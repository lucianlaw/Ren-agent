/* 迁移台账：老库不炸、新库建对、改过的文件不许静默重跑
 *
 * 台账这种东西只在两种时刻被注意到：升级老库的那一刻，和出事想回溯的那一刻。
 * 所以这批判定的重点是「不骗人」：
 *   1. 老库（没有台账的时代建的）升级上来，**数据要还在**，缺的列要补上，
 *      而且不能因为 CREATE TABLE IF NOT EXISTS「都跳过了」就当成跑过了。
 *   2. 已应用的迁移文件被改过，必须报出来而不是重跑——重跑一个 DROP 是灾难。
 *   3. 半路失败要停在那份迁移上，并且清楚说是哪份；不能带着半截 schema 继续往下跑。
 *   4. --dry 必须真的什么都不做（连库文件都不建）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
/* 测试绝不碰真实状态库：lib/state.js 对 test/*.mjs 会自动改道，
   但这份测试还会 import state.js 验接线，所以显式设一次更稳。 */
process.env.REN_STATE_DIR = path.join(TMP, 'state');

const M = await import('../lib/dbmigrate.js');

const dbAt = (file) => new DatabaseSync(file);
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);

/* ── [1] 文件发现 ── */
console.log('\n[1] 迁移文件的发现与排序');
{
  const d = path.join(TMP, 'fx1');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '010_ten.sql'), 'SELECT 1;');
  fs.writeFileSync(path.join(d, '002_two.sql'), 'SELECT 2;');
  fs.writeFileSync(path.join(d, 'notes.txt'), '不是迁移');
  const r = M.migrationFiles(d);
  ok('读得到目录', r.ok);
  eq('按编号排序，忽略非 .sql', r.files.map(f => f.n), [2, 10]);
  eq('名字从文件名里取', r.files.map(f => f.name), ['two', 'ten']);
  ok('每份都算了 sha256', r.files.every(f => /^[0-9a-f]{16}$/.test(f.sum)));

  const bad = path.join(TMP, 'fx-bad');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'init.sql'), 'SELECT 1;');
  const rb = M.migrationFiles(bad);
  ok('命名不合规直接报错，不静默跳过', !rb.ok && /不合规/.test(rb.error), rb.error);

  const dup = path.join(TMP, 'fx-dup');
  fs.mkdirSync(dup, { recursive: true });
  fs.writeFileSync(path.join(dup, '001_a.sql'), 'SELECT 1;');
  fs.writeFileSync(path.join(dup, '001_b.sql'), 'SELECT 2;');
  const rd = M.migrationFiles(dup);
  ok('编号重复报错', !rd.ok && /重复/.test(rd.error), rd.error);

  const none = M.migrationFiles(path.join(TMP, 'no-such-dir'));
  ok('目录不存在时给出原因而不是抛异常', !none.ok && /读不到/.test(none.error), none.error);
}

/* ── [2] 切句 ── */
console.log('\n[2] SQL 切句：字符串里的分号不能当分隔符');
{
  const st = M.splitStatements("CREATE TABLE a (x TEXT DEFAULT 'a;b'); INSERT INTO a VALUES (';');");
  eq('两句（不是四句）', st.length, 2);
  ok('字符串里的分号留在原文里', st[0].sql.includes("'a;b'"), st[0].sql);
  ok('插入语句完整', /VALUES \(';'\)/.test(st[1].sql), st[1].sql);

  const cm = M.splitStatements('-- 普通注释\nCREATE TABLE t (a);\n/* 块注释 ; */\nSELECT 1;');
  eq('注释不产生空语句', cm.length, 2);
  ok('块注释被脱掉', !cm[1].sql.includes('块注释'), cm[1].sql);

  const dir = M.splitStatements('-- @skip-if-column runs.host\nALTER TABLE runs ADD COLUMN host TEXT;');
  eq('指令被收到 dirs 上', dir[0].dirs['skip-if-column'], 'runs.host');

  const esc = M.splitStatements("INSERT INTO t VALUES ('it''s; fine');");
  eq("'' 转义不会把句子切断", esc.length, 1);

  /* 指令只对紧跟着的那一句生效，不能泄漏到下一句 */
  const scoped = M.splitStatements('-- @skip-if-table x\nCREATE TABLE x(a);\nCREATE TABLE y(b);');
  ok('指令不泄漏到下一句', scoped[0].dirs['skip-if-table'] === 'x' && !scoped[1].dirs['skip-if-table'],
    scoped.map(s => s.dirs));
}

