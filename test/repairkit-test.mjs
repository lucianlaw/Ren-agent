/* 修复工具封装：定义合法 + 边界没被放宽
 *
 * 这一层最容易出两类问题，都是「看起来在工作」的那种：
 *   1. 参数名换了（old/new 写成 old_string/new_string 的混搭），模型照着之前
 *      edit_file 的手感填，每次都填错一个字段——回执像「功能坏了」，它就开始乱试。
 *   2. 悄悄多了一个「能宣布通过」的动作。这一条最坏：整个自愈闭环的价值
 *      就建立在「它不能自己说自己通过」上。
 * 所以这里钉的不是功能，是定义本身。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repairkit-'));
/* 把数据目录全部圈进临时目录：这个测试会碰 repair / ticket / incident 三个库，
   不设的话会往仓库 data/ 里写，下一次发布还会把它打包上去。 */
process.env.REPAIR_DIR = path.join(TMP, 'repair');
process.env.TICKET_DIR = path.join(TMP, 'ticket');
process.env.PROOF_DIR = path.join(TMP, 'proof');
process.env.INCIDENT_DIR = path.join(TMP, 'incident');
process.env.AUDIT_DIR = path.join(TMP, 'audit');
delete process.env.REN_DEV_INSTANCE;

const K = await import('../lib/repairkit.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined
      ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''));
  }
};

console.log('[1] 定义本身就是契约');
{
  const names = K.KIT_DEFS.map(d => d.function.name);
  ok('五个工具，一个不多一个不少', names.length === 5, names);
  ok('名字集合固定（改了要同步改文档和测试）', names.join(',') === 'repair_queue,repair_begin,repair_look,repair_change,repair_finish', names);

  /* 全用 repair_ 前缀：混进普通工具表时一眼能看出这是哪一类，
     也让「未知工具」那条报错不至于把它和内置工具搞混。 */
  ok('全部带 repair_ 前缀', names.every(n => n.startsWith('repair_')), names);

  for (const d of K.KIT_DEFS) {
    const f = d.function;
    ok(`${f.name}：是 function 类型`, d.type === 'function');
    ok(`${f.name}：有描述`, typeof f.description === 'string' && f.description.length > 20);
    ok(`${f.name}：parameters 是 object schema`, f.parameters && f.parameters.type === 'object');
    const props = Object.keys((f.parameters && f.parameters.properties) || {});
    const req = (f.parameters && f.parameters.required) || [];
    ok(`${f.name}：required 都在 properties 里`, req.every(r => props.includes(r)), { req, props });
    ok(`${f.name}：required 声明为数组`, Array.isArray(req));
  }
}

console.log('\n[2] 参数名沿用 edit_file / write_file 的叫法');
{
  /* 不是洁癖：模型对 old_string / new_string / content 这三个名字已经有手感，
     换一套命名（old/new）会让它按习惯填错，而错误回执看起来像功能坏了。 */
  const change = K.KIT_DEFS.find(d => d.function.name === 'repair_change').function;
  const props = Object.keys(change.parameters.properties);
  ok('repair_change 用 old_string', props.includes('old_string'), props);
  ok('repair_change 用 new_string', props.includes('new_string'), props);
  ok('repair_change 用 content', props.includes('content'), props);
  ok('没有 old/new 这种简写', !props.includes('old') && !props.includes('new'), props);

  const look = K.KIT_DEFS.find(d => d.function.name === 'repair_look').function;
  ok('repair_look 的 key 和 action 都是必填',
    look.parameters.required.includes('key') && look.parameters.required.includes('action'));
}

console.log('\n[3] 没有「自己宣布通过」的入口');
{
  /* 这一条是整条链路的地基：允许它自证自己通过，等于把「谁来判断」也交出去。
     所以逐个动作查——只要有 verify / pass / approve / settle / resolve 这类
     动作或参数，这条就红。 */
  const banned = /^(verify|pass|pass$|approve|settle|resolve|mark|confirm|close)$/i;
  for (const d of K.KIT_DEFS) {
    const f = d.function;
    const props = Object.keys(f.parameters.properties || {});
    ok(`${f.name}：没有「宣布通过」的参数`, !props.some(p => banned.test(p)), props);
    const enums = props.map(p => f.parameters.properties[p]).filter(p => Array.isArray(p.enum))
      .flatMap(p => p.enum);
    ok(`${f.name}：动作枚举里没有「宣布通过」`, !enums.some(v => banned.test(String(v))), enums);
  }

  /* submit 只能到 fixed：这条写在描述里，也写在 lib/repair.js 里。
     这里只验描述没被改成「它会自动验收」之类的说法。 */
  const fin = K.KIT_DEFS.find(d => d.function.name === 'repair_finish').function.description;
  ok('repair_finish 描述了「只能到 fixed、复核由人做」', /fixed/.test(fin) && /人/.test(fin), fin);
}

console.log('\n[4] 分类是 none：不由工作区四类开关决定');
{
  /* 判 'none' 的实际作用是让前端不要拦（前端逻辑是 cat !== 'none' && !perm[cat]）。
     修复工作区改的是仓库源码，不属于任何账号的 workspace，
     用 read/write 那套判会得出错的结论——所以服务端单独按「维护者」判。 */
  const cat = K.KIT_CATEGORY;
  ok('五个都有分类', Object.keys(cat).length === 5, cat);
  ok('全是 none', Object.values(cat).every(v => v === 'none'), cat);
}

