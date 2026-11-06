// 修复工作区：把「改」这一步关进一个 git worktree 里。
//
// 前四步（看得见 / dev 闸门 / 工单 / 自证）都是基础设施，缺的是中间那一段路：
// **它到底在哪改，改完怎么变成一张能复核的单子**。这一步补的就是这一段。
//
// 为什么不在原地改：
//   dev 实例跑的就是这份源码。让它原地改，等于一边跑一边换自己脚下的文件——
//   下一次 import 拿到的是半成品，进程可能直接崩，而崩掉之后连「刚才改了什么」
//   都重建不出来。worktree 是同一份历史、另一份工作区：改坏了删掉即可，
//   正在跑的那份一个字节没动。
//
// 为什么必须只在 dev 实例开：
//   这条链路能写源码、能建分支、能跑测试。挂在公网上就等于「谁拿到令牌谁改生产代码」。
//   部署包里没有 .git，本来也建不出 worktree——但那是巧合，不是判据。
//   判据写在这里：REN_DEV_INSTANCE=1 且绑回环，否则 503，并把理由讲清楚。
//
// 三个刻意的克制：
//   1. **没有 shell**。给了 shell，前面所有路径围栏都白做——一句 `cat` 就能读到任何东西。
//      跑测试由 prove 一步代劳，不需要通用命令执行。
//   2. **红线按文件 + 按代码块**双层挡。只按文件挡太粗（server.js 整份禁掉，大部分
//      bug 就都修不了），只按字符串挡太糙（server.js 里本来就写着 PUBLIC_API）。
//      所以：敏感文件整份禁；重要的围栏函数按「块的边界」判，改到块里就拒。
//   3. **它不能自己标 verified**。它只能交 fixed——复核这一档留给人。
//      允许它自证自己通过，等于把「谁来判断」也交出去了。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isTestEntry, ensureDir } from './testdir.js';

import { keyOf, claim, settle, getTicket, toTaskPrompt } from './ticket.js';
import { runProof, saveProof, loadProof } from './proof.js';
import { treeSrc, readSrc, grepSrc } from './selfsrc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* 被修的那份代码。默认是本目录的上一级；测试和 worktree 里跑时用 REPAIR_ROOT 指过去。 */
export const ROOT = process.env.REPAIR_ROOT
  ? path.resolve(process.env.REPAIR_ROOT)
  : path.resolve(__dirname, '..');

const DIR = ensureDir(process.env.REPAIR_DIR
  ? path.resolve(process.env.REPAIR_DIR)
  : (isTestEntry()
    ? path.join(os.tmpdir(), 'ren-repair-test')
    : path.join(ROOT, 'data', 'repair')));

try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 不可写就静默降级 */ }

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;
const MAX_BYTES = 2 * 1024 * 1024;

const clip = (s, n) => {
  const t = s == null ? '' : String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/* ── 能不能开 ──
   两层：dev 实例标记 + 回环绑定。第二层不是多余的——devinfo 在启动时就查过，
   但那是**启动时**的环境；这里再查一次当前环境，是为了让「有人临时把 HOST 改成
   0.0.0.0 重启」这件事在接口层面同样失效，而不是只靠启动闸门那一次。 */
export function available(env = process.env) {
  if (!/^(1|true|yes|on)$/i.test(String(env.REN_DEV_INSTANCE || ''))) {
    return {
      ok: false, code: 503,
      why: '修复工作区只在 dev 实例开（REN_DEV_INSTANCE=1）。'
        + '它能写源码、建分支、跑测试——放在生产上等于把「改代码」做成一个公开接口。'
        + '要用先 npm run dev。'
    };
  }
  const host = String(env.HOST || '');
  if (host && !LOOPBACK.test(host)) {
    return { ok: false, code: 503, why: `HOST=${host} 不是回环地址，修复工作区不开` };
  }
  return { ok: true };
}

/* ── 路径围栏 ──
   和 lib/tools.js 的 within() 是同一件事，但**不能复用**：
   那个函数判的是「用户工作区之内的相对路径」，靠 path.resolve 就够；
   这里还多一层符号链接——worktree 里放一个指向 /etc 的软链，
   resolve 之后仍然在 worktree 里面，真正跟过去时已经在外面了。
   所以对已存在的部分做一次 realpath 比对。 */
export const DENY_DIR = new Set(['.git', 'node_modules', 'data', 'workspace', '.ren-secrets', '.ren-state']);

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.css',
  '.py', '.sh', '.yml', '.yaml', '.sql'
]);

