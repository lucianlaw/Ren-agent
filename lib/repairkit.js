/* ── 修复工作区的工具封装：让 ren agent 自己走完一轮 ──
 *
 * 到这一层为止，链路已经全了：看得见（报错归组）→ dev 闸门 → 工单 → 工作区
 * → 自证 → 分诊。但**能走通**和**它自己走通**是两件事。
 *
 * 差在哪：这条链路有十几个动作，命令行入口（scripts/heal.mjs）是给手用的。
 * 让模型现拼 curl 或现拼 JSON，出错的地方永远是引号、转义、字段名，
 * 而错误回执看起来像「功能坏了」——它会开始换参数乱试，烧掉一整轮。
 *
 * 所以这里只做一件事：把复现一轮所需的最少动作，变成几个参数名固定的工具。
 *
 * ── 为什么是 5 个，不是照搬 12 个命令 ──
 * 工具定义每一轮都要进 prompt。12 个工具 × 每个 200 字描述，就是每轮多付两千字，
 * 而在 95% 的任务里它们一个都用不上。所以按「一轮的四步」切：
 *   看（queue）→ 开工（begin）→ 看代码（look）→ 改（change）→ 收（finish）
 * 每步内部用 action 枚举，参数名沿用 edit_file / write_file 的叫法
 * （old_string / new_string / content）——模型对这几个名字已经练熟了，
 * 换一套命名只会增加填错字段的概率。
 *
 * ── 三条边界，一条都不放宽 ──
 *   1. **判定全在服务端**（lib/repair.js + lib/proof.js + lib/ticket.js）。
 *      这一层只做「参数翻译 + 回执翻成人话」，和 heal.mjs 的定位完全一样。
 *      它要是能判定，判定就等于没有。
 *   2. **它不能宣布自己通过**。prove 只给红/绿的证据，submit 只到 fixed。
 *      这里没有、也不会有「标成 verified」的入口——允许它自证自己通过，
 *      等于把「谁来判断」也交出去。
 *   3. **红线照旧**：敏感文件整份禁、围栏函数按代码块禁。这条不在这里实现，
 *      也不在这里复述成规则去「劝」模型——改不动就是改不动，
 *      围栏拒了会把原因原样带出来。工具描述里提一句是为了少走一趟，
 *      不是把它当闸门。
 *
 * ── 谁能拿到这 5 个工具 ──
 * 不是所有账号：/api/tooldefs 只在「dev 实例 + 维护者」时把它们并进清单。
 * 生产实例上它们根本不存在，普通账号也看不到。判定在 server.js，
 * 因为那里才有身份——这一层不该知道「谁是维护者」。
 */

import * as REPAIR from './repair.js';
import * as TRIAGE from './triage.js';
import { getTicket, toTaskPrompt } from './ticket.js';

/* 工具定义。描述里每条都写「什么时候用」而不是「它能做什么」——
   后者模型看完还是不知道下一步该不该调它。 */
