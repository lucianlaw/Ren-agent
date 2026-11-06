// schema 迁移台账
//
// 起因很具体：状态库的四张表原来是一大段字符串常量，塞在 lib/state.js 的 openDb() 里。
// 后来要加一列 host，只能在那段常量后面补一句
//   try { if (!cols.includes('host')) d.exec('ALTER TABLE runs ADD COLUMN host TEXT') } catch {}
// —— 这种写法有三个问题：
//   1. 谁也不知道线上这台机器到底跑过哪几句（没有账）；
//   2. 同一句判断会越积越多，最后没人敢删；
//   3. 想回滚一次改动，得靠人肉读代码猜。
//
// 所以：一个文件一件事，按编号顺序跑，跑过的记一笔 sha256。
//
// 三条边界，写在这里免得以后对着它许愿：
//   · 这是**单机**台账。库在 .ren-state/state.db（部署目录之外）。
//   · 不回滚。写错了就补一份新的把状态改回去——撤销一次 DDL 比前滚危险得多。
//   · 不改已应用的迁移。改了 sha256 就对不上，台账会把它报成 drift（见 status()），
//     此时**不执行**，只是让健康检查看得见。
//
// 关于老库：线上那个库是「没有台账的时代」建的。如果直接跑 001，CREATE TABLE IF NOT EXISTS
// 会全部跳过、看起来没事，但 `meta.schema` 里记着 1，002 该不该跑没人知道。
// 所以有 baseline：台账为空 + 库里已经有 meta.schema 时，把编号 ≤ 它的迁移一律
// 记为「已应用（baseline）」——不执行，只认账。之后 002 正常按需执行。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DEFAULT_DIR = path.join(ROOT, 'db', 'migrations');

const FILE_RE = /^(\d{3,})_([A-Za-z0-9_-]+)\.sql$/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ── 文件读取 ── */

/**
 * 列出迁移文件，按编号排序。
 * 编号重复、文件名不合规一律报错——静默跳过是台账最不能有的行为。
 */
export function migrationFiles(dir = DEFAULT_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) {
    return { ok: false, error: `迁移目录读不到（${dir}）：${e.code || e.message}`, files: [] };
  }
  const files = [];
  const seen = new Map();
  for (const name of names.sort()) {
    if (!name.endsWith('.sql')) continue;
    const m = name.match(FILE_RE);
    if (!m) return { ok: false, error: `迁移文件名不合规：${name}（要 000_名字.sql）`, files: [] };
    const n = Number(m[1]);
    if (seen.has(n)) return { ok: false, error: `迁移编号重复：${seen.get(n)} 和 ${name}`, files: [] };
    seen.set(n, name);
    let sql = '';
    try { sql = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (e) {
      return { ok: false, error: `读不了 ${name}：${e.message}`, files: [] };
    }
    files.push({ n, name: m[2], file: name, sql, sum: sumOf(sql) });
  }
  return { ok: true, files };
}

