/* 双层编排治理：状态机 / 契约硬证据 / 心跳 / 错误分类 / 计划版本
 *
 * 这组断言对应技术文档（任务与项目双层编排系统技术设计 v1.0）里能落到
 * 前端的那几条硬要求：
 *   第 6 节  状态机：三套状态归一 + 非法迁移被拒绝
 *   4.1 节  Task Contract：每个任务都有可判定的验收口径
 *   8.1 节  Lease/心跳：过期才算断了，新鲜就不许别人抢
 *   8.2 节  错误分类：权限拒绝/预算耗尽不许重试
 *   第 5 节  计划版本化：重规划不覆盖历史
 *
 * 全部不调模型、不连云库，跑一遍零 token。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const statesSrc = read('public/states.js');
const contractSrc = read('public/contract.js');
const meetSrc = read('public/meeting.js');
const appSrc = read('public/app.js');
const agentSrc = read('public/agent.js');
const htmlSrc = read('public/index.html');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* states.js / contract.js 是自执行 IIFE，挂到 globalThis，可直接 new Function 跑 */
new Function(statesSrc)();
new Function(contractSrc)();
const S = globalThis.STATES;
const C = globalThis.CONTRACT;

/* meeting.js 依赖一堆别的东西，没法整份加载：只把纯函数抽出来跑 */
function grabFn(src, name) {
  const key = '  function ' + name + '(';
  const i = src.indexOf(key);
  if (i < 0) return '';
  const j = src.indexOf('\n  }', i);
  return src.slice(i, j + 4);
}

console.log('[1] 三套状态归一到同一套词表');
{
  ok('states.js 已挂上 window.STATES', !!S && !!S.NODE && !!S.TASK && !!S.PROJ);
  ok('任务 done / weak 都归 completed', S.task.from('done') === 'completed' && S.task.from('weak') === 'completed');
  ok('interrupted 归 ready（能续，不是失败）', S.task.from('interrupted') === 'ready');
  ok('budget_exceeded 归 failed（文档：预算耗尽 → FAILED）', S.task.from('budget_exceeded') === 'failed');
  ok('unverified 归 review（没过验收，不是失败）', S.task.from('unverified') === 'review');
  ok('void 归 cancelled', S.task.from('void') === 'cancelled');
  ok('项目 halted 归 paused（能接着跑）', S.project.from('halted') === 'paused');
  ok('项目 awaiting 归 needs_input', S.project.from('awaiting') === 'needs_input');
  ok('项目 confirm 归 needs_approval', S.project.from('confirm') === 'needs_approval');
  ok('节点 wait / todo 都归 pending', S.node.from('wait') === 'pending' && S.node.from('todo') === 'pending');
  ok('节点 ask 归 waiting（等老板拍板）', S.node.from('ask') === 'waiting');
  ok('节点 weak 归 succeeded（产出在，存疑另记）', S.node.from('weak') === 'succeeded');
  ok('认不出来的词有兜底，不会崩', S.task.from('???') === 'created' && S.node.from('???') === 'pending');
}

console.log('[2] 非法迁移被拒绝（文档：状态迁移必须可校验）');
{
  /* 文档的 running → REVIEW → COMPLETED 是两跳。我们收尾时在同一段里做完
     了验收（落盘检查 + 验收人），所以把 REVIEW 和 COMPLETED 合并成一跳，
     否则任务界面要凭空多一个阶段——老板看到的是「跑完就直接是结果」。
     但「没验收就归档」仍然要拒。 */
  ok('running → done 允许（验收与收尾合并，不额外插一个阶段）', S.canTransit('task', 'running', 'done'));
  ok('running → archived 被拒（没验收不能直接归档）', !S.canTransit('task', 'running', 'archived'));
  ok('running → review 允许', S.canTransit('task', 'running', 'review'));
  ok('review → done 允许', S.canTransit('task', 'review', 'done'));
  ok('completed → running 被拒（做完不能倒回去跑）', !S.canTransit('task', 'completed', 'running'));
  ok('failed → ready 允许（失败可重试）', S.canTransit('task', 'failed', 'ready'));
  ok('项目 completed → active 被拒', !S.canTransit('project', 'done', 'analyzing'));
  ok('项目 paused → active 允许（能接着跑）', S.canTransit('project', 'halted', 'analyzing'));
  ok('节点 succeeded → running 被拒', !S.canTransit('node', 'done', 'run'));
  ok('节点 pending → ready → running 通路成立',
    S.canTransit('node', 'wait', 'ready') && S.canTransit('node', 'ready', 'run'));
}