export const KIT_DEFS = [
  {
    type: 'function',
    function: {
      name: 'repair_queue',
      description: '看这一轮该修哪张单：会派谁、跳过谁（为什么跳过）、今天还剩几次额度。只读，不动仓库。'
        + '开始修之前先看这个，不要凭印象挑。',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['triage', 'list', 'decisions'],
            description: 'triage（默认）= 这一轮会派谁；list = 所有工单和修复记录；decisions = 这周起了几轮、都被什么挡掉'
          },
          days: { type: 'number', description: 'mode=decisions 时回看几天，默认 7' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repair_begin',
      description: '领一张工单开工：给它建一个独立的 git worktree（正在跑的那份源码一个字节不动），'
        + '返回 key 和任务书。之后所有 look/change 都要带这个 key。同时只能开一张。'
        + '不带 sig 就让服务端按分诊选（等价于「这一轮该修哪张就开哪张」）。',
      parameters: {
        type: 'object',
        properties: {
          sig: { type: 'string', description: '工单签名（repair_queue 里给的那个）。不给就由分诊选' },
          dry: { type: 'boolean', description: '只看会开哪张、任务书是什么，不真开。默认 false' },
          by: { type: 'string', description: '以谁的名义领这张单，默认 "ren"' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repair_look',
      description: '在修复工作区里看代码（只读）：tree 列目录、read 读文件（带行号）、grep 全文搜。'
        + '定位优先用 grep，比整篇读省得多。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'repair_begin 给的 key' },
          action: { type: 'string', enum: ['tree', 'read', 'grep'], description: 'tree / read / grep' },
          path: { type: 'string', description: 'action=read 时要读的文件（仓库内相对路径，如 lib/x.js）' },
          dir: { type: 'string', description: 'action=tree 时的目录前缀，如 lib' },
          q: { type: 'string', description: 'action=grep 时的搜索词（正则）' },
          glob: { type: 'string', description: 'action=grep 时只搜路径里含这个串的文件，如 lib/' },
          from: { type: 'number', description: 'action=read 时从第几行开始，默认 1' },
          lines: { type: 'number', description: 'action=read 时读多少行，默认 200，最多 400' }
        },
        required: ['key', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repair_change',
      description: '改修复工作区里的代码：edit 精确替换一处（只改这一处，别整篇重写）、'
        + 'write 整份覆盖（新建文件或确实要重写时用）、diff 看自己改了什么（交单前必须看一眼）、'
        + 'revert 撤销全部改动回到开工那一版。'
        + '红线文件（身份/权限/计费/删除/证据/工单/这个链路自己）与围栏函数改不动，会被拒并把原因带出来。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'repair_begin 给的 key' },
          action: { type: 'string', enum: ['edit', 'write', 'diff', 'revert'], description: 'edit / write / diff / revert' },
          path: { type: 'string', description: 'action=edit/write 时的文件路径（仓库内相对路径）' },
          old_string: { type: 'string', description: 'action=edit：要被替换的原文，必须逐字一致（含缩进）' },
          new_string: { type: 'string', description: 'action=edit：替换成什么；空串表示删掉这一段' },
          all: { type: 'boolean', description: 'action=edit：确实要替换全部同名片段时置 true' },
          content: { type: 'string', description: 'action=write：完整文件内容' },
          full: { type: 'boolean', description: 'action=diff：要完整 patch（默认截到 20KB）' }
        },
        required: ['key', 'action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repair_finish',
      description: '收尾：prove 跑指定测试，证明「改之前红、改之后绿」（红了就是红了，重跑没用，回去改）；'
        + 'submit 交单（只能到 fixed，复核由人做）；abort 扔掉这一轮（默认留分支）。'
        + '交单前必须先 prove 成功，否则会被拒。',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'repair_begin 给的 key' },
          action: { type: 'string', enum: ['prove', 'submit', 'abort'], description: 'prove / submit / abort' },
          test: { type: 'string', description: 'action=prove：测哪个文件，如 test/foo-test.mjs' },
          note: { type: 'string', description: 'action=submit：改了什么、为什么。没有说明的「修好了」不可复核，会被拒' },
          force: { type: 'boolean', description: 'action=abort：连分支一起删（默认只摘工作区、留分支）' }
        },
        required: ['key', 'action']
      }
    }
  }
];

/* 权限分类一律 'none'。
   语义是「这一步不由用户工作区的四类开关决定」。前端见到 'none' 会直接放行到服务端，
   而服务端按「dev 实例 + 维护者」单独判——修复工作区改的是仓库源码，
   不属于任何账号的 workspace，用 read/write 那套去判只会判出错的结论。 */
export const KIT_CATEGORY = Object.fromEntries(KIT_DEFS.map(d => [d.function.name, 'none']));

const NAMES = new Set(KIT_DEFS.map(d => d.function.name));
export const isKit = (name) => NAMES.has(String(name || ''));
export const kitNames = () => [...NAMES];

