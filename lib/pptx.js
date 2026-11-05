/**
 * 零依赖 PPTX 生成器（v2）。
 *
 * v1 只会「标题 + 要点」，插不了图、没有版式，做出来是白底黑字的文档搬运。
 * v2 补齐三件事：
 *   1. 版式：封面 / 章节 / 要点 / 卡片 / 图文分栏 / 满版图 / 表格 / 条形图 / 大数字 / 流程 / 引言 / 结尾
 *   2. 图片：真 p:pic 嵌入（可自动按框裁切、圆角），素材由 find_image 或用户附件提供
 *   3. 主题：五套配色，颜色、留白、字号层级统一由主题给，模型只管内容
 *
 * 仍然零依赖：整个 pptx 就是 zip + 一堆固定骨架 + 每页一份 slide XML，
 * 骨架（母版/版式/主题）是从一份标准空白 pptx 抠出来的静态文件，在 pptx-tpl/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(HERE, 'pptx-tpl');

/* 1 px = 9525 EMU；画布 1280×720 px（16:9） */
const PX = 9525;
const W = 1280 * PX;
const H = 720 * PX;
const M = 88;              // 左右安全边距（px）
const CW = 1280 - M * 2;   // 内容宽度

const FONT = 'Microsoft YaHei';
const FONT_NUM = 'Segoe UI';

/* ── 主题：一套颜色 + 一点排版尺度 ── */
export const THEMES = {
  paper: {
    bg: 'FBF8F3', ink: '1F1B17', body: '4A423A', mute: '8C8279', line: 'E6DCCE',
    accent: 'B4562F', accent2: '2E6B57', tint: 'F3E9DD', soft: 'FFFFFF'
  },
  ink: {
    bg: 'FFFFFF', ink: '101828', body: '475467', mute: '98A2B3', line: 'EAECF0',
    accent: '1F4E79', accent2: 'B54708', tint: 'EEF3F9', soft: 'F9FAFB'
  },
  forest: {
    bg: 'F7FAF7', ink: '14261C', body: '41524A', mute: '82938A', line: 'DCE7DF',
    accent: '2E6B4F', accent2: 'B4652F', tint: 'E8F0EA', soft: 'FFFFFF'
  },
  plum: {
    bg: 'FCF9FB', ink: '231620', body: '4E3B49', mute: '94818E', line: 'EBDFE7',
    accent: '8A2F5C', accent2: '2F5F8A', tint: 'F5E9F0', soft: 'FFFFFF'
  },
  mono: {
    bg: 'FAFAFA', ink: '171717', body: '444444', mute: '8C8C8C', line: 'E5E5E5',
    accent: '1F1F1F', accent2: 'B45309', tint: 'F1F1F1', soft: 'FFFFFF'
  }
};
const THEME_KEYS = Object.keys(THEMES);

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* 模型经常把 md 语法带进来：**粗体**、- 列表、### 标题。清掉，别让符号上台面 */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^\s{0,3}[-*·•]\s+/, '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 估算文字宽度与行数：版式里很多"高度"必须跟着文字走，不然单行标题会顶出一条大缝。
   中文字宽 ≈ 字号，英文数字 ≈ 0.55 字号（1pt = 1.333px） */
function textWidthPx(s, sz) {
  const px = sz / 100 * 1.3333;
  let w = 0;
  for (const ch of String(s || '')) w += /[\u2E80-\uFFFF]/.test(ch) ? px : px * 0.56;
  return w;
}
const estLines = (s, sz, boxW) => Math.max(1, Math.ceil(textWidthPx(s, sz) / Math.max(60, boxW - 6)));
const lineH = sz => (sz / 100 * 1.3333) * 1.35;


/* 所有坐标一律用 px 传进来，这里统一换成 EMU —— 只在最底层换一次，避免上层漏乘 */
const XF = (x, y, w, h) => `<a:xfrm><a:off x="${Math.round(x * PX)}" y="${Math.round(y * PX)}"/>`
  + `<a:ext cx="${Math.round(w * PX)}" cy="${Math.round(h * PX)}"/></a:xfrm>`;

