// Office 预览：把 .docx / .xlsx / .pptx 读成浏览器能直接画的结构
//
// 为什么不用现成库：这个进程是零依赖的（部署沙箱里 npm 装不上，python 的
// python-docx / openpyxl / python-pptx 也没有），所以这里自己解 ZIP + 读 XML。
// 目标不是「还原排版」，而是让人点开就知道里面写了什么、有几张表、几页幻灯片；
// 真要排版或编辑，还是下载后用本机 Office 打开。
//
// 三个文件格式本质都是 ZIP：中央目录找条目 → inflateRaw 解压 → 扫 XML。
import fs from 'node:fs';
import zlib from 'node:zlib';

const LIMITS = {
  maxBytes: 24 * 1024 * 1024,   // 再大就别在浏览器里预览了，直接下载
  docBlocks: 400,
  sheetRows: 300,
  sheetCols: 24,
  sheets: 6,
  slides: 40
};

/* ── ZIP 读取（只支持 store / deflate，够 Office 用了）── */
function readZip(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 22) throw new Error('文件不完整');
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文件（找不到 ZIP 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff) throw new Error('暂不支持 ZIP64 格式');
  const entries = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (compSize === 0xffffffff) throw new Error('暂不支持 ZIP64 格式');
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return {
    names: () => [...entries.keys()],
    has: n => entries.has(n),
    text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const lo = e.localOff;
      if (lo + 30 > buf.length) return null;
      const nLen = buf.readUInt16LE(lo + 26);
      const xLen = buf.readUInt16LE(lo + 28);
      const start = lo + 30 + nLen + xLen;
      const data = buf.subarray(start, start + e.compSize);
      let raw;
      try {
        raw = e.method === 0 ? data : zlib.inflateRawSync(data);
      } catch {
        return null;
      }
      return raw.toString('utf8');
    }
  };
}

const unesc = s => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const tagTexts = (xml, tag) => {
  const out = [];
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'g');
  let m;
  while ((m = re.exec(xml))) out.push(unesc(m[1]));
  return out;
};

/* ── .docx ── */
function previewDocx(zip) {
  const xml = zip.text('word/document.xml');
  if (!xml) throw new Error('这个 docx 里没有正文（可能是空文件或被加密）');
  const start = xml.indexOf('<w:body');
  const end = xml.lastIndexOf('</w:body>');
  const body = start >= 0 && end > start ? xml.slice(start, end) : xml;

  const blocks = [];
  const re = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(body)) && blocks.length < LIMITS.docBlocks) {
    const chunk = m[0];
    if (chunk.startsWith('<w:tbl')) {
      const rows = [];
      const trRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
      let tr;
      while ((tr = trRe.exec(chunk)) && rows.length < 60) {
        const cells = [];
        const tcRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
        let tc;
        while ((tc = tcRe.exec(tr[0])) && cells.length < LIMITS.sheetCols) {
          cells.push(tagTexts(tc[0], 'w:t').join('').trim());
        }
        rows.push(cells);
      }
      if (rows.length) blocks.push({ t: 'table', rows });
      continue;
    }
    /* 段落 */
    let level = 0;
    const st = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(chunk);
    if (st) {
      const v = st[1];
      const h = /heading\s*([1-6])/i.exec(v) || /^([1-6])$/.exec(v);
      if (h) level = Number(h[1]);
      else if (/^(Title|标题)$/i.test(v)) level = 1;
    }
    if (!level) {
      const ol = /<w:outlineLvl\b[^>]*w:val="(\d)"/.exec(chunk);
      if (ol) level = Math.min(6, Number(ol[1]) + 1);
    }
    const isList = /<w:numPr\b/.test(chunk);
    const text = tagTexts(chunk, 'w:t').join('').replace(/[ \t]+$/g, '');
    if (!text.trim()) continue;
    blocks.push(level ? { t: 'h', level, text } : { t: isList ? 'li' : 'p', text });
  }
  if (!blocks.length) throw new Error('正文是空的');
  return { kind: 'docx', blocks };
}

