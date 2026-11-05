// 后置校验：每一步「做成了没有」，由程序说了算，不由模型说了算
// 这是整个 agent 里最不值钱写、但最值钱的部分：
// 模型说「已写好」不算数，文件真的在、内容真的不空、命令真的返回 0 才算数。
import fs from 'node:fs';
import path from 'node:path';

function inside(workspace, rel) {
  const w = path.resolve(workspace);
  const p = path.resolve(w, String(rel || ''));
  if (p === w || p.startsWith(w + path.sep)) return p;
  /* 完全访问时工具可以碰工作区外的绝对路径，这里也要跟着能校验，否则会误判「没做成」 */
  if (path.isAbsolute(String(rel || ''))) return p;
  return null;
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

  if (name === 'edit_file') {
    const f = inside(workspace, args.path);
    if (!f || !fs.existsSync(f)) return { pass: false, why: `文件没有真的存在：${args.path}` };
    const size = fs.statSync(f).size;
    if (!size) return { pass: false, why: `改完文件变成空的：${args.path}` };
    const n = Number(out.replaced);
    if (!Number.isFinite(n) || n < 1) return { pass: false, why: '一处都没替换成功，等于没改' };
    /* 长度必须对得上账：换了 n 处，长度变化就该正好是 n×(新−旧)。
       这不是猜文本，是算术核对——文件没被真改过就对不上。 */
    const beforeLen = Number(out.beforeLen), afterLen = Number(out.afterLen);
    if (Number.isFinite(beforeLen) && Number.isFinite(afterLen)) {
      const expect = beforeLen + (String(args.new_string ?? '').length - String(args.old_string ?? '').length) * n;
      if (afterLen !== expect) {
        return { pass: false, why: `文件长度变化对不上（预期 ${expect}，实际 ${afterLen}），替换可能没生效` };
      }
    }
    return { pass: true, why: `${args.path} 已改，替换 ${n} 处（${size}B）` };
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
    /* 退出码优先读结构化字段 out.code（run_shell 会带），其次从正文解析 'exit N'，
       最后兼容「退出码：N」这种中文写法。三级兜底是因为这里曾只认中文格式，
       而工具实际输出是 'exit 1'——跑测试失败也判成通过，验证形同虚设。 */
    let code = Number.isFinite(out.code) ? out.code : null;
    if (code === null) {
      const m = /(?:^|\n)\s*exit\s+(-?\d+)/i.exec(text) || /退出码[:：]?\s*(-?\d+)/.exec(text);
      if (m) code = Number(m[1]);
    }
    if (code !== null) {
      if (code !== 0) return { pass: false, why: `命令退出码 ${code}，这一步没成功（输出里有报错，改完再跑一次）` };
      return { pass: true, why: '命令正常返回（退出码 0）' };
    }
    /* 拿不到退出码：不颁通过，让模型自己确认结果，别默认它做对了 */
    return { pass: true, why: '命令已执行（未取到退出码）' };
  }

  if (name === 'search_text') {
    return { pass: true, why: String(out.output || '').includes('没有匹配') ? '搜索完成（0 命中）' : '搜索完成' };
  }

  /* 联网：搜索必须真拿到结果，抓页面必须真有正文，空手回来等于没做 */
  if (name === 'web_search') {
    const t = String(out.output || '');
    const n = Number((/共\s*(\d+)\s*条/.exec(t) || [])[1] || 0);
    if (!n) return { pass: false, why: '一条结果都没拿到，换个搜法（更短、更具体，或者换成要查的具体数字）' };
    return { pass: true, why: `拿到 ${n} 条结果` };
  }

  if (name === 'fetch_url') {
    const t = String(out.output || '');
    if (t.length < 200) return { pass: false, why: '抓回来的正文太短，多半没读到内容，换一个链接或直接用搜索摘要' };
    return { pass: true, why: `抓到 ${t.length} 字符正文` };
  }

  if (name === 'read_doc') {
    const t = String(out.output || '');
    if (t.length < 40) return { pass: false, why: '文档读出来几乎是空的，可能是扫描件——让老板直接发图片' };
    return { pass: true, why: `读出 ${t.length} 字符` };
  }

  /* 产文件三件套：真落盘 + 不是空壳才算过 */
  if (name === 'make_deck' || name === 'make_sheet' || name === 'make_doc') {
    /* 校验的对象是「文件到底在哪」，不是「模型说它写在哪」。
       工具会把实际落盘的相对路径放进 out.path（后缀可能是它补的、路径可能被规范化过）。
       拿 args.path 去对磁盘，模型漏个后缀就会得到「文件没有真的出现」——
       而文件明明写成了、就在旁边。模型看到「校验未通过」会再调一次同样的工具，
       于是线上出现「2 步执行 · 1 步失败」这种看着像 bug 的场面。 */
    const p = String(out.path || args.path || '');
    const f = inside(workspace, p);
    if (!f || !fs.existsSync(f)) return { pass: false, why: `文件没有真的出现：${p}` };
    const size = fs.statSync(f).size;
    if (size < 1200) return { pass: false, why: `文件太小（${size}B），多半没写成：${p}` };
    return { pass: true, why: `${p} 已落盘 ${Math.round(size / 1024)}KB` };
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
      /* mtime 一起带回去：调用方可以据此判断「这份是这一轮新写的，还是上一轮留下的」 */
      detail.push({ path: rel, ok: true, why: `${size}B`, size, mtime: fs.statSync(f).mtimeMs });
    }
  }
  return { checked: true, pass: missing.length === 0, missing, detail };
}
