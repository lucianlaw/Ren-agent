/* 回收站：删除只做「移走」，不做「抹掉」
 *
 * 为什么要单独一层
 *   这个应用删掉的是用户自己的工作文件（报价表、合同、原型）。直接 unlink 之后
 *   没有任何恢复路径——一次误点就没了，而「误点」是这类界面最常见的操作。
 *   所以删除 = 移到 <工作区>/.trash/<id>/<原路径>，配上一条 meta.json 记住原位置。
 *
 * 三条硬规矩
 *   ① 只能动自己工作区里的东西：路径解析后必须仍在 root 内，且不能指向 .trash 自己。
 *   ② 挪不动就报错，不退回「删掉」——跨设备 rename 失败时用 copy+unlink，
 *      但复制失败绝不 unlink，否则就是「说好了能恢复，其实已经没了」。
 *   ③ 回收站也占磁盘：它算在配额里（这是诚实的——数据还在盘上）。
 *      想真腾出空间就点「清空回收站」，那一步才是真删。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NAME = '.trash';

export function trashPath(root) {
  return path.join(root, NAME);
}

/* 一个路径有多大：文件就 stat，目录递归累加（上限内），用于告诉用户「腾出多少」 */
function sizeOf(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      total += sizeOf(path.join(abs, e.name));
    }
    return total;
  } catch { return 0; }
}

function copyThenRemove(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
  /* 复制成功之后才敢删原件。顺序反了就等于先毁证再备份。 */
  fs.rmSync(src, { recursive: true, force: true });
}

/**
 * 把 root 下的 rel 移进回收站。
 * @returns {{ok:boolean, id?:string, path?:string, bytes?:number, error?:string}}
 */
export function moveToTrash(root, rel, { now = Date.now() } = {}) {
  const r = String(rel == null ? '' : rel).trim();
  if (!r || r === '.' || r === './') return { ok: false, error: '要删哪个？请给出路径（不能是工作区根目录）' };
  const abs = path.resolve(root, r);
  const relSafe = path.relative(root, abs);
  if (!relSafe || relSafe.startsWith('..') || path.isAbsolute(relSafe)) {
    return { ok: false, error: '路径超出工作区，已拒绝' };
  }
  if (relSafe.split(path.sep)[0] === NAME) {
    return { ok: false, error: '回收站本身不能这样删；要清空请用「清空回收站」' };
  }
  if (!fs.existsSync(abs)) return { ok: false, error: '这个文件不在了' };

  const bytes = sizeOf(abs);
  const id = `${now}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(root, NAME, id);
  const dest = path.join(dir, relSafe);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(abs, dest);
    } catch {
      /* 跨设备（工作区可能被挂到别处）时 rename 会 EXDEV，退回复制再删 */
      copyThenRemove(abs, dest);
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      id, path: relSafe, at: new Date(now).toISOString(), bytes,
      kind: path.extname(relSafe).replace('.', '') || 'dir'
    }, null, 2) + '\n');
  } catch (e) {
    return { ok: false, error: `移进回收站失败：${(e && e.message) || e}` };
  }
  return { ok: true, id, path: relSafe, bytes };
}

export function listTrash(root) {
  const base = trashPath(root);
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return { items: [], bytes: 0 }; }
  const items = [];
  let bytes = 0;
  for (const d of dirs) {
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(base, d.name, 'meta.json'), 'utf8')); } catch { /* 没 meta 也列出来 */ }
    const size = meta && Number(meta.bytes) ? Number(meta.bytes) : sizeOf(path.join(base, d.name));
    bytes += size;
    items.push({
      id: d.name,
      path: (meta && meta.path) || '',
      at: (meta && meta.at) || '',
      bytes: size
    });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return { items, bytes };
}

/** 恢复：回到原路径。目标已存在就拒绝——静默覆盖比不恢复更糟。 */
export function restoreFromTrash(root, id) {
  const key = String(id || '');
  if (!/^[\d]+-[0-9a-f]{6}$/.test(key)) return { ok: false, error: 'id 不合法' };
  const dir = path.join(trashPath(root), key);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch {
    return { ok: false, error: '这条回收站记录已经不在（可能清空过）' };
  }
  const rel = String(meta.path || '');
  const dest = path.resolve(root, rel);
  if (!path.relative(root, dest) || path.relative(root, dest).startsWith('..')) {
    return { ok: false, error: '记录里的路径不合法，拒绝恢复' };
  }
  if (fs.existsSync(dest)) {
    return { ok: false, error: `${rel} 现在已经有同名文件了；先改名或删掉它再恢复` };
  }
  const src = path.join(dir, rel);
  if (!fs.existsSync(src)) return { ok: false, error: '回收站里找不到这份内容' };
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.renameSync(src, dest);
    } catch {
      copyThenRemove(src, dest);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `恢复失败：${(e && e.message) || e}` };
  }
  return { ok: true, path: rel };
}

/** 真删。这是唯一会不可逆地丢数据的入口，所以单独一个动作、单独确认。 */
export function emptyTrash(root) {
  const base = trashPath(root);
  const before = listTrash(root);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {
    return { ok: false, error: `清空失败：${(e && e.message) || e}` };
  }
  return { ok: true, removed: before.items.length, bytes: before.bytes };
}

/** 清空整个工作区：顶层条目逐个进回收站（不是直接删），所以还能恢复。 */
export function clearWorkspace(root) {
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return { ok: false, error: '工作区读不到' }; }
  const moved = [];
  const failed = [];
  for (const e of ents) {
    if (e.name === NAME) continue;            /* 回收站自己不动 */
    const r = moveToTrash(root, e.name);
    if (r.ok) moved.push({ name: e.name, bytes: r.bytes });
    else failed.push({ name: e.name, error: r.error });
  }
  return { ok: true, moved, failed, bytes: moved.reduce((s, x) => s + (x.bytes || 0), 0) };
}
