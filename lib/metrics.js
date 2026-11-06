/* 请求级指标：QPS / 延迟分位 / 错误率
 *
 * 为什么要有这个文件
 *   在它之前，线上出问题的唯一证据是「老板截图」。health 里有配额、备份、长连接探针，
 *   但那些都是「资源状态」；「这几分钟到底有多少请求、慢在哪个端点、错了几次」
 *   一条都没有。于是每次排障都得先复现一遍——而线上问题是复现不出来的。
 *
 * 三条设计取舍
 *   ① 进程内、环形缓冲、不落盘。指标是「此刻怎么样」，不是「上个月怎么样」；
 *      要长期趋势应该接外部监控，这里做的只是让它**看得见**。
 *   ② 采样有上限。每个路由只留最近 N 条延迟样本，24 小时不间断跑也不会把内存吃掉——
 *      一个会自己撑爆的监控，比没有监控更糟。
 *   ③ 分位用「排序后取位」，不用近似算法。样本只有几百条，精确值算得动，
 *      而近似值在样本少的时候误差大到会误导判断。
 */

const MAX_SAMPLES = 400;      /* 每个路由保留的延迟样本数 */
const MAX_ROUTES = 120;       /* 路由种类上限，防止被随机路径打爆内存 */
const SLOW_MS = 1000;         /* 超过这个就算「慢请求」，单独留一份最近的 */

const routes = new Map();
const slow = [];
let started = Date.now();
let total = 0;
let totalErr = 0;

function bucket(route) {
  let b = routes.get(route);
  if (b) return b;
  /* 留一个位置给 __other__：满的那一刻不能再凭空加一条，
     否则「上限 120」其实是 121。 */
  if (routes.size >= MAX_ROUTES - 1) {
    b = routes.get('__other__');
    if (b) return b;
    b = { n: 0, err: 0, ms: [], max: 0, last: 0, bytes: 0, rt: [] };
    routes.set('__other__', b);
    return b;
  }
  b = { n: 0, err: 0, ms: [], max: 0, last: 0, bytes: 0, rt: [] };
  routes.set(route, b);
  return b;
}

/* 记录一次请求。route 用「去掉查询串的路径」——
   不把 query 算进 key，否则 /api/file?path=a 和 ?path=b 会变成两个路由。 */
export function record(route, ms, status, bytes = 0, now = Date.now()) {
  const key = String(route || '/');
  const b = bucket(key);
  const d = Number(ms) || 0;
  b.n++;
  total++;
  b.last = now;
  b.bytes += Number(bytes) || 0;
  if (status >= 400) { b.err++; totalErr++; }
  if (d > b.max) b.max = d;
  b.ms.push(d);
  if (b.ms.length > MAX_SAMPLES) b.ms.shift();
  /* 最近一分钟的时间戳：QPS 用它算，不另存计数器 */
  b.rt.push(now);
  while (b.rt.length && now - b.rt[0] > 60000) b.rt.shift();
  if (d >= SLOW_MS) {
    slow.push({ route: key, ms: Math.round(d), status, at: now });
    if (slow.length > 20) slow.shift();
  }
}

/* 排序后取位。q=0.95、n=100 → 第 95 个（从 1 数）。空样本返回 0。 */
function pct(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

export function summary({ limit = 12, now = Date.now() } = {}) {
  const out = {
    uptimeSec: Math.round((now - started) / 1000),
    total, errors: totalErr,
    errRate: total ? Math.round((totalErr / total) * 1000) / 10 : 0,
    routes: []
  };
  for (const [route, b] of routes) {
    const sorted = [...b.ms].sort((x, y) => x - y);
    const fresh = b.rt.filter(t => now - t <= 60000).length;
    out.routes.push({
      route,
      n: b.n,
      err: b.err,
      errRate: b.n ? Math.round((b.err / b.n) * 1000) / 10 : 0,
      qps1m: Math.round((fresh / 60) * 100) / 100,
      p50: Math.round(pct(sorted, 0.5)),
      p95: Math.round(pct(sorted, 0.95)),
      max: Math.round(b.max),
      lastAt: b.last ? new Date(b.last).toISOString() : ''
    });
  }
  /* 按请求量排，取前 N；剩下的折成一行总数——
     一个从来不看的端点不该挤掉真正在跑的端点。 */
  out.routes.sort((a, b) => b.n - a.n);
  if (out.routes.length > limit) {
    const rest = out.routes.slice(limit);
    out.routes = out.routes.slice(0, limit);
    out.rest = { routes: rest.length, n: rest.reduce((s, r) => s + r.n, 0) };
  }
  out.slow = slow.slice(-5).reverse().map(x => ({ ...x, at: new Date(x.at).toISOString() }));
  return out;
}

/* 一行摘要：给 health 用。运维扫一眼就知道「现在有没有在出事」。 */
export function line(now = Date.now()) {
  const s = summary({ limit: 1, now });
  const busiest = s.routes[0];
  return `${s.total} 次请求 / 错误 ${s.errRate}%`
    + (busiest ? ` / 最忙 ${busiest.route} ${busiest.n} 次 p95 ${busiest.p95}ms` : '');
}

export function reset() {
  routes.clear();
  slow.length = 0;
  started = Date.now();
  total = 0;
  totalErr = 0;
}

export const __test = { pct, MAX_SAMPLES, MAX_ROUTES };
