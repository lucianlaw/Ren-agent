/* 员工性格四维度：性别 / 生肖 / 星座 / MBTI（全部选填）。
 *
 * 换掉的是原来 6 个预制人设（严谨 / 沉稳 / 锋利 / 青春 / 温和 / 成熟）——
 * 选完之后每个员工的口气都差不多，真正上场时区分不出来。
 * 这组测试盯三件事：
 *   1. 四个维度都齐、键不重复、认不出的旧值当没填（不能让脏数据写出「属undefined」）。
 *   2. 提示词里必须带上「不改判断」的约束——性格只改语气和先看什么。
 *   3. 一项没填时回落到老人设，老员工不会因为这次改版突然变声。
 *
 * 跑法：node test/traits-test.mjs
 * 只测纯函数与结构，不连网、不起服务。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const traitsSrc = read('../public/traits.js');
const appJs = read('../public/app.js');
const agentJs = read('../public/agent.js');
const meetJs = read('../public/meeting.js');
const cloudJs = read('../public/cloud.js');
const html = read('../public/index.html');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

/* 在沙箱里跑 traits.js，拿真的 window.TRAITS —— 不复制实现 */
const win = {};
new Function('window', traitsSrc)(win);
const T = win.TRAITS;

/* ── 1. 维度与选项 ── */
console.log('[1] 四个维度都齐');
eq('维度顺序固定：性别 → 生肖 → 星座 → MBTI', T.DIMS, ['gender', 'zodiac', 'sign', 'mbti']);
eq('性别 2 项', T.D.gender.opts.length, 2);
eq('生肖 12 项', T.D.zodiac.opts.length, 12);
eq('星座 12 项', T.D.sign.opts.length, 12);
eq('MBTI 16 项', T.D.mbti.opts.length, 16);
T.DIMS.forEach(d => {
  const keys = T.D[d].opts.map(o => o.k);
  ok(`${d} 的键不重复`, new Set(keys).size === keys.length);
  ok(`${d} 每项都有名字和描述`, T.D[d].opts.every(o => o.n && o.d));
});

/* ── 2. 取值：认不出的当没填 ── */
console.log('[2] 取值与容错');
eq('四个空 → 全空', T.pick({}), { gender: '', zodiac: '', sign: '', mbti: '' });
eq('null 也不炸', T.pick(null), { gender: '', zodiac: '', sign: '', mbti: '' });
eq('认识的键原样保留',
  T.pick({ gender: 'female', zodiac: 'tiger', sign: 'scorpio', mbti: 'INTJ' }),
  { gender: 'female', zodiac: 'tiger', sign: 'scorpio', mbti: 'INTJ' });
eq('不认识的键当没填（老数据里废掉的人设键不会漏进来）',
  T.pick({ gender: 'x', zodiac: 'dragon2', sign: '蛇夫座', mbti: 'ABCD' }),
  { gender: '', zodiac: '', sign: '', mbti: '' });
eq('大小写不对的 MBTI 也不认（避免 INtj 和 INTJ 两条并存）', T.pick({ mbti: 'INtj' }).mbti, '');
ok('填了一条 any() 就为真', T.any({ mbti: 'ENFP' }) === true);
ok('一条没填 any() 为假', T.any({}) === false);

/* ── 3. 标签行 ── */
console.log('[3] 短标签（界面和提示词共用）');
eq('四项全填', T.line({ gender: 'male', zodiac: 'tiger', sign: 'scorpio', mbti: 'INTJ' }), '男 · 属虎 · 天蝎座 · INTJ');
eq('只填生肖：自动加「属」', T.line({ zodiac: 'ox' }), '属牛');
eq('只填 MBTI', T.line({ mbti: 'INFP' }), 'INFP');
eq('一条没填是空串（调用方好判断要不要回落到老人设）', T.line({}), '');
ok('即时预览：标签在前、各维描述在后',
  T.summary({ gender: 'female', mbti: 'ISTJ' }).startsWith('女 · ISTJ　——　')
  && T.summary({ gender: 'female', mbti: 'ISTJ' }).includes('先接住对方的顾虑'));
eq('一项没填的预览是空串（界面自己给默认话术）', T.summary({}), '');

/* ── 4. 提示词 ── */
console.log('[4] 提示词：带约束、够短');
const full = T.prompt({ gender: 'female', zodiac: 'goat', sign: 'libra', mbti: 'ENFJ' });
ok('四项都写进去', ['女', '属羊', '天秤座', 'ENFJ'].every(k => full.includes(k)));
ok('每项的行为描述也写进去', full.includes('先接住对方的顾虑') && full.includes('权衡取舍'));
ok('硬约束：不为了像这个人就把问题说小', /不为了像这个人就把问题说小/.test(full));
ok('硬约束：性别只影响语气，不做能力假设', /性别只影响语气/.test(full));
ok('硬约束：事实与风险照实说', /事实、数字、风险该说什么说什么/.test(full));
ok('一条没填 → 空串（交给老人设兜底）', T.prompt({}) === '');
ok(`全填也不啰嗦（${full.length} 字，上限 260）`, full.length <= 260, full.length);
ok('单填一项也带约束', /性别只影响语气/.test(T.prompt({ mbti: 'ISTJ' })));

