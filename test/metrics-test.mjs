/* 请求级指标：分位要准、内存要有上限、指标自己不能成为故障源
 *
 * 这一层最容易犯的三个错，正是这批判定要挡的：
 *   1. 分位算错（用平均值冒充 p95）——「平均 40ms」和「1% 的请求卡 8 秒」
 *      在用户那里是两种完全不同的体验，混成一个数就永远查不出来。
 *   2. 无上限增长——每个路由存全部样本，跑一周就是内存泄漏，
 *      而症状是「用了几天就变慢」，看起来像模型慢。
 *   3. 把 query 算进路由名——/api/file?path=a 和 ?path=b 变成两个端点，
 *      指标表被几百个「不同路由」淹没，等于没有。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const M = await import('../lib/metrics.js');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const T0 = Date.now();

console.log('\n[1] 分位是「排序后取位」，不是平均值');
{
  M.reset();
  /* 100 个样本：1..99 都是 10ms，最后一个 5000ms。
     平均值会被拉到 60ms 左右，p50 应该还是 10，p95 应该还是 10，max 才是 5000。 */
  for (let i = 0; i < 99; i++) M.record('/api/x', 10, 200, 0, T0 + i);
  M.record('/api/x', 5000, 200, 0, T0 + 100);
  const s = M.summary({ now: T0 + 101 });
  const r = s.routes.find(x => x.route === '/api/x');
  eq('p50 = 10', r.p50, 10);
  eq('p95 = 10（99 个 10ms，一个 5000ms 排在第 100 位）', r.p95, 10);
  eq('max 抓到了那个尖峰', r.max, 5000);
  ok('平均值会骗人（这也是为什么不用它）', (10 * 99 + 5000) / 100 > r.p95);
}

console.log('\n[2] 样本有上限，内存不会自己撑爆');
{
  M.reset();
  for (let i = 0; i < 1200; i++) M.record('/api/big', i, 200, 0, T0);
  const r = M.summary({ now: T0 }).routes.find(x => x.route === '/api/big');
  eq('请求数照数（1200）', r.n, 1200);
  ok('样本只留最近 400 条（所以 p50 是后半段的数）', r.p50 >= 800, r.p50);
  ok('样本上限是常量 400', M.__test.MAX_SAMPLES === 400);

  /* 路由种类也有上限：随机路径不能把 Map 撑到几万条 */
  M.reset();
  for (let i = 0; i < 300; i++) M.record(`/api/r${i}`, 5, 200, 0, T0);
  const s = M.summary({ limit: 500, now: T0 });
  const names = s.routes.map(x => x.route);
  ok('路由数被折到上限内', names.length <= M.__test.MAX_ROUTES, names.length);
  ok('多出来的折进 __other__', names.includes('__other__'), names.slice(-3));
}

console.log('\n[3] 错误率与 QPS');
{
  M.reset();
  for (let i = 0; i < 8; i++) M.record('/api/ok', 20, 200, 0, T0);
  for (let i = 0; i < 2; i++) M.record('/api/ok', 30, 500, 0, T0);
  const s = M.summary({ now: T0 });
  eq('总数 10', s.total, 10);
  eq('错误 2', s.errors, 2);
  eq('错误率 20%', s.errRate, 20);
  const r = s.routes[0];
  eq('单路由错误率 20%', r.errRate, 20);

  /* 一分钟窗口外的样本不算 QPS，但仍然算在总数里 */
  M.reset();
  for (let i = 0; i < 60; i++) M.record('/api/q', 5, 200, 0, T0 - 120000);
  for (let i = 0; i < 60; i++) M.record('/api/q', 5, 200, 0, T0);
  const s2 = M.summary({ now: T0 });
  eq('总数 120', s2.total, 120);
  eq('QPS 只看最近一分钟（60/60 = 1）', s2.routes[0].qps1m, 1);
}

console.log('\n[4] 慢请求单独留档');
{
  M.reset();
  M.record('/api/slow', 2500, 200, 0, T0);
  M.record('/api/fast', 5, 200, 0, T0);
  const s = M.summary({ now: T0 });
  eq('只有一条慢请求', s.slow.length, 1);
  eq('记的是慢的那个端点', s.slow[0].route, '/api/slow');
  eq('耗时取整', s.slow[0].ms, 2500);
  ok('带时间戳（ISO）', /^\d{4}-\d{2}-\d{2}T/.test(s.slow[0].at), s.slow[0].at);
}

console.log('\n[5] 一行摘要：扫一眼就知道有没有在出事');
{
  M.reset();
  M.record('/api/a', 10, 200, 0, T0);
  M.record('/api/a', 20, 500, 0, T0);
  M.record('/api/a', 30, 200, 0, T0);
  M.record('/api/a', 1200, 200, 0, T0);
  const l = M.line(T0);
  ok('含请求数', /4 次请求/.test(l), l);
  ok('含错误率', /错误 25%/.test(l), l);
  ok('含最忙端点与 p95', /最忙 \/api\/a/.test(l) && /p95/.test(l), l);
  ok('空时也不报错', (M.reset(), /0 次请求/.test(M.line(T0))));
}

console.log('\n[6] 路由名不带 query（否则一个端点会变成几百个）');
{
  const src = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
  ok('记录时用的是 pathname 而不是原始 URL', /METRICS\.record\(path0, ms/.test(src), '');
  ok('path0 取的是 new URL(...).pathname', /const path0 = \(\(\) => \{ try \{ return new URL\(req\.url, 'http:\/\/127\.0\.0\.1'\)\.pathname/.test(src), '');
  ok('记录挂在响应结束时（不是请求开始时）', /res\.on\('finish',[\s\S]{0,300}METRICS\.record/.test(src), '');
  ok('/api/metrics 只给运维 key', /u\.pathname === '\/api\/metrics'/.test(src) && /adminOK/.test(src), '');
  ok('health 带一行摘要', /METRICS\.line\(\)/.test(src));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
