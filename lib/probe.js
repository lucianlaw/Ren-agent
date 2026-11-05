import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ── 长连接探针 ──
   为什么需要它：SSE 有三种失效方式，日志里一种都看不出来。

     ① 空闲超时——上游几十秒没字节，中间层回收连接。真流大部分时间在等模型，
        所以这条最容易发生。对策是定时发注释帧（`: ping`），但「发了」不等于
        「过得去」：有的中间层会把注释帧吃掉。
     ② 总时长上限——连接再活跃，到点也会被切。只有把连接真挂满那么久才知道。
     ③ 缓冲——最阴的一种：连接不断，但事件被攒着，直到结束才一次性吐出。
        用户看到的是「跑了三分钟界面一动不动，最后一下全出来」。
        它不报错、不超时，只让实时性消失。

   探针同时测这三件事：pings 测①，总时长测②，每个 beat 带服务端时间戳、
   客户端拿到达时刻减一下就得到 lag，lag 单调增长就是③。

   只给运维 key 用。它不读任何业务数据，最坏情况是占用一条连接。 */

const MAX_SECONDS = 1800;
const MIN_SECONDS = 2;
const MAX_HISTORY = 20;

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 和 lib/quota.js 同一个处置：测试进程绝不写真实 data/。
   探针一跑就是几十秒，测试里起几个 server 就会在真实目录留下记录。 */
const ENTRY = String(process.argv[1] || '');
if (!process.env.REN_PROBE_DIR && /[\\/]test[\\/][^\\/]+\.mjs$/.test(ENTRY)) {
  process.env.REN_PROBE_DIR = path.join(os.tmpdir(), 'ren-probe-test');
}

function probeDir() {
  const custom = String(process.env.REN_PROBE_DIR || '').trim();
  return custom ? path.resolve(custom) : path.join(APP, 'data', 'probe');
}
function historyFile() {
  return path.join(probeDir(), 'history.json');
}

export function probeHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function saveResult(rec) {
  try {
    fs.mkdirSync(probeDir(), { recursive: true, mode: 0o700 });
    const all = probeHistory();
    all.push(rec);
    /* 只留最近 20 条：这是「最近几次网关表现如何」的证据，不是时序数据库 */
    fs.writeFileSync(historyFile(), JSON.stringify(all.slice(-MAX_HISTORY), null, 1));
  } catch { /* 记录失败不影响探针本身 */ }
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/* 同时只允许一个探针：它是长连接，N 个并发就等于拿它做连接耗尽测试了，
   而那不是这个端点的用途。 */
let running = null;

export function probeBusy() {
  return running ? { id: running.id, startedAt: running.startedAt, plannedMs: running.plannedMs } : null;
}

export function streamProbe(req, res, opts = {}) {
  const seconds = clamp(opts.seconds, MIN_SECONDS, MAX_SECONDS, 300);
  const pingMs = clamp(opts.pingMs, 1000, 60000, 15000);
  const dataMs = clamp(opts.dataMs, 1000, 120000, 15000);
  const plannedMs = seconds * 1000;
  const t0 = Date.now();
  const id = `p${t0.toString(36)}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let pings = 0;
  let beats = 0;
  let endedBy = '';
  let endTimer = null;

  const finish = (why) => {
    if (endedBy) return;
    endedBy = why;
    clearInterval(pingIv);
    clearInterval(beatIv);
    clearTimeout(endTimer);
    const elapsedMs = Date.now() - t0;
    const rec = {
      id, startedAt: new Date(t0).toISOString(), plannedMs, elapsedMs,
      pingMs, dataMs, pings, beats,
      /* 这三个数字是结论本身：
         endedBy=timer 且 elapsed ≈ planned → 挂满了，网关没切
         endedBy=client 且 elapsed << planned → 被提前切断，切在 elapsed 处 */
      endedBy,
      completed: endedBy === 'timer'
    };
    if (why === 'timer') {
      try {
        res.write(`data: ${JSON.stringify({ t: 'probe-end', ...rec })}\n\n`);
        res.end();
      } catch { /* 已经断了 */ }
    } else {
      try { res.end(); } catch { /* 已经断了 */ }
    }
    if (running && running.id === id) running = null;
    saveResult(rec);
  };

  /* 心跳用注释帧：真实流就是这么发的（server.js 的 streamRun 用 ': ping'），
     探针必须和它一模一样，否则测的是另一条路径。 */
  const pingIv = setInterval(() => {
    pings += 1;
    try { res.write(': ping\n\n'); } catch { finish('client'); }
  }, pingMs);

  /* 数据帧另算一路：注释帧可能被中间层吃掉而数据帧不会，
     两路分开计数才能区分「连接死了」和「只有注释帧被丢弃」。 */
  const beatIv = setInterval(() => {
    beats += 1;
    try {
      res.write(`data: ${JSON.stringify({ t: 'beat', n: beats, at: Date.now(), elapsedMs: Date.now() - t0 })}\n\n`);
    } catch { finish('client'); }
  }, dataMs);

  endTimer = setTimeout(() => finish('timer'), plannedMs);

  res.write(`event: hello\ndata: ${JSON.stringify({
    t: 'probe-hello', id, plannedMs, pingMs, dataMs, at: Date.now()
  })}\n\n`);

  /* 客户端断开（或被中间层切断）时，服务端这一侧会先收到 close。
     记下来才能区分「我按时收工」和「别人把线拔了」。 */
  req.on('close', () => finish('client'));
  res.on('close', () => finish('client'));

  running = { id, startedAt: new Date(t0).toISOString(), plannedMs };
  return { id, plannedMs };
}
