/* 分诊：这一轮该派哪张、为什么跳过其余
 *
 * 这一层最容易出的不是崩溃，是**静默不干活**：
 * 一张单被挡掉了但没人知道原因，一周后结论是「最近挺稳的」。
 * 所以每条规则都要钉住两件事：它挡得住，以及**它说得出为什么**。
 *
 * 另外三条是策略本身：
 *   · external 不派（不是我们的代码，派出去等于烧一晚上）
 *   · 同一张单最多试 3 次、间隔 6 小时（同一份上下文重试大概率同样结果）
 *   · 已有在修的不开第二张（prove 跑全量测试，worktree 会互相踩）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-test-'));
const REPO = path.join(TMP, 'repo');
const REPAIR_DIR = path.join(TMP, 'repair');

const git = (dir, ...args) => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();

fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q');
git(REPO, 'config', 'user.email', 'r@test');
git(REPO, 'config', 'user.name', 'r');
const writeRepo = (rel, body) => {
  const f = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
};
writeRepo('.gitignore', 'data/\nnode_modules/\n');
writeRepo('package.json', JSON.stringify({ name: 'fixture', version: '0.0.1', type: 'module' }, null, 2) + '\n');
writeRepo('lib/x.js', 'export function add(a, b) { return a - b; }\n');
writeRepo('test/ok-test.mjs', "console.log('1 通过 / 0 失败');\n");
git(REPO, 'add', '-A');
git(REPO, 'commit', '-q', '-m', 'base');

process.env.REPAIR_ROOT = REPO;
process.env.REPAIR_DIR = REPAIR_DIR;
process.env.PROOF_DIR = path.join(TMP, 'proofs');
process.env.TICKET_DIR = path.join(TMP, 'tickets');
process.env.AUDIT_DIR = path.join(TMP, 'audit');
process.env.INCIDENT_DIR = path.join(TMP, 'incident');

const G = await import('../lib/triage.js');
const R = await import('../lib/repair.js');
const T = await import('../lib/ticket.js');
const INC = await import('../lib/incident.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};

const DEV = { REN_DEV_INSTANCE: '1', HOST: '127.0.0.1' };
const SCOPE = 'a'.repeat(32);

/* 报一条错，拿到它的签名 */
function boom(code, { route = '/api/x', where = 'doThing', msg = 'boom' } = {}) {
  INC.resetLimits();
  INC.report({ code, route, where, msg, scope: SCOPE, stack: [`at ${where} (lib/x.js:1:1)`] }, Date.now());
  const sig = INC.signature({ code, route, where, msg });
  return { sig, key: T.keyOf(sig) };
}

/* 造一份修复状态文件，用来模拟「试过几次 / 什么时候试的 / 还在修」 */
function repairState(key, { attempt = 1, status = 'aborted', agoMs = 0 } = {}) {
  fs.mkdirSync(REPAIR_DIR, { recursive: true });
  const o = {
    key, sig: key, branch: `heal/${key}`, dir: path.join(REPAIR_DIR, 'wt-' + key),
    base: '0000000', status, by: 'ren',
    created: new Date(Date.now() - agoMs).toISOString(), test: '', attempt
  };
  fs.writeFileSync(path.join(REPAIR_DIR, key + '.json'), JSON.stringify(o, null, 2));
}

function resetRepair() {
  fs.rmSync(REPAIR_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPAIR_DIR, { recursive: true });
}

/* 把某张单子的工单状态直接改掉（复现「已复核」这类状态，走 settle 太重） */
function setTicketState(sig, patch) {
  const st = T.__test.loadState(sig) || T.__test.freshState(sig, Date.now());
  Object.assign(st, patch);
  T.__test.saveState(st);
}

const reason = (r, key) => (r.skipped || []).find(s => s.key === key)?.reason || '';
const whyOf = (r, key) => (r.skipped || []).find(s => s.key === key)?.why || '';

let HOT = null;      /* 分数最高的那张 self 单 */
let LOW = null;      /* 同屏第二张 self 单 */

console.log('[1] 开不开：和修复工作区同一道闸');
{
  ok('没设 REN_DEV_INSTANCE 就关', !G.pick({ env: {} }).ok);
  ok('关掉时给 503 而不是 403', G.pick({ env: {} }).code === 503);
  ok('非回环 HOST 也关', !G.pick({ env: { REN_DEV_INSTANCE: '1', HOST: '0.0.0.0' } }).ok);
}

