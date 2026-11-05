/* 评测统计内核（纯函数，不碰 DOM，不碰网络）
 *
 * 为什么单独拆出来：指标口径和显著性检验一旦掺进界面代码，就再也没法单测了。
 * 而「两版模型差 8% 算不算数」这件事，本身是可以被证伪的——12 道题 + 一道题翻面
 * 就能造出 8%，那不是结论，是噪声。
 *
 * 口径来源：《深入理解 AI Agent》第 7 章
 *   - Pass^k 衡量业务可靠性，Pass@k 衡量能力上限，两个必须分开报
 *   - 同一批题比较两个配置，用配对分析（McNemar / paired bootstrap），不要直接相减
 *   - 分差要超过噪声、配对显著、并且能复现，才值得据此切换
 *
 * 这里只做计算，不做判断以外的动作；结论文字由 decide() 统一生成，
 * 保证「同一个数字在界面上和在日志里说的是同一句话」。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EVALKIT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CREDIT_PER_TOKEN = 1 / 10000;

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

  function sum(a) {
    let s = 0;
    for (const x of a || []) s += num(x);
    return s;
  }

  function mean(a) {
    const arr = (a || []).filter((x) => typeof x === 'number' && isFinite(x));
    return arr.length ? sum(arr) / arr.length : 0;
  }

  /* 百分位用「最近秩」：小样本下比线性插值稳，也不会在 n=3 时给出不存在的值 */
  function pct(a, p) {
    const arr = (a || []).filter((x) => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y);
    if (!arr.length) return 0;
    const i = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
    return arr[i];
  }

  function sd(a) {
    const arr = (a || []).filter((x) => typeof x === 'number' && isFinite(x));
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(sum(arr.map((x) => (x - m) * (x - m))) / (arr.length - 1));
  }

  function credits(tokens) {
    return num(tokens) * CREDIT_PER_TOKEN;
  }

  /* ── 二项系数：只在小样本上用，n 大了走正态近似 ── */
  function binom(n, k) {
    if (k < 0 || k > n) return 0;
    let r = 1;
    const kk = Math.min(k, n - k);
    for (let i = 0; i < kk; i++) r = (r * (n - i)) / (i + 1);
    return r;
  }

  /* McNemar 精确检验：只吃「不一致的那几对」
     两个模型都过的题、都没过的题，对判断差异毫无信息量，掺进分母只会稀释信号。 */
  function mcnemar(aWin, bWin) {
    const b = Math.max(0, Math.round(num(aWin)));
    const c = Math.max(0, Math.round(num(bWin)));
    const n = b + c;
    if (!n) return { b, c, n: 0, p: 1, note: '没有出现分歧的题' };
    let p;
    if (n <= 200) {
      const k = Math.min(b, c);
      let cum = 0;
      for (let i = 0; i <= k; i++) cum += binom(n, i);
      p = Math.min(1, (2 * cum) / Math.pow(2, n));
    } else {
      /* 大样本：连续性校正的正态近似 */
      const z = (Math.abs(b - c) - 1) / Math.sqrt(n);
      p = z <= 0 ? 1 : 2 * (1 - normCdf(z));
    }
    return { b, c, n, p };
  }

  function normCdf(z) {
    /* Abramowitz & Stegun 7.1.26，误差 < 1.5e-7，够用来判 0.05 */
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const p = 1 - d * t * (1.330274429 * Math.pow(t, 4) - 1.821255978 * Math.pow(t, 3)
      + 1.781477937 * t * t - 0.356563782 * t + 0.319381530);
    return z >= 0 ? p : 1 - p;
  }

  /* 固定种子的随机数：同一次对比跑两遍必须给出同一个置信区间，
     否则「昨天显著、今天不显著」会被当成系统不稳定。 */
  function mulberry32(a) {
    let s = a >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 配对 bootstrap：对「每道题的差值」重采样，
     而不是对两组各自的均值重采样——后者的区间里混着题目难度差异。 */
  function pairedBootstrap(deltas, opt) {
    const o = opt || {};
    const iters = o.iters || 2000;
    const alpha = o.alpha == null ? 0.05 : o.alpha;
    const arr = (deltas || []).filter((x) => typeof x === 'number' && isFinite(x));
    if (!arr.length) return { n: 0, mean: 0, lo: 0, hi: 0, excludesZero: false };
    const rnd = mulberry32(o.seed || 20261102);
    const means = new Array(iters);
    for (let i = 0; i < iters; i++) {
      let s = 0;
      for (let j = 0; j < arr.length; j++) s += arr[Math.floor(rnd() * arr.length)];
      means[i] = s / arr.length;
    }
    means.sort((x, y) => x - y);
    const lo = means[Math.max(0, Math.floor((alpha / 2) * iters))];
    const hi = means[Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1)];
    const m = mean(arr);
    return { n: arr.length, mean: m, lo, hi, excludesZero: lo > 0 || hi < 0 };
  }

  /* ── 单侧指标聚合 ──
     输入是「一个变体跑完的一批用例」，输出是这套口径下的全部指标。
     缺失的指标返回 null 而不是 0——0 会被当成「测出来是 0」，null 才是「没测」。 */
  function aggregate(items) {
    const list = (items || []).filter(Boolean);
    const n = list.length;
    const passN = list.filter((x) => x.pass).length;
    const qs = list.map((x) => x.quality).filter((v) => typeof v === 'number' && isFinite(v));
    const ms = list.map((x) => num(x.ms)).filter((v) => v > 0);
    const ttfts = list.map((x) => num(x.ttftP50)).filter((v) => v > 0);
    const t = { in: 0, out: 0, reasoning: 0, cached: 0 };
    for (const x of list) {
      const k = x.tokens || {};
      t.in += num(k.in);
      t.out += num(k.out);
      t.reasoning += num(k.reasoning);
      t.cached += num(k.cached);
    }
    const total = t.in + t.out;
    const cr = credits(total);
    return {
      n,
      passN,
      passRate: n ? passN / n : 0,
      quality: qs.length ? mean(qs) : null,
      qualityN: qs.length,
      msP50: pct(ms, 50),
      msP95: pct(ms, 95),
      ttftP50: ttfts.length ? pct(ttfts, 50) : null,
      ttftP95: ttfts.length ? pct(ttfts, 95) : null,
      tokens: t,
      totalTokens: total,
      credits: cr,
      costPerTask: n ? cr / n : 0,
      /* 便宜但老失败，算下来更贵——这个指标比「平均成本」诚实 */
      costPerSuccess: passN ? cr / passN : null,
      toolCalls: mean(list.map((x) => num(x.toolCalls))),
      calls: mean(list.map((x) => num(x.calls))),
      rounds: n ? mean(list.map((x) => num(x.rounds) || 1)) : 0,
      reasoningShare: t.out ? t.reasoning / t.out : 0,
      errorN: list.filter((x) => x.error).length
    };
  }

  /* 逐题对齐两个变体。对不上的题不参与比较——拿 A 的第 3 题去比 B 的第 5 题，
     比出来的东西没有任何意义。 */
  function pairUp(aItems, bItems) {
    const mapB = new Map(((bItems || []).filter(Boolean)).map((x) => [x.caseId, x]));
    const pairs = [];
    const onlyA = [];
    for (const a of (aItems || []).filter(Boolean)) {
      const b = mapB.get(a.caseId);
      if (b) pairs.push({ caseId: a.caseId, title: a.title || b.title || a.caseId, a, b });
      else onlyA.push(a.caseId);
    }
    const seenA = new Set((aItems || []).map((x) => x && x.caseId));
    const onlyB = (bItems || []).filter((x) => x && !seenA.has(x.caseId)).map((x) => x.caseId);
    return { pairs, onlyA, onlyB };
  }

  function tokenTotal(x) {
    const t = (x && x.tokens) || {};
    return num(t.in) + num(t.out);
  }

  /* A = 旧的/基线，B = 新的/候选 */
  function compare(aItems, bItems) {
    const up = pairUp(aItems, bItems);
    const pairs = up.pairs;
    let aWin = 0; // A 过、B 没过
    let bWin = 0; // B 过、A 没过
    const qDeltas = [];
    const msDeltas = [];
    const tokDeltas = [];
    const ttftDeltas = [];
    const rows = [];
    for (const p of pairs) {
      const aPass = !!p.a.pass;
      const bPass = !!p.b.pass;
      if (aPass && !bPass) aWin++;
      if (!aPass && bPass) bWin++;
      const aq = typeof p.a.quality === 'number' ? p.a.quality : null;
      const bq = typeof p.b.quality === 'number' ? p.b.quality : null;
      const dq = aq != null && bq != null ? bq - aq : null;
      if (dq != null) qDeltas.push(dq);
      const dms = num(p.b.ms) - num(p.a.ms);
      if (num(p.a.ms) > 0 && num(p.b.ms) > 0) msDeltas.push(dms);
      const dtok = tokenTotal(p.b) - tokenTotal(p.a);
      tokDeltas.push(dtok);
      const att = num(p.a.ttftP50);
      const btt = num(p.b.ttftP50);
      if (att > 0 && btt > 0) ttftDeltas.push(btt - att);
      rows.push({
        caseId: p.caseId,
        title: p.title,
        aPass, bPass,
        aQuality: aq, bQuality: bq, dq,
        aMs: num(p.a.ms), bMs: num(p.b.ms), dms,
        aTok: tokenTotal(p.a), bTok: tokenTotal(p.b), dtok,
        aReason: num((p.a.tokens || {}).reasoning),
        bReason: num((p.b.tokens || {}).reasoning),
        aFail: firstFail(p.a),
        bFail: firstFail(p.b),
        changed: aPass !== bPass || (dq != null && Math.abs(dq) >= 0.5)
      });
    }

    const aggA = aggregate(aItems);
    const aggB = aggregate(bItems);
    const mc = mcnemar(aWin, bWin);
    const qBoot = pairedBootstrap(qDeltas, { seed: 7 });
    const msBoot = pairedBootstrap(msDeltas, { seed: 11 });
    const tokBoot = pairedBootstrap(tokDeltas, { seed: 13 });
    const ttftBoot = pairedBootstrap(ttftDeltas, { seed: 17 });

    return {
      pairs: rows,
      onlyA: up.onlyA,
      onlyB: up.onlyB,
      n: rows.length,
      aggA,
      aggB,
      pass: {
        aRate: aggA.passRate,
        bRate: aggB.passRate,
        delta: aggB.passRate - aggA.passRate,
        aWin, bWin,
        p: mc.p,
        significant: mc.p < 0.05 && mc.n > 0,
        note: mc.note
      },
      quality: {
        a: aggA.quality,
        b: aggB.quality,
        delta: qBoot.mean,
        lo: qBoot.lo,
        hi: qBoot.hi,
        n: qBoot.n,
        significant: qBoot.n >= 3 && qBoot.excludesZero
      },
      latency: {
        aP50: aggA.msP50, bP50: aggB.msP50,
        aP95: aggA.msP95, bP95: aggB.msP95,
        delta: msBoot.mean, lo: msBoot.lo, hi: msBoot.hi,
        significant: msBoot.n >= 3 && msBoot.excludesZero
      },
      ttft: {
        aP50: aggA.ttftP50, bP50: aggB.ttftP50,
        delta: ttftBoot.mean, lo: ttftBoot.lo, hi: ttftBoot.hi,
        significant: ttftBoot.n >= 3 && ttftBoot.excludesZero
      },
      tokens: {
        aTotal: aggA.totalTokens, bTotal: aggB.totalTokens,
        delta: tokBoot.mean, lo: tokBoot.lo, hi: tokBoot.hi,
        significant: tokBoot.n >= 3 && tokBoot.excludesZero,
        aReason: aggA.tokens.reasoning, bReason: aggB.tokens.reasoning,
        aReasonShare: aggA.reasoningShare, bReasonShare: aggB.reasoningShare
      },
      cost: {
        aPerTask: aggA.costPerTask, bPerTask: aggB.costPerTask,
        aPerSuccess: aggA.costPerSuccess, bPerSuccess: aggB.costPerSuccess,
        deltaPerSuccess: (aggB.costPerSuccess != null && aggA.costPerSuccess != null)
          ? aggB.costPerSuccess - aggA.costPerSuccess : null
      }
    };
  }

  function firstFail(item) {
    const r = (item && item.results) || [];
    const bad = r.find((x) => !x.pass);
    return bad ? { type: bad.type, msg: bad.msg } : null;
  }

  /* 结论生成：把一堆数字压成几句能直接照着做的话。
     分开写的好处是同一条结论可以同时进界面和进差异日志，不会两处说法不一致。 */
  function decide(comp, opt) {
    const o = opt || {};
    const out = [];
    if (!comp || !comp.n) {
      return [{ level: 'warn', key: 'empty', text: '两个变体没有可配对的题，先各跑一遍同一批用例。' }];
    }
    const p = comp.pass;
    const guardCost = o.costGuard == null ? 0.1 : o.costGuard;
    const guardLatency = o.latencyGuard == null ? 0.2 : o.latencyGuard;

    if (p.significant) {
      out.push(p.delta > 0
        ? { level: 'good', key: 'pass-up', text: `通过率显著提升：${fmtPct(p.aRate)} → ${fmtPct(p.bRate)}（McNemar p=${p.p.toFixed(3)}，B 多过 ${p.bWin} 题、A 多过 ${p.aWin} 题）` }
        : { level: 'bad', key: 'pass-down', text: `通过率显著下降：${fmtPct(p.aRate)} → ${fmtPct(p.bRate)}（McNemar p=${p.p.toFixed(3)}，A 多过 ${p.aWin} 题、B 多过 ${p.bWin} 题），不建议切换` });
    } else {
      out.push({
        level: 'warn', key: 'pass-noise',
        text: `通过率差异 ${fmtPp(p.delta)} 落在噪声内（McNemar p=${p.p.toFixed(3)}，只有 ${p.aWin + p.bWin} 道题结果不同），不足以支持切换结论`
      });
    }

    if (comp.quality.n >= 3) {
      if (comp.quality.significant) {
        out.push(comp.quality.delta > 0
          ? { level: 'good', key: 'quality-up', text: `产出质量显著变好：${fmtQ(comp.quality.a)} → ${fmtQ(comp.quality.b)}，95% 区间 ${fmtSigned(comp.quality.lo, 2)}～${fmtSigned(comp.quality.hi, 2)}` }
          : { level: 'bad', key: 'quality-down', text: `产出质量显著变差：${fmtQ(comp.quality.a)} → ${fmtQ(comp.quality.b)}，95% 区间 ${fmtSigned(comp.quality.lo, 2)}～${fmtSigned(comp.quality.hi, 2)}` });
      } else {
        out.push({ level: 'info', key: 'quality-noise', text: `质量分差异 ${fmtSigned(comp.quality.delta, 2)} 未超噪声（区间 ${fmtSigned(comp.quality.lo, 2)}～${fmtSigned(comp.quality.hi, 2)}，n=${comp.quality.n}）` });
      }
    }

    if (comp.cost.deltaPerSuccess != null && comp.aggA.costPerSuccess) {
      const r = comp.cost.deltaPerSuccess / comp.aggA.costPerSuccess;
      if (r > guardCost) {
        out.push({ level: 'bad', key: 'cost-up', text: `护栏破：每成功一次的成本涨了 ${fmtPct(r)}（${comp.cost.aPerSuccess.toFixed(1)} → ${comp.cost.bPerSuccess.toFixed(1)} 积分）` });
      } else if (r < -guardCost) {
        out.push({ level: 'good', key: 'cost-down', text: `每成功一次的成本降了 ${fmtPct(-r)}（${comp.cost.aPerSuccess.toFixed(1)} → ${comp.cost.bPerSuccess.toFixed(1)} 积分）` });
      }
    }

    const p95 = comp.latency.aP95;
    if (p95 > 0) {
      const r = (comp.latency.bP95 - p95) / p95;
      if (r > guardLatency) {
        out.push({ level: 'bad', key: 'latency-up', text: `护栏破：p95 时延涨了 ${fmtPct(r)}（${fmtMs(p95)} → ${fmtMs(comp.latency.bP95)}）` });
      } else if (r < -guardLatency) {
        out.push({ level: 'good', key: 'latency-down', text: `p95 时延降了 ${fmtPct(-r)}（${fmtMs(p95)} → ${fmtMs(comp.latency.bP95)}）` });
      }
    }

    if (comp.ttft.aP50 && comp.ttft.bP50) {
      const r = (comp.ttft.bP50 - comp.ttft.aP50) / comp.ttft.aP50;
      if (Math.abs(r) >= 0.15) {
        out.push({
          level: r > 0 ? 'warn' : 'info', key: 'ttft',
          text: `首 token 延迟 ${fmtMs(comp.ttft.aP50)} → ${fmtMs(comp.ttft.bP50)}（${fmtPct(r)}）`
        });
      }
    }

    if (comp.tokens.aReason || comp.tokens.bReason) {
      const a = comp.tokens.aReason;
      const b = comp.tokens.bReason;
      const r = a ? (b - a) / a : 0;
      out.push({
        level: Math.abs(r) >= 0.3 ? 'info' : 'info', key: 'reasoning',
        text: `推理 token ${a.toLocaleString()} → ${b.toLocaleString()}（${a ? fmtPct(r) : '基线为 0'}），占输出比重 ${fmtPct(comp.tokens.aReasonShare)} → ${fmtPct(comp.tokens.bReasonShare)}`
      });
    }

    if (comp.n < 20) {
      out.push({ level: 'warn', key: 'sample', text: `样本只有 ${comp.n} 道题：这个规模只能筛方向，下「可以切」的结论至少要 30 道题或每题多跑几次` });
    }

    return out;
  }

  function verdictOf(comp) {
    const list = decide(comp);
    if (list.some((x) => x.key === 'pass-down')) return { code: 'reject', text: '不要切' };
    if (list.some((x) => x.key === 'pass-up') && !list.some((x) => x.key === 'cost-up' || x.key === 'latency-up')) {
      return { code: 'accept', text: '可以切' };
    }
    if (list.some((x) => x.key === 'pass-up')) return { code: 'conditional', text: '能力变好但护栏破了，看具体场景' };
    return { code: 'inconclusive', text: '差异在噪声内' };
  }

  /* ── 展示格式 ── */
  function fmtPct(v) {
    if (v == null || !isFinite(v)) return '—';
    return (v * 100).toFixed(0) + '%';
  }
  function fmtPp(v) {
    if (v == null || !isFinite(v)) return '—';
    const s = (v * 100);
    return (s > 0 ? '+' : '') + s.toFixed(1) + 'pp';
  }
  function fmtSigned(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d);
  }
  function fmtMs(v) {
    if (!v && v !== 0) return '—';
    const n = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    return n >= 1000 ? sign + (n / 1000).toFixed(1) + 's' : sign + Math.round(n) + 'ms';
  }
  function fmtTok(v) {
    const raw = num(v);
    const n = Math.abs(raw);
    const sign = raw < 0 ? '-' : '';
    if (n >= 1000000) return sign + (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return sign + (n / 1000).toFixed(1) + 'k';
    return sign + String(Math.round(n));
  }
  function fmtQ(v) {
    return v == null ? '—' : v.toFixed(2) + '/4';
  }

  return {
    CREDIT_PER_TOKEN,
    sum, mean, pct, sd, credits,
    binom, mcnemar, normCdf, pairedBootstrap,
    aggregate, pairUp, compare, decide, verdictOf, firstFail,
    fmtPct, fmtPp, fmtSigned, fmtMs, fmtTok, fmtQ
  };
});
