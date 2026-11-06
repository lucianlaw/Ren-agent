#!/usr/bin/env node
/* 修复工作区的手边入口。
 *
 * 为什么要有这个脚本，而不是让它自己拼 curl：
 *   这条链路有十几个动作，每个都带必填参数和一段结构化的回执。让模型（或人）
 *   现拼 JSON，出错的地方永远是引号、转义、字段名——而错误回执看起来像「功能坏了」。
 *   一个动作一条命令，参数名和回执格式都固定下来，才谈得上「它自己走完一轮」。
 *
 * 它只做三件事：拼请求、发请求、把回执翻成人话。所有判定都在服务端
 * （lib/repair.js + lib/proof.js + lib/ticket.js），它一个都改不了——
 * 命令行要是能判定，那判定就等于没有。
 *
 * 用法（服务端必须是 dev 实例）：
 *   npm run dev                        # 另开一个终端起 dev
 *   node scripts/heal.mjs next         # 这一轮该修哪张（选 + 开修 + 给任务书）
 *   node scripts/heal.mjs triage       # 只看会选谁，不改动仓库
 *   node scripts/heal.mjs decisions    # 这周起了几轮、都被什么挡掉
 *   node scripts/heal.mjs list
 *   node scripts/heal.mjs begin --sig <工单签名> --by ren
 *   node scripts/heal.mjs tree  --key <key> --dir lib
 *   node scripts/heal.mjs read  --key <key> --path lib/x.js
 *   node scripts/heal.mjs grep  --key <key> --q "within"
 *   node scripts/heal.mjs edit  --key <key> --path lib/x.js --old "..." --new "..."
 *   node scripts/heal.mjs write --key <key> --path lib/x.js --file /tmp/x.js
 *   node scripts/heal.mjs diff  --key <key>
 *   node scripts/heal.mjs prove --key <key> --test test/x-test.mjs
 *   node scripts/heal.mjs submit --key <key> --note "把 A 改成 B"
 *   node scripts/heal.mjs revert --key <key>
 *   node scripts/heal.mjs abort --key <key> [--force]
 *
 * 令牌：--token、环境变量 SELF_TOKEN，或密钥目录里的 self.key（与只读自审同一个）。
 * 地址：--url、环境变量 REN_DEV_URL，默认 http://127.0.0.1:8090。
 */
import fs from 'node:fs';
import { selfToken } from '../lib/selfsrc.js';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';

function arg(name, dflt = '') {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}
const has = (name) => argv.includes('--' + name);

const URL_BASE = (arg('url') || process.env.REN_DEV_URL || 'http://127.0.0.1:8090').replace(/\/+$/, '');
const TOKEN = arg('token') || process.env.SELF_TOKEN || selfToken() || '';
const JSON_OUT = has('json');

const die = (msg, hint = '') => {
  console.error('\n  ' + msg + '\n');
  if (hint) console.error(hint.split('\n').map(l => '    ' + l).join('\n') + '\n');
  process.exit(1);
};

if (cmd === 'help' || has('help')) {
  console.log(`
  修复工作区（服务端必须是 dev 实例）

    node scripts/heal.mjs next           这一轮该修哪张（选 + 开修 + 给任务书）
    node scripts/heal.mjs next --dry     只看会选谁，不改动仓库
    node scripts/heal.mjs next --wait    等一张能修的单子出现再开（--interval 60）
    node scripts/heal.mjs triage         分诊快照：选谁、跳过谁、额度还剩多少
    node scripts/heal.mjs decisions      这周起了几轮、都被什么挡掉 [--days 7]

    node scripts/heal.mjs list
    node scripts/heal.mjs begin  --sig <工单签名> [--by ren]
    node scripts/heal.mjs tree   --key <key> [--dir lib]
    node scripts/heal.mjs read   --key <key> --path lib/x.js [--from 1 --lines 200]
    node scripts/heal.mjs grep   --key <key> --q "within"
    node scripts/heal.mjs edit   --key <key> --path lib/x.js --old "..." --new "..." [--all]
    node scripts/heal.mjs write  --key <key> --path lib/x.js --file /tmp/x.js
    node scripts/heal.mjs diff   --key <key> [--full]
    node scripts/heal.mjs prove  --key <key> --test test/x-test.mjs
    node scripts/heal.mjs submit --key <key> --note "改了什么、为什么"
    node scripts/heal.mjs revert --key <key>
    node scripts/heal.mjs abort  --key <key> [--force]

  令牌：--token / 环境变量 SELF_TOKEN / 密钥目录里的 self.key
  地址：--url / 环境变量 REN_DEV_URL，默认 http://127.0.0.1:8090
  加 --json 拿原始回执（给程序用），不加就是人话。
`);
  process.exit(0);
}

