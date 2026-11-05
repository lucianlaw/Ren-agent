/* 只读自审探针：验证「让 agent 读自己源码」这件事的边界。
 *
 * 这组测试不看功能好不好用，只盯四件事：
 *   1. 出不去：任何相对/绝对路径穿越都拒
 *   2. 摸不到凭据：admins.json / self-token.json 永远读不到（它们就在源码根目录）
 *   3. 没有写：这一层不许有写文件、执行命令的出口
 *   4. 令牌：没配就整关，错了就拒，对了才给读
 *
 * 跑法：node test/self-probe-test.mjs
 * 只测本地文件访问层与源码契约，不联网、不连库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSrc, walkSrc, treeSrc, readSrc, grepSrc, selfToken, selfAuth, isShadow } from '../lib/selfsrc.js';
import { __test as cfgTest } from '../lib/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const selfSrc = read('../lib/selfsrc.js');
const serverSrc = read('../server.js');
const page = read('../public/self.html');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('[1] 正常读源码');
ok('能读 public/states.js', !resolveSrc('public/states.js').error, JSON.stringify(resolveSrc('public/states.js')));
ok('能读 server.js 本体', !resolveSrc('server.js').error);
ok('能读 lib/ 下的模块', !resolveSrc('lib/tools.js').error);
ok('能读 test/ 下的用例', !resolveSrc('test/points-test.mjs').error);
ok('目录不给读，提示去看列表', /目录/.test(resolveSrc('public').error || ''));

console.log('[2] 出不去：路径穿越一律拒');
[
  '../etc/passwd',
  '../../secret.txt',
  'public/../../outside.js',
  '/etc/passwd',
  'public/../admins.json',
  './public/../../x.js',
  'lib/../../x.js'
].forEach(p => {
  const r = resolveSrc(p);
  ok(`拒绝 ${p}`, !!r.error, JSON.stringify(r));
});
ok('空路径直接拒', !!resolveSrc('').error);
ok('含 NUL 的路径直接拒', !!resolveSrc('public/a\u0000b.js').error);

console.log('[3] 凭据永远读不到');
ok('拒绝 admins.json', /凭据/.test(resolveSrc('admins.json').error || ''), resolveSrc('admins.json').error);
ok('拒绝 self-token.json', /凭据/.test(resolveSrc('self-token.json').error || ''));
ok('绕道 public/../self-token.json 也拒', !!resolveSrc('public/../self-token.json').error);
ok('遍历清单里没有 admins.json', !walkSrc().includes('admins.json'));
ok('遍历清单里没有 self-token.json', !walkSrc().includes('self-token.json'));

console.log('[4] 不是源码的地方不开放');
[
  'workspace/users/x/a.md',
  'data/admins.json',
  '.git/config',
  'node_modules/x/index.js',
  '.workbuddy/memory/x.md'
].forEach(p => ok(`拒绝 ${p}`, !!resolveSrc(p).error, JSON.stringify(resolveSrc(p))));
ok('遍历结果里没有任何 workspace 文件', !walkSrc().some(p => p.startsWith('workspace/')));
ok('遍历结果里没有 data/', !walkSrc().some(p => p.startsWith('data/')));
ok('遍历结果里没有 .git/', !walkSrc().some(p => p.startsWith('.git/')));

console.log('[5] 二进制/非文本不给读');
['a.png', 'b.pdf', 'c.docx', 'd.bin'].forEach(p => {
  ok(`拒绝 ${p}`, !!resolveSrc(p).error, resolveSrc(p).error);
});

console.log('[6] 读出来带行号，能续读');
{
  const r = readSrc('public/states.js', 1, 10);
  ok('返回带行号的文本', /^1\t/.test(r.text || ''), (r.text || '').slice(0, 40));
  ok('报了总行数', r.total > 10, String(r.total));
  ok('能被截断并告诉模型', r.truncated === true);
  const r2 = readSrc('public/states.js', n => n, 10);
  ok('行号参数非法时不崩（退回首行）', !r2.error, JSON.stringify(r2).slice(0, 80));
  const far = readSrc('public/states.js', 999999, 10);
  ok('读到文件末尾之后不抛错', !far.error);
}

console.log('[7] 检索：先定位再精读');
{
  const r = grepSrc('looksStuck');
  ok('能搜到 looksStuck（在生产代码里真的存在）', r.hits > 0, JSON.stringify(r).slice(0, 120));
  ok('命中格式是 文件:行号: 内容', /^[\w./-]+:\d+: /m.test(r.text || ''));
  const g = grepSrc('looksStuck', undefined, { glob: 'states.js' });
  ok('glob 只搜指定文件', g.hits > 0 && (g.text || '').split('\n').every(l => /states\.js:\d+:/.test(l)), (g.text || '').slice(0, 80));
  ok('搜不到时给的是人话', /没有匹配/.test(grepSrc('zzz_not_exist_zzz').text));
  ok('非法正则自动降级为字面量，不抛错', !grepSrc('a(b').error);
}

console.log('[8] 大文件不能被静默跳过');
{
  /* app.js 361KB、meeting.js 198KB 是整个项目最该被读的两个文件。
     曾经因为设了 160KB 上限，它俩对 grep 完全隐形——不报错，就是搜不到，
     这种「看不见的漏」比报错危险得多，所以单独立一组盯住。 */
  ['public/app.js', 'public/meeting.js', 'public/agent.js'].forEach(p => {
    const r = readSrc(p, 1, 3);
    ok(`${p} 能读（不被大小上限挡掉）`, !r.error, r.error);
  });
  ok('能在 app.js 里搜到 maybeElsewhere', grepSrc('maybeElsewhere', undefined, { glob: 'app.js' }).hits > 0);
  ok('能在 meeting.js 里搜到 guardRun', grepSrc('guardRun', undefined, { glob: 'meeting.js' }).hits > 0);
  ok('大文件仍然只返回一段（不会整篇倒出来）', (readSrc('public/app.js', 1, 5).text || '').split('\n').length <= 5);
}

