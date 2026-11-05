/* SSE 长连接：能不能挂住、断了能不能接上
 *
 * 这件事一直是「没报错」而不是「验证过」。多设备并发放开之后，一个任务跑十分钟
 * 变成了正常情况，而长连接有三种失效方式，日志里一种都看不出来：
 *   ① 空闲超时（真流大部分时间在等模型，几十秒没有字节）
 *   ② 总时长上限（连接再活跃，到点也切）
 *   ③ 缓冲（不断、不超时，但事件攒着，最后一次性吐出——实时性静默消失）
 *
 * 所以这里测两半：
 *   前半：探针端点本身。它是以后换网关/改反代的复测工具，工具坏了就没法复测。
 *   后半：断点续传。自动重连的正确性全靠「from=seq 不重不漏」，
 *         这一条以前完全没有测试，而它一旦有偏差，界面会出现重复步骤或整段丢失，
 *         并且很难归因到「重连」上。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-sse-'));
const WS = path.join(TMP, 'ws');
const STATE = path.join(TMP, 'state');
const SECRETS = path.join(TMP, 'secrets');
const PROBE = path.join(TMP, 'probe');
for (const d of [WS, STATE, SECRETS, PROBE]) fs.mkdirSync(d, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const UID = 'sseUser000000000000000000001';
const STAFF = { id: 's1', name: '小张', persona: 'mature', role: '助理' };

/* 假模型：每轮慢 600ms，回一段短文就 stop。
   慢一点是必要的——「中途断线」这条要能在任务结束前真的把流掐掉。 */
const gateway = http.createServer((req, res) => {
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith('/.cloud/auth/v1/user/me')) {
    if (!req.headers.origin) return json(401, { error: 'invalid_grant' });
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m || m[1].trim() !== 'tok-qa') return json(401, { error: 'invalid_grant' });
    return json(200, { sub: UID, email: 'qa@test.local' });
  }
  if (req.url.startsWith('/.cloud/llm/chat/completions')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          id: 'c1', object: 'chat.completion.chunk', model: 'test',
          choices: [{ index: 0, delta: { content: '好的，收到。' }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'c1', object: 'chat.completion.chunk', model: 'test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4 }
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 600);
    });
    return;
  }
  json(404, { error: 'not_found' });
});

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

await new Promise(r => gateway.listen(0, '127.0.0.1', r));
const GW = `http://127.0.0.1:${gateway.address().port}`;
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    WORKSPACE_DIR: WS,
    REN_STATE_DIR: STATE,
    REN_SECRET_DIR: SECRETS,
    REN_PROBE_DIR: PROBE,
    REN_USAGE_DIR: path.join(TMP, 'usage'),
    REN_BACKUP_DIR: path.join(TMP, 'bk'),
    REN_BACKUP_HOURS: '999',
    REN_BACKUP_FIRST_MS: '999999',
    REN_LLM_BASE: GW,
    REN_LLM_KEY: 'wbpk_test',
    REN_AUTH_MODE: 'strict'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });

for (let i = 0; i < 150; i++) {
  try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* 还没起来 */ }
  await sleep(100);
}
if (!srvLog.includes('监听') && !srvLog.includes(':' + PORT)) {
  /* 起不来的话，后面每一条都会以一个看不懂的错误失败，先把日志打出来 */
  console.log('服务可能没起来：\n' + srvLog.slice(-1500));
}

const AUTH = { Origin: BASE, 'x-ren-auth': 'Bearer tok-qa' };
const KEY = fs.readFileSync(path.join(SECRETS, 'alerts.key'), 'utf8').trim();

/* 读一条 SSE，按帧解析。reconnect 场景下要能「读一部分就掐」。
   自带超时：任何一条流挂住都会让整个测试卡死，而卡死的测试比失败的测试更难查。 */
