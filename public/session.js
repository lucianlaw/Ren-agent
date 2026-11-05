/* 服务端身份：浏览器只负责「把凭证带上」，谁是谁由服务端问云端决定。
 *
 * 为什么要有这一层：以前所有接口靠 ?scope=<uid> 认人，等于「知道别人 uid 就能进
 * 别人工作区」。现在服务端拿到 access_token 会去云端问一次「这张凭证是谁」，
 * 工作区由答案里的 sub 派生——所以这里唯一要做的事就是：
 *   1. 启动时用云端凭证换一次「服务端认可的身份」（拿回 scope 和文件签名 fk）
 *   2. 之后每个 /api 请求都带 Authorization: Bearer <同一张凭证>
 *   3. <img src> / 下载链接带不了请求头，改用 ?fk=<签名>（服务端按 scope 算出来的）
 *
 * 一条边界写清楚：这里不做任何「判断」，只做搬运。任何看起来像鉴权的逻辑
 * 落到前端都等于没有，所以本地一行都不写。
 */
(function () {
  'use strict';

  const S = {
    ready: false,      // 服务端已经认下这个身份
    guest: false,      // 没有可用凭证（未登录 / 游客），按本地模式跑
    uid: '',           // 服务端认定的账号标识
    scope: '',         // 服务端派生的工作区
    fk: '',            // 文件访问签名（只对这一个工作区有效）
    token: '',         // 云端 access_token，请求时带上
    claimed: '',       // 浏览器自己以为的 uid，仅用于排查
    mismatch: false,
    error: '',
    at: 0
  };
  window.SESSION = S;

  let pending = null;

  function pathOf(u) {
    try { return new URL(String(u), location.href).pathname; } catch (e) { return ''; }
  }
  function isApi(u) {
    const p = pathOf(u);
    return p === '/api' || p.indexOf('/api/') === 0;
  }

  /* 拿凭证 → 换身份。失败不抛：调用方拿到 guest 状态后降级成本地执行，
     总比整个界面卡在启动屏上强。失败原因放在 S.error，由界面决定怎么显示。 */
  async function negotiate(triedRefresh) {
    let token = '';
    try {
      token = (window.CLOUD && typeof CLOUD.accessToken === 'function')
        ? String(await CLOUD.accessToken() || '') : '';
    } catch (e) { token = ''; }

    if (!token) {
      S.guest = true;
      S.error = '没有登录凭证';
      return S;
    }
    S.token = token;

    const claimed = (window.CLOUD && typeof CLOUD.uid === 'function') ? String(CLOUD.uid() || '') : '';
    let r, j = null;
    try {
      r = await fetch(window.withSC ? window.withSC('/api/session') : '/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, uid: claimed })
      });
      j = await r.json().catch(() => null);
    } catch (e) {
      S.guest = true;
      S.error = '换身份时连不上服务端：' + ((e && e.message) || '网络错误');
      return S;
    }

    if (!r.ok || !j || !j.ok) {
      /* 只对「凭证不被认」重试一次：可能是这张 token 刚过期，而刷新令牌还有效。
         别的失败（连不上、服务端配置问题）重试也没用，白白多等一秒。 */
      const code = (j && j.code) || '';
      if (code === 'token_invalid' && !triedRefresh && window.CLOUD
        && typeof CLOUD.refreshSession === 'function') {
        triedRefresh = true;
        try {
          await CLOUD.refreshSession();
          return await negotiate(true);   // 带上标记：只重试这一次，别再绕回来
        } catch (e) { /* 刷不动就走下面的失败分支 */ }
      }
      S.guest = true;
      S.error = (j && j.error) || ('身份校验没通过（HTTP ' + r.status + '）');
      /* 服务端把「被拒的是哪张凭证」一并送回来了。分不清这两者就只能在
         「凭证不行」和「压根没用上用户的凭证」之间瞎猜——线上已经为此多跑了两轮。 */
      if (j && j.diag) {
        const d = j.diag || {};
        const f = (o) => o ? (o.len + (o.jwt ? '字JWT' : '') + (o.clientId ? '/c=' + o.clientId : '')) : '无';
        S.error += '｜诊断：送来=' + f(d.sent) + '，网关注入=' + f(d.injected && d.injected.present !== false ? d.injected : null);
      }
      /* 一张图看完：服务端逐组头试探的结果 + 浏览器自己发同一条请求的结果。
         两边对不上，就说明问题在「谁在发」，而不是「凭证好不好」。 */
      diagSoon(token);
      return S;
    }

    S.ready = true;
    S.guest = false;
    S.uid = String(j.uid || '');
    S.scope = String(j.scope || '');
    S.fk = String(j.fk || '');
    S.claimed = String(j.claimed || '');
    S.mismatch = !!j.mismatch;
    S.error = '';
    S.at = Date.now();
    if (S.mismatch) {
      /* 两边算出来不是同一个人：一定有什么地方对不上，但不要静默换目录，
         否则用户只会看到「文件全没了」。留一条日志，界面上再提示一次。 */
      console.warn('[auth] 客户端与服务端认定的账号不一致：', S.claimed, '≠', S.uid);
    }
    return S;
  }

  /* 并发调用只发一次：页面启动时好几个模块会同时要身份 */
  S.ensure = function (force) {
    if (S.ready && !force) return Promise.resolve(S);
    if (pending) return pending;
    pending = negotiate().finally(function () { pending = null; });
    return pending;
  };

  /* ── 给所有 /api 请求带上凭证 ──
     逐个改调用点必然漏（现在有 38 处，以后还会加），所以在这里拦一次。
     只注入 Authorization，其余参数原样透传——SSE 流、AbortSignal 都不受影响。 */
  const rawFetch = window.fetch.bind(window);
  let warnedAt = 0;

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const opt = init ? Object.assign({}, init) : {};
    const need = S.token && isApi(url);

    if (need) {
      let h;
      try { h = new Headers(opt.headers || (input && input.headers) || {}); }
      catch (e) { h = null; }
      if (h) {
        /* 用自定义头而不是 Authorization：线上反代会给每个请求塞一个自己的
           Authorization（即使客户端一个都没带），拿它当身份来源等于认错了人。
           Authorization 照旧带上——模型通道认它，多带一个头不影响。 */
        if (!h.has('x-ren-auth')) h.set('x-ren-auth', 'Bearer ' + S.token);
        if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + S.token);
        opt.headers = h;
      }
    }

    return rawFetch(input, opt).then(function (r) {
      /* 401 说明服务端不认这张凭证了（过期 / 换了账号 / 被吊销）。
         重新换一次；换不动就把原因交给界面，别让用户对着一片空白猜。 */
      if (r && r.status === 401 && isApi(url) && !S.guest) {
        onAuthLost();
      }
      return r;
    });
  };

  /* ── 失败时的自证 ──
     线上连着三轮都只看到「登录态已失效」，可凭证明明刚换过。
     只报错误码永远分不清是「凭证不行」还是「压根没用上用户那张凭证」，
     所以失败时把两件事一起量出来：
       · 服务端拿这张凭证、逐组加头去问云端，哪一组过
       · 浏览器自己发同一条请求，过不过
     两边结果不一样 → 问题在「谁在发」；两边都不过 → 凭证本身不被认。 */
  let diagShown = false;
  function diagSoon(token) {
    if (diagShown || !token) return;
    diagShown = true;
    collectDiag(token).then(drawDiag).catch(function (e) {
      drawDiag(['诊断没跑起来：' + ((e && e.message) || e)]);
    });
  }

  async function collectDiag(token) {
    const lines = [];
    let key = '';
    let srv = null;
    try {
      const r = await window.fetch(window.withSC ? window.withSC('/api/auth-diag') : '/api/auth-diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token })
      });
      srv = await r.json();
      key = (srv && srv.key) || '';
    } catch (e) {
      lines.push('服务端诊断没跑起来：' + ((e && e.message) || e));
    }

    /* 决定性的一步：同一张凭证、同一组头，从浏览器发 */
    let browser = '没试（缺应用标识）';
    if (key) {
      try {
        const r2 = await window.fetch('/.cloud/auth/v1/user/me', {
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + token,
            'x-wb-webapp-access-key': key
          }
        });
        const t = await r2.text();
        let ec = '';
        try { ec = JSON.parse(t).error || ''; } catch (e) { /* 非 JSON */ }
        browser = 'HTTP ' + r2.status + (ec ? ' / ' + ec : '');
      } catch (e) {
        browser = '连不上：' + ((e && e.message) || e);
      }
    }

    lines.push('浏览器自己发同一条 → ' + browser);
    lines.push('');
    if (srv && srv.probes) {
      for (const p of srv.probes) {
        if (p.skip) { lines.push(p.label + '：' + p.skip); continue; }
        if (p.combo) {
          lines.push('  服务端 ' + p.label + ' / ' + p.combo + ' → ' + p.status + (p.err ? ' ' + p.err : ''));
        } else {
          lines.push('  凭证 ' + p.label + '：' + p.len + ' 字符' + (p.jwt ? '（JWT）' : '') +
            (p.iss ? ' iss=' + p.iss : '') + (p.aud ? ' aud=' + p.aud : '') +
            (p.clientId ? ' client=' + p.clientId : '') +
            (p.expInMin !== null ? ' 剩余' + p.expInMin + '分' : '') +
            ' → ' + p.status + (p.err ? ' ' + p.err : ''));
        }
      }
      const first = (srv.probes || []).find(function (p) { return p.combo && !p.skip; });
      if (srv.headerNames) lines.push('');
      if (first) lines.push('第一组试探的凭证长度 ' + first.len + '，与网关塞进来的那张不同即说明用的是你的。');
    }
    return lines;
  }

  function drawDiag(lines) {
    try {
      const id = 'ren-diag';
      let box = document.getElementById(id);
      if (!box) {
        box = document.createElement('div');
        box.id = id;
        box.style.cssText = [
          'position:fixed', 'left:12px', 'right:12px', 'bottom:12px', 'z-index:99999',
          'max-height:52vh', 'overflow:auto', 'padding:12px 14px', 'border-radius:10px',
          'background:#111827', 'color:#e5e7eb', 'font:12px/1.6 ui-monospace,Menlo,monospace',
          'white-space:pre-wrap', 'box-shadow:0 8px 30px rgba(0,0,0,.45)', 'border:1px solid #374151'
        ].join(';');
        const tip = document.createElement('div');
        tip.style.cssText = 'color:#9ca3af;margin-bottom:6px';
        tip.textContent = '身份校验诊断（把这块截图发给维护者即可关闭页面）';
        const body = document.createElement('div');
        body.id = id + '-body';
        const close = document.createElement('button');
        close.textContent = '关闭';
        close.style.cssText = 'margin-top:8px;padding:4px 12px;border-radius:6px;border:1px solid #4b5563;background:#1f2937;color:#e5e7eb;cursor:pointer';
        close.onclick = function () { box.remove(); };
        box.appendChild(tip); box.appendChild(body); box.appendChild(close);
        document.body.appendChild(box);
      }
      const body = document.getElementById(id + '-body');
      if (body) body.textContent = lines.join('\n');
    } catch (e) { /* 诊断用的界面自己不能把页面搞挂 */ }
  }

  function onAuthLost() {
    const now = Date.now();
    if (now - warnedAt < 15000) return;
    warnedAt = now;
    S.ensure(true).then(function (s) {
      if (s.ready) return;   // 换成功了：下一次请求自然带新凭证
      try {
        window.dispatchEvent(new CustomEvent('ren-auth-lost', { detail: { error: s.error } }));
      } catch (e) { /* 老浏览器没有 CustomEvent 构造器，忽略 */ }
    });
  }

  /* ── 媒体链接的签名 ──
     <img src> / <a download> 是浏览器自己发的请求，带不了 Authorization。
     所有这类 URL 都会经过 withSC（拼 sharecode），在这里补一个 fk 就全覆盖了。 */
  const rawSC = window.withSC || function (u) { return u; };
  window.withSC = function (u) {
    const s = String(rawSC(u) || u);
    if (!S.fk || !isApi(u)) return s;
    if (/[?&]fk=/.test(s)) return s;
    return s + (s.indexOf('?') >= 0 ? '&' : '?') + 'fk=' + encodeURIComponent(S.fk);
  };
})();
