// 服务端执行循环：这一层要保证的是「搬过去之后行为没变」
//
// 搬家的风险不在「能不能跑起来」，而在几处一旦错就很像别的问题的地方：
//   · SSE 切帧切在半个事件上 → 丢一步，看起来像模型漏了动作
//   · 权限取值取错层（拿到包装对象）→ 每步都判缺权限，看起来像开关没开
//   · 步数参数没送到 → 循环一次不跑，看起来像模型没话说
//   · 断开连接顺手把任务中止 → 「刷新不断」这个卖点直接失效
// 所以这组测试盯的是这四条，不是「函数能不能调通」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatStream, listModels, __test as llmTest } from '../lib/llm.js';
import { buildSandbox, loadInto, startRun, __test as hostTest } from '../lib/agent-host.js';
const { Bus, SCRIPTS } = hostTest;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const cloudSrc = fs.readFileSync(path.join(ROOT, 'public', 'cloud.js'), 'utf8');
const hostSrc = fs.readFileSync(path.join(ROOT, 'lib', 'agent-host.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra === undefined ? '' : ' → ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300)}`);
};

/* ── 假通道 ──
   不联网：给它一个 Response，body 是 ReadableStream，按字节吐 SSE。 */
function sseResponse(frames, { status = 200, headers = {} } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    }
  });
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream', ...headers } });
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

async function collect(iter) {
  const out = [];
  for await (const x of iter) out.push(x);
  return out;
}

async function main() {
  /* ══ 1. SSE 切帧 ══ */
  {
    const chunks = [
      frame({ choices: [{ delta: { content: '你' } }] }),
      frame({ choices: [{ delta: { content: '好' } }] }),
      'data: [DONE]\n\n'
    ];
    /* 故意在事件中间切断：真实网络就是这样切的，切点由 TCP 决定不由我们决定 */
    const whole = chunks.join('');
    const pieces = [];
    for (let i = 0; i < whole.length; i += 7) pieces.push(whole.slice(i, i + 7));

    const got = await collect(chatStream({
      endpoint: 'http://x', token: 't', payload: { model: 'm' },
      fetchImpl: async () => sseResponse(pieces)
    }));
    ok('切成 7 字节一片也能拼回完整事件', got.length === 2, got.length);
    ok('内容没有丢字', got.map(c => c.choices[0].delta.content).join('') === '你好',
      got.map(c => c.choices[0].delta.content).join(''));

    /* 必须 stream:true：通道不提供非流式，传 false 会被直接拒 */
    let sent = null;
    await collect(chatStream({
      endpoint: 'http://x', token: 't', payload: { model: 'm', stream: false },
      fetchImpl: async (u, init) => { sent = JSON.parse(init.body); return sseResponse([frame({ ok: 1 }), 'data: [DONE]\n\n']); }
    }));
    ok('无论如何都按 stream:true 发', sent && sent.stream === true, sent);

    let auth = '';
    await collect(chatStream({
      endpoint: 'http://x', token: 'tok-abc', payload: {},
      fetchImpl: async (u, init) => { auth = init.headers.Authorization; return sseResponse(['data: [DONE]\n\n']); }
    }));
    ok('用用户 token 鉴权，不是 publishableKey', auth === 'Bearer tok-abc', auth);
  }

  /* ══ 2. 通道报错要能读 ══ */
  {
    let err = null;
    try {
      await collect(chatStream({
        endpoint: 'http://x', token: 't', payload: {},
        fetchImpl: async () => sseResponse(['{"error":{"message":"client credential is invalid"}}'], { status: 401 })
      }));
    } catch (e) { err = e; }
    ok('401 抛错而不是静默结束', !!err, err && err.message);
    ok('401 标成 auth_invalid（前端据此判断该重新登录）', err && err.code === 'auth_invalid', err && err.code);
    ok('错误文案说清是凭证问题', /凭证|鉴权|token/.test(String(err && err.message)), err && err.message);

    /* 一帧都没有就断开：不能当成「模型无话可说」 */
    let empty = null;
    try {
      await collect(chatStream({
        endpoint: 'http://x', token: 't', payload: {},
        fetchImpl: async () => sseResponse([])
      }));
    } catch (e) { empty = e; }
    ok('空流判失败，不当成正常收工', !!empty, empty && empty.message);

    /* 网关拦截页（HTML）：剥标签压成一行，不能把几十行乱码甩给用户 */
    ok('HTML 错误页被压成一行', (() => {
      const t = llmTest.errText(502, '<html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>');
      return !t.includes('<') && t.length < 200;
    })());

    /* data 帧里带回错误 */
    let dErr = null;
    try {
      await collect(chatStream({
        endpoint: 'http://x', token: 't', payload: {},
        fetchImpl: async () => sseResponse([frame({ error: { message: 'quota exceeded', code: 'quota_x' } })])
      }));
    } catch (e) { dErr = e; }
    ok('data 帧里的 error 也要抛', !!dErr && /quota/.test(dErr.message), dErr && dErr.message);

    /* 心跳注释行不能当数据 */
    const hb = await collect(chatStream({
      endpoint: 'http://x', token: 't', payload: {},
      fetchImpl: async () => sseResponse([': ping\n\n', frame({ choices: [{ delta: { content: 'x' } }] }), 'data: [DONE]\n\n'])
    }));
    ok('心跳注释行被跳过', hb.length === 1, hb.length);
  }

  /* ══ 3. 事件总线 ══ */
  {
    const b = new Bus(4);
    b.push({ t: 'a' });
    b.push({ t: 'b' });
    const seen = [];
    const it = (async () => { for await (const r of b.since(0)) seen.push(r.ev.t); })();
    await new Promise(r => setTimeout(r, 10));
    ok('已有的先吐出来', seen.join(',') === 'a,b', seen.join(','));

    b.push({ t: 'c' });
    await new Promise(r => setTimeout(r, 10));
    ok('后到的也能收到', seen.join(',') === 'a,b,c', seen.join(','));

    b.close();
    await it;
    ok('关闭后循环正常结束', seen.length === 3, seen.length);

    const b2 = new Bus(3);
    for (let i = 0; i < 6; i++) b2.push({ t: 'x' + i });
    /* 必须先 close 再遍历：总线不关，for await 会一直等下一个事件。
       而没有活动句柄时 Node 会直接退出——「全绿」和「一行没跑」在输出上完全一样，
       这一条坑值得写在这里，比写在文档里有用的多。 */
    b2.close();
    const left = [];
    for await (const r of b2.since(0)) left.push(r.ev.t);
    ok('超上限丢最早的，不撑爆内存', left.length === 3 && left[2] === 'x5', left.join(','));

    /* 断线时叫醒订阅者但不关总线：任务要继续跑 */
    const b3 = new Bus();
    let alive = true;
    const waiter = (async () => { for await (const r of b3.since(0)) { if (!r) break; } alive = false; })();
    await new Promise(r => setTimeout(r, 10));
    ok('等待中的订阅者会挂住', alive === true);
    b3.wake();
    await waiter;
    ok('wake 后订阅者退出（连接能释放）', alive === false);
    ok('wake 不等于关闭总线（任务还在跑）', b3.done === false);
  }

  /* ══ 4. 壳能真的把循环加载起来 ══ */
  {
    const ctx = buildSandbox({
      base: 'http://127.0.0.1:1', sharecode: 'X', internal: 'k',
      token: 't', endpoint: 'http://127.0.0.1:1', tools: [{ name: 'x' }]
    });
    const BOSS = loadInto(ctx);
    ok('window.BOSS 出现了', !!(ctx.window && ctx.window.BOSS), null);
    ok('run 是函数', typeof BOSS.run === 'function');
    ok('inject / approve 都导出了（服务端要能转回去）',
      typeof BOSS.inject === 'function' && typeof BOSS.approve === 'function');
    ok('judge / contract / traits 三个依赖都加载了',
      !!(ctx.window.JUDGE && ctx.window.CONTRACT && ctx.window.TRAITS));
    ok('自定义工具进了壳', Array.isArray(ctx.window.CUSTOM_TOOLS) && ctx.window.CUSTOM_TOOLS.length === 1);
    ok('withSC 会带上 sharecode', ctx.window.withSC('/api/tool').includes('sharecode=X'), ctx.window.withSC('/api/tool'));

    /* 两个实例之间不能串状态：METER / activeGoal 都是模块级变量，
       共用一个 context 会让并发任务互相污染 token 账 */
    const ctx2 = buildSandbox({ base: 'http://127.0.0.1:1', sharecode: 'Y', internal: 'k', token: 't', endpoint: 'http://x' });
    const BOSS2 = loadInto(ctx2);
    ok('两个实例是两套对象（状态隔离）', BOSS !== BOSS2);
    ok('第二个实例的 sharecode 是自己的', ctx2.window.withSC('/a').includes('sharecode=Y'));

    ok('加载清单写死且顺序固定', SCRIPTS[SCRIPTS.length - 1] === 'agent.js', SCRIPTS.join(','));
  }

  /* ══ 5. 服务端接线（读源码断言，防「改了别处忘了这处」）══ */
  {
    ok('/api/run 存在', /u\.pathname === '\/api\/run' && req\.method === 'POST'/.test(serverSrc));
    ok('权限取 .perms（不是包装对象）', /effectivePerms\(scope, settings\.permissions\)\.perms/.test(serverSrc));
    ok('步数参数两种写法都收', /settings\.maxSteps == null/.test(serverSrc) && /max_steps/.test(serverSrc));
    /* 判据从「内存里有没有对应 Run」换成了「锁在谁手里」——锁在磁盘上，
       所以这条检查也顺带盯着「多进程场景下占用可见」这件事没被改回去。 */
    ok('同工作区只允许一个执行', /state\.acquireLock\(lockKey, runId\)/.test(serverSrc) && /code: 'busy'/.test(serverSrc));
    ok('占用锁按设备粒度（同账号多端可并发）', /runLockKey\(scope, device\)/.test(serverSrc)
      && /run:\$\{scope\}:\$\{device\}/.test(serverSrc));
    ok('任务收尾落状态层', /onEnd: \(\{ status, reason \}\)/.test(serverSrc) && /state\.runEnd\(runId/.test(serverSrc));
    ok('断开连接不中止任务', !/res\.on\('close',\s*\(\)\s*=>\s*run\.abort/.test(serverSrc));
    ok('有停止端点', /endsWith\('\/stop'\)/.test(serverSrc) && /run\.abort\('用户停止'\)/.test(serverSrc));
    ok('有插话与审批端点', /\/inject/.test(serverSrc) && /\/approve/.test(serverSrc));
    ok('重连端点支持 from 续传', /searchParams\.get\('from'\)/.test(serverSrc));
    ok('心跳防代理超时', /: ping\\n\\n/.test(serverSrc));
    ok('内部自调用有豁免（否则线上工具全被 Origin 拦）',
      /isInternal\(req\)/.test(serverSrc) && /const internal = isInternal\(req\)/.test(serverSrc));
    ok('内部密钥随机生成、不落盘', /crypto\.randomBytes\(16\)\.toString\('hex'\)/.test(serverSrc));
    ok('token 只放内存', /const TOKENS = new Map\(\)/.test(serverSrc) && !/writeFileSync\([^)]*token/i.test(serverSrc));
    ok('模型基址和前端读同一份配置', /cloud-config\.js/.test(serverSrc) && /REN_LLM_BASE/.test(serverSrc));
  }

  /* ══ 6. 前端接线 ══ */
  {
    ok('发起走服务端', /await agentRun\(\{/.test(appSrc));
    ok('不再自己跑循环', !/await BOSS\.run\(\{/.test(appSrc));
    ok('游客回退到本地执行（否则游客彻底不能用）',
      /if \(state\.guest \|\| !state\.session\)/.test(appSrc) && /return BOSS\.run\(job\)/.test(appSrc));
    ok('停止会通知服务端', /function agentStop\(\)[\s\S]{0,120}srvAction\('\/stop'/.test(appSrc));
    ok('插话会通知服务端', /function agentInject\([\s\S]{0,600}srvAction\('\/inject'/.test(appSrc));
    /* 插话带的图只能传路径：这条请求体塞 base64 一样会被网关拦（403），
       而拦下来界面还显示「已插给员工」，图就静默丢了 */
    ok('插话带的图只传路径', /srvAction\('\/inject',\s*\{\s*text,\s*images:\s*slimFiles\(images\)\s*\}\)/.test(appSrc));
    ok('审批会通知服务端', /function agentApprove\([\s\S]{0,150}srvAction\('\/approve'/.test(appSrc));
    ok('忙碌时挂到已有任务上', /code === 'busy'[\s\S]{0,120}attachServerRun/.test(appSrc));
    ok('SSE 按 \\n\\n 切帧', /indexOf\('\\n\\n'\)/.test(appSrc));
    ok('心跳帧不当事件', /frame\.startsWith\(':'\)/.test(appSrc));
    ok('cloud.js 导出了 accessToken', /accessToken,/.test(cloudSrc) && /async function accessToken/.test(cloudSrc));
    ok('取 token 先问 auth 再翻 session', /getAccessToken/.test(cloudSrc) && /access_token/.test(cloudSrc));
  }

  /* ══ 7. 端到端：真起一条 run，用假通道 ══ */
  {
    /* 这里只验「壳 + 事件总线 + 工具调用」能串起来，模型用假的。
       真实模型的验证在线上做（需要用户 token），不在单测里假装能做到。 */
    const fake = async (url, init) => {
      const body = JSON.parse(init.body);
      const hasTool = (body.messages || []).some(m => m.role === 'tool');
      if (!hasTool) {
        const args = JSON.stringify({ path: 'probe.txt', content: 'hi' });
        return sseResponse([
          frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] }),
          ...args.match(/.{1,20}/g).map(p => frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: p } }] } }] })),
          frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n'
        ]);
      }
      return sseResponse([
        frame({ choices: [{ delta: { content: '做完了' } }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n'
      ]);
    };

    const events = [];
    /* 用假的 fetch 顶掉全局，避免真的打网络 */
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, i) => {
      if (String(u).includes('/chat/completions')) return fake(u, i);
      /* 工具调用打回自己的 /api/tool：这里返回一个成功体，验证事件流会不会带上它 */
      /* 顺序要紧：/api/tooldefs 里也含 '/api/tool'，先判 tooldefs，
         否则工具清单会拿到 /api/tool 的返回体 → CATS 为空 → 每个工具都被判成 exec → 全被权限拦 */
      if (String(u).includes('/api/tooldefs')) {
        return new Response(JSON.stringify({ ok: true, tools: [{ type: 'function', function: { name: 'write_file', description: '写文件', parameters: { type: 'object', properties: {} } } }], categories: { write_file: 'write' } }), { status: 200 });
      }
      if (String(u).includes('/api/tool')) {
        return new Response(JSON.stringify({ ok: true, result: { ok: true, output: '写好了', ms: 5, verify: { pass: true } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    try {
      const run = startRun({
        id: 'unit-1', scope: 'a'.repeat(32), uid: 'u1',
        task: { id: 'unit-1', goal: '写一个 probe.txt', files: [], messages: [], steps: [], userMsgs: [], curRound: 1 },
        staff: { id: 's', name: '测试', role: '助手' },
        settings: { maxSteps: 3, maxTokens: 100000, permissions: { read: true, write: true, exec: false, net: false }, verify: false },
        model: 'stub', base: 'http://127.0.0.1:1', sharecode: '', internal: 'k',
        token: 't', endpoint: 'http://127.0.0.1:1',
        onEvent: (ev) => events.push(ev)
      });
      const deadline = Date.now() + 8000;
      while (run.alive && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      ok('run 跑完了（没卡死）', !run.alive, run.status);
      ok('拿到了事件', events.length > 3, events.length);
      ok('有工具调用', events.some(e => e.t === 'step' && e.kind === 'call'), events.map(e => e.t).join(','));
      ok('有工具结果', events.some(e => e.t === 'step' && e.kind === 'result'), null);
      ok('工具结果是成功的', (() => {
        const r = events.find(e => e.t === 'step' && e.kind === 'result');
        return r && r.ok === true;
      })(), null);
      ok('发出了 end（前端据此收尾）', events.some(e => e.t === 'end'), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* ══ 8. 中止 ══ */
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{}', { status: 200 });
    try {
      const run = startRun({
        id: 'unit-2', scope: 'b'.repeat(32), uid: 'u2',
        task: { id: 'unit-2', goal: 'x', files: [], messages: [], steps: [], userMsgs: [] },
        staff: { id: 's', name: 't', role: 'r' },
        settings: { maxSteps: 2, maxTokens: 1000, permissions: {}, verify: false },
        model: 'm', base: 'http://127.0.0.1:1', sharecode: '', internal: 'k',
        token: 't', endpoint: 'http://127.0.0.1:1'
      });
      run.abort('用户停止');
      const deadline = Date.now() + 5000;
      while (run.alive && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      ok('abort 之后不再 alive', !run.alive, run.status);
      ok('abort 后总线关闭（订阅者能释放）', run.bus.done === true);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  /* 用 exitCode 而不是 process.exit：直接退出会把还没刷出去的 stdout 丢掉，
     于是「全绿」和「一行没跑」在管道里长得一模一样 */
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error('崩了：', e); process.exit(1); });
