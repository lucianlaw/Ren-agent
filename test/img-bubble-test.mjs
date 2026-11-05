/* 图片三件事：发得出去、看得见、点得开。
 *
 * 现场（2026-11-05 晚）：
 *   ① 再发一次图片就报「服务端拒绝了这次执行（HTTP 403）：WAF拦截页面…」——
 *      base64 随 /api/run 重发，请求体几 MB，前置网关当成攻击载荷拦掉。
 *   ② 发出去的图在对话里看不到，只剩一行「（附 2 张截图）」。
 *   ③ 输入区那张缩略图只有 22px，点开没反应。
 *
 * 这组测试盯的就是这三条：体积必须只留路径、气泡必须渲染出图、图必须能放大。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/app.css'), 'utf8');
const attachSrc = fs.readFileSync(path.join(root, 'public/attach.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ── 极简 DOM（同 output-rail-test） ── */
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
  /* 带 sharecode 的 URL 拼装：线上每个请求都要它 */
  withSC: p => p + (p.includes('?') ? '&' : '?') + 'sharecode=SC123',
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
    src + '\n;return { slimFiles, stripImages, slimRunPayload, payloadKB, imgPathsOf, msgMeHTML, syncRounds, roundsList, state };'
  )(win, document, localStorage, win.location, win.navigator,
    win.requestAnimationFrame, win.fetch, console);
} catch (e) {
  console.error('app.js 加载失败：', e.message);
  console.error(String(e.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exit(1);
}
ok('app.js 能加载', !!mod && typeof mod.stripImages === 'function');

const { slimFiles, stripImages, slimRunPayload, payloadKB, imgPathsOf, msgMeHTML, syncRounds, roundsList, state } = mod;
state.scope = 'a'.repeat(32);

/* 一张「压过」的截图：700KB dataURL，和 attach.js 里的上限一致 */
const B64 = 'A'.repeat(700 * 1024);
const shot = (n) => ({
  name: `截图${n}.jpg`, path: `uploads/截图${n}.jpg`, mime: 'image/jpeg', size: 520 * 1024,
  kind: 'jpg', dataUrl: 'data:image/jpeg;base64,' + B64, thumb: 'data:image/jpeg;base64,' + B64
});
const doc1 = { name: '合同.pdf', path: 'uploads/合同.pdf', mime: 'application/pdf', size: 90000, dataUrl: null, thumb: null };

console.log('\n① 请求体里不许有 base64');
{
  const files = [shot(1), shot(2), doc1];
  const slim = slimFiles(files);
  ok('图片的 dataUrl 被摘掉', slim[0].dataUrl === null && slim[1].dataUrl === null);
  ok('缩略图 thumb 也被摘掉', slim[0].thumb === null);
  ok('路径留着（服务端要按它读盘）', slim[0].path === 'uploads/截图1.jpg');
  ok('非图片附件原样不动', slim[2].path === 'uploads/合同.pdf' && slim[2].mime === 'application/pdf');

  const payload = {
    task: {
      goal: '看图改原型',
      files,
      messages: [
        { role: 'system', content: '你是小阮' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '照这张图改' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + B64 } }
          ]
        }
      ]
    },
    followUpImages: [shot(3)]
  };
  const before = payloadKB(payload);
  const after = payloadKB(stripImages(payload));
  ok('三张图从兆级压到十 KB 以内', after < 10, `before=${before}KB after=${after}KB`);
  ok('messages 里的 image_url 换成了文字占位',
    typeof payload.task.messages[1].content[1] === 'object'
    && stripImages(payload).task.messages[1].content[1].type === 'text');
  ok('正文一个字没动', stripImages(payload).task.messages[1].content[0].text === '照这张图改');

  /* 体积大时还要继续砍正文，但不能把图带回来 */
  const big = stripImages(payload);
  const slim2 = slimRunPayload(payload, 2);
  ok('第二档瘦身之后仍然没有 base64',
    payloadKB(slim2) <= payloadKB(big) && !/data:image\/jpeg/.test(JSON.stringify(slim2)));
}

