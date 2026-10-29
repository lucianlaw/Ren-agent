// Boss Agent 内核 v0.1
// 只监听 127.0.0.1，所有 /api 请求都要过口令与 Host/Origin 校验
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  ROOT, DATA_DIR, ensureToken, createSession, validSession,
  getConfig, saveConfig, listEmployees, saveEmployees,
  listTasks, saveTasks, PERSONAS
} from './lib/store.js';
import { TOOL_DEFS, TOOL_CATEGORY, runTool } from './lib/tools.js';
import { callModel, PRESETS } from './lib/llm.js';
import { verifyStep, checkDeliverables } from './lib/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4319);
const TOKEN = ensureToken();

/* 免口令模式：只在「自己一个人的机器上」用。
   开启方式：node server.js --no-auth  或  NO_AUTH=1 node server.js
   它关掉的只有口令这一道闸，Host / Origin 校验和 127.0.0.1 绑定照旧。 */
const NO_AUTH = process.argv.includes('--no-auth') || process.env.NO_AUTH === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

/* ── 安全闸：Host / Origin / 口令 ── */
const HOST_OK = h => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(h || '');

function originOK(req) {
  const o = req.headers.origin;
  if (!o) return true; // 同源请求或无 Origin（curl）
  try {
    const u = new URL(o);
    return HOST_OK(u.host);
  } catch { return false; }
}

function authed(req) {
  if (NO_AUTH) return true;
  const h = req.headers['x-token'];
  if (h && h === TOKEN) return true;
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
  return !!(m && validSession(m[1]));
}

/* ── 员工 ── */
function personaOf(id) { return PERSONAS[id] || PERSONAS.mature; }

function buildSystem(emp, cfg) {
  const p = personaOf(emp.persona);
  return [
    `你是「${emp.name}」，一个真实存在于这家公司的岗位员工，岗位是「${emp.role}」。`,
    `说话风格：${p.n} —— ${p.d}`,
    `你的语气大致像这样：「${p.ex}」`,
    emp.notes ? `老板对你的额外交代：${emp.notes}` : '',
    '',
    `工作目录：${cfg.workspace}`,
    '所有文件路径都相对工作目录，不能访问目录之外的东西。',
    '',
    '工作规则（必须遵守）：',
    '1. 能用工具确认的事情，不要凭印象回答。先查，再说。',
    '2. 每一步只做一件事，看到结果再决定下一步。',
    '3. 工具报错或拿不到信息，就如实说拿不到，不要编造。',
    '4. 最终用中文回答，先给结论，再给依据；不超过 400 字。',
    '5. 不要主动写文件或跑命令，除非任务目标确实要求产出。',
    '6. 涉及资金、证件、对外发送的事，只给方案，不动手。'
  ].filter(Boolean).join('\n');
}

