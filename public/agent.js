/* Agent 循环：模型调用走云端 LLM 通道（浏览器直连、免 Key），
   工具执行打回本地/容器里的 /api/tool。一次任务 = 模型想 → 工具做 → 程序校验 → 再想。 */
(function () {
  const PERSONAS = {
    rigor:  { n: '严谨', d: '先给结论与依据，再谈建议，不用形容词', ex: '该条款违约金按日 3% 计算，折年化超 1000%，超出司法实践可支持范围。建议改为总额 20% 封顶。' },
    calm:   { n: '沉稳', d: '克制、给依据、留余地',             ex: '这一项我建议再核一遍。按现行准则，违约金上限通常按实际损失 130% 认定，3% 日息明显偏高。' },
    sharp:  { n: '锋利', d: '直指要害，敢否定方案',             ex: '这个签不了。日 3% 违约金，等于给对方一个随时引爆的雷。换成 20% 封顶，今天就能定。' },
    youth:  { n: '青春', d: '口语化，敢用语气词',               ex: '老板这条有点猛啊，一天赔 3% 顶不住 😅 建议砍到 20% 封顶，我去改？' },
    warm:   { n: '温和', d: '先照顾情绪再讲问题',               ex: '理解对方希望有强约束。不过按日 3% 这个量级，真出问题时我们压力会很大，要不要换个更稳的写法？' },
    mature: { n: '成熟', d: '稳重、有分寸、先讲影响面',         ex: '这条的影响面比看上去大：一旦触发，金额会随时间线性放大。建议先封顶，再谈触发条件。' }
  };

  let TOOLS = null;
  let CATS = null;

  /* ── 评测计量 ──
   * 评测台要回答「新模型更快还是更慢、思考变多还是变少」，光有总 token 不够。
   * 这里把每次模型调用的首 token 延迟、推理 token、缓存命中都记下来，收工挂到 task.metrics。
   * 用模块级对象而不是逐层返回：compactContext / 隔离执行也会调用模型，
   * 它们的开销本来就属于这个任务，一起进账才不会少算。 */
  let METER = null;
  function meterNew() {
    return { calls: 0, ms: 0, ttft: [], ttftContent: [], reasoning: 0, cached: 0, in: 0, out: 0, served: '', models: [] };
  }
  function meterNote(m) {
    if (!METER || !m) return;
    METER.calls++;
    METER.ms += Number(m.ms) || 0;
    METER.in += Number(m.in) || 0;
    METER.out += Number(m.out) || 0;
    METER.reasoning += Number(m.reasoning) || 0;
    METER.cached += Number(m.cached) || 0;
    if (m.ttft > 0) METER.ttft.push(m.ttft);
    if (m.ttftContent > 0) METER.ttftContent.push(m.ttftContent);
    if (m.served && !METER.served) METER.served = m.served;
    if (m.model && METER.models.indexOf(m.model) < 0) METER.models.push(m.model);
  }
  const pctOf = (arr, p) => {
    if (!arr || !arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return s[i];
  };

  async   function loadTools() {
    if (!TOOLS) {
      const r = await fetch(window.withSC('/api/tooldefs'));
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '工具清单加载失败');
      TOOLS = j.tools;
      CATS = j.categories;
    }
    /* 老板自定义的 HTTP 工具并进清单（不算缓存，改了设置下次调用就生效） */
    const customs = (window.CUSTOM_TOOLS || []).filter(t => t && t.name && t.url);
    if (!customs.length) return { tools: TOOLS, cats: CATS };
    const tools = TOOLS.slice();
    const cats = { ...CATS };
    for (const t of customs) {
      if (tools.some(x => x.function && x.function.name === t.name)) continue;
      tools.push({
        type: 'function',
        function: {
          name: t.name,
          description: String(t.description || '自定义工具'),
          parameters: t.parameters && typeof t.parameters === 'object'
            ? t.parameters : { type: 'object', properties: {} }
        }
      });
      cats[t.name] = 'net';
    }
    return { tools, cats };
  }

  /* ── 记忆 ──
   * 记忆只从两个地方来：老板手写的公司档案，和员工自己在收工时写下的【记忆】块。
   * 程序不替模型总结——总结出来的东西最容易变成一本正经的错话。 */
  async function briefOf(scope, staff, query, project) {
    try {
      const q = new URLSearchParams({
        scope, id: String(staff.id || staff.key || ''),
        name: staff.name || '', q: String(query || '').slice(0, 200),
        pj: String((project && project.id) || ''),
        pjn: String((project && project.title) || '')
      });
      const r = await fetch(window.withSC('/api/memory/brief?' + q.toString()));
      const j = await r.json();
      return j && j.ok ? String(j.brief || '') : '';
    } catch { return ''; }
  }

  /* 员工自己写的记忆先进「待采纳」，老板在记忆面板点一下才真正生效；
     没采纳的候选不参与召回，避免一次跑偏的经验长期影响判断。 */
  async function saveMemo(scope, staff, items, src, srcId) {
    const none = { added: 0, merged: 0, superseded: 0, rejected: [] };
    if (!items || !items.length) return none;
    try {
      const r = await fetch(window.withSC('/api/memory'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope, kind: 'staff', id: String(staff.id || staff.key || ''),
          add: items, src: String(src || '').slice(0, 60),
          srcId: String(srcId || '').slice(0, 60), candidate: true
        })
      });
      const j = await r.json();
      if (!j || !j.ok) return none;
      return {
        added: j.added || 0, merged: j.merged || 0,
        superseded: j.superseded || 0, rejected: j.rejected || []
      };
    } catch { return none; }
  }

  /* 项目共享记忆：写进项目而不是个人，项目里谁干活谁都能召回 */
  async function saveProjectMemo(scope, projectId, projectTitle, items, src, srcId) {
    const none = { added: 0, merged: 0, superseded: 0, rejected: [] };
    if (!projectId || !items || !items.length) return none;
    try {
      const r = await fetch(window.withSC('/api/memory'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope, kind: 'project', id: String(projectId),
          title: String(projectTitle || '').slice(0, 40),
          add: items, src: String(src || '').slice(0, 60),
          srcId: String(srcId || '').slice(0, 60), candidate: true
        })
      });
      const j = await r.json();
      if (!j || !j.ok) return none;
      return {
        added: j.added || 0, merged: j.merged || 0,
        superseded: j.superseded || 0, rejected: j.rejected || []
      };
    } catch { return none; }
  }

  /* 从正文里摘出【记忆】【项目记忆】块；这两段是内部记账，不往产出里给老板看 */
  function cutMemoBlock(src, label) {
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
      if (t.length >= 4 && !/^(无|没有|无新增|暂无|略|none)$/i.test(t)) items.push(t);
    }
    const rest = lines.slice(i).join('\n');
    return { items, body: (head + (rest.trim().length > 4 ? '\n' + rest : '')).trim() };
  }

  function splitMemo(text) {
    let s = String(text || '');
    let projectItems = [];
    const pj = cutMemoBlock(s, '项目记忆');
    if (pj) { s = pj.body; projectItems = pj.items; }
    const mx = cutMemoBlock(s, '记忆');
    if (mx) s = mx.body;
    return {
      body: s.trim(),
      items: (mx ? mx.items : []).slice(0, 4),
      projectItems: projectItems.slice(0, 4)
    };
  }

  /* 常驻 system：每个任务、每一步都要重发一遍，写长一句就是每一步都多付一次钱。
     所以这里只留「不做就会出错」的约束；能靠工具描述说清的，不在这儿重复。
     改动前 1,340 字，现在压到 600 出头。 */
  /* 标准员工库的训练记忆：按 std_id 实时取，不复制到用户自己名下。
     这样后台补一条经验，所有取用过这位员工的人下次开口就吃到，不用谁手动同步。
     取不到就当没有——这是加分项，不能因为一次网络失败把整段系统提示拼空。 */
  async function stdMemBrief(staff) {
    const id = Number(staff && staff.stdId) || 0;
    if (!id || !window.CLOUD || typeof CLOUD.listStdMemOf !== 'function') return '';
    let list = [];
    try { list = await CLOUD.listStdMemOf(id); } catch (e) { return ''; }
    const items = (list || []).filter(x => String((x && x.text) || '').trim());
    if (!items.length) return '';
    const KN = { rule: '规矩', exp: '经验', pref: '偏好', fact: '事实', note: '备注' };
    /* 40 条封顶：system 每一步重发一次，塞满等于每一步都在为它付钱 */
    return ['', '你被训练时留下的记忆（照这里的口径做；和上面的通用做法冲突时，以这里为准）：',
      ...items.slice(0, 40).map((x, i) => `${i + 1}. [${KN[x.kind] || '备注'}] ${String(x.text).trim()}`),
      '记忆里没有的事实不要编；记忆和现状对不上，按现状判断并说明。'].join('\n');
  }

  function buildSystem(staff, task, mem, stdMem) {
    const p = PERSONAS[staff.persona] || PERSONAS.mature;
    /* 性格四维度（性别 / 生肖 / 星座 / MBTI）：填了哪几项就按哪几项说、按哪几项取舍。
       一项没填才回落到老人设，保证老员工的口径不会因为这次改版突然变。 */
    const trait = (window.TRAITS && typeof window.TRAITS.prompt === 'function')
      ? String(window.TRAITS.prompt(staff) || '') : '';
    const style = trait || `说话风格：${p.n} —— ${p.d}。像这样：「${p.ex}」`;
    /* 老板写的愿景（愿景和印象页）：员工按这个方向取舍，没写就不占位 */
    const vis = (window.PROFILE && typeof window.PROFILE.visionLines === 'function')
      ? String(window.PROFILE.visionLines() || '') : '';
    const kb = Array.isArray(staff.kb) && staff.kb.length
      ? ['', '你的专属资料库（只你能用）里跟这次最相关的段落：',
        ...staff.kb.map((k, i) => `【${i + 1}｜${k.title || '资料'}】${k.text}`),
        '以资料为准，资料里没有的就说没有依据。'].join('\n')
      : '';
    const files = (task && Array.isArray(task.files) ? task.files : []);
    const isImgF = f => /^image\//i.test((f && f.mime) || '')
      || /\.(png|jpe?g|webp|gif|bmp)$/i.test(String((f && (f.path || f.name)) || ''));
    const att = files.length
      ? ['', '附件已在工作目录里：',
        ...files.map(f => {
          const sz = f.size ? `，${Math.round(f.size / 1024)}KB` : '';
          return isImgF(f)
            ? `· ${f.path}（图片${sz}）${f.dataUrl ? ' 已随这条消息给你看' : ' 要看就调 view_image'}`
            : `· ${f.path}（${String(f.kind || '').toUpperCase()}${sz}）用 read_doc 读`;
        }),
        '口径以附件为准；没读就别说看过。图片看不清楚或当前模型不支持视觉，就调 view_image（传上面的路径）——绝不许回答「没收到图片」。'].join('\n')
      : '';
    return [
      `你是「${staff.name}」，这家公司的「${staff.role}」。${style}`,
      staff.notes ? `老板期望：${staff.notes}` : '',
      stdMem || '',
      vis,
      kb,
      att,
      mem || '',
      '',
      '工作目录（相对路径，如 报价表/2026-11-W1.md）是你唯一能读写的地方；写出来的文件会自动出现在对话里和老板右侧产出栏，不用你解释怎么打开。',
      '先判断这句话要不要动手：老板只是打招呼、闲聊、问一句事实、确认进度/状态（「你好」「在吗」「刚才那个做完没」），就用一两句话直接回答，说完就完——不拆目标、不调产出工具、不建文件。为了显得干了活而硬造一份文档交上去，是最招人烦的过度交付，比什么都不做更糟。',
      '干活：',
      '1. 真要动手的事，先拆目标（2–5 件必须交付的东西）再干，别先翻目录。',
      '2. 需要外部事实才动工具，自己会写的直接写；同一份文件别反复读。',
      '3. 一步一件事，看到结果再决定下一步；报错换参数重来，不许假装成功。',
      '4. 要产出就真写出来并落盘，只说「我将如何做」等于没做。',
      '5. 要 Word：正文用 Markdown 写在回答里（# 标题、## 小节、- 要点、| 表格），再调 make_doc 只给 path 和 title，正文系统会取你刚写的那段。',
      '6. 会变的数字（价格/税率/政策/竞品）先查再说，结论标来源；查不到就写「没查到公开数据」。',
      '7. 涉及资金、证件、对外发送，只给方案不动手。',
      '8. 缺关键决策就别猜：技术选型、品牌名/主色、页面范围、价格口径这类定错要返工的事，开工前先调 ask_boss 一次问完——每题给 2–4 个候选选项，没有合理候选就留空让老板自己填；老板确认后你会拿到答案继续。不要用纯文本列一堆问题然后停下：那种问法老板没法点选，等于白问。',
      '9. 产出物格式先看老板点名：说 PPT / 幻灯片 / .pptx → make_deck；说 Word / 文档 / .docx → make_doc；说 Excel / 表格 / .xlsx → make_sheet；说图 / 海报 / 效果图 / 设计稿 / .png → gen_image。老板点名什么就给什么，不许自作主张换一种格式。',
      '10. 老板没点格式时，按他的动词判断：画 / 绘制 / 出图 / 做张图 → 图片（gen_image）；写 / 撰写 / 起草 / 写一份 → Word（make_doc）；做演示 / 汇报 / 提案 → PPT（make_deck）；统计 / 列个表 / 汇总成表 → Excel（make_sheet）。',
      '11. 不许用 md 兜底：老板没说要 md，就别拿 write_file 写一份 .md 当交付。md 只当自己记的中间稿，不算产出物，也不要出现在「产出文件」里。',
      '12. 格式真判断不了（比如「帮我弄个客户回访的东西」）就先调 ask_boss 问「这份东西要做成哪种」：给 Word / PPT / Excel / 图片 四个选项，别猜，也别先做一份 md。',
      '13. PDF 目前做不了：老板要 PDF 时，用 ask_boss 说明只能出 Word / PPT / Excel / 图片，问他要哪种；不要拿 md 或 txt 顶替。',
      '14. 老板要图 / 效果图 / 设计稿 / 主视觉：调 gen_image 出图，它一定能出——AI 通道排队时会由本地插画引擎画一张设计稿。不要因为「没有实拍渲染通道」「担心带水印」就跳过出图；先出图，再在正文说清这是设计稿/示意图，实拍请走 3D 渲染，这才是可交付的做法。',
      '收工前自检：这次该做的事都落地了吗？真有产出要求的话，产出在哪？没解决的列出来。要交付的任务，停下来的条件是「目标被满足、产出已落盘」，不是「我说完了」；一开始就不需要产出的问候和问答，答完就是收工，不要为了凑一条「已落盘」去造文件。',
      '自检结论写在回答里就行，不要额外写「验收报告 / 验收.json / 自检清单」这类文件——验收由系统独立做，老板要的是成品，多出来的质检单是噪音。',
      '这一轮确认了值得长期留下的事实（客户口径、真实报价、老板偏好与禁区），在最后单起一行写 `【记忆】`，下面最多 3 条、每条 `- ` 开头、60 字以内；推翻旧说法就写成 `- 更正：新说法`；没有就留空。这段不给老板看。密码、密钥、证件号一律不写。'
    ].filter(Boolean).join('\n');
  }

  /* 带图片的 user 消息；模型看不了图时会退化。
     图片的路径一定写进正文：视觉通道一旦不可用（模型不支持 / 上下文被压缩），
     模型至少还知道「有这张图、路径是什么」，能自己调 view_image 去补，
     而不是回一句「我没有收到图片」——那句话在老板看来就是系统坏了。 */
  function userContent(text, files) {
    const list = (files || []).filter(x => x && (x.dataUrl || x.path));
    const isImg = x => /^image\//i.test((x && x.mime) || '')
      || /\.(png|jpe?g|webp|gif|bmp)$/i.test(String((x && (x.path || x.name)) || ''));
    const imgs = list.filter(isImg);
    const docs = list.filter(x => !isImg(x) && x.path);
    const withData = imgs.filter(x => x.dataUrl).slice(0, 6);
    let body = String(text == null ? '' : text);
    if (imgs.length) {
      body += `\n\n【老板发了 ${imgs.length} 张图片，已存在工作区】\n`
        + imgs.filter(x => x.path).map(x => '- ' + x.path).join('\n')
        + '\n能直接看就照图做；看成不了（或需要更细的结构/文字）就调 view_image 传路径。';
    }
    if (docs.length) {
      body += `\n\n【附件文件（要内容就 read_doc 读）】\n` + docs.map(x => '- ' + x.path).join('\n');
    }
    if (!withData.length) return body;
    return [
      { type: 'text', text: body },
      ...withData.map(im => ({ type: 'image_url', image_url: { url: im.dataUrl } }))
    ];
  }

  function hasImages(messages) {
    return messages.some(m => Array.isArray(m.content));
  }

  /* 模型不支持视觉时，把图片从上下文里摘掉，别让整个任务卡死。
     摘掉 base64 不等于「图不存在」：路径还留在正文里，模型可以调 view_image 看。 */
  function dropImages(messages) {
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      const txt = m.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
      m.content = `${txt}\n\n【当前模型看不了图片，图上内容不在上下文里。要照图做，就按上面列出的路径调 view_image 让它描述图片，不要回答“没收到图片”。】`;
    }
  }

  /* 存云之前把 base64 图片摘掉：上下文要能续跑，但不能把几 MB 的图塞进数据库 */
  function leanMessages(list) {
    return list.map(m => {
      if (!Array.isArray(m.content)) return m;
      const txt = m.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
      const n = m.content.filter(c => c && c.type === 'image_url').length;
      return { ...m, content: `${txt}${n ? `\n（另有 ${n} 张图片，出于体积考虑不再随上下文重放）` : ''}` };
    });
  }

  /* 模型通道偶发 500 / 超时 / 限流：这种不该判定任务失败，等一下就过去。
     实测（2026-10-30）云端模型 500 一次，整个任务直接被标 failed，太脆。 */
  /* ── 拦截页识别与净化（标准化防线）──
     事故：任务上下文里带了整段生成的 HTML/代码，发给模型网关时被前面的 WAF 误判成
     攻击，回了一个 403 拦截页；错误信息把整页 HTML 原样带回来，直接糊进了对话气泡。
     规矩：任何错误文本进界面前必须过 sanitizeErrText；识别出是拦截页就给修复指引，
     并在 callWithRetry 里自动精简上下文重试一次。 */
  const WAF_RE = /WAF拦截|Web应用防护|WAF 防护|block-pages|您的请求可能为|请求已被拦截|请求被中断|拦截页面|security.?policy|.access denied.|captcha/i;
  function looksLikeBlockPage(s) {
    const t = String(s || '');
    if (!WAF_RE.test(t)) return false;
    return /<html|<!doctype|<head|<body/i.test(t) || t.length > 800;
  }
  function stripErrHtml(s) {
    return String(s || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]{1,300}>/g, ' ')
      .replace(/&[a-z#0-9]{1,8};/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
  function sanitizeErrText(s) {
    const t = String(s || '');
    if (looksLikeBlockPage(t)) {
      return '请求被安全网关（WAF）拦下了：这一轮对话里带着整段生成的网页代码，被误判成了攻击内容。点「继续跑」我会用精简过的上下文重试；或者让员工先把代码落盘、别在对话里贴全文。';
    }
    const clean = stripErrHtml(t);
    return clean.length > 400 ? clean.slice(0, 400) + '…（错误详情已截断）' : clean;
  }
  /* WAF 误判的自救：只保留最近 2 条原文，更早的一律砍到头 160 字——
     实测尾部第 3 条里也常躺着整段生成的 HTML，留它等于白精简 */
  function leanForWaf(messages) {
    const arr = Array.isArray(messages) ? messages : [];
    const n = arr.length;
    return arr.map((m, idx) => {
      if (!m || m.role === 'system' || idx >= n - 2) return m;
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (c.length <= 160) return m;
      return { ...m, content: c.slice(0, 160).replace(/[\s\S]{0,60}<[\s\S]*$/, '') + ' …[旧内容已精简以通过安全网关]' };
    });
  }

  function isTransient(e) {
    const msg = String((e && e.message) || '') + ' ' + String((e && e.code) || '');
    if (/401|403|invalid.*key|unauthorized|quota|balance|insufficient|402/i.test(msg)) return false;
    return /\b(429|500|502|503|504)\b|timeout|timed out|unavailable|overload|rate.?limit|ECONNRESET|network|fetch failed/i.test(msg);
  }

  async function callWithRetry(args, emit) {
    /* 自愈：通道抖动（429/5xx/超时）自动退避重试，最多 3 次。
       实测 500 一次就把整个任务标 failed 太脆，绝大多数抖动等一下就过去。
       另有一类「WAF 误判」：上下文里带着整段代码/HTML 被网关当成攻击拒掉。
       重试本身没用，得把老消息精简掉再试一次——代码落盘的任务最容易被这么误伤。 */
    let last = null;
    for (let i = 0; i < 3; i++) {
      try {
        return await chatSafe(args);
      } catch (e) {
        last = e;
        if (i === 0 && looksLikeBlockPage(String((e && e.message) || ''))) {
          const before = (args.messages || []).length;
          const leaned = leanForWaf(args.messages);
          if (JSON.stringify(leaned).length < JSON.stringify(args.messages || []).length || leaned.length !== before) {
            args.messages = leaned;
            if (emit) emit({ t: 'notice', message: '这一轮被安全网关误判（上下文里带了整段代码/网页），已自动精简旧内容重试' });
            continue;
          }
        }
        if (!isTransient(e)) throw e;
        if (i === 2) break;
        if (emit) emit({ t: 'notice', message: `模型通道抖了一下，正在重试（${i + 2}/3）…` });
        await new Promise(r => setTimeout(r, 1600 * (i + 1)));
      }
    }
    throw last;
  }

  /* ── 中途插话：任务跑着的时候老板随时能改方向，下一次模型调用就带上 ── */
  const injectQ = [];
  function inject(text, images) {
    const t = String(text || '').trim();
    /* 截图也能插：图片走视觉通道随插话一起进上下文，别再卡在输入框上 */
    const imgs = (images || []).filter(x => x && x.dataUrl).slice(0, 6);
    if (t || imgs.length) injectQ.push({ text: t, images: imgs });
    return t;
  }

  /* ── 敏感操作审批：老板开了「先问一下」后，写盘/跑命令前挂起等放行 ── */
  const approvals = new Map();
  function approve(id, ok) {
    const w = approvals.get(id);
    if (w) { approvals.delete(id); w.resolve(!!ok); }
  }
  function waitApproval(id, signal) {
    return new Promise(resolve => {
      const w = { resolve };
      approvals.set(id, w);
      if (signal) {
        signal.addEventListener('abort', () => {
          if (approvals.has(id)) { approvals.delete(id); resolve(false); }
        }, { once: true });
      }
    });
  }

  async function chatSafe(args) {
    try {
      return await chatOnce(args);
    } catch (e) {
      const msg = String((e && e.message) || (e && e.error && e.error.message) || '');
      if (!hasImages(args.messages)) throw e;
      /* 只认英文关键词会漏：通道报错有时是「不支持图片输入」这种中文，
         那时降级不触发，整个任务直接失败——而失败原因看起来跟图毫无关系。
         带图的请求收到 400/413/422 本身就足够可疑了（体积、格式、模型不收图），
         降级重试一次几乎不会有副作用：摘掉图而已，路径还留在正文里。 */
      const st = Number((e && (e.status || (e.error && e.error.status))) || 0);
      const looksImagey = /image|vision|multimodal|unsupported|invalid.*content|content.*invalid|图片|多模态|不支持/i.test(msg);
      if (!looksImagey && st !== 400 && st !== 413 && st !== 422) throw e;
      dropImages(args.messages);
      if (args.onDropImages) args.onDropImages();
      return chatOnce(args);
    }
  }

  function parseArgs(raw) {
    if (!raw) return { ok: true, args: {} };
    try { return { ok: true, args: JSON.parse(raw) }; }
    catch { return { ok: false, args: {} }; }
  }

  /* 工具参数是流式吐出来的：一边生成一边就能知道「在写哪份文件、写了多少」
     以前这段是纯黑箱——模型闷头生成 30 秒参数，界面一动不动，看着像卡死。 */
  function argChars(raw) {
    const m = String(raw || '').match(/[\u4e00-\u9fa5A-Za-z0-9]/g);
    return m ? m.length : 0;
  }
  function argPath(raw) {
    const m = /"(?:path|file)"\s*:\s*"((?:[^"\\]|\\.){0,80})/.exec(String(raw || ''));
    if (!m) return '';
    return m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, '\\');
  }

  /* ── 工具按需下发 ──
   * 14 个工具全量塞给模型是 7.4KB schema，每步都要重发一遍，光工具定义就两千多 token。
   * 但一个具体任务真正用得上的通常只有五六个：写日报不需要 make_deck，做 PPT 不需要 make_sheet。
   * 所以按目标里的关键词挑：核心工具常驻，重工具按需加。挑错了质检台会立刻报出来。 */
  /* edit_file 必须常驻，不能靠 NEED_TOOLS 的正则触发：
     改已有文件的局部时它是 write_file 的替代品，一旦没下发，模型只能整篇重写——
     大文件（app.js 30 万字符）会直接超出输出上限，而且报错是「写出来的内容不对」，
     不是「工具不存在」，排查成本极高。这类「不在白名单就静默消失」的坑踩过一次了。 */
  const CORE_TOOLS = ['list_dir', 'read_file', 'write_file', 'edit_file', 'search_text', 'web_search', 'fetch_url', 'todo_write', 'ask_boss'];
  const NEED_TOOLS = [
    /* 词表按「老板会怎么说」列，不是按「工具叫什么」列：
       老板说「帮我写一份月度复盘」，里面没有「文档」「报告」两个字，但只要动手写，
       他要的就是一份 Word。工具没下发，模型就只会写一段聊天文字交差（2026-11-03 任务 #39）。 */
    { re: /(docx|\bword\b|文档|报告|公文|说明书|合同稿|方案稿|纪要|白皮书|周报|月报|日报|复盘|撰写|起草|写成|整理成文|总结成文|写一份|写一篇|写个|写份|写篇)/i, add: ['make_doc'] },
    { re: /(ppt|幻灯片|演示|汇报|提案|路演|deck|slide)/i, add: ['make_deck'] },
    { re: /(xlsx|excel|表格|报价表|成本表|台账|数据表|对账|报表|清单|统计表|明细)/i, add: ['make_sheet'] },
    /* 「画一个 / 画个 / 画张」是老板最常用的说法，以前只认「画一张」和「图片」，
       结果「画一个马克杯」这个目标下 gen_image 根本没下发——模型手上没有这个工具，
       只能写一篇设计说明交差（2026-11-03 任务 #39）。口语化的量词要全收。 */
    { re: /(图片|插画|配图|海报|封面图|生成图|绘图|画一|画个|画张|画幅|效果图|渲染图|设计稿|主视觉|示意图|图标|\blogo\b|\.(png|jpe?g|webp)\b)/i, add: ['gen_image', 'find_image'] },
    { re: /(命令|脚本|运行|批量|shell|python|node|跑一下)/i, add: ['run_shell'] }
  ];
  let activeGoal = '';
  let activeFiles = 0;
  /* 这一轮到现在为止动过几次手。闲聊判定要用它：
     只看目标是不够的——万一第一轮判成问候、模型却真调了工具，
     第二轮还按「问候」不给工具，就会把一个正在干的活硬按回去。 */
  let activeWorked = 0;

  /* 「你好」「在吗」这种只有寒暄、没有任何诉求的话。
     判定刻意做得极窄：整句必须只剩问候语（后面可以跟标点），多一个字都不算——
     「你好，帮我把报价表改了」绝不会被当成闲聊。
     为什么要单独判：核心工具常驻 9 个，光它们的 schema 就有两千多 token，
     每轮都重发一遍。一次问候为这 9 个工具付钱，是纯浪费。 */
  const GREET_RE = /^(?:你好|您好|hi|hello|嗨|哈喽|在吗|在不在|早上好|早安|早|下午好|晚上好|晚安|谢谢|多谢|感谢|收到|好的|好|ok|okay|嗯+|辛苦了|干得好|不错|厉害)[\s。！!～~,，.？?…]*$/i;
  function isPureGreeting(g) {
    const s = String(g || '').trim();
    return s.length > 0 && s.length <= 16 && GREET_RE.test(s);
  }

  function pickTools(tools, goal, hasFiles) {
    const g = String(goal || '');
    const builtin = new Set((TOOLS || []).map(t => t.function.name));
    /* 纯问候一个工具都用不上：连核心工具都不下发。
       模型手上没有工具，就会直接回一句话——这正是要的结果。
       自定义 HTTP 工具保留：那是老板自己配的，不归这里管。
       注意这里不能走下面的 `out.length ? out : tools` 兜底：那个兜底会把
       空结果换回「全量工具」，等于白挑。 */
    if (isPureGreeting(g) && !activeWorked) {
      return (tools || []).filter(t => !builtin.has(t.function.name));
    }
    const keep = new Set(CORE_TOOLS);
    for (const r of NEED_TOOLS) if (r.re.test(g)) r.add.forEach(n => keep.add(n));
    /* 带附件才下发读附件的工具：文档给 read_doc，图片给 view_image。
       没附件就不给——每个工具定义都占上下文，而且每一步都要重发一遍。
       图片特别需要 view_image：主模型不一定是多模态的，没这个工具它就只能说「我看不了」。 */
    if (hasFiles || /(附件|上传|图片|截图|照片|设计稿|看图|照着)/i.test(g)) {
      keep.add('read_doc');
      keep.add('view_image');
    }
    /* 老板自己配的 HTTP 工具不在内置清单里，一律保留 */
    const out = tools.filter(t => keep.has(t.function.name) || !builtin.has(t.function.name));
    return out.length ? out : tools;
  }

  /* 一次模型调用：流式收集正文 / 思考 / 工具调用 / 用量 */
  async function chatOnce({ model, messages, signal, onText, onTool, onThink }) {
    const { tools } = await loadTools();
    const payload = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2
    };
    const picked = pickTools(tools || [], activeGoal, activeFiles > 0);
    if (picked && picked.length) {
      payload.tools = picked;
      payload.tool_choice = 'auto';
    }
    if (signal) payload.signal = signal;

    let content = '';
    let reasoning = '';
    let usage = null;
    /* 通道回显的模型名：用来核实「选的是 A、实际跑的是不是 A」 */
    let served = '';
    const calls = new Map();
    let lastPing = 0;
    let lastChars = 0;
    /* 推理流回显的节流游标：模型在「想」的时候正文还是空的，
       以前这段时间界面上什么都不动，只能干等。 */
    let lastThink = 0;
    /* 计时点：用户感知的「反应快慢」是首个 token，不是整轮耗时 */
    const tCall = Date.now();
    let tFirst = 0;
    let tFirstContent = 0;

    for await (const chunk of window.CLOUD.chatStream(payload)) {
      if (!served && chunk && chunk.model) served = String(chunk.model);
      const choice = chunk && chunk.choices && chunk.choices[0];
      const delta = choice && choice.delta;
      if (delta) {
        if (!tFirst) tFirst = Date.now();
        if (delta.content && !tFirstContent) tFirstContent = Date.now();
        if (delta.content) { content += delta.content; if (onText) onText(delta.content); }
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          /* 推理是「分析过程」的一部分，老板要的就是这段时间看见它在想什么。
             节流 140ms：推理 token 比正文密得多，逐字回显会把界面压垮。 */
          if (onThink) {
            const now = Date.now();
            if (now - lastThink > 140) { lastThink = now; try { onThink(reasoning); } catch (e) { /* 界面出错不影响取数 */ } }
          }
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index == null ? 0 : tc.index;
            const cur = calls.get(idx) || { id: '', name: '', arguments: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function && tc.function.name) cur.name = tc.function.name;
            if (tc.function && tc.function.arguments) {
              cur.arguments += tc.function.arguments;
              /* 节流回显：同一毫秒级别的增量没必要每次都重排界面 */
              if (onTool) {
                const now = Date.now();
                const chars = argChars(cur.arguments);
                if (now - lastPing > 150 && chars > lastChars) {
                  lastPing = now; lastChars = chars;
                  try { onTool({ name: cur.name, idx, chars, path: argPath(cur.arguments) }); } catch (e) { /* 界面抛错不影响取数 */ }
                }
              }
            }
            calls.set(idx, cur);
          }
        }
      }
      if (chunk && chunk.usage) usage = chunk.usage;
    }

    const toolCalls = [...calls.values()]
      .filter(c => c.name)
      .map(c => {
        const parsed = parseArgs(c.arguments);
        return {
          id: c.id || 'call_' + Math.random().toString(36).slice(2, 10),
          name: c.name,
          raw: c.arguments,
          args: parsed.args,
          badArgs: !parsed.ok
        };
      });

    const u = usage || {};
    const cdet = u.completion_tokens_details || {};
    const pdet = u.prompt_tokens_details || {};
    /* 推理 token 优先取通道给的明细；通道不给就按思考字符估（中英混排约 1 字 0.6 token） */
    const reasonTok = Number(cdet.reasoning_tokens) || 0;
    const meter = {
      model,
      served: served || model,
      ms: Date.now() - tCall,
      ttft: tFirst ? tFirst - tCall : 0,
      ttftContent: tFirstContent ? tFirstContent - tCall : 0,
      in: Number(u.prompt_tokens) || 0,
      out: Number(u.completion_tokens) || 0,
      reasoning: reasonTok || Math.round(reasoning.length * 0.6),
      cached: Number(pdet.cached_tokens) || 0
    };
    meterNote(meter);

    /* 收尾补一次：节流窗口里最后那几十毫秒的推理不该被吞掉，
       否则界面上看到的「思考」永远比真实进度慢半拍，最后一句还会缺一角 */
    if (reasoning && onThink) { try { onThink(reasoning); } catch (e) { /* 同上 */ } }

    return {
      content, reasoning, toolCalls, servedModel: served, meter,
      usage: {
        in: meter.in,
        out: meter.out,
        credit: u && typeof u.credit === 'number' ? u.credit : null
      }
    };
  }

  /* ── 上下文压缩 ──
   * 问题：工具回包会一直留在 messages 里，每一步都全量重发一遍。一个节点读两份上游
   * 文件（各两万字），五步下来输入就冲到十四万 token——钱是这么烧掉的。
   *
   * 做法（主流两段式，不新造概念）：
   *   1) 折叠：除最近 tailRounds 轮，旧工具回包只留开头 keepHead 字；同一文件被重复读，
   *      只留最后一次。纯字符串处理，不花钱，也不改任何事实。
   *   2) 归纳：折叠后仍超 hardTok，就把最早那一段交给模型写成「前情提要」（目标/关键事实/
   *      已产出/待确认），替换掉原始消息，并落盘到 .ctx/ 备查。这一步花一次小调用，
   *      换回来的是后面每一步都少几万 token。
   * 永远不动 system 和第一条 user（那是任务本身，压掉了就没人知道自己该干什么了）。 */
  const CTX = {
    soft: 5000,        // 超过就先折叠（不花钱，几乎无损）
    hard: 25000,       // 折叠还压不到这个数，才值得花一次调用去归纳
    tailRounds: 1,     // 只看最近一轮的原文（再往前折叠，但数字行都留着）
    keepHead: 900,     // 折叠后每条工具回包留多少字开头
    keepTail: 600,     // 末尾也留一段（结论通常在结尾）
    foldText: 600,     // 旧轮次的模型正文留多少字
    minMsgs: 8,        // 消息太少不做（没得压）
    digestGap: 3,      // 两次归纳之间至少隔几步，别把工作现场压没了
    digestMinLeft: 3   // 剩下不到这么多步就不归纳了（省下的 token 已经用不上）
  };

  /* 粗估 token：汉字按 0.75、其他按 0.26 折算。
   * 不追求准，只要求在「该动手压缩」这个量级上不误判；宁可略微高估。 */
  function estTok(s) {
    s = String(s == null ? '' : s);
    if (!s) return 0;
    let cjk = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x2E80) cjk++;
    return Math.ceil(cjk * 0.75 + (s.length - cjk) * 0.26);
  }

  function msgTok(m) {
    if (!m) return 0;
    let n = 8;
    if (typeof m.content === 'string') n += estTok(m.content);
    else if (Array.isArray(m.content)) {
      for (const c of m.content) n += c && c.type === 'text' ? estTok(c.text) : 900;
    }
    if (m.tool_calls) n += estTok(JSON.stringify(m.tool_calls));
    return n;
  }

  function ctxTok(list) {
    let n = 0;
    for (const m of list) n += msgTok(m);
    return n;
  }

  /* 最近 tailRounds 轮从哪开始：一轮 = 一条带 tool_calls 的 assistant + 它后面的 tool 回包 */
  function tailStart(messages) {
    let seen = 0;
    for (let i = messages.length - 1; i >= 2; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        if (seen >= CTX.tailRounds) return i;
        seen++;
      }
    }
    return 2;
  }

  /* 从一段长文本里挑出「带数字的行」：折叠时这些是不能丢的——
     只留开头、把数字折掉，模型就只能回头重读，省下的 token 又花回去。 */
  function numberLines(text, limit) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
      const t = line.trim();
      if (t.length < 6 || t.length > 160) continue;
      if (!/[0-9０-９]/.test(t)) continue;
      if (/^\d+[.、)]\s*$/.test(t)) continue;         // 纯序号行
      if (out.includes(t)) continue;
      out.push(t);
      if (out.length >= (limit || 12)) break;
    }
    return out;
  }

  function foldOne(content, tag, head) {
    const s = String(content == null ? '' : content);
    if (s.length <= head + CTX.keepTail) return s;
    /* 开头（结构/表头）+ 结尾（结论）+ 中间所有带数字的行，三段合起来基本不会丢事实 */
    const mid = s.slice(head, s.length - CTX.keepTail);
    const nums = numberLines(mid, 10);
    return [
      s.slice(0, head),
      nums.length ? `\n【折叠段里含数字的行（共留 ${nums.length} 行，够了就别重读）】\n` + nums.map(x => '· ' + x).join('\n') : '',
      `\n…【已折叠 ${mid.length} 字｜这是${tag}，真要原文细节就用 read_file 带 offset 读那一段】\n`,
      s.slice(s.length - CTX.keepTail)
    ].filter(Boolean).join('');
  }

  /* 第一段：折叠旧观察。就地改，幂等（打过 _fold 的跳过） */
  function foldObservations(messages) {
    let n = 0;
    const callOf = new Map();
    for (const m of messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) {
          callOf.set(c.id, {
            name: (c.function && c.function.name) || '工具',
            args: (c.function && c.function.arguments) || ''
          });
        }
      }
    }
    const cut = tailStart(messages);
    const readSeen = new Map();   // 同一文件重复读，只留最后一次
    for (let i = 0; i < cut; i++) {
      const m = messages[i];
      if (m._fold) continue;

      if (m.role === 'tool') {
        const c = callOf.get(m.tool_call_id) || {};
        let tag = String(c.name || '工具回包');
        let key = tag + '|' + String(c.args || '');
        try {
          const a = JSON.parse(c.args || '{}');
          if (a.path) { key = tag + '|' + a.path; tag += ' ' + String(a.path); }
          else if (a.query) { key = tag + '|' + a.query; tag += '「' + String(a.query).slice(0, 16) + '」'; }
          else if (a.url) { key = tag + '|' + a.url; tag += ' ' + String(a.url).slice(0, 40); }
        } catch { /* 参数不是 JSON 就按原样标注 */ }

        const total = String(m.content || '').length;
        if (readSeen.has(key) && total > 0) {
          /* 这个文件后面又被读过一次，这一份可以直接丢掉——重复内容不该占两次上下文 */
          m.content = `【重复回包已省略：${tag} 这一步的结果与后面某次读取相同，以那次为准】`;
        } else {
          readSeen.set(key, i);
          m.content = foldOne(m.content, tag, CTX.keepHead);
        }
        m._fold = true;
        n++;
        continue;
      }

      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.length > CTX.foldText) {
        m.content = foldOne(m.content, '我当时的说法', CTX.foldText);
        m._fold = 'text';
        n++;
      }
    }
    /* 上面从前往后扫，重复判定应该以「最后一次出现」为准，所以再走一遍把非最后一次的收掉 */
    const lastAt = new Map();
    for (let i = 0; i < cut; i++) {
      const m = messages[i];
      if (m.role !== 'tool') continue;
      const c = callOf.get(m.tool_call_id) || {};
      let key = String(c.name || '') + '|';
      try { const a = JSON.parse(c.args || '{}'); key = (c.name || '') + '|' + (a.path || a.query || a.url || ''); } catch { /* ignore */ }
      if (!lastAt.has(key)) lastAt.set(key, []);
      lastAt.get(key).push(i);
    }
    for (const [, idxs] of lastAt) {
      if (idxs.length < 2) continue;
      for (const i of idxs.slice(0, -1)) {
        const m = messages[i];
        const c = callOf.get(m.tool_call_id) || {};
        let tag = String(c.name || '工具');
        try { const a = JSON.parse(c.args || '{}'); if (a.path) tag += ' ' + a.path; } catch { /* ignore */ }
        m.content = `【重复回包已省略：${tag} 后来又被读过一次，内容以最后一次为准】`;
      }
    }
    return n;
  }

  /* 第二段：把最早的一段交给模型归纳成前情提要 */
  function digestScript(messages, cut) {
    /* 越靠后越重要：从后往前装，装不下就丢掉更早的 */
    const parts = [];
    for (let i = cut - 1; i >= 2; i--) {
      const m = messages[i];
      let s = '';
      if (m.role === 'user') s = '老板/上游：' + String(m.content || '').slice(0, 1200);
      else if (m.role === 'assistant') {
        const names = Array.isArray(m.tool_calls) ? m.tool_calls.map(c => c.function && c.function.name).filter(Boolean) : [];
        s = names.length ? '我调用了：' + names.join('、') + (m.content ? '\n' + String(m.content).slice(0, 400) : '') : '';
      } else if (m.role === 'tool') s = '结果：' + String(m.content || '').slice(0, 500);
      if (s) parts.push(s);
    }
    let total = 0;
    const keep = [];
    for (const p of parts) {
      if (total + p.length > 22000) break;
      keep.push(p);
      total += p.length;
    }
    return keep.reverse().join('\n\n');
  }

  const DIGEST_SYS = [
    '你是这场工作的记录员。下面是同事前几步的操作流水（工具回包只留了开头）。',
    '把它压成一页「前情提要」，供他自己接着往下干。规则：',
    '1. 只记已经发生的事和已经拿到的数字、口径、路径，不写计划、不写评价、不写建议。',
    '2. 数字必须带口径（谁的数、哪一期、什么单位），拿不准就写「未确认」。',
    '3. 200-400 字，用下面四个小标题，某一项没有就写「无」：',
    '【目标】这次要交付什么',
    '【关键事实】已经确认的口径与数字',
    '【已产出】已写入的文件和路径',
    '【待确认】还没查到、还没定的事',
    '4. 不要出现「他说」「我准备」这类叙述，直接写结论。'
  ].join('\n');

  /**
   * 按预算压缩上下文。返回 { notes, folded, summarized, usage }
   * model/signal 用来做归纳那一次调用；不传就只做折叠。
   */
  async function compactContext(messages, opts) {
    const o = opts || {};
    const before = ctxTok(messages);
    /* 对照实验用：置 window.BOSS_CTX_OFF = true 就退回「不压缩」的老行为 */
    if (window.BOSS_CTX_OFF) {
      return { before, after: before, folded: 0, summarized: false, usage: { in: 0, out: 0 }, notes: '' };
    }
    if (messages.length < CTX.minMsgs || before <= CTX.soft) {
      return { before, after: before, folded: 0, summarized: false, usage: { in: 0, out: 0 }, notes: '' };
    }

    const folded = foldObservations(messages);
    let now = ctxTok(messages);
    if (now <= CTX.hard || !o.model) {
      return { before, after: now, folded, summarized: false, usage: { in: 0, out: 0 }, notes: '' };
    }
    /* 归纳会换掉整段过程，用得太勤会把「工作现场」压没，反而让模型从头再摸一遍。
       所以：剩下步数不够就不做，两次之间至少隔几步。 */
    const st = o.state || {};
    if (st.lastDigestAt != null && (st.step || 0) - st.lastDigestAt < CTX.digestGap) {
      return { before, after: now, folded, summarized: false, usage: { in: 0, out: 0 }, notes: '' };
    }
    if (o.stepsLeft != null && o.stepsLeft < CTX.digestMinLeft) {
      return { before, after: now, folded, summarized: false, usage: { in: 0, out: 0 }, notes: '' };
    }

    /* 折叠还不够：把 [2, tailStart) 这一段换成一段提要 */
    const cut = tailStart(messages);
    if (cut <= 2) return { before, after: now, folded, summarized: false, usage: { in: 0, out: 0 }, notes: '' };

    const script = digestScript(messages, cut);
    let notes = '';
    let usage = { in: 0, out: 0 };
    try {
      const r = await chatSafe({
        model: o.model,
        messages: [
          { role: 'system', content: DIGEST_SYS },
          { role: 'user', content: script + '\n\n请输出前情提要。' }
        ],
        signal: o.signal
      });
      notes = String(r.content || '').trim();
      usage = r.usage || usage;
    } catch { /* 归纳失败就退化成只折叠，主流程不受影响 */ }

    if (!notes) return { before, after: now, folded, summarized: false, usage, notes: '' };

    const head = messages.slice(0, 2);
    const tail = messages.slice(cut);
    messages.length = 0;
    messages.push(
      ...head,
      {
        role: 'user',
        content: [
          `【前情提要｜前面的 ${cut - 2} 条过程已压缩，原始约 ${before} token】`,
          notes,
          '（细节已折叠。需要某个具体数字或原文，用 search_text 定位、read_file 读指定段落，不要凭空回忆。）'
        ].join('\n')
      },
      ...tail
    );

    /* 关键点落盘：重做、续跑、换人接手时都能捞回来，不靠模型记性 */
    if (o.scope && o.label) saveCtxNotes(o.scope, o.label, notes, o.perms);
    if (o.state) o.state.lastDigestAt = o.step || 0;

    if (o.onNotice) { try { o.onNotice({ before, after: ctxTok(messages), summarized: true }); } catch { /* ignore */ } }
    return { before, after: ctxTok(messages), folded, summarized: true, usage, notes };
  }

  /* 前情提要存到 .ctx/ 下：list_dir 会滤掉点开头的目录，不会污染模型看到的文件清单 */
  function saveCtxNotes(scope, label, notes, perms) {
    if (!perms || !perms.write) return;
    const slug = String(label).replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(-40) || 'task';
    fetch(window.withSC('/api/tool'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope, name: 'write_file', perms, device: window.REN_DEVICE || '',
        args: { path: `.ctx/${slug}-notes.md`, content: `# 前情提要\n\n${notes}\n` }
      })
    }).catch(() => {});
  }

  /* 交付物校验：文件系统说了算。服务不可用时回 checked:false，绝不当成通过
     since：给了就额外判断「这份是不是这一轮新写的」——盘上留着上一轮的旧文件不算交付 */
  async function verifyPaths(scope, paths, since) {
    if (!paths || !paths.length) return { checked: false, pass: true, missing: [], detail: [] };
    try {
      const r = await fetch(window.withSC('/api/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, deliverables: paths })
      });
      const j = await r.json();
      if (j.ok) {
        const check = j.check || { checked: true, missing: [], detail: [] };
        if (since) {
          check.stale = (check.detail || [])
            .filter(d => d.ok && d.mtime && d.mtime < since - 2000)
            .map(d => d.path);
        }
        return check;
      }
    } catch (e) { /* 校验服务不可用 */ }
    return { checked: false, pass: true, missing: [], detail: [] };
  }

  /* ══ 验收人 ══
   * 依据书第 7 章：判定必须建立在「机器可独立复核的事实」上（7.4.2），
   * 不能拿执行者的自我陈述当证据；标准要事先定、四档打分、一票否决（7.5.1）；
   * 判的人要跟干的人不是同一个模型（10.5.3 同质趋同）。
   * 判定逻辑全在 public/judge.js 里——项目线调的是同一份，不许各写一套。 */

  /* 交付物摘要：让验收人看到磁盘上到底有什么、写了什么
     since：这一轮的起始时间，用来把「上一轮留下的旧文件」标出来 */
  async function digestPaths(scope, paths, since) {
    const list = [...new Set((paths || []).filter(Boolean).map(String))].slice(0, 8);
    if (!list.length) return [];
    try {
      const r = await fetch(window.withSC('/api/digest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, paths: list, since: since || 0 })
      });
      const j = await r.json();
      if (j && j.ok && Array.isArray(j.items)) return j.items;
    } catch (e) { /* 摘要拿不到：验收人会看到「没有文件产出」，这本身就是一条证据 */ }
    return [];
  }

  /* 验收人只判眼前这份东西：不挂工具、不许它自己去查、温度 0 保证可复现 */
  async function judgeOnce({ model, system, user, signal, maxTokens }) {
    const payload = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      /* 验收只要一个 5 维度的 JSON。额度留到 2000：混合推理模型偶尔会先想一大圈
         （实测同一模型同一输入，有时 0 思考 4 秒答完，有时思考吃满、正文 0 字），
         多留一截能少一次重试；但再往上加没有意义 —— 陷进去的模型给多少都会用光。 */
      max_tokens: maxTokens || 2000
    };
    let text = '';
    let reasoning = '';
    let finish = '';
    let usage = null;
    for await (const chunk of window.CLOUD.chatStream(payload)) {
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const choice = chunk && chunk.choices && chunk.choices[0];
      const d = choice && choice.delta;
      if (d && d.content) text += d.content;
      if (d && d.reasoning_content) reasoning += d.reasoning_content;
      if (choice && choice.finish_reason) finish = String(choice.finish_reason);
      if (chunk && chunk.usage) usage = chunk.usage;
    }
    const det = (usage && usage.completion_tokens_details) || {};
    /* 注意：这里不再拿 reasoning 去顶替 text。
       思考里那几千字是「我要输出 JSON」的自我盘桓，不是结论；
       把它当答案送进解析，只会得出一个假的「验收人说了话但没结论」。 */
    return {
      text, reasoning, finish,
      usage: {
        in: (usage && usage.prompt_tokens) || 0,
        out: (usage && usage.completion_tokens) || 0,
        reasoning: Number(det.reasoning_tokens) || 0,
        credit: usage && typeof usage.credit === 'number' ? usage.credit : null
      }
    };
  }

  /**
   * 判一份交付。顺序是刻意的：程序能判死的直接判死，不花一次模型调用，
   * 也不给话术翻案的机会；程序判不了的才问验收人。
   * @returns 判定对象（见 judge.js 的 decide 返回值），另外带 usage / error
   */
  async function judgeTask(opt) {
    const o = opt || {};
    const J = window.JUDGE;
    if (!J) return null;
    const digests = await digestPaths(o.scope, o.paths || [], o.since);
    const prog = J.gate({ digests, text: o.text, expectFiles: !!o.expectFiles });
    let cand = o.judge || { id: o.workerModel || o.model, name: o.model, level: 'none' };

    /* 程序判死：连模型都不用问 */
    if (prog.hard.length) {
      const v = J.decide({ prog, model: null, judge: cand, workerModel: o.model, kind: o.kind || 'task' });
      return { ...v, digests, usage: { in: 0, out: 0 } };
    }

    const t0 = Date.now();
    let parsed = null;
    let usage = { in: 0, out: 0, reasoning: 0, credit: 0 };
    let error = '';
    const diag = [];
    const sumUsage = (a, b) => ({
      in: (a.in || 0) + ((b && b.in) || 0),
      out: (a.out || 0) + ((b && b.out) || 0),
      reasoning: (a.reasoning || 0) + ((b && b.reasoning) || 0),
      credit: (a.credit || 0) + ((b && b.credit) || 0)
    });
    const ask = (who, tail) => judgeOnce({
      model: who.id || o.model,
      system: J.systemPrompt({
        kind: o.kind || 'task',
        workerName: o.workerName,
        workerModel: o.model,
        judgeModel: who.id
      }),
      user: J.userPrompt({
        kind: o.kind || 'task',
        goal: o.goal,
        accept: o.accept,
        text: o.text,
        digests,
        prevText: o.prevText,
        prog
      }) + (tail || ''),
      signal: o.signal
    });
    const tried = [];
    let queue = null;
    const listModels = async () => {
      try {
        if (!window.CLOUD || typeof window.CLOUD.listModels !== 'function') return [];
        return await window.CLOUD.listModels();
      } catch (e) { return []; }
    };
    /* 下一个还没试过的候选。第一次失败就换人，不拿同一个模型再撞一遍：
       思考型模型每次都会把额度花光，重试只是再烧一次钱和一分钟。 */
    const nextCand = async () => {
      if (!queue) {
        const models = await listModels();
        queue = models.length ? J.candidates(models, o.model, {}) : [];
      }
      for (let i = 0; i < queue.length; i++) {
        const c = queue[i];
        if (c && c.id && tried.indexOf(c.id) < 0) return c;
      }
      return null;
    };
    const NUDGE = '\n\n【上一轮没按格式输出】这次只输出那个 JSON 对象本身：不要任何解释、不要代码围栏、不要前后缀、不要思考过程。';

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        tried.push(cand.id);
        const r = await ask(cand, attempt ? NUDGE : '');
        usage = sumUsage(usage, r.usage);
        diag.push({
          model: cand.id, finish: r.finish, out: r.usage.out,
          reasoning: r.usage.reasoning || 0, chars: r.text.length, ms: Date.now() - t0
        });
        /* 正文优先；正文里抽不出 JSON 才去看思考 —— 而且只有真能抽出五个维度才算数。
           思考里那几千字是它自己跟自己商量，不是结论；当成结论比没结论更糟。 */
        parsed = J.parse(r.text) || (r.reasoning ? J.parse(r.reasoning) : null);
        if (parsed) break;
        const alt = await nextCand();
        if (alt && alt.id && alt.id !== cand.id) { cand = alt; continue; }
        break;
      }
      if (!parsed) {
        const last = diag[diag.length - 1] || {};
        const who = cand.name || cand.id || '验收人';
        if (last.finish === 'length' && !(last.chars > 0)) {
          error = `${who} 把 ${last.reasoning || last.out || '整笔'} token 全用在思考上，正文一个字都没写就被截断`;
        } else if (last.finish === 'length') {
          error = `${who} 的结论写到 ${last.chars} 字就撞上上限被截断`;
        } else {
          error = `${who} 两次都没按格式给出结论`;
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      error = (e && e.message) || '验收调用失败';
    }
    const v = J.decide({
      prog, model: parsed, judge: cand, workerModel: o.model,
      kind: o.kind || 'task', failReason: error
    });
    return { ...v, digests, usage, error, diag, ms: Date.now() - t0 };
  }

  /* 把验收结论翻成一条能回灌给执行者的话：只说缺什么，不说「你要更努力」 */
  function repairText(v) {
    const gaps = (v && v.gaps) || [];
    const dims = (v && v.dims) || [];
    const bad = dims.filter(d => d.s < 3).map(d => `${d.name}${d.why ? '：' + d.why : ''}`);
    const list = (gaps.length ? gaps : bad).filter(Boolean);
    return [
      '【验收退回】这一轮没过验收。问题如下：',
      ...list.slice(0, 3).map((x, i) => `${i + 1}. ${x}`),
      '只补上面这几处，已经对的内容不要重写；改完直接收工，不要解释。'
    ].join('\n');
  }

  /* ══ 子 Agent 隔离：大块材料不进主上下文 ══
   * 书 2.7.4 的结论是「隔离优于压缩」：压缩是有损的事后补救——材料先进了主上下文，
   * 每一轮都要背着它跑，最后还得花一次调用把它擦掉；隔离是让材料根本不进来，
   * 子 Agent 自己消化，只把带得走的结论还给主线。
   * 触发面刻意收窄：只有读文件 / 搜索 / 抓网页这类「回包天然很大」的工具，
   * 且回包超过阈值才隔离。写盘回包都很短，别多花这一次调用。 */
  const ISOLATE_TOOLS = new Set(['read_file', 'web_search', 'fetch_url']);
  const ISOLATE_MIN = 6000;   // 回包低于这个字数，原样进上下文（隔离本身也有成本）
  const ISOLATE_MAX = 24000;  // 材料再大，子 Agent 也只读这一段
  let isolateOff = false;
  try { isolateOff = typeof localStorage !== 'undefined' && localStorage.getItem('boss.isolate') === '0'; } catch (e) { /* 非浏览器环境照常 */ }

  /**
   * 大块工具回包 → 子 Agent 读完 → 返回一份短摘要。
   * @returns null 表示不隔离 / 提炼失败（调用方原样注入全量，别拖垮执行）
   */
  async function maybeIsolate(o) {
    const text = String(o && o.text || '');
    if (isolateOff || !o || !o.model) return null;
    if (!ISOLATE_TOOLS.has(o.toolName) || text.length < ISOLATE_MIN) return null;
    if (o.signal && o.signal.aborted) return null;
    const material = text.length > ISOLATE_MAX
      ? text.slice(0, ISOLATE_MAX) + '\n…（材料太长，只给了前一部分）'
      : text;
    const sys = [
      '你是资料提炼员。主 Agent 正在干活，刚拿到一份工具回包，主上下文放不下这么多原文，由你读完、替它提炼。',
      '你的结论会**替代原文**进主上下文：漏了重点 = 主 Agent 漏了重点。所以宁可多留一条，也不要为了简洁砍掉关键数字。',
      '',
      '要求：',
      '· 直接输出提炼结果，不寒暄、不复述任务、不写「根据材料」。',
      '· 第一行一句总判断：这份材料对主 Agent 手头的事有没有用、回答了什么。',
      '· 之后最多 5 条，每条一行；数字、金额、日期、口径、文件名**原样照抄**，不许四舍五入、不许概括成「若干」。',
      '· 与手头的事无关的段落直接丢弃，不要给无关内容做摘要。',
      '· 材料被截断时，最后一行标「（材料未读完，截断处之后的内容缺失）」。'
    ].join('\n');
    const q = o.args && o.args.query ? `，搜「${String(o.args.query).slice(0, 80)}」`
      : (o.args && o.args.path ? `，读 ${String(o.args.path).slice(0, 80)}` : (o.args && o.args.url ? `，抓 ${String(o.args.url).slice(0, 80)}` : ''));
    const user = [
      `【主 Agent 手头的事】${String(o.goal || '').replace(/\s+/g, ' ').slice(0, 300)}`,
      `【它刚调了 ${o.toolName}${q}】`,
      '【工具回包全文】',
      material
    ].join('\n\n');
    try {
      const r = await judgeOnce({ model: o.model, system: sys, user, signal: o.signal, maxTokens: 700 });
      const t = String(r.text || '').replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
      if (!t) return null;
      return {
        summary: `【${o.toolName} 回包 ${text.length} 字，没直接进主上下文：子 Agent 已读完并提炼成下面这些。要原文细节就再调一次 ${o.toolName}，只问还缺的部分。】\n${t}`,
        usage: r.usage
      };
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      return null; /* 提炼失败退回全量注入，不能因为这个把活干砸 */
    }
  }

  /**
   * 通用工具循环：会议里的每个执行节点也走这条，产出必须真落盘。
   * 跟 run() 的区别是它不认识任务/事件，只回一份结果，怎么显示由调用方决定。
   * 返回 { text, wrote, steps, gates, status, usage }
   */
  async function toolLoop({ model, system, user, scope, perms, maxSteps = 6, signal, onText, onStep, onCompact, gatePaths = [], files = [], budget = 0, onAsk, goal = '' }) {
    const { cats } = await loadTools();
    const perm = perms || {};
    /* 工具按需下发用的是 activeGoal，以前只有 run() 会设它——
       项目节点走 toolLoop，拿到的是上一个任务的旧目标（甚至是空的），
       于是「这一节要交 .docx」也不会把 make_doc 下发下去。这里按节点目标重设一次。 */
    if (goal) activeGoal = String(goal);
    activeFiles = (files || []).length;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userContent(user, files) }
    ];
    const wrote = [];
    const steps = [];
    const gates = [];
    const MAX_NUDGE = 2;
    const startAt = Date.now();
    let nudges = 0;
    let text = '';
    let inTok = 0;
    let outTok = 0;
    let status = 'done';
    let finished = false;
    const ctxState = {};
    /* 同一份文件反复读、同一个词反复搜，是节点把步数烧光的头号原因。
       这里不靠提示词自觉，直接记账：读第二遍就只回一句「读过了」。 */
    const seenRead = new Map();
    const seenSearch = new Map();
    let searchUsed = 0;
    let lastStepHinted = false;
    /* 多留一步「收尾写入」：前面的步数用来查、读，最后这一步只准写。
       不给这一步，模型经常把步数全花在搜上面，然后两手空空收工。 */
    const LAST = maxSteps;

    for (let step = 0; step < maxSteps + 1; step++) {
      const isLast = step >= LAST;
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      /* 单节点自己的 token 上限：到线就停手。
         这一轮已经花掉的撤不回来，但能拦住「读着读着又重读一遍」的继续烧。 */
      if (budget && inTok + outTok > budget) {
        status = 'budget_exceeded';
        break;
      }
      /* 发出去之前先看上下文多大：该折叠折叠，该归纳归纳，别把每一步都按全量重发 */
      try {
        const cc = await compactContext(messages, {
          model, signal, scope, perms, state: ctxState, step,
          stepsLeft: Math.max(0, LAST - step),
          label: (gatePaths[0] || 'tool').split('/').pop(),
          onNotice: onCompact
        });
        if (cc.usage && (cc.usage.in || cc.usage.out)) { inTok += cc.usage.in; outTok += cc.usage.out; }
      } catch { /* 压缩本身出问题不该拖垮执行 */ }

      /* 最后一步还没落盘：把话说死，别再让它去翻资料 */
      if (isLast && !lastStepHinted && gatePaths.length) {
        lastStepHinted = true;
        messages.push({
          role: 'user',
          content: `【最后一步】前面能查的都查过了。这一轮只能写文件：直接把 ${gatePaths[0]} 写出来。`
            + `内容不全也比没写强——缺的部分在文件里标一句「待确认」。本轮除 write_file / make_deck 之外的调用都会被拒。`
        });
      }
      /* 走 callWithRetry 而不是裸 chatSafe：上下文里带着生成的 HTML/代码时
         会被 WAF 误判成攻击，这里和任务线一样自动精简上下文重试，
         不让一整段拦截页 HTML 糊进对话气泡 */
      const r = await callWithRetry({ model, messages, signal, onText });
      inTok += r.usage.in;
      outTok += r.usage.out;
      if (r.content) text = r.content;

      if (!r.toolCalls.length) {
        /* 说了不算，文件在不在、是不是这一轮写的，才是交付 */
        if (gatePaths.length) {
          const g = await verifyPaths(scope, gatePaths, startAt);
          const lack = [
            ...(g.missing || []).filter(Boolean),
            ...(g.stale || []).filter(Boolean).map(p => `${p}（盘上那份是上一轮的，这一轮没重写）`)
          ];
          if (g.checked && lack.length) {
            if (nudges < MAX_NUDGE) {
              nudges++;
              gates.push({ round: nudges, missing: lack });
              messages.push({ role: 'assistant', content: r.content || '' });
              messages.push({
                role: 'user',
                content: `【交付门禁】${lack.join('、')} 还没真正写进工作目录。不要解释、不要说「我将…」，现在就用 write_file 把这一节的完整产出写出来，写完再收工。`
              });
              continue;
            }
            status = 'unverified';
          }
        }
        finished = true;
        break;
      }

      messages.push({
        role: 'assistant',
        content: r.content || '',
        tool_calls: r.toolCalls.map(c => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.raw || '{}' }
        }))
      });

      for (const c of r.toolCalls) {
        const cat = (cats && cats[c.name]) || 'exec';
        if (c.badArgs) {
          steps.push({ name: c.name, ok: false, output: '参数不是合法 JSON' });
          messages.push({ role: 'tool', tool_call_id: c.id, content: '工具参数不是合法 JSON，这一步没执行。请重新生成参数。' });
          continue;
        }
        if (cat !== 'none' && !perm[cat]) {
          steps.push({ name: c.name, ok: false, output: '缺少权限：' + cat });
          messages.push({
            role: 'tool', tool_call_id: c.id,
            content: `用户没有开启「${cat}」类权限，这一步被拦了。不要重试，改用不需要这项权限的做法，或者在结尾说明卡在哪。`
          });
          continue;
        }
        /* ask_boss：节点做到一半需要老板拍板。
           挂起等答案（等待期不烧 token），答案作为工具回包让它接着干。
           项目线用它；任务线 run() 里有自己的一套。 */
        if (c.name === 'ask_boss' && typeof onAsk !== 'function') {
          /* 这条链路没接拍板卡（比如项目里的随手 @ 干活）：别去服务端撞 unknown tool，
             直接让它把问题写进正文问老板，然后继续干活 */
          steps.push({ name: c.name, ok: true, output: '转正文提问' });
          messages.push({
            role: 'tool', tool_call_id: c.id,
            content: '这一路没有挂起等拍板的卡片。请把要问老板的问题（每题带 2–4 个候选选项）直接写进回复正文，单起一段【要老板拍板】；其余部分照常交付，不要停下来。'
          });
          continue;
        }
        if (c.name === 'ask_boss' && typeof onAsk === 'function') {
          const qs = [];
          const qlist = Array.isArray(c.args && c.args.questions) ? c.args.questions : [];
          for (const q of qlist.slice(0, 6)) {
            if (!q || !q.q) continue;
            qs.push({
              q: String(q.q).slice(0, 200),
              options: (Array.isArray(q.options) ? q.options : []).slice(0, 6).map(o => String(o).slice(0, 60)),
              multi: !!q.multi
            });
          }
          if (!qs.length) {
            steps.push({ name: c.name, ok: false, output: 'questions 为空' });
            messages.push({ role: 'tool', tool_call_id: c.id, content: 'ask_boss 的 questions 是空的，请重新调用，至少给一个带 q 的问题。' });
            continue;
          }
          if (onStep) { try { onStep({ i: step + 1, name: 'ask_boss', args: c.args }); } catch { /* ignore */ } }
          let ans = null;
          try { ans = await onAsk({ intro: String((c.args && c.args.intro) || ''), questions: qs }); }
          catch (e) {
            if (e && e.name === 'AbortError') throw e;
            ans = null;
          }
          const line = (Array.isArray(ans) && ans.length)
            ? '【老板已确认，按这个继续】\n' + ans.map((a, i) =>
              `${i + 1}. ${qs[i].q}\n答：${(a && a.text) || a}`).join('\n')
            : '【老板没有作答】没有答案的部分按行业默认假设继续，拿不准的地方在产出里标一句「待老板确认」。';
          steps.push({ name: c.name, ok: true, output: Array.isArray(ans) && ans.length ? '老板已确认' : '老板未答，按默认假设' });
          messages.push({ role: 'tool', tool_call_id: c.id, content: line });
          /* 同一批里的其它调用不再执行：拍板的结果可能改变它们的前提 */
          for (const o of r.toolCalls) {
            if (o === c) continue;
            messages.push({ role: 'tool', tool_call_id: o.id, content: '老板在拍板，这一调用本轮没有执行。' });
          }
          break; /* 回到主循环，模型拿着答案继续 */
        }
        let payload;
        /* 收尾那一步只准落盘：别的调用一律拒，免得又跑去搜 */
        if (isLast && c.name !== 'write_file' && c.name !== 'make_deck') {
          steps.push({ name: c.name, ok: false, output: '收尾步拒绝：只能写文件' });
          messages.push({
            role: 'tool', tool_call_id: c.id,
            content: `这是收尾步，${c.name} 被拒了。现在只能调 write_file / make_deck 把产出写出来。`
          });
          continue;
        }
        /* 搜索是硬预算：这一节总共 3 次。搜不到就该动笔了，不是换个说法接着搜 */
        if (c.name === 'web_search') {
          searchUsed++;
          if (searchUsed > 3) {
            steps.push({ name: c.name, ok: false, output: '超出本节搜索预算' });
            messages.push({
              role: 'tool', tool_call_id: c.id,
              content: '这一节已经搜了 3 次，搜索预算用完了。不要再搜——用已经拿到的信息 + 你自己的经验把结论写进文件，'
                + '数字标成「按行业经验估值，上线前用平台后台核实」。'
            });
            continue;
          }
        }
        /* 重复读 / 重复搜：不执行，直接回一句。省一步，也省一次几万字的回包 */
        const key = c.name === 'read_file' ? String(c.args && c.args.path || '')
          : (c.name === 'web_search' ? String(c.args && c.args.query || '') : '');
        const tally = c.name === 'read_file' ? seenRead : (c.name === 'web_search' ? seenSearch : null);
        if (tally && key) {
          const n = (tally.get(key) || 0) + 1;
          tally.set(key, n);
          const cap = c.name === 'read_file' ? 1 : 2;
          if (n > cap) {
            steps.push({ name: c.name, ok: true, output: '重复调用，已跳过' });
            messages.push({
              role: 'tool', tool_call_id: c.id,
              content: c.name === 'read_file'
                ? `「${key}」这一节已经读过 ${n - 1} 次了，内容没变。别重读，用你已经看到的内容下判断，接着写文件。`
                : `「${key}」这个搜法已经用过，结果不会变。换一次说法，或者直接用现有信息给结论并写文件。`
            });
            continue;
          }
        }
        /* 让外面能看见「这一步在干什么」，进度条才有内容可显示 */
        if (onStep) { try { onStep({ i: step + 1, name: c.name, args: c.args }); } catch { /* ignore */ } }
        try { payload = await execTool(scope, c.name, c.args, perm); }
        catch (e) {
          payload = { blocked: false, result: { ok: false, output: '执行失败：' + e.message, verify: { pass: false, why: e.message } } };
        }
        const out = payload.result || {};
        const v = out.verify || { pass: true, why: '' };
        if (out.wrote) wrote.push(out.wrote);
        steps.push({ name: c.name, ok: !!out.ok, output: String(out.output || '').slice(0, 240),
          files: Array.isArray(out.files) && out.files.length ? out.files : undefined });
        /* 大块材料先过子 Agent 隔离：主上下文只收结论，原文不进来 */
        let toolContent = v.pass
          ? String(out.output || '')
          : `${out.output}\n\n【校验未通过】${v.why}。这一步没有真正生效，换一种做法重试，不要当作已完成。`;
        const iso = v.pass ? await maybeIsolate({
          model, signal, toolName: c.name, args: c.args, text: toolContent, goal: user
        }) : null;
        if (iso) {
          toolContent = iso.summary;
          inTok += iso.usage.in; outTok += iso.usage.out;
          /* 这次读过的文件允许以后再读：子 Agent 只带了结论走，模型要细节得自己再拿 */
          const rk = c.name === 'read_file' ? String(c.args && c.args.path || '')
            : (c.name === 'web_search' ? String(c.args && c.args.query || '') : '');
          if (rk) (c.name === 'read_file' ? seenRead : seenSearch).delete(rk);
        }
        messages.push({
          role: 'tool', tool_call_id: c.id,
          content: toolContent
        });
      }
    }

    if (!finished && status === 'done') status = 'step_limit';

    /* 收工只有一个标准：文件在不在、是不是这一轮写的。
       步数用尽、门禁退回过两次，都可能文件其实已经写好了——
       所以这里无条件再查一次，别只凭 status 下结论。 */
    let delivered = null;
    let lack = [];
    if (gatePaths.length) {
      const g = await verifyPaths(scope, gatePaths, startAt);
      if (g.checked) {
        lack = [
          ...(g.missing || []).filter(Boolean),
          ...(g.stale || []).filter(Boolean)
        ];
        delivered = lack.length === 0;
        /* 到预算停下的要留住这个原因，别被「没交付」盖成一句含糊的 unverified */
        if (!delivered && status !== 'budget_exceeded') status = 'unverified';
        else if (status === 'unverified' || status === 'step_limit') status = 'done';
      }
    }
    const mm = splitMemo(text);
    return {
      text: mm.body, memo: mm.items, projectMemo: mm.projectItems, wrote: [...new Set(wrote)], steps, gates,
      status, delivered, lack, usage: { in: inTok, out: outTok }
    };
  }

  /* 一步工具：交给服务端执行，并把结果拿回来。
     同步接口有上限：生图这类几分钟的操作会被平台网关先掐断，前端就只能拿到一坨 HTML。
     所以这里自己看表（150 秒），超时就明确说清楚，别让员工以为工具坏了。 */
  async   function execTool(scope, name, args, perms, outerSignal) {
    /* 自定义工具把描述符带上，服务端按它去打接口 */
    const custom = (window.CUSTOM_TOOLS || []).find(t => t && t.name === name);
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctl.abort();
    if (outerSignal) {
      if (outerSignal.aborted) ctl.abort();
      else outerSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, 150000);
    const t0 = Date.now();
    try {
      const r = await fetch(window.withSC('/api/tool'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          scope, name, args, perms,
          /* 设备标识给服务端判路径租约用：两台设备写同一个文件时，后到的那一步要被告知
             「另一边正在写」，而不是默默覆盖。它不是权限，改它也就多占一个租约。 */
          device: window.REN_DEVICE || '',
          custom: custom ? { url: custom.url, method: custom.method, headers: custom.headers } : undefined
        })
      });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch { /* 下面统一报 */ }
      if (!j) {
        const secs = Math.round((Date.now() - t0) / 1000);
        const head = (window.BOSS && BOSS.sanitizeErrText ? BOSS.sanitizeErrText(String(txt || '').replace(/\s+/g, ' ')) : String(txt || '').replace(/\s+/g, ' ')).slice(0, 120);
        throw new Error(secs > 20
          ? `这一步同步跑了 ${secs} 秒还没回，被网关/通道掐断了（HTTP ${r.status || '—'}）。生图这类慢操作不要一直等：改用 find_image，或者把画面要求简化后再试一次。`
          : `工具接口返回的不是 JSON（HTTP ${r.status || '—'}${head ? '：' + head : ''}）。换参数或换工具重试。`);
      }
      if (!j.ok) throw new Error(j.error || '工具调用失败');
      return j;
    } catch (e) {
      if (timedOut) {
        const secs = Math.round((Date.now() - t0) / 1000);
        throw new Error(`这一步 ${secs} 秒还没返回，已中止（多半卡在生图排队/限流）。改用 find_image 找现成图，或把画面描述简化后再生成一次。`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
    }
  }

  /* ── 产出物格式：老板点名的 > 名词暗示的 > 动词推出来的 ──
   * 判断顺序是有讲究的：老板明确说了「要 .pptx」就绝不能给他一份 docx；
   * 没说格式才按动词猜——「画」是图片、「写」是 Word、「统计」是 Excel。
   * 全都推不出来就别猜，先问（见 artNeedAsk）。
   * 硬规矩：md 不是兜底格式。老板没要 md，就不许拿 write_file 写一份 .md 交差。 */
  const ART_FORMS = {
    pptx: { key: 'pptx', name: 'PPT（.pptx）', re: /\.pptx$/i, tool: 'make_deck' },
    docx: { key: 'docx', name: 'Word（.docx）', re: /\.docx$/i, tool: 'make_doc' },
    xlsx: { key: 'xlsx', name: 'Excel（.xlsx）', re: /\.xlsx?$/i, tool: 'make_sheet' },
    pdf: { key: 'pdf', name: 'PDF（.pdf）', re: /\.pdf$/i, tool: '' },
    image: { key: 'image', name: '图片（.png / .jpg）', re: /\.(png|jpe?g|webp)$/i, tool: 'gen_image' },
    md: { key: 'md', name: 'Markdown（.md）', re: /\.(md|markdown)$/i, tool: 'write_file' }
  };

  /* 缺产出时给模型的逐条做法：一种格式一条，别再把所有类型混成一句话 */
  const ART_NUDGE = {
    pptx: '- PPT：调 make_deck 写成 .pptx。把这一轮的内容按 cover / section / bullets / cards / kpi 这些版式排进去，8 页起。',
    docx: '- Word：把正文按 Markdown 写在回答里，再调 make_doc 给 path（以 .docx 结尾）和 title，正文系统会取你刚写的那段。',
    xlsx: '- Excel：调 make_sheet，把数据按 sheets / columns / rows 传进去，写成 .xlsx。',
    image: '- 图片：调 gen_image 出图（prompt 用英文，写清主体+风格+光线）。'
      + '这个工具一定能出图——AI 通道排队时会由本地插画引擎画一张设计稿，不会报错。'
      + '**不要因为「没有实拍渲染通道」「担心带水印」就不出图**：先出图，再在正文说清这是设计稿/示意图即可。',
    pdf: '- PDF：当前没有 PDF 生成工具，别拿 md/txt 顶替；用 ask_boss 说明只能出 Word / PPT / Excel / 图片，问老板要哪种。'
  };

  function wantedArtifacts(text) {
    const g = String(text || '');
    const want = [];
    const add = k => { const f = ART_FORMS[k]; if (f && !want.some(w => w.key === k)) want.push(f); };
    const deliver = /(画|绘制|生成|输出|做成|做成|写成|写一|写个|写篇|写份|撰写|起草|做一|做个|做份|整理成|汇总成|转成|导成|导出|给我一|来一|出一|出个|出份|设计一|设计个|弄一|弄个|帮我做|帮我写|帮我画)/.test(g);

    /* 1) 老板点名的后缀：写了 .pptx 就是 .pptx。
          后缀是最硬的信号——写了「readme.md」就别再按「写」推成 docx。 */
    let byExt = false;
    if (/\.pptx?\b/i.test(g)) { add('pptx'); byExt = true; }
    if (/\.docx?\b/i.test(g)) { add('docx'); byExt = true; }
    if (/\.xlsx?\b|\.csv\b/i.test(g)) { add('xlsx'); byExt = true; }
    if (/\.pdf\b/i.test(g)) { add('pdf'); byExt = true; }
    if (/\.(png|jpe?g|webp)\b/i.test(g)) { add('image'); byExt = true; }
    if (/\.(md|markdown)\b/i.test(g)) { add('md'); byExt = true; }
    /* 后缀已经说死了，后面的名词/动词推断全部让位 */
    if (byExt) return want;

    /* 2) 点名的格式词。PDF / Word 这类也能当输入格式（「读一下这个 PDF」），
          所以必须同时有产出动作，否则会把「读附件」当成「要产出」 */
    if (/\bpptx?\b|幻灯片|演示文稿|演示稿|\bslides?\b|\bdeck\b/i.test(g)) add('pptx');
    if (/\bword\b|docx/i.test(g)) add('docx');
    if (/\bexcel\b|xlsx/i.test(g)) add('xlsx');
    if (/\bmarkdown\b/i.test(g)) add('md');
    if (/\bpdf\b/i.test(g) && deliver) add('pdf');

    /* 3) 名词暗示：老板没提格式，但说的东西天然对应某种文件 */
    if (/(演示|汇报|提案|路演|宣讲|汇报材料)/.test(g)) add('pptx');
    if (/(文档|报告|公文|说明书|合同稿|方案稿|纪要|白皮书|周报|月报|日报|复盘|总结|手册|策划书|计划书|简历|备忘录)/.test(g)) add('docx');
    if (/(表格|台账|清单|报表|报价表|成本表|预算表|数据表|对账|明细表|统计表)/.test(g)) add('xlsx');

    /* 视觉类名词（海报 / 主视觉 / 效果图 …）：只在不属于「流程图 / 架构图」这类矢量图时才要真图片。
       这个判断要放在所有图片归因之前，否则「画一张流程图」会被动词兜底错判成文生图。 */
    const diagram = /(流程图|架构图|时序图|思维导图|甘特图|拓扑图|组织结构图|ER 图|UML)/i.test(g);

    /* 4) 动词兜底：没说东西是什么，看他让干什么 */
    if (!diagram && /(画一|画个|画张|画幅|绘制|出图|生成图|来张图|做张图|做一张图)/.test(g)) add('image');
    if (/(写一份|写一篇|写个|写份|写篇|撰写|起草|整理成文|总结成文|写成文|形成文档|整理成文档)/.test(g)) add('docx');
    if (/(统计一下|汇总成表|列个表|做个表|做张表)/.test(g)) add('xlsx');

    if (!diagram && /(配图|插画|插图|效果图|渲染图|设计稿|主视觉|海报|封面图|图标|\blogo\b|图片)/i.test(g)) add('image');

    /* 写代码 / 写脚本这类「写」不是要文档，别被动词兜底带偏 */
    const code = /(代码|脚本|程序|函数|接口|组件|SQL|正则|爬虫|prompt|提示词)/i.test(g);
    if (code && !/(文档|报告|说明书|方案|周报|月报|日报)/.test(g)) {
      const i = want.findIndex(w => w.key === 'docx');
      if (i >= 0) want.splice(i, 1);
    }
    return want;
  }

  /**
   * 推不出格式 → 该问老板，而不是自己挑一个（尤其不能挑 md）。
   * 只在「确实要交东西、却说不清交什么」时成立：有产出动作 + 有个可数宾语。
   * 「帮我看看这份数据」这种不动手的请求不算，别把闲聊也拦下来提问。
   */
  function artNeedAsk(text) {
    const g = String(text || '');
    if (wantedArtifacts(g).length) return false;
    if (/(流程图|架构图|时序图|思维导图|甘特图|拓扑图|组织结构图)/.test(g)) return false;
    if (!/(帮我做|帮我写|帮我画|帮我弄|帮我整|做一个|做个|做一份|弄一个|弄个|整一个|整一份|来一份|来一个|出一份|给我一份|给我一个|生成|输出)/.test(g)) return false;
    if (!/(一份|一个|一套|一张|一批|一版|东西|内容|材料|稿件)/.test(g)) return false;
    /* 明显是在问问题而不是派活 */
    if (/(吗？|吗\?|怎么|为什么|如何|能不能|可不可以|是不是|要不要|你觉得|建议)/.test(g) && !/(帮我|给我)/.test(g)) return false;
    return true;
  }

  /**
   * 跑一个任务。
   * emit 事件：start / step(call|result) / text / usage / need_permission / budget / error / done
   */
  async function run({ task, staff, settings, model, scope, signal, emit, followUp, followUpImages, judge }) {
    const { cats } = await loadTools();
    /* 工具按需下发看的是这个任务的原始目标，整轮不变（中途换工具清单会让模型找不到刚才用过的工具） */
    activeGoal = String(task.goal || '') + '\n' + String(followUp || '');
    activeFiles = Array.isArray(task.files) ? task.files.length : 0;
    activeWorked = 0;
    const t0 = Date.now();
    METER = meterNew();
    /* followUp：老板在本任务里接着说的那句话。同一个任务、同一串上下文，
       不是新任务；历史 steps 也接着往下加。 */
    const resuming = Array.isArray(task.messages) && task.messages.length > 2;
    const carry = resuming || !!followUp;
    /* 续跑时 system 里已经有记忆了，不重复取 */
    const mem = resuming ? '' : await briefOf(scope, staff, task.goal,
      task.projectId ? { id: task.projectId, title: task.projectTitle || '' } : null);
    /* 标准员工库的记忆也只在开头取一次：续跑时 system 已经在 messages 里了 */
    const stdMem = resuming ? '' : await stdMemBrief(staff);
    const messages = resuming
      ? task.messages.slice()
      : [
          { role: 'system', content: buildSystem(staff, task, mem, stdMem) },
          { role: 'user', content: userContent(task.goal, task.files) }
        ];
    /* 老板已经拍过板、这一轮却是从断点重跑：确认内容只靠一次性的 followUp 是留不住的，
       所以在调用前就把答案写进任务上下文。
       这里不再按「文字相同」跳过：连着说两句「继续」是两次真实指令，
       按文字去重会把第二句吞掉，模型就只当没听见。多一句话的 token 远比丢指令便宜。 */
    if (followUp) {
      const fImgs = (followUpImages || []).filter(x => x && (x.dataUrl || x.path)).slice(0, 6);
      messages.push({ role: 'user', content: userContent(followUp, fImgs) });
    }

    /* 老板说过的话单独记一份账：messages 会被压缩/截断，原话不能跟着丢。
       at = 说话时已有的工具步数，用来插回轨迹的对应位置。 */
    if (!Array.isArray(task.userMsgs) || !task.userMsgs.length) {
      const um = [];
      let tools = 0;
      for (const m of (task.messages || [])) {
        if (m.role === 'tool') { tools++; continue; }
        if (m.role !== 'user') continue;
        const c = m.content;
        const txt = typeof c === 'string' ? c
          : Array.isArray(c) ? ((c.find(x => x && x.type === 'text') || {}).text || '') : '';
        if (txt.trim().startsWith('【')) continue;
        if (txt.trim()) um.push({ text: txt.trim(), at: tools });
      }
      if (!um.length && task.goal) um.push({ text: String(task.goal), at: 0 });
      task.userMsgs = um;
    }
    /* 本轮编号：先用界面定的 task.curRound，其次从已有标记里取最大——
       task.rounds 不进数据库，刷新后归零，拿它当真相会让第三句话又挂回第二轮 */
    const _maxTag = arr => (arr || []).reduce((m, x) => Math.max(m, Number(x && x.round) || 0), 0);
    const myRound = Math.max(1, Number(task.curRound) || 0, _maxTag(task.steps), _maxTag(task.userMsgs));
    if (followUp && !task.userMsgs.some(u => u && u.text === String(followUp) && (Number(u.round) || 0) === myRound)) {
      task.userMsgs.push({
        text: String(followUp),
        at: (task.steps || []).filter(s => s.kind === 'tool').length,
        round: myRound
      });
    }

    /* 上一轮没过验收：这一轮开工前先把缺口摆到它面前，
       不然「继续跑」会把同一个毛病再犯一遍——验收的价值一半在回灌。 */
    if (carry && task.verify && task.verify.verdict !== 'pass'
      && (task.verify.gaps || []).length && Number(task.verify.round) !== myRound) {
      messages.push({
        role: 'user',
        content: [
          '【上一轮验收没过】',
          ...task.verify.gaps.slice(0, 3).map((g, i) => `${i + 1}. ${g}`),
          '这一轮先把这些补上，再往下做别的；已经对的内容不要推倒重写。'
        ].join('\n')
      });
    }

    let inTok = carry ? (task.tokens && task.tokens.in) || 0 : 0;
    let outTok = carry ? (task.tokens && task.tokens.out) || 0 : 0;
    /* 流式回显的节流游标：正文一段、工具参数一段，各自独立 */
    let liveBuf = '';
    let livePing = 0;
    let toolPing = 0;
    let status = 'done';
    let blockedCat = null;
    /* 新一轮：界面上的「现场轨迹」清空，但落库的 steps 必须接着长——
       收工时 task.steps 会被整体替换，这里若给空数组，前几轮的步骤和账本就永久没了
       （实测：第一轮的 12s / 9,541 token 在第二轮开始后变成「—」，就是这么丢的）。 */
    const steps = followUp
      ? (task.steps || []).filter(s => s && (Number(s.round) || 1) < myRound).slice()
      : (task.steps || []);
    const stepBase = steps.length; // 续跑时编号接着上一轮，不从头开始
    /* 这一轮的起点：验收时拿它判断文件是不是这一轮写的。
       没有它，上一轮留在盘上的旧文件能让这一轮空跑的任务也算「交付了」。 */
    const roundStart = Date.now();
    const wrote = [];
    /* 这一轮真落盘的文件（含 gen_image / find_image 出的图），用来回答
       「老板要的 PPT 和图片到底做出来没有」——wrote 只认 write 类工具的 path 参数。 */
    const made = [];
    /* 老板这轮要的产出类型（PPT / 图片）：目标 + 本轮每句话一起看，少一句都可能漏掉「顺带做个 PPT」 */
    const wantArt = wantedArtifacts([
      String(task.goal || ''),
      String(followUp || ''),
      ...(task.userMsgs || []).filter(u => Number(u && u.round) === myRound).map(u => String(u.text || ''))
    ].join('\n'));
    let artNudged = 0; // 产出缺口最多退一次：再退就是模型真做不到，别烧钱

    /* ── Task Contract（文档 4.1）──
       以前这些口径散在各处，最要紧的是 task.accept 从来没被写过（见下），
       验收人拿到的一直是 undefined，只能凭「看起来像不像做完了」判——正是文档
       明确禁止的那种判定。契约在这里一次性生成，后续产出门禁、验收人、收尾
       判定都读同一份，不再各说各话。
       只从「目标 + 本轮每句话」推导，纯函数，重算幂等，所以不落库。 */
    const contract = (window.CONTRACT && typeof CONTRACT.build === 'function')
      ? CONTRACT.build(task, {
        wantArtifacts: wantedArtifacts,
        followUp: [
          String(followUp || ''),
          ...(task.userMsgs || []).filter(u => Number(u && u.round) === myRound).map(u => String(u.text || ''))
        ].join('\n'),
        permissions: settings.permissions,
        maxTokens: settings.maxTokens,
        maxSteps: settings.maxSteps
      })
      : null;
    if (contract) {
      task.contract = contract;
      emit({ t: 'contract', contract, round: myRound });
    }
    /* 契约里点了名、但记录里还没落盘的产出物。循环里每步更新，收尾时用它压状态。 */
    let hardMissing = [];
    /* 老板要交东西、却说不出要什么格式：先问，别猜。问过一次就不再拦，避免来回卡住。 */
    const needAskFormat = artNeedAsk([
      String(task.goal || ''),
      String(followUp || ''),
      ...(task.userMsgs || []).filter(u => Number(u && u.round) === myRound).map(u => String(u.text || ''))
    ].join('\n'));
    let askedFormat = false;
    const MAX_NUDGE = 2; // 交付物没落盘时，最多退回重做几次
    let nudges = 0;
    /* 这一轮到底动过手没有。纯对话（「你好」「在吗」）一次工具都不调，
       它不是「活干完了」，是「本来就没活」——两者的验收口径完全不同。 */
    let toolRounds = 0;
    let finished = false;
    let memoItems = [];
    let projectMemoItems = [];
    /* 独立验收：默认证一次；老板在设置里可以关掉（省一次调用） */
    const verifyOn = settings.verify !== false && !!window.JUDGE;
    const MAX_REPAIR = 1; // 验收没过最多退回重做一次，再多就是模型根本做不到，别烧钱
    let repairs = 0;
    let verify = null;
    /* 上一轮已经成立的结论：验收人拿它判「前后一致」，不然它不知道原来定过什么 */
    const prevSay = (task.steps || [])
      .filter(s => s && s.kind === 'say' && (Number(s.round) || 1) < myRound)
      .pop();
    const prevRoundText = (prevSay && prevSay.text) || '';
    /* 验收人：优先不同模型；调用方没给就退回自己验自己（并在 UI 上说清独立度） */
    const judgePick = judge || {
      id: model, name: model, level: 'none',
      reason: '没有可用的第二个模型，验收人与执行人同源'
    };
    /* 最近一次「正文」：模型有时把 Word 正文先写成一段回答、下一轮才调 make_doc，
       所以正文要跨轮留着，不能只认当前这一轮 */
    let lastBody = '';
    const ctxState = {};

    /* 只要有交付物，就用文件系统说了算，不看模型怎么讲 */
    async function deliverablesNow() {
      const r = await verifyPaths(scope, task.deliverables || [], roundStart);
      return r || { checked: false, pass: true, missing: [], detail: [] };
    }

    emit({
      t: 'start', taskId: task.id, resume: carry, round: myRound,
      employee: { name: staff.name, role: staff.role, model }
    });

    for (let step = 0; step < settings.maxSteps; step++) {
      if (inTok + outTok > settings.maxTokens) {
        status = 'budget_exceeded';
        emit({ t: 'budget', spent: inTok + outTok, budget: settings.maxTokens });
        break;
      }
      /* 积分见底就停手：再往下跑就是欠账，
         这一轮已经产出的都留着，充完值说一句「接着做」就能续上 */
      if (window.APP && typeof window.APP.creditLeft === 'function' && window.APP.creditLeft() <= 0) {
        status = 'credit_exhausted';
        emit({ t: 'credit', left: 0 });
        break;
      }

      /* 续跑/长任务时上下文会越滚越大：每轮发出去之前先压一次 */
      try {
        const cc = await compactContext(messages, {
          model, signal, scope, perms: (settings && settings.permissions) || {},
          state: ctxState, step, stepsLeft: settings.maxSteps - step - 1,
          label: String(task.goal || task.id || 'task').slice(0, 24),
          onNotice: s => emit({ t: 'notice', message: `上下文已压缩：${s.before} → ${s.after} token（前面的过程整理成了前情提要）` })
        });
        if (cc.usage && (cc.usage.in || cc.usage.out)) {
          inTok += cc.usage.in; outTok += cc.usage.out;
          emit({ t: 'usage', in: inTok, out: outTok });
        }
      } catch { /* 压缩失败按原样继续 */ }

      let r;
      try {
        /* 老板插话：攒到这一轮发出去，任务跑着也能改方向（带图就走视觉通道） */
        while (injectQ.length) {
          const item = injectQ.shift();
          const txt = typeof item === 'string' ? item : String((item && item.text) || '');
          const imgs = (item && item.images) || [];
          messages.push({ role: 'user', content: userContent(`【老板插话】${txt}`, imgs) });
        }
        /* 每轮重新起一段：上一轮的正文不该残留在这一轮的实时行上 */
        liveBuf = ''; livePing = 0; toolPing = 0;
        emit({ t: 'stream', content: '', reset: true });
        r = await callWithRetry({
          model, messages, signal,
          /* 正文边生成边显示：以前要等整轮返回才一次性冒出来，看着像卡了半分钟 */
          onText: (d) => {
            liveBuf += d;
            const now = Date.now();
            if (now - livePing > 90) { livePing = now; emit({ t: 'stream', content: liveBuf }); }
          },
          /* 推理模型的「想」也是过程：不回显这段时间界面上只有一句『分析中』，
             跑长任务时看着和卡死没区别。整段累积发，前端按折叠块显示。
             超过 8000 字只发尾部：老板看的是「现在在想什么」，不是开头那句客套。 */
          onThink: (txt) => emit({
            t: 'think',
            content: txt.length > 8000 ? '…' + txt.slice(-8000) : txt
          }),
          /* 工具参数（写文件/做表/做 PPT 的正文都在这里）也在流式生成，一并回显进度 */
          onTool: (p) => {
            const now = Date.now();
            if (now - toolPing > 150) { toolPing = now; emit({ t: 'writing', ...p }); }
          },
          onDropImages: () => emit({ t: 'notice', message: '当前模型看不了图片，已按文字继续（图片里的数字建议你直接贴进来）' })
        }, emit);
      } catch (e) {
        const msg = describeLLMError(e);
        emit({ t: 'error', message: msg });
        steps.push({ i: stepBase + step + 1, kind: 'error', text: msg, at: Date.now() });
        status = 'failed';
        break;
      }

      inTok += r.usage.in;
      outTok += r.usage.out;
      emit({ t: 'usage', in: inTok, out: outTok, credit: r.usage.credit, asked: model, served: r.servedModel || '' });

      let roundText = '';
      if (r.content) {
        /* 【记忆】块不给老板看，攒下来等收工一起入库 */
        const mm = splitMemo(r.content);
        if (mm.items.length) memoItems = mm.items;
        if (mm.projectItems && mm.projectItems.length) projectMemoItems = mm.projectItems;
        roundText = mm.body || r.content;
        task.result = roundText || r.content;
        if (roundText) lastBody = roundText;
        emit({ t: 'text', content: task.result });
      }

      if (r.toolCalls.length) { toolRounds += 1; activeWorked = toolRounds; }

      if (!r.toolCalls.length) {
        /* 格式推不出来就别猜，更别拿 md 顶：先问老板要哪种。
           只在「确实要交东西、却说不出交什么」时成立，闲聊不会走到这里。
           已经做出正经文件（docx / png / pptx…）的就不拦，那是模型自己判断对了；
           只写了一份 md 的，正是要拦的对象。 */
        const onlyMd = made.every(p => /\.(md|markdown|txt)$/i.test(String(p)));
        if (!wantArt.length && needAskFormat && onlyMd && !askedFormat) {
          askedFormat = true;
          emit({ t: 'gate', round: nudges + 1, missing: ['产出物格式待确认'] });
          steps.push({
            i: stepBase + step + 1, kind: 'gate', at: Date.now(),
            output: '退回补产出：先问老板要哪种格式'
          });
          if (!task.result) task.result = r.content || '';
          messages.push({ role: 'assistant', content: r.content || '' });
          messages.push({
            role: 'user',
            content: [
              '【产出物格式没定】老板这轮要交东西，但没说要做成什么格式，你也还没问他。',
              '不要自己挑一种、更不要拿 write_file 写一份 .md 交差。现在就调 ask_boss，一次问清：',
              '- 问题：「这份东西要做成哪种？」选项给「Word 文档 / PPT 演示 / Excel 表格 / 图片」。',
              '老板选完你会拿到答案，再按他选的工具做出来。'
            ].join('\n')
          });
          continue;
        }

        /* 老板点了名的格式（PPT / Word / Excel / 图片），这一轮一个都没落盘：退回一次，别拿一份 md 交差。
           权限没开的（没联网画不了图、没写权限做不了文件）就不逼，逼了也是死循环。 */
        const perm = settings.permissions || {};
        const missArt = wantArt.filter(w => {
          if (w.key === 'image' && !perm.net) return false;
          if (w.key === 'pdf') return false; // 没有 PDF 生成器，逼也生不出来，交给提示词去问老板
          if (!perm.write) return false;
          return !made.some(p => w.re.test(String(p)));
        });
        /* 契约硬证据：老板点名的格式到底落盘没有。
           没写权限的不逼（逼了也是死循环），其余一律按「记录里有没有这个文件」判。 */
        if (contract && window.CONTRACT && CONTRACT.check && perm.write) {
          hardMissing = CONTRACT.check(contract, { wrote: [...wrote, ...made] }).missing;
        }
        if (missArt.length && artNudged < 1) {
          artNudged++;
          const names = missArt.map(w => w.name).join('、');
          emit({ t: 'gate', round: nudges + 1, missing: missArt.map(w => w.name) });
          steps.push({
            i: stepBase + step + 1, kind: 'gate', at: Date.now(),
            output: `退回补产出：${names}`
          });
          if (!task.result) task.result = r.content || '';
          messages.push({ role: 'assistant', content: r.content || '' });
          messages.push({
            role: 'user',
            content: [
              `【产出缺口】老板这轮要的 ${names}，工作目录里一个都没有。`,
              ...missArt.map(w => ART_NUDGE[w.key] || `- ${w.name}：用对应工具做出来。`),
              `现在就把 ${names} 做出来，做完再收工；正文里顺便说一句放在哪个路径。`,
              '**用 write_file 写一份 .md 说「这是源文件」等于没交付——md 不是兜底格式。**'
            ].join('\n')
          });
          continue;
        }

        /* 停止条件：交付物真在目录里才算完。不在就退回重做，别让「我说完了」变成收工。 */
        const gate = await deliverablesNow();
        const missing = (gate.missing || []).filter(Boolean);
        if (gate.checked && missing.length && nudges < MAX_NUDGE) {
          nudges++;
          emit({ t: 'gate', round: nudges, missing });
          steps.push({
            i: stepBase + step + 1, kind: 'gate', at: Date.now(),
            output: `退回重做（第 ${nudges} 次）：${missing.join('、')}`
          });
          if (!task.result) task.result = r.content || '';
          messages.push({ role: 'assistant', content: r.content || '' });
          messages.push({
            role: 'user',
            content: [
              `【交付门禁】这些还没真正落盘：${missing.join('、')}。`,
              '不要重复解释，也不要说「我将…」。现在就用工具把它们写出来，写完再收工；',
              '确实写不出来的，说清卡在哪一步、缺什么，然后收工。'
            ].join('\n')
          });
          continue;
        }
        if (gate.checked && missing.length) status = 'unverified';

        /* 交付物的「有没有」已经查过了，这里查「对不对」：
           程序能判的先判死，判不了的交给一个不同模型的验收人（书 7.5.1）。
           不通过就退回重做一次——把 gaps 原话回灌，比让老板自己发现强。 */
        /* 纯对话不验收：这一轮一次工具都没调、也没什么要交的，
           就没有可验的东西——叫验收人来，它只能对着「你好」两个字挑毛病。
           实测代价很大：一句问候因此变成三次模型调用（主调用 → 验收 → 被判不过退回重做），
           9,086 token 里有约 6,000 花在「验一句你好」上，还慢了十几秒。
           验收的对象是产物，不是聊天。 */
        const nothingToVerify = toolRounds === 0
          && !made.length
          && !wantArt.length
          && !(contract && Array.isArray(contract.deliverables) && contract.deliverables.length);
        if (verifyOn && !verify && !nothingToVerify) {
          verify = await judgeTask({
            scope, kind: 'task',
            goal: task.goal,
            /* 验收口径从契约里取：以前这里读 task.accept，而它从来没被写过，
               验收人等于没有尺子。契约生成后至少有「产出物必须落盘」这条硬话。 */
            accept: (window.CONTRACT && contract && CONTRACT.judgeArgs)
              ? CONTRACT.judgeArgs(contract, { hardMissing: hardMissing }).accept
              : task.accept,
            text: task.result || lastBody || r.content || '',
            paths: [...new Set([...(task.deliverables || []), ...wrote])],
            since: roundStart,
            prevText: prevRoundText,
            expectFiles: !!(task.deliverables || []).length,
            model, judge: judgePick, workerName: staff.name, signal
          });
          if (verify) {
            verify.round = myRound;
            inTok += verify.usage ? verify.usage.in : 0;
            outTok += verify.usage ? verify.usage.out : 0;
            emit({ t: 'verify', verdict: verify, round: repairs + 1 });
            steps.push({
              i: stepBase + step + 1, kind: 'verify', at: Date.now(),
              name: window.JUDGE ? window.JUDGE.summary(verify) : '验收',
              ok: verify.verdict === 'pass',
              output: (verify.gaps || []).join('；') || verify.note || ''
            });
            if (verify.usage && (verify.usage.in || verify.usage.out)) emit({ t: 'usage', in: inTok, out: outTok });
            const canRepair = verify.verdict !== 'pass'
              && repairs < MAX_REPAIR
              && step + 2 < settings.maxSteps;
            if (canRepair) {
              repairs++;
              const gate2 = repairText(verify);
              if (!task.result) task.result = r.content || '';
              messages.push({ role: 'assistant', content: r.content || '' });
              messages.push({ role: 'user', content: gate2 });
              verify = null; /* 重做之后再验一次，这次的结果才算数 */
              continue;
            }
          }
        }

        if (!task.result) { task.result = '（模型没有返回内容）'; emit({ t: 'text', content: task.result }); }
        finished = true;
        break;
      }

      messages.push({
        role: 'assistant',
        content: r.content || '',
        tool_calls: r.toolCalls.map(c => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: c.raw || '{}' }
        }))
      });

      let blocked = null;
      /* ask_boss：任务在这里暂停，等老板在界面上选完/填完点确认，答案作为追问开新一轮 */
      let askPending = null;
      for (const c of r.toolCalls) {
        const cat = (cats && cats[c.name]) || 'exec';

        // 参数不合法：直接回给模型，不让它带着坏参数往下演
        if (c.badArgs) {
          const why = '工具参数不是合法 JSON，这一步没执行。请重新生成参数。';
          steps.push({ i: stepBase + step + 1, kind: 'tool', name: c.name, cat, ok: false, output: why, args: {}, ms: 0, verify: { pass: false, why } });
          emit({ t: 'step', kind: 'result', name: c.name, ok: false, output: why, ms: 0, verify: { pass: false, why } });
          messages.push({ role: 'tool', tool_call_id: c.id, content: why });
          continue;
        }

        if (c.name === 'ask_boss') {
          const qs = (Array.isArray(c.args.questions) ? c.args.questions : []).slice(0, 6)
            .map(x => ({
              q: String((x && x.q) || '').trim(),
              options: (x && Array.isArray(x.options) ? x.options : []).map(s => String(s).trim()).filter(Boolean).slice(0, 6),
              multi: !!(x && x.multi)
            }))
            .filter(x => x.q);
          if (!qs.length) {
            const why = 'ask_boss 的 questions 是空的，老板没东西可答。请重新调用，至少给一个带 q 的问题。';
            steps.push({ i: stepBase + step + 1, kind: 'tool', name: c.name, cat, ok: false, output: why, args: {}, ms: 0, verify: { pass: false, why } });
            emit({ t: 'step', kind: 'result', name: c.name, ok: false, output: why, ms: 0, verify: { pass: false, why } });
            messages.push({ role: 'tool', tool_call_id: c.id, content: why });
            continue;
          }
          askPending = { intro: String(c.args.intro || '').trim(), questions: qs };
          steps.push({
            i: stepBase + step + 1, kind: 'tool', name: c.name, cat, ok: true,
            output: `等老板拍板：${qs.length} 个问题`, args: { 问了: qs.length }, ms: 0,
            verify: { pass: true, why: '' }
          });
          emit({ t: 'step', kind: 'result', name: c.name, ok: true, output: `等老板拍板：${qs.length} 个问题`, ms: 0, verify: { pass: true, why: '' } });
          messages.push({ role: 'tool', tool_call_id: c.id, content: '问题已递给老板，他确认后你会拿到答案，届时继续执行。' });
          continue;
        }
        /* 这一轮已经决定停下来问老板了：同轮其余调用一律不执行，但必须补上 tool 回包，
           不然 messages 里 assistant.tool_calls 没有对应 tool 消息，下一次调用会被接口拒 */
        if (askPending) {
          messages.push({ role: 'tool', tool_call_id: c.id, content: '（这一轮以向老板提问为准，此步未执行。）' });
          continue;
        }

        if (cat !== 'none' && !settings.permissions[cat]) {
          blocked = { category: cat, tool: c.name };
          blockedCat = blockedCat || cat;
          emit({ t: 'need_permission', category: cat, tool: c.name });
          steps.push({ i: stepBase + step + 1, kind: 'blocked', name: c.name, cat, at: Date.now() });
          messages.push({
            role: 'tool', tool_call_id: c.id,
            content: `用户没有开启「${cat}」类权限，这一步被拦截了。不要重试，直接说明你需要这项权限。`
          });
          continue;
        }

        emit({ t: 'step', kind: 'call', name: c.name, args: c.args });

        /* 敏感操作审批：开了「先问一下」，写盘/跑命令前先挂起等老板放行 */
        if (settings.approve && (cat === 'write' || cat === 'exec')) {
          const aid = 'ap' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          emit({ t: 'need_approval', id: aid, name: c.name, args: c.args });
          const allowed = await waitApproval(aid, signal);
          if (!allowed) {
            const why = '老板没有放行这一步，已跳过';
            steps.push({ i: stepBase + step + 1, kind: 'tool', name: c.name, cat, ok: false, output: why, args: c.args, ms: 0, verify: { pass: false, why } });
            emit({ t: 'step', kind: 'result', name: c.name, ok: false, output: why, ms: 0, verify: { pass: false, why } });
            messages.push({
              role: 'tool', tool_call_id: c.id,
              content: `${why}。改用不需要${cat === 'write' ? '写盘' : '执行命令'}的做法，或者在结尾说明卡在哪。`
            });
            continue;
          }
        }

        let payload;
        try {
          /* 写 Word 时正文已经写在回答里了：这里把它补进参数，
             模型不需要再把同一篇正文塞一遍 JSON —— 这一步省的就是那份输出 token */
          let toolArgs = c.args;
          if (c.name === 'make_doc'
            && !(Array.isArray(c.args.blocks) && c.args.blocks.length)
            && !c.args.markdown
            && (roundText || lastBody)) {
            toolArgs = { ...c.args, markdown: roundText || lastBody };
          }
          payload = await execTool(scope, c.name, toolArgs, settings.permissions, signal);
        } catch (e) {
          payload = { blocked: false, result: { name: c.name, ok: false, output: '执行失败：' + e.message, ms: 0, verify: { pass: false, why: e.message } } };
        }

        const out = payload.result || {};
        const v = out.verify || { pass: true, why: '' };

        if (payload.blocked) {
          blocked = { category: payload.category, tool: c.name };
          blockedCat = blockedCat || payload.category;
          emit({ t: 'need_permission', category: payload.category, tool: c.name });
          steps.push({ i: stepBase + step + 1, kind: 'blocked', name: c.name, cat: payload.category, at: Date.now() });
          messages.push({ role: 'tool', tool_call_id: c.id, content: out.output || '被权限拦截' });
          continue;
        }

        steps.push({
          i: stepBase + step + 1, kind: 'tool', name: c.name, cat,
          args: c.args, ok: out.ok, output: out.output, ms: out.ms, at: Date.now(), verify: v,
          /* 改完自动跑测试的结论：null 表示没跑（不是代码文件 / 没有测试 / 没开 exec） */
          tests: out.tests || undefined,
          files: Array.isArray(out.files) && out.files.length ? out.files : undefined
        });
        emit({ t: 'step', kind: 'result', name: c.name, ok: out.ok, output: out.output, ms: out.ms, verify: v,
          tests: out.tests || undefined,
          files: Array.isArray(out.files) ? out.files : [] });

        if (out.wrote) { wrote.push(out.wrote); made.push(String(out.wrote)); }
        if (Array.isArray(out.files)) for (const f of out.files) made.push(String(f));

        /* 大块材料先过子 Agent 隔离：主上下文只收结论，原文不进来 */
        let toolContent = v.pass
          ? String(out.output || '')
          : `${out.output}\n\n【校验未通过】${v.why}。这一步没有真正生效，请换一种做法重试，不要当作已完成。`;
        const iso = v.pass ? await maybeIsolate({
          model, signal, toolName: c.name, args: c.args, text: toolContent, goal: task.goal
        }) : null;
        if (iso) {
          toolContent = iso.summary;
          inTok += iso.usage.in; outTok += iso.usage.out;
          /* run 这条线没有「读过就跳过」的记账，重复读本来就允许，不用解锁 */
        }
        messages.push({
          role: 'tool', tool_call_id: c.id,
          content: toolContent
        });
      }

      /* 这一轮要等老板拍板：任务暂停，答案会作为追问开新一轮 */
      if (askPending) {
        task.pendingAsk = askPending;
        task.result = r.content || task.result || '';
        status = 'need_input';
        finished = true;
        /* 提问这一轮也要同步上下文再 break：不同步的话，落库的 messages 还停在「提问之前」，
           重开对话既还原不出选项卡，模型也不知道自己问过什么。 */
        task.messages = leanMessages(messages);
        emit({ t: 'need_input', intro: askPending.intro, questions: askPending.questions });
        break;
      }

      /* 每轮结束把上下文同步回任务对象：浏览器里的执行一旦被刷新打断，
         靠这份 messages 才能真正「接着做」，否则续跑等于从头重新分析一遍 */
      task.messages = leanMessages(messages);

      if (blocked && r.toolCalls.every(c => {
        const k = (cats && cats[c.name]) || 'exec';
        return k !== 'none' && !settings.permissions[k];
      })) {
        status = 'blocked';
        task.blockedOn = blocked.category;
        break;
      }
    }

    if (blockedCat && status === 'done') status = 'blocked';
    /* 步数用完还没自然收工：如实标出来，不伪装成「已完成」 */
    if (!finished && status === 'done') status = 'step_limit';

    // 交付物校验：声明了要产出什么，就必须真有。没有交付物的任务只能叫「它说做完了」
    const dv = await deliverablesNow();

    task.deliverableCheck = dv;
    task.verified = dv.checked ? dv.pass : null;
    if (dv.checked && !dv.pass && (status === 'done' || status === 'blocked')) status = 'unverified';

    /* ── 契约硬证据（文档原话：不得仅凭 Agent 自述判定完成）──
       deliverables 只核老板自己填的那几项；契约还包含他从话里点名的格式
       （「顺带做个 ppt」这种）。两者合起来才算证据：记录里找得到对应文件
       才允许停在 done，找不到就如实降级成「产出缺失」。
       这里不再退回重做——循环已经退过 MAX_NUDGE 次，再退只是烧钱，
       标清楚缺什么比假装做完有用。 */
    const canWrite = !!(settings.permissions && settings.permissions.write);
    if (contract && canWrite && window.CONTRACT && CONTRACT.check) {
      const ev = CONTRACT.check(contract, { wrote: [...wrote, ...made] });
      hardMissing = ev.missing || [];
      task.evidence = {
        checked: !!ev.checked, pass: !!ev.pass, missing: hardMissing,
        basis: ev.basis, at: Date.now()
      };
      if (ev.checked && !ev.pass && (status === 'done' || status === 'blocked')) status = 'unverified';
    } else if (hardMissing.length && (status === 'done' || status === 'blocked')) {
      status = 'unverified';
    }

    /* 文件都在，但验收人说不能用：状态从 done 降成 weak。
       unverified（文件没落实）比 weak 更具体，别互相盖掉。 */
    if (verify) {
      task.verify = verify;
      if (verify.verdict !== 'pass' && status === 'done') status = 'weak';
    } else if (verifyOn && status === 'done' && task.verify
      && Number(task.verify.round) === myRound && task.verify.verdict !== 'pass') {
      /* 这一轮验过、但因为别的原因没走到收工流程：结论还算数，别让状态悄悄变回 done */
      status = 'weak';
    }

    task.status = status;
    if (blockedCat) task.blockedOn = blockedCat;
    /* 每一步都标上「第几轮」，对话才能按轮排回去 */
    for (const s of steps) if (s && s.round === undefined) s.round = myRound;
    /* 本轮账本：累计 token + 本轮耗时。界面按「这轮累计 − 上轮累计」算这一轮花了多少 */
    steps.push({
      kind: 'round', round: myRound, at: Date.now(),
      ms: Date.now() - t0, tokIn: inTok, tokOut: outTok
    });
    task.steps = steps;
    task.rounds = Math.max(Number(task.rounds) || 1, myRound);
    task.curRound = myRound;
    /* 续跑要靠 messages[0] 那段 system，截断时先把它留住 */
    const head = messages[0] && messages[0].role === 'system' ? [messages[0]] : [];
    task.messages = leanMessages(head.concat(messages.slice(head.length).slice(-39)));
    task.tokens = { in: inTok, out: outTok };
    /* 评测口径：把这一趟的调用次数、首 token 延迟分布、推理与缓存 token 一起交出去。
       续跑时跟 token 一样累加，否则第二次追问会把第一趟的账抹掉。 */
    task.metrics = {
      calls: (carry ? Number(task.metrics && task.metrics.calls) || 0 : 0) + METER.calls,
      llmMs: (carry ? Number(task.metrics && task.metrics.llmMs) || 0 : 0) + METER.ms,
      ttftP50: pctOf(METER.ttft, 50),
      ttftP95: pctOf(METER.ttft, 95),
      ttftContentP50: pctOf(METER.ttftContent, 50),
      ttftN: METER.ttft.length,
      reasoningTokens: (carry ? Number(task.metrics && task.metrics.reasoningTokens) || 0 : 0) + METER.reasoning,
      cachedTokens: (carry ? Number(task.metrics && task.metrics.cachedTokens) || 0 : 0) + METER.cached,
      served: METER.served || '',
      models: METER.models.slice()
    };
    METER = null;
    task.ms = Date.now() - t0;
    task.wrote = [...new Set(wrote)];

    /* 只把「真做完」的任务写进记忆：失败、超步数、卡权限的中间稿一律不记，
       否则员工会拿一次半成品的结论当经验反复用。 */
    if (memoItems.length && status === 'done') {
      const mr = await saveMemo(scope, staff, memoItems,
        '任务：' + String(task.goal || '').slice(0, 24), task.id);
      if (mr.added) {
        task.memo = memoItems;
        emit({ t: 'notice', message: `记下 ${mr.added} 条候选记忆（记忆面板点「采纳」后才生效）` });
      }
      if (mr.superseded) {
        emit({ t: 'notice', message: `更正了 ${mr.superseded} 条旧记忆（旧的已标成「已被取代」，不再参与判断）` });
      }
      if (mr.rejected && mr.rejected.length) {
        const kinds = [...new Set(mr.rejected.map(x => x.kind))].join('、');
        emit({ t: 'notice', message: `有 ${mr.rejected.length} 条记忆看着含${kinds}，按规矩没记` });
      }
    }
    /* 项目里确认的共用结论：写进项目共享记忆，项目里谁接着干都能拿到 */
    if (projectMemoItems.length && status === 'done' && task.projectId) {
      const pr = await saveProjectMemo(scope, task.projectId, task.projectTitle || '',
        projectMemoItems, '任务：' + String(task.goal || '').slice(0, 24), task.id);
      if (pr.added) emit({ t: 'notice', message: `写进项目共享记忆 ${pr.added} 条（项目里同事共用）` });
    }

    emit({ t: 'done', task });
    return task;
  }

  function describeLLMError(e) {
    const code = (e && e.error && e.error.code) || (e && e.code) || '';
    const raw = (e && e.error && e.error.message) || (e && e.message) || '模型调用失败';
    /* 任何错误文本进界面前先过净化：拦截页 HTML / 大段标签一律不许原样出现 */
    const base = sanitizeErrText(raw);
    const rid = e && e.requestId ? `（requestId: ${e.requestId}）` : '';
    if (String(code).startsWith('quota_')) return `云端额度不够或触发限流：${base}${rid}`;
    /* 「域名不匹配」是浏览器直连时代的说法：那时通道按 Origin 认应用。
       v0.4 起服务端直连，鉴权靠用户 token，出错更可能是 token 过期或被吊销，
       所以这里两种可能都列，不替用户下结论。
       服务端那条路会把原因写在 message 里（「模型通道鉴权没过…」），
       已经说清的事不再套一层前缀——两句话叠在一起只会让人以为出了两个问题。 */
    if (String(code).startsWith('auth_')) {
      return /模型通道/.test(base) ? `${base}${rid}` : `云端鉴权没过（登录态可能已失效）：${base}${rid}`;
    }
    if (String(code).startsWith('request_')) return `请求参数或模型不匹配：${base}${rid}`;
    if (String(code).startsWith('model_') || String(code).startsWith('gateway_')) return `模型服务暂时不可用，可以稍后重试：${base}${rid}`;
    if (e && e.name === 'AbortError') return '你手动停了这一次执行';
    return `${base}${rid}`;
  }

  window.BOSS = {
    PERSONAS, run, loadTools, toolLoop, verifyPaths,
    briefOf, saveMemo, saveProjectMemo, splitMemo,
    buildSystem, pickTools, wantedArtifacts, artNeedAsk, ART_FORMS,
    sanitizeErrText, looksLikeBlockPage, leanForWaf,
    inject, approve
  };
})();
