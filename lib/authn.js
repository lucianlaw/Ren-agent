// 身份校验：谁在调用，由云端说了算
//
// 之前这一层的边界写在 identity.js 顶部：uid 即凭证，知道别人 uid 就能进别人工作区。
// 现在那个洞补上了——服务端拿着请求里的 access_token 去问云端「这张凭证是谁的」，
// 拿回来的 sub 就是唯一可信的身份来源。客户端传来的 uid 从此只用于展示，不参与任何判定。
//
// 凭什么能问到：应用自身的域名下就有云端鉴权的反向代理，
//   GET {endpoint}/.cloud/auth/v1/user/me
//   Authorization: Bearer <access_token>
//   x-wb-webapp-access-key: <publishableKey>
// 实测（2026-11-04）：带假 token → 401 invalid_grant；不带 Authorization → 401 invalid_client。
// 这两条把「路径对不对」和「token 是不是被真的校验了」同时证明了。
//
// 一个反复踩的坑记在这里：**whoami 和 LLM 通道一样，必须带 Origin/Referer。**
// 2026-11-04 实测（用一张真正签发给本应用的凭证）：
//   plain（不带 Origin）→ 401 invalid_grant
//   origin（带 Origin+Referer）→ 200，正常返回 sub
// 网关把「没有来源的请求」当成匿名会话，于是无论 token 多合法都判 invalid_grant——
// 而这句话读起来像「凭证有毒」，把人往错误方向带了两轮。
// 教训：先前那版注释写着「whoami 不需要 Origin」，那是我拿假 token 试出来的假结论
// （假 token 走到哪都是 invalid_grant，根本区分不了）。**用错的样本只能得出错的结论。**
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_BASE } from './workspace.js';
import { normUid, UID_RE } from './identity.js';
import { secretValue } from './config.js';

export const WHOAMI_PATH = '/.cloud/auth/v1/user/me';

/* 验一次 10 分钟有效。设这个值的依据：token 本身 6 小时才过期，
   而这里缓存的是「这张 token 属于谁」这个结论，不是授权决定——
   用户退出登录后最坏情况是 10 分钟内旧 token 还能读到自己的文件，读不到别人的。
   对这个阶段够用；要更严就把它调到 0，代价是每个请求多一次外网往返。 */
const CACHE_TTL = 10 * 60e3;
const cache = new Map();        // tokenHash -> { val, at }
const inflight = new Map();     // 同一张 token 并发进来只问一次云端

function tokenHash(t) {
  return crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 32);
}

/* whoami 的返回体有两种可能：裸的用户对象，或者 { data: 用户对象 }。
   身份字段也有多个候选名，按 SDK 里 parseUser 的顺序取（sub 优先，其次 uid）。 */
export function parseSubject(body) {
  const root = body && typeof body === 'object' ? body : {};
  const d = (root.data && typeof root.data === 'object') ? root.data
    : (root.user && typeof root.user === 'object') ? root.user
      : root;
  const raw = d.sub || d.uid || d.user_id || d.id || '';
  const uid = normUid(raw);
  const anon = d.is_anonymous === true || d.scope === 'anonymous';
  return {
    uid: UID_RE.test(uid) ? uid : '',
    anon,
    name: String(d.name || ''),
    email: String(d.email || '')
  };
}

/**
 * 校验一张 access_token。
 * 成功：{ ok:true, uid, anon, name, email }
 * 失败：{ ok:false, code, message }  —— code 用于前端/日志区分，不猜成因
 *
 * 注意所有失败分支都不带 token 原文，也不带长度以外的形态信息：
 * 这个函数的返回值会被写进日志和 HTTP 响应。
 */
