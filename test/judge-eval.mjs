/* 核验内核的专项评估：判定口径对不对、程序兜底灵不灵、解析容不容错
 *
 * 为什么要有这一套：验收人本身也会错。它的错法有两种——
 *   把好活判死（老板会烦），把烂活放行（比没有验收更糟）。
 * 所以这里不打模型，只打判定规则：同一份输出在不同证据下必须得到同一个结论，
 * 而不许因为模型措辞、格式、有没有返工而变化。
 *
 * 跑法：node test/judge-eval.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestFile, digestFiles } from '../lib/digest.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/* public/judge.js 是给浏览器用的经典脚本（挂 window.JUDGE），
   在 Node 里用一层壳把它跑起来，保证「测的就是线上跑的那份代码」，不做第二份实现 */
function loadJudge() {
  const code = fs.readFileSync(path.join(here, '../public/judge.js'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', 'window', code)(mod, mod.exports, undefined);
  return mod.exports;
}

const J = loadJudge();

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  fails.push(name + (extra ? '  →  ' + extra : ''));
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `拿到 ${JSON.stringify(got)}，应该 ${JSON.stringify(want)}`);
}

/* 造一份标准回答：五个维度都能自己指定 */
function dims(over) {
  const base = {
    goal: 4, deliver: 4, consist: 4, brevity: 4, fact: 'pass'
  };
  const o = { ...base, ...(over || {}) };
  return {
    dims: [
      { k: 'goal', s: o.goal, why: '' },
      { k: 'deliver', s: o.deliver, why: '' },
      { k: 'fact', s: o.fact, why: '' },
      { k: 'consist', s: o.consist, why: '' },
      { k: 'brevity', s: o.brevity, why: '' }
    ],
    gaps: o.gaps || []
  };
}
const JUDGE = { id: 'judge-x', name: '验收模型 X', level: 'full' };

console.log('【一】四档判定：好活不许判死，烂活不许放行');

{
  const v = J.decide({ prog: { hard: [], soft: [] }, model: J.parse(JSON.stringify(dims())), judge: JUDGE, workerModel: 'worker-a', kind: 'task' });
  eq('全项优秀 → pass', v.verdict, 'pass');
  ok('全项优秀 → 分数接近 4', v.score >= 3.8, 'score=' + v.score);
  ok('pass 时 pass=true', v.pass === true);
  ok('标出独立验收', v.independent === true && v.independence === 'full');
}

{
  const v = J.decide({ prog: { hard: [], soft: [] }, model: J.parse(JSON.stringify(dims({ goal: 2 }))), judge: JUDGE, workerModel: 'w' });
  eq('目标覆盖只有及格 → weak（能用但下游要补）', v.verdict, 'weak');
  ok('weak 时 pass=false', v.pass === false);
}

{
  const v = J.decide({ prog: { hard: [], soft: [] }, model: J.parse(JSON.stringify(dims({ goal: 1 }))), judge: JUDGE, workerModel: 'w' });
  eq('目标覆盖不及格 → fail', v.verdict, 'fail');
}

{
  const v = J.decide({ prog: { hard: [], soft: [] }, model: J.parse(JSON.stringify(dims({ deliver: 1 }))), judge: JUDGE, workerModel: 'w' });
  eq('交付一致不及格 → fail', v.verdict, 'fail');
}

{
  /* 只有「啰嗦」这一项差：不能因此判死，否则好活会被文风挡住 */
  const v = J.decide({ prog: { hard: [], soft: [] }, model: J.parse(JSON.stringify(dims({ brevity: 1 }))), judge: JUDGE, workerModel: 'w' });
  eq('只有「凑字数」差 → 仍 pass', v.verdict, 'pass');
}

{
  const v = J.decide({ prog: { hard: [], soft: [] }, model: J.parse(JSON.stringify(dims({ goal: 2, deliver: 2, consist: 2, brevity: 2 }))), judge: JUDGE, workerModel: 'w' });
  eq('四项都只是及格 → weak（不是 fail，及格线不是死刑线）', v.verdict, 'weak');
}

console.log('【二】一票否决：编造数字，别的再好也归零');

