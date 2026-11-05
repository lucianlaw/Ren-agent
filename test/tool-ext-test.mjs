/* 产出工具的后缀容忍 + 「闲聊不产出」的提示词约束
 *
 * 线上现场（2026-11-04，任务「你好」）：
 *   步骤 01 make_doc path=秘书就绪确认        → 失败「文件名必须以 .docx 结尾」
 *   步骤 02 make_doc path=秘书就绪确认.docx   → 成功
 * 老板看到的是「2 步执行 · 1 步失败」加一条红色报错，reason 是「这东西老出错」。
 *
 * 两件事都得修，而且不是同一件事：
 *   1. 漏后缀不该是错误。模型想说的就是「秘书就绪确认.docx」，只是没打后缀。
 *      报错逼它再调一次：白烧一轮 token，还把内部摩擦暴露给老板看。
 *   2. 但「你好」根本不该生成文档。这是提示词的问题——「停下来的条件是
 *      目标被满足、产出已落盘」对问候也生效，它就硬造一份东西来凑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, __test } from '../lib/tools.js';
import { verifyStep } from '../lib/verify.js';

const { ensureExt } = __test;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

/* ── [1] 后缀补全 ── */
console.log('[1] 漏后缀自动补，不报错');
{
  ok('给名字没后缀 → 补 .docx', ensureExt('秘书就绪确认', 'docx').path === '秘书就绪确认.docx',
    ensureExt('秘书就绪确认', 'docx'));
  ok('带子目录也照样补', ensureExt('报告/2026-W1 周报', 'docx').path === '报告/2026-W1 周报.docx');
  ok('已经对了就原样返回', ensureExt('提案.docx', 'docx').path === '提案.docx');
  ok('大小写不敏感', ensureExt('提案.DOCX', 'docx').path === '提案.DOCX');
  ok('xlsx 同规则', ensureExt('报价表', 'xlsx').path === '报价表.xlsx');
  ok('pptx 同规则', ensureExt('季度汇报', 'pptx').path === '季度汇报.pptx');
}

console.log('[2] 文件名里带点，不能被当成后缀');
{
  /* 「报价单.v2」是很常见的版本号写法。如果把它开头的 .v2 当扩展名，
     要么误拒、要么补成「报价单.docx」把版本号吃掉——两种都错。 */
  ok('.v2 不算扩展名，补在后面', ensureExt('报价单.v2', 'xlsx').path === '报价单.v2.xlsx',
    ensureExt('报价单.v2', 'xlsx'));
  ok('2026.11 这种日期不被吃掉', ensureExt('2026.11 台账', 'xlsx').path === '2026.11 台账.xlsx',
    ensureExt('2026.11 台账', 'xlsx'));
}

console.log('[3] 明确要了别的格式，就不能替它改');
{
  /* 这里和上面相反：模型写 .md 说明它可能想换格式（或想拿 md 顶替交付物），
     替它改成 .docx 等于「悄悄换格式」，比报错更坏——老板拿到的不是他要的东西，
     而且没有任何痕迹说明中途被换过。 */
  const md = ensureExt('报告.md', 'docx');
  ok('要 md 却调 make_doc → 报错', !!md.error, md);
  ok('报错里说清正确后缀是 .docx', /\.docx/.test(md.error || ''), md.error);
  ok('报错里说清别拿别的格式顶替', /顶替/.test(md.error || ''), md.error);
  ok('.pdf 同理', !!ensureExt('资料.pdf', 'docx').error);
  ok('.txt 同理', !!ensureExt('笔记.txt', 'xlsx').error);
}

console.log('[4] 空路径仍要拦');
{
  ok('空字符串报错', !!ensureExt('', 'docx').error);
  ok('只有空格也报错', !!ensureExt('   ', 'docx').error);
  ok('报错说清缺什么', /path/.test(ensureExt('', 'docx').error || ''));
}

/* ── [5] 真跑一次 make_doc：漏后缀这一路必须能出文件 ── */
console.log('[5] 端到端：漏后缀的 make_doc 真的出文件');
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-ext-'));
  const r = await runTool('make_doc', {
    path: '秘书就绪确认',
    title: '秘书就绪确认',
    markdown: '# 秘书就绪确认\n\n随时可以开工。'
  }, { workspace: ws });
  ok('不报错', r.ok === true, r.output);
  ok('文件落在工作区里且补了 .docx', fs.existsSync(path.join(ws, '秘书就绪确认.docx')),
    fs.readdirSync(ws));
  const st = fs.existsSync(path.join(ws, '秘书就绪确认.docx'))
    ? fs.statSync(path.join(ws, '秘书就绪确认.docx')) : null;
  ok('不是空文件', st && st.size > 1000, st && st.size);
  /* 校验必须认「实际写到哪」。以前 verify 拿 args.path 去对磁盘，
     漏后缀那次会得到「文件没有真的出现：秘书就绪确认」——文件就在旁边写着，
     却被标成校验未通过，模型于是再调一次同样的工具。这才是截图里
     「2 步执行 · 1 步失败」的真正来源。 */
  ok('结果里带实际落盘路径', r.path === '秘书就绪确认.docx', r.path);
  /* verify 在生产里由 server.js 调 verifyStep(name, args, out, root)。
     这里按同样的签名复现一次，确认它认 out.path 而不是原始 args.path。 */
  const v = verifyStep('make_doc', { path: '秘书就绪确认' }, r, ws);
  ok('校验通过（认的是实际落盘路径）', v.pass === true, v);
  /* 反过来确认一下：如果只拿原始参数去对磁盘，就会误判——这正是修改前的行为 */
  const bad = verifyStep('make_doc', { path: '秘书就绪确认' }, { ok: true, output: '', ms: 0 }, ws);
  ok('对照组：拿原始参数对磁盘确实会误判', bad.pass === false, bad);
  fs.rmSync(ws, { recursive: true, force: true });
}
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-ext-'));
  const r = await runTool('make_doc', {
    path: '报告.md', title: 't', markdown: '# x'
  }, { workspace: ws });
  ok('要 md 的那一次仍然被拦', r.ok === false, r.output);
  ok('拦下来时一个文件都没写', fs.readdirSync(ws).length === 0, fs.readdirSync(ws));
  fs.rmSync(ws, { recursive: true, force: true });
}

/* ── [6] 提示词：问候不该被逼着产出 ── */
console.log('[6] 提示词不再对问候强制落盘');
{
  const agent = fs.readFileSync(path.join(root, 'public/agent.js'), 'utf8');
  ok('有「先判断要不要动手」的总则', /先判断这句话要不要动手/.test(agent));
  ok('点名了打招呼 / 闲聊这类输入', /打招呼、闲聊/.test(agent));
  ok('明说这类直接回答、不建文件', /直接回答[^']*不建文件/.test(agent));
  ok('把「硬造文档」定性为过度交付', /过度交付/.test(agent));
  /* 原来那句是「停下来的条件是『目标被满足、产出已落盘』」，对问候也生效。
     现在必须带上「要交付的任务」这个限定，否则改回原文就前功尽弃。 */
  ok('收工条件限定在「要交付的任务」', /要交付的任务，停下来的条件是/.test(agent));
  ok('明说无需产出的问候答完即收工', /不需要产出的问候和问答/.test(agent));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
