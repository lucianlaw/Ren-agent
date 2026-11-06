/* ── dev 实例的隔离闸门 ──

   约定有两条：
     1. dev 实例只有维护者本人能访问；
     2. dev 实例不碰生产数据。

   这两条都写进了文档，而写进文档的约定会在第三个忙周被忘掉。所以这里把它们
   变成**启动条件**：不满足就拒绝启动，而不是打一行警告。

   为什么必须是拒绝而不是警告：
   - 绑到 0.0.0.0 的 dev 实例 = 一个能改源码的入口挂在公网上。警告会被人按
     回车跳过，拒绝不会。
   - 连到生产数据的 dev 实例 = 在 dev 里删掉的东西是真的没了。这种错误发生时
     没有任何提示，要等到有人发现文件不见了才知道。

   判据刻意要求「显式」：dev 模式下四个数据目录**必须**逐个设好，且都落在
   REN_DEV_ROOT 之内。不靠默认值的原因是默认值恰好就是生产路径——那正是
   最坏的失败形态：一切看起来正常，只是数据是真实的。 */

import path from 'node:path';

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;

/* 生产端口。dev 必须换一个，否则两个实例抢同一个口，
   表现出来是「生产突然起不来了」，排查成本远高于在这里拦一下。 */
const PROD_PORT = 8080;

/* 四个必须有自己份的数据目录：键名 = 环境变量，值 = 说人话的名字 */
const DIRS = [
  ['WORKSPACE_DIR', '工作区'],
  ['REN_STATE_DIR', '状态库'],
  ['AUDIT_DIR', '审计日志'],
  ['INCIDENT_DIR', '报错记录']
];

export function devMode(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.REN_DEV_INSTANCE || ''));
}

/* 目录是否在 root 之下（root 自身也算）。
   注意这里比的是字符串前缀，符号链接能绕过——dev 目录是自己建的、不含外部
   软链，所以不为此付出 realpath 的代价（目标目录可能还不存在，realpath 会抛）。 */
function under(root, p) {
  if (!root) return false;
  const a = path.resolve(root);
  const b = path.resolve(p);
  return b === a || b.startsWith(a + path.sep);
}

/* 返回问题清单（空数组 = 合格）。单独导出是为了能测：
   启动闸门本身很难测（它 process.exit），但判定逻辑可以。 */
export function isolationProblems(env = process.env) {
  const out = [];
  const devRoot = env.REN_DEV_ROOT ? String(env.REN_DEV_ROOT) : '';

  if (!devRoot) {
    out.push('没设 REN_DEV_ROOT —— dev 的数据必须圈在一个目录里，'
      + '否则说不清哪些文件是它的、哪些是生产的。');
  }

  /* ① 谁能访问：必须是回环，且必须显式写出来 */
  const host = String(env.HOST || '');
  if (!host) {
    out.push('没设 HOST —— dev 必须显式绑回环（HOST=127.0.0.1）。'
      + '留空会走默认值，而默认值在设了 PORT 的情况下是 0.0.0.0。');
  } else if (!LOOPBACK.test(host)) {
    out.push(`HOST=${host} 不是回环地址 —— dev 实例能改源码，`
      + '绑到对外地址等于把「改生产代码」的权限挂到公网上。');
  }

  /* ② 端口：必须显式、必须不是生产口 */
  const portRaw = String(env.PORT || '');
  const port = Number(portRaw);
  if (!portRaw) {
    out.push('没设 PORT —— dev 必须显式用另一个端口（比如 8090），不能和生产抢。');
  } else if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    out.push(`PORT=${portRaw} 不是合法端口号。`);
  } else if (port === PROD_PORT) {
    out.push(`PORT=${PROD_PORT} 是生产端口 —— dev 换一个（比如 8090）。`);
  }

  /* ③ 数据边界：四个目录逐个显式设，且都在 REN_DEV_ROOT 之下 */
  for (const [key, zh] of DIRS) {
    const v = String(env[key] || '');
    if (!v) {
      out.push(`没设 ${key} —— dev 的${zh}必须显式指向 dev 目录。`
        + '留空会落回默认路径，而那正是生产在用的那一份。');
      continue;
    }
    if (devRoot && !under(devRoot, v)) {
      out.push(`${key}=${v} 跑到 REN_DEV_ROOT 外面了 —— `
        + `dev 的${zh}必须待在 dev 目录内，否则就是在动真实数据。`);
    }
  }

  return out;
}

/* 启动闸门。返回结构化结果而不是直接 exit，让 server.js 决定怎么死——
   测试里也能拿到同一份判定而不触发退出。 */
export function assertSafe(env = process.env) {
  if (!devMode(env)) return { ok: true, dev: false, problems: [] };
  const problems = isolationProblems(env);
  if (!problems.length) return { ok: true, dev: true, problems: [] };
  const message = '\n  dev 实例拒绝启动（这是闸门，不是 bug）：\n'
    + problems.map(s => '  · ' + s).join('\n')
    + '\n\n  用 npm run dev 起 dev 实例，它会把上面这些变量都设好。\n'
    + '  想手工起的话，四个目录 + HOST + PORT + REN_DEV_ROOT 一个都不能省。\n';
  return { ok: false, dev: true, problems, message };
}

export const __test = { LOOPBACK, PROD_PORT, DIRS, under };
