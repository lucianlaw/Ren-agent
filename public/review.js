/* 评测台：把「跑一次看通过率」升级成「配对跑 → 出指标 → 判显著 → 记差异日志」
 *
 * 为什么重写：老版本只能回答「这次过没过」，回答不了三个真要命的问题——
 *   1. 换了模型/改了逻辑，到底变好还是变坏？（没有基线，没有配对，没有显著性）
 *   2. 产出是「能交」还是「写得好」？（只有确定性断言，没有质量分）
 *   3. 快了多少、省了多少、思考变多变少？（只有总耗时和总 token）
 *
 * 口径来源《深入理解 AI Agent》第 7 章：
 *   - 成功定义分三档：Pass@1 / Pass^k（可靠性）/ Pass@k（能力上限），不许混着报
 *   - 验证分两轨：确定性断言守住底线，Rubric + LLM 评判比出优劣
 *   - 结果要能变成决策：配对检验、置信区间、护栏指标，三条齐了才敢说「可以切」
 *   - 每次结果必须带版本指纹，否则「变好了」这句话无从归因
 *
 * 设计取舍：
 *   - 跑批用的是「当前员工 + 指定模型」，模型由变体决定，跑完写进运行记录，不靠人记
 *   - 一行 run 一行记录，云端 ba_eval_runs 为主、localStorage 兜底；游客态也能用
 *   - 每次跑完自动和上一次同模型、同题集的 run 比一次，生成一条差异日志（跨版本对比就靠它）
 */
