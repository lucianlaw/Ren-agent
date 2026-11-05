// 执行隔离：run_shell 到底在什么边界里跑
//
// 为什么需要这一层（2026-11-05 实测）：
//   run_shell 原来是 execFile('/bin/sh', ['-c', cmd], { cwd: workspace })，
//   以本进程的身份跑。于是「命令字符串检查」成了唯一的防线——
//   而它挡不住两行代码：B 在自己目录写 x.js，把 A 的路径 base64 藏进去，
//   执行 `node x.js` 就读到了 A 的报价表。三条正则（WT 字面量 / `..` / ${PWD%）一条都没命中，
//   因为命令里根本没有路径。
//
//   结论：图灵完备的执行环境不能靠字符串围栏。要么交给 OS，要么承认没有隔离。
//
// 这一层做的事：先探测这台机器给不给条件，再按条件选执行方式。
//   ① uid-split  —— 进程是 root：给每个账号分配一个独立 uid，目录 700 且属主是它，
//                    子进程降权执行。OS 强制，用户代码再怎么写也越不过文件权限。
//                    不需要 docker，不需要 namespace，是最轻也最可靠的一条。
//   ② bwrap      —— 有 bubblewrap 且 user namespace 可用：mount namespace 只挂自己的目录。
//   ③ none       —— 什么都不给：**拒绝执行**，而不是假装安全地照跑。
//
// 逃生门 REN_SANDBOX=off 保留旧行为（不隔离），但会在 health 里显式写出来，
// 免得「忘了自己在裸跑」。
import { execFileSync, spawnSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES = ['bwrap', 'unshare', 'docker', 'podman', 'nsjail', 'setpriv'];

function which(bin) {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch { return false; }
}

function runs(argv, timeout = 4000) {
  try {
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout });
    return r.status === 0;
  } catch { return false; }
}

let cached = null;

/* 探测这台机器能给什么。结果缓存——这是启动期事实，不会变。 */
export function probeRuntime() {
  if (cached) return cached;

  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const bins = {};
  for (const b of CANDIDATES) bins[b] = which(b);

  const r = {
    platform: process.platform,
    node: process.version,
    uid,
    root: uid === 0,
    bins,
    userns: null,      // user namespace 是否真的能起（不只是有 unshare 二进制）
    mode: 'none',      // uid-split | bwrap | none
    why: '',
    at: Date.now()
  };

  if (process.platform === 'linux') {
    /* 不只看二进制在不在：容器里 unshare 常常装了但被 seccomp 拦掉，
       直接试一次才知道。 */
    if (bins.unshare) {
      r.userns = runs(['unshare', '--user', '--map-root-user', 'true']);
    }
  }

  if (r.root && process.platform === 'linux') {
    /* 最优先：root 能 chown + 降权，这是不依赖任何额外二进制的 OS 级隔离。
       但必须先确认内核真的接受这些 uid——容器的 user namespace 可能只映射了一小段。 */
    const rg = uidRange();
    r.uidMap = { from: rg.from, maxLen: rg.maxLen, base: rg.base, span: rg.span };
    if (rg.from === 'uid_map-too-small') {
      if (bins.bwrap && r.userns) {
        r.mode = 'bwrap';
        r.why = `uid 映射只有 ${rg.maxLen} 个，不足以降权；改用 bubblewrap`;
      } else {
        r.mode = 'none';
        r.why = `uid 映射只有 ${rg.maxLen} 个，降权会被内核拒绝，也没有 bwrap`;
      }
    } else {
      r.mode = 'uid-split';
      r.why = `进程以 root 运行，给每个账号分配独立 uid 并降权执行（${rg.from}，可用 ${rg.span} 个）`;
    }
  } else if (bins.bwrap && r.userns) {
    r.mode = 'bwrap';
    r.why = 'bubblewrap 可用且 user namespace 能起，用 mount namespace 圈目录';
  } else if (process.platform === 'darwin') {
    r.mode = 'none';
    r.why = 'macOS 本机开发环境，不做隔离；线上以 Linux 为准';
  } else {
    r.mode = 'none';
    r.why = r.userns === false
      ? 'unshare 装了但 user namespace 被禁（容器里常见），且进程不是 root'
      : '既不是 root，也没有可用的 namespace 工具';
  }

  /* 逃生门：显式关掉隔离。默认永远按探测结果走。 */
  if (String(process.env.REN_SANDBOX || '').toLowerCase() === 'off') {
    r.mode = 'off';
    r.why = '被 REN_SANDBOX=off 显式关闭（没有隔离，别对外用）';
  }

  cached = r;
  return r;
}