export function guardPath(root, rel, { mustExist = false } = {}) {
  const raw = String(rel == null ? '' : rel).replace(/\\/g, '/').trim();
  if (!raw) return { ok: false, why: '要给一个路径' };
  if (raw.includes('\0')) return { ok: false, why: '路径不合法' };
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) return { ok: false, why: '只收修复工作区内的相对路径' };

  const norm = path.normalize(raw).replace(/^(\.\/)+/, '');
  if (norm === '..' || norm.startsWith('../')) return { ok: false, why: '不能跳出修复工作区' };

  const parts = norm.split('/').filter(p => p && p !== '.');
  if (!parts.length) return { ok: false, why: '要给一个文件路径' };
  const denied = parts.find(p => DENY_DIR.has(p));
  if (denied) return { ok: false, why: `「${denied}」不在可改范围（修复工作区只碰源码）` };

  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, norm);
  if (!(abs === rootAbs || abs.startsWith(rootAbs + path.sep))) {
    return { ok: false, why: '不能跳出修复工作区' };
  }

  let realRoot = rootAbs;
  try { realRoot = fs.realpathSync(rootAbs); } catch { /* 目录不存在，按字面判 */ }

  let real = '';
  try {
    real = fs.realpathSync(abs);
  } catch {
    /* 文件还不存在（新建）：查它最近的那个已存在的父目录，
       父目录的真实位置还在工作区里才算放行。 */
    let p = path.dirname(abs);
    while (p.length > rootAbs.length && !fs.existsSync(p)) p = path.dirname(p);
    try { real = fs.realpathSync(p); } catch { real = realRoot; }
    if (mustExist) return { ok: false, why: '没有这个文件' };
  }
  if (!(real === realRoot || real.startsWith(realRoot + path.sep))) {
    return { ok: false, why: '这个路径是软链，指到工作区外面去了' };
  }
  return { ok: true, abs, rel: norm };
}

/* ── 红线 ──
   第一层：整份文件禁。这些文件改了，等于它有权决定「谁能干什么」，
   或者能伪造证据本身。它们的 bug 归人修——这也正是分诊协议里
   「它判我修」那一支的落点，不是漏洞。 */
export const BLOCK_FILE = new Map([
  ['lib/repair.js', '这条链路自己的闸门（改了它就能绕开下面所有限制）'],
  ['lib/proof.js', '证据的生产者（改了它就能造一份绿）'],
  ['lib/ticket.js', '工单状态机（改了它就能把 claimed 直接标成 verified）'],
  ['lib/selfsrc.js', '只读自审的边界'],
  ['lib/authn.js', '身份'],
  ['lib/identity.js', '身份'],
  ['lib/perms.js', '权限档位'],
  ['lib/quota.js', '计费'],
  ['lib/points.js', '积分'],
  ['lib/trash.js', '数据删除'],
  ['lib/purge.js', '数据删除'],
  ['lib/config.js', '密钥解析'],
  ['admins.json', '管理员名单']
]);

/* 第二层：整份文件不能禁（一个文件几百上千行，禁掉等于大部分 bug 都修不了），
   但里面有几个函数是围栏本身，改到它们所在的块就拒。
   块边界用的是「从这一行到下一个行首 `}`」——这个仓库的顶层函数都是这么收尾的，
   所以判得准，而且不需要真的解析 JS（真解析反而会被模板串里的花括号带偏）。 */
