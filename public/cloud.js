/* 云服务客户端：登录 / 员工 / 任务 / 设置 / 云端存档 / 模型通道，共用同一个 client。
   初始化参数只来自 cloud-config.js 里的 publicConfig，不猜、不写死第二份。 */
(function () {
  const CFG = window.__BOSS_CLOUD__ || {};
  let client = null;
  let session = null;

  /* 发布网关要求每个请求都带 sharecode（首次从链接进来，之后存本地） */
  const SC = (function () {
    try {
      const q = new URLSearchParams(location.search).get('sharecode') || '';
      if (q) localStorage.setItem('bsc', q);
      return q || localStorage.getItem('bsc') || '';
    } catch (e) { return ''; }
  })();
  function withSC(url) {
    return SC ? url + (url.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(SC) : url;
  }
  window.withSC = withSC;

  /* SDK 按需加载：主 CDN 不通时自动换备用源，避免整站因为一个 CDN 挂掉 */
  const CDN = [
    'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js',
    'https://unpkg.com/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js'
  ];
  let readyPromise = null;

  function loadScript(src, timeoutMs) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      const t = setTimeout(() => { s.remove(); reject(new Error('加载超时')); }, timeoutMs);
      s.onload = () => { clearTimeout(t); resolve(); };
      s.onerror = () => { clearTimeout(t); s.remove(); reject(new Error('加载失败')); };
      document.head.appendChild(s);
    });
  }

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      if (window.WorkBuddyCloud) return true;
      for (const src of CDN) {
        try {
          await loadScript(src, 9000);
          if (window.WorkBuddyCloud) return true;
        } catch (e) { /* 换下一个源 */ }
      }
      throw new Error('云 SDK 加载失败：两个 CDN 都没通，检查网络后刷新页面');
    })();
    return readyPromise;
  }

  function sdk() {
    if (!window.WorkBuddyCloud || typeof window.WorkBuddyCloud.createWorkBuddyCloud !== 'function') {
      throw new Error('云 SDK 还没就绪，稍等或刷新页面');
    }
    return window.WorkBuddyCloud;
  }

  function clientOf() {
    if (client) return client;
    client = sdk().createWorkBuddyCloud({
      endpoint: CFG.endpoint,
      oauthRelayBaseUrl: CFG.oauthRelayBaseUrl,
      publishableKey: CFG.publishableKey
    });
    return client;
  }

  /* ── 登录 ── */
  async function restoreCallback() {
    const url = new URL(location.href);
    if (!url.searchParams.has('code') && !url.searchParams.has('error')) return null;
    const provider = url.searchParams.get('provider');
    if (provider !== 'workbuddy' && provider !== 'wechat') {
      return { error: new Error('授权回调缺少有效的登录方式，请重新登录') };
    }
    const auth = clientOf().auth;
    const handler = provider === 'workbuddy' ? auth.handleWorkBuddyCallback : auth.handleWechatWebCallback;
    if (typeof handler !== 'function') {
      return { error: new Error('当前 SDK 版本缺少该登录方式的回调能力') };
    }
    const { data, error } = await handler.call(auth);
    if (!error) {
      for (const k of ['code', 'state', 'provider']) url.searchParams.delete(k);
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
    return { session: data || null, error: error || null };
  }

  async function getSession() {
    const { data, error } = await clientOf().auth.getSession();
    if (error) { session = null; return { session: null, error }; }
    session = data || null;
    return { session, error: null };
  }

  async function signInWorkBuddy() {
    const back = new URL(location.href);
    back.pathname = '/';
    for (const k of ['code', 'state', 'provider']) back.searchParams.delete(k);
    const { data, error } = await clientOf().auth.signInWithOAuth({
      provider: 'workbuddy',
      redirectTo: back.toString()
    });
    if (error) throw error;
    location.assign(data.url);
  }

  async function signInWechat() {
    const redirectTo = SC
      ? location.origin + '/?sharecode=' + encodeURIComponent(SC)
      : location.origin;
    const { data, error } = await clientOf().auth.signInWithOAuth({
      provider: 'wechat',
      redirectTo
    });
    if (error) throw error;
    location.assign(data.url);
  }

  async function sendPhoneCode(phone) {
    const { data, error } = await clientOf().auth.sendOtp({ phone });
    if (error) throw error;
    return data;
  }

  async function verifyPhoneCode({ phone, verificationId, isExistingUser, token }) {
    const { data, error } = await clientOf().auth.verifyOtp({
      phone, verificationId, isExistingUser, token
    });
    if (error) throw error;
    session = data || null;
    return data;
  }

  /* 邮箱验证码登录：和手机那条同一个开关，只是收件人换成邮箱 */
  async function sendEmailCode(email) {
    const { data, error } = await clientOf().auth.sendOtp({ email });
    if (error) throw error;
    return data;
  }

  async function verifyEmailCode({ email, verificationId, isExistingUser, token }) {
    const { data, error } = await clientOf().auth.verifyOtp({
      email, verificationId, isExistingUser, token
    });
    if (error) throw error;
    session = data || null;
    return data;
  }

  async function signOut() {
    try { await clientOf().auth.signOut(); } catch (e) { /* 断网时也要能退到登录页 */ }
    session = null;
  }

  function user() {
    return (session && session.user) || null;
  }

  function uid() {
    const u = user();
    return (u && u.id) || '';
  }

  /* ── 模型凭证 ──
     循环搬到服务端之后，服务端要自己调模型，就得有用户身份的 access_token。
     这个函数只做一件事：把它取出来交给调用方（由调用方随任务一起 POST 上去）。
     SDK 没把它放在文档里，所以按「内部方法 → 会话字段」两路取：
     先问 auth 要（它内部就是这么给 cloudFetch 供货的），拿不到再翻 session。
     两条都空就返回空串——上层据此提示「请重新登录」，不要编一个假 token。

     取完还要再看一眼有效期：SDK 的 ensure() 判过期用的是本地记的 expiresAt，
     本地时钟或写入时机稍有偏差，就会把一张通道那头已经过期的凭证当有效交出去。
     与其等服务端 401 再回头问用户，不如这里直接算一次 exp。 */
  function jwtExp(t) {
    try {
      const p = String(t).split('.');
      if (p.length !== 3) return 0;
      const b = p[1].replace(/-/g, '+').replace(/_/g, '/');
      const pad = '='.repeat((4 - (b.length % 4)) % 4);
      const j = JSON.parse(atob(b + pad));
      return typeof j.exp === 'number' ? j.exp * 1000 : 0;
    } catch (e) { return 0; }
  }

  async function accessToken() {
    const a = clientOf().auth;
    let t = '';
    try {
      if (a && typeof a.getAccessToken === 'function') t = String(await a.getAccessToken() || '');
    } catch (e) { /* 落到下面的字段兜底 */ }
    if (!t) {
      const s = session || {};
      t = String(
        s.access_token || s.accessToken
        || (s.session && (s.session.access_token || s.session.accessToken))
        || ''
      );
    }
    /* 已过期或 2 分钟内到期：拿 refresh_token 换一张，换不到就返回原值——
       原值哪怕过期，也比空字符串更有诊断价值（服务端能把 exp 报出来）。 */
    const exp = jwtExp(t);
    if (t && exp && exp - Date.now() < 120000) {
      try {
        if (a && typeof a.refreshSession === 'function') await a.refreshSession();
        const t2 = a && typeof a.getAccessToken === 'function' ? String(await a.getAccessToken() || '') : '';
        if (t2) t = t2;
      } catch (e) { /* 续期失败：让服务端照原样报 401，别在这里改成别的话 */ }
    }
    return t;
  }

  /* ── 模型通道 ── */
  async function listModels() {
    const r = await clientOf().llm.models.list();
    const arr = Array.isArray(r) ? r : (r && r.data) || [];
    return arr.filter(m => m && m.disabled !== true && m.enabled !== false);
  }

  function chatStream(payload) {
    return clientOf().llm.chat.completions.create(payload);
  }

  /* ── 设置 ── */
  const DEFAULT_SETTINGS = {
    model: '',
    permissions: { read: true, write: true, exec: false, net: true },
    max_steps: 12,
    max_tokens: 200000,
    max_proj_steps: 6,
    max_proj_tokens: 600000
  };

  async function loadSettings() {
    const { data, error } = await clientOf().database
      .from('ba_settings').select('*').limit(1);
    if (error) throw error;
    if (data && data.length) return normalizeSettings(data[0]);
    const { data: made, error: e2 } = await clientOf().database
      .from('ba_settings')
      .insert({ ...DEFAULT_SETTINGS, owner_name: user() && user().name ? user().name : null })
      .select();
    if (e2) throw e2;
    return normalizeSettings((made && made[0]) || { ...DEFAULT_SETTINGS, id: null });
  }

  function normalizeSettings(row) {
    return {
      rowId: row.id || null,
      model: row.model || '',
      permissions: Object.assign({ read: true, write: true, exec: false, net: true }, row.permissions || {}),
      maxSteps: Number(row.max_steps) || 12,
      maxTokens: Number(row.max_tokens) || 200000,
      /* 项目侧：每节最多几步 + 整场 token 上限（跟着设置一起存，换设备也一致） */
      projSteps: Number(row.max_proj_steps) || 6,
      projTokens: Number(row.max_proj_tokens) || 600000,
      /* 愿景（老板可改）与印象（员工生成、只读）跟着设置一起存，不另开表 */
      vision: Array.isArray(row.vision) ? row.vision : [],
      impressions: Array.isArray(row.impressions) ? row.impressions : []
    };
  }

  async function saveSettings(patch) {
    const payload = {};
    if (patch.model !== undefined) payload.model = patch.model;
    if (patch.permissions) payload.permissions = patch.permissions;
    if (patch.maxSteps !== undefined) payload.max_steps = patch.maxSteps;
    if (patch.maxTokens !== undefined) payload.max_tokens = patch.maxTokens;
    if (patch.projSteps !== undefined) payload.max_proj_steps = patch.projSteps;
    if (patch.projTokens !== undefined) payload.max_proj_tokens = patch.projTokens;
    if (patch.vision !== undefined) payload.vision = patch.vision;
    if (patch.impressions !== undefined) payload.impressions = patch.impressions;
    payload.updated_at = new Date().toISOString();
    if (!patch.rowId) return null;
    const { data, error } = await clientOf().database
      .from('ba_settings').update(payload).eq('id', patch.rowId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('设置没保存上（可能不是你的账号，或登录已过期）');
    return normalizeSettings(data[0]);
  }

  /* ── 员工 ── */
  const SEED_STAFF = [
    { name: '周砚', role: '秘书', persona: 'mature', core: true, notes: '先给结论再给依据。拆任务时按「能验证」拆，不要按「听起来完整」拆。' },
    { name: '秦律', role: '法务', persona: 'rigor', core: true, notes: '条款风险必须引具条文或惯例来源；不确定就说不确定，不要为了给答案而给答案。' },
    { name: '何算', role: '财务', persona: 'sharp', core: true, notes: '算钱必须给算式和口径；涉及总成本时要摊运费、看起订量。' }
  ];

  function staffFromRow(r) {
    return {
      rowId: r.id, id: 'e_' + r.id, name: r.name, role: r.role,
      persona: r.persona || 'mature', model: r.model || '', notes: r.notes || '',
      /* 性格四维度：都选填，空字符串表示没填（提示词里就不会出现这一项） */
      gender: r.gender || '', zodiac: r.zodiac || '', sign: r.sign || '', mbti: r.mbti || '',
      /* 从标准员工库复制过来的会带上出处 id，运行时按它实时读那边的记忆 */
      stdId: Number(r.std_id) || 0,
      kind: r.kind === 'human' ? 'human' : 'ai',
      core: r.core === true,
      createdAt: Date.parse(r.created_at) || Date.now()
    };
  }

  async function listStaff(autoSeed) {
    const { data, error } = await clientOf().database
      .from('ba_staff').select('*').order('created_at', { ascending: true });
    if (error) throw error;
    let rows = data || [];
    if (!rows.length && autoSeed) {
      const ownName = user() && user().name ? user().name : null;
      const { data: made, error: e2 } = await clientOf().database
        .from('ba_staff')
        .insert(SEED_STAFF.map(s => ({ ...s, model: '', owner_name: ownName })))
        .select();
      if (e2) throw e2;
      rows = made || [];
    }
    return rows.map(staffFromRow);
  }

  async function addStaff(s) {
    const { data, error } = await clientOf().database
      .from('ba_staff')
      .insert({
        name: s.name, role: s.role || '助理', persona: s.persona || 'mature',
        model: s.model || '', notes: s.notes || '',
        gender: s.gender || '', zodiac: s.zodiac || '', sign: s.sign || '', mbti: s.mbti || '',
        kind: s.kind === 'human' ? 'human' : 'ai',
        core: s.core === true,
        owner_name: user() && user().name ? user().name : null
      })
      .select();
    if (error) throw error;
    return staffFromRow(data[0]);
  }

  async function updateStaff(rowId, patch) {
    const payload = {};
    for (const k of ['name', 'role', 'persona', 'model', 'notes', 'kind', 'core', 'gender', 'zodiac', 'sign', 'mbti']) {
      if (patch[k] !== undefined) payload[k] = patch[k];
    }
    const { data, error } = await clientOf().database
      .from('ba_staff').update(payload).eq('id', rowId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没改成（可能不是你的员工）');
    return staffFromRow(data[0]);
  }

  async function deleteStaff(rowId) {
    const { data, error } = await clientOf().database
      .from('ba_staff').delete().eq('id', rowId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没删掉（可能不是你的员工）');
  }

  /* ── 标准员工（管理后台训练的公共员工库） ──
     和 ba_staff 的关键差别是读权限：ba_staff 只能看自己的（owner 隔离），
     ba_std_staff 的 SELECT 对所有人开放——不然「训练出来的员工所有人可用」这话就是空的。
     写仍然限 owner（只有训练它的人在管理后台能改）。 */
  function stdFromRow(r, mems) {
    return {
      stdId: Number(r.id),
      id: 's_' + r.id,
      name: r.name || '',
      role: r.role || '',
      persona: r.persona || 'mature',
      gender: r.gender || '', zodiac: r.zodiac || '', sign: r.sign || '', mbti: r.mbti || '',
      notes: r.notes || '',
      model: r.model || '',
      kind: r.kind === 'human' ? 'human' : 'ai',
      core: r.core === true,
      published: r.published !== false,
      uses: Number(r.uses) || 0,
      tag: r.tag || '',
      sort: Number(r.sort) || 100,
      createdAt: Date.parse(r.created_at) || Date.now(),
      mem: mems || []
    };
  }

  function memFromRow(r) {
    return {
      memId: Number(r.id),
      stdId: Number(r.staff_id) || 0,
      kind: r.kind || 'note',
      text: r.text || '',
      hits: Number(r.hits) || 0,
      createdAt: Date.parse(r.created_at) || Date.now()
    };
  }

  /* 一次把员工和记忆都拉回来：分两次查再拼，比每人查一次记忆少 N-1 次往返 */
  async function listStdStaff() {
    const { data, error } = await clientOf().database
      .from('ba_std_staff').select('*').order('sort', { ascending: true });
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) return [];
    let mems = [];
    try {
      const r2 = await clientOf().database
        .from('ba_std_mem').select('*').order('created_at', { ascending: true });
      if (r2.error) throw r2.error;
      mems = (r2.data || []).map(memFromRow);
    } catch (e) {
      /* 记忆表读不到不该让整个员工库消失：员工照常返回，记忆空着 */
      mems = [];
    }
    const byStaff = {};
    for (const m of mems) (byStaff[m.stdId] = byStaff[m.stdId] || []).push(m);
    return rows.map(r => stdFromRow(r, byStaff[Number(r.id)] || []));
  }

  function stdPayload(s) {
    const p = {};
    for (const k of ['name', 'role', 'persona', 'model', 'notes', 'kind', 'core',
      'gender', 'zodiac', 'sign', 'mbti', 'tag']) {
      if (s[k] !== undefined) p[k] = s[k];
    }
    if (s.published !== undefined) p.published = !!s.published;
    if (s.sort !== undefined) p.sort = Number(s.sort) || 100;
    return p;
  }

  /* owner_name：记录这条标准员工是谁训练的，后台列表用来标来源。
     列是后加的，老环境可能没有——真遇上 42703 就把这个字段摘掉重试，
     不能因为它把整条插入废掉（之前就是这么「同步了但一条都没有」的）。 */
  function undefCol(err) {
    const s = `${(err && err.code) || ''} ${(err && err.message) || ''}`;
    return /42703|does not exist|不存在/.test(s);
  }

  async function addStdStaff(s) {
    const payload = stdPayload(s);
    payload.owner_name = user() && user().name ? user().name : '';
    payload.updated_at = new Date().toISOString();
    let { data, error } = await clientOf().database.from('ba_std_staff').insert(payload).select();
    if (error && payload.owner_name !== undefined && undefCol(error)) {
      const p2 = { ...payload };
      delete p2.owner_name;
      ({ data, error } = await clientOf().database.from('ba_std_staff').insert(p2).select());
    }
    if (error) throw error;
    if (!data || !data.length) throw new Error('写入被拒（可能不是你的登录身份或没有写权限）');
    return stdFromRow(data[0], []);
  }

  async function updateStdStaff(stdId, patch) {
    const payload = stdPayload(patch);
    payload.updated_at = new Date().toISOString();
    const { data, error } = await clientOf().database
      .from('ba_std_staff').update(payload).eq('id', stdId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没改成（这条标准员工不归你管）');
    return stdFromRow(data[0], []);
  }

  async function deleteStdStaff(stdId) {
    /* 先删记忆再删员工：反过来的话记忆变孤儿，谁都清不掉 */
    try {
      await clientOf().database.from('ba_std_mem').delete().eq('staff_id', stdId);
    } catch (e) { /* 记忆本来就没有也无所谓 */ }
    const { data, error } = await clientOf().database
      .from('ba_std_staff').delete().eq('id', stdId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没删掉（这条标准员工不归你管）');
  }

  async function addStdMem(m) {
    const { data, error } = await clientOf().database.from('ba_std_mem').insert({
      staff_id: m.stdId,
      kind: m.kind || 'note',
      text: String(m.text || '')
    }).select();
    if (error) throw error;
    return memFromRow(data[0]);
  }

  async function updateStdMem(memId, patch) {
    const payload = { updated_at: new Date().toISOString() };
    if (patch.kind !== undefined) payload.kind = patch.kind;
    if (patch.text !== undefined) payload.text = patch.text;
    const { data, error } = await clientOf().database
      .from('ba_std_mem').update(payload).eq('id', memId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没改成（这条记忆不归你管）');
    return memFromRow(data[0]);
  }

  async function deleteStdMem(memId) {
    const { data, error } = await clientOf().database
      .from('ba_std_mem').delete().eq('id', memId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没删掉（这条记忆不归你管）');
  }

  /* 用户端「用这个标准员工」：复制一份到自己名下，std_id 记住出处。
     std_id 的用处是运行时按它实时读记忆——老板在后台补充的经验，老用户下次开口就吃到。 */
  async function adoptStdStaff(std) {
    if (!uid()) throw new Error('登录后才能把标准员工加进来');
    const { data, error } = await clientOf().database.from('ba_staff').insert({
      name: std.name, role: std.role || '助理', persona: std.persona || 'mature',
      model: '', notes: std.notes || '',
      gender: std.gender || '', zodiac: std.zodiac || '', sign: std.sign || '', mbti: std.mbti || '',
      kind: 'ai',
      /* 核心员工是「新项目默认拉谁」的开关，属于使用者自己的偏好，不从库里继承 */
      core: false,
      std_id: Number(std.stdId) || 0,
      owner_name: user() && user().name ? user().name : null
    }).select();
    if (error) throw error;
    const out = staffFromRow(data[0]);
    out.stdId = Number(data[0].std_id) || 0;
    /* 使用次数只是个热度指标，写不上不算失败（跨账号写别人的行会被 RLS 挡住） */
    (async () => {
      try {
        await clientOf().database.from('ba_std_staff')
          .update({ uses: (Number(std.uses) || 0) + 1 }).eq('id', std.stdId);
      } catch (e) { /* 记不上就算了，不影响取用 */ }
    })();
    return out;
  }

  /* 运行时按 std_id 取记忆（用户端提示词要用，不能只给管理后台） */
  async function listStdMemOf(stdId) {
    if (!stdId) return [];
    try {
      const { data, error } = await clientOf().database
        .from('ba_std_mem').select('*').eq('staff_id', stdId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map(memFromRow);
    } catch (e) { return []; }
  }

  /* ── 任务 ── */
  /* 拍板卡要能跨刷新还原：pending_ask 没有单独的库列，就从存档的 messages 里
     倒查最后一次 ask_boss 的调用参数。已经确认过的（后面接着一条「【已确认…】」）
     不再弹卡片，否则一刷新又让人答一遍。 */
  function pendingAskFromMessages(msgs) {
    if (!Array.isArray(msgs)) return null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m) continue;
      if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('【已确认')) return null;
      const calls = (m.role === 'assistant' && Array.isArray(m.tool_calls)) ? m.tool_calls : [];
      for (let j = calls.length - 1; j >= 0; j--) {
        const f = calls[j] && calls[j].function;
        if (!f || f.name !== 'ask_boss') continue;
        let a = {};
        try { a = JSON.parse(f.arguments || '{}'); } catch (e) { continue; }
        const questions = (Array.isArray(a.questions) ? a.questions : [])
          .map(x => ({
            q: String((x && x.q) || '').trim(),
            options: (x && Array.isArray(x.options) ? x.options : []).map(s => String(s).trim()).filter(Boolean),
            multi: !!(x && x.multi)
          }))
          .filter(x => x.q);
        if (!questions.length) continue;
        return { intro: String(a.intro || '').trim(), questions };
      }
    }
    return null;
  }
  function taskFromRow(r) {
    return {
      rowId: r.id,
      id: r.client_id,
      title: r.title,
      goal: r.goal,
      deliverables: Array.isArray(r.deliverables) ? r.deliverables : [],
      employeeId: r.staff_id || '',
      employeeName: r.staff_name || '',
      employeeRole: r.staff_role || '',
      status: r.status || 'queued',
      result: r.result || '',
      steps: Array.isArray(r.steps) ? r.steps : [],
      messages: Array.isArray(r.messages) ? r.messages : null,
      userMsgs: Array.isArray(r.user_msgs) ? r.user_msgs : null,
      tokens: { in: Number(r.tokens_in) || 0, out: Number(r.tokens_out) || 0 },
      ms: Number(r.ms) || 0,
      blockedOn: r.blocked_on || null,
      deliverableCheck: r.deliverable_check || null,
      /* 验收结论跟着 deliverable_check 一起存（库里没单独的列），读回来要拆出来还给界面 */
      verify: (r.deliverable_check && r.deliverable_check.verify) || null,
      pendingAsk: r.status === 'need_input' ? pendingAskFromMessages(r.messages) : null,
      pinned: !!r.pinned,
      createdAt: Date.parse(r.created_at) || Date.now(),
      /* 最近修改时间：左栏按它排（谁刚动过谁在上）。老记录没有 updated_at 就退回创建时间 */
      updatedAt: Date.parse(r.updated_at) || Date.parse(r.created_at) || Date.now()
    };
  }

  async function listTasks(limit) {
    /* 按最近修改倒序取：左栏就是照这个顺序列的，先按创建时间取 60 条再排，
       会把「很早建、今天才动过」的任务漏在窗口外。 */
    const { data, error } = await clientOf().database
      .from('ba_tasks').select('*').order('updated_at', { ascending: false }).limit(limit || 60);
    if (error) throw error;
    return (data || []).map(taskFromRow);
  }

  async function createTask(t) {
    const { data, error } = await clientOf().database
      .from('ba_tasks')
      .insert({
        client_id: t.id, title: t.title, goal: t.goal,
        deliverables: t.deliverables || [],
        staff_id: t.employeeId || null, staff_name: t.employeeName || null,
        staff_role: t.employeeRole || null,
        status: t.status || 'queued', result: '', steps: [], tokens_in: 0, tokens_out: 0, ms: 0,
        owner_name: user() && user().name ? user().name : null
      })
      .select();
    if (error) throw error;
    return taskFromRow(data[0]);
  }

  async function saveTask(clientId, patch) {
    const payload = { updated_at: new Date().toISOString() };
    if (patch.title !== undefined) payload.title = patch.title;
    if (patch.pinned !== undefined) payload.pinned = !!patch.pinned;
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.result !== undefined) payload.result = patch.result;
    if (patch.steps !== undefined) payload.steps = patch.steps;
    if (patch.messages !== undefined) payload.messages = patch.messages;
    if (patch.userMsgs !== undefined) payload.user_msgs = patch.userMsgs;
    if (patch.tokens !== undefined) { payload.tokens_in = patch.tokens.in; payload.tokens_out = patch.tokens.out; }
    if (patch.ms !== undefined) payload.ms = patch.ms;
    if (patch.blockedOn !== undefined) payload.blocked_on = patch.blockedOn;
    if (patch.deliverableCheck !== undefined) payload.deliverable_check = patch.deliverableCheck;
    if (patch.title !== undefined) payload.title = patch.title;
    /* 转交：把「谁在跟」一起存下来，换个设备打开还是这个人 */
    if (patch.staff !== undefined) {
      payload.staff_id = patch.staff ? (patch.staff.id || null) : null;
      payload.staff_name = patch.staff ? (patch.staff.name || null) : null;
      payload.staff_role = patch.staff ? (patch.staff.role || null) : null;
    }
    const { data, error } = await clientOf().database
      .from('ba_tasks').update(payload).eq('client_id', clientId).select();
    if (error) throw error;
    return data && data.length ? taskFromRow(data[0]) : null;
  }

  async function deleteTask(clientId) {
    const { data, error } = await clientOf().database
      .from('ba_tasks').delete().eq('client_id', clientId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没删掉（可能不是你的任务）');
  }

  /* ── 会议 ── */
  function meetingFromRow(r) {
    const at = Date.parse(r.created_at) || Date.now();
    return {
      rowId: r.id,
      id: r.client_id,
      topic: r.topic,
      status: r.status || 'briefing',
      /* at 必须带上：项目的工作目录名是按「创建时间 + 主题」算的，
         少了它每次刷新都会换一个目录，之前写出来的产出就对不上了 */
      at,
      createdAt: at,
      /* 项目也按最近修改排；at 不能动（目录名靠它），所以另开一个字段 */
      updatedAt: Date.parse(r.updated_at) || at,
      participants: Array.isArray(r.participants) ? r.participants : [],
      messages: Array.isArray(r.messages) ? r.messages : [],
      follow: Array.isArray(r.follow) ? r.follow : [],
      brief: r.brief || null,
      plan: r.plan || null,
      outputs: Array.isArray(r.outputs) ? r.outputs : [],
      minutes: r.minutes || null,
      tokens: { in: Number(r.tokens_in) || 0, out: Number(r.tokens_out) || 0 },
      ms: Number(r.ms) || 0,
      pinned: !!r.pinned
    };
  }

  async function listMeetings(limit) {
    const { data, error } = await clientOf().database
      .from('ba_meetings').select('*').order('updated_at', { ascending: false }).limit(limit || 40);
    if (error) throw error;
    return (data || []).map(meetingFromRow);
  }

  async function createMeeting(m) {
    const { data, error } = await clientOf().database
      .from('ba_meetings')
      .insert({
        client_id: m.id, topic: m.topic, status: m.status || 'briefing',
        participants: m.participants || [], messages: [], outputs: [],
        owner_name: user() && user().name ? user().name : null
      })
      .select();
    if (error) throw error;
    return meetingFromRow(data[0]);
  }

  async function saveMeeting(clientId, patch) {
    const payload = { updated_at: new Date().toISOString() };
    if (patch.topic !== undefined) payload.topic = patch.topic;
    if (patch.pinned !== undefined) payload.pinned = !!patch.pinned;
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.participants !== undefined) payload.participants = patch.participants;
    if (patch.messages !== undefined) payload.messages = patch.messages;
    if (patch.brief !== undefined) payload.brief = patch.brief;
    if (patch.plan !== undefined) payload.plan = patch.plan;
    if (patch.outputs !== undefined) payload.outputs = patch.outputs;
    if (patch.minutes !== undefined) payload.minutes = patch.minutes;
    if (patch.follow !== undefined) payload.follow = patch.follow;
    if (patch.tokens !== undefined) { payload.tokens_in = patch.tokens.in; payload.tokens_out = patch.tokens.out; }
    if (patch.ms !== undefined) payload.ms = patch.ms;
    const { data, error } = await clientOf().database
      .from('ba_meetings').update(payload).eq('client_id', clientId).select();
    if (error) throw error;
    return data && data.length ? meetingFromRow(data[0]) : null;
  }

  async function deleteMeeting(clientId) {
    const { data, error } = await clientOf().database
      .from('ba_meetings').delete().eq('client_id', clientId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没删掉（可能不是你的项目）');
  }

  /* ── 待办 ── */
  function todoFromRow(r) {
    return {
      rowId: r.id,
      id: r.client_id,
      what: r.what || '',
      who: r.who || '',
      due: r.due || '',
      sourceType: r.source_type || 'meeting',
      sources: Array.isArray(r.sources) ? r.sources : [],
      taskIds: Array.isArray(r.task_ids) ? r.task_ids : [],
      status: r.status || 'open',
      createdAt: Date.parse(r.created_at) || Date.now()
    };
  }

  async function listTodos(limit) {
    const { data, error } = await clientOf().database
      .from('ba_todos').select('*').order('created_at', { ascending: false }).limit(limit || 200);
    if (error) throw error;
    return (data || []).map(todoFromRow);
  }

  async function createTodo(t) {
    const { data, error } = await clientOf().database
      .from('ba_todos')
      .insert({
        client_id: t.id,
        what: t.what, who: t.who || null, due: t.due || null,
        source_type: t.sourceType || 'meeting',
        sources: t.sources || [],
        task_ids: t.taskIds || [],
        status: t.status || 'open',
        owner_name: user() && user().name ? user().name : null
      })
      .select();
    if (error) throw error;
    return todoFromRow(data[0]);
  }

  async function saveTodo(clientId, patch) {
    const payload = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.sources !== undefined) payload.sources = patch.sources;
    if (patch.taskIds !== undefined) payload.task_ids = patch.taskIds;
    if (patch.who !== undefined) payload.who = patch.who;
    if (patch.due !== undefined) payload.due = patch.due;
    const { data, error } = await clientOf().database
      .from('ba_todos').update(payload).eq('client_id', clientId).select();
    if (error) throw error;
    return data && data.length ? todoFromRow(data[0]) : null;
  }

  /* 批量改状态：待办页的「全部失效 / 全部恢复」用。
     一次请求改一批，不要一条条发——50 条待办就是 50 次往返，还没改完人就关页面了。 */
  async function voidTodos(clientIds, status) {
    const ids = (clientIds || []).filter(Boolean);
    if (!ids.length) return 0;
    const { data, error } = await clientOf().database
      .from('ba_todos')
      .update({ status: status || 'void', updated_at: new Date().toISOString() })
      .in('client_id', ids)
      .select();
    if (error) throw error;
    return (data || []).length;
  }

  async function deleteTodo(clientId) {
    const { data, error } = await clientOf().database
      .from('ba_todos').delete().eq('client_id', clientId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没删掉（可能不是你的待办）');
  }

  /* ── 员工专属知识库 ── */
  function kbFromRow(r) {
    return {
      rowId: r.id,
      id: r.client_id,
      staffId: r.staff_id,
      staffName: r.staff_name || '',
      title: r.title || '',
      content: r.content || '',
      chunks: Array.isArray(r.chunks) ? r.chunks : [],
      chars: Number(r.chars) || 0,
      createdAt: Date.parse(r.created_at) || Date.now()
    };
  }

  async function listKb(staffId) {
    let q = clientOf().database.from('ba_kb').select('*').order('created_at', { ascending: false }).limit(400);
    if (staffId) q = q.eq('staff_id', staffId);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(kbFromRow);
  }

  async function createKb(k) {
    const { data, error } = await clientOf().database
      .from('ba_kb')
      .insert({
        client_id: k.id, staff_id: k.staffId, staff_name: k.staffName || null,
        title: k.title || null, content: k.content, chunks: k.chunks || [],
        chars: k.chars || 0,
        owner_name: user() && user().name ? user().name : null
      })
      .select();
    if (error) throw error;
    return kbFromRow(data[0]);
  }

  async function deleteKb(clientId) {
    const { data, error } = await clientOf().database
      .from('ba_kb').delete().eq('client_id', clientId).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没删掉（可能不是你的知识库）');
  }

  /* ── 云端存档 ── */
  const safeSeg = s => String(s).replace(/[\\:*?"<>|\u0000]/g, '_').replace(/^\/+/, '') || 'file';
  const safeRel = p => String(p).split('/').filter(Boolean).map(safeSeg).join('/');

  async function archiveFiles(taskId, files) {
    if (!uid()) throw new Error('未登录，无法存到云端');
    const out = [];
    for (const f of files) {
      const rel = safeRel(f.path);
      if (!rel) continue;
      const p = clientOf().storage.userPath(uid(), `runs/${safeSeg(taskId)}/${rel}`);
      const body = new File([f.text], safeSeg(rel.split('/').pop()), { type: 'text/plain;charset=utf-8' });
      const r = await clientOf().storage.upload(p, body, { contentType: 'text/plain;charset=utf-8', upsert: true });
      if (r && r.error) throw r.error;
      out.push(p);
    }
    return out;
  }

  async function listArchive() {
    if (!uid()) return [];
    const prefix = `users/${uid()}/runs`;
    const r = await clientOf().storage.list(prefix, { limit: 200, offset: 0 });
    if (r && r.error) throw r.error;
    const arr = (r && r.data) || [];
    return arr.map(it => {
      const name = it.name || it.path || '';
      const full = name.startsWith(prefix) ? name : `${prefix}/${name}`;
      return { path: full, name, size: Number(it.metadata && it.metadata.size) || Number(it.size) || 0, at: it.updated_at || it.created_at || '' };
    });
  }

  async function downloadArchive(p) {
    const r = await clientOf().storage.download(p);
    if (r && r.error) throw r.error;
    return (r && r.data) || r;
  }

  /* ── 产出物镜像（真正干活的那一对）──
     键位：users/<uid>/runs/<任务或项目 id>/<工作区相对路径>
     路径可推导 = 不需要额外建表记映射，任务记录里那个文件名本身就是钥匙。
     只收 base64 之外的二进制也行：body 直接给 Blob，contentType 按真实类型传。 */
  function runKey(runId, rel) {
    const seg = String(rel || '').split('/').map(safeSeg)
      .filter(s => s && s !== '.' && s !== '..').join('/');
    return clientOf().storage.userPath(uid(), `runs/${safeSeg(runId)}/${seg}`);
  }

  async function putRunFile(runId, rel, blob, contentType) {
    if (!uid()) throw new Error('未登录，产出不会存到云端');
    /* SDK 文档给的入参是 File；Blob 虽然也是合法 body，但带文件名和 type 更贴近它的正常用法 */
    const nameSeg = String(rel || '').split('/').pop() || 'file';
    const type = contentType || (blob && blob.type) || 'application/octet-stream';
    const body = (typeof File !== 'undefined' && !(blob instanceof File))
      ? new File([blob], safeSeg(nameSeg), { type })
      : blob;
    const r = await clientOf().storage.upload(runKey(runId, rel), body, {
      contentType: type,
      upsert: true
    });
    if (r && r.error) throw r.error;
    return true;
  }

  async function getRunFile(runId, rel) {
    if (!uid()) throw new Error('未登录，读不到云端产出');
    const r = await clientOf().storage.download(runKey(runId, rel));
    if (r && r.error) throw r.error;
    return (r && r.data) || r;
  }

  /* ── 积分：配置 / 钱包 / 流水 / 充值 ──
     真值全部在云表里，前端只读；写只有一个入口——数据库函数：
       ba_signup_bonus()  开号赠送（signup_granted 一把锁，重复调用不会多送）
       ba_spend()         按 token 扣积分（先扣赠送、再扣充值，ref 幂等，不会重复扣）
       ba_recharge_submit() 提交充值单（金额/积分数由服务端按档位算，前端传不了数）
       ba_recharge_review() 管理员审核（函数内校验 ba_admins，非管理员直接抛错）
     ba_credit_wallet / ba_credit_log / ba_recharge_orders 上 authenticated 只剩 SELECT，
     写权限已被 REVOKE —— 所以「自己把余额改成 999999」在数据库层就通不过。 */

  function normalizeConfig(r) {
    const plans = Array.isArray(r.plans) ? r.plans : [];
    const rates = (r.model_rates && typeof r.model_rates === 'object') ? r.model_rates : {};
    return {
      signupPoints: Number(r.signup_points) || 0,
      tokenPerPoint: Number(r.token_per_point) || 1000000,
      modelRates: rates,
      plans: plans
        .filter(p => p && p.id && Number(p.yen) > 0 && Number(p.credits) > 0)
        .map(p => ({ id: String(p.id), yen: Number(p.yen), credits: Number(p.credits) }))
        .sort((a, b) => a.yen - b.yen),
      payWechat: r.pay_wechat || '',
      payAlipay: r.pay_alipay || '',
      payNote: r.pay_note || ''
    };
  }

  async function loadConfig() {
    const { data, error } = await clientOf().database
      .from('ba_config').select('*').eq('id', 1).limit(1);
    if (error) throw error;
    return normalizeConfig((data && data[0]) || {});
  }

  /* 只有管理员能改：policy 是 FOR UPDATE USING (ba_is_admin())，别人改会被 0 行命中 */
  async function saveConfig(patch) {
    const p = { updated_at: new Date().toISOString() };
    if (patch.signupPoints !== undefined) p.signup_points = Math.max(0, Math.round(Number(patch.signupPoints) || 0));
    if (patch.tokenPerPoint !== undefined) p.token_per_point = Math.max(1, Math.round(Number(patch.tokenPerPoint) || 1000000));
    if (patch.modelRates !== undefined) p.model_rates = patch.modelRates || {};
    if (patch.plans !== undefined) p.plans = patch.plans || [];
    if (patch.payWechat !== undefined) p.pay_wechat = patch.payWechat || '';
    if (patch.payAlipay !== undefined) p.pay_alipay = patch.payAlipay || '';
    if (patch.payNote !== undefined) p.pay_note = patch.payNote || '';
    const { data, error } = await clientOf().database
      .from('ba_config').update(p).eq('id', 1).select();
    if (error) throw error;
    if (!data || !data.length) throw new Error('没改成：只有管理员能改积分设置');
    return normalizeConfig(data[0]);
  }

  function walletFromRow(r) {
    const g = Number(r && r.gift_bal) || 0;
    const p = Number(r && r.paid_bal) || 0;
    return {
      gift: g, paid: p, total: g + p,
      /* 账号编号：开号时由 ba_signup_bonus 分配，全局唯一。
         用户ID 是给人看、给管理员输的；账户ID 是这笔钱落在哪本账上。 */
      userNo: (r && r.user_no) || '',
      walletNo: (r && r.wallet_no) || '',
      giftIn: Number(r && r.gift_in) || 0,
      paidIn: Number(r && r.paid_in) || 0,
      giftOut: Number(r && r.gift_out) || 0,
      paidOut: Number(r && r.paid_out) || 0,
      signupGranted: !!(r && r.signup_granted),
      exists: !!r
    };
  }

  async function myWallet() {
    const { data, error } = await clientOf().database
      .from('ba_credit_wallet').select('*').limit(1);
    if (error) throw error;
    return walletFromRow((data && data[0]) || null);
  }

  /* 开号赠送：幂等，重复调用不会重复给。返回 granted=false 表示这号早领过了。 */
  async function claimBonus() {
    const { data, error } = await clientOf().database.rpc('ba_signup_bonus');
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) || {};
  }

  /* 扣费：tokens 由调用方按本轮实际用量传，积分换算在服务端做。
     ref 是幂等键（如 `taskId#r3`），同一个 ref 重复提交只会算一次。 */
  async function spendPoints(tokens, model, ref) {
    const t = Math.max(0, Math.round(Number(tokens) || 0));
    if (!t) return { spent: 0, dup: false };
    const { data, error } = await clientOf().database.rpc('ba_spend', {
      p_tokens: t, p_model: String(model || ''), p_ref: String(ref || '')
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) || { spent: 0 };
  }

  function logFromRow(r) {
    return {
      id: Number(r.id),
      kind: r.kind || 'spend',
      bucket: r.bucket === 'paid' ? 'paid' : 'gift',
      delta: Number(r.delta) || 0,
      balAfter: Number(r.bal_after) || 0,
      tokens: Number(r.tokens) || 0,
      model: r.model || '',
      ref: r.ref || '',
      note: r.note || '',
      at: Date.parse(r.created_at) || Date.now()
    };
  }

  async function listCreditLog(opt) {
    const o = opt || {};
    let q = clientOf().database.from('ba_credit_log').select('*');
    if (o.kind) q = q.eq('kind', o.kind);
    if (o.bucket) q = q.eq('bucket', o.bucket);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(o.limit || 80);
    if (error) throw error;
    return (data || []).map(logFromRow);
  }

  /* 提交充值单：档位 id + 渠道 + 用户从账单里抄来的交易单号。
     金额和积分数由服务端按 config.plans 算，前端传不了数；
     同一个交易单号只能提交一次（表上有唯一索引），这是「假充值」的第一道闸。 */
  async function submitRecharge(o) {
    const { data, error } = await clientOf().database.rpc('ba_recharge_submit', {
      p_plan_id: String((o && o.planId) || ''),
      p_channel: String((o && o.channel) || 'wechat'),
      p_pay_no: String((o && o.payNo) || ''),
      p_note: String((o && o.note) || '')
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) || {};
  }

  function rechargeFromRow(r) {
    return {
      id: Number(r.id),
      ownerId: r.owner_id || '',
      planId: r.plan_id || '',
      credits: Number(r.credits) || 0,
      amountFen: Number(r.amount_fen) || 0,
      channel: r.channel || 'wechat',
      payNo: r.pay_no || '',
      status: r.status || 'pending',
      userNote: r.user_note || '',
      reviewNote: r.review_note || '',
      at: Date.parse(r.created_at) || Date.now(),
      reviewedAt: r.reviewed_at ? Date.parse(r.reviewed_at) : 0
    };
  }

  async function listRecharges(opt) {
    const o = opt || {};
    let q = clientOf().database.from('ba_recharge_orders').select('*');
    if (o.status) q = q.eq('status', o.status);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(o.limit || 60);
    if (error) throw error;
    return (data || []).map(rechargeFromRow);
  }

  async function reviewRecharge(orderId, approve, note) {
    const { data, error } = await clientOf().database.rpc('ba_recharge_review', {
      p_order: Number(orderId), p_approve: !!approve, p_note: String(note || '')
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) || {};
  }

  /* ── 管理员：账号台账 + 充入积分 ──
     两个函数都是 SECURITY DEFINER，函数体里再查一遍 ba_admins——
     所以前端就算被人改了代码，也只能拿到「自己是不是管理员」的结果，拿不到别人的余额。
     对账口径：钱包里的余额（gift_bal+paid_bal）必须等于流水里所有 delta 的和，
     diff ≠ 0 就是有一笔没记账，这一栏就是用来抓这种事的。 */
  async function adminAccounts() {
    const { data, error } = await clientOf().database.rpc('ba_admin_accounts');
    if (error) throw error;
    return (data || []).map(r => ({
      userNo: r.user_no || '',
      walletNo: r.wallet_no || '',
      ownerId: r.owner_id || '',
      gift: Number(r.gift_bal) || 0,
      paid: Number(r.paid_bal) || 0,
      total: (Number(r.gift_bal) || 0) + (Number(r.paid_bal) || 0),
      giftIn: Number(r.gift_in) || 0,
      giftOut: Number(r.gift_out) || 0,
      paidIn: Number(r.paid_in) || 0,
      paidOut: Number(r.paid_out) || 0,
      logSum: Number(r.log_sum) || 0,
      spent: Number(r.spent) || 0,
      diff: Number(r.diff) || 0,
      lastAt: r.last_at ? Date.parse(r.last_at) : 0
    }));
  }

  /* 按用户ID / 账户ID / 内部 uid 充入。金额只认正数，上限由函数挡。 */
  async function adminGrant(o) {
    const { data, error } = await clientOf().database.rpc('ba_admin_grant', {
      p_user: String((o && o.user) || ''),
      p_points: Number((o && o.points) || 0),
      p_note: String((o && o.note) || '')
    });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) || {};
  }

  /* 数据库侧的管理员表：和后端 /api/is-admin 是两条独立的判定，
     一条管「能不能进后台」，一条管「能不能批充值」。 */
  async function isAdminRow() {
    const { data, error } = await clientOf().database.from('ba_admins').select('uid').limit(1);
    if (error) return false;
    return !!(data && data.length);
  }

  window.CLOUD = {
    ready,
    client: clientOf,
    user, uid,
    restoreCallback, getSession, signInWorkBuddy, signInWechat, sendPhoneCode, verifyPhoneCode,
    sendEmailCode, verifyEmailCode, signOut,
    listModels, chatStream, accessToken,
    loadSettings, saveSettings,
    listStaff, addStaff, updateStaff, deleteStaff,
    listTasks, createTask, saveTask, deleteTask,
    pendingAskFromMessages,
    listMeetings, createMeeting, saveMeeting, deleteMeeting,
    listTodos, createTodo, saveTodo, deleteTodo, voidTodos,
    listKb, createKb, deleteKb,
    listStdStaff, addStdStaff, updateStdStaff, deleteStdStaff, adoptStdStaff, listStdMemOf,
    addStdMem, updateStdMem, deleteStdMem,
    archiveFiles, listArchive, downloadArchive,
    putRunFile, getRunFile,
    loadConfig, saveConfig, myWallet, claimBonus, spendPoints,
    listCreditLog, submitRecharge, listRecharges, reviewRecharge, isAdminRow,
    adminAccounts, adminGrant
  };
})();
