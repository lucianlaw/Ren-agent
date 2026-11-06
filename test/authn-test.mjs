/* 鉴权层：谁在调用，只能由云端说了算
 *
 * 这一套测试盯的不是「功能对不对」，是「有没有一条路能让别人进来」。
 * 所以每个失败分支都要单独验，尤其是「拿不到主体时会不会退回客户端说的 uid」——
 * 那条退路一旦存在，前面验多少次签都等于零。
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-authn-'));
process.env.WORKSPACE_DIR = WS;   // 必须在 import 之前：workspace.js 在模块加载时定根目录
/* 密钥目录也指到临时目录：这个测试会真的生成一把签名密钥，
   不指的话会写进本机 .ren-secrets，跑一次测试就换掉线上链接的签名根。 */
const SECRETS = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-authn-secrets-'));
/* 四本账的落点也必须指到临时目录：拉起来的 server.js 不是 test 入口，
   lib/testdir.js 的测试兜底对它不生效，留空就会写进项目真实的 data/。 */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-authn-data-'));
process.env.REN_SECRET_DIR = SECRETS;

const { verifyToken, parseSubject, fileKey, checkFileKey, __test } =
  await import('../lib/authn.js');
const { identityOf, scopeFor } = await import('../lib/identity.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

function sse(...chunks) { return chunks; }

/* 造一个假 fetch：只回答 whoami，并记下被调了几次 */
function fakeWhoami(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    };
  };
  impl.calls = calls;
  return impl;
}

const ENDPOINT = 'https://example.test';
const KEY = 'wbpk_test';

