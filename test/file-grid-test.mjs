/* 产出文件卡：一行三个、从左往右排、排满换行

   以前每张卡独占一整行（横版：图标 | 名字 | 预览 | 下载），
   一个任务产出五六个文件就把对话区铺满，得往下滚半天才看得见结论。
   现在改成竖版小卡 + 三列网格，同时保证两件事：
     1. 文件名不截断（允许折行，长名字也看得全）；
     2. 「预览」「下载」两个按钮都完整露出来（等宽平分，不换行、不缩没）。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const meet = fs.readFileSync(path.join(root, 'public/meeting.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const rule = sel => {
  const i = css.indexOf(sel + '{');
  return i < 0 ? '' : css.slice(i + sel.length + 1, css.indexOf('}', i) + 1);
};
const fn = app.slice(app.indexOf('function filesBlockHTML('), app.indexOf('function turnHTML('));

console.log('三列网格');
{
  const g = rule('.file-grid');
  ok('有一层 .file-grid 容器', /class="file-grid"/.test(fn));
  ok('固定三列', /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(g), g);
  ok('列宽可压缩，不会撑破容器（minmax 下限是 0）', /minmax\(0,1fr\)/.test(g));
  ok('卡片之间有 8px 间距', /gap:8px/.test(g));
  ok('同行卡片等高', /align-items:stretch/.test(g));
  ok('卡片不再各占一行（旧的 margin-bottom:6px 已去掉）', !/margin-bottom:6px/.test(rule('.file-card')));
}

console.log('卡片是竖版：上半名字，下半按钮');
{
  ok('卡片改成纵向排列', /flex-direction:column/.test(rule('.file-card')));
  ok('上半部分包在 .fc-top 里', /class="fc-top"/.test(fn));
  ok('按钮单独一行 .fc-acts', /class="fc-acts"/.test(fn));
  ok('.fc-acts 不吃掉名字的高度、靠底部对齐', /margin-top:auto/.test(rule('.fc-acts')));
  ok('卡片允许收缩（min-width:0）', /min-width:0/.test(rule('.file-card')));
}

console.log('文件名必须看全');
{
  const b = rule('.fc-body b');
  ok('文件名允许折行', /white-space:normal/.test(b), b);
  ok('超长无空格文件名也强制断行', /overflow-wrap:anywhere/.test(b), b);
  ok('文件名不再用省略号截断', !/text-overflow:ellipsis/.test(b));
  ok('鼠标悬停能看到完整路径（title）', /<b title="\$\{esc\(p\.split\('\/'\)\.pop\(\)\)\}"/.test(fn));
  ok('路径仍是单行省略（次要信息）', /text-overflow:ellipsis/.test(rule('.fc-body i')));
}

console.log('两个按钮都完整');
{
  const d = rule('.fc-dl');
  ok('按钮等宽平分这一行', /flex:1 1 0/.test(d), d);
  ok('按钮可以缩但不会没（min-width:0 + 内边距收窄）', /min-width:0/.test(d));
  ok('按钮内文字不换行', /white-space:nowrap/.test(d));
  ok('按钮文字居中', /text-align:center/.test(d));
  ok('两个按钮都还在（预览 + 下载）', /data-preview=/.test(fn) && /download="\$\{esc\(p\.split\('\/'\)\.pop\(\)\)\}">下载<\/a>/.test(fn));
  ok('按钮顺序：预览在左、下载在右', fn.indexOf('预览</button>') < fn.indexOf('>下载</a>'));
}

console.log('窄了就少放几列，不硬挤');
{
  ok('用容器查询（跟主区拖窄联动，不看窗口宽度）', /\.node-files\{container-type:inline-size\}/.test(css));
  ok('容器 ≤520px 退两列', /@container \(max-width:520px\)\{\.file-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/.test(css));
  ok('容器 ≤340px 退一列', /@container \(max-width:340px\)\{\.file-grid\{grid-template-columns:minmax\(0,1fr\)\}\}/.test(css));
}

console.log('任务页和项目页共用同一块');
{
  ok('项目页直接复用 filesBlockHTML', /window\.APP\.filesBlockHTML/.test(meet));
  ok('filesBlockHTML 挂到了 window 上（项目页要用）', /window\.filesBlockHTML = filesBlockHTML;/.test(app));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
