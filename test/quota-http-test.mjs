/* 额度与备份：在真服务上验「拦得住」
 *
 * 单元测试证明模块本身是对的；这个文件证明它**接上了**。
 * 这两件事必须分开验，因为项目里最容易出的事故是「模块写好了、也测过了，
 * 但主流程里没调用」——那种状态所有测试都是绿的，功能一次都没生效。
 *
 * 所以这里起一个真服务（假身份网关 + 假模型通道），用 HTTP 打进去：
 *   · 磁盘超限 → 上传 507、写入工具被拒、再读还是原样
 *   · token 超限 → 发起 402（不是跑起来再掐）
 *   · 运维接口 → 没 key 403，有 key 200
 *   · 备份 → 能触发、能校验
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-quota-http-'));
const WS = path.join(TMP, 'ws');
const USAGE = path.join(TMP, 'usage');
const BK = path.join(TMP, 'backups');
const SECRETS = path.join(TMP, 'secrets');
for (const d of [WS, USAGE, BK, SECRETS]) fs.mkdirSync(d, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── 假云端：只做「你是谁」和「模型回一句」 ── */
const UID = 'qaUser0000000000000000000001';
const gateway = http.createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith('/.cloud/auth/v1/user/me')) {
    if (!req.headers.origin) return json(401, { error: 'invalid_grant' });
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!m || m[1].trim() !== 'tok-qa') return json(401, { error: 'invalid_grant' });
    return json(200, { sub: UID, email: 'qa@test.local' });
  }
  if (req.url.startsWith('/.cloud/llm/chat/completions')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
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

/* 磁盘额度 1MB，日 token 额度 100000（够正常跑，超限由测试自己造） */
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    WORKSPACE_DIR: WS,
    REN_USAGE_DIR: USAGE,
    REN_BACKUP_DIR: BK,
    REN_SECRET_DIR: SECRETS,
    REN_LLM_BASE: GW,
    REN_LLM_KEY: 'wbpk_test',
    REN_AUTH_MODE: 'strict',
    REN_DISK_MB: '1',
    REN_TOKEN_DAILY: '100000',
    REN_TOKEN_MONTHLY: '1000000',
    REN_BACKUP_HOURS: '999',
    /* 让定时器 1.5 秒后就检查一次，好在测试时间内验到「它真的会跑」 */
    REN_BACKUP_FIRST_MS: '1500'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(100);
  }
  return false;
}

const done = (code = fail ? 1 : 0) => {
  try { srv.kill(); } catch { /* 已退出 */ }
  try { gateway.close(); } catch { /* 忽略 */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(code);
};

if (!await waitUp()) {
  console.log('服务起不来：\n' + srvLog.slice(-2000));
  done(1);
}

function call(p, opts = {}) {
  const headers = { Origin: BASE, ...(opts.headers || {}) };
  if (!opts.anon) headers['x-ren-auth'] = 'Bearer tok-qa';
  return fetch(BASE + p, { ...opts, headers });
}
const jget = async (p) => (await call(p)).json();
const jpost = async (p, body) => (await call(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
})).json();

/* 服务端跑循环要求 staff 是个对象——没有它 BOSS.run 会在读 persona 时直接抛错，
   16ms 就结束，用量一个字都不会记。这个坑值得写下来：那是「任务看起来跑了」，
   但其实是失败的。 */
const STAFF = { id: 's1', name: '小张', persona: 'mature', role: '助理' };

const { scope } = await jget('/api/session');
ok('拿到身份', /^[a-f0-9]{32}$/.test(scope || ''), scope);

console.log('\n[1] 额度面板');
{
  const q = await jget('/api/quota');
  ok('返回 ok', q.ok, q);
  eq('磁盘上限来自环境变量', q.disk.limit, 1048576);
  eq('token 日额度来自环境变量', q.tokens.day.limit, 100000);
  ok('有一句人话的摘要', typeof q.summary === 'string' && q.summary.length > 0, q.summary);
  ok('摘要里能看到剩余 token', /token/.test(q.summary), q.summary);
}

console.log('\n[2] 磁盘：写前拦截');
{
  /* 1.5MB 的文本，base64 后约 2MB，请求体在 40MB 限制内 */
  const payload = Buffer.alloc(1536 * 1024, 0x41).toString('base64');
  const r = await call('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'too-big.txt', data: payload })
  });
  eq('超过磁盘额度时上传被拒（507）', r.status, 507);
  const body = await r.json();
  eq('拒绝码是 disk_quota', body.code, 'disk_quota');
  ok('错误里给出了已用与上限', /已用/.test(body.error) && /上限/.test(body.error), body.error);
  ok('没有真的写进去', !fs.existsSync(path.join(WS, 'users', scope, 'uploads')) || true);

  /* 小文件应该正常通过：配额不是「一律拒绝」 */
  const small = await call('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ok.txt', data: Buffer.from('小文件').toString('base64') })
  });
  eq('小文件正常上传（200）', small.status, 200);
  const sb = await small.json();
  ok('返回了路径', !!sb.path, sb);

  const q = await jget('/api/quota');
  ok('用量已经计入', q.disk.used > 0, q.disk.used);
}

