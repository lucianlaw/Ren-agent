/* 状态层：重启不丢、多进程一致、坏环境降级
 *
 * 这批断言针对的是「内存里那份 Map」换到磁盘之后**最容易骗人的三件事**：
 *   1. 收尸：把「进程没了但状态还写着 running」当成还活着 —— 界面永远转圈，
 *      而真正在跑的那个反而可能被误杀。两个方向都要测。
 *   2. 计数：重启把额度清零 —— 这正是「重启即重置」这条免费通道。
 *      所以必须换一个进程去读，同进程读自己的内存说明不了任何事。
 *   3. 降级：sqlite 打不开时静默降级成内存 —— 那等于「持久化」只写在文档里。
 *      降级本身可以接受，但不许**假装**没降级。
 *
 * 这里大量用子进程，不是因为喜欢，是因为这三件事的定义就跨越了进程边界。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
const DIR = path.join(TMP, 'state');
process.env.REN_STATE_DIR = DIR;
const FILE = path.join(DIR, 'state.db');

const s = await import('../lib/state.js');

/* 子进程：独立进程才有独立的 boot / 内存，才能验「重启」 */
function inChild(code, env = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
}
/* 子进程的 stdout 里会混进日志（例如「已收尸 1 个」），所以只认最后一行能解析的 JSON。
   直接 JSON.parse(stdout) 会把日志当成数据，报一个和真实问题毫无关系的语法错误。 */
function outJson(r, fallback = {}) {
  for (const line of String(r.out || '').split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try { return JSON.parse(t); } catch { /* 不是这行 */ }
  }
  return fallback;
}

const SCOPE = 'a'.repeat(32);

console.log('\n[1] 初始化与落盘');
{
  const i = s.init();
  eq('用了 sqlite', i.mode, 'sqlite');
  ok('状态库落在部署目录之外', !i.file.startsWith(path.resolve('.')), i.file);
  ok('库文件真的生成了', fs.existsSync(FILE), FILE);
  eq('重复 init 幂等', s.init().mode, 'sqlite');
  ok('stats 能报出来', s.stats().runs.total >= 0, s.stats());
}

console.log('\n[2] 任务注册表');
{
  s.runBegin({ id: 'r1', scope: SCOPE, title: '做一份报价表', device: 'macbook', model: 'm1' });
  const r = s.runGet('r1');
  eq('状态是 running', r.status, 'running');
  eq('标题记住了', r.title, '做一份报价表');
  eq('设备记住了', r.device, 'macbook');
  s.runEnd('r1', { status: 'done' });
  eq('结束后状态变了', s.runGet('r1').status, 'done');
  ok('结束时间有值', s.runGet('r1').endedAt > 0, s.runGet('r1'));

  const recent = s.runRecent(SCOPE, 5);
  ok('最近任务里有它', recent.some(x => x.id === 'r1'), recent);
  eq('别的 scope 看不到', s.runRecent('b'.repeat(32), 5).length, 0);
}

console.log('\n[3] 占用锁：同 key 互斥，换 key 放行');
{
  eq('A 拿到锁', s.acquireLock('run:x', 'rA').ok, true);
  eq('B 抢同一个 key 被拒', s.acquireLock('run:x', 'rB').ok, false);
  eq('B 被告知占用者', s.acquireLock('run:x', 'rB').holder, 'rA');
  eq('A 重复拿自己的锁是幂等的', s.acquireLock('run:x', 'rA').ok, true);
  eq('另一把 key 不受影响（多设备并发的关键）', s.acquireLock('run:y', 'rB').ok, true);
  s.releaseLock('run:x', 'rA');
  eq('释放后 B 能拿到', s.acquireLock('run:x', 'rB').ok, true);
  eq('holder 查得到', s.lockHolder('run:x'), 'rB');
  s.releaseLock('run:x', 'rB');
  eq('释放后没人占', s.lockHolder('run:x'), '');
  /* 释放只能由持有者做：否则任何任务都能把别人的锁解开 */
  s.acquireLock('run:z', 'rA');
  s.releaseLock('run:z', 'rB');
  eq('别人解不开我的锁', s.lockHolder('run:z'), 'rA');
  s.releaseLock('run:z', 'rA');
}

console.log('\n[4] 路径租约：并发写同一文件才冲突');
{
  const f1 = path.join(TMP, 'a.md');
  const f2 = path.join(TMP, 'b.md');
  eq('设备 A 租到 a.md', s.leasePath(f1, 'rA').ok, true);
  eq('设备 B 抢 a.md 被拒', s.leasePath(f1, 'rB').ok, false);
  eq('设备 B 写 b.md 不受影响', s.leasePath(f2, 'rB').ok, true);
  s.releaseLeases('rA');
  eq('任务结束释放全部租约', s.leasePath(f1, 'rB').ok, true);
  ok('释放后 a.md 是 B 的', s.leasePath(f1, 'rB').ok);
}

