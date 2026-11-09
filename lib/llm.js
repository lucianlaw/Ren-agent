/* 服务端模型通道：直连云端的 OpenAI 兼容流式接口
 *
 * 为什么要有这个文件
 *   循环搬到服务端之后，模型调用不能再借浏览器的手。云端 SDK 那条路
 *   （window.CLOUD.chatStream）只在浏览器里可用，它背后打的是：
 *
 *     POST {endpoint}/.cloud/llm/chat/completions
 *     Authorization: Bearer <用户 access_token>
 *     Accept: text/event-stream
 *
 *   端点、路径、鉴权方式都是从 SDK 源码里读出来的（不是猜的），
 *   所以这里按同一份协议实现一遍，服务端就能自己把话说出去。
 *
 * 三条硬约束（照抄通道的要求，不是我们加戏）
 *   1. 必须 stream:true —— 通道不提供非流式，传 false 会被直接拒
 *   2. 鉴权是用户 token，不是 publishableKey —— 后者只能识别「哪个应用」，
 *      识别不了「谁在花钱」，拿它调 LLM 会得到 401 invalid_client
 *   3. token 会过期 —— 这边不存盘、不续期，过期就如实报错让前端换一个。
 *      存盘会把「一次会话的凭证」变成「永久凭证」，代价大于收益。
 */
const LLM_PATH = '/.cloud/llm/chat/completions';

/* ── 直连档：不走托管通道，直接打一家 OpenAI 兼容服务 ──
 *
 * 为什么需要它：托管通道的凭证是「用户 access_token」，并且必须是**本应用签发**的。
 * 本地 dev 跑在 127.0.0.1，浏览器换到的令牌其 client 就是 http://127.0.0.1:8090，
 * 通道一律回 `invalid_grant / issued for another client`——于是本地能进界面、
 * 能调工具，但一个任务也跑不起来。这不是配置问题，是那个入口天生没有登录态。
 *
 * 打开它的代价与边界：
 *   · 只有三处会变——路径（`/chat/completions`）、鉴权（API key 当 bearer）、
 *     模型名（用的是对方家的 id，不是通道的）；SSE 解析、错误翻译、用量上报全不变。
 *   · 不碰身份、不碰权限、不碰工具表。它只回答「怎么把话说出去」。
 *   · 默认关着。线上不设这三个变量，行为一个字节都不变。
 *
 * 环境变量：REN_LLM_DIRECT=1 / REN_LLM_BASE（到 /v1 为止）/ REN_LLM_KEY / REN_LLM_MODEL
 */
const DIRECT_PATH = '/chat/completions';

export function directLLM(env = process.env) {
  const on = /^(1|true|yes|on)$/i.test(String(env.REN_LLM_DIRECT || ''));
  return {
    on,
    path: DIRECT_PATH,
    key: String(env.REN_LLM_KEY || ''),
    model: String(env.REN_LLM_MODEL || '')
  };
}


/* ── 凭证自检：只解载荷，不验签 ──
   401 有两种完全不同的原因，而通道给的是同一句话
   （"the session is invalid, expired or issued for another client"）：
     · 这张凭证确实过期了  → 让用户重新登录，改代码没用
     · 凭证没过期，但不是本应用签发的 → 登录走错了地方，重新登录也没用
   分不开就只能瞎猜。区分它们不需要密钥：JWT 的载荷是明文 base64url，
   exp / iss / aud / client_id 全在里面。签名不碰、原文不回传，只报结论。 */
function b64urlJson(seg) {
  try { return JSON.parse(Buffer.from(String(seg || ''), 'base64url').toString('utf8')); }
  catch { return null; }
}

export function jwtInfo(token) {
  const s = String(token || '');
  const jwt = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s);
  const out = { len: s.length, jwt };
  if (!jwt) return out;
  const p = b64urlJson(s.split('.')[1]);
  if (!p) return out;
  out.exp = typeof p.exp === 'number' ? p.exp : 0;
  out.iat = typeof p.iat === 'number' ? p.iat : 0;
  out.iss = typeof p.iss === 'string' ? p.iss : '';
  const aud = p.aud;
  out.aud = Array.isArray(aud) ? aud.join(',') : (typeof aud === 'string' ? aud : '');
  out.clientId = String(p.client_id || p.azp || p.app_id || '');
  out.sub = typeof p.sub === 'string' ? p.sub : '';
  return out;
}

