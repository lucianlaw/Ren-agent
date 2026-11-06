// 工单：把「同一个错误犯了 37 次」变成「一张能被领取、能被复核的任务」。
//
// 为什么不能只用 groupIncidents 的结果：
//   归组是**现算**的——次数、首末次、最新样本每次都不一样。这是对的，
//   因为它是事实。但「这张单子谁领了、修没修、复核过没」不是事实，是**状态**，
//   状态必须落盘，否则每次刷新列表都回到「没人管」。
//   所以这一层的做法是：事实每次现算，状态单独存，按签名合并。
//
// 三个刻意的设计：
//   1. 状态文件按 sig 的哈希命名，不按 sig 本身。sig 里有 `|` 和可能很长的
//      路由串，直接当文件名在 Windows 上非法，在某些文件系统上还会超长。
//   2. 复现步骤从审计日志里取「报错前 10 分钟、同一账号的最后 8 步操作」。
//      没有它，工单只是一条统计；有了它，「修什么」才有着落。
//      拿不到就明说拿不到——编一个假的复现路径比没有更坏。
//   3. 修复任务里**前置**红线清单。等它改完再拒绝，等于浪费一整轮推理，
//      而且它改的那一版已经进了工作区。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { groupIncidents, CODES } from './incident.js';
import { readAudit } from './audit.js';
import { loadProof, dropProof, proofKeys } from './proof.js';
import { dataDir, ensureDir } from './testdir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DIR = ensureDir(dataDir('TICKET_DIR', 'tickets'));

/* 签名算法的版本。
   签名一变，所有状态文件的 key 都会失联，工单历史会「凭空消失」——
   不是数据没了，是找不到。存一个版本号，读到对不上的就知道是这么回事，
   而不是以为这些 bug 从来没出现过。以后改 signature() 时记得 +1。 */
const SIG_VER = 1;

export const STATES = ['open', 'claimed', 'fixed', 'verified', 'dropped'];

/* 允许的状态迁移。写死而不是「随便改」，因为非法迁移正是最容易出的事：
   从 verified 直接跳回 open 会让「修好了」这件事无法统计。 */
const NEXT = {
  open:     ['claimed', 'dropped'],
  claimed:  ['fixed', 'dropped', 'open'],
  fixed:    ['verified', 'claimed'],   // 复核不过 → 打回，不是重开
  verified: [],                        // 终态；复发由 reopened 标记，不改状态
  dropped:  ['open']                   // 判定为噪音后又能重开
};

/* 严重度：决定「同样被报 10 次，先修哪个」。
   不是按错误的「吓人程度」排，是按**能不能悄悄毁掉东西**排：
   进程级异常和状态库读写失败都是「表面正常、底下已经不对」的那一类。 */
const SEVERITY = {
  E_PROCESS: 3, E_HTTP_5XX: 3, E_STATE: 3,
  E_UI_RENDER: 2, E_TOOL_FAIL: 2, E_TOOL_ARGS: 2, E_TOOL_DENY: 2,
  E_UNKNOWN: 2, E_HTTP_4XX: 2, E_AUTH: 2, E_LLM_EMPTY: 2, E_LLM_BAD: 2,
  E_LLM_GATE: 1, E_LLM_QUOTA: 1, E_LLM_TIMEOUT: 1, E_NET: 1
};

/* 红线：这些文件改了，等于它有权决定「谁能干什么」。
   放在任务模板里**前置**给出来，而不是等复核时再拒。 */
export const RED_FILES = [
  'lib/authn.js / lib/identity.js（身份）',
  'lib/perms.js（权限档位）',
  'lib/quota.js（计费）',
  'lib/trash.js / lib/purge.js（数据删除）',
  'lib/tools.js 的 within() / DENY_PATH（路径围栏）',
  'server.js 的 PUBLIC_API / OPTIONAL_AUTH（免登录边界）'
];

