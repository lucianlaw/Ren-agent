// 后置校验：每一步「做成了没有」，由程序说了算，不由模型说了算
// 这是整个 agent 里最不值钱写、但最值钱的部分：
// 模型说「已写好」不算数，文件真的在、内容真的不空、命令真的返回 0 才算数。
import fs from 'node:fs';
import path from 'node:path';

function inside(workspace, rel) {
  const p = path.resolve(workspace, String(rel || ''));
  return p.startsWith(path.resolve(workspace)) ? p : null;
}

/** 单步校验。返回 { pass, why } —— pass=false 时 why 会回灌给模型，让它知道哪一步白做了 */
export function verifyStep(name, args, out, workspace) {
  if (!out || out.ok === false) return { pass: false, why: '工具自己报了失败' };

  if (name === 'write_file') {
    const f = inside(workspace, args.path);
    if (!f) return { pass: false, why: '写入路径超出工作目录' };
    if (!fs.existsSync(f)) return { pass: false, why: `文件没有真的出现：${args.path}` };
    const size = fs.statSync(f).size;
    if (!size) return { pass: false, why: `文件是空的：${args.path}` };
    const want = String(args.content ?? '').length;
    // 内容明显缩水（比如只写了个标题）时也要拦
    if (want && size < Math.min(want * 0.5, 80)) {
      return { pass: false, why: `落盘内容比预期少很多（写了 ${want} 字符，只落了 ${size} 字节）` };
    }
    return { pass: true, why: `${args.path} 已落盘 ${size}B` };
  }

  if (name === 'read_file') {
    const f = inside(workspace, args.path);
    if (!f || !fs.existsSync(f)) return { pass: false, why: `文件不存在：${args.path}` };
    const text = String(out.output || '');
    if (text.length < 10) return { pass: false, why: '读回来的内容几乎是空的，可能读错了文件' };
    return { pass: true, why: `读到 ${text.length} 字符` };
  }

  if (name === 'run_shell') {
    const text = String(out.output || '');
    if (/退出码[:：]?\s*(?!0)\d+/.test(text)) return { pass: false, why: '命令非零退出' };
    return { pass: true, why: '命令正常返回' };
  }

  if (name === 'search_text') {
    return { pass: true, why: String(out.output || '').includes('没有匹配') ? '搜索完成（0 命中）' : '搜索完成' };
  }

  return { pass: true, why: '无校验规则，视为通过' };
}

/** 任务级校验：交付物清单里每个文件都必须存在且非空。这是 done 的唯一依据。 */
export function checkDeliverables(list, workspace) {
  if (!list || !list.length) return { checked: false, pass: true, missing: [], detail: [] };
  const detail = [];
  const missing = [];
  for (const rel of list) {
    const f = inside(workspace, rel);
    if (!f || !fs.existsSync(f)) {
      missing.push(rel);
      detail.push({ path: rel, ok: false, why: '不存在' });
      continue;
    }
    const size = fs.statSync(f).size;
    if (!size) {
      missing.push(rel);
      detail.push({ path: rel, ok: false, why: '空文件' });
    } else {
      detail.push({ path: rel, ok: true, why: `${size}B` });
    }
  }
  return { checked: true, pass: missing.length === 0, missing, detail };
}
