/* 右栏产出：文件明明在工作区里，面板却显示「暂无产出」——这条必须拦住。
 *
 * 现场：老板让 agent 做原型，上一轮写了 agent_server.py 和 index.html；
 * 换个任务回来看，右栏只剩 1 个 contract.md，他说「两个产物怎么没有了」。
 * 文件其实一直在工作区根目录（第 5 轮 list_dir 还列出来了），
 * 只是产出清单只认「任务轨迹里记过的写文件动作」，记录不在那个任务里就永远不显示。
 *
 * 这组测试真加载 app.js，mock 掉 /api/files，验证三件事：
 *   ① 任务产出为空时也会去问工作区（以前空清单直接 return，兜底永远轮不到）
 *   ② 磁盘上有、记录里没有的文件会补进列表，并标「工作区」
 *   ③ 记录里已有的不重复；太老的不补（工作区一放就是几十个历史文件）
 *   ④ write_file 给空路径要给一句人话，而不是 EISDIR
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ── 极简 DOM ── */
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

const NOW = Date.now();
const DAY = 24 * 3600e3;
/* 工作区首页：一个刚写的、一个八天前的、一个和任务记录重名的 */
const WS_ITEMS = [
  { name: 'agent_server.py', dir: false, path: 'agent_server.py', size: 8023, mtime: NOW - 3600e3 },
  { name: 'index.html', dir: false, path: 'index.html', size: 11998, mtime: NOW - 7200e3 },
  { name: 'old-report.md', dir: false, path: 'old-report.md', size: 100, mtime: NOW - 8 * DAY },
  { name: 'agent-workbench', dir: true, path: 'agent-workbench', size: 0, mtime: NOW },
  { name: 'README.md', dir: false, path: 'README.md', size: 337, mtime: NOW - 30 * DAY }
];
let filesCalls = 0;