const clip = (s, n) => {
  const t = s == null ? '' : String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};
const need = (v, field, hint) => (String(v == null ? '' : v).trim()
  ? null
  : { ok: false, error: `要给 ${field}${hint ? '：' + hint : ''}` });

/* ── 回执翻译 ──
   模型只读 output 文本。所以每一句都要回答「下一步做什么」，
   而不是把 JSON 原样丢回去——它看不懂的字段会被它自己编一个含义。 */

function renderPick(p) {
  const L = [];
  if (p.resume) {
    L.push(`已经有一张在修：${p.resume.key}（分支 ${p.resume.branch}）`);
    L.push('先把这张走完再开新的——同时开两张会互相踩 worktree。');
    L.push(`继续用 repair_look / repair_change，key=${p.resume.key}`);
  } else if (p.pick) {
    const t = p.pick;
    L.push(`这一轮该修：${t.code || '?'}  ${(t.wheres || []).slice(0, 3).join(', ') || ''}`.trim());
    L.push(`  得分 ${t.score}　状态 ${t.state}　归属 ${t.owner}　报错 ${t.n || '?'} 次`);
    if (t.reopened) L.push('  **修好过又犯了**：上次的修复只压住了症状，别照着上次的思路改。');
    L.push(`  sig ${t.sig}`);
    L.push('');
    L.push('开修：repair_begin（不带 sig 就是这一张）');
  } else {
    L.push(`这一轮没得修：${p.why || '没有可派的单子'}`);
  }

  if (p.skipped && p.skipped.length) {
    L.push('');
    L.push(`跳过 ${p.skipped.length} 张：`);
    for (const s of p.skipped.slice(0, 12)) L.push(`  · ${s.key}  ${s.code || ''}  ${s.why}`);
    if (p.skipped.length > 12) L.push(`  ……还有 ${p.skipped.length - 12} 张，原因同上几类`);
  }
  if (p.budget) L.push('', `今日额度：${p.budget.used}/${p.budget.limit}（还能开 ${p.budget.left} 张）`);
  return L.join('\n');
}

function renderBegin(b, dry) {
  const L = [];
  if (b.reuse) L.push(`这张单子已经开着：key ${b.key}（分支 ${b.branch}）——接着改，不用重开。`);
  else if (dry) L.push(`（只是看看，仓库没动）会开：${b.key ? 'key ' + b.key : '这一轮没有可开的单子'}`);
  else L.push('开好了。');
  if (b.key) L.push(`  key    ${b.key}`);
  /* 分支和 base 只有真开过才有。dry 时打 'undefined' 会让它以为工作区已经建好了，
     下一步直接去 look —— 而那时 key 对应的目录根本不存在。 */
  if (b.branch) L.push(`  分支   ${b.branch}`);
  if (b.base) L.push(`  base   ${String(b.base).slice(0, 7)}`);
  if (!dry && b.attempt) L.push(`  第 ${b.attempt} 次尝试`);
  if (b.task) L.push('', '任务书：', b.task);
  if (b.red) {
    L.push('', '改不动的文件（围栏直接拒，别浪费时间试）：');
    L.push('  ' + b.red.blocked.join('、'));
  }
  L.push('', dry
    ? '要真开：repair_begin（去掉 dry）；开了之后用 repair_look 先 grep 定位'
    : '下一步：repair_look（先 grep 定位，再读那一段）');
  return L.join('\n');
}

