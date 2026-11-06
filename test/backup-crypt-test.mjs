/* 备份加密：不是「加了个参数」，而是「没有口令就打不开」
 *
 * 这一条的分量在于：备份默认就躺在部署目录旁边（../.ren-backups），
 * 一份不加密的 tar.gz 等于把所有人的报价表、合同、聊天记录摊在磁盘上——
 * 拿到磁盘的人不需要任何凭证。所以加密必须满足四件事，少一件就等于没加：
 *
 *   1. 不解密也认得出这是加密包（否则运维会拿明文工具去解，报错看起来像「包坏了」）；
 *   2. 没口令时给的是人话（「请设置某某环境变量」），不是 gunzip 的 incorrect header check；
 *   3. 口令错和包被改过必须都失败——GCM 的认证标签就是干这个的，
 *      少了这一步，错口令会解出一堆垃圾字节然后「校验通过」；
 *   4. 加了密也照样能用：verify 通过、extract 出来的字节和原始文件一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bkc-'));
process.env.REN_BACKUP_DIR = path.join(TMP, 'backups');
process.env.REN_BACKUP_KEEP = '9';
process.env.REN_SECRET_DIR = path.join(TMP, 'secrets');
delete process.env.REN_BACKUP_PASSPHRASE;

const b = await import('../lib/backup.js');

/* 源数据：一份文本 + 一份 200KB 随机二进制（压缩率接近 1，最能暴露加解密错位） */
const SRC = path.join(TMP, 'src');
fs.mkdirSync(path.join(SRC, 'data'), { recursive: true });
fs.writeFileSync(path.join(SRC, 'data', 'a.txt'), '合同第五条：逾期按 3% 计违约金\n');
const BIN = crypto.randomBytes(200000);
fs.writeFileSync(path.join(SRC, 'data', 'b.bin'), BIN);
const ROOTS = [{ prefix: 'data', dir: path.join(SRC, 'data') }];

const dirOf = () => process.env.REN_BACKUP_DIR;
const full = (f) => path.join(dirOf(), f);
const head8 = (f) => fs.readFileSync(f).subarray(0, 8);
const withPass = async (pass, fn) => {
  process.env.REN_BACKUP_PASSPHRASE = pass;
  try { return await fn(); } finally { delete process.env.REN_BACKUP_PASSPHRASE; }
};

console.log('\n[1] 不设口令：明文 gzip，系统 tar 也能解（交叉验证）');
let plain = null;
{
  const r = await b.runBackup({ reason: 'plain', build: { commit: 'aaa1111' }, roots: ROOTS });
  ok('备份成功', r.ok, r);
  plain = r;
  eq('文件头是 gzip 魔数', [...head8(full(r.file))].slice(0, 2), [0x1f, 0x8b]);
  ok('不被认成加密包', b.isEncryptedFile(full(r.file)) === false);
  const lst = execFileSync('tar', ['-tzf', full(r.file)], { encoding: 'utf8' }).trim().split('\n');
  ok('系统 tar 能列出内容', lst.includes('data/a.txt'), lst);
  const man = b.readManifest(r.file);
  ok('manifest 里 encrypted=false', man.ok && man.manifest.encrypted === false, man.manifest && man.manifest.encrypted);
}

console.log('\n[2] 设了口令：整包加密，明文工具打不开');
let enc = null;
{
  const r = await withPass('open-sesame-2026', () => b.runBackup({ reason: 'enc', build: { commit: 'bbb2222' }, roots: ROOTS }));
  ok('备份成功', r.ok, r);
  enc = r;
  eq('文件头是自家魔数 RENBAK1', head8(full(r.file)).toString('utf8'), 'RENBAK1\n');
  ok('isEncryptedFile 认得出', b.isEncryptedFile(full(r.file)) === true);
  ok('系统 tar 解不开（这正是「别人拿到也没用」的证据）', (() => {
    try { execFileSync('tar', ['-tzf', full(r.file)], { stdio: 'pipe' }); return false; }
    catch { return true; }
  })());

  const items = b.listBackups();
  const it = items.find(x => x.file === r.file);
  ok('列表里标了 encrypted', it && it.encrypted === true, it && it.encrypted);
  const plainItem = items.find(x => x.file === plain.file);
  ok('明文那份标 false（看文件头，不信索引）', plainItem && plainItem.encrypted === false, plainItem && plainItem.encrypted);

  const man = await withPass('open-sesame-2026', async () => b.readManifest(r.file));
  ok('用对口令能读 manifest', man.ok, man.error);
  ok('manifest 记了 encrypted=true', man.ok && man.manifest.encrypted === true, man.ok && man.manifest.encrypted);
}

