/* 部署包体检：运行时数据不许跟着上传
 *
 * 这一条不是「整洁癖」。`data/` 和 `workspace/` 都在 .gitignore 里，所以
 * 「工作区干净」那道门对它们完全放行；而发布工具传的是目录，不是 commit。
 * 于是本地跑过的东西会一起上线上，装成生产数据。
 *
 * 真实踩到过：线上 health 里出现「修复过 2 轮、当前接着某个 16 位号在修」，
 * 而那个工单号在线上根本不存在；工单列表里多出一张从没发生过的 E_UI_RENDER。
 * 全程不报错——唯一的发现方式是记得自己没造过这些数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { runtimeDataFiles, RUNTIME_DIRS, explain } from '../lib/deployguard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deployguard-'));
const mk = (rel, body = '{}') => {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

console.log('\n[1] 干净目录：放行');
{
  ok('空目录没有运行时数据', runtimeDataFiles(TMP).length === 0);
  mk('server.js', '// code');
  mk('lib/x.js', '// code');
  ok('只有代码也放行', runtimeDataFiles(TMP).length === 0, runtimeDataFiles(TMP));
}

console.log('\n[2] data/ 下任何一个文件都要被叫出来');
{
  mk('data/tickets/abcdef0123456789.json');
  const f = runtimeDataFiles(TMP);
  ok('报出工单状态文件', f.includes('data/tickets/abcdef0123456789.json'), f);

  mk('data/repair/decisions/2026-11-07.jsonl');
  ok('看得到嵌套目录里的分诊决策',
    runtimeDataFiles(TMP).includes('data/repair/decisions/2026-11-07.jsonl'));

  /* 这一条是最坏的：同名文件会把线上那一天的真实报错覆盖掉 */
  mk('data/incidents/2026-11-06.jsonl');
  ok('报错日志也要报出来（同名会覆盖线上那一天）',
    runtimeDataFiles(TMP).includes('data/incidents/2026-11-06.jsonl'));

  ok('路径带目录前缀（只说文件名没法定位）', runtimeDataFiles(TMP).every(p => p.includes('/')));
  ok('结果排过序（同一次体检两次输出一致）',
    JSON.stringify(runtimeDataFiles(TMP)) === JSON.stringify(runtimeDataFiles(TMP)));
}

console.log('\n[3] 用户工作区同样不许跟走');
{
  mk('workspace/memory/u1/project/p1.md', '# 用户文件');
  ok('workspace 下的文件被报出', runtimeDataFiles(TMP).includes('workspace/memory/u1/project/p1.md'));
}

console.log('\n[4] 状态库：带不带点都要认');
{
  mk('.ren-state/runs.json');
  ok('.ren-state 被报出', runtimeDataFiles(TMP).includes('.ren-state/runs.json'));
  mk('.ren-dev/state/x.json');
  ok('.ren-dev 被报出', runtimeDataFiles(TMP).includes('.ren-dev/state/x.json'));
}

console.log('\n[5] 说明性文件不算数据');
{
  const T2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deployguard2-'));
  fs.mkdirSync(path.join(T2, 'workspace'), { recursive: true });
  fs.mkdirSync(path.join(T2, 'data'), { recursive: true });
  fs.writeFileSync(path.join(T2, 'workspace', 'README.md'), '# 说明');
  fs.writeFileSync(path.join(T2, 'data', '.gitkeep'), '');
  ok('workspace/README.md 和 .gitkeep 放行', runtimeDataFiles(T2).length === 0, runtimeDataFiles(T2));
  fs.writeFileSync(path.join(T2, 'data', 'real.json'), '{}');
  ok('但同目录里有一个真文件就立刻报', runtimeDataFiles(T2).length === 1);
  fs.rmSync(T2, { recursive: true, force: true });
}

