/* 标准报错：签名要稳、脱敏要净、限流要压得住、上报本身不许抛
 *
 * 这四件事任何一件错了，整套「让 ren agent 自己修 bug」的链路就变成一场幻觉：
 *   签名不稳 → 同一个 bug 每次都是新工单，永远看不出「它报了 200 次」。
 *   脱敏不净 → 用户文件名和账号 id 躺在日志里，是数据事故。
 *   不限流   → 渲染循环出错一秒写上千条，磁盘先满，然后整个服务挂。
 *   上报会抛 → 一次故障变两次，而且第二次发生在错误处理里，最难查。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, '..');

/* DIR 在 import 时就定了，所以必须先设 env 再 import。
   这个坑之前在 audit 测试上踩过一次：改完 env 发现读的还是原目录。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-'));
process.env.INCIDENT_DIR = TMP;
process.env.INCIDENT_LIMIT_PER_SIG = '3';
process.env.INCIDENT_LIMIT_TOTAL = '8';

const I = await import('../lib/incident.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    console.log('  ✗ ' + name + (extra !== undefined
      ? '  → ' + String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 300) : ''));
  }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const SCOPE_A = 'a'.repeat(32);
const SCOPE_B = 'b'.repeat(32);

console.log('\n[1] 签名：变量变、签名不变；错变了、签名才变');
{
  const base = { code: 'E_TOOL_FAIL', route: '/api/tool', where: 'runTool' };
  const s1 = I.signature({ ...base, msg: '写文件失败：/ws/报价单-2026Q4.xlsx 权限不足 (行 42)' });
  const s2 = I.signature({ ...base, msg: '写文件失败：/ws/预算表.xlsx 权限不足 (行 97)' });
  eq('同码同路由同函数 → 同一个签名（消息不同也不影响）', s1, s2);
  ok('签名里不带行号', !/42|97/.test(s1), s1);

  ok('换错误码 → 换签名', I.signature({ ...base, code: 'E_NET' }) !== s1);
  ok('换路由 → 换签名', I.signature({ ...base, route: '/api/export' }) !== s1);
  ok('换出错函数 → 换签名', I.signature({ ...base, where: 'sendFile' }) !== s1);

  /* 改一行代码会让行号位移。如果签名带行号，改完代码所有历史工单都变成新的，
     「这个 bug 犯了 200 次」的历史就断了。 */
  const withLine = I.signature({ ...base, msg: 'at runTool (tools.js:721:13)' });
  const movedLine = I.signature({ ...base, msg: 'at runTool (tools.js:745:13)' });
  eq('同一函数换了行号，签名不动', withLine, movedLine);

  ok('签名形如 CODE|route|where', /^E_TOOL_FAIL\|/.test(s1) && s1.split('|').length === 3, s1);
  ok('空字段用 - 占位，不产生空段', I.signature({ code: 'E_NET' }) === 'E_NET|-|-', I.signature({ code: 'E_NET' }));
  ok('竖线注入被压掉（否则签名可被伪造）',
    !I.signature({ code: 'E_NET', route: 'a|E_NET|b', where: 'x' }).includes('||'), '');
}

console.log('\n[2] 未知码不能全并成一张工单');
{
  const a = I.signature({ code: 'E_UNKNOWN', route: 'r', where: 'w', msg: '无法读取配置 /x/a.json' });
  const b = I.signature({ code: 'E_UNKNOWN', route: 'r', where: 'w', msg: '无法写入磁盘 /x/a.json' });
  const c = I.signature({ code: 'E_UNKNOWN', route: 'r', where: 'w', msg: '连接被重置' });
  ok('同为 E_UNKNOWN，但毛病不同 → 不同签名', a !== b && b !== c && a !== c, { a, b, c });
  ok('消息结构相同（只差变量）→ 同签名',
    I.signature({ code: 'E_UNKNOWN', route: 'r', where: 'w', msg: '读 /a.json 失败 42' })
    === I.signature({ code: 'E_UNKNOWN', route: 'r', where: 'w', msg: '读 /b.json 失败 97' }), '');
  ok('同一条消息重复算 → 签名固定（哈希不用盐）', a ===
    I.signature({ code: 'E_UNKNOWN', route: 'r', where: 'w', msg: '无法读取配置 /x/a.json' }), '');
  ok('已知码不带消息哈希（保持三段）', I.signature({ code: 'E_NET', route: 'r', where: 'w', msg: 'x' }).split('|').length === 3, '');
}

