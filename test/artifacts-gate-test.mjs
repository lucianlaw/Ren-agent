/* 产出物格式判定 + 产出缺口门禁

   规则（2026-11-03 老板定）：
   1. 老板点了名的格式，就照他说的做（说 .pptx 就不能给 docx）；
   2. 没点名就按动词判断：画 → 图片，写 → Word，统计 → Excel，做演示 → PPT；
   3. 不许拿 md 兜底；
   4. 真判断不出来，先问老板要哪种，别自己猜。

   背景（任务 #39「画一个马克杯」）：员工只写了一篇 md 就收工，
   一次 gen_image、一次 make_deck 都没调，产出栏里只有一个 .md。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = fs.readFileSync(path.join(root, 'public/agent.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 纯函数单独拿出来跑，避免为了测它去搭一整个浏览器环境。
   这两个函数依赖 ART_FORMS / ART_NUDGE 两个常量，切片要从常量开始。 */
const seg = agent.slice(agent.indexOf('const ART_FORMS'), agent.indexOf('async function run('));
const { wantedArtifacts: wanted, artNeedAsk } = new Function(seg + ';return { wantedArtifacts, artNeedAsk };')();
const keys = t => wanted(t).map(w => w.key);

console.log('老板点名要什么格式，就给什么');
{
  ok('「做个 .pptx」→ pptx', keys('做成 汇报.pptx').includes('pptx'));
  ok('「导出 word 文档」→ docx', keys('导出 word 文档').includes('docx'));
  ok('「要 Excel 版」→ xlsx', keys('给我一份 Excel 报价表').includes('xlsx'));
  ok('「转成 PDF」→ pdf', keys('把这份资料转成 PDF').includes('pdf'));
  ok('「出一版幻灯片」→ pptx', keys('出一版幻灯片').includes('pptx'));
  ok('点名 PPT 时不夹带 docx', !keys('做一套新人培训的 PPT').includes('docx'));
  ok('点名 Excel 时不夹带 docx', !keys('给我一份 Excel 报价表').includes('docx'));
}

console.log('没说格式，按动词判断');
{
  ok('「画一个马克杯」→ 图片', keys('画一个马克杯').includes('image'));
  ok('「画个马克杯」→ 图片', keys('画个马克杯').includes('image'));
  ok('「画张主视觉」→ 图片', keys('画张主视觉').includes('image'));
  ok('「设计一个马克杯，用图片展示」→ 图片', keys('设计一个马克杯，用图片展示给我').includes('image'));
  ok('「写一份本周周报」→ docx', keys('写一份本周周报').includes('docx'));
  ok('「帮我写一份月度复盘」→ docx（以前会退化成 md）', keys('帮我写一份月度复盘').includes('docx'));
  ok('「整理一份会议纪要」→ docx', keys('整理一份会议纪要').includes('docx'));
  ok('「把这些整理成表格」→ xlsx', keys('把这些整理成表格').includes('xlsx'));
  ok('「做一份汇报稿」→ pptx', keys('做一份汇报稿').includes('pptx'));
  ok('「画一个马克杯 + 顺带做个 PPT」两样都要', (() => {
    const k = keys('画一个马克杯\n顺带做个ppt');
    return k.includes('image') && k.includes('pptx') && k.length === 2;
  })());
  ok('同一种格式不重复记账', (() => {
    const k = keys('画个海报，再画一张封面图');
    return k.filter(x => x === 'image').length === 1;
  })());
}

console.log('不该误伤');
{
  ok('「画一张流程图」不算文生图', !keys('画一张流程图').includes('image'));
  ok('「画个系统架构图」不算文生图', !keys('画个系统架构图').includes('image'));
  ok('「读一下这个 pdf 附件」不算要产出 PDF', !keys('读一下这个 pdf 附件').includes('pdf'));
  ok('「写个爬虫脚本」不算要文档', !keys('写个爬虫脚本').includes('docx'));
  ok('「帮我写一段自我介绍」不当成要交文件', keys('帮我写一段自我介绍').length === 0);
  ok('「你好」什么都不产出', keys('你好').length === 0);
  ok('空目标不报错', Array.isArray(wanted('')) && wanted('').length === 0);
}

