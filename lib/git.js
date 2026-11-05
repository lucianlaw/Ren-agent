// 仓库工作流：把「coding agent」缺的那半截补上
//
// 在此之前模型只能用 run_shell 裸跑 git：命令是黑盒，回退不了，也不知道自己改了什么。
// 更麻烦的是模型经常在 shell 里写 `git checkout .` / `git reset --hard`——
// 一句就把没提交的改动全抹了，而且没人看得见发生过。
//
// 这里的选择是**调系统 git**，不引 isomorphic-git 之类的实现：
//   · 这个项目零运行时依赖，引一个几百 KB 的 git 实现会破坏这条底线；
//   · 用户真实的仓库（clone 下来的开源项目）里什么都有：子模块、LFS、worktree、
//     奇形怪状的 hooks。只有真 git 能处理真仓库。
// 代价是要探测二进制。探测不到时明确说「这台机器没有 git」，而不是给一个假的成功。
//
// 三条硬约束：
//   1. 仓库根必须在自己的工作区里（用 within 判，不靠字符串前缀）
//   2. 身份写在命令行上（-c user.name），不改用户/系统 git 配置
//   3. 破坏性操作（reset --hard、discard 未提交改动）必须显式 confirm

import path from 'node:path';
import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

/* 身份固定成执行器自己：用老板的个人身份提交，会把他真实邮箱写进一堆仓库历史里。
   GIT_TERMINAL_PROMPT=0 尤其重要——容器里没有终端，要密码时 git 会挂到超时，
   表现成「命令莫名其妙卡住 30 秒」。 */
function gitEnv() {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: 'echo',
    GIT_AUTHOR_NAME: process.env.REN_GIT_NAME || 'Ren Agent',
    GIT_AUTHOR_EMAIL: process.env.REN_GIT_EMAIL || 'agent@ren.local',
    GIT_COMMITTER_NAME: process.env.REN_GIT_NAME || 'Ren Agent',
    GIT_COMMITTER_EMAIL: process.env.REN_GIT_EMAIL || 'agent@ren.local'
  };
  return env;
}

let gitVersionCache = null;
export function gitAvailable() {
  if (gitVersionCache !== null) return gitVersionCache;
  try {
    const r = execFileSync('git', ['--version'], { stdio: 'pipe', timeout: 5000 });
    gitVersionCache = String(r.toString() || '').trim();
  } catch {
    gitVersionCache = '';
  }
  return gitVersionCache;
}

async function git(args, { cwd, timeout = 20000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const r = await pexec('git', args, {
    cwd, timeout, env: gitEnv(), maxBuffer: maxBytes, encoding: 'buffer'
  }).catch(e => {
    /* execFile 的失败也带 stdout/stderr：git 很多「失败」是有信息量的
       （比如 diff 退出码 1 表示有差异），不能当成没输出。 */
    if (e && (e.stdout || e.stderr)) return e;
    throw e;
  });
  const out = String(r.stdout || '').toString();
  const err = String(r.stderr || '').toString();
  return { code: typeof r.code === 'number' ? r.code : 0, out, err };
}

const cutText = (s, n = 20000) => (s.length > n ? `${s.slice(0, n)}\n…（已截断，共 ${s.length} 字符）` : s);
const oneLine = (s) => String(s || '').split('\n').find(x => x.trim()) || '';

/* 仓库根：先看这里是不是仓库，再看它属于哪个仓库的哪一层。
   为什么要往上找：模型经常 cd 到 src/ 里干活，然后调 repo_status。
   只认「当前目录就是根」会让它一脸茫然。 */
async function resolveRepo(ctx, rel) {
  const root = path.resolve(String((ctx && ctx.workspace) || '.'));
  const target = path.resolve(root, String(rel || '.'));
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { error: '这个路径在工作区之外，不能当仓库用。' };
  }
  if (!fs.existsSync(target)) return { error: `目录不存在：${rel || '.'}` };
  const r = await git(['rev-parse', '--show-toplevel'], { cwd: target });
  if (r.code !== 0) return { error: '这里还不是 git 仓库。要开始管理版本，先调 repo_init。' };
  const top = r.out.trim();
  /* 比较前先取真实路径：macOS 的 /tmp 是 /private/tmp 的软链，容器里也常有挂载软链，
     git 回的是真实路径。直接比字符串会把「自己的仓库」判成「别人的仓库」——
     这个错误的观感极差：明明刚 init 完，下一步就说你越界。 */
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const rootReal = real(root);
  const topReal = real(top);
  if (topReal !== rootReal && !topReal.startsWith(rootReal + path.sep)) {
    return { error: '这个仓库的根不在工作区里（可能指到了上层目录），拒绝操作。' };
  }
  return { top: topReal, cwd: target };
}

