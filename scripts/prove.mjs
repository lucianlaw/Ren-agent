// 自证：把「我修好了」变成一份别人能复核的证据
//
//   npm run prove -- --ticket <工单号> --test test/xxx-test.mjs
//   npm run prove -- --ticket <工单号> --test test/xxx-test.mjs --fix <提交>
//   npm run prove -- --test test/xxx-test.mjs --dry     只看会怎么做，不真跑
//
// 它在做什么（这些步骤全在临时 worktree 里，不动当前工作区）：
//   1. 检出修复提交的父提交
//   2. 把修复提交里的那份测试原样铺过去
//   3. 在旧代码上跑 → 必须失败
//   4. 在修复提交上跑 → 必须通过且 0 失败
//   5. 结果写进 data/proofs/，结算 fixed / verified 时会检查它
//
// 为什么不能只信 agent 贴的终端输出：那段文字是它自己写的。
// 它完全可能跑的是另一份测试、或者把失败说成成功、或者「红」其实是
// 模块不存在（只证明功能原来没有，不证明 bug 原来在）。
import { runProof, saveProof, checkTestPath } from '../lib/proof.js';

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || '') : def;
}
const has = (name) => process.argv.includes(name);

const ticketArg = arg('--ticket');
const testArg = arg('--test');
const fixArg = arg('--fix', 'HEAD');
const baseArg = arg('--base');
const dry = has('--dry');
const asJson = has('--json');

if (!testArg) {
  console.error('要给测试文件：--test test/xxx-test.mjs');
  process.exit(2);
}
const tp = checkTestPath(testArg);
if (!tp.ok) {
  console.error(tp.why);
  process.exit(2);
}

/* 工单号是短哈希。这里要把它换回完整签名——签名才是证据的归属。 */
let sig = ticketArg;
let ticket = null;
if (ticketArg) {
  const T = await import('../lib/ticket.js');
  const all = T.listTickets({ limit: 500, includeDropped: true });
  ticket = all.tickets.find(t => t.key === ticketArg || t.sig === ticketArg) || null;
  if (ticket) sig = ticket.sig;
  else if (ticketArg.includes('|')) sig = ticketArg;   /* 直接给了完整签名 */
  else {
    console.error(`找不到工单 ${ticketArg}。用 listTickets 的口径对一下短 id。`);
    process.exit(2);
  }
} else {
  console.error('提示：不给 --ticket 也能跑，但证据没法挂到工单上（结算时会被拦）。');
}

if (dry) {
  console.log('会做的事：');
  console.log(`  测试    ${tp.path}`);
  console.log(`  修复    ${fixArg}`);
  console.log(`  基线    ${baseArg || fixArg + ' 的父提交'}`);
  console.log(`  工单    ${ticket ? ticket.key + ' ' + ticket.zh : '(未指定)'}`);
  console.log('（--dry 只打印，不跑）');
  process.exit(0);
}

const t0 = Date.now();
console.log('跑证明中（会检出两个临时 worktree，跑两遍测试）…');
const proof = await runProof({ sig: sig || '', test: tp.path, fix: fixArg, base: baseArg });

if (asJson) {
  console.log(JSON.stringify(proof, null, 2));
} else {
  console.log('');
  for (const c of proof.checks || []) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${String(c.id).padEnd(20)} ${c.detail || ''}`);
  }
  console.log('');
  if (proof.red) {
    console.log(`旧代码：退出码 ${proof.red.exit}，${proof.red.kind}，${proof.red.pass} 通过 / ${proof.red.fail} 失败`);
  }
  if (proof.green) {
    console.log(`新代码：退出码 ${proof.green.exit}，${proof.green.kind}，${proof.green.pass} 通过 / ${proof.green.fail} 失败`);
  }
  if (proof.fix) console.log(`提交：${String(proof.base).slice(0, 8)} → ${String(proof.fix).slice(0, 8)}（${proof.changedCount || 0} 个文件变动）`);
  console.log(`耗时：${proof.ms}ms`);
  console.log('');
  if (proof.ok) {
    console.log(proof.strong
      ? '结论：通过（强红）—— 旧代码上是断言失败，这份修复确实消灭了一个当时存在的问题。'
      : '结论：通过（弱红）—— 旧代码上是「加载失败」而不是断言失败，只能证明这个能力原来没有；标 verified 会被拦。');
  } else {
    console.log('结论：没通过 —— ' + (proof.why || '红→绿 不成立'));
  }
}

if (sig) {
  const saved = saveProof(proof);
  if (!saved) console.log('警告：证据写不进 data/proofs/（磁盘权限？），这次证明没有被记录下来。');
  else if (proof.ok) console.log('证据已记在 data/proofs/ 下，结算 fixed / verified 时会用到它。');
} else if (proof.ok) {
  /* 没有工单的证据等于没有：结算时按 sig 找，找不到照样拦。 */
  console.log('提示：这次证明没有挂到任何工单上，所以它不能用于结算（结算按签名找证据）。');
}

process.exit(proof.ok ? 0 : 1);
