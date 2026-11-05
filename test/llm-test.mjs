// 模型通道客户端单测：请求头、错误分类、SSE 切分
//
// 为什么值得单测：这三块坏了都不会「报语法错误」，而是变成线上的一句
// 「鉴权没过」——而「鉴权没过」有四种完全不同的成因（缺应用标识、凭证过期、
// 额度、限流），分不清就只能靠猜和反复部署试。线上真实踩过：
// 漏了 x-wb-webapp-access-key，症状是 invalid_client，看起来像用户 token 坏了。
import { chatStream, listModels, __test } from '../lib/llm.js';
const { errText } = __test;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
};
const has = (name, s, kw, extra) => ok(name, String(s).includes(kw), extra !== undefined ? extra : s);

/* 造一个能记录请求的假 fetch */
function spyFetch(sseText = 'data: [DONE]\n\n', status = 200, bodyText = '') {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, headers: init && init.headers });
    if (status !== 200) return new Response(bodyText, { status });
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) { c.enqueue(enc.encode(sseText)); c.close(); }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  fn.calls = calls;
  return fn;
}

const KEY = 'wbpk_test_abcdefg';
const BASE = { endpoint: 'https://example.test', token: 'tok-123', payload: { model: 'm', messages: [] } };

async function drain(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

/* ── [1] 请求头 ── */
console.log('[1] 请求头');
{
  const f = spyFetch();
  await drain(chatStream({ ...BASE, accessKey: KEY, fetchImpl: f }));
  const h = f.calls[0].headers;
  ok('带应用标识头', String(h['x-wb-webapp-access-key'] || '') === KEY, h);
  ok('Authorization 是 Bearer 用户凭证', h.Authorization === 'Bearer tok-123', h.Authorization);
  ok('Accept 要 SSE', h.Accept === 'text/event-stream', h.Accept);
  /* 浏览器发的同源 POST 一定带 Origin/Referer，Node 的 fetch 一个都不带。
     网关按来源判「谁在调模型」，缺了它们，有效凭证也会被判成别人的会话。
     线上真实踩过：只补了 access-key 头，401 从 invalid_client 变成 invalid_grant，
     剩下的那一半就是这两个头。 */
  ok('带 Origin（Node fetch 默认不带，浏览器必带）', h.Origin === 'https://example.test', h.Origin);
  ok('带 Referer', h.Referer === 'https://example.test/', h.Referer);
  eqUrl(f.calls[0].url, '/.cloud/llm/chat/completions');
}
function eqUrl(got, path) {
  ok('打到正确路径', String(got).endsWith(path), got);
}

/* 没有 accessKey 时不能把 undefined 序列化进头里 —— 那会变成字符串 "undefined"，
   比不带更难查：通道报 invalid_client，而你以为自己带了。 */
{
  const f = spyFetch();
  await drain(chatStream({ ...BASE, fetchImpl: f }));
  const h = f.calls[0].headers;
  ok('没配就不带这个头（不是 undefined 字符串）', !('x-wb-webapp-access-key' in h), h);
}

/* ── [2] stream 强制 true ── */
console.log('[2] 流式约束');
{
  const f = spyFetch();
  await drain(chatStream({ ...BASE, payload: { model: 'm', stream: false }, accessKey: KEY, fetchImpl: f }));
  ok('payload 传 false 也会被改成 true', JSON.parse(f.calls[0].init.body).stream === true,
    f.calls[0].init.body.slice(0, 80));
}

/* ── [3] 错误分类 ── */
console.log('[3] 错误分类（四种成因不能混成一句）');
{
  const c = errText(401, '{"error":"invalid_client","error_description":"the client credential is invalid or revoked"}');
  has('缺应用标识 → 说的是应用没被认出', c, '没认出是哪个应用');
  has('缺应用标识 → 告诉要带哪个头', c, 'x-wb-webapp-access-key');
  ok('缺应用标识 → 不提「重新登录」，那不是用户的问题', !c.includes('重新登录'), c);
}
{
  const g = errText(401, '{"error":"invalid_grant","error_description":"the session is invalid, expired or issued for another client"}');
  has('凭证无效 → 说的是登录凭证', g, '登录凭证');
  ok('凭证无效 → 指出可能过期/非本应用签发', /过期|签发/.test(g), g);
  ok('两种 401 的文案必须不同', g !== errText(401, '{"error":"invalid_client"}'));
}
has('403 说额度或权限', errText(403, '{"message":"x"}'), '额度或权限');
has('429 说限流', errText(429, '{"message":"x"}'), '限流');
has('其它状态带状态码', errText(500, '{"message":"x"}'), '500');
has('网关 HTML 页压成一行', errText(502, '<html><body><h1>Bad Gateway</h1></body></html>'), 'Bad Gateway');
ok('HTML 里的标签不留下来', !errText(502, '<html><body>Bad Gateway</body></html>').includes('<'), errText(502, '<b>x</b>'));

/* ── [4] 401 抛出时带 code，前端据此判断该不该重新登录 ── */
console.log('[4] 抛错带标记');
{
  const f = spyFetch('', 401, '{"error":"invalid_grant"}');
  let e = null;
  try { await drain(chatStream({ ...BASE, accessKey: KEY, fetchImpl: f })); } catch (x) { e = x; }
  ok('401 抛错', !!e);
  ok('code 标成 auth_invalid', e && e.code === 'auth_invalid', e && e.code);
  ok('status 带出来', e && e.status === 401, e && e.status);
  /* 401 有两种成因（取错东西 / 取对了但过期），只报「鉴权没过」就分不开 */
  ok('带凭证长度', e && /长度 7/.test(e.message), e && e.message);
  ok('非 JWT 会标出来', e && /不是 JWT/.test(e.message), e && e.message);
}
{
  const f = spyFetch('', 401, '{"error":"invalid_grant"}');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
  let e = null;
  try { await drain(chatStream({ ...BASE, token: jwt, accessKey: KEY, fetchImpl: f })); } catch (x) { e = x; }
  ok('JWT 形态被认出来', e && /是 JWT/.test(e.message) && e.diag && e.diag.jwt === true, e && e.message);
  ok('不把凭证原文带进错误里', e && !e.message.includes(jwt), e && e.message);
}

/* 通道把「过期」和「签发方不对」压成同一句 error_description：
   "the session is invalid, expired or issued for another client"。
   这两件事的处理方式正好相反——前者重新登录就好，后者重新登录一百次也没用。
   分不开就只能在两者之间瞎猜，而分开它们只需要读一下明文载荷里的 exp。 */
function mkJwt(payload) {
  return 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.c2ln';
}
{
  const past = Math.floor(Date.now() / 1000) - 3600;
  const tok = mkJwt({ sub: 'u1', exp: past, client_id: 'other-app' });
  const f = spyFetch('', 401, '{"error":"invalid_grant","error_description":"the session is invalid, expired or issued for another client"}');
  let e = null;
  try { await drain(chatStream({ ...BASE, token: tok, accessKey: KEY, fetchImpl: f })); } catch (x) { e = x; }
  has('过期 → 直说是过期，不再让人猜', e && e.message, '已经过期');
  has('过期 → 给出下一步（重新登录）', e && e.message, '重新登录');
  ok('过期 → hint=relogin', e && e.hint === 'relogin', e && e.hint);
  ok('过期 → diag 带 exp', e && e.diag && e.diag.exp === past, e && e.diag);
  ok('过期 → 凭证原文不进错误', e && !e.message.includes(tok), e && e.message);
}
{
  const future = Math.floor(Date.now() / 1000) + 3600;
  const tok = mkJwt({ sub: 'u1', exp: future });
  const f = spyFetch('', 401, '{"error":"invalid_grant"}');
  let e = null;
  try { await drain(chatStream({ ...BASE, token: tok, accessKey: KEY, fetchImpl: f })); } catch (x) { e = x; }
  has('没过期 → 直说不是本应用签发的', e && e.message, '不是本应用签发');
  ok('没过期 → hint=wrong_client', e && e.hint === 'wrong_client', e && e.hint);
  ok('没过期 → 不误报成「已过期」', e && !e.message.includes('已经过期'), e && e.message);
}
{
  /* 没有 exp 的凭证（自签 / 测试桩）不能硬判成因，退回形态说明 */
  const tok = mkJwt({ sub: 'u1' });
  const f = spyFetch('', 401, '{"error":"invalid_grant"}');
  let e = null;
  try { await drain(chatStream({ ...BASE, token: tok, accessKey: KEY, fetchImpl: f })); } catch (x) { e = x; }
  ok('没有 exp 就不猜成因', e && !e.hint, e && e.hint);
  has('没有 exp 时说清载荷里没有', e && e.message, '没有 exp');
}
{
  const f = spyFetch('', 503, '{"message":"up"}');
  let e = null;
  try { await drain(chatStream({ ...BASE, accessKey: KEY, fetchImpl: f })); } catch (x) { e = x; }
  ok('503 的 code 是 http_503（不是 auth_invalid）', e && e.code === 'http_503', e && e.code);
}

/* ── [5] SSE 切分 ── */
console.log('[5] SSE 解析');
{
  /* 故意把一行切成三段：chunk 边界会落在任意字节上，这是手写 SSE 最常见的丢帧点 */
  const full = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n';
  const enc = new TextEncoder();
  const f = async () => {
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(full.slice(0, 7)));
        c.enqueue(enc.encode(full.slice(7, 30)));
        c.enqueue(enc.encode(full.slice(30)));
        c.close();
      }
    });
    return new Response(stream, { status: 200 });
  };
  const got = await drain(chatStream({ ...BASE, accessKey: KEY, fetchImpl: f }));
  ok('切碎的行也能拼回来', got.length === 2, got.length);
  ok('第一段内容正确', got[0] && got[0].choices[0].delta.content === '你', got[0]);
  ok('第二段内容正确', got[1] && got[1].choices[0].delta.content === '好', got[1]);
}
{
  /* 心跳注释行、event: 行不能当成内容 */
  const txt = ': ping\n\nevent: message\ndata: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n\n';
  const f = spyFetch(txt);
  const got = await drain(chatStream({ ...BASE, accessKey: KEY, fetchImpl: f }));
  ok('注释行和 event 行被跳过', got.length === 1, got.length);
}
{
  /* 一帧都没有就正常结束：不能当「模型无话可说」，那是两件事 */
  const f = spyFetch('');
  let e = null;
  try { await drain(chatStream({ ...BASE, accessKey: KEY, fetchImpl: f })); } catch (x) { e = x; }
  ok('零帧结束要报错，不能静默成功', !!e && /没有返回任何内容/.test(e.message), e && e.message);
}
{
  /* data 帧里带 error 也要抛，而不是当成正常 chunk 传下去 */
  const f = spyFetch('data: {"error":{"message":"boom"}}\n\n');
  let e = null;
  try { await drain(chatStream({ ...BASE, accessKey: KEY, fetchImpl: f })); } catch (x) { e = x; }
  ok('data 帧里的 error 会被抛出', !!e && /boom/.test(e.message), e && e.message);
}
{
  let e = null;
  try { await drain(chatStream({ ...BASE, token: '', accessKey: KEY, fetchImpl: spyFetch() })); } catch (x) { e = x; }
  ok('没有 token 直接报，不空跑一次网络', !!e && /凭证/.test(e.message), e && e.message);
}

/* ── [6] listModels 也要带应用标识 ── */
console.log('[6] 模型清单');
{
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, headers: init && init.headers });
    return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
  };
  const list = await listModels({ endpoint: BASE.endpoint, token: 't', accessKey: KEY, fetchImpl: f });
  ok('拿得到清单', Array.isArray(list) && list.length === 1, list);
  ok('清单请求也带应用标识', String(calls[0].headers['x-wb-webapp-access-key']) === KEY, calls[0].headers);
  ok('清单请求带 Bearer', calls[0].headers.Authorization === 'Bearer t', calls[0].headers);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
