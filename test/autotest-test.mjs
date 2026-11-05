// 改完自动跑测试：这一层的价值全在「判断得准」——
// 跑起来不难，难的是分清「这次改坏了」「本来就红」「根本没跑」三种情况。
// 所以这组测试盯三件事：
//   1) 触发要对：文档不跑、没测试不跑、没 exec 权限不跑（跑测试 = 执行任意代码）
//   2) 解析要真：各家 runner 的失败行都要认出来，进程崩了不能算「0 失败」
//   3) 归因要诚实：首次红判红、老失败不算新失败、新失败必须拦住
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  isCodeFile, discoverTests, parseTestOutput, runAfterEdit, resetBaseline
} from '../lib/selftest.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autotest-'));
function mkProject(files) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'p-'));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return dir;
}

/* 一个真能跑的测试脚本：读同目录的 lib.mjs，里面写了 VALUE = 42 就算过 */
const TEST_SCRIPT = `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const src = fs.readFileSync(path.join(here, '..', 'lib.mjs'), 'utf8');
function ok(n, c) { if (c) { pass++; } else { fail++; console.log('  ✗ ' + n); } }
ok('常量应为 42', /VALUE = 42/.test(src));
ok('应该导出 VALUE', /export const VALUE/.test(src));
console.log('\\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
`;

console.log('[1] 什么改动才值得跑测试');
{
  ok('js 是代码文件', isCodeFile('lib/tools.js'));
  ok('mjs / ts / tsx / py 都算', ['a.mjs', 'a.ts', 'a.tsx', 'a.py', 'a.cjs'].every(isCodeFile));
  ok('md 不是代码文件（写文档不该触发跑测试）', !isCodeFile('report.md'));
  ok('docx / xlsx / png 都不算', !['a.docx', 'a.xlsx', 'a.png'].some(isCodeFile));
  ok('空路径不算', !isCodeFile(''));
  ok('伪装后缀不算（a.js.md）', !isCodeFile('a.js.md'));
}