console.log('\n[3] 归一化：把会漂的东西抹平');
{
  eq('uuid 抹掉', I.normMsg('请求 550e8400-e29b-41d4-a716-446655440000 失败'), '请求 <id> 失败');
  eq('账号 id 抹掉', I.normMsg(`scope ${SCOPE_A} 出错`), 'scope <scope> 出错');
  eq('时间戳抹掉', I.normMsg('at 2026-11-06T14:22:01.123Z'), 'at <ts>');
  eq('数字抹掉（行号/端口/计数）', I.normMsg('第 42 行 port 8080 共 3 次'), '第 <n> 行 port <n> 共 <n> 次');
  eq('连续空白压成一个', I.normMsg('a\n\n   b\tc'), 'a b c');
  ok('长度有上限', I.normMsg('x'.repeat(5000)).length <= 301, I.normMsg('x'.repeat(5000)).length);
  eq('null 不炸', I.normMsg(null), '');
}

console.log('\n[4] 脱敏：账号和文件名不许躺在日志里');
{
  eq('账号 id 换成 <scope>', I.scrubText(`路径 /app/data/ws/${SCOPE_A}/a.md`), '路径 /app/data/ws/<scope>/a.md');
  ok('账号 id 不残留', !I.scrubText(`/x/${SCOPE_A}/y`).includes(SCOPE_A), '');
  ok('家目录用户名抹成 ~', I.scrubText('/Users/maffia/WorkBuddy/x.md').includes('~/'), I.scrubText('/Users/maffia/WorkBuddy/x.md'));
  ok('用户名不残留', !I.scrubText('/Users/maffia/x').includes('maffia'), '');

  /* 文件名只留扩展名：「.xlsx 出错」是定位信息，「报价单-2026Q4」是业务内容 */
  eq('中文文件名只留扩展名', I.scrubText('打不开 报价单-2026Q4.xlsx'), '打不开 *.xlsx');
  eq('英文文件名只留扩展名', I.scrubText('missing report_final_v3.docx'), 'missing *.docx');
  eq('路径里的文件名也抹', I.scrubText('/ws/a/合同扫描件.pdf'), '/ws/a/*.pdf');
  ok('扩展名区分的类型没被吃掉', I.scrubText('a.xlsx b.docx').includes('.xlsx') && I.scrubText('a.xlsx b.docx').includes('.docx'), I.scrubText('a.xlsx b.docx'));
  ok('没有扩展名的普通词不动', I.scrubText('连接超时 connection timeout') === '连接超时 connection timeout', I.scrubText('连接超时 connection timeout'));
  eq('null 不炸', I.scrubText(null), '');
}

console.log('\n[5] 码表：每条都要有中文解释和合法 owner，否则分诊时无话可说');
{
  const codes = Object.keys(I.CODES);
  ok('至少有 12 个码', codes.length >= 12, codes.length);
  ok('每条都有中文', codes.every(c => typeof I.CODES[c].zh === 'string' && I.CODES[c].zh.length > 0), codes);
  ok('owner 只能是 self/external/either', codes.every(c => I.OWNERS.includes(I.CODES[c].owner)),
    codes.filter(c => !I.OWNERS.includes(I.CODES[c].owner)));
  ok('模型通道那类判给 external（改自己代码没用）',
    I.CODES.E_LLM_GATE.owner === 'external' && I.CODES.E_LLM_QUOTA.owner === 'external', '');
  ok('界面/工具那类判给 self（它自己能修）',
    I.CODES.E_UI_RENDER.owner === 'self' && I.CODES.E_TOOL_FAIL.owner === 'self', '');
}

