// 联网层：把「外面的事实」拿进来
//
// 两条路：
//   web_search → 必应结果页，抽标题 + 链接 + 摘要（不依赖任何 API Key）
//   fetch_url  → 打开具体网页，剥掉脚本与导航，只留正文
//
// 安全边界（这里是唯一能主动往外连的地方，必须自己把关）：
//   1. 只允许 http / https
//   2. 禁止内网与云元数据地址（否则工具能读服务器自己的内部接口）
//   3. 手动逐跳跟随重定向，每一跳都重新校验
//   4. 响应体上限、超时上限

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const BLOCK_HOST = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^::1$/i, /^fc00:/i, /^fe80:/i,
  /\.local$/i, /\.internal$/i, /\.localhost$/i, /metadata\./i
];

export function urlProblem(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return '不是合法网址'; }
  if (!/^https?:$/.test(u.protocol)) return '只支持 http / https';
  const h = u.hostname.toLowerCase();
  if (BLOCK_HOST.some(re => re.test(h))) return '不允许访问内网或本机地址';
  if (!h.includes('.')) return '域名不完整';
  return null;
}

async function readCapped(res, maxBytes) {
  const buf = await res.arrayBuffer();
  const bytes = Buffer.from(buf);
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  return bytes.subarray(0, maxBytes).toString('utf8') + '\n…（内容过长已截断）';
}

/** 带逐跳校验的抓取。返回 { ok, status, url, html } */
export async function grab(url, { timeout = 15000, maxBytes = 2 * 1024 * 1024, headers = {} } = {}) {
  let cur = String(url).trim();
  for (let hop = 0; hop < 4; hop++) {
    const bad = urlProblem(cur);
    if (bad) return { ok: false, error: bad, url: cur };
    let res;
    try {
      res = await fetch(cur, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers }
      });
    } catch (e) {
      const msg = e && e.name === 'TimeoutError' ? `请求超时（${Math.round(timeout / 1000)}s）` : `请求失败：${e.message}`;
      return { ok: false, error: msg, url: cur };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, error: `跳转但没有目标（${res.status}）`, url: cur };
      cur = new URL(loc, cur).toString();
      continue;
    }
    if (!res.ok) return { ok: false, error: `对方返回 ${res.status}`, url: cur, status: res.status };
    const ct = String(res.headers.get('content-type') || '');
    if (!/text|json|xml|html/i.test(ct) && ct) {
      return { ok: false, error: `不是文本内容（${ct.split(';')[0]}），读不了`, url: cur };
    }
    const body = await readCapped(res, maxBytes);
    return { ok: true, status: res.status, url: cur, html: body, contentType: ct };
  }
  return { ok: false, error: '跳转次数过多', url: cur };
}

/** 抓二进制（图片）。与 grab 同一套逐跳校验，只是不把响应体当文本 */
export async function grabBinary(url, { timeout = 20000, maxBytes = 8 * 1024 * 1024, headers = {} } = {}) {
  let cur = String(url).trim();
  for (let hop = 0; hop < 4; hop++) {
    const bad = urlProblem(cur);
    if (bad) return { ok: false, error: bad, url: cur };
    let res;
    try {
      res = await fetch(cur, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', ...headers }
      });
    } catch (e) {
      const msg = e && e.name === 'TimeoutError' ? '请求超时' : `请求失败：${e.message}`;
      return { ok: false, error: msg, url: cur };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, error: `跳转但没有目标（${res.status}）`, url: cur };
      cur = new URL(loc, cur).toString();
      continue;
    }
    if (!res.ok) return { ok: false, error: `对方返回 ${res.status}`, url: cur };
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) return { ok: false, error: `图片太大（${Math.round(len / 1024)}KB）`, url: cur };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, error: `图片太大（${Math.round(buf.length / 1024)}KB）`, url: cur };
    return { ok: true, buf, url: cur, contentType: ct };
  }
  return { ok: false, error: '跳转次数过多', url: cur };
}

