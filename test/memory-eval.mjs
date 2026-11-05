// 记忆专项评估：不是「跑得通」，而是「记的对不对」。
//
//   node test/memory-eval.mjs
//
// 覆盖 6 组、共 20 条断言：
//   ① 同义改写仍能召回（换个说法问，旧事实还在）
//   ② 旧口径被取代后不再召回，且历史可查
//   ③ 跨员工不串线（A 的记忆不会出现在 B 的上下文里）
//   ④ 项目共享记忆：项目内任何员工都带，项目外不带
//   ⑤ 候选态：没采纳不进召回，采纳后才生效，跟旧说法冲突时旧条目标成已被取代
//   ⑥ 敏感信息不落盘
// 直连 lib/memory.js，不经过模型，所以每次结果都一样。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  appendEntries, approveEntry, readDoc, recallFor, memoryBrief,
  splitMemo, deleteEntry, clearDoc, findSensitive, writeProjectTitle,
  memoryPathsForTest
} from '../lib/memory.js';

const scope = crypto.randomBytes(16).toString('hex');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};
const has = (arr, kw) => (arr || []).some(e => String(e.text || '').includes(kw));
const brief = async (staff, q, pj) => memoryBrief(scope, staff, staff, q, { projectId: pj || '' });

function section(t) { console.log('\n' + t); }

/* ① 同义改写召回 */
section('① 同义改写仍能召回');
appendEntries(scope, 'staff', 's1', ['周报固定在每周五下午 5 点前发出，发到老板邮箱'], '任务：周报', {});
{
  const r = recallFor(scope, 's1', '周报什么时候发？');
  ok('换个问法仍召回「周报」那条', has(r.staff, '周报'));
  const t2 = await brief('s1', '每周报告发送时间');
  ok('memoryBrief 里也带着这条', t2.includes('周报'));
}

/* ② 旧口径被取代 */
section('② 旧口径不再用');
appendEntries(scope, 'staff', 's1', ['周报固定在每周五下午 5 点前发出，发到老板邮箱'], '任务：周报', {});
appendEntries(scope, 'staff', 's1', ['更正：周报改为每周一上午 10 点前发出'], '任务：周报', {});
{
  const doc = readDoc(scope, 'staff', 's1');
  const oldRow = doc.entries.find(e => e.text.includes('周五'));
  const newRow = doc.entries.find(e => e.text.includes('周一'));
  ok('新说法是有效状态', newRow && newRow.status === 'active');
  ok('旧说法被标成已被取代（历史保留）', oldRow && oldRow.status === 'superseded');
  ok('取代关系指得到新条目', oldRow && (oldRow.sup === newRow.id || doc.entries.some(e => e.sup === newRow.id)));
  const r = recallFor(scope, 's1', '周报几点发');
  ok('召回里不再出现旧说法', !has(r.staff, '周五'));
  ok('召回里有新说法', has(r.staff, '周一'));
}

/* ②b 同一个意思换个叫法（账期 / 回款周期）也要认成同一件事 */
section('②b 换个叫法的改口');
appendEntries(scope, 'staff', 's5', ['客户 B 的回款周期是 60 天'], '任务：账期', {});
appendEntries(scope, 'staff', 's5', ['客户 B 的账期改成 45 天'], '任务：账期', {});
{
  const doc = readDoc(scope, 'staff', 's5');
  const o = doc.entries.find(e => e.text.includes('60 天'));
  const n = doc.entries.find(e => e.text.includes('45 天'));
  ok('旧账期被取代', o && o.status === 'superseded' && n && n.status === 'active');
  ok('召回只剩新账期', !has(recallFor(scope, 's5', '客户B 账期').staff, '60 天')
    && has(recallFor(scope, 's5', '客户B 账期').staff, '45 天'));
}

/* ③ 跨员工不串线 */section('③ 跨员工不串线');
appendEntries(scope, 'staff', 's2', ['小张自己的习惯：配色一律用低饱和'], '任务：配色', {});
{
  const r1 = recallFor(scope, 's1', '配色怎么定');
  const r2 = recallFor(scope, 's2', '配色怎么定');
  ok('员工 A 看不到 B 的私有记忆', !has(r1.staff, '低饱和'));
  ok('员工 B 自己看得到', has(r2.staff, '低饱和'));
  ok('B 的 brief 不含 A 的条目文本', !(await brief('s2', '周报 配色')).includes('发给老板'));
}

