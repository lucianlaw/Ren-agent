// 自证：不接受「我修好了」，只接受「同一份测试，旧代码上红、新代码上绿」。
//
// 为什么不能只看 agent 贴的终端输出：那段文字是它自己写的。它完全可能
// 在旧代码上跑了个不相干的测试、或者把失败的说成成功、或者「红」其实是
// 模块不存在（这只能证明功能原来没有，不能证明 bug 原来存在）。
// 所以我们自己跑：
//   1. 建两个临时 worktree —— 一个在修复提交的父提交上，一个在修复提交上。
//      用 worktree 而不是 checkout，因为前者不动当前工作区：证明过程不能
//      把正在跑的服务脚下的文件换掉。
//   2. 把**修复提交里的那份测试**拷到旧代码上。回归测试通常是新增文件，
//      旧代码里没有它；但「红」必须来自同一份判据，否则新旧两次跑的不是
//      同一个东西，也就谈不上「红变绿」。
//   3. 旧代码上跑 → 必须失败；新代码上跑 → 必须通过且 0 失败。
//
// 三个必须挡住的假绿（每一种都真的会有人这么干）：
//   · 把测试删了 → 文件在新提交里不存在，第一步就拒（test-exists）
//   · 把测试掏空成一行 console.log → 绿里没有汇总行，判 silent 不算过
//   · 让旧代码也能过（写了个测不到 bug 的测试）→ 红这一关过不去
//   · 修复提交和父提交代码一模一样 → diff 为空，直接拒（diff-not-empty）
//
// 还有一条「强红/弱红」的区分，是这一层最要紧的判断：
//   assert = 测试跑完了、断言失败。这是真红：bug 当时确实在。
//   load   = 测试根本没跑起来（模块不存在/语法错误）。这只是「东西原来没有」。
// 两者都算「红」，但可信度差一档。所以证据里记 red.kind，
// 而「复核通过」那一档要求强红 —— 否则以后所有新功能都能自称修了个 bug。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTestEntry, ensureDir } from './testdir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/* 默认就在本仓库上证明。PROOF_ROOT 是给两件事用的：
   测试（在临时仓库上验，不碰真仓库）和 dev 实例（证明它自己那份代码）。 */
const ROOT = process.env.PROOF_ROOT
  ? path.resolve(process.env.PROOF_ROOT)
  : path.resolve(__dirname, '..');

/* 目录落点：显式 PROOF_DIR > 测试兜底 > <ROOT>/data/proofs。
   测试兜底那一条见 lib/testdir.js——没有它，任何一个跑到证明路径的测试
   都会往真实的 data/proofs 里写证据。 */
const DIR = ensureDir(process.env.PROOF_DIR
  ? path.resolve(process.env.PROOF_DIR)
  : (isTestEntry()
    ? path.join(os.tmpdir(), 'ren-proofs-test')
    : path.join(ROOT, 'data', 'proofs')));

/* 只收 test/ 下的 .mjs。不收 `--require`、不收绝对路径、不收 ..，
   因为这个参数最终会变成一次子进程调用。 */
export const TEST_RE = /^test\/[A-Za-z0-9._-]+\.mjs$/;

const COUNT_RE = /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/;

const clip = (s, n) => {
  const t = s == null ? '' : String(s);
  return t.length > n ? t.slice(0, n) + '…' : t;
};