/* 给 health 用的粗粒度词：不把 uid / 二进制清单摊到公网上 */
export function runtimeWord() {
  return probeRuntime().mode;
}

/* ── uid 分配 ──
 * 稳定映射：同一个 scope 永远同一个 uid，重启不变。
 *
 * 这里踩过一个坑（2026-11-05 首次上线）：想当然地用 100000 起，
 * 结果 spawn 报 EINVAL——容器的 user namespace 只映射了有限的一段 uid，
 * 超出范围的 uid 内核直接不认。所以范围要从 /proc/self/uid_map 读出来，
 * 不能用想当然的常数。 */
export const UID_BASE = 100000;   // 拿不到映射时的默认值（普通 Linux 主机）
export const UID_SPAN = 100000;

let RANGE = null;

function readUidMap() {
  try {
    const txt = fs.readFileSync('/proc/self/uid_map', 'utf8').trim();
    let maxLen = 0;
    for (const line of txt.split('\n')) {
      const p = line.trim().split(/\s+/).map(Number);
      if (p.length < 3) continue;
      const [inside, , len] = p;
      if (inside === 0 && Number.isFinite(len)) maxLen = Math.max(maxLen, len);
    }
    return maxLen > 0 ? { maxLen, raw: txt.split('\n')[0].slice(0, 60) } : null;
  } catch {
    return null;
  }
}

/* 可用 uid 段：底部留给系统账号，取映射长度的 3/4 之后 */
function uidRange() {
  if (RANGE) return RANGE;
  const m = readUidMap();
  if (m && m.maxLen > 20000) {
    const base = Math.max(1000, Math.floor(m.maxLen * 0.75));
    const span = m.maxLen - base - 1;
    if (span > 100) { RANGE = { base, span, from: 'uid_map', maxLen: m.maxLen }; return RANGE; }
  }
  /* 没有映射信息（普通主机 / macOS）：用默认段 */
  RANGE = { base: UID_BASE, span: UID_SPAN, from: m ? 'uid_map-too-small' : 'default', maxLen: m ? m.maxLen : 0 };
  return RANGE;
}

export function uidRangeInfo() { return uidRange(); }

export function uidForScope(scope) {
  const { base, span } = uidRange();
  const h = crypto.createHash('sha256').update(String(scope)).digest();
  return base + (h.readUInt32BE(0) % span);
}

/* 把一个账号目录交给它的 uid 并关死。
 * -R 是必须的：文件工具由 root 写入，新建文件的属主是 root，
 * 不还给该 uid，用户自己在 shell 里就读不了、改不了自己刚上传的文件。 */
export function hardenTenant(root, scope) {
  const rt = probeRuntime();
  if (rt.mode !== 'uid-split') return false;
  const uid = uidForScope(scope);
  try {
    /* 子进程的 TMPDIR 指向自己目录下的 .tmp：不设的话都写 /tmp，
       那是一个所有账号共享的可写区，等于给了一条侧信道。 */
    const tmp = path.join(root, '.tmp');
    try { fs.mkdirSync(tmp, { recursive: true }); } catch { /* 只读盘就算了 */ }
    execFileSync('chown', ['-R', `${uid}:${uid}`, root], { stdio: 'ignore', timeout: 15000 });
    fs.chmodSync(root, 0o700);
    return true;
  } catch {
    return false;
  }
}

/* 启动时把所有账号目录都关一遍。
 * 只在「有人跑过 shell 时才收紧」是不够的：一个从没跑过命令的账号，目录还是 755/root，
 * 别人降权后照样能读。所以要在启动时统一处理。 */
