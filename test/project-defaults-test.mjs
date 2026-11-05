/* 新建项目 / 任务转项目的默认班子测试。

   老板的原话（2026-11-03）：
   「新建项目或者任务转项目，项目经理默认用上个项目的项目经理是谁，就填谁。
     默认为非全选，点全选才全部选择。」

   改之前的两处毛病：
   1) 每次都按岗位重猜项目经理，猜出来永远是「挂着项目经理岗的那位」，
      老板想换的人每次都得重选一遍；
   2) 转项目默认把全部 AI 员工都勾上（截图里「已选 15 人（AI 15）」），
      一轮就把一场项目的 token 烧掉，想精简还得手动一个个取消。

   这组测试只喂函数、不碰 DOM：defaultCrew 是纯函数，lastProjectRoles 只读 state。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/meeting.js'), 'utf8');

function grabFn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name + '，源码结构变了');
  let d = 0, seen = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; seen = true; }
    else if (c === '}') { d--; if (seen && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error(name + ' 括号没闭合');
}

function bind(state) {
  const code = `
    const S = () => state;
    const aiStaff = () => state.staff.filter(s => s.kind !== 'human');
    ${grabFn('pmCandidate')}
    ${grabFn('pmOf')}
    ${grabFn('chiefOf')}
    ${grabFn('lastProjectRoles')}
    ${grabFn('defaultCrew')}
    ${grabFn('quickPick')}
    return { pmCandidate, pmOf, chiefOf, lastProjectRoles, defaultCrew, quickPick };
  `;
  return new Function('state', code)(state);
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/* 一个 6 人小班子：小刘挂项目经理岗、小吴挂设计师岗、小张挂秘书岗，
   另外三个是核心但岗上不带 PM 字样。 */
const STAFF = [
  { id: 's1', name: '小刘', role: '产品线 · 项目经理', kind: 'ai', core: true },
  { id: 's2', name: '小吴', role: '设计线 · 设计师', kind: 'ai', core: true },
  { id: 's3', name: '小张', role: '行政线 · 秘书', kind: 'ai' },
  { id: 's4', name: '阿健特', role: 'AI Agent工程师', kind: 'ai', core: true },
  { id: 's5', name: '安全', role: '安全架构师', kind: 'ai', core: true },
  { id: 's6', name: '老罗', role: '产品经理（ToC/ToB）', kind: 'ai' },
  { id: 'h1', name: '客户王总', role: '甲方', kind: 'human' }
];
/* 一个项目：项目经理是小吴（不是挂 PM 岗的小刘），牵头人是小张 */
const MEET_OLD = {
  id: 'm1', at: 1000, updatedAt: 5000,
  participants: [
    { id: 's2', name: '小吴', role: '设计线 · 设计师', pm: true, chief: false },
    { id: 's3', name: '小张', role: '行政线 · 秘书', pm: false, chief: true },
    { id: 's4', name: '阿健特', role: 'AI Agent工程师' }
  ]
};

/* ── 1. 上一个项目的班底 ── */
console.log('\n[1] 从上一个项目读班底');
{
  const M = bind({ staff: STAFF, meetings: [MEET_OLD] });
  const r = M.lastProjectRoles();
  ok('取到上个项目的项目经理（小吴，不是挂岗的小刘）', r.pmId === 's2', r.pmId);
  ok('取到上个项目的牵头人（小张）', r.chiefId === 's3', r.chiefId);
}
{
  const M = bind({ staff: STAFF, meetings: [] });
  const r = M.lastProjectRoles();
  ok('从没开过项目 → 两个空值，交给岗位兜底', r.pmId === '' && r.chiefId === '');
}
{
  /* 两个项目：老项目更新、新项目更旧（数组顺序不可信，必须按时间取） */
  const newer = { id: 'm2', at: 9000, updatedAt: 9000, participants: [{ id: 's4', name: '阿健特', pm: true }] };
  const M = bind({ staff: STAFF, meetings: [newer, MEET_OLD] });
  ok('按 updatedAt 取最近那一场，不看数组顺序', M.lastProjectRoles().pmId === 's4');
}
{
  /* 那个人已经被删了：不能拿一个不存在的 id 去填 select */
  const gone = { id: 'm3', updatedAt: 9000, participants: [{ id: 'sX', name: '已离职', pm: true, chief: true }] };
  const M = bind({ staff: STAFF, meetings: [gone, MEET_OLD] });
  const r = M.lastProjectRoles();
  ok('上次那位不在职 → 往前找还能用的那一场', r.pmId === 's2' && r.chiefId === 's3',
    JSON.stringify(r));
}

