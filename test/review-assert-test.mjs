/* 评测台断言与评分单测：不跑任务、不烧 token。
   跑法：node test/review-assert-test.mjs
   这里覆盖的是「新加的两个断言（字数上限 / 必含全部）和 Rubric 加权评分」，
   它们直接决定通过率和质量分，口径错了整套对比都不可信。 */
import fs from 'fs';

const code = fs.readFileSync(new URL('../public/review.js', import.meta.url), 'utf8');
const kitCode = fs.readFileSync(new URL('../public/evalkit.js', import.meta.url), 'utf8');
const kitMod = { exports: {} };
new Function('module', 'exports', kitCode)(kitMod, kitMod.exports);
const K = kitMod.exports;

const FILES = {
  'brief.md': '这款产品续航 12 小时，重量 380 克，价格 299 元。',
  'long.md': '这是一段很长的正文。'.repeat(40),
  'full.md': '续航不错，重量很轻，规格页见附表。'
};

const win = {
  APP: { state: { scope: 'u1' }, esc: (x) => String(x), toast: () => {} },
  EVALKIT: K,
  withSC: (p) => p,
  BOSS: {}
};
const doc = { getElementById: () => null, querySelectorAll: () => [] };
const ls = { getItem: () => null, setItem() {}, removeItem() {} };
const fetchStub = async (url) => {
  const name = decodeURIComponent(String(url).split('path=')[1] || '');
  return { json: async () => ({ ok: true, text: FILES[name] || '' }) };
};

const mod = { exports: {} };
new Function('window', 'document', 'localStorage', 'fetch', 'module', 'exports', code)(
  win, doc, ls, fetchStub, mod, mod.exports
);
const R = win.REVIEW;
if (!R) throw new Error('REVIEW 没有挂到 window 上');

const taskWith = (path) => ({
  steps: [{ kind: 'tool', name: 'write_file', ok: true, round: 1, files: [path], args: { path } }],
  userMsgs: [{ text: 'x', round: 1 }],
  status: 'done'
});

let bad = 0;
const ok = (name, cond, extra) => {
  if (!cond) bad++;
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
};

const run = async (name, task, a, want) => {
  const r = await R._check(task, a);
  ok(name, r.pass === want, `${r.pass ? '通过' : '不通过'}${r.msg ? ' · ' + r.msg : ''}`);
};

await (async () => {
  /* ── 必含全部关键词（指令遵循题靠它） ── */
  await run('contains.all：三个词都在', taskWith('brief.md'),
    { type: 'contains', match: 'brief\\.md$', all: ['续航', '重量', '价格'] }, true);
  await run('contains.all：漏一个就红', taskWith('full.md'),
    { type: 'contains', match: 'full\\.md$', all: ['续航', '重量', '价格'] }, false);
  await run('contains.any：有一个就算过', taskWith('full.md'),
    { type: 'contains', match: 'full\\.md$', any: ['续航', '促销'] }, true);
  await run('contains.none：出现禁用词要红', taskWith('brief.md'),
    { type: 'contains', match: 'brief\\.md$', none: ['299'] }, false);

  /* ── 字数上限 ── */
  await run('maxChars：120 字左右在上限内', taskWith('brief.md'),
    { type: 'maxChars', match: 'brief\\.md$', max: 190 }, true);
  await run('maxChars：写太长要红', taskWith('long.md'),
    { type: 'maxChars', match: 'long\\.md$', max: 190 }, false);

  /* ── 全局兜底：拦截页不许糊出来 ── */
  const blocked = { result: '<!DOCTYPE html><html><body>WAF拦截</body></html>', steps: [] };
  const jr = await R._judge(blocked, []);
  ok('全局断言：结论里出现拦截页要红', jr.some((x) => x.type === 'no_raw_html' && !x.pass));

  /* ── Rubric 加权评分 ── */
  const dims = [
    { key: 'fact', weight: 'essential' },
    { key: 'complete', weight: 'important' },
    { key: 'usable', weight: 'important' }
  ];
  const s1 = R._scoreDims(dims, { dims: { fact: 4, complete: 4, usable: 4 }, veto: false });
  ok('全 4 分 → 4.00', Math.abs(s1.quality - 4) < 1e-9, String(s1.quality));
  const s2 = R._scoreDims(dims, { dims: { fact: 4, complete: 2, usable: 2 }, veto: false });
  /* 必要项权重 3，重要项 2：(4*3 + 2*2 + 2*2) / 7 = 20/7 ≈ 2.857 */
  ok('必要项权重更高', Math.abs(s2.quality - 20 / 7) < 1e-6, s2.quality.toFixed(3));
  const s3 = R._scoreDims(dims, { dims: { fact: 4, complete: 4, usable: 4 }, veto: true });
  ok('幻觉一票否决直接归零', s3.quality === 0 && s3.veto === true);
  const s4 = R._scoreDims(dims, { dims: { fact: 3 } });
  ok('只回一个维度也能算', Math.abs(s4.quality - 3) < 1e-9, String(s4.quality));
  const s5 = R._scoreDims(dims, null);
  ok('评委没给分 → quality 为 null（不是 0）', s5.quality === null);
  const s6 = R._scoreDims(dims, { dims: { fact: 9, complete: 0, usable: 4 } });
  ok('越界分数被夹在 1-4', s6.dims.fact === 4 && s6.dims.usable === 4, JSON.stringify(s6.dims));

  console.log(bad ? `\nFAILED: ${bad} 项` : '\nALL_REVIEW_ASSERT_OK');
  process.exit(bad ? 1 : 0);
})();
