/* 评测台渲染冒烟：不连网、不跑任务，只把整页渲染路径走一遍。
   目的：模板里引用了不存在的字段、算了 undefined、或者拼 HTML 出错，在这里就会炸，
   而不是等到真跑完一轮（几万 token）之后才发现页面白屏。
   跑法：node test/render-smoke.mjs */
import fs from 'fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const kitMod = { exports: {} };
new Function('module', 'exports', read('../public/evalkit.js'))(kitMod, kitMod.exports);
const K = kitMod.exports;

/* ── 极简 DOM：只要够渲染路径用 ── */
function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', hidden: false, disabled: false, value: '',
    options: [], dataset: {}, children: [],
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    appendChild() {}, remove() {}, click() {}, setAttribute() {},
    getAttribute() { return ''; }
  };
  return el;
}
const els = new Map();
const document = {
  getElementById(id) {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement() { return makeEl('tmp'); },
  body: { appendChild() {} },
  documentElement: { classList: { add() {}, remove() {} } }
};
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

/* ── 两条假运行记录：一条基线、一条当前，让对比/配对表/日志都能渲染出来 ── */
const mkItem = (id, title, pass, q, ms, tok, ttft) => ({
  caseId: id, title, difficulty: 'L2', tags: [], attempts: 1,
  pass, passAtK: pass,
  ms, tokens: { in: tok, out: Math.round(tok * 0.3), reasoning: Math.round(tok * 0.1), cached: 0 },
  ttftP50: ttft, toolCalls: 3, calls: 4, rounds: 1,
  quality: q, dims: { fact: 3, complete: 3, usable: 3 }, veto: false,
  results: pass ? [{ type: 'file', pass: true, msg: '产出 a.md' }] : [{ type: 'chars', pass: false, msg: '正文只有 20 字' }],
  error: ''
});
const run1 = {
  kind: 'run', id: 'r_old', at: Date.now() - 3600e3, groupId: 'g1',
  variant: { which: 'b', label: 'B', model: 'model-a', modelName: '模型 A', judgeModel: 'judge-x' },
  fp: { appVersion: 'v20261101', caseVersion: 3, k: 1, caseIds: ['c1', 'c2'], caseCount: 2 },
  items: [
    mkItem('c1', '写一句话日记存 md', true, 3.5, 8000, 5000, 900),
    mkItem('c2', '做 3 页 PPT', false, 2.2, 15000, 9000, 1400)
  ]
};
const run2 = {
  kind: 'run', id: 'r_new', at: Date.now(), groupId: 'g2',
  variant: { which: 'b', label: 'B', model: 'model-a', modelName: '模型 A', judgeModel: 'judge-x' },
  fp: { appVersion: 'v20261102', caseVersion: 3, k: 1, caseIds: ['c1', 'c2'], caseCount: 2 },
  items: [
    mkItem('c1', '写一句话日记存 md', true, 3.8, 6000, 3800, 700),
    mkItem('c2', '做 3 页 PPT', true, 3.1, 12000, 7000, 1100)
  ]
};
const log1 = {
  kind: 'log', id: 'l_1', at: Date.now(), groupId: 'g2',
  from: { appVersion: 'v20261101', model: 'model-a', modelName: '模型 A', k: 1, n: 2 },
  to: { appVersion: 'v20261102', model: 'model-a', modelName: '模型 A', k: 1, n: 2 },
  verdict: { code: 'accept', text: '可以切' },
  text: '# 评测差异日志\n\n测试正文',
  summary: {
    n: 2, aRate: 0.5, bRate: 1, passDelta: 0.5, pValue: 0.5, significant: false,
    qualityA: 2.85, qualityB: 3.45, qualityDelta: 0.6,
    costA: 2.8, costB: 1.9, p95A: 15000, p95B: 12000,
    ttftA: 1400, ttftB: 1100, tokDelta: -3200, aWin: 0, bWin: 1,
    changed: [{ caseId: 'c2', title: '做 3 页 PPT', aPass: false, bPass: true, dq: 0.9 }]
  }
};
store.set('boss.eval.runs', JSON.stringify([run2, run1]));
store.set('boss.eval.logs', JSON.stringify([log1]));

const CASES = {
  version: 3,
  rubricDefaults: { dims: [{ key: 'fact', name: '事实', weight: 'essential' }], veto: '编造' },
  cases: [
    { id: 'c1', title: '写一句话日记存 md', smoke: true, difficulty: 'L1', goal: '写日记', assertions: [{ type: 'noFail' }] },
    { id: 'c2', title: '做 3 页 PPT', smoke: true, difficulty: 'L2', goal: '做 PPT', assertions: [{ type: 'noFail' }] }
  ]
};

const win = {
  APP: {
    state: {
      isAdmin: true, scope: 'u1',
      models: [{ id: 'model-a', name: '模型 A' }, { id: 'model-b', name: '模型 B' }],
      staff: [{ id: 's1', name: '小助手', model: 'model-a' }],
      settings: { model: 'model-a' },
      tasks: []
    },
    esc: (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    toast: () => {},
    showView: () => {}
  },
  EVALKIT: K,
  withSC: (p) => p,
  CLOUD: { user: () => null },
  BOSS: {},
  JUDGE: { pick: (list, m) => ({ id: 'judge-x', name: '评委', level: 'full' }) }
};
const fetchStub = async () => ({ json: async () => CASES });

const code = read('../public/review.js');
new Function('window', 'document', 'localStorage', 'fetch', code)(win, document, localStorage, fetchStub);
const R = win.REVIEW;

let bad = 0;
const ok = (name, cond, extra) => {
  if (!cond) bad++;
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

await R.open();

const cmp = document.getElementById('evCompare').innerHTML;
const pairs = document.getElementById('evPairs').innerHTML;
const list = document.getElementById('evList').innerHTML;
const logs = document.getElementById('evLogs').innerHTML;
const vars = document.getElementById('evVarA').innerHTML;
const base = document.getElementById('evBase').innerHTML;

ok('指标卡渲染出通过率', /通过率 Pass\^k/.test(cmp));
ok('指标卡出现跨版本标记', /跨版本对比/.test(cmp), 'v20261101 → v20261102');
ok('结论区有内容', /ev-concl-i/.test(cmp));
ok('配对表渲染', /逐题配对/.test(pairs) && /做 3 页 PPT/.test(pairs));
ok('配对表标出翻盘题', /ev-chg/.test(pairs));
ok('用例列表渲染出 2 道题', (list.match(/ev-row /g) || []).length >= 2);
ok('用例显示质量分', /质量/.test(list));
ok('差异日志渲染出 1 条', /版本差异日志/.test(logs) && /可以切/.test(logs));
ok('A/B 下拉填上了模型', /模型 A/.test(vars) && /模型 B/.test(vars));
ok('基线下拉列出历史运行', /自动选基线/.test(base) && /v20261102/.test(base));
ok('未出现 undefined / NaN', !/undefined|NaN/.test(cmp + pairs + list + logs), '');

/* 差异日志正文：这是「版本前后对比」留档的产物，字段必须齐、不能有空洞 */
const log = R._buildLog(run1, run2);
const txt = log.text || '';
ok('日志有标题与结论', /# 评测差异日志/.test(txt) && /## 结论/.test(txt));
ok('日志有指标表', /## 指标/.test(txt) && /通过率/.test(txt) && /每成功一次成本/.test(txt));
ok('日志有逐题变化', /## 逐题变化/.test(txt) && /做 3 页 PPT/.test(txt));
ok('日志有口径说明', /## 口径说明/.test(txt) && /McNemar/.test(txt));
ok('日志标注了版本号', /v20261101/.test(txt) && /v20261102/.test(txt));
ok('日志没有未填值', !/undefined|NaN/.test(txt));
ok('日志结构可直接落库', log.kind === 'log' && !!log.id && !!log.summary && log.summary.bWin === 1);
if (process.env.SHOW_LOG) console.log('\n--- 日志正文 ---\n' + txt + '\n--- 结束 ---\n');

/* 空态：没有历史时不应报错 */
store.delete('boss.eval.runs');
store.delete('boss.eval.logs');
const els2 = new Map();
const doc2 = Object.assign({}, document, {
  getElementById(id) {
    if (!els2.has(id)) els2.set(id, makeEl(id));
    return els2.get(id);
  }
});
/* 重新加载一份干净的模块实例 */
const win2 = JSON.parse(JSON.stringify({ x: 1 }));
const fresh = {
  APP: win.APP, EVALKIT: K, withSC: (p) => p, CLOUD: { user: () => null }, BOSS: {}, JUDGE: win.JUDGE
};
new Function('window', 'document', 'localStorage', 'fetch', code)(fresh, doc2, localStorage, fetchStub);
await fresh.REVIEW.open();
const emptyCmp = doc2.getElementById('evCompare').innerHTML;
ok('空态给出引导文案', /还没有可对比的运行/.test(emptyCmp));
ok('空态不出现 undefined', !/undefined|NaN/.test(emptyCmp));

console.log(bad ? `\nFAILED: ${bad} 项` : '\nALL_RENDER_OK');
process.exit(bad ? 1 : 0);
