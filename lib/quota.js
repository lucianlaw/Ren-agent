/**
 * 账号级额度：token 与磁盘。
 *
 * 在此之前这两件事都是「没有上限」：
 *   · token 只有单任务的预算闸（settings.maxTokens），一个账号开十个任务就是十倍；
 *   · 磁盘只有单文件 24MB 的上传上限，但可以传二十次，也可以让模型一直写。
 * 单用户时这两个缺口都咬不到人，一旦真的多人用，第一个把机器吃满的人会让所有人的
 * 任务一起失败——而且失败得很随机（写一半没空间、模型调用被上游掐）。
 *
 * 这一层做两件事，都刻意做得「能算清、能解释」：
 *   1. 记账：token 按天/月累计，磁盘按账号目录实测体积；
 *   2. 熔断：超限就拒绝，而不是等系统自己崩。
 *
 * 三条设计取舍（都是被现实逼出来的）：
 *
 * ① token 计量优先用上游给的 usage，拿不到才估算，并且**分开记**。
 *    通道在流式模式下不一定回 usage 帧；把它当成一定有，结果是所有账号的用量
 *    恒为 0——「有配额」变成一句空话。所以：有 usage 记 exact，没有就按字符估
 *    （中文约 1 字 1 token，英文约 4 字符 1 token，混排取 2.5 字符 1 token）。
 *    估算值单独累计，report 里标 estimated，谁看都知道这个数不是账单。
 *
 * ② 磁盘只在**写入前**检查，不做事后追认。
 *    事后追认等于「先让你写爆，再告诉你超了」——那时候别人的任务已经失败了。
 *    但 shell 是例外：降权后的子进程想写什么我们拦不住（这是 OS 边界，不是代码边界），
 *    所以 run_shell 走「跑完实测 + 超限冻结」，冻结之后所有写入口一律拒绝，
 *    直到有人清理或提额。这个不对称必须写在代码里，否则下一个人会以为配额是硬的。
 *
 * ③ 配额与用量都落盘，不只在内存。
 *    进程重启（每次部署都会）不能让用量归零——否则「重启即重置」就是最好的绕限方法。
 *    写盘做成「内存累加 + 定时 flush + 退出时 flush」：每来一个 chunk 就写一次盘，
 *    会把磁盘 IO 变成模型调用的瓶颈。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCOPE_RE, scopeRoot } from './workspace.js';
import { writeAudit } from './audit.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 测试进程绝不写真实 data/。
   和 lib/config.js 同一个理由：任何一个起 server 的测试都会走到记账路径，
   写进真实目录就变成「测试跑一遍，线上额度少一截」这种查不出来的怪事。 */
const ENTRY = String(process.argv[1] || '');
if (!process.env.REN_USAGE_DIR && /[\\/]test[\\/][^\\/]+\.mjs$/.test(ENTRY)) {
  process.env.REN_USAGE_DIR = path.join(os.tmpdir(), 'ren-usage-test');
}

function pickDir() {
  const custom = String(process.env.REN_USAGE_DIR || '').trim();
  const dir = custom ? path.resolve(custom) : path.join(APP, 'data', 'usage');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    const t = path.join(os.tmpdir(), 'ren-usage');
    fs.mkdirSync(t, { recursive: true });
    return t;
  }
}

const DIR = pickDir();
const LIMITS_FILE = path.join(DIR, '_limits.json');

/* ── 默认额度 ──
   **这是安全网，不是账单。**
   原来写的是日 50 万 / 月 500 万，理由是「一次 12 步任务约 3–5 万 token」。
   那个估算早就过时了：真实的带图、带长上下文、多轮续跑的任务，一轮就能烧
   6–7 万，一个任务 30 万很常见。于是日额度变成「一个任务就把自己锁死」——
   老板会先看到「额度用完」，而不是账单。更糟的是这一层根本看不见（界面上
   只有单任务上限），改那个数字对它毫无影响。
   现在把默认拉到「够用一整天、又能在真发疯时拦住」：
     日 500 万 ≈ 十几个重任务；月 6000 万 ≈ 一天 200 万 × 30 天。
   真正的成本闸是积分（见 lib/points.js）；token 这层只负责别把机器吃满。
   想收紧就改环境变量，或在设置里改（/api/quota/limits）。 */