export function checkTestPath(p) {
  if (typeof p !== 'string' || !p.trim()) {
    return { ok: false, why: '要给测试文件（例：test/foo-test.mjs）' };
  }
  const t = p.trim().replace(/^\.\//, '');
  if (t.includes('..') || t.startsWith('/') || t.includes('\\')) {
    return { ok: false, why: '测试路径只能是 test/ 下的相对路径' };
  }
  if (!TEST_RE.test(t)) {
    return { ok: false, why: `只收 test/xxx.mjs 这种形式，收到的是「${clip(t, 80)}」` };
  }
  return { ok: true, path: t };
}

/* 汇总行是「这个测试真的跑完了」的凭证。
   没有它，退出码 0 可能只是「什么都没跑」。 */
export function parseSummary(s) {
  const m = COUNT_RE.exec(String(s || ''));
  return m ? { pass: Number(m[1]), fail: Number(m[2]) } : null;
}

export function classify(exitCode, out, err) {
  const s = String(out || '') + '\n' + String(err || '');
  const sum = parseSummary(s);
  if (exitCode === 0) {
    if (sum && sum.fail === 0) return { kind: 'pass', pass: sum.pass, fail: sum.fail };
    /* 退出码 0 但没打汇总行：可能是空测试，也可能是它自己 process.exit(0)。
       一律不算过 —— 这正是「掏空测试」最常见的形态。 */
    return { kind: 'silent', pass: sum ? sum.pass : 0, fail: sum ? sum.fail : 0 };
  }
  if (sum && sum.fail > 0) return { kind: 'assert', pass: sum.pass, fail: sum.fail };
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_DIR_IMPORT|Cannot find package/.test(s)) {
    return { kind: 'load' };
  }
  if (/SyntaxError/.test(s)) return { kind: 'load' };
  if (/\bENOENT\b/.test(s)) return { kind: 'missing' };
  return { kind: 'crash' };
}

/* 子进程环境要洗一遍。
   证明脚本是在服务进程里跑的，而服务进程身上挂着 REN_STATE_DIR / AUDIT_DIR /
   TICKET_DIR 这些指向**生产数据**的变量；被测测试如果偷懒读了它们，
   一次「证明」就会往真实数据里写东西。宁可让测试因为缺变量自己报错，
   也不要让它们在真实数据上「跑通」。 */
const DROP_ENV = [
  'PORT', 'HOST', 'ADMIN_KEY', 'ALERTS_KEY', 'LOCAL_ONLY', 'REN_DEV_INSTANCE', 'REN_DEV_ROOT',
  'WORKSPACE_DIR', 'REN_STATE_DIR', 'AUDIT_DIR', 'INCIDENT_DIR', 'TICKET_DIR', 'PROOF_DIR', 'PROOF_ROOT',
  'REN_BACKUP_DIR', 'REN_BACKUP_PASSPHRASE', 'CLOUD_BACKUP'
];

function cleanEnv() {
  const e = { ...process.env };
  for (const k of DROP_ENV) delete e[k];
  for (const k of Object.keys(e)) if (/^REN_/.test(k)) delete e[k];
  e.REN_PROOF = '1';
  e.NO_COLOR = '1';
  return e;
}

function run(cmd, args, { cwd, timeout = 30000, env } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, {
      cwd,
      timeout,
      maxBuffer: 8 << 20,
      encoding: 'utf8',
      env: env || cleanEnv()
    }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === 'number' ? err.code : (err.killed ? 124 : 127);
      resolve({
        code,
        killed: !!(err && err.killed),
        out: String(stdout || ''),
        err: String(stderr || '')
      });
    });
  });
}

/* 有些文件是构建产物、被 git 忽略，但测试会读——build.json 就是。
   在 worktree 里它们不存在，测试一读就 ENOENT，分类器只能报 crash，
   看上去像代码坏了，实际是环境不完整。这一步补上。

   注意是**按那个提交重新生成**，不是把当前那份拷过去：拷过去会写着
   别的版本号和别的提交号，测试拿它做断言就会得出荒谬结论（比如
   「0.8.9 的代码配 0.8.12 的 build.json，版本一致性检查居然通过」）。

   只补这一个，并且记进证据（seeded），让复核的人知道有东西是造出来的。 */
function seedBuildJson(dir, rev) {
  const bj = path.join(dir, 'build.json');
  if (fs.existsSync(bj)) return '';
  let ver;
  try {
    ver = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return '';      /* 没有 package.json 就别造，造了反而误导 */
  }
  if (!ver) return '';
  fs.writeFileSync(bj, JSON.stringify({
    version: ver,
    commit: String(rev).slice(0, 7),
    dirty: false,
    generatedBy: 'proof',
    at: new Date().toISOString()
  }, null, 2) + '\n');
  return 'build.json';
}

async function git(root, args, opts = {}) {
  return run('git', args, { cwd: root, ...opts });
}