/* ── [3] 新库 ── */
console.log('\n[3] 全新库：按编号建出完整 schema');
{
  const f = path.join(TMP, 'fresh.db');
  const db = dbAt(f);
  const r = M.run(db, { log: null });
  ok('跑成功', r.ok, r.error);
  eq('版本 = 最大编号', r.version, 2);
  eq('两份都应用了', r.applied.map(a => a.n), [1, 2]);
  const t = tables(db);
  ok('四张业务表都在', ['meta', 'runs', 'locks', 'leases', 'rate'].every(x => t.includes(x)), t);
  ok('台账表也在', t.includes('schema_migrations'));
  ok('索引建了', db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('runs_scope','runs_hb')").all().length === 2);
  ok('runs 有 host 列（001 自带）', cols(db, 'runs').includes('host'));
  eq('002 因为列已存在被跳过，但照样记账', r.skipped.map(s => s.n), [2]);
  eq('meta.schema 跟着写成 2', db.prepare("SELECT v FROM meta WHERE k='schema'").get().v, '2');
  db.close();

  const db2 = dbAt(f);
  const again = M.run(db2, { log: null });
  eq('再跑一次：零应用（幂等）', again.applied.length, 0);
  eq('版本不变', again.version, 2);
  db2.close();
}

/* ── [4] 老库升级 ── */
console.log('\n[4] 老库（没有台账、runs 缺 host）：认账 + 补列 + 数据不丢');
{
  const f = path.join(TMP, 'legacy.db');
  const db = dbAt(f);
  db.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, uid TEXT, title TEXT, device TEXT,
      model TEXT, status TEXT NOT NULL, reason TEXT, boot TEXT NOT NULL, pid INTEGER,
      started_at INTEGER NOT NULL, ended_at INTEGER, hb_at INTEGER NOT NULL);
    CREATE TABLE locks (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, boot TEXT NOT NULL, pid INTEGER NOT NULL, at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE leases (path TEXT PRIMARY KEY, run_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE rate (key TEXT PRIMARY KEY, n INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run('schema', '1');
  db.prepare('INSERT INTO runs(id,scope,status,boot,started_at,hb_at) VALUES(?,?,?,?,?,?)')
    .run('r-legacy', 'a'.repeat(32), 'done', 'boot1', 1000, 2000);
  ok('先确认这是「缺 host」的老结构', !cols(db, 'runs').includes('host'));

  const r = M.run(db, { log: null });
  ok('跑成功', r.ok, r.error);
  ok('001 记为 baseline 没重跑', r.applied.some(a => a.n === 1 && a.baseline));
  eq('002 真跑了（没有跳过）', r.skipped.length, 0);
  ok('host 列补上了', cols(db, 'runs').includes('host'));
  eq('老数据一行没少', db.prepare('SELECT COUNT(*) n FROM runs').get().n, 1);
  eq('老数据内容没变', db.prepare("SELECT id FROM runs WHERE scope=?").get('a'.repeat(32)).id, 'r-legacy');
  eq('版本升到 2', r.version, 2);
  const led = db.prepare('SELECT n, note FROM schema_migrations ORDER BY n').all();
  eq('台账两条', led.map(x => x.n), [1, 2]);
  eq('001 标了 baseline', led[0].note, 'baseline');
  db.close();
}

/* ── [5] 跳过指令 ── */
console.log('\n[5] 跳过指令：@skip-if-column / @skip-if-table');
{
  const d = path.join(TMP, 'fx5');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '001_a.sql'), 'CREATE TABLE t1 (a TEXT);');
  fs.writeFileSync(path.join(d, '002_b.sql'),
    '-- @skip-if-column t1.ghost\nALTER TABLE t1 ADD COLUMN ghost TEXT;\n'
    + '-- @skip-if-table t1\nCREATE TABLE t1 (b TEXT);\n'
    + 'CREATE TABLE t2 (c TEXT);');
  const db = dbAt(path.join(TMP, 'fx5.db'));
  const r = M.run(db, { dir: d, log: null });
  ok('整体成功', r.ok, r.error);
  /* 只有 CREATE TABLE t1 被跳过：ALTER 那会儿 ghost 还不存在，该加的照加 */
  eq('建表那句被跳过（ALTER 照执行）', r.skipped.length, 1);
  ok('跳过原因是人话', r.skipped.every(s => /已存在/.test(s.why)), r.skipped);
  ok('t1 没被重建（仍是 a,ghost 两列）', cols(db, 't1').join(',') === 'a,ghost', cols(db, 't1'));
  ok('t2 建出来了', tables(db).includes('t2'));
  db.close();

  /* 缺列时指令不该误跳 */
  const d2 = path.join(TMP, 'fx5b');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, '001_a.sql'), 'CREATE TABLE t1 (a TEXT);');
  fs.writeFileSync(path.join(d2, '002_b.sql'), '-- @skip-if-column t1.ghost\nALTER TABLE t1 ADD COLUMN ghost TEXT;');
  const db2 = dbAt(path.join(TMP, 'fx5b.db'));
  const r2 = M.run(db2, { dir: d2, log: null });
  ok('真缺列时照加', r2.skipped.length === 0 && cols(db2, 't1').includes('ghost'), r2.skipped);
  db2.close();
}

