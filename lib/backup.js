/**
 * 备份：把「丢了就回不来」的东西打成一份可校验的快照。
 *
 * 为什么必须有这一层
 *   这个应用的全部状态就三处：data/（审计、告警、权限、额度）、workspace/（每个人的文件）、
 *   SECRET_DIR（签名密钥）。数据库是云的，代码在 git 里——唯独这三处，
 *   一次误删、一次 bad deploy、一次「清理一下磁盘」，就真的没有了。
 *   在此之前 `grep -r backup` 零命中，也就是说这件事从来没做过。
 *
 * 五个决定，每一个都是被这个项目的具体处境逼出来的：
 *
 * ① 备份放在部署目录之外（默认 ../.ren-backups）。
 *   部署 = 把整个目录压包上传。放在目录里的备份，会在下一次部署时跟着被覆盖或丢掉，
 *   而「部署出问题需要回滚数据」恰恰发生在那之后。和密钥同一个位置理由相同。
 *
 * ② 自己写 tar，不调系统 tar。
 *   理由不是「不想依赖」，而是两条具体的：路径里会有中文和空格，过 shell 引号是事故源；
 *   macOS 的 bsdtar 和 GNU tar 对长路径的处理不一致，备份在本地能解、线上解不开。
 *   自己写 512 字节头 + GNU longname 大约 80 行，两边行为一致。
 *
 * ③ 包内一定带 manifest（逐文件 sha256）。
 *   「备份成功」和「备份能用」是两件事。没有逐文件摘要，恢复前无法回答
 *   「这份包是完整的吗」——只能解开看运气。校验就是把 manifest 里的 sha256 重算一遍。
 *
 * ④ 密钥单独一份、单独标注。
 *   主包里放密钥等于「谁拿到备份谁就有签名能力」。所以默认不包含；需要完整灾备时
 *   用 { includeSecrets: true } 另出一份 .keys 包，manifest 里标 containsSecrets，
 *   恢复脚本必须显式 --with-keys 才肯用它。
 *
 * ⑤ 默认只留 7 份、每 24 小时一份。
 *   备份的价值在于「能回到昨天」，不在于「留住每一个小时」。保留策略不做，
 *   第一个月就会发现磁盘被自己的备份吃满了——那正是这一轮要解决的问题。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { secretDir, APP_ROOT } from './config.js';
import { WORKSPACE_BASE } from './workspace.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── 位置与参数 ── */
export function backupDir() {
  const custom = String(process.env.REN_BACKUP_DIR || '').trim();
  const dir = custom ? path.resolve(custom) : path.join(path.dirname(APP_ROOT), '.ren-backups');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* 下面会失败，交给调用方 */ }
  return dir;
}

const KEEP = () => Math.max(1, Number(process.env.REN_BACKUP_KEEP) || 7);
const HOURS = () => Math.max(0.1, Number(process.env.REN_BACKUP_HOURS) || 24);
const MAX_MB = () => Math.max(1, Number(process.env.REN_BACKUP_MAX_MB) || 600);

const INDEX = () => path.join(backupDir(), 'index.json');

/* 打包时跳过的目录名：依赖、git、临时目录、备份自己 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', '.ren-backups', 'backups', '__pycache__', '.cache']);
/* 单文件上限：超过的不进包（记在 skipped 里，而不是假装备过）。
   512MB 配额下这种文件只可能是有人故意塞进来的，硬背会把备份本身变成故障源。 */
const MAX_FILE = 128 * 1024 * 1024;

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
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    return false;
  }
}

/* ── tar 写入 ──
   ustar 头：name[100] mode[8] uid[8] gid[8] size[12] mtime[12] chksum[8]
             typeflag[1] linkname[100] magic[6] version[2] uname[32] gname[32]
             devmajor[8] devminor[8] prefix[155] pad[12]  = 512 字节 */
function octal(n, len) {
  /* 长度包含结尾的 \0：7 位八进制 + \0 是最通用的写法 */
  const s = Math.max(0, Math.floor(Number(n) || 0)).toString(8);
  return s.padStart(len - 1, '0').slice(0, len - 1) + '\0';
}