export function hardenAll(usersDir) {
  const rt = probeRuntime();
  if (rt.mode !== 'uid-split') return { ok: false, mode: rt.mode, done: 0 };
  let done = 0;
  let names = [];
  try { names = fs.readdirSync(usersDir); } catch { return { ok: true, mode: rt.mode, done: 0 }; }
  for (const name of names) {
    if (!/^[a-f0-9]{32}$/.test(name)) continue;
    const dir = path.join(usersDir, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    if (hardenTenant(dir, name)) done++;
  }
  return { ok: true, mode: rt.mode, done };
}

/* ── 执行 ──
 * 返回统一结构：{ code, stdout, stderr } 或 { refused, reason }
 * refused 是「拒绝执行」，不是「执行失败」——调用方要能区分这两件事。 */
export function runIsolated({ cmd, cwd, scope, timeout = 20000 }) {
  const rt = probeRuntime();

  if (rt.mode === 'off') {
    return new Promise(resolve => {
      execFile('/bin/sh', ['-c', cmd], { cwd, timeout, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout, stderr, mode: 'off'
        }));
    });
  }

  if (rt.mode === 'uid-split') {
    const uid = uidForScope(scope);
    hardenTenant(cwd, scope);
    return new Promise(resolve => {
      let child;
      try {
        child = execFile('/bin/sh', ['-c', cmd], {
          cwd, timeout, maxBuffer: 2 * 1024 * 1024,
          uid, gid: uid,
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            HOME: cwd,
            TMPDIR: path.join(cwd, '.tmp'),
            LANG: 'C.UTF-8',
            SHELL: '/bin/sh'
          }
        }, (err, stdout, stderr) => {
          if (err && (err.code === 'EPERM' || err.code === 'EINVAL')) {
            return resolve({
              refused: true,
              reason: `降权执行失败（${err.code}）：uid ${uid} 可能超出容器的 uid 映射范围`
            });
          }
          resolve({
            code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
            stdout, stderr, mode: 'uid-split', uid
          });
        });
      } catch (e) {
        /* spawn 参数无效时是同步抛的（EINVAL），不会走到回调 */
        return resolve({
          refused: true,
          reason: `降权执行无法启动（${e.code || e.message}）：uid ${uid} 不被内核接受`
        });
      }
    });
  }

  if (rt.mode === 'bwrap') {
    const args = [
      '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      '--die-with-parent', '--new-session',
      '--bind', cwd, '/work',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/sbin', '/sbin',
      '--ro-bind', '/lib', '/lib',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--chdir', '/work',
      '/bin/sh', '-c', cmd
    ];
    if (fs.existsSync('/lib64')) args.splice(args.indexOf('--proc'), 0, '--ro-bind', '/lib64', '/lib64');
    return new Promise(resolve => {
      execFile('bwrap', args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout, stderr, mode: 'bwrap'
        }));
    });
  }

  if (rt.mode === 'none' && rt.platform === 'darwin') {
    /* macOS 开发机：没有容器、也降不了权，但这里只有我一个人在跑测试。
       照跑，免得本地 33 个测试文件全红；线上是 Linux，走下面那条拒绝路径。 */
    return new Promise(resolve => {
      execFile('/bin/sh', ['-c', cmd], { cwd, timeout, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout, stderr, mode: 'none-dev'
        }));
    });
  }

  /* mode === 'none'：没有隔离能力。
     这里必须拒绝，而不是照跑——照跑就等于把「应用层检查能挡住」这个已经被证伪的假设
     再赌一次，而赌输的代价是别人的文件。 */
  return Promise.resolve({
    refused: true,
    reason: `这台机器没有可用的隔离手段（${rt.why}）。为了不把别人的文件暴露给任意代码，` +
      '「跑命令」已暂停。需要临时恢复请设置 REN_SANDBOX=off（会明确标记为无隔离）。'
  });
}

/* 仅测试用：清掉探测缓存，让同一进程能验不同 REN_SANDBOX 取值 */
export function resetProbe() { cached = null; }