if (!TOKEN) {
  die('没有自审令牌，修复工作区打不开。', [
    '令牌在密钥目录里的 self.key（与只读自审同一个），设环境变量也行：',
    '  export SELF_TOKEN=$(cat ../.ren-secrets/self.key)',
    '或者显式传：node scripts/heal.mjs ' + cmd + ' --token <令牌>'
  ]);
}

/* 动作 → 必填参数。缺参数在这里就报，不要发一个必然 409 的请求：
   服务端的报错是给「逻辑不对」用的，参数没填是调用方的事。 */
const NEED = {
  next: [], triage: [], decisions: [],
  begin: ['sig'],
  tree: ['key'], read: ['key', 'path'], grep: ['key', 'q'],
  write: ['key', 'path'], edit: ['key', 'path', 'old'],
  diff: ['key'], prove: ['key', 'test'], submit: ['key', 'note'],
  revert: ['key'], abort: ['key'], list: []
};

if (!(cmd in NEED)) die(`不认识的命令「${cmd}」`, '可用：' + Object.keys(NEED).join(' / '));
for (const k of NEED[cmd]) {
  if (!arg(k)) die(`缺参数 --${k}`, `例：node scripts/heal.mjs ${cmd} ` + NEED[cmd].map(x => `--${x} <${x}>`).join(' '));
}

const body = { action: cmd === 'list' ? 'list' : cmd, token: TOKEN };
for (const k of ['sig', 'key', 'path', 'q', 'old', 'new', 'text', 'test', 'note', 'by', 'dir', 'glob', 'url']) {
  const v = arg(k);
  if (v && v !== 'true') body[k] = v;
}
if (cmd === 'write') {
  const f = arg('file');
  if (f) {
    try { body.content = fs.readFileSync(f, 'utf8'); } catch (e) { die(`读不了 ${f}：${e.message}`); }
  } else if (arg('text')) {
    body.content = arg('text');
  } else {
    die('写文件要给内容：--file <本地文件> 或 --text <内容>');
  }
}
if (has('full')) body.full = true;
if (has('force')) body.force = true;
if (has('all')) body.all = true;
if (has('dry')) body.dryRun = true;
if (arg('days')) body.days = Number(arg('days')) || 7;

/* --new 必须显式给：漏掉它时服务端会当成「替换成空」，看起来像改成功了，
   实际把那一行删掉了一半。（这条是实测出来的：一次演示把 PUBLIC_API 改成了 `new Set([);`） */
if (cmd === 'edit' && !has('new')) {
  die('edit 要给 --new', '要删掉这段就显式写 --new ""，不要靠省略——省略和「改成空」在参数上是同一件事，\n而它们出错的样子很难分辨。');
}

async function call(payload) {
  try {
    const res = await fetch(URL_BASE + '/api/self/repair', {
      method: 'POST',
      /* Origin 必须带：服务端的同源校验对「没有 Origin」的请求一律拒绝。
         命令行的 Origin 没有浏览器那一层保证，但这条接口真正的凭证是令牌，
         Origin 只是让「从别的网页里偷偷打过来」这条路走不通。 */
      headers: { 'content-type': 'application/json', origin: URL_BASE },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(600000)      /* 自证可能要跑几分钟 */
    });
    return await res.json();
  } catch (e) {
    die(`连不上 ${URL_BASE}（dev 实例起了吗？）`, e.message);
  }
}

/* ── 等一张单子 ──
   「谁起这一轮」的最后一个缺口：机器不能主动找活，但它可以等着。
   循环里只发 triage（选而不开），有得选才发 next——
   不然每轮都会真开一张，把额度烧在一个正在被人看着的屏幕上。 */
