// 安全网关（WAF）特征：这是 2026-11-06 用**真请求**探出来的，不是猜的。
//
// 现场：老板连着两次看到「模型通道拒绝了这次请求（可能是额度或权限）：WAF拦截页面
// function submitWafFeedback()…」。前几次我都判成「请求体太大」，一路加阈值、
// 摘图片 base64、压正文，全都没用——因为拦的不是体积。
//
// 探法：同一个端点（POST /.cloud/llm/chat/completions）、同一份假凭证，只换正文。
//   干净正文  → 401 invalid_client（说明请求进了业务层，只是凭证是假的）
//   命中特征  → 403 + https://api.waf.qq.com 的拦截页
// 结论（每一条都单独发过）：
//   拦：<script>…</script>（成对才拦）、onclick= / onload= 等事件属性、alert( / eval(、
//       javascript:、DROP TABLE、union select、../../ 穿越、etc/passwd
//   不拦：200KB 纯中文、function / import / 反引号代码块 / iframe / DOCTYPE、
//       单独的 "<script" 或 "</script>"、SELECT * FROM、JSON 的 \u003c 转义（会先解码）
// 所以「压体积」「换编码」都没用，只能让这些片段不出现在请求里。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentSrc = fs.readFileSync(path.join(root, 'public/agent.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? '  → ' + String(extra).slice(0, 300) : ''}`);
}

/* ── 造一个够 agent.js 跑起来的壳 ── */
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

let BOSS = null;
try {
  BOSS = new Function(
    'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
    'requestAnimationFrame', 'fetch', 'console',
    agentSrc + '\n;return window.BOSS;'
  )(win, document, win.localStorage, win.localStorage, win.location, win.navigator,
    win.requestAnimationFrame, win.fetch, console);
} catch (e) {
  console.error('agent.js 加载失败：', e.message);
  process.exit(1);
}
ok('agent.js 能加载出 BOSS', !!BOSS && typeof BOSS.wafHit === 'function');
const { wafHit, wafMask, safeForModel, looksLikeBlockPage } = BOSS;

console.log('\n[1] 命中判定：线上探到会 403 的写法，一个都不能漏');
{
  const hit = [
    ['成对 script 标签', '<script>function f(){}</script>'],
    ['带属性的 script', '<script type="text/javascript">var a=1;</script>'],
    ['多行 script 块', '<div>\n<script>\nconst a = 1;\n</script>\n</div>'],
    ['转义后的 script', '&lt;script&gt;function f(){}&lt;/script&gt;'],
    ['onclick 事件属性', '<button onclick="go()">x</button>'],
    ['onload', '<body onload="init()">'],
    ['onerror', '<img src=x onerror="a()">'],
    ['alert(', '这里写着 alert(1)'],
    ['eval(', 'eval("1+1")'],
    ['javascript: 伪协议', '<a href="javascript:alert(1)">x</a>'],
    ['DROP TABLE', 'DROP TABLE users'],
    ['union select', '1 union select password from t'],
    ['union all select', '1 union all select 1'],
    ['路径穿越', '../../etc/something'],
    ['etc/passwd', '看看 /etc/passwd']
  ];
  for (const [name, s] of hit) ok(name + ' 判为命中', !!wafHit(s), wafHit(s));
}

console.log('\n[2] 不误报：这些线上实测是放行的，不能自己把自己拦死');
{
  const clean = [
    ['纯中文', '帮我把这段话改得更简洁一些'],
    ['function 定义', 'function build(a, b) { return a + b; }'],
    ['DOCTYPE 网页', '<!DOCTYPE html><html><body><h1>hi</h1></body></html>'],
    ['import 语句', "import fs from 'node:fs';\nexport const x = 1;"],
    ['反引号代码块', '```html\n<div class="a">x</div>\n```'],
    ['单独 <script 开头', '这里说的是 <script 这个词'],
    ['单独 </script>', '结尾写了 </script>'],
    ['SELECT * FROM', 'SELECT * FROM t'],
    ['普通 HTML', '<div class="card"><h1>标题</h1><p>正文</p></div>'],
    ['内联样式', '<div style="color:red">x</div>'],
    ['200KB 纯中文', '这是一段很长的中文说明文字。'.repeat(8000)]
  ];
  for (const [name, s] of clean) ok(name + ' 不命中', !wafHit(s), wafHit(s));
}