/* 弱红的三种说法不能混成一句。它们的可信度其实不一样：
     load    = 模块不存在 → 这个能力原来确实没有（新功能正常，修 bug 不合格）
     missing = 文件都没有 → 同上，但更粗
     crash   = 跑到一半崩了 → **什么也说明不了**：可能是缺模块，也可能是测试自己写错了。
   混成一句「都只是证明原来没有」会让人以为 crash 也算数，那是最坏的一种安慰。 */
function weakWhy(red) {
  if (red.kind === 'assert') return `断言失败 ${red.fail} 项`;
  if (red.kind === 'load') return '红的原因不是断言失败，而是「模块不存在」——只证明这东西原来没有，不证明当时是坏的';
  if (red.kind === 'missing') return '红的原因是「文件都没有」——同上，而且更粗';
  if (red.kind === 'crash') return '红的原因是「测试没跑完就崩了」——既可能是缺模块，也可能是测试自己写错了；这条什么也证明不了，要重写成断言失败';
  return `红的原因不明（${red.kind}）`;
}

async function gitMust(root, args, why) {
  const r = await git(root, args);
  if (r.code !== 0) {
    throw new Error(`${why}：git ${args.join(' ')} → ${clip((r.err || r.out).trim(), 200)}`);
  }
  return r.out.trim();
}

/* ── 主流程 ──
   全程 async：服务是单线程的，跑证明时不能把整个事件循环堵死，
   否则证明期间所有用户的请求一起卡住——修 bug 的动作本身就是一次故障。 */
