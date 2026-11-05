// 改完自动跑测试 —— 把「改坏了」从「下一轮才发现」提前到「这一步就暴露」。
//
// 为什么必须有这一层：模型说「已改好」不算数，语法闸门只保证「能解析」，
// 保证不了「逻辑还对」。上一轮实测就吃过这个亏——verifyStep 把失败的 run_shell
// 判成通过，整条验证链是假的。测试是唯一能让「对不对」由机器说了算的东西。
//
// 三条原则：
// 1) 只跑能跑的：工作区没有测试基建就静默跳过，绝不编一个「通过」出来
// 2) 只跑该跑的：改 .md/.docx 不触发；有 scripts.test 就听它的，否则扫约定名
// 3) 判断要诚实：失败不一定这次改出来的。有基线就只算「新冒出来的」，并如实说明
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/* 只有这些后缀的改动值得跑测试。文档/图片/表格改了跑测试纯属浪费 */
const CODE_EXT = /\.(m?js|cjs|jsx|ts|tsx|py)$/i;

/* 测试文件约定名：xxx-test.mjs / xxx.test.js / test_xxx.py / xxx_test.py
   ——刻意不匹配 *-eval.mjs、render-smoke.mjs 这类「评测 / 冒烟」脚本：
   它们往往要网络或模型额度，塞进每次改动后的自动跑只会又慢又假红。 */
const TEST_NAME = /[-_.]test\.(?:m?js|cjs|jsx|ts|tsx)$|^test[-_.].+\.(?:m?js|cjs|jsx|ts|tsx)$/i;
const TEST_PY = /^test_.+\.py$|_test\.py$/i;

/* ANSI 色码一律剥掉：不同 runner 会自己染色，留着会污染关键词匹配 */
const ANSI = /\u001b\[[0-9;]*m/g;

export function isCodeFile(rel) {
  return CODE_EXT.test(String(rel || ''));
}

/** 扫 test / tests / __tests__ 下的约定名文件，返回相对路径数组 */
function scanTestFiles(root) {
  const out = [];
  for (const dir of ['test', 'tests', '__tests__']) {
    const abs = path.join(root, dir);
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && TEST_NAME.test(e.name)) out.push(`${dir}/${e.name}`);
    }
  }
  return out.sort();
}

/**
 * 找出这个工作区该怎么跑测试。返回 null 表示「没有测试可跑」。
 * 顺序是有讲究的：项目自己声明的 scripts.test 最可信（可能是 jest/vitest/自定义 runner），
 * 只有它不存在或只是个占位 echo 时，才按文件名约定自己拼命令。
 */
export function discoverTests(root) {
  const r = path.resolve(root);
  const pkgFile = path.join(r, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const s = String((pkg.scripts && pkg.scripts.test) || '');
      if (s && !/no test specified/i.test(s)) {
        return { kind: 'npm', label: 'npm test', cmd: 'npm', args: ['test', '--silent'], files: [] };
      }
    } catch { /* package.json 坏了不致命，继续往下找 */ }
  }

  const files = scanTestFiles(r);
  if (files.length) return { kind: 'node', label: `${files.length} 个测试文件`, cmd: process.execPath, args: [], files };

  /* Python：有 pytest 配置或 pyproject 才按 pytest 跑，否则不猜 */
  try {
    const py = fs.readdirSync(r).filter(n => TEST_PY.test(n));
    const hasCfg = ['pytest.ini', 'conftest.py', 'pyproject.toml', 'setup.cfg'].some(n => fs.existsSync(path.join(r, n)));
    if (py.length && hasCfg) return { kind: 'pytest', label: `${py.length} 个 pytests`, cmd: 'python3', args: ['-m', 'pytest', '-q', '--no-header'], files: py };
  } catch { /* 目录读不了就当没有 */ }

  return null;
}