console.log('判断不了就问，别猜、别兜底成 md');
{
  ok('「帮我做个客户回访的东西」→ 要问', artNeedAsk('帮我做个客户回访的东西'));
  ok('「帮我弄一个新人入职的材料」→ 要问', artNeedAsk('帮我弄一个新人入职的材料'));
  ok('「画一个马克杯」→ 不用问', !artNeedAsk('画一个马克杯'));
  ok('「写一份周报」→ 不用问（动词已经能定）', !artNeedAsk('写一份周报'));
  ok('「帮我看看这份数据」→ 不拦，人家没要交东西', !artNeedAsk('帮我看看这份数据'));
  ok('「这个方案你觉得行吗」→ 不拦', !artNeedAsk('这个方案你觉得行吗'));
  ok('md 不会被当成任何类型的别名', !keys('做一份汇报').includes('md'));
  ok('ART_FORMS 里 md 只在老板点名时出现', wanted('写个 readme.md').every(w => w.key === 'md'));
}

console.log('落盘记账：什么才算「做出来了」');
{
  ok('write 类工具的结果进 made', /if \(out\.wrote\) \{ wrote\.push\(out\.wrote\); made\.push\(String\(out\.wrote\)\); \}/.test(agent));
  ok('gen_image 返回的图片路径也进 made', /if \(Array\.isArray\(out\.files\)\) for \(const f of out\.files\) made\.push\(String\(f\)\);/.test(agent));
  ok('.pptx 才算 PPT', /key: 'pptx', name: 'PPT（\.pptx）', re: \/\\\.pptx\$\/i/.test(agent));
  ok('.docx 才算 Word', /key: 'docx', name: 'Word（\.docx）', re: \/\\\.docx\$\/i/.test(agent));
  ok('.xlsx 才算 Excel', /key: 'xlsx', name: 'Excel（\.xlsx）', re: \/\\\.xlsx\?\$\/i/.test(agent));
  ok('png/jpg/webp 才算图', /key: 'image'.*re: \/\\\.\(png\|jpe\?g\|webp\)\$\/i/.test(agent));
}

console.log('收工前退回一次');
{
  ok('缺口检查放在「没工具调用」的收尾分支里', /if \(!r\.toolCalls\.length\) \{/.test(agent));
  ok('缺了就退回，最多一次', /if \(missArt\.length && artNudged < 1\)/.test(agent));
  ok('退回落成一步，老板能看见', /output: `退回补产出：\$\{names\}`/.test(agent));
  ok('提示里点明「md 不是兜底格式」', /md 不是兜底格式/.test(agent));
  ok('提示里点明 gen_image 一定能出图', /这个工具一定能出图/.test(agent));
  ok('没写权限就不逼着做文件', /if \(!perm\.write\) return false;/.test(agent));
  ok('没联网权限就不逼着画图', /w\.key === 'image' && !perm\.net/.test(agent));
  ok('PDF 没工具，不设门禁（交给提示词去问）', /w\.key === 'pdf'\) return false/.test(agent));
  ok('缺口信息取自目标 + 本轮每句话', /\.\.\.\(task\.userMsgs \|\| \[\]\)\.filter\(u => Number\(u && u\.round\) === myRound\)/.test(agent));
  ok('格式定不下来时先问，不硬做', /if \(!wantArt\.length && needAskFormat && onlyMd && !askedFormat\)/.test(agent));
  ok('只写了 md 才算「没交付」，做出正经文件就不拦', /const onlyMd = made\.every\(p => \/\\\.\(md\|markdown\|txt\)\$\/i\.test\(String\(p\)\)\);/.test(agent));
  ok('问过一次就不再拦，避免卡死', /askedFormat = true/.test(agent));
}

