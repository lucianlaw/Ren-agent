/* 修复工作区：它到底能在哪改、改到哪会被拦、交单前必须有什么
 *
 * 这一层要挡的不是「恶意」，是**顺手**：
 *   · 顺手 `cd ..` 或者写个绝对路径，把文件改到工作区外面去
 *   · 顺手「顺手把 within() 里的判断放宽一点」，问题就解决了——而这正是路径围栏
 *   · 顺手改一改 prove 的判定，让弱红也通过
 *   · 顺手把 server.js 的 PUBLIC_API 加一条，测试就好跑了
 * 每一种都不是攻击，都是「为了让测试过」的自然动作。所以判据要做成硬的。
 *
 * 还有一条同样要紧：**它不能自己标 verified**。交单只能到 fixed。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-test-'));
const REPO = path.join(TMP, 'repo');

const git = (dir, ...args) => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();

/* ── 造一个「有 bug 的小应用」当修复对象 ──
   它必须真的像这个仓库：有围栏函数、有免登录边界、有被 gitignore 的 data/，
   否则测出来的「红线判定」只是在测玩具。 */
fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q');
git(REPO, 'config', 'user.email', 'r@test');
git(REPO, 'config', 'user.name', 'r');

const FILES = {
  '.gitignore': 'data/\nnode_modules/\n',
  'package.json': JSON.stringify({ name: 'fixture', version: '0.0.1', type: 'module' }, null, 2) + '\n',
  'lib/x.js': 'export function add(a, b) { return a - b; }\n',          // 这就是要被修的 bug
  'lib/authn.js': 'export function login() { return true; }\n',
  'lib/repair.js': 'export const fence = 1;\n',
  'lib/tools.js': [
    'const DENY_PATH = [\'/etc/ssh\', \'/bin\'];',
    '',
    'function within(root, target, fullAccess = false) {',
    '  const r = path.resolve(root);',
    '  const t = path.resolve(r, target || \'.\');',
    '  if (t === r || t.startsWith(r + path.sep)) return t;',
    '  if (!fullAccess) return null;',
    '  return t;',
    '}',
    '',
    'function dispPath(workspace, p) {',
    '  const r = path.resolve(workspace);',
    '  const t = path.resolve(p);',
    '  return t.startsWith(r + path.sep) ? path.relative(r, t) : t;',
    '}',
    ''
  ].join('\n'),
  'server.js': [
    'const PUBLIC_API = new Set([\'/api/health\']);',
    '',
    'function handler(req) {',
    '  return PUBLIC_API.has(req.url);',
    '}',
    ''
  ].join('\n'),
  'test/ok-test.mjs': [
    "import { add } from '../lib/x.js';",
    'let pass = 0, fail = 0;',
    "const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };",
    "ok('是个函数', typeof add === 'function');",
    "console.log(pass + ' 通过 / ' + fail + ' 失败');",
    'process.exit(fail ? 1 : 0);',
    ''
  ].join('\n')
};
for (const [rel, body] of Object.entries(FILES)) {
  const f = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}
git(REPO, 'add', '-A');
git(REPO, 'commit', '-q', '-m', 'base');

/* 目录在 import 时就定死，必须在 import 之前设 */
process.env.REPAIR_ROOT = REPO;
process.env.REPAIR_DIR = path.join(TMP, 'repair');
process.env.PROOF_DIR = path.join(TMP, 'proofs');
process.env.TICKET_DIR = path.join(TMP, 'tickets');
process.env.AUDIT_DIR = path.join(TMP, 'audit');
process.env.INCIDENT_DIR = path.join(TMP, 'incident');

