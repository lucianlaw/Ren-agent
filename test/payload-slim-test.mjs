/* 请求体瘦身：网关 403 的自救。
 *
 * 现场（2026-11-05 晚）：任务生成了 index.html + agent_server.py，第 4 轮续跑时
 * 前端报「服务端拒绝了这次执行（HTTP 403）」。我们的 403 全部带 JSON，
 * 而这里 r.json() 解析失败 —— 说明响应根本不是我们发的，是前置安全网关的拦截页。
 * 请求体里每轮都带着整段生成的代码，累计到几百 KB 就被当成攻击载荷。
 *
 * 这里把 app.js 真加载进 mock DOM，直接跑瘦身函数：
 * 体积必须下来，而且不能把「老板刚说的这句话」和 system 提示砍掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(root, 'public/agent.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

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
  createElement: () => el(''),
  addEventListener() {}, body: el('body'), documentElement: el('html'), head: el('head'),
  createTextNode: () => ({})
};
const store = new Map();
const win = {
  addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)
  },
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
    src + '\n;return { slimText, slimMessages, slimRunPayload, payloadKB };'
  )(win, document, win.localStorage, win.localStorage, win.location, win.navigator,
    win.requestAnimationFrame, win.fetch, console);
} catch (e) {
  console.error('app.js 加载失败：', e.message);
  console.error(String(e.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
ok('app.js 能加载', !!M && typeof M.slimMessages === 'function');
const { slimText, slimMessages, slimRunPayload, payloadKB } = M;

console.log('短内容不动');
{
  ok('短文本原样返回', slimText('这红框标定的地方输入框，没法输入和发送消息', 700, 220)
    === '这红框标定的地方输入框，没法输入和发送消息');
  const msgs = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在' }];
  ok('短消息一条不少', slimMessages(msgs, 1).length === 2);
  ok('短消息内容不变', slimMessages(msgs, 1)[0].content === '你好');
}

console.log('长内容砍成头 + 尾');
{
  const big = 'A'.repeat(5000) + 'MIDDLE' + 'B'.repeat(500);
  const s = slimText(big, 700, 220);
  ok('长度明显下降', s.length < 1200, String(s.length));
  ok('保留开头', s.startsWith('AAA'));
  ok('保留结尾', s.endsWith('BBB'));
  ok('中间标了省略说明', /中间省略 \d+ 字/.test(s) && /read_file/.test(s));
  ok('原文深处的正文确实没了', !s.includes('MIDDLE'));
}

console.log('对话结构不能坏');
{
  const msgs = [
    { role: 'system', content: 'S'.repeat(3000) },
    { role: 'user', content: 'U'.repeat(3000) },
    { role: 'assistant', content: 'A'.repeat(3000) },
    { role: 'user', content: 'U2'.repeat(100) },
    { role: 'assistant', content: 'A2'.repeat(100) },
    { role: 'user', content: '这红框标定的地方输入框，没法输入和发送消息' }
  ];
  const out = slimMessages(msgs, 1);
  ok('消息条数不变', out.length === msgs.length);
  ok('system 提示一个字都不动', out[0].content === msgs[0].content);
  ok('最后一句新指令原样留着', out[5].content === msgs[5].content);
  ok('中间的历史被压缩', out[1].content.length < 1200, String(out[1].content.length));
  /* 第二档更狠，但依然不能动最后两条 */
  const out2 = slimMessages(msgs, 2);
  ok('第二档压得更狠', out2[1].content.length <= out[1].content.length);
  ok('第二档也不动 system', out2[0].content === msgs[0].content);
  ok('第二档保留最后一条新指令', out2[5].content === msgs[5].content);
}

