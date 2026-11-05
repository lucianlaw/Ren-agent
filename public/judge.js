/* 核验内核：任务线和项目线共用同一套判定，不许各写一份
 *
 * 依据《深入理解 AI Agent》第 7 章：
 *   · 7.4.2 评估框架必须核实「机器可独立复核的事实」，而不是 Agent 的自我陈述；
 *           所以文件内容由程序从磁盘读出来交给验收人，交付人自称「已完成」不算证据。
 *   · 7.5.1 Rubric 四准则：按重要性分必要项/重要项/可选项/一票否决项，
 *           四档制打分且每档都写死可验证的行为，不写「不够深入」这种没法判的话；
 *           显式惩罚冗长（长度偏差），幻觉一票否决（奖励作弊）。
 *   · 10.5.3 同质趋同：审核人和生产者是同一个模型时，其意见不能算独立证据，
 *           所以验收人优先挑「不同家族」的模型，并且把独立度如实标出来。
 *
 * 这个文件是纯函数，不碰网络、不碰 DOM：
 *   - 浏览器里挂 window.JUDGE（agent.js / meeting.js 都只调它）
 *   - Node 里可以 require / import 进来做单测
 */
;(function (root, factory) {
  const api = factory();
  if (root) root.JUDGE = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  /* ── 维度表：权重决定聚合，「一票否决」只有 fact 一个 ── */
  const DIMS = [
    { k: 'goal', name: '目标覆盖', w: 'essential', weight: 3, tip: '有没有正面回答要办的那件事' },
    { k: 'deliver', name: '交付一致', w: 'essential', weight: 3, tip: '说做了的东西是否真在、内容是否对得上' },
    { k: 'fact', name: '事实可溯', w: 'veto', weight: 0, tip: '具体数字有没有来源或口径' },
    { k: 'consist', name: '前后一致', w: 'important', weight: 2, tip: '和已经成立的结论有没有打架' },
    { k: 'brevity', name: '不凑字数', w: 'optional', weight: 1, tip: '有没有靠堆篇幅充数' }
  ];
  const DIM = Object.fromEntries(DIMS.map(d => [d.k, d]));

  /* 逐档写死行为：书里明确要求「每档配具体判定标准而非抽象描述」 */
  const RUBRIC = [
    '1. goal（必要项）4=第一句就是结论且把要求全覆盖；3=结论清楚，漏了次要要求；2=只答了一部分，或者结论埋在背景里；1=没回答，或者答的是另一件事。',
    '2. deliver（必要项）4=声明的产出都在，且内容与结论对得上；3=产出在，但有一处说法和文件内容不符；2=产出在但明显不完整（只有标题/只有一部分）；1=说做了但文件里没有。',
    '3. fact（一票否决项）pass=每个具体数字都写了来源或口径（如「按 3 年、单价 0.12 元/次估算」「按 3000 只首单摊」）；fail=凭空甩出一个具体数字，既没来源也没口径。注意：写了口径的估算算 pass——这一项不是让你质疑估算准不准，只拦「一句话凭空甩个数」。',
    '4. consist（重要项）4=与已有结论一致；3=有出入但说明了原因；2=有出入、说明含糊；1=直接矛盾且没有任何交代。没有前文可比时给 4。',
    '5. brevity（可选项）4=该说的说完、没有废话；3=略啰嗦；2=大段复述背景、凑篇幅；1=几乎全是废话。只用来纠长度偏差，不单独决定通过与否。'
  ];

  /* ── 挑验收人：优先不同家族，其次不同型号，都没有才用同一个 ── */
  const LIGHT_RE = /flash|mini|turbo|fast|lite|instant|haiku|small/i;
  function famOf(id) {
    return String(id || '').toLowerCase().split(/[-_/.:@\s]/)[0];
  }
  /**
   * @returns {{id,name,level:'full'|'weak'|'none',reason}}
   *   full = 不同家族的模型（独立证据）
   *   weak = 同家族的另一款（独立性打折）
   *   none = 只能自己验自己（同质趋同，结论只能当参考）
   */
  /* 验收人候选队列：按「能不能给出结论」排序，而不是按列表顺序碰运气。
     2026-11-02 线上事故：pick 取到列表第一个不同家族的模型（hy4-preview），
     它在验收任务上会把 max_tokens 全花在思考上、正文 0 字、finish_reason=length，
     连 enable_thinking:false 都拦不住（实测 1600 / 4000 两种额度结果一样）。
     hy3-x 同样如此。所以这里先排掉思考型、再排掉轻量版。 */
  function candidates(models, workerModel, opts) {
    const o = opts || {};
    const skip = new Set((Array.isArray(o.exclude) ? o.exclude : []).map(x => String(x)));
    /* auto / default 是路由别名，不是具体模型：拿它当验收人等于随机，
       连是谁验的都说不清，所以一律排除（也排除在「重试换人」之外）。 */
    const alias = new Set(['auto', 'default']);
    const list = (Array.isArray(models) ? models : [])
      .filter(m => m && m.id
        && !alias.has(String(m.id).toLowerCase())
        && !skip.has(String(m.id)));
    const worker = String(workerModel || '');
    if (!list.length) return [];
    const wf = famOf(worker);
    const score = (m) => (isThinking(m.id) ? 4 : 0) + (LIGHT_RE.test(m.id + ' ' + (m.name || '')) ? 2 : 0);
    const seen = new Set();
    const out = [];
    const push = (arr, level) => {
      arr.slice().sort((a, b) => score(a) - score(b)).forEach(m => {
        if (seen.has(String(m.id))) return;
        seen.add(String(m.id));
        const thinking = isThinking(m.id);
        out.push({
          id: m.id, name: m.name || m.id, level, thinking,
          reason: level === 'full'
            ? (thinking
              ? '与生产者不同模型，但它是思考型，可能把额度全花在思考上'
              : '与生产者不同模型，意见可算独立证据')
            : '同家族的另一款模型，独立性打折'
        });
      });
    };
    push(list.filter(m => famOf(m.id) !== wf), 'full');
    push(list.filter(m => famOf(m.id) === wf && String(m.id) !== worker), 'weak');
    return out;
  }

  function pick(models, workerModel, opts) {
    const worker = String(workerModel || '');
    const list = candidates(models, workerModel, opts);
    if (list.length) return list[0];
    /* 没有别的可挑：列表是空的，或者只剩生产者自己 */
    const all = (Array.isArray(models) ? models : []).filter(m => m && m.id);
    if (!all.length) {
      return { id: worker, name: worker || '未知', level: 'none', reason: '模型列表为空，只能沿用生产者模型' };
    }
    const self = all.find(m => String(m.id) === worker);
    return {
      id: worker, name: (self && self.name) || worker, level: 'none',
      reason: '只有一个可用模型，验收人与生产者同源，结论仅供参考',
      thinking: isThinking(worker)
    };
  }

  /* 思考型模型识别：这类模型做验收会「只思考、不落笔」，必须避开。
     -thinking / -reasoner / -r1 是明写的；
     hy3-x、hy4-preview-x 是同一批「重度思考」变体（实测正文同样是 0 字）。 */
  const THINKING_RE = /thinking|reasoner|-r1$|hy\d.*-x$|hy4-preview/i;
  function isThinking(id) {
    return THINKING_RE.test(String(id || ''));
  }

  /* ── 程序能判的，先判：书里说「核实机器可独立复核的事实」 ──
   * 这一层不花 token，也不会被模型的话术说服；模型只能在此基础上加判定，不能推翻。 */
  function gate(opt) {
    const o = opt || {};
    const digests = Array.isArray(o.digests) ? o.digests : [];
    const text = String(o.text || '');
    const hard = [];
    const soft = [];

    if (o.expectFiles && !digests.length) {
      hard.push('这次要求交付文件，但工作目录里没有多出任何文件');
    }
    for (const d of digests) {
      if (!d) continue;
      const name = d.path || '产出文件';
      if (d.missing) { hard.push(`说已交付 ${name}，磁盘上没有这个文件`); continue; }
      if (!d.size) { hard.push(`${name} 是空文件（0 字节）`); continue; }
      /* 十几字以内基本就是占位符（只写了个标题）。再短下去会误伤真·短交付物，
         所以门槛压得很低：真正的判断交给验收人，程序只拦「几乎是空的」。 */
      if (d.chars != null && d.chars < 12) { hard.push(`${name} 里几乎没有内容（${d.chars} 字）`); continue; }
      if (d.kind === 'other' && d.error) soft.push(`${name} 读不出内容：${d.error}`);
    }
    /* 全都是上一轮的旧文件：这一轮根本没动过盘，拿旧货当新交付。
       只在「全旧」时才报——单个文件旧是常事（这一轮只改了其中一个），全旧才说明这轮没干活。 */
    if (digests.length && digests.every(d => d && d.stale)) {
      soft.push('这一轮没有新写或改动任何文件，盘上还是上一轮的旧版');
    }
    /* 没有文件、正文也几乎为空：交付人不只是没落盘，是什么都没做 */
    if (!digests.length && text.trim().length < 40) {
      hard.push('既没有交付文件，正文也几乎是空的');
    }
    /* 声明了「已写入 X」但 X 不在磁盘上：这是最常见的自我陈述造假，程序能抓。
       只在明确写盘的说法里找文件名——「生成一份报告」这种话不算承诺，别冤判。 */
    const CLAIM_RE = /已(?:经)?(?:写入|写进|保存|落盘|导出|存到|存进)/;
    const FILE_RE = /[`「"']?([^\s`「」"'，。；、：:,（）()]{2,60}\.(?:md|txt|docx|xlsx|pptx|csv|pdf|html|json|png|jpg|jpeg|svg))/g;
    const claimed = [];
    for (const seg of String(text || '').split(/[。；;\n]/)) {
      if (!CLAIM_RE.test(seg)) continue;
      for (const m of seg.matchAll(FILE_RE)) claimed.push(m[1]);
    }
    for (const c of uniq(claimed)) {
      if (digests.some(d => d && (d.path === c || String(d.path || '').endsWith('/' + c)))) continue;
      hard.push(`正文说已经写入 ${c}，但工作目录里找不到这个文件`);
    }
    return { hard: uniq(hard), soft: uniq(soft) };
  }

  function uniq(list) {
    const seen = new Set();
    const out = [];
    for (const x of list) {
      const k = String(x || '').trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    return out;
  }

  /* ── 验收人的 system prompt：同一个模板，只换「验的是整件事还是一个节点」 ── */
  function systemPrompt(opt) {
    const o = opt || {};
    const isNode = o.kind === 'node';
    const who = o.workerName ? `交付它的是「${o.workerName}」` : '交付人';
    return [
      `你是这个${isNode ? '项目节点' : '任务'}的验收人。${who}。你只判一件事：这份东西能不能被下游（或者老板）直接拿去用。`,
      '',
      '给你的文件内容是程序从磁盘上真实读出来的，不是交付人的转述。交付人自己说「已完成」「已经写好了」，一律不作为证据——你只认磁盘上的东西。',
      '',
      '五个维度，各按下面写死的行为判档次（4 优秀 / 3 良好 / 2 及格 / 1 不及格），不要按文笔判：',
      ...RUBRIC,
      '',
      '硬性要求：',
      '· 不许夸，不许替交付人重写，只指问题。',
      '· 每条 why 必须是一句具体的话（作者照着就能补），禁止「不够深入」「可以更完善」这类空话。',
      '· 只有真正阻断下游使用的问题才写进 gaps，最多 2 条。',
      '· 程序已经报出来的硬问题（下面会列出来）不要重复写，也不要试图反驳它。',
      '· 只输出 JSON，不要解释、不要代码围栏、不要前后缀。',
      '· 第一个字符必须是 {，在此之前不要写任何分析、权衡、复述任务的文字。不要在心里反复推敲要不要输出 JSON——直接输出。',
      '',
      '输出格式：',
      '{"dims":[{"k":"goal","s":4,"why":""},{"k":"deliver","s":4,"why":""},{"k":"fact","s":"pass","why":""},{"k":"consist","s":4,"why":""},{"k":"brevity","s":3,"why":""}],"gaps":[]}'
    ].join('\n');
  }

  /* ── 验收人的 user prompt：事实摆前面，自述摆后面（自述只当线索，不当证据） ── */
  function userPrompt(opt) {
    const o = opt || {};
    const digests = Array.isArray(o.digests) ? o.digests : [];
    const isNode = o.kind === 'node';
    const parts = [];

    parts.push(`【要办的${isNode ? '这一节点' : '事'}】\n${String(o.goal || '（没写）').slice(0, 1200)}`);
    parts.push(o.accept
      ? `【事先写明的验收标准】\n${String(o.accept).slice(0, 600)}`
      : '【事先写明的验收标准】（没写——就按「要办的事」里能被检验的部分判）');
    if (o.prevText) parts.push(`【前文已经成立的结论】\n${String(o.prevText).slice(0, 800)}`);

    parts.push(`【磁盘上真实存在的东西】\n${digests.length
      ? digests.map(d => digestLine(d)).join('\n\n')
      : '（这次没有任何文件产出）'}`);

    parts.push(`【交付人最后说的】\n${String(o.text || '（没有正文）').slice(0, 1400)}`);

    const prog = (o.prog && o.prog.hard && o.prog.hard.length)
      ? `【程序查出来的硬问题】\n${o.prog.hard.map(x => '· ' + x).join('\n')}`
      : '【程序查出来的硬问题】（没有）';
    parts.push(prog);

    return parts.join('\n\n');
  }

  function digestLine(d) {
    if (!d) return '';
    const head = [
      `· ${d.path}（${kb(d.size)}，${d.chars != null ? d.chars + ' 字' : '未统计'}）`,
      d.structure ? `  结构：${d.structure}` : '',
      d.head ? `  开头：${String(d.head).replace(/\s+/g, ' ').slice(0, 700)}` : ''
    ].filter(Boolean);
    return head.join('\n');
  }
  function kb(n) {
    const v = Number(n) || 0;
    return v > 1024 ? (v / 1024).toFixed(1) + 'KB' : v + 'B';
  }

  /* ── 解析：宽容。模型可能给 JSON，也可能给旧格式（{pass,gaps} / {checks:[...]}） ── */
  function parse(raw) {
    const obj = extractJSON(raw);
    if (!obj) return null;

    const dims = {};
    let factPass = null;
    const gaps = [];

    if (Array.isArray(obj.dims)) {
      for (const d of obj.dims) {
        if (!d) continue;
        const k = String(d.k || d.key || d.name || '').trim();
        if (!DIM[k]) continue;
        if (k === 'fact') {
          const v = d.s != null ? d.s : d.pass;
          factPass = truthyPass(v);
          dims[k] = { k, s: factPass ? 4 : 1, why: clip(d.why) };
        } else {
          dims[k] = { k, s: grade(d.s), why: clip(d.why) };
        }
      }
    }

    /* 旧格式兼容：项目线原来只回 pass + gaps；新的验收人 prompt 之外的东西也认 */
    if (!Object.keys(dims).length && obj.pass !== undefined) {
      const ok = !!obj.pass;
      dims.goal = { k: 'goal', s: ok ? 4 : 2, why: '' };
      dims.deliver = { k: 'deliver', s: ok ? 4 : 2, why: '' };
      /* 老格式的 pass=false 是「整体不行」，不能说成编造数字——不认领一票否决 */
      factPass = true;
      dims.fact = { k: 'fact', s: 4, why: '' };
    }
    if (Array.isArray(obj.checks) && !Object.keys(dims).length) {
      const bad = obj.checks.filter(c => c && c.pass === false);
      dims.goal = { k: 'goal', s: bad.length ? 2 : 4, why: '' };
      dims.deliver = { k: 'deliver', s: bad.length ? 2 : 4, why: '' };
      factPass = true;
      for (const b of bad) for (const g of (Array.isArray(b.gaps) ? b.gaps : [])) gaps.push(clip(g));
    }

    for (const g of (Array.isArray(obj.gaps) ? obj.gaps : [])) {
      const t = clip(g);
      if (t) gaps.push(t);
    }
    if (!Object.keys(dims).length) return null;
    return { dims, factPass, gaps: uniq(gaps).slice(0, 3) };
  }

  function truthyPass(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v >= 3;
    const s = String(v || '').trim().toLowerCase();
    return !(s === 'fail' || s === 'false' || s === 'no' || s === '不通过' || s === '不可');
  }
  function grade(v) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.max(1, Math.min(4, Math.round(n)));
    const s = String(v || '').trim();
    if (/优秀|excellent|^4/.test(s)) return 4;
    if (/良好|good|^3/.test(s)) return 3;
    if (/及格|fair|^2/.test(s)) return 2;
    if (/不及格|差|poor|^1/.test(s)) return 1;
    return 3; // 说不清就按「良好」，不因为格式问题冤枉人
  }
  function clip(x) {
    return String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, 160);
  }

  function extractJSON(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      const body = s.slice(a, b + 1);
      try { return JSON.parse(body); } catch { /* 继续 */ }
      try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch { /* 继续 */ }
    }
    for (const line of s.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch { /* 继续 */ }
    }
    return null;
  }

  /* ── 合并判定：程序 > 一票否决 > 必要项 > 加权分 ── */
  function decide(opt) {
    const o = opt || {};
    const prog = o.prog || { hard: [], soft: [] };
    const hard = Array.isArray(prog.hard) ? prog.hard : [];
    const soft = Array.isArray(prog.soft) ? prog.soft : [];
    const m = o.model || null;
    const judge = o.judge || { id: '', name: '', level: 'none' };
    const base = {
      judgeModel: judge.id || '',
      judgeName: judge.name || judge.id || '',
      workerModel: o.workerModel || '',
      independent: judge.level === 'full' ? true : judge.level === 'weak' ? 'weak' : false,
      independence: judge.level || 'none',
      at: Date.now(),
      kind: o.kind || 'task'
    };

    /* 1) 程序说不行就是不行，模型怎么夸都不算（书 7.4.2） */
    if (hard.length) {
      return {
        ...base, verdict: 'fail', pass: false, score: 0, veto: true, source: 'program',
        dims: [], gaps: uniq([...hard, ...soft]).slice(0, 3),
        note: '程序判定：交付物没过硬性检查，没有送模型复核'
      };
    }
    /* 2) 模型没给出可解析的结论：不能算通过，也不能判死刑。
       这里要把「为什么」说准：是思考吃光了额度，还是结论被截断，
       还是它答非所问。原来一律写「没给出可解析的结论」，看不出该换模型还是该重试。 */
    if (!m) {
      const why = String(o.failReason || '验收人没返回结构化结论').replace(/[。；]+$/, '');
      return {
        ...base, verdict: 'weak', pass: false, score: 0, veto: false, source: 'program',
        dims: [],
        gaps: uniq([...soft, `这份交付实际上没被验过（不等于不合格）：${why}。可以点「继续跑」重验一次`]).slice(0, 3),
        note: why
      };
    }

    const dims = DIMS.map(d => m.dims[d.k]).filter(Boolean);
    const get = k => m.dims[k];
    const gaps = uniq([...soft, ...(m.gaps || [])]).slice(0, 3);

    /* 3) 一票否决：编造具体数字 */
    if (m.factPass === false) {
      return {
        ...base, verdict: 'fail', pass: false, score: 0, veto: true, source: 'model',
        dims: dims.map(x => ({ k: x.k, name: (DIM[x.k] || {}).name || x.k, w: (DIM[x.k] || {}).w, s: x.s, why: x.why })),
        gaps: gaps.length ? gaps : ['有具体数字既没写来源也没写口径'],
        note: '事实可溯一项触发一票否决'
      };
    }

    /* 4) 必要项兜底：1 分直接不过，2 分算有缺口 */
    const ess = ['goal', 'deliver'].map(k => get(k)).filter(Boolean);
    const minEss = ess.length ? Math.min(...ess.map(x => x.s)) : 4;

    /* 5) 加权分：brevity 权重最低，只用来拉分不影响主判定 */
    let sum = 0, wsum = 0;
    for (const d of dims) {
      const w = (DIM[d.k] || {}).weight || 0;
      if (!w) continue;
      sum += w * d.s;
      wsum += w;
    }
    const score = wsum ? Math.round((sum / wsum) * 10) / 10 : 4;

    let verdict = 'pass';
    /* 2 分是「及格」——全项及格算能用但有缺口，不是不能用 */
    if (minEss <= 1 || score < 2.0) verdict = 'fail';
    else if (minEss === 2 || score < 2.8) verdict = 'weak';

    /* 只有 optional 维度差，不算缺口——否则「略啰嗦」会把好活判成没过 */
    if (verdict === 'weak' && !gaps.length) {
      const onlyOptional = dims.filter(d => d.s < 3).every(d => (DIM[d.k] || {}).w === 'optional');
      if (onlyOptional) verdict = 'pass';
    }

    return {
      ...base, verdict, pass: verdict === 'pass', score, veto: false, source: 'model',
      dims: dims.map(x => ({ k: x.k, name: (DIM[x.k] || {}).name || x.k, w: (DIM[x.k] || {}).w, s: x.s, why: x.why })),
      gaps: verdict === 'pass' ? gaps.slice(0, 1) : gaps,
      note: verdict === 'pass' ? '可用' : (verdict === 'weak' ? '能用但下游要补' : '不能直接拿去用')
    };
  }

  /* 统一状态口径：两边都只有这两个结果，项目线原来就是这么用的 */
  function statusOf(v) {
    return v && v.verdict === 'pass' ? 'done' : 'weak';
  }

  function summary(v) {
    if (!v) return '';
    if (v.verdict === 'pass') return '验收通过';
    if (v.verdict === 'weak') return '验收有缺口';
    return '验收没过';
  }

  /* 给 UI 的一行「谁验的、算不算独立」 */
  function whoLine(v) {
    if (!v) return '';
    const name = v.judgeName || v.judgeModel || '验收人';
    if (v.independence === 'full') return `${name} 独立验收（与执行的不是同一个模型）`;
    if (v.independence === 'weak') return `${name} 验收（同家族模型，独立性打折）`;
    return `${name} 验收（与执行同模型，结论仅供参考）`;
  }

  return {
    DIMS, DIM, RUBRIC,
    pick, candidates, isThinking, gate, systemPrompt, userPrompt, parse, decide,
    statusOf, summary, whoLine, famOf,
    /* 测试用 */
    _extractJSON: extractJSON, _grade: grade
  };
});