function renderFinish(name, a, out) {
  const L = [];
  if (name === 'prove') {
    const p = out.proof || {};
    if (out.ok) {
      L.push('绿了。红→绿 成立：');
      L.push(`  测试 ${p.test || a.test}`);
      L.push(`  改之前 ${p.red || '?'}　改之后 ${p.green || '?'}`);
      L.push(`  提交 ${String(out.sha || p.fix || '').slice(0, 7)}`);
      L.push('', '下一步：repair_finish action=submit（带一句 note，说明改了什么、为什么）');
    } else {
      L.push(`没绿：${out.error || p.why || '红→绿 不成立'}`);
      if (p.evidence) L.push('', clip(p.evidence, 2000));
      L.push('', '别重跑同一个 prove——同一份代码重跑还是红的。回去用 repair_look 看为什么，改完再 prove。');
    }
  } else if (name === 'submit') {
    L.push(`交单了：现在是 fixed（**不是** verified）。`);
    L.push(`  key    ${out.key}`);
    L.push(`  分支   ${out.branch}`);
    L.push(`  修复提交 ${String(out.fix || '').slice(0, 7)}`);
    if (out.stat) L.push('', out.stat);
    L.push('', out.next || '复核由人做。');
  } else {
    L.push(out.force ? '这一轮扔了，分支也删了。' : '这一轮扔了，工作区摘了、分支还留着（要连分支一起删就带 force）。');
  }
  return L.join('\n');
}

/* ── 分派 ──
   只做参数翻译。所有判断（能不能开、红线、红绿、能不能交单）都在被调的那一层。 */