console.log('\n[1] 主体解析：只认服务端返回的身份字段');
{
  eq('sub 优先', parseSubject({ sub: 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg' }).uid, 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg');
  eq('没有 sub 取 uid', parseSubject({ uid: 'AbCdEfGhIjKlMnOpQrStUvWxYz12' }).uid, 'AbCdEfGhIjKlMnOpQrStUvWxYz12');
  eq('user_id 兜底', parseSubject({ user_id: 'AbCdEfGhIjKlMnOpQrStUvWxYz34' }).uid, 'AbCdEfGhIjKlMnOpQrStUvWxYz34');
  eq('包在 data 里', parseSubject({ data: { sub: 'AbCdEfGhIjKlMnOpQrStUvWxYz56' } }).uid, 'AbCdEfGhIjKlMnOpQrStUvWxYz56');
  eq('包在 user 里', parseSubject({ user: { sub: 'AbCdEfGhIjKlMnOpQrStUvWxYz78' } }).uid, 'AbCdEfGhIjKlMnOpQrStUvWxYz78');
  eq('去 wu: 前缀', parseSubject({ sub: 'wu:AbCdEfGhIjKlMnOpQrStUvWxYz90' }).uid, 'AbCdEfGhIjKlMnOpQrStUvWxYz90');
  eq('空对象 → 空', parseSubject({}).uid, '');
  eq('null → 空', parseSubject(null).uid, '');
  eq('字母太短不像 uid → 空', parseSubject({ sub: 'abc' }).uid, '');
  eq('带空格要裁掉', parseSubject({ sub: '  AbCdEfGhIjKlMnOpQrStUvWxYz12 ' }).uid, 'AbCdEfGhIjKlMnOpQrStUvWxYz12');
  ok('匿名标记', parseSubject({ sub: 'AbCdEfGhIjKlMnOpQrStUvWxYz12', is_anonymous: true }).anon === true);
  ok('scope=anonymous 也算匿名', parseSubject({ sub: 'AbCdEfGhIjKlMnOpQrStUvWxYz12', scope: 'anonymous' }).anon === true);
}

console.log('\n[2] 验签成功路径');
{
  __test.resetCache();
  const f = fakeWhoami({ status: 200, body: { sub: 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg', email: 'a@b.c' } });
  const v = await verifyToken({ token: 'tk-1', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: f });
  ok('认下身份', v.ok === true && v.uid === 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg', v);
  eq('请求的是 whoami', f.calls[0].url, ENDPOINT + '/.cloud/auth/v1/user/me');
  eq('带 Bearer', f.calls[0].init.headers.Authorization, 'Bearer tk-1');
  ok('带应用标识', f.calls[0].init.headers['x-wb-webapp-access-key'] === KEY, f.calls[0].init.headers);
  /* 这两个头是必须的：2026-11-04 用一张真正签发给本应用的凭证实测，
     不带 Origin → 401 invalid_grant，带上 → 200。少了它整条鉴权永远过不去，
     而报错读起来像「凭证有毒」，能白白误导好几轮。 */
  eq('必须带 Origin', f.calls[0].init.headers.Origin, ENDPOINT);
  eq('必须带 Referer', f.calls[0].init.headers.Referer, ENDPOINT + '/');

  /* 对照组：一个「没 Origin 就判 invalid_grant」的假网关。
     这条防的是「哪天有人把 Origin 当可选项删掉」——删了断言会红，
     而不是等线上再报一轮 invalid_grant。 */
  __test.resetCache();
  const strictGw = fakeWhoami((url, init) => (
    init.headers.Origin
      ? { status: 200, body: { sub: 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg' } }
      : { status: 401, body: { error: 'invalid_grant' } }
  ));
  const v3 = await verifyToken({ token: 'tk-3', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: strictGw });
  ok('带 Origin 才过得去（假网关复现线上行为）', v3.ok === true, v3);

  /* 路径尾巴上的斜杠不该拼出 // */
  __test.resetCache();
  const f2 = fakeWhoami({ status: 200, body: { sub: 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg' } });
  await verifyToken({ token: 'tk-2', endpoint: ENDPOINT + '///', accessKey: KEY, fetchImpl: f2 });
  eq('endpoint 尾部斜杠被吃掉', f2.calls[0].url, ENDPOINT + '/.cloud/auth/v1/user/me');
}

console.log('\n[3] 缓存与并发：一次结论用 10 分钟，同时进来的只问一次');
{
  __test.resetCache();
  const f = fakeWhoami({ status: 200, body: { sub: 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg' } });
  await verifyToken({ token: 'tk-a', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: f });
  const v2 = await verifyToken({ token: 'tk-a', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: f });
  ok('第二次命中缓存', v2.cached === true, v2);
  eq('只问了一次云端', f.calls.length, 1);

  __test.resetCache();
  const g = fakeWhoami({ status: 200, body: { sub: 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg' } });
  const [a, b, c] = await Promise.all([
    verifyToken({ token: 'tk-b', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: g }),
    verifyToken({ token: 'tk-b', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: g }),
    verifyToken({ token: 'tk-b', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: g })
  ]);
  ok('三路并发结论一致', a.uid === b.uid && b.uid === c.uid);
  eq('并发只问一次云端（去重生效）', g.calls.length, 1);

  /* 失败不缓存：用户重新登录后必须立刻能进，不能被上一次的失败挡住 */
  __test.resetCache();
  let n = 0;
  const h = fakeWhoami(() => (++n === 1
    ? { status: 401, body: { error: 'invalid_grant' } }
    : { status: 200, body: { sub: 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg' } }));
  const bad = await verifyToken({ token: 'tk-c', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: h });
  const good = await verifyToken({ token: 'tk-c', endpoint: ENDPOINT, accessKey: KEY, fetchImpl: h });
  ok('第一次失败', bad.ok === false && bad.code === 'token_invalid', bad);
  ok('第二次（换新凭证后）成功', good.ok === true, good);
  eq('失败没被缓存', n, 2);
}

console.log('\n[4] 失败分支：每一种都要能被区分开');
{
  __test.resetCache();
  const t = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
  const cases = [
    ['没带凭证', { token: '' }, 'no_token'],
    ['没有 endpoint', { token: t, endpoint: '' }, 'no_endpoint'],
    ['凭证过期/不属于本应用', { status: 401, body: { error: 'invalid_grant' } }, 'token_invalid'],
    ['服务端没配好应用标识', { status: 401, body: { error: 'invalid_client' } }, 'app_key_invalid'],
    ['云端 500', { status: 500, body: 'boom' }, 'verify_failed'],
    ['云端 403', { status: 403, body: 'nope' }, 'verify_failed']
  ];
  for (const [name, reply, want] of cases) {
    __test.resetCache();
    const f = fakeWhoami(reply);
    const arg = { token: reply.token !== undefined ? reply.token : t, endpoint: ENDPOINT, accessKey: KEY, fetchImpl: f };
    if (reply.token === '') arg.token = '';
    if (reply.endpoint !== undefined) arg.endpoint = reply.endpoint;
    const v = await verifyToken(arg);
    ok(name + ' → ' + want, v.ok === false && v.code === want, v);
  }

  /* 网络断了要能分辨：不是用户的问题，文案不能指向「重新登录」 */
  __test.resetCache();
  const down = fakeWhoami(() => new Error('ECONNREFUSED'));
  const v = await verifyToken({ token: t, endpoint: ENDPOINT, accessKey: KEY, fetchImpl: down });
  ok('连不上云端 → verify_unreachable', v.code === 'verify_unreachable', v);
  ok('不把网络问题说成登录问题', !/重新登录/.test(v.message), v.message);

  /* 最关键的一条：返回 200 但拿不到主体时，绝不能退回「客户端说的 uid」 */
  __test.resetCache();
  const empty = fakeWhoami({ status: 200, body: {} });
  const v2 = await verifyToken({ token: t, endpoint: ENDPOINT, accessKey: KEY, fetchImpl: empty });
  ok('空主体 → 拒绝（no_subject）', v2.ok === false && v2.code === 'no_subject', v2);
  ok('空主体时没有回退到任何默认身份', v2.uid === undefined, v2);

  __test.resetCache();
  const anon = fakeWhoami({ status: 200, body: { is_anonymous: true } });
  const v3 = await verifyToken({ token: t, endpoint: ENDPOINT, accessKey: KEY, fetchImpl: anon });
  ok('游客没有主体 → 拒绝', v3.ok === false && v3.code === 'no_subject', v3);
  ok('游客的文案说清楚是游客', /游客/.test(v3.message), v3.message);

  /* 报错里不能带凭证原文 */
  __test.resetCache();
  const f401 = fakeWhoami({ status: 401, body: { error: 'invalid_grant' } });
  const v4 = await verifyToken({ token: t, endpoint: ENDPOINT, accessKey: KEY, fetchImpl: f401 });
  ok('错误信息不含凭证原文', !v4.message.includes(t), v4.message);
}

console.log('\n[5] 文件签名 fk：只能开自己那一扇门');
{
  const a = scopeFor('oYQVK6vlBz11FIQ7XP2m8rLKh8pg');
  const b = scopeFor('AbCdEfGhIjKlMnOpQrStUvWxYz12');
  const ka = fileKey(a);
  ok('同一个 scope 签名稳定', fileKey(a) === ka);
  ok('不同 scope 签名不同', fileKey(a) !== fileKey(b));
  ok('长度 32', ka.length === 32, ka.length);
  ok('自己的签名能开自己', checkFileKey(a, ka) === true);
  ok('自己的签名开不了别人', checkFileKey(b, ka) === false);
  ok('空签名被拒', checkFileKey(a, '') === false);
  ok('长度不对直接拒（不进 timingSafeEqual）', checkFileKey(a, ka.slice(0, 31)) === false);
  ok('空 scope 不算签名', fileKey('') === '');
  /* 密钥落盘：换个进程重新算，结果必须一样，否则重启后所有图片和下载链接一起失效。
     位置必须是「部署目录之外」——放在 workspace 里的版本已经废弃：那个目录随发布上传，
     等于把本机的签名密钥交给线上，两边共用一把。 */
  const keyFile = path.join(SECRETS, 'authn.key');
  ok('密钥写在密钥目录（部署目录之外）', fs.existsSync(keyFile), keyFile);
  ok('工作区里不再有密钥副本', !fs.existsSync(path.join(WS, '.authn.key')));
  ok('密钥文件权限 600', (fs.statSync(keyFile).mode & 0o777).toString(8) === '600');
  ok('密钥够长', fs.readFileSync(keyFile, 'utf8').trim().length >= 32);
  /* 用同一份密钥重算（模拟另一个进程） */
  __test.resetSecret();
  ok('重启后签名不变', fileKey(a) === ka);
}

console.log('\n[6] 端到端：没有凭证进不来，有签名才放行');
{
  /* 起一个真服务，用真 HTTP 打真实接口——闸门这种位置，只有真请求算验证过 */
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    /* 不传 REN_AUTH_SECRET：让子进程读工作区里那份密钥文件，
       和本进程算出同一串签名。传一个不同的密钥，这里就会假红。 */
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', WORKSPACE_DIR: WS, REN_AUTH_SECRET: '', AUDIT_DIR: path.join(DATA, 'audit'), INCIDENT_DIR: path.join(DATA, 'incidents'), TICKET_DIR: path.join(DATA, 'tickets'), PROOF_DIR: path.join(DATA, 'proofs') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const base = `http://127.0.0.1:${port}`;
  const call = async (p, body, headers) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, ...(headers || {}) },
      body: JSON.stringify(body || {})
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };

  try {
    /* 等服务起来（最多 8 秒），失败就别把测试挂在这儿 */
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      try { const r = await fetch(base + '/api/health'); up = r.ok; } catch (e) { await new Promise(r2 => setTimeout(r2, 200)); }
    }
    ok('服务起得来', up, out.slice(-200));

    const uid = 'AbCdEfGhIjKlMnOpQrStUvWxYz12';
    const scope = identityOf(uid).scope;

    const r1 = await call('/api/tool', { scope: uid, name: 'list_dir', args: { path: '.' } });
    ok('① 无凭证 → 401', r1.status === 401, r1);
    eq('① 错误码是 auth_required', r1.json && r1.json.code, 'auth_required');

    /* 伪造的 Bearer 打进来：云端要么说不认（401），要么连不上（也 401）——
       两种都必须进不来，所以只断言状态码 */
    const r2 = await call('/api/tool', { scope: uid, name: 'list_dir', args: { path: '.' } },
      { 'x-ren-auth': 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2ln' });
    ok('② 伪造凭证 → 401', r2.status === 401, r2);

    /* 线上反代会给每个请求塞一个 Authorization。它绝不能被当身份用——
       这条如果变绿，说明「凭证来源」又被换回了一个会被代答覆盖的头。 */
    const r2b = await call('/api/tool', { scope: uid, name: 'list_dir', args: { path: '.' } },
      { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2ln' });
    ok('②b 只带 Authorization 不算凭证（反代会塞它）', r2b.status === 401, r2b);
    eq('②b 错误码仍是 auth_required', r2b.json && r2b.json.code, 'auth_required');

    const fk = fileKey(scope);
    const r3 = await call(`/api/tool?scope=${uid}&fk=${fk}`, { name: 'list_dir', args: { path: '.' } });
    ok('③ 正确签名 → 200（image/下载链接这条路过）', r3.status === 200 && r3.json.ok === true, r3);

    const r4 = await call(`/api/tool?scope=${uid}&fk=${'0'.repeat(32)}`, { name: 'list_dir', args: { path: '.' } });
    ok('④ 错签名 → 401', r4.status === 401, r4);

    const other = 'ZzZzZzZzZzZzZzZzZzZzZzZz12';
    const r5 = await call(`/api/tool?scope=${other}&fk=${fk}`, { name: 'list_dir', args: { path: '.' } });
    ok('⑤ 拿自己的签名开别人的目录 → 401', r5.status === 401, r5);

    /* 老页面只带 scope、不带任何凭证：以前能进，现在必须进不来 */
    const r6 = await call('/api/files?scope=' + uid, {});
    ok('⑥ 老式 ?scope= 裸请求 → 401', r6.status === 401, r6);

    const r7 = await call('/api/session', { uid });
    ok('⑦ 不带 token 换身份 → 401', r7.status === 401, r7);
    eq('⑦ 换身份失败码', r7.json && r7.json.code, 'no_token');

    /* 健康检查不能要凭证，否则活着也判死 */
    const hp = await fetch(base + '/api/health');
    ok('⑧ health 不需要凭证', hp.ok, hp.status);
  } finally {
    child.kill('SIGKILL');
  }
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败\n`);
process.exitCode = fail ? 1 : 0;
