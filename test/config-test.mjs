/* 配置外置：密钥不许待在部署目录里
 *
 * 这一套锁的是「位置」和「优先级」，不是加密强度：
 *   · 默认密钥目录在部署目录之外（部署会把整个目录压包上传）
 *   · 环境变量优先于文件（平台侧能注入就不落盘）
 *   · 老位置的密钥会被迁走并删掉原位（否则下次部署又传上去）
 *   · 自审令牌这种「配了才开」的必须允许缺失，不能凭空生成
 *   · 部署目录扫描：不许出现任何密钥类文件
 *
 * 为什么值得单独一个测试文件：这几条一旦退回，症状不是报错，
 * 而是「一切正常，但线上的密钥就是本机那把」——没有任何报错会提醒你。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secretDir, secretDirInfo, secretValue, secretStatus, findSecretFiles, APP_ROOT, __test } from '../lib/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
const SEC = path.join(tmp, 'secrets');
process.env.REN_SECRET_DIR = SEC;

console.log('[1] 目录位置');
{
  const info = secretDirInfo();
  ok('密钥目录不在 app 目录内', info.outsideApp && !info.path.startsWith(ROOT + path.sep), info);
  ok('目录已创建', fs.existsSync(SEC));
  const mode = fs.statSync(SEC).mode & 0o777;
  eq('目录权限 700', mode.toString(8), '700');
}

console.log('[2] 环境变量优先');
{
  __test.reset();
  process.env.REN_PROBE_ENV = 'env-value-1234567890';
  const v = secretValue('probe.env', { env: 'REN_PROBE_ENV', bytes: 8, minLen: 8 });
  eq('取到环境变量的值', v, 'env-value-1234567890');
  eq('来源标为 env', secretStatus(['probe.env'])['probe.env'], 'env:REN_PROBE_ENV');
  ok('没有落盘', !fs.existsSync(path.join(SEC, 'probe.env')));
  delete process.env.REN_PROBE_ENV;
}

console.log('[3] 生成与复用');
{
  __test.reset();
  const a = secretValue('probe.gen', { bytes: 16, minLen: 16 });
  eq('长度 = bytes*2（hex）', a.length, 32);
  const f = path.join(SEC, 'probe.gen');
  eq('文件权限 600', (fs.statSync(f).mode & 0o777).toString(8), '600');
  __test.reset();
  const b = secretValue('probe.gen', { bytes: 16, minLen: 16 });
  eq('重新解析（模拟重启）拿到同一个值', b, a);
}

console.log('[4] 老文件迁移');
{
  __test.reset();
  const legacy = path.join(tmp, 'old.key');
  fs.writeFileSync(legacy, 'legacy-secret-value-abcdef', { mode: 0o600 });
  const v = secretValue('probe.mig', { bytes: 8, minLen: 8, legacy });
  eq('迁过来的值不变', v, 'legacy-secret-value-abcdef');
  ok('默认只复制、不删除老文件（测试进程不许误删真实凭证）', fs.existsSync(legacy));
  eq('新位置已写入', fs.readFileSync(path.join(SEC, 'probe.mig'), 'utf8'), 'legacy-secret-value-abcdef');
}

console.log('[4b] 显式 move 才删除');
{
  __test.reset();
  const legacy = path.join(tmp, 'old2.key');
  fs.writeFileSync(legacy, 'another-legacy-value-abcdef', { mode: 0o600 });
  process.env.REN_ADOPT_LEGACY = 'move';
  secretValue('probe.mov', { bytes: 8, minLen: 8, legacy });
  delete process.env.REN_ADOPT_LEGACY;
  ok('REN_ADOPT_LEGACY=move 时原位被删', !fs.existsSync(legacy));
}

console.log('[5] JSON 老文件（self-token.json 的形态）');
{
  __test.reset();
  const legacy = path.join(tmp, 'self-token.json');
  fs.writeFileSync(legacy, JSON.stringify({ token: 'tok-in-json-1234567890', _note: 'x' }));
  const v = secretValue('probe.json', {
    bytes: 8, minLen: 8, legacy,
    legacyPick: raw => JSON.parse(raw).token
  });
  eq('从 JSON 里挑出 token，而不是整段 JSON', v, 'tok-in-json-1234567890');
}

console.log('[6] create:false 的必须允许缺失');
{
  __test.reset();
  const v = secretValue('probe.off', { bytes: 8, minLen: 8, create: false });
  eq('没有就返回空串', v, '');
  ok('没有偷偷生成文件', !fs.existsSync(path.join(SEC, 'probe.off')));
  eq('来源标为 missing', secretStatus(['probe.off'])['probe.off'], 'missing');
}

console.log('[7] 部署目录卫生');
{
  /* 名单在 lib/config.js 里，发布闸门用的是同一份——两边各写一套会慢慢长歪。
     只查「密钥类」文件名，不查 data/ 里的业务数据。 */
  const hits = findSecretFiles(ROOT);
  /* 迁移是一次性的：先发布让线上把老密钥搬进密钥目录，再在本机清理。
     这个环境变量只在那个窗口里用一次，用来显式列出现在还允许存在的历史文件；
     默认（CI / 正常发布）为空，等于「一个都不许有」。 */
  const allow = String(process.env.REN_ALLOW_LEGACY_SECRETS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const unexpected = hits.filter(h => !allow.includes(h));
  const tolerated = hits.filter(h => allow.includes(h));
  if (tolerated.length) console.log('  · 已登记的历史文件（待迁移）：' + tolerated.join(', '));
  eq('app 目录里没有任何密钥类文件', unexpected, []);
}

console.log('[8] 真实消费方已接上（静态断言）');
{
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok('authn.js 用 config 取密钥', /secretValue\('authn\.key'/.test(read('lib/authn.js')));
  ok('alerts.js 用 config 取密钥', /secretValue\('alerts\.key'/.test(read('lib/alerts.js')));
  ok('selfsrc.js 用 config 取密钥', /secretValue\('self\.key'/.test(read('lib/selfsrc.js')));
  ok('authn.js 不再直接读 workspace 下的 .authn.key',
    !/readFileSync\([^)]*\.authn\.key/.test(read('lib/authn.js')));
  ok('selfsrc.js 不再直接读根目录 self-token.json',
    !/readFileSync\(path\.join\(ROOT, 'self-token\.json'\)/.test(read('lib/selfsrc.js')));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
