/* Boss Agent 内核前端 v0.1 —— 原生 JS，无依赖 */
const $ = s => document.querySelector(s);
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Token': localStorage.getItem('bat') || '',
      ...(opts.headers || {})
    }
  });
  if (r.status === 401) { showLogin(); throw new Error('未登录'); }
  const j = await r.json().catch(() => ({ ok: false, error: '响应不是 JSON' }));
  if (!j.ok) throw new Error(j.error || '请求失败');
  return j;
};

const state = {
  employees: [], tasks: [], personas: {}, presets: [], config: null,
  curTask: null, curEmpId: null, persona: 'mature',
  trace: { nodes: [], result: '', status: '', blocked: null }
};

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ── 登录 ── */
function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
}
async function doLogin() {
  const token = $('#tokenInput').value.trim();
  if (!token) return toast('先填口令');
  try {
    const r = await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const j = await r.json();
    if (!j.ok) { $('#loginHint').textContent = j.error || '口令不对'; return; }
    localStorage.setItem('bat', token);
    $('#login').hidden = true;
    $('#app').hidden = false;
    await boot();
  } catch (e) { $('#loginHint').textContent = e.message; }
}

/* ── 启动 ── */
async function boot() {
  const j = await api('/api/bootstrap');
  state.employees = j.employees;
  state.tasks = j.tasks;
  state.personas = j.personas;
  state.presets = j.presets;
  state.config = j.config;
  if (!state.curEmpId && state.employees.length) state.curEmpId = state.employees[0].id;

  const p = j.config.provider;
  const mock = p.preset === 'mock' || !p.baseURL;
  const pill = $('#modelPill');
  pill.textContent = mock ? '离线 Mock' : `${p.model || '未设模型'}`;
  pill.className = 'model-pill' + (mock ? ' mock' : '');
  pill.title = mock ? '当前是离线 Mock 基座，在「模型设置」里换成真实服务商' : p.baseURL;

  $('#permGroup').querySelectorAll('.perm').forEach(b => {
    b.classList.toggle('on', !!j.config.permissions[b.dataset.cat]);
  });
  $('#wsLabel').textContent = '工作区 ' + j.config.workspace.replace(/^.*\/([^/]+\/[^/]+)$/, '…/$1');

  renderEmployees();
  renderTasks();
  renderWho();
  if (!state.tasks.length) renderEmpty();
  else selectTask(state.tasks[0].id);
}

/* ── 员工 ── */
function renderEmployees() {
  if (!state.employees.length) {
    $('#empList').innerHTML = `<div style="font-size:11.5px;color:#8f97a3;padding:10px 4px;line-height:1.8">还没有员工。<br>先建一个，给它一个岗位和说话风格。</div>`;
    return;
  }
  $('#empList').innerHTML = state.employees.map(e => {
    const p = state.personas[e.persona] || { n: '—', d: '' };
    return `<div class="emp ${e.id === state.curEmpId ? 'on' : ''}" data-id="${e.id}">
      <div class="emp-top">
        <div class="av">${e.name[0]}</div>
        <div style="min-width:0">
          <div class="emp-n"><span>${esc(e.name)}</span><span class="pn">${p.n}</span></div>
          <div class="emp-r">${esc(e.role)}</div>
        </div>
      </div>
      <div class="emp-m">${e.model ? '模型 ' + esc(e.model) : '跟随全局模型'}</div>
    </div>`;
  }).join('');
  $('#empList').querySelectorAll('.emp').forEach(el => {
    el.onclick = () => { state.curEmpId = el.dataset.id; renderEmployees(); renderWho(); };
  });
}
function renderWho() {
  const e = state.employees.find(x => x.id === state.curEmpId);
  $('#whoLabel').textContent = e ? `交给 ${e.name}` : '先建员工';
}