/**
 * 图片搜索。只做一件事：给定一句话，回一批可直接下载的图片地址。
 *
 * 为什么要单独一路：正文搜索给的是网页，图得另找。实测结论（2026-10）：
 *   cn.bing.com 的图片搜索在云出口可用，结果里带原图直链（murl），质量最好，作主源。
 *   搜狗图片（pic.sogou.com）作兜底：跟正文搜索同一套域名，云上通常也通。
 * 两个都空就如实回空数组 —— 不出图也不能让模型去编图片地址。
 */
export async function imageSearch(query, limit = 8) {
  const q = String(query || '').trim().slice(0, 60);
  if (!q) return { ok: false, error: '搜索词是空的', results: [], engine: '' };

  const found = [];
  const seen = new Set();
  const push = (u, w) => {
    let s = String(u || '').trim();
    if (!s || s.startsWith('data:')) return;
    if (s.startsWith('//')) s = 'https:' + s;
    if (!/^https?:\/\//i.test(s)) return;
    if (!/\.(jpe?g|png)(\?|$)/i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    found.push({ url: s, width: Number(w) || 0 });
  };

  /* 主源：必应图片 */
  try {
    const u = 'https://cn.bing.com/images/search?q=' + encodeURIComponent(q)
      + '&form=HDRSC2&first=1&tsc=ImageHoverTitle';
    const r = await grab(u, { timeout: 12000, headers: { referer: 'https://cn.bing.com/' } });
    if (r.ok) {
      const html = r.html;
      const re1 = /murl&quot;:&quot;(https?:[^&]+?)&quot;/g;
      const re2 = /"murl":"((?:[^"\\]|\\.)+?)"/g;
      for (const re of [re1, re2]) {
        let m;
        while ((m = re.exec(html)) && found.length < limit * 3) push(m[1].replace(/\\\//g, '/'));
      }
    }
  } catch { /* 换兜底源 */ }

  /* 兜底：搜狗图片（ajax 接口回 JSON） */
  if (found.length < limit) {
    try {
      const u = 'https://pic.sogou.com/napi/pc/searchList?mode=1&start=0&xml_len=48&query='
        + encodeURIComponent(q);
      const r = await grab(u, { timeout: 12000, headers: { referer: 'https://pic.sogou.com/' } });
      if (r.ok) {
        const re = /"(?:picUrl|oriPicUrl|locImageLink)":"((?:[^"\\]|\\.)+?)"/g;
        let m;
        while ((m = re.exec(r.html)) && found.length < limit * 3) push(m[1].replace(/\\\//g, '/'));
      }
    } catch { /* 无源可用 */ }
  }

  if (!found.length) return { ok: false, error: '两个图片源都没返回可下载的结果', results: [], engine: '' };
  return { ok: true, results: found.slice(0, limit), engine: found.length ? 'cn.bing.com/pic.sogou.com' : '' };
}