const R = await import('../lib/repair.js');
const INC = await import('../lib/incident.js');
const T = await import('../lib/ticket.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const write = (rel, body) => {
  const f = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/* 造一份真 diff：写文件 → add → diff --cached → 复位。
   手写 hunk 行号很容易和文件对不上，然后用一句「测试写错了」掩盖真实的判定错误。 */
function diffFor(edits) {
  for (const [rel, body] of Object.entries(edits)) {
    if (body === null) { try { fs.unlinkSync(path.join(REPO, rel)); } catch { /* 不存在就算了 */ } }
    else write(rel, body);
  }
  git(REPO, 'add', '-A');
  const d = execFileSync('git', ['diff', '--cached', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
  git(REPO, 'reset', '-q');
  git(REPO, 'checkout', '--', '.');
  git(REPO, 'clean', '-fdq');
  return d;
}
const oldOf = (rel) => {
  try { return git(REPO, 'show', `HEAD:${rel}`) + '\n'; } catch { return ''; }
};
const flagsFor = (edits) => {
  const d = diffFor(edits);
  const newOf = (rel) => (rel in edits ? String(edits[rel] ?? '') : oldOf(rel));
  return R.redFlags(d, oldOf, newOf);
};

console.log('[1] 开不开：只在 dev 实例，且必须绑回环');
{
  ok('没设 REN_DEV_INSTANCE 就关', !R.available({}).ok);
  ok('关掉时给 503 而不是 403（403 会被读成权限没配好）', R.available({}).code === 503);
  ok('dev + 回环 → 开', R.available({ REN_DEV_INSTANCE: '1', HOST: '127.0.0.1' }).ok);
  ok('dev 但 HOST 是对外地址 → 关', !R.available({ REN_DEV_INSTANCE: '1', HOST: '0.0.0.0' }).ok);
  ok('dev 没写 HOST 也放行（启动闸门已经管过这一条）', R.available({ REN_DEV_INSTANCE: '1' }).ok);
  ok('理由里说清了为什么', /改代码|源码/.test(R.available({}).why));
}

console.log('\n[2] 路径围栏：它只能碰工作区里的源码');
{
  const root = REPO;
  ok('普通相对路径放行', R.guardPath(root, 'lib/x.js').ok);
  ok('新建文件也放行（还不存在）', R.guardPath(root, 'test/new-test.mjs').ok);
  ok('绝对路径拒', !R.guardPath(root, '/etc/passwd').ok);
  ok('.. 拒', !R.guardPath(root, '../outside.js').ok);
  ok('绕一圈的 .. 也拒', !R.guardPath(root, 'lib/../../x.js').ok);
  ok('.git 拒（改它能改历史）', !R.guardPath(root, '.git/config').ok);
  ok('data 拒（那是运行数据）', !R.guardPath(root, 'data/tickets/a.json').ok);
  ok('node_modules 拒', !R.guardPath(root, 'node_modules/x/index.js').ok);
  ok('NUL 字符拒', !R.guardPath(root, 'lib/x.js\0.txt').ok);

  /* 软链：worktree 里放一个指向外面的链接，resolve 之后路径还在里面——
     这是「字符串前缀判断」必然漏掉的那一种。 */
  const outside = path.join(TMP, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  try { fs.symlinkSync(outside, path.join(REPO, 'link'), 'dir'); } catch { /* 没权限就不测这条 */ }
  const g = R.guardPath(root, 'link/secret.txt');
  ok('软链指到外面 → 拒', !g.ok, g);
  try { fs.unlinkSync(path.join(REPO, 'link')); } catch { /* 忽略 */ }

  ok('mustExist 时不存在就报', !R.guardPath(root, 'lib/nope.js', { mustExist: true }).ok);
}

console.log('\n[3] 红线：敏感文件整份禁');
{
  ok('lib/authn.js 拒', flagsFor({ 'lib/authn.js': 'export function login() { return false; }\n' }).length > 0);
  ok('lib/repair.js 拒（闸门本身）', flagsFor({ 'lib/repair.js': 'export const fence = 2;\n' }).length > 0);
  ok('理由说的是「闸门」这一层', /闸门/.test(JSON.stringify(flagsFor({ 'lib/repair.js': 'export const fence = 2;\n' }))));
}

console.log('\n[4] 红线：围栏函数所在的「块」');
{
  /* 把 within() 里的判断放宽——这是「为了让测试过」最自然的一步 */
  const widen = [
    'const DENY_PATH = [\'/etc/ssh\', \'/bin\'];',
    '',
    'function within(root, target, fullAccess = false) {',
    '  const r = path.resolve(root);',
    '  const t = path.resolve(r, target || \'.\');',
    '  if (t === r || t.startsWith(r + path.sep)) return t;',
    '  if (!fullAccess) return null;',
    '  return t;',
    '  // 允许绝对路径直通',
    '}',
    '',
    'function dispPath(workspace, p) {',
    '  const r = path.resolve(workspace);',
    '  const t = path.resolve(p);',
    '  return t.startsWith(r + path.sep) ? path.relative(r, t) : t;',
    '}',
    ''
  ].join('\n');
  const f = flagsFor({ 'lib/tools.js': widen });
  ok('改 within() 的函数体 → 拒', f.some(x => /within/.test(x.why)), f);
  eq('只报一条（不会把整份文件都算进去）', f.length, 1);

  const other = FILES['lib/tools.js'].replace(
    "  return t.startsWith(r + path.sep) ? path.relative(r, t) : t;",
    "  return t.startsWith(r + path.sep) ? path.relative(r, t) : p;"
  );
  const f2 = flagsFor({ 'lib/tools.js': other });
  ok('改无关函数 dispPath → 放行', f2.length === 0, f2);

  const deny = FILES['lib/tools.js'].replace("'/bin'", "'/bin', '/usr/bin'");
  const f3 = flagsFor({ 'lib/tools.js': deny });
  ok('往 DENY_PATH 里加一条 → 拒', f3.some(x => /DENY_PATH/.test(x.why)), f3);
  eq('一行写完的常量只算它自己那一行（不吞掉后面几十行）', f3.length, 1);
}

console.log('\n[5] 红线：免登录边界在 server.js 里只占一行');
{
  const addApi = FILES['server.js'].replace("'/api/health'", "'/api/health', '/api/secret'");
  const f = flagsFor({ 'server.js': addApi });
  ok('往 PUBLIC_API 里加一条 → 拒', f.some(x => /PUBLIC_API/.test(x.why)), f);
  eq('只报一条', f.length, 1);

  const other = FILES['server.js'].replace('return PUBLIC_API.has(req.url);', 'return !!req.url;');
  ok('改 handler 本身 → 放行', flagsFor({ 'server.js': other }).length === 0);
}

console.log('\n[6] 红线：删测试');
{
  ok('删掉一个已有测试 → 拒', flagsFor({ 'test/ok-test.mjs': null }).some(x => /判据没了/.test(x.why)));
  ok('新增测试 → 放行', flagsFor({ 'test/new-test.mjs': 'console.log(1);\n' }).length === 0);
}

console.log('\n[7] 开修：建 worktree、领单子、给任务书');
{
  INC.report({ code: 'E_UI_RENDER', route: '/x', where: 'render', msg: 'boom', scope: 'a'.repeat(32) });
  const t = T.listTickets({ limit: 10 }).tickets[0];
  ok('先有一张单子', !!t, t && t.sig);

  const b1 = await R.begin({ sig: t.sig, by: 'ren', env: { REN_DEV_INSTANCE: '1', HOST: '127.0.0.1' } });
  ok('begin 成功', b1.ok, b1.error);
  ok('worktree 真的建出来了', fs.existsSync(path.join(b1.dir, 'lib/x.js')));
  ok('分支是 heal/<key>', b1.branch === 'heal/' + b1.key);
  ok('单子被认领了', T.getTicket(t.sig).state === 'claimed');
  ok('任务书一起给出来了（含红线）', /边界（不许动）/.test(b1.task));

  const again = await R.begin({ sig: t.sig, by: 'ren', env: { REN_DEV_INSTANCE: '1' } });
  ok('重复 begin 是「继续」，不是再建一个', again.ok && again.reuse && again.dir === b1.dir);

  const bad = await R.begin({ sig: 'deadbeef'.repeat(4), by: 'ren', env: { REN_DEV_INSTANCE: '1' } });
  ok('编一个不存在的签名 → 拒', !bad.ok && /没有这张单子/.test(bad.error), bad.error);

  /* 生产环境一律不开 */
  const prod = await R.begin({ sig: t.sig, by: 'ren', env: {} });
  ok('生产环境 → 503', !prod.ok && prod.code === 503);

  globalThis.__K = b1.key;
  globalThis.__SIG = t.sig;
}

console.log('\n[8] 改：只能改工作区里的源码');
{
  const key = globalThis.__K;
  const w1 = R.writeFile({ key, path: 'lib/authn.js', content: 'x' });
  ok('写红线文件 → 拒', !w1.ok && /红线/.test(w1.error), w1);
  const w2 = R.writeFile({ key, path: '../x.js', content: 'x' });
  ok('写到工作区外 → 拒', !w2.ok);
  const w3 = R.writeFile({ key, path: 'data/x.json', content: '{}' });
  ok('写运行数据 → 拒', !w3.ok);
  const w4 = R.writeFile({ key, path: 'lib/x.bin', content: 'x' });
  ok('非文本扩展名 → 拒', !w4.ok);

  const good = R.editFile({ key, path: 'lib/x.js', old: 'return a - b;', new: 'return a + b;' });
  ok('改 bug 本身 → 放行', good.ok, good.error);
  ok('改动真的落在 worktree 里', /a \+ b/.test(fs.readFileSync(path.join(R.load(key).dir, 'lib/x.js'), 'utf8')));

  const miss = R.editFile({ key, path: 'lib/x.js', old: 'return a * b;', new: 'x' });
  ok('原文找不到 → 明确报「没找到」', !miss.ok && /没找到/.test(miss.error));
  const dup = R.editFile({ key, path: 'lib/x.js', old: 'a', new: 'b' });
  ok('原文不唯一 → 拒（不许猜一处改）', !dup.ok && /出现/.test(dup.error), dup.error);

  const r = R.read({ key, path: 'lib/x.js' });
  ok('读得回来', r.ok && /a \+ b/.test(r.output));
  const g = R.grep({ key, q: 'return a' });
  ok('搜得到', g.ok && g.hits > 0);
}

console.log('\n[9] 自证 + 交单：只能到 fixed');
{
  const key = globalThis.__K;

  /* 回归测试：调用已存在的入口，断言行为。这样旧代码上是「断言失败」= 强红，
     而不是「模块不存在」= 弱红。 */
  const testSrc = [
    "import { add } from '../lib/x.js';",
    'let pass = 0, fail = 0;',
    "const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };",
    "ok('1+2=3', add(1, 2) === 3);",
    "console.log(pass + ' 通过 / ' + fail + ' 失败');",
    'process.exit(fail ? 1 : 0);',
    ''
  ].join('\n');
  R.writeFile({ key, path: 'test/add-test.mjs', content: testSrc });

  const p = await R.prove({ key, test: 'test/add-test.mjs' });
  ok('自证通过', p.ok, p.error || (p.proof && p.proof.why));
  ok('是强红（旧代码上断言失败，不是模块不存在）', p.proof && p.proof.strong === true, p.proof && p.proof.red);
  ok('改了代码的只有 lib/x.js 和新增测试', p.proof.changedCount >= 2);

  const sub = await R.submit({ key, note: '把 add 的减法改成加法' });
  ok('交单成功', sub.ok, sub.error);
  eq('状态是 fixed，不是 verified', sub.state, 'fixed');
  ok('交单回执里说明了「复核留给人」', /verified/.test(sub.next));
  ok('工单状态同步成 fixed', T.getTicket(globalThis.__SIG).state === 'fixed');
  ok('回执带 patch（人能直接看改了什么）', /return a \+ b/.test(sub.patch || ''));

  const again = await R.submit({ key, note: '再来一次' });
  ok('已交过的单子不能重复交', !again.ok);
}

console.log('\n[10] 中止：worktree 摘掉，分支默认留着');
{
  INC.report({ code: 'E_TOOL_FAIL', route: '/y', where: 'run', msg: 'failed', scope: 'b'.repeat(32) });
  const list = T.listTickets({ limit: 20 }).tickets.filter(x => x.state === 'open');
  const t = list[0];
  ok('有一张没处理过的单子', !!t);

  const b = await R.begin({ sig: t.sig, by: 'ren', env: { REN_DEV_INSTANCE: '1' } });
  ok('begin', b.ok, b.error);

  const a1 = await R.abort({ key: b.key });
  ok('abort 成功', a1.ok, a1.error);
  ok('worktree 目录没了', !fs.existsSync(b.dir));
  ok('默认保留分支', a1.branchKept === true);
  ok('单子退回 open（否则会永远挂在「有人正在修」）', T.getTicket(t.sig).state === 'open');

  const b2 = await R.begin({ sig: t.sig, by: 'ren', env: { REN_DEV_INSTANCE: '1' } });
  ok('分支还在 → 不许悄悄覆盖，要求先 abort --force', !b2.ok && /abort --force/.test(b2.error), b2.error);

  const a2 = await R.abort({ key: b.key, force: true });
  ok('force 才删分支', a2.ok && a2.branchKept === false);
  const b3 = await R.begin({ sig: t.sig, by: 'ren', env: { REN_DEV_INSTANCE: '1' } });
  ok('清干净后能重开', b3.ok, b3.error);
  await R.abort({ key: b3.key, force: true });
}

console.log('\n[11] 脏工作区：base 指不到确定版本就不许开修');
{
  const t = T.listTickets({ limit: 20 }).tickets.find(x => x.state === 'open')
    || (INC.report({ code: 'E_NET', route: '/z', where: 'fetch', msg: 'timeout', scope: 'c'.repeat(32) }),
      T.listTickets({ limit: 20 }).tickets[0]);
  write('lib/x.js', 'export function add(a, b) { return a + b + 1; }\n');
  const b = await R.begin({ sig: t.sig, by: 'ren', env: { REN_DEV_INSTANCE: '1' } });
  ok('源码目录脏 → 拒', !b.ok && /未提交/.test(b.error), b.error);
  git(REPO, 'checkout', '--', '.');
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
