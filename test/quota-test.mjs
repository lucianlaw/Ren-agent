/* 账号级额度：token 与磁盘
 *
 * 这套测试盯的是「配额是不是真的在起作用」，不是「函数能不能调通」。
 * 一条配额如果只是记数、不拦人，它比没有更糟：仪表盘上显示「已用 120%」，
 * 而任务照跑——所有人都会以为有保护。
 *
 * 所以要验六件事：
 *   1. 记账准不准（含跨天翻转、估算与精确分开记）
 *   2. 超限会不会被拒（发起前 402，不是事后追认）
 *   3. 落盘与重载（重启不能把用量清零——那是最好用的绕限方法）
 *   4. 磁盘是「写前检查」（不是写爆了再告诉你）
 *   5. 冻结之后所有写入口都拒（shell 是唯一拦不住的，靠事后实测兜底）
 *   6. 用户清完文件能自己解冻，但不能贴着上限解冻
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-'));
process.env.REN_USAGE_DIR = path.join(TMP, 'usage');
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
process.env.REN_TOKEN_DAILY = '10000';
process.env.REN_TOKEN_MONTHLY = '50000';
process.env.REN_DISK_MB = '1';

/* 动态 import：quota.js 在加载时就读环境变量，静态 import 会让上面三行来不及生效 */
const q = await import('../lib/quota.js');
const ws = await import('../lib/workspace.js');

const S1 = 'a'.repeat(32);
const S2 = 'b'.repeat(32);

console.log('[1] 默认额度与按账号覆盖');
{
  const lim = q.limitsOf(S1);
  eq('日额度取环境变量', lim.tokenDaily, 10000);
  eq('月额度取环境变量', lim.tokenMonthly, 50000);
  eq('磁盘额度换算成字节', lim.diskBytes, 1048576);

  const r = q.setLimits(S2, { tokenDaily: 1234 });
  ok('设置覆盖成功', r.ok, r);
  eq('覆盖后的日额度', q.limitsOf(S2).tokenDaily, 1234);
  eq('未覆盖的字段仍走默认', q.limitsOf(S2).tokenMonthly, 50000);

  const bad = q.setLimits(S2, { tokenDaily: -5 });
  ok('非法值被拒', !bad.ok, bad);
  const badScope = q.setLimits('not-a-scope', { tokenDaily: 5 });
  ok('非法 scope 被拒', !badScope.ok, badScope);
  q.setLimits(S2, { tokenDaily: null });
  eq('传 null 取消覆盖', q.limitsOf(S2).tokenDaily, 10000);
}

console.log('[2] token 记账');
{
  q.__test.reset();
  const before = q.tokenStatus(S1);
  eq('初始为 0', before.day.used, 0);

  const r1 = q.recordTokens(S1, { total: 3000, exact: true });
  eq('精确记账', r1.consumed, 3000);
  eq('未超限', r1.exceeded, '');

  q.recordTokens(S1, { total: 1000, exact: false });
  const s = q.tokenStatus(S1);
  eq('日累计', s.day.used, 4000);
  eq('精确与估算分开记', [s.exact, s.estimated], [3000, 1000]);
  ok('估算占比可读', s.estimatedRatio > 0.2 && s.estimatedRatio < 0.3, s.estimatedRatio);
  eq('调用次数', s.calls, 2);

  const r2 = q.recordTokens(S1, { total: 6000, exact: true });
  eq('撞日额度时返回 day', r2.exceeded, 'day');
  eq('撞线值仍如实累加', q.tokenStatus(S1).day.used, 10000);

  const gate = q.checkTokens(S1);
  ok('超限后发起被拒', !gate.ok, gate);
  eq('拒绝码', gate.code, 'token_quota');
  eq('指出是哪一档', gate.where, 'day');
  ok('错误里带重置时间', /重置/.test(gate.error), gate.error);
  ok('返回里带完整状态', !!gate.status && !!gate.status.day.resetAt);
}

console.log('[3] 跨天翻转');
{
  q.__test.reset();
  /* 直接改写落盘文件，模拟「昨天用完了」——改系统时钟不现实 */
  const f = path.join(process.env.REN_USAGE_DIR, `${S1}.json`);
  q.recordTokens(S1, { total: 9000, exact: true });
  q.flush();
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  rec.day = '2000-01-01';
  rec.dayTokens = 9999;
  rec.month = q.__test.monthKey();
  fs.writeFileSync(f, JSON.stringify(rec));
  q.__test.reset();

  const s = q.tokenStatus(S1);
  eq('昨天用满不影响今天', s.day.used, 0);
  eq('day key 已翻到今天', s.day.key, q.__test.dayKey());
  const g = q.checkTokens(S1);
  ok('翻转后可以发起', g.ok, g);
}