/* ── 任务执行：SSE 流出每一步 ── */
async function runTask(task, emp, cfg, send, onFinish) {
  const t0 = Date.now();
  // 断点续跑：上一轮的消息上下文还在，就从那里接着走，不从头再来
  const resuming = Array.isArray(task.messages) && task.messages.length > 2;
  const messages = resuming
    ? task.messages
    : [
        { role: 'system', content: buildSystem(emp, cfg) },
        { role: 'user', content: task.goal }
      ];
  let inTok = task.tokens?.in || 0, outTok = task.tokens?.out || 0;
  let status = 'done';
  let blockedCat = null;

  // 预算闸：算钱，不按调用次数。超了就挂起，不让它继续烧
  const budget = Number(cfg.budgetCNY) || 0;
  const priceIn = Number(cfg.priceIn) || 0;
  const priceOut = Number(cfg.priceOut) || 0;
  const costOf = (i, o) => (i / 1e6) * priceIn + (o / 1e6) * priceOut;

  const sse = obj => { try { send(obj); } catch { /* 客户端断了 */ } };

  for (let step = 0; step < cfg.maxSteps; step++) {
    if (budget > 0 && costOf(inTok, outTok) >= budget) {
      status = 'budget_exceeded';
      sse({ t: 'budget', spent: costOf(inTok, outTok), budget });
      break;
    }
    let r;
    try {
      r = await callModel({ provider: cfg.provider, messages, tools: TOOL_DEFS });
    } catch (e) {
      sse({ t: 'error', message: e.message });
      task.steps.push({ i: step + 1, kind: 'error', text: e.message, at: Date.now() });
      status = 'failed';
      break;
    }
    inTok += r.usage.in; outTok += r.usage.out;
    sse({ t: 'usage', in: inTok, out: outTok });

    if (r.content) {
      task.result = r.content;
      sse({ t: 'text', content: r.content });
    }
    if (!r.toolCalls.length) {
      if (!task.result) { task.result = '（模型没有返回内容）'; sse({ t: 'text', content: task.result }); }
      break;
    }

    messages.push({
      role: 'assistant',
      content: r.content || '',
      tool_calls: r.toolCalls.map(c => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) }
      }))
    });

    let blocked = null;
    for (const c of r.toolCalls) {
      const cat = TOOL_CATEGORY[c.name] || 'exec';
      if (cat !== 'none' && !cfg.permissions[cat]) {
        blocked = { category: cat, tool: c.name };
        blockedCat = blockedCat || cat;
        sse({ t: 'need_permission', category: cat, tool: c.name });
        task.steps.push({ i: step + 1, kind: 'blocked', name: c.name, cat, at: Date.now() });
        messages.push({ role: 'tool', tool_call_id: c.id, content: `用户没有开启「${cat}」类权限，这一步被拦截了。` });
        continue;
      }
      sse({ t: 'step', kind: 'call', name: c.name, args: c.args });
      const out = await runTool(c.name, c.args, {
        workspace: cfg.workspace,
        onTodos: items => { task.todos = items; }
      });
      // 后置校验：这一步是不是真做成了
      const v = verifyStep(c.name, c.args, out, cfg.workspace);
      task.steps.push({
        i: step + 1, kind: 'tool', name: c.name, cat,
        args: c.args, ok: out.ok, output: out.output, ms: out.ms, at: Date.now(),
        verify: v
      });
      sse({ t: 'step', kind: 'result', name: c.name, ok: out.ok, output: out.output, ms: out.ms, verify: v });
      // 校验没过：把失败原因回灌给模型，让它换路子，而不是继续往下演
      messages.push({
        role: 'tool', tool_call_id: c.id,
        content: v.pass
          ? out.output
          : `${out.output}\n\n【校验未通过】${v.why}。这一步没有真正生效，请换一种做法重试，不要当作已完成。`
      });
    }
    if (blocked && r.toolCalls.every(c => {
      const k = TOOL_CATEGORY[c.name] || 'exec';
      return k !== 'none' && !cfg.permissions[k];
    })) {
      // 整步都被拦下，模型无从继续
      status = 'blocked';
      task.blockedOn = blocked.category;
      break;
    }
  }

  if (blockedCat && status === 'done') status = 'blocked';

  // 交付物校验：声明了要产出什么，就必须真有。
  // 没有交付物的任务只能叫「它说做完了」，不能叫「已完成」。
  const dv = checkDeliverables(task.deliverables, cfg.workspace);
  task.deliverableCheck = dv;
  task.verified = dv.checked ? dv.pass : null;
  if (dv.checked && !dv.pass && (status === 'done' || status === 'blocked')) status = 'unverified';

  task.status = status;
  if (blockedCat) task.blockedOn = blockedCat;
  // 断点续跑的依据：把这一轮的上下文留下来（截断尾部，别把 data 撑爆）
  task.messages = messages.slice(-40);
  task.tokens = { in: inTok, out: outTok };
  task.cost = costOf(inTok, outTok);
  task.ms = Date.now() - t0;
  onFinish(task);
  sse({ t: 'done', task });
}

