/* dev 实例的隔离闸门
 *
 * 这两条约定（只有本人能访问、不碰生产数据）一旦破，代价都不是「有点不对」：
 *   - 绑 0.0.0.0 的 dev 实例 = 一个能改源码的入口挂在公网上；
 *   - 连到生产数据的 dev 实例 = 在 dev 里删掉的东西真的没了。
 * 所以这里不测「警告有没有打」，测的是「能不能起得来」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = await import('../lib/devinfo.js');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'devgate-'));
const DEV_ROOT = path.join(TMP, 'devroot');

/* 一份合格的 dev 配置：下面每个用例都是「在它上面改一处」 */
const goodEnv = () => ({
  REN_DEV_INSTANCE: '1',
  REN_DEV_ROOT: DEV_ROOT,
  HOST: '127.0.0.1',
  PORT: '8090',
  WORKSPACE_DIR: path.join(DEV_ROOT, 'workspace'),
  REN_STATE_DIR: path.join(DEV_ROOT, 'state'),
  AUDIT_DIR: path.join(DEV_ROOT, 'audit'),
  INCIDENT_DIR: path.join(DEV_ROOT, 'incidents')
});

console.log('\n[1] 非 dev 模式一律放行（生产和本地直接 node server.js 都不能被这段拦住）');
{
  ok('没有 REN_DEV_INSTANCE 时 devMode=false', D.devMode({}) === false);
  ok('空环境也放行', D.assertSafe({}).ok === true);
  const prod = D.assertSafe({ HOST: '0.0.0.0', PORT: '8080' });
  ok('生产形态（0.0.0.0:8080、默认目录）放行', prod.ok === true);
  /* 注意 isolationProblems 是纯判定，不看 devMode——所以生产形态在它眼里
     「不合格」是正常的（0.0.0.0 本来就不该出现在 dev 判据里）。
     生产形态能不能起来，看的是 assertSafe，也就是上面那条。 */
  ok('生产形态下 assertSafe 报的 problems 为空', prod.problems.length === 0);
  ok('生产形态 dev 标记为 false', prod.dev === false);
  for (const v of ['1', 'true', 'YES', 'on']) ok(`REN_DEV_INSTANCE=${v} 算 dev`, D.devMode({ REN_DEV_INSTANCE: v }) === true);
  for (const v of ['0', 'false', '', 'off']) ok(`REN_DEV_INSTANCE=${v} 不算 dev`, D.devMode({ REN_DEV_INSTANCE: v }) === false);
}

console.log('\n[2] 合格的 dev 配置能起来');
{
  const r = D.assertSafe(goodEnv());
  ok('assertSafe 通过', r.ok === true, r.problems);
  ok('标记为 dev', r.dev === true);
  ok('problems 为空', r.problems.length === 0);
}

console.log('\n[3] 谁能访问：HOST 必须是回环，且必须显式');
{
  const e1 = goodEnv(); delete e1.HOST;
  const r1 = D.assertSafe(e1);
  ok('不设 HOST 直接拒绝', r1.ok === false);
  ok('说明里点出「留空会走 0.0.0.0」', /0\.0\.0\.0/.test(r1.message), r1.message);

  for (const h of ['0.0.0.0', '192.168.1.9', '10.0.0.2', 'boss-agent.app.workbuddy.host', '::']) {
    const e = goodEnv(); e.HOST = h;
    const r = D.assertSafe(e);
    ok(`HOST=${h} 被拒`, r.ok === false, r.problems);
  }
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    const e = goodEnv(); e.HOST = h;
    ok(`HOST=${h} 放行`, D.assertSafe(e).ok === true, D.isolationProblems(e));
  }
}

console.log('\n[4] 端口：必须显式、必须是数、不能是生产口');
{
  const e1 = goodEnv(); delete e1.PORT;
  ok('不设 PORT 被拒', D.assertSafe(e1).ok === false);

  const e2 = goodEnv(); e2.PORT = '8080';
  const r2 = D.assertSafe(e2);
  ok('PORT=8080 被拒（会和生产抢）', r2.ok === false);
  ok('说明是「换一个端口」不是「端口非法」', /生产端口/.test(r2.message), r2.message);

  for (const bad of ['abc', '0', '-1', '70000']) {
    const e = goodEnv(); e.PORT = bad;
    ok(`PORT=${bad} 被拒`, D.assertSafe(e).ok === false);
  }
  ok('PORT=8090 放行', D.assertSafe(goodEnv()).ok === true);
}

