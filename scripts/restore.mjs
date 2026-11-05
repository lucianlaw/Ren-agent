#!/usr/bin/env node
/**
 * 从一份备份恢复。
 *
 * 为什么恢复要单独一个脚本、而不是再挂一个 HTTP 接口
 *   恢复是唯一一个「一次操作就能把线上打回昨天」的动作。它不应该能被
 *   「一个带着凭证的请求」触发——凭证会泄漏、会被误用、会在浏览器里点错。
 *   放在命令行里，意味着做这件事的人必须能登进机器、必须手打文件名、
 *   必须自己加 --yes。摩擦在这里是功能，不是缺陷。
 *
 * 安全顺序（每一步失败都停，不往下走）：
 *   1. 校验 sha256 —— 包不完整就到此为止，绝不往线上写
 *   2. 先给当前状态拍一份 pre-restore 备份 —— 恢复本身也可能是错的
 *   3. 解到临时目录 —— 解包失败也不会污染现场
 *   4. 只在这之后才替换文件，且默认是「合并覆盖」，不是「清空重来」
 *
 * 用法：
 *   node scripts/restore.mjs --list
 *   node scripts/restore.mjs --verify ren-20261105T160500Z-abc1234.tar.gz
 *   node scripts/restore.mjs --file ren-....tar.gz --dry-run
 *   node scripts/restore.mjs --file ren-....tar.gz --yes
 *   node scripts/restore.mjs --file ren-....keys.tar.gz --with-keys --yes
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
process.env.REN_BACKUP_DIR ||= '';

const b = await import('../lib/backup.js');
const { WORKSPACE_BASE } = await import('../lib/workspace.js');

function arg(name, dflt = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const has = (n) => process.argv.includes(`--${n}`);

const fmt = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / 1048576).toFixed(1)}MB`;
};

/* ── --list ── */
if (has('list')) {
  const items = b.listBackups();
  console.log(`备份目录：${b.backupDir()}`);
  console.log(`保留策略：最多 ${b.backupStatus().keep} 份，每 ${b.backupStatus().hours} 小时一份\n`);
  if (!items.length) {
    console.log('（还没有任何备份）');
    process.exit(0);
  }
  console.log('时间                 大小      文件数  校验  含密钥  文件');
  for (const it of items) {
    const v = it.verifyOk === null ? '未验' : (it.verifyOk ? '通过' : '失败');
    console.log(
      `${String(it.at).slice(0, 19).replace('T', ' ')}  ${fmt(it.bytes).padStart(8)}  `
      + `${String(it.files).padStart(6)}  ${v.padEnd(4)}  ${it.containsSecrets ? ' 是 ' : ' 否 '}   ${it.file}`
    );
  }
  process.exit(0);
}

/* ── --verify ── */
const verifyOnly = arg('verify');
if (verifyOnly && verifyOnly !== 'true') {
  const r = b.verifyBackup(verifyOnly);
  console.log(r.ok ? `✔ 校验通过：${r.files} 个文件全部一致` : `✘ 校验失败：${r.error}`);
  if (!r.ok) {
    if (r.bad?.length) console.log('  内容不一致：' + r.bad.join(', '));
    if (r.missing?.length) console.log('  缺失：' + r.missing.join(', '));
  }
  process.exit(r.ok ? 0 : 1);
}

/* 没给 --file 时用最新一份，但要用户明确加 --latest */
const file = arg('file') || (has('latest') ? (b.listBackups()[0] || {}).file : '');
if (!file) {
  console.error('用法：node scripts/restore.mjs --list | --verify <文件> | --file <文件> [--dry-run] [--yes]');
  console.error(`备份目录：${b.backupDir()}`);
  process.exit(2);
}

const withKeys = has('with-keys');
const dry = has('dry-run');
const full = path.isAbsolute(file) ? file : path.join(b.backupDir(), file);

console.log(`备份文件：${full}`);
if (!fs.existsSync(full)) {
  console.error('✘ 文件不存在');
  process.exit(2);
}

/* 1. 校验 */
console.log('\n[1/4] 校验完整性…');
const v = b.verifyBackup(full);
if (!v.ok) {
  console.error(`✘ 校验没通过：${v.error}`);
  console.error('  这个包不能用来恢复。如果确认只是校验环节出了问题，请人工核对后再处理。');
  process.exit(1);
}
console.log(`  ✔ ${v.files} 个文件全部一致（备份时间 ${v.at}）`);
if (v.containsSecrets && !withKeys) {
  console.log('  提示：这份包包含密钥，但没有加 --with-keys，恢复时会跳过密钥。');
}

/* 2. 目标位置 */
const target = path.resolve(arg('to', APP));
const wsDir = path.resolve(arg('workspace', String(WORKSPACE_BASE)));
const plan = [
  { prefix: 'data', dest: path.join(target, 'data') },
  { prefix: 'workspace', dest: wsDir },
  ...(withKeys ? [{ prefix: 'secrets', dest: path.resolve(arg('secrets', path.join(path.dirname(target), '.ren-secrets'))) }] : [])
];
console.log('\n[2/4] 恢复目标：');
for (const p of plan) console.log(`  ${p.prefix.padEnd(10)} → ${p.dest}`);
if (dry) {
  console.log('\n--dry-run：到此为止，没有写任何东西。去掉 --dry-run 并加 --yes 才会真的恢复。');
  process.exit(0);
}
if (!has('yes')) {
  console.error('\n✘ 恢复会覆盖线上数据，必须显式加 --yes。');
  process.exit(2);
}

/* 3. pre-restore 备份：恢复本身也可能是错的，得留一条回头路 */
console.log('\n[3/4] 先给当前状态拍一份备份…');
const pre = await b.runBackup({ reason: 'pre-restore' });
if (!pre.ok) {
  console.error(`✘ 当前状态的备份失败：${pre.error}`);
  console.error('  为了不出现「恢复了一半、又回不去」的局面，这里停下。');
  process.exit(1);
}
console.log(`  ✔ ${pre.file}（${pre.files} 个文件，${fmt(pre.bytes)}）`);

/* 4. 解包 → 覆盖 */
console.log('\n[4/4] 解包并覆盖…');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-restore-'));
let res;
try {
  res = b.extractTo(full, tmp, { withKeys });
  if (!res.ok) throw new Error(res.error);
  console.log(`  ✔ 解出 ${res.files} 个文件到临时目录`);

  let copied = 0;
  for (const p of plan) {
    const from = path.join(tmp, p.prefix);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(p.dest, { recursive: true });
    /* -a 保留时间与权限；不带 --delete，是「合并覆盖」而不是「清空重来」——
       备份之后新产生的文件不会被这份旧快照抹掉。真要回到完全一致的状态，
       应该恢复到一个空目录再切过去（--to 参数就是为此留的）。 */
    execFileSync('cp', ['-a', `${from}/.`, p.dest], { stdio: 'inherit' });
    copied += 1;
    console.log(`  ✔ ${p.prefix} → ${p.dest}`);
  }
  if (!copied) throw new Error('包里没有任何可恢复的目录');
} catch (e) {
  console.error(`✘ 恢复失败：${e.message}`);
  console.error(`  现场没有被清空；当前状态的备份在 ${pre.file}`);
  process.exit(1);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('\n完成。');
console.log(`  恢复到：${target}`);
console.log(`  恢复前的状态：${pre.file}（要退回就用它再跑一次）`);
console.log('\n下一步：重启服务让它重新扫描工作区。密钥没恢复的话，图片/下载链接会需要重新签发。');
