// edit_file：改已有文件的局部，而不整篇重写。
// 它存在的唯一理由是大文件——app.js 30 万字符，模型单次输出上限约 2000 token，
// 整篇重写物理上不可能。所以这组测试盯三件事：
//   1) 定位必须准（找不到 / 找到多处都要拒绝，不能猜）
//   2) 只动该动的地方（其余一字不差）
//   3) 改出语法错误必须撤回，绝不留坏文件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTool, planEdit, TOOL_DEFS, TOOL_CATEGORY } from '../lib/tools.js';
import { verifyStep } from '../lib/verify.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-test-'));
const W = (n) => path.join(tmp, n);
const rel = (n) => path.relative(tmp, W(n));

console.log('[1] 定位阶段：找不到 / 找到多处都要拒绝，不能猜');
{
  const src = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';

  ok('old_string 为空被拒', /不能为空/.test(planEdit(src, '', 'x', false).error || ''));

  ok('old == new 被拒（无意义编辑）', /一模一样/.test(planEdit(src, 'return 1;', 'return 1;', false).error || ''));

  const miss = planEdit(src, 'return 999;', 'return 3;', false);
  ok('找不到原文被拒', /没有这段原文/.test(miss.error || ''), miss.error);
  ok('找不到时不产出新内容', miss.after === undefined);

  // 缩进不一致：文件里是 tab，模型抄成 4 个空格 —— 逐字匹配必然失败，但要认出「只是空白不同」
  const tabSrc = 'function c() {\n\treturn 1;\n}\n';
  const indent = planEdit(tabSrc, '    return 1;', 'return 3;', false);
  ok('缩进对不上时给出专门提示（tab 抄成空格）', /空白\/缩进对不上/.test(indent.error || ''), indent.error);

  const dup = planEdit(src, 'return', 'x', false);
  ok('出现多次且未声明 replace_all 时拒绝', /出现了 2 次/.test(dup.error || ''), dup.error);
  ok('拒绝时告诉它出现在哪几行', /第 2、6 行/.test(dup.error || ''), dup.error);

  const near = planEdit(src, 'function b() {\n  return 99;\n}', 'x', false);
  ok('整段没命中时给出最接近的行号', /最接近的是第 5 行/.test(near.error || ''), near.error);
}

console.log('[2] 替换阶段：只动该动的地方');
{
  const src = 'a1\na2\nTARGET\na4\na5\n';
  const r = planEdit(src, 'TARGET', 'CHANGED', false);
  ok('唯一命中时替换成功', r.replaced === 1 && r.error === undefined);
  ok('替换后目标消失', !r.after.includes('TARGET') && r.after.includes('CHANGED'));
  ok('其余内容一字未动', r.after === 'a1\na2\nCHANGED\na4\na5\n', JSON.stringify(r.after));
  ok('记录改前改后长度（供校验对账）', r.beforeLen === src.length && r.afterLen === r.after.length);

  const all = planEdit(src, 'a', 'A', true);
  ok('replace_all 时全部替换（a 出现 4 次）', all.replaced === 4 && all.after === 'A1\nA2\nTARGET\nA4\nA5\n', JSON.stringify(all.after));

  /* 关键陷阱：new_string 里带 $& / $1 时，用 String.replace 会被当成替换模式，把内容改坏 */
  const dollar = planEdit('price = OLD;', 'OLD', '$&$&', false);
  ok('new_string 里的 $& 原样写入，不被当替换模式', dollar.after === 'price = $&$&;', JSON.stringify(dollar.after));

  const del = planEdit('keep\nDELETE ME\nkeep2\n', 'DELETE ME\n', '', false);
  ok('new_string 留空等于删除这一段', del.after === 'keep\nkeep2\n', JSON.stringify(del.after));

  ok('替换预览带行号，能自己核对位置', /\d+\| /.test(r.preview || ''), r.preview);
}

console.log('[3] 端到端：真的写进文件，且校验认账');
{
  fs.writeFileSync(W('t1.js'), 'const A = 1;\nconst B = 2;\nconst C = 3;\n');
  const out = await runTool('edit_file', { path: rel('t1.js'), old_string: 'const B = 2;', new_string: 'const B = 22;' }, { workspace: tmp });
  ok('真实改文件返回成功', out.ok === true, out.output);
  ok('文件内容已变', fs.readFileSync(W('t1.js'), 'utf8') === 'const A = 1;\nconst B = 22;\nconst C = 3;\n');
  ok('返回结构化 replaced 计数', out.replaced === 1, `replaced=${out.replaced}`);
  const v = verifyStep('edit_file', { path: rel('t1.js'), old_string: 'const B = 2;', new_string: 'const B = 22;' }, out, tmp);
  ok('校验判通过', v.pass === true, v.why);

  /* 文件不存在：要引导去 write_file，而不是静默建一个空文件 */
  const noFile = await runTool('edit_file', { path: rel('ghost.js'), old_string: 'a', new_string: 'b' }, { workspace: tmp });
  ok('文件不存在时拒绝并指向 write_file', noFile.ok === false && /write_file/.test(noFile.output), noFile.output);
  ok('拒绝时不会凭空建文件', !fs.existsSync(W('ghost.js')));

  const outside = await runTool('edit_file', { path: '../../etc/hosts', old_string: 'a', new_string: 'b' }, { workspace: tmp });
  ok('越界路径被拒', outside.ok === false && /超出工作目录/.test(outside.output), outside.output);

  fs.writeFileSync(W('bin.dat'), Buffer.from([0x41, 0x00, 0x42]));
  const bin = await runTool('edit_file', { path: rel('bin.dat'), old_string: 'A', new_string: 'Z' }, { workspace: tmp });
  ok('二进制文件被拒（utf8 读写会损坏它）', bin.ok === false && /二进制/.test(bin.output), bin.output);
}