{
  const v = J.decide({
    prog: { hard: [], soft: [] },
    model: J.parse(JSON.stringify(dims({ fact: 'fail', goal: 4, deliver: 4 }))),
    judge: JUDGE, workerModel: 'w'
  });
  eq('事实可溯 fail → 整份 fail', v.verdict, 'fail');
  ok('标出触发了一票否决', v.veto === true);
  ok('分数归零', v.score === 0);
}

console.log('【三】程序优先：磁盘上没东西，模型说什么都不算');

{
  const v = J.decide({
    prog: { hard: ['说已交付 报价.md，磁盘上没有这个文件'], soft: [] },
    model: J.parse(JSON.stringify(dims({ goal: 4, deliver: 4 }))),
    judge: JUDGE, workerModel: 'w'
  });
  eq('程序报硬问题 → fail', v.verdict, 'fail');
  eq('判定来源标成 program', v.source, 'program');
  ok('模型的高分被忽略', v.score === 0);
  ok('gaps 里带着程序给的原因', (v.gaps || []).join('').includes('磁盘上没有'));
}

{
  /* 没文件的节点：正文写得再漂亮，也是「没落盘」 */
  const g = J.gate({ digests: [], text: '已经全部写进 报告.md 了，内容很完整。', expectFiles: true });
  ok('要求交文件却没有文件 → 硬问题', g.hard.length > 0, JSON.stringify(g.hard));
}

{
  const g = J.gate({
    digests: [{ path: '报告.md', size: 1024, chars: 0 }],
    text: '写好了', expectFiles: true
  });
  ok('文件几乎是空的 → 硬问题', g.hard.some(x => x.includes('几乎没有内容')), JSON.stringify(g.hard));
}

{
  const g = J.gate({ digests: [{ path: 'a.md', size: 0, chars: 0 }], text: '', expectFiles: true });
  ok('空文件 → 硬问题', g.hard.some(x => x.includes('空文件')), JSON.stringify(g.hard));
}

{
  const g = J.gate({
    digests: [{ path: '报价.md', size: 900, chars: 300 }],
    text: '已经写入 报价.md 和 成本表.xlsx。'
  });
  ok('声称写了两个文件、只找到一个 → 硬问题', g.hard.some(x => x.includes('成本表.xlsx')), JSON.stringify(g.hard));
}

{
  const g = J.gate({
    digests: [{ path: '报价.md', size: 900, chars: 300 }],
    text: '已经写入 报价.md。'
  });
  eq('声称的和磁盘上对得上 → 没有硬问题', g.hard, []);
}

{
  const g = J.gate({
    digests: [{ path: '报价.md', size: 900, chars: 300, stale: true }],
    text: '内容见文件'
  });
  ok('旧文件 → 记成软问题（提示，不判死）', g.soft.length === 1 && g.hard.length === 0, JSON.stringify(g));
}

console.log('【四】解析容错：模型不按格式来，不能因此放行也不能因此判死');

{
  const p = J.parse('```json\n{"dims":[{"k":"goal","s":4},{"k":"deliver","s":3},{"k":"fact","s":"pass"},{"k":"consist","s":4},{"k":"brevity","s":3}],"gaps":[]}\n```');
  ok('带代码围栏也能解析', !!p && p.dims.goal.s === 4);
}

{
  const p = J.parse('好的，我的判定如下：\n{"dims":[{"k":"goal","s":2,"why":"只答了一半"}],"gaps":["缺成本口径"]}\n以上。');
  ok('前后有废话也能从里面抠出 JSON', !!p && p.dims.goal.s === 2);
  ok('中文 why 保留', p && p.dims.goal.why === '只答了一半');
}

{
  const p = J.parse('{"dims":[{"k":"goal","s":"优秀"},{"k":"fact","s":"PASS"}]}');
  ok('「优秀/PASS」这种文字档位也认', !!p && p.dims.goal.s === 4 && p.factPass === true);
}

{
  eq('完全不是 JSON → 解析不出来（上层按未验证处理）', J.parse('我觉得还行，可以过。'), null);
}

{
  const v = J.decide({ prog: { hard: [], soft: [] }, model: null, judge: JUDGE, workerModel: 'w' });
  eq('没解析出结论 → weak（不是 pass）', v.verdict, 'weak');
  ok('说明为什么没过', /没被验过|没返回结构化结论/.test((v.gaps || []).join('')));
}