function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export const DEFAULTS = {
  tokenDaily: num(process.env.REN_TOKEN_DAILY, 5000000),
  tokenMonthly: num(process.env.REN_TOKEN_MONTHLY, 60000000),
  diskMb: num(process.env.REN_DISK_MB, 512)
};

/* 改额度时允许的上界。不设上界等于「额度可以调到无限」——
   那这个闸就只剩一句注释，真实发疯时拦不住任何人。 */
export const CEIL = {
  tokenDaily: 100000000,
  tokenMonthly: 1000000000,
  diskMb: 20480
};

/* ── 文件读写 ── */
function validScope(scope) {
  return SCOPE_RE.test(String(scope || ''));
}

function usageFile(scope) {
  return path.join(DIR, `${scope}.json`);
}

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 清不掉也不影响主流程 */ }
    return false;
  }
}

/* 按账号覆盖的额度。放一个文件而不是按账号拆，是因为这张表要能整体导出给运维看。
 *
 * **必须看文件时间戳。** 以前这里读完就一直用内存里的那份，理由是「只有本进程
 * 会写它」——但这句话不成立：备份恢复会把 _limits.json 整个换掉，命令行脚本
 * 也会写，多实例部署时另一台也在写。结果就是「明明改了额度，界面上还是旧的」，
 * 而且重启才恢复。stat 一次比读一次便宜得多，代价可以忽略。 */
let LIMITS = null;
let LIMITS_MTIME = -1;

function limitsMtime() {
  try { return fs.statSync(LIMITS_FILE).mtimeMs; } catch { return 0; }
}

function allLimits() {
  const mt = limitsMtime();
  if (LIMITS && mt === LIMITS_MTIME) return LIMITS;
  const j = readJson(LIMITS_FILE, {});
  LIMITS = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  LIMITS_MTIME = mt;
  return LIMITS;
}

export function limitsOf(scope) {
  const o = allLimits()[String(scope)] || {};
  return {
    tokenDaily: num(o.tokenDaily, DEFAULTS.tokenDaily),
    tokenMonthly: num(o.tokenMonthly, DEFAULTS.tokenMonthly),
    diskMb: num(o.diskMb, DEFAULTS.diskMb),
    diskBytes: Math.round(num(o.diskMb, DEFAULTS.diskMb) * 1024 * 1024)
  };
}

export function setLimits(scope, patch = {}) {
  if (!validScope(scope)) return { ok: false, error: '工作区标识不合法' };
  const all = allLimits();
  const cur = { ...(all[scope] || {}) };
  for (const k of ['tokenDaily', 'tokenMonthly', 'diskMb']) {
    if (patch[k] === undefined) continue;
    if (patch[k] === null) { delete cur[k]; continue; }
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `${k} 必须是正数` };
    if (n > CEIL[k]) {
      return { ok: false, error: `${k} 最大只能到 ${CEIL[k].toLocaleString('zh-CN')}（再大就等于没有闸了）` };
    }
    cur[k] = Math.round(n);
  }
  if (Object.keys(cur).length) all[scope] = cur;
  else delete all[scope];
  LIMITS = all;
  if (!writeJson(LIMITS_FILE, all)) return { ok: false, error: '额度表写不进磁盘' };
  /* 写完自己认一下新时间戳，否则下一次 allLimits() 会以为文件被外部改了、
     再读一遍（结果一样，但白读一次，也会让测试里的引用比较失效）。 */
  LIMITS_MTIME = limitsMtime();
  return { ok: true, limits: limitsOf(scope) };
}

export function allLimitOverrides() { return { ...allLimits() }; }

/* ── 时间口径 ──
   日额度按**本地时区**零点重置。用 UTC 的话，中国用户在早上 8 点会看到额度重置，
   而账单和直觉都是按自然日的，对不上就会被当成 bug 报上来。 */
function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function monthKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
function nextDayMs(now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return t.getTime();
}
function nextMonthMs(now = new Date()) {
  const t = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return t.getTime();
}