/** 起一个子进程，带超时强杀。用 spawn 数组参数而不是 exec 拼串：文件名里有空格/引号也不会被当成 shell */
function runOne(cmd, args, cwd, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let out = '', err = '', killed = false, timer = null, settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err, ms: Date.now() - t0, killed });
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        shell: false,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' }
      });
    } catch (e) {
      return resolve({ code: -1, out: '', err: `起不来：${e.message}`, ms: 0, killed: false });
    }
    timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, timeoutMs);
    child.stdout.on('data', d => { if (out.length < 200000) out += d; });
    child.stderr.on('data', d => { if (err.length < 200000) err += d; });
    child.on('error', e => { err += `\n${e.message}`; finish(-1); });
    child.on('close', code => finish(typeof code === 'number' ? code : -1));
  });
}

/* 各家 runner 的失败行长得都不一样，统一成 {name} 一种。只认明确的失败标记，
   不认「Error:」这种——通过用例里也可能打印 Error 字样，会把绿判成红。 */
const FAIL_PATTERNS = [
  /^\s*✗\s+(.+?)\s*$/,                          // 本项目自研测试 / 多数中文脚本
  /^\s*✕\s+(.+?)\s*$/,                          // vitest
  /^\s*not ok\s+\d+\s*[-–]?\s*(.+)$/i,           // TAP / node:test
  /^FAILED\s+(\S+)(?:\s*[-–]\s*(.*))?$/          // pytest
];

/** 解析一次测试进程的输出。返回 { pass, fail, fails:[{name}], parsed } */
export function parseTestOutput(stdout, stderr, code, file) {
  const text = `${stdout || ''}\n${stderr || ''}`.replace(ANSI, '');
  const fails = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    for (const re of FAIL_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const name = String(m[2] ? `${m[1]} ${m[2]}` : m[1]).trim().slice(0, 160);
      if (!name || seen.has(name)) break;
      seen.add(name);
      fails.push({ name, file: file || '' });
      break;
    }
  }

  /* 通过/失败数：优先认「N 通过 / M 失败」这种明确汇总，再退到各家的英文汇总行 */
  let pass = 0, fail = fails.length;
  const zh = /(\d+)\s*通过\s*\/\s*(\d+)\s*失败/.exec(text);
  if (zh) { pass = Number(zh[1]); fail = Number(zh[2]); }
  else {
    const jest = /Tests:\s*(?:(\d+)\s*failed,)?\s*(?:(\d+)\s*passed,?)?/.exec(text);
    const vpass = /(\d+)\s+passed/i.exec(text);
    const vfail = /(\d+)\s+failed/i.exec(text);
    if (vpass) pass = Number(vpass[1]);
    if (vfail) fail = Math.max(fail, Number(vfail[1]));
    else if (jest && jest[1]) fail = Math.max(fail, Number(jest[1]));
  }

  /* 进程挂了却一条失败都没解析出来（import 报错、语法错、找不到模块）：
     这是最容易被漏掉的红 —— 必须补一条伪失败，否则「0 失败」会被当成通过 */
  if (code !== 0 && !fails.length) {
    const tail = text.split('\n').map(s => s.trim()).filter(Boolean).slice(-3).join(' / ').slice(0, 200);
    fails.push({ name: `进程退出码 ${code}，没有断言输出${tail ? `：${tail}` : ''}`, file: file || '' });
    if (!fail) fail = 1;
  }

  return { pass, fail, fails, parsed: fails.length > 0 || !!zh };
}

