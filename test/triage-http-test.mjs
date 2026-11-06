/* 分诊的端到端：真的把服务起起来，打「这一轮该修哪张」
 *
 * 纯函数测试回答不了的三件事：
 *   1. 路由挂上了没有（挂错路径时 lib 照样全绿）
 *   2. 生产实例上它是不是真的关了（这是唯一会写源码的入口）
 *   3. 命令行那套参数能不能真的走通（--dry / --json / decisions）
 *
 * 用 REPAIR_ROOT 指向一个临时的 git 仓库：真开修会在那儿建分支，
 * 不能让它碰本项目的 .git。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
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

const TOKEN = 'triage-http-token-0123456789';
const KEY = 'triage-http-alerts-0123456789';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-http-'));
const REPO = path.join(TMP, 'repo');
let child = null;
let PORT = 0;

const git = (dir, ...args) => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim();

/* 一个干净的 git 仓库：begin 要求 base 能指认，脏工作区会被拒。 */
fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '-q');
git(REPO, 'config', 'user.email', 't@test');
git(REPO, 'config', 'user.name', 't');
fs.mkdirSync(path.join(REPO, 'lib'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'lib', 'x.js'), 'export function add(a, b) { return a + b; }\n');
fs.writeFileSync(path.join(REPO, '.gitignore'), 'data/\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-q', '-m', 'base');

function pickPort() { return 41000 + Math.floor(Math.random() * 3000); }

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
      ALERTS_KEY: KEY,
      REPAIR_ROOT: REPO,
      REN_STATE_DIR: path.join(root, 'state'),
      WORKSPACE_DIR: path.join(root, 'ws'),
      AUDIT_DIR: path.join(root, 'audit'),
      INCIDENT_DIR: path.join(root, 'incident'),
      REPAIR_DIR: path.join(root, 'repair'),
      PROOF_DIR: path.join(root, 'proof'),
      TICKET_DIR: path.join(root, 'ticket'),
      BACKUP_DIR: path.join(root, 'bk')
    };
    if (dev) { env.REN_DEV_INSTANCE = '1'; env.REN_DEV_ROOT = root; }
    else { delete env.REN_DEV_INSTANCE; delete env.REN_DEV_ROOT; }
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

/* 造一条 self 归属的报错，让分诊有事可派 */
async function seedIncident() {
  const r = await fetch(`${BASE()}/api/incident`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE() },
    body: JSON.stringify({
      code: 'E_UI_RENDER', route: '/app', where: 'renderList',
      msg: 'x is not a function', v: '0.0.0', commit: 'test',
      stack: ['at renderList (public/app.js:1:1)']
    })
  });
  return r.ok;
}

try {
  console.log('[1] 生产实例：分诊必须关着（它是唯一会写源码的入口）');
  ok('起得来', await boot(false));
  {
    const r = await call({ action: 'next', token: TOKEN });
    ok('带对令牌也拒绝（503）', r.status === 503, r);
    ok('理由说清「只在 dev 实例开」', /dev/.test(String(r.body && r.body.error)), r.body);
    const t = await call({ action: 'triage', token: TOKEN });
    ok('连「看看会选谁」也不给', t.status === 503, t);
    const r2 = await call({ action: 'next', token: 'wrong-token-0123456789' });
    ok('错误令牌先被拒（403），不泄露是不是 dev', r2.status === 403, r2);
  }
  stop();

  console.log('\n[2] dev 实例：分诊能跑，且没单子时明说「没有」');
  ok('dev 起得来', await boot(true));
  {
    const r = await call({ action: 'triage', token: TOKEN });
    ok('triage 200', r.status === 200 && r.body.ok, r.body);
    ok('没单子时 pick 为 null', r.body.pick === null, r.body.pick);
    ok('说明是没有单子，不是被挡掉', /还没有任何报错/.test(r.body.why || ''), r.body.why);
    ok('带回额度信息', !!r.body.budget && r.body.budget.limit === 5, r.body.budget);

    ok('能上报一条 self 归属的错', await seedIncident());
    const r2 = await call({ action: 'triage', token: TOKEN });
    ok('有单子后能选出它', !!r2.body.pick && r2.body.pick.code === 'E_UI_RENDER', r2.body.pick);
    ok('选了不等于开了：triage 不建分支', !git(REPO, 'branch', '--list').includes('heal/'));
  }

  console.log('\n[3] next --dry：给任务书，但不动仓库');
  {
    const before = git(REPO, 'branch', '--list').split('\n').filter(Boolean).length;
    const r = await call({ action: 'next', token: TOKEN, dryRun: true });
    ok('200', r.status === 200 && r.body.ok, r.body);
    ok('给出会派哪张', !!r.body.pick, r.body.pick);
    ok('给了任务书', /工单 /.test(r.body.task || ''), (r.body.task || '').slice(0, 60));
    ok('没建分支', git(REPO, 'branch', '--list').split('\n').filter(Boolean).length === before);
    ok('没建 worktree', !fs.existsSync(path.join(TMP, 'dev-root', 'repair', 'wt-' + r.body.pick.key)));
  }

  console.log('\n[4] next：真开一张');
  {
    const r = await call({ action: 'next', token: TOKEN, by: 'ren' });
    ok('200 且开成', r.status === 200 && r.body.ok && !!r.body.began, r.body.error || r.body);
    const b = r.body.began || {};
    ok('建了分支 heal/<key>', git(REPO, 'branch', '--list').includes(b.branch || 'x'), b.branch);
    ok('第 1 次尝试', b.attempt === 1, b.attempt);
    ok('回执带任务书', /工单 /.test(r.body.task || ''));

    const again = await call({ action: 'next', token: TOKEN });
    ok('紧接着再起 → 不建第二张', again.body.pick === null && !!again.body.resume, again.body.why);
    ok('理由说清会互相踩 worktree', /互相踩/.test(again.body.why || ''), again.body.why);
  }

  console.log('\n[5] 决策留痕：能回答「为什么这周一张都没修」');
  {
    const r = await call({ action: 'decisions', token: TOKEN, days: 7 });
    ok('200', r.status === 200 && r.body.ok, r.body);
    ok('统计里有轮次', r.body.stats.rounds >= 3, r.body.stats);
    ok('统计里数得出开成几张', r.body.stats.began >= 1, r.body.stats.began);
    ok('决策里有「只看不开」的那条', (r.body.decisions || []).some(d => d.dryRun === true));
    ok('每条决策都带时间', (r.body.decisions || []).every(d => !!d.at));
  }

  console.log('\n[6] health 里能看到分诊（不带令牌看不到）');
  {
    const pub = await (await fetch(`${BASE()}/api/health`)).json();
    ok('公开 health 不含 triage', pub.triage === undefined);
    const withKey = await (await fetch(`${BASE()}/api/health?key=${encodeURIComponent(KEY)}`)).json();
    ok('带 key 能看到', !!withKey.triage && typeof withKey.triage.rounds === 'number', withKey.triage);
  }
} finally {
  stop();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
