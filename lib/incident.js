// 标准报错：把「又报错了」变成一条能归组、能分诊、能复核的记录。
//
// 为什么不塞进 audit：
//   audit 回答「谁做了什么」，所以按账号分目录——查的是某个人。
//   incident 回答「哪个 bug 犯了几次」，必须跨账号聚合——同一个 bug 在 4 个账号
//   下各报一次，是 1 个工单，不是 4 个。所以这里按天分片，scope 只当一个字段。
//   混在一起的话，归组就得先扫全目录再拆，而且审计的保留期（30 天）和
//   问题单的保留期根本不是一回事。
//
// 三条设计约束，都来自踩过的坑：
//   1. 签名必须稳定。带行号的签名改一行代码就断，历史工单全变成新的。
//      所以签名只取「错误码 + 路由 + 出错函数」，行号留在 record 里给人看。
//   2. 上报本身不许抛。一个会在错误路径上抛异常的错误上报，等于把一次故障
//      变成两次。
//   3. 必须限流。渲染循环里出的错能一秒报上千条，把磁盘写满之前先把自己掐掉。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DIR = process.env.INCIDENT_DIR
  ? path.resolve(process.env.INCIDENT_DIR)
  : path.join(ROOT, 'data', 'incidents');

try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 不可写就静默降级 */ }

/* 保留期跟审计一致（30 天）。0 表示明确不清理——这个区别很重要：
   没设和设成 0 在运维眼里是两件事，前者是「没想过」，后者是「想过了，别删」。 */
