/* 积分体系：赠送 / 汇率 / 扣费 / 充值审核。
 *
 * 这组测试盯四件事：
 *   1. 兑换口径只有一个：1 积分 = N token（默认 100 万），进度卡和余额用同一把尺子。
 *   2. 前端不记账：余额的写入口只能是数据库函数，代码里不许出现直接改钱包的调用。
 *   3. 扣费幂等：ref = 任务#轮次，重复收工不会重复扣。
 *   4. 假充值有两道闸：交易单号唯一（数据库拦）、到账要管理员点通过（函数里校验）。
 *
 * 跑法：node test/points-test.mjs
 * 只测纯函数与源码契约，不连网、不连库。
 */
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const appJs = read('../public/app.js');
const cloudJs = read('../public/cloud.js');
const adminSrc = read('../public/admin.js');
const html = read('../public/index.html');
const css = read('../public/app.css');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 把纯函数从源文件里抠出来单独求值：不引整个 app.js（它要 DOM） */
function grabFn(name) {
  const src = `function ${name}(`;
  const i = appJs.indexOf(src);
  if (i < 0) throw new Error('找不到函数 ' + name);
  let depth = 0, started = false;
  for (let j = i; j < appJs.length; j++) {
    const c = appJs[j];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (started && depth === 0) return appJs.slice(i, j + 1);
    }
  }
  throw new Error('函数没闭合：' + name);
}
const constLine = (appJs.match(/const CREDIT_FALLBACK_RATE = \d+;/) || [''])[0];
const pure = new Function('state', `
  ${constLine}
  ${grabFn('creditRate')}
  ${grabFn('fmtBal')}
  ${grabFn('fmtTokenW')}
  ${grabFn('creditsOf')}
  return { creditRate, fmtBal, fmtTokenW, creditsOf };
`);
const M = pure({ cfg: { tokenPerPoint: 1000000 } });

/* ── 1. 汇率 ── */
console.log('[1] 1 积分 = 100 万 token');
ok('默认汇率就是 100 万', M.creditRate() === 1000000, M.creditRate());
ok('后台改了汇率，前端跟着走', pure({ cfg: { tokenPerPoint: 500000 } }).creditRate() === 500000);
ok('配置缺失时退回默认值', pure({ cfg: null }).creditRate() === 1000000);
ok('100 万 token = 1 积分', Math.abs(M.creditsOf(1000000) - 1) < 1e-9, M.creditsOf(1000000));
ok('300 万 token = 3 积分', Math.abs(M.creditsOf(3000000) - 3) < 1e-9);
ok('零 token 不产生积分', M.creditsOf(0) === 0);
ok('100 万显示成「100 万」', M.fmtTokenW(1000000) === '100 万', M.fmtTokenW(1000000));
ok('500 积分 = 5 亿 token', M.fmtTokenW(500 * M.creditRate()) === '5 亿', M.fmtTokenW(500 * M.creditRate()));

/* ── 2. 余额格式 ── */
console.log('[2] 余额显示不像钱');
ok('整数不带小数点', M.fmtBal(500) === '500');
ok('零显示 0', M.fmtBal(0) === '0');
ok('小数留两位', M.fmtBal(0.5) === '0.50');
ok('十位以上留一位', M.fmtBal(12.34) === '12.3');
ok('负数也稳', M.fmtBal(-3) === '-3');