console.log('[3] 心跳判活：新鲜就不许抢（Lease 的等价物）');
{
  const now = 1_800_000_000_000;
  ok('30 秒前的心跳算活着', S.heartbeatFresh(now - 30_000, now) === true);
  ok('89 秒前还算活着', S.heartbeatFresh(now - 89_000, now) === true);
  ok('91 秒前算过期', S.heartbeatFresh(now - 91_000, now) === false);
  ok('没有心跳时间戳 = 没过期也说不上活着', S.heartbeatFresh(0, now) === false);
  ok('running + 心跳过期 → 判定卡死', S.looksStuck('running', now - 120_000, now) === true);
  ok('running + 心跳新鲜 → 不算卡死', S.looksStuck('running', now - 10_000, now) === false);
  ok('done 状态不谈卡死', S.looksStuck('done', now - 999_999, now) === false);
  ok('阈值是 90 秒', S.STUCK_MS === 90_000);
}

console.log('[4] Task Contract：验收口径必须写死，不能是 undefined');
{
  const t = { goal: '画一个马克杯，顺带做个 ppt', files: ['/w/a.png'], deliverables: [] };
  const c = C.build(t, {
    wantArtifacts: () => [
      { key: 'image', name: '图片（.png / .jpg）', re: /\.(png|jpe?g)$/i },
      { key: 'pptx', name: 'PPT（.pptx）', re: /\.pptx$/i }
    ],
    permissions: { write: true, net: true }, maxTokens: 200000, maxSteps: 24
  });
  ok('goal 带过来了', c.goal.indexOf('马克杯') >= 0);
  ok('产出物进了契约（图片 + PPT）', c.deliverables.length === 2);
  ok('验收口径非空（改造前这里读的是 undefined）', Array.isArray(c.acceptance_criteria) && c.acceptance_criteria.length >= 2);
  ok('验收口径点名了产出物必须落盘', /必须真的存在于工作区/.test(c.acceptance_criteria.join('；')));
  ok('预算/权限/交接格式都在', !!c.budget && !!c.tool_permissions && c.handoff_format.length === 4);
  ok('纯看图的任务风险是 LOW', c.risk_level === 'LOW');

  const risky = C.build({ goal: '把这份合同发邮件给客户，然后付款' }, { wantArtifacts: () => [] });
  ok('有外发/付款动作时抬到 HIGH', risky.risk_level === 'HIGH');
  ok('风险理由写清了为什么会抬', risky.risk_why.length >= 1);

  const judge = C.judgeArgs(c);
  ok('交给验收人的口径是字符串，不是 undefined', typeof judge.accept === 'string' && judge.accept.length > 0);
  ok('验收人知道缺了哪些硬产出', Array.isArray(judge.hardMissing));
}

console.log('[5] 硬证据：没有文件就不算交付');
{
  const c = C.build({ goal: '做个 ppt 和一张图' }, {
    wantArtifacts: () => [
      { key: 'image', name: '图片（.png / .jpg）', re: /\.(png|jpe?g)$/i },
      { key: 'pptx', name: 'PPT（.pptx）', re: /\.pptx$/i }
    ]
  });
  const bad = C.check(c, { wrote: ['/w/封面.png'] });
  ok('少做了 PPT → 判定不通过', bad.pass === false);
  ok('缺的正是 PPT 那一项', bad.missing.some(x => /PPT/.test(x)));
  ok('判定依据说清了在核什么', /核了 2 类产出物/.test(bad.basis));

  const good = C.check(c, { wrote: ['/w/封面.png', '/w/提案.pptx'] });
  ok('都做了 → 通过', good.pass === true && good.missing.length === 0);

  /* 记录里有、但文件已经被移走：这也算没交付（文档要求以产物为准） */
  const gone = C.check(c, { wrote: ['/w/封面.png', '/w/提案.pptx'], exists: () => false });
  ok('文件被移走 → 不算交付', gone.pass === false);

  const none = C.check({ deliverables: [], declared: [] }, { wrote: [] });
  ok('没点名产出物时不瞎判', none.checked === false && none.pass === true);
}

