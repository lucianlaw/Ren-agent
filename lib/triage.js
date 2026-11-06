/* ── 分诊：这一轮该开哪一张单 ──

   前五步都有了：看得见、进不去（dev 闸门）、能领取、能自证、有地方改。
   缺的是「谁起这一轮」。没有这一层，那五步就等同一套没人按的按钮：
   单子堆在那里，谁都不知道该先动哪张、哪张根本不该动。

   这一层的产出只有两个：**选一张**、**说清为什么跳过其余**。
   第二个至少和第一个一样重要——「这周一张都没修」有两种完全不同的原因：
   真没有错，或者全被规则挡掉了。只报第一个，第二种会被当成第一种。

   三条克制：
   1. 只派 self。external 不是我们的代码（模型网关、网络），either 要人判归属。
      把 external 派出去，等于让它对着不可能改的东西烧一晚上。
   2. 单张最多试 3 次、间隔 6 小时。同一份代码 + 同一份上下文，重试大概率同样的结果；
      而它每次失败都要跑一遍全量测试（一分钟起）。
   3. 一天最多开 5 张。这是给机器留的余量，不是效率指标。

   判定全在服务端，命令行只负责发请求和把回执翻成人话。
   理由和 repair 那一层一样：命令行要是能判定，那判定就等于没有。 */

import fs from 'node:fs';
import path from 'node:path';
import { listTickets, getTicket, toTaskPrompt } from './ticket.js';
import { available, list as listRepairs, stateDir, attemptIndex, begin } from './repair.js';

export const POLICY = {
  maxAttempts: 3,
  cooldownMs: 6 * 3600e3,
  dailyBudget: 5
};

