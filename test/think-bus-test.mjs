/* 推理回显的传输层：think 事件要能实时到人，但不能撑爆重连日志。
 *
 * 约束是两条互相打架的：
 *   ① 断线重连靠 bus.log 补历史（有 4000 条上限）；
 *   ② think 是高频全量重发（每 140ms 一帧），一次长推理就能上千条。
 * 只满足 ①：think 全进 log → 真正的步骤被挤掉，刷新后任务起点没了。
 * 只满足 ②：think 不进 log → 在线的人看不到推理（这恰恰是本次要修的体验）。
 * 所以：不落 log，但订阅者拿到的那一刻直接透出。
 */
import { __test } from '../lib/agent-host.js';

const { Bus } = __test;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('think 不挤占重连日志');
{
  const bus = new Bus(50);
  for (let i = 0; i < 400; i++) bus.push({ t: 'think', content: 'x'.repeat(200) });
  ok('log 里一条 think 都没有', bus.log.length === 0, String(bus.log.length));
  ok('seq 照常递增（续传游标不能倒退）', bus.seq === 400, String(bus.seq));

  for (let i = 0; i < 10; i++) bus.push({ t: 'step', kind: 'call', name: 'tool' + i });
  ok('真正的步骤一条不少', bus.log.length === 10, String(bus.log.length));
  ok('log 里留下的是步骤', bus.log.every(r => r.ev.t === 'step'));
  bus.close();
}

console.log('在线订阅者仍然收得到 think');
{
  const bus = new Bus(50);
  const it = bus.since(bus.seq);
  const p = it.next();
  bus.push({ t: 'think', content: '正在推理：先看布局' });
  const r = await p;
  ok('实时收到 think', !r.done && r.value.ev.t === 'think', JSON.stringify(r.value && r.value.ev));
  bus.close();
  await it.next().catch(() => {});
}

console.log('补历史 + 接新事件不重复');
{
  const bus = new Bus(50);
  bus.push({ t: 'start' });
  bus.push({ t: 'text', content: '第一句' });
  const it = bus.since(0);
  const a = await it.next();
  const b = await it.next();
  ok('先把已经发生的补出来', a.value.ev.t === 'start' && b.value.ev.t === 'text');

  const p = it.next();
  bus.push({ t: 'step', kind: 'result', name: 'write_file' });
  const c = await p;
  ok('再接上新的', c.value.ev.t === 'step' && c.value.ev.name === 'write_file');

  /* 关键：这条已经实时发过了，不能因为后来进了 log 又发一遍 */
  const p2 = it.next();
  bus.push({ t: 'think', content: '想一下' });
  const d = await p2;
  ok('think 只发一次', d.value.ev.t === 'think');
  const p3 = it.next();
  bus.push({ t: 'done', task: {} });
  const e = await p3;
  ok('后续事件不重复也不丢', e.value.ev.t === 'done');
  bus.close();
  await it.next().catch(() => {});
}

console.log('从中间续传');
{
  const bus = new Bus(50);
  for (let i = 0; i < 5; i++) bus.push({ t: 'text', content: 'n' + i });
  const from = bus.log[2].seq;
  const it = bus.since(from);
  const r1 = await it.next();
  ok('只补 from 之后的', r1.value.seq > from && r1.value.ev.content === 'n3', JSON.stringify(r1.value));
  bus.close();
  await it.next().catch(() => {});
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