console.log('\n[3] 掩码：换完之后必须放行，而且结构不能坏');
{
  const html = [
    '<!DOCTYPE html>',
    '<html><head><title>原型</title></head>',
    '<body onload="init()">',
    '  <h1 class="title">标题</h1>',
    '  <button onclick="go()">开始</button>',
    '  <script>',
    '    function go() {',
    '      document.getElementById("a").innerHTML = "x";',
    '      alert(1);',
    '    }',
    '  </script>',
    '</body></html>'
  ].join('\n');

  const masked = wafMask(html);
  ok('掩码后不再命中', !wafHit(masked), wafHit(masked));
  ok('行数不变（行号引用才对得上）', masked.split('\n').length === html.split('\n').length,
    `${masked.split('\n').length} vs ${html.split('\n').length}`);
  ok('脚本里的函数体还在', /function go\(\)/.test(masked) && /getElementById/.test(masked));
  ok('标签换成了可读占位', /\[script 标签\]/.test(masked) && /\[script 结束\]/.test(masked));
  ok('事件属性换成 on…=', /on…=/.test(masked) && !/onclick=/.test(masked));
  ok('alert 换成了中文', /警告\(/.test(masked) && !/alert\(/.test(masked));
  ok('正常 HTML 一个字没动', masked.includes('<h1 class="title">标题</h1>'));
  ok('幂等：再掩一次不变', wafMask(masked) === masked);

  /* 单行内的整块 script 也要能换 */
  const one = '<script>function f(){}</script>';
  ok('单行 script 块也能过', !wafHit(wafMask(one)), wafMask(one));
  ok('单行块的函数体保留', /function f\(\)/.test(wafMask(one)));

  /* 兜底：认不出来的特征，宁可折这一行 */
  const weird = '<script onmouseover=x>y</script>';
  ok('边角写法也有兜底', !wafHit(wafMask(weird)), wafMask(weird));
}

console.log('\n[4] 发请求前：历史里的整份文件换成指针，system 一个字不许动');
{
  const bigHtml = '<html><body onload="x()"><script>var a=1;</script></body></html>';
  const msgs = [
    { role: 'system', content: '你是阮，规矩若干。<script>这里不该出现</script>' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'index.html', content: bigHtml }) } }] },
    { role: 'tool', tool_call_id: 'c1', content: '已写入 index.html（1200B）' },
    { role: 'user', content: '把标题改大一点' }
  ];
  const out = safeForModel(msgs, 0);
  ok('条数不变', out.length === msgs.length);
  ok('system 被掩码（否则整轮必挂）', !wafHit(out[0].content));
  ok('工具参数换成指针', /参数没有随上下文重发/.test(out[1].tool_calls[0].function.arguments));
  ok('指针里带上了路径', /index\.html/.test(out[1].tool_calls[0].function.arguments));
  ok('用户这句话原样保留', /把标题改大一点/.test(out[3].content));
  ok('工具回复原样（本身没触发词）', out[2].content === msgs[2].content);
  ok('原始 messages 没被改坏', msgs[1].tool_calls[0].function.arguments.includes('<script>'));
  ok('整轮序列化后不再命中', !wafHit(JSON.stringify(out)));

  /* 短的、干净的工具参数不该被动 */
  const clean = [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }] }];
  ok('干净参数原样', safeForModel(clean, 0)[0].tool_calls[0].function.arguments === '{"path":"a.md"}');

  /* 掩过东西时补一句说明，否则模型会以为文件里真有「[script 标签]」 */
  ok('补了占位说明', /这些占位只存在于这次对话的传输里/.test(out[3].content));
}

console.log('\n[5] 降级重发：只留尾巴时，tool 回复不能和它的调用拆开');
{
  const msgs = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '内容' },
    { role: 'assistant', content: '好' },
    { role: 'user', content: '再改一下' }
  ];
  const lv1 = safeForModel(msgs, 1);
  ok('level1 保留了 system', lv1[0].role === 'system');
  ok('level1 收紧了条数', lv1.length < msgs.length, lv1.length);
  const firstNonSys = lv1.find(m => m.role !== 'system');
  ok('level1 不会以 tool 开头（否则 400）', firstNonSys.role !== 'tool', firstNonSys.role);
  const lv2 = safeForModel(msgs, 2);
  ok('level2 只剩 system + 最后一句', lv2.length === 2 && lv2[1].role === 'user', JSON.stringify(lv2.map(m => m.role)));
  /* 尾巴正好是一条 tool 回复时，必须把它的 assistant 一起带回来 */
  const tailTool = [
    { role: 'system', content: 'SYS' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c9', content: '内容' }
  ];
  const t = safeForModel(tailTool, 1);
  ok('尾巴是 tool 时把它的调用一起带上', t.some(m => m.role === 'assistant') && t.some(m => m.role === 'tool'),
    JSON.stringify(t.map(m => m.role)));
}

console.log('\n[6] 拦截页识别：被压成一行的也要认得出来');
{
  /* llm.js 会把拦截页去标签 + 截 160 字，老判定（要求有 <html> 或 >800 字）永远为假 */
  const short = '模型通道拒绝了这次请求（可能是额度或权限）：WAF拦截页面 function submitWafFeedback() { var uuid = document.getElementById("uuid").innerHTML;';
  ok('压成一行的拦截页认得出', looksLikeBlockPage(short));
  ok('带 api.waf.qq 的也认得出', looksLikeBlockPage('见 https://api.waf.qq.com/x'));
  ok('普通 403 不误判', !looksLikeBlockPage('服务端拒绝了这次执行（HTTP 403）'));
}

console.log('\n[7] 接口层：403 要分清「网关拦的」和「真没权限」');
{
  const llm = fs.readFileSync(path.join(root, 'lib/llm.js'), 'utf8');
  ok('llm.js 有拦截页指纹', /WAF_BODY\s*=/.test(llm));
  ok('拦截页不打「额度或权限」标签', /status === 403 && looksWafBody\(raw\)/.test(llm));
  ok('错误上打了 waf 标记', /err\.waf = true/.test(llm));
  ok('导出识别函数', /export function looksWafBody/.test(llm));
}

console.log('\n[8] 源码钉住：三条链路都接到了');
{
  ok('每次模型调用前都洗', /messages: safeForModel\(messages, 0\)/.test(agentSrc));
  ok('失败后按 waf 标记升级重发', /const waf = !!\(e && e\.waf\)[\s\S]{0,400}safeForModel\(args\.messages/.test(agentSrc));
  ok('存档前也掩码', /out\.content = wafMask\(out\.content\)/.test(agentSrc));
  ok('app.js 复用同一份规则', /BOSS\.wafMask/.test(appSrc));
  ok('请求体清洗用上了它', /const cleaned = wafMaskText\(stripCodeBlocks\(t\)\)/.test(appSrc));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
