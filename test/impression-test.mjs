/* 「让员工重新看看我」：为什么点了没结果
 *
 * 线上现象（2026-11-06）：点按钮 → toast「这次没整理出印象：模型只吐了推理没给正文。
 * 换一个模型再点一次试试」，页面上一条印象都没有。
 *
 * 真因不是解析，是**预算被思考吃掉**：请求写了 max_tokens: 2200，而当前模型是
 * 思考型，先想 2000 多 token 就到底了，正文 0 字、finish_reason=length。
 * judge.js 里为同一件事写过判定（hy4-preview / hy3-x 实测正文 0 字），但印象这条
 * 路没接上，只把「换一个模型」甩给了老板。
 *
 * 这里验四件事：
 *   1. 解析：代码块 / 前后缀文字 / 坏 JSON 都要能正确处理
 *   2. 选模型：不思考的排前面，思考型兜底，最多试 3 个
 *   3. 源码契约：真的会换模型重试、真的收 finish_reason、预算不是 2200
 *   4. 失败文案说清「试了几个」，不是让老板自己猜
 *
 * 跑法：node test/impression-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const judgeSrc = fs.readFileSync(path.join(root, 'public/judge.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

/* 从源码里抠真函数体，不复制实现 */
function grabFn(s, name) {
  const i = s.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  let depth = 0;
  const start = s.indexOf('{', i);
  for (let k = start; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}') { depth--; if (!depth) return s.slice(i, k + 1); }
  }
  throw new Error(name + ' 括号没闭合');
}

/* vsModelOrder 依赖 vsIsThinking / state / window.JUDGE：把真函数拼起来跑 */
function loadOrder(state, judge) {
  const body = [
    grabFn(src, 'vsIsThinking'),
    grabFn(src, 'vsModelOrder'),
    'return vsModelOrder;'
  ].join('\n');
  return new Function('state', 'window', body)(state, { JUDGE: judge });
}

console.log('[1] 解析：模型回的东西不总是干净的 JSON');
{
  const parse = new Function(
    ['return ' + grabFn(src, 'vsParseImpressions') + ';'][0]
  )();
  const out = parse('好的，这是清单：\n```json\n[{"text":"先给结论再展开","kind":"good","tag":"表达"},{"text":"决策前要三档备选","kind":"watch","advice":"下次先列 A/B/C","tag":"决策"}]\n```\n以上。');
  eq('能剥掉前后缀和代码块', out.length, 2);
  eq('正面的默认 kind', out[0].kind, 'good');
  eq('待改进的带 advice', out[1].advice, '下次先列 A/B/C');
  eq('坏 JSON 不抛错', parse('[{"text":').length, 0);
  eq('空回复给空数组', parse('').length, 0);
  eq('没有 text 的条目被过滤', parse('[{"advice":"x"}]').length, 0);
  ok('过长的条会被截到 60 字', parse(`[{"text":"${'长'.repeat(120)}"}]`)[0].text.length === 60);
}

console.log('[2] 选模型：先不思考的，思考型兜底');
{
  const models = [
    { id: 'hy4-preview' },  // 思考型
    { id: 'hy3-x' },        // 思考型
    { id: 'deepseek-v4' },
    { id: 'glm-4' }
  ];
  const judge = (id) => /hy4-preview|hy3-x/.test(String(id));
  const state = { models, settings: { model: 'hy4-preview' } };
  const order = loadOrder(state, { isThinking: judge })(state.settings.model);
  eq('当前是思考型：第一个换成不思考的', order[0], 'deepseek-v4');
  ok('思考型仍留在候选里兜底', order.includes('hy4-preview'));
  ok('最多试 3 个', order.length <= 3, order);

  const s2 = { models, settings: { model: 'glm-4' } };
  const order2 = loadOrder(s2, { isThinking: judge })('glm-4');
  eq('当前模型本来就不思考：先用它', order2[0], 'glm-4');

  const s3 = { models: [{ id: 'hy3-x' }], settings: { model: 'hy3-x' } };
  const order3 = loadOrder(s3, { isThinking: judge })('hy3-x');
  eq('只剩思考型：也得试，不能空手就说没模型', order3[0], 'hy3-x');

  /* judge.js 有判定就复用，别维护第二份正则 */
  ok('判定复用 judge.isThinking', /window\.JUDGE/.test(src) && /\.isThinking\(id\)/.test(src));
}

console.log('[3] 源码契约：空手时要自己换人，不是让老板换');
{
  const scan = src.slice(src.indexOf('async function vsScan()'));
  ok('真的循环试多个模型', /for \(const m of order\)/.test(scan));
  ok('失败后继续下一个（不是直接 return）', /if \(fresh\.length\) break;/.test(scan));
  ok('收了 finish_reason', /finish_reason/.test(scan));
  ok('预算不再是 2200', !/max_tokens:\s*2200/.test(scan) && /max_tokens:\s*3000/.test(scan));
  ok('能识别「额度被思考吃光」', /finish === 'length'/.test(scan));
  ok('失败文案说清试了几个', /试了 \$\{order\.length\} 个模型/.test(scan));
  ok('全是思考型时给出可执行的一句话', /都是思考型模型/.test(scan));
  ok('选模型顺序有单测覆盖的入口', /function vsModelOrder/.test(src) && /function vsIsThinking/.test(src));
}

console.log('[4] 和 judge 的口径一致');
{
  ok('judge 仍导出 isThinking（复用前提）', /isThinking/.test(judgeSrc) && /isThinking,\s*gate/.test(judgeSrc));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
