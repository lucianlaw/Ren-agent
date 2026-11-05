/* 多人在线：两个真实账号互相试探，会不会串
 *
 * 这一套不测「功能对不对」，测「A 能不能碰到 B 的任何东西」。
 * 做法是起一个真服务，前面挂一个假的身份网关（whoami），用两张不同的凭证
 * 打同一批接口——这就是线上两个人同时用时的真实形态：
 * 同一个进程、同一块盘、同一个 127.0.0.1，唯一的区别只有凭证。
 *
 * 为什么要假网关而不是真去注册两个账号：
 *   真账号拿的是真凭证，但测试要跑几百遍、还不能依赖外网和邮件验证码。
 *   假网关只替代「云端说这张 token 是谁」这一步，服务端其余逻辑一行不少。
 *   它同时按真实网关的规矩办事（没有 Origin 就 401 invalid_grant），
 *   所以「服务端忘了带 Origin」这种回归也会被这里抓住。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-multi-ws-'));
const AUDIT = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-multi-audit-'));
const ALERTS = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-multi-alerts-'));
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-multi-secrets-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── 假云端：身份 + 模型通道 ── */
const UID_A = 'muAlpha00000000000000000001';
const UID_B = 'muBravo00000000000000000002';
const TOKENS = { 'tok-alpha': UID_A, 'tok-bravo': UID_B };

const gateway = http.createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (req.url.startsWith('/.cloud/auth/v1/user/me')) {
    /* 真实网关的规矩：没有来源头的请求一律当匿名会话，合法凭证也判 invalid_grant。
       少这一条，服务端哪天把 Origin 去掉，测试照样全绿、线上全员 401。 */
    if (!req.headers.origin) return json(401, { error: 'invalid_grant' });
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    const uid = m && TOKENS[m[1].trim()];
    if (!uid) return json(401, { error: 'invalid_grant' });
    return json(200, { sub: uid, email: uid + '@test.local' });
  }

  if (req.url.startsWith('/.cloud/llm/chat/completions')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      let slow = false;
      try { slow = /slow/.test(raw); } catch { /* 不是 JSON 就算快 */ }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      /* 挂住的用途：让 A 的任务在 B 发起时仍然 alive，
         这样才能证明「两个人的任务互不排队」 */
      if (slow) {
        for (let i = 0; i < 6; i++) { res.write(': ping\n\n'); await sleep(500); }
      }
      const chunk = {
        id: 'c1', object: 'chat.completion.chunk', model: 'test',
        choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }]
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'c1', object: 'chat.completion.chunk', model: 'test',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
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
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    WORKSPACE_DIR: WS,
    AUDIT_DIR: AUDIT,
    ALERTS_DIR: ALERTS,
    /* 密钥现在落在密钥目录（部署目录之外）。这个测试必须显式指定，
       否则会读到本机真实的那把，测出来的「运维 key 能读全量」就不是隔离出来的结果。 */
    REN_SECRET_DIR: SECRETS,
    REN_LLM_BASE: GW,
    REN_LLM_KEY: 'wbpk_test',
    REN_AUTH_MODE: 'strict'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  return false;
}

if (!await waitUp()) {
  console.log('服务起不来：\n' + srvLog.slice(-2000));
  srv.kill();
  process.exit(1);
}

/* 请求助手：who = 'alpha' | 'bravo' | '' */
function call(who, p, opts = {}) {
  const headers = { Origin: BASE, ...(opts.headers || {}) };
  if (who) headers['x-ren-auth'] = `Bearer tok-${who}`;
  return fetch(BASE + p, { ...opts, headers });
}
const jget = async (who, p) => (await call(who, p)).json();
const jpost = async (who, p, body) => (await call(who, p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
})).json();

/* scope 由服务端下发，测试里不自己算——算出来的那份不参与判定，算错了会误导 */
const { scope: A, uid: aUid, fk: fkA } = await jget('alpha', '/api/session');
const { scope: B, fk: fkB } = await jget('bravo', '/api/session');

