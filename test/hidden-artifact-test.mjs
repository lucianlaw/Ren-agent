/* 「老板不该看到的东西」+「继续跑为什么会假死」的回归测试。
 *
 * 两件事各有一次真实事故：
 *   1) 2026-11-02：任务累计 530,665 token、上限 200,000，点「继续跑」后
 *      agent 循环第一行就撞预算检查直接 break，界面上只弹了句提示，
 *      看起来像按钮坏了。→ ensureBudget 必须在续跑前把额度补够。
 *   2) 同一轮里产出清单多了「股票详情页_验收.md / .json」和一张验收卡，
 *      这些是内部质检，老板不需要看。→ isInternalArtifact 必须过滤掉。
 *
 * 跑法：node test/hidden-artifact-test.mjs
 * 只测纯函数与结构，不连网、不起服务。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const src = read('../public/app.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/* ── 从 app.js 里抠出真正的函数体来测（不复制实现，避免测了个假的） ── */
function grabFn(s, name) {
  const i = s.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('app.js 里找不到 ' + name);
  let depth = 0;
  const start = s.indexOf('{', i);
  for (let k = start; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') { depth--; if (!depth) return s.slice(i, k + 1); }
  }
  throw new Error(name + ' 括号没闭合');
}
const reLine = src.match(/const INTERNAL_FILE_RE = .*;/);
if (!reLine) throw new Error('找不到 INTERNAL_FILE_RE');

const store = new Map();
const fakeLS = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};
const fakeState = { settings: { maxTokens: 200000 } };

const api = new Function('localStorage', 'state', [
  reLine[0],
  grabFn(src, 'isInternalArtifact'),
  'function budExtra(taskId) { return Number(localStorage.getItem("boss.tbud." + taskId)) || 0; }',
  'function budRaise(taskId, n) { const v = budExtra(taskId) + n; localStorage.setItem("boss.tbud." + taskId, String(v)); return v; }',
  grabFn(src, 'budgetOf'),
  grabFn(src, 'spentOf'),
  grabFn(src, 'ensureBudget'),
  grabFn(src, 'fmtTokenW'),
  'return { isInternalArtifact, budgetOf, spentOf, ensureBudget, fmtTokenW };'
].join('\n'))(fakeLS, fakeState);

/* ── 1. 验收 / 自检类中间产物 ── */
console.log('\n[1] 验收类文件不进老板的产出清单');
ok('股票详情页_验收.md 被过滤', api.isInternalArtifact('股票详情页_验收.md'));
ok('股票详情页_验收.json 被过滤', api.isInternalArtifact('股票详情页_验收.json'));
ok('子目录里的也过滤', api.isInternalArtifact('设计/03-验收报告.md'));
ok('自检清单过滤', api.isInternalArtifact('自检清单.txt'));
ok('verify-result.json 过滤', api.isInternalArtifact('verify-result.json'));
ok('正常 html 保留', !api.isInternalArtifact('股票详情页.html'));
ok('正常 md 保留', !api.isInternalArtifact('报价结论.md'));
ok('图片保留', !api.isInternalArtifact('assets/chart.png'));
ok('老板点名要的 docx 验收单保留（只过滤文本类）', !api.isInternalArtifact('验收单.docx'));
ok('空串不算', !api.isInternalArtifact(''));
ok('./ 前缀也能认', api.isInternalArtifact('./股票详情页_验收.md'));

/* ── 2. 续跑前补额度 ── */
console.log('\n[2] 续跑前把额度补够（点继续跑不再假死）');
const t1 = { id: 'tk1', tokens: { in: 400000, out: 130665 } };
eq('账面累计算得对', api.spentOf(t1), 530665);
eq('额度默认 20 万', api.budgetOf('tk1', { maxTokens: 200000 }), 200000);
const add1 = api.ensureBudget(t1, { maxTokens: 200000 });
ok('烧穿上限时会补额度', add1 > 0, '补了 ' + add1);
ok('补完以后上限真的高于已花', api.budgetOf('tk1', { maxTokens: 200000 }) > api.spentOf(t1),
  `budget ${api.budgetOf('tk1', { maxTokens: 200000 })} spent ${api.spentOf(t1)}`);
ok('补的量够再跑一轮', add1 >= 100000, '补了 ' + add1);