/* ④ 项目共享记忆 */
section('④ 项目共享记忆');
const PJ = 'p' + crypto.randomBytes(4).toString('hex');
writeProjectTitle(scope, PJ, '马克杯联名项目');
appendEntries(scope, 'project', PJ, ['这个项目的杯身主色定为陶土橙'], '项目：马克杯联名', {});
{
  const inA = recallFor(scope, 's1', '杯身主色', { projectId: PJ });
  const inB = recallFor(scope, 's2', '杯身主色', { projectId: PJ });
  ok('项目里员工 A 带得到', has(inA.project, '陶土橙'));
  ok('项目里员工 B 也带得到（不按人分）', has(inB.project, '陶土橙'));
  const outPj = recallFor(scope, 's1', '杯身主色', { projectId: 'p-other' });
  ok('别的项目带不到', !has(outPj.project, '陶土橙'));
  const noPj = recallFor(scope, 's1', '杯身主色');
  ok('不在项目里跑的任务带不到', !has(noPj.project, '陶土橙'));
  const txt = await brief('s1', '杯身主色', PJ);
  ok('项目的 brief 里明说是项目共用', txt.includes('项目里所有同事共用') && txt.includes('陶土橙'));
  ok('项目名写进了正文标题', readDoc(scope, 'project', PJ).prose.includes('马克杯联名项目'));
}

/* ⑤ 候选态 */
section('⑤ 候选态：没采纳不生效');
appendEntries(scope, 'staff', 's3', ['客户 A 的回款周期是 60 天'], '任务：回款', { candidate: true });
{
  const doc = readDoc(scope, 'staff', 's3');
  const cand = doc.entries.find(e => e.text.includes('回款周期'));
  ok('落成待采纳状态', cand && cand.status === 'candidate');
  ok('正文里带〔待采纳〕标记', readDoc(scope, 'staff', 's3').raw.includes('〔待采纳〕'));
  const r = recallFor(scope, 's3', '回款周期几天');
  ok('没采纳 → 不进召回', !has(r.staff, '回款周期'));
  const ap = approveEntry(scope, 'staff', 's3', cand.id);
  ok('采纳成功', ap.ok && !ap.already);
  const r2 = recallFor(scope, 's3', '回款周期几天');
  ok('采纳后进召回', has(r2.staff, '回款周期'));
  ok('状态变成有效', readDoc(scope, 'staff', 's3').entries.find(e => e.id === cand.id).status === 'active');

  /* 候选与现行说法冲突：采纳时才取代，候选期不动老口径 */
  appendEntries(scope, 'staff', 's3', ['客户 A 的回款周期是 30 天'], '任务：回款', { candidate: true });
  const beforeDoc = readDoc(scope, 'staff', 's3');
  const oldActive = beforeDoc.entries.find(e => e.text.includes('60 天'));
  ok('候选期不改旧口径', oldActive && oldActive.status === 'active');
  const newCand = beforeDoc.entries.find(e => e.text.includes('30 天'));
  approveEntry(scope, 'staff', 's3', newCand.id);
  const afterDoc = readDoc(scope, 'staff', 's3');
  ok('采纳后旧说法转成已被取代', afterDoc.entries.find(e => e.text.includes('60 天')).status === 'superseded');
  ok('采纳后召回只认 30 天', has(recallFor(scope, 's3', '回款周期').staff, '30 天')
    && !has(recallFor(scope, 's3', '回款周期').staff, '60 天'));
}

/* ⑥ 敏感信息 */
section('⑥ 敏感信息不落盘');
{
  const r = appendEntries(scope, 'staff', 's4', ['后台账号密码是 Passw0rd!2026'], '任务：配置', {});
  ok('密码被拒收', r.rejected.length === 1 && r.added === 0);
  const r2 = appendEntries(scope, 'staff', 's4', ['接口密钥 sk-live-abcdefghijklmnop123456'], '任务：配置', {});
  ok('sk- 密钥被拒收', r2.rejected.length === 1);
  ok('文件里没有落任何一条', readDoc(scope, 'staff', 's4').entries.length === 0);
  ok('findSensitive 认得私钥', findSensitive('-----BEGIN RSA PRIVATE KEY-----') === '私钥');
  /* 整篇粘贴公司档案只做遮蔽，不让老板白粘一次 */
  appendEntries(scope, 'company', '', ['报价一律含税，口头不算'], '老板手写', { candidate: false });
  ok('正常口径照常写进公司档案', readDoc(scope, 'company').entries.length === 1);
}

/* ⑦ 摘【记忆】/【项目记忆】块 */
section('⑦ 正文分块');
{
  const mm = splitMemo('这是正文结论。\n\n【记忆】\n- 客户 A 用月结\n\n【项目记忆】\n- 本项目主色陶土橙\n\n后面还有一句正文。');
  ok('正文剥掉了两个块', !mm.body.includes('客户 A 用月结') && mm.body.includes('这是正文结论'));
  ok('个人记忆 1 条', mm.items.length === 1 && mm.items[0].includes('月结'));
  ok('项目记忆 1 条', mm.projectItems.length === 1 && mm.projectItems[0].includes('陶土橙'));
  ok('块后的正文保留下来', mm.body.includes('后面还有一句正文'));
}

/* 清理这次评估产生的工作区记忆目录 */
try {
  const p = memoryPathsForTest(scope);
  if (p) fs.rmSync(p, { recursive: true, force: true });
} catch { /* 清不掉也不影响结论 */ }

console.log(`\n${fail === 0 ? '✅' : '❌'} 记忆专项评估：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
