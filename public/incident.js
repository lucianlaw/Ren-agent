/* 客户端标准报错：把「又报错了」变成一条能归组、能分诊的记录
 *
 * 为什么这件事必须在浏览器里做，而不是等服务端记：
 *   让老板连续三天误判的那个 403，是浏览器直连模型网关被打回来的——
 *   请求根本没到我们自己的服务端，服务端日志里一片安静。
 *   前端崩、白屏、模型通道被拦，这三类最影响体感的故障，只有浏览器知道。
 *
 * 三条约束：
 *   1. 不许自己制造错误。上报走 try/catch，失败就放弃，绝不重试到死。
 *   2. 不许把浏览器打爆。同一个错 60 秒内只发一次（本地先压一道），
 *      否则一个渲染循环出错就是一秒上千个请求。
 *   3. 不许干扰页面卸载。优先用 sendBeacon，页关了也能把最后一条送出去。
 */
(function () {
  'use strict';

  var WIN_MS = 60 * 1000;
  var MAX_KEYS = 60;
  var SENT = Object.create(null);   // key -> { t, n }
  var KEY_N = 0;
  var busy = false;
  var installed = false;

  var NET_LIKE = /Failed to fetch|NetworkError|Load failed|net::ERR|ERR_NETWORK|network error/i;

  function beacon(body) {
    if (navigator.sendBeacon) {
      /* Blob 的 type 必须是 application/json：用字符串形式发出去会是
         text/plain，服务端按 JSON 解析直接失败，而失败得还很安静。 */
      var ok = navigator.sendBeacon('/api/incident', new Blob([body], { type: 'application/json' }));
      if (ok) return true;
    }
    fetch('/api/incident', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true
    }).catch(function () { /* 上报失败就算了，绝不重试 */ });
    return true;
  }

  function keyOf(code, where, msg) {
    /* 本地去重用的键：把数字抹平，让「第 42 行」和「第 97 行」算同一个。
       注意这跟服务端的 signature 不是一回事——服务端那次是给工单用的，
       这次只是「别把同一个错重复发一百遍」。 */
    return code + '|' + where + '|' + String(msg || '').replace(/\d+/g, '#').slice(0, 120);
  }

  function report(code, msg, opts) {
    if (busy) return false;
    opts = opts || {};
    try {
      var c = String(code || 'E_UNKNOWN').slice(0, 32);
      var where = String(opts.where || 'ui').slice(0, 40);
      var text = String(msg == null ? '' : msg).slice(0, 1500);
      var key = keyOf(c, where, text);
      var now = Date.now();

      var seen = SENT[key];
      if (seen && now - seen.t < WIN_MS) { seen.n++; return false; }
      if (!seen) {
        if (KEY_N >= MAX_KEYS) {
          /* 键太多说明错在变着花样出（或者有人在手动刷）。
             清一轮最老的，别让内存跟着涨。 */
          var oldest = '', oldestT = Infinity;
          for (var k in SENT) if (SENT[k].t < oldestT) { oldestT = SENT[k].t; oldest = k; }
          if (oldest) { delete SENT[oldest]; KEY_N--; }
        }
        KEY_N++;
      }
      SENT[key] = { t: now, n: 1 };

      var stack = [];
      if (Array.isArray(opts.stack)) stack = opts.stack.slice(0, 8).map(function (l) { return String(l).slice(0, 300); });
      else if (opts.stack) stack = String(opts.stack).split('\n').filter(Boolean).slice(0, 8);

      var body = JSON.stringify({
        code: c,
        route: String(location.pathname || '').slice(0, 120),
        where: where,
        msg: text,
        stack: stack,
        extra: opts.extra && typeof opts.extra === 'object' ? opts.extra : null
      });

      busy = true;
      try { return beacon(body); } finally { busy = false; }
    } catch (e) {
      return false;
    }
  }

  function stackOf(err) {
    return err && err.stack ? String(err.stack).split('\n').filter(Boolean).slice(0, 8) : [];
  }

  function fileOf(ev, err) {
    var f = String((ev && ev.filename) || (err && err.fileName) || '');
    var base = f.split('/').pop().split('?')[0];
    return base || 'inline';
  }

  function install() {
    if (installed) return;
    installed = true;

    /* capture: true 是必须的——资源加载失败（img/script 404）不冒泡，
       不加捕获就永远收不到。而「某个 js 没加载出来」正是白屏最常见的原因。 */
    window.addEventListener('error', function (ev) {
      try {
        var t = ev && ev.target;
        if (t && t !== window && (t.src || t.href)) {
          var u = String(t.src || t.href || '').split('?')[0];
          report('E_UI_RENDER', '资源加载失败：' + u, {
            where: 'resource',
            extra: { tag: String(t.tagName || ''), url: u.slice(0, 300) }
          });
          return;
        }
        var err = ev && ev.error;
        var m = (err && err.message) || (ev && ev.message) || '脚本错误';
        report('E_UI_RENDER', m, { where: fileOf(ev, err), stack: stackOf(err) });
      } catch (e) { /* 收错误的地方自己不能出错 */ }
    }, true);

    window.addEventListener('unhandledrejection', function (ev) {
      try {
        var r = ev && ev.reason;
        var m = String((r && (r.message || r)) || '未处理的 Promise 拒绝');
        /* fetch 失败在浏览器里也走 rejection，但它是网络问题不是代码问题。
           分错码会让工单归错人：判成 E_UI_RENDER 就成了「ren agent 自己修」，
           可实际该去看网关。 */
        report(NET_LIKE.test(m) ? 'E_NET' : 'E_UNKNOWN', m, { where: 'promise', stack: stackOf(r) });
      } catch (e) { /* 同上 */ }
    });
  }

  window.INC = { report: report, install: install };
  install();
})();