console.log('工具得先发下去，模型才可能用（真正的根因）');
{
  const segT = agent.slice(agent.indexOf('const CORE_TOOLS'), agent.indexOf('let activeGoa'));
  const { CORE_TOOLS, NEED_TOOLS } = new Function(segT + ';return { CORE_TOOLS, NEED_TOOLS };')();
  const picks = g => {
    const keep = new Set(CORE_TOOLS);
    for (const r of NEED_TOOLS) if (r.re.test(g)) r.add.forEach(n => keep.add(n));
    return keep;
  };
  ok('「画一个马克杯」→ 发 gen_image', picks('画一个马克杯').has('gen_image'));
  ok('「画张主视觉」→ 发 gen_image', picks('画张主视觉').has('gen_image'));
  ok('「帮我写一份月度复盘」→ 发 make_doc', picks('帮我写一份月度复盘').has('make_doc'));
  ok('「写一份本周周报」→ 发 make_doc', picks('写一份本周周报').has('make_doc'));
  ok('「顺带做个ppt」→ 发 make_deck', picks('画一个马克杯\n顺带做个ppt').has('make_deck'));
  ok('「整理成表格」→ 发 make_sheet', picks('把这些整理成表格').has('make_sheet'));
  ok('闲聊不会顺带发一堆重工具', !picks('你好').has('gen_image') && !picks('你好').has('make_deck'));
}

console.log('提示词也写清楚，别只靠门禁兜');
{
  const sys = agent.slice(agent.indexOf('function buildSystem'), agent.indexOf('function userContent'));
  ok('第 9 条：点名格式优先', /'9\. 产出物格式先看老板点名/.test(sys));
  ok('第 10 条：没点名按动词判断', /'10\. 老板没点格式时，按他的动词判断/.test(sys));
  ok('第 11 条：不许用 md 兜底', /'11\. 不许用 md 兜底/.test(sys));
  ok('第 12 条：判断不了先 ask_boss', /'12\. 格式真判断不了.*ask_boss/.test(sys));
  ok('第 13 条：PDF 做不了要问，不许拿 md 顶', /'13\. PDF 目前做不了/.test(sys));
  ok('第 14 条：要图必须 gen_image，别说没通道', /'14\. 老板要图.*gen_image/.test(sys));
  ok('ask_boss 的选项写明了四种格式', /Word \/ PPT \/ Excel \/ 图片/.test(sys));
  ok('正文不再教「要 PPT 就写 md 源文件」', !/这是 PPT 源文件/.test(sys));
}

console.log('项目侧（节点 / 项目里派活）同一套规则，不许在那边退化成 md');
{
  const meet = fs.readFileSync(path.join(root, 'public/meeting.js'), 'utf8');
  ok('节点 .docx → 教它调 make_doc', /\/\\\.docx\$\/i\.test\(n\.deliver \|\| ''\)[\s\S]{0,80}make_doc/.test(meet));
  ok('节点 .xlsx → 教它调 make_sheet', /\/\\\.xlsx\$\/i\.test\(n\.deliver \|\| ''\)[\s\S]{0,80}make_sheet/.test(meet));
  ok('节点 .png → 教它调 gen_image', /\\\.\(png\|jpe\?g\|webp\)\$\/i\.test\(n\.deliver \|\| ''\)[\s\S]{0,80}gen_image/.test(meet));
  ok('成品节点不再一律「write_file 写进」', /这一节要交的是成品文件 \$\{file\}：用对应工具做/.test(meet));
  ok('deliver 后缀认得 .docx（不会补成 .docx.md）', /docx\|xlsx\|pdf\|png/.test(meet) && !/\.\(md\|txt\|csv\|json\|pptx\|html\)\$/.test(meet));
  ok('成品节点步数也给够（不只 .pptx）', /\\\.\(pptx\|docx\|xlsx\|png\|jpe\?g\|webp\|pdf\)\$\/i\.test\(deliver/.test(meet));
  ok('节点规划按老板要的成品格式出成稿节点', /Word \/ 文档 \/ 报告 \/ 方案 \/ 复盘 → deliver 写 \.docx/.test(meet));
  ok('项目里派活也不再一律 write_file', !/要做产出（页面\/文档\/表格\/清单\/代码）就直接用 write_file/.test(meet));
  ok('项目里派活会按格式挑工具', /Word 用 make_doc、PPT 用 make_deck、Excel 用 make_sheet、图片用 gen_image/.test(meet));
  ok('节点把目标传给 toolLoop（不然工具清单还是旧任务的）', /goal: `\$\{n\.title \|\| ''\} \$\{n\.question \|\| ''\} \$\{n\.deliver \|\| ''\}`/.test(meet));
  ok('toolLoop 真的会按 goal 重设 activeGoal', /if \(goal\) activeGoal = String\(goal\);/.test(agent));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