/* ── [6] 半路失败 ── */
console.log('\n[6] 失败即停：说清楚是哪一份，不带着半截 schema 往下跑');
{
  const d = path.join(TMP, 'fx6');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '001_a.sql'), 'CREATE TABLE ok1 (a TEXT);');
  fs.writeFileSync(path.join(d, '002_bad.sql'), 'CREATE TABLE ok2 (a TEXT);\nTHIS IS NOT SQL;');
  fs.writeFileSync(path.join(d, '003_c.sql'), 'CREATE TABLE never (a TEXT);');
  const db = dbAt(path.join(TMP, 'fx6.db'));
  const r = M.run(db, { dir: d, log: null });
  ok('整体失败', !r.ok);
  ok('错误里指明是哪一份', /002_bad\.sql/.test(String(r.error)), r.error);
  ok('失败那份整份回滚（ok2 没留下）', !tables(db).includes('ok2'), tables(db));
  ok('后面的没跑', !tables(db).includes('never'));
  ok('前一份仍然是已应用', M.applied(db).map(x => x.n).join(',') === '1', M.applied(db));
  ok('版本停在 1', M.currentVersion(db) === 1, M.currentVersion(db));
  db.close();
}

/* ── [7] 漂移 ── */
console.log('\n[7] 已应用的迁移被改过：报 drift，绝不重跑');
{
  const d = path.join(TMP, 'fx7');
  fs.mkdirSync(d, { recursive: true });
  const f1 = path.join(d, '001_a.sql');
  fs.writeFileSync(f1, 'CREATE TABLE keepme (a TEXT);');
  const db = dbAt(path.join(TMP, 'fx7.db'));
  M.run(db, { dir: d, log: null });

  /* 有人把已应用的文件改了（最常见的误操作：直接改 001 加列） */
  fs.writeFileSync(f1, 'CREATE TABLE keepme (a TEXT);\nDROP TABLE keepme;');
  const r = M.run(db, { dir: d, log: null });
  ok('跑不报错但报出漂移', r.ok && r.drift.length === 1, r);
  eq('漂移的是 001', r.drift.map(x => x.n), [1]);
  ok('没有重新执行（表还在）', tables(db).includes('keepme'));

  const st = M.status(db, d);
  eq('status 把它标成 drift', st.rows.map(x => x.state), ['drift']);
  db.close();
}

/* ── [8] dryRun ── */
console.log('\n[8] 预演：不动库');
{
  const f = path.join(TMP, 'dry.db');
  const db = dbAt(f);
  const r = M.run(db, { dryRun: true, log: null });
  ok('列出会跑两份', r.applied.length === 2 && r.applied.every(a => a.dry), r.applied);
  ok('库是空的（一张业务表都没有）', tables(db).length === 0, tables(db));
  db.close();
}

/* ── [9] status ── */
console.log('\n[9] status 的形状');
{
  const db = dbAt(path.join(TMP, 'fresh.db'));
  const st = M.status(db);
  ok('ok', st.ok);
  eq('版本 2', st.version, 2);
  eq('没有待应用', st.pending, []);
  eq('没有漂移', st.drift, []);
  eq('每份迁移都有一行', st.rows.length, 2);
  ok('行的字段齐', st.rows.every(r => 'n' in r && 'name' in r && 'state' in r && 'appliedAt' in r));
  db.close();
}

/* ── [10] 与 state.js 的接线 ── */
console.log('\n[10] state.js 真的走台账，而不是还留着那段建表常量');
{
  const src = fs.readFileSync(path.join(APP, 'lib', 'state.js'), 'utf8');
  ok('不再内联 CREATE TABLE', !/CREATE TABLE\s+IF NOT EXISTS\s+runs/i.test(src));
  ok('不再内联 ALTER TABLE 兜底', !/ALTER TABLE runs ADD COLUMN host/.test(src));
  ok('调用了迁移台账', /MIGRATE\.run\(/.test(src));

  const s = await import('../lib/state.js');
  const info = s.init();
  eq('init 之后是 sqlite 模式', info.mode, 'sqlite');
  ok('initInfo 带出 schema 版本', info.schema && info.schema.version >= 2, info.schema);
  ok('降级时不假装', info.why === '', info.why);
  /* 台账确实把表建出来了 */
  const db = dbAt(path.join(process.env.REN_STATE_DIR, 'state.db'));
  ok('库里有 schema_migrations', tables(db).includes('schema_migrations'));
  ok('库里有 runs', tables(db).includes('runs'));
  db.close();
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
