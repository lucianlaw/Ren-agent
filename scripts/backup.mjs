#!/usr/bin/env node
/**
 * 跑一次备份。给 cron / 本机手动用，逻辑全在 lib/backup.js，
 * 这里只负责「参数、退出码、给人看的输出」。
 *
 *   node scripts/backup.mjs                 立刻备份一次
 *   node scripts/backup.mjs --keys          连密钥一起备份（末日恢复用）
 *   node scripts/backup.mjs --verify-only   只校验最新一份
 *   node scripts/backup.mjs --status        看状态（上一次成功是多久前）
 *
 * 退出码：0 成功 / 1 失败 / 2 用法错。cron 靠它判断要不要报警。
 */
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0;
};

const b = await import('../lib/backup.js');

const fmt = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / 1048576).toFixed(1)}MB`;
};

if (arg('status')) {
  const s = b.backupStatus();
  console.log(`目录：${s.dir}`);
  console.log(`份数：${s.count}（保留 ${s.keep} 份，每 ${s.hours} 小时一份）`);
  console.log(`上次成功：${s.lastAt || '从未'}`);
  if (s.ageHours !== null) console.log(`距今：${s.ageHours} 小时${s.stale ? '  ⚠ 已经超过计划间隔' : ''}`);
  if (s.lastError) console.log(`上次错误：${s.lastError}`);
  process.exit(s.count ? 0 : 1);
}

if (arg('verify-only')) {
  const latest = b.listBackups()[0];
  if (!latest) { console.log('还没有任何备份'); process.exit(1); }
  const v = b.verifyBackup(latest.file);
  console.log(v.ok ? `✔ ${latest.file} 校验通过（${v.files} 个文件）` : `✘ ${latest.file} 校验失败：${v.error}`);
  process.exit(v.ok ? 0 : 1);
}

const r = await b.runBackup({ reason: 'cli', includeSecrets: arg('keys') });
if (!r.ok) {
  console.error(`✘ 备份失败：${r.error}`);
  process.exit(1);
}
console.log(`✔ ${r.file}`);
console.log(`  ${r.files} 个文件，原始 ${fmt(r.rawBytes)} → 压缩后 ${fmt(r.bytes)}，用时 ${r.ms}ms`);
if (r.skipped) console.log(`  跳过 ${r.skipped} 项（空目录 / 符号链接 / 超大文件，见包内 manifest）`);
if (r.pruned?.removed?.length) console.log(`  轮转删掉 ${r.pruned.removed.length} 份旧备份`);
console.log(`  sha256 ${r.sha256}`);