export const REGION = new Map([
  ['lib/tools.js', [
    { re: /^\s*function within\s*\(/, why: '路径围栏 within()' },
    { re: /^\s*function insideTenantBase\s*\(/, why: '租户边界 insideTenantBase()' },
    { re: /^\s*function tenantEscapeCmd\s*\(/, why: 'shell 租户边界 tenantEscapeCmd()' },
    { re: /^\s*function shellDenied\s*\(/, why: 'shell 黑名单入口 shellDenied()' },
    { re: /^const DENY_PATH\s*=/, why: '系统目录黑名单 DENY_PATH' },
    { re: /^const DENY\s*=\s*\[/, why: 'shell 黑名单 DENY' }
  ]],
  ['server.js', [
    { re: /^const PUBLIC_API\s*=/, why: '免登录边界 PUBLIC_API' },
    { re: /^const OPTIONAL_AUTH\s*=/, why: '可选身份边界 OPTIONAL_AUTH' },
    { re: /^\s*function adminOK\s*\(/, why: '运维鉴权 adminOK()' },
    { re: /^\s*function effectivePerms\s*\(/, why: '权限收紧入口 effectivePerms()' },
    { re: /^const INTERNAL\s*=/, why: '进程内调用凭证 INTERNAL' },
    { re: /^const isInternal\s*=/, why: '进程内调用判定 isInternal' }
  ]]
]);

/* ── diff 解析 ──
   要的是「**真的改了**哪几行」，不是 hunk 覆盖了哪几行。
   这个区别是踩出来的：一开始按 `@@ -a,b +c,d @@` 的范围判断，
   而 git 默认带 3 行上下文，于是「改一个离围栏 3 行以内的普通代码」
   也会被判成碰到了围栏——几乎等于整份文件禁掉。所以逐行数：
   只有 `+` / `-` 开头的行才算改动，上下文行不计。 */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function changedFiles(diffText) {
  const out = [];
  let cur = null;
  let oldNo = 0, newNo = 0, inHunk = false;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      cur = m ? { path: m[2], oldLines: new Set(), newLines: new Set() } : null;
      if (cur) out.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('deleted file mode')) { cur.deleted = true; continue; }
    const h = HUNK.exec(line);
    if (h) { oldNo = Number(h[1]); newNo = Number(h[3]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) { cur.newLines.add(newNo); newNo += 1; }
    else if (line.startsWith('-')) { cur.oldLines.add(oldNo); oldNo += 1; }
    else if (line.startsWith(' ') || line === '') { oldNo += 1; newNo += 1; }
    /* `\ No newline at end of file` 两边都不占行号 */
  }
  return out;
}

/* 块的边界：从锚点行到它对应的收尾行（行首 `}` 或 `]`）。
   两个细节，不做就会误伤：
     · 锚点是一行写完的（`const PUBLIC_API = new Set([...]);`），块就只有这一行——
       否则它会一路吃到文件里下一个行首 `}`，把几十行无关代码都算进块里，
       改哪儿都判红线，等于整份文件禁掉。
     · 收尾符按开头的括号定：`{` 配 `}`、`[` 配 `]`。只认 `}` 的话，
       `const DENY = [` 会找不到收尾而吃到文件尾。 */
export function blockRange(lines, i) {
  const head = String(lines[i] || '').trimEnd();
  const open = head.endsWith('{') ? '{' : head.endsWith('[') ? '[' : '';
  if (!open) return [i + 1, i + 1];
  const close = open === '{' ? /^\}/ : /^\]/;
  for (let j = i + 1; j < lines.length; j++) {
    if (close.test(lines[j])) return [i + 1, j + 1];
  }
  return [i + 1, i + 1];
}

function touches(file, start, end, coord) {
  const set = coord === 'old' ? file.oldLines : file.newLines;
  for (const n of set) if (n >= start && n <= end) return true;
  return false;
}

/* ── 红线判定 ──
   readOld / readNew 由调用方提供（一个读 git 里的旧版，一个读工作区的新版），
   这样这个函数可以脱离 git 单测——它是这一层最该被钉死的一段。 */
export function redFlags(diffText, readOld = () => '', readNew = () => '') {
  const out = [];
  for (const f of changedFiles(diffText)) {
    const why = BLOCK_FILE.get(f.path);
    if (why) { out.push({ file: f.path, why, line: '' }); continue; }
    if (f.deleted && f.path.startsWith('test/')) {
      out.push({ file: f.path, why: '删掉了一个已有的测试——那不是修好，是判据没了', line: '' });
      continue;
    }
    const rules = REGION.get(f.path);
    if (!rules) continue;
    const oldLines = String(readOld(f.path) || '').split('\n');
    const newLines = String(readNew(f.path) || '').split('\n');
    for (const rule of rules) {
      let hit = '';
      for (const [lines, coord] of [[oldLines, 'old'], [newLines, 'new']]) {
        for (let i = 0; i < lines.length && !hit; i++) {
          if (!rule.re.test(lines[i])) continue;
          const [a, b] = blockRange(lines, i);
          if (touches(f, a, b, coord)) hit = clip(lines[i].trim(), 120);
        }
        if (hit) break;
      }
      if (hit) out.push({ file: f.path, why: rule.why, line: hit });
    }
  }
  return out;
}

/* ── 子进程 ──
   全程 execFile + 异步：服务是单线程的，同步跑 git 会把所有用户的请求一起卡住。 */
function run(cmd, args, { cwd, timeout = 30000 } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : (err.killed ? 124 : 127);
      resolve({ code, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

function git(cwd, args, opts = {}) {
  /* 身份写死：修复工作区里的提交是**机器提交**，不该依赖开发机上的 git config。
     不加的话，没配 user.email 的机器上第一张单子就卡在「请告诉我是谁」。 */
  return run('git', ['-c', 'user.name=ren-repair', '-c', 'user.email=repair@ren',
    '-c', 'commit.gpgsign=false', ...args], { cwd, ...opts });
}

/* ── 状态 ──
   状态文件只记「这次修复的落点」：哪个分支、哪个目录、从哪个提交起。
   事实（次数、复现）在工单那边，这里不重复存——两处各存一份必然会不一致。 */
function fileOf(key) {
  return path.join(DIR, key + '.json');
}

export function load(key) {
  try {
    const o = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
    return o && o.key === key ? o : null;
  } catch {
    return null;
  }
}

function save(st) {
  try {
    const tmp = fileOf(st.key) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    fs.renameSync(tmp, fileOf(st.key));
    return true;
  } catch {
    return false;
  }
}

export function stateDir() {
  return DIR;
}

/* ── 每张单试过几次 ──
   这是分诊层要的判断依据：同一份代码 + 同一份上下文，第三次重试大概率还是同样的结果。
   一次 readdir 全读，不是每张单一次 readFile——分诊一次要看几百张。
   lastMs 取 created：那是「这次尝试开始的时间」，正是冷却期要算的东西。 */
export function attemptIndex() {
  const m = new Map();
  let names = [];
  try { names = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch { return m; }
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
      if (o && o.key) m.set(o.key, { n: o.attempt || 0, lastMs: Date.parse(o.created) || 0, status: o.status });
    } catch { /* 坏文件跳过 */ }
  }
  return m;
}

/* 清一条修复记录。只删状态文件，不碰 worktree——
   worktree 是 git 的东西，删它要走 `git worktree remove`，那是有副作用的动作，
   不该混在「清孤儿」里顺手做。目录还在就把它报回去，让调用方知道要手工收拾。 */
export function dropState(key) {
  const k = String(key || '').replace(/\.json$/, '').replace(/[^a-f0-9]/gi, '');
  if (!k) return { ok: false, error: '要 key' };
  let st = null;
  try { st = JSON.parse(fs.readFileSync(path.join(DIR, k + '.json'), 'utf8')); } catch { /* 没了就算了 */ }
  try {
    fs.unlinkSync(path.join(DIR, k + '.json'));
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? '没有这条修复记录' : e.message };
  }
  return { ok: true, key: k, worktreeLeft: st && st.dir && fs.existsSync(st.dir) ? st.dir : '' };
}

export function list() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
      if (o && o.key) {
        out.push({
          key: o.key, sig: o.sig, status: o.status, branch: o.branch, dir: o.dir,
          base: (o.base || '').slice(0, 7), created: o.created, by: o.by,
          test: o.test || '', submitted: o.submitted || '', note: o.note || '',
          attempt: o.attempt || 0
        });
      }
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

const brief = (st) => st && ({
  key: st.key, sig: st.sig, status: st.status, branch: st.branch,
  dir: st.dir, base: st.base, created: st.created, by: st.by,
  test: st.test || '', proofAt: st.proofAt || '', submitted: st.submitted || '',
  attempt: st.attempt || 0
});

function activeOf(key) {
  const st = load(key);
  if (!st) return { error: '这张单子还没开始修（先 begin）' };
  if (st.status === 'aborted') return { error: '这次修复已经中止了（再 begin 一次重开）', st };
  /* 交过单还允许继续改，等于「证据是真的，但它证明的不是这一版」——
     复核的人拿到的 patch 会和磁盘上那份悄悄分叉。 */
  if (st.status === 'submitted') {
    return { error: '这次修复已经交单了（fixed）。要再改，先 abort --force 重开一张——不能一边复核一边改', st };
  }
  return { st };
}

/* ── 开始 ──
   三件事：建 worktree、认下这张单子、把任务书一起给出去。
   第三件不是顺手给的——它把「边界」和「验收」前置，省掉一整轮「你还没告诉我改哪」。 */
export async function begin({ sig = '', by = '', env = process.env } = {}) {
  const av = available(env);
  if (!av.ok) return { ok: false, code: av.code, error: av.why };
  const s = String(sig || '').trim();
  if (!s) return { ok: false, error: '要给工单 sig 或 id' };

  const key = keyOf(s);
  const cur = load(key);
  if (cur && cur.status === 'active') {
    const t = getTicket(s);
    return { ok: true, reuse: true, ...brief(cur), task: t ? toTaskPrompt(t) : '' };
  }
  if (cur && cur.status === 'submitted') {
    return { ok: false, error: `这张单子已经交过修复了（${cur.branch}）。要重来先 abort --force` };
  }

  /* 单子必须真的存在。没有这一句，随便编一个 sig 就能开出一个分支去改源码——
     而「改源码的入口」不该由调用方决定目标是否存在。 */
  const t0 = getTicket(s);
  if (!t0) return { ok: false, error: '没有这张单子（签名不对，或已过保留期）' };
  if (t0.state === 'fixed' || t0.state === 'verified') {
    return { ok: false, error: `这张单子当前是 ${t0.state}，已经结算过了。复核不过的话先由人打回 claimed` };
  }
  if (t0.state === 'claimed' && t0.claimedBy && by && t0.claimedBy !== by) {
    return { ok: false, error: `这张单子已经被「${t0.claimedBy}」领了` };
  }

  /* 分支还在就拒：删掉它等于把上一次未合入的改动扔了。
     让人（或它自己）先明确 abort，比默默覆盖安全。 */
  const br = await git(ROOT, ['show-ref', '--verify', '--quiet', `refs/heads/heal/${key}`]);
  if (br.code === 0) {
    return { ok: false, error: `分支 heal/${key} 已经存在（上一次修复没清干净）。先 abort --force 再重来` };
  }

  const isRepo = await git(ROOT, ['rev-parse', '--git-dir']);
  if (isRepo.code !== 0) {
    return { ok: false, error: '源码目录不是 git 仓库（部署包里没有 .git），修复工作区建不起来——这也是它只能在 dev 实例用的原因之一' };
  }

  /* 脏工作区拒绝：base 必须是一个能指认的提交。
     不拒的话「修复前」到底是哪一版就说不清，红→绿也就没意义了。 */
  const dirty = await git(ROOT, ['status', '--porcelain']);
  if (dirty.code !== 0) return { ok: false, error: '读不到 git 状态' };
  if (dirty.out.trim()) {
    return {
      ok: false,
      error: '源码目录有未提交的改动，先提交或 stash，否则 base 指不到一个确定的版本',
      changed: dirty.out.trim().split('\n').slice(0, 10)
    };
  }

  const head = (await git(ROOT, ['rev-parse', 'HEAD'])).out.trim();
  if (!head) return { ok: false, error: '读不到 HEAD' };

  const dir = path.join(DIR, 'wt-' + key);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 残留目录先清掉 */ }

  const add = await git(ROOT, ['worktree', 'add', '-b', `heal/${key}`, dir, head]);
  if (add.code !== 0) {
    return { ok: false, error: `建修复工作区失败：${clip((add.err || add.out).trim(), 300)}` };
  }

  /* 认单。open → claimed；已经 claimed（同一个人）就继续，不用重复 claim。 */
  if (t0.state === 'open') {
    const c = claim(s, by || 'ren', Date.now());
    if (!c.ok) {
      await git(ROOT, ['worktree', 'remove', '--force', dir]);
      await git(ROOT, ['branch', '-D', `heal/${key}`]);
      return { ok: false, error: `领取失败：${c.error}` };
    }
  }

  const st = {
    key, sig: s, branch: `heal/${key}`, dir, base: head,
    status: 'active', by: clip(by || 'ren', 60),
    created: new Date().toISOString(), test: '',
    /* 第几次尝试。交单后会被下次 begin 覆盖，所以次数得自己往上数——
       分诊层靠它判断「这张已经试过三次，别再派了」。 */
    attempt: (cur && cur.attempt ? cur.attempt : 0) + 1
  };
  if (!save(st)) {
    await git(ROOT, ['worktree', 'remove', '--force', dir]);
    return { ok: false, error: '状态写不进去（磁盘？）' };
  }

  const t = getTicket(s);
  return {
    ok: true, ...brief(st),
    task: t ? toTaskPrompt(t) : '',
    red: {
      blocked: [...BLOCK_FILE.keys()],
      guarded: [...REGION.entries()].map(([f, rs]) => `${f}: ${rs.map(r => r.why).join('、')}`)
    }
  };
}

/* ── 读 ──
   三个只读动作直接复用 selfsrc：它就是为「把源码交给模型看」写的，
   SKIP_DIR / 凭据名单 / 文本扩展名那套边界已经在了，再写一份只会两边不一致。 */
export function tree({ key, dir = '' } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const r = treeSrc(dir, a.st.dir);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, output: r.text, count: r.count, more: r.more, dir: a.st.dir };
}

export function read({ key, path: rel, from, lines } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const g = guardPath(a.st.dir, rel, { mustExist: true });
  if (!g.ok) return { ok: false, error: g.why };
  const r = readSrc(g.rel, from, lines, a.st.dir);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, output: r.text, total: r.total, from: r.from, to: r.to, truncated: r.truncated };
}

export function grep({ key, q, glob } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const r = grepSrc(q, a.st.dir, { glob });
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, output: r.text, hits: r.hits, scanned: r.scanned, more: r.more };
}

/* ── 写 ──
   整篇覆盖和局部替换各一条。局部替换要求原文唯一——不唯一时宁可报错，
   也不要「猜一个位置改掉」：那会在没人注意的时候改错一处。
   （同一套语义在 lib/tools.js 的 edit_file 里也有，但那边是给用户工作区的，
   参数名和行为都更长；这里保持最小可用，不复用是为了不把用户侧的行为绑死。） */
export function writeFile({ key, path: rel, content } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const g = guardPath(a.st.dir, rel);
  if (!g.ok) return { ok: false, error: g.why };

  const blocked = BLOCK_FILE.get(g.rel);
  if (blocked) return { ok: false, error: `这个文件是红线：${blocked}。它的 bug 归人修——请只出分析，不要出补丁` };

  const ext = path.extname(g.abs).toLowerCase();
  if (!TEXT_EXT.has(ext)) return { ok: false, error: `只改文本类源码，${ext || '无扩展名'} 不支持` };

  const body = String(content == null ? '' : content);
  if (Buffer.byteLength(body) > MAX_BYTES) return { ok: false, error: '单个文件超过 2MB，改不了' };

  try {
    fs.mkdirSync(path.dirname(g.abs), { recursive: true });
    fs.writeFileSync(g.abs, body, 'utf8');
  } catch (e) {
    return { ok: false, error: `写不进去：${clip(e.message, 200)}` };
  }
  return { ok: true, path: g.rel, bytes: Buffer.byteLength(body) };
}

export function editFile({ key, path: rel, old: oldS, new: newS = '', all = false } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const g = guardPath(a.st.dir, rel, { mustExist: true });
  if (!g.ok) return { ok: false, error: g.why };

  const blocked = BLOCK_FILE.get(g.rel);
  if (blocked) return { ok: false, error: `这个文件是红线：${blocked}。它的 bug 归人修——请只出分析，不要出补丁` };

  const seek = String(oldS == null ? '' : oldS);
  if (!seek) return { ok: false, error: '要给 old（要被替换的原文）' };

  let text = '';
  try { text = fs.readFileSync(g.abs, 'utf8'); } catch { return { ok: false, error: '读不出来' }; }

  const parts = text.split(seek);
  const n = parts.length - 1;
  if (!n) return { ok: false, error: '原文没找到。要逐字一致（含缩进），或者先用 read 看一眼现在是什么样' };
  if (n > 1 && !all) {
    return { ok: false, error: `原文出现了 ${n} 次。把 old 前后多带几行让它唯一，或者显式 all:true 全部替换` };
  }

  const next = all ? parts.join(String(newS)) : text.replace(seek, () => String(newS));
  try { fs.writeFileSync(g.abs, next, 'utf8'); } catch (e) { return { ok: false, error: `写不进去：${clip(e.message, 200)}` }; }
  return { ok: true, path: g.rel, replaced: all ? n : 1 };
}

/* ── 暂存 ──
   算 diff 和做红线判定前必须先把新文件也纳入：`git diff` 看不见未跟踪的新文件，
   而回归测试恰恰通常是新文件——不 add 的话，红线判定会漏掉一整个新增的测试目录。 */
async function stage(st) {
  await git(st.dir, ['add', '-A']);
  const r = await git(st.dir, ['diff', '--cached', st.base]);
  return r.code === 0 ? r.out : '';
}

async function showAt(dir, rev, rel) {
  const r = await git(dir, ['show', `${rev}:${rel}`]);
  return r.code === 0 ? r.out : '';
}

function readNewIn(dir, rel) {
  try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; }
}