console.log('\n[2] 空场：没单子时要说「没有」，不能装作干完了');
{
  const r = G.pick({ env: DEV });
  ok('ok 但没选中', r.ok && r.pick === null);
  ok('说明是没有单子，不是被挡掉', /还没有任何报错/.test(r.why), r.why);
}

console.log('\n[3] 归属：external 不派，either 要人判');
{
  const a = boom('E_LLM_TIMEOUT', { route: '/api/chat', where: 'callLLM', msg: 'timed out after 60s' });
  const b = boom('E_LLM_EMPTY', { route: '/api/chat', where: 'parse', msg: 'empty content' });
  const r = G.pick({ env: DEV });
  ok('external 被挡', reason(r, a.key) === 'owner-external', r.skipped);
  ok('either 被挡', reason(r, b.key) === 'owner-either', r.skipped);
  ok('一个都没选', r.pick === null);
  ok('给出的理由是「不是我们的代码」', /不是我们的代码/.test((r.skipped || []).find(s => s.key === a.key)?.why || ''));
  ok('没有可派时给出按原因的分组', r.byReason && r.byReason['owner-external'] === 1, r.byReason);
}

console.log('\n[4] 只派 self，且同屏多张时按分排');
{
  LOW = boom('E_TOOL_FAIL', { route: '/api/tool', where: 'runTool', msg: 'spawn failed' });
  for (let i = 0; i < 6; i++) {
    INC.resetLimits();
    INC.report({ code: 'E_UI_RENDER', route: '/app', where: 'renderList', msg: 'x is not a function', scope: SCOPE }, Date.now());
  }
  HOT = { sig: INC.signature({ code: 'E_UI_RENDER', route: '/app', where: 'renderList', msg: 'x is not a function' }) };
  HOT.key = T.keyOf(HOT.sig);
  const r = G.pick({ env: DEV });
  ok('选中了 self 那张', !!r.pick && r.pick.key === HOT.key, r.pick && r.pick.key);
  ok('低分那张进跳过列表且说明是「排在后面」', reason(r, LOW.key) === 'not-first', r.skipped);
  ok('选中的带得分与次数', r.pick.score > 0 && r.pick.n === 6, { score: r.pick.score, n: r.pick.n });
}

console.log('\n[5] 冷却：刚试过的不再派');
{
  resetRepair();
  repairState(HOT.key, { attempt: 1, agoMs: 2 * 3600e3 });
  const r = G.pick({ env: DEV });
  ok('2 小时前试过 → 挡', !!r.pick && r.pick.key !== HOT.key, r.pick && r.pick.key);
  ok('原因记成 cooldown', reason(r, HOT.key) === 'cooldown', r.skipped);
  ok('理由里写了还要等多久', /小时后再派/.test(whyOf(r, HOT.key)));
  ok('它换成派下一张，而不是整轮停摆', !!r.pick && r.pick.key === LOW.key, r.pick && r.pick.key);
}

console.log('\n[6] 冷却过了就放行；试满 3 次转人工');
{
  resetRepair();
  repairState(HOT.key, { attempt: 1, agoMs: 7 * 3600e3 });
  const r1 = G.pick({ env: DEV });
  ok('7 小时前试过 → 放行', !!r1.pick && r1.pick.key === HOT.key, r1.pick && r1.pick.key);

  repairState(HOT.key, { attempt: 3, agoMs: 7 * 3600e3 });
  const r2 = G.pick({ env: DEV });
  ok('试满 3 次 → 挡', !!r2.pick && r2.pick.key !== HOT.key, r2.pick && r2.pick.key);
  ok('原因记成 attempts', reason(r2, HOT.key) === 'attempts', r2.skipped);
  ok('理由说清是「转人工」', /转人工/.test(whyOf(r2, HOT.key)));
}

console.log('\n[7] 已结算的不派；修好又犯的要优先');
{
  resetRepair();
  /* settledAt 必须在最后一次报错之后，否则算「复发」——这正是下面要单独测的那条 */
  setTicketState(HOT.sig, {
    state: 'verified', settledAt: new Date(Date.now() + 3600e3).toISOString(), history: []
  });
  const r1 = G.pick({ env: DEV });
  ok('verified 且之后没再犯 → 挡', reason(r1, HOT.key) === 'state-verified', r1.skipped);
  ok('它不会误判成复发', !!r1.pick && r1.pick.key !== HOT.key);

  /* 结算时间早于最后一次报错 = 复发：那次修复只压住了症状 */
  setTicketState(HOT.sig, { settledAt: new Date(Date.now() - 3600e3).toISOString() });
  const r2 = G.pick({ env: DEV });
  ok('复发的不但放行，还排到最前', !!r2.pick && r2.pick.key === HOT.key && r2.pick.reopened === true,
    r2.pick && { key: r2.pick.key, re: r2.pick.reopened });
}

