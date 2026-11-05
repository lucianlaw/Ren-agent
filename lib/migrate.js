// 旧工作区一次性迁移
//
// 换到「账号即工作区」之后，老用户 localStorage 里那个随机串指向的目录还在磁盘上，
// 但新目录是另一个名字。这里把旧目录里的文件搬过去，避免升级后看起来「文件全没了」。
//
// 三条硬规矩：
//   1. 幂等：目标目录里记一笔 .migrated.json，同一个来源再调直接返回上次结果，不重复搬。
//   2. 不覆盖更新的：同名文件只在目标不存在、或源比目标更新时才写；用户在新目录里
//      改过的文件不能被一份旧副本盖回去。
//   3. 有上限：旧目录可能被塞了几万个文件，迁移是自动触发的，不能让它把磁盘写满。
import fs from 'node:fs';
import path from 'node:path';
import { scopeRoot, ensureScope, WORKSPACE_BASE } from './workspace.js';

const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;
const MARK = '.migrated.json';
/* 旧串归属表：一个旧目录只能被搬到第一个来认领的账号。
   少了这道锁，同一台电脑换账号时，后登录的人会把前一个人的文件搬到自己名下
   ——旧串是浏览器级的，它本身不知道属于谁，只能靠「先到先得」定归属。 */
const INDEX = path.join(WORKSPACE_BASE, 'migrations', 'legacy-index.json');

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')) || {}; } catch { return {}; }
}

function claim(legacy, to) {
  const idx = readIndex();
  const cur = idx[legacy];
  if (cur && cur.to !== to) return { ok: false, to: cur.to, at: cur.at };
  if (!cur) {
    idx[legacy] = { to, at: Date.now() };
    fs.mkdirSync(path.dirname(INDEX), { recursive: true });
    const tmp = `${INDEX}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 1));
    fs.renameSync(tmp, INDEX);
  }
  return { ok: true };
}

function readMark(to) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(to, MARK), 'utf8'));
    return Array.isArray(j.sources) ? j : { sources: [] };
  } catch { return { sources: [] }; }
}

function writeMark(to, mark) {
  fs.writeFileSync(path.join(to, MARK), JSON.stringify(mark, null, 1));
}

/**
 * 把 fromScope 目录的内容搬到 toScope 目录。
 * @returns {{ok:true, copied:number, skipped:number, bytes:number, capped?:string,
 *            from:string, to:string, at:number, cached?:number}|{ok:false, error:string}}
 */
export function migrateScope(fromScope, toScope) {
  if (fromScope === toScope) return { ok: true, copied: 0, skipped: 0, bytes: 0, same: true, from: fromScope, to: toScope, at: Date.now() };

  const from = scopeRoot(fromScope);
  const to = scopeRoot(toScope);
  if (!from || !to) return { ok: false, error: '工作区标识不合法' };
  if (!fs.existsSync(from)) return { ok: true, copied: 0, skipped: 0, bytes: 0, missing: true, from: fromScope, to: toScope, at: Date.now() };

  /* 认领：同一旧目录只归第一个搬它的账号。换账号登录时后者拿不到，
     提示一句就够，不要把对方的工作区标识回给前端。 */
  const own = claim(fromScope, toScope);
  if (!own.ok) {
    return { ok: true, copied: 0, skipped: 0, bytes: 0, claimed: true, from: fromScope, to: toScope, at: own.at };
  }
  /* 先建空目录再搬，最后才铺种子：反过来的话种子文件 mtime 更新，
     「目标更新就不动」会把用户旧文件挡在门外，人就会觉得自己改过的文件被覆盖了 */
  fs.mkdirSync(to, { recursive: true });

  const mark = readMark(to);
  const done = mark.sources.find(s => s.from === fromScope);
  if (done) {
    /* 已经迁过一次：直接回报上次的数字。前端每次登录都会问一遍，不能每次都重新扫盘。 */
    return { ok: true, copied: done.copied, skipped: done.skipped, bytes: done.bytes, cached: done.at, from: fromScope, to: toScope, at: done.at };
  }

  let copied = 0, skipped = 0, bytes = 0, capped = '';

  const walk = (rel) => {
    if (capped) return;
    const srcDir = path.join(from, rel);
    let ents = [];
    try { ents = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (capped) return;
      /* 不搬内部标记：.seeded 决定「首次铺种子」，.migrated.json 是本次迁移的账本 */
      if (e.name === '.seeded' || e.name === MARK) continue;
      const r = rel ? path.join(rel, e.name) : e.name;
      const s = path.join(from, r);
      const d = path.join(to, r);
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        walk(r);
        continue;
      }
      if (!e.isFile()) continue;
      if (copied >= MAX_FILES) { capped = `文件超过 ${MAX_FILES} 个，后面的没搬`; return; }
      let st;
      try { st = fs.statSync(s); } catch { continue; }
      if (bytes + st.size > MAX_BYTES) { capped = `总量超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB，后面的没搬`; return; }
      /* 目标更新就不动它：用户可能已经在新目录里改过同名文件 */
      try {
        const t = fs.statSync(d);
        if (t.mtimeMs >= st.mtimeMs) { skipped++; continue; }
      } catch { /* 目标不存在，正常搬 */ }
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      /* 保留原时间：否则旧文件会变成「刚刚写过」，交付物校验按 mtime 判「这一轮新写的」会误判 */
      try { fs.utimesSync(d, st.atime, st.mtime); } catch { /* 不致命 */ }
      copied++;
      bytes += st.size;
    }
  };

  try {
    walk('');
  } catch (e) {
    return { ok: false, error: `迁移中断：${e.message}` };
  }

  /* 搬完再补种子：目标已存在的同名文件不会被覆盖（ensureScope 内部就是这么判的） */
  try { ensureScope(toScope); } catch { /* 种子铺不上不影响已经搬过去的文件 */ }

  const at = Date.now();
  mark.sources.push({ from: fromScope, at, copied, skipped, bytes, capped });
  try { writeMark(to, mark); } catch { /* 账本写不上不影响已经搬过去的文件 */ }

  return { ok: true, copied, skipped, bytes, capped, from: fromScope, to: toScope, at };
}