/* ── 2. 项目经理默认值 ── */
console.log('\n[2] 项目经理默认填谁');
{
  const M = bind({ staff: STAFF, meetings: [MEET_OLD] });
  ok('有上个项目 → 沿用他的项目经理', M.defaultCrew(M.lastProjectRoles(), STAFF, null).pmId === 's2');
}
{
  const M = bind({ staff: STAFF, meetings: [] });
  ok('没有历史 → 按岗位猜（小刘挂项目经理岗）',
    M.defaultCrew(M.lastProjectRoles(), STAFF, null).pmId === 's1');
}
{
  const M = bind({ staff: STAFF, meetings: [MEET_OLD] });
  const task = { employeeId: 's4' };
  ok('转项目时也先认上个项目的项目经理，不是原任务的执行人',
    M.defaultCrew(M.lastProjectRoles(), STAFF, task).pmId === 's2');
}
{
  const M = bind({ staff: STAFF, meetings: [] });
  /* 原任务是小刘（挂项目经理岗）跑的：没有历史时按他优先，而不是第一位 */
  const task = { employeeId: 's1' };
  ok('没有历史时，原任务的执行人优先', M.defaultCrew(M.lastProjectRoles(), STAFF, task).pmId === 's1');
}
{
  const M = bind({ staff: STAFF, meetings: [] });
  /* 执行人是设计师：不硬塞他当 PM，仍按岗位找（既有语义，不是这次要改的） */
  const task = { employeeId: 's2' };
  ok('执行人不是管理岗时不硬塞，仍按岗位找项目经理',
    M.defaultCrew(M.lastProjectRoles(), STAFF, task).pmId === 's1');
}
{
  /* 上一场是「小吴兼任 PM + 牵头人」 */
  const solo = { id: 'm4', updatedAt: 9000, participants: [{ id: 's2', name: '小吴', pm: true, chief: true }] };
  const M = bind({ staff: STAFF, meetings: [solo] });
  const c = M.defaultCrew(M.lastProjectRoles(), STAFF, null);
  ok('上个项目 PM 与被删牵头人同名时不会自相矛盾', c.pmId === 's2');
  ok('牵头人必须换一个人（拆解和施工分开）', c.chiefId !== c.pmId, c.chiefId);
}

/* ── 3. 成员默认一个人都不多勾 ── */
console.log('\n[3] 成员默认只有项目经理和牵头人');
{
  const M = bind({ staff: STAFF, meetings: [MEET_OLD] });
  const c = M.defaultCrew(M.lastProjectRoles(), STAFF, null);
  const aiIds = STAFF.filter(s => s.kind !== 'human').map(s => s.id);
  ok('默认只勾 2 个人', c.memberIds.length === 2, JSON.stringify(c.memberIds));
  ok('默认就是项目经理 + 牵头人',
    c.memberIds.includes(c.pmId) && c.memberIds.includes(c.chiefId));
  ok('核心员工默认一个都不勾', !['s1', 's4', 's5'].some(id => c.memberIds.includes(id)),
    JSON.stringify(c.memberIds));
  /* s3 是这场项目的牵头人，所以它在；除 PM/chief 之外不该再有别人 */
  ok('秘书岗不再额外自动算进来（s3 在是因为它是牵头人）',
    c.memberIds.filter(id => id !== c.pmId && id !== c.chiefId).length === 0,
    JSON.stringify(c.memberIds));
  ok('真人不会进默认名单', !c.memberIds.includes('h1'));
  ok('不是全部 AI 员工', c.memberIds.length < aiIds.length);
}
{
  /* 没有任何核心员工：默认形态本来就是两人，不用特判也能过「至少 2 位」 */
  const plain = [
    { id: 'a', name: '甲', role: '运营', kind: 'ai' },
    { id: 'b', name: '乙', role: '文案', kind: 'ai' },
    { id: 'c', name: '丙', role: '剪辑', kind: 'ai' }
  ];
  const M = bind({ staff: plain, meetings: [] });
  const c = M.defaultCrew(M.lastProjectRoles(), plain, null);
  ok('没有核心员工时也只有项目经理 + 牵头人',
    c.memberIds.length === 2 && !c.memberIds.includes('c'), JSON.stringify(c.memberIds));
}
{
  const one = [{ id: 'only', name: '独苗', role: '全栈', kind: 'ai', core: true }];
  const M = bind({ staff: one, meetings: [] });
  const c = M.defaultCrew(M.lastProjectRoles(), one, null);
  ok('只有一个员工时允许兼任（PM = 牵头人 = 他）',
    c.pmId === 'only' && c.chiefId === 'only' && c.memberIds.length === 1);
}

