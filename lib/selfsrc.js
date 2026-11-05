// 只读自审：把「自己的源码」作为一个只读仓库交给模型看。
//
// 这一层唯一的职责是**划界**，不是提供功能：
//   · 只能读源码目录，出不去（workspace/data/.git 都不算源码）
//   · 只能读文本类文件，二进制直接跳过
//   · admins.json / self-token.json 必须拒绝——它们就在源码根目录里，
//     放过去等于把管理员名单和自审令牌一并交出去
//   · 全部只读：这里没有任何写文件、执行命令的出口
//
// 刻意不做成「工具清单里多三个工具」：那会让它出现在所有普通任务里。
// 自审是独立入口，边界单独收口才好审计。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './workspace.js';
import { secretValue } from './config.js';

/* 不算源码的目录：用户工作区、运行数据、版本库、依赖 */
const SKIP_DIR = new Set(['node_modules', '.git', 'workspace', 'data', '.workbuddy', '.slidep', 'outputs', '.next']);

/* 允许读的扩展名：能把逻辑看懂的就这些，图片/office 二进制不进来 */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.py', '.sh', '.yml', '.yaml']);

/* 根目录里这两个文件是「凭据」，任何时候都不给读 */
const DENY_FILE = new Set(['admins.json', 'self-token.json']);

const READ_MAX_LINES = 400;
/* 单文件上限只用来挡异常大文件，不能设小：app.js 有 361KB、meeting.js 198KB，
   这两个正是最该被读的文件。上限设小了会把核心代码变成「不存在」，
   表现是 grep 永远漏掉它们——这比报错更坏，因为看不出来。 */
const FILE_MAX_BYTES = 8 * 1024 * 1024;
const TREE_MAX = 500;
const GREP_MAX_HITS = 40;
const GREP_MAX_FILES = 4000;

function inside(p, base) {
  const b = base.endsWith(path.sep) ? base : base + path.sep;
  return p === base || p.startsWith(b);
}

/* 把外部传进来的相对路径落到真实文件上；不合法就返回原因，不抛异常 */
export function resolveSrc(rel, base = ROOT) {
  const raw = String(rel || '').replace(/\\/g, '/').trim();
  if (!raw) return { error: '要给一个路径' };
  if (raw.includes('\0')) return { error: '路径不合法' };
  /* 先规整再判断：../../etc/passwd 这类必须先被拍平才看得出越界 */
  const norm = path.normalize(raw).replace(/^([.][/\\])+/, '');
  if (norm.startsWith('..')) return { error: '不能读源码目录以外的东西' };
  const abs = path.resolve(base, norm);
  if (!inside(abs, base)) return { error: '不能读源码目录以外的东西' };

  const parts = path.relative(base, abs).split(path.sep);
  if (parts.some(p => SKIP_DIR.has(p))) return { error: `「${parts.find(p => SKIP_DIR.has(p))}」不是源码，不开放` };
  if (DENY_FILE.has(path.basename(abs))) return { error: '这个文件是凭据，不开放' };

  let st;
  try { st = fs.statSync(abs); } catch { return { error: '没有这个文件' }; }
  /* 目录先判：这么说模型能立刻知道该换 self_tree，而不是去纠结扩展名 */
  if (st.isDirectory()) return { error: '这是目录，用 self_tree 看列表' };
  if (!st.isFile()) return { error: '不是普通文件，不开放' };

  const ext = path.extname(abs).toLowerCase();
  if (!TEXT_EXT.has(ext)) return { error: `只开放文本类源码，${ext || '无扩展名'} 不支持` };

  return { abs, rel: path.relative(base, abs) };
}

/* 遍历源码树。只返回相对路径，前端/模型看到的就是「仓库里的路径」 */
export function walkSrc(base = ROOT, max = GREP_MAX_FILES) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < max) {
    const cur = stack.pop();
    const dir = path.join(base, cur);
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const rel = cur ? cur + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue;
        stack.push(rel);
      } else if (e.isFile()) {
        if (DENY_FILE.has(e.name)) continue;
        if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
        out.push(rel);
        if (out.length >= max) break;
      }
    }
  }
  return out.sort();
}

/* 哪些文件不是「线上在跑的那份」。
   server.js 的静态路由只从 public/ 里取文件（`path.join(PUBLIC, rel)`），
   所以不在 public/ 下的 .html 一律访问不到。部署又是只增不删，
   早年的 UI 原型 index.html 就一直留在根目录：里面全是写死的演示任务，
   还带 status:'running'。模型搜 running 会命中它，然后拿演示数据当真实逻辑讲——
   这比搜不到更坏。所以结果里必须显式标出来。 */
export function isShadow(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  return p.endsWith('.html') && !p.startsWith('public/');
}

const SHADOW_TAG = '  ← 未上线：不在 public/ 下，静态路由取不到';

