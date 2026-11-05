/* 项目：老板给一个主题 → 牵头人拆成要老板拍板的问题 → 老板确认/纠正 →
   牵头人拆执行路径并分派给对口成员 → 成员按方法论各自分析 → 牵头人出项目纪要。
   模型走云端 LLM 通道；项目内容落云库 ba_meetings（按 owner_id 隔离）。 */
(function () {
  const ST_LABEL = {
    briefing: '拆题中', awaiting: '等你拍板', planning: '拆解中',
    confirm: '等你确认', analyzing: '成员分析中', done: '已出纪要', failed: '中断',
    /* 积分烧到 0：项目不是失败，是「付不起继续跑」，充值后能从断点接上 */
    halted: '积分用完已停'
  };
  const ST_DOT = {
    briefing: 'running', awaiting: 'blocked', planning: 'running',
    confirm: 'blocked', analyzing: 'running', done: 'done', failed: 'failed',
    halted: 'blocked'
  };
  const BUSY = new Set(['briefing', 'planning', 'analyzing']);

  /* token 预算：单节到 8 万就停手，整场到老板设的上限（默认 60 万）停下来问老板。
     节内步数与整场上限都可以在「设置」里改，这里只放兜底常量。
     不硬杀——停在原地等一句「继续」或「就这样出纪要」。 */
  const BUD = { node: 80000, total: 600000, raise: 300000 };

  /* 老板在设置里定的项目额度。读不到（老版本设置）就退回常量，老项目行为不变。 */
  function limOf() {
    const s = (window.APP && window.APP.state && window.APP.state.settings) || {};
    const st = Number(s.projSteps);
    const tk = Number(s.projTokens);
    return {
      steps: st > 0 ? Math.max(2, Math.min(30, Math.round(st))) : 6,
      tokens: tk > 0 ? Math.max(20000, Math.round(tk)) : BUD.total
    };
  }
  /* 成稿那一节要多给几步：读几份 md + 搜图 / 排版 + 修一轮，6 步必然卡在中途。
     PPT / Word / Excel / 图片都是成品，都要多给；只有 .md 中间稿按默认步数。 */
  function nodeSteps(deliver) {
    const n = limOf().steps;
    return /\.(pptx|docx|xlsx|png|jpe?g|webp|pdf)$/i.test(deliver || '') ? n + 5 : n;
  }
  /* 单节 token 上限：不许超过整场上限，否则一节就能把整个项目烧穿 */
  function nodeBudget() {
    return Math.min(BUD.node, limOf().tokens);
  }

  /* 「主岗位 · 次级岗位」在项目里只显示次级，避免参会人那一行被撑爆 */
  function shortRole(r) {
    const t = String(r || '');
    const i = t.lastIndexOf(' · ');
    return i >= 0 ? t.slice(i + 3) : t;
  }
  /* 提示词里带上主岗位线，免得把银行产品经理当成互联网产品经理 */
  function rolePhrase(r) {
    const t = String(r || '');
    const i = t.lastIndexOf(' · ');
    return i >= 0 ? `${t.slice(i + 3)}，${t.slice(0, i)}线` : t;
  }

  const S = () => window.APP.state;
  const esc = s => window.APP.esc(s);
  const md = s => window.APP.mdLite(s);
  const el = id => document.getElementById(id);
  const cur = () => S().meetings.find(m => m.id === S().curMeetingId) || null;

  /* 这一场是不是正开着。
     项目在后台跑的时候，老板可能已经点开另一场了：数据都写在各自的 m 上（安全），
     但 DOM 只有一个盒子，而节点 id 全是 T1/T2 这种，百分百撞号——
     不看这一眼，A 项目的进度文案和流式正文就会长在 B 项目的行里
     （对齐任务线 2026-11-03 的「A 的反馈跑到 B」）。 */
  const onScreen = (m) => !!m && S().curMeetingId === m.id;

  /* 重绘主区：不是当前这一场就别画——后台项目每秒重绘一次，
     会把老板正在看的那一场的滚动位置和阅读位置一直打断。 */
  const renderIfOpen = (m) => { if (onScreen(m)) render(); };
  /* 进气泡的报错先净化：WAF 拦截页那种整页 HTML 绝不能原样吐进对话 */
  const niceErr = e => {
    const raw = String((e && e.message) || e || '');
    const s = (window.BOSS && window.BOSS.sanitizeErrText) ? window.BOSS.sanitizeErrText(raw) : raw;
    return String(s || raw).replace('点「继续跑」我会用精简过的上下文重试', '可以再 @ 他一次接着干');
  };

  /* ── 每场会一个工作目录：项目/2026-10-30-主题/ ── */
  function dirOf(m) {
    if (m.dir) return m.dir;
    const d = new Date(m.at || Date.now());
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const slug = String(m.topic || '议题').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || '议题';
    m.dir = `会议/${ymd}-${slug}`;
    return m.dir;
  }

  /* 节点产出的文件名：不许带路径、不许空，缺了就用 id + 标题兜 */
  function deliverName(raw, id, title) {
    let s = String(raw || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
    if (!s || /^-+$/.test(s)) s = `${id}-${String(title || '结论').replace(/[\\/:*?"<>|\s]+/g, '')}`;
    /* 认得出的后缀都放过：老板要成品 Word / Excel / 图片时，别给它补成「xx.docx.md」 */
    if (!/\.(md|txt|csv|json|pptx|docx|xlsx|pdf|png|jpe?g|webp|html)$/i.test(s)) s += '.md';
    return s.slice(0, 60);
  }

  /* 工具能不能用：要有工作区、要有写权限、模型得支持工具调用、服务端得在 */
  function canUseTools(model) {
    const st = S();
    const perm = (st.settings && st.settings.permissions) || {};
    if (!window.BOSS || typeof window.BOSS.toolLoop !== 'function') return false;
    if (!st.scope || !perm.write) return false;
    const md = (st.models || []).find(x => x.id === model);
    if (md && md.supportsToolCall === false) return false;
    return true;
  }

  /* ── 新建项目 / 任务转项目：共用同一个弹窗 ──
     两种来源字段完全一致：主题 + 项目经理 + 项目牵头人 + 项目成员。
     成员表底部有「只选核心」「全选」两个快捷选择；项目经理和牵头人自动算成员，取消不掉。 */
  let pick = new Set();          // 选中的成员 id
  let mtMode = 'create';         // create（新建）| convert（任务转项目）
  let mtTask = null;             // convert 模式下的原任务
  let mtHandover = null;         // convert 模式下的前情材料
  let mtPM = '', mtChief = '';   // 当前选中的项目经理 / 牵头人

  const aiStaff = () => S().staff.filter(s => s.kind !== 'human');
  /* 认 Lie 岗：项目经理/秘书/PM 优先当项目经理；没有就取第一位 AI 员工。
     staff 可以外部传进来，方便单测在沙箱里跑（不碰全局 state）。 */
  function pmCandidate(prefer, staffArg) {
    const staff = staffArg || aiStaff();
    if (prefer && /项目经理|秘书|PM/.test(prefer.role || '')) return prefer;
    return staff.find(s => /项目经理|秘书|PM/.test(s.role || '')) || prefer || staff[0] || null;
  }

  /* 上一个项目的班底是谁。
     为什么要这个：同一拨人连着开项目，每次弹窗都把项目经理重猜一遍，
     猜出来的还是「谁挂着项目经理岗」，老板想换的那个人每次都要重选。
     按最近更新时间取（不是数组顺序——数组受左侧拖动排序影响），
     人和岗可能已被删/改名，所以只认还在职的 AI 员工。 */
  function lastProjectRoles() {
    const list = (S().meetings || []).slice().sort(
      (a, b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0)
    );
    const alive = new Set(aiStaff().map(s => s.id));
    for (const m of list) {
      const pm = pmOf(m);
      const chief = chiefOf(m);
      const pmId = pm && alive.has(pm.id) ? pm.id : '';
      const chiefId = chief && alive.has(chief.id) ? chief.id : '';
      if (pmId || chiefId) return { pmId, chiefId };
    }
    return { pmId: '', chiefId: '' };
  }

  /* 弹窗的默认班子（纯函数，单测直接喂数据）：
     1) 项目经理沿用上一个项目那位；没有上一场、或者那位已不在职，才按岗位重猜。
     2) 牵头人默认换一个人当（拆解和施工分开），但也不跨项目乱换——
        上一个项目的牵头人还在，就继续是他；他正好是项目经理时另找一个。
     3) 成员默认一个人都不额外勾，只有项目经理和牵头人；
        「只选核心」「全选」是老板点了才加的档，再点一次退回这两个人。 */
  function defaultCrew(last, staff, task) {
    const ids = new Set((staff || []).map(s => s.id));
    const curEmp = task ? (staff.find(s => s.id === task.employeeId) || null) : null;
    const guess = pmCandidate(curEmp, staff) || (staff || [])[0] || null;
    const pmId = (last && last.pmId && ids.has(last.pmId) ? last.pmId : '') || (guess && guess.id) || '';
    let chiefId = (last && last.chiefId && ids.has(last.chiefId) && last.chiefId !== pmId)
      ? last.chiefId : '';
    if (!chiefId) {
      const other = staff.find(s => s.id !== pmId) || staff[0] || null;
      chiefId = (other && other.id) || pmId;
    }
    /* 默认一个人都不额外勾：成员里只有项目经理和牵头人。
       「只选核心」「全选」是老板主动点才加的档，再点一次退回这两个人。 */
    const set = new Set();
    if (pmId) set.add(pmId);
    if (chiefId) set.add(chiefId);
    return { pmId, chiefId, memberIds: [...set] };
  }
  function staffOptions(selId) {
    return aiStaff().map(s =>
      `<option value="${esc(s.id)}" ${s.id === selId ? 'selected' : ''}>${esc(s.name)} · ${esc(shortRole(s.role))}</option>`
    ).join('');
  }

  /* 牵头人默认换一个人当（拆解和施工分开）；只有一个员工时允许兼任 */
  function fillPM(v) {
    mtPM = v || mtPM;
    el('mtPM').innerHTML = staffOptions(mtPM);
    if (!mtChief || mtChief === mtPM) {
      mtChief = (aiStaff().find(s => s.id !== mtPM) || aiStaff()[0] || {}).id || mtPM;
    }
    el('mtChief').innerHTML = staffOptions(mtChief);
    el('mtPM').value = mtPM;
    el('mtChief').value = mtChief;
    syncRoles();
  }
  function fillChief(v) {
    mtChief = v || mtChief;
    el('mtChief').innerHTML = staffOptions(mtChief);
    el('mtChief').value = mtChief;
    syncRoles();
  }
  /* 换了项目经理 / 牵头人，就把他算进成员里（不用再单独勾） */
  function syncRoles() {
    [mtPM, mtChief].forEach(id => { if (id) pick.add(id); });
    renderPick();
  }

  function openCreate(opts = {}) {
    mtMode = opts.from ? 'convert' : 'create';
    mtTask = opts.from || null;
    mtHandover = opts.handover || null;
    pick = new Set();
    mtPM = ''; mtChief = '';
    const staff = aiStaff();
    if (!staff.length) return window.APP.toast('还没有 AI 员工，先去「员工」里建一位');

    if (mtMode === 'convert') {
      const t = mtTask;
      /* 默认班子：项目经理 / 牵头人沿用上一个项目，成员只勾核心（不是全选） */
      const crew = defaultCrew(lastProjectRoles(), staff, t);
      mtPM = crew.pmId;
      mtChief = crew.chiefId;
      pick = new Set(crew.memberIds);
      fillPM(mtPM);
      el('mtTopic').value = String(t.title || t.goal || '').slice(0, 60);
      el('mtTitle').textContent = '转为项目';
      el('mtSub').textContent = '原任务的对话和产出会提炼成一份《前情简报》带给全体成员，不用每人重读原文。下面定项目组的三个角色。';
      el('mtCreate').textContent = '确认，转为项目';
    } else {
      const crew = defaultCrew(lastProjectRoles(), staff, null);
      mtPM = crew.pmId;
      mtChief = crew.chiefId;
      pick = new Set(crew.memberIds);
      fillPM(mtPM);
      el('mtTopic').value = '';
      el('mtTitle').textContent = '新建项目';
      el('mtSub').textContent = '先给一句主题；再定项目经理、牵头人和成员。牵头人把目标拆成子任务分给对口的同事施工，项目经理盯推进。';
      el('mtCreate').textContent = '成立项目';
    }
    el('mtPickCore').textContent = '只选核心';
    syncRoles();
    el('mtModal').hidden = false;
    setTimeout(() => el('mtTopic').focus(), 60);
  }

  function renderPick() {
    /* 核心置顶，其余按名字首字母 A→Z（和右栏员工列表一致） */
    const raw = S().staff;
    const all = window.NAMEORDER ? window.NAMEORDER.sortStaff(raw) : raw;
    const box = el('mtPickGrid');
    if (!all.length) {
      box.innerHTML = '<div class="hint-block">还没有员工。先去右栏建一个。</div>';
      el('mtPickNote').textContent = '已选 0 人';
      return;
    }
    box.innerHTML = all.map(s => {
      const human = s.kind === 'human';
      const isPM = s.id === mtPM, isChief = s.id === mtChief;
      const lock = isPM || isChief;
      const tag = isPM ? '<i class="pick-tag">项目经理</i>'
        : isChief ? '<i class="pick-tag">牵头人</i>' : '';
      return `<div class="pick ${pick.has(s.id) ? 'on' : ''} ${human ? 'human' : ''} ${lock ? 'lock' : ''}" data-id="${esc(s.id)}">
        <div class="pick-n"><b>${esc(s.name)}</b><i class="tag-ai ${human ? 'human' : 'ai'}">${human ? '真人' : 'AI'}</i>${s.core ? '<i class="tag-core">核心</i>' : ''}${tag}</div>
        <div class="pick-r" title="${esc(s.role)}">${esc(shortRole(s.role))}${human ? ' · 只接待办' : ''}</div>
      </div>`;
    }).join('');
    box.querySelectorAll('.pick').forEach(n => {
      n.onclick = () => {
        const id = n.dataset.id;
        if (id === mtPM || id === mtChief) {
          return window.APP.toast('项目经理和牵头人已经在项目里了，取消不掉');
        }
        if (pick.has(id)) pick.delete(id); else pick.add(id);
        n.classList.toggle('on', pick.has(id));
        countPick();
      };
    });
    countPick();
  }

  function countPick() {
    const sel = S().staff.filter(s => pick.has(s.id));
    const ai = sel.filter(s => s.kind !== 'human').length;
    const hu = sel.length - ai;
    el('mtPickNote').textContent = `已选 ${sel.length} 人（AI ${ai}${hu ? ' · 真人 ' + hu : ''}）`;
    paintQuick();
  }

  /* 「只选核心」「全选」是两档开关，不是一次性按钮：
     当前已经是这一档 → 再点一次退回「只有项目经理和牵头人」；
     否就勾上这一档。核心档处在全选状态下点，是切到核心档（不是取消）。 */
  function quickPick(mode, cur, base, core, all) {
    const set = new Set(cur || []);
    const allOn = all.length > 0 && all.every(id => set.has(id));
    const coreOn = core.length > 0 && core.every(id => set.has(id));
    if (mode === 'all') {
      if (allOn) return [...base];
      return [...new Set(base.concat(all))];
    }
    if (coreOn && !allOn) return [...base];
    return [...new Set(base.concat(core))];
  }
  const baseIds = () => [mtPM, mtChief].filter(Boolean);
  const coreIds = () => aiStaff().filter(s => s.core || /秘书/.test(s.role || '')).map(s => s.id);
  const allIds = () => aiStaff().map(s => s.id);

  function pickCore() {
    pick = new Set(quickPick('core', pick, baseIds(), coreIds(), allIds()));
    syncRoles();
  }
  function pickAll() {
    pick = new Set(quickPick('all', pick, baseIds(), coreIds(), allIds()));
    syncRoles();
  }
  /* 两个快捷按钮的亮/灭：不亮 = 现在只有项目经理和牵头人 */
  function paintQuick() {
    const c = el('mtPickCore'), a = el('mtPickAll');
    const all = allIds(), core = coreIds();
    const allOn = all.length > 0 && all.every(id => pick.has(id));
    const coreOn = core.length > 0 && core.every(id => pick.has(id));
    if (a) a.classList.toggle('on', allOn);
    if (c) c.classList.toggle('on', coreOn && !allOn);
  }

  /* id 列表 → 项目成员（含 pm / chief 标记，兼任时两个标记同时给一个人） */
  function buildParticipants(ids, pmId, chiefId) {
    const staff = S().staff;
    return (ids || []).map(id => staff.find(s => s.id === id)).filter(Boolean).map(s => ({
      id: s.id, name: s.name, role: s.role, persona: s.persona,
      /* 性格四维度跟着人走：每一节的提示词都靠这四个字段决定「怎么说」 */
      gender: s.gender || '', zodiac: s.zodiac || '', sign: s.sign || '', mbti: s.mbti || '',
      /* 标准员工库的出处：项目侧靠它实时读训练记忆 */
      stdId: Number(s.stdId) || 0,
      model: s.model || '', kind: s.kind || 'ai', core: !!s.core,
      notes: s.notes || '', pm: s.id === pmId, chief: s.id === chiefId
    }));
  }

  async function createFromModal() {
    const topic = el('mtTopic').value.trim();
    if (!topic) return window.APP.toast('先写一句项目主题');
    mtPM = el('mtPM').value;
    mtChief = el('mtChief').value;
    syncRoles();
    const participants = buildParticipants([...pick], mtPM, mtChief);
    if (participants.length < 2) return window.APP.toast('项目至少要拉 2 位成员');
    if (!S().models.length) return window.APP.toast('模型通道还没就绪，等两秒再试');

    el('mtModal').hidden = true;
    if (mtMode === 'convert' && mtTask) {
      return convertFromTask({
        task: mtTask, pmId: mtPM, chiefId: mtChief, memberIds: [...pick],
        handover: mtHandover, topic
      });
    }
    /* 附件在开会前就上传好了，这里只取清单 */
    const atts = window.ATT_MEET ? window.ATT_MEET.take() : [];
    return createProject({ topic, participants, files: atts });
  }

  /* 项目经理：优先秘书岗，否则取第一位成员。标记写在 participants 上，
     这样换设备、刷新页面也能认出来（云端只存 participants，没有单独的 pm 字段）。 */
  function markPM(participants) {
    let pm = participants.find(p => /秘书|项目经理|PM/.test(String(p.role || ''))) || participants[0];
    if (!pm) return null;
    participants.forEach(p => { p.pm = p === pm; });
    return pm;
  }
  function pmOf(m) {
    const ps = m.participants || [];
    return ps.find(p => p.pm) || ps.find(p => /秘书/.test(String(p.role || ''))) || ps[0] || { name: '', role: '' };
  }
  /* 项目牵头人：负责拆解、分工、汇总整理。转项目时明确指定；老项目回退给项目经理。 */
  function chiefOf(m) {
    const ps = m.participants || [];
    return ps.find(p => p.chief) || ps.find(p => p.pm) || ps[0]
      || { name: '牵头人', role: '', persona: 'rigor' };
  }
  /* 原任务带来的前情（转项目时写入 m.messages，云端 messages 列一直有映射） */
  function originOf(m) {
    return (Array.isArray(m.messages) ? m.messages : []).find(x => x && x.kind === 'origin') || null;
  }
  const PRI_W = { P0: 0, P1: 1, P2: 2 };

  async function createProject({ topic, participants, files }) {
    if (!S().models.length) return window.APP.toast('模型通道还没就绪，等两秒再试');
    /* 弹窗里已经定好了项目经理 / 牵头人就不再猜；只有快捷入口（createQuick）才按岗位回退 */
    let pm = participants.find(p => p.pm) || markPM(participants);
    if (!participants.find(p => p.chief) && pm) pm.chief = true;
    const chief = participants.find(p => p.chief) || pm;
    const m = {
      id: window.APP.newId().replace(/^t/, 'm'),
      topic, status: 'briefing', participants,
      files: files || [], docText: '',
      messages: [], brief: null, plan: null, outputs: [], minutes: null,
      tokens: { in: 0, out: 0 }, ms: 0,
      pending: { answers: {}, note: '' },
      at: Date.now(),
      updatedAt: Date.now()
    };
    const st = S();
    if (!st.guest) {
      try {
        const made = await window.CLOUD.createMeeting(m);
        m.rowId = made.rowId;
      } catch (e) {
        window.APP.toast('项目没存上云端：' + e.message);
      }
    }
    st.meetings.unshift(m);
    st.curMeetingId = m.id;
    st.view = 'meeting';
    st.lastListView = 'project';
    window.APP.showView('meeting');
    renderList();
    render();
    runBrief(m);
    if (pm) window.APP.toast(`已按项目启动 · 项目经理 ${pm.name} · 牵头人 ${(chief || pm).name}${chief && chief.id === pm.id ? '（兼任）' : ''}`);
    return m;
  }

  /* 输入区勾了多位员工：直接按项目跑，第一位（或秘书岗）当项目经理 */
  function createQuick({ topic, memberIds, files }) {
    const staff = S().staff;
    const participants = (memberIds || [])
      .map(id => staff.find(s => s.id === id))
      .filter(Boolean)
      .map(s => ({
        id: s.id, name: s.name, role: s.role, persona: s.persona,
      /* 性格四维度跟着人走：每一节的提示词都靠这四个字段决定「怎么说」 */
      gender: s.gender || '', zodiac: s.zodiac || '', sign: s.sign || '', mbti: s.mbti || '',
        model: s.model || '', kind: s.kind || 'ai', core: !!s.core,
        notes: s.notes || ''
      }));
    if (participants.length < 2) return window.APP.toast('至少选 2 位员工才会转成项目');
    const t = String(topic || '').trim();
    return createProject({ topic: t.length > 60 ? t.slice(0, 60) + '…' : t, participants, files: files || [] });
  }

  /* ── 任务转项目 ──
     老板在任务页点「转项目」：指定项目经理 / 牵头人 / 成员，
     原任务的对话与产出先提炼成一份《前情简报》，全员共用这一份，
     子任务 prompt 只注入简报，不让每个参与人反复读原文烧 token。
     牵头人自动开始拆解（拆题 → 拆分工），需要老板拍板的地方走确认板。 */
  async function convertFromTask({ task, pmId, chiefId, memberIds, handover, topic }) {
    const st = S();
    const participants = buildParticipants(memberIds, pmId, chiefId);
    const pm = participants.find(p => p.pm);
    const chief = participants.find(p => p.chief) || pm;
    const workers = participants.filter(p => !p.pm && !p.chief);
    if (!pm || !chief) return window.APP.toast('员工选的有问题，重新选一下');
    const m = {
      id: window.APP.newId().replace(/^t/, 'm'),
      topic: String(topic || task.title || task.goal || '未命名项目').slice(0, 60),
      status: 'briefing', participants,
      files: [], docText: '',
      /* messages[0] 固定放「转项目来源」：原任务是谁、前情简报是什么。
         这列云端一直有映射、项目流程原本不用，正好拿来持久化。 */
      messages: [{
        kind: 'origin',
        taskId: task.id, taskTitle: task.title || task.goal || '', at: Date.now(),
        roles: { pm: pm.name, chief: chief.name, workers: workers.map(w => w.name) },
        handover: handover || null,
        brief: '', decisions: [], files: (handover && handover.files) || []
      }],
      brief: null, plan: null, outputs: [], minutes: null,
      tokens: { in: 0, out: 0 }, ms: 0,
      pending: { answers: {}, note: '' },
      at: Date.now(),
      updatedAt: Date.now()
    };
    if (!st.guest) {
      try {
        const made = await window.CLOUD.createMeeting(m);
        m.rowId = made.rowId;
      } catch (e) {
        window.APP.toast('项目没存上云端：' + e.message);
      }
    }
    st.meetings.unshift(m);
    /* 原任务盖「已转项目」的章，左栏徽标与头部入口都认它 */
    try {
      task.deliverableCheck = Object.assign({}, task.deliverableCheck || {},
        { project: { meetingId: m.id, topic: m.topic, at: m.at } });
      task.pendingAsk = null;
      if (window.APP.persistTask) await window.APP.persistTask(task);
      if (window.APP.refreshRail) window.APP.refreshRail();
    } catch (e) { /* 章没盖上不影响项目继续 */ }
    open(m.id);
    renderList();
    render();
    window.APP.toast(`已转为项目 · 项目经理 ${pm.name} · 牵头人 ${chief.name}${chief.id === pm.id ? '（兼任）' : ''}`);
    /* 前情简报：牵头人把原任务的分析链、老板交代、结论、产出提炼成一份。
       提炼失败不拦路——兜底直接用原任务结论当简报。 */
    await makeOriginBrief(m, chief);
    runBrief(m);
    return m;
  }

  /* 前情简报：产出文件先过 /api/digest 拿结构+开头，再让牵头人提炼。
     一份简报全员共用：写进项目共享记忆 + 存在 origin 里随每节 prompt 注入。 */
  async function makeOriginBrief(m, chief) {
    const o = originOf(m);
    if (!o) return;
    const h = o.handover || {};
    const scope = S().scope;
    /* 产出文件摘要：拿到每一份的结构和开头 900 字，比让模型去读全文省得多 */
    let fileText = '';
    try {
      if ((h.files || []).length && scope) {
        const items = await digestOf(scope, h.files.slice(0, 8), 0);
        fileText = (items || []).filter(x => x && !x.missing && x.head).map(x =>
          `· ${x.path}（${x.structure || x.kind || '文件'}）：${String(x.head).slice(0, 260)}`).join('\n');
      }
    } catch (e) { /* 摘要拿不到就用文件名清单 */ }
    const saysText = (h.says || []).map(s => `· ${String(s.text || '').slice(0, 150)}`).join('\n');
    const bossText = (h.bossMsgs || []).map(s => `· ${String(s).slice(0, 150)}`).join('\n');
    const fallback = [
      h.goal ? `原任务目标：${String(h.goal).slice(0, 300)}` : '',
      h.result ? `原任务结论：${String(h.result).slice(0, 600)}` : '',
      (h.files || []).length ? `原任务产出：${h.files.join('、')}` : ''
    ].filter(Boolean).join('\n');
    const model = modelOf(chief);
    try {
      if (!model) throw new Error('没有模型');
      const obj = await callJSON({
        m, model,
        system: [
          `你是「${chief.name}」，即将牵头这个项目。${personaLine(chief)}`,
          '这个项目是从老板的一个任务转过来的，团队里有新成员不熟悉前情。',
          '请把下面这份原任务材料提炼成一份《前情简报》，让每位参与人读那一份就够了，谁都不用再去翻原始对话和文件。',
          '只输出 JSON：{"brief":"简报正文，400-700字：任务背景与目标、已经定下的口径与关键决策、已经做完的事、产出文件各自写了什么、还没解决的坑","decisions":["关键决策/口径，每条一句话，最多6条"]}'
        ].join('\n'),
        user: [
          `原任务：${o.taskTitle}`,
          h.goal ? `目标：${String(h.goal).slice(0, 400)}` : '',
          bossText ? `老板在这些场合说过：\n${bossText}` : '',
          saysText ? `执行过程中的分析要点：\n${saysText}` : '',
          h.result ? `最终结论：\n${String(h.result).slice(0, 1200)}` : '',
          fileText ? `产出文件摘要：\n${fileText}` : ((h.files || []).length ? `产出文件：${h.files.join('、')}` : '')
        ].filter(Boolean).join('\n\n'),
        maxTokens: 2000
      });
      o.brief = String(obj.brief || fallback).slice(0, 2200);
      o.decisions = (Array.isArray(obj.decisions) ? obj.decisions : []).slice(0, 6).map(x => String(x).slice(0, 120));
    } catch (e) {
      o.brief = fallback || '（前情简报生成失败，参与人按各自节点的问题直接开工。）';
      o.decisions = [];
    }
    /* 简报写进项目共享记忆：refresh 之后 briefOf 还能召回，全员可查 */
    try {
      if (window.BOSS && window.BOSS.saveProjectMemo) {
        window.BOSS.saveProjectMemo(S().scope, m.id, m.topic,
          ['《前情简报》（原任务：' + o.taskTitle + '）\n' + o.brief,
            ...(o.decisions || []).map(d => '前情决策：' + d)],
          '转项目：' + String(o.taskTitle).slice(0, 20), m.id);
      }
    } catch (e) { /* 记忆写不进不拦路 */ }
    render();
    save(m);
  }

  /* ── 左栏列表 ── */
  function renderList() {
    const st = S();
    const box = el('railList');
    if (!box) return;
    if (el('mtCount')) el('mtCount').textContent = st.meetings.length;
    if (el('tkCount')) el('tkCount').textContent = st.tasks.length;
    if (el('railHint') && st.view === 'meeting') el('railHint').textContent = `共 ${st.meetings.length} 个项目`;
    if (!st.meetings.length) {
      box.innerHTML = '<div class="hint-block">还没有项目。<br>点右上「＋ 新建项目」，召集一次协作。</div>';
      return;
    }
    /* 按最近修改降序：刚跑过一节的项目浮到上面（置顶的仍置顶）。
       排序口径和任务线共用 window.APP.sortRailItems，别各写一套又漂移。
       at 是创建时间、还要用来算工作目录，不能拿它排。 */
    const list = (window.APP && window.APP.sortRailItems)
      ? window.APP.sortRailItems(st.meetings)
      : st.meetings.slice().sort((a, b) => (b.updatedAt || b.at || 0) - (a.updatedAt || a.at || 0));
    /* 左栏搜索：按项目主题过滤 */
    const q = String((st.railQ && st.railQ.project) || '').trim().toLowerCase();
    const shown = q ? list.filter(m => String(m.topic || '').toLowerCase().includes(q)) : list;
    if (q && !shown.length) {
      box.innerHTML = `<div class="hint-block">没有匹配「${esc(q)}」的项目<br>换个关键词试试</div>`;
      return;
    }
    box.innerHTML = shown.map(m => {
      const ppl = Array.isArray(m.participants) ? m.participants : [];
      const ai = ppl.filter(p => p.kind !== 'human').length;
      const hu = ppl.length - ai;
      /* 日期显示「最近动过」的那天，和排序口径保持一致 */
      const stamp = m.updatedAt || m.at;
      const d = stamp ? new Date(stamp) : null;
      const date = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
      return `<div class="ti ${st.curMeetingId === m.id ? 'on' : ''}" data-mid="${esc(m.id)}">
        <div class="ti-t"><i class="dot ${ST_DOT[m.status] || 'queued'}"></i><span>${esc(m.topic)}</span>
          <button class="ti-more" data-more="${esc(m.id)}" data-kind="meeting" title="更多操作">⋯</button>
        </div>
        <div class="ti-m">${m.pinned ? '<span class="ti-pin">置顶</span>' : ''}<span>${esc(date)}</span><span>${ST_LABEL[m.status] || m.status}</span><span>· ${ai} AI${hu ? ' +' + hu + ' 真人' : ''}</span></div>
      </div>`;
    }).join('');
    box.querySelectorAll('.ti').forEach(n => {
      n.onclick = e => {
        if (e.target.closest('[data-more]')) return;
        open(n.dataset.mid);
      };
    });
  }

  /* ── 产出物落盘 ──
   * 沙箱是临时文件系统：重新发布 / 重启 / 长时间空闲会把 workspace 清空，
   * 记录里的文件名还在、文件没了，auditFiles 就会把它们当「丢了」从记录里删掉——越打开丢得越干净。
   * 现在改成：跑完一节就往本机文件夹写一份（没目录时才按设置回落到云端），
   * 打开前再从本地把缺的读回工作区。
   * 复用 app.js 里任务侧那一套（syncFilesFor / restoreFilesFor），桶名用 'proj-'+id 区分。 */
  function projectFiles(m) {
    const set = new Set();
    for (const o of (m.outputs || [])) for (const p of (o.files || [])) if (p) set.add(String(p));
    return [...set];
  }

  function projectLabel(m) {
    return (m && (m.title || m.goal || m.name)) || '项目';
  }

  function syncProjectFiles(m, opts) {
    if (!m || typeof window.syncFilesFor !== 'function') return;
    try {
      window.syncFilesFor('proj-' + m.id, projectFiles(m), opts || { quiet: true }, projectLabel(m)).catch(() => {});
    } catch (e) { /* 不影响主流程 */ }
  }

  async function restoreProjectFiles(m) {
    if (!m || typeof window.restoreFilesFor !== 'function') return 0;
    try { return await window.restoreFilesFor('proj-' + m.id, projectFiles(m), projectLabel(m)); } catch (e) { return 0; }
  }

  /* 打开项目时对一遍盘：记录里的产出文件还在不在。
   * 换设备、清过工作区、或者当初就没写成，都会对不上——
   * 宁可当场纠正，也别让人点开一个死链再猜「是不是被删了」。 */
  async function auditFiles(m) {
    const items = (m.outputs || []).filter(o => (o.files || []).length);
    if (!items.length) return false;
    const all = [...new Set(items.flatMap(o => (o.files || []).filter(Boolean)))];
    let g;
    try { g = await window.BOSS.verifyPaths(S().scope, all, 0); }
    catch { return false; }
    if (!g.checked) return false;
    const bad = new Set((g.missing || []).filter(Boolean));
    if (!bad.size) return false;
    let changed = false;
    for (const o of m.outputs) {
      const had = (o.files || []).filter(Boolean);
      const keep = had.filter(f => !bad.has(f));
      if (keep.length === had.length) continue;
      o.lostFiles = had.filter(f => bad.has(f));
      o.files = keep;
      changed = true;
    }
    return changed;
  }

  function open(id) {
    const st = S();
    const m = st.meetings.find(x => x.id === id);
    if (!m) return;
    st.curMeetingId = id;
    st.view = 'meeting';
    st.lastListView = 'project';
    window.APP.showView('meeting');
    /* 刷新后拍板卡的应答通道已经不在了：把「等你拍板」的节点放回队列，
       点「继续跑」会重新执行并再次提问（已完成的不受影响） */
    let askFixed = false;
    (m.outputs || []).forEach(o => {
      if (o && o.status === 'ask') { o.status = 'wait'; o.now = ''; askFixed = true; }
    });
    if (askFixed) { m.nodeAsks = []; save(m); }
    renderList();
    render();
    /* 余额快见底：点开项目就说一句（一分钟内不重复念） */
    if (window.APP && window.APP.creditWarn) window.APP.creditWarn('这个项目');
    /* 先补文件再对账：否则刚重启过的项目点开一次，产出就被当成「丢了」从记录里删掉 */
    restoreProjectFiles(m)
      .catch(() => 0)
      .then(() => auditFiles(m))
      .then(changed => {
        if (!changed) return;
        render();
        save(m);
      });
  }

  /* ── 主区渲染 ── */
  function render() {
    const m = cur();
    if (!m) {
      el('mtTitle').textContent = '还没有项目';
      el('mtTitle').title = '';
      el('mtMeta').textContent = '点左上角「＋ 新建项目」，牵头人会先拆题，再拉对口的成员。';
      el('mtPeople').innerHTML = '';
      el('mtStats').innerHTML = '';
      el('meetBody').innerHTML = `<div class="empty"><div class="empty-t">还没有项目</div>
        <div class="empty-d">一次项目协作：牵头人把主题拆成几个要你拍板的问题 → 你确认 → 牵头人排执行路径并分派给对口成员 → 成员按方法论分别分析 → 牵头人出纪要。</div></div>`;
      syncComposer();
      return;
    }

    const sec = secretaryOf(m);
    const pm = pmOf(m);
    const chief = chiefOf(m);
    el('mtTitle').textContent = m.topic;
    el('mtTitle').title = m.topic;
    const ai = m.participants.filter(p => p.kind !== 'human').length;
    const hu = m.participants.length - ai;
    el('mtMeta').textContent = `项目经理 ${pm.name}${pm.role ? '（' + pm.role + '）' : ''} · 牵头人 ${chief.name} · 成员 ${m.participants.length} 人（AI ${ai}${hu ? ' · 真人 ' + hu : ''}）`
      + ((m.files || []).length ? ` · 附件 ${m.files.length} 份` : '')
      + (m.plan && m.plan.understanding ? ' · ' + m.plan.understanding : '');
    el('mtPeople').innerHTML = m.participants.map(p =>
      `<span class="mp ${p.id === pm.id ? 'pm' : ''}" data-nm="${esc(p.name)}" title="点一下在输入框里 @ 他，让他接着干"><i class="${p.kind === 'human' ? 'human' : ''}">${esc(p.name.slice(0, 1))}</i>${esc(p.name)}<em title="${esc(p.role)}">${esc(p.id === pm.id ? '项目经理' : p.chief ? '牵头人' : shortRole(p.role))}</em></span>`
    ).join('') + '<button class="mp-add" id="mpAddBtn" title="增加成员">＋</button>';
    el('mpAddBtn').onclick = e => { e.stopPropagation(); openAdd(); };
    /* 任何阶段都能点成员 chip = 在输入框里 @ 他，让他接着干 */
    el('mtPeople').querySelectorAll('.mp[data-nm]').forEach(n => {
      n.classList.add('at');
      n.onclick = () => insertMention(m, n.dataset.nm);
    });

    const tok = m.tokens || { in: 0, out: 0 };
    const weakN = (m.outputs || []).filter(o =>
      o.status === 'weak' || o.status === 'fail' || (o.lostFiles || []).length).length;
    /* 右上角和任务页保持一致：只留一个「任务总消耗」。
       状态在进度卡里、耗时在进度卡里，不用在这儿重复占位。 */
    el('mtStats').innerHTML = `
      <div class="stat ${overBud(m) ? 'over' : ''}" title="这个项目的 token 上限 ${budCap(m)}"><b>${tok.in + tok.out ? Number(tok.in + tok.out).toLocaleString() + ' token' : '—'}</b><span>任务总消耗</span></div>
`;
    /* 右上角只留「任务总消耗」：补跑入口撤掉，缺的节点直接在下面说一句就行 */
    el('meetBody').innerHTML = bodyHTML(m);
    bindBody(m);
    syncComposer();
    if (el('mpPop') && !el('mpPop').hidden) placePop();
    // 只有正在跑的时候才跟着最新内容往下滚；停下来等你拍板时保持从头看
    if (m.busy) {
      const box = el('meetBody');
      box.scrollTop = box.scrollHeight;
    }
    // 重渲染后把标题旁的搜索条件重新套上
    if (window.APP && window.APP.applyContentSearch) window.APP.applyContentSearch('meeting');
    // 右栏产出物跟着当前项目走
    if (window.APP && window.APP.renderOutputRail) window.APP.renderOutputRail();
  }

  /* ── 项目中拉人：最近联系人 / 单选 / 多选 / 搜索 ── */
  let addPick = new Set();
  let addQuery = '';

  const recentKey = () => 'boss.recent.' + (S().scope || 'local');

  function recentIds() {
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem(recentKey()) || '[]') || []; } catch (e) { ids = []; }
    if (!ids.length) {
      // 还没记过就先用最近几个项目的成员兜底
      const m = cur();
      S().meetings.filter(x => !m || x.id !== m.id).slice(0, 3)
        .forEach(x => (x.participants || []).forEach(p => ids.push(p.id)));
    }
    return [...new Set(ids)];
  }

  function markRecent(ids) {
    try {
      const next = [...new Set([...ids, ...recentIds()])].slice(0, 12);
      localStorage.setItem(recentKey(), JSON.stringify(next));
    } catch (e) { /* 存不上不影响这次用 */ }
  }

  function candidates() {
    const m = cur();
    if (!m) return [];
    const has = new Set(m.participants.map(p => p.id));
    const rest = S().staff.filter(s => !has.has(s.id));
    return window.NAMEORDER ? window.NAMEORDER.sortStaff(rest) : rest;
  }

  function rowHTML(s) {
    const human = s.kind === 'human';
    const on = addPick.has(s.id);
    return `<div class="mp-row ${on ? 'on' : ''}" data-pk="${esc(s.id)}">
      <i class="mp-ck">${on ? '✓' : ''}</i>
      <i class="mp-av ${human ? 'human' : ''}">${esc(s.name.slice(0, 1))}</i>
      <span class="mp-nm"><b>${esc(s.name)}</b><i class="tag-ai ${human ? 'human' : 'ai'}">${human ? '真人' : 'AI'}</i>${s.core ? '<i class="tag-core">核心</i>' : ''}</span>
      <span class="mp-ro" title="${esc(s.role)}">${esc(shortRole(s.role))}</span>
      <button class="mp-inc" data-inc="${esc(s.id)}" title="只加这个人">加入</button>
    </div>`;
  }

  function listWrapHTML() {
    const list = candidates();
    const q = addQuery.trim().toLowerCase();
    const hit = q ? list.filter(s => `${s.name} ${s.role}`.toLowerCase().includes(q)) : list;
    let body;
    if (!list.length) body = '<div class="mp-empty">所有员工都已经在会上了。要拉新人，先去右栏新建一个。</div>';
    else if (!hit.length) body = `<div class="mp-empty">没有匹配「${esc(addQuery.trim())}」的员工。</div>`;
    else body = hit.map(rowHTML).join('');
    return `<span class="mp-lb">全部员工${list.length ? ` <em>${hit.length}/${list.length}</em>` : ''}</span><div class="mp-list" id="mpList">${body}</div>`;
  }

  function footText() {
    return addPick.size ? `已选 ${addPick.size} 人` : '可多选；想只拉一个人点行尾「加入」';
  }

  function placePop() {
    const btn = el('mpAddBtn');
    const pop = el('mpPop');
    if (!btn || !pop || pop.hidden) return;
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 334;
    const h = pop.offsetHeight || 300;
    const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function closePop() {
    const p = el('mpPop');
    if (p) p.hidden = true;
    addPick = new Set();
  }

  function openAdd() {
    if (!cur()) return;
    addPick = new Set();
    addQuery = '';
    renderAddPick();
    const inp = el('mpSearch');
    if (inp) setTimeout(() => inp.focus(), 30);
  }

  function renderAddPick() {
    const pop = el('mpPop');
    if (!pop) return;
    const list = candidates();
    const recs = recentIds().map(id => list.find(s => s.id === id)).filter(Boolean).slice(0, 8);
    pop.innerHTML = `
      <div class="mp-h"><span>增加参会人员</span><button class="mp-x" data-mpclose title="关闭">×</button></div>
      <input class="mp-search" id="mpSearch" placeholder="搜名字 / 岗位，或者直接勾" value="${esc(addQuery)}" autocomplete="off">
      ${recs.length ? `<div class="mp-sec">
        <span class="mp-lb">最近一起开过会 · 点一下直接拉进来</span>
        <div class="mp-recs">${recs.map(s => `<span class="mp-re" data-inc="${esc(s.id)}"><i class="${s.kind === 'human' ? 'human' : ''}">${esc(s.name.slice(0, 1))}</i>${esc(s.name)}</span>`).join('')}</div>
      </div>` : ''}
      <div class="mp-sec" id="mpListWrap">${listWrapHTML()}</div>
      <div class="mp-foot"><span id="mpFoot">${footText()}</span>
        <button class="btn tiny primary" id="mpAddConfirm" ${addPick.size ? '' : 'disabled'}>添加</button></div>`;
    pop.hidden = false;
    placePop();
  }

  async function addMembers(ids) {
    const m = cur();
    if (!m) return;
    const add = S().staff.filter(s => ids.includes(s.id) && !m.participants.some(p => p.id === s.id));
    if (!add.length) return closePop();
    add.forEach(s => m.participants.push({
      id: s.id, name: s.name, role: s.role, persona: s.persona,
      /* 性格四维度跟着人走：每一节的提示词都靠这四个字段决定「怎么说」 */
      gender: s.gender || '', zodiac: s.zodiac || '', sign: s.sign || '', mbti: s.mbti || '',
      model: s.model || '', kind: s.kind || 'ai', core: !!s.core,
      notes: s.notes || ''
    }));
    markRecent(add.map(s => s.id));
    closePop();
    render();
    renderList();
    await save(m);
    const names = add.map(s => s.name).join('、');
    const tail = m.status === 'analyzing' ? '，这轮拆完再分要素'
      : m.status === 'done' ? '，需要补一块分析就在下面说一句'
        : (m.status === 'confirm' || m.status === 'awaiting' ? '，拆解时会分到要素' : '');
    window.APP.toast(`${names} 已入会${tail}`);
  }

  function onPopClick(e) {
    if (e.target.closest('[data-mpclose]')) return closePop();
    if (e.target.closest('#mpAddConfirm')) {
      if (addPick.size) addMembers([...addPick]);
      return;
    }
    const inc = e.target.closest('[data-inc]');
    if (inc) return addMembers([inc.dataset.inc]);
    const row = e.target.closest('[data-pk]');
    if (row) {
      const id = row.dataset.pk;
      if (addPick.has(id)) addPick.delete(id); else addPick.add(id);
      row.classList.toggle('on', addPick.has(id));
      const ck = row.querySelector('.mp-ck');
      if (ck) ck.textContent = addPick.has(id) ? '✓' : '';
      const f = el('mpFoot');
      if (f) f.textContent = footText();
      const ok = el('mpAddConfirm');
      if (ok) ok.disabled = !addPick.size;
    }
  }

  /* 员工发言行：和任务聊天框同一套（头像 + 气泡 + 署名行），tag 是这一段的性质；
     头像用 avClass 上色（和任务线一致：按名字落到 av-c0..av-c7 八色之一） */
  function botRow(who, tag, inner) {
    const nm = who && who.name || 'AI';
    const avc = (window.APP && window.APP.avClass) ? window.APP.avClass(nm) : '';
    return `<div class="node-txt bot">
      <span class="bot-ava ${avc}" title="${esc(nm)}">${esc(String(nm).slice(0, 1))}</span>
      <div class="bot-bub"><span class="lbl">${esc(nm)} · ${esc(shortRole(who.role || ''))}${tag ? ` · ${esc(tag)}` : ''}</span>${inner}</div>
    </div>`;
  }

  /* ── 节点状态：只在这一处判 ──────────────────────────────────────────
     以前「执行路径」列表和下面的「节点执行块」各写一套 if：同样是产出缺失，
     一处显示、另一处漏了；stTag 甚至定义了变量却从没渲染过。
     现在统一走这里，顺带给出标准状态（STATES），和任务线的判定能对上号。 */
  function nodeState(o) {
    const S = window.STATES && STATES.node;
    const lost = !!(o && (o.lostFiles || []).length);
    let raw = 'wait';
    if (!o) raw = 'wait';
    else if (lost) raw = 'weak';
    else if (o.status === 'done') raw = (o.verify && o.verify.pass === false) ? 'weak' : 'done';
    else if (o.status === 'run') raw = 'run';
    else if (o.status === 'ask') raw = 'ask';
    else if (o.status === 'fail') raw = 'fail';
    else if (o.status === 'skip') raw = 'skip';
    else if (o.status === 'weak') raw = 'weak';
    else if (o.status === 'wait') raw = 'wait';
    return { raw, lost, std: S ? S.from(raw) : raw, done: raw === 'done' };
  }
  /* 状态小标签：两种视图共用一份，别再各写一套 */
  function stTagOf(o, deps) {
    if (!o) return '';
    const s = nodeState(o);
    if (s.lost) return '<span class="mt-st weak">产出缺失</span>';
    if (s.raw === 'done') return '<span class="mt-st ok">已核验</span>';
    if (s.raw === 'weak') return '<span class="mt-st weak">存疑</span>';
    if (s.raw === 'run') return '<span class="mt-st run">跑着</span>';
    if (s.raw === 'ask') return '<span class="mt-st run">等你拍板</span>';
    if (s.raw === 'fail') return '<span class="mt-st skip">没跑成</span>';
    if (s.raw === 'skip') return '<span class="mt-st skip">前置未完成</span>';
    if (s.raw === 'wait') {
      const d = (deps || []).filter(Boolean);
      return `<span class="mt-st wait">${d.length ? '等 ' + esc(d.join('、')) : '排队中'}</span>`;
    }
    return '';
  }

  function bodyHTML(m) {
    /* 拆题、拆解、纪要的署名都归牵头人（转项目后明确指定；老项目回退项目经理） */
    const sec = chiefOf(m);
    let h = '';

    /* 项目进度卡：拆了几节 / 跑到第几节 / 预计完成 / 积分 */
    {
      const nodes = planNodes(m);
      const itemOf = id => (m.outputs || []).find(o => o && o.id === id);
      const steps = nodes.map(n => {
        const it = itemOf(n.id);
        const st = !it ? 'todo' : it.status === 'done' ? 'done' : it.status === 'run' ? 'doing' : 'todo';
        return { text: n.title || n.id, status: st };
      });
      const runIt = (m.outputs || []).find(o => o && o.status === 'run');
      const running = BUSY.has(m.status);
      h += window.APP.progressHTML({
        label: '项目进度',
        steps,
        stepLabel: m.plan ? '已拆解，等待开工' : `${sec.name} 在拆题`,
        now: running
          ? (runIt ? (runIt.now || runIt.title || '这一节在写') : (m.busyText || (m.status === 'briefing' ? `${sec.name} 在读材料、准备问题` : `${sec.name} 在排执行路径、分派成员`)))
          : '',
        startAt: running ? (m.phaseStart || m.at || Date.now()) : 0,
        endAt: running ? 0 : 1,
        elapsedMs: running ? null : m.ms,
        tokens: m.tokens || { in: 0, out: 0 },
        budgetTokens: budCap(m)
      });
    }

    /* 积分烧完：项目终止。把「为什么停」和「怎么接」摊开，别只留一个失败状态 */
    if (m.creditHold) {
      const c = m.creditHold;
      const bal = (window.APP && window.APP.walletTotal) ? window.APP.walletTotal() : 0;
      h += `<section class="mt-sec"><div class="mt-card mt-bud mt-credit">
        <div class="mt-bud-h"><b>积分用完了，项目停下了</b>
          <span>${c.left ? `还剩 ${c.left} 节没跑` : '只差纪要'} · 余额 ${bal}</span></div>
        <div class="mt-bud-d">${m.error || '钱花完了就不该继续烧。'}已经跑完的节点和落盘的文件都在，不会丢；充值到账后点「继续跑」，从断点接着走，跑过的不会重来。</div>
        <div class="mt-bud-act">
          <button class="btn tiny primary" data-act="credtopup">去充值</button>
          <button class="btn tiny ghost" data-act="creditresume">充好了，接着跑</button>
        </div>
      </div></section>`;
    }

    /* 预算到线：把两条路摊在明面上，不替老板做主 */
    if (m.budgetHold) {
      const b = m.budgetHold;
      h += `<section class="mt-sec"><div class="mt-card mt-bud">
        <div class="mt-bud-h"><b>token 到上限了</b>
          <span>已花 ${b.spent} · 上限 ${Math.round(b.cap / 10000)} 万</span></div>
        <div class="mt-bud-d">${b.left ? `还剩 ${b.left} 节没跑。` : '节点都跑完了，只差纪要。'}两件事你挑一个：接着烧，或者就地收口——没跑的会记成「按你意思停」，不会假装做完。</div>
        <div class="mt-bud-act">
          <button class="btn tiny primary" data-act="budraise">再给 ${Math.round(BUD.raise / 10000)} 万，接着跑</button>
          <button class="btn tiny ghost" data-act="budstop">停在这里，出纪要</button>
        </div>
      </div></section>`;
    }

    /* 0. 前情简报：原任务带过来的统一上下文，全员看这一份就够了。
       展示跟任务聊天框对齐：老板的话靠右气泡。 */
    const origin = originOf(m);
    if (origin) {
      const ofiles = (origin.files || []).filter(Boolean);
      h += `<div class="msg me mt-origin">
        <div class="bub">
          <span class="mt-tag" style="background:rgba(74,124,247,.14);color:#3a5cc9">由任务转来 · 全员共用这一份简报，不用各自去翻原始对话和文件</span>
          <div class="mt-origin-h"><b>前情 · ${esc(origin.taskTitle || '原任务')}</b></div>
          ${origin.brief ? md(origin.brief) : '<span class="mt-wait">牵头人正在提炼前情简报…</span>'}
          ${(origin.decisions || []).length ? `<div class="mt-blk"><span class="mt-k">已定下的口径</span>${origin.decisions.map(x => `<div class="mt-li">· ${esc(x)}</div>`).join('')}</div>` : ''}
          ${ofiles.length ? `<div class="mt-origin-files"><span class="mt-k">原任务产出</span>${ofiles.map(f => `<button class="mt-file" data-file="${esc(f)}" title="${esc(f)}">📄 ${esc(String(f).split('/').pop())}</button>`).join('')}</div>` : ''}
        </div>
        <span class="ava">板</span>
      </div>`;
    }

    /* 1. 牵头人拆题（头像+气泡，和任务聊天框同一套） */
    if (m.brief) {
      const b = m.brief;
      const answered = m.status !== 'awaiting' && m.status !== 'briefing';
      h += botRow(sec, '议题拆解', `
        <div class="mt-under"><span class="mt-k">我要解决的问题</span>${esc(b.understanding || '')}</div>
        ${(b.assumptions || []).length ? `<div class="mt-assume"><span class="mt-k">我先按这些默认假设往下走</span>${b.assumptions.map(a => `<div>· ${esc(a)}</div>`).join('')}</div>` : ''}
        ${(b.questions || []).length ? `<div class="ask-form" id="askBrief">
          <div class="ask-hd"><b>需要你拍板</b><span>选一下或自己填，答完点确认，${esc(sec.name)}接着拆</span></div>
          ${(b.questions || []).map((q, i) => `
            <div class="ask-q" data-i="${i}">
              <div class="ask-qt">${i + 1}. ${esc(q.q)}</div>
              <div class="ask-opts" data-multi="1">
                ${(q.options || []).map(o => {
                  const on = picksOf(m, i).includes(o);
                  return `<button type="button" class="ask-opt ${on ? 'on' : ''}" data-q="${i}" data-v="${esc(o)}" ${answered ? 'disabled' : ''}>${esc(o)}</button>`;
                }).join('')}
                <input class="ask-custom" data-q="${i}" type="text" ${answered ? 'disabled' : ''}
                       placeholder="都不合适？自己填…" autocomplete="off" value="${esc(extraOf(m, i))}">
              </div>
            </div>`).join('')}
          <div class="ask-ft"><button class="ask-ok" id="askBriefOk" type="button" ${answered ? 'disabled' : ''}>确认，继续</button><span class="ask-note">没答的按默认假设走</span></div>
        </div>` : ''}
      `);
    }

    /* 2. 老板答案：靠右气泡 */
    if (m.answers && m.answers.length) {
      h += `<div class="msg me"><div class="bub">${m.answers.map(a => `<div class="mt-ans"><span class="mt-k">${esc(a.q)}</span>${esc(a.answer)}</div>`).join('')}</div><span class="ava">板</span></div>`;
    }

    /* 3. 牵头人确认 + 执行路径（带依赖的执行图） */
    if (m.plan) {
      const p = m.plan;
      const nodes = planNodes(m);
      const waves = planWaves(nodes);
      const width = waves.reduce((a, w) => Math.max(a, w.length), 0);
      /* 开跑之后路径收成一行一个，别把真正的结论挤到屏幕外 */
      const compact = m.status !== 'confirm' && !m.pathOpen;
      h += botRow(sec, '确认与拆解', `
        <div class="mt-under"><span class="mt-k">我按这个往下走</span>${esc(p.understanding || '')}</div>
        ${(p.changes || []).length ? `<div class="mt-chg"><span class="mt-k">你的回答改了什么</span>${p.changes.map(c => `<div>· ${esc(c)}</div>`).join('')}</div>` : ''}
        <div class="mt-path ${compact ? 'compact' : ''}">
          <div class="mt-path-h">
            <span class="mt-k">执行路径</span>
            <em>${compact ? `${nodes.length} 个节点 · ${waves.length} 层` : `${nodes.length} 个节点 · ${waves.length} 层 · 同一层最多 ${width} 个并排`}</em>
            ${m.status !== 'confirm' ? `<button class="mt-path-tg" data-act="path">${compact ? '展开' : '收起'}</button>` : ''}
            ${(() => {
              const outs = m.outputs || [];
              const okN = outs.filter(o => o.status === 'done').length;
              const weakN = outs.filter(o => o.status === 'weak').length;
              const badN = outs.filter(o => o.status === 'fail' || o.status === 'skip').length;
              if (!outs.length) return '';
              const pct = Math.round((okN + weakN) / nodes.length * 100);
              return `<span class="mt-prog" title="已跑 ${okN + weakN}/${nodes.length}"><i style="width:${pct}%"></i></span>
                <span class="mt-prog-t">已跑 ${okN + weakN}/${nodes.length}${weakN ? ` · 存疑 ${weakN}` : ''}${badN ? ` · 没成 ${badN}` : ''}</span>`;
            })()}
          </div>
          ${nodes.map(n => {
            const depNames = (n.deps || []).map(id => {
              const up = nodes.find(x => x.id === id);
              return up ? `${up.id} ${up.title}` : id;
            });
            const o = (m.outputs || []).find(x => x.id === n.id);
            /* 状态标签与下面的执行块同源（nodeState），不再各写一套判定 */
            const rs = o ? stTagOf(o, []) : '';
            return `<div class="mt-node ${n.deps && n.deps.length ? 'has-dep' : 'root'} ${o && o.status === 'run' ? 'on' : ''}">
              <span class="mt-nid">${esc(n.id)}</span>
              <div class="mt-nbody">
                <div class="mt-nh">
                  <b>${esc(n.title)}</b>
                  <i class="mt-pri ${esc(String(n.priority || 'P1').toLowerCase())}">${esc(n.priority || 'P1')}</i>
                  <span class="mt-nlead">${esc(n.lead)} · ${esc(shortRole(n.role || ''))}</span>
                  ${rs}
                </div>
                ${compact ? '' : `<p class="mt-nq">${esc(n.question || '')}</p>`}
                <div class="mt-nmeta ${compact ? 'hide' : ''}">
                  <span class="${depNames.length ? 'mt-dep' : ''}">${depNames.length ? '前置：' + esc(depNames.join('、')) : '无前置，可先跑'}</span>
                  ${n.method ? `<span>方法 ${esc(n.method)}</span>` : ''}
                  ${n.deliver ? `<span>产出 ${esc(n.deliver)}</span>` : ''}
                  ${n.accept ? `<span>验收 ${esc(n.accept)}</span>` : ''}
                  ${n.depNote ? `<span class="mt-depwarn">${esc(n.depNote)}</span>` : ''}
                </div>
              </div>
            </div>`;
          }).join('')}
          ${(m.planVersions || []).length > 1 ? `<details class="mt-planver">
            <summary>计划历史 · 共 ${m.planVersions.length} 版（重规划不覆盖旧版）</summary>
            ${m.planVersions.slice().reverse().map(v => `<div class="mt-pv">
              <b>v${v.v}</b><span>${esc(v.why || '初版')}</span>
              <span>${v.nodes} 个节点</span>
              <span>${new Date(v.at).toLocaleString('zh-CN', { hour12: false }).slice(5)}</span>
            </div>`).join('')}
          </details>` : ''}
        </div>
        ${(p.pushback || []).length ? `<div class="mt-push"><span class="mt-k">我要提醒你一句</span>${p.pushback.map(x => `<div>· ${esc(x)}</div>`).join('')}</div>` : ''}
        ${m.status === 'confirm'
          ? (m.autoIn > 0
            ? `<div class="mt-tip auto"><span class="mt-cd">${m.autoIn}</span> 秒后自动开跑，不用你点。
                <button class="btn tiny" data-act="hold">等一下，我先看看</button></div>`
            : '<div class="mt-tip">点右下「确认，按这个路径开跑」；哪个节点顺序不对、多了少了，直接在下面说。</div>')
          : ''}
      `);
    }

    /* 4. 按路径逐节执行 */
    (m.outputs || []).forEach((o, i) => {
      const st = o.status || 'done';
      const deps = o.deps || [];
      /* 状态标签走统一判定：产出缺失 / 存疑 / 没跑成 的优先级不再靠 if 嵌套记忆 */
      const stTag = stTagOf(o, deps);
      /* 核验结论按维度摊开：只写「存疑」看不出该补什么。
         这一层和任务线是同一套判定（public/judge.js），措辞也一样。 */
      const vf = o.verify || null;
      const dims = vf && Array.isArray(vf.dims) && vf.dims.length
        ? `<span class="mt-k">核验</span>${vf.dims.map(d => {
          const ok = d.w === 'veto' ? d.s >= 3 : d.s >= 3;
          const val = d.w === 'veto' ? (ok ? '通过' : '否决') : d.s + '/4';
          return `<span class="mt-vd ${ok ? 'ok' : d.s === 2 ? 'warn' : 'bad'}">${esc(d.name || d.k)} ${esc(val)}</span>`;
        }).join('')}`
        : '';
      const gaps = (vf && !vf.pass && (vf.gaps || []).length)
        ? `<div class="mt-vf"><span class="mt-k">核验没过的点</span>${vf.gaps.map(g => `<div>· ${esc(g)}</div>`).join('')}</div>` : '';
      const files = (o.files || []).filter(Boolean);
      const lost = (o.lostFiles || []).filter(Boolean);
      const lostLine = lost.length
        ? `<div class="mt-files"><span class="mt-k">产出</span><span class="mt-lost">记录里的 ${lost.map(x => esc(String(x).split('/').pop())).join('、')} 不在工作区——这一节当初没写成文件</span></div>`
        : '';
      const fchips = (files.length
        ? `<div class="mt-files"><span class="mt-k">产出</span>${files.map(f => `<button class="mt-file" data-file="${esc(f)}" title="${esc(f)}">📄 ${esc(String(f).split('/').pop())}</button>`).join('')}</div>` : '') + lostLine;
      const tbits = [
        o.toolN ? `跑了 ${o.toolN} 步工具` : '',
        o.gateN ? `门禁退回 ${o.gateN} 次` : ''
      ].filter(Boolean);
      const tmeta = tbits.length ? `<span class="mt-tmeta">${tbits.join(' · ')}</span>` : '';
      /* 分析过程逐条摊开（不覆盖不删除）：和任务线同一套 say-mid 行，头像也上色 */
      const avc = (window.APP && window.APP.avClass) ? window.APP.avClass(o.lead || '') : '';
      const says = Array.isArray(o.says) && o.says.length
        ? o.says.map((s, si) => `<div class="node-txt bot say-mid"><span class="bot-ava ${avc}">${esc(String(o.lead || '?').slice(0, 1))}</span><div class="bot-bub"><span class="lbl">${esc(o.lead)} · 分析 ${si + 1}</span><div class="md">${md(s)}</div></div></div>`).join('')
        : '';
      /* 工具步骤折叠条：和任务线「N 步执行 · Xs · 展开过程」一致。
         拆解目标（这一节要解决什么）→ 分析过程（可展开的工具步骤）→ 结论 → 产出物。 */
      const steps = Array.isArray(o.steps) ? o.steps : [];
      const stepsMs = steps.reduce((a, s) => a + (Number(s.ms) || 0), 0);
      const procBar = steps.length
        ? (() => {
            if (o._stepsOpen) {
              const N = window.APP && window.APP.nodeHTML;
              const rows = N
                ? steps.map((s, si) => N(s, si, true, 'mt' + i + '_')).join('')
                : steps.map((s, si) => `<div class="node"><div class="node-h"><b>${esc(s.name)}</b><span class="st ${s.ok ? 'ok' : 'no'}">${s.ok ? 'ok' : 'err'}</span></div></div>`).join('');
              return `<div class="mt-steps-open" data-mt-steps="${i}">
                <div class="turn-bar" data-mt-steps="${i}" style="margin:2px 0 4px">
                  <span class="caret">▾</span><b>${steps.length} 步执行</b>
                  <span class="args">${(stepsMs / 1000).toFixed(1)}s</span>
                  <span class="tb-hint">收起过程</span>
                </div>
                <div class="turn-steps">${rows}</div>
              </div>`;
            }
            return `<div class="turn-bar" data-mt-steps="${i}" style="margin:2px 0 6px">
              <span class="caret">▸</span><b>${steps.length} 步执行</b>
              <span class="args">${(stepsMs / 1000).toFixed(1)}s</span>
              <span class="tb-hint">展开过程</span>
            </div>`;
          })()
        : (o.toolN ? `<div class="mt-tmeta" style="margin:2px 0 6px">跑了 ${o.toolN} 步工具</div>` : '');
      /* 执行中的拍板卡：答案直接回给这一节，它接着干 */
      const liveAsk = (m.nodeAsks || []).filter(a => a && a.nodeId === o.id)
        .sort((a, b) => (PRI_W[a.priority] ?? 3) - (PRI_W[b.priority] ?? 3));
      const waitTxt = st === 'wait' ? `${esc(o.lead || '')} 在等前置出结果，不会白烧 token`
        : st === 'ask' ? '等你拍板，答完接着跑'
          : `${esc(o.lead || '')} 正在写…`;
      /* 产出文件卡：对齐任务线的 file-card（带预览/下载），不再用裸 📄 chip */
      const fcHtml = (() => {
        const list = (files || []).filter(Boolean);
        if (!list.length) return fchips;
        const F = window.APP && window.APP.filesBlockHTML;
        if (!F) return fchips;
        try { return `<div class="mt-files-node">${F(list.map(p => ({ path: p })), null, null)}</div>`; }
        catch (e) { return fchips; }
      })();
      /* 节点执行块：和任务线同一种排版——直排、无气泡外壳、步骤条可折叠。
         以前这里是 botRow 气泡（全宽白底 + 蓝竖线），跟任务的 trace 不是一套视觉，
         「分析框和任务不一样」说的就是这个。顺手把一直定义却没渲染的 stTag 用上：
         那一节到底在跑、在等、还是没跑成，以前气泡里根本看不出来。 */
      h += `<div class="mt-node-out">
        <div class="mt-no-hd">
          <span class="mt-no-who">${esc(o.lead || '')}</span>
          <span class="mt-no-tag">${esc(o.id ? o.id + ' · ' : '')}${esc(o.title || '')}</span>
          ${stTag}
        </div>
        ${says}${procBar}
        <div class="mt-no-body" data-live="${i}">${o.content ? md(o.content) : `<span class="mt-wait">${waitTxt}</span>`}</div>
        ${fcHtml}${dims ? `<div class="mt-files">${dims}</div>` : ''}${gaps}
      </div>` + liveAsk.map(nodeAskHTML).join('');
    });

    /* 5. 纪要 */
    if (m.minutes) {
      const mi = m.minutes;
      h += botRow(sec, '项目纪要', `
        <div class="mt-sum">${md(mi.summary || '')}</div>
        ${(mi.decisions || []).length ? `<div class="mt-blk"><span class="mt-k">已经定下的</span>${mi.decisions.map(x => `<div class="mt-li">· ${esc(x)}</div>`).join('')}</div>` : ''}
        ${(mi.todos || []).length ? `<div class="mt-blk"><span class="mt-k">待办</span>
          <div class="mt-todo-h"><span>做什么</span><span>谁</span><span>什么时候</span></div>
          ${mi.todos.map(t => `<div class="mt-todo"><span>${esc(t.what)}</span><span>${esc(t.who || '')}</span><span>${esc(t.when || '')}</span></div>`).join('')}
        </div>` : ''}
        ${(mi.risks || []).length ? `<div class="mt-blk"><span class="mt-k">还没解决的风险</span>${mi.risks.map(x => `<div class="mt-li risk">· ${esc(x)}</div>`).join('')}</div>` : ''}
        ${(mi.needsBoss || []).length ? `<div class="mt-blk"><span class="mt-k">只有你能拍的</span>${mi.needsBoss.map(x => `<div class="mt-li boss">· ${esc(x)}</div>`).join('')}</div>` : ''}
        ${(() => {
          const all = [...new Set((m.outputs || []).flatMap(o => o.files || []))].filter(Boolean);
          if (!all.length) return '';
          return `<div class="mt-blk"><span class="mt-k">这个项目落下的文件（${all.length}）</span>
            <div class="mt-files wrap">${all.map(f => `<button class="mt-file" data-file="${esc(f)}" title="${esc(f)}">📄 ${esc(String(f).split('/').pop())}</button>`).join('')}</div>
            <div class="mt-fhint">都在工作区 ${esc(dirOf(m))}/ 里，点开能看全文。</div></div>`;
        })()}
      `);
    }

    /* 5b. 老板发言（右侧气泡）→ 在场成员各自表态 → 牵头人收口；@ 点名时只有被点的人答 */
    (m.follow || []).forEach((f, fi) => {
      h += `<div class="msg me"><div class="bub">${esc(f.q)}${(f.only || []).length ? `<div class="mt-k" style="margin-top:4px">定向 @${esc(f.only.join(' @'))}</div>` : ''}</div><span class="ava">板</span></div>`;

      (f.replies || []).forEach((r, ri) => {
        /* 对齐任务线的回合展示：
           N 步执行折叠条 → 分析过程（顶层扁平小气泡，不嵌套）→ 结论/正在写 → 产出 → 状态卡 */
        const ravc = (window.APP && window.APP.avClass) ? window.APP.avClass(r.lead || '') : '';
        const rkey = `r${fi}-${ri}`;
        const rsteps = Array.isArray(r.steps) ? r.steps : [];
        const rMs = rsteps.reduce((a, s) => a + (Number(s.ms) || 0), 0);
        const rBar = rsteps.length
          ? (() => {
              if (r._stepsOpen) {
                const N = window.APP && window.APP.nodeHTML;
                const rows = N
                  ? rsteps.map((s, si) => N(s, si, true, 'fr' + fi + '-' + ri + '_')).join('')
                  : rsteps.map((s, si) => `<div class="node"><div class="node-h"><b>${esc(s.name)}</b><span class="st ${s.ok ? 'ok' : 'no'}">${s.ok ? 'ok' : 'err'}</span></div></div>`).join('');
                return `<div class="mt-steps-open" data-mt-steps="${rkey}">
                  <div class="turn-bar" data-mt-steps="${rkey}" style="margin:2px 0 4px">
                    <span class="caret">▾</span><b>${rsteps.length} 步执行</b>
                    <span class="args">${(rMs / 1000).toFixed(1)}s</span>
                    <span class="tb-hint">收起过程</span>
                  </div>
                  <div class="turn-steps">${rows}</div>
                </div>`;
              }
              return `<div class="turn-bar" data-mt-steps="${rkey}" style="margin:2px 0 6px">
                <span class="caret">▸</span><b>${rsteps.length} 步执行</b>
                <span class="args">${(rMs / 1000).toFixed(1)}s</span>
                <span class="tb-hint">展开过程</span>
              </div>`;
            })()
          : (r.toolN ? `<div class="mt-tmeta" style="margin:2px 0 6px">跑了 ${r.toolN} 步工具</div>` : '');
        /* 分析过程：和任务线一样是顶层小气泡（每条一个头像 + 「分析 N」），不再嵌在结论气泡里 */
        const says = Array.isArray(r.says) && r.says.length
          ? r.says.map((s, si) => `<div class="node-txt bot say-mid"><span class="bot-ava ${ravc}" title="${esc(r.lead)}">${esc(String(r.lead || '?').slice(0, 1))}</span><div class="bot-bub"><span class="lbl">${esc(r.lead)} · 分析 ${si + 1}</span><div class="md">${md(s)}</div></div></div>`).join('')
          : '';
        const rFiles = (r.files || []).filter(Boolean);
        const rFileHtml = rFiles.length
          ? `<div class="mt-files"><span class="mt-k">产出</span>${rFiles.map(f => `<button class="mt-file" data-file="${esc(f)}" title="${esc(f)}">📄 ${esc(String(f).split('/').pop())}</button>`).join('')}</div>`
          : '';
        /* 结论行：干活跑着的时候是「小吴 正在写」的流式气泡（对齐任务线），收工后是署名结论气泡 */
        const rRunning = r.status === 'run';
        const rBub = rRunning
          ? `<div class="node-txt bot"><span class="bot-ava ${ravc}" title="${esc(r.lead)}">${esc(String(r.lead || '?').slice(0, 1))}</span><div class="bot-bub"><span class="lbl">${esc(r.lead)} 正在写 <i class="caret-blink"></i></span><div class="md stream" data-fr="${fi}-${ri}">${r.content ? md(r.content) : ''}</div></div></div>`
          : botRow({ name: r.lead, role: r.role }, '',
              `<div class="pt" data-fr="${fi}-${ri}">${r.content ? md(r.content) : '<span class="mt-wait">正在想…</span>'}</div>`);
        /* 状态卡：对齐任务线「第 N 轮 · 分析中」那张合并卡（进度条/耗时/积分/token）。
           只有干活链路（startedAt）才有；全员表态的普通回复不挂。 */
        const P = window.APP && window.APP.progressHTML;
        const rCard = (P && r.startedAt) ? P({
          label: r.lead,
          stateLabel: r.status === 'fail' ? '没说完' : r.status === 'run' ? (r._now ? '执行中' : '分析中') : '已完成',
          state: r.status === 'fail'
            ? '这一轮被拦下了，可以再 @ 他一次'
            : r.status === 'run'
              ? (r._now || '正在接着往下做…')
              : ((r.toolN ? `跑了 ${r.toolN} 步` : '答完了') + (rFiles.length ? ` · 产出 ${rFiles.length} 个文件` : '')),
          done: r.toolN || 0,
          total: nodeSteps(''),
          startAt: r.startedAt || 0,
          endAt: r.status === 'run' ? 0 : ((r.startedAt || 0) + (r.ms || 0)),
          tokens: r.usage || { in: 0, out: 0 },
          budgetTokens: nodeBudget()
        }).replace('id="liveTick"', '') : '';
        h += rBar + says + rBub + rFileHtml + rCard;
        /* 这条回复干活途中问老板的拍板卡：挂在回复下面，和节点拍板同一套样式 */
        const fAsks = (m.nodeAsks || []).filter(a => a && a.followKey === rkey);
        if (fAsks.length) h += fAsks.map(nodeAskHTML).join('');
      });

      const hasRecap = !!(f.a || (f.needsBoss || []).length || (f.todos || []).length);
      if (!hasRecap) return;
      const secOnly = (f.only || []).length === 1 && f.only[0] === sec.name;
      h += botRow(sec, secOnly ? '回你' : '收口', `
        ${f.a ? md(f.a) : '<span class="mt-wait">正在汇总…</span>'}
        ${(f.needsBoss || []).length ? `<div class="mt-blk"><span class="mt-k">只有你能拍的</span>${f.needsBoss.map(x => `<div class="mt-li boss">· ${esc(x)}</div>`).join('')}</div>` : ''}
        ${(f.todos || []).length ? `<div class="mt-blk"><span class="mt-k">这一轮的待办</span>
          <div class="mt-todo-h"><span>做什么</span><span>谁</span><span>什么时候</span></div>
          ${f.todos.map(t => `<div class="mt-todo"><span>${esc(t.what)}</span><span>${esc(t.who || '')}</span><span>${esc(t.when || '')}</span></div>`).join('')}
        </div>` : ''}
      `);
    });

    /* 6. 进行中 / 出错 */
    if (BUSY.has(m.status) || (m.busy && m.status === 'done')) {
      const chN = sec.name;
      const txt = m.busyText || (m.status === 'briefing' ? `${chN} 在读你的主题，准备要问你的问题…`
        : m.status === 'analyzing' ? '按路径一层层往下跑…'
          : (m.outputs || []).length && !m.minutes ? `${chN} 在把大家的发言收成纪要…`
            : m.status === 'done' ? '成员在回应…'
              : `${chN} 在排执行路径、指派对口成员…`);
      const outs0 = m.outputs || [];
      const nodes0 = m.plan ? planNodes(m) : [];
      const total = nodes0.length || outs0.length;
      const settled = outs0.filter(o => o.status === 'done' || o.status === 'weak').length;
      const running = outs0.filter(o => o.status === 'run');
      const redoN = outs0.filter(o => o.status === 'run' && o.redo).length;
      /* 用已完成节点的实际耗时估剩余时间：比「已等 122s」有用得多 */
      const msList = outs0.filter(o => o.ms > 0).map(o => o.ms);
      const avg = msList.length ? msList.reduce((a, b) => a + b, 0) / msList.length : 45000;
      const left = Math.max(0, total - settled);
      const lanes = Math.min(3, Math.max(1, left));
      const eta = Math.round(avg * Math.ceil(left / lanes) / 1000);
      const rows = running.map(o => `<div class="pr-r" data-id="${esc(o.id)}">
          <span class="pr-d${o.redo ? ' redo' : ''}"></span>
          <span class="pr-n">${esc(o.id)} ${esc(o.title)}<em>${esc(o.lead || '')}</em></span>
          <span class="pr-s">${esc(o.now || '在跑…')}</span>
          <span class="pr-t" data-t0="${o.startedAt || 0}"></span>
        </div>`).join('');
      h += `<div class="node dashed">
        <div class="node-h">
          <span class="n">…</span><b class="muted">${esc(txt)}</b>
          <span class="args mt-el" data-t0="${m.phaseStart || 0}"></span>
        </div>
        ${rows ? `<div class="pr-list">${rows}</div>` : ''}
        <div class="pr-foot">
          <span>已完成 ${settled}/${total || '—'}</span>
          ${redoN ? `<span class="pr-rd">重做 ${redoN} 节</span>` : ''}
          ${left && avg ? `<span class="pr-eta">预计还要约 ${eta >= 90 ? Math.round(eta / 30) * 30 : Math.max(10, Math.round(eta / 10) * 10)}s</span>` : ''}
        </div>
      </div>`;
    }
    if (m.error) h += `<div class="alert err"><div class="grow">${esc(m.error)}</div></div>`;

    return h || `<div class="empty"><div class="empty-t">项目刚开始</div><div class="empty-d">等 ${esc(sec.name)} 拆题。${''}</div></div>`;
  }

  function bindBody(m) {
    const box = el('meetBody');
    /* 拆题阶段的拍板卡（#askBrief）：选项点一下多选、自定义框就地记，确认按钮提交 */
    const askBrief = box.querySelector('#askBrief');
    if (askBrief) {
      askBrief.querySelectorAll('.ask-opt').forEach(b => {
        b.onclick = () => {
          if (BUSY.has(m.status) || !m.pending) return;
          const q = Number(b.dataset.q);
          const v = b.dataset.v;
          const arr = picksOf(m, q).slice();
          const k = arr.indexOf(v);
          if (k >= 0) arr.splice(k, 1); else arr.push(v);
          /* 只选中一个时仍存成字符串，旧数据与云端老记录都还能读 */
          m.pending.answers[q] = arr.length === 1 ? arr[0] : arr;
          /* 不整页重绘：老板可能正在下面的补充框里打字 */
          askBrief.querySelectorAll(`.ask-opt[data-q="${q}"]`).forEach(x => {
            x.classList.toggle('on', arr.includes(x.dataset.v));
          });
          /* 只改内存，提交时统一落盘 */
        };
      });
      askBrief.querySelectorAll('.ask-custom').forEach(inp => {
        inp.addEventListener('input', () => {
          if (!m.pending) return;
          if (!m.pending.extra) m.pending.extra = {};
          m.pending.extra[Number(inp.dataset.q)] = inp.value;
        });
      });
      const ok = askBrief.querySelector('#askBriefOk');
      if (ok) ok.onclick = () => {
        const note = el('meetInput') ? el('meetInput').value.trim() : '';
        if (el('meetInput')) el('meetInput').value = '';
        submitAnswers(m, note);
      };
    }
    const pt = box.querySelector('[data-act="path"]');
    if (pt) pt.onclick = () => { m.pathOpen = !m.pathOpen; render(); };
    const hold = box.querySelector('[data-act="hold"]');
    if (hold) hold.onclick = () => {
      cancelAutoRun(m);
      render();
      window.APP.toast('已暂停自动开跑，看完再点右下角开跑');
    };
    const budRaise = box.querySelector('[data-act="budraise"]');
    if (budRaise) budRaise.onclick = () => raiseBud(m);
    const budStop = box.querySelector('[data-act="budstop"]');
    if (budStop) budStop.onclick = () => finishNow(m);
    const credPay = box.querySelector('[data-act="credtopup"]');
    if (credPay) credPay.onclick = () => {
      if (window.APP.openPoints) window.APP.openPoints();
      else window.APP.toast('点右上角积分去充值');
    };
    const credGo = box.querySelector('[data-act="creditresume"]');
    if (credGo) credGo.onclick = () => {
      /* 没充就点：先把话说清楚，别让它跑起来又停一次 */
      if (creditOut()) return window.APP.toast('余额还是 0，充完再到账几秒后点这个按钮');
      m.creditHold = null;
      m.error = '';
      startAnalysis(m);
    };
    /* 节点落盘的文件：点开直接看全文 */
    box.querySelectorAll('.mt-file[data-file]').forEach(b => {
      b.onclick = () => {
        if (window.APP.openFile) window.APP.openFile(b.dataset.file);
      };
    });
    /* 工具步骤折叠条：点一下展开/收起这一节跑了哪些工具（对齐任务线的 N 步执行）。
       键两种：纯数字 = 节点 outputs[i]；r{fi}-{ri} = follow 回复 follow[fi].replies[ri] */
    box.querySelectorAll('.turn-bar[data-mt-steps]').forEach(bar => {
      const key = String(bar.dataset.mtSteps);
      bar.onclick = () => {
        let o = null;
        const rm = /^r(\d+)-(\d+)$/.exec(key);
        if (rm) {
          const f = (m.follow || [])[Number(rm[1])];
          o = f && (f.replies || [])[Number(rm[2])];
        } else {
          o = (m.outputs || [])[Number(key)];
        }
        if (!o) return;
        if (o._stepsOpen) { o._stepsOpen = false; render(); return; }
        o._stepsOpen = true; render();
      };
    });
    /* 已展开的步骤明细：点 node-h 展开/收起单步输出 */
    box.querySelectorAll('.mt-steps-open .node-h[data-toggle]').forEach(h => {
      h.addEventListener('click', () => {
        const node = h.closest('.node');
        const b = node.querySelector('.node-b');
        if (!b) return;
        b.hidden = !b.hidden;
        const caret = h.querySelector('.caret');
        if (caret) caret.textContent = b.hidden ? '▸' : '▾';
      });
    });
    bindAsks(m);
  }

  /* ── 节点执行中的拍板 ──
     子任务做到一半要老板定口径：节点挂起（等待期不烧 token），
     老板在项目里或「待我决策」页答完，答案回给那一节接着跑。
     多个节点同时问时按 P0 > P1 > P2 依次摆出来。 */
  function nodeAskHTML(a) {
    const isFollow = !!a.followKey;
    const whoDesc = isFollow
      ? `${esc(a.lead || '参与人')} 干活途中提问，答完他接着干`
      : `${esc(a.lead || '参与人')} 在执行「${esc(a.nodeTitle || a.nodeId || '')}」时提问，答完他接着干`;
    return `<div class="ask-form" data-ask="${esc(a.askId)}">
      <div class="ask-hd mt-ask-hd"><b>需要你拍板</b>
        <span>${whoDesc}</span>
        ${a.priority ? `<i class="mt-pri ${esc(String(a.priority).toLowerCase())}">${esc(a.priority)}</i>` : ''}</div>
      ${a.intro ? `<div class="ask-intro">${esc(a.intro)}</div>` : ''}
      ${(a.questions || []).map((q, i) => `
        <div class="ask-q" data-i="${i}">
          <div class="ask-qt">${i + 1}. ${esc(q.q)}</div>
          <div class="ask-opts" data-multi="${q.multi ? 1 : 0}">
            ${(q.options || []).map(o => `<button type="button" class="ask-opt" data-q="${i}">${esc(o)}</button>`).join('')}
            <input class="ask-custom" data-q="${i}" type="text" autocomplete="off"
                   placeholder="${(q.options || []).length ? '都不合适？自己填…' : '写你的答案…'}">
          </div>
        </div>`).join('')}
      <div class="ask-ft"><button class="ask-ok" type="button">确认，继续</button>
        <span class="ask-note">没答的按默认假设走；等待期不消耗 token</span></div>
    </div>`;
  }

  function bindAsks(m) {
    const box = el('meetBody');
    box.querySelectorAll('.ask-form[data-ask]').forEach(card => {
      card.querySelectorAll('.ask-opt').forEach(elm => {
        elm.onclick = () => {
          const opts = elm.closest('.ask-opts');
          if (opts.dataset.multi === '1') { elm.classList.toggle('on'); return; }
          opts.querySelectorAll('.ask-opt.on').forEach(x => x.classList.remove('on'));
          elm.classList.add('on');
        };
      });
      card.querySelectorAll('.ask-custom').forEach(inp => {
        inp.oninput = () => {
          if (inp.value.trim()) inp.closest('.ask-opts').querySelectorAll('.ask-opt.on').forEach(x => x.classList.remove('on'));
        };
      });
      const ok = card.querySelector('.ask-ok');
      if (ok) ok.onclick = () => {
        const askId = card.dataset.ask;
        const entry = (m.nodeAsks || []).find(x => x && x.askId === askId);
        const qs = (entry && entry.questions) || [];
        const answers = qs.map((q, i) => {
          const picks = [...card.querySelectorAll(`.ask-opt.on[data-q="${i}"]`)].map(x => x.textContent.trim());
          const custom = (card.querySelector(`.ask-custom[data-q="${i}"]`) || {}).value || '';
          return { text: [...picks, custom.trim()].filter(Boolean).join('；') };
        });
        answerNodeAsk(m.id, askId, answers);
      };
    });
  }

  function answerNodeAsk(meetingId, askId, answers) {
    const m = S().meetings.find(x => x.id === meetingId);
    if (!m || !Array.isArray(m.nodeAsks)) return window.APP.toast('这一条已经不在等拍板了');
    const entry = m.nodeAsks.find(x => x && x.askId === askId);
    if (!entry || typeof entry.resolve !== 'function') {
      m.nodeAsks = m.nodeAsks.filter(x => x !== entry);
      render(); save(m);
      return window.APP.toast('这一条已经答过了');
    }
    const list = (Array.isArray(answers) ? answers : []).map(a => ({ text: (a && a.text) || '' }));
    const any = list.some(a => a.text);
    window.APP.toast(any ? '已确认，他接着干' : '没作答，按默认假设继续');
    entry.resolve(any ? list : []);
    render();
    save(m);
  }

  /* 决策页要把执行中的拍板也摊出来（app.js decisionItems 调它） */
  function liveNodeAsks(m) {
    return (m && Array.isArray(m.nodeAsks)) ? m.nodeAsks.filter(Boolean) : [];
  }

  /* ── 输入框 @ 定向：@ 到谁，谁才接这一句 ── */
  let mn = { open: false, at: -1, q: '', idx: 0, from: 'input' };

  function mnPool(m) {
    return ((m && m.participants) || []).filter(p => p.kind !== 'human');
  }

  function mnMatches(m) {
    const q = String(mn.q || '').trim().toLowerCase();
    const pool = mnPool(m);
    if (!q) return pool;
    return pool.filter(p => {
      const name = String(p.name || '').toLowerCase();
      const role = String(p.role || '').toLowerCase();
      return name.includes(q) || role.includes(q) || shortRole(p.role).toLowerCase().includes(q);
    });
  }

  function mnClose() {
    const p = el('mnPop');
    if (p) p.hidden = true;
    mn = { open: false, at: -1, q: '', idx: 0, from: 'input' };
  }

  /* 底栏右侧员工 chip 的内容：文本 + 上箭头，保持可点击的「选人」样式 */
  function whoChip(text) {
    return `${esc(text)}<i class="emp-chip-arr">⌃</i>`;
  }
  function setWhoChip(text) {
    const w = el('meetWho');
    if (w) w.innerHTML = whoChip(text || '');
  }

  function placeMn() {
    const p = el('mnPop');
    const anchor = mn.from === 'who' ? el('meetWho') : el('meetInput');
    const ta = anchor || el('meetInput');
    if (!p || !ta || p.hidden) return;
    const r = ta.getBoundingClientRect();
    const h = p.offsetHeight || 260;
    p.style.left = Math.max(10, Math.min(r.left, window.innerWidth - p.offsetWidth - 10)) + 'px';
    p.style.top = Math.max(10, r.top - h - 8) + 'px';
    p.style.width = Math.min(360, Math.max(260, r.width - 40)) + 'px';
  }

  function renderMn(m) {
    const p = el('mnPop');
    if (!p) return;
    const list = mnMatches(m);
    if (!list.length) {
      p.hidden = false; mn.open = true;
      p.innerHTML = '<div class="mn-empty">没有匹配的参会人，参会名单里没有这位。</div>';
      placeMn();
      return;
    }
    if (mn.idx > list.length - 1 || mn.idx < 0) mn.idx = 0;
    p.hidden = false; mn.open = true;
    p.innerHTML = '<div class="mn-h">' + (mn.from === 'who' ? '选谁接这句话（点一下即 @ 他）' : '只让他回这一句（其他人不接话）') + '</div>' + list.map((s, i) =>
      `<div class="mn-item${i === mn.idx ? ' on' : ''}" data-i="${i}">
        <i class="mn-av">${esc(String(s.name || '?').slice(0, 1))}</i>
        <b>${esc(s.name)}</b><em>${esc(shortRole(s.role))}</em>
      </div>`).join('');
    placeMn();
  }

  function pickMn(m, i) {
    const list = mnMatches(m);
    const p = list[i];
    if (!p) return mnClose();
    const ta = el('meetInput');
    const v = ta.value;
    const at = mn.at < 0 ? v.length : mn.at;
    const before = v.slice(0, at);
    const after = v.slice(at).replace(/^@[^\s@]*\s*/, '');
    const ins = `@${p.name} `;
    ta.value = before + ins + after;
    const caret = (before + ins).length;
    mnClose();
    ta.focus();
    try { ta.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
    /* 选完人，底栏 chip 立即反映「只回谁」 */
    const names = mentionsIn(m, ta.value).map(x => x.name);
    setWhoChip(names.length ? `只回 ${names.join('、')}` : `牵头人 ${chiefOf(m).name}`);
  }

  /* 点输入区右侧的员工 chip = 单选一位参会人，选完自动在输入框里 @ 他。
     与手打 @ 同一套机制，只是把「选人」这一步做成可点。 */
  function toggleMeetWhoPop() {
    const m = cur();
    if (!m || m.busy) return;
    const p = el('mnPop');
    if (!p) return;
    if (mn.open && mn.from === 'who') { mnClose(); return; }
    // 只列 AI 参会人（真人成员靠点名，不在自动回复池里）
    const pool = mnPool(m);
    if (!pool.length) return window.APP.toast('这场会还没有可接话的 AI 成员');
    mn = { open: true, at: -1, q: '', idx: 0, from: 'who' };
    renderMn(m);
  }

  /* 从一句话里认出 @ 了谁（名字互为前缀时取长的，先匹配先剥掉） */
  function mentionsIn(m, text) {
    const pool = mnPool(m);
    const hit = new Set();
    let rest = String(text || '');
    const escRe = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pool.map(p => String(p.name || '')).filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .forEach(n => {
        const re = new RegExp('@' + escRe(n), 'g');
        if (re.test(rest)) { rest = rest.replace(re, ''); hit.add(n); }
      });
    return pool.filter(p => hit.has(p.name));
  }

  /* 点顶部参会人 chip，等于在输入框里 @ 他；任何阶段都可，正在生成时不行 */
  function insertMention(m, name) {
    const ta = el('meetInput');
    if (!ta || m.busy) return;
    const v = ta.value;
    const caret = ta.selectionStart == null ? v.length : ta.selectionStart;
    const pre = v.slice(0, caret);
    const need = pre && !/\s$/.test(pre) ? ' ' : '';
    const ins = need + '@' + name + ' ';
    ta.value = pre + ins + v.slice(caret);
    const pos = (pre + ins).length;
    mnClose();
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';
    const names = mentionsIn(m, ta.value).map(p => p.name);
    setWhoChip(names.length ? `只回 ${names.join('、')}` : `全体参会 ${mnPool(m).length} 人`);
  }

  function stripMentions(m, text) {
    let out = String(text || '');
    mnPool(m).map(p => String(p.name || '')).filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .forEach(n => { out = out.replace(new RegExp('@' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ''); });
    return out.replace(/\s{2,}/g, ' ').trim();
  }

  /* ── 底部输入区 ── */
  function syncComposer() {
    const m = cur();
    const send = el('meetSend');
    const proc = el('meetProceed');
    const input = el('meetInput');
    const hint = el('meetHint');

    if (!m) {
      setWhoChip('');
      input.value = '';
      input.placeholder = '先新建一个项目';
      input.disabled = true;
      send.disabled = true;
      send.textContent = '↑';
      send.onclick = null;
      proc.hidden = true;
      if (hint) hint.textContent = '点左上角「＋ 新建项目」开始。';
      return;
    }
    const sec = chiefOf(m);
    const speakerN = m.participants.filter(p => p.kind !== 'human').length;
    // 会开完之后的发言是全员场：谁都能接；平时对话窗口署名牵头人（拆题/收口都是他）
    setWhoChip(m.status === 'done' && speakerN > 1 ? `全体成员 ${speakerN} 人` : `牵头人 ${sec.name}`);
    input.disabled = false;

    if (m.busy) {
      send.disabled = false;
      send.textContent = '■';
      send.onclick = () => { if (m.abort) m.abort.abort(); };
      proc.hidden = true;
      if (hint) hint.textContent = '正在跑。想改方向就打字回车（这一轮跑完自动发给他）；点「停止」可打断。';
      input.placeholder = '插一句（可 @ 人），这一轮结束就发…';
      return;
    }
    send.textContent = '↑';
    send.onclick = () => sendMsg();

    if (m.status === 'awaiting') {
      const unanswered = (m.brief && m.brief.questions || []).length > 0 && !anyAnswer(m);
      input.placeholder = '也可以在这里直接说：你的答案、纠正、或者补一条它没问到的。';
      proc.hidden = false;
      proc.textContent = unanswered ? '按你的假设走，直接拆' : '确认，继续';
      // 点按钮时把输入框里的补充一起带上，别让它白写
      proc.onclick = () => { const t = el('meetInput').value.trim(); el('meetInput').value = ''; submitAnswers(m, t); };
      if (hint) hint.textContent = unanswered
        ? '不想逐条答就点右边：它会按上面那几条默认假设往下拆，写到哪条你不同意再打断。'
        : `你定方向，${sec.name} 只负责把题问清楚。没答的按默认假设走。`;
    } else if (m.status === 'confirm') {
      const nodes = planNodes(m);
      const waves = planWaves(nodes);
      input.placeholder = '要改就在这说（例如：成本得先于定价；这两个没有先后，可以并行）';
      proc.hidden = false;
      proc.textContent = m.autoIn > 0 ? `马上开跑（${m.autoIn}s）` : '确认，按这个路径开跑';
      proc.onclick = () => { el('meetInput').value = ''; startAnalysis(m); };
      if (hint) hint.textContent = waves.length > 1
        ? `一共 ${nodes.length} 个节点、${waves.length} 层：前置没出结果，下一节不会开工。`
        : `一共 ${nodes.length} 个节点，互不依赖，会一起跑。`;
    } else if (m.status === 'analyzing') {
      /* 中途被打断：从断点接着跑，已核验的节点不重来 */
      const outs = m.outputs || [];
      const leftN = outs.filter(o => o.status === 'wait' || o.status === 'run' || o.status === 'fail').length;
      input.placeholder = '要补一句就直说（例如：T2 那个成本口径改成含税）';
      proc.hidden = !leftN;
      if (m.budgetHold) {
        proc.textContent = `再加 ${Math.round(BUD.raise / 10000)} 万接着跑`;
        proc.onclick = () => raiseBud(m);
        if (hint) hint.textContent = `这一场已经花了 ${budSpent(m)} token，到上限了。不想再烧就点上面的「停在这里，出纪要」。`;
      } else {
        proc.textContent = `继续跑（还剩 ${leftN} 节）`;
        proc.onclick = () => startAnalysis(m);
        if (hint) hint.textContent = '上一轮没跑完，点右边从断点接着走；已经跑过的不会重来。';
      }
    } else if (m.status === 'halted') {
      /* 积分用完停下的：按钮直接指向「去充值」，别给一个点了还会再停一次的继续 */
      const outs = m.outputs || [];
      const leftN = outs.filter(o => o.status === 'wait' || o.status === 'run' || o.status === 'fail').length;
      input.placeholder = '充值到账后点右边接着跑；也可以在这儿说一句要改什么。';
      proc.hidden = false;
      if (creditOut()) {
        proc.textContent = '去充值';
        proc.onclick = () => { if (window.APP.openPoints) window.APP.openPoints(); };
        if (hint) hint.textContent = `积分已经用完${leftN ? `，还剩 ${leftN} 节没跑` : '，只差纪要'}；充完值再点「继续跑」。`;
      } else {
        proc.textContent = `继续跑（还剩 ${leftN} 节）`;
        proc.onclick = () => { m.creditHold = null; m.error = ''; startAnalysis(m); };
        if (hint) hint.textContent = '余额已到账，点右边从断点接着走；跑过的不会重来。';
      }
    } else if (m.status === 'done') {
      input.placeholder = '在会上说一句：默认全员回应；打 @ 选人，就只让那一位回。';
      proc.hidden = true;
      proc.onclick = null;
      if (hint) if (hint) hint.textContent = '';
    } else if (m.status === 'failed') {
      input.placeholder = '可以继续说，或者重新拆一次。';
      proc.hidden = false;
      proc.textContent = '重新拆题';
      proc.onclick = () => runBrief(m);
      if (hint) hint.textContent = '上一次中断了，重新拆题会保留已有内容重来。';
    } else {
      proc.hidden = true;
      if (hint) hint.textContent = `等 ${sec.name} 说完这一轮。也可以 @ 某位同事，让他接着干。`;
    }
  }

  async function sendMsg() {
    const m = cur();
    if (!m) return;
    /* 会中补附件：随时可以加，加完就地解析一遍；本条带的图要随这一句送给成员看 */
    let added = [];
    if (window.ATT_MEET) {
      const add = window.ATT_MEET.take();
      if (add.length) {
        m.files = [...(m.files || []), ...add];
        m.docText = '';
        await ingestFiles(m);
        save(m);
        window.APP.toast(`已读入 ${add.length} 个附件`);
        added = add;
      }
    }
    const input = el('meetInput');
    const text = input.value.trim();
    const mentions = mentionsIn(m, text);
    /* 跑着的时候（拆题/拆解/分析中）插话：先记下来，这一轮结束自动补发，不打断正在跑的活。
       对齐任务线「跑着也能改方向」——只是项目线有状态机，用排队而不是即时注入。 */
    if (m.busy) {
      if (!text && !added.length) return window.APP.toast('想说什么？打几个字或 @ 某位同事');
      if (!Array.isArray(m.pendingFollow)) m.pendingFollow = [];
      m.pendingFollow.push({ text, mentions: mentions.map(p => p.name), added });
      input.value = '';
      window.APP.toast('已记下，这一轮跑完就发给他');
      return;
    }
    /* @ 了谁就只让谁接这一句、让他接着干——任何阶段都支持；没 @ 才走各阶段的原逻辑 */
    if (mentions.length) {
      input.value = '';
      return followUp(m, text, mentions, added);
    }
    if (m.status === 'awaiting') {
      if (!text && !anyAnswer(m)) return window.APP.toast('选一个选项，或者直接说你的答案');
      input.value = '';
      return submitAnswers(m, text);
    }
    if (m.status === 'confirm') {
      input.value = '';
      if (!text) return startAnalysis(m);
      return replan(m, text);
    }
    if (m.status === 'done') {
      if (!text && !added.length) return window.APP.toast('想说什么？@ 某位同事可以只让他回');
      input.value = '';
      return followUp(m, text, [], added);
    }
    if (m.status === 'failed') return runBrief(m);
    window.APP.toast('等这一轮说完');
  }

  function anyAnswer(m) {
    if (!m.pending) return false;
    const hasPick = (m.brief && m.brief.questions || []).some((q, i) => answerOf(m, i));
    return hasPick || !!(m.pending.note || '').trim();
  }

  /* ── 模型调用 ── */
  const secOf = m => secretaryOf(m);
  function secretaryOf(m) {
    return m.participants.find(p => /秘书/.test(p.role)) || m.participants[0] || S().staff[0] || { name: '秘书', role: '秘书', persona: 'mature' };
  }
  function modelOf(p) {
    return (p && p.model) || S().settings.model || '';
  }
  /* 标准员工库的训练记忆：按 stdId 缓存，由 primeStdMem() 在跑节点前异步预热。
     为什么不在 personaLine 里 await：这一处被 8 个提示词模板同步调用，改成异步会把整条链路都染成 async。 */
  const STD_MEM = {};
  async function primeStdMem(list) {
    if (!window.CLOUD || typeof CLOUD.listStdMemOf !== 'function') return;
    const ids = [...new Set((list || []).map(x => Number((x && x.stdId) || 0)).filter(Boolean))]
      .filter(id => !STD_MEM[id]);
    if (!ids.length) return;
    await Promise.all(ids.map(async id => {
      try { STD_MEM[id] = (await CLOUD.listStdMemOf(id)) || []; }
      catch (e) { STD_MEM[id] = []; }
    }));
  }
  function stdMemLine(p) {
    const arr = STD_MEM[Number((p && p.stdId) || 0)];
    if (!arr || !arr.length) return '';
    const KN = { rule: '规矩', exp: '经验', pref: '偏好', fact: '事实', note: '备注' };
    return ['你被训练时留下的记忆（照这里的口径做；冲突时以这里为准）：',
      ...arr.slice(0, 40).map((x, i) => `${i + 1}. [${KN[x.kind] || '备注'}] ${String(x.text || '').trim()}`)
    ].join('\n');
  }
  /* 一段话交代「这个人怎么说话」：有性格四维度（性别/生肖/星座/MBTI）就按它讲，
     一项没填才回落到老人设，老项目里的人不会因为改版突然变声。 */
  function personaLine(p) {
    /* 以员工档案里的当前值为准：老板刚改完性格，老项目也应该立刻用新的口径 */
    const cur = (p && p.id && (S().staff || []).find(s => s.id === p.id)) || p || {};
    const t = (window.TRAITS && typeof window.TRAITS.prompt === 'function')
      ? String(window.TRAITS.prompt(cur) || '') : '';
    const per = (window.BOSS.PERSONAS || {})[cur.persona] || { n: '成熟', d: '稳重、有分寸、先讲影响面' };
    const style = t || `说话风格：${per.n} —— ${per.d}`;
    const mem = stdMemLine(cur);
    return mem ? `${style}\n${mem}` : style;
  }

  function addTokens(m, u) {
    if (!u) return;
    const d = (u.in || 0) + (u.out || 0);
    m.tokens.in += u.in || 0;
    m.tokens.out += u.out || 0;
    /* 项目也烧真 token，同样要扣积分。这里只报「这一次涨了多少」，
       幂等键用累计量（APP.chargeMeeting 里拼），重试不会重复扣。 */
    const A = window.APP;
    if (A && A.chargeMeeting) A.chargeMeeting(m, d, m.tokens.in + m.tokens.out);
  }

  /* ── token 预算：上限先看这个项目有没有单独调过，没有就用设置里的默认值 ── */
  function budKey(m) { return 'boss.bud.' + (m.id || 'x'); }
  function budCap(m) {
    try {
      const v = Number(localStorage.getItem(budKey(m)));
      if (v > 0) return v;
    } catch (e) { /* 读不到就按默认值 */ }
    return limOf().tokens;
  }
  function budSet(m, v) {
    m.budgetCap = v;
    try { localStorage.setItem(budKey(m), String(v)); } catch (e) { /* 存不上不影响这一轮 */ }
  }
  function budSpent(m) {
    const t = m.tokens || {};
    return (t.in || 0) + (t.out || 0);
  }
  function overBud(m) { return budSpent(m) >= budCap(m); }
  /* 预算到线：不是错误，是一种「停在这里等老板拍板」的走法 */
  const holdErr = () => Object.assign(new Error('budget_hold'), { name: 'BudgetHold' });

  /* ── 积分闸 ──
     项目一次会同时开三个节点，欠账跑一轮就是三份 token。
     所以每一层、每个节点动手之前都先问一句「还有没有钱」，没钱立刻停。 */
  function creditOut() {
    const A = window.APP || {};
    return typeof A.creditLeft === 'function' ? A.creditLeft() <= 0 : false;
  }
  const noCreditErr = () => Object.assign(new Error('no_credit'), { name: 'NoCredit' });
  function creditGuard() { if (creditOut()) throw noCreditErr(); }
  /* 每个节点/每一层的统一入口：先看钱，再看 token 额度。
     钱是硬闸（欠账跑出来的活没法结算），额度是软闸（可以加额度接着跑）。 */
  function guardRun(m) { creditGuard(); if (overBud(m)) throw holdErr(); }

  async function stream({ model, system, user, images, onDelta, signal, maxTokens }) {
    /* 图片走视觉通道；模型看不了就自动退回纯文字，不让整场会卡死 */
    const imgs = (images || []).filter(x => x && x.dataUrl).slice(0, 4);
    const build = withImg => {
      const content = (withImg && imgs.length)
        ? [{ type: 'text', text: String(user || '') },
           ...imgs.map(im => ({ type: 'image_url', image_url: { url: im.dataUrl } }))]
        : String(user || '');
      const payload = {
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content }],
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.3,
        // 不封顶的话，遇上爱长篇的模型会一个人说十分钟
        max_tokens: maxTokens || 1200
      };
      if (signal) payload.signal = signal;
      return payload;
    };
    const consume = async payload => {
      let text = '';
      let reasoning = '';
      let usage = null;
      for await (const chunk of window.CLOUD.chatStream(payload)) {
        const d = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (d && d.content) { text += d.content; if (onDelta) onDelta(text); }
        /* 推理型模型（如 DeepSeek-R1）会把正文放进 reasoning_content，content 反而空；
           单独收着，正文为空时兜底，别让这一位白答、显示成「（没有内容）」 */
        if (d && d.reasoning_content) reasoning += d.reasoning_content;
        if (chunk && chunk.usage) usage = chunk.usage;
      }
      if (!text && reasoning) text = reasoning;
      return {
        text,
        usage: { in: (usage && usage.prompt_tokens) || 0, out: (usage && usage.completion_tokens) || 0 }
      };
    };
    try {
      return await consume(build(true));
    } catch (e) {
      const msg = String((e && e.message) || '');
      if (imgs.length && /image|vision|multimodal|invalid.*content|content.*invalid/i.test(msg)) {
        window.APP.toast('当前模型看不了图片，这一轮按文字继续');
        return consume(build(false));
      }
      throw e;
    }
  }

  function extractJSON(raw) {
    let s = String(raw || '').trim();
    /* 剥代码围栏：开头/结尾/中间出现的都剥掉 */
    s = s.replace(/```(?:json)?[\s\S]*?```/gi, m => m.replace(/```(?:json)?/i, '').replace(/```$/, ''));
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    /* 策略 1：取第一个 { 到最后一个 } */
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      const body = s.slice(a, b + 1);
      try { return JSON.parse(body); } catch (e) { /* 继续 */ }
      try { return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); } catch (e) { /* 继续 */ }
      /* 策略 2：截断 JSON——尝试补齐缺失的括号 */
      const fixed = closeBrackets(body);
      if (fixed) { try { return JSON.parse(fixed); } catch (e) { /* 继续 */ } }
    }
    /* 策略 3：逐行找第一个合法 JSON 对象（模型偶尔在 JSON 前后加说明文字） */
    for (const line of s.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try { return JSON.parse(t); } catch (e) { /* 继续 */ }
      try { return JSON.parse(closeBrackets(t) || ''); } catch (e) { /* 继续 */ }
    }
    return null;
  }

  /* 尝试补齐未闭合的 { 和 [（模型输出被 maxTokens 截断时用） */
  function closeBrackets(s) {
    const stack = [];
    let inStr = false, esc = false;
    for (const ch of s) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
      else if (ch === '}' || ch === ']') { if (stack.length) stack.pop(); }
    }
    if (!stack.length) return null;
    return s + stack.reverse().join('');
  }

  async function callJSON({ m, model, system, user, images, signal, maxTokens }) {
    const limit = maxTokens || 3000;
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const sys = attempt
        ? system + (attempt >= 2
          ? '\n\n这是第三次尝试。**只输出 JSON**，没有任何解释、没有代码围栏、没有前后缀。用最短的字符串值，不要写长句。'
          : '\n\n上一次你的输出不是合法 JSON。这次只输出 JSON 本身：不要解释、不要前后缀、不要代码围栏。')
        : system;
      const r = await stream({ model, system: sys, user, images, signal, maxTokens: limit });
      addTokens(m, r.usage);
      const obj = extractJSON(r.text);
      if (obj) return obj;
      last = r.text;
    }
    throw new Error('模型没给出可解析的结构（' + String(last).slice(0, 60) + '…）');
  }

  /* ── 阶段 1：牵头人拆题 ── */
  function briefSystem(sec) {
    return [
      `你是「${sec.name}」，老板的${rolePhrase(sec.role)}，正在主持一场内部会。${personaLine(sec)}`,
      sec.notes ? `老板对你的额外交代：${sec.notes}` : '',
      '',
      '老板刚给了一个议题。你的目标不是「把问题问清楚」，是「这件事今天就能开工」——问是为了开工，不是为了周全。',
      '规则：',
      '1. understanding：一句话说清这次最终要拍的是什么（不是复述原话，要说出决策对象）。',
      '2. 先自己定 80%：能靠常识、行业惯例、附件信息、老板过往说法定下来的，一律不要问。把它写进 assumptions，并且每条都补一句「按这个走，结论会怎么变」，让老板扫一眼就知道要不要改。',
      '3. questions：最多 2 个，而且只有「答案会直接改变做法、你确实猜不出来」的才配占一个名额。宁可少问——一个可有可无的问题，会让整场会停在原地等。',
      '4. 每个问题给 2–4 个具体选项。选项要是结论或口径（例如「先做两周可行性验证」「按 3000 只首单」），不要写「方案 A」。',
      '5. 老板如果给了附件或图片：把里面的关键数字、金额、条款、期限摘出来，写进 understanding 或 assumptions。后面参会的同事看不到原图，你摘漏了他们就只能瞎猜。',
      '6. 只输出 JSON，不要任何解释。',
      '',
      '输出格式：',
      '{"understanding":"...","questions":[{"q":"...","options":["...","..."]}],"assumptions":["..."]}'
    ].filter(Boolean).join('\n');
  }

  /* ── 把项目附件读成文本：文档走 read_doc，图片交给视觉通道 ── */
  async function ingestFiles(m) {
    const files = m.files || [];
    if (!files.length || m.docText) return;
    const docs = files.filter(f => !f.dataUrl);
    if (!docs.length) return;
    const st = S();
    const parts = [];
    for (const f of docs) {
      try {
        const r = await fetch(window.withSC('/api/tool'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: st.scope, name: 'read_doc',
            args: { path: f.path, max_chars: 6000 }, perms: { read: true }
          })
        });
        const j = await r.json();
        const txt = j && j.ok && j.result ? String(j.result.output || '') : '';
        parts.push(`【附件：${f.name}】\n${txt || '（没读出内容）'}`);
      } catch (e) {
        parts.push(`【附件：${f.name}】读取失败：${e.message}`);
      }
    }
    m.docText = parts.join('\n\n').slice(0, 16000);
  }

  /* 注入到各阶段 prompt 里的附件上下文。cap 控制长度：拆题看全文，执行节点看摘要，省 token */
  function attachText(m, cap) {
    const t = String(m.docText || '').trim().slice(0, cap || 16000);
    const imgs = (m.files || []).filter(f => f.dataUrl).length;
    if (!t && !imgs) return '';
    return [
      '',
      '老板提供的附件内容（这是这次讨论的事实基础，别猜）：',
      t,
      imgs ? `（另有 ${imgs} 张图片，前面已经把要点摘在上面了）` : ''
    ].filter(Boolean).join('\n');
  }

  async function runBrief(m) {
    if (m.busy) return;
    /* 拆题是牵头人的活：把老板的目标问清楚，再交给老板拍板 */
    const sec = chiefOf(m);
    const model = modelOf(sec);
    if (!model) return window.APP.toast('先选一个模型');
    m.busy = true; m.status = 'briefing'; m.error = '';
    m.abort = new AbortController();
    m.phaseStart = Date.now();
    m.t0 = m.t0 || Date.now();
    render(); renderList(); save(m);
    try {
      if ((m.files || []).length) window.APP.toast('正在读你上传的附件…');
      await ingestFiles(m);
      const obj = await withRetry(() => callJSON({
        m, model,
        system: briefSystem(sec),
        user: [
          `项目主题：${m.topic}`,
          (() => { const o = originOf(m); return o && o.brief
            ? `项目前情（这个项目从老板的一个任务转来，这是全员共用的《前情简报》，口径以它为准）：\n${String(o.brief).slice(0, 1000)}`
            : ''; })(),
          `参会同事：${m.participants.map(p => `${p.name}（${p.role}${p.kind === 'human' ? '，真人' : ''}）`).join('、')}`,
          attachText(m)
        ].filter(Boolean).join('\n'),
        images: m.files || [],
        signal: m.abort.signal
      }));
      m.brief = {
        understanding: String(obj.understanding || '').slice(0, 300),
        questions: (Array.isArray(obj.questions) ? obj.questions : []).slice(0, 2).map(q => ({
          q: String(q.q || '').slice(0, 160),
          options: (Array.isArray(q.options) ? q.options : []).slice(0, 4).map(o => String(o).slice(0, 40))
        })).filter(q => q.q),
        assumptions: (Array.isArray(obj.assumptions) ? obj.assumptions : []).slice(0, 4).map(a => String(a).slice(0, 160))
      };
      m.status = 'awaiting';
      m.pending = { answers: {}, extra: {}, note: '' };
    } catch (e) {
      m.status = 'failed';
      m.error = e.name === 'AbortError' ? '你打断了这一轮' : ('拆题失败：' + niceErr(e));
    } finally {
      m.busy = false;
      m.ms = Date.now() - m.t0;
      m.abort = null;
      render(); renderList(); save(m);
    }
    /* 没什么要问的，就别让老板多点一次：直接排执行路径 */
    if (m.status === 'awaiting' && !((m.brief && m.brief.questions) || []).length) {
      await submitAnswers(m, '');
    }
  }

  /* ── 阶段 2：老板答完 → 牵头人确认 + 拆路径 ── */

  /* 一个问题可能选了多个选项，也可能自己补了一句：统一按数组读 */
  function picksOf(m, i) {
    const v = (m.pending && m.pending.answers || {})[i];
    if (Array.isArray(v)) return v.slice();
    return v ? [v] : [];
  }
  function extraOf(m, i) {
    return ((m.pending && m.pending.extra || {})[i] || '').trim();
  }
  /* 选项 + 补充拼成一句给模型看的话 */
  function answerOf(m, i) {
    const parts = picksOf(m, i).slice();
    const ex = extraOf(m, i);
    if (ex) parts.push(ex);
    return parts.join('；');
  }

  function answersText(m) {
    const b = m.brief || { questions: [] };
    const lines = (b.questions || []).map((q, i) => {
      const v = answerOf(m, i);
      return `${q.q}\n老板的回答：${v || '（没答，按你的默认假设走）'}`;
    });
    if (m.pending.note) lines.push(`老板补充：${m.pending.note}`);
    return lines.join('\n\n');
  }

  async function submitAnswers(m, extraText) {
    if (m.busy) return;
    if (extraText) m.pending.note = extraText;
    /* 不答题也能往下走：没答的按「按默认假设」处理。
       以前这里会拦一句「先回答至少一个」，等于把决策权又塞回老板手里——
       老板要的是有人替他先定，不是被追问。 */
    const b = m.brief || { questions: [] };
    m.answers = (b.questions || []).map((q, i) => ({
      q: q.q,
      answer: answerOf(m, i) || (m.pending.note ? '（见补充）' : '按默认假设')
    }));
    if ((m.pending.note || '').trim()) {
      m.answers.push({ q: '补充', answer: m.pending.note.trim() });
    }
    const ansText = answersText(m);

    /* 拆解和分工也由牵头人做：他对老板的口径最熟 */
    const sec = chiefOf(m);
    const model = modelOf(sec);
    m.busy = true; m.status = 'planning'; m.error = '';
    m.abort = new AbortController();
    m.phaseStart = Date.now();
    render(); renderList(); save(m);
    try {
      const obj = await withRetry(() => callJSON({
        m, model,
        system: planSystem(sec, m),
        user: [
          `项目主题：${m.topic}`,
          (() => { const o = originOf(m); return o && o.brief
            ? `项目前情（原任务《前情简报》，拆分工时口径以它为准）：\n${String(o.brief).slice(0, 1000)}`
            : ''; })(),
          `你的理解：${(m.brief && m.brief.understanding) || ''}`,
          `你问的问题和老板的回答：\n${ansText}`,
          attachText(m),
          `参会同事（只能从这些名字里指派）：${m.participants.map(p => `${p.name}（${p.role}${p.kind === 'human' ? '，真人，不发言只接受待办' : ''}）`).join('、')}`
        ].filter(Boolean).join('\n\n'),
        signal: m.abort.signal,
        maxTokens: 4000
      }));
      m.plan = normalizePlan(obj, m);
      pushPlanVersion(m, m.plan, '初版拆解');
      m.status = 'confirm';
      m.pending = { answers: {}, note: '' };
    } catch (e) {
      m.status = 'failed';
      m.error = e.name === 'AbortError' ? '你打断了这一轮' : ('拆解失败：' + niceErr(e));
    } finally {
      m.busy = false;
      m.ms = Date.now() - m.t0;
      m.abort = null;
      render(); renderList(); save(m);
    }
    /* 问题都问完了就别再等老板点一下：路径排好自动开跑 */
    if (m.status === 'confirm') scheduleAutoRun(m);
  }

  /* 待我决策页把项目的题也摊在那儿了：从那边答完直接走同一套拆解流程。
     answers 按题的顺序给，形状是 [{ picks: [...], custom: '...' }]；
     一题没答也允许往下走——没答的按默认假设，别把决策权再塞回老板手里。 */
  async function answerFromBoard(id, answers, allowEmpty) {
    const m = S().meetings.find(x => x.id === id);
    if (!m) return window.APP.toast('这个项目已经不在了');
    if (m.status !== 'awaiting') return window.APP.toast('这个项目已经不需要拍板了');
    if (m.busy) return window.APP.toast('这个项目正在跑，等它停下来再确认');
    const list = Array.isArray(answers) ? answers : [];
    if (!allowEmpty && !list.some(a => a && (a.text || (a.picks || []).length || a.custom))) {
      return window.APP.toast('至少答一题，或者点「按默认假设走」');
    }
    const qs = (m.brief && m.brief.questions) || [];
    m.pending = { answers: {}, extra: {}, note: '' };
    qs.forEach((q, i) => {
      const a = list[i] || {};
      const picks = (a.picks || []).filter(Boolean);
      if (picks.length) m.pending.answers[i] = picks.length === 1 ? picks[0] : picks;
      if (a.custom) m.pending.extra[i] = a.custom;
    });
    /* 切到那个项目：拆解过程能直接看见，不用在空页面上等 */
    open(id);
    window.APP.toast(`已确认，${chiefOf(m).name} 按你的回答往下拆`);
    await submitAnswers(m, '');
  }

  function planSystem(sec, m) {
    return [
      `你是「${sec.name}」，老板的${rolePhrase(sec.role)}。${personaLine(sec)}`,
      sec.notes ? `老板对你的额外交代：${sec.notes}` : '',
      '',
      '老板已经回答了你的问题。现在你要把这件事拆成一条**有先后顺序的执行路径**，不是一堆并列的要素。',
      '',
      '怎么拆（按软件/硬件开发的分析路径来）：',
      '· 先定「口径与范围」：这件事按什么标准算、边界在哪、以什么为准。这一步不做完，后面的数字全是废的。',
      '· 再收「事实与数据」：成本、技术可行性、市场、供应链这类要查要算的，可以并排跑。',
      '· 然后才是「方案与风险」：架构/选型、法务合规、风险矩阵，这些要拿着前面的结论才能判断。',
      '· 最后「结论与建议」：综合成可拍板的建议。',
      '不用把四层都拆满，但依赖关系必须是真的。',
      '',
      '每个节点写：',
      '· id：T1、T2…按执行顺序编号',
      '· title：节点名（两个字到六个字）',
      '· lead：负责的同事，必须从参会名单里选，写名字',
      '· priority：P0（没有它结论不成立，必须先做）/ P1（重要）/ P2（补充）',
      '· deps：这个节点开工前必须先完成哪些节点，写 id 数组。真的不需要前置就写 []，不要为了好看硬加依赖。',
      '· method：从这个池子里选：5W2H、MECE、PDCA、SWOT、RACI、风险矩阵、盈亏平衡、用户旅程、RICE、鱼骨图、六西格玛（6σ）、6S。同一个方法最多用两次。',
      '· question：给这位同事的具体问题（带判定标准，不是标题）',
      '· accept：这个节点交付成什么样才算完成（一句话，可验收）',
      '· deliver：这一节要落盘的文件名，例如「T1-口径与范围.md」。只写文件名，不要带目录、不要带 /。'
        + '中间过程稿一律用 .md；如果这一节本身就是老板要的成品，后缀必须按成品格式写（见硬约束 5）。',
      '',
      '硬约束：',
      '1. 节点 3–8 个，不要更多。',
      '2. 依赖只能是「B 真的要用 A 的产出才能开工」，不能成环，不能自己依赖自己。',
      '3. 同一个节点不能依赖两个互相依赖的节点。',
      '4. 同一时刻能并行跑的（互不依赖、也不抢同一份数据）尽量排成并行，但不要为了并行把该串的拆开。',
      '5. 老板要成品文件时，最后单独加一个成稿节点，后缀按老板要的格式写，前面的节照常各写 .md 中间稿，不要为了出成品把内容都堆到最后：',
      '   · PPT / 汇报稿 / 提案 / 演示材料 → deliver 写 .pptx，question 写成「把前面各节的结论收成一份 8–14 页的 PPT，一页一个结论」；',
      '   · Word / 文档 / 报告 / 方案 / 复盘 → deliver 写 .docx，question 写成「把前面各节的结论收成一份完整文档，分章节、可直接给人看」；',
      '   · Excel / 表格 / 台账 / 报价表 → deliver 写 .xlsx，question 写成「把前面各节的数据收成一张表，列清口径」；',
      '   · 图片 / 海报 / 效果图 / 主视觉 → deliver 写 .png，question 写成「按前面定下的方向出一张图」。',
      '   · 老板没说格式、也推不出（做的东西不像上面任何一种）→ 不要硬塞一个 .md 了事：成稿节点照常，但 understanding 里写明「成品格式待确认」，让老板在开工前定。',
      '',
      'understanding：用老板的答案收敛出一句最终理解（带口径/边界）。',
      'changes：老板哪个回答改变了你原本的判断（没有就给空数组）。',
      'pushback：老板的答案里有矛盾、缺口、或明显乐观的地方，1–2 句提醒；没有就给空数组。',
      '只输出 JSON，不要解释。字段值写短——question/accept 各 ≤30 字，不要写长句：',
      '{"understanding":"...","changes":["..."],"nodes":[{"id":"T1","title":"口径与范围","lead":"何算","priority":"P0","deps":[],"method":"5W2H","question":"...","accept":"...","deliver":"T1-口径与范围.md"}],"pushback":["..."]}'
    ].filter(Boolean).join('\n');
  }

  function normalizePlan(obj, m) {
    const raw = Array.isArray(obj.nodes) ? obj.nodes
      : (Array.isArray(obj.dimensions) ? obj.dimensions : []); // 兼容老格式
    const names = m.participants.map(p => p.name);
    const ai = m.participants.filter(p => p.kind !== 'human');
    /* 指派兜底人：优先牵头人，别再把活甩给不在场的人 */
    const sec = chiefOf(m);

    const used = new Set();
    let nodes = raw.slice(0, 8).map((d, i) => {
      /* 负责人：先认名字，再按岗位关键词找，最后轮派；真人接的活回收给 AI */
      let lead = String(d.lead || '').trim();
      let p = m.participants.find(x => x.name === lead);
      if (!p && lead) p = m.participants.find(x => x.role.includes(lead) || lead.includes(x.role));
      if (p && p.kind === 'human') p = null;
      if (!p) p = ai[i % Math.max(ai.length, 1)] || sec;

      let id = String(d.id || 'T' + (i + 1)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || ('T' + (i + 1));
      if (used.has(id)) id = 'T' + (i + 1);
      used.add(id);

      const title = String(d.title || '要素').slice(0, 10);
      return {
        id,
        title,
        lead: p.name,
        role: p.role,
        priority: ['P0', 'P1', 'P2'].includes(String(d.priority || '').toUpperCase())
          ? String(d.priority).toUpperCase() : 'P1',
        deps: (Array.isArray(d.deps) ? d.deps : []).map(x => String(x).toUpperCase()).filter(Boolean),
        method: String(d.method || '').slice(0, 12),
        question: String(d.question || '').slice(0, 300),
        accept: String(d.accept || d.why || '').slice(0, 160),
        deliver: deliverName(d.deliver, id, title)
      };
    });

    /* 依赖清洗：不能指自己、不能指不存在的节点 */
    const ids = new Set(nodes.map(n => n.id));
    nodes.forEach(n => { n.deps = [...new Set(n.deps.filter(x => x !== n.id && ids.has(x)))]; });

    /* 破环：找不到「依赖都已就绪」的节点时，把剩下第一个的依赖砍掉，保证一定能跑完 */
    const ready = new Set();
    for (let guard = 0; guard <= nodes.length + 1 && ready.size < nodes.length; guard++) {
      const go = nodes.filter(n => !ready.has(n.id) && n.deps.every(x => ready.has(x)));
      if (!go.length) {
        const stuck = nodes.find(n => !ready.has(n.id));
        if (!stuck) break;
        stuck.deps = [];
        stuck.depNote = '原依赖成环，已解除';
        continue;
      }
      go.forEach(n => ready.add(n.id));
    }

    return {
      understanding: String(obj.understanding || '').slice(0, 300),
      changes: (Array.isArray(obj.changes) ? obj.changes : []).slice(0, 4).map(x => String(x).slice(0, 160)),
      nodes,
      pushback: (Array.isArray(obj.pushback) ? obj.pushback : []).slice(0, 3).map(x => String(x).slice(0, 200))
    };
  }

  /* 按依赖分层：第 1 层是没有前置的，第 2 层依赖第 1 层，以此类推 */
  function planWaves(nodes) {
    const left = nodes.slice();
    const done = new Set();
    const waves = [];
    for (let guard = 0; guard <= nodes.length + 1 && left.length; guard++) {
      const go = left.filter(n => (n.deps || []).every(d => done.has(d)));
      if (!go.length) { waves.push(left.splice(0)); break; } // 成环：剩下的单独一波，别卡死
      waves.push(go);
      go.forEach(n => {
        done.add(n.id);
        const k = left.indexOf(n);
        if (k >= 0) left.splice(k, 1);
      });
    }
    return waves;
  }

  /* ── 计划版本化（文档：重规划生成新版本，不覆盖历史）──────────────────
     以前 replan 直接 m.plan = 新计划，旧的那一版就没了：老板想回看「上一版
     排的是什么、为什么改」没有任何地方查。这里在覆盖前先归档一份。
     只留最近 12 版——够回溯，又不至于把一行 JSON 撑爆。 */
  function pushPlanVersion(m, plan, why) {
    if (!m || !plan) return;
    const list = Array.isArray(m.planVersions) ? m.planVersions : [];
    const sig = JSON.stringify({
      u: String(plan.understanding || '').slice(0, 120),
      n: (plan.nodes || []).map(x => x && x.id)
    });
    /* 同一份计划不重复归档：重规划失败又重试时会拿到一模一样的方案 */
    const last = list[list.length - 1];
    if (last && last.sig === sig) return;
    let snap;
    try { snap = JSON.parse(JSON.stringify(plan)); } catch (e) { snap = null; }
    if (!snap) return;
    list.push({
      v: list.length + 1, at: Date.now(), why: String(why || '').slice(0, 80),
      sig, nodes: (plan.nodes || []).length, plan: snap
    });
    m.planVersions = list.slice(-12);
    m.planVersion = m.planVersions.length;
  }
  /* 回看某一版：只读，不切回去（切回去会跟当前 outputs 对不上，容易出鬼） */
  function planVersionOf(m, v) {
    const list = Array.isArray(m.planVersions) ? m.planVersions : [];
    return list.find(x => Number(x.v) === Number(v)) || null;
  }

  function planNodes(m) {
    if (!m.plan) return [];
    if (Array.isArray(m.plan.nodes) && m.plan.nodes.length) return m.plan.nodes;
    return (m.plan.dimensions || []).map((d, i) => ({
      id: 'T' + (i + 1), title: d.title, lead: d.lead, role: d.role,
      priority: 'P1', deps: [], method: d.method, question: d.question, accept: d.why || ''
    }));
  }

  async function replan(m, text) {
    /* 老板看完拆解方案要改：把这句话当新一轮回答，重新拆一次 */
    if (m.busy) return;
    m.pending.note = ((m.pending.note || '') + (m.pending.note ? '\n' : '') + text).trim();
    m.answers = (m.answers || []).concat([{ q: '纠正拆解方案', answer: text }]);
    const sec = chiefOf(m);
    const model = modelOf(sec);
    m.busy = true; m.status = 'planning'; m.error = '';
    m.abort = new AbortController();
    m.phaseStart = Date.now();
    render(); save(m);
    try {
      const ansText = (m.answers || []).map(a => `${a.q}：${a.answer}`).join('\n');
      const obj = await callJSON({
        m, model,
        system: planSystem(sec, m) + '\n\n注意：老板对上一版拆解提出了修改意见，这次必须按他的意见调整，不要照旧。',
        user: [
          `项目主题：${m.topic}`,
          `到目前为止老板说过的：\n${ansText}`,
          `上一版路径：${m.plan ? planNodes(m).map(n => `${n.id} ${n.title}（${n.lead}${(n.deps || []).length ? '，前置 ' + n.deps.join('/') : ''}）`).join('、') : '无'}`,
          `参会同事：${m.participants.map(p => `${p.name}（${shortRole(p.role)}）`).join('、')}`
        ].join('\n\n'),
        signal: m.abort.signal,
        maxTokens: 4000
      });
      m.plan = normalizePlan(obj, m);
      m.plan.changes = ['按老板的修改意见重排：' + text.slice(0, 60)].concat(m.plan.changes || []).slice(0, 4);
      /* 新版归档：旧的那一版留着，老板要回看时查得到 */
      pushPlanVersion(m, m.plan, '按老板意见重排：' + text.slice(0, 40));
      m.status = 'confirm';
    } catch (e) {
      m.status = 'failed';
      m.error = e.name === 'AbortError' ? '你打断了这一轮' : ('重新拆解失败：' + niceErr(e));
    } finally {
      m.busy = false;
      m.abort = null;
      render(); save(m);
    }
    if (m.status === 'confirm') scheduleAutoRun(m);
  }

  /* 单发模型调用偶发抽风（限流/超时）：重试一次再报错，别让整场会停在一个 500 上 */
  /* ── 错误分类（文档 8.2 那张表）──────────────────────────────────────
     能不能重试不是一个「重试几次」的数字，而是先看这错误属于哪一类：
       瞬时（限流 / 超时 / 网络 / 5xx）→ 退避重试
       参数/格式错                    → 有限重试（模型多半能自己改对）
       权限拒绝                       → 不重试，重试还是拒，白烧一次调用
       输入缺失 / 需求矛盾             → 不重试，交给上层转 NEEDS_INPUT
       预算 / 积分耗尽                 → 不重试
     以前一律等 1500ms 重试一次，连权限拒绝也要多烧一遍。 */
  function errClass(e) {
    if (!e) return 'transient';
    if (e.name === 'BudgetHold' || e.name === 'NoCredit') return 'budget';
    const m = String(e.message || e.reason || e || '');
    const code = String(e.code || e.status || '');
    const both = m + ' ' + code;
    if (/权限|permission|not allowed|denied|unauthor|forbidden|\b401\b|\b403\b/i.test(both)) return 'permission';
    if (/(缺少|还没给|需要你|请先提供|needs?[_ ]input|missing[_ ](input|param))/i.test(both)) return 'input';
    if (/\b429\b|rate.?limit|限流|超时|timeout|ETIMEDOUT|network|fetch failed|\b50\d\b|ECONNRESET/i.test(both)) return 'transient';
    if (/(参数|格式|JSON|parse|schema|invalid)/i.test(both)) return 'param';
    return 'transient';
  }
  const RETRYABLE = { transient: true, param: true, permission: false, input: false, budget: false };

  async function withRetry(fn, n) {
    const max = n === undefined ? 1 : n;
    let last;
    for (let i = 0; i <= max; i++) {
      try { return await fn(i); } catch (e) {
        if (e.name === 'AbortError') throw e;
        last = e;
        const cls = errClass(e);
        e.errClass = cls;
        /* 不可重试的类：立刻抛出，让上层决定是转 NEEDS_INPUT 还是停 */
        if (!RETRYABLE[cls]) throw e;
        if (i < max) await new Promise(r => setTimeout(r, 1200 * (i + 1)));
      }
    }
    throw last;
  }

  /* 限并发的执行池：同时不超过 3 个人在说话，别把接口打爆 */
  async function pool(items, limit, fn) {
    const q = items.slice();
    const n = Math.min(limit, q.length) || 0;
    await Promise.all(Array.from({ length: n }, async () => {
      while (q.length) await fn(q.shift());
    }));
  }

  /* ── 阶段 3：同事逐个分析 ── */
  function kbLines(p, query) {
    if (!p || !p.id || !window.APP.kbSnippets) return '';
    const hits = window.APP.kbSnippets(p.id, query || '', 2);
    if (!hits.length) return '';
    return ['', '你有一份专属资料库，下面是检索到的相关段落（以它为准，不要凭印象改写）：',
      ...hits.map((k, i) => `【${i + 1}｜${k.title || '资料'}】${k.text}`)].join('\n');
  }

  /* 老板在「愿景和印象」页写的愿景：全体员工共用，没写就返回空串不占位 */
  function visLines() {
    try {
      const f = window.PROFILE && window.PROFILE.visionLines;
      return f ? String(f() || '') : '';
    } catch (e) { return ''; }
  }

  function nodeSystem(p, m, n, useTools, mem) {
    const hasUp = (n.deps || []).length > 0;
    const dir = dirOf(m);
    const file = `${dir}/${n.deliver || deliverName('', n.id, n.title)}`;
    return [
      `你是「${p.name}」，这家公司的「${rolePhrase(p.role)}」。${personaLine(p)}`,
      p.notes ? `老板期望你具备的能力：${p.notes}` : '',
      visLines(),
      kbLines(p, `${m.topic} ${n.title} ${n.question}`),
      mem || '',
      '',
      `这是内部项目「${m.topic}」的执行环节。你负责节点 ${n.id}「${n.title}」（优先级 ${n.priority}）。`,
      hasUp
        ? '这一节要接着前置节点的结论往下做，直接用他们钉好的口径和数字，不要重新论证一遍，也不要推翻已经定下的前提。'
        : '这是整条路径的起点。你的结论会被后面的节点直接拿去用，口径必须钉死，含糊的话后面全歪。',
      '',
      useTools
        ? [
          `你有工作目录，这个项目的文件夹是 ${dir}/。`,
          /* 成稿节点：后缀是老板定的格式，工具就必须跟着换。
             以前这里只有 .pptx 分支，剩下的一律 write_file 写 md——这就是项目里「产出物全变 md」的源头。 */
          /\.(pptx|docx|xlsx|png|jpe?g|webp)$/i.test(n.deliver || '')
            ? `这一节要交的是成品文件 ${file}：用对应工具做（见下），不要用 write_file 写一份 md 冒充。`
            : `这一节的完整产出用 write_file 写进 ${file}：表格、算式、清单、备选方案都写全，那是交付给下游节点和老板看的正本。`,
          /\.pptx$/i.test(n.deliver || '')
            ? [
              `这一节交的是成品 PPT：用 make_deck 写 ${file}。不要用 write_file 硬写 md 冒充 PPT。`,
              '配图顺序：① 老板上传过产品图就优先用 uploads/ 里的图；② 没有就 find_image 搜 2–3 张（查询写「主体 + 材质 + 白底/场景 + 摄影」，例如「白色陶瓷马克杯 白底 产品图」），把返回的 path 填进对应页的 image；③ 需要概念图/场景图/风格化插画时用 gen_image AI 生成（英文提示词效果好，写主体+风格+光线）；④ 一张都没有就全用无图版式（cards / kpi / chart / table / steps），不要硬凑。',
              '版式要换着用，一页一种：cover 封面 → section 章节 → split 图文分栏 / image 满版图 / cards 三卡 / kpi 大数字 / chart 条形图 / table 表格 / steps 流程 / bullets 要点 → end 结尾。封面配 image，成本用 kpi + chart，拆解用 table，节奏用 steps。不要连续三页都是 bullets —— 那正是「不像 PPT」的原因。',
              '配色看题材：消费品/家居用 theme=paper（暖米 + 陶土红），科技/金融用 ink，环保/健康用 forest，美妆用 plum，极简用 mono。',
              '每页只讲一个结论，标题就写这句结论；数字页一定要带口径（note）。'
            ].join('\n')
            : /\.docx$/i.test(n.deliver || '')
              ? `这一节交的是成品 Word：正文按 Markdown 写全（# 标题、## 小节、- 要点、| 表格），再调 make_doc 只给 path="${file}" 和 title，正文系统会取你刚写的那段。`
              : /\.xlsx$/i.test(n.deliver || '')
                ? `这一节交的是成品 Excel：调 make_sheet，把数据按 sheets / columns / rows 传进去，path="${file}"。`
                : /\.(png|jpe?g|webp)$/i.test(n.deliver || '')
                  ? `这一节交的是成品图片：调 gen_image 出图（英文 prompt，写清主体 + 风格 + 光线 + 构图），保存到 "${file}"。这个工具一定能出图，别因为「没有实拍通道」就跳过。`
                  : '',
          '写完之后，正文只回 180 字以内的结论摘要：第一句判断 + 关键依据（带数字和口径）+ 下游能直接接着做的那一步。正文不要复述文件里的全文。',
          `你能联网：web_search 查公开事实（政策与标准、市场行情、原料与代工报价、竞品、招聘薪酬），fetch_url 打开具体页面核实数字。凡是要「外面的事实」，先用它们查，不要凭印象写、也不要因为「手上没有资料」就跳过。`,
          `缺数据的处理顺序：先看 ${dir}/ 里前置节点写下的文件 → 再 web_search（换个说法再搜一次，两轮）→ 两轮还拿不到，就按你判断最合理的方式定一个假设往下算，写成「按 Y 假设推进（依据：…；影响：…）」。不要写「缺 X，待确认」把问题当成结论交回去。`,
          '节奏纪律：同一份文件最多读 2 次，web_search 总共不超过 3 次（这个工具的英文/中文索引差异大，搜两次没用的东西第三次也不会有）。搜不到不影响交付——先定假设把文件写完，比多搜三次更有用。',
          '写完再收工——只有正文、文件没写等于没做。'
        ].filter(Boolean).join('\n')
        : '',
      '',
      '规则：',
      `1. 用「${n.method || '5W2H'}」把这件事拆开：先给结构（分层/分点），再给判断。`,
      `2. 你这一节的验收标准：${n.accept || n.question}`,
      '3. 结论先行：第一句就是你的判断（能做 / 不能做 / 有条件能做），然后才是依据。',
      '4. 涉及数字必须给算式和口径。能查的先去查（web_search / fetch_url），查两轮还没有，就自己定一个站得住的估算，写清「按 Y 假设｜依据 …｜这个数往上浮动 X% 结论也成立」。不许编来源，但也不许把「缺数据」当成不推进的理由。',
      '5. 涉及钱、合同、对外承诺，只给方案和红线，不替老板拍板。',
      useTools ? '6. 正文 180 字以内，短句，不堆形容词，不复述项目背景。' : '6. 350 字以内，短句，不要堆形容词，不要复述项目背景。',
      useTools
        ? '7. 写完文件后，如果你在这一节里确认了以后还用得上的事实（真实报价、客户口径、政策口径、老板的偏好与禁区），在正文最末单起一行写 `【记忆】`，下面每条一行、以 `- ` 开头、最多 2 条、每条不超过 60 字；没有就留空。这一段不给人看，会存进你的记忆。'
        : ''
    ].filter(Boolean).join('\n');
  }

  /* ── 自动开跑：路径排好后倒数几秒自动开，老板有异议可以按住 ── */
  let autoT = null;
  function cancelAutoRun(m) {
    if (autoT) { clearInterval(autoT); autoT = null; }
    if (m) m.autoIn = 0;
  }
  function scheduleAutoRun(m) {
    cancelAutoRun(m);
    m.autoIn = 5;
    render();
    autoT = setInterval(() => {
      if (!m || m.busy || cur() !== m) { cancelAutoRun(m); if (m) { render(); save(m); } return; }
      m.autoIn -= 1;
      if (m.autoIn <= 0) {
        cancelAutoRun(m);
        startAnalysis(m);
        return;
      }
      render();
    }, 1000);
  }

  /* ── 节点核验：不采信「我做完了」，对照验收标准独立查一遍 ──
   * 判定规则不写在这里。项目线和任务线共用 public/judge.js 那一份，
   * 免得同一种毛病一边拦、一边不拦（以前就是这样：项目线拦「凭空数字」，任务线不拦）。 */
  function judgePickFor(workerModel) {
    const models = (S() && S().models) || [];
    if (!window.JUDGE) return { id: workerModel, name: workerModel, level: 'none', reason: '核验模块没加载' };
    return window.JUDGE.pick(models, workerModel);
  }

  /* 磁盘上真有什么：一次问完这一批节点的所有文件，别一个节点发一次请求
     since：这一批节点开跑的时间，用来把「更早留下的旧文件」标出来 */
  async function digestOf(scope, paths, since) {
    const list = [...new Set((paths || []).filter(Boolean))].slice(0, 8);
    if (!list.length) return [];
    try {
      const r = await fetch(window.withSC('/api/digest'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, paths: list, since: since || 0 })
      });
      const j = await r.json();
      if (j && j.ok && Array.isArray(j.items)) return j.items;
    } catch (e) { /* 拿不到就当没文件——这本身就是一条证据 */ }
    return [];
  }

  function nodeJudgeSystem(sec, m, pick, count) {
    const J = window.JUDGE;
    const base = J.systemPrompt({
      kind: 'node',
      workerName: sec.name,
      judgeModel: pick && pick.id
    });
    return [
      base,
      '',
      `【这次一次给你 ${count} 个节点】上面那个输出格式是单个节点的；一次多个时换成：`,
      '{"items":[{"id":"T1","dims":[{"k":"goal","s":4,"why":""},{"k":"deliver","s":4,"why":""},{"k":"fact","s":"pass","why":""},{"k":"consist","s":4,"why":""},{"k":"brevity","s":3,"why":""}],"gaps":[]}]}',
      'id 必须照抄我给的节点号；每个节点都要有一项，不许合并、不许漏。'
    ].join('\n');
  }

  function nodeJudgeUser(m, list, digestsFor, progFor) {
    const J = window.JUDGE;
    const head = `【老板的定调】${(m.plan && m.plan.understanding) || '（没写）'}`;
    const body = list.map(({ n, it }) => [
      `──────── 节点 ${n.id}｜${n.lead || ''}｜${n.title || ''} ────────`,
      J.userPrompt({
        kind: 'node',
        goal: `【${n.title || n.id}】要回答的：${n.question || n.title}`,
        accept: n.accept || '',
        text: it.content,
        digests: digestsFor(it),
        prog: progFor(n, it)
      })
    ].join('\n')).join('\n\n');
    return [head, body].join('\n\n');
  }

  async function verifyBatch(m, sec, batch) {
    const J = window.JUDGE;
    const items = batch
      .map(n => ({ n, it: m.outputs.find(o => o.id === n.id) }))
      .filter(x => x.it && x.it.content && (x.it.status === 'done' || x.it.status === 'weak'));
    if (!items.length) return;
    if (!J) {
      items.forEach(({ it }) => { it.verify = { pass: false, gaps: ['核验模块没加载，按未验证处理'] }; });
      render(); save(m);
      return;
    }

    const scope = S().scope;
    const pick = judgePickFor(modelOf(sec));
    /* 用这批节点里最早开跑的那个作为分界：早于它的文件是「之前就有的」，
       不是这一批写出来的。取最早的一个，宁可少标也别把刚写的文件冤成旧文件。 */
    const since = Math.min(...items.map(({ it }) => it.startedAt || Date.now()));
    const allDigests = await digestOf(scope, items.flatMap(({ it }) => it.files || []), since);
    const digestsFor = it => {
      const list = it.files || [];
      if (!list.length) return [];
      return allDigests.filter(d => list.includes(d.path));
    };
    /* 程序能判的先判死：声明要落盘却没文件、内容是空的、文件里几乎没字 */
    const progFor = (n, it) => J.gate({
      digests: digestsFor(it),
      text: it.content,
      expectFiles: !!it.file
    });

    const needModel = items.filter(({ n, it }) => progFor(n, it).hard.length === 0);
    let arr = [];
    let callErr = '';
    if (needModel.length) {
      try {
        const obj = await callJSON({
          m, model: pick.id || modelOf(sec),
          system: nodeJudgeSystem(sec, m, pick, needModel.length),
          user: nodeJudgeUser(m, needModel, digestsFor, progFor),
          signal: m.abort.signal,
          maxTokens: 400 + needModel.length * 260
        });
        arr = Array.isArray(obj.items) ? obj.items
          : (Array.isArray(obj.checks) ? obj.checks : []);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        callErr = niceErr(e);
      }
    }

    items.forEach(({ n, it }) => {
      const prog = progFor(n, it);
      const raw = arr.find(x => x && String(x.id || '').trim() === n.id);
      const parsed = raw ? J.parse(JSON.stringify(raw)) : null;
      const v = J.decide({ prog, model: parsed, judge: pick, workerModel: modelOf(sec), kind: 'node' });
      if (callErr) v.note = '核验没跑成：' + callErr;
      it.verify = v;
      it.status = J.statusOf(v);
    });
    render(); save(m);
  }

  /* ── 跑一个节点：失败重试一次，重做时把上一版被指出的问题带上 ── */
  /* 把工具调用翻成人话：进度里要看到「正在查纸板价格」，不是「web_search」 */
  function actOf(s) {
    const a = (s && s.args) || {};
    const cut = (x, n = 20) => String(x || '').split('/').pop().slice(0, n);
    switch (s && s.name) {
      case 'web_search': return `在查「${cut(a.query, 18)}」`;
      case 'fetch_url': return `在打开 ${String(a.url || '').replace(/^https?:\/\//, '').slice(0, 26)}`;
      case 'read_file': return `在读 ${cut(a.path)}`;
      case 'read_doc': return `在解析 ${cut(a.path)}`;
      case 'write_file': return `在写 ${cut(a.path)}`;
      case 'make_deck': return `在排 PPT（${(a.slides || []).length || 0} 页）`;
      case 'find_image': return `在找配图「${cut(a.query, 16)}」`;
      case 'gen_image': return `在画图「${cut(a.prompt, 16)}」`;
      case 'web_search': return `在搜「${cut(a.query, 14)}」`;
      case 'fetch_url': return '在打开一个网页核实';
      case 'list_dir': return '在看目录';
      case 'search_text': return `在找「${cut(a.query, 14)}」`;
      case 'run_shell': return '在跑命令';
      default: return `在调 ${s ? s.name : '工具'}`;
    }
  }

  /* 只改那一行文案，不整页重绘——重绘会把老板正在读的内容打断 */
  function showNow(id, text) {
    const n = el('meetBody').querySelector(`.pr-r[data-id="${id}"] .pr-s`);
    if (n) n.textContent = text;
  }

  /* 把某一节的正文写进界面。写之前先看这一场是不是正开着——
     所有「后台跑着的时候往 DOM 里塞内容」的路径都必须走这两个口子，
     否则 A 项目的流式正文会落到 B 项目的行上（节点 id 都叫 T1，撞得死死的）。 */
  function writeLive(m, idx, content) {
    if (!onScreen(m)) return false;
    const box = el('meetBody').querySelector(`[data-live="${idx}"]`);
    if (!box) return false;
    box.innerHTML = md(content);
    return true;
  }

  /* @ 派活那条回复的正文（项目消息流里的第 idx 轮第 ri 位） */
  function writeFollow(m, idx, ri, content) {
    if (!onScreen(m)) return false;
    const box = el('meetBody').querySelector(`[data-fr="${idx}-${ri}"]`);
    if (!box) return false;
    box.innerHTML = md(content);
    return true;
  }

  /* 这一节到底写出了什么文件。
   * 计划里的文件名只是「应该叫什么」，不能当证据；
   * 但也不能因此把盘上上一轮的旧文件认成本轮产出——
   * 顺序是：本轮真写过的路径 → 计划路径（且是这一轮写的）→ 同目录按节点号找（且是这一轮写的）。 */
  async function resolveDelivered(scope, plan, wrote, nid, since) {
    const detailOk = g => (g.detail || []).filter(d => d.ok && (d.size || 0) > 0 && !d.stale).map(d => d.path);

    /* 1. 本轮 write_file 真写过的，可信度最高 */
    const w = [...new Set((wrote || []).filter(Boolean))];
    if (w.length) {
      try {
        const g = await window.BOSS.verifyPaths(scope, w, 0);
        const ok = detailOk(g);
        if (ok.length) return ok;
      } catch { /* 继续往下找 */ }
    }

    /* 2. 计划路径本身，但必须是这一轮写的（旧文件不算） */
    try {
      const g = await window.BOSS.verifyPaths(scope, [plan], since || 0);
      const stale = new Set(g.stale || []);
      const ok = (g.detail || [])
        .filter(d => d.ok && (d.size || 0) > 0 && !stale.has(d.path))
        .map(d => d.path);
      if (ok.length) return ok;
    } catch { /* 继续往下找 */ }

    /* 3. 模型把名字写歪了：同目录按节点号找，且只认这一轮改动过的 */
    try {
      const dir = plan.includes('/') ? plan.slice(0, plan.lastIndexOf('/')) : '.';
      const r = await fetch(window.withSC(
        `/api/files?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(dir)}`));
      const j = await r.json();
      if (j.ok) {
        const key = String(nid || '').replace(/[^\w]/g, '');
        const floor = Number(since) ? Number(since) - 2000 : 0;
        if (key) {
          const re = new RegExp('^' + key + '(?![0-9])', 'i');
          const hit = (j.items || [])
            .filter(it => !it.dir && /\.(md|txt|csv|json|pptx)$/i.test(it.name) && re.test(it.name))
            .filter(it => !floor || (Number(it.mtime) || 0) >= floor)
            .map(it => it.path);
          if (hit.length) return hit;
        }
      }
    } catch { /* ignore */ }
    return [];
  }

  async function runNode(m, n, it, extra) {
    const p = m.participants.find(x => x.name === n.lead) || chiefOf(m);
    const idx = m.outputs.indexOf(it);
    const useTools = canUseTools(modelOf(p));
    const file = `${dirOf(m)}/${n.deliver || deliverName('', n.id, n.title)}`;
    it.status = 'run';
    /* 只有能调工具、能写文件的时候才要求落盘；
       只说话的模型（不支持工具调用）不该被「产出没落盘」判死 */
    it.file = useTools ? file : '';
    it.startedAt = Date.now();
    it.now = it.redo && it.gap ? `按意见重做：${String(it.gap).slice(0, 24)}` : '读题中…';
    delete it.verify;
    renderIfOpen(m);

    const t1 = Date.now();
    const ups = (n.deps || []).map(id => m.outputs.find(o => o.id === id))
      .filter(o => o && o.content && (o.status === 'done' || o.status === 'weak'));
    const upText = ups.length
      ? `前置节点已经出的结论（直接用，不要重新论证）：\n${ups.map(o => `【${o.id} ${o.title} · ${o.lead}】\n${String(o.content).slice(0, 700)}${(o.files || []).length ? `\n（完整产出在 ${o.files.join('、')}，需要细节就 read_file）` : ''}`).join('\n\n')}`
      : '';
    const ansText = (m.answers || []).map(a => `${a.q} → ${a.answer}`).join('\n');
    /* 这位员工记得的事：公司档案 + 他自己的往次结论 + 这个项目的共享结论。
       按本节的问题做相关性召回 */
    const mem = await window.BOSS.briefOf(
      S().scope, p, `${m.topic} ${n.title} ${n.question || ''}`.slice(0, 200),
      { id: m.id, title: m.topic }
    );
    /* 训练记忆要先就位，下面拼 system 时是同步读缓存 */
    await primeStdMem([p]);
    const user = [
      `项目主题：${m.topic}`,
      /* 前情简报是全员共用的那一份：直接用这里的结论，谁都不用回头翻原任务 */
      (() => { const o = originOf(m); return o && o.brief
        ? `项目前情（原任务《前情简报》，全员共用，其中的口径与结论直接采用，不要重新查证）：\n${String(o.brief).slice(0, 1200)}${(o.decisions || []).length ? '\n已定口径：\n' + o.decisions.map(d => '· ' + d).join('\n') : ''}`
        : ''; })(),
      `老板已确认的定调：${(m.plan && m.plan.understanding) || ''}`,
      ansText ? `老板的原话（口径以这个为准）：\n${ansText}` : '',
      attachText(m, 3500),
      upText,
      `你要做的这一节：${n.id}「${n.title}」（${n.priority}）\n${n.question}`,
      extra || ''
    ].filter(Boolean).join('\n\n');

    let last = 0;
    let acc = '';
    const paint = text => {
      /* 流式过程中就把【记忆】块藏掉，别让老板看着看着又消失 */
      it.content = window.BOSS.splitMemo(text).body;
      const now = Date.now();
      if (now - last < 140) return;
      last = now;
      writeLive(m, idx, it.content);
    };

    try {
      if (useTools) {
        /* 走完整执行回路：会真写文件，写完才算完 */
        const r = await window.BOSS.toolLoop({
          model: modelOf(p),
          system: nodeSystem(p, m, n, true, mem),
          user,
          scope: S().scope,
          perms: (S().settings && S().settings.permissions) || {},
          /* 成稿 PPT 节点要多给几步：读几份 md + find_image 搜图 + make_deck 修一轮，
             光 6 步必然卡死在中途（图还没配就收工）。步数底数在设置里改。 */
          maxSteps: nodeSteps(n.deliver),
          /* 把这一节的产出文件名和问题一起给下去：工具按目标挑，
             交付 .docx 的节点必须拿到 make_doc，交付 .xlsx 的必须拿到 make_sheet。 */
          goal: `${n.title || ''} ${n.question || ''} ${n.deliver || ''}`.trim(),
          budget: nodeBudget(),
          signal: m.abort.signal,
          onText: d => { acc += d; paint(acc); },
          onStep: s => {
            /* 分析过程逐条记账：展示层要的是「每一步做了什么」，不许覆盖 */
            const a = actOf(s);
            if (a) {
              if (!Array.isArray(it.says)) it.says = [];
              if (it.says[it.says.length - 1] !== a) it.says.push(a);
              if (it.says.length > 24) it.says.shift();
            }
            it.now = a || (s && s.name) || '在跑…';
            if (onScreen(m)) showNow(n.id, it.now);
          },
          onCompact: s => { it.now = `在整理前情（${s.before} → ${s.after} tok）`; if (onScreen(m)) showNow(n.id, it.now); },
          /* 执行中要老板拍板：节点挂起等答案，答案作为工具回包让它继续 */
          onAsk: async ({ intro, questions }) => {
            const askId = 'a' + Math.random().toString(36).slice(2, 8);
            const entry = {
              askId, nodeId: n.id, nodeTitle: n.title, lead: p.name, leadRole: p.role,
              priority: n.priority || 'P1', intro: String(intro || '').slice(0, 200),
              questions, at: Date.now()
            };
            if (!Array.isArray(m.nodeAsks)) m.nodeAsks = [];
            m.nodeAsks.push(entry);
            it.status = 'ask';
            it.now = '等你拍板（等待期不消耗 token）';
            renderIfOpen(m); renderList(); save(m);
            try {
              return await new Promise((resolve, reject) => {
                entry.resolve = resolve;
                entry.reject = reject;
                if (m.abort) m.abort.signal.addEventListener('abort', () =>
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
              });
            } finally {
              const ix = m.nodeAsks.indexOf(entry);
              if (ix >= 0) m.nodeAsks.splice(ix, 1);
              if (it.status === 'ask') it.status = 'run';
              it.now = '接着干…';
              renderIfOpen(m);
            }
          },
          gatePaths: [file]
        });
        addTokens(m, r.usage);
        it.toolN = (r.steps || []).length;
        /* 保留工具步骤明细，供「分析过程」折叠条展开（对齐任务线的 N 步执行） */
        if (r.steps && r.steps.length) it.steps = r.steps.map(s => ({
          name: s.name, ok: s.ok, args: s.args || {}, output: s.output || '', ms: s.ms || 0
        })).slice(0, 24);
        if (r.gates && r.gates.length) it.gateN = r.gates.length;
        it.budgetHit = r.status === 'budget_exceeded';
        /* 只有真落盘的文件才配进「产出」。计划名不写死，按盘上实际情况认。 */
        const real = await resolveDelivered(S().scope, file, r.wrote, n.id, t1);
        const failed = !real.length;
        if (failed) {
          const why = r.delivered === false
            ? `产出没落盘：${file}`
            : (r.status === 'budget_exceeded'
                ? `这一节花到 ${Math.round(nodeBudget() / 10000)} 万 token 还没写出文件，已停手`
                : (r.status === 'step_limit'
                    ? '步数用尽，模型还在读材料，没写到文件'
                    : `没有写出文件（${r.status || '未知'}）`));
          it.content = `${r.text || '（这一节没写出正文）'}\n\n> ${why}。下游只有这段摘要可用。`;
          it.status = 'weak';
          it.verify = { pass: false, gaps: [why] };
          it.files = [];
        } else {
          it.content = r.text || '（这一节没写出正文）';
          it.status = 'done';
          it.files = real.slice(0, 4);
          /* 名字跟计划不一致时留个口子，免得以后有人以为文件丢了 */
          if (real[0] !== file) it.fileAlias = file;
        }
        /* 只有这一节真交出来了才写记忆；存疑的那半成品不记 */
        if (it.status === 'done' && r.memo && r.memo.length) {
          window.BOSS.saveMemo(S().scope, p, r.memo, '项目：' + String(m.topic || '').slice(0, 20));
        }
        /* 项目级结论：写进项目共享记忆，项目里其他同事下一节就能拿到 */
        if (it.status === 'done' && r.projectMemo && r.projectMemo.length) {
          window.BOSS.saveProjectMemo(S().scope, m.id, m.topic, r.projectMemo,
            '项目：' + String(m.topic || '').slice(0, 20), m.id);
        }
      } else {
        const r = await stream({
          model: modelOf(p),
          system: nodeSystem(p, m, n, false, mem),
          user,
          signal: m.abort.signal,
          maxTokens: 900,
          onDelta: text => paint(text)
        });
        it.content = r.text || '（这一节没写出正文）';
        addTokens(m, r.usage);
        it.status = 'done';
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      it.content = `这一节没跑成：${niceErr(e)}`;
      it.status = 'fail';
    }
    it.ms = Date.now() - t1;
    it.startedAt = 0;
    it.now = '';
    it.redo = false;
    it.gap = '';
    writeLive(m, idx, it.content);
    renderIfOpen(m); save(m);
  }

  /* 补跑：只重做没写成的那几节，以及依赖它们的下游。
   * 已经写好的别的节不动，省时间也省 token。 */
  async function rerunWeak(m) {
    if (m.busy) return window.APP.toast('这一场还在跑');
    const bad = new Set((m.outputs || [])
      .filter(o => o.status === 'weak' || o.status === 'fail' || (o.lostFiles || []).length)
      .map(o => o.id));
    if (!bad.size) return window.APP.toast('没有要补跑的节点');
    /* 依赖链上的下游也得跟着重算，否则它还在引用上一版的错结论 */
    let grew = true;
    while (grew) {
      grew = false;
      for (const o of m.outputs) {
        if (bad.has(o.id)) continue;
        if ((o.deps || []).some(d => bad.has(d))) { bad.add(o.id); grew = true; }
      }
    }
    for (const o of m.outputs) {
      if (!bad.has(o.id)) continue;
      o.status = 'wait'; o.content = ''; o.files = []; o.verify = null;
      o.ms = 0; o.gateN = 0; o.toolN = 0; o.file = ''; o.fileAlias = ''; o.lostFiles = [];
      o.steps = []; o._stepsOpen = false;
    }
    m.minutes = null;
    window.APP.toast(`重跑 ${bad.size} 节（含下游）`);
    renderIfOpen(m); save(m);
    await startAnalysis(m);
  }

  async function startAnalysis(m) {
    if (m.busy) return;
    cancelAutoRun(m);
    const nodes = planNodes(m);
    if (!nodes.length) return window.APP.toast('还没有拆解方案');
    /* 积分见底：项目当场终止，不进 analyzing。
       项目一层会同时开三个节点，欠账跑一轮就是三份 token——这钱收不回来。 */
    if (creditOut()) {
      const leftN = (m.outputs || []).filter(o => o.status === 'wait' || o.status === 'run' || o.status === 'fail').length;
      m.status = 'halted';
      m.creditHold = { left: leftN };
      m.error = '积分用完了，项目停在这里';
      renderIfOpen(m); renderList(); save(m);
      window.APP.toast('积分用完了，项目已终止；充值后点「继续跑」接着走');
      return;
    }
    /* 没见底但快见底：开跑前先提醒一句，别跑到一半断在那儿 */
    if (window.APP && window.APP.creditWarn) window.APP.creditWarn('这个项目');
    /* 核验署名与收口都归牵头人：判定本身用另一个模型的 JUDGE（public/judge.js） */
    const sec = chiefOf(m);
    m.busy = true; m.status = 'analyzing'; m.error = '';
    m.abort = new AbortController();
    m.phaseStart = Date.now();

    /* 按依赖分层：同一层互不依赖，可以并排跑；下一层必须等上一层出结果 */
    const waves = planWaves(nodes);
    const flat = waves.flat();

    /* 断点续跑：已经跑过（含存疑）的节点不重跑 */
    const prev = new Map((m.outputs || []).map(o => [o.id, o]));
    const doneIds = new Set();
    m.outputs = flat.map(n => {
      const old = prev.get(n.id);
      if (old && old.content && (old.status === 'done' || old.status === 'weak')) {
        doneIds.add(n.id);
        return Object.assign(old, { deps: n.deps || [], title: n.title, lead: n.lead, role: n.role });
      }
      return {
        id: n.id, lead: n.lead, role: n.role, title: n.title, method: n.method,
        priority: n.priority, deps: n.deps || [], accept: n.accept || '',
        status: 'wait', content: '', ms: 0
      };
    });
    renderIfOpen(m); renderList(); save(m);

    const itemOf = id => m.outputs.find(o => o.id === id);

    try {
      for (let wi = 0; wi < waves.length; wi++) {
        if (m.abort.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        /* 到预算就停在原地，不自作主张往下跑，也不偷偷砍内容 */
        guardRun(m);

        /* 前置没成的，这一节不跑，也不假装跑过 */
        const runnable = [];
        for (const n of waves[wi]) {
          const it = itemOf(n.id);
          if (it && doneIds.has(n.id)) continue;
          const missing = (n.deps || []).filter(d => !doneIds.has(d));
          if (missing.length) {
            if (it) {
              it.status = 'skip';
              it.content = `前置 ${missing.join('、')} 没有完成，这一节没执行。要补，就在下面说一句。`;
            }
            continue;
          }
          runnable.push(n);
        }
        if (!runnable.length) continue;

        m.busyText = waves.length > 1
          ? `第 ${wi + 1}/${waves.length} 层：${runnable.map(n => n.title).join('、')}`
          : `${runnable.length} 个节点一起跑：${runnable.map(n => n.title).join('、')}`;
        renderIfOpen(m);

        await pool(runnable, 3, async n => {
          if (m.abort.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          guardRun(m);
          await runNode(m, n, itemOf(n.id));
        });

        /* 失败的自动补一次：把出错原因写给它，让它换个做法 */
        for (const n of runnable) {
          if (m.abort.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          guardRun(m);
          const it = itemOf(n.id);
          if (!it || it.status !== 'fail') continue;
          m.busyText = `${n.title} 没跑成，重新试一次…`;
          renderIfOpen(m);
          await runNode(m, n, it, `上一次这一节失败了（${String(it.content || '').slice(0, 120)}）。换一个更直接的写法重做：先把判断写在第一句，再补依据。`);
        }

        /* 核验：对照验收标准过一遍，不过的打回重做一次 */
        m.busyText = `正在核验这一层（${runnable.length} 节，对照验收标准逐条查）`;
        renderIfOpen(m);
        await verifyBatch(m, sec, runnable);

        const weakN = runnable.filter(n => {
          const it = itemOf(n.id);
          return it && it.verify && !it.verify.pass && it.status === 'weak';
        });
        if (weakN.length) {
          m.busyText = `${weakN.length} 节没过核验，正在并排重做`;
          /* 并排重做（最多 2 个）：串行重做是整场会最慢的一段，3 节排下来要两分钟 */
          await pool(weakN, 2, async n => {
            if (m.abort.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            guardRun(m);
            const it = itemOf(n.id);
            const gaps = (it.verify && it.verify.gaps) || [];
            it.redo = true;
            it.gap = gaps[0] || '';
            renderIfOpen(m);
            await runNode(m, n, it, [
              '上一版被验收人指出这些问题，这一版必须逐条补上：',
              ...gaps.map((g, i) => `${i + 1}. ${g}`),
              '补的时候不要整篇重写，只补缺口，保留已经对的部分。'
            ].join('\n'));
          });
          renderIfOpen(m);
          await verifyBatch(m, sec, weakN);
        }

        runnable.forEach(n => {
          const it = itemOf(n.id);
          if (it && (it.status === 'done' || it.status === 'weak')) doneIds.add(n.id);
        });
        renderIfOpen(m); save(m);
        /* 这一层的文件已经生成了：顺手镜像到云端，别等整场跑完 */
        syncProjectFiles(m);
      }

      /* 纪要 */
      await writeMinutes(m, sec);
      syncProjectFiles(m);
    } catch (e) {
      const leftN = (m.outputs || []).filter(o => o.status === 'wait' || o.status === 'run' || o.status === 'fail' || o.status === 'ask').length;
      (m.outputs || []).forEach(o => { if (o.status === 'run' || o.status === 'ask') o.status = 'wait'; });
      m.nodeAsks = [];
      if (e.name === 'NoCredit') {
        /* 钱烧完了：项目终止（不是失败）。已跑完的节点都在，充值后从断点接 */
        m.status = 'halted';
        m.creditHold = { left: leftN };
        m.error = leftN
          ? `积分用完了：还剩 ${leftN} 节没跑。充值后点「继续跑」接着走，已完成的不会重跑。`
          : '积分用完了：节点都跑完了，只差纪要。充完值点「继续跑」把它收口。';
      } else if (e.name === 'BudgetHold') {
        /* token 花到上限：停在原地等老板拍板，不算失败，也不自己往下走 */
        m.status = leftN ? 'analyzing' : m.status;
        m.budgetHold = { spent: budSpent(m), cap: budCap(m), left: leftN };
        m.error = '';
      } else if (e.name === 'AbortError' && leftN) {
        /* 停下来但没跑完：留成暂停态，点「继续跑」从断点接着走 */
        m.status = 'analyzing';
        m.error = '你打断了这一轮（已完成的部分保留，点「继续跑」接着走）';
      } else {
        m.status = m.outputs.length ? 'done' : 'failed';
        m.error = e.name === 'AbortError' ? '你打断了这一轮（已完成的部分保留）' : ('分析中断：' + niceErr(e));
      }
    } finally {
      m.busy = false;
      m.ms = Date.now() - m.t0;
      m.abort = null;
      renderIfOpen(m); renderList(); save(m);
      /* 跑完这一整轮（或停下），把老板中途插的话补发出去 */
      await flushPendingFollow(m);
    }
  }

  /* 纪要：正常收尾和「停在这里出纪要」都走这一条，不许两套口径 */
  async function writeMinutes(m, sec) {
    const who = sec || secretaryOf(m);
    m.status = 'planning';
    m.budgetHold = null;
    renderIfOpen(m);
    const badN = (m.outputs || []).filter(o => o.status && o.status !== 'done' && o.status !== 'weak');
    const weakAll = (m.outputs || []).filter(o => o.status === 'weak');
    const obj = await withRetry(() => callJSON({
      m, model: modelOf(who),
      system: minutesSystem(who),
      user: [
        `项目主题：${m.topic}`,
        `老板已确认的定调：${(m.plan && m.plan.understanding) || ''}`,
        `老板的原话：\n${m.answers ? m.answers.map(a => `${a.q} → ${a.answer}`).join('\n') : '（无）'}`,
        `按路径执行的结果：\n${m.outputs.map(o => `【${o.id || ''} ${o.title} · ${o.lead}｜${o.priority || ''}｜${o.status === 'done' ? '已完成并核验' : o.status === 'weak' ? '做完但核验存疑' : o.status === 'skip' ? '按老板意思停下没跑' : '未完成'}】\n${o.content}${(o.files || []).length ? `\n（正本文件：${o.files.join('、')}）` : ''}${o.verify && !o.verify.pass && (o.verify.gaps || []).length ? `\n（核验指出：${o.verify.gaps.join('；')}）` : ''}`).join('\n\n')}`,
        badN.length ? `注意：有 ${badN.length} 个节点没执行完（${badN.map(o => o.id).join('、')}）。纪要里必须把没完成的部分写进 risks 或 needsBoss，不许当成已经做完，也不许替它编一个结论。` : '',
        weakAll.length ? `注意：有 ${weakAll.length} 个节点核验没过（${weakAll.map(o => o.id).join('、')}）。相关结论只能写成「待确认」，不能当定论。` : ''
      ].filter(Boolean).join('\n\n'),
      signal: (m.abort && m.abort.signal) || null
    }));
    m.minutes = normalizeMinutes(obj);
    m.status = 'done';
    pushTodos(m, m.minutes.todos);
  }

  /* ── 预算到线后的两条路 ── */
  function raiseBud(m) {
    if (m.busy) return window.APP.toast('这一节还在跑，等它停手');
    budSet(m, budCap(m) + BUD.raise);
    m.budgetHold = null;
    window.APP.toast(`上限调到 ${Math.round(budCap(m) / 10000)} 万 token，从断点接着跑`);
    startAnalysis(m);
  }

  async function finishNow(m) {
    if (m.busy) return window.APP.toast('这一节还在跑，等它停手');
    m.budgetHold = null;
    (m.outputs || []).forEach(o => {
      if (o.status === 'wait' || o.status === 'run') {
        o.status = 'skip';
        o.content = '按你的意思停在这里，这一节没跑。';
      }
    });
    m.busy = true;
    m.abort = new AbortController();
    renderIfOpen(m); save(m);
    try {
      await writeMinutes(m, chiefOf(m));
    } catch (e) {
      m.status = (m.outputs || []).length ? 'done' : 'failed';
      m.error = '出纪要时出错：' + niceErr(e);
    } finally {
      m.busy = false;
      m.abort = null;
      renderIfOpen(m); renderList(); save(m);
    }
  }

  function minutesSystem(sec) {
    return [
      `你是「${sec.name}」，老板的${rolePhrase(sec.role)}。项目讨论完了，你出一份项目纪要。`,
      '要求：decisions 只写真的定下来的；todos 每条都要能直接派给一个人（做什么 + 谁 + 什么时候/触发条件），不要写「进一步研究」这种空话；risks 写清触发条件和后果；needsBoss 只写只有老板能拍的。',
      '只输出 JSON：',
      '{"summary":"三句话以内说清结论","decisions":["..."],"todos":[{"what":"...","who":"...","when":"..."}],"risks":["..."],"needsBoss":["..."]}'
    ].join('\n');
  }

  function normalizeTodos(v) {
    return (Array.isArray(v) ? v : []).slice(0, 10).map(t => ({
      what: String(t.what || '').slice(0, 160),
      who: String(t.who || '').slice(0, 20),
      when: String(t.when || '').slice(0, 40)
    })).filter(t => t.what);
  }

  function normalizeMinutes(obj) {
    const arr = v => (Array.isArray(v) ? v : []).map(x => String(x).slice(0, 200));
    return {
      summary: String(obj.summary || '').slice(0, 800),
      decisions: arr(obj.decisions).slice(0, 8),
      todos: normalizeTodos(obj.todos),
      risks: arr(obj.risks).slice(0, 8),
      needsBoss: arr(obj.needsBoss).slice(0, 6)
    };
  }

  /* ── 阶段 4：老板说一句，在场成员一起回应，牵头人收口 ── */
  function speakSystem(p, m, said, directed) {
    return [
      `你是「${p.name}」，这家公司的「${rolePhrase(p.role)}」。${personaLine(p)}`,
      p.notes ? `老板期望你具备的能力：${p.notes}` : '',
      visLines(),
      kbLines(p, `${m.topic} ${said || ''}`),
      '',
      directed
        ? `这是内部项目「${m.topic}」。老板这句只点了你的名，其他同事不会接话，你直接对着老板说，不要替别人表态，也不要说「我同意某某」。`
        : `这是内部项目「${m.topic}」。老板刚说了一句，在座的人都要表态，不是让你复述项目背景。`,
      '规则：',
      '1. 第一句就是你的判断（认 / 不认 / 有条件认），后面才是依据。',
      '2. 只从你的专业看，不要越界替别的部门拍板。',
      '3. 涉及数字给算式和口径；拿不到数据就说缺什么，不要编。',
      directed
        ? '4. 300 字以内，短句。老板是在跟你对话：可以反问、可以要资料，把话说透，别写客套话。'
        : '4. 200 字以内，短句，不写客套话，不重复别人已经说过的。',
      '5. 这句话确实跟你的专业无关，就一句话带过「这块我不表态，交给 X」，不要硬凑。'
    ].filter(Boolean).join('\n');
  }

  /* @点名 = 干活，不是表态：对齐任务线的体验——直接动手、产出落地，别绕「认/不认」 */
  function workSystem(p, m, said, dir, mem, useTools) {
    return [
      `你是「${p.name}」，这家公司的「${rolePhrase(p.role)}」。${personaLine(p)}`,
      p.notes ? `老板期望你具备的能力：${p.notes}` : '',
      visLines(),
      kbLines(p, `${m.topic} ${said || ''}`),
      mem || '',
      '',
      `这是内部项目「${m.topic}」。老板在项目里点名找你做事，像任务线一样：直接把活干了。`,
      useTools
        ? [
          `你有工作目录，这个项目的文件夹是 ${dir}/。`,
          '要做产出就直接做成文件落盘：Word 用 make_doc、PPT 用 make_deck、Excel 用 make_sheet、图片用 gen_image；只有纯文本/代码/清单这类才用 write_file。',
          '老板点了格式就照他点的来，不许换一种；没点就按他的动词判断：画/出图 → 图片，写/整理成文 → Word，做演示/汇报 → PPT，统计/列表 → Excel。',
          '两样都判断不了，就用 ask_boss 问一句「这份东西要做成哪种」（Word / PPT / Excel / 图片），不要拿一份 md 顶上去。',
          '要查公开事实就 web_search / fetch_url，查完直接引用，不要凭印象编数字。',
          '正文只回 180 字以内的交付摘要：做了什么、产出文件在哪、下一步是什么。正文不要复述文件全文。',
          '缺关键决策（技术选型、品牌名/主色、页面范围这类定错要返工的）不要瞎猜：用 ask_boss 工具问老板，每题给 2–4 个候选选项，其余部分照常交付，不要停下来。'
        ].join('\n')
        : [
          '这个模型用不了工具：把要交付的内容直接写在回复正文里（Markdown），写全，不要只给提纲。',
          '不要说「认 / 不认 / 有条件认」之类的表态套话，直接给结果。'
        ].join('\n'),
      '',
      '规则：',
      '1. 第一句就是结论或交付说明。不要复述问题，不要客套，不要先表态再干活。',
      '2. 只从你的专业范围动手；别的部门的事只给建议，不替别人拍板。',
      '3. 涉及数字给算式和口径；拿不到数据就说缺什么，不要编。',
      '4. 涉及钱、合同、对外承诺，只给方案和红线，不替老板拍板。',
      useTools ? '5. 短句，正文 180 字以内。' : '5. 短句，600 字以内，把交付内容写完整。'
    ].filter(Boolean).join('\n');
  }

  function recapSystem(sec, m, directed) {
    return [
      `你是「${sec.name}」，老板的${rolePhrase(sec.role)}，这个项目（${m.topic}）的主持人。`,
      directed
        ? '老板这句是单独问你的，同事没有发言。你自己答，不要假装别人说了话。'
        : '老板刚说了一句，在座同事各说了一遍。现在你收口，不要重复他们的话。',
      '1. summary：①这件事现在怎么定（结论先行）②谁和谁不一致、分歧点在哪③下一步做什么。200 字以内。',
      directed
        ? '2. todos：只有老板明确要你去派活时才给，0–2 条；纯问答就空数组。'
        : '2. todos：这一轮真正能落地的待办，0–5 条。每条 what（动词开头、可验收）/ who（必须是参会名单里的名字）/ when（时间或触发条件）。没有就空数组，不要凑。',
      '3. needsBoss：只有老板能拍的点，0–3 条。',
      '只输出 JSON，不要解释：',
      '{"summary":"...","todos":[{"what":"...","who":"...","when":"..."}],"needsBoss":["..."]}'
    ].join('\n');
  }

  async function followUp(m, text, targets, atts) {
    if (m.busy) return;
    const sec = secOf(m);
    const to = (targets || []).filter(Boolean);
    const toSec = to.some(p => p.name === sec.name);
    const directed = to.length > 0;
    // 定向：只有被 @ 到的人接这一句；秘书只在被点名、或全员场里负责收口
    const speakers = directed
      ? to.filter(p => p.name !== sec.name).slice(0, 5)
      : m.participants.filter(p => p.kind !== 'human' && p.name !== sec.name).slice(0, 5);
    const doRecap = !directed || toSec || speakers.length === 0;
    const said = stripMentions(m, text) || text || '（看刚发的附件）';
    /* 这一条随发的附件：截图走视觉通道让成员直接看到，文档给路径让它 read_file */
    const newImgs = (atts || []).filter(x => x && x.dataUrl).slice(0, 6);
    const newDocs = (atts || []).filter(x => x && !x.dataUrl && x.path);
    const docHint = newDocs.length
      ? `\n\n老板刚发来文件：${newDocs.map(d => '`' + d.path + '`').join('、')}（需要内容就 read_file 读）`
      : '';

    m.busy = true; m.error = '';
    m.abort = new AbortController();
    m.phaseStart = Date.now();
    m.busyText = speakers.length
      ? (directed
        ? `${speakers.map(p => p.name).join('、')} 在干活…`
        : `${speakers.length} 位同事在各自的角度回应…`)
      : `${sec.name} 在回应…`;

    const turn = {
      q: text || '（发来附件）', a: '',
      replies: speakers.map(p => ({ lead: p.name, role: p.role, content: '' })),
      todos: [], needsBoss: []
    };
    if (directed) turn.only = speakers.length ? speakers.map(p => p.name) : [sec.name];
    m.follow = (m.follow || []).concat([turn]);
    const idx = m.follow.length - 1;
    renderIfOpen(m);

    const ctx = [
      `项目主题：${m.topic}`,
      (m.plan && m.plan.understanding) ? `已定调：${m.plan.understanding}` : '',
      (m.minutes && m.minutes.summary) ? `纪要要点：${String(m.minutes.summary).slice(0, 300)}` : '',
      attachText(m, 1200),
      m.outputs.length
        ? `先前同事已经说过：\n${m.outputs.map(o => `${o.lead}（${o.title}）：${String(o.content).slice(0, 160)}`).join('\n')}`
        : ''
    ].filter(Boolean).join('\n\n');

    try {
      if (speakers.length) {
        await pool(speakers.map((p, i) => ({ p, i })), 3, async ({ p, i }) => {
          if (m.abort.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          let last = 0;
          const rep = turn.replies[i];
          /* 干活链路开工就记账：状态卡要跑表（耗时/积分/token），对齐任务线 */
          if (directed) {
            rep.status = 'run';
            rep.startedAt = Date.now();
            rep._now = '';
            renderIfOpen(m);
          }
          try {
            /* 定向 @ = 派活：能用工具就走完整执行回路（和任务线一样直接干），
               只说话的模型退回纯文本但也按干活的口径回，不再「认/不认」表态 */
            const useTools = directed && window.BOSS && window.BOSS.toolLoop && canUseTools(modelOf(p));
            if (useTools) {
              const mem = await window.BOSS.briefOf(
                S().scope, p, `${m.topic} ${said}`.slice(0, 200),
                { id: m.id, title: m.topic }
              );
              let acc = '';
              const r = await window.BOSS.toolLoop({
                model: modelOf(p),
                system: workSystem(p, m, said, dirOf(m), mem, true),
                user: `${ctx}\n\n老板点名交代你：${said}${docHint}`,
                scope: S().scope,
                perms: (S().settings && S().settings.permissions) || {},
                maxSteps: nodeSteps(''),
                goal: String(said || ''),
                budget: nodeBudget(),
                signal: m.abort.signal,
                files: newImgs,
                onText: d => {
                  acc += d;
                  rep.content = window.BOSS.splitMemo(acc).body;
                  const now = Date.now();
                  if (now - last < 140) return;
                  last = now;
                  writeFollow(m, idx, i, rep.content);
                },
                onStep: s => {
                  const a = actOf(s);
                  if (a) {
                    if (!Array.isArray(rep.says)) rep.says = [];
                    if (rep.says[rep.says.length - 1] !== a) rep.says.push(a);
                    if (rep.says.length > 24) rep.says.shift();
                    rep._now = a;
                  }
                  /* 每步重绘一次：分析行（扁平小气泡）和状态卡跟着长出来，
                     和任务线「边干边冒进度」一个体验 */
                  renderIfOpen(m);
                },
                /* 干活途中要老板拍板：挂起等答案，答案作为工具回包让它接着干。
                   和节点执行同一套——只是把卡挂到这条回复下面，不是挂在节点上。 */
                onAsk: async ({ intro, questions }) => {
                  const askId = 'af' + Math.random().toString(36).slice(2, 8);
                  const followKey = `r${idx}-${i}`;
                  const entry = {
                    askId, followKey, lead: p.name, leadRole: p.role,
                    nodeTitle: rep.lead || p.name, priority: 'P1',
                    intro: String(intro || '').slice(0, 200), questions, at: Date.now()
                  };
                  if (!Array.isArray(m.nodeAsks)) m.nodeAsks = [];
                  m.nodeAsks.push(entry);
                  rep.status = 'ask';
                  rep._now = '等你拍板（等待期不消耗 token）';
                  renderIfOpen(m); renderList(); save(m);
                  try {
                    return await new Promise((resolve, reject) => {
                      entry.resolve = resolve;
                      entry.reject = reject;
                      if (m.abort) m.abort.signal.addEventListener('abort', () =>
                        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
                    });
                  } finally {
                    const ix = m.nodeAsks.indexOf(entry);
                    if (ix >= 0) m.nodeAsks.splice(ix, 1);
                    if (rep.status === 'ask') rep.status = 'run';
                    rep._now = '接着干…';
                    renderIfOpen(m);
                  }
                }
              });
              addTokens(m, r.usage);
              rep.usage = r.usage;
              rep.content = r.text || '（这一轮没接上话：模型没吐正文。可以直接再 @ 他一次重试。）';
              rep.toolN = (r.steps || []).length;
              if (r.steps && r.steps.length) {
                rep.steps = r.steps.map(s => ({
                  name: s.name, ok: s.ok, args: s.args || {}, output: s.output || '', ms: s.ms || 0
                })).slice(0, 24);
              }
              rep.files = (r.wrote || []).slice(0, 4);
              /* 交付核验：模型声称写了的文件得真在盘上，没落盘就标出来（对齐节点的核验口径） */
              if (rep.files.length) {
                try {
                  const g = await window.BOSS.verifyPaths(S().scope, rep.files, 0);
                  const ok = (g.detail || []).filter(d => d.ok && (d.size || 0) > 0).map(d => d.path);
                  if (!ok.length) {
                    rep.files = [];
                    rep.verify = { pass: false, gaps: ['产出没落盘：模型声称写了文件，但工作区里没有'] };
                  } else {
                    rep.files = ok.slice(0, 4);
                  }
                } catch { /* 核验失败不阻塞交付展示 */ }
              }
              if (r.memo && r.memo.length) {
                window.BOSS.saveMemo(S().scope, p, r.memo, '项目：' + String(m.topic || '').slice(0, 20));
              }
              if (r.projectMemo && r.projectMemo.length) {
                window.BOSS.saveProjectMemo(S().scope, m.id, m.topic, r.projectMemo,
                  '项目：' + String(m.topic || '').slice(0, 20), m.id);
              }
            } else {
              const r = await stream({
                model: modelOf(p),
                system: directed ? workSystem(p, m, said, dirOf(m), '', false) : speakSystem(p, m, said, directed),
                user: (directed
                  ? `${ctx}\n\n老板点名问你：${said}`
                  : `${ctx}\n\n老板刚说：${said}`) + docHint,
                images: newImgs,
                signal: m.abort.signal,
                maxTokens: directed ? 800 : 700,
                onDelta: t => {
                  turn.replies[i].content = t;
                  const now = Date.now();
                  if (now - last < 140) return;
                  last = now;
                  writeFollow(m, idx, i, t);
                }
              });
              turn.replies[i].content = r.text || '（这一轮没接上话：模型没吐正文。可以直接再 @ 他一次重试。）';
              addTokens(m, r.usage);
              rep.usage = r.usage;
            }
            if (rep.startedAt) rep.status = 'done';
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            turn.replies[i].content = '这一位没说出来：' + niceErr(e);
            if (rep.startedAt) rep.status = 'fail';
          }
          if (rep.startedAt && !rep.ms) rep.ms = Date.now() - rep.startedAt;
          writeFollow(m, idx, i, turn.replies[i].content);
          save(m);
        });
      }

      if (!doRecap) {
        /* 定向对话：被点的人答完就停，不生成待办、不拉别人 */
        return;
      }

      m.busyText = directed ? `${sec.name} 在回你…` : `${sec.name} 在收口：结论、分歧、待办…`;
      renderIfOpen(m);
      const obj = await callJSON({
        m, model: modelOf(sec),
        system: recapSystem(sec, m, directed),
        user: [
          ctx,
          directed ? `老板点名问：${said}` : `老板刚说：${said}`,
          speakers.length
            ? `同事发言：\n${turn.replies.map(r => `【${r.lead} · ${r.role}】\n${r.content}`).join('\n\n')}`
            : '（这一句只有你在回，直接答老板，不用替别人表态）',
          `参会名单：${m.participants.map(p => `${p.name}（${shortRole(p.role)}）`).join('、')}`
        ].filter(Boolean).join('\n\n'),
        signal: m.abort.signal
      });
      turn.a = String(obj.summary || '').slice(0, 900);
      turn.todos = normalizeTodos(obj.todos).slice(0, 5);
      pushTodos(m, turn.todos);
      turn.needsBoss = (Array.isArray(obj.needsBoss) ? obj.needsBoss : []).slice(0, 3).map(x => String(x).slice(0, 200));
    } catch (e) {
      const aborted = e.name === 'AbortError';
      if (!doRecap) {
        /* 定向对话没有收口，出错/停下就只提示，不塞一段假的汇总 */
        turn.a = '';
        window.APP.toast(aborted ? '已停止' : ('没答出来：' + niceErr(e)));
      } else {
        turn.a = aborted ? '（已停止，上面已经说完的保留）' : ('收口失败了：' + niceErr(e));
      }
    } finally {
      /* 中途被停/异常退出时，状态卡不能一直挂着「跑着」：就地收表 */
      (turn.replies || []).forEach(r => {
        if (r && r.status === 'run') {
          r.status = 'done';
          if (r.startedAt && !r.ms) r.ms = Date.now() - r.startedAt;
        }
      });
      m.busy = false; m.busyText = '';
      m.abort = null;
      renderIfOpen(m); renderList(); save(m);
      /* 这一轮跑完，把老板中途插的话补发出去（跑着也能改方向，只是排队不打断） */
      await flushPendingFollow(m);
    }
  }

  /* 跑着的时候老板插的话排进队列，这一轮跑完统一补发（不打断正在跑的活） */
  async function flushPendingFollow(m) {
    if (!m || !Array.isArray(m.pendingFollow) || !m.pendingFollow.length) return;
    const queued = m.pendingFollow.splice(0);
    for (const q of queued) {
      const names = (q.mentions || []).filter(Boolean);
      const targets = names.length
        ? m.participants.filter(p => names.includes(p.name) && p.kind !== 'human')
        : [];
      await followUp(m, q.text, targets, q.added || []);
    }
  }

  /* ── 待办 → 任务 ── */
  /* 项目产生的待办直接进待办池，标签挂这个项目 */
  async function pushTodos(m, todos) {
    if (!todos || !todos.length) return 0;
    return window.APP.addTodos(todos.map(t => ({
      what: t.what,
      who: t.who,
      due: t.when,
      sourceType: 'meeting',
      sources: [{ type: 'meeting', id: m.id, label: m.topic }]
    })));
  }

  /* ── 删除 ── */
  async function remove(m) {
    if (!confirm(`删除项目「${m.topic}」？云端记录会一起删。`)) return;
    const st = S();
    try {
      if (!st.guest && !String(m.id).startsWith('local_')) await window.CLOUD.deleteMeeting(m.id);
    } catch (e) {
      window.APP.toast(e.message);
      return;
    }
    st.meetings = st.meetings.filter(x => x.id !== m.id);
    st.curMeetingId = st.meetings[0] ? st.meetings[0].id : null;
    renderList();
    if (st.curMeetingId) open(st.curMeetingId); else render();
    window.APP.refreshRail();
  }

  /* ── 落库 ── */
  async function save(m) {
    /* 每一节跑完 / 老板插一句话都算「动过」：先更新内存，左栏顺序立刻跟着变 */
    m.updatedAt = Date.now();
    const st = S();
    if (st.guest || !m.rowId || String(m.id).startsWith('local_')) return;
    try {
      await window.CLOUD.saveMeeting(m.id, {
        topic: m.topic,
        pinned: !!m.pinned,
        status: m.status,
        participants: m.participants,
        messages: m.messages || [],
        brief: m.brief || null,
        plan: m.plan || null,
        outputs: m.outputs || [],
        minutes: m.minutes || null,
        follow: m.follow || [],
        tokens: m.tokens || { in: 0, out: 0 },
        ms: m.ms || 0
      });
    } catch (e) {
      /* 不打断项目：内存里还在，刷新前再存一次 */
    }
  }

  /* ── 绑定 ── */
  document.addEventListener('DOMContentLoaded', () => {
    el('mtCreate').onclick = createFromModal;
    el('mtPickCore').onclick = pickCore;
    el('mtPickAll').onclick = pickAll;
    el('mtPM').onchange = e => fillPM(e.target.value);
    el('mtChief').onchange = e => fillChief(e.target.value);

    // 拉人浮层
    const pop = el('mpPop');
    if (pop) {
      pop.addEventListener('click', onPopClick);
      pop.addEventListener('input', e => {
        if (e.target.id !== 'mpSearch') return;
        addQuery = e.target.value;
        const wrap = el('mpListWrap');
        if (wrap) wrap.innerHTML = listWrapHTML();
        const f = el('mpFoot');
        if (f) f.textContent = footText();
        placePop();
      });
      pop.addEventListener('keydown', e => {
        if (e.key === 'Escape') closePop();
        if (e.key === 'Enter' && addPick.size) { e.preventDefault(); addMembers([...addPick]); }
      });
    }
    document.addEventListener('click', e => {
      const p = el('mpPop');
      if (!p || p.hidden) return;
      if (p.contains(e.target) || (e.target.closest && e.target.closest('#mpAddBtn'))) return;
      closePop();
    });
    window.addEventListener('resize', () => placePop());

    el('meetInput').addEventListener('keydown', e => {
      if (mn.open) {
        const m = cur();
        const list = mnMatches(m);
        if (e.key === 'ArrowDown') { e.preventDefault(); mn.idx = list.length ? (mn.idx + 1) % list.length : 0; renderMn(m); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); mn.idx = list.length ? (mn.idx - 1 + list.length) % list.length : 0; renderMn(m); return; }
        if ((e.key === 'Enter' || e.key === 'Tab') && list.length) { e.preventDefault(); pickMn(m, mn.idx); return; }
        if (e.key === 'Escape') { e.preventDefault(); mnClose(); return; }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
    });
    el('meetInput').addEventListener('input', e => {
      const ta = e.target;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 130) + 'px';

      /* 打 @ 就弹出参会人，续打汉字继续过滤（任何阶段都支持） */
      const m = cur();
      const before = ta.value.slice(0, ta.selectionStart);
      const at = before.lastIndexOf('@');
      if (m && at >= 0 && !/[\s@]/.test(before.slice(at + 1))) {
        const q = before.slice(at + 1);
        if (q !== mn.q) mn.idx = 0;
        mn.at = at; mn.q = q; mn.from = 'input';
        renderMn(m);
      } else {
        mnClose();
      }
      /* 底栏右边提示这一句会发给谁（带 @ 就只回那几位） */
      if (m) {
        const names = mentionsIn(m, ta.value).map(p => p.name);
        setWhoChip(names.length ? `只回 ${names.join('、')}` : (m.status === 'done' ? `全体参会 ${m.participants.filter(p => p.kind !== 'human').length} 人` : `牵头人 ${chiefOf(m).name}`));
      }
    });
    el('meetInput').addEventListener('blur', () => setTimeout(() => { if (mn.open) mnClose(); }, 160));
    el('meetInput').addEventListener('click', () => placeMn());

    const mnp = el('mnPop');
    if (mnp) {
      mnp.addEventListener('mousedown', e => {
        e.preventDefault();
        const it = e.target.closest && e.target.closest('.mn-item');
        if (!it) return;
        pickMn(cur(), Number(it.dataset.i));
      });
    }
    /* 底栏右侧员工 chip：点开单选一位参会人，选完自动 @ 他 */
    const whoChipEl = el('meetWho');
    if (whoChipEl) whoChipEl.addEventListener('click', e => { e.stopPropagation(); toggleMeetWhoPop(); });
    /* 点 chip 之外的空白就收起选人浮层 */
    document.addEventListener('click', e => {
      if (!mn.open) return;
      if (e.target.closest && (e.target.closest('#mnPop') || e.target.closest('#meetWho'))) return;
      mnClose();
    });
    window.addEventListener('resize', () => placeMn());
    el('meetBody').addEventListener('scroll', () => { if (mn.open) mnClose(); }, { passive: true });
  });

  /* 等模型的时候给个读数，别让人以为卡死了 */
  setInterval(() => {
    document.querySelectorAll('.mt-el').forEach(n => {
      const t0 = Number(n.dataset.t0) || 0;
      if (!t0) return;
      n.textContent = '已等 ' + Math.round((Date.now() - t0) / 1000) + 's';
    });
    document.querySelectorAll('.pr-t').forEach(n => {
      const t0 = Number(n.dataset.t0) || 0;
      if (!t0) { n.textContent = ''; return; }
      n.textContent = Math.round((Date.now() - t0) / 1000) + 's';
    });
  }, 1000);

  /* 质检台用：不烧 token 的自检——后台项目的正文会不会写进当前这一场。
     不碰真实项目数据：临时把主区换成一具骨架（两个同号容器），
     当前场设成 A 让 B 往里写，必须被挡住；再让 A 写，必须成功。 */
  function checkBinding() {
    const box = el('meetBody');
    const st = S();
    if (!box) return { pass: false, detail: [{ name: '找到项目主区容器', pass: false }] };
    const keepHTML = box.innerHTML;
    const keepId = st.curMeetingId;
    const out = [];
    try {
      box.innerHTML = '<div data-live="0"></div><div data-fr="0-0"></div>';
      st.curMeetingId = 'bindA';
      const A = { id: 'bindA' };
      const B = { id: 'bindB' };
      const okA = writeLive(A, 0, 'A 的正文');
      const gotA = /A 的正文/.test(box.querySelector('[data-live="0"]').innerHTML);
      const before = box.innerHTML;
      const okB = writeLive(B, 0, 'B 的正文');
      const after = box.innerHTML;
      out.push({ name: '当前这一场写得进去', pass: okA === true && gotA });
      out.push({ name: '别处的项目写不进来', pass: okB === false && before === after });
      const okFA = writeFollow(A, 0, 0, 'A 的回复');
      const before2 = box.innerHTML;
      const okFB = writeFollow(B, 0, 0, 'B 的回复');
      out.push({ name: '当前这一场的 @ 回复写得进去', pass: okFA === true });
      out.push({ name: '@ 回复不串场', pass: okFB === false && before2 === box.innerHTML });
    } catch (e) {
      out.push({ name: '自检跑得完', pass: false, detail: String((e && e.message) || e) });
    } finally {
      try { st.curMeetingId = keepId; box.innerHTML = keepHTML; } catch { /* 尽力还原 */ }
    }
    return { pass: out.every(x => x.pass), detail: out };
  }

  window.MEET = { primeStdMem, stdMemLine, openCreate, createQuick, createProject, convertFromTask, pmOf, chiefOf, originOf, renderList, open, render, syncComposer, sendMsg, cur, remove, save, rerunWeak, resolveDelivered, raiseBud, finishNow, writeMinutes, budCap, budSpent, answerFromBoard, answerNodeAsk, liveNodeAsks, limOf, nodeSteps, nodeBudget,
  /* 后台项目不许把正文写进当前这一场：给质检台的自检入口（不烧 token） */
  checkBinding,
  /* 错误分类、节点状态判定、计划版本：抽出来给单测和质检台用，不烧 token */
  errClass, RETRYABLE, nodeState, stTagOf, pushPlanVersion, planVersionOf,
  /* 左栏员工卡点一下就把人拉进当前项目，和「＋ 增加成员」走同一条路 */
  addMembers };
})();