function readStream(url, { stopAfter = Infinity, headers = AUTH, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const out = { events: [], pings: 0, hello: null, probeEnd: null, firstByteMs: -1, ended: false };
  const t0 = Date.now();
  const killer = setTimeout(() => { out.timedOut = true; try { ctrl.abort(); } catch { /* 已经断了 */ } }, timeoutMs);
  const done = (async () => {
    try {
      const r = await fetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal: ctrl.signal });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        out.status = r.status;
        out.body = body.slice(0, 200);
        return out;
      }
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of r.body) {
          if (out.firstByteMs < 0) out.firstByteMs = Date.now() - t0;
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!frame) continue;
            if (frame.startsWith(':')) { out.pings += 1; continue; }
            let seq = 0;
            const datas = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('id: ')) seq = Number(line.slice(4)) || 0;
              else if (line.startsWith('data: ')) datas.push(line.slice(6));
            }
            if (!datas.length) continue;
            let ev;
            try { ev = JSON.parse(datas.join('\n')); } catch { continue; }
            if (ev.t === 'probe-hello') { out.hello = ev; continue; }
            if (ev.t === 'probe-end') { out.probeEnd = ev; out.ended = true; continue; }
            out.events.push({ seq, ev });
            if (out.events.length >= stopAfter) { try { ctrl.abort(); } catch { /* 已经断了 */ } return out; }
          }
        }
      } catch (e) {
        if (!(e && e.name === 'AbortError')) out.error = e.message;
      }
      return out;
    } finally {
      clearTimeout(killer);
    }
  })();
  return { done, abort: () => { try { ctrl.abort(); } catch { /* 已经断了 */ } } };
}

console.log('\n[1] 探针是运维接口，不是公开接口');
{
  const noKey = await fetch(BASE + '/api/admin/stream-probe?seconds=2');
  eq('不带 key：403', noKey.status, 403);
  const badKey = await fetch(BASE + '/api/admin/stream-probe?seconds=2&key=wrong');
  eq('错 key：403', badKey.status, 403);
  /* 这两条容易被忽略：探针一旦漏进 PUBLIC_API，闸门会连身份都不解析，
     任何人都能拿它挂住一条长连接；而放进 OPTIONAL_AUTH 才符合它的凭证模型
     （调用方是运维 curl，凭证是 key，由 handler 自己验）。 */
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const pubSet = (src.match(/const PUBLIC_API = new Set\(\[([^\]]*)\]\)/) || [, ''])[1];
  ok('探针不在 PUBLIC_API（免身份）里', !/stream-probe/.test(pubSet), pubSet);
  const optSet = (src.match(/const OPTIONAL_AUTH = new Set\(\[([\s\S]*?)\]\)/) || [, ''])[1];
  ok('探针在 OPTIONAL_AUTH 里（凭证交给 handler 判）', /stream-probe/.test(optSet), optSet.slice(-120));
}

console.log('\n[2] 探针：一条真流能挂满，心跳和数据帧都过得去');
{
  const s = readStream(`${BASE}/api/admin/stream-probe?seconds=3&dataMs=1000&pingMs=1000&key=${encodeURIComponent(KEY)}`, { headers: { Origin: BASE } });
  const r = await s.done;
  ok('HTTP 200', r.status === undefined, { status: r.status, body: r.body });
  ok('拿到 hello 帧', !!(r.hello && r.hello.id), r.hello);
  ok('hello 里报了计划时长', r.hello && r.hello.plannedMs >= 2000, r.hello && r.hello.plannedMs);
  ok('收到数据帧', r.events.length >= 2, r.events.length);
  ok('收到心跳帧（注释帧没被吃掉）', r.pings >= 1, r.pings);
  ok('首字节很快（不在缓冲里等）', r.firstByteMs >= 0 && r.firstByteMs < 2000, r.firstByteMs);
  ok('收到了 probe-end', !!r.probeEnd, r.probeEnd);
  eq('结束方式是 timer（不是被切断）', r.probeEnd && r.probeEnd.endedBy, 'timer');
  eq('计划时长没被改写', r.probeEnd && r.probeEnd.plannedMs, 3000);
  ok('服务端心跳次数 ≥ 客户端收到的', r.probeEnd && r.probeEnd.pings >= r.pings, { srv: r.probeEnd && r.probeEnd.pings, cli: r.pings });
}