console.log('\n[5] isKit 只认这五个');
{
  for (const n of ['repair_queue', 'repair_begin', 'repair_look', 'repair_change', 'repair_finish']) {
    ok(`认 ${n}`, K.isKit(n) === true);
  }
  /* 反向：普通工具和别的入口绝不能被当成修复工具——
     否则 /api/tool 会把它拐进修复分支，行为完全变样。 */
  for (const n of ['edit_file', 'write_file', 'run_shell', 'ticket_settle', 'settle', 'self_tool', '']) {
    ok(`不认「${n}」`, K.isKit(n) === false);
  }
}

console.log('\n[6] 失败也要有一段能被模型读到的 output');
{
  /* 模型只读 output。只给 error 字段它看不见，表现出来是「工具调了但什么都没回来」，
     然后它开始重复调同一个——这不是模型笨，是回执没给够。 */
  const r1 = await K.runKit('repair_look', {});
  ok('缺 key → ok:false', r1.ok === false, r1);
  ok('缺 key → 有 output', typeof r1.output === 'string' && r1.output.length > 0, r1);
  ok('缺 key → 说了要给什么', /key/.test(r1.output), r1.output);

  const r2 = await K.runKit('repair_change', { key: 'abcabcabcabcabc1', action: 'nope' });
  ok('未知 action → ok:false', r2.ok === false, r2);
  ok('未知 action → 提示可选值', /edit|write|diff/.test(r2.output), r2.output);

  const r3 = await K.runKit('repair_not_a_tool', {});
  ok('不认识的工具名 → ok:false', r3.ok === false, r3);
  ok('不认识的工具名 → 有 output', !!r3.output, r3);

  const r4 = await K.runKit('repair_finish', { key: 'abcabcabcabcabc1', action: 'submit' });
  ok('交单没 note → 拒绝（没有说明的「修好了」不可复核）', r4.ok === false, r4);
  ok('交单没 note → 说了为什么', /note|说明/.test(r4.output), r4.output);
}

console.log('\n[7] 非 dev 实例上，连工具本身都不可用');
{
  /* 定义存在不等于能用。这里验的是「不在 dev 实例时它自己会拒」——
     这条和 server 层的 repairKitOpen 是两道，不是重复：
     前者防「误判 dev」，后者防「根本没开」。 */
  const av = (await import('../lib/repair.js')).available();
  ok('当前不是 dev 实例（测试没设 REN_DEV_INSTANCE）', av.ok === false);
  const q = await K.runKit('repair_queue', {});
  ok('非 dev 上 repair_queue 被拒', q.ok === false, q);
  ok('拒的理由说的是 dev', /dev/.test(q.output), q.output);
}

console.log('\n[8] 渲染：dry 不能装成「已经开好了」');
{
  /* 踩过：dry 回执里把 branch / base 打成 undefined，看起来像工作区已经建好，
     于是下一步直接去 look，而那个目录根本不存在。 */
  const t = K.__test.renderBegin({ key: 'deadbeefdeadbeef', task: '任务书内容' }, true);
  ok('dry 里没有 undefined', !/undefined/.test(t), t);
  ok('dry 说了「仓库没动」', /没动/.test(t), t);
  ok('dry 给了真开的办法', /repair_begin/.test(t), t);
  const t2 = K.__test.renderBegin({ key: 'deadbeefdeadbeef', branch: 'heal/deadbeef', base: 'abcdef1234567', attempt: 2, task: '' }, false);
  ok('真开时打出了分支', /heal\/deadbeef/.test(t2), t2);
  ok('真开时 base 截到 7 位', /abcdef1/.test(t2) && !/abcdef1234567/.test(t2), t2);

  /* 第二类：prove 的 red / green 是对象，直接插模板会变成 [object Object]。
     第一版就这么发出去过——回执里那两行等于没写，模型看到的是两个 Object。 */
  const pf = K.__test.renderFinish('prove', { test: 'test/x-test.mjs' }, {
    ok: true, sha: 'abcdef1234567',
    proof: {
      test: 'test/x-test.mjs', strong: true,
      red: { exit: 1, kind: 'assert', pass: 18, fail: 1 },
      green: { exit: 0, kind: 'pass', pass: 19, fail: 0 }
    }
  });
  ok('prove 回执里没有 [object Object]', !/\[object Object\]/.test(pf), pf);
  ok('改之前报了失败数', /1 失败/.test(pf), pf);
  ok('改之后报了 0 失败', /0 失败/.test(pf), pf);

  /* 弱红必须说出来：它只证明「原来没这个东西」，不证明「当时是坏的」。 */
  const weak = K.__test.renderFinish('prove', { test: 'x' }, {
    ok: true,
    proof: { strong: false, red: { kind: 'load', fail: 1, pass: 0 }, green: { kind: 'pass', fail: 0, pass: 1 } }
  });
  ok('弱红要明说（不然复核的人以为红是修出来的）', /弱红/.test(weak), weak);
}

console.log('\n[9] 工具定义里点名了红线文件');
{
  /* 只为了让模型少走一趟：改不动就是改不动，这里写一句是为了省掉
     「改 → 被拒 → 换个字号再试」那一轮。闸门本身在 lib/repair.js。 */
  const txt = K.KIT_DEFS.map(d => d.function.description).join('\n');
  ok('提到了红线/改不动', /红线|改不动/.test(txt), txt.slice(0, 200));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
