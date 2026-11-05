/* 多轮对话：轮次不能被「插话」撑出来，画面不能出现空轮。
 *
 * 真实缺陷（2026-11-05，老板反馈「我发的消息一会儿在上面、一会儿消失」）：
 *   syncRounds 用 `n = asks.length` 当轮数，而 asks 里含着「中途插话」。
 *   于是「第 1 轮 + 插一句 + 第 2 轮」被算成 3 轮，第 3 轮什么都没有。
 *   当前轮指针一旦落到那个空轮上，屏幕上就只剩一片空白——老板看到的就是
 *   「我的话在上面呆了一会儿，然后没了」。
 *
 * 这里钉住三件事：
 *   1) 轮数 = 最大轮号，不是「一共说了几句」
 *   2) 插话不占新轮，跟着最近那句走，且带 inline 标记
 *   3) 归一化是幂等的（渲染每帧都会调，不能每帧换一个新数组）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

const a = appSrc.indexOf('function maxRoundOf(t)');
const b = appSrc.indexOf('function roundsOf(t)');
if (a < 0 || b < 0) {
  console.error('找不到 maxRoundOf / roundsOf，测试没法继续');
  process.exit(1);
}
const code = appSrc.slice(a, b) + '\nreturn { maxRoundOf, asksOf, syncRounds, roundsList };';
const { syncRounds, asksOf, roundsList } = new Function('window', 'document', code)(
  {}, { querySelector: () => null }
);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const empty = R => !(R.askItems || []).length && !(R.says || []).length
  && !String(R.result || '').trim() && !(R.tools || []).length;

/* ── 1. 插话不撑出新轮 ── */
console.log('插话不占轮');
{
  const t = {
    userMsgs: [
      { text: 'A 第一轮', at: 0, round: 1 },
      { text: 'X 中途补充', at: 2, round: 1, inline: true },
      { text: 'B 第二轮', at: 3, round: 2 }
    ],
    steps: [
      { kind: 'tool', round: 1, name: 'write_file' },
      { kind: 'tool', round: 1, name: 'write_file' },
      { kind: 'say', round: 1, text: '第一轮结论' },
      { kind: 'tool', round: 2, name: 'write_file' },
      { kind: 'say', round: 2, text: '第二轮结论' }
    ]
  };
  const info = syncRounds(t);
  ok('轮数是 2（以前会算成 3）', info.rounds === 2, String(info.rounds));
  ok('没有空轮', info.list.every(R => !empty(R)), JSON.stringify(info.list.map(R => R.round)));
  ok('第 1 轮带两句（问话 + 补充）', info.list[0].askItems.length === 2, String(info.list[0].askItems.length));
  ok('补充那句标了 inline', info.list[0].askItems[1].inline === true);
  ok('第 2 轮只有自己那句', info.list[1].askItems.length === 1);
}

/* ── 2. 同轮多说几句也不撑出新轮 ── */
console.log('同轮多句');
{
  const t = {
    userMsgs: [
      { text: '问一', at: 0, round: 1 },
      { text: '问二', at: 1, round: 1 }
    ],
    steps: [{ kind: 'tool', round: 1, name: 'read_file' }, { kind: 'say', round: 1, text: '答' }]
  };
  const info = syncRounds(t);
  ok('还是一轮', info.rounds === 1, String(info.rounds));
  ok('两句都在这一轮', info.list[0].asks.length === 2);
}

/* ── 3. 没有 round 标记的老数据：按顺序补，且不让某轮空掉 ── */
console.log('老数据兜底');
{
  const t = {
    userMsgs: [{ text: 'a', at: 0 }, { text: 'b', at: 2 }],
    steps: [
      { kind: 'tool', name: 'write_file', at: 0 },
      { kind: 'say', at: 1, text: '第一轮' },
      { kind: 'tool', name: 'write_file', at: 2 },
      { kind: 'say', at: 3, text: '第二轮' }
    ]
  };
  const info = syncRounds(t);
  ok('两句 → 两轮', info.rounds === 2, String(info.rounds));
  ok('每轮都有自己的问话', info.list.every(R => R.asks.length >= 1));
  ok('最后一轮拿到最后那句', info.list[1].says[0] === '第二轮');
}

/* ── 4. 归一化幂等：渲染每帧都调，不能每帧换数组 ── */
console.log('幂等');
{
  const t = {
    userMsgs: [{ text: 'A', at: 0, round: 1, inline: false }],
    steps: [{ kind: 'say', round: 1, text: '好的' }]
  };
  syncRounds(t);
  const first = t.userMsgs;
  syncRounds(t);
  ok('第二次不换数组引用', t.userMsgs === first);
  ok('内容没被改坏', t.userMsgs[0].text === 'A' && t.userMsgs[0].round === 1);
}

/* ── 5. 插话在没有前文时也不炸（round 补齐） ── */
console.log('边界');
{
  const asks = asksOf({ userMsgs: [{ text: '只有一句插话', at: 0, inline: true }], steps: [] });
  ok('插话也有合法轮号', asks.length === 1 && asks[0].round >= 1, JSON.stringify(asks));
  const info = syncRounds({ userMsgs: [], steps: [] });
  ok('空任务算 1 轮', info.rounds === 1);
  ok('roundsList 不会返回空数组', roundsList({ userMsgs: [], steps: [] }, 1).length === 1);
}

/* ── 6. 同一句话说两遍是两轮，不许被「去重」吞掉 ── */
console.log('重复的话');
{
  const t = {
    userMsgs: [{ text: '继续', at: 0, round: 1 }, { text: '继续', at: 1, round: 2 }],
    steps: [
      { kind: 'say', round: 1, text: '第一轮做完了' },
      { kind: 'say', round: 2, text: '第二轮也做完了' }
    ]
  };
  const info = syncRounds(t);
  ok('两轮都在', info.rounds === 2, String(info.rounds));
  ok('两句话都没丢', info.list[0].asks[0] === '继续' && info.list[1].asks[0] === '继续');
  ok('两轮结论各归各位', info.list[0].says[0].includes('第一轮') && info.list[1].says[0].includes('第二轮'));
  ok('push 侧按轮去重（不再只按文字）',
    /u\.text === followUp && \(Number\(u\.round\) \|\| 0\) === nextR/.test(appSrc));
  ok('agent 收 followUp 时不再按文字跳过',
    !/const same = last && last\.role === 'user'/.test(fs.readFileSync(path.join(root, 'public/agent.js'), 'utf8')));
}

/* ── 7. 源码层面钉住：不许再用「条数当轮数」 ── */
console.log('回归断言');
{
  ok('不再出现 n = asks.length', !/const n = Math\.max\(1, asks\.length\)/.test(appSrc));
  ok('轮数取最大轮号', /const n = Math\.max\(1, asks\.reduce\(/.test(appSrc));
  ok('渲染前会滤掉空轮', /const filled = R =>/.test(appSrc));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