console.log('\n[3] 探针：并发只允许一条，提前断开要记为 client');
{
  /* 开一条长的，占住 */
  const long = readStream(`${BASE}/api/admin/stream-probe?seconds=30&dataMs=5000&pingMs=5000&key=${encodeURIComponent(KEY)}`, { headers: { Origin: BASE } });
  await sleep(600);

  const second = await fetch(`${BASE}/api/admin/stream-probe?seconds=5&key=${encodeURIComponent(KEY)}`, { headers: { Origin: BASE } });
  eq('已有探针在跑：409', second.status, 409);
  const sb = await second.json().catch(() => null);
  ok('409 里说清了是谁在跑', !!(sb && sb.running && sb.running.id), sb);

  /* 客户端主动断 —— 服务端应该把「谁先断的」记下来。
     这条是探针的核心价值：不记下来就分不清「网关切我」和「我按时收工」。 */
  long.abort();
  await sleep(500);

  const hist = await (await fetch(`${BASE}/api/admin/stream-probe?key=${encodeURIComponent(KEY)}`, { headers: { Origin: BASE } })).json();
  const last = (hist.history || [])[0];
  ok('历史里留下了这次探针', !!last, hist.history);
  eq('服务端记到「客户端先断开」', last && last.endedBy, 'client');
  eq('并且没标成走完', last && last.completed, false);
  ok('提前断开时耗时明显小于计划', last && last.elapsedMs < last.plannedMs, last && { e: last.elapsedMs, p: last.plannedMs });
}

console.log('\n[4] 探针参数有上下限（不能用来挂一条 10 小时的连接）');
{
  const r = await readStream(`${BASE}/api/admin/stream-probe?seconds=1&dataMs=500&pingMs=500&key=${encodeURIComponent(KEY)}`, { headers: { Origin: BASE } }).done;
  ok('seconds=1 被抬到最小值', r.hello && r.hello.plannedMs >= 2000, r.hello && r.hello.plannedMs);
  ok('没被无限挂住', !!r.probeEnd, r.probeEnd);
}

console.log('\n[5] 续传：任务结束后，事件还能原样重放');
let allEvents = [];
{
  const job = {
    token: 'tok-qa', staff: STAFF, task: { id: 'sse-1', goal: '随便说句话' },
    settings: { permissions: { read: true, write: true, exec: false }, maxSteps: 2 }
  };
  const r = await fetch(BASE + '/api/run', {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(job)
  });
  eq('发起任务：200', r.status, 200);

  /* 把 POST 的响应流读完（POST 返回的就是同一条流） */
  const dec = new TextDecoder();
  let buf = '';
  const seen = [];
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frame || frame.startsWith(':')) continue;
      let seq = 0;
      const datas = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('id: ')) seq = Number(line.slice(4)) || 0;
        else if (line.startsWith('data: ')) datas.push(line.slice(6));
      }
      if (!datas.length) continue;
      let ev;
      try { ev = JSON.parse(datas.join('\n')); } catch { continue; }
      seen.push({ seq, ev });
    }
  }
  allEvents = seen.filter(x => x.seq > 0);
  ok('任务跑出了若干带 seq 的事件', allEvents.length >= 2, allEvents.map(x => x.ev.t));

  /* 任务结束后再连一次 from=0：应该能把这些事件重放出来。
     刷新页面靠的就是这条路——RUNS 里的 run 不会因为结束就立刻删。 */
  const replay = await readStream(`${BASE}/api/run/sse-1?from=0`).done;
  const replayed = replay.events.filter(x => x.seq > 0);
  eq('重放的事件数一致', replayed.length, allEvents.length);
  eq('重放的 seq 完全一致', replayed.map(x => x.seq), allEvents.map(x => x.seq));
  ok('重放不会挂住连接（任务已结束就要自己收尾）', !replay.timedOut, { timedOut: replay.timedOut });
  ok('重放里带着收尾事件', replayed.some(x => x.ev.t === 'end'), replayed.map(x => x.ev.t));
}

