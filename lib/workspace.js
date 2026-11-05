// 工作区：每个浏览器实例一个隔离目录，工具只能在这个目录里活动
// scope 由前端生成的 32 位十六进制随机串充当「能力凭证」——猜不到，也就进不来别人的目录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hardenTenant } from './sandbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const SCOPE_RE = /^[a-f0-9]{32}$/;

function usableDir(preferred, fallbackName) {
  try {
    fs.mkdirSync(preferred, { recursive: true });
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const t = path.join(os.tmpdir(), fallbackName);
    fs.mkdirSync(t, { recursive: true });
    return t;
  }
}

const BASE = usableDir(
  process.env.WORKSPACE_DIR ? path.resolve(process.env.WORKSPACE_DIR) : path.join(ROOT, 'workspace'),
  'boss-agent-workspace'
);
const SCOPES = path.join(BASE, 'users');

/* 种子文件：线上第一次打开就能直接测，而不是一个空壳 */
const SEED_FILES = {
  'README.md': `# 工作区

这是当前登录账号的私有工作目录。员工所有的读写、命令都在这里发生，出不去。

右上角三个开关：**读文件 / 写文件 / 跑命令**。
「写文件」默认开着，「跑命令」默认关着——需要时你手动开，这也是有意的。

试一句：\`看看这里有什么\`
`,

  '报价表/2026-11-W1.md': `# 包装材料询价 · 2026-11 第 1 周

采购物料：五层瓦楞纸箱 40x30x25cm
本周需求：8000 个

| 供应商 | 报价 | 计价单位 | 起订量 | 交期 | 备注 |
|---|---|---|---|---|---|
| 华东包装 | 3.20 | 元/个 | 5000 | 15 天 | 含运费，含税 |
| 立信纸品 | 295 | 元/箱 | 10000 | 22 天 | 不含运费，运费 0.12/个，含税 |
| 新联包装 | 3.05 | 元/个 | 8000 | 18 天 | 可开专票，运费按 3 元/箱另计 |
| 恒通纸业 | 12.8 | 元/套 | 2000 | 12 天 | 一套 4 个，含运费，不含税 |
| 南方包装 | 2.98 | 元/个 | 12000 | 25 天 | 含运费，不含税 |
| 鑫源 | 3.10 | 元/个 | 3000 | 20 天 | 运费到付，约 800 元/车，一车 6000 个 |
`,

  '合同/采购框架协议_草稿.md': `# 采购框架协议（草稿）

甲方：本公司
乙方：华东包装有限公司

## 第五条 违约责任
乙方逾期交货的，每逾期一日，按未交付货物总金额的 3% 向甲方支付违约金。

## 第六条 争议解决
因本协议发生的争议，提交上海仲裁委员会仲裁。

## 第七条 付款
甲方于收货后 90 日内付清全款。
`
};

export function scopeRoot(scope) {
  if (!SCOPE_RE.test(String(scope || ''))) return null;
  return path.join(SCOPES, scope);
}

/** 首次访问时把种子文件铺进去 */
export function ensureScope(scope) {
  const root = scopeRoot(scope);
  if (!root) return null;
  const fresh = !fs.existsSync(path.join(root, '.seeded'));
  fs.mkdirSync(root, { recursive: true });
  if (fresh) {
    for (const [rel, content] of Object.entries(SEED_FILES)) {
      const p = path.join(root, rel);
      if (fs.existsSync(p)) continue;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
    }
    fs.writeFileSync(path.join(root, '.seeded'), new Date().toISOString());
    /* 新账号的目录默认是 755：在用户还没往里放东西之前就交给它的 uid 并关到 700。
       不补这一步，会有一个窗口——目录建好、文件上传了、但还没跑过 shell，
       这时别的账号降权后照样能读。 */
    try { hardenTenant(root, scope); } catch { /* 非 root 环境直接跳过 */ }
  }
  return root;
}

/* ── 工作区归属标记 ──
   迁移接口要判断「这个旧目录有没有主」。光看目录名不行：派生的 scope 也是 32 位十六进制，
   和旧随机串长得一模一样，分不出来。所以给每个被验明身份的目录放一个 .owner 文件。
   - 有 .owner 且不是自己 → 拒绝迁移（防止有人把自己目录认领走，或反过来把别人的旧目录搬进自己名下）
   - 没有 .owner → 旧版本留下的目录，允许第一次认领（迁移本来就是给它们用的） */
export function markOwner(scope, uid) {
  const root = scopeRoot(scope);
  const id = String(uid || '');
  if (!root || !id) return false;
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '.owner'), id, 'utf8');
    return true;
  } catch { return false; }
}

export function ownerOf(scope) {
  const root = scopeRoot(scope);
  if (!root) return '';
  try { return String(fs.readFileSync(path.join(root, '.owner'), 'utf8')).trim(); }
  catch { return ''; }
}

/** 路径围栏：解析后必须还在工作区内 */
export function inside(root, rel) {
  if (!root) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, String(rel || '.'));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export function listFiles(scope, rel) {
  const root = scopeRoot(scope);
  if (!root) return { error: '工作区标识不合法' };
  const target = inside(root, rel || '.');
  if (!target) return { error: '路径超出工作区' };
  let ents = [];
  try { ents = fs.readdirSync(target, { withFileTypes: true }); }
  catch { return { items: [], root: rel || '.' }; }
  const items = ents
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const p = path.join(target, e.name);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(p); size = st.size; mtime = st.mtimeMs; } catch { /* ignore */ }
      return {
        name: e.name,
        dir: e.isDirectory(),
        path: path.relative(root, p).split(path.sep).join('/'),
        size, mtime
      };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { items, root: rel || '.' };
}

export function readTextFile(scope, rel, limit = 2 * 1024 * 1024) {
  const root = scopeRoot(scope);
  if (!root) return { error: '工作区标识不合法' };
  const target = inside(root, rel);
  if (!target) return { error: '路径超出工作区' };
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) return { error: '这是目录' };
    if (st.size > limit) return { error: '文件太大（>2MB）' };
    return { text: fs.readFileSync(target, 'utf8'), size: st.size };
  } catch {
    return { error: '文件不存在' };
  }
}

export const WORKSPACE_BASE = BASE;