console.log('写文件的工具参数（代码全文就在这儿）');
{
  const code = 'def main():\n' + '    print("x")\n'.repeat(600);
  const msgs = [{
    role: 'assistant', content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'agent_server.py', content: code }) } }]
  }, { role: 'tool', tool_call_id: 'c1', content: '已写入 agent_server.py' }];
  const out = slimMessages(msgs, 1);
  const a = out[0].tool_calls[0].function.arguments;
  ok('超长代码参数被替换', a.length < 200, String(a.length));
  ok('替换后仍是合法 JSON', (() => { try { JSON.parse(a); return true; } catch { return false; } })());
  ok('提示指向工作区', /read_file/.test(a));
  ok('工具名保留（否则对话结构就不合法了）', out[0].tool_calls[0].function.name === 'write_file');

  const small = [{ role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'hi' }) } }] }];
  ok('小文件参数不动', slimMessages(small, 1)[0].tool_calls[0].function.arguments.includes('hi'));
}

console.log('图片 base64 是体积大户');
{
  const payload = {
    task: { id: 't1', goal: 'x', messages: [{ role: 'user', content: '看图' }] },
    followUpImages: [{ name: 'a.png', path: 'uploads/a.png', dataUrl: 'data:image/png;base64,' + 'X'.repeat(400000) }]
  };
  const slim = slimRunPayload(payload, 1);
  ok('base64 被去掉', !slim.followUpImages[0].dataUrl);
  ok('路径保留（view_image 还要用）', slim.followUpImages[0].path === 'uploads/a.png');
  ok('原 payload 没被就地改坏', payload.followUpImages[0].dataUrl.length > 1000);
}

console.log('真算一次体积：一个真实大小的任务');
{
  const code = 'import os\n' + 'def f():\n    return 1\n'.repeat(3000);   // ≈ 66KB 代码
  const msgs = [
    { role: 'system', content: '你是员工。'.repeat(200) },
    { role: 'user', content: '做一个最前沿的 agent 工具' }
  ];
  /* 模拟 4 轮：每轮都有一次写文件（整份代码）+ 一次读回 */
  for (let r = 0; r < 4; r++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + r, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'a.py', content: code }) } }] });
    msgs.push({ role: 'tool', tool_call_id: 'c' + r, content: code });
    msgs.push({ role: 'assistant', content: '第 ' + r + ' 轮做完了，' + '说明'.repeat(300) });
  }
  msgs.push({ role: 'user', content: '这红框标定的地方输入框，没法输入和发送消息' });
  const payload = { task: { id: 't', goal: 'g', messages: msgs }, followUp: '这红框…', followUpImages: [] };
  const before = payloadKB(payload);
  const after1 = payloadKB(slimRunPayload(payload, 1));
  const after2 = payloadKB(slimRunPayload(payload, 2));
  ok('瘦身前确实超阈值', before > 420, before + 'KB');
  ok('第一档压到阈值以下', after1 < 420, after1 + 'KB');
  ok('第二档比第一档更小', after2 < after1, `${after1} → ${after2}`);
  console.log(`    体积：${before}KB → ${after1}KB → ${after2}KB`);
}

console.log('存云前也要瘦（否则“完整轨迹没同步上”）');
{
  ok('leanMessages 会处理 tool_calls 里的代码', /out\.tool_calls = out\.tool_calls\.map/.test(agentSrc));
  ok('超长参数换成说明', /文件全文已省略；内容已在工作区/.test(agentSrc));
  ok('单条超长正文也砍', /内容过长已省略/.test(agentSrc));
}

console.log('403 要能分辨是谁拒的');
{
  ok('非 JSON 响应会带上拦截页开头', /replace\(\/<!\[^>\]\*>\/g, ' '\)/.test(src) || /replace\(\/<\[\^>\]\*>\/g, ' '/.test(src));
  ok('成功时不去读 body（读了就把 SSE 流吃掉了）', /if \(resp\.ok\) return \{ resp, raw: '', j: null \}/.test(src));
  ok('被网关拦会自动压到最小重发', /已把上下文压到最小重发/.test(src));
  ok('体积超阈值第一发就瘦', /kb0 > 420/.test(src) && /slimRunPayload\(payload, 1\)/.test(src));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
