// 工具层：文件 / 搜索 / 联网 / 命令 / 待办 + 权限分类 + 路径围栏
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WORKSPACE_BASE } from './workspace.js';
import { runIsolated } from './sandbox.js';
import { checkDisk, noteDisk, isFrozen, fmtBytes } from './quota.js';
import { leasePath } from './state.js';
import { webSearch, fetchPage, imageSearch, grabBinary, genImage, urlProblem, imageChannelDown } from './net.js';
import { chatStream } from './llm.js';
import { renderIllustration, illustrationKind } from './illustrate.js';
import { buildDeck, imageSize } from './pptx.js';
import { buildXlsx } from './xlsx.js';
import { buildDocx } from './docx.js';
import { mdToBlocks } from './md.js';
import { GIT_DEFS, runGitTool } from './git.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARSE_DOC = path.join(__dirname, 'parse_doc.py');
const PYTHON = process.env.PYTHON_BIN || 'python3';

/* 文生图模型对「数量」几乎不敏感：说 mug 就常画成两个把手，说 bike 就多一条车架。
   这是模型能力问题，光靠员工写 prompt 不稳定，这里在服务端补一道硬约束。
   员工自己在 prompt 里明确要了 two/double handles 时不插手。 */
const ONE_HANDLE = /\b(mug|cup|teacup|teapot|kettle|pitcher|jug|bucket|pan|pot|saucepan|casserole)\b/i;
function structureGuard(prompt) {
  const p = String(prompt || '').trim();
  if (!p) return p;
  if (/\b(two|three|double|2|3)\s*-?\s*(handles?|spouts?|spigots?)\b/i.test(p)) return p;
  const extra = [];
  if (ONE_HANDLE.test(p)) extra.push('exactly one handle attached on one side only, no second handle');
  extra.push('one single object centered, physically correct structure, no duplicated or extra parts');
  return `${p.replace(/[,\s]+$/, '')}, ${extra.join(', ')}`;
}

/* 权限分类：read / write / exec。read 是读文件与列目录，write 是写文件，
   exec 是跑 shell（既要 exec 权限也要 read 权限，因为它能读任何东西）。 */
export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录内容。',
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
      description: '读文本文件，默认最多 20000 字；超长用 offset 分段。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
          offset: { type: 'number', description: '从第几个字符开始读，默认 0' },
          max_chars: { type: 'number', description: '这次读多少字符，默认 20000，最多 60000' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '整篇写文件（覆盖同名，目录自动建）。只改已有文件的一小段时用 edit_file，别整篇重写。',
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
      name: 'edit_file',
      description: '精确改文件里的某一小段：给出原文（old_string）和改成什么（new_string），只替换这一处，文件其余部分一字不动。'
        + '改已有文件的局部时必须用它，不要用 write_file 整篇重写——大文件重写既费输出又容易把别处改崩。'
        + 'old_string 必须和文件里的内容完全一致（含缩进和标点），并且默认要求只出现一次；'
        + '不唯一时会报「出现 N 次」，这时把 old_string 前后多带几行让它变唯一。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
          old_string: { type: 'string', description: '要被替换的原文，必须逐字一致（含缩进），默认要求全文唯一' },
          new_string: { type: 'string', description: '替换成什么；留空字符串表示删除这一段' },
          replace_all: { type: 'boolean', description: '确实要替换全部同名片段时置 true，默认只替换唯一那一处' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '按正则搜文件内容，最多 40 条。',
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
      description: '执行 shell 命令（禁止破坏性命令）。',
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
      description: '写当前任务的待办清单（覆盖式）。',
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
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索，返回标题+链接+摘要。政策、行情、价格、竞品、新闻这类会变的事实都用它；要细节再用 fetch_url 打开。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词，像人一样写，例如「2026 上海 客服外包 人均月成本」' },
          limit: { type: 'number', description: '要几条结果，默认 6，最多 10' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '打开网页取正文纯文本，用来核实数字、读政策原文。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整网址，必须以 http:// 或 https:// 开头' },
          max_chars: { type: 'number', description: '最多返回多少字符，默认 12000' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'make_deck',
      description: '生成真正的 PowerPoint（.pptx）。要 PPT / 汇报稿 / 提案时用它，别用 write_file 写 md。你给内容和版式，排版（16:9、配色、层级、留白、页码）由它做。'
        + 'layout：cover 封面、section 过渡(给 no)、bullets 要点、cards 卡片(cards[])、split 图文分栏(image+bullets)、'
        + 'image 满版图、table 表格、chart 条形图、kpi 大数字(kpis[])、steps 流程(steps[])、quote 引言(text)、end 结尾。'
        + '一页一种版式，别连续三页都用 bullets。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '.pptx 路径，例如 "提案.pptx"' },
          title: { type: 'string', description: '封面主标题' },
          subtitle: { type: 'string', description: '封面副标题' },
          theme: {
            type: 'string',
            enum: ['paper', 'ink', 'forest', 'plum', 'mono'],
            description: '配色：消费品 paper、科技金融 ink、环保 health forest、女性向 plum、极简 mono'
          },
          footer: { type: 'string', description: '页脚小字，如「提案 · 2026-10」' },
          slides: {
            type: 'array',
            description: '按顺序的页，建议 8–16 页，首 cover 尾 end',
            items: {
              type: 'object',
              properties: {
                layout: {
                  type: 'string',
                  enum: ['cover', 'section', 'bullets', 'cards', 'split', 'image', 'table', 'chart', 'kpi', 'steps', 'quote', 'end'],
                  description: '版式'
                },
                kicker: { type: 'string' },
                title: { type: 'string', description: '写结论，不写「关于…」' },
                subtitle: { type: 'string' },
                meta: { type: 'string', description: '封面/结尾落款' },
                no: { type: 'string', description: 'section 序号' },
                bullets: { type: 'array', items: { type: 'string' }, description: '要点；二级写 {"text":"…","level":1}；split 页可写 {"k":"39 元","text":"…"}' },
                cards: { type: 'array', items: { type: 'object' }, description: '[{k?,title,text}] 2–4 张' },
                kpis: { type: 'array', items: { type: 'object' }, description: '[{value,label,note?}] 2–4 个' },
                table: { type: 'object', description: '{head:[…],rows:[[…]],widths?}' },
                chart: { type: 'object', description: '{items:[{label,value,display?,highlight?}],unit?}' },
                steps: { type: 'array', items: { type: 'object' }, description: '[{title,text}] 3–5 步' },
                text: { type: 'string', description: '引言正文' },
                by: { type: 'string' },
                takeaway: { type: 'string', description: '底部结论色带' },
                note: { type: 'string', description: '表/图脚注' },
                image: { type: 'string', description: '配图路径' },
                caption: { type: 'string' },
                side: { type: 'string', enum: ['l', 'r'] }
              },
              required: ['layout']
            }
          }
        },
        required: ['path', 'title', 'slides']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_image',
      description: '给 PPT 配图：按一句话搜真实图片并存到 assets/，返回能直接塞进 make_deck 的 image 路径。搜不到就换成无图版式，不要编地址。'
        + '注意：取回的是公开可检索的图片，仅作内部提案示意；对外发布要换成自有素材或授权图。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '画面里有什么：主体 + 场景 + 风格，如「白色陶瓷马克杯 猫爪把手 工作室柔光 产品图」' },
          count: { type: 'number', description: '要几张，默认 3，最多 6' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'gen_image',
      description: 'AI 文生图，存到 assets/，返回能塞进 make_deck 的 image 路径。prompt 用英文，写清主体+风格+光线；'
        + '画具体物体时把「数量+位置+结构」写死（如 exactly one handle on the right），否则容易画出两个把手。'
        + '一次一张，多张就多调；通道会排队失败，同一 prompt 别连试，失败就简化后重试一次或改用 find_image。',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '英文画面描述' },
          aspect: { type: 'string', description: 'square 1:1 / wide 16:9 / tall 3:4' }
        },
        required: ['prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'make_sheet',
      description: '生成一份真正的 Excel（.xlsx）。老板要「表格 / 报价单 / 成本表 / 数据汇总 / 台账」时用它，不要用 write_file 硬写 md。'
        + '每个 sheet 是一张二维表，第一行写表头；数字直接给数字（不用加引号），会按数值存、能在 Excel 里继续算。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '写到哪个文件，例如 "T3-报价表.xlsx"（漏了 .xlsx 会自动补上）' },
          sheets: {
            type: 'array',
            description: '工作表列表。简单表给一张就够',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '工作表名，如 "报价"' },
                rows: {
                  type: 'array',
                  description: '二维数组：第一行是表头，后面是数据行',
                  items: { type: 'array', items: {} }
                }
              },
              required: ['name', 'rows']
            }
          }
        },
        required: ['path', 'sheets']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'make_doc',
      description: '把正文排成 Word（.docx）。正文直接写在回答里（Markdown：# 标题、## 小节、- 要点、| 表格），'
        + '然后调用它只给 path 和 title，系统会自动取你刚写的那段正文。不要用 write_file 硬写 md。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '写到哪个文件，例如 "T5-项目报告.docx"（漏了 .docx 会自动补上）' },
          title: { type: 'string', description: '文档大标题' },
          subtitle: { type: 'string', description: '副标题 / 落款，可留空' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_doc',
      description: '读 PDF/Word/Excel/PPT/CSV 成结构化文本，表格转 Markdown。附件都用它读。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径，例如 "uploads/2026-10-30/报价单.pdf"' },
          max_chars: { type: 'number', description: '最多返回多少字符，默认 24000' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_image',
      description: '看工作区里的一张图片（截图 / 设计稿 / 流程图 / 海报 / 照片），返回图上有什么：'
        + '布局结构、配色、以及图上所有能读到的文字。老板发图让你「照着做」时用它；'
        + '当前模型不能直接看图时更要用它。一次一张。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '图片在工作区的相对路径，例如 "uploads/2026-11-05/首页截图.png"' },
          question: { type: 'string', description: '想让它重点看什么，例如「照这个还原页面结构和配色」' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_boss',
      description: '向老板提问并等他拍板：关键决策（技术选型、品牌口径、范围取舍）不确定时用，一次问完。'
        + '每个问题给 2–4 个候选选项；没有合理选项就留空 options，让老板自己填。'
        + '调用后任务暂停，老板在界面上选完/填完点确认，你会拿着他的答案继续干。不要用纯文本列一堆问题然后干等。',
      parameters: {
        type: 'object',
        properties: {
          intro: { type: 'string', description: '一句话说明为什么要问' },
          questions: {
            type: 'array',
            description: '问题列表，一次 1–5 个，别拆成多次调用',
            items: {
              type: 'object',
              properties: {
                q: { type: 'string', description: '问题本身，一句话说清' },
                options: { type: 'array', items: { type: 'string' }, description: '候选 2–4 个；没有就留空' },
                multi: { type: 'boolean', description: '可多选时 true，默认单选' }
              },
              required: ['q']
            }
          }
        },
        required: ['questions']
      }
    }
  }
];