console.log('\n[6] 续传：from=N 只给 N 之后，不重不漏');
{
  const mid = allEvents[Math.min(1, allEvents.length - 1)].seq;
  const r = await readStream(`${BASE}/api/run/sse-1?from=${mid}`).done;
  const got = r.events.filter(x => x.seq > 0);
  const want = allEvents.filter(x => x.seq > mid);
  eq(`from=${mid} 之后的事件数`, got.length, want.length);
  eq(`from=${mid} 之后没有重复（首条 seq 应 > ${mid}）`, got[0] ? got[0].seq > mid : null, true);
  eq('seq 严格递增', got.map(x => x.seq).join(','), want.map(x => x.seq).join(','));
}

console.log('\n[7] 续传：中途断线的真实形态');
{
  const job = {
    token: 'tok-qa', staff: STAFF, task: { id: 'sse-2', goal: '再说一句话' },
    settings: { permissions: { read: true, write: true, exec: false }, maxSteps: 2 }
  };
  const r = await fetch(BASE + '/api/run', {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(job)
  });
  eq('发起任务：200', r.status, 200);

  /* 读到第一个带 seq 的事件就掐，模拟网关在这一刻把线拔了 */
  const dec = new TextDecoder();
  let buf = '';
  let cutAt = 0;
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^id: (\d+)/m.exec(frame);
        if (m) { cutAt = Number(m[1]); break; }
      }
      if (cutAt) break;
    }
  } catch { /* 断就断 */ }
  try { await r.body.cancel(); } catch { /* 已经关了 */ }
  ok('确实在任务中途掐断了', cutAt > 0, cutAt);

  /* 等服务端把任务跑完（600ms/轮 × 2 轮，留足余量） */
  await sleep(2500);
  const r2 = await readStream(`${BASE}/api/run/sse-2?from=${cutAt}`).done;
  const rest = r2.events.filter(x => x.seq > 0);
  ok('重连能拿到后续事件', rest.length >= 1, rest.length);
  eq('重连的第一条正好接在断点之后（不重复）', rest[0] && rest[0].seq, cutAt + 1);
  ok('最终收到了收尾事件', r2.events.some(x => x.ev.t === 'end'), r2.events.map(x => x.ev.t));
  ok('重连本身没有挂住', !r2.timedOut, { timedOut: r2.timedOut });
}

console.log('\n[8] 前端：断了要自己接回来，且不能把「流断了」当成「任务没了」');
{
  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  ok('有自动重连', /async function resumeRunStream/.test(app));
  ok('重连用 SRV.seq 作为续点', /from=\$\{SRV\.seq/.test(app));
  ok('410 会区分「任务被中断」并说明原因', /code === 'interrupted'/.test(app));
  /* 这条是这次差点写错的地方：流断时把 SRV.on 置 false，
     插话和审批就会走到本地那个已经不存在的任务上，静默失效。 */
  ok('不会在流断开时把 SRV.on 置 false',
    !/catch \(e\) \{[\s\S]{0,400}?SRV\.on = false;/.test(app.split('async function consumeRunStream')[1]?.slice(0, 2000) || ''));
  ok('发起路径断线后也走重连', /const ended = await consumeRunStream\(r, job\.emit, job\.signal\);[\s\S]{0,200}?resumeRunStream/.test(app));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
srv.kill();
gateway.close();
process.exit(fail ? 1 : 0);