/* 目录视图：给个前缀，列出文件和大小，模型据此决定读哪个 */
export function treeSrc(dir = '', base = ROOT) {
  /* '.' 和 './public' 是模型顺口就会写的写法，要当空前缀处理，
     否则 startsWith('./') 一个都匹配不上，返回「这里没有源码文件」——看着像目录是空的 */
  const prefix = String(dir || '').replace(/\\/g, '/')
    .replace(/^\.\/+/, '').replace(/^\.$/, '')
    .replace(/^\/+|\/+$/g, '');
  if (prefix) {
    const norm = path.normalize(prefix);
    if (norm.startsWith('..')) return { error: '不能看源码目录以外的东西' };
    if (norm.split(path.sep).some(p => SKIP_DIR.has(p))) return { error: '这个目录不开放' };
  }
  const files = walkSrc(base).filter(p => !prefix || p === prefix || p.startsWith(prefix + '/'));
  const lines = files.slice(0, TREE_MAX).map(p => {
    let n = 0;
    try { n = fs.statSync(path.join(base, p)).size; } catch { /* 读不到就别写了 */ }
    return `${p}\t${n}${isShadow(p) ? SHADOW_TAG : ''}`;
  });
  return {
    text: lines.length ? lines.join('\n') : '（这里没有源码文件）',
    count: files.length,
    more: files.length > TREE_MAX
  };
}

/* 读一段：带行号返回，模型引用结论时要指到行 */
export function readSrc(rel, from, lines, base = ROOT) {
  const r = resolveSrc(rel, base);
  if (r.error) return r;
  let text = '';
  try {
    const st = fs.statSync(r.abs);
    if (st.size > FILE_MAX_BYTES) return { error: `文件太大（${Math.round(st.size / 1024)}KB），先用 self_grep 定位再读片段` };
    text = fs.readFileSync(r.abs, 'utf8');
  } catch { return { error: '读不出来' }; }
  if (text.includes('\u0000')) return { error: '这是二进制文件' };

  const all = text.split('\n');
  const start = Math.max(1, Number(from) || 1);
  const take = Math.min(Number(lines) || 200, READ_MAX_LINES);
  const slice = all.slice(start - 1, start - 1 + take);
  return {
    text: slice.map((l, i) => `${start + i}\t${l}`).join('\n'),
    total: all.length,
    from: start,
    to: start + slice.length - 1,
    truncated: start - 1 + slice.length < all.length
  };
}

/* 全文检索：模型先定位再精读，比整篇塞进去省得多 */
export function grepSrc(q, base = ROOT, opts = {}) {
  const pat = String(q || '');
  if (!pat.trim()) return { error: '要给一个搜索词' };
  let re;
  try { re = new RegExp(pat, 'i'); } catch { re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const glob = String(opts.glob || '').trim();
  const hits = [];
  const files = walkSrc(base);
  for (const rel of files) {
    if (glob && !rel.includes(glob)) continue;
    let text = '';
    try {
      const st = fs.statSync(path.join(base, rel));
      if (st.size > FILE_MAX_BYTES) continue;
      text = fs.readFileSync(path.join(base, rel), 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    const arr = text.split('\n');
    const tag = isShadow(rel) ? SHADOW_TAG : '';
    for (let i = 0; i < arr.length; i++) {
      if (re.test(arr[i])) {
        hits.push(`${rel}:${i + 1}: ${arr[i].trim().slice(0, 200)}${tag}`);
        if (hits.length >= GREP_MAX_HITS) return { text: hits.join('\n'), hits: hits.length, scanned: files.length, more: true };
      }
    }
  }
  return {
    text: hits.length ? hits.join('\n') : '没有匹配。换个关键词，或者用 self_tree 看看目录结构。',
    hits: hits.length,
    scanned: files.length,
    more: false
  };
}

/* ── 令牌 ──
   源码本身不是秘密，但「谁都能读」不合适：这是个公开部署。
   令牌以前放根目录 self-token.json —— 那个位置在部署目录里，等于随发布件一起
   发到了线上、也留在任何人拿到的源码包里。现在改由 config 解析，放在部署目录之外；
   老文件第一次读到时会被自动搬走并删除。
   注意 create:false：自审是「配了才开」的功能，不能凭空生成一个没人知道的令牌
   假装已经开启。取不到就整体关掉，宁可不可用也不裸奔。 */
export function selfToken() {
  return secretValue('self.key', {
    env: 'SELF_TOKEN',
    bytes: 24,
    minLen: 16,
    create: false,
    legacy: 'self-token.json',
    /* 老文件是 { token, _note } 的 JSON，不是纯文本，要挑出 token 再搬 */
    legacyPick: raw => JSON.parse(raw).token
  });
}

export function selfAuth(given) {
  const want = selfToken();
  if (!want) return { ok: false, code: 503, error: '自审没开启：未配置 SELF_TOKEN，或密钥目录里没有 self.key' };
  const g = String(given || '');
  if (g.length !== want.length) return { ok: false, code: 403, error: '令牌不对' };
  /* 定长比较，别用 === 泄长度（这里其实泄不了多少，但习惯要对） */
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= g.charCodeAt(i) ^ want.charCodeAt(i);
  if (diff !== 0) return { ok: false, code: 403, error: '令牌不对' };
  return { ok: true };
}