/* ── 路由 ── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');

  if (!HOST_OK(req.headers.host)) return send(res, 421, { ok: false, error: 'Host 不被接受' });
  if (!originOK(req)) return send(res, 403, { ok: false, error: 'Origin 不被接受' });

  try {
    /* 静态与入口 */
    if (req.method === 'GET' && !u.pathname.startsWith('/api/')) {
      const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '');
      const f = path.join(PUBLIC, rel);
      if (f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return fs.createReadStream(f).pipe(res);
      }
      return send(res, 404, { ok: false, error: 'not found' });
    }

    if (u.pathname === '/api/health') return send(res, 200, { ok: true, v: '0.1.0' });

    if (u.pathname === '/api/auth' && req.method === 'POST') {
      const b = await readBody(req);
      if (!NO_AUTH && b.token !== TOKEN) {
        await new Promise(r => setTimeout(r, 400)); // 拖慢暴力尝试
        return send(res, 401, { ok: false, error: '口令不对' });
      }
      const sid = createSession();
      res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
      return send(res, 200, { ok: true });
    }

    /* 以下全部需要登录 */
    if (u.pathname.startsWith('/api/') && !authed(req)) return send(res, 401, { ok: false, error: '未登录' });

    if (u.pathname === '/api/bootstrap') {
      const cfg = getConfig();
      return send(res, 200, {
        ok: true,
        noAuth: NO_AUTH,
        employees: listEmployees(),
        tasks: listTasks().map(t => ({
          id: t.id, title: t.title, status: t.status, employeeName: t.employeeName,
          createdAt: t.createdAt, tokens: t.tokens, ms: t.ms
        })),
        personas: PERSONAS,
        presets: PRESETS,
        config: {
          provider: { ...cfg.provider, apiKey: cfg.provider.apiKey ? '••••••' + String(cfg.provider.apiKey).slice(-4) : '' },
          hasKey: !!cfg.provider.apiKey,
          permissions: cfg.permissions,
          workspace: cfg.workspace,
          maxSteps: cfg.maxSteps,
          budgetCNY: cfg.budgetCNY,
          priceIn: cfg.priceIn,
          priceOut: cfg.priceOut
        }
      });
    }

    if (u.pathname === '/api/config' && req.method === 'POST') {
      const b = await readBody(req);
      const cur = getConfig();
      const patch = {};
      if (b.provider) {
        patch.provider = { ...b.provider };
        if (!b.provider.apiKey || b.provider.apiKey.includes('••')) {
          patch.provider.apiKey = cur.provider.apiKey; // 前端回显的掩码不要覆盖真 Key
        }
      }
      if (b.permissions) patch.permissions = b.permissions;
      if (b.maxSteps) patch.maxSteps = Math.min(Math.max(1, Number(b.maxSteps)), 24);
      if (b.budgetCNY !== undefined) patch.budgetCNY = Math.max(0, Number(b.budgetCNY) || 0);
      if (b.priceIn !== undefined) patch.priceIn = Math.max(0, Number(b.priceIn) || 0);
      if (b.priceOut !== undefined) patch.priceOut = Math.max(0, Number(b.priceOut) || 0);
      const next = saveConfig(patch);
      return send(res, 200, { ok: true, permissions: next.permissions, provider: { ...next.provider, apiKey: '' } });
    }

    if (u.pathname === '/api/employees' && req.method === 'POST') {
      const b = await readBody(req);
      const name = String(b.name || '').trim();
      if (!name) return send(res, 400, { ok: false, error: '名字不能为空' });
      const list = listEmployees();
      const emp = {
        id: 'e' + crypto.randomBytes(4).toString('hex'),
        name, role: String(b.role || '助理').trim() || '助理',
        persona: PERSONAS[b.persona] ? b.persona : 'mature',
        model: String(b.model || '').trim(),
        notes: String(b.notes || '').trim().slice(0, 800),
        createdAt: Date.now()
      };
      list.push(emp);
      saveEmployees(list);
      return send(res, 200, { ok: true, employee: emp });
    }

    if (u.pathname.startsWith('/api/employees/')) {
      const id = u.pathname.split('/').pop();
      const list = listEmployees();
      const i = list.findIndex(e => e.id === id);
      if (i < 0) return send(res, 404, { ok: false, error: '员工不存在' });
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        ['name', 'role', 'model', 'notes'].forEach(k => { if (b[k] !== undefined) list[i][k] = String(b[k]).slice(0, 800); });
        if (PERSONAS[b.persona]) list[i].persona = b.persona;
        saveEmployees(list);
        return send(res, 200, { ok: true, employee: list[i] });
      }
      if (req.method === 'DELETE') {
        list.splice(i, 1);
        saveEmployees(list);
        return send(res, 200, { ok: true });
      }
    }

    if (u.pathname === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const goal = String(b.goal || '').trim();
      if (!goal) return send(res, 400, { ok: false, error: '目标不能为空' });
      const emps = listEmployees();
      const emp = emps.find(e => e.id === b.employeeId) || emps[0];
      if (!emp) return send(res, 400, { ok: false, error: '还没有员工，先创建一个' });
      const tasks = listTasks();
      const deliverables = Array.isArray(b.deliverables)
        ? b.deliverables.map(s => String(s).trim()).filter(Boolean).slice(0, 20)
        : [];
      const task = {
        id: 't' + Date.now().toString(36),
        title: String(b.title || goal.split('\n')[0].slice(0, 40)).trim(),
        goal,
        deliverables,
        employeeId: emp.id, employeeName: emp.name, employeeRole: emp.role,
        status: 'queued', steps: [], result: '', tokens: { in: 0, out: 0 },
        createdAt: Date.now(), ms: 0
      };
      tasks.unshift(task);
      saveTasks(tasks);
      return send(res, 200, { ok: true, task });
    }

    if (u.pathname.startsWith('/api/tasks/')) {
      const parts = u.pathname.split('/').filter(Boolean); // api tasks id run
      const id = parts[2];
      const tasks = listTasks();
      const task = tasks.find(t => t.id === id);
      if (!task) return send(res, 404, { ok: false, error: '任务不存在' });

      if (req.method === 'GET' && parts.length === 3) return send(res, 200, { ok: true, task });

      if (req.method === 'DELETE') {
        saveTasks(tasks.filter(t => t.id !== id));
        return send(res, 200, { ok: true });
      }

      if (req.method === 'POST' && parts[3] === 'run') {
        const cfg = getConfig();
        const emp = listEmployees().find(e => e.id === task.employeeId) || { name: '助理', role: '助理', persona: 'mature' };

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        const sendEv = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

        // 默认重跑；带 {resume:true} 则接着上一轮的上下文走
        let body = {};
        try { body = await readBody(req); } catch { /* 无 body 即重跑 */ }
        const resuming = body && body.resume === true && Array.isArray(task.messages);
        task.steps = []; task.result = ''; task.status = 'running'; task.blockedOn = null;
        if (!resuming) { task.messages = null; task.tokens = { in: 0, out: 0 }; }
        sendEv({ t: 'start', taskId: task.id, resume: !!resuming, employee: { name: emp.name, role: emp.role, model: emp.model || cfg.provider.model } });

        await runTask(task, emp, cfg, sendEv, t => {
          const all = listTasks();
          const i = all.findIndex(x => x.id === t.id);
          if (i >= 0) { all[i] = t; saveTasks(all); }
        });
        res.end();
        return;
      }
    }

    send(res, 404, { ok: false, error: 'no route' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { ok: false, error: e.message });
    else try { res.end(); } catch { /* ignore */ }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const cfg = getConfig();
  const base = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  Boss Agent 内核 v0.1 已启动');
  console.log('  ────────────────────────────────────────────');
  console.log('  打开：  ' + (NO_AUTH ? `http://localhost:${PORT}` : base));
  console.log('  口令：  ' + (NO_AUTH ? '已关闭（免口令模式）' : TOKEN));
  console.log('  工作区：' + cfg.workspace);
  console.log('  模型：  ' + (cfg.provider.preset === 'mock' || !cfg.provider.baseURL
    ? '离线 Mock（在设置里换成真实基座）'
    : cfg.provider.baseURL + ' · ' + cfg.provider.model));
  console.log('  数据：  ' + DATA_DIR);
  if (NO_AUTH) {
    console.log('');
    console.log('  ⚠ 免口令模式：任何能访问 127.0.0.1 的程序都能直接操作这个内核。');
    console.log('    自己一个人用没问题，一旦要分享、或装到别人机器上，去掉 --no-auth。');
  }
  console.log('');
});
