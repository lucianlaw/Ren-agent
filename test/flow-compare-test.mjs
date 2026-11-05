/* Agent 逻辑页：改后 / 改前 左右对照。
 *
 * 这一页是给内部看「这一版到底动了什么」的，一旦哪行悄悄退回「两边同一份」，
 * 或者新增的那几步右边不再留空，看的人就会被误导。所以盯三件事：
 *   1. 每行标记只能是 新增 / 修改 / 保留 / 移除，且语义自洽：
 *      新增必须没有旧卡（右边渲染成空槽），修改必须有旧卡 + 一句「改了什么」。
 *   2. 旧逻辑不能丢：上一版的原文案要能在源文件里找到（不是删掉重写）。
 *   3. 左列与右列真的是两列（CSS 有 grid 定义），空槽有独立元素。
 *
 * 跑法：node test/flow-compare-test.mjs（不连网、不连库、不需要 DOM）
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const adminSrc = read('../public/admin.js');
const css = read('../public/admin.css');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 从源文件里按大括号配对抠出一段（函数或 const 字面量），不引整个 admin.js（它要 DOM） */
function grab(startText) {
  const i = adminSrc.indexOf(startText);
  if (i < 0) throw new Error('找不到 ' + startText);
  let depth = 0, started = false;
  for (let j = i; j < adminSrc.length; j++) {
    const c = adminSrc[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (started && depth === 0) return adminSrc.slice(i, j + 1);
    }
  }
  throw new Error('没配平 ' + startText);
}

const MOD = new Function(`
  const S = { flowOpen: '' };
  const esc = (s) => String(s == null ? '' : s);
  const APP = () => ({ state: { settings: { maxSteps: 24, maxTokens: 200000, projSteps: 6, projTokens: 600000 } } });
  ${grab('function fmtW(')}
  ${grab('function flowTask(')}
  ${grab('function flowProj(')}
  ${grab('const FLOW_MARK =')};
  ${grab('function flowCardHTML(')}
  ${grab('function flowHTML(')}
  return { flowTask, flowProj, flowHTML, flowCardHTML, FLOW_MARK };
`)();

const task = MOD.flowTask();
const proj = MOD.flowProj();

/* ── 1. 结构自洽 ── */
console.log('[1] 每行标记的语义自洽');
const ALLOW = ['new', 'chg', 'keep', 'gone'];
let badMark = '', badNew = '', badChg = '', badKeep = '';
[...task, ...proj].forEach(r => {
  if (ALLOW.indexOf(r.k) < 0) badMark = r.id + ':' + r.k;
  if (r.k === 'new' && r.old) badNew = r.id;
  if (r.k === 'chg' && (!r.old || !r.chg)) badChg = r.id;
  if (r.k === 'keep' && r.old !== undefined) badKeep = r.id;
});
ok('标记只用四种：新增 / 修改 / 保留 / 移除', !badMark, badMark);
ok('「新增」的行右边没有旧卡（右边是空槽）', !badNew, badNew);
ok('「修改」的行两边都有卡，且写了一句改了什么', !badChg, badChg);
ok('「保留」的行不重复维护一份旧文案', !badKeep, badKeep);

/* ── 2. 这一版必须体现出来的改动 ── */
console.log('[2] 新机制都出现在对照里');
const ids = [...task, ...proj].reduce((m, r) => { m[r.id] = r; return m; }, {});
ok('任务：建任务契约是新增的一步', ids.t3 && ids.t3.k === 'new');
ok('任务：预算闸改成「预算闸 · 积分闸」', ids.t4 && ids.t4.k === 'chg'
  && /积分/.test(ids.t4.neu.n + ids.t4.neu.d));
ok('任务：交付物校验升级成契约硬证据', ids.t10 && ids.t10.k === 'chg'
  && /契约/.test(ids.t10.neu.n));
