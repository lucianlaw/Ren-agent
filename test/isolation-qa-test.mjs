/* 分任务 / 分项目隔离，以及它在质检台上的落点。
 *
 * 这组断言守的是「跑着的那一个 ≠ 你正看着的那一个」：
 *   任务侧：A 在跑、老板点开 B —— A 的步骤/结论/产出不许写进 B（2026-11-03 线上真踩过）。
 *   项目侧：P1 在跑、老板点开 P2 —— 节点 id 都叫 T1，正文和进度文案不许落到 P2 的行上。
 *
 * 质检台为此加了一道「不调模型」的自检题（localOnly），跑批时零 token 就能守住这条接线。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSrc = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const meetSrc = fs.readFileSync(path.join(root, 'public/meeting.js'), 'utf8');
const revSrc = fs.readFileSync(path.join(root, 'public/review.js'), 'utf8');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'public/eval-cases.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('任务侧自检入口');
{
  ok('APP 导出了 checkRunBinding', /checkRunBinding\s*\n?\};?/.test(appSrc) || /window\.APP = \{[\s\S]*?checkRunBinding/.test(appSrc));
  ok('自检会顶掉云端落库（不许往云库塞假行）', /window\.CLOUD\.saveTask = \(\) => Promise\.resolve\(\);/.test(appSrc));
  ok('自检结束把现场还原', /state\.tasks = keep\.tasks;/.test(appSrc) && /runCtx = keep\.ctx;/.test(appSrc));
  ok('自检覆盖「正在看的任务没被写脏」', /正在看的任务一点没被写脏/.test(appSrc));
  ok('自检覆盖「B 的快照里没有 A 的工具」', /B 的快照里没有 A 的工具/.test(appSrc));
  ok('自检覆盖「A 的快照里有自己的工具和结论」', /A 的快照里有自己的工具和结论/.test(appSrc));
}

console.log('项目侧：后台跑的那一场不许写进当前这一场');
{
  ok('有 onScreen 判据', /const onScreen = \(m\) => !!m && S\(\)\.curMeetingId === m\.id;/.test(meetSrc));
  ok('正文写入统一走 writeLive', /function writeLive\(m, idx, content\) \{[\s\S]{0,120}if \(!onScreen\(m\)\) return false;/.test(meetSrc));
  ok('@ 回复走 writeFollow', /function writeFollow\(m, idx, ri, content\) \{[\s\S]{0,120}if \(!onScreen\(m\)\) return false;/.test(meetSrc));
  ok('节点流式正文改走 writeLive', /writeLive\(m, idx, it\.content\);/.test(meetSrc));
  ok('节点收尾也走 writeLive（两处）', (meetSrc.match(/writeLive\(m, idx, it\.content\);/g) || []).length === 2);
  ok('@ 派活三处都走 writeFollow', (meetSrc.match(/writeFollow\(m, idx, i, /g) || []).length === 3);
  ok('进度文案只在正开着时改 DOM', /if \(onScreen\(m\)\) showNow\(n\.id, it\.now\);/.test(meetSrc));
  ok('不再有裸的 [data-live] 直接写', !/querySelector\(`\[data-live="\$\{idx\}"\]`\);\n\s*if \(live\) live\.innerHTML/.test(meetSrc));
  ok('不再有裸的 [data-fr] 直接写', !/querySelector\(`\[data-fr="\$\{idx\}-\$\{i\}"\]`\);\n\s*if \(live\) live\.innerHTML/.test(meetSrc));
  ok('MEET 导出 checkBinding', /window\.MEET = \{[\s\S]{0,1200}checkBinding/.test(meetSrc));
  ok('checkBinding 真的会写一次再挡一次', /const okA = writeLive\(A, 0, 'A 的正文'\);/.test(meetSrc) && /const okB = writeLive\(B, 0, 'B 的正文'\);/.test(meetSrc));
  ok('checkBinding 跑完还原主区', /box\.innerHTML = keepHTML;/.test(meetSrc));

  ok('有 renderIfOpen（后台项目不重绘当前这一场）', /const renderIfOpen = \(m\) => \{ if \(onScreen\(m\)\) render\(\); \};/.test(meetSrc));
  ok('运行路径都改走 renderIfOpen', (meetSrc.match(/renderIfOpen\(m\);/g) || []).length >= 15,
    String((meetSrc.match(/renderIfOpen\(m\);/g) || []).length));

  /* 关键：不许在跑批函数里留下裸的 render();（它会重绘当前这一场，把老板的阅读位置打断） */
  {
    const lines = meetSrc.split('\n');
    const fnRe = /^\s*(?:async )?function (\w+)/;
    const runFns = new Set(['runNode', 'startAnalysis', 'followUp', 'rerunWeak', 'writeMinutes', 'finishNow']);
    let fn = '', bad = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(fnRe);
      if (m) fn = m[1];
      if (runFns.has(fn) && /(^|[^.\w])render\(\);/.test(lines[i])) bad.push(`${i + 1}:${fn}`);
    }
    ok('跑批函数里没有裸 render()', bad.length === 0, bad.join(','));
  }
}

console.log('质检台接线');
{
  ok('断言 runBinding 存在', /if \(name === 'runBinding'\) \{[\s\S]{0,300}checkRunBinding/.test(revSrc));
  ok('断言 projectBinding 存在', /if \(name === 'projectBinding'\) \{[\s\S]{0,300}checkBinding/.test(revSrc));
  ok('自检题不调模型', /if \(c\.localOnly\) \{[\s\S]{0,160}task\.status = 'done';/.test(revSrc));
  ok('自检题不打质量分', /if \(!c\.localOnly && !stopFlag\) \{/.test(revSrc));
  ok('自检题不走第二轮追问', /if \(!c\.localOnly && c\.then/.test(revSrc));

  const c = (cases.cases || []).find((x) => x.id === 'task-isolation');
  ok('题库里有 task-isolation 这一题', !!c);
  ok('是 smoke（每轮回归都跑）', !!(c && c.smoke));
  ok('标了 localOnly（零 token）', !!(c && c.localOnly));
  ok('断言同时覆盖任务侧和项目侧', !!(c && (c.assertions || []).some((a) => a.type === 'runBinding')
    && (c.assertions || []).some((a) => a.type === 'projectBinding')));
  ok('题目说明了踩过什么坑', !!(c && /gen_image|PPT/.test(c.why || '')));
  ok('题库版本号已升', Number(cases.version) >= 4, String(cases.version));
  ok('老题的断言没被动过（md-note 仍是那三条）', (() => {
    const old = (cases.cases || []).find((x) => x.id === 'md-note');
    const t = (old && old.assertions || []).map((a) => a.type).join(',');
    return t === 'noFail,file,maxMs';
  })());
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
