#!/usr/bin/env node
/* SSE 长连接实测。
 *
 * 为什么要有这个脚本：探针只负责「发」，判断得在「收」这一侧做。
 * 服务端说「我发了 20 个心跳」，客户端说「我只收到 3 个」，这才是有信息量的对照。
 *
 * 它回答三个问题：
 *   ① 连接会不会被提前切断（断了就是断了，结束时刻是证据）
 *   ② 事件是实时的还是攒着一次性吐出的（lag：到达时刻 - 服务端发送时刻）
 *   ③ 心跳帧过得去吗（注释帧被中间层丢弃时，连接看着还在，其实已经没有保活）
 *
 * 用法：
 *   node scripts/sse-probe.mjs --seconds 600
 *   node scripts/sse-probe.mjs --url https://.../api/admin/stream-probe?key=...&seconds=600
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, dflt = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  const kv = process.argv.find(a => a.startsWith(`--${name}=`));
  return kv ? kv.slice(name.length + 3) : dflt;
}

function secretKey() {
  const direct = String(process.env.REN_ADMIN_KEY || '').trim();
  if (direct) return direct;
  const dir = process.env.REN_SECRET_DIR
    || path.resolve(APP, '..', '.ren-secrets');
  try { return fs.readFileSync(path.join(dir, 'alerts.key'), 'utf8').trim(); } catch { return ''; }
}

const seconds = Number(arg('seconds', '600')) || 600;
const origin = arg('origin', 'http://127.0.0.1:' + (process.env.PORT || 4477));
let url = arg('url', '');
if (!url) {
  const key = secretKey();
  if (!key) {
    console.error('拿不到运维 key：用 --url 直接给地址，或设 REN_ADMIN_KEY');
    process.exit(2);
  }
  url = `${origin}/api/admin/stream-probe?seconds=${seconds}&pingMs=15000&dataMs=15000&key=${encodeURIComponent(key)}`;
}
const sc = arg('sharecode', process.env.REN_SHARECODE || '');
if (sc && !/[?&]sharecode=/.test(url)) url += `&sharecode=${encodeURIComponent(sc)}`;

const originHeader = (() => {
  try { return new URL(url).origin; } catch { return origin; }
})();

console.log(`探针 ${seconds}s → ${url.replace(/key=[^&]+/, 'key=***')}`);

const t0 = Date.now();
const beats = [];
let pings = 0;
let firstByteMs = -1;
let rawBytes = 0;
let endedBy = 'unknown';
let errMsg = '';

const ctrl = new AbortController();
/* 客户端自己也要有上限：如果网关不切、服务端也不切，脚本不能永远挂在那里。
   多留 30 秒，是为了区分「服务端按时结束」和「客户端放弃等待」。 */
const guard = setTimeout(() => { endedBy = 'client-timeout'; ctrl.abort(); }, (seconds + 30) * 1000);

try {
  const r = await fetch(url, {
    headers: { Origin: originHeader, Accept: 'text/event-stream' },
    signal: ctrl.signal
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error(`HTTP ${r.status}：${body.slice(0, 300)}`);
    process.exit(1);
  }
  const ct = String(r.headers.get('content-type') || '');
  if (!ct.includes('event-stream')) {
    console.error(`返回的不是事件流：${ct}`);
    process.exit(1);
  }

  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    if (firstByteMs < 0) firstByteMs = Date.now() - t0;
    rawBytes += chunk.length;
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!frame) continue;
      /* 注释帧（: ping）在 fetch 的字节流里是看得到的。
         如果服务端发了而这里收不到，就是中间层把它吃掉了。 */
      if (frame.startsWith(':')) { if (/ping/.test(frame)) pings += 1; continue; }
      const data = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.t === 'beat') {
        beats.push({ n: ev.n, at: ev.at, arrivedAt: Date.now(), lag: Date.now() - Number(ev.at || Date.now()) });
      } else if (ev.t === 'probe-end') {
        endedBy = 'server-timer';
      }
    }
  }
  if (endedBy === 'unknown') endedBy = 'stream-closed';
} catch (e) {
  if (e && e.name === 'AbortError') { if (endedBy === 'unknown') endedBy = 'client-abort'; }
  else { errMsg = e.message || String(e); endedBy = 'error'; }
} finally {
  clearTimeout(guard);
}

const elapsedMs = Date.now() - t0;
const lags = beats.map(b => b.lag);
const half = Math.floor(lags.length / 2);
const avg = (a) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
const earlyLag = avg(lags.slice(0, half));
const lateLag = avg(lags.slice(half));
const maxLag = lags.length ? Math.max(...lags) : 0;

console.log('');
console.log('── 结果 ──');
console.log(`  总时长        ${(elapsedMs / 1000).toFixed(1)}s（计划 ${seconds}s）`);
console.log(`  结束方式      ${endedBy}${errMsg ? ' | ' + errMsg : ''}`);
console.log(`  首字节        ${firstByteMs < 0 ? '没收到任何字节' : firstByteMs + 'ms'}`);
console.log(`  收到数据帧    ${beats.length} 个（服务端节奏 15s/个）`);
console.log(`  收到心跳帧    ${pings} 个`);
console.log(`  延迟 lag      最大 ${maxLag}ms | 前半段均值 ${earlyLag}ms | 后半段均值 ${lateLag}ms`);
console.log(`  字节数        ${rawBytes}`);

console.log('');
console.log('── 判读 ──');
const complete = endedBy === 'server-timer' && elapsedMs >= seconds * 1000 - 3000;
if (complete) {
  console.log(`  ✔ 挂满了 ${seconds}s，网关没有按总时长切断`);
} else if (endedBy === 'server-timer') {
  console.log(`  ⚠ 服务端按时结束但客户端早到 ${((seconds * 1000 - elapsedMs) / 1000).toFixed(1)}s，时钟或代理有偏差`);
} else if (endedBy === 'client-timeout') {
  console.log('  ✔ 客户端超时才放弃（比计划多等了 30s 都没结束）——更像是服务端没按时收工');
} else {
  console.log(`  ✘ 在 ${(elapsedMs / 1000).toFixed(1)}s 处被切断（计划 ${seconds}s）→ 网关或中间层有上限`);
}

if (firstByteMs > 3000) {
  console.log(`  ✘ 首字节 ${firstByteMs}ms，响应头到得太慢——大概率被中间层缓冲`);
} else if (firstByteMs >= 0) {
  console.log(`  ✔ 首字节 ${firstByteMs}ms，不在缓冲里等下一条`);
}

if (!beats.length) {
  console.log('  ✘ 一个数据帧都没收到');
} else if (lateLag > Math.max(2000, earlyLag * 3)) {
  console.log(`  ✘ 延迟在累积（${earlyLag}ms → ${lateLag}ms）→ 事件被攒着，实时性是假的`);
} else if (maxLag > 5000) {
  console.log(`  ⚠ 出现过 ${maxLag}ms 的延迟尖峰，但不持续`);
} else {
  console.log(`  ✔ 延迟平稳（最大 ${maxLag}ms），事件是实时的`);
}

if (pings === 0 && beats.length) {
  console.log('  ⚠ 心跳帧一个都没收到（但数据帧收到了）→ 注释帧被中间层丢弃，空闲保活可能失效');
} else if (pings > 0) {
  console.log(`  ✔ 心跳帧过得去（${pings} 个）→ 空闲保活有效`);
}

process.exit(complete ? 0 : 1);
