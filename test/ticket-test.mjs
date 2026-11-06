/* 工单层：事实现算、状态落盘、任务可复核
 *
 * 这一层最容易出的三个错，正是这批判定要挡的：
 *   1. 复现步骤取错窗口——把报错**之后**的操作当成复现步骤，因果就反了，
 *      照着它查会一路查到不相干的地方。
 *   2. 状态迁移不设限——从 verified 直接跳回 open，于是「修好了多少次」
 *      永远统计不出来。
 *   3. 状态文件写到一半——直接覆盖时进程被杀，留下半截 JSON，
 *      这张单子的历史整段消失，而症状看起来像「这个 bug 从没出现过」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-'));

/* 这三个目录的常量在模块 import 时就定死了，所以必须写在 import 之前。
   测试里改 env 再 import 才有效——这是这一层最容易踩的坑。 */
process.env.INCIDENT_DIR = path.join(TMP, 'incidents');
process.env.AUDIT_DIR = path.join(TMP, 'audit');
process.env.TICKET_DIR = path.join(TMP, 'tickets');
process.env.PROOF_DIR = path.join(TMP, 'proofs');

const I = await import('../lib/incident.js');
const A = await import('../lib/audit.js');
const T = await import('../lib/ticket.js');

/* 造一份证据（结算 fixed / verified 时会查它）。
   这里直接写文件而不是真跑一遍证明：真跑要检 worktree、跑两遍测试，
   那是 proof-test 的活。这一层只验「有没有证据」这道闸门。 */
function giveProof(sig, strong = true) {
  const key = crypto.createHash('sha1').update(String(sig)).digest('hex').slice(0, 16);
  fs.mkdirSync(process.env.PROOF_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.PROOF_DIR, key + '.json'), JSON.stringify({
    ok: true, strong, sig, test: 'test/x-test.mjs', base: 'aaaaaaa', fix: 'bbbbbbb',
    red: { exit: 1, kind: strong ? 'assert' : 'load', pass: 1, fail: strong ? 1 : 0 },
    green: { exit: 0, kind: 'pass', pass: 2, fail: 0 },
    at: new Date().toISOString(), ms: 100, why: ''
  }));
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const SCOPE = 'a'.repeat(32);
const SCOPE2 = 'b'.repeat(32);

