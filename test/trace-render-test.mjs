/* 对话渲染：把 app.js 真的加载进一个极简 DOM，调 renderTrace 看它吐出来的 HTML。
 *
 * 为什么要这么做：轮次那套逻辑（syncRounds / turnHTML / renderTrace）以前只有
 * 「数据层」的断言，渲染层改了没人拦——而老板看到的问题恰恰在渲染层：
 * 空轮占一整块、自己的话被顶到上面、补充的话和正式问话长得一样。
 * 这里不连网、不跑任务，只把「三句话 + 一次插话」铺出来看结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ── 极简 DOM：只够渲染路径用 ── */
function el(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    setAttribute() {}, getAttribute() { return ''; }, click() {}, focus() {},
    scrollIntoView() {}, closest: () => null, insertBefore() {}, contains: () => false
  };
}
const cache = new Map();
const document = {
  querySelector: s => { if (!cache.has(s)) cache.set(s, el(s)); return cache.get(s); },
  querySelectorAll: () => [],
  getElementById: id => { const k = '#' + id; if (!cache.has(k)) cache.set(k, el(id)); return cache.get(k); },
  createElement: () => el(''), addEventListener() {},
  body: el('body'), documentElement: el('html'), head: el('head'),
  createTextNode: () => ({})
};
const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const win = {
  addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage, location: { href: 'http://127.0.0.1/', search: '', origin: 'http://127.0.0.1' },
  requestAnimationFrame: f => f(), setTimeout: () => 0, clearTimeout() {},
  setInterval: () => 0, clearInterval() {},
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  console, URLSearchParams, Blob: class {}, FormData: class {},
  navigator: { clipboard: {} }, performance: { now: () => Date.now() },
  crypto: { getRandomValues: b => b }
};
win.window = win;

let mod = null;
try {
  mod = new Function(
    'window', 'document', 'localStorage', 'location', 'navigator',
    'requestAnimationFrame', 'fetch', 'console',
    src + '\n;return { renderTrace, state, msgMeHTML, turnHTML, syncRounds, curTask };'
  )(win, document, localStorage, win.location, win.navigator,
    win.requestAnimationFrame, win.fetch, console);
} catch (e) {
  console.error('app.js 加载失败：', e.message);
  console.error(String(e.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
ok('app.js 能加载', !!mod && typeof mod.renderTrace === 'function');

const { renderTrace, state } = mod;
const traceBox = cache.get('#trace') || document.querySelector('#trace');

/* ── 造一个 3 轮任务：第 2 轮里插了一句「补充」 ── */
function makeTask() {
  return {
    id: 't1', title: '照图做页面', goal: '照这张截图做一个前端页面',
    employeeName: '小陈', employeeRole: '前端', status: 'running',
    files: [], messages: [], tokens: { in: 100, out: 200 }, ms: 12000,
    deliverableCheck: null, pendingAsk: null, createdAt: Date.now(), updatedAt: Date.now(),
    userMsgs: [
      { text: '照这张截图做一个前端页面', at: 0, round: 1 },
      { text: '再加一个底部固定按钮', at: 1, round: 2 },
      { text: '配色换成深色', at: 2, round: 2, inline: true },
      { text: '把导航改成两栏', at: 3, round: 3 }
    ],
    steps: [
      { kind: 'tool', round: 1, name: 'view_image', ok: true, ms: 900, output: '一个登录页' },
      { kind: 'say', round: 1, at: 1, text: '第一轮：我看清了，是个登录页' },
      { kind: 'tool', round: 2, name: 'write_file', ok: true, ms: 400, output: '已写入 index.html' },
      { kind: 'say', round: 2, at: 2, text: '第二轮：按钮加好了' },
      { kind: 'tool', round: 3, name: 'write_file', ok: true, ms: 300, output: '已写入 index.html' },
      { kind: 'say', round: 3, at: 3, text: '第三轮：两栏导航改完了' }
    ]
  };
}

const task = makeTask();
state.tasks = [task];
state.curTaskId = task.id;
state.drafting = false;
state.staff = [{ id: 'e1', name: '小陈', role: '前端' }];
state.curEmpId = 'e1';
state.pickEmp = ['e1'];
state.running = true;
state.traceStartedAt = Date.now() - 5000;
state.settings = { ...(state.settings || {}), maxSteps: 24, maxTokens: 200000 };
state.trace = {
  nodes: [], result: '', status: 'running', blocked: null,
  round: 3, userMsg: '把导航改成两栏',
  thinks: '', think: '先看是不是单栏……改成两栏要动 grid 和侧栏宽度。',
  says: [{ text: '第三轮：正在改布局', at: Date.now() }]
};

let html = '';
try {
  renderTrace(true);
  html = String(traceBox.innerHTML || '');
  ok('renderTrace 不抛错', true);
} catch (e) {
  ok('renderTrace 不抛错', false, e.message);
}

console.log('渲染结果');
{
  ok('有内容', html.length > 200, String(html.length));
  const me = (html.match(/class="msg me/g) || []).length;
  ok('四条「我」的气泡（3 句问话 + 1 句补充）', me === 4, '拿到 ' + me);
  ok('补充那句有「补充」标记',
    (html.match(/class="me-tag"/g) || []).length === 1,
    '拿到 ' + (html.match(/class="me-tag"/g) || []).length);
  ok('补充那句的样式带 sup', /class="msg me sup"/.test(html));
  ok('没有空轮（不含 data-turn 的空壳）', !/data-turn="4"/.test(html));
  ok('三轮的问话都在',
    ['照这张截图', '再加一个底部', '把导航改成两栏'].every(x => html.includes(x)));
  ok('三句结论都在',
    ['第一轮：我看清了', '第二轮：按钮加好了', '第三轮：正在改布局'].every(x => html.includes(x)));
  ok('推理过程有折叠块', /class="think"/.test(html));
  ok('推理内容可见', html.includes('两栏要动 grid'));
  ok('没有 undefined 字面量', !/>undefined</.test(html));
  ok('没有 NaN 字面量', !/>NaN</.test(html));
}

/* ── 收工态：不该再挂「正在推理」 ── */
console.log('收工态');
{
  task.status = 'done';
  state.running = false;
  state.trace = {
    nodes: [], result: '第三轮：两栏导航改完了', status: 'done', blocked: null,
    round: 3, userMsg: '把导航改成两栏',
    says: [{ text: '第三轮：两栏导航改完了', at: Date.now() }]
  };
  renderTrace(true);
  const doneHtml = String(traceBox.innerHTML || '');
  ok('收工后不再显示推理块', !/class="think"/.test(doneHtml));
  ok('结论还在', doneHtml.includes('两栏导航改完了'));
  const me = (doneHtml.match(/class="msg me/g) || []).length;
  ok('收工后四条问话一条不少', me === 4, '拿到 ' + me);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
