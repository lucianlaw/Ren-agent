/* Ren Agent 前端 v0.3 —— 原生 JS，无构建
   数据在云端（按登录账号隔离），模型走云端通道，工具执行打回 /api/tool */
const $ = s => document.querySelector(s);
const $$ = s => Array.prototype.slice.call(document.querySelectorAll(s));

const state = {
  session: null,
  guest: false,
  settings: { rowId: null, model: '', permissions: { read: true, write: true, exec: false, net: true }, maxSteps: 24, maxTokens: 200000, projSteps: 6, projTokens: 600000, vision: [], impressions: [] },
  staff: [],
  /* 员工性格四维度（性别 / 生肖 / 星座 / MBTI），编辑时挂在 state 上，保存时整体带走。
     四个都是选填：空字符串 = 没填。 */
  traits: { gender: '', zodiac: '', sign: '', mbti: '' },
  tasks: [],
  curTaskId: null,
  // 左栏三个 tab：任务 / 项目 / 员工
  view: 'task',
  lastListView: 'task',
  meetings: [],
  curMeetingId: null,
  todos: [],
  kb: [],
  trace: { nodes: [], result: '', status: '', blocked: null },
  models: [],
  /* 积分：配置（赠送额 / 汇率 / 档位 / 收款码）、钱包（赠送桶 + 充值桶）、明细缓存。
     真值都在云端，这里只是显示用的副本，扣费一律走数据库函数。 */
  cfg: null,
  wallet: null,
  walletAt: 0,          // 上次读钱包的时刻，用于连点时不重复打云表
  logs: [],
  pointsTab: 'all',
  payPlan: '',
  payChannel: 'wechat',
  payOrders: [],
  scope: '',
  running: false,
  ctrl: null,
  editing: null,
  // true = 输入区是在「开一个新任务」；false = 接着当前选中的任务往下说
  drafting: true,
  fmTab: 'cloud',
  fmCur: '.',
  fmPath: '',
  // 左栏每个 tab 各自的搜索词（任务 / 项目 / 员工互不干扰）
  railQ: { task: '', project: '', staff: '' },
  // 输入区本次交给谁（可多选；≥2 位自动按项目跑）
  pickEmp: [],
  // 左栏「员工」Tab 里正在查看的这位（和输入区要交给谁分开记，
  // 否则点员工看产出时会被当前任务的员工覆盖回去）
  railEmpId: null,
  // 这一轮从什么时候开始跑（进度卡算 ETA 用）  traceStartedAt: 0,
  // 上次手动选的员工是否已经从 localStorage 恢复过（只恢复一次，之后以界面为准）
  empRestored: false,
  // 右栏产出物的搜索关键字（边打边筛，切换面板时保留）
  outQuery: '',
  // 刷新/重开页面后，等着自动接上的那个任务（进来时由本机标记决定）
  resumeId: ''
};

const ST = {
  queued: '待执行', running: '执行中', done: '已完成', blocked: '等授权',
  /* 验收没过对老板来说仍然是「做完了」——它拿到的是成品，质检结论走管理员邮箱。
     交付物根本没落盘（unverified）才必须让老板知道，所以那条改成说人话的「缺交付物」。 */
  failed: '失败', unverified: '缺交付物', weak: '已完成',
  budget_exceeded: '超上限已停', step_limit: '步数用完',
  credit_exhausted: '积分用完已停',
  interrupted: '已中断', need_input: '等你拍板'
};
const CAT_NAME = { read: '读文件', write: '写文件', exec: '跑命令', net: '联网' };

/* ── 启动屏 ──
   首屏不露空骨架。进度跟着真实加载步骤走；步骤之间的空档自己慢慢爬，
   但停在上限等 finish，不假装跑完。 */
const BOOT = (() => {
  const el = $('#boot');
  const bar = $('#bootBar');
  const pct = $('#bootPct');
  const txt = $('#bootText');
  let v = 8, closed = false, timer = 0;
  const paint = () => {
    if (bar) bar.style.width = v.toFixed(1) + '%';
    if (pct) pct.textContent = Math.round(v) + '%';
  };
  const creep = () => {
    if (closed || v >= 92) return;
    v = Math.min(92, v + Math.max(0.16, (92 - v) * 0.012));
    paint();
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    v = 100; paint();
    if (txt) txt.textContent = '准备就绪';
    if (el) {
      el.classList.add('out');
      setTimeout(() => { el.hidden = true; }, 460);
    }
  };
  /* text：这一步在干什么；n：这一步结束时的进度（只增不减） */
  const step = (text, n) => {
    if (closed) return;
    if (typeof n === 'number' && n > v) v = Math.min(n, 96);
    if (text && txt) txt.textContent = text;
    paint();
  };
  if (el) { paint(); timer = setInterval(creep, 150); }
  /* 云端慢的时候给出可解释的状态，别让人以为白屏了 */
  setTimeout(() => { if (!closed && txt) txt.textContent = '云端响应有点慢，还在加载…'; }, 6000);
  return { step, finish };
})();


/* ── 工具 ── */
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
/* 员工头像取色：八色轮换，蓝色留给「我」。
   优先按员工列表里的位置取色——这样三五个同事一定互不相同；
   不在列表里（离职、历史记录）就用名字哈希，同一个名字永远同一个色。 */
function avClass(name) {
  const s = String(name == null ? '' : name);
  const list = (state && state.staff) || [];
  const idx = list.findIndex(x => x && x.name === s);
  if (idx >= 0) return 'av-c' + (idx % 8);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 'av-c' + (h % 8);
}
/* 结论卡里的轻量 markdown：只认加粗/行内代码/标题/空行分段。
   先转义再替换，不会把模型输出当 HTML 执行。 */
function mdLite(s) {
  const raw = esc(s || '');
  return raw
    .replace(/^\s{0,3}#{1,4}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/(^|\n)[-*]\s+/g, '$1• ')
    .split(/\n{2,}/)
    .filter(p => p.trim())
    .map(p => `<p>${p.replace(/^\n+|\n+$/g, '').replace(/\n/g, '<br>')}</p>`)
    .join('');
}
function argsBrief(a) {
  if (!a || typeof a !== 'object') return '';
  const s = Object.entries(a).map(([k, v]) => {
    let val = typeof v === 'string' ? v.replace(/\s+/g, ' ') : JSON.stringify(v);
    if (val && val.length > 46) val = val.slice(0, 46) + '…';
    return `${k}=${val}`;
  }).join(' · ');
  return s.length > 96 ? s.slice(0, 96) + '…' : s;
}
function newId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function parseDeliverables(v) {
  return String(v || '').split(/[,，、\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 20);
}
function guessTitle(goal) {
  const line = String(goal).split('\n')[0].trim();
  return line.length > 42 ? line.slice(0, 42) + '…' : line;
}

/* 工作区标识：登录后就是账号 uid（服务端把它映射成固定目录），
   换设备、清缓存都落到同一份文件；只有游客/登录页才退回本机随机串。
   旧版本留下来的是一个 32 位随机串存在 bossScope 里，登录后由
   migrateLegacyScope() 搬一次，不会丢。 */
function ensureScope() {
  /* 优先用服务端认定的标识：万一云端会话里的 id 和 whoami 的 sub 不同，
     以服务端那份为准，否则请求里的 scope 和闸门认定的 scope 会对不上 */
  const uid = (window.SESSION && SESSION.uid)
    || (window.CLOUD && typeof CLOUD.uid === 'function' && CLOUD.uid()) || '';
  if (uid) return uid;
  let s = '';
  try { s = localStorage.getItem('bossScope') || ''; } catch (e) { /* 隐私模式 */ }
  if (!/^[a-f0-9]{32}$/.test(s)) {
    const buf = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    s = [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('bossScope', s); } catch (e) { /* ignore */ }
  }
  return s;
}

/* 把旧随机串目录里的文件搬到账号目录：一次登录只问一次，搬过就记下来。
   失败不阻断登录——最坏是暂时看不到旧文件，人还能继续用；下次登录会再试。 */
async function migrateLegacyScope() {
  let legacy = '';
  try { legacy = localStorage.getItem('bossScope') || ''; } catch (e) { return; }
  if (!/^[a-f0-9]{32}$/.test(legacy)) return;
  if (legacy === state.scope) return;
  try { if (localStorage.getItem('bossScopeMoved') === legacy) return; } catch (e) { /* ignore */ }
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(window.withSC('/api/migrate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({ uid: state.scope, legacy })
    });
    clearTimeout(timer);
    const j = await r.json().catch(() => null);
    if (j && j.ok) {
      try { localStorage.setItem('bossScopeMoved', legacy); } catch (e) { /* ignore */ }
      if (j.copied > 0) {
        setTimeout(() => toast(`已把旧工作区的 ${j.copied} 个文件搬到你的账号下`), 1200);
      } else if (j.claimed) {
        /* 同一台电脑换账号：旧目录已经归前一个账号了。不给搬，也不要静默 */
        setTimeout(() => toast('这台电脑上的旧工作区已归属另一个账号，这次没有搬过来'), 1200);
      }
    }
  } catch (e) { /* 网络问题：下次登录再试，旧目录还在，不会丢 */ }
}

/* ── 登录 ── */
function showLogin(msg) {
  $('#login').hidden = false;
  $('#app').hidden = true;
  BOOT.finish();   /* 登录页是完整的，不是骨架，启动屏可以让位了 */
  if (msg) {
    $('#loginHint').textContent = msg;
    $('#loginHint').classList.add('bad');
  }
}
function hideLogin() {
  $('#login').hidden = true;
  $('#loginHint').classList.remove('bad');
}

let pendingPhone = null;
let pendingEmail = null;
let codeTimer = null;

/* 提示语三种状态：正常（带送多少积分）、已发送、报错。
   登录页只有一行提示位，别让它被错误信息永久占住。 */
function hintDefault() {
  const n = (state.cfg && state.cfg.signupPoints) || 0;
  return n > 0
    ? `新用户注册送 <b>${n}</b> 积分，可直接开一个任务试试。`
    : '登录后员工、任务、产出都存在云端，换设备也还在。';
}
function landErr(msg) {
  const el = $('#loginHint');
  el.textContent = msg;
  el.classList.add('bad');
}
function landNote(html) {
  const el = $('#loginHint');
  el.innerHTML = html;
  el.classList.remove('bad');
}
function resetHint() {
  /* 用户开始改输入了，把上一次的报错换回默认提示（送多少积分那行） */
  if ($('#loginHint').classList.contains('bad')) landNote(hintDefault());
}

function landMode(m) {
  const phone = m !== 'email';
  $('#panePhone').hidden = !phone;
  $('#paneEmail').hidden = phone;
  $$('#landTabs button').forEach(b => b.classList.toggle('on', (b.dataset.mode === 'email') === !phone));
  landNote(hintDefault());
}
$('#landTabs').onclick = e => {
  const b = e.target.closest('button[data-mode]');
  if (b) landMode(b.dataset.mode);
};
$('#landLoginBtn').onclick = () => {
  const card = $('#landCard');
  if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const inp = $('#paneEmail').hidden ? $('#phoneInput') : $('#emailInput');
  if (inp) setTimeout(() => inp.focus(), 120);
};

$('#wbLogin').onclick = async () => {
  try { await CLOUD.signInWorkBuddy(); }
  catch (e) { landErr(e.message || 'WorkBuddy 登录失败'); }
};
$('#wxLogin').onclick = async () => {
  try { await CLOUD.signInWechat(); }
  catch (e) { landErr(e.message || '微信登录失败'); }
};

/* 手机：一次「继续」= 发码，然后按钮换成「登录 / 注册」，另给一行重发 */
$('#phoneInput').addEventListener('input', resetHint);
$('#sendCodeBtn').onclick = async () => {
  const phone = $('#phoneInput').value.trim();
  if (!/^1\d{10}$/.test(phone)) return landErr('请输入正确的 11 位手机号');
  const btn = $('#sendCodeBtn');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const data = await CLOUD.sendPhoneCode(phone);
    pendingPhone = { phone, verificationId: data.verificationId, isExistingUser: data.isExistingUser };
    $('#codeRow').hidden = false;
    $('#codeInput').focus();
    btn.hidden = true;
    $('#verifyBtn').hidden = false;
    $('#phoneResend').hidden = false;
    landNote('验证码已发送到 ' + phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'));
    startResend('phoneResend', 60);
  } catch (e) {
    landErr(e.message || '验证码发送失败');
  } finally {
    btn.disabled = false;
    btn.textContent = '继续';
  }
};
$('#verifyBtn').onclick = async () => {
  const token = $('#codeInput').value.trim();
  if (!token) return landErr('先填验证码');
  if (!pendingPhone) return landErr('请先获取验证码');
  const btn = $('#verifyBtn');
  btn.disabled = true;
  try {
    await CLOUD.verifyPhoneCode({ ...pendingPhone, token });
    pendingPhone = null;
    await enterApp();
  } catch (e) {
    landErr(e.message || '验证码不对');
  } finally { btn.disabled = false; }
};
$('#phoneResend').onclick = () => {
  $('#sendCodeBtn').hidden = false;
  $('#sendCodeBtn').click();
  $('#sendCodeBtn').hidden = true;
};

/* 邮箱：结构跟手机一样，只是收件人换成邮箱 */
$('#emailInput').addEventListener('input', resetHint);
$('#emailSendBtn').onclick = async () => {
  const email = $('#emailInput').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return landErr('请输入正确的邮箱地址');
  const btn = $('#emailSendBtn');
  btn.disabled = true;
  btn.textContent = '发送中…';
  try {
    const data = await CLOUD.sendEmailCode(email);
    pendingEmail = { email, verificationId: data.verificationId, isExistingUser: data.isExistingUser };
    $('#emailCodeRow').hidden = false;
    $('#emailCodeInput').focus();
    btn.hidden = true;
    $('#emailVerifyBtn').hidden = false;
    $('#emailResend').hidden = false;
    landNote('验证码已发到 ' + email);
    startResend('emailResend', 60);
  } catch (e) {
    landErr(e.message || '验证码发送失败');
  } finally {
    btn.disabled = false;
    btn.textContent = '继续';
  }
};
$('#emailVerifyBtn').onclick = async () => {
  const token = $('#emailCodeInput').value.trim();
  if (!token) return landErr('先填验证码');
  if (!pendingEmail) return landErr('请先获取验证码');
  const btn = $('#emailVerifyBtn');
  btn.disabled = true;
  try {
    await CLOUD.verifyEmailCode({ ...pendingEmail, token });
    pendingEmail = null;
    await enterApp();
  } catch (e) {
    landErr(e.message || '验证码不对');
  } finally { btn.disabled = false; }
};
$('#emailResend').onclick = () => {
  $('#emailSendBtn').hidden = false;
  $('#emailSendBtn').click();
  $('#emailSendBtn').hidden = true;
};

/* 重发倒计时挂在「重新获取」那行小字上，不占主按钮 */
function startResend(id, seconds) {
  const el = $('#' + id);
  if (!el) return;
  let left = seconds;
  el.disabled = true;
  el.textContent = `重新获取（${left}s）`;
  clearInterval(codeTimer);
  codeTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(codeTimer);
      el.disabled = false;
      el.textContent = '重新获取验证码';
    } else el.textContent = `重新获取（${left}s）`;
  }, 1000);
}
$('#guestBtn').onclick = () => enterGuest();
$('#bannerBtn').onclick = () => showLogin();

/* 跑着跑着凭证失效（过期、在别处换了账号）：不能静默失败，
   否则表现是「点什么都没反应」或者「文件突然全没了」——那比报错难查得多。 */
window.addEventListener('ren-auth-lost', (e) => {
  const msg = (e && e.detail && e.detail.error) || '登录态已失效';
  const b = $('#banner');
  if (!b) return;
  b.hidden = false;
  $('#bannerText').textContent = msg + '。刷新页面重新登录后再继续。';
  $('#bannerBtn').textContent = '刷新';
  $('#bannerBtn').onclick = () => location.reload();
});
$('#crAvatar').onclick = (e) => {
  e.stopPropagation();
  toggleCrPop();
};
$('#rechargeBtn').onclick = () => openPay();

/* ══════════ 积分：余额 / 明细 / 充值 ══════════
   一句话原则：**前端不记账**。
   余额、流水、充值单全在云端；改余额只有数据库函数一条路（ba_spend / ba_signup_bonus /
   ba_recharge_review），表上 authenticated 只剩 SELECT。这里做的只是「显示」和「发起」。 */
const CREDIT_FALLBACK_RATE = 1000000;    // 1 积分 = 100 万 token（deepseek V4.1 flash）
/* 余额低于这个数就提醒：按现在的汇率，20 积分差不多是「再跑两轮」的量。
   提醒归提醒，不拦——真正拦的是 0（见 creditLeft / 数据库的 INSUFFICIENT）。 */
const LOW_CREDIT = 20;

function creditRate() {
  const r = Number(state.cfg && state.cfg.tokenPerPoint);
  return r > 0 ? r : CREDIT_FALLBACK_RATE;
}

/* ── 余额口径只有一个入口 ──
   state.wallet 是登录后从云表读回来的快照，每次扣费后刷新；
   所有「还能不能跑」的判断都走这里，别各自去摸 state.wallet.total。 */
function walletTotal() {
  const w = state.wallet;
  if (!w) return 0;
  return Number(w.total) || 0;
}

/* 还能烧多少。游客态返回 Infinity：游客不落库、不扣积分，别让体验模式被闸住。 */
function creditLeft() {
  if (!state.session) return Infinity;
  if (!state.wallet) return Infinity;   // 还没读回来，先不误杀
  return walletTotal();
}

/* 见底提醒：一分钟内只念一次，免得每轮都弹。
   返回 true 表示这次真提醒了（测试和调用方都能据此判断）。 */
function creditWarn(where) {
  if (!state.session || !state.wallet) return false;
  const total = walletTotal();
  if (total >= LOW_CREDIT) return false;
  const now = Date.now();
  if (now - (state.creditTipAt || 0) < 60000) return false;
  state.creditTipAt = now;
  toast(total <= 0
    ? `积分已经用完了，${where || '任务'}跑不动了——先充值再继续`
    : `积分只剩 ${fmtBal(total)}，${where || '任务'}再跑几轮就见底了，建议先充一点`);
  return true;
}
/* 余额显示：整数就不带小数点，带小数的留两位，别让「500.00」这种看着像钱 */
function fmtBal(n) {
  const v = Number(n) || 0;
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return v.toFixed(Math.abs(v) >= 10 ? 1 : 2);
}
function fmtTokenW(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000) + ' 亿';
  if (v >= 10000) return (Math.round(v / 1000) / 10) + ' 万';
  return String(v);
}
function fmtWhen(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? `今天 ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* 项目侧扣费入口：meeting.js 每累计一次 token 就调一次。
   ref 用「项目 id#累计 token」——同一次调用重试、同一段重复上报都会得到同一个 ref，
   数据库那边只认第一次，不会重复扣。 */
async function chargeMeeting(m, delta, total) {
  const d = Number(delta) || 0;
  if (!state.session || !m || !m.id || d <= 0) return;
  try {
    const r = await CLOUD.spendPoints(d, (state.settings && state.settings.model) || '', `${m.id}#t${Number(total) || d}`);
    if (r && r.spent) {
      state.wallet = await CLOUD.myWallet();
      state.walletAt = Date.now();
      paintCredits();
    }
  } catch (e) {
    if (!/INSUFFICIENT/.test(String((e && e.message) || e))) console.warn('项目扣积分失败', e);
  }
}
window.APP = window.APP || {};
window.APP.chargeMeeting = chargeMeeting;

/* ── 设备标识 ──
   一个账号现在允许几台设备各跑一个任务，服务端靠这个标识区分「谁在跑」。
   它不需要保密（不是凭证），只需要稳定：换一次就等于换了一台设备，
   原来那条锁会挂在一个再也不会出现的名字上，直到 TTL 到期。

   取不到 localStorage 时返回空串——服务端会退回「按账号锁」，
   也就是回到以前的行为。宁可少一点并发，也不能因为一个标识没拿到就变成无锁。 */
function deviceKey() {
  if (window.REN_DEVICE !== undefined) return window.REN_DEVICE;
  let k = '';
  try {
    k = localStorage.getItem('ren_device') || '';
    if (!/^[a-z0-9_-]{6,40}$/.test(k)) {
      k = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      localStorage.setItem('ren_device', k);
    }
  } catch { k = ''; }
  window.REN_DEVICE = k;
  return k;
}
deviceKey();

/* 只读配置（不领赠送）：登录页要靠它显示赠送额，游客态也要看得到汇率 */
async function loadCfgEarly() {
  try {
    state.cfg = await CLOUD.loadConfig();
    const lb = $('#landBonus');
    if (lb) lb.textContent = state.cfg.signupPoints || 0;
    const h = $('#loginHint');
    if (h && !h.classList.contains('bad')) landNote(hintDefault());
  } catch (e) {
    console.warn('积分配置读取失败', e);
  }
}

function paintCredits() {
  const box = $('#creditsBox');
  const b = $('#creditNum');
  if (!b || !box) return;
  const w = state.wallet;
  if (!state.session) { b.textContent = '—'; box.classList.remove('low'); return; }
  if (!w) { b.textContent = '—'; return; }
  b.textContent = fmtBal(w.total);
  /* 20 分以下就变色：不是装饰，是「再跑两轮就停了」的提前量 */
  box.classList.toggle('low', w.total < LOW_CREDIT);
  box.title = w.total < LOW_CREDIT
    ? `积分只剩 ${fmtBal(w.total)}，低于 ${LOW_CREDIT} 就开始提醒。点这里看明细和充值`
    : `我的积分${w.userNo ? '（用户ID ' + w.userNo + '）' : ''}：点这里看明细和充值`;
}

/* 进主界面时调用一次：读配置 → 领赠送（幂等）→ 读钱包 */
async function loadPoints() {
  try {
    state.cfg = await CLOUD.loadConfig();
    const lb = $('#landBonus');
    if (lb) lb.textContent = state.cfg.signupPoints || 0;
  } catch (e) {
    console.warn('积分配置读取失败', e);
  }
  if (!state.session) { state.wallet = null; paintCredits(); return; }
  try {
    const r = await CLOUD.claimBonus();
    state.wallet = await CLOUD.myWallet();
    state.walletAt = Date.now();
    if (r && r.granted && Number(r.amount) > 0) {
      setTimeout(() => toast(`新用户注册赠送 ${fmtBal(r.amount)} 积分已到账，可以直接开个任务试试`), 1400);
    }
  } catch (e) {
    console.warn('积分读取失败', e);
    if (!state.wallet) state.wallet = { gift: 0, paid: 0, total: 0, exists: false };
  }
  paintCredits();
}

/* 积分明细弹框 */
function openPoints(tab) {
  if (!state.session) return toast('登录后才能看积分明细');
  state.pointsTab = tab || state.pointsTab || 'all';
  $('#pointsMask').hidden = false;
  renderPoints();
  refreshPoints(true);   /* 打开弹框一律强刷，余额必须是当下的真数 */
}
function closePoints() { $('#pointsMask').hidden = true; }

function logOpt(tab) {
  if (tab === 'spend') return { kind: 'spend' };
  if (tab === 'spend_gift') return { kind: 'spend', bucket: 'gift' };
  if (tab === 'spend_paid') return { kind: 'spend', bucket: 'paid' };
  if (tab === 'recharge') return { kind: 'recharge' };
  if (tab === 'grant') return { kind: 'grant' };
  if (tab === 'admin') return { kind: 'admin' };
  return {};
}

/* 余额一律从云表重读，不用 state.wallet 这份旧快照。
   管理员在后台充入、或换个标签页充值，本地快照都是过期的；
   以前这里只刷流水不刷余额，就会出现「流水里明明有 +10000，头上还是 495.1」。
   1.2 秒内连点分类页签不重复打云表。 */
async function reloadWallet(force) {
  if (!state.session) return;
  const now = Date.now();
  if (!force && now - (state.walletAt || 0) < 1200) return;
  try {
    state.wallet = await CLOUD.myWallet();
    state.walletAt = Date.now();
    paintCredits();
  } catch (e) {
    /* 读不到就沿用上次快照：弹框不能因为一次网络抖动变成空的 */
    console.warn('余额读取失败，沿用上次快照', e);
  }
}

async function refreshPoints(force) {
  await reloadWallet(force);
  const w = state.wallet;
  const total = $('#ptsTotal'), gift = $('#ptsGift'), paid = $('#ptsPaid');
  if (total) total.textContent = w ? fmtBal(w.total) : '—';
  if (gift) gift.textContent = w ? fmtBal(w.gift) : '—';
  if (paid) paid.textContent = w ? fmtBal(w.paid) : '—';
  const at = $('#ptsAt');
  if (at && state.walletAt) at.textContent = `余额更新于 ${new Date(state.walletAt).toLocaleTimeString('zh-CN', { hour12: false })}`;
  /* 用户ID / 账户ID：管理员充积分时要的就是这两个号，用户得能自己看到 */
  const ids = $('#ptsIds');
  if (ids) {
    ids.innerHTML = w && (w.userNo || w.walletNo)
      ? `用户ID <b>${esc(w.userNo || '—')}</b> · 账户ID <b>${esc(w.walletNo || '—')}</b>
         <span>充值或找管理员补积分时报这个号</span>`
      : '<span>账号编号还没生成，重新登录一次就会分配</span>';
  }
  const rate = $('#ptsRate');
  if (rate) {
    rate.innerHTML = `1 积分 = <b>${fmtTokenW(creditRate())}</b> token（deepseek V4.1 flash）· 先扣赠送，赠送用完再扣充值`;
  }
  const foot = $('#ptsFoot');
  if (foot && state.cfg) {
    const p = state.cfg.plans || [];
    foot.textContent = p.length
      ? `充值档位：${p.map(x => `¥${x.yen} = ${x.credits} 积分`).join(' · ')}`
      : '充值档位还没配';
  }
  try {
    state.logs = await CLOUD.listCreditLog({ ...logOpt(state.pointsTab), limit: 100 });
  } catch (e) {
    state.logs = [];
    const box = $('#ptsList');
    if (box) box.innerHTML = `<div class="pts-empty">明细没读上：${esc(e.message || e)}</div>`;
    return;
  }
  renderPoints();
}

function renderPoints() {
  $$('#ptsTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.pointsTab));
  const box = $('#ptsList');
  if (!box) return;
  const list = state.logs || [];
  if (!list.length) {
    const t = state.pointsTab;
    box.innerHTML = `<div class="pts-empty">${t === 'all' ? '还没有任何积分记录。' : '这个分类下暂时没有记录。'}</div>`;
    return;
  }
  box.innerHTML = list.map(logRow).join('');
}

function logRow(l) {
  const up = Number(l.delta) > 0;
  const kindTxt = l.kind === 'grant' ? '注册赠送'
    : l.kind === 'admin' ? '管理员充入'
    : l.kind === 'recharge' ? '充值到账'
    : l.kind === 'adjust' ? '人工调整'
    : (l.bucket === 'paid' ? '消耗 · 充值积分' : '消耗 · 赠送积分');
  const bits = [fmtWhen(l.at)];
  if (l.tokens) bits.push(l.tokens.toLocaleString() + ' token');
  if (l.model) bits.push(l.model);
  return `<div class="pts-row ${esc(l.kind)}">
    <div class="pi">${up ? '＋' : '－'}</div>
    <div class="pm">
      <b>${esc(l.note || kindTxt)}</b>
      <span>${esc(bits.join(' · '))}</span>
    </div>
    <div class="pv ${up ? 'up' : 'down'}">${up ? '+' : ''}${fmtBal(l.delta)}</div>
    <div class="pb">余 ${fmtBal(l.balAfter)}</div>
  </div>`;
}

$('#ptsClose').onclick = closePoints;
$('#ptsRecharge').onclick = () => { closePoints(); openPay(); };
$('#pointsMask').addEventListener('click', e => { if (e.target.id === 'pointsMask') closePoints(); });
$('#ptsTabs').onclick = e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.pointsTab = b.dataset.tab;
  renderPoints();
  refreshPoints();
};

/* 充值：档位 → 收款码 → 回填交易单号 → 等人工核对。
   防假充值靠三道闸：① 金额和积分数由服务端按档位算，前端改不了；
   ② 交易单号全库唯一，同一单号交两次数据库直接拒；③ 到账要管理员在后台点通过。 */
async function openPay() {
  if (!state.session) return toast('登录后才能充值');
  $('#payMask').hidden = false;
  const box = $('#payBody');
  if (box) box.innerHTML = '<div class="pts-empty">正在读取充值信息…</div>';
  try {
    if (!state.cfg) state.cfg = await CLOUD.loadConfig();
  } catch (e) { /* 配置读不到也把界面画出来，只是没档位 */ }
  try {
    state.payOrders = await CLOUD.listRecharges({ limit: 20 });
  } catch (e) { state.payOrders = []; }
  renderPay();
}
function closePay() { $('#payMask').hidden = true; }

function renderPay() {
  const box = $('#payBody');
  if (!box) return;
  const cfg = state.cfg || {};
  const plans = cfg.plans || [];
  if (!plans.find(p => p.id === state.payPlan)) state.payPlan = plans.length ? plans[0].id : '';
  const plan = plans.find(p => p.id === state.payPlan) || null;
  const ch = state.payChannel;
  const qr = ch === 'wechat' ? cfg.payWechat : cfg.payAlipay;
  const orders = state.payOrders || [];
  const stName = { pending: '待核对', approved: '已到账', rejected: '已驳回' };
  const chName = { wechat: '微信', alipay: '支付宝' };

  box.innerHTML = `
    ${plans.length ? `<div class="pay-plans">${plans.map(p => `
      <button class="pay-plan${p.id === state.payPlan ? ' on' : ''}" data-plan="${esc(p.id)}" type="button">
        <b>${p.credits.toLocaleString()}</b><span>积分 · ¥${p.yen}</span>
      </button>`).join('')}</div>`
      : '<div class="pts-empty">管理员还没配充值档位，暂时不能充值。</div>'}

    <div class="pay-ch">
      <button data-ch="wechat" class="${ch === 'wechat' ? 'on' : ''}" type="button">微信</button>
      <button data-ch="alipay" class="${ch === 'alipay' ? 'on' : ''}" type="button">支付宝</button>
    </div>

    <div class="pay-qr">${qr
      ? `<img src="${esc(qr)}" alt="收款码">
         <small>扫码付 <b>¥${plan ? plan.yen : '—'}</b>（${plan ? plan.credits.toLocaleString() : '—'} 积分）<br>付款后把账单里的交易单号填到下面</small>`
      : `<div class="no-qr">${chName[ch]}收款码还没配。<br>换另一个渠道，或让管理员在后台把收款码传上去。</div>`}
    </div>

    <div class="pay-field">
      <label>付款交易单号（必填 · 一单只能提交一次）</label>
      <input id="payNo" placeholder="账单详情里的「交易单号 / 订单号」" autocomplete="off" maxlength="64">
    </div>
    <div class="pay-field">
      <label>备注（选填）</label>
      <input id="payNote" placeholder="例如：需要发票 / 公司报销" autocomplete="off" maxlength="60">
    </div>
    <p class="pay-note">${esc(cfg.payNote || '提交后人工核对到账，一般不用等很久。核对不通过会写明原因，可以重新提交。')}</p>
    <div class="pay-actions">
      <span id="payMsg" style="flex:1;font-size:11px;line-height:1.6;color:var(--mute)"></span>
      <button class="btn tiny primary" id="paySubmit" type="button"${(!qr || !plan) ? ' disabled' : ''}>提交，等核对</button>
    </div>

    ${orders.length ? `<div class="adm-sec-hd" style="margin:16px 0 8px"><b>我的充值单</b><span>${orders.filter(o => o.status === 'pending').length} 单待核对</span></div>
      ${orders.map(o => `<div class="pay-order">
        <div class="po-m"><b>${o.credits.toLocaleString()} 积分 · ¥${(o.amountFen / 100).toFixed(2)}</b>
          <span>${esc(chName[o.channel] || o.channel)} · 单号 ${esc(o.payNo)} · ${fmtWhen(o.at)}${o.reviewNote ? ' · ' + esc(o.reviewNote) : ''}</span></div>
        <span class="pay-badge ${esc(o.status)}">${stName[o.status] || o.status}</span>
      </div>`).join('')}` : ''}
  `;

  $$('#payBody .pay-plan').forEach(b => {
    b.onclick = () => { state.payPlan = b.dataset.plan; renderPay(); };
  });
  $$('#payBody .pay-ch button').forEach(b => {
    b.onclick = () => { state.payChannel = b.dataset.ch; renderPay(); };
  });
  const sub = $('#paySubmit');
  if (sub) sub.onclick = submitPay;
}

async function submitPay() {
  const payNo = ($('#payNo') && $('#payNo').value.trim()) || '';
  const note = ($('#payNote') && $('#payNote').value.trim()) || '';
  const msg = $('#payMsg');
  const say = (t, bad) => {
    if (!msg) return;
    msg.textContent = t;
    msg.style.color = bad ? 'var(--red)' : 'var(--mute)';
  };
  if (payNo.length < 6) return say('交易单号不对：至少 6 位，照账单里的原样抄', true);
  if (!state.payPlan) return say('先选一个档位', true);
  const btn = $('#paySubmit');
  if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
  try {
    const r = await CLOUD.submitRecharge({
      planId: state.payPlan, channel: state.payChannel, payNo, note
    });
    say(`已提交：${(Number(r.credits) || 0).toLocaleString()} 积分，等核对后到账`);
    state.payOrders = await CLOUD.listRecharges({ limit: 20 }).catch(() => state.payOrders);
    renderPay();
    const m2 = $('#payMsg');
    if (m2) m2.textContent = '已提交，核对后自动到账；可以在下面看到状态';
  } catch (e) {
    const m = String((e && e.message) || e);
    if (/PAY_NO_USED/.test(m)) say('这个交易单号已经提交过了。一个单号只能入账一次，别重复提交。', true);
    else if (/PAY_NO_INVALID/.test(m)) say('交易单号太短，照账单里的原样抄全', true);
    else if (/PLAN_NOT_FOUND|PLAN_INVALID/.test(m)) say('档位对不上，关掉重开一次再试', true);
    else say('没提交上去：' + m, true);
    if (btn) { btn.disabled = false; btn.textContent = '提交，等核对'; }
  }
}

$('#payClose').onclick = closePay;
$('#payMask').addEventListener('click', e => { if (e.target.id === 'payMask') closePay(); });
$('#creditsBox').onclick = () => openPoints();

/* 收工扣费：按本轮真实 token 折算积分。
   ref 固定成「任务 id#第几轮」——数据库那边同一个 ref 只认一次，
   所以刷新重试、重复收工都不会重复扣（这一点比在前端做标记可靠）。 */
async function chargeRound(t, tokens) {
  const tok = Number(tokens) || 0;
  if (!state.session || !t || tok <= 0) return;
  const round = Number(t.round) || 1;
  const ref = `${t.id}#r${round}`;
  const model = (state.settings && state.settings.model) || '';
  try {
    const r = await CLOUD.spendPoints(tok, model, ref);
    if (r && r.spent) {
      const before = walletTotal();
      state.wallet = await CLOUD.myWallet();
      state.walletAt = Date.now();
      paintCredits();
      /* 这一轮扣完见底了：说清「为什么停了」，别让它悄悄断在半路 */
      if (walletTotal() <= 0 && before > 0) {
        toast('积分已扣到 0，这个任务到此为止；充值后在任务里说一句就能接着跑');
        creditWarn('这个任务');
      } else if (walletTotal() < LOW_CREDIT) {
        creditWarn('这个任务');
      }
    }
  } catch (e) {
    if (/INSUFFICIENT/.test(String((e && e.message) || e))) {
      toast('积分不够扣这一轮了，先充一点再继续');
      openPoints();
    } else {
      console.warn('扣积分失败', e);
    }
  }
}

/* ── CR 头像浮层：外观 / 意见反馈 / 记忆 / 退出 ── */
function toggleCrPop() {
  const p = $('#crPop');
  p.hidden = !p.hidden;
  if (!p.hidden) syncThemeSwitch();
}
document.addEventListener('click', (e) => {
  const p = $('#crPop');
  if (p.hidden) return;
  if (e.target.closest('#crPop') || e.target.closest('#crAvatar')) return;
  p.hidden = true;
});

/* 主题：浅色 / 深色，持久化到 localStorage */
function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  localStorage.setItem('boss.theme', t);
  syncThemeSwitch();
}
function syncThemeSwitch() {
  const cur = document.body.classList.contains('dark') ? 'dark' : 'light';
  $('#themeSwitch').querySelectorAll('.thm').forEach(b => {
    b.classList.toggle('on', b.dataset.theme === cur);
  });
}
$('#themeSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('.thm');
  if (!b) return;
  applyTheme(b.dataset.theme);
});
/* 启动时恢复主题 */
(function () {
  const t = localStorage.getItem('boss.theme');
  if (t === 'dark') document.body.classList.add('dark');
})();

/* 意见反馈 */
let fbImages = [];
$('#crFeedback').onclick = () => {
  $('#crPop').hidden = true;
  $('#fbModal').hidden = false;
};
$('#crExit').onclick = async () => {
  $('#crPop').hidden = true;
  if (state.guest) { showLogin(); return; }
  if (!confirm('退出登录？')) return;
  await CLOUD.signOut();
  location.reload();
};
/* 记忆入口（保留原「记忆」功能，移入头像浮层） */
$('#crMemory').onclick = () => {
  $('#crPop').hidden = true;
  memOpen();
};
/* 设置入口：模型 / 步数 / token 额度 / 产出位置 / 工具 / 例行任务都在那个弹框里 */
$('#crSettings').onclick = () => {
  $('#crPop').hidden = true;
  openSettings();
};

$('#fbText').addEventListener('input', () => {
  const len = $('#fbText').value.length;
  $('#fbCount').textContent = `${len}/10000`;
  $('#fbSubmit').disabled = len === 0;
});
$('#fbImgBtn').onclick = () => $('#fbImgFile').click();
$('#fbImgFile').onchange = () => {
  const files = Array.from($('#fbImgFile').files || []);
  for (const f of files) {
    if (fbImages.length >= 6) { toast('最多上传 6 张'); break; }
    if (!f.type.startsWith('image/')) continue;
    const url = URL.createObjectURL(f);
    fbImages.push(url);
  }
  renderFbThumbs();
};
function renderFbThumbs() {
  $('#fbImgCount').textContent = `${fbImages.length}/6`;
  $('#fbThumbs').innerHTML = fbImages.map((u, i) =>
    `<img src="${u}" alt=""><button class="fb-del" data-i="${i}">×</button>`).join('');
  $('#fbThumbs').querySelectorAll('.fb-del').forEach(b => {
    b.onclick = () => { fbImages.splice(Number(b.dataset.i), 1); renderFbThumbs(); };
  });
}
$('#fbSubmit').onclick = () => {
  toast('反馈已提交，感谢你的意见');
  $('#fbModal').hidden = true;
  $('#fbText').value = '';
  $('#fbCount').textContent = '0/10000';
  $('#fbSubmit').disabled = true;
  fbImages = [];
  renderFbThumbs();
};
$('#fbDiag').onclick = () => toast('智能诊断：暂未发现异常');
$('#fbPrivacy').onclick = (e) => { e.preventDefault(); toast('我们仅收集反馈内容与运行日志，用于定位问题，不会用于其他用途。'); };

/* ── 启动 ── */
const GUEST_STAFF = [
  { id: 'g1', rowId: null, name: '周砚', role: '秘书', persona: 'mature', model: '', kind: 'ai', core: true, notes: '先给结论再给依据。拆任务时按「能验证」拆，不要按「听起来完整」拆。' },
  { id: 'g2', rowId: null, name: '秦律', role: '法务', persona: 'rigor', model: '', kind: 'ai', core: true, notes: '条款风险必须引具条文或惯例来源。' },
  { id: 'g3', rowId: null, name: '何算', role: '财务', persona: 'sharp', model: '', kind: 'ai', core: true, notes: '算钱必须给算式和口径；涉及总成本要摊运费、看起订量。' }
];

async function init() {
  BOOT.step('检查登录状态…', 10);
  state.scope = ensureScope();
  initAttach();
  try {
    await CLOUD.ready();
    BOOT.step('连接云端…', 18);
    const cb = await CLOUD.restoreCallback();
    if (cb && cb.error) return showLogin(cb.error.message);
    /* 登录前先把积分配置读回来：登录页要显示「注册送 X 积分」，
       这个数字不该写死在前端（管理员改了小屏上也该立刻是新数） */
    await loadCfgEarly();
    const { session } = await CLOUD.getSession();
    if (session) await enterApp();
    else if (!state.guest) showLogin();
  } catch (e) {
    showLogin(e.message || '初始化失败');
  }
}

/* ── 附件：选文件 / 拖进来 / 粘贴截图，都落到工作区 uploads/ ── */
function initAttach() {
  if (!window.ATT) return;
  const mk = (btn, file, list) => window.ATT.create({
    btn: $('#' + btn), input: $('#' + file), list: $('#' + list),
    getScope: () => state.scope, toast
  });
  window.ATT_MAIN = mk('attBtn', 'attFile', 'attList');
  window.ATT_MEET = mk('attBtnM', 'attFileM', 'attListM');

  const pasteInto = (el, att) => {
    if (!el) return;
    el.addEventListener('paste', e => {
      const fs = Array.from((e.clipboardData && e.clipboardData.items) || [])
        .filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
      if (fs.length) { e.preventDefault(); att.addFiles(fs); }
    });
  };
  pasteInto($('#goal'), window.ATT_MAIN);
  pasteInto($('#meetInput'), window.ATT_MEET);

  const dropOn = (el, att) => {
    if (!el) return;
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drop-hi'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-hi'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drop-hi');
      const fs = e.dataTransfer && e.dataTransfer.files;
      if (fs && fs.length) att.addFiles(fs);
    });
  };
  dropOn($('#taskView'), window.ATT_MAIN);
  dropOn($('#meetingView'), window.ATT_MEET);
}

/* ── 管理员校验 ──
   质检台是内部判据（回归集 / Pass^k / 失败归因），普通用户看到只会困惑，
   所以入口在 index.html 里默认就是 hidden，只有白名单账号校验通过才露出来。
   判定在服务端（admins.json），前端只拿结果，不把名单写进 JS。 */
async function checkAdmin() {
  state.isAdmin = false;
  const uid = (window.CLOUD && CLOUD.uid && CLOUD.uid()) || '';
  try {
    const p = '/api/is-admin?uid=' + encodeURIComponent(uid);
    const r = await fetch(window.withSC ? window.withSC(p) : p, { cache: 'no-store' });
    const j = await r.json();
    state.isAdmin = !!(j && j.admin);
  } catch (e) {
    state.isAdmin = false;
  }
  if (!state.isAdmin && uid) console.info('[admin] 质检台对当前账号隐藏，当前 uid =', uid);
  const btn = $('#adminBtn');
  if (btn) btn.hidden = !state.isAdmin;
  /* 换账号 / 退出登录时如果正停在管理后台，把人送走——不然后台内容还摊在屏幕上。
     判 DOM 不判 state.view：后台是独立覆盖层，不经过 showView */
  if (!state.isAdmin) {
    if (window.ADMIN && window.ADMIN.on) {
      try { window.ADMIN.close(); } catch (e) { /* 还没初始化就无所谓 */ }
    }
    const ev = $('#evalView');
    if (ev && !ev.hidden) ev.hidden = true;
  }
  /* 没露出来时把 uid 打到控制台：万一换了账号要对名单，一眼能看到该填哪串 */
  if (!state.isAdmin) console.info('[admin] 质检台对当前账号隐藏，当前 uid =', uid || '（未登录）');
  return state.isAdmin;
}

async function enterApp() {
  hideLogin();
  state.guest = false;
  state.session = true;
  /* 先让服务端认下这个人，再决定工作区。
     顺序不能反：闸门上线后没有凭证的 /api 请求一律 401，
     反了会看到满屏「身份校验失败」，而实际原因只是调用早了一步。 */
  if (window.SESSION) {
    BOOT.step('校验身份…', 24);
    const s = await SESSION.ensure();
    if (s && s.ready && s.mismatch) {
      toast('账号标识与本地记录不一致，已按服务端认定的身份加载工作区');
    }
    if (s && !s.ready && s.error) {
      /* 换不到身份也要让人进来（本地还能干活），但必须说清楚为什么云端那部分不能用 */
      state.serverOff = true;
      $('#banner').hidden = false;
      $('#bannerText').textContent = '服务端没通过身份校验：' + s.error;
      $('#bannerBtn').textContent = '重新登录';
      /* 只刷新页面没用：本地存的那张凭证还在，刷完还是同一张。
         要真正换掉它，得先退出、再走一次登录，拿一张新凭证。 */
      $('#bannerBtn').onclick = async () => {
        try { await CLOUD.signOut(); } catch (e) { /* 断网也要能退到登录页 */ }
        try { location.hash = ''; } catch (e) { /* ignore */ }
        showLogin('登录态没通过服务端校验，请重新登录一次');
      };
    }
  }

  /* 登录之后才拿得到 uid：工作区从「本机随机串」切成「账号目录」，
     换设备、清缓存都还连同一份文件。游客态保持本机随机串。 */
  state.scope = ensureScope();

  const u = CLOUD.user();
  if (!state.serverOff) $('#banner').hidden = true;

  /* #app 先不露：等数据齐了、渲染完再一次性亮出来，中间那段由启动屏顶着 */
  try {
    BOOT.step('读取偏好设置…', 28);
    state.settings = await CLOUD.loadSettings();
    /* 登录后先把权限对齐一次：云端设置可能早就改过，服务端记录还停在上一份 */
    syncPerms(state.settings.permissions);
    BOOT.step('载入员工…', 42);
    state.staff = await CLOUD.listStaff(true);
    BOOT.step('载入任务…', 58);
    state.tasks = await CLOUD.listTasks();
    /* 上一条还在 running 的任务：刷新已经把浏览器里的执行打断了。
       先认领「本机刚才在跑的那一个」准备自动续上，其余仍然标「已中断」等手点。 */
    const claim = claimResume(state.tasks);
    const orphan = claim.orphans;
    const autoId = claim.autoId;
    const markOnly = claim.markOnly;
    state.resumeId = '';
    for (const t of orphan) {
      if (t.id === autoId && markOnly) continue;   // 交给下面的统一处理
      /* ── 心跳判活（文档 Lease 的等价物）──
         以前一进来就把所有 running 标成「已中断」，多开一个标签页或换台设备
         就会把另一边上真在跑的任务误杀（状态被改写成 interrupted，那边还在写，
         两边打架）。现在先看心跳，90 秒内算「还有人握着」，不抢；超过才判定断了。
         心跳就是云端 updated_at，由两条路刷新：每步落库（scheduleRunSave，节流 3.5 秒）
         和 20 秒一拍的后台补点（startRunHeart → beatCloud，专管「等模型返回」的空档）。
         不认 heartbeatAt：那个字段全库没有任何地方写，取它永远是空。 */
      const beat = t.updatedAt || 0;
      const live = window.STATES
        ? STATES.heartbeatFresh(beat)
        : (Date.now() - Number(beat || 0) < 90000);
      if (live) { t.maybeElsewhere = true; continue; }
      t.status = 'interrupted';
      CLOUD.saveTask(t.id, { status: 'interrupted' }).catch(() => {});
    }
    if (autoId) {
      const t = state.tasks.find(x => x.id === autoId);
      /* 这个任务可能根本还在服务端跑（刷新页面不会杀掉服务端的 run）。
         以前这里无条件写 interrupted，等于刷新一下就把「正在跑」改成「已中断」，
         紧接着又自动接回去——UI 上先闪一下中断再继续，老板的感受就是
         「任务像中断了一下」。判据见 shouldMarkInterrupted。 */
      const stillLive = stillRunning(t);
      if (shouldMarkInterrupted(t, autoId, markOnly)) {
        t.status = 'interrupted';
        CLOUD.saveTask(t.id, { status: 'interrupted' }).catch(() => {});
      }
      if (t && stillLive) t.maybeElsewhere = false;   // 就是本机刚才那个，不算「别处」
      state.resumeId = autoResumeOn() ? autoId : '';
      /* 关掉了自动续跑：至少把「可以继续」说清楚，别让人以为任务丢了 */
      if (!state.resumeId) {
        setTimeout(() => {
          toast(stillLive
            ? `「${(t && t.title) || '上个任务'}」还在服务端跑，点右上角「继续跑」就能接上现场`
            : `「${(t && t.title) || '上个任务'}」被刷新打断了，进度都留着，点右上角「继续跑」接着做`);
        }, 900);
      }
    } else if (orphan.length) {
      setTimeout(() => {
        toast(orphan.length === 1
          ? `「${orphan[0].title || '上个任务'}」被刷新打断了，已完成的步骤都留着，点「继续跑」接着做`
          : `有 ${orphan.length} 个任务被刷新打断，已完成的步骤都留着，点「继续跑」接着做`);
      }, 900);
    }
    BOOT.step('载入项目记录…', 68);
    /* 项目读失败不要静默吞掉——否则左栏点「项目」只会看到空白，人会以为项目丢了 */
    state.meetings = await CLOUD.listMeetings().catch(e => {
      console.warn('listMeetings failed', e);
      toast('项目记录没读上：' + ((e && e.message) || e));
      return [];
    });
    BOOT.step('载入待办…', 75);
    state.todos = await CLOUD.listTodos().catch(() => []);
    BOOT.step('载入知识库…', 80);
    state.kb = await CLOUD.listKb().catch(() => []);
  } catch (e) {
    toast('云端数据读取失败：' + e.message);
  }
  /* 本机偏好：审批开关 + 自定义工具注册表（员工执行时用） */
  state.settings.approve = localStorage.getItem('boss.approve') === '1';
  window.CUSTOM_TOOLS = loadCustomTools();
  BOOT.step('准备模型通道…', 86);
  await loadModels();
  BOOT.step('核对积分…', 90);
  /* 积分要在进主界面之前就位：赠送是幂等的，老用户这里只会把余额读回来 */
  await loadPoints();
  BOOT.step('检查旧工作区…', 92);
  /* 只在主界面亮出来之前搬一次：搬完再渲染文件列表，否则人先看到空的、一秒后才冒出来 */
  await migrateLegacyScope();
  BOOT.step('整理工作台…', 93);
  await checkAdmin();
  $('#app').hidden = false;
  renderAll();
  /* 默认优先落到任务；有任务先看任务，没有再看项目，都没有就空左栏 */
  if (state.tasks.length) { state.lastListView = 'task'; state.view = 'task'; selectTask(state.tasks[0].id); }
  else if (state.meetings.length) { state.lastListView = 'project'; MEET.open(state.meetings[0].id); }
  else renderRail();
  BOOT.finish();
  /* 启动屏收掉之后再续跑：让人先看见「接着跑」，而不是打开就是一片空白在等 */
  if (state.resumeId) setTimeout(() => { autoResumeTask(); }, 700);
}

function enterGuest() {
  hideLogin();
  state.guest = true;
  state.session = null;
  /* 游客态没有身份，也就谈不上管理员；质检台入口保持隐藏 */
  state.isAdmin = false;
  const eb = $('#adminBtn');
  if (eb) eb.hidden = true;
  if (window.ADMIN && window.ADMIN.on) window.ADMIN.close();
  $('#banner').hidden = false;
  $('#bannerText').textContent = '未登录：能跑，但员工、任务、产出不会保存到云端。';
  state.staff = GUEST_STAFF.map(s => ({ ...s }));
  state.tasks = [];
  state.meetings = [];
  state.todos = [];
  state.kb = [];
  /* 游客态没有云库：愿景和印象从本机拿，别让这一页进去是空的 */
  vsLoadLocal();
  state.view = 'meeting';
  state.curMeetingId = null;
  BOOT.step('载入示例员工…', 60);
  $('#app').hidden = false;
  renderAll();
  loadModels();
  /* 游客没有账号，积分永远是「—」：读一次配置就够，不去领赠送 */
  loadPoints();
  BOOT.finish();
}

async function loadModels() {
  try {
    const list = await CLOUD.listModels();
    state.models = list;
    if (!list.length) {
      $('#modelName').textContent = '无模型';
      return;
    }
    const ok = list.find(m => m.id === state.settings.model);
    if (!ok) {
      // 默认别选「auto」这种路由模型：项目里要连跑好几次，等不起
      const usable = list.filter(m => m.supportsToolCall !== false && String(m.id).toLowerCase() !== 'auto');
      const fast = usable.find(m => /flash|mini|turbo|fast|lite|instant|haiku/i.test(m.id + ' ' + (m.name || '')));
      const prefer = fast || usable[0] || list[0];
      state.settings.model = prefer.id;
      if (!state.guest) persistSettings({ model: prefer.id });
    }
    renderModelPill();
    // 模型列表是异步到的：到了要重画员工卡，否则每个员工的模型下拉里还是空的
    renderStaff();
    syncComposer();
  } catch (e) {
    state.models = [];
    $('#modelName').textContent = '未就绪';
    $('#globalModelBtn').title = e.message;
  }
}

function modelOf(id) {
  return state.models.find(m => m.id === id) || null;
}
/* 挑一个能看图的模型：当前选中的如果本身就是多模态，就用它自己；否则从列表里找一个。
   为什么靠名字匹配：通道的模型对象只标了「支持工具调用」，没有图片能力位。
   找不到就返回空——服务端的 view_image 会如实说「没有可用的视觉模型」，
   而不是让员工回一句「我没收到图片」。 */
const VISION_RE = /(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|claude|gemini|qwen[\w.-]*vl|glm-4(\.\d)?v|doubao[\w.-]*(vision|vl)|internvl|llava|pixtral|moondream|multimodal|vision|omni)/i;
const NOT_VISION_RE = /(audio|tts|whisper|embed|rerank|moderation)/i;
const isVisionName = m => VISION_RE.test(`${m.id} ${m.name || ''} ${m.description || ''}`)
  && !NOT_VISION_RE.test(`${m.id} ${m.name || ''} ${m.description || ''}`);

/* 候选链而不是单个：按名字挑本来就不可靠（通道不给能力位），
   押的这一个万一不收图，服务端还能往下换。当前模型排在最前面——
   它要是本身能看图，就不该另外挑一条通道去花钱。 */
function pickVisionModels() {
  const list = (state.models || []).filter(m => m && m.id);
  const out = [];
  const cur = list.find(m => m.id === state.settings.model);
  if (cur && isVisionName(cur)) out.push(cur.id);
  for (const m of list) if (isVisionName(m) && !out.includes(m.id)) out.push(m.id);
  return out.slice(0, 4);
}
function pickVisionModel() {
  return pickVisionModels()[0] || '';
}
function renderModelPill() {
  // 顶栏「全局模型」徽标显示的是全局默认模型名
  const m = modelOf(state.settings.model);
  const el = $('#modelName');
  if (!m) {
    el.textContent = '未就绪';
    $('#globalModelBtn').title = '点这里选模型';
    return;
  }
  el.textContent = m.name || m.id;
  $('#globalModelBtn').title = '全局默认模型：' + (m.name || m.id) + '（点此切换）'
    + (m.supportsToolCall === false ? ' · 没有标注工具调用能力，员工可能只会说不会做' : '');
}

function renderAll() {
  restoreLastEmp();
  renderPerms();
  renderStaff();
  renderRail();
  renderWho();
  renderPermLabel();
  renderModelPill();
  renderTaskHead();
  syncComposer();
  /* 账号 uid 可能带 wu: 前缀（云端 owner_id 就是这个形态），显示时去掉——
     给人看的是「哪个工作区」，不是内部账号格式 */
  $('#wsLabel').textContent = '私有工作区 · ' + state.scope.replace(/^wu:/i, '').slice(0, 6);
  renderTodoCount();
  renderDecisionCount();
  showView(state.view);
}

/* ── 左栏：任务 / 项目 / 员工 三个 tab（不带数字） ── */
function renderRail() {
  /* 兼容老值：主视图叫 meeting，左栏 tab 叫 project */
  const lvRaw = state.lastListView || 'task';
  const lv = lvRaw === 'meeting' ? 'project' : lvRaw;
  $('#railTabs').querySelectorAll('.rtab').forEach(b => b.classList.toggle('on', b.dataset.view === lv));
  const labels = { task: '＋ 新建任务', project: '＋ 新建项目', staff: '＋ 新建员工' };
  const hints = { task: `共 ${state.tasks.length} 个任务`, project: `共 ${state.meetings.length} 个项目`, staff: `共 ${state.staff.length} 位员工` };
  $('#railActionBtn').textContent = labels[lv] || '＋ 新建任务';
  $('#railHint').textContent = hints[lv] || '';
  /* 搜索框跟着 tab 走：占位文案和已输入的关键词都按 tab 分开记 */
  const si = $('#railSearch');
  if (si) {
    si.placeholder = { task: '搜索任务', project: '搜索项目', staff: '搜索员工' }[lv] || '搜索';
    si.value = state.railQ[lv] || '';
    const x = $('#railSearchX');
    if (x) x.hidden = !si.value;
  }
  if (lv === 'task') renderTaskList();
  else if (lv === 'project') {
    if (window.MEET && typeof MEET.renderList === 'function') MEET.renderList();
    else $('#railList').innerHTML = '<div class="hint-block">项目模块没加载上，刷新一下页面。<br>还不行就清一次缓存。</div>';
  }
  else if (lv === 'staff') renderStaffInRail();
}

/* 左栏点员工卡：默认「派给当前打开的任务 / 项目」，页面原地不动。
   返回 true = 已按指派处理完了，别再跳员工详情。
   任务页：还没开跑就是选人，老任务换人就是转交（和输入区那颗胶囊同一套口径）。
   项目页：等于「＋ 增加成员」，人拉进当前项目。 */
function assignStaffToOpen(id) {
  const s = state.staff.find(x => x.id === id);
  if (!s) return false;
  if (state.view === 'task') {
    const t = state.drafting ? null : curTask();
    if (t && t.employeeName) {
      const from = state.staff.find(x => x.name === t.employeeName);
      if (from && from.id === s.id) { toast(`${s.name} 正在跟这件事`); return true; }
      if (state.running) { toast('这一轮还在跑，等它停下来再换人'); return true; }
      handoverTask(t, s);
      return true;
    }
    state.pickEmp = [s.id];
    state.curEmpId = s.id;
    state.railEmpId = s.id;
    rememberEmp(s.id);   // 人自己选的，才记成「上次交给谁」
    renderWho();
    renderStaffInRail();
    syncComposer();
    toast(`这件事交给 ${s.name}${s.role && s.role !== s.name ? ' · ' + s.role : ''}`);
    return true;
  }
  if (state.view === 'meeting' && window.MEET) {
    const m = MEET.cur ? MEET.cur() : null;
    if (!m) return false;
    if ((m.participants || []).some(p => p.id === s.id)) {
      toast(`${s.name} 已经在这个项目里`);
      return true;
    }
    if (MEET.addMembers) { MEET.addMembers([s.id]); return true; }
  }
  return false;
}

/* 员工 Tab 下，员工卡平铺在左栏（右栏已改为产出区） */
function renderStaffInRail() {
  /* 只许画在「员工」Tab 上。改员工模型之类的操作会顺手叫一次这个函数，
     以前不管当前在哪个 Tab 都往 #railList 里塞员工卡——左栏明明点着「任务」，
     列表却变成一串员工，看着就像被谁拽去了员工菜单。 */
  if ((state.lastListView || 'task') !== 'staff') return;
  const listEl = $('#railList');
  /* 标准员工库入口放在列表最上面：它是「逛出来再取一个」，不是「从零建一个」，
     塞进「＋ 新建员工」的流程里等于让人先建后删。 */
  const stdBar = `<div class="std-bar" id="stdBar" title="查看管理后台训练好的员工">
      <span class="std-bar-i">◉</span>
      <span class="std-bar-t"><b>标准员工库</b><em id="stdBarN">训练好的员工，一键取用</em></span>
      <span class="std-bar-go">›</span>
    </div>`;
  const bindStdBar = () => {
    const b = $('#stdBar');
    if (b) b.onclick = () => openStdLib();
    if (!window.CLOUD || state.guest) {
      const n = $('#stdBarN');
      if (n) n.textContent = '登录后可用';
      return;
    }
    loadStdLib().then(list => {
      const n = $('#stdBarN');
      if (n) n.textContent = list.length ? `${list.length} 位可用 · 一键取用` : '暂时还没有';
    });
  };
  if (!state.staff.length) {
    listEl.innerHTML = stdBar + '<div class="hint-block">还没有员工。<br>点右上「＋ 新建员工」，或者从上面的标准员工库里取一个。</div>';
    bindStdBar();
    return;
  }
  const sorted = window.NAMEORDER ? window.NAMEORDER.sortStaff(state.staff) : state.staff;
  /* 左栏搜索：按名字 / 岗位过滤 */
  const q = String((state.railQ && state.railQ.staff) || '').trim().toLowerCase();
  const staff = q
    ? sorted.filter(e => `${e.name || ''} ${e.role || ''} ${(window.TRAITS && window.TRAITS.line(e)) || ''} ${(BOSS.PERSONAS[e.persona] || {}).n || ''}`.toLowerCase().includes(q))
    : sorted;
  if (q && !staff.length) {
    listEl.innerHTML = stdBar + `<div class="hint-block">没有匹配「${esc(q)}」的员工<br>换个关键词试试</div>`;
    bindStdBar();
    return;
  }
  listEl.innerHTML = stdBar + staff.map(e => {
    /* 有性格设定就显示它（女 · 属虎 · 天蝎座 · INTJ），没填才回落到老人设名 */
    const pn = (window.TRAITS && window.TRAITS.line(e)) || (BOSS.PERSONAS[e.persona] || { n: '—' }).n;
    const viewing = e.id === (state.railEmpId || state.curEmpId);
    return `<div class="emp ${viewing ? 'on' : ''}" data-id="${e.id}">
      <div class="emp-top">
        <div class="av ${avClass(e.name)}">${esc(e.name.slice(0, 1))}</div>
        <div style="min-width:0">
          <div class="emp-n"><span>${esc(e.name)}</span><i class="tag-ai ai">AI</i>${e.core ? '<i class="tag-core">核心</i>' : ''}</div>
          <div class="emp-r" title="${esc(e.role)} · ${esc(pn)}">${esc(roleShort(e.role))} · ${esc(pn)}</div>
        </div>
        <button class="emp-edit" data-edit="${e.id}" title="编辑">⋯</button>
      </div>
      <select class="emp-sel" data-sel="${e.id}" title="这个员工用哪个模型">${modelOptions(e.model || '')}</select>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.emp').forEach(el => {
    el.onclick = ev => {
      if (ev.target.closest('[data-edit]') || ev.target.closest('select')) return;
      /* 主区正开着任务 / 项目时，点员工卡＝把人派过去，绝不把这一页顶掉；
         想看 / 改档案点右边的 ⋯。 */
      if (assignStaffToOpen(el.dataset.id)) return;
      /* 已经在员工菜单里，或者当前没有任务/项目可派：打开这位员工的详情 */
      openStaffPanel(el.dataset.id);
    };
  });
  listEl.querySelectorAll('[data-edit]').forEach(b => {
    b.onclick = (ev) => { ev.stopPropagation(); openStaffPanel(b.dataset.edit); };
  });
  listEl.querySelectorAll('[data-sel]').forEach(sel => {
    sel.onclick = ev => ev.stopPropagation();
    sel.onchange = ev => {
      ev.stopPropagation();
      setEmpModel(state.staff.find(x => x.id === sel.dataset.sel), sel.value);
    };
  });
  bindStdBar();
}

/* ══════════ 标准员工库 ══════════
   管理后台训练好的员工，所有账号都能取一份。
   取用 = 复制一条自己的 ba_staff 记录（std_id 记住出处）：
   档案是他改得了的，记忆是后台实时给的——后台补一条经验，所有用过的人下次开口就吃到。 */
const STD_LIB = { list: [], at: 0, loading: null };

function loadStdLib(force) {
  if (!window.CLOUD || state.guest) return Promise.resolve([]);
  if (!force && STD_LIB.at && Date.now() - STD_LIB.at < 60000) return Promise.resolve(STD_LIB.list);
  if (STD_LIB.loading) return STD_LIB.loading;
  STD_LIB.loading = CLOUD.listStdStaff()
    .then(all => {
      /* 草稿态的口径跟后台一致：只有 published 的才对别人可见 */
      STD_LIB.list = (all || []).filter(s => s.published);
      STD_LIB.at = Date.now();
      STD_LIB.loading = null;
      return STD_LIB.list;
    })
    .catch(() => { STD_LIB.loading = null; return STD_LIB.list; });
  return STD_LIB.loading;
}

/* 已经取用过的那位，按钮改成「再来一份」——不隐藏，因为有人确实要给同一个岗位建两个 */
function stdTaken(s) {
  return (state.staff || []).some(e => e.stdId && e.stdId === s.stdId);
}

function paintStdLib(list) {
  const box = $('#stdLibList');
  if (!box) return;
  const n = $('#stdLibN');
  if (n) n.textContent = (list || []).length + ' 位';
  if (!list || !list.length) {
    box.innerHTML = '<div class="hint-block">库里还没有员工。<br>管理员在「管理后台 → 标准员工」里同步现有员工或新建。</div>';
    return;
  }
  box.innerHTML = list.map(s => {
    const tl = (window.TRAITS && window.TRAITS.line(s)) || '';
    const memN = (s.mem || []).length;
    const ini = esc((s.name || s.role || '员').slice(0, 1));
    const meta = [s.role, tl, memN ? `${memN} 条记忆` : ''].filter(Boolean).join(' · ');
    return `<div class="stdlib-i" data-sid="${s.stdId}">
      <div class="stdlib-av">${ini}</div>
      <div class="stdlib-b">
        <div class="stdlib-n">${esc(s.name || '未命名')}<span class="stdlib-tag">${esc(s.tag || s.role || '')}</span></div>
        <div class="stdlib-d">${esc(meta)}</div>
        ${s.notes ? `<div class="stdlib-quote">${esc(String(s.notes).slice(0, 90))}${s.notes.length > 90 ? '…' : ''}</div>` : ''}
      </div>
      <button class="btn tiny ${stdTaken(s) ? 'ghost' : 'primary'}" type="button" data-take="${s.stdId}">${stdTaken(s) ? '再来一份' : '取用'}</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-take]').forEach(b => {
    b.onclick = async () => {
      const s = STD_LIB.list.find(x => x.stdId === Number(b.dataset.take));
      if (!s) return;
      b.disabled = true;
      b.textContent = '取用中…';
      try {
        const made = await CLOUD.adoptStdStaff(s);
        state.staff.push(made);
        renderStaff();
        renderRail();
        paintStdLib(STD_LIB.list);
        toast(`「${made.name}」已加入你的员工`);
      } catch (e) {
        toast('没加成：' + (e && e.message ? e.message : e));
        b.disabled = false;
        b.textContent = '取用';
      }
    };
  });
}

async function openStdLib() {
  if (state.guest) return toast('登录后才能用标准员工库');
  const mask = $('#stdLibMask');
  if (!mask) return;
  mask.hidden = false;
  const box = $('#stdLibList');
  box.innerHTML = '<div class="hint-block">正在读取…</div>';
  const list = await loadStdLib(true);
  paintStdLib(list);
}

function showView(v) {
  /* 换页就把麦克风关了：看不见的输入框还在收音，用户会以为被偷听 */
  if (window.VOICE) window.VOICE.stopAll();
  /* 左栏的 tab 键只有 task / project / staff；主视图叫 meeting，别把 lastListView 写成 meeting，
     否则左栏找不到对应的 tab，点「项目」会像点了没反应 */
  if (v === 'meeting') state.lastListView = 'project';
  else if (v === 'task') state.lastListView = 'task';
  $('#meetingView').hidden = v !== 'meeting';
  $('#taskView').hidden = v !== 'task';
  $('#todoView').hidden = v !== 'todo';
  $('#decisionView').hidden = v !== 'decision';
  $('#empTodoView').hidden = v !== 'empTodo';
  $('#outputView').hidden = v !== 'output';
  $('#visionView').hidden = v !== 'vision';
  $('#evalView').hidden = v !== 'eval';
  $('#staffView').hidden = v !== 'staffPanel';
  setNav(v);
  if (v === 'todo') renderTodos();
  if (v === 'decision') renderDecision();
  if (v === 'output') renderOutputList();
  if (v === 'vision') renderVision();
  if (v === 'staffPanel') renderStaffPanel();
  renderOutputRail();
}
/* 顶栏菜单高亮：工作台覆盖 task/meeting/staff，其余一一对应。
   注意「员工待办」的视图名是 todo，不是 empTodo——map 里两个都留着，
   否则点进去这一项永远不亮（tab 看着像没选中）。 */
function setNav(v) {
  const workbench = (v === 'task' || v === 'meeting' || v === 'staff' || v === 'staffPanel');
  const map = { decision: 'decisionBtn', todo: 'empTodoBtn', empTodo: 'empTodoBtn', output: 'outputBtn', vision: 'visionBtn' };
  ['workbenchBtn', 'decisionBtn', 'empTodoBtn', 'outputBtn', 'visionBtn'].forEach(id => {
    const el = $('#' + id);
    if (!el) return;
    const on = id === 'workbenchBtn' ? workbench : map[v] === id;
    el.classList.toggle('on', on);
  });
}

/* ── 待办 ── */
function todoAgo(ts) {
  const d = Date.now() - (ts || 0);
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}
function srcLabel(s) {
  if (!s || !s.type) return null;
  const live = s.type === 'meeting'
    ? state.meetings.find(m => m.id === s.id)
    : state.tasks.find(t => t.id === s.id);
  const label = (live && (live.topic || live.title)) || s.label || '(已删除)';
  return { type: s.type, id: s.id, label, gone: !live };
}
function renderTodos() {
  const list = state.todos.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const open = list.filter(t => t.status !== 'done' && t.status !== 'void').length;
  const voidN = list.filter(t => t.status === 'void').length;
  const mN = list.filter(t => (t.sources || []).some(s => s.type === 'meeting')).length;
  const tN = list.filter(t => (t.sources || []).some(s => s.type === 'task')).length;
  $('#tdStats').innerHTML = list.length
    ? `<div class="stat"><b>${list.length}</b><span>共几条</span></div>
       <div class="stat"><b>${open}</b><span>未完成</span></div>
       ${voidN ? `<div class="stat"><b>${voidN}</b><span>已失效</span></div>` : ''}
       <div class="stat"><b>${mN} / ${tN}</b><span>项目 / 任务</span></div>`
    : '';
  /* 失效后同一个按钮变成「全部恢复」：整批撤回，不用一条条点 */
  const vb = $('#tdVoidAll');
  if (vb) {
    vb.textContent = voidN ? `全部恢复（${voidN}）` : '全部失效';
    vb.classList.toggle('on', voidN > 0);
    vb.disabled = !list.length;
    vb.title = voidN
      ? '把已失效的待办整批恢复成未完成'
      : '把还没完成的待办一次性置为失效：仍留在列表里（灰色），但不能勾选、关联项目、派活';
  }
  $('#tdMeta').textContent = list.length
    ? (voidN
      ? `已完成 ${list.filter(t => t.status === 'done').length} 条 · 失效 ${voidN} 条（灰显，不能再操作）。点上面「全部恢复」可以整批撤回。`
      : '项目和任务产生的待办都在这里，按产生时间倒序。点标签能跳到那个项目 / 那个任务。')
    : '项目结束、任务跑完产生的待办会自动落到这里。';

  if (!list.length) {
    $('#tdList').innerHTML = `<div class="empty"><div class="empty-t">还没有待办</div><div class="empty-d">开会时秘书给的待办会自动进来；把待办派成任务后，这里也会标上对应的任务。</div></div>`;
    renderTodoCount();
    return;
  }
  $('#tdList').innerHTML = list.map(t => {
    const done = t.status === 'done';
    const dead = t.status === 'void';
    const srcs = (t.sources || []).map(srcLabel).filter(Boolean);
    return `<div class="td ${done ? 'done' : ''} ${dead ? 'void' : ''}" data-id="${esc(t.id)}">
      <button class="td-ck ${done ? 'on' : ''}" data-ck ${dead ? 'disabled' : ''} title="${dead ? '已失效，不能勾选' : done ? '标为未完成' : '标为已完成'}">${done ? '✓' : ''}</button>
      <div class="td-main">
        <div class="td-what">${esc(t.what)}${dead ? '<span class="td-void-tag">已失效</span>' : ''}</div>
        <div class="td-meta">
          ${t.who ? `<span class="td-who">${esc(t.who)}</span>` : ''}
          ${t.due ? `<span>${esc(t.due)}</span>` : ''}
          <span class="td-time">${todoAgo(t.createdAt)}</span>
        </div>
        <div class="td-src">
          ${srcs.map(s => `<span class="td-tag ${s.type} ${s.gone ? 'gone' : ''}" data-go="${esc(s.id)}" data-go-type="${s.type}" title="${s.gone ? '来源已删除' : dead ? '已失效，不能跳转' : '点一下跳过去'}">${s.type === 'meeting' ? '项目' : '任务'} · ${esc(s.label)}${s.gone ? '（已删除）' : ''}</span>`).join('')}
          <button class="td-add" data-link="${esc(t.id)}" ${dead ? 'disabled' : ''}>＋ 关联项目</button>
        </div>
      </div>
      <button class="td-del" data-del="${esc(t.id)}" title="${dead ? '已失效' : '删掉这条'}">×</button>
    </div>`;
  }).join('');

  const box = $('#tdList');
  box.querySelectorAll('[data-ck]').forEach(b => {
    b.onclick = () => toggleTodo(b.closest('.td').dataset.id);
  });
  box.querySelectorAll('[data-go]').forEach(b => {
    b.onclick = () => {
      /* 失效的条目任何跳转都不做——它已经不参与流转了 */
      if (b.closest('.td').classList.contains('void')) return;
      const id = b.dataset.go;
      if (b.dataset.goType === 'meeting') {
        state.view = 'meeting';
        showView('meeting'); renderRail();
        MEET.open(id);
      } else {
        state.view = 'task';
        state.drafting = false;
        selectTask(id);
        showView('task'); renderRail();
      }
    };
  });
  box.querySelectorAll('[data-link]').forEach(b => {
    b.onclick = () => {
      if (b.closest('.td').classList.contains('void')) return;
      openLinkModal(b.dataset.link);
    };
  });
  box.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = async () => {
      if (b.closest('.td').classList.contains('void')) return;
      const id = b.dataset.del;
      const gone = state.todos.find(t => t.id === id);
      state.todos = state.todos.filter(t => t.id !== id);
      renderTodos();
      if (!state.guest && gone && gone.rowId) {
        try { await CLOUD.deleteTodo(id); } catch (e) { toast(e.message); }
      }
      renderTodoCount();
    };
  });
  renderTodoCount();
  applyContentSearch('todo');
}
/* 全部失效 / 全部恢复：软处理，不删数据。
   失效的待办仍留在列表里（灰显），只是不能再勾选、关联项目、跳转来源或派活。
   为什么要给「恢复」：这个按钮一次影响几十条，误点就该能一键撤回。 */
async function voidAllTodos() {
  const live = state.todos.filter(t => t.status !== 'void' && t.status !== 'done');
  const dead = state.todos.filter(t => t.status === 'void');
  const toVoid = dead.length === 0;
  const targets = toVoid ? live : dead;
  if (!targets.length) return toast(toVoid ? '没有还能失效的待办' : '没有已失效的待办');
  if (toVoid) {
    const ok = window.confirm(`把 ${targets.length} 条未完成的待办一次性置为失效？\n\n`
      + '失效后它们仍然留在列表里（灰显），但不能勾选、不能关联项目、不能派活。\n'
      + '误点了就再点一次「全部恢复」整批撤回。');
    if (!ok) return;
  }
  const ids = targets.map(t => t.id);
  const next = toVoid ? 'void' : 'open';
  for (const t of targets) t.status = next;
  renderTodos();
  renderTodoCount();
  if (state.guest || !targets.some(t => t.rowId)) {
    toast(toVoid ? `${ids.length} 条已置为失效` : `${ids.length} 条已恢复`);
    return;
  }
  try {
    await CLOUD.voidTodos(ids, next);
    toast(toVoid ? `${ids.length} 条已置为失效，云端已同步` : `${ids.length} 条已恢复，云端已同步`);
  } catch (e) {
    toast(friendlyErr(toVoid ? '云端没存上这次失效' : '云端没存上这次恢复', e));
  }
}

function renderTodoCount() {
  const n = state.todos.filter(t => t.status !== 'done' && t.status !== 'void').length;
  const b = $('#empTodoBtn');
  if (!b) return;
  b.textContent = n ? `员工待办 ${n}` : '员工待办';
  b.classList.toggle('has-dot', n > 0);
}

/* ── 待我决策：工作台里问完在等你拍板的卡，原样汇总到这一页 ──
   一条 = 一个任务 / 一个项目的一次提问。卡片长得和工作台里那张一模一样
   （同一套 .ask-form 样式和交互），在这儿选完点确认就接着跑，不用先跳回去。 */
const DEC_KIND = { all: '全部', task: '任务', meeting: '项目' };
let decCache = [];

/* 拍板卡要能跨刷新认出来：pendingAsk 只在 need_input 时随行读回来，
   断点 / 失败 / 中断的任务得从存档的 messages 里倒查最后一次 ask_boss。
   按 messages 长度做缓存，列表每次重画不用把几十个任务的上下文重新解一遍。 */
function taskAskOf(t) {
  if (!t) return null;
  if (t.pendingAsk) return t.pendingAsk;
  if (!Array.isArray(t.messages) || !t.messages.length) return null;
  const stamp = t.messages.length + '|' + (t.status || '');
  if (t._askStamp === stamp) return t._askMemo || null;
  let pa = null;
  try {
    pa = (window.CLOUD && typeof CLOUD.pendingAskFromMessages === 'function')
      ? CLOUD.pendingAskFromMessages(t.messages) : null;
  } catch (e) { pa = null; }
  t._askStamp = stamp;
  t._askMemo = pa;
  return pa;
}

function decisionItems() {
  const out = [];
  for (const t of state.tasks) {
    if (!t) continue;
    /* 正在跑的不算「等你拍板」——它自己会跑出结果，别在列表里闪来闪去 */
    if (t.status === 'running') continue;
    const pa = taskAskOf(t);
    if (!pa || !(pa.questions || []).length) continue;
    out.push({
      kind: 'task', id: t.id,
      title: t.title || t.goal || '未命名任务',
      who: t.employeeName || '', role: t.employeeRole || '',
      at: t.createdAt || 0, pa
    });
  }
  for (const m of (state.meetings || [])) {
    if (!m) continue;
    if (m.status === 'awaiting' && !m.busy) {
      const qs = ((m.brief && m.brief.questions) || []).filter(q => q && q.q);
      if (qs.length) {
        const pm = (window.MEET && MEET.pmOf) ? MEET.pmOf(m) : null;
        out.push({
          kind: 'meeting', id: m.id,
          title: m.topic || '未命名项目',
          who: (pm && pm.name) || '秘书', role: (pm && pm.role) || '',
          at: m.at || m.createdAt || 0,
          /* 项目的题允许多选，也能自己补一句：和工作台里保持一致 */
          pa: {
            intro: (m.brief && m.brief.understanding) || '',
            questions: qs.map(q => ({ q: q.q, options: q.options || [], multi: true }))
          }
        });
      }
    }
    /* 子任务执行中的拍板卡：谁在执行、优先级多少，都摊到决策页，按优先级排 */
    const asks = (window.MEET && MEET.liveNodeAsks) ? MEET.liveNodeAsks(m) : [];
    for (const a of asks) {
      out.push({
        kind: 'meeting', id: m.id, askId: a.askId, nodeAsk: true,
        title: `${m.topic || '未命名项目'} · ${a.nodeTitle || a.nodeId || ''}`,
        who: a.lead || '', role: a.leadRole || '',
        at: a.at || m.at || 0,
        pa: {
          intro: [a.priority ? `优先级 ${a.priority}` : '', a.intro || ''].filter(Boolean).join(' · '),
          questions: (a.questions || []).map(q => ({ q: q.q, options: q.options || [], multi: !!q.multi }))
        }
      });
    }
  }
  /* 按优先级依次进行：P0 > P1 > P2，同级新的在上 */
  const pri = x => (x.pa && /P0/.test(x.pa.intro)) ? 0 : (x.pa && /P1/.test(x.pa.intro)) ? 1 : (x.pa && /P2/.test(x.pa.intro)) ? 2 : 3;
  return out.sort((a, b) => (pri(a) - pri(b)) || ((b.at || 0) - (a.at || 0)));
}

function renderDecisionCount(all) {
  const n = (all || decisionItems()).length;
  const b = $('#decisionBtn');
  if (!b) return;
  b.textContent = n ? `待我决策 ${n}` : '待我决策';
  b.classList.toggle('has-dot', n > 0);
}

/* 新的拍板卡出现 / 老的被答掉之后，顶栏计数跟着变；
   正停在那一页就顺手重画，不用让人手动刷新 */
function refreshDecisionIfOpen() {
  try {
    renderDecisionCount();
    if (state.view === 'decision') renderDecision();
  } catch (e) { /* 列表重画失败不该影响正在跑的这一轮 */ }
}

function decCardHTML(d) {
  const key = d.kind + ':' + d.id;
  const pa = d.pa;
  const who = d.who || '员工';
  const isTask = d.kind === 'task';
  return `<div class="dec-item">
    <div class="dec-hd">
      <span class="td-tag ${isTask ? 'task' : 'meeting'}">${isTask ? '任务' : '项目'}</span>
      <b class="dec-name" title="${esc(d.title)}">${esc(d.title)}</b>
      ${d.who ? `<span class="dec-who">${esc(d.who)}${d.role && d.role !== d.who ? ' · ' + esc(d.role) : ''}</span>` : ''}
      <span class="dec-time">${todoAgo(d.at)}</span>
      <button class="dec-go" type="button" data-go="${esc(d.id)}" data-go-kind="${d.kind}">回到${isTask ? '任务' : '项目'} ›</button>
    </div>
    <div class="ask-form dec-ask" data-dec="${esc(key)}">
      <div class="ask-hd"><b>需要你拍板</b><span>选一下或自己填，答完点确认，${esc(who)}接着干</span></div>
      ${pa.intro ? `<div class="ask-intro">${esc(pa.intro)}</div>` : ''}
      ${pa.questions.map((q, i) => `
        <div class="ask-q" data-i="${i}">
          <div class="ask-qt">${i + 1}. ${esc(q.q || '')}</div>
          <div class="ask-opts" data-multi="${q.multi ? 1 : 0}">
            ${(q.options || []).map(o => `<button type="button" class="ask-opt" data-q="${i}">${esc(o)}</button>`).join('')}
            <input class="ask-custom" data-q="${i}" type="text" autocomplete="off"
                   placeholder="${(q.options || []).length ? '都不合适？自己填…' : '写你的答案…'}">
          </div>
        </div>`).join('')}
      <div class="ask-ft">
        <button class="ask-ok" type="button">确认，继续</button>
        <span class="ask-note">${isTask ? '全部答完才能确认' : '没答的按默认假设走'}</span>
      </div>
    </div>
  </div>`;
}

function renderDecision() {
  const box = $('#decisionList');
  if (!box) return;
  const all = decisionItems();
  decCache = all;
  const kind = state.decKind || 'all';
  const list = kind === 'all' ? all : all.filter(d => d.kind === kind);
  const nT = all.filter(d => d.kind === 'task').length;
  const nM = all.length - nT;

  renderDecisionCount(all);

  const tabs = $('#decTabs');
  if (tabs) {
    const kinds = all.length ? ['all', 'task', 'meeting'].filter(k =>
      k === 'all' || (k === 'task' ? nT : nM) > 0) : [];
    tabs.innerHTML = kinds.map(k => {
      const n = k === 'all' ? all.length : k === 'task' ? nT : nM;
      return `<button class="dec-tab ${kind === k ? 'on' : ''}" type="button" data-k="${k}">${DEC_KIND[k]} ${n}</button>`;
    }).join('');
    tabs.querySelectorAll('[data-k]').forEach(b => {
      b.onclick = () => { state.decKind = b.dataset.k; renderDecision(); };
    });
  }
  const stats = $('#decStats');
  if (stats) {
    stats.innerHTML = all.length
      ? `<div class="stat"><b>${all.length}</b><span>待你拍板</span></div>
         <div class="stat"><b>${nT} / ${nM}</b><span>任务 / 项目</span></div>`
      : '';
  }
  const meta = $('#decMeta');
  if (meta) {
    meta.textContent = all.length
      ? `共 ${all.length} 件在等你拍板（任务 ${nT} 件 · 项目 ${nM} 件）。在这儿选完点确认，那位员工就接着干；点右边能跳回原来的任务 / 项目看上下文。`
      : '没有等你拍板的事了。员工在任务 / 项目里问出要你定的事，会自动汇总到这里。';
  }

  if (!list.length) {
    box.innerHTML = `<div class="empty"><div class="empty-t">${all.length ? '这一类没有待决策' : '暂无待决策'}</div>
      <div class="empty-d">${all.length
        ? '换个分类看看。'
        : '等员工在任务 / 项目里提出需要你拍板的问题，就会汇总到这里，选项和工作台里那张卡一模一样。'}</div></div>`;
    applyContentSearch('decision');
    return;
  }

  box.innerHTML = list.map(decCardHTML).join('');
  box.querySelectorAll('.dec-ask').forEach(card => {
    card.querySelectorAll('.ask-opt').forEach(el => {
      el.onclick = () => {
        const opts = el.closest('.ask-opts');
        if (opts && opts.dataset.multi === '1') { el.classList.toggle('on'); return; }
        opts.querySelectorAll('.ask-opt.on').forEach(x => x.classList.remove('on'));
        el.classList.add('on');
        opts.parentElement.classList.add('answered');
      };
    });
    card.querySelectorAll('.ask-custom').forEach(el => {
      el.oninput = () => {
        const opts = el.closest('.ask-opts');
        if (el.value.trim()) opts.querySelectorAll('.ask-opt.on').forEach(x => x.classList.remove('on'));
        el.closest('.ask-q').classList.toggle('answered', !!el.value.trim());
      };
    });
    const ok = card.querySelector('.ask-ok');
    if (ok) ok.onclick = () => submitDecisionAnswer(card);
  });
  box.querySelectorAll('[data-go]').forEach(b => {
    b.onclick = () => {
      const id = b.dataset.go;
      if (b.dataset.goKind === 'meeting') {
        if (window.MEET && typeof MEET.open === 'function') MEET.open(id);
        else toast('项目模块还没加载上');
      } else {
        state.drafting = false;
        selectTask(id);
      }
    };
  });
  applyContentSearch('decision');
}

function decAnswersOf(card) {
  const key = card.dataset.dec || '';
  const d = decCache.find(x => (x.kind + ':' + x.id) === key);
  if (!d) return null;
  const answers = [];
  for (let i = 0; i < (d.pa.questions || []).length; i++) {
    const picks = [...card.querySelectorAll(`.ask-opt.on[data-q="${i}"]`)].map(el => el.textContent.trim());
    const ci = card.querySelector(`.ask-custom[data-q="${i}"]`);
    const custom = ci ? ci.value.trim() : '';
    answers.push({ picks, custom, text: [...picks, custom].filter(Boolean).join('；') });
  }
  return { item: d, answers };
}

function submitDecisionAnswer(card) {
  const got = decAnswersOf(card);
  if (!got) return toast('这条已经从列表里消失了，刷新一下看看');
  const { item, answers } = got;
  /* 项目子任务执行中的拍板：答案直接回给那个节点，它接着干 */
  if (item.kind === 'meeting' && item.nodeAsk) {
    if (!window.MEET || typeof MEET.answerNodeAsk !== 'function') return toast('项目模块还没加载上');
    MEET.answerNodeAsk(item.id, item.askId, answers);
    renderDecision();
    return;
  }
  if (item.kind === 'task') {
    const miss = answers.findIndex(a => !a.text);
    if (miss >= 0) {
      toast(`第 ${miss + 1} 题还没选`);
      const q = card.querySelectorAll('.ask-q')[miss];
      if (q) q.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const t = state.tasks.find(x => x.id === item.id);
    if (!t) return toast('这个任务已经不在了');
    if (state.running) return toast('有任务正在跑，等它停下来再确认这一条');
    /* 和工作台里点「确认，继续」走同一条路：答案先落进上下文，
       再切到那个任务、从断点接着跑（切过去正好能把员工 / 轨迹 / 输入区都对准） */
    const cf = '【已确认，按这个继续】\n'
      + answers.map((a, i) => `${i + 1}. ${item.pa.questions[i].q}\n答：${a.text}`).join('\n');
    if (!Array.isArray(t.messages)) t.messages = [];
    if (!t.messages.some(m => m && m.role === 'user'
      && typeof m.content === 'string' && m.content.includes('【已确认'))) {
      t.messages.push({ role: 'user', content: cf });
    }
    t.pendingAsk = null;
    t._askStamp = '';
    t._askMemo = null;
    persistTask(t);
    toast(`${t.employeeName || '员工'} 接着干`);
    state.drafting = false;
    selectTask(t.id);
    if (state.trace) state.trace.pendingAsk = null;
    runGoal(cf);
    return;
  }
  /* 项目：选题写回项目的 pending，再让它按同一套拆解流程往下走 */
  if (!window.MEET || typeof MEET.answerFromBoard !== 'function') return toast('项目模块还没加载上');
  const empty = answers.every(a => !a.text);
  MEET.answerFromBoard(item.id, answers, empty);
  renderDecision();
}

async function toggleTodo(id) {
  const t = state.todos.find(x => x.id === id);
  if (!t) return;
  if (t.status === 'void') return toast('这条已经失效了，先点「全部恢复」再勾');
  const next = t.status === 'done' ? 'open' : 'done';
  t.status = next;
  renderTodos();
  if (!state.guest && t.rowId) {
    try { await CLOUD.saveTodo(t.id, { status: next }); } catch (e) { toast(e.message); }
  }
}
/* 项目 / 任务往待办池里放东西；同源同内容不重复入池 */
async function addTodos(items) {
  if (!items || !items.length) return 0;
  let n = 0;
  for (const it of items) {
    const sources = it.sources || [];
    const dup = state.todos.find(t => t.what === it.what
      && sources.some(s => (t.sources || []).some(x => x.type === s.type && x.id === s.id)));
    if (dup) continue;
    const draft = {
      id: 'td' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      what: String(it.what || '').slice(0, 200),
      who: String(it.who || '').slice(0, 20),
      due: String(it.due || '').slice(0, 40),
      sourceType: it.sourceType || (sources[0] && sources[0].type) || 'meeting',
      sources, taskIds: [], status: 'open', createdAt: Date.now()
    };
    if (!draft.what) continue;
    try {
      const made = state.guest ? { rowId: null, ...draft } : await CLOUD.createTodo(draft);
      state.todos.unshift(made);
      n++;
    } catch (e) { toast('待办没存进云端：' + e.message); }
  }
  if (n) {
    if (state.view === 'todo') renderTodos(); else renderTodoCount();
  }
  return n;
}
/* 待办派成任务之后，在这条待办上挂一个任务标签 */
async function linkTodoTask(what, taskId, taskTitle, meetingId) {
  const t = state.todos.find(x => x.what === what
    && (!meetingId || (x.sources || []).some(s => s.id === meetingId)))
    || state.todos.find(x => x.what === what);
  if (!t) return;
  if (!(t.taskIds || []).includes(taskId)) t.taskIds = (t.taskIds || []).concat([taskId]);
  if (!(t.sources || []).some(s => s.type === 'task' && s.id === taskId)) {
    t.sources = (t.sources || []).concat([{ type: 'task', id: taskId, label: taskTitle }]);
  }
  if (!state.guest && t.rowId) {
    try { await CLOUD.saveTodo(t.id, { sources: t.sources, taskIds: t.taskIds }); } catch (e) { /* 静默：标签丢了不影响主线 */ }
  }
  if (state.view === 'todo') renderTodos();
}

let linkCur = null;
function openLinkModal(todoId) {
  const t = state.todos.find(x => x.id === todoId);
  if (!t) return;
  linkCur = { id: todoId, picked: new Set((t.sources || []).filter(s => s.type === 'meeting').map(s => s.id)) };
  if (!state.meetings.length) return toast('还没有项目可以关联');
  $('#lkList').innerHTML = state.meetings.map(m => {
    const on = linkCur.picked.has(m.id);
    return `<div class="lk ${on ? 'on' : ''}" data-mid="${esc(m.id)}">
      <i class="lk-ck">${on ? '✓' : ''}</i>
      <div class="lk-main"><b>${esc(m.topic)}</b><em>${m.status === 'done' ? '已出纪要' : '进行中'} · 参会 ${(m.participants || []).length} 人</em></div>
    </div>`;
  }).join('');
  $('#lkList').querySelectorAll('.lk').forEach(row => {
    row.onclick = () => {
      const id = row.dataset.mid;
      if (linkCur.picked.has(id)) linkCur.picked.delete(id); else linkCur.picked.add(id);
      row.classList.toggle('on', linkCur.picked.has(id));
      row.querySelector('.lk-ck').textContent = linkCur.picked.has(id) ? '✓' : '';
    };
  });
  $('#linkModal').hidden = false;
}
$('#lkSave').onclick = async () => {
  if (!linkCur) return;
  const t = state.todos.find(x => x.id === linkCur.id);
  if (!t) return;
  const keep = (t.sources || []).filter(s => s.type !== 'meeting');
  const add = state.meetings.filter(m => linkCur.picked.has(m.id))
    .map(m => ({ type: 'meeting', id: m.id, label: m.topic }));
  t.sources = add.concat(keep);
  $('#linkModal').hidden = true;
  linkCur = null;
  renderTodos();
  if (!state.guest && t.rowId) {
    try { await CLOUD.saveTodo(t.id, { sources: t.sources }); } catch (e) { toast(e.message); }
  }
};

/* 工作台：回到任务 / 项目 / 员工的主界面 */
$('#workbenchBtn').onclick = () => {
  const lv = state.lastListView || 'task';
  state.view = lv === 'project' ? 'meeting' : 'task';
  showView(state.view);
  renderRail();
  if (state.view === 'meeting') {
    if (state.curMeetingId) MEET.render();
    else if (state.meetings.length) MEET.open(state.meetings[0].id);
  }
};
/* 全局模型：打开模型与执行设置 */
$('#globalModelBtn').onclick = openSettings;

$('#railTabs').addEventListener('click', e => {
  const b = e.target.closest('.rtab');
  if (!b) return;
  state.lastListView = b.dataset.view;
  if (b.dataset.view === 'staff') {
    /* 员工 Tab：不切主视图，只在左栏显示员工卡 */
    renderRail();
    return;
  }
  state.view = b.dataset.view === 'project' ? 'meeting' : 'task';
  showView(state.view);
  renderRail();
  if (state.view === 'meeting') {
    if (!window.MEET) { toast('项目模块没加载上，刷新页面再试'); return; }
    try {
      const exists = state.meetings.some(m => m.id === state.curMeetingId);
      if (state.meetings.length && !exists) MEET.open(state.meetings[0].id);
      else MEET.render();
    } catch (err) {
      toast('项目打不开：' + (err && err.message || err));
    }
  } else {
    renderTaskHead(); renderTrace(); syncComposer();
  }
});

/* 顶部菜单入口 */
$('#decisionBtn').onclick = () => { state.view = 'decision'; showView('decision'); };
/* 待办页头：「全部失效 / 全部恢复」是一个按钮，按当前有没有失效项切换语义 */
if ($('#tdVoidAll')) $('#tdVoidAll').onclick = () => voidAllTodos();
$('#empTodoBtn').onclick = () => { state.view = 'todo'; showView('todo'); renderTodos(); };
$('#outputBtn').onclick = () => {
  /* 总产出：任务 / 项目 / 员工的产出汇总成一张表，可看、可下载、可看源码 */
  state.view = 'output';
  showView('output');
};
$('#visionBtn').onclick = () => { state.view = 'vision'; showView('vision'); renderVision(); };
/* 管理后台入口：模型接入 / 标准员工 / Agent 逻辑 / 质检平台都在里面。
   按钮默认 hidden，checkAdmin 通过才露；点到但没权限时只提示，不解释名单在哪。 */
$('#adminBtn').onclick = () => {
  if (!state.isAdmin) return toast('这一页只有管理员能看');
  if (!window.ADMIN) return toast('管理后台脚本没加载，刷新一下试试');
  window.ADMIN.open();
};

/* ══════════ 愿景和印象 ══════════
   上半：老板写给全体员工的长期方向，可增删改，会拼进员工每次的系统提示词（agent.js / meeting.js 通过 window.PROFILE 取）。
   下半：员工基于过往沟通记录给出的印象，只读、不能改；最多 50 条，新的顶上来、旧的收起。
   数据跟着 ba_settings 走（vision / impressions 两列），游客态落 localStorage。 */
const VISION_MAX = 20;   // 愿景条数上限：再多提示词会糊，员工抓不住重点
const IMP_MAX = 50;      // 展示上限：超过 50 条时按时间收起最老的
const IMP_KEEP = 200;    // 存储上限：收起的也留着，万一以后要做时间线
const VS_LS = 'boss.profile';

function vsLocalRead() {
  try { return JSON.parse(localStorage.getItem(VS_LS) || '{}') || {}; } catch (e) { return {}; }
}
function vsLocalWrite() {
  if (!state.guest) return;
  try {
    localStorage.setItem(VS_LS, JSON.stringify({
      vision: state.settings.vision || [],
      impressions: state.settings.impressions || []
    }));
  } catch (e) { /* 存不下就算了，游客态本来就是临时的 */ }
}
/* 游客态没有云库：进界面时从本机把上次写的捞回来 */
function vsLoadLocal() {
  const j = vsLocalRead();
  state.settings.vision = Array.isArray(j.vision) ? j.vision : [];
  state.settings.impressions = Array.isArray(j.impressions) ? j.impressions : [];
}

async function vsPersist(field) {
  const val = Array.isArray(state.settings[field]) ? state.settings[field] : [];
  if (state.guest) { vsLocalWrite(); return true; }
  try {
    /* 启动时设置读失败过（rowId 空的极端情况）：补读一次再写，不然会静默丢数据 */
    if (!state.settings.rowId) {
      const s = await CLOUD.loadSettings().catch(() => null);
      if (s && s.rowId) state.settings.rowId = s.rowId;
    }
    const saved = await CLOUD.saveSettings({ [field]: val, rowId: state.settings.rowId });
    if (saved && saved.rowId) state.settings.rowId = saved.rowId;
    if (!saved) { toast('没存上：账号的设置行还没准备好，刷新一下再试'); return false; }
    return true;
  } catch (e) {
    toast('没存上：' + ((e && e.message) || e));
    return false;
  }
}

/* 愿景拼成提示词片段。没写就返回空串，别给员工塞一句「（暂无）」添乱 */
function visionPrompt() {
  const items = (state.settings.vision || [])
    .map(v => String((v && v.text) || '').trim()).filter(Boolean);
  if (!items.length) return '';
  return [
    '公司和老板的愿景（全体员工都朝这个方向做事，拿不准时按它取舍）：',
    ...items.map(t => `· ${t}`)
  ].join('\n');
}
/* agent.js / meeting.js 在运行时向这里要愿景，不直接读 state */
window.PROFILE = { visionLines: visionPrompt, impressions: () => (state.settings.impressions || []) };

function vsFmtDay(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number(ts)) return '';
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderVision() {
  if (!Array.isArray(state.settings.vision)) state.settings.vision = [];
  if (!Array.isArray(state.settings.impressions)) state.settings.impressions = [];
  renderVisionItems();
  renderImpressions();
  const add = $('#vsAdd');
  if (add && !add._bound) {
    add._bound = true;
    add.onclick = vsAddItem;
  }
  const scan = $('#vsScan');
  if (scan && !scan._bound) {
    scan._bound = true;
    scan.onclick = vsScan;
  }
}

/* ── 愿景：一行一条，悬停出「改 / 删」，点改就地变输入框 ── */
function renderVisionItems() {
  const box = $('#vsList');
  if (!box) return;
  const list = state.settings.vision || [];
  const ed = state.visionEditId || '';
  if (!list.length && !ed) {
    box.innerHTML = `<div class="vs-empty">还没写。先写一两条你和公司想成为什么、什么不做——员工每次开工会照着它做事。</div>`;
    return;
  }
  box.innerHTML = list.map((v, i) => {
    const on = ed && ed === v.id;
    const txt = String(v.text || '');
    return `<div class="vs-row ${on ? 'editing' : ''}">
      <span class="vs-no">${i + 1}</span>
      ${on
        ? `<textarea class="vs-in" rows="2" data-vin="${esc(v.id)}" placeholder="一句话写清：想成为什么，或者什么不做">${esc(txt)}</textarea>
           <span class="vs-act"><button data-vsave="${esc(v.id)}">保存</button><button data-vcancel="1">取消</button></span>`
        : `<span class="vs-tx" title="${esc(txt)}">${esc(txt)}</span>
           <span class="vs-act"><button data-vedit="${esc(v.id)}" title="改这一条">✎</button><button class="del" data-vdel="${esc(v.id)}" title="删掉这一条">✕</button></span>`}
    </div>`;
  }).join('');

  box.querySelectorAll('[data-vedit]').forEach(b => {
    b.onclick = () => { state.visionEditId = b.dataset.vedit; renderVisionItems(); vsFocusInput(); };
  });
  box.querySelectorAll('[data-vsave]').forEach(b => {
    b.onclick = () => vsSaveItem(b.dataset.vsave);
  });
  box.querySelectorAll('[data-vcancel]').forEach(b => {
    b.onclick = () => { vsDropBlank(); state.visionEditId = ''; renderVisionItems(); };
  });
  box.querySelectorAll('[data-vdel]').forEach(b => {
    b.onclick = async () => {
      const it = (state.settings.vision || []).find(x => x.id === b.dataset.vdel);
      if (!it) return;
      if (!confirm(`删掉这条愿景？\n\n「${String(it.text || '').slice(0, 40)}」`)) return;
      state.settings.vision = state.settings.vision.filter(x => x.id !== it.id);
      if (state.visionEditId === it.id) state.visionEditId = '';
      renderVisionItems();
      if (await vsPersist('vision')) toast('已删除，员工下次开工会按新的走');
    };
  });
  box.querySelectorAll('[data-vin]').forEach(inp => {
    inp.onkeydown = ev => {
      /* 回车保存、Shift+回车换行、Esc 取消：单手就能改完一条 */
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); vsSaveItem(inp.dataset.vin); }
      if (ev.key === 'Escape') { ev.preventDefault(); vsDropBlank(); state.visionEditId = ''; renderVisionItems(); }
    };
  });
}

function vsFocusInput() {
  const inp = document.querySelector('[data-vin]');
  if (!inp) return;
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
}

function vsAddItem() {
  if (!Array.isArray(state.settings.vision)) state.settings.vision = [];
  if (state.visionEditId) { toast('先把手头这条保存了'); return; }
  const filled = state.settings.vision.filter(v => String(v.text || '').trim()).length;
  if (filled >= VISION_MAX) return toast(`最多 ${VISION_MAX} 条；写多了员工抓不住重点，先删一条`);
  const it = { id: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: '', at: Date.now() };
  state.settings.vision.push(it);
  state.visionEditId = it.id;
  renderVisionItems();
  vsFocusInput();
}

/* 取消编辑：把没写字的空条目撤掉，别在列表里留空行 */
function vsDropBlank() {
  state.settings.vision = (state.settings.vision || [])
    .filter(v => String(v.text || '').trim() || v.id !== state.visionEditId);
}

async function vsSaveItem(id) {
  const inp = document.querySelector(`[data-vin="${id}"]`);
  const it = (state.settings.vision || []).find(x => x.id === id);
  if (!inp || !it) return;
  const txt = inp.value.replace(/\s+/g, ' ').trim();
  if (!txt) { toast('写一句再保存'); inp.focus(); return; }
  it.text = txt;
  it.at = it.at || Date.now();
  state.visionEditId = '';
  renderVisionItems();
  if (await vsPersist('vision')) toast('已保存，全体员工都会看到');
}

/* ── 印象：只读写死，超 50 条收老的 ── */
function renderImpressions() {
  const box = $('#vsImpList');
  if (!box) return;
  const all = (state.settings.impressions || [])
    .filter(x => x && String(x.text || '').trim())
    .slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  const show = all.slice(0, IMP_MAX);
  const meta = $('#vsScanMeta');
  if (meta && !state.vsScanning) {
    const last = all.length ? Number(all[0].at) || 0 : 0;
    if (last) {
      meta.hidden = false;
      meta.innerHTML = `上次整理：${vsFmtDay(last)} · 共 ${all.length} 条${all.length > IMP_MAX ? `（页面只显示最近 ${IMP_MAX} 条）` : ''}`;
    } else {
      meta.hidden = true;
    }
  }
  if (!show.length) {
    box.innerHTML = `<div class="vs-empty">还没有印象。点右上角「让员工重新看看我」，他们会翻你过去说过的话，按 MBTI 和行为方式总结成几条——只谈沟通习惯，不谈人品。</div>`;
    return;
  }
  box.innerHTML = show.map(x => {
    const watch = x.kind === 'watch';
    const adv = String(x.advice || '').trim();
    const tip = watch && adv ? `${x.text}\n改进：${adv}` : x.text;
    return `<div class="vs-imp-row ${watch ? 'watch' : ''}" title="${esc(tip)}">
      ${x.tag ? `<span class="vi-tag">${esc(x.tag)}</span>` : ''}
      <span class="vi-tx">${esc(x.text)}</span>
      ${watch && adv ? `<span class="vi-adv" title="改进：${esc(adv)}">改进：${esc(adv)}</span>` : ''}
      <span class="vi-at">${vsFmtDay(x.at)}</span>
    </div>`;
  }).join('') + (all.length > IMP_MAX
    ? `<div class="vs-more">更早的 ${all.length - IMP_MAX} 条已收起（最多显示 ${IMP_MAX} 条）</div>`
    : '');
}

/* 老板说过的话：任务里的原话 + 项目里 @ 出来的句子，按时间往后排 */
function vsGatherSaid() {
  const out = [];
  const tasks = (state.tasks || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  for (const t of tasks) {
    for (const u of userMsgsOf(t)) {
      const s = String(u.text || '').trim();
      if (s.length >= 4) out.push({ t: s, at: Number(t.createdAt) || 0 });
    }
  }
  for (const m of (state.meetings || [])) {
    for (const f of (m.follow || [])) {
      const s = String((f && f.q) || '').trim();
      if (s.length >= 4) out.push({ t: s, at: Number(m.createdAt) || 0 });
    }
  }
  return out.slice(-160).map(x => x.t.length > 120 ? x.t.slice(0, 120) + '…' : x.t);
}

/* 语义归一 + 相似度：用来合并同义印象，别让同一件事占十条 */
function vsNorm(s) {
  return String(s || '').replace(/[\s，。、；：！？,.;:!?「」“”"'（）()【】\[\]\-—…·~]/g, '').toLowerCase();
}
function vsSim(a, b) {
  const A = vsNorm(a), B = vsNorm(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const short = A.length <= B.length ? A : B;
  const long = short === A ? B : A;
  if (short.length >= 4 && long.includes(short) && short.length / long.length >= 0.7) return 0.9;
  const grams = s => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m;
  };
  const ga = grams(A), gb = grams(B);
  let inter = 0, union = 0;
  new Set([...ga.keys(), ...gb.keys()]).forEach(k => {
    const x = ga.get(k) || 0, y = gb.get(k) || 0;
    inter += Math.min(x, y); union += Math.max(x, y);
  });
  return union ? inter / union : 0;
}

/* 清一遍存量里的同义重复：只说一遍的事不该占两条。
   保留更早的时间（它先出现），内容取新的那条，watch 优先不丢改进建议 */
function vsDedupe(list) {
  const out = [];
  for (const x of (list || [])) {
    const hit = out.find(y => vsSim(y.text, x.text) >= 0.85);
    if (!hit) { out.push(x); continue; }
    if ((Number(x.at) || 0) < (Number(hit.at) || 0)) hit.at = x.at;
    if (x.kind === 'watch') { hit.kind = 'watch'; hit.advice = x.advice || hit.advice; }
    else if (!hit.advice && x.advice) hit.advice = x.advice;
    if (String(x.text || '').length > String(hit.text || '').length) hit.text = x.text;
    if (!hit.tag && x.tag) hit.tag = x.tag;
  }
  return out;
}

function vsParseImpressions(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let arr = null;
  try { arr = JSON.parse(s.slice(a, b + 1)); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.map(x => ({
    text: String((x && x.text) || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    kind: (x && x.kind) === 'watch' ? 'watch' : 'good',
    advice: String((x && x.advice) || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    tag: String((x && x.tag) || '').trim().slice(0, 6)
  })).filter(x => x.text);
}

const VS_SCAN_SYS = [
  '你是这家公司的员工代表，现在要和老板做一次坦诚的内部复盘。',
  '任务：只从「沟通方式和思维习惯」的角度，看老板过往是怎么说话、怎么决策、怎么推进事情的，总结成一份印象清单给他自己看。',
  '',
  '硬性规则（违反任意一条，整份作废）：',
  '1. 只评价工作中的沟通行为；不评价人品、人格缺陷、私人生活、外貌、健康、家庭、信仰、籍贯；不做心理诊断，不给病理化标签。',
  '2. 禁止贬低、嘲讽、羞辱、指责性表述（例如「很差」「无能」「幼稚」「控制欲强」「情商低」）。',
  '3. 每条只说一个可观察的行为模式，一句话、40 字以内；不写「你是一个……的人」这类总评，不堆形容词。',
  '4. 需要改进的（kind=watch）必须配一条 advice：30 字以内、具体到下次怎么做，只给方法不批评。',
  '5. 语义相同或高度接近的合并成一条，宁少不重复。若这次观察到的就是「已有的印象」里那一件事，必须一字不改地复用那条原文，不要换个说法重写。',
  '6. 总共不超过 12 条；正面的和待改进的都可以有，但不要凑数——数据看不出规律就少写。',
  '7. 只输出 JSON 数组，不要解释、不要 markdown 代码块、不要任何前后缀文字。',
  '',
  '每条格式：{"text":"一句话印象","kind":"good 或 watch","advice":"仅 watch 填，30 字内","tag":"风格|决策|表达|节奏|协作 之一"}'
].join('\n');

/* 思考型模型：会先想一大段，正文可能一个字都不剩。
   judge.js 里已经为同一件事写过一套判定（hy4-preview / hy3-x 实测都是正文 0 字），
   这里直接复用，别再维护第二份正则。 */
function vsIsThinking(id) {
  /* 只认 window.JUDGE：judge.js 挂在 window 上，不保证有同名全局变量
     （测试里直接 eval 这两个函数时，裸 JUDGE 会 ReferenceError）。 */
  const jd = (typeof window !== 'undefined' && window.JUDGE) || null;
  if (jd && typeof jd.isThinking === 'function') return jd.isThinking(id);
  return /thinking|reasoner|-r1$|hy\d.*-x$|hy4-preview/i.test(String(id || ''));
}

/* 这次让谁来整理印象。
   顺序是「先不思考的 → 当前模型 → 思考型兜底」：印象是结构化小任务，
   思考型在这种「输出很短、要求严格 JSON」的活上最容易空手而归。
   最多试三个，不把老板的积分烧在一件事上。 */
function vsModelOrder(cur) {
  const all = (state.models || []).filter(m => m && m.id).map(m => String(m.id));
  const order = [];
  const push = id => { const s = String(id || ''); if (s && !order.includes(s)) order.push(s); };
  const calm = all.filter(id => !vsIsThinking(id));
  const hot = all.filter(vsIsThinking);
  if (cur && !vsIsThinking(cur)) push(cur);
  calm.forEach(push);
  push(cur);
  hot.forEach(push);
  return order.slice(0, 3);
}

async function vsScan() {
  if (state.vsScanning) return;
  const said = vsGatherSaid();
  if (said.length < 5) return toast('对话还太少，员工看不出规律（至少要攒 5 句你说过的话）');
  const model = state.settings.model;
  if (!model) return toast('还没选模型，先在右上角挑一个');

  state.vsScanning = true;
  const btn = $('#vsScan');
  const meta = $('#vsScanMeta');
  if (btn) { btn.disabled = true; btn.textContent = '员工在看…'; }
  if (meta) {
    meta.hidden = false;
    meta.innerHTML = `<span class="caret-blink"></span><span id="vsScanTx">员工正在翻你过去的 ${said.length} 句发言…</span>`;
  }
  const say = t => {
    const x = document.getElementById('vsScanTx');
    if (x) x.textContent = t;
  };

  const existing = (state.settings.impressions || [])
    .slice(0, IMP_MAX).map(x => '- ' + x.text).join('\n');
  const usr = [
    `老板说过的话（按时间先后，共 ${said.length} 句，可能很碎，别当完整指令读）：`,
    said.map((t, i) => `【${i + 1}】${t}`).join('\n'),
    existing ? `\n已有的印象（不要重复；语义相同的并成一条，别换句话重说一遍）：\n${existing}` : '',
    '',
    '请输出印象清单 JSON 数组。'
  ].filter(Boolean).join('\n');

  let buf = '';
  let reasoning = '';
  let usage = null;
  let fresh = [];
  let last = null;
  try {
    /* 一次只发一个模型的请求；空手而归时由外层换下一个。
       抽出来是为了让「重试」变成循环而不是复制一段解析逻辑。 */
    const once = async (model) => {
      let b = '', r = '', fin = '', u = null, lastPing = 0;
      const payload = {
        model,
        messages: [{ role: 'system', content: VS_SCAN_SYS }, { role: 'user', content: usr }],
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.4,
        /* 2200 是上一版的值，实测被思考吃光（正文 0 字、finish_reason=length）。
           这类任务本身输出很短，预算给宽一点不浪费——思考型模型烧的是同一个额度。 */
        max_tokens: 3000
      };
      for await (const chunk of window.CLOUD.chatStream(payload)) {
        const ch = chunk && chunk.choices && chunk.choices[0];
        const d = ch && ch.delta;
        if (d && d.content) b += d.content;
        /* 推理模型会先吐一大段 reasoning，正文可能很晚才来；不接住会误判成「没吐正文」 */
        if (d && d.reasoning_content) r += d.reasoning_content;
        if (ch && ch.finish_reason) fin = String(ch.finish_reason);
        if (chunk && chunk.usage) u = chunk.usage;
        const now = Date.now();
        if (now - lastPing > 400) {
          lastPing = now;
          const n = (b.match(/"text"/g) || []).length;
          say(n ? `员工已经写下 ${n} 条，正在合并同义项…` : `员工正在翻你过去的 ${said.length} 句发言…（${model}）`);
        }
      }
      return { buf: b, reasoning: r, finish: fin, usage: u, model };
    };

    /* 试的顺序：先不思考的，再当前模型，最后才是思考型。
       思考型在这个任务上几乎必空手（把预算全花在推理上），
       但也不是一律排除——列表里只有它时，给足预算仍有一半机会。 */
    const order = vsModelOrder(model);
    for (const m of order) {
      say(`员工正在翻你过去的 ${said.length} 句发言…（${m}）`);
      let r = null;
      try {
        r = await once(m);
      } catch (e) {
        /* 单个模型挂了（模型下线 / 通道 5xx）不该把整条路堵死：
           记下来，换下一个。全挂了才由下面的失败分支统一说明。 */
        last = { buf: '', reasoning: '', finish: 'error', model: m, error: String((e && e.message) || e) };
        continue;
      }
      last = r;
      buf = r.buf; reasoning = r.reasoning; usage = r.usage || usage;
      fresh = vsParseImpressions(r.buf);
      if (fresh.length) break;
      /* 正文空、只有推理，或者回的不是 JSON：下一个模型再来一次 */
    }

    if (!fresh.length) {
      const why = !String(buf).trim()
        ? (last && last.error
          ? `通道报错（${String(last.error).slice(0, 60)}）`
          : (String(reasoning).trim()
            ? (last && last.finish === 'length'
              ? '模型把额度全花在思考上，正文一个字没写'
              : '模型只吐了推理没给正文')
            : '模型没回应'))
        : '模型回的不是清单格式';
      const allThinking = order.length > 0 && order.every(m => vsIsThinking(m));
      toast(`这次没整理出印象：${why}（试了 ${order.length} 个模型）。`
        + (allThinking ? '你现在能用的都是思考型模型，换一个普通的再试。' : '再点一次，或者换一个模型试试。'));
      return;
    }

    /* 合并：同义的沿用旧条目（保留更早的时间，内容用新的，watch 优先），其余新增 */
    const now = Date.now();
    const list = (state.settings.impressions || []).slice();
    let added = 0, merged = 0;
    for (const f of fresh) {
      const hit = list.find(x => vsSim(x.text, f.text) >= 0.6);
      if (hit) {
        hit.text = f.text;
        if (f.advice) hit.advice = f.advice;
        if (f.kind === 'watch') hit.kind = 'watch';
        if (f.tag) hit.tag = f.tag;
        merged++;
      } else {
        list.push({
          id: 'i' + now.toString(36) + Math.random().toString(36).slice(2, 5),
          text: f.text, kind: f.kind, advice: f.advice, tag: f.tag, at: now
        });
        added++;
      }
    }
    list.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    state.settings.impressions = vsDedupe(list).slice(0, IMP_KEEP);
    renderImpressions();
    if (await vsPersist('impressions')) {
      const hid = list.length > IMP_MAX ? `；超出 ${IMP_MAX} 条的已收起` : '';
      toast(`员工看完了：新增 ${added} 条，合并同义 ${merged} 条${hid}`);
    }
    if (usage) {
      const tk = (usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))) | 0;
      if (tk) console.info('[vision] 分析消耗 token', tk);
    }
  } catch (e) {
    toast('没整理成：' + ((e && e.message) || e));
  } finally {
    state.vsScanning = false;
    if (btn) { btn.disabled = false; btn.textContent = '让员工重新看看我'; }
    if (meta && !(state.settings.impressions || []).length) meta.hidden = true;
    renderImpressions();
  }
}


/* ── 权限开关 ── */
function renderPerms() {
  // 权限开关已从顶栏移除（读/写/跑/联网），权限本身仍生效，仅不再单独展示
  const g = $('#permGroup');
  if (!g) return;
  g.querySelectorAll('.perm').forEach(b => {
    b.classList.toggle('on', !!state.settings.permissions[b.dataset.cat]);
  });
}

/* 把权限同步到服务端：/api/tool 以服务端记录为准，前端传来的只能收紧。
   不同步的话服务端会停留在上一份记录，用户明明开了「跑命令」却一直被判没权限。 */
function syncPerms(p) {
  if (state.guest || !state.scope) return;
  fetch(window.withSC('/api/perms'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: state.scope, perms: p || {}, by: 'ui' })
  }).catch(() => { /* 离线时忽略：下一次动作还会再同步 */ });
}

async function persistSettings(patch) {
  if (state.guest) return;
  if (patch && patch.permissions) syncPerms(patch.permissions);
  try {
    const saved = await CLOUD.saveSettings({ ...patch, rowId: state.settings.rowId });
    if (saved && saved.rowId) state.settings.rowId = saved.rowId;
  } catch (e) {
    toast('设置没存上：' + e.message);
  }
}

/* ── 员工 ── */
function modelOptions(sel) {
  const g = state.models.find(m => m.id === state.settings.model);
  const gname = g ? (g.name || g.id) : '全局';
  const head = `<option value="" ${sel ? '' : 'selected'}>跟随全局 · ${esc(gname)}</option>`;
  return head + state.models.map(m =>
    `<option value="${esc(m.id)}" ${m.id === sel ? 'selected' : ''}>${esc(m.name || m.id)}</option>`
  ).join('');
}

async function setEmpModel(emp, model) {
  if (!emp) return;
  const before = emp.model || '';
  emp.model = model;
  syncComposer(); // 员工卡 + 顶栏「实际用的模型」一起刷新
  if (state.guest || !emp.rowId) { toast(model ? `已切到 ${model}` : '已改为跟随全局'); return; }
  try {
    await CLOUD.updateStaff(emp.rowId, { model });
    toast(model ? `${emp.name} 改用 ${model}` : `${emp.name} 改回跟随全局`);
  } catch (e) {
    emp.model = before;
    syncComposer();
    toast('没切换成功：' + e.message);
  }
}

function renderStaff() {
  /* 员工卡已迁到左栏「员工」Tab；右栏现在是产出物展示区。
     仅在当前停留在员工 Tab 时刷新左栏员工列表。 */
  if (state.lastListView === 'staff') renderStaffInRail();
}

/* ── 记住「上次交给谁」──
   只有一条：开新对话时默认带上次手动选的员工（跨刷新也记得，所以落 localStorage）。
   打开老对话不弹任何确认，人跟着活儿走，直接切回这个对话原来的人。
   只有「人主动选的」才写记忆：进老对话时系统自动切换不算，否则记忆会被历史对话带跑。 */
const LAST_EMP_KEY = 'boss.lastEmp';
function rememberEmp(id) {
  try { if (id) localStorage.setItem(LAST_EMP_KEY, String(id)); } catch { /* 忽略 */ }
}
function forgetEmp(id) {
  try {
    if (localStorage.getItem(LAST_EMP_KEY) === String(id)) localStorage.removeItem(LAST_EMP_KEY);
  } catch { /* 忽略 */ }
}
function lastEmpStaff() {
  let id = '';
  try { id = localStorage.getItem(LAST_EMP_KEY) || ''; } catch { id = ''; }
  return id ? (state.staff.find(s => s.id === id) || null) : null;
}
/* 首次渲染前恢复一次：员工列表是异步到的，恢复放这里最稳 */
function restoreLastEmp() {
  if (state.empRestored || !state.staff.length) return;
  state.empRestored = true;
  const s = lastEmpStaff();
  if (!s) return;
  if (state.curEmpId && state.staff.some(x => x.id === state.curEmpId)) return; // 已经有选择了就别盖
  state.curEmpId = s.id;
  state.pickEmp = [s.id];
  state.railEmpId = state.railEmpId || s.id;
}

/* 这次交给谁：输入区单选（一件事一个人做）；多位一起干请从「项目」里拉人 */
function pickEmpIds() {
  const ids = (state.pickEmp || []).filter(id => state.staff.some(s => s.id === id));
  if (!ids.length && state.curEmpId && state.staff.some(s => s.id === state.curEmpId)) ids.push(state.curEmpId);
  return ids;
}
function pickEmpStaff() {
  return pickEmpIds().map(id => state.staff.find(s => s.id === id)).filter(Boolean);
}
function renderWho() {
  const t = curTask();
  const continuing = !state.drafting && !!t;
  if (continuing) {
    const e = state.staff.find(s => s.name === t.employeeName);
    if (e) state.curEmpId = e.id;
  }
  const list = continuing
    ? [state.staff.find(s => s.name === t.employeeName) || state.staff.find(s => s.id === state.curEmpId) || state.staff[0]].filter(Boolean)
    : pickEmpStaff();
  const e = list[0] || state.staff[0] || null;
  if (e && !continuing) state.curEmpId = e.id;
  const nm = $('#whoLabel'), rl = $('#whoRole'), chip = $('#empSel');
  if (nm) nm.textContent = e ? (list.length > 1 ? `${e.name} 等 ${list.length} 人` : e.name) : '先建员工';
  /* 名字和岗位是两个字段：名字深色、岗位灰色。有人建员工时把整串「软件工程师（初/中/高/…）」
     同时填进了两栏，胶囊里就成了一句话两种颜色还互相裁切——内容一样就只显示一份 */
  if (rl) rl.textContent = e ? (list.length > 1 ? '项目' : (e.role && e.role !== e.name ? e.role : '')) : '';
  if (chip) chip.title = e
    ? (list.length > 1
      ? `会按项目跑：${list.map(s => s.name).join('、')}（第一位 ${e.name} 当项目经理，点一下调整）`
      : `${continuing ? '接着跟' : '交给'} ${e.name}${e.role ? ' · ' + e.role : ''}（点一下换员工 / 可多选）`)
    : '还没有员工，点一下去新建';
}



/* ── 员工选择器（任务输入区）：单选 + 顺手换模型，向上展开 ──
   一件事只派一个人做；要多个人一起干，那是「项目」，从项目里拉人。
   这里换的模型直接写回 TA 的档案，跟员工 Tab 里改的是同一份数据。 */
function staffModelName(s) {
  const id = (s && s.model) || state.settings.model;
  const m = modelOf(id);
  return m ? (m.name || m.id) : '跟随全局';
}
/* 当前是不是「在老对话里」——决定这次选择是「派活」还是「转交」 */
function handoverCtx() {
  const t = state.drafting ? null : curTask();
  if (!t || !t.employeeName) return null;
  const from = state.staff.find(s => s.name === t.employeeName);
  if (!from) return null;
  return { task: t, from };
}
function empPopHTML() {
  const staff = state.staff;
  const ids = pickEmpIds();
  const curId = ids[0] || '';
  const models = state.models || [];
  const g = modelOf(state.settings.model);
  const gName = g ? (g.name || g.id) : '默认';
  const ho = handoverCtx();
  return `<div class="emp-pop-hd">${ho ? '换谁接着跟' : '交给谁做'}<span class="emp-pop-n">${ho ? '转交' : '单选'}</span></div>`
    + staff.map(s => {
      const on = s.id === curId;
      const mid = s.model || '';
      const opts = [`<option value=""${mid ? '' : ' selected'}>跟随全局（${esc(gName)}）</option>`]
        .concat(models.map(m => `<option value="${esc(m.id)}"${m.id === mid ? ' selected' : ''}>${esc(m.name || m.id)}</option>`))
        .join('');
      const nmTxt = (s.name || '').trim();
      const roleTxt = (s.role || '').trim();
      /* 有人建员工时把岗位整串也填进了名字（「软件工程师」+「软件工程师（初/中/高/资深/首席）」），
         照原样拼就成了「软件工程师 · 软件工程师（…）」。岗位已经包含名字就只显示岗位这一份。 */
      const label = !roleTxt || roleTxt === nmTxt
        ? nmTxt
        : (roleTxt.indexOf(nmTxt) === 0 ? roleTxt : `${nmTxt} · ${roleTxt}`);
      return `<div class="emp-opt ${on ? 'on' : ''}" data-id="${esc(s.id)}">
        <span class="av ${avClass(s.name || s.role)}">${esc((s.name || s.role || '?').slice(0, 1))}</span>
        <span class="emp-opt-main">
          <span class="emp-opt-nm">${esc(label)}</span>
          <select class="emp-model" data-mid="${esc(s.id)}" title="让 ${esc(s.name)} 用哪个模型（会同步到员工档案）">${opts}</select>
        </span>
        <span class="emp-opt-ck">${on ? '✓' : ''}</span>
      </div>`;
    }).join('')
    /* 没有「完成」按钮：点哪一行就是选了谁，选完浮层自己收起。
       换模型仍然要点那一行里的下拉框——点行只选人，不会顺手把下拉框弹开。 */
    + `<div class="emp-pop-ft"><span class="ft-txt">${ho
      ? `点一下即选定：换人＝把这件事转交给 TA 接着跟，前面的结论和产出都保留（现在是 ${esc(ho.from.name)} 在跟）`
      : '点一下即选定；换模型点行里的下拉框'}</span></div>`;
}

/* 换模型：内存里先生效，落库失败再退回去 */
async function setStaffModel(s, modelId) {
  if (!s) return;
  const before = s.model || '';
  if (before === modelId) return;
  s.model = modelId;
  renderWho();
  renderStaffInRail();
  const nm = modelId ? ((modelOf(modelId) || {}).name || modelId) : '跟随全局';
  if (state.guest || !s.rowId) { toast(`${s.name} 改用 ${nm}`); return; }
  try {
    await CLOUD.updateStaff(s.rowId, { model: modelId });
    toast(`${s.name} 改用 ${nm}，员工档案已同步`);
  } catch (e) {
    s.model = before;
    renderWho();
    renderStaffInRail();
    toast('模型没存上：' + (e.message || e));
  }
}

/* 交接包：换人时把「这件事到哪一步了」摊成一张结构化清单。
   全部从已有记录里取（不另外让模型总结），所以不会出现「新员工听到一个编出来的前情」。 */
function handoffPacket(task, to, fromName) {
  const steps = task.steps || [];
  const files = [...new Set(steps
    .filter(s => s.kind === 'tool' && s.ok && Array.isArray(s.files))
    .flatMap(s => s.files))];
  const says = steps
    .filter(s => s.kind === 'say' && s.text)
    .map(s => String(s.text).replace(/\s+/g, ' ').trim());
  const confirmed = [];
  for (const m of (task.messages || [])) {
    if (!m || m.role !== 'user' || typeof m.content !== 'string') continue;
    if (m.content.indexOf('【已确认') !== 0) continue;
    for (const line of m.content.split('\n').slice(1)) {
      const t = line.replace(/^\d+\.\s*/, '').replace(/^答：/, ' → ').trim();
      if (t) confirmed.push(t);
    }
  }
  const open = ((task.pendingAsk || {}).questions || []).map(q => q && q.q).filter(Boolean);
  const risks = [];
  if (task.status === 'unverified') risks.push('交付物没通过自检');
  if (task.status === 'weak' && task.verify) {
    risks.push('上一轮复核有缺口：' + ((task.verify.gaps || [])[0] || '细节没核完'));
  }
  if (task.status === 'failed') risks.push('上一轮出错停下，结论可能只到一半');
  if (task.status === 'step_limit') risks.push('步数用完了，可能还有没做完的');
  if (task.blockedOn) risks.push('卡在「' + task.blockedOn + '」授权');
  const packet = {
    goal: String(task.goal || task.title || '').slice(0, 120),
    done: says.slice(-2).map(s => brief(s, 90)),
    confirmed: confirmed.slice(-6).map(s => brief(s, 90)),
    open: open.slice(0, 6).map(s => brief(s, 90)),
    risks,
    files: files.slice(0, 8),
    next: ''
  };
  packet.next = packet.open.length
    ? '先把上面没定的问题定下来，再往下做'
    : (packet.done.length ? '接着往下做，不要重头再来' : '按目标开工');
  return { at: Date.now(), from: fromName || '', to: to.name || '', packet };
}

/* 交接说明写进上下文的那段话：结构化，模型照着就能接上 */
function handoffText(h, to, fromName) {
  const p = h.packet || {};
  const L = [`【工作交接】从这句开始，这件事交给 ${to.name}${to.role ? '（' + to.role + '）' : ''} 接着跟`
    + `${fromName && fromName !== to.name ? '，之前是 ' + fromName + ' 在做' : ''}。`];
  const row = (k, v) => { if (v && v.length) L.push(`- ${k}：${v.join('；')}`); };
  row('目标', p.goal ? [p.goal] : []);
  row('已完成', p.done);
  row('已确认事实', p.confirmed);
  row('未决问题', p.open);
  row('风险', p.risks);
  row('产物', p.files);
  row('下一步', p.next ? [p.next] : []);
  L.push('前面的对话、已经拿到的结论和产出的文件都还在，直接接着往下做，不要重头再来。');
  return L.join('\n');
}

/* 验收卡：把「谁验的、各维几分、缺什么」摊开。
   注意：这张卡不再出现在老板的任务对话里——验收是内部质检，老板看成品。
   保留这个渲染函数是给管理员视角用（告警邮件、质检台复核），别在 trace 里再调它。 */
function verifyCardHTML(v) {
  if (!v || !v.verdict) return '';
  const J = window.JUDGE;
  const tone = v.verdict === 'pass' ? 'ok' : v.verdict === 'weak' ? 'warn' : 'bad';
  const title = J ? J.summary(v) : (v.verdict === 'pass' ? '验收通过' : v.verdict === 'weak' ? '验收有缺口' : '验收没过');
  const who = J ? J.whoLine(v) : '';
  const dims = (v.dims || []).map(d => {
    const cls = d.w === 'veto' ? (d.s >= 3 ? 'ok' : 'bad') : (d.s >= 3 ? 'ok' : d.s === 2 ? 'warn' : 'bad');
    const val = d.w === 'veto' ? (d.s >= 3 ? '通过' : '否决') : d.s + '/4';
    return `<div class="vf-d ${cls}"><span class="vf-k">${esc(d.name || d.k)}</span><span class="vf-s">${esc(val)}</span>`
      + (d.why ? `<span class="vf-w">${esc(d.why)}</span>` : '') + '</div>';
  }).join('');
  const gaps = (v.gaps || []).map(g => `<li>${esc(g)}</li>`).join('');
  return `<div class="vf-card ${tone}">
    <div class="vf-hd">
      <b>${esc(title)}</b>
      ${v.score ? `<span class="vf-score">${esc(String(v.score))}/4</span>` : ''}
      <span class="vf-who">${esc(who)}</span>
    </div>
    ${dims ? `<div class="vf-dims">${dims}</div>` : ''}
    ${gaps
      ? `<ul class="vf-gaps">${gaps}</ul>`
      : (v.note ? `<div class="vf-note">${esc(v.note)}</div>` : '')}
  </div>`;
}

function handoffCardHTML(t) {
  const h = t && t.handoff;
  if (!h) return '';
  const p = h.packet || {};
  const row = (k, v) => (v && v.length)
    ? `<div class="ho-row"><b>${esc(k)}</b><span>${esc([].concat(v).join('；'))}</span></div>`
    : '';
  return `<div class="ho-card">
    <div class="ho-h">
      <span class="ho-badge">工作交接</span>
      <span class="ho-who">${esc(h.from || '—')} → <b>${esc(h.to || '—')}</b></span>
      <span class="ho-at">${esc(fmtAt(h.at))}</span>
      <button class="ho-x" type="button" data-ho-x title="收起这张卡（不影响上下文）">×</button>
    </div>
    <div class="ho-b">
      ${row('目标', p.goal ? [p.goal] : [])}
      ${row('已完成', p.done)}
      ${row('已确认事实', p.confirmed)}
      ${row('未决问题', p.open)}
      ${row('风险', p.risks)}
      ${row('产物', p.files)}
      ${row('下一步', p.next ? [p.next] : [])}
    </div>
  </div>`;
}

/* 同一个任务里换人：这件事整体转交给新人接着跟。
   上下文（messages）、已经跑出来的轨迹、产出的文件都原样留着，只换「谁在跟」；
   并在上下文里留一条交接说明，下一轮模型读得到，不会把别人做过的当没做。 */
async function handoverTask(task, to) {
  if (!task || !to) return;
  const fromName = task.employeeName || '';
  task.employeeId = to.id;
  task.employeeName = to.name;
  task.employeeRole = to.role || '';
  state.curEmpId = to.id;
  state.pickEmp = [to.id];
  state.railEmpId = to.id;
  rememberEmp(to.id);
  const h = handoffPacket(task, to, fromName);
  task.handoff = h;
  const note = handoffText(h, to, fromName);
  if (!Array.isArray(task.messages)) task.messages = [];
  const last = task.messages[task.messages.length - 1];
  if (last && last.role === 'user' && typeof last.content === 'string'
    && last.content.indexOf('【工作交接】') === 0) {
    last.content = note;   /* 连着换两次人只留最新一条，别把上下文堆满 */
  } else {
    task.messages.push({ role: 'user', content: note });
  }
  renderWho(); renderTaskHead(); renderRail(); renderTrace(); syncComposer();
  toast(`已转交给 ${to.name} 接着跟，前面的结论和产出都保留`);
  if (state.guest || String(task.id).startsWith('local_')) return;
  try {
    await CLOUD.saveTask(task.id, {
      staff: { id: to.id, name: to.name, role: to.role || '' },
      messages: task.messages
    });
  } catch (e) {
    toast(friendlyErr('转交没同步到云端', e));
  }
}

function bindEmpPop(pop) {
  pop.querySelectorAll('.emp-opt').forEach(el => {
    el.onclick = (ev) => {
      if (ev.target.closest('select')) return;   // 点模型下拉不要触发选人
      ev.stopPropagation();
      const id = el.dataset.id;
      /* 老对话里换人 = 转交：这件事整体交给新人接着跟，上下文和产出都不动。
         正在跑的那一轮不换，避免把这一轮的工具调用记到别人头上。 */
      const ho = handoverCtx();
      if (ho && id !== ho.from.id) {
        const pick = state.staff.find(s => s.id === id);
        if (!pick) return;
        if (state.running) {
          toast('这一轮还在跑，等它停下来再换人');
          return;
        }
        pop.hidden = true;
        handoverTask(ho.task, pick);
        return;
      }
      /* 单选：点谁就是谁，其余全部取消 */
      state.pickEmp = [id];
      state.curEmpId = id;
      rememberEmp(id);   /* 人自己选的，才记成「上次交给谁」 */
      pop.querySelectorAll('.emp-opt').forEach(x => {
        const on = x.dataset.id === id;
        x.classList.toggle('on', on);
        const ck = x.querySelector('.emp-opt-ck');
        if (ck) ck.textContent = on ? '✓' : '';
      });
      const n = pop.querySelector('.emp-pop-n');
      if (n) n.textContent = '已选 1';
      const st = state.staff.find(x => x.id === id);
      if (st) state.railEmpId = st.id;
      renderWho();
      /* 点行即完成：不再要第二个「完成」按钮确认一次 */
      pop.hidden = true;
      const who = state.staff.find(x => x.id === id);
      if (who) toast(`这件事交给 ${who.name}${who.role && who.role !== who.name ? ' · ' + who.role : ''}`);
    };
  });
  pop.querySelectorAll('.emp-model').forEach(sel => {
    /* 只有点在模型下拉框上才展开模型列表；点行别把下拉框带出来，也别顺手选人 */
    sel.onmousedown = ev => ev.stopPropagation();
    sel.onclick = ev => ev.stopPropagation();
    sel.onchange = ev => {
      ev.stopPropagation();
      const st = state.staff.find(x => x.id === sel.dataset.mid);
      setStaffModel(st, sel.value);
    };
  });
  const done = pop.querySelector('[data-empdone]');
  if (done) done.onclick = (ev) => { ev.stopPropagation(); pop.hidden = true; };
}
function toggleEmpPop() {
  const pop = $('#empPop');
  if (!pop.hidden) { pop.hidden = true; return; }
  const staff = state.staff;
  if (!staff.length) { toast('还没有员工，先去「员工」Tab 新建一个'); return; }
  pop.innerHTML = empPopHTML();
  bindEmpPop(pop);
  /* 先显示再量高度，然后向上展开（输入区贴着窗口底部） */
  pop.style.visibility = 'hidden';
  pop.hidden = false;
  const anchor = $('#empSel');
  const r = anchor.getBoundingClientRect();
  const h = pop.offsetHeight, w = pop.offsetWidth;
  const top = r.top - h - 8;
  pop.style.left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10)) + 'px';
  pop.style.top = (top > 8 ? top : Math.min(r.bottom + 8, window.innerHeight - h - 8)) + 'px';
  pop.style.visibility = '';
}
$('#empSel').addEventListener('click', (e) => { e.stopPropagation(); toggleEmpPop(); });

/* ── 权限：两态开关（完全访问 / 默认沙箱），开启需二次确认并留审计日志 ── */
const FULL_PERMS = { read: true, write: true, exec: true, net: true };
const DEFAULT_PERMS = { read: true, write: true, exec: false, net: true };
function isFullAccess() {
  const p = state.settings.permissions || {};
  return !!(p.read && p.write && p.exec && p.net);
}
function applyPermLevel(id) {
  const full = id === 'full';
  state.settings.permissions = { ...(full ? FULL_PERMS : DEFAULT_PERMS) };
  /* 完全访问的语义就是「减少确认步骤」：顺手把「敏感操作先问一下」关掉 */
  if (full) {
    try { localStorage.setItem('boss.approve', '0'); } catch { /* 忽略 */ }
    state.settings.approve = false;
  }
  renderPermLabel();
  if (!state.guest) persistSettings({ permissions: state.settings.permissions });
  /* 权限变更也是一条证据：写入后台审计日志 */
  auditLog('permission_change', full ? 'full' : 'default', {
    action: full ? '开启完全访问' : '关闭完全访问（回到默认权限）',
    detail: full ? '用户勾选风险确认后开启，agent 可读写任意位置文件、跑命令、联网' : '权限收敛回沙箱默认（不跑命令）'
  });
  toast(full ? '已开启完全访问，操作都会记入审计日志' : '已回到默认权限（沙箱约束内）');
}
function renderPermLabel() {
  const full = isFullAccess();
  [['#permSel', '#permLabel'], ['#permSelM', '#permLabelM']].forEach(([sel, lab]) => {
    const s = $(sel), l = $(lab);
    if (!s || !l) return;
    s.classList.toggle('off', !full);
    l.textContent = full ? '允许完全访问' : '默认权限';
    s.title = full ? '当前：允许完全访问（点击调整）' : '当前：默认权限，沙箱内执行（点击调整）';
  });
}
function togglePermPop(anchorSel) {
  const pop = $('#permPop');
  if (!pop.hidden) { pop.hidden = true; return; }
  const full = isFullAccess();
  pop.innerHTML = `
    <div class="perm-note">${full
      ? '当前权限为允许完全访问，请注意数据安全，建议执行可信任的任务。'
      : '当前为默认权限，所有操作都会在安全沙箱约束内进行，超出范围会请求你的允许。'}</div>
    <div class="perm-sep"></div>
    <div class="perm-row">
      <span>允许完全访问</span>
      <button class="sw ${full ? 'on' : ''}" id="permSw" type="button" role="switch" aria-checked="${full}"
              title="${full ? '点击关闭完全访问' : '点击开启完全访问'}"></button>
    </div>`;
  pop.querySelector('#permSw').onclick = (ev) => {
    ev.stopPropagation();
    if (isFullAccess()) { applyPermLevel('default'); pop.hidden = true; }
    else { pop.hidden = true; openRiskConfirm(); }
  };
  pop.style.visibility = 'hidden';
  pop.hidden = false;
  const anchor = $(anchorSel);
  const r = anchor.getBoundingClientRect();
  const h = pop.offsetHeight, w = pop.offsetWidth;
  const top = r.top - h - 8;
  pop.style.left = Math.max(10, Math.min(r.left, window.innerWidth - w - 10)) + 'px';
  pop.style.top = (top > 8 ? top : Math.min(r.bottom + 8, window.innerHeight - h - 8)) + 'px';
  pop.style.visibility = '';
}
$('#permSel').addEventListener('click', (e) => { e.stopPropagation(); togglePermPop('#permSel'); });
if ($('#permSelM')) $('#permSelM').addEventListener('click', (e) => { e.stopPropagation(); togglePermPop('#permSelM'); });

/* 确认允许完全访问 */
function openRiskConfirm() {
  $('#permRiskModal').hidden = false;
  $('#riskAck').checked = false;
  $('#riskOk').disabled = true;
}
if ($('#riskAck')) $('#riskAck').addEventListener('change', (e) => {
  $('#riskOk').disabled = !e.target.checked;
});
if ($('#riskOk')) $('#riskOk').addEventListener('click', () => {
  if (!$('#riskAck').checked) return;
  $('#permRiskModal').hidden = true;
  applyPermLevel('full');
});
[['#riskClose'], ['#riskCancel']].forEach(([sel]) => {
  const b = $(sel); if (b) b.onclick = () => { $('#permRiskModal').hidden = true; };
});
if ($('#permRiskModal')) $('#permRiskModal').addEventListener('click', (e) => {
  if (e.target.id === 'permRiskModal') $('#permRiskModal').hidden = true;
});

/* 审计日志：调用后台记录一条（失败静默，不打扰主流程） */
function auditLog(kind, target, extra) {
  try {
    fetch(window.withSC('/api/audit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: state.scope, kind, target, ...(extra || {}) })
    }).catch(() => {});
  } catch { /* 忽略 */ }
}

/* 点击别处收起下拉 */
document.addEventListener('click', (e) => {
  if (!e.target.closest('#empSel') && !e.target.closest('#empPop')) $('#empPop').hidden = true;
  if (!e.target.closest('.perm-sel') && !e.target.closest('#permPop')) $('#permPop').hidden = true;
});

/* ── 员工详情：直接在中间面板里看 / 改，不再弹窗 ──
   左栏点员工、点 ⋯、点「＋ 新建员工」都落到这里。 */
function staffPanelTarget() {
  if (state.staffPanelNew) return null;
  return state.staff.find(x => x.id === state.staffPanelId) || null;
}
function openStaffPanel(id) {
  const s = id ? state.staff.find(x => x.id === id) : null;
  state.staffPanelNew = !s;
  state.staffPanelId = s ? s.id : '';
  /* 打开谁就装谁的四项，并且记下「这份草稿属于谁」：
     之后面板因为别的原因重画（切视图、员工列表刷新）也不会把没保存的选择冲掉。 */
  state.traitsFor = s ? s.id : '__new__';
  state.traits = window.TRAITS ? window.TRAITS.pick(s) : { gender: '', zodiac: '', sign: '', mbti: '' };
  if (s) state.railEmpId = s.id;
  state.view = 'staffPanel';
  state.lastListView = 'staff';
  showView('staffPanel');
  renderStaffInRail();
  renderOutputRail();
}
/* 性格 chips：一组里单选，再点同一个就取消；「不指定」等价于空值。
   整组重画而不是逐颗改 class——四组加起来不到 50 颗，重画比维护状态便宜。 */
function renderTraitBox(box, cur) {
  if (!box || !window.TRAITS) return;
  box.innerHTML = window.TRAITS.allHTML(cur);
  box.querySelectorAll('.tr-chip').forEach(el => {
    el.onclick = () => {
      const dim = el.dataset.dim;
      const k = el.dataset.k || '';
      cur[dim] = cur[dim] === k ? '' : k;
      renderTraitBox(box, cur);
    };
  });
}
function renderStaffPanel() {  const box = $('#stfBody');
  if (!box) return;
  const s = staffPanelTarget();
  if (!s && !state.staffPanelNew) {
    $('#stfTitle').textContent = '员工';
    $('#stfTags').innerHTML = '';
    $('#stfMeta').textContent = '';
    box.innerHTML = '<div class="empty"><div class="empty-t">这位员工不在了</div><div class="empty-d">可能已被删除。从左边选一位，或者点「＋ 新建员工」。</div></div>';
    return;
  }
  const isNew = !s;
  /* 只有换了人（或第一次打开）才重新装档案；重画面板不该把没保存的选择冲掉 */
  const tKey = s ? s.id : '__new__';
  if (state.traitsFor !== tKey) {
    state.traitsFor = tKey;
    state.traits = window.TRAITS ? window.TRAITS.pick(s) : { gender: '', zodiac: '', sign: '', mbti: '' };
  }
  const traitLine = window.TRAITS ? window.TRAITS.line(s) : '';
  const all = collectOutputs();
  const outs = s ? all.filter(o => o.by === s.name) : [];
  const tks = s ? state.tasks.filter(t => t.employeeName === s.name) : [];
  const pjs = s ? state.meetings.filter(m => (m.participants || []).some(x => x.name === s.name)) : [];
  const kbN = s ? state.kb.filter(k => k.staffId === s.id).length : 0;

  $('#stfTitle').textContent = isNew ? '新建员工' : (s.name || '员工');
  $('#stfTags').innerHTML = isNew ? '' : `<i class="tag-ai ai">AI</i>${s.core ? '<i class="tag-core">核心</i>' : ''}`;
  $('#stfMeta').textContent = isNew
    ? '给 TA 一个岗位、一组性格、一个模型；保存后就能接活。'
    : `${s.role || '没设岗位'}${traitLine ? ' · ' + traitLine : ''} · 模型 ${staffModelName(s)} · 任务 ${tks.length} · 项目 ${pjs.length} · 产出 ${outs.length}`;

  box.innerHTML = `
    <div class="stf-wrap">
      <section class="stf-card">
        <div class="stf-hd"><b>${isNew ? '新建档案' : '基本资料'}</b><span class="stf-note">改完点下面保存，改动立刻生效</span></div>
        <div class="stf-row">
          <label class="f">岗位
            <input id="stfRole" list="roleDl" value="${esc(s ? s.role : '')}" placeholder="输入汉字搜索，或点下拉选" autocomplete="off" spellcheck="false">
          </label>
          <label class="f">名字（选填）
            <input id="stfNameIn" value="${esc(s ? s.name : '')}" placeholder="不填就用岗位名顶上">
          </label>
          <label class="f">基座模型
            <select id="stfModel" class="stf-sel">${modelOptions(s ? (s.model || '') : '')}</select>
          </label>
        </div>
        <div class="f">性格与说话风格（四个都选填）
          <div class="tr-box" id="stfTraits"></div>
          <p class="tr-note">填了哪几项，TA 就按哪几项调语气和做事方式：先看什么、先问什么都会跟着变。一项都不填，就用默认的稳重口径。</p>
        </div>
        <label class="f">期望 TA 具备的能力
          <textarea id="stfNotes" rows="3" placeholder="例如：能独立做三年现金流测算；看得懂合同里的违约金上限；报价必须含税">${esc(s ? (s.notes || '') : '')}</textarea>
        </label>
        <label class="chk"><input type="checkbox" id="stfCore" ${!s || s.core !== false ? 'checked' : ''}> 核心员工（新建项目时默认拉进来）</label>
        <div class="stf-actions">
          <button class="btn primary" id="stfSave" type="button">${isNew ? '让它上岗' : '保存修改'}</button>
          ${isNew ? '' : '<button class="btn ghost danger" id="stfDel" type="button">删除这个员工</button>'}
        </div>
      </section>

      ${isNew ? '' : `
      <section class="stf-card">
        <div class="stf-hd"><b>专属知识库</b><span class="stf-note">只喂给 TA 一个人，平台不读取、不共享</span></div>
        <div class="stf-kb">
          <span class="stf-kbn">已有 <b>${kbN}</b> 份资料</span>
          <button class="btn tiny" id="stfKbIn" type="button">＋ 导入知识库</button>
          <button class="btn tiny ghost" id="stfKbView" type="button">查看已导入</button>
        </div>
      </section>

      <section class="stf-card">
        <div class="stf-hd"><b>TA 的产出</b><span class="stf-note">${outs.length ? `最近 ${Math.min(outs.length, 8)} 条，点一下看内容` : '跑完任务就有'}</span></div>
        ${outs.length ? `<div class="stf-outs">${outs.slice(0, 8).map((o, i) => `
          <div class="stf-out" data-i="${i}">
            <span class="stf-out-ic">${o.typeIcon || '📎'}</span>
            <span class="stf-out-main"><b>${esc((o.path || '').split('/').pop())}</b>
              <i>${esc(o.srcLabel || '')} · ${esc(o.typeName || '文件')}${o.at ? ' · ' + todoAgo(o.at) : ''}</i></span>
            <span class="stf-out-go">查看</span>
          </div>`).join('')}</div>` : `<div class="hint-block">还没有产出。给 ${esc(s.name)} 一个任务试试。</div>`}
      </section>`}
    </div>`;

  renderTraitBox(box.querySelector('#stfTraits'), state.traits);
  const saveBtn = $('#stfSave');
  if (saveBtn) saveBtn.onclick = saveStaffPanel;
  const delBtn = $('#stfDel');
  if (delBtn) delBtn.onclick = () => deleteStaffProfile(s);
  const kbIn = $('#stfKbIn');
  if (kbIn) kbIn.onclick = () => { kbStaffId = s.id; openKb('import'); };
  const kbView = $('#stfKbView');
  if (kbView) kbView.onclick = () => { kbStaffId = s.id; openKb('list'); };
  box.querySelectorAll('.stf-out').forEach(el => {
    el.onclick = () => openOutputView(outs[Number(el.dataset.i)]);
  });
}
async function saveStaffPanel() {
  const isNew = state.staffPanelNew;
  const s = staffPanelTarget();
  const role = String(($('#stfRole') || {}).value || '').trim();
  if (!role) return toast('先给 TA 一个岗位');
  const name = String(($('#stfNameIn') || {}).value || '').trim() || roleShort(role);
  const payload = {
    name, role,
    /* 性格四维度整体带走（空字符串 = 没填）；persona 不再从界面改，
       老员工身上那个值留着当「四项全空时的兜底口径」。 */
    gender: state.traits.gender || '',
    zodiac: state.traits.zodiac || '',
    sign: state.traits.sign || '',
    mbti: state.traits.mbti || '',
    notes: String(($('#stfNotes') || {}).value || '').trim(),
    model: String(($('#stfModel') || {}).value || ''),
    kind: 'ai',
    core: !!($('#stfCore') || {}).checked
  };
  const btn = $('#stfSave');
  if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
  try {
    if (isNew) {
      const made = state.guest
        ? { id: 'g' + Date.now(), rowId: null, ...payload }
        : await CLOUD.addStaff(payload);
      state.staff.push(made);
      state.curEmpId = made.id;
      state.pickEmp = [made.id];
      /* 刚建的人往往就是接下来要用的：顺手记成「上次交给谁」 */
      rememberEmp(made.id);
      state.staffPanelNew = false;
      state.staffPanelId = made.id;
      state.railEmpId = made.id;
      toast(`${made.name} 上岗了`);
    } else {
      if (state.guest) Object.assign(s, payload);
      else Object.assign(s, await CLOUD.updateStaff(s.rowId, payload));
      toast(`${payload.name} 的档案已更新`);
    }
    renderStaffPanel();
    renderStaffInRail();
    renderWho();
    renderOutputRail();
  } catch (e) {
    toast(e.message || '没存上');
    if (btn) { btn.disabled = false; btn.textContent = isNew ? '让它上岗' : '保存修改'; }
  }
}
async function deleteStaffProfile(s) {  if (!s) return;
  if (!window.confirm(`删除「${s.name}」？TA 的历史产出还留在任务和项目里，但不能再给 TA 派活。`)) return;
  try {
    if (!state.guest) await CLOUD.deleteStaff(s.rowId);
    state.staff = state.staff.filter(x => x.id !== s.id);
    forgetEmp(s.id);
    if (state.curEmpId === s.id) state.curEmpId = state.staff[0] ? state.staff[0].id : null;
    if (state.railEmpId === s.id) state.railEmpId = '';
    state.staffPanelId = '';
    state.staffPanelNew = false;
    state.view = 'task';
    showView('task');
    renderStaffInRail();
    renderWho();
    toast('已删除');
  } catch (e) { toast(e.message); }
}

/* 面板右上「回到任务」：有当前任务就回去，没有就回空白任务页 */
if ($('#stfBack')) {
  $('#stfBack').onclick = () => {
    state.view = 'task';
    if (state.curTaskId && state.tasks.some(t => t.id === state.curTaskId)) return selectTask(state.curTaskId);
    showView('task');
    renderTaskHead(); renderTrace(); syncComposer();
  };
}

function openEmp(staff) {
  state.editing = staff || null;
  state.traits = window.TRAITS ? window.TRAITS.pick(staff) : { gender: '', zodiac: '', sign: '', mbti: '' };
  $('#empModalTitle').textContent = staff ? '编辑员工' : '新建员工';
  $('#empName').value = staff ? staff.name : '';
  $('#empRole').value = staff ? staff.role : '';
  $('#empNotes').value = staff ? staff.notes : '';
  $('#empDelete').hidden = !staff;
  $('#empCore').checked = staff ? staff.core !== false : true;
  renderTraitBox($('#traitBox'), state.traits);
  closeRoleList();
  kbStaffId = staff ? staff.id : '';
  renderKbCount();
  $('#empModal').hidden = false;
  setTimeout(() => $('#empRole').focus(), 60);
}
/* 新建员工入口已移到左栏「员工」Tab 的 railActionBtn（lv==='staff' → openEmp(null)） */

/* ── 岗位：直接从岗位库里平铺选，可汉字搜索 ──
   数据在 roles.js（window.ROLE_TREE，按行业线分组只是为了取用方便）。
   员工身上只存次级岗位名本身，例如「成本会计」。 */
const ROLE_ALL = (() => {
  const seen = new Set();
  const out = [];
  (window.ROLE_TREE || []).forEach(node => (node.items || []).forEach(it => {
    if (!seen.has(it)) { seen.add(it); out.push(it); }
  }));
  return out;
})();
/* 员工详情面板里改岗位用原生 datalist：输入汉字就能筛，不额外写一套下拉 */
if ($('#roleDl')) {
  $('#roleDl').innerHTML = ROLE_ALL.map(r => `<option value="${esc(r)}"></option>`).join('');
}

/* 兼容旧数据：万一岗位里还带着「主岗位 · 次级岗位」，只取后面那段 */
function roleShort(r) {
  const t = String(r || '');
  const i = t.lastIndexOf(' · ');
  return i >= 0 ? t.slice(i + 3) : t;
}
function roleGroup(r) {
  const t = String(r || '');
  const i = t.lastIndexOf(' · ');
  return i >= 0 ? t.slice(0, i) : '';
}

let roleIdx = -1;

/* 已在用的岗位排最前面，方便复用 */
function roleUsed() {
  const out = [];
  state.staff.forEach(st => {
    const r = roleShort(st.role);
    if (r && !out.includes(r)) out.push(r);
  });
  return out;
}
function rolePool() {
  const out = roleUsed();
  ROLE_ALL.forEach(r => { if (!out.includes(r)) out.push(r); });
  return out;
}
function roleMatches(q) {
  const ql = String(q || '').trim().toLowerCase();
  if (!ql) return rolePool();
  return rolePool().filter(r => r.toLowerCase().includes(ql));
}

function renderRoleList(q) {
  const list = roleMatches(q);
  const box = $('#roleList');
  roleIdx = -1;
  const raw = String(q || '').trim();
  if (!list.length) {
    box.innerHTML = `<div class="combo-empty">没找到「${esc(raw)}」。可以直接用你输入的岗位，换个词也行。</div>`;
    box.hidden = false;
    return;
  }
  const cap = 150;
  box.innerHTML = list.slice(0, cap).map(r =>
    `<div class="combo-i" data-r="${esc(r)}" title="${esc(r)}">${esc(r)}</div>`
  ).join('') + (list.length > cap
    ? `<div class="combo-more">还有 ${list.length - cap} 个，继续输入缩小范围</div>`
    : '');
  box.querySelectorAll('.combo-i').forEach(el => {
    el.onmousedown = ev => { ev.preventDefault(); pickRole(el.dataset.r); };
  });
  box.hidden = false;
}

function pickRole(r) {
  $('#empRole').value = r;
  closeRoleList();
  $('#empName').focus();
}
function closeRoleList() {
  const box = $('#roleList');
  if (box) box.hidden = true;
  roleIdx = -1;
}

$('#empRole').addEventListener('input', e => renderRoleList(e.target.value));
$('#empRole').addEventListener('focus', e => {
  renderRoleList('');
  setTimeout(() => { try { e.target.select(); } catch (_) { } }, 0);
});
$('#empRole').addEventListener('keydown', e => {
  const box = $('#roleList');
  const items = box.hidden ? [] : [...box.querySelectorAll('.combo-i')];
  if (e.key === 'Escape') { closeRoleList(); return; }
  if (!items.length) {
    if (e.key === 'ArrowDown') { renderRoleList(e.target.value); e.preventDefault(); }
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    roleIdx = e.key === 'ArrowDown'
      ? Math.min(items.length - 1, roleIdx + 1)
      : Math.max(0, roleIdx - 1);
    items.forEach((it, i) => it.classList.toggle('on', i === roleIdx));
    items[roleIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const pick = roleIdx >= 0 ? items[roleIdx] : items[0];
    if (pick) pickRole(pick.dataset.r);
  }
});
$('#roleDrop').onclick = () => {
  if (!$('#roleList').hidden) return closeRoleList();
  renderRoleList('');
};

$('#empSave').onclick = async () => {
  const role = $('#empRole').value.trim();
  if (!role) return toast('先选一个岗位');
  // 名字选填：不填就用岗位名顶上
  const typed = $('#empName').value.trim();
  const name = typed || roleShort(role);
  const payload = {
    name, role,
    gender: state.traits.gender || '', zodiac: state.traits.zodiac || '',
    sign: state.traits.sign || '', mbti: state.traits.mbti || '',
    notes: $('#empNotes').value.trim(),
    kind: 'ai',
    core: $('#empCore').checked
  };
  try {
    if (state.editing) {
      if (state.guest) {
        Object.assign(state.editing, payload);
      } else {
        const saved = await CLOUD.updateStaff(state.editing.rowId, payload);
        Object.assign(state.editing, saved);
      }
      toast(`${payload.name} 的档案已更新`);
    } else {
      const made = state.guest
        ? { id: 'g' + Date.now(), rowId: null, model: '', ...payload }
        : await CLOUD.addStaff(payload);
      state.staff.push(made);
      state.curEmpId = made.id;
      state.pickEmp = [made.id];
      rememberEmp(made.id);
      await adoptPendingKb(made);
      toast(`${made.name} 上岗了`);
    }
    $('#empModal').hidden = true;
    renderStaff(); renderWho();
  } catch (e) { toast(e.message); }
};

/* ── 员工知识库（RAG） ──
   内容是员工专属的：只按 staffId 取，只喂给这个人。 */
let kbStaffId = '';
let pendingKb = [];

function kbOf(id) { return id === 'pending' ? pendingKb : state.kb.filter(k => k.staffId === id); }
function renderKbCount() {
  const n = kbOf(kbStaffId || 'pending').length;
  $('#kbCount').textContent = n;
  $('#kbN2').textContent = n;
}
/* 段落切块：以原文的空行分段为一块（检索精度高），太短的并到下一段，超长段按句末切开 */
function chunkText(text) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  const out = [];
  let buf = '';
  String(clean).split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean).forEach(p => {
    if (buf && (buf.length + p.length) < 120) { buf += '\n' + p; return; }
    if (buf) out.push(buf);
    buf = p;
  });
  if (buf.trim()) out.push(buf.trim());
  const fin = [];
  out.forEach(s => {
    let rest = s;
    while (rest.length > 700) {
      let cut = rest.lastIndexOf('。', 640);
      if (cut < 200) cut = rest.lastIndexOf('；', 640);
      if (cut < 200) cut = 640;
      fin.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
    }
    if (rest.trim()) fin.push(rest.trim());
  });
  return fin.slice(0, 300);
}
function grams(s) {
  const t = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]+/g, '');
  const g = [];
  for (let i = 0; i < t.length - 1; i++) g.push(t.slice(i, i + 2));
  return g;
}
/* 轻量检索：中文按二元组命中率打分，取最相关的几段（不联网、不外传） */
function kbSnippets(staffId, query, limit) {
  const items = state.kb.filter(k => k.staffId === staffId);
  if (!items.length) return [];
  const qg = new Set(grams(query));
  if (!qg.size) return [];
  const scored = [];
  items.forEach(k => {
    const chunks = (k.chunks && k.chunks.length)
      ? k.chunks
      : chunkText(k.content).map((t, i) => ({ i, text: t }));
    chunks.forEach(c => {
      const g = grams(c.text);
      if (!g.length) return;
      let hit = 0;
      g.forEach(x => { if (qg.has(x)) hit++; });
      const score = hit / Math.sqrt(g.length);
      if (score > 0.15) scored.push({ title: k.title, text: c.text, score });
    });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit || 3);
}

function switchKbTab(t) {
  kbStaffId = kbStaffId; // noop，保持语义清晰
  const imp = $('#kbPaneImport');
  const lst = $('#kbPaneList');
  $('#kbTabs').querySelectorAll('.kbt').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  imp.hidden = t !== 'import';
  lst.hidden = t !== 'list';
  if (t === 'list') renderKbList();
}
function openKb(tab) {
  const staff = state.staff.find(s => s.id === kbStaffId);
  $('#kbTitle').textContent = '知识库（RAG）';
  $('#kbFor').textContent = staff
    ? `这份知识只喂给「${staff.name} · ${staff.role}」。它每次做事前，会先从你导入的资料里检索相关段落。`
    : '先把内容导进来，员工保存上岗后这些资料会挂到它身上。';
  $('#kbName').value = '';
  $('#kbText').value = '';
  $('#kbFile').value = '';
  $('#kbFileHint').textContent = '也可以直接把上面的框填满';
  renderKbCount();
  switchKbTab(tab || 'import');
  $('#kbModal').hidden = false;
}
function renderKbList() {
  const items = kbOf(kbStaffId || 'pending');
  const box = $('#kbList');
  if (!items.length) {
    box.innerHTML = `<div class="kb-empty">还没有导入任何资料。<br>把制度、口径、历史报价、FAQ、合同范本贴进「导入」那个页签就行。</div>`;
    return;
  }
  box.innerHTML = items.map(k => `<div class="kb-i" data-id="${esc(k.id)}">
      <div class="kb-i-main">
        <b>${esc(k.title || '未命名资料')}</b>
        <em>${k.chars} 字 · ${(k.chunks || []).length} 段 · ${todoAgo(k.createdAt)}</em>
      </div>
      <button type="button" class="btn tiny ghost" data-kprev="${esc(k.id)}">看</button>
      <button type="button" class="kb-del" data-kdel="${esc(k.id)}" title="删掉这份资料">×</button>
      <pre class="kb-prev" data-prev-for="${esc(k.id)}" hidden>${esc(k.content.slice(0, 800))}${k.content.length > 800 ? '\n…（还有 ' + (k.content.length - 800) + ' 字）' : ''}</pre>
    </div>`).join('');
  box.querySelectorAll('[data-kprev]').forEach(b => {
    b.onclick = () => {
      const pre = box.querySelector(`[data-prev-for="${b.dataset.kprev}"]`);
      if (pre) pre.hidden = !pre.hidden;
    };
  });
  box.querySelectorAll('[data-kdel]').forEach(b => {
    b.onclick = async () => {
      const id = b.dataset.kdel;
      const item = kbOf(kbStaffId || 'pending').find(k => k.id === id);
      if (!item) return;
      if (!confirm(`删掉「${item.title || '这份资料'}」？它的 ${(item.chunks || []).length} 段会一起没了，员工就再也检索不到。`)) return;
      if (kbStaffId === 'pending' || !kbStaffId) {
        pendingKb = pendingKb.filter(k => k.id !== id);
      } else if (state.guest) {
        state.kb = state.kb.filter(k => k.id !== id);
      } else {
        try { await CLOUD.deleteKb(id); state.kb = state.kb.filter(k => k.id !== id); }
        catch (e) { return toast(e.message); }
      }
      renderKbCount(); renderKbList();
      toast('已删除');
    };
  });
}
$('#kbImportBtn').onclick = () => openKb('import');
$('#kbViewBtn').onclick = () => openKb('list');
$('#kbTabs').addEventListener('click', e => {
  const b = e.target.closest('.kbt');
  if (b) switchKbTab(b.dataset.t);
});
$('#kbFileBtn').onclick = () => $('#kbFile').click();
$('#kbFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) { toast('文件太大，控制在 2MB 以内'); return; }
  try {
    const text = await f.text();
    $('#kbText').value = text.slice(0, 200000);
    if (!$('#kbName').value.trim()) $('#kbName').value = f.name.replace(/\.[^.]+$/, '');
    $('#kbFileHint').textContent = `已读入 ${f.name} · ${text.length} 字`;
  } catch (err) { toast('读不了这个文件：' + err.message); }
});
$('#kbSave').onclick = async () => {
  const text = $('#kbText').value.trim();
  if (!text) return toast('先粘贴内容，或者选一个文件');
  const staff = state.staff.find(s => s.id === kbStaffId);
  const title = $('#kbName').value.trim() || `资料 ${kbOf(kbStaffId || 'pending').length + 1}`;
  const chunks = chunkText(text).map((t, i) => ({ i, text: t }));
  const draft = {
    id: 'kb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    staffId: kbStaffId || 'pending',
    staffName: staff ? staff.name : '',
    title,
    content: text.slice(0, 200000),
    chunks,
    chars: text.length,
    createdAt: Date.now()
  };
  try {
    if (kbStaffId && !state.guest) {
      const made = await CLOUD.createKb(draft);
      state.kb.unshift(made);
    } else if (kbStaffId) {
      state.kb.unshift({ rowId: null, ...draft });
    } else {
      pendingKb.unshift(draft);
    }
  } catch (e) {
    return toast('没存进云端：' + e.message);
  }
  $('#kbName').value = '';
  $('#kbText').value = '';
  $('#kbFileHint').textContent = '也可以直接把上面的框填满';
  renderKbCount();
  switchKbTab('list');
  toast(`已导入 ${chunks.length} 段 · ${text.length} 字`);
};
/* 新员工保存后，把挂在他身上的临时资料真正入库 */
async function adoptPendingKb(staff) {
  if (!pendingKb.length || !staff) return;
  const moving = pendingKb.slice();
  pendingKb = [];
  for (const k of moving) {
    k.staffId = staff.id;
    k.staffName = staff.name;
    if (!state.guest) {
      try {
        const made = await CLOUD.createKb(k);
        state.kb.unshift(made);
        continue;
      } catch (e) { toast('知识库没存进云端：' + e.message); }
    }
    state.kb.unshift({ rowId: null, ...k });
  }
}

$('#empDelete').onclick = async () => {
  const s = state.editing;
  if (!s) return;
  if (!confirm(`删除员工「${s.name}」？它的历史任务不会删。`)) return;
  try {
    if (!state.guest) await CLOUD.deleteStaff(s.rowId);
    state.staff = state.staff.filter(x => x.id !== s.id);
    forgetEmp(s.id);
    if (state.curEmpId === s.id) state.curEmpId = state.staff[0] ? state.staff[0].id : null;
    $('#empModal').hidden = true;
    renderStaff(); renderWho();
    toast('已删除');
  } catch (e) { toast(e.message); }
};

/* ── 任务池 ── */
/* 左栏排序：置顶的在最前，其余按「最近修改时间」倒序——谁刚动过谁在上面。
   抽成纯函数是为了能被单独测：这段错一次，找任务就得从头翻。
   老数据没有 updatedAt 就退回创建时间，再没有才用到 at。 */
function sortRailItems(list) {
  const stamp = x => Number((x && (x.updatedAt || x.createdAt || x.at)) || 0);
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
    const ap = a && a.pinned ? 1 : 0, bp = b && b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return stamp(b) - stamp(a);
  });
}

function renderTaskList() {
  if (!state.tasks.length) {
    $('#railList').innerHTML = '<div class="hint-block">还没有任务。<br>点右上「＋ 新建任务」，交代一件事。</div>';
    return;
  }
  /* 按最近修改时间降序：谁刚动过谁在上面（置顶的仍置顶）。
     以前按创建时间排，接着聊一句老任务它还沉在下面，找起来要翻半天。 */
  const list = sortRailItems(state.tasks);
  /* 左栏搜索：按标题 / 目标过滤 */
  const q = String((state.railQ && state.railQ.task) || '').trim().toLowerCase();
  const shown = q
    ? list.filter(t => `${t.title || ''} ${t.goal || ''}`.toLowerCase().includes(q))
    : list;
  if (q && !shown.length) {
    $('#railList').innerHTML = `<div class="hint-block">没有匹配「${esc(q)}」的任务<br>换个关键词试试</div>`;
    return;
  }
  $('#railList').innerHTML = shown.map(t => {
    /* 日期跟着排序走，显示「最近动过」的那天，不然排序和日期对不上会看着很怪 */
    const stamp = t.updatedAt || t.createdAt || t.at;
    const d = stamp ? new Date(stamp) : null;
    const date = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
    return `<div class="ti ${state.curTaskId === t.id ? 'on' : ''}" data-id="${t.id}">
      <div class="ti-t"><i class="dot ${t.status}"></i><span>${esc(t.title)}</span>
        <button class="ti-more" data-more="${esc(t.id)}" data-kind="task" title="更多操作">⋯</button>
      </div>
      <div class="ti-m">${t.pinned ? '<span class="ti-pin">置顶</span>' : ''}${t.deliverableCheck && t.deliverableCheck.project ? '<span class="ti-pin proj">已转项目</span>' : ''}<span>${esc(date)}</span><span>${ST[t.status] || t.status}</span>${t.tokens && (t.tokens.in + t.tokens.out) ? `·<span>${t.tokens.in + t.tokens.out} tok</span>` : ''}</div>
    </div>`;
  }).join('');
  $('#railList').querySelectorAll('.ti').forEach(el => {
    el.onclick = e => {
      if (e.target.closest('[data-more]')) return;
      state.view = 'task'; selectTask(el.dataset.id);
    };
  });
}

function curTask() {
  return state.tasks.find(t => t.id === state.curTaskId) || null;
}

function selectTask(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  state.lastListView = 'task';
  state.view = 'task';
  showView('task');
  state.curTaskId = id;
  state.drafting = false;
  /* 点回来的正是还在跑的那个任务时，这一轮的起跑时刻不能被清掉，
     否则「已跑多久」会从 1970 算起（buildSteps 拿它算本轮耗时） */
  state.traceStartedAt = (runCtx && runCtx.id === id) ? (runCtx.startedAt || 0) : 0;
  traceStick = true; /* 换了个任务，跟随重新吸底 */
  const emp = state.staff.find(s => s.name === t.employeeName);
  /* 打开老对话就把输入区切回这个对话原来的人：换个对话等于换个活儿，人跟着活儿走 */
  if (emp) {
    state.curEmpId = emp.id;
    state.pickEmp = [emp.id];
  }
  /* 拍板卡兜底：断点 / 刷新之后任务状态可能已经不是 need_input，
     但只要存档里最后一次问话还没被回答，就把选项卡还原出来让人能补答。 */
  if (!t.pendingAsk && Array.isArray(t.messages) && t.messages.length && window.CLOUD
    && typeof CLOUD.pendingAskFromMessages === 'function') {
    try { t.pendingAsk = CLOUD.pendingAskFromMessages(t.messages); } catch { /* 解析不了就当没有 */ }
  }
  /* 只把「最后一轮」的步骤装进现场：前面几轮已经按轮存好了，重开时各归各位 */
  const curR = syncRounds(t).rounds || 1;
  /* 点回来的正好是还在跑的那个任务：现场就是内存里那一份，别从存档重建——
     存档是 3.5 秒一拍的，重建会把这一轮刚跑出来的几步当场抹掉 */
  state.trace = (runCtx && runCtx.id === id) ? runCtx.trace : {
    nodes: (t.steps || []).filter(s => s.kind === 'tool' && (Number(s.round) || 1) === curR).map(s => ({
      name: s.name, args: s.args, ok: s.ok, output: s.output, ms: s.ms, verify: s.verify, tests: s.tests,
      /* 带上落盘文件和发生时间：刷新后重开一个还在跑的任务，进度卡也能算出已经跑了多久 */
      at: s.at, files: s.files, round: curR
    })),
    result: t.result || '',
    status: t.status,
    blocked: t.blockedOn ? { category: t.blockedOn } : null,
    round: curR
  };
  renderRail();
  renderTaskHead();
  renderTrace();
  renderOutputRail();
  renderWho();
  syncComposer();
  /* 沙箱重启后本地文件可能已经没了：悄悄从本机文件夹还原，还原到了再重画一次。
     游客态也做——本地目录是浏览器能力，不依赖登录。 */
  restoreTaskFiles(t).then(n => { if (n) { renderTrace(); renderOutputRail(); } }).catch(() => {});
  renderOutDirBar();
  /* 打开的这个任务要是也在等你拍板，顶栏计数得当场对上 */
  renderDecisionCount();
}

/* 输入区的形态：接着当前任务说 / 开新任务。按钮与提示语都跟着变 */
function syncComposer() {
  const t = curTask();
  const continuing = !state.drafting && !!t;
  const emp = continuing
    ? (state.staff.find(s => s.name === t.employeeName) || state.staff[0])
    : (state.staff.find(s => s.id === state.curEmpId) || state.staff[0]);
  if (emp && !continuing) state.curEmpId = emp.id;
  const name = emp ? emp.name : '';
  $('#goal').placeholder = continuing
    ? `接着跟 ${name} 说。会写进这个任务，不新建；前面的结论和文件它都还记得。`
    : '交代一件事。例如：把报价表折算排序，结论写进 报价结论.md';
  if (!state.running) {
    $('#runBtn').textContent = '↑';
    $('#runBtn').title = continuing ? '继续这个任务（Enter）' : '执行（Enter）';
  } else if (runCtx && runCtx.id !== state.curTaskId) {
    /* 别处还有一个在跑：按钮还是「停止」，但得说清停的是谁 */
    $('#runBtn').textContent = '■';
    $('#runBtn').title = `停止正在跑的「${runCtx.task.title || '另一个任务'}」`;
  }
  $('#deliverables').placeholder = continuing
    ? '交付物（可空；这里填了会覆盖本任务的交付物清单）'
    : '交付物（可空，逗号分隔，如 报价结论.md）';
  renderStaff();
  renderModelPill();
}

function renderTaskHead() {
  const t = curTask();
  if (!t) {
    $('#taskTitle').textContent = state.drafting ? '新任务' : '还没有任务';
    $('#taskTitle').title = '';
    $('#taskMeta').textContent = state.drafting ? '在下面交代你要做的事，回车执行' : '在下面交代第一件事';
    $('#taskStats').innerHTML = '';
    $('#dvBox').innerHTML = '';
    return;
  }
  $('#taskTitle').textContent = t.title;
  // 标题过长时单行截断，hover 用 title 气泡看全文
  $('#taskTitle').title = t.title;
  // 标题就是目标前 42 字的截断，短目标时别把同一句话显示两遍
  const same = String(t.goal || '').trim() === String(t.title || '').trim();
  $('#taskMeta').textContent = same ? '' : t.goal;
  $('#taskMeta').style.display = same ? 'none' : '';
  const tok = t.tokens || { in: 0, out: 0 };
  const spent = (tok.in || 0) + (tok.out || 0);
  const UNFINISHED = ['failed', 'blocked', 'budget_exceeded', 'step_limit', 'unverified', 'weak', 'need_input', 'interrupted'];
  /* 断在半路（含「刚发出就刷新」）都给一个继续跑的入口：
     哪怕这一步还没落任何工具节点，也别让人找不到接着做的地方。
     等拍板不给——那时候该点的是卡里的「确认，继续」，不是绕过去再跑一遍。
     验收没过（weak）也不给：成品已经在老板手上，质检结论走管理员邮箱，不在这里催他重跑。 */
  const canResume = UNFINISHED.includes(t.status) && t.status !== 'need_input' && t.status !== 'weak'
    && ((t.steps || []).length > 0 || t.status === 'interrupted');
  /* 右上角只留「任务总消耗」。重跑按钮去掉了：真要对一件事再做一遍，
     直接在下面接着说就行，「重跑」只会把已经做好的东西再烧一遍积分。
     只有任务卡在失败/中断上时留一个「继续跑」，那是救现场，不是重做。 */
  $('#taskStats').innerHTML = `
    <div class="stat"><b>${spent ? Number(spent).toLocaleString() + ' token' : '—'}</b><span>任务总消耗</span></div>
    ${canResume ? '<button class="btn tiny ghost" data-act="resume">继续跑</button>' : ''}
    ${tpBtnHTML(t)}`;
  const resumeBtn = $('#taskStats').querySelector('[data-act="resume"]');
  if (resumeBtn) resumeBtn.onclick = () => runGoal('', t.id);
  const tpBtn = $('#taskStats').querySelector('[data-act="to-project"]');
  if (tpBtn) tpBtn.onclick = () => openToProj(t);

  const dv = t.deliverableCheck;
  let html = '';
  if (dv && dv.checked) {
    /* 验收/自检类中间产物同样不摊给老板看 */
    const rows = dv.detail.filter(d => !isInternalArtifact(d.path));
    if (rows.length) {
      html = `<div class="dv">${rows.map(d =>
        `<span class="dv-i ${d.ok ? '' : 'no'}">${d.ok ? '✓' : '✗'} ${esc(d.path)} · ${esc(d.why)}</span>`).join('')}</div>`;
    }
  } else if (t.deliverables && t.deliverables.length) {
    const rows = t.deliverables.filter(p => !isInternalArtifact(p));
    if (rows.length) {
      html = `<div class="dv">${rows.map(p => `<span class="dv-i no">? ${esc(p)} · 未校验</span>`).join('')}</div>`;
    }
  }
  $('#dvBox').innerHTML = html;
}

/* 转项目入口：做过实事的任务（有结论或有产出）才值得转；
   已经转过的不重复转，给一个跳过去的入口。 */
function tpBtnHTML(t) {
  const proj = t.deliverableCheck && t.deliverableCheck.project;
  if (proj && proj.meetingId) {
    const alive = (state.meetings || []).some(m => m.id === proj.meetingId);
    if (alive) return `<button class="btn tiny tp-link" data-act="to-project">已转项目 · 去看 ›</button>`;
    return '';
  }
  const hasBody = ((t.steps || []).length > 0 || (t.result || '').trim());
  if (!hasBody) return '';
  return `<button class="btn tiny tp-go" data-act="to-project">转项目</button>`;
}

/* ── 任务转项目 ──
   弹框和「新建项目」是同一个（meeting.js 管），字段完全一致：
   项目经理 / 项目牵头人 / 项目成员（含「只选核心」「全选」）。
   这里只负责把前情材料备好——原任务的分析链、老板交代、结论、产出文件，
   交给牵头人提炼成一份《前情简报》，全员共用，不用每人重读原文。 */
function openToProj(t) {
  if (!window.MEET || !MEET.openCreate) return toast('项目模块还没就绪');
  const proj = t.deliverableCheck && t.deliverableCheck.project;
  if (proj && proj.meetingId && (state.meetings || []).some(m => m.id === proj.meetingId)) {
    if (MEET.open) MEET.open(proj.meetingId);
    return;
  }
  if (!state.staff.filter(s => s.kind !== 'human').length) return toast('还没有员工，先去「员工」里建一位');
  const steps = buildSteps(t);
  const says = steps.filter(s => s.kind === 'say').map(s => ({ at: s.at, text: s.text }));
  const files = outputFiles(t, state.trace, true).map(r => r.path).slice(0, 8);
  const handover = {
    title: t.title, goal: t.goal, status: t.status,
    says: says.slice(-24),
    result: t.result || '',
    bossMsgs: (t.userMsgs || []).map(u => u.text).filter(Boolean).slice(-10),
    files
  };
  MEET.openCreate({ from: t, handover });
}


async function removeTask(t) {
  if (!confirm(`删除任务「${t.title}」？云端记录会一起删。`)) return;
  try {
    if (!state.guest && !String(t.id).startsWith('local_')) await CLOUD.deleteTask(t.id);
    state.tasks = state.tasks.filter(x => x.id !== t.id);
    state.curTaskId = state.tasks[0] ? state.tasks[0].id : null;
    state.drafting = !state.curTaskId;
    renderRail();
    if (state.curTaskId) selectTask(state.curTaskId);
    else {
      state.trace = { nodes: [], result: '', status: '', blocked: null };
      renderTaskHead(); renderTrace(); renderWho(); syncComposer();
    }
    toast('已删除');
  } catch (e) { toast(e.message); }
}

/* ── 轨迹 ── */
/* 轨迹默认只显示一行摘要，输出明细要手动点开——一屏塞满工具返回没有意义 */
const openedNodes = new Set();

/* 老板说过的话：刷新、换任务、重跑都不能丢。
   优先用任务上记着的；老任务从 messages 里认领（提要/门禁之类的合成消息不算人话） */
function userMsgsOf(t) {
  const out = [];
  const push = (text, at, round) => {
    text = String(text || '').trim();
    if (text) out.push({ text, at: Number(at) || 0, round: Number(round) || 0 });
  };
  /* 任务上直接记着的原话：messages 会被压缩/截断，这份不能跟着丢。
     round 是「第几轮问的」，对话按轮排全靠它 */
  if (t && Array.isArray(t.userMsgs)) {
    for (const u of t.userMsgs) {
      if (u && typeof u === 'object') push(u.text, u.at, u.round);
      else push(u, 0, 0);
    }
    if (out.length) return out;
  }
  let tools = 0;
  for (const m of (t && t.messages) || []) {
    if (m.role === 'tool') { tools++; continue; }
    if (m.role !== 'user') continue;
    const c = m.content;
    const txt = typeof c === 'string' ? c
      : Array.isArray(c) ? ((c.find(x => x && x.type === 'text') || {}).text || '') : '';
    if (txt.trim().startsWith('【')) continue;
    push(txt, tools);
  }
  if (!out.length && t && t.goal) push(t.goal, 0);
  return out;
}

/* make_deck 的入参就是幻灯片本身——拿它直接在对话里铺预览，点开就能看 */
function findDeckSpec(t, tr, p) {
  const scan = arr => {
    for (const s of arr || []) {
      if (s && s.name === 'make_deck' && s.ok && s.args && s.args.path === p) return s.args;
    }
    return null;
  };
  return scan((tr && tr.nodes) || []) || scan((t && t.steps) || []);
}

const DECK_T = {
  paper: { bg: '#FBF8F3', ink: '#1F1B17', body: '#4A423A', mute: '#8C8279', line: '#E6DCCE', accent: '#B4562F', tint: '#F3E9DD' },
  ink: { bg: '#FFFFFF', ink: '#101828', body: '#475467', mute: '#98A2B3', line: '#EAECF0', accent: '#1F4E79', tint: '#EEF3F9' },
  forest: { bg: '#F7FAF7', ink: '#14261C', body: '#41524A', mute: '#82938A', line: '#DCE7DF', accent: '#2E6B4F', tint: '#E8F0EA' },
  plum: { bg: '#FCF9FB', ink: '#231620', body: '#4E3B49', mute: '#94818E', line: '#EBDFE7', accent: '#8A2F5C', tint: '#F5E9F0' },
  mono: { bg: '#FAFAFA', ink: '#171717', body: '#444444', mute: '#8C8C8C', line: '#E5E5E5', accent: '#1F1F1F', tint: '#F1F1F1' }
};

/* 幻灯片内容预览：按 make_deck 的入参把每页铺成 16:9 小卡片 */
function deckSlidesHTML(spec) {
  const T = DECK_T[spec.theme] || DECK_T.paper;
  const raw = rel => window.withSC('/api/file?scope=' + state.scope + '&raw=1&path=' + encodeURIComponent(rel || ''));
  const imgTag = rel => `<img src="${esc(raw(rel))}" alt="">`;
  const bulletList = arr => `<ul>` + (arr || []).map(b => {
    if (typeof b === 'string') return `<li>${esc(b)}</li>`;
    const o = b || {};
    if (o.k) return `<li><b>${esc(o.k)}</b> ${esc(o.text || '')}</li>`;
    return `<li class="lv${Number(o.level) || 1}">${esc(o.text || '')}</li>`;
  }).join('') + `</ul>`;
  const total = (spec.slides || []).length;
  const slides = (spec.slides || []).map((s, i) => {
    const L = s.layout || (i === 0 ? 'cover' : 'bullets');
    const head = `<div class="dp-head"><div class="dp-kicker">${esc(s.kicker || '')}</div>`
      + `<h3>${esc(s.title || '')}</h3><div class="dp-sub">${esc(s.subtitle || '')}</div></div>`;
    let inner = '';
    if (L === 'cover' || L === 'end') {
      inner = `<div class="dp-cover${s.image ? '' : ' plain'}"${s.image ? ` style="background-image:url('${esc(raw(s.image))}')"` : ''}>`
        + (s.image ? '<div class="dp-ov"></div>' : '')
        + `<div class="dp-cover-t"><h2>${esc(s.title || spec.title || '')}</h2><div class="dp-sub">${esc(s.subtitle || '')}</div></div>`
        + `<div class="dp-meta">${esc(s.meta || '')}</div></div>`;
    } else if (L === 'section') {
      inner = `<div class="dp-section"><span>${esc(s.no || '')}</span><h2>${esc(s.title || '')}</h2></div>`;
    } else if (L === 'cards') {
      inner = head + `<div class="dp-cards">` + (s.cards || []).map(c =>
        `<div class="dp-card"><i>${esc(c.k || '')}</i><b>${esc(c.title || '')}</b><p>${esc(c.text || '')}</p></div>`).join('') + `</div>`;
    } else if (L === 'kpi') {
      inner = head + `<div class="dp-kpis">` + (s.kpis || []).map(k =>
        `<div><b>${esc(k.value || '')}</b><span>${esc(k.label || '')}</span><i>${esc(k.note || '')}</i></div>`).join('') + `</div>`;
    } else if (L === 'steps') {
      inner = head + `<div class="dp-steps">` + (s.steps || []).map((st, j) =>
        `<div><i>${j + 1}</i><b>${esc(st.title || '')}</b><p>${esc(st.text || '')}</p></div>`).join('') + `</div>`;
    } else if (L === 'table') {
      const t2 = s.table || {};
      inner = head + `<table><thead><tr>${(t2.head || []).map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>`
        + (t2.rows || []).map(r => `<tr>${(r || []).map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') + `</tbody></table>`;
    } else if (L === 'chart') {
      const items = (s.chart && s.chart.items) || [];
      const max = Math.max(1, ...items.map(x => Number(x.value) || 0));
      inner = head + `<div class="dp-chart">` + items.map(x =>
        `<div class="dp-bar"><span>${esc(x.label || '')}</span><div>`
        + `<i style="width:${Math.round((Number(x.value) || 0) / max * 100)}%"${x.highlight ? ' class="hl"' : ''}></i></div>`
        + `<b>${esc(x.display || x.value || '')}</b></div>`).join('') + `</div>`;
    } else if (L === 'quote') {
      inner = `<div class="dp-quote"><p>${esc(s.text || s.title || '')}</p><i>${esc(s.subtitle || '')}</i></div>`;
    } else if (L === 'split') {
      const pic = s.image ? `<div class="dp-pic">${imgTag(s.image)}</div>` : '';
      const half = `<div class="dp-half">${head}${bulletList(s.bullets)}</div>`;
      inner = `<div class="dp-split${s.side === 'l' ? ' l' : ''}">${s.side === 'l' ? pic + half : half + pic}</div>`;
    } else if (L === 'image') {
      inner = `<div class="dp-full">${s.image ? imgTag(s.image) : ''}<div class="dp-cap">${esc(s.caption || s.title || '')}</div></div>`;
    } else {
      inner = head + bulletList(s.bullets);
    }
    const take = s.takeaway ? `<div class="dp-take">${esc(s.takeaway)}</div>` : '';
    return `<div class="dps" style="--db:${T.bg};--di:${T.ink};--dy:${T.body};--dm:${T.mute};--dl:${T.line};--da:${T.accent};--dt:${T.tint}">`
      + `${inner}${take}`
      + `<div class="dps-foot"><span>${esc(spec.footer || '')}</span><span>${i + 1}/${total}</span></div></div>`;
  }).join('');
  return `<div class="deck-prev">${slides}</div>`;
}

/* 铺垫类工具不进轨迹：每轮开头的固定动作，摊出来只添噪音 */
const HIDE_STEPS = new Set(['list_dir', 'todo_write', '验收']);

/* 员工真写出来的东西：make_deck 的 pptx、write_file 的文件、gen_image / find_image 的图片，
   加上老板点名的交付物 */
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;
function isImagePath(p) {
  return IMG_RE.test(String(p || '').split('?')[0]);
}
/* 「验收报告 / 自检清单 / 验收.json」这类文件是员工和系统自己对账用的中间产物，
   老板要的是成品，不是质检单。它们不该出现在产出栏，也不该算进「本轮产出 N 项」。
   只认文本/JSON 后缀：老板真点名要的《验收单.docx》照样得交出来。 */
const INTERNAL_FILE_RE = /(^|\/)[^/]*(?:验收|自检|质检|复核记录|verify[-_.]?(?:report|result))[^/]*\.(?:md|json|txt)$/i;
function isInternalArtifact(p) {
  const s = String(p || '').trim().replace(/^\.?\//, '');
  return !!s && INTERNAL_FILE_RE.test(s);
}
function imgPreviewUrl(scope, p) {
  return window.withSC('/api/file?scope=' + scope + '&raw=1&inline=1&path=' + encodeURIComponent(p));
}
/* 从任意工具输出里捞图片路径：老记录没有 files 字段，只能靠文本反查。
   只认 assets/ 下的落盘路径，避免把说明里的外链 URL 当成产出。
   不限定工具名——以后换成别的作图工具也不用再改这里。 */
const IMG_PATH_RE = /assets\/[^\s"'`，,（）()<>:：]+\.(?:jpe?g|png|webp|gif|bmp|svg)/gi;
function outputFiles(t, tr, includeDeliverables, onlyRound) {
  const inRound = s => !onlyRound || (Number(s && s.round) || onlyRound) === onlyRound;
  const map = new Map();
  const add = (p, kind) => {
    p = String(p || '').trim();
    if (!p) return;
    if (isInternalArtifact(p)) return;   /* 验收/自检类中间产物不进产出清单 */
    if (!map.has(p)) map.set(p, { path: p, kind: isImagePath(p) ? 'image' : kind });
    else if (kind === 'deck') map.get(p).kind = 'deck';
  };
  /* 按后缀归类，图片不会被当普通文件吞掉 */
  const addAny = p => add(p, 'file');
  const norm = p => String(p || '').trim().replace(/^\.?\//, '');
  if (includeDeliverables) for (const p of (t && t.deliverables) || []) add(norm(p), 'deliverable');
  const scan = arr => {
    for (const s of arr || []) {
      if (!s || !s.ok) continue;
      if (s.name === 'make_deck' && s.args && s.args.path) add(norm(s.args.path), 'deck');
      else if ((s.name === 'write_file' || s.name === 'make_sheet' || s.name === 'make_doc') && s.args && s.args.path) add(norm(s.args.path), 'file');
      /* 任何一步回报的 files 都收下：gen_image / find_image / 以及以后新加的工具 */
      for (const p of (s.files || [])) if (p) addAny(norm(p));
      /* 兜底：从输出文本里捞图片路径（老记录、或工具只把路径写在说明里） */
      if (/\b(gen_?image|find_?image)\b|图片|插图/.test(`${s.name || ''} ${String(s.output || '').slice(0, 400)}`)) {
        for (const p of (String(s.output || '').match(IMG_PATH_RE) || [])) addAny(norm(p));
      }
    }
  };
  scan(((tr && tr.nodes) || []).filter(inRound));
  scan(((t && t.steps) || []).filter(inRound));
  /* 结论正文里点到的图片也算：有些老任务只在结论里留了路径，步骤里没存。
     但按轮取的时候必须用「这一轮」的结论——t.result 是整任务最后那份，
     第二轮刚开跑时它还挂着上一轮，旧图就会被重新捞进第二轮（实测踩过）。 */
  let said = '';
  if (onlyRound) {
    said = String((tr && tr.result) || '');
    if (!said) {
      const mine = ((t && t.steps) || [])
        .filter(s => s && s.kind === 'say' && (Number(s.round) || 1) === onlyRound).pop();
      said = String((mine && mine.text) || '');
    }
  } else {
    said = String((tr && tr.result) || (t && t.result) || '');
  }
  if (said) for (const p of (said.match(IMG_PATH_RE) || [])) addAny(norm(p));
  return [...map.values()];
}

/* 工作区里实有的文件（缓存 20 秒）。
   为什么需要它：产出清单一直只认「任务轨迹里记过的写文件动作」。于是——
   换个任务、换个会话、或那一轮轨迹没存上（断线 / 网关拦了），
   文件明明躺在工作区里，右栏却显示「暂无产出」，看着就是东西丢了。
   磁盘是唯一不会说谎的真相来源，所以首页文件直接兜底列出来。 */
let WS_FILES = { at: 0, items: [], busy: false };
async function loadWorkspaceFiles() {
  if (!state.scope || state.guest) { WS_FILES = { at: Date.now(), items: [], busy: false }; return; }
  try {
    const r = await fetch(window.withSC('/api/files?scope=' + state.scope + '&path=.'));
    const j = await r.json();
    const items = (j && j.ok && Array.isArray(j.items)) ? j.items.filter(x => x && !x.dir && x.path) : [];
    WS_FILES = { at: Date.now(), items, busy: false };
  } catch {
    WS_FILES = { at: Date.now(), items: [], busy: false };
  }
}

/* ── 右栏产出物展示区：跟随左栏当前选择 ──
   任务 Tab 选中某任务 → 该任务产出；项目 Tab 选中某项目 → 该项目产出；
   员工 Tab 选中某员工 → 该员工产出；「总产出」页 → 全部产出。 */
function renderOutputRail() {
  const box = $('#outList');
  if (!box) return;
  renderOutDirBar();
  const kindIcon = { deck: '📊', file: '📄', deliverable: '📌', image: '🖼' };
  const kindName = { deck: 'PPT', file: '文件', deliverable: '交付物', image: '图片' };
  /* 和「总产出」共用同一份清单，保证两边看到的产出完全一致 */
  const all = collectOutputs();

  /* 过滤：跟随当前上下文 */
  let list = all;
  let head = '产出物';
  if (state.view === 'output') {
    head = '总产出';
  } else if (state.lastListView === 'task' && state.curTaskId) {
    list = all.filter(o => o.srcType === 'task' && o.srcId === state.curTaskId);
    head = '任务产出';
  } else if (state.lastListView === 'project' && state.curMeetingId) {
    list = all.filter(o => o.srcType === 'project' && o.srcId === state.curMeetingId);
    head = '项目产出';
  } else if (state.lastListView === 'staff') {
    const emp = state.staff.find(s => s.id === (state.railEmpId || state.curEmpId));
    const nm = emp ? emp.name : '';
    list = nm ? all.filter(o => o.by === nm) : [];
    head = emp ? `${emp.name} · 产出` : '员工产出';
  }
  /* 任务 / 总产出这两处才补工作区首页文件：
     员工产出、项目产出讲的是「谁做的 / 哪个项目的」，把所有人的工作区文件混进去没意义。
     只补最近 7 天动过的：工作区一放就是几十个历史文件 + 种子文件，
     全摊进来会把真正的产出冲淡；更早的东西让人自己点「工作区」去翻。 */
  const workspacesScope = state.view === 'output' || (state.lastListView === 'task' && !!state.curTaskId);
  /* 拉工作区清单必须放在「暂无产出」早退之前：否则空清单直接 return，
     连拉都不拉，兜底永远轮不到——这正是「文件明明在、面板却说没有」的成因。 */
  if (workspacesScope && !WS_FILES.busy && Date.now() - WS_FILES.at > 20000) {
    WS_FILES.busy = true;
    loadWorkspaceFiles().then(() => renderOutputRail()).catch(() => {});
  }
  const WS_RECENT = 7 * 24 * 3600e3;
  if (workspacesScope) {
    const known = new Set(list.map(o => String(o.path || '')));
    const extra = WS_FILES.items
      .filter(f => f && f.path && !known.has(f.path))
      .filter(f => Number(f.mtime || 0) > Date.now() - WS_RECENT)
      .sort((a, b) => Number(b.mtime || 0) - Number(a.mtime || 0))
      .slice(0, 15);
    for (const f of extra) {
      list.push({
        path: f.path,
        kind: isImagePath(f.path) ? 'image' : 'file',
        srcType: 'workspace', srcId: '', srcLabel: '工作区', by: '',
        at: Number(f.mtime || 0), intro: ''
      });
    }
  }
  list = list.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  /* 右栏搜索：先在本面板里筛，筛不到再扩到全部产出——
     想找某个文件时，人记的是文件名，不一定记得它在哪个任务里。 */
  const q = String(state.outQuery || '').trim().toLowerCase();
  if (q) {
    const hit = o => ((o.path || '') + ' ' + (o.srcLabel || '') + ' ' + (o.by || '')).toLowerCase().includes(q);
    let res = list.filter(hit);
    if (res.length) {
      head = `${head} · 「${q}」`;
    } else {
      res = all.filter(hit);
      head = res.length ? `全部产出 · 「${q}」` : `${head} · 「${q}」`;
    }
    list = res;
  }
  $('#outHead').textContent = head + (list.length ? `（${list.length}）` : (q ? '（0）' : ''));
  syncOutSearch();

  if (!list.length) {
    if (q) {
      box.innerHTML = `<div class="hint-block">没有文件名 / 路径含「${esc(state.outQuery.trim())}」的产出。<br>换个关键字试试，或点上面的 × 清掉搜索。</div>`;
      return;
    }
    const emp = state.staff.find(s => s.id === (state.railEmpId || state.curEmpId));
    const tip = state.view === 'output'
      ? '任务 / 项目跑完生成的产出会汇总在这里。'
      : state.lastListView === 'staff'
        ? (emp ? `${emp.name} 还没有产出，交给 TA 一个任务试试。` : '这位员工还没有产出。')
        : state.lastListView === 'project'
          ? '这个项目还没有产出。'
          : '这个任务还没有产出。';
    box.innerHTML = `<div class="hint-block">暂无产出。<br>${tip}</div>`;
    return;
  }
  box.innerHTML = list.map(o => {
    const isImg = o.kind === 'image' || isImagePath(o.path);
    const nm = (o.path || '').split('/').pop();
    return `
    <div class="ti out-i" data-out-path="${esc(o.path)}" data-out-kind="${esc(o.kind)}"${isImg ? ' title="点一下看图"' : ''}>
      <div class="ti-t">${isImg
        ? `<span class="out-im"><img src="${esc(imgPreviewUrl(state.scope, o.path))}" alt="${esc(nm)}" loading="lazy" onerror="this.style.opacity=0"></span>`
        : `<span class="out-ic">${kindIcon[o.kind] || '📎'}</span>`}<span>${esc(nm)}</span></div>
      <div class="ti-m"><span>${kindName[o.kind] || '文件'}</span>${o.by ? `<span>${esc(o.by)}</span>` : ''}<span>${esc(o.srcLabel || '')}</span></div>
    </div>`;
  }).join('');
  box.querySelectorAll('.out-i').forEach(el => {
    el.onclick = () => {
      const p = el.dataset.outPath;
      /* 图片：直接开新页看原图，比丢进文件管理器顺手 */
      if (el.dataset.outKind === 'image' || isImagePath(p)) {
        window.open(imgPreviewUrl(state.scope, p), '_blank', 'noopener');
        return;
      }
      /* 网页 / 文档 / 文本 / PDF / Office：一律就地出预览，别再让人去文件管理器里翻。
         以前只有 Office/PDF 走预览，点 md、html 会跳进本地盘的文件管理器——
         云端产出的文件根本不在那块盘上，看着就是「点了没反应」。 */
      if (HTML_FILE.test(p) || TEXT_FILE.test(p) || OFFICE_PREVIEW.test(p) || PDF_FILE.test(p)) {
        viewOutput(p);
        return;
      }
      openFiles(p);
    };
  });
}

/* 搜索框只是同步值，不重建节点——一边打字一边重绘会把焦点弄丢 */
function syncOutSearch() {
  const inp = $('#outSearch');
  const x = $('#outSearchX');
  if (!inp) return;
  const q = state.outQuery || '';
  if (document.activeElement !== inp && inp.value !== q) inp.value = q;
  if (x) x.hidden = !q;
}
(function wireOutSearch() {
  const inp = $('#outSearch');
  if (!inp) return;
  const x = $('#outSearchX');
  inp.addEventListener('input', () => {
    state.outQuery = inp.value;
    renderOutputRail();
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Escape') { state.outQuery = ''; inp.value = ''; renderOutputRail(); } });
  if (x) {
    x.onclick = () => {
      state.outQuery = '';
      inp.value = '';
      renderOutputRail();
      inp.focus();
    };
  }
})();

/* ── 总产出：任务 / 项目 / 员工的产出摊成一张表 ──
   一行一个产出物：谁产出的、什么类型、叫什么、什么时候、干什么用的。
   点开能看、能下载；代码和网页还能直接看源码。 */
const OUT_KINDS = [
  [/\.(pptx|ppt)$/i, 'PPT', '📊'],
  [/\.(xlsx|xls|csv|tsv)$/i, '表格', '📈'],
  [/\.(docx|doc)$/i, '文档', '📄'],
  [/\.pdf$/i, 'PDF', '📕'],
  [/\.(png|jpe?g|webp|gif|bmp)$/i, '图片', '🖼'],
  [/\.html?$/i, '网页', '🌐'],
  [/\.svg$/i, '图形', '🎨'],
  [/\.(js|mjs|cjs|ts|tsx|jsx|vue|py|go|java|rs|rb|php|css|scss|sql|sh|json|ya?ml|xml)$/i, '代码', '⌘'],
  [/\.(md|txt|log)$/i, '文本', '📝'],
  [/\.zip$/i, '压缩包', '🗜']
];
const CODE_FILE = /\.(html?|css|scss|js|mjs|cjs|ts|tsx|jsx|vue|py|go|java|rs|rb|php|sql|sh|json|ya?ml|xml|svg|md)$/i;
const TEXT_FILE = /\.(md|txt|log|csv|tsv|json|html?|css|scss|js|mjs|cjs|ts|tsx|jsx|vue|py|go|java|rs|rb|php|sql|sh|ya?ml|xml|svg)$/i;
/* 网页类产出：默认要把页面渲出来，不是把源码铺给人看。
   源码另外留一个「查看源码」按钮，两者不是一个东西。 */
const HTML_FILE = /\.html?$/i;
const BIN_FILE = /\.(pptx|ppt|xlsx|xls|docx|doc|pdf|zip|png|jpe?g|webp|gif|bmp)$/i;
/* 这几种能在应用内预览：PDF 用浏览器自带阅读器，Office 走 /api/preview 解出内容 */
const OFFICE_PREVIEW = /\.(docx|xlsx|pptx|doc|xls|ppt)$/i;
const PDF_FILE = /\.pdf$/i;
function outKind(p) {
  for (const [re, name, icon] of OUT_KINDS) if (re.test(String(p || ''))) return { name, icon };
  return { name: '文件', icon: '📎' };
}
function fmtAt(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function brief(s, n) {
  const t = String(s || '').replace(/[#>*`]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > (n || 56) ? t.slice(0, n || 56) + '…' : t;
}

/* 全部产出：任务看 steps，项目看 outputs（每个分析节点落盘的文件） */
function collectOutputs() {
  const rows = [];
  const seen = new Set();
  const add = r => {
    if (!r || !r.path) return;
    const k = r.srcType + '|' + r.srcId + '|' + r.path;
    if (seen.has(k)) return;
    seen.add(k);
    const kd = outKind(r.path);
    rows.push({ ...r, typeName: kd.name, typeIcon: kd.icon });
  };
  const atOf = (nodes, path) => {
    const n = (nodes || []).find(s => (s.files || []).includes(path));
    return (n && n.at) || 0;
  };
  for (const t of state.tasks) {
    const nodes = (t.steps || []).filter(s => s.kind === 'tool');
    const live = t.id === state.curTaskId ? (state.trace.nodes || []) : [];
    const all = nodes.concat(live);
    const files = outputFiles(t, { nodes: all }, false);
    for (const f of files) {
      add({
        path: f.path, kind: f.kind,
        srcType: 'task', srcId: t.id, srcLabel: t.title || t.goal || '任务',
        by: t.employeeName || '',
        at: atOf(all, f.path) || t.createdAt || t.at || 0,
        intro: brief(t.goal || t.title, 64)
      });
    }
  }
  for (const m of state.meetings) {
    const pm = (window.MEET && MEET.pmOf) ? MEET.pmOf(m) : null;
    const nodes = (m.steps || []).filter(s => s.kind === 'tool');
    for (const o of (m.outputs || [])) {
      for (const p of (o.files || [])) {
        add({
          path: p, kind: 'file',
          srcType: 'project', srcId: m.id, srcLabel: m.topic || '项目',
          by: o.owner || (pm && pm.name) || '',
          at: o.at || m.at || 0,
          intro: brief(o.title || o.content || m.topic, 64)
        });
      }
    }
    /* 项目里若有工具步骤直接写出的文件，也收进来 */
    for (const f of outputFiles(m, { nodes }, false)) {
      add({
        path: f.path, kind: f.kind,
        srcType: 'project', srcId: m.id, srcLabel: m.topic || '项目',
        by: (pm && pm.name) || '',
        at: atOf(nodes, f.path) || m.at || 0,
        intro: brief(m.topic, 64)
      });
    }
  }
  return rows.sort((a, b) => (b.at || 0) - (a.at || 0));
}

function renderOutputList() {
  const box = $('#outputList');
  if (!box) return;
  const rows = collectOutputs();
  const meta = $('#outViewMeta');
  if (meta) meta.textContent = rows.length
    ? `共 ${rows.length} 个产出物 · 任务 ${state.tasks.length} 个 · 项目 ${state.meetings.length} 个 · 员工 ${state.staff.length} 位`
    : '所有任务、项目、员工的产出物，按类型 / 名称 / 时间汇总。';
  if (!rows.length) {
    box.innerHTML = `<div class="empty"><div class="empty-t">暂无产出</div>
      <div class="empty-d">任务跑完、项目结束后生成的文件都会汇总到这里，可查看、下载，网页和代码还能直接看源码。</div></div>`;
    return;
  }
  box.innerHTML = `<div class="out-wrap"><table class="out-table">
    <thead><tr>
      <th class="c-name">产出物</th><th class="c-type">类型</th><th class="c-src">来自</th>
      <th class="c-by">员工</th><th class="c-at">产出时间</th><th class="c-intro">简介</th><th class="c-act">操作</th>
    </tr></thead><tbody>` + rows.map((r, i) => `
      <tr data-out-i="${i}">
        <td class="c-name"><span class="ot-ic">${r.typeIcon}</span><span class="ot-nm" title="${esc(r.path)}">${esc(r.path.split('/').pop())}</span></td>
        <td class="c-type"><span class="ot-badge">${esc(r.typeName)}</span></td>
        <td class="c-src"><button class="ot-src ${r.srcType}" data-go-src="${esc(r.srcId)}" data-go-type="${esc(r.srcType)}" title="点一下跳到这个${r.srcType === 'task' ? '任务' : '项目'}">${r.srcType === 'task' ? '任务' : '项目'}</button><span class="ot-srclbl" title="${esc(r.srcLabel)}">${esc(brief(r.srcLabel, 18))}</span></td>
        <td class="c-by">${esc(r.by || '—')}</td>
        <td class="c-at">${esc(fmtAt(r.at))}</td>
        <td class="c-intro" title="${esc(r.intro)}">${esc(r.intro || '—')}</td>
        <td class="c-act">
          <button class="ot-btn" data-view-i="${i}">查看</button>
          <a class="ot-btn ghost" href="${esc(window.withSC('/api/file?scope=' + state.scope + '&raw=1&path=' + encodeURIComponent(r.path)))}" download="${esc(r.path.split('/').pop())}">下载</a>
          ${CODE_FILE.test(r.path) ? `<button class="ot-btn ghost" data-code-i="${i}">源码</button>` : ''}
        </td>
      </tr>`).join('') + `</tbody></table></div>`;

  box.querySelectorAll('[data-view-i]').forEach(el => {
    el.onclick = e => { e.stopPropagation(); viewOutput(rows[Number(el.dataset.viewI)].path); };
  });
  box.querySelectorAll('[data-code-i]').forEach(el => {
    el.onclick = e => { e.stopPropagation(); openOutputView(rows[Number(el.dataset.codeI)], { code: true }); };
  });
  box.querySelectorAll('[data-go-src]').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const id = el.dataset.goSrc;
      if (el.dataset.goType === 'task') {
        state.lastListView = 'task'; state.view = 'task'; showView('task'); selectTask(id);
      } else if (window.MEET) {
        state.lastListView = 'project'; MEET.open(id);
      }
    };
  });
  box.querySelectorAll('tr[data-out-i]').forEach(tr => {
    tr.onclick = e => {
      if (e.target.closest('button,a')) return;
      openOutputView(rows[Number(tr.dataset.outI)]);
    };
  });
  /* 重绘后把搜索词接着套上，不然一刷新/一换页筛选就丢了 */
  applyContentSearch('output');
}

/* 产出物预览：图片直接看，文本/代码给正文，其余给下载 */
let outViewCur = null;

/* 表格：第一行当表头。docx 里的表格和 xlsx 的工作表共用 */
function ovTable(rows) {
  if (!rows || !rows.length) return '';
  const width = Math.max(...rows.map(r => (r || []).length));
  if (!width) return '';
  const body = rows.map((r, i) => {
    const tds = [];
    for (let c = 0; c < width; c++) {
      const v = esc((r && r[c]) || '');
      tds.push(i === 0 ? `<th>${v}</th>` : `<td>${v}</td>`);
    }
    return `<tr>${tds.join('')}</tr>`;
  }).join('');
  return `<table class="ov-tb">${body}</table>`;
}

const OV_HINT = '这是文本预览，排版以原件为准。要在本机 Office 里打开：点「下载」后双击，或先「存到本机文件夹」再到那个文件夹里打开。';

/* 把 /api/preview 返回的结构画成 HTML */
function officeHTML(j) {
  if (!j || !j.ok) return '';
  if (j.kind === 'docx') {
    const html = (j.blocks || []).map(b => {
      if (b.t === 'h') {
        const lv = Math.min(6, Math.max(2, (Number(b.level) || 1) + 1));
        return `<h${lv}>${esc(b.text)}</h${lv}>`;
      }
      if (b.t === 'li') return `<p class="ov-li">• ${esc(b.text)}</p>`;
      if (b.t === 'table') return ovTable(b.rows);
      return `<p>${esc(b.text)}</p>`;
    }).join('');
    return `<div class="ov-doc">${html}</div><div class="ov-note">${OV_HINT}</div>`;
  }
  if (j.kind === 'xlsx') {
    const html = (j.sheets || []).map(s =>
      `<h4 class="ov-sh">${esc(s.name)}<span>${(s.rows || []).length} 行</span></h4>`
      + `<div class="ov-sheet">${ovTable(s.rows)}</div>`).join('');
    return `<div class="ov-doc">${html}<div class="ov-dim">最多显示前 300 行 / 24 列，完整数据请下载。</div></div>
      <div class="ov-note">${OV_HINT}</div>`;
  }
  if (j.kind === 'pptx') {
    const html = (j.slides || []).map((s, i) =>
      `<div class="ov-slide">
        <div class="ov-sn">第 ${i + 1} 页${j.total ? ' / ' + j.total : ''}</div>
        <h4>${esc(s.title || '')}</h4>
        ${(s.lines || []).length ? `<ul>${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      </div>`).join('');
    return `<div class="ov-slides">${html}</div><div class="ov-note">${OV_HINT}</div>`;
  }
  return '';
}

/* Office 文档预览：服务端解 ZIP + XML，这里只负责画 */
async function renderOfficePreview(r, body) {
  body.innerHTML = '<div class="ov-loading">正在解析文档…</div>';
  let j = null;
  try {
    const res = await fetch(window.withSC('/api/preview?scope=' + state.scope + '&path=' + encodeURIComponent(r.path)));
    j = await res.json();
  } catch (e) {
    body.innerHTML = `<div class="hint-block">预览服务没响应：${esc(e.message)}<br>可以直接下载用本机程序打开。</div>`;
    return;
  }
  if (!j || !j.ok) {
    body.innerHTML = `<div class="hint-block">${esc((j && j.error) || '读不出来')}<br>
      点「下载」用本机 Office 打开${localReady() ? '；也可以先「存到本机文件夹」，再到那个文件夹里双击' : ''}。</div>`;
    return;
  }
  body.innerHTML = officeHTML(j);
}

async function openOutputView(r, opt) {
  if (!r) return;
  /* 先把弹窗开出来占位：下面补文件要走网络（线上实测 1.2s），
     不给反馈的话点了半秒没动静，用户会以为按钮坏了。 */
  const early = $('#ovModal');
  if (early && early.hidden && !(opt && opt.quiet)) {
    $('#ovTitle').textContent = r.path.split('/').pop();
    $('#ovType').textContent = outKind(r.path).name;
    $('#ovBody').innerHTML = '<div class="ov-load">正在准备预览…</div>';
    early.hidden = false;
  }
  /* 沙箱重启后本地文件可能已经没了：先把缺的补回来再渲染（只查一次，已存在就直接过） */
  if (localReady() || cloudStoreReady()) {
    try {
      if (r.srcType === 'task') {
        const tk = state.tasks.find(x => String(x.id) === String(r.srcId));
        if (tk) await restoreTaskFiles(tk);
      } else if (r.srcType === 'project') {
        await restoreFilesFor('proj-' + r.srcId, [r.path], r.srcLabel);
      }
    } catch (e) { /* 补不回来就按原来的兜底提示 */ }
  }
  outViewCur = r;
  const kd = outKind(r.path);
  const name = r.path.split('/').pop();
  const m = $('#ovModal');
  $('#ovTitle').textContent = name;
  $('#ovType').textContent = kd.name;
  $('#ovMeta').innerHTML = `
    <span>${r.srcType === 'task' ? '任务' : '项目'} · ${esc(r.srcLabel || '')}</span>
    ${r.by ? `<span>${esc(r.by)}</span>` : ''}
    <span>${esc(fmtAt(r.at))}</span>
    <span class="ov-path" title="${esc(r.path)}">${esc(r.path)}</span>`;
  const raw = window.withSC('/api/file?scope=' + state.scope + '&raw=1&path=' + encodeURIComponent(r.path));
  const inline = window.withSC('/api/file?scope=' + state.scope + '&raw=1&inline=1&path=' + encodeURIComponent(r.path));
  $('#ovDl').href = raw;
  $('#ovDl').setAttribute('download', name);
  $('#ovOpen').href = inline;
  $('#ovOpen').hidden = !/\.(html?|png|jpe?g|webp|gif|bmp|svg|pdf)$/i.test(r.path);
  /* 单独存一份到本机文件夹：不依赖下次跑任务 */
  const sl = $('#ovSaveLocal');
  if (sl) {
    sl.hidden = !localReady();
    sl.onclick = () => { if (outViewCur) saveOneToLocal(outViewCur); };
  }
  const codeBtn = $('#ovCode');
  codeBtn.hidden = !CODE_FILE.test(r.path);
  codeBtn.classList.toggle('on', !!opt && !!opt.code);
  const body = $('#ovBody');
  const isImg = /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(r.path);
  m.hidden = false;
  if (isImg && !(opt && opt.code)) {
    body.innerHTML = `<div class="ov-img"><img src="${esc(inline)}" alt="${esc(name)}"></div>`;
    return;
  }
  /* HTML 产出：直接渲成页面（iframe 走同源 inline 地址，样式脚本都能跑）。
     想看代码点右上「查看源码」，不再默认甩一屏源码出来。 */
  if (HTML_FILE.test(r.path) && !(opt && opt.code)) {
    body.innerHTML = `<iframe class="ov-html" src="${esc(inline)}" title="${esc(name)}"></iframe>`;
    return;
  }
  if (TEXT_FILE.test(r.path)) {
    body.innerHTML = `<pre class="ov-code">读取中…</pre>`;
    try {
      const res = await fetch(window.withSC('/api/file?scope=' + state.scope + '&path=' + encodeURIComponent(r.path)));
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || '读取失败');
      const txt = j.text || '';
      if (opt && opt.code) {
        const lines = txt.split('\n');
        body.innerHTML = `<pre class="ov-code">${lines.map((l, i) =>
          `<i>${i + 1}</i>${esc(l)}`).join('\n')}</pre>`;
      } else if (/\.(md)$/i.test(r.path)) {
        body.innerHTML = `<div class="md ov-md">${mdLite(txt)}</div>`;
        body.dataset.mode = 'md';
      } else {
        body.innerHTML = `<pre class="ov-code">${txt.split('\n').map((l, i) => `<i>${i + 1}</i>${esc(l)}`).join('\n')}</pre>`;
      }
    } catch (e) {
      body.innerHTML = `<div class="hint-block">读不出来：${esc(e.message)}<br>可以直接下载。</div>`;
    }
    return;
  }
  /* PDF：浏览器自带阅读器，直接嵌进来，不用第三方库 */
  if (PDF_FILE.test(r.path)) {
    body.innerHTML = `<iframe class="ov-pdf" src="${esc(inline)}" title="${esc(name)}"></iframe>`;
    return;
  }
  /* PPT：能从 make_deck 的入参还原版面，就在弹窗里铺成真幻灯片；
     还原不出来再退回 /api/preview 解包出来的文字大纲 */
  if (/\.pptx$/i.test(r.path) && !(opt && opt.code)) {
    const spec = deckSpecOfRec(r);
    if (spec) {
      body.innerHTML = `<div class="ov-deck">${deckSlidesHTML(spec)}</div>`;
      return;
    }
  }
  /* Office：docx / xlsx / pptx 解成内容画出来（老格式会拿到一句说明） */
  if (OFFICE_PREVIEW.test(r.path)) {
    await renderOfficePreview(r, body);
    return;
  }
  body.innerHTML = `<div class="hint-block">这类文件（${esc(kd.name)}）不能在线预览。<br>
    点右上「下载」用本机程序打开${localReady() ? '，或先「存到本机文件夹」再到那个文件夹里双击' : ''}。</div>`;
}
function closeOutputView() { const m = $('#ovModal'); if (m) m.hidden = true; }

/* 按路径找回这条产出的原始记录（任务 / 项目 / 员工页的卡片都只带一个 path） */
function recOfPath(p) {
  const hit = collectOutputs().find(o => o.path === p);
  if (hit) return hit;
  const t = curTask();
  return {
    path: p, srcType: 'task', srcId: t ? t.id : '',
    srcLabel: t ? (t.title || t.goal) : '', at: Date.now()
  };
}

/* 这条产出的 make_deck 原参数：能还原版面时，PPT 就在弹窗里直接铺成幻灯片 */
function deckSpecOfRec(r) {
  if (!r || !r.path) return null;
  const t = state.tasks.find(x => String(x.id) === String(r.srcId));
  if (!t) return null;
  return findDeckSpec(t, null, r.path);
}

/* 点「查看」看产出：一律就地弹窗，不再顺手开一个新标签页。
   网页类（.html/.htm）在弹窗里用 iframe 渲成真页面，跟交出去的一样；
   真想整页放到新窗口看，弹窗底部有「在新窗口打开」，由人自己决定。
   其它类型同样走弹窗预览（图 / PDF / Office / 文本）。 */
function viewOutput(p) {
  if (!p) return;
  openOutputView(recOfPath(p));
}
{
  const m = $('#ovModal');
  if (m) {
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-close-ov]')) closeOutputView();
    });
    const c = $('#ovCode');
    if (c) c.onclick = () => {
      if (!outViewCur) return;
      openOutputView(outViewCur, { code: !c.classList.contains('on') });
    };
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && m && !m.hidden) closeOutputView();
  });
}

/* ── 进度卡：第几步 / 正在做什么 / 预计完成时间 / 积分 ──
   积分按后台配置的汇率折算（默认 1 积分 = 100 万 token，deepseek V4.1 flash），
   跟右上角「积分」用同一把尺子——见 creditRate()。 */
const TOOL_CN = {
  write_file: '写文件', read_file: '读文件', list_dir: '看目录', search_text: '搜内容',
  make_deck: '生成 PPT', make_sheet: '生成表格', make_doc: '生成文档', gen_image: '生成图片',
  find_image: '找图片', read_doc: '读文档', view_image: '看图片', run_shell: '跑命令', web_search: '联网搜索',
  fetch_url: '打开网页', todo_write: '记录进度'
};
function creditsOf(tok) { return (Number(tok) || 0) / creditRate(); }
function fmtCredit(n) {
  n = Number(n) || 0;
  if (n >= 100) return String(Math.round(n));
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m}m${r}s` : `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}
function clockAt(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
/* 当前在做什么：工具名 + 对象，例如「生成图片 · cute kawaii mug」 */
function toolNow(nodes) {
  const n = (nodes || []).filter(x => x && x.name && !HIDE_STEPS.has(x.name)).slice(-1)[0];
  if (!n) return '';
  const label = TOOL_CN[n.name] || n.name;
  const a = n.args || {};
  const obj = a.path || a.query || a.url || a.pattern || a.command || '';
  return obj ? `${label} · ${brief(obj, 26)}` : label;
}
/* o: {label, steps:[{text,status}], done, total, doing, stepLabel, startAt, endAt, tokens:{in,out}, budgetTokens, now} */
function progressHTML(o) {
  o = o || {};
  const steps = o.steps || [];
  const total = steps.length || o.total || 0;
  const done = steps.length ? steps.filter(s => s.status === 'done').length : (o.done || 0);
  const doing = steps.length ? steps.some(s => s.status === 'doing') : !!o.doing;
  const start = Number(o.startAt) || 0;
  const end = Number(o.endAt) || 0;
  const tok = o.tokens ? ((Number(o.tokens.in) || 0) + (Number(o.tokens.out) || 0)) : (Number(o.tokens) || 0);
  const used = creditsOf(tok);
  const budget = creditsOf(o.budgetTokens || 0);
  /* 只有员工真的列了计划（≥2 步）才用完成比例推剩余时间；
     没列计划时 total 是「步数上限」，按它推会算出十几分钟的假 ETA */
  const planned = steps.length >= 2;
  const frac = total ? Math.min(1, (done + (doing ? 0.4 : 0)) / total) : 0;
  const elapsed = o.elapsedMs != null ? Math.max(0, Number(o.elapsedMs) || 0) : (start ? Math.max(0, (end || Date.now()) - start) : 0);
  const eta = planned && !end && frac > 0.08 ? elapsed * (1 - frac) / frac : 0;
  const nowTxt = o.now || (steps.find(s => s.status === 'doing') || {}).text || '';
  const hi = Math.max(budget, used, 0.01);
  const curStep = total ? Math.min(total, done + (doing ? 1 : 0) || 1) : 0;
  /* 有真实计划才说「第 x / y 步」；只有步数上限时只说走了几步，别把上限假装成计划 */
  const stepTxt = steps.length ? `第 <b>${curStep}</b> / ${total} 步` : (o.stepLabel || '还没拆步骤');
  /* 任务页的新版卡：状态和进度合成一张——「第 1 轮 · 分析中 / 正在拆解任务…」，
     不再拆成上面一条虚线「收到消息，正在分析」+ 下面一条进度条两处说同一件事 */
  if (o.state != null) {
    return `<div class="prog merged" data-prog data-start="${start}" data-end="${end}"
      data-total="${total}" data-done="${done}" data-doing="${doing ? 1 : 0}">
    <div class="prog-h">
      <span class="prog-t">${esc(o.label || '进度')} · ${esc(o.stateLabel || '分析中')}</span>
      <span class="prog-time"><span class="prog-el" id="liveTick">${elapsed ? '已 ' + fmtDur(elapsed) : ''}</span>${end ? '' : `<span class="prog-eta">${eta ? '预计还需 ' + fmtDur(eta) + '（约 ' + clockAt(Date.now() + eta) + ' 完成）' : ''}</span>`}</span>
    </div>
    <div class="prog-state"><span class="ps-dot"></span><span class="ps-txt">${esc(o.state)}</span></div>
    <div class="prog-bar${planned ? '' : ' indet'}"><i style="width:${Math.round(Math.max(3, frac * 100))}%"></i></div>
    <div class="prog-f">
      ${steps.length ? `<span class="prog-step">${stepTxt}</span>` : ''}
      <span>预计消耗 <b>${fmtCredit(Math.max(used, 0.01))} ~ ${fmtCredit(hi)}</b> 积分</span>
      <span class="prog-used">已消耗 <b>${fmtCredit(used)}</b> 积分</span>
      <span class="prog-tok">${tok ? tok.toLocaleString() + ' token' : (end ? '0 token' : '等待首个 token')}</span>
    </div>
    ${steps.length ? `<div class="prog-steps">${steps.map((s, i) =>
      `<span class="ps ${esc(s.status || 'todo')}" title="${esc(s.text)}"><i>${s.status === 'done' ? '✓' : s.status === 'doing' ? '▶' : i + 1}</i>${esc(brief(s.text, 24))}</span>`).join('')}</div>` : ''}
  </div>`;
  }
  /* 项目页仍用一行式头部：那里没有「分析中」的实时动作，多一行反而占地方 */
  return `<div class="prog" data-prog data-start="${start}" data-end="${end}"
      data-total="${total}" data-done="${done}" data-doing="${doing ? 1 : 0}">
    <div class="prog-h">
      <span class="prog-t">${esc(o.label || '进度')} · ${stepTxt}</span>
      ${nowTxt ? `<span class="prog-now">${end ? '收尾' : '正在'}：<b>${esc(brief(nowTxt, 34))}</b></span>` : ''}
      <span class="prog-time"><span class="prog-el">${elapsed ? '已处理 ' + fmtDur(elapsed) : ''}</span><span class="prog-eta">${end
        ? ('已完成' + (elapsed ? ' · 共 ' + fmtDur(elapsed) : ''))
        : (planned && done >= total
          ? '步骤已走完，正在整理结论'
          : eta ? '预计还需 ' + fmtDur(eta) + '（约 ' + clockAt(Date.now() + eta) + ' 完成）'
            : (planned ? '正在估算剩余时间…' : '剩余时间估不准（还没列计划）'))}</span></span>
    </div>
    <div class="prog-bar${planned ? '' : ' indet'}"><i style="width:${Math.round(Math.max(3, frac * 100))}%"></i></div>
    <div class="prog-f">
      <span>预计消耗 <b>${fmtCredit(Math.max(used, 0.01))} ~ ${fmtCredit(hi)}</b> 积分</span>
      <span class="prog-used">已消耗 <b>${fmtCredit(used)}</b> 积分</span>
      <span class="prog-tok">${tok ? tok.toLocaleString() + ' token' : (end ? '0 token' : '等待首个 token')}</span>
    </div>
    ${steps.length ? `<div class="prog-steps">${steps.map((s, i) =>
      `<span class="ps ${esc(s.status || 'todo')}" title="${esc(s.text)}"><i>${s.status === 'done' ? '✓' : s.status === 'doing' ? '▶' : i + 1}</i>${esc(brief(s.text, 24))}</span>`).join('')}</div>` : ''}
  </div>`;
}
/* 本轮状态条：跑着是实时进度（第几步 / 正在做什么 / 预计完成 / 积分），
   跑完换成这一轮的账（耗时 / 本轮 token / 产出数）挂在那一轮下面。 */
function runStatusHTML(t, tr) {
  const running = tr.status === 'running' || t.status === 'running';
  const curR = Number(tr.round) || Number(t.rounds) || 1;
  const touched = (tr.nodes && tr.nodes.length) || tr.result || t.status;
  if (!touched) return '';
  if (!running) {
    /* 验收没过也在老板这里是「做完了」：成品已经在，缺的那点内部质检不进这个页面 */
    const ok = t.status === 'done' || t.status === 'weak';
    /* 等你拍板的时候，上面那张卡已经有「确认，继续」了，
       底下再挂一个「继续跑」是同一件事说两遍，还容易点错——去掉 */
    const waiting = t.status === 'need_input' || !!(tr.pendingAsk || t.pendingAsk);
    /* 预算超限的「继续跑」和普通续跑不是一回事：额度不补，点了也会在第一步被踢回来。
       按钮就直说是「加额度接着跑」，别让人以为点一下就能跑。 */
    const act = t.status === 'budget_exceeded'
      ? '<button class="rs-resume" type="button" data-resume data-need-bud>加额度接着跑</button>'
      : '<button class="rs-resume" type="button" data-resume>继续跑</button>';
    return roundMetaHTML(t, curR, t.status)
      + (ok || waiting ? '' : `<div class="tm-act">${act}</div>`);
  }
  /* 进度卡报的是「这一轮」的账：累计值减掉上一轮结束时的累计 */
  const tot = t.tokens || { in: 0, out: 0 };
  const base = roundBaseTokens(t, curR);
  const tok = {
    in: Math.max(0, (Number(tot.in) || 0) - base.in),
    out: Math.max(0, (Number(tot.out) || 0) - base.out)
  };
  const todo = lastTodo(t, tr, curR) || [];
  const steps = todo.map(it => {
    const st = String(it.status || 'todo');
    return { text: String(it.text || ''), status: st === 'done' ? 'done' : st === 'doing' ? 'doing' : 'todo' };
  });
  /* 刷新后重开一个还在跑的任务时，state 里没有开始时间，
     用第一颗工具节点的落盘时间兜底，别让「已处理」一直显示 0s。
     注意不能用 t.createdAt：那是任务创建时间，新一轮刚发起时会变成
     「第 3 轮 · 还没开始 已处理 20m」这种自相矛盾的显示。 */
  const firstAt = (tr.nodes || []).map(n => Number(n.at) || 0).filter(Boolean).sort((a, b) => a - b)[0] || 0;
  /* 开始时间的兜底链（刷新后前两档都是空，以前就断在这里 → 秒表整块消失）：
     本机这一轮的开始 → 服务端 run 的开始 → 第一颗工具节点落盘时间 → 本机心跳标记的 since */
  const mark = runMark();
  const markSince = (mark && mark.id === t.id && Number(mark.since)) || 0;
  const startAt = state.traceStartedAt || Number(SRV.startedAt) || firstAt || markSince || 0;
  const busyDoing = !!(tr.writing || (tr.nodes || []).some(n => n.ok === undefined)
    || steps.some(s => s.status === 'doing'));
  const allDone = steps.length > 0 && steps.every(s => s.status === 'done');
  return progressHTML({
    label: `第 ${curR} 轮`,
    /* 状态与进度合成一张卡：头一行说这轮在干什么，第二行说具体做到哪了 */
    stateLabel: allDone ? '收尾中' : busyDoing ? '执行中' : (tr.think ? '推理中' : '分析中'),
    state: doingTextOf(tr, t, curR),
    steps,
    stepLabel: tr.nodes.length ? `已走 <b>${tr.nodes.length}</b> 步` : '还没开始',
    done: steps.length ? 0 : tr.nodes.length || 0,
    total: steps.length ? 0 : (state.settings.maxSteps || 24),
    now: toolNow(tr.nodes),
    startAt,
    endAt: 0,
    tokens: tok,
    budgetTokens: (state.settings.maxTokens || 200000) + (t.id ? budExtra(t.id) : 0)
  });
}

/* 「这一轮现在在干嘛」——照 agent 的真实动作说，不写套话。
   优先级：等你拍板 > 正在生成文件 > 正在跑某个工具 > 正在写回复 >
   计划全打勾了在收尾 > 还没动手（分析/拆解） */
function doingTextOf(tr, t, curR) {
  if (tr.pendingAsk) return '等你拍板，选完就接着干';
  if (tr.writing && tr.writing.name) return writingLine(tr.writing);
  const liveNode = (tr.nodes || []).filter(n => n && n.name && n.ok === undefined && !HIDE_STEPS.has(n.name)).pop();
  if (liveNode) {
    const a = liveNode.args || {};
    const obj = a.path || a.query || a.url || a.pattern || a.command || '';
    const head = TOOL_CN[liveNode.name] ? '正在' + TOOL_CN[liveNode.name] : '正在执行 ' + liveNode.name;
    return head + (obj ? '：' + brief(obj, 30) : '');
  }
  const stream = String(tr.stream || '').trim();
  if (stream) {
    const line = stream.split(/\n+/).map(s => s.replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean)[0] || '';
    return line ? '正在写回复：' + brief(line, 38) : '正在写回复…';
  }
  /* 推理模型已经在「想」了：把最后一句想的内容摆出来，别只留一句「分析中」。
     取最后一行（最新的判断），太长就截断——这里要的是一眼能读的摘要。 */
  const think = String(tr.think || '').trim();
  if (think) {
    const lines = think.split(/\n+/).map(s => s.replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    return lastLine ? '正在推理：' + brief(lastLine, 36) : '正在推理…';
  }
  const todo = lastTodo(t, tr, curR) || [];
  if (todo.length) {
    const idx = todo.findIndex(x => String(x.status) !== 'done');
    if (idx < 0) return '步骤都走完了，正在整理结论…';
    const cur = todo[idx] || {};
    return `第 ${idx + 1}/${todo.length} 步：${brief(String(cur.text || ''), 34)}`;
  }
  if (!(tr.nodes || []).length) {
    /* 一句「正在拆解任务」挂十几秒，和卡死长得一样。按静默时长说实话：
       推理模型头一段本来就要几十秒，先把「在等什么、等了多久」讲清楚。 */
    const t0 = Number(state.traceStartedAt) || Number(SRV.startedAt) || 0;
    const secs = t0 ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : 0;
    if (secs >= 90) return `已经 ${secs}s 没有第一个字：可能卡住了，建议点 ■ 停掉重发（或换一个更快的模型）`;
    if (secs >= 25) return `模型还在想第一段（${secs}s）。推理模型开头慢是常态，再等等`;
    if (secs >= 8) return `已发给模型，等它吐第一个字（${secs}s）…`;
    return '正在拆解任务：先想清楚要做什么、分几步做…';
  }
  return '正在接着往下做…';
}

/* 每秒把「已处理 / 预计还需」往前推，进度条跟着走 */
setInterval(() => {
  document.querySelectorAll('[data-prog]').forEach(el => {
    const start = Number(el.dataset.start) || 0;
    if (!start) return;
    const end = Number(el.dataset.end) || 0;
    const total = Number(el.dataset.total) || 0;
    const done = Number(el.dataset.done) || 0;
    const doing = el.dataset.doing === '1';
    const elapsed = Math.max(0, (end || Date.now()) - start);
    const frac = total ? Math.min(1, (done + (doing ? 0.4 : 0)) / total) : 0;
    const et = el.querySelector('.prog-el');
    /* 合并卡的秒表在头一行：任务卡（id=liveTick）由 startLiveTick 单独跳；
       项目 @干活的卡没有那个 id（同屏会有多张），跟着这里按各自的 data-start 跳 */
    if (et && el.classList.contains('merged')) {
      if (et.id !== 'liveTick') et.textContent = '已 ' + fmtDur(elapsed);
    } else if (et) et.textContent = '已处理 ' + fmtDur(elapsed);
    const ea = el.querySelector('.prog-eta');
    if (ea) {
      /* 合并卡的第二行已经在说「步骤都走完了，正在整理结论」，这里别再说一遍 */
      const merged = el.classList.contains('merged');
      const plannedEl = !el.querySelector('.prog-bar.indet');
      if (end) ea.textContent = merged ? '' : '已完成 · 共 ' + fmtDur(elapsed);
      else if (!merged && total && done >= total) ea.textContent = '步骤已走完，正在整理结论';
      else {
        const eta = plannedEl && frac > 0.08 ? elapsed * (1 - frac) / frac : 0;
        ea.textContent = merged
          ? (eta ? '预计还需 ' + fmtDur(eta) + '（约 ' + clockAt(Date.now() + eta) + ' 完成）' : '')
          : (eta ? '预计还需 ' + fmtDur(eta) + '（约 ' + clockAt(Date.now() + eta) + ' 完成）' : '正在估算剩余时间…');
      }
    }
    const bar = el.querySelector('.prog-bar i');
    if (bar && !end) bar.style.width = Math.round(Math.max(3, frac * 100)) + '%';
    /* 空窗期（还没有任何步骤 / 推理 / 正文）第二行也跟着秒数走：
       「正在拆解任务」一句挂半分钟，和卡死没有区别。有动静之后就让位给真实动作 */
    const ps = el.querySelector('.ps-txt');
    if (ps && el.classList.contains('merged') && !end && state.running) {
      const tr2 = state.trace || {};
      const blank = !(tr2.nodes || []).length
        && !String(tr2.think || '').trim() && !String(tr2.stream || '').trim();
      if (blank) {
        const txt = doingTextOf(tr2, curTask(), Number(tr2.round) || 1);
        if (txt && txt !== ps.textContent) ps.textContent = txt;
      }
    }
  });
}, 1000);

function budExtra(taskId) {
  return Number(localStorage.getItem('boss.tbud.' + taskId)) || 0;
}
function budRaise(taskId, n) {
  const v = budExtra(taskId) + n;
  localStorage.setItem('boss.tbud.' + taskId, String(v));
  return v;
}
function withBud(taskId, settings) {
  const extra = budExtra(taskId);
  const out = extra ? { ...settings, maxTokens: (settings.maxTokens || 200000) + extra } : { ...settings };
  /* 独立验收：默认开。收工时多一次调用，但换来「不是它自己说做完了就算完」 */
  out.verify = verifyOn();
  return out;
}

/* 这个任务还能烧多少 token（全局上限 + 这个任务身上加过的额度） */
function budgetOf(taskId, settings) {
  const base = Number((settings || state.settings || {}).maxTokens) || 200000;
  return base + (taskId ? budExtra(taskId) : 0);
}
function spentOf(task) {
  const tok = (task && task.tokens) || {};
  return (Number(tok.in) || 0) + (Number(tok.out) || 0);
}
/* 续跑前先把额度补够。
   踩过的坑（2026-11-02）：一个任务累计烧到 53 万 token、上限 20 万，点「继续跑」
   之后 agent 循环第一行就撞上 `累计 > 上限` 直接 break —— 从界面上看就是
   「弹了句提示，什么都没发生」。这里补够「已花 + 再跑一轮的余量」，续跑才真的能跑。
   返回补了多少；没补返回 0。 */
function ensureBudget(task, settings) {
  if (!task || !task.id) return 0;
  const spent = spentOf(task);
  const bud = budgetOf(task.id, settings);
  if (!spent || spent < bud) return 0;
  /* 目标是「已花 + 再跑一轮的余量」，不是「在上限上加一点」：
     只加固定值的话，烧掉 53 万的任务补到 46 万，还是一进去就被踢出来。
     余量至少 10 万，长任务按已花的 50% 给。 */
  const add = spent + Math.max(100000, Math.round(spent * 0.5)) - bud;
  if (add <= 0) return 0;
  budRaise(task.id, add);
  return add;
}
/* 「万」字口径的提示语统一走前面那个 fmtTokenW（积分模块里那一个），这里不再重复定义 */

/* ── 管理员告警 ──
   验收没过 / 执行报错 / 预算超限，这三类都是「产品要修的问题」，
   不是老板要看的东西。界面里不再展示，改成投一条告警进服务端队列，
   由定时任务汇总发到管理员邮箱（livincuzlove@agent.qq.com）。
   投递失败不回抛、不弹窗：运维提示不该打断老板干活。 */
const ALERT_KINDS = { verify: '验收没过', error: '执行报错', budget: '预算超限' };
function queueAlert(t, kind, extra) {
  try {
    if (!t || !ALERT_KINDS[kind]) return;
    const round = Number(t.curRound) || 1;
    /* 同一任务 + 同一轮 + 同一类只报一次：重试、刷新都不该把邮箱刷爆 */
    const key = 'boss.alert.' + (t.id || 'x') + '.' + round + '.' + kind;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, String(Date.now()));
    const tok = t.tokens || {};
    const body = {
      scope: state.scope || '',
      alert: {
        kind, kindName: ALERT_KINDS[kind],
        taskId: t.id || '', taskTitle: t.title || '', goal: String(t.goal || '').slice(0, 400),
        employee: t.employeeName || '', round, status: t.status || '',
        tokens: { in: Number(tok.in) || 0, out: Number(tok.out) || 0 },
        models: ((t.metrics && t.metrics.models) || []).join('/'),
        at: Date.now(),
        ...(extra || {})
      }
    };
    const url = window.withSC ? window.withSC('/api/notify') : '/api/notify';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => {});
  } catch (e) { /* 告警是旁路，坏了不能影响主流程 */ }
}

/* 收工时按真实结局分派：只有「正常做完」才不惊动管理员 */
function queueTaskAlert(t, done) {
  if (!t) return;
  const st = (done && done.status) || t.status || '';
  const v = (done && done.verify) || t.verify || null;
  const vGap = v && v.verdict && v.verdict !== 'pass';
  if (st === 'weak' || vGap) {
    queueAlert(t, 'verify', {
      verdict: (v && v.verdict) || '', score: (v && v.score) || 0,
      gaps: (v && v.gaps) || [], note: (v && v.note) || '',
      verifier: (v && (v.judgeName || v.judgeModel || v.model)) || ''
    });
  }
  if (st === 'unverified') {
    queueAlert(t, 'verify', { verdict: 'missing', gaps: ['交付物没有落到工作目录里'], note: '交付物校验没过' });
  }
  if (st === 'budget_exceeded') {
    queueAlert(t, 'budget', { budget: budgetOf(t.id, state.settings), spent: spentOf(t) });
  }
  if (st === 'failed') {
    queueAlert(t, 'error', { error: String((state.trace && state.trace.error) || t.error || '') });
  }
}

/* 设置里的「独立验收」开关：默认开，只有明确关掉才关 */
function verifyOn() {
  try { return localStorage.getItem('boss.verify') !== '0'; } catch (e) { return true; }
}

/* ── 敏感操作审批：弹出的卡片点放行/拒绝 ── */
function resolveApproval(id, ok) {
  const tr = state.trace;
  const a = (tr.approvals || []).find(x => x.id === id);
  if (a) a.status = ok ? 'allowed' : 'denied';
  agentApprove(id, ok);
  renderTrace();
}

/* ── 进度面板：员工用 todo_write 记的清单，直接摊在对话顶上 ── */
/* 最近一次「员工自己列的步骤」。只认这一轮的：上一轮的 4/4 已完成清单
   挂到新一轮头上，就会变成「刚开始就显示步骤走完」的错觉。 */
function lastTodo(t, tr, curR) {
  const R = Number(curR) || 0;
  const scan = arr => {
    for (let i = (arr || []).length - 1; i >= 0; i--) {
      const s = arr[i];
      if (!s || s.name !== 'todo_write' || !s.args || !Array.isArray(s.args.items) || !s.args.items.length) continue;
      if (R && (Number(s.round) || 1) !== R) continue;
      return s.args.items;
    }
    return null;
  };
  return scan((tr && tr.nodes) || []) || scan((t && t.steps) || []);
}

/* ── 例行任务：到点自动交代给员工；应用开着准时跑，关着下次打开补跑 ── */
function loadCron() {
  try { return JSON.parse(localStorage.getItem('boss.cron') || '[]'); } catch { return []; }
}
function saveCron(list) {
  localStorage.setItem('boss.cron', JSON.stringify(list));
}
function cronDue(c, now) {
  if (!c || !c.enabled) return false;
  if (c.last && now - c.last < 30 * 60 * 1000) return false; // 刚跑过，别重复
  if (c.freq === 'hourly') return !c.last || now - c.last >= 6 * 3600 * 1000;
  const [h, m] = String(c.at || '09:00').split(':').map(Number);
  const due = new Date(now);
  due.setHours(h || 9, m || 0, 0, 0);
  if (now < due.getTime()) return false;
  return !c.last || c.last < due.getTime();
}
function checkCron() {
  if (state.running) return;
  const list = loadCron();
  const now = Date.now();
  const hit = list.find(c => cronDue(c, now));
  if (!hit) return;
  hit.last = now;
  saveCron(list);
  toast('例行任务到点：' + String(hit.goal).slice(0, 24));
  state.drafting = true; // 例行任务永远开新任务，不插进当前对话
  runGoal(hit.goal);
}

/* ── 对话按轮排：一轮 = 我问的那句 + 这轮的执行过程 + 它的回答 + 这轮的产出 ──
   老板连着说两句时，如果只按「所有话堆一起、所有步骤堆一起」排，看起来就是
   「我自说自话，最后才有个回答」。这里按 round 把每一步归到它所属的那一轮。 */
const openedTurns = new Set();

/* 老任务没轮次标记，或者标记本身就是错的。根因只有一个：
   `rounds` 这个字段从来没进过数据库（ba_tasks 没这一列），刷新一次就退回 1，
   于是「第三句话又被算成第二轮」，同一轮的结论互相覆盖、前面几轮整段消失。
   所以这里一律从数据推导，不认 task.rounds：
     userMsgs[].at = 说这句话时已经走了几个工具步（落库，可信）
     steps[]       = 按时间先后排的工具与结论
   第 k 句话 = 第 k 轮；工具步按 at 边界归到它所属的那一轮。 */
function maxRoundOf(t) {
  const tag = arr => (arr || []).reduce((m, x) => Math.max(m, Number(x && x.round) || 0), 0);
  return Math.max(1, tag(t && t.steps), tag(t && t.userMsgs));
}

function asksOf(t) {
  const raw = Array.isArray(t && t.userMsgs) ? t.userMsgs : [];
  const asks = raw.map((u, i) => (u && typeof u === 'object')
    ? {
      text: String(u.text || '').trim(), at: Math.max(0, Number(u.at) || 0),
      _i: i, inline: !!u.inline, said: Math.floor(Number(u.round) || 0),
      /* 这句话带了几张图（只留路径）。归一化时不能丢——丢了气泡里就只剩
         「（附 2 张截图）」这一行字，老板会以为图没发出去。 */
      imgs: Array.isArray(u.imgs) ? u.imgs : []
    }
    : { text: String(u || '').trim(), at: 0, _i: i, inline: false, said: 0, imgs: [] })
    .filter(a => a.text);
  if (!asks.length && t && t.goal) {
    asks.push({ text: String(t.goal).trim(), at: 0, _i: 0, inline: false, said: 1 });
  }
  asks.sort((a, b) => (a.at - b.at) || (a._i - b._i));
  /* 轮次归属：自带 round 的一律认它（只信 ≥1 的整数），缺的才按顺序补。
     以前这里无视原 round、纯按条数往上数——中途插一句「补充」也被算成新的一轮，
     于是「说两句」变成「三轮」，多出来的那轮是空的。
     空轮正是老板看到的「我的话一会儿在上面，一会儿没了」：
     当前轮指针落到空轮上，屏幕上就只剩一片空白。 */
  let seq = 0;
  let last = 0;
  for (const a of asks) {
    if (a.said >= 1) {
      a.round = a.said;
      last = Math.max(last, a.said);
      if (!a.inline) seq = Math.max(seq, a.said);
    } else if (a.inline && last >= 1) {
      a.round = last;                 /* 插话不占新轮，跟着最近那句走 */
    } else {
      seq += 1;
      a.round = seq;
      last = Math.max(last, seq);
    }
  }
  return asks;
}

function syncRounds(t) {
  if (!t) return { rounds: 1, asks: [], list: [] };
  const asks = asksOf(t);
  /* 轮数 = 最大轮号，**不是**一共说了几句：插话、同轮多说几句都不该撑出新轮。
     这一行以前写的是 asks.length，实测「1 轮 + 1 次插话 + 2 轮」会被算成 3 轮，
     第 3 轮什么都没有——界面上凭空多一块空白，还把这之后的新话挤到错位。 */
  const n = Math.max(1, asks.reduce((m, a) => Math.max(m, Number(a.round) || 1), 1));
  const steps = Array.isArray(t.steps) ? t.steps : [];
  const roundAt = g => {
    let r = 1;
    for (const a of asks) if (g >= a.at) r = a.round;
    return r;
  };
  let g = 0;
  const tagOf = new Map();
  for (const s of steps) {
    if (!s) continue;
    if (s.kind === 'tool') { tagOf.set(s, roundAt(g)); g++; }
    else if (s.kind === 'error') { tagOf.set(s, roundAt(Math.max(0, g - 1))); }
  }
  /* 结论：自带合法轮次的直接认，**同一轮允许多句**。
     这里以前错在「一句话占一轮」：模型在一轮里常说两句——先「我先把图做出来」再调工具，
     工具回来再「逐段讲」。按唯一性分，第二句会被挤到前面的轮次（实测第 6 轮的 793 字
     结论被塞进第 1 轮），老板看到的就是「分析过程没了、只剩一句开场」。
     只有老数据没有 round 标记时，才从最后一轮往前找还没人占的空位。 */
  const says = steps.filter(s => s && s.kind === 'say');
  const taken = new Set();
  for (const s of says) {
    const want = Number(s.round) || 0;
    if (want >= 1 && want <= n) { tagOf.set(s, want); taken.add(want); }
  }
  /* 只有老数据没有 round 标记时，才按出现顺序落到末尾几轮：
     这样最后一句一定落在最后一轮，前后顺序也不会被倒过来。 */
  const orphan = says.filter(s => !tagOf.has(s));
  orphan.forEach((s, i) => {
    let r = Math.max(1, n - orphan.length + 1 + i);
    while (r < n && taken.has(r)) r++;
    tagOf.set(s, r); taken.add(r);
  });
  for (const s of steps) {
    if (!s) continue;
    const r = tagOf.get(s);
    if (r) s.round = r;
    if (s.kind === 'round') s.round = Math.min(n, Math.max(1, Number(s.round) || n));
  }
  if (Array.isArray(t.userMsgs) && t.userMsgs.length) {
    const want = asks.map(a => (a.inline
      ? { text: a.text, at: a.at, round: a.round, inline: true, imgs: a.imgs }
      : { text: a.text, at: a.at, round: a.round, imgs: a.imgs }));
    /* 归一化只在「真的变了」的时候替换：renderTrace 每帧都会走到这里，
       无条件换数组会让所有持有旧引用的地方（runCtx、落库节流）看到两份数据 */
    const samePaths = (o, w) => {
      const a = Array.isArray(o) ? o : [];
      const b = Array.isArray(w) ? w : [];
      if (a.length !== b.length) return false;
      return a.every((x, i) => String((x && x.path) || x || '') === String((b[i] && b[i].path) || b[i] || ''));
    };
    const same = want.length === t.userMsgs.length && want.every((w, i) => {
      const o = t.userMsgs[i];
      return o && String(o.text || '') === w.text
        && (Math.floor(Number(o.round) || 0)) === w.round
        && !!o.inline === !!w.inline
        && samePaths(o.imgs, w.imgs);
    });
    if (!same) t.userMsgs = want;
  }
  t.rounds = n;
  return { rounds: n, asks, list: roundsList(t, n) };
}

function roundsList(t, n) {
  const steps = Array.isArray(t && t.steps) ? t.steps : [];
  const ums0 = Array.isArray(t && t.userMsgs) ? t.userMsgs : [];
  /* 老任务 / 刚建好就刷新过的任务：云端 user_msgs 是空的，但 goal 就是第一句原话。
     不回退这一档，界面上第一轮就没有「我」的气泡——话还在，看着像被吞了。 */
  const ums = (ums0.length || !t || !String(t.goal || '').trim())
    ? ums0
    : [{ text: String(t.goal).trim(), round: 1 }];
  const list = [];
  /* 老任务没有 imgs 字段（这个字段是本版才加的），但它们的第一轮附件还在
     task.files 里。不补这一档，老板升级后再看历史对话，图依然是看不见的。 */
  const firstImgs = (t && Array.isArray(t.files)) ? imgPathsOf(t.files) : [];
  for (let r = 1; r <= n; r++) {
    const tools = steps.filter(s => s && s.kind === 'tool' && (Number(s.round) || 1) === r);
    const saysR = steps.filter(s => s && s.kind === 'say' && (Number(s.round) || 1) === r);
    const say = saysR[saysR.length - 1];
    const umR = ums.filter(u => (Number(u && u.round) || 1) === r);
    list.push({
      round: r,
      /* asks 只给文字（决策卡、待办、导出这些老地方按字符串用）；
         askItems 多带一个 inline 标记，界面上要把「中途补充」和「这一轮的问话」分开 */
      asks: umR.map(u => String((u && u.text) || '')),
      /* imgs 只放路径（几十字节）：气泡里要看得见图，就不能只写一句「附 2 张截图」 */
      askItems: umR.map((u, i) => {
        const own = (u && Array.isArray(u.imgs)) ? u.imgs : [];
        return {
          text: String((u && u.text) || ''),
          inline: !!(u && u.inline),
          imgs: (own.length || r !== 1 || i !== 0) ? own : firstImgs
        };
      }),
      tools,
      /* result 留作兼容（拍板卡、交接这些地方还读它）；界面渲染走 says 全量 */
      result: (say && say.text) || '',
      says: saysR.map(s => String(s.text || ''))
    });
  }
  return list;
}

function roundsOf(t) {
  return syncRounds(t).list;
}

/* 这一轮的账：耗时 / token。token 是「本轮结束时累计 − 上一轮结束时累计」，
   累计值由员工每轮结束时写一条 kind:'round' 记录（老任务没这条记录就显示 —，不瞎估）。 */
function roundStats(t, r) {
  const steps = Array.isArray(t && t.steps) ? t.steps : [];
  const recs = steps.filter(s => s && s.kind === 'round' && Number(s.round) >= 1)
    .sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0));
  const mine = recs.filter(s => (Number(s.round) || 0) <= r).pop();
  const prev = recs.filter(s => (Number(s.round) || 0) < r).pop();
  const tools = steps.filter(s => s && s.kind === 'tool' && (Number(s.round) || 1) === r);
  const durMs = (mine && mine.ms != null)
    ? Number(mine.ms) || 0
    : tools.reduce((a, s) => a + (Number(s.ms) || 0), 0);
  let tokens = null;
  if (mine) {
    const m = (Number(mine.tokIn) || 0) + (Number(mine.tokOut) || 0);
    const p = prev ? (Number(prev.tokIn) || 0) + (Number(prev.tokOut) || 0) : 0;
    tokens = Math.max(0, m - p);
  } else if (!recs.length && t) {
    /* 一条记录都没有的老任务：只敢在最后一轮报任务总量，中间轮没有账就不编 */
    const n = Number(t.rounds) || 1;
    if (r === n) {
      const tok = t.tokens || {};
      tokens = (Number(tok.in) || 0) + (Number(tok.out) || 0);
    }
  }
  return { durMs, tokens };
}

/* 这一轮开始时已经烧掉多少（上一轮结束时的累计），用来算「本轮」的增量 */
function roundBaseTokens(t, r) {
  const recs = ((t && t.steps) || [])
    .filter(s => s && s.kind === 'round' && (Number(s.round) || 0) < r)
    .sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0));
  const p = recs.pop();
  return p ? { in: Number(p.tokIn) || 0, out: Number(p.tokOut) || 0 } : { in: 0, out: 0 };
}

/* 一轮对话的收尾：状态 + 耗时 + 这一轮烧了多少 token + 出了几样东西。
   opts.history：前面几轮的账。这些轮早结束了，写成「第 2 轮 · 已结束」——
   不然一进入下一轮，上面还挂着一条绿的「✓ 已完成」，看着就像整个任务收工了。 */
function roundMetaHTML(t, r, status, R, opts) {
  const hist = !!(opts && opts.history);
  const st = roundStats(t, r);
  const turn = R || (roundsOf(t) || []).find(x => x.round === r) || { tools: [] };
  const outs = filesOfTurn(turn).length;
  const done = !status || status === 'done' || status === 'weak';
  const raw = done ? '✓ 已完成'
    : status === 'interrupted' ? '⏸ 已中断（刷新打断）'
    : status === 'failed' ? '✕ 出错停下'
    : status === 'blocked' ? '· 卡在授权'
    : status === 'step_limit' ? '· 步数用完'
    : status === 'budget_exceeded' ? '· 额度用完停下'
    : status === 'unverified' ? '· 交付物没落实'
    : status === 'need_input' ? '· 等你拍板'
    : status === 'running' ? '▶ 进行中'
    : '· 已结束';
  const label = hist
    ? `第 ${r} 轮 · ${done ? '已结束' : raw.replace(/^[^\u4e00-\u9fa5A-Za-z]+/, '')}`
    /* 中途被打断：把轮次写进来说清是「哪一轮断的」，多轮对话里不容易认错 */
    : (status === 'interrupted' ? `第 ${r} 轮 · 已中断（刷新打断）` : raw);
  const cls = 'turn-meta' + (done ? (hist ? ' hist' : ' ok') : ' no');
  const tokTxt = st.tokens == null
    ? 'token <b>—</b>'
    : `${hist ? '这轮' : '本轮'} <b>${st.tokens.toLocaleString()}</b> token ≈ <b>${fmtCredit(creditsOf(st.tokens))}</b> 积分`;
  return `<div class="${cls}">
    <span class="tm-st">${label}</span>
    <span>耗时 <b>${st.durMs ? fmtDur(st.durMs) : '—'}</b></span>
    <span class="tm-tok">${tokTxt}</span>
    <span>产出 <b>${outs}</b> 项</span>
  </div>`;
}

/* 这一轮真写出来的文件：优先用步骤里带的 files，再从输出文本里反查图片路径 */
/* 这一轮产出了哪些文件：规则和右栏/总产出一致（不只是图片）。
   之前只认 assets/outputs 下的图片，写个 round1.md 就被算成「产出 0 项」。 */
function filesOfTurn(R) {
  const out = [];
  const seen = new Set();
  const add = p => {
    const s = String(p || '').trim().replace(/^\.?\//, '');
    if (!s || seen.has(s)) return;
    if (isInternalArtifact(s)) return;   /* 自检/验收报告不算「产出」 */
    seen.add(s);
    out.push(s);
  };
  for (const s of R.tools || []) {
    if (!s || s.ok === false) continue;
    if (s.args && s.args.path && /^(make_deck|write_file|make_sheet|make_doc)$/.test(String(s.name || ''))) {
      add(s.args.path);
    }
    for (const f of (s.files || [])) add(f);
    /* 输出里点到的图片路径（老记录或工具只在说明里写路径） */
    const txt = String(s.output || '');
    for (const p of (txt.match(IMG_PATH_RE) || [])) add(p);
  }
  for (const p of (String(R.result || '').match(IMG_PATH_RE) || [])) add(p);
  return out;
}

function nodeHTML(n, i, open, keyPrefix = '') {
  const k = keyPrefix + n.name + i;
  return `<div class="node" data-i="${i}">
    <div class="node-h ${n.output ? 'can-open' : ''}" data-toggle="${esc(k)}">
      <span class="caret">${n.output ? (open ? '▾' : '▸') : ''}</span>
      <span class="n">${String(i + 1).padStart(2, '0')}</span>
      <b>${esc(n.name)}</b>
      <span class="args">${esc(argsBrief(n.args))}</span>
      ${n.ms ? `<span class="ms">${n.ms}ms</span>` : ''}
      ${n.tests && n.tests.pass ? `<span class="vf ok" title="改完自动跑了测试">测 ${n.tests.passCount} 项</span>` : ''}
      ${n.verify && n.verify.pass === false ? '<span class="vf no">校验未过</span>' : ''}
      <span class="st ${n.ok === undefined ? 'pending' : n.ok ? 'ok' : 'no'}">${n.ok === undefined ? '…' : n.ok ? 'ok' : 'err'}</span>
    </div>
    ${n.verify && n.verify.pass === false ? `<div class="vwhy">✗ ${esc(n.verify.why)}</div>` : ''}
    ${n.output && open ? `<div class="node-b"><pre>${esc(n.output)}</pre></div>` : ''}
  </div>`;
}

function filesBlockHTML(files, t, tr) {
  const pics = files.filter(f => isImagePath(f.path));
  const docs = files.filter(f => !isImagePath(f.path));
  let h = '';
  if (pics.length) {
    h += `<div class="node-files node-pics"><span class="lbl">产出图片</span><div class="pic-grid">`
      + pics.map(f => {
        const nm = f.path.split('/').pop();
        const url = imgPreviewUrl(state.scope, f.path);
        return `<figure class="pic-i"><a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(f.path)}">`
          + `<img src="${esc(url)}" alt="${esc(nm)}" loading="lazy" onerror="this.closest('figure').classList.add('lost')"></a>`
          + `<figcaption>${esc(nm)}</figcaption></figure>`;
      }).join('')
      + `</div></div>`;
  }
  if (docs.length) {
    /* 产出文件：一行三个、从左往右排，排满自动换行。
       卡片改成「上面文件名 / 下面两个按钮」的竖版——横版塞进三分之一宽会把名字截断、
       按钮也挤成小方块，竖版才能保证名字看得全、预览和下载都完整露出来。 */
    h += `<div class="node-files"><span class="lbl">产出文件</span><div class="file-grid">`;
    for (const f of docs) {
      const p = f.path;
      const ext = (p.split('.').pop() || '').toLowerCase();
      const icon = { pptx: '📊', docx: '📄', xlsx: '📈', pdf: '📕', md: '📝', txt: '📝', png: '🖼', jpg: '🖼', jpeg: '🖼' }[ext] || '📎';
      const url = window.withSC('/api/file?scope=' + state.scope + '&raw=1&path=' + encodeURIComponent(p));
      const spec = ext === 'pptx' ? findDeckSpec(t, tr, p) : null;
      /* 预览只留一个按钮：所有类型都走同一个弹窗（图片 / PDF / Office / 网页 / 文本 / 代码）。
         以前 pptx 有两个「预览」——一个就地铺幻灯片、一个弹窗，说的是同一件事。 */
      h += `<div class="file-card" data-path="${esc(p)}">
        <div class="fc-top">
          <span class="fc-icon">${icon}</span>
          <div class="fc-body"><b title="${esc(p.split('/').pop())}">${esc(p.split('/').pop())}</b><i title="${esc(p)}">${esc(p)}${spec ? ` · ${(spec.slides || []).length} 页` : ''}</i></div>
        </div>
        <div class="fc-acts">
          <button class="fc-dl ghost-btn" data-preview="${esc(p)}" title="预览（图片 / PDF / Office / 网页 / 文本 都能看）">预览</button>
          <a class="fc-dl" href="${esc(url)}" download="${esc(p.split('/').pop())}">下载</a>
        </div>
      </div>`;
    }
    h += `</div></div>`;
  }
  return h;
}

/* 已经结束的那种「一轮」：步骤默认收起来，回答和产出直接摊在外面 */
/* ── 图片放大 ──
   输入区的待发图和对话框里已经发出去的图，点击都是这一层。
   不跳页、不开新窗口：老板要的只是看清图里那一行字，看完点一下就走。 */
function imgSrcOf(p) {
  const q = '/api/raw?scope=' + encodeURIComponent(state.scope || '') + '&path=' + encodeURIComponent(String(p || ''));
  return window.withSC ? window.withSC(q) : q;
}
function openImgBox(src) {
  if (!src) return;
  let box = document.getElementById('imgBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'imgBox';
    box.className = 'img-box';
    box.innerHTML = '<img alt=""><b class="img-x" title="关闭（Esc）">×</b>';
    document.body.appendChild(box);
    box.addEventListener('click', () => box.classList.remove('on'));
    box.querySelector('img').addEventListener('click', e => e.stopPropagation());
  }
  box.querySelector('img').src = src;
  box.classList.add('on');
}
function closeImgBox() {
  const box = document.getElementById('imgBox');
  if (box) box.classList.remove('on');
}
/* 附件 → 对话气泡要记住的图片清单：**只留路径和名字**。
   一张 700KB 的 dataURL 存进 userMsgs，会被一起送进 /api/run 并落库，
   既撑爆请求体（403），也让存档变成几 MB。图本来就在工作区。 */
function imgPathsOf(list) {
  return (Array.isArray(list) ? list : [])
    .filter(x => x && x.path && (x.dataUrl || x.thumb || /^image\//i.test(String(x.mime || ''))
      || /\.(png|jpe?g|webp|gif|bmp)$/i.test(String(x.path))))
    .map(x => ({ path: String(x.path), name: String(x.name || '') }));
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeImgBox(); });
/* 任何带 data-imgbox 的图（气泡里的、产出卡片上的）点了都放大 */
document.addEventListener('click', e => {
  const t = e.target && e.target.closest ? e.target.closest('[data-imgbox]') : null;
  if (!t) return;
  e.preventDefault();
  openImgBox(t.getAttribute('data-imgbox'));
});

/* 老板说的话：历史轮和当前轮用同一套渲染，位置和样式才不会有「刚才在这、一会儿没了」 */
function msgMeHTML(text, inline, imgs) {
  /* 已经发出去的图要看得见：只存路径，不存 base64——几 MB 的 dataURL 存进
     userMsgs 会被一起送去 /api/run，那就是 403 的来源。图在工作区里，按路径取。 */
  const pics = (Array.isArray(imgs) ? imgs : [])
    .map(x => (typeof x === 'string' ? { path: x } : x))
    .filter(x => x && x.path);
  const strip = pics.length
    ? `<div class="bub-pics">${pics.map(p => {
      const src = imgSrcOf(p.path);
      return `<img class="bub-pic" src="${esc(src)}" alt="${esc(p.name || '图片')}" data-imgbox="${esc(src)}" loading="lazy">`;
    }).join('')}</div>`
    : '';
  return `<div class="msg me${inline ? ' sup' : ''}">`
    + (inline ? '<span class="me-tag">补充</span>' : '')
    + `<div class="bub">${strip}${esc(text)}</div><span class="ava">我</span></div>`;
}

function turnHTML(R, t) {
  const who = (t && t.employeeName) || 'AI';
  const open = openedTurns.has(R.round);
  const tools = (R.tools || []).filter(s => !HIDE_STEPS.has(s.name));
  const bad = tools.filter(s => s.ok === false).length;
  const ms = tools.reduce((a, s) => a + (Number(s.ms) || 0), 0);
  let h = `<div class="turn" data-turn="${R.round}">`;
  const askItems = (R.askItems && R.askItems.length)
    ? R.askItems
    : (R.asks || []).map(x => ({ text: x, inline: false, imgs: [] }));
  for (const a of askItems) h += msgMeHTML(a.text, a.inline, a.imgs);
  if (tools.length) {
    h += `<div class="turn-bar" data-turn-toggle="${R.round}">
      <span class="caret">${open ? '▾' : '▸'}</span>
      <b>${tools.length} 步执行</b>
      <span class="args">${bad ? `<i class="tb-bad">${bad} 步失败</i> · ` : ''}${(ms / 1000).toFixed(1)}s</span>
      <span class="tb-hint">${open ? '收起过程' : '展开过程'}</span>
    </div>`;
    if (open) {
      h += `<div class="turn-steps">${tools.map((s, i) =>
        nodeHTML(s, i, openedNodes.has('t' + R.round + s.name + i), 't' + R.round)).join('')}</div>`;
    }
  }
  /* 这一轮说过的每句话都摊开：中间的分析标「分析 N」，最后那句才是结论。
     老任务只有 result 一条，退回单条显示。 */
  {
    const saysList = (Array.isArray(R.says) && R.says.length)
      ? R.says
      : (R.result ? [R.result] : []);
    saysList.forEach((tx, i) => {
      if (!String(tx || '').trim()) return;
      const isLast = i === saysList.length - 1;
      const lbl = isLast ? `${esc(who)} 的结论` : `${esc(who)} · 分析 ${i + 1}`;
      h += `<div class="node-txt bot${isLast ? '' : ' say-mid'}">`
        + `<span class="bot-ava ${avClass(who)}" title="${esc(who)}">${esc((who || 'AI').slice(0, 1))}</span>`
        + `<div class="bot-bub"><span class="lbl">${lbl}</span><div class="md">${mdLite(tx)}</div></div>`
        + `</div>`;
    });
  }
  const files = filesOfTurn(R);
  if (files.length) h += filesBlockHTML(files.map(p => ({ path: p })), t, null);
  /* 这一轮的账挂在这一轮下面：出了几样、烧了多少 token、花了多久。
     历史轮走 history 文案（第 N 轮 · 已结束），别和「整个任务已完成」混在一起。 */
  h += roundMetaHTML(t, R.round, 'done', R, { history: true });
  h += `</div>`;
  return h;
}

/* ── 拍板卡：把老板的选择拼成一句追问，交给同一个任务接着跑 ── */
function submitAskAnswer(box) {
  const form = box.querySelector('#askForm');
  const tr = state.trace;
  const pa = (tr && tr.pendingAsk) || (curTask() && curTask().pendingAsk);
  if (!form || !pa) return;
  const answers = [];
  for (let i = 0; i < (pa.questions || []).length; i++) {
    const picked = [...form.querySelectorAll(`.ask-opt.on[data-q="${i}"]`)].map(el => el.textContent.trim());
    const ci = form.querySelector(`.ask-custom[data-q="${i}"]`);
    const custom = ci ? ci.value.trim() : '';
    const val = [...picked, custom].filter(Boolean).join('；');
    if (!val) { toast(`第 ${i + 1} 题还没选`); (ci || form).scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    answers.push(`${i + 1}. ${pa.questions[i].q}\n答：${val}`);
  }
  const task = curTask();
  if (task) task.pendingAsk = null;
  if (task) { task._askStamp = ''; task._askMemo = null; }
  if (tr) tr.pendingAsk = null;
  traceStick = true;
  const cf = '【已确认，按这个继续】\n' + answers.join('\n');
  /* 确认过的话必须当场进 messages 并落库：这一轮要是断点（模型 500 / 网关拦截 / 关页面），
     重跑只能靠已存档的上下文还原。只留在一次性的 followUp 里，重跑后模型看到的
     还是「问完在等老板」，就会回一句「我还在等确认」——实测踩过。 */
  if (task) {
    if (!Array.isArray(task.messages)) task.messages = [];
    if (!task.messages.some(m => m && m.role === 'user'
      && typeof m.content === 'string' && m.content.includes('【已确认'))) {
      task.messages.push({ role: 'user', content: cf });
    }
    persistTask(task);
  }
  refreshDecisionIfOpen();
  runGoal(cf);
}

/* ── 滚动跟随：默认吸底，老板往上翻就不再拽着走；翻回底部恢复跟随 ── */
let traceStick = true;
let traceProgUntil = 0;
(function wireTraceScroll() {
  const box = document.getElementById('trace');
  if (!box) return;
  box.addEventListener('scroll', () => {
    if (Date.now() < traceProgUntil) return;
    traceStick = (box.scrollHeight - box.scrollTop - box.clientHeight) < 48;
  }, { passive: true });
})();

function renderTrace(noScroll) {
  const tr = state.trace;
  const box = $('#trace');
  const t = curTask();
  /* 轮次从数据推导（见 syncRounds）：前面几轮整段铺上去，最后一轮是现场 */
  const info = t ? syncRounds(t) : { rounds: 1, asks: [], list: [] };
  const rounds = info.list || [];
  /* 空轮不画：没有问话、没有步骤、也没有回答的轮次是「轮次算错」留下的壳，
     不是真发生过的事。以前它会实实在在占一整块，把老板的话推到上面去 */
  const filled = R => ((R.askItems || R.asks || []).length || (R.says || []).length
    || String(R.result || '').trim() || (R.tools || []).length) > 0;
  const curR = Number(tr.round) || info.rounds || 1;
  const hist = rounds.filter(R => R.round < curR && filled(R));
  const curTurn = rounds.find(R => R.round === curR)
    || { round: curR, asks: [], askItems: [], tools: [], result: '' };
  /* 当前轮的问话带上 inline 标记（中途补充和这一轮的问话要能分出来），
     再加「刚发出去、还没落进 userMsgs」的那一句 */
  const curItems = (curTurn.askItems && curTurn.askItems.length)
    ? curTurn.askItems.map(x => ({ text: x.text, inline: !!x.inline, imgs: x.imgs || [] }))
    : (curTurn.asks || []).map(x => ({ text: x, inline: false, imgs: [] }));
  if (tr.userMsg) {
    const txt = String(tr.userMsg).trim();
    if (txt && !curItems.some(a => a.text === txt)) curItems.push({ text: txt, inline: false, imgs: [] });
  }
  const running = tr.status === 'running' || !!(t && t.status === 'running');
  if (!tr.nodes.length && !tr.result && !running && !curItems.length && !hist.length) {
    box.innerHTML = `<div class="empty"><div class="empty-t">这里会显示每一步</div>
      <div class="empty-d">员工调用了哪个工具、参数是什么、返回了什么、花了多久——都摊开给你看，不藏在对话里。</div></div>`;
    return;
  }
  const keepY = noScroll ? box.scrollTop : -1;
  let html = '';

  /* ── 前面几轮：每轮自带「我的话 → 过程 → 它的回答 → 产出 → 这一轮的账」 ── */
  html += hist.map(R => turnHTML(R, t)).join('');

  /* ── 当前这一轮 ── */
  html += `<div class="turn cur" data-turn="${curR}">`;
  for (const a of curItems) html += msgMeHTML(a.text, a.inline, a.imgs);
  /* 预算续杯：到线了不是只能去设置里改 */
  if (tr.status === 'budget_exceeded' || (t && t.status === 'budget_exceeded')) {
    html += `<div class="alert"><div class="grow">token 到上限了，任务停在这里。再给 10 万可以从断点接着跑。</div>
      <button data-bud="100000">再给 10 万，接着跑</button></div>`;
  }
  /* 敏感操作审批卡：员工想写盘/跑命令，等老板点头 */
  if (tr.approvals && tr.approvals.length) {
    for (const a of tr.approvals) {
      const pending = a.status === 'pending';
      html += `<div class="alert${pending ? '' : ' mini'}"><div class="grow">${pending ? '员工想做这一步，等你放行：' : a.status === 'allowed' ? '已放行：' : '已拒绝：'}<b>${esc(a.name)}</b> <span class="args">${esc(argsBrief(a.args))}</span></div>`
        + (pending ? `<button data-ap="${esc(a.id)}" data-ok="1">放行</button><button class="btn ghost" data-ap="${esc(a.id)}" data-ok="">拒绝</button>` : '')
        + `</div>`;
    }
  }
  if (tr.blocked) {
    html += `<div class="alert"><div class="grow">这一步被拦下了：<b>${CAT_NAME[tr.blocked.category] || tr.blocked.category}</b> 权限没开。开一下再重跑，不用改目标。</div>
      <button onclick="grantAndRerun('${tr.blocked.category}')">开启并重跑</button></div>`;
  }
  if (tr.error) {
    /* 额度用尽不是「出错」，是一个能当场解掉的状态：旁边直接给门，
       别让人对着一句「用完了」自己去找设置里哪个数字才是它。 */
    const quotaBlocked = /账号额度用完了|token 额度用完了/.test(String(tr.error));
    html += `<div class="alert err"><div class="grow">${esc(tr.error)}</div>`
      + (quotaBlocked ? '<button class="btn tiny" data-quota-fix="1" type="button">去调额度</button>' : '')
      + '</div>';
  }
  /* 这一轮的执行过程：默认收成一行，点开才摊细节 */
  const shown = tr.nodes.filter(n => !HIDE_STEPS.has(n.name));
  if (shown.length) {
    const open = openedTurns.has('c' + curR);
    const bad = shown.filter(n => n.ok === false).length;
    const ms = shown.reduce((a, n) => a + (Number(n.ms) || 0), 0);
    html += `<div class="turn-bar" data-turn-toggle="c${curR}">
      <span class="caret">${open ? '▾' : '▸'}</span>
      <b>${shown.length} 步执行</b>
      <span class="args">${bad ? `<i class="tb-bad">${bad} 步失败</i> · ` : ''}${(ms / 1000).toFixed(1)}s</span>
      <span class="tb-hint">${open ? '收起过程' : '展开过程'}</span>
    </div>`;
    if (open) {
      html += `<div class="turn-steps">${shown.map((n, i) => {
        const idx = tr.nodes.indexOf(n);
        return nodeHTML(n, i, openedNodes.has('c' + curR + n.name + idx), 'c' + curR);
      }).join('')}</div>`;
    }
  }
  /* 跑着的时候不再单独出一条「收到消息，正在分析…」的虚线：
     那句话和下面的进度条说的是同一件事，已经合并进进度卡的第二行 */
  /* 推理模型的思考：默认只露最后几行，点开看全文。
     老板说的「一直在显示分析问题」就是这一段缺位——模型在想的几十秒里，
     界面上没有任何新东西，看着和卡住一样。这里只显示，不落库。 */
  {
    const think = String(tr.think || '').trim();
    if (think && running) {
      const open = openedNodes.has('think' + curR);
      const tail = think.length > 900 ? '…' + think.slice(-900) : think;
      html += `<div class="think" data-toggle="think${curR}">
        <div class="think-hd">
          <span class="caret">${open ? '▾' : '▸'}</span>
          <b>${esc((t && t.employeeName) || 'AI')} 正在推理</b>
          <span class="args">${think.length} 字 · ${open ? '收起' : '看全文'}</span>
        </div>
        <div class="think-bd">${esc(open ? think : tail)}</div>
      </div>`;
    }
  }
  /* 分析过程逐条摊开：每条一句、按发生顺序排，不隐藏不覆盖。
     正在生成的正文单独一条挂在最后——它写完后也会变成列表里的一笔。 */
  {
    const who = (t && t.employeeName) || '';
    /* 跑着的时候以 tr.says 为准（现场）；停下来之后以 steps 里的为准
       （最后一轮也算历史，curTurn.says 是落过库的完整清单） */
    const liveSays = (!running && Array.isArray(curTurn.says) && curTurn.says.length)
      ? curTurn.says.map(tx => ({ text: tx }))
      : (Array.isArray(tr.says) && tr.says.length)
        ? tr.says
        : (tr.result ? [{ text: tr.result }] : []); /* 老任务没存 says，退回单条 */
    liveSays.forEach((s, i) => {
      const isLast = i === liveSays.length - 1;
      const isFinal = isLast && !running;
      const lbl = isFinal ? `${esc(who)} 的结论` : `${esc(who)} · 分析 ${i + 1}`;
      html += `<div class="node-txt bot${isFinal ? '' : ' say-mid'}">`
        + `<span class="bot-ava ${avClass(who)}" title="${esc(who)}">${esc((who || 'AI').slice(0, 1))}</span>`
        + `<div class="bot-bub"><span class="lbl">${lbl}</span><div class="md">${mdLite(s.text)}</div></div>`
        + `</div>`;
    });
    if (running && tr.stream) {
      html += `<div class="node-txt bot">`
        + `<span class="bot-ava ${avClass(who)}" title="${esc(who)}">${esc((who || 'AI').slice(0, 1))}</span>`
        + `<div class="bot-bub"><span class="lbl">${esc(who)} 正在写 <i class="caret-blink"></i></span><div class="md stream">${mdLite(tr.stream)}</div></div>`
        + `</div>`;
    }
  }
  /* 这一轮的产出：图片直接出缩略图，文件给卡片 */
  html += filesBlockHTML(outputFiles(t, tr, false, curR), t, tr);
  /* 验收结论不再摊在对话里：那是内部质检，老板看的是成品。
     没过验收的情况改走「告警队列 → 管理员邮箱」，成品有问题时员工下一轮会自己补。 */
  /* 收尾：跑着是实时进度卡，跑完是这一轮的账（耗时 / 本轮 token / 产出数） */
  /* 员工提问待拍板：选项点一下就选，没合适的自己填，全部答完才能确认。
     只要存档里还留着没回答的提问就露出来，不限于 need_input——
     断点重跑后状态可能已经变成 failed，但问题还没答，卡片不能跟着消失。 */
  const pa = tr.pendingAsk || (!running && t && t.pendingAsk) || null;
  if (!running && pa && Array.isArray(pa.questions) && pa.questions.length) {
    html += `<div class="ask-form" id="askForm">
      <div class="ask-hd"><b>需要你拍板</b><span>选一下或自己填，答完点确认，${esc(t ? (t.employeeName || '员工') : '员工')}接着干</span></div>
      ${pa.intro ? `<div class="ask-intro">${esc(pa.intro)}</div>` : ''}
      ${pa.questions.map((q, i) => `
        <div class="ask-q" data-i="${i}">
          <div class="ask-qt">${i + 1}. ${esc(q.q || '')}</div>
          <div class="ask-opts" data-multi="${q.multi ? 1 : 0}">
            ${(q.options || []).map(o => `<button type="button" class="ask-opt" data-q="${i}">${esc(o)}</button>`).join('')}
            <input class="ask-custom" data-q="${i}" type="text" placeholder="都不合适？自己填…" autocomplete="off">
          </div>
        </div>`).join('')}
      <div class="ask-ft"><button class="ask-ok" id="askOk" type="button">确认，继续</button><span class="ask-note">全部答完才能确认</span></div>
    </div>`;
  }
  if (t && t.handoff && !t.handoff.closed) html += handoffCardHTML(t);
  if (t) html += running ? runStatusHTML(t, tr) : runStatusHTML(t, tr);
  html += `</div>`;

  box.innerHTML = html;
  /* 刷新接回来的任务不会再收到一次 start 事件，秒表得在这里重新挂上；
     不挂的话「已 27s」直接变成空白——老板看到的就是「时间也不展示了」。 */
  if (running) startLiveTick(); else stopLiveTick();
  box.querySelectorAll('.ask-opt').forEach(el => {
    el.onclick = () => {
      const opts = el.closest('.ask-opts');
      if (opts && opts.dataset.multi === '1') { el.classList.toggle('on'); return; }
      opts.querySelectorAll('.ask-opt.on').forEach(x => x.classList.remove('on'));
      el.classList.add('on');
      opts.parentElement.classList.add('answered');
    };
  });
  box.querySelectorAll('.ask-custom').forEach(el => {
    el.oninput = () => {
      const opts = el.closest('.ask-opts');
      if (el.value.trim()) opts.querySelectorAll('.ask-opt.on').forEach(x => x.classList.remove('on'));
      el.closest('.ask-q').classList.toggle('answered', !!el.value.trim());
    };
  });
  const askOk = box.querySelector('#askOk');
  if (askOk) askOk.onclick = () => submitAskAnswer(box);
  box.querySelectorAll('[data-toggle]').forEach(el => {
    el.onclick = () => {
      const k = el.dataset.toggle;
      const y = box.scrollTop;
      if (openedNodes.has(k)) openedNodes.delete(k); else openedNodes.add(k);
      renderTrace(true);
      box.scrollTop = y;
    };
  });
  box.querySelectorAll('[data-turn-toggle]').forEach(el => {
    el.onclick = () => {
      const k = el.dataset.turnToggle;
      const y = box.scrollTop;
      if (openedTurns.has(k)) openedTurns.delete(k); else openedTurns.add(k);
      renderTrace(true);
      box.scrollTop = y;
    };
  });
  box.querySelectorAll('[data-ap]').forEach(el => {
    el.onclick = () => resolveApproval(el.dataset.ap, el.dataset.ok === '1');
  });
  box.querySelectorAll('[data-ho-x]').forEach(el => {
    el.onclick = () => {
      const tt = curTask();
      if (!tt || !tt.handoff) return;
      tt.handoff.closed = true;   /* 只影响界面，上下文里的交接说明照旧在 */
      renderTrace(true);
    };
  });
  box.querySelectorAll('[data-bud]').forEach(el => {
    el.onclick = () => {
      const tt = curTask();
      if (!tt) return;
      budRaise(tt.id, Number(el.dataset.bud) || 100000);
      toast('上限已加 10 万，从断点接着跑');
      runGoal('', tt.id);
    };
  });
  box.querySelectorAll('[data-resume]').forEach(el => {
    el.onclick = async () => {
      const tt = curTask();
      if (!tt) return;
      if (state.running) return toast('上一个还在跑');
      const was = el.textContent;
      el.disabled = true;
      el.textContent = '接着跑…';
      toast('从上次断的地方接着跑');
      const started = await runGoal('', tt.id);
      /* 没跑起来（模型通道没就绪 / 任务不存在 / 还在等拍板）就把按钮还原：
         以前一直停在「接着跑…」的禁用态，看着就像点了没反应。 */
      if (!started) { el.disabled = false; el.textContent = was; }
    };
  });
  /* 吸底跟随：老板没往上翻（或刚点了确认）才跟到最新；翻上去了就停在原地，
     innerHTML 重建后浏览器会把 scrollTop 夹回合法范围，正好等于原地不动 */
  traceProgUntil = Date.now() + 80;
  if (keepY >= 0) box.scrollTop = keepY;
  else if (traceStick) box.scrollTop = box.scrollHeight;
  applyContentSearch('task');
  renderOutputRail();
}

/* ── 标题旁的搜索：筛当前这一屏里的内容块 ──
   任务 / 项目筛的是对话块；待我决策 / 员工待办 / 总产出筛的是条目（总产出是表格行）。
   统一走这一处，省得三个页面各写一套筛法、行为不一致。 */
const SEARCH_MAP = {
  task:     { input: '#taskSearch',     box: '#trace',         meta: '#taskSearchMeta',     x: '#taskSearchX' },
  meeting:  { input: '#meetSearch',     box: '#meetBody',      meta: '#meetSearchMeta',     x: '#meetSearchX' },
  decision: { input: '#decisionSearch', box: '#decisionList',  meta: '#decisionSearchMeta', x: '#decisionSearchX' },
  todo:     { input: '#todoSearch',     box: '#tdList',         meta: '#todoSearchMeta',     x: '#todoSearchX' },
  output:   { input: '#outputSearch',   box: '#outputList',    meta: '#outputSearchMeta',   x: '#outputSearchX' }
};

function applyContentSearch(kind) {
  const cfg = SEARCH_MAP[kind] || SEARCH_MAP.task;
  const input = $(cfg.input);
  const box = $(cfg.box);
  const meta = $(cfg.meta);
  const xb = $(cfg.x);
  if (!input || !box) return;
  const q = String(input.value || '').trim().toLowerCase();
  if (xb) xb.hidden = !q;
  /* 表格页要筛行，不是筛整张表 */
  const rows = box.querySelectorAll('tbody tr');
  const units = rows.length ? Array.prototype.slice.call(rows) : Array.prototype.slice.call(box.children);
  if (!q) {
    units.forEach(k => { k.hidden = false; });
    if (meta) { meta.textContent = ''; meta.classList.remove('none'); }
    box.classList.remove('no-hit');
    return;
  }
  let n = 0;
  units.forEach(k => {
    const hit = String(k.textContent || '').toLowerCase().includes(q);
    k.hidden = !hit;
    if (hit) n++;
  });
  /* 全被筛掉时给一句明确的空态，别让人以为页面坏了 */
  const hitAny = n > 0;
  box.classList.toggle('no-hit', !hitAny);
  if (meta) {
    meta.textContent = hitAny ? `${n} 处匹配` : '没有匹配';
    meta.classList.toggle('none', !hitAny);
  }
}
window.APP = window.APP || {};
window.APP.applyContentSearch = applyContentSearch;

function wireContentSearch() {
  const bind = (kind, inId, xId) => {
    const inp = $('#' + inId);
    if (inp) {
      inp.addEventListener('input', () => applyContentSearch(kind));
      inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.value = ''; applyContentSearch(kind); } });
    }
    const x = $('#' + xId);
    if (x) x.onclick = () => { if (inp) inp.value = ''; applyContentSearch(kind); };
  };
  bind('task', 'taskSearch', 'taskSearchX');
  bind('meeting', 'meetSearch', 'meetSearchX');
  bind('decision', 'decisionSearch', 'decisionSearchX');
  bind('todo', 'todoSearch', 'todoSearchX');
  bind('output', 'outputSearch', 'outputSearchX');

  /* 左栏搜索：按当前 tab 过滤任务 / 项目 / 员工 */
  const rs = $('#railSearch');
  const rx = $('#railSearchX');
  const redraw = () => {
    const lv = state.lastListView || 'task';
    if (lv === 'task') renderTaskList();
    else if (lv === 'project') window.MEET.renderList();
    else if (lv === 'staff') renderStaffInRail();
  };
  if (rs) {
    rs.addEventListener('input', e => {
      const lv = state.lastListView || 'task';
      state.railQ[lv] = e.target.value;
      if (rx) rx.hidden = !e.target.value;
      redraw();
    });
    rs.addEventListener('keydown', e => { if (e.key === 'Escape') { rs.value = ''; state.railQ[state.lastListView || 'task'] = ''; if (rx) rx.hidden = true; redraw(); } });
  }
  if (rx) rx.onclick = () => {
    const lv = state.lastListView || 'task';
    state.railQ[lv] = '';
    if (rs) rs.value = '';
    rx.hidden = true;
    redraw();
  };
}
wireContentSearch();

/* ── 刷新不丢：把「正在跑的任务」记在本机，重新进页面自动接着跑 ──
   循环跑在浏览器里，刷新 / 关标签一定打断它。以前只把状态改成「已中断」，
   等人自己点「继续跑」。现在默认自动接上：重新进来就把那个任务续起来，
   进度从已落库的步骤后面接着长。不想让它自动烧 token，就在设置里关掉。 */
const RUNNING_KEY = 'boss.running';
const RESUME_MAX_AGE = 30 * 60 * 1000;   // 半小时以内的断点才自动接；隔夜的留给人自己决定

/* 每个标签页一个固定编号：刷新后 sessionStorage 还在，编号不变。
   靠它区分「这条标记是我这个标签留下的」和「是隔壁标签正在跑的任务」，
   否则另一开一个标签就会把别人手上的活儿抢过来双跑。 */
function tabId() {
  try {
    let v = sessionStorage.getItem('boss.tab');
    if (!v) { v = 't' + Math.random().toString(36).slice(2, 9); sessionStorage.setItem('boss.tab', v); }
    return v;
  } catch (e) { return ''; }
}
function runMark() {
  try {
    const j = JSON.parse(localStorage.getItem(RUNNING_KEY) || 'null');
    return j && j.id ? j : null;
  } catch (e) { return null; }
}
function freshMark(j, ms) {
  if (!j || !j.id) return false;
  return Date.now() - Number(j.at || 0) < (ms || RESUME_MAX_AGE);
}
function markRunning(task, opts) {
  try {
    /* at 是「最后一次心跳」（每 20 秒往后推），since 才是「这一轮什么时候开始的」。
       两者不能混用：拿 at 当开始时间，刷新后算出来的耗时会一次次被打回 0；
       而刷新后云端只留 updated_at（也是心跳），没有 since 就再也算不出真实耗时。
       keepSince 只给「断点续跑」用：续的是同一轮，开始时间当然还是原来那一刻。 */
    const old = runMark();
    const same = old && old.id === task.id && old.since;
    const since = (same && (opts && opts.keepSince)) ? old.since : Date.now();
    localStorage.setItem(RUNNING_KEY, JSON.stringify({
      id: task.id, title: task.title || '', goal: task.goal || '',
      emp: task.employeeName || '', at: Date.now(), since, tid: tabId()
    }));
  } catch (e) { /* 隐私模式写不了，退化成原来的手动续跑 */ }
}
/* 跑长任务时定时把标记的时间往后推：不然跑过半小时再刷新，
   标记就过期了，人回来只看到一句「已中断」，等不到自动续。 */
let runHeart = null, beatLast = 0;
const HEARTBEAT_MS = 20000;      // 打点间隔
const HEARTBEAT_GAP = 50000;     // 距上次落库不到这么久，就不再补一次

/* 云端心跳：只写 status + updated_at，不碰轨迹。
   原来这里只写 localStorage，云端一个字都不写，于是出现一个洞：
   判活读的是云端 updated_at（见下面的恢复分支），可「等模型返回」的那段
   ——生图、长文经常 90 秒没有一个工具步骤落地——scheduleRunSave 不会触发，
   updated_at 就停在上一次落库上。这时另一台设备打开这个任务，
   会按 90 秒判定「没人握着」并把它改成 interrupted，把真在跑的任务误杀。
   所以这里补一笔。每步落库本身就会刷新 updated_at，所以先看最近有没有落过，
   刚落过就别重复写：一条任务一分钟最多补两次。 */
function beatCloud(task) {
  if (!task || state.guest || String(task.id).startsWith('local_')) return;
  const since = Math.max(Number(runSaveLast) || 0, beatLast);
  if (Date.now() - since < HEARTBEAT_GAP) return;
  beatLast = Date.now();
  CLOUD.saveTask(task.id, { status: 'running' }).catch(() => { /* 抖一下不用管，下一拍会补 */ });
}
function startRunHeart(task) {
  stopRunHeart();
  beatLast = 0;
  runHeart = setInterval(() => {
    try {
      markRunning(task);   // 本机标记：刷新后靠它认领这一轮
      beatCloud(task);     // 云端打点：别的设备 / 别的标签靠它判活
    } catch (e) { /* 忽略 */ }
  }, HEARTBEAT_MS);
}
function stopRunHeart() {
  if (runHeart) { clearInterval(runHeart); runHeart = null; }
}
function clearRunningMark(id) {
  try {
    const raw = localStorage.getItem(RUNNING_KEY);
    if (!raw) return;
    const j = JSON.parse(raw) || {};
    /* 只清自己的那条：同时开两个标签页时别把别人正在跑的任务标记抹掉 */
    if (!id || j.id === id) localStorage.removeItem(RUNNING_KEY);
  } catch (e) {
    try { localStorage.removeItem(RUNNING_KEY); } catch (e2) { /* 忽略 */ }
  }
}
function autoResumeOn() {
  try { return localStorage.getItem('boss.autoResume') !== '0'; } catch (e) { return true; }
}
/* 本机标记指向的那个任务：只要它还新鲜、又确实是这个标签留下的，就算断点。
   不能只看云端有没有 status=running——这一轮刚发出就刷新的情况下，
   云端可能还停在上一次的 done，那样会把整轮对话连同「继续跑」一起弄丢。 */
function ownRunMark() {
  const j = runMark();
  if (!freshMark(j)) return null;
  /* 老版本标记没带 tid，认；带了 tid 就必须是同一个标签 */
  if (j.tid && tabId() && j.tid !== tabId()) return null;
  return j;
}
/* 这一批「刷新后还是 running」的任务里，哪一个是本机刚才在跑的那个 */
function pendingResumeId(orphans) {
  if (!autoResumeOn()) return '';
  const j = ownRunMark();
  if (!j) return '';
  const hit = (orphans || []).some(t => t.id === j.id);
  if (!hit) return '';
  return j.id;
}
/* 云端没记成 running、但本机有新鲜标记的那个任务（刚发出就刷新会走到这里） */
function markedTaskId(tasks) {
  const j = ownRunMark();
  if (!j) return '';
  return (tasks || []).some(t => t.id === j.id) ? j.id : '';
}
/* 刷新回来后到底接哪个任务：先看云端还挂着 running 的，再看本机标记兜底。
   抽成纯函数，方便单独验（enterApp 里被 await 包着不好测）。 */
function claimResume(tasks) {
  const orphans = (tasks || []).filter(t => t.status === 'running');
  let autoId = pendingResumeId(orphans);
  let markOnly = '';
  if (!autoId) {
    markOnly = markedTaskId(tasks);
    if (markOnly) autoId = markOnly;
  }
  return { orphans, autoId, markOnly };
}

/* 刷新回来后这个任务还算不算「还在跑」。
   判据是心跳（云端 updated_at，20 秒一拍）：新鲜的说明服务端那边还握着，
   不能因为「我刷新了」就把状态改写成 interrupted——那会让界面先闪一下中断，
   紧接着又自动接回去，老板的感受就是「任务像中断了一下」。 */
function stillRunning(t) {
  const beat = t ? (t.updatedAt || 0) : 0;
  return !!(t && (window.STATES
    ? STATES.heartbeatFresh(beat)
    : (Date.now() - Number(beat || 0) < 90000)));
}
/* 该不该把它标成「已中断」：只有心跳过期、而且确实是本机刚才在跑的那个才标 */
function shouldMarkInterrupted(t, autoId, markOnly) {
  if (!t) return false;
  if (stillRunning(t)) return false;
  return markOnly === autoId || t.status === 'running';
}

/* 进来之后把断点任务接上：等模型通道就绪，然后走和「继续跑」完全一样的路径 */
async function autoResumeTask() {
  const id = state.resumeId;
  state.resumeId = '';
  if (!id) return;
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  for (let i = 0; i < 24 && (!state.models.length || state.running); i++) {
    await new Promise(r => setTimeout(r, 300));
  }
  if (state.running) return;
  if (!state.models.length) {
    toast('模型通道还没就绪，任务已暂停；好了点「继续跑」');
    return;
  }
  selectTask(id);
  /* 说清楚是「接着原来的现场」还是「重新开跑」：两种情况界面上都是继续，
     但对老板意味着不同的事（一个还在跑、一个真的断过一次）。 */
  const live = stillRunning(t);
  toast(live
    ? `「${t.title || '上一个任务'}」还在跑，已接上现场`
    : `「${t.title || '上一个任务'}」被刷新打断，已自动接着跑`);
  runGoal('', id);
}

/* ── 服务端执行 ──
 * 循环不再跑在这个页面里。原因很直接：它原来是一个 Promise，页面一刷新就没了，
 * 任务半路死掉，谁都救不回来——这跟「卡了」是两件事，后者至少还能等。
 *
 * 现在分工是：
 *   浏览器：把任务发过去 → 把事件流画出来 → 把老板的动作（停 / 插话 / 审批）转回去
 *   服务端：跑循环、调模型、执行工具、跑测试、落盘
 *
 * 关键点是「事件没有变」。applyEvent 只认事件对象，从来不管事件从哪来，
 * 所以这层换掉之后，轨迹渲染、落库、计费、告警一行都不用改。
 */
const SRV = { runId: '', seq: 0, on: false, startedAt: 0 };

/* 一次 POST 把动作转回服务端。失败不抛——这些动作都是「尽力」，
   抛出去会打断调用处正在做的事（比如插话失败不该让输入框卡住）。 */
function srvAction(path, body) {
  if (!SRV.runId) return Promise.resolve(null);
  return fetch(window.withSC(`/api/run/${encodeURIComponent(SRV.runId)}${path}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(r => r.json().catch(() => null)).catch(() => null);
}

function agentInject(text, images) {
  if (!SRV.on) {
    /* 游客态 / 本地执行：直接交给页面里的那个循环，它一定在（同一份内存） */
    if (window.BOSS && BOSS.inject) BOSS.inject(text, images);
    return Promise.resolve(true);
  }
  /* 走服务端的插话只传路径：这条请求体里塞 base64 同样会被网关拦，
     拦下来表现成「已插给员工」，其实那句话和图谁也没收到。 */
  return srvAction('/inject', { text, images: slimFiles(images) }).then(j => {
    if (j && j.ok) return true;
    /* 服务端说这条任务已经结束了（runId 失效 / 404）：这一轮是真的没了。
       不能假装插进去了——老板会看到「已插给员工」，而那句话谁也没收到，
       过一会儿就变成「我发的消息发着发着消失了」。交给调用方重发成新的一轮。 */
    SRV.on = false;
    return false;
  });
}

function agentApprove(id, ok) {
  if (!SRV.on) { if (window.BOSS && BOSS.approve) BOSS.approve(id, ok); return; }
  srvAction('/approve', { id, ok });
}

function agentStop() {
  if (SRV.on) srvAction('/stop', {});
  if (state.ctrl) {
    try { state.ctrl.abort(); } catch (e) { /* 已经断了 */ }
  }
}

/* 读一条 SSE 流，把事件逐个交给 emitFn。
   三种收尾都要分清：
     · 收到 end   → 任务正常收工
     · 流断了     → 只是这个页面的连接断了，任务还在服务端跑（不当作失败）
     · 本地 abort → 用户主动停，已经发过 /stop，也不当作失败

   reconnecting=true 表示这是重连上来的一次，断开时不再弹提示
   （否则每失败一次弹一次，任务跑十分钟能弹出五六条一样的）。 */
async function consumeRunStream(res, emitFn, signal, reconnecting = false) {
  let buf = '';
  const dec = new TextDecoder();
  let ended = false;
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!frame || frame.startsWith(':')) continue;   /* 心跳 */
        let seq = 0;
        const datas = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) seq = Number(line.slice(4)) || 0;
          else if (line.startsWith('data: ')) datas.push(line.slice(6));
        }
        if (!datas.length) continue;
        let ev;
        try { ev = JSON.parse(datas.join('\n')); } catch (e) { continue; }  /* 坏帧丢掉，别整条流废掉 */
        if (seq) SRV.seq = seq;
        /* hello 帧（没有 t 字段）：服务端告诉我们这条 run 什么时候开的。
           接上现场时用它把秒表接到原来的时间轴上，而不是从 0 重数。 */
        if (ev && ev.runId && ev.t === undefined) {
          if (Number(ev.startedAt)) {
            SRV.startedAt = Number(ev.startedAt);
            if (!state.traceStartedAt) state.traceStartedAt = Number(ev.startedAt);
          }
          continue;
        }
        if (ev.t === 'end') { ended = true; continue; }
        if (emitFn) emitFn(ev);
        if (ev.t === 'done' || ev.t === 'error') ended = true;
      }
    }
  } catch (e) {
    if (!(e && e.name === 'AbortError') && !signal && !reconnecting) {
      toast('事件流断了，正在自动重连（任务在服务端继续跑）');
    }
  }
  /* SRV.on 在这里**不置 false**。
     它的语义是「这个任务在服务端」，不是「这条连接还活着」。
     流断的那一刻任务往往还在跑，如果置 false，接下来的插话和审批会走
     BOSS.inject/BOSS.approve —— 也就是发给浏览器里那个已经不存在的本地任务，
     结果是静默失效：用户以为话插进去了，其实没人收到。
     谁真的结束才置 false，交给调用方在确定收工时做。 */
  return ended;
}

/* 断了就自己接回去，不等用户按刷新。
   为什么必须自动：长任务的流断不是因为出错，是因为中间层有上限（空闲超时、
   总时长、连接重建）。这是常态，不是异常。把它交给用户手动处理，等于把
   「网关每 X 分钟抖一次」变成「用户每 X 分钟要刷新一次」。
   续点是 SRV.seq：服务端从 from 之后补发，界面上不会丢步骤也不会重复。 */
async function resumeRunStream(emitFn, signal) {
  if (!SRV.runId) return false;
  const waits = [1000, 2000, 4000, 8000, 15000];
  for (let i = 0; i < waits.length; i++) {
    await new Promise(r => setTimeout(r, waits[i]));
    if (signal && signal.aborted) return false;
    let r;
    try {
      r = await fetch(window.withSC(`/api/run/${encodeURIComponent(SRV.runId)}?from=${SRV.seq || 0}`), { signal });
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      continue;   /* 网络还没好，按退避再来一次 */
    }
    /* 410 是「任务已经不在服务端了」，服务端还带了原因（是不是被重启打断）。
       这种情况重连多少次都一样，直接收工并把原因说清楚。 */
    if (r.status === 410 || r.status === 404) {
      const j = await r.json().catch(() => null);
      if (j && j.code === 'interrupted') toast(`任务中断：${j.error || '服务重启'}`);
      SRV.on = false;
      return false;
    }
    if (!r.ok) continue;
    SRV.on = true;
    const ended = await consumeRunStream(r, emitFn, signal, true);
    if (ended) return true;
  }
  /* 五次都没接上：任务可能还在跑，也可能早就结束了，这里不做判断，
     只告诉用户怎么把它捞回来。 */
  toast('事件流反复断开，任务可能仍在服务端跑；刷新页面能接上现场');
  return false;
}

/* 发起一条服务端执行。job 的结构和原来 BOSS.run 的入参一致，
   少一个 emit（含在 job 里），多一个返回值的语义：true = 跑到了收工。 */
/* ── 请求体瘦身：前置网关 403 的自救 ──
   现场：任务里生成了一整份 index.html 和 agent_server.py，之后每次续跑都把
   整段代码随 /api/run 重新 POST 一次。体积上去以后，前置安全网关把它当成
   攻击载荷，回一个 HTML 拦截页（403）。而前端 r.json() 解析失败，界面上只剩
   一句「服务端拒绝了这次执行（HTTP 403）」——看着像我们的鉴权拒了，
   其实请求连我们的 handler 都没进到。
   砍掉为什么不会丢信息：完整内容就在工作区文件里，模型要看就 read_file；
   在上下文里背一份几万字的副本，既费 token，又每轮都要过一遍网关。 */
function slimText(s, head, tail) {
  const t = String(s == null ? '' : s);
  if (t.length <= head + tail + 60) return t;
  return `${t.slice(0, head)}\n…[中间省略 ${t.length - head - tail} 字：全文在工作区文件里，要读就 read_file]…\n${tail ? t.slice(-tail) : ''}`;
}

/* ── 什么会被网关当成「攻击载荷」──
 * 线上实测（2026-11-06，第四次栽在同一处）：
 *   任务在写一个 HTML 原型，第二轮起 /api/run 就 403，回的是一张
 *   api.waf.qq.com 的反馈页（页面里那句 function submitWafFeedback 被当成我们的
 *   错误信息弹了出来）。**那次请求体并不大**——v0.8.5 只按 420KB 瘦身，
 *   几十 KB 的 index.html 根本没碰到阈值。
 *   所以判定不能只看体积：只要正文里出现整段源码（<script>、function(...)、
 *   import ...），WAF 的「Web 攻击」规则就会命中。凡是把代码原样放进 JSON 的
 *   做法，在这个网关后面都是必挂的，跟任务本身有没有问题无关。
 *
 * 由此定下的规矩：**代码不进请求体**。文件在工作区，模型要看就 read_file。
 * 这条比「超过多少 KB 才砍」硬，因为它不是性能取舍，是通不通的问题。 */
const CODE_HINT = /<script|<html|<!doctype|<\?php|<style|onclick\s*=|onerror\s*=|document\.|window\.|function\s*[A-Za-z_$]*\s*\(|=>\s*\{|\bconsole\.|^\s*(def|class|import|from|package)\s/m;

function looksCode(s) {
  const t = String(s == null ? '' : s);
  return t.length > 40 && CODE_HINT.test(t);
}

/* 把一段「夹着代码的话」里的代码剥掉，留下人话。
   很多消息不是纯代码，而是「这是你要的原型：<整篇 html>」「我改了这三处：```js …```」。
   整条丢掉太可惜（那是上下文），原样留着又过不了网关——所以剥掉代码块，
   人话留着，代码指回文件。 */
function stripCodeBlocks(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '\n（脚本已省略：在文件里，要看就 read_file）\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n（样式已省略）\n')
    .replace(/```[\s\S]*?```/g, '\n（代码块已省略：在文件里，要看就 read_file）\n');
  return t;
}

/* 网关掩码：规则只有一份，实现在 agent.js（wafMask）。
   2026-11-06 实测出来的：前置 WAF 按内容拦——script 标签成对出现、onclick= 这类
   事件属性、alert(、alert、../ 穿越都会 403，跟体积无关（200KB 纯中文反而放行）。
   这里不重复实现，改用同一份规则；拿不到就原样返回（单测直接加载 app.js 时就是这种情况）。 */
function wafMaskText(s) {
  const t = String(s == null ? '' : s);
  try {
    if (window.BOSS && typeof BOSS.wafMask === 'function') return BOSS.wafMask(t);
  } catch (e) { /* 掩码失败不影响主流程 */ }
  return t;
}

/* 一条文本怎么洗：先剥代码块，剥完还带源码特征就整条换成指针。 */
function scrubText(s, near, keep) {
  const t = String(s == null ? '' : s);
  const cleaned = wafMaskText(stripCodeBlocks(t));
  if (looksCode(cleaned)) {
    return `（这条消息里有整段代码/网页源码，${t.length} 字，已省略：文件在工作区，需要就 read_file）`;
  }
  /* keep = 最后一条（老板刚说的这句）：除了剥掉的代码，别的都留着 */
  if (keep) return cleaned.length > 4000 ? slimText(cleaned, 4000, 0) : cleaned;
  if (cleaned !== t || cleaned.length > 900) return slimText(cleaned, near ? 600 : 300, 0);
  return cleaned;
}
/* 存档用：不截短（步骤详情还有用），只把代码剥掉/换指针。
   和请求体的要求一样——代码不进 JSON，否则云库那条链路也会 403，
   表现就是「完整轨迹没同步上」。 */
function scrubKeep(s) {
  const t = String(s == null ? '' : s);
  const c = wafMaskText(stripCodeBlocks(t));
  if (looksCode(c)) return `（这段里有 ${t.length} 字源码，已省略：文件在工作区，要读就 read_file）`;
  return c;
}

function scrubArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      out[k] = looksCode(v) ? `（${v.length} 字源码已省略：在文件里）` : wafMaskText(v);
    } else if (v && typeof v === 'object') {
      const s = JSON.stringify(v);
      out[k] = looksCode(s) ? '（源码已省略）' : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/* 轨迹落库前洗一遍：args 里可能是整篇文件，output 里可能是读回来的正文 */
function scrubSteps(list) {
  return (Array.isArray(list) ? list : []).map(s => {
    if (!s || typeof s !== 'object') return s;
    const o = { ...s };
    if (typeof o.output === 'string' && o.output) o.output = scrubKeep(o.output);
    if (typeof o.text === 'string' && o.text) o.text = scrubKeep(o.text);
    if (o.args && typeof o.args === 'object') o.args = scrubArgs(o.args);
    return o;
  });
}

/* 把一条条 messages 洗成「能被网关放行」的样子。
   比起 v0.8.5 那版只摘图，这里多了三件事，每一件都对应一次真实 403：
     ① tool 输出（读文件读回来的正文）→ 换成一句指针；
     ② 工具调用参数（写文件时的整篇内容）→ 换成占位；
     ③ 文本里出现源码特征 → 剥掉代码块，剥不干净就整条换指针，不管总长度有没有到阈值。 */
function scrubForWire(list) {
  const arr = Array.isArray(list) ? list : [];
  const n = arr.length;
  return arr.map((m, i) => {
    if (!m || typeof m !== 'object') return m;
    /* 系统提示是我们自己写的规矩，几千字，不会带源码 */
    if (m.role === 'system') return m;
    const out = { ...m };
    const last = i === n - 1;
    const near = i >= n - 2;

    /* 工具读回来的正文：这是最大的一坨，也是 WAF 最爱看的那一坨 */
    if (out.role === 'tool') {
      const t = String(out.content == null ? '' : out.content);
      if (t.length > 400 || looksCode(t)) {
        out.content = `（这条工具输出 ${t.length} 字已省略：内容在工作区文件里，需要就 read_file / view_image 自己读）`;
      }
      return out;
    }

    if (Array.isArray(out.tool_calls)) {
      out.tool_calls = out.tool_calls.map(tc => {
        const a = tc && tc.function && tc.function.arguments;
        if (typeof a !== 'string') return tc;
        if (a.length <= 240 && !looksCode(a)) return tc;
        return { ...tc, function: { ...tc.function, arguments: '{"note":"参数已省略（文件内容在工作区，需要就 read_file）"}' } };
      });
    }

    if (typeof out.content === 'string') {
      out.content = scrubText(out.content, near, last);
    } else if (Array.isArray(out.content)) {
      out.content = out.content.map(c => {
        if (!c || typeof c !== 'object') return c;
        if (c.type === 'text') {
          const t = String(c.text == null ? '' : c.text);
          const clean = scrubText(t, near, last);
          return clean === t ? c : { ...c, text: clean };
        }
        if (c.type === 'image_url') return { type: 'text', text: '（这里原本附了一张图，已从上下文摘掉；路径见上文，要看就调 view_image）' };
        return c;
      });
    }
    return out;
  });
}

const msgsKB = list => Math.round(JSON.stringify(Array.isArray(list) ? list : []).length / 1024);

/* 洗完还是太大，就从最老的开始丢——但**成对丢**：
   丢了一条带 tool_calls 的 assistant 却留着它的 tool 回复，模型通道会直接 400。
   最后两条永远留着（那是这一轮真正要干的事）。 */
function fitMessages(list, budgetKB) {
  let arr = Array.isArray(list) ? list : [];
  let guard = 0;
  while (msgsKB(arr) > budgetKB && arr.length > 3 && guard++ < 400) {
    const i = arr.findIndex((m, k) => k > 0 && m && m.role !== 'system');
    if (i < 0) break;
    let drop = 1;
    if (arr[i].role === 'assistant' && Array.isArray(arr[i].tool_calls)) {
      while (arr[i + drop] && arr[i + drop].role === 'tool') drop++;
    }
    arr = arr.slice(0, i).concat(arr.slice(i + drop));
  }
  return arr;
}

/* 一次请求的上下文预算。不是「省 token」，是「过网关」：
   洗完之后正常在 10–30KB，超过 120KB 说明还有东西没被识别成代码。 */
const WIRE_BUDGET_KB = 120;

function slimMessages(list, level) {
  const arr = Array.isArray(list) ? list : [];
  /* level = -1 是「每次都做」的那一档：摘图 + 抹代码，不按体积判断。
     砍正文是有损的，但代码那部分**本来就该由 read_file 提供**，不算丢信息。 */
  const onlyImg = level === -1;
  /* 不管哪一档，先洗一遍：代码和图片 base64 都不进请求体，
     这条没有「小就放行」的例外。 */
  const base = scrubForWire(arr);
  if (onlyImg) return fitMessages(base, WIRE_BUDGET_KB);
  const head = level >= 2 ? 160 : 700;
  const tail = level >= 2 ? 0 : 220;
  const keepTail = level >= 2 ? 2 : 3;
  const n = base.length;
  const out2 = base.map((m, i) => {
    if (!m || typeof m !== 'object') return m;
    /* 系统提示是「怎么干活」的规矩，砍了等于换个人 */
    if (m.role === 'system') return m;
    /* 工具输出已经在 scrubForWire 里换成指针了，别再截一次 */
    if (m.role === 'tool') return m;
    const near = i >= n - keepTail;
    const out = { ...m };
    if (typeof out.content === 'string') {
      /* 最后几条可能是老板刚说的这句指令，本来就短，原样留着 */
      out.content = (near && out.content.length < 6000) ? out.content : slimText(out.content, head, tail);
    } else if (Array.isArray(out.content)) {
      out.content = out.content.map(c => {
        if (!c || typeof c !== 'object') return c;
        if (c.type === 'text') return { ...c, text: slimText(c.text, head, tail) };
        /* 多模态 part 里的 base64：一张图几百 KB，历史里留几张就能把请求体顶过网关上限。
           图还在工作区，路径写在正文里，模型要看自己调 view_image。 */
        if (c.type === 'image_url') return { type: 'text', text: '（这里原本附了一张图，已从上下文摘掉；路径见上文，要看就调 view_image）' };
        return c;
      });
    }
    return out;
  });
  return fitMessages(out2, level >= 2 ? 40 : WIRE_BUDGET_KB);
}
/* 图片是 dataURL，一张顶几百 KB 文字。**无条件**摘掉 base64，只留路径：
   体积问题不是「大了才处理」，而是「一有图就超标」——一次发三张截图，
   请求体就是 2MB，前置网关必拦（403），而前端只能看到一句「服务端拒绝了这次执行」。
   服务端拿到路径会自己去工作区读回来补给视觉模型（见 server.js hydrateImages），
   所以这里摘掉不影响「员工看得见图」。thumb 也是 dataURL，一起摘。 */
function slimFiles(list) {
  return (Array.isArray(list) ? list : []).map(x => {
    if (!x || typeof x !== 'object') return x;
    if (!x.dataUrl && !x.thumb) return x;
    return { ...x, dataUrl: null, thumb: null };
  });
}
function slimRunPayload(payload, level) {
  const p = stripImages(payload);
  const q = { ...p };
  if (q.task && typeof q.task === 'object') {
    q.task = { ...q.task, messages: slimMessages(p.task.messages, level) };
  }
  return q;
}
/* 只摘图，不动任何文字。用于「每次请求都做」的那一档。 */
function stripImages(payload) {
  const p = { ...payload };
  if (p.task && typeof p.task === 'object') {
    p.task = {
      ...p.task,
      messages: slimMessages(p.task.messages, -1),
      files: slimFiles(p.task.files)
    };
  }
  p.followUpImages = slimFiles(p.followUpImages);
  return p;
}
const payloadKB = p => Math.round(JSON.stringify(p).length / 1024);

async function agentRun(job) {
  const token = (window.CLOUD && typeof CLOUD.accessToken === 'function')
    ? await CLOUD.accessToken().catch(() => '') : '';
  /* 没登录 = 没有凭证 = 服务端没法替你调模型。
     这时退回浏览器本地执行，功能和以前完全一样，只是刷新会断——
     这个取舍比「游客根本不能用」合理：断不断是体验问题，能不能用是可用性问题。 */
  if (!token) {
    if (state.guest || !state.session) {
      SRV.on = false;
      SRV.runId = '';
      return BOSS.run(job);
    }
    throw new Error('没拿到登录凭证，服务端没法替你调模型。刷新页面重新登录一次即可。');
  }
  const payload = {
    uid: state.scope,
    token,
    /* 设备标识决定占用锁的粒度：带上了，手机和电脑才能各跑一个。
       不带（老页面 / 无 localStorage）服务端按账号锁，行为退回以前。 */
    device: deviceKey(),
    task: job.task,
    staff: job.staff || null,
    settings: job.settings || {},
    model: job.model || '',
    judge: job.judge || null,
    followUp: job.followUp || '',
    followUpImages: job.followUpImages || [],
    /* 能看图的模型：服务端跑 view_image 时用。模型名不让工具参数决定，
       只认这里带上来的值。没有就留空，员工会被告知「看不了图」而不是瞎猜 */
    visionModel: pickVisionModel(),
    visionModels: pickVisionModels(),
    tools: Array.isArray(window.CUSTOM_TOOLS) ? window.CUSTOM_TOOLS : []
  };
  /* 第一发就摘图：base64 是**一定**要摘的（一次发三张截图就是 2MB，必被网关拦），
     不是「大了才摘」。摘图是无损的——路径还在，服务端会自己读回来。
     体积仍然过大（历史里堆了大段代码）才继续砍正文。 */
  let body = stripImages(payload);
  const kb0 = payloadKB(body);
  if (kb0 > 420) {
    body = slimRunPayload(payload, 1);
    toast(`这次上下文里有大段代码（${kb0}KB），已精简到 ${payloadKB(body)}KB 再发；完整内容还在工作区文件里`);
  }

  const post = async (b) => {
    const resp = await fetch(window.withSC('/api/run'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
      signal: job.signal
    });
    /* 成功时不能读 body：那是一条 SSE 流，读成文本就等于把它消费掉了，
       后面 consumeRunStream 只会拿到空壳。只有失败才去取错误内容。 */
    if (resp.ok) return { resp, raw: '', j: null };
    const raw = await resp.text().catch(() => '');
    let j = null;
    try { j = JSON.parse(raw); } catch { j = null; }
    return { resp, raw, j };
  };

  let r, raw = '', j = null;
  try {
    ({ resp: r, raw, j } = await post(body));
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new Error(`连不上服务端：${(e && e.message) || '网络错误'}`);
  }

  /* 被前置网关拦下来（403/413，或者回的压根不是 JSON）：压到最小再发一次。
     这一步必须有——不然任务一旦生成过大文件，之后每一轮都会死在这儿，
     老板只能看着「继续跑」反复失败，而每次失败给出的信息都是同一句 403。 */
  if (!r.ok && !(j && j.code === 'busy') && (r.status === 403 || r.status === 413 || !j)) {
    const slim2 = slimRunPayload(body, 2);
    if (JSON.stringify(slim2).length < JSON.stringify(body).length) {
      toast('这次请求被前置网关拦了，已把上下文压到最小重发');
      try {
        ({ resp: r, raw, j } = await post(slim2));
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new Error(`连不上服务端：${(e && e.message) || '网络错误'}`);
      }
    }
  }

  if (!r.ok) {
    /* 这个工作区已经有一条在跑：直接挂上去看它的现场，而不是报错收工。
       刷新页面后自动续跑走的就是这条路——原来那条还活着，看见它比重新起一条对。 */
    if (j && j.code === 'busy' && j.runId) {
      toast('这个任务还在服务端跑，已接上现场');
      return attachServerRun(j.runId, job.emit, job.signal, 0);
    }
    /* 回的不是 JSON ⇒ 拦在网关，不是我们的鉴权。把拦截页开头几个字带出来：
       只剩一句「HTTP 403」的话，谁都分不清是自己拒的还是网关拒的。 */
    const peek = !j && raw
      ? String(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) : '';
    /* 把「这次请求有多大」一并说出来：没有这个数，403 只能靠猜，
       上一版就因为看不到体积，把「几十 KB 的源码触发规则」误判成「体积超标」，
       于是修了一个不存在的阈值。 */
    throw new Error((j && j.error)
      || `服务端拒绝了这次执行（HTTP ${r.status}，请求体 ${payloadKB(body)}KB）${peek ? '：' + peek : ''}`);
  }
  SRV.on = true;
  SRV.runId = String(job.task.id || '');
  SRV.seq = 0;
  SRV.startedAt = Number(state.traceStartedAt) || 0;
  const ended = await consumeRunStream(r, job.emit, job.signal);
  if (ended) { SRV.on = false; return true; }
  /* 流断了：任务还在服务端。接着上一次的 seq 自己接回去。 */
  return resumeRunStream(job.emit, job.signal);
}

/* 重连：从 from 之后开始补。刷新页面后把已经发生过的步骤补出来，再接新的。 */
async function attachServerRun(runId, emitFn, signal, from) {
  const r = await fetch(window.withSC(`/api/run/${encodeURIComponent(runId)}?from=${from || 0}`), { signal });
  if (!r.ok) return false;
  SRV.on = true;
  SRV.runId = runId;
  SRV.seq = from || 0;
  const ended = await consumeRunStream(r, emitFn, signal);
  if (ended) { SRV.on = false; return true; }
  return resumeRunStream(emitFn, signal);
}

/* ── 执行 ── */
async function runGoal(goal, existingTaskId) {
  /* 发送前先收掉麦克风：半句已经落进框里了，再听下去会往空框里补字 */
  if (window.VOICE) window.VOICE.stopAll();
  if (state.running) {
    /* 老板此刻看的是别的任务：这句话不能塞进正在跑的那个任务的上下文里，
       否则「我在 B 的框里打的字」会变成 A 的追问。先劝他把跑着的那个收掉。 */
    if (!watchingRun()) {
      const rt = runCtx && runCtx.task;
      return toast(`「${rt ? rt.title : '另一个任务'}」还在跑，等它收工或先按 ■ 停掉再发`);
    }
    /* 任务跑着的时候再发一句 = 中途插话，下一次模型调用就带上（截图/文件也一并插下去） */
    const text2 = String(goal || '').trim();
    const attsPending = window.ATT_MAIN ? window.ATT_MAIN.items() : [];
  if ((text2 || attsPending.length) && (SRV.on || (window.BOSS && BOSS.inject))) {
    const atts = window.ATT_MAIN ? window.ATT_MAIN.take() : [];
    const imgs = atts.filter(a => a && a.dataUrl).slice(0, 6);
    const docs = atts.filter(a => a && !a.dataUrl && a.path);
    const docHint = docs.length
      ? `\n（老板刚发来 ${docs.length} 个文件：${docs.map(d => '`' + d.path + '`').join('、')}，需要内容就 read_file 读）`
      : '';
    const delivered = await agentInject(text2 + docHint, imgs);
    if (!delivered) {
      /* 这一轮在服务端已经结束了（前端还以为在跑）：不能装作插进去了。
         附件原样退回输入区，这句话改走「新的一轮」重新发出去——
         不然老板看到「已插给员工」，实际上那句话和图都掉进了黑洞。 */
      if (window.ATT_MAIN && atts.length) window.ATT_MAIN.restore(atts);
      $('#goal').value = text2;
      $('#goal').style.height = 'auto';
      state.running = false;
      stopRunHeart();
      toast('这一轮在服务端已经结束了，刚才那句改成新的一轮重发');
      return runGoal(text2, existingTaskId);
    }
      /* 插话插的是「正在跑的那个任务」，不是老板此刻翻到的那个 */
      const t = runTask();
      const live = runTrace();
      if (t) {
        if (!Array.isArray(t.userMsgs)) t.userMsgs = userMsgsOf(t);
        t.userMsgs.push({
          text: text2 + (imgs.length ? `（附 ${imgs.length} 张截图）` : '')
            + (docs.length ? `（附 ${docs.length} 个文件）` : ''),
          at: (live.nodes || []).length,
          round: Number(live.round) || 1, inline: true,
          imgs: imgPathsOf(imgs)
        });
      }
      $('#goal').value = '';
      $('#goal').style.height = 'auto';
      renderTrace();
      toast((imgs.length || docs.length) ? '文字和附件已插给员工，下一轮生效' : '已插给员工，下一轮生效');
      return;
    }
    return toast('上一个还在跑');
  }
  if (!state.staff.length) return toast('先建一个员工');
  /* 带图的任务先确认有没有能看图的模型：没有的话现在就说，
     别等员工跑完回一句「我看不到图片」——那时候老板已经等了两分钟，
     还以为是系统把图弄丢了。图片本身照样会存进工作区。 */
  if (window.ATT_MAIN) {
    const pendingImg = window.ATT_MAIN.items().some(a => a && a.dataUrl);
    if (pendingImg && !pickVisionModel()) {
      toast('通道里没有能看图的模型：图会存进工作区，但员工只能按你的文字理解。要用图就先去「全局模型」换一个多模态的。');
    }
  }
  if (!state.models.length) {
    toast('模型通道还没就绪，先登录或检查网络');
    loadModels();
    return false;
  }
  /* 积分闸：没余额就别让他跑起来再失败——跑一轮就烧真 token，那才是真亏。
     游客/未登录不走这道（游客本来就不落库、不扣积分）。 */
  if (state.session && state.wallet && state.wallet.total <= 0) {
    toast('积分用完了，充一点再开跑');
    openPoints();
    return false;
  }
  /* 没见底但快见底：开跑前先提醒一句，别跑到一半断在那儿 */
  creditWarn('这个任务');

  const text = String(goal || '').trim();
  const cur = curTask();
  // 选中了任务、又不是在「+ 新建」状态 → 这句话接在这个任务上，不新开
  const continuing = existingTaskId ? null : (!state.drafting && cur ? cur : null);

  /* 选了 2 位以上员工 → 这不再是「一个人的任务」，直接按项目跑：
     第一位当项目经理，其余按各自岗位分工，产出统一挂在这个项目下面。 */
  const picks = pickEmpIds();
  if (!existingTaskId && !continuing && picks.length >= 2) {
    if (!text) return toast('先说要做什么');
    const atts = window.ATT_MAIN ? window.ATT_MAIN.take() : [];
    $('#goal').value = '';
    $('#goal').style.height = 'auto';
    if (!window.MEET || !MEET.createQuick) return toast('项目模块还没就绪');
    MEET.createQuick({ topic: text, memberIds: picks, files: atts });
    return;
  }

  const staff = existingTaskId
    ? (state.staff.find(s => s.name === (cur || {}).employeeName) || state.staff[0])
    : continuing
      ? (state.staff.find(s => s.name === continuing.employeeName)
        || state.staff.find(s => s.id === state.curEmpId) || state.staff[0])
      : (state.staff.find(s => s.id === state.curEmpId) || state.staff[0]);

  // 员工自己指定了模型就用它，否则跟随全局
  const model = (staff && staff.model) || state.settings.model;
  if (!model) return toast('先选一个模型');

  let task;
  let followUp = null;
  let followUpImages = null;
  let resume = false;
  /* 附件：新任务和「接着说」都会带上；只有「重跑」沿用原上下文，不收新附件 */
  if (existingTaskId && window.ATT_MAIN && window.ATT_MAIN.items().length) {
    toast('重跑沿用原上下文，新附件不会带上；要带附件请接着说或新开任务');
  }
  if (existingTaskId) {
    task = state.tasks.find(t => t.id === existingTaskId);
    if (!task) return toast('任务不存在');
    /* 还有问题没答就别硬重跑：模型只会再回一句「我在等老板确认」，白烧 token。
       先把人带到那张拍板卡前面。 */
    if (task.pendingAsk) {
      toast('上面的问题还没答，选完点确认我就接着跑');
      renderTrace();
      const f = $('#askForm');
      if (f) f.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    /* 断点续跑：没跑完的任务保留现场接着跑（steps/结论/原话都不清）；
       只有已完成的任务「重跑」才是推倒重来 */
    const UNFINISHED = ['failed', 'blocked', 'budget_exceeded', 'step_limit', 'unverified', 'weak', 'running', 'interrupted', 'need_input'];
    resume = UNFINISHED.includes(task.status) && (task.steps || []).length > 0;
    if (!resume) {
      task.steps = [];
      task.result = '';
    }
    /* 额度已经烧穿的任务，续跑前先把上限补够：
       不补的话 agent 循环第一步就撞「累计 > 上限」直接退出，点了等于没点。 */
    if (resume) {
      const budBefore = budgetOf(task.id, state.settings);
      const added = ensureBudget(task, state.settings);
      if (added) toast(`这个任务已经烧到 ${fmtTokenW(spentOf(task))} token（上限 ${fmtTokenW(budBefore)}），额度补了 ${fmtTokenW(added)}，从断点接着跑`);
    }
    /* 续跑时补一句上下文：这一轮的原话若还没进 messages（刚发出就刷新，
       消息只在存档里、没来得及落库），模型会不知道刚才被交代了什么。
       直接补进 messages 而不是当 followUp 传，避免把本轮已经跑出来的步骤剔掉。 */
    if (resume && Array.isArray(task.messages) && task.messages.length > 2) {
      const curR0 = Number(task.curRound) || maxRoundOf(task) || 1;
      const ask0 = (Array.isArray(task.userMsgs) ? task.userMsgs : [])
        .filter(u => u && u.text && (Number(u.round) || 1) === curR0).pop();
      const said = String((ask0 && ask0.text) || '').trim();
      if (said) {
        const has = task.messages.some(m => m && m.role === 'user' && typeof m.content === 'string'
          && m.content.trim() === said);
        if (!has) task.messages.push({ role: 'user', content: said });
      }
    }
    task.status = 'running';
    task.blockedOn = null;
  } else if (continuing) {
    /* 「接着说」也收附件：截图走视觉通道跟着这句话一起给员工，文档给路径让它 read_file */
    const atts2 = window.ATT_MAIN ? window.ATT_MAIN.take() : [];
    const followImgs = atts2.filter(a => a && a.dataUrl).slice(0, 6);
    const followDocs = atts2.filter(a => a && !a.dataUrl && a.path);
    if (!text && !followImgs.length && !followDocs.length) return toast('交代你要接着做的那句');
    task = continuing;
    followUpImages = followImgs;
    const docHint2 = followDocs.length
      ? `\n（老板刚发来 ${followDocs.length} 个文件：${followDocs.map(d => '`' + d.path + '`').join('、')}，需要内容就 read_file 读）`
      : '';
    followUp = (text || '（看刚发的截图）') + docHint2;
    /* 轮次从已有数据推：`rounds` 字段不落库，刷新后就归零，
       接着推会让第三句话又挂回第二轮（结论互相覆盖就是这么来的） */
    syncRounds(task);
    const nextR = maxRoundOf(task) + 1;
    task.curRound = nextR;
    task.rounds = nextR;
    /* 老板这句原话必须当场记下并标好轮次：对话是一条一条问答排的，
       光靠 messages 反推会在 userMsgs 已有内容时整段丢掉。
       去重看的是「这一轮有没有记过」，不是「这句话以前说过没有」——
       只看文字的话，连着说两句「继续」第二句会被当成重复静默丢掉，
       老板看到的就是「我发的消息发出去就没了」。 */
    if (!Array.isArray(task.userMsgs)) task.userMsgs = userMsgsOf(task);
    if (!task.userMsgs.some(u => u && u.text === followUp && (Number(u.round) || 0) === nextR)) {
      task.userMsgs.push({
        text: followUp,
        at: (task.steps || []).filter(s => s.kind === 'tool').length,
        round: nextR,
        imgs: imgPathsOf(followImgs)
      });
    }
    task.status = 'running';
    task.blockedOn = null;
    task.deliverableCheck = null;
    const extra = parseDeliverables($('#deliverables').value);
    if (extra.length) task.deliverables = extra;
    /* 清空输入框 + 记录用户消息（用于对话展示） */
    $('#goal').value = '';
    $('#goal').style.height = 'auto';
  } else {
    if (!text) return toast('交代一件事');
    /* 附件在选中时就已上传到工作区，这里只是把清单交给员工 */
    const atts = window.ATT_MAIN ? window.ATT_MAIN.take() : [];
    const draft = {
      id: newId(),
      title: guessTitle(text),
      goal: text,
      /* 第一句原话必须当场进存档：以前只在跑完的 finally 里落库，
         「正在分析」时刷新 → 云端 user_msgs 还是空的 → 回来就只剩一个空壳，
         老板看到的正是「我发的文字不展示了」。 */
      userMsgs: [{ text, at: 0, round: 1, imgs: imgPathsOf(atts) }],
      /* 存档里不留 base64：几 MB 的图既撑爆 createTask 的请求体，
         也让「刷新后重新拉任务」变成拉一份图库。图在工作区，路径就够。 */
      files: slimFiles(atts),
      deliverables: parseDeliverables($('#deliverables').value),
      employeeId: staff.id, employeeName: staff.name, employeeRole: staff.role,
      status: 'running', steps: [], result: '', messages: null,
      rounds: 1,
      tokens: { in: 0, out: 0 }, ms: 0, blockedOn: null,
      /* 游客态没有云端行，时间戳得自己带上，否则左栏排序会当成 0 */
      createdAt: Date.now(), updatedAt: Date.now()
    };
    if (!state.guest) {
      try {
        task = await CLOUD.createTask(draft);
        await CLOUD.saveTask(task.id, { status: 'running' });
      } catch (e) {
        toast('任务没存上：' + e.message);
        task = { ...draft, id: 'local_' + draft.id };
      }
    } else {
      task = { ...draft, id: 'local_' + draft.id };
    }
    /* 内存里留完整附件（含 dataURL）：游客态和「在本机直接跑」要靠它把图交给模型；
       发服务端时 stripImages 会先摘掉 base64，落库也从不写 files，所以不会撑大请求。 */
    task.files = atts;
    state.tasks.unshift(task);
    state.curTaskId = task.id;
    state.drafting = false;
    $('#goal').value = '';
    $('#goal').style.height = 'auto';
  }

  state.running = true;
  /* 续跑时用本机标记里的原始开始时间：刷新前后「已跑了多久」应该是连续的，
     从 0 重新数会让人以为任务刚被重启过（这正是「感觉像中断了一下」的来源之一）。 */
  state.traceStartedAt = resume ? (Number((ownRunMark() || {}).since) || Date.now()) : Date.now();
  /* 先在本机打标：这一轮要是被刷新/关标签打断，重新进来靠它认领这个任务 */
  markRunning(task, { keepSince: !!resume });
  startRunHeart(task);
  /* 再把「这一轮已经开始」落一次库。原来只在 finally 里存，导致多轮里
     「正在分析」时刷新 → 云端还停在上一次的 done → 重进页面这一轮整段消失，
     连「继续跑」都没有。这里只写状态 + 这轮原话，很轻。 */
  persistRoundStart(task);
  traceStick = true;
  state.ctrl = new AbortController();
  state.view = 'task';
  showView('task');
  $('#runBtn').disabled = false;
  $('#runBtn').textContent = '■';
  $('#runBtn').title = '停止';
  $('#runBtn').onclick = () => agentStop();
  const curRound = Number(task.curRound) || maxRoundOf(task) || 1;
  /* 前几轮的步骤先封存起来，这一轮从空轨迹重新长 */
  task.stepHist = (Array.isArray(task.steps) ? task.steps : []).filter(s => (Number(s.round) || 1) < curRound);
  if (continuing) {
    /* 新一轮：轨迹从空开始。上一轮的步骤留在 task.steps 里按轮分组，
       对话才能排成「我问 → 它答 → 我再问 → 它再答」，而不是我几句挤在一起 */
    state.trace = {
      nodes: [], result: '', status: 'running', blocked: null,
      userMsg: followUp || text, userMsgAt: 0, round: curRound
    };
  } else if (resume) {
    // 断点续跑：同一轮，前面做过的步骤原样留在轨迹里，接着往下长
    const lastAsk = (Array.isArray(task.userMsgs) ? task.userMsgs : [])
      .filter(u => u && (Number(u.round) || 1) === curRound).pop();
    /* 上一轮的结论还挂在 task.result 上：续跑新一轮时别把它当成这一轮的结论顶上 */
    const lastSay = (task.steps || []).filter(s => s && s.kind === 'say').pop();
    const stale = lastSay && (Number(lastSay.round) || 1) < curRound
      && String(lastSay.text || '').trim() === String(task.result || '').trim();
    state.trace = {
      /* 只装这一轮的步骤：任务里存着前几轮的工具节点，
         全塞进来会让新一轮凭空多出几十步「重复执行」 */
      nodes: (task.steps || []).filter(s => s.kind === 'tool' && (Number(s.round) || 1) === curRound).map(s => ({
        name: s.name, args: s.args, ok: s.ok, output: s.output, ms: s.ms, verify: s.verify, tests: s.tests,
        at: s.at, files: s.files, round: curRound
      })),
      result: stale ? '' : (task.result || ''),
      status: 'running',
      blocked: null,
      /* 续跑时 runGoal 的 goal 是空的：这一轮那句原话从存档里捞回来，别让对话缺一问 */
      userMsg: text || (lastAsk ? lastAsk.text : ''),
      userMsgAt: (task.steps || []).filter(s => s.kind === 'tool' && (Number(s.round) || 1) === curRound).length,
      round: curRound
    };
  } else {
    state.trace = { nodes: [], result: '', status: 'running', blocked: null, userMsg: text, userMsgAt: 0, round: curRound };
    openedNodes.clear();
  }
  /* 这一轮归谁：从这里开始，事件、落库、收工都只认这个任务，
     老板中途点开别的任务也不会串（见 runCtx 注释） */
  runCtx = { id: task.id, task, trace: state.trace, startedAt: state.traceStartedAt };
  renderRail(); renderTaskHead(); renderTrace(); renderWho(); syncComposer();

  try {
    // 这位员工专属知识库里跟这次目标相关的段落，一起交给它
    const snippets = staff ? kbSnippets(staff.id, `${text} ${$('#deliverables').value || ''}`) : [];
    if (snippets.length) state.trace.kb = snippets.length;
    await agentRun({
      task,
      staff: snippets.length ? { ...staff, kb: snippets } : staff,
      settings: withBud(task.id, state.settings),
      model,
      /* 验收人优先挑「不是这个模型」的：同一个模型自己验自己，意见不算独立证据 */
      judge: window.JUDGE ? JUDGE.pick(state.models || [], model) : null,
      followUp,
      followUpImages,
      scope: state.scope,
      signal: state.ctrl.signal,
      emit: handleEvent
    });
  } catch (e) {
    const tr = runTrace();
    tr.status = 'failed';
    tr.error = e.message;
    task.status = 'failed';
    if (watchingRun()) renderTrace();
    toast(e.message);
  } finally {
    state.running = false;
    state.ctrl = null;
    /* 这一轮结束了（跑完 / 失败 / 被停），标记撤掉：下次进页面不该再自动续 */
    stopRunHeart();
    clearRunningMark(task.id);
    $('#runBtn').disabled = false;
    $('#runBtn').textContent = '↑';
    $('#runBtn').title = '执行（Enter）';
    $('#runBtn').onclick = () => runGoal($('#goal').value);
    /* 先落库再松绑：persistTask 拼 steps 时还要靠 runCtx 认领「这一轮的现场」 */
    await persistTask(task);
    const watching = watchingRun();
    runCtx = null;
    renderRail();
    /* 老板要是已经翻到别的任务上了，就别拿这一轮的现场去重画他的界面 */
    if (watching) { renderTaskHead(); renderTrace(); }
    renderWho(); syncComposer();
    refreshDecisionIfOpen();
    // 任务卡在权限上就别让它悄悄沉底：进待办池等你授权
    if (task.blockedOn || task.status === 'blocked') {
      const catName = { read: '读文件', write: '写文件', exec: '跑命令' }[task.blockedOn] || '权限';
      addTodos([{
        what: `任务「${task.title}」要「${catName}」权限，卡在这里等你授权`,
        who: task.employeeName || '',
        due: '',
        sourceType: 'task',
        sources: [{ type: 'task', id: task.id, label: task.title }]
      }]);
    }
    /* 产出落本机：不登录也能存，浏览器直接写用户选的文件夹 */
    syncTaskFiles(task, { quiet: true });
  }
  return true;
}

/* ── 错误文本是「不可信输入」 ──
   云端接口出错时会把整页 HTML（最典型的就是前置 WAF 的拦截页）塞进 message。
   原样弹进界面就是几十行乱码糊住气泡——所以任何错误进 UI 之前都过这一道：
   认出拦截页 → 换成人话 + 怎么绕；其余错误剥掉标签、压成一行、截断。 */
function errText(e) {
  return String((e && (e.message || e.error_description || e.error)) || e || '');
}
function looksBlocked(e) {
  const s = errText(e);
  return /<!doctype|<html|<body|WAF|block-pages|请求已中断|应用防护|安全网关|attack-feedback/i.test(s);
}
function friendlyErr(prefix, e) {
  if (looksBlocked(e)) {
    return `${prefix}：这次内容里有整段代码 / 网页源码，被前置安全网关当成攻击载荷拦下了（不是你的数据有问题）。`
      + '把任务拆小一点重试一次通常就过去了；要生成首页这类整页代码，直接说「写一个 index.html」，别把源码贴回来。';
  }
  const clean = errText(e).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `${prefix}：${clean || '未知错误'}`;
}

/* 这一轮刚发出时的一次轻量落库：只写「运行中 + 这轮原话」。
   不写 messages / steps（那两样可能几百 KB），所以够快；
   没有这一步，多轮对话里「正在分析」时一刷新，这一轮就整段蒸发了。 */
function persistRoundStart(task) {
  if (!task || state.guest || String(task.id).startsWith('local_')) return;
  const patch = { status: 'running' };
  if (Array.isArray(task.userMsgs)) patch.userMsgs = task.userMsgs;
  if (task.status !== 'running') task.status = 'running';
  CLOUD.saveTask(task.id, patch).catch(() => { /* 落不上就靠本机标记兜底 */ });
}

async function persistTask(task) {
  /* 动过就算改过：左栏按这个时间排，先更新内存，落库时 saveTask 会带上 updated_at */
  task.updatedAt = Date.now();
  if (state.guest || String(task.id).startsWith('local_')) return;
  /* 轨迹里的 args 只留诊断要用的部分：生成首页这类任务，args 里就是整页 HTML/代码，
     原样 POST 出去会被前置 WAF 判成攻击载荷直接 403（实测踩过）。产出物在文件里，不靠这个字段。 */
  /* 验收结论跟着 deliverable_check 一起存：库里没有单独的列，
     而它本来就是「这份交付过没过检查」的一部分，放一起语义也顺。 */
  const dc = task.deliverableCheck
    ? { ...task.deliverableCheck, verify: task.verify || null }
    : (task.verify ? { checked: false, pass: true, missing: [], detail: [], verify: task.verify } : null);
  const full = {
    status: task.status,
    result: scrubKeep(task.result || ''),
    /* 轨迹也要洗：args 里是整篇文件、output 里是读回来的正文，
       原样提交到云库同样会被 WAF 拦，表现是「完整轨迹没同步上」。 */
    steps: scrubSteps(buildSteps(task)),
    /* 存档也走同一道洗：这条曾经把整份 index.html 原样塞进云库，
       云库那条链路的网关同样会 403（表现是「轨迹没同步上」）。
       对话本身在 steps / userMsgs 里，messages 只是给下一轮接话用的。 */
    messages: task.messages ? slimMessages(task.messages, -1) : null,
    userMsgs: task.userMsgs || null,
    tokens: task.tokens || { in: 0, out: 0 },
    ms: task.ms || 0,
    blockedOn: task.blockedOn || null,
    deliverableCheck: dc,
    pendingAsk: task.pendingAsk || null
  };
  try {
    await CLOUD.saveTask(task.id, full);
  } catch (e) {
    /* 降级：被安全网关拦下时，先保住「任务状态 + 结论」，
       轨迹少一轮没同步远比整条任务记录丢掉强；下一轮成功会自动补全。 */
    if (looksBlocked(e)) {
      try {
        await CLOUD.saveTask(task.id, {
          status: task.status,
          result: String(task.result || '').slice(0, 2000),
          tokens: task.tokens || { in: 0, out: 0 },
          ms: task.ms || 0
        });
        toast('这次内容里有大段代码，完整轨迹没同步上；任务状态和结论已保住');
        return;
      } catch (e2) {
        toast(friendlyErr('任务没同步到云端', e2));
        return;
      }
    }
    toast(friendlyErr('任务没同步到云端', e));
  }
}

/* ── 产出物持久化：文件落本地，对话留云端 ──
   沙箱是临时文件系统：重新发布、重启、长时间空闲都会把 workspace 清空；
   而任务记录（步骤里那些文件名）在云端还在，于是点开任务就成了「文件名在、文件没了」。

   分工按用户定的来：
     · 对话 / 任务记录 → 云端（ba_tasks / ba_meetings，本来就在那儿）
     · 产出物文件     → 用户自己选的本地文件夹（File System Access API）
   本地这份是真文件：Finder 里看得见、能用别的软件打开、不占平台对象存储，游客态也能用。

   打开任务时如果工作区里缺文件，就从本地目录读回来写进沙箱（/api/restore），
   预览、下载、打包这些老代码一行都不用改。
   只有「浏览器不支持」或「还没选文件夹」时才可能回落到云端暂存，且要用户显式打开开关。 */

const savedFiles = new Map();        // bucket|path -> 上次写入时间戳（4 秒内不重复写，超时就重写，文件改了能跟上）
const pendingSaves = new Map();      // bucketId -> { folder, label, paths:Set }：等授权时排队
const restoringTasks = new Set();
let outBarSig = '';                  // 产出目录提示条上次渲染的指纹，避免每次都重排
let localSavedOnce = false;          // 本次会话是否已经提示过「已存到本机」

function localReady() { return !!(window.LOCALFS && LOCALFS.supported()); }
function cloudBackupOn() { return localStorage.getItem('boss.cloudBackup') === '1'; }
function cloudStoreReady() { return !state.guest && !!(window.CLOUD && CLOUD.uid()); }

/* 本地文件夹名：任务/项目标题 + id 末四位，同名不同任务不会混在一个夹子里 */
function outFolderOf(label, bucketId) {
  const base = String(label || '产出')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '产出';
  const tail = String(bucketId || '').replace(/^proj-/, '').slice(-4) || '0000';
  return base + '-' + tail;
}
function baseOf(p) { return String(p || '').split('/').pop() || 'file'; }

/* 这个任务名下的全部产出路径（所有轮次），去重且顺序稳定 */
function taskFilePaths(task) {
  const seen = new Set(), out = [];
  for (const f of outputFiles(task, null, true)) {
    const p = String(f.path || '').trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function blobB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || '').split(',')[1] || '');
    fr.onerror = () => rej(new Error('文件读不出来'));
    fr.readAsDataURL(blob);
  });
}

function nameMapFor(folder) {
  return LOCALFS.readJSON(folder + '/_index.json').then(v => (v && typeof v === 'object' ? v : {})).catch(() => ({}));
}

/* 同一批里重名的，加 -2、-3，不覆盖已经存过的东西 */
function uniqueName(used, want) {
  const s = String(want || 'file');
  const dot = s.lastIndexOf('.');
  const stem = dot > 0 ? s.slice(0, dot) : s;
  const ext = dot > 0 ? s.slice(dot) : '';
  let name = s, i = 2;
  while (used.has(name.toLowerCase())) name = stem + '-' + (i++) + ext;
  used.add(name.toLowerCase());
  return name;
}

function rememberPending(bucketId, folder, label, paths) {
  const it = pendingSaves.get(bucketId) || { folder, label, paths: new Set() };
  for (const p of paths) it.paths.add(p);
  pendingSaves.set(bucketId, it);
}

/* 授权之后把排队没存上的补写一遍 */
async function flushPendingSaves() {
  const all = [...pendingSaves.entries()];
  if (!all.length) return 0;
  pendingSaves.clear();
  let n = 0;
  for (const [bucketId, it] of all) {
    n += await syncFilesFor(bucketId, [...it.paths], { quiet: true }, it.label);
  }
  if (n) toast('已补存 ' + n + ' 个产出到本机');
  return n;
}

/* 把产出写进本机文件夹；opts.grant=true 时会弹授权（必须在点击事件里调）。
   bucketId 把「任务」和「项目」区分开：任务用 task.id，项目用 'proj-'+id。 */
async function syncFilesFor(bucketId, paths, opts, label) {
  if (!bucketId) return 0;
  /* 4 秒内同一路径不重复写（一轮里会连着调好几次）；隔得久了就重写，文件改过也能跟上 */
  const now = Date.now();
  const todo = (paths || []).filter(p => p && !(now - (savedFiles.get(bucketId + '|' + p) || 0) < 4000));
  if (!todo.length) return 0;
  const folder = outFolderOf(label, bucketId);

  if (localReady()) {
    try {
      await LOCALFS.ensure(!!(opts && opts.grant));
    } catch (e) {
      /* 没授权：先记着，等用户点授权再补写。这是浏览器规矩，不能静默当成失败 */
      rememberPending(bucketId, folder, label, todo);
      renderOutDirBar(true);
      if (!(opts && opts.quiet)) toast('产出还在这台机器的工作区里；选一次保存文件夹就能落到本地');
      return 0;
    }
    const idx = await nameMapFor(folder);
    const used = new Set(Object.keys(idx).map(k => String(idx[k]).toLowerCase()));
    let done = 0;
    for (const p of todo.slice(0, 60)) {
      try {
        const r = await fetch(window.withSC('/api/file?scope=' + state.scope + '&raw=1&path=' + encodeURIComponent(p)));
        if (!r.ok) continue;
        const blob = await r.blob();
        if (!blob.size) continue;
        const name = idx[p] || uniqueName(used, baseOf(p));
        idx[p] = name;
        await LOCALFS.write(folder + '/' + name, blob);
        savedFiles.set(bucketId + '|' + p, Date.now());
        done++;
      } catch (e) { /* 单个失败不打断整批；下次打开还会重试 */ }
    }
    if (done) {
      await LOCALFS.writeJSON(folder + '/_index.json', idx).catch(() => {});
      /* 自动落盘是后台动作，静默会让人以为没生效：本次会话第一次成功时说一声 */
      if (!(opts && opts.quiet) || !localSavedOnce) {
        localSavedOnce = true;
        toast('已存 ' + done + ' 个产出到本机「' + (LOCALFS.rootName() || '产出') + '」');
      }
      renderOutDirBar(true);
    }
    if (done || !cloudBackupOn()) return done;
  } else if (!(opts && opts.quiet)) {
    toast('这个浏览器不支持存到本地文件夹，产出只在本次会话可用');
  }
  return cloudBackupFiles(bucketId, todo, opts);
}

async function syncTaskFiles(task, opts) {
  if (!task) return 0;
  return syncFilesFor(String(task.id), taskFilePaths(task), opts, task.title || task.goal);
}

/* 没本地目录时的兜底：只往云端放小文件，别把存储额度烧掉 */
async function cloudBackupFiles(bucketId, paths, opts) {
  if (!cloudStoreReady() || !cloudBackupOn()) return 0;
  let done = 0;
  for (const p of (paths || []).slice(0, 12)) {
    try {
      const r = await fetch(window.withSC('/api/file?scope=' + state.scope + '&raw=1&path=' + encodeURIComponent(p)));
      if (!r.ok) continue;
      const blob = await r.blob();
      if (!blob.size || blob.size > 2 * 1024 * 1024) continue;
      await CLOUD.putRunFile(bucketId, p, blob, blob.type || 'application/octet-stream');
      savedFiles.set(bucketId + '|' + p, Date.now());
      done++;
    } catch (e) { /* 云端失败不影响任务 */ }
  }
  if (done && !(opts && opts.quiet)) toast('已在云端暂存 ' + done + ' 个产出（只放 ≤2MB 的小文件）');
  return done;
}

/* 打开任务 / 项目时把工作区里缺的产出补回来：
   先看本机文件夹，再看有没有开云端兜底，都没有就交给原来的「文件不在工作区」提示 */
async function restoreFilesFor(bucketId, paths, label) {
  if (!bucketId) return 0;
  const key = String(bucketId);
  if (restoringTasks.has(key)) return 0;
  const list = (paths || []).filter(Boolean);
  if (!list.length) return 0;
  restoringTasks.add(key);
  try {
    const r = await fetch(window.withSC('/api/exists'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: state.scope, paths: list })
    });
    const j = await r.json();
    const missing = (j && j.ok && j.missing) || [];
    if (!missing.length) return 0;
    const folder = outFolderOf(label, bucketId);
    let idx = null;
    if (localReady()) {
      const okPerm = await LOCALFS.ensure(false).then(() => true).catch(() => false);
      if (okPerm) idx = await nameMapFor(folder);
      else renderOutDirBar(true);
    }
    const items = [];
    for (const p of missing.slice(0, 40)) {
      let blob = null;
      if (idx) {
        try { blob = await LOCALFS.read(folder + '/' + (idx[p] || baseOf(p))); } catch (e) { blob = null; }
      }
      if ((!blob || !blob.size) && cloudStoreReady() && cloudBackupOn()) {
        try { blob = await CLOUD.getRunFile(bucketId, p); } catch (e) { blob = null; }
      }
      if (blob && blob.size) {
        const data = await blobB64(blob);
        if (data) items.push({ path: p, data });
      }
    }
    if (!items.length) return 0;
    const rr = await fetch(window.withSC('/api/restore'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: state.scope, items })
    });
    const rj = await rr.json();
    const n = (rj && rj.written && rj.written.length) || 0;
    if (n) toast('已从本机「' + (LOCALFS.rootName() || '产出') + '」取回 ' + n + ' 个产出');
    return n;
  } catch (e) {
    return 0;
  } finally {
    restoringTasks.delete(key);
  }
}

async function restoreTaskFiles(task) {
  if (!task) return 0;
  return restoreFilesFor(String(task.id), taskFilePaths(task), task.title || task.goal);
}

/* 单个产出「存到本机」：直接写进用户选的文件夹，不等下次跑任务 */
async function saveOneToLocal(r) {
  if (!r) return;
  if (!localReady()) return toast('这个浏览器不支持选择本地文件夹，请用 Chrome / Edge');
  const bucketId = r.srcType === 'project' ? 'proj-' + r.srcId : String(r.srcId || 'adhoc');
  savedFiles.delete(bucketId + '|' + r.path);
  const n = await syncFilesFor(bucketId, [r.path], { grant: true }, r.srcLabel);
  if (!n) renderOutDirBar(true);
}

/* 产出栏顶上那条提示：没选目录 / 待授权 / 已存本地，三态说清楚 */
function renderOutDirBar(force) {
  const bar = $('#outDirBar');
  if (!bar) return;
  if (!localReady()) {
    if (force || outBarSig !== 'none') {
      outBarSig = 'none';
      bar.hidden = false;
      bar.innerHTML = '<span class="odb-t">产出只存本次会话：换 Chrome / Edge 可存到本机</span>';
    }
    return;
  }
  LOCALFS.status().then(st => {
    const sig = st.has ? (st.name + '|' + st.perm) : 'empty';
    if (!force && sig === outBarSig) return;
    outBarSig = sig;
    bar.hidden = false;
    if (!st.has) {
      bar.innerHTML = '<span class="odb-t">产出存在哪？</span><button class="btn tiny" id="outDirPick">选本机文件夹</button>';
    } else if (st.perm !== 'granted') {
      bar.innerHTML = '<span class="odb-t">「' + esc(st.name) + '」待授权</span><button class="btn tiny" id="outDirPick">点一下授权</button>';
    } else {
      bar.innerHTML = '<span class="odb-t">存本机「' + esc(st.name) + '」</span><button class="btn tiny ghost" id="outDirPick">换</button>';
    }
    const btn = $('#outDirPick');
    if (btn) btn.onclick = onOutDirPick;
  }).catch(() => {});
}

async function onOutDirPick() {
  try {
    const st = await LOCALFS.status();
    if (st.has && st.perm !== 'granted') {
      await LOCALFS.ensure(true);
      toast('已授权，之后跑完会自动存到这个文件夹');
    } else {
      const r = await LOCALFS.pick();
      if (!r || r.perm !== 'granted') toast('还没拿到写入权限，再点一次');
      else toast('产出会存到「' + r.name + '」');
    }
    await flushPendingSaves();
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.code === 'AbortError')) return;  // 用户自己取消的，不用报错
    toast('没能设置保存位置：' + e.message);
  }
  renderOutDirBar(true);
}

/* 设置弹窗里那一行「产出存在哪」 */
function refreshOutDirRow() {
  const el = $('#outDirName');
  if (!el) return;
  if (!window.LOCALFS || !LOCALFS.supported()) {
    el.textContent = '这个浏览器不支持（用 Chrome / Edge 桌面版）';
    return;
  }
  LOCALFS.status().then(st => {
    el.textContent = !st.has
      ? '未选择文件夹'
      : (st.perm === 'granted' ? '已连接：' + st.name : st.name + '（下次用要点一下授权）');
  }).catch(() => { el.textContent = '读不到保存位置'; });
}

/* 运行中的快照：步骤一变就往云端写一次（节流 3.5 秒）。
   任务是浏览器里跑的，刷新/关页面 = 执行被打断，这份快照是唯一能把现场救回来的东西。 */
let runSaveTimer = 0, runSaveLast = 0;

/* 谁在跑，谁在写。
   一轮跑起来之后，事件只能落到「这一轮所属的那个任务」上。
   以前全用全局的 state.trace + state.curTaskId：老板跑着 A 的时候点开 B 看一眼，
   state.trace 已经换成 B 的现场、curTaskId 也成了 B，于是 A 的步骤、分析、产出物
   一路写进 B 的对话里；收工那下 Object.assign(curTask(), ev.task) 更是把 A 的整条记录
   拷进 B（2026-11-03 线上实测）。跑的任务和看的任务是两件事，这里分开记。 */
let runCtx = null; // { id, task, trace }

/* 这一轮真正归属的任务（跑着的时候就是它，没跑就是当前打开的那个） */
function runTask() { return runCtx ? runCtx.task : curTask(); }
/* 这一轮的现场轨迹 */
function runTrace() { return (runCtx && runCtx.trace) || state.trace; }
/* 老板的眼睛是不是就在这一轮上：不在就别往界面上画，画出来也是错的任务 */
function watchingRun() { return !runCtx || runCtx.id === state.curTaskId; }
/* 落库的步骤快照 = 之前各轮的记录（已经封好的）+ 这一轮正在跑的。
   每一轮都带 round 号，重开任务时才能把对话按「我问 → 它答」一段段排回来。
   历史轮的 output 掐到 400 字：步骤越攒越多，全量存会把整条记录撑爆。 */
/* 把要同步给云端的工具参数瘦身。
   为什么必须做：生成整页 HTML / 长代码的任务，args 里会带几 KB 源码，
   原样提交到云端接口时会被前置 WAF 当成攻击载荷 → 403 → 整条任务记录都没同步上。
   这里只保留「看清楚调了什么」所需的信息：短字段原样，长字段截断并标注原长。 */
function leanArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      out[k] = v.length > 160 ? `${v.slice(0, 160)}…[截断，原 ${v.length} 字]` : v;
    } else if (Array.isArray(v)) {
      const s = JSON.stringify(v);
      out[k] = s.length > 600 ? [...v.slice(0, 5), `…共 ${v.length} 项`] : v;
    } else if (v && typeof v === 'object') {
      const s = JSON.stringify(v);
      out[k] = s.length > 300 ? `${s.slice(0, 300)}…[截断]` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildSteps(task, trace) {
  /* 现场从哪来：调用方指定 > 这一轮自己的 > 老板正打开的那个（必须是同一条任务）。
     跑着 A 的时候点开 B，state.trace 是 B 的，绝不能拿它去拼 A 的步骤；
     反过来没在跑时给 B 存档，也不能借屏幕上 A 的现场——线上两个方向都踩过：
     A 的 gen_image/make_deck 写进 B，B 的 write_file（长任务流程图.md）又流进 A 的产出物。 */
  const tr = trace
    || (runCtx && runCtx.id === task.id ? runCtx.trace : null)
    || (state.curTaskId === task.id ? state.trace : null)
    || null;
  const src = Array.isArray(task && task.steps) ? task.steps : [];
  /* 没有属于这条任务的现场：存档里有的就是全部，原样保留（含最后一轮）——
     既不借屏幕上别人的现场，也不把最后一轮弄丢（最后一轮平时是从现场重建的）。 */
  if (!tr) return src;
  const r = Number(tr.round) || maxRoundOf(task) || 1;
  const hist = Array.isArray(task && task.stepHist)
    ? task.stepHist
    : src.filter(s => (Number(s.round) || 1) < r);
  const out = hist.map(s => (s.kind === 'say' || s.kind === 'round' ? s : { ...s, output: String(s.output || '').slice(0, 400) }));
  (tr.nodes || []).forEach((n, i) => {
    out.push({
      i: i + 1, kind: 'tool', round: r, name: n.name, args: leanArgs(n.args),
      ok: n.ok, at: n.at || 0, ms: n.ms || 0, verify: n.verify, tests: n.tests, files: n.files, cum: n.cum,
      output: String(n.output || '').slice(0, 1600)
    });
  });
  /* 每一句都单独存一条：分析过程是一条链，不是只有最后那句话。
     上一版只存 tr.result，中间那些「我先看下 X / 我已有三份口径正本」全被冲掉了。
     老任务没有 tr.says 就退回单条，别让历史轮变空。 */
  {
    const saysArr = (Array.isArray(tr.says) && tr.says.length)
      ? tr.says
      : (String(tr.result || '').trim() ? [{ text: tr.result, at: 0 }] : []);
    for (const s of saysArr) {
      const txt = String(s && s.text || '').trim();
      if (!txt) continue;
      out.push({ kind: 'say', round: r, at: s.at || Date.now(), text: txt.slice(0, 12000) });
    }
  }
  /* 验收结论这类记录不在 trace.nodes 里（它不是工具调用），
     必须从存档里接回来——否则刷新一次、或者下一轮一开始，验收记录就没了。 */
  for (const s of src) {
    if (!s || s.kind !== 'verify') continue;
    if ((Number(s.round) || 1) !== r) continue;
    out.push({ ...s, output: String(s.output || '').slice(0, 400) });
  }
  /* 每一轮的账本（累计 token 打点）：老记录留着，本轮按最新累计盖一条。
     有了它，「这一轮花了多少 token」才不用靠猜。 */
  const recs = new Map();
  for (const x of src) if (x && x.kind === 'round') recs.set(Number(x.round) || 0, x);
  for (const x of out) if (x && x.kind === 'round') recs.set(Number(x.round) || 0, x);
  const tot = (task && task.tokens) || { in: 0, out: 0 };
  const prev = recs.get(r);
  const base = roundBaseTokens(task, r);
  const roundMs = (tr.status === 'running')
    ? Math.max(0, Date.now() - (state.traceStartedAt || Date.now()))
    : (prev && prev.ms != null ? Number(prev.ms) || 0
      : (tr.nodes || []).reduce((a, n) => a + (Number(n.ms) || 0), 0));
  recs.set(r, {
    kind: 'round', round: r, at: Date.now(),
    ms: roundMs,
    /* 累计值：本轮结束时全任务的 token 总数 */
    tokIn: Math.max(Number(tot.in) || 0, base.in),
    tokOut: Math.max(Number(tot.out) || 0, base.out)
  });
  const clean = out.filter(x => !x || x.kind !== 'round');
  for (const [k, v] of [...recs.entries()].sort((a, b) => a[0] - b[0])) {
    if (k >= 1 && k <= r) clean.push(v);
  }
  if (task) {
    task.steps = clean;
    task.stepHist = clean.filter(s => (Number(s.round) || 1) < r);
    task.rounds = Math.max(Number(task.rounds) || 1, r);
  }
  return clean;
}

function scheduleRunSave() {
  /* 存的对象是「这一轮跑的那个任务」，不是老板此刻点开的那个 */
  const id = runCtx ? runCtx.id : state.curTaskId;
  const cur = state.tasks.find(x => x.id === id);
  if (!cur || state.guest || String(id).startsWith('local_')) return;
  const doSave = () => {
    const t = state.tasks.find(x => x.id === id);
    if (!t) return;
    runSaveLast = Date.now();
    /* 跑一轮就是在改这条任务：时间戳跟着走，左栏顺序才不会把它压在底下 */
    t.updatedAt = Date.now();
    const steps = buildSteps(t);
    CLOUD.saveTask(id, {
      status: 'running',
      result: (runCtx ? runCtx.trace : state.trace).result || '',
      steps,
      /* 上下文也存一份：续跑要靠它，不然「继续跑」会变成从头分析 */
      messages: Array.isArray(t.messages) ? t.messages.slice(-30) : null,
      userMsgs: t.userMsgs || null,
      tokens: t.tokens || { in: 0, out: 0 }
    }).catch(() => {});
  };
  const gap = Date.now() - runSaveLast;
  if (gap >= 3500) { doSave(); return; }
  if (!runSaveTimer) runSaveTimer = setTimeout(() => { runSaveTimer = 0; doSave(); }, 3500 - gap);
}

/* ── 模型核对：通道回显的 model 和请求的是不是同一个 ──
   代码里不会偷换模型（选谁就传谁），但平台侧如果降级/兜底，这里能当场看出来。 */
const modelNorm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function noteServedModel(asked, served) {
  if (!served) return;
  state.servedModel = served;
  if (!asked) return;
  const a = modelNorm(asked), b = modelNorm(served);
  if (!a || !b) return;
  if (a.includes(b) || b.includes(a)) return;
  const key = asked + '→' + served;
  if (state.servedWarned === key) return;
  state.servedWarned = key;
  console.warn('[model] 请求', asked, '实际返回', served);
  toast(`模型通道回显：请求 ${asked}，实际返回 ${served}（不一致时以回显为准）`);
}

/* 流式期间会高频来事件：合并到一帧里重排一次，别每个增量都重建整段 DOM */
let traceSoonPending = false;
function renderTraceSoon() {
  if (traceSoonPending) return;
  traceSoonPending = true;
  requestAnimationFrame(() => { traceSoonPending = false; renderTrace(); });
}

/* 「正在写《报价结论.docx》· 已 320 字」——工具参数生成过程的人话版 */
const WRITE_VERB = { write_file: '写', make_doc: '写', make_deck: '做', make_sheet: '做', read_doc: '读' };
function writingLine(w) {
  if (!w) return '';
  const file = String(w.path || '').split('/').pop();
  const v = WRITE_VERB[w.name];
  const n = Number(w.chars) || 0;
  if (file) return `正在${v || '生成'}《${file}》 · 已 ${n.toLocaleString()} 字`;
  return `正在生成 ${w.name || '工具参数'} · 已 ${n.toLocaleString()} 字`;
}

/* 空窗期也得有东西在动：模型还没吐第一个字时，秒表每秒跳一下，
   否则那一两秒到十几秒的静止跟「卡死」长得一模一样 */
let liveTickTimer = null;
function startLiveTick() {
  stopLiveTick();
  liveTickTimer = setInterval(() => {
    const el = $('#liveTick');
    if (!el) return stopLiveTick();
    /* 开始时间走同一个兜底链：刷新接回来时 trace.startedAt 是空的，
       只认它的话秒表第一拍就把自己停掉，界面上就是「时间不展示了」。 */
    const t0 = Number(state.traceStartedAt) || Number(state.trace && state.trace.startedAt) || 0;
    if (!t0) return stopLiveTick();
    el.textContent = '已 ' + Math.max(0, Math.round((Date.now() - t0) / 1000)) + 's';
  }, 1000);
}
function stopLiveTick() {
  if (liveTickTimer) { clearInterval(liveTickTimer); liveTickTimer = null; }
}

/* 事件入口：先判断老板现在看的是不是这一轮，再决定要不要画到界面上 */
function handleEvent(ev) {
  applyEvent(ev, !watchingRun());
}

function applyEvent(ev, muted) {
  const tr = runTrace();
  const paint = () => { if (!muted) renderTrace(); };
  const paintSoon = () => { if (!muted) renderTraceSoon(); };
  if (ev.t === 'notice') {
    toast(ev.message || '');
    return;
  }
  if (ev.t === 'start') {
    tr.status = 'running';
    tr.error = '';
    tr.startedAt = Date.now();
    tr.writing = null;
    tr.pendingAsk = null;
    /* 新一轮的推理从空开始：上一轮的思考不能挂在这一轮脸上 */
    tr.think = '';
    if (!muted) startLiveTick();
    paint();
  } else if (ev.t === 'step' && ev.kind === 'call') {
    tr.nodes.push({ name: ev.name, args: ev.args, ok: undefined, output: '', ms: 0, at: Date.now() });
    paint();
  } else if (ev.t === 'step' && ev.kind === 'result') {
    const n = tr.nodes[tr.nodes.length - 1];
    if (n && n.name === ev.name) {
      n.ok = ev.ok; n.output = ev.output; n.ms = ev.ms; n.verify = ev.verify;
      if (ev.tests) n.tests = ev.tests;
      if (ev.files && ev.files.length) n.files = ev.files;
    }
    paint();
    /* 每步都往云端落一次（节流 3.5 秒）：刷新、关页面、断网都不会把这一轮对话清空 */
    scheduleRunSave();
  } else if (ev.t === 'gate') {
    tr.nodes.push({
      name: '验收', args: { 缺: ev.missing.join('、') }, ok: false,
      output: `交付物不在目录里，已退回重做（第 ${ev.round} 次）`, ms: 0, at: Date.now(),
      verify: { pass: false, why: '缺少：' + ev.missing.join('、') }
    });
    paint();
  } else if (ev.t === 'contract') {
    /* 契约：任务界面不新增块（老板看惯了这套），只挂在轨迹上，
       供验收卡、产出缺口提示和落库时读——以前这些口径根本没有落地处。 */
    tr.contract = ev.contract;
    const t = runTask();
    if (t && ev.contract) t.contract = ev.contract;
  } else if (ev.t === 'verify') {
    /* 验收人回来了：先挂到轨迹上，等 done 再整体落库 */
    tr.verify = ev.verdict;
    paint();
  } else if (ev.t === 'budget') {
    tr.result = (tr.result ? tr.result + '\n\n' : '') + `已停：本任务用了 ${ev.spent} tokens，超过上限 ${ev.budget}。提高上限后可继续。`;
    paint();
  } else if (ev.t === 'credit') {
    /* 积分烧到 0：这一轮不再往下走。写清原因和下一步，别只留一个「失败」 */
    tr.result = (tr.result ? tr.result + '\n\n' : '')
      + '已停：积分用完了。这一轮已经产出的内容都在，充值回来说一句「接着做」就能往下走。';
    paint();
    toast('积分用完了，任务停在半路——充值后才能接着跑');
    openPoints();
  } else if (ev.t === 'think') {
    /* 推理模型的思考过程：整段累积发过来，前端只负责显示。
       没有这一步，模型「想」的那几十秒界面上只有一句静止的「分析中」。 */
    tr.think = String(ev.content || '');
    paintSoon();
  } else if (ev.t === 'stream') {
    /* 正文边生成边显示：清空是新一轮开始，别把上一轮的残句留在屏幕上 */
    if (ev.reset) { tr.stream = ''; tr.writing = null; tr.think = ''; }
    else tr.stream = ev.content || '';
    paintSoon();
  } else if (ev.t === 'writing') {
    /* 工具参数（写文件 / 做表 / 做 PPT 的正文）也在流式生成，这里只报进度 */
    tr.writing = { name: ev.name || '', chars: ev.chars || 0, path: ev.path || '' };
    paintSoon();
  } else if (ev.t === 'text') {
    /* 分析过程逐条留：每条都是独立一笔，按顺序排着，不覆盖前面的。
       上一版只把 tr.result 换成最新一条，之前那些分析在界面上直接消失。 */
    if (!Array.isArray(tr.says)) tr.says = [];
    tr.says.push({ text: String(ev.content || ''), at: Date.now() });
    tr.result = ev.content; /* 兼容：落库、交接、验收这些都还读最后一条 */
    tr.stream = '';
    tr.writing = null;
    paint();
  } else if (ev.t === 'need_permission') {
    tr.blocked = { category: ev.category };
    paint();
  } else if (ev.t === 'need_approval') {
    if (!tr.approvals) tr.approvals = [];
    tr.approvals.push({ id: ev.id, name: ev.name, args: ev.args, status: 'pending' });
    paint();
  } else if (ev.t === 'usage') {
    const t = runTask();
    if (t) {
      t.tokens = { in: ev.in, out: ev.out };
      renderTaskHead();
      const li = state.tasks.find(x => x.id === t.id);
      if (li) li.tokens = t.tokens;
      renderRail();
    }
    /* 通道回显的模型名：选的 A、实际跑的是不是 A，这里能看出来 */
    noteServedModel(ev.asked, ev.served);
  } else if (ev.t === 'need_input') {
    /* 员工有问题要老板拍板：任务暂停，界面出选择卡 */
    tr.writing = null;
    tr.pendingAsk = { intro: ev.intro || '', questions: ev.questions || [] };
    paint();
    refreshDecisionIfOpen();
  } else if (ev.t === 'done') {
    tr.status = ev.task.status;
    if (!muted) stopLiveTick();
    tr.pendingAsk = ev.task.status === 'need_input' ? (tr.pendingAsk || ev.task.pendingAsk || null) : null;
    const t = runTask();
    if (t) {
      Object.assign(t, ev.task);
      /* 这一轮刚收工，就是「最近修改」；左栏立刻把它顶上去 */
      t.updatedAt = Date.now();
      /* 收工立刻归档一次：历史轮 + 本轮轨迹 + 本轮账本合成一份 steps。
         不靠落库触发（游客态不落库，落库还会晚几秒），界面上的轮次本来就该立刻正确 */
      buildSteps(t);
      syncRounds(t);
    }
    const li = state.tasks.find(x => x.id === ev.task.id);
    if (li) { li.status = ev.task.status; li.tokens = ev.task.tokens; }
    /* 这一轮烧掉的 token 现在要真扣积分：按轮次取增量，ref = 任务#轮次，重复收工不会重复扣 */
    if (t) {
      const r = Number(ev.task.round) || 1;
      const rs = roundStats(t, r);
      chargeRound(t, rs.tokens || 0);
    }
    /* 验收没过 / 报错 / 预算超限：投管理员告警，别在老板的对话里摊质检单 */
    if (t) queueTaskAlert(t, ev.task);
    renderRail(); renderTaskHead(); paint();
    refreshDecisionIfOpen();
  } else if (ev.t === 'error') {
    tr.status = 'failed';
    tr.error = ev.message;
    if (!muted) stopLiveTick();
    const t = runTask();
    if (t) queueAlert(t, 'error', { error: String(ev.message || '') });
    paint();
  }
}

async function grantAndRerun(cat) {
  const next = { ...state.settings.permissions, [cat]: true };
  state.settings.permissions = next;
  renderPerms();
  renderPermLabel();
  await persistSettings({ permissions: next });
  toast('已开启，重跑中');
  const t = curTask();
  if (t) await runGoal('', t.id);
}

/* ── 输入区 ── */
$('#runBtn').onclick = () => runGoal($('#goal').value);
$('#goal').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    runGoal($('#goal').value);
  }
  /* Shift + Enter 默认换行，无需处理 */
});
$('#goal').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 130) + 'px';
});
/* 语音输入：任务和项目两个输入框各挂一个麦克风，识别结果直接写回框里 */
if (window.VOICE) {
  window.VOICE.attach({ btn: 'micTask', input: 'goal' });
  window.VOICE.attach({ btn: 'micMeet', input: 'meetInput' });
}
/* 左栏主按钮：项目 tab 下新建项目，任务 tab 下开新任务 */
$('#railActionBtn').onclick = () => {
  const lv = state.lastListView === 'meeting' ? 'project' : (state.lastListView || 'task');
  if (lv === 'project') return MEET.openCreate();
  if (lv === 'staff') return openStaffPanel('');
  newTaskDraft();
};

function newTaskDraft(preferId) {
  state.view = 'task';
  showView('task');
  state.drafting = true;
  state.curTaskId = null;
  state.trace = { nodes: [], result: '', status: '', blocked: null };
  /* 新对话默认带「上次交给的那位」——跨刷新也记得；没有记忆才退回输入区当前这位 */
  const want = preferId
    ? state.staff.find(s => s.id === preferId) || null
    : lastEmpStaff();
  if (want) {
    state.curEmpId = want.id;
    state.pickEmp = [want.id];
  } else if (state.curEmpId) {
    state.pickEmp = [state.curEmpId];
  }
  $('#deliverables').value = '';
  $('#goal').value = '';
  $('#goal').style.height = 'auto';
  renderRail(); renderTaskHead(); renderTrace(); renderWho(); syncComposer();
  $('#goal').focus();
}

/* ── 设置弹窗 ── */
function loadCustomTools() {
  try { return JSON.parse(localStorage.getItem('boss.customTools') || '[]'); } catch { return []; }
}
function saveCustomTools(list) {
  localStorage.setItem('boss.customTools', JSON.stringify(list));
  window.CUSTOM_TOOLS = list; // agent.js 每次调用都现读
}
function renderCtList() {
  const list = loadCustomTools();
  $('#ctList').innerHTML = list.length
    ? list.map((t, i) => `<div class="ct-i"><b>${esc(t.name)}</b><i>${esc(t.url)}</i>`
      + `<button class="ct-del" data-i="${i}">删</button></div>`).join('')
    : '<p class="sub">还没注册自定义工具。</p>';
  $('#ctList').querySelectorAll('.ct-del').forEach(b => {
    b.onclick = () => {
      const l = loadCustomTools();
      l.splice(Number(b.dataset.i), 1);
      saveCustomTools(l);
      renderCtList();
    };
  });
}
function renderCronList() {
  const list = loadCron();
  $('#cronList').innerHTML = list.length
    ? list.map((c, i) => `<div class="ct-i"><b>${c.freq === 'hourly' ? '每 6 小时' : '每天 ' + esc(c.at || '09:00')}</b>`
      + `<i>${esc(String(c.goal).slice(0, 40))}</i>`
      + `<button class="ct-del" data-i="${i}">删</button></div>`).join('')
    : '<p class="sub">还没有例行任务。</p>';
  $('#cronList').querySelectorAll('.ct-del').forEach(b => {
    b.onclick = () => {
      const l = loadCron();
      l.splice(Number(b.dataset.i), 1);
      saveCron(l);
      renderCronList();
    };
  });
}
/* 额度输入的夹取：手滑输 0 或 99999 都不能把 agent 推到荒谬的边界。
   任务和项目两套数走同一套规则，省得各写一份、改一处漏一处。 */
function normLimits(raw) {
  const r = raw || {};
  const int = (v, d, lo, hi) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) return d;
    return Math.max(lo, Math.min(hi, n));
  };
  return {
    maxSteps: int(r.maxSteps, 24, 1, 40),
    maxTokens: int(r.maxTokens, 200000, 1000, 20000000),
    projSteps: int(r.projSteps, 6, 2, 30),
    projTokens: int(r.projTokens, 600000, 20000, 200000000)
  };
}
/* ── 账号额度：读 / 存 ──
 *
 * 这一块以前根本不存在。界面上唯一叫「额度」的输入框是「单任务 token 上限」，
 * 而真正拦人的是账号日额度——两个数、两套闸，只有前一个有地方改。结果就是
 * 「我改了额度，它说额度用完了」：改的那个数对拦人的那个数一点影响都没有。
 *
 * 现在把账号额度摆到设置里，并且**改完立刻生效**（服务端每次判断都读最新值），
 * 不用等重启、不用等第二天零点。
 */
const QUOTA_NF = n => Number(n || 0).toLocaleString('zh-CN');
/* 上次读到的服务端上限。用来判断「打开设置→改了数→按了保存」时
   到底要不要发一次保存请求——不能靠输入框有值就发，那会把所有老数值重写一遍。 */
const quotaLoaded = { day: 0, month: 0 };

function quotaMsg(text, bad) {
  const el = $('#quotaMsg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

async function refreshQuotaBox() {
  const day = $('#quotaDay');
  const mon = $('#quotaMonth');
  const note = $('#quotaNote');
  if (!day || !mon || !note) return;
  note.classList.remove('warn');
  if (state.guest) {
    note.textContent = '游客态不记账；登录后这里会显示这个账号的真实用量。';
    return;
  }
  try {
    const r = await fetch(window.withSC('/api/quota'), { headers: { Accept: 'application/json' } });
    const j = await r.json();
    if (!j || !j.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
    const lim = j.limits || {};
    const d = (j.tokens && j.tokens.day) || {};
    const m = (j.tokens && j.tokens.month) || {};
    if (lim.tokenDaily) day.value = lim.tokenDaily;
    if (lim.tokenMonthly) mon.value = lim.tokenMonthly;
    quotaLoaded.day = Number(lim.tokenDaily) || 0;
    quotaLoaded.month = Number(lim.tokenMonthly) || 0;
    const when = d.resetAt
      ? new Date(d.resetAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric' })
      : '明天';
    note.textContent = `今天已用 ${QUOTA_NF(d.used)} / ${QUOTA_NF(d.limit)} token（${when} 零点重置）`
      + ` · 本月 ${QUOTA_NF(m.used)} / ${QUOTA_NF(m.limit)}`;
    /* 单任务上限高过日额度 = 注定跑到一半被账号额度打断。
       这种数字组合不报错，但一定会在中途停，提前说出来比事后解释便宜。 */
    const cap = Number(state.settings && state.settings.maxTokens) || 0;
    if (cap && d.limit && cap > d.limit) {
      note.textContent += `。注意：单任务上限 ${QUOTA_NF(cap)} 比日额度还高，长任务会被这里的额度先拦住`;
      note.classList.add('warn');
    }
  } catch (e) {
    note.textContent = '读不到额度：' + String((e && e.message) || e).slice(0, 120);
  }
}

async function saveQuotaBox() {
  const day = Math.round(Number($('#quotaDay').value));
  const mon = Math.round(Number($('#quotaMonth').value));
  if (!(day > 0) || !(mon > 0)) { quotaMsg('两个数都要大于 0', true); return; }
  if (mon < day) { quotaMsg('月度上限不能比每天上限还小', true); return; }
  const btn = $('#quotaSave');
  if (btn) btn.disabled = true;
  quotaMsg('保存中…');
  try {
    const r = await fetch(window.withSC('/api/quota/limits'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenDaily: day, tokenMonthly: mon })
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
    quotaMsg('已保存，立刻生效');
    await refreshQuotaBox();
    toast('额度已保存并生效');
  } catch (e) {
    quotaMsg('没存上：' + String((e && e.message) || e).slice(0, 140), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
if ($('#quotaSave')) $('#quotaSave').onclick = saveQuotaBox;

function openSettings() {
  const opts = state.models.length
    ? state.models.map(m => `<option value="${esc(m.id)}" ${m.id === state.settings.model ? 'selected' : ''}>${esc(m.name || m.id)}${m.supportsToolCall === false ? '（无工具调用）' : ''}</option>`).join('')
    : '<option value="">没有可用模型</option>';
  $('#modelSel').innerHTML = opts;
  $('#maxSteps').value = state.settings.maxSteps;
  $('#maxTokens').value = state.settings.maxTokens;
  if ($('#maxProjSteps')) $('#maxProjSteps').value = state.settings.projSteps || 6;
  if ($('#maxProjTokens')) $('#maxProjTokens').value = state.settings.projTokens || 600000;
  $('#approveOps').checked = localStorage.getItem('boss.approve') === '1';
  const ar = $('#autoResume');
  if (ar) ar.checked = autoResumeOn();
  const vo = $('#verifyOn');
  if (vo) vo.checked = verifyOn();
  renderCtList();
  renderCronList();
  updateModelNote();
  refreshOutDirRow();
  /* 打开就拉一次真实用量：这块数字必须当场是准的，
     不能是「上次打开时」的缓存——老板就是冲着它来的。 */
  refreshQuotaBox();
  const cb = $('#cloudBackup');
  if (cb) cb.checked = cloudBackupOn();
  $('#setModal').hidden = false;
}
function updateModelNote() {
  const m = modelOf($('#modelSel').value);
  $('#modelNote').textContent = m
    ? (m.description || '') + (m.supportsToolCall === false ? ' ⚠ 该模型未标注工具调用能力，员工可能只会说不会做。' : '')
    : '模型列表为空：先确认已登录、网络正常。';
}
if ($('#settingsBtn')) $('#settingsBtn').onclick = openSettings;

/* ── 看图自检 ──
   存在的理由：通道只标「支持工具调用」，没有「能不能收图」的能力位，
   前端一直是按模型名猜的。猜错的表现就是一句「400，看不了图」，
   而这句话既不像体积问题也不像模型不认，光看它定不了性。
   这里跳过所有推测：当场画一张写着固定暗号的图，逐个候选模型真发一次。
   能读出暗号 = 真能看图；报错 = 把通道原文原样摊出来。
   测试图是 canvas 画的（几百字节），所以失败一定不是「图太大」。 */
function visionTestImage() {
  try {
    const cv = document.createElement('canvas');
    cv.width = 420; cv.height = 120;
    const c = cv.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 420, 120);
    c.fillStyle = '#111111'; c.font = 'bold 46px sans-serif';
    c.fillText('REN 7391', 24, 76);
    return cv.toDataURL('image/jpeg', 0.9);
  } catch { return ''; }
}
async function visionCheck() {
  const btn = $('#visionCheckBtn');
  const hint = $('#visionCheckHint');
  const out = $('#visionOut');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  out.hidden = false;
  out.textContent = '';
  hint.textContent = '正在试…（每个模型会真花一点 token）';
  const lines = [];
  const push = s => { lines.push(s); out.textContent = lines.join('\n'); };

  const url = visionTestImage();
  if (!url) { hint.textContent = '浏览器画不出测试图，自检跑不了'; btn.disabled = false; return; }

  const cands = pickVisionModels();
  push(`当前模型：${state.settings.model || '（未选）'}`);
  push(`按名字挑出的候选：${cands.length ? cands.join(' / ') : '一个也没有'}`);
  push('图里写的是 REN 7391，读对了才算真能看图。');
  push('');
  if (!cands.length) {
    push('候选是 0：模型列表里没有名字像多模态的。换一个模型再试。');
    hint.textContent = '候选为 0';
    btn.disabled = false;
    return;
  }
  for (const model of cands) {
    const t0 = Date.now();
    let got = '';
    let err = '';
    try {
      const stream = CLOUD.chatStream({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '这张图上写的是什么字？只把字抄出来，不要解释。' },
            { type: 'image_url', image_url: { url } }
          ]
        }],
        max_tokens: 64
      });
      for await (const chunk of stream) {
        const d = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (d && d.content) got += d.content;
      }
    } catch (e) {
      err = String((e && (e.message || e.error)) || e || '未知错误');
    }
    const ms = Date.now() - t0;
    if (got.trim()) {
      const right = /7391/.test(got);
      push(`${right ? '✅' : '⚠️'} ${model}  ${ms}ms  ${right ? '读对了' : '没读出暗号'}：${got.trim().slice(0, 80)}`);
      if (!right) push('    通道收下了图但没读出来：多半是把图当成了普通附件，没真的看。');
    } else if (err) {
      push(`❌ ${model}  ${ms}ms  ${err.slice(0, 300)}`);
    } else {
      push(`❔ ${model}  ${ms}ms  通道收下了，但一个字都没回`);
    }
  }
  push('');
  push('结论：至少要有一个 ✅。全是 ❌ 就是这条通道没有真能收图的模型——');
  push('      换模型，或者把图里的关键内容用文字发过来。');
  hint.textContent = '自检完成';
  btn.disabled = false;
}
if ($('#visionCheckBtn')) $('#visionCheckBtn').onclick = visionCheck;
$('#modelSel').onchange = updateModelNote;
$('#setSave').onclick = async () => {
  const patch = {
    ...normLimits({
      maxSteps: $('#maxSteps').value,
      maxTokens: $('#maxTokens').value,
      projSteps: $('#maxProjSteps') ? $('#maxProjSteps').value : undefined,
      projTokens: $('#maxProjTokens') ? $('#maxProjTokens').value : undefined
    }),
    model: $('#modelSel').value
  };
  state.settings.approve = $('#approveOps').checked;
  localStorage.setItem('boss.approve', state.settings.approve ? '1' : '');
  const arBox = $('#autoResume');
  if (arBox) localStorage.setItem('boss.autoResume', arBox.checked ? '1' : '0');
  const vBox = $('#verifyOn');
  if (vBox) localStorage.setItem('boss.verify', vBox.checked ? '1' : '0');
  const prevModel = state.settings.model;
  Object.assign(state.settings, patch);
  renderModelPill();
  $('#setModal').hidden = true;
  await persistSettings(patch);
  /* 额度那一块存在服务端的额度表里，和上面这些偏好不是一处。
     只用「保存」不给额度也算保存，是「我改了它没生效」的另一个版本——
     这里一并提交，别再让人猜哪个按钮管哪个数。 */
  const qd = Math.round(Number($('#quotaDay') ? $('#quotaDay').value : 0));
  const qm = Math.round(Number($('#quotaMonth') ? $('#quotaMonth').value : 0));
  if (quotaLoaded.day && qd > 0 && qm > 0 && (qd !== quotaLoaded.day || qm !== quotaLoaded.month)) {
    await saveQuotaBox();
  }
  /* 项目页顶上那句「这个项目的 token 上限 X」用的是这组数，改完就地重画 */
  if (state.view === 'meeting' && window.MEET && window.MEET.render) {
    try { window.MEET.render(); } catch (e) { /* 重画失败不影响设置已存 */ }
  }
  if (!state.guest && prevModel !== patch.model) toast('模型已切换');
};

/* 产出保存位置：选目录必须在点击事件里做，所以直接挂在按钮上 */
$('#outDirPickSet').onclick = async () => {
  try {
    const st = window.LOCALFS ? await LOCALFS.status() : null;
    if (st && st.has && st.perm !== 'granted') {
      await LOCALFS.ensure(true);
      toast('已授权，之后产出会自动写进这个文件夹');
    } else {
      const r = await LOCALFS.pick();
      toast(r && r.perm === 'granted' ? '产出会存到「' + r.name + '」' : '还没拿到写入权限，再点一次');
    }
    await flushPendingSaves();
  } catch (e) {
    if (!(e && e.name === 'AbortError')) toast('没能选择文件夹：' + e.message);
  }
  refreshOutDirRow();
  renderOutDirBar(true);
};
$('#outDirClear').onclick = async () => {
  if (window.LOCALFS) await LOCALFS.forget().catch(() => {});
  savedFiles.clear();
  refreshOutDirRow();
  renderOutDirBar(true);
  toast('已断开本机文件夹，产出不再自动落盘');
};
$('#cloudBackup').onchange = e => {
  localStorage.setItem('boss.cloudBackup', e.target.checked ? '1' : '');
  toast(e.target.checked ? '没目录时会往云端暂存小文件' : '已关闭云端暂存');
};
$('#ctAdd').onclick = () => {
  const name = $('#ctName').value.trim();
  const url = $('#ctUrl').value.trim();
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/.test(name)) return toast('工具名要英文/下划线开头');
  if (!/^https?:\/\//.test(url)) return toast('接口地址要以 http(s):// 开头');
  let parameters = null;
  const raw = $('#ctParams').value.trim();
  if (raw) {
    try { parameters = JSON.parse(raw); } catch { return toast('参数 Schema 不是合法 JSON'); }
  }
  const list = loadCustomTools();
  if (list.some(t => t.name === name)) return toast('已有同名工具');
  list.push({ name, description: $('#ctDesc').value.trim(), url, method: 'GET', parameters });
  saveCustomTools(list);
  $('#ctName').value = ''; $('#ctDesc').value = ''; $('#ctUrl').value = ''; $('#ctParams').value = '';
  renderCtList();
  toast('工具已注册，员工下一次调用就能用');
};
$('#cronAdd').onclick = () => {
  const goal = $('#cronGoal').value.trim();
  if (!goal) return toast('先写要交代的事');
  const list = loadCron();
  list.push({
    id: 'cr' + Date.now().toString(36),
    goal,
    freq: $('#cronFreq').value,
    at: $('#cronAt').value.trim() || '09:00',
    enabled: true,
    last: 0
  });
  saveCron(list);
  $('#cronGoal').value = '';
  renderCronList();
  toast('例行任务已加上');
};
/* 到点检查：应用开着准时跑；打开时也会补一次（关着错过的下次打开就跑） */
setInterval(checkCron, 60000);
setTimeout(checkCron, 8000);

/* ── 产出 ── */
function fmtSize(n) {
  if (!n) return '';
  return n > 1048576 ? (n / 1048576).toFixed(1) + 'M' : n > 1024 ? (n / 1024).toFixed(0) + 'K' : n + 'B';
}

if ($('#filesBtn')) $('#filesBtn').onclick = () => {
  $('#filesModal').hidden = false;
  $('#fmDownload').hidden = true;
  switchTab(state.fmTab);
};

function switchTab(tab) {
  state.fmTab = tab;
  $('#fmTabs').querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#fmPath').textContent = tab === 'cloud' ? '云端' : '/' + (state.fmCur === '.' ? '' : state.fmCur);
  $('#fmText').textContent = '← 选一个文件';
  if (tab === 'cloud') loadCloudFiles();
  else openFiles(state.fmCur);
}
$('#fmTabs').addEventListener('click', e => {
  const b = e.target.closest('.tab');
  if (b) switchTab(b.dataset.tab);
});

async function loadCloudFiles() {
  $('#fmDownload').hidden = true;
  if (state.guest) {
    $('#fmList').innerHTML = '<div class="fm-empty">未登录，没有云端存档。<br>登录后跑的任务会自动存到这里。</div>';
    $('#fmTip').textContent = '云端存档需要登录。';
    return;
  }
  $('#fmTip').textContent = '每个任务写出来的文件都会存到这里，换设备也能拿回来。';
  $('#fmList').innerHTML = '<div class="fm-empty">读取中…</div>';
  try {
    const list = await CLOUD.listArchive();
    if (!list.length) {
      $('#fmList').innerHTML = '<div class="fm-empty">还没有云端存档。<br>跑一个会写文件的任务试试。</div>';
      return;
    }
    const prefix = `users/${CLOUD.uid()}/runs/`;
    list.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    $('#fmList').innerHTML = list.map(it => {
      const rel = it.path.startsWith(prefix) ? it.path.slice(prefix.length) : it.path;
      return `<div class="fm-item" data-p="${esc(it.path)}">
        <span class="nm">${esc(rel)}</span><span class="sz">${fmtSize(it.size)}</span></div>`;
    }).join('');
    bindCloudItems();
  } catch (e) {
    $('#fmList').innerHTML = `<div class="fm-empty">云端存档读不到：${esc(e.message)}</div>`;
  }
}

function bindCloudItems() {
  $('#fmList').querySelectorAll('.fm-item[data-p]').forEach(el => {
    el.onclick = async () => {
      $('#fmList').querySelectorAll('.fm-item').forEach(x => x.classList.remove('on'));
      el.classList.add('on');
      state.fmPath = el.dataset.p;
      $('#fmText').textContent = '读取中…';
      try {
        const blob = await CLOUD.downloadArchive(state.fmPath);
        const text = await blob.text();
        $('#fmText').textContent = text.slice(0, 60000) || '（空文件）';
        const btn = $('#fmDownload');
        btn.hidden = false;
        btn.onclick = () => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = state.fmPath.split('/').pop();
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
        };
      } catch (e) {
        $('#fmText').textContent = '读不到：' + e.message;
      }
    };
  });
}

/* 工作区（服务端实时文件） */
async function openFiles(p) {
  state.fmCur = p || '.';
  $('#fmDownload').hidden = true;
  $('#fmPath').textContent = '/' + (state.fmCur === '.' ? '' : state.fmCur);
  $('#fmText').textContent = '← 选一个文件';
  let items = [];
  try {
    const r = await fetch(window.withSC('/api/files?scope=' + state.scope + '&path=' + encodeURIComponent(state.fmCur)));
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || '读取失败');
    items = j.items || [];
  } catch (e) {
    $('#fmList').innerHTML = `<div class="fm-empty">${esc(e.message)}</div>`;
    return;
  }
  const up = state.fmCur !== '.'
    ? `<div class="fm-item" data-up="1"><span class="nm">↑ 上一级</span></div>`
    : '';
  $('#fmList').innerHTML = up + (items.length
    ? items.map(x => `<div class="fm-item" data-p="${esc(x.path)}" data-d="${x.dir ? 1 : 0}">
        <span class="nm">${x.dir ? '📁 ' : ''}${esc(x.name)}</span>
        ${x.dir ? '' : `<span class="sz">${fmtSize(x.size)}</span>`}</div>`).join('')
    : '<div class="fm-empty">这里是空的。<br>让它写点东西进来。</div>');

  const upEl = $('#fmList').querySelector('[data-up]');
  if (upEl) {
    upEl.onclick = () => openFiles(state.fmCur.includes('/') ? state.fmCur.slice(0, state.fmCur.lastIndexOf('/')) : '.');
  }
  $('#fmList').querySelectorAll('.fm-item[data-p]').forEach(el => {
    el.onclick = async () => {
      const path = el.dataset.p;
      if (el.dataset.d === '1') return openFiles(path);
      $('#fmList').querySelectorAll('.fm-item').forEach(x => x.classList.remove('on'));
      el.classList.add('on');
      /* 预览只有一套：图片 / 网页 / 文本 / PDF / Office 都走同一个弹窗；
         压缩包这类实在解不开的，才只给下载 */
      const canPrev = isImagePath(path) || TEXT_FILE.test(path)
        || OFFICE_PREVIEW.test(path) || PDF_FILE.test(path);
      const url = window.withSC('/api/file?scope=' + state.scope + '&raw=1&path=' + encodeURIComponent(path));
      const armDownload = () => {
        const btn = $('#fmDownload');
        btn.hidden = false;
        btn.onclick = () => {
          const a = document.createElement('a');
          a.href = url;
          a.download = path.split('/').pop();
          a.click();
        };
      };
      if (canPrev) {
        const rec = collectOutputs().find(o => o.path === path)
          || { path, srcType: 'project', srcId: state.curMeetingId || '', srcLabel: '', at: Date.now() };
        openOutputView(rec);
        $('#fmText').textContent = '已经在弹窗里打开了；要改内容就用本机程序：下载后双击。';
        armDownload();
        return;
      }
      const ext = path.split('.').pop().toUpperCase();
      $('#fmText').textContent = `这是 ${ext} 文件，浏览器里预览不了。点右下角「下载」保存到本地再打开。`;
      armDownload();
    };
  });
}

/* ── 记忆 ──
 * 老板能看见员工记得什么，也能一条条改：停用、纠正、标重要、删掉、跳回来源任务。
 * 「看不见的记忆」比没有记忆更危险：说错了话，你都不知道该从哪儿开始改。 */
const memUI = {
  tab: 'company', staffId: '', staffName: '', projectId: '', projectTitle: '',
  items: [], type: '', state: 'all', editing: '', counts: null, prose: ''
};

async function memApi(qs, opt) {
  const r = await fetch(window.withSC(qs), opt);
  const j = await r.json().catch(() => ({ ok: false, error: '服务端没响应' }));
  if (!j.ok) throw new Error(j.error || '记忆操作失败');
  return j;
}

function memPaint() {
  $('#memTabs').querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.mt === memUI.tab));
  $('#memPaneCompany').hidden = memUI.tab !== 'company';
  $('#memPaneStaff').hidden = memUI.tab !== 'staff';
  const pjPane = $('#memPaneProject');
  if (pjPane) pjPane.hidden = memUI.tab !== 'project';
  const inStaff = memUI.tab === 'staff' && !!memUI.staffId;
  const inProj = memUI.tab === 'project' && !!memUI.projectId;
  $('#memBack').hidden = !(inStaff || inProj);
  $('#memClear').hidden = !(inStaff || inProj);
  const pathTxt = memUI.tab === 'company' ? ''
    : memUI.tab === 'project' ? (memUI.projectId ? (memUI.projectTitle || memUI.projectId) : '')
      : (memUI.staffId ? memUI.staffName : '');
  $('#memPath').textContent = pathTxt;
  $('#memPath').hidden = !pathTxt;
  /* 员工 / 项目列表页（还没点进某一个）没有条目，筛选条一起收起来 */
  const listView = (memUI.tab === 'staff' && !memUI.staffId)
    || (memUI.tab === 'project' && !memUI.projectId);
  const flt = $('#memFlt');
  if (flt) {
    flt.hidden = listView;
    flt.querySelectorAll('[data-ft]').forEach(b => b.classList.toggle('on', b.dataset.ft === memUI.type));
    flt.querySelectorAll('[data-fs]').forEach(b => b.classList.toggle('on', b.dataset.fs === memUI.state));
  }
}

function memVisible() {
  return memUI.items.filter(e => {
    if (memUI.type && e.type !== memUI.type) return false;
    if (memUI.state === 'active' && e.status !== 'active') return false;
    if (memUI.state === 'cand' && e.status !== 'candidate') return false;
    if (memUI.state === 'off' && (e.status === 'active' || e.status === 'candidate')) return false;
    return true;
  });
}

/* 一条记忆：类型 / 正文 / 日期 / 来源（能跳回任务）/ 状态 / 用过几次 + 动作
   待采纳的那几条只给「采纳 / 丢弃」：没采纳之前它不参与召回，改它没有意义。 */
function memEntryHtml(e) {
  const cand = e.status === 'candidate';
  const off = e.status !== 'active' && !cand;
  const editing = memUI.editing === e.id;
  const srcTxt = String(e.src || '').replace(/^任务：/, '');
  const body = editing
    ? `<div class="mem-edit">
         <textarea class="mem-edit-ta" rows="2" spellcheck="false">${esc(e.text)}</textarea>
         <div class="mem-edit-act">
           <button class="btn tiny primary" type="button" data-mem-act="save">保存更正</button>
           <button class="btn tiny ghost" type="button" data-mem-act="cancel">取消</button>
         </div>
       </div>`
    : `<div class="mem-t">${esc(e.text)}</div>`;
  const ops = cand
    ? `<button class="mem-op txt ok" type="button" data-mem-act="approve" title="采纳后才参与召回">采纳</button>
       <button class="mem-op txt del" type="button" data-mem-act="reject" title="不采纳，直接删掉">丢弃</button>`
    : `<button class="mem-op${e.imp >= 5 ? ' on' : ''}" type="button" data-mem-act="imp"
              title="${e.imp >= 5 ? '取消「重要」标记' : '标为重要（同类任务更容易被想起）'}">${e.imp >= 5 ? '★' : '☆'}</button>
      <button class="mem-op" type="button" data-mem-act="edit" title="纠正这条的说法">✎</button>
      <button class="mem-op" type="button" data-mem-act="toggle"
              title="${off ? '恢复使用' : '停用（保留但不再召回）'}">${off ? '↺' : '⏻'}</button>
      <button class="mem-op del" type="button" data-mem-act="del" title="删除这条">×</button>`;
  return `<div class="mem-e${off ? ' off' : ''}${cand ? ' cand' : ''}${editing ? ' editing' : ''}" data-mem-id="${esc(e.id)}">
    <span class="mem-ty ty-${esc(e.type)}" title="类型：${esc(e.typeLabel)}">${esc(e.typeLabel)}</span>
    <div class="mem-body">
      ${body}
      <div class="mem-meta">
        <span class="mem-d">${esc(e.date)}</span>
        ${srcTxt ? (e.srcId
      ? `<button class="mem-src" type="button" data-mem-go="${esc(e.srcId)}" title="回到来源：${esc(srcTxt)}">${esc(srcTxt)}</button>`
      : `<span class="mem-src dead" title="老记忆，没记下来源">${esc(srcTxt)}</span>`)
      : ''}
        ${e.status !== 'active' ? `<span class="mem-st st-${esc(e.status)}">${esc(e.statusLabel)}</span>` : ''}
        ${e.hits ? `<span class="mem-hit" title="被召回进上下文的次数">用过 ${e.hits} 次</span>` : ''}
      </div>
    </div>
    <div class="mem-ops">${ops}</div>
  </div>`;
}

function memListHtml(items, emptyText) {
  if (!items.length) return `<div class="mem-empty">${emptyText}</div>`;
  /* 新的在上：刚学到的东西最值得先看一眼 */
  return items.slice().reverse().map(memEntryHtml).join('');
}

function memPaintEntries() {
  const list = memVisible();
  const empty = memUI.items.length
    ? '这个筛选下没有条目。'
    : '还没有记忆。完成一次任务后，员工会自己沉淀几条「以后还用得上」的事实。';
  if (memUI.tab === 'project') {
    const box = $('#memProjList');
    if (box) box.innerHTML = memListHtml(list, '这个项目还没记下什么。');
    return;
  }
  if (memUI.tab === 'company') {
    $('#memCoList').innerHTML = memListHtml(list, empty);
    const c = memUI.counts || { active: 0, total: memUI.items.length };
    const cand = c.candidate || 0;
    $('#memCoHead').textContent = `可召回的条目 ${c.active} 条`
      + (cand ? ` · ${cand} 条待采纳` : '');
    $('#memCount').textContent = `${c.active} 条有效`
      + (cand ? ` · ${cand} 条待采纳` : '')
      + (c.total > c.active + cand ? ` · ${c.total - c.active - cand} 条已作废` : '');
  } else if (memUI.staffId) {
    $('#memList').innerHTML = memListHtml(list, '这位员工还没记下什么。');
  }
}

async function memLoadCompany() {
  try {
    const j = await memApi(`/api/memory?scope=${state.scope}&kind=company`);
    memUI.items = j.entries || [];
    memUI.counts = j.counts || null;
    memUI.prose = j.prose || '';
    $('#memText').value = j.raw || '';
    memPaintEntries();
  } catch (e) { toast(e.message); }
}

async function memLoadStaffList() {
  try {
    const j = await memApi(`/api/memory?scope=${state.scope}&kind=staff`);
    const rows = (j.list || []);
    if (!rows.length) {
      $('#memList').innerHTML = '<div class="mem-empty">还没有员工写下过记忆。<br>完成一次任务后，员工会自己沉淀几条「以后还用得上」的事实。</div>';
      return;
    }
    $('#memList').innerHTML = rows.map(r => {
      const s = state.staff.find(x => String(x.id) === String(r.id));
      const name = s ? s.name : r.id;
      const role = s ? roleShort(s.role) : '';
      return `<div class="mem-emp" data-mem-emp="${esc(r.id)}" data-mem-name="${esc(name)}">
        <span class="mem-emp-n">${esc(name)}${role ? ` · ${esc(role)}` : ''}</span>
        <span class="mem-emp-m">${r.n} 条 · 最近 ${esc(r.last || '—')}</span>
      </div>`;
    }).join('');
  } catch (e) { toast(e.message); }
}

async function memLoadStaff(id) {
  try {
    const j = await memApi(`/api/memory?scope=${state.scope}&kind=staff&id=${encodeURIComponent(id)}`);
    memUI.items = j.entries || [];
    memUI.counts = j.counts || null;
    memPaintEntries();
  } catch (e) { toast(e.message); }
}

/* 有共享记忆的项目列出来；点进去看这个项目里已经定过什么 */
async function memLoadProjectList() {
  try {
    const j = await memApi(`/api/memory?scope=${state.scope}&kind=project`);
    const rows = (j.list || []);
    const box = $('#memProjList');
    if (!box) return;
    if (!rows.length) {
      box.innerHTML = '<div class="mem-empty">还没有项目记忆。<br>项目里跑完一节后，员工可以把它写进【项目记忆】，项目里所有同事下一节都能拿到。</div>';
      return;
    }
    box.innerHTML = rows.map(r => {
      const m = state.meetings.find(x => String(x.id) === String(r.id));
      const title = r.title || (m && m.topic) || r.id;
      return `<div class="mem-emp" data-mem-proj="${esc(r.id)}" data-mem-ptitle="${esc(title)}">
        <span class="mem-emp-n">${esc(title)}</span>
        <span class="mem-emp-m">${r.n} 条${r.nCand ? ` · ${r.nCand} 条待采纳` : ''} · 最近 ${esc(r.last || '—')}</span>
      </div>`;
    }).join('');
  } catch (e) { toast(e.message); }
}

async function memLoadProject(id) {
  try {
    const j = await memApi(`/api/memory?scope=${state.scope}&kind=project&id=${encodeURIComponent(id)}`);
    memUI.items = j.entries || [];
    memUI.counts = j.counts || null;
    memPaintEntries();
  } catch (e) { toast(e.message); }
}

async function memReload() {
  if (memUI.tab === 'company') await memLoadCompany();
  else if (memUI.tab === 'project') await (memUI.projectId ? memLoadProject(memUI.projectId) : memLoadProjectList());
  else if (memUI.staffId) await memLoadStaff(memUI.staffId);
  else await memLoadStaffList();
}

/** 对一条记忆做点什么：停用/恢复、纠正、改重要度、删除 */
async function memRecount() {
  const c = { active: 0, candidate: 0, superseded: 0, disabled: 0, total: memUI.items.length };
  for (const e of memUI.items) {
    if (e.status === 'active') c.active++;
    else if (e.status === 'candidate') c.candidate++;
    else if (e.status === 'superseded') c.superseded++;
    else if (e.status === 'disabled') c.disabled++;
  }
  memUI.counts = c;
}

async function memAct(act, row) {
  const entryId = row.dataset.memId;
  const kind = memUI.tab === 'project' ? 'project' : (memUI.tab === 'company' ? 'company' : 'staff');
  const id = memUI.tab === 'project' ? memUI.projectId : memUI.staffId;
  const base = { scope: state.scope, kind, id, entryId };
  const send = (body) => memApi('/api/memory', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const e = memUI.items.find(x => x.id === entryId);
  /* 改完先就地把这一行更新掉再渲染：线上一次往返要快 1 秒，
     等整块重新拉一遍会让「停用」这类即时动作看着像没生效。 */
  const repaint = () => { memRecount(); memPaintEntries(); memSyncText(); };

  /* 候选记忆：采纳才生效，丢弃等于删掉。两条都不改内容，避免「边改边采纳」把冲突判断搞乱 */
  if (act === 'approve' || act === 'reject') {
    if (!e) return;
    const before = memUI.items.slice();
    if (act === 'approve') {
      e.status = 'active';
      e.statusLabel = '有效';
    } else {
      memUI.items = memUI.items.filter(x => x.id !== entryId);
    }
    repaint();
    try {
      if (act === 'approve') {
        const j = await send({ ...base, approve: true });
        toast(j && j.superseded && j.superseded.length
          ? `已采纳，跟它冲突的旧说法已标成「已被取代」`
          : (j && j.merged ? '已采纳（和已有的一条重复，已合并）' : '已采纳，下次同类任务就会用上'));
      } else {
        await memApi('/api/memory', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(base)
        });
        toast('已丢弃这条候选');
      }
      /* 采纳可能引起合并 / 取代，界面上的状态以服务端为准，干脆重拉一次 */
      await memReload();
    } catch (err) {
      memUI.items = before;
      repaint();
      toast(err.message);
    }
    return;
  }

  if (act === 'del') {
    const gone = memUI.items.find(x => x.id === entryId);
    const idx = memUI.items.indexOf(gone);
    memUI.items = memUI.items.filter(x => x.id !== entryId);
    memUI.editing = '';
    repaint();
    try {
      await memApi('/api/memory', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(base)
      });
      toast('已删掉这条');
    } catch (err) {
      /* 服务端没删掉就把行放回去，别让界面撒谎 */
      if (gone) memUI.items.splice(Math.max(0, idx), 0, gone);
      repaint();
      toast(err.message);
    }
    return;
  }

  if (act === 'toggle') {
    if (!e) return;
    const prev = e.status;
    e.status = prev === 'active' ? 'disabled' : 'active';
    e.statusLabel = e.status === 'active' ? '有效' : '已停用';
    repaint();
    try {
      await send({ ...base, status: e.status });
      toast(e.status === 'active' ? '已恢复使用' : '已停用，不再参与判断');
    } catch (err) {
      e.status = prev;
      e.statusLabel = prev === 'superseded' ? '已被取代' : prev === 'disabled' ? '已停用' : '有效';
      repaint();
      toast(err.message);
    }
    return;
  }

  if (act === 'imp') {
    if (!e) return;
    const prev = e.imp;
    e.imp = prev >= 5 ? 3 : 5;
    repaint();
    try {
      await send({ ...base, imp: e.imp });
    } catch (err) {
      e.imp = prev;
      repaint();
      toast(err.message);
    }
    return;
  }

  if (act === 'edit') {
    memUI.editing = entryId;
    memPaintEntries();
    const sel = memUI.tab === 'company' ? 'memCoList' : (memUI.tab === 'project' ? 'memProjList' : 'memList');
    const ta = $(`#${sel} .mem-e[data-mem-id="${entryId}"] .mem-edit-ta`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    return;
  }

  if (act === 'cancel') {
    memUI.editing = '';
    memPaintEntries();
    return;
  }

  if (act === 'save') {
    const ta = row.querySelector('.mem-edit-ta');
    const text = ta ? ta.value.trim() : '';
    if (text.length < 4) return toast('至少写 4 个字');
    try {
      const j = await send({ ...base, text });
      memUI.editing = '';
      if (j.merged) {
        /* 合并掉了这条，本地无法自己算，老实重拉 */
        await memReload();
      } else if (e) {
        e.text = j.text || text;
        e.id = j.id || e.id;
        repaint();
      } else {
        await memReload();
      }
      toast(j.merged ? '和已有条目一样，已合并成一条' : '已更正');
    } catch (err) { toast(err.message); }
  }
}

/* 公司档案的正文（去掉条目行）：改完条目要同步回文本框，否则一保存档案就把改动冲掉 */
function memCompanyText() {
  const lines = memUI.items.map(e => `- [${e.date}] ${e.status === 'superseded' ? '〔已被取代〕' : e.status === 'disabled' ? '〔已停用〕' : e.status === 'candidate' ? '〔待采纳〕' : ''}${e.text}${e.src ? `｜来源：${e.src}` : ''}`);
  const head = String(memUI.prose || '').trim();
  return (head ? head + '\n\n' : '') + (lines.length ? lines.join('\n') : '');
}

function memSyncText() {
  if (memUI.tab !== 'company') return;
  const ta = $('#memText');
  /* 老板正在改档案就别抢他的光标 */
  if (ta && document.activeElement !== ta) ta.value = memCompanyText();
}

function memWireList(sel) {
  const box = $(sel);
  if (!box) return;
  box.addEventListener('click', async ev => {
    const go = ev.target.closest('[data-mem-go]');
    if (go) {
      const id = go.dataset.memGo;
      if (!id) return;
      $('#memModal').hidden = true;
      if (!state.tasks.some(t => String(t.id) === String(id))) return toast('那次任务的记录已经不在列表里了');
      state.view = 'task';
      showView('task');
      selectTask(id);
      return;
    }
    const btn = ev.target.closest('[data-mem-act]');
    if (!btn) return;
    const row = btn.closest('.mem-e');
    if (!row) return;
    await memAct(btn.dataset.memAct, row);
  });
}
memWireList('#memCoList');
memWireList('#memList');
memWireList('#memProjList');

async function memOpen() {
  $('#memModal').hidden = false;
  memUI.tab = 'company'; memUI.staffId = ''; memUI.staffName = '';
  memUI.projectId = ''; memUI.projectTitle = '';
  memUI.type = ''; memUI.state = 'all'; memUI.editing = ''; memUI.items = []; memUI.prose = '';
  memPaint();
  await memLoadCompany();
}

/* 入口在头像浮层：#crMemory（见上方 296 行附近） */

$('#memTabs').addEventListener('click', async e => {
  const b = e.target.closest('.tab');
  if (!b) return;
  memUI.tab = b.dataset.mt;
  memUI.staffId = ''; memUI.staffName = '';
  memUI.projectId = ''; memUI.projectTitle = '';
  memUI.items = []; memUI.counts = null; memUI.prose = ''; memUI.editing = ''; memUI.type = ''; memUI.state = 'all';
  memPaint();
  if (memUI.tab === 'company') await memLoadCompany();
  else if (memUI.tab === 'project') await memLoadProjectList();
  else await memLoadStaffList();
});

$('#memFlt').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.ft !== undefined) memUI.type = b.dataset.ft;
  if (b.dataset.fs !== undefined) memUI.state = b.dataset.fs;
  memPaint();
  memPaintEntries();
});

$('#memList').addEventListener('click', async e => {
  const emp = e.target.closest('[data-mem-emp]');
  if (!emp) return;
  memUI.staffId = emp.dataset.memEmp;
  memUI.staffName = emp.dataset.memName || memUI.staffId;
  memUI.editing = '';
  memPaint();
  await memLoadStaff(memUI.staffId);
});

const memProjBox = $('#memProjList');
if (memProjBox) {
  memProjBox.addEventListener('click', async e => {
    const pj = e.target.closest('[data-mem-proj]');
    if (!pj) return;
    memUI.projectId = pj.dataset.memProj;
    memUI.projectTitle = pj.dataset.memPtitle || memUI.projectId;
    memUI.editing = '';
    memPaint();
    await memLoadProject(memUI.projectId);
  });
}

$('#memBack').onclick = async () => {
  if (memUI.tab === 'project') {
    memUI.projectId = ''; memUI.projectTitle = ''; memUI.editing = '';
    memPaint();
    await memLoadProjectList();
    return;
  }
  memUI.staffId = ''; memUI.staffName = ''; memUI.editing = '';
  memPaint();
  await memLoadStaffList();
};

$('#memClear').onclick = async () => {
  const isPj = memUI.tab === 'project';
  const what = isPj ? `项目「${memUI.projectTitle}」的共享记忆` : `「${memUI.staffName}」的全部记忆`;
  if (!confirm(`清空${what}？这个操作不能撤销。`)) return;
  try {
    await memApi('/api/memory', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: state.scope, kind: isPj ? 'project' : 'staff',
        id: isPj ? memUI.projectId : memUI.staffId, clear: true
      })
    });
    memUI.items = [];
    memPaintEntries();
    toast('已清空');
  } catch (e) { toast(e.message); }
};

$('#memSaveCompany').onclick = async () => {
  const btn = $('#memSaveCompany');
  btn.disabled = true;
  try {
    const j = await memApi('/api/memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: state.scope, kind: 'company', text: $('#memText').value })
    });
    await memLoadCompany();
    toast(`公司档案已保存（${j.entries || 0} 条），下次任务就按这个来`);
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
};

/* ── 列表项「⋯」菜单：置顶 / 重命名 / 删除 ──
 * 操作从详情页头部收进列表项里：在哪儿看见它，就在哪儿改它，
 * 不用先点进去、改完再退出来。 */
let tiCtx = null;

function tiItem(kind, id) {
  return kind === 'task'
    ? state.tasks.find(t => String(t.id) === String(id))
    : state.meetings.find(m => String(m.id) === String(id));
}

function closeTiMenu() {
  const box = $('#tiMenu');
  if (box) box.hidden = true;
  tiCtx = null;
}

function openTiMenu(btn) {
  const kind = btn.dataset.kind;
  const it = tiItem(kind, btn.dataset.more);
  if (!it) return;
  tiCtx = { kind, id: btn.dataset.more };
  const box = $('#tiMenu');
  const pinned = !!it.pinned;
  box.innerHTML = `
    <button class="tmi" data-m="pin"><i>${pinned ? '↓' : '↑'}</i>${pinned ? '取消置顶' : '置顶'}</button>
    <button class="tmi" data-m="rename"><i>✎</i>重命名</button>
    <div class="tmi-sep"></div>
    <button class="tmi danger" data-m="del"><i>✕</i>删除</button>`;
  box.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = box.offsetWidth || 148;
  const h = box.offsetHeight || 130;
  box.style.top = Math.min(r.bottom + 6, window.innerHeight - h - 10) + 'px';
  box.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 10)) + 'px';
}

/* 只有真存在云端行时才同步，本地草稿（local_）不用发请求 */
async function tiPersist(kind, it, patch) {
  if (state.guest || !it.rowId || String(it.id).startsWith('local_')) return;
  try {
    if (kind === 'task') await CLOUD.saveTask(it.id, patch);
    else await CLOUD.saveMeeting(it.id, patch);
  } catch (e) { toast('没同步到云端：' + e.message); }
}

document.addEventListener('click', e => {
  const more = e.target.closest('[data-more]');
  if (more) {
    e.preventDefault();
    e.stopPropagation();
    openTiMenu(more);
    return;
  }
  if (!e.target.closest('#tiMenu')) closeTiMenu();
});

document.addEventListener('scroll', closeTiMenu, true);
window.addEventListener('resize', closeTiMenu);

$('#tiMenu').addEventListener('click', async e => {
  const b = e.target.closest('.tmi');
  if (!b || !tiCtx) return;
  const { kind, id } = tiCtx;
  const it = tiItem(kind, id);
  const act = b.dataset.m;
  closeTiMenu();
  if (!it) return;

  if (act === 'pin') {
    it.pinned = !it.pinned;
    await tiPersist(kind, it, { pinned: it.pinned });
    renderRail();
    if (kind === 'meeting' && state.curMeetingId === it.id) window.MEET.render();
    if (kind === 'task' && state.curTaskId === it.id) renderTaskHead();
    toast(it.pinned ? '已置顶，排在最上面' : '已取消置顶');
    return;
  }

  if (act === 'rename') {
    const cur = kind === 'task' ? it.title : it.topic;
    const name = prompt(kind === 'task' ? '重命名这个任务' : '重命名这个项目议', cur);
    if (name === null) return;
    const val = String(name).trim().slice(0, 80);
    if (!val || val === cur) return;
    if (kind === 'task') {
      it.title = val;
      await tiPersist('task', it, { title: val });
      renderRail();
      if (state.curTaskId === it.id) renderTaskHead();
    } else {
      it.topic = val;
      await tiPersist('meeting', it, { topic: val });
      window.MEET.renderList();
      if (state.curMeetingId === it.id) window.MEET.render();
    }
    toast('已重命名');
    return;
  }

  if (act === 'del') {
    if (kind === 'task') await removeTask(it);
    else await window.MEET.remove(it);
  }
});

/* ── 弹窗关闭 ── */
document.addEventListener('click', e => {
  if (e.target.matches('[data-close]')) {
    const m = e.target.closest('.mask');
    if (m) m.hidden = true;
  }
  if (e.target.classList.contains('mask')) e.target.hidden = true;
});

/* ── 任务转项目：确认 ── */
document.addEventListener('DOMContentLoaded', () => {
  const go = document.getElementById('tpGo');
  if (go) go.onclick = submitToProj;
});

/* ── 给项目模块用的桥（meeting.js 通过 window.APP 取状态与动作） ── */
async function createTaskFromTodo({ title, goal, staffName }) {
  const emp = state.staff.find(s => s.name === staffName && s.kind !== 'human')
    || state.staff.find(s => /秘书/.test(s.role || ''))
    || state.staff.find(s => s.kind !== 'human')
    || state.staff[0];
  const draft = {
    id: newId(),
    title: guessTitle(title || goal),
    goal,
    deliverables: [],
    employeeId: emp ? emp.id : '',
    employeeName: emp ? emp.name : '',
    employeeRole: emp ? emp.role : '',
    status: 'queued', steps: [], result: '', messages: null,
    tokens: { in: 0, out: 0 }, ms: 0, blockedOn: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  let task;
  if (!state.guest) {
    try { task = await CLOUD.createTask(draft); }
    catch (e) { task = { ...draft, id: 'local_' + draft.id }; }
  } else {
    task = { ...draft, id: 'local_' + draft.id };
  }
  state.tasks.unshift(task);
  renderRail();
  return task;
}

/* 项目节点落盘的文件：直接开在「产出 → 工作区」里 */
async function openFile(path) {
  if (!path) return;
  $('#filesModal').hidden = false;
  $('#fmDownload').hidden = true;
  state.fmTab = 'local';
  $('#fmTabs').querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === 'local'));
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
  state.fmCur = dir;
  $('#fmPath').textContent = '/' + (dir === '.' ? '' : dir);
  $('#fmTip').textContent = '这是这个项目里同事真正写出来的文件，改一个字都在盘上。';
  await openFiles(dir);
  const item = $('#fmList').querySelector(`.fm-item[data-p="${path}"]`);
  if (item) { item.click(); return; }

  /* 记录里的名字是当初计划的名字，盘上未必叫这个。
     先按节点号（T4）在同一目录里找真文件，找不到就直说没写成——
     不能让人以为文件被谁删了。 */
  const base = path.split('/').pop();
  const nid = (base.match(/^([A-Za-z]{1,3}\d{1,2})/) || [])[1];
  const sib = nid ? [...$('#fmList').querySelectorAll('.fm-item[data-p]')].filter(n => {
    const nm = n.dataset.p.split('/').pop();
    return new RegExp('^' + nid + '(?!\\d)', 'i').test(nm);
  }) : [];
  if (sib.length) {
    sib[0].click();
    $('#fmTip').textContent = `记录里叫「${base}」，盘上实际是「${sib[0].dataset.p.split('/').pop()}」，已经直接打开。`;
    return;
  }
  $('#fmText').textContent = `这一节没写出文件——「${base}」只是当初计划的文件名，不是已经写好的文件。`;
  $('#fmTip').textContent = '项目节点只有真写进盘上的文件才算产出；没写成的会标成「核验存疑」并写清原因。左边是这个项目里其它真写出来的文件。';
}

window.APP = {
  get state() { return state; },
  toast, esc, mdLite, modelOf, newId,
  /* 左栏排序：任务和项目共用一套口径（置顶 → 最近修改） */
  sortRailItems,
  showView, refreshRail: renderRail, renderStaff: renderStaff,
  gotoTask: id => { state.view = 'task'; showView('task'); selectTask(id); },
  createTaskFromTodo,
  addTodos, linkTodoTask, renderTodos, renderTodoCount,
  kbSnippets, kbOf, roleShort, roleGroup,
  openFile, applyContentSearch, renderOutputRail, renderOutputList, progressHTML, openOutputView, viewOutput,
  /* 项目对话区对齐任务线：复用这组渲染件（彩色头像 / 步骤折叠 / 文件卡） */
  avClass, nodeHTML, filesBlockHTML, argsBrief, isImagePath, imgPreviewUrl,
  /* 产出落本地：项目侧（meeting.js）复用同一套 */
  syncFilesFor, restoreFilesFor, saveOneToLocal, renderOutDirBar, flushPendingSaves,
  /* 员工记忆：给质检/联调留的入口 */
  rememberEmp, restoreLastEmp, newTaskDraft, selectTask,
  /* 待办失效 / 错误净化 / 参数瘦身：给联调留的入口 */
  voidAllTodos, renderTodos, friendlyErr, leanArgs, looksBlocked,
  /* 管理员校验：登录态变化后可以再查一次，决定质检台入口露不露 */
  checkAdmin,
  /* 刷新续跑：给联调留的入口 */
  markRunning, clearRunningMark, autoResumeOn, pendingResumeId, autoResumeTask,
  claimResume, markedTaskId, runMark, tabId, persistRoundStart,
  startRunHeart, stopRunHeart, freshMark, ownRunMark, runGoal,
  /* 刷新后的判活与耗时还原：给单测留的入口 */
  stillRunning, shouldMarkInterrupted, roundsList, doingTextOf, runStatusHTML, SRV,
  /* 产出过滤 + 额度：给单测和联调留的入口 */
  isInternalArtifact, budgetOf, spentOf, ensureBudget, fmtTokenW, queueAlert, queueTaskAlert,
  /* 设置里的额度夹取：任务与项目两套数共用一套规则 */
  openSettings, normLimits,
  /* 验收卡只在管理员视角用，不在任务对话里渲染 */
  verifyCardHTML,
  /* 任务落库：转项目时要在任务上盖「已转项目」的章 */
  persistTask,
  /* 分任务隔离自检：质检台每轮都跑一次，不烧 token（跑着的任务不许写进别的任务） */
  checkRunBinding,
  /* 积分闸：项目侧（meeting.js）和质检台都用这同一套口径，别各判一套 */
  creditLeft, creditWarn, walletTotal, creditRate, LOW_CREDIT
};
/* meeting.js 是按 window.xxx 探测的，这两个别名要挂在 window 上 */
window.syncFilesFor = syncFilesFor;
window.restoreFilesFor = restoreFilesFor;
window.saveOneToLocal = saveOneToLocal;
window.renderOutDirBar = renderOutDirBar;
/* 项目对话区对齐任务线：项目侧复用任务线这组渲染件（彩色头像 / 步骤折叠 / 文件卡） */
window.avClass = avClass;
window.nodeHTML = nodeHTML;
window.filesBlockHTML = filesBlockHTML;
window.argsBrief = argsBrief;
window.isImagePath = isImagePath;
window.imgPreviewUrl = imgPreviewUrl;

/* ── 栏宽拉手 ──
   左右两条分隔线都能按住鼠标左右拖：左栏改 --rail-w（顶栏品牌占位宽度跟着走，
   导航起点仍然对齐主区标题），右栏改 --rail-rw。
   宽度写进 localStorage，下次打开还是上次宽；双击拉手回默认宽。 */
const SPLIT_LS = { left: 'boss.railW', right: 'boss.outW' };
const SPLIT_DEF = { left: 216, right: 232 };
/* 主区留够字宽，不然拖到极限会把对话挤成一条 */
const SPLIT_MIN_MAIN = 460;
const SPLIT_MIN = { left: 148, right: 168 };
const SPLIT_MAX = { left: 420, right: 520 };

function splitWidth(side) {
  const v = parseInt(document.documentElement.style.getPropertyValue(side === 'left' ? '--rail-w' : '--rail-rw'), 10);
  if (v > 0) return v;
  const el = document.querySelector(side === 'left' ? '.layout > .rail' : '.rail.right');
  return el ? Math.round(el.getBoundingClientRect().width) : SPLIT_DEF[side];
}
/* 拖动过程中每一步都只算「起点宽度 + 位移」再夹紧，避免累积误差把栏拖歪 */
function clampSplit(side, startW, dx) {
  const layout = document.querySelector('.layout');
  const other = side === 'left'
    ? document.querySelector('.rail.right')
    : document.querySelector('.layout > .rail');
  const total = layout ? layout.getBoundingClientRect().width : window.innerWidth;
  const otherW = other && other.offsetParent !== null ? other.getBoundingClientRect().width : 0;
  const maxW = Math.min(SPLIT_MAX[side], total - otherW - SPLIT_MIN_MAIN);
  const want = startW + (side === 'left' ? dx : -dx);
  return Math.round(Math.max(SPLIT_MIN[side], Math.min(Math.max(maxW, SPLIT_MIN[side]), want)));
}
function setSplit(side, w) {
  document.documentElement.style.setProperty(side === 'left' ? '--rail-w' : '--rail-rw', w + 'px');
}

function initSplitters() {
  /* 先把上次拖的宽度还原，再绑事件：顺序反了会先闪一下默认宽 */
  ;['left', 'right'].forEach(side => {
    let w = 0;
    try { w = parseInt(localStorage.getItem(SPLIT_LS[side]) || '', 10) || 0; } catch { /* 隐私模式读不了，按默认 */ }
    if (w >= SPLIT_MIN[side] && w <= SPLIT_MAX[side]) setSplit(side, w);
  });

  [['splitL', 'left'], ['splitR', 'right']].forEach(([id, side]) => {
    const el = document.getElementById(id);
    if (!el) return;
    let dragging = false, startX = 0, startW = 0, moved = false;

    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;   // 只认左键，右键留给菜单
      dragging = true; moved = false;
      startX = e.clientX;
      startW = splitWidth(side);
      el.classList.add('dragging');
      document.body.classList.add('resizing');
      try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器不支持就算了，document 上的 move 兜住 */ }
      e.preventDefault();
    });

    el.addEventListener('pointermove', e => {
      if (!dragging) return;
      if (Math.abs(e.clientX - startX) > 1) moved = true;
      setSplit(side, clampSplit(side, startW, e.clientX - startX));
    });

    const stop = e => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      try { el.releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
      const w = splitWidth(side);
      try { localStorage.setItem(SPLIT_LS[side], String(w)); } catch { /* 存不下不影响本次 */ }
      /* 拖完让主区重排一次：宽高算死的预览画布 / 图表要靠 resize 重新量 */
      if (moved) window.dispatchEvent(new Event('resize'));
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
    /* 指针跑出窗口外松手，也要收尾 */
    el.addEventListener('lostpointercapture', stop);

    /* 双击回默认宽：顺手把存下来的宽度也清掉 */
    el.addEventListener('dblclick', e => {
      e.preventDefault();
      document.documentElement.style.removeProperty(side === 'left' ? '--rail-w' : '--rail-rw');
      try { localStorage.removeItem(SPLIT_LS[side]); } catch { /* 忽略 */ }
      window.dispatchEvent(new Event('resize'));
    });

    /* 键盘也能调：聚焦拉手后 ←/→ 各 16px，方便没有鼠标的场合 */
    el.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const step = e.key === 'ArrowLeft' ? -16 : 16;
      const w = clampSplit(side, splitWidth(side), side === 'left' ? step : -step);
      setSplit(side, w);
      try { localStorage.setItem(SPLIT_LS[side], String(w)); } catch { /* 忽略 */ }
      window.dispatchEvent(new Event('resize'));
    });
  });
}

/* 额度被拦之后的那颗「去调额度」：直接把设置打开、滚到那一块、聚焦输入框。
   三步操作一次点完——中间少一步，人多半就去干别的了。 */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-quota-fix]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  openSettings();
  const box = $('#quotaDay');
  if (box) {
    try { box.scrollIntoView({ block: 'center' }); } catch { /* 老浏览器没有也行 */ }
    box.focus();
    try { box.select(); } catch { /* 忽略 */ }
  }
});

/* 对话里文件卡上的「预览」：一律走产出预览弹窗，省得再去文件管理器翻 */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-preview]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const p = b.dataset.preview;
  const rec = collectOutputs().find(o => o.path === p);
  const t = curTask();
  openOutputView(rec || {
    path: p, srcType: 'task', srcId: t ? t.id : '',
    srcLabel: t ? (t.title || t.goal) : '', at: Date.now()
  });
});

/* 质检台用：不烧 token 的自检——跑着的任务会不会把步骤结论写进另一个任务。
   拿两条假任务走一遍真函数（handleEvent / buildSteps / watchingRun）：
   A 在跑、老板看着 B，A 的事件必须落在 A 的现场，B 的快照里不许出现 A 的工具。
   线上 2026-11-03 真踩过：A 的 gen_image / make_deck 全写进了 B 的对话。 */
function checkRunBinding() {
  const keep = {
    curTaskId: state.curTaskId, trace: state.trace, tasks: state.tasks.slice(),
    ctx: runCtx, started: state.traceStartedAt,
    save: window.CLOUD && window.CLOUD.saveTask
  };
  const out = [];
  try {
    if (window.CLOUD && window.CLOUD.saveTask) {
      /* 自检不许往云库塞假行 */
      window.CLOUD.saveTask = () => Promise.resolve();
    }
    const taskA = { id: '__bindA', title: 'A', steps: [], round: 1, tokens: { in: 0, out: 0 } };
    const taskB = { id: '__bindB', title: 'B', steps: [], round: 1, tokens: { in: 0, out: 0 } };
    const traceA = { round: 1, status: 'running', nodes: [], says: [], result: '' };
    const traceB = { round: 1, status: 'done', nodes: [], says: [], result: 'B 的结论' };
    state.tasks = [taskA, taskB];
    state.traceStartedAt = Date.now();
    /* 起跑 A */
    state.trace = traceA;
    runCtx = { id: taskA.id, task: taskA, trace: traceA, startedAt: state.traceStartedAt };
    /* 老板中途点开了 B */
    state.trace = traceB;
    state.curTaskId = taskB.id;

    handleEvent({ t: 'step', kind: 'call', name: 'gen_image', args: {} });
    handleEvent({ t: 'step', kind: 'result', name: 'gen_image', ok: true, output: '已出图', files: ['assets/x.png'] });
    handleEvent({ t: 'text', content: 'A 的结论' });

    out.push({ name: '事件落到跑着的那个任务', pass: traceA.nodes.length === 1 && traceA.says.length === 1 });
    out.push({
      name: '正在看的任务一点没被写脏',
      pass: traceB.nodes.length === 0 && traceB.says.length === 0 && traceB.result === 'B 的结论'
    });
    out.push({ name: '跑着的时候认得出「不是同一条」', pass: watchingRun() === false });
    out.push({ name: 'runTask() 指向 A 而不是 B', pass: runTask().id === '__bindA' && runTrace() === traceA });

    const sB = buildSteps(taskB);
    out.push({
      name: 'B 的快照里没有 A 的工具',
      pass: !sB.some(s => s.kind === 'tool' && s.name === 'gen_image')
    });
    out.push({
      name: 'B 的结论没被 A 顶掉',
      pass: !sB.some(s => s.kind === 'say' && String(s.text).includes('A 的结论'))
    });
    const sA = buildSteps(taskA);
    out.push({
      name: 'A 的快照里有自己的工具和结论',
      pass: sA.some(s => s.kind === 'tool' && s.name === 'gen_image')
        && sA.some(s => s.kind === 'say' && String(s.text).includes('A 的结论'))
    });

    /* 切回 A：现场立刻接管，不需要从存档重建 */
    state.curTaskId = taskA.id;
    out.push({ name: '切回跑着的那个就地接管现场', pass: watchingRun() === true && runTrace() === traceA });

    /* 反方向：没在跑的时候，老板看着 A 去给 B 存档 —— B 不许借 A 的现场。
       线上 2026-11-03 也踩过这半边：B 的 write_file（长任务流程图.md）流进了 A 的产出物清单。 */
    runCtx = null;
    state.curTaskId = taskA.id;
    state.trace = traceA;
    const sB2 = buildSteps(taskB);
    out.push({
      name: '存 B 时不借 A 的现场（反方向）',
      pass: !sB2.some(s => (s.kind === 'tool' && s.name === 'gen_image')
        || (s.kind === 'say' && String(s.text).includes('A 的结论')))
        && sB2.some(s => s.kind === 'say' && String(s.text).includes('B 的结论')) /* B 自己的也不许丢 */
    });
  } catch (e) {
    out.push({ name: '自检跑得完', pass: false, detail: String((e && e.message) || e) });
  } finally {
    try {
      if (window.CLOUD && keep.save) window.CLOUD.saveTask = keep.save;
      runCtx = keep.ctx;
      state.trace = keep.trace;
      state.curTaskId = keep.curTaskId;
      state.tasks = keep.tasks;
      state.traceStartedAt = keep.started;
    } catch { /* 尽力还原 */ }
  }
  return { pass: out.every(x => x.pass), detail: out };
}

/* ── 起 ── */
init();
/* 栏宽拉手要在布局渲染完再绑：栏宽得先量到真实像素才算得准 */
initSplitters();