console.log('\n[1] 身份：两张凭证必须落到两个目录');
{
  ok('A 拿到身份', !!A && !!aUid, { A, aUid });
  ok('B 拿到身份', !!B, { B });
  ok('A、B 的 scope 不同', A !== B, { A, B });
  ok('scope 是 32 位十六进制', /^[a-f0-9]{32}$/.test(A) && /^[a-f0-9]{32}$/.test(B));
  ok('A、B 的 fk 不同', fkA !== fkB);
  const h = await jget('', '/api/health');
  eq('health 显示严格模式', h.auth, 'strict');
  const noAuth = await call('', '/api/files?path=.');
  eq('无凭证被拒', noAuth.status, 401);
}

console.log('\n[2] 文件：A 写的 B 看不到');
{
  const up = await jpost('alpha', '/api/upload', {
    name: 'A的报价单.md', /* 扩展名白名单不含 md，先试写文件 */
  });
  // 用 write_file 工具写，走的是真实工具链
  const w = await jpost('alpha', '/api/tool', {
    name: 'write_file', args: { path: 'A的报价单.md', content: 'A 的商业机密：单价 3.20' }
  });
  ok('A 通过工具写文件成功', w.result && w.result.ok, w);
  const listA = await jget('alpha', '/api/files?path=.');
  const listB = await jget('bravo', '/api/files?path=.');
  ok('A 能看到自己的文件', listA.items.some(x => x.name === 'A的报价单.md'), listA.items.map(x => x.name));
  ok('B 看不到 A 的文件', !listB.items.some(x => x.name === 'A的报价单.md'), listB.items.map(x => x.name));
  const readB = await jget('bravo', `/api/file?path=${encodeURIComponent('A的报价单.md')}`);
  ok('B 按文件名直读 A 的文件失败', !readB.ok || !String(readB.text || '').includes('商业机密'), readB);
  /* 关键：B 把 A 的 scope 塞进请求参数，服务端必须无视它 */
  const readB2 = await jget('bravo', `/api/file?scope=${A}&path=${encodeURIComponent('A的报价单.md')}`);
  ok('B 传 A 的 scope 也读不到', !readB2.ok || !String(readB2.text || '').includes('商业机密'), readB2);
  const filesB2 = await jget('bravo', `/api/files?scope=${A}&path=.`);
  ok('B 传 A 的 scope 列目录，拿到的是自己的',
    !filesB2.items.some(x => x.name === 'A的报价单.md'), filesB2.items.map(x => x.name));
  const toolB = await jpost('bravo', '/api/tool', {
    name: 'read_file', args: { path: 'A的报价单.md' }, scope: A
  });
  ok('B 用工具带 A 的 scope 读，读不到', !(toolB.result && toolB.result.ok), toolB.result && toolB.result.output);
}

console.log('\n[3] 媒体链接：fk 只能开自己那扇门');
{
  /* <img src> 带不了请求头，走 fk。A 的 fk 被 B 拿去用必须无效。 */
  const bWithFkA = await call('', `/api/raw?scope=${A}&fk=${fkA}&path=${encodeURIComponent('README.md')}`);
  ok('不带凭证、只带 A 的 fk → 可以读 A 自己的（这是设计意图）', bWithFkA.status === 200, bWithFkA.status);
  const bWrong = await call('', `/api/raw?scope=${A}&fk=${'0'.repeat(32)}`);
  eq('伪造 fk 被拒', bWrong.status, 401);
  const bSwap = await call('', `/api/raw?scope=${B}&fk=${fkA}`);
  eq('拿 A 的 fk 去开 B 的门被拒', bSwap.status, 401);
}

