/* 服务端跑 agent 循环：给浏览器代码造一个最小运行壳
 *
 * 为什么用壳而不是把这 2232 行改写成 ESM
 *   agent.js 本来就按「事件流」写的：它只 emit 事件，由外面负责渲染。
 *   实测它对外部世界只有三个真实接缝（withSC / fetch / CLOUD.chatStream），
 *   DOM 依赖是 0。既然如此，与其重写一份、让前后端从此各维护一套逻辑
 *   （然后慢慢分叉），不如在服务端给它一个壳，跑的就是同一份文件。
 *
 *   代价是每跑一个任务要新建一个 vm context（约 5–15ms）。
 *   这个代价换到的是并发安全：METER、activeGoal、approvals 都是模块级变量，
 *   共用一个 context 会让两个任务互相污染，那时候的 bug 极难查。
 *
 * 这不是安全沙箱：context 里跑的是我们自己发布的代码，不是用户代码。
 * 它只负责「状态隔离」，不负责「防恶意」。别把这条界线搞混。
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatStream, listModels } from './llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

/* 加载顺序有依赖：agent.js 在构建系统提示时会读 TRAITS / CONTRACT，
   judge.js 被 run 用来做验收。顺序错了不会报错，只会在某个分支上悄悄变成 undefined，
   所以把它写死成常量，不靠目录遍历。 */
const SCRIPTS = ['judge.js', 'contract.js', 'traits.js', 'roles.js', 'nameorder.js', 'states.js', 'agent.js'];

/* 预编译一次，反复实例化 context。
   vm.Script 可以在多个 context 里重复 runInContext，编译开销只付一次。 */
const compiled = new Map();
function scriptOf(name) {
  if (compiled.has(name)) return compiled.get(name);
  const src = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
  const s = new vm.Script(src, { filename: `public/${name}` });
  compiled.set(name, s);
  return s;
}

export function warmup() {
  for (const n of SCRIPTS) scriptOf(n);
  return SCRIPTS.length;
}

/* 任务事件总线：一条 run 的所有 emit 都从这里出去。
   - log 留着是为了前端断线重连能续上（刷新页面不该丢掉已经发生的步骤）
   - 总线关闭后 attach 仍能拿到完整 log，然后立刻结束，不会挂住连接 */
class Bus {
  constructor(cap = 4000) {
    this.log = [];
    this.seq = 0;
    this.cap = cap;
    this.done = false;
    this.waiters = [];
  }
  push(ev) {
    this.seq += 1;
    const rec = { seq: this.seq, ev };
    /* 推理过程不进重连日志：它是高频的（每 140ms 一帧全量）且只在「此刻正在看」
       的时候有意义。全塞进 log 会把真正的步骤挤出去——log 有上限，被挤掉的
       第一条往往是任务的起点。seq 照常递增，续传游标跳号不影响任何判断。 */
    if (!(ev && ev.t === 'think')) {
      this.log.push(rec);
      /* 单条事件可能很大（工具回包几万字），但一条任务的事件总数有限。
         超过上限丢最早的：重连时丢开头比进程被撑爆好。 */
      if (this.log.length > this.cap) this.log.splice(0, this.log.length - this.cap);
    }
    const ws = this.waiters.splice(0);
    for (const w of ws) w(rec);
  }
  close() {
    this.done = true;
    const ws = this.waiters.splice(0);
    for (const w of ws) w(null);
  }
  /* 叫醒等着的订阅者但不关总线：SSE 断开时用。
     断开的是「这一个订阅者」，不是任务——任务该继续跑完。 */
  wake() {
    const ws = this.waiters.splice(0);
    for (const w of ws) w(null);
  }
  /* 从 fromSeq 之后开始收；已经有了的先吐出来，剩下的等新的。
     注意「实时事件不一定在 log 里」：think（推理回显）刻意不落 log（高频、体积大，
     会把真正的步骤挤出去），但它必须能立刻送到正在看的人手上。
     所以订阅者拿到的那条要直接 yield 一次，并用 last 去重——
     否则它下次从 log 遍历时会被重复发一遍。 */
  async *since(fromSeq) {
    let last = Number(fromSeq) || 0;
    let i = this.log.findIndex(r => r.seq > last);
    if (i < 0) i = this.log.length;
    for (;;) {
      while (i < this.log.length) {
        const rec = this.log[i];
        i += 1;
        if (rec.seq > last) { last = rec.seq; yield rec; }
      }
      if (this.done) return;
      const nxt = await new Promise(resolve => this.waiters.push(resolve));
      if (!nxt) return;
      if (nxt.seq <= last) continue;
      last = nxt.seq;
      yield nxt;
    }
  }
}