/* 不许进版本库的东西。
   两个来源：一是这个应用自己的机密（密钥、审计、用量），二是通用雷区（.env、私钥、巨型依赖目录）。
   模型不会主动想这些，但一旦 commit -A 就会把整个 data/ 和历史告警打进仓库，
   而仓库通常是会被推走的——那就是一次真实的数据外泄。 */
const FORBIDDEN = [
  { re: /(^|\/)\.ren-secrets\//, why: '签名密钥目录' },
  { re: /(^|\/)data\//, why: '运行时数据（告警、审计、用量）' },
  { re: /(^|\/)\.env(\.|$)/, why: '环境变量文件' },
  { re: /(^|\/)self-token\.json$/, why: '自审令牌' },
  { re: /\.(pem|key|p12|pfx)$/i, why: '证书或私钥' },
  { re: /(^|\/)node_modules\//, why: '依赖目录' },
  { re: /(^|\/)\.DS_Store$/, why: '系统垃圾文件' }
];

function forbiddenReason(p) {
  for (const f of FORBIDDEN) if (f.re.test(p)) return f.why;
  return '';
}

const BIG = 5 * 1024 * 1024;

export const GIT_DEFS = [
  {
    type: 'function',
    function: {
      name: 'repo_init',
      description: '把一个目录变成 git 仓库（默认工作目录本身），并写好 .gitignore（排除密钥、运行时数据、依赖目录）。'
        + '要做有版本的开发、或者需要「改坏了能回退」时，先调这个。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库位置，默认 "."（工作目录根）' },
          branch: { type: 'string', description: '初始分支名，默认 main' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_status',
      description: '看仓库现状：当前分支、有哪些改动/未跟踪文件。动手改代码前先看一眼，改完再看一眼。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库内任意目录，默认 "."' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_diff',
      description: '看具体改了什么（按行）。不带参数看未暂存的改动，stat=true 只看统计。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库内任意目录，默认 "."' },
          file: { type: 'string', description: '只看某个文件，例如 "src/app.js"' },
          staged: { type: 'boolean', description: '看已暂存（将要提交）的改动' },
          stat: { type: 'boolean', description: '只看每个文件加了几行减了几行' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_commit',
      description: '把当前所有改动提交成一个版本。提交前会自动挡住密钥、运行时数据、依赖目录和超大文件。'
        + '每做完一件完整的事就提交一次——这样「改坏了回退」才有落点。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库内任意目录，默认 "."' },
          message: { type: 'string', description: '一句话说清这次改了什么（为什么改比改了什么更重要）' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_log',
      description: '看提交历史（最近的在前）。想知道「之前有没有人动过这里」时用。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库内任意目录，默认 "."' },
          limit: { type: 'number', description: '看几条，默认 10' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_branch',
      description: '管理分支：不带参数列出现有分支；给 name 就新建并切过去；switch 指定已有分支名就切过去。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库内任意目录，默认 "."' },
          name: { type: 'string', description: '要新建的分支名' },
          switch: { type: 'string', description: '要切换到的已有分支名' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_rollback',
      description: '回退。file + 不给 commit：把这个文件恢复到上次提交的样子（丢掉未提交改动）；'
        + 'file + commit：把文件恢复到某个版本；commit 不给 file：整棵树回到那次提交（会丢改动，必须 confirm=true）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '仓库内任意目录，默认 "."' },
          file: { type: 'string', description: '只回退这个文件（相对仓库根）' },
          commit: { type: 'string', description: '回到哪个提交（哈希或 HEAD~1）' },
          confirm: { type: 'boolean', description: '整棵树回退时必须显式给 true' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'repo_clone',
      description: '把远端仓库克隆到工作区里（只接受 https 地址）。克隆后可以正常改、提交、看历史。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'https 开头的仓库地址' },
          dir: { type: 'string', description: '克隆到哪个目录（相对工作目录）' }
        },
        required: ['url']
      }
    }
  }
];

export async function runGitTool(name, args, ctx) {
  const t0 = Date.now();
  const done = (output, extra = {}) => ({ ok: true, output: cutText(String(output)), ms: Date.now() - t0, ...extra });
  const fail = (output, extra = {}) => ({ ok: false, output: String(output), ms: Date.now() - t0, ...extra });

  if (!gitAvailable()) {
    return fail('这台机器上没有 git 命令，仓库功能用不了。文件读写、搜索、跑命令都不受影响。');
  }

  const rel = args.path || '.';

  /* ── init ── */
  if (name === 'repo_init') {
    const root = path.resolve(String(ctx.workspace || '.'), String(rel || '.'));
    const base = path.resolve(String(ctx.workspace || '.'));
    if (root !== base && !root.startsWith(base + path.sep)) return fail('这个路径在工作区之外。');
    try { fs.mkdirSync(root, { recursive: true }); } catch (e) { return fail(`建不了目录：${e.message}`); }

    const probe = await git(['rev-parse', '--git-dir'], { cwd: root });
    if (probe.code === 0) return done(`这里已经是 git 仓库了：${root}\n用 repo_status 看现状。`);

    const branch = String(args.branch || 'main').replace(/[^\w./-]/g, '') || 'main';
    const init = await git(['init', '-b', branch], { cwd: root });
    if (init.code !== 0) return fail(`git init 失败：${oneLine(init.err) || oneLine(init.out)}`);

    /* .gitignore 只在没有的时候写：用户自己的忽略规则比我们的默认值重要 */
    const gi = path.join(root, '.gitignore');
    let added = false;
    if (!fs.existsSync(gi)) {
      fs.writeFileSync(gi, [
        '# 由 Ren Agent 初始化时生成。可以随意改。',
        '.ren-secrets/',
        'data/',
        'node_modules/',
        '.env',
        '.env.*',
        'self-token.json',
        '*.log',
        '.DS_Store',
        ''
      ].join('\n'));
      added = true;
    }
    return done(`已初始化仓库：${root}（分支 ${branch}）${added ? '\n已写入默认 .gitignore（排除密钥、运行时数据、依赖目录）' : ''}`);
  }

  /* ── clone ── */
  if (name === 'repo_clone') {
    const url = String(args.url || '').trim();
    /* 只放 https：file:// 和本地路径能读到工作区外的东西，ssh 会要私钥。
       这条不是防模型，是防「一句 clone 就把宿主机目录搬进来」。 */
    if (!/^https:\/\/[^\s]+$/i.test(url)) {
      return fail('只接受 https 开头的仓库地址。本地路径和 file:// 会把工作区外的内容搬进来，ssh 会要私钥，这两种都不放行。');
    }
    const base = path.resolve(String(ctx.workspace || '.'));
    const dir = path.resolve(base, String(args.dir || '') || url.split('/').pop().replace(/\.git$/, '') || 'repo');
    if (dir !== base && !dir.startsWith(base + path.sep)) return fail('目标目录在工作区之外。');
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) return fail(`目标目录不为空：${args.dir || dir}`);

    const r = await git(['clone', '--depth', '1', url, dir], { cwd: base, timeout: 120000, maxBytes: 4 * 1024 * 1024 });
    if (r.code !== 0) {
      const why = oneLine(r.err) || oneLine(r.out) || '未知错误';
      return fail(`克隆失败：${why}\n（容器里可能没有外网；也可能是地址本身不对）`);
    }
    const st = await git(['rev-parse', '--short', 'HEAD'], { cwd: dir });
    return done(`已克隆到 ${path.relative(base, dir) || '.'}（当前提交 ${st.out.trim() || '未知'}）\n`
      + '接下来用 repo_status 看现状，改完用 repo_commit 提交。');
  }

  const repo = await resolveRepo(ctx, rel);
  if (repo.error) return fail(repo.error);
  const cwd = repo.cwd;

  /* ── status ── */
  if (name === 'repo_status') {
    const br = await git(['status', '--porcelain=v1', '-b'], { cwd });
    const lines = br.out.split('\n').filter(Boolean);
    const head = lines.find(l => l.startsWith('##')) || '';
    /* porcelain 的这行有两种形状：`## main...origin/main [ahead 1]` 和
       `## No commits yet on main`。原样透出去会得到「分支 No commits yet on main」
       这种半截话，模型容易误读成「分支名叫 No commits yet」。 */
    const label = head.replace(/^##\s*/, '').replace(/^No commits yet on\s+/i, '') || '（未知分支）';
    const noCommit = /No commits yet/i.test(head);
    const files = lines.filter(l => !l.startsWith('##'));
    if (!files.length) {
      return done(`分支 ${label}${noCommit ? '（还没有提交）' : ''}\n工作区干净，没有未提交的改动。`);
    }
    const shown = files.slice(0, 60);
    return done(`分支 ${label}${noCommit ? '（还没有提交）' : ''}\n共 ${files.length} 个改动：\n`
      + shown.map(l => `  ${l}`).join('\n')
      + (files.length > shown.length ? `\n  …还有 ${files.length - shown.length} 个` : '')
      + '\n\n改完用 repo_commit 提交；想先看细节用 repo_diff。');
  }

  /* ── diff ── */
  if (name === 'repo_diff') {
    const a = ['diff'];
    if (args.staged) a.push('--cached');
    if (args.stat) a.push('--stat');
    if (args.file) a.push('--', String(args.file));
    const r = await git(a, { cwd });
    const body = r.out.trim();
    if (!body) {
      return done(args.staged ? '暂存区是空的（还没有 git add 过东西）。' : '没有未提交的改动。');
    }
    return done(body, { changed: true });
  }

  /* ── commit ── */
  if (name === 'repo_commit') {
    const msg = String(args.message || '').trim();
    if (!msg) return fail('提交信息不能为空。一句话说清这次改了什么。');

    /* 先看要提交什么，再决定能不能提交。顺序不能反：
       先 add 再看，等于已经把密钥放进索引了，哪怕最后拒掉，它也已经躺在 .git/ 里。 */
    const before = await git(['status', '--porcelain=v1'], { cwd });
    const rows = before.out.split('\n').filter(Boolean);
    if (!rows.length) return done('没有改动，不需要提交。');

    const blocked = [];
    const big = [];
    for (const row of rows) {
      const p = row.slice(3).trim();
      const why = forbiddenReason(p);
      if (why) { blocked.push(`${p}（${why}）`); continue; }
      const abs = path.join(repo.top, p);
      try {
        const st = fs.statSync(abs);
        if (st.isFile() && st.size > BIG) big.push(`${p}（${(st.size / 1048576).toFixed(1)}MB）`);
      } catch { /* 已删除的文件不查大小 */ }
    }
    if (blocked.length) {
      return fail('这些不该进版本库，已拒绝提交：\n' + blocked.map(s => '  ' + s).join('\n')
        + '\n\n它们多半是密钥、运行时数据或依赖目录。把它们写进 .gitignore，或者只提交该提交的文件。',
        { code: 'forbidden' });
    }
    if (big.length) {
      return fail('这些文件太大（>5MB），不适合直接提交：\n' + big.map(s => '  ' + s).join('\n')
        + '\n\n大文件会让仓库迅速膨胀，而且克隆/推送都会变慢。放进 .gitignore，或者另外存。',
        { code: 'too_big' });
    }

    const add = await git(['add', '-A'], { cwd });
    if (add.code !== 0) return fail(`git add 失败：${oneLine(add.err)}`);

    const r = await git(['commit', '-m', msg], { cwd });
    if (r.code !== 0) return fail(`提交失败：${oneLine(r.err) || oneLine(r.out)}`);

    const hash = (await git(['rev-parse', '--short', 'HEAD'], { cwd })).out.trim();
    const stat = await git(['show', '--stat', '--oneline', 'HEAD'], { cwd });
    return done(`已提交 ${hash}：${msg}\n${cutText(stat.out.trim(), 4000)}\n\n要回退这一次用 repo_rollback commit=${hash}。`,
      { commit: hash, files: rows.length });
  }

  /* ── log ── */
  if (name === 'repo_log') {
    const n = Math.min(50, Math.max(1, Number(args.limit) || 10));
    const r = await git(['log', `-${n}`, '--pretty=format:%h  %ad  %s', '--date=format:%Y-%m-%d %H:%M'], { cwd });
    if (r.code !== 0) return done('还没有任何提交。');
    return done(r.out.trim() || '还没有任何提交。');
  }

  /* ── branch ── */
  if (name === 'repo_branch') {
    const name2 = String(args.name || '').replace(/[^\w./-]/g, '');
    const sw = String(args.switch || '').replace(/[^\w./-]/g, '');
    if (name2) {
      const r = await git(['checkout', '-b', name2], { cwd });
      if (r.code !== 0) return fail(`建分支失败：${oneLine(r.err) || oneLine(r.out)}`);
      return done(`已新建并切到分支 ${name2}。`);
    }
    if (sw) {
      const r = await git(['checkout', sw], { cwd });
      if (r.code !== 0) return fail(`切分支失败：${oneLine(r.err) || oneLine(r.out)}`);
      return done(`已切到分支 ${sw}。`);
    }
    const r = await git(['branch', '-a', '--no-color'], { cwd });
    const cur = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return done(`当前分支：${cur.out.trim()}\n${r.out.trim()}`);
  }

  /* ── rollback ── */
  if (name === 'repo_rollback') {
    const file = String(args.file || '').trim();
    const commit = String(args.commit || '').trim();
    if (!file && !commit) return fail('要说清楚回退什么：给 file（只回退一个文件），或者给 commit（整棵树回退）。');
    if (!file && commit) {
      if (args.confirm !== true) {
        return fail(`整棵树回到 ${commit} 会丢掉当前所有未提交的改动。确认要这样做，就带 confirm=true 再调一次。`,
          { code: 'need_confirm' });
      }
      const r = await git(['reset', '--hard', commit], { cwd, timeout: 30000 });
      if (r.code !== 0) return fail(`回退失败：${oneLine(r.err) || oneLine(r.out)}`);
      const hash = (await git(['rev-parse', '--short', 'HEAD'], { cwd })).out.trim();
      return done(`已把整棵树回退到 ${hash}。未提交的改动已丢弃（这一点无法撤销）。`);
    }
    const a = ['checkout', commit || 'HEAD', '--', file];
    const r = await git(a, { cwd });
    if (r.code !== 0) return fail(`回退失败：${oneLine(r.err) || oneLine(r.out)}`);
    return done(`已把 ${file} 恢复到 ${commit || '上次提交'} 的样子。`);
  }

  return fail(`不认识的操作 ${name}`);
}