(() => {
  const APP = () => window.APP;
  const EK = () => window.EVALKIT;
  const LS_CUSTOM = 'boss.eval.custom';
  const LS_RUNS = 'boss.eval.runs';
  const LS_LOGS = 'boss.eval.logs';
  const LS_VARS = 'boss.eval.variants';
  const MAX_RUNS = 40;
  const MAX_LOGS = 30;
  const JUDGE_MAX_CHARS = 9000;

  let seed = [];
  let seedVersion = 0;
  let rubricDefaults = null;
  let loaded = false;
  let stopFlag = false;
  let busy = false;
  let cur = null;
  let cloudDead = false;
  let history = [];          // 运行记录 + 差异日志，新的在前
  let lastCompare = null;    // 最近一次对比结果，供渲染与导出

  /* ── 题库 ── */

  function customCases() {
    try { return JSON.parse(localStorage.getItem(LS_CUSTOM) || '[]'); } catch { return []; }
  }
  function saveCustom(list) {
    localStorage.setItem(LS_CUSTOM, JSON.stringify(list.slice(0, 80)));
  }
  function allCases() {
    return seed.concat(customCases());
  }
  async function loadSeed() {
    if (loaded) return;
    try {
      const r = await fetch(window.withSC('./eval-cases.json'), { cache: 'no-store' });
      const j = await r.json();
      seed = Array.isArray(j.cases) ? j.cases : [];
      seedVersion = Number(j.version) || 1;
      rubricDefaults = j.rubricDefaults || null;
    } catch (e) {
      seed = [];
    }
    loaded = true;
  }

  /* ── 版本指纹 ──
     没有这个，「变好了」就只是一句感觉。脚本 query 上的 v= 就是当前构建号。 */
  function appVersion() {
    try {
      const tags = document.querySelectorAll('script[src*="app.js"]');
      for (const t of tags) {
        const m = /[?&]v=([\w.-]+)/.exec(t.getAttribute('src') || '');
        if (m) return m[1];
      }
    } catch (e) { /* 取不到就退回 dev */ }
    return 'dev';
  }

  /* ── 变体配置（A/B 两个模型，跑之前先定死） ── */

  function savedVariants() {
    try { return JSON.parse(localStorage.getItem(LS_VARS) || '{}') || {}; } catch { return {}; }
  }
  function saveVariants(v) {
    localStorage.setItem(LS_VARS, JSON.stringify(v || {}));
  }

  function modelList() {
    const s = APP().state || {};
    return (s.models || []).filter((m) => m && m.id && String(m.id).toLowerCase() !== 'auto');
  }

  function variantOf(which) {
    const s = APP().state || {};
    const staff = activeStaff();
    const saved = savedVariants();
    const models = modelList();
    const fallback = (staff && staff.model) || s.settings && s.settings.model || (models[0] && models[0].id) || '';
    let model = saved[which] || (which === 'b' ? fallback : '');
    if (which === 'b') model = saved.b || fallback;
    if (which === 'a') model = saved.a || fallback;
    if (!model) model = fallback;
    const judge = window.JUDGE ? window.JUDGE.pick(models, model) : { id: model, name: model, level: 'none' };
    const name = (models.find((m) => m.id === model) || {}).name || model;
    return {
      which,
      label: (which === 'a' ? 'A 基线 · ' : 'B 候选 · ') + name,
      model,
      modelName: name,
      judgeModel: judge.id,
      judgeName: judge.name || judge.id,
      judgeLevel: judge.level || 'none'
    };
  }

  /* ── 云端存档：ba_eval_runs ──
     run 与 log 共用一张表，kind 区分。owner_id 由服务端 auth.uid() 兜，前端不传。 */

  function dbClient() {
    try { return window.CLOUD.client().database; } catch (e) { return null; }
  }

  async function cloudInsert(row) {
    if (cloudDead) return false;
    const db = dbClient();
    if (!db) return false;
    try {
      const r = await db.from('ba_eval_runs').insert(row);
      if (r && r.error) throw r.error;
      return true;
    } catch (e) {
      cloudDead = true;
      return false;
    }
  }

  async function cloudFetch(limit) {
    const db = dbClient();
    if (!db) return [];
    try {
      const r = await db.from('ba_eval_runs')
        .select('id,kind,run_at,payload')
        .order('run_at', { ascending: false })
        .limit(limit || 80);
      if (r && r.error) throw r.error;
      return (r && r.data) || [];
    } catch (e) {
      return [];
    }
  }

  function localHistory() {
    try { return JSON.parse(localStorage.getItem(LS_RUNS) || '[]') || []; } catch { return []; }
  }
  function localLogs() {
    try { return JSON.parse(localStorage.getItem(LS_LOGS) || '[]') || []; } catch { return []; }
  }
  function saveLocalHistory(list) {
    /* 本地只留最近的一批，云端才是长期档案 */
    localStorage.setItem(LS_RUNS, JSON.stringify(list.slice(0, MAX_RUNS)));
  }
  function saveLocalLogs(list) {
    try { localStorage.setItem(LS_LOGS, JSON.stringify(list.slice(0, MAX_LOGS))); } catch (e) {
      /* 日志太大写不下时，先丢掉最老的再试一次 */
      try { localStorage.setItem(LS_LOGS, JSON.stringify(list.slice(0, 5))); } catch (e2) { /* 放弃本地 */ }
    }
  }

  async function loadHistory() {
    const map = new Map();
    for (const x of localHistory()) if (x && x.id) map.set(x.id, x);
    for (const x of localLogs()) if (x && x.id) map.set(x.id, x);
    const remote = await cloudFetch(100);
    for (const r of remote) {
      const p = r && r.payload;
      if (!p || !p.id || map.has(p.id)) continue;
      map.set(p.id, p);
    }
    history = [...map.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, MAX_RUNS + MAX_LOGS);
    saveLocalHistory(history.filter((x) => x.kind === 'run'));
    saveLocalLogs(history.filter((x) => x.kind === 'log'));
    return history;
  }

  async function persist(rec) {
    history.unshift(rec);
    history.sort((a, b) => (b.at || 0) - (a.at || 0));
    saveLocalHistory(history.filter((x) => x.kind === 'run'));
    if (rec.kind === 'log') saveLocalLogs(history.filter((x) => x.kind === 'log'));
    const user = window.CLOUD && window.CLOUD.user ? window.CLOUD.user() : null;
    const v = rec.variant || {};
    const fp = rec.fp || {};
    await cloudInsert({
      id: rec.id,
      owner_name: (user && user.name) || null,
      kind: rec.kind || 'run',
      group_id: rec.groupId || null,
      variant_label: v.label || null,
      variant_model: v.model || null,
      judge_model: v.judgeModel || null,
      app_version: fp.appVersion || null,
      case_version: fp.caseVersion || null,
      k: fp.k || null,
      payload: rec
    });
  }

  function runsOnly() { return history.filter((x) => x && x.kind === 'run'); }
  function logsOnly() { return history.filter((x) => x && x.kind === 'log'); }

  /* ── 从任务里把产出捞出来（沿用老逻辑，断言与 Rubric 都吃这个） ── */

  const FILE_TOOLS = /write_file|make_doc|make_sheet|make_deck/;

  function collectFiles(task) {
    const out = [];
    const seen = new Map();
    for (const s of (task.steps || [])) {
      if (s.kind !== 'tool' || s.ok === false) continue;
      const round = Number(s.round) || 1;
      const list = Array.isArray(s.files) ? s.files.slice() : [];
      if (FILE_TOOLS.test(s.name || '') && s.args && s.args.path) list.push(String(s.args.path));
      for (const p of list) {
        const path = String(p || '').trim();
        if (!path || seen.has(path)) continue;
        seen.set(path, true);
        out.push({ path, round, tool: s.name });
      }
    }
    const re = /(?:已写入|已生成|保存为|written|saved)[：:\s]*([\w./\-\u4e00-\u9fa5]+\.(?:md|txt|docx|xlsx|pptx|png|jpe?g|webp|csv|html?))/gi;
    for (const s of (task.steps || [])) {
      if (s.kind !== 'tool' || s.ok === false) continue;
      const text = String(s.output || '');
      let m;
      while ((m = re.exec(text))) {
        const path = m[1];
        if (seen.has(path)) continue;
        seen.set(path, true);
        out.push({ path, round: Number(s.round) || 1, tool: s.name });
      }
    }
    return out;
  }

  function roundsOf(task) {
    let max = 0;
    for (const u of (task.userMsgs || [])) max = Math.max(max, Number(u.round) || 1);
    for (const s of (task.steps || [])) max = Math.max(max, Number(s.round) || 1);
    return max || 1;
  }

  function pickFile(files, pattern) {
    const re = new RegExp(pattern, 'i');
    return files.filter((f) => re.test(f.path)).sort((a, b) => b.path.length - a.path.length)[0] || null;
  }

  async function textOf(path) {
    const scope = APP().state.scope;
    if (/\.(docx|xlsx|pptx)$/i.test(path)) {
      const r = await fetch(window.withSC('/api/preview?scope=' + encodeURIComponent(scope) + '&path=' + encodeURIComponent(path)));
      const j = await r.json();
      if (!j.ok) return { err: j.error || '预览解析失败' };
      return { text: flatten(j), kind: j.kind, data: j };
    }
    const r = await fetch(window.withSC('/api/file?scope=' + encodeURIComponent(scope) + '&path=' + encodeURIComponent(path)));
    const j = await r.json();
    if (!j.ok) return { err: j.error || '读不到' };
    return { text: String(j.text || ''), kind: 'text', data: j };
  }

  function flatten(o, acc) {
    acc = acc || [];
    if (typeof o === 'string') { acc.push(o); return acc.join('\n'); }
    if (Array.isArray(o)) { for (const x of o) flatten(x, acc); return acc.join('\n'); }
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (k === 'kind' || k === 'total' || k === 'width' || k === 'height') continue;
        flatten(o[k], acc);
      }
    }
    return acc.join('\n');
  }

  async function sizeOf(path) {
    const scope = APP().state.scope;
    try {
      const r = await fetch(window.withSC('/api/file?scope=' + encodeURIComponent(scope) + '&raw=1&path=' + encodeURIComponent(path)));
      if (!r.ok) return -1;
      const b = await r.blob();
      return b.size;
    } catch (e) { return -1; }
  }

  function cjkLen(s) {
    return String(s || '').replace(/\s+/g, '').length;
  }

  /* ── 断言（确定性那一轨：守住底线，抓回归） ── */

  async function check(task, a) {
    const files = collectFiles(task);
    const name = a.type;

    if (name === 'noFail') {
      const bad = (task.steps || []).filter((s) => s.kind === 'tool' && s.ok === false);
      if (bad.length) return fail(`有 ${bad.length} 个工具步骤失败，第一个：${bad[0].name}`);
      if (task.status === 'failed') return fail('任务整体失败');
      if (task.blockedOn) return fail(`卡在权限：${task.blockedOn}`);
      return ok();
    }

    if (name === 'file') {
      const f = pickFile(files, a.match);
      if (!f) return fail(`没有产出匹配 /${a.match}/ 的文件（本轮产出：${files.map((x) => x.path).join('、') || '空'}）`);
      return ok(`产出 ${f.path}`);
    }

    if (name === 'minBytes') {
      const f = pickFile(files, a.match);
      if (!f) return fail(`没有产出匹配 /${a.match}/ 的文件`);
      const n = await sizeOf(f.path);
      if (n < 0) return fail(`文件 ${f.path} 读不到大小（可能不在工作区）`);
      if (n < a.min) return fail(`${f.path} 只有 ${n} 字节，少于 ${a.min}`);
      return ok(`${f.path} ${n} 字节`);
    }

    if (name === 'chars') {
      const f = pickFile(files, a.match);
      if (!f) return fail(`没有产出匹配 /${a.match}/ 的文件`);
      const r = await textOf(f.path);
      if (r.err) return fail(`${f.path} 解析失败：${r.err}`);
      const n = cjkLen(r.text);
      if (n < a.min) return fail(`${f.path} 正文只有 ${n} 字，少于 ${a.min}`);
      return ok(`${f.path} ${n} 字`);
    }

    /* 指令遵循类题目要靠上限卡：模型最爱在这里偷懒（要求 120 字它写 300 字） */
    if (name === 'maxChars') {
      const f = pickFile(files, a.match);
      if (!f) return fail(`没有产出匹配 /${a.match}/ 的文件`);
      const r = await textOf(f.path);
      if (r.err) return fail(`${f.path} 解析失败：${r.err}`);
      const n = cjkLen(r.text);
      if (n > a.max) return fail(`${f.path} 正文 ${n} 字，超过上限 ${a.max} 字`);
      return ok(`${n} 字，在上限内`);
    }

    if (name === 'contains') {
      const f = pickFile(files, a.match);
      if (!f) return fail(`没有产出匹配 /${a.match}/ 的文件`);
      const r = await textOf(f.path);
      if (r.err) return fail(`${f.path} 解析失败：${r.err}`);
      const all = a.all || [];
      if (all.length) {
        const miss = all.filter((w) => !r.text.includes(w));
        if (miss.length) return fail(`${f.path} 缺少必含内容：${miss.join('、')}`);
      }
      const words = a.any || [];
      if (words.length && !words.some((w) => r.text.includes(w))) {
        return fail(`${f.path} 里没有出现任何一个关键词：${words.join(' / ')}`);
      }
      const bad = a.none || [];
      const hit = bad.find((w) => r.text.includes(w));
      if (hit) return fail(`${f.path} 里出现了不该有的内容：${hit}`);
      return ok(all.length ? `必含 ${all.length} 项齐全` : '');
    }

    if (name === 'slides') {
      const f = pickFile(files, a.match);
      if (!f) return fail(`没有产出匹配 /${a.match}/ 的文件`);
      const r = await textOf(f.path);
      if (r.err) return fail(`${f.path} 解析失败：${r.err}`);
      const n = (r.data.slides || []).length;
      if (n < a.min) return fail(`${f.path} 只有 ${n} 页，少于 ${a.min}`);
      return ok(`${n} 页`);
    }

    if (name === 'rows') {
      const f = pickFile(files, a.match);
      if (!f) return fail(`没有产出匹配 /${a.match}/ 的文件`);
      const r = await textOf(f.path);
      if (r.err) return fail(`${f.path} 解析失败：${r.err}`);
      const sheets = r.data.sheets || [];
      const n = sheets.reduce((m, s) => Math.max(m, (s.rows || []).length), 0);
      if (n < a.min) return fail(`${f.path} 最多的一张表只有 ${n} 行，少于 ${a.min}`);
      return ok(`${n} 行`);
    }

    if (name === 'rounds') {
      const n = roundsOf(task);
      if (n < a.min) return fail(`只跑出 ${n} 轮，应该至少 ${a.min} 轮`);
      return ok(`${n} 轮`);
    }

    if (name === 'roundIsolation') {
      if (!files.length) return fail('没有任何产出，无法判断跨轮');
      const byPath = new Map();
      for (const f of files) {
        if (!byPath.has(f.path)) byPath.set(f.path, new Set());
        byPath.get(f.path).add(f.round);
      }
      const crossed = [...byPath.entries()].filter(([, rs]) => rs.size > 1).map(([p]) => p);
      if (crossed.length) return fail(`这些产出跨了多轮：${crossed.join('、')}`);
      const rounds = roundsOf(task);
      const empty = [];
      for (let r = 1; r <= rounds; r++) {
        if (!files.some((f) => f.round === r)) empty.push(r);
      }
      if (empty.length) return fail(`第 ${empty.join('、')} 轮没有任何产出`);
      return ok(`${rounds} 轮各管各的产出`);
    }

    if (name === 'maxMs') {
      const ms = Number(task.ms) || 0;
      if (!ms) return ok('没记到耗时');
      if (ms > a.ms) return fail(`耗时 ${(ms / 1000).toFixed(1)}s，超过上限 ${(a.ms / 1000).toFixed(0)}s`);
      return ok(`${(ms / 1000).toFixed(1)}s`);
    }

    if (name === 'maxTokens') {
      const t = task.tokens || {};
      const n = (Number(t.in) || 0) + (Number(t.out) || 0);
      if (n > a.n) return fail(`用了 ${n} token，超过上限 ${a.n}`);
      return ok(`${n} token`);
    }

    if (name === 'verifyClean') {
      const v = task.verify;
      if (!v) return fail('这次没有验收结论（验收没跑，或者没落到 task.verify）');
      const gaps = Array.isArray(v.gaps) ? v.gaps : [];
      if (gaps.some((g) => /可解析|未验证处理/.test(String(g)))) {
        return fail(`验收人没返回可解析的结论，这份交付其实没被验过：${gaps.join('；')}`);
      }
      if (!v.verdict) return fail('验收结论没有 verdict 字段');
      if (a.mustPass && v.verdict !== 'pass') {
        return fail(`该过的题被判没过：${v.verdict}${gaps[0] ? ' · ' + gaps[0] : ''}`);
      }
      return ok(`${v.verdict}${v.score ? ' ' + v.score + '/4' : ''}`);
    }

    if (name === 'usedTools') {
      const tools = (task.steps || []).filter((s) => s && s.kind === 'tool' && s.ok !== false);
      const need = Number(a.min) || 1;
      if (tools.length < need) {
        return fail(`只调用了 ${tools.length} 次工具，至少要有 ${need} 次——像是只表态没干活`);
      }
      return ok(`${tools.length} 次工具调用`);
    }

    if (name === 'noStaleTalk') {
      const t = String(task.result || '');
      if (!t.trim()) return fail('正文是空的');
      const hit = t.match(/(有条件认|我不认|我认[，。、]|认领这活|认这个活|认下这个活)/);
      if (hit) return fail(`正文里出现了表态套话「${hit[0]}」，应该直接给结果`);
      return ok();
    }

    /* ── 分任务隔离（确定性自检，不调模型） ──
       线上真踩过：A 任务跑着的时候点开 B，A 的步骤和 PPT 产出写进了 B 的对话。
       这题把「跑的任务 ≠ 看的任务」钉成回归项：拿假任务走一遍真函数，看有没有串。 */
    if (name === 'runBinding') {
      const run = window.APP && window.APP.checkRunBinding;
      if (typeof run !== 'function') return fail('拿不到分任务隔离自检入口（APP.checkRunBinding）');
      const r = run() || {};
      const bad = (r.detail || []).filter((d) => !d.pass);
      if (bad.length) {
        return fail(bad.map((d) => d.name + (d.detail ? '：' + d.detail : '')).join('；'));
      }
      return ok(`${(r.detail || []).length} 项`);
    }

    /* 项目侧同一件事：后台跑着的项目，正文不许写进当前这一场（节点 id 都叫 T1，撞号） */
    if (name === 'projectBinding') {
      const run = window.MEET && window.MEET.checkBinding;
      if (typeof run !== 'function') return fail('拿不到项目隔离自检入口（MEET.checkBinding）');
      const r = run() || {};
      const bad = (r.detail || []).filter((d) => !d.pass);
      if (bad.length) {
        return fail(bad.map((d) => d.name + (d.detail ? '：' + d.detail : '')).join('；'));
      }
      return ok(`${(r.detail || []).length} 项`);
    }

    /* ── 编排治理（确定性自检，不调模型） ──
       技术文档里能在前端落地的那几条硬规矩：状态归一、非法迁移被拒、
       心跳判活、契约必须带验收口径、没落盘的产出不许算完成。
       直接问 STATES / CONTRACT 要答案，不碰界面、不烧 token。 */
    if (name === 'governance') {
      const S = window.STATES;
      const C = window.CONTRACT;
      if (!S || !C) return fail('拿不到 STATES / CONTRACT（states.js、contract.js 没加载）');
      const bad = [];
      const chk = (cond, msg) => { if (!cond) bad.push(msg); };
      chk(S.task.from('interrupted') === 'ready', 'interrupted 应归 ready（能续，不是失败）');
      chk(S.task.from('budget_exceeded') === 'failed', 'budget_exceeded 应归 failed');
      chk(S.task.from('weak') === 'completed', 'weak 应归 completed');
      chk(!S.canTransit('task', 'completed', 'running'), 'completed 不应能倒回 running');
      chk(!S.canTransit('node', 'done', 'run'), '节点 succeeded 不应能倒回 running');
      const now = Date.now();
      chk(S.heartbeatFresh(now - 30000), '30 秒前的心跳应算活着');
      chk(!S.heartbeatFresh(now - 120000), '2 分钟前的心跳应算过期');
      let c = null;
      try {
        c = C.build({ goal: '做个 ppt' }, {
          wantArtifacts: () => [{ key: 'pptx', name: 'PPT（.pptx）', re: /\.pptx$/i }]
        });
      } catch (e) { bad.push('契约生成抛错：' + e.message); }
      if (c) {
        chk((c.acceptance_criteria || []).length > 0, '契约必须有可判定的验收口径');
        chk(C.check(c, { wrote: [] }).pass === false, '没落盘的产出必须判不通过');
        chk(C.check(c, { wrote: ['/w/提案.pptx'] }).pass === true, '落盘后应判通过');
      }
      if (bad.length) return fail(bad.join('；'));
      return ok('状态机 / 心跳 / 契约 / 硬证据 10 项');
    }

    return fail(`未知断言类型：${name}`);
  }

  const ok = (msg) => ({ pass: true, msg: msg || '' });
  const fail = (msg) => ({ pass: false, msg: msg || '' });

  async function assertAll(task, assertions) {
    const results = [];
    const resultText = String(task.result || '');
    if (/<!doctype|<html[\s>]|WAF拦截|Web应用防护|block-pages/i.test(resultText)) {
      results.push({ type: 'no_raw_html', pass: false, msg: '结论里出现了原样 HTML/拦截页文本，错误没有净化' });
    }
    for (const a of assertions || []) {
      let r;
      try { r = await check(task, a); } catch (e) { r = fail('断言执行出错：' + e.message); }
      results.push({ type: a.type, ...r });
      if (!r.pass) break;
    }
    return results;
  }

  /* ── Rubric 评判（模型那一轨：比出优劣，给出诊断维度） ──
     为什么不复用任务内验收：那个是「这活干完没」的判定，只回 pass/fail + gaps，
     拿不到分维度分数，也没法跨模型比。质量分必须单独跑一遍评分标准。 */

  function extractJSON(text) {
    const s = String(text || '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    const body = s.slice(a, b + 1);
    try { return JSON.parse(body); } catch (e) { /* 继续尝试修 */ }
    try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
  }

  async function outputText(task) {
    const files = collectFiles(task);
    const out = [];
    for (const f of files.slice(0, 4)) {
      if (!/\.(md|txt|docx|xlsx|pptx|html?|csv)$/i.test(f.path)) continue;
      const r = await textOf(f.path);
      if (!r.err && String(r.text || '').trim()) out.push(`【${f.path}】\n${r.text}`);
    }
    if (!out.length) out.push(String(task.result || ''));
    return out.join('\n\n').slice(0, JUDGE_MAX_CHARS);
  }

  function rubricDims(c) {
    const r = c.rubric || {};
    if (Array.isArray(r.dims) && r.dims.length) return r.dims;
    return (rubricDefaults && rubricDefaults.dims) || [];
  }

  function scoreDims(dims, j) {
    const W = { essential: 3, important: 2, optional: 1 };
    let wsum = 0;
    let sum = 0;
    const got = {};
    const raw = (j && j.dims) || {};
    for (const d of dims) {
      const v = Number(raw[d.key]);
      if (!v) continue;
      const w = W[d.weight] || 2;
      const s = Math.max(1, Math.min(4, v));
      wsum += w;
      sum += s * w;
      got[d.key] = s;
    }
    const veto = !!(j && (j.veto === true || j.veto === 'fail'));
    const avg = wsum ? sum / wsum : null;
    return {
      quality: veto ? 0 : avg,
      raw: avg,
      dims: got,
      veto,
      note: String((j && (j.note || j.reason)) || '').slice(0, 200)
    };
  }

  async function rubricScore(c, task, variant, signal) {
    if (!window.CLOUD || !window.CLOUD.chatStream) return null;
    const text = await outputText(task);
    if (!String(text || '').trim()) {
      return { quality: 0, raw: 0, dims: {}, veto: true, note: '没有任何产出内容', tokens: { in: 0, out: 0 } };
    }
    const dims = rubricDims(c);
    if (!dims.length) return null;
    const ref = (c.rubric && c.rubric.ref) || '';
    const vetoText = (c.rubric && c.rubric.veto) || (rubricDefaults && rubricDefaults.veto) || '';
    const sys = '你是严格的内容评审。只输出一个 JSON 对象，不要任何解释、不要代码块。';
    const user = [
      '【任务】' + String(c.goal || ''),
      ref ? '【合格要点】' + ref : '',
      '【产出正文】\n' + text,
      '',
      '按下面维度逐项打 1-4 分（4=优秀，3=良好，2=及格，1=不及格）：',
      dims.map((d) => `- ${d.key}（${d.name}，${d.weight}）：${d.desc || ''}`).join('\n'),
      '',
      vetoText ? `【一票否决】${vetoText}。若命中，veto 置 true。` : '',
      '输出格式：{"dims":{"' + dims[0].key + '":4},"veto":false,"note":"一句话说明扣分点"}'
    ].filter(Boolean).join('\n');

    let txt = '';
    let usage = null;
    try {
      const payload = {
        model: variant.judgeModel,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
        max_tokens: 900
      };
      if (signal) payload.signal = signal;
      for await (const ch of window.CLOUD.chatStream(payload)) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const d = ch && ch.choices && ch.choices[0] && ch.choices[0].delta;
        if (d && d.content) txt += d.content;
        if (ch && ch.usage) usage = ch.usage;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      return { quality: null, raw: null, dims: {}, veto: false, note: '评委调用失败：' + (e.message || ''), tokens: { in: 0, out: 0 } };
    }
    const j = extractJSON(txt);
    const scored = scoreDims(dims, j);
    scored.note = j ? scored.note : ('评委没返回可解析的 JSON：' + String(txt || '').slice(0, 60));
    scored.tokens = {
      in: (usage && usage.prompt_tokens) || 0,
      out: (usage && usage.completion_tokens) || 0
    };
    return scored;
  }

  /* ── 跑一条 ── */

  function activeStaff() {
    const s = APP().state;
    if (!s.staff || !s.staff.length) return null;
    const id = s.curStaffId || (s.tasks[0] && s.tasks[0].employeeId);
    return s.staff.find((x) => x.id === id) || s.staff[0];
  }

  function summarizeAttempts(attempts) {
    const as = attempts || [];
    const tok = { in: 0, out: 0, reasoning: 0, cached: 0 };
    for (const a of as) {
      const t = a.tokens || {};
      tok.in += Number(t.in) || 0;
      tok.out += Number(t.out) || 0;
      tok.reasoning += Number(t.reasoning) || 0;
      tok.cached += Number(t.cached) || 0;
    }
    const qs = as.map((a) => a.quality).filter((v) => typeof v === 'number');
    const ttfts = as.map((a) => a.ttftP50).filter((v) => v > 0);
    return {
      ms: as.length ? Math.round(EK().mean(as.map((a) => a.ms))) : 0,
      tokens: tok,
      ttftP50: ttfts.length ? Math.round(EK().mean(ttfts)) : 0,
      toolCalls: Math.round(EK().mean(as.map((a) => a.toolCalls))),
      calls: Math.round(EK().mean(as.map((a) => a.calls))),
      rounds: as.length ? Math.max(...as.map((a) => a.rounds || 1)) : 1,
      quality: qs.length ? EK().mean(qs) : null,
      dims: (as[0] && as[0].dims) || {},
      veto: as.some((a) => a.veto),
      error: (as.find((a) => a.error) || {}).error || '',
      results: (as[0] || {}).results || []
    };
  }

  /* 任务内验收要独立于执行者，否则「自己批自己」；评委与评测用的 Rubric 评委分开挑，避免同一个模型既当运动员又当裁判 */
  function judgeFor(variant) {
    if (!window.JUDGE) return null;
    return window.JUDGE.pick(modelList(), variant.model);
  }

  async function runCase(c, variant, k, idx, total, signal) {
    const s = APP().state;
    const staff = activeStaff();
    const attempts = [];

    for (let i = 0; i < k; i++) {
      if (stopFlag) break;
      if (cur) {
        cur.line = `${variant.which === 'a' ? 'A' : 'B'} · 第 ${idx}/${total} 题 · ${c.title} · 第 ${i + 1}/${k} 次`;
        paintProgress();
      }
      const task = {
        id: 'eval_' + Date.now().toString(36) + '_' + c.id,
        title: '评测 · ' + c.title,
        goal: c.goal,
        files: [],
        steps: [],
        userMsgs: [],
        tokens: { in: 0, out: 0 },
        ms: 0,
        status: 'running'
      };
      const t0 = Date.now();
      const emit = () => {};
      /* 自检题（localOnly）：不调模型、不烧 token。
         这类题守的是「代码里的接线对不对」，跑一遍模型反而看不出串台。 */
      if (c.localOnly) {
        task.status = 'done';
        task.result = '（自检题：不调用模型）';
        task.ms = 0;
      } else {
      try {
        await window.BOSS.run({
          task, staff, settings: s.settings, model: variant.model,
          judge: judgeFor(variant), followUp: false, scope: s.scope, signal, emit
        });
        task.status = task.status || 'done';
      } catch (e) {
        task.ms = Date.now() - t0;
        task.status = 'failed';
        task.error = e.message;
        if (e && e.name === 'AbortError') stopFlag = true;
      }
      }

      if (!c.localOnly && c.then && task.status !== 'failed' && !stopFlag) {
        task.curRound = 2;
        try {
          await window.BOSS.run({
            task, staff, settings: s.settings, model: variant.model,
            judge: judgeFor(variant), followUp: c.then, scope: s.scope, signal, emit
          });
        } catch (e) {
          task.status = 'failed';
          task.error = e.message;
          if (e && e.name === 'AbortError') stopFlag = true;
        }
      }
      task.ms = task.ms || (Date.now() - t0);

      const results = await assertAll(task, c.assertions || []);
      let q = null;
      if (!c.localOnly && !stopFlag) {
        if (cur) { cur.line = `${variant.which === 'a' ? 'A' : 'B'} · 第 ${idx}/${total} 题 · ${c.title} · 评分中`; paintProgress(); }
        try { q = await rubricScore(c, task, variant, signal); } catch (e) { q = null; }
      }
      const m = task.metrics || {};
      attempts.push({
        ok: results.every((r) => r.pass),
        results,
        ms: task.ms,
        tokens: {
          in: Number(task.tokens && task.tokens.in) || 0,
          out: Number(task.tokens && task.tokens.out) || 0,
          reasoning: Number(m.reasoningTokens) || 0,
          cached: Number(m.cachedTokens) || 0
        },
        ttftP50: Number(m.ttftP50) || 0,
        calls: Number(m.calls) || 0,
        toolCalls: (task.steps || []).filter((x) => x.kind === 'tool' && x.ok !== false).length,
        rounds: roundsOf(task),
        quality: q && typeof q.quality === 'number' ? q.quality : null,
        dims: (q && q.dims) || {},
        veto: !!(q && q.veto),
        judgeTokens: (q && q.tokens) || { in: 0, out: 0 },
        qualityNote: (q && q.note) || '',
        error: task.error || ''
      });
    }

    const sum = summarizeAttempts(attempts);
    return {
      caseId: c.id,
      title: c.title,
      difficulty: c.difficulty || '',
      tags: c.tags || [],
      attempts: attempts.length,
      pass: attempts.length > 0 && attempts.length === k && attempts.every((a) => a.ok),
      passAtK: attempts.some((a) => a.ok),
      ...sum
    };
  }

  /* ── 跑一批（一个变体） ── */

  async function runSuite({ variant, cases, k, groupId }) {
    const ctrl = new AbortController();
    const items = [];
    cur = { at: Date.now(), k, line: '准备中…', items, total: cases.length, done: 0, groupId, ctrl };
    paintProgress();
    for (let i = 0; i < cases.length; i++) {
      if (stopFlag) break;
      const r = await runCase(cases[i], variant, k, i + 1, cases.length, ctrl.signal);
      items.push(r);
      cur.done = i + 1;
      renderList();
      paintProgress();
    }
    const run = {
      kind: 'run',
      id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      at: Date.now(),
      groupId: groupId || null,
      variant: {
        which: variant.which, label: variant.label, model: variant.model,
        modelName: variant.modelName, judgeModel: variant.judgeModel, judgeName: variant.judgeName
      },
      fp: {
        appVersion: appVersion(),
        caseVersion: seedVersion,
        k,
        caseIds: cases.map((c) => c.id),
        caseCount: cases.length,
        stopped: !!stopFlag
      },
      items
    };
    run.totals = EK().aggregate(items);
    await persist(run);
    return run;
  }

  /* ── 选基线：同模型 + 同题集，优先最近一条 ── */

  function sameCaseSet(a, b) {
    const x = (a.fp && a.fp.caseIds) || [];
    const y = (b.fp && b.fp.caseIds) || [];
    if (!x.length || !y.length) return false;
    const s = new Set(y);
    return x.length === y.length && x.every((id) => s.has(id));
  }

  function baselineFor(run) {
    const list = runsOnly().filter((r) => r.id !== run.id);
    const pick = document.getElementById('evBase');
    if (pick && pick.value && pick.value !== 'auto') {
      const got = list.find((r) => r.id === pick.value);
      if (got) return got;
    }
    const sameModel = list.filter((r) => r.variant && run.variant && r.variant.model === run.variant.model && sameCaseSet(r, run));
    if (sameModel.length) return sameModel.sort((a, b) => b.at - a.at)[0];
    const sameSet = list.filter((r) => sameCaseSet(r, run));
    if (sameSet.length) return sameSet.sort((a, b) => b.at - a.at)[0];
    return null;
  }

  /* ── 差异日志 ── */

  function timeStr(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function brief(run) {
    return {
      id: run.id,
      at: run.at,
      appVersion: (run.fp && run.fp.appVersion) || '?',
      model: (run.variant && run.variant.model) || '?',
      modelName: (run.variant && run.variant.modelName) || (run.variant && run.variant.model) || '?',
      judgeModel: (run.variant && run.variant.judgeModel) || '?',
      k: (run.fp && run.fp.k) || 1,
      n: (run.items || []).length
    };
  }

  function buildLog(base, curRun, comp) {
    const E = EK();
    const v = E.verdictOf(comp);
    const lines = [];
    lines.push(`# 评测差异日志 · ${timeStr(curRun.at)}`);
    lines.push('');
    lines.push(`- 基线：${base.fp.appVersion} · ${base.variant.model} · ${base.items.length} 题 · 每题 ${base.fp.k} 次 · ${timeStr(base.at)}`);
    lines.push(`- 当前：${curRun.fp.appVersion} · ${curRun.variant.model} · ${curRun.items.length} 题 · 每题 ${curRun.fp.k} 次 · ${timeStr(curRun.at)}`);
    lines.push(`- 评委：${curRun.variant.judgeModel || '—'} · 配对题数：${comp.n}`);
    lines.push('');
    lines.push('## 结论');
    lines.push(`**${v.text}**`);
    lines.push('');
    for (const d of E.decide(comp)) lines.push(`- ${d.text}`);
    lines.push('');
    lines.push('## 指标');
    lines.push('| 指标 | 基线 | 当前 | 差异 |');
    lines.push('|---|---|---|---|');
    lines.push(`| 通过率（Pass^k） | ${E.fmtPct(comp.aggA.passRate)} | ${E.fmtPct(comp.aggB.passRate)} | ${E.fmtPp(comp.pass.delta)} |`);
    lines.push(`| 至少过一次（Pass@k） | ${E.fmtPct(rateOf(base.items, 'passAtK'))} | ${E.fmtPct(rateOf(curRun.items, 'passAtK'))} | ${E.fmtPp(rateOf(curRun.items, 'passAtK') - rateOf(base.items, 'passAtK'))} |`);
    lines.push(`| 质量分 | ${E.fmtQ(comp.quality.a)} | ${E.fmtQ(comp.quality.b)} | ${E.fmtSigned(comp.quality.delta, 2)}（${E.fmtSigned(comp.quality.lo, 2)}～${E.fmtSigned(comp.quality.hi, 2)}） |`);
    lines.push(`| 首 token 延迟 p50 | ${E.fmtMs(comp.ttft.aP50)} | ${E.fmtMs(comp.ttft.bP50)} | ${E.fmtMs(comp.ttft.bP50 - comp.ttft.aP50)} |`);
    lines.push(`| 总时延 p50 / p95 | ${E.fmtMs(comp.latency.aP50)} / ${E.fmtMs(comp.latency.aP95)} | ${E.fmtMs(comp.latency.bP50)} / ${E.fmtMs(comp.latency.bP95)} | p95 ${E.fmtMs(comp.latency.bP95 - comp.latency.aP95)} |`);
    const aTokPer = comp.aggA.totalTokens / Math.max(1, comp.aggA.n);
    const bTokPer = comp.aggB.totalTokens / Math.max(1, comp.aggB.n);
    lines.push(`| token / 任务 | ${E.fmtTok(aTokPer)} | ${E.fmtTok(bTokPer)} | ${E.fmtTok(bTokPer - aTokPer)} |`);
    const aReasonPer = comp.aggA.tokens.reasoning / Math.max(1, comp.aggA.n);
    const bReasonPer = comp.aggB.tokens.reasoning / Math.max(1, comp.aggB.n);
    lines.push(`| 推理 token / 任务 | ${E.fmtTok(aReasonPer)} | ${E.fmtTok(bReasonPer)} | ${E.fmtTok(bReasonPer - aReasonPer)} |`);
    lines.push(`| 每成功一次成本 | ${comp.cost.aPerSuccess == null ? '—' : comp.cost.aPerSuccess.toFixed(1) + ' 积分'} | ${comp.cost.bPerSuccess == null ? '—' : comp.cost.bPerSuccess.toFixed(1) + ' 积分'} | ${comp.cost.deltaPerSuccess == null ? '—' : E.fmtSigned(comp.cost.deltaPerSuccess, 1) + ' 积分'} |`);
    lines.push(`| 工具调用次数 | ${comp.aggA.toolCalls.toFixed(1)} | ${comp.aggB.toolCalls.toFixed(1)} | ${E.fmtSigned(comp.aggB.toolCalls - comp.aggA.toolCalls, 1)} |`);
    lines.push('');
    const changed = comp.pairs.filter((p) => p.changed);
    lines.push('## 逐题变化');
    if (!changed.length) {
      lines.push('没有题目的判定或质量分发生可观察变化。');
    } else {
      lines.push('| 题目 | 基线 | 当前 | 质量 | token |');
      lines.push('|---|---|---|---|---|');
      for (const p of changed) {
        lines.push(`| ${p.title} | ${p.aPass ? '过' : '未过'} | ${p.bPass ? '过' : '未过'} | ${p.dq == null ? '—' : E.fmtSigned(p.dq, 1)} | ${E.fmtTok(p.dtok)} |`);
      }
    }
    lines.push('');
    lines.push('## 口径说明');
    lines.push('- 通过率按 Pass^k 报：k 次全过才算过，衡量的是「每次都对」的可靠性。');
    lines.push('- 质量分按 Rubric 四档（1-4）加权，命中幻觉否决直接归零。');
    lines.push('- 显著性用配对检验：二值走 McNemar 精确检验，连续量走配对 bootstrap（95% 区间）。');
    lines.push('- 分差在噪声内、或护栏（成本 / p95 时延）被突破时，不应据此切换。');

    return {
      kind: 'log',
      id: 'l_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      at: Date.now(),
      groupId: curRun.groupId || null,
      from: brief(base),
      to: brief(curRun),
      verdict: v,
      text: lines.join('\n'),
      summary: {
        n: comp.n,
        aRate: comp.aggA.passRate,
        bRate: comp.aggB.passRate,
        passDelta: comp.pass.delta,
        pValue: comp.pass.p,
        significant: comp.pass.significant,
        qualityA: comp.quality.a,
        qualityB: comp.quality.b,
        qualityDelta: comp.quality.delta,
        costA: comp.cost.aPerSuccess,
        costB: comp.cost.bPerSuccess,
        p95A: comp.latency.aP95,
        p95B: comp.latency.bP95,
        ttftA: comp.ttft.aP50,
        ttftB: comp.ttft.bP50,
        tokDelta: comp.tokens.delta,
        aWin: comp.pass.aWin,
        bWin: comp.pass.bWin,
        changed: comp.pairs.filter((p) => p.changed).map((p) => ({
          caseId: p.caseId, title: p.title, aPass: p.aPass, bPass: p.bPass, dq: p.dq
        }))
      }
    };
  }

  function rateOf(items, key) {
    const n = (items || []).length;
    if (!n) return 0;
    return (items || []).filter((x) => x[key || 'pass']).length / n;
  }

  /* ── 对外动作 ── */

  async function runBatch(which) {
    const s = APP().state;
    if (!(s && s.isAdmin)) return APP().toast('这一页只有管理员能看');
    if (busy) return;
    if (!window.BOSS) return APP().toast('员工模块还没就绪');

    await loadSeed();
    await loadHistory();

    const k = Math.max(1, Number((document.getElementById('evK') || {}).value) || 1);
    const list = Array.isArray(which)
      ? which
      : allCases().filter((c) => (which === 'all' ? true : !!c.smoke));
    if (!list.length) return APP().toast('这个范围里没有题');
    /* 自检题（localOnly）不调模型：整套都是自检的话，没配模型也该能跑 */
    if (list.some((c) => !c.localOnly)) {
      if (!s.models || !s.models.length) return APP().toast('模型通道还没就绪');
      if (!activeStaff()) return APP().toast('先建一个员工');
    }

    busy = true;
    stopFlag = false;
    renderControls();
    const groupId = 'g_' + Date.now().toString(36);
    const variant = variantOf('b');
    let run = null;
    try {
      run = await runSuite({ variant, cases: list, k, groupId });
    } finally {
      busy = false;
      if (cur) cur.ctrl = null;
      renderControls();
      paintProgress();
    }
    if (!run) return;

    const base = baselineFor(run);
    if (base) {
      const comp = EK().compare(base.items, run.items);
      lastCompare = { base, cur: run, comp };
      const log = buildLog(base, run, comp);
      await persist(log);
    }
    renderAll();
    const rate = Math.round((run.totals.passRate || 0) * 100);
    APP().toast(`${run.totals.passN}/${run.totals.n} 通过（${rate}%）${base ? '，已生成差异日志' : '，这是第一条基线'}`);
  }

  /* A/B 配对跑：同一批题、两个模型、逐题交替（ABBA），把时间漂移摊平 */
  async function runAB() {
    const s = APP().state;
    if (!(s && s.isAdmin)) return APP().toast('这一页只有管理员能看');
    if (busy) return;
    if (!window.BOSS) return APP().toast('员工模块还没就绪');
    if (!activeStaff()) return APP().toast('先建一个员工');

    await loadSeed();
    await loadHistory();

    const k = Math.max(1, Number((document.getElementById('evK') || {}).value) || 1);
    const list = allCases().filter((c) => !!c.smoke);
    if (!list.length) return APP().toast('没有冒烟题');
    const va = variantOf('a');
    const vb = variantOf('b');
    if (va.model === vb.model) return APP().toast('A 和 B 是同一个模型，改一下其中一个再跑');

    busy = true;
    stopFlag = false;
    renderControls();
    const groupId = 'g_' + Date.now().toString(36);
    const itemsA = [];
    const itemsB = [];
    const ctrl = new AbortController();
    cur = { at: Date.now(), k, line: '准备中…', items: [], total: list.length * 2, done: 0, groupId, ctrl };
    paintProgress();

    try {
    for (let i = 0; i < list.length; i++) {
      if (stopFlag) break;
      const c = list[i];
      /* 交替顺序：偶数题先 A 后 B，奇数题先 B 后 A，抵消「后跑的占便宜」 */
      const order = i % 2 === 0 ? [['a', va], ['b', vb]] : [['b', vb], ['a', va]];
      for (const [tag, v] of order) {
        if (stopFlag) break;
        const r = await runCase(c, v, k, i + 1, list.length, ctrl.signal);
        (tag === 'a' ? itemsA : itemsB).push(r);
        cur.done = itemsA.length + itemsB.length;
        paintProgress();
      }
      renderList();
    }

    const mkRun = (variant, items) => {
      const run = {
        kind: 'run',
        id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        at: Date.now(),
        groupId,
        variant: {
          which: variant.which, label: variant.label, model: variant.model,
          modelName: variant.modelName, judgeModel: variant.judgeModel, judgeName: variant.judgeName
        },
        fp: {
          appVersion: appVersion(), caseVersion: seedVersion, k,
          caseIds: list.map((c) => c.id), caseCount: list.length, stopped: !!stopFlag
        },
        items
      };
      run.totals = EK().aggregate(items);
      return run;
    };

    const runA = mkRun(va, itemsA);
    const runB = mkRun(vb, itemsB);
    await persist(runA);
    await persist(runB);
    const comp = EK().compare(runA.items, runB.items);
    lastCompare = { base: runA, cur: runB, comp };
    const log = buildLog(runA, runB, comp);
    await persist(log);
    APP().toast(`${EK().verdictOf(comp).text} · 已生成差异日志`);
    } finally {
      busy = false;
      if (cur) cur.ctrl = null;
      renderControls();
      paintProgress();
      renderAll();
    }
  }

  /* ── 界面 ── */

  const esc = (x) => APP().esc(x);

  function renderControls() {
    const a = document.getElementById('evSmoke');
    const b = document.getElementById('evAll');
    const ab = document.getElementById('evAB');
    const kSel = document.getElementById('evK');
    if (kSel) kSel.disabled = busy;
    if (a) { a.disabled = busy; a.textContent = busy ? '跑着…' : '跑冒烟'; a.onclick = () => { if (!busy) runBatch('smoke'); }; }
    if (b) { b.disabled = busy; b.textContent = busy ? '停止' : '全部跑一遍'; b.classList.toggle('primary', !busy); b.classList.toggle('danger', busy); b.onclick = () => { if (busy) { stopFlag = true; if (cur && cur.ctrl) { try { cur.ctrl.abort(); } catch (e) { /* 已停 */ } } return; } runBatch('all'); }; }
    if (ab) { ab.disabled = busy; ab.textContent = busy ? '跑着…' : 'A/B 配对跑'; ab.onclick = () => { if (!busy) runAB(); }; }
    paintVariants();
  }

  function paintVariants() {
    const sal = document.getElementById('evVarA');
    const sbl = document.getElementById('evVarB');
    if (!sal || !sbl) return;
    const models = modelList();
    const saved = savedVariants();
    const staff = activeStaff();
    const def = (staff && staff.model) || (APP().state.settings && APP().state.settings.model) || (models[0] && models[0].id) || '';
    const a = saved.a || def;
    const b = saved.b || def;
    const opts = (sel) => models.map((m) => `<option value="${esc(m.id)}"${m.id === sel ? ' selected' : ''}>${esc(m.name || m.id)}</option>`).join('');
    if (!models.length) {
      sal.innerHTML = '<option value="">无可用模型</option>';
      sbl.innerHTML = '<option value="">无可用模型</option>';
      return;
    }
    sal.innerHTML = opts(a);
    sbl.innerHTML = opts(b);
    sal.onchange = () => { const v = savedVariants(); v.a = sal.value; saveVariants(v); };
    sbl.onchange = () => { const v = savedVariants(); v.b = sbl.value; saveVariants(v); };
  }

  function paintProgress() {
    const el = document.getElementById('evProg');
    if (!el) return;
    if (!busy || !cur) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const pct = cur.total ? Math.round((cur.done / cur.total) * 100) : 0;
    el.innerHTML = `<div class="ev-prog-t">${esc(cur.line || '准备中…')}</div>
      <div class="ev-bar"><i style="width:${pct}%"></i></div>
      <div class="ev-prog-m">${cur.done}/${cur.total} · 每题 ${cur.k} 次</div>`;
  }

  function metricCell(label, a, b, deltaText, tone, hint) {
    return `<div class="ev-metric">
      <div class="ev-metric-l">${esc(label)}</div>
      <div class="ev-metric-v">${a}<span class="ev-arrow">→</span>${b}</div>
      <div class="ev-metric-d ${tone || ''}">${esc(deltaText || '')}</div>
      ${hint ? `<div class="ev-metric-h">${esc(hint)}</div>` : ''}
    </div>`;
  }

  /* 当前要比的是哪两份：优先刚跑完的那次，其次「最近一次运行 + 自动基线」。
     两个面板共用同一份结果，避免指标卡说 A→B、逐题表却在比别的。 */
  function currentCompare() {
    if (lastCompare && lastCompare.comp) return lastCompare;
    const run = runsOnly()[0];
    if (!run) return null;
    const base = baselineFor(run);
    if (!base) return null;
    const comp = EK().compare(base.items, run.items);
    if (!comp || !comp.n) return null;
    lastCompare = { base, cur: run, comp };
    return lastCompare;
  }

  function renderCompare() {
    const box = document.getElementById('evCompare');
    if (!box) return;
    const E = EK();
    const got = currentCompare();
    if (!got) {
      box.innerHTML = `<div class="ev-card">
        <div class="ev-card-head"><span class="ev-card-t">还没有可对比的运行</span></div>
        <div class="ev-card-m">先点「跑冒烟」或「全部跑一遍」。第一遍是基线；之后每次跑完会自动和上一次同模型、同题集的记录配对比较，并生成差异日志。</div>
      </div>`;
      return;
    }
    const base = got.base;
    const run = got.cur;
    const comp = got.comp;
    if (!comp || !comp.n) {
      box.innerHTML = `<div class="ev-card"><div class="ev-card-m">两次运行的题目对不上（也许题库改过），无法配对比较。</div></div>`;
      return;
    }
    const v = E.verdictOf(comp);
    const tone = v.code === 'accept' ? 'good' : v.code === 'reject' ? 'bad' : 'warn';
    const concl = E.decide(comp);
    const sameVer = base.fp.appVersion === run.fp.appVersion;

    box.innerHTML = `<div class="ev-card">
      <div class="ev-card-head">
        <span class="ev-card-t">${esc(base.fp.appVersion)} · ${esc(base.variant.model)} → ${esc(run.fp.appVersion)} · ${esc(run.variant.model)}</span>
        <span class="ev-pill ${tone}">${esc(v.text)}</span>
        ${sameVer ? '<span class="ev-tag">同版本对比</span>' : '<span class="ev-tag">跨版本对比</span>'}
        <span class="ev-num">${esc(timeStr(base.at))} → ${esc(timeStr(run.at))} · 配对 ${comp.n} 题</span>
      </div>
      <div class="ev-metrics">
        ${metricCell('通过率 Pass^k', E.fmtPct(comp.aggA.passRate), E.fmtPct(comp.aggB.passRate), E.fmtPp(comp.pass.delta) + (comp.pass.significant ? ' 显著' : ' 噪声内'), comp.pass.delta > 0 ? 'up' : comp.pass.delta < 0 ? 'down' : '', `McNemar p=${comp.pass.p.toFixed(3)}`)}
        ${metricCell('质量分', E.fmtQ(comp.quality.a), E.fmtQ(comp.quality.b), comp.quality.n ? E.fmtSigned(comp.quality.delta, 2) + (comp.quality.significant ? ' 显著' : ' 噪声内') : '未评分', comp.quality.delta > 0 ? 'up' : comp.quality.delta < 0 ? 'down' : '', comp.quality.n ? `95% 区间 ${E.fmtSigned(comp.quality.lo, 2)}～${E.fmtSigned(comp.quality.hi, 2)}` : '')}
        ${metricCell('首 token 延迟', E.fmtMs(comp.ttft.aP50), E.fmtMs(comp.ttft.bP50), comp.ttft.aP50 ? E.fmtSigned(comp.ttft.delta, 0) + 'ms' : '未测到', comp.ttft.delta < 0 ? 'up' : 'down', '反应速度')}
        ${metricCell('p95 时延', E.fmtMs(comp.latency.aP95), E.fmtMs(comp.latency.bP95), comp.latency.aP95 ? E.fmtSigned(comp.latency.bP95 - comp.latency.aP95, 0) + 'ms' : '—', comp.latency.bP95 < comp.latency.aP95 ? 'up' : 'down', '用户等待')}
        ${metricCell('token / 任务', E.fmtTok(comp.aggA.totalTokens / Math.max(1, comp.aggA.n)), E.fmtTok(comp.aggB.totalTokens / Math.max(1, comp.aggB.n)), E.fmtTok(comp.aggB.totalTokens / Math.max(1, comp.aggB.n) - comp.aggA.totalTokens / Math.max(1, comp.aggA.n)), comp.tokens.delta < 0 ? 'up' : 'down', `推理 ${E.fmtTok(comp.tokens.aReason / Math.max(1, comp.aggA.n))} → ${E.fmtTok(comp.tokens.bReason / Math.max(1, comp.aggB.n))}`)}
        ${metricCell('每成功一次成本', comp.cost.aPerSuccess == null ? '—' : comp.cost.aPerSuccess.toFixed(1), comp.cost.bPerSuccess == null ? '—' : comp.cost.bPerSuccess.toFixed(1), comp.cost.deltaPerSuccess == null ? '—' : E.fmtSigned(comp.cost.deltaPerSuccess, 1) + ' 积分', comp.cost.deltaPerSuccess < 0 ? 'up' : comp.cost.deltaPerSuccess > 0 ? 'down' : '', '便宜但老失败，实际更贵')}
      </div>
      <div class="ev-concl">
        ${concl.map((x) => `<div class="ev-concl-i ${x.level}"><span class="ev-concl-dot"></span>${esc(x.text)}</div>`).join('')}
      </div>
    </div>`;
  }

  function renderPairs() {
    const box = document.getElementById('evPairs');
    if (!box) return;
    const E = EK();
    const got = currentCompare();
    if (!got) { box.innerHTML = ''; return; }
    const comp = got.comp;
    const rows = comp.pairs.slice().sort((a, b) => (b.changed ? 1 : 0) - (a.changed ? 1 : 0));
    const head = `<div class="ev-prow ev-phead">
      <span>题目</span><span>A</span><span>B</span><span>质量</span><span>时延</span><span>token</span><span>首个没过的断言</span>
    </div>`;
    const body = rows.map((p) => `<div class="ev-prow ${p.changed ? 'chg' : ''}">
      <span class="ev-ptitle">${esc(p.title)}${p.changed ? '<i class="ev-chg">变化</i>' : ''}</span>
      <span><i class="ev-badge ${p.aPass ? 'pass' : 'fail'}">${p.aPass ? '过' : '未过'}</i></span>
      <span><i class="ev-badge ${p.bPass ? 'pass' : 'fail'}">${p.bPass ? '过' : '未过'}</i></span>
      <span>${p.dq == null ? '—' : E.fmtSigned(p.dq, 1)}</span>
      <span>${E.fmtMs(p.aMs)} → ${E.fmtMs(p.bMs)}</span>
      <span>${E.fmtTok(p.aTok)} → ${E.fmtTok(p.bTok)}</span>
      <span class="ev-pfail">${esc((p.bFail && (p.bFail.type + ' · ' + p.bFail.msg)) || (p.aFail ? '（基线失败：' + p.aFail.type + '）' : ''))}</span>
    </div>`).join('');
    const changed = comp.pairs.filter((p) => p.changed).length;
    box.innerHTML = `<div class="ev-card">
      <div class="ev-card-head">
        <span class="ev-card-t">逐题配对</span>
        <span class="ev-tag">${rows.length} 题 · ${changed} 题有变化</span>
      </div>
      <div class="ev-ptable">${head}${body}</div>
      ${(comp.onlyA.length || comp.onlyB.length) ? `<div class="ev-card-m">未配对：仅 A 有 ${comp.onlyA.length} 题、仅 B 有 ${comp.onlyB.length} 题（题库不一致）</div>` : ''}
    </div>`;
  }

  function renderList() {
    const box = document.getElementById('evList');
    if (!box) return;
    const cases = allCases();
    if (!cases.length) {
      box.innerHTML = `<div class="empty"><div class="empty-t">题库没加载上</div><div class="empty-d">刷新一次页面；如果还不行，检查 eval-cases.json 是否跟着一起部署了。</div></div>`;
      return;
    }
    const E = EK();
    const latest = runsOnly()[0];
    const byCase = new Map();
    for (const r of runsOnly()) {
      for (const it of (r.items || [])) if (!byCase.has(it.caseId)) byCase.set(it.caseId, { item: it, run: r });
    }
    if (latest) for (const it of latest.items) byCase.set(it.caseId, { item: it, run: latest });

    box.innerHTML = cases.map((c) => {
      const got = byCase.get(c.id);
      const r = got && got.item;
      const state = !r ? 'idle' : r.pass ? 'pass' : 'fail';
      const badge = state === 'pass' ? '通过' : state === 'fail' ? '没过' : '未跑';
      const failOne = r && !r.pass ? (r.results || []).find((x) => !x.pass) : null;
      const dims = r && r.dims ? Object.keys(r.dims) : [];
      const detail = r && (r.results || []).length
        ? `<div class="ev-asserts">${r.results.map((x) => `<span class="ev-a ${x.pass ? 'ok' : 'no'}">${esc(x.type)}${x.msg ? ' · ' + esc(x.msg) : ''}</span>`).join('')}
           ${r.quality != null ? `<span class="ev-a ok">质量 ${Number(r.quality).toFixed(2)}/4${r.veto ? ' · 幻觉否决' : ''}</span>` : ''}
           ${dims.map((k) => `<span class="ev-a">${esc(k)} ${r.dims[k]}</span>`).join('')}
           ${r.attempts > 1 ? `<span class="ev-a">${r.attempts} 次里 ${(r.passAtK ? '过' : '未过')}过</span>` : ''}
         </div>`
        : '';
      return `<div class="ev-row ${state}" data-case="${esc(c.id)}">
        <div class="ev-row-top">
          <span class="ev-dot"></span>
          <span class="ev-title">${esc(c.title)}</span>
          ${c.smoke ? '<span class="ev-tag">冒烟</span>' : ''}
          ${c.difficulty ? `<span class="ev-tag">${esc(c.difficulty)}</span>` : ''}
          <span class="ev-badge ${state}">${badge}</span>
          <span class="ev-num">${r ? E.fmtMs(r.ms) + ' · ' + E.fmtTok((r.tokens.in || 0) + (r.tokens.out || 0)) + ' token' + (r.quality != null ? ' · 质量 ' + Number(r.quality).toFixed(1) : '') : ''}</span>
          <button class="ev-one" data-one="${esc(c.id)}" type="button">${busy ? '' : '跑这条'}</button>
        </div>
        ${c.why ? `<div class="ev-why">${esc(c.why)}</div>` : ''}
        ${failOne ? `<div class="ev-fail">第一个没过的断言：<b>${esc(failOne.type)}</b> — ${esc(failOne.msg)}</div>` : ''}
        ${detail}
      </div>`;
    }).join('');

    box.querySelectorAll('.ev-row').forEach((row) => {
      row.onclick = () => row.classList.toggle('open');
    });
    box.querySelectorAll('.ev-one').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        if (busy) return;
        const c = allCases().find((x) => x.id === btn.dataset.one);
        if (c) runBatch([c]);
      };
    });
  }

  function renderLogs() {
    const box = document.getElementById('evLogs');
    if (!box) return;
    const logs = logsOnly().slice(0, MAX_LOGS);
    if (!logs.length) {
      box.innerHTML = `<div class="ev-card"><div class="ev-card-head"><span class="ev-card-t">版本差异日志</span></div>
        <div class="ev-card-m">每次跑完会自动生成一条：记下基线版本、当前版本、五项指标变化和结论。更新完 agent 逻辑后再跑一次，就能看到前后差异。</div></div>`;
      return;
    }
    const toneOf = (v) => (v && v.code === 'accept' ? 'good' : v && v.code === 'reject' ? 'bad' : 'warn');
    box.innerHTML = `<div class="ev-card">
      <div class="ev-card-head">
        <span class="ev-card-t">版本差异日志</span>
        <span class="ev-tag">${logs.length} 条</span>
        <button class="btn tiny ghost" id="evExportAll" type="button">导出全部</button>
      </div>
      <div class="ev-logs">
        ${logs.map((l) => {
          const sm = l.summary || {};
          const q = (v) => (v == null ? '—' : Number(v).toFixed(1));
          return `<div class="ev-log" data-log="${esc(l.id)}">
          <div class="ev-log-top">
            <span class="ev-pill ${toneOf(l.verdict)}">${esc((l.verdict && l.verdict.text) || '—')}</span>
            <span class="ev-log-t">${esc((l.from && l.from.appVersion) || '?')} → ${esc((l.to && l.to.appVersion) || '?')}</span>
            <span class="ev-log-m">${esc((l.from && l.from.model) || '')} · 通过 ${EK().fmtPct(sm.aRate)} → ${EK().fmtPct(sm.bRate)} · 质量 ${q(sm.qualityA)} → ${q(sm.qualityB)}</span>
            <span class="ev-num">${esc(timeStr(l.at))}</span>
          </div>
          <pre class="ev-log-body" hidden></pre>
        </div>`;
        }).join('')}
      </div>
    </div>`;

    box.querySelectorAll('.ev-log').forEach((el) => {
      el.onclick = () => {
        const log = logs.find((x) => x.id === el.dataset.log);
        const pre = el.querySelector('.ev-log-body');
        if (!log || !pre) return;
        pre.textContent = log.text || '';
        pre.hidden = !pre.hidden;
        el.classList.toggle('open', !pre.hidden);
      };
    });
    const btn = document.getElementById('evExportAll');
    if (btn) btn.onclick = () => exportAll(logs);
  }

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportAll(logs) {
    const text = (logs || []).map((l) => l.text).join('\n\n---\n\n');
    download(`评测差异日志-${timeStr(Date.now()).replace(/[: ]/g, '-')}.md`, text || '暂无日志');
    APP().toast('已导出差异日志');
  }

  function renderMeta() {
    const el = document.getElementById('evMeta');
    if (!el) return;
    const n = allCases().length;
    const smoke = allCases().filter((c) => c.smoke).length;
    const runs = runsOnly().length;
    el.textContent = `题库 v${seedVersion || '?'} · ${n} 道题（冒烟 ${smoke}）· 历史 ${runs} 次运行。跑完自动和上一次同模型、同题集的记录配对比较，生成差异日志。`;
  }

  function fillBaselineSelect() {
    const sel = document.getElementById('evBase');
    if (!sel) return;
    const keep = sel.value || 'auto';
    const list = runsOnly().slice(0, 12);
    sel.innerHTML = `<option value="auto">自动选基线（同模型 + 同题集）</option>` + list.map((r) => {
      const d = new Date(r.at);
      const t = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `<option value="${esc(r.id)}">${esc(`${t} · ${r.fp.appVersion} · ${r.variant.model} · ${r.items.length}题`)}</option>`;
    }).join('');
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    sel.onchange = () => { lastCompare = null; renderCompare(); renderPairs(); };
  }

  function renderAll() {
    renderMeta();
    renderCompare();
    renderPairs();
    renderList();
    renderLogs();
    fillBaselineSelect();
  }

  async function open() {
    if (!(APP().state && APP().state.isAdmin)) return APP().toast('这一页只有管理员能看');
    APP().showView('eval');
    await loadSeed();
    await loadHistory();
    lastCompare = null;
    renderControls();
    renderAll();
    paintProgress();
  }

  function addCase({ title, goal, match, minChars }) {
    if (!title || !goal) return APP().toast('题目和目标都要有');
    const list = customCases();
    const c = {
      id: 'my-' + Date.now().toString(36),
      title,
      goal,
      smoke: false,
      difficulty: 'L2',
      tags: ['手工'],
      why: '手工录的题',
      k: 1,
      maxMs: 180000,
      assertions: [
        { type: 'noFail' },
        { type: 'file', match: match || '.' },
        ...(minChars ? [{ type: 'chars', match: match || '.', min: Number(minChars) }] : [])
      ]
    };
    list.unshift(c);
    saveCustom(list);
    renderAll();
    APP().toast('已加入题库');
  }

  window.REVIEW = {
    open, runBatch, runAB, addCase, allCases,
    runs: () => runsOnly(),
    logs: () => logsOnly(),
    compare: (aId, bId) => {
      const a = runsOnly().find((r) => r.id === aId);
      const b = runsOnly().find((r) => r.id === bId);
      return a && b ? EK().compare(a.items, b.items) : null;
    },
    exportAll,
    clearRuns: () => { localStorage.removeItem(LS_RUNS); history = []; renderAll(); },
    /* 测试口子：断言、评分、日志生成不该靠真跑任务去验 */
    _check: check, _judge: assertAll, _scoreDims: scoreDims, _buildLog: (a, b) => buildLog(a, b, EK().compare(a.items, b.items))
  };
})();