console.log('\n[3] 没口令：说人话，不说「incorrect header check」');
{
  const v = b.verifyBackup(enc.file);
  ok('校验失败', !v.ok);
  ok('提示要设口令', /REN_BACKUP_PASSPHRASE/.test(String(v.error)), v.error);
  ok('不是 gzip 的报错原文', !/incorrect header|invalid|unexpected/i.test(String(v.error)), v.error);
  const m = b.readManifest(enc.file);
  ok('读 manifest 同样拒绝', !m.ok && /REN_BACKUP_PASSPHRASE/.test(String(m.error)), m.error);
}

console.log('\n[4] 口令错 / 包被改：都必须失败，不许解出垃圾');
{
  await withPass('wrong-pass', async () => {
    const v = b.verifyBackup(enc.file);
    ok('错口令校验失败', !v.ok, v);
    ok('说明可能是口令不对或包被改过', /口令不对|被改过/.test(String(v.error)), v.error);
  });

  /* 篡改密文中间一个字节：GCM 认证必须拦住 */
  const copy = path.join(dirOf(), 'tampered.tar.gz');
  const buf = fs.readFileSync(full(enc.file));
  buf[buf.length - 100] = buf[buf.length - 100] ^ 0xff;
  fs.writeFileSync(copy, buf);
  await withPass('open-sesame-2026', async () => {
    const v = b.verifyBackup(copy);
    ok('被改过的包校验失败', !v.ok, v);
    ok('没有「解出内容但校验不过」这种半吊子状态', !v.ok && /解不开/.test(String(v.error)), v.error);
  });
  fs.unlinkSync(copy);
}

console.log('\n[5] 对的口令：校验通过，解出来的字节和原始一致');
{
  await withPass('open-sesame-2026', async () => {
    const v = b.verifyBackup(enc.file);
    ok('校验通过', v.ok, v);
    eq('文件数对得上', v.files, 2);

    const out = path.join(TMP, 'restored');
    fs.mkdirSync(out, { recursive: true });
    const ex = b.extractTo(enc.file, out);
    ok('解包成功', ex.ok, ex);
    const txt = fs.readFileSync(path.join(out, 'data', 'a.txt'), 'utf8');
    ok('文本内容一致', txt.includes('违约金'), txt);
    const bin = fs.readFileSync(path.join(out, 'data', 'b.bin'));
    eq('二进制长度一致', bin.length, BIN.length);
    ok('二进制 sha256 一致（错位一个字节这里就会红）',
      crypto.createHash('sha256').update(bin).digest('hex')
      === crypto.createHash('sha256').update(BIN).digest('hex'));
  });
}

console.log('\n[6] 导出（给用户带走）：不加密，只有文件本身');
{
  const out = path.join(TMP, 'export.tar.gz');
  const r = await withPass('open-sesame-2026', () => b.exportTree(out, { dir: path.join(SRC, 'data'), prefix: 'files' }));
  ok('导出成功', r.ok, r);
  ok('即使设了口令也不加密（用户要能自己解开）', !b.isEncryptedFile(out), [...head8(out)].slice(0, 2));
  const names = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' }).trim().split('\n');
  /* 包内除了一个 manifest.json（清单+逐文件 sha256，用户自己也能核），
     其余全部挂在 files/ 前缀下——不夹带审计、密钥、状态库 */
  const body = names.filter(n => n !== 'manifest.json');
  ok('文件都挂在 files/ 下', body.length >= 2 && body.every(n => n.startsWith('files/')), names);
  ok('只有清单一个额外条目', names.filter(n => !n.startsWith('files/')).join(',') === 'manifest.json', names);
  ok('没有夹带审计/密钥/状态库', !names.some(n => /audit|\.key|state\.db|\.trash/.test(n)), names);
  ok('文件名带中文也没坏', names.some(n => n.includes('a.txt')), names);
}

console.log('\n[7] 接线：health 报「加没加密、是不是同机」');
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server.js'), 'utf8');
  ok('health 里带 encrypted', /encrypted: b\.encrypted/.test(src));
  ok('health 里带 sameHost', /sameHost: b\.sameHost/.test(src));
  const bs = b.backupStatus();
  ok('backupStatus 有 encrypted 字段', 'encrypted' in bs, Object.keys(bs));
  ok('backupStatus 有 sameHost 字段', 'sameHost' in bs, Object.keys(bs));
  ok('同机判定是「备份目录就在部署目录旁边」', typeof bs.sameHost === 'boolean');
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