ok('任务：收工前多一道压状态', ids.t12 && ids.t12.k === 'chg'
  && /压状态/.test(ids.t12.neu.n));
ok('任务：新增刷新判活（心跳）', ids.t13 && ids.t13.k === 'new'
  && /90/.test(JSON.stringify(ids.t13.neu.p)));
ok('任务：新增跨层状态归一', ids.t14 && ids.t14.k === 'new'
  && /states\.js/.test(JSON.stringify(ids.t14.neu.p)));
ok('项目：积分闸并进预算闸', ids.p5 && ids.p5.k === 'chg'
  && /积分/.test(ids.p5.neu.d));
ok('项目：新增节点状态归一（标签终于渲染）', ids.p7 && ids.p7.k === 'new'
  && /stTag/.test(ids.p7.neu.why));
ok('项目：新增计划版本化', ids.p9 && ids.p9.k === 'new'
  && /12/.test(JSON.stringify(ids.p9.neu.p)));
ok('项目：分析框对齐任务（直排）', ids.p10 && ids.p10.k === 'chg'
  && /bot-bub/.test(JSON.stringify(ids.p10.old)));
ok('项目：确认板限宽', ids.p11 && ids.p11.k === 'chg'
  && /660/.test(JSON.stringify(ids.p11.neu.p)));

/* ── 3. 旧逻辑一条没删 ── */
console.log('[3] 旧逻辑保留，不是删掉重写');
ok('旧文案「budget_exceeded 直接收工」还在', /budget_exceeded/.test(adminSrc));
ok('旧文案「一律 1.5 秒重试」还在', /1\.5 秒/.test(adminSrc));
ok('旧文案「撑满正文宽度」还在', /撑满正文宽度/.test(adminSrc));
ok('旧文案「铺满正文宽度」还在', /铺满正文宽度/.test(adminSrc));
ok('旧文案「全宽」还在', /全宽/.test(adminSrc));

/* ── 4. 渲染：右边空着就真的是空的 ── */
console.log('[4] 渲染出的右列');
const htmlTask = MOD.flowHTML(task);
ok('新增行渲染出空槽（不写任何字）', /adm-cmp-blank/.test(htmlTask));
ok('空槽里没有说明性文字', !/adm-cmp-blank[^>]*>[^<]*[^\s<]/.test(
  htmlTask.replace(/<div class="adm-cmp-blank" aria-hidden="true"><\/div>/g, '')));
ok('每个新增行各有一个空槽', (htmlTask.match(/adm-cmp-blank/g) || []).length === task.filter(r => r.k === 'new').length);
ok('右列旧卡是虚线槽，视觉上退到后面', /adm-cmp-c old/.test(htmlTask));
ok('汇总行写清新增 / 修改 / 保留的步数', /新增 \d+ 步 · 修改 \d+ 步 · 保留 \d+ 步/.test(htmlTask));
ok('表头标明左右两边是什么', /现在/.test(htmlTask) && /上一版/.test(htmlTask));

/* ── 5. 样式与绑定 ── */
console.log('[5] 两列是真两列');
ok('对照行用三列网格（标记 / 现在 / 上一版）',
  /\.adm-cmp-head,\.adm-cmp-row\{display:grid;grid-template-columns:56px minmax\(0,1fr\) minmax\(0,1fr\)/.test(css));
ok('空槽有独立样式（虚线，不给文字留位）', /\.adm-cmp-blank\{[^}]*border:1px dashed/.test(css));
ok('窄屏退成一列，旧卡换行到下方', /max-width:940px[\s\S]{0,260}adm-cmp-c\.old\{grid-column:2\}/.test(css));
ok('点击展开绑在对照行上（旧的时间线节点已撤）',
  /\$\$\('\.adm-cmp-row'\)/.test(adminSrc) && !/\$\$\('\.adm-fl'\)/.test(adminSrc));
ok('页头说明了「左边是现在、右边是上一版」', /右边是上一版/.test(adminSrc));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
