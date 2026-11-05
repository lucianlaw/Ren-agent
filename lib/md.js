/* Markdown → docx 内容块
 *
 * 为什么要这一层：以前写 Word 是让模型把整篇正文塞进 make_doc 的 blocks 参数里，
 * 每个段落都包一层 {"type":"para","text":"…"}，JSON 转义 + 结构开销白烧 token，
 * 而且参数不落盘之前界面上一个字都看不见（生成 30 秒 = 干等 30 秒）。
 *
 * 现在正文直接写在回答里（本来就是流式吐出来的，边写边能看见），
 * make_doc 只收 path / title，正文由这里解析成块，再交给 docx.js 排版。
 * 只做这几件事，不做全量 Markdown：标题、段落、要点、表格——文档真正用得上的就这些。
 */

function stripInline(s) {
  return String(s || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

function splitRow(line) {
  const t = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|').map(c => stripInline(c));
}

const isSepRow = (line) => /^\s*\|?[\s:|-]+\|?\s*$/.test(String(line)) && /-/.test(String(line));

export function mdToBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let title = '';
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    if (!line) { i++; continue; }

    /* 表格：连续以 | 开头的行算一张表，第二行是分隔行就说明第一行是表头 */
    if (/^\|.*\|$/.test(line)) {
      const rows = [];
      let j = i;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(lines[j]); j++; }
      let head = null;
      let body = rows;
      if (rows.length >= 2 && isSepRow(rows[1])) { head = splitRow(rows[0]); body = rows.slice(2); }
      const data = body.filter(r => !isSepRow(r)).map(splitRow);
      if (head || data.length) {
        blocks.push(head ? { type: 'table', head, rows: data } : { type: 'table', head: data.shift() || [], rows: data });
      }
      i = j;
      continue;
    }

    /* 标题：# / ## / ### 都收，一级标题当文档大标题用掉 */
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      const text = stripInline(h[2]);
      if (!title && h[1].length === 1) { title = text; i++; continue; }
      blocks.push({ type: 'heading', text, level: h[1].length <= 2 ? h[1].length : 2 });
      i++;
      continue;
    }

    /* 要点：- / * / · / 1. / 1、 开头 */
    const b = /^([-*·]|\d{1,2}[.、)])\s+(.*)$/.exec(line);
    if (b) {
      const indented = /^\s{2,}/.test(raw);
      blocks.push({ type: 'bullet', text: stripInline(b[2]), level: indented ? 1 : 0 });
      i++;
      continue;
    }

    /* 分隔线不进正文 */
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { i++; continue; }

    blocks.push({ type: 'para', text: stripInline(line) });
    i++;
  }

  /* 开头那句「好的，我这就写：」是对话礼节，不该出现在公文里 */
  if (blocks.length) {
    const first = blocks[0];
    const looksLikeChatter = first.type === 'para'
      && first.text.length <= 40
      && /(好的|可以|没问题|收到|以下|这是|我来|我这就|下面)/.test(first.text)
      && blocks.slice(1).some(x => x.type === 'heading' || x.type === 'table');
    if (looksLikeChatter) blocks.shift();
  }

  return { title, blocks: blocks.filter(x => x.type === 'table' || (x.text && x.text.length)) };
}
