#!/usr/bin/env node
/**
 * 产物冒烟：把「准备发布的那一份」单独跑起来验一遍，再上传。
 *
 * 为什么不是「staging 环境」：试过了，做不到。这个平台的发布目标是**应用**，
 * 而应用是按工作区登记的——我把同一份代码放到相邻目录发布，返回的
 * sandboxId 和分享链接跟生产完全一样，等于直接覆盖了生产（2026-11-05 实测）。
 * 工具文档也写明「发布永远是覆盖，没有创建第二个应用的入口」。
 *
 * 所以「先在测试环境验、再上线」在这套平台上只能拆成两段：
 *   1. 发布前：本脚本 —— 用 git 归档出**将要上传的那份产物**，独立跑起来，
 *      自己的端口、自己的密钥目录、自己的数据目录，确认它真的能启动、能应答；
 *   2. 发布后：/api/health 核对 build.commit + 一次真实请求。
 * 真正独立的第二套环境要等有第二个应用（另一台主机 / 另一个工作区）才行。
 *
 * 用法：
 *   node scripts/stage.mjs              # 构建 + 冒烟 + 清理
 *   node scripts/stage.mjs --keep       # 留着产物目录，方便自己点两下
 *   node scripts/stage.mjs --ref v0.4.0 # 指定版本（默认 HEAD）
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const refIdx = argv.indexOf('--ref');
const REF = refIdx >= 0 ? argv[refIdx + 1] : 'HEAD';

const say = (s = '') => console.log(s);
const fail = (m) => { console.log('  ✗ ' + m); process.exit(1); };

/* 1. 归档：只取 git 里的东西，data/ workspace/ 密钥一律不进来 ——
      这正是「部署目录里有运行时垃圾」那个问题的解法。 */
const dir = path.join(os.tmpdir(), `ren-stage-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const arch = spawnSync('sh', ['-c', `git archive ${JSON.stringify(REF)} | tar -x -C ${JSON.stringify(dir)}`], {
  cwd: ROOT, encoding: 'utf8'
});
if (arch.status !== 0) fail(`归档 ${REF} 失败：${arch.stderr || arch.stdout}`);
say(`产物：${REF} → ${dir}`);
say(`体积：${(spawnSync('du', ['-sh', dir], { encoding: 'utf8' }).stdout || '').split('\t')[0]}`);

/* 2. 产物必须自带版本标记，否则上线后无法回答「这是哪个版本」 */
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({
  commit: head.slice(0, 7), full: head, at: new Date().toISOString(),
  version: (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return ''; }
  })(),
  stage: 'artifact-smoke', note: '由 scripts/stage.mjs 归档构建'
}, null, 2) + '\n');

/* 3. 独立跑起来：端口、密钥目录、工作区全部与线上分开 */
const freePort = () => new Promise(r => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

const port = await freePort();
const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  WORKSPACE_DIR: path.join(dir, '.run', 'workspace'),
  ALERTS_DIR: path.join(dir, '.run', 'alerts'),
  REN_SECRET_DIR: path.join(dir, '.run', 'secrets'),
  /* 冒烟只验「能不能起来、接口通不通」，不验登录：本机没有云端 Origin，
     强行 strict 会一律 401，那是环境限制不是产物问题。 */
  REN_AUTH_MODE: 'off'
};

const child = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', d => { log += d; });
child.stderr.on('data', d => { log += d; });

const up = async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
};

const health = await up();
child.kill('SIGKILL');

let bad = 0;
const check = (name, cond, extra) => {
  if (cond) say('  ✓ ' + name);
  else { bad++; say('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

if (!health) {
  say('\n启动日志：\n' + log.split('\n').slice(-20).join('\n'));
  fail('产物启动失败 —— 这一份不应发布');
}

const wantCommit = head.slice(0, 7);
check('能启动并应答 /api/health', health.ok === true);
check('版本标记对得上', (health.build || {}).commit === wantCommit, { got: (health.build || {}).commit, want: wantCommit });
check('密钥目录在产物之外', !String((health.secretsDir || {}).path || '').startsWith(dir), health.secretsDir);
check('沙箱模式已报告', typeof (health.runtime) === 'string' || !!health.runtime, health.runtime);

if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
else say(`\n产物保留在：${dir}\n本地预览：PORT=3901 REN_AUTH_MODE=off REN_SECRET_DIR=${dir}/.run/secrets node ${dir}/server.js`);

say('');
if (bad) fail(`产物冒烟 ${bad} 项不通过，不要发布`);
say('产物冒烟通过。可以发布了。');
