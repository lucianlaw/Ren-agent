// 审计日志：完全访问模式下必须可追溯
//
// 落盘格式：data/audit/YYYY-MM-DD.jsonl（一行一条，追加写，按天分片）
// 每条都带够了「事后能复盘」的要素：
//   时间（ISO + 本地可读 + 毫秒）、谁（scope）、做了什么（tool / action / 权限档位）、
//   访问了什么（target：路径 / 命令 / URL）、结果（ok / blocked / 报错）、耗时、来源（IP / UA / Origin）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DIR = process.env.AUDIT_DIR
  ? path.resolve(process.env.AUDIT_DIR)
  : path.join(ROOT, 'data', 'audit');

try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 目录不可写就静默降级 */ }

/* 按工作区（账号）分目录：互不串味，后续后台页也能只查某个人的日志 */
function scopeDir(scope) {
  const s = String(scope || '');
  const safe = /^[a-f0-9]{32}$/.test(s) ? s : '_unknown';
  const d = path.join(DIR, safe);
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* 忽略 */ }
  return d;
}

/* 工具名 → 人类可读动作 */
const ACTION = {
  list_dir: '列目录', read_file: '读文件', search_text: '搜索文件内容', read_doc: '解析文档',
  write_file: '写文件', make_deck: '生成 PPT', make_sheet: '生成表格', make_doc: '生成文档',
  run_shell: '执行终端命令', todo_write: '记录待办',
  find_image: '查找图片', gen_image: '生成图片',
  web_search: '联网搜索', fetch_url: '访问网页'
};

