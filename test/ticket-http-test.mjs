/* 工单端点的端到端：真起服务、真打 HTTP
 *
 * 纯函数测试测不到的三件事：
 *   1. 路由有没有真的挂上（少挂一条，函数测试照样全绿）
 *   2. 权限闸门有没有守住（工单里有报错原文、栈、账号，不能谁都能看）
 *   3. 状态改完之后，下一次请求读到的确实是新状态（落盘真的生效了）
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
/* 用非法 key 打过来，要么 400（参数没给），要么 404（查不到）——都不许 200 */
const collided = (st) => st === 403 || st === 404 || st === 400;

const KEY = 'ticket-test-key';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-http-'));
let child = null;
let PORT = 0;

const pickPort = () => 35500 + Math.floor(Math.random() * 3000);

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
  for (let a = 0; a < 4; a++) {
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
        /* 注意是 WORKSPACE_DIR 不是 WORKSPACE_BASE：lib/workspace.js 只认前者。
           写错名字的后果不是「跑不起来」，而是**悄悄落到项目的 workspace/ 目录**——
           测试看起来全绿，实际上往真实工作区里写了种子文件。 */
        WORKSPACE_DIR: path.join(TMP, 'ws'),
        AUDIT_DIR: path.join(TMP, 'audit'),
        INCIDENT_DIR: path.join(TMP, 'inc'),
        TICKET_DIR: path.join(TMP, 'tickets'),
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
const get = (p, withKey = true) => fetch(`${BASE()}${p}${p.includes('?') ? '&' : '?'}${withKey ? 'key=' + KEY : ''}`, {
  headers: { Origin: BASE() }
});
const postJson = (p, body, withKey = true) => fetch(`${BASE()}${p}${withKey ? '?key=' + KEY : ''}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: BASE() },
  body: JSON.stringify(body)
});
const report = (body) => fetch(`${BASE()}/api/incident`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: BASE() },
  body: JSON.stringify(body)
});

try {
  const up = await boot();
  ok('服务起来了', up, `port=${PORT}`);

  if (up) {
    console.log('\n[1] 先造两条报错（同一签名两次、另一个签名一次）');
    {
      for (let i = 0; i < 2; i++) {
        await report({ code: 'E_TOOL_FAIL', route: '/api/tool', where: 'runTool', msg: '写文件失败：磁盘满了' });
      }
      await report({ code: 'E_HTTP_5XX', route: '/api/export', where: 'sendFile', msg: '导出失败' });
      const r = await get('/api/health');
      const h = await r.json();
      ok('health 里能看到报错数', h.incident && h.incident.last24h >= 3, h.incident);
      ok('health 里有工单统计（带 key）', !!h.tickets && typeof h.tickets.tickets === 'number', h.tickets);
    }

    console.log('\n[2] 权限：工单里有报错原文和账号，不能谁都能看');
    {
      const noKey = await get('/api/tickets', false);
      ok('/api/tickets 无 key → 403', noKey.status === 403, noKey.status);

      const noKey2 = await get('/api/ticket?sig=x', false);
      ok('/api/ticket 无 key → 403', noKey2.status === 403, noKey2.status);

      const noKey3 = await postJson('/api/ticket/claim', { sig: 'x' }, false);
      ok('/api/ticket/claim 无 key → 403', noKey3.status === 403, noKey3.status);

      const noKey4 = await postJson('/api/ticket/settle', { sig: 'x', state: 'fixed', note: 'x' }, false);
      ok('/api/ticket/settle 无 key → 403', noKey4.status === 403, noKey4.status);
    }

    console.log('\n[3] 列表：按得分排，带状态');
    {
      const r = await get('/api/tickets');
      const j = await r.json();
      ok('200', r.status === 200, r.status);
      ok('ok=true', j.ok === true, j);
      ok('至少两张单（两个签名）', j.tickets.length >= 2, j.tickets.length);
      ok('每张都有 sig / key / state', j.tickets.every(t => t.sig && /^[0-9a-f]{16}$/.test(t.key) && t.state), j.tickets[0]);
      ok('默认都是 open', j.tickets.every(t => t.state === 'open'), j.tickets.map(t => t.state));
      ok('列表里不带复现（省掉几十次目录扫描）', j.tickets.every(t => t.repro.skipped === true), j.tickets[0].repro);
      ok('按得分降序', j.tickets.every((t, i, a) => i === 0 || a[i - 1].score >= t.score), j.tickets.map(t => t.score));
      eq('统计里的总数与列表一致', j.stats.tickets >= j.tickets.length, true);

      const only5xx = await (await get('/api/tickets?state=open')).json();
      ok('按 state 过滤可用', only5xx.tickets.every(t => t.state === 'open'));
    }

    console.log('\n[4] 详情 + 任务模板');
    {
      const list = await (await get('/api/tickets')).json();
      const first = list.tickets[0];

      const r = await get(`/api/ticket?sig=${encodeURIComponent(first.sig)}&task=1`);
      const j = await r.json();
      ok('200', r.status === 200, r.status);
      ok('详情里复现不是 skipped', j.ticket.repro.skipped !== true, j.ticket.repro);
      ok('匿名上报时明说拿不到复现', j.ticket.repro.ok === false && /匿名/.test(j.ticket.repro.why), j.ticket.repro);
      ok('带回任务模板', typeof j.task === 'string' && j.task.length > 100, String(j.task).slice(0, 80));
      ok('模板里有红线', /## 边界（不许动）/.test(j.task), '');
      ok('模板里有验收标准', /## 验收/.test(j.task), '');
      ok('模板里明说没有复现上下文', /没有可用的复现上下文/.test(j.task), '');

      /* 短 id 走 `id` 参数。用 `key` 会和运维凭证撞名——那正是第一版踩的坑：
         拿 key 查单永远 403，而 403 看起来像权限没配好。 */
      const byId = await get(`/api/ticket?id=${first.key}`);
      ok('用短 id 也能取', byId.status === 200, byId.status);

      const collide = await get(`/api/ticket?key=${first.key}`);
      ok('拿工单 id 冒充 key 查不到（参数不共用）', collided(collide.status), collide.status);

      const miss = await get('/api/ticket?sig=nosuch');
      ok('不存在的签名 → 404', miss.status === 404, miss.status);

      const empty = await get('/api/ticket?sig=');
      ok('不给 sig → 400', empty.status === 400, empty.status);
      const noParams = await get('/api/ticket');
      ok('什么都不给 → 400', noParams.status === 400, noParams.status);
    }

    console.log('\n[5] 领取 → 结算：状态真的落盘了');
    {
      const list = await (await get('/api/tickets')).json();
      const t0 = list.tickets[0];

      const c = await postJson('/api/ticket/claim', { sig: t0.sig, by: 'ren-agent' });
      const cj = await c.json();
      ok('领取成功', c.ok === true && cj.state === 'claimed', cj);

      const again = await postJson('/api/ticket/claim', { sig: t0.sig, by: 'ren-agent' });
      ok('不能重复领取（已是 claimed）', again.status === 409, again.status);

      const jump = await postJson('/api/ticket/settle', { sig: t0.sig, state: 'verified', by: 'x', note: '跳过 fixed' });
      ok('claimed → verified 被拒（409）', jump.status === 409, jump.status);

      const noNote = await postJson('/api/ticket/settle', { sig: t0.sig, state: 'fixed', note: '' });
      ok('fixed 不带说明被拒', noNote.status === 409, noNote.status);

      const f = await postJson('/api/ticket/settle', { sig: t0.sig, state: 'fixed', by: 'ren-agent', note: '补了磁盘空间检查' });
      ok('claimed → fixed 成功', f.ok && f.status === 200, f.status);

      /* 关键：重新拉一次列表，读到的必须是新状态——这说明是落盘生效，
         不是内存里改了改 */
      const after = await (await get('/api/tickets?state=fixed')).json();
      ok('下一次请求能读到 fixed', after.tickets.some(t => t.sig === t0.sig), after.tickets.map(t => t.sig));
      const tt = after.tickets.find(t => t.sig === t0.sig);
      eq('记下了领取人', tt.claimedBy, 'ren-agent');
      ok('历史里有两步', tt.history.length >= 2, tt.history);
    }

    console.log('\n[6] 判掉噪音：默认不出现，但能查回来');
    {
      const list = await (await get('/api/tickets')).json();
      const t = list.tickets[list.tickets.length - 1];
      const d = await postJson('/api/ticket/settle', { sig: t.sig, state: 'dropped', by: 'me', note: '断网时的正常失败' });
      ok('open → dropped 成功', d.status === 200, d.status);

      const normal = await (await get('/api/tickets')).json();
      ok('默认列表不含 dropped', !normal.tickets.some(x => x.sig === t.sig));

      const all = await (await get('/api/tickets?dropped=1')).json();
      ok('dropped=1 能查回来', all.tickets.some(x => x.sig === t.sig));
    }

    console.log('\n[7] 状态文件：落在 TICKET_DIR 里，且是完整 JSON');
    {
      const d = path.join(TMP, 'tickets');
      const files = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')) : [];
      ok('写到了指定目录', files.length >= 2, files);
      ok('没有 .tmp 残留', !files.some(f => f.includes('.tmp')), files);
      let allParsed = true;
      for (const f of files) {
        try { JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { allParsed = false; }
      }
      ok('每个文件都是完整 JSON', allParsed);
      const one = JSON.parse(fs.readFileSync(path.join(d, files[0]), 'utf8'));
      ok('文件里有 sig / state / sigVer', !!one.sig && !!one.state && one.sigVer === 1, one);
    }

    console.log('\n[8] 预期内的拒绝不许进工单表');
    {
      const src = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
      /* 这条来自真实数据：本地 7 条报错全部是 POST /api/upload → 507，
         得分 31.5 排第一，而它只是「用户配额满了」。5xx 采集分不清
         「出故障」和「按设计拒绝」，而后者一旦进表就会永久霸榜。 */
      ok('5xx 采集检查了预期标记', /res\.statusCode >= 500 && !res\._expected5xx/.test(src));
      ok('上传配额不足时打了标记', /expectReject\(res\);[\s\S]{0,200}507/.test(src));
      ok('expectReject 有解释为什么只能由 handler 判断',
        /只有产生响应的人知道答案/.test(src), '');

      /* 真故障仍然要记：否则这次修就把「看得见」这件事一起修没了。
         所以标记必须少——一旦为了消噪音到处乱标，真故障也会被吞掉。 */
      /* 带分号只匹配调用处，不含函数定义那一行 */
      const calls = (src.match(/expectReject\(res\);/g) || []).length;
      eq('只有一处标记（不是到处乱标）', calls, 1);
      ok('异常兜底的 500 没有打标记', /if \(!res\.headersSent\) send\(res, 500/.test(src), '');
    }
  }
} finally {
  stop();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