const win = {
  addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage, location: { href: 'http://127.0.0.1/', search: '', origin: 'http://127.0.0.1' },
  requestAnimationFrame: f => f(), setTimeout: () => 0, clearTimeout() {},
  setInterval: () => 0, clearInterval() {},
  withSC: p => p,
  fetch: async (url) => {
    if (String(url).includes('/api/files')) {
      filesCalls += 1;
      return { ok: true, json: async () => ({ ok: true, items: WS_ITEMS }) };
    }
    return { ok: false, json: async () => ({}) };
  },
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
    src + '\n;return { renderOutputRail, state, collectOutputs, WS_FILES, loadWorkspaceFiles };'
  )(win, document, localStorage, win.location, win.navigator,
    win.requestAnimationFrame, win.fetch, console);
} catch (e) {
  console.error('app.js 加载失败：', e.message);
  console.error(String(e.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
ok('app.js 能加载', !!mod && typeof mod.renderOutputRail === 'function');

const { renderOutputRail, state } = mod;
const outBox = document.querySelector('#outList');

/* ── 造一个「轨迹里只有 contract.md」的任务，模拟现场 ── */
function mkTask() {
  return {
    id: 't1', title: '做一个 agent 工具', goal: '做一个最前沿的 agent 工具',
    employeeName: '小陈', status: 'done', files: [], messages: [], tokens: { in: 0, out: 0 }, ms: 0,
    createdAt: NOW - 600e3, updatedAt: NOW - 60e3,
    userMsgs: [{ text: '做一个最前沿的 agent 工具', at: 0, round: 1 }],
    steps: [
      { kind: 'tool', round: 1, name: 'write_file', ok: true, at: 1, args: { path: 'agent-workbench/contract.md' }, output: '已写入 agent-workbench/contract.md（6545B）' }
    ]
  };
}
const task = mkTask();
state.tasks = [task];
state.curTaskId = task.id;
state.view = 'chat';
state.lastListView = 'task';
state.staff = [{ id: 'e1', name: '小陈' }];
state.curEmpId = 'e1';
state.railEmpId = 'e1';
state.scope = 'a'.repeat(32);
state.guest = false;
state.outQuery = '';

/* ── ① 第一次渲染：清单里只有 contract.md，但必须去问一次工作区 ── */
renderOutputRail();
ok('渲染后立刻发起过一次工作区查询', filesCalls === 1, `calls=${filesCalls}`);
ok('先显示轨迹里的产出（不等磁盘）', /contract\.md/.test(outBox.innerHTML));

/* 等异步回来再渲染一次 */
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

/* ── ② 磁盘上的补进来了，并标「工作区」 ── */
ok('补出了 agent_server.py', /agent_server\.py/.test(outBox.innerHTML), outBox.innerHTML.slice(0, 200));
ok('补出了根目录 index.html', /index\.html/.test(outBox.innerHTML));
ok('补出来的标成「工作区」', /工作区/.test(outBox.innerHTML));
ok('目录不会被当成产出', !/agent-workbench<\/span>/.test(outBox.innerHTML));

/* ── ③ 去重与时效 ── */
/* 注意：文件名在卡片里会出现两次（data-out-path 属性 + 可见名字），
   所以数「卡片数」而不是数文字出现次数。 */
const contractCards = (outBox.innerHTML.match(/data-out-path="[^"]*contract\.md"/g) || []).length;
ok('轨迹里已有的 contract.md 只占一张卡，没被重复列一遍', contractCards === 1, `卡片数 ${contractCards}`);
ok('八天前的旧文件不补', !/old-report\.md/.test(outBox.innerHTML));
ok('三十天前的种子文件不补', !/README\.md/.test(outBox.innerHTML));

/* ── ④ 缓存生效：紧接着再渲染不该再打一次接口 ── */
const before = filesCalls;
renderOutputRail();
await Promise.resolve();
ok('20 秒内不重复请求 /api/files', filesCalls === before, `calls=${filesCalls} before=${before}`);

/* ── ⑤ 员工产出不掺工作区文件 ── */
state.lastListView = 'staff';
renderOutputRail();
ok('员工产出不掺整盘文件', !/agent_server\.py/.test(outBox.innerHTML));

/* ── ⑥ write_file 空路径：说人话，别给 EISDIR ── */
const { runTool } = await import('../lib/tools.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-writetest-'));
const ctx = { workspace: tmp, fullAccess: true, runId: 'r1', leaseOwner: 'test', onTodos: () => {}, scope: '' };
const r1 = await runTool('write_file', { path: '', content: 'x' }, ctx);
ok('空 path 被拦下', r1.ok === false);
ok('说的是「path 不能为空」而不是 EISDIR', /path 不能为空/.test(String(r1.output)) && !/EISDIR/.test(String(r1.output)), String(r1.output));
ok('提示里给了正确示例', /agent-workbench\/index\.html/.test(String(r1.output)));

const r2 = await runTool('write_file', { path: '.', content: 'x' }, ctx);
ok('path 只给「.」也被拦下', r2.ok === false && /path 不能为空/.test(String(r2.output)), String(r2.output));

fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
const r3 = await runTool('write_file', { path: 'sub', content: 'x' }, ctx);
ok('指向已有目录时明确说要带文件名', r3.ok === false && /目录/.test(String(r3.output)) && /sub\/index\.html/.test(String(r3.output)), String(r3.output));

const r4 = await runTool('write_file', { path: 'sub/ok.txt', content: 'hi' }, ctx);
ok('正常路径照常写入', r4.ok === true && fs.readFileSync(path.join(tmp, 'sub/ok.txt'), 'utf8') === 'hi', String(r4.output));
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
console.log('ALL_OUTPUT_RAIL_OK');
/* tools.js 会带出网络层的常驻句柄，不显式退出的话进程挂着不结束，
   全量测试跑到这里会被当成超时杀掉（实测：断言全绿但 exit 137）。 */
process.exit(0);
