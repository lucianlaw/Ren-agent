// 状态层：把「重启就没了」的那几样东西放到磁盘上
//
// 之前这些状态全在模块级 Map 里：任务注册表、工作区占用、限流计数。
// 三件事因此不成立——重启即失（换个进程就当没发生过）、不能多实例
// （两个进程各算各的）、出了问题看不见（内存里的东西没有审计面）。
//
// 为什么是 SQLite 而不是「再写几个 JSON 文件」：
//   · 限流是「读-改-写」，两个进程同时改同一个 JSON 就是典型的丢失更新，
//     而丢的那几次正好发生在最忙的时候。
//   · 锁需要「检查并占用」的原子性。文件系统上模拟要用 O_EXCL 加一堆清理逻辑，
//     SQLite 一条 BEGIN IMMEDIATE 就够。
//   · node:sqlite 是标准库，不引依赖——这个项目从第一天起就是零运行时依赖。
//
// 边界（写在这里，免得以后又对着它许愿）：
//   · 这是**单机**状态。多台机器要共享，得换成网络数据库（云库）。
//     WAL 能让同一台机器上的多个进程安全并发，不能让两台机器并发。
//   · 落盘的是「谁在跑什么」，不是任务本身。事件流、对话、abort 句柄是内存对象，
//     进程没了就没了，这里只负责让**别人**知道它没了，而不是让它复活。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import * as MIGRATE from './dbmigrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

/* 测试进程绝不写真实状态库。
   理由和 lib/config.js 里那条一样，但后果更难看：限流计数是跨测试共享的，
   一个测试把额度打满，另一个测试就会莫名其妙收到 429；
   而且它还挂在真实目录里，跑完测试会留下一堆假任务。
   按 pid 分开，是为了让并发跑的测试互不影响。 */
const ENTRY = String(process.argv[1] || '');
if (!process.env.REN_STATE_DIR && /[\\/]test[\\/][^\\/]+\.mjs$/.test(ENTRY)) {
  process.env.REN_STATE_DIR = path.join(os.tmpdir(), `ren-state-test-${process.pid}`);
}

/* 状态库放在部署目录之外，理由和密钥、备份一样：
   发布是「覆盖上传」，放进应用目录的东西下一次发布就可能是旧的或被清掉。
   状态库比密钥更不能丢——丢了不是「要重登一次」，是「所有人正在跑的任务变成幽灵」。 */
function stateDir() {
  return process.env.REN_STATE_DIR
    ? path.resolve(process.env.REN_STATE_DIR)
    : path.resolve(ROOT, '..', '.ren-state');
}
function dbFile() { return path.join(stateDir(), 'state.db'); }

const BOOT = crypto.randomBytes(8).toString('hex');
const HOST = os.hostname();
const HB_MS = 10 * 1000;          // 心跳周期
/* 这两个阈值只在测试里被压缩：真实环境下「进程刚死」和「另一个进程正在跑」
   只能靠时间区分，把窗口调小就等于允许误杀。默认值不要动。 */
const STALE_MS = Math.max(0, Number(process.env.REN_STATE_STALE_MS || 90 * 1000));
const PID_GRACE_MS = Math.max(0, Number(process.env.REN_STATE_PID_GRACE_MS || 20 * 1000));

let db = null;
let mode = 'memory';
let initInfo = { mode: 'memory', dir: stateDir(), file: dbFile(), why: 'not-initialized', reaped: 0 };
/* 建表结果：跑了几份迁移、有没有「文件被改过」的漂移。health 会原样带出去——
   一个看不见的 schema 版本，等于没有版本。 */
let migrateInfo = { version: 0, applied: [], drift: [] };

/* ── 内存兜底 ──
   sqlite 打不开（旧 Node、只读盘、文件损坏）时不能把服务拖死，
   但要让人看得见「现在是降级状态」——一个静默降级的持久化层，
   比没有持久化层更危险，因为所有人都以为它在。 */
