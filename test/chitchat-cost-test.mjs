/* 一句「你好」到底该花多少 token
 *
 * 线上现场（2026-11-04）：问一句「你好」，9,086 token、23 秒、1.82 积分。
 * 界面底下写着「产出 0 项」——九千多 token 全花在「回一句话」上。
 *
 * 拆开是三笔账，只有最后一笔该付：
 *   1. 主调用——该付；
 *   2. 验收人——纯对话没有产物可验，叫它来只能对着「你好」挑毛病，白付；
 *   3. 验收判不过 → 退回重做 → 又一次主调用，钱花了还把同一句话说两遍，最不该付。
 * 另外每次调用都重发 9 个核心工具的 schema（两千多 token），问候一个都用不上。
 *
 * 这个测试不看文案，只看两个硬指标：模型被调了几次、请求里带没带工具。
 */
import http from 'node:http';
import { startRun } from '../lib/agent-host.js';
import { TOOL_DEFS, TOOL_CATEGORY } from '../lib/tools.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
}

const USAGE = 'data: {"choices":[],"usage":{"prompt_tokens":800,"completion_tokens":20,"total_tokens":820}}\n\n';
/* 一轮「只说了一句话、没调工具」的响应 */
const SAY = 'data: {"choices":[{"delta":{"content":"周砚在。"}}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
  + USAGE + 'data: [DONE]\n\n';
/* 一轮「调了一个工具」的响应（todo_write 最轻，不碰文件系统） */
const CALL = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function",'
  + '"function":{"name":"todo_write","arguments":"{\\"todos\\":[{\\"text\\":\\"x\\"}]}"}}]}}]}\n\n'
  + 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n'
  + USAGE + 'data: [DONE]\n\n';

/* 假通道：既是模型端点，也是工具清单端点。
   plan[i] 决定第 i 次模型请求回什么，缺省就回 SAY。 */
function fakeCloud(plan = []) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const url = String(req.url || '');
      if (url.startsWith('/api/tooldefs')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, tools: TOOL_DEFS, categories: TOOL_CATEGORY }));
        return;
      }
      /* 只统计真正打到模型通道的请求。
         这个坑踩过一次：一开始把所有请求都算成「模型调用」，
         把取记忆的 GET /api/memory/brief 也算进去，误判成「调了两次」。 */
      if (!url.startsWith('/.cloud/llm/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, items: [], brief: '', pass: true, missing: [] }));
        return;
      }
      const i = calls.length;
      calls.push({ url, body, at: Date.now() });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(plan[i] || SAY);
    });
  });
  return { srv, calls };
}

async function withCloud(plan, fn) {
  const { srv, calls } = fakeCloud(plan);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(endpoint, calls); }
  finally { srv.close(); }
}

function baseJob(goal, extra = {}) {
  return {
    task: { id: 'gc1', goal, userMsgs: [{ text: goal, at: 0 }] },
    staff: { id: 's1', name: '周砚', role: '秘书', persona: '干练、不啰嗦的行政秘书', notes: '', style: 'calm' },
    settings: {
      maxSteps: 6, maxTokens: 200000,
      permissions: { read: true, write: true, exec: false, net: false }
    },
    model: 'test-model',
    judge: { id: 'judge-model', name: 'judge-model', level: 'none', reason: '测试' },
    ...extra
  };
}

function runOnce(endpoint, job) {
  return new Promise((resolve) => {
    const run = startRun({
      id: job.task.id, scope: '0123456789abcdef0123456789abcdef', uid: 'u1',
      ...job,
      base: endpoint, sharecode: '', internal: 'test-internal',
      token: 'test-token', accessKey: 'test-key', endpoint, tools: []
    });
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (Date.now() - t0 > 25000) { clearInterval(tick); resolve({ run, timedOut: true }); return; }
      if (!run.alive) { clearInterval(tick); resolve({ run, timedOut: false }); }
    }, 60);
  });
}

/* ── [1] 一句问候：只准调一次模型，而且不带工具 ── */
console.log('[1] 「你好」：一次调用，不带工具');
await withCloud([], async (endpoint, calls) => {
  const { timedOut } = await runOnce(endpoint, baseJob('你好'));
  ok('没有超时', !timedOut);
  ok('只调了一次模型（验收人没有来，也没有返工）', calls.length === 1, calls.length);
  const body = calls[0] ? calls[0].body : '';
  ok('请求里没有 tools 字段（9 个核心工具的 schema 不再白付）',
    !/"tools"\s*:/.test(body), body.slice(0, 160));
});

/* ── [2] 同样的问候，换个说法也不算活 ── */
console.log('[2] 别的寒暄同待遇');
for (const g of ['在吗', '谢谢', '早上好！', 'ok']) {
  await withCloud([], async (endpoint, calls) => {
    await runOnce(endpoint, baseJob(g));
    ok(`「${g}」也只调一次`, calls.length === 1, calls.length);
  });
}

/* ── [3] 带诉求的一句话不能被当成问候 ── */
console.log('[3] 带诉求的话照常干活');
await withCloud([], async (endpoint, calls) => {
  await runOnce(endpoint, baseJob('你好，帮我写一份周报'));
  ok('「你好，帮我写一份周报」不是问候，会带工具',
    calls.some(c => /"tools"\s*:/.test(c.body)), calls.map(c => c.body.slice(0, 60)));
  ok('并且下发了 make_doc', calls.some(c => /"name":"make_doc"/.test(c.body)));
});

/* ── [4] 反过来：真调过工具就该验收，别把这个也一起关掉 ──
   上面三组都在证明「闲聊别调验收人」。但如果把条件写宽了，
   正经任务的验收会一起失效——那比多花 token 严重得多。
   这一组的模型第一轮调了工具，所以验收必须照跑。 */
console.log('[4] 调过工具的任务仍然验收');
await withCloud([CALL, SAY, SAY], async (endpoint, calls) => {
  const { timedOut } = await runOnce(endpoint, baseJob('你好'));
  ok('没有超时', !timedOut);
  ok('调过工具 → 走满主调用 + 验收', calls.length >= 3, calls.length);
  ok('第二次调用带了工具（说明它不是被当成闲聊）',
    calls[1] && /"tools"\s*:/.test(calls[1].body));
});

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