/* 红线判定要两版内容：旧版从 git 里取、新版从工作区读。
   旧版只对进了 REGION 的文件取（整棵取太贵），逐个 show 一次。 */
async function flagsOf(st, patch) {
  const files = changedFiles(patch).map(f => f.path);
  const needOld = files.filter(f => REGION.has(f));
  const map = new Map();
  for (const f of needOld) map.set(f, await showAt(st.dir, st.base, f));
  return redFlags(patch, rel => map.get(rel) || '', rel => readNewIn(st.dir, rel));
}

export async function diff({ key, full = false } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const st = a.st;
  const patch = await stage(st);
  const stat = (await git(st.dir, ['diff', '--cached', '--stat', st.base])).out.trim();
  return {
    ok: true, key, base: st.base, stat,
    files: changedFiles(patch).map(f => f.path),
    patch: full ? clip(patch, 120000) : clip(patch, 20000),
    patchBytes: Buffer.byteLength(patch),
    truncated: !full && Buffer.byteLength(patch) > 20000,
    redFlags: await flagsOf(st, patch)
  };
}

/* ── 提交 ──
   自证跑的是**提交**，不是工作区。所以「改完了」这一步在物理上就是一次 commit：
   没有哈希就没有「修复前/修复后」可比，红→绿也就无从谈起。 */
