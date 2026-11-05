// 记忆层：让员工「记得住」，但只记确认过的事
//
// 两份文件，都在这个 scope 自己的目录下（跟工作区同源，换设备随工作区一起走）：
//   memory/<scope>/company.md            公司档案：老板手写 + 各员工沉淀的共同事实（客户口径、禁区、偏好）
//   memory/<scope>/staff/<id>.md         员工个人记忆：这位员工在往次任务里确认过的事
//   memory/<scope>/<kind>.meta.json      条目元数据：类型 / 重要度 / 用到次数 / 状态 / 取代关系 / 来源任务
//
// 为什么正文用 md、元数据另存 json：
//   · 正文给人看、给人改——老板打开文件就能自己划掉一条，不需要任何工具；
//   · 元数据要能随程序演进加字段（重要度、命中次数、取代链），写在正文行里会把文件搞成一行天书；
//   · 正文里只保留「人必须一眼看见」的状态标记（〔已被取代〕/〔已停用〕），
//     这样即便元数据文件丢了，也不会把一条作废的记忆当成有效记忆用。
//
// 一条记忆的生命周期：
//   active（有效）→ superseded（被新事实取代，保留历史，召回不再用）
//                 → disabled（老板手动停用）
//   新事实与旧事实冲突时**不删旧行**：旧行标成「已被取代」并指向新条目，
//   这样"什么时候改的口径"永远查得到——删掉就再也说不清了。
//
// 写入只发生在两种时机：
//   · 员工在正文末尾主动写【记忆】块（任务成功收工时程序截取，含敏感信息直接丢弃）
//   · 老板在公司档案里手写
// 失败的任务、被打回重做的中间稿，一律不写——脏记忆会长期污染判断。
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_BASE, SCOPE_RE } from './workspace.js';

const BASE = path.join(WORKSPACE_BASE, 'memory');
const MAX_ENTRIES = 120;         // 单份记忆上限，超了先丢最旧的作废条目，再丢最旧的
const MAX_ENTRY_LEN = 160;       // 单条上限，长条目说明它该写成文件而不是记忆
const MAX_ADD_PER_ROUND = 4;     // 一次任务最多沉淀几条，防止刷屏

export const MEMORY_KINDS = ['company', 'staff', 'project'];
export const MEMORY_TYPES = ['fact', 'pref', 'decision', 'policy', 'risk'];

export const TYPE_LABEL = {
  fact: '事实', pref: '偏好', decision: '决策', policy: '口径', risk: '禁区'
};
export const STATUS_LABEL = {
  active: '有效', candidate: '待采纳', superseded: '已被取代', disabled: '已停用'
};

/* 不同类型的默认重要度：禁区/口径天生比一条普通事实更该被想起 */
const TYPE_IMP = { fact: 2, pref: 3, decision: 4, policy: 4, risk: 5 };

/* ── 路径 ── */

function safeId(id) {
  const s = String(id || '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(s) ? s : '';
}

export function memFile(scope, kind, id) {
  if (!SCOPE_RE.test(String(scope || ''))) return null;
  const root = path.join(BASE, scope);
  if (kind === 'company') return path.join(root, 'company.md');
  if (kind === 'staff') {
    const sid = safeId(id);
    return sid ? path.join(root, 'staff', sid + '.md') : null;
  }
  /* 项目共享记忆：项目里任何一个员工召回都带，项目外的人看不到 */
  if (kind === 'project') {
    const pid = safeId(id);
    return pid ? path.join(root, 'project', pid + '.md') : null;
  }
  return null;
}

/** 测试用：这个 scope 的记忆根目录（评估脚本跑完自己清掉） */
export function memoryPathsForTest(scope) {
  if (!SCOPE_RE.test(String(scope || ''))) return null;
  return path.join(BASE, scope);
}

function metaFile(scope, kind, id) {
  const f = memFile(scope, kind, id);
  if (!f) return null;
  return f.replace(/\.md$/, '.meta.json');
}

/* 稳定短 id：同一条事实反复出现在同一天，删除/停用时前端要能指回那一行 */
function hashOf(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 8);
}

const ENTRY_RE = /^\s*[-*·]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+?)\s*$/;
/* 正文里的状态标记（人可读、丢了元数据也认得出） */
const MARK_RE = /^〔(已被取代|已停用|待采纳)〕\s*/;
const MARKS = { superseded: '〔已被取代〕', disabled: '〔已停用〕', candidate: '〔待采纳〕' };

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ── 敏感信息：宁可少记一条，也不把密钥写进记忆 ──
   老板会把报价单、合同、后台配置整段粘进公司档案，模型也会顺手把"接口 Key 是 xxx"
   当成事实记下来。这些一旦落盘，就等于把凭证抄进了要长期保留的文本里。 */
