/* ── 状态机单一来源 ────────────────────────────────────────────────────────
 *
 * 技术文档第 6 节要求 Task / Node / Project 各自有权威状态，且状态迁移必须
 * 合法、由统一的地方判定。改造之前我们是三套各写各的：
 *   任务  t.status = queued | running | done | weak | failed | interrupted
 *                   | budget_exceeded | need_input | void | blocked
 *   项目  m.status = briefing | awaiting | planning | confirm | analyzing
 *                   | done | failed | halted
 *   节点  o.status = wait | run | ask | skip | fail | weak | done
 * 同一个「等前置」在项目里叫 wait、在任务步骤里叫 todo；「完成但有瑕疵」
 * 一边叫 weak、另一边也叫 weak——但这只是巧合，没有共同的定义。
 *
 * 这个文件把三套归到一套标准词表，对外提供：
 *   - fromLegacy  : 旧词 → 标准状态（决定语义）
 *   - label/dot   : 标准状态 → 中文/圆点色（决定显示）
 *   - canTransit  : 标准状态之间的合法迁移（决定能不能走）
 *
 * 原则：标准词表是「判定用的」，旧词是「显示用的」。任务的界面文案一个字
 * 都不改（老板看惯了），改的是底层判定不再各说各话。
 */
(function (root) {
  'use strict';

  /* ── 三套标准状态 ── */
  const NODE = {
    PENDING: 'pending',      // 依赖未满足
    READY: 'ready',          // 依赖满足，可领取
    RUNNING: 'running',      // 执行中
    WAITING: 'waiting',      // 等事件/审批/输入
    SUCCEEDED: 'succeeded',  // 验收通过
    RETRYABLE: 'retryable_failed', // 失败但允许重试
    FAILED: 'failed',        // 不可恢复或重试耗尽
    SKIPPED: 'skipped',      // 条件分支跳过
    CANCELLED: 'cancelled'
  };

  const TASK = {
    CREATED: 'created',
    ANALYZING: 'analyzing',
    NEEDS_INPUT: 'needs_input',
    PLANNED: 'planned',
    NEEDS_APPROVAL: 'needs_approval',
    READY: 'ready',
    RUNNING: 'running',
    WAITING: 'waiting',
    REVIEW: 'review',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    ARCHIVED: 'archived'
  };

  const PROJ = {
    CREATED: 'created',
    DISCOVERY: 'discovery',
    NEEDS_INPUT: 'needs_input',
    PLANNING: 'planning',
    NEEDS_APPROVAL: 'needs_approval',
    ACTIVE: 'active',
    PAUSED: 'paused',
    BLOCKED: 'blocked',
    REVIEW: 'review',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    ARCHIVED: 'archived'
  };

  /* ── 旧词 → 标准状态 ────────────────────────────────────────────────────
   * 注意几个不能想当然的对应：
   *   weak 不是一个独立状态，它是「完成但验收存疑」——标准里属于 COMPLETED，
   *   存疑这层信息留在 verify 上，别塞进状态里（状态一膨胀就没法做迁移校验）。
   *   interrupted 不是 failed：它是「跑到一半断了，能续」，属于 READY 的前身。
   *   halted（项目）是「预算/积分到线停下」，属于 PAUSED 而不是 FAILED，
   *   因为它是可以被用户点一下继续的，而 FAILED 按文档定义不可自动恢复。
   */
  const TASK_MAP = {
    queued: TASK.CREATED,
    pending: TASK.CREATED,
    created: TASK.CREATED,
    analyzing: TASK.ANALYZING,
    planning: TASK.PLANNED,
    planned: TASK.PLANNED,
    need_input: TASK.NEEDS_INPUT,
    needs_input: TASK.NEEDS_INPUT,
    need_approval: TASK.NEEDS_APPROVAL,
    needs_approval: TASK.NEEDS_APPROVAL,
    ready: TASK.READY,
    running: TASK.RUNNING,
    waiting: TASK.WAITING,
    blocked: TASK.WAITING,
    review: TASK.REVIEW,
    done: TASK.COMPLETED,
    weak: TASK.COMPLETED,
    completed: TASK.COMPLETED,
    failed: TASK.FAILED,
    budget_exceeded: TASK.FAILED,   // 预算耗尽：文档归 FAILED 或人工接管
    credit_exhausted: TASK.FAILED,
    step_limit: TASK.FAILED,
    unverified: TASK.REVIEW,        // 产出没落盘：不是失败，是没过验收
    interrupted: TASK.READY,        // 断了但能续，不是失败
    void: TASK.CANCELLED,
    cancelled: TASK.CANCELLED,
    archived: TASK.ARCHIVED
  };

  const PROJ_MAP = {
    created: PROJ.CREATED,
    briefing: PROJ.DISCOVERY,
    discovery: PROJ.DISCOVERY,
    awaiting: PROJ.NEEDS_INPUT,
    needs_input: PROJ.NEEDS_INPUT,
    planning: PROJ.PLANNING,
    confirm: PROJ.NEEDS_APPROVAL,
    needs_approval: PROJ.NEEDS_APPROVAL,
    analyzing: PROJ.ACTIVE,
    active: PROJ.ACTIVE,
    paused: PROJ.PAUSED,
    halted: PROJ.PAUSED,            // 预算/积分到线：能接着跑，不是死
    blocked: PROJ.BLOCKED,
    review: PROJ.REVIEW,
    done: PROJ.COMPLETED,
    completed: PROJ.COMPLETED,
    failed: PROJ.FAILED,
    cancelled: PROJ.CANCELLED,
    archived: PROJ.ARCHIVED
  };

  const NODE_MAP = {
    pending: NODE.PENDING,
    todo: NODE.PENDING,
    wait: NODE.PENDING,        // 项目里「等前置」
    queued: NODE.PENDING,
    ready: NODE.READY,
    run: NODE.RUNNING,
    running: NODE.RUNNING,
    doing: NODE.RUNNING,
    ask: NODE.WAITING,         // 等老板拍板
    waiting: NODE.WAITING,
    done: NODE.SUCCEEDED,
    succeeded: NODE.SUCCEEDED,
    ok: NODE.SUCCEEDED,
    weak: NODE.SUCCEEDED,      // 存疑但产出在，仍算走完；存疑记在 verify 上
    retry: NODE.RETRYABLE,
    retryable_failed: NODE.RETRYABLE,
    fail: NODE.FAILED,
    failed: NODE.FAILED,
    skip: NODE.SKIPPED,
    skipped: NODE.SKIPPED,
    cancelled: NODE.CANCELLED
  };

  /* ── 标准状态 → 显示 ────────────────────────────────────────────────────
   * 任务的界面文案保持原样（老板看惯了），这里只供「新增的」统一视图使用。
   */
  const NODE_LABEL = {
    pending: '等前置', ready: '可开工', running: '跑着', waiting: '等你拍板',
    succeeded: '已核验', retryable_failed: '可重试', failed: '没跑成',
    skipped: '前置未完成', cancelled: '已取消'
  };
  const NODE_DOT = {
    pending: 'queued', ready: 'queued', running: 'running', waiting: 'blocked',
    succeeded: 'done', retryable_failed: 'failed', failed: 'failed',
    skipped: 'queued', cancelled: 'queued'
  };
  const TASK_LABEL = {
    created: '待开始', analyzing: '分析中', needs_input: '等补充',
    planned: '已计划', needs_approval: '等拍板', ready: '可续跑',
    running: '执行中', waiting: '等待中', review: '验收中',
    completed: '已完成', failed: '失败', cancelled: '已取消', archived: '已归档'
  };
  const PROJ_LABEL = {
    created: '已创建', discovery: '拆题中', needs_input: '等你拍板',
    planning: '拆解中', needs_approval: '等你确认', active: '推进中',
    paused: '已暂停', blocked: '卡住了', review: '验收中',
    completed: '已出纪要', failed: '中断', cancelled: '已取消', archived: '已归档'
  };

  /* ── 合法迁移 ──────────────────────────────────────────────────────────
   * 只列「允许走的路」，没列出来的一律拒绝。文档要求非法迁移被拒绝，
   * 我们做不到在数据库层拦（前端直连云表），但可以在写之前拦——
   * 至少能保证代码里的状态跳转不是随手写出来的。
   */
  const TRANSIT = {
    task: {
      created: ['analyzing', 'planned', 'ready', 'cancelled'],
      analyzing: ['needs_input', 'planned', 'failed', 'cancelled'],
      needs_input: ['analyzing', 'planned', 'cancelled'],
      planned: ['needs_approval', 'ready', 'cancelled'],
      needs_approval: ['ready', 'planned', 'cancelled'],
      ready: ['running', 'cancelled'],
      /* 文档是 running → review → completed 两跳。我们把验收做在收尾那一段里
         （落盘检查 + 验收人），所以允许直接到 completed——凭空插一个 review
         阶段会让任务界面多一步「验收中」，老板的体感是跑完就该看到结果。
         但 archived 仍然只能从 completed / cancelled 过来，没过验收不许归档。 */
      running: ['waiting', 'review', 'failed', 'completed', 'cancelled'],
      waiting: ['running', 'needs_input', 'cancelled'],
      review: ['running', 'completed', 'failed', 'cancelled'],
      completed: ['archived'],
      failed: ['ready', 'cancelled', 'archived'],
      cancelled: ['archived'],
      archived: []
    },
    project: {
      created: ['discovery', 'cancelled'],
      discovery: ['needs_input', 'planning', 'cancelled'],
      needs_input: ['discovery', 'planning', 'cancelled'],
      planning: ['needs_approval', 'active', 'cancelled'],
      needs_approval: ['active', 'planning', 'cancelled'],
      active: ['paused', 'blocked', 'review', 'completed', 'cancelled'],
      paused: ['active', 'cancelled'],
      blocked: ['active', 'paused'],
      review: ['active', 'completed'],
      completed: ['archived'],
      cancelled: ['archived'],
      archived: []
    },
    node: {
      pending: ['ready', 'skipped', 'cancelled'],
      ready: ['running', 'cancelled'],
      running: ['waiting', 'succeeded', 'retryable_failed', 'failed', 'cancelled'],
      waiting: ['running', 'cancelled'],
      retryable_failed: ['ready', 'failed', 'cancelled'],
      failed: ['ready', 'cancelled'],
      succeeded: [],
      skipped: [],
      cancelled: []
    }
  };

  function fromLegacy(kind, s) {
    const v = String(s == null ? '' : s).trim().toLowerCase();
    if (kind === 'task') return TASK_MAP[v] || TASK.CREATED;
    if (kind === 'project') return PROJ_MAP[v] || PROJ.CREATED;
    if (kind === 'node') return NODE_MAP[v] || NODE.PENDING;
    return v;
  }

  /* 迁移校验：返回 true/false。未知状态一律放行（别因为词表没覆盖就卡住线上） */
  function canTransit(kind, from, to) {
    const a = fromLegacy(kind, from);
    const b = fromLegacy(kind, to);
    const table = TRANSIT[kind];
    if (!table || !table[a]) return true;
    if (a === b) return true;
    return table[a].indexOf(b) >= 0;
  }

  /* ── 心跳判活 ──────────────────────────────────────────────────────────
   * 文档的 Lease 在这里的等价物：执行方定时打点，超时即认为「没人握着」。
   * 90 秒是经验值——一次生图/长文生成可能跑 60 秒以上，压得太紧会误判。
   */
  const STUCK_MS = 90 * 1000;
  function heartbeatFresh(at, now) {
    const t = Number(at) || 0;
    if (!t) return false;
    return (now == null ? Date.now() : now) - t < STUCK_MS;
  }
  /* running 但心跳不新鲜 = 卡死/页面被关掉，应该按「断了能续」处理 */
  function looksStuck(status, at, now) {
    return fromLegacy('task', status) === TASK.RUNNING && !heartbeatFresh(at, now);
  }

  const STATES = {
    NODE, TASK, PROJ,
    node: {
      from: s => fromLegacy('node', s),
      label: s => NODE_LABEL[fromLegacy('node', s)] || '',
      dot: s => NODE_DOT[fromLegacy('node', s)] || 'queued',
      isDone: s => fromLegacy('node', s) === NODE.SUCCEEDED,
      isLive: s => [NODE.RUNNING, NODE.WAITING].indexOf(fromLegacy('node', s)) >= 0,
      isBlocked: s => [NODE.PENDING, NODE.WAITING].indexOf(fromLegacy('node', s)) >= 0
    },
    task: {
      from: s => fromLegacy('task', s),
      label: s => TASK_LABEL[fromLegacy('task', s)] || '',
      isOver: s => [TASK.COMPLETED, TASK.FAILED, TASK.CANCELLED, TASK.ARCHIVED]
        .indexOf(fromLegacy('task', s)) >= 0,
      canResume: s => [TASK.READY, TASK.FAILED, TASK.REVIEW].indexOf(fromLegacy('task', s)) >= 0
    },
    project: {
      from: s => fromLegacy('project', s),
      label: s => PROJ_LABEL[fromLegacy('project', s)] || '',
      isOver: s => [PROJ.COMPLETED, PROJ.CANCELLED, PROJ.ARCHIVED]
        .indexOf(fromLegacy('project', s)) >= 0,
      canResume: s => [PROJ.PAUSED, PROJ.BLOCKED, PROJ.ACTIVE].indexOf(fromLegacy('project', s)) >= 0
    },
    canTransit,
    STUCK_MS, heartbeatFresh, looksStuck
  };

  root.STATES = STATES;
  if (typeof module !== 'undefined' && module.exports) module.exports = STATES;
})(typeof window !== 'undefined' ? window : globalThis);