async function commitAll(st, note) {
  await git(st.dir, ['add', '-A']);
  const dirty = await git(st.dir, ['diff', '--cached', '--name-only']);
  if (!dirty.out.trim()) return { ok: true, sha: (await git(st.dir, ['rev-parse', 'HEAD'])).out.trim(), empty: true };
  const msg = clip(String(note || `fix(${st.key}): 修复工单 ${st.key}`), 200);
  const c = await git(st.dir, ['commit', '-m', msg, '--no-verify']);
  if (c.code !== 0) return { ok: false, error: `提交失败：${clip((c.err || c.out).trim(), 300)}` };
  return { ok: true, sha: (await git(st.dir, ['rev-parse', 'HEAD'])).out.trim() };
}

/* ── 自证 ──
   先把改动提交（没有提交就证明不了），再交给 lib/proof.js 那套「红→绿」。
   证明的根是**修复工作区**，不是生产那份——证明过程会建临时 worktree，
   在有未完成改动的工作区里建会互相干扰。 */
export async function prove({ key, test } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const st = a.st;
  if (!String(test || '').trim()) return { ok: false, error: '要给 test（例：test/foo-test.mjs）' };

  const patch = await stage(st);
  const flags = await flagsOf(st, patch);
  if (flags.length) {
    return {
      ok: false,
      error: '改动碰到红线，先撤掉再证明：' + flags.map(f => `${f.file}（${f.why}）`).join('；'),
      redFlags: flags
    };
  }

  const com = await commitAll(st, `fix(${key}): 修复工单 ${key}`);
  if (!com.ok) return com;

  const proof = await runProof({ root: st.dir, sig: st.sig, test, fix: com.sha, base: st.base });
  proof.key = key;
  saveProof({ ...proof, sig: st.sig });

  st.test = String(test);
  st.proofAt = new Date().toISOString();
  st.fix = com.sha;
  save(st);

  return { ok: proof.ok, proof, sha: com.sha };
}