console.log('[6] 错误分类：不该重试的立刻抛');
{
  const errClass = new Function(grabFn(meetSrc, 'errClass') + '\nreturn errClass;')();
  ok('429 限流 → 可重试', errClass({ message: '429 Too Many Requests' }) === 'transient');
  ok('超时 → 可重试', errClass({ message: 'ETIMEDOUT' }) === 'transient');
  ok('401 → 不重试', errClass({ message: 'HTTP 401 unauthorized' }) === 'permission');
  ok('403 forbidden → 不重试', errClass({ message: 'forbidden' }) === 'permission');
  ok('中文「没有权限」也能认', errClass({ message: '没有权限访问该文件' }) === 'permission');
  ok('输入缺失 → 不重试', errClass({ message: '缺少必要参数' }) === 'input');
  ok('预算闸 → 不重试', errClass({ name: 'BudgetHold' }) === 'budget');
  ok('积分耗尽 → 不重试', errClass({ name: 'NoCredit' }) === 'budget');
  ok('JSON 解析错 → 有限重试', errClass({ message: 'Unexpected token in JSON' }) === 'param');
  ok('withRetry 里对不可重试类直接抛', /if \(!RETRYABLE\[cls\]\) throw e;/.test(meetSrc));
  ok('重试改成退避（不再是固定 1500ms）', /setTimeout\(r, 1200 \* \(i \+ 1\)\)/.test(meetSrc));
}

console.log('[7] 计划版本：重规划不覆盖历史');
{
  globalThis.window = { STATES: S };
  const pushPlanVersion = new Function('window', grabFn(meetSrc, 'pushPlanVersion') + '\nreturn pushPlanVersion;')(globalThis.window);
  const m = {};
  pushPlanVersion(m, { understanding: 'v1 理解', nodes: [{ id: 'T1' }] }, '初版拆解');
  ok('第一版归档成 v1', m.planVersions.length === 1 && m.planVersions[0].v === 1);
  ok('版本号同步到 m.planVersion', m.planVersion === 1);

  pushPlanVersion(m, { understanding: 'v1 理解', nodes: [{ id: 'T1' }] }, '重复一次');
  ok('同一份计划不重复归档', m.planVersions.length === 1);

  pushPlanVersion(m, { understanding: 'v2 理解', nodes: [{ id: 'T1' }, { id: 'T2' }] }, '按老板意见重排');
  ok('新计划进 v2，旧版留着', m.planVersions.length === 2 && m.planVersions[1].v === 2);
  ok('旧版内容没被覆盖', m.planVersions[0].plan.understanding === 'v1 理解');
  ok('新版记了为什么改', /重排/.test(m.planVersions[1].why));
  ok('归档的是深拷贝，不是同一个对象', m.planVersions[0].plan !== m.planVersions[1].plan);

  for (let i = 0; i < 20; i++) pushPlanVersion(m, { understanding: 'x' + i, nodes: [{ id: 'T' + i }] }, '迭代 ' + i);
  ok('最多留 12 版（不至于把一行 JSON 撑爆）', m.planVersions.length === 12);
}