console.log('[4] 语法闸门：改坏了必须撤回，工作区不留坏代码');
{
  const orig = 'export function f() {\n  return 1;\n}\n';
  fs.writeFileSync(W('t2.js'), orig);
  /* 把结尾的 } 删掉 → 语法坏 */
  const out = await runTool('edit_file', { path: rel('t2.js'), old_string: '  return 1;\n}\n', new_string: '  return 1;\n' }, { workspace: tmp });
  ok('语法不通过时判失败', out.ok === false, out.output);
  ok('失败原因说清是语法问题', /语法不通过/.test(out.output || ''), out.output);
  ok('文件被完整回滚（与改前逐字一致）', fs.readFileSync(W('t2.js'), 'utf8') === orig, JSON.stringify(fs.readFileSync(W('t2.js'), 'utf8')));

  /* 非 JS 文件不做语法检查，不能因为 .md 里少个括号就拦 */
  fs.writeFileSync(W('t3.md'), '# 标题\n\n正文\n');
  const md = await runTool('edit_file', { path: rel('t3.md'), old_string: '正文', new_string: '正文（改过）' }, { workspace: tmp });
  ok('非 JS 文件不受语法闸门影响', md.ok === true, md.output);

  /* 合法改动要能过闸门 —— 上面 t1.js 已证明，这里再验一次带 import 的文件 */
  fs.writeFileSync(W('t4.mjs'), "import fs from 'node:fs';\nexport const x = 1;\n");
  const esm = await runTool('edit_file', { path: rel('t4.mjs'), old_string: 'export const x = 1;', new_string: 'export const x = 2;' }, { workspace: tmp });
  ok('合法 ESM 改动通过语法闸门', esm.ok === true && fs.readFileSync(W('t4.mjs'), 'utf8').includes('x = 2'), esm.output);
}

console.log('[5] 校验层：长度必须对得上账，不许「说改了其实没改」');
{
  fs.writeFileSync(W('t5.js'), 'aaaa\n');
  const args = { path: rel('t5.js'), old_string: 'aa', new_string: 'bbb' };
  /* 声称替换了 1 处，但长度变化对不上（实际应 +1，这里故意报 +99） */
  const lie = verifyStep('edit_file', args, { ok: true, replaced: 1, beforeLen: 5, afterLen: 104 }, tmp);
  ok('长度对不上时判失败', lie.pass === false && /长度变化对不上/.test(lie.why), lie.why);

  const zero = verifyStep('edit_file', args, { ok: true, replaced: 0, beforeLen: 5, afterLen: 5 }, tmp);
  ok('replaced=0 判失败（等于没改）', zero.pass === false && /一处都没替换/.test(zero.why), zero.why);

  const honest = verifyStep('edit_file', args, { ok: true, replaced: 1, beforeLen: 5, afterLen: 6 }, tmp);
  ok('账对得上时通过', honest.pass === true, honest.why);
}

console.log('[6] 真场景：30 万字符的大文件，只改一行');
{
  const big = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  ok('app.js 确实是大文件（>20 万字符）', big.length > 200000, `${big.length} 字符`);

  fs.writeFileSync(W('big.js'), big);
  const before = fs.readFileSync(W('big.js'), 'utf8');
  const line = 'const RUNNING_KEY = \'boss.running\';';
  ok('目标行在文件里唯一', before.split(line).length - 1 === 1, `出现 ${before.split(line).length - 1} 次`);

  const out = await runTool('edit_file', {
    path: rel('big.js'),
    old_string: line,
    new_string: 'const RUNNING_KEY = \'boss.running.v2\';'
  }, { workspace: tmp });

  const after = fs.readFileSync(W('big.js'), 'utf8');
  ok('大文件也能改（这正是 edit_file 的意义）', out.ok === true, out.output);
  ok('只多了 3 个字符（v2. → 精确替换没重写全文）', after.length === before.length + 3, `${before.length} → ${after.length}`);
  ok('其余内容逐字未变', after.replace('boss.running.v2', 'boss.running') === before);
  /* 只花几百字符的输出，而不是 30 万 */
  ok('模型只需输出被替换的那一小段', line.length < 60 && after.length > 200000);
}

console.log('[7] 注册齐全：漏一处就静默失效');
{
  const names = TOOL_DEFS.map(t => t.function && t.function.name);
  ok('TOOL_DEFS 里有 edit_file', names.includes('edit_file'));
  ok('TOOL_CATEGORY 标成 write', TOOL_CATEGORY.edit_file === 'write', TOOL_CATEGORY.edit_file);

  const def = TOOL_DEFS.find(t => t.function && t.function.name === 'edit_file');
  const req = (def && def.function.parameters.required) || [];
  ok('参数 required 是 path/old_string/new_string', ['path', 'old_string', 'new_string'].every(k => req.includes(k)), req.join(','));

  /* 前端白名单：不在 CORE_TOOLS 也没被 NEED_TOOLS 命中，工具就永远不会下发给模型 */
  const agentSrc = fs.readFileSync(new URL('../public/agent.js', import.meta.url), 'utf8');
  const core = (agentSrc.match(/const CORE_TOOLS = \[([^\]]*)\]/) || [])[1] || '';
  ok('前端 CORE_TOOLS 含 edit_file（否则静默失效）', /'edit_file'/.test(core), core.slice(0, 120));

  const serverSrc = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  ok('server.js 的 writes 集合含 edit_file', /new Set\(\['write_file', 'edit_file'/.test(serverSrc));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