/* ── 交单 ──
   顺序是刻意的：先看红线，再看证据，最后才动状态。
   反过来的话，一张被拒的单子已经变成 fixed 了，而「fixed 但没证据」正是最坏的状态：
   列表上看起来有人修过，实际什么都没验证。 */
export async function submit({ key, note = '', test = '' } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const st = a.st;
  if (!String(note).trim()) return { ok: false, error: '要给一句说明：改了什么、为什么。没有说明的「修好了」不可复核' };

  let proof = loadProof(st.sig);
  const head = (await git(st.dir, ['rev-parse', 'HEAD'])).out.trim();

  if (!proof || proof.fix !== head) {
    if (!String(test).trim() && !st.test) {
      return { ok: false, error: '还没有和当前提交对得上的自证。先 prove（带 --test）再交单' };
    }
    const p = await prove({ key, test: String(test).trim() || st.test });
    if (!p.ok) return { ok: false, error: p.error || `自证没通过：${(p.proof && p.proof.why) || '未知'}`, proof: p.proof, redFlags: p.redFlags };
    proof = p.proof;
  }

  /* 证据必须对得上这个提交：prove 之后又改了东西的话，那份绿证明的不是这一版。 */
  if (proof.fix !== head) {
    return { ok: false, error: '证据里的修复提交和当前 HEAD 不一致（prove 之后又改过），重跑一次 prove' };
  }
  if (!proof.ok) return { ok: false, error: `自证没通过：${proof.why || '红→绿 不成立'}`, proof };

  const patch = await stage(st);
  const flags = await flagsOf(st, patch);
  if (flags.length) {
    return {
      ok: false,
      error: '改动碰到红线，不能交单：' + flags.map(f => `${f.file}（${f.why}${f.line ? '：' + f.line : ''}）`).join('；'),
      redFlags: flags
    };
  }

  const r = settle(st.sig, { state: 'fixed', by: st.by, note }, Date.now());
  if (!r.ok) return { ok: false, error: r.error };

  st.status = 'submitted';
  st.submitted = new Date().toISOString();
  st.note = clip(note, 600);
  save(st);

  return {
    ok: true,
    key,
    branch: st.branch,
    base: st.base,
    fix: proof.fix,
    state: 'fixed',
    proof: { strong: proof.strong, test: proof.test, red: proof.red, green: proof.green, changedCount: proof.changedCount },
    stat: (await git(st.dir, ['diff', '--cached', '--stat', st.base])).out.trim(),
    patch: clip(patch, 60000),
    /* 复核这一档留给人：允许它自证自己通过，等于把「谁来判断」也交出去了。 */
    next: '这张单子现在是 fixed，不是 verified。复核由人做：看 patch + 自己再跑一遍 prove。'
  };
}

