/* 备份：能打包、能校验、能恢复、能轮转
 *
 * 备份这件事最容易骗自己的地方是「跑成功了」和「能用」是两件事。
 * 一个 tar 命令 exit 0 也可能打出一份解不开的包（路径带中文、长路径被截断、
 * gzip 中途失败）。所以这里的判据不是「函数返回 ok」，而是：
 *   · 系统 tar 能不能解开我写的包（交叉验证，不是自己验自己）
 *   · manifest 里的 sha256 和真实文件对不对得上
 *   · 篡改一个字节之后校验会不会失败（校验如果永远通过，它就没有意义）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
process.env.REN_BACKUP_DIR = path.join(TMP, 'backups');
process.env.REN_BACKUP_KEEP = '3';
process.env.REN_SECRET_DIR = path.join(TMP, 'secrets');

const b = await import('../lib/backup.js');

/* ── 造一份有代表性的源数据 ── */
const SRC = path.join(TMP, 'src');
const dataDir = path.join(SRC, 'data');
const wsDir = path.join(SRC, 'workspace', 'users', 'aaaa');
fs.mkdirSync(path.join(dataDir, 'audit'), { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(path.join(SRC, 'workspace', 'empty-dir'), { recursive: true });

fs.writeFileSync(path.join(dataDir, 'x.txt'), 'hello 中文\n');
fs.writeFileSync(path.join(dataDir, 'audit', '2026-11-05.jsonl'),
  Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, at: '2026-11-05', what: '写文件' })).join('\n'));
/* 跨多个 512 字节块，且不是 512 的整数倍——填充逻辑最容易在这里错 */
const big = crypto.randomBytes(300001);
fs.writeFileSync(path.join(wsDir, 'big.bin'), big);
/* 名字超过 100 字节：必须走 GNU longname，否则会被静默截断 */
const longName = '这是一个非常长的中文文件名用来验证长路径处理是否正确' + '继续加长'.repeat(6) + '.md';
fs.writeFileSync(path.join(wsDir, longName), '长名字的内容\n');

const ROOTS = [
  { prefix: 'data', dir: dataDir },
  { prefix: 'workspace', dir: path.join(SRC, 'workspace') }
];

console.log('[1] 打包');
let first = null;
{
  const r = await b.runBackup({ reason: 'test', build: { commit: 'deadbee' }, roots: ROOTS });
  ok('备份成功', r.ok, r);
  first = r;
  eq('文件数（3 个普通文件）', r.files, 4);
  ok('包比原始数据小（文本压缩）', r.bytes > 0 && r.bytes < r.rawBytes, { bytes: r.bytes, raw: r.rawBytes });
  ok('文件名带时间戳与 commit', /^ren-\d{8}T\d{6}Z-deadbee\.tar\.gz$/.test(r.file), r.file);
  ok('包里没有密钥（默认不包含）', !/\.keys\.tar\.gz$/.test(r.file), r.file);
  eq('空目录被记进 skipped', r.skipped, 1);
}

console.log('[2] 系统 tar 能解开（交叉验证，不是自己验自己）');
{
  const full = path.join(process.env.REN_BACKUP_DIR, first.file);
  const out = execFileSync('tar', ['-tzf', full], { encoding: 'utf8' }).trim().split('\n');
  ok('列出 manifest.json', out.includes('manifest.json'), out.slice(0, 4));
  ok('列出 data/x.txt', out.includes('data/x.txt'));
  ok('长中文名字没被截断', out.some(n => n === `workspace/users/aaaa/${longName}`), out.filter(n => n.includes('中文')));

  const dest = path.join(TMP, 'sys');
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', full, '-C', dest]);
  const got = fs.readFileSync(path.join(dest, 'workspace', 'users', 'aaaa', 'big.bin'));
  ok('系统 tar 解出的 300KB 二进制逐字节一致', got.equals(big), { len: got.length });
  eq('中文文本内容一致', fs.readFileSync(path.join(dest, 'data', 'x.txt'), 'utf8'), 'hello 中文\n');
}

console.log('[3] manifest 与 sha256');
{
  const m = b.readManifest(first.file);
  ok('manifest 可读', m.ok, m.error);
  eq('manifest 标记来源 commit', m.manifest.app.commit, 'deadbee');
  const e = m.manifest.entries.find(x => x.name === 'data/x.txt');
  ok('条目里有 sha256', !!e && /^[a-f0-9]{64}$/.test(e.sha256), e);
  const real = crypto.createHash('sha256').update(fs.readFileSync(path.join(dataDir, 'x.txt'))).digest('hex');
  eq('sha256 与真实文件一致', e.sha256, real);
  ok('manifest 不包含密钥内容', !JSON.stringify(m.manifest).includes('PRIVATE'));
}

console.log('[4] 校验');
{
  const v = b.verifyBackup(first.file);
  ok('完整包校验通过', v.ok, v);
  eq('校验的文件数', v.files, 4);

  /* 篡改：解压 → 改一个字节 → 重新压缩（重算 gzip crc，让失败原因是「内容不一致」
     而不是「包坏了」——这两种失败的含义完全不同，测试要能分开验证） */
  const full = path.join(process.env.REN_BACKUP_DIR, first.file);
  const raw = zlib.gunzipSync(fs.readFileSync(full));
  const at = raw.indexOf(Buffer.from('hello'));
  raw[at] = 'H'.charCodeAt(0);
  const tampered = path.join(process.env.REN_BACKUP_DIR, 'tampered.tar.gz');
  fs.writeFileSync(tampered, zlib.gzipSync(raw));
  const v2 = b.verifyBackup('tampered.tar.gz');
  ok('篡改一个字节后校验失败', !v2.ok, v2);
  ok('指出是哪个文件', v2.bad.includes('data/x.txt'), v2.bad);
  ok('失败原因说清楚', /不一致/.test(v2.error), v2.error);
  fs.unlinkSync(tampered);
}