const t2 = { id: 'tk2', tokens: { in: 1000, out: 500 } };
eq('没烧穿就不补', api.ensureBudget(t2, { maxTokens: 200000 }), 0);
eq('没烧穿时上限不变', api.budgetOf('tk2', { maxTokens: 200000 }), 200000);
ok('没有 tokens 字段也不炸', api.ensureBudget({ id: 'tk3' }, { maxTokens: 1 }) === 0);
ok('没有 id 不动额度', api.ensureBudget({ tokens: { in: 9e9, out: 0 } }, { maxTokens: 1 }) === 0);

/* 补完之后再点一次不该继续加（否则每点一次涨一截，账算不清） */
const add2 = api.ensureBudget(t1, { maxTokens: 200000 });
eq('补完再点不会重复加', add2, 0);

eq('万位口径 200000', api.fmtTokenW(200000), '20 万');
eq('万位口径 530665', api.fmtTokenW(530665), '53.1 万');
eq('小数字原样', api.fmtTokenW(8600), '8600');

/* ── 3. 结构断言：这些地方改回去就是事故复现 ── */
console.log('\n[3] 界面结构');
ok('任务对话里不再渲染验收卡', !/html \+= verifyCardHTML/.test(src));
ok('验收卡函数保留给管理员视角', /function verifyCardHTML/.test(src));
ok('验收节点不进步骤列表', /'验收'/.test(src.slice(src.indexOf('const HIDE_STEPS'), src.indexOf('const HIDE_STEPS') + 120)));
ok('产出清单里过滤内部产物', /if \(isInternalArtifact\(p\)\) return;/.test(src));
ok('轮次文件里过滤内部产物', /if \(isInternalArtifact\(s\)\) return;/.test(src));
ok('续跑按钮失败会还原', /if \(!started\) \{ el\.disabled = false; el\.textContent = was; \}/.test(src));
ok('预算超限的按钮说法不同', /data-need-bud/.test(src));
ok('收工时投告警', /queueTaskAlert\(t, ev\.task\)/.test(src));
ok('报错也投告警', /queueAlert\(t, 'error'/.test(src));
ok('状态文案不再出现「验收有缺口」', !/验收有缺口/.test(src.split('const ST = {')[1].split('};')[0]));

/* ── 4. 服务端告警队列 ── */
console.log('\n[4] 服务端告警队列');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-alerts-'));
process.env.ALERTS_DIR = tmp;
process.env.ADMIN_EMAIL = 'livincuzlove@agent.qq.com';
const A = await import('../lib/alerts.js');

const base = {
  kind: 'verify', scope: 'a'.repeat(32), taskId: 'tk1', taskTitle: '设计一个股票查看的静态页面',
  goal: '设计一个股票查看的静态页面', employee: '小吴', round: 1, status: 'weak',
  tokens: { in: 400000, out: 130665 }, verdict: 'weak', score: 2.4,
  gaps: ['验收人两次都没给出可解析的结论']
};
const a1 = A.addAlert(base);
ok('合法告警能入队', !!a1 && !!a1.id);
eq('收件人固定为管理员邮箱', A.ADMIN_EMAIL, 'livincuzlove@agent.qq.com');
eq('重复投递被去重', A.addAlert(base).id, a1.id);
eq('队列里只有一条', A.listAlerts({ days: 1 }).length, 1);

ok('未知类型拒收', A.addAlert({ kind: 'whatever', taskTitle: 'x' }) === null);
ok('没有任务标题的拒收', A.addAlert({ kind: 'verify' }) === null);
ok('超长报错被截断', (() => {
  const r = A.addAlert({ kind: 'error', taskTitle: 'T', error: 'x'.repeat(5000) });
  return r && r.error.length <= 1201;
})());

const a3 = A.addAlert({ kind: 'budget', taskTitle: 'T2', taskId: 'tk2', round: 1, status: 'budget_exceeded', budget: 200000, spent: 530665 });
ok('预算类能入队', !!a3);
eq('未发信的有 3 条', A.listAlerts({ days: 1 }).length, 3);
eq('标记已发 2 条', A.ackAlerts([a1.id, a3.id]), 2);
eq('发完只剩 1 条待发', A.listAlerts({ days: 1 }).length, 1);
eq('all=1 仍能看到全部', A.listAlerts({ days: 1, onlyNew: false }).length, 3);
eq('ack 空数组不炸', A.ackAlerts([]), 0);
eq('ack 非数组不炸', A.ackAlerts(null), 0);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