const clip = (s, n) => {
  const t = s == null ? '' : String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export function keyOf(sig) {
  return crypto.createHash('sha1').update(String(sig || '')).digest('hex').slice(0, 16);
}

function fileOf(key) {
  return path.join(DIR, key + '.json');
}

function loadState(sig) {
  const key = keyOf(sig);
  try {
    const o = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
    if (!o || o.sig !== sig) return null;
    return o;
  } catch {
    return null;
  }
}

function saveState(st) {
  const key = keyOf(st.sig);
  st.key = key;
  st.sigVer = SIG_VER;
  st.updatedAt = new Date().toISOString();
  try {
    /* 先写临时文件再 rename：直接覆盖时如果进程在写一半时被杀，
       留下半截 JSON，这张单子的历史就整段丢了。 */
    const tmp = fileOf(key) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    fs.renameSync(tmp, fileOf(key));
    bumpStats();
    return true;
  } catch {
    return false;
  }
}

function freshState(sig, now = Date.now()) {
  return {
    sig,
    key: keyOf(sig),
    sigVer: SIG_VER,
    state: 'open',
    claimedBy: '',
    claimedAt: '',
    settledAt: '',
    note: '',
    history: [{ at: new Date(now).toISOString(), from: '', to: 'open', by: '', note: '首次出现' }]
  };
}

/* ── 复现步骤 ──
   取「报错前 windowMs 内、同一账号的最后 maxSteps 次工具调用」。
   为什么是工具调用而不是更细的点击流：工具调用是唯一被结构化记下来的操作，
   而它恰好也最有信息量——大部分 bug 出在「读了什么、写了什么、算了什么」之后。 */
export function reproFor(sample, { windowMs = 10 * 60e3, maxSteps = 8 } = {}) {
  const s = sample || {};
  if (!/^[a-f0-9]{32}$/.test(String(s.scope || ''))) {
    return {
      ok: false,
      scope: '',
      why: '这条记录是匿名上报（登录页崩了、或前端还没拿到身份），关联不到操作序列。'
        + '要看上下文，只能靠消息本身和栈。',
      steps: []
    };
  }
  const t = Number(s.epochMs) || 0;
  if (!t) return { ok: false, scope: s.scope, why: '这条记录没有时间戳，无法回溯操作。', steps: [] };

  let rows = [];
  try {
    rows = readAudit({
      from: new Date(t - windowMs).toISOString(),
      to: new Date(t).toISOString(),
      scope: s.scope,
      limit: 400,
      kind: 'tool_call'
    });
  } catch { rows = []; }

  rows.sort((a, b) => (a.epochMs || 0) - (b.epochMs || 0));
  const steps = rows.slice(-maxSteps).map(r => ({
    at: r.at || '',
    tool: String(r.tool || r.action || '?'),
    target: clip(r.target || '', 90),
    ok: !!r.ok,
    blocked: !!r.blocked,
    ms: Number(r.ms) || 0
  }));

  if (!steps.length) {
    return {
      ok: false,
      scope: s.scope,
      why: '审计里没有这个账号在报错前 10 分钟内的操作记录——可能已经过了保留期，'
        + '也可能这一步根本没走到工具调用。',
      steps: []
    };
  }
  return { ok: true, scope: s.scope, why: '', steps };
}

/* ── 组装一张工单 ──
   得分 = 次数 × 严重度 × 近期系数。
   这是**经验值**，不是定理：用来排序，不用来下结论。
   近期系数的理由：一个今天还在犯的错，比一个上周犯过 100 次、之后没再出的错更该先看。

   withRepro 默认 **false**：算复现要扫该账号的审计目录，而列表里有几十张单，
   每张扫一遍就是几十次全目录读。列表不需要它——点开某一单时才要。
   这个默认值是刻意的，因为「先做完再优化」在这里会变成一个真问题：
   health 每隔几秒被调一次，带上它就等于每几秒扫几十遍磁盘。 */
export function buildTicket(g, now = Date.now(), { withRepro = false, withProof = false, proofSet = null } = {}) {
  const st = loadState(g.sig) || freshState(g.sig, now);
  const sev = SEVERITY[g.code] || 2;
  const hits = g.n + (g.drop || 0);
  const ageH = g.lastMs ? (now - g.lastMs) / 3600e3 : 999;
  const hot = ageH <= 24 ? 1.5 : ageH <= 24 * 7 ? 1.2 : 1;
  const score = Math.round(hits * sev * hot * 10) / 10;

  /* 修好之后又犯了：比没修过更值得看。
     说明当时的修复只压住了症状——「看起来好了」是最容易骗过复核的形态。 */
  const settledMs = st.settledAt ? Date.parse(st.settledAt) : 0;
  const reopened = st.state === 'verified' && settledMs > 0 && g.lastMs > settledMs;

  const sample = g.sample || {};
  return {
    sig: g.sig,
    key: keyOf(g.sig),
    code: g.code,
    zh: (CODES[g.code] || CODES.E_UNKNOWN).zh,
    owner: g.owner,
    state: st.state,
    score,
    severity: sev,
    reopened,
    n: g.n,
    drop: g.drop || 0,
    first: g.first,
    last: g.last,
    ageHours: Math.round(ageH),
    scopeCount: (g.scopes || []).length,
    routes: g.routes || [],
    wheres: g.wheres || [],
    versions: g.versions || [],
    claimedBy: st.claimedBy || '',
    claimedAt: st.claimedAt || '',
    settledAt: st.settledAt || '',
    note: st.note || '',
    history: st.history || [],
    evidence: {
      msg: sample.msg || '',
      stack: Array.isArray(sample.stack) ? sample.stack : [],
      route: sample.route || '',
      where: sample.where || '',
      v: sample.v || '',
      commit: sample.commit || '',
      ua: sample.ua || '',
      at: sample.at || '',
      layer: sample.layer || '',
      extra: sample.extra || null
    },
    repro: withRepro
      ? reproFor(sample)
      : { skipped: true, ok: false, why: '列表里不算复现步骤（要点开某一单才有）', scope: '', steps: [] },
    /* 有没有自证材料。列表只认「文件在不在」（一次 readdir），
       内容要详情才读——一张单一次文件读，200 张就是 200 次。 */
    hasProof: proofSet ? proofSet.has(keyOf(g.sig)) : false,
    proof: withProof ? loadProof(g.sig) : null
  };
}

/* 列表。state 过滤、排序都在这里做——
   调用方拿到的就该是「按该修的先后排好的一列」，而不是要自己再排一遍。 */
export function listTickets({ from, to, limit = 200, state, includeDropped = false, withRepro = false } = {}) {
  const g = groupIncidents({ from, to, limit: Math.max(2000, limit * 20) });
  const now = Date.now();
  const proofSet = proofKeys();       /* 一次 readdir，不是每张单一次读 */
  let rows = g.groups.map(gr => buildTicket(gr, now, { withRepro, proofSet }));
  if (state) rows = rows.filter(t => t.state === state);
  else if (!includeDropped) rows = rows.filter(t => t.state !== 'dropped');
  rows.sort((a, b) => b.score - a.score || Date.parse(b.last) - Date.parse(a.last));
  return {
    totalIncidents: g.total,
    count: rows.length,
    tickets: rows.slice(0, Math.max(1, Math.min(limit, 500)))
  };
}

/* ── 状态文件盘点与清除 ──
   存在的理由来自一次真实的泄漏：本地 dev 实例把演示用的工单状态写进了生产
   的 data/tickets，随后被一起打包上线。线上从此多出「从没发生过的工单」，
   而没有任何地方会报错——工单表是靠状态文件与报错归组**合并**出来的，
   状态文件在、报错记录不在，那张单就只是「不显示」，但统计里 stateFiles 会多出来。

   所以要有办法回答两个问题：盘子里有哪些状态文件？哪些是孤儿（找不到对应报错）？ */
export function stateFiles() {
  let names = [];
  try { names = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const full = path.join(DIR, n);
    try {
      const o = JSON.parse(fs.readFileSync(full, 'utf8'));
      const st = fs.statSync(full);
      out.push({
        key: n.replace(/\.json$/, ''),
        sig: String(o.sig || ''),
        state: String(o.state || ''),
        sigVer: o.sigVer || 0,
        updatedAt: o.updatedAt || o.claimedAt || o.settledAt || '',
        ms: st.mtimeMs,
        bytes: st.size
      });
    } catch { /* 坏文件也报出来：半截 JSON 本身就是问题 */ 
      out.push({ key: n.replace(/\.json$/, ''), sig: '', state: 'corrupt', ms: 0, bytes: 0 });
    }
  }
  return out;
}

export function dropState(key) {
  const k = String(key || '').replace(/\.json$/, '').replace(/[^a-f0-9]/gi, '');
  if (!k) return { ok: false, error: '要 key' };
  try {
    fs.unlinkSync(fileOf(k));
    bumpStats();
    return { ok: true, key: k };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? '没有这个状态文件' : e.message };
  }
}

