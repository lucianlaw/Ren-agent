// 交付物内容摘要：给验收人看的「磁盘上到底有什么」
//
// 为什么不把正文交给验收人审：交付人自己写的总结可能漂亮但空，书 7.4.2 讲得很直接——
// 评估框架必须核实「机器可独立复核的事实」，而不是 Agent 的自我陈述。
// 所以这里从磁盘把真文件读出来，摘成一段能塞进 prompt 的内容。
import fs from 'node:fs';
import path from 'node:path';
import { previewOffice } from './office.js';

/* 能直接按文本读的：代码/标记/纯文本都算 */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.html', '.htm',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.py', '.sh',
  '.yaml', '.yml', '.xml', '.svg', '.log', '.sql', '.toml', '.ini', '.env'
]);
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx']);

const LIMITS = {
  headChars: 900,      // 每个文件给验收人看的开头字数
  textReadBytes: 2 * 1024 * 1024,
  files: 8
};

function clipHead(s, n) {
  const t = String(s || '').replace(/\r\n/g, '\n').trim();
  if (t.length <= (n || LIMITS.headChars)) return t;
  return t.slice(0, (n || LIMITS.headChars)) + '…';
}

function safeStat(f) {
  try { return fs.statSync(f); } catch { return null; }
}

/**
 * 单个交付物的摘要。
 * @param {string} root  工作区根目录（已解析好的绝对路径）
 * @param {string} rel   相对路径
 * @param {number} since 这一轮的起始时间；给了就顺带标出「这是上一轮的旧文件」
 * @returns {{path,size,mtime,kind,chars,structure,head,stale}|{path,missing:true}}
 */
export function digestFile(root, rel, since) {
  const p = String(rel || '');
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  const st = safeStat(abs);
  if (!st || !st.isFile()) return { path: p, missing: true, size: 0, chars: 0 };

  const ext = path.extname(abs).toLowerCase();
  const base = {
    path: p, size: st.size, mtime: st.mtimeMs,
    /* 旧文件标记：盘上留着上一轮写的同名文件，这一轮没重写。
       多给 2 秒余量——写盘时间和轮次起始时间几乎同时，别冤枉刚写完的文件。 */
    stale: !!since && st.mtimeMs < since - 2000
  };

  if (st.size === 0) return { ...base, kind: 'empty', chars: 0, head: '' };

  if (TEXT_EXT.has(ext)) {
    let text = '';
    try {
      const fd = fs.openSync(abs, 'r');
      const len = Math.min(st.size, LIMITS.textReadBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch (e) {
      return { ...base, kind: 'text', chars: null, head: '', error: e.message };
    }
    return {
      ...base, kind: 'text',
      chars: text.length,
      structure: ext.replace('.', '').toUpperCase(),
      head: clipHead(text)
    };
  }

  if (OFFICE_EXT.has(ext)) {
    try {
      const d = previewOffice(abs, ext);
      return { ...base, ...digestOffice(d) };
    } catch (e) {
      /* 2003 老格式、损坏、纯图版都走这里：告诉验收人「有文件但读不出内容」，别让它当空文件判死 */
      return { ...base, kind: 'other', chars: null, head: '', error: (e && e.message) || '读不出内容' };
    }
  }

  const imgExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
  if (imgExt.includes(ext)) {
    return { ...base, kind: 'image', chars: null, structure: '图片', head: '' };
  }
  if (ext === '.pdf') {
    return { ...base, kind: 'pdf', chars: null, structure: 'PDF', head: '' };
  }
  return { ...base, kind: 'binary', chars: null, structure: ext.replace('.', '').toUpperCase() || '未知类型', head: '' };
}

function digestOffice(d) {
  if (d.kind === 'docx') {
    const blocks = Array.isArray(d.blocks) ? d.blocks : [];
    const text = blocks.map(b => (b.t === 'table'
      ? (b.rows || []).map(r => r.join(' | ')).join('\n')
      : String(b.text || ''))).join('\n');
    const heads = blocks.filter(b => b.t === 'h').map(b => b.text).slice(0, 8);
    return {
      kind: 'docx', chars: text.length,
      structure: [
        `${blocks.filter(b => b.t === 'h').length} 个标题`,
        `${blocks.filter(b => b.t === 'p' || b.t === 'li').length} 段`,
        `${blocks.filter(b => b.t === 'table').length} 张表`,
        heads.length ? '标题：' + heads.join(' / ') : ''
      ].filter(Boolean).join('，'),
      head: clipHead(text)
    };
  }
  if (d.kind === 'xlsx') {
    const sheets = Array.isArray(d.sheets) ? d.sheets : [];
    const brief = sheets.map(s => `${s.name}(${(s.rows || []).length}×${Math.max(0, ...(s.rows || []).map(r => r.length))})`);
    const sample = sheets.map(s => {
      const rows = (s.rows || []).slice(0, 3).map(r => r.join(' | '));
      return `[${s.name}]\n${rows.join('\n')}`;
    }).join('\n');
    const totalRows = sheets.reduce((a, s) => a + (s.rows || []).length, 0);
    return {
      kind: 'xlsx', chars: totalRows,
      structure: `${sheets.length} 个工作表：${brief.join('、')}`,
      head: clipHead(sample)
    };
  }
  if (d.kind === 'pptx') {
    const slides = Array.isArray(d.slides) ? d.slides : [];
    return {
      kind: 'pptx', chars: slides.length,
      structure: `${slides.length} 页幻灯片`,
      head: clipHead(slides.map((s, i) => `${i + 1}. ${s.title || '（无标题）'}${s.lines && s.lines.length ? ' — ' + s.lines.slice(0, 2).join(' / ') : ''}`).join('\n'))
    };
  }
  return { kind: 'other', chars: null, head: '' };
}

/** 一批交付物：按先后顺序摘，最多 8 个（再多验收人也看不过来） */
export function digestFiles(root, rels, since) {
  const list = (Array.isArray(rels) ? rels : []).map(String).filter(Boolean).slice(0, LIMITS.files);
  return list.map(r => digestFile(root, r, since));
}

export { TEXT_EXT, OFFICE_EXT };