export async function verifyToken({
  token, endpoint, accessKey, fetchImpl = globalThis.fetch, ttl = CACHE_TTL
} = {}) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, code: 'no_token', message: '没有拿到登录凭证，请重新登录' };
  if (!endpoint) return { ok: false, code: 'no_endpoint', message: '服务端没有配置云端地址，无法校验身份' };

  const key = tokenHash(t);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return { ...hit.val, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const base = String(endpoint).replace(/\/+$/, '');
    const url = base + WHOAMI_PATH;
    let r;
    try {
      r = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${t}`,
          /* 应用标识：告诉网关「是哪个应用在问」 */
          ...(accessKey ? { 'x-wb-webapp-access-key': accessKey } : {}),
          /* 来源：**必需**，不是可选项。少了这两个头，网关把请求当匿名会话，
             一张完全合法的凭证也会被判 invalid_grant（见文件顶部的实测记录）。 */
          Origin: base,
          Referer: base + '/'
        }
      });
    } catch (e) {
      return {
        ok: false, code: 'verify_unreachable',
        message: `校验登录态时连不上云端：${(e && e.message) || '网络错误'}`
      };
    }

    if (r.ok) {
      let body = null;
      try { body = await r.json(); } catch { /* 非 JSON 走下面的缺主体分支 */ }
      const s = parseSubject(body);
      if (!s.uid) {
        /* 拿不到主体时宁可拒绝，也不要退回「客户端说的 uid」——
           那条退路一旦存在，攻击者只需要让接口返回空主体就能绕过整个校验。 */
        return {
          ok: false, code: 'no_subject',
          message: s.anon
            ? '当前是游客身份，没有可用的账号标识。请登录后再使用工作区'
            : '云端没有返回可识别的账号标识，无法确定这份工作区属于谁'
        };
      }
      const val = { ok: true, uid: s.uid, anon: s.anon, name: s.name, email: s.email };
      cache.set(key, { val, at: Date.now() });
      /* 缓存别无限长：按 token 数增长，给个上限并顺手清过期的 */
      if (cache.size > 2000) {
        const cut = Date.now() - ttl;
        for (const [k, v] of cache) if (v.at < cut) cache.delete(k);
      }
      return val;
    }

    let raw = '';
    try { raw = await r.text(); } catch { /* ignore */ }
    let errCode = '';
    try { errCode = String((JSON.parse(raw) || {}).error || ''); } catch { /* HTML 或空体 */ }

    if (r.status === 401) {
      if (errCode === 'invalid_client') {
        /* 这条是我们自己的配置问题，不是用户没登录，文案必须区分开，
           否则运维会一直让用户「重新登录」而问题在服务端。 */
        return {
          ok: false, code: 'app_key_invalid',
          message: '服务端缺少有效的应用标识，无法校验登录态。这是服务端配置问题，请联系维护者'
        };
      }
      return {
        ok: false, code: 'token_invalid',
        message: '登录态已失效（凭证过期或不属于这个应用），请刷新页面重新登录'
      };
    }
    return {
      ok: false, code: 'verify_failed',
      message: `校验登录态失败（HTTP ${r.status}）`
    };
  })();

  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

/* ── 文件访问签名（fk）──
   为什么需要它：<img src> 和 <a download> 是浏览器自己发的请求，带不了 Authorization 头。
   以前这些链接靠 ?scope=<uid> 就能读文件，等于把「知道 uid 就能下载」写进了 HTML。
   现在改成 ?fk=<签名>：签名由服务端用密钥对 scope 算出来的 HMAC，客户端伪造不出来，
   而且只能开这一个 scope 的门。

   为什么不带过期时间：要把 fk 写进 img 的 src 和下载链接，一旦会过期就得重新渲染整页；
   而它泄露的后果与「用户自己的会话凭证泄露」同级别，不额外放大风险。
   要更严的话这里加时间戳 + 短期有效即可，函数签名不用变。 */
let _secret = '';
function secret() {
  if (_secret) return _secret;
  /* 密钥不再落在 workspace/.authn.key：那个位置在部署目录里，每次发布都会
     把本机的密钥传给线上，两边共用一把——本机能伪造线上的文件签名。
     现在由 config 统一解析（env > 部署目录外的 .ren-secrets > 首次生成），
     老位置的密钥会自动迁过去并删掉，所以升级当天已有链接不会失效。 */
  _secret = secretValue('authn.key', {
    env: 'REN_AUTH_SECRET',
    bytes: 32,
    minLen: 32,
    legacy: path.join(WORKSPACE_BASE, '.authn.key')
  }) || crypto.randomBytes(32).toString('hex');   // 只读盘时退回进程内密钥
  return _secret;
}

/* 启动时主动解析一次：让「迁移老密钥」发生在启动阶段，而不是第一个用户
   请求图片时才发生。迁移失败（只读盘）也只有在启动日志里才看得见。 */
export function warmSecret() {
  try { return secret().length; } catch { return 0; }
}

export function fileKey(scope) {  const s = String(scope || '');
  if (!s) return '';
  return crypto.createHmac('sha256', secret()).update(`file|${s}`).digest('hex').slice(0, 32);
}

export function checkFileKey(scope, k) {
  const want = fileKey(scope);
  const got = String(k || '');
  if (!want || got.length !== want.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(want, 'utf8'), Buffer.from(got, 'utf8'));
  } catch { return false; }
}

export const __test = {
  tokenHash, cache, inflight,
  resetCache() { cache.clear(); inflight.clear(); },
  resetSecret() { _secret = ''; }
};
