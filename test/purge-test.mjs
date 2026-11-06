/* 删除与注销：能恢复的和不能恢复的必须分开
 *
 * 这组断言盯的是「不可逆」这条线：
 *   1. 删文件 = 进回收站，恢复得回来；目标已有同名文件时**拒绝**，不静默覆盖。
 *   2. 清空工作区也走回收站（还能捞），只有「清空回收站」才是真删。
 *   3. 注销 = 文件 + 记忆 + 状态库痕迹 + 用量记录一起没，且**只**动自己那份。
 *   4. 有任务在跑时不许注销（删到一半会让正在写的那步崩）。
 *   5. 注销后必须说清楚哪些没删（审计、备份），不能假装删干净了。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-'));

/* 目录全部改道：这些模块在 import 时就定路径，所以必须在 import 之前设 */
process.env.WORKSPACE_DIR = path.join(TMP, 'ws');
process.env.REN_STATE_DIR = path.join(TMP, 'state');
process.env.REN_USAGE_DIR = path.join(TMP, 'usage');
process.env.AUDIT_DIR = path.join(TMP, 'audit');

const { scopeRoot } = await import('../lib/workspace.js');
const TRASH = await import('../lib/trash.js');
const { purgeAccount } = await import('../lib/purge.js');
const state = await import('../lib/state.js');
const quota = await import('../lib/quota.js');
const mem = await import('../lib/memory.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const S = 'a1'.repeat(16);     // 自己的 scope
const T = 'b2'.repeat(16);     // 别人的 scope

function mkScope(scope, files) {
  const root = scopeRoot(scope);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files || {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}
const exists = (p) => fs.existsSync(p);

console.log('\n[1] 删除 = 进回收站，不是抹掉');
{
  const root = mkScope(S, { '报价表/a.md': 'x'.repeat(100), 'b.md': 'yy' });
  const st = fs.statSync(path.join(root, '报价表/a.md')).size;

  const r = TRASH.moveToTrash(root, '报价表/a.md');
  ok('移进回收站成功', r.ok, r);
  ok('原位置没了', !exists(path.join(root, '报价表/a.md')));
  eq('记下了大小', r.bytes, st);
  ok('回收站里能看到', TRASH.listTrash(root).items.some(i => i.path === '报价表/a.md'));

  const back = TRASH.restoreFromTrash(root, r.id);
  ok('恢复成功', back.ok, back);
  ok('内容回来了', fs.readFileSync(path.join(root, '报价表/a.md'), 'utf8').length === st);
  eq('恢复后回收站空', TRASH.listTrash(root).items.length, 0);

  /* 不覆盖：目标已经有同名文件时拒绝，并说明原因 */
  const r2 = TRASH.moveToTrash(root, 'b.md');
  fs.writeFileSync(path.join(root, 'b.md'), '新内容');
  const back2 = TRASH.restoreFromTrash(root, r2.id);
  ok('目标已存在时拒绝恢复', !back2.ok, back2);
  ok('拒绝理由说人话', /已经有同名文件/.test(String(back2.error)), back2.error);
  eq('新文件没被覆盖', fs.readFileSync(path.join(root, 'b.md'), 'utf8'), '新内容');

  /* 越界：不能靠 ../ 溜出工作区，也不能删回收站自己 */
  const esc = TRASH.moveToTrash(root, '../outside.md');
  ok('越界路径被拒', !esc.ok && /超出工作区/.test(esc.error), esc);
  const self = TRASH.moveToTrash(root, '.trash');
  ok('回收站自己不能这样删', !self.ok, self);
  const empty = TRASH.moveToTrash(root, '');
  ok('空路径被拒', !empty.ok, empty);
}

console.log('\n[2] 清空工作区走回收站；只有「清空回收站」是真删');
{
  /* 用一个干净的 scope：上一节在 S 里留了文件和一个回收站条目，
     拿它来数「进了几项」会把自己绕进去 */
  const root = mkScope('c3'.repeat(16), { 'a.md': 'a', '深/层/b.md': 'b' });
  const r = TRASH.clearWorkspace(root);
  ok('整体成功', r.ok, r);
  eq('两条都进站了', r.moved.length, 2);
  ok('工作区里只剩回收站', fs.readdirSync(root).join(',') === '.trash', fs.readdirSync(root));
  ok('回收站里两份都在', TRASH.listTrash(root).items.length === 2);

  const e = TRASH.emptyTrash(root);
  ok('清空回收站成功', e.ok, e);
  eq('真删了 2 项', e.removed, 2);
  ok('回收站目录没了', !exists(TRASH.trashPath(root)));
  ok('恢复入口也随之失效（记录没了）', !TRASH.restoreFromTrash(root, '1-abcdef').ok);
}

console.log('\n[3] 注销：文件 / 记忆 / 状态 / 用量一起没');
{
  const root = mkScope(S, { '合同/框架.md': 'x'.repeat(50), 'note.md': 'n' });
  /* 记忆：公司口径 + 一个员工的画像 */
  mem.replaceCompany(S, '本公司主营包装材料采购');
  mem.appendEntries(S, 'company', '', [{ text: '供应商华东包装报价 3.20 元/个' }], 'test');
  fs.mkdirSync(path.join(process.env.WORKSPACE_DIR, 'memory', S), { recursive: true });

  /* 状态库：一条跑过的任务 + 它的锁/租约 */
  state.init();
  state.runBegin({ id: 'run-purge-1', scope: S, uid: 'u1', title: '整理报价表' });
  state.runEnd('run-purge-1', { status: 'done' });
  state.acquireLock(`c:${S}`, 'run-purge-1', 60000);
  state.leasePath(path.join(root, 'note.md'), 'run-purge-1', 60000);
  state.takeRate(`s:${S}|1`, 60000, 100);

  /* 用量记录 */
  quota.recordTokens(S, { total: 1234, exact: true, model: 'x' });
  quota.flush();
  const usageFile = path.join(process.env.REN_USAGE_DIR, `${S}.json`);
  ok('先确认用量文件在', exists(usageFile), fs.readdirSync(process.env.REN_USAGE_DIR));

  const before = state.runRecent(S, 10);
  ok('先确认状态库里有这条任务', before.length === 1, before);

  const memDir = path.join(process.env.WORKSPACE_DIR, 'memory', S);
  ok('先确认记忆目录在', exists(memDir));

  const r = purgeAccount(S);
  ok('注销成功', r.ok, r);
  ok('工作区目录没了', !exists(root));
  ok('记忆目录没了', !exists(memDir));
  eq('状态库里的任务清掉了', state.runRecent(S, 10).length, 0);
  ok('用量记录文件没了', !exists(usageFile), fs.readdirSync(process.env.REN_USAGE_DIR));
  ok('报了删掉多少文件', r.files >= 2, r.files);
  ok('报了删掉多少字节', r.bytes >= 50, r.bytes);
  ok('返回里还留了状态层统计', r.state && r.state.ok === true, r.state);
  ok('明说审计没删', r.auditKept === true);
  ok('明说备份没删', /备份/.test(String(r.note)), r.note);
  ok('审计里记了这一笔（注销本身要留痕）',
    fs.readdirSync(path.join(process.env.AUDIT_DIR, S)).some(f => /\.jsonl$/.test(f)));

  /* 幂等：再注销一次不该报错，也不该编出文件数 */
  const r2 = purgeAccount(S);
  ok('再注销一次仍然 ok', r2.ok, r2);
  eq('第二次没有文件可删', r2.files, 0);
}

console.log('\n[4] 注销只动自己那份');
{
  const mine = mkScope(S, { 'mine.md': 'm' });
  const other = mkScope(T, { 'other.md': 'o' });
  state.init();
  state.runBegin({ id: 'run-other', scope: T, uid: 'u2', title: '别人的任务' });
  state.runEnd('run-other', { status: 'done' });
  quota.recordTokens(T, { total: 99, exact: true, model: 'x' });
  quota.flush();

  const r = purgeAccount(S);
  ok('自己注销成功', r.ok, r);
  ok('自己的没了', !exists(mine));
  ok('别人的工作区还在', exists(other));
  ok('别人的文件还在', exists(path.join(other, 'other.md')));
  eq('别人的任务记录还在', state.runRecent(T, 10).length, 1);
  ok('别人的用量记录还在', exists(path.join(process.env.REN_USAGE_DIR, `${T}.json`)));
}

console.log('\n[5] 拒绝不合法输入');
{
  ok('空 scope 被拒', !purgeAccount('').ok);
  ok('非 32 位十六进制被拒', !purgeAccount('../../etc').ok);
  const r = purgeAccount(S, { running: 2 });
  ok('有任务在跑时拒绝注销', !r.ok && /在跑/.test(r.error), r);
}

console.log('\n[6] 接线：端点、口令、界面');
{
  const serverSrc = fs.readFileSync(path.join(APP, 'server.js'), 'utf8');
  ok('有 /api/account/purge 路由', /'\/api\/account\/purge'/.test(serverSrc));
  ok('端点要求口令确认', /确认框里输入 DELETE/.test(serverSrc));
  ok('注销前数一次在跑的任务', /for \(const r of RUNS\.values\(\)\) if \(r\.alive && r\.scope === scope\) running\+\+/.test(serverSrc), '');
  ok('注销也写审计', /kind: 'account'/.test(serverSrc));
  ok('health 带出 schema 版本', /schema: withKey \? \(state\.info\(\)\.schema/.test(serverSrc));

  const appSrc = fs.readFileSync(path.join(APP, 'public', 'app.js'), 'utf8');
  ok('前端有注销按钮的处理', /\$\('#dataPurge'\)\.onclick/.test(appSrc));
  ok('点注销会让手打 DELETE', /手打 DELETE/.test(appSrc));
  ok('注销后清本地偏好', /clearLocalPrefs\(\);[\s\S]{0,400}bossScope/.test(appSrc));
  ok('退出登录也清本地偏好', /await CLOUD\.signOut\(\);[\s\S]{0,300}clearLocalPrefs\(\)/.test(appSrc));
  ok('换账号检测只在「之前记过别人」时清', /prev && uid && prev !== uid/.test(appSrc));

  const htmlSrc = fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8');
  ok('设置里有「我的数据」区块', /我的数据/.test(htmlSrc));
  ok('四个按钮齐了', ['dataExport', 'dataClear', 'dataEmptyTrash', 'dataPurge']
    .every(id => new RegExp(`id="${id}"`).test(htmlSrc)));
  const cssSrc = fs.readFileSync(path.join(APP, 'public', 'app.css'), 'utf8');
  ok('回收站列表有样式', /\.trash-r\{/.test(cssSrc) && /\.trash-box\{/.test(cssSrc));
  ok('注销按钮是红的', /\.btn\.ghost\.danger\{color:var\(--red\)\}/.test(cssSrc));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