/* ── .xlsx ── */
function previewXlsx(zip) {
  const ssXml = zip.text('xl/sharedStrings.xml') || '';
  const shared = [];
  if (ssXml) {
    const siRe = /<si\b[\s\S]*?<\/si>/g;
    let si;
    while ((si = siRe.exec(ssXml))) shared.push(tagTexts(si[0], 't').join(''));
  }
  const wb = zip.text('xl/workbook.xml') || '';
  const names = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map(m => unesc(m[1]));

  const files = zip.names()
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!files.length) throw new Error('这个 xlsx 里没有工作表');

  const sheets = [];
  for (let i = 0; i < files.length && sheets.length < LIMITS.sheets; i++) {
    const xml = zip.text(files[i]) || '';
    const rows = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml)) && rows.length < LIMITS.sheetRows) {
      const cells = [];
      const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRe.exec(rm[1])) && cells.length < LIMITS.sheetCols) {
        const attrs = cm[1] || '';
        const inner = cm[2] || '';
        const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1] || '';
        const col = colIndex(ref);
        const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || '';
        let v = '';
        if (type === 's') {
          const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1]);
          v = Number.isFinite(idx) ? (shared[idx] || '') : '';
        } else if (type === 'inlineStr') {
          v = tagTexts(inner, 't').join('');
        } else {
          v = unesc((/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] || '');
        }
        v = String(v).trim();
        if (col >= 0 && col < LIMITS.sheetCols) {
          while (cells.length < col) cells.push('');
          cells[col] = v;
        } else {
          cells.push(v);
        }
      }
      if (cells.some(c => c !== '')) rows.push(cells);
    }
    sheets.push({ name: names[i] || ('工作表' + (i + 1)), rows });
  }
  const hasText = sheets.some(s => s.rows.length);
  if (!hasText) throw new Error('工作表里没有可显示的内容');
  return { kind: 'xlsx', sheets };
}

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ── .pptx ── */
function previewPptx(zip) {
  const files = zip.names()
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  if (!files.length) throw new Error('这个 pptx 里没有幻灯片');
  const slides = [];
  for (const f of files.slice(0, LIMITS.slides)) {
    const xml = zip.text(f) || '';
    const paras = [];
    const pRe = /<a:p\b[\s\S]*?<\/a:p>/g;
    let pm;
    while ((pm = pRe.exec(xml))) {
      const t = tagTexts(pm[0], 'a:t').join('').trim();
      if (t) paras.push(t);
    }
    if (!paras.length) continue;
    /* 页脚那个纯数字是页码占位符（PPT 模板自带），留着像一条莫名其妙的要点 */
    if (paras.length > 1 && /^\d{1,3}$/.test(paras[paras.length - 1])) paras.pop();
    slides.push({ title: paras[0], lines: paras.slice(1) });
  }
  if (!slides.length) throw new Error('幻灯片里没有文字（可能是纯图片版）');
  return { kind: 'pptx', slides, total: files.length };
}

/* 对外唯一入口：按扩展名分派，出错就把原因说清楚（别让人对着白屏猜） */
export function previewOffice(file, ext) {
  const st = fs.statSync(file);
  if (st.size > LIMITS.maxBytes) {
    throw new Error(`文件 ${(st.size / 1024 / 1024).toFixed(1)}MB，太大不适合在线预览，请下载后用本机程序打开`);
  }
  const e = String(ext || '').toLowerCase();
  if (e === '.doc' || e === '.xls' || e === '.ppt') {
    throw new Error('这是 2003 老格式，在线预览不支持；下载后用本机 Office 打开就行');
  }
  const zip = readZip(file);
  if (e === '.docx') return previewDocx(zip);
  if (e === '.xlsx') return previewXlsx(zip);
  if (e === '.pptx') return previewPptx(zip);
  throw new Error('这种文件还不支持预览');
}

export const PREVIEW_EXTS = ['.docx', '.xlsx', '.pptx'];