console.log('[9] 没有写、没有执行：这一层是纯只读');
ok('selfsrc 里没有 writeFile', !/writeFile/.test(selfSrc));
ok('selfsrc 里没有 unlink/rm', !/unlinkSync|rmSync/.test(selfSrc));
ok('selfsrc 里没有子进程', !/child_process|execFile|spawn/.test(selfSrc));
ok('selfsrc 里没有网络', !/fetch\(|http\.request|https\.request/.test(selfSrc));
ok('服务端只接了三个只读操作', /self_tree[\s\S]{0,200}self_read[\s\S]{0,200}self_grep/.test(serverSrc));
ok('不认识的只读操作直接拒', /不认识的只读操作/.test(serverSrc));

console.log('[9] 令牌：没配就关，错了就拒');
{
  const saved = process.env.SELF_TOKEN;
  delete process.env.SELF_TOKEN;
  const disk = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'self-token.json'), 'utf8')).token || ''; } catch { return ''; } })();
  if (disk) {
    ok('磁盘上有令牌时，对的能过', selfAuth(disk).ok === true);
    ok('磁盘上有令牌时，错的不给过', selfAuth('x'.repeat(disk.length)).ok === false);
    ok('长度不对也拒（不报细节）', selfAuth('short').error === '令牌不对');
    ok('空令牌拒', selfAuth('').ok === false);
  } else {
    ok('磁盘上没令牌时整体不可用（503）', selfAuth('x').code === 503);
  }
  process.env.SELF_TOKEN = 'test-token-123456';
  /* 密钥解析结果在进程内是缓存过的（否则每个请求都要读盘）。
     这里改的是环境变量，所以要把缓存清掉，否则验的是上一次的结果。 */
  cfgTest.reset();
  ok('环境变量能覆盖文件', selfToken() === 'test-token-123456');
  ok('匹配的令牌通过', selfAuth('test-token-123456').ok === true);
  ok('不匹配的令牌 403', selfAuth('test-token-123457').code === 403);
  delete process.env.SELF_TOKEN;
  cfgTest.reset();
  process.env.SELF_TOKEN = '';
  if (saved !== undefined) process.env.SELF_TOKEN = saved; else delete process.env.SELF_TOKEN;
}

console.log('[10] 页面契约：不能靠前端加出写能力');
ok('页面只声明了三个只读工具', (page.match(/name: 'self_/g) || []).length === 3, String((page.match(/name: 'self_/g) || []).length));
ok('页面里没有写文件/跑命令的调用', !/write_file|run_shell/.test(page));
ok('所有自审请求都打 /api/self/ 一个口', /\/api\/self\/tool/.test(page) && /\/api\/self\/ping/.test(page));
ok('页面提醒这是探针不是产品', /探针/.test(page));
ok('有轮次上限，不会无限读', /rounds < 12/.test(page) && /最多 10 轮/.test(page));
ok('工具结果进了 messages 的 tool 角色', /role: 'tool'/.test(page) && /tool_call_id/.test(page));

/* 这一节是「实测抓出来的坑」，不是想出来的：
   线上部署目录里躺着一份早年的 UI 原型 index.html（写死的演示任务，带 status:'running'），
   静态路由根本不服务它，但探针会照读。实测模型搜 running 时 6 条命中全来自它。
   模型把演示数据当真实逻辑讲，比搜不到更危险，所以必须显式标注。 */
console.log('[11] 影子文件必须被标出来（部署目录里有源码仓库没有的文件）');
{
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'selfshadow-'));
  fs.writeFileSync(path.join(tmp, 'index.html'), '<div>原型 status:"running"</div>\n');
  fs.mkdirSync(path.join(tmp, 'public'));
  fs.writeFileSync(path.join(tmp, 'public', 'index.html'), '<div>线上 status:"running"</div>\n');
  fs.writeFileSync(path.join(tmp, 'a.js'), 'const running = 1;\n');

  ok('根目录的 html 判定为影子', isShadow('index.html') === true);
  ok('public/ 下的 html 不算影子', isShadow('public/index.html') === false);
  ok('.html 以外的文件不算影子', isShadow('a.js') === false);

  const g = grepSrc('running', tmp);
  ok('grep 能同时命中两份 html', g.hits === 3, String(g.hits));
  const rootHit = (g.text || '').split('\n').find(l => l.startsWith('index.html:'));
  const liveHit = (g.text || '').split('\n').find(l => l.startsWith('public/index.html:'));
  ok('影子文件的命中带「未上线」标注', /未上线/.test(rootHit || ''), rootHit);
  ok('线上文件的命中不带这个标注', !/未上线/.test(liveHit || ''), liveHit);

  const t = treeSrc('', tmp);
  ok('tree 里影子文件也标注', /未上线/.test((t.text || '').split('\n').find(l => l.startsWith('index.html')) || ''));

  /* dir 传 '.' 是模型最自然的写法，以前会返回「这里没有源码文件」 */
  ok("dir='.' 等于根目录，不是空目录", treeSrc('.', tmp).count === treeSrc('', tmp).count, treeSrc('.', tmp).text);
  ok("dir='./' 也一样", treeSrc('./', tmp).count === treeSrc('', tmp).count);
  ok("dir='./public' 能定位到子目录", treeSrc('./public', tmp).count === 1, treeSrc('./public', tmp).text);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