const fmt = (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/* 基线：同一个工作区 + 同一种跑法，记上一次的失败集合。
   有它才能回答「这些红是这次改出来的，还是本来就红」——不然模型会去修不相干的测试。 */
const BASELINE = new Map();
const LOCKS = new Map();
/* 跑不完的项目：一旦某套测试在预算内跑不完，就别每次改文件都再烧一遍预算。
   记下来，10 分钟内对同一个 key 直接跳过（如实标 too-slow，不冒充通过）。 */
const SLOW = new Map();
const SLOW_TTL = 10 * 60 * 1000;

export function resetBaseline() {
  BASELINE.clear();
  LOCKS.clear();
  SLOW.clear();
}

const failKey = (f) => `${f.file}::${f.name}`;

/* 同一个工作区串行跑：并发跑测试会互相抢 CPU、输出交错，还会把一个进程池打满 */
function withLock(key, fn) {
  const prev = LOCKS.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  LOCKS.set(key, next.catch(() => {}));
  return next;
}

/**
 * 改完跑测试。返回：
 *   { ran:false, reason }  —— 没跑（不是代码文件 / 没有测试 / 没开 exec 权限）
 *   { ran:true, pass, why, evidence, files, passCount, failCount, fresh, known, ms }
 *
 * 「没跑」和「跑挂了」必须严格分开：前者静默通过，后者必须判失败。
 */
export async function runAfterEdit({ root, changed, perms, budgetMs = 45000, timeoutMs = 20000 }) {
  /* 跑测试 = 执行工作区里的代码。用户写的 test 文件就是任意代码，
     所以这里的权限必须是 exec，不能因为「只是改了个文件」就放行。 */
  if (!perms || !perms.exec) return { ran: false, reason: 'no-exec-perm' };
  if (!isCodeFile(changed)) return { ran: false, reason: 'not-code' };

  const spec = discoverTests(root);
  if (!spec) return { ran: false, reason: 'no-tests' };

  const key = `${path.resolve(root)}|${spec.kind}|${spec.label}`;
  const slowAt = SLOW.get(key);
  if (slowAt && Date.now() - slowAt < SLOW_TTL) return { ran: false, reason: 'too-slow' };
  return withLock(key, () => execSpec(key, spec, root, budgetMs, timeoutMs));
}

/* 小并发跑测试：本项目 23 个文件串行要 11 秒，每次改文件都等 11 秒没法用。
   并发 3 能把这段压到 4 秒上下，又不至于在一台小机器上把 CPU 抢光反而更慢。
   并发安全的前提是测试互不写同一份文件——本项目每个测试用 mkdtemp 建自己的临时目录。 */
const PAR = Math.max(1, Math.min(3, (os.cpus() || []).length || 1));

/* 固定并发跑一批任务，结果按输入顺序返回（顺序错了会让「哪个文件红了」对不上） */
async function runPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function execSpec(key, spec, root, budgetMs, timeoutMs) {
  const t0 = Date.now();
  const runs = [];
  let timedOut = false;

  const one = async (file) => {
    /* 先看总预算还剩多少，再被单文件超时夹一次：剩下不够 1.5 秒就别起了，
       起了也只能被强杀，白烧一次进程启动 */
    const raw = budgetMs - (Date.now() - t0);
    if (raw <= 1500) { timedOut = true; return null; }
    const left = Math.min(timeoutMs, raw);
    const r = await runOne(spec.cmd, file ? [...spec.args, file] : spec.args, root, left);
    const parsed = parseTestOutput(r.out, r.err, r.code, file);
    /* 单个文件超时：把「跑了多久被掐」写成唯一一条失败，比让上游看到一句
       「进程退出码 -1，没有断言输出」清楚得多 */
    if (r.killed) {
      parsed.fails = [{ name: `跑了 ${fmt(r.ms)} 超过单文件上限 ${fmt(left)}，已中止`, file: file || '' }];
      parsed.fail = 1;
      parsed.pass = 0;
    }
    return { file: file || '', code: r.code, ms: r.ms, killed: r.killed, errTail: String(r.err || '').slice(0, 400), ...parsed };
  };

  if (spec.kind === 'node') {
    const got = await runPool(spec.files, PAR, f => one(f));
    for (const r of got) if (r) runs.push(r);
  } else if (spec.kind === 'pytest') {
    /* pytest 一次就把整个目录跑完了，逐个传文件反而会重复收集 */
    const r = await one(null);
    if (r) runs.push(r);
  } else {
    /* npm test：ENOENT 说明这机器上没有 npm（只有 node）——退化成扫测试文件，别报假错 */
    const r = await one(null);
    if (r && r.code === -1 && /ENOENT|起不来/.test(r.errTail)) {
      const files = scanTestFiles(path.resolve(root));
      if (files.length) {
        const got = await runPool(files, PAR, f => one(f));
        for (const rr of got) if (rr) runs.push(rr);
      } else {
        return { ran: false, reason: 'npm-missing' };
      }
    } else if (r) {
      runs.push(r);
    }
  }

  const ms = Date.now() - t0;
  const passCount = runs.reduce((a, r) => a + (r.pass || 0), 0);
  const failCount = runs.reduce((a, r) => a + (r.fail || 0), 0);
  const fails = runs.flatMap(r => r.fails || []);
  const allGreen = runs.length > 0 && runs.every(r => r.code === 0) && failCount === 0;

  const prev = BASELINE.get(key);
  const cur = new Set(fails.map(failKey));
  const fresh = prev ? [...cur].filter(k => !prev.has(k)) : [...cur];
  const known = prev ? [...cur].filter(k => prev.has(k)) : [];
  BASELINE.set(key, cur);

  const files = runs.map(r => r.file).filter(Boolean);
  /* 失败证据：文件名 + 断言名，够模型定位就行，不要把几万字测试输出塞进上下文 */
  const evidence = fails.length
    ? `【改完自动跑了测试｜${spec.label}，${fmt(ms)}】\n`
      + fails.slice(0, 12).map(f => `  ✗ ${f.file ? f.file + ' → ' : ''}${f.name}`).join('\n')
      + (fails.length > 12 ? `\n  …还有 ${fails.length - 12} 项` : '')
    : '';

  if (timedOut) {
    /* 只跑了一半就超预算：已跑的那几个再绿也不能算过——剩下的没跑，结论不完整 */
    SLOW.set(key, Date.now());
    return {
      ran: true, pass: false, ms, files, passCount, failCount, fresh: [], known: [],
      why: `测试跑到 ${fmt(ms)} 还没跑完，已按预算中止（${Math.round(budgetMs / 1000)}s）：`
        + `只跑完 ${runs.length}/${spec.kind === 'node' ? spec.files.length : 1} 个，结果不完整`,
      evidence: fails.length ? '' : ''
    };
  }

  if (allGreen) {
    return {
      ran: true, pass: true, ms, files, passCount, failCount: 0, fresh: [], known: [],
      why: `改完自动跑了测试，全通过（${passCount} 项，${fmt(ms)}）`,
      evidence: ''
    };
  }

  /* 首次跑就红：没有基线可比，「是不是这次改出来的」无法判断。
     这里判失败并如实说明——不判失败等于放行一次未经检验的改动，那这一层就没意义了。 */
  if (!prev) {
    return {
      ran: true, pass: false, ms, files, passCount, failCount, fresh, known: [],
      why: `改完跑了测试，${failCount || fails.length} 项失败${passCount ? `（通过 ${passCount} 项）` : ''}。`
        + '这是第一次跑，没法判断是不是这次改出来的——先看下面失败的是哪几项：属于你改的范围就修掉，确实是原本就红的就在结论里说明。',
      evidence
    };
  }

  if (!fresh.length) {
    return {
      ran: true, pass: true, ms, files, passCount, failCount, fresh: [], known,
      why: `改完跑了测试，没有新增失败（仍有 ${known.length} 项既有失败，与本次改动无关）`,
      evidence: ''
    };
  }

  return {
    ran: true, pass: false, ms, files, passCount, failCount, fresh, known,
    why: `改完跑测试挂了：新出现 ${fresh.length} 项失败（共 ${failCount} 项，${fmt(ms)}）`,
    evidence
  };
}
