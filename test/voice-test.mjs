/* 语音输入的文本拼装单测：不烧 token、不开麦克风，纯算文本。
   跑法：node test/voice-test.mjs
   这里验的是最容易出错的三件事：中英混排粘字、插入点被外部改动后重复拼字、光标位置。 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(here, '../public/voice.js'), 'utf8');

const win = {};
const doc = { addEventListener() {}, getElementById() { return null; } };
new Function('window', 'document', 'localStorage', code)(win, doc, { getItem() { return null; }, setItem() {} });
const V = win.VOICE;

let bad = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' · ' + extra : ''}`);
};
const eq = (name, got, want) => ok(name, got === want, got === want ? '' : `得到「${got}」应为「${want}」`);

if (!V) {
  console.error('voice.js 没挂到 window.VOICE 上');
  process.exit(1);
}

/* 1) 拼接：中文不补空格、英文补空格、空白不重复 */
eq('中文两段直接拼', V._join('你好', '世界'), '你好世界');
eq('英文两段补空格', V._join('hello', 'world'), 'hello world');
eq('英文自带空格不重复', V._join('hello ', ' world'), 'hello world');
eq('前段为空取后段', V._join('', 'abc'), 'abc');
eq('后段为空取前段', V._join('abc', ''), 'abc');
eq('中文接英文词不粘空格', V._join('帮我看看', 'API 设计'), '帮我看看API 设计');
eq('英文接中文不补空格', V._join('call', '我'), 'call我');
eq('数字之间补空格', V._join('共 12', '34 条'), '共 12 34 条');

/* 2) 插入点：写到光标处，前后原文都保住 */
const st = V._anchor({}, 'ABCD', 2, 2);
eq('光标前置文本', st.prefix, 'AB');
eq('光标后置文本', st.suffix, 'CD');
st.finals = '你好';
eq('插在光标中间', V._build(st), 'AB你好CD');

/* 3) 选中一段再说话 = 替换选中内容 */
const st2 = V._anchor({}, 'ABCD', 1, 3);
st2.finals = 'X';
eq('选中被替换', V._build(st2), 'AXD');

/* 4) 追加在末尾（最常见的场景） */
const st3 = V._anchor({}, '写个周报', 4, 4);
st3.finals = '，三百字';
eq('末尾追加', V._build(st3), '写个周报，三百字');

/* 5) 空框 */
const st4 = V._anchor({}, '', 0, 0);
st4.finals = '把报价表折算排序';
eq('空框直接写', V._build(st4), '把报价表折算排序');

/* 6) 临时结果与定稿结果交替时不重复 */
const st5 = V._anchor({}, '', 0, 0);
st5.finals = '第一句。';
st5.interim = '第二';
eq('定稿 + 临时句', V._build(st5), '第一句。第二');
st5.interim = '';
eq('临时转正后不留残影', V._build(st5), '第一句。');

/* 7) 边界：光标越界不能抛错 */
const st6 = V._anchor({}, 'abc', 99, 999);
eq('越界光标夹到末尾', st6.prefix, 'abc');
eq('越界不产生后缀', st6.suffix, '');

/* 8) 未支持语音的浏览器：模块仍要能安全挂载 */
ok('无 API 时 supported 为 false', V.supported === false);
ok('无 API 时 attach 不抛错', (() => { try { V.attach({ btn: 'x', input: 'y' }); return true; } catch (e) { return false; } })());
ok('stopAll 可安全调用', (() => { try { V.stopAll(); return true; } catch (e) { return false; } })());

console.log(bad ? `FAILED ${bad}` : 'ALL_VOICE_OK');
process.exit(bad ? 1 : 0);