console.log('\n[6] 上报：字段齐、空输入也能落一条');
{
  const r = I.report({
    code: 'E_LLM_GATE', layer: 'client', route: '/agent/chat', where: 'chatStream',
    msg: '模型通道被拦：' + `scope ${SCOPE_A} 打不开 报价单.xlsx`,
    stack: ['at chatStream (llm.js:120:15)', 'at async toolLoop (agent.js:1450:9)'],
    v: '0.8.8', commit: 'b0b61b8', scope: SCOPE_A, ua: 'Chrome/120',
    extra: { status: 403 }
  });
  ok('返回了记录', !!r, r);
  eq('码对', r.code, 'E_LLM_GATE');
  eq('owner 带出来了', r.owner, 'external');
  eq('层对', r.layer, 'client');
  ok('消息里的账号被抹', !r.msg.includes(SCOPE_A), r.msg);
  ok('消息里的文件名被抹', !r.msg.includes('报价单'), r.msg);
  ok('栈也被脱敏', Array.isArray(r.stack) && r.stack.length === 2 && !JSON.stringify(r.stack).includes(SCOPE_A), r.stack);
  ok('extra 保留', r.extra && r.extra.status === 403, r.extra);
  ok('有 id / ts / at / epochMs', r.id && r.ts && r.at && r.epochMs, Object.keys(r));

  const empty = I.report({});
  ok('空 entry 也落一条 E_UNKNOWN', empty && empty.code === 'E_UNKNOWN', empty);
  ok('垃圾 scope 被丢掉（不合法的不进日志）', I.report({ scope: 'not-a-scope' }).scope === '', '');

  const junk = I.report({ code: 'E_NET', extra: 'not-an-object', stack: 'not-an-array', msg: { a: 1 } });
  ok('类型错乱不抛，仍能落盘', !!junk && junk.layer === 'client', junk && junk.layer);

  const veryLong = I.report({ code: 'E_NET', msg: 'x'.repeat(5000) });
  ok('超长消息被截断', veryLong && veryLong.msg.length <= 801, veryLong && veryLong.msg.length);
}

console.log('\n[7] 限流：单签名压 3 条，被压的条数跨窗口也要交出来');
{
  I.resetLimits();
  const t0 = Date.now() - 10 * 60_000;   // 用一个过去的时刻，方便往前推窗口
  let got = 0;
  for (let i = 0; i < 10; i++) {
    if (I.report({ code: 'E_NET', route: '/api/x', where: 'fetchX', msg: 'boom ' + i }, t0)) got++;
  }
  eq('10 次里只落 3 条', got, 3);
  ok('当下就知道还压着 7 条没交出去', I.suppressed() === 7, I.suppressed());

  /* 窗口翻过去之后的第一条，要把上一窗口压掉的次数带上——
     否则「报了一次」和「报了 700 次」在表上长得一模一样。 */
  const next = I.report({ code: 'E_NET', route: '/api/x', where: 'fetchX', msg: 'boom again' }, t0 + 61_000);
  ok('新窗口放行了', !!next, next);
  eq('上窗口压掉的 7 次记在这条上', next && next.drop, 7);
  ok('交出后清零', I.suppressed() === 0, I.suppressed());

  /* 全局上限 8：上面已用掉 4 个额度，再来不同签名最多再进 4 条 */
  let other = 0;
  for (let i = 0; i < 12; i++) {
    if (I.report({ code: 'E_TOOL_FAIL', route: '/api/t' + i, where: 'w', msg: 'x' }, t0 + 62_000)) other++;
  }
  /* 窗口在 t0+61s 时翻过一次，那一格只用了 1 个额度，所以这里最多再进 7 条 */
  ok('全局上限把总量压住', other <= 7, other);
  ok('全局压掉的也被记着', I.suppressed() > 0, I.suppressed());
}