/* 仓库工具单独一个文件（lib/git.js），这里只把声明接上：
   定义和行为放一起会长到没人愿意读，而它们的权限分类又必须和别的工具放在同一张表里。 */
TOOL_DEFS.push(...GIT_DEFS);

export const TOOL_CATEGORY = {
  list_dir: 'read', read_file: 'read', search_text: 'read', read_doc: 'read', view_image: 'read',
  write_file: 'write', edit_file: 'write', make_deck: 'write', make_sheet: 'write', make_doc: 'write',
  ask_boss: 'none',
  run_shell: 'exec', todo_write: 'none',
  /* 只读的三个是 read，会改仓库的是 write——按「会不会留下副作用」分，
     不按「是不是 git」分。commit 在权限上等价于写文件：它确实改变了磁盘状态。 */
  repo_status: 'read', repo_diff: 'read', repo_log: 'read',
  repo_init: 'write', repo_commit: 'write', repo_branch: 'write',
  repo_rollback: 'write', repo_clone: 'write',
  find_image: 'net', gen_image: 'net',
  web_search: 'net', fetch_url: 'net'
};

/* 老板在设置里自定义的 HTTP 工具（MCP 的平替）：模型按 name 调，服务端替它去打接口 */
export async function runHttpTool(custom, args, started) {
  const t0 = started || Date.now();
  const method = String(custom.method || 'GET').toUpperCase();
  let url = String(custom.url || '');
  const bad = urlProblem(url.replace(/\{[a-zA-Z0-9_]+\}/g, 'x'));
  if (bad) return { ok: false, output: `自定义工具地址不合法：${bad}`, ms: Date.now() - t0 };
  for (const [k, v] of Object.entries(args || {})) {
    url = url.replace(new RegExp(`\\{${k}\\}`, 'g'), encodeURIComponent(String(v ?? '')));
  }
  if (method === 'GET' || method === 'HEAD') {
    const u = new URL(url);
    for (const [k, v] of Object.entries(args || {})) {
      if (!String(url).includes(`{${k}}`)) u.searchParams.set(k, String(v ?? ''));
    }
    url = u.toString();
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'user-agent': 'RenAgent/1.0', ...(custom.headers || {}), ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(args || {}),
      signal: AbortSignal.timeout(20000)
    });
  } catch (e) {
    return { ok: false, output: `调用自定义工具失败：${e.message}`, ms: Date.now() - t0 };
  }
  const text = await res.text();
  return {
    ok: res.ok,
    output: `HTTP ${res.status}（${custom.name}）\n` + text.slice(0, 20000),
    ms: Date.now() - t0
  };
}

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
  return tenantEscapeCmd(cmd);
}

/* 系统关键目录：即使开了「完全访问」也不落子，避免一步把机器搞坏 */
const DENY_PATH = ['/etc/ssh', '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/System', '/dev', '/proc', '/sys', '/boot'];

/* 「完全访问」的边界仍然是租户边界。
 *
 * 这里踩过一个真实的坑（2026-11-04 多人场景复查）：完全访问原本只挡 DENY_PATH，
 * 而所有账号的目录都在 WORKSPACE_BASE/users/<scope> 下，于是任何用户把读写执行三个开关
 * 全打开之后，read_file 给一个绝对路径就能读到别人的报价表和合同。
 * 也就是说「单人玩没问题，一多人就等于没有隔离」。
 *
 * 判据很简单：自己的目录在前一个分支已经 return 了，走到这里还能落在 WORKSPACE_BASE
 * 里面的，只可能是别人的租户目录、权限表（perms/）或数据目录。
 * 所以整个 BASE 一并拒绝，而不是去枚举「哪些子目录不能碰」——枚举法一定会漏。 */