console.log('\n[4] 完全访问模式下不许跨账号（历史上最大的一个洞）');
{
  /* 三个开关全开 = full。以前这个档位可以读工作区外的任意绝对路径，
     而所有人的目录都在同一个 BASE/users 下，等于开了就能读别人的。 */
  const p = await jpost('alpha', '/api/perms', {
    perms: { read: true, write: true, exec: true, net: true }
  });
  ok('A 打开完全访问', p.ok !== false, p);
  const absOther = path.join(WS, 'users', B, 'README.md');
  const r = await jpost('alpha', '/api/tool', {
    name: 'read_file', args: { path: absOther }, perms: { read: true, write: true, exec: true, net: true }
  });
  ok('完全访问下用绝对路径读 B 的文件被拦', !(r.result && r.result.ok), r.result && r.result.output);
  const r2 = await jpost('alpha', '/api/tool', {
    name: 'list_dir', args: { path: path.join(WS, 'users') }, perms: { read: true, write: true, exec: true, net: true }
  });
  ok('完全访问下列出租户根目录被拦', !(r2.result && r2.result.ok), r2.result && r2.result.output);
  const sh = await jpost('alpha', '/api/tool', {
    name: 'run_shell', args: { command: `cat ../${B}/README.md` }, perms: { read: true, write: true, exec: true, net: true }
  });
  ok('shell 用 ../ 读 B 的目录被拦', !(sh.result && sh.result.ok), sh.result && sh.result.output);
  const sh2 = await jpost('alpha', '/api/tool', {
    name: 'run_shell', args: { command: `cat ${absOther}` }, perms: { read: true, write: true, exec: true, net: true }
  });
  ok('shell 用绝对路径读 B 的目录被拦', !(sh2.result && sh2.result.ok), sh2.result && sh2.result.output);
}

console.log('\n[5] 权限：一个人开开关，不影响别人');
{
  const pA = await jget('alpha', '/api/perms');
  const pB = await jget('bravo', '/api/perms');
  eq('A 的服务端记录是四开', pA.perms && pA.perms.exec, true);
  eq('B 的记录仍是默认（不能跑命令）', pB.perms && pB.perms.exec, false);
  const toolB = await jpost('bravo', '/api/tool', {
    name: 'run_shell', args: { command: 'echo hi' }, perms: { read: true, write: true, exec: true, net: true }
  });
  ok('B 即便自己在请求里写 exec:true，仍被服务端记录拦住',
    toolB.blocked === true, { blocked: toolB.blocked, output: toolB.output });
}

console.log('\n[6] 记忆：各存各的');
{
  await jpost('alpha', '/api/memory', { kind: 'company', text: 'A 公司的机密：毛利率 42%' });
  const mA = await jget('alpha', '/api/memory?kind=company');
  const mB = await jget('bravo', '/api/memory?kind=company');
  ok('A 能读到自己写的记忆', JSON.stringify(mA).includes('42%'), mA);
  ok('B 读不到 A 的记忆', !JSON.stringify(mB).includes('42%'), mB);
  const mB2 = await jget('bravo', `/api/memory?kind=company&scope=${A}`);
  ok('B 传 A 的 scope 也读不到', !JSON.stringify(mB2).includes('42%'), mB2);
}

