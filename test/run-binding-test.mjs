/* 跑着的任务 ≠ 正在看的任务。
 *
 * 线上实测：A「画个马克杯 + 做个 PPT」跑着的时候点开 B「长任务怎么构建」，
 * A 的工具步骤、结论、PPT 产出物一路写进 B 的对话；收工那下还把 A 的整条记录
 * 拷进了 B（ba_tasks 里 B 的 steps 混进了 gen_image / make_deck，result 变成 PPT 的话）。
 *
 * 根因：事件全写全局 state.trace，落库全用 state.curTaskId，收工 assign 给 curTask()。
 * 这里把「这一轮归谁」钉住：事件、落库、收工只认这一轮所属的任务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('接线：这一轮归谁');
{
  ok('有 runCtx（跑的任务单独记）', /let runCtx = null;/.test(appSrc));
  ok('runTask() 认跑着的那个', /function runTask\(\) \{ return runCtx \? runCtx\.task : curTask\(\); \}/.test(appSrc));
  ok('runTrace() 认跑着的那份现场', /function runTrace\(\) \{ return \(runCtx && runCtx\.trace\) \|\| state\.trace; \}/.test(appSrc));
  ok('watchingRun() 判断老板眼睛在哪', /function watchingRun\(\) \{ return !runCtx \|\| runCtx\.id === state\.curTaskId; \}/.test(appSrc));
  ok('runGoal 起跑时挂上 runCtx', /runCtx = \{ id: task\.id, task, trace: state\.trace, startedAt: state\.traceStartedAt \};/.test(appSrc));
  ok('收工后解开 runCtx', /\n    runCtx = null;/.test(appSrc));
}

console.log('事件入口：不在看的那个任务，只记账不画界面');
{
  const i = appSrc.indexOf('function handleEvent(ev) {');
  const j = appSrc.indexOf('async function grantAndRerun(cat)');
  const seg = appSrc.slice(i, j);
  ok('handleEvent 只是个转发壳', /applyEvent\(ev, !watchingRun\(\)\);/.test(seg));
  ok('applyEvent 从 runTrace() 取现场（不再是全局 state.trace）', /const tr = runTrace\(\);/.test(seg));
  ok('applyEvent 里不再直接摸 state.trace', !/state\.trace/.test(seg));
  ok('renderTrace 被 muted 挡住', /const paint = \(\) => \{ if \(!muted\) renderTrace\(\); \};/.test(seg));
  ok('renderTraceSoon 同样被挡', /const paintSoon = \(\) => \{ if \(!muted\) renderTraceSoon\(\); \};/.test(seg));
  ok('秒表不在别人页面上跳', /if \(!muted\) startLiveTick\(\);/.test(seg) && /if \(!muted\) stopLiveTick\(\);/.test(seg));
  ok('收工按 ev.task 找列表项，不按当前页', /const li = state\.tasks\.find\(x => x\.id === ev\.task\.id\);/.test(seg));
}

console.log('落库与收工：只认这一轮的任务');
{
  const i = appSrc.indexOf('function scheduleRunSave() {');
  const j = appSrc.indexOf('/* ── 模型核对');
  const seg = appSrc.slice(i, j);
  ok('节流落库用 runCtx.id，不用 curTaskId', /const id = runCtx \? runCtx\.id : state\.curTaskId;/.test(seg));
  ok('节流落库的 result 取这一轮的', /result: \(runCtx \? runCtx\.trace : state\.trace\)\.result \|\| ''/.test(seg));

  ok('buildSteps 可以指定现场', /function buildSteps\(task, trace\)/.test(appSrc));
  ok('buildSteps 挑现场认 id（对象引用换了也算同一条）', /runCtx && runCtx\.id === task\.id \? runCtx\.trace : null/.test(appSrc));
  ok('buildSteps 只有「老板正打开的那条」才借 state.trace，别的任务一律不借',
    /\(state\.curTaskId === task\.id \? state\.trace : null\)/.test(appSrc));
  ok('buildSteps 不再无条件退回 state.trace（那是反方向串台的口子）',
    !/const tr = trace \|\| \(\(runCtx && runCtx\.task === task\) \? runCtx\.trace : state\.trace\) \|\| \{\};/.test(appSrc));
  ok('收工那句 assign 作用在 runTask() 上',
    (() => {
      const k = appSrc.indexOf("} else if (ev.t === 'done') {");
      const m = appSrc.indexOf('Object.assign(t, ev.task)', k);
      const head = appSrc.slice(k, m);
      return m > k && /const t = runTask\(\);/.test(head);
    })());
}

console.log('切任务：正在跑的那个不许重建现场');
{
  const i = appSrc.indexOf('const curR = syncRounds(t).rounds || 1;');
  const seg = appSrc.slice(i, i + 900);
  ok('点回正在跑的任务时沿用内存里那份现场', /state\.trace = \(runCtx && runCtx\.id === id\) \? runCtx\.trace : \{/.test(seg));
  ok('其它任务照旧从存档重建', /nodes: \(t\.steps \|\| \[\]\)\.filter/.test(seg));
  ok('起跑时刻不被清掉（否则本轮耗时会从 1970 算起）',
    /state\.traceStartedAt = \(runCtx && runCtx\.id === id\) \? \(runCtx\.startedAt \|\| 0\) : 0;/.test(appSrc));
}

console.log('插话：不能把 B 框里的话塞进 A');
{
  const g = appSrc.indexOf('async function runGoal(goal, existingTaskId) {');
  const i = appSrc.indexOf('if (state.running) {', g);
  const seg = appSrc.slice(i, i + 2600);
  ok('看的是别的任务就先劝住', /if \(!watchingRun\(\)\) \{/.test(seg));
  ok('提示里点名是哪个任务在跑', /还在跑，等它收工或先按 ■ 停掉再发/.test(seg));
  /* 先投递、再记账：投递失败（那一轮其实已经结束）要能把这句话改走新一轮，
     不能先记进 userMsgs 再说「已插给员工」——那是假的 */
  ok('先确认插话真送到了', /const delivered = await agentInject\(text2 \+ docHint, imgs\);/.test(seg));
  ok('没送到就退回输入区重发', /window\.ATT_MAIN\.restore\(atts\)/.test(seg));
  ok('插话记账落在跑着的那个任务上', /const t = runTask\(\);[\s\S]{0,80}const live = runTrace\(\);/.test(seg));
}

