/* 刷新页面之后：话还在不在、秒表还走不走、会不会被判成「已中断」。
 *
 * 这三件事是老板同一次反馈里的三个症状，根因是三个不同的洞：
 *   ① 新任务的 user_msgs 是空的 —— 第一句原话要到跑完的 finally 才落库，
 *      「正在分析」时刷新，云端还什么都没写；渲染层又只认 userMsgs、不回退 goal。
 *   ② 秒表靠 data-start，refresh 后 traceStartedAt=0、没有工具节点也是 0，
 *      于是进度卡「已 27s」整块变空。
 *   ③ 进来就无条件把 running 改写成 interrupted，服务端明明还在跑——
 *      界面上先闪一下中断再自动接回来，看着就是「任务像中断了一下」。
 *
 * 这里把 app.js 真加载进 mock DOM，用可控的 localStorage 走真实函数，
 * 不看源码字符串（源码钉只作为最后一道兜底）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ── 可控的 localStorage：markRunning / ownRunMark 都读写它 ── */
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); }
};
const sessionStore = new Map();
const sessionStorage = {
  getItem: k => (sessionStore.has(k) ? sessionStore.get(k) : null),
  setItem: (k, v) => { sessionStore.set(k, String(v)); },
  removeItem: k => { sessionStore.delete(k); }
};

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
const win = {
  addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage, sessionStorage,
  location: { href: 'http://127.0.0.1/', search: '', origin: 'http://127.0.0.1' },
  requestAnimationFrame: f => f(), setTimeout: () => 0, clearTimeout() {},
  setInterval: () => 0, clearInterval() {},
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  console, URLSearchParams, Blob: class {}, FormData: class {},
  navigator: { clipboard: {} }, performance: { now: () => Date.now() },
  crypto: { getRandomValues: b => b }
};
win.window = win;