/* ── 3. 前端不记账 ── */
console.log('[3] 余额只能由数据库函数写');
ok('有接赠送的函数', /rpc\('ba_signup_bonus'\)/.test(cloudJs));
ok('有接扣费的函数', /rpc\('ba_spend'/.test(cloudJs));
ok('有接充值提交的函数', /rpc\('ba_recharge_submit'/.test(cloudJs));
ok('有接审核的函数', /rpc\('ba_recharge_review'/.test(cloudJs));
ok('前端没有直接 insert 钱包', !/from\('ba_credit_wallet'\)[\s\S]{0,80}\.insert\(/.test(cloudJs));
ok('前端没有直接 update 钱包', !/from\('ba_credit_wallet'\)[\s\S]{0,80}\.update\(/.test(cloudJs));
ok('前端没有直接写流水', !/from\('ba_credit_log'\)[\s\S]{0,80}\.insert\(/.test(cloudJs));
ok('前端没有直接插充值单', !/from\('ba_recharge_orders'\)[\s\S]{0,80}\.insert\(/.test(cloudJs));
ok('钱包只查自己的（靠 RLS）', /from\('ba_credit_wallet'\)\.select\('\*'\)\.limit\(1\)/.test(cloudJs));

/* ── 4. 赠送：一人一次 ── */
console.log('[4] 新用户赠送不可重复');
ok('进主界面前会领一次赠送', /BOOT\.step\('核对积分…'[\s\S]{0,400}loadPoints\(\)/.test(appJs));
ok('领取是幂等接口（服务端 signup_granted 兜底）', /claimBonus/.test(cloudJs) && /granted/.test(cloudJs));
ok('送多少由后台配置读，不写死在前端', /state\.cfg\.signupPoints|cfg\.signupPoints/.test(appJs));
ok('登录页的赠送数字来自配置', /landBonus/.test(appJs) && /id="landBonus"/.test(html));
ok('已经领过就不再提示（看 granted 才提示）', /r\.granted && Number\(r\.amount\) > 0/.test(appJs));

/* ── 5. 扣费幂等 ── */
console.log('[5] 扣费按轮次，重复收工不重复扣');
ok('收工时扣这一轮的增量', /const rs = roundStats\(t, r\);\s*\n\s*chargeRound\(t, rs\.tokens \|\| 0\)/.test(appJs));
ok('ref 用「任务#轮次」做幂等键', /const ref = `\$\{t\.id\}#r\$\{round\}`/.test(appJs));
ok('没 token 不发起扣费', /if \(!state\.session \|\| !t \|\| tok <= 0\) return/.test(appJs));
ok('余额不足时给的是人话', /积分不够扣这一轮了/.test(appJs));
ok('余额为 0 时不让开跑（免得白烧 token）', /state\.wallet\.total <= 0[\s\S]{0,120}openPoints\(\)/.test(appJs));
ok('扣完刷新余额显示', /state\.wallet = await CLOUD\.myWallet\(\);[\s\S]{0,80}paintCredits\(\)/.test(appJs));
/* 项目（会议）也烧 token：不走任务那条路，单独一个入口 */
ok('项目侧也有扣费入口', /window\.APP\.chargeMeeting = chargeMeeting/.test(appJs));
ok('项目扣费用累计量做幂等键', /\$\{m\.id\}#t\$\{Number\(total\) \|\| d\}/.test(appJs));
ok('会议累计 token 时会回调扣费', /A\.chargeMeeting\(m, d, m\.tokens\.in \+ m\.tokens\.out\)/.test(read('../public/meeting.js')));

/* ── 6. 充值：防假充值 ── */
console.log('[6] 假充值拦在两道闸上');
ok('积分数由服务端按档位算（只传 planId）', /planId: state\.payPlan, channel: state\.payChannel, payNo, note/.test(appJs));
ok('前端没有把积分数传给服务端', !/submitRecharge\(\{[^}]*credits/.test(appJs));
ok('同一单号重复提交有专门提示', /PAY_NO_USED[\s\S]{0,80}只能入账一次/.test(appJs));
ok('没配收款码就不给提交', /\(\!qr \|\| \!plan\) \? ' disabled' : ''/.test(appJs));
ok('必须有交易单号才提交', /payNo\.length < 6/.test(appJs));
ok('后台审核要二次确认', /确认收到 \$\{yenText\(o\.amountFen\)\}/.test(adminSrc));
ok('驳回要写原因并回显给对方', /prompt\('驳回原因/.test(adminSrc) && /reviewNote/.test(adminSrc));

/* ── 7. 明细弹框 ── */
console.log('[7] 明细能分到「哪个桶花的」');
ok('点余额开弹框', /id="creditsBox"/.test(html) && /\$\('#creditsBox'\)\.onclick = \(\) => openPoints\(\)/.test(appJs));
ok('弹框里有总额 / 赠送 / 充值三块', /id="ptsTotal"/.test(html) && /id="ptsGift"/.test(html) && /id="ptsPaid"/.test(html));
ok('消耗能按赠送桶 / 充值桶分开看', /data-tab="spend_gift"/.test(html) && /data-tab="spend_paid"/.test(html));
ok('分桶查询条件对得上库字段', /kind: 'spend', bucket: 'gift'/.test(appJs) && /kind: 'spend', bucket: 'paid'/.test(appJs));
ok('每行带余额快照（对账用）', /余 \$\{fmtBal\(l\.balAfter\)\}/.test(appJs));
ok('充值单状态能自己看到', /我的充值单/.test(appJs));

/* ── 8. 首页四种进法 ── */
console.log('[8] 首页四种登录方式都在');
ok('手机验证码', /id="phoneInput"/.test(html) && /id="sendCodeBtn"/.test(html));
ok('邮箱验证码', /id="emailInput"/.test(html) && /id="emailSendBtn"/.test(html));
ok('微信扫码', /id="wxLogin"/.test(html) && /signInWechat/.test(cloudJs));
ok('访客体验', /id="guestBtn"/.test(html));
ok('邮箱走同一套 OTP 接口', /sendOtp\(\{ email \}\)/.test(cloudJs) && /verifyEmailCode/.test(cloudJs));
ok('两个 tab 切换不打架', /data-mode="phone"/.test(html) && /data-mode="email"/.test(html));
ok('邮箱格式先在前端挡一道', /\^\[\^\\s@\]\+@\[\^\\s@\]\+\\\./.test(appJs));
ok('首页有底部政策位', /land-foot/.test(html) && /隐私政策/.test(html));
ok('首页样式跟深浅色走变量', /\.land\{[\s\S]*?var\(--bg\)/.test(css));

/* ── 9. 后台设置项 ── */
console.log('[9] 后台能改赠送额与汇率');
ok('赠送额可改', /id="admSignup"/.test(adminSrc));
ok('基础汇率可改', /id="admRate"/.test(adminSrc));
ok('其他模型汇率是占位（留空跟随基础汇率）', /留空 = 跟随基础汇率/.test(adminSrc));
ok('档位可加可删', /id="admPlanAdd"/.test(adminSrc) && /adm-plan-del/.test(adminSrc));
ok('收款码可上传（压缩后存 data URL）', /shrinkImage/.test(adminSrc) && /toDataURL\('image\/jpeg'/.test(adminSrc));
ok('待审单有通过 / 驳回', /data-ok=/.test(adminSrc) && /data-no=/.test(adminSrc));
/* 充入不是「直接改余额」：走 ba_admin_grant 函数，函数里校验管理员、同事务写流水 */
ok('充入走数据库函数，不是直接改钱包', /rpc\('ba_admin_grant'/.test(cloudJs) && !/adminGrant[\s\S]{0,200}\.update\(/.test(cloudJs));
ok('充入要选账号、填额度、可选备注', /id="admGrantUser"/.test(adminSrc) && /id="admGrantPts"/.test(adminSrc) && /id="admGrantNote"/.test(adminSrc));
ok('菜单里有这一页', /data-page="points"/.test(html) && /page === 'points'/.test(adminSrc));

/* ── 10. 旧口径清干净 ── */
console.log('[10] 不再有「1 积分 = 1 万 token」的旧尺子');
ok('没有 CREDIT_PER_TOKEN 常量', !/const CREDIT_PER_TOKEN/.test(appJs));
ok('creditsOf 走统一汇率', /function creditsOf\(tok\) \{ return \(Number\(tok\) \|\| 0\) \/ creditRate\(\); \}/.test(appJs));
ok('只有一处 fmtTokenW 定义', (appJs.match(/function fmtTokenW\(/g) || []).length === 1);

/* ── 11. 余额闸：0 停、20 提醒 ──
   这组盯的是「500 积分为什么一动不动」之后补上的那套闸：
   汇率看得见（1 积分 = N token）、消耗有流水、见底会停、快见底会提醒。 */
console.log('[11] 积分见底会停，快见底会提醒');
const LOW = (appJs.match(/const LOW_CREDIT = (\d+);/) || [])[1];
ok('提醒阈值写死在常量里且是 20', LOW === '20', LOW);

/* 这些函数读的是闭包里的 state / toast，所以用 Function 重新绑一份 */
function bindGate(total) {
  const said = [];
  const st = { session: { uid: 'u' }, wallet: { total }, cfg: { tokenPerPoint: 5000 } };
  const fns = new Function('state', 'toast', `
    const LOW_CREDIT = ${LOW};
    ${grabFn('fmtBal')}
    ${grabFn('creditRate')}
    ${grabFn('walletTotal')}
    ${grabFn('creditLeft')}
    ${grabFn('creditWarn')}
    return { walletTotal, creditLeft, creditWarn };
  `)(st, m => said.push(m));
  return { st, fns, said };
}

const gOk = bindGate(500);
ok('余额 500 时不需要提醒', gOk.fns.creditWarn('这个任务') === false && gOk.said.length === 0);
ok('余额 500 时可以继续跑', gOk.fns.creditLeft() === 500);

const gLow = bindGate(18);
ok('余额 18（低于 20）会提醒', gLow.fns.creditWarn('这个任务') === true, gLow.said[0]);
ok('提醒里带上剩余额度', /18/.test(gLow.said[0] || ''), gLow.said[0]);
ok('提醒里点名是哪个任务/项目', /这个任务/.test(gLow.said[0] || ''), gLow.said[0]);
ok('一分钟内不重复念', gLow.fns.creditWarn('这个任务') === false && gLow.said.length === 1);
ok('18 分仍然可以继续跑（提醒不是拦截）', gLow.fns.creditLeft() === 18);

const gZero = bindGate(0);
ok('余额 0 时 creditLeft 为 0（可以据此停下）', gZero.fns.creditLeft() === 0);
ok('余额 0 时说的是「用完了」', gZero.fns.creditWarn('这个任务') === true && /用完/.test(gZero.said[0] || ''), gZero.said[0]);

const gGuest = new Function('state', `
  const LOW_CREDIT = ${LOW};
  ${grabFn('walletTotal')}
  ${grabFn('creditLeft')}
  return creditLeft;
`)({ session: null, wallet: null });
ok('游客态不拦（不落库、不扣积分）', gGuest() === Infinity);
const gNoWallet = new Function('state', `
  const LOW_CREDIT = ${LOW};
  ${grabFn('walletTotal')}
  ${grabFn('creditLeft')}
  return creditLeft;
`)({ session: { uid: 'u' }, wallet: null });
ok('余额还没读回来时不误杀', gNoWallet() === Infinity);

/* 界面与三条链路都要真接上 */
ok('任务每步之前查余额', /creditLeft\(\) <= 0[\s\S]{0,120}credit_exhausted/.test(read('../public/agent.js')));
ok('任务停下有专门状态', /credit_exhausted: '积分用完已停'/.test(appJs));
ok('任务停下会写成一句人话，不是只留失败', /ev\.t === 'credit'[\s\S]{0,200}积分用完了/.test(appJs));
ok('项目每一层/每个节点之前查余额', /function guardRun\(m\) \{ creditGuard\(\); if \(overBud\(m\)\) throw holdErr\(\); \}/.test(read('../public/meeting.js')));
ok('项目见底是「终止」状态，不是失败', /halted: '积分用完已停'/.test(read('../public/meeting.js')));
ok('项目见底给出「去充值 / 充好接着跑」两条路', /data-act="credtopup"/.test(read('../public/meeting.js')) && /data-act="creditresume"/.test(read('../public/meeting.js')));
ok('项目开跑前先挡一道（余额为 0 不进 analyzing）', /if \(creditOut\(\)\) \{[\s\S]{0,400}return;/.test(read('../public/meeting.js')));
ok('项目点开时也会提醒（一分钟一次）', /window\.APP\.creditWarn\('这个项目'\)/.test(read('../public/meeting.js')));

/* ── 12. 账号：用户ID / 账户ID / 对账 ── */
console.log('[12] 每个账号都有用户ID和账户ID，账要对得上');
ok('钱包表有用户ID和账户ID两列', /user_no/.test(cloudJs) && /wallet_no/.test(cloudJs));
ok('余额对象带着两个编号', /userNo: \(r && r\.user_no\) \|\| ''/.test(cloudJs) && /walletNo: \(r && r\.wallet_no\) \|\| ''/.test(cloudJs));
ok('积分弹框里能看到自己的两个号', /id="ptsIds"/.test(html) && /用户ID <b>/.test(appJs));
ok('台账来自数据库函数（不是前端算的）', /rpc\('ba_admin_accounts'\)/.test(cloudJs));
ok('台账带对账差异', /diff: Number\(r\.diff\) \|\| 0/.test(cloudJs));
ok('对账不平会标红', /adm-bad/.test(adminSrc) && /adm-bad\{color:var\(--red\)/.test(read('../public/admin.css')));
ok('点一行能把用户ID填进输入框', /adm-acct-row" data-user=/.test(adminSrc) && /userEl\.value = tr\.dataset\.user/.test(adminSrc));
ok('充入成功要说清充给谁、余额多少、流水号', /当前余额 \$\{fmtNum\(r\.total\)\}，流水号/.test(adminSrc));
ok('找不到账号有人话提示', /ACCOUNT_NOT_FOUND/.test(adminSrc) && /没找到这个账号/.test(adminSrc));
ok('充入后能看到「充入」这一栏流水', /data-tab="admin"/.test(html) && /kind === 'admin'/.test(appJs));

/* ── 13. 汇率改动看得见 ── */
console.log('[13] 汇率是真在用的那一把尺子');
ok('汇率换算只在服务端做（前端不自己记账）', !/tokens\s*\/\s*(rate|tokenPerPoint)|credits\s*=\s*tokens\s*\//.test(cloudJs));
ok('前端汇率与后台同一字段', /state\.cfg\.tokenPerPoint/.test(appJs));
ok('一轮的 token 能折算成积分给老板看', /≈ <b>\$\{fmtCredit\(creditsOf\(st\.tokens\)\)\}<\/b> 积分/.test(appJs));

/* ── 14. 充了积分，余额必须当场变 ── */
console.log('[14] 充值到账后余额立刻变（不能用登录时的旧快照）');
ok('有一个专门重读余额的函数', /async function reloadWallet\(force\)/.test(appJs));
ok('它真的去云表读钱包', /async function reloadWallet[\s\S]{0,400}CLOUD\.myWallet\(\)/.test(appJs));
ok('打开明细时会先重读余额，再画数字', /async function refreshPoints\(force\) \{\s*await reloadWallet\(force\);/.test(appJs));
ok('打开弹框是强刷，不受节流影响', /refreshPoints\(true\);/.test(appJs));
ok('重读之后同步刷新顶部余额', /async function reloadWallet[\s\S]{0,500}paintCredits\(\)/.test(appJs));
ok('读失败不让弹框变空（沿用上次快照）', /读不到就沿用上次快照/.test(appJs));
ok('连点分类页签不重复打云表', /1\.2 秒内连点分类页签不重复打云表/.test(appJs) && /1200/.test(appJs));
ok('弹框里写明余额是什么时候读的', /id="ptsAt"/.test(html) && /余额更新于/.test(appJs));
ok('这个时间戳有样式，不会挤成一坨', /\.pts-at\{/.test(css));
ok('登录拿到钱包时记下时刻', /state\.wallet = await CLOUD\.myWallet\(\);\s*state\.walletAt = Date\.now\(\);/.test(appJs));

/* 真跑一遍：登录时钱包是 495.15 / 0，管理员充了 10000 之后云表变成 495.15 / 10000。
   以前 refreshPoints 只刷流水不刷余额，弹框里就永远停在 0。 */
{
  let calls = 0, painted = 0;
  const state = {
    session: { uid: 'u1' }, walletAt: 0,
    wallet: { gift: 495.15, paid: 0, total: 495.15, userNo: 'U000001', walletNo: 'W000001' }
  };
  const CLOUD = {
    async myWallet() {
      calls++;
      return { gift: 495.15, paid: 10000, total: 10495.15, userNo: 'U000001', walletNo: 'W000001' };
    }
  };
  const run = new Function('state', 'CLOUD', 'paintCredits', 'console',
    /* grabFn 从 `function xxx(` 开始截，异步函数的 async 前缀会被切掉，这里补回来 */
    'async ' + grabFn('reloadWallet') + '\nreturn reloadWallet;'
  )(state, CLOUD, () => { painted++; }, { warn() {} });

  await run();
  ok('重读后余额从 495.15 变成 10495.15', state.wallet.total === 10495.15, String(state.wallet.total));
  ok('充值那一栏从 0 变成 10000', state.wallet.paid === 10000, String(state.wallet.paid));
  ok('顶部余额跟着重画了一次', painted === 1 && calls === 1, `calls=${calls} painted=${painted}`);

  await run();
  ok('紧接着再点一次页签不重复打云表', calls === 1, `calls=${calls}`);
  await run(true);
  ok('强制刷新（打开弹框）会绕过节流', calls === 2, `calls=${calls}`);
}

/* 读失败要保住旧数字，不能把「有 1 万」变成「—」 */
{
  const state = { session: { uid: 'u1' }, walletAt: 0, wallet: { gift: 0, paid: 10000, total: 10000 } };
  const CLOUD = { async myWallet() { throw new Error('network'); } };
  const run = new Function('state', 'CLOUD', 'paintCredits', 'console',
    /* grabFn 从 `function xxx(` 开始截，异步函数的 async 前缀会被切掉，这里补回来 */
    'async ' + grabFn('reloadWallet') + '\nreturn reloadWallet;'
  )(state, CLOUD, () => { throw new Error('读失败不该重画成空'); }, { warn() {} });
  await run();
  ok('网络抖动时余额仍然是 1 万，不会变成空', state.wallet.total === 10000, String(state.wallet && state.wallet.total));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