console.log('\n[8] 单飞：已有在修的不开第二张');
{
  resetRepair();
  repairState('ffffffffffffffff', { attempt: 1, status: 'active' });
  const r = G.pick({ env: DEV });
  ok('不选新的', r.pick === null);
  ok('把在修的那张带回来（可以继续，不是「没活」）', !!r.resume && r.resume.key === 'ffffffffffffffff', r.resume);
  ok('理由说清会互相踩 worktree', /互相踩/.test(r.why), r.why);
}

console.log('\n[9] 日额度：一天最多 5 张');
{
  resetRepair();
  for (let i = 0; i < 5; i++) repairState('b' + i.toString().padStart(15, '0'), { attempt: 1, agoMs: 60e3 });
  const r = G.pick({ env: DEV });
  ok('额度用尽 → 不派', r.pick === null && r.budget.left === 0, r.budget);
  ok('理由说清是额度，不是没单子', /额度/.test(r.why), r.why);
  ok('额度是按「今天动过的单子」算的', r.budget.used === 5, r.budget);
}

console.log('\n[10] 起一轮：dry 不动仓库，真起才建 worktree');
{
  resetRepair();
  /* 第 7 节把这张标成 verified 了，起一轮的测试要先把它放回未结算 */
  setTicketState(HOT.sig, { state: 'open', settledAt: '', claimedBy: '', claimedAt: '', history: [] });

  const before = git(REPO, 'branch', '--list').split('\n').filter(Boolean).length;
  const d = await G.next({ env: DEV, dryRun: true });
  ok('dry 也给出会派哪张', !!d.pick && d.pick.key === HOT.key, d.pick && d.pick.key);
  ok('dry 给了任务书（不用真开就能看会派什么活）', /工单 /.test(d.task || ''), (d.task || '').slice(0, 60));
  ok('dry 没建分支', git(REPO, 'branch', '--list').split('\n').filter(Boolean).length === before);
  ok('dry 没建 worktree', !fs.existsSync(path.join(REPAIR_DIR, 'wt-' + d.pick.key)));
  ok('但 dry 也记了一条决策（「看过、决定不开」要能查到）',
    (G.decisions({ days: 1 }) || []).some(x => x.dryRun === true));

  const n = await G.next({ env: DEV, by: 'ren' });
  ok('真起 → ok', n.ok && !!n.began, n.error);
  ok('真起 → 建了分支', !!n.began && git(REPO, 'branch', '--list').includes(n.began.branch));
  ok('真起 → worktree 在', !!n.began && fs.existsSync(path.join(REPAIR_DIR, 'wt-' + n.began.key)));
  ok('真起 → 单子被领走（claimed）', !!n.began && T.getTicket(n.began.sig)?.state === 'claimed');
  ok('真起 → 是第 1 次尝试', !!n.began && n.began.attempt === 1, n.began && n.began.attempt);
  ok('真起 → 回执带任务书', /工单 /.test(n.task || ''));

  const again = await G.next({ env: DEV });
  ok('同一时刻再起 → 返回在修的那张，不建第二张', again.pick === null && !!again.resume, again.why);
}

console.log('\n[11] 决策留痕：能回答「为什么这周一张都没修」');
{
  const rows = G.decisions({ days: 1 });
  ok('写进去了', rows.length >= 2, rows.length);
  ok('每条都有时间与结果', rows.every(r => r.at && ('picked' in r)));
  const s = G.triageStats({ days: 1 });
  ok('统计里能数出轮次', s.rounds === rows.length, { rounds: s.rounds, rows: rows.length });
  ok('统计里能数出开成几张', s.began >= 1, s.began);
  ok('统计给出挡掉最多的原因', Array.isArray(s.top), s.top);
}

/* 收尾：把 worktree 摘掉，别给下一次跑留垃圾 */
try {
  const st = fs.readdirSync(REPAIR_DIR).filter(f => f.endsWith('.json'));
  for (const f of st) {
    const o = JSON.parse(fs.readFileSync(path.join(REPAIR_DIR, f), 'utf8'));
    if (o.branch) { try { git(REPO, 'worktree', 'remove', '--force', o.dir); } catch { /* 没有就算了 */ } }
  }
} catch { /* 收尾失败不影响结论 */ }
fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
