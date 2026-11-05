// 零依赖 xlsx 写入器：手写 OOXML + store 模式 ZIP（复用 pptx.js 的 zip）。
// 只做一件事：把「一叠二维表」写成 Excel 能直接打开的 .xlsx。
// 单元格用 inlineStr，不引 sharedStrings.xml——少一个部件就少一处兼容性问题。
import { zip } from './pptx.js';

const esc = s => String(s ?? '')
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* 0 -> A，25 -> Z，26 -> AA */
function colName(n) {
  let s = '';
  n = Math.floor(n);
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

const NUM_RE = /^-?\d+(\.\d+)?$/;

function sheetXml(rows) {
  const rs = rows.map((row, r) => {
    const cells = (row || []).map((v, c) => {
      if (v == null || v === '') return '';
      const ref = colName(c) + (r + 1);
      const s = String(v);
      if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      if (NUM_RE.test(s.trim())) return `<c r="${ref}"><v>${Number(s)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<cols><col min="1" max="1" width="18"/><col min="2" max="8" width="14"/></cols>`
    + `<sheetData>${rs}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>`
  + `<borders count="1"><border/></borders>`
  + `<cellStyleXfs count="1"><xf/></cellStyleXfs>`
  + `<cellXfs count="1"><xf xfId="0"/></cellXfs></styleSheet>`;

/**
 * spec: { sheets: [{ name: '表名', rows: [[单元格, ...], ...] }] }
 * 返回 { buffer, sheets, rows }
 */
export function buildXlsx(spec) {
  const sheets = (spec && spec.sheets || [])
    .map(s => ({ name: String((s && s.name) || 'Sheet').slice(0, 28), rows: (s && s.rows) || [] }))
    .filter(s => s.rows.length);
  if (!sheets.length) throw new Error('sheets 是空的，至少要一张有数据的表');

  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + sheets.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + `</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;

  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>` + sheets.map((s, i) =>
      `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + `</sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + sheets.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`;

  const entries = [
    ['[Content_Types].xml', ct],
    ['_rels/.rels', rels],
    ['xl/workbook.xml', wb],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)])
  ];
  const rows = sheets.reduce((n, s) => n + s.rows.length, 0);
  return { buffer: zip(entries), sheets: sheets.length, rows };
}
