/* ── Task Contract：把散落的口径收拢成一份契约 ────────────────────────────
 *
 * 技术文档 4.1 要求「每个分配给员工的子任务必须具有 Task Contract」，
 * 字段是 goal / inputs / deliverables / acceptance_criteria / scope /
 * dependencies / constraints / risk_level / tool_permissions / budget。
 *
 * 改造之前我们的字段是散的，而且有一个真缺口：
 *   task.accept（验收口径）在 agent.js 里被读，但 app.js 从来没写过它，
 *   所以验收人拿到的一直是 undefined —— 它只能按「看起来像不像做完了」判，
 *   这正是文档禁止的「凭自述判定」。
 *
 * 这个文件做三件事：
 *   1. build(): 从任务现状推导出一份完整契约（缺的补默认，不猜格式）
 *   2. check(): 用「产出物真实落盘」做硬证据判定，不看模型怎么说
 *   3. judgeArgs(): 给验收人一套明确口径，而不是一句空话
 */
(function (root) {
  'use strict';

  /* 格式 → 判定用的正则。与 agent.js 的 ART_FORMS 同源，但这里只关心「文件在不在」 */
  const EXT = {
    pptx: { name: 'PPT（.pptx）', re: /\.pptx$/i },
    docx: { name: 'Word（.docx）', re: /\.docx$/i },
    xlsx: { name: 'Excel（.xlsx / .csv）', re: /\.(xlsx?|csv)$/i },
    pdf: { name: 'PDF（.pdf）', re: /\.pdf$/i },
    image: { name: '图片（.png / .jpg）', re: /\.(png|jpe?g|webp)$/i },
    md: { name: 'Markdown（.md）', re: /\.(md|markdown)$/i }
  };

  /* 高风险动作：这些一出现就要抬风险等级，人工看一眼再放行 */
  const RISKY = [
    { re: /(发邮件|群发|发送给|邮件给|外发)/, key: 'mail', why: '会真的把东西发出去' },
    { re: /(删除|清空|移除全部|覆盖原文件)/, key: 'destroy', why: '会动到已有文件' },
    { re: /(付款|转账|下单|采购|支付)/, key: 'money', why: '涉及资金' },
    { re: /(发布|上线|公开)/, key: 'publish', why: '发布后外部可见' }
  ];

  /* ── 1. 生成契约 ─────────────────────────────────────────────────────── */
  function build(task, opts) {
    const o = opts || {};
    const t = task || {};
    const goal = String(t.goal || '').trim();
    const followUp = String(o.followUp || '').trim();
    const text = goal + '\n' + followUp;

    /* 产出物：老板点名的（后缀/名词/动词）优先，其次是他自己填的交付清单 */
    let want = [];
    try {
      if (typeof o.wantArtifacts === 'function') want = o.wantArtifacts(text) || [];
    } catch (e) { want = []; }
    const declared = Array.isArray(t.deliverables) ? t.deliverables.filter(Boolean) : [];
    /* 契约里的产出要求用简化结构，别把 agent 的工具句柄带进去 */
    const deliverables = want.map(w => ({ key: w.key, name: w.name, re: w.re }));

    /* 验收口径：以前是空的。现在必须写死成可判定的句子，验收人才有尺子。 */
    const accept = [];
    if (deliverables.length) {
      accept.push(`这几种文件必须真的存在于工作区：${deliverables.map(d => d.name).join('、')}`);
    }
    if (declared.length) {
      accept.push(`老板点名的交付物要在目录里：${declared.join('、')}`);
    }
    accept.push('不许用 .md 顶替老板点名的其它格式；正文里说明的产出路径必须真实可打开');
    accept.push('结论要能对回老板这句话本身，不是复述过程');

    /* 约束：从目标里抽出来的硬话，加上系统级常识 */
    const constraints = [];
    if (/不要|别|禁止|不能|不许/.test(text)) {
      const m = text.match(/(不要|别|禁止|不能|不许)[^。；\n]{0,30}/g);
      if (m) constraints.push(...m.slice(0, 3).map(s => s.trim()));
    }
    if (t.lang === 'en' || /in english/i.test(text)) constraints.push('按英文输出');

    /* 风险等级：只按「会不会碰到不可逆动作」判，不按篇幅长短判 */
    let risk = 'LOW';
    const riskWhy = [];
    RISKY.forEach(r => {
      if (r.re.test(text)) { risk = 'HIGH'; riskWhy.push(r.why); }
    });
    if (!riskWhy.length && (goal.length > 200 || /(生产|线上|客户|合同|财务)/.test(text))) {
      risk = 'MEDIUM';
      riskWhy.push('涉及对外/生产口径，改错了要返工');
    }

    return {
      v: 1,
      goal,
      inputs: Array.isArray(t.files) ? t.files.slice(0, 20) : [],
      deliverables,
      declared,
      acceptance_criteria: accept,
      /* 允许动哪儿：工作区就是全部能碰的地方；禁的是工作区外 */
      scope: { allow: [o.scope || '工作区'], deny: ['系统目录', '其它任务的工作区'] },
      constraints,
      risk_level: risk,
      risk_why: riskWhy,
      tool_permissions: Object.assign({}, (o.permissions || {})),
      budget: { maxTokens: Number(o.maxTokens) || 0, maxSteps: Number(o.maxSteps) || 0 },
      handoff_format: ['事实', '假设', '产物', '未决项'],
      at: Date.now()
    };
  }

  /* ── 2. 硬证据判定 ────────────────────────────────────────────────────
   * 只认三种证据，不认模型的自述：
   *   ① 产出文件真的在（exists 回调由调用方提供，走工作区真实列目录）
   *   ② 工具调用记录里有写成功的动作（wrote）
   *   ③ 验收人给出的 gaps（它只能「扣分」，不能单独把没落盘的说成落盘）
   */
  function check(contract, ctx) {
    const c = contract || {};
    const x = ctx || {};
    const wrote = (Array.isArray(x.wrote) ? x.wrote : []).map(String);
    const exists = typeof x.exists === 'function' ? x.exists : null;
    const missing = [];
    const details = [];

    (c.deliverables || []).forEach(d => {
      const hit = wrote.filter(p => d.re && d.re.test(p));
      let ok = hit.length > 0;
      /* 记录里有还不够：文件被移走/没写成也算没交付 */
      if (ok && exists) {
        const alive = hit.some(p => {
          try { return !!exists(p); } catch (e) { return true; }
        });
        if (!alive) { ok = false; }
      }
      details.push({ key: d.key, name: d.name, ok, paths: hit });
      if (!ok) missing.push(d.name);
    });

    (c.declared || []).forEach(p => {
      const s = String(p);
      const hit = wrote.some(w => w.indexOf(s) >= 0 || s.indexOf(w) >= 0);
      let ok = hit;
      if (ok && exists) {
        try { ok = !!exists(s); } catch (e) { ok = hit; }
      }
      if (!ok) missing.push(s);
    });

    return {
      checked: !!(c.deliverables || []).length || !!(c.declared || []).length,
      pass: missing.length === 0,
      missing,
      details,
      /* 判定依据要能说清楚：这是给老板看的，不是给日志看的 */
      basis: (c.deliverables || []).length
        ? `按契约核了 ${(c.deliverables || []).length} 类产出物是否真实落盘`
        : '老板没点名格式，只核正文结论'
    };
  }

  /* ── 3. 给验收人的口径 ────────────────────────────────────────────────
   * 验收人（judge.js）以前拿不到口径，只能靠感觉。现在把契约摊给它，
   * 并且明确：产出物缺失它不许判通过。
   */
  function judgeArgs(contract, extra) {
    const c = contract || {};
    const e = extra || {};
    return Object.assign({
      accept: (c.acceptance_criteria || []).join('；'),
      constraints: (c.constraints || []).join('；'),
      deliverables: (c.deliverables || []).map(d => d.name),
      risk: c.risk_level || 'LOW',
      hardMissing: Array.isArray(e.hardMissing) ? e.hardMissing : []
    }, extra || {});
  }

  /* 任务对象上挂一份（幂等：同一份契约不重复生成，除非目标变了） */
  function attach(task, opts) {
    if (!task) return null;
    const prev = task.contract;
    const goal = String(task.goal || '');
    if (prev && prev.goal === goal && prev.v === 1) return prev;
    const c = build(task, opts);
    task.contract = c;
    return c;
  }

  const CONTRACT = { build, check, judgeArgs, attach, EXT, RISKY };
  root.CONTRACT = CONTRACT;
  if (typeof module !== 'undefined' && module.exports) module.exports = CONTRACT;
})(typeof window !== 'undefined' ? window : globalThis);