const TZ = 0;                                     /* 和审计一样按本机时区算「今天」 */
const clip = (s, n) => {
  const t = s == null ? '' : String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

function dayKey(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function decisionsDir() {
  return path.join(stateDir(), 'decisions');
}

function appendDecision(rec) {
  try {
    const dir = decisionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, dayKey(Date.now()) + '.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch {
    return false;                                  /* 记不下不影响派活，但确实会看不到历史 */
  }
}

/* 读回决策历史：用来回答「为什么这周一张都没修」。 */
export function decisions({ days = 7, now = Date.now(), limit = 500 } = {}) {
  const out = [];
  const dir = decisionsDir();
  for (let i = 0; i < days; i++) {
    const f = path.join(dir, dayKey(now - i * 864e5) + '.jsonl');
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 半截行跳过 */ }
    }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out.slice(0, Math.max(1, Math.min(limit, 2000)));
}

/* ── 单张能不能派 ──
   返回 null 表示可以；否则给一个 code + 一句人话。
   code 是给统计用的（「这周 47 次都是 owner-external」一眼能看出来），
   人话是给看日志的人用的。两个都要：只有人话统计不了，只有 code 看不懂。 */
function blockedBecause(t, ctx) {
  if (t.state === 'dropped') return { code: 'state-dropped', why: '已经判定不修（dropped）' };
  if (t.state === 'fixed') return { code: 'state-fixed', why: '已经交单，等人复核（fixed）' };
  if (t.state === 'verified') {
    /* 修好之后又犯了，是另一回事：那次修复只压住了症状。
       这时不该跳过——它比一张新单更值得看。 */
    if (!t.reopened) return { code: 'state-verified', why: '已复核通过（verified）' };
  }
  if (t.owner === 'external') return { code: 'owner-external', why: '不是我们的代码（模型网关 / 网络），改了也没用' };
  if (t.owner === 'either') return { code: 'owner-either', why: '归属待定，要人先判是它的问题还是外部的问题' };

  const a = ctx.attempts.get(t.key);
  const n = a ? a.n : 0;
  if (n >= ctx.policy.maxAttempts) {
    return { code: 'attempts', why: `已经试过 ${n} 次都没修成，转人工（它修不动的，让它一直试等于烧时间）` };
  }
  if (a && a.lastMs && ctx.now - a.lastMs < ctx.policy.cooldownMs) {
    const h = Math.round((ctx.now - a.lastMs) / 3600e3);
    return { code: 'cooldown', why: `${h} 小时前刚试过，同一份代码重试大概率同样结果（${Math.round(ctx.policy.cooldownMs / 3600e3)} 小时后再派）` };
  }
  return null;
}

/* ── 选一张 ──
   不 begin，只决定。begin 那一步有副作用（建分支、领单），
   要能分开——不然「看看会选谁」这件事本身就会改动仓库。 */
export function pick({ now = Date.now(), env = process.env, policy = POLICY, dryRun = false } = {}) {
  const av = available(env);
  if (!av.ok) return { ok: false, code: av.code, error: av.why };

  const idx = attemptIndex();
  const ctx = { now, policy, attempts: idx };

  /* 今天已经开了几张：按「今天动过的单子」算，不按 begin 次数。
     一张单今天被退回重开两次，对机器的消耗和一张新单是一次量级，
     但它对「今天还剩多少余量」的占用不该翻倍——所以这里数单子。 */
  const today = dayKey(now);
  let used = 0;
  for (const v of idx.values()) if (v.lastMs && dayKey(v.lastMs) === today) used++;

  const budget = { used, limit: policy.dailyBudget, left: Math.max(0, policy.dailyBudget - used) };

  const all = listTickets({ limit: 300 }).tickets;
  const skipped = [];
  let chosen = null;

  /* 排序：复发优先，然后按分。
     「修好又犯」比「没修过」值钱——前者说明上次的修复只压住了症状。 */
  const ordered = [...all].sort((a, b) => (Number(b.reopened) - Number(a.reopened)) || (b.score - a.score));

  for (const t of ordered) {
    const b = blockedBecause(t, ctx);
    if (b) { skipped.push({ key: t.key, sig: t.sig, code: t.code, owner: t.owner, score: t.score, state: t.state, why: b.why, reason: b.code }); continue; }
    if (!chosen) chosen = t;
    else skipped.push({ key: t.key, sig: t.sig, code: t.code, owner: t.owner, score: t.score, state: t.state, why: '排在后面，这一轮先不动它', reason: 'not-first' });
  }

  const active = listRepairs().filter(r => r.status === 'active');

  /* 先取决于「已经在修的那张」，再看有没有新的。
     反过来（先挑新的、挑不到才说在修）有个很坑的形态：单子只有一张、
     而它正在被修，回执会说「没有可派的单子」——同一件事，听起来像「没事可做」，
     实际是「有一张正在做」。这两句对下一步动作的引导完全相反。 */
  if (active.length) {
    return {
      ok: true,
      pick: null,
      resume: active[0],
      skipped, budget,
      why: `已经有一张在修（${active[0].key} / ${active[0].branch}）。先把那张走完——同时开两张会互相踩 worktree`
    };
  }

  if (!chosen) {
    const byReason = {};
    for (const s of skipped) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    return {
      ok: true, pick: null, skipped, budget, byReason,
      why: all.length ? '没有可派的单子（原因见 byReason）' : '还没有任何报错归组出来的单子'
    };
  }

  if (budget.left <= 0) {
    return {
      ok: true, pick: null, skipped, budget,
      why: `今天的额度用完了（${budget.used}/${budget.limit}）。这是给机器留的余量，不是效率指标`
    };
  }

  return { ok: true, pick: chosen, skipped, budget, dryRun };
}

/* ── 起一轮 ──
   选 + 开。dryRun 时只选不开，但仍记一条决策——
   「看过、决定不开」和「根本没看」在事后要能分开。 */
export async function next({ now = Date.now(), env = process.env, policy = POLICY, dryRun = false, by = 'ren' } = {}) {
  const p = pick({ now, env, policy, dryRun });
  const rec = {
    at: new Date(now).toISOString(),
    picked: p.pick ? p.pick.key : '',
    sig: p.pick ? p.pick.sig : '',
    resume: p.resume ? p.resume.key : '',
    why: p.why || '',
    budget: p.budget || null,
    byReason: {},
    dryRun: !!dryRun
  };
  for (const s of (p.skipped || [])) rec.byReason[s.reason] = (rec.byReason[s.reason] || 0) + 1;

  if (!p.ok || !p.pick || dryRun) {
    if (p.ok) appendDecision(rec);
    /* 只看不派的时候也要能看到任务书——否则「它会派什么活」这个问题
       只能靠真派一次来回答，而真派是有副作用的。 */
    if (p.ok && p.pick && dryRun) {
      const t = getTicket(p.pick.sig);
      return { ...p, task: t ? toTaskPrompt(t) : '' };
    }
    return p;
  }

  const b = await begin({ sig: p.pick.sig, by, env });
  rec.began = !!b.ok;
  rec.beganWhy = b.ok ? '' : clip(b.error, 200);
  appendDecision(rec);

  if (!b.ok) {
    /* 开不起来不是「跳过」——是这一轮根本没法开始。
       把原因原样带出去（源码脏、分支残留、单子被别人领了），别自己再编一个。 */
    return { ...p, ok: false, error: b.error, began: b };
  }
  return { ...p, began: b, task: b.task || '' };
}

/* ── 这周为什么没修 ──
   把决策历史按原因聚一遍。没有这个，回答「怎么一张都没修」只能靠翻日志。 */
export function triageStats({ days = 7, now = Date.now() } = {}) {
  const rows = decisions({ days, now, limit: 2000 });
  const reasons = {};
  let rounds = 0, picked = 0, began = 0;
  for (const r of rows) {
    rounds++;
    if (r.picked) picked++;
    if (r.began) began++;
    for (const [k, v] of Object.entries(r.byReason || {})) reasons[k] = (reasons[k] || 0) + v;
  }
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([reason, n]) => ({ reason, n }));
  return { days, rounds, picked, began, top, last: rows[0] || null };
}