console.log('\n[8] 归组：这张表就是工单列表');
{
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const now = Date.now();
  const mk = (sig, ms, scope, v) => {
    const d = new Date(ms);
    const p = path.join(TMP, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
    const rec = {
      id: 'x' + Math.random().toString(16).slice(2), ts: d.toISOString(), at: d.toISOString().slice(0, 19),
      epochMs: ms, sig, code: sig.split('|')[0], owner: 'self', layer: 'client',
      route: sig.split('|')[1], where: sig.split('|')[2], msg: 'm', stack: [],
      v: v || '0.8.8', commit: 'c', scope, ua: '', extra: null
    };
    fs.appendFileSync(p, JSON.stringify(rec) + '\n');
  };
  const A = 'E_TOOL_FAIL|/api/tool|runTool';
  const B = 'E_UI_RENDER|/app|renderList';
  /* A 报 5 次跨 3 天 2 个账号；B 报 2 次 */
  for (let i = 0; i < 5; i++) mk(A, now - i * 86400e3, i % 2 ? SCOPE_A : SCOPE_B);
  mk(B, now - 3600e3, SCOPE_A);
  mk(B, now - 1800e3, SCOPE_A);

  const g = I.groupIncidents({ from: new Date(now - 30 * 86400e3).toISOString() });
  eq('两条签名归成两组', g.count, 2);
  eq('第一条是最常发生的', g.groups[0].sig, A);
  eq('A 记了 5 次', g.groups[0].n, 5);
  eq('A 跨 2 个账号', g.groups[0].scopes.length, 2);
  ok('A 的首末次时间反了（first 早于 last）',
    Date.parse(g.groups[0].first) <= Date.parse(g.groups[0].last), { first: g.groups[0].first, last: g.groups[0].last });
  ok('每组带中文解释和 owner', g.groups.every(x => x.zh && I.OWNERS.includes(x.owner)), g.groups.map(x => [x.zh, x.owner]));
  ok('按次数降序', g.groups[0].n >= g.groups[1].n, g.groups.map(x => x.n));

  const win = I.groupIncidents({ from: new Date(now - 2 * 3600e3).toISOString() });
  ok('时间窗生效（只算最近 2 小时）', win.total <= 3, win.total);
}

console.log('\n[9] 现状与清扫');
{
  const now = Date.now();
  const st = I.incidentStats(now);
  ok('统计不抛，给得出天数与字节', st.days >= 1 && st.bytes > 0, st);
  ok('保留期默认 30 天', st.keepDays === 30, st.keepDays);
  ok('按天聚合了 byCode', Object.keys(st.byCode).length >= 1, st.byCode);

  /* 造一个 40 天前的分片，看清扫会不会动它；今天的必须留下 */
  const old = new Date(now - 40 * 86400e3);
  const oldName = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}.jsonl`;
  fs.writeFileSync(path.join(TMP, oldName), '{"sig":"E_NET|-|-"}\n');
  const today = new Date(now);
  const todayName = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.jsonl`;

  const dry = I.sweepIncidents({ dryRun: true, now });
  ok('预演说要删，但文件还在', dry.deleted >= 1 && fs.existsSync(path.join(TMP, oldName)), dry);
  const real = I.sweepIncidents({ now });
  ok('真删了 40 天前的分片', real.deleted >= 1 && !fs.existsSync(path.join(TMP, oldName)), real);
  ok('今天的分片留着', fs.existsSync(path.join(TMP, todayName)), todayName);
  ok('keepDays=0 表示明确不清理', I.sweepIncidents({ keepDays: 0, now }).deleted === 0, '');

  /* 非日分片的文件绝不能碰 */
  const junkFile = path.join(TMP, 'notes.txt');
  fs.writeFileSync(junkFile, 'x');
  I.sweepIncidents({ now });
  ok('不是日分片的文件不删', fs.existsSync(junkFile), '');
}

console.log('\n[10] 目录没了也不许抛');
{
  fs.rmSync(TMP, { recursive: true, force: true });
  ok('report 在目录不存在时返回 null 而不抛', I.report({ code: 'E_NET', msg: 'x' }) === null, '');
  const st = I.incidentStats();
  ok('统计返回 0 而不抛', st.files === 0 && st.days === 0, st);
  eq('归组返回空表', I.groupIncidents().count, 0);
  eq('清扫删 0 个', I.sweepIncidents().deleted, 0);
}

console.log(`\n${fail ? '✗ 失败' : '✓ 全过'}：${pass} 通过 / ${fail} 失败`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