/* ── 任务列表 ── */
const ST = { queued: '待执行', running: '执行中', done: '已完成', blocked: '等授权', failed: '失败' };
function renderTasks() {
  if (!state.tasks.length) {
    $('#taskList').innerHTML = `<div style="font-size:11.5px;color:#8f97a3;padding:10px 4px">还没有任务</div>`;
    return;
  }
  $('#taskList').innerHTML = state.tasks.map(t => `
    <div class="ti ${state.curTask && state.curTask.id === t.id ? 'on' : ''}" data-id="${t.id}">
      <div class="ti-t"><i class="dot ${t.status}"></i><span>${esc(t.title)}</span></div>
      <div class="ti-m"><span>${ST[t.status] || t.status}</span>${t.tokens && t.tokens.out ? `·<span>${t.tokens.in + t.tokens.out} tok</span>` : ''}</div>
    </div>`).join('');
  $('#taskList').querySelectorAll('.ti').forEach(el => {
    el.onclick = () => selectTask(el.dataset.id);
  });
}
function renderEmpty() {
  $('#taskTitle').textContent = '还没有任务';
  $('#taskMeta').textContent = '在下面交代第一件事，或者点左上角「+ 新建」';
  $('#taskStats').innerHTML = '';
}

/* ── 打开一个任务 ── */
async function selectTask(id) {
  const j = await api('/api/tasks/' + id);
  state.curTask = j.task;
  state.trace = {
    nodes: (j.task.steps || []).filter(s => s.kind === 'tool').map(s => ({
      name: s.name, args: s.args, ok: s.ok, output: s.output, ms: s.ms
    })),
    result: j.task.result || '',
    status: j.task.status,
    blocked: j.task.blockedOn ? { category: j.task.blockedOn } : null
  };
  renderTasks();
  renderTaskHead();
  renderTrace();
}

function renderTaskHead() {
  const t = state.curTask;
  if (!t) return;
  $('#taskTitle').textContent = t.title;
  $('#taskMeta').textContent = t.goal;
  const tok = t.tokens || { in: 0, out: 0 };
  $('#taskStats').innerHTML = `
    <div class="stat"><b>${t.employeeName}</b><span>执行员工</span></div>
    <div class="stat"><b>${tok.in + tok.out || '—'}</b><span>tokens</span></div>
    <div class="stat"><b>${t.ms ? (t.ms / 1000).toFixed(1) + 's' : '—'}</b><span>耗时</span></div>`;
}

/* ── 轨迹渲染 ── */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function argsBrief(a) {
  if (!a) return '';
  const s = Object.entries(a).map(([k, v]) => {
    let val = typeof v === 'string' ? v.replace(/\s+/g, ' ') : JSON.stringify(v);
    if (val.length > 46) val = val.slice(0, 46) + '…';
    return `${k}=${val}`;
  }).join(' · ');
  return s.length > 96 ? s.slice(0, 96) + '…' : s;
}