console.log('[2] 找出怎么跑：项目声明的 > 约定名 > 没有');
{
  const npmDir = mkProject({ 'package.json': JSON.stringify({ scripts: { test: 'node run.mjs' } }) });
  const npm = discoverTests(npmDir);
  ok('有 scripts.test 就用 npm test', npm && npm.kind === 'npm' && npm.cmd === 'npm', JSON.stringify(npm));
  ok('npm test 用 --silent（少点无关噪音）', npm && npm.args.includes('--silent'));

  const ph = mkProject({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  ok('npm 默认占位脚本不算测试入口', discoverTests(ph) === null, JSON.stringify(discoverTests(ph)));

  const broken = mkProject({ 'package.json': '{ 这不是 json' });
  ok('package.json 坏了不崩，继续往下找', discoverTests(broken) === null);

  const dirA = mkProject({ 'test/a-test.mjs': '1', 'test/b.test.js': '1', 'test/c_test.py': '1' });
  const spec = discoverTests(dirA);
  ok('扫 test/ 下的约定名（node 只收 js/ts，别拿 node 去跑 .py）',
    spec && spec.kind === 'node' && spec.files.length === 2, JSON.stringify(spec));
  ok('约定名带目录前缀（spawn 时相对工作区）', spec && spec.files.every(f => f.startsWith('test/')));

  const onlyEval = mkProject({ 'test/judge-eval.mjs': '1', 'test/render-smoke.mjs': '1' });
  ok('*-eval / *-smoke 不算（要网络和模型额度，不能塞进每次改动）', discoverTests(onlyEval) === null);

  const pyDir = mkProject({ 'conftest.py': '', 'test_calc.py': 'def test_a(): pass' });
  const py = discoverTests(pyDir);
  ok('有 pytest 配置时按 pytest 跑', py && py.kind === 'pytest' && py.cmd === 'python3', JSON.stringify(py));

  const pyBare = mkProject({ 'test_calc.py': 'def test_a(): pass' });
  ok('只有 test_*.py 没有 pytest 配置时不猜', discoverTests(pyBare) === null);

  const empty = mkProject({ 'readme.md': '# hi' });
  ok('空项目返回 null（不能编一个通过出来）', discoverTests(empty) === null);
}

console.log('[3] 解析各家 runner 的输出');
{
  const zh = parseTestOutput('\n11 通过 / 2 失败\n', '', 1, 'test/x.mjs');
  ok('认中文汇总行', zh.pass === 11 && zh.fail === 2, JSON.stringify(zh));

  const marks = parseTestOutput('  ✗ 常量应为 42\n  ✗ 应该导出 VALUE\n\n0 通过 / 2 失败\n', '', 1, 'a.mjs');
  ok('✗ 行收集成失败项', marks.fails.length === 2 && marks.fails[0].name === '常量应为 42', JSON.stringify(marks.fails));
  ok('失败项带上文件名（多文件跑时能定位）', marks.fails[0].file === 'a.mjs');

  const tap = parseTestOutput('not ok 3 - should add numbers\n', '', 1);
  ok('认 TAP 的 not ok', tap.fails.some(f => /should add numbers/.test(f.name)), JSON.stringify(tap.fails));

  const vit = parseTestOutput('  ✕ renders header\n\n  Tests: 1 failed, 4 passed\n', '', 1);
  ok('认 vitest 的 ✕', vit.fails.some(f => /renders header/.test(f.name)));
  ok('认 vitest 的 Tests: 汇总', vit.fail === 1 && vit.pass === 4, JSON.stringify(vit));

  const py = parseTestOutput('FAILED test_calc.py::test_add - assert 1 == 2\n', '', 1);
  ok('认 pytest 的 FAILED 行', py.fails.some(f => /test_calc.py::test_add/.test(f.name)));

  const crash = parseTestOutput('', "SyntaxError: Unexpected token '}'\n    at file:///x/y.mjs:1", 1, 'y.mjs');
  ok('进程崩了要补一条伪失败（否则「0 失败」会被当成通过）',
    crash.fails.length === 1 && /退出码 1/.test(crash.fails[0].name), JSON.stringify(crash));
  ok('崩了的输出尾巴要带上（方便定位）', /SyntaxError/.test(crash.fails[0].name), crash.fails[0].name);

  const green = parseTestOutput('\n5 通过 / 0 失败\n', '', 0);
  ok('全绿不产生失败项', green.fails.length === 0 && green.fail === 0 && green.pass === 5);

  const ansi = parseTestOutput('\u001b[31m  ✗ 染色的失败行\u001b[0m\n', '', 1);
  ok('剥掉 ANSI 色码后仍能认出失败行', ansi.fails.length === 1, JSON.stringify(ansi.fails));

  const noise = parseTestOutput('Error: 这句只是日志\n\n3 通过 / 0 失败\n', '', 0);
  ok('正文里的 Error 不算失败（绿的就是绿的）', noise.fails.length === 0);
}

console.log('[4] 该跑 / 不该跑：三种「没跑」必须静默');
{
  resetBaseline();
  const dir = mkProject({ 'lib.mjs': 'export const VALUE = 42;\n', 'test/lib-test.mjs': TEST_SCRIPT });

  const notCode = await runAfterEdit({ root: dir, changed: 'report.md', perms: { exec: true } });
  ok('改文档不跑测试', notCode.ran === false && notCode.reason === 'not-code', JSON.stringify(notCode));

  const noPerm = await runAfterEdit({ root: dir, changed: 'lib.mjs', perms: { write: true } });
  ok('没开 exec 权限不跑（跑测试 = 执行工作区里的任意代码）',
    noPerm.ran === false && noPerm.reason === 'no-exec-perm', JSON.stringify(noPerm));

  const bare = mkProject({ 'lib.mjs': 'export const VALUE = 42;\n' });
  const none = await runAfterEdit({ root: bare, changed: 'lib.mjs', perms: { exec: true } });
  ok('没有测试基建就不跑', none.ran === false && none.reason === 'no-tests', JSON.stringify(none));

  const okRun = await runAfterEdit({ root: dir, changed: 'lib.mjs', perms: { exec: true } });
  ok('测试全绿时判通过', okRun.ran === true && okRun.pass === true, JSON.stringify(okRun));
  ok('全绿时数出通过项（不是笼统一句「跑过了」）', okRun.passCount >= 2, String(okRun.passCount));
  ok('全绿时 why 里带耗时', /全通过.*\ds|全通过.*\d+ms/.test(okRun.why), okRun.why);
}

console.log('[5] 跑挂了：首次红 / 老红 / 新红必须分开判');
{
  resetBaseline();
  const dir = mkProject({ 'lib.mjs': 'export const VALUE = 42;\n', 'test/lib-test.mjs': TEST_SCRIPT });

  /* 把常量改坏 —— 这就是「改完没跑测试就会漏掉」的典型 */
  fs.writeFileSync(path.join(dir, 'lib.mjs'), 'export const VALUE = 7;\n');
  const first = await runAfterEdit({ root: dir, changed: 'lib.mjs', perms: { exec: true } });
  ok('首次跑就红 → 判失败（不能放行一次未经检验的改动）', first.ran && first.pass === false, JSON.stringify(first.why));
  ok('失败原因说清楚「没法判断是不是这次改的」', /第一次跑/.test(first.why), first.why);
  ok('证据里有失败断言名', /常量应为 42/.test(first.evidence), first.evidence);

  const again = await runAfterEdit({ root: dir, changed: 'lib.mjs', perms: { exec: true } });
  ok('同样的失败再跑一次不算「新失败」', again.pass === true, JSON.stringify(again.why));
  ok('但要如实说是既有失败，不是全绿', /既有失败/.test(again.why), again.why);
  ok('既有失败计数带上', again.known.length === 1, JSON.stringify(again.known));

  /* 再加一条失败：这才是这次改出来的 */
  fs.writeFileSync(path.join(dir, 'test', 'lib-test.mjs'), TEST_SCRIPT.replace(
    'ok(\'应该导出 VALUE\'',
    "ok('这条是刚坏的', false);\nok('应该导出 VALUE'"
  ));
  const fresh = await runAfterEdit({ root: dir, changed: 'test/lib-test.mjs', perms: { exec: true } });
  ok('新冒出来的失败必须拦住', fresh.pass === false, JSON.stringify(fresh.why));
  ok('why 里区分「新出现」和总数', /新出现 1 项失败/.test(fresh.why), fresh.why);
  ok('新失败只算新增那条', fresh.fresh.length === 1 && /这条是刚坏的/.test(fresh.fresh[0]), JSON.stringify(fresh.fresh));
}

console.log('[6] 超时与进程崩溃：不能把「没跑完」当成「通过」');
{
  resetBaseline();
  const slow = mkProject({
    'lib.mjs': 'export const VALUE = 42;\n',
    'test/slow-test.mjs': 'setTimeout(() => { console.log("\\n1 通过 / 0 失败"); }, 3000);\n'
  });
  const t0 = Date.now();
  const r = await runAfterEdit({ root: slow, changed: 'lib.mjs', perms: { exec: true }, timeoutMs: 1200, budgetMs: 6000 });
  const spent = Date.now() - t0;
  ok('单文件超时会被强杀', spent < 2900, `实际 ${spent}ms`);
  ok('超时判失败（没跑完 ≠ 通过）', r.pass === false, JSON.stringify(r.why));
  ok('证据里写明是超时被中止', /超过单文件上限|中止/.test(r.evidence), r.evidence);

  resetBaseline();
  const broken = mkProject({
    'lib.mjs': 'export const VALUE = 42;\n',
    'test/broken-test.mjs': 'import x from "./不存在.mjs";\nconsole.log("1 通过 / 0 失败");\n'
  });
  const b = await runAfterEdit({ root: broken, changed: 'lib.mjs', perms: { exec: true } });
  ok('import 失败（进程崩）判失败', b.pass === false, JSON.stringify(b.why));
  ok('崩溃原因进证据', /退出码|Cannot find/.test(b.evidence), b.evidence);

  /* 总预算不够跑完全部文件：不能拿「跑完的那几个是绿的」冒充全绿。
     7 个文件 × 800ms，预算 2.2 秒 —— 并发 3 的一批 0.8 秒，第二批还没起就没预算了 */
  resetBaseline();
  const slowOne = 'setTimeout(() => { console.log("\\n1 通过 / 0 失败"); }, 800);\n';
  const manyFiles = { 'lib.mjs': 'export const VALUE = 42;\n' };
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) manyFiles[`test/${n}-test.mjs`] = slowOne;
  const many = mkProject(manyFiles);
  const cut = await runAfterEdit({ root: many, changed: 'lib.mjs', perms: { exec: true }, timeoutMs: 3000, budgetMs: 2200 });
  ok('预算不够跑完全部 → 判失败，不冒充全绿', cut.pass === false, JSON.stringify(cut.why));
  ok('说明只跑了几分之几', /只跑完 \d+\/7/.test(cut.why), cut.why);

  const skip = await runAfterEdit({ root: many, changed: 'lib.mjs', perms: { exec: true }, timeoutMs: 3000, budgetMs: 2200 });
  ok('跑不完的项目 10 分钟内不再每次重烧预算', skip.ran === false && skip.reason === 'too-slow', JSON.stringify(skip));
}

console.log('[7] 接线：服务端跑完要把结论挂到 verify 上，前端才会回灌给模型');
{
  const serverSrc = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  ok('server.js 引入了 runAfterEdit', /import \{ runAfterEdit \} from '\.\/lib\/selftest\.js'/.test(serverSrc));
  ok('改文件成功后调用它（传服务端生效权限 p，不是前端原始 perms）',
    /await runAfterEdit\(\{ root, changed: args\.path, perms: p \}\)/.test(serverSrc));
  ok('p 来自服务端权限交集（前端只能收紧）',
    /const pm = effectivePerms\(scope, perms\);\s*\n\s*const p = pm\.perms;/.test(serverSrc));
  ok('只对 write_file / edit_file 触发', /name === 'edit_file' \|\| name === 'write_file'/.test(serverSrc));
  ok('测试挂了把 verify 判成不通过', /else \{\s*verify = \{ pass: false, why: t\.why, by: 'autotest' \}/.test(serverSrc));
  ok('测试失败证据拼进输出（模型才看得到哪条断言挂了）', /output = `\$\{out\.output\}\\n\\n\$\{String\(t\.evidence/.test(serverSrc));
  ok('响应体透出 tests 字段（前端/排查都能读）', /\btests,$/.test(serverSrc) || /\n\s+tests,/.test(serverSrc));
  ok('verify 改成 let（否则挂不上测试结论）', /let verify = verifyStep\(name, args, out, root\)/.test(serverSrc));

  /* 回灌那一环在 public/agent.js：verify 不过时给模型的消息里带「校验未通过」 */
  const agentSrc = fs.readFileSync(new URL('../public/agent.js', import.meta.url), 'utf8');
  ok('前端仍把 verify 失败回灌给模型',
    /let toolContent = v\.pass[\s\S]{0,120}【校验未通过】/.test(agentSrc));
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
resetBaseline();
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