console.log('[4] 落盘与重载');
{
  q.__test.reset();
  q.recordTokens(S2, { total: 777, exact: true });
  q.flush();
  const file = path.join(process.env.REN_USAGE_DIR, `${S2}.json`);
  ok('用量文件已落盘', fs.existsSync(file), file);
  q.__test.reset();                  // 清掉内存缓存，相当于重启
  const s = q.tokenStatus(S2);
  eq('重启后用量还在（重启不等于重置）', s.day.used, 777);
}

console.log('[5] 磁盘：写前检查');
{
  const root = ws.scopeRoot(S1);
  fs.mkdirSync(root, { recursive: true });
  q.noteDisk(S1, 0);

  const add = 100 * 1024;
  eq('小文件放行', q.checkDisk(S1, add).ok, true);
  fs.writeFileSync(path.join(root, 'a.bin'), Buffer.alloc(add));
  q.noteDisk(S1, add);

  const u = q.diskUsage(S1, { fresh: true });
  eq('实测体积', u.bytes, add);

  const big = 2 * 1024 * 1024;
  const gate = q.checkDisk(S1, big);
  ok('超限被拒', !gate.ok, gate);
  eq('拒绝码', gate.code, 'disk_quota');
  ok('错误里给出已用与上限', /已用/.test(gate.error) && /上限/.test(gate.error), gate.error);

  const st = q.diskStatus(S1, { fresh: true });
  eq('状态里的百分比', st.pct, 9.8);
  ok('状态里有最大的文件', st.top.length === 1 && st.top[0].path === 'a.bin', st.top);
}

console.log('[6] 冻结：拦的是所有写入口');
{
  const fr = q.freeze(S1, '测试：故意超限');
  ok('冻结成功', fr.ok, fr);
  ok('isFrozen 为真', q.isFrozen(S1));
  const gate = q.checkDisk(S1, 1);
  ok('冻结后哪怕写 1 字节也被拒', !gate.ok, gate);
  eq('拒绝码是 frozen 而不是 quota', gate.code, 'disk_frozen');
  ok('原因带在错误里', /故意超限/.test(gate.error), gate.error);

  const d = q.diskStatus(S1, { fresh: true });
  ok('状态里能读到冻结原因', d.frozen && /故意超限/.test(d.frozenReason), d);
}

console.log('[7] shell 事后实测 → 超限冻结');
{
  const S3 = 'c'.repeat(32);
  const root = ws.scopeRoot(S3);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'huge.bin'), Buffer.alloc(2 * 1024 * 1024));
  const r = q.reconcileShell(S3);
  ok('实测超限', !r.ok, r);
  ok('并自动冻结', q.isFrozen(S3));
  ok('冻结原因是实测值', /实测/.test(q.diskStatus(S3, { fresh: true }).frozenReason));
}

console.log('[8] 解冻');
{
  const t = q.thaw(S1);
  ok('解冻成功', t.ok && t.was, t);
  ok('解冻后不再冻结', !q.isFrozen(S1));
  /* 解冻了但磁盘还是 100KB/1MB，仍在额度内 */
  ok('额度内可以继续写', q.checkDisk(S1, 1000).ok);
}

console.log('[9] 报告与运维视图');
{
  const rep = q.quotaReport(S2);
  ok('报告含 token/disk/limits 三块', !!(rep.tokens && rep.disk && rep.limits));
  const list = q.listScopes();
  ok('运维列表能列出账号', list.some(x => x.scope === S2), list.map(x => x.scope));
  const quick = q.quickStats();
  ok('轻量统计不碰磁盘（只读 JSON）', quick.accounts >= 2, quick);
}

console.log('[10] 额度表被外部写了，进程要认');
{
  /* 备份恢复会把 _limits.json 整个换掉，命令行脚本也会写。
     只信内存那一份时，表现是「明明改了额度、界面上还是旧的」，重启才好。 */
  const f = q.__test.LIMITS_FILE;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  cur[S1] = { ...(cur[S1] || {}), tokenDaily: 777777 };
  fs.writeFileSync(f, JSON.stringify(cur, null, 2));
  const t = new Date(Date.now() + 2000);
  try { fs.utimesSync(f, t, t); } catch { /* 某些文件系统不支持，靠 mtime 变化也够 */ }
  eq('外部写入的额度立刻生效', q.limitsOf(S1).tokenDaily, 777777);
  ok('额度有天花板，不能改成无限大', q.setLimits(S1, { tokenDaily: 1e12 }).ok === false);
  ok('正常范围内还是能改', q.setLimits(S1, { tokenDaily: 900000 }).ok === true);
  eq('改完读回来是新值', q.limitsOf(S1).tokenDaily, 900000);
}

console.log('[11] 不写真实 data/');{
  const real = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'usage');
  ok('用量目录是临时目录', !process.env.REN_USAGE_DIR.startsWith(real), process.env.REN_USAGE_DIR);
  const realFiles = fs.existsSync(real) ? fs.readdirSync(real) : [];
  ok('真实 data/usage 里没有本次测试的 scope',
    ![S1, S2, 'c'.repeat(32)].some(s => realFiles.includes(`${s}.json`)), realFiles.slice(0, 10));
}

q.__test.reset();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
