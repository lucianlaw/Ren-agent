/* 修复工具：真的把服务起起来打一遍
 *
 * 纯函数测试（repairkit-test）只能证明「定义对、参数翻译对」。它证明不了三件事：
 *   1. 这五个工具是不是真的出现在 /api/tooldefs 里——它不出现，模型永远不会调；
 *   2. /api/tool 是不是真的把它们分派到了修复分支——分派错了会报「未知工具」；
 *   3. 生产实例上是不是真的没有——多给一个能改源码的入口，前面所有闸都白做。
 * 少任何一条，单测照样全绿，而这条链路一次也走不通。
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repairkit-http-'));
let child = null;
let PORT = 0;
let ROOT = '';
const SCOPE = '0123456789abcdef0123456789abcdef';

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

/* dev 的数据目录必须逐个显式指到 dev 根下（lib/devinfo.js 的启动闸门要求的）。
   这里顺手把生产形态也指向临时目录——测试绝不能写到仓库的 data/ 里。 */
async function boot({ dev, admin }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    PORT = pickPort();
    ROOT = path.join(TMP, `${dev ? 'dev' : 'prod'}-${admin ? 'admin' : 'plain'}-${attempt}`);
    const env = {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOCAL_ONLY: '1',
      /* 身份走逃生门：这个测试要验的是「谁能看到修复工具」，
         不是「云端验签通不通」——后者有 authn-test 管。
         不关掉的话，任何请求都拿不到 uid，全部卡在 401，这一层的判定就测不到。 */
      REN_AUTH_MODE: 'off',
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
    if (dev) {
      env.REN_DEV_INSTANCE = '1';
      env.REN_DEV_ROOT = ROOT;
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

async function get(u) {
  const r = await fetch(`${BASE()}${u}`);
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}

async function call(name, args) {
  const r = await fetch(`${BASE()}/api/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE() },
    body: JSON.stringify({ scope: SCOPE, name, args: args || {} })
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: j };
}

const kitOf = (body) => ((body && body.tools) || [])
  .map(t => (t.function && t.function.name) || '')
  .filter(n => n.startsWith('repair_'));

try {
  console.log('[1] 维护者 + dev 实例：五个工具要在清单里');
  ok('起得来', await boot({ dev: true, admin: true }));
  {
    const r = await get('/api/tooldefs');
    ok('tooldefs 200', r.status === 200 && r.body.ok, r.body);
    const kit = kitOf(r.body);
    ok('五个都在', kit.length === 5, kit);
    ok('清单里标了 repairKit', r.body.repairKit === true, r.body.repairKit);
    ok('分类是 none（前端不要拿工作区四类开关去拦）', r.body.categories.repair_queue === 'none', r.body.categories.repair_queue);
    /* 普通工具没被顶掉：加工具时最容易犯的错是 concat 错了对象 */
    const all = (r.body.tools || []).map(t => t.function.name);
    ok('普通工具还在（edit_file / run_shell）', all.includes('edit_file') && all.includes('run_shell'), all.length);

    console.log('\n[2] /api/tool 真的分派到修复分支');
    const q = await call('repair_queue', {});
    ok('repair_queue 200', q.status === 200, q);
    ok('回执 ok', q.body && q.body.result && q.body.result.ok === true, q.body);
    /* 这一步故意不给它任何工单：回执应该是「没得修」或「有一张在修」，
       而不是报错。空表也不是故障。 */
    ok('给了人能读的 output', typeof (q.body.result || {}).output === 'string' && q.body.result.output.length > 10, q.body);

    const b = await call('repair_begin', { dry: true });
    ok('repair_begin dry 200', b.status === 200, b);
    const out = String((b.body.result || {}).output || '');
    ok('dry 回执里没有 undefined', !/undefined/.test(out), out.slice(0, 200));
    /* 临时库是空的，所以这里会走「这一轮没得修」——那也是对的。
       要验的是「它没有假装开好了」：要么说没得修，要么说仓库没动。 */
    ok('dry 没有假装开好（说了没得修 / 没动）', /没得修|没动|没有可开的/.test(out), out.slice(0, 200));
    /* dry 真的没建 worktree：这条比回执文本重要得多。
       「说是只看看」和「实际只看看」是两回事。 */
    let wt = [];
    try { wt = fs.readdirSync(path.join(ROOT, 'repair')).filter(f => f.startsWith('wt-')); } catch { /* 目录可能还没建 */ }
    ok('dry 没建出 worktree', wt.length === 0, wt);

    console.log('\n[3] 工具层的拒绝不该变成 HTTP 错误');
    const l = await call('repair_look', {});
    ok('缺 key → HTTP 200（模型要能读到原因，不是 4xx 断掉）', l.status === 200, l.status);
    ok('缺 key → result.ok=false', l.body && l.body.result && l.body.result.ok === false, l.body);
    ok('缺 key → output 里说了要 key', /key/.test(String((l.body.result || {}).output || '')), l.body);

    const u = await call('repair_change', { key: 'aaaaaaaaaaaaaaaa', action: '瞎写' });
    ok('未知 action → 200 + ok:false', u.status === 200 && u.body.result.ok === false, u.body);

    /* 回归：普通工具没被这里的改动带坏。未知名字仍然要报「未知工具」，
       而不是被当成修复工具拐走——那会让「工具名打错」变成「修复工作区出错」。 */
    const bad = await call('no_such_tool', {});
    ok('未知工具仍然 400', bad.status === 400, bad);
    ok('报错说的是「未知工具」', /未知工具/.test(String((bad.body || {}).error || '')), bad.body);

    console.log('\n[4] 改源码这件事留痕了没有');
    {
      let hit = 0;
      const walk = (d) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.jsonl')) {
            const t = fs.readFileSync(p, 'utf8');
            hit += t.split('\n').filter(x => /"kind":"repair"/.test(x)).length;
          }
        }
      };
      walk(path.join(ROOT, 'audit'));
      ok('审计里出现了 repair 记录', hit >= 2, { hit });
    }
  }
  stop();

  console.log('\n[5] dev 实例但不是维护者：工具根本不该出现');
  ok('起得来', await boot({ dev: true, admin: false }));
  {
    const r = await get('/api/tooldefs');
    ok('tooldefs 200（不报错，只是没有那五个）', r.status === 200 && r.body.ok, r.status);
    ok('清单里没有修复工具', kitOf(r.body).length === 0, kitOf(r.body));
    ok('repairKit 标成 false', r.body.repairKit === false, r.body.repairKit);

    const q = await call('repair_queue', {});
    /* 403 而不是 404：404 会被读成「这个功能不存在 / 版本没上」，
       而实际是「这个入口不对你开」。 */
    ok('直接调 → 403', q.status === 403, q);
    ok('理由是账号归属', /维护者/.test(String((q.body || {}).error || '')), q.body);
  }
  stop();

  console.log('\n[6] 生产实例：连工具都不存在');
  ok('起得来', await boot({ dev: false, admin: true }));
  {
    const r = await get('/api/tooldefs');
    ok('tooldefs 200', r.status === 200 && r.body.ok, r.status);
    ok('生产清单里没有修复工具（哪怕调用者是管理员）', kitOf(r.body).length === 0, kitOf(r.body));

    const q = await call('repair_queue', {});
    /* 503 而不是 403：403 会被读成「令牌/权限没配好」，而这里是
       「这个实例不该有这个能力」——理由完全不同，处置也不同。 */
    ok('直接调 → 503', q.status === 503, q);
    ok('理由说的是 dev 实例', /dev/.test(String((q.body || {}).error || '')), q.body);
  }
} finally {
  stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清不掉不影响结论 */ }
}

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