function header({ name, size, mode, mtime, type = '0' }) {
  const b = Buffer.alloc(512, 0);
  const nm = Buffer.from(name, 'utf8');
  nm.copy(b, 0, 0, Math.min(nm.length, 100));
  b.write(octal(mode || 0o644, 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(size, 12), 124, 'ascii');
  b.write(octal(Math.floor((mtime || Date.now()) / 1000), 12), 136, 'ascii');
  b.write('        ', 148, 'ascii');           // 校验和先填空格
  b.write(type, 156, 'ascii');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  b.write('ren', 265, 'ascii');
  b.write('ren', 297, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return b;
}

function pad512(n) {
  const r = n % 512;
  return r === 0 ? 0 : 512 - r;
}

/** GNU longname 块：名字超过 100 字节时先写一条 type 'L'，内容是完整名字 */
function longNameBlocks(name) {
  const nm = Buffer.from(name + '\0', 'utf8');
  const out = [header({ name: '././@LongLink', size: nm.length, mode: 0o644, mtime: 0, type: 'L' }), nm];
  const p = pad512(nm.length);
  if (p) out.push(Buffer.alloc(p, 0));
  return out;
}

/* ── 扫描 ──
   两遍：第一遍算清单（含 sha256），第二遍按清单流式写。
   为什么不合成一遍：manifest 要写在包的最前面才能「不解包就读到」，
   而 sha256 只有读完文件才知道。数据量在几十 MB 量级，多读一遍是值得的。 */
function* walk(root, rel = '') {
  let ents = [];
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
  ents.sort((a, b) => a.name.localeCompare(b.name));
  /* 空目录单独记一笔。tar 里目录是独立条目，这里没写，所以空目录不会进包——
     这不是 bug，是取舍：为一个空文件夹加一类条目（type '5'），读取端就要多一条分支，
     而恢复时上级目录本来就会 mkdir -p 建出来。记进 skipped 是为了让「备份里有 3 个空目录没进包」
     这件事在清单上看得见，而不是永远没人知道。 */
  if (rel && !ents.length) { yield { rel, emptyDir: true }; return; }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) { yield { rel: r, link: true }; continue; }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(root, r);
      continue;
    }
    if (!e.isFile()) continue;
    yield { rel: r, abs: path.join(root, r) };
  }
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * 收集要打包的条目。
 * @returns {{entries:Array, skipped:Array, bytes:number}}
 */
export function scan({ includeSecrets = false, roots = null } = {}) {
  const sources = roots || [
    { prefix: 'data', dir: path.join(APP, 'data') },
    { prefix: 'workspace', dir: WORKSPACE_BASE },
    ...(includeSecrets ? [{ prefix: 'secrets', dir: secretDir() }] : [])
  ];
  const entries = [];
  const skipped = [];
  let bytes = 0;

  for (const src of sources) {
    if (!fs.existsSync(src.dir)) continue;
    for (const it of walk(src.dir)) {
      if (it.emptyDir) { skipped.push({ path: `${src.prefix}/${it.rel}`, why: '空目录（恢复时自动建）' }); continue; }
      if (it.link) { skipped.push({ path: `${src.prefix}/${it.rel}`, why: '符号链接' }); continue; }
      let st;
      try { st = fs.statSync(it.abs); } catch { skipped.push({ path: `${src.prefix}/${it.rel}`, why: '读不到' }); continue; }
      if (st.size > MAX_FILE) {
        skipped.push({ path: `${src.prefix}/${it.rel}`, why: `单文件 ${(st.size / 1048576).toFixed(1)}MB 超过 128MB` });
        continue;
      }
      /* 备份目录自身如果被指到 app 里面，必须排除，否则会自我包含 */
      if (path.resolve(it.abs).startsWith(path.resolve(backupDir()) + path.sep)) continue;
      entries.push({
        name: `${src.prefix}/${it.rel}`,
        abs: it.abs,
        size: st.size,
        mode: st.mode & 0o777,
        mtime: st.mtimeMs || Date.now(),
        sha256: sha256File(it.abs)
      });
      bytes += st.size;
    }
  }
  return { entries, skipped, bytes };
}

