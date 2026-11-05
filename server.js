// Ren Agent · 工具执行器 + 执行循环 v0.4
//
// v0.4 起，agent 循环也跑在这里（原来整条循环在浏览器里，刷新就断）：
//   - 员工 / 任务 / 设置 → 云数据库（浏览器直连，按 owner_id 隔离）
//   - 模型调用          → 云端 LLM 通道（服务端直连，用用户的 access_token，不落盘）
//   - 循环              → lib/agent-host.js 给 public/*.js 造壳，跑的是同一份代码
//   - 本进程还做一件事：在隔离的工作区里执行工具，并把「这一步真做成了没有」校验出来
//
// 安全模型：
//   1. 只做同源请求（线上按 Origin 与 Host 比对；本机只认回环）
//   2. 身份由云端裁决：请求带 access_token，服务端问 whoami 拿到 sub，
//      工作区目录由这个 sub 派生。客户端传来的 uid 只用于展示，不参与判定
//      （v0.5 之前是「uid 即凭证」，构造一个 uid 就能读写别人的工作区）
//   3. 工具本身带路径围栏 + shell 黑名单 + 权限闸（权限以服务端记录为准，前端只能收紧）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

import { TOOL_DEFS, TOOL_CATEGORY, runTool, runHttpTool } from './lib/tools.js';
import { verifyStep, checkDeliverables } from './lib/verify.js';
import { runAfterEdit } from './lib/selftest.js';
import { SCOPE_RE, scopeRoot, ensureScope, listFiles, readTextFile, inside, WORKSPACE_BASE, markOwner, ownerOf } from './lib/workspace.js';
import { identityOf, normUid } from './lib/identity.js';
import { verifyToken, fileKey, checkFileKey, warmSecret } from './lib/authn.js';
import { jwtInfo } from './lib/llm.js';
import { effectivePerms, savePerms, loadPerms, DEFAULT_PERMS } from './lib/perms.js';
import { migrateScope } from './lib/migrate.js';
import {
  readDoc, appendEntries, deleteEntry, clearDoc, replaceCompany, updateEntry,
  approveEntry, writeProjectTitle, listStaff, listProjects, memoryBrief, MEMORY_KINDS, MEMORY_TYPES
} from './lib/memory.js';
import { toolAudit, writeAudit, readAudit } from './lib/audit.js';
import { addAlert, listAlerts, ackAlerts, ADMIN_EMAIL, ALERTS_KEY } from './lib/alerts.js';
import { probeRuntime, runtimeWord, hardenAll, uidForScope, runIsolated } from './lib/sandbox.js';
import { secretStatus, secretDirInfo, secretDir } from './lib/config.js';
import {
  checkTokens, tokenStatus, recordTokens, checkDisk, noteDisk, diskStatus,
  quotaReport, reconcileShell, isFrozen, freeze, thaw, setLimits, limitsOf,
  listScopes, quickStats, usageDir, allLimitOverrides, fmtBytes
} from './lib/quota.js';
import { runBackup, verifyBackup, backupStatus, listBackups, scheduleBackups } from './lib/backup.js';
import { streamProbe, probeHistory, probeBusy, probeSummary } from './lib/probe.js';
import { previewOffice } from './lib/office.js';
import { digestFiles } from './lib/digest.js';
import { selfAuth, treeSrc, readSrc, grepSrc } from './lib/selfsrc.js';
import { startRun, warmup } from './lib/agent-host.js';
import * as state from './lib/state.js';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

/* 构建信息：发布脚本（scripts/release.mjs）在发布前写入 build.json。
   线上没有这个文件 = 直接上传的文件夹，不是一次「发布」。
   这一条不是装饰：出问题时第一个要回答的就是「线上跑的是哪个 commit」，
   没有它只能靠比对文件内容，等于没有版本。 */
let BUILD = { commit: '', at: '', dirty: null, note: '未标记（本地直接运行）' };
try {
  BUILD = JSON.parse(fs.readFileSync(path.join(__dirname, 'build.json'), 'utf8'));
} catch { /* 没有就算了，health 里会显示未标记 */ }
const PORT = Number(process.env.PORT || 4319);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.webmanifest': 'application/manifest+json'
};

/* ── 图片补水：浏览器只传路径，服务端自己去工作区读 ──
   为什么必须这样：一张截图压完也有 500–700KB，base64 再涨三分之一。几张图
   随 /api/run 或 /inject 重发一次，请求体就是几 MB，前置网关会当成攻击载荷
   直接回一个 HTML 拦截页（403）——界面上是「服务端拒绝了这次执行」，
   看着像我们自己的鉴权拒了，其实请求连 handler 都没进到。
   图片本来就在工作区里（上传是发送前就完成的），所以让浏览器只报路径，
   服务端读盘再补成 dataURL 交给视觉模型。链路一样，体积归零。 */
const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const IMG_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
};
/* 补水上限：单张 4MB（原文件）、一次最多 6 张。超了就不补——
   模型看不到时还有路径可调 view_image，比整条请求被网关拦掉好得多。 */
function hydrateImages(scope, list, cap = 6) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.length) return arr;
  const root = scopeRoot(scope);
  if (!root) return arr;
  let filled = 0;
  return arr.map(it => {
    if (!it || typeof it !== 'object') return it;
    const p = String(it.path || '');
    const isImg = /^image\//i.test(String(it.mime || '')) || IMG_EXT_RE.test(p);
    if (!isImg || it.dataUrl || !p) return it;
    if (filled >= cap) return it;
    const target = inside(root, p);
    if (!target) return it;
    try {
      const st = fs.statSync(target);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) return it;
      const mime = IMG_MIME[path.extname(target).toLowerCase()] || 'image/png';
      const dataUrl = `data:${mime};base64,${fs.readFileSync(target).toString('base64')}`;
      filled += 1;
      return { ...it, mime, dataUrl };
    } catch { return it; }
  });
}

/* 语音转写：硅基流动的 SenseVoiceSmall（官方定价页写明免费）。
   浏览器自带的 Web Speech 在国内连不上 Google 的接口，所以录音走服务端转发。
   密钥不落盘、不入库：由请求带上，或用环境变量兜底。 */
const ASR_URL = process.env.ASR_URL || 'https://api.siliconflow.cn/v1/audio/transcriptions';
const ASR_MODEL = process.env.ASR_MODEL || 'FunAudioLLM/SenseVoiceSmall';
const ASR_MAX = 20 * 1024 * 1024;

/* 附件上传：单文件 24MB 上限（base64 后约 32MB），只允许办公与图片类 */
const UPLOAD_MAX = 24 * 1024 * 1024;
const UPLOAD_EXT = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.txt', '.md', '.json',
  '.png', '.jpg', '.jpeg', '.webp', '.gif']);

/* ── 管理员白名单 ──
   质检台（回归集 + Pass^k + 失败归因）是内部判据，不该被普通用户当成产品功能。
   白名单放根目录 admins.json：不在 public/ 下，浏览器拿不到；改人不用改代码。
   注意这不是安全边界——质检台跑的是调用者自己的任务、烧自己的 token，
   这里只是「别让人看见」和「别让人误用」。 */
const ADMIN_FILE = path.join(__dirname, 'admins.json');

function adminList() {
  try {
    const j = JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
    const list = Array.isArray(j.admins) ? j.admins : [];
    /* 云库里的 owner_id 是 wu:<id>，前端 session.user.id 可能不带前缀，两边都归一 */
    return list.map(s => String(s || '').trim().replace(/^wu:/, '')).filter(Boolean);
  } catch (e) { return []; }
}

function isAdmin(uid) {
  if (process.env.ADMIN_DEV === '1') return true;       // 只给本机调试用，线上不设这个变量
  const id = String(uid || '').trim().replace(/^wu:/, '');
  if (!id) return false;
  return adminList().includes(id);
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/* 云端基址：和前端读的是同一份文件，不另设环境变量。
   两处各配一份的结果一定是「某天有人改了一边」，然后模型调用 404 而没人知道为什么。 */
let _cloudEndpoint = null;
function cloudEndpoint() {
  /* 允许用环境变量覆盖：搬到自建主机后模型可能不再走托管通道，
     那时只改这一处，循环和工具层一行都不用动。测试也靠它指到假通道。 */
  if (process.env.REN_LLM_BASE) return process.env.REN_LLM_BASE;
  if (_cloudEndpoint !== null) return _cloudEndpoint;
  try {
    const src = fs.readFileSync(path.join(PUBLIC, 'cloud-config.js'), 'utf8');
    const m = src.match(/endpoint\s*:\s*['"]([^'"]+)['"]/);
    _cloudEndpoint = m ? m[1] : '';
  } catch { _cloudEndpoint = ''; }
  return _cloudEndpoint;
}

/* 应用标识（publishableKey）：网关靠它认「是哪个应用在发请求」。
   和 endpoint 一样允许 env 覆盖——搬到自建主机时这两个值会一起换。
   它不是密钥、可以公开（就明文摆在 public/cloud-config.js 里），
   但缺了它通道会直接 401 invalid_client，所以必须随每次模型请求带上。 */
let _cloudKey = null;
function cloudKey() {
  if (process.env.REN_LLM_KEY) return process.env.REN_LLM_KEY;
  if (_cloudKey !== null) return _cloudKey;
  try {
    const src = fs.readFileSync(path.join(PUBLIC, 'cloud-config.js'), 'utf8');
    const m = src.match(/publishableKey\s*:\s*['"]([^'"]+)['"]/);
    _cloudKey = m ? m[1] : '';
  } catch { _cloudKey = ''; }
  return _cloudKey;
}

/* 把一条 run 的事件总线接成 SSE。
   from=0 表示从头来（新任务），from=N 表示续传（刷新后重连）。
   注意：订阅者断开不等于任务停止——循环继续跑，事件留在总线里。
   这是「刷新页面任务不断」的实现位置，别在这里顺手把 run 中止掉。 */
async function streamRun(req, res, run, from) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  let closed = false;
  let hb = null;
  const stop = () => {
    if (closed) return;
    closed = true;
    if (hb) clearInterval(hb);
    /* 把还在等新事件的订阅者叫醒，否则 for await 会挂到任务结束才释放连接 */
    if (typeof run.bus.wake === 'function') run.bus.wake();
  };
  hb = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch { stop(); }
  }, 15000);
  req.on('close', stop);
  res.on('close', stop);

  try {
    /* hello 里带上服务端的开跑时间：刷新 / 换设备接上现场时，界面上
       「已跑了多久」要靠它，否则秒表只能从 0 重新数，看着像任务刚重启 */
    res.write(`event: hello\ndata: ${JSON.stringify({
      runId: run.id, from, alive: run.alive, startedAt: run.startedAt || 0
    })}\n\n`);
    for await (const rec of run.bus.since(from)) {
      if (closed) break;
      res.write(`id: ${rec.seq}\ndata: ${JSON.stringify(rec.ev)}\n\n`);
    }
  } catch (e) {
    if (!closed) {
      try { res.write(`data: ${JSON.stringify({ t: 'error', message: `事件流中断：${e.message}` })}\n\n`); } catch { /* 已经断了 */ }
    }
  } finally {
    stop();
    try { res.end(); } catch { /* 已经断了 */ }
  }
}

/* ── 安全闸 ── */
const BIND = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const LOCAL_ONLY = /^(127\.0\.0\.1|localhost|::1)$/.test(BIND);
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
/* 额外放行的来源域名（host[:port] 形式，逗号分隔）。放在反代后面时通常用不到，
   因为公开域名会经 Host / X-Forwarded-Host 传进来；换域名又不想改代码时用它。 */
