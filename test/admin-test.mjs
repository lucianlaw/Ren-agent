/* 管理后台：模型接入 / 标准员工 / Agent 逻辑 / 质检平台。
 *
 * 这组测试盯四件事：
 *   1. 入口只有管理员看得到——按钮默认 hidden，权限判定在服务端，前端不写死名单。
 *   2. 质检台真的从用户端下架了（连 DOM 都不在主界面里），不是 CSS 藏起来。
 *   3. 标准员工那套「档案 + 记忆」能落地：云端函数齐、取用时带 std_id、记忆实时读。
 *   4. Agent 逻辑页的数字来自设置而不是写死——改 maxSteps，节点上的闸值要跟着变。
 *
 * 跑法：node test/admin-test.mjs
 * 只测纯函数与源码结构，不连网、不起服务。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const adminSrc = read('../public/admin.js');
const adminCss = read('../public/admin.css');
const appJs = read('../public/app.js');
const cloudJs = read('../public/cloud.js');
const agentJs = read('../public/agent.js');
const meetJs = read('../public/meeting.js');
const reviewJs = read('../public/review.js');
const html = read('../public/index.html');
const serverJs = read('../server.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/* ── 沙箱：给 admin.js 一个最小 DOM，让它能初始化并交出 window.ADMIN ── */
function makeSandbox(settings) {
  const noop = () => {};
  const el = () => ({
    hidden: false, innerHTML: '', textContent: '', value: '', disabled: false,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, appendChild: noop, focus: noop, style: {}
  });
  const doc = {
    readyState: 'complete',
    body: { classList: { add: noop, remove: noop } },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: el
  };
  const win = {
    APP: {
      state: { isAdmin: true, settings: settings || {}, models: [], staff: [] },
      esc: (s) => String(s == null ? '' : s),
      toast: noop,
      showView: noop,
      openSettings: noop
    },
    CLOUD: {},
    REVIEW: {},
    TRAITS: null
  };
  new Function('window', 'document', 'console', adminSrc)(win, doc, console);
  return win;
}