const mem = {
  runs: new Map(),      // id -> row
  locks: new Map(),     // key -> { runId, exp }
  leases: new Map(),    // path -> { runId, exp }
  rate: new Map()       // key -> { base, pend, exp }
};

/* ── 限流的写合并 ──
   每个请求都写一次库，在几百 QPS 下会把 WAL 打满。改成：
   检查时读库（拿到别的进程写的值）+ 内存里累计本次的增量，每 250ms 合并写一次。
   代价是崩溃会丢最后 250ms 的计数——对「每分钟 120 次」这个量级可以忽略。 */
const FLUSH_MS = 250;
let dirty = new Map();  // key -> { n, exp }

function nowMs() { return Date.now(); }

function openDb() {
  /* 建目录这一步也要兜住：路径上有个同名文件时 mkdirSync 会抛，
     异常直接冒到 init 外面就等于「降级失败、服务起不来」——
     而降级恰恰是给这种坏环境准备的。 */
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  } catch (e) {
    return { ok: false, why: `状态目录不可用（${e.code || e.message}）：${stateDir()}` };
  }
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    return { ok: false, why: `这个 Node 没有 node:sqlite（${e.message}）` };
  }
  if (typeof DatabaseSync !== 'function') return { ok: false, why: 'node:sqlite 形状不对' };

  let d;
  try {
    d = new DatabaseSync(dbFile());
  } catch (e) {
    return { ok: false, why: `打不开 ${dbFile()}：${e.message}` };
  }
  try {
    d.exec('PRAGMA journal_mode = WAL');
    d.exec('PRAGMA synchronous = NORMAL');
    d.exec('PRAGMA busy_timeout = 3000');
    /* 建表交给迁移台账：db/migrations/*.sql + lib/dbmigrate.js。
       以前这里是一大段 CREATE TABLE 常量，改一列要在原地补一句
       「if (!cols.includes(...)) ALTER TABLE ...」——跑过没跑过没人知道。
       现在每份迁移按编号跑一次，跑过的记 sha256；老库（meta.schema=1 但没有台账）
       按 baseline 认账，再往下补缺的。 */
    const mig = MIGRATE.run(d, {
      log: process.env.REN_MIGRATE_LOG ? (m) => console.error('[migrate] ' + m) : null
    });
    if (!mig.ok) {
      try { d.close(); } catch { /* ignore */ }
      return { ok: false, why: mig.error };
    }
    migrateInfo = {
      version: mig.version,
      applied: mig.applied.map(a => a.n),
      drift: mig.drift.map(x => x.n)
    };
  } catch (e) {
    try { d.close(); } catch { /* ignore */ }
    return { ok: false, why: `建表失败：${e.message}` };
  }
  return { ok: true, db: d };
}

/* 一次写事务。BEGIN IMMEDIATE 先把写锁拿到手，避免「读到没有、写的时候已经被占了」。 */
function tx(fn) {
  if (!db) return fn();
  try {
    db.exec('BEGIN IMMEDIATE');
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 事务可能压根没开起来 */ }
    throw e;
  }
}

/**
 * 初始化。幂等：重复调用只返回第一次的结果。
 * 启动时调用一次即可，之后所有读写都走这里的连接。
 */
