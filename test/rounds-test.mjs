/* 轮次归位测试：同一轮里说多句话，一句都不能被挪到别的轮去。

   真实踩过的坑（2026-11-03，任务 #34）：模型在一轮里先说一句「我先把图做出来落盘」，
   再调 write_file，工具回来又说 793 字结论。归位逻辑当时假定「一句话占一轮」，
   第二句只能往前面的轮次找空位，结果 793 字被塞进第 1 轮——
   老板看到的现象就是「本来有一大段分析，产出物一出来分析就没了」。 */
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
const { syncRounds, roundsList, maxRoundOf } = new Function('window', 'document', code)(
  {}, { querySelector: () => null }
);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 造一个 6 轮任务：每轮 1 个工具步 + 1 句分析，第 6 轮额外多一句（开场 + 结论） */
function makeTask() {
  const t = { userMsgs: [], steps: [] };
  for (let r = 1; r <= 6; r++) {
    t.userMsgs.push({ text: '第' + r + '句话', at: r - 1, round: r });
    t.steps.push({ kind: 'tool', round: r, name: 'write_file', at: 0, output: 'ok' });
    if (r === 6) {
      t.steps.push({ kind: 'say', round: 6, at: 1, text: '开场：我先把图做出来落盘，再逐段讲。' });
      t.steps.push({ kind: 'say', round: 6, at: 2, text: '结论：' + 'B'.repeat(793) });
    } else {
      t.steps.push({ kind: 'say', round: r, at: 1, text: '第' + r + '轮的分析' });
    }
  }
  return t;
}

console.log('轮次归位');
{
  const t = makeTask();
  const info = syncRounds(t);
  const last = info.list[5];
  ok('一共 6 轮', info.rounds === 6, String(info.rounds));
  ok('第 6 轮保住两句（开场 + 结论）', last.says.length === 2, '拿到 ' + last.says.length + ' 句');
  ok('第 6 轮结论是那 793 字', /^结论：B{793}$/.test(last.says[1] || ''), (last.says[1] || '').slice(0, 20));
  ok('第 1 轮没被塞进别人的话', info.list[0].says.length === 1, '拿到 ' + info.list[0].says.length + ' 句');
  ok('每轮都还有自己的那句话', info.list.every(R => R.says.length >= 1));
  ok('result 仍取最后一句（兼容拍板/交接）', /^结论：/.test(last.result));
}

/* 老数据没有 round 标记：一句一句往前补空位，不能让某轮变空 */
console.log('老数据兜底');
{
  const t = {
    userMsgs: [{ text: 'a', at: 0 }, { text: 'b', at: 1 }],
    steps: [
      { kind: 'tool', name: 'write_file', at: 0 },
      { kind: 'say', at: 1, text: '第一轮的话' },
      { kind: 'tool', name: 'write_file', at: 2 },
      { kind: 'say', at: 3, text: '第二轮的话' }
    ]
  };
  const info = syncRounds(t);
  ok('两句都归到第 2 轮以外各自的位', info.list[1].says.length === 1 && info.list[0].says.length === 1,
    JSON.stringify(info.list.map(R => R.says.length)));
  ok('最后一轮拿到最后那句', info.list[1].says[0] === '第二轮的话');
}

/* 同一轮三句（开场 / 中途汇报 / 结论）也要全留 */
console.log('同轮三句');
{
  const t = {
    userMsgs: [{ text: '一件事', at: 0 }],
    steps: [
      { kind: 'tool', name: 'write_file', at: 0 },
      { kind: 'say', round: 1, at: 1, text: '开场' },
      { kind: 'say', round: 1, at: 2, text: '中途汇报' },
      { kind: 'say', round: 1, at: 3, text: '结论' }
    ]
  };
  const info = syncRounds(t);
  ok('三句俱在', info.list[0].says.length === 3, '拿到 ' + info.list[0].says.length + ' 句');
  ok('顺序不乱', info.list[0].says.join('|') === '开场|中途汇报|结论');
  ok('只有 1 轮', maxRoundOf(t) === 1, String(maxRoundOf(t)));
  ok('roundsList 与 sync 一致', roundsList(t, 1)[0].says.length === 3);
}

/* 源码层面钉住：不允许再出现「一轮只能有一句」的写法 */
console.log('回归断言');
{
  ok('归位不再用 !taken.has(want) 卡唯一性', !/!taken\.has\(want\)/.test(appSrc));
  ok('分析正文不再 4000 字截断', !/text: txt\.slice\(0, 4000\)/.test(appSrc));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