console.log('\n[1] key：能当文件名，且不撞');
{
  const k = T.keyOf('E_TOOL_FAIL|/api/x|writeFile');
  ok('是 16 位十六进制', /^[0-9a-f]{16}$/.test(k), k);
  ok('同一签名稳定', T.keyOf('E_TOOL_FAIL|/api/x|writeFile') === k);
  ok('不同签名不同 key', T.keyOf('E_TOOL_FAIL|/api/y|writeFile') !== k);
  ok('key 里不含 | 和 /（能当文件名）', !/[|/\\:*?"<>]/.test(k));
  /* 超长签名：路由 + 函数都可能很长，hash 之后长度不变 */
  const longSig = 'E_UNKNOWN|/' + 'x'.repeat(3000) + '|' + 'y'.repeat(2000);
  ok('超长签名 hash 后仍是 16 位', T.keyOf(longSig).length === 16);
}

console.log('\n[2] 复现步骤：时间窗口必须只往前，不往后');
{
  /* 造一条审计：现在是「报错前 1 分钟」 */
  A.toolAudit({ scope: SCOPE, name: 'read_file', args: { path: 'a.md' }, ok: true, ms: 12 });
  A.toolAudit({ scope: SCOPE, name: 'edit_file', args: { path: 'a.md' }, ok: false, ms: 30, blocked: false });

  const now = Date.now();
  const sample = { scope: SCOPE, epochMs: now };
  const r = T.reproFor(sample);
  ok('有账号 + 有审计 → 能取到步骤', r.ok === true, r);
  ok('步骤数不超过 8', r.steps.length <= 8, r.steps.length);
  ok('步骤带工具名', r.steps.every(s => s.tool && s.tool !== '?'), r.steps);
  ok('失败的那一步标了 ok:false', r.steps.some(s => s.ok === false), r.steps);

  /* 报错时间设成 5 分钟前，审计是「刚才」写的 → 落在窗口之外 */
  const r2 = T.reproFor({ scope: SCOPE, epochMs: now - 5 * 60e3 });
  ok('窗口外的操作不算复现步骤', r2.ok === false, r2);
  ok('并说明为什么拿不到', /保留期|工具调用/.test(r2.why), r2.why);

  /* 匿名：没有 scope */
  const r3 = T.reproFor({ scope: '', epochMs: now });
  ok('没有账号时明确说拿不到', r3.ok === false);
  ok('说明里点出「匿名上报」', /匿名/.test(r3.why), r3.why);
  ok('不编造步骤', r3.steps.length === 0);

  /* 别的账号的审计不能被拿来用 */
  const r4 = T.reproFor({ scope: SCOPE2, epochMs: now });
  ok('不串账号：另一个账号查不到', r4.ok === false, r4);

  /* 没有时间戳 */
  const r5 = T.reproFor({ scope: SCOPE, epochMs: 0 });
  ok('没时间戳时退回「无法回溯」', r5.ok === false && /时间戳/.test(r5.why), r5);
}

console.log('\n[3] 排序：次数 × 严重度，而不是只看次数');
{
  I.resetLimits();
  const t0 = Date.now();
  /* 5 次界面渲染错（severity 2） vs 5 次网络错（severity 1） */
  for (let i = 0; i < 5; i++) I.report({ code: 'E_UI_RENDER', route: '/api/ui', where: 'render', msg: 'x' }, t0 - i * 1000);
  for (let i = 0; i < 5; i++) I.report({ code: 'E_NET', route: '/api/net', where: 'fetch', msg: 'y' }, t0 - i * 1000);

  const list = T.listTickets({ limit: 50 });
  const ui = list.tickets.find(t => t.code === 'E_UI_RENDER');
  const net = list.tickets.find(t => t.code === 'E_NET');
  ok('两种错都在表里', !!ui && !!net, list.tickets.map(t => t.code));
  ok('同样 5 次，界面错排在网络错前面', ui.score > net.score, { ui: ui.score, net: net.score });
  ok('严重度写进了工单', ui.severity === 2 && net.severity === 1, { ui: ui.severity, net: net.severity });
  eq('排在第一的是分最高的', list.tickets[0].score >= list.tickets[list.tickets.length - 1].score, true);
}

console.log('\n[4] 状态机：不许跳步');
{
  const sig = 'E_TOOL_FAIL|/api/x|writeFile';
  const c = T.claim(sig, 'ren-agent');
  ok('open → claimed 可以', c.ok === true, c);
  ok('记下了领取人', T.__test.loadState(sig).claimedBy === 'ren-agent');

  const bad = T.settle(sig, { state: 'verified', by: 'x', note: '跳过 fixed' });
  ok('claimed → verified 被拒（不许跳步）', bad.ok === false, bad);
  ok('错误里列出允许的目标', /fixed/.test(bad.error), bad.error);

  const noNote = T.settle(sig, { state: 'fixed', by: 'ren-agent', note: '   ' });
  ok('fixed 不写说明被拒', noNote.ok === false, noNote);
  ok('说明里要求「一句说明」', /说明/.test(noNote.error), noNote.error);

  /* 说明写了、但没自证材料 —— 仍然不许说「修好了」。
     这一条是整条链路的终点线：没有红→绿，前面所有步骤都只是「它说」。 */
  const noProof = T.settle(sig, { state: 'fixed', by: 'ren-agent', note: '参数校验漏了空数组' });
  ok('有说明但没证据 → 仍被拒', noProof.ok === false, noProof.error);
  ok('拒绝理由指向自证', /自证|prove/.test(String(noProof.error)), noProof.error);

  giveProof(sig);
  const f = T.settle(sig, { state: 'fixed', by: 'ren-agent', note: '参数校验漏了空数组' });
  ok('claimed → fixed 可以（带证据）', f.ok === true, f);

  const back = T.settle(sig, { state: 'claimed', by: 'me', note: '复核不过：只改了表象' });
  ok('fixed → claimed 可以（复核打回）', back.ok === true, back);

  const noProof2 = T.settle(sig, { state: 'fixed', by: 'ren-agent', note: '这次补了测试' });
  ok('打回后证据作废，再结算要重新证明', noProof2.ok === false, noProof2.error);

  giveProof(sig);
  T.settle(sig, { state: 'fixed', by: 'ren-agent', note: '这次补了测试' });
  const v = T.settle(sig, { state: 'verified', by: 'me', note: '复核通过，已上线' });
  ok('fixed → verified 可以', v.ok === true, v);

  const again = T.settle(sig, { state: 'open', note: '重开' });
  ok('verified 是终态，不能乱改', again.ok === false, again);

  eq('历史完整记录了每一次迁移', T.__test.loadState(sig).history.map(h => h.to).join('>'), 'open>claimed>fixed>claimed>fixed>verified');
}

console.log('\n[5] 状态落盘：原子、可读、不串号');
{
  const sig = 'E_HTTP_5XX|/api/export|sendFile';
  T.claim(sig, 'ren-agent');
  const key = T.keyOf(sig);
  const f = T.__test.fileOf(key);
  ok('状态文件确实写出来了', fs.existsSync(f), f);
  ok('没有 .tmp 残留', !fs.readdirSync(T.__test.DIR).some(n => n.includes('.tmp')), fs.readdirSync(T.__test.DIR));
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  eq('文件里存了 sig 原文（用于防串号）', o.sig, sig);
  eq('文件里存了签名算法版本', o.sigVer, T.__test.SIG_VER);

  /* 手动把 sig 改坏，模拟「hash 撞了 / 文件被换过」 */
  fs.writeFileSync(f, JSON.stringify({ ...o, sig: 'E_HTTP_5XX|/api/other|sendFile' }));
  ok('sig 对不上就当没状态（不串号）', T.__test.loadState(sig) === null);

  fs.writeFileSync(f, '{"sig": broken');
  ok('半截 JSON 不抛，返回 null', T.__test.loadState(sig) === null);
}

console.log('\n[6] 复发：修好过又犯了，要显式标出来');
{
  const sig = 'E_STATE|/api/state|write';
  const t0 = Date.now() - 10 * 24 * 3600e3;   // 10 天前
  I.report({ code: 'E_STATE', route: '/api/state', where: 'write', msg: 'db locked' }, t0);
  T.claim(sig, 'ren-agent');
  giveProof(sig);
  T.settle(sig, { state: 'fixed', by: 'ren-agent', note: '加了重试' });
  T.settle(sig, { state: 'verified', by: 'me', note: '通过' });

  const before = T.listTickets({ limit: 50 }).tickets.find(t => t.sig === sig);
  ok('刚修好时没有复发标记', before && before.reopened === false, before && before.reopened);

  /* 修好之后又报了一次 */
  I.report({ code: 'E_STATE', route: '/api/state', where: 'write', msg: 'db locked again' }, Date.now());
  const after = T.listTickets({ limit: 50 }).tickets.find(t => t.sig === sig);
  ok('再犯之后 reopened=true', after && after.reopened === true, after && after.reopened);
  ok('状态还是 verified（不自动改状态，只标记）', after.state === 'verified', after.state);
}

console.log('\n[7] dropped：判为噪音要留理由，且默认不进列表');
{
  const sig = 'E_NET|/api/ping|ping';
  I.report({ code: 'E_NET', route: '/api/ping', where: 'ping', msg: 'offline' }, Date.now());
  const noNote = T.settle(sig, { state: 'dropped', note: '' });
  ok('dropped 必须写理由', noNote.ok === false, noNote);

  const d = T.settle(sig, { state: 'dropped', by: 'me', note: '断网时的正常失败，不是 bug' });
  ok('open → dropped 可以', d.ok === true, d);

  const listed = T.listTickets({ limit: 50 }).tickets.some(t => t.sig === sig);
  ok('默认列表里不出现被判掉噪音的单', listed === false);
  const all = T.listTickets({ limit: 50, includeDropped: true }).tickets.some(t => t.sig === sig);
  ok('显式要求时能看到', all === true);

  const re = T.settle(sig, { state: 'open', note: '又开始频繁报，重开' });
  ok('dropped → open 可以（重开）', re.ok === true, re);
}

console.log('\n[8] 任务模板：复现、红线、验收三样缺一不可');
{
  /* 列表默认不算复现（几十张单各扫一遍审计太贵），所以这里取详情：
     详情才是「交给 agent 的那一份」，列表只是索引。 */
  const brief = T.listTickets({ limit: 50, includeDropped: true }).tickets[0];
  ok('列表里复现被标成 skipped，而不是假装没有', brief.repro.skipped === true, brief.repro);

  const t = T.getTicket(brief.sig);
  ok('详情能取到', !!t, brief.sig);
  ok('详情里有真实复现结果（不是 skipped）', t.repro.skipped !== true, t.repro);
  ok('详情的 sig 与列表一致', t.sig === brief.sig);

  const p = T.toTaskPrompt(t);
  ok('带工单号', /【工单 [0-9a-f]{16}】/.test(p), p.slice(0, 60));
  ok('带次数与首末次', /发生 \d+ 次/.test(p) && /首次/.test(p), '');
  ok('带报错原文代码块', /## 报错原文/.test(p) && /```/.test(p));
  ok('带复现步骤小节', /## 复现步骤/.test(p));
  ok('带红线清单', /## 边界（不许动）/.test(p) && /within\(\)/.test(p));
  ok('带验收标准', /## 验收/.test(p) && /红→绿/.test(p));
  ok('带「指到 文件:行」的要求', /文件:行/.test(p), '');
  ok('拿不到复现时明说，不编', /没有可用的复现上下文|报错前同一账号的操作/.test(p),
    p.slice(p.indexOf('## 复现步骤'), p.indexOf('## 复现步骤') + 120));

  /* 列表对象直接拿去生成任务时，不能让它误以为「这个 bug 没有复现路径」 */
  const p2 = T.toTaskPrompt(brief);
  ok('用列表对象也不撒谎：说明要去取完整版', /取完整版|没算复现步骤/.test(p2), p2.slice(0, 200));
}

console.log('\n[9] 统计与退回');
{
  const s = T.ticketStats();
  ok('给出总数', typeof s.tickets === 'number' && s.tickets > 0, s);
  ok('按状态分好了', s.byState && typeof s.byState.verified === 'number', s.byState);
  ok('统计了状态文件数', s.stateFiles >= 3, s.stateFiles);
  ok('统计了复发数', typeof s.reopened === 'number', s.reopened);
}

console.log('\n[10] 源码钉住：这几处一旦被改，这一层就失去意义');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'ticket.js'), 'utf8');
  ok('状态文件先写临时再 rename（原子）', /writeFileSync\(tmp/.test(src) && /renameSync\(tmp/.test(src));
  ok('复现窗口只往前取（to = 报错时刻）', /to: new Date\(t\)\.toISOString\(\)/.test(src));
  ok('状态迁移是白名单', /const NEXT = \{/.test(src));
  ok('fixed/verified/dropped 强制写说明', /state === 'fixed' \|\| state === 'verified' \|\| state === 'dropped'/.test(src));
  ok('签名算法版本号存在状态里', /sigVer: SIG_VER/.test(src));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
