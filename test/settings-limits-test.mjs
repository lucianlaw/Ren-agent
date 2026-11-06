/* 设置里的「步数 / token 额度」：任务一套、项目一套。
 *
 * 这一块的坑不在界面，在「设了不生效」和「设了把项目烧穿」：
 *   1) 项目里的步数原来是写死的 6（PPT 那一节 11），设置面板里改了任务步数，项目纹丝不动。
 *   2) 项目整场 token 上限原来写死 60 万，改设置也不动，老板以为调低了其实没调。
 *   3) 输入框手滑输 0 或 99999，不能把 agent 推到荒谬边界（0 步 = 永远不干活）。
 *
 * 跑法：node test/settings-limits-test.mjs
 * 只测纯函数与结构，不连网、不起服务。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const appJs = read('../public/app.js');
const meetJs = read('../public/meeting.js');
const cloudJs = read('../public/cloud.js');
const html = read('../public/index.html');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/* ── 从源文件里抠真函数体来测，不复制实现 ── */
function grabFn(s, name) {
  const i = s.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  let depth = 0;
  const start = s.indexOf('{', i);
  for (let k = start; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') { depth--; if (!depth) return s.slice(i, k + 1); }
  }
  throw new Error(name + ' 括号没闭合');
}

/* ── 1. 输入夹取：任务 + 项目走同一套规则 ── */
const appApi = new Function([grabFn(appJs, 'normLimits'), 'return normLimits;'].join('\n'))();
console.log('[1] normLimits：任务与项目的输入边界');
eq('空输入全走默认值', appApi({}), { maxSteps: 24, maxTokens: 200000, projSteps: 6, projTokens: 600000 });
eq('undefined 也不炸', appApi(undefined), { maxSteps: 24, maxTokens: 200000, projSteps: 6, projTokens: 600000 });
eq('0 / 负数退回默认（0 步等于永远不干活）',
  appApi({ maxSteps: 0, maxTokens: -5, projSteps: 0, projTokens: '-1' }),
  { maxSteps: 24, maxTokens: 200000, projSteps: 6, projTokens: 600000 });
eq('字符串数字能认（输入框给的都是 string）',
  appApi({ maxSteps: '12', maxTokens: '150000', projSteps: '8', projTokens: '400000' }),
  { maxSteps: 12, maxTokens: 150000, projSteps: 8, projTokens: 400000 });
eq('超上界被夹住', appApi({ maxSteps: 999, maxTokens: 1e12, projSteps: 99, projTokens: 1e12 }),
  { maxSteps: 40, maxTokens: 20000000, projSteps: 30, projTokens: 200000000 });
eq('低于下界被抬起（项目至少 2 步 / 2 万 token）',
  appApi({ maxSteps: 1, maxTokens: 1000, projSteps: 1, projTokens: 999 }),
  { maxSteps: 1, maxTokens: 1000, projSteps: 2, projTokens: 20000 });
eq('小数取整，不会出现 6.7 步', appApi({ projSteps: 6.7, maxSteps: 9.4 }).projSteps, 7);

/* ── 2. 项目侧读取：设置改了必须真生效 ── */
const meetSrc = [
  'function budKey(m) { return "boss.bud." + (m.id || "x"); }',
  grabFn(meetJs, 'limOf'),
  grabFn(meetJs, 'nodeSteps'),
  grabFn(meetJs, 'nodeBudget'),
  grabFn(meetJs, 'budCap'),
  'return { limOf, nodeSteps, nodeBudget, budCap };'
].join('\n');

function meetApi(settings, ls) {
  const store = new Map(Object.entries(ls || {}));
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v))
  };
  const BUD = { node: 80000, total: 600000, raise: 300000 };
  const win = settings === null ? {} : { APP: { state: { settings } } };
  return new Function('window', 'BUD', 'localStorage', meetSrc)(win, BUD, localStorage);
}

console.log('[2] 项目额度：默认值 / 自定义 / 夹取');
const d = meetApi({});
eq('没设过 → 每节 6 步、整场 60 万', d.limOf(), { steps: 6, tokens: 600000 });
eq('读不到设置（未登录）也退回默认', meetApi(null).limOf(), { steps: 6, tokens: 600000 });
eq('设置成 10 步 / 90 万，读出来就是它',
  meetApi({ projSteps: 10, projTokens: 900000 }).limOf(), { steps: 10, tokens: 900000 });
eq('设置里被夹过一次的值也守得住（1 步 → 至少 2）',
  meetApi({ projSteps: 1 }).limOf().steps, 2);
eq('设置里 99 步 → 上限 30', meetApi({ projSteps: 99 }).limOf().steps, 30);
eq('token 低于 2 万 → 抬到 2 万', meetApi({ projTokens: 100 }).limOf().tokens, 20000);

console.log('[3] 每节步数：PPT 那一节要多给');
eq('普通节点 = 设置的步数', d.nodeSteps(''), 6);
eq('markdown 交付也是普通节点', d.nodeSteps('分析.md'), 6);
eq('PPT 节点 +5 步（搜图 + 修一轮）', d.nodeSteps('提案.pptx'), 11);
eq('改了设置，PPT 节点跟着变', meetApi({ projSteps: 8 }).nodeSteps('提案.pptx'), 13);
eq('大写扩展名也认', d.nodeSteps('提案.PPTX'), 11);

console.log('[4] 单节 token：不许超过整场上限');
eq('默认单节 8 万', d.nodeBudget(), 80000);
eq('整场设成 5 万 → 单节只能 5 万（一节就烧穿没有意义）', meetApi({ projTokens: 50000 }).nodeBudget(), 50000);
eq('整场设成 100 万 → 单节仍按 8 万截', meetApi({ projTokens: 1000000 }).nodeBudget(), 80000);