export function init() {
  if (db || (mode === 'memory' && initInfo.why !== 'not-initialized')) return initInfo;

  const r = openDb();
  if (!r.ok) {
    mode = 'memory';
    initInfo = { mode, dir: stateDir(), file: dbFile(), why: r.why, reaped: 0, boot: BOOT };
    return initInfo;
  }
  db = r.db;
  mode = 'sqlite';

  /* 收尸：上一个进程留下的 running 行。
     两条判据，先快后稳：
       ① 本机 pid 已经不存在 → 立刻判定（进程被杀时是这样，最常见）
       ② 90 秒没有心跳 → 判定（跨机、pid 被复用、容器换命名空间时靠这条兜底）
     只靠 ① 会在 pid 复用时误判「还活着」，所以 ② 必须留着。
     只靠 ② 会让部署后的 90 秒里，所有人看到一个永远不会动的「进行中」。 */
  const reaped = reapStale({ initial: true });
  /* 收尸之后必须紧接着清锁：崩溃时 onEnd 不会执行，锁要留到 TTL 才失效，
     而这两天里用户看到的是「有任务在跑」，那个任务其实早没了。 */
  clearDeadLocks();

  try {
    db.prepare('DELETE FROM locks WHERE expires_at < ?').run(nowMs());
    db.prepare('DELETE FROM leases WHERE expires_at < ?').run(nowMs());
    db.prepare('DELETE FROM rate WHERE expires_at < ?').run(nowMs());
  } catch { /* 清理失败不影响启动 */ }

  initInfo = { mode, dir: stateDir(), file: dbFile(), why: '', reaped, boot: BOOT, schema: migrateInfo };
  return initInfo;
}

/** 把「进程没了但状态还写着 running」的行改成 interrupted。返回收拾了几条。 */
export function reapStale({ initial = false } = {}) {
  if (!db) return 0;
  const t = nowMs();
  let n = 0;
  try {
    const rows = db.prepare("SELECT id, pid, host, boot, hb_at FROM runs WHERE status = 'running'").all();
    for (const r of rows) {
      /* 本进程的行一律不判死：它们要么在内存里活着，要么已经由 onEnd 标了状态。
         少这条判断，把 STALE 调小（测试环境）时心跳间隔就会把自己的活任务杀掉。 */
      if (r.boot === BOOT) continue;
      const stale = r.hb_at < t - STALE_MS;
      const sameHost = r.host === HOST;
      const deadPid = sameHost && Number(r.pid) > 0
        && r.hb_at < t - PID_GRACE_MS && !pidAlive(Number(r.pid));
      if (!stale && !deadPid) continue;
      const why = deadPid && !stale
        ? '执行进程已退出（重启或崩溃），任务中断'
        : '超过 90 秒没有心跳，任务中断';
      const res = db.prepare("UPDATE runs SET status = 'interrupted', reason = ?, ended_at = ? WHERE id = ? AND status = 'running'")
        .run(why, t, r.id);
      if (res.changes) n += 1;
    }
    if (n) console.log(`[state] 已收尸 ${n} 个中断任务${initial ? '（上次进程遗留）' : ''}`);
  } catch { /* ignore */ }
  return n;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }  /* EPERM：有权限限制但进程在 */
}

export function info() { return { ...initInfo }; }
export function modeOf() { return mode; }
export function bootId() { return BOOT; }
export function stateDirOf() { return stateDir(); }

export function dbBytes() {
  try {
    let n = 0;
    for (const f of fs.readdirSync(stateDir())) {
      if (f.startsWith('state.db')) n += fs.statSync(path.join(stateDir(), f)).size;
    }
    return n;
  } catch { return 0; }
}

/* ── 任务注册表 ── */

export function runBegin({ id, scope, uid = '', title = '', device = '', model = '' }) {
  const t = nowMs();
  const row = {
    id: String(id), scope: String(scope), uid: String(uid || ''), title: String(title || '').slice(0, 200),
    device: String(device || '').slice(0, 64), model: String(model || '').slice(0, 80),
    status: 'running', reason: '', boot: BOOT, pid: process.pid, host: HOST,
    startedAt: t, endedAt: 0, hbAt: t
  };
  if (db) {
    try {
      db.prepare(`INSERT INTO runs(id, scope, uid, title, device, model, status, reason, boot, pid, host, started_at, ended_at, hb_at)
                  VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    status = 'running', reason = '', boot = excluded.boot, pid = excluded.pid,
                    host = excluded.host, started_at = excluded.started_at, ended_at = NULL, hb_at = excluded.hb_at`)
        .run(row.id, row.scope, row.uid, row.title, row.device, row.model,
          row.status, row.reason, row.boot, row.pid, row.host, row.startedAt, row.hbAt);
    } catch { /* 写不进去也不能挡住任务启动 */ }
  }
  mem.runs.set(row.id, row);
  return row;
}