function run(text, { sz = 1600, color = '000000', bold = false, font = FONT, spc = 0 } = {}) {
  return `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${sz}"${bold ? ' b="1"' : ''}`
    + `${spc ? ` spc="${spc}"` : ''} dirty="0">`
    + `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
    + `<a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/>`
    + `</a:rPr><a:t xml:space="preserve">${esc(text)}</a:t></a:r>`;
}

/**
 * 一个段落。opts:
 *   sz 字号(1/100 pt)  color 颜色  bold 加粗  algn 对齐
 *   lnSpc 行距(百分比×1000)  spcBef 段前(pt×100)  marL/indent 缩进
 *   bullet 字符（null 表示无项目符号）  bulletColor
 */
function para(text, opts = {}) {
  const {
    sz = 1600, color = '000000', bold = false, algn = 'l',
    lnSpc = 100000, spcBef = 0, lvl = 0, bullet = null, bulletColor,
    marL = 0, indent = 0, font = FONT
  } = opts;
  const pPr = `<a:pPr algn="${algn}" marL="${marL}" indent="${indent}" lvl="${lvl}">`
    + `<a:lnSpc><a:spcPct val="${lnSpc}"/></a:lnSpc>`
    + (spcBef ? `<a:spcBef><a:spcPts val="${spcBef}"/></a:spcBef>` : '')
    + (bullet
      ? `<a:buClr><a:srgbClr val="${bulletColor || color}"/></a:buClr>`
        + `<a:buSzPct val="90000"/><a:buFont typeface="Arial"/><a:buChar char="${esc(bullet)}"/>`
      : '<a:buNone/>')
    + `</a:pPr>`;
  return `<a:p>${pPr}${text === '' ? '<a:endParaRPr lang="zh-CN"/>' : run(text, { sz, color, bold, font })}</a:p>`;
}

function textBox(id, x, y, w, h, paras, opts = {}) {
  const anchor = opts.anchor || 't';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="tb${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${XF(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + `<a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}">`
    + `<a:normAutofit/></a:bodyPr><a:lstStyle/>${paras.join('')}</p:txBody></p:sp>`;
}

/** 矩形：可圆角、半透明、描边 */
function shape(id, x, y, w, h, o = {}) {
  const {
    fill = null, alpha = null, line = null, lineW = 1, radius = 0, dash = null, geom: g = null
  } = o;
  const geom = g === 'ellipse'
    ? '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>'
    : radius
      ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(radius)}"/></a:avLst></a:prstGeom>`
      : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  const fillXml = fill
    ? `<a:solidFill><a:srgbClr val="${fill}">${alpha != null ? `<a:alpha val="${Math.round(alpha * 1000)}"/>` : ''}</a:srgbClr></a:solidFill>`
    : '<a:noFill/>';
  const lineXml = line
    ? `<a:ln w="${Math.round(lineW * PX)}" cap="flat"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill>`
      + `${dash ? `<a:prstDash val="${dash}"/>` : ''}</a:ln>`
    : '<a:ln><a:noFill/></a:ln>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="sh${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${XF(x, y, w, h)}${geom}${fillXml}${lineXml}</p:spPr>`
    + `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`;
}

const ellipse = (id, x, y, w, h, o = {}) => shape(id, x, y, w, h, { ...o, geom: 'ellipse' });

/** 图片：按框裁切（cover）或等比内缩（contain） */
function pic(id, rid, box, img, o = {}) {
  const { fit = 'cover', radius = 0 } = o;
  let { x, y, w, h } = box;
  let srcRect = '';
  if (fit === 'cover') {
    const boxA = w / h;
    const imgA = img.w / img.h;
    if (imgA > boxA) {
      const f = boxA / imgA;
      const side = Math.round((1 - f) / 2 * 100000);
      srcRect = `<a:srcRect l="${side}" r="${side}"/>`;
    } else if (imgA < boxA) {
      const f = imgA / boxA;
      const side = Math.round((1 - f) / 2 * 100000);
      srcRect = `<a:srcRect t="${side}" b="${side}"/>`;
    }
  } else {
    const imgA = img.w / img.h;
    const boxA = w / h;
    if (imgA > boxA) { const nh = w / imgA; y += (h - nh) / 2; h = nh; }
    else { const nw = h * imgA; x += (w - nw) / 2; w = nw; }
  }
  const geom = radius
    ? `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.round(radius)}"/></a:avLst></a:prstGeom>`
    : '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="pic${id}"/>`
    + `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rid}"/>${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${XF(x, y, w, h)}${geom}<a:ln><a:noFill/></a:ln></p:spPr></p:pic>`;
}