const closedNodes = new Set();
function renderTrace() {
  const tr = state.trace;
  const box = $('#trace');
  if (!tr.nodes.length && !tr.result && tr.status !== 'running') {
    box.innerHTML = `<div class="empty"><div class="empty-t">这里会显示每一步</div>
      <div class="empty-d">员工调用了哪个工具、参数是什么、返回了什么、花了多久——都摊开给你看，不藏在对话里。</div></div>`;
    return;
  }
  let html = '';
  if (tr.blocked) {
    const names = { read: '读文件', write: '写文件', exec: '跑命令' };
    html += `<div class="alert"><div class="grow">这一步被拦下了：<b>${names[tr.blocked.category] || tr.blocked.category}</b> 权限没开。开一下再重跑，不用改目标。</div>
      <button onclick="grantAndRerun('${tr.blocked.category}')">开启并重跑</button></div>`;
  }
  if (tr.status === 'running') {
    html += `<div class="node" style="border-style:dashed"><div class="node-h"><span class="n">…</span><b style="color:#8f97a3">正在执行</b><span class="args">模型在想 / 工具在跑</span></div></div>`;
  }
  tr.nodes.forEach((n, i) => {
    const open = !closedNodes.has(n.name + i);
    html += `<div class="node" data-i="${i}">
      <div class="node-h" onclick="toggleNode('${n.name}${i}')">
        <span class="n">${String(i + 1).padStart(2, '0')}</span>
        <b>${esc(n.name)}</b>
        <span class="args">${esc(argsBrief(n.args))}</span>
        ${n.ms ? `<span class="ms">${n.ms}ms</span>` : ''}
        <span class="st ${n.ok === undefined ? 'pending' : n.ok ? 'ok' : 'no'}">${n.ok === undefined ? '…' : n.ok ? 'ok' : 'err'}</span>
      </div>
      ${n.output && open ? `<div class="node-b"><pre>${esc(n.output)}</pre></div>` : ''}
    </div>`;
  });
  if (tr.result) {
    html += `<div class="node-txt"><span class="lbl">${esc((state.curTask && state.curTask.employeeName) || '')} 的结论</span>${esc(tr.result)}</div>`;
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}
function toggleNode(key) {
  if (closedNodes.has(key)) closedNodes.delete(key); else closedNodes.add(key);
  renderTrace();
}

/* ── 执行 ── */
let running = false;
async function runGoal(goal, existingTaskId) {
  if (running) return toast('上一个还在跑');
  if (!state.employees.length) return toast('先建一个员工');
  const text = (goal || '').trim();
  if (!text && !existingTaskId) return toast('交代一件事');

  running = true;
  $('#runBtn').disabled = true;
  try {
    let taskId = existingTaskId;
    if (!taskId) {
      const c = await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ goal: text, employeeId: state.curEmpId })
      });
      taskId = c.task.id;
      state.curTask = c.task;
      state.tasks.unshift({ id: c.task.id, title: c.task.title, status: 'queued', employeeName: c.task.employeeName, tokens: { in: 0, out: 0 } });
      state.trace = { nodes: [], result: '', status: 'running', blocked: null };
      renderTasks(); renderTaskHead(); renderTrace();
      $('#goal').value = '';
      $('#goal').style.height = 'auto';
    }

    state.trace = { nodes: [], result: '', status: 'running', blocked: null };
    closedNodes.clear();
    renderTrace();

    const res = await fetch(`/api/tasks/${taskId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': localStorage.getItem('bat') || '' }
    });
    if (res.status === 401) { showLogin(); return; }
    if (!res.ok || !res.body) throw new Error('流式连接失败');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const p of parts) {
        const line = p.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        handleEvent(ev);
      }
    }
  } catch (e) {
    toast(e.message);
  } finally {
    running = false;
    $('#runBtn').disabled = false;
    const t = state.tasks.find(x => x.id === (state.curTask && state.curTask.id));
    if (t && state.curTask) t.status = state.curTask.status;
    renderTasks();
  }
}

function handleEvent(ev) {
  const tr = state.trace;
  if (ev.t === 'start') {
    tr.status = 'running';
    renderTrace();
  } else if (ev.t === 'step' && ev.kind === 'call') {
    tr.nodes.push({ name: ev.name, args: ev.args, ok: undefined, output: '', ms: 0 });
    renderTrace();
  } else if (ev.t === 'step' && ev.kind === 'result') {
    const n = tr.nodes[tr.nodes.length - 1];
    if (n && n.name === ev.name) { n.ok = ev.ok; n.output = ev.output; n.ms = ev.ms; }
    renderTrace();
  } else if (ev.t === 'text') {
    tr.result = ev.content;
    renderTrace();
  } else if (ev.t === 'need_permission') {
    tr.blocked = { category: ev.category };
    renderTrace();
  } else if (ev.t === 'usage') {
    if (state.curTask) {
      state.curTask.tokens = { in: ev.in, out: ev.out };
      renderTaskHead();
      const li = state.tasks.find(x => x.id === state.curTask.id);
      if (li) { li.tokens = state.curTask.tokens; renderTasks(); }
    }
  } else if (ev.t === 'done') {
    tr.status = ev.task.status;
    if (state.curTask) {
      state.curTask = { ...state.curTask, ...ev.task };
    }
    const li = state.tasks.find(x => x.id === ev.task.id);
    if (li) { li.status = ev.task.status; li.tokens = ev.task.tokens; li.title = ev.task.title; }
    renderTasks(); renderTaskHead(); renderTrace();
  } else if (ev.t === 'error') {
    tr.status = 'failed';
    tr.nodes.push({ name: 'error', args: {}, ok: false, output: ev.message, ms: 0 });
    renderTrace();
  }
}

async function grantAndRerun(cat) {
  try {
    const perms = { ...state.config.permissions, [cat]: true };
    await api('/api/config', { method: 'POST', body: JSON.stringify({ permissions: perms }) });
    state.config.permissions = perms;
    $('#permGroup').querySelectorAll('.perm').forEach(b => {
      b.classList.toggle('on', !!perms[b.dataset.cat]);
    });
    toast('已开启，重跑中');
    await runGoal('', state.curTask.id);
  } catch (e) { toast(e.message); }
}

/* ── 绑定 ── */
$('#loginBtn').onclick = doLogin;
$('#tokenInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

$('#permGroup').addEventListener('click', async e => {
  const b = e.target.closest('.perm');
  if (!b) return;
  const cat = b.dataset.cat;
  const perms = { ...state.config.permissions, [cat]: !state.config.permissions[cat] };
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ permissions: perms }) });
    state.config.permissions = perms;
    b.classList.toggle('on', perms[cat]);
    toast(`${b.textContent} 已${perms[cat] ? '开启' : '关闭'}`);
  } catch (err) { toast(err.message); }
});

$('#runBtn').onclick = () => runGoal($('#goal').value);
$('#goal').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runGoal($('#goal').value); }
});
$('#goal').addEventListener('input', e => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 130) + 'px';
});
$('#newTaskBtn').onclick = () => $('#goal').focus();

/* 新建员工 */
function openEmp() {
  state.persona = 'mature';
  $('#empName').value = ''; $('#empRole').value = ''; $('#empNotes').value = '';
  $('#personaGrid').innerHTML = Object.entries(state.personas).map(([k, p]) =>
    `<div class="pg ${k === 'mature' ? 'on' : ''}" data-k="${k}">${p.n}<small>${p.d.slice(0, 10)}</small></div>`
  ).join('');
  $('#personaGrid').querySelectorAll('.pg').forEach(el => {
    el.onclick = () => {
      state.persona = el.dataset.k;
      $('#personaGrid').querySelectorAll('.pg').forEach(x => x.classList.toggle('on', x === el));
    };
  });
  $('#empModal').hidden = false;
  setTimeout(() => $('#empName').focus(), 60);
}
$('#newEmpBtn').onclick = openEmp;
$('#empSave').onclick = async () => {
  try {
    const j = await api('/api/employees', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#empName').value, role: $('#empRole').value,
        persona: state.persona, notes: $('#empNotes').value,
        model: state.config.provider.model
      })
    });
    state.employees.push(j.employee);
    state.curEmpId = j.employee.id;
    $('#empModal').hidden = true;
    renderEmployees(); renderWho();
    toast(`${j.employee.name} 上岗了`);
  } catch (e) { toast(e.message); }
};

/* 模型设置 */
$('#settingsBtn').onclick = () => {
  const p = state.config.provider;
  $('#presetSel').innerHTML = state.presets.map(x => `<option value="${x.id}" ${x.id === p.preset ? 'selected' : ''}>${x.label}</option>`).join('');
  $('#baseURL').value = p.baseURL || '';
  $('#apiKey').value = '';
  $('#apiKey').placeholder = state.config.hasKey ? p.apiKey : 'sk-…';
  $('#modelName').value = p.model || '';
  $('#maxSteps').value = state.config.maxSteps || 12;
  $('#setModal').hidden = false;
};
$('#presetSel').onchange = e => {
  const x = state.presets.find(p => p.id === e.target.value);
  if (x) { $('#baseURL').value = x.baseURL; $('#modelName').value = x.model; }
};
$('#setSave').onclick = async () => {
  try {
    const provider = {
      preset: $('#presetSel').value,
      baseURL: $('#baseURL').value.trim(),
      apiKey: $('#apiKey').value.trim(),
      model: $('#modelName').value.trim()
    };
    await api('/api/config', { method: 'POST', body: JSON.stringify({ provider, maxSteps: $('#maxSteps').value }) });
    $('#setModal').hidden = true;
    await boot();
    toast('已保存');
  } catch (e) { toast(e.message); }
};

document.addEventListener('click', e => {
  if (e.target.matches('[data-close]')) e.target.closest('.mask').hidden = true;
  if (e.target.classList.contains('mask')) e.target.hidden = true;
});

/* 自检：被当成静态文件打开时给出明确提示 */
(function selfCheck() {
  if (location.protocol === 'file:' || location.pathname.startsWith('/static-html/')) {
    showLogin();
    $('#loginHint').innerHTML = '你打开的是页面文件，不是应用本身。<br>先在终端跑 <code>node server.js</code>，再访问它打印的地址。';
    return;
  }
  // 支持带口令直达（仅本机回环可用），存下后立刻从地址栏抹掉
  const q = new URLSearchParams(location.search);
  if (q.get('token')) {
    localStorage.setItem('bat', q.get('token'));
    history.replaceState({}, '', '/');
  }
  // 免口令模式下内核直接放行，这里先乐观放行，真被拒再退回登录页
  $('#login').hidden = true; $('#app').hidden = false;
  boot().catch(() => { showLogin(); });
})();
