// 版本号比较与递增
//
// 抽出来的原因很实际：这段逻辑原来写在 scripts/release.mjs 里，而那个文件一被 import
// 就会跑满四道门（含全量测试）。于是它成了整个项目里唯一没人测、也测不了的一段代码——
// 偏偏它决定「线上那个版本号算不算新」，判错的后果是「代码是新的、health 报旧版本」，
// 而那正是回滚时唯一的定位依据。
//
// 比较按**数字**而不是字符串：'0.8.10' > '0.8.9'。按字符串比会把 0.8.10 判成更小。

export function verNum(v) {
  return String(v == null ? '0' : v)
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map(n => Number(n) || 0);
}

/** a > b 返回 1，a < b 返回 -1，相等 0。缺位当 0（1.2 == 1.2.0）。 */
export function verCmp(a, b) {
  const x = verNum(a), y = verNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** patch +1。保留 major.minor；多余段（0.8.7.3）会被截掉——发布只认三段。 */
export function bumpPatch(v) {
  const a = verNum(v);
  return `${a[0] || 0}.${a[1] || 0}.${(a[2] || 0) + 1}`;
}

/** 发布口径：package.json 的版本必须严格大于上次发布记录，否则取 patch+1。 */
export function nextVersion(current, lastReleased) {
  if (!lastReleased) return { version: current, bumped: false };
  if (verCmp(current, lastReleased) > 0) return { version: current, bumped: false };
  return { version: bumpPatch(current), bumped: true };
}