/* 把 exp 说成人话。服务端和前端时区可能不同，一律用 UTC 标注清楚。 */
function expText(exp, now = Date.now()) {
  if (!exp) return '载荷里没有 exp 字段';
  const t = new Date(exp * 1000);
  const utc = `${t.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const d = Math.round((now - exp * 1000) / 60000);
  if (d > 0) return `凭证有效期到 ${utc}，已经过期 ${d} 分钟`;
  return `凭证有效期到 ${utc}，还有 ${-d} 分钟`;
}

/* 网关拦截页的指纹。命中它就别再猜「额度」「权限」了——那是另一类 403，
   两类混在一起说，只会让人去查错方向（2026-11-06 实测：老板连续三次被告知
   「可能是额度或权限」，而真相是正文里有 <script> / onclick=）。 */
const WAF_BODY = /WAF拦截|api\.waf\.qq|submitWafFeedback|WAF 拦截页面/i;
export function looksWafBody(body) { return WAF_BODY.test(String(body || '')); }

/* 通道的报错体有两种形态：{error:{message,code}} 和 {error_description}，
   另外还可能直接甩一坨 HTML（网关拦截页）。统一压成一句能读的话。 */
function errText(status, body) {
  const raw = String(body || '').slice(0, 600);
  let msg = raw;
  let code = '';
  try {
    const j = JSON.parse(raw);
    const e = j.error;
    /* 通道把机器码放在 error 里（字符串形态）：invalid_client / invalid_grant，
       两者含义完全不同，混成一句「鉴权没过」等于让人瞎猜。 */
    if (typeof e === 'string') code = e;
    msg = (e && (e.message || e.code)) || (typeof e === 'string' ? e : '') || j.error_description || j.message || raw;
  } catch {
    /* 不是 JSON：多半是网关拦截页，剥掉标签压成一行 */
    msg = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  }
  if (status === 403 && looksWafBody(raw)) {
    /* 这句要能直接指向下一步：不是账号问题，是内容问题，而且我们已经自动处理过一次 */
    return '模型通道前面的安全网关拦了这次请求：正文里有会被判成攻击的片段（script 标签、onclick= 这类事件属性、'
      + 'alert( / ../../ 这类写法）。跟额度、登录都无关。';
  }
  if (status === 401) {
    if (code === 'invalid_client') {
      /* 客户端层就没过：请求里没带应用标识，网关不知道是哪个应用在发。
         这是「配置缺失」，不是「用户登录态坏了」，改代码就能好，别让用户去重新登录。 */
      return `模型通道没认出是哪个应用（请求缺少 x-wb-webapp-access-key）：${msg}`;
    }
    if (code === 'invalid_grant') {
      /* 客户端过了，是这张凭证本身不行：过期、被吊销，或者不是本应用签发的 */
      return `模型通道不认这张登录凭证（可能已过期，或凭证不是本应用签发的）：${msg}`;
    }
    return `模型通道鉴权没过：${msg}`;
  }
  if (status === 403) return `模型通道拒绝了这次请求（可能是额度或权限）：${msg}`;
  if (status === 429) return `模型通道限流了，稍等再试：${msg}`;
  return `模型通道返回 ${status}：${msg}`;
}

/* 把 SSE 字节流切成一行一行。
   注意 chunk 边界会切在任意字节上，所以必须留半行缓冲——
   这是所有手写 SSE 解析最常见的错，切漏一个换行就会丢一个 delta。 */
async function* sseLines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      yield line;
    }
  }
  buf += decoder.decode();
  if (buf) yield buf.replace(/\r$/, '');
}

/* 返回一个 async generator，产出 OpenAI 格式的 chunk（和浏览器里那个一模一样）。
   调用方（agent-core 里的 chatOnce）只关心 chunk.choices[0].delta 和 chunk.usage，
   所以这里不做任何再加工，原样透出。 */
export async function* chatStream({
  endpoint,
  token,
  accessKey,
  payload,
  signal,
  fetchImpl = globalThis.fetch,
  path = LLM_PATH
}) {
  /* 直连档在**这一处**统一切换，而不是让每个调用方各判一次：
     调用方有 agent-host 的循环、工具层的看图、模型列表三条，抄三遍必然漏一处，
     而漏掉的那条平时没人走，等到用它的时候只会得到一句「404」。 */
  const DR = directLLM();
  if (DR.on) {
    path = DR.path;
    /* API key 当 bearer。token 为空时也用它——否则会先撞上下面的
       「没有拿到模型凭证」，而那句话在直连场景下是误导。 */
    token = DR.key || token;
    accessKey = '';                 /* 应用标识对第三方没有意义，带上反而可能被判非法头 */
  }
  if (!token) throw new Error('服务端没有拿到模型凭证，请重新登录后再试一次');
  const url = String(endpoint || '').replace(/\/+$/, '') + path;
  const body = { ...payload, stream: true, ...(DR.on && DR.model ? { model: DR.model } : {}) };
  /* Origin / Referer：浏览器发的每个同源 POST 都自带这两个头，
     而 Node 的 fetch 一个都不带。网关按请求来源判断「谁在调模型」，
     少了它，服务端拿着一张完全有效的凭证也会被判成别人的会话。
     这不是我们加的规矩，是把浏览器的默认行为补回来。 */
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* endpoint 不合法就不带 */ }

  let r;
  try {
    r = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        /* 应用标识：SDK 的 createCloudFetch 在每个请求上都会带这个头
           （头名 x-wb-webapp-access-key，值是 publishableKey）。
           少了它，网关不知道是哪个应用在发 → 401 invalid_client，
           哪怕用户 token 完全有效也一样。这条不是可选项。 */
        ...(accessKey ? { 'x-wb-webapp-access-key': accessKey } : {}),
        ...(origin ? { Origin: origin, Referer: origin + '/' } : {})
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new Error(`连不上模型通道：${(e && e.message) || '网络错误'}`);
  }

  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const err = new Error(errText(r.status, txt));
    err.status = r.status;
    /* 打个标：上层（agent.js 的 callWithRetry）据此知道「该换内容重发」，
       而不是当成普通 403 直接判任务失败。没有这个标，自愈永远不触发。 */
    if (r.status === 403 && looksWafBody(txt)) err.waf = true;
    err.code = r.status === 401 ? 'auth_invalid' : `http_${r.status}`;
    /* 凭证形态要一起报：401 有两种完全不同的原因——
       「取错东西了」（拿到的根本不是 access token）和「取对了但过期了」。
       前者该改代码，后者该让用户重新登录。只报「鉴权没过」这两种就分不开，
       而区分它们只需要看形态：通道签发的是 JWT，形如 eyJ...，三段用点隔开。
       只报长度和是不是 JWT，不带任何一位原文。 */
    if (r.status === 401) {
      const info = jwtInfo(token);
      err.diag = info;
      const said = typeof txt === 'string' && /invalid_grant/.test(txt);
      if (said && info.jwt && info.exp) {
        /* 通道把「过期」和「签发方不对」压成同一句话，但它自己的描述里分明写着
           "expired or issued for another client"——这句就是让人猜的。
           exp 在载荷里是明文的，直接算一下就能定死是哪一种，顺带给出下一步动作。 */
        err.message = info.exp * 1000 < Date.now()
          ? `模型通道不认这张凭证：它已经过期了（${expText(info.exp)}）。刷新页面重新登录即可。`
          : `模型通道不认这张凭证：但它并没有过期（${expText(info.exp)}），说明这张凭证不是本应用签发的。`
            + `请确认是在这个站点（${origin || '当前域名'}）上登录的，而不是从别的地方复制过来的。`;
        err.hint = info.exp * 1000 < Date.now() ? 'relogin' : 'wrong_client';
      } else {
        err.message += `（手上这张凭证：长度 ${info.len}，${info.jwt ? '是 JWT' : '不是 JWT'}`
          + `${info.jwt ? '，' + expText(info.exp) : ''}）`;
      }
    }
    throw err;
  }
  if (!r.body) throw new Error('模型通道没有返回流式响应体');

  let sawAny = false;
  for await (const line of sseLines(r.body)) {
    if (!line) continue;
    if (line.startsWith(':')) continue;            /* 心跳注释 */
    if (line.startsWith('event:')) {
      const ev = line.slice(6).trim();
      /* 通道用 event:error 单独报错，此时 data 里是错误体 */
      if (ev === 'error') continue;                /* 交给下面的 data 分支处理 */
      continue;
    }
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    /* 有些错误是以普通 data 帧回来的：{error:{...}} */
    if (j && j.error) throw new Error(errText(200, JSON.stringify(j)));
    sawAny = true;
    yield j;
  }
  /* 一帧都没收到就断了：不能当成「模型无话可说」，那是两件事 */
  if (!sawAny) throw new Error('模型通道没有返回任何内容就断开了');
}

/* 列出可用模型。循环不依赖它（模型是前端选的），
   但评测台要拿它算「验收人有没有跨家族」，所以顺手实现。 */
export async function listModels({ endpoint, token, accessKey, fetchImpl = globalThis.fetch }) {
  /* 直连档不去问对方要模型清单：各家返回格式不一（有的 data[]、有的 models[]、
     有的一律 404），而这里只为「评测台判断有没有跨家族」，配一个就够用。 */
  const DR = directLLM();
  if (DR.on) return DR.model ? [{ id: DR.model, name: DR.model }] : [];
  const url = String(endpoint || '').replace(/\/+$/, '') + '/.cloud/llm/models';
  let origin = '';
  try { origin = new URL(url).origin; } catch { /* 不带 */ }
  const r = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(accessKey ? { 'x-wb-webapp-access-key': accessKey } : {}),
      ...(origin ? { Origin: origin, Referer: origin + '/' } : {})
    }
  });
  if (!r.ok) throw new Error(errText(r.status, await r.text().catch(() => '')));
  const j = await r.json();
  return Array.isArray(j) ? j : (j && (j.data || j.models)) || [];
}

export const __test = { errText, sseLines, LLM_PATH, jwtInfo, expText };
