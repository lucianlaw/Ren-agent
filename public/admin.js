/* 管理后台：模型接入 / 标准员工 / Agent 逻辑 / 质检平台。
 *
 * 只在一个前提下存在——服务端 /api/is-admin 返回 admin（白名单在 admins.json，不在前端）。
 * 这里做的事都不该被普通用户看到：改公共员工库、看内部流程参数、跑评测。
 * 前端这层拦截只是「别让人看见」，真正的写权限由云表 RLS 兜（ba_std_staff 写限 owner）。
 *
 * 依赖：cloud.js（数据）、traits.js（性格四维）、review.js（质检台）、app.js（state / toast / esc）。
 */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const APP = () => window.APP || {};
  const esc = (s) => (APP().esc ? APP().esc(s) : String(s == null ? '' : s));
  const toast = (m) => (APP().toast ? APP().toast(m) : console.log(m));
  const CF = () => window.CLOUD || {};

  const S = {
    on: false,
    page: 'staff',
    std: [],          // 标准员工（含未发布）
    curId: 0,         // 正在编辑的 stdId；0 = 新建
    draft: null,      // 编辑中的字段（未保存）
    traits: { gender: '', zodiac: '', sign: '', mbti: '' },
    q: '',            // 左列表搜索词
    notice: '',       // 同步/批量操作留下的错误提示（toast 一闪就没了，失败原因得留住）
    flowTab: 'task',
    flowOpen: '',
    cfg: null,        // 积分配置（赠送额 / 汇率 / 档位 / 收款码）
    orders: [],       // 充值单缓存
    accts: [],        // 账号台账缓存（user_no / wallet_no / 余额 / 对账差异）
    loaded: false,
    busy: false
  };

  /* ── 入口 ── */
  function open(page) {
    const st = APP().state || {};
    if (!st.isAdmin) return toast('这一页只有管理员能看');
    S.on = true;
    $('#adminApp').hidden = false;
    /* 后台是全屏层，底下主界面还在跑动画/计时器，没必要 */
    document.body.classList.add('adm-mode');
    go(page || S.page || 'staff');
  }

  function close() {
    S.on = false;
    $('#adminApp').hidden = true;
    document.body.classList.remove('adm-mode');
    /* 质检台在后台里是显示态，退出去要收起来，否则下次进主界面它可能还亮着 */
    const ev = $('#evalView');
    if (ev) ev.hidden = true;
    const st = APP().state;
    if (st) {
      st.view = 'task';
      if (APP().showView) APP().showView('task');
    }
  }

  async function go(page) {
    if (!S.on) return;
    S.page = page;
    $$('#admNav .adm-nav-i').forEach(b => b.classList.toggle('on', b.dataset.page === page));
    const body = $('#admBody');
    const ev = $('#evalView');
    if (page === 'qa') {
      body.hidden = true;
      body.classList.add('hide');
      ev.hidden = false;
    } else {
      body.hidden = false;
      body.classList.remove('hide');
      ev.hidden = true;
    }
    if (page === 'models') return paintModels();
    if (page === 'staff') {
      /* 先读库再画：直接 paintStaff 的话第一次进来列表永远是空的（S.std 还没加载） */
      if (!S.loaded) body.innerHTML = '<div class="adm-empty">正在读取标准员工…</div>';
      await loadStd();
      return paintStaff();
    }
    if (page === 'flow') return paintFlow();
    if (page === 'points') return paintPoints();
    if (page === 'qa') return paintQA();
  }

  function head(title, sub, actions) {
    $('#admTitle').textContent = title;
    $('#admSub').innerHTML = sub || '';
    $('#admActions').innerHTML = actions || '';
  }

  /* ══════════ 1. 模型接入 ══════════
     当前所有调用都走 WorkBuddy 托管通道（CLOUD.listModels / chatStream），
     没有任何自持 Key。这一页要解决的是「以后接自有 Key 时，入口在哪、当前占没占」，
     不是真让它现在跑——所以 Key 输入框是禁用态，按钮点了会明说没启用。 */
  function paintModels() {
    const st = APP().state || {};
    const models = st.models || [];
    const cur = st.settings ? st.settings.model : '';
    const curName = (models.find(m => m.id === cur) || {}).name || cur || '未选';

    head('模型接入', '所有对话与工具调用都经过 WorkBuddy 托管通道。自有 Key 直连的位置已留好，当前未启用，保存也不会生效。',
      '<button class="btn tiny ghost" id="admMdlRefresh" type="button">重新拉取模型清单</button>');

    const rows = models.map(m => {
      const tool = m.supportsToolCall === false ? '<span class="adm-ch-tag adm-ch-off">不支持</span>' : '<span class="adm-ch-tag adm-ch-live">支持</span>';
      const isCur = m.id === cur;
      return `<tr>
        <td><b>${esc(m.name || m.id)}</b>${isCur ? ' <span class="adm-std-flag">当前默认</span>' : ''}</td>
        <td class="mono">${esc(m.id || '')}</td>
        <td>${tool}</td>
        <td class="mono">${esc(m.provider || m.vendor || '—')}</td>
      </tr>`;
    }).join('');

    $('#admBody').innerHTML = `
      <section class="adm-sec">
        <div class="adm-sec-hd"><b>接入通道</b><span>同一时刻只有一条通道生效；切到自有 Key 需要改服务端配置</span></div>
        <div class="adm-route">
          <div class="adm-card">
            <div class="adm-rt">
              <div class="adm-rt-ic">◈</div>
              <div class="adm-rt-b">
                <div class="adm-rt-t"><b>WorkBuddy 托管通道</b><span class="adm-ch-tag adm-ch-live">在用</span></div>
                <div class="adm-rt-d">平台统一计费与限速，员工、任务、项目、验收全部走这里。不需要填 Key，也拿不到 Key。</div>
                <div class="adm-rt-kv">
                  <span class="adm-kv">可用模型 <b>${models.length}</b></span>
                  <span class="adm-kv">当前默认 <b>${esc(curName)}</b></span>
                  <span class="adm-kv">Key <b>平台托管</b></span>
                </div>
              </div>
            </div>
          </div>
          <div class="adm-card">
            <div class="adm-rt">
              <div class="adm-rt-ic" style="background:var(--soft);color:var(--mute)">＋</div>
              <div class="adm-rt-b">
                <div class="adm-rt-t"><b>自有 Key 直连</b><span class="adm-ch-tag adm-ch-off">未启用</span></div>
                <div class="adm-rt-d">用于以后接 OpenAI / Anthropic / DeepSeek 等开放接口，自带配额与账单。位置先占住，避免以后改造要动前端架构。</div>
                <div class="adm-rt-kv">
                  <span class="adm-kv">通道数 <b>0</b></span>
                  <span class="adm-kv">Key <b>未填</b></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="adm-sec">
        <div class="adm-sec-hd"><b>可调用的模型</b><span>来自托管通道实时清单，共 ${models.length} 个</span></div>
        <div class="adm-card" style="padding:12px 6px 6px">
          ${models.length ? `<table class="adm-tbl">
            <thead><tr><th>名称</th><th>标识</th><th>工具调用</th><th>来源</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>` : `<div class="adm-empty">还没拿到模型清单。检查登录状态或网络后，点右上角「重新拉取模型清单」。</div>`}
        </div>
      </section>

      <section class="adm-sec">
        <div class="adm-sec-hd"><b>自有 Key 接入（预留）</b><span>字段按主流厂商通用格式留好，启用时不用改界面</span></div>
        <div class="adm-card">
          <div class="adm-keyform">
            <label class="f">提供商
              <select id="admKeyVendor" disabled>
                <option>OpenAI 兼容</option>
                <option>Anthropic</option>
                <option>DeepSeek</option>
                <option>硅基流动</option>
                <option>自定义网关</option>
              </select>
            </label>
            <label class="f">Base URL
              <input id="admKeyBase" placeholder="https://api.example.com/v1" disabled>
            </label>
            <label class="f">API Key
              <input id="admKeyVal" placeholder="sk-…" type="password" disabled>
            </label>
            <button class="btn" id="admKeyTest" type="button" disabled>测试连通</button>
          </div>
          <div class="adm-note-bar">
            <span>ⓘ</span>
            <span>当前版本只会走托管通道，这一栏是占位：输入框禁用，按钮禁用，填了也不会被读取。<b>真要用自有 Key，需要服务端加一张加密的通道表并把 chatStream 分流</b>——不是前端能开的事。真要做的时候告诉我，我按顺序加：Key 加密存储 → 服务端分流 → 这一页的启用开关。</span>
          </div>
        </div>
      </section>`;

    const rb = $('#admMdlRefresh');
    if (rb) rb.onclick = async () => {
      rb.disabled = true;
      rb.textContent = '拉取中…';
      try {
        if (window.CLOUD && CLOUD.listModels) {
          const list = await CLOUD.listModels();
          APP().state.models = list;
        }
        paintModels();
        toast('模型清单已刷新');
      } catch (e) {
        toast('拉取失败：' + (e.message || e));
        rb.disabled = false;
        rb.textContent = '重新拉取模型清单';
      }
    };
  }

  /* ══════════ 2. 标准员工 ══════════
     和用户端「员工」页同一套字段，多两样：发布开关、员工记忆。
     记忆是这次的重点——它不该散在对话里，得是一条条能增删改查的经验，运行时整段拼进提示词。 */
  const MEM_KIND = [
    { k: 'note', n: '备注' },
    { k: 'exp', n: '经验' },
    { k: 'rule', n: '规矩' },
    { k: 'pref', n: '偏好' },
    { k: 'fact', n: '事实' }
  ];
  const kindName = k => (MEM_KIND.find(x => x.k === k) || { n: '备注' }).n;

  async function loadStd(force) {
    if (S.loaded && !force) return;
    S.busy = true;
    try {
      S.std = await CF().listStdStaff();
      S.loaded = true;
      /* 一进来默认落在第一位：空白表单看不出「记忆长什么样」，得先有个人 */
      if (!S.curId && S.std.length) {
        S.curId = S.std[0].stdId;
        S.traits = window.TRAITS ? window.TRAITS.pick(S.std[0]) : S.traits;
      }
    } catch (e) {
      S.std = [];
      toast('读标准员工失败：' + (e.message || e));
    }
    S.busy = false;
  }

  async function paintStaff() {
    const sel = S.std.find(x => x.stdId === S.curId) || null;
    const mine = (APP().state || {}).staff || [];

    head('标准员工', '这里训练的员工程度对所有用户可见、可一键取用。档案改动立刻影响已有使用者；记忆是运行时实时读取的，改完下次开口就生效。',
      `<button class="btn tiny" id="admSync" type="button">⤓ 同步我的员工（${mine.length}）</button>
       <button class="btn tiny primary" id="admNew" type="button">＋ 新建标准员工</button>`);

    $('#admBody').innerHTML = `
      <div class="adm-split">
        <div class="adm-list-col">
          <div class="adm-list-search"><input id="admStdQ" placeholder="搜索名字 / 岗位 / 标签" value="${esc(S.q)}" autocomplete="off"></div>
          <div class="adm-std-list" id="admStdList"></div>
        </div>
        <div class="adm-edit-col" id="admEdit"></div>
      </div>`;

    paintStdList();
    paintEditor();

    $('#admStdQ').oninput = e => { S.q = e.target.value; paintStdList(); };
    const add = $('#admNew');
    if (add) add.onclick = () => {
      S.curId = 0;
      S.traits = { gender: '', zodiac: '', sign: '', mbti: '' };
      S.draft = { name: '', role: '', model: '', tag: '', notes: '', published: true, core: false };
      paintStdList();
      paintEditor();
      const i = $('#admName');
      if (i) i.focus();
    };
    const sy = $('#admSync');
    if (sy) sy.onclick = () => syncMine(sy);
  }

  function paintStdList() {
    const box = $('#admStdList');
    if (!box) return;
    const note = S.notice
      ? `<div class="adm-warn">${esc(S.notice)}<button class="adm-warn-x" type="button" title="知道了">×</button></div>`
      : '';
    const q = S.q.trim().toLowerCase();
    const list = S.std.filter(s => !q
      || `${s.name} ${s.role} ${s.tag} ${s.mbti}`.toLowerCase().includes(q));
    if (!list.length) {
      box.innerHTML = note + `<div class="adm-empty">${S.std.length ? '没搜到。' : '还没有标准员工。点右上角「同步我的员工」把现有员工搬过来，或者新建一个。'}</div>`;
      bindNotice(box);
      return;
    }
    box.innerHTML = note + list.map(s => {
      const on = S.curId === s.stdId ? ' on' : '';
      const ini = esc((s.name || s.role || '员').slice(0, 1));
      const flag = s.published ? '' : '<span class="adm-std-flag draft">草稿</span>';
      const tl = window.TRAITS ? window.TRAITS.line(s) : '';
      return `<div class="adm-std${on}" data-id="${s.stdId}">
        <div class="adm-std-av">${ini}</div>
        <div class="adm-std-b">
          <div class="adm-std-n">${esc(s.name || '未命名')}${flag}</div>
          <div class="adm-std-r" title="${esc((s.role || '') + (tl ? ' · ' + tl : ''))}">${esc(s.role || '未设岗位')}${tl ? ' · ' + esc(tl.split(' —— ')[0]) : ''}</div>
        </div>
      </div>`;
    }).join('');
    bindNotice(box);
    $$('.adm-std', box).forEach(el => {
      el.onclick = () => {
        const id = Number(el.dataset.id);
        const s = S.std.find(x => x.stdId === id);
        if (!s) return;
        S.curId = id;
        S.draft = null;
        S.traits = window.TRAITS ? window.TRAITS.pick(s) : { gender: '', zodiac: '', sign: '', mbti: '' };
        paintStdList();
        paintEditor();
      };
    });
  }

  function bindNotice(box) {
    const x = $('.adm-warn-x', box);
    if (x) x.onclick = () => { S.notice = ''; paintStdList(); };
  }

  function curStd() {
    return S.std.find(x => x.stdId === S.curId) || null;
  }
  function draftOf() {
    const s = curStd();
    if (!S.draft) {
      S.draft = s
        ? { name: s.name, role: s.role, model: s.model, tag: s.tag, notes: s.notes, core: s.core, published: s.published }
        : { name: '', role: '', model: '', tag: '', notes: '', core: false, published: true };
    }
    return S.draft;
  }

  function paintEditor() {
    const box = $('#admEdit');
    if (!box) return;
    const s = curStd();
    const isNew = !s;
    const d = draftOf();
    const mem = s ? (s.mem || []) : [];
    const modelOpts = ['<option value="">跟随全局默认</option>'].concat(
      ((APP().state || {}).models || []).map(m =>
        `<option value="${esc(m.id)}" ${m.id === d.model ? 'selected' : ''}>${esc(m.name || m.id)}</option>`)
    ).join('');

    box.innerHTML = `
      <section class="adm-card">
        <div class="adm-sec-hd" style="margin-bottom:12px">
          <b>${isNew ? '新建标准员工' : esc(s.name || '未命名') + ' 的档案'}</b>
          <span>${isNew ? '存下来之后才能加记忆' : `已被 ${s.uses} 人取用`}</span>
        </div>
        <div class="adm-form-row">
          <label class="f">岗位<input id="admRole" value="${esc(d.role)}" placeholder="例如 法务 / 财务 / 秘书"></label>
          <label class="f">名字<input id="admName" value="${esc(d.name)}" placeholder="不填就用岗位名" ></label>
          <label class="f">基座模型<select id="admModel">${modelOpts}</select></label>
        </div>
        <div class="adm-form-row">
          <label class="f">标签<input id="admTag" value="${esc(d.tag)}" placeholder="例如 合同审查 / 报价核算"></label>
          <label class="f">排序<input id="admSort" type="number" value="${esc(s ? s.sort : 100)}" placeholder="小的在前"></label>
          <label class="f">状态
            <select id="admPub">
              <option value="1" ${d.published ? 'selected' : ''}>已发布（所有人可用）</option>
              <option value="0" ${!d.published ? 'selected' : ''}>草稿（只有自己能看）</option>
            </select>
          </label>
        </div>
        <div class="f">性格与说话风格（四项都选填）
          <div class="tr-box" id="admTraits"></div>
        </div>
        <label class="f">能力要求 / 工作习惯
          <textarea id="admNotes" rows="3" placeholder="例如：条款风险必须引条文来源；不确定就说不确定，不要为了给答案而给答案。">${esc(d.notes)}</textarea>
        </label>
        <div class="adm-foot-act">
          <span class="grow adm-hint">${isNew ? '' : '改动保存后，已取用这位员工的用户下一次开口就是新版本。'}</span>
          ${isNew ? '' : '<button class="btn ghost danger" id="admDel" type="button">删除</button>'}
          <button class="btn primary" id="admSave" type="button">${isNew ? '建立档案' : '保存档案'}</button>
        </div>
      </section>

      <section class="adm-card">
        <div class="adm-mem-hd">
          <b style="font-size:13px">员工记忆 <span class="adm-hint" style="font-weight:400">共 ${mem.length} 条 · 运行时按顺序拼进提示词</span></b>
        </div>
        ${isNew
          ? '<div class="adm-hint">先把档案存下来，再给它写记忆。</div>'
          : `<div class="adm-mem-add">
              <select id="admMemKind">${MEM_KIND.map(k => `<option value="${k.k}">${k.n}</option>`).join('')}</select>
              <textarea id="admMemText" rows="1" placeholder="一条经验写一件事，比如：报价必须先问清是否含税、几个点位"></textarea>
              <button class="btn primary tiny" id="admMemAdd" type="button">加入</button>
            </div>
            <div id="admMemList">${mem.length
              ? mem.map(m => `<div class="adm-mem" data-mid="${m.memId}">
                  <span class="adm-mem-k ${esc(m.kind)}">${esc(kindName(m.kind))}</span>
                  <div class="adm-mem-t" data-txt>${esc(m.text)}</div>
                  <div class="adm-mem-act">
                    <button class="adm-mem-x" data-edit type="button">改</button>
                    <button class="adm-mem-x del" data-del type="button">删</button>
                  </div>
                </div>`).join('')
              : '<div class="adm-hint">还没有记忆条目。这里写的每一条都会成为这位员工的行为依据。</div>'}</div>`}
      </section>`;

    /* 性格四维：和员工面板同一套选择器，共用 TRAITS 的渲染件 */
    if (window.TRAITS) {
      const tb = $('#admTraits');
      if (tb) {
        tb.innerHTML = window.TRAITS.allHTML(S.traits);
        $$('.tr-chip', tb).forEach(el => {
          el.onclick = () => {
            const dim = el.dataset.dim;
            const k = el.dataset.k || '';
            S.traits[dim] = S.traits[dim] === k ? '' : k;
            tb.innerHTML = window.TRAITS.allHTML(S.traits);
            paintEditorTraitsBind();
          };
        });
      }
    }

    /* 输入即存草稿：不这样做的话，点列表里另一个人再回来，没保存的字就没了 */
    ['admRole|role', 'admName|name', 'admTag|tag', 'admNotes|notes'].forEach(pair => {
      const [id, key] = pair.split('|');
      const el = $('#' + id);
      if (el) el.oninput = () => { draftOf()[key] = el.value; };
    });
    const ms = $('#admModel');
    if (ms) ms.onchange = () => { draftOf().model = ms.value; };
    const pb = $('#admPub');
    if (pb) pb.onchange = () => { draftOf().published = pb.value === '1'; };

    const sv = $('#admSave');
    if (sv) sv.onclick = () => saveStd(sv, isNew);
    const dl = $('#admDel');
    if (dl) dl.onclick = () => delStd(s);

    if (!isNew) bindMem(mem);
  }

  function paintEditorTraitsBind() {
    const tb = $('#admTraits');
    if (!tb) return;
    $$('.tr-chip', tb).forEach(el => {
      el.onclick = () => {
        const dim = el.dataset.dim;
        const k = el.dataset.k || '';
        S.traits[dim] = S.traits[dim] === k ? '' : k;
        tb.innerHTML = window.TRAITS.allHTML(S.traits);
        paintEditorTraitsBind();
      };
    });
  }

  function bindMem(mem) {
    const add = $('#admMemAdd');
    if (add) add.onclick = async () => {
      const ta = $('#admMemText');
      const txt = String(ta.value || '').trim();
      if (!txt) return toast('写点什么再加');
      if (S.busy) return;
      S.busy = true;
      add.disabled = true;
      add.textContent = '加中…';
      try {
        const kind = ($('#admMemKind') || {}).value || 'note';
        const made = await CF().addStdMem({ stdId: S.curId, kind, text: txt });
        const s = curStd();
        if (s) (s.mem = s.mem || []).push(made);
        paintEditor();
        toast('已加入记忆');
      } catch (e) {
        toast('加失败：' + (e.message || e));
        add.disabled = false;
        add.textContent = '加入';
      }
      S.busy = false;
    };
    /* 记忆条目：改是就地换 textarea，删要二次确认——这两件事都在这一页直接改云端 */
    $$('#admMemList .adm-mem').forEach(row => {
      const mid = Number(row.dataset.mid);
      const rec = mem.find(m => m.memId === mid);
      if (!rec) return;
      const ed = $('[data-edit]', row);
      const de = $('[data-del]', row);
      if (ed) ed.onclick = () => {
        const t = $('[data-txt]', row);
        if ($('textarea', t)) return;
        const old = rec.text;
        t.innerHTML = `<textarea rows="2">${esc(old)}</textarea>
          <div style="display:flex;gap:6px;margin-top:5px">
            <button class="btn tiny primary" data-ok type="button">保存</button>
            <button class="btn tiny ghost" data-no type="button">取消</button>
          </div>`;
        $('[data-ok]', t).onclick = async () => {
          const v = String($('textarea', t).value || '').trim();
          if (!v) return toast('不能存空的');
          try {
            await CF().updateStdMem(mid, { text: v });
            rec.text = v;
            paintEditor();
            toast('已改');
          } catch (e) { toast('没改成：' + (e.message || e)); }
        };
        $('[data-no]', t).onclick = () => paintEditor();
      };
      if (de) de.onclick = async () => {
        if (!confirm('删掉这条记忆？删了这位员工就不会再参考它。')) return;
        try {
          await CF().deleteStdMem(mid);
          const s = curStd();
          if (s) s.mem = (s.mem || []).filter(m => m.memId !== mid);
          paintEditor();
          toast('已删');
        } catch (e) { toast('没删掉：' + (e.message || e)); }
      };
    });
  }

  async function saveStd(btn, isNew) {
    const d = draftOf();
    const role = String(d.role || '').trim();
    if (!role) return toast('先给 TA 一个岗位');
    const name = String(d.name || '').trim() || role;
    const payload = {
      name, role,
      model: d.model || '',
      tag: String(d.tag || '').trim(),
      notes: String(d.notes || '').trim(),
      published: !!d.published,
      sort: Math.max(0, Math.min(9999, Number(($('#admSort') || {}).value) || 100)),
      gender: S.traits.gender || '', zodiac: S.traits.zodiac || '',
      sign: S.traits.sign || '', mbti: S.traits.mbti || ''
    };
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      if (isNew) {
        const made = await CF().addStdStaff(payload);
        S.std.push(made);
        S.curId = made.stdId;
      } else {
        const up = await CF().updateStdStaff(S.curId, payload);
        const i = S.std.findIndex(x => x.stdId === S.curId);
        if (i >= 0) S.std[i] = Object.assign({}, S.std[i], up, { mem: S.std[i].mem });
      }
      S.draft = null;
      paintStaff();
      toast(isNew ? '标准员工已建立' : '已保存');
    } catch (e) {
      toast('保存失败：' + (e.message || e));
      btn.disabled = false;
      btn.textContent = isNew ? '建立档案' : '保存档案';
    }
  }

  async function delStd(s) {
    if (!s) return;
    if (!confirm(`删除「${s.name}」？\n\n已经取用过它的用户手上那份还在（只是不再同步记忆），但公共库里就没有了。`)) return;
    try {
      await CF().deleteStdStaff(s.stdId);
      S.std = S.std.filter(x => x.stdId !== s.stdId);
      S.curId = S.std.length ? S.std[0].stdId : 0;
      S.draft = null;
      paintStaff();
      toast('已删除');
    } catch (e) { toast('没删掉：' + (e.message || e)); }
  }

  /* 把我的员工同步成标准员工：
     只按「岗位 + 名字」查重，不按 id——因为用户端员工和标准员工是两张表。
     同步过一次之后再点，已存在的会跳过，所以可以反复点。
     失败必须喊出来：之前插入全挂（带了个库里没有的字段）却只写 console，
     界面上就只剩「点了没动静、列表还是空的」。 */
  async function syncMine(btn) {
    const mine = (APP().state || {}).staff || [];
    if (!mine.length) return toast('你名下还没有员工');
    if (!confirm(`把你名下的 ${mine.length} 位员工同步到公共库？\n\n已存在的（同名同岗位）会跳过，不会重复。同步后所有用户都能取用。`)) return;
    btn.disabled = true;
    S.notice = '';
    const has = new Set(S.std.map(x => `${x.name}|${x.role}`));
    let ok = 0, skip = 0, bad = 0, firstErr = '';
    const added = [];
    for (let i = 0; i < mine.length; i++) {
      const m = mine[i];
      btn.textContent = `同步中 ${i + 1}/${mine.length}…`;
      const key = `${m.name}|${m.role}`;
      if (has.has(key)) { skip++; continue; }
      try {
        const made = await CF().addStdStaff({
          name: m.name, role: m.role, model: m.model || '',
          notes: m.notes || '',
          gender: m.gender || '', zodiac: m.zodiac || '', sign: m.sign || '', mbti: m.mbti || '',
          core: !!m.core,
          published: true,
          tag: '',
          sort: 100
        });
        S.std.push(made);
        added.push(made);
        has.add(key);
        ok++;
      } catch (e) {
        bad++;
        if (!firstErr) firstErr = (e && (e.message || e.hint || e.code)) || String(e);
        console.warn('[adm] 同步失败', m.name, e);
      }
    }
    await loadStd(true);
    /* 同步完落在新搬进来的第一位上：不然右边还是空白新建表单，看着像没成功 */
    if (!curStd() && S.std.length) S.curId = (added[0] || S.std[0]).stdId;
    if (curStd()) S.traits = window.TRAITS ? window.TRAITS.pick(curStd()) : S.traits;
    S.draft = null;
    if (bad) S.notice = `有 ${bad} 位没同步成功：${String(firstErr).slice(0, 120)}`;
    paintStaff();
    if (bad && !ok) toast(`同步失败（${bad} 位）：${String(firstErr).slice(0, 60)}`);
    else if (bad) toast(`新增 ${ok}，跳过 ${skip}，失败 ${bad}`);
    else toast(`同步完成：新增 ${ok}，已存在跳过 ${skip}`);
    /* 按钮不用手动还原：paintStaff 已经重画了整页，新按钮上的数字和可用状态都是对的 */
  }

  /* ══════════ 3. Agent 逻辑 ══════════
     这一页不是装饰。所有数字都从当前设置和代码里取，改设置后回来会跟着变——
     目的就是让人一眼看出「agent 到底在哪些地方会停、停的条件是什么」。

     改版后改成左右对照：左边是现在跑的链路，右边是上一版，旧的文案一个字都没删。
     这么做是因为「改了哪些」光看新版看不出来——新增的步骤没有旧版可对照，
     修改的步骤又要同时看到改前改后才知道动了什么。 */
  /* ── 任务链路：改后 / 改前 对照 ────────────────────────────────────────
     每行三格：标记 | 现在 | 上一版。
       k='new'  左有右空 —— 这次新长出来的一步（右边留空，不写字）
       k='chg'  两边都有、左边是改过的 —— chg 一句话说改了什么
       k='keep' 两边一致 —— 不写 old，渲染时直接把左边那份当右边用
       k='gone' 右有左空 —— 这次删掉的（目前没有，留着位置）
     保留项共用同一份文案：同一个东西没必要维护两份，改一处两边同步。 */
  function flowTask() {
    const st = (APP().state || {}).settings || {};
    const steps = Number(st.maxSteps) || 24;
    const tokens = Number(st.maxTokens) || 200000;
    const R = [];

    R.push({
      id: 't1', k: 'keep',
      neu: {
        n: '收任务',
        d: '老板一句话 + 附件 → 建任务记录，挂上指定的员工（没指定就用核心员工）。',
        p: [{ k: '入口', v: 'runGoal()' }],
        why: '任务一旦建出来就落库，刷新不丢。断点续跑靠的就是这条记录里的 steps。'
      }
    });

    R.push({
      id: 't2', k: 'keep',
      neu: {
        n: '拼系统提示',
        d: '岗位 + 性格四维 + 能力要求 + 公司愿景 + 员工印象 + 员工记忆，拼成一段 system prompt。',
        p: [{ k: '组件', v: '6 段' }, { k: '来源', v: 'buildSystem()' }],
        why: '每一步都会重发一次 system，所以性格描述都压得很短：多十个字，跑 24 步就多付 24 次。'
      }
    });

    R.push({
      id: 't3', k: 'new',
      neu: {
        n: '建任务契约',
        d: '开跑前从「目标 + 本轮每句话」推一份契约：产出物、验收口径、约束、风险等级、工具权限、预算、交接格式。后面的产出门禁、验收人、收尾判定都读同一份。',
        p: [
          { k: '来源', v: 'CONTRACT.build()' },
          { k: '风险', v: 'LOW / MEDIUM / HIGH', cls: 'warn' },
          { k: '不落库', v: '纯函数·可重算' }
        ],
        why: '以前 task.accept（验收口径）在 agent.js 里被读、app.js 从来没写过，验收人拿到的永远是 undefined，只能凭「看起来像不像做完了」判——正是文档点名禁止的那种判定。风险等级只看会不会碰不可逆动作（发邮件 / 删文件 / 付款 / 发布），不看篇幅长短。'
      }
    });

    R.push({
      id: 't4', k: 'chg',
      neu: {
        n: '预算闸 · 积分闸',
        d: '每步开工前先看积分余额（为 0 直接停），再看累计 token 有没有超上限。',
        p: [
          { k: '积分', v: '见底即停', cls: 'stop' },
          { k: 'token 上限', v: fmtW(tokens), cls: 'warn' },
          { k: '结局', v: 'credit_exhausted / budget_exceeded', cls: 'stop' }
        ],
        why: '积分闸排在最前面：余额为 0 时连模型都不用调，省一次调用。见底就停在这一步，已经产出的内容都留着，充值后点「继续跑」接着做。'
      },
      old: {
        n: '预算闸',
        d: '累计 token 超过上限就直接收工，不再往下烧。',
        p: [{ k: '上限', v: fmtW(tokens), cls: 'warn' }, { k: '结局', v: 'budget_exceeded', cls: 'stop' }],
        why: '这是「继续跑点了没反应」的老根：额度用完时循环第一步就 break，看起来像按钮坏了。现在续跑前会自动补额度。'
      },
      chg: '多加一道积分闸，余额为 0 时状态是 credit_exhausted，不再跑到半路报错。'
    });

    R.push({
      id: 't5', k: 'keep',
      neu: {
        n: '步数闸',
        d: '走满步数上限就停，防止一个死循环把额度烧穿。',
        p: [{ k: '上限', v: steps + ' 步', cls: 'warn' }, { k: '结局', v: 'step_limit', cls: 'stop' }]
      }
    });

    R.push({
      id: 't6', k: 'keep',
      neu: {
        n: '调模型（流式）',
        d: '带工具定义请求模型，记 TTFT、首正文延迟、reasoning token、缓存命中。',
        p: [{ k: '计量', v: 'task.metrics' }],
        why: '这些指标是质检台比较 A/B 版本的数据来源，不在界面上展示。'
      }
    });

    R.push({
      id: 't7', k: 'keep',
      neu: {
        n: '执行工具',
        d: '读写文件、跑命令、搜图、问你拍板（ask_boss）、记待办。',
        p: [{ k: '授权', v: '敏感操作可挂起' }],
        why: '开了「敏感操作先问一下」之后，写文件和跑命令会先停下来等你放行，这就是状态变成「等授权」的原因。'
      }
    });

    R.push({
      id: 't8', k: 'keep',
      neu: {
        n: '单步校验',
        d: '写文件查是否真落盘、内容有没有明显缩水；跑命令查退出码。',
        p: [{ k: '结局', v: '失败即标红' }],
        why: '模型说「写好了」不算数，落盘才算。这一步就是为了挡住「嘴上说做完了」。'
      }
    });

    R.push({
      id: 't9', k: 'keep',
      neu: {
        n: '循环判定',
        d: '还有工具没执行完就回到调模型；模型不再要工具就是要收工。',
        p: [{ k: '回到', v: '预算闸' }]
      }
    });

    R.push({
      id: 't10', k: 'chg',
      neu: {
        n: '契约硬证据',
        d: '按契约逐类核：老板点名的格式（「顺带做个 ppt」这种也算）在记录里有没有写成功的动作，文件是不是真的还在工作区。',
        p: [
          { k: '依据', v: 'CONTRACT.check()' },
          { k: '不过', v: 'unverified / 产出缺失', cls: 'warn' },
          { k: '无写权限', v: '不逼' }
        ],
        why: '记录里有、文件被移走也算没交付。循环里已经退过 MAX_NUDGE 次，收尾这里不再退回重做——再退只是烧钱，标清楚缺什么比假装做完有用。没有写权限的任务不按这条压，否则纯问答任务会被误判。'
      },
      old: {
        n: '交付物校验',
        d: '任务声明了要交哪些文件，就逐个查：在不在、空不空。',
        p: [{ k: '不过', v: 'unverified', cls: 'warn' }],
        why: '缺交付物会标成「缺交付物」，不会伪装成完成。'
      },
      chg: '从「只查老板填的声明清单」扩大到「按契约核每一类产出物 + 文件真实存在」，判定依据写进 task.evidence。'
    });

    R.push({
      id: 't11', k: 'chg',
      neu: {
        n: '独立验收',
        d: '换一个不是干活的模型。现在它同时拿到契约（验收口径 / 约束 / 产出物 / 风险）和硬证据缺失清单，不再只有一份 Rubric。',
        p: [
          { k: '口径', v: '契约' },
          { k: '候选', v: '3 个' },
          { k: '产出缺失', v: '不许判通过', cls: 'stop' }
        ],
        why: '验收人不许把「产出物缺失」判成通过——这是文档要求的「不得仅凭自述判定」。结论仍然不进用户界面，只进内部告警队列：老板关心的是东西能不能用，不是内部打了几分。'
      },
      old: {
        n: '独立验收',
        d: '换一个不是干活的模型，按 Rubric 打分。最多试 3 个候选，失败就换人。',
        p: [{ k: '候选', v: '不同家族优先' }, { k: '结论', v: '进告警队列' }],
        why: '验收结论不展示给用户——用户关心的是东西能不能用，不是内部打了几分。没过就发邮件给管理员。'
      },
      chg: '验收人从「只有 Rubric」变成「Rubric + 契约口径 + 缺失清单」。'
    });

    R.push({
      id: 't12', k: 'chg',
      neu: {
        n: '收工 · 压状态',
        d: '先按契约硬证据压状态（没落盘不许留在 done），再写指标、更新记忆、投告警，把控制权交回界面。',
        p: [
          { k: '压状态', v: 'canTransit()' },
          { k: '结局', v: 'done / weak / unverified / failed' }
        ],
        why: '收尾是唯一改终态的地方，所以合法迁移表也在这里校验一次：running → completed 允许（验收做在收尾段里，不凭空插一个「验收中」让老板多等一步），但没过验收就 archived 会被拒。'
      },
      old: {
        n: '收工',
        d: '写任务指标、更新记忆、按需投递告警，然后把控制权交回界面。',
        p: [{ k: '结局', v: 'done / failed / 等拍板' }]
      },
      chg: '收工前多一道按契约压状态：弱结论从 done 降成 weak / unverified。'
    });

    R.push({
      id: 't13', k: 'new',
      neu: {
        n: '刷新 / 重开判活',
        d: '进页面时先看云端打点：90 秒内算「还有人在握着」，不抢；超过才判「已中断」。',
        p: [
          { k: '判活', v: 'heartbeatFresh()' },
          { k: '阈值', v: '90 秒' },
          { k: '多标签', v: '不误杀' }
        ],
        why: '以前一进页面就把所有 running 全标成 interrupted，多开一个标签页就会把另一边真在跑的任务改死，两边互相打架。打点就用云端 updated_at——执行方每次存档都刷新它，不用额外加定时器。'
      }
    });

    R.push({
      id: 't14', k: 'new',
      neu: {
        n: '状态归一（跨层）',
        d: '任务 9 种、项目 8 种、节点 6 种状态归到一套标准词表，再加一张合法迁移表。界面文案一个字没改，改的是底层判定。',
        p: [
          { k: '来源', v: 'states.js' },
          { k: '迁移', v: 'canTransit()' },
          { k: '旧词', v: '只用于显示' }
        ],
        why: '以前三套词表各写各的：同一个「等前置」项目里叫 wait、步骤里叫 todo；「做完但有瑕疵」两边都叫 weak，但那只是巧合，没有共同定义。归一只为两件事——非法跳转能被拒（没过验收不许归档），跨层能说同一句话。'
      }
    });

    return R;
  }

  function flowProj() {
    const st = (APP().state || {}).settings || {};
    const pSteps = Number(st.projSteps) || 6;
    const pTokens = Number(st.projTokens) || 600000;
    const nodeCap = Math.min(80000, pTokens);
    const R = [];

    R.push({
      id: 'p1', k: 'keep',
      neu: {
        n: '建项目',
        d: '一句话目标 + 交付物 + 参会人（默认拉核心员工），项目落库。',
        p: [{ k: '入口', v: 'MEET.createProject()' }]
      }
    });

    R.push({
      id: 'p2', k: 'keep',
      neu: {
        n: '拆节点',
        d: 'PM 把目标拆成若干节：每节一个标题、一个负责人、一个要交的文件名。',
        p: [{ k: '产出', v: '节点计划' }],
        why: '拆的时候要求「能验证」——每节必须落一个具体文件，否则后面没法判断这节到底做完没有。'
      }
    });

    R.push({
      id: 'p3', k: 'keep',
      neu: {
        n: '逐节执行',
        d: '每次只做一节，节内还是一个「模型 → 工具 → 校验」的小循环。',
        p: [
          { k: '每节步数', v: pSteps + ' 步', cls: 'warn' },
          { k: '出 PPT', v: pSteps + 5 + ' 步' }
        ],
        why: '成稿 PPT 那节要读几份 md、搜图、再做一轮修，固定多给 5 步；不然必然卡在「图还没配就收工」。'
      }
    });

    R.push({
      id: 'p4', k: 'keep',
      neu: {
        n: '单节预算',
        d: '一节烧到上限还没写出文件就停手，问你是继续还是换个做法。',
        p: [
          { k: '单节上限', v: fmtW(nodeCap), cls: 'warn' },
          { k: '取值', v: 'min(8 万, 整场)' }
        ],
        why: '单节上限不会超过整场，否则一节就能把整个项目烧穿。整场设得比 8 万小时，单节跟着降。'
      }
    });

    R.push({
      id: 'p5', k: 'chg',
      neu: {
        n: '整场预算 · 积分闸',
        d: '每一层开工前、每个节点开工前都过同一道闸：先查积分余额，再看整场累计 token。任一不过就停住，不硬杀。',
        p: [
          { k: '闸门', v: 'guardRun()' },
          { k: '积分', v: '见底即停', cls: 'stop' },
          { k: '整场上限', v: fmtW(pTokens), cls: 'stop' },
          { k: '结局', v: 'halted（已暂停）' }
        ],
        why: '以前只有预算这一道，而且是循环里各处自己判；积分压根没做闸，余额为 0 时会一路调到报错才停。现在合成一道闸，停下来是「已暂停」而不是「中断」——它不是失败，是等你决定：去充值 / 充好了接着跑 / 就这样出纪要。跑过的节点不重跑。'
      },
      old: {
        n: '整场预算',
        d: '整场累计到上限就停下来问老板，不硬杀。',
        p: [{ k: '整场上限', v: fmtW(pTokens), cls: 'stop' }],
        why: '停住等你一句「继续」或「就这样出纪要」。点提高上限会写这个项目自己的额度，优先级高于设置里的默认值。'
      },
      chg: '积分闸并进预算闸；停下来是「已暂停」不是「中断」，并给出「去充值 / 接着跑」两条路。'
    });

    R.push({
      id: 'p6', k: 'keep',
      neu: {
        n: '节点验收',
        d: '每节结束核对：声明的文件名在不在盘上、内容是不是空壳。',
        p: [{ k: '不过', v: '核验存疑' }]
      }
    });

    R.push({
      id: 'p7', k: 'new',
      neu: {
        n: '节点状态归一',
        d: '每节的「等前置 / 跑着 / 等你拍板 / 已核验 / 没跑成」统一从词表取，标签真正渲染到节点卡上。',
        p: [
          { k: '来源', v: 'nodeState() / stTagOf()' },
          { k: '词表', v: 'states.js' }
        ],
        why: '以前 stTag 这个变量定义了、却从来没渲染出来——看项目根本分不清某一节是在跑、在等、还是没跑成。顺带把节点状态归到标准词表：「等前置」不再一边叫 wait 一边叫 todo。'
      }
    });

    R.push({
      id: 'p8', k: 'chg',
      neu: {
        n: '失败重试',
        d: '按错误类别决定要不要重试：限流 / 超时 / 5xx 才退避重试；权限拒绝、缺输入、预算耗尽直接抛给上层。',
        p: [
          { k: '分类', v: 'errClass()' },
          { k: '不重试', v: '权限 / 输入 / 预算', cls: 'stop' },
          { k: '退避', v: '1.2 秒 × 次数' }
        ],
        why: '以前一律等 1.5 秒重试一次，连「没权限」也要多烧一遍调用——重试还是被拒，纯亏。不可重试的类现在立刻抛出，转成「等你补充」或者停下。'
      },
      old: {
        n: '失败重试',
        d: '任一调用失败就等 1.5 秒重试一次，再失败才算没跑成。',
        p: [{ k: '次数', v: '1 次' }, { k: '间隔', v: '1.5 秒' }]
      },
      chg: '从「一律重试一次」改成按类别：只有瞬时错误才重试。'
    });

    R.push({
      id: 'p9', k: 'new',
      neu: {
        n: '计划版本化',
        d: '重排计划前先把旧计划归档成一版，界面上「计划历史」可以展开回看；当前计划永远是最后一版。',
        p: [
          { k: '保留', v: '最近 12 版' },
          { k: '入口', v: 'pushPlanVersion()' },
          { k: '回看', v: '只读' }
        ],
        why: '以前 replan 直接覆盖 m.plan，旧的那一版就没了：老板想回看「上一版排的是什么、为什么改」没有任何地方查。只留 12 版——够回溯，又不至于把一行 JSON 撑爆。同一份计划不重复归档。'
      }
    });

    R.push({
      id: 'p10', k: 'chg',
      neu: {
        n: '节点执行块（界面）',
        d: '每节的结果改成直排：一条虚线分隔，头一行写「谁 / 哪一节 / 什么状态」，正文和任务线同一档字号。',
        p: [{ k: '容器', v: '.mt-node-out' }, { k: '宽度', v: '≤ 700px' }]
      },
      old: {
        n: '节点执行块（界面）',
        d: '每节结果是一整条气泡：白底 + 左边一道蓝竖线 + 撑满正文宽度。',
        p: [{ k: '容器', v: 'bot-bub' }, { k: '宽度', v: '全宽' }]
      },
      chg: '项目的分析框和任务不是一套视觉语言，现在对齐任务线的直排卡片。'
    });

    R.push({
      id: 'p11', k: 'chg',
      neu: {
        n: '确认与拆解卡（界面）',
        d: '宽度收到 660px，和「需要你拍板」同一档；节点再多也不会铺满一整屏。',
        p: [{ k: '宽度', v: '≤ 660px' }]
      },
      old: {
        n: '确认与拆解卡（界面）',
        d: '铺满正文宽度，节点一多就顶满整屏。',
        p: [{ k: '宽度', v: '全宽' }]
      },
      chg: '限宽到拍板卡那一档。'
    });

    R.push({
      id: 'p12', k: 'keep',
      neu: {
        n: '合稿 / 出纪要',
        d: '所有节点交付后合成整稿，或者按讨论出会议纪要。',
        p: [{ k: '产出', v: '交付物清单' }]
      }
    });

    return R;
  }

  function fmtW(n) {
    const v = Number(n) || 0;
    if (v >= 10000) return (Math.round(v / 1000) / 10) + ' 万';
    return String(v);
  }

  /* ── 对照渲染 ── */
  const FLOW_MARK = {
    new: { t: '新增', cls: 'new' },
    chg: { t: '修改', cls: 'chg' },
    keep: { t: '保留', cls: 'keep' },
    gone: { t: '移除', cls: 'gone' }
  };

  function flowCardHTML(c, side, open) {
    /* 右边空着就是空着：只留一个虚线槽，不写「旧版没有」之类的话，
       免得看的人以为那里本来有个被删掉的东西 */
    if (!c) return '<div class="adm-cmp-blank" aria-hidden="true"></div>';
    const p = (c.p || []).map(q =>
      `<span class="${q.cls || ''}">${esc(q.k)} <b>${esc(q.v)}</b></span>`).join('');
    return `<div class="adm-cmp-c ${side}">
      <div class="adm-fl-t"><b>${esc(c.n)}</b></div>
      <div class="adm-fl-d">${c.d}</div>
      ${p ? `<div class="adm-fl-p">${p}</div>` : ''}
      ${open && c.why ? `<div class="adm-cmp-why">${c.why}</div>` : ''}
    </div>`;
  }

  function flowHTML(rows) {
    const cnt = { new: 0, chg: 0, keep: 0, gone: 0 };
    rows.forEach(r => { cnt[r.k] = (cnt[r.k] || 0) + 1; });
    const body = rows.map((r, i) => {
      const m = FLOW_MARK[r.k] || FLOW_MARK.keep;
      const open = S.flowOpen === r.id;
      const oldC = (r.old === undefined && r.k !== 'new') ? r.neu : r.old;
      return `<div class="adm-cmp-row${open ? ' on' : ''}" data-fid="${r.id}">
        <div class="adm-cmp-k"><span class="adm-mk ${m.cls}">${m.t}</span><i>${i + 1}</i></div>
        ${flowCardHTML(r.neu, 'neu', open)}
        ${flowCardHTML(oldC, 'old', open)}
        ${r.chg ? `<div class="adm-cmp-chg">改了什么：${r.chg}</div>` : ''}
      </div>`;
    }).join('');

    return `<div class="adm-cmp">
      <div class="adm-cmp-head">
        <div></div>
        <div><b>现在</b><span>这一版实际在跑的</span></div>
        <div><b>上一版</b><span>改造前，原样留着</span></div>
      </div>
      ${body}
      <div class="adm-cmp-sum">新增 ${cnt.new} 步 · 修改 ${cnt.chg} 步 · 保留 ${cnt.keep} 步 ·
        右边空着就是上一版没有这步${cnt.gone ? ' · 移除 ' + cnt.gone + ' 步' : ''}</div>
    </div>`;
  }

  function paintFlow() {
    const st = (APP().state || {}).settings || {};
    head('Agent 逻辑', '左边是这一版实际在跑的链路，右边是上一版（旧文案一条没删）。两边按执行顺序并排，左侧有、右侧空的那几步就是这次新加的；标「修改」的两边都有，底下补一句改了什么。点一行看「为什么这么设计」。',
      '<button class="btn tiny ghost" id="admFlowSet" type="button">去改额度设置</button>');

    const tab = S.flowTab;
    const list = tab === 'task' ? flowTask() : flowProj();

    $('#admBody').innerHTML = `
      <section class="adm-sec">
        <div class="adm-tabs">
          <button class="adm-tab ${tab === 'task' ? 'on' : ''}" data-tab="task" type="button">任务链路 · 单件事</button>
          <button class="adm-tab ${tab === 'proj' ? 'on' : ''}" data-tab="proj" type="button">项目链路 · 多节协作</button>
        </div>
        ${flowHTML(list)}
      </section>

      <section class="adm-sec">
        <div class="adm-sec-hd"><b>当前生效的闸值</b><span>${tab === 'task' ? '任务级' : '项目级'} · 跟着「设置」走，不是写死的</span></div>
        <div class="adm-param">
          ${tab === 'task' ? `
            <div class="adm-pm"><div class="adm-pm-k">单任务步数</div><div class="adm-pm-v">${Number(st.maxSteps) || 24}<small>步</small></div><div class="adm-pm-s">走满就停</div></div>
            <div class="adm-pm"><div class="adm-pm-k">单任务 token</div><div class="adm-pm-v">${fmtW(Number(st.maxTokens) || 200000)}<small>token</small></div><div class="adm-pm-s">超了直接收工</div></div>
            <div class="adm-pm"><div class="adm-pm-k">积分闸</div><div class="adm-pm-v">0<small>积分</small></div><div class="adm-pm-s">见底即停，已产出都留着</div></div>
            <div class="adm-pm"><div class="adm-pm-k">心跳判活</div><div class="adm-pm-v">90<small>秒</small></div><div class="adm-pm-s">超时才算断了</div></div>
            <div class="adm-pm"><div class="adm-pm-k">验收候选</div><div class="adm-pm-v">3<small>个</small></div><div class="adm-pm-s">失败就换模型</div></div>
            <div class="adm-pm"><div class="adm-pm-k">验收 max_tokens</div><div class="adm-pm-v">2000</div><div class="adm-pm-s">防思考吃满正文为空</div></div>
          ` : `
            <div class="adm-pm"><div class="adm-pm-k">每节步数</div><div class="adm-pm-v">${Number(st.projSteps) || 6}<small>步</small></div><div class="adm-pm-s">PPT 节 +5</div></div>
            <div class="adm-pm"><div class="adm-pm-k">单节 token</div><div class="adm-pm-v">${fmtW(Math.min(80000, Number(st.projTokens) || 600000))}</div><div class="adm-pm-s">min(8 万, 整场)</div></div>
            <div class="adm-pm"><div class="adm-pm-k">整场 token</div><div class="adm-pm-v">${fmtW(Number(st.projTokens) || 600000)}</div><div class="adm-pm-s">到顶停下来问</div></div>
            <div class="adm-pm"><div class="adm-pm-k">积分闸</div><div class="adm-pm-v">0<small>积分</small></div><div class="adm-pm-s">每层 / 每节前都查</div></div>
            <div class="adm-pm"><div class="adm-pm-k">计划留档</div><div class="adm-pm-v">12<small>版</small></div><div class="adm-pm-s">重规划不覆盖历史</div></div>
            <div class="adm-pm"><div class="adm-pm-k">单项目覆盖</div><div class="adm-pm-v">有</div><div class="adm-pm-s">点过提高上限就按它</div></div>
          `}
        </div>
      </section>`;

    $$('.adm-tab').forEach(b => {
      b.onclick = () => { S.flowTab = b.dataset.tab; S.flowOpen = ''; paintFlow(); };
    });
    $$('.adm-cmp-row').forEach(el => {
      el.onclick = () => {
        const id = el.dataset.fid;
        S.flowOpen = S.flowOpen === id ? '' : id;
        paintFlow();
      };
    });
    const fs = $('#admFlowSet');
    if (fs) fs.onclick = () => { close(); if (APP().openSettings) APP().openSettings(); };
  }

  /* ══════════ 4. 质检平台 ══════════
     DOM 在 index.html 里已经搬进后台了，这里只负责把它点亮。
     为什么要搬：回归集、Pass^k、失败归因是内部判据，用户看到只会困惑。 */
  async function paintQA() {
    head('质检平台', '改完 agent 逻辑在这里跑一遍，拿新版本和上一次比：通过率、耗时、token、推理量、质量分。结论会写成差异日志。',
      '');
    if (window.REVIEW && REVIEW.open) {
      try {
        await REVIEW.open();
      } catch (e) {
        toast('质检台打开失败：' + (e.message || e));
      }
    } else {
      toast('质检台脚本没加载');
    }
  }

  /* ══════════ 5. 积分与充值 ══════════
     这一页管三件事：参数（赠送额 / 汇率 / 档位）、审充值单、按账号充入。
     余额本身仍然只能由数据库函数动：
       ba_signup_bonus()  开号赠送
       ba_spend()         按 token 扣
       ba_recharge_review() 审核充值单到账
       ba_admin_grant()   管理员按用户ID充入（函数里校验 ba_admins，并且同事务写流水）
     ba_credit_wallet 上 authenticated 连 UPDATE 都没有，所以「充入」不是改余额，
     而是调函数——余额和流水必须一起动，否则对账就对不上。 */
  const fen2yen = f => (Number(f) || 0) / 100;
  const yenText = f => '¥' + fen2yen(f).toFixed(2);

  async function paintPoints() {
    head('积分与充值', '每个注册用户都有用户ID和账户ID。按用户ID充入后，余额与流水同一次事务里记；余额只能由数据库函数写，前端改不了。',
      '<button class="btn tiny ghost" id="admPtsReload" type="button">↻ 刷新</button>');
    $('#admBody').innerHTML = '<div class="adm-empty">正在读取积分配置与账号台账…</div>';

    let cfg;
    try {
      cfg = await CF().loadConfig();
      S.cfg = cfg;
    } catch (e) {
      $('#admBody').innerHTML = `<div class="adm-empty">积分配置读不到：${esc(e.message || e)}</div>`;
      return;
    }
    let orders = [];
    try { orders = await CF().listRecharges({ limit: 80 }); } catch (e) { orders = []; }
    S.orders = orders;
    /* 账号台账：读不到就退成空的，别让整页跟着挂 */
    let accts = [];
    let acctErr = '';
    try {
      accts = await CF().adminAccounts();
    } catch (e) {
      acctErr = String((e && e.message) || e);
      accts = [];
    }
    S.accts = accts;

    const models = ((APP().state || {}).models || []);
    const rates = cfg.modelRates || {};
    const pending = orders.filter(o => o.status === 'pending');

    $('#admBody').innerHTML = `
      <section class="adm-sec">
        <div class="adm-sec-hd"><b>账号与充入</b><span>输入用户ID → 充入 → 余额增加 + 记一笔「管理员充入」流水</span></div>
        <div class="adm-card">
          <div class="adm-form-row">
            <div class="f">
              <label>用户ID / 账户ID</label>
              <input id="admGrantUser" placeholder="例如 U000001" autocomplete="off" spellcheck="false">
            </div>
            <div class="f">
              <label>充入积分</label>
              <input id="admGrantPts" type="number" min="1" max="1000000" step="1" placeholder="例如 100">
            </div>
            <div class="f">
              <label>备注（可选）</label>
              <input id="admGrantNote" placeholder="例如：线下转账补分" maxlength="40">
            </div>
          </div>
          <div class="adm-foot-act" style="margin-top:10px">
            <span class="adm-hint" id="admGrantHint">充入后余额立刻增加，流水里会留一条「管理员充入」。</span>
            <span class="grow"></span>
            <button class="btn tiny primary" id="admGrantBtn" type="button">充入</button>
          </div>
        </div>
      </section>

      <section class="adm-sec">
        <div class="adm-sec-hd"><b>账号台账</b><span>${accts.length ? accts.length + ' 个账户' : '还没有账户'}${acctErr ? ' · 读不到：' + esc(acctErr) : ''}</span></div>
        <div class="adm-card">
          ${acctsHTML(accts)}
          <p class="adm-hint" style="margin-top:10px">
            「对账」= 余额 − 流水合计，正常必须是 <b>0</b>；不是 0 就说明有一笔没记账，先查再说。
            「累计消耗」是流水里所有负数之和（也就是这个账号一共花掉多少积分）。
            点一行可以把账号填进上面的输入框。
          </p>
        </div>
      </section>

      <section class="adm-sec">
        <div class="adm-sec-hd"><b>新用户与汇率</b><span>改完点保存，下一个新用户立刻按新数字赠送</span></div>
        <div class="adm-card">
          <div class="adm-form-row">
            <div class="f">
              <label>每个新用户赠送积分</label>
              <input id="admSignup" type="number" min="0" max="1000000" step="1" value="${Number(cfg.signupPoints) || 0}">
            </div>
            <div class="f">
              <label>1 积分 = 多少 token（基础汇率）</label>
              <input id="admRate" type="number" min="1" step="1000" value="${Number(cfg.tokenPerPoint) || 1000000}">
            </div>
            <div class="f">
              <label>换算预览</label>
              <input id="admRateHint" value="—" disabled>
            </div>
          </div>
          <p class="adm-hint" style="margin-top:8px">
            赠送只发生一次：wallet 上有一把 <code>signup_granted</code> 的锁，同一个账号反复登录也只领一次。
            改小赠送额不会追回已经发出去的积分。
          </p>
          <div class="adm-sec-hd" style="margin:16px 0 8px"><b>其他模型汇率</b><span>占位，留空 = 跟随基础汇率</span></div>
          <div class="adm-form-row">
            ${models.length ? models.map(m => `
              <div class="f">
                <label>${esc(m.name || m.id)} <span class="adm-std-flag">占位</span></label>
                <input class="adm-mrate" data-mid="${esc(m.id)}" placeholder="留空 = 跟随基础汇率"
                  value="${esc(rates[m.id] != null ? rates[m.id] : '')}">
              </div>`).join('') : '<div class="f"><label>模型清单还没拉回来</label><input value="刷新页面后重试" disabled></div>'}
          </div>
          <p class="adm-hint" style="margin-top:8px">
            当前所有模型都按基础汇率折算；这里填了数字才会单独计费。先占位不设参数，免得出现「同一个任务两种价」。
          </p>
          <div class="adm-foot-act">
            <span class="grow"></span>
            <button class="btn tiny primary" id="admCfgSave" type="button">保存设置</button>
          </div>
        </div>
      </section>

      <section class="adm-sec">
        <div class="adm-sec-hd"><b>收款码</b><span>用户扫码付款，再把交易单号填进来，你在这里核对</span></div>
        <div class="adm-card">
          <div class="adm-qr2">
            ${payBoxHTML('wechat', '微信收款码', cfg.payWechat)}
            ${payBoxHTML('alipay', '支付宝收款码', cfg.payAlipay)}
          </div>
          <div class="f" style="margin-top:12px">
            <label>付款说明（显示在充值弹框里）</label>
            <textarea id="admPayNote" rows="2">${esc(cfg.payNote || '')}</textarea>
          </div>
          <div class="adm-foot-act">
            <span class="grow"></span>
            <button class="btn tiny primary" id="admPaySave" type="button">保存收款方式</button>
          </div>
        </div>
      </section>

      <section class="adm-sec">
        <div class="adm-sec-hd"><b>充值档位</b><span>金额和积分都由服务端按这里算，前端改不了</span></div>
        <div class="adm-card">
          <div id="admPlans">${plansHTML(cfg.plans)}</div>
          <div class="adm-foot-act" style="margin-top:10px">
            <button class="btn tiny ghost" id="admPlanAdd" type="button">＋ 加一档</button>
            <span class="grow"></span>
            <button class="btn tiny primary" id="admPlanSave" type="button">保存档位</button>
          </div>
        </div>
      </section>

      <section class="adm-sec">
        <div class="adm-sec-hd"><b>待核对的充值单</b><span>${pending.length ? pending.length + ' 单待处理' : '没有待处理的单'}</span></div>
        <div class="adm-card">
          ${ordersHTML(orders)}
          <p class="adm-hint" style="margin-top:10px">
            核对方法：打开微信/支付宝账单，按「交易单号」搜到那一笔，金额和单号都对上再点通过。
            通过后积分立刻进对方账户；驳回要写原因，对方能看到。
          </p>
        </div>
      </section>`;

    paintRateHint();
    bindPoints(cfg);
    bindGrant();
  }

  function payBoxHTML(ch, title, val) {
    return `<div class="adm-qrbox">
      <div class="adm-qrbox-hd"><b>${title}</b><label class="adm-qr-up">换图<input type="file" accept="image/*" data-qr="${ch}" hidden></label></div>
      <div class="adm-qrprev" id="admQrPrev_${ch}">${val ? `<img src="${esc(val)}" alt="${title}">` : '<span>还没上传</span>'}</div>
      <textarea class="adm-qrurl" id="admQr_${ch}" rows="2" placeholder="也可以直接贴图片地址 / data URL">${esc(val || '')}</textarea>
    </div>`;
  }

  function plansHTML(plans) {
    const list = plans.length ? plans : [{ id: '', yen: '', credits: '' }];
    return `<div class="adm-plan-hd"><span>金额（元）</span><span>到账积分</span><span></span></div>` +
      list.map((p, i) => `<div class="adm-plan-row" data-i="${i}">
        <input class="adm-plan-yen" type="number" min="0.01" step="0.01" value="${p.yen || ''}" placeholder="10">
        <input class="adm-plan-credits" type="number" min="1" step="1" value="${p.credits || ''}" placeholder="1000">
        <button class="btn tiny ghost adm-plan-del" type="button" data-i="${i}">删</button>
      </div>`).join('');
  }

  function ordersHTML(orders) {
    if (!orders.length) return '<div class="adm-empty">还没有充值单</div>';
    const stName = { pending: '待核对', approved: '已到账', rejected: '已驳回' };
    const chName = { wechat: '微信', alipay: '支付宝' };
    return `<table class="adm-tbl"><thead><tr>
        <th>提交时间</th><th>用户</th><th>金额 / 积分</th><th>渠道</th><th>交易单号</th><th>状态</th><th></th>
      </tr></thead><tbody>${orders.map(o => `
        <tr class="${o.status === 'rejected' ? 'off' : ''}">
          <td class="mono">${esc(fmtTime(o.at))}</td>
          <td class="mono" title="${esc(o.ownerId)}">…${esc(String(o.ownerId).slice(-6))}</td>
          <td><b>${yenText(o.amountFen)}</b> / ${o.credits.toLocaleString()}</td>
          <td>${esc(chName[o.channel] || o.channel)}</td>
          <td class="mono">${esc(o.payNo)}</td>
          <td><span class="pay-badge ${esc(o.status)}">${stName[o.status] || o.status}</span>
            ${o.reviewNote ? `<div class="adm-hint">${esc(o.reviewNote)}</div>` : ''}</td>
          <td>${o.status === 'pending'
            ? `<button class="btn tiny primary" data-ok="${o.id}" type="button">通过</button>
               <button class="btn tiny ghost" data-no="${o.id}" type="button">驳回</button>`
            : ''}</td>
        </tr>`).join('')}</tbody></table>`;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* 换算预览用的口径：过亿就按亿，免得出现「50,000 万」这种看着吓人的写法 */
  function fmtTok(v) {
    const n = Number(v) || 0;
    if (n >= 100000000) return (Math.round(n / 10000000) / 10) + ' 亿';
    if (n >= 10000) return (Math.round(n / 1000) / 10) + ' 万';
    return String(n);
  }

  function paintRateHint() {
    const out = $('#admRateHint');
    if (!out) return;
    const rate = Number(($('#admRate') || {}).value) || 0;
    const bonus = Number(($('#admSignup') || {}).value) || 0;
    out.value = rate > 0
      ? `${bonus} 积分 ≈ ${fmtTok(bonus * rate)} token`
      : '—';
  }

  function collectPlans() {
    const rows = $$('#admPlans .adm-plan-row');
    const out = [];
    rows.forEach((r, i) => {
      const yen = Number(($('.adm-plan-yen', r) || {}).value);
      const credits = Number(($('.adm-plan-credits', r) || {}).value);
      if (!(yen > 0) || !(credits > 0)) return;
      /* 档位 id 跟钱绑：金额和积分一起决定，改价就是新档位，老单仍按提交时的数字留档 */
      out.push({ id: 'c' + Math.round(yen * 100) + 'x' + Math.round(credits), yen, credits });
    });
    return out;
  }

  /* 数字显示：整数不带小数、有小数留两位（积分可以是 0.01 起的消费） */
  function fmtNum(v) {
    const n = Number(v) || 0;
    if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
    return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  /* 账号台账：一行一个钱包。用户ID 是给管理员输的，账户ID 是这笔钱落在哪本账上。
     「对账」= 余额 − 流水合计，正常为 0；不为 0 就是有账没记，标红。 */
  function acctsHTML(list) {
    if (!list.length) {
      return '<div class="adm-empty">还没有账户。用户第一次登录会自动开一个，带用户ID和账户ID。</div>';
    }
    return `<table class="adm-tbl adm-acct-tbl"><thead><tr>
        <th>用户ID</th><th>账户ID</th><th>赠送</th><th>充值</th><th>合计</th>
        <th>累计充入</th><th>累计消耗</th><th>对账</th><th>最近</th>
      </tr></thead><tbody>${list.map(a => {
        const bad = Math.abs(a.diff) > 0.011;
        return `<tr class="adm-acct-row" data-user="${esc(a.userNo || a.ownerId)}" title="点一下填进上面的「用户ID」">
          <td class="mono"><b>${esc(a.userNo || '—')}</b></td>
          <td class="mono adm-dim">${esc(a.walletNo || '—')}</td>
          <td class="mono${a.gift < 20 ? ' adm-low' : ''}">${fmtNum(a.gift)}</td>
          <td class="mono">${fmtNum(a.paid)}</td>
          <td class="mono"><b>${fmtNum(a.total)}</b></td>
          <td class="mono adm-dim">${fmtNum(a.giftIn + a.paidIn)}</td>
          <td class="mono adm-dim">${fmtNum(a.spent)}</td>
          <td class="mono ${bad ? 'adm-bad' : 'adm-ok'}">${bad ? fmtNum(a.diff) : '平'}</td>
          <td class="mono adm-dim">${a.lastAt ? esc(fmtTime(a.lastAt)) : '—'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }

  function bindGrant() {
    const btn = $('#admGrantBtn');
    const userEl = $('#admGrantUser'), ptsEl = $('#admGrantPts'), noteEl = $('#admGrantNote'), hintEl = $('#admGrantHint');
    /* 点台账里的行 → 把用户ID填进输入框，省得手抄 */
    $$('#admBody .adm-acct-row').forEach(tr => {
      tr.onclick = () => {
        if (userEl) { userEl.value = tr.dataset.user || ''; userEl.focus(); }
        if (ptsEl && !ptsEl.value) ptsEl.value = '';
        if (hintEl) { hintEl.textContent = `已选 ${tr.dataset.user || ''}，填积分额度后点「充入」。`; hintEl.style.color = ''; }
      };
    });
    if (!btn) return;
    const say = (m, bad) => {
      if (!hintEl) return;
      hintEl.textContent = m;
      hintEl.style.color = bad ? 'var(--red,#c0392b)' : '';
    };
    btn.onclick = async () => {
      const user = String((userEl && userEl.value) || '').trim();
      const pts = Number((ptsEl && ptsEl.value) || 0);
      const note = String((noteEl && noteEl.value) || '').trim();
      if (!user) { say('先填用户ID（形如 U000001）', true); if (userEl) userEl.focus(); return; }
      if (!(pts > 0)) { say('积分额度要大于 0', true); if (ptsEl) ptsEl.focus(); return; }
      if (pts > 1000000) { say('一次最多充 100 万积分，请分几次', true); return; }
      btn.disabled = true; btn.textContent = '充入中…';
      say('正在充入…');
      try {
        const r = await CF().adminGrant({ user, points: pts, note });
        await paintPoints();
        const h = $('#admGrantHint');
        if (h) {
          h.textContent = `已充入 ${fmtNum(r.points)} 积分 → ${r.user_no || user}（账户 ${r.wallet_no || '—'}），`
            + `当前余额 ${fmtNum(r.total)}，流水号 #${r.log_id || '—'}`;
          h.style.color = '';
        }
        const u = $('#admGrantUser'); if (u) u.value = r.user_no || user;
        const p = $('#admGrantPts'); if (p) p.value = '';
        const n = $('#admGrantNote'); if (n) n.value = '';
        toast(`已充入 ${fmtNum(r.points)} 积分`);
      } catch (e) {
        const m = String((e && e.message) || e);
        if (/ACCOUNT_NOT_FOUND/.test(m)) say('没找到这个账号：用户ID 要对（U000001 这种），或者用账户ID（W000001）', true);
        else if (/NOT_ADMIN/.test(m)) say('这次操作没通过管理员校验（库里的 ba_admins 里没有当前账号）', true);
        else if (/POINTS_TOO_LARGE/.test(m)) say('一次最多充 100 万积分', true);
        else if (/POINTS_INVALID/.test(m)) say('积分额度要大于 0', true);
        else if (/NO_SESSION/.test(m)) say('登录态过期了，重新登录再来', true);
        else say('没充上：' + m, true);
        btn.disabled = false; btn.textContent = '充入';
      }
    };
  }

  function bindPoints(cfg) {
    const rel = $('#admPtsReload');
    if (rel) rel.onclick = () => paintPoints();
    ['#admRate', '#admSignup'].forEach(sel => {
      const el = $(sel);
      if (el) el.oninput = paintRateHint;
    });

    const save = $('#admCfgSave');
    if (save) save.onclick = async () => {
      const signupPoints = Math.max(0, Math.round(Number(($('#admSignup') || {}).value) || 0));
      const tokenPerPoint = Math.max(1, Math.round(Number(($('#admRate') || {}).value) || 1000000));
      const modelRates = {};
      $$('.adm-mrate').forEach(inp => {
        const v = Number(inp.value);
        if (inp.value.trim() !== '' && v > 0) modelRates[inp.dataset.mid] = v;
      });
      save.disabled = true;
      try {
        S.cfg = await CF().saveConfig({ signupPoints, tokenPerPoint, modelRates });
        toast('已保存：新用户赠送 ' + signupPoints + ' 积分，基础汇率 1 积分 = ' + tokenPerPoint.toLocaleString() + ' token');
        paintRateHint();
      } catch (e) { toast('没保存上：' + (e.message || e)); }
      save.disabled = false;
    };

    $$('#admBody .adm-qr-up input[type=file]').forEach(inp => {
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        const ch = inp.dataset.qr;
        if (!f) return;
        shrinkImage(f, url => {
          const ta = $('#admQr_' + ch);
          const prev = $('#admQrPrev_' + ch);
          if (!url) return toast('这张图读不出来，换一张试试');
          if (ta) ta.value = url;
          if (prev) prev.innerHTML = `<img src="${esc(url)}" alt="收款码">`;
        });
      };
    });
    /* 直接贴地址时，预览跟着走 */
    ['wechat', 'alipay'].forEach(ch => {
      const ta = $('#admQr_' + ch);
      if (!ta) return;
      ta.oninput = () => {
        const prev = $('#admQrPrev_' + ch);
        const v = ta.value.trim();
        if (prev) prev.innerHTML = v ? `<img src="${esc(v)}" alt="收款码">` : '<span>还没上传</span>';
      };
    });

    const paySave = $('#admPaySave');
    if (paySave) paySave.onclick = async () => {
      const payWechat = (($('#admQr_wechat') || {}).value || '').trim();
      const payAlipay = (($('#admQr_alipay') || {}).value || '').trim();
      const payNote = (($('#admPayNote') || {}).value || '').trim();
      paySave.disabled = true;
      try {
        S.cfg = await CF().saveConfig({ payWechat, payAlipay, payNote });
        toast('收款方式已保存');
      } catch (e) { toast('没保存上：' + (e.message || e)); }
      paySave.disabled = false;
    };

    const add = $('#admPlanAdd');
    if (add) add.onclick = () => {
      const box = $('#admPlans');
      if (!box) return;
      const n = $$('#admPlans .adm-plan-row').length;
      const div = document.createElement('div');
      div.className = 'adm-plan-row';
      div.dataset.i = String(n);
      div.innerHTML = `<input class="adm-plan-yen" type="number" min="0.01" step="0.01" placeholder="10">
        <input class="adm-plan-credits" type="number" min="1" step="1" placeholder="1000">
        <button class="btn tiny ghost adm-plan-del" type="button">删</button>`;
      box.appendChild(div);
      bindPlanDel();
    };
    bindPlanDel();

    const planSave = $('#admPlanSave');
    if (planSave) planSave.onclick = async () => {
      const plans = collectPlans();
      if (!plans.length) return toast('至少留一档（金额和积分都要大于 0）');
      planSave.disabled = true;
      try {
        S.cfg = await CF().saveConfig({ plans });
        toast('档位已保存：' + plans.map(p => `¥${p.yen}=${p.credits}`).join(' / '));
      } catch (e) { toast('没保存上：' + (e.message || e)); }
      planSave.disabled = false;
    };

    $$('#admBody [data-ok]').forEach(b => {
      b.onclick = async () => {
        const o = (S.orders || []).find(x => String(x.id) === b.dataset.ok);
        if (!o) return;
        if (!confirm(`确认收到 ${yenText(o.amountFen)}（${o.credits.toLocaleString()} 积分）？\n\n单号 ${o.payNo}\n\n点确定之后积分立刻进对方账户，不能撤回。`)) return;
        b.disabled = true;
        try {
          await CF().reviewRecharge(o.id, true, '');
          toast('已通过，积分已到账');
          paintPoints();
        } catch (e) { toast('没通过：' + (e.message || e)); b.disabled = false; }
      };
    });
    $$('#admBody [data-no]').forEach(b => {
      b.onclick = async () => {
        const reason = prompt('驳回原因（对方能看到，写清楚点）：', '没查到这笔单号，请确认后重新提交');
        if (reason == null) return;
        b.disabled = true;
        try {
          await CF().reviewRecharge(Number(b.dataset.no), false, String(reason).slice(0, 120));
          toast('已驳回');
          paintPoints();
        } catch (e) { toast('没驳回：' + (e.message || e)); b.disabled = false; }
      };
    });
  }

  function bindPlanDel() {
    $$('#admPlans .adm-plan-del').forEach(b => {
      b.onclick = () => {
        const row = b.closest('.adm-plan-row');
        if (row) row.remove();
      };
    });
  }

  /* 收款码要能扫得出来，不能压成马赛克：最长边收到 480px、JPEG 0.85 */
  function shrinkImage(file, cb) {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 480;
        const s = Math.min(1, max / Math.max(img.width || max, img.height || max));
        const w = Math.max(1, Math.round(img.width * s));
        const h = Math.max(1, Math.round(img.height * s));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        if (!ctx) return cb('');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        cb(cv.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => cb('');
      img.src = fr.result;
    };
    fr.onerror = () => cb('');
    fr.readAsDataURL(file);
  }

  /* ── 绑定 ── */
  function init() {
    const nav = $('#admNav');
    if (nav) $$('.adm-nav-i', nav).forEach(b => { b.onclick = () => go(b.dataset.page); });
    const ex = $('#admExit');
    if (ex) ex.onclick = close;
    const back = $('#admBack');
    if (back) back.onclick = close;
    /* Esc 退出：后台是全屏的，没有明显关闭位置时会让人困在里面 */
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && S.on) {
        const m = document.querySelector('.mask:not([hidden])');
        if (m) return;            // 有弹层时先让弹层处理
        close();
      }
    });
  }

  window.ADMIN = {
    open, close, go,
    get page() { return S.page; },
    get on() { return S.on; },
    _state: S,
    /* 测试口子：流程节点和闸值不该靠点页面去验 */
    _flow: { task: flowTask, proj: flowProj, fmtW }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
