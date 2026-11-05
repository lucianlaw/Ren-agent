/* 语音输入（语义输入）：点麦克风开始听，说的话边识别边写进输入框，再点一次停。
   ── 实现要点 ──────────────────────────────────────────────
   1. 用浏览器自带的 Web Speech API（Chrome / Edge / Safari 14.1+）。音频由浏览器直连识别服务，
      不经过我们的后端，也不需要额外配密钥；没有这个能力的浏览器会明确说清楚，不静默失败。
   2. 只负责把文字写回输入框，不碰发送逻辑。写回后会派发一次 input 事件，所以原有的
      自适应高度、@提醒、按钮态都会照常刷新，不需要第二套逻辑。
   3. 中英切换：点麦克风右下角的小角标，或右键麦克风。选择记在本机，
      中文模式下英文单词也能认，纯英文发言建议切到 EN。
   4. 点发送 / 按 Enter 时先把「还没定稿的半句」落进输入框再发送，
      否则最后说的那句会跟着输入框一起被清掉。 */

(function () {
  'use strict';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const LS_LANG = 'boss.voice.lang';
  const LANGS = ['zh-CN', 'en-US'];
  const TAG = { 'zh-CN': '中', 'en-US': 'EN' };
  const TIP_OFF = '语音输入：点一下开始说话，自动转成文字（右键切换中/英）';
  const TIP_ON = '正在听…再点一下停止（右键切换中/英）';
  const TIP_NA = '当前浏览器不支持语音识别（建议用 Chrome / Edge / Safari 14.1 以上）';

  function toast(msg) {
    try { if (window.APP && window.APP.toast) return window.APP.toast(msg); } catch (e) {}
  }
  function getLang() {
    try { const v = localStorage.getItem(LS_LANG); if (LANGS.indexOf(v) >= 0) return v; } catch (e) {}
    return 'zh-CN';
  }
  function saveLang(v) { try { localStorage.setItem(LS_LANG, v); } catch (e) {} }

  const WORD = /[A-Za-z0-9'\u2019]/;

  /* 两段识别结果拼起来：英文单词之间补空格，中文之间不补。
     浏览器给的分片不带边界空格，不补就会粘成「helpthe」。 */
  function join(a, b) {
    const x = String(a == null ? '' : a).replace(/\s+$/, '');
    const y = String(b == null ? '' : b).replace(/^\s+/, '');
    if (!x) return y;
    if (!y) return x;
    return x + (WORD.test(x.slice(-1)) && WORD.test(y.charAt(0)) ? ' ' : '') + y;
  }

  /* 定插入点：记下光标前后的文本，识别结果只往中间塞，不动用户已经写好的部分 */
  function anchor(st, cur, start, end) {
    const s = typeof start === 'number' && start >= 0 ? Math.min(start, cur.length) : cur.length;
    const e = typeof end === 'number' && end >= s ? Math.min(end, cur.length) : s;
    st.prefix = cur.slice(0, s);
    st.suffix = cur.slice(e);
    st.finals = '';
    st.interim = '';
    st.lastWritten = cur;
    st.anchor = { start: s, end: e };
    return st;
  }
  function buildText(st) { return st.prefix + join(st.finals, st.interim) + st.suffix; }

  function attach(cfg) {
    const btn = typeof cfg.btn === 'string' ? document.getElementById(cfg.btn) : cfg.btn;
    const input = typeof cfg.input === 'string' ? document.getElementById(cfg.input) : cfg.input;
    if (!btn || !input) return null;

    const st = {
      on: false, rec: null, running: false, manualStop: false,
      finals: '', interim: '', prefix: '', suffix: '', anchor: null,
      lastWritten: '', writing: false, lang: getLang(), timer: null
    };

    const badge = btn.querySelector('.mic-lang');
    if (badge) badge.textContent = TAG[st.lang];
    if (!SR) {
      btn.classList.add('na');
      btn.title = TIP_NA;
    }

    function mark(on) {
      btn.classList.toggle('on', !!on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = on ? TIP_ON : (SR ? TIP_OFF : TIP_NA);
    }

    /* 框里的文本被外部改过（发送后清空、用户手动编辑）就重新定插入点。
       已说出的字这时已经在框里了，所以要清空缓冲，否则会拼两遍。 */
    function ensureAnchor() {
      const cur = input.value;
      if (st.anchor && cur === st.lastWritten) return;
      const s = input.selectionStart == null ? cur.length : input.selectionStart;
      const e = input.selectionEnd == null ? s : input.selectionEnd;
      anchor(st, cur, s, e);
    }

    function paint() {
      ensureAnchor();
      const spoken = join(st.finals, st.interim);
      const next = st.prefix + spoken + st.suffix;
      if (next === input.value) return;
      st.lastWritten = next;
      st.writing = true;
      input.value = next;
      const pos = st.prefix.length + spoken.length;
      try { input.setSelectionRange(pos, pos); } catch (e) {}
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      st.writing = false;
    }

    function makeRec() {
      const rec = new SR();
      rec.lang = st.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onstart = () => { st.running = true; };

      rec.onresult = (ev) => {
        if (!st.on) return;
        /* 先对一次插入点：万一框里的字被外部改过，要在这里重锚并把旧缓冲清掉，
           否则新结果会被下面的重锚一起清掉，最后一句就丢了 */
        ensureAnchor();
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const txt = (r && r[0] && r[0].transcript) || '';
          if (r.isFinal) st.finals = join(st.finals, txt);
          else interim = join(interim, txt);
        }
        st.interim = interim;
        paint();
      };

      rec.onerror = (ev) => {
        const err = (ev && ev.error) || '';
        /* no-speech / aborted 是正常现象：静音或主动中止，交给 onend 决定要不要续听 */
        if (err === 'no-speech' || err === 'aborted') return;
        stop();
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          toast('没拿到麦克风权限：点地址栏左边的小锁，把「麦克风」改成允许，再点一次');
        } else if (err === 'network') {
          /* Chrome 系把这个音频发给 Google 的识别服务，国内网络基本不可达；
             内嵌浏览器（Electron 一类）则压根没有内置识别服务。
             这里必须说清「不是你的网络坏了」，否则用户会一直去排查 wifi。 */
          toast('浏览器自带的语音识别用不了：Chrome 走的是 Google 的接口，国内连不上，不是你的网络问题。换 Safari 或 Edge 打开这个页面可以试');
        } else if (err === 'audio-capture') {
          toast('没检测到麦克风设备');
        } else {
          toast('语音识别出错了：' + err);
        }
      };

      rec.onend = () => {
        st.running = false;
        if (!st.on || st.manualStop) return;
        /* 浏览器静音一段时间会自己结束，这里接着听 —— 否则用户以为断了 */
        clearTimeout(st.timer);
        st.timer = setTimeout(() => { if (st.on && !st.manualStop) startRec(); }, 260);
      };

      return rec;
    }

    function startRec() {
      if (!SR) return;
      if (st.running) return;
      if (!st.rec) st.rec = makeRec();
      st.rec.lang = st.lang;
      try {
        st.rec.start();
        st.running = true;
      } catch (e) {
        /* 上一轮还没断干净时 start() 会抛 InvalidStateError，隔一拍重试一次就够 */
        st.running = false;
        clearTimeout(st.timer);
        st.timer = setTimeout(() => {
          if (!st.on) return;
          try { st.rec.start(); st.running = true; } catch (e2) {}
        }, 240);
      }
    }

    function start() {
      if (st.on) return;
      if (!SR) { toast(TIP_NA); return; }
      st.on = true;
      st.manualStop = false;
      st.finals = '';
      st.interim = '';
      st.anchor = null;
      /* 没聚焦时把光标放到末尾，别把话插到开头去；已聚焦就尊重用户选的位置 */
      if (document.activeElement !== input) {
        try {
          input.focus();
          const n = input.value.length;
          input.setSelectionRange(n, n);
        } catch (e) {}
      }
      ensureAnchor();
      mark(true);
      startRec();
    }

    function stop() {
      if (!st.on) return;
      st.on = false;
      st.manualStop = true;
      clearTimeout(st.timer);
      /* 收尾：把还没定稿的那半句直接落进框里。用 abort 而不是 stop，
         避免紧接着再来一次 final 结果，同一句写两遍 */
      if (st.interim) {
        ensureAnchor();
        st.finals = join(st.finals, st.interim);
        st.interim = '';
        paint();
      }
      if (st.rec && st.running) {
        try { st.rec.abort(); } catch (e) {}
      }
      st.running = false;
      st.anchor = null;
      mark(false);
    }

    function cycleLang() {
      const i = LANGS.indexOf(st.lang);
      st.lang = LANGS[(i + 1) % LANGS.length];
      saveLang(st.lang);
      if (badge) badge.textContent = TAG[st.lang];
      toast(st.lang === 'zh-CN' ? '语音识别：中文（英文词也能认）' : '语音识别：English');
      /* 换语言必须换一个识别器，同实例改 lang 不生效 */
      if (st.on) {
        st.manualStop = false;
        if (st.rec && st.running) { try { st.rec.abort(); } catch (e) {} }  /* onend 会接着开新的 */
        else startRec();
      }
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (st.on) stop(); else start();
    });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); cycleLang(); });
    if (badge) {
      badge.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); cycleLang(); });
    }

    /* 用户一边说一边手动改字：重锚一次，后面的话接到新光标后面，不覆盖已有内容 */
    input.addEventListener('input', () => {
      if (st.writing) return;
      if (st.on) st.anchor = null;
    });

    /* 点发送 / 按 Enter 之前先把半句定稿，否则刚说的那句会随输入框一起被清掉 */
    function flushBeforeSend(e) {
      if (!st.on) return;
      const t = e.target;
      const hitBtn = t && t.closest && (t.closest('#runBtn') || t.closest('#meetSend'));
      const hitEnter = e.type === 'keydown' && e.key === 'Enter' && !e.shiftKey && !e.isComposing && document.activeElement === input;
      if (hitBtn || hitEnter) stop();
    }
    document.addEventListener('click', flushBeforeSend, true);
    document.addEventListener('keydown', flushBeforeSend, true);

    /* 切到后台就把麦克风放了，别在后台一直收音 */
    document.addEventListener('visibilitychange', () => { if (document.hidden && st.on) stop(); });

    mark(false);
    return { start, stop, toggle: () => (st.on ? stop() : start()), get listening() { return st.on; } };
  }

  const list = [];
  function attachAll(cfg) {
    const h = attach(cfg);
    if (h) list.push(h);
    return h;
  }

  window.VOICE = {
    supported: !!SR,
    attach: attachAll,
    stopAll() { list.forEach((h) => { try { h.stop(); } catch (e) {} }); },
    /* 测试口子：拼接与插入点不该靠真开麦克风去验 */
    _join: join,
    _anchor: anchor,
    _build: buildText
  };
})();