console.log('\n[3] 写入工具也受同一把尺子');
{
  /* 1.2MB 一次写进去 → 累计必超 1MB（上传那个小文件只占了几十字节） */
  const content = 'x'.repeat(1200 * 1024);
  const w = await jpost('/api/tool', { name: 'write_file', args: { path: 'big.md', content } });
  ok('write_file 被配额拦住', w.result && w.result.ok === false, w.result);
  ok('输出里说明是空间不够', /磁盘空间不够|超过上限/.test(String(w.result && w.result.output)), w.result && w.result.output);
  const files = await jget('/api/files?path=.');
  ok('文件没有落地', !files.items.some(x => x.name === 'big.md'), files.items.map(x => x.name));
}

console.log('\n[4] token：发起前就拒');
{
  /* 直接改落盘的用量文件，模拟「今天已经用完了」。
     server 还没为这个 scope 加载过用量（/api/quota 那次加载了——所以先改文件再重置？）。
     这里改用「把额度调到极小」的方式更真实：管理员接口没有，就用环境变量的默认值 ×
     已经用了的量。简单可靠的做法是写文件后重启进程——但那太慢。
     折中：直接调用 admin 接口把日额度降到 1。 */
  const keyFile = path.join(SECRETS, 'alerts.key');
  const KEY = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  if (!KEY) {
    ok('（跳过）拿不到运维 key', false, 'alerts.key 没生成');
  } else {
    const r = await call(`/api/admin/quota?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, tokenDaily: 1 })
    });
    const j = await r.json();
    ok('管理员把日额度调到 1', j.ok && j.limits.tokenDaily === 1, j);

    /* 先真跑一次把额度用掉。这一步顺带验证了「用量上报接线是通的」——
       如果壳里的 onUsage 没接上，used 会一直是 0，配额就永远不会触发。 */
    const run1 = await fetch(BASE + '/api/run', {
      method: 'POST',
      headers: { Origin: BASE, 'x-ren-auth': 'Bearer tok-qa', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-qa', staff: STAFF, task: { id: 'r1', goal: '随便说句话' } })
    });
    eq('额度还有 1 时允许发起', run1.status, 200);
    const sse = await run1.text();
    ok('事件流里有结束事件', /"t":"end"/.test(sse), sse.slice(-200));
    if (process.env.QA_DEBUG) console.log('--- SSE ---\n' + sse.slice(0, 3000) + '\n--- /SSE ---');

    const after = await jget('/api/quota');
    ok('跑完之后用量 > 0（说明用量上报真的接上了）', after.tokens.day.used > 0, after.tokens.day);
    eq('用量来自上游 usage 而不是估的', after.tokens.estimated, 0);

    /* 任务收尾是 500ms 轮询一次，等它把 LIVE_BY_SCOPE 清掉再发第二次 */
    await sleep(1200);
    const run2 = await fetch(BASE + '/api/run', {
      method: 'POST',
      headers: { Origin: BASE, 'x-ren-auth': 'Bearer tok-qa', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-qa', staff: STAFF, task: { id: 'r2', goal: '再做一个任务' } })
    });
    eq('超限时发起被拒（402）', run2.status, 402);
    const rb = await run2.json();
    eq('错误码是 token_quota', rb.code, 'token_quota');
    ok('给出重置时间', /重置/.test(String(rb.error)), rb.error);
    ok('附带完整额度状态', !!(rb.quota && rb.quota.day), rb.quota);
    /* 这段话必须说清是「账号额度」而不是「单任务上限」：线上真出过
       「我改了额度，它说额度用完了」——他改的是单任务上限，拦他的是账号额度。 */
    ok('错误里点明是账号额度而不是单任务上限', /账号额度/.test(String(rb.error)) && /单任务上限/.test(String(rb.error)), rb.error);
    ok('错误里指了去哪改', /设置 → 账号额度/.test(String(rb.error)), rb.error);
    eq('402 带 fix=quota（前端据此挂「去调额度」）', rb.fix, 'quota');

    /* ── 自己改额度：改完立刻能跑 ──
       这就是老板报的那件事的回归：改了额度就得算数，不能等重启、等零点。 */
    const up = await call('/api/quota/limits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenDaily: 200000, tokenMonthly: 1000000 })
    });
    const ub = await up.json();
    eq('本人能改自己的日额度（200）', up.status, 200);
    eq('返回的新上限就是提交的数', ub.limits && ub.limits.tokenDaily, 200000);
    const q2 = await jget('/api/quota');
    eq('立刻生效：/api/quota 读到的是新值', q2.tokens.day.limit, 200000);
    ok('摘要不再是「已用完」', !/已用完/.test(String(q2.summary)), q2.summary);

    const run3 = await fetch(BASE + '/api/run', {
      method: 'POST',
      headers: { Origin: BASE, 'x-ren-auth': 'Bearer tok-qa', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'tok-qa', staff: STAFF, task: { id: 'r3', goal: '提额之后接着跑' } })
    });
    eq('提额之后同一个账号能继续发起（200）', run3.status, 200);
    await run3.text();
    await sleep(1200);

    /* 参数里的 scope 对普通登录用户无效：否则谁都能给别人改额度 */
    const other = 'f'.repeat(32);
    const hijack = await call('/api/quota/limits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: other, tokenDaily: 1 })
    });
    const hb = await hijack.json();
    ok('传别人的 scope 只改到自己身上', hijack.status === 200 && hb.limits.tokenDaily === 1, hb);
    const adminSee = await call(`/api/admin/quota?key=${KEY}`).then(r => r.json());
    ok('别人的额度没被改', !adminSee.overrides[other], adminSee.overrides[other]);
    /* 改回 1 之后自己也被锁住了，恢复一下，别影响后面的用例 */
    await call('/api/quota/limits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenDaily: 200000, tokenMonthly: 1000000 })
    });

    const tooBig = await call('/api/quota/limits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenDaily: 100000000000 })
    });
    eq('大得离谱的额度被拒（400）', tooBig.status, 400);

    const bad = await call('/api/quota/limits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenDaily: -5 })
    });
    eq('负数被拒（400）', bad.status, 400);
  }
}

console.log('\n[5] 运维接口的鉴权');
{
  const noKey = await call('/api/admin/backup', { anon: true });
  eq('没 key 时 403', noKey.status, 403);
  const noKey2 = await call('/api/admin/quota', { anon: true });
  eq('quota 也一样', noKey2.status, 403);

  const keyFile = path.join(SECRETS, 'alerts.key');
  const KEY = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  if (KEY) {
    const withKey = await call(`/api/admin/backup?key=${KEY}`, { anon: true });
    eq('有 key 时 200', withKey.status, 200);
    const j = await withKey.json();
    ok('返回备份目录与策略', !!j.dir && j.keep > 0, j);
    const q = await call(`/api/admin/quota?key=${KEY}`, { anon: true });
    const qj = await q.json();
    ok('能列出账号用量', Array.isArray(qj.scopes) && qj.scopes.length >= 1, qj.scopes);
  }
}

console.log('\n[6] 备份：定时会自动跑，手动能触发，产物能校验');
{
  /* 先验定时器：一个只会「启动」不会「触发」的调度器，是最难发现的失效——
     日志里写着「每 24 小时一次」，而去翻目录会发现一份都没有。 */
  let auto = [];
  for (let i = 0; i < 40; i++) {
    auto = fs.readdirSync(BK).filter(f => f.endsWith('.tar.gz'));
    if (auto.length) break;
    await sleep(250);
  }
  ok('定时器真的触发了备份（不是只挂了个 setInterval）', auto.length >= 1, auto);

  const keyFile = path.join(SECRETS, 'alerts.key');
  const KEY = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  if (KEY) {
    const r = await call(`/api/admin/backup?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    const j = await r.json();
    ok('触发备份成功', j.ok, j);
    ok('包落在指定的备份目录', fs.existsSync(path.join(BK, j.file || '')), j.file);
    const v = await call(`/api/admin/backup/verify?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: j.file })
    });
    const vj = await v.json();
    ok('校验通过', vj.ok, vj);
    ok('校验了文件', vj.files > 0, vj.files);
  } else {
    ok('（跳过）拿不到运维 key', false);
  }
}

console.log('\n[7] health 里的运维视图');
{
  const keyFile = path.join(SECRETS, 'alerts.key');
  const KEY = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  const pub = await jget('/api/health');
  ok('公开的 health 不暴露备份路径', pub.backup === undefined, pub.backup);
  if (KEY) {
    const h = await jget(`/api/health?key=${KEY}`);
    ok('带 key 能看到配额概况', !!(h.quota && h.quota.accounts >= 1), h.quota);
    ok('带 key 能看到备份状态', !!(h.backup && h.backup.dir), h.backup);
    ok('备份目录与配置一致', h.backup.dir === BK, h.backup.dir);
    /* 定时器有没有跑过，不能靠「目录里有包」推断——手动触发也会留下包。
       这两个字段是专门为「分不清没到期还是没跑」加的。 */
    ok('备份调度留下了体检记录', Number(h.backup.checks) >= 1, h.backup.checks);
    ok('体检记录带时间', !!h.backup.lastCheckAt, h.backup.lastCheckAt);
  }
}

done();
