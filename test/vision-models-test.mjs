/* 看图模型：候选链怎么排、谁能进、服务端怎么存。
 *
 * 背景：通道只标「支持工具调用」，没有「能不能收图」的能力位，前端只能按名字挑。
 * 押一个名字 = 押一次，押错就是「400，看不了图」而且没有退路。
 * 所以改成候选链：当前模型排最前（它要是本来就能看图，不该另开一条通道去花钱），
 * 后面按列表顺序补，服务端挨个试。
 *
 * 这里把 app.js 真加载进 mock DOM，直接跑 pickVisionModels，不看源码字符串。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const toolsSrc = fs.readFileSync(path.join(root, 'lib/tools.js'), 'utf8');

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
    src + '\n;return { state, pickVisionModels, pickVisionModel, visionCheck };'
  )(win, document, win.localStorage, win.localStorage, win.location, win.navigator,
    win.requestAnimationFrame, win.fetch, console);
} catch (e) {
  console.error('app.js 加载失败：', e.message);
  console.error(String(e.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
ok('app.js 能加载', !!M && typeof M.pickVisionModels === 'function');

const { state, pickVisionModels, pickVisionModel } = M;

const mk = (id, name) => ({ id, name: name || id });

console.log('候选链的顺序');
{
  /* 当前模型本身就能看图：它必须排第一，不该另开一条通道 */
  state.models = [mk('gpt-4o'), mk('deepseek-v4.1-flash'), mk('qwen2.5-vl-7b')];
  state.settings.model = 'gpt-4o';
  const c = pickVisionModels();
  ok('当前模型能看图时排第一', c[0] === 'gpt-4o', JSON.stringify(c));
  ok('名字能看图的都进候选', c.includes('qwen2.5-vl-7b'), JSON.stringify(c));
  ok('纯文本模型不进候选', !c.includes('deepseek-v4.1-flash'), JSON.stringify(c));

  /* 当前模型看不了图：候选里不该出现它 */
  state.models = [mk('deepseek-v4.1-flash'), mk('glm-4v'), mk('gemini-2.5-pro')];
  state.settings.model = 'deepseek-v4.1-flash';
  const c2 = pickVisionModels();
  ok('当前模型没有视觉能力时不进候选', !c2.includes('deepseek-v4.1-flash'), JSON.stringify(c2));
  ok('退回到第一个能看图的模型', c2[0] === 'glm-4v', JSON.stringify(c2));
}

console.log('过滤与上限');
{
  state.models = [
    mk('tts-1', 'tts audio'), mk('text-embedding-3', 'embedding'),
    mk('whisper-1', 'whisper'), mk('my-vision-model'), mk('vision-model')
  ];
  state.settings.model = '';
  const c = pickVisionModels();
  ok('音频/向量模型被排除', !c.some(x => /tts|embedding|whisper/i.test(x)), JSON.stringify(c));
  ok('名字带 vision 的能进', c.includes('my-vision-model'), JSON.stringify(c));

  state.models = ['a-vision', 'b-vision', 'c-vision', 'd-vision', 'e-vision', 'f-vision'].map(x => mk(x));
  state.settings.model = '';
  const many = pickVisionModels();
  ok('候选最多 4 个（每个都要真花钱试一次）', many.length === 4, JSON.stringify(many));
  ok('候选之间不重复', new Set(many).size === many.length);

  state.models = [];
  ok('没有模型时返回空数组而不是抛错', Array.isArray(pickVisionModels()) && pickVisionModels().length === 0);
  ok('pickVisionModel 是候选链的第一个', pickVisionModel() === '');
}

console.log('服务端存的是链，不是单个名字');
{
  ok('VISION 支持数组', /Array\.isArray\(model\) \? model : \[model\]/.test(serverSrc));
  ok('去重且有上限', /\[\.\.\.new Set\(list\)\]\.slice\(0, 6\)/.test(serverSrc));
  ok('工具层拿到的是候选链', /models: visionModelsOf\(scope\)/.test(serverSrc));
  ok('兼容旧字段 visionModel', /b\.visionModels \|\| b\.visionModel/.test(serverSrc));
  ok('前端两个字段都发', /visionModels: pickVisionModels\(\)/.test(src)
    && /visionModel: pickVisionModel\(\)/.test(src));
}

console.log('工具层挨个试');
{
  ok('候选上限 3 个（再多多花钱）', /\.slice\(0, 3\)/.test(toolsSrc));
  ok('失败信息里带体积（区分「太大」和「不收图」）', /base64 约/.test(toolsSrc));
  ok('失败信息要求照抄原文', /照抄转告老板/.test(toolsSrc));
}

console.log('自检入口');
{
  const btn = document.querySelector('#visionCheckBtn');
  ok('自检按钮挂上了处理函数', typeof btn.onclick === 'function');
  ok('自检走真实模型通道', /CLOUD\.chatStream\(\{/.test(src));
  ok('测试图当场用 canvas 画（失败就不可能是「图太大」）', /canvas/.test(src) && /REN 7391/.test(src));
  ok('自检查的是「有没有真读出来」而不是「有没有返回」', /\^7391|7391\//.test(src) || /\/7391\//.test(src));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
