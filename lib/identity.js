// 身份 → 目录：把「谁」稳定映射到「哪个工作区」
//
// 以前 scope 是浏览器随机生成的 32 位十六进制串，存在 localStorage：
// 换设备连到另一个空目录、清缓存文件全丢、同一台电脑换账号还会串号。
// 现在 scope 由账号 uid 派生，同一账号在任何设备、任何浏览器都落到同一个目录。
//
// 边界（2026-11-04 起）：这个文件只负责「uid → 目录」的映射，不负责「uid 是谁」。
// 谁是谁由 lib/authn.js 决定：服务端拿请求里的 access_token 去云端 whoami 换回 sub，
// 再用那个 sub 调 scopeFor 得到目录。客户端传来的 uid 只用于展示，不参与判定。
//
// 上一版这里写着「云端鉴权接口不在本应用域名下，当前拿不到」——那句话是错的。
// 应用域名下就有反代：`{endpoint}/.cloud/auth/v1/user/me`，一次 curl 就能证伪。
// 教训：写进注释的结论必须是自己验过的，否则下一个人（包括未来的自己）会被它带偏。
import crypto from 'node:crypto';

const SALT = 'ren-scope-v1';

/* 云库里的 owner_id 是 `wu:<id>`，而 SDK 的 session.user.id 有时候带这个前缀、
   有时候不带（服务端 adminList/isAdmin 早就各自 strip 过一次，就是这个原因）。
   不归一会出现两种坏结果，一种报错、一种更难发现：
     - 带前缀的直接判定失败 → 一进任务就「身份标识不合法」
     - 两边各派生一个目录 → 同一账号分裂成两个工作区，文件"时有时无"
   所以凡是进来的标识，先过一遍 normUid 再判。 */
export function normUid(key) {
  return String(key || '').trim().replace(/^wu:/i, '').trim();
}

/* 账号 uid：云端给的是 28 位 base62（如 oYQVK6vlBz11FIQ7XP2m8rLKh8pg）。
   放宽到 16-64 位，将来换格式也不至于全站 400。 */
export const UID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/* 旧版浏览器随机串：32 位小写十六进制 */
export const LEGACY_RE = /^[a-f0-9]{32}$/;

/** uid → 32 位十六进制目录名。单向、无密钥：secret 丢了会让所有用户目录失联，不值当。 */
export function scopeFor(uid) {
  return crypto.createHash('sha256').update(`${SALT}|${String(uid)}`).digest('hex').slice(0, 32);
}

/**
 * 把请求里带来的标识解析成工作区。
 * - 32 位小写十六进制 → 旧随机串，原样当目录（过渡期，让还没刷新的老页面继续能用）
 * - 其它合法 uid → 派生目录
 * uid 恰好是 32 位小写十六进制的概率约 1e-38（云端 uid 是大小写混合的 base62），
 * 真撞上会被当旧串处理，可以忽略。
 */
export function identityOf(raw) {
  const k = String(raw || '').trim();
  if (!k) return { error: '缺少身份标识', code: 400 };
  /* 旧串先判：32 位十六进制本身就是合法目录名，别去动它 */
  if (LEGACY_RE.test(k)) return { scope: k, uid: '', legacy: true };
  const id = normUid(k);
  /* 归一后才 32 位 hex 的（wu: + 32串）当旧串处理，保证同一串走同一个目录 */
  if (LEGACY_RE.test(id)) return { scope: id, uid: '', legacy: true };
  if (UID_RE.test(id)) return { scope: scopeFor(id), uid: id, legacy: false };
  /* 报错要能自证：只说「不合法」，线上就变成「改半天不知道该改哪」。
     这里报长度和第一个不被接受的字符位置，但不回显整个标识。 */
  return { error: `身份标识不合法（长度 ${[...k].length}${badCharAt(k)}）`, code: 400 };
}

function badCharAt(s) {
  const cs = [...s];
  const i = cs.findIndex(c => !/[A-Za-z0-9_-]/.test(c));
  if (i < 0) return '，且不是 16-64 位的字母数字';
  return `，第 ${i + 1} 个字符不在允许范围内`;
}
