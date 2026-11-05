// 零依赖 docx 写入器：手写 OOXML + store 模式 ZIP（复用 pptx.js 的 zip）。
// 支持标题 / 段落 / 要点（用 • 前缀 + 缩进，避开 numbering.xml 的兼容坑）/ 表格。
import { zip } from './pptx.js';

const esc = s => String(s ?? '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function run(text, bold) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text, { style, bold, indent, after } = {}) {
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    indent ? `<w:ind w:left="${indent}"/>` : '',
    after != null ? `<w:spacing w:after="${after}"/>` : ''
  ].join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${run(text, bold)}</w:p>`;
}

function tableXml(head, rows) {
  const cell = (t, bold) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(String(t ?? ''), { bold, after: 40 })}</w:tc>`;
  const tr = (cells, bold) => `<w:tr>${cells.map(c => cell(c, bold)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>`
    + `<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/>`
    + `<w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/>`
    + `<w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>`
    + tr(head || [], true)
    + (rows || []).map(r => tr(r || [], false)).join('')
    + `</w:tbl>` + para('', { after: 80 });
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
  + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>`
  + `<w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style>`
  + `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="200"/></w:pPr>`
  + `<w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>`
  + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>`
  + `<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>`
  + `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr>`
  + `<w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style></w:styles>`;

/**
 * spec: {
 *   title, subtitle,
 *   blocks: [
 *     { type:'heading', text, level?:1|2 },
 *     { type:'para', text },
 *     { type:'bullet', text, level?:0|1 },
 *     { type:'table', head:[], rows:[[]] }
 *   ]
 * }
 */
export function buildDocx(spec) {
  const blocks = (spec && spec.blocks || []).filter(b => b && b.type && (b.text || b.type === 'table'));
  if (!blocks.length && !(spec && spec.title)) throw new Error('内容是空的，至少给一段');

  const body = [];
  if (spec.title) body.push(para(String(spec.title), { style: 'Title', bold: true }));
  if (spec.subtitle) body.push(para(String(spec.subtitle), { after: 200 }));
  for (const b of blocks) {
    if (b.type === 'heading') {
      body.push(para(b.text, { style: b.level === 2 ? 'Heading2' : 'Heading1', bold: true }));
    } else if (b.type === 'bullet') {
      const lv = Number(b.level) || 0;
      body.push(para(`${lv ? '◦' : '•'} ${b.text}`, { indent: 360 + lv * 360, after: 40 }));
    } else if (b.type === 'table') {
      body.push(tableXml(b.head, b.rows));
    } else {
      body.push(para(b.text, { after: 100 }));
    }
  }

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:body>${body.join('')}`
    + `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
    + `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>`
    + `</w:body></w:document>`;

  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
    + `</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`;

  return {
    buffer: zip([
      ['[Content_Types].xml', ct],
      ['_rels/.rels', rels],
      ['word/document.xml', doc],
      ['word/styles.xml', STYLES],
      ['word/_rels/document.xml.rels', docRels]
    ]),
    blocks: blocks.length
  };
}
