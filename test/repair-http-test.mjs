/* 修复工作区：真的把服务起起来打一遍
 *
 * 只测 lib 是不够的。这条链路要在线上走通，得同时满足四件事：
 *   1. 路由挂上了
 *   2. 它没被身份闸门挡在门外（调用方是命令行，没有浏览器登录态）
 *   3. 令牌判在 handler 里，而且判在「这是不是 dev 实例」之前
 *   4. 生产实例上它真的关着
 * 少任何一条，纯函数测试都照样全绿，而它一次也走不通。
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

const TOKEN = 'repair-http-token-0123456789';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-http-'));
let child = null;
let PORT = 0;

const pickPort = () => 39000 + Math.floor(Math.random() * 4000);

async function waitUp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/* dev 实例的四个数据目录必须都在 REN_DEV_ROOT 下面，否则启动闸门会拒——
   这正是 lib/devinfo.js 那条约定，测试里照它办，也顺带验证了它能正常启动。 */
async function boot(dev) {
  for (let attempt = 0; attempt < 4; attempt++) {
    PORT = pickPort();
    const root = path.join(TMP, dev ? 'dev-root' : 'prod-root');
    const env = {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOCAL_ONLY: '1',
      SELF_TOKEN: TOKEN,
      REN_STATE_DIR: path.join(root, 'state'),
      WORKSPACE_DIR: path.join(root, 'ws'),
      AUDIT_DIR: path.join(root, 'audit'),
      INCIDENT_DIR: path.join(root, 'incident'),
      REPAIR_DIR: path.join(root, 'repair'),
      PROOF_DIR: path.join(root, 'proof'),
      TICKET_DIR: path.join(root, 'ticket'),
      BACKUP_DIR: path.join(root, 'bk')
    };
    if (dev) {
      env.REN_DEV_INSTANCE = '1';
      env.REN_DEV_ROOT = root;
    } else {
      delete env.REN_DEV_INSTANCE;
      delete env.REN_DEV_ROOT;
    }
    child = spawn(process.execPath, ['server.js'], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], env });
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
async function call(body) {
  const r = await fetch(`${BASE()}/api/self/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE() },
    body: JSON.stringify(body)
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}

try {
  console.log('[1] 生产实例：这条链路必须是关的');
  /* 关掉的原因要能看出来。403 会被读成「令牌没配好」，503 才是「这功能在这儿不开」。 */
  ok('起得来', await boot(false));
  {
    const r = await call({ action: 'list', token: TOKEN });
    ok('带对令牌也拒绝（503）', r.status === 503, r);
    ok('理由说清了「只在 dev 实例开」', /dev/.test(String(r.body && r.body.error)), r.body);
    const r2 = await call({ action: 'list', token: 'wrong-token-0123456789' });
    ok('错误令牌先被拒（403），不泄露这个实例是不是 dev', r2.status === 403, r2);
    const r3 = await call({ action: 'list' });
    ok('没有令牌 → 403', r3.status === 403, r3);
  }
  stop();

  console.log('\n[2] dev 实例：能进，但只做允许的动作');
  ok('dev 起得来（四个目录都在 dev 根下）', await boot(true));
  {
    /* 这一条同时验证「没被身份闸门挡住」：请求里没有任何登录凭证，
       能拿到 handler 的回答（403 令牌不对）就说明闸门放行了。 */
    const r0 = await call({ action: 'list', token: 'nope-nope-nope-nope' });
    ok('没登录态也能到 handler（令牌错 → 403）', r0.status === 403, r0);

    const r = await call({ action: 'list', token: TOKEN });
    ok('list 能跑', r.status === 200 && r.body.ok, r.body);
    ok('返回的是数组', Array.isArray(r.body.repairs), r.body);

    const bad = await call({ action: 'rm -rf /', token: TOKEN });
    ok('不认识的动作 → 400（不是「静默成功」）', bad.status === 400, bad);

    const noSig = await call({ action: 'begin', token: TOKEN });
    ok('begin 不给签名 → 拒绝', noSig.status === 409 && /sig|签名/.test(noSig.body.error), noSig.body);

    const fake = await call({ action: 'begin', token: TOKEN, sig: 'x'.repeat(40) });
    ok('编一个不存在的签名 → 拒绝（不许随便建分支改源码）',
      fake.status === 409 && /没有这张单子/.test(fake.body.error), fake.body);

    const noKey = await call({ action: 'read', token: TOKEN, path: 'lib/x.js' });
    ok('没 begin 就读 → 说清要先 begin', noKey.status === 409 && /begin/.test(noKey.body.error), noKey.body);

    const esc = await call({ action: 'write', token: TOKEN, id: 'k', path: '../x.js', content: 'x' });
    ok('写到工作区外 → 拒绝', esc.status === 409, esc.body);
  }

  console.log('\n[3] 审计：改源码这件事必须留痕');
  {
    /* 审计是「一个月后还能回答谁改了什么」的唯一来源。这里只验它落到了文件里，
       内容对不对由 lib/audit.js 自己的测试管。 */
    const root = path.join(TMP, 'dev-root', 'audit');
    let hit = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) {
          const t = fs.readFileSync(p, 'utf8');
          if (/"kind":"repair"/.test(t)) hit += t.split('\n').filter(l => /"kind":"repair"/.test(l)).length;
        }
      }
    };
    try { walk(root); } catch { /* 没有就算了，下面会红 */ }
    ok('审计里出现了 repair 记录', hit >= 3, { hit });
  }
} finally {
  stop();
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