console.log('[8] 节点状态：只留一处判定，两种视图同源');
{
  globalThis.window = { STATES: S };
  const nodeState = new Function('window', grabFn(meetSrc, 'nodeState') + '\nreturn nodeState;')(globalThis.window);
  ok('产出缺失优先于 done（文件不在就不算做完）', nodeState({ status: 'done', lostFiles: ['/w/a.md'] }).lost === true);
  ok('done + 验收没过 → 存疑', nodeState({ status: 'done', verify: { pass: false } }).raw === 'weak');
  ok('done + 验收通过 → done', nodeState({ status: 'done', verify: { pass: true } }).raw === 'done');
  ok('ask → standard waiting', nodeState({ status: 'ask' }).std === 'waiting');
  ok('wait → standard pending', nodeState({ status: 'wait' }).std === 'pending');
  ok('run → standard running', nodeState({ status: 'run' }).std === 'running');
  ok('两种视图都调 stTagOf（不再各写一套 if）',
    (meetSrc.match(/stTagOf\(/g) || []).length >= 3);
  ok('路径列表里不再有硬编码的状态三元链', !/o\.status === 'done' \? '<span class="mt-st ok">已核验/.test(meetSrc));
}

console.log('[9] 接线：契约进执行流程、心跳进恢复流程、文件被页面加载');
{
  ok('agent.js 在开跑时生成契约', /CONTRACT\.build\(task, \{/.test(agentSrc));
  ok('契约通过事件交给界面', /emit\(\{ t: 'contract', contract, round: myRound \}\)/.test(agentSrc));
  ok('验收人拿到的是契约口径而非 undefined 的 task.accept',
    /CONTRACT\.judgeArgs\(contract/.test(agentSrc));
  ok('收尾用硬证据压状态（没落盘不许留 done）',
    /const ev = CONTRACT\.check\(contract, \{ wrote: \[\.\.\.wrote, \.\.\.made\] \}\)/.test(agentSrc));
  ok('没写权限的任务不硬逼产出', /const canWrite = !!\(settings\.permissions && settings\.permissions\.write\)/.test(agentSrc));
  ok('界面接住了 contract 事件', /ev\.t === 'contract'/.test(appSrc));
  ok('恢复流程先看心跳再判中断', /const live = window\.STATES[\s\S]{0,120}heartbeatFresh/.test(appSrc));
  ok('心跳新鲜时标 maybeElsewhere 而不是改状态', /t\.maybeElsewhere = true; continue;/.test(appSrc));
  ok('index.html 先加载 states/contract，再加载 agent',
    htmlSrc.indexOf('states.js') < htmlSrc.indexOf('agent.js')
    && htmlSrc.indexOf('contract.js') < htmlSrc.indexOf('agent.js'));
  ok('项目节点执行块用直排（不再是 bot 气泡）',
    /<div class="mt-node-out">/.test(meetSrc) && !/h \+= botRow\(\{ name: o\.lead, role: o\.role \}/.test(meetSrc));
  ok('计划历史在界面上可回看', /mt-planver/.test(meetSrc));
}

/* 这一节来自一次真实的自审错误：模型看到 startRunHeart 只写 localStorage，
   就断定「换设备必然没心跳」。它漏了 scheduleRunSave 每步会落库、也会刷新
   updated_at。但顺着查下去发现另一半是真的：等模型返回时没有步骤落地，
   updated_at 会停住，90 秒后别的设备就把真在跑的任务判死。
   所以补一笔云端打点，这里把它的行为钉住。 */
console.log('[10] 云端心跳：等模型返回的空档也要续租，否则别的设备会误杀');
{
  const src = (appSrc.match(/function beatCloud\(task\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('beatCloud 存在', src.length > 0);
  const mk = (o = {}) => {
    const calls = [];
    const hb = { beatLast: 0 };
    const fakeState = { guest: !!o.guest };
    const fakeCloud = { saveTask: (id, p) => { calls.push({ id, p }); return Promise.resolve(); } };
    const body = src.replace(/\bbeatLast\b/g, 'hb.beatLast');
    /* 常量也一起注进去：用真实源码里的值，不在这里另抄一份 */
    const gap = Number((appSrc.match(/HEARTBEAT_GAP = (\d+)/) || [])[1] || 0);
    const fn = new Function('state', 'CLOUD', 'runSaveLast', 'hb', 'HEARTBEAT_GAP', body + '\nreturn beatCloud;')(
      fakeState, fakeCloud, o.lastSave || 0, hb, gap);
    return { fn, calls };
  };

  const a = mk();
  a.fn({ id: 't1' });
  ok('长时间没有落库时补一笔云端打点', a.calls.length === 1 && a.calls[0].id === 't1', JSON.stringify(a.calls));
  ok('打点只写状态，不把整轮轨迹再传一遍', JSON.stringify(a.calls[0] && a.calls[0].p) === '{"status":"running"}', JSON.stringify(a.calls[0] && a.calls[0].p));
  a.fn({ id: 't1' });
  ok('刚补过就不再写（一分钟最多两次）', a.calls.length === 1);

  const b = mk({ lastSave: Date.now() });
  b.fn({ id: 't2' });
  ok('刚有步骤落过库时不重复写', b.calls.length === 0);

  const c = mk({ guest: true });
  c.fn({ id: 't3' });
  ok('游客不写云端', c.calls.length === 0);

  const d = mk();
  d.fn({ id: 'local_9' });
  ok('本地草稿任务不写云端', d.calls.length === 0);

  ok('定时器里既做本机标记也做云端打点', /markRunning\(task\);[\s\S]{0,120}beatCloud\(task\);/.test(appSrc));
  /* 注释里还提到这个词（说明为什么不认它），所以只断言「没有被当成值读」 */
  ok('判活不再读从不写入的 heartbeatAt', !/t\.heartbeatAt/.test(appSrc) && !/heartbeatAt\s*\|\|/.test(appSrc));
  ok('打点 20 秒一拍、补写间隔 50 秒', /HEARTBEAT_MS = 20000/.test(appSrc) && /HEARTBEAT_GAP = 50000/.test(appSrc));
  ok('判活读的是云端 updated_at', /const beat = t\.updatedAt \|\| 0;/.test(appSrc));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