const ALLOWED_ORIGINS = String(process.env.ALLOW_ORIGINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function hostOK(req) {
  const h = (req.headers.host || '').toLowerCase();
  if (!h) return false;
  if (LOCAL_ONLY) return LOOPBACK.test(h);
  return true; // 线上交给 Origin 同源比对约束
}

/* 线上同源判定的依据：
   - 平台反代会把 Host / X-Forwarded-Host 改写成沙箱内网域名，公开域名只留在浏览器的 Origin 里，
     所以「Origin == Host」在云端必然不成立，不能只靠这一条。
   - 优先用 PUBLIC_ORIGIN / ALLOW_ORIGINS 显式声明对外域名；
   - 都没配且确实跑在平台沙箱反代后面时，放行 https 来源：
     平台网关已经挡在外面（分享链接 / sharecode），且工作区还靠 32 位随机 scope 隔离，
     Origin 在这里是第二道，不是唯一一道。 */
const SANDBOX_PROXY = /\.sandbox\.cloudstudio\.club$/;

function originOK(req) {
  const o = req.headers.origin;
  if (!o) return req.method === 'GET' || req.method === 'HEAD'; // 写操作必须带 Origin，挡住直接 curl
  let u;
  try { u = new URL(o); } catch { return false; }
  if (LOCAL_ONLY) return LOOPBACK.test(u.host);
  const oh = u.host.toLowerCase();
  if (ALLOWED_ORIGINS.includes(oh)) return true;
  const h = (req.headers.host || '').toLowerCase();
  if (oh === h) return true;
  const xfh = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
  if (xfh && oh === xfh) return true;
  const fwd = String(req.headers['x-original-host'] || req.headers['x-forwarded-server'] || '')
    .split(',')[0].trim().toLowerCase();
  if (fwd && oh === fwd) return true;
  if ((SANDBOX_PROXY.test(h) || SANDBOX_PROXY.test(xfh)) && u.protocol === 'https:') return true;
  return process.env.TRUST_ANY_ORIGIN === '1';
}

/* ── 请求级身份上下文 ──
   scopeKey() 在十几个端点里被调用，逐个改函数签名风险太大（漏一个就是越权口子）。
   改成：路由入口把「验过的身份」塞进 AsyncLocalStorage，scopeKey 从上下文里取。
   好处是以后新加的端点只要用 scopeKey 就自动受管；代价是必须保证
   「没有身份上下文时不返回可用 scope」——否则等于留了一条默认放行的后门。 */
const ALS = new AsyncLocalStorage();

/* 紧急开关：REN_AUTH_MODE=off 关掉身份校验，退回「谁说的 uid 就是谁」。
   为什么留这个后门：万一线上的凭证校验出问题，所有人会被锁在门外，
   而那时未必来得及走一次完整发布。代价是任何一个环境变量都能把安全关掉，
   所以启动时必须大声喊出来，健康检查里也要能看见它当前是什么档。 */
const AUTH_MODE = String(process.env.REN_AUTH_MODE || 'strict').toLowerCase() === 'off' ? 'off' : 'strict';

/* 身份闸门的计数：上线后不打开浏览器也能知道「验签到底通没通」。
   只记次数，不记任何人。看 /api/health 就能读出这三个数。 */
const AUTH_STATS = { verified: 0, fk: 0, rejected: 0, lastCode: '' };
function bumpAuth(k, code) {
  AUTH_STATS[k] = (AUTH_STATS[k] || 0) + 1;
  if (code) AUTH_STATS.lastCode = String(code);
}

function currentAuth() {
  const s = ALS.getStore();
  return (s && s.auth) || null;
}

/* 这个任务是不是「我的」：读事件流、停止、插话、审批都要过这一关。
   不知道 runId 也没用——知道了也只能动自己那份。 */
function ownsRun(run) {
  const me = currentAuth();
  if (!run || !me) return false;
  if (me.internal) return true;
  return !!me.scope && me.scope === run.scope;
}

/* 内存里找不到，未必是「没这个任务」，也可能是「重启过，任务已经被收尸了」。
   这两种情况对用户的含义完全不同：前者是「你记错了吧」，后者是「你的活干到一半断了」。
   所以去状态层问一句，把中断原因带出来。查不到才算真的没有。 */
function goneRun(res, runId) {
  const me = currentAuth();
  const row = state.runGet(runId);
  if (row && me && (me.internal || me.scope === row.scope)) {
    const why = row.status === 'interrupted'
      ? (row.reason || '服务重启，任务中断')
      : '这个任务在服务端已经结束了';
    return send(res, 410, {
      ok: false, code: row.status === 'interrupted' ? 'interrupted' : 'gone',
      error: why, status: row.status, title: row.title || '', endedAt: row.endedAt || 0
    });
  }
  return send(res, 404, { ok: false, error: '这个任务在服务端已经结束了' });
}

/* 请求里的标识可能是账号 uid（新）或 32 位随机串（旧页面）。统一映射成目录名：
   uid 走派生，旧串原样用；映射不了就原样返回，交给后面那句 SCOPE_RE 拦成 400。 */
function scopeKey(v) {
  const a = currentAuth();
  /* 已验身份：直接用它，传入值一概不看。
     这是整个改造的要害——只要这里还允许传入值覆盖，前面验多少次签都白费。 */
  if (a && a.scope) return a.scope;
  /* 进程内自调用（服务端跑循环时打自己的 /api/tool）：没有用户凭证，
     由内存里的随机头担保，scope 由调用方给。这条路径出不了进程。 */
  if (a && (a.internal || a.legacy)) {
    const id = identityOf(v);
    return id.error ? String(v || '') : id.scope;
  }
  /* 没有上下文 = 本机单测或没走网关的老代码路径。线上请求一定会有上下文。 */
  const id = identityOf(v);
  return id.error ? String(v || '') : id.scope;
}

/* ── 身份闸门 ──
   两种进来的方式：
     1. Authorization: Bearer <access_token> —— 所有 JS 发起的请求走这条
     2. ?scope=<uid>&fk=<文件签名> —— 只有浏览器自己发的 img src / 下载链接需要，
        因为它带不了请求头。这里明确只认 fk，不认 access_token：
        把真凭证贴进 URL 会被访问日志和 Referer 原样带走。
   fk 是服务端用密钥对 scope 算的 HMAC，客户端伪造不出来，也只能开这一个目录的门。 */
/* 取凭证：只认自定义头 x-ren-auth，完全不看 Authorization。
   线上实测（2026-11-04）：即使请求一个凭证都不带，反代也会塞一个 386 字符的
   Authorization 进来。拿它当身份来源等于把鉴权交给上一层代答；更糟的是它可能
   把用户真正的凭证覆盖掉，让所有人都变成同一个会话。自定义头不会被改写。
   代价是老页面（只带 Authorization 的版本）会拿到 401，需要刷新一次——这是有意的。 */
function bearerOf(req) {
  const own = String(req.headers['x-ren-auth'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(own);
  if (m) return m[1].trim();
  return own && !/^Bearer/i.test(own) ? own.trim() : '';
}

async function resolveAuth(req, u) {
  if (isInternal(req)) return { ok: true, internal: true, uid: '', scope: '' };
  /* 逃生门：只认环境变量，且启动时会打警告；默认永远走 verification */
  if (AUTH_MODE === 'off') return { ok: true, legacy: true, uid: '', scope: '' };

  const token = bearerOf(req);
  if (token) {
    const v = await verifyToken({ token, endpoint: cloudEndpoint(), accessKey: cloudKey() });
    if (!v.ok) { bumpAuth('rejected', v.code); return { ok: false, code: 401, errCode: v.code, error: v.message }; }
    const id = identityOf(v.uid);
    if (id.error) {
      bumpAuth('rejected', 'scope_bad');
      return { ok: false, code: 500, errCode: 'scope_bad', error: `账号标识无法映射到工作区（${id.error}）` };
    }
    bumpAuth('verified');
    return { ok: true, uid: v.uid, scope: id.scope, anon: !!v.anon, via: 'token' };
  }

  const fk = u.searchParams.get('fk') || '';
  const claimed = u.searchParams.get('scope') || '';
  if (fk && claimed) {
    const id = identityOf(claimed);
    if (!id.error && checkFileKey(id.scope, fk)) {
      bumpAuth('fk');
      return { ok: true, uid: '', scope: id.scope, via: 'fk' };
    }
  }

  bumpAuth('rejected', 'auth_required');
  return { ok: false, code: 401, errCode: 'auth_required', error: '这个请求没有携带登录凭证' };
}

/* 不需要身份就能访问的接口：存活探测、以及拿凭证来换身份的那一条 */
const PUBLIC_API = new Set(['/api/health', '/api/session', '/api/auth-diag']);

/* 身份「可选」的接口：带了凭证就认，不带也不在这里拦——凭证由处理器自己判。
   目前只有告警队列两条：消费方是 09:00 的定时任务（curl 出发，没有浏览器登录态），
   它的凭证是随机落盘的运维 key。
   不能放进 PUBLIC_API：那样闸门会连身份都不解析，登录用户在页面上查自己的告警
   会被当成匿名人 403——而「B 看不到 A 的告警」也会因为双方都是 403 而假绿。 */
const OPTIONAL_AUTH = new Set(['/api/alerts', '/api/alerts/ack', '/api/sandbox-check',
  /* 运维接口：调用方可能是 cron（curl，没有浏览器登录态），凭证是随机落盘的运维 key。
     放进这个集合的语义是「闸门照常验，验不过也交给 handler 自己判」，
     不是「不需要凭证」——handler 里 adminOK 会逐条核对 key 或管理员身份。 */
  '/api/admin/quota', '/api/admin/backup', '/api/admin/backup/verify', '/api/admin/stream-probe']);


/* ── 内部调用凭证 ──
   服务端跑循环时，工具调用不再由浏览器发起，而是这个进程自己打自己的 /api/tool。
   那条请求同样要过 Origin 检查，而线上进程在反代后面，Origin 是 http://127.0.0.1:PORT，
   对不上任何公开域名——不放行的话，任务跑到第一步工具就全被自己的安全闸拦死。
   所以发一个进程内随机串：带上它就跳过 Origin / Host / 限流三项检查。
   它只存在内存里，不落盘、不下发浏览器，重启即失效。 */
const INTERNAL = crypto.randomBytes(16).toString('hex');
const isInternal = (req) => req.headers['x-ren-internal'] === INTERNAL;

/* ── 模型凭证（内存，不落盘）──
   服务端要自己调模型，就需要用户的 access_token。它由前端在发起任务时带上来。
   为什么不做持久化：token 是「一次会话的凭证」，存盘就变成「永久凭证」，
   一旦漏水，代价远超省下的那几次重新登录。
   过期由前端重新登录解决——服务端 401 时报错，不自己续。 */
const TOKENS = new Map();     // uid -> { token, at }
const TOKEN_TTL = 6 * 3600e3;

function putToken(uid, token) {
  const k = String(uid || '').trim();
  if (!k || !token) return;
  TOKENS.set(k, { token: String(token), at: Date.now() });
  if (TOKENS.size > 5000) {
    const cut = Date.now() - TOKEN_TTL;
    for (const [kk, v] of TOKENS) if (v.at < cut) TOKENS.delete(kk);
  }
}

function getToken(uid) {
  const v = TOKENS.get(String(uid || '').trim());
  if (!v) return '';
  if (Date.now() - v.at > TOKEN_TTL) { TOKENS.delete(String(uid || '').trim()); return ''; }
  return v.token;
}

/* ── 看图用的视觉模型（按工作区记最近一次）──
   为什么模型名由前端挑、服务端记：通道的模型列表只有前端拿得到（SDK 在浏览器里），
   服务端拿不到「哪些模型能看图」的能力清单。前端从完整列表里挑一个多模态的传上来。
   为什么不放进工具参数：工具参数是模型写的，让它自己指定模型等于把「用哪个通道花钱」
   交给它。这里只认发起任务时前端给的那个值。 */
const VISION = new Map();     // scope -> model id[]（按优先级）
function setVisionModel(scope, model) {
  /* 存的是一条候选链，不是一个名字。
     原因很实在：通道不给能力位，前端只能按名字挑；名字沾上 vision 但实际不收图的
     模型不是没有。只押一个，押错就是「400，看不了图」，而模型自己也不知道该换谁。
     候选链让工具层能自己换一个再试，换到能看的为止。 */
  const k = String(scope || '').trim();
  const list = (Array.isArray(model) ? model : [model])
    .map(x => String(x || '').trim().slice(0, 120)).filter(Boolean);
  const uniq = [...new Set(list)].slice(0, 6);
  if (!k || !uniq.length) return;
  VISION.set(k, uniq);
  if (VISION.size > 5000) VISION.clear();   // 极端情况下别让这张表长成内存泄漏
}
function visionModelsOf(scope) {
  return VISION.get(String(scope || '').trim()) || [];
}
function visionModelOf(scope) {
  return visionModelsOf(scope)[0] || '';
}

/* 进行中的服务端任务：id -> ServerRun。
   这张表仍然只在内存里，理由要说清楚：Run 上面挂着事件总线、abort 控制器、
   agent 的作用域，这些都是活对象，没法序列化。把它搬到磁盘上不是「持久化」，
   是「假装任务还活着」——真正的进程已经没了。
   所以状态层（lib/state.js）持久化的是**谁在跑**，不是任务本身：
     · 重启后能告诉用户「这个任务中断了」，而不是让界面一直转圈
     · 两个进程能看到彼此的占用，不会同时写同一个工作区 */
const RUNS = new Map();

/* 启动顺序有讲究：先 init（它顺手收掉上次进程遗留的 running 行），
   再注册心跳供给。反过来的话，第一次心跳会把一堆早已死掉的 id 当成活的报上去。 */
const STATE = state.init();
state.onHeartbeat(() => {
  const ids = [];
  for (const [id, r] of RUNS) if (r.alive) ids.push(id);
  return ids;
});
state.startHeartbeat();

function sweeper() {
  const cut = Date.now() - 30 * 60e3;
  for (const [id, r] of RUNS) {
    if (!r.alive && r.finishedAt && r.finishedAt < cut) RUNS.delete(id);
  }
}
setInterval(sweeper, 5 * 60e3).unref();

/* 一个账号能不能再起一个任务，判据从「内存里有没有对应 Run」变成了「锁在谁手里」。
   锁的粒度决定并发边界：
     scope  → 一账号一个（原来的行为）
     scope+设备 → 手机和电脑各跑一个。设备标识由前端生成并持久化，
                 没有设备标识的老客户端自动退回按账号锁，不会因此变成无锁。 */
function deviceOf(v) {
  const d = String(v || '').trim().toLowerCase();
  return /^[a-z0-9_-]{6,40}$/.test(d) ? d : '';
}
function runLockKey(scope, device) {
  return device ? `run:${scope}:${device}` : `run:${scope}`;
}

/* 谁挡着这个任务。
   两种锁要互相看得见，否则会出现「第三条通道」：
     · 带设备标识的客户端占的是 run:<scope>:<device>
     · 不带设备标识的客户端占的是 run:<scope>
   如果只查自己那一把，一台老设备（没升级页面、或者 localStorage 不可用）
   就能在一个已经有任务在跑的账号上再起一个——三份任务同时改一个目录。
   所以两把锁互为约束：有设备的也要看老锁，没设备的要看所有设备锁。 */
function lockConflict(scope, device) {
  const base = `run:${scope}`;
  if (device) {
    return state.lockHolder(`${base}:${device}`) || state.lockHolder(base) || '';
  }
  return state.lockHolder(base) || state.lockHolders(`${base}:`)[0] || '';
}

/* ── 限流 ──
   粗粒度：每分钟每个主体最多 120 次工具调用，防被人当免费沙箱。
 *
 * 为什么按主体而不是按 IP（2026-11-04 多人场景复查）：
 * 线上所有请求都从平台反代进来，socket.remoteAddress 清一色是 127.0.0.1。
 * 按 IP 计数等于「全站共用一个桶」——一个人跑任务把额度打满，其他人的工具调用
 * 就会拿到 429「调用太频繁」。那是最难解释的一种「串」：数据没串，但一个人的用量
 * 会掐掉另一个人的任务，用户看到的就是「我一用别人就卡」。
 *
 * 没验身份的请求（/api/health、静态资源、老路径）仍按 IP 兜底，量很小。
 * 已验身份的多给一倍额度：一个任务动辄几十步工具调用，120 步/分钟只够单人慢用。 */
const RATE_WINDOW = 60e3;
function rateOK(req) {
  const a = currentAuth();
  const who = a && a.scope ? `s:${a.scope}` : `ip:${req.socket.remoteAddress || 'x'}`;
  /* key 里带窗口序号：换一分钟就是一个新桶，不用去清理旧桶。
     计数落到磁盘（lib/state.js），所以「重启把 429 洗掉」不再是免费通道——
     以前重启一次，被打满的额度就回到零，这条谁都能想到。 */
  const key = `${who}|${Math.floor(Date.now() / RATE_WINDOW)}`;
  const limit = who.startsWith('s:') ? 240 : 120;
  return state.takeRate(key, RATE_WINDOW, limit).ok;
}

/* 审计日志用的来源信息（放在反代后面时优先取 X-Forwarded-For） */
function clientMeta(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    ip: xf || String(req.socket.remoteAddress || ''),
    ua: String(req.headers['user-agent'] || ''),
    origin: String(req.headers.origin || '')
  };
}

/* ── 路由 ── */
const server = http.createServer((req, res) => {
  /* 每个请求一份身份上下文。用 ALS 而不是模块级变量：请求之间是交错执行的，
     一个全局「当前用户」在并发下会串号——那比没有鉴权还危险。 */
  ALS.run({ auth: null }, () => {
    route(req, res).catch((e) => {
      try {
        if (!res.headersSent) send(res, 500, { ok: false, error: e && e.message });
        else res.end();
      } catch { /* ignore */ }
    });
  });
});

async function route(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  /* 进程内自调用（服务端跑循环时打自己的 /api/tool）：不走对外的三道闸。
     这条必须放在最前面，且只认内存里的随机串——外部拿不到这个头。 */
  const internal = isInternal(req);

  if (!internal && !hostOK(req)) return send(res, 421, { ok: false, error: 'Host 不被接受' });
  if (!internal && !originOK(req)) {
    return send(res, 403, {
      ok: false,
      error: 'Origin 不被接受',
      seen: {
        host: req.headers.host || '',
        xfh: req.headers['x-forwarded-host'] || '',
        origin: req.headers.origin || ''
      }
    });
  }

  try {
    /* 静态资源 */
    if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
      const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
      const f = path.join(PUBLIC, rel);
      if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        return fs.createReadStream(f).pipe(res);
      }
      return send(res, 404, { ok: false, error: 'not found' });
    }

    /* ── 身份闸门 ──
       放在静态资源之后、所有 /api 端点之前：静态文件（含登录页）谁都能拿，
       但任何碰到工作区的接口，必须先有一个由云端确认过的身份。 */
    if (u.pathname.startsWith('/api/') && !PUBLIC_API.has(u.pathname)) {
      const a = await resolveAuth(req, u);
      if (!a.ok && !OPTIONAL_AUTH.has(u.pathname)) {
        return send(res, a.code, {
          ok: false,
          code: a.errCode || 'auth_failed',
          error: a.error
        });
      }
      if (a.ok) {
        const store = ALS.getStore();
        if (store) store.auth = a;
      }
    }

    if (u.pathname === '/api/health') {
      /* 沙箱能力：带运维 key 才给详细（uid、有哪些二进制）。
         公网上只给一个词，够运维判断「现在有没有隔离」，又不告诉别人
         「这台机器是以 root 跑的」。 */
      const withKey = String(u.searchParams.get('key') || '') === ALERTS_KEY;
      const runtime = withKey ? probeRuntime() : runtimeWord();
      return send(res, 200, {
        ok: true, v: BUILD.version || '0.4.0',
        mode: LOCAL_ONLY ? 'local' : 'cloud',
        auth: AUTH_MODE,
        /* 线上跑的是哪个版本：发布脚本写的 build.json。没有就是「本地直接起的」，
           这种状态能跑但不该出现在线上——出问题时无法回答「线上是什么版本」。 */
        build: BUILD,
        authStats: { ...AUTH_STATS },
        runtime,
        /* 密钥从哪来（env / 文件 / 首次生成 / 迁移），只给名字不给内容。
           这条是「配置外置」是否真的生效的唯一证据：如果线上一直显示
           generated，说明密钥目录每次发布都丢了，签名会集体失效。 */
        secrets: withKey ? secretStatus(['authn.key', 'alerts.key', 'self.key']) : undefined,
        secretsDir: withKey ? secretDirInfo() : undefined,
        /* 配额与备份的运维视图。这两块是「机器会不会突然出事」的直接指标：
           磁盘还剩多少、有多少账号被冻结、上一次备份是几小时前、有没有失败。
           公开页面上不出现——它只对拿着运维 key 的人有意义。 */
        quota: withKey ? {
          dir: usageDir(),
          ...quickStats(),
          defaults: limitsOf('0'.repeat(32))
        } : undefined,
        backup: withKey ? (() => {
          const b = backupStatus();
          return {
            dir: b.dir, count: b.count, keep: b.keep, hours: b.hours,
            lastAt: b.lastAt, ageHours: b.ageHours, stale: b.stale, lastError: b.lastError,
            /* 白名单式取值，新字段必须在这里显式放出来——
               第一次加这两个字段时就是漏了这一步，health 里看不到，
               排查时等于没有。 */
            checks: b.checks, lastCheckAt: b.lastCheckAt
          };
        })() : undefined,
        /* 状态层：mode 是 memory 就说明这次降级了——磁盘上什么都没存。
           reaped 是本次启动收掉的中断任务数，非 0 意味着上次是非正常退出。 */
        state: withKey ? state.stats() : { mode: state.modeOf() },
        /* 最近一次长连接实测。result=never 意味着「从来没测过」——
           这不是错误，但它是一个应该被看见的状态：长连接是任务不中断的前提，
           而「没测过」和「测过且通过」在界面上长得一模一样。 */
        probe: withKey ? probeSummary() : undefined,
        workspace: WORKSPACE_BASE,
        // 反代进来的实际头部，用来核对同源判定（不含任何密钥）
        seen: LOCAL_ONLY ? undefined : {
          host: req.headers.host || '',
          xfh: req.headers['x-forwarded-host'] || '',
          xfp: req.headers['x-forwarded-proto'] || '',
          origin: req.headers.origin || '',
          /* 反代会不会自己塞一个 Authorization 进来？只看有没有、多长，
             不看内容——这决定了我们能不能靠这个头认人。 */
          authHdr: {
            present: !!req.headers.authorization,
            len: String(req.headers.authorization || '').length
          },
          renHdr: {
            present: !!req.headers['x-ren-auth'],
            len: String(req.headers['x-ren-auth'] || '').length
          }
        }
      });
    }

    /* ── 临时诊断：这一张凭证到底被谁拒了 ──
       线上只看到「token_invalid」，但那一条后面还有三种完全不同的成因：
       凭证本身不被认、凭证是给别的 client 签的、或者需要额外的头。
       这里把能拿到的东西各问一遍云端，只回状态码和「哪一档错误」——
       不回 token 原文、不回任何敏感字段的完整值。
       排查完就删。 */
    if (u.pathname === '/api/auth-diag') {
      /* 只在真的出了问题、前端带着一张凭证来问时才干活：
         不带凭证就当没有这个接口，免得被当成「随便试探」的公共入口。 */
      if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not found' });
      if (!rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const strip = (h) => {
        const m = /^Bearer\s+(.+)$/i.exec(String(h || ''));
        return m ? m[1].trim() : String(h || '').trim();
      };
      /* 用一组头分别问一次云端，看哪一组能过。
         线上已经证明：网关会给**每个**进来的请求塞一个 CloudStudio 的 Authorization
         （iss=cloudstudio.net、无 sub、3 天有效期），那张令牌问谁都是 invalid_grant。
         所以真正要分辨的是「用户这张凭证在什么条件下才算数」。 */
      const rawWhoami = async (token, extra, useKey = true, query = '') => {
        const base = String(cloudEndpoint() || '').replace(/\/+$/, '');
        try {
          const r = await fetch(base + '/.cloud/auth/v1/user/me' + (query || ''), {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
              ...(useKey && cloudKey() ? { 'x-wb-webapp-access-key': cloudKey() } : {}),
              ...extra
            }
          });
          const txt = await r.text().catch(() => '');
          let err = '';
          let keys = [];
          try {
            const j = JSON.parse(txt);
            err = String(j.error || j.code || '');
            const d = (j.data && typeof j.data === 'object') ? j.data : j;
            keys = Object.keys(d).slice(0, 12);
          } catch { /* 非 JSON */ }
          return { status: r.status, err, keys };
        } catch (e) {
          return { status: 0, err: 'net:' + String((e && e.message) || '').slice(0, 60) };
        }
      };

      let sentTok = strip(req.headers['x-ren-auth']);
      if (req.method === 'POST') {
        const b = await readBody(req, 64 * 1024);
        if (b && b.token) sentTok = String(b.token).trim();
      }

      const base = String(cloudEndpoint() || '');
      const shareCode = String(req.headers['x-wb-share-code'] || '').trim();
      const cookie = String(req.headers.cookie || '');
      const combos = [
        ['plain', {}, true, ''],
        ['origin', { Origin: base, Referer: base + '/' }, true, ''],
        ['share', { Origin: base, 'x-wb-share-code': shareCode }, true, ''],
        ['cookie', { Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, true, ''],
        ['nokey', {}, false, ''],
        ['edge', {
          Origin: base, Referer: base + '/',
          'x-wb-share-code': shareCode,
          'x-wb-base-url': String(req.headers['x-wb-base-url'] || ''),
          'x-space-key': String(req.headers['x-space-key'] || '')
        }, true, '']
      ];

      const probes = [];
      const pushTok = async (label, t) => {
        if (!t) { probes.push({ label, skip: 'no token' }); return; }
        const i = jwtInfo(t);
        for (const [name, extra, useKey, q] of combos) {
          const r = await rawWhoami(t, extra, useKey, q);
          probes.push({
            label, combo: name,
            len: i.len, jwt: i.jwt,
            iss: i.iss || '', aud: i.aud || '', clientId: i.clientId || '',
            subHead: String(i.sub || '').slice(0, 3),
            expInMin: i.exp ? Math.round((i.exp * 1000 - Date.now()) / 60000) : null,
            status: r.status, err: r.err, keys: r.keys
          });
        }
      };
      await pushTok('sent', sentTok);
      await pushTok('injected', strip(req.headers.authorization));

      return send(res, 200, {
        ok: true,
        endpoint: base,
        /* publishableKey 本来就是公开的（明文在 cloud-config.js 里），
           浏览器侧要复现同一条请求就得用它 */
        key: cloudKey(),
        headerNames: Object.keys(req.headers),
        hasCookie: !!req.headers.cookie,
        probes
      });
    }

    /* ── 用云端凭证换「服务端认可的身份」──
       浏览器知道的 uid 是它自己说的，不能信。这里让它把 access_token 交上来，
       服务端去云端问一次「这张凭证是谁」，再把派生好的 scope 和文件签名下发。
       之后每个 JS 请求带 Authorization: Bearer <同一张 token> 即可，
       服务端最多 10 分钟问一次云端（缓存），但任何时候都不再采信客户端说的 uid。 */
    if (u.pathname === '/api/session') {
      /* 取凭证的顺序：请求体里明确的 token 优先。
         为什么不从 Authorization 头拿：线上反代会给每个请求塞一个自己的
         386 字符 Authorization（客户端一个都没带也照样塞），拿它当用户凭证
         等于认错人——而且它是“别人签发的”，云端会回 invalid_grant。 */
      let token = '';
      let claimed = '';
      if (req.method === 'POST') {
        const b = await readBody(req, 64 * 1024);
        token = String(b.token || '').trim();
        claimed = String(b.uid || '');
      }
      if (!token) token = bearerOf(req);
      const v = await verifyToken({ token, endpoint: cloudEndpoint(), accessKey: cloudKey() });
      if (!v.ok) {
        /* 被拒时把「到底是哪张凭证被拒」一起回给前端：
           光有错误码分不清「凭证本身不行」和「根本没用上用户那张凭证」。 */
        const me = jwtInfo(token);
        const inj = String(req.headers.authorization || '');
        const injTok = /^Bearer\s+(.+)$/i.exec(inj);
        const mi = injTok ? jwtInfo(injTok[1].trim()) : null;
        return send(res, 401, {
          ok: false, code: v.code, error: v.message,
          diag: {
            sent: { len: me.len, jwt: !!me.jwt, clientId: me.clientId || '', aud: me.aud || '' },
            injected: mi
              ? { len: mi.len, jwt: !!mi.jwt, clientId: mi.clientId || '', aud: mi.aud || '' }
              : { present: false },
            src: req.method === 'POST' ? 'body' : 'x-ren-auth'
          }
        });
      }
      const id = identityOf(v.uid);
      if (id.error) return send(res, 500, { ok: false, code: 'scope_bad', error: id.error });
      /* 模型通道要用同一张凭证，顺手记下（内存，6 小时） */
      putToken(id.scope, token);
      /* 给这个目录盖上归属标记：迁移接口靠它区分「旧目录」和「别人的目录」 */
      markOwner(id.scope, v.uid);
      return send(res, 200, {
        ok: true, uid: v.uid, scope: id.scope, fk: fileKey(id.scope),
        anon: !!v.anon, cached: !!v.cached,
        /* claimed/mismatch 只用于排查，不参与判定：
           万一同一个账号在两边算出不同标识，前端会把这事显出来，
           而不是默默换一个空目录让人以为文件丢了。 */
        claimed,
        mismatch: !!claimed && normUid(claimed) !== v.uid
      });
    }

    /* 质检台白名单校验：前端拿到 admin 才露出入口 */
    if (u.pathname === '/api/is-admin') {
      /* 只按验过的身份判，不再接受 ?uid= —— 否则传入别人的 uid 就能试探谁是管理员 */
      const me = currentAuth();
      return send(res, 200, { ok: true, admin: isAdmin((me && me.uid) || '') });
    }

    /* 工具清单：浏览器要把它原样交给云端模型 */
    if (u.pathname === '/api/tooldefs') {
      return send(res, 200, { ok: true, tools: TOOL_DEFS, categories: TOOL_CATEGORY });
    }

    /* ── 只读自审：让 agent 读自己的源码 ──
       独立入口，不复用 /api/tool：那边认 scope 和前端传来的 perms，
       这边只认令牌、且只有三个只读操作，两条路各走各的，便于审计。
       见 lib/selfsrc.js 里的划界说明。 */
    if (u.pathname === '/api/self/ping') {
      const a = selfAuth(u.searchParams.get('token'));
      return send(res, a.ok ? 200 : a.code, a.ok ? { ok: true, on: true } : { ok: false, error: a.error });
    }

    if (u.pathname === '/api/self/tool' && req.method === 'POST') {
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const b = await readBody(req, 256 * 1024);
      const a = selfAuth(b.token);
      if (!a.ok) return send(res, a.code, { ok: false, error: a.error });
      const name = String(b.name || '');
      const args = b.args && typeof b.args === 'object' ? b.args : {};
      const t0 = Date.now();
      let out;
      if (name === 'self_tree') out = treeSrc(String(args.dir || ''));
      else if (name === 'self_read') out = readSrc(args.path, args.from, args.lines);
      else if (name === 'self_grep') out = grepSrc(args.q, undefined, { glob: args.glob });
      else return send(res, 400, { ok: false, error: `不认识的只读操作 ${name}` });
      if (out.error) return send(res, 200, { ok: true, result: { ok: false, output: out.error, ms: Date.now() - t0 } });
      return send(res, 200, {
        ok: true,
        result: {
          ok: true,
          output: out.text,
          meta: { total: out.total, from: out.from, to: out.to, truncated: out.truncated, hits: out.hits, scanned: out.scanned, count: out.count, more: out.more },
          ms: Date.now() - t0
        }
      });
    }

    /* 执行一步工具 */
    if (u.pathname === '/api/tool' && req.method === 'POST') {
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const b = await readBody(req);
      const scope = scopeKey(b.scope);
      const name = String(b.name || '');
      const args = b.args && typeof b.args === 'object' ? b.args : {};
      const perms = b.perms && typeof b.perms === 'object' ? b.perms : {};

      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      /* 自定义 HTTP 工具：内置清单里没有的名字，带 custom 描述符就按 net 权限去打接口 */
      const custom = b.custom && typeof b.custom === 'object' ? b.custom : null;
      if (!TOOL_CATEGORY[name] && TOOL_CATEGORY[name] !== 'none' && !(custom && custom.url)) {
        return send(res, 400, { ok: false, error: `未知工具 ${name}` });
      }

      const root = ensureScope(scope);
      const cat = TOOL_CATEGORY[name] || 'net';
      /* 权限以服务端记录为准：前端这次带来的 perms 只能收紧，不能放宽。
         以前这里直接读 b.perms，等于把闸门交给调用者自己填表——绕过 UI 打接口
         就能把「跑命令」打开。现在放宽权限必须走 /api/perms，那条路留审计。 */
      const pm = effectivePerms(scope, perms);
      const p = pm.perms;
      /* 完全访问 = 四类权限全开；这一步的档位直接进审计日志 */
      const level = (p.read && p.write && p.exec && p.net) ? 'full' : 'default';
      const meta = clientMeta(req);
      // 权限在这里再兜一次：服务端记录没开，前端传什么都给不了
      if (cat !== 'none' && !p[cat]) {
        toolAudit({
          scope, name, args, custom, category: cat, level, ok: false, blocked: true, ms: 0,
          output: `缺少 ${cat} 权限（服务端记录：${pm.source}）`,
          verify: { pass: false, why: `缺少 ${cat} 权限` }, ...meta
        });
        return send(res, 200, {
          ok: true, blocked: true, category: cat, name,
          output: `用户没有开启「${cat}」类权限，这一步被拦截了。`,
          ms: 0, verify: { pass: false, why: `缺少 ${cat} 权限` }
        });
      }

      const out = (!TOOL_CATEGORY[name] && TOOL_CATEGORY[name] !== 'none')
        ? await runHttpTool({ ...custom, name }, args)
        /* scope 一起传下去：磁盘配额要按账号查，而 workspace 只是个路径。
           从路径反推 scope 也行，但那是「靠命名约定」，一旦 WORKSPACE_DIR 被改成
           扁平结构就会静默失效——配额静默失效比报错难查得多。 */
        /* leaseOwner：路径租约的「谁」。
           优先用 runId（同一台设备上不可能有两个 run），否则退到设备标识。
           两个设备同时写同一个文件才会冲突——这正是要拦的那一种。 */
        : await runTool(name, args, {
          workspace: root, scope,
          runId: String(b.runId || '').slice(0, 64),
          leaseOwner: deviceOf(b.device) || scope,
          onTodos: () => {}, fullAccess: level === 'full',
          /* 看图要自己再调一次模型：凭证和端点在这一层拿，不下发给前端。
             模型名只认任务发起时记下的那个，不由工具参数决定——
             工具参数是模型写的，让它挑模型等于让它挑花哪条通道。 */
          llm: (name === 'view_image' && getToken(scope))
            ? {
              endpoint: cloudEndpoint(), token: getToken(scope), accessKey: cloudKey(),
              models: visionModelsOf(scope), model: visionModelOf(scope)
            }
            : null
        });

      /* shell 是唯一一条拦不住写入的路径：降权后的子进程想写什么，应用层管不着
         （这是 OS 边界，不是代码边界）。所以这里不预测，跑完直接实测，超了就冻结。
         冻结之后所有写入口一律拒绝——代价是用户得清理一下，不冻结的代价是
         所有人的任务一起因为没空间失败。两害相权，选前者。 */
      if (name === 'run_shell' && out && out.ok) {
        const rec = reconcileShell(scope);
        if (!rec.ok) {
          out.ok = false;
          out.output = `${String(out.output || '')}\n\n⚠ 磁盘配额：执行完后实测 `
            + `${fmtBytes(rec.used)}，超过上限 ${fmtBytes(rec.limit)}，写入已冻结。`
            + '先删掉一些文件（再调一次 /api/quota/thaw，或让管理员解冻）才能继续写。';
        }
      }
      let verify = verifyStep(name, args, out, root);

      /* ── 改完自动跑测试 ──
         语法闸门只保证「能解析」，保证不了「逻辑还对」。代码文件改成功之后立刻跑一遍
         这个工作区的测试：挂了就把 verify 判成不通过，前端会把失败项当成「这一步没生效」
         回灌给模型（见 public/agent.js 的校验未通过分支），下一轮它自己会去修。
         没测试基建 / 不是代码文件 / 没开 exec 权限 → ran:false，静默通过，绝不假装跑过。 */
      let tests = null;
      let output = out.output;
      if (out.ok && verify.pass && (name === 'edit_file' || name === 'write_file')) {
        const t = await runAfterEdit({ root, changed: args.path, perms: p });
        if (t.ran) {
          tests = {
            pass: t.pass, why: t.why, ms: t.ms,
            files: t.files, passCount: t.passCount, failCount: t.failCount,
            fresh: t.fresh, known: t.known
          };
          if (t.pass) {
            verify = { pass: true, why: `${verify.why}；${t.why}` };
          } else {
            verify = { pass: false, why: t.why, by: 'autotest' };
            output = `${out.output}\n\n${String(t.evidence || '').slice(0, 4000)}`;
          }
        }
      }

      const writes = new Set(['write_file', 'edit_file', 'make_deck', 'make_sheet', 'make_doc']);
      /* 审计：不管成没成都落一条，事后能复盘「它到底碰了什么」 */
      toolAudit({
        scope, name, args, custom, category: cat, level,
        ok: out.ok, blocked: false, ms: out.ms, output, verify,
        /* 这次权限依据的是服务端记录还是首次初始化，事后复盘能分清 */
        permsFrom: pm.source, ...meta
      });
      return send(res, 200, {
        ok: true,
        blocked: false,
        result: {
          name,
          ok: out.ok,
          output,
          ms: out.ms,
          verify,
          /* 退出码、替换处数这类结构化结果原样透出：前端和模型都能直接读，
             不用再从 output 文本里猜。run_shell 的 code、edit_file 的 replaced 都在这。 */
          code: typeof out.code === 'number' ? out.code : undefined,
          replaced: typeof out.replaced === 'number' ? out.replaced : undefined,
          /* 改完自动跑测试的结果：null 表示没跑（不是代码文件/没有测试/没开 exec 权限） */
          tests,
          /* 这一步实际生效的权限（服务端记录 ∩ 本次请求）：前端据此校准自己的开关显示，
             免得 UI 上看着开了、实际被服务端收紧，人以为是 bug */
          perms: p,
          permsFrom: pm.source,
          /* gen_image / find_image 落盘的图片路径：前端据此在对话和产出区里直接展示 */
          files: Array.isArray(out.files) ? out.files.slice(0, 12).map(String) : [],
          wrote: writes.has(name) && out.ok ? String(args.path || '') : ''
        }
      });
    }

    /* ── 权限的服务端副本 ──
       前端把开关状态同步到这里；/api/tool 以这里为准。
       读：GET /api/perms?scope=<uid|旧串>
       写：POST /api/perms { scope, perms, by }
       写是「放宽」的唯一入口，所以落一条审计。 */
    if (u.pathname === '/api/perms' && req.method === 'GET') {
      const scope = scopeKey(u.searchParams.get('scope') || '');
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const got = loadPerms(scope);
      return send(res, 200, { ok: true, perms: got ? got.perms : DEFAULT_PERMS, at: got ? got.at : 0, saved: !!got });
    }
    if (u.pathname === '/api/perms' && req.method === 'POST') {
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const b = await readBody(req, 16 * 1024);
      const scope = scopeKey(b.scope);
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const p = b.perms && typeof b.perms === 'object' ? b.perms : {};
      const rec = savePerms(scope, p, String(b.by || 'ui'));
      toolAudit({
        scope, name: 'set_perms', args: { perms: rec.perms }, custom: null,
        category: 'none', level: (rec.perms.read && rec.perms.write && rec.perms.exec && rec.perms.net) ? 'full' : 'default',
        ok: true, blocked: false, ms: 0, output: JSON.stringify(rec.perms),
        verify: { pass: true }, ...clientMeta(req)
      });
      return send(res, 200, { ok: true, ...rec });
    }

    /* ── 旧工作区一次性迁移 ──
       账号化之后，老用户 localStorage 里那个随机串指的还是旧目录。前端登录后
       带 { uid, legacy } 来问一次：搬到账号目录，搬过就不重复搬。
       迁移只在「同名目标更旧」时写，不会盖掉用户在新目录里改过的文件。 */
    if (u.pathname === '/api/migrate' && req.method === 'POST') {
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const b = await readBody(req, 16 * 1024);
      /* 目标目录只认验过的身份：以前传入别人的 uid 就能把自己的文件「搬」到别人目录里，
         反过来也能把别人的旧目录认领走（migrateScope 是先到先得锁）。 */
      const target = scopeKey(b.uid);
      if (!SCOPE_RE.test(target)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const legacy = String(b.legacy || '');
      if (!/^[a-f0-9]{32}$/.test(legacy)) return send(res, 400, { ok: false, error: '旧工作区标识不合法' });
      if (legacy === target) return send(res, 200, { ok: true, copied: 0, same: true });
      /* 有主且不是自己 → 拒绝。没有这道判断，知道别人目录名就能把内容整份搬走 */
      const owner = ownerOf(legacy);
      const me = (currentAuth() && currentAuth().uid) || '';
      if (owner && normUid(owner) !== normUid(me)) {
        return send(res, 403, { ok: false, error: '那个工作区属于另一个账号，不能迁移' });
      }
      const r = migrateScope(legacy, target);
      if (!r.ok) return send(res, 500, r);
      return send(res, 200, r);
    }

    /* ── 服务端执行循环 ──
       以前整个循环跑在浏览器里：模型直连、工具打回来、事件在本地渲染。
       页面一刷新，那个 Promise 就没了——任务半路死掉，谁都救不回来。
       现在循环搬到这里，浏览器只订阅事件流。

       四条约定：
       1. 模型凭证由前端带上来（access_token），服务端只用不存盘
       2. 同一工作区同时只允许一个执行，避免两端互相覆盖文件
       3. 浏览器断了不中止任务，事件留在总线里等重连
       4. 执行入口和工具执行复用同一套权限（perms 从服务端记录读，不信前端） */
    if (u.pathname === '/api/run' && req.method === 'POST') {
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      let b;
      try { b = await readBody(req, 48 * 1024 * 1024); }
      catch (e) { return send(res, 413, { ok: false, error: e.message }); }

      /* 两种包法都收：{job:{...}} 和直接摊在顶层。少一种就得两边对版本号，不值当。 */
      const job = b.job && typeof b.job === 'object' ? b.job : b;
      /* scope 一律由闸门给：b.uid / b.scope 只在「进程内自调用」时才有意义，
         正常请求里 scopeKey 会直接返回验过的身份，传入值不看一眼。 */
      const scope = scopeKey(b.uid || b.scope);
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });

      /* 凭证：每次发起都刷新一次有效期。没带就沿用上一次的（同一会话里的后续轮次）。
         key 用派生后的 scope 而不是原始 uid——原始 uid 可能带 wu: 前缀也可能不带，
         拿它当 key 会在同一账号下存出两份凭证。 */
      if (b.token) putToken(scope, b.token);
      /* 看图模型跟着这次任务记下来：view_image 在 /api/tool 里要用，
         而那条请求里不会带模型名（模型不能自己指定通道） */
      if (b.visionModels || b.visionModel) setVisionModel(scope, b.visionModels || b.visionModel);
      const token = getToken(scope);
      if (!token) {
        return send(res, 401, {
          ok: false, code: 'no_token',
          error: '服务端还没拿到模型凭证，请刷新页面重新登录后再发起'
        });
      }

      /* ── 账号级额度闸（发起前） ──
         单任务预算（settings.maxTokens）只管「这一次任务」，账号一天跑十个任务就能绕过去。
         这里看的是这个账号今天/这月累计用了多少。402 而不是 429：429 是「你太快了，等等再来」，
         402 是「你的额度用完了」——用户看到的分辨率不同，下一步动作也不同。 */
      const qc = checkTokens(scope);
      if (!qc.ok) {
        toolAudit({
          scope, name: 'quota.block', args: { where: qc.where || '' }, custom: null,
          category: 'none', level: 'default', ok: false, blocked: true, ms: 0,
          output: qc.error, verify: { pass: false, why: '账号额度用尽' }, ...clientMeta(req)
        });
        return send(res, 402, {
          ok: false, code: qc.code, where: qc.where || '', error: qc.error, quota: qc.status
        });
      }

      /* 占用检查：同一把锁上只能有一个 run。
         锁在磁盘上，所以「另一个进程正在跑」也看得见——这是多实例的前提。 */
      const device = deviceOf(job.device || b.device);
      const lockKey = runLockKey(scope, device);
      const holder = lockConflict(scope, device);
      if (holder) {
        return send(res, 409, {
          ok: false, code: 'busy',
          error: device
            ? '这台设备已经有一个任务在跑了，等它结束或先停掉它'
            : '这个工作区已经有一个任务在跑了，等它结束或先停掉它',
          runId: holder
        });
      }

      const task = job.task;
      if (!task || typeof task !== 'object' || !String(task.goal || '').trim()) {
        return send(res, 400, { ok: false, error: '缺少任务内容（task.goal）' });
      }
      /* 浏览器只送路径（见 hydrateImages）：把图从工作区读回来，
         视觉模型才有东西可看。前端自己带 dataUrl 的老版本页面不受影响。 */
      task.files = hydrateImages(scope, task.files);
      job.followUpImages = hydrateImages(scope, job.followUpImages);

      /* 权限一律以服务端记录为准：前端说法只能用来收紧 */
      const settings = job.settings && typeof job.settings === 'object' ? { ...job.settings } : {};
      /* permissions 取 .perms：effectivePerms 返回的是带来源说明的包装对象，
         直接把它塞给 settings 会让 permissions.write 变成 undefined，
         结果每一步工具都被判「缺少权限」——排查时看着像权限开关没开，其实是取值取错了层。 */
      settings.permissions = effectivePerms(scope, settings.permissions).perms;
      /* 步数/预算两个字段：库里存的是 max_steps，循环里读的是 settings.maxSteps。
         缺了它循环一次都不跑，直接标成 step_limit 收工——看起来像「模型没话说」，
         实际是参数没送到。所以这里两种写法都收，并给出兜底值。 */
      if (settings.maxSteps == null) settings.maxSteps = Number(settings.max_steps) || 12;
      if (settings.maxTokens == null) settings.maxTokens = Number(settings.max_tokens) || 200000;
      if (settings.projSteps == null) settings.projSteps = Number(settings.max_proj_steps) || 6;

      const runId = String(task.id || b.runId || ('r' + Date.now().toString(36)));
      const base = `http://127.0.0.1:${PORT}`;
      const sc = u.searchParams.get('sharecode') || '';

      let run;
      /* 运行中的额度监控要能掐掉 run，而 run 是 startRun 的返回值——
         用一个让回调能看到的变量，比给 startRun 加一个「反向依赖」干净。 */
      let liveRun = null;

      /* 先占锁再起任务：检查与占用之间有空隙，两个请求同时进来就会都通过检查。
         acquireLock 是事务里的「查+写」，这才是真正的判据；上面那次查询只为了让
         最常见的「明明在跑」直接返回，不必走到启动逻辑。 */
      const lock = state.acquireLock(lockKey, runId);
      if (!lock.ok) {
        return send(res, 409, {
          ok: false, code: 'busy',
          error: '这个工作区已经有一个任务在跑了，等它结束或先停掉它',
          runId: lock.holder || ''
        });
      }
      /* 拿到自己的锁之后再看一眼另一把：检查和占用之间有一小段空隙，
         正好有老客户端在这时插进来，就会出现「三个任务同时跑」。
         顺手把刚拿到的锁还回去，比留一个说不清的状态干净。 */
      if (device && state.lockHolder(`run:${scope}`)) {
        state.releaseLock(lockKey, runId);
        return send(res, 409, {
          ok: false, code: 'busy',
          error: '这个账号已经有一个任务在跑了（另一台设备或旧版页面），等它结束再试',
          runId: state.lockHolder(`run:${scope}`) || ''
        });
      }

      /* 先落「开跑」记录，再启动任务。
         顺序反过来的话有个很窄但真实的竞态：任务可能在我写这条记录之前就结束了
         （起手就报错的那种），onEnd 更新不到任何行，随后 runBegin 又插进一条
         status=running —— 那条记录会一直挂着，界面上是一个永远不动的任务。 */
      state.runBegin({
        id: runId, scope, uid: (currentAuth() && currentAuth().uid) || scope,
        title: String(task.goal || '').slice(0, 200), device, model: job.model || ''
      });

      try {
        run = startRun({
          id: runId, scope, uid: (currentAuth() && currentAuth().uid) || scope,
          task, staff: job.staff || null, settings,
          model: job.model || '', judge: job.judge || null,
          followUp: job.followUp || '', followUpImages: job.followUpImages || [],
          base, sharecode: sc, internal: INTERNAL,
          token, accessKey: cloudKey(), endpoint: cloudEndpoint(), tools: job.tools || [],
          /* 任务收尾（正常结束 / 报错 / 被中止）都要落到状态层。
             这里是唯一能保证「一定会被调用」的地方——放在 HTTP 处理里不行，
             用户关掉页面时那个请求早就断了。 */
          onEnd: ({ status, reason }) => {
            try {
              state.runEnd(runId, { status, reason });
              state.releaseLock(lockKey, runId);
              state.releaseLeases(runId);
            } catch { /* 收尾失败不影响已经结束的任务 */ }
          },
          /* 每一轮模型调用的用量都回到这里。三个约束：
             ① 不许抛错——记账失败不能把任务弄死；
             ② 只在撞线时中止，不到线不打断（不然用户会觉得「跑到一半莫名其妙停了」）；
             ③ 中止要留一句人话在事件流里，否则前端只看到 status=stopped。 */
          onUsage: (u) => {
            try {
              const r = recordTokens(scope, u || {});
              if (!r.exceeded) return;
              const why = r.exceeded === 'day'
                ? `今天的 token 额度用完了（${r.day.used}/${r.day.limit}）`
                : `这个月的 token 额度用完了（${r.month.used}/${r.month.limit}）`;
              if (liveRun) {
                liveRun.quotaStopped = why;
                liveRun.bus.push({ t: 'error', message: `账号额度：${why}，任务已停止。额度重置后可以继续。` });
                liveRun.abort(`账号额度：${why}`);
              }
              toolAudit({
                scope, name: 'quota.exceeded', args: { where: r.exceeded }, custom: null,
                category: 'none', level: 'default', ok: false, blocked: true, ms: 0,
                output: why, verify: { pass: false, why }, ...clientMeta(req)
              });
            } catch { /* 记账出错不影响任务本身 */ }
          }
        });
        liveRun = run;
      } catch (e) {
        state.runEnd(runId, { status: 'failed', reason: `起不来：${e.message}` });
        state.releaseLock(lockKey, runId);
        return send(res, 500, { ok: false, error: `起不来：${e.message}` });
      }

      RUNS.set(runId, run);

      toolAudit({
        scope, name: 'run.start', args: { runId, model: job.model || '' }, custom: null,
        category: 'none', level: 'default', ok: true, blocked: false, ms: 0,
        output: `服务端执行：${String(task.goal || '').slice(0, 120)}`,
        verify: { pass: true }, ...clientMeta(req)
      });

      return streamRun(req, res, run, 0);
    }

    /* 断线重连：按 seq 续传。刷新页面后前端会来这里把已经发生过的事件补出来，
       然后接着等新的——所以「刷新会丢进度」这件事从这一版起不再成立。 */
    if (u.pathname.startsWith('/api/run/') && req.method === 'GET') {
      const rest = u.pathname.slice('/api/run/'.length).split('/');
      const runId = decodeURIComponent(rest[0] || '');
      const run = RUNS.get(runId);
      if (!run) return goneRun(res, runId);
      /* 事件流里有完整对话和工具输出。以前只凭 runId 就能订阅，
         而 runId 就是任务 id，猜起来并不难。现在必须是这个工作区的主人。 */
      if (!ownsRun(run)) {
        return send(res, 404, { ok: false, error: '这个任务在服务端已经结束了' });
      }
      const from = Number(u.searchParams.get('from')) || 0;
      return streamRun(req, res, run, from);
    }

    /* 停止 */
    if (u.pathname.startsWith('/api/run/') && u.pathname.endsWith('/stop') && req.method === 'POST') {
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const runId = decodeURIComponent(u.pathname.slice('/api/run/'.length, -'/stop'.length));
      const run = RUNS.get(runId);
      if (!run) return send(res, 404, { ok: false, error: '任务已结束' });
      /* 停别人正在跑的任务，等于远程把人家的活掐了。必须是自己那一份 */
      if (!ownsRun(run)) return send(res, 404, { ok: false, error: '任务已结束' });
      run.abort('用户停止');
      return send(res, 200, { ok: true });
    }

    /* 中途插话 / 审批放行：这两件事原来都是同一个页面里的函数调用，
       搬到服务端之后必须能跨进程打回去，否则任务会卡在等审批那一步。 */
    if (u.pathname.startsWith('/api/run/') && req.method === 'POST'
      && (u.pathname.endsWith('/inject') || u.pathname.endsWith('/approve'))) {
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const tail = u.pathname.endsWith('/inject') ? '/inject' : '/approve';
      const runId = decodeURIComponent(u.pathname.slice('/api/run/'.length, -tail.length));
      const run = RUNS.get(runId);
      if (!run) return send(res, 404, { ok: false, error: '任务已结束' });
      /* 插话能改变别人任务的走向，审批能替别人放行一次危险操作——都必须是主人 */
      if (!ownsRun(run)) return send(res, 404, { ok: false, error: '任务已结束' });
      const b = await readBody(req, 8 * 1024 * 1024);
      if (tail === '/inject') {
        /* 插话带的截图同样是「只传路径」：这条请求体里塞 base64 一样会被网关拦，
           拦下来表现成「已插给员工」但其实谁也没收到。 */
        const imgs = hydrateImages(run.scope, b.images || []);
        const t = run.inject(String(b.text || ''), imgs);
        return send(res, 200, { ok: true, queued: !!t || (b.images || []).length > 0 });
      }
      run.approve(String(b.id || ''), !!b.ok);
      return send(res, 200, { ok: true });
    }

    /* 审计日志：读（后续后台管理页用）+ 写（前端权限变更等 UI 事件） */
    if (u.pathname === '/api/audit' && req.method === 'GET') {
      const scope = scopeKey(u.searchParams.get('scope'));
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const items = readAudit({
        scope,
        limit: u.searchParams.get('limit') || 200,
        from: u.searchParams.get('from') || undefined,
        to: u.searchParams.get('to') || undefined,
        kind: u.searchParams.get('kind') || undefined
      });
      return send(res, 200, { ok: true, count: items.length, items });
    }
    if (u.pathname === '/api/audit' && req.method === 'POST') {
      const b = await readBody(req);
      const scope = scopeKey(b.scope);
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const rec = writeAudit({
        kind: String(b.kind || 'ui_event'),
        scope,
        action: String(b.action || ''),
        target: String(b.target || ''),
        detail: String(b.detail || ''),
        level: String(b.target || ''),
        ...clientMeta(req)
      });
      return send(res, 200, { ok: true, id: rec.id, at: rec.at });
    }

    /* ── 管理员告警队列 ──
       验收没过 / 执行报错 / 预算超限：这些是运维要看的东西，不进老板的对话界面。
       前端同源投递；读队列和打卡要带 key，避免任务标题被谁都能翻。 */
    if (u.pathname === '/api/notify' && req.method === 'POST') {
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const b = await readBody(req, 256 * 1024);
      const a = b.alert && typeof b.alert === 'object' ? b.alert : {};
      /* 告警里的 scope 只是元数据，同样归一成目录名，别让同一个人的告警出现两种格式 */
      const rec = addAlert({ ...a, scope: scopeKey(a.scope || b.scope || '') });
      return send(res, 200, { ok: true, id: rec ? rec.id : '', to: ADMIN_EMAIL, accepted: !!rec });
    }
    /* ── 运维接口的鉴权 ──
       三条不同的来路，缺一不可：
         · 进程内自调用（服务端自己打自己）
         · 运维 key（cron / curl，没有浏览器登录态）
         · 管理员账号（人，登着录进来的）
       注意 key 的比较用的是 CONSTANT_TIME 式的前置判断：长度不一致就直接 false，
       不做逐字节短路——虽然这把 key 是随机 32 字节、爆破不现实，但「比较密钥」
       这件事写成按位比对是一种义务，不是可选的优化。 */
    function keyEq(a, b) {
      const x = String(a || ''); const y = String(b || '');
      if (!x || !y || x.length !== y.length) return false;
      let d = 0;
      for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
      return d === 0;
    }
    function adminOK(req, u) {
      if (isInternal(req)) return true;
      const key = String(u.searchParams.get('key') || req.headers['x-ren-admin'] || '');
      if (ALERTS_KEY && keyEq(key, ALERTS_KEY)) return true;
      const a = currentAuth();
      return !!(a && a.uid && isAdmin(a.uid));
    }

    /* ── 我最近跑过什么 ──
       存在的理由是多设备：同一账号在两台设备上，各自要知道「另一边是不是在跑」。
       以前这事靠内存里的一个 Map，重启后就答不上来了（只能答「不知道」）。 */
    if (u.pathname === '/api/runs' && req.method === 'GET') {
      const scope = scopeKey('');
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const limit = Math.min(20, Math.max(1, Number(u.searchParams.get('limit')) || 8));
      const rows = state.runRecent(scope, limit).map(r => ({
        id: r.id, title: r.title || '', device: r.device || '', status: r.status,
        reason: r.reason || '', startedAt: r.startedAt, endedAt: r.endedAt || 0
      }));
      /* 正在跑的那条附上「锁在谁手里」——多设备时前端靠它判断能不能再起一个 */
      const live = rows.filter(r => r.status === 'running');
      return send(res, 200, {
        ok: true, scope, runs: rows, running: live.length,
        state: state.modeOf()
      });
    }

    /* ── 额度：自己的 token 与磁盘 ──
       scope 一律由闸门给，参数里的 scope 不起作用——这条和所有其它接口一致。 */
    if (u.pathname === '/api/quota' && req.method === 'GET') {
      const scope = scopeKey(u.searchParams.get('scope'));
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const rep = quotaReport(scope);
      const t = rep.tokens || {};
      const d = rep.disk || {};
      return send(res, 200, {
        ok: true, scope,
        tokens: t, disk: d, limits: rep.limits,
        /* 一句人话：前端不用拿两个数自己算「还能不能干活」 */
        summary: d.frozen
          ? `写入已冻结：${d.frozenReason || '磁盘超限'}`
          : (t.day && t.day.remaining > 0
            ? `今天还剩 ${t.day.remaining} token，磁盘 ${fmtBytes(d.used)} / ${fmtBytes(d.limit)}`
            : `今天的 token 额度已用完，明天零点重置`)
      });
    }

    /* 自己解冻：清理完文件之后不该还要等管理员。
       但不能凭一句「我删了」就解——服务端实测，并且要降到 80% 以下才放行，
       否则刚贴着上限解冻、下一次上传立刻又冻，用户会在两个状态之间反复撞墙。 */
    if (u.pathname === '/api/quota/thaw' && req.method === 'POST') {
      const scope = scopeKey('');
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const lim = limitsOf(scope);
      const d = diskStatus(scope, { fresh: true });
      if (!d.ok) return send(res, 400, { ok: false, error: d.error });
      const target = Math.floor(lim.diskBytes * 0.8);
      if (d.used > target) {
        return send(res, 409, {
          ok: false, code: 'still_full',
          error: `现在还有 ${fmtBytes(d.used)}，要先降到 ${fmtBytes(target)} 以下才能解冻（上限的 80%）。`,
          disk: d
        });
      }
      const r = thaw(scope);
      toolAudit({
        scope, name: 'quota.thaw', args: { used: d.used }, custom: null,
        category: 'none', level: 'default', ok: !!r.ok, blocked: false, ms: 0,
        output: `实测 ${fmtBytes(d.used)}，低于阈值，解冻`, verify: { pass: !!r.ok }, ...clientMeta(req)
      });
      return send(res, 200, { ok: r.ok, disk: diskStatus(scope, { fresh: true }) });
    }

    /* ── 运维：所有账号的额度 ── */
    if (u.pathname === '/api/admin/quota' && req.method === 'GET') {
      if (!adminOK(req, u)) return send(res, 403, { ok: false, error: 'key 不对或不是管理员' });
      const probe = '0'.repeat(32);
      return send(res, 200, {
        ok: true,
        scopes: listScopes(),
        overrides: allLimitOverrides(),
        defaults: limitsOf(probe),
        dir: usageDir()
      });
    }
    if (u.pathname === '/api/admin/quota' && req.method === 'POST') {
      if (!adminOK(req, u)) return send(res, 403, { ok: false, error: 'key 不对或不是管理员' });
      const b = await readBody(req, 64 * 1024);
      const target = String(b.scope || '');
      if (!SCOPE_RE.test(target)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      let lim = null;
      if (b.tokenDaily !== undefined || b.tokenMonthly !== undefined || b.diskMb !== undefined) {
        const r = setLimits(target, { tokenDaily: b.tokenDaily, tokenMonthly: b.tokenMonthly, diskMb: b.diskMb });
        if (!r.ok) return send(res, 400, r);
        lim = r.limits;
      }
      let unfrozen = null;
      if (b.unfreeze) unfrozen = thaw(target);
      toolAudit({
        scope: target, name: 'admin.quota', args: { lim: !!lim, unfreeze: !!b.unfreeze }, custom: null,
        category: 'none', level: 'default', ok: true, blocked: false, ms: 0,
        output: `管理员调整额度${lim ? '：' + JSON.stringify(lim) : ''}${unfrozen ? '，并解冻写入' : ''}`,
        verify: { pass: true }, ...clientMeta(req)
      });
      return send(res, 200, { ok: true, limits: lim || limitsOf(target), quota: quotaReport(target) });
    }

    /* ── 运维：备份 ──
       注意这里**不提供** includeSecrets。把密钥打进包是可以的，但只能由人在机器上敲
       `node scripts/backup.mjs --keys` —— 一个 HTTP 请求不该有「把签名密钥导出成文件」的能力，
       哪怕调用者拿着运维 key（key 会泄漏，命令行不会）。 */
    if (u.pathname === '/api/admin/backup' && req.method === 'GET') {
      if (!adminOK(req, u)) return send(res, 403, { ok: false, error: 'key 不对或不是管理员' });
      return send(res, 200, { ok: true, ...backupStatus() });
    }
    if (u.pathname === '/api/admin/backup' && req.method === 'POST') {
      if (!adminOK(req, u)) return send(res, 403, { ok: false, error: 'key 不对或不是管理员' });
      if (!internal && !rateOK(req)) return send(res, 429, { ok: false, error: '调用太频繁，缓一下' });
      const r = await runBackup({ reason: 'api', includeSecrets: false, build: BUILD });
      writeAudit({
        kind: 'backup', scope: '', action: '手动备份', target: r.file || '',
        ok: !!r.ok, blocked: false, output: r.ok ? `${r.files} 个文件 ${fmtBytes(r.bytes)}` : r.error,
        ...clientMeta(req)
      });
      return send(res, r.ok ? 200 : 500, { ...r, status: backupStatus() });
    }
    if (u.pathname === '/api/admin/backup/verify' && req.method === 'POST') {
      if (!adminOK(req, u)) return send(res, 403, { ok: false, error: 'key 不对或不是管理员' });
      const b = await readBody(req, 64 * 1024);
      const file = String(b.file || '') || (listBackups()[0] || {}).file || '';
      if (!file) return send(res, 400, { ok: false, error: '没有任何备份可校验' });
      const r = verifyBackup(file);
      return send(res, r.ok ? 200 : 409, { ...r, file });
    }

    /* ── 运维：长连接探针 ──
       带 seconds 就开一条流，不带就返回历史。
       存在的理由：SSE 的三种失效（空闲超时 / 总时长上限 / 缓冲）在日志里全都看不出来，
       而「没报错」和「验证过」是两件事。有了它，换网关、改反代配置之后能当场复测，
       而不是等用户报「界面卡住不动」。 */
    if (u.pathname === '/api/admin/stream-probe' && req.method === 'GET') {
      if (!adminOK(req, u)) return send(res, 403, { ok: false, error: 'key 不对或不是管理员' });
      if (!u.searchParams.has('seconds')) {
        return send(res, 200, {
          ok: true,
          running: probeBusy(),
          history: probeHistory().slice(-5).reverse(),
          hint: '带 ?seconds=600 开一条真流；客户端记录每个 beat 的到达时刻，两者相减得到延迟'
        });
      }
      if (probeBusy()) {
        return send(res, 409, { ok: false, error: '已经有一条探针在跑了，等它结束', running: probeBusy() });
      }
      const r = streamProbe(req, res, {
        seconds: u.searchParams.get('seconds'),
        pingMs: u.searchParams.get('pingMs'),
        dataMs: u.searchParams.get('dataMs')
      });
      writeAudit({
        kind: 'probe', scope: '', action: '长连接探针', target: r.id,
        ok: true, blocked: false, output: `计划 ${Math.round(r.plannedMs / 1000)} 秒`,
        ...clientMeta(req)
      });
      return;
    }

    /* 沙箱自检：不靠「配置看起来对了」，而是用降权后的身份去读它**不该**读到的东西。
       三次真实尝试：自己的 uid 是多少、能不能读运维密钥、能不能列别人的目录。
       只有运维 key 能调——它返回 uid 和路径错误原文。 */
    if (u.pathname === '/api/sandbox-check' && req.method === 'GET') {
      if (String(u.searchParams.get('key') || '') !== ALERTS_KEY) {
        return send(res, 403, { ok: false, error: 'key 不对' });
      }
      const rt = probeRuntime();
      const probeScope = 'f'.repeat(32);
      const root = ensureScope(probeScope);
      const expectUid = uidForScope(probeScope);
      const run = (cmd) => runIsolated({ cmd, cwd: root, scope: probeScope, timeout: 8000 });

      const a = await run('id -u 2>&1');
      /* 密钥已迁出部署目录：现在要试的是密钥目录本身（新版位置）。
         老位置 data/alerts/.key 在迁移后就没了，拿它探会得到「文件不存在」，
         那不算拦住——所以这里探的是真的还在用的那把。 */
      const keyPath = path.join(secretDir(), 'alerts.key');
      const b = await run(`cat ${keyPath} 2>&1 | head -c 120`);
      const c = await run(`ls ${path.join(WORKSPACE_BASE, 'users')} 2>&1 | head -c 200`);

      /* 最终证据：造一个「受害者」账号目录，写一份机密，再用探针身份去读。
         这就是 2026-11-05 实测里那两行 JS 干的事——只不过那次真的读到了。 */
      const victimScope = 'e'.repeat(32);
      const victimRoot = ensureScope(victimScope);
      let victimCase = 'skip';
      try {
        fs.writeFileSync(path.join(victimRoot, 'secret.md'), '受害者账号的商业机密：单价 3.20');
        fs.chmodSync(victimRoot, 0o700);
        const r = await run(`cat ${path.join(victimRoot, 'secret.md')} 2>&1 | head -c 300`);
        const out = String(r.stdout || '');
        victimCase = /permission denied|operation not permitted/i.test(out)
          ? 'denied'
          : (/3\.20/.test(out) ? 'READ!!!' : 'other:' + out.slice(0, 120));
      } catch (e) {
        victimCase = 'err:' + String(e.message || '').slice(0, 40);
      }

      const d = await run('echo ok > ./__probe.txt && cat ./__probe.txt && rm -f ./__probe.txt');

      const outA = String(a.stdout || '').trim();
      const outB = String(b.stdout || '');
      const outC = String(c.stdout || '');
      const denied = (s) => /permission denied|operation not permitted/i.test(s);

      return send(res, 200, {
        ok: true,
        mode: rt.mode,
        uidMap: rt.uidMap || null,
        expectUid,
        actualUid: outA,
        dropped: outA === String(expectUid),
        readOpsKey: denied(outB) ? 'denied' : 'READ!!!',
        listOtherTenants: denied(outC) ? 'denied' : 'LISTED!!!',
        readOtherTenantFile: victimCase,
        writeOwnDir: /^ok$/m.test(String(d.stdout || '').trim()),
        detail: {
          keyErr: denied(outB) ? '' : outB.slice(0, 60),
          listErr: denied(outC) ? '' : outC.slice(0, 90)
        }
      });
    }

    if (u.pathname === '/api/alerts' && req.method === 'GET') {
      const withKey = String(u.searchParams.get('key') || '') === ALERTS_KEY;
      const me = currentAuth();
      /* 两条路，界线是「能不能看到别人的」：
         · 带对 key → 运维消费方，返回全量（key 现在是随机落盘的，不是仓库里的固定串）
         · 只带登录凭证 → 只看自己 scope 的告警
         以前只有 key 一条路，而 key 写死在源码里，等于任何登录用户都能读到
         所有人的任务标题和报错原文。 */
      if (!withKey && !(me && me.scope)) {
        return send(res, 403, { ok: false, error: '需要登录态，或运维用的 key' });
      }
      const items = listAlerts({
        days: Number(u.searchParams.get('days')) || 3,
        limit: Number(u.searchParams.get('limit')) || 200,
        /* 默认只给「还没发过信」的；all=1 看全部，便于排查 */
        onlyNew: u.searchParams.get('all') !== '1',
        scope: withKey ? '' : me.scope
      });
      return send(res, 200, {
        ok: true, to: withKey ? ADMIN_EMAIL : '', count: items.length,
        filtered: withKey ? 'all' : 'self', items
      });
    }
    if (u.pathname === '/api/alerts/ack' && req.method === 'POST') {
      const b = await readBody(req, 256 * 1024);
      if (String(b.key || u.searchParams.get('key') || '') !== ALERTS_KEY) {
        return send(res, 403, { ok: false, error: 'key 不对' });
      }
      const n = ackAlerts(b.ids);
      return send(res, 200, { ok: true, acked: n });
    }

    /* 交付物校验：任务到底算不算「做完」 */
    if (u.pathname === '/api/verify' && req.method === 'POST') {
      const b = await readBody(req);
      const scope = scopeKey(b.scope);
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const root = ensureScope(scope);
      const list = Array.isArray(b.deliverables) ? b.deliverables.map(String) : [];
      return send(res, 200, { ok: true, check: checkDeliverables(list, root) });
    }

    /* 交付物内容摘要：验收人要看到磁盘上真有东西、真写了这些内容。
       不能让它只看执行者自己的总结——那是「自我陈述」，书里明确不能当证据。 */
    if (u.pathname === '/api/digest' && req.method === 'POST') {
      const b = await readBody(req, 512 * 1024);
      const scope = scopeKey(b.scope);
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const root = scopeRoot(scope);
      if (!root) return send(res, 400, { ok: false, error: '工作区不存在' });
      const paths = Array.isArray(b.paths) ? b.paths.map(String) : [];
      /* since：这一轮的起始时间。给了就把「上一轮留下的旧文件」标出来，
         免得这一轮什么都没干、却拿旧文件当成新交付蒙混过关。 */
      const since = Number(b.since) || 0;
      const items = digestFiles(root, paths, since);
      return send(res, 200, { ok: true, items });
    }

    /* 附件上传：浏览器把文件读成 base64 传过来，落到工作区 uploads/日期/ 下 */
    if (u.pathname === '/api/upload' && req.method === 'POST') {
      const b = await readBody(req, 40 * 1024 * 1024);
      const scope = scopeKey(b.scope);
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const rawName = String(b.name || 'file');
      const ext = path.extname(rawName).toLowerCase();
      if (!UPLOAD_EXT.has(ext)) {
        return send(res, 400, { ok: false, error: `不支持的文件类型「${ext || '无扩展名'}」，能传的是 PDF / Word / Excel / PPT / CSV / 图片` });
      }
      let buf;
      try { buf = Buffer.from(String(b.data || ''), 'base64'); }
      catch { return send(res, 400, { ok: false, error: '文件内容解析失败' }); }
      if (!buf.length) return send(res, 400, { ok: false, error: '文件是空的' });
      if (buf.length > UPLOAD_MAX) {
        return send(res, 413, { ok: false, error: `文件太大（${(buf.length / 1048576).toFixed(1)}MB），单个上限 24MB` });
      }
      /* 磁盘配额：上传是唯一一条「一次就能灌进 24MB」的入口，必须在**写之前**查。
         写完再查等于「先让你写爆，再告诉你超了」，那时候别人的任务已经因为没空间失败了。
         状态码分开：507 = 空间不够，423 = 写入被冻结（原因不同，用户要做的事也不同）。 */
      const room = checkDisk(scope, buf.length);
      if (!room.ok) {
        return send(res, room.code === 'disk_frozen' ? 423 : 507, {
          ok: false, code: room.code, error: room.error, quota: diskStatus(scope)
        });
      }
      const root = ensureScope(scope);
      const day = new Date().toISOString().slice(0, 10);
      const base = path.basename(rawName).replace(/\.[^.]+$/, '')
        .replace(/[^\w\u4e00-\u9fa5 .-]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'file';
      const dirRel = `uploads/${day}`;
      fs.mkdirSync(path.join(root, dirRel), { recursive: true });
      let rel = `${dirRel}/${base}${ext}`;
      let n = 1;
      while (fs.existsSync(path.join(root, rel))) rel = `${dirRel}/${base}(${++n})${ext}`;
      fs.writeFileSync(path.join(root, rel), buf);
      noteDisk(scope, buf.length);
      return send(res, 200, {
        ok: true, path: rel, size: buf.length,
        kind: ext.replace('.', ''), mime: MIME[ext] || 'application/octet-stream'
      });
    }

    /* 语音转文字：前端录音 → 这里转发给硅基流动。
       为什么不在浏览器里直接用 Web Speech：Chrome 会把音频送到 Google 的识别服务，
       国内网络基本不可达，内嵌浏览器则根本没有这项服务，属于「必然失败」。
       错误一律用 200 + ok:false 返回，前端只需要看 message，不用区分状态码。 */
    if (u.pathname === '/api/asr' && req.method === 'POST') {
      const b = await readBody(req, 30 * 1024 * 1024);
      const key = String(b.key || req.headers['x-asr-key'] || process.env.SILICONFLOW_API_KEY || '').trim();
      if (!key) return send(res, 200, { ok: false, code: 'no-key', error: '还没配语音识别密钥' });
      let buf;
      try { buf = Buffer.from(String(b.data || ''), 'base64'); }
      catch (e) { return send(res, 200, { ok: false, error: '录音解析失败' }); }
      if (!buf.length) return send(res, 200, { ok: false, error: '录音是空的，再说一次' });
      if (buf.length > ASR_MAX) {
        return send(res, 200, { ok: false, error: `录音太长（${(buf.length / 1048576).toFixed(1)}MB），单次上限 20MB，分几次说` });
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      let r = null;
      let txt = '';
      try {
        const form = new FormData();
        form.set('model', ASR_MODEL);
        form.set('file', new Blob([buf], { type: String(b.mime || 'audio/wav') }), String(b.name || 'voice.wav'));
        r = await fetch(ASR_URL, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key },
          body: form,
          signal: ctrl.signal
        });
        txt = await r.text();
      } catch (e) {
        clearTimeout(timer);
        const to = e && (e.name === 'AbortError');
        return send(res, 200, {
          ok: false,
          error: to
            ? '转写超时了（音频太长或对方服务忙），再试一次'
            : '连不上语音识别服务：' + ((e && e.message) || '网络错误')
        });
      }
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(txt); } catch (e) {}
      if (!r.ok) {
        const raw = String((j && (j.message || j.error || j.detail)) || txt.slice(0, 300) || ('HTTP ' + r.status));
        let hint = raw;
        if (r.status === 401 || /invalid token|unauthor|api.?key/i.test(raw)) {
          hint = '密钥无效：去硅基流动「API 密钥」页重新复制一个（sk- 开头那串）';
        } else if (r.status === 403) hint = '这个密钥没有权限调语音模型';
        else if (r.status === 429) hint = '调用太频繁，等几秒再试';
        else if (r.status === 413) hint = '录音太大，一次别超过 50MB';
        return send(res, 200, { ok: false, code: 'upstream', status: r.status, error: hint });
      }
      const text = String((j && (j.text || (j.data && j.data.text))) || '').trim();
      if (!text) return send(res, 200, { ok: false, error: '这段没听清（可能太短或环境太吵），再说一次' });
      return send(res, 200, { ok: true, text, model: ASR_MODEL });
    }

    /* 产出物还在不在本地：一次问一批。
       沙箱是临时文件系统（重新发布 / 重启 / 长时间空闲会清空 workspace），
       但任务记录在云端还在，于是会出现「文件名还在、文件没了」。
       前端拿到 missing 列表后去云端把缺的拉回来。 */
    if (u.pathname === '/api/exists' && req.method === 'POST') {
      const b = await readBody(req, 512 * 1024);
      const scope = scopeKey(b.scope);
      const root = scopeRoot(scope);
      if (!root) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const paths = Array.isArray(b.paths) ? b.paths.map(String).slice(0, 400) : [];
      const missing = [], present = [];
      for (const rel of paths) {
        const t = inside(root, rel);
        let there = false;
        try { there = !!(t && fs.statSync(t).isFile()); } catch { there = false; }
        (there ? present : missing).push(rel);
      }
      return send(res, 200, { ok: true, present, missing });
    }

    /* 把云端存档写回工作区：换设备、或者沙箱重启之后，
       任务里的产出还能照常预览 / 下载 / 打包，前端其它代码一行不用改。 */
    if (u.pathname === '/api/restore' && req.method === 'POST') {
      const b = await readBody(req, 60 * 1024 * 1024);
      const scope = scopeKey(b.scope);
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const root = ensureScope(scope);
      const items = Array.isArray(b.items) ? b.items.slice(0, 80) : [];
      const written = [], skipped = [];
      let total = 0;
      for (const it of items) {
        const rel = String((it && it.path) || '');
        const data = String((it && it.data) || '');
        const target = inside(root, rel);
        if (!target || !data) { skipped.push(rel); continue; }
        let buf;
        try { buf = Buffer.from(data, 'base64'); } catch { skipped.push(rel); continue; }
        if (!buf.length) { skipped.push(rel); continue; }
        total += buf.length;
        if (total > 48 * 1024 * 1024) { skipped.push(rel); continue; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
        written.push(rel);
      }
      return send(res, 200, { ok: true, written, skipped });
    }

    /* 把工作区里的文件原样回给浏览器：图片预览、附件下载 */
    if (u.pathname === '/api/raw') {
      const scope = scopeKey(u.searchParams.get('scope') || '');
      const rel = u.searchParams.get('path') || '';
      const root = scopeRoot(scope);
      if (!root) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const target = inside(root, rel);
      if (!target) return send(res, 400, { ok: false, error: '路径超出工作区' });
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        return send(res, 404, { ok: false, error: '文件不存在' });
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return fs.createReadStream(target).pipe(res);
    }

    /* 文档预览：docx / xlsx / pptx 解成结构化内容，前端自己画。
       不追求还原排版——点开能看清写了什么、几列表格、几页幻灯片；要排版就下载后用本机 Office。 */
    if (u.pathname === '/api/preview' && req.method === 'GET') {
      const scope = scopeKey(u.searchParams.get('scope') || '');
      const rel = u.searchParams.get('path') || '';
      const root = scopeRoot(scope);
      if (!root) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const target = inside(root, rel);
      if (!target) return send(res, 400, { ok: false, error: '路径超出工作区' });
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        return send(res, 404, { ok: false, error: '文件不在工作区了（沙箱被清过）；重新跑一次或从本机文件夹恢复' });
      }
      try {
        const d = previewOffice(target, path.extname(target).toLowerCase());
        return send(res, 200, { ok: true, ...d });
      } catch (e) {
        return send(res, 200, { ok: false, error: (e && e.message) || '读不出来' });
      }
    }

    /* 工作区浏览 */
    if (u.pathname === '/api/files') {
      const scope = scopeKey(u.searchParams.get('scope') || '');
      const r = listFiles(scope, u.searchParams.get('path') || '.');
      if (r.error) return send(res, 400, { ok: false, error: r.error });
      return send(res, 200, { ok: true, items: r.items, root: r.root });
    }

    /* 原始文件下载。md / txt 走下面那个返回 JSON 的文本接口，
       但 pptx / xlsx 这类二进制必须原样吐出去——按 utf8 读一遍就废了。 */
    if (u.pathname === '/api/file' && u.searchParams.get('raw') === '1') {
      const scope = scopeKey(u.searchParams.get('scope') || '');
      const root = scopeRoot(scope);
      if (!root) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      const target = inside(root, u.searchParams.get('path') || '');
      if (!target) return send(res, 400, { ok: false, error: '路径超出工作区' });
      let st;
      try { st = fs.statSync(target); } catch { return send(res, 404, { ok: false, error: '文件不存在' }); }
      if (st.isDirectory()) return send(res, 400, { ok: false, error: '这是目录' });
      if (st.size > 40 * 1024 * 1024) return send(res, 400, { ok: false, error: '文件太大（>40MB）' });
      const name = path.basename(target);
      const MIME = {
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
        '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.csv': 'text/csv; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
        '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8'
      };
      /* inline=1：给 <img> 用，不进下载队列 */
      const inline = u.searchParams.get('inline') === '1';
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return fs.createReadStream(target).pipe(res);
    }

    if (u.pathname === '/api/file') {
      const scope = scopeKey(u.searchParams.get('scope') || '');
      const rel = u.searchParams.get('path') || '';
      const r = readTextFile(scope, rel);
      if (r.error) return send(res, 400, { ok: false, error: r.error });
      return send(res, 200, { ok: true, path: rel, text: r.text.slice(0, 200000), size: r.size });
    }

    /* ── 记忆 ──
     * 存在这个 scope 自己的目录下（memory/<scope>/），跟工作区分开：
     * 员工能读到注入进上下文的记忆，但不能用 write_file 直接改它——
     * 记忆必须经过「确认过的事实」这条路，否则就是自说自话。 */
    if (u.pathname === '/api/memory' && req.method === 'GET') {
      const scope = scopeKey(u.searchParams.get('scope') || '');
      const kind = u.searchParams.get('kind') || 'company';
      const id = u.searchParams.get('id') || '';
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      if (!MEMORY_KINDS.includes(kind)) return send(res, 400, { ok: false, error: '记忆类型不合法' });
      if (kind === 'staff' && !id) return send(res, 200, listStaff(scope));
      if (kind === 'project' && !id) return send(res, 200, listProjects(scope));
      const doc = readDoc(scope, kind, id);
      if (!doc.ok) return send(res, 400, doc);
      return send(res, 200, {
        ok: true, kind, id: doc.id, entries: doc.entries, prose: doc.prose, raw: doc.raw,
        counts: doc.counts, types: MEMORY_TYPES
      });
    }

    /* 拼好可以直接进 system 的记忆段落（召回按这次任务的目标做相关性排序）。
       带上 pj=<项目 id> 时，项目共享记忆也会一起带进来——项目里谁干活都用同一份。 */
    if (u.pathname === '/api/memory/brief' && req.method === 'GET') {
      const scope = scopeKey(u.searchParams.get('scope') || '');
      const id = u.searchParams.get('id') || '';
      const name = u.searchParams.get('name') || '';
      const q = u.searchParams.get('q') || '';
      const pj = u.searchParams.get('pj') || '';
      const pjn = u.searchParams.get('pjn') || '';
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      return send(res, 200, {
        ok: true,
        brief: memoryBrief(scope, id, name, q, { projectId: pj, projectName: pjn })
      });
    }

    if (u.pathname === '/api/memory' && req.method === 'POST') {
      const b = await readBody(req);
      const scope = scopeKey(b.scope);
      const kind = String(b.kind || 'staff');
      const id = String(b.id || '');
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      if (!MEMORY_KINDS.includes(kind)) return send(res, 400, { ok: false, error: '记忆类型不合法' });
      if (kind === 'company' && typeof b.text === 'string') {
        return send(res, 200, replaceCompany(scope, b.text));
      }
      /* 项目记忆第一次写时，把项目名记在正文第一行：面板上显示名字而不是一串 id */
      if (kind === 'project' && b.id && b.title) {
        try {
          const cur = readDoc(scope, 'project', b.id);
          if (cur.ok && !String(cur.prose || '').trim()) {
            writeProjectTitle(scope, b.id, b.title);
          }
        } catch { /* 记不上名字不影响写条目 */ }
      }
      const r = appendEntries(scope, kind, id, b.add || b.items, String(b.src || '').slice(0, 60), {
        srcId: String(b.srcId || ''),
        candidate: !!b.candidate
      });
      return send(res, r.ok ? 200 : 400, r);
    }

    /* 改一条记忆：停用 / 恢复 / 纠正文字 / 改类型 / 改重要度 */
    if (u.pathname === '/api/memory' && req.method === 'PATCH') {
      const b = await readBody(req);
      const scope = scopeKey(b.scope);
      const kind = String(b.kind || 'staff');
      const id = String(b.id || '');
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      if (!MEMORY_KINDS.includes(kind)) return send(res, 400, { ok: false, error: '记忆类型不合法' });
      /* 采纳一条候选：转成有效，顺手处理跟现行说法冲突的旧条目 */
      if (b.approve) {
        const r = approveEntry(scope, kind, id, b.entryId);
        return send(res, r.ok ? 200 : 400, r);
      }
      const r = updateEntry(scope, kind, id, b.entryId, {
        status: b.status, text: b.text, type: b.type, imp: b.imp
      });
      return send(res, r.ok ? 200 : 400, r);
    }

    if (u.pathname === '/api/memory' && req.method === 'DELETE') {
      const b = await readBody(req);
      const scope = scopeKey(b.scope);
      const kind = String(b.kind || 'staff');
      const id = String(b.id || '');
      if (!SCOPE_RE.test(scope)) return send(res, 400, { ok: false, error: '工作区标识不合法' });
      if (!MEMORY_KINDS.includes(kind)) return send(res, 400, { ok: false, error: '记忆类型不合法' });
      const r = b.clear ? clearDoc(scope, kind, id) : deleteEntry(scope, kind, id, b.entryId);
      return send(res, r.ok ? 200 : 400, r);
    }

    send(res, 404, { ok: false, error: 'no route' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
    else try { res.end(); } catch { /* ignore */ }
  }
}

/* ── 启动时把租户边界交给 OS ──
   应用层的路径围栏挡的是「工具调用」，挡不住 shell 里的任意代码（见 lib/sandbox.js）。
   这里在服务起来之前做两件事：
     1. 每个账号目录 chown 到它自己的 uid、chmod 700 —— 降权后的子进程读不到别人的
     2. data/ 关到 700、workspace 根设 711 —— 密钥和审计不被普通 uid 读到，
        但仍能穿越走到自己的目录 */
const RT = probeRuntime();
const SANDBOX = { mode: RT.mode, why: RT.why, hardened: 0 };
if (RT.mode === 'uid-split') {
  try { fs.chmodSync(path.join(__dirname, 'data'), 0o700); } catch { /* 可能不存在 */ }
  try { fs.chmodSync(WORKSPACE_BASE, 0o711); } catch { /* 只读盘 */ }
  const usersDir = path.join(WORKSPACE_BASE, 'users');
  try { fs.mkdirSync(usersDir, { recursive: true }); fs.chmodSync(usersDir, 0o711); } catch { /* ignore */ }
  const r = hardenAll(usersDir);
  SANDBOX.hardened = r.done || 0;
}

/* ── 备份调度 ──
   为什么需要「启动就开始跑」而不是等运维想起：这个应用此前一份备份都没有过。
   一个靠人记得住的机制，在忙起来的第一周就会失效。
   第一次检查推迟 90 秒，避开冷启动的 IO 高峰。 */
const BACKUP_PLAN = scheduleBackups({ build: BUILD });

server.listen(PORT, BIND, () => {
  console.log('');
  console.log('  Ren Agent · 工具执行器 + 执行循环 v0.4 已启动');
  console.log('  ────────────────────────────────────────────');
  console.log('  监听：  ' + BIND + ':' + PORT);
  console.log('  工作区：' + WORKSPACE_BASE);
  console.log('  循环：  ' + '在服务端跑（v0.4 起；浏览器只订阅事件流）');
  console.log('  身份：  ' + (AUTH_MODE === 'off'
    ? '⚠ 已关闭（REN_AUTH_MODE=off）—— 任何人都能读写任意工作区'
    : '云端验签（whoami）+ 文件签名 fk'));
  console.log('  沙箱：  ' + (SANDBOX.mode === 'uid-split'
    ? `uid-split（${SANDBOX.hardened} 个账号目录已降权到独立 uid）`
    : `${SANDBOX.mode} —— ${SANDBOX.why}`));
  console.log('  模型：  ' + (process.env.REN_LLM_BASE || cloudEndpoint() || '未配置') + '/.cloud/llm');
  /* 密钥位置要在启动日志里出现一次：它决定了「重新发布后图片链接还能不能用」。
     看不到这行的目录，就没法判断线上是不是把密钥放回了部署目录。 */
  {
    const sd = secretDirInfo();
    const warmLen = warmSecret();
    console.log('  密钥：  ' + sd.path + (sd.outsideApp ? '（部署目录之外）' : ' ⚠ 在部署目录内')
      + (warmLen ? '' : ' ⚠ 签名密钥解析失败，文件链接会失效'));
    console.log('  版本：  ' + (BUILD.commit
      ? `${BUILD.commit}${BUILD.dirty ? '（有未提交改动）' : ''} @ ${BUILD.at}`
      : '未标记（本地直接运行，不是一次发布）'));
  }
  console.log('  数据：  云数据库（员工 / 任务 / 设置按登录账号隔离）');
  /* 备份和配额这两行也要在启动日志里出现：
     它们都是「平时看不见、出事才知道有没有」的东西。日志里没有，就等于没有。 */
  {
    const b = backupStatus();
    console.log('  备份：  ' + b.dir + `（${b.count} 份，每 ${b.hours} 小时一份，留 ${b.keep} 份）`
      + (b.stale ? ' ⚠ 上次备份已经超过计划间隔' : ''));
  }
  {
    const lim = limitsOf('0'.repeat(32));
    console.log('  配额：  每账号每天 ' + lim.tokenDaily.toLocaleString('en-US') + ' token、'
      + '每月 ' + lim.tokenMonthly.toLocaleString('en-US') + ' token、磁盘 ' + fmtBytes(lim.diskBytes)
      + `（用量在 ${usageDir()}）`);
  }
  /* 预编译前端那 7 个脚本：第一个任务不用再等 40ms 编译，也顺手验证壳能装起来。
     装不起来就别等到用户点执行才报错——启动时就要喊出来。 */
  try {
    const n = warmup();
    console.log('  循环文件：' + n + ' 个已预编译（public/*.js，与服务端同一份代码）');
  } catch (e) {
    console.log('  ⚠ 循环加载失败：' + e.message);
    console.log('    服务端执行会不可用，浏览器本地执行不受影响。');
  }
  if (LOCAL_ONLY) {
    console.log('');
    console.log('  本机模式：云服务要求「已发布域名」作为 Origin，');
    console.log('  本机打开只能看界面，登录与存储要在线上域名里验证。');
  }
  console.log('');
});