let M = null;
try {
  M = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
    'requestAnimationFrame', 'fetch', 'console',
    src + `\n;return { renderTrace, state, roundsList, doingTextOf, runStatusHTML,
      markRunning, runMark, ownRunMark, stillRunning, shouldMarkInterrupted, SRV, curTask };`
  )(win, document, localStorage, sessionStorage, win.location, win.navigator,
    win.requestAnimationFrame, win.fetch, console);
} catch (e) {
  console.error('app.js 加载失败：', e.message);
  console.error(String(e.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
ok('app.js 能加载', !!M && typeof M.renderTrace === 'function');

const { state, roundsList, doingTextOf, renderTrace, markRunning, runMark, stillRunning, shouldMarkInterrupted } = M;
const traceBox = document.querySelector('#trace');

/* ══ 1. 第一句原话：user_msgs 没落上库时也要显示出来 ══ */
console.log('① 刷新后「我发的文字」还在不在');
{
  const list = roundsList({ goal: '我想做一个最前沿的 agent 工具', userMsgs: null, steps: [] }, 1);
  ok('userMsgs 为空时用 goal 兜底成第一句问话',
    (list[0].askItems || []).length === 1 && list[0].askItems[0].text.includes('最前沿'),
    JSON.stringify(list[0] && list[0].askItems));

  const list2 = roundsList({
    goal: 'x', steps: [],
    userMsgs: [{ text: '我自己说的', round: 1 }]
  }, 1);
  ok('有 userMsgs 时不被 goal 覆盖', list2[0].asks[0] === '我自己说的');

  const list3 = roundsList({ goal: '', userMsgs: null, steps: [] }, 1);
  ok('没有 goal 也没有 userMsgs 时不造假气泡', (list3[0].askItems || []).length === 0);
}

/* 真渲染一遍：刷新回来的现场（有轨迹、状态 running、userMsgs 为空） */
{
  const task = {
    id: 'r1', title: '做 agent 工具', goal: '我想做一个最前沿的 agent 工具，你先给建议',
    employeeName: '小陈', employeeRole: '前端', status: 'running',
    files: [], messages: null, tokens: { in: 0, out: 0 }, ms: 0,
    userMsgs: null, updatedAt: Date.now(),
    steps: [{ kind: 'tool', round: 1, name: 'list_dir', ok: true, ms: 120, at: Date.now() - 12000 }]
  };
  state.tasks = [task];
  state.curTaskId = task.id;
  state.staff = [{ id: 'e1', name: '小陈', role: '前端' }];
  state.running = true;
  state.traceStartedAt = 0;                 // 刷新后的真实状态：没有开始时间
  state.trace = { nodes: [], result: '', status: 'running', round: 1, userMsg: '' };
  renderTrace(true);
  const html = String(traceBox.innerHTML || '');
  ok('真渲染：气泡里有我说的话', html.includes('我想做一个最前沿的 agent 工具'));
  ok('真渲染：没有 undefined', !/>undefined</.test(html));
}

/* ══ 2. 秒表：刷新之后接着走，不从 0 重数、也不消失 ══ */
console.log('② 刷新后「已跑了多久」');
{
  const task = state.tasks[0];
  const t0 = Date.now() - 27000;
  /* 本机心跳标记带上 since（这一轮真正开始的时间） */
  store.set('boss.running', JSON.stringify({ id: task.id, at: Date.now(), since: t0, tid: 'tA' }));

  const mark = runMark();
  ok('标记里有 since（开始时间）', Number(mark && mark.since) > 0);

  renderTrace(true);
  const html = String(traceBox.innerHTML || '');
  const m = html.match(/data-start="(\d+)"/);
  ok('进度卡带上了 data-start', !!m, m ? m[1] : '没匹配到');
  const startMs = m ? Number(m[1]) : 0;
  ok('data-start 是原来的开始时间（不是 0、也不是现在）',
    Math.abs(startMs - t0) < 1500, 'start=' + startMs + ' want≈' + t0);
  ok('秒表文案不是空的', /已 \d+s|已 \d+m/.test(html), html.slice(0, 0) || '没找到');
  ok('没有把时间显示成 0s（刷新后从 0 重数）', !/>已 0s</.test(html));

  /* 服务端 hello 带回来的开始时间也能用 */
  M.SRV.startedAt = t0;
  state.traceStartedAt = 0;
  store.delete('boss.running');
  renderTrace(true);
  const html2 = String(traceBox.innerHTML || '');
  const m2 = html2.match(/data-start="(\d+)"/);
  ok('本机标记丢了也能用服务端的开始时间',
    m2 && Math.abs(Number(m2[1]) - t0) < 1500, m2 ? m2[1] : '没匹配到');
}

/* markRunning：续跑保留 since，新一轮重置 */
{
  store.clear();
  sessionStore.set('boss.tab', 'tA');
  const t = { id: 'r2', title: 'x', goal: 'g' };
  const realNow = Date.now;
  let fake = 1_700_000_000_000;
  Date.now = () => fake;
  markRunning(t, { keepSince: false });
  const first = runMark().since;
  ok('第一次打标：since = 现在', first === fake);
  fake += 20000;
  markRunning(t, { keepSince: true });
  ok('续跑打标：since 不动（不然耗时被打回 0）', runMark().since === first, String(runMark().since));
  ok('心跳 at 往前走', runMark().at === fake);
  fake += 20000;
  markRunning(t, { keepSince: false });
  ok('新一轮打标：since 重置', runMark().since === fake);
  Date.now = realNow;
}

/* ══ 3. 刷新不该把还在跑的任务判成「已中断」 ══ */
console.log('③ 刷新后会不会被判成中断');
{
  const now = Date.now();
  const fresh = { id: 'a', status: 'running', updatedAt: now - 5000 };
  const stale = { id: 'b', status: 'running', updatedAt: now - 120000 };

  ok('心跳新鲜 → 认为还在跑', stillRunning(fresh) === true);
  ok('心跳过期 → 认为不在了', stillRunning(stale) === false);

  ok('心跳新鲜时不改写状态', shouldMarkInterrupted(fresh, 'a', '') === false);
  ok('心跳过期且是本机那个 → 标中断', shouldMarkInterrupted(stale, 'b', 'b') === true);
  ok('心跳过期但不是 running 的 → 不动', shouldMarkInterrupted({ ...stale, status: 'done' }, 'x', '') === false);
  ok('没有任务 → 不标', shouldMarkInterrupted(null, 'a', 'a') === false);
}

/* ══ 4. 空窗期的文案：不能一句「正在拆解」挂到底 ══ */
console.log('④ 还没吐字时的说法');
{
  const tr = { nodes: [], think: '', stream: '', round: 1 };
  const t = { id: 'z', status: 'running' };

  state.traceStartedAt = Date.now() - 1000;
  ok('刚发出去：说在拆解', (doingTextOf(tr, t, 1) || '').includes('拆解'));
  state.traceStartedAt = Date.now() - 12000;
  ok('12 秒：说在等第一个字', (doingTextOf(tr, t, 1) || '').includes('等它吐第一个字'));
  state.traceStartedAt = Date.now() - 40000;
  const s40 = doingTextOf(tr, t, 1) || '';
  ok('40 秒：说明推理模型开头慢，带秒数', s40.includes('40s') && s40.includes('推理'));
  state.traceStartedAt = Date.now() - 200000;
  ok('200 秒：直接建议停掉重发', (doingTextOf(tr, t, 1) || '').includes('停掉重发'));

  /* 有动静之后就让位给真实动作，不能还停在「在等第一个字」 */
  state.traceStartedAt = Date.now() - 40000;
  const tr2 = { nodes: [], think: '先看目录结构，再决定分层', stream: '', round: 1 };
  ok('开始推理后：说正在推理', (doingTextOf(tr2, t, 1) || '').includes('正在推理'));
}

/* ══ 5. 进度卡：0 token 不该写成「0 token」 ══ */
{
  const task = state.tasks[0];
  task.tokens = { in: 0, out: 0 };
  state.running = true;
  state.traceStartedAt = Date.now() - 5000;
  state.trace = { nodes: [], result: '', status: 'running', round: 1 };
  renderTrace(true);
  const html = String(traceBox.innerHTML || '');
  ok('还没计 token 时写「等待首个 token」', html.includes('等待首个 token'));
  ok('不出现「0 token」', !/>0 token</.test(html));
}

/* ══ 6. 服务端：hello 帧要带 startedAt，前端才接得上时间轴 ══ */
console.log('⑤ 服务端契约');
ok('hello 带 startedAt', /startedAt:\s*run\.startedAt/.test(serverSrc));

/* ══ 7. 源码兜底：新任务的第一句当场进存档 ══ */
ok('新任务 draft 里就带上 userMsgs',
  /userMsgs:\s*\[\{\s*text,\s*at:\s*0,\s*round:\s*1,\s*imgs:/.test(src));
/* 附件的 base64 绝不能进存档：几张截图就是几 MB，createTask / saveTask 会被
   前置网关拦（403），界面上表现为「任务存不上」。图留在工作区，只存路径。 */
ok('新任务存档里的附件不留 base64',
  /files:\s*slimFiles\(atts\)/.test(src) && /dataUrl:\s*null,\s*thumb:\s*null/.test(src));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