export function runEnd(id, { status = 'done', reason = '' } = {}) {
  const t = nowMs();
  const k = String(id);
  const cur = mem.runs.get(k);
  if (cur) { cur.status = status; cur.reason = String(reason || '').slice(0, 300); cur.endedAt = t; cur.hbAt = t; }
  if (db) {
    try {
      db.prepare('UPDATE runs SET status = ?, reason = ?, ended_at = ?, hb_at = ? WHERE id = ?')
        .run(status, String(reason || '').slice(0, 300), t, t, k);
    } catch { /* ignore */ }
  }
}

export function runHeartbeat(ids) {
  if (!ids.length) return;
  const t = nowMs();
  for (const id of ids) { const r = mem.runs.get(id); if (r) r.hbAt = t; }
  if (!db) return;
  try {
    const st = db.prepare("UPDATE runs SET hb_at = ? WHERE id = ? AND status = 'running'");
    tx(() => { for (const id of ids) st.run(t, id); });
  } catch { /* ignore */ }
}

export function runGet(id) {
  const k = String(id);
  const m = mem.runs.get(k);
  if (m) return m;
  if (!db) return null;
  try {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(k);
    return r ? {
      id: r.id, scope: r.scope, uid: r.uid, title: r.title, device: r.device, model: r.model,
      status: r.status, reason: r.reason, boot: r.boot, pid: r.pid,
      startedAt: r.started_at, endedAt: r.ended_at || 0, hbAt: r.hb_at
    } : null;
  } catch { return null; }
}

export function runRecent(scope, limit = 10) {
  if (!db) {
    return [...mem.runs.values()].filter(r => r.scope === scope)
      .sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }
  try {
    return db.prepare('SELECT * FROM runs WHERE scope = ? ORDER BY started_at DESC LIMIT ?')
      .all(String(scope), limit)
      .map(r => ({
        id: r.id, scope: r.scope, title: r.title, device: r.device, status: r.status,
        reason: r.reason, startedAt: r.started_at, endedAt: r.ended_at || 0
      }));
  } catch { return []; }
}

/* ── 注销 ──
   把这个 scope 在状态库里留下的痕迹清掉。
   顺序不能反：locks/leases 靠 run_id 关联 runs，先删子表再删主表，
   否则「先删 runs」之后那些锁就成了永远查不到主人的僵尸锁，要等 TTL 过期才消失。
   限流的 key 形如 s:<scope>|<窗口号>（见 server.js rateOK），一起清掉——
   不然同一个人刚注销完，换新账号在同一分钟内还可能撞上旧桶的计数。 */
export function purgeScope(scope) {
  const s = String(scope || '');
  if (!s) return { ok: false, error: '缺少工作区标识' };
  if (!db) {
    let n = 0;
    for (const [k, v] of mem.runs) if (v.scope === s) { mem.runs.delete(k); n++; }
    return { ok: true, runs: n, locks: 0, leases: 0, rate: 0, mode: 'memory' };
  }
  const out = { ok: true, runs: 0, locks: 0, leases: 0, rate: 0, mode };
  try {
    tx(() => {
      out.locks = db.prepare('DELETE FROM locks WHERE run_id IN (SELECT id FROM runs WHERE scope = ?)').run(s).changes || 0;
      out.leases = db.prepare('DELETE FROM leases WHERE run_id IN (SELECT id FROM runs WHERE scope = ?)').run(s).changes || 0;
      out.runs = db.prepare('DELETE FROM runs WHERE scope = ?').run(s).changes || 0;
      out.rate = db.prepare("DELETE FROM rate WHERE key LIKE 's:' || ? || '|%'").run(s).changes || 0;
    });
  } catch (e) {
    return { ok: false, error: `清状态失败：${(e && e.message) || e}`, ...out };
  }
  return out;
}