/* 一个进行中的服务端任务。对外只暴露「订阅事件 / 停止 / 插话 / 审批」四件事。 */
export class ServerRun {
  constructor({ id, scope, uid, bus, controller }) {
    this.id = id;
    this.scope = scope;
    this.uid = uid;
    this.bus = bus;
    this.controller = controller;
    this.startedAt = Date.now();
    this.finishedAt = 0;
    this.status = 'running';
    /* 由 runOnServer 填：拿到壳里的 BOSS，才能调 inject / approve */
    this.boss = null;
  }
  abort(reason = '用户停止') {
    this.abortedBy = reason;
    try { this.controller.abort(); } catch { /* ignore */ }
  }
  inject(text, images) {
    return this.boss && typeof this.boss.inject === 'function' ? this.boss.inject(text, images) : '';
  }
  approve(id, ok) {
    if (this.boss && typeof this.boss.approve === 'function') this.boss.approve(id, ok);
  }
  get alive() { return this.status === 'running'; }
}

/* ── 用量估算的底数 ──
   通道不一定回 usage 帧，没有它的那次调用只能按字符估。
   系数取「中文 ≈ 1 字 1 token、英文 ≈ 4 字符 1 token」的中间值：
   prompt 里中英混排、还夹着 JSON 和工具描述，2.5 是这三类混在一起的实测均值。
   它不精确，但比「记 0」好得多——而且 report 里会明确标出其中多少是估的。 */
const PROMPT_DIV = 2.5;
const OUT_DIV = 1.8;

function promptCharsOf(payload) {
  const msgs = payload && Array.isArray(payload.messages) ? payload.messages : [];
  let n = 0;
  for (const m of msgs) {
    const c = m && m.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) {
      for (const part of c) if (part && typeof part.text === 'string') n += part.text.length;
    }
  }
  return n;
}

/* ── 造壳 ──
 * opts:
 *   base      自调用基址（http://127.0.0.1:PORT）
 *   sharecode 网关分享码；线上所有请求都要带，否则被网关挡在外面
 *   internal  内部调用密钥；带上它服务端自己人不再走 Origin/限流检查
 *   token     用户 access_token（模型通道的唯一凭证）
 *   endpoint  云端基址（取 cloud-config 里那个）
 *   tools     自定义工具描述符（前端 CUSTOM_TOOLS 的内容）
 *   onEvent   事件出口
 *   onUsage   用量出口（每轮模型调用一次；不传就只记账不拦）
 *   signal    外部中断
 */