if (cmd === 'next' && has('wait')) {
  const every = Math.max(5, Number(arg('interval')) || 60) * 1000;
  const once = has('once');
  let round = 0;
  for (;;) {
    round++;
    const snap = await call({ action: 'triage', token: TOKEN });
    if (!snap.ok) {
      if (JSON_OUT) console.log(JSON.stringify(snap, null, 2));
      else console.log(`  ✗ ${snap.error || '分诊失败'}`);
      process.exit(1);
    }
    const ready = snap.pick || snap.resume;
    if (ready) {
      if (JSON_OUT) { console.log(JSON.stringify(snap, null, 2)); }
      else {
        console.log(`  第 ${round} 轮：有活可干（${ready.key}）。`);
      }
      break;
    }
    if (!JSON_OUT) {
      console.log(`  ${new Date().toLocaleTimeString('zh-CN')} 第 ${round} 轮：${snap.why}`);
    }
    if (once) {
      if (JSON_OUT) console.log(JSON.stringify(snap, null, 2));
      process.exit(snap.pick ? 0 : 2);        /* 2 = 等到了尽头也没活，和「出错」分开 */
    }
    await new Promise(r => setTimeout(r, every));
  }
}

const data = await call(body);

if (JSON_OUT) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(data.ok ? 0 : 1);
}

/* ── 回执翻成人话 ──
   每一种动作的回执形状不同，混在一起打会变成「一大坨 JSON」——
   而人（和模型）真正需要的是「现在这一步成了没有、下一步是什么」。 */
const say = (s = '') => console.log(s);

/* 决策里存的是 UTC（ISO）。直接截字符串会显示成「昨天」——
   而这里问的恰好是「刚才那轮怎么了」，差 8 小时就答错了。 */
