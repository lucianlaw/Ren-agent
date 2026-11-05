/* evalkit 单测：统计口径错了，整个评测台就是在拿噪声当结论。
   直接跑：node test/evalkit-test.mjs
   不烧 token，不连网，改完统计逻辑必须先过这里。
   注：项目是 type=module，前端脚本没有 ESM 导出，这里按浏览器的方式求值。 */
import fs from 'fs';
const code = fs.readFileSync(new URL('../public/evalkit.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const K = mod.exports;

let bad = 0;
const ok = (name, cond, extra) => {
  if (!cond) bad++;
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ── 基础统计 ── */
ok('mean', near(K.mean([1, 2, 3]), 2));
ok('pct p50 偶数个取最近秩', K.pct([1, 2, 3, 4], 50) === 2, `got ${K.pct([1, 2, 3, 4], 50)}`);
ok('pct p95 小样本取最大', K.pct([10, 20, 30], 95) === 30);
ok('pct 空数组为 0', K.pct([], 95) === 0);
ok('sd 样本标准差', near(K.sd([2, 4, 4, 4, 5, 5, 7, 9]), 2.138, 0.01), `got ${K.sd([2, 4, 4, 4, 5, 5, 7, 9]).toFixed(3)}`);

/* ── McNemar：只有分歧题才算数 ── */
const m1 = K.mcnemar(1, 8); // A 多过 1 题，B 多过 8 题
ok('McNemar 8:1 显著', m1.p < 0.05, `p=${m1.p.toFixed(4)}`);
const m2 = K.mcnemar(5, 5);
ok('McNemar 5:5 完全不显著', m2.p === 1, `p=${m2.p}`);
const m3 = K.mcnemar(3, 6);
ok('McNemar 6:3 不显著', m3.p > 0.05, `p=${m3.p.toFixed(4)}`);
const m4 = K.mcnemar(0, 0);
ok('McNemar 无分歧返回 p=1', m4.p === 1 && m4.n === 0);

/* ── 配对 bootstrap ── */
const b1 = K.pairedBootstrap([1, 1, 1, 1, 1]);
ok('全部同向的差值 → 区间不含 0', b1.excludesZero && near(b1.mean, 1), `[${b1.lo}, ${b1.hi}]`);
const b2 = K.pairedBootstrap([1, -1, 1, -1, 1, -1]);
ok('正负交替 → 区间含 0', !b2.excludesZero, `[${b2.lo.toFixed(2)}, ${b2.hi.toFixed(2)}]`);
const b3 = K.pairedBootstrap([], {});
ok('空输入不炸', b3.n === 0 && b3.mean === 0);
const b4a = K.pairedBootstrap([0.1, 0.2, 0.3, -0.1], { seed: 5 });
const b4b = K.pairedBootstrap([0.1, 0.2, 0.3, -0.1], { seed: 5 });
ok('同种子结果可复现', b4a.lo === b4b.lo && b4a.hi === b4b.hi);

/* ── 聚合 ── */
const items = [
  { caseId: 'a', pass: true, quality: 3.5, ms: 1000, ttftP50: 400, toolCalls: 3, calls: 4, rounds: 1, tokens: { in: 1000, out: 500, reasoning: 200, cached: 0 } },
  { caseId: 'b', pass: false, quality: 2.0, ms: 3000, ttftP50: 900, toolCalls: 5, calls: 6, rounds: 1, tokens: { in: 2000, out: 1000, reasoning: 600, cached: 0 } }
];
const agg = K.aggregate(items);
ok('通过率 1/2', agg.passRate === 0.5);
ok('质量分均值 2.75', near(agg.quality, 2.75));
ok('token 合计 4500', agg.totalTokens === 4500);
ok('每成功成本 = 总积分 / 通过数', near(agg.costPerSuccess, 0.45 / 1), `got ${agg.costPerSuccess}`);
ok('推理占比 = 推理 / 输出', near(agg.reasoningShare, 800 / 1500), `got ${agg.reasoningShare.toFixed(3)}`);
ok('p95 时延取大者', agg.msP95 === 3000);
const agg0 = K.aggregate([{ caseId: 'x', pass: false, ms: 1, tokens: {} }]);
ok('零通过时每成功成本为 null（不是 0）', agg0.costPerSuccess === null);
ok('没测到质量分是 null（不是 0）', agg0.quality === null);

/* ── 配对比较 ── */
const A = [
  { caseId: 'c1', pass: true, quality: 3, ms: 5000, tokens: { in: 1000, out: 500 } },
  { caseId: 'c2', pass: false, quality: 2, ms: 6000, tokens: { in: 2000, out: 1000 } },
  { caseId: 'c3', pass: true, quality: 4, ms: 4000, tokens: { in: 1000, out: 500 } }
];
const B = [
  { caseId: 'c1', pass: true, quality: 3.5, ms: 3000, tokens: { in: 600, out: 300 } },
  { caseId: 'c2', pass: true, quality: 3, ms: 3500, tokens: { in: 1200, out: 600 } },
  { caseId: 'c3', pass: true, quality: 4, ms: 3800, tokens: { in: 900, out: 400 } }
];
const cmp = K.compare(A, B);
ok('配对题数 3', cmp.n === 3);
ok('A 输 1 题、B 赢 1 题', cmp.pass.aWin === 0 && cmp.pass.bWin === 1);
ok('通过率 0.67 → 1.00', near(cmp.pass.aRate, 2 / 3) && near(cmp.pass.bRate, 1));
ok('质量差值均值 +0.5', near(cmp.quality.delta, 0.5), `got ${cmp.quality.delta.toFixed(2)}`);
ok('时延整体变快（负差值）', cmp.latency.delta < 0, `got ${cmp.latency.delta.toFixed(0)}ms`);
ok('token 整体变少', cmp.tokens.delta < 0, `got ${cmp.tokens.delta.toFixed(0)}`);
ok('逐题表标出翻盘题', cmp.pairs.find((p) => p.caseId === 'c2').changed === true);
ok('对不上的题单独列出', K.compare(A, B.slice(0, 2)).onlyA.length === 1);

/* ── 结论生成 ── */
const d1 = K.decide(cmp);
ok('样本 3 道题时提示样本不足', d1.some((x) => x.key === 'sample'));
const big = [];
for (let i = 0; i < 30; i++) {
  big.push({ caseId: 'p' + i, pass: i < 20, quality: 3, ms: 5000, tokens: { in: 1000, out: 500 } });
}
const bigB = big.map((x, i) => ({ ...x, pass: i < 26 }));
const cmpBig = K.compare(big, bigB);
const d2 = K.decide(cmpBig);
ok('30 题里多过 6 题 → McNemar 显著', cmpBig.pass.significant, `p=${cmpBig.pass.p.toFixed(4)}`);
ok('显著提升记为 good', d2.some((x) => x.level === 'good' && x.key === 'pass-up'));
ok('结论判定为可以切', K.verdictOf(cmpBig).code === 'accept');

const worseB = big.map((x, i) => ({ ...x, pass: i < 12 }));
const cmpWorse = K.compare(big, worseB);
ok('显著下降判定为不要切', K.verdictOf(cmpWorse).code === 'reject');

/* 护栏：通过率涨了，但成本翻倍 */
const costlyB = bigB.map((x) => ({ ...x, tokens: { in: 4000, out: 2000 } }));
const cmpCost = K.compare(big, costlyB);
const d3 = K.decide(cmpCost);
ok('成本翻倍触发护栏', d3.some((x) => x.key === 'cost-up'));
ok('护栏破了不给「可以切」', K.verdictOf(cmpCost).code !== 'accept', K.verdictOf(cmpCost).text);

console.log(bad ? `\nFAILED: ${bad} 项` : '\nALL_EVALKIT_OK');
process.exit(bad ? 1 : 0);