/* ── 内存态 ──
   rec 的结构固定下来，不要随手加字段：这个对象会被备份带走、被恢复脚本读回来。 */
const cache = new Map();      // scope → rec
const dirty = new Set();
let flushTimer = null;
const FLUSH_MS = 5000;

function blank(scope) {
  return {
    v: 1,
    scope,
    day: dayKey(),
    dayTokens: 0,
    month: monthKey(),
    monthTokens: 0,
    totalTokens: 0,
    exactTokens: 0,
    estTokens: 0,
    calls: 0,
    createdAt: new Date().toISOString(),
    lastAt: '',
    lastModel: '',
    /* 冻结：磁盘超限后的写保护。token 超限用「拒绝新任务」，不复用这个标志——
       两件事混一个标志会让「磁盘清理完了 token 还在超额」这种组合没法表达。 */
    frozen: false,
    frozenReason: '',
    frozenAt: '',
    /* 磁盘记账：只作为缓存，真值永远以实测为准（见 diskUsage） */
    diskBytes: 0,
    diskAt: 0
  };
}

function load(scope) {
  if (!validScope(scope)) return null;
  if (cache.has(scope)) return cache.get(scope);
  const raw = readJson(usageFile(scope), null);
  const rec = { ...blank(scope), ...(raw && typeof raw === 'object' ? raw : {}) };
  /* 跨天/跨月：读回来的瞬间就翻转，而不是等到下一次写入。
     否则「昨天用完了，今天第一次请求」会读到昨天的数而被拒。 */
  const d = dayKey();
  const m = monthKey();
  if (rec.day !== d) { rec.day = d; rec.dayTokens = 0; }
  if (rec.month !== m) { rec.month = m; rec.monthTokens = 0; }
  cache.set(scope, rec);
  return rec;
}

export function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  for (const scope of dirty) {
    const rec = cache.get(scope);
    if (!rec) continue;
    writeJson(usageFile(scope), rec);
  }
  dirty.clear();
}

function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
  /* unref：不让记账把进程钉住。测试进程要能自己退出。 */
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/* 退出前落盘。部署是 kill + 重启，SIGTERM 一定会有；不挂这个钩子，
   最后 5 秒的用量就会安静地消失。 */
let hooked = false;
function hookExit() {
  if (hooked) return;
  hooked = true;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    try {
      process.on(sig, () => { flush(); process.exit(0); });
    } catch { /* 某些环境不允许监听，忽略 */ }
  }
  process.on('exit', () => { flush(); });
}
hookExit();

/* ── token 记账 ── */
/**
 * @param {string} scope
 * @param {object} u  {total, prompt, completion, exact, model}
 *   exact=false 表示这是按字符估的，不是上游给的 usage
 * @returns {{consumed:number, day:object, month:object, exceeded:''|'day'|'month'}}
 */
export function recordTokens(scope, u = {}) {
  const rec = load(scope);
  if (!rec) return { consumed: 0, exceeded: '' };
  const n = Math.max(0, Math.round(Number(u.total) || 0));
  if (!n) return { consumed: 0, exceeded: '' };

  /* 跨天翻转也要在这里做一次：一个跑几个小时的任务可能横跨零点 */
  const d = dayKey();
  const m = monthKey();
  if (rec.day !== d) { rec.day = d; rec.dayTokens = 0; }
  if (rec.month !== m) { rec.month = m; rec.monthTokens = 0; }

  rec.dayTokens += n;
  rec.monthTokens += n;
  rec.totalTokens += n;
  if (u.exact) rec.exactTokens += n; else rec.estTokens += n;
  rec.calls += 1;
  rec.lastAt = new Date().toISOString();
  if (u.model) rec.lastModel = String(u.model).slice(0, 80);

  dirty.add(scope);
  schedule();

  const lim = limitsOf(scope);
  let exceeded = '';
  if (rec.dayTokens >= lim.tokenDaily) exceeded = 'day';
  else if (rec.monthTokens >= lim.tokenMonthly) exceeded = 'month';
  return { consumed: n, day: { used: rec.dayTokens, limit: lim.tokenDaily }, month: { used: rec.monthTokens, limit: lim.tokenMonthly }, exceeded };
}