{
  /* 线上真实场景：hy4-preview 把额度全花在思考上，正文 0 字。
     这种情况必须说清「谁、因为什么」，否则老板只会看到一句「验收失败」。 */
  const v = J.decide({
    prog: { hard: [], soft: [] }, model: null,
    judge: { id: 'hy4-preview', name: 'Hy4 preview', level: 'full' },
    workerModel: 'deepseek-v4-pro',
    failReason: 'Hy4 preview 把 1500 token 全用在思考上，正文一个字都没写就被截断'
  });
  const said = (v.gaps || []).join('') + ' ' + (v.note || '');
  ok('失败原因要具体到「思考吃光额度」', /思考/.test(said), said);
  ok('不把「没验过」说成「不合格」', /不等于不合格/.test(said));
}

{
  /* 老格式（项目线上一版就是这样回话的）：不能被误判成「编造数字」 */
  const v = J.decide({ prog: { hard: [], soft: [] }, model: J.parse('{"pass":false,"gaps":["第一句不是判断"]}'), judge: JUDGE, workerModel: 'w' });
  eq('老格式 pass=false → weak', v.verdict, 'weak');
  ok('老格式不认领一票否决', v.veto === false);
  ok('原因照原样带出来', (v.gaps || []).join('').includes('第一句不是判断'));
}

{
  const v = J.decide({ prog: { hard: [], soft: [] }, model: J.parse('{"checks":[{"id":"T1","pass":false,"gaps":["没回答"]}]}'), judge: JUDGE, workerModel: 'w' });
  eq('checks 格式也认（项目线老口径）', v.verdict, 'weak');
}

console.log('【五】验收人挑选：同一个模型自己验自己，不算独立证据');