export function sumOf(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

/* ── SQL 切句 ──
   node:sqlite 的 exec() 能吃多句，但我们要逐句判跳过指令、还要把失败定位到具体那句，
   所以自己切。切的时候必须避开字符串里的分号（'a;b' 是合法值），否则一刀切错，
   整份文件的语义就变了。注释顺手脱掉，指令（-- @xxx）收进 dirs。 */
export function splitStatements(sql) {
  const out = [];
  const src = String(sql || '');
  let cur = '';
  let dirs = {};
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      const text = src.slice(i, end);
      const m = text.match(/^--\s*@([\w-]+)\s*(.*)$/);
      if (m) dirs[m[1].toLowerCase()] = m[2].trim();
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? src.length : e + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === c) {
          /* '' 是两个字符转义出来的一个引号，不是闭合 */
          if (src[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      const stop = Math.min(j + 1, src.length);
      cur += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ';') {
      const s = cur.trim();
      if (s) out.push({ sql: s, dirs });
      cur = '';
      dirs = {};
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  const tail = cur.trim();
  if (tail) out.push({ sql: tail, dirs });
  return out;
}

/* ── 台账表 ── */

export function ensureLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    n          INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    sum        TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    ms         INTEGER NOT NULL,
    note       TEXT
  )`);
}

export function applied(db) {
  try {
    return db.prepare('SELECT n, name, sum, applied_at, ms, note FROM schema_migrations ORDER BY n').all();
  } catch { return []; }
}

function tableExists(db, t) {
  try {
    const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
    return !!r;
  } catch { return false; }
}

function columnsOf(db, t) {
  if (!IDENT_RE.test(t)) return null;
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); } catch { return null; }
}

/** 老库判定：台账为空，但库里已经有 meta.schema —— 说明这是「没有台账的时代」建的 */
function legacyVersion(db) {
  if (!tableExists(db, 'meta')) return 0;
  try {
    const r = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get();
    return r ? Math.max(0, parseInt(r.v, 10) || 0) : 0;
  } catch { return 0; }
}

function setSchemaVersion(db, n) {
  if (!tableExists(db, 'meta')) return;
  db.prepare('INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .run('schema', String(n));
}

/* ── 跑迁移 ── */

/**
 * 执行未应用的迁移。
 * @returns {{ok:boolean, version:number, applied:Array, skipped:Array, drift:Array, error?:string}}
 *   applied  这次真跑了的
 *   skipped  因为跳过指令没跑的（指令名 + 原因）
 *   drift    已应用但文件被改过的（不执行，只报告）
 */
export function run(db, { dir = DEFAULT_DIR, dryRun = false, baseline = true, log = null } = {}) {
  const list = migrationFiles(dir);
  if (!list.ok) return { ok: false, error: list.error, version: 0, applied: [], skipped: [], drift: [] };

  /* 预演连台账表都不建：--dry 的承诺是「什么都别发生」，
     顺手建个表会让人以为跑过了。 */
  if (!dryRun) ensureLedger(db);
  const done = applied(db);
  const doneMap = new Map(done.map(r => [r.n, r]));
  const appliedNow = [];
  const skipped = [];
  const drift = [];

  /* baseline：只在台账完全为空时做一次 */
  const legacy = done.length === 0 && baseline ? legacyVersion(db) : 0;
  if (legacy > 0) {
    for (const f of list.files) {
      if (f.n > legacy) continue;
      if (dryRun) { appliedNow.push({ n: f.n, name: f.name, baseline: true, dry: true }); continue; }
      db.prepare('INSERT OR IGNORE INTO schema_migrations(n, name, sum, applied_at, ms, note) VALUES(?, ?, ?, ?, ?, ?)')
        .run(f.n, f.name, f.sum, Date.now(), 0, 'baseline');
      appliedNow.push({ n: f.n, name: f.name, baseline: true });
    }
    if (log) log(`老库（schema=${legacy}）按 baseline 认账 ${appliedNow.length} 份迁移`);
  }

  for (const f of list.files) {
    const prev = doneMap.get(f.n) || appliedNow.find(a => a.n === f.n && !a.dry);
    if (prev) {
      if (prev.sum && prev.sum !== f.sum && !prev.baseline) {
        drift.push({ n: f.n, name: f.name, was: prev.sum, now: f.sum });
      }
      continue;
    }
    if (dryRun) { appliedNow.push({ n: f.n, name: f.name, dry: true }); continue; }

    const t0 = Date.now();
    let ms = 0;
    try {
      db.exec('BEGIN IMMEDIATE');
      for (const st of splitStatements(f.sql)) {
        const why = skipReason(db, st.dirs);
        if (why) { skipped.push({ n: f.n, name: f.name, why, sql: firstLine(st.sql) }); continue; }
        db.exec(st.sql);
      }
      ms = Date.now() - t0;
      db.prepare('INSERT INTO schema_migrations(n, name, sum, applied_at, ms, note) VALUES(?, ?, ?, ?, ?, ?)')
        .run(f.n, f.name, f.sum, Date.now(), ms, null);
      db.exec('COMMIT');
      appliedNow.push({ n: f.n, name: f.name, ms });
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 事务可能没开起来 */ }
      /* 失败就停在这里：后面的迁移是按「前一份已经生效」写的，硬着头皮往下跑只会更糟 */
      return {
        ok: false, error: `迁移 ${f.file} 失败：${e.message}`, version: currentVersion(db),
        applied: appliedNow, skipped, drift
      };
    }
    if (log) log(`应用 ${f.file}${ms ? `（${ms}ms）` : ''}`);
  }

  const version = currentVersion(db);
  if (!dryRun && version > 0) setSchemaVersion(db, version);
  return { ok: true, version, applied: appliedNow, skipped, drift };
}

function skipReason(db, dirs) {
  const col = dirs['skip-if-column'];
  if (col) {
    const [t, c] = String(col).split('.');
    const cols = t ? columnsOf(db, t) : null;
    if (cols && cols.includes(String(c || ''))) return `列 ${t}.${c} 已存在`;
  }
  const tab = dirs['skip-if-table'];
  if (tab && tableExists(db, String(tab).trim())) return `表 ${tab} 已存在`;
  return '';
}

function firstLine(s) { return String(s || '').split('\n')[0].slice(0, 80); }

export function currentVersion(db) {
  try {
    const r = db.prepare('SELECT MAX(n) AS n FROM schema_migrations').get();
    return Number((r && r.n) || 0);
  } catch { return 0; }
}

/** 台账现状：给 /api/health、scripts/migrate.mjs --status 和测试用 */
export function status(db, dir = DEFAULT_DIR) {
  const list = migrationFiles(dir);
  if (!list.ok) return { ok: false, error: list.error };
  const done = applied(db);
  const map = new Map(done.map(r => [r.n, r]));
  const rows = list.files.map(f => {
    const r = map.get(f.n);
    return {
      n: f.n, name: f.name,
      state: !r ? 'pending' : (r.note === 'baseline' ? 'baseline' : (r.sum !== f.sum ? 'drift' : 'applied')),
      appliedAt: r ? r.applied_at : null,
      ms: r ? r.ms : null
    };
  });
  return {
    ok: true,
    version: currentVersion(db),
    pending: rows.filter(r => r.state === 'pending').map(r => r.n),
    drift: rows.filter(r => r.state === 'drift').map(r => r.n),
    rows
  };
}

export const __test = { FILE_RE, IDENT_RE, firstLine, skipReason, legacyVersion, setSchemaVersion };