export function buildSandbox(opts) {
  const {
    base, sharecode, internal, token, accessKey, endpoint, tools = [], signal, onUsage
  } = opts;

  const q = sharecode ? `sharecode=${encodeURIComponent(sharecode)}` : '';
  const withSC = (p) => {
    if (!q) return base + p;
    return base + p + (p.includes('?') ? '&' : '?') + q;
  };

  /* fetch 要两件事：把相对路径补成绝对（Node 不认相对），
     以及带上内部密钥（否则线上会撞 Origin 检查，白跑一趟） */
  const wrappedFetch = (url, init = {}) => {
    const abs = /^https?:\/\//i.test(url) ? url : base + (String(url).startsWith('/') ? '' : '/') + url;
    const headers = { ...(init.headers || {}) };
    if (internal) headers['x-ren-internal'] = internal;
    if (!headers.Origin && !headers.origin) headers.Origin = base;
    return fetch(abs, { ...init, headers });
  };

  const g = {
    console,
    fetch: wrappedFetch,
    withSC,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    structuredClone,
    atob,
    btoa,
    performance
  };
  g.window = g;
  g.self = g;
  g.globalThis = g;

  /* 模型通道：agent.js 里三处 `for await (const chunk of window.CLOUD.chatStream(payload))`
     全都走这里，所以只有这一个实现点需要接对。

     用量上报挂在这个包装上，而不是改 llm.js：llm.js 是「通道协议」的实现，
     它该知道的只有 SSE 怎么切、错误怎么翻译；「谁花了多少 token」是计费侧的事。
     两件事混在一个文件里，以后想换通道就得连计量一起重写。

     计量的三个现实：
       ① 流式响应**不一定**带 usage 帧。当成一定有，结果是所有账号用量恒为 0——
          「有配额」变成一句空话。所以有 usage 就记准的，没有就按字符估，并分开记。
       ② 任务被中途 abort 时生成器会抛异常跳出。用量在 finally 里报——
          「被打断的那次调用」照样烧了 token，不记等于留了一条免费通道。
       ③ 上报本身绝不能让任务失败，所以整段是 try/catch 包死的。 */
  g.CLOUD = {
    chatStream: async function* (payload) {
      const t0 = Date.now();
      const pChars = promptCharsOf(payload);
      let outChars = 0;
      let usage = null;
      try {
        for await (const chunk of chatStream({ endpoint, token, accessKey, payload, signal })) {
          /* usage 可能挂在最后一个 chunk，也可能是每个 chunk 的累计值：后到覆盖先到 */
          if (chunk && chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
          const d = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (d && typeof d.content === 'string') outChars += d.content.length;
          yield chunk;
        }
      } finally {
        reportUsage({ usage, pChars, outChars, ms: Date.now() - t0, model: payload && payload.model });
      }
    },
    listModels: () => listModels({ endpoint, token, accessKey }),
    /* 标准员工库的记忆：run 会问一次，拿不到就当没有（不是错） */
    listStdMemOf: async () => []
  };

  function reportUsage({ usage, pChars, outChars, ms, model }) {
    if (typeof onUsage !== 'function') return;
    try {
      let total = 0;
      let exact = false;
      const uTotal = usage && Number(usage.total_tokens);
      if (Number.isFinite(uTotal) && uTotal > 0) {
        total = Math.round(uTotal);
        exact = true;
      } else if (usage) {
        const sum = (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
        if (sum > 0) { total = Math.round(sum); exact = true; }
      }
      if (!total) {
        /* 没有 usage：按字符估。prompt 用本次 payload 的总字符数（历史消息本来就在里面，
           不另做累加——累加会把同一段对话重复计费）。 */
        total = Math.round(pChars / PROMPT_DIV + outChars / OUT_DIV);
        exact = false;
      }
      if (total > 0) onUsage({ total, exact, promptChars: pChars, outChars, ms, model: String(model || '') });
    } catch { /* 计量出错不影响任务 */ }
  }

  g.CUSTOM_TOOLS = Array.isArray(tools) ? tools : [];

  return vm.createContext(g, { name: 'ren-agent' });
}

export function loadInto(ctx) {
  for (const n of SCRIPTS) scriptOf(n).runInContext(ctx, { timeout: 10000 });
  const w = ctx.window || ctx;
  if (!w.BOSS || typeof w.BOSS.run !== 'function') {
    throw new Error('agent 循环没加载出来（window.BOSS 缺失），服务端跑不了');
  }
  return w.BOSS;
}

/* 起一个任务：造壳 → 加载 → 跑 run → 事件全部进 bus。
   返回 ServerRun，调用方拿它订阅。 */
export function startRun(opts) {
  const { id, scope, uid, task, staff, settings, model, judge, followUp, followUpImages, signal, onEvent } = opts;
  const { onEnd } = opts;
  const bus = new Bus();
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const run = new ServerRun({ id, scope, uid, bus, controller });

  /* emit：循环唯一的事件出口。这里不做任何加工，原样转发——
     applyEvent 在浏览器那边认的就是这些字段，多包一层就会全都不认。 */
  const emit = (ev) => {
    try {
      bus.push(ev);
      if (typeof onEvent === 'function') onEvent(ev);
    } catch { /* 前端处理出错不能反过来打断循环 */ }
  };

  (async () => {
    try {
      const ctx = buildSandbox({ ...opts, signal: controller.signal });
      const BOSS = loadInto(ctx);
      run.boss = BOSS;
      const out = await BOSS.run({
        task, staff, settings, model, judge, followUp, followUpImages,
        scope, signal: controller.signal, emit
      });
      run.status = (out && out.status) || 'done';
    } catch (e) {
      run.status = 'failed';
      emit({ t: 'error', message: String((e && e.message) || e || '服务端执行失败') });
    } finally {
      run.finishedAt = Date.now();
      emit({ t: 'end', status: run.status, ms: run.finishedAt - run.startedAt });
      bus.close();
      /* 收尾通知放在最后，且包死：状态层的清理（解锁、释放路径租约）失败
         不能把「任务已结束」这个事实吞掉——那个更贵。 */
      try {
        if (typeof onEnd === 'function') {
          onEnd({ status: run.status, reason: run.abortedBy || (run.quotaStopped ? `额度：${run.quotaStopped}` : '') });
        }
      } catch { /* ignore */ }
    }
  })();

  return run;
}

export const __test = { SCRIPTS, Bus, scriptOf };