/* ── 1. 入口与权限 ── */
console.log('[1] 入口只在管理员这边露出来');
ok('顶栏有「管理后台」按钮', /id="adminBtn"/.test(html));
ok('按钮默认 hidden（前端不先露再收）', /id="adminBtn"[^>]*hidden/.test(html));
ok('按钮在顶栏导航里', /<nav class="top-nav">[\s\S]*?adminBtn[\s\S]*?<\/nav>/.test(html));
ok('旧的「质检台」顶栏按钮已删掉', !/id="evalBtn"/.test(html));
ok('app.js 里也没有残留的 evalBtn 绑定', !appJs.includes("$('#evalBtn')"));
ok('权限判定仍走 /api/is-admin', appJs.includes('/api/is-admin'));
ok('服务端白名单不在 public 下（浏览器拿不到）', serverJs.includes("path.join(__dirname, 'admins.json')"));
ok('管理员 uid 两端都归一（带不带 wu: 都认）', /replace\(\/\^wu:\//.test(serverJs));
ok('checkAdmin 通过后才把入口露出来', /adminBtn'\)[\s\S]{0,80}hidden = !state\.isAdmin/.test(appJs));
ok('非管理员点进去会被挡住', /if \(!state\.isAdmin\) return toast\('这一页只有管理员能看'\)/.test(appJs));
ok('切账号 / 退出登录会把后台收走', /ADMIN\.close\(\)/.test(appJs));
ok('ADMIN.open 自己也校验一次，不靠按钮 hidden 兜底',
  /function open\(page\) \{[\s\S]{0,160}if \(!st\.isAdmin\) return toast/.test(adminSrc));

/* ── 2. 质检台从用户端下架 ── */
console.log('[2] 质检台搬进后台，主界面不再有它');
const appStart = html.indexOf('id="adminApp"');
const evAt = html.indexOf('id="evalView"');
ok('adminApp 容器存在', appStart > 0);
ok('evalView 挪到了 adminApp 内部（不是 CSS 藏起来）', evAt > appStart && evAt > 0);
const layoutEnd = html.indexOf('id="visionView"');
ok('主布局里已经找不到 evalView', layoutEnd > 0 && !(evAt > 0 && evAt < layoutEnd));
ok('后台菜单有五项', (html.match(/class="adm-nav-i"/g) || []).length === 5);
['models', 'staff', 'flow', 'points', 'qa'].forEach(p => {
  ok(`菜单含 ${p} 页`, html.includes(`data-page="${p}"`));
});
ok('质检台由 REVIEW.open 挂载', /REVIEW\.open/.test(adminSrc));
ok('后台可以退出回工作台', /id="admExit"/.test(html) && /admExit/.test(adminSrc));
ok('Esc 也能退（全屏层没有明显关闭位置）', /e\.key === 'Escape' && S\.on/.test(adminSrc));

/* ── 3. 标准员工的数据层 ── */
console.log('[3] 标准员工：公共可读、只本人可写');
ok('云端导出 listStdStaff', /listStdStaff/.test(cloudJs.split('window.CLOUD = {')[1] || ''));
ok('云端导出 addStdStaff / updateStdStaff / deleteStdStaff',
  /addStdStaff, updateStdStaff, deleteStdStaff/.test(cloudJs));
ok('云端导出记忆增删改', /addStdMem, updateStdMem, deleteStdMem/.test(cloudJs));
ok('取用走单独函数 adoptStdStaff', /async function adoptStdStaff/.test(cloudJs));
ok('取用时把 std_id 写进自己的员工记录', /std_id: Number\(std\.stdId\)/.test(cloudJs));
ok('读自己的员工时把 std_id 读回来', /stdId: Number\(r\.std_id\)/.test(cloudJs));
ok('记忆按 staff_id 分组拼到员工上', /byStaff\[m\.stdId\]/.test(cloudJs));
ok('删员工先删记忆，不留孤儿', /delete\(\)\.eq\('staff_id', stdId\)[\s\S]{0,200}from\('ba_std_staff'\)\.delete/.test(cloudJs));
ok('记忆读不到时不影响员工列表返回', /catch \(e\) \{\s*\/\* 记忆表读不到不该让整个员工库消失/.test(cloudJs));
ok('运行时按 std_id 取记忆（listStdMemOf）', /async function listStdMemOf/.test(cloudJs));

console.log('[3.1] 记忆真的进了提示词');
ok('任务线 buildSystem 收第 4 段', /function buildSystem\(staff, task, mem, stdMem\)/.test(agentJs));
ok('stdMem 插在「老板期望」之后', /staff\.notes \? `老板期望：\$\{staff\.notes\}` : '',\s*\n\s*stdMem \|\| ''/.test(agentJs));
ok('任务线有 stdMemBrief 并限制条数', /async function stdMemBrief[\s\S]{0,900}slice\(0, 40\)/.test(agentJs));
ok('续跑不重复取记忆（system 已在 messages 里）', /const stdMem = resuming \? '' : await stdMemBrief/.test(agentJs));
ok('取记忆失败不炸掉整段提示词', /catch \(e\) \{ return ''; \}/.test(agentJs));
ok('项目线有 primeStdMem 预热缓存', /async function primeStdMem/.test(meetJs));
ok('项目线 personaLine 拼上训练记忆', /const mem = stdMemLine\(cur\)/.test(meetJs));
ok('参会人带上 stdId', /stdId: Number\(s\.stdId\) \|\| 0/.test(meetJs));
ok('跑节点前先预热记忆', /await primeStdMem\(\[p\]\)/.test(meetJs));

console.log('[3.2] 用户端能用上标准员工');
ok('左栏员工页有标准员工库入口', /class="std-bar" id="stdBar"/.test(appJs));
ok('入口显示可用数量', /位可用 · 一键取用/.test(appJs));
ok('有取用弹层', /id="stdLibMask"/.test(html) && /id="stdLibList"/.test(html));
ok('只展示已发布的（草稿不外泄）', /filter\(s => s\.published\)/.test(appJs));
ok('游客态不给用（要登录才有归属）', /if \(state\.guest\) return toast\('登录后才能用标准员工库'\)/.test(appJs));
ok('取用后立刻进列表并重画', /state\.staff\.push\(made\)[\s\S]{0,80}renderStaff\(\)/.test(appJs));

/* ── 4. 后台页面的落地 ── */
console.log('[4] 四个页面都是真页面');
ok('模型页列出托管通道为「在用」', /托管通道[\s\S]{0,200}在用/.test(adminSrc));
ok('模型页把自有 Key 标成未启用', /自有 Key 直连[\s\S]{0,200}未启用/.test(adminSrc));
ok('Key 输入框是禁用态（占位不启用）', /id="admKeyBase"[^>]*disabled/.test(adminSrc));
ok('测试连通按钮也禁用', /id="admKeyTest"[^>]*disabled/.test(adminSrc));
ok('说明写清了「填了也不会被读取」', /填了也不会被读取/.test(adminSrc));
ok('标准员工页有同步自己员工的入口', /id="admSync"/.test(adminSrc) && /async function syncMine/.test(adminSrc));
ok('同步按「名字+岗位」去重（可反复点）', /has\.has\(key\)/.test(adminSrc));
ok('同步会告诉你新增几条 / 跳过几条', /新增 \$\{ok\}，已存在跳过 \$\{skip\}/.test(adminSrc));
/* 回归：曾经因为 insert 带了库里不存在的 owner_name，15 条全插失败、界面只剩空白 */
ok('插入遇到未知列会摘字段重试（不再整条废掉）', /42703/.test(cloudJs) && /delete p2\.owner_name/.test(cloudJs));
ok('插入返回空行要报错，不能当成功', /if \(!data \|\| !data\.length\) throw new Error\('写入被拒/.test(cloudJs));
ok('同步失败要说出来（不只是 console）', /同步失败（\$\{bad\} 位）/.test(adminSrc) && /S\.notice/.test(adminSrc));
ok('同步失败的原因留在页面上（toast 会消失）', /adm-warn/.test(adminSrc) && /\.adm-warn\{/.test(adminCss));
ok('同步完自动选中新搬进来的员工', /if \(!curStd\(\) && S\.std\.length\) S\.curId = \(added\[0\] \|\| S\.std\[0\]\)\.stdId/.test(adminSrc));
/* 后台是全屏层，顶栏返回必须常驻：不能塞进会被各页 head() 覆盖的 #admActions */
ok('顶栏有常驻的「返回用户端」', /id="admBack"/.test(html) && /← 返回用户端/.test(html));
ok('返回按钮不放在会被覆盖的 actions 里', /class="adm-acts" id="admActions"/.test(html));
ok('返回按钮点了真的退出后台', /const back = \$\('#admBack'\);\s*\n\s*if \(back\) back\.onclick = close;/.test(adminSrc));
ok('档案里能改性格四维', /id="admTraits"/.test(adminSrc) && /TRAITS\.allHTML/.test(adminSrc));
ok('记忆能加', /id="admMemAdd"/.test(adminSrc));
ok('记忆能改（就地换 textarea）', /data-edit/.test(adminSrc) && /updateStdMem\(mid, \{ text: v \}\)/.test(adminSrc));
ok('记忆能删且要确认', /confirm\('删掉这条记忆/.test(adminSrc));
ok('新建档没保存前不给加记忆（没有外键 id）', /先把档案存下来，再给它写记忆/.test(adminSrc));

/* ── 5. Agent 逻辑页的数字跟着设置走 ── */
console.log('[5] 流程图的闸值不是写死的');
const box = makeSandbox({ maxSteps: 9, maxTokens: 123000, projSteps: 4, projTokens: 300000 });
const A = box.ADMIN;
ok('window.ADMIN 暴露出来了', !!A);
ok('暴露流程取数口子', !!(A._flow && A._flow.task && A._flow.proj));

const task = A._flow.task();
const proj = A._flow.proj();
/* 这一页改成左右对照后，每行是 {k, neu, old}：左边是现在，右边是上一版。
   断言跟着改，但验的东西一条没少——节点齐不齐、数字跟不跟设置走、旧文案还在不在。 */
ok('任务链现在有 14 步', task.length === 14, task.length);
ok('任务链首步是「收任务」', task[0].neu.n === '收任务');
ok('任务链有预算闸（改后并入积分闸）', task.some(x => /预算闸/.test(x.neu.n)));
ok('任务链有步数闸', task.some(x => x.neu.n === '步数闸'));
ok('任务链有交付物校验（改后叫契约硬证据）', task.some(x => /契约硬证据|交付物校验/.test(x.neu.n)));
ok('任务链有独立验收', task.some(x => x.neu.n === '独立验收'));
ok('每一步都有说明', task.every(x => x.neu.d && x.neu.d.length > 6));
ok('旧版的「交付物校验」原文案还在右列', task.some(x => x.old && x.old.n === '交付物校验'));
ok('旧版的「预算闸」原文案还在右列', task.some(x => x.old && x.old.n === '预算闸'));

const tBudget = task.find(x => /预算闸/.test(x.neu.n));
const tStep = task.find(x => x.neu.n === '步数闸');
ok('预算闸显示设置里的 token 上限', JSON.stringify(tBudget.neu.p).includes('12.3 万'), JSON.stringify(tBudget.neu.p));
ok('步数闸显示设置里的步数', JSON.stringify(tStep.neu.p).includes('9 步'), JSON.stringify(tStep.neu.p));

ok('项目链现在有 12 步', proj.length === 12, proj.length);
ok('项目链有拆节点', proj.some(x => x.neu.n === '拆节点'));
ok('项目链有单节预算', proj.some(x => x.neu.n === '单节预算'));
ok('项目链有整场预算（改后并入积分闸）', proj.some(x => /整场预算/.test(x.neu.n)));

const pNode = proj.find(x => x.neu.n === '逐节执行');
ok('每节步数跟着设置走', JSON.stringify(pNode.neu.p).includes('4 步'), JSON.stringify(pNode.neu.p));
ok('出 PPT 那节自动 +5 步', JSON.stringify(pNode.neu.p).includes('9 步'), JSON.stringify(pNode.neu.p));
const pNodeBud = proj.find(x => x.neu.n === '单节预算');
ok('整场 30 万时单节仍封顶 8 万', JSON.stringify(pNodeBud.neu.p).includes('8 万'), JSON.stringify(pNodeBud.neu.p));

const low = makeSandbox({ projTokens: 50000 });
const lowNode = low.ADMIN._flow.proj().find(x => x.neu.n === '单节预算');
ok('整场比 8 万小时，单节跟着降到整场上限', JSON.stringify(lowNode.neu.p).includes('5 万'), JSON.stringify(lowNode.neu.p));

eq('fmtW 万位保留一位小数', A._flow.fmtW(123456), '12.3 万');
eq('fmtW 不足一万按原数', A._flow.fmtW(999), '999');

/* ── 6. 视觉与状态 ── */
console.log('[6] 后台是全屏独立层');
ok('admin.css 里 .adm 是 fixed 全屏', /\.adm\{position:fixed;inset:0/.test(adminCss));
ok('有侧栏 216px', /\.adm-side\{[\s\S]{0,80}216px/.test(adminCss));
ok('深色模式有补丁', /html\.dark \.adm-head/.test(adminCss));
ok('窄屏收成图标栏', /@media \(max-width:760px\)/.test(adminCss));
ok('切页时质检台与普通页互斥', /body\.hidden = true;[\s\S]{0,120}ev\.hidden = false/.test(adminSrc));
ok('退出后台会把质检台收起来', /const ev = \$'#evalView'|const ev = \$\('#evalView'\)/.test(adminSrc));

console.log('[7] 版本与加载顺序');
ok('admin.css 在 index 里加载', /admin\.css\?v=/.test(html));
ok('admin.js 在 app.js 之后加载（要用 APP）',
  html.indexOf('app.js?v=') < html.indexOf('admin.js?v='));
ok('版本号统一', new Set((html.match(/\?v=([0-9A-Za-z]+)/g) || [])).size === 1,
  JSON.stringify([...new Set(html.match(/\?v=([0-9A-Za-z]+)/g) || [])]));

/* 综述里没有的东西会被误以为做过 —— 顺手确认 review.js 没被改坏 */
ok('review.js 仍是原来那个导出面', /window\.REVIEW = \{/.test(reviewJs));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
