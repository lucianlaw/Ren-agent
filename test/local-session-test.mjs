/* 本地会话：dev 实例关掉身份校验之后，/api/session 还能不能给出一个身份
 *
 * 存在理由是一段真实的现场：`npm run dev` 起得来，浏览器打开却一直显示
 * 「登录态已失效（凭证过期）」，而同一时刻接口全是通的（authStats 里
 * rejected 一直涨、verified 始终 0）。
 *
 * 成因不是配置错，是两处口径不一致：
 *   - 闸门 resolveAuth 在 AUTH_MODE=off 时已经放行（uid 空、legacy）；
 *   - /api/session 却没有这个分支，仍然拿本地那张令牌去云端 whoami。
 * 而 dev 跑在 127.0.0.1，浏览器换到的令牌 client 就是 http://127.0.0.1:8090，
 * 它不属于本应用，问谁都是 invalid_grant——**凭证没有过期，是这里天生没有登录态**。
 *
 * 所以这个测试钉四件事：
 *   1. 关掉校验时 /api/session 要给得出身份，且 scope 是稳定的（不是每次随机）；
 *   2. 这个身份的 scope 由固定 uid 派生，写死期望值——否则本地目录会漂，
 *      表现是「昨天的工作区今天不见了」；
 *   3. ADMIN_DEV 只影响「是不是管理员」，不影响身份本身；
 *   4. strict（生产形态）一个字节都不能松：没有凭证就 401。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'local-session-'));
let child = null;
let PORT = 0;
let ROOT = '';

const LOCAL_UID = 'local-dev-0000000000';
/* 与 lib/identity.js 同一个算法：sha256('ren-scope-v1|' + uid) 取前 32 位。
   写死期望值是有意的——这个值一旦变了，等于所有本地工作区换了个目录。 */
const EXPECT_SCOPE = crypto.createHash('sha256').update(`ren-scope-v1|${LOCAL_UID}`).digest('hex').slice(0, 32);

const pickPort = () => 39500 + Math.floor(Math.random() * 3000);

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

/* 数据目录一律指到临时目录：这个测试要能反复跑，绝不能碰仓库里的 data/。 */
async function boot({ auth, admin }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    PORT = pickPort();
    ROOT = path.join(TMP, `${auth}-${admin ? 'admin' : 'plain'}-${attempt}`);
    const env = {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      REN_AUTH_MODE: auth,
      REN_STATE_DIR: path.join(ROOT, 'state'),
      WORKSPACE_DIR: path.join(ROOT, 'ws'),
      AUDIT_DIR: path.join(ROOT, 'audit'),
      INCIDENT_DIR: path.join(ROOT, 'incident'),
      REPAIR_DIR: path.join(ROOT, 'repair'),
      PROOF_DIR: path.join(ROOT, 'proof'),
      TICKET_DIR: path.join(ROOT, 'ticket'),
      BACKUP_DIR: path.join(ROOT, 'bk')
    };
    if (admin) env.ADMIN_DEV = '1';
    else delete env.ADMIN_DEV;
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

async function get(u) {
  const r = await fetch(`${BASE()}${u}`);
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}

try {
  console.log('[1] 关掉校验：/api/session 要给得出本地身份');
  ok('起得来', await boot({ auth: 'off', admin: true }));
  {
    const h = await get('/api/health');
    ok('health 说 auth=off', h.body && h.body.auth === 'off', h.body && h.body.auth);

    const s = await get('/api/session');
    ok('session 200（不是 401）', s.status === 200 && s.body.ok, s);
    ok('给的是本地身份', s.body.uid === LOCAL_UID, s.body.uid);
    ok('标的出来是本地（前端据此不再找人登录）', s.body.local === true, s.body);
    ok('scope 是 32 位十六进制', /^[a-f0-9]{32}$/.test(String(s.body.scope)), s.body.scope);
    ok('scope 由固定 uid 派生（写死期望值，防止本地目录漂移）', s.body.scope === EXPECT_SCOPE, s.body.scope);
    ok('fk 也给了（img/下载链接靠它，不能只给一半）', /^[a-f0-9]{32}$/.test(String(s.body.fk)), s.body.fk);
    ok('不再带 claimed/mismatch 那套排查字段', s.body.claimed === '' && s.body.mismatch === false, s.body);

    const again = await get('/api/session');
    ok('再问一次还是同一个 scope', again.body.scope === s.body.scope, [s.body.scope, again.body.scope]);

    const a = await get('/api/is-admin');
    ok('ADMIN_DEV=1 时是管理员', a.body && a.body.admin === true, a.body);
  }

  stop();
  console.log('\n[2] 关掉校验但不给管理员：身份照给，「是不是管理员」照拒');
  ok('起得来', await boot({ auth: 'off', admin: false }));
  {
    const s = await get('/api/session');
    ok('session 还是 200', s.status === 200 && s.body.ok, s);
    ok('scope 与上一轮一致（身份不随管理员开关变）', s.body.scope === EXPECT_SCOPE, s.body.scope);
    const a = await get('/api/is-admin');
    ok('不是管理员', a.body && a.body.admin === false, a.body);
  }

  stop();
  console.log('\n[3] strict（生产形态）：没有凭证仍然 401，一个字节都不松');
  ok('起得来', await boot({ auth: 'strict', admin: true }));
  {
    const h = await get('/api/health');
    ok('health 说 auth=strict', h.body && h.body.auth === 'strict', h.body && h.body.auth);

    const s = await get('/api/session');
    ok('session 401', s.status === 401, s.status);
    ok('理由是没有凭证，不是「已登录」', s.body && s.body.code === 'no_token', s.body && s.body.code);
    ok('没把本地身份漏给严格模式', s.body && !s.body.uid, s.body);
  }
} finally {
  stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
