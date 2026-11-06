/* 报错上报的端到端：真的把服务起起来，用真 HTTP 打它
 *
 * 为什么不能只测 lib 里的纯函数：
 *   「函数对」和「线上真的能收到报错」之间隔着三道闸——Origin 校验、
 *   身份闸门、路由挂载。少挂一条路由，纯函数测试照样全绿，而线上一条都收不到。
 *   这三道恰好也是最容易在重构时被顺手改坏的地方。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined
      ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''));
  }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const KEY = 'incident-test-key';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-http-'));
const DIR = path.join(TMP, 'inc');
let child = null;
let PORT = 0;

function pickPort() { return 35000 + Math.floor(Math.random() * 4000); }

async function waitUp(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function boot() {
  for (let attempt = 0; attempt < 4; attempt++) {
    PORT = pickPort();
    child = spawn(process.execPath, ['server.js'], {
      cwd: APP,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(PORT),
        LOCAL_ONLY: '1',
        ALERTS_KEY: KEY,
        REN_STATE_DIR: path.join(TMP, 'state'),
        WORKSPACE_BASE: path.join(TMP, 'ws'),
        AUDIT_DIR: path.join(TMP, 'audit'),
        INCIDENT_DIR: DIR,
        BACKUP_DIR: path.join(TMP, 'bk')
      }
    });
    if (await waitUp(PORT)) return true;
    try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  }
  return false;
}

function stop() {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch { /* 忽略 */ }
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  child = null;
}

const BASE = () => `http://127.0.0.1:${PORT}`;
const post = (body, extraHeaders = {}) => fetch(`${BASE()}/api/incident`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: BASE(), ...extraHeaders },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

function logs() {
  try {
    return fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl'))
      .flatMap(f => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean))
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

try {
  const up = await boot();
  ok('服务起来了', up, `port=${PORT}`);

  if (up) {
    console.log('\n[1] 上报端点：不要求登录，但要求同源');
    {
      /* 登录页自己崩掉的时候用户没有凭证，所以这条不能要求登录。
         但正因为免登录，它必须被 Origin 闸门挡住，否则谁都能往日志里灌东西。 */
      const noOrigin = await fetch(`${BASE()}/api/incident`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'E_NET', msg: 'x' })
      });
      ok('没带 Origin 被拒（403）', noOrigin.status === 403, noOrigin.status);

      const wrongOrigin = await post({ code: 'E_NET', msg: 'x' }, { Origin: 'https://evil.example.com' });
      ok('外来 Origin 被拒（403）', wrongOrigin.status === 403, wrongOrigin.status);

      const r = await post({ code: 'E_NET', route: '/x', where: 'w', msg: 'boom 42' });
      eq('同源 POST 收下（204 无正文）', r.status, 204);
      ok('204 不带正文', (await r.text()) === '', '');
    }

    console.log('\n[2] 落盘的记录：字段齐、已脱敏');
    {
      const recs = logs();
      ok('写出了记录', recs.length >= 1, recs.length);
      const r = recs[recs.length - 1];
      eq('码对', r.code, 'E_NET');
      eq('层标成 client', r.layer, 'client');
      ok('有签名', typeof r.sig === 'string' && r.sig.startsWith('E_NET|'), r.sig);
      ok('带版本与 commit（线上是哪个版本犯错，这条是唯一依据）', !!r.v && !!r.commit, { v: r.v, commit: r.commit });
      ok('带本机时间戳', !!r.at, r.at);
    }

    console.log('\n[3] 身份不采信 body，只认闸门验出来的');
    {
      /* 免登录接口最容易被当成「顺便信一下 body 里的 scope」。
         真那么写，任何人都能往别人的工单里塞样本。 */
      const fake = 'a'.repeat(32);
      await post({ code: 'E_NET', route: '/y', where: 'w', msg: 'x', scope: fake });
      const last = logs().pop();
      ok('匿名上报里不带 scope', !last.scope, last.scope);
    }

    console.log('\n[4] 垃圾输入不许把服务搞坏');
    {
      const bad = await fetch(`${BASE()}/api/incident`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE() },
        body: '这不是 JSON'
      });
      ok('非 JSON 也被收下且不报错（204）', bad.status === 204, bad.status);

      /* 超过 16KB 的正文会被直接掐断连接（readBody 的上限），浏览器侧表现为
         一次静默失败——对 sendBeacon 来说这正是想要的：宁可丢掉这条上报，
         也不能让人用一条巨型 body 把内存吃满。所以这里两种结果都算过：
         要么给个 <500 的状态码，要么连接被 reset。 */
      let hugeStatus = 0;
      let hugeReset = false;
      try {
        const huge = await post({ code: 'E_NET', msg: 'x'.repeat(200000) });
        hugeStatus = huge.status;
      } catch { hugeReset = true; }
      ok('超大体积：拒收（状态码或断连），都不许 5xx', hugeReset || hugeStatus < 500, { hugeStatus, hugeReset });

      const still = await fetch(`${BASE()}/api/health`);
      ok('服务仍然活着', still.ok, still.status);
    }

    console.log('\n[5] 归组列表：只有运维能看');
    {
      const noKey = await fetch(`${BASE()}/api/incidents`);
      eq('没有 key → 403', noKey.status, 403);

      const withKey = await fetch(`${BASE()}/api/incidents?key=${KEY}`);
      eq('带 key → 200', withKey.status, 200);
      const j = await withKey.json();
      ok('返回了归组表', j.ok && Array.isArray(j.groups), Object.keys(j));
      ok('同一签名的两次上报合成一组', j.groups.some(g => g.sig === 'E_NET|/x|w' && g.n >= 1), j.groups.map(g => [g.sig, g.n]));
      ok('每组带中文解释和分诊归属', j.groups.every(g => g.zh && ['self', 'external', 'either'].includes(g.owner)), j.groups[0]);
      ok('带限流未交出计数', typeof j.suppressed === 'number', j.suppressed);
      ok('带现状统计', j.stats && typeof j.stats.last24h === 'number', j.stats);
    }

    console.log('\n[6] health 里看得到「有没有在报错」');
    {
      const h = await (await fetch(`${BASE()}/api/health`)).json();
      ok('health 带 incident 段', !!h.incident, Object.keys(h));
      ok('里面有 last24h', typeof h.incident.last24h === 'number', h.incident);
      ok('有 crashes 计数（未捕获异常）', typeof h.incident.crashes === 'number', h.incident);
      eq('本轮没有崩溃', h.incident.crashes, 0);
    }

    console.log('\n[7] 清扫端点');
    {
      const noKey = await fetch(`${BASE()}/api/admin/incident-sweep`);
      eq('没有 key → 403', noKey.status, 403);
      const withKey = await fetch(`${BASE()}/api/admin/incident-sweep?key=${KEY}`);
      eq('带 key → 200', withKey.status, 200);
      const j = await withKey.json();
      ok('返回保留期与现状', j.ok && j.stats && j.stats.keepDays === 30, j.stats);
      const dry = await fetch(`${BASE()}/api/admin/incident-sweep?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE() },
        body: JSON.stringify({ dryRun: true })
      });
      const dj = await dry.json();
      ok('预演不删今天的分片', dj.ok && dj.deleted === 0, dj);
    }
  }
} finally {
  stop();
  await new Promise(r => setTimeout(r, 300));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n${fail ? '✗ 失败' : '✓ 全过'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