/* 单张：这里才算复现（一次目录扫描，可接受）。 */
export function getTicket(sig, now = Date.now()) {
  const key = String(sig || '');
  const all = listTickets({ limit: 500, includeDropped: true });
  const hit = all.tickets.find(t => t.sig === key || t.key === key);
  if (!hit) return null;
  /* 用同一批归组里的最新样本重算一次复现，避免两套口径 */
  const g = groupIncidents({ limit: 2000 }).groups.find(x => x.sig === hit.sig);
  return buildTicket(g || { ...hit, sample: hit.evidence, firstMs: 0, lastMs: Date.parse(hit.last) || 0 }, now, { withRepro: true, withProof: true });
}

/* ── 领取 ──
   by 是一个名字，不是一个身份——这一层不做鉴权，鉴权在 server 的闸门上。
   记录 by 的意义是「谁在看这张单子」，出问题时能问对人。 */
export function claim(sig, by = '', now = Date.now()) {
  const st = loadState(sig) || freshState(sig, now);
  if (!NEXT[st.state] || !NEXT[st.state].includes('claimed')) {
    return { ok: false, error: `当前状态是 ${st.state}，不能领取`, state: st.state };
  }
  const from = st.state;
  st.state = 'claimed';
  st.claimedBy = clip(by, 60) || '未署名';
  st.claimedAt = new Date(now).toISOString();
  st.history.push({ at: st.claimedAt, from, to: 'claimed', by: st.claimedBy, note: '' });
  if (!saveState(st)) return { ok: false, error: '状态写不进去（磁盘？）' };
  bumpStats();
  return { ok: true, state: st.state };
}

