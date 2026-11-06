/* 请求体里不许有源码：网关 403 的真正触发条件
 *
 * 现场（2026-11-06 晚，第五次栽在同一处）：
 *   任务在写一个 HTML 原型，点「继续跑」直接弹
 *   「服务端拒绝了这次执行（HTTP 403）」+ 一张 api.waf.qq.com 的反馈页。
 *   而这次请求体**并不大**——v0.8.5 只在超过 420KB 时才瘦身，
 *   几十 KB 的 index.html 根本没碰到阈值，于是被原样发了出去。
 *
 * 结论：网关不是按体积拦的，是按「内容里有没有整段源码」拦的。
 * 所以「代码不进请求体」必须是**无条件**的，不是「超过多少才处理」。
 *
 * 验的事：
 *   1. 工具读回来的正文（HTML/JS）→ 换成指针，不留原文
 *   2. 写文件的参数（整篇内容）→ 换成占位
 *   3. 历史里带源码的普通消息 → 掐头，且不再含 <script
 *   4. 老板最后那句短指令 → 原样不动
 *   5. 体积：几百 KB 的代码上下文洗成几十 KB
 *   6. 丢消息时成对丢（tool_calls 和它的 tool 回复不能拆开）
 *
 * 跑法：node test/wire-scrub-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

/* ── 极简 DOM（同 img-bubble-test） ── */
function el(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false,
    style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
      contains(c) { return this._s.has(c); }
    },
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
  withSC: p => p, fetch: async () => ({ ok: false, json: async () => ({}) }),
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
    src + '\n;return { slimMessages, scrubForWire, looksCode, msgsKB, fitMessages, stripImages, payloadKB, CODE_HINT };'
  )(win, document, localStorage, win.location, win.navigator,
    win.requestAnimationFrame, win.fetch, console);
} catch (e) {
  console.error('app.js 加载失败：', e.message);
  process.exit(1);
}
const { slimMessages, scrubForWire, looksCode, msgsKB, fitMessages, stripImages } = mod;

/* 一段够真实的原型代码：既有 <script>，也有 function( */
const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0}.box{display:flex}
</style></head><body><div class="box">原型</div>
<script>
function bindInput(){ var el = document.querySelector('#input'); el.addEventListener('click', function(){ console.log('hi'); }); }
window.onload = bindInput;
</script></body></html>`;
const PY = `import os\nclass Agent:\n    def run(self, task):\n        return task\n`;

console.log('[1] 什么算「源码」');
{
  ok('HTML 被认出是源码', looksCode(HTML));
  ok('Python 被认出是源码', looksCode(PY));
  ok('中文说明不算源码', !looksCode('这个输入框没法输入，先看一下 JS 是不是被 disabled 了，然后按截图改。'));
  ok('短句不算源码（长度不够）', !looksCode('<html>'));
}

console.log('[2] 工具输出：原件不进请求');
{
  const msgs = [
    { role: 'system', content: '你是小阮' },
    { role: 'assistant', content: '我读一下文件', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"index.html"}' } }] },
    { role: 'tool', tool_call_id: 't1', content: HTML }
  ];
  const out = slimMessages(msgs, -1);
  eq('系统提示一字不动', out[0].content, '你是小阮');
  ok('工具输出换成了指针', /已省略/.test(out[2].content), out[2].content);
  ok('工具输出里没有 <script', !/<script/.test(out[2].content));
  ok('助手那句话还在', out[1].content === '我读一下文件');
}

console.log('[3] 写文件的参数：整篇内容也要摘');
{
  const msgs = [
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: HTML }) } }] },
    { role: 'tool', tool_call_id: 't1', content: '写入成功 4123 字节' },
    { role: 'user', content: '继续' }
  ];
  const out = slimMessages(msgs, -1);
  ok('参数被换成占位', /参数已省略/.test(out[0].tool_calls[0].function.arguments), out[0].tool_calls[0].function.arguments);
  ok('整条消息里没有 <script', !/<script/.test(JSON.stringify(out)));
  ok('短工具输出保留（那是结论不是正文）', out[1].content === '写入成功 4123 字节');
  eq('最后一句老板的话原样', out[2].content, '继续');
}

console.log('[4] 历史里带源码的普通消息');
{
  const msgs = [
    { role: 'assistant', content: '这是你要的原型：\n' + HTML },
    { role: 'user', content: '按这个改' }
  ];
  const out = slimMessages(msgs, -1);
  ok('被掐头', out[0].content.length < 800, out[0].content.length);
  ok('不再含 <script', !/<script/.test(out[0].content));
  ok('末尾那句短指令原样', out[1].content === '按这个改');
}

console.log('[5] 体积：几百 KB 的代码上下文必须洗到能过网关');
{
  /* 真实的 index.html 是几 KB 到十几 KB：这里按 15 倍重复模拟一个「写了很多版」的任务 */
  const BIG = HTML.repeat(15);
  const msgs = [{ role: 'system', content: 's'.repeat(1200) }];
  for (let i = 0; i < 40; i++) {
    msgs.push({ role: 'assistant', content: '写第 ' + i + ' 版', tool_calls: [{ id: 't' + i, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'p' + i + '.html', content: BIG + i }) } }] });
    msgs.push({ role: 'tool', tool_call_id: 't' + i, content: BIG + i });
  }
  msgs.push({ role: 'user', content: '接着改' });
  const before = msgsKB(msgs);
  const after = msgsKB(slimMessages(msgs, -1));
  ok('原始体积足够大（复现前提）', before > 200, before + 'KB');
  ok('洗后 < 120KB', after < 120, after + 'KB');
  ok('洗后整个 JSON 里没有 <script', !/<script/.test(JSON.stringify(slimMessages(msgs, -1))));
  ok('最后一句还在', slimMessages(msgs, -1).slice(-1)[0].content === '接着改');
}

console.log('[6] 丢消息要成对丢');
{
  const msgs = [{ role: 'system', content: 's' }];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'assistant', content: 'a'.repeat(3000), tool_calls: [{ id: 't' + i, type: 'function', function: { name: 'read_file', arguments: '{"path":"x"}' } }] });
    msgs.push({ role: 'tool', tool_call_id: 't' + i, content: 'y'.repeat(3000) });
  }
  const out = fitMessages(msgs, 20);
  ok('确实压到预算内', msgsKB(out) <= 20, msgsKB(out));
  /* 每个 tool 回复前面必须还有它那条带 tool_calls 的 assistant */
  const ids = new Set();
  let orphan = 0;
  for (const m of out) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) ids.add(tc.id);
    if (m.role === 'tool' && !ids.has(m.tool_call_id)) orphan++;
  }
  eq('没有孤儿 tool 回复', orphan, 0);
}

console.log('[7] 存档也走同一道洗');
{
  ok('persistTask 里的 messages 先洗再存', /messages: task\.messages \? slimMessages\(task\.messages, -1\) : null/.test(src));
  ok('每次请求都洗（不是超了才洗）', /let body = stripImages\(payload\);/.test(src) && /const base = scrubForWire\(arr\);/.test(src));
  ok('403 时把请求体大小带进错误里', /请求体 \$\{payloadKB\(body\)\}KB/.test(src));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
