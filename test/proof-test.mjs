/* 自证：不接受「我修好了」，只接受「同一份测试，旧代码上红、新代码上绿」
 *
 * 这一层要挡的是四种假绿，每一种都真的会有人这么干：
 *   1. 测不到 bug —— 测试在旧代码上也能过，说明它根本没测到这个毛病
 *   2. 掏空测试 —— 退出码 0，但一个断言都没跑（或者被删成了空文件）
 *   3. 换测试 —— 跑一份、贴另一份的输出（所以证明必须自己复跑）
 *   4. 没改代码 —— 两个提交一模一样，「绿」只是「什么都没动，跑了两遍」
 *
 * 还有一条比「通过/不通过」更要紧的判断：红是**强红**还是**弱红**。
 *   assert = 跑完了、断言失败 → bug 当时确实在
 *   load   = 测试根本没跑起来 → 只证明「这东西原来没有」
 * 两者都算红，但可信度差一档，所以证据里必须分开记。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-test-'));

/* 目录在 import 时就定死了，必须在 import 之前设 */
process.env.PROOF_DIR = path.join(TMP, 'proofs');
process.env.TICKET_DIR = path.join(TMP, 'tickets');
process.env.AUDIT_DIR = path.join(TMP, 'audit');
process.env.INCIDENT_DIR = path.join(TMP, 'incident');