/* ── 结算 ──
   除了迁移状态，还要求「fixed / verified 必须有 note」。
   理由：没有说明的「修好了」不可复核——一个月后没人知道当时改了什么、
   为什么这么改。逼着写一句话，比事后翻 diff 便宜得多。 */
export function settle(sig, { state, by = '', note = '' } = {}, now = Date.now()) {
  if (!STATES.includes(state)) return { ok: false, error: `不认识的状态：${state}` };
  const st = loadState(sig) || freshState(sig, now);
  const allowed = NEXT[st.state] || [];
  if (!allowed.includes(state)) {
    return { ok: false, error: `不能从 ${st.state} 直接改成 ${state}（允许：${allowed.join(' / ') || '无'}）`, state: st.state };
  }
  if ((state === 'fixed' || state === 'verified' || state === 'dropped') && !String(note).trim()) {
    return { ok: false, error: `${state} 必须附一句说明：改了什么、为什么、或者为什么判定不修` };
  }

  /* ── 自证闸门 ──
     「修好了」必须有红→绿，而且必须是**我们跑出来的**那份，不是它自己贴的。
     没有这一关的话，这条链路的终点就退回成「它说好了」，那和没有链路一样。 */
  if (state === 'fixed' || state === 'verified') {
    const p = loadProof(sig);
    if (!p) {
      return {
        ok: false,
        error: '还没有自证材料。先跑一次证明（npm run prove -- --ticket ' + keyOf(sig) + ' --test test/xxx-test.mjs），'
          + '它会检出修复前那一版、把同一份测试铺过去跑，必须红；再在修复提交上跑，必须绿。'
      };
    }
    if (!p.ok) {
      return { ok: false, error: `自证没通过：${p.why || '红→绿 不成立'}`, proof: p };
    }
    /* 强制「强红」只用在复核通过这一档：
       fixed 可以是弱红（比如这个能力原来根本不存在，测试在旧代码上直接 import 失败），
       但「复核通过」意味着我们认定这个 bug 存在且已被消灭，那要求旧代码上是断言失败。 */
    if (state === 'verified' && !p.strong) {
      return {
        ok: false,
        error: `复核通过要求「强红」：这份证据在旧代码上的失败是「${p.red && p.red.kind}」，不是断言失败。`
          + '那只说明这个能力原来没有（甚至可能只是测试自己没跑起来），不证明这个 bug 当时存在。'
          + '要标 verified，请补一个在旧代码上会断言失败的测试。',
        proof: p
      };
    }
  }

  const from = st.state;
  st.state = state;
  st.settledAt = new Date(now).toISOString();
  if (note) st.note = clip(note, 600);
  st.history.push({ at: st.settledAt, from, to: state, by: clip(by, 60), note: clip(note, 600) });
  if (!saveState(st)) return { ok: false, error: '状态写不进去（磁盘？）' };

  /* 打回 = 「这次修复不成立」。证据必须一起作废：
     不作废的话，下一次结算会复用到上一份过期的绿——那正是「看起来好了」的
     第二种形态：证据是真的，但它证明的不是这一版。 */
  if (state === 'claimed' || state === 'open') dropProof(sig);

  bumpStats();
  return { ok: true, state: st.state };
}

