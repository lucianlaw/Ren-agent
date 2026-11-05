// 身份层单测：uid → 工作区映射、服务端权限交集、旧目录迁移
//
// 这三块都属「静默失效也能跑」的类型：映射错了只是看不到文件、权限交集写反了
// 是安全洞、迁移不幂等会重复覆盖用户文件。所以每条都要有断言钉住。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* workspace.js 在 import 时读 WORKSPACE_DIR，所以必须先设环境变量再动态 import */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ren-identity-'));
process.env.WORKSPACE_DIR = TMP;

const { identityOf, scopeFor, UID_RE, LEGACY_RE } = await import('../lib/identity.js');
const { effectivePerms, savePerms, loadPerms, DEFAULT_PERMS } = await import('../lib/perms.js');
const { migrateScope } = await import('../lib/migrate.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, { got, want });

const UID = 'oYQVK6vlBz11FIQ7XP2m8rLKh8pg';

/* ── [1] uid → scope ── */
console.log('[1] 账号 → 工作区');
ok('uid 格式判定通过', UID_RE.test(UID));
const s1 = scopeFor(UID);
ok('派生出 32 位十六进制', /^[a-f0-9]{32}$/.test(s1), s1);
eq('同一 uid 结果稳定', scopeFor(UID), s1);
ok('不同 uid 落到不同目录', scopeFor('anotherAccountId12345') !== s1);
ok('派生结果不等于 uid 原文', s1 !== UID);
eq('空 uid 也能算（不会抛）', typeof scopeFor(''), 'string');

/* ── [2] 请求标识解析 ── */
console.log('[2] 请求标识解析');
const a = identityOf(UID);
eq('uid 解析成派生目录', a.scope, s1);
eq('uid 标记为非旧串', a.legacy, false);
eq('uid 原样带出来', a.uid, UID);
const oldScope = '0123456789abcdef0123456789abcdef';
const b = identityOf(oldScope);
eq('旧随机串原样当目录', b.scope, oldScope);
eq('旧随机串标记 legacy', b.legacy, true);

/* wu: 前缀：云端 owner_id 就是 `wu:<id>`，session.user.id 有时带有时不带。
   线上真实踩过：带前缀的 uid 直接被判「身份标识不合法」，一进任务就红。
   两条断言必须同时成立——能进（不报错），且和裸 uid 落到同一个目录（不分裂）。 */
const w = identityOf('wu:' + UID);
ok('带 wu: 前缀不报错', !w.error, w.error);
eq('带 wu: 前缀与裸 uid 同一目录', w.scope, s1);
eq('解析出的 uid 已去掉前缀', w.uid, UID);
eq('大写 WU: 也认', identityOf('WU:' + UID).scope, s1);
eq('前缀前后带空格也认', identityOf(' wu:' + UID + ' ').scope, s1);
ok('wu: 后面是空的仍然报错', !!identityOf('wu:').error);

ok('空值报错', !!identityOf('').error);
ok('太短的串报错', !!identityOf('abc').error);
ok('带斜杠的串报错（不能拼路径）', !!identityOf('../../etc/passwd').error);
ok('中文串报错', !!identityOf('张三的账号一二三四五六').error);
eq('错误码是 400', identityOf('abc').code, 400);
/* 报错要能自证：只说「不合法」，线上就变成「不知道改哪」 */
ok('报错带长度，不用猜', /长度 3/.test(identityOf('abc').error), identityOf('abc').error);
ok('报错指出非法字符位置，不回显整个标识',
  /第 1 个字符/.test(identityOf('../../etc/passwd').error) && !identityOf('../../etc/passwd').error.includes('passwd'),
  identityOf('../../etc/passwd').error);

/* ── [3] 服务端权限：前端只能收紧 ── */
console.log('[3] 权限交集');
/* 首次初始化是一条真实的绕过路径：直接打 /api/tool 并在请求体里写 exec:true，
   以前会被当成「前端从云端读回的设置」直接接受——等于不经过 /api/perms 就开了跑命令。
   所以 init 的上限是 DEFAULT_PERMS：默认关的必须走 /api/perms。 */
const p1 = effectivePerms(s1, { read: true, write: true, exec: true, net: true });
eq('首次调用：exec 默认关，前端说 true 也不打开', p1.perms.exec, false);
eq('首次标记为 init', p1.source, 'init');
eq('初始化落盘的是收紧后的值', loadPerms(s1).perms.exec, false);
ok('默认开着的三类照常给', p1.perms.read && p1.perms.write && p1.perms.net, p1.perms);

const s1c = scopeFor('mtighten0000000000000000001');
const p1c = effectivePerms(s1c, { read: true, write: false, exec: false, net: true });
eq('首次调用可以收紧（写文件关掉）', p1c.perms.write, false);
eq('收紧也落盘', loadPerms(s1c).perms.write, false);

const p2 = effectivePerms(s1, { read: true, write: true, exec: false, net: true });
eq('前端可立刻收紧 exec', p2.perms.exec, false);
eq('有记录时标记为 stored', p2.source, 'stored');
eq('请求里收紧不写回服务端记录', loadPerms(s1).perms.exec, false);

savePerms(s1, { read: true, write: true, exec: false, net: true }, 'test');
const p3 = effectivePerms(s1, { read: true, write: true, exec: true, net: true });
eq('服务端关着 exec，前端传 true 也不给', p3.perms.exec, false);
eq('其余类别照常放行', p3.perms.write, true);

const p4 = effectivePerms(s1, {});
eq('什么都不传就全按服务端记录', p4.perms.exec, false);
eq('net 跟随服务端记录', p4.perms.net, true);

const s2 = scopeFor('freshAccountId0987654321');
const p5 = effectivePerms(s2, {});
ok('首次且没传 → 用默认档', p5.source === 'init' && p5.perms.exec === DEFAULT_PERMS.exec, p5.perms);
ok('默认档不跑命令', p5.perms.exec === false);

const rec = savePerms(s1, { read: true, write: false, exec: false, net: true }, 'ui');
eq('savePerms 归一化布尔', rec.perms.write, false);
eq('savePerms 记来源', rec.by, 'ui');
ok('savePerms 落盘可回读', loadPerms(s1).perms.write === false);

/* ── [4] 迁移 ── */
console.log('[4] 旧目录迁移');
const legacy = 'ffffffffffffffffffffffffffffffff';
const target = scopeFor('migrateTarget1234567890');
const fromDir = path.join(TMP, 'users', legacy);
const toDir = path.join(TMP, 'users', target);
fs.mkdirSync(path.join(fromDir, '报价表'), { recursive: true });
fs.writeFileSync(path.join(fromDir, 'README.md'), '# 我改过的说明\n');
fs.writeFileSync(path.join(fromDir, '报价表', 'a.md'), 'A 报价\n');
fs.writeFileSync(path.join(fromDir, '.seeded'), 'x');

const m1 = migrateScope(legacy, target);
ok('迁移成功', m1.ok === true, m1);
eq('搬了 2 个文件（.seeded 不算）', m1.copied, 2);
eq('旧文件内容到了新目录', fs.readFileSync(path.join(toDir, 'README.md'), 'utf8'), '# 我改过的说明\n');
eq('子目录结构保留', fs.readFileSync(path.join(toDir, '报价表', 'a.md'), 'utf8'), 'A 报价\n');
ok('不搬 .seeded', !fs.existsSync(path.join(toDir, '.seeded')) || fs.readFileSync(path.join(toDir, '.seeded'), 'utf8') !== 'x');
ok('写了迁移账本', fs.existsSync(path.join(toDir, '.migrated.json')));
ok('种子文件补上了', fs.existsSync(path.join(toDir, '合同')), '应有 SEED 目录');

const m2 = migrateScope(legacy, target);
ok('第二次不再重复搬', m2.cached > 0, m2);
eq('第二次不算新搬', m2.copied, m1.copied);

/* 同一台电脑换账号：旧目录只归第一个搬它的账号，后者拿不到。
   少了这条，后登录的人会把前一个人的文件搬到自己名下。 */
const otherAccount = scopeFor('someoneElseAccount123456');
const stolen = migrateScope(legacy, otherAccount);
ok('第二个账号拿不到已认领的旧目录', stolen.claimed === true && stolen.copied === 0, stolen);
ok('被认领后目标目录不会凭空建出一份副本', !fs.existsSync(path.join(TMP, 'users', otherAccount, 'README.md')));
ok('原账号仍能正常拿到（缓存）', migrateScope(legacy, target).cached > 0);

/* 目标更新时不能覆盖：用户在新目录里改过的文件优先 */
const future = Date.now() + 60000;
fs.writeFileSync(path.join(toDir, '报价表', 'a.md'), '我在新目录改的\n');
fs.utimesSync(path.join(toDir, '报价表', 'a.md'), new Date(future), new Date(future));
const legacy2 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const fromDir2 = path.join(TMP, 'users', legacy2);
fs.mkdirSync(path.join(fromDir2, '报价表'), { recursive: true });
fs.writeFileSync(path.join(fromDir2, '报价表', 'a.md'), '旧的\n');
const m3 = migrateScope(legacy2, target);
eq('目标更新时跳过', m3.skipped, 1);
eq('用户改过的内容没被盖掉', fs.readFileSync(path.join(toDir, '报价表', 'a.md'), 'utf8'), '我在新目录改的\n');

const missing = migrateScope('dddddddddddddddddddddddddddddddd', target);
ok('源目录不存在也返回成功（不报错）', missing.ok === true && missing.missing === true, missing);

/* 同一目录不搬 */
const same = migrateScope(target, target);
ok('同目录直接返回', same.ok === true && same.same === true, same);

/* ── [5] 身份与迁移的接缝 ── */
console.log('[5] 接缝');
ok('旧串迁移后指向的目录与身份派生一致', scopeFor('migrateTarget1234567890') === target);
ok('迁移不会把 uid 当旧串', identityOf(UID).legacy === false);
ok('LEGACY_RE 不匹配 uid', !LEGACY_RE.test(UID));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