/* ── 打包 ── */
async function writeTarGz(file, entries, manifest) {
  const tmp = `${file}.part`;
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  const done = pipeline(gz, out);

  /* 背压等待。注意必须把监听器摘掉：一个小文件要 write 三次，
     每个文件挂两个 once 监听器，几百个文件后就超过 EventEmitter 的默认 10 个上限，
     进程会刷一屏 MaxListenersExceededWarning——不影响结果，但会把真正的错误淹掉。 */
  const write = (buf) => new Promise((resolve, reject) => {
    if (gz.write(buf)) return resolve();
    const onDrain = () => { gz.removeListener('error', onErr); resolve(); };
    const onErr = (e) => { gz.removeListener('drain', onDrain); reject(e); };
    gz.once('drain', onDrain);
    gz.once('error', onErr);
  });

  try {
    /* manifest 放第一个：不解包就能读到做了什么、有哪些文件 */
    const mBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    for (const b of longNameBlocks('manifest.json')) await write(b);
    await write(header({ name: 'manifest.json', size: mBuf.length, mode: 0o600, mtime: Date.now() }));
    await write(mBuf);
    const mp = pad512(mBuf.length);
    if (mp) await write(Buffer.alloc(mp, 0));

    for (const e of entries) {
      if (Buffer.byteLength(e.name, 'utf8') > 100) {
        for (const b of longNameBlocks(e.name)) await write(b);
      }
      await write(header({ name: e.name, size: e.size, mode: e.mode, mtime: e.mtime }));
      if (e.size > 0) {
        /* 分块读写：把整个文件读进内存再写，遇到大附件会把进程撑爆 */
        const fd = fs.openSync(e.abs, 'r');
        try {
          const buf = Buffer.alloc(256 * 1024);
          let left = e.size;
          while (left > 0) {
            const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), null);
            if (!n) break;
            await write(buf.subarray(0, n));
            left -= n;
          }
        } finally { fs.closeSync(fd); }
        const p = pad512(e.size);
        if (p) await write(Buffer.alloc(p, 0));
      }
    }
    /* tar 结尾是两个全零块 */
    await write(Buffer.alloc(1024, 0));
    gz.end();
    await done;
    return tmp;
  } catch (e) {
    try { gz.destroy(); } catch { /* 忽略 */ }
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    throw e;
  }
}

/* ── 读取 ──
   解析器写成「整包解到内存再按偏移走」，不用流式：备份的量级在几十 MB，
   解进来完全放得下。流式版要处理跨 chunk 的头、跨 chunk 的填充、长名字块的状态机，
   每一处都能写错，而写错的后果是「恢复时读到一个错位的字节」——
   这种 bug 不会在备份时报错，只会在最需要它的那天暴露。慢一点是有意的取舍。 */
/* 上面的解析器对长名字的处理太绕，实际用到的场景只有「读 manifest」和「校验」。
   单独写一版更直白的：先把整个包解到内存（备份量级在 100MB 内可接受），再按偏移走。
   慢一点，但 correctness 比聪明重要——恢复读错一个字节，比慢十秒严重得多。 */
export function readTarGz(file, onEntry) {
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  let off = 0;
  let longName = '';
  const out = { entries: 0, bytes: 0 };
  while (off + 512 <= raw.length) {
    const h = raw.subarray(off, off + 512);
    off += 512;
    let zero = true;
    for (let i = 0; i < 512; i++) if (h[i] !== 0) { zero = false; break; }
    if (zero) break;

    const rawName = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0[\s\S]*$/, '').trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const body = raw.subarray(off, off + size);
    off += size + ((512 - (size % 512)) % 512);

    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    const name = longName || rawName;
    longName = '';
    if (type === '0' || type === '\0' || type === '') {
      onEntry(name, body);
      out.entries += 1;
      out.bytes += body.length;
    }
  }
  return out;
}

/* ── 索引 ── */
function loadIndex() {
  const j = readJson(INDEX(), { v: 1, items: [], lastAt: '', lastOkAt: '' });
  if (!Array.isArray(j.items)) j.items = [];
  return j;
}

function saveIndex(j) { return writeJson(INDEX(), j); }