/* ── 中止 ──
   force 才删分支。默认只摘 worktree、留分支：分支里可能是还没合入的修复，
   删掉就是真丢了；而 worktree 只是个工作目录，删了不心疼。 */
export async function abort({ key, force = false } = {}) {
  const st = load(key);
  if (!st) return { ok: false, error: '没有这次修复' };
  await git(ROOT, ['worktree', 'remove', '--force', st.dir]);
  await git(ROOT, ['worktree', 'prune']);
  if (force) await git(ROOT, ['branch', '-D', st.branch]);

  /* 单子退回 open：claimed 状态下不能直接 open？可以（NEXT 里有）。
     不退回的话，这张单子会永远挂在「有人正在修」。 */
  if (st.status === 'active') settle(st.sig, { state: 'open', by: st.by, note: '中止修复' }, Date.now());

  st.status = 'aborted';
  st.aborted = new Date().toISOString();
  save(st);
  return { ok: true, key, branchKept: !force };
}

/* ── 撤销未提交的改动 ──
   只动 worktree，不动别的分支。改了十条路都走不通时，这比重开一张单便宜。 */
export async function revert({ key } = {}) {
  const a = activeOf(key);
  if (a.error) return { ok: false, error: a.error };
  const r = await git(a.st.dir, ['reset', '--hard', 'HEAD']);
  await git(a.st.dir, ['clean', '-fd']);
  if (r.code !== 0) return { ok: false, error: `撤不掉：${clip((r.err || r.out).trim(), 200)}` };
  return { ok: true, key };
}

export const __test = { DIR, ROOT, TEXT_EXT, HUNK };
