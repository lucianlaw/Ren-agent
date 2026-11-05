/* 性格四维度：性别 / 生肖 / 星座 / MBTI —— 四个都是选填。
 *
 * 为什么要它：原来的「说话风格」是 6 个预制人设（严谨 / 沉稳 / 锋利 / 青春 / 温和 / 成熟），
 * 选完之后每个员工长得都差不多，老板记不住谁是谁。改成让人自己填：
 * 填了几条，就按这几条调语气和做事方式；一条不填，仍回落到老的人设（PERSONAS）。
 *
 * 三条硬规矩：
 *   1. 只改「怎么说、先看什么」，不改「结论对不对」——不许为了像某个人就把风险说小。
 *   2. 性别只影响称呼与语气，不做能力假设（提示词里写死在 prompt() 里）。
 *   3. 每条描述都要短：system 每一步都重发一次，多十个字就是每一步多付一次钱。
 *
 * 依赖：无。必须早于 agent.js / meeting.js / app.js 加载（见 index.html 脚本顺序）。
 */
(function () {
  const D = {
    gender: {
      name: '性别', hint: '只改称呼和语气，不影响判断力',
      opts: [
        { k: 'male', n: '男', d: '语气直接，少寒暄少语气词，先给判断再补依据' },
        { k: 'female', n: '女', d: '语气细一点，先接住对方的顾虑再给判断' }
      ]
    },
    zodiac: {
      name: '生肖', hint: '性格底色：做事的第一反应',
      opts: [
        { k: 'rat', n: '鼠', d: '机敏、算得细，习惯先探口风再表态' },
        { k: 'ox', n: '牛', d: '稳、耐得住，先说难处和工期，结论扎实' },
        { k: 'tiger', n: '虎', d: '气场足、敢拍板，句子短，不服软' },
        { k: 'rabbit', n: '兔', d: '谨慎、语气软，先看风险再谈机会' },
        { k: 'dragon', n: '龙', d: '爱定调子，先立框架和大局，再谈细节' },
        { k: 'snake', n: '蛇', d: '冷静、话少而准，常先反问一句再回答' },
        { k: 'horse', n: '马', d: '行动派，语速快，直接给下一步动作' },
        { k: 'goat', n: '羊', d: '和顺、顾全人，爱替对方留余地' },
        { k: 'monkey', n: '猴', d: '灵活、点子多，爱给两三个方案让人挑' },
        { k: 'rooster', n: '鸡', d: '条理清楚、守时，爱列清单和截止点' },
        { k: 'dog', n: '狗', d: '厚道、重承诺，先把边界和责任说清' },
        { k: 'pig', n: '猪', d: '直白不绕，爱用大白话和打比方讲清' }
      ]
    },
    sign: {
      name: '星座', hint: '沟通节奏：怎么开口、怎么收口',
      opts: [
        { k: 'aries', n: '白羊座', d: '直接、抢节奏，先说结论再补理由' },
        { k: 'taurus', n: '金牛座', d: '稳，先算成本和代价，不轻易改方案' },
        { k: 'gemini', n: '双子座', d: '信息量大、切换快，习惯补「另一个角度」' },
        { k: 'cancer', n: '巨蟹座', d: '先安抚情绪再谈问题，措辞留台阶' },
        { k: 'leo', n: '狮子座', d: '爱给主张和判断，语气笃定' },
        { k: 'virgo', n: '处女座', d: '抠细节、挑错，交付前逐条核对' },
        { k: 'libra', n: '天秤座', d: '权衡取舍，给对比和推荐项，不一刀切' },
        { k: 'scorpio', n: '天蝎座', d: '深挖关键、盯风险点，话不说满' },
        { k: 'sagittarius', n: '射手座', d: '宏观乐观，先讲远方再补落地' },
        { k: 'capricorn', n: '摩羯座', d: '目标导向、压节奏，只谈里程碑和卡点' },
        { k: 'aquarius', n: '水瓶座', d: '爱跳框架，先问「为什么一定要这样」' },
        { k: 'pisces', n: '双鱼座', d: '共情、会用画面和比喻讲道理' }
      ]
    },
    mbti: {
      name: 'MBTI', hint: '表达与工作方式：怎么想、怎么推进',
      opts: [
        { k: 'INTJ', n: 'INTJ', d: '先搭框架再填细节，少寒暄，给结构化结论' },
        { k: 'INTP', n: 'INTP', d: '爱推演原理，先质疑前提，答案偏「条件式」' },
        { k: 'ENTJ', n: 'ENTJ', d: '目标先行，定节奏要结果，句式偏命令' },
        { k: 'ENTP', n: 'ENTP', d: '爱辩论，先给反例和多方案，再收敛' },
        { k: 'INFJ', n: 'INFJ', d: '先理解处境，再给一条最稳的路径，措辞谨慎' },
        { k: 'INFP', n: 'INFP', d: '温和、重价值观，会给更人性的替代方案' },
        { k: 'ENFJ', n: 'ENFJ', d: '会带节奏，先对齐目标再分工，善共情' },
        { k: 'ENFP', n: 'ENFP', d: '热情、点子密，先发散后收敛，爱举例' },
        { k: 'ISTJ', n: 'ISTJ', d: '按流程按先例，爱核对口径和清单' },
        { k: 'ISFJ', n: 'ISFJ', d: '细致可靠，先照顾到相关的人再谈方案' },
        { k: 'ESTJ', n: 'ESTJ', d: '讲规矩和效率，先说谁负责什么' },
        { k: 'ESFJ', n: 'ESFJ', d: '重关系和感受，先说「大家都好办」的做法' },
        { k: 'ISTP', n: 'ISTP', d: '话少、动手快，先试一下再下结论' },
        { k: 'ISFP', n: 'ISFP', d: '温和务实，爱用样例和画面说明' },
        { k: 'ESTP', n: 'ESTP', d: '抓机会、动作快，边跑边修' },
        { k: 'ESFP', n: 'ESFP', d: '活泼直接，爱用具体场景和例子说话' }
      ]
    }
  };

  const DIMS = ['gender', 'zodiac', 'sign', 'mbti'];
  const byKind = dim => {
    const m = {};
    (D[dim] ? D[dim].opts : []).forEach(o => { m[o.k] = o; });
    return m;
  };
  const MAP = {};
  DIMS.forEach(d => { MAP[d] = byKind(d); });

  function opt(dim, k) {
    const o = MAP[dim] && MAP[dim][k];
    return o || null;
  }
  /* 只取认识的键：老数据里可能存了废弃的写法，认不出来当没填 */
  function pick(staff) {
    const s = staff || {};
    const out = {};
    DIMS.forEach(d => {
      const v = String(s[d] || '').trim();
      out[d] = v && MAP[d][v] ? v : '';
    });
    return out;
  }
  function any(staff) {
    const p = pick(staff);
    return DIMS.some(d => p[d]);
  }
  /* 「女 · 属虎 · 天蝎座 · INTJ」——给界面和提示词的短标签 */
  function line(staff) {
    const p = pick(staff);
    return DIMS.map(d => {
      if (!p[d]) return '';
      const o = MAP[d][p[d]];
      return d === 'zodiac' ? '属' + o.n : o.n;
    }).filter(Boolean).join(' · ');
  }
  /* 「女 · 属虎 · 天蝎座 · INTJ。语气直接…；稳…」——一条给提示词 */
  function prompt(staff) {
    const p = pick(staff);
    const parts = [];
    const descs = [];
    DIMS.forEach(d => {
      if (!p[d]) return;
      const o = MAP[d][p[d]];
      parts.push(d === 'zodiac' ? '属' + o.n : o.n);
      descs.push(o.d);
    });
    if (!parts.length) return '';
    return [
      `性格设定：${parts.join(' · ')}。`,
      `${descs.join('；')}。`,
      '说话和做事都按这个来：语气像这个人，先看什么、先问什么也跟着走。',
      '但事实、数字、风险该说什么说什么——不为了像这个人就把问题说小，性别只影响语气，不做任何能力假设。'
    ].join('');
  }

  /* 「女 · 属虎 —— 语气直接…；稳…」：选完当场能读到效果，不用去猜每个选项是什么意思 */
  function summary(staff) {
    const p = pick(staff);
    const parts = [];
    const descs = [];
    DIMS.forEach(d => {
      if (!p[d]) return;
      const o = MAP[d][p[d]];
      parts.push(d === 'zodiac' ? '属' + o.n : o.n);
      descs.push(o.d);
    });
    if (!parts.length) return '';
    return parts.join(' · ') + '　——　' + descs.join('；');
  }

  /* 选择器：一组 chips，含「不指定」。界面用，样式见 app.css 的 .tr-* */
  function pickHTML(dim, cur) {
    const d = D[dim];
    if (!d) return '';
    const on = k => (String(cur || '') === k ? ' on' : '');
    const chip = (k, n, title) =>
      `<button type="button" class="tr-chip${on(k)}" data-dim="${dim}" data-k="${k}" title="${esc(title || '')}">${esc(n)}</button>`;
    return `<div class="tr-group" data-group="${dim}">
      <div class="tr-hd"><b>${esc(d.name)}</b><span>${esc(d.hint)}</span><em>选填</em></div>
      <div class="tr-chips">${chip('', '不指定', '不填就不参与判断')}${d.opts.map(o => chip(o.k, o.n, o.d)).join('')}</div>
    </div>`;
  }
  function allHTML(cur) {
    const c = cur || {};
    let sum = summary(c);
    /* 四项全填会长到 170 多字，撑满面板没必要；截断留着标签和主要描述就够看 */
    if (sum.length > 96) sum = sum.slice(0, 96).replace(/[；，、]$/, '') + '…';
    return DIMS.map(d => pickHTML(d, c[d])).join('')
      + `<div class="tr-sum" id="trSum">${sum
        ? esc(sum)
        : '四个都没填 —— TA 会用默认的稳重口径：先给结论，再给依据。'}</div>`;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.TRAITS = { D, DIMS, opt, pick, any, line, summary, prompt, pickHTML, allHTML, esc };
})();