/** 真表格（a:tbl） */
function table(id, x, y, w, rows, o = {}) {
  const { colW, headH = 40, rowH = 38, fontSize = 1300 } = o;
  const T = o.T;
  const cols = rows[0].length;
  const widths = Array.isArray(colW) && colW.length === cols
    ? colW.map(f => Math.round(w * f))
    : Array.from({ length: cols }, () => Math.round(w / cols));
  const grid = widths.map(cw => `<a:gridCol w="${Math.round(cw * PX)}"/>`).join('');
  const body = rows.map((cells, ri) => {
    const head = ri === 0;
    const h = (head ? headH : rowH) * PX;
    const tcs = cells.map((c, ci) => {
      const fill = head ? T.accent : (ri % 2 === 0 ? T.soft : T.bg);
      const color = head ? 'FFFFFF' : T.body;
      const algn = ci === 0 ? 'l' : 'l';
      return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>`
        + para(clean(c), { sz: fontSize, color, bold: head, algn, lnSpc: 100000 })
        + `</a:txBody><a:tcPr marL="${Math.round(0.09 * PX)}" marR="${Math.round(0.09 * PX)}" anchor="ctr">`
        + `<a:lnB w="${Math.round(0.75 * PX)}"><a:solidFill><a:srgbClr val="${head ? T.accent : T.line}"/></a:solidFill></a:lnB>`
        + `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr></a:tc>`;
    }).join('');
    return `<a:tr h="${Math.round(h)}">${tcs}</a:tr>`;
  }).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="tbl${id}"/>`
    + `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${Math.round(x * PX)}" y="${Math.round(y * PX)}"/>`
    + `<a:ext cx="${Math.round(widths.reduce((a, b) => a + b, 0) * PX)}" cy="${Math.round((headH + rowH * (rows.length - 1)) * PX)}"/></p:xfrm>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">`
    + `<a:tbl><a:tblPr firstRow="1" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl>`
    + `</a:graphicData></a:graphic></p:graphicFrame>`;
}

/* ── 页面骨架 ── */
const spTree = shapes => `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
  + `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>`
  + `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`
  + shapes.filter(Boolean).join('') + `</p:spTree>`;

function slideXml(shapes, T) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" `
    + `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${T.bg}"/></a:solidFill>`
    + `<a:effectLst/></p:bgPr></p:bg>${spTree(shapes)}</p:cSld>`
    + `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/* 页码 + 页脚：只在内容页出现，封面/结尾不出。
   满版图页要传 light：灰字压在暗图上根本看不见 */
function chrome(id, T, pageNo, label, opts = {}) {
  const c = opts.light ? 'FFFFFF' : T.mute;
  const a = opts.light ? 78 : null;
  return [
    textBox(id, M, 674, 600, 22, [para(label || '', { sz: 900, color: c, spc: 40 })]),
    textBox(id + 200, 1080, 674, 112, 22, [para(String(pageNo), { sz: 900, color: c, algn: 'r', font: FONT_NUM })])
  ];
}

/* 内容页标题区：kicker + 标题 + 细线。标题行数决定细线位置，不再写死 */
function head(id, s, T, opts = {}) {
  const y0 = opts.y || 62;
  const out = [];
  let y = y0;
  if (s.kicker) {
    out.push(textBox(id, M, y, CW, 20, [para(clean(s.kicker).toUpperCase(), { sz: 1000, color: T.accent, bold: true, spc: 120 })]));
    y += 24;
  }
  const titleSz = opts.titleSz || 3000;
  const lines = estLines(clean(s.title), titleSz, CW);
  const th = Math.max(52, lines * lineH(titleSz));
  out.push(textBox(id + 1, M, y, CW, th, [para(clean(s.title), { sz: titleSz, color: T.ink, bold: true, lnSpc: 108000 })], { anchor: 'b' }));
  const ruleY = y + th + 10;
  out.push(shape(id + 2, M, ruleY, 56, 3, { fill: T.accent }));
  return { shapes: out, ruleY, contentTop: ruleY + (opts.gap || 34) };
}

/* ── 版式：封面 ── */
function layoutCover(s, T, ctx) {
  const out = [];
  const img = s.image ? ctx.img(s.image) : null;
  const textW = img ? 660 : 900;

  if (img) {
    out.push(pic(2, ctx.rid(img), { x: 1280 - 520, y: 0, w: 520, h: 720 }, img, { fit: 'cover' }));
    out.push(shape(3, 1280 - 520, 0, 520, 720, { fill: T.ink, alpha: 12 }));
  } else {
    /* 无图也不留白：一组几何装饰 */
    out.push(shape(2, 838, 96, 330, 330, { fill: T.tint, radius: 12 }));
    out.push(ellipse(3, 950, 300, 210, 210, { fill: T.accent, alpha: 18 }));
    out.push(ellipse(4, 1010, 150, 96, 96, { fill: T.accent2, alpha: 22 }));
    out.push(shape(5, 838, 500, 120, 4, { fill: T.accent }));
  }

  let y = 132;
  if (s.kicker) {
    out.push(textBox(6, M, y, textW, 20, [para(clean(s.kicker).toUpperCase(), { sz: 1000, color: T.accent, bold: true, spc: 160 })]));
    y += 30;
  }
  /* 标题底对齐：单行标题不会把下面的细线推得太远 */
  const tSz = 4600;
  const tLines = estLines(clean(s.title), tSz, textW);
  const tH = Math.max(72, tLines * lineH(tSz));
  out.push(textBox(7, M, y, textW, tH, [para(clean(s.title), { sz: tSz, color: T.ink, bold: true, lnSpc: 104000 })], { anchor: 'b' }));
  y += tH + 20;
  out.push(shape(8, M, y, 72, 4, { fill: T.accent }));
  y += 26;
  if (s.subtitle) {
    out.push(textBox(9, M, y, textW - 40, 110, [para(clean(s.subtitle), { sz: 1800, color: T.body, lnSpc: 136000 })]));
    y += 116;
  }
  if (s.meta) {
    out.push(textBox(10, M, 596, textW, 24, [para(clean(s.meta), { sz: 1100, color: T.mute, spc: 30 })]));
  }
  return out;
}

/* ── 版式：章节过渡 ── */
function layoutSection(s, T, ctx) {
  const no = clean(s.no || '').padStart(2, '0');
  return [
    shape(2, 0, 0, 1280, 720, { fill: T.tint }),
    textBox(3, M, 168, 520, 300, [para(no, { sz: 16000, color: T.accent, bold: true, font: FONT_NUM, lnSpc: 90000 })]),
    textBox(4, M, 452, 900, 70, [para(clean(s.title), { sz: 3600, color: T.ink, bold: true })]),
    s.subtitle ? textBox(5, M, 528, 900, 90, [para(clean(s.subtitle), { sz: 1500, color: T.body, lnSpc: 140000 })]) : null,
    shape(6, 0, 0, 12, 720, { fill: T.accent })
  ];
}

/* ── 版式：要点 ── */
function layoutBullets(s, T, ctx, pageNo, label) {
  const h = head(2, s, T);
  const list = (Array.isArray(s.bullets) ? s.bullets : [])
    .map(b => typeof b === 'string' ? { text: b, level: 0 } : b)
    .map(b => ({ text: clean(b.text), level: Number(b.level) || 0 }))
    .filter(b => b.text);
  /* 条目少就把段间距拉开：三条要点贴在页面上半部，是「没做完」的观感 */
  const nTop = list.filter(b => b.level === 0).length;
  const spc = nTop <= 3 ? 1600 : nTop <= 5 ? 1000 : 620;
  const paras = list.map(b => {
    const lv = Math.min(b.level, 2);
    return para(b.text, {
      sz: lv === 0 ? 1650 : 1400,
      color: lv === 0 ? T.body : T.mute,
      lnSpc: 134000,
      spcBef: lv === 0 ? spc : Math.round(spc * 0.55),
      marL: 247650 + lv * 300000,
      indent: -247650,
      bullet: lv === 0 ? '•' : '–',
      bulletColor: lv === 0 ? T.accent : T.mute
    });
  });
  /* 要点页底部留一条强调：把 s.takeaway 做成色带，避免「一页六条，读完全忘」 */
  const takeaway = s.takeaway ? 1 : 0;
  const bodyH = (takeaway ? 596 - 62 - 40 : 596) - h.contentTop;
  const out = [...h.shapes,
    /* 条目少就整块垂直居中，别让三条要点吊在页面上半截 */
    textBox(20, M, h.contentTop, CW, bodyH, paras.length ? paras : [para('', {})],
      { anchor: list.length <= 4 ? 'ctr' : 't' }),
    ...chrome(30, T, pageNo, label)
  ];
  if (takeaway) {
    out.push(shape(40, M, 604, CW, 46, { fill: T.tint, radius: 6 }));
    out.push(textBox(41, M + 20, 616, CW - 40, 24, [para(clean(s.takeaway), { sz: 1250, color: T.accent2, bold: true })]));
  }
  return out;
}

/* ── 版式：卡片（2–4 张横排） ── */
function layoutCards(s, T, ctx, pageNo, label) {
  const h = head(2, s, T);
  const cards = (s.cards || []).slice(0, 4);
  const n = Math.max(1, cards.length);
  const gap = n >= 4 ? 16 : 22;
  const cw = (CW - gap * (n - 1)) / n;
  const bandBottom = s.takeaway ? 584 : 620;
  const bandH = bandBottom - h.contentTop;

  /* 卡片高度按内容算，算完在内容区里垂直居中。
     固定拉满会让「三张卡 + 两行字」出现一大片空肚子，比留白更难看。 */
  const cwText = cw - 44;
  const need = cards.map(c => {
    const tL = estLines(clean(c.title), 1550, cwText);
    const xL = c.text ? estLines(clean(c.text), 1250, cwText) : 0;
    return (c.k ? 78 : 24) + tL * lineH(1550) + (xL ? 6 + xL * lineH(1250) : 0) + 28;
  });
  const cardH = Math.min(bandH, Math.max(196, Math.max(...need, 0)));
  const top = h.contentTop + Math.max(0, (bandH - cardH) / 2);

  const out = [...h.shapes];
  cards.forEach((c, i) => {
    const x = M + i * (cw + gap);
    out.push(shape(100 + i, x, top, cw, cardH, { fill: T.soft, radius: 8, line: T.line, lineW: 1 }));
    out.push(shape(110 + i, x, top, cw, 4, { fill: i % 2 ? T.accent2 : T.accent }));
    if (c.k) {
      out.push(textBox(120 + i, x + 22, top + 22, cwText, 44,
        [para(clean(c.k), { sz: 2600, color: T.accent, bold: true, font: FONT_NUM })]));
    }
    const textTop = top + (c.k ? 76 : 26);
    const textH = cardH - (textTop - top) - 24;
    const paras = [para(clean(c.title), { sz: 1550, color: T.ink, bold: true, lnSpc: 122000 })];
    if (c.text) paras.push(para(clean(c.text), { sz: 1250, color: T.body, lnSpc: 140000, spcBef: 500 }));
    out.push(textBox(130 + i, x + 22, textTop, cwText, textH, paras, { anchor: 'b' }));
  });
  out.push(...chrome(30, T, pageNo, label));
  if (s.takeaway) {
    out.push(shape(40, M, 604, CW, 46, { fill: T.tint, radius: 6 }));
    out.push(textBox(41, M + 20, 616, CW - 40, 24, [para(clean(s.takeaway), { sz: 1250, color: T.accent2, bold: true })]));
  }
  return out;
}

/* ── 版式：图文分栏 ── */
function layoutSplit(s, T, ctx, pageNo, label) {
  const img = s.image ? ctx.img(s.image) : null;
  if (!img) return layoutBullets(s, T, ctx, pageNo, label);
  const right = (s.side || 'r') === 'r';
  const imgW = 520;
  const imgX = right ? 1280 - M - imgW : M;
  const txtX = right ? M : M + imgW + 56;
  const txtW = CW - imgW - 56;
  const h = head(2, { ...s, title: s.title }, T, { y: 62 });

  const list = (Array.isArray(s.bullets) ? s.bullets : [])
    .map(b => typeof b === 'string' ? { text: b } : b)
    .map(b => ({ text: clean(b.text), k: b.k }));
  const paras = [];
  list.forEach(b => {
    if (!b.text) return;
    if (b.k) {
      paras.push(para(b.k, { sz: 2000, color: T.accent, bold: true, font: FONT_NUM, spcBef: 700 }));
      paras.push(para(b.text, { sz: 1300, color: T.body, lnSpc: 130000 }));
    } else {
      paras.push(para(b.text, { sz: 1450, color: T.body, lnSpc: 132000, spcBef: 800, marL: 247650, indent: -247650, bullet: '•', bulletColor: T.accent }));
    }
  });

  return [
    ...h.shapes,
    /* 图后面垫一层浅底：透明底 PNG 直接贴上去会露出棋盘格/白洞，垫了才像"产品图放在白卡上" */
    shape(6, imgX, 150, imgW, 470, { fill: T.soft, radius: 5 }),
    pic(3, ctx.rid(img), { x: imgX, y: 150, w: imgW, h: 470 }, img, { fit: 'cover', radius: 5 }),
    s.caption ? textBox(4, imgX, 628, imgW, 22, [para(clean(s.caption), { sz: 950, color: T.mute })]) : null,
    /* 文字块在内容区里垂直居中：三条要点也不用全堆在页面上半部 */
    textBox(5, txtX, 150, txtW, 470, paras, { anchor: 'ctr' }),
    ...chrome(30, T, pageNo, label)
  ];
}

/* ── 版式：满版图 ── */
function layoutImage(s, T, ctx, pageNo, label) {
  const img = s.image ? ctx.img(s.image) : null;
  if (!img) return layoutBullets(s, T, ctx, pageNo, label);
  return [
    /* 透明底 PNG 满版铺开会透出幻灯片底色，先垫一层同色系底 */
    img.alpha ? shape(1, 0, 0, 1280, 720, { fill: T.tint }) : null,
    pic(2, ctx.rid(img), { x: 0, y: 0, w: 1280, h: 720 }, img, { fit: 'cover' }),
    shape(3, 0, 400, 1280, 320, { fill: '000000', alpha: 46 }),
    textBox(4, M, 442, CW - 100, 70, [para(clean(s.title), { sz: 3200, color: 'FFFFFF', bold: true })]),
    s.subtitle ? textBox(5, M, 516, CW - 160, 60, [para(clean(s.subtitle), { sz: 1400, color: 'F2F2F2', lnSpc: 130000 })]) : null,
    s.caption ? textBox(6, M, 640, CW, 22, [para(clean(s.caption), { sz: 950, color: 'E8E8E8' })]) : null,
    ...chrome(30, T, pageNo, label, { light: true })
  ];
}

/* ── 版式：表格 ── */
function layoutTable(s, T, ctx, pageNo, label) {
  const h = head(2, s, T);
  const rows = (s.table && Array.isArray(s.table.rows)) ? [s.table.head || [], ...s.table.rows] : [];
  if (rows.length < 2) return layoutBullets(s, T, ctx, pageNo, label);
  const cols = Math.max(...rows.map(r => r.length));
  const norm = rows.map(r => Array.from({ length: cols }, (_, i) => r[i] == null ? '' : String(r[i])));
  const fontSize = cols >= 5 ? 1100 : 1200;
  /* 行高按可用高度摊开：6 行的表只占到页面一半，会显得"数据不够硬" */
  const top = h.contentTop + 4;
  const avail = (s.note ? 570 : 600) - top;
  const rowH = Math.max(34, Math.min(56, Math.floor((avail - 40) / Math.max(1, norm.length - 1))));
  const out = [...h.shapes,
    table(20, M, top, CW, norm, { T, colW: s.table.widths, fontSize, rowH }),
    ...chrome(30, T, pageNo, label)
  ];
  if (s.note) out.push(textBox(21, M, 640, CW, 24, [para(clean(s.note), { sz: 1000, color: T.mute })]));
  return out;
}

/* ── 版式：图表（条形 / 柱形，用矩形画：比 chart 部件稳，配色可控） ── */
function layoutChart(s, T, ctx, pageNo, label) {
  const h = head(2, s, T);
  const items = (s.chart && Array.isArray(s.chart.items)) ? s.chart.items.slice(0, 8) : [];
  if (!items.length) return layoutBullets(s, T, ctx, pageNo, label);
  const unit = s.chart.unit || '';
  const max = Math.max(...items.map(i => Number(i.value) || 0)) || 1;
  const noteH = s.note ? 28 : 0;
  const hi = items.findIndex(i => i.highlight);
  const out = [...h.shapes];

  /* 三条以内的数据用柱形，横向条形铺不满一页；五条以上用横向条形，标签好放 */
  if (items.length <= 4) {
    const top = h.contentTop + 24;
    const base = 596 - noteH;
    const maxH = base - top - 44;
    const slot = CW / items.length;
    const barW = Math.min(104, Math.round(slot * 0.42));
    out.push(shape(90, M, base, CW, 2, { fill: T.line }));
    items.forEach((it, i) => {
      const v = Number(it.value) || 0;
      const bh = Math.max(8, Math.round(maxH * v / max));
      const cx = M + slot * i + slot / 2;
      const isHi = it.highlight || (hi < 0 && i === items.length - 1);
      out.push(shape(100 + i * 3, cx - barW / 2, base - bh, barW, bh, { fill: isHi ? T.accent : T.tint }));
      out.push(textBox(101 + i * 3, cx - slot / 2, base - bh - 34, slot, 28,
        [para(`${clean(it.display != null ? it.display : it.value)}${unit ? ' ' + unit : ''}`,
          { sz: 1500, color: isHi ? T.accent : T.body, bold: isHi, algn: 'ctr', font: FONT_NUM })]));
      out.push(textBox(102 + i * 3, cx - slot / 2, base + 12, slot, 26,
        [para(clean(it.label), { sz: 1250, color: T.mute, algn: 'ctr' })]));
    });
  } else {
    const labelW = 210;
    const valW = 130;
    const barMax = CW - labelW - valW - 20;
    const top = h.contentTop + 6;
    const bottom = 600 - noteH;
    const rowH = Math.min(64, Math.max(34, Math.floor((bottom - top) / items.length)));
    const barH = Math.min(28, Math.round(rowH * 0.44));
    items.forEach((it, i) => {
      const y = top + i * rowH + (rowH - barH) / 2;
      const v = Number(it.value) || 0;
      const bw = Math.max(6, Math.round(barMax * v / max));
      const isHi = it.highlight || (hi < 0 && i === items.length - 1);
      out.push(textBox(100 + i * 4, M, y + (barH - 20) / 2, labelW, 24,
        [para(clean(it.label), { sz: 1300, color: T.body, algn: 'r' })]));
      out.push(shape(101 + i * 4, M + labelW + 12, y, bw, barH, { fill: isHi ? T.accent : T.tint, radius: 3 }));
      out.push(textBox(102 + i * 4, M + labelW + 12 + bw + 10, y + (barH - 20) / 2, valW, 24,
        [para(`${clean(it.display != null ? it.display : it.value)}${unit ? ' ' + unit : ''}`,
          { sz: 1250, color: isHi ? T.accent : T.mute, bold: isHi, font: FONT_NUM })]));
    });
  }

  out.push(...chrome(30, T, pageNo, label));
  if (s.note) out.push(textBox(21, M, 640, CW, 24, [para(clean(s.note), { sz: 1000, color: T.mute })]));
  return out;
}

/* ── 版式：大数字 ── */
function layoutKpi(s, T, ctx, pageNo, label) {
  const h = head(2, s, T);
  const kpis = (s.kpis || []).slice(0, 4);
  const n = Math.max(1, kpis.length);
  const gap = 24;
  const cw = (CW - gap * (n - 1)) / n;
  const cardH = 200;
  const out = [...h.shapes];
  kpis.forEach((k, i) => {
    const x = M + i * (cw + gap);
    out.push(shape(100 + i, x, h.contentTop + 4, cw, cardH, { fill: T.soft, radius: 8, line: T.line, lineW: 1 }));
    out.push(textBox(110 + i, x + 26, h.contentTop + 30, cw - 52, 64,
      [para(clean(k.value), { sz: 3400, color: T.accent, bold: true, font: FONT_NUM })]));
    out.push(textBox(120 + i, x + 26, h.contentTop + 108, cw - 52, 26,
      [para(clean(k.label), { sz: 1300, color: T.ink, bold: true })]));
    if (k.note) out.push(textBox(122 + i, x + 26, h.contentTop + 140, cw - 52, 44,
      [para(clean(k.note), { sz: 1100, color: T.mute, lnSpc: 130000 })]));
  });
  if (s.bullets && s.bullets.length) {
    const list = s.bullets.slice(0, 4).map(b => para(clean(typeof b === 'string' ? b : b.text),
      { sz: 1400, color: T.body, lnSpc: 138000, spcBef: 900, marL: 247650, indent: -247650, bullet: '•', bulletColor: T.accent }));
    out.push(textBox(20, M, h.contentTop + cardH + 34, CW, 200, list));
  }
  out.push(...chrome(30, T, pageNo, label));
  if (s.takeaway) {
    out.push(shape(40, M, 604, CW, 46, { fill: T.tint, radius: 6 }));
    out.push(textBox(41, M + 20, 616, CW - 40, 24, [para(clean(s.takeaway), { sz: 1250, color: T.accent2, bold: true })]));
  }
  return out;
}

/* ── 版式：横向流程 ── */
function layoutSteps(s, T, ctx, pageNo, label) {
  const h = head(2, s, T);
  const steps = (s.steps || []).slice(0, 5);
  const n = Math.max(1, steps.length);
  const gap = 18;
  const cw = (CW - gap * (n - 1)) / n;
  /* 流程块整体在内容区里垂直居中：靠上会显得页面没写完 */
  const blockH = 36 + 14 + 56 + 110;
  const top = h.contentTop + Math.max(0, (596 - h.contentTop - blockH) * 0.42);
  const out = [...h.shapes];
  /* 连接线 */
  out.push(shape(90, M + 20, top + 17, CW - 40, 2, { fill: T.line }));
  steps.forEach((st, i) => {
    const x = M + i * (cw + gap);
    out.push(ellipse(100 + i, x + 6, top, 36, 36, { fill: i === 0 ? T.accent : T.soft, line: i === 0 ? T.accent : T.line, lineW: 1.5 }));
    out.push(textBox(110 + i, x + 6, top + 8, 36, 22,
      [para(String(i + 1), { sz: 1200, color: i === 0 ? 'FFFFFF' : T.mute, bold: true, algn: 'ctr', font: FONT_NUM })]));
    out.push(textBox(120 + i, x + 6, top + 52, cw - 12, 28, [para(clean(st.title), { sz: 1450, color: T.ink, bold: true })]));
    if (st.text) out.push(textBox(130 + i, x + 6, top + 84, cw - 12, 120, [para(clean(st.text), { sz: 1150, color: T.body, lnSpc: 138000 })]));
  });
  out.push(...chrome(30, T, pageNo, label));
  return out;
}

/* ── 版式：引言 ── */
function layoutQuote(s, T, ctx, pageNo, label) {
  return [
    shape(2, 0, 0, 1280, 720, { fill: T.tint }),
    textBox(3, M, 150, 120, 120, [para('“', { sz: 9000, color: T.accent, bold: true })]),
    textBox(4, M, 250, CW - 120, 200, [para(clean(s.text || s.title), { sz: 2600, color: T.ink, bold: true, lnSpc: 138000 })]),
    s.by ? textBox(5, M, 470, CW - 120, 30, [para('— ' + clean(s.by), { sz: 1300, color: T.mute })]) : null,
    ...chrome(30, T, pageNo, label)
  ];
}

/* ── 版式：结尾 ── */
function layoutEnd(s, T, ctx) {
  const out = [
    shape(2, 0, 0, 1280, 720, { fill: T.tint }),
    shape(3, 0, 0, 12, 720, { fill: T.accent }),
    textBox(4, M, 218, CW, 80, [para(clean(s.title || '谢谢'), { sz: 4000, color: T.ink, bold: true })]),
    s.subtitle ? textBox(5, M, 312, CW - 200, 100, [para(clean(s.subtitle), { sz: 1500, color: T.body, lnSpc: 140000 })]) : null,
    shape(6, M, 448, 72, 4, { fill: T.accent })
  ];
  if (s.meta) out.push(textBox(7, M, 480, CW - 100, 60, [para(clean(s.meta), { sz: 1150, color: T.mute, lnSpc: 140000 })]));
  return out;
}

/* ── 汇总 ── */
const LAYOUTS = {
  cover: layoutCover,
  section: layoutSection,
  bullets: layoutBullets,
  cards: layoutCards,
  split: layoutSplit,
  image: layoutImage,
  table: layoutTable,
  chart: layoutChart,
  kpi: layoutKpi,
  steps: layoutSteps,
  quote: layoutQuote,
  end: layoutEnd
};
export const LAYOUT_NAMES = Object.keys(LAYOUTS);

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = items => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
  + `<Relationships xmlns="${REL_NS}">`
  + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('')
  + `</Relationships>`;

function contentTypes(n, exts) {
  const slides = Array.from({ length: n }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  const img = exts.map(e => `<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + img
    + `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`
    + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`
    + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`
    + `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`
    + slides
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
    + `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`
    + `</Types>`;
}

function presentation(n) {
  const ids = Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" `
    + `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" `
    + `xmlns:r="${REL}" firstSlideNum="1" saveSubsetFonts="1">`
    + `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst>`
    + `<p:sldIdLst>${ids}</p:sldIdLst>`
    + `<p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/>`
    + `<p:defaultTextStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">`
    + `<a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>`
    + `<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr>`
    + `</a:lvl1pPr></p:defaultTextStyle></p:presentation>`;
}

/* ── zip（store，不压缩）：pptx 允许未压缩条目，省掉一个 deflate 实现 ── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

export function zip(entries) {
  const now = new Date();
  const { time, date } = dosTime(now);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function coreProps(title) {
  const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" `
    + `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" `
    + `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${esc(title)}</dc:title><dc:creator>Ren Agent</dc:creator>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>`
    + `</cp:coreProperties>`;
}

function appProps(n) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n`
    + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" `
    + `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">`
    + `<Application>Ren Agent</Application><Slides>${n}</Slides><Company></Company></Properties>`;
}

/* ── 图片尺寸：只需宽高比，png / jpeg 头部就够 ── */
export function imageSize(buf) {
  try {
    if (buf.length > 26 && buf.readUInt32BE(0) === 0x89504e47) {
      const colorType = buf[25];               // 4 / 6 带 alpha：透明底，直接满版会露出底色
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: 'png', alpha: colorType === 4 || colorType === 6 };
    }
    if (buf.length > 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), ext: 'jpg' };
        }
        i += 2 + len;
      }
    }
  } catch { /* 读不出来就退化成 1:1 */ }
  return { w: 1000, h: 1000, ext: 'jpg' };
}

