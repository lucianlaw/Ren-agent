/* 同账号多设备并发：在真服务上验「能同时跑」和「不会互相覆盖」
 *
 * 上一版的行为是：一个账号同时只能有一个任务（LIVE_BY_SCOPE 按 scope 判忙），
 * 手机和电脑第二个必拿 409。这一版把判据换成「scope + 设备」，
 * 于是同一台设备仍然互斥，不同设备可以并行。
 *
 * 但「放开」只是第一步。真正要证明的是三件事：
 *   1. 两台设备真的能同时跑（不是接口放行了、内部还排队）
 *   2. 同一台设备仍然只能一个（不然双击两下就两个任务改同一份文件）
 *   3. 重启之后还算数：正在跑的要变「中断」，不是永远转圈
 *
 * 用假网关 + 慢模型把任务拖住，才有「同时」可言。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-multi-'));
const WS = path.join(TMP, 'ws');
const STATE = path.join(TMP, 'state');
const SECRETS = path.join(TMP, 'secrets');
for (const d of [WS, STATE, SECRETS]) fs.mkdirSync(d, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UID = 'qaUser0000000000000000000001';
const STAFF = { id: 's1', name: '小张', persona: 'mature', role: '助理' };

/* 慢模型：每次响应拖 4 秒。任务一次模型调用就收工，所以 4 秒就是它的全部寿命。
   必须比测试里这一串断言加起来更长，否则每次去查的时候它已经结束了——
   而「已经结束」会让所有并发断言看起来都通过（假绿），这是这类测试最常见的坑。 */
const gateway = http.createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith('/.cloud/auth/v1/user/me')) {
    if (!req.headers.origin) return json(401, { error: 'invalid_grant' });
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m || m[1].trim() !== 'tok-qa') return json(401, { error: 'invalid_grant' });
    return json(200, { sub: UID, email: 'qa@test.local' });
  }
  if (req.url.startsWith('/.cloud/llm/chat/completions')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          id: 'c1', object: 'chat.completion.chunk', model: 'test',
          choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'c1', object: 'chat.completion.chunk', model: 'test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2 }
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 4000);
    });
    return;
  }
  json(404, { error: 'not_found' });
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

await new Promise(r => gateway.listen(0, '127.0.0.1', r));
const GW = `http://127.0.0.1:${gateway.address().port}`;

let srv = null;
let srvLog = '';
function startServer(port) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      WORKSPACE_DIR: WS,
      REN_STATE_DIR: STATE,
      /* 拉起来的 server.js 不是 test 入口，lib/testdir.js 的测试兜底对它不生效，
         不指到这里就会写进项目真实的 data/ */
      AUDIT_DIR: path.join(TMP, 'audit'),
      INCIDENT_DIR: path.join(TMP, 'incidents'),
      TICKET_DIR: path.join(TMP, 'tickets'),
      PROOF_DIR: path.join(TMP, 'proofs'),
      REN_SECRET_DIR: SECRETS,
      REN_LLM_BASE: GW,
      REN_LLM_KEY: 'wbpk_test',
      REN_AUTH_MODE: 'strict',
      REN_BACKUP_DIR: path.join(TMP, 'bk'),
      REN_BACKUP_HOURS: '999',
      REN_BACKUP_FIRST_MS: '999999',
      /* 只在这个测试里把「判死」窗口压到 0：重启后要立刻看到收尸结果。
         真实环境里这两个值是 20 秒 / 90 秒，调小会误杀还活着的进程。 */
      REN_STATE_PID_GRACE_MS: '0',
      REN_STATE_STALE_MS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srvLog = '';
  p.stdout.on('data', d => { srvLog += d; });
  p.stderr.on('data', d => { srvLog += d; });
  return p;
}

async function waitUp(port) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  return false;
}

let PORT = await freePort();
let BASE = `http://127.0.0.1:${PORT}`;
srv = startServer(PORT);
if (!await waitUp(PORT)) {
  console.error('服务没起来：\n' + srvLog);
  process.exit(1);
}

const H = { Origin: BASE, 'Content-Type': 'application/json' };
const AUTH = { ...H, 'x-ren-auth': 'Bearer tok-qa' };

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}

/* 发起任务必须单独一个函数：/api/run 成功时返回的是 SSE 流，
   用 r.json() 去读会一直等到任务结束——那时「有没有并发」早就没意义了，
   而所有并发断言都会因为「任务已经跑完」而假绿。所以只取状态码，然后主动取消流。 */