/** 当前用量与剩余。调用方（前端 / health）只看这一个。 */
export function tokenStatus(scope) {
  const rec = load(scope);
  const lim = limitsOf(scope);
  if (!rec) return { ok: false, error: '工作区标识不合法', limit: lim };
  const now = Date.now();
  const remainingDay = Math.max(0, lim.tokenDaily - rec.dayTokens);
  const remainingMonth = Math.max(0, lim.tokenMonthly - rec.monthTokens);
  return {
    ok: true,
    day: { key: rec.day, used: rec.dayTokens, limit: lim.tokenDaily, remaining: remainingDay, resetAt: nextDayMs() },
    month: { key: rec.month, used: rec.monthTokens, limit: lim.tokenMonthly, remaining: remainingMonth, resetAt: nextMonthMs() },
    total: rec.totalTokens,
    exact: rec.exactTokens,
    estimated: rec.estTokens,
    /* 估算占比：这个数高就说明上游没回 usage，看着的用量是推的，不是账单 */
    estimatedRatio: rec.totalTokens ? Math.round((rec.estTokens / rec.totalTokens) * 100) / 100 : 0,
    calls: rec.calls,
    lastAt: rec.lastAt,
    lastModel: rec.lastModel,
    checkedAt: now
  };
}

/**
 * 发起任务前的闸门。
 * 返回 ok:false 时调用方应当直接拒（HTTP 402），并把 resetAt 一起给出去——
 * 「你超了」但不说什么时候恢复，用户唯一能做的就是反复重试。
 */
export function checkTokens(scope) {
  const s = tokenStatus(scope);
  if (!s.ok) return { ok: false, code: 'scope_bad', error: s.error };
  if (s.day.remaining <= 0) {
    return {
      ok: false, code: 'token_quota', where: 'day',
      /* 「额度」在这套系统里有两个完全不同的东西：单任务的 token 上限（设置里那个）
         和账号一天的总量（这里）。不加限定词，用户改完单任务上限还会撞在这里——
         上一版就是这么让他白改一次的。 */
      error: `今天的账号额度用完了（${s.day.used.toLocaleString('zh-CN')} / ${s.day.limit.toLocaleString('zh-CN')} token）。`
        + `这是账号一天的总量，不是「单任务上限」；在 设置 → 账号额度 里能调高，或者等 ${new Date(s.day.resetAt).toLocaleString('zh-CN')} 自动重置。`,
      fix: 'quota', status: s
    };
  }
  if (s.month.remaining <= 0) {
    return {
      ok: false, code: 'token_quota', where: 'month',
      error: `这个月的账号额度用完了（${s.month.used.toLocaleString('zh-CN')} / ${s.month.limit.toLocaleString('zh-CN')} token）。`
        + '在 设置 → 账号额度 里能调高月度上限，或者等下个月 1 日重置。',
      fix: 'quota', status: s
    };
  }
  return { ok: true, status: s };
}

/* ── 磁盘记账 ── */
function walkSize(root, { topN = 0 } = {}) {
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  const big = [];
  const stack = [root];
  let guard = 0;
  while (stack.length) {
    const d = stack.pop();
    if (++guard > 60000) break;      // 目录极深时放弃精确统计，别把请求挂死
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { dirs++; stack.push(p); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      bytes += st.size;
      files++;
      if (topN > 0) big.push({ path: p.slice(root.length + 1), size: st.size });
    }
  }
  if (topN > 0) {
    big.sort((a, b) => b.size - a.size);
    return { bytes, files, dirs, top: big.slice(0, topN) };
  }
  return { bytes, files, dirs };
}

/* 实测体积有缓存：每次写文件都遍历一遍目录，在文件多的时候比写文件本身还慢。
   缓存只在「记账增量」和「定时校准」时刷新，写前检查用的是增量值，误差是字节级。 */
const DISK_TTL = 30 * 1000;