/* ── 占用锁 ──
   key 的粒度决定「谁能和谁同时跑」：
     scope  → 一个账号一次只能跑一个（原来的行为）
     scope+device → 手机和电脑能各跑一个，同一台设备仍只能一个
   锁带 TTL，进程被 kill -9 也不会留下永久僵锁。 */
export function acquireLock(key, runId, ttlMs = 120 * 1000) {
  const t = nowMs();
  const exp = t + ttlMs;
  if (!db) {
    const cur = mem.locks.get(key);
    if (cur && cur.exp > t && cur.runId !== runId) return { ok: false, holder: cur.runId, until: cur.exp };
    mem.locks.set(key, { runId, exp });
    return { ok: true };
  }
  try {
    return tx(() => {
      db.prepare('DELETE FROM locks WHERE expires_at < ?').run(t);
      const cur = db.prepare('SELECT run_id, expires_at FROM locks WHERE key = ?').get(key);
      if (cur && cur.run_id !== runId) return { ok: false, holder: cur.run_id, until: cur.expires_at };
      db.prepare(`INSERT INTO locks(key, run_id, boot, pid, at, expires_at) VALUES(?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET run_id = excluded.run_id, boot = excluded.boot,
                    pid = excluded.pid, at = excluded.at, expires_at = excluded.expires_at`)
        .run(key, runId, BOOT, process.pid, t, exp);
      return { ok: true };
    });
  } catch (e) {
    /* 库出错时宁可放行：占用锁是「防并发冲突」，不是安全边界。
       因为一次 IO 抖动把所有人的任务拒掉，代价更大。 */
    return { ok: true, degraded: true, why: e.message };
  }
}

export function releaseLock(key, runId) {
  if (!db) {
    const cur = mem.locks.get(key);
    if (cur && cur.runId === runId) mem.locks.delete(key);
    return;
  }
  try {
    db.prepare('DELETE FROM locks WHERE key = ? AND run_id = ?').run(key, runId);
  } catch { /* ignore */ }
}

export function lockHolder(key) {
  const t = nowMs();
  if (!db) {
    const cur = mem.locks.get(key);
    return cur && cur.exp > t ? cur.runId : '';
  }
  try {
    const r = db.prepare('SELECT run_id, expires_at FROM locks WHERE key = ?').get(key);
    if (!r) return '';
    if (r.expires_at <= t) { db.prepare('DELETE FROM locks WHERE key = ?').run(key); return ''; }
    return r.run_id;
  } catch { return ''; }
}

/** 以某个前缀开头的所有占用者。给「没有设备标识的老客户端」用：
 *  它不知道自己是不是这些设备之一，那就一律当成「有可能冲突」。 */
export function lockHolders(prefix) {
  const t = nowMs();
  if (!db) {
    return [...mem.locks.entries()]
      .filter(([k, v]) => k.startsWith(prefix) && v.exp > t).map(([, v]) => v.runId);
  }
  try {
    return db.prepare("SELECT run_id FROM locks WHERE key LIKE ? AND expires_at > ?")
      .all(`${prefix}%`, t).map(r => r.run_id);
  } catch { return []; }
}

/* 清掉「锁还在、任务已经没了」的行。
   崩溃（kill -9 / 部署）之后 onEnd 不会执行，锁会留到 TTL 到期——120 秒里
   用户重新点开始，得到的是「已经有一个任务在跑了」，而那个任务根本不存在。
   所以判据不是时间，是「它指向的那个 run 还活着吗」。 */
export function clearDeadLocks() {
  if (!db) {
    for (const [k, v] of mem.locks) {
      const r = mem.runs.get(v.runId);
      if (!r || r.status !== 'running') mem.locks.delete(k);
    }
    return 0;
  }
  const t = nowMs();
  let n = 0;
  try {
    n += db.prepare(`DELETE FROM locks WHERE run_id IN (SELECT id FROM runs WHERE status != 'running')`).run().changes || 0;
    /* 连行都没有的锁：可能是「刚拿到锁、run 还没落库」的瞬间。
       所以只清 30 秒前的，避免把正在启动的任务踢掉。 */
    n += db.prepare(`DELETE FROM locks WHERE at < ? AND run_id NOT IN (SELECT id FROM runs)`).run(t - 30 * 1000).changes || 0;
    n += db.prepare('DELETE FROM locks WHERE expires_at < ?').run(t).changes || 0;
  } catch { /* ignore */ }
  return n;
}

