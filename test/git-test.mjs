/* 仓库工作流：能提交、能回退、拦得住不该提交的东西
 *
 * 这类工具的失败模式和文件工具不一样：它不会「写出一个坏文件」，
 * 它会把**不该进版本库的东西**存进历史里。而历史是可以被推走的，
 * 一旦推出去，删文件也没用——所以这里一半的断言是在验「拒绝」。
 *
 * 另外两条容易被忽略的：
 *   · 工作区边界：repo_rollback 能 checkout 任意 ref，指到工作区外就是一扇后门
 *   · 没有 git 的机器：要明确报错，不能假装成功（线上容器里未必装了 git）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 260) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'git-'));
process.env.REN_STATE_DIR = path.join(TMP, 'state');
const WS = path.join(TMP, 'ws');
fs.mkdirSync(WS, { recursive: true });

const { runTool } = await import('../lib/tools.js');
const { gitAvailable } = await import('../lib/git.js');

const ctx = { workspace: WS, scope: 'a'.repeat(32), leaseOwner: 'dev-1' };
const call = (name, args, c = ctx) => runTool(name, args, c);

console.log('\n[1] 前置：这台机器有 git');
{
  const v = gitAvailable();
  ok('git 可用（没有 git 的话下面全都会报「用不了」）', !!v, v);
}

console.log('\n[2] init：仓库建在自己的工作区里');
{
  const r = await call('repo_init', {});
  ok('初始化成功', r.ok, r.output);
  ok('目录真的成了 git 仓库', fs.existsSync(path.join(WS, '.git')));
  ok('自动写了 .gitignore', fs.existsSync(path.join(WS, '.gitignore')));
  const gi = fs.readFileSync(path.join(WS, '.gitignore'), 'utf8');
  ok('.gitignore 排除密钥目录', /\.ren-secrets\//.test(gi), gi);
  ok('.gitignore 排除运行时数据', /data\//.test(gi), gi);

  const again = await call('repo_init', {});
  ok('重复 init 不报错，且说明「已经是仓库」', again.ok && /已经是/.test(again.output), again.output);
}

console.log('\n[3] 提交与历史');
{
  await call('write_file', { path: 'src/app.js', content: 'export const a = 1;\n' });
  const st = await call('repo_status', {});
  ok('status 看得到未跟踪文件', /src\//.test(st.output) || /app\.js/.test(st.output), st.output);

  const c1 = await call('repo_commit', { message: '第一版' });
  ok('提交成功', c1.ok, c1.output);
  ok('返回了提交号', /[0-9a-f]{7}/.test(String(c1.commit || '') + c1.output), c1.commit);

  await call('write_file', { path: 'src/app.js', content: 'export const a = 2;\n' });
  const d = await call('repo_diff', {});
  ok('diff 里有新增和删除两行', /-export const a = 1/.test(d.output) && /\+export const a = 2/.test(d.output), d.output);

  const c2 = await call('repo_commit', { message: '把 a 改成 2' });
  ok('第二次提交成功', c2.ok, c2.output);

  const log = await call('repo_log', { limit: 5 });
  ok('历史里有两次提交', /第一版/.test(log.output) && /把 a 改成 2/.test(log.output), log.output);
  ok('最新的排在前面', log.output.indexOf('把 a 改成 2') < log.output.indexOf('第一版'), log.output);

  const empty = await call('repo_commit', { message: '没东西可提交' });
  ok('没改动时不产生空提交', empty.ok && /没有改动/.test(empty.output), empty.output);

  const noMsg = await call('repo_commit', { message: '  ' });
  ok('空提交信息被拒', noMsg.ok === false, noMsg.output);
}

console.log('\n[4] 拒绝：不该进版本库的东西');
{
  /* 私钥类：不在默认 .gitignore 里，只能靠提交前扫描挡住 */
  fs.writeFileSync(path.join(WS, 'server.pem'), 'PRIVATE KEY\n');
  const r = await call('repo_commit', { message: '提交私钥' });
  ok('私钥被拒', r.ok === false, r.output);
  eq('错误码是 forbidden', r.code, 'forbidden');
  ok('说清了是哪个文件、为什么', /server\.pem/.test(r.output) && /私钥|证书/.test(r.output), r.output);
  const log = await call('repo_log', { limit: 5 });
  ok('历史里确实没有那次提交', !/提交私钥/.test(log.output), log.output);
  fs.unlinkSync(path.join(WS, 'server.pem'));

  /* 大文件：>5MB 会让仓库迅速膨胀，克隆/推送都变慢 */
  fs.writeFileSync(path.join(WS, 'huge.bin'), Buffer.alloc(6 * 1024 * 1024));
  const b = await call('repo_commit', { message: '提交大文件' });
  ok('大文件被拒', b.ok === false, b.output);
  eq('错误码是 too_big', b.code, 'too_big');
  fs.unlinkSync(path.join(WS, 'huge.bin'));

  /* 被 .gitignore 挡住的（data/、.env）连 status 都不该出现，
     这样「看不见的东西不会被误提交」——比事后拦截更省事 */
  fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'alerts.jsonl'), 'secret\n');
  const st = await call('repo_status', {});
  ok('被忽略的 data/ 不出现在改动列表里', !/data\/alerts/.test(st.output), st.output);
  fs.rmSync(path.join(WS, 'data'), { recursive: true });
}

