// 迁移台账的命令行入口
//
//   node scripts/migrate.mjs                 跑掉所有未应用的迁移
//   node scripts/migrate.mjs --status        只看现状，不动库
//   node scripts/migrate.mjs --dry           预演：列出会跑哪些，不写库
//   node scripts/migrate.mjs --db /tmp/x.db  指定别的库（迁移演练/排查用）
//   node scripts/migrate.mjs --dir db/migrations
//
// 服务启动时也会自动跑一遍（lib/state.js → openDb），这个脚本是给
// 「部署前先在新库上验一遍」和「线上出事了想确认到底跑到第几份」用的。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { stateDirOf } from '../lib/state.js';
import * as MIGRATE from '../lib/dbmigrate.js';

const require = createRequire(import.meta.url);

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : def;
}
const has = (name) => process.argv.includes(name);

const dir = arg('--dir', MIGRATE.DEFAULT_DIR);
const dbPath = arg('--db', path.join(stateDirOf(), 'state.db'));

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) {
  console.error('这个 Node 没有 node:sqlite，迁移跑不了：' + e.message);
  process.exit(2);
}

if (has('--status')) {
  if (!fs.existsSync(dbPath)) {
    console.log(`没有库：${dbPath}`);
    console.log('（服务第一次启动时会建；也可以去掉 --status 直接把迁移跑出来）');
    process.exit(0);
  }
  const db = new DatabaseSync(dbPath);
  const st = MIGRATE.status(db, dir);
  db.close();
  if (!st.ok) { console.error(st.error); process.exit(2); }
  console.log(`库：${dbPath}`);
  console.log(`版本：${st.version}　待应用：${st.pending.length ? st.pending.join(',') : '无'}`
    + (st.drift.length ? `　⚠ 被改过的：${st.drift.join(',')}` : ''));
  for (const r of st.rows) {
    const when = r.appliedAt ? new Date(r.appliedAt).toISOString().slice(0, 19).replace('T', ' ') : '';
    console.log(`  ${String(r.n).padStart(3, '0')} ${r.name.padEnd(20)} ${r.state.padEnd(9)} ${when}`);
  }
  process.exit(st.drift.length ? 1 : 0);
}

const dryRun = has('--dry');
const list = MIGRATE.migrationFiles(dir);
if (!list.ok) { console.error(list.error); process.exit(2); }

/* 预演模式不建库文件：--dry 的价值就是「什么都不发生」，
   顺手建出一个空库会让人以为跑过了。 */
if (dryRun && !fs.existsSync(dbPath)) {
  console.log(`预演：库还不存在（${dbPath}），首次启动会依次应用：`);
  for (const f of list.files) console.log(`  ${String(f.n).padStart(3, '0')} ${f.file}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
const before = MIGRATE.status(db, dir);
const r = MIGRATE.run(db, { dir, dryRun, log: (m) => console.log('  ' + m) });
const after = dryRun ? before : MIGRATE.status(db, dir);
db.close();

if (!r.ok) { console.error('✗ ' + r.error); process.exit(1); }

console.log(`库：${dbPath}`);
console.log(dryRun
  ? `预演：会应用 ${r.applied.map(a => String(a.n).padStart(3, '0')).join(', ') || '（没有待应用的）'}`
  : `完成：版本 ${before.version} → ${r.version}，本次应用 ${r.applied.length} 份`);
for (const s of r.skipped) console.log(`  跳过 ${s.n} ${s.name}：${s.why}`);
if (r.drift.length) {
  console.error('⚠ 以下迁移已应用但文件被改过（不会重跑，请补一份新迁移）：');
  for (const d of r.drift) console.error(`  ${d.n} ${d.name}　${d.was} → ${d.now}`);
  process.exit(1);
}
if (!dryRun && after.ok && after.pending.length) {
  console.error('⚠ 还有未应用的迁移：' + after.pending.join(','));
  process.exit(1);
}
process.exit(0);
