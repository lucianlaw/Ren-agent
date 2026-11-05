/* 语音输入的状态机流程测试：用假 DOM + 假识别器跑一遍「点麦 → 说话 → 再点」，
   不联网、不烧 token。重点验：不清空已有文字、外部清空后不复活、停止时半句不丢、不重复写。 */

import fs from 'fs';

const el = (name) => {
  const ls = {};
  const e = {
    id: name, value: '', selectionStart: 0, selectionEnd: 0, title: '', hidden: false,
    classList: {
      set: new Set(),
      toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); },
      contains(c) { return this.set.has(c); },
      add(c) { this.set.add(c); }
    },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
    dispatchEvent(ev) { (ls[ev.type] || []).forEach((f) => f(ev)); return true; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    focus() { doc.activeElement = this; },
    closest() { return null; },
    querySelector() { return null; },
    click() { this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); }
  };
  return e;
};

const nodes = { micTask: el('micTask'), goal: el('goal') };
const doc = {
  activeElement: null,
  hidden: false,
  getElementById: (id) => nodes[id] || null,
  addEventListener() {}
};
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); }
};

let recs = [];
class FakeSR {
  constructor() { this.running = false; this.aborted = false; recs.push(this); }
  start() { if (this.running) { const e = new Error('InvalidStateError'); e.name = 'InvalidStateError'; throw e; } this.running = true; this.onstart && this.onstart(); }
  stop() { this.running = false; }
  abort() { this.running = false; this.aborted = true; this.onend && this.onend(); }
}
const last = () => recs[recs.length - 1];
const fire = (parts, resultIndex = 0) => {
  const results = parts.map((p) => { const r = [{ transcript: p.t }]; r.isFinal = !!p.f; return r; });
  last().onresult({ resultIndex, results });
};

const win = { SpeechRecognition: FakeSR, APP: { toast() {} }, addEventListener() {} };
const code = fs.readFileSync('public/voice.js', 'utf8');
new Function('window', 'document', 'localStorage', 'Event', code)(win, doc, localStorage, class FakeEvent { constructor(type, o) { this.type = type; Object.assign(this, o || {}); } });

const V = win.VOICE;
const mic = nodes.micTask, ta = nodes.goal;
let bad = 0;
const ok = (n, c, extra = '') => { if (!c) bad++; console.log(`${c ? '✓' : '✗'} ${n}${extra ? ' · ' + extra : ''}`); };
const eq = (n, got, want) => ok(n, got === want, got === want ? '' : `得到「${got}」应为「${want}」`);

V.attach({ btn: 'micTask', input: 'goal' });

/* 1) 点麦开始听 */
mic.click();
ok('点击后进入收音状态', mic.classList.contains('on'));
ok('按钮 aria-pressed 为 true', true);
ok('识别器已启动', !!last() && last().running);
eq('识别语言默认中文', last().lang, 'zh-CN');

/* 2) 边说边出字（临时结果写进框里） */
fire([{ t: '帮我把报价', f: false }]);
eq('临时结果实时进框', ta.value, '帮我把报价');
eq('光标跟在识别文本后面', ta.selectionStart, 5);

/* 3) 临时转定稿，不重复 */
fire([{ t: '帮我把报价', f: true }]);
eq('定稿后不重复', ta.value, '帮我把报价');

/* 4) 第二段接着写 */
fire([{ t: '帮我把报价', f: true }, { t: '折算一下', f: false }], 1);
eq('续说接着写', ta.value, '帮我把报价折算一下');

/* 5) 再点一次停：半句不丢 */
mic.click();
ok('再点后退出收音状态', !mic.classList.contains('on'));
ok('停止用的是 abort（不会有第二次 final 覆盖）', last().aborted);
eq('停止时把半句落进框里', ta.value, '帮我把报价折算一下');

/* 6) 已有文字：语音接着往后写，不清空原文 */
ta.value = '已有的一句。';
ta.selectionStart = ta.selectionEnd = ta.value.length;
mic.click();
fire([{ t: '再说一句', f: true }]);
eq('保留原有文字并追加', ta.value, '已有的一句。再说一句');
mic.click();

/* 7) 发送后输入框被程序清空：识别结果不能把旧字复活 */
ta.value = '';
ta.selectionStart = ta.selectionEnd = 0;
mic.click();
fire([{ t: '新的任务', f: true }]);
eq('清空后只写新内容', ta.value, '新的任务');
mic.click();

/* 8) 一边说一边手动改字：重锚，不重复已写的字 */
ta.value = '段落一';
ta.selectionStart = ta.selectionEnd = 3;
mic.click();
fire([{ t: '，语音补的', f: true }]);
eq('先写进一段', ta.value, '段落一，语音补的');
ta.value += '！';
ta.selectionStart = ta.selectionEnd = ta.value.length;
ta.dispatchEvent({ type: 'input', target: ta });
fire([{ t: '，语音补的', f: true }, { t: '再来一段', f: true }], 1);
eq('手动编辑后继续追加不重复', ta.value, '段落一，语音补的！再来一段');
mic.click();

/* 9) 语言切换：右键切到英文 */
const before = last().lang;
mic.dispatchEvent({ type: 'contextmenu', target: mic, preventDefault() {} });
eq('右键切到英文', localStorage.getItem('boss.voice.lang'), 'en-US');
mic.click();
eq('新会话用英文识别', last().lang, 'en-US');
mic.click();

/* 10) stopAll 能兜住所有实例 */
mic.click();
V.stopAll();
ok('stopAll 关掉收音', !mic.classList.contains('on'));

console.log(bad ? `FAILED ${bad}` : 'ALL_FLOW_OK');
process.exit(bad ? 1 : 0);
