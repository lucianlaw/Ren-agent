// 管理员告警队列
//
// 为什么要有这一层：验收没过、执行报错、预算超限这些是「产品要修的问题」，
// 不该摊在老板的任务对话里（老板要的是成品，不是质检单），但也不能就这么丢掉。
// 所以前端只负责把告警投过来，这里按天落盘；发邮件交给队列的消费方
// （定时任务读 /api/alerts，汇总后发给管理员邮箱）。
//
// 落盘：data/alerts/YYYY-MM-DD.jsonl，一行一条，追加写。
// 已投递标记写在 data/alerts/mailed.json（{ id: 时间戳 }），消费方 ack 之后写这里。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { secretValue } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DIR = process.env.ALERTS_DIR
  ? path.resolve(process.env.ALERTS_DIR)
  : path.join(ROOT, 'data', 'alerts');
const MAILED = path.join(DIR, 'mailed.json');

try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 目录不可写就静默降级 */ }

function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

/* 收件人：默认就是管理员的固定邮箱，可用 ADMIN_EMAIL 覆盖 */
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'livincuzlove@agent.qq.com';

/* 读队列要带 key：任务是老板的私事，不挂 key 等于对外开放。
 *
 * 这个 key 以前是写死的字符串（'ra-alerts-2f9c41'）。单人用时无所谓，
 * 多人场景下它就是一个公开口令：任何登录用户翻一下仓库源码就能带着它
 * 把**所有人**的任务标题、目标、报错原文拉走。所以改成随机生成。
 *
 * 生成位置又改过一次：原先落在 data/alerts/.key，而 data/ 在部署目录里，
 * 每次发布都会把本机的这一把传给线上——本机脚本因此天然能读线上队列。
 * 现在由 config 统一放到部署目录之外，旧的 data/alerts/.key 首次读到时自动迁走。
 * 唯一需要双端一致的就是这把 key（定时任务在我本机跑，要读线上的队列），
 * 所以它靠「迁移时两端取同一个值」保持一致，而不是靠随包上传。 */
function makeKey() {
  return secretValue('alerts.key', {
    env: 'ALERTS_KEY',
    bytes: 18,
    minLen: 24,
    legacy: path.join(DIR, '.key')
  });
}
export const ALERTS_KEY = makeKey();

const KINDS = new Set(['verify', 'error', 'budget']);

function clip(v, n) {
  const s = v == null ? '' : String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* 一条告警必须能独立看懂：谁、哪个任务、哪一轮、什么结局、缺什么。
   没有这些字段的投递直接丢，免得队列里堆一堆没法处理的噪音。 */
export function normalize(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const kind = String(a.kind || '');
  if (!KINDS.has(kind)) return null;
  const gaps = Array.isArray(a.gaps) ? a.gaps.map(g => clip(g, 400)).slice(0, 8) : [];
  const rec = {
    id: crypto.randomUUID(),
    at: Number(a.at) || Date.now(),
    recvAt: Date.now(),
    kind,
    kindName: { verify: '验收没过', error: '执行报错', budget: '预算超限' }[kind],
    scope: /^[a-f0-9]{32}$/.test(String(a.scope || '')) ? String(a.scope) : '',
    taskId: clip(a.taskId, 80),
    taskTitle: clip(a.taskTitle, 120),
    goal: clip(a.goal, 400),
    employee: clip(a.employee, 40),
    round: Number(a.round) || 1,
    status: clip(a.status, 30),
    tokens: {
      in: Number(a.tokens && a.tokens.in) || 0,
      out: Number(a.tokens && a.tokens.out) || 0
    },
    models: clip(a.models, 80),
    /* 验收类 */
    verdict: clip(a.verdict, 20),
    score: Number(a.score) || 0,
    gaps,
    note: clip(a.note, 400),
    verifier: clip(a.verifier, 60),
    /* 报错 / 预算类 */
    error: clip(a.error, 1200),
    budget: Number(a.budget) || 0,
    spent: Number(a.spent) || 0
  };
  if (!rec.taskTitle && !rec.goal) return null;
  return rec;
}

/* 写一条：同一天同任务同轮同类只留一条（前端已经去过重，这里再兜一次，
   防止刷新/重试把同一个毛病刷成几十条） */
export function addAlert(raw) {
  const rec = normalize(raw);
  if (!rec) return null;
  const file = path.join(DIR, `${dayKey(new Date())}.jsonl`);
  const dupKey = [rec.taskId, rec.round, rec.kind, rec.status].join('|');
  try {
    if (fs.existsSync(file)) {
      const body = fs.readFileSync(file, 'utf8');
      for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if ([o.taskId, o.round, o.kind, o.status].join('|') === dupKey) return o;
        } catch { /* 坏行跳过 */ }
      }
    }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch { /* 落盘失败也别让前端报错 */ }
  return rec;
}

function readMailed() {
  try { return JSON.parse(fs.readFileSync(MAILED, 'utf8')) || {}; } catch { return {}; }
}

/* 最近 N 天的告警（默认 3 天，够定时任务一天一取不会漏）
 * scope：给了就只返回这个工作区的。登录用户在界面上读队列时必须带
 * ——告警正文里有任务标题、目标和报错原文，跨账号读等于把别人的活摊开看。 */
export function listAlerts({ days = 3, limit = 200, onlyNew = true, scope = '' } = {}) {
  const mailed = onlyNew ? readMailed() : {};
  const want = String(scope || '');
  const out = [];
  const now = new Date();
  for (let i = 0; i < Math.max(1, Math.min(30, days)); i++) {
    const d = new Date(now.getTime() - i * 86400000);
    const file = path.join(DIR, `${dayKey(d)}.jsonl`);
    if (!fs.existsSync(file)) continue;
    let body = '';
    try { body = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (onlyNew && mailed[o.id]) continue;
        if (want && String(o.scope || '') !== want) continue;
        out.push(o);
      } catch { /* 坏行跳过 */ }
    }
  }
  out.sort((a, b) => (a.at || 0) - (b.at || 0));
  return out.slice(-Math.max(1, Math.min(1000, limit)));
}

/* 消费方发完信回来打卡：打过的不再重复发 */
export function ackAlerts(ids) {
  const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (!list.length) return 0;
  const mailed = readMailed();
  const now = Date.now();
  for (const id of list) mailed[id] = now;
  /* 只留 60 天，文件不会无限长 */
  const keep = now - 60 * 86400000;
  for (const [k, v] of Object.entries(mailed)) if (Number(v) < keep) delete mailed[k];
  try { fs.writeFileSync(MAILED, JSON.stringify(mailed)); } catch { /* 忽略 */ }
  return list.length;
}
