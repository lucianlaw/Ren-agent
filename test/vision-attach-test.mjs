/* 图片链路：老板发的图必须真的到得了员工手里。
 *
 * 真实缺陷（2026-11-05，老板反馈「我发了张图让它参考开发，它说没收到图片」）：
 *   1) createTask 返回的是 taskFromRow 的结果，而库表没有 files 列 →
 *      「新任务带附件」在落库这一步就被丢了，员工拿到的任务没有附件。
 *   2) 模型不支持视觉时，dropImages 把图摘掉后只留一句「看不了图」，
 *      模型不知道图还在工作区里，只能回「我没收到图片」。
 *
 * 这里钉住：附件清单不丢、路径一定写进正文、看图工具确实注册了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const agentSrc = read('public/agent.js');
const appSrc = read('public/app.js');
const cloudSrc = read('public/cloud.js');
const serverSrc = read('server.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 从 agent.js 里摘出 userContent / dropImages（它们不依赖 DOM） */
function grab(from, to, names) {
  const a = agentSrc.indexOf(from);
  const b = agentSrc.indexOf(to);
  if (a < 0 || b < 0) throw new Error('摘不出 ' + from);
  return new Function(agentSrc.slice(a, b) + '\nreturn {' + names + '};')();
}
const { userContent, dropImages } = grab(
  'function userContent(text, files) {',
  'function leanMessages(list) {',
  'userContent, dropImages, hasImages'
);

const IMG = { name: '首页.png', path: 'uploads/2026-11-05/首页.png', mime: 'image/png', kind: 'png', dataUrl: 'data:image/png;base64,AAAA' };
const IMG_PATH_ONLY = { name: '首页.png', path: 'uploads/2026-11-05/首页.png', mime: 'image/png', kind: 'png' };
const PDF = { name: '需求.pdf', path: 'uploads/2026-11-05/需求.pdf', mime: 'application/pdf', kind: 'pdf' };

console.log('图片进上下文');
{
  const c = userContent('照这个页面做', [IMG]);
  ok('带 dataUrl 的图走视觉通道', Array.isArray(c) && c.some(x => x.type === 'image_url'));
  const txt = Array.isArray(c) ? c[0].text : c;
  ok('正文里同时写了图片路径', txt.includes('uploads/2026-11-05/首页.png'), txt.slice(0, 120));
  ok('正文里点了 view_image 这条后路', /view_image/.test(txt));
  ok('原话没被吞', txt.startsWith('照这个页面做'));
}

console.log('只有路径的图（存档恢复 / 模型看不了图）');
{
  const c = userContent('照这个做', [IMG_PATH_ONLY]);
  ok('返回的是纯文本', typeof c === 'string');
  ok('路径在正文里', c.includes('uploads/2026-11-05/首页.png'));
  ok('明确指向 view_image', /view_image/.test(c));
  ok('不再出现「请改用文字描述」这种甩锅话术', !/请让老板改用文字描述/.test(c));
}

console.log('文档走 read_doc');
{
  const c = userContent('读一下', [PDF]);
  ok('文档路径写进正文', c.includes('uploads/2026-11-05/需求.pdf'));
  ok('提示用 read_doc', /read_doc/.test(c));
  ok('文档不会被当成图片', !/image_url/.test(JSON.stringify(c)));
}

console.log('模型看不了图时，路径不能一起丢');
{
  const msgs = [{ role: 'user', content: userContent('照这个做', [IMG]) }];
  dropImages(msgs);
  ok('content 被压成字符串', typeof msgs[0].content === 'string');
  ok('路径仍然在', msgs[0].content.includes('uploads/2026-11-05/首页.png'));
  ok('明确要求走 view_image', /view_image/.test(msgs[0].content));
  ok('不再说「让老板改用文字描述」', !/请让老板改用文字描述/.test(msgs[0].content));
}

console.log('附件清单不会被落库这一步吞掉');
{
  ok('createTask 把 files 还回去',
    /return \{ \.\.\.taskFromRow\(data\[0\]\), files: Array\.isArray\(t\.files\) \? t\.files : \[\] \};/.test(cloudSrc));
  ok('taskFromRow 有明确的空 files（读回来就是没有附件）',
    /files: \[\],/.test(cloudSrc));
}

console.log('看图工具');
{
  const cat = /view_image: 'read'/.test(fs.readFileSync(path.join(root, 'lib/tools.js'), 'utf8'));
  ok('view_image 归为 read 权限', cat);
  const toolsSrc = read('lib/tools.js');
  ok('工具定义存在', /name: 'view_image'/.test(toolsSrc));
  ok('实现里会拒绝非图片', /不认识的图片格式/.test(toolsSrc));
  ok('没有视觉模型时给的是明确指引', /没有可用的视觉模型/.test(toolsSrc));
  ok('看图调用走同一条模型通道', /chatStream\(\{/.test(toolsSrc));
}

console.log('通道与权限边界');
{
  ok('模型名由任务发起时带给服务端', /visionModel: pickVisionModel\(\)/.test(appSrc));
  ok('服务端只认发起时记下的模型', /function visionModelOf\(scope\)/.test(serverSrc)
    && /function setVisionModel\(scope, model\)/.test(serverSrc));
  ok('工具参数不能指定模型（跑的是 ctx.llm.model）', /model: llm\.model/.test(read('lib/tools.js')));
  ok('带附件才下发读图工具', /keep\.add\('view_image'\)/.test(agentSrc));
}

console.log('思考过程要回显');
{
  ok('chatOnce 收 onThink', /async function chatOnce\(\{ model, messages, signal, onText, onTool, onThink \}\)/.test(agentSrc));
  ok('reasoning_content 会回调', /onThink\(reasoning\)/.test(agentSrc));
  ok('run 里把思考发成事件', /onThink: \(txt\) => emit\(\{[\s\S]{0,120}t: 'think'/.test(agentSrc));
  ok('前端认 think 事件', /ev\.t === 'think'/.test(appSrc));
  ok('进度卡会用推理内容说话', /正在推理：/.test(appSrc));
  ok('推理有折叠块', /class="think"/.test(appSrc) && /\.think-bd/.test(read('public/app.css')));
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