/* ── 路径租约 ──
   放开「同一账号多设备并发」之后，两台设备写同一个文件就会互相覆盖，
   而且没人知道发生过——后写的直接把先写的抹掉，任务日志里两边都是「成功」。
   所以在写入口加一道按路径的短租约：同一时刻同一条路径只允许一个 run 写。

   为什么不做「整棵树的互斥」：那就等于没放开并发。
   为什么不做「内容级版本比对」：写入是 ms 级操作，租约足够；
   版本比对要在模型侧引入 base 修订号，成本和收益不成比例。 */
export function leasePath(absPath, runId, ttlMs = 120 * 1000) {
  const p = String(absPath);
  const t = nowMs();
  const exp = t + ttlMs;
  if (!db) {
    const cur = mem.leases.get(p);
    if (cur && cur.exp > t && cur.runId !== runId) return { ok: false, holder: cur.runId };
    mem.leases.set(p, { runId, exp });
    return { ok: true };
  }
  try {
    return tx(() => {
      db.prepare('DELETE FROM leases WHERE expires_at < ?').run(t);
      const cur = db.prepare('SELECT run_id FROM leases WHERE path = ?').get(p);
      if (cur && cur.run_id !== runId) return { ok: false, holder: cur.run_id };
      db.prepare(`INSERT INTO leases(path, run_id, expires_at) VALUES(?, ?, ?)
                  ON CONFLICT(path) DO UPDATE SET run_id = excluded.run_id, expires_at = excluded.expires_at`)
        .run(p, runId, exp);
      return { ok: true };
    });
  } catch {
    return { ok: true, degraded: true };
  }
}

export function releaseLeases(runId) {
  if (!db) {
    for (const [k, v] of mem.leases) if (v.runId === runId) mem.leases.delete(k);
    return;
  }
  try { db.prepare('DELETE FROM leases WHERE run_id = ?').run(runId); } catch { /* ignore */ }
}

/* ── 限流 ──
   跨进程计数：先读库里的基数，加上本进程还没落盘的增量。
   重启之后基线还在，所以「重启即重置额度」这条免费通道没有了。 */
function readRateBase(key, now) {
  if (!db) return { base: 0, exp: 0 };
  try {
    const r = db.prepare('SELECT n, expires_at FROM rate WHERE key = ?').get(key);
    if (!r || r.expires_at <= now) return { base: 0, exp: 0 };
    return { base: r.n, exp: r.expires_at };
  } catch { return { base: 0, exp: 0 }; }
}

export function takeRate(key, windowMs, limit) {
  const t = nowMs();
  let rec = mem.rate.get(key);
  if (!rec || rec.exp <= t) {
    const b = readRateBase(key, t);
    rec = b.exp > t ? { base: b.base, pend: 0, exp: b.exp } : { base: 0, pend: 0, exp: t + windowMs };
    mem.rate.set(key, rec);
  }
  rec.pend += 1;
  const n = rec.base + rec.pend;
  const d = dirty.get(key) || { n: 0, exp: rec.exp };
  d.n += 1; d.exp = rec.exp;
  dirty.set(key, d);
  return { ok: n <= limit, n, limit, resetAt: rec.exp };
}