function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localStamp(d) {
  return `${dayKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* 这一步到底碰了什么：路径 / 命令 / URL / 查询词 */
export function auditTarget(name, args = {}, custom = null) {
  if (custom && custom.url) return String(custom.url);
  if (name === 'run_shell') return String(args.command || '');
  if (name === 'web_search') return String(args.query || '');
  if (name === 'fetch_url' || name === 'gen_image') return String(args.url || args.prompt || '');
  if (name === 'find_image') return String(args.query || '');
  return String(args.path || args.file || args.query || '');
}

const clip = (s, n) => (s == null ? '' : (String(s).length > n ? String(s).slice(0, n) + '…' : String(s)));

/* 写一条审计日志（同步追加，量小、不引入队列） */
export function writeAudit(entry) {
  const d = new Date();
  const rec = {
    id: crypto.randomUUID(),
    ts: d.toISOString(),
    at: localStamp(d),
    epochMs: d.getTime(),
    ...entry
  };
  try {
    fs.appendFileSync(path.join(scopeDir(entry.scope), dayKey(d) + '.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  } catch { /* 磁盘不可写时不影响主流程 */ }
  return rec;
}

/* 组装一条工具调用记录 */
export function toolAudit({ scope, name, args, custom, category, level, ok, blocked, ms, verify, output, ip, ua, origin }) {
  return writeAudit({
    kind: 'tool_call',
    scope,
    tool: name,
    action: ACTION[name] || (custom ? '调用自定义接口' : '调用工具'),
    category: category || (custom ? 'net' : 'unknown'),
    target: clip(auditTarget(name, args, custom), 800),
    args: clip(JSON.stringify(args || {}), 1200),
    ok: !!ok,
    blocked: !!blocked,
    ms: Number(ms) || 0,
    verify: verify ? { pass: !!verify.pass, why: clip(verify.why, 300) } : null,
    output: clip(output, 400),
    level: level || 'default',
    ip: ip || '',
    ua: clip(ua, 200),
    origin: origin || ''
  });
}

/* 读日志：给后台管理页用（后续做页面时直接调 /api/audit） */export function readAudit({ from, to, scope, limit = 200, kind } = {}) {
  /* 有 scope 只读该目录；没有就扫全部账号目录 */
  const dirs = [];
  try {
    if (scope) dirs.push(scopeDir(scope));
    else {
      for (const d of fs.readdirSync(DIR, { withFileTypes: true })) {
        if (d.isDirectory()) dirs.push(path.join(DIR, d.name));
      }
    }
  } catch { return []; }
  const files = [];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d).filter(x => x.endsWith('.jsonl'))) files.push(path.join(d, f));
    } catch { /* 忽略 */ }
  }
  files.sort().reverse();
  if (!files.length) return [];
  const max = Math.max(1, Math.min(Number(limit) || 200, 2000));
  const fromMs = from ? Date.parse(from) : 0;
  const toMs = to ? Date.parse(to) : Infinity;
  const out = [];
  for (const f of files) {
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { continue; }
      if (scope && rec.scope !== scope) continue;
      if (kind && rec.kind !== kind) continue;
      if (rec.epochMs < fromMs || rec.epochMs > toMs) continue;
      out.push(rec);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/* ══ 保留期：审计只写不删，磁盘没有上限 ══
   2026-11-06 的待办清单里这条排最前：本地 32 个日分片 / 776KB，线上更老更大；
   而备份会把 data/ 整个打进去（最新一份 7.88MB，大头就是这些）。
   「只增不减」在磁盘上是慢性病：不会立刻出事，出了事就是写满。
   按天保留，默认 30 天。AUDIT_KEEP_DAYS=0 表示明确关掉清理（要留全量证据时用）。 */
const KEEP_DAYS = (() => {
  const n = Number(process.env.AUDIT_KEEP_DAYS);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

/* 文件名就是日期：2026-11-06.jsonl → 那天零点的时间戳（无效名字返回 0） */
function dayOf(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(String(name || ''));
  if (!m) return 0;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isFinite(t) ? t : 0;
}

/* 目录现状：多少天、多重、最老到哪天。health 里给这几个数就够了——
   「审计有没有在长胖」这件事，没有数字就只能靠感觉。 */
/* 时间戳 → 本地日期串。
   不能用 toISOString().slice(0,10)：那个值在 UTC+8 会往回退一天，
   「最老的日志是哪天」直接错一天——而这个数正是判断「保留期有没有生效」的依据。 */
function ymd(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function auditStats(now = Date.now()) {
  const out = { dir: DIR, days: 0, files: 0, bytes: 0, oldest: '', newest: '', keepDays: KEEP_DAYS };
  let scopes = [];
  try { scopes = fs.readdirSync(DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  const days = new Set();
  let oldestMs = Infinity, newestMs = 0;
  for (const s of scopes) {
    let files = [];
    try { files = fs.readdirSync(path.join(DIR, s.name)); } catch { continue; }
    for (const f of files) {
      const ms = dayOf(f);
      if (!ms) continue;               /* 不是日分片的（比如 .tmp）不计 */
      days.add(f.slice(0, 10));
      if (ms < oldestMs) oldestMs = ms;
      if (ms > newestMs) newestMs = ms;
      out.files++;
      try { out.bytes += fs.statSync(path.join(DIR, s.name, f)).size; } catch { /* 忽略 */ }
    }
  }
  out.days = days.size;
  out.oldest = oldestMs === Infinity ? '' : ymd(oldestMs);
  out.newest = newestMs ? ymd(newestMs) : '';
  void now;
  return out;
}

/* 清扫：删掉早于 keepDays 的日分片。
   三条克制：
     ① 只删文件名长得像日分片的（别的文件一律不碰，避免误删 .key 之类）；
     ② 边界取「今天零点往前 keepDays 天」，不是 24h×N 的滑动窗口——
        按天分片的东西按天算，跟人理解的一致；
     ③ dryRun 先看要删什么，跟删除走同一套判定。 */
export function sweepAudit({ keepDays = KEEP_DAYS, now = Date.now(), dryRun = false } = {}) {
  const res = { keepDays, dryRun, deleted: 0, bytes: 0, kept: 0, files: [] };
  if (!(keepDays > 0)) return res;     /* 0/负数 = 明确不清理 */
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  const cutMs = cutoff.getTime() - keepDays * 86400000;
  let scopes = [];
  try { scopes = fs.readdirSync(DIR, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return res; }
  for (const s of scopes) {
    const d = path.join(DIR, s.name);
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    for (const f of files) {
      const ms = dayOf(f);
      if (!ms) continue;
      if (ms >= cutMs) { res.kept++; continue; }
      const full = path.join(d, f);
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* 忽略 */ }
      if (!dryRun) {
        try { fs.unlinkSync(full); } catch { continue; }
      }
      res.deleted++;
      res.bytes += size;
      if (res.files.length < 20) res.files.push(path.posix.join(s.name, f));
    }
  }
  return res;
}

export const __test = { dayOf, KEEP_DAYS };