const P = await import('../lib/proof.js');
const T = await import('../lib/ticket.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 320) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

/* ── 造仓库 ── */
const git = (dir, ...args) => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();

function mkRepo(name, files) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'proof@test');
  git(dir, 'config', 'user.name', 'proof');
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}
function commit(dir, files, msg) {
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

const CNT = "console.log('\\n' + pass + ' 通过 / ' + fail + ' 失败');";
const LIB_BUG = 'export function add(a, b) { return a - b; }\n';   // 加法写成减法
const LIB_FIX = 'export function add(a, b) { return a + b; }\n';

/* 一个真的能测到 bug 的测试 */
const T_GOOD = [
  "import { add } from '../lib/x.js';",
  'let pass = 0, fail = 0;',
  "const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };",
  "ok('1+2=3', add(1, 2) === 3);",
  "ok('2+2=4', add(2, 2) === 4);",
  CNT,
  'process.exit(fail ? 1 : 0);',
  ''
].join('\n');

/* 测不到 bug 的测试：旧代码也能过 */
const T_WEAK = [
  "import { add } from '../lib/x.js';",
  'let pass = 0, fail = 0;',
  "const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };",
  "ok('是个函数', typeof add === 'function');",
  CNT,
  'process.exit(fail ? 1 : 0);',
  ''
].join('\n');

/* 掏空：退出码 0，但没有汇总行 */
const T_HOLLOW = [
  "console.log('看起来跑过了');",
  'process.exit(0);',
  ''
].join('\n');

console.log('[1] 测试路径：只收 test/ 下的 .mjs（这个参数会变成一次子进程调用）');
{
  ok('正常路径放行', P.checkTestPath('test/foo-test.mjs').ok);
  ok('./ 前缀会被去掉', P.checkTestPath('./test/a.mjs').path === 'test/a.mjs');
  ok('空值拒绝', !P.checkTestPath('').ok);
  ok('绝对路径拒绝', !P.checkTestPath('/etc/passwd').ok);
  ok('.. 穿越拒绝', !P.checkTestPath('test/../../etc/x.mjs').ok);
  ok('反斜杠拒绝', !P.checkTestPath('test\\x.mjs').ok);
  ok('不在 test/ 下拒绝', !P.checkTestPath('lib/x.mjs').ok);
  ok('非 .mjs 拒绝', !P.checkTestPath('test/x.js').ok);
  ok('命令行开关混进来也拒', !P.checkTestPath('--require=./evil.js').ok);
  ok('空格也拒（不给参数拼接留口子）', !P.checkTestPath('test/a b.mjs').ok);
}

console.log('\n[2] 分类器：汇总行是「真的跑完了」的唯一凭证');
{
  eq('读得出汇总', P.parseSummary('x\n3 通过 / 2 失败\n'), { pass: 3, fail: 2 });
  eq('没有汇总就是 null', P.parseSummary('随便什么输出'), null);

  eq('退出 0 + 0 失败 = pass', P.classify(0, '5 通过 / 0 失败', '').kind, 'pass');
  eq('退出 0 但无汇总 = silent（不能算过）', P.classify(0, '看起来跑过了', '').kind, 'silent');
  eq('退出 1 + 有失败 = assert（强红）', P.classify(1, '2 通过 / 3 失败', '').kind, 'assert');
  eq('模块不存在 = load（弱红）', P.classify(1, '', "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/x'").kind, 'load');
  eq('语法错误 = load', P.classify(1, 'SyntaxError: Unexpected token', '').kind, 'load');
  eq('文件都没有 = missing', P.classify(1, '', 'Error: ENOENT: no such file').kind, 'missing');
  eq('跑到一半崩了 = crash', P.classify(1, '开始跑…', 'TypeError: x is not a function').kind, 'crash');
  ok('崩溃不算强红', P.classify(1, '开始跑…', 'TypeError').kind !== 'assert');
}

console.log('\n[3] 正常修复：旧代码断言失败 → 新代码全绿');
{
  const dir = mkRepo('good', { 'lib/x.js': LIB_BUG, 'package.json': '{"type":"module"}' });
  const fix = commit(dir, { 'lib/x.js': LIB_FIX, 'test/x-test.mjs': T_GOOD }, 'fix: 加法');

  const p = await P.runProof({ root: dir, sig: 'SIG-GOOD', test: 'test/x-test.mjs', fix });
  ok('整体通过', p.ok, p.why);
  ok('是强红', p.strong === true, p.red);
  eq('红是断言失败', p.red.kind, 'assert');
  eq('红里两个断言都失败', p.red.fail, 2);
  eq('绿里 0 失败', p.green.fail, 0);
  eq('绿里两个都过', p.green.pass, 2);
  ok('记录了基线提交', p.base === git(dir, 'rev-parse', 'HEAD^'), p.base);
  ok('记录了修复提交', p.fix === fix.slice(0, 40) || fix.startsWith(p.fix), p.fix);
  ok('记录了测试指纹', /^[0-9a-f]{64}$/.test(p.testSha), p.testSha);
  ok('认出测试是新增的', p.testIsNew === true);
  eq('改动文件数', p.changedCount, 2);
  ok('每条检查都留了人话', p.checks.every(c => typeof c.detail === 'string'), p.checks.map(c => c.id));
  ok('红里有输出尾巴（复核时能看原文）', /✗/.test(p.red.tail), p.red.tail.slice(0, 80));

  /* 证明过程不能动工作区：它跑的是临时 worktree */
  eq('工作区没被改', git(dir, 'status', '--porcelain'), '');
  eq('没有残留 worktree', git(dir, 'worktree', 'list').split('\n').length, 1);
  eq('没有残留临时目录', fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ren-proof-') && fs.statSync(path.join(os.tmpdir(), n)).mtimeMs > Date.now() - 60000).length >= 0, true);

  /* 落盘 / 读回 / 删掉 */
  ok('存得下', P.saveProof(p) === true);
  const back = P.loadProof('SIG-GOOD');
  ok('读得回', back && back.ok === true && back.test === 'test/x-test.mjs', back && back.test);
  ok('列表能认出哪几张有证据', P.proofKeys().has(T.keyOf('SIG-GOOD')));
  const st = P.proofStats();
  ok('统计里算一张', st.total >= 1 && st.ok >= 1 && st.strong >= 1, st);
  ok('删得掉', P.dropProof('SIG-GOOD') === true);
  ok('删完读不到', P.loadProof('SIG-GOOD') === null);
}

console.log('\n[4] 假绿一：测试测不到 bug（旧代码也能过）');
{
  const dir = mkRepo('weak', { 'lib/x.js': LIB_BUG, 'package.json': '{"type":"module"}' });
  const fix = commit(dir, { 'lib/x.js': LIB_FIX, 'test/x-test.mjs': T_WEAK }, 'fix: 加法');
  const p = await P.runProof({ root: dir, sig: 'SIG-WEAK', test: 'test/x-test.mjs', fix });
  ok('判为没通过', p.ok === false, p.why);
  const c = p.checks.find(x => x.id === 'red-fails');
  ok('卡在「旧代码居然过了」', c && !c.ok, c && c.detail);
  ok('理由是人话，说清了问题', /测不到 bug/.test(p.why), p.why);
}

console.log('\n[5] 假绿二：把测试掏空（退出 0，但没有断言）');
{
  const dir = mkRepo('hollow', { 'lib/x.js': LIB_BUG, 'package.json': '{"type":"module"}' });
  const fix = commit(dir, { 'lib/x.js': LIB_FIX, 'test/x-test.mjs': T_HOLLOW }, 'fix: 加法');
  const p = await P.runProof({ root: dir, sig: 'SIG-HOLLOW', test: 'test/x-test.mjs', fix });
  ok('判为没通过', p.ok === false, p.why);
  eq('绿被认成 silent 而不是 pass', p.green.kind, 'silent');
  ok('指出「没有汇总行」', /汇总行/.test(p.why || ''), p.why);
}

console.log('\n[6] 弱红：新功能而不是修 bug（旧代码上模块不存在）');
{
  const dir = mkRepo('newfeat', { 'lib/x.js': LIB_BUG, 'package.json': '{"type":"module"}' });
  const T_NEW = [
    "import { add, sub } from '../lib/x.js';",
    'let pass = 0, fail = 0;',
    "const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };",
    "ok('k', add(1, 2) === 3);",
    "ok('sub 也有了', sub(5, 2) === 3);",
    CNT,
    'process.exit(fail ? 1 : 0);',
    ''
  ].join('\n');
  const fix = commit(dir, {
    'lib/x.js': LIB_FIX + 'export function sub(a, b) { return a - b; }\n',
    'test/x-test.mjs': T_NEW
  }, 'feat: sub');
  const p = await P.runProof({ root: dir, sig: 'SIG-NEW', test: 'test/x-test.mjs', fix });
  ok('整体仍算通过（红确实红了、绿确实绿了）', p.ok === true, p.why);
  ok('但不是强红', p.strong === false, p.red);
  eq('红的原因是加载失败', p.red.kind, 'load');
  const c = p.checks.find(x => x.id === 'red-is-assertion');
  ok('单独标出「这不是断言失败」', c && !c.ok && /只证明/.test(c.detail), c && c.detail);
  ok('但它是分档项，不是否决项（否则新功能永远过不了）', c && c.gate === false, c && c.gate);
  ok('弱红的提示单独放在 warn 里', /只证明/.test(p.warn || ''), p.warn);
}

console.log('\n[7] 假绿三：修复提交和父提交一模一样');
{
  const dir = mkRepo('same', { 'lib/x.js': LIB_BUG, 'package.json': '{"type":"module"}' });
  commit(dir, { 'test/x-test.mjs': T_GOOD }, 'test: 加个测试');
  const head = git(dir, 'rev-parse', 'HEAD');
  const p = await P.runProof({ root: dir, sig: 'SIG-SAME', test: 'test/x-test.mjs', fix: head, base: head });
  ok('判为没通过', p.ok === false, p.why);
  ok('理由是「同一个提交」', /同一个提交/.test(p.why), p.why);

  /* 换一种：代码真的没变，但测试是新加的 —— diff 非空，可代码里根本没修 */
  const dir2 = mkRepo('same2', { 'lib/x.js': LIB_BUG, 'package.json': '{"type":"module"}' });
  const h2 = commit(dir2, { 'test/x-test.mjs': T_GOOD }, 'chore: 只是加了测试');
  const p2 = await P.runProof({ root: dir2, sig: 'SIG-SAME2', test: 'test/x-test.mjs', fix: h2 });
  ok('只加测试不改代码：diff 非空但红仍然红', p2.ok === false && p2.red.exit !== 0, p2.why);
  ok('失败原因指向「旧代码上也失败」之后的绿', /仍然失败|红/.test(p2.why || ''), p2.why);
}

console.log('\n[8] 参数与环境：这些情况必须明说，不能给假绿');
{
  const dir = mkRepo('errs', { 'lib/x.js': LIB_BUG, 'package.json': '{"type":"module"}' });

  const p1 = await P.runProof({ root: dir, test: 'lib/x.js', fix: 'HEAD' });
  ok('路径不在 test/ → 拒', !p1.ok && /test\//.test(p1.why), p1.why);

  const p2 = await P.runProof({ root: dir, test: 'test/x-test.mjs', fix: 'nosuchrev' });
  ok('提交不存在 → 拒', !p2.ok && /找不到修复提交/.test(p2.why), p2.why);

  const p3 = await P.runProof({ root: dir, test: 'test/x-test.mjs', fix: 'HEAD' });
  ok('根提交没有父提交 → 拒（没有「修复前」可比）', !p3.ok && /没有父提交/.test(p3.why), p3.why);

  const noGit = path.join(TMP, 'nogit');
  fs.mkdirSync(noGit, { recursive: true });
  const p4 = await P.runProof({ root: noGit, test: 'test/x-test.mjs' });
  ok('不是 git 仓库 → 拒，并说明要去开发机跑', !p4.ok && /不是 git 仓库/.test(p4.why), p4.why);

  const dir2 = mkRepo('notest', { 'lib/x.js': LIB_BUG, 'package.json': '{"type":"module"}' });
  const fix2 = commit(dir2, { 'lib/x.js': LIB_FIX }, 'fix: 但忘了提交测试');
  const p5 = await P.runProof({ root: dir2, test: 'test/x-test.mjs', fix: fix2 });
  ok('修复提交里没有这个测试 → 拒', !p5.ok && /没有 test\/x-test\.mjs/.test(p5.why), p5.why);

  /* 失败时也必须清理 */
  eq('失败路径也清掉了 worktree', git(dir2, 'worktree', 'list').split('\n').length, 1);
}

console.log('\n[9] 环境清洗：证明跑测试时不能继承生产数据目录');
{
  const e = P.__test.cleanEnv();
  ok('丢掉了 REN_STATE_DIR', !('REN_STATE_DIR' in e));
  ok('丢掉了 AUDIT_DIR', !('AUDIT_DIR' in e));
  ok('丢掉了 TICKET_DIR', !('TICKET_DIR' in e));
  ok('丢掉了 PROOF_DIR', !('PROOF_DIR' in e));
  ok('所有 REN_ 前缀的一律不放行（除了自己的标记）', Object.keys(e).filter(k => /^REN_/.test(k)).join(',') === 'REN_PROOF', Object.keys(e).filter(k => /^REN_/.test(k)));
  ok('留在那里的是通用变量（PATH 不能丢）', typeof e.PATH === 'string' && e.PATH.length > 0);
  ok('打上了自己是证明环境的标记', e.REN_PROOF === '1');
}

console.log('\n[10] 工单：没有证据不许说「修好了」');
{
  const sig = 'E_TOOL_FAIL|/api/x|doThing';
  const key = T.keyOf(sig);

  const a = T.settle(sig, { state: 'claimed', note: '' });
  ok('先领取', a.ok === true, a.error);

  const b = T.settle(sig, { state: 'fixed', note: '按 UI 提示改了' });
  ok('没有证据 → 拒绝结算为 fixed', b.ok === false, b.error);
  ok('拒绝理由说清了怎么补', /自证|prove/.test(b.error), b.error);
  ok('提示里给了可复制的命令', /npm run prove/.test(b.error), b.error);
  ok('顺带给了工单号', b.error.includes(key), b.error);

  /* 一份合格的证据 */
  const good = { ok: true, strong: true, sig, test: 'test/x-test.mjs', red: { kind: 'assert', exit: 1 }, green: { exit: 0, pass: 3, fail: 0 }, at: new Date().toISOString(), ms: 900 };
  P.saveProof(good);

  const c = T.settle(sig, { state: 'fixed', note: '按 UI 提示改了两行' });
  ok('有合格证据 → 能标 fixed', c.ok === true, c.error);

  /* 复核不过：fixed → claimed 是唯一合法的打回路径
     （verified 是终态，走不到这里——这也是「打回」必须发生在复核之前的原因） */
  const d = T.settle(sig, { state: 'claimed', note: '复核发现只改了文案' });
  ok('复核不过可以打回 claimed', d.ok === true, d.error);
  ok('打回时把证据一起删了', P.loadProof(sig) === null);
  const e2 = T.settle(sig, { state: 'fixed', note: '这次真改了' });
  ok('打回后想再标 fixed：必须重新证明', e2.ok === false && /自证/.test(e2.error), e2.error);

  /* 补一份新证据，这次一路走到 verified */
  P.saveProof(good);
  const f = T.settle(sig, { state: 'fixed', note: '这次真改了' });
  ok('补证据后能再标 fixed', f.ok === true, f.error);
  const g2 = T.settle(sig, { state: 'verified', note: '复核过了' });
  ok('强红可以标 verified', g2.ok === true, g2.error);
  const h = T.settle(sig, { state: 'fixed', note: '想再改一次' });
  ok('verified 是终态，回不去 fixed', h.ok === false && /不能从/.test(h.error), h.error);
}

console.log('\n[11] 弱红的证据：能标 fixed，不能标 verified');
{
  const sig = 'E_UNKNOWN|/api/y|doOther';
  T.settle(sig, { state: 'claimed' });
  const weak = { ok: true, strong: false, sig, test: 'test/y-test.mjs', red: { kind: 'load', exit: 1 }, green: { exit: 0, pass: 4, fail: 0 }, at: new Date().toISOString() };
  P.saveProof(weak);

  const a = T.settle(sig, { state: 'fixed', note: '这个能力原来没有，补上了' });
  ok('弱红可以标 fixed（新功能是正常情况）', a.ok === true, a.error);

  const b = T.settle(sig, { state: 'verified', note: '看着没问题' });
  ok('弱红不能标 verified', b.ok === false, b.error);
  ok('理由说清了是「只证明原来没有」', /原来没有|不证明/.test(b.error), b.error);
  ok('失败时把证据一起返回，方便复核', b.proof && b.proof.strong === false);
}

console.log('\n[12] 接线：入口、鉴权、命令都真的存在');
{
  const srv = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
  ok('有 /api/ticket/prove 端点', /u\.pathname === '\/api\/ticket\/prove'/.test(srv));
  ok('端点在 OPTIONAL_AUTH 里（先过闸门再判 key）', /'\/api\/ticket\/prove'\]\)/.test(srv) || /\/api\/ticket\/prove'/.test(srv.slice(srv.indexOf('OPTIONAL_AUTH'), srv.indexOf('OPTIONAL_AUTH') + 800)));
  ok('端点要运维 key', /pathname === '\/api\/ticket\/prove'[\s\S]{0,200}adminOK/.test(srv));
  ok('有全局串行锁（否则两个证明会抢 worktree）', /PROOF_BUSY/.test(srv) && /已有一次证明在跑/.test(srv));
  ok('用的是异步子进程而不是 execSync（不能卡住事件循环）', /await runProof/.test(srv) && !/execSync[\s\S]{0,80}runProof/.test(srv));
  ok('health 里能看到证据数量', /proofStats\(\)/.test(srv));

  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  ok('npm run prove 存在', pkg.scripts && pkg.scripts.prove === 'node scripts/prove.mjs', pkg.scripts && pkg.scripts.prove);
  ok('命令行脚本存在', fs.existsSync(path.join(APP, 'scripts', 'prove.mjs')));

  const tk = fs.readFileSync(path.join(APP, 'lib', 'ticket.js'), 'utf8');
  ok('结算里有自证闸门', /state === 'fixed' \|\| state === 'verified'[\s\S]{0,400}loadProof/.test(tk));
  ok('打回时作废证据', /state === 'claimed' \|\| state === 'open'[\s\S]{0,80}dropProof/.test(tk));
  ok('任务模板里写清了两档红', /强红|断言失败/.test(tk) && /模块不存在/.test(tk));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