export function flushRate() {
  if (!db || !dirty.size) return 0;
  const rows = [...dirty.entries()];
  dirty = new Map();
  const t = nowMs();
  let n = 0;
  try {
    const st = db.prepare(`INSERT INTO rate(key, n, expires_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET n = CASE WHEN rate.expires_at <= ? THEN excluded.n
        ELSE rate.n + excluded.n END, expires_at = excluded.expires_at`);
    tx(() => {
      for (const [k, v] of rows) {
        if (v.exp <= t) continue;
        st.run(k, v.n, v.exp, t);
        n += 1;
      }
    });
    /* 写进去的那部分从 pend 挪到 base，否则同一个进程会把自己的增量算两遍 */
    for (const [k, v] of rows) {
      const rec = mem.rate.get(k);
      if (rec) { rec.base += v.n; rec.pend = Math.max(0, rec.pend - v.n); }
    }
  } catch {
    /* 合并失败：把增量放回去，下一个 tick 再试 */
    for (const [k, v] of rows) {
      const d = dirty.get(k) || { n: 0, exp: v.exp };
      d.n += v.n; dirty.set(k, d);
    }
  }
  return n;
}

/* ── 心跳 ── */
let hbTimer = null;
let liveProvider = null;

export function onHeartbeat(fn) { liveProvider = fn; }

export function startHeartbeat(ms = HB_MS) {
  if (hbTimer) return;
  let tick = 0;
  hbTimer = setInterval(() => {
    try {
      const ids = typeof liveProvider === 'function' ? liveProvider() : [];
      runHeartbeat(ids);
      flushRate();
      /* 收尸也要周期性做：只在启动时收，意味着「本次进程里被 kill 掉的任务」
         要等到下一次部署才会被标成中断。 */
      if (tick++ % 3 === 0) { reapStale(); clearDeadLocks(); }
      /* 顺手清过期行，别让表无限长。掉一两条只是丢了「上次谁跑过」的历史。 */
      if (db && tick % 30 === 0) {
        const cut = nowMs() - 7 * 24 * 3600 * 1000;
        db.prepare('DELETE FROM runs WHERE status != ? AND started_at < ?').run('running', cut);
      }
    } catch { /* 心跳失败不致命 */ }
  }, ms);
  if (typeof hbTimer.unref === 'function') hbTimer.unref();
}

export function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
  try { flushRate(); } catch { /* ignore */ }
}

/* ── 视图 ── */
export function stats() {
  const out = {
    mode, dir: stateDir(), file: dbFile(), boot: BOOT,
    why: initInfo.why || '', reaped: initInfo.reaped || 0, bytes: dbBytes(),
    runs: { total: 0, running: 0, interrupted: 0 }, locks: 0, leases: 0, rate: 0
  };
  if (!db) {
    out.runs.total = mem.runs.size;
    out.runs.running = [...mem.runs.values()].filter(r => r.status === 'running').length;
    out.locks = mem.locks.size; out.leases = mem.leases.size; out.rate = mem.rate.size;
    return out;
  }
  try {
    const g = (sql, ...a) => { const r = db.prepare(sql).get(...a); return r ? Object.values(r)[0] : 0; };
    out.runs.total = g('SELECT COUNT(*) FROM runs');
    out.runs.running = g("SELECT COUNT(*) FROM runs WHERE status = 'running'");
    out.runs.interrupted = g("SELECT COUNT(*) FROM runs WHERE status = 'interrupted'");
    out.locks = g('SELECT COUNT(*) FROM locks');
    out.leases = g('SELECT COUNT(*) FROM leases');
    out.rate = g('SELECT COUNT(*) FROM rate');
  } catch { /* ignore */ }
  return out;
}

/** 测试用：把库整个抹掉重来。线上不该调用。 */
export function _resetForTest() {
  try { if (db) db.close(); } catch { /* ignore */ }
  db = null; mode = 'memory';
  mem.runs.clear(); mem.locks.clear(); mem.leases.clear(); mem.rate.clear();
  dirty = new Map();
  initInfo = { mode: 'memory', dir: stateDir(), file: dbFile(), why: 'not-initialized', reaped: 0 };
  try {
    for (const f of fs.readdirSync(stateDir())) {
      if (f.startsWith('state.db')) fs.unlinkSync(path.join(stateDir(), f));
    }
  } catch { /* ignore */ }
}