const WT = path.resolve(WORKSPACE_BASE);
function insideTenantBase(t) {
  return t === WT || t.startsWith(WT + path.sep);
}

/* ── 磁盘配额的上下文 ──
   配额按「账号」算，而工具层手里只有路径。正常路径是 server.js 把 scope 传进来
   （ctx.scope）；没有的时候从目录名反推——那只为单测服务。
   反推看起来能省一个参数，但它把「scope 一定等于目录名」变成隐含前提：
   哪天 WORKSPACE_DIR 改成扁平结构，配额就会静默变成空操作，而且不报错。 */
function quotaScope(ctx) {
  const s = String((ctx && ctx.scope) || '');
  if (/^[a-f0-9]{32}$/.test(s)) return s;
  const b = path.basename(path.resolve(String((ctx && ctx.workspace) || '')));
  return /^[a-f0-9]{32}$/.test(b) ? b : '';
}

/* 写之前的统一检查：算出这次净增多少，交给 quota。
   覆盖写一定要减掉原大小——不然「把 1MB 的文件改成 1.1MB」会被算成又用了 1.1MB，
   反复编辑几次就莫名其妙撞上限，而磁盘上其实没变多少。 */
function quotaGate(scope, file, newBytes) {
  if (!scope) return { ok: true, prev: 0 };
  let prev = 0;
  try {
    const st = fs.statSync(file);
    if (st.isFile()) prev = st.size;
  } catch { /* 文件还不存在，prev = 0 */ }
  const q = checkDisk(scope, Math.max(0, (Number(newBytes) || 0) - prev));
  return { ...q, prev };
}

/* ── 路径租约 ──
   同一账号在两台设备上同时跑任务，工作区是同一棵树。两个任务同时写一个文件，
   后写的把先写的抹掉，而两边的日志都写着「成功」——这种损坏不会报错，只会让人
   在两天后发现文件内容不对。所以写入口加一道按路径的短租约。

   租约键用「谁」：优先 runId，没有就退到设备标识，再没有就退到 scope。
   判据可以粗，但不能没有——没有就等于两台设备在同一份文件上抢。

   shell 不走这里（它是降权子进程，本来就拦不住写入），这一点在文档里写明。 */
function leaseGate(ctx, file) {
  const owner = String((ctx && (ctx.runId || ctx.leaseOwner || ctx.scope)) || '').trim();
  if (!owner) return { ok: true };
  const r = leasePath(file, owner);
  if (r.ok) return { ok: true, degrade: !!r.degraded };
  return {
    ok: false,
    output: `另一个任务正在写 ${dispPath(ctx.workspace, file)}（几秒内会释放）。`
      + '换一个文件名先做别的，或者把这一步放到它结束之后再试——同时改同一个文件会互相覆盖。'
  };
}

function within(root, target, fullAccess = false) {
  const r = path.resolve(root);
  const abs = path.isAbsolute(String(target || ''));
  const t = path.resolve(r, target || '.');
  if (t === r || t.startsWith(r + path.sep)) return t;
  if (!fullAccess) return null;
  /* 完全访问：允许工作区外的绝对路径（相对路径仍按工作区解释，避免语义漂移） */
  if (!abs) return null;
  if (insideTenantBase(t)) return null;
  if (DENY_PATH.some(d => t === d || t.startsWith(d + path.sep))) return null;
  return t;
}

/* shell 里的租户边界。
 *
 * 文件工具那道围栏管不到 shell：`cat ../../<别人的scope>/报价表.md` 是完全合法的语法，
 * 黑名单里也没有一条会命中它。所以这里按「路径形态」再拦一道：
 *   · 命令里出现工作区根的真实路径（绝对路径直读别人目录）
 *   · 出现向上的父目录段 `..`（从自己的目录往上就是所有账号的目录）
 *   · 用 ${PWD%…} 这类裁剪展开绕过 `..` 字面量（唯一能不写 .. 就上跳的写法）
 *
 * 说清楚这不是硬沙箱：shell 里能做的事按图灵完备算，静态检查永远有漏。
 * 它挡住的是「一句 cat 就串号」这种顺手而为的路径，不是蓄意逃逸。
 * 真正的边界要等容器/独立用户（1b 基础设施那一步），在那之前别对外宣称已隔离。 */