/* ── 变成任务 ──
   这是这一层的产出物：一段能直接交给 ren agent 的文字。
   它把「事实（错误、次数、复现）」和「边界（红线、验收标准）」放在一起，
   因为这三样缺一样，它就会走错方向：
     没有复现 → 它猜；
     没有红线 → 它改到不该改的地方；
     没有验收标准 → 它说改好了，而「好了」没有定义。 */
export function toTaskPrompt(t) {
  if (!t) return '';
  const L = [];
  L.push(`【工单 ${t.key}】${t.zh}（${t.code}）`);
  L.push('');
  L.push('## 事实');
  L.push(`- 发生 ${t.n} 次${t.drop ? `（另有 ${t.drop} 次被限流压缩，未落盘）` : ''}`);
  L.push(`- 首次 ${t.first || '?'}　末次 ${t.last || '?'}`);
  L.push(`- 影响 ${t.scopeCount} 个账号　版本 ${(t.versions || []).join(', ') || '未知'}`);
  L.push(`- 路由 ${(t.routes || []).join(', ') || '?'}　出错位置 ${(t.wheres || []).join(', ') || '?'}`);
  if (t.reopened) L.push('- **这张单子修好过，又犯了。当时的修复只压住了症状。**');
  L.push('');
  L.push('## 报错原文');
  L.push('```');
  L.push(clip(t.evidence.msg || '(空)', 600));
  if (t.evidence.stack && t.evidence.stack.length) {
    L.push('---');
    for (const l of t.evidence.stack.slice(0, 6)) L.push(clip(l, 240));
  }
  L.push('```');
  L.push('');
  L.push('## 复现步骤');
  if (t.repro && t.repro.skipped) {
    /* 列表里没算复现（那是刻意的：几十张单各扫一遍审计太贵）。
       走到这里说明调用方拿的是列表对象，不是详情对象——直接说清楚，
       不要让它以为「这个 bug 没有复现路径」。 */
    L.push('（这一段来自列表，没算复现步骤。取完整版用 /api/ticket?sig=…&task=1）');
  } else if (t.repro && t.repro.ok) {
    L.push('报错前同一账号的操作：');
    t.repro.steps.forEach((s, i) => {
      const flag = s.blocked ? '⛔' : s.ok ? '·' : '⚠';
      L.push(`${i + 1}. ${s.at} ${flag} ${s.tool}  ${s.target}${s.ms ? `（${s.ms}ms）` : ''}`);
    });
    L.push('↓');
    L.push(`${t.evidence.at} 报错：${t.zh}`);
  } else {
    L.push('**没有可用的复现上下文。** ' + ((t.repro && t.repro.why) || '原因不明'));
    L.push('这种情况下不要假设操作序列——先把范围缩小到「这个路由 + 这个函数」，');
    L.push('并说明你打算用什么方式验证根因。');
  }
  L.push('');
  L.push('## 边界（不许动）');
  for (const r of RED_FILES) L.push(`- ${r}`);
  L.push('');
  L.push('## 验收');
  L.push('1. 指出根因，一句话，指到 文件:行；说不出来就退回重查，不要先改。');
  L.push('2. 新增一个回归测试，命名成 test/<说清是什么>-test.mjs，并提交。');
  L.push('3. 跑自证：`npm run prove -- --ticket ' + t.key + ' --test test/你的测试.mjs`');
  L.push('   它会检出这个修复提交的**父提交**，把你的测试原样铺过去跑一遍，必须失败；');
  L.push('   再在修复提交上跑，必须通过且 0 失败。这就是「红→绿」，而且必须是**我们跑出来的**。');
  L.push('   不能是「模块不存在」——后者只证明这东西原来没有，不证明当时是坏的。');
  L.push('4. 全量测试通过，给出文件数与断言数。');
  L.push('5. 改动文件数 > 3 时，先说明为什么不能更小。');
  L.push('');
  L.push('**你不会直接被告知「通过了」。** 证明是这边自己复跑出来的，');
  L.push('你贴的终端输出不作为证据——它证明不了你没有换一份测试去跑。');
  return L.join('\n');
}