const KEEP_DAYS = (() => {
  const n = Number(process.env.INCIDENT_KEEP_DAYS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
})();

/* ── 错误码表 ──
   owner 是分诊的**第一层判断**，不是结论：
     self     = ren agent 自己大概率能修（界面、工具实现、参数校验）
     external = 外部依赖或配置（网关、额度、网络），改自己代码没用
     either   = 要看具体样本才能定
   为什么把 owner 写进码表而不是留给模型每次现判：
   一张固定的表可以被讨论、被修正；每次现判会飘——同一个错今天说 self 明天说
   external，你就没法统计「它判断得准不准」了。 */
export const CODES = {
  E_LLM_GATE:    { zh: '模型通道被安全网关拦下', owner: 'external' },
  E_LLM_QUOTA:   { zh: '模型额度或权限不足',     owner: 'external' },
  E_LLM_TIMEOUT: { zh: '模型响应超时',           owner: 'external' },
  E_LLM_EMPTY:   { zh: '模型返回空内容',         owner: 'either'   },
  E_LLM_BAD:     { zh: '模型返回无法解析的结构', owner: 'either'   },
  E_TOOL_FAIL:   { zh: '工具执行失败',           owner: 'self'     },
  E_TOOL_DENY:   { zh: '工具调用被权限拦截',     owner: 'either'   },
  E_TOOL_ARGS:   { zh: '工具参数不合法',         owner: 'self'     },
  E_NET:         { zh: '网络请求失败',           owner: 'external' },
  E_HTTP_5XX:    { zh: '服务端 5xx',             owner: 'self'     },
  E_HTTP_4XX:    { zh: '服务端 4xx',             owner: 'either'   },
  E_UI_RENDER:   { zh: '界面渲染异常',           owner: 'self'     },
  E_STATE:       { zh: '状态库读写失败',         owner: 'either'   },
  E_PROCESS:     { zh: '进程级异常（未捕获）',   owner: 'self'     },
  E_AUTH:        { zh: '身份校验失败',           owner: 'either'   },
  E_UNKNOWN:     { zh: '未归类',                 owner: 'either'   }
};

export const OWNERS = ['self', 'external', 'either'];

/* ── 归一化与脱敏 ──
   两件事分开：
     normMsg / signature  只求「同错同签」，所以把一切可变的都抹掉（含数字）。
     scrubText            只求「能看又不漏」，保留可读性，只抹账号、路径用户名、文件名。 */
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_SCOPE = /\b[a-f0-9]{32}\b/g;
const RE_HEX8 = /\b[0-9a-f]{8,}\b/gi;
const RE_TS = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g;
/* 只抹「用户产出的成品文件」，不抹源码和配置。
   为什么这么窄：把 .md/.json/.js 也抹掉，栈里的 `tools.js`、`package.json`
   全变成 `*.js`、`*.json`，定位能力直接没了——而这些都出现在 message 里，
   恰恰是排查时最该看的东西。
   为什么不能带空格：`([\w\u4e00-\u9fa5 ]+)\.xlsx` 会把「打不开 报价单-2026Q4」
   整串当成文件名，把「打不开」也一起吃掉，消息就剩个 `*.xlsx`。 */
const RE_FILE = /([^\s\\/:*?"<>|]+)\.(xlsx|xls|docx|doc|pptx|ppt|pdf|png|jpe?g|gif|webp|csv|tsv|zip)\b/gi;

const clip = (s, n) => {
  const t = s == null ? '' : String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/* 给「同错同签」用的归一化：数字一律抹平（行号、端口、计数都会变）。
   带扩展名的 token 也折成 <f>：`读 /a.json 失败` 和 `读 /b.json 失败` 是同一个
   毛病犯了两次，不该算两张工单——而 E_UNKNOWN 的签名正好靠这段归一化后的哈希。 */
export function normMsg(s) {
  return String(s == null ? '' : s)
    .replace(RE_UUID, '<id>')
    .replace(RE_SCOPE, '<scope>')
    .replace(RE_TS, '<ts>')
    .replace(RE_HEX8, '<hex>')
    .replace(/[^\s"'`,;:()（）]*\.[A-Za-z0-9]{1,6}\b/g, '<f>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/* 给「人看」用的脱敏：留下结构，抹掉账号、家目录用户名、文件主体名。
   文件名只留扩展名——`.xlsx` 说的是「哪类文件出问题」，而「报价单-2026Q4」说的是
   用户的业务内容。定位用前者够了，后者属于不该躺在日志里的东西。 */
export function scrubText(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(RE_UUID, '<id>')
       .replace(RE_SCOPE, '<scope>')
       .replace(RE_TS, '<ts>')
       .replace(RE_HEX8, '<hex>');
  t = t.replace(/\/Users\/[^/\s"'`]+/g, '~').replace(/\/home\/[^/\s"'`]+/g, '~');
  t = t.replace(RE_FILE, '*.$2');
  return t;
}

function cleanPart(s) {
  return String(s == null ? '' : s)
    .replace(/[|\n\r\t]/g, ' ')
    .trim()
    .slice(0, 64) || '-';
}

/* 签名：错误码 | 路由 | 出错函数。
   刻意不含行号、不含时间、不含账号——这三样一变，历史就断了。
   E_UNKNOWN 额外挂一段归一化消息的短哈希，否则所有未归类的错会并成一张工单。 */
export function signature({ code, route, where, msg } = {}) {
  const c = CODES[code] ? code : 'E_UNKNOWN';
  let sig = `${c}|${cleanPart(route)}|${cleanPart(where)}`;
  if (c === 'E_UNKNOWN') {
    sig += '|' + crypto.createHash('sha1').update(normMsg(msg)).digest('hex').slice(0, 8);
  }
  return sig;
}

/* ── 限流 ──
   两级：单签名每分钟 N 条、全进程每分钟 M 条。被压掉的条数不丢——
   记在「本窗口内下一条被记录的」记录里当 drop，否则「报了一次」和
   「报了一万次」在表上长得一模一样，而这恰恰是最该看出来的差别。 */
const LIMIT_PER_SIG = (() => {
  const n = Number(process.env.INCIDENT_LIMIT_PER_SIG);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
})();
const LIMIT_TOTAL = (() => {
  const n = Number(process.env.INCIDENT_LIMIT_TOTAL);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
})();
const WIN_MS = 60_000;

const sigWin = new Map();     // sig -> { n, t, drop }
let totWin = { n: 0, t: 0 };

/* 被压掉的次数要跨窗口传下去。
   第一版里 drop 是「窗口内计数器」，窗口一翻就归零——于是「这个错被压了 700 次」
   永远读不出来，表上看起来和「只报了一次」一模一样。而「报了 1 次」和
   「报了 700 次」正是这张表最该区分的东西。 */
function takeSlot(sig, now) {
  if (!totWin.t || now - totWin.t >= WIN_MS) totWin = { n: 0, t: now };
  let w = sigWin.get(sig);
  if (!w) w = { n: 0, t: now, drop: 0 };
  else if (now - w.t >= WIN_MS) w = { n: 0, t: now, drop: w.drop };
  if (w.n >= LIMIT_PER_SIG || totWin.n >= LIMIT_TOTAL) {
    w.drop += 1;
    sigWin.set(sig, w);
    return { ok: false };
  }
  w.n += 1;
  totWin.n += 1;
  const drop = w.drop;
  w.drop = 0;
  sigWin.set(sig, w);
  return { ok: true, drop };
}

/* 窗口太多时清一轮，别让 Map 无限长。只在超过 500 个签名时做，
   代价可以忽略，但少了这句，一个会变签名的错就能把内存慢慢吃掉。 */
function maybeSweepWindows(now) {
  if (sigWin.size <= 500) return;
  for (const [k, v] of sigWin) {
    if (!v.t || now - v.t >= WIN_MS * 5) sigWin.delete(k);
  }
}

function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function localStamp(d) {
  return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ── 上报 ──
   entry 里的字段全部可选，什么都没有也能落一条 E_UNKNOWN——
   「报了个空」本身也是信息，比丢掉强。
   now 是可注入的时钟：限流的窗口行为（跨窗口才把 drop 交出去）没法靠等 60 秒来测。 */
export function report(entry = {}, now = Date.now()) {
  try {
    const d = new Date(now);
    const code = CODES[entry.code] ? entry.code : 'E_UNKNOWN';
    const sig = entry.sig || signature({ ...entry, code });
    const slot = takeSlot(sig, now);
    if (!slot.ok) return null;
    maybeSweepWindows(now);

    const stack = Array.isArray(entry.stack)
      ? entry.stack.slice(0, 8).map(l => clip(scrubText(String(l)).trim(), 300)).filter(Boolean)
      : [];

    const rec = {
      id: crypto.randomUUID(),
      ts: d.toISOString(),
      at: localStamp(d),
      epochMs: now,
      sig,
      code,
      owner: CODES[code].owner,
      layer: entry.layer === 'server' ? 'server' : 'client',
      route: clip(cleanPart(entry.route), 120),
      where: clip(cleanPart(entry.where), 120),
      msg: clip(scrubText(entry.msg), 800),
      stack,
      v: clip(String(entry.v || ''), 32),
      commit: clip(String(entry.commit || ''), 40),
      scope: /^[a-f0-9]{32}$/.test(String(entry.scope || '')) ? entry.scope : '',
      ua: clip(String(entry.ua || ''), 200),
      extra: entry.extra && typeof entry.extra === 'object'
        ? JSON.parse(clip(JSON.stringify(entry.extra), 1200))
        : null
    };
    if (slot.drop) rec.drop = slot.drop;

    fs.appendFileSync(path.join(DIR, dayKey(d) + '.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
    return rec;
  } catch {
    /* 上报失败绝不能影响主流程：这是错误路径上的代码，它自己出错就是二次故障 */
    return null;
  }
}

/* ── 读取 ──
   扁平目录，按文件名（日期）倒序，够新的先读，读够 limit 就停。 */
function dayFiles() {
  let names = [];
  try { names = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)); } catch { return []; }
  return names.sort().reverse();
}

function dayMs(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

export function readIncidents({ from, to, limit = 2000 } = {}) {
  const fromMs = from ? Date.parse(from) : -Infinity;
  const toMs = to ? Date.parse(to) : Infinity;
  const max = Math.max(1, Math.min(Number(limit) || 2000, 20000));
  const out = [];
  for (const name of dayFiles()) {
    const ms = dayMs(name);
    if (ms == null) continue;
    if (ms > toMs) continue;
    /* 按天分片的好处：整片都在范围外就整片跳过，不用逐行 parse */
    if (ms + 86400e3 < fromMs) break;
    let txt = '';
    try { txt = fs.readFileSync(path.join(DIR, name), 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line) continue;
      let r = null;
      try { r = JSON.parse(line); } catch { continue; }
      const t = Number(r.epochMs) || Date.parse(r.ts) || 0;
      if (t < fromMs || t > toMs) continue;
      out.push(r);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/* ── 归组：这张表就是「工单列表」 ──
   排序按次数，不是按时间。「最常发生的」比「刚发生的」更该先修，
   因为前者是稳定复现的问题，后者可能只是一次抖动。 */
export function groupIncidents({ from, to, limit = 2000 } = {}) {
  const rows = readIncidents({ from, to, limit });
  const map = new Map();
  for (const r of rows) {
    const sig = r.sig || signature(r);
    let g = map.get(sig);
    if (!g) {
      g = {
        sig, code: r.code || 'E_UNKNOWN',
        zh: (CODES[r.code] || CODES.E_UNKNOWN).zh,
        owner: (CODES[r.code] || CODES.E_UNKNOWN).owner,
        n: 0, drop: 0, first: '', firstMs: 0, last: '', lastMs: 0,
        scopes: [], versions: [], routes: [], wheres: [],
        lastMsg: '', sample: null
      };
      map.set(sig, g);
    }
    g.n += 1;
    g.drop += Number(r.drop) || 0;
    const t = Number(r.epochMs) || Date.parse(r.ts) || 0;
    if (!g.firstMs || t < g.firstMs) { g.firstMs = t; g.first = r.at || r.ts || ''; }
    if (t >= g.lastMs) {
      g.lastMs = t; g.last = r.at || r.ts || '';
      g.lastMsg = r.msg || '';
      g.sample = r;
    }
    if (r.scope && g.scopes.length < 20 && !g.scopes.includes(r.scope)) g.scopes.push(r.scope);
    if (r.v && g.versions.length < 10 && !g.versions.includes(r.v)) g.versions.push(r.v);
    if (r.route && g.routes.length < 10 && !g.routes.includes(r.route)) g.routes.push(r.route);
    if (r.where && g.wheres.length < 10 && !g.wheres.includes(r.where)) g.wheres.push(r.where);
  }
  const groups = [...map.values()].sort((a, b) => (b.n + b.drop) - (a.n + a.drop) || b.lastMs - a.lastMs);
  return {
    total: rows.length,
    count: groups.length,
    groups: groups.slice(0, Math.max(1, Math.min(Number(limit) || 200, 500)))
  };
}

/* ── 现状 ──
   health 里要能回答「现在有没有在报错」，所以这里给的是「按天聚合的概览」，
   不是全量明细。 */
export function incidentStats(now = Date.now()) {
  const out = { dir: DIR, days: 0, files: 0, bytes: 0, total: 0, oldest: '', newest: '', keepDays: KEEP_DAYS, byCode: {} };
  const names = dayFiles();
  out.files = names.length;
  let oldest = 0, newest = 0;
  const days = new Set();
  for (const name of names) {
    const ms = dayMs(name);
    const full = path.join(DIR, name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* 忽略 */ }
    out.bytes += size;
    if (ms != null) {
      days.add(name.slice(0, 10));
      if (!oldest || ms < oldest) oldest = ms;
      if (ms > newest) newest = ms;
    }
  }
  out.days = days.size;
  out.oldest = oldest ? new Date(oldest).toISOString().slice(0, 10) : '';
  out.newest = newest ? new Date(newest).toISOString().slice(0, 10) : '';
  const recent = readIncidents({ from: new Date(now - 24 * 3600e3).toISOString(), limit: 20000 });
  out.total = recent.length;
  out.last24h = recent.length;
  for (const r of recent) {
    const c = r.code || 'E_UNKNOWN';
    out.byCode[c] = (out.byCode[c] || 0) + 1;
  }
  return out;
}

/* ── 清扫 ──
   只删形如 YYYY-MM-DD.jsonl 的分片，边界是「今天零点往前 keepDays 天」。
   和审计清扫同一个口径——两套日志如果保留期算法不一样，运维迟早会算错一次。 */
export function sweepIncidents({ keepDays = KEEP_DAYS, now = Date.now(), dryRun = false } = {}) {
  const res = { dryRun: !!dryRun, keepDays, deleted: 0, bytes: 0, kept: 0, files: [] };
  if (!keepDays || keepDays <= 0) return res;
  const d = new Date(now);
  const zero = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const cutoff = zero - keepDays * 86400e3;
  for (const name of dayFiles()) {
    const ms = dayMs(name);
    if (ms == null) continue;
    if (ms >= cutoff) { res.kept += 1; continue; }
    const full = path.join(DIR, name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* 忽略 */ }
    if (!dryRun) {
      try { fs.unlinkSync(full); } catch { continue; }
    }
    res.deleted += 1;
    res.bytes += size;
    res.files.push(name);
  }
  return res;
}

/* 当前窗口里还压着多少条没交出去。测试和 health 用得上：
   「有 700 条被限流丢掉」比「日志里只有 20 条」重要得多。 */
export function suppressed() {
  let n = 0;
  for (const w of sigWin.values()) n += w.drop || 0;
  return n;
}

export function resetLimits() {
  sigWin.clear();
  totWin = { n: 0, t: 0 };
}

export const __test = { dayKey, dayMs, dayFiles, DIR, KEEP_DAYS, LIMIT_PER_SIG, LIMIT_TOTAL, WIN_MS };
