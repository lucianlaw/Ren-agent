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
    this.log.push(rec);
    /* 单条事件可能很大（工具回包几万字），但一条任务的事件总数有限。
       超过上限丢最早的：重连时丢开头比进程被撑爆好。 */
    if (this.log.length > this.cap) this.log.splice(0, this.log.length - this.cap);
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
  /* 从 fromSeq 之后开始收；已经有了的先吐出来，剩下的等新的 */
  async *since(fromSeq) {
    let i = this.log.findIndex(r => r.seq > fromSeq);
    if (i < 0) i = this.log.length;
    for (;;) {
      while (i < this.log.length) {
        yield this.log[i];
        i += 1;
      }
      if (this.done) return;
      const nxt = await new Promise(resolve => this.waiters.push(resolve));
      if (!nxt) return;
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

/* ── 造壳 ──
 * opts:
 *   base      自调用基址（http://127.0.0.1:PORT）
 *   sharecode 网关分享码；线上所有请求都要带，否则被网关挡在外面
 *   internal  内部调用密钥；带上它服务端自己人不再走 Origin/限流检查
 *   token     用户 access_token（模型通道的唯一凭证）
 *   endpoint  云端基址（取 cloud-config 里那个）
 *   tools     自定义工具描述符（前端 CUSTOM_TOOLS 的内容）
 *   onEvent   事件出口
 *   signal    外部中断
 */
export function buildSandbox(opts) {
  const {
    base, sharecode, internal, token, accessKey, endpoint, tools = [], signal
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
     全都走这里，所以只有这一个实现点需要接对 */
  g.CLOUD = {
    chatStream: (payload) => chatStream({ endpoint, token, accessKey, payload, signal }),
    listModels: () => listModels({ endpoint, token, accessKey }),
    /* 标准员工库的记忆：run 会问一次，拿不到就当没有（不是错） */
    listStdMemOf: async () => []
  };
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
    }
  })();

  return run;
}

export const __test = { SCRIPTS, Bus, scriptOf };
