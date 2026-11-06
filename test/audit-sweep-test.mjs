/* 审计保留期：只删「日分片」，边界按天算，先能预演再真删
 *
 * 「审计只写不删」当时不是决定，是没人想过。后果是磁盘上的慢性病：
 * 分片一天一个、备份会把 data/ 整个打进去，于是备份越来越慢越来越重。
 * 但这批日志又是出事之后唯一能复盘的东西，所以清理必须克制到近乎胆小：
 *
 *   1. 只认 /^\d{4}-\d{2}-\d{2}\.jsonl$/ 这个名字。别的文件一律不碰——
 *      data/audit 下面将来放什么都可能，误删一个 .key 就够喝一壶。
 *   2. 边界是「今天零点往前 N 天」，不是 24h×N 的滑动窗口。
 *      按天分片的东西按天算，跟人理解的一致：说保留 30 天，就是能查到 30 天前那天的记录。
 *   3. 先能 dryRun 看清单，再真删。清理动作不可逆，必须有一步「只看不做」。
 *   4. keepDays=0 表示明确不清理（要留全量证据时用），不能被当成「全删」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-sweep-'));
process.env.AUDIT_DIR = path.join(TMP, 'audit');

const A = await import('../lib/audit.js');
const DIR = process.env.AUDIT_DIR;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const S1 = 'a1'.repeat(16);
const S2 = 'b2'.repeat(16);

function day(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function put(scope, dayStr, body = '{}\n') {
  const dir = path.join(DIR, scope);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${dayStr}.jsonl`), body.repeat(10));
}

console.log('\n[1] 日分片的名字解析');
{
  const { dayOf } = A.__test;
  ok('正常名字解出当天零点', new Date(dayOf('2026-11-06.jsonl')).getHours() === 0);
  eq('无效名字返回 0（不是 NaN）', dayOf('hello.jsonl'), 0);
  eq('半截日期返回 0', dayOf('2026-11.jsonl'), 0);
  eq('别的后缀返回 0', dayOf('2026-11-06.log'), 0);
  eq('空值返回 0', dayOf(''), 0);
  ok('默认保留 30 天', A.__test.KEEP_DAYS === 30, A.__test.KEEP_DAYS);
}

console.log('\n[2] 只删过期的日分片，别的一律不碰');
{
  put(S1, day(45));            /* 过期 */
  put(S1, day(31));            /* 过期（> 30 天） */
  put(S1, day(29));            /* 保留 */
  put(S1, day(0));             /* 今天，保留 */
  put(S2, day(60));            /* 另一个账号的过期分片 */
  /* 干扰项：这些都不能被删 */
  fs.writeFileSync(path.join(DIR, S1, 'alerts.key'), 'secret');
  fs.writeFileSync(path.join(DIR, S1, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(DIR, S1, '2026-01-01.jsonl.tmp'), 'x');

  const dry = A.sweepAudit({ dryRun: true });
  eq('预演看到 3 个过期分片', dry.deleted, 3);
  ok('预演没真删', fs.existsSync(path.join(DIR, S1, `${day(45)}.jsonl`)));
  eq('预演报了会删哪些', dry.files.length, 3);

  const r = A.sweepAudit();
  eq('真删了 3 个', r.deleted, 3);
  ok('预演与真删的数量一致', r.deleted === dry.deleted);
  ok('过期分片没了', !fs.existsSync(path.join(DIR, S1, `${day(45)}.jsonl`)));
  ok('另一个账号的也清了（审计是服务端的，按天不按人）', !fs.existsSync(path.join(DIR, S2, `${day(60)}.jsonl`)));
  ok('29 天前的留着', fs.existsSync(path.join(DIR, S1, `${day(29)}.jsonl`)));
  ok('今天的留着', fs.existsSync(path.join(DIR, S1, `${day(0)}.jsonl`)));
  ok('密钥文件没被碰', fs.existsSync(path.join(DIR, S1, 'alerts.key')));
  ok('普通文本没被碰', fs.existsSync(path.join(DIR, S1, 'notes.txt')));
  ok('.tmp 没被碰', fs.existsSync(path.join(DIR, S1, '2026-01-01.jsonl.tmp')));
  ok('报了腾出多少字节', r.bytes > 0, r.bytes);
  eq('剩下的算进 kept', r.kept, 2);
}

console.log('\n[3] 边界：正好满 30 天的那天要留下');
{
  /* 清空重来，只放两个：正好 30 天、31 天 */
  fs.rmSync(DIR, { recursive: true, force: true });
  put(S1, day(30));
  put(S1, day(31));
  const r = A.sweepAudit();
  eq('只删 31 天那份', r.deleted, 1);
  ok('30 天前那份还在（保留期是「包含今天往前 30 天」）',
    fs.existsSync(path.join(DIR, S1, `${day(30)}.jsonl`)));
}

console.log('\n[4] keepDays=0 是「不清理」，不是「全删」');
{
  fs.rmSync(DIR, { recursive: true, force: true });
  put(S1, day(400));
  const r = A.sweepAudit({ keepDays: 0 });
  eq('一个都没删', r.deleted, 0);
  ok('文件还在', fs.existsSync(path.join(DIR, S1, `${day(400)}.jsonl`)));
  const r2 = A.sweepAudit({ keepDays: 7 });
  eq('改成 7 天就删了', r2.deleted, 1);
}

console.log('\n[5] 统计：不清理，只报数字');
{
  fs.rmSync(DIR, { recursive: true, force: true });
  put(S1, day(0), 'x'.repeat(100) + '\n');
  put(S1, day(1), 'x'.repeat(100) + '\n');
  put(S2, day(2), 'x'.repeat(100) + '\n');
  const st = A.auditStats();
  eq('3 个文件', st.files, 3);
  eq('3 天', st.days, 3);
  ok('体积累加了三个账号', st.bytes > 300, st.bytes);
  eq('最老是 2 天前', st.oldest, day(2));
  eq('最新是今天', st.newest, day(0));
  eq('报出保留天数', st.keepDays, 30);
  ok('统计不删东西', fs.existsSync(path.join(DIR, S1, `${day(1)}.jsonl`)));

  /* 目录不存在时不许抛。注意 DIR 在 import 时就定下了，改环境变量没用——
     要模拟「目录没了」就把目录删掉。 */
  fs.rmSync(DIR, { recursive: true, force: true });
  const empty = A.auditStats();
  ok('目录没建也不抛，返回 0', empty.files === 0 && empty.days === 0 && empty.oldest === '', empty);
  ok('清扫同样不抛，删 0 个', A.sweepAudit().deleted === 0);
  fs.mkdirSync(DIR, { recursive: true });
}

console.log('\n[6] 接线：服务启动扫一次 + 每 6 小时一次，且能手工触发');
{
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server.js'), 'utf8');
  ok('启动时扫一次', /AUDIT_SWEEP\.last = runAuditSweep\(\)/.test(src));
  ok('定时器 unref（不挡进程退出）', /setInterval\([\s\S]{0,200}AUDIT_SWEEP[\s\S]{0,120}\.unref\(\)/.test(src), '');
  ok('有手工触发端点', /'\/api\/admin\/audit-sweep'/.test(src));
  ok('手工端点支持 dryRun', /dryRun/.test(src));
  ok('health 里能看到审计现状与上次清扫', /lastSweep/.test(src) && /auditStats\(\)/.test(src));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