export function diskUsage(scope, { fresh = false, topN = 0 } = {}) {
  const root = scopeRoot(scope);
  if (!root) return { ok: false, error: '工作区标识不合法' };
  const rec = load(scope);
  const now = Date.now();
  const cached = rec && rec.diskAt && (now - rec.diskAt) < DISK_TTL && !fresh;
  if (cached && topN === 0) {
    return { ok: true, bytes: rec.diskBytes, files: rec.diskFiles || 0, at: rec.diskAt, cached: true };
  }
  if (!fs.existsSync(root)) {
    return { ok: true, bytes: 0, files: 0, at: now, cached: false };
  }
  const m = walkSize(root, { topN });
  if (rec) {
    rec.diskBytes = m.bytes;
    rec.diskFiles = m.files;
    rec.diskAt = now;
    /* 校准值不标 dirty：它随时可以从磁盘再算一遍，没必要为它写盘 */
  }
  return { ok: true, bytes: m.bytes, files: m.files, dirs: m.dirs, top: m.top, at: now, cached: false };
}

/** 写入后的增量记账：正数是新增，负数是覆盖写变小。 */
export function noteDisk(scope, delta) {
  const rec = load(scope);
  if (!rec) return;
  const d = Math.round(Number(delta) || 0);
  if (!d) return;
  if (!rec.diskAt) { diskUsage(scope, { fresh: true }); }
  rec.diskBytes = Math.max(0, (rec.diskBytes || 0) + d);
  rec.diskAt = Date.now();
}

export function isFrozen(scope) {
  const rec = load(scope);
  return !!(rec && rec.frozen);
}

export function freeze(scope, reason) {
  const rec = load(scope);
  if (!rec) return { ok: false, error: '工作区标识不合法' };
  if (rec.frozen) return { ok: true, already: true, reason: rec.frozenReason };
  rec.frozen = true;
  rec.frozenReason = String(reason || '').slice(0, 300);
  rec.frozenAt = new Date().toISOString();
  dirty.add(scope);
  flush();
  writeAudit({
    kind: 'quota', scope, action: '冻结写入', target: '', ok: false, blocked: true,
    output: rec.frozenReason, category: 'system', level: 'default', ms: 0
  });
  return { ok: true, reason: rec.frozenReason };
}

export function thaw(scope) {
  const rec = load(scope);
  if (!rec) return { ok: false, error: '工作区标识不合法' };
  const was = rec.frozen;
  rec.frozen = false;
  rec.frozenReason = '';
  rec.frozenAt = '';
  dirty.add(scope);
  flush();
  if (was) {
    writeAudit({
      kind: 'quota', scope, action: '解除写入冻结', target: '', ok: true, blocked: false,
      output: '由管理员或清理动作解除', category: 'system', level: 'default', ms: 0
    });
  }
  return { ok: true, was };
}

/**
 * 写入前检查。addBytes 是「这次打算写多少」。
 * 已冻结 → 直接拒；冻结是对 shell 那种绕不过去的写法的唯一兜底，
 * 所以这里必须排在容量判断前面（不然清理一点空间就自动解冻了，冻结形同虚设）。
 */
export function checkDisk(scope, addBytes = 0) {
  const rec = load(scope);
  if (!rec) return { ok: false, code: 'scope_bad', error: '工作区标识不合法' };
  if (rec.frozen) {
    return {
      ok: false, code: 'disk_frozen',
      error: `这个工作区的写入被冻结了：${rec.frozenReason || '磁盘超限'}。清理文件或联系管理员提额后恢复。`
    };
  }
  const lim = limitsOf(scope);
  const u = diskUsage(scope);
  const used = Number(u.bytes) || 0;
  const add = Math.max(0, Math.round(Number(addBytes) || 0));
  if (used + add > lim.diskBytes) {
    return {
      ok: false, code: 'disk_quota',
      used, limit: lim.diskBytes, add,
      error: `磁盘空间不够了：已用 ${fmtBytes(used)}，上限 ${fmtBytes(lim.diskBytes)}，`
        + `这次还要写 ${fmtBytes(add)}。先删掉一些文件，或者让管理员提额。`
    };
  }
  return { ok: true, used, limit: lim.diskBytes, add };
}