/* ── 现状 ──
   给 health 用：有多少张单、几张没人管、几张卡在「等复核」。
   「卡在等复核」这个数很重要——它是这条链路真正的瓶颈。

   两条性能上的克制：
   1. 不走 listTickets（那会给每张单建一个对象并排序），只做计数。
   2. 结果缓存 60 秒。health 会被监控轮询，而「现在有几张单」不需要秒级实时；
      不缓存的话，每几秒扫一遍 incident 目录。
      状态一变（claim/settle）就把缓存打掉，所以点完按钮立刻能看到新数字。 */
let statsCache = { at: 0, val: null };
const STATS_TTL = 60e3;

export function ticketStats(now = Date.now()) {
  if (statsCache.val && now - statsCache.at < STATS_TTL) return statsCache.val;
  const g = groupIncidents({ limit: 2000 });
  const by = {};
  for (const s of STATES) by[s] = 0;
  let stateFiles = 0;
  try { stateFiles = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).length; } catch { /* 忽略 */ }
  let reopened = 0;
  for (const gr of g.groups) {
    const st = loadState(gr.sig);
    const state = st ? st.state : 'open';
    by[state] = (by[state] || 0) + 1;
    const settledMs = st && st.settledAt ? Date.parse(st.settledAt) : 0;
    if (st && st.state === 'verified' && settledMs > 0 && gr.lastMs > settledMs) reopened += 1;
  }
  const out = { dir: DIR, tickets: g.groups.length, byState: by, reopened, stateFiles };
  /* 有证据的几张。「卡在 fixed 但没有证据」是不该出现的状态，
     真出现了说明有人绕过接口直接写状态文件——这个数就是为了让它显形。 */
  const pk = proofKeys();
  out.withProof = pk.size;
  statsCache = { at: now, val: out };
  return out;
}

/* 状态一变就把统计缓存打掉。少这一句，点完「领取」要等一分钟列表才变，
   而人看到自己点完没反应，第一反应是再点一次。 */
function bumpStats() { statsCache = { at: 0, val: null }; }

export const __test = { keyOf, loadState, saveState, freshState, fileOf, DIR, SIG_VER, NEXT, SEVERITY };
