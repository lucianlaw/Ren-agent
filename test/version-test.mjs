/* 版本号：按数字比，只增不减
 *
 * 这段逻辑原来写在 scripts/release.mjs 里，而那个文件一被 import 就会跑满四道门，
 * 于是它成了整个项目里唯一没人测、也测不了的一段——偏偏它决定「线上那个版本号
 * 算不算新」。判错的后果是「代码是新的、health 报旧版本」，而那正是回滚时唯一的定位依据。
 *
 * 最容易错的一处：字符串比较会把 0.8.10 判成比 0.8.9 小。
 * 这不是理论问题——patch 号过 9 之后每次自动递增都会撞上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const V = await import('../lib/version.js');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');

console.log('\n[1] 解析：容错但不乱来');
{
  eq('普通三段', V.verNum('0.8.7'), [0, 8, 7]);
  eq('两段补一位', V.verNum('1.2'), [1, 2]);
  eq('带 v 前缀', V.verNum('v1.2.3'), [1, 2, 3]);
  eq('空值当 0', V.verNum(''), [0]);
  eq('undefined 当 0', V.verNum(undefined), [0]);
  eq('非数字段当 0', V.verNum('1.x.3'), [1, 0, 3]);
}

console.log('\n[2] 比较：数字序，不是字典序');
{
  eq('0.8.10 > 0.8.9（字符串比较会判反）', V.verCmp('0.8.10', '0.8.9'), 1);
  ok('对照：字典序确实是反的', '0.8.10' < '0.8.9');
  eq('相等', V.verCmp('0.8.7', '0.8.7'), 0);
  eq('缺位补 0 视为相等', V.verCmp('1.2', '1.2.0'), 0);
  eq('major 优先', V.verCmp('2.0.0', '1.99.99'), 1);
  eq('minor 优先于 patch', V.verCmp('0.9.0', '0.8.99'), 1);
  eq('小于', V.verCmp('0.8.6', '0.8.7'), -1);
}

console.log('\n[3] 递增：只动 patch');
{
  eq('0.8.7 → 0.8.8', V.bumpPatch('0.8.7'), '0.8.8');
  eq('0.8.9 → 0.8.10', V.bumpPatch('0.8.9'), '0.8.10');
  eq('0.9.99 → 0.9.100', V.bumpPatch('0.9.99'), '0.9.100');
  eq('一位版本也能升', V.bumpPatch('1'), '1.0.1');
  eq('多出来的段被截掉（发布只认三段）', V.bumpPatch('0.8.7.3'), '0.8.8');
}

console.log('\n[4] 发布判定：package.json 必须严格大于上次发布记录');
{
  eq('没记录（第一次发布）不动它', V.nextVersion('0.8.7', ''), { version: '0.8.7', bumped: false });
  eq('手动升过了就不再动', V.nextVersion('0.8.8', '0.8.7'), { version: '0.8.8', bumped: false });
  eq('忘了升：自动 +1', V.nextVersion('0.8.7', '0.8.7'), { version: '0.8.8', bumped: true });
  eq('比上次还旧：也 +1（只增不减）', V.nextVersion('0.8.5', '0.8.7'), { version: '0.8.6', bumped: true });
  eq('跳过 9 的边界：0.8.10 比 0.8.9 新，不动', V.nextVersion('0.8.10', '0.8.9'), { version: '0.8.10', bumped: false });
}

console.log('\n[5] 接线：闸门真的用这一份，而不是又抄了一遍');
{
  const rel = fs.readFileSync(path.join(APP, 'scripts', 'release.mjs'), 'utf8');
  ok('闸门 import 了 lib/version.js', /import \{ nextVersion \} from '\.\.\/lib\/version\.js'/.test(rel));
  ok('闸门里不再自己写 verCmp/bumpPatch', !/function verCmp/.test(rel) && !/function bumpPatch/.test(rel));
  ok('版本不一致时会提交（否则下一次闸门第 1 道会挂）', /git\(\['commit', '-m', `chore\(version\)/.test(rel), '');
  ok('--check 只提示不改文件', /__CHECK__|CHECK_ONLY\) \{\s*$/.test(rel) || /CHECK_ONLY/.test(rel));
  ok('build.json 记的版本来自 package.json', /version: \(\(\) => \{[\s\S]{0,200}package\.json[\s\S]{0,80}version/.test(rel), '');

  const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
  const build = JSON.parse(fs.readFileSync(path.join(APP, 'build.json'), 'utf8'));
  /* 允许「已手动升过、还没发布」的状态：package 必须 ≥ build */
  ok('package.json 版本不低于上次发布记录的版本',
    V.verCmp(pkg.version, build.version) >= 0, { pkg: pkg.version, build: build.version });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