/* ── AI 文生图（Pollinations.ai，免 key，限速 1 张/45 秒/IP）── */
export async function genImage(prompt, opts = {}) {
  const width = opts.width || 1024;
  const height = opts.height || 1024;
  const seed = opts.seed || Math.floor(Math.random() * 1000000);
  const model = opts.model || 'flux';
  const encoded = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true&seed=${seed}&model=${model}`;
  /* 总预算 100 秒：这是同步接口，卡太久平台网关会先断开，前端只能拿到「不是 JSON」。
     免费档限速是 1 张/45 秒/IP，硬等 46 秒 ×2 次等于一次调用烧 3-7 分钟，
     所以这里只等一次短的，仍然不成就立刻把失败交回给员工，让它换 find_image。 */
  /* 75 秒硬上限：网关对同步请求的耐心通常比这更短，超了前端只能收到一坨 HTML */
  const deadline = Date.now() + 75000;
  /* 免费档（Classic API）高峰经常整体 402/503，配了自己的 pollen key 就走授权通道，稳定得多 */
  const auth = process.env.POLLINATIONS_TOKEN ? { authorization: 'Bearer ' + process.env.POLLINATIONS_TOKEN } : {};

  /* 熔断：免费通道一挂就是整段挂（实测连发 10 次全 402），
     在这种状态下继续每步重试只是白等。记住 90 秒，期间直接告诉调用方换路。 */
  if (!process.env.POLLINATIONS_TOKEN && DOWN_UNTIL > Date.now()) {
    return { ok: false, error: '免费生图通道当前排队已满', rateLimited: true, skipped: true };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const left = deadline - Date.now();
    if (left < 6000) break;
    /* 每次换一个 seed：同一个 URL 撞限流时，换 seed 至少能吃到不同的边缘节点 */
    const u = attempt === 0 ? url : url.replace(/seed=\d+/, `seed=${seed + attempt * 7919}`);
    const r = await grabBinary(u, { timeout: Math.min(20000, left), maxBytes: 8 * 1024 * 1024, headers: auth });
    if (r.ok && r.buf && r.buf.length > 5000) {
      DOWN_UNTIL = 0;
      return { ok: true, buf: r.buf, contentType: r.contentType, url: r.url };
    }
    const errText = r.buf && r.buf.length < 1000 ? r.buf.toString('utf8') : (r.error || '');
    const isRateLimit = /FREE_LIMIT|429|402|503/.test(errText) || /对方返回 (429|402|503)/.test(r.error || '');
    if (isRateLimit) {
      /* 限流是「整段时间」的属性，不是「这一次」的属性：不再等 6 秒空转，立刻记熔断 */
      if (!process.env.POLLINATIONS_TOKEN) DOWN_UNTIL = Date.now() + 90000;
      if (attempt === 0) continue;              // 再给一次机会，换 seed 试
      return { ok: false, error: '免费生图通道排队已满（上游 402/503）', rateLimited: true };
    }
    if (attempt === 0 && /超时|失败/.test(r.error || '')) continue;  // 网络抖动，换一次
    return { ok: false, error: r.error || (errText.slice(0, 120)), rateLimited: false };
  }
  return { ok: false, error: '图片通道排队，没能在预算内出图', rateLimited: true };
}

/* 免费通道熔断时间点：挂过一次后这段时间内不再浪费员工的时间 */
let DOWN_UNTIL = 0;
export function imageChannelDown() {
  return !process.env.POLLINATIONS_TOKEN && DOWN_UNTIL > Date.now();
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/' };
export function decodeEntities(s) {
  return String(s)
    .replace(/&([a-zA-Z#0-9x]+);/g, (m, k) => (ENT[k] !== undefined ? ENT[k] : ENT[decodeURIComponentSafe(k)] !== undefined ? ENT[decodeURIComponentSafe(k)] : m))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** HTML → 纯文本。不追求完美，只要正文读得懂、导航与脚本别混进来 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|dd|dt)>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, ' | ');
  s = s.replace(/<li[^>]*>/gi, '\n· ');
  s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .join('\n');
}

/** 取页面标题 */
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ''));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** 必应有时把真实地址包在 /ck/a?...&u=a1<base64url> 里 */
function unwrapBing(href) {
  try {
    const u = new URL(href, 'https://www.bing.com');
    if (!u.hostname.endsWith('bing.com') || !u.pathname.startsWith('/ck/')) return href;
    const raw = u.searchParams.get('u') || '';
    if (!raw.startsWith('a1')) return href;
    const b64 = raw.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const out = Buffer.from(b64, 'base64').toString('utf8');
    return /^https?:\/\//.test(out) ? out : href;
  } catch { return href; }
}

function stripTags(s) {
  const t = decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  /* 「客服 外包」这种被标签切碎的中文，把中间的空格收掉 */
  return t.replace(/([\u4e00-\u9fa5]) (?=[\u4e00-\u9fa5])/g, '$1');
}

/* ── 搜索源 ──
 * 实测结论（2026-10）：
 *   百度 / 搜狗 / 360 都按 IP 识别爬虫，云主机出口一律吃「安全验证」页 —— 本地能跑，线上不能。
 *   神马（m.sm.cn）和夸克（quark.sm.cn）服务端渲染、云 IP 可用、中文相关性最好，作主源。
 *   必应只留 RSS 兜底：它对无 cookie 请求会给泛化结果，直连 HTML 不能用。
 */
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/* 神马 / 夸克同一套前端框架（qk-*） */
function pickQk(seg) {
  const a = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*class="[^"]*qk-link-wrapper/i.exec(seg)
    || /class="[^"]*qk-link-wrapper[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i.exec(seg);
  const t = /class="qk-title-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(seg);
  if (!a || !t) return null;
  const title = stripTags(t[1]);
  if (!title || title.length < 2) return null;
  const d = /class="qk-(?:abstract|summary|desc|text-desc)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(seg);
  let digest = d ? stripTags(d[1]) : '';
  if (digest.length < 12) digest = '';
  return { url: a[1], title, digest };
}

function pickH3(seg) {
  const m = /<h3[^>]*>[\s\S]{0,600}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(seg);
  if (!m) return null;
  const title = stripTags(m[2]).replace(/\s+/g, ' ');
  if (!title || title.length < 2) return null;
  return { url: decodeEntities(m[1]).trim(), title, digest: '' };
}

/**
 * 搜狗移动版（m.sogou.com/web/searchList.jsp）。
 * 实测（2026-10-30）云端可用、不被风控，且中文相关性是这批免费源里最好的。
 * 结果不是干净的 DOM 块，而是 SSR 塞进页面的 JSON：{"content":"标题","datetime":"日期", ... ,"url":"..."}。
 * 所以按「标题 + 日期」定位，再往后找同一条的链接与摘要。
 */
function parseSogouM(html, limit) {
  const t = String(html);
  const heads = [...t.matchAll(/\{"content":"((?:[^"\\]|\\.){4,160})","datetime":"([^"]{0,24})"/g)];
  const boxes = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index;
    const end = i + 1 < heads.length ? heads[i + 1].index : Math.min(t.length, start + 6000);
    boxes.push({ title: heads[i][1], date: heads[i][2], seg: t.slice(start, end) });
  }
  const digests = [...t.matchAll(/class="[^"]*click-sugg-content[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map(m => stripTags(m[1]));

  const out = [];
  for (const b of boxes) {
    const title = stripTags(safeJsonStr(b.title));
    if (!title || title.length < 2) continue;
    if (/^(大家还在搜|相关搜索|热门推荐|查看更多)/.test(title)) continue;
    /* 搜狗一条结果里会同时塞「真链」和几种埋点跳转链（mp.weixin.qq.com/count、
       qb://、sogou 自己的中转），埋点链打开是 404，所以先在块内把所有链接捞出来再挑。 */
    const cands = [...b.seg.matchAll(/"(?:url|inner_url|contenturl|link|docurl|src)":"((?:[^"\\]|\\.){10,400})"/g)]
      .map(m => safeJsonStr(m[1]))
      .map(x => (x.startsWith('//') ? 'https:' + x : x))
      .map(x => x.replace(/&amp;/g, '&'))
      .filter(x => /^https?:\/\//.test(x))
      .filter(x => !/mp\.weixin\.qq\.com\/count\//i.test(x))
      .filter(x => !/(^|\/\/)([^/]*\.)?(sogou|sm)\.(com|cn)\//i.test(x));
    const href = cands[0] || '';
    if (!href) continue;
    const digest = (digests[out.length] || '').slice(0, 240);
    if (out.some(x => x.url === href || x.title === title)) continue;
    out.push({ title: title.slice(0, 120), url: href, digest, date: b.date || '', from: '搜狗' });
    if (out.length >= limit) break;
  }
  return out;
}

/** SSR JSON 里的字符串（\\\\/ 和 \\" 都要还原） */
function safeJsonStr(raw) {
  try { return JSON.parse('"' + String(raw) + '"'); } catch { return String(raw).replace(/\\\//g, '/').replace(/\\"/g, '"'); }
}

const ENGINES = [
  {
    name: '搜狗', mobile: true, custom: parseSogouM,
    url: q => 'https://m.sogou.com/web/searchList.jsp?keyword=' + encodeURIComponent(q)
  },
  {
    name: '神马', mobile: true,
    url: q => 'https://m.sm.cn/s?q=' + encodeURIComponent(q),
    split: /<div[^>]*class="qk-card/, pick: pickQk
  },
  {
    name: '夸克', mobile: true,
    url: q => 'https://quark.sm.cn/s?q=' + encodeURIComponent(q),
    split: /<div[^>]*class="qk-card/, pick: pickQk
  },
  {
    name: '百度', mobile: false,
    url: q => 'https://www.baidu.com/s?wd=' + encodeURIComponent(q),
    split: /<div[^>]*class="result[^"]*"/, pick: pickH3
  },
  {
    name: '搜狗', mobile: false,
    url: q => 'https://www.sogou.com/web?query=' + encodeURIComponent(q),
    split: /<div[^>]*class="vrwrap"/, pick: pickH3,
    fix: h => (h.startsWith('/') ? 'https://www.sogou.com' + h : h)
  },
  {
    name: '360', mobile: false,
    url: q => 'https://www.so.com/s?q=' + encodeURIComponent(q),
    split: /<li[^>]*class="res-list/, pick: pickH3
  }
];

function digestOf(seg) {
  let s = String(seg).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  /* 分块时把外层 <div class="... 切掉了，这里先跳过标签残余，别把 class 串当正文 */
  const gt = s.indexOf('>');
  if (gt >= 0 && s.slice(0, gt).includes('=')) s = s.slice(gt + 1);
  const i = s.indexOf('</h3>');
  if (i > 0) s = s.slice(i + 5);
  const t = stripTags(s)
    .replace(/百度快照|网页快照|百度图片|查看更多|展开全部|广告|收藏|来源[:：]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/qk-|class=|display:flex|href=/.test(t.slice(0, 60))) return '';
  return t.slice(0, 240);
}

function parseEngine(html, engine, limit) {
  if (engine.custom) {
    try { return engine.custom(html, limit) || []; } catch { return []; }
  }
  const blocks = String(html).split(engine.split).slice(1);
  const out = [];
  for (const b of blocks) {
    const seg = b.slice(0, 24000);
    const got = engine.pick(seg);
    if (!got) continue;
    let href = engine.fix ? engine.fix(got.url) : got.url;
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//.test(href)) continue;
    /* 别把「搜索结果页」本身、站内推荐位当结果 */
    if (/^https?:\/\/[^/]*(so\.com|baidu\.com|sogou\.com|sm\.cn|quark\.sm\.cn)\/.*\?(q|wd|query|keyword)=/i.test(href)) continue;
    if (/^https?:\/\/([^/]*\.)?(sm\.cn|quark\.sm\.cn)\/s\?/i.test(href)) continue;
    if (/^(其他人还搜了|相关搜索|查看更多|大家都在搜|热门推荐)/.test(title)) continue;
    /* 百度推广位（baidu.php）是广告，不是结果 */
    if (/baidu\.com\/baidu\.php|\/baidu\.php\?/i.test(href)) continue;
    const title = got.title.replace(/\s+/g, ' ').slice(0, 120);
    if (out.some(x => x.url === href || x.title === title)) continue;
    out.push({ title, url: href, digest: got.digest || digestOf(seg), from: engine.name });
    if (out.length >= limit) break;
  }
  return out;
}

/* ── 相关性 ──
 * 过滤掉「搜瓦楞纸箱价格，第一条是 2026年_百度百科」这类噪音。
 * 做法是看关键词（含中文 bigram）在标题+摘要里的覆盖率。 */
const STOP = /^(的|了|和|与|及|或|多少|多少钱|怎么|如何|什么|哪些|哪个|请问|一个|几个|现在|目前|最新|\d{4}|\d{4}年|元|个|只|件|元\/个|元\/只)$/;

export function keywordsOf(q) {
  const raw = String(q || '').split(/[\s,，、;；.。?？!！]+/).filter(Boolean);
  let out = raw.filter(w => w.length >= 2 && !STOP.test(w));
  const flat = raw.join('').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  if (out.length < 2 && flat.length >= 4) {
    const bi = [];
    for (let i = 0; i + 2 <= flat.length && bi.length < 10; i++) {
      const g = flat.slice(i, i + 2);
      if (!STOP.test(g)) bi.push(g);
    }
    out = out.concat(bi);
  }
  return [...new Set(out)].slice(0, 12);
}

/* 价格/规模/标准这类查询，摘要里没数字基本是废话；百科类页面在问「多少钱」时也没用 */
const NUM_HINT = /价格|多少钱|成本|费用|报价|工资|标准|规模|增长|占比|单价|收费|补贴|税率/;
const NOISE_TITLE = /百科|百度知道|词典|汉语|拼音/;

function relScore(item, keys, wantNum) {
  if (!keys.length) return 1;
  const hay = (item.title + ' ' + (item.digest || '')).toLowerCase();
  let s = keys.filter(k => hay.includes(k.toLowerCase())).length / keys.length;
  if (wantNum) {
    if (/\d/.test(item.digest || '')) s += 0.15;
    if (NOISE_TITLE.test(item.title)) s -= 0.12;
  }
  return s;
}

/** 必应 RSS：结构最稳，作为最后兜底（但中文相关性一般） */
/**
 * 必应的 cookie 预热。
 * 实测（2026-10-30）：不带 cookie 时必应返回的是一批「和查询无关的通用结果」，
 * 同一个查询换三遍说法，结果一模一样 —— 那不是相关性差，是根本没检索。
 * 先访问一次首页拿到 MUID / _EDGE_S 再搜，结果立刻变成真的。
 * cookie 缓存 10 分钟，不要每次搜索都去握手。
 */
let BING_CK = { at: 0, ck: '' };
async function bingCookie() {
  if (BING_CK.ck && Date.now() - BING_CK.at < 10 * 60 * 1000) return BING_CK.ck;
  try {
    const r = await fetch('https://www.bing.com/?mkt=zh-CN&setlang=zh-CN', {
      headers: { 'user-agent': UA, accept: 'text/html' },
      signal: AbortSignal.timeout(10000)
    });
    const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
    const ck = list.map(x => String(x).split(';')[0]).join('; ');
    if (ck) BING_CK = { at: Date.now(), ck };
    return ck;
  } catch { return BING_CK.ck || ''; }
}

/** 必应真实结果页（带 cookie）。解析 b_algo 块：标题 / 链接 / 摘要 */
async function bingHtml(q, limit) {
  const ck = await bingCookie();
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&mkt=zh-CN&setlang=zh-CN&count=' + Math.min(limit + 4, 20);
  const r = await grab(url, { timeout: 16000, headers: ck ? { cookie: ck } : {} });
  if (!r.ok) return [];
  const blocks = String(r.html).split(/<li class="b_algo"/).slice(1);
  const out = [];
  for (const b of blocks) {
    const seg = b.slice(0, 12000);
    const a = /<h2[^>]*>[\s\S]{0,400}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(seg);
    if (!a) continue;
    const href = unwrapBing(decodeEntities(a[1]));
    const title = stripTags(a[2]);
    if (!/^https?:\/\//.test(href) || !title) continue;
    const pm = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(seg) || /class="b_(?:lineclamp|caption|snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i.exec(seg);
    const digest = pm ? stripTags(pm[1]).slice(0, 260) : '';
    if (out.some(x => x.url === href)) continue;
    out.push({ title: title.slice(0, 120), url: href, digest, from: '必应' });
    if (out.length >= limit) break;
  }
  return out;
}

/** 抓一个源；主源失败再试一次（免费搜索源偶发超时，不值得直接放弃） */
async function fromEngine(e, q, limit, retry) {
  let lastErr = '';
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const r = await grab(e.url(q), {
        timeout: 20000,
        headers: e.mobile ? { 'user-agent': MOBILE_UA } : {}
      });
      if (!r.ok) { lastErr = r.error; continue; }
      const list = parseEngine(r.html, e, limit);
      if (list.length >= 2) return { list };
      lastErr = `只解析到 ${list.length} 条`;
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { list: [], err: lastErr };
}

/* 把口语长句压成检索词：去提问句、去年份、去量词，留下实体 */
const ASK_WORDS = /(多少钱|怎么样|怎么|如何|什么|哪些|哪个|请问|是否|能不能|可不可以|一般|大概|大约|左右|一个|一家|一次|我想知道|想知道|了解|看看|帮我|查一下|搜一下)/g;

export function shortenQuery(q) {
  let s = String(q || '').replace(ASK_WORDS, ' ');
  s = s.replace(/\b20\d{2}\s*年?/g, ' ');
  s = s.replace(/[，。、？！,.?!；;：:（）()【】\[\]"']/g, ' ');
  const words = s.split(/\s+/).filter(w => w.length >= 2 || /^[a-zA-Z]{2,}$/.test(w));
  const out = [...new Set(words)].slice(0, 6).join(' ');
  return out.length >= 4 && out !== q.trim() ? out : '';
}

/**
 * 搜索：神马 → 夸克 → 百度 → 搜狗 → 360 → 必应 RSS。
 * 谁能给出「够多且够相关」的结果就用谁；主源重试一次，兜底只走必应。
 */
export async function webSearch(query, limit = 8) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '搜索词是空的' };
  const n = Math.max(1, Math.min(limit, 10));
  const keys = keywordsOf(q);
  const wantNum = NUM_HINT.test(q);
  const tried = [];

  const short = shortenQuery(q);

  for (let i = 0; i < ENGINES.length; i++) {
    const e = ENGINES[i];
    const first = await fromEngine(e, q, n * 3, i < 2 ? 1 : 0);
    let list = first.list;
    let err = first.err;

    /* 长查询（带年份、带一串限定词）在中文引擎上常常一条都解析不出来：
       先按原词搜，拿不到就用剥掉提问词的短查询再搜一次。 */
    if (list.length < 2 && short) {
      const again = await fromEngine(e, short, n * 3, 0);
      if (again.list.length > list.length) {
        const seen = new Set(list.map(x => x.url));
        list = list.concat(again.list.filter(x => !seen.has(x.url)));
        err = again.err;
      }
    }
    if (!list.length) { tried.push(`${e.name}:${err || '没有结果'}`); continue; }

    const strict = list.filter(x => relScore(x, keys, wantNum) >= 0.5);
    const loose = list.filter(x => relScore(x, keys, wantNum) >= 0.25);
    const pick = strict.length >= 2 ? strict : loose.length >= 2 ? loose : list;
    const results = pick.slice(0, n);
    if (results.length >= 2) {
      return { ok: true, results, engine: e.name, dropped: list.length - pick.length, weak: strict.length < 2 };
    }
    tried.push(`${e.name}:可用结果不足`);
  }

  try {
    let list = await bingHtml(q, n);
    let strict = list.filter(x => relScore(x, keys, wantNum) >= 0.35);

    /* 必应中文对「口语长句 + 年份」这种查询会把主体词丢掉：
       「2026 家用机器人 市场规模」→ 全是 2026 年放假通知。
       这时把提问词、年份、量词剥掉重搜一次，效果立刻不一样。 */
    if (strict.length < 2 && short && short !== q) {
      const again = await bingHtml(short, n);
      const seen = new Set(list.map(x => x.url));
      list = list.concat(again.filter(x => !seen.has(x.url)));
      strict = list.filter(x => relScore(x, keys, wantNum) >= 0.35);
      if (strict.length >= 2) tried.push(`必应(改用「${short}」)`);
    }

    /* 别按抓取顺序交付：先按相关性排，弱结果沉底，前端一眼能看出哪条是凑数的 */
    const ranked = list.slice().sort((a, b) => relScore(b, keys, wantNum) - relScore(a, keys, wantNum));
    const use = strict.length >= 2 ? strict : ranked;
    if (use.length) {
      return {
        ok: true, results: use.slice(0, n), engine: '必应',
        dropped: list.length - use.length,
        weak: strict.length < 2
      };
    }
    tried.push('必应:没有结果');
  } catch (e) {
    tried.push('必应:' + e.message);
  }

  return { ok: false, error: `所有搜索源都没给结果（${tried.join('；')}）。换个更短、更口语的说法再试。` };
}

/* 正文清洗：压掉成串的项目符号行、重复空行（微信/资讯页常见） */
function tidyText(t) {
  return String(t || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => !/^[·•\-\u2022\s]+$/.test(l))
    .filter(l => l.length > 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 抓一个网页的正文 */
export async function fetchPage(url, maxChars = 12000) {
  let cur = String(url || '');
  let r = await grab(cur, { timeout: 18000, headers: refererHeaders(cur) });

  /* 搜索引擎的跳转链接常常是一个「JS 跳转页」：抓下来只有一行 location.replace。
     这种页面正文是空的，要继续跟一层。 */
  for (let hop = 0; hop < 2 && r.ok; hop++) {
    if (htmlToText(r.html).length >= 80) break;
    const next = scriptRedirect(r.html);
    if (!next) break;
    cur = next;
    r = await grab(cur, { timeout: 18000, headers: refererHeaders(cur) });
  }

  if (!r.ok) return { ok: false, error: r.error, url: r.url };
  const html = r.html;
  if (/\.(pdf|docx?|xlsx?|pptx?)(\?|$)/i.test(r.url)) {
    return { ok: false, error: '这是一个文件（PDF / Office），不能当网页读。把文件传给我，我用 read_doc 解析。' };
  }
  /* 微信公众号文章：正文全在 id="js_content" 里，整页提取只会捞到导航和一堆「·」 */
  let body = html;
  const jc = html.search(/id=["']js_content["']/i);
  if (jc > 0) {
    /* 从那个 div 的内容开始切，别把半个标签留在正文里 */
    const gt = html.indexOf('>', jc);
    body = html.slice(gt > 0 ? gt + 1 : jc, jc + 300000);
  }

  const text = tidyText(htmlToText(body));
  /* 微信文章的 <title> 是空的，退到 h1 */
  const title = pageTitle(html) || stripTags((/<h1[^>]*>([\s\S]{0,120}?)<\/h1>/i.exec(html) || [])[1] || '');
  if (text.length < 80) {
    return { ok: false, error: '这个页面几乎没有正文（可能是动态渲染、需要登录，或者是纯 JS 站点）', url: r.url };
  }
  return { ok: true, title, url: r.url, text: text.slice(0, maxChars), truncated: text.length > maxChars, total: text.length };
}

/* 给搜索引擎的跳转链接带上来源，否则对方直接回一个空壳 */
function refererHeaders(url) {
  try {
    const h = new URL(url).hostname;
    if (/sogou\.com$/i.test(h)) return { referer: 'https://www.sogou.com/' };
    if (/baidu\.com$/i.test(h)) return { referer: 'https://www.baidu.com/' };
    if (/so\.com$/i.test(h)) return { referer: 'https://www.so.com/' };
  } catch { /* ignore */ }
  return {};
}

/* 从跳转页里挖出下一站：location.replace(...) / meta refresh / URL= */
export function scriptRedirect(html) {
  const s = String(html || '');
  const pats = [
    /location\.(?:replace|assign)\(\s*["']([^"']+)["']/i,
    /location\.href\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i,
    /\bURL\s*=\s*([^"'>\s]+)/i
  ];
  for (const p of pats) {
    const m = p.exec(s);
    if (m && m[1] && /^https?:\/\//i.test(m[1])) return decodeEntities(m[1]);
  }
  return '';
}
