#!/usr/bin/env node
/**
 * 发布闸门。
 *
 * 存在理由：以前「发布」= 把文件夹传上去。于是线上跑的东西对应不到任何一个 commit，
 * 出了问题既回答不了「线上是哪个版本」，也没法「回滚到上一版」。更常见的是
 * 测试没跑就发了——不是有人故意，是没有任何东西会拦。
 *
 * 五道门，按「越便宜越先」排：
 *   1. 工作区必须干净 —— 否则线上跑的东西不是一个 commit，回滚无从谈起
 *   2. 部署目录不许有密钥文件 —— 上传是把整个目录压包，密钥会跟着走
 *   3. 部署目录不许有运行时数据 —— 同上，而且它会在线上装成生产数据
 *   4. 全量测试必须通过 —— 这才是真正的闸门，不是我记得跑
 *   5. 产物冒烟 —— 把将要上传的那一份单独跑起来（平台上没有第二个应用可建，
 *      「先验后发」只能退化成这一步，见 scripts/stage.mjs 的说明）
 *
 * 用法：
 *   node scripts/release.mjs            跑完五道门，写 build.json
 *   node scripts/release.mjs --check    只跑门，不写文件（CI / 发布前自查）
 *   node scripts/release.mjs --rollback <ref>
 *                                       把工作区切回某个 tag/commit，并提示下一步
 *
 * 它不负责发布——发布是部署工具的事。它负责让「发布」有据可查。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSecretFiles, APP_ROOT } from '../lib/config.js';
import { nextVersion } from '../lib/version.js';
import { runtimeDataFiles, explain } from '../lib/deployguard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const ROLLBACK_AT = argv.indexOf('--rollback');

const say = (s = '') => console.log(s);
const pass = (label, note = '') => console.log(`  ✓ ${label}${note ? '  ' + note : ''}`);

/* 各测试文件的收尾格式不统一（「通过 N 项」/「N 通过 / M 失败」/「全部通过：N 项」），
   这里按顺序试，取第一个能认出来的。认不出就当 0，只影响统计不影响通过与否。 */