console.log('[5] 项目整场上限：单独调过的优先');
eq('没单独调过 → 跟设置走', meetApi({ projTokens: 300000 }).budCap({ id: 'p1' }), 300000);
eq('这个项目手动加过额度 → 用项目自己的',
  meetApi({ projTokens: 300000 }, { 'boss.bud.p1': '750000' }).budCap({ id: 'p1' }), 750000);
eq('另一个项目不受影响',
  meetApi({ projTokens: 300000 }, { 'boss.bud.p1': '750000' }).budCap({ id: 'p2' }), 300000);

/* ── 6. 结构：入口在头像菜单里，且排在「退出」上面 ── */
console.log('[6] 界面结构');
const popStart = html.indexOf('id="crPop"');
const popEnd = html.indexOf('</div>', html.indexOf('id="crExit"'));
const pop = html.slice(popStart, popEnd);
ok('头像菜单里有「设置」', /id="crSettings"[^>]*>\s*<span>设置<\/span>/.test(pop));
ok('设置排在记忆之后', pop.indexOf('id="crMemory"') < pop.indexOf('id="crSettings"'));
ok('设置排在退出之前', pop.indexOf('id="crSettings"') < pop.indexOf('id="crExit"'));
ok('设置弹框里有「任务」和「项目」两段', /任务：几步、多少 token/.test(html) && /项目：每节几步、整场多少 token/.test(html));
ok('单任务步数 / token 两个输入还在', /id="maxSteps"/.test(html) && /id="maxTokens"/.test(html));
ok('项目这两个输入在', /id="maxProjSteps"/.test(html) && /id="maxProjTokens"/.test(html));
ok('打开设置会回填项目两项', /maxProjSteps'\)\.value = state\.settings\.projSteps/.test(appJs)
  && /maxProjTokens'\)\.value = state\.settings\.projTokens/.test(appJs));
const saveBlock = appJs.slice(appJs.indexOf("$('#setSave').onclick")).slice(0, 600);
ok('保存时走 normLimits（两套数一套规则）', saveBlock.includes('normLimits('));
ok('菜单项绑了 openSettings', /\$\('#crSettings'\)\.onclick[\s\S]{0,160}openSettings\(\)/.test(appJs));

/* ── 7. 云端：两张表列要对上，否则「保存了但没存上」 ── */
console.log('[7] 云端往返');
ok('读设置认 max_proj_steps', /projSteps: Number\(row\.max_proj_steps\)/.test(cloudJs));
ok('读设置认 max_proj_tokens', /projTokens: Number\(row\.max_proj_tokens\)/.test(cloudJs));
ok('写设置带 max_proj_steps', /payload\.max_proj_steps = patch\.projSteps/.test(cloudJs));
ok('写设置带 max_proj_tokens', /payload\.max_proj_tokens = patch\.projTokens/.test(cloudJs));

/* ── 8. 项目侧不再有写死的步数/预算 ── */
console.log('[8] 项目侧没有写死的额度');
const meetNoComment = meetJs.replace(/\/\*[\s\S]*?\*\//g, '');
ok('没有 maxSteps: 6 这种写死', !/maxSteps:\s*6\b/.test(meetNoComment));
ok('没有 11 : 6 的三元写法', !/\?\s*11\s*:\s*6/.test(meetNoComment));
ok('没有 budget: BUD.node 写死', !/budget:\s*BUD\.node\b/.test(meetNoComment));
ok('两处 toolLoop 都走 nodeSteps', (meetNoComment.match(/maxSteps:\s*nodeSteps\(/g) || []).length >= 2);
ok('两处 toolLoop 都走 nodeBudget', (meetNoComment.match(/budget:\s*nodeBudget\(\)/g) || []).length >= 2);
ok('budCap 默认值跟设置走', /return limOf\(\)\.tokens;/.test(meetNoComment));
ok('进度卡的分母也用 nodeSteps', /total:\s*nodeSteps\(''\)/.test(meetNoComment));

/* ── 9. 账号额度：跟单任务上限不是一回事，但改它必须真的生效 ──
 * 线上报过「我改了额度，它说额度用完了」：他改的是单任务上限，拦他的是
 * 账号日额度，而账号额度当时**没有任何地方能改**。这一节就盯这条链路。 */
console.log('[9] 账号额度');
{
  const css = read('../public/app.css');
  ok('设置里有账号额度这一段', /账号额度：一天 \/ 一个月总共能用多少/.test(html));
  ok('有日 / 月两个输入', /id="quotaDay"/.test(html) && /id="quotaMonth"/.test(html));
  ok('有独立的保存按钮', /id="quotaSave"/.test(html));
  ok('正文写明它和单任务上限的区别', /管「这一次任务」[\s\S]{0,40}管「这个账号一天/.test(html));
  ok('打开设置就拉真实用量（不是缓存）', /refreshOutDirRow\(\);[\s\S]{0,200}refreshQuotaBox\(\)/.test(appJs));
  ok('保存走 /api/quota/limits', /\/api\/quota\/limits/.test(appJs));
  ok('只按底部「保存」也会把改过的额度一起提交',
    /quotaLoaded\.day && qd > 0[\s\S]{0,120}saveQuotaBox\(\)/.test(appJs));
  ok('读不到额度时不留白，给一句人话', /读不到额度：/.test(appJs));
  ok('被额度拦住时给一颗「去调额度」', /\/账号额度用完了\|token 额度用完了\//.test(appJs) && /data-quota-fix/.test(appJs));
  ok('单任务上限高过日额度会当场提示', /比日额度还高/.test(appJs));
  ok('提示颜色有别于普通说明', /\.lim-note\.warn\{/.test(css));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