console.log('\n② 对话气泡要看得见图');
{
  const imgs = imgPathsOf([shot(1), doc1]);
  ok('只记图片路径和名字', imgs.length === 1 && imgs[0].path === 'uploads/截图1.jpg' && !('dataUrl' in imgs[0]));
  ok('PDF 不算图片', imgs.every(x => !/\.pdf$/.test(x.path)));

  const html = msgMeHTML('照这张图改', false, imgs);
  ok('气泡里有 <img>', /<img[^>]+class="bub-pic"/.test(html), html.slice(0, 200));
  /* 属性值里的 & 会被 esc 转成 &amp;（HTML 转义的正常行为，浏览器读回来还是 &） */
  ok('src 指向工作区原图', /\/api\/raw\?scope=[^"]+(&|&amp;)path=uploads%2F/.test(html), html.slice(0, 240));
  ok('带 sharecode（线上不带会被网关挡）', /sharecode=SC123/.test(html));
  ok('点了能放大：有 data-imgbox', /data-imgbox="/.test(html));
  ok('没有图时不渲染空容器', !/bub-pics/.test(msgMeHTML('就一句话', false, [])));
}

console.log('\n③ 刷新之后图还在（归一化别把它抹掉）');
{
  const task = {
    goal: '看图改原型', userMsgs: [], steps: [], rounds: 1
  };
  task.userMsgs = [{ text: '照这张图改', at: 0, round: 1, imgs: [{ path: 'uploads/截图1.jpg', name: '截图1.jpg' }] }];
  syncRounds(task);
  ok('userMsgs 还在', task.userMsgs.length === 1);
  ok('imgs 没被归一化抹掉', Array.isArray(task.userMsgs[0].imgs) && task.userMsgs[0].imgs.length === 1,
    JSON.stringify(task.userMsgs[0]));
  ok('二次 syncRounds 不会反复替换数组（引用稳定）',
    (() => { const a = task.userMsgs; syncRounds(task); return task.userMsgs === a; })());

  /* 升级前存下的老任务：userMsgs 里没有 imgs，但附件还在 files 里。
     不补这一档，历史对话里的图还是看不见。 */
  const old = {
    goal: '看我发的图', rounds: 1, steps: [],
    userMsgs: [{ text: '看我发的图', at: 0, round: 1 }],
    files: [{ path: 'uploads/老截图.jpg', mime: 'image/jpeg', name: '老截图.jpg' }]
  };
  const L = roundsList(old, 1);
  ok('老任务用 files 兜底出图', L[0].askItems[0].imgs.length === 1
    && L[0].askItems[0].imgs[0].path === 'uploads/老截图.jpg', JSON.stringify(L[0].askItems[0]));
}

console.log('\n④ 服务端自己读盘补图');
{
  ok('有 hydrateImages', /function hydrateImages\(/.test(serverSrc));
  ok('/api/run 会补 task.files', /task\.files = hydrateImages\(scope, task\.files\)/.test(serverSrc));
  ok('/api/run 会补 followUpImages', /job\.followUpImages = hydrateImages\(scope, job\.followUpImages\)/.test(serverSrc));
  ok('/inject 会补插话带来的图', /hydrateImages\(run\.scope, b\.images/.test(serverSrc));
  ok('超 4MB 原图不硬塞（让 view_image 去读）', /st\.size > 4 \* 1024 \* 1024/.test(serverSrc));
}

console.log('\n⑤ 输入区的缩略图能点开');
{
  ok('chip 上的缩略图带 data-imgbox', /class="att-th"[^>]*data-imgbox=/.test(attachSrc)
    || /data-imgbox="\$\{it\.thumb\}"/.test(attachSrc));
  ok('有可点的光标提示', /\.att-th\{[^}]*cursor:zoom-in/.test(css));
  ok('放大层有样式', /\.img-box\{/.test(css) && /\.img-box\.on\{display:flex\}/.test(css));
}

console.log('\n⑥ 输入框别被内容顶出视口');
{
  /* flex 纵向子项默认 min-height:auto，内容一长就不肯收缩，把输入框整块挤出去 */
  ok('.trace 有 min-height:0', /\.trace\{[^}]*min-height:0/.test(css), '.trace 缺 min-height:0 时输入框会被顶出屏幕');
  ok('.main 有 min-height:0', /\.main\{[^}]*min-height:0/.test(css));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
