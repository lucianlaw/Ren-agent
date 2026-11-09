#!/usr/bin/env node
/* 起一个 dev 实例。

   它存在的唯一理由：让「dev 只有我能访问」和「dev 不碰生产数据」这两条
   变成默认值，而不是每次启动前要背下来的四条环境变量。

   它做的事很少——算好路径、建好目录、把变量钉死、把自己换成 server.js。
   不做的事同样重要：不改代码、不复制生产数据、不连生产状态库。

   用法：
     npm run dev                     # 用当前目录的代码，数据放 ../.ren-dev
     npm run dev -- --port 8091
     npm run dev -- --dir ../.ren-dev/work   # 跑 worktree 里那一份代码

   数据目录结构：
     <REN_DEV_ROOT>/state      状态库（runs / locks / leases / rate）
     <REN_DEV_ROOT>/workspace  所有账号的工作区
     <REN_DEV_ROOT>/audit      审计日志
     <REN_DEV_ROOT>/incidents  报错记录
     <REN_DEV_ROOT>/tickets    工单状态
     <REN_DEV_ROOT>/repair     修复工作区（worktree + 分诊决策）
     <REN_DEV_ROOT>/proofs     自证证据
   七个都在 REN_DEV_ROOT 下，这正是 lib/devinfo.js 要求的——
   任何一个跑到外面去，server 会拒绝启动。 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : dflt;
}

const DEV_ROOT = path.resolve(arg('root', process.env.REN_DEV_ROOT || path.join(APP, '..', '.ren-dev')));
const CODE_DIR = path.resolve(arg('dir', APP));
const PORT = String(arg('port', '8090'));

/* 本地没有「账号」这回事，默认把云端身份校验关掉。
   不关的结果是本机这套东西用不了：dev 跑在 127.0.0.1，浏览器从云端换到的令牌
   其 client 就是 `http://127.0.0.1:8090`，它不属于本应用，拿去 whoami 一律
   invalid_grant。表现出来是「登录态已失效（凭证过期）」——但凭证没过期，是
   这个入口天生就没有登录态。
   要验真实的鉴权链路时用 --auth strict：那时页面停在未登录是正确行为。 */
const AUTH = String(arg('auth', 'off')).toLowerCase() === 'strict' ? 'strict' : 'off';
const LOCAL = AUTH === 'off';

/* 端口不能是生产口：这里先拦一次，给的是「换个端口」而不是 server 那句更长的解释 */
if (Number(PORT) === 8080) {
  console.error('\n  8090 之外别用 8080 —— 那是生产端口，dev 抢了它生产就起不来了。\n');
  process.exit(2);
}

if (!fs.existsSync(path.join(CODE_DIR, 'server.js'))) {
  console.error(`\n  ${CODE_DIR} 里没有 server.js —— --dir 指错了吧？\n`);
  process.exit(2);
}

const DIRS = {
  REN_DEV_ROOT: DEV_ROOT,
  WORKSPACE_DIR: path.join(DEV_ROOT, 'workspace'),
  REN_STATE_DIR: path.join(DEV_ROOT, 'state'),
  AUDIT_DIR: path.join(DEV_ROOT, 'audit'),
  INCIDENT_DIR: path.join(DEV_ROOT, 'incidents'),
  /* 这三个是后来加的库（工单 / 修复工作区 / 自证证据）。它们的 `*_DIR`
     不设就落回 `data/<库>`，而那正是生产在用的那一份——dev 实例上演示一轮，
     生产数据目录里就多出一批假工单，下一次发布还会把整个 data/ 打包上去。 */
  TICKET_DIR: path.join(DEV_ROOT, 'tickets'),
  REPAIR_DIR: path.join(DEV_ROOT, 'repair'),
  PROOF_DIR: path.join(DEV_ROOT, 'proofs')
};

for (const [k, v] of Object.entries(DIRS)) {
  if (k === 'REN_DEV_ROOT') continue;
  try { fs.mkdirSync(v, { recursive: true }); } catch (e) {
    console.error(`\n  建不了 ${v}：${e.message}\n`);
    process.exit(2);
  }
}

/* 第一次起 dev 实例时把边界说清楚：这一步之后写的每个文件都落在这个目录里，
   删掉这个目录就等于把 dev 的一切清空，而生产一个字节都不会少。 */
const fresh = !fs.existsSync(path.join(DEV_ROOT, 'state'));

console.log('');
console.log('  dev 实例');
console.log('  ────────────────────────────────────────────');
console.log('  代码：  ' + CODE_DIR);
console.log('  数据：  ' + DEV_ROOT + (fresh ? '  （新建）' : ''));
console.log('  监听：  127.0.0.1:' + PORT + '  （只有本机能访问）');
console.log('  身份：  ' + (LOCAL
  ? '本地（不问云端；管理员 = 这台机器）'
  : '严格（按云端凭证，未登录时页面会停在登录态）'));
/* 直连档只从环境变量读，不从命令行读：KEY 写进命令行会落进 shell 历史。 */
const DIRECT_ON = /^(1|true|yes|on)$/i.test(String(process.env.REN_LLM_DIRECT || ''));
console.log('  模型：  ' + (DIRECT_ON
  ? '直连 ' + (process.env.REN_LLM_BASE || '(缺 REN_LLM_BASE)')
    + ' · ' + (process.env.REN_LLM_MODEL || '(缺 REN_LLM_MODEL)')
    + (process.env.REN_LLM_KEY ? '' : ' · 缺 REN_LLM_KEY')
  : '托管通道（凭证必须是本应用签发的）'));
if (LOCAL && !DIRECT_ON) {
  console.log('  注意：  本地拿到的令牌 client 是 127.0.0.1，托管通道不认它，任务一发起就会被拒。');
  console.log('          要在这里跑任务，加 REN_LLM_DIRECT=1 + REN_LLM_BASE + REN_LLM_KEY + REN_LLM_MODEL。');
}
console.log('  ────────────────────────────────────────────');
console.log('  生产数据不在这个目录里，改坏了删掉本目录即可。');
console.log('');

const env = {
  ...process.env,
  ...DIRS,
  /* 这三个是 devinfo.js 的判据。写死在这里，不给「临时改成 0.0.0.0 试试」
     留口子——要对外开放就该走发布流程，而不是把开发实例暴露出去。 */
  REN_DEV_INSTANCE: '1',
  HOST: '127.0.0.1',
  PORT,
  /* 两个开关一起给：关了校验却不给管理员，页面上看得见工具、一调就 403。
     它们只在本机生效（HOST 钉在回环），跟着 dev 实例走，不写进任何配置。 */
  REN_AUTH_MODE: AUTH,
  ...(LOCAL ? { ADMIN_DEV: '1' } : {})
};

const child = spawn(process.execPath, ['server.js'], {
  cwd: CODE_DIR,
  env,
  stdio: 'inherit'
});

child.on('exit', (code, sig) => {
  if (sig) process.kill(process.pid, sig);
  else process.exit(code ?? 0);
});