console.log('\n[5] 回退');
{
  const before = fs.readFileSync(path.join(WS, 'src/app.js'), 'utf8');
  await call('write_file', { path: 'src/app.js', content: 'export const a = 999;\n' });

  const rb = await call('repo_rollback', { file: 'src/app.js' });
  ok('单文件回退成功', rb.ok, rb.output);
  eq('内容回到上次提交的样子', fs.readFileSync(path.join(WS, 'src/app.js'), 'utf8'), before);

  /* 整棵树回退会丢掉未提交的改动，必须显式确认 */
  await call('write_file', { path: 'src/app.js', content: 'export const a = -1;\n' });
  const noConfirm = await call('repo_rollback', { commit: 'HEAD' });
  ok('整树回退不给 confirm 就拒绝', noConfirm.ok === false, noConfirm.output);
  eq('错误码是 need_confirm', noConfirm.code, 'need_confirm');
  ok('文件没被动过（拒绝是真的拒绝）', /-1/.test(fs.readFileSync(path.join(WS, 'src/app.js'), 'utf8')));

  const yes = await call('repo_rollback', { commit: 'HEAD', confirm: true });
  ok('给了 confirm 才执行', yes.ok, yes.output);
  ok('文件回到已提交状态', !/-1/.test(fs.readFileSync(path.join(WS, 'src/app.js'), 'utf8')));
}

console.log('\n[6] 分支');
{
  const mk = await call('repo_branch', { name: 'feature/x' });
  ok('建分支成功', mk.ok, mk.output);
  const list = await call('repo_branch', {});
  ok('列表里能看到新分支', /feature\/x/.test(list.output), list.output);
  const sw = await call('repo_branch', { switch: 'main' });
  ok('切回 main', sw.ok, sw.output);
  const bad = await call('repo_branch', { switch: 'no-such-branch' });
  ok('切到不存在的分支会失败（不是静默成功）', bad.ok === false, bad.output);
}

console.log('\n[7] 边界：不许指到工作区外');
{
  const out = await call('repo_status', { path: '../../' });
  ok('工作区外的路径被拒', out.ok === false && /之外/.test(out.output), out.output);

  const init = await call('repo_init', { path: '../outside' });
  ok('不能把仓库 init 到工作区外', init.ok === false, init.output);
  ok('工作区外确实没被建出目录', !fs.existsSync(path.join(TMP, 'outside')));

  /* 从子目录调 status 要能找到仓库根，否则模型会以为「没仓库」*/
  const sub = await call('repo_status', { path: 'src' });
  ok('子目录里也能认出仓库', sub.ok && /分支/.test(sub.output), sub.output);
}

console.log('\n[8] clone：只放 https');
{
  for (const url of ['file:///etc/passwd', '/etc/passwd', 'git@github.com:a/b.git', 'ssh://x/y.git', 'http://x/y.git']) {
    const r = await call('repo_clone', { url });
    ok(`拒掉 ${url}`, r.ok === false && /https/.test(r.output), r.output.slice(0, 80));
  }
}

console.log('\n[9] 没有 git 的机器：明确报错，不假装成功');
{
  /* PATH 清空后 gitAvailable 在子进程里会重新探测 */
  const code = `
    const { runGitTool } = await import(${JSON.stringify(path.resolve('lib/git.js'))});
    const r = await runGitTool('repo_status', {}, { workspace: ${JSON.stringify(WS)} });
    console.log(JSON.stringify({ ok: r.ok, out: r.output }));
  `;
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', code], {
    cwd: path.resolve('.'),
    env: { ...process.env, PATH: '/nonexistent-path' },
    encoding: 'utf8'
  });
  const j = (() => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return {}; } })();
  eq('返回失败而不是成功', j.ok, false);
  ok('说清是「没有 git」', /没有 git/.test(String(j.out)), j.out);
}

console.log('\n[10] 写入口的路径租约（多设备并发的另一半）');
{
  const a = { workspace: WS, scope: 'a'.repeat(32), leaseOwner: 'dev-A' };
  const b = { workspace: WS, scope: 'a'.repeat(32), leaseOwner: 'dev-B' };
  const first = await runTool('write_file', { path: 'shared.md', content: 'A 写的\n' }, a);
  ok('设备 A 写成功', first.ok, first.output);
  /* A 的租约还在（120 秒 TTL），B 现在写同一文件要被拦 */
  const second = await runTool('write_file', { path: 'shared.md', content: 'B 写的\n' }, b);
  ok('设备 B 写同一文件被拦', second.ok === false, second.output);
  eq('错误码是 lease', second.code, 'lease');
  ok('给出了可操作的提示', /另一个任务正在写/.test(second.output), second.output);
  eq('文件内容还是 A 的（没有被覆盖）', fs.readFileSync(path.join(WS, 'shared.md'), 'utf8'), 'A 写的\n');

  const other = await runTool('write_file', { path: 'other.md', content: 'B 写的\n' }, b);
  ok('写别的文件不受影响', other.ok, other.output);

  const { releaseLeases } = await import('../lib/state.js');
  releaseLeases('dev-A');
  const retry = await runTool('write_file', { path: 'shared.md', content: 'B 写的\n' }, b);
  ok('租约释放后 B 能写', retry.ok, retry.output);
  eq('这次覆盖成功', fs.readFileSync(path.join(WS, 'shared.md'), 'utf8'), 'B 写的\n');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
