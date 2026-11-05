// 权限的服务端副本
//
// 以前 /api/tool 直接信前端传来的 perms：绕过 UI 直接打接口就能把「跑命令」打开，
// 服务端那句「权限在这里再兜一次」实际兜的是调用者自己填的表格。
// 现在服务端按工作区存一份，前端传的只能收紧、不能放宽：
//   - 服务端记录说 exec=false，前端传 true 也不给跑；
//   - 前端传 false 则立刻生效（用户在这一轮主动收紧）。
// 放宽权限只能走 POST /api/perms，那条路会留审计。
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_BASE } from './workspace.js';

const DIR = path.join(WORKSPACE_BASE, 'perms');
export const PERM_CATS = ['read', 'write', 'exec', 'net'];
/* 和前端 state.settings.permissions 的默认值保持一致：
   写文件默认开，跑命令默认关——这是产品有意为之的默认档 */
export const DEFAULT_PERMS = { read: true, write: true, exec: false, net: true };

function norm(p) {
  const o = {};
  for (const k of PERM_CATS) o[k] = !!(p && p[k] === true);
  return o;
}

function fileOf(scope) {
  /* scope 只可能是 32 位十六进制（derive 出来的或旧的随机串），
     再洗一遍是防御性的：不要拿外部输入直接拼路径 */
  const s = String(scope || '').replace(/[^a-f0-9]/g, '');
  return s.length === 32 ? path.join(DIR, `${s}.json`) : null;
}

export function loadPerms(scope) {
  const f = fileOf(scope);
  if (!f) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { perms: norm(j.perms || j), at: Number(j.at) || 0, by: String(j.by || '') };
  } catch { return null; }
}

export function savePerms(scope, perms, by) {
  const f = fileOf(scope);
  if (!f) return null;
  const rec = { perms: norm(perms), at: Date.now(), by: String(by || '') };
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 1));
  fs.renameSync(tmp, f);   /* 原子替换：并发请求不会读到半截 */
  return rec;
}

/**
 * 得出这一步真正能用的权限。
 * @param sent 前端这次带来的 perms（可能为空）
 * @returns {{perms:object, source:'stored'|'init', saved:object|null, storedAt:number}}
 */
export function effectivePerms(scope, sent) {
  const got = loadPerms(scope);
  if (!got) {
    /* 服务端还没有记录：首次调用。此时前端刚从云端读回自己的设置，
       没有别的可信来源，所以允许用 sent 初始化。
       但只能「收紧」，不能「放宽」：直接打 /api/tool 并在请求体里写 exec:true
       就是绕过 /api/perms 的那条路（2026-11-04 多用户复查时实测通过）。
       所以初始化时以 DEFAULT_PERMS 为上限——默认关的（跑命令）必须走 /api/perms
       才能打开，那条路留审计。 */
    const base = {};
    for (const k of PERM_CATS) base[k] = DEFAULT_PERMS[k] === true && !(sent && sent[k] === false);
    return { perms: base, source: 'init', saved: savePerms(scope, base, 'init'), storedAt: 0 };
  }
  const out = {};
  for (const k of PERM_CATS) out[k] = got.perms[k] === true && !(sent && sent[k] === false);
  return { perms: out, source: 'stored', saved: got, storedAt: got.at };
}