/* ── 5. 选择器渲染 ── */
console.log('[5] 选择器 HTML');
const g = T.pickHTML('zodiac', 'tiger');
ok('有「不指定」选项', /data-k=""[^>]*>不指定</.test(g));
ok('每个选项都带维度与键', /data-dim="zodiac" data-k="tiger"/.test(g));
ok('当前项高亮', /class="tr-chip on" data-dim="zodiac" data-k="tiger"/.test(g));
ok('只高亮一个', (g.match(/tr-chip on/g) || []).length === 1);
ok('生肖的 12 项都在', T.D.zodiac.opts.every(o => g.includes(`data-k="${o.k}"`)));
ok('描述挂成 title（悬停能看含义）', g.includes('title="气场足、敢拍板'));
ok('不认识的维度给空串', T.pickHTML('nope', 'x') === '');
const all = T.allHTML({ gender: 'male' });
ok('四组一次渲出来', T.DIMS.every(d => all.includes(`data-group="${d}"`)));
ok('没填的维度默认停在「不指定」', /data-group="mbti"[\s\S]*data-k=""[^>]*class="tr-chip on"|class="tr-chip on" data-dim="mbti" data-k=""/.test(all));
ok('底部有即时预览行', /class="tr-sum"/.test(all));
ok('一条没填时预览给默认口径', /默认的稳重口径/.test(T.allHTML({})));
const sumTxt = (T.allHTML({ gender: 'female', zodiac: 'tiger', sign: 'scorpio', mbti: 'INTJ' })
  .match(/class="tr-sum"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
ok('四项全填时预览也不超过两行（≤100 字）', sumTxt.length > 20 && sumTxt.length <= 100, sumTxt.length);

/* ── 6. 界面结构：老的选择器必须彻底让位 ── */
console.log('[6] 界面');
ok('新建员工弹框用 tr-box', /id="traitBox"/.test(html));
ok('老的 personaGrid 已删', !/id="personaGrid"/.test(html));
ok('traits.js 在 agent.js 之前加载（提示词要用）',
  html.indexOf('./traits.js') > 0 && html.indexOf('./traits.js') < html.indexOf('./agent.js'));
ok('员工面板用 stfTraits', /id="stfTraits"/.test(appJs));
ok('面板里不再渲染老的人设格子', !/stfPersona/.test(appJs));
ok('renderTraitBox 存在且是单选逻辑', /function renderTraitBox\(/.test(appJs) && /cur\[dim\] === k \? '' : k/.test(appJs));
ok('保存带上四个字段',
  /gender: state\.traits\.gender \|\| ''/.test(appJs)
  && /zodiac: state\.traits\.zodiac \|\| ''/.test(appJs)
  && /sign: state\.traits\.sign \|\| ''/.test(appJs)
  && /mbti: state\.traits\.mbti \|\| ''/.test(appJs));
ok('保存不再写 persona（老值留着当兜底）', !/persona: state\.panelPersona/.test(appJs));
ok('左栏员工卡优先显示性格标签', /TRAITS\.line\(e\)/.test(appJs));

/* ── 7. 提示词接线：任务线和项目线都要用 ── */
console.log('[7] 提示词接线');
ok('任务线 buildSystem 用 TRAITS.prompt', /TRAITS\.prompt\(staff\)/.test(agentJs));
ok('任务线没填时回落到老人设', /const style = trait \|\| `说话风格：/.test(agentJs));
ok('项目线 personaLine 用 TRAITS.prompt', /TRAITS\.prompt\(cur\)/.test(meetJs));
ok('项目线按员工档案的当前值算（刚改完立刻生效）', /S\(\)\.staff \|\| \[\]\)\.find\(s => s\.id === p\.id\)/.test(meetJs));
ok('项目线不再重复拼「说话风格：」前缀', (meetJs.match(/说话风格：\$\{personaLine/g) || []).length === 0);
ok('参会人带上四个字段',
  /gender: s\.gender \|\| ''/.test(meetJs) && /mbti: s\.mbti \|\| ''/.test(meetJs));

/* ── 8. 云端往返 ── */
console.log('[8] 云端往返');
ok('读员工映射四列',
  /gender: r\.gender \|\| ''/.test(cloudJs) && /zodiac: r\.zodiac \|\| ''/.test(cloudJs)
  && /sign: r\.sign \|\| ''/.test(cloudJs) && /mbti: r\.mbti \|\| ''/.test(cloudJs));
ok('新建员工写入四列', /gender: s\.gender \|\| ''/.test(cloudJs) && /mbti: s\.mbti \|\| ''/.test(cloudJs));
ok('改员工允许更新四列',
  /'gender', 'zodiac', 'sign', 'mbti'/.test(cloudJs));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