function tenantEscapeCmd(cmd) {
  if (cmd.includes(WT)) return '访问其他账号的工作区';
  if (/(^|[\s"'=([;|&])\.\.([/"'\s);|&]|$)/.test(cmd)) return '向上越出工作区目录';
  if (/\$\{?PWD[%#:]/.test(cmd)) return '用参数裁剪绕过目录边界';
  return null;
}

/* 展示路径：工作区内显示相对路径，工作区外显示绝对路径（避免出现 ../../..） */
function dispPath(workspace, p) {
  const r = path.resolve(workspace);
  const t = path.resolve(p);
  if (t === r) return '.';
  return t.startsWith(r + path.sep) ? path.relative(r, t) : t;
}

/* 产出工具的扩展名处理。
 *
 * 模型给 "秘书就绪确认" 的时候，它想说的就是 "秘书就绪确认.docx"——
 * 只是没打后缀。这种情况下报「必须以 .docx 结尾」，模型只会换个参数再调一次：
 * 多烧一轮 token，界面上还多一条红色的「工具失败」，老板看到的是「这东西老出错」。
 * 补一个后缀就能解决的事，不该让人看见它发生过。
 *
 * 反过来，模型明确写了别的后缀（.md / .pdf / .png）就不能替它改：
 * 那说明它可能想换格式，或者拿 md 顶替交付物——这种要拦，而且要说明白拦的理由。
 * 所以这里只认「已知的文档后缀」，其它一律当作文件名的一部分补上去
 * （"报价单.v2" 这种带点的名字不会被误判成扩展名）。 */
const KNOWN_EXT = /\.(md|markdown|txt|rtf|pdf|doc|docx|xls|xlsx|csv|tsv|ppt|pptx|key|html?|json|xml|png|jpe?g|gif|webp|svg|zip)$/i;

function ensureExt(rel, ext) {
  const s = String(rel || '').trim();
  if (!s) return { error: 'path 是空的，写清要写到哪个文件。' };
  if (new RegExp('\\.' + ext + '$', 'i').test(s)) return { path: s };
  const m = s.match(KNOWN_EXT);
  if (m) {
    return { error: `这次要交的是 .${ext}，但 path 写成了 ${m[0]}。要么把后缀改对再调一次，要么按老板点名的格式换对应的工具——不要拿别的格式顶替。` };
  }
  return { path: `${s}.${ext}` };
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

/* ── edit_file 的定位与替换 ────────────────────────────────────────────
   精确替换的难点全在「没找到」和「找到多处」，所以诊断要比替换本身更细：
   只说一句「没匹配」模型没法自救，得告诉它差在哪——缩进？行号？还是文件已经被改过。 */
function countHits(text, needle) {
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/* 每次命中所在行号（1 起），最多列 limit 个 */
function hitLines(text, needle, limit = 8) {
  const out = [];
  let i = 0;
  while (out.length < limit) {
    const at = text.indexOf(needle, i);
    if (at === -1) break;
    out.push(text.slice(0, at).split('\n').length);
    i = at + needle.length;
  }
  return out;
}

/* 完全没命中时，找文件里跟 old_string 首行最像的那几行，给模型一个落点 */
function nearestLines(text, needle, limit = 3) {
  const probe = (needle.split('\n').find(l => l.trim()) || '').trim().slice(0, 24);
  if (probe.length < 6) return [];
  const out = [];
  text.split('\n').forEach((l, idx) => {
    if (out.length < limit && l.includes(probe)) out.push(idx + 1);
  });
  return out;
}

/* 改动位置前后几行，带行号，让模型自己确认改的是不是那一处 */
function ctxPreview(text, at, span = 2) {
  const arr = text.split('\n');
  const line = Math.max(0, text.slice(0, Math.max(0, at)).split('\n').length - 1);
  const from = Math.max(0, line - span);
  const to = Math.min(arr.length, line + span + 1);
  return arr.slice(from, to)
    .map((l, i) => `${from + i + 1}| ${l.length > 160 ? l.slice(0, 160) + '…' : l}`)
    .join('\n');
}

/* 纯函数：只算「换成什么」和「为什么拒绝」，不碰文件系统，方便单测 */
export function planEdit(text, oldS, newS, replaceAll) {
  if (!oldS) return { error: 'old_string 不能为空。新写文件用 write_file；只删一段也要把它完整抄进 old_string，new_string 留空。' };
  if (oldS === newS) return { error: 'old_string 和 new_string 一模一样，这次编辑不会产生任何变化。' };

  const hits = countHits(text, oldS);
  if (!hits) {
    /* 缩进/空白差异是最常见的失败原因，单独识别出来，模型才改得动 */
    const squash = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (text.replace(/\r\n/g, '\n').includes(oldS.replace(/\r\n/g, '\n')) || squash(text).includes(squash(oldS))) {
      return { error: '文件里有这段内容，但空白/缩进对不上（空格多了少了、tab 当成空格、换行位置不同）。先 read_file 看一眼实际缩进，再逐字照抄 old_string。' };
    }
    const near = nearestLines(text, oldS);
    return {
      error: '文件里没有这段原文，一个字都没改。'
        + (near.length
          ? `\n最接近的是第 ${near.join('、')} 行——如果目标就在那儿，把那几行原样抄进 old_string（也可能是文件已被别处改过，先 read_file 重读）。`
          : '\n先 read_file 确认文件现在的内容，别凭记忆写 old_string。')
    };
  }
  if (hits > 1 && !replaceAll) {
    return {
      error: `这段原文在文件里出现了 ${hits} 次（第 ${hitLines(text, oldS).join('、')} 行），不确定要改哪一处，已拒绝。\n`
        + '把 old_string 前后多带一两行让它唯一；确认要全部替换就传 replace_all=true。'
    };
  }

  const at = text.indexOf(oldS);
  /* 用切片拼接而不是 String.replace：new_string 里带 $& $1 这类字符时不会被当成替换模式 */
  const after = replaceAll ? text.split(oldS).join(newS) : text.slice(0, at) + newS + text.slice(at + oldS.length);
  const replaced = replaceAll ? hits : 1;
  const atNew = (replaceAll && newS) ? after.indexOf(newS) : at;
  return {
    after, replaced,
    preview: ctxPreview(after, Math.max(0, atNew)),
    beforeLen: text.length, afterLen: after.length
  };
}

/* 语法闸门：只查 JS，改完立刻校验。语法坏了就撤回，工作区永远留一份能跑的代码。
   —— 为什么不直接 `node --check 原文件`：.js 按「所在目录有无 package.json
   type:module」决定模块类型，而工作区（workspace/users/<scope>/）里没有 package.json，
   于是含 export 的 .js 会被静默放过（实测：坏 ESM 的 .js 在无 pkg 目录 exit 0）。
   所以这里按内容判定模块类型，复制成 .mjs / .cjs 临时文件再查——扩展名强制模式，
   不受目录影响。 */
const ESM_HINT = /^[ \t]*(?:import[\s{*'"]|export[\s{*])/m;
function syntaxError(abs) {
  if (!/\.(m?js|cjs)$/i.test(abs)) return null;
  let code;
  try { code = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const isEsm = /\.mjs$/i.test(abs) || (!/\.cjs$/i.test(abs) && ESM_HINT.test(code));
  const tmpFile = path.join(os.tmpdir(), `syntax-${process.pid}-${Math.random().toString(36).slice(2, 8)}${isEsm ? '.mjs' : '.cjs'}`);
  try {
    fs.writeFileSync(tmpFile, code);
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
    return null;
  } catch (e) {
    const raw = String((e && (e.stderr || e.stdout)) || (e && e.message) || '');
    const lines = raw.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 5).join('\n');
    /* 报错里的临时路径换回真文件，否则模型会对着一个没见过的文件名发愣 */
    return (lines || '语法检查未通过').split(tmpFile).join(path.basename(abs));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* 清不掉就算了 */ }
  }
}

const cut = (s, n) => (s.length > n ? s.slice(0, n) + `\n…（已截断，共 ${s.length} 字符）` : s);

export async function runTool(name, args, ctx) {
  const { workspace } = ctx;
  const fullAccess = !!ctx.fullAccess;
  const started = Date.now();
  const done = (output, extra = {}) => ({ ok: true, output: cut(String(output), 24000), ms: Date.now() - started, ...extra });

  try {
    /* 仓库工具走独立的实现，但它和文件工具共享同一套围栏（workspace 根）。
       放在最前面是因为 agent.js 里 repo_* 和内置工具是同一张调用表。 */
    if (name.startsWith('repo_')) return await runGitTool(name, args, ctx);

    if (name === 'list_dir') {
      const dir = within(workspace, args.path || '.', fullAccess);
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
      return done(`目录 ${dispPath(workspace, dir)} 共 ${ents.length} 项：\n${lines.join('\n')}`);
    }

    if (name === 'read_file') {
      const f = within(workspace, args.path, fullAccess);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      const st = fs.statSync(f);
      if (st.isDirectory()) return { ok: false, output: '这是一个目录，请用 list_dir。', ms: Date.now() - started };
      const raw = fs.readFileSync(f, 'utf8');
      /* offset 让模型能只读需要的那一段；默认仍是整份（≤20000 字），别为了省 token 逼它分段重读 */
      const off = Math.max(0, Math.floor(Number(args.offset) || 0));
      const len = Math.max(200, Math.min(Number(args.max_chars) || 20000, 60000));
      const body = raw.slice(off, off + len);
      const rest = raw.length - (off + body.length);
      const head = raw.length > body.length
        ? `【${path.basename(f)}：共 ${raw.length} 字，本次第 ${off}–${off + body.length} 字】\n`
        : '';
      return done(head + body + (rest > 0 ? `\n…（后面还有 ${rest} 字，要读就带 offset=${off + body.length}）` : ''));
    }

    if (name === 'write_file') {
      const f = within(workspace, args.path, fullAccess);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      const body = String(args.content ?? '');
      const bytes = Buffer.byteLength(body);
      const scope = quotaScope(ctx);
      const gate = quotaGate(scope, f, bytes);
      if (!gate.ok) {
        return { ok: false, output: gate.error, code: gate.code, quota: true, ms: Date.now() - started };
      }
      const lease = leaseGate(ctx, f);
      if (!lease.ok) return { ok: false, code: 'lease', ms: Date.now() - started, output: lease.output };
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
      const st = fs.statSync(f);
      if (scope) noteDisk(scope, st.size - (gate.prev || 0));
      return done(`已写入 ${dispPath(workspace, f)}（${st.size}B）`);
    }

    if (name === 'edit_file') {
      const f = within(workspace, args.path, fullAccess);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      if (!fs.existsSync(f)) {
        return { ok: false, output: `文件不存在：${args.path}。要新建文件请用 write_file。`, ms: Date.now() - started };
      }
      const st0 = fs.statSync(f);
      if (st0.isDirectory()) return { ok: false, output: '这是一个目录，不是文件。', ms: Date.now() - started };
      /* 大文件读进来编辑是合理的（这正是它存在的理由），但二进制会被 utf8 读成乱码再写回去损坏，
         8MB 以上的文本也基本超出上下文，两个都拦掉 */
      if (st0.size > 8 * 1024 * 1024) {
        return { ok: false, output: `文件太大（${Math.round(st0.size / 1024 / 1024)}MB），不适合整份读进来编辑。`, ms: Date.now() - started };
      }
      const raw = fs.readFileSync(f);
      if (raw.includes(0)) return { ok: false, output: '这看起来是二进制文件，不能按文本编辑。', ms: Date.now() - started };
      const before = raw.toString('utf8');

      const plan = planEdit(before, String(args.old_string ?? ''), String(args.new_string ?? ''), !!args.replace_all);
      if (plan.error) return { ok: false, output: plan.error, ms: Date.now() - started };

      /* 编辑也是写入：一次把 100 字改成 50 万字同样会把磁盘吃满 */
      const scope = quotaScope(ctx);
      const gate = quotaGate(scope, f, Buffer.byteLength(plan.after));
      if (!gate.ok) {
        return { ok: false, output: gate.error, code: gate.code, quota: true, ms: Date.now() - started };
      }

      const lease = leaseGate(ctx, f);
      if (!lease.ok) return { ok: false, code: 'lease', ms: Date.now() - started, output: lease.output };

      fs.writeFileSync(f, plan.after);
      /* 语法闸门：坏了就撤回。宁可这一次没改成，也不能在工作区留下跑不起来的代码 */
      const bad = syntaxError(f);
      if (bad) {
        fs.writeFileSync(f, before);
        return {
          ok: false,
          output: `这次编辑会让 ${dispPath(workspace, f)} 语法不通过，已撤回，文件保持原样。\n${bad}\n`
            + '请检查 new_string 里的括号、逗号、引号是否闭合，改好后重试。',
          ms: Date.now() - started
        };
      }
      const st = fs.statSync(f);
      if (scope) noteDisk(scope, st.size - (gate.prev || 0));
      return done(
        `已改 ${dispPath(workspace, f)}：替换 ${plan.replaced} 处（${plan.beforeLen} → ${plan.afterLen} 字符，现 ${st.size}B）\n`
        + `改动附近：\n${plan.preview}`,
        { changed: true, replaced: plan.replaced, beforeLen: plan.beforeLen, afterLen: plan.afterLen }
      );
    }

    if (name === 'make_deck') {
      const named = ensureExt(args.path, 'pptx');
      if (named.error) return { ok: false, output: named.error, ms: Date.now() - started };
      const rel = named.path;
      const f = within(workspace, rel, fullAccess);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      const slides = Array.isArray(args.slides) ? args.slides : [];
      if (!slides.length) return { ok: false, output: 'slides 是空的，至少要给一页内容。', ms: Date.now() - started };
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const built = buildDeck(
        { title: args.title, subtitle: args.subtitle, theme: args.theme, footer: args.footer, slides },
        {
          readImage: p => {
            const fp = within(workspace, p, fullAccess);
            if (!fp || !fs.existsSync(fp)) return null;
            const st = fs.statSync(fp);
            if (!st.isFile() || st.size > 12 * 1024 * 1024) return null;
            return fs.readFileSync(fp);
          }
        }
      );
      /* 生成类工具的内容已经在内存里（built.buffer），所以可以在写盘前精确判断。
         拒的时候要说清「东西是好的、只是没地方放」——否则模型会以为是内容错了，
         开始改参数重试，白烧几轮。 */
      const qScope = quotaScope(ctx);
      const qGate = quotaGate(qScope, f, built.buffer.length);
      if (!qGate.ok) {
        return {
          ok: false, code: qGate.code, quota: true, ms: Date.now() - started,
          output: `${qGate.error}\n（内容已经生成好了，只差没写盘——清理出空间后重试同一次调用即可）`
        };
      }
      const lease = leaseGate(ctx, f);
      if (!lease.ok) return { ok: false, code: 'lease', ms: Date.now() - started, output: lease.output };
      fs.writeFileSync(f, built.buffer);
      if (qScope) noteDisk(qScope, built.buffer.length - (qGate.prev || 0));
      const st = fs.statSync(f);
      /* 图片路径写错是最常见的失败：明确回「哪页引用的图没读进来」，别让模型以为已经配上了 */
      const used = new Set();
      slides.forEach(s => { if (s && s.image) used.add(String(s.image)); });
      const missing = [...used].filter(p => !within(workspace, p, fullAccess) || !fs.existsSync(within(workspace, p, fullAccess)));
      return done(`已生成 ${dispPath(workspace, f)}：${built.pages} 页，主题 ${built.theme}，`
        + `内嵌图片 ${built.media} 张，${Math.round(st.size / 1024)}KB。`
        + (missing.length ? `\n⚠ 这些图片没读进来（保证没配上）：${missing.join('、')}。先用 find_image 拿到真实路径再重做。` : '')
        + `\n这是最终交付物，不需要再用 write_file 写一遍；正文只回结论摘要。`,
      /* path 是「实际写到哪」，不是「模型说要写到哪」。
         校验必须看这个：模型漏了后缀、或者路径写成 ./a.docx，args.path 就对不上磁盘，
         于是一份好好的文件被标成「没真的出现」——模型看见「校验未通过」会再调一次同样的工具，
         白烧一轮还多一条红。这条字段就是为了让校验有真相可依。 */
      { path: dispPath(workspace, f) });
    }

    if (name === 'make_sheet') {
      const named = ensureExt(args.path, 'xlsx');
      if (named.error) return { ok: false, output: named.error, ms: Date.now() - started };
      const rel = named.path;
      const f = within(workspace, rel, fullAccess);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      let built;
      try { built = buildXlsx({ sheets: args.sheets }); }
      catch (e) { return { ok: false, output: `表没写出来：${e.message}`, ms: Date.now() - started }; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      /* 生成类工具的内容已经在内存里（built.buffer），所以可以在写盘前精确判断。
         拒的时候要说清「东西是好的、只是没地方放」——否则模型会以为是内容错了，
         开始改参数重试，白烧几轮。 */
      const qScope = quotaScope(ctx);
      const qGate = quotaGate(qScope, f, built.buffer.length);
      if (!qGate.ok) {
        return {
          ok: false, code: qGate.code, quota: true, ms: Date.now() - started,
          output: `${qGate.error}\n（内容已经生成好了，只差没写盘——清理出空间后重试同一次调用即可）`
        };
      }
      const lease = leaseGate(ctx, f);
      if (!lease.ok) return { ok: false, code: 'lease', ms: Date.now() - started, output: lease.output };
      fs.writeFileSync(f, built.buffer);
      if (qScope) noteDisk(qScope, built.buffer.length - (qGate.prev || 0));
      const st = fs.statSync(f);
      return done(`已生成 ${dispPath(workspace, f)}：${built.sheets} 个工作表、共 ${built.rows} 行，${Math.round(st.size / 1024)}KB。`
        + `\n这是最终交付物，不需要再用 write_file 写一遍；正文只回结论摘要。`,
      { path: dispPath(workspace, f) });
    }

    if (name === 'make_doc') {
      const named = ensureExt(args.path, 'docx');
      if (named.error) return { ok: false, output: named.error, ms: Date.now() - started };
      const rel = named.path;
      const f = within(workspace, rel, fullAccess);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      /* 正文优先用 blocks（老通道），其次 markdown —— markdown 一般是模型刚写在回答里的那段，
         agent 侧会把它补进来，所以这里拿到的往往就是屏幕上已经看见的那篇 */
      let blocks = Array.isArray(args.blocks) ? args.blocks : [];
      let title = args.title;
      if (!blocks.length && args.markdown) {
        const parsed = mdToBlocks(args.markdown);
        blocks = parsed.blocks;
        if (!title) title = parsed.title;
      }
      if (!blocks.length) {
        return {
          ok: false, ms: Date.now() - started,
          output: '没有内容：先把正文用 Markdown 写在回答里（# 标题、## 小节、- 要点、| 表格），再调用 make_doc 只给 path 和 title。'
        };
      }
      let built;
      try { built = buildDocx({ title, subtitle: args.subtitle, blocks }); }
      catch (e) { return { ok: false, output: `文档没写出来：${e.message}`, ms: Date.now() - started }; }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      /* 生成类工具的内容已经在内存里（built.buffer），所以可以在写盘前精确判断。
         拒的时候要说清「东西是好的、只是没地方放」——否则模型会以为是内容错了，
         开始改参数重试，白烧几轮。 */
      const qScope = quotaScope(ctx);
      const qGate = quotaGate(qScope, f, built.buffer.length);
      if (!qGate.ok) {
        return {
          ok: false, code: qGate.code, quota: true, ms: Date.now() - started,
          output: `${qGate.error}\n（内容已经生成好了，只差没写盘——清理出空间后重试同一次调用即可）`
        };
      }
      const lease = leaseGate(ctx, f);
      if (!lease.ok) return { ok: false, code: 'lease', ms: Date.now() - started, output: lease.output };
      fs.writeFileSync(f, built.buffer);
      if (qScope) noteDisk(qScope, built.buffer.length - (qGate.prev || 0));
      const st = fs.statSync(f);
      return done(`已生成 ${dispPath(workspace, f)}：${built.blocks} 个内容块，${Math.round(st.size / 1024)}KB。`
        + `\n这是最终交付物，不需要再用 write_file 写一遍；正文只回结论摘要。`,
      { path: dispPath(workspace, f) });
    }

    if (name === 'find_image') {
      const q = String(args.query || '').trim();
      if (!q) return { ok: false, output: 'query 是空的，写清楚画面里要有什么。', ms: Date.now() - started };
      const want = Math.max(1, Math.min(Number(args.count) || 3, 6));
      const r = await imageSearch(q, want * 4);
      if (!r.ok) {
        return { ok: false, output: `没找到可用的图片（${r.error}）。改用无图版式：cards / kpi / chart / table / steps，不要编图片地址。`, ms: Date.now() - started };
      }
      const dir = path.join(workspace, 'assets');
      fs.mkdirSync(dir, { recursive: true });
      const saved = [];
      const seenSize = new Set();
      const slug = q.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, '-').slice(0, 18) || 'img';

      /* 图源排序：图库站（昵图/千图/千库…）出来的图基本都带水印或"AI生成"角标，
         商品实拍站（alicdn、京东、亚马逊）和免费图库（unsplash/pexels）干净得多。
         不硬过滤，只把干净的排前面——全站都是水印图时总比没图强，但要排在后面。 */
      const CLEAN = /(alicdn|alibaba|360buyimg|jd\.com|suning|amazon|unsplash|pexels|pixabay|wikimedia|static\.ikea|shopify)/i;
      const DIRTY = /(nipic|nximg|588ku|58pic|699pic|51yuansu|zcool|tuchong|huke88|pngtree|lovepik|shutterstock|gettyimages|veer|bigstock|dreamstime|istockphoto|qiantucdn|ooopic|16pic|zhituwang|51miz|sucai999|ztupic)/i;
      const rank = u => (CLEAN.test(u) ? 0 : DIRTY.test(u) ? 2 : 1);
      const cands = [...r.results].sort((a, b) => rank(a.url) - rank(b.url));

      for (const cand of cands) {
        if (saved.length >= want) break;
        let g;
        try { g = await grabBinary(cand.url, { timeout: 15000, headers: { referer: 'https://cn.bing.com/' } }); } catch { continue; }
        if (!g.ok || !g.buf || g.buf.length < 12000) continue;
        const isPng = g.buf.length > 8 && g.buf.readUInt32BE(0) === 0x89504e47;
        const isJpg = g.buf[0] === 0xFF && g.buf[1] === 0xD8;
        if (!isPng && !isJpg) continue;                       // webp/gif/bmp 一律不要：PowerPoint 兼容性差
        const size = imageSize(g.buf);
        if (!size.w || !size.h) continue;
        if (size.alpha) continue;                             // 透明底 PNG 配到满版/封面会露底，宁缺
        if (Math.min(size.w, size.h) < 500) continue;          // 缩略图不要，放大会糊
        if (size.w / size.h > 3.2 || size.h / size.w > 3.2) continue; // 长条图基本是 banner，别用
        const key = `${size.w}x${size.h}`;
        if (seenSize.has(key)) continue;                        // 同一张图的不同尺寸
        seenSize.add(key);
        const ext = isPng ? 'png' : 'jpg';
        const name = `assets/img-${slug}-${saved.length + 1}.${ext}`;
        fs.writeFileSync(path.join(workspace, name), g.buf);
        saved.push({ path: name, w: size.w, h: size.h, from: g.url, kb: Math.round(g.buf.length / 1024) });
      }
      if (!saved.length) {
        return { ok: false, output: '图源里没有能用的图（下载失败或全是缩略图）。改用无图版式，不要编图片地址。', ms: Date.now() - started };
      }
      const lines = saved.map((s, i) =>
        `${i + 1}. ${s.path}  ${s.w}×${s.h}  ${s.kb}KB  ← ${s.from.slice(0, 90)}`);
      return done(`搜「${q}」存下 ${saved.length} 张（${r.engine}）：\n${lines.join('\n')}\n\n`
        + `用法：make_deck 里对应页写 "image": "<上面的 path>"，配 split（图文分栏）/ image（满版）/ cover（封面背景）。\n`
        + `这些是公开检索到的图片，正式对外发布前请换成自有素材或授权图；页脚建议标一句「图片来自公开检索，仅作示意」。`,
        { files: saved.map(s => s.path) });
    }

    if (name === 'gen_image') {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) return { ok: false, output: 'prompt 是空的，写清楚要画什么。', ms: Date.now() - started };
      const aspect = String(args.aspect || 'square').toLowerCase();
      /* 免费生图通道按像素出图，尺寸砍一半、耗时差不多减半；
         1024 的方图在插件里也看不全，768 已经够用 */
      const dims = aspect === 'wide' ? { width: 1024, height: 576 }
        : aspect === 'tall' ? { width: 640, height: 854 }
          : { width: 768, height: 768 };
      const dir = path.join(workspace, 'assets');
      fs.mkdirSync(dir, { recursive: true });
      const slug = prompt.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, '-').slice(0, 20) || 'gen';
      const name2 = `assets/gen-${slug}-${Date.now().toString(36).slice(-4)}.jpg`;
      const finalPrompt = structureGuard(prompt);
      let g = { ok: false, error: '通道已熔断，跳过' };
      /* 通道刚挂过就直接跳过，别让员工再等十几秒 */
      if (!imageChannelDown()) {
        try { g = await genImage(finalPrompt, dims); } catch (e) { g = { ok: false, error: e.message }; }
      }

      /* ── 兜底：本地插画引擎 ──
         公共文生图通道常年排队（2026-11 起新图基本全是 402/503），等下去只会让老板
         看到一排红叉。这里用代码把图画出来：结构由几何决定，一个把手就是一条弧，
         不可能多画。老板要的是「看到设计稿」，不是「看到报错」。 */
      if (!g.ok) {
        try {
          const buf = renderIllustration(prompt, dims);
          const png = name2.replace(/\.jpe?g$/i, '.png');
          fs.writeFileSync(path.join(workspace, png), buf);
          const kind = illustrationKind(prompt);
          return done(`已出图 ${png}（${dims.width}×${dims.height}，${Math.round(buf.length / 1024)}KB）。\n`
            + `说明：公共文生图通道这会儿排队满了（${String(g.error || '').slice(0, 60)}），这张是工作台本地插画引擎画的`
            + `${kind === 'mug' ? '马克杯' : '主视觉'}设计稿——形状由几何图形生成，单个把手、单条杯口这类结构不会画错，配色按 prompt 里的关键词取，可以直接用。\n`
            + `用法：make_deck 里对应页写 "image": "${png}"，配 split（图文分栏）/ image（满版）/ cover（封面背景）。\n`
            + `**不要再调一次 gen_image 试运气**，通道恢复是上游的事，重试只会让老板多等十几秒。要换风格就改 prompt 里的颜色/图案关键词再来一次。\n`
            + `这是本地生成的插图，无版权与来源问题。`,
            { files: [png] });
        } catch (e) {
          return {
            ok: false,
            output: `图片生成失败：${g.error || e.message}。本地兜底也没成。改用 find_image 找现成图，或用无图版式（cards / kpi / chart / table）。`,
            ms: Date.now() - started
          };
        }
      }

      const size = imageSize(g.buf);
      fs.writeFileSync(path.join(workspace, name2), g.buf);
      return done(`已生成 AI 插图 ${name2}（${size.w || dims.width}×${size.h || dims.height}，${Math.round(g.buf.length / 1024)}KB）。\n`
        + `用法：make_deck 里对应页写 "image": "${name2}"，配 split（图文分栏）/ image（满版）/ cover（封面背景）。\n`
        + `交付前自己看一眼：有把手、壶嘴、肢体、轮子这类结构的地方最容易多画一个。数量不对就把 prompt 里的数量写死`
        + `（exactly one handle on the right side / one single object）再调一次 gen_image，最多重生成 2 次，别把画错的图直接交出去。\n`
        + `这是 AI 生成的原创插图，无版权风险；如果需要真实产品照片，改用 find_image。\n`
        + `注意：免费通道出的图右下角会带 pollinations.ai 水印，正式对外的物料要说明这一点，或改用授权通道。`,
        { files: [name2] });
    }

    if (name === 'search_text') {
      const base = within(workspace, args.path || '.', fullAccess);
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
            hits.push(`${dispPath(workspace, f.p)}:${i + 1}: ${line.trim().slice(0, 160)}`);
          }
        });
        if (hits.length >= 40) break;
      }
      return done(hits.length ? hits.join('\n') : '没有匹配结果。');
    }

    if (name === 'run_shell') {
      const cmd = String(args.command || '');
      /* 这一道只挡「顺手越界」，不是安全边界（见 sandbox.js 的实测记录）。
         真正的边界在 runIsolated 里：按 uid 降权 / namespace，或者直接拒绝。 */
      const why = shellDenied(cmd);
      if (why) return { ok: false, output: `命令被安全规则拦截：${why}。如确需执行，请你自己在终端运行。`, ms: Date.now() - started };
      const timeout = Math.min(Number(args.timeout_ms) || 20000, 120000);
      const scope = path.basename(path.resolve(workspace));
      const r = await runIsolated({ cmd, cwd: workspace, scope, timeout });
      if (r.refused) {
        return {
          ok: false, blocked: true,
          output: `没有执行：${r.reason}`,
          ms: Date.now() - started
        };
      }
      /* 退出码单独回传成结构化字段 code：校验方直接读这个数，不去正文里猜格式。
         以前正文里只有 'exit 1'，而校验方按「退出码：1」去正则，两边对不上，
         导致跑测试失败也判「命令正常返回」——验证等于没有。 */
      return done(`exit ${r.code}\n${r.stdout || ''}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`,
        { code: r.code, sandbox: r.mode });
    }

    if (name === 'todo_write') {
      const items = Array.isArray(args.items) ? args.items : [];
      ctx.onTodos?.(items);
      return done('待办已记录：\n' + items.map((t, i) => `${i + 1}. [${t.status || 'todo'}] ${t.text}`).join('\n'));
    }

    if (name === 'web_search') {
      const limit = Math.max(1, Math.min(Number(args.limit) || 6, 10));
      const r = await webSearch(args.query, limit);
      if (!r.ok) return { ok: false, output: `搜索没成功：${r.error}`, ms: Date.now() - started };
      const body = r.results
        .map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}${x.digest ? `\n   ${x.digest}` : ''}`)
        .join('\n\n');
      /* 兜底源给的常常是泛化结果。与其假装很准，不如把「这批可能不贴题」说出来。
         提示必须硬：实测不写死这一点，模型会连搜五次同类词，拿同一批泛化结果，最后把任务跑挂。 */
      const weak = !!r.weak || (r.dropped || 0) >= r.results.length;
      const head = `搜索「${args.query}」共 ${r.results.length} 条（来源：${r.engine}，检索于 ${new Date().toLocaleDateString('zh-CN')}）`;
      const tail = weak
        ? '这批结果和问题的贴合度不够（中文索引弱）。**不要再换相近的关键词重搜**——最多再换一次说法；' +
          '换不到就用已有信息给结论，查不到的写成「待核实：X」，并注明建议去哪查（官网 / 财报 / 行业数据库）。宁可写没查到，也不要编数字。'
        : '引用时把链接一起写进产出；摘要不等于原文，关键数字和条款用 fetch_url 打开核实。';
      return done(`${head}：\n\n${body}\n\n${tail}`);
    }

    if (name === 'fetch_url') {
      const r = await fetchPage(args.url, Math.max(2000, Math.min(Number(args.max_chars) || 12000, 30000)));
      if (!r.ok) return { ok: false, output: `打不开这个网页：${r.error}`, ms: Date.now() - started };
      const head = [r.title ? `标题：${r.title}` : '', `网址：${r.url}`].filter(Boolean).join('\n');
      const tail = r.truncated ? `\n\n…（原文共 ${r.total} 字符，这里只给了前一段；需要更多就用 max_chars 调大再抓一次）` : '';
      return done(`${head}\n\n${r.text}${tail}`);
    }

    if (name === 'read_doc') {
      const f = within(workspace, args.path, fullAccess);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      if (!fs.existsSync(f)) return { ok: false, output: `文件不存在：${args.path}。先 list_dir 看看 uploads/ 里有什么。`, ms: Date.now() - started };
      const cap = Math.max(2000, Math.min(Number(args.max_chars) || 24000, 40000));
      const res = await new Promise(resolve => {
        execFile(PYTHON, [PARSE_DOC, f, String(cap)], { timeout: 90000, maxBuffer: 12 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (stdout && stdout.trim()) return resolve({ raw: stdout });
            resolve({ err: (stderr || (err && err.message) || '解析器没有输出').slice(0, 300) });
          });
      });
      if (res.err) return { ok: false, output: `文档解析失败：${res.err}`, ms: Date.now() - started };
      let j;
      try { j = JSON.parse(res.raw); } catch { return { ok: false, output: '解析器返回的内容看不懂', ms: Date.now() - started }; }
      if (!j.ok) return { ok: false, output: String(j.error || '读不出来'), ms: Date.now() - started };
      const meta = j.meta || {};
      const bits = [
        meta.pages != null ? `${meta.pages} 页` : '',
        meta.sheets ? `${meta.sheets.length} 个工作表（${meta.sheets.join('、')}）` : '',
        meta.slides != null ? `${meta.slides} 页` : '',
        meta.tables != null ? `${meta.tables} 个表格` : '',
        meta.bytes ? (meta.bytes < 1024 ? `${meta.bytes}B` : `${Math.round(meta.bytes / 1024)}KB`) : ''
      ].filter(Boolean).join('，');
      return done(`文件：${args.path}（${String(j.kind || '').toUpperCase()}${bits ? '，' + bits : ''}）\n\n${j.text}`);
    }

    /* 看图：老板丢一张截图说「照这个做」，主模型未必是多模态的。
       这里用视觉模型把图「翻译」成结构化文字，主上下文只收这份描述——
       图里的布局、配色、关键文案都能落到文字上，接着就能写代码/写文档。
       不做 OCR 专用库：走同一条模型通道，容忍度更高（字体、气泡、图标都能讲）。 */
    if (name === 'view_image') {
      const f = within(workspace, args.path, fullAccess);
      if (!f) return { ok: false, output: '路径超出工作目录，已拒绝。', ms: Date.now() - started };
      if (!fs.existsSync(f)) {
        return { ok: false, output: `文件不存在：${args.path}。先 list_dir 看看 uploads/ 里有什么。`, ms: Date.now() - started };
      }
      const st = fs.statSync(f);
      if (st.isDirectory()) return { ok: false, output: '这是一个目录，不是图片。', ms: Date.now() - started };
      const ext = path.extname(f).toLowerCase();
      const MT = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
      };
      if (!MT[ext]) {
        return { ok: false, output: `不认识的图片格式「${ext || '无扩展名'}」，支持 png / jpg / webp / gif / bmp。`, ms: Date.now() - started };
      }
      if (st.size > 8 * 1024 * 1024) {
        return { ok: false, output: `图片太大（${fmtBytes(st.size)}），看图通道单张上限 8MB。`, ms: Date.now() - started };
      }
      const llm = ctx.llm || null;
      if (!llm || !llm.token) {
        return {
          ok: false,
          output: '看图通道还没就绪（这次任务没有拿到模型凭证）。先按图上的文字/老板的描述做，或者请老板把关键信息贴成文字。',
          ms: Date.now() - started
        };
      }
      if (!llm.model) {
        return {
          ok: false,
          output: '没有可用的视觉模型：当前通道里没有标注能看图的模型。'
            + '请老板在「全局模型」里换一个多模态模型（如 gpt-4o / gemini / qwen-vl / glm-4v），或者把图里的关键信息用文字发过来。',
          ms: Date.now() - started
        };
      }
      const MIME_DEF = MT[ext];
      const dataUrl = `data:${MIME_DEF};base64,${fs.readFileSync(f).toString('base64')}`;
      const ask = String(args.question || '').trim();
      const prompt = [
        '你是「看图」助手。请把这张图讲清楚，让一个看不见图的人能照着它干活。',
        '必须覆盖：',
        '1) 整体是什么（页面截图 / 设计稿 / 流程图 / 表格 / 照片 / 手写草图）；',
        '2) 布局与结构（从上到下、从左到右分几块，每块放什么，大致比例/位置关系）；',
        '3) 视觉细节（主色、辅色、背景、圆角/阴影/边框、字号层级、按钮样式）；',
        '4) 图上所有能读到的文字，按位置逐条抄下来（标题、正文、按钮、菜单、数字），一个字都别漏；',
        '5) 明显的数据/图表：指标名、数值、趋势。',
        ask ? `重点回答老板关心的：${ask}` : '',
        '只描述你确实看见的，看不清就说看不清，不要编。'
      ].filter(Boolean).join('\n');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 90000);
      let text = '';
      let served = '';
      try {
        for await (const chunk of chatStream({
          endpoint: llm.endpoint, token: llm.token, accessKey: llm.accessKey,
          signal: ctl.signal,
          payload: {
            model: llm.model,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }],
            temperature: 0.2
          }
        })) {
          if (!served && chunk && chunk.model) served = String(chunk.model);
          const d = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (d && d.content) text += d.content;
        }
      } catch (e) {
        const why = String((e && e.message) || e || '看图失败');
        return { ok: false, output: `看图失败：${why}`, ms: Date.now() - started };
      } finally {
        clearTimeout(timer);
      }
      if (!text.trim()) {
        return { ok: false, output: '看图模型没有返回内容（可能这张图触发了内容审核，或通道不支持图片输入）。', ms: Date.now() - started };
      }
      return done(`图：${dispPath(workspace, f)}（${served || llm.model} 看的内容）\n\n${text.trim()}`);
    }

    return { ok: false, output: `未知工具 ${name}`, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, output: `工具执行出错：${e.message}`, ms: Date.now() - started };
  }
}

export const __test = { ensureExt, within, dispPath };