console.log('\n[5] 数据边界：四个目录都得显式设，都得在 dev 根里');
{
  const KEYS = ['WORKSPACE_DIR', 'REN_STATE_DIR', 'AUDIT_DIR', 'INCIDENT_DIR'];
  for (const k of KEYS) {
    const e = goodEnv(); delete e[k];
    const r = D.assertSafe(e);
    ok(`不设 ${k} 被拒`, r.ok === false);
    ok(`不设 ${k} 时说明提到「落回默认路径」`, /默认路径/.test(r.message), r.message);
  }

  /* 最关键的一条：路径写成了生产目录 */
  const PRODISH = [
    ['WORKSPACE_DIR', 'workspace'],
    ['REN_STATE_DIR', '..ren-state'],
    ['AUDIT_DIR', 'data/audit'],
    ['INCIDENT_DIR', 'data/incidents']
  ];
  for (const [k, rel] of PRODISH) {
    const e = goodEnv(); e[k] = path.resolve(ROOT, rel);
    const r = D.assertSafe(e);
    ok(`${k} 指到 dev 根外面被拒`, r.ok === false, r.problems);
    ok(`${k} 的说明点出「动真实数据」`, /真实数据/.test(r.message), r.message);
  }

  /* 相对路径也要能正确解析：../../ 跳出去必须被抓到 */
  const e3 = goodEnv();
  e3.AUDIT_DIR = path.join(DEV_ROOT, '..', '..', 'escape');
  ok('用 ../ 跳出去同样被拒', D.assertSafe(e3).ok === false, D.isolationProblems(e3));

  /* 边界：/a/bc 不能算在 /a/b 之下（纯字符串前缀会误判） */
  ok('under 不吃前缀误判', D.__test.under('/x/dev', '/x/devil/a') === false);
  ok('under 认自己的子目录', D.__test.under('/x/dev', '/x/dev/a') === true);
  ok('under 认根自身', D.__test.under('/x/dev', '/x/dev') === true);

  const e4 = goodEnv(); delete e4.REN_DEV_ROOT;
  ok('没有 REN_DEV_ROOT 被拒（否则无从判断边界）', D.assertSafe(e4).ok === false);
}

console.log('\n[6] 多个问题一次全报，不是修一个报一个');
{
  const e = { REN_DEV_INSTANCE: '1', HOST: '0.0.0.0', PORT: '8080' };
  const p = D.isolationProblems(e);
  ok('至少报 6 条（host + port + 4 个目录）', p.length >= 6, p.length);
  ok('每条都有中文说明', p.every(s => /[\u4e00-\u9fa5]/.test(s)), p);
  const m = D.assertSafe(e).message;
  ok('消息里带「这是闸门，不是 bug」', /闸门/.test(m), m.slice(0, 80));
  ok('消息里给出解法（npm run dev）', /npm run dev/.test(m), m.slice(0, 80));
}

console.log('\n[7] 真起进程：不合格的 dev 实例必须 exit 2，且不监听端口');
{
  const run = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => { c.kill('SIGKILL'); resolve({ code: 'timeout', out }); }, 8000);
    c.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });

  const bad = await run({
    REN_DEV_INSTANCE: '1',
    REN_DEV_ROOT: DEV_ROOT,
    HOST: '0.0.0.0',
    PORT: '35993',
    WORKSPACE_DIR: path.join(DEV_ROOT, 'workspace'),
    REN_STATE_DIR: path.join(DEV_ROOT, 'state'),
    AUDIT_DIR: path.join(DEV_ROOT, 'audit'),
    INCIDENT_DIR: path.join(DEV_ROOT, 'incidents')
  });
  eq('绑 0.0.0.0 的 dev 实例退出码是 2', bad.code, 2);
  ok('退出前把原因打出来了', /不是回环地址/.test(bad.out), bad.out.slice(0, 300));
  ok('没有走到「已启动」', !/已启动/.test(bad.out), bad.out.slice(0, 300));
}

console.log('\n[8] 源码钉住：这三处一旦被改，闸门就形同虚设');
{
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('server.js 启动了闸门', /DEVINFO\.assertSafe\(\)/.test(src));
  ok('不合格时 exit 2（和生产崩了的 1 区分开）', /process\.exit\(2\)/.test(src));
  ok('health 暴露 dev 标记', /dev:\s*DEV\.dev/.test(src));
  ok('启动日志有 dev 提示', /dev 实例：只绑回环/.test(src));

  const dev = fs.readFileSync(path.join(ROOT, 'scripts', 'dev.mjs'), 'utf8');
  ok('dev.mjs 写死 REN_DEV_INSTANCE', /REN_DEV_INSTANCE:\s*'1'/.test(dev));
  ok('dev.mjs 写死 HOST=127.0.0.1', /HOST:\s*'127\.0\.0\.1'/.test(dev));
  ok('dev.mjs 抢 8080 时先自己拦下', /8080/.test(dev) && /process\.exit\(2\)/.test(dev));
  ok('dev.mjs 四个目录都在 DEV_ROOT 下', ['WORKSPACE_DIR', 'REN_STATE_DIR', 'AUDIT_DIR', 'INCIDENT_DIR']
    .every(k => new RegExp(k + ':\\s*path\\.join\\(DEV_ROOT').test(dev)));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package.json 有 dev 脚本', pkg.scripts.dev === 'node scripts/dev.mjs', pkg.scripts.dev);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