export async function runProof({
  root = ROOT,
  sig = '',
  test,
  fix = 'HEAD',
  base = '',
  timeoutMs = 180000
} = {}) {
  const t0 = Date.now();
  const checks = [];
  /* gate = 必过项；非 gate 的是**分档项**，用来区分强红/弱红，不单独否决。
     分开的理由：弱红（旧代码上模块不存在）对「新功能」是正常的，
     对「修 bug」是不合格的。同一份证据在两种场景下结论不同，
     所以这里只记事实，谁能不能用由结算那一层按状态决定。 */
  const add = (id, ok, detail = '', gate = true) => {
    checks.push({ id, ok: !!ok, gate, detail });
    return !!ok;
  };

  const bail = (id, why) => {
    add(id, false, why);
    return {
      ok: false, sig, test: String(test || ''), checks,
      why, ms: Date.now() - t0, at: new Date().toISOString()
    };
  };

  /* 路径先卡死，再谈别的 */
  const tp = checkTestPath(test);
  if (!tp.ok) return bail('test-path', tp.why);
  const testRel = tp.path;

  /* 部署目录里通常没有 .git（发布是拷文件）。没有历史就没有「修复前」，
     这种地方跑不了证明——明说，而不是给一个假的绿。 */
  const gitDir = await git(root, ['rev-parse', '--git-dir']);
  if (gitDir.code !== 0) {
    return bail('git-repo', '这个目录不是 git 仓库（部署包里通常没有 .git），自证要在开发机上跑');
  }

  const fixSha = (await git(root, ['rev-parse', '--verify', `${fix}^{commit}`]));
  if (fixSha.code !== 0) return bail('fix-commit', `找不到修复提交「${clip(fix, 60)}」`);
  const fixHash = fixSha.out.trim();

  /* 修复前那一版：默认取第一个父提交。 */
  let baseHash = '';
  if (base) {
    const b = await git(root, ['rev-parse', '--verify', `${base}^{commit}`]);
    if (b.code !== 0) return bail('base-commit', `找不到基线提交「${clip(base, 60)}」`);
    baseHash = b.out.trim();
  } else {
    const b = await git(root, ['rev-parse', '--verify', `${fixHash}^`]);
    if (b.code !== 0) return bail('base-commit', '这个提交没有父提交，没有「修复前」可比');
    baseHash = b.out.trim();
  }

  if (baseHash === fixHash) return bail('base-commit', '修复提交和基线是同一个提交');

  /* 测试必须在修复提交里存在 */
  const hasTest = await git(root, ['cat-file', '-e', `${fixHash}:${testRel}`]);
  if (hasTest.code !== 0) {
    return bail('test-exists', `修复提交里没有 ${testRel}（先把回归测试提交上去）`);
  }

  /* 两边代码必须有差异。一样的话，「绿」只是「什么都没改，跑了两遍」。 */
  const diff = await git(root, ['diff', '--name-only', baseHash, fixHash]);
  if (diff.code !== 0) return bail('diff-not-empty', '算不出两个提交的差异');
  const changed = diff.out.trim().split('\n').map(s => s.trim()).filter(Boolean);
  if (!add('diff-not-empty', changed.length > 0, changed.length ? `${changed.length} 个文件变动` : '两个提交一模一样')) {
    return { ok: false, sig, test: testRel, base: baseHash, fix: fixHash, checks, why: '修复提交和父提交的代码完全一样，没有可验证的修复', ms: Date.now() - t0, at: new Date().toISOString() };
  }

  /* 测试内容取修复提交里的那一份，算个指纹留证：
     事后有人换了测试，指纹对不上，这份证据就作废。 */
  const src = await git(root, ['show', `${fixHash}:${testRel}`], { timeout: 30000 });
  if (src.code !== 0) return bail('test-exists', `取不出 ${testRel} 的内容`);
  const testSrc = src.out;
  const testSha = crypto.createHash('sha256').update(testSrc).digest('hex');
  const baseHas = await git(root, ['cat-file', '-e', `${baseHash}:${testRel}`]);
  const testIsNew = baseHas.code !== 0;
  add('test-exists', true, `${testRel}（${testIsNew ? '本次新增' : '已存在，跑的是旧版'}）`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-proof-'));
  const dirBase = path.join(tmp, 'base');
  const dirFix = path.join(tmp, 'fix');
  const made = [];
  const seeded = [];

  try {
    for (const [dir, rev, label] of [[dirBase, baseHash, '基线'], [dirFix, fixHash, '修复']]) {
      const r = await git(root, ['-c', 'advice.detachedHead=false', 'worktree', 'add', '--detach', dir, rev], { timeout: 60000 });
      if (r.code !== 0) {
        return bail('worktree', `检出${label}版失败：${clip((r.err || r.out).trim(), 200)}`);
      }
      made.push(dir);
      /* 零依赖项目也一并接上：以后加了依赖，worktree 里不会凭空缺 node_modules */
      const nm = path.join(root, 'node_modules');
      if (fs.existsSync(nm) && !fs.existsSync(path.join(dir, 'node_modules'))) {
        try { fs.symlinkSync(nm, path.join(dir, 'node_modules'), 'dir'); } catch { /* 不行就算了 */ }
      }
      const s = seedBuildJson(dir, rev);
      if (s && !seeded.includes(s)) seeded.push(s);
    }
    /* 造出来的东西必须让人看见：否则复核时「测试读的那些文件哪来的」会成为一个谜。 */
    add('worktree-seeded', true,
      seeded.length ? `补了构建产物 ${seeded.join('、')}（按各自提交生成，不是拷贝）` : '没有需要补的文件');

    /* 把修复提交里的那份测试，原样铺到旧代码上。
       这是整件事的关键一步：新旧两次跑的必须是同一个判据。 */
    const dst = path.join(dirBase, testRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, testSrc);
    add('test-copied', true, `已把 ${testRel} 铺到基线版（${Buffer.byteLength(testSrc)} 字节）`);

    const runOne = async (dir) => {
      const r = await run(process.execPath, ['--no-warnings', testRel], {
        cwd: dir,
        timeout: timeoutMs,
        env: cleanEnv()
      });
      const c = classify(r.code, r.out, r.err);
      return {
        exit: r.code,
        killed: r.killed,
        kind: c.kind,
        pass: c.pass || 0,
        fail: c.fail || 0,
        tail: clip((r.out + (r.err ? '\n' + r.err : '')).trim(), 4000)
      };
    };

    const red = await runOne(dirBase);
    const green = await runOne(dirFix);

    /* 红：必须真的跑起来并失败。 */
    add('red-fails', red.exit !== 0, red.exit === 0 ? '旧代码上测试居然通过了 —— 这个测试测不到 bug' : `退出码 ${red.exit}`);
    add('red-is-assertion', red.kind === 'assert', weakWhy(red), false);   /* 分档项：不算否决，但决定能不能标 verified */

    /* 绿：必须通过，且 0 失败，且打了汇总行（证明它真跑了）。 */
    add('green-passes', green.kind === 'pass',
      green.kind === 'pass' ? `${green.pass} 项通过、0 失败`
        : green.kind === 'silent' ? '退出码 0 但没有汇总行：测试可能没真跑（或已被掏空）'
          : `新代码上仍然失败（${green.kind}，失败 ${green.fail} 项）`);

    /* 绿不能比红「更弱」：修完之后通过的断言数，至少不能少于修之前。
       少了说明有断言被删掉了 —— 那不是修好，是判据没了。 */
    add('green-not-weaker', green.pass >= red.pass,
      green.pass >= red.pass ? `${red.pass} → ${green.pass} 项` : `通过的断言从 ${red.pass} 掉到 ${green.pass}，有断言被删了`);

    const gateFail = checks.filter(c => c.gate && !c.ok);
    const softFail = checks.filter(c => !c.gate && !c.ok);
    const ok = gateFail.length === 0;
    const strong = ok && red.kind === 'assert';
    const proof = {
      ok,
      strong,
      sig: String(sig || ''),
      test: testRel,
      testSha,
      testIsNew,
      base: baseHash,
      fix: fixHash,
      changedFiles: changed.slice(0, 40),
      changedCount: changed.length,
      seeded,
      red: { exit: red.exit, kind: red.kind, pass: red.pass, fail: red.fail, tail: red.tail },
      green: { exit: green.exit, kind: green.kind, pass: green.pass, fail: green.fail, tail: green.tail },
      checks,
      ms: Date.now() - t0,
      at: new Date().toISOString(),
      why: ok ? '' : gateFail.map(c => c.detail).filter(Boolean).join('；'),
      warn: softFail.map(c => c.detail).filter(Boolean).join('；')
    };
    return proof;
  } catch (e) {
    return {
      ok: false, sig: String(sig || ''), test: testRel, base: baseHash, fix: fixHash,
      checks, why: `证明过程中出错：${clip(e.message, 300)}`, ms: Date.now() - t0, at: new Date().toISOString()
    };
  } finally {
    /* 清理必须无条件执行：留下的 worktree 会一直占着 .git/worktrees，
       攒几十个之后 `git status` 自己就开始变慢，而没人会想到这里。 */
    for (const dir of made) {
      const r = await git(root, ['worktree', 'remove', '--force', dir], { timeout: 30000 });
      if (r.code !== 0) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
    await git(root, ['worktree', 'prune'], { timeout: 30000 });
  }
}

/* ── 落盘 ──
   证据要留得住，不能只在返回体里。复核的人隔一周来看，得能看到
   「当时是哪个提交、哪份测试、红在哪一行」。 */
export function fileOf(sig) {
  const h = crypto.createHash('sha1').update(String(sig || '')).digest('hex').slice(0, 16);
  return path.join(DIR, h + '.json');
}

export function saveProof(proof) {
  if (!proof || !proof.sig) return false;
  const tmp = fileOf(proof.sig) + '.tmp';
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(proof, null, 2));
    fs.renameSync(tmp, fileOf(proof.sig));
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
    return false;
  }
}

export function loadProof(sig) {
  try {
    return JSON.parse(fs.readFileSync(fileOf(sig), 'utf8'));
  } catch {
    return null;
  }
}

export function dropProof(sig) {
  try { fs.unlinkSync(fileOf(sig)); return true; } catch { return false; }
}

/* 一次 readdir 拿到「哪些单有证据」。列表里要显示这个标记，
   但一张单读一次 JSON 是 200 次文件读——列表只认文件名。 */
export function proofKeys() {
  const out = new Set();
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (f.endsWith('.json')) out.add(f.slice(0, -5));
    }
  } catch { /* 目录没建就当没有 */ }
  return out;
}

export function proofStats() {
  const out = { dir: DIR, total: 0, ok: 0, strong: 0 };
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      out.total++;
      if (p.ok) out.ok++;
      if (p.strong) out.strong++;
    } catch { /* 坏文件不计 */ }
  }
  return out;
}

export const __test = { DIR, ROOT, cleanEnv, DROP_ENV, clip };