const local = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '').slice(5, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

if (!data.ok) {
  say('');
  say('  ✗ ' + (data.error || '失败'));
  if (data.redFlags && data.redFlags.length) {
    say('');
    say('  红线（这些地方不许改）：');
    for (const f of data.redFlags) say(`    · ${f.file} — ${f.why}${f.line ? `（${f.line}）` : ''}`);
    say('');
    say('  这不是「工具不好用」：红线是这条链路的地基，改了它等于给自己开权限。');
  }
  if (data.proof) {
    const p = data.proof;
    say('');
    say(`  自证：${p.ok ? '通过' : '不通过'}（红 ${p.red && p.red.kind} / 绿 ${p.green && p.green.kind}）`);
    for (const c of (p.checks || []).filter(x => !x.ok)) say(`    · ${c.id}：${c.detail}`);
  }
  say('');
  process.exit(1);
}

if (cmd === 'next' || cmd === 'triage') {
  const p = data.pick;
  say('');
  if (!p) {
    say('  这一轮没有可干的活。');
    say(`  ${data.why || ''}`);
    if (data.resume) {
      say(`  在修的：${data.resume.key}　${data.resume.branch}　第 ${data.resume.attempt || 1} 次`);
      say('  先把这张走完（begin 会直接给你任务书），或 abort 掉再开下一张。');
    }
  } else {
    say(`  ${cmd === 'triage' ? '会派（没开）' : '这一轮'}：${p.code}  ${(p.routes && p.routes[0]) || ''}  ${(p.wheres && p.wheres[0]) || ''}`);
    say(`  ${p.zh || ''}　得分 ${p.score}　次数 ${p.n}${p.drop ? `（还有 ${p.drop} 次被限流丢弃）` : ''}　状态 ${p.state}${p.reopened ? '　⚠ 修好又犯' : ''}`);
    if (data.began) {
      say(`  开工：${data.began.key}　${data.began.branch}　基线 ${(data.began.base || '').slice(0, 7)}${data.began.attempt ? `　第 ${data.began.attempt} 次` : ''}`);
    } else if (cmd === 'triage') {
      say('  （只是看看，仓库没动。真开用 next）');
    }
  }
  if (data.budget) say(`  今日额度：${data.budget.used}/${data.budget.limit}`);
  say('');

  const skipped = data.skipped || [];
  if (skipped.length) {
    say(`  跳过 ${skipped.length} 张：`);
    const group = new Map();
    for (const s of skipped) {
      if (!group.has(s.reason)) group.set(s.reason, []);
      group.get(s.reason).push(s);
    }
    for (const [reason, rows] of [...group.entries()].sort((a, b) => b[1].length - a[1].length)) {
      say(`    ${reason}（${rows.length}）— ${rows[0].why}`);
      for (const r of rows.slice(0, 3)) say(`      · ${r.key} ${r.code} 得分 ${r.score}`);
      if (rows.length > 3) say(`      · 还有 ${rows.length - 3} 张`);
    }
    say('');
  }
  if (data.task) { say(data.task); say(''); }
} else if (cmd === 'decisions') {
  const s = data.stats || {};
  say('');
  say(`  近 ${s.days} 天：${s.rounds} 轮分诊，选中 ${s.picked} 次，开了 ${s.began} 张`);
  if (s.top && s.top.length) {
    say('  挡掉最多的原因：');
    for (const t of s.top) say(`    ${String(t.n).padStart(4)}  ${t.reason}`);
  } else {
    say('  （没有跳过记录）');
  }
  const rows = (data.decisions || []).slice(0, 10);
  if (rows.length) {
    say('');
    say('  最近几轮：');
    for (const r of rows) {
      const what = r.picked ? `开了 ${r.picked}` : (r.resume ? `在修 ${r.resume}` : '没开');
      say(`    ${local(r.at)}  ${what}${r.dryRun ? '（只看）' : ''}${r.beganWhy ? `　✗ ${r.beganWhy}` : ''}`);
    }
  }
  say('');
} else if (cmd === 'list') {
  const rows = data.repairs || [];
  if (!rows.length) { say('\n  没有进行中的修复。\n'); process.exit(0); }
  say('');
  for (const r of rows) {
    say(`  ${r.status.padEnd(10)} ${r.key}  ${r.base || '?'}  ${r.branch}  ${r.created || ''}`);
  }
  say('');
} else if (cmd === 'begin') {
  say('');
  say(`  开工：${data.key}  ${data.branch}${data.reuse ? '（继续之前那次）' : ''}`);
  say(`  基线：${(data.base || '').slice(0, 7)}   工作区：${data.dir}`);
  if (data.red) {
    say('');
    say('  禁改文件：');
    for (const f of data.red.blocked) say(`    · ${f}`);
    say('  禁改代码块：');
    for (const f of data.red.guarded) say(`    · ${f}`);
  }
  if (data.task) { say(''); say(data.task); }
  say('');
} else if (cmd === 'tree' || cmd === 'read' || cmd === 'grep') {
  say(data.output || '');
  const nums = [data.count && `共 ${data.count} 个`, data.hits && `${data.hits} 处命中`,
    data.total && `共 ${data.total} 行`, data.truncated && '已截断']
    .filter(Boolean).join('　');
  if (nums) say(`\n（${nums}）`);
} else if (cmd === 'write' || cmd === 'edit') {
  say(`  ✓ ${data.path}  ${data.replaced ? `替换 ${data.replaced} 处` : `${data.bytes} 字节`}`);
} else if (cmd === 'diff') {
  say('');
  say(data.stat || '  （没有改动）');
  if (data.redFlags && data.redFlags.length) {
    say('');
    say('  ⚠ 碰到红线（交单会被拒）：');
    for (const f of data.redFlags) say(`    · ${f.file} — ${f.why}${f.line ? `（${f.line}）` : ''}`);
  }
  say('');
  say(data.patch || '');
  if (data.truncated) say(`\n（补丁 ${data.patchBytes} 字节，已截断；看全的加 --full）`);
} else if (cmd === 'prove') {
  const p = data.proof || {};
  say('');
  say(`  自证：${data.ok ? '✓ 通过' : '✗ 不通过'}${p.strong ? '（强红）' : p.ok ? '（弱红，只能标 fixed）' : ''}`);
  say(`  红：${p.red ? `${p.red.kind}（通过 ${p.red.pass} / 失败 ${p.red.fail}）` : '?'}`);
  say(`  绿：${p.green ? `${p.green.kind}（通过 ${p.green.pass} / 失败 ${p.green.fail}）` : '?'}`);
  say(`  提交：${(p.fix || '').slice(0, 7)}　测试：${p.test || ''}　改动 ${p.changedCount || 0} 个文件`);
  for (const c of (p.checks || []).filter(x => !x.ok)) say(`    · ${c.id}：${c.detail}`);
  say('');
} else if (cmd === 'submit') {
  say('');
  say(`  ✓ 交单：${data.key} → ${data.state}`);
  say(`  分支 ${data.branch}　修复提交 ${(data.fix || '').slice(0, 7)}　改动 ${data.stat || ''}`);
  if (data.proof) {
    say(`  证据：${data.proof.test}　${data.proof.strong ? '强红' : '弱红'}　`
      + `旧代码 ${data.proof.red && data.proof.red.kind} / 新代码 ${data.proof.green && data.proof.green.kind}`);
  }
  say('');
  say('  ' + (data.next || ''));
  say('');
} else if (cmd === 'abort') {
  say(`  ✓ 已中止${data.branchKept ? '（分支保留，改动还在）' : '（分支已删）'}`);
} else if (cmd === 'revert') {
  say('  ✓ 已回到上一次提交（这条单子的改动都撤了）');
}