const SENS_RULES = [
  { kind: '私钥', src: 'PRIVATE KEY-----' },
  { kind: '私钥', src: '-----BEGIN[^-]{0,40}PRIVATE KEY-----' },
  { kind: '密钥', src: '\\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{16,}' },
  { kind: '密钥', src: '\\bAKIA[0-9A-Z]{16}\\b' },
  { kind: '密钥', src: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\\b' },
  { kind: '令牌', src: '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b' },
  { kind: '密钥', src: '\\bAIza[0-9A-Za-z_-]{30,}\\b' },
  { kind: '令牌', src: '\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b' },
  { kind: '密码', src: '(?:密码|口令|passwd|password|pwd)\\s*(?:是|为|=|:|：)\\s*[^\\s，。；,;]{4,}', flags: 'i' },
  { kind: '证件号', src: '(?<![0-9])[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{3}[\\dXx](?![0-9])' }
];

function luhnOk(s) {
  let sum = 0, alt = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

/** 命中就返回类别名（密钥/密码/证件号/银行卡/私钥/令牌），干净返回空串 */
export function findSensitive(text) {
  const s = String(text || '');
  for (const r of SENS_RULES) {
    if (new RegExp(r.src, r.flags || '').test(s)) return r.kind;
  }
  /* 银行卡：16–19 位连号 + Luhn 校验，避免把订单号/物料号误判成卡号 */
  const cards = s.match(/(?<!\d)\d{16,19}(?!\d)/g) || [];
  for (const c of cards) if (luhnOk(c)) return '银行卡';
  /* 长随机串：32 位以上、大小写字母+数字混排，基本只有密钥长这样 */
  const rnd = s.match(/[A-Za-z0-9_-]{32,}/g) || [];
  for (const r of rnd) {
    if (/[a-z]/.test(r) && /[A-Z]/.test(r) && /\d/.test(r)) return '密钥';
  }
  return '';
}

/** 把敏感片段替换成 ***（存量数据兜底：老记忆里可能已经写了） */
export function maskSensitive(text) {
  let s = String(text || '');
  for (const r of SENS_RULES) {
    s = s.replace(new RegExp(r.src, (r.flags || '') + 'g'), '***');
  }
  s = s.replace(/(?<!\d)\d{16,19}(?!\d)/g, m => (luhnOk(m) ? '***' : m));
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, m => (
    /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? '***' : m
  ));
  return s;
}

/* ── 文本相似度：判"同一件事"和"改口" ── */

/* 同一件事常有两种叫法（回款周期 / 账期）。不归一的话，改口会被当成两条并存。
   只收「确定是同一个意思」的几组，宁缺勿滥：多收一组，就会多错一批取代。 */
const SYNONYMS = [
  [/回款周期|付款周期|结款周期|结算周期|账期/g, '账期'],
  [/交期|交货期|交付周期/g, '交期'],
  [/单价|报价|价格/g, '价格'],
  [/含税价|含税报价/g, '含税价']
];

function norm(s) {
  let t = String(s || '').toLowerCase();
  for (const [re, to] of SYNONYMS) t = t.replace(re, to);
  return t.replace(/[\s，。、；：""''（）()【】\[\]·.,;:!?！？-]/g, '');
}

function grams(s) {
  const t = norm(s);
  const set = new Set();
  for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

/** 字符二元组 Jaccard：中文不需要分词，短句上比编辑距离稳 */
function sim(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 最长公共子串占比：短句改一两个词时（周报周一发 → 周报周五发）比 Jaccard 更能认出"同一件事" */
function lcsRatio(a, b) {
  const s = norm(a), t = norm(b);
  if (!s.length || !t.length) return 0;
  let prev = new Array(t.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= s.length; i++) {
    const cur = new Array(t.length + 1).fill(0);
    for (let j = 1; j <= t.length; j++) {
      if (s[i - 1] === t[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best / Math.min(s.length, t.length);
}

const NEG_RE = /不|别|禁止|严禁|无需|不必|取消|停止|避免|勿|莫|不得/;
/* 改口动词：「X 改成 45 天」和「X 是 60 天」说的是同一件事的两个版本 */
const CHG_RE = /改为|改成|调到|调成|调整为|调整到|更新为|变更为|变成|降到|降为|提高到|升至|改为按/;

function numsOf(s) {
  return (String(s || '').match(/\d+(?:\.\d+)?/g) || []).filter(x => x !== '');
}

/**
 * 两条记忆是否互相矛盾（新说法推翻旧说法）。
 * 只在"说的是同一件事"时才可能冲突——相似度不够的一律算两条独立事实。
 */
function contradicts(oldText, newText) {
  const s = sim(oldText, newText);
  if (s < 0.34) return false;
  const po = NEG_RE.test(oldText), pn = NEG_RE.test(newText);
  if (po !== pn && s >= 0.42) return true;
  const no = numsOf(oldText), nn = numsOf(newText);
  if (no.length && nn.length) {
    const a = no.slice().sort().join(','), b = nn.slice().sort().join(',');
    if (a !== b) {
      /* 数字换了，且新说法里带改口动词（改成 / 调整为）→ 基本可以确定是同一件事改了 */
      if (CHG_RE.test(newText)) return true;
      if (s >= 0.52) return true;
    }
  }
  return false;
}

/** 类型：模型没标就按措辞推断，老板可在面板里改 */
export function inferType(text) {
  const s = String(text || '');
  if (/禁止|严禁|不许|不得|红线|禁区|合规|风险/.test(s)) return 'risk';
  if (/一律|统一|必须|口径|标准|模板|格式|含税|不含税|按.{0,6}执行/.test(s)) return 'policy';
  if (/决定|确定|定了|敲定|拍板|采用|选用|定为|改用/.test(s)) return 'decision';
  if (/喜欢|偏好|习惯|倾向|希望|更愿意|风格|语气|简洁|详细/.test(s)) return 'pref';
  return 'fact';
}

/* ── 元数据 ── */

function readMeta(scope, kind, id) {
  const f = metaFile(scope, kind, id);
  if (!f) return { v: 2, items: {} };
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j && typeof j === 'object' && j.items && typeof j.items === 'object'
      ? { v: 2, items: j.items }
      : { v: 2, items: {} };
  } catch { return { v: 2, items: {} }; }
}

function writeMeta(scope, kind, id, meta) {
  const f = metaFile(scope, kind, id);
  if (!f) return;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(meta), 'utf8');
  } catch { /* 元数据丢了不影响正文，下一轮会按默认值重建 */ }
}

function itemOf(meta, entryId) {
  if (!meta.items[entryId]) meta.items[entryId] = {};
  return meta.items[entryId];
}

function clampImp(v, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/** 把正文条目 + 元数据合成前端要的一条 */
function decorate(e, m) {
  const type = MEMORY_TYPES.includes(m.type) ? m.type : inferType(e.text);
  const status = (e.status && STATUS_LABEL[e.status]) ? e.status
    : ((m.status && STATUS_LABEL[m.status]) ? m.status : 'active');
  return {
    id: e.id,
    date: e.date,
    text: e.text,
    src: e.src || '',
    srcId: m.srcId || '',
    status,
    statusLabel: STATUS_LABEL[status],
    type,
    typeLabel: TYPE_LABEL[type],
    imp: clampImp(m.imp, TYPE_IMP[type] || 3),
    hits: Number(m.hits) || 0,
    seen: Number(m.seen) || 1,
    at: m.at || e.date,
    sup: m.sup || '',
    supAt: m.supAt || '',
    lastHit: m.lastHit || ''
  };
}

/* ── 正文读写 ── */

/** 把文本切成「非条目正文」与「条目」，条目按出现顺序返回 */
export function parseDoc(text) {
  const entries = [];
  const prose = [];
  for (const line of String(text || '').split('\n')) {
    const m = ENTRY_RE.exec(line);
    if (m) {
      let body = m[2];
      let status = 'active';
      const mk = MARK_RE.exec(body);
      if (mk) {
        status = mk[1] === '已停用' ? 'disabled'
          : mk[1] === '待采纳' ? 'candidate' : 'superseded';
        body = body.slice(mk[0].length);
      }
      const [fact, srcPart] = body.split('｜来源：');
      const factText = String(fact || '').trim();
      if (!factText) continue;
      entries.push({
        id: hashOf(factText),
        date: m[1],
        text: factText,
        src: String(srcPart || '').trim(),
        status
      });
    } else {
      prose.push(line);
    }
  }
  return { entries, prose: prose.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

function render(entries, prose) {
  const head = String(prose || '').trim();
  const lines = entries.map(e => {
    const mark = MARKS[e.status] || '';
    return `- [${e.date}] ${mark}${e.text}${e.src ? `｜来源：${e.src}` : ''}`;
  });
  return (head ? head + '\n\n' : '') + (lines.length ? lines.join('\n') + '\n' : '');
}

export function readDoc(scope, kind, id) {
  const file = memFile(scope, kind, id);
  if (!file) return { ok: false, error: '记忆定位不合法' };
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = ''; }
  const { entries, prose } = parseDoc(raw);
  const meta = readMeta(scope, kind, id);
  const list = entries.map(e => decorate(e, meta.items[e.id] || {}));
  return {
    ok: true, kind, id: kind === 'staff' ? safeId(id) : '',
    file: path.basename(file), entries: list, prose, raw,
    counts: {
      active: list.filter(x => x.status === 'active').length,
      candidate: list.filter(x => x.status === 'candidate').length,
      superseded: list.filter(x => x.status === 'superseded').length,
      disabled: list.filter(x => x.status === 'disabled').length,
      total: list.length
    }
  };
}

/** 超上限时先丢作废的旧条目，有效条目尽量留全 */
function trimEntries(list) {
  if (list.length <= MAX_ENTRIES) return list;
  const keep = list.slice();
  const dead = keep
    .map((e, i) => ({ e, i }))
    .filter(x => x.e.status && x.e.status !== 'active')
    .sort((a, b) => (a.e.date < b.e.date ? -1 : 1));
  while (keep.length > MAX_ENTRIES && dead.length) {
    const pos = keep.indexOf(dead.shift().e);
    if (pos >= 0) keep.splice(pos, 1);
  }
  while (keep.length > MAX_ENTRIES) keep.shift();
  return keep;
}

export function writeDoc(scope, kind, id, entries, prose, meta) {
  const file = memFile(scope, kind, id);
  if (!file) return { ok: false, error: '记忆定位不合法' };
  const list = trimEntries(entries || []);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(list, prose), 'utf8');
  const m = meta || readMeta(scope, kind, id);
  const keep = new Set(list.map(e => e.id));
  for (const k of Object.keys(m.items)) if (!keep.has(k)) delete m.items[k];
  writeMeta(scope, kind, id, m);
  return { ok: true };
}

function uniqId(entries, text) {
  const base = hashOf(text);
  let id = base, n = 2;
  while (entries.some(e => e.id === id)) id = base + '-' + (n++);
  return id;
}

/* ── 写入 ── */

/** 更正前缀：模型明确说"这条推翻旧的"时，无需再靠相似度猜 */
const CORR_RE = /^(?:更正|纠正|推翻|修正|改为|改成)[:：]\s*/;

/**
 * 追加记忆。三件事同时做掉：
 *   ① 重复（同一件事说第二遍）→ 不新增，只刷新日期并记一次确认；
 *   ② 冲突（新说法推翻旧说法）→ 旧条目转 superseded 并指向新条目，历史保留；
 *   ③ 敏感（密钥/密码/证件/银行卡）→ 直接丢弃并回报，不落盘。
 */
export function appendEntries(scope, kind, id, items, src, opts = {}) {
  const file = memFile(scope, kind, id);
  if (!file) return { ok: false, error: '记忆定位不合法' };

  const raw = (Array.isArray(items) ? items : [items])
    .map(x => String(x || ''))
    .map(x => x.replace(/^[-*·]\s+/, '').replace(/\s+/g, ' ').trim())
    .filter(x => x.length >= 4);

  const rejected = [];
  const clean = [];
  for (const t of raw) {
    const kindHit = findSensitive(t);
    if (kindHit) {
      rejected.push({ kind: kindHit, sample: maskSensitive(t).slice(0, 40) });
      continue;
    }
    clean.push(t.slice(0, MAX_ENTRY_LEN));
  }
  if (!clean.length) {
    return { ok: true, added: 0, merged: 0, superseded: 0, rejected, total: 0 };
  }

  const doc = readDoc(scope, kind, id);
  const entries = doc.entries.slice();
  const meta = readMeta(scope, kind, id);
  const day = today();
  const srcLabel = String(src || '').slice(0, 60);
  const srcId = String(opts.srcId || '').slice(0, 60);
  let added = 0, merged = 0, superseded = 0;

  const reinforce = (e) => {
    e.date = day;
    if (srcLabel) e.src = srcLabel;
    const m = itemOf(meta, e.id);
    m.seen = (Number(m.seen) || 1) + 1;
    if (srcId) m.srcId = srcId;
    if (srcLabel) m.srcLabel = srcLabel;
    merged++;
  };

  for (const rawText of clean.slice(0, MAX_ADD_PER_ROUND)) {
    const explicit = CORR_RE.test(rawText);
    const text = rawText.replace(CORR_RE, '');
    const key = norm(text);
    const keyLen = key.length;

    /* ① 一模一样 */
    const same = entries.find(e => norm(e.text) === key);
    if (same) { reinforce(same); continue; }

    /* 在一批条目里找最像的那条（只跟还有效/待采纳的条目比：作废的再撞也不该互相影响） */
    let best = null, bestSim = 0, bestAff = 0;
    for (const e of entries) {
      if (e.status === 'superseded' || e.status === 'disabled') continue;
      /* 包含关系也算强相似：避免「纸板 3.4 元」与「五层纸板约 3.4 元/㎡」并存 */
      const s = sim(text, e.text);
      const contained = keyLen >= 8 && (norm(e.text).includes(key) || key.includes(norm(e.text)));
      const sc = contained ? Math.max(s, 0.66) : s;
      const aff = Math.max(sc, lcsRatio(text, e.text));
      if (aff > bestAff) { bestAff = aff; bestSim = sc; best = e; }
    }

    if (best && !opts.candidate && (explicit || contradicts(best.text, text))) {
      /* 显式更正认"最像的那条"就够，但门槛别设太高：
         自然改口的相似度往往只有 0.25 上下（「周报周五发」→「周报改为周一发」），
         卡到 0.3 就落成两条并存，旧的错口径会一直被召回。
         自动判定仍要相似度真的够高（contradicts 里另有阈值），别乱取代。 */
      const okSim = explicit ? bestAff >= 0.22 : true;
      if (okSim) {
        const newId = uniqId(entries, text);
        best.status = 'superseded';
        const bm = itemOf(meta, best.id);
        bm.status = 'superseded';
        bm.sup = newId;
        bm.supAt = day;
        entries.push({ id: newId, date: day, text, src: srcLabel, status: 'active' });
        itemOf(meta, newId).status = 'active';
        superseded++;
        added++;
        continue;
      }
    }

    if (best && bestSim >= 0.72) { reinforce(best); continue; }

    const newId = uniqId(entries, text);
    const st = opts.candidate ? 'candidate' : 'active';
    entries.push({ id: newId, date: day, text, src: srcLabel, status: st });
    itemOf(meta, newId).status = st;
    added++;
  }

  /* 这一轮新增/强化的条目补元数据：类型、来源任务、首次时间 */
  for (const e of entries) {
    const m = itemOf(meta, e.id);
    if (m.at) continue;
    if (e.status === 'superseded' && !m.at) { /* 历史条目：按日期回填 */ }
    m.at = e.date;
    if (!MEMORY_TYPES.includes(m.type)) m.type = inferType(e.text);
    if (m.imp == null) m.imp = TYPE_IMP[m.type] || 3;
    if (m.seen == null) m.seen = 1;
    if (e.src && !m.srcLabel) m.srcLabel = e.src;
    if (srcId && e.date === day && !m.srcId) m.srcId = srcId;
  }

  writeDoc(scope, kind, id, entries, doc.prose, meta);
  return {
    ok: true, added, merged, superseded, rejected,
    total: entries.length
  };
}

export function deleteEntry(scope, kind, id, entryId) {
  const doc = readDoc(scope, kind, id);
  if (!doc.ok) return doc;
  const left = doc.entries.filter(e => e.id !== String(entryId || ''));
  if (left.length === doc.entries.length) return { ok: false, error: '没找到这条记忆' };
  writeDoc(scope, kind, id, left, doc.prose);
  return { ok: true, left: left.length };
}

export function clearDoc(scope, kind, id) {
  const doc = readDoc(scope, kind, id);
  if (!doc.ok) return doc;
  writeDoc(scope, kind, id, [], doc.prose);
  return { ok: true };
}

/** 公司档案整篇替换（老板手写）：正文即 prose，`- [日期]` 行仍是条目 */
export function replaceCompany(scope, text) {
  const file = memFile(scope, 'company');
  if (!file) return { ok: false, error: '工作区标识不合法' };
  /* 整篇粘贴最容易带进凭证：这里改写而不是整篇拒绝，别让老板白粘一次 */
  const cut = maskSensitive(String(text || '')).slice(0, 20000);
  const { entries, prose } = parseDoc(cut);
  const meta = readMeta(scope, 'company');
  for (const e of entries) {
    const m = itemOf(meta, e.id);
    m.at = m.at || e.date;
    if (!MEMORY_TYPES.includes(m.type)) m.type = inferType(e.text);
    if (m.imp == null) m.imp = TYPE_IMP[m.type] || 3;
    if (m.seen == null) m.seen = 1;
    if (e.src && !m.srcLabel) m.srcLabel = e.src;
  }
  writeDoc(scope, 'company', '', entries, prose, meta);
  return { ok: true, entries: entries.length };
}

/**
 * 改一条记忆：停用/恢复、纠正文字、改类型、改重要度。
 * 纠正文字时 id 会跟着变（id 是内容哈希），旧 id 的元数据一并迁过去。
 */
export function updateEntry(scope, kind, id, entryId, patch = {}) {
  const doc = readDoc(scope, kind, id);
  if (!doc.ok) return doc;
  const e = doc.entries.find(x => x.id === String(entryId || ''));
  if (!e) return { ok: false, error: '没找到这条记忆' };
  const meta = readMeta(scope, kind, id);
  const oldId = e.id;
  const m = itemOf(meta, oldId);
  let newId = oldId;
  let changed = [];

  if (patch.status && (patch.status === 'active' || patch.status === 'disabled')) {
    e.status = patch.status;
    m.status = patch.status;
    changed.push(patch.status === 'active' ? '已恢复' : '已停用');
  }

  if (typeof patch.text === 'string') {
    const t = patch.text.replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_LEN);
    if (t.length < 4) return { ok: false, error: '这条太短了，至少 4 个字' };
    const hit = findSensitive(t);
    if (hit) return { ok: false, error: `这条看着像${hit}，不能写进记忆` };
    if (norm(t) !== norm(e.text)) {
      /* 纠正成和另一条一模一样 → 不是新增，是合并：留旧那条，别制造两条重复 */
      const dup = doc.entries.find(x => x.id !== oldId && norm(x.text) === norm(t));
      if (dup) {
        const left = doc.entries.filter(x => x.id !== oldId);
        delete meta.items[oldId];
        writeDoc(scope, kind, id, left, doc.prose, meta);
        return { ok: true, id: dup.id, text: dup.text, merged: true, changed: ['与已有条目重复，已合并'] };
      }
      newId = uniqId(doc.entries.filter(x => x.id !== oldId), t);
      e.text = t;
      e.id = newId;
      delete meta.items[oldId];
      meta.items[newId] = m;
      /* 指着旧 id 的取代关系跟着改 */
      for (const k of Object.keys(meta.items)) {
        if (meta.items[k].sup === oldId) meta.items[k].sup = newId;
      }
      changed.push('文字已更正');
    }
  }

  if (patch.type && MEMORY_TYPES.includes(patch.type)) {
    m.type = patch.type;
    if (patch.imp == null) m.imp = TYPE_IMP[patch.type] || 3;
    changed.push('类型已改');
  }
  if (patch.imp != null) {
    m.imp = clampImp(patch.imp, m.imp || 3);
    changed.push('重要度已改');
  }

  writeDoc(scope, kind, id, doc.entries, doc.prose, meta);
  return { ok: true, id: newId, text: e.text, changed };
}

/**
 * 一键采纳一条候选记忆。
 * 采纳时才做冲突处理：跟现有有效条目说的是同一件事就合并，说的是相反的话就把旧的取代掉。
 * 候选期不参与召回，所以老板没点的候选不会影响任何判断。
 */
export function approveEntry(scope, kind, id, entryId) {
  const doc = readDoc(scope, kind, id);
  if (!doc.ok) return doc;
  const e = doc.entries.find(x => x.id === String(entryId || ''));
  if (!e) return { ok: false, error: '没找到这条记忆' };
  if (e.status === 'active') return { ok: true, id: e.id, text: e.text, already: true };
  if (e.status !== 'candidate') return { ok: false, error: '这条不是待采纳状态' };

  const meta = readMeta(scope, kind, id);
  const others = doc.entries.filter(x => x.id !== e.id);
  /* ① 已经有一条一模一样 → 采纳变成合并，别留两条重复 */
  const dup = others.find(x => x.status === 'active' && norm(x.text) === norm(e.text));
  if (dup) {
    const left = doc.entries.filter(x => x.id !== e.id);
    delete meta.items[e.id];
    writeDoc(scope, kind, id, left, doc.prose, meta);
    return { ok: true, id: dup.id, text: dup.text, merged: true };
  }
  /* ② 跟现行说法相反 → 旧的标成已被取代，保留历史 */
  const superseded = [];
  for (const o of others) {
    if (o.status !== 'active') continue;
    if (!contradicts(o.text, e.text)) continue;
    o.status = 'superseded';
    const om = itemOf(meta, o.id);
    om.status = 'superseded';
    om.sup = e.id;
    om.supAt = today();
    superseded.push(o.text);
  }
  e.status = 'active';
  itemOf(meta, e.id).status = 'active';
  writeDoc(scope, kind, id, doc.entries, doc.prose, meta);
  return { ok: true, id: e.id, text: e.text, superseded };
}

/** 项目记忆第一次建立时写下项目名（正文第一行），面板靠它显示项目而不是一串 id */
export function writeProjectTitle(scope, id, title) {
  const doc = readDoc(scope, 'project', id);
  if (!doc.ok) return doc;
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!t) return { ok: true };
  writeDoc(scope, 'project', id, doc.entries, `# 项目：${t}`);
  return { ok: true };
}

/** 列出有共享记忆的项目 */
export function listProjects(scope) {
  if (!SCOPE_RE.test(String(scope || ''))) return { ok: false, error: '工作区标识不合法' };
  const dir = path.join(BASE, scope, 'project');
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { names = []; }
  const list = names.map(f => {
    const id = f.replace(/\.md$/, '');
    const doc = readDoc(scope, 'project', id);
    const active = doc.entries.filter(e => e.status === 'active');
    const cand = doc.entries.filter(e => e.status === 'candidate');
    /* 项目名抄在正文第一行（# 项目：xxx），面板上直接显示名字而不是一串 id */
    const nm = (/^#\s*项目[:：]\s*(.+)$/m.exec(doc.prose || '') || [])[1] || '';
    return {
      id, title: String(nm).trim(),
      n: active.length, nCand: cand.length, nAll: doc.entries.length,
      last: active.length ? active[active.length - 1].date : ''
    };
  }).filter(x => x.nAll > 0).sort((a, b) => (a.last < b.last ? 1 : -1));
  return { ok: true, list };
}
export function listStaff(scope) {
  if (!SCOPE_RE.test(String(scope || ''))) return { ok: false, error: '工作区标识不合法' };
  const dir = path.join(BASE, scope, 'staff');
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { names = []; }
  const list = names.map(f => {
    const id = f.replace(/\.md$/, '');
    const doc = readDoc(scope, 'staff', id);
    const active = doc.entries.filter(e => e.status === 'active');
    return {
      id,
      n: active.length,
      nAll: doc.entries.length,
      last: active.length ? active[active.length - 1].date : ''
    };
  }).filter(x => x.nAll > 0).sort((a, b) => (a.last < b.last ? 1 : -1));
  return { ok: true, list };
}

/* ── 召回：这次任务该带哪几条记忆进上下文 ── */

const PUNCT = /[\s，。、；：""''（）()【】\[\]·.,;:!?！？\-—]+/;

function tokens(q) {
  const raw = String(q || '').split(PUNCT).filter(w => w.length >= 2);
  const flat = String(q || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const bi = [];
  for (let i = 0; i + 2 <= flat.length && bi.length < 12; i++) bi.push(flat.slice(i, i + 2));
  return [...new Set(raw.concat(bi))].slice(0, 16);
}

/**
 * 排序分 = 命中次数×2 + 重要度偏移 + 用过次数 + 时间新鲜度。
 * 加重要度是因为「禁止口头报价」这类禁区，命中词少但永远比一条陈年事实更该被想起。
 */
function score(entry, keys) {
  const hay = (entry.text + ' ' + (entry.src || '')).toLowerCase();
  let s = keys.filter(k => hay.includes(k.toLowerCase())).length * 2;
  const imp = Number(entry.imp) || 3;
  s += (imp - 3) * 0.45;
  s += Math.min(Number(entry.hits) || 0, 6) * 0.22;
  const days = (Date.now() - Date.parse(entry.date + 'T00:00:00')) / 86400000;
  if (days <= 90) s += 1.2; else if (days <= 180) s += 0.4;
  return s;
}

function pick(entries, keys, n, budget) {
  const ranked = entries
    .map(e => ({ e, s: score(e, keys) }))
    .sort((a, b) => b.s - a.s || (a.e.date < b.e.date ? 1 : -1));
  const out = [];
  let used = 0;
  for (const { e } of ranked) {
    if (out.length >= n) break;
    if (used + e.text.length > budget) continue;
    out.push(e);
    used += e.text.length;
  }
  /* 输出按日期正序，读起来像一本流水账而不是打乱的碎片 */
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 召回即"用到"：命中次数进排序，常用口径下次更容易被想起 */
function bumpHits(scope, kind, id, ids) {
  if (!ids || !ids.length) return;
  const meta = readMeta(scope, kind, id);
  const day = today();
  for (const k of ids) {
    const m = itemOf(meta, k);
    m.hits = (Number(m.hits) || 0) + 1;
    m.lastHit = day;
  }
  writeMeta(scope, kind, id, meta);
}

export function recallFor(scope, staffId, query, opts = {}) {
  const keys = tokens(query);
  const comp = readDoc(scope, 'company');
  const staff = staffId ? readDoc(scope, 'staff', staffId) : { entries: [] };
  const proj = opts.projectId ? readDoc(scope, 'project', opts.projectId) : { entries: [] };
  const compAct = (comp.entries || []).filter(e => e.status === 'active');
  const stAct = (staff.entries || []).filter(e => e.status === 'active');
  const pjAct = (proj.entries || []).filter(e => e.status === 'active');
  const compPick = pick(compAct, keys, opts.companyN || 24, opts.companyBudget || 1500);
  const stPick = pick(stAct, keys, opts.staffN || 12, opts.staffBudget || 900);
  /* 项目共享记忆不按人分：谁在这个项目里干活谁就带着同一份 */
  const pjPick = pick(pjAct, keys, opts.projectN || 16, opts.projectBudget || 1200);
  if (opts.track !== false) {
    try {
      bumpHits(scope, 'company', '', compPick.map(e => e.id));
      if (staffId) bumpHits(scope, 'staff', staffId, stPick.map(e => e.id));
      if (opts.projectId) bumpHits(scope, 'project', opts.projectId, pjPick.map(e => e.id));
    } catch { /* 计数失败不影响这次任务 */ }
  }
  return {
    ok: true,
    company: compPick,
    staff: stPick,
    project: pjPick,
    companyProse: (comp.prose || '').slice(0, 800),
    total: compAct.length + stAct.length + pjAct.length,
    skipped: (comp.entries || []).length + (staff.entries || []).length + (proj.entries || []).length
      - compAct.length - stAct.length - pjAct.length
  };
}

/** 拼成可以直接塞进 system 的段落；没有记忆就返回空串 */
export function memoryBrief(scope, staffId, staffName, query, opts = {}) {
  const r = recallFor(scope, staffId, query, opts);
  if (!r.ok) return '';
  const clean = s => maskSensitive(String(s || ''));
  const parts = [];
  if (r.companyProse) {
    parts.push('· 公司档案（老板写的，最高优先级）', clean(r.companyProse));
  }
  if (r.company.length) {
    parts.push('· 公司层面确认过的事实',
      ...r.company.map(e => `  - ${clean(e.text)}（${e.date}${e.src ? '，' + clean(e.src) : ''}）`));
  }
  if (r.project && r.project.length) {
    parts.push(`· 这个项目里已经定过的事（项目里所有同事共用${opts.projectName ? '，项目：' + clean(opts.projectName) : ''}）`,
      ...r.project.map(e => `  - ${clean(e.text)}（${e.date}${e.src ? '，' + clean(e.src) : ''}）`));
  }
  if (r.staff.length) {
    parts.push(`· ${staffName || '你'}在往次任务里确认过的事`,
      ...r.staff.map(e => `  - ${clean(e.text)}（${e.date}，${clean(e.src) || '旧任务'}）`));
  }
  if (!parts.length) return '';
  return [
    '',
    '【你记得的事】下面是这家公司和你自己过去确认过的事实，可以直接用，不用重新查：',
    ...parts,
    '用法：口径、偏好、禁区以这里为准；里面的价格、政策、数字如果距今天超过 90 天，用之前先核实一次。',
    '如果这次任务推翻了某条旧记忆，别照着错的做：在结尾【记忆】里写成「更正：新的说法」，程序会把旧的标成已被取代。',
    '项目里多个同事共用的结论，收工时写进【项目记忆】块（格式同【记忆】），只进项目不写进你个人记忆。'
  ].join('\n');
}

/* ── 收工时的记忆回写 ── */

/**
 * 从员工正文里摘出【记忆】【项目记忆】块。
 * 模型自己知道这一轮确认了什么，比事后让另一个模型去总结更准，也不多花一次调用。
 * 摘掉之后正文照常展示——老板不该在产出里看到内部记账。
 */
function cutBlock(src, label) {
  const re = new RegExp('(^|\\n)[ \\t]*【' + label + '】[ \\t]*');
  const m = re.exec(src);
  if (!m) return null;
  const head = src.slice(0, m.index);
  const lines = src.slice(m.index + m[0].length).replace(/^\n/, '').split('\n');
  const items = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const b = /^[ \t]*[-*·][ \t]*(.+)$/.exec(l);
    if (!b) break;
    const t = b[1].trim();
    if (t.length >= 4 && !/^(无|没有|无新增|暂无|略)$/.test(t)) items.push(t);
  }
  const rest = lines.slice(i).join('\n');
  return { items, body: (head + (rest.trim().length > 4 ? '\n' + rest : '')).trim() };
}

export function splitMemo(text) {
  let s = String(text || '');
  let projectItems = [];
  const pj = cutBlock(s, '项目记忆');
  if (pj) { s = pj.body; projectItems = pj.items; }
  const mx = cutBlock(s, '记忆');
  if (mx) s = mx.body;
  return {
    body: s.trim(),
    items: (mx ? mx.items : []).slice(0, MAX_ADD_PER_ROUND),
    projectItems: projectItems.slice(0, MAX_ADD_PER_ROUND)
  };
}
