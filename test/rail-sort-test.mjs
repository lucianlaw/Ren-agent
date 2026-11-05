/* 左栏排序：任务 / 项目都按「最近修改时间」倒序，置顶的仍在最前。

   以前按创建时间排：接着聊一句老任务，它还是沉在下面——
   在 37 个任务里翻半天才能找回来。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const cloudSrc = fs.readFileSync(path.join(root, 'public/cloud.js'), 'utf8');
const meetSrc = fs.readFileSync(path.join(root, 'public/meeting.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 求值真正的排序函数，别测复制品 */
const a = appSrc.indexOf('function sortRailItems(list)');
const b = appSrc.indexOf('function renderTaskList()');
ok('找得到 sortRailItems', a > 0 && b > a);
const { sortRailItems } = new Function(appSrc.slice(a, b) + '\nreturn { sortRailItems };')();

console.log('排序行为');
{
  const base = Date.parse('2026-11-01T10:00:00+08:00');
  const list = [
    { id: 'A', createdAt: base, updatedAt: base },                    // 创建最早、也没动过
    { id: 'B', createdAt: base + 2000, updatedAt: base + 2000 },
    { id: 'C', createdAt: base + 1000, updatedAt: base + 900000 }     // 建得早，但刚动过
  ];
  const out = sortRailItems(list).map(x => x.id).join('');
  ok('刚动过的排最前', out === 'CBA', out);
  ok('不改原数组', list.map(x => x.id).join('') === 'ABC');
}

console.log('置顶');
{
  const list = [
    { id: 'new', updatedAt: 3000 },
    { id: 'pin', updatedAt: 1000, pinned: true },
    { id: 'mid', updatedAt: 2000 }
  ];
  ok('置顶优先于时间', sortRailItems(list).map(x => x.id).join('') === 'pinnewmid');
  ok('两个置顶之间还是按时间', sortRailItems([
    { id: 'p1', updatedAt: 100, pinned: true },
    { id: 'p2', updatedAt: 900, pinned: true }
  ]).map(x => x.id).join('') === 'p2p1');
}

console.log('老数据兜底');
{
  ok('没有 updatedAt 用 createdAt', sortRailItems([
    { id: 'old', createdAt: 1000 },
    { id: 'new', createdAt: 5000 }
  ]).map(x => x.id).join('') === 'newold');
  ok('项目只有 at 也能排', sortRailItems([
    { id: 'm1', at: 100 },
    { id: 'm2', at: 800 }
  ]).map(x => x.id).join('') === 'm2m1');
  ok('时间全缺也不炸', sortRailItems([{ id: 'x' }, { id: 'y' }]).length === 2);
  ok('空列表返回空', sortRailItems([]).length === 0 && sortRailItems(null).length === 0);
}

console.log('任务线接线');
{
  ok('taskFromRow 带出 updatedAt', /updatedAt: Date\.parse\(r\.updated_at\) \|\| Date\.parse\(r\.created_at\) \|\| Date\.now\(\)/.test(cloudSrc));
  ok('查任务按 updated_at 倒序取', /from\('ba_tasks'\)[\s\S]{0,80}order\('updated_at'/.test(cloudSrc));
  ok('左栏任务用同一套排序', /const list = sortRailItems\(state\.tasks\)/.test(appSrc));
  ok('任务日期显示最近修改那天', /const stamp = t\.updatedAt \|\| t\.createdAt \|\| t\.at;/.test(appSrc));
  ok('任务保存时刷新 updatedAt', /task\.updatedAt = Date\.now\(\);\s*\n\s*if \(state\.guest/.test(appSrc));
  ok('跑一轮也刷新 updatedAt', /t\.updatedAt = Date\.now\(\);\s*\n\s*const steps = buildSteps\(t\);/.test(appSrc));
  ok('收工也刷新 updatedAt', /t\.updatedAt = Date\.now\(\);\s*\n\s*\/\* 收工立刻归档一次/.test(appSrc));
}

console.log('项目线接线');
{
  ok('meetingFromRow 带出 updatedAt', /updatedAt: Date\.parse\(r\.updated_at\) \|\| at,/.test(cloudSrc));
  ok('查项目按 updated_at 倒序取', /from\('ba_meetings'\)[\s\S]{0,80}order\('updated_at'/.test(cloudSrc));
  ok('项目列表走共用排序', /window\.APP\.sortRailItems\(st\.meetings\)/.test(meetSrc));
  ok('项目日期显示最近修改那天', /const stamp = m\.updatedAt \|\| m\.at;/.test(meetSrc));
  ok('项目保存时刷新 updatedAt', /m\.updatedAt = Date\.now\(\);\s*\n\s*const st = S\(\);/.test(meetSrc));
  ok('新建项目就带上 updatedAt', (meetSrc.match(/at: Date\.now\(\),\s*\n\s*updatedAt: Date\.now\(\)/g) || []).length === 2);
  ok('at 没被当成排序键（目录名依赖它）', !/return \(b\.at \|\| 0\) - \(a\.at \|\| 0\)/.test(meetSrc));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