/* ── 4. 「只选核心」「全选」是开关，按一下选、再按一下取消 ── */
console.log('\n[4] 快捷档是可切换的开关');
{
  const BASE = ['s2', 's3'];                     // 项目经理 + 牵头人
  const CORE = ['s1', 's2', 's4', 's5', 's7'];   // 核心（含 PM，不含牵头人）
  const ALL = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
  const M = bind({ staff: STAFF, meetings: [] });
  const q = (mode, cur) => M.quickPick(mode, cur, BASE, CORE, ALL);

  /* base 里的牵头人 s3（秘书）不算核心，所以结果 = 2 + 5 - 1 = 6 */
  ok('默认只有两人时，点「只选核心」→ 核心全上',
    q('core', BASE).length === 6 && q('core', BASE).includes('s7'), JSON.stringify(q('core', BASE)));
  ok('核心已全选时，再点「只选核心」→ 退回两人',
    JSON.stringify(q('core', CORE).sort()) === JSON.stringify(BASE.slice().sort()),
    JSON.stringify(q('core', CORE)));
  ok('默认只有两人时，点「全选」→ 全员',
    q('all', BASE).length === 7, JSON.stringify(q('all', BASE)));
  ok('全员已选时，再点「全选」→ 退回两人',
    JSON.stringify(q('all', ALL).sort()) === JSON.stringify(BASE.slice().sort()),
    JSON.stringify(q('all', ALL)));
  ok('全员状态下点「只选核心」→ 收到核心档（不是退回两人）',
    q('core', ALL).length === 6 && q('core', ALL).includes('s7') && !q('core', ALL).includes('s6'),
    JSON.stringify(q('core', ALL)));
  ok('核心档状态下点「全选」→ 补到全员',
    q('all', CORE).length === 7, JSON.stringify(q('all', CORE)));
  ok('已经手动多加了一个人，点核心仍然只留核心档',
    q('core', ['s1', 's2', 's3', 's4', 's5', 's7', 's6']).length === 6
    && !q('core', ['s1', 's2', 's3', 's4', 's5', 's7', 's6']).includes('s6'));
  ok('核心为空时点核心不崩、只剩两人', q('core', BASE).length >= BASE.length);
  ok('项目经理和牵头人任何时候都在结果里',
    ['core', 'all'].every(m => [BASE, CORE, ALL].every(cur => {
      const r = q(m, cur);
      return BASE.every(id => r.includes(id));
    })));
}

/* ── 5. 源码层面：别再把「全选」写回默认值 ── */
console.log('\n[5] 源码接线');
{
  const a = src.indexOf('function openCreate(');
  const b = src.indexOf('function renderPick(');
  const body = src.slice(a, b > a ? b : a + 3000);
  ok('弹窗里已看不到「转来就全员上阵」的全选',
    !/aiStaff\(\)\.forEach\(s => pick\.add\(s\.id\)\)/.test(body));
  ok('两条分支都走 defaultCrew', (body.match(/defaultCrew\(/g) || []).length === 2);
  ok('两条分支都先读上个项目的班底',
    (body.match(/lastProjectRoles\(\)/g) || []).length === 2);
  ok('「全选」按钮还在', /el\('mtPickAll'\)\.onclick = pickAll/.test(src));
  ok('pickCore / pickAll 都走 quickPick（不是一次性赋值）',
    /function pickCore\(\)[\s\S]{0,200}quickPick\('core'/.test(src)
    && /function pickAll\(\)[\s\S]{0,200}quickPick\('all'/.test(src));
  ok('按钮有亮/灭状态，否则看不出「这一档开着」',
    /classList\.toggle\('on', allOn\)/.test(src) && /classList\.toggle\('on', coreOn && !allOn\)/.test(src));
  ok('选择一变就刷新按钮状态',
    /paintQuick\(\);/.test(src.slice(src.indexOf('function countPick('), src.indexOf('function countPick(') + 400)));
  ok('亮起来的样式是现成的 .btn.ghost.on',
    /\.btn\.ghost\.on\{/.test(fs.readFileSync(path.join(root, 'public/app.css'), 'utf8')));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