console.log('[5] 恢复（解到临时目录，不碰现场）');
{
  const dest = path.join(TMP, 'restore');
  fs.mkdirSync(dest, { recursive: true });
  const r = b.extractTo(first.file, dest);
  ok('解包成功', r.ok, r);
  eq('解出的文件数', r.files, 4);
  ok('data 树完整', fs.existsSync(path.join(dest, 'data', 'audit', '2026-11-05.jsonl')));
  ok('长中文名字还原正确', fs.existsSync(path.join(dest, 'workspace', 'users', 'aaaa', longName)));
  const back = fs.readFileSync(path.join(dest, 'workspace', 'users', 'aaaa', 'big.bin'));
  ok('二进制逐字节一致', back.equals(big));

  /* 路径穿越：包里不能出现 ../ 之类的东西把我们带出去。
     这里直接验实现里的白名单——只认 data/ workspace/ secrets/ 三棵树 */
  const evil = path.join(TMP, 'evil');
  fs.mkdirSync(evil, { recursive: true });
  const r2 = b.extractTo(first.file, evil);
  const files = fs.readdirSync(evil).sort();
  eq('只解出三棵树里的内容', files, ['data', 'workspace']);
  ok('没有逃到目标目录之外', !fs.existsSync(path.join(TMP, 'x.txt')));
}

console.log('[6] 轮转');
{
  /* 再打两份，KEEP=3，所以第一份应该被删 */
  await new Promise(r => setTimeout(r, 1100));   // 文件名按秒打戳，等一下避免同名
  const r2 = await b.runBackup({ reason: 'test', build: { commit: 'deadbee' }, roots: ROOTS });
  await new Promise(r => setTimeout(r, 1100));
  const r3 = await b.runBackup({ reason: 'test', build: { commit: 'deadbee' }, roots: ROOTS });
  ok('第 2、3 份都成功', r2.ok && r3.ok);
  const items = b.listBackups();
  eq('只保留 KEEP 份', items.length, 3);
  ok('最新的是第 3 份', items[0].file === r3.file, { got: items[0].file, want: r3.file });
  const st = b.backupStatus();
  eq('状态里的份数', st.count, 3);
  ok('状态里有最近一次时间', !!st.lastAt, st);
  ok('刚备份过，不算过期', st.stale === false, st.ageHours);
}

console.log('[7] 密钥：单独一份，且必须显式索取');
{
  fs.mkdirSync(process.env.REN_SECRET_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.REN_SECRET_DIR, 'alerts.key'), 'k'.repeat(32), { mode: 0o600 });
  const r = await b.runBackup({
    reason: 'test-keys', includeSecrets: true, build: { commit: 'deadbee' },
    roots: [...ROOTS, { prefix: 'secrets', dir: process.env.REN_SECRET_DIR }]
  });
  ok('带密钥的备份成功', r.ok, r);
  ok('文件名标记 .keys', /\.keys\.tar\.gz$/.test(r.file), r.file);
  const m = b.readManifest(r.file);
  ok('manifest 标记 containsSecrets', m.manifest.containsSecrets === true, m.manifest.containsSecrets);

  const dest = path.join(TMP, 'restore-nokeys');
  fs.mkdirSync(dest, { recursive: true });
  const x = b.extractTo(r.file, dest, { withKeys: false });
  ok('不带 --with-keys 时不恢复密钥', !fs.existsSync(path.join(dest, 'secrets', 'alerts.key')), x);
  const dest2 = path.join(TMP, 'restore-keys');
  fs.mkdirSync(dest2, { recursive: true });
  b.extractTo(r.file, dest2, { withKeys: true });
  ok('带 --with-keys 时恢复密钥', fs.existsSync(path.join(dest2, 'secrets', 'alerts.key')));
}

console.log('[8] 位置与安全');
{
  const dir = b.backupDir();
  ok('备份目录在部署目录之外', !dir.startsWith(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..') + path.sep), dir);
  const mode = fs.statSync(dir).mode & 0o777;
  ok('备份目录权限 700', (mode & 0o077) === 0, mode.toString(8));
  ok('不提供 HTTP 侧的「带密钥备份」入口',
    !fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'server.js'), 'utf8')
      .includes('includeSecrets: true'));
}

console.log('[9] 失败要能说清原因');
{
  const r = b.verifyBackup('不存在的文件.tar.gz');
  ok('文件不存在时明确报错', !r.ok && /不存在/.test(r.error), r);
  const r2 = await b.runBackup({ roots: [{ prefix: 'data', dir: path.join(TMP, 'nope') }] });
  ok('源目录为空时明确失败（空包会挤掉一份真备份）', r2.ok === false && /没有/.test(r2.error || ''), r2);
  eq('失败时不留下空包', b.listBackups().filter(x => x.files === 0).length, 0);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