{
  const p = J.pick([
    { id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { id: 'hunyuan-pro', name: '混元 Pro' }
  ], 'deepseek-chat');
  eq('不同家族 → full', p.level, 'full');
  ok('挑的不是干活那个', p.id !== 'deepseek-chat');
}

{
  const p = J.pick([
    { id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }
  ], 'deepseek-chat');
  eq('只有同家族的另一个 → weak', p.level, 'weak');
  ok('仍然是另一个型号', p.id === 'deepseek-reasoner');
}

{
  const p = J.pick([{ id: 'deepseek-chat' }], 'deepseek-chat');
  eq('只有一个模型 → none', p.level, 'none');
  ok('退回用自己，但标出来', p.id === 'deepseek-chat' && /同源|自己/.test(p.reason));
}

{
  const p = J.pick([], 'x');
  eq('模型列表为空 → none', p.level, 'none');
}

{
  const p = J.pick([{ id: 'deepseek-chat' }, { id: 'qwen-flash' }, { id: 'kimi-pro' }], 'deepseek-chat');
  ok('优先挑非轻量模型当验收人（要判断力）', p.id === 'kimi-pro', '挑到了 ' + p.id);
}

{
  /* 2026-11-02 线上事故：hy4-preview 做验收人，reasoning 吃满 max_tokens、
     content 0 字、finish_reason=length，两次重试都这样（1600 和 4000 一样）。
     这类模型必须在挑选阶段就避开。 */
  const p = J.pick([
    { id: 'hy4-preview', name: 'Hy4 preview' },
    { id: 'glm-5.3', name: 'GLM-5.3' }
  ], 'deepseek-v4-pro');
  ok('跳过思考型模型当验收人', p.id === 'glm-5.3', '挑到了 ' + p.id);
}

{
  const p = J.pick([
    { id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking' },
    { id: 'glm-5.3', name: 'GLM-5.3' }
  ], 'deepseek-v4-pro');
  ok('-thinking 结尾的一律避开', p.id === 'glm-5.3', '挑到了 ' + p.id);
}

{
  const p = J.pick([{ id: 'glm-5.3' }, { id: 'kimi-k3-1' }], 'deepseek-v4-pro', { exclude: ['glm-5.3'] });
  ok('重试时能排除已经试过的模型', p.id === 'kimi-k3-1', '挑到了 ' + p.id);
}

{
  const p = J.pick([{ id: 'hy4-preview' }], 'deepseek-v4-pro');
  eq('只剩思考型模型时也要退回去用（不能没验收人）', p.id, 'hy4-preview');
  ok('并且如实标出它是思考型', p.thinking === true);
}

console.log('【六】状态口径：两边只有 done / weak 两个结果');

eq('pass → done', J.statusOf({ verdict: 'pass' }), 'done');
eq('weak → weak', J.statusOf({ verdict: 'weak' }), 'weak');
eq('fail → weak', J.statusOf({ verdict: 'fail' }), 'weak');
ok('summary 是人话', /通过|缺口|没过/.test(J.summary({ verdict: 'pass' })));
ok('whoLine 写清独立度', /独立验收/.test(J.whoLine({ verdict: 'pass', judgeName: 'X', independence: 'full' })));
ok('同模型时如实说明', /同模型|仅供参考/.test(J.whoLine({ verdict: 'pass', judgeName: 'X', independence: 'none' })));

console.log('【七】交付物摘要：验收人看到的是磁盘上的内容，不是执行者的总结');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jdg-'));
  fs.writeFileSync(path.join(dir, '报告.md'), '# 结论\n单价按 0.12 元/次估算，三年合计 36 万。\n' + '细节'.repeat(300));
  fs.writeFileSync(path.join(dir, '空.md'), '');

  const d1 = digestFile(dir, '报告.md');
  eq('文本文件认成 text', d1.kind, 'text');
  ok('有字数统计', d1.chars > 100, 'chars=' + d1.chars);
  ok('有开头摘要', String(d1.head).includes('0.12'), String(d1.head).slice(0, 40));
  ok('摘要不会把整篇塞进去', d1.head.length <= 901, 'head=' + d1.head.length);

  const d2 = digestFile(dir, '空.md');
  eq('空文件认成 empty', d2.kind, 'empty');

  const d3 = digestFile(dir, '没有这个.md');
  ok('不存在的文件标 missing', d3.missing === true);

  const many = digestFiles(dir, ['报告.md', '空.md', '没有这个.md']);
  eq('一次最多摘 8 个，且顺序不变', many.length, 3);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('【八】旧文件：这一轮没干活，不能拿上一轮的旧货当新交付');

{
  const t0 = Date.now();
  const fresh = { path: 'a.md', size: 100, chars: 80 };
  const old = { path: 'b.md', size: 100, chars: 80, stale: true };

  const g1 = J.gate({ digests: [fresh], text: '结论已经写在 a.md 里了，内容齐备。', expectFiles: true });
  eq('这一轮真写了文件 → 不算问题', g1.hard.length, 0);
  ok('也没有旧文件的软提示', !g1.soft.join('').includes('旧'), JSON.stringify(g1.soft));

  const g2 = J.gate({ digests: [old, { path: 'c.md', size: 50, chars: 40, stale: true }], text: '已经更新过了，内容齐备。', expectFiles: true });
  eq('全是旧文件 → 不判死（交给验收人）', g2.hard.length, 0);
  ok('但要提示这一轮没动过盘', g2.soft.join('').includes('上一轮'), JSON.stringify(g2.soft));

  /* 单个旧文件不算：这一轮只改了其中一个，是常事，不能冤 */
  const g3 = J.gate({ digests: [fresh, old], text: 'a.md 已经重写，b.md 沿用上一版。', expectFiles: true });
  ok('部分旧文件不算问题', !g3.soft.join('').includes('上一轮'), JSON.stringify(g3.soft));

  /* 没传 since 时（digest 不带 stale 字段）不能误报 */
  const g4 = J.gate({ digests: [{ path: 'a.md', size: 100, chars: 80 }], text: '内容齐备。', expectFiles: true });
  ok('没有 since 时不误报旧文件', g4.soft.length === 0, JSON.stringify(g4.soft));

  const v = J.decide({
    prog: g2, model: { dims: { goal: { s: 4 }, deliver: { s: 3 }, consist: { s: 4 }, brevity: { s: 3 } }, factPass: true, gaps: [] },
    judge: { id: 'j', name: 'J', level: 'full' }, workerModel: 'w', kind: 'task'
  });
  ok('旧文件提示会带进验收结论', (v.gaps || []).join('').includes('上一轮'), JSON.stringify(v.gaps));
  ok('但不会因为旧文件就直接判死', v.verdict !== 'fail', v.verdict);
}

console.log('');
if (fail) {
  console.log(`✗ ${pass} 通过 / ${fail} 失败`);
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log(`✓ 全部通过：${pass} 项`);