export async function runKit(name, args = {}) {
  const t0 = Date.now();
  const a = (args && typeof args === 'object') ? args : {};
  const done = (r) => {
    const o = { name, ms: Date.now() - t0, ...r };
    /* 失败也要有一段 output：模型只读 output，只给 error 字段它看不见，
       表现出来就是「工具调了但什么都没回来」，然后它开始重复调同一个。 */
    if (o.ok === false && !o.output) o.output = `这一步没成：${o.error || '未知原因'}`;
    return o;
  };

  try {
    if (name === 'repair_queue') {
      const mode = String(a.mode || 'triage');
      if (mode === 'list') {
        const rows = REPAIR.list();
        const tickets = TRIAGE.pick({ dryRun: true });
        const L = [`修复记录 ${rows.length} 条（最近的在前）：`];
        for (const r of rows.slice(0, 20)) {
          L.push(`  · ${r.key}  ${r.status}  ${r.branch}  ${String(r.created || '').slice(0, 19)}  ${r.test || '未跑测试'}`);
        }
        if (!rows.length) L.push('  （没有）');
        L.push('', tickets.ok ? renderPick(tickets) : `分诊不可用：${tickets.error}`);
        return done({ ok: true, output: L.join('\n') });
      }
      if (mode === 'decisions') {
        const days = Math.max(1, Math.min(Number(a.days) || 7, 30));
        const st = TRIAGE.triageStats({ days });
        const rows = TRIAGE.decisions({ days, limit: 50 });
        const L = [`最近 ${days} 天：起了 ${st.rounds} 轮，选中 ${st.picked} 张，真开成 ${st.began} 张`];
        if (st.top.length) {
          L.push('被挡掉的原因：');
          for (const x of st.top) L.push(`  · ${x.reason}  ${x.n} 次`);
        }
        if (rows.length) {
          L.push('', '最近的决策：');
          for (const r of rows.slice(0, 12)) {
            L.push(`  ${String(r.at || '').slice(0, 19)}  ${r.picked || r.resume || '没选'}  ${r.why || ''}`);
          }
        }
        return done({ ok: true, output: L.join('\n'), stats: st });
      }

      const p = TRIAGE.pick({ dryRun: true });
      if (!p.ok) return done({ ok: false, error: p.error || '分诊不可用', code: p.code });
      return done({ ok: true, output: renderPick(p), pick: p.pick ? p.pick.key : '', resume: p.resume ? p.resume.key : '' });
    }

    if (name === 'repair_begin') {
      const dry = !!a.dry;
      const by = String(a.by || 'ren').slice(0, 60);
      const sig = String(a.sig || '').trim();
      if (sig) {
        /* dry 只能看任务书，不能顺手把 worktree 建出来——
           「看看会开哪张」本身会改动仓库的话，这条 dry 就白叫了。 */
        if (dry) {
          const t = getTicket(sig);
          if (!t) return done({ ok: false, error: '没有这张单子（签名不对，或已过保留期）' });
          return done({ ok: true, output: renderBegin({ key: t.key, task: toTaskPrompt(t) }, true), dry: true });
        }
        const b = await REPAIR.begin({ sig, by });
        if (!b.ok) return done({ ok: false, error: b.error, changed: b.changed });
        return done({ ok: true, output: renderBegin(b), key: b.key, branch: b.branch, task: b.task });
      }
      /* 不给 sig：让分诊选。dry 只选不开，仍记一条决策（「看过、决定不开」和「没看」要能分开）。 */
      const n = await TRIAGE.next({ dryRun: dry, by });
      if (!n.ok) return done({ ok: false, error: n.error || n.why, began: n.began });
      /* 没有 pick 有两种完全不同的情况：有一张正在修（resume），or 一张都派不出来。
         两种都别落到「开好了」——那会让人以为仓库里多了一个工作区，其实什么也没开。 */
      if (!n.pick) return done({ ok: true, output: renderPick(n), key: '', dry });
      if (dry) return done({ ok: true, output: renderBegin({ ...n.pick, task: n.task }, true), key: '', dry: true });
      return done({ ok: true, output: renderBegin(n.began || {}, false), key: (n.began && n.began.key) || '', task: n.task });
    }

    if (name === 'repair_look') {
      const key = String(a.key || '').trim();
      const miss = need(key, 'key', 'repair_begin 给的那个');
      if (miss) return done(miss);
      const action = String(a.action || '');
      if (action === 'tree') {
        const r = REPAIR.tree({ key, dir: a.dir });
        if (!r.ok) return done({ ok: false, error: r.error });
        return done({ ok: true, output: r.output + (r.more ? `\n（还有更多，共 ${r.count} 个文件）` : '') });
      }
      if (action === 'read') {
        const r = REPAIR.read({ key, path: a.path, from: a.from, lines: a.lines });
        if (!r.ok) return done({ ok: false, error: r.error });
        const tail = r.truncated ? `\n（共 ${r.total} 行，只读到 ${r.from}-${r.to}，接着读用 from=${r.to + 1}）` : `\n（共 ${r.total} 行）`;
        return done({ ok: true, output: r.output + tail });
      }
      if (action === 'grep') {
        const mq = need(a.q, 'q', '搜索词，正则');
        if (mq) return done(mq);
        const r = REPAIR.grep({ key, q: a.q, glob: a.glob });
        if (!r.ok) return done({ ok: false, error: r.error });
        return done({ ok: true, output: r.output + (r.more ? `\n（命中已到上限，缩窄关键词或加 glob）` : '') });
      }
      return done({ ok: false, error: 'action 只能是 tree / read / grep' });
    }

    if (name === 'repair_change') {
      const key = String(a.key || '').trim();
      const miss = need(key, 'key', 'repair_begin 给的那个');
      if (miss) return done(miss);
      const action = String(a.action || '');
      if (action === 'edit') {
        const mp = need(a.path, 'path', '要改的文件，如 lib/x.js');
        if (mp) return done(mp);
        if (typeof a.old_string !== 'string') {
          return done({ ok: false, error: '要给 old_string（要被替换的原文，逐字一致含缩进）；要删掉一段就把 new_string 传空串' });
        }
        const r = REPAIR.editFile({ key, path: a.path, old: a.old_string, new: a.new_string == null ? '' : a.new_string, all: !!a.all });
        if (!r.ok) return done({ ok: false, error: r.error, redFlags: r.redFlags });
        return done({ ok: true, output: `改了 ${a.path}：替换 ${r.replaced || 1} 处。下一步用 repair_change action=diff 看一眼。`, replaced: r.replaced });
      }
      if (action === 'write') {
        const mp = need(a.path, 'path', '要写的文件');
        if (mp) return done(mp);
        if (typeof a.content !== 'string') return done({ ok: false, error: '要给 content（完整文件内容）' });
        const r = REPAIR.writeFile({ key, path: a.path, content: a.content });
        if (!r.ok) return done({ ok: false, error: r.error, redFlags: r.redFlags });
        return done({ ok: true, output: `整份写好：${a.path}（${Buffer.byteLength(a.content)} 字节）。下一步 repair_change action=diff 看一眼。` });
      }
      if (action === 'diff') {
        const r = await REPAIR.diff({ key, full: !!a.full });
        if (!r.ok) return done({ ok: false, error: r.error });
        const L = [];
        L.push(r.files.length ? `改了 ${r.files.length} 个文件：${r.files.join(', ')}` : '还没有任何改动。');
        if (r.stat) L.push('', r.stat);
        if (r.redFlags && r.redFlags.length) {
          L.push('', '⚠ 碰到红线（交单会被拒，先撤掉）：');
          for (const f of r.redFlags) L.push(`  · ${f.file}（${f.why}${f.line ? '：' + f.line : ''}）`);
        }
        if (r.patch) L.push('', r.patch);
        if (r.truncated) L.push(`\n（patch 被截断，共 ${r.patchBytes} 字节；要全看用 full=true）`);
        return done({ ok: true, output: L.join('\n'), files: r.files, redFlags: r.redFlags });
      }
      if (action === 'revert') {
        const r = await REPAIR.revert({ key });
        if (!r.ok) return done({ ok: false, error: r.error });
        return done({ ok: true, output: '改动全撤了，回到开工那一版。重新看一遍再改。' });
      }
      return done({ ok: false, error: 'action 只能是 edit / write / diff / revert' });
    }

    if (name === 'repair_finish') {
      const key = String(a.key || '').trim();
      const miss = need(key, 'key', 'repair_begin 给的那个');
      if (miss) return done(miss);
      const action = String(a.action || '');
      if (action === 'prove') {
        const mt = need(a.test, 'test', '测哪个文件，如 test/foo-test.mjs');
        if (mt) return done(mt);
        const out = await REPAIR.prove({ key, test: String(a.test).trim() });
        const r = done({ ok: !!out.ok, output: renderFinish('prove', a, out), proof: out.proof, error: out.ok ? '' : (out.error || (out.proof && out.proof.why) || '红→绿 不成立'), redFlags: out.redFlags });
        /* 红了要让前端知道「这一步没生效」，它会把原因回灌给模型接着改 */
        r.verify = r.ok
          ? { pass: true, why: '红→绿 成立' }
          : { pass: false, why: r.error || '红→绿 不成立' };
        return r;
      }
      if (action === 'submit') {
        const mn = need(a.note, 'note', '改了什么、为什么');
        if (mn) return done(mn);
        const out = await REPAIR.submit({ key, note: String(a.note).trim(), test: String(a.test || '').trim() });
        if (!out.ok) return done({ ok: false, error: out.error || '交单被拒', proof: out.proof, redFlags: out.redFlags });
        return done({ ok: true, output: renderFinish('submit', a, out), state: out.state, fix: out.fix, verify: { pass: true, why: '交单成功（fixed）' } });
      }
      if (action === 'abort') {
        const out = await REPAIR.abort({ key, force: !!a.force });
        if (!out.ok) return done({ ok: false, error: out.error });
        return done({ ok: true, output: renderFinish('abort', a, out) });
      }
      return done({ ok: false, error: 'action 只能是 prove / submit / abort' });
    }

    return done({ ok: false, error: `不认识的修复工具 ${clip(name, 40)}` });
  } catch (e) {
    /* 抛异常不能变成 500：那会看起来像「服务坏了」，而实际是这一步的参数或状态不对。
       把原始信息带出去，让它自己判断要不要换参数。 */
    return done({ ok: false, error: `这一步执行失败：${clip(e && e.message, 300)}` });
  }
}

export const __test = { NAMES, renderPick, renderBegin, renderFinish };