/** 从包名取时间：ren-20261105T160500Z-<commit>.tar.gz */
function stampName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T`
    + `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function listBackups() {
  const j = loadIndex();
  let files = [];
  try { files = fs.readdirSync(backupDir()).filter(f => /\.tar\.gz$/.test(f)); } catch { files = []; }
  const known = new Map(j.items.map(it => [it.file, it]));
  const out = files.map((f) => {
    const full = path.join(backupDir(), f);
    let st = null;
    try { st = fs.statSync(full); } catch { /* 刚被删 */ }
    const meta = known.get(f) || {};
    return {
      file: f,
      bytes: st ? st.size : 0,
      at: meta.at || (st ? st.mtime.toISOString() : ''),
      files: meta.files || 0,
      sha256: meta.sha256 || '',
      build: meta.build || '',
      reason: meta.reason || '',
      containsSecrets: !!meta.containsSecrets,
      verifiedAt: meta.verifiedAt || '',
      verifyOk: meta.verifyOk === undefined ? null : meta.verifyOk,
      manifest: meta.manifest || null
    };
  });
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

/* ── 备份 ── */
let LOCK = false;

/**
 * 跑一次备份。
 * @param {object} opts { reason, includeSecrets, build, now }
 * @returns {Promise<{ok:boolean, file?:string, bytes?:number, files?:number, error?:string}>}
 */
export async function runBackup(opts = {}) {
  if (LOCK) return { ok: false, error: '上一次备份还没结束' };
  LOCK = true;
  const started = Date.now();
  try {
    const dir = backupDir();
    const build = opts.build || readJson(path.join(APP, 'build.json'), {}) || {};
    const includeSecrets = !!opts.includeSecrets;
    /* roots 只给测试和「只备某棵树」用；线上走默认的三棵树 */
    const scanRes = scan({ includeSecrets, roots: opts.roots || null });

    const bytes = scanRes.entries.reduce((s, e) => s + e.size, 0);
    /* 空包必须当失败，不能当成功。
       这不是洁癖：一次「0 个文件」的备份会走进轮转、把一份真正有用的旧备份挤掉，
       于是「备份成功」的这个动作，实际效果是删掉了一份好的。 */
    if (!scanRes.entries.length) {
      return { ok: false, error: '没有任何可备份的文件（data/ 和 workspace/ 都是空的或读不到）' };
    }
    if (bytes > MAX_MB() * 1024 * 1024) {
      return {
        ok: false,
        error: `待备份数据 ${(bytes / 1048576).toFixed(0)}MB 超过单份上限 ${MAX_MB()}MB，`
          + '请先清理工作区，或用 REN_BACKUP_MAX_MB 调高'
      };
    }

    const at = new Date();
    const commit = String(build.commit || '').slice(0, 8) || 'nogit';
    const file = path.join(dir, `ren-${stampName(at)}-${commit}${includeSecrets ? '.keys' : ''}.tar.gz`);

    const manifest = {
      v: 1,
      at: at.toISOString(),
      app: { commit: build.commit || '', version: build.version || '', at: build.at || '' },
      host: os.hostname(),
      includeSecrets,
      containsSecrets: includeSecrets,
      bytes,
      files: scanRes.entries.length,
      entries: scanRes.entries.map(e => ({ name: e.name, size: e.size, sha256: e.sha256 })),
      skipped: scanRes.skipped
    };

    const tmp = await writeTarGz(file, scanRes.entries, manifest);
    const st = fs.statSync(tmp);
    if (st.size === 0) {
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      return { ok: false, error: '打出来的包是空的' };
    }
    fs.renameSync(tmp, file);
    const sha = sha256File(file);

    const j = loadIndex();
    j.items = j.items.filter(it => it.file !== path.basename(file));
    j.items.push({
      file: path.basename(file),
      at: at.toISOString(),
      bytes: st.size,
      rawBytes: bytes,
      files: scanRes.entries.length,
      sha256: sha,
      build: build.commit || '',
      reason: String(opts.reason || 'manual'),
      containsSecrets: includeSecrets,
      manifest: { skipped: scanRes.skipped.length, host: os.hostname() }
    });
    j.lastAt = at.toISOString();
    j.lastOkAt = at.toISOString();
    j.lastError = '';
    saveIndex(j);

    const pruned = prune();
    return {
      ok: true, file: path.basename(file), path: file, bytes: st.size, rawBytes: bytes,
      files: scanRes.entries.length, sha256: sha, ms: Date.now() - started,
      skipped: scanRes.skipped.length, pruned
    };
  } catch (e) {
    const j = loadIndex();
    j.lastAt = new Date().toISOString();
    j.lastError = String((e && e.message) || e).slice(0, 300);
    saveIndex(j);
    return { ok: false, error: j.lastError };
  } finally {
    LOCK = false;
  }
}

/** 校验：把 manifest 里的 sha256 全部重算一遍。恢复前的唯一凭据。 */
export function verifyBackup(file) {
  const full = path.isAbsolute(file) ? file : path.join(backupDir(), file);
  if (!fs.existsSync(full)) return { ok: false, error: '这个备份文件不存在' };
  let manifest = null;
  const seen = new Map();
  try {
    readTarGz(full, (name, body) => {
      if (name === 'manifest.json' && !manifest) {
        try { manifest = JSON.parse(body.toString('utf8')); } catch { /* 下面会报 */ }
        return;
      }
      seen.set(name, crypto.createHash('sha256').update(body).digest('hex'));
    });
  } catch (e) {
    return { ok: false, error: `包解不开：${(e && e.message) || e}` };
  }
  if (!manifest || !Array.isArray(manifest.entries)) {
    return { ok: false, error: '包里没有 manifest，无法校验完整性' };
  }
  const bad = [];
  const missing = [];
  for (const e of manifest.entries) {
    const got = seen.get(e.name);
    if (got === undefined) { missing.push(e.name); continue; }
    if (got !== e.sha256) bad.push(e.name);
  }
  const extra = [...seen.keys()].filter(n => !manifest.entries.some(e => e.name === n));
  const ok = !bad.length && !missing.length;
  const j = loadIndex();
  const it = j.items.find(x => x.file === path.basename(full));
  if (it) {
    it.verifiedAt = new Date().toISOString();
    it.verifyOk = ok;
    saveIndex(j);
  }
  return {
    ok, files: manifest.entries.length, checked: seen.size,
    bad: bad.slice(0, 20), missing: missing.slice(0, 20), extra: extra.slice(0, 20),
    at: manifest.at, containsSecrets: !!manifest.containsSecrets,
    error: ok ? '' : `有 ${bad.length} 个文件内容不一致、${missing.length} 个缺失`
  };
}

/** 只读 manifest（不解全包的内容校验），给列表页显示「包里有什么」 */
export function readManifest(file) {
  const full = path.isAbsolute(file) ? file : path.join(backupDir(), file);
  let manifest = null;
  try {
    readTarGz(full, (name, body) => {
      if (name === 'manifest.json' && !manifest) {
        try { manifest = JSON.parse(body.toString('utf8')); } catch { /* 忽略 */ }
      }
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (!manifest) return { ok: false, error: '包里没有 manifest' };
  return { ok: true, manifest };
}

/** 保留策略：只留最近 KEEP 份。删的时候连 manifest 里的记录一起清。 */
export function prune() {
  const keep = KEEP();
  const items = listBackups();
  if (items.length <= keep) return { removed: [] };
  const removed = [];
  for (const it of items.slice(keep)) {
    try {
      fs.unlinkSync(path.join(backupDir(), it.file));
      removed.push(it.file);
    } catch { /* 删不掉就留着，下次再说 */ }
  }
  if (removed.length) {
    const j = loadIndex();
    const keepNames = new Set(items.slice(0, keep).map(x => x.file));
    j.items = j.items.filter(x => keepNames.has(x.file));
    saveIndex(j);
  }
  return { removed };
}

/** 给 /api/health 与运维页的一句话状态 */
export function backupStatus() {
  const j = loadIndex();
  const items = listBackups();
  const last = items[0] || null;
  const ageMs = last && last.at ? Date.now() - Date.parse(last.at) : -1;
  return {
    dir: backupDir(),
    count: items.length,
    keep: KEEP(),
    hours: HOURS(),
    lastAt: j.lastOkAt || '',
    lastError: j.lastError || '',
    /* 定时器的体检指标。
       起因是一次真实的误判：日志里写着「每 24 小时检查一次」，而目录里一份也没有，
       分不清是「还没到期」还是「定时器压根没跑」。这两个数字能直接回答：
       checks 一直不涨 = 定时器没跑；checks 涨而 lastCheckAt 不新 = 进程被反复重启。 */
    checks: Number(j.checks) || 0,
    lastCheckAt: j.lastCheckAt || '',
    ageHours: ageMs >= 0 ? Math.round(ageMs / 3600000 * 10) / 10 : null,
    /* 「多久没备份了」比「备份了几份」更能说明问题：
       七份都是上个月的，等于没有备份。 */
    stale: ageMs < 0 ? true : ageMs > HOURS() * 3600 * 1000 * 1.5,
    latest: last,
    items: items.slice(0, 10)
  };
}

/* ── 定时 ── */
let timer = null;

/**
 * 起一个「该备就备」的定时器。
 * 不是 setInterval(24h)：进程重启会把它重置，于是每次部署都从零开始算，
 * 部署勤的那几天永远等不到一次备份。改成每 10 分钟检查一次「距上次成功是否超过 HOURS」，
 * 判断依据是落盘的 index，重启不影响。
 */
export function scheduleBackups({ build = null, tickMs = 10 * 60 * 1000 } = {}) {
  if (timer) return { ok: true, already: true };
  const check = async () => {
    try {
      const j = loadIndex();
      const lastMs = j.lastOkAt ? Date.parse(j.lastOkAt) : 0;
      /* 先把「我检查过了」写下去，再判断要不要备份。
         顺序反了的话，「检查过但没到期」和「没检查过」在磁盘上长得一模一样。 */
      j.checks = (Number(j.checks) || 0) + 1;
      j.lastCheckAt = new Date().toISOString();
      saveIndex(j);
      if (Date.now() - lastMs < HOURS() * 3600 * 1000) return;
      const r = await runBackup({ reason: 'scheduled', build });
      if (r.ok) console.log(`[backup] 已备份 ${r.file}（${r.files} 个文件，${(r.bytes / 1048576).toFixed(1)}MB）`);
      else console.error(`[backup] 备份失败：${r.error}`);
    } catch (e) {
      console.error(`[backup] 定时检查出错：${(e && e.message) || e}`);
    }
  };
  /* 启动后第一次检查的时间。
     默认 90 秒：让服务先把请求接住，备份不该和冷启动抢 IO。
     但「一份备份都没有」时不等这么久——那是真实发生过的一次：
     4 分钟里连发 3 次部署，每次重启都把 90 秒的计时重置，于是一整天下来
     一份备份也没有，而日志上写着「每 10 分钟检查一次」，看不出问题。
     已经有备份的时候才值得等，因为最坏情况也只是晚 90 秒。
     REN_BACKUP_FIRST_MS 是为了让测试能在几秒内验到「定时器真的会跑」。 */
  const everBacked = !!loadIndex().lastOkAt;
  const def = everBacked ? 90 * 1000 : 10 * 1000;
  const firstMs = Math.max(0, Number(process.env.REN_BACKUP_FIRST_MS || def));
  setTimeout(check, firstMs).unref?.();
  timer = setInterval(check, tickMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { ok: true, hours: HOURS(), keep: KEEP(), dir: backupDir() };
}

export function stopScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * 恢复到指定目录（不碰现场）。scripts/restore.mjs 用它，
 * 校验通过之后才由脚本自己做替换——把「解开」和「覆盖线上」分开，
 * 是因为一旦写在一起，就没法先看一眼「这个包到底对不对」。
 */
export function extractTo(file, destDir, { withKeys = false } = {}) {
  const full = path.isAbsolute(file) ? file : path.join(backupDir(), file);
  if (!fs.existsSync(full)) return { ok: false, error: '备份文件不存在' };
  let manifest = null;
  let n = 0;
  try {
    readTarGz(full, (name, body) => {
      if (name === 'manifest.json') {
        try { manifest = JSON.parse(body.toString('utf8')); } catch { /* 忽略 */ }
        return;
      }
      if (!/^(data|workspace|secrets)\//.test(name)) return;   // 只认这三棵树
      if (name.startsWith('secrets/') && !withKeys) return;
      if (name.includes('..')) return;
      const target = path.join(destDir, name);
      if (!path.resolve(target).startsWith(path.resolve(destDir) + path.sep)) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      n += 1;
    });
  } catch (e) {
    return { ok: false, error: `解包失败：${(e && e.message) || e}` };
  }
  return { ok: true, files: n, manifest, dir: destDir, skippedSecrets: !withKeys && !!(manifest && manifest.containsSecrets) };
}

export const __test = {
  header, octal, longNameBlocks, stampName, SKIP_DIRS,
  resetLock() { LOCK = false; }
};