export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1048576).toFixed(1)}MB`;
  return `${(v / 1073741824).toFixed(2)}GB`;
}

export function diskStatus(scope, { fresh = false } = {}) {
  const lim = limitsOf(scope);
  const u = diskUsage(scope, { fresh, topN: 8 });
  if (!u.ok) return { ok: false, error: u.error };
  const rec = load(scope);
  const used = Number(u.bytes) || 0;
  return {
    ok: true,
    used, limit: lim.diskBytes, remaining: Math.max(0, lim.diskBytes - used),
    pct: lim.diskBytes ? Math.round((used / lim.diskBytes) * 1000) / 10 : 0,
    files: u.files, top: (u.top || []).map(t => ({ path: t.path, size: t.size, human: fmtBytes(t.size) })),
    frozen: !!(rec && rec.frozen),
    frozenReason: (rec && rec.frozenReason) || '',
    frozenAt: (rec && rec.frozenAt) || '',
    at: u.at
  };
}

/** 一整份报告：前端「额度」面板和运维排查都用它 */
export function quotaReport(scope, opts = {}) {
  return {
    ok: true,
    scope,
    tokens: tokenStatus(scope),
    disk: diskStatus(scope, opts),
    limits: limitsOf(scope)
  };
}

/**
 * 跑完 shell 之后的实测校准。
 * shell 是唯一一条我们拦不住写入的路径，所以这里不做预测，直接实测，
 * 超了就冻结——冻结的代价是「用户得清理一下」，不冻结的代价是「所有人的任务一起失败」。
 */
export function reconcileShell(scope) {
  const u = diskUsage(scope, { fresh: true });
  if (!u.ok) return { ok: false };
  const lim = limitsOf(scope);
  const rec = load(scope);
  if (u.bytes > lim.diskBytes) {
    freeze(scope, `执行命令后实测 ${fmtBytes(u.bytes)}，超过上限 ${fmtBytes(lim.diskBytes)}`);
    return { ok: false, code: 'disk_quota', used: u.bytes, limit: lim.diskBytes, frozen: true };
  }
  if (rec && rec.frozen) return { ok: true, stillFrozen: true, used: u.bytes };
  return { ok: true, used: u.bytes };
}

/* 内存里的用量是「此刻」的真值，磁盘是「5 秒前」的快照。
   只读文件的后果不是数据错，而是**看起来没在用**——管理员打开面板发现所有人都是 0，
   第一反应是「配额没生效」，然后去改一个本来没坏的东西。
   所以两处统计都先看内存，再用磁盘补上「不在这个进程里的账号」。 */
function scopeNames() {
  const names = new Set();
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (/^[a-f0-9]{32}\.json$/.test(f)) names.add(f.slice(0, -5));
    }
  } catch { /* 目录读不到就只靠内存 */ }
  for (const k of cache.keys()) names.add(k);
  return [...names];
}

/** 轻量统计：只读小 JSON + 内存，不遍历工作区目录。
 *  给 /api/health 用——那个接口可能被监控每分钟打一次，不能每次去扫所有人的文件。 */
export function quickStats() {
  const d = dayKey();
  let frozen = 0;
  let dayTokens = 0;
  const names = scopeNames();
  for (const scope of names) {
    const mem = cache.get(scope);
    const r = mem || readJson(path.join(DIR, `${scope}.json`), null);
    if (!r || typeof r !== 'object') continue;
    if (r.frozen) frozen += 1;
    if (r.day === d) dayTokens += Number(r.dayTokens) || 0;
  }
  return { accounts: names.length, frozen, dayTokens };
}

/* ── 运维视图 ── */
export function listScopes() {
  const out = [];
  for (const scope of scopeNames()) {
    const t = tokenStatus(scope);
    const d = diskStatus(scope);
    out.push({
      scope,
      dayTokens: t.day ? t.day.used : 0,
      monthTokens: t.month ? t.month.used : 0,
      calls: t.calls || 0,
      lastAt: t.lastAt || '',
      diskBytes: d.ok ? d.used : 0,
      frozen: d.ok ? d.frozen : false
    });
  }
  return out.sort((a, b) => b.monthTokens - a.monthTokens);
}

export function usageDir() { return DIR; }

export const __test = {
  reset() {
    flush();
    cache.clear();
    dirty.clear();
    LIMITS = null;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  },
  dayKey, monthKey, scopeRoot, LIMITS_FILE, DIR
};
