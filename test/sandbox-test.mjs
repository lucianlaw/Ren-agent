/* 执行隔离：uid 分配与逃生门
 *
 * 这一套测的不是「隔离好不好用」，是「决策有没有跑偏」：
 *   · 同一个账号永远拿同一个 uid（重启、重新部署都不能变，否则 chown 过的东西全失效）
 *   · 不同账号拿到不同 uid（撞了就等于两个人共用一个身份）
 *   · 没有隔离能力时必须拒绝执行，而不是悄悄照跑
 *
 * 真实的越权拦截效果只能在线上验证（需要 root 才能建独立 uid），
 * 那一步在部署后打 /api/health?key=… 看 runtime.mode，再跑一次越权探针。
 * 这里能锁死的是「逻辑不许退回到应用层检查」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uidForScope, probeRuntime, resetProbe, runIsolated, UID_BASE, UID_SPAN } from '../lib/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

console.log('[1] uid 分配');
{
  const ua = uidForScope(A);
  eq('同一个 scope 永远同一个 uid', uidForScope(A), ua);
  ok('uid 落在保留段内', ua >= UID_BASE && ua < UID_BASE + UID_SPAN, ua);
  ok('不是 root', ua !== 0);
  ok('两个账号拿到的 uid 不同', uidForScope(A) !== uidForScope(B), { a: ua, b: uidForScope(B) });

  /* 1000 个随机 scope 里不该出现碰撞：10 万槽位、1000 个样本，
     期望碰撞 ~5 个（生日问题），但那 5 个落在「真有多人」时是隐患。
     这里只要求「常见规模（200 个账号）不撞」。 */
  const seen = new Map();
  let clash = 0;
  for (let i = 0; i < 200; i++) {
    const s = (i.toString(16).padStart(8, '0')).repeat(4);
    const u = uidForScope(s);
    if (seen.has(u)) clash++;
    seen.set(u, s);
  }
  eq('200 个账号没有 uid 碰撞', clash, 0);
}

console.log('\n[2] 运行时探测');
{
  resetProbe();
  const r = probeRuntime();
  ok('返回 platform', typeof r.platform === 'string' && r.platform.length > 0);
  ok('mode 是已知值之一', ['uid-split', 'bwrap', 'none', 'off'].includes(r.mode), r.mode);
  ok('给了 why（人话解释）', typeof r.why === 'string' && r.why.length > 0, r.why);
  ok('结果被缓存（两次同一对象）', probeRuntime() === r);
}

console.log('\n[3] 逃生门与拒绝');
{
  /* 显式关闭：必须照跑，并标记 mode=off——它存在的意义是「我知道自己在裸跑」 */
  process.env.REN_SANDBOX = 'off';
  resetProbe();
  eq('REN_SANDBOX=off 时 mode 变 off', probeRuntime().mode, 'off');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-off-'));
  const r = await runIsolated({ cmd: 'echo hi', cwd: dir, scope: A, timeout: 5000 });
  ok('off 模式下照常执行', !r.refused && /hi/.test(r.stdout || ''), r);
  fs.rmSync(dir, { recursive: true, force: true });

  delete process.env.REN_SANDBOX;
  resetProbe();
  ok('取消后恢复自动探测', probeRuntime().mode !== 'off', probeRuntime().mode);
}

console.log('\n[4] 没有隔离能力时不许照跑（架构断言）');
{
  /* 这条是防回归：哪天有人图省事把 run_shell 改回直接 execFile，
     这里会立刻红——因为「应用层检查能挡住任意代码」已经被实测证伪了。 */
  const tools = fs.readFileSync(path.join(ROOT, 'lib/tools.js'), 'utf8');
  ok('run_shell 走 runIsolated', /runIsolated\(\s*\{[^}]*cmd/.test(tools));
  ok('run_shell 里不再直接 execFile', !/name === 'run_shell'[\s\S]{0,900}?execFile\(/.test(tools));

  const sb = fs.readFileSync(path.join(ROOT, 'lib/sandbox.js'), 'utf8');
  ok('none 分支返回 refused', /refused:\s*true/.test(sb));
  ok('uid-split 传了 uid/gid 选项', /uid,\s*gid:\s*uid/.test(sb));
  ok('启动时会全量收紧账号目录', /export function hardenAll/.test(sb));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
