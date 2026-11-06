/* 数据目录的默认值：测试进程不许落到真实的 data/ 下。
 *
 * 这条规矩原先散在三个库里（config / probe / quota），各自抄了一遍；
 * 后来加的库没抄，于是测试跑一遍就往项目真实的 data/ 里写审计日志和报错记录。
 * 表现出来是发布闸门那道「部署目录不许有运行时数据」突然拦下来——
 * 拦得对，但根因是测试在污染部署目录。
 *
 * 判据刻意保守：只有「显式给了环境变量」或者「入口确实是 test/*.mjs」
 * 才改变落点，其余一律照旧。任何一个起 server 的测试都会走到记账路径，
 * 写进真实目录就变成「测试跑一遍，线上数据多一截」这种查不出来的怪事。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = String(process.argv[1] || '');

export function isTestEntry(entry = ENTRY) {
  return /[\\/]test[\\/][^\\/]+\.mjs$/.test(String(entry));
}

/* 取一个数据目录：显式 env > 测试兜底 > 生产默认
   name 是 data/ 下的子目录名，也是 tmp 前缀。 */
export function dataDir(envKey, name, { entry = ENTRY, env = process.env } = {}) {
  const custom = String(env[envKey] || '').trim();
  if (custom) return path.resolve(custom);
  if (isTestEntry(entry)) return path.join(os.tmpdir(), `ren-${name}-test`);
  return path.join(ROOT, 'data', name);
}

/* 建好再用。建不了不抛——各库原本的语义就是「不可写就静默降级」。 */
export function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 忽略 */ }
  return dir;
}
