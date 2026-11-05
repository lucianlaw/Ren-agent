/* 两条栏宽拉手 + 左上角星标 + 点员工卡不再跳员工菜单

   以前：左右两栏是死宽度，读长文档时中间被挤成一条；
        改个员工模型，左栏「任务」Tab 明明点着，列表却被画成员工卡，
        再点一张卡就直接跳到员工详情，手上那件事找不回来了。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const meet = fs.readFileSync(path.join(root, 'public/meeting.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 布局里两段的位置关系：左拉手要在左栏之后、右拉手要在右侧栏之前 */
const layout = html.slice(html.indexOf('<div class="layout">'), html.indexOf('<!-- 管理后台：全屏覆盖层'));
const iRailL = layout.indexOf('class="rail"');
const iSplitL = layout.indexOf('id="splitL"');
const iSplitR = layout.indexOf('id="splitR"');
const iRailR = layout.indexOf('class="rail right"');

console.log('拉手挂在布局里');
{
  ok('左栏之后有左拉手', iRailL > 0 && iSplitL > iRailL, `${iRailL} / ${iSplitL}`);
  ok('左拉手在右拉手之前', iSplitL < iSplitR);
  ok('右拉手在右侧栏之前', iSplitR > 0 && iRailR > iSplitR, `${iSplitR} / ${iRailR}`);
  ok('两个拉手都有 separator 语义（读屏能用）',
    (layout.match(/role="separator" aria-orientation="vertical"/g) || []).length === 2);
  ok('两个拉手都能用键盘聚焦', (layout.match(/tabindex="0"/g) || []).length === 2);
}

console.log('栏宽是变量，不是写死的像素');
{
  ok(':root 定义了 --rail-rw', /--rail-rw:\s*232px/.test(css));
  ok('右栏宽度读变量', /\.rail\.right\{width:var\(--rail-rw\);flex:0 0 var\(--rail-rw\)/.test(css));
  ok('窄屏改的也是变量（拖动才不会被媒体查询盖掉）',
    /@media \(max-width:1180px\)\{\s*:root\{--rail-rw:196px\}/.test(css));
  ok('左栏仍然用 --rail-w（顶栏品牌占位跟着一起变）',
    /\.rail\{\s*\n?\s*width:var\(--rail-w\)/.test(css));
}

console.log('拉手长什么样');
{
  ok('手型是左右拖动', /\.splitter\{[^}]*cursor:col-resize/.test(css));
  ok('负边距叠在分隔线上，不吃布局宽度', /\.splitter\{[^}]*margin:0 -3px/.test(css));
  ok('拖动时出蓝线', /\.splitter:hover::after,\.splitter\.dragging::after/.test(css));
  ok('拖动时整页光标跟着变、防选中', /body\.resizing,body\.resizing \*\{cursor:col-resize!important;user-select:none!important\}/.test(css));
  ok('右侧栏收起时拉手也收起', /\.splitter\.right\{display:none\}/.test(css));
  ok('手机端左栏收起时拉手也收起', /\.splitter\.left\{display:none\}/.test(css));
}

console.log('拖动逻辑');
{
  ok('起手就是还原上次宽度 + 绑事件', /function initSplitters\(\)[\s\S]*localStorage\.getItem\(SPLIT_LS\[side\]\)/.test(app));
  ok('启动时调用了一次', /init\(\);\s*\n\/\* 栏宽拉手[\s\S]{0,40}\ninitSplitters\(\);/.test(app));
  ok('宽度记在本地', /const SPLIT_LS = \{ left: 'boss\.railW', right: 'boss\.outW' \}/.test(app));
  ok('只认左键，右键留给菜单', /if \(e\.button !== 0\) return;\s*\/\/ 只认左键/.test(app));
  ok('按位移算宽度，不是累加', /const want = startW \+ \(side === 'left' \? dx : -dx\)/.test(app));
  ok('夹紧范围：左 148–420、右 168–520', /SPLIT_MIN = \{ left: 148, right: 168 \}/.test(app) && /SPLIT_MAX = \{ left: 420, right: 520 \}/.test(app));
  ok('主区至少留 460px，别把对话挤成一条', /SPLIT_MIN_MAIN = 460/.test(app) && /total - otherW - SPLIT_MIN_MAIN/.test(app));
  ok('松手写回本地', /localStorage\.setItem\(SPLIT_LS\[side\], String\(w\)\)/.test(app));
  ok('拖完广播 resize，画布类预览重新量尺寸', /if \(moved\) window\.dispatchEvent\(new Event\('resize'\)\)/.test(app));
  ok('双击回默认宽', /el\.addEventListener\('dblclick'[\s\S]{0,200}removeProperty/.test(app));
  ok('键盘 ←/→ 也能调', /ArrowLeft[\s\S]{0,120}ArrowRight/.test(app));
}

console.log('左上角星标');
{
  ok('品牌区带星标', /<div class="brand"><i class="brand-star" aria-hidden="true">✦<\/i>Ren&nbsp;Agent<\/div>/.test(html));
  ok('星标样式跟着品牌字走', /\.brand-star\{font-style:normal;color:var\(--blue\);font-size:17px/.test(css));
}

console.log('员工卡不再劫持左栏');
{
  const fn = app.slice(app.indexOf('function renderStaffInRail()'), app.indexOf('function renderStaffInRail()') + 400);
  ok('函数自己守一道：不是员工 Tab 就直接返回', /if \(\(state\.lastListView \|\| 'task'\) !== 'staff'\) return;/.test(fn));
  ok('点卡先试着派活，再考虑开详情', /if \(assignStaffToOpen\(el\.dataset\.id\)\) return;/.test(app));
}

console.log('点员工卡 = 派给当前任务 / 项目');
{
  ok('有 assignStaffToOpen', /function assignStaffToOpen\(id\)/.test(app));
  ok('任务页：老任务换人走转交', /if \(t && t\.employeeName\)[\s\S]{0,320}handoverTask\(t, s\)/.test(app));
  ok('任务页：这一轮在跑就不换人', /if \(state\.running\) \{ toast\('这一轮还在跑，等它停下来再换人'\)/.test(app));
  ok('任务页：当选人就只改选择区', /state\.pickEmp = \[s\.id\];\s*\n\s*state\.curEmpId = s\.id;/.test(app));
  ok('项目页：拉进当前项目', /MEET\.addMembers\(\[s\.id\]\)/.test(app));
  ok('项目页：已经在项目里就不重复拉', /已经在这个项目里/.test(app));
  ok('派活全程不切主视图', !/function assignStaffToOpen[\s\S]{0,1600}showView\(/.test(app));
  ok('meeting.js 把 addMembers 交出来了', /addMembers \};/.test(meet));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