async function startRun(body) {
  const r = await fetch(BASE + '/api/run', { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
  const ct = String(r.headers.get('content-type') || '');
  let j = null;
  if (ct.includes('application/json')) {
    j = await r.json().catch(() => null);
  } else {
    try { await r.body.cancel(); } catch { /* 已经结束 */ }
  }
  return { status: r.status, body: j };
}
async function get(p) {
  const r = await fetch(BASE + p, { headers: AUTH });
  let j = null;
  try { j = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: j };
}

const job = (id, goal) => ({
  token: 'tok-qa', staff: STAFF,
  task: { id, goal },
  settings: { permissions: { read: true, write: true, exec: false }, maxSteps: 3 }
});

console.log('\n[1] 前置：拿到 scope');
{
  const s = await get('/api/session');
  ok('会话可用', s.status === 200 && !!s.body.scope, s.body);
}

console.log('\n[2] 两台设备可以同时跑');
let runA, runB;
{
  runA = await startRun({ ...job('run-A', '电脑上的任务'), device: 'dev-macbook' });
  eq('设备 A 起任务：200', runA.status, 200);
  await sleep(400);

  runB = await startRun({ ...job('run-B', '手机上的任务'), device: 'dev-phone' });
  eq('设备 B 起任务：不被 409 拦（这正是这次改的东西）', runB.status, 200);
  if (runB.status !== 200) console.log('    → ' + JSON.stringify(runB.body));
}

console.log('\n[3] 同一台设备仍然只能一个');
{
  const again = await startRun({ ...job('run-A2', '同一台设备又来一个'), device: 'dev-macbook' });
  eq('设备 A 再起一个：409', again.status, 409);
  eq('错误码是 busy', again.body && again.body.code, 'busy');
  ok('提示说清了是「这台设备」', /这台设备/.test(String(again.body && again.body.error)), again.body);

  /* 没有设备标识的老客户端：退回按账号锁。此时账号里已经有两个在跑，
     按账号锁必然拿不到——它是被 409 挡住，而不是被放行成第三个。 */
  const noDev = await startRun({ ...job('run-legacy', '老页面') });
  eq('不带设备标识：按账号锁，仍然 409', noDev.status, 409);
}

console.log('\n[4] 状态面板看得见两个');
{
  const r = await get('/api/runs');
  eq('接口可用', r.status, 200);
  const runs = (r.body && r.body.runs) || [];
  const devices = runs.map(x => x.device);
  ok('能看到设备 A 的任务', devices.includes('dev-macbook'), devices);
  ok('能看到设备 B 的任务', devices.includes('dev-phone'), devices);
  eq('说得出有几个在跑', r.body.running, 2);
}

console.log('\n[5] 重启：中断的任务要被标记，不是永远转圈');
{
  /* SIGKILL：模拟部署/崩溃，不给它写收尾的机会 */
  srv.kill('SIGKILL');
  await sleep(300);

  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  srv = startServer(PORT);
  if (!await waitUp(PORT)) {
    console.error('重启没起来：\n' + srvLog);
    process.exit(1);
  }

  const r = await fetch(BASE + '/api/runs', {
    headers: { Origin: BASE, 'x-ren-auth': 'Bearer tok-qa' }
  });
  const j = await r.json();
  const runs = j.runs || [];
  ok('任务记录跨重启还在（不是内存里的东西）', runs.length >= 2, runs.length);

  const ghost = runs.find(x => x.id === 'run-A');
  ok('重启前在跑的任务被标成中断', ghost && ghost.status === 'interrupted', ghost);
  ok('给出中断原因', ghost && /中断/.test(ghost.reason || ''), ghost && ghost.reason);
  eq('重启后没有还在跑的', j.running, 0);

  /* 断线重连要能拿到「中断」而不是「没有这个任务」 */
  const one = await fetch(BASE + '/api/run/run-A', {
    headers: { Origin: BASE, 'x-ren-auth': 'Bearer tok-qa' }
  });
  eq('查中断的任务返回 410', one.status, 410);
  const oj = await one.json().catch(() => ({}));
  eq('code 是 interrupted', oj.code, 'interrupted');
  ok('带一句人话', /中断/.test(String(oj.error)), oj);
}

console.log('\n[6] 重启后可以重新起任务（锁没有残留）');
{
  const again = await startRun({ ...job('run-A3', '重启后再来一次'), device: 'dev-macbook' });
  eq('同一台设备重新可用', again.status, 200);
  if (again.status !== 200) console.log('    → ' + JSON.stringify(again.body));
}

srv.kill('SIGKILL');
try { gateway.close(); } catch { /* ignore */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