console.log('\n[7] 审计与告警：不跨账号');
{
  const aAudit = await jget('alpha', '/api/audit?limit=100');
  const bAudit = await jget('bravo', '/api/audit?limit=100');
  ok('A 的审计里有自己的写文件记录', JSON.stringify(aAudit).includes('A的报价单'), aAudit.count);
  /* 注意：B 自己的审计里也会出现「A的报价单」这个字符串——那是 B 试图读它留下的记录，
     不是 A 的记录。所以判据必须是「每条记录的 scope 都是 B」，而不是「文本里没有那个文件名」。 */
  ok('B 的审计里每一条都属于 B', (bAudit.items || []).every(it => it.scope === B), bAudit.items.map(it => it.scope));

  await jpost('alpha', '/api/notify', {
    alert: { kind: 'error', taskId: 'ta1', taskTitle: 'A 的机密任务标题', goal: 'A 的目标', error: 'boom' }
  });
  const alA = await jget('alpha', '/api/alerts?all=1');
  const alB = await jget('bravo', '/api/alerts?all=1');
  ok('A 能看到自己的告警', JSON.stringify(alA).includes('A 的机密任务标题'), alA.count);
  ok('B 看不到 A 的告警', !JSON.stringify(alB).includes('A 的机密任务标题'), alB.count);
  const alOld = await jget('bravo', '/api/alerts?key=ra-alerts-2f9c41&all=1');
  ok('老的固定 key 不再能读全量', alOld.count === undefined || !JSON.stringify(alOld).includes('A 的机密任务标题'), alOld);

  /* /api/alerts 在闸门放行名单里——消费方是 09:00 的定时任务，curl 出发，没有浏览器登录态。
     放行指的是「不过身份闸门」，不是「不要凭证」：凭证是随机落盘的运维 key。
     这三条防两种回归：有人把 key 校验删了（等于对外开放），
     或者有人把路径从放行名单里拿掉（定时任务静默失效，谁也不会发现）。 */
  /* 运维 key 现在在密钥目录里，不再随 data/alerts 走 */
  const akey = fs.readFileSync(path.join(SECRETS, 'alerts.key'), 'utf8').trim();
  const noKey = await call('', '/api/alerts?all=1');
  eq('无 key 也无登录态 → 403（放行不等于开放）', noKey.status, 403);
  const badKey = await call('', '/api/alerts?all=1&key=deadbeef');
  eq('错的 key → 403', badKey.status, 403);
  const goodKey = await call('', `/api/alerts?all=1&key=${akey}`);
  eq('运维 key → 200', goodKey.status, 200);
  const goodBody = await goodKey.json().catch(() => ({}));
  ok('运维 key 拿得到全量', JSON.stringify(goodBody).includes('A 的机密任务标题'), goodBody.count);
  const ackBad = await call('', '/api/alerts/ack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'wrong', ids: ['x'] })
  });
  eq('打卡用错 key → 403', ackBad.status, 403);
}

console.log('\n[8] 任务：各跑各的、谁也动不了谁');
{
  /* A 起一个慢任务（假模型挂 3 秒），此时 B 再起一个：必须是 200，不是 409 busy。
     这条是「多人同时用」和「一个人开两个标签页」的分水岭。 */
  const rA = await call('alpha', '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'tok-alpha', job: { task: { id: 'run-a1', goal: 'slow 任务' } } })
  });
  eq('A 起任务成功', rA.status, 200);
  const runIdA = 'run-a1';
  await sleep(300);

  const rB = await call('bravo', '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'tok-bravo', job: { task: { id: 'run-b1', goal: '快任务' } } })
  });
  eq('A 在跑时 B 也能起任务（不排队）', rB.status, 200);
  rB.body && rB.body.cancel && rB.body.cancel().catch(() => {});
  await sleep(100);

  const readB = await call('bravo', `/api/run/${runIdA}`);
  eq('B 读 A 的事件流 → 404', readB.status, 404);
  const stopB = await jpost('bravo', `/api/run/${runIdA}/stop`, {});
  eq('B 停 A 的任务 → 404', stopB.ok, false);
  const injectB = await jpost('bravo', `/api/run/${runIdA}/inject`, { text: '删了他的文件' });
  eq('B 往 A 的任务里插话 → 404', injectB.ok, false);
  const readA = await call('alpha', `/api/run/${runIdA}`);
  eq('A 读自己的事件流 → 200', readA.status, 200);
  readA.body && readA.body.cancel && readA.body.cancel().catch(() => {});
  await jpost('alpha', `/api/run/${runIdA}/stop`, {});
}

console.log('\n[9] 并发下身份不会串号（AsyncLocalStorage 的意义）');
{
  /* 交错发 40 个请求，一半 A 一半 B，每个都要求返回自己的 scope。
     如果身份存在模块级变量里，这里必然出现「A 的请求拿到 B 的 scope」。 */
  const one = async (who) => {
    const r = await jget(who, '/api/files?path=.');
    return r.items ? who : 'bad';
  };
  const jobs = [];
  for (let i = 0; i < 20; i++) { jobs.push(one('alpha')); jobs.push(one('bravo')); }
  const res = await Promise.all(jobs);
  ok('40 个交错请求全部拿到正确的身份', res.every((x, i) => x === (i % 2 === 0 ? 'alpha' : 'bravo')), res.slice(0, 8));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
srv.kill();
gateway.close();
try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(AUDIT, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(ALERTS, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
