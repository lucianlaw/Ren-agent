// 工具层：5 个工具 + 权限分类 + 路径围栏
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/* 权限分类：read / write / exec。read 是读文件与列目录，write 是写文件，
   exec 是跑 shell（既要 exec 权限也要 read 权限，因为它能读任何东西）。 */
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出工作目录下某个路径的文件与子目录。path 为空表示根目录。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对工作目录的路径，例如 "." 或 "src"' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取一个文本文件的内容。超过 20000 字符会被截断。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
          max_chars: { type: 'number', description: '最多读取多少字符，默认 20000' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把内容写入一个文件。目录不存在会自动创建。会覆盖同名文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
          content: { type: 'string', description: '完整文件内容' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '在工作目录内按正则搜索文件内容，返回 路径:行号:内容。最多 40 条。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式' },
          path: { type: 'string', description: '搜索起点，默认 "."' }
        },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: '在工作目录内执行一条 shell 命令，返回 stdout/stderr。禁止破坏性命令。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，例如 "ls -la" 或 "wc -l *.md"' },
          timeout_ms: { type: 'number', description: '超时毫秒，默认 20000，最大 120000' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: '把当前任务的待办清单写下来（覆盖式）。用于多步任务保持节奏。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: '待办项列表',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                status: { type: 'string', enum: ['todo', 'doing', 'done'] }
              },
              required: ['text']
            }
          }
        },
        required: ['items']
      }
    }
  }
];

export const TOOL_CATEGORY = {
  list_dir: 'read', read_file: 'read', search_text: 'read',
  write_file: 'write', run_shell: 'exec', todo_write: 'none'
};

/* shell 黑名单：命中即拒绝，不做「智能判断」。宁可误拒，不要误放。 */
const DENY = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, why: '删除根目录' },
  { re: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, why: '递归强制删除' },
  { re: /\bsudo\b|\bsu\s+-/, why: '提权' },
  { re: /\bmkfs\b|\bdd\s+if=|\bdiskutil\s+erase/, why: '磁盘操作' },
  { re: /\bshutdown\b|\breboot\b|\bhalt\b/, why: '关机重启' },
  { re: /\bchmod\s+(-R\s+)?777\s+\//, why: '放开根目录权限' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, why: '下载后直接执行' },
  { re: /:\s*\(\s*\)\s*\{/, why: 'fork 炸弹' },
  { re: /\bgit\s+push\s+.*--force/, why: '强推覆盖远端' },
  { re: />\s*\/dev\/(sd|disk)/, why: '写裸设备' },
  { re: /\bssh-keygen\b|\bsecurity\s+find-/, why: '动密钥与钥匙串' }
];

export function shellDenied(cmd) {
  for (const d of DENY) if (d.re.test(cmd)) return d.why;
  return null;
}

function within(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(root, target || '.');
  if (t !== r && !t.startsWith(r + path.sep)) return null;
  return t;
}

const SKIP_DIR = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', '__pycache__']);

function walk(dir, out, depth = 0) {
  if (depth > 6 || out.length > 4000) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.env') continue;
    if (e.isDirectory() && SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    out.push({ p, isDir: e.isDirectory() });
    if (e.isDirectory()) walk(p, out, depth + 1);
  }
}

const cut = (s, n) => (s.length > n ? s.slice(0, n) + `\n…（已截断，共 ${s.length} 字符）` : s);

export async function runTool(name, args, ctx) {
  const { workspace } = ctx;
  const started = Date.now();
  const done = (output, extra = {}) => ({ ok: true, output: cut(String(output), 24000), ms: Date.now() - started, ...extra });

  try {
    if (name === 'list_dir') {
      const dir = within(workspace, args.path || '.');
      if (!dir) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      const ents = fs.readdirSync(dir, { withFileTypes: true });
      if (!ents.length) return done('（空目录）');
      const lines = ents
        .filter(e => !e.name.startsWith('.'))
        .map(e => {
          if (e.isDirectory()) return `  ${e.name}/`;
          const st = fs.statSync(path.join(dir, e.name));
          return `  ${e.name}  ${st.size}B`;
        });
      return done(`目录 ${path.relative(workspace, dir) || '.'} 共 ${ents.length} 项：\n${lines.join('\n')}`);
    }

    if (name === 'read_file') {
      const f = within(workspace, args.path);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      const st = fs.statSync(f);
      if (st.isDirectory()) return { ok: false, output: '这是一个目录，请用 list_dir。', ms: Date.now() - started };
      const raw = fs.readFileSync(f, 'utf8');
      return done(cut(raw, Math.min(Number(args.max_chars) || 20000, 60000)));
    }

    if (name === 'write_file') {
      const f = within(workspace, args.path);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(args.content ?? ''));
      const st = fs.statSync(f);
      return done(`已写入 ${path.relative(workspace, f)}（${st.size}B）`);
    }

    if (name === 'search_text') {
      const base = within(workspace, args.path || '.');
      if (!base) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      let re;
      try { re = new RegExp(args.pattern, 'i'); } catch { return { ok: false, output: '正则写错了，请换一个。', ms: Date.now() - started }; }
      const files = [];
      const st = fs.statSync(base);
      if (st.isDirectory()) walk(base, files); else files.push({ p: base, isDir: false });
      const hits = [];
      for (const f of files) {
        if (f.isDir) continue;
        let text = '';
        try {
          const s = fs.statSync(f.p);
          if (s.size > 800_000) continue;
          text = fs.readFileSync(f.p, 'utf8');
        } catch { continue; }
        if (text.includes('\u0000')) continue;
        text.split('\n').forEach((line, i) => {
          if (hits.length < 40 && re.test(line)) {
            hits.push(`${path.relative(workspace, f.p)}:${i + 1}: ${line.trim().slice(0, 160)}`);
          }
        });
        if (hits.length >= 40) break;
      }
      return done(hits.length ? hits.join('\n') : '没有匹配结果。');
    }

    if (name === 'run_shell') {
      const cmd = String(args.command || '');
      const why = shellDenied(cmd);
      if (why) return { ok: false, output: `命令被安全规则拦截：${why}。如确需执行，请你自己在终端运行。`, ms: Date.now() - started };
      const timeout = Math.min(Number(args.timeout_ms) || 20000, 120000);
      const out = await new Promise(resolve => {
        execFile('/bin/sh', ['-c', cmd], { cwd: workspace, timeout, maxBuffer: 2 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
            resolve(`exit ${code}\n${stdout}${stderr ? '\n[stderr]\n' + stderr : ''}`);
          });
      });
      return done(out);
    }

    if (name === 'todo_write') {
      const items = Array.isArray(args.items) ? args.items : [];
      ctx.onTodos?.(items);
      return done('待办已记录：\n' + items.map((t, i) => `${i + 1}. [${t.status || 'todo'}] ${t.text}`).join('\n'));
    }

    return { ok: false, output: `未知工具 ${name}`, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, output: `工具执行出错：${e.message}`, ms: Date.now() - started };
  }
}