/**
 * 生成 pptx。
 * spec = { title, subtitle, theme, slides: [ {layout, title, ...} ] }
 * ctx.readImage(relPath) → Buffer（由调用方注入文件读取，pptx.js 不管路径沙箱）
 */
export function buildDeck(spec, opts = {}) {
  const readImage = opts.readImage || (() => null);
  const title = String(spec.title || '汇报').slice(0, 80);
  const themeKey = THEME_KEYS.includes(spec.theme) ? spec.theme : 'paper';
  const T = THEMES[themeKey];
  const rawSlides = Array.isArray(spec.slides) ? spec.slides.slice(0, 40) : [];

  /* 图片登记表：同一张图多页复用只存一份 */
  const media = [];
  const mediaIndex = new Map();
  const ctx = {
    img(p) {
      const key = String(p || '');
      if (!key) return null;
      if (mediaIndex.has(key)) return media[mediaIndex.get(key)];
      let buf = null;
      try { buf = readImage(key); } catch { buf = null; }
      if (!buf || !buf.length) return null;
      const { w, h, ext } = imageSize(buf);
      if (!w || !h) return null;
      const item = { key, w, h, ext, buf, idx: media.length + 1 };
      media.push(item);
      mediaIndex.set(key, media.length - 1);
      return item;
    },
    rid: img => `rId${img.idx + 1}`
  };

  const pages = rawSlides.map((s, i) => {
    const layout = LAYOUTS[s.layout] ? s.layout : (i === 0 && !s.layout ? 'cover' : 'bullets');
    const label = spec.footer || '';
    const shapes = LAYOUTS[layout](s, T, ctx, i + 1, label);
    return { xml: slideXml(shapes, T), imgs: media.slice() };
  });

  const exts = [...new Set(media.map(m => m.ext))];
  const entries = [
    ['[Content_Types].xml', contentTypes(pages.length, exts)],
    ['_rels/.rels', rels([
      ['rId1', 'officeDocument', 'ppt/presentation.xml'],
      ['rId2', 'metadata/core-properties', 'docProps/core.xml'],
      ['rId3', 'extended-properties', 'docProps/app.xml']
    ])],
    ['docProps/core.xml', coreProps(title)],
    ['docProps/app.xml', appProps(pages.length)],
    ['ppt/presentation.xml', presentation(pages.length)],
    ['ppt/_rels/presentation.xml.rels', rels([
      ...pages.map((_, i) => [`rId${i + 1}`, 'slide', `slides/slide${i + 1}.xml`]),
      ['rIdM', 'slideMaster', 'slideMasters/slideMaster1.xml']
    ])],
    ['ppt/slideMasters/slideMaster1.xml', fs.readFileSync(path.join(TPL, 'slideMaster1.xml'))],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([
      ['rId0', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId1', 'theme', '../theme/theme1.xml']
    ])],
    ['ppt/slideLayouts/slideLayout1.xml', fs.readFileSync(path.join(TPL, 'slideLayout1.xml'))],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([
      ['rId0', 'slideMaster', '../slideMasters/slideMaster1.xml']
    ])],
    ['ppt/theme/theme1.xml', fs.readFileSync(path.join(TPL, 'theme1.xml'))]
  ];

  /* 每页只挂自己用到的图：把所有已登记图片都挂上会让 rels 里出现无用关系 */
  pages.forEach((p, i) => {
    entries.push([`ppt/slides/slide${i + 1}.xml`, p.xml]);
    entries.push([`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels([
      ['rId0', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ...media.map(m => [`rId${m.idx + 1}`, 'image', `../media/image${m.idx}.${m.ext}`])
    ])]);
  });
  media.forEach(m => entries.push([`ppt/media/image${m.idx}.${m.ext}`, m.buf]));

  return { buffer: zip(entries), media: media.length, pages: pages.length, theme: themeKey };
}