/* ── 行为验证：把真函数拉出来跑 ── */
console.log('行为：A 在跑、老板点开 B');
{
  const hStart = appSrc.indexOf('let runCtx = null;');
  const hEnd = appSrc.indexOf('function buildSteps(task, trace)');
  const bStart = hEnd;
  const bEnd = appSrc.indexOf('function scheduleRunSave() {');
  if (hStart < 0 || hEnd < 0 || bEnd < 0) {
    ok('能抽出 runCtx 与 buildSteps', false);
  } else {
    const state = { trace: null, traceStartedAt: 0, curTaskId: 'B' };
    const maxRoundOf = t => Math.max(1, ...(t.steps || []).map(s => Number(s.round) || 1));
    const roundBaseTokens = () => ({ in: 0, out: 0 });
    const factory = new Function('state', 'maxRoundOf', 'roundBaseTokens', `
      ${appSrc.slice(hStart, hEnd)}
      ${appSrc.slice(bStart, bEnd)}
      return { runTask, runTrace, watchingRun, buildSteps, setCtx: c => { runCtx = c; } };
    `);
    const M = factory(state, maxRoundOf, roundBaseTokens);
    const curTask = () => ({ id: 'B' }); // 仅作语义占位；runTask 用 runCtx

    const taskA = { id: 'A', steps: [], round: 1, tokens: { in: 10, out: 5 } };
    const taskB = { id: 'B', steps: [{ kind: 'tool', round: 1, name: 'list_dir', output: 'B 的目录' }], round: 2 };
    const traceA = { round: 2, status: 'running', nodes: [{ name: 'gen_image', files: ['assets/mug.png'] }], says: [{ text: 'A 的结论' }], result: 'A 的结论' };
    /* B 已经跑到第 2 轮：第 1 轮的 list_dir 是历史轮，这一轮还没调工具 */
    const traceB = { round: 2, status: 'running', nodes: [], says: [{ text: 'B 的结论' }], result: 'B 的结论' };

    state.trace = traceB;
    state.curTaskId = 'B';
    M.setCtx({ id: 'A', task: taskA, trace: traceA, startedAt: Date.now() });

    ok('跑着的是 A，看的是 B：watchingRun=false', M.watchingRun() === false);
    ok('runTask() 仍是 A（不是 B）', M.runTask().id === 'A');
    ok('runTrace() 仍是 A 的现场', M.runTrace() === traceA);

    /* 关键：此时给 A 存快照，绝不能把 B 的节点拼进去，也不能漏掉 A 的 */
    const stepsA = M.buildSteps(taskA);
    const namesA = stepsA.filter(s => s.kind === 'tool').map(s => s.name);
    ok('A 的快照含 A 自己的工具调用', namesA.includes('gen_image'), namesA.join(','));
    ok('A 的快照不含 B 的工具调用', !namesA.includes('list_dir'), namesA.join(','));
    ok('A 的快照含 A 的结论', stepsA.some(s => s.kind === 'say' && s.text === 'A 的结论'));

    /* 反过来：老板这会儿切回 A，runTrace 就是 state.trace 的那个对象 */
    state.curTaskId = 'A';
    ok('切回 A：watchingRun=true', M.watchingRun() === true);

    /* B 自己存快照时用的是 B 的现场，不能混进 A 的 gen_image */
    state.curTaskId = 'B';
    const stepsB = M.buildSteps(taskB);
    const namesB = stepsB.filter(s => s.kind === 'tool').map(s => s.name);
    ok('B 的快照仍是 B 自己的', namesB.includes('list_dir') && !namesB.includes('gen_image'), namesB.join(','));
    ok('B 的结论没被 A 顶掉', stepsB.some(s => s.kind === 'say' && s.text === 'B 的结论'));

    /* 没有跑着的任务时，一切照旧回落到当前打开的那个 */
    M.setCtx(null);
    ok('没跑任务：runTrace 回到 state.trace', M.runTrace() === state.trace);
    ok('没跑任务：watchingRun 恒真', M.watchingRun() === true);

    /* 反方向（2026-11-03 线上踩过）：没在跑、老板看着 A，却要给 B 存档。
       B 绝不能借 A 的现场；同时 B 自己已有的步骤（含最后一轮）一条都不许丢。 */
    state.curTaskId = 'A';
    state.trace = traceA;
    const stepsB2 = M.buildSteps(taskB);
    const namesB2 = stepsB2.filter(s => s.kind === 'tool').map(s => s.name);
    ok('存 B 时不借 A 的现场：没有 gen_image', !namesB2.includes('gen_image'), namesB2.join(','));
    ok('存 B 时不借 A 的结论', !stepsB2.some(s => s.kind === 'say' && s.text === 'A 的结论'));
    ok('存 B 时不弄丢 B 自己的步骤', namesB2.includes('list_dir'), namesB2.join(','));
    ok('存 B 时不弄丢 B 自己的结论', stepsB2.some(s => s.kind === 'say' && s.text === 'B 的结论'));
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