console.log('\n[6] 报错文案：说清后果，并且不给「直接删」这个建议');
{
  const e = explain(['data/tickets/a.json', 'data/b.json'], 2);
  ok('标题里有文件数', /2 个文件/.test(e.label), e.label);
  ok('列出具体文件', /data\/tickets\/a\.json/.test(e.note), e.note);
  ok('说清会发生什么（混进生产数据）', /生产数据/.test(e.hint), e.hint);
  ok('给的是「挪出去」不是「删掉」', /mv data/.test(e.hint) && !/rm -rf data/.test(e.hint), e.hint);
  ok('点出根因（dev 数据目录）', /TICKET_DIR|REPAIR_DIR/.test(e.hint), e.hint);

  const many = explain(Array.from({ length: 40 }, (_, i) => `data/f${i}.json`), 40);
  ok('文件多时截断但不丢总数', /共 40 个/.test(many.note), many.note);
}

console.log('\n[7] 发布闸门真的接了这一步');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'release.mjs'), 'utf8');
  ok('release.mjs 调了 runtimeDataFiles', /runtimeDataFiles\(ROOT\)/.test(src));
  ok('命中就 die（不是打一行警告）', /if \(files\.length\)[^}]*die\(/.test(src));
  ok('门数从四道改成五道（说明文字对得上）', /五道门/.test(src));
  ok('名单与 lib 是同一份（不在闸门里另写一遍）',
    !/RUNTIME_DIRS\s*=/.test(src) && /from '\.\.\/lib\/deployguard\.js'/.test(src));
}

console.log('\n[8] 名单要覆盖每一个会落盘的库');
{
  /* 各库的默认落盘路径：新增一个库就要回来加一行，否则这道门会「合格」而实际早漏了 */
  const defaults = {
    'lib/ticket.js': 'data/tickets',
    'lib/repair.js': 'data/repair',
    'lib/incident.js': 'data/incidents',
    'lib/audit.js': 'data/audit',
    'lib/proof.js': 'data/proofs'
  };
  for (const [f, rel] of Object.entries(defaults)) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(`${f} 默认落在 ${rel}`, src.includes(`'${rel.split('/')[1]}'`) || src.includes(rel), rel);
  }
  ok('RUNTIME_DIRS 含 data', RUNTIME_DIRS.includes('data'), RUNTIME_DIRS);
  ok('RUNTIME_DIRS 含 workspace', RUNTIME_DIRS.includes('workspace'), RUNTIME_DIRS);
}

console.log('\n[9] 测试进程不许落到真实 data/（这条才是根因）');
{
  const { dataDir, isTestEntry } = await import('../lib/testdir.js');
  const app = '/app/server.js';
  const tst = '/app/test/foo-test.mjs';

  ok('生产入口 → <app>/data/audit（和改动前一致，不能顺手改了生产行为）',
    dataDir('AUDIT_DIR', 'audit', { entry: app, env: {} }) === path.join(ROOT, 'data', 'audit'),
    dataDir('AUDIT_DIR', 'audit', { entry: app, env: {} }));
  ok('测试入口 → 临时目录',
    dataDir('AUDIT_DIR', 'audit', { entry: tst, env: {} }).startsWith(os.tmpdir()));
  ok('显式环境变量优先（测试想指定就指定）',
    dataDir('AUDIT_DIR', 'audit', { entry: tst, env: { AUDIT_DIR: '/tmp/z' } }) === path.resolve('/tmp/z'));
  ok('production 入口认得出不是测试', isTestEntry(app) === false);
  ok('test 入口认得出是测试', isTestEntry(tst) === true);
  ok('名字里带 test 但不是 test/ 目录的不算（server.js 里跑的不受影响）',
    isTestEntry('/app/lib/testdir.js') === false);

  /* 五个会落盘的库都得走这条兜底：漏一个，跑一遍测试就往部署目录里写一截 */
  const LIBS = {
    'lib/audit.js': 'AUDIT_DIR', 'lib/incident.js': 'INCIDENT_DIR',
    'lib/ticket.js': 'TICKET_DIR', 'lib/proof.js': 'isTestEntry()',
    'lib/repair.js': 'isTestEntry()'
  };
  for (const [f, token] of Object.entries(LIBS)) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ok(`${f} 接了测试兜底`, src.includes(token), token);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