console.log('\n[5] 限流：换进程也不清零');
{
  const LIMIT = 3;
  for (let i = 0; i < 2; i++) s.takeRate('k1', 60000, LIMIT);
  s.flushRate();
  const r = inChild(`
    const s = await import(${JSON.stringify(path.resolve('lib/state.js'))});
    s.init();
    const a = s.takeRate('k1', 60000, ${LIMIT});
    const b = s.takeRate('k1', 60000, ${LIMIT});
    console.log(JSON.stringify([a.n, a.ok, b.n, b.ok]));
  `);
  const [n1, ok1, n2, ok2] = outJson(r, []);
  eq('新进程看到的是第 3 次', n1, 3);
  eq('第 3 次仍放行', ok1, true);
  eq('第 4 次被拒', ok2, false);
  ok('跨进程计数是累加的，不是各算各的', n2 === 4, r.out);
}

console.log('\n[6] 收尸：进程没了要标中断，进程还在不能误杀');
{
  /* 幽灵任务必须由**一个已经退出的进程**创建：pid 是那个子进程的，
     这样「本机 pid 已不存在」这条判据才成立。用当前测试进程去建，
     pid 是活的，判据会正确地认为它还在跑——那是测试写错了，不是代码错了。 */
  const mk = inChild(`
    const s = await import(${JSON.stringify(path.resolve('lib/state.js'))});
    s.init();
    s.runBegin({ id: 'ghost', scope: '${SCOPE}', title: '跑到一半被打断' });
    console.log(JSON.stringify({ pid: process.pid }));
  `);
  const ghostPid = outJson(mk).pid;
  ok('幽灵任务是由别的进程建的', ghostPid > 0 && ghostPid !== process.pid, { ghostPid, me: process.pid });

  /* 把心跳推到 60 秒前，模拟「进程已经死了但没来得及写收尾」 */
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(FILE);
  d.prepare('UPDATE runs SET hb_at = ? WHERE id = ?').run(Date.now() - 60000, 'ghost');
  d.close();

  const r = inChild(`
    const s = await import(${JSON.stringify(path.resolve('lib/state.js'))});
    const i = s.init();
    const row = s.runGet('ghost');
    console.log(JSON.stringify({ reaped: i.reaped, status: row.status, reason: row.reason }));
  `);
  const j = outJson(r);
  ok('新进程启动时收掉了它', j.reaped >= 1, j);
  eq('状态是 interrupted', j.status, 'interrupted');
  ok('给出了人话原因', /中断/.test(j.reason || ''), j.reason);

  /* 反方向：另一个进程还活着（心跳新鲜），不能被杀 */
  s.runBegin({ id: 'alive', scope: SCOPE, title: '真的在跑' });
  const r2 = inChild(`
    const s = await import(${JSON.stringify(path.resolve('lib/state.js'))});
    s.init();
    console.log(JSON.stringify(s.runGet('alive').status));
  `);
  eq('心跳新鲜的任务不被收尸', r2.out, '"running"');
  s.runEnd('alive', { status: 'done' });
}

console.log('\n[7] 中断任务能被查到（不是无声消失）');
{
  const r = s.runGet('ghost');
  eq('还查得到这条记录', r.status, 'interrupted');
  ok('reason 存在', !!r.reason, r);
  ok('recent 里带得出状态', s.runRecent(SCOPE, 10).some(x => x.id === 'ghost' && x.status === 'interrupted'));
}

console.log('\n[8] 降级：打不开库时明确说自己在降级');
{
  const badDir = path.join(TMP, 'not-a-dir');
  fs.writeFileSync(badDir, 'x');   // 同名文件，mkdir 必失败
  const r = inChild(`
    const s = await import(${JSON.stringify(path.resolve('lib/state.js'))});
    const i = s.init();
    s.runBegin({ id: 'm1', scope: '${SCOPE}' });
    console.log(JSON.stringify({ mode: i.mode, why: i.why, hasRun: !!s.runGet('m1'), statMode: s.stats().mode }));
  `, { REN_STATE_DIR: badDir });
  const j = outJson(r);
  eq('降级为 memory', j.mode, 'memory');
  ok('说明了为什么', (j.why || '').length > 0, j.why);
  eq('降级后仍可用（不崩）', j.hasRun, true);
  eq('stats 也如实报 memory', j.statMode, 'memory');
}

console.log('\n[9] 库本身的一致性');
{
  const st = s.stats();
  ok('mode 是 sqlite', st.mode === 'sqlite', st);
  ok('库有体积', st.bytes > 0, st.bytes);
  ok('没有残留的活锁', st.locks <= 2, st);
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(FILE);
  const v = d.prepare('PRAGMA integrity_check').get();
  d.close();
  const val = Object.values(v || {})[0];
  eq('integrity_check 通过', val, 'ok');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
