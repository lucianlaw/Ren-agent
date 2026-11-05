/**
 * 配置与密钥的唯一出口。
 *
 * 起因：部署 = 把整个目录压缩上传。放在目录里的一切——包括密钥——会同时出现在
 * 三个地方：本机磁盘、上传的压缩包、线上容器。压缩包一旦被分享或下载，
 * 「只是运维用的 key」就变成了公开口令；而本地和线上共用同一把密钥，
 * 意味着本机跑的任何脚本都能伪造线上的文件签名。
 *
 * 所以凭证不放在部署目录里，放在 SECRET_DIR：
 *   默认 = 部署目录的上一级/.ren-secrets（权限 0700，文件 0600）
 *   可用 REN_SECRET_DIR 覆盖；staging 与生产各用各的目录。
 *
 * 取值优先级：环境变量 > SECRET_DIR 下的文件 > 首次生成（只有 create:true 才生成）。
 * 环境变量优先是为了在平台侧能直接注入而不落盘；文件次之是为了重启后仍然一致。
 *
 * 迁移：三处历史位置（workspace/.authn.key、data/alerts/.key、根 self-token.json）
 * 在第一次读到时自动搬进 SECRET_DIR 并删掉原位。不这么做的话，升级当天
 * 所有人的图片链接会集体失效、告警定时任务会开始 403。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, '..');

/* 测试进程绝不写真实密钥目录。
   起因是一次真实事故：跑全量测试时，某个测试启动的 server 在真实密钥目录里
   生成了一把 alerts.key；随后本机执行迁移时「文件已存在」直接返回，
   于是本机这把和线上那把不是同一个值——告警定时任务会静默 403。
   入口是 test/*.mjs 时，把 REN_SECRET_DIR 指到临时目录；子进程 spawn 时
   继承 env，所以它们也跟着走临时目录，不用逐个测试文件去改。 */
const ENTRY = String(process.argv[1] || '');
if (!process.env.REN_SECRET_DIR && /[\\/]test[\\/][^\\/]+\.mjs$/.test(ENTRY)) {
  process.env.REN_SECRET_DIR = path.join(os.tmpdir(), 'ren-secrets-test');
}

/* 内存缓存：同一进程内只解析一次。key 是逻辑名，不是路径。 */
const cache = new Map();
const sources = new Map();

function envDir() {
  return String(process.env.REN_SECRET_DIR || '').trim();
}

/* 密钥目录。默认刻意选在部署目录之外——这是这个文件存在的全部理由。 */
export function secretDir() {
  const custom = envDir();
  const dir = custom || path.join(path.dirname(APP_ROOT), '.ren-secrets');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { /* 下面写文件时还会失败，交给调用方按值降级 */ }
  return dir;
}

export function secretDirInfo() {
  const dir = secretDir();
  return {
    path: dir,
    /* 落回默认位置说明「与部署目录同级」，这是设计意图，不是错误 */
    custom: !!envDir(),
    outsideApp: !dir.startsWith(APP_ROOT + path.sep)
  };
}

function readTrim(file) {
  try {
    return String(fs.readFileSync(file, 'utf8')).trim();
  } catch { return ''; }
}

function write0600(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, value, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* 有的文件系统不支持，忽略 */ }
    return true;
  } catch { return false; }
}

/* 把历史位置的密钥搬到 SECRET_DIR。
   pick 用于老文件不是纯文本的场合（比如 self-token.json 是个 JSON）。

   默认**只复制不删除**。原设计是「搬走并删掉原位」，但那件事在测试进程里
   极其危险：任何一个启动 server.js 的测试只要没指定密钥目录，就会把真实的
   data/alerts/.key 和 self-token.json 删掉（本地已经因此丢过一次，靠临时目录
   里的副本才救回来）。删除改成显式开关 REN_ADOPT_LEGACY=move，
   而「让部署目录变干净」由发布脚本在本机做——那才是唯一该删的地方。 */
function adoptLegacy(legacyPath, target, minLen, pick) {
  if (!legacyPath) return '';
  let v = readTrim(legacyPath);
  if (!v) return '';
  if (typeof pick === 'function') {
    try { v = String(pick(v) || '').trim(); } catch { v = ''; }
    if (!v || v.length < minLen) return '';
  }
  if (v.length < minLen) return '';
  if (!write0600(target, v)) return v;   // 写不进去也先用着，至少本进程可用
  if (String(process.env.REN_ADOPT_LEGACY || '').toLowerCase() === 'move') {
    try { fs.unlinkSync(legacyPath); } catch { /* 删不掉不是致命问题 */ }
  }
  console.log(`[config] 密钥已迁出部署目录：${path.basename(legacyPath)} → ${target}`);
  return v;
}

/**
 * 取一个密钥。
 * @param {string} name    SECRET_DIR 下的文件名，如 'authn.key'
 * @param {object} opts
 *   env      环境变量名（优先）
 *   bytes    自动生成时的随机字节数
 *   create   缺失时是否自动生成（默认 true；像自审令牌这种「配了才开」的应传 false）
 *   legacy   历史文件路径（相对 app 根或绝对），存在就迁过来
 *   minLen   视为有效的长度下限
 * @returns {string} 取不到且不允许生成时返回空串
 */
export function secretValue(name, opts = {}) {
  const { env = '', bytes = 32, create = true, legacy = '', minLen = 16, legacyPick = null } = opts;
  if (cache.has(name)) return cache.get(name);

  const fromEnv = String((env && process.env[env]) || '').trim();
  if (fromEnv) { cache.set(name, fromEnv); sources.set(name, `env:${env}`); return fromEnv; }

  const dir = secretDir();
  const file = path.join(dir, name);
  let v = readTrim(file);
  let src = 'file';
  if (v && v.length < minLen) { v = ''; }

  if (!v) {
    const legacyAbs = legacy ? (path.isAbsolute(legacy) ? legacy : path.join(APP_ROOT, legacy)) : '';
    v = adoptLegacy(legacyAbs, file, minLen, legacyPick);
    if (v) src = 'migrated';
  }

  if (!v && create) {
    v = crypto.randomBytes(bytes).toString('hex');
    src = write0600(file, v) ? 'generated' : 'memory';
  }

  if (!v) { cache.set(name, ''); sources.set(name, 'missing'); return ''; }
  cache.set(name, v);
  sources.set(name, src);
  return v;
}

/* 给运维看的来源说明：只说「从哪来的」，不回显任何密钥内容。 */
export function secretStatus(names) {
  const out = {};
  for (const n of names) out[n] = sources.get(n) || 'unresolved';
  return out;
}

/* ── 部署目录卫生扫描 ──
   新增密钥必须登记到这里，否则「检查通过」只是因为这个列表没跟上。
   测试和发布闸门共用这一份，避免两边各写一套、慢慢长歪。 */
export const SECRET_FILE_NAMES = [
  '.authn.key', 'self-token.json', '.key', 'authn.key', 'alerts.key', 'self.key',
  '.env', 'secrets.json', 'id_rsa', 'id_ed25519', '.npmrc'
];
export const SECRET_DIR_NAMES = ['.ren-secrets'];

export function findSecretFiles(root, { maxDepth = 3 } = {}) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SECRET_DIR_NAMES.includes(e.name)) hits.push(rel + '/');
        walk(p, depth + 1);
        continue;
      }
      if (SECRET_FILE_NAMES.includes(e.name)) hits.push(rel);
    }
  };
  walk(root, 0);
  return hits.sort();
}

export const __test = {
  reset() { cache.clear(); sources.clear(); }
};
