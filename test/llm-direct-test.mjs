/* 直连档：能不能真的把话发到「别家」的 OpenAI 兼容接口上
 *
 * 为什么要有这个测试：这条路的成败全在三个「看不见的差异」上——
 *   1. 路径。托管通道是 `{endpoint}/.cloud/llm/chat/completions`，
 *      第三方是 `{endpoint}/chat/completions`。猜错就是一个 404，
 *      而 404 报出来像「通道挂了」，不像是拼错了。
 *   2. 鉴权。托管通道要用户 access_token，第三方要 API key。
 *      两者都是 `Bearer xxx`，发给谁只有 URL 知道。
 *   3. 应用标识。`x-wb-webapp-access-key` 对第三方没有意义，
 *      带上可能被判非法头；不带，托管通道又会 401 invalid_client。
 * 这三件事全部只能在「真发一次请求」里验，所以这里起一个假服务收包看字段。
 */
import http from 'node:http';
import { chatStream, listModels, directLLM } from '../lib/llm.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined
      ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''));
  }
};

/* 收一次请求，记下它长什么样，然后按 SSE 回两帧内容 */
function makeFake() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* 记原文 */ }
      seen.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '好' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { srv, seen };
}

const drain = async (gen) => { for await (const _ of gen) { /* 只要跑完 */ } };

const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const BASE_ENV = ['REN_LLM_DIRECT', 'REN_LLM_BASE', 'REN_LLM_KEY', 'REN_LLM_MODEL'];
const saveEnv = () => Object.fromEntries(BASE_ENV.map(k => [k, process.env[k]]));
const restoreEnv = (saved) => {
  for (const k of BASE_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

const { srv, seen } = makeFake();
const PORT = await listen(srv);
const BASE = `http://127.0.0.1:${PORT}/v1`;
const saved = saveEnv();

try {
  console.log('[1] 直连档：路径、鉴权、模型名三处都要按第三方的规矩来');
  Object.assign(process.env, {
    REN_LLM_DIRECT: '1',
    REN_LLM_BASE: BASE,
    REN_LLM_KEY: 'sk-test-123',
    REN_LLM_MODEL: 'my-model-x'
  });
  {
    const d = directLLM();
    ok('开关被认出来', d.on === true, d);
    ok('模型名取自配置', d.model === 'my-model-x', d.model);

    await drain(chatStream({
      endpoint: BASE,
      /* 故意塞一个「托管通道的 token」：直连档应当无视它 */
      token: 'wbpk_should_be_ignored',
      accessKey: 'wbpk_appkey_should_not_be_sent',
      payload: { model: 'Hy3', messages: [{ role: 'user', content: 'hi' }] }
    }));

    const got = seen.pop();
    ok('请求打到了 /v1/chat/completions（不是 .cloud/llm/…）',
      got && got.path === '/v1/chat/completions', got && got.path);
    ok('用的是 API key，不是那张用户 token',
      got && got.headers.authorization === 'Bearer sk-test-123', got && got.headers.authorization);
    ok('没带应用标识（第三方没有这个概念）',
      got && !('x-wb-webapp-access-key' in got.headers), got && Object.keys(got.headers));
    ok('模型名被换成了配置里那个',
      got && got.body && got.body.model === 'my-model-x', got && got.body && got.body.model);
    ok('仍然是流式（通道与第三方都要求 stream:true）',
      got && got.body && got.body.stream === true, got && got.body && got.body.stream);

    const ms = await listModels({ endpoint: BASE, token: '', accessKey: '' });
    ok('模型列表直接给配置里那一个，不去问对方要',
      Array.isArray(ms) && ms.length === 1 && ms[0].id === 'my-model-x', ms);
  }

  console.log('\n[2] 关掉直连：一个字节都回到托管通道的形态');
  restoreEnv(saved);
  {
    await drain(chatStream({
      endpoint: `http://127.0.0.1:${PORT}`,
      token: 'user-token-abc',
      accessKey: 'wbpk_real',
      payload: { model: 'Hy3', messages: [] }
    }));
    const got = seen.pop();
    ok('路径回到 .cloud/llm/chat/completions',
      got && got.path === '/.cloud/llm/chat/completions', got && got.path);
    ok('鉴权用回用户 token',
      got && got.headers.authorization === 'Bearer user-token-abc', got && got.headers.authorization);
    ok('应用标识带上了',
      got && got.headers['x-wb-webapp-access-key'] === 'wbpk_real', got && got.headers['x-wb-webapp-access-key']);
    ok('模型名没被动过', got && got.body && got.body.model === 'Hy3', got && got.body && got.body.model);
  }

  console.log('\n[3] 直连档没配 key：要说清楚缺的是 key，不是让人去重新登录');
  Object.assign(process.env, { REN_LLM_DIRECT: '1', REN_LLM_BASE: BASE, REN_LLM_KEY: '', REN_LLM_MODEL: 'm' });
  {
    let err = null;
    try { await drain(chatStream({ endpoint: BASE, token: '', accessKey: '', payload: { model: 'm' } })); }
    catch (e) { err = e; }
    ok('确实抛错（不会静默发一个空凭证出去）', !!err, err && err.message);
    ok('说的是凭证缺失', !!err && /凭证/.test(err.message), err && err.message);
    ok('没有把请求真的发出去', seen.length === 0, seen.length);
  }
} finally {
  restoreEnv(saved);
  srv.close();
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