function countAssertions(out) {
  for (const re of [/通过\s*(\d+)\s*项/, /(\d+)\s*通过/, /全部通过：\s*(\d+)/]) {
    const m = out.match(re);
    if (m) return Number(m[1]);
  }
  return 0;
}
const die = (label, note = '', hint = '') => {
  console.log(`  ✗ ${label}${note ? '  ' + note : ''}`);
  if (hint) console.log('\n' + hint.split('\n').map(l => '    ' + l).join('\n'));
  process.exit(1);
};

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { code: r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

/* ── 回滚：只切代码，不动线上 ──
   刻意不做成「自动重新部署」：回滚本身是有风险的动作，应该由人确认后再发布。
   这里只保证「切到某个已知版本、并且工作区是干净的」。 */
if (ROLLBACK_AT >= 0) {
  const ref = argv[ROLLBACK_AT + 1];
  if (!ref) { console.error('用法：node scripts/release.mjs --rollback <tag|commit>'); process.exit(2); }
  const show = git(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (show.code !== 0) { console.error(`找不到这个版本：${ref}`); process.exit(2); }
  const dirty = git(['status', '--porcelain']);
  if (dirty.out) {
    console.error('工作区有未提交改动，先处理掉再回滚（git stash 或提交）。改动清单：\n' + dirty.out);
    process.exit(1);
  }
  const co = git(['checkout', '--detach', ref]);
  if (co.code !== 0) { console.error('切换失败：' + co.err); process.exit(1); }
  say(`已切到 ${ref}（${show.out.slice(0, 7)}）。下一步：跑 node scripts/release.mjs --check，再发布。`);
  process.exit(0);
}

say('发布闸门');
say('────────────────────────────────────────');

/* [1/5] 工作区干净 */
{
  const st = git(['status', '--porcelain']);
  const head = git(['rev-parse', '--short', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (st.code !== 0) die('读不到 git 状态', '', '这个目录不是 git 仓库。');
  if (st.out) {
    const lines = st.out.split('\n');
    die('工作区不干净', `${lines.length} 个文件待处理`,
      '线上跑的东西必须对应到一个 commit，否则「回滚到上一版」没有落点。\n' +
      '提交：git add -A && git commit -m "..."\n' +
      '改动清单：\n' + lines.slice(0, 15).join('\n') + (lines.length > 15 ? `\n…（共 ${lines.length} 个）` : ''));
  }
  pass('工作区干净', `${branch.out} @ ${head.out}`);
}

/* [2/5] 部署目录不许有密钥 */
{
  /* 名单与 test/config-test.mjs 共用 lib/config.js 里那一份 */
  const allow = String(process.env.REN_ALLOW_LEGACY_SECRETS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const hits = findSecretFiles(ROOT).filter(h => !allow.includes(h));
  if (hits.length) {
    die('部署目录里有密钥文件', hits.join(', '),
      '上传是把整个目录压包下发，这些文件会一起到线上、也留在任何拿到源码包的人手里。\n' +
      '把它们放进密钥目录（与部署目录同级的 .ren-secrets），再从目录里删掉。\n' +
      '确认是历史遗留、只是走一次迁移的话，用 REN_ALLOW_LEGACY_SECRETS="路径" 显式放行。');
  }
  pass('部署目录无密钥');
}

/* [3/5] 部署目录不许有运行时数据
 *
 * 这条是踩出来的：`data/` 在 .gitignore 里，所以它**不会**被 `git status` 看见，
 * 第 1 道门完全放行。但发布工具传的是目录，不是 commit——于是本地跑 dev 时
 * 写进 `data/` 的工单状态、修复快照、分诊决策，一起被打包上去，在线上装成生产数据。
 *
 * 表现出来是很像 bug 的正常现象：线上 health 里出现「修复过 2 轮、当前接着
 * 6927c3… 在修」，而那个工单号在线上根本不存在；工单列表里多出一张从没发生过的
 * E_UI_RENDER。没有这道门的话，唯一的发现方式是去读那条快照并且记得自己没造过它。
 *
 * 判定逻辑在 lib/deployguard.js：放在这里就没法测（这个文件一被 import 就跑满
 * 五道门），而那正是「闸门自己没被验过」的老问题。 */
{
  const files = runtimeDataFiles(ROOT);
  if (files.length) {
    const e = explain(files, files.length);
    die(e.label, e.note, e.hint);
  }
  pass('部署目录无运行时数据');
}

/* [4/5] 全量测试 */
{
  const dir = path.join(ROOT, 'test');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.mjs')).sort();
  if (!files.length) die('找不到测试', '', 'test/*.mjs 为空，闸门等于没有。');
  say(`  · 跑 ${files.length} 个测试文件…`);
  const failed = [];
  let assertions = 0;
  const t0 = Date.now();
  for (const f of files) {
    const r = spawnSync(process.execPath, [path.join('test', f)], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000,
      env: { ...process.env }
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    assertions += countAssertions(out);
    if (r.status !== 0) {
      failed.push({ f, out: out.split('\n').slice(-25).join('\n') });
      console.log(`    ✗ ${f}`);
    }
  }
  if (failed.length) {
    console.log('');
    for (const x of failed) console.log(`--- ${x.f} ---\n${x.out}\n`);
    die('测试没通过', `${failed.length}/${files.length} 个文件失败`, '闸门不放行：测试不过就不该上线。');
  }
  pass('全量测试通过', `${files.length} 个文件 / ${assertions} 项断言 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* [5/5] 产物冒烟：把「将要上传的那一份」单独跑起来
   这一道是 staging 的替代品——平台上发布永远覆盖同一个应用（没有第二个应用可建），
   所以「先在测试环境验」只能退化成「先把产物独立跑一遍再传」。 */
{
  const r = spawnSync(process.execPath, [path.join('scripts', 'stage.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env }
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status !== 0) {
    console.log(out.split('\n').slice(-20).join('\n'));
    die('产物冒烟没通过', '', '这一份产物起不来，不该发布。');
  }
  pass('产物冒烟通过', `${out.match(/体积：(\S+)/)?.[1] || ''}`);
}

/* ── 版本号：从「我记得改」改成「发布时自动判」 ──
   在它之前：版本号是手改的（`perl -pi -e 's/0.8.5/0.8.6/'`）。忘一次，线上就会出现
   「代码是新的、health 说旧版本」——而那正是回滚时唯一的定位依据。
   规则很简单：package.json 的版本必须**大于**上一次发布记录里的版本，
   否则 patch +1 并提交。只增不减，比较的是数字而不是字符串（0.8.10 > 0.8.9）。
   比较与递增的实现挪到了 lib/version.js：放在这里的话，那个文件一被 import
   就会跑满四道门，于是它成了全程唯一没法测的一段。 */
{
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  /* 先把旧版本号存下来：下面会把 pkg.version 改成新值，改完再打印就成了
     「0.8.9 → 0.8.9」——闸门输出的每一条都是给人看的证据，印错了就等于没有。 */
  const before = pkg.version;
  let last = '';
  try { last = JSON.parse(fs.readFileSync(path.join(ROOT, 'build.json'), 'utf8')).version || ''; } catch { /* 第一次发布 */ }
  const pick = nextVersion(pkg.version, last);
  if (pick.bumped) {
    if (CHECK_ONLY) {
      say(`  · 版本号该升了：${before} → ${pick.version}（--check 只提示，不改文件）`);
    } else {
      pkg.version = pick.version;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      /* 必须提交：build.json 记的是 commit，而「这个 commit 里的版本号」才作数；
         不提交的话下一次闸门第 1 道会直接挂（工作区不干净）。 */
      git(['add', 'package.json']);
      const c = git(['commit', '-m', `chore(version): ${pick.version}（发布时自动递增）`]);
      if (c.code !== 0) {
        die('版本号已改成 ' + pick.version + '，但提交失败', c.err.slice(0, 200),
          '手动提交 package.json 之后重跑闸门。');
      }
      pass('版本号自动递增', `${before} → ${pick.version}`);
    }
  } else {
    pass('版本号已递增', pkg.version + (last ? `（上次发布 ${last}）` : ''));
  }
}

/* 写 build.json：这是「线上是哪个版本」的唯一来源 */
const head = git(['rev-parse', 'HEAD']).out;
const info = {
  commit: head.slice(0, 7),
  full: head,
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).out,
  at: new Date().toISOString(),
  version: (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''; }
    catch { return ''; }
  })(),
  dirty: false,
  gate: 'release.mjs'
};

say('');
if (CHECK_ONLY) {
  say(`闸门全过（--check，未写 build.json）。将标记为 ${info.commit} @ ${info.at}`);
  process.exit(0);
}
fs.writeFileSync(path.join(ROOT, 'build.json'), JSON.stringify(info, null, 2) + '\n');
say(`build.json 已写入：${info.commit} @ ${info.at}`);
say('下一步：用部署工具发布本目录；发布后用 /api/health?key=… 核对 build.commit。');
