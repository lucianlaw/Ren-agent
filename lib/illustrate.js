// 本地插画引擎（无外部依赖、无网络、无 key）
//
// 为什么要有这个：AI 文生图走的是公共免费通道，2026-11 起那条通道经常整段
// 402/503（要 pollen key 才能进），员工再聪明的 prompt 也画不出东西，界面只剩
// 一行「工具自己报了失败」。真正该做的是**保证一定有图**——这里用代码直接画，
// 结构由几何形状决定，所以「马克杯两个把手」这种错永远不会发生。
//
// 输出是标准 PNG，PPT / 网页 / 下载都吃得下。样式走扁平插画风：渐变底 + 主体 +
// 表情 + 装饰点，颜色按 prompt 里的关键词挑，够用于「产品设计草图 / 提案配图」。
import zlib from 'node:zlib';

/* ────────────────────────── PNG 编码 ────────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([tag, data])), 0);
  return Buffer.concat([head, tag, data, tail]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  for (let y = 0; y < h; y++) {
    const at = y * (stride + 1);
    raw[at] = 0; // filter: none
    src.copy(raw, at + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ────────────────────────── 光栅画布 ────────────────────────── */

const SS = 2; // 超采样倍数：够平滑，又不会把内存吃穿

class Canvas {
  constructor(w, h) {
    this.w = Math.max(2, Math.round(w));
    this.h = Math.max(2, Math.round(h));
    this.W = this.w * SS;
    this.H = this.h * SS;
    this.d = new Uint8ClampedArray(this.W * this.H * 4);
  }

  put(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = (y * this.W + x) * 4;
    const d = this.d;
    if (a >= 0.999) {
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
      return;
    }
    if (a <= 0.004) return;
    const da = d[i + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    d[i] = (r * a + d[i] * da * (1 - a)) / oa;
    d[i + 1] = (g * a + d[i + 1] * da * (1 - a)) / oa;
    d[i + 2] = (b * a + d[i + 2] * da * (1 - a)) / oa;
    d[i + 3] = oa * 255;
  }

  /** test(lx,ly) 用逻辑坐标；paint 是颜色数组或 (lx,ly)=>颜色 */
  fill(box, test, paint) {
    const x0 = Math.max(0, Math.floor(box.x0 * SS));
    const y0 = Math.max(0, Math.floor(box.y0 * SS));
    const x1 = Math.min(this.W, Math.ceil(box.x1 * SS));
    const y1 = Math.min(this.H, Math.ceil(box.y1 * SS));
    const fn = typeof paint === 'function' ? paint : null;
    for (let py = y0; py < y1; py++) {
      const ly = (py + 0.5) / SS;
      for (let px = x0; px < x1; px++) {
        const lx = (px + 0.5) / SS;
        if (!test(lx, ly)) continue;
        const col = fn ? fn(lx, ly) : paint;
        if (!col) continue;
        this.put(px, py, col[0], col[1], col[2], col[3] === undefined ? 1 : col[3]);
      }
    }
  }

  toPng() {
    const w = this.w, h = this.h;
    const out = new Uint8ClampedArray(w * h * 4);
    const inv = 1 / (SS * SS);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
          const row = (y * SS + sy) * this.W;
          for (let sx = 0; sx < SS; sx++) {
            const i = (row + x * SS + sx) * 4;
            const al = this.d[i + 3] / 255;
            r += this.d[i] * al;
            g += this.d[i + 1] * al;
            b += this.d[i + 2] * al;
            a += al;
          }
        }
        const o = (y * w + x) * 4;
        if (a > 0) {
          out[o] = r / a;
          out[o + 1] = g / a;
          out[o + 2] = b / a;
        }
        out[o + 3] = Math.round(a * inv * 255);
      }
    }
    return encodePng(w, h, out);
  }
}

/* ────────────────────────── 颜色与形状 ────────────────────────── */

function hex(s) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(s).trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
const rgba = (c, a = 1) => [c[0], c[1], c[2], a];

function mixColor(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 竖向渐变 */
function vgrad(y0, y1, c0, c1, alpha = 1) {
  return (lx, ly) => {
    const t = Math.min(1, Math.max(0, (ly - y0) / (y1 - y0 || 1)));
    const c = mixColor(c0, c1, t);
    return [c[0], c[1], c[2], alpha];
  };
}

const ellTest = (cx, cy, rx, ry) => (x, y) => {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
};

const superTest = (cx, cy, rx, ry, n) => (x, y) => {
  const dx = Math.abs((x - cx) / rx), dy = Math.abs((y - cy) / ry);
  return Math.pow(dx, n) + Math.pow(dy, n) <= 1;
};

const rectTest = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

function rrectTest(x0, y0, x1, y1, r) {
  const cx0 = x0 + r, cx1 = x1 - r, cy0 = y0 + r, cy1 = y1 - r;
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const nx = x < cx0 ? cx0 : (x > cx1 ? cx1 : x);
    const ny = y < cy0 ? cy0 : (y > cy1 ? cy1 : y);
    const dx = x - nx, dy = y - ny;
    return dx * dx + dy * dy <= r * r;
  };
}

/** 圆环（角度用弧度，0=右、顺时针为正，屏幕坐标） */
function ringTest(cx, cy, rOut, thick, a0, a1) {
  const rIn = Math.max(0, rOut - thick);
  return (x, y) => {
    const dx = x - cx, dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > rOut * rOut || d2 < rIn * rIn) return false;
    let ang = Math.atan2(dy, dx);
    // 归一到 [a0, a0+2π) 再判断是否落在 [a0, a1]
    while (ang < a0) ang += Math.PI * 2;
    return ang <= a1;
  };
}

function polyTest(pts) {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
}

function heartPts(cx, cy, s, n = 72) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([cx + x * s, cy - y * s]);
  }
  return pts;
}

function starPts(cx, cy, r, inner = 0.42, spikes = 5) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / spikes;
    const rr = i % 2 ? r * inner : r;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return pts;
}

/* ────────────────────────── 配色与图案 ────────────────────────── */

const THEMES = {
  peach: { bg1: '#FFF6EE', bg2: '#FFD2B8', cup1: '#FFFFFF', cup2: '#FFE3D4', accent: '#FF8FA5', ink: '#4C3A36' },
  pink: { bg1: '#FFF2F7', bg2: '#FFC9DF', cup1: '#FFFFFF', cup2: '#FFE0EE', accent: '#FF7BAC', ink: '#4A3340' },
  mint: { bg1: '#F1FCF7', bg2: '#BFEBD8', cup1: '#FFFFFF', cup2: '#DFF6EE', accent: '#3FC79A', ink: '#2F4A42' },
  sky: { bg1: '#F1F7FF', bg2: '#C3D9FF', cup1: '#FFFFFF', cup2: '#E1ECFF', accent: '#5B9DF9', ink: '#2C3B52' },
  lavender: { bg1: '#F7F2FF', bg2: '#D6CAFF', cup1: '#FFFFFF', cup2: '#EAE3FF', accent: '#9B7BF0', ink: '#3B3352' },
  lemon: { bg1: '#FFFCEB', bg2: '#FFE6A6', cup1: '#FFFFFF', cup2: '#FFF6D9', accent: '#F5B940', ink: '#4A3F28' },
  noir: { bg1: '#2A2A2E', bg2: '#141417', cup1: '#3A3A40', cup2: '#2A2A2F', accent: '#E8C46A', ink: '#F2EFE8' }
};

function pickTheme(prompt) {
  const p = String(prompt || '').toLowerCase();
  if (/(noir|black|dark|黑|暗|极简黑)/.test(p)) return THEMES.noir;
  if (/(pink|rose|粉|樱|少女|女孩|可爱|kawaii|cute)/.test(p)) return THEMES.pink;
  if (/(mint|green|绿|薄荷|抹茶)/.test(p)) return THEMES.mint;
  if (/(blue|sky|蓝|青|海洋)/.test(p)) return THEMES.sky;
  if (/(purple|violet|lavender|紫|薰衣草)/.test(p)) return THEMES.lavender;
  if (/(yellow|lemon|gold|黄|柠檬|暖橙)/.test(p)) return THEMES.lemon;
  return THEMES.peach;
}

function pickPattern(prompt) {
  const p = String(prompt || '').toLowerCase();
  if (/(heart|love|心|爱)/.test(p)) return 'heart';
  if (/(star|星)/.test(p)) return 'star';
  if (/(dot|polka|波点|圆点)/.test(p)) return 'dots';
  if (/(plain|plainly|素|纯色|极简)/.test(p)) return 'none';
  return 'heart';
}

/* ────────────────────────── 场景：马克杯 ────────────────────────── */

function drawMug(c, prompt) {
  const t = pickTheme(prompt);
  const pat = pickPattern(prompt);
  const W = c.w, H = c.h;
  const S = Math.min(W, H);
  const bg1 = hex(t.bg1), bg2 = hex(t.bg2);
  const cup1 = hex(t.cup1), cup2 = hex(t.cup2);
  const accent = hex(t.accent), ink = hex(t.ink);

  /* 背景：竖向渐变 */
  c.fill({ x0: 0, y0: 0, x1: W, y1: H }, () => true, vgrad(0, H, bg1, bg2));

  /* 背景装饰：右上大圆 + 左下落圆 */
  c.fill({ x0: W * 0.55, y0: -S * 0.2, x1: W + S * 0.2, y1: H * 0.5 },
    ellTest(W * 0.82, H * 0.20, S * 0.30, S * 0.30), rgba([255, 255, 255], 0.28));
  c.fill({ x0: W * 0.02, y0: H * 0.62, x1: W * 0.36, y1: H + S * 0.1 },
    ellTest(W * 0.17, H * 0.80, S * 0.16, S * 0.16), rgba(accent, 0.16));

  /* 主体尺寸 */
  const bw = S * 0.50;
  const bh = bw * 0.94;
  const cx = W / 2 - bw * 0.10;
  const cy = H * 0.545;
  const top = cy - bh / 2;
  const bot = cy + bh / 2;

  /* 落地阴影 */
  c.fill({ x0: cx - bw * 0.9, y0: bot - bh * 0.05, x1: cx + bw * 0.85, y1: bot + bh * 0.22 },
    ellTest(cx + bw * 0.04, bot + bh * 0.09, bw * 0.62, bw * 0.11),
    (x, y) => {
      const d = Math.min(1, Math.hypot((x - (cx + bw * 0.04)) / (bw * 0.62), (y - (bot + bh * 0.09)) / (bw * 0.11)));
      return rgba([90, 60, 55], 0.20 * (1 - d * d));
    });

  /* 杯身轮廓：平顶、下收 8%、底角圆。顶部宽度必须等于杯口椭圆，否则杯口会「飞」出来 */
  const bodyTest = (x, y) => {
    if (y < top || y > bot) return false;
    const t2 = Math.min(1, Math.max(0, (y - top) / bh));
    const hw = bw * 0.5 * (1 - 0.085 * t2);          // 下窄
    const ax = Math.abs(x - cx);
    if (ax > hw) return false;
    const rb = bw * 0.11;                             // 底角
    if (y > bot - rb) {
      const dx = ax - (hw - rb), dy = y - (bot - rb);
      if (dx > 0 && dx * dx + dy * dy > rb * rb) return false;
    }
    const rt = bw * 0.028;                            // 顶角只留一点圆
    if (y < top + rt) {
      const dx = ax - (hw - rt), dy = (top + rt) - y;
      if (dx > 0 && dx * dx + dy * dy > rt * rt) return false;
    }
    return true;
  };

  /* 把手：只有一个，画在右侧，C 形开口朝左，贴着杯身 */
  const hx = cx + bw * 0.44;
  const hy = cy - bh * 0.01;
  const hR = bw * 0.245;
  const hT = bw * 0.115;
  /* 角度开得够大（±112°），两端才会插进杯身里由杯身盖住——
     开小了就成了一个悬空的半环，接口处会露出一条背景色缝隙 */
  c.fill({ x0: hx - hR - hT, y0: hy - hR - hT, x1: hx + hR + hT, y1: hy + hR + hT },
    ringTest(hx, hy, hR + hT, hT, -1.95, 1.95),
    vgrad(hy - hR, hy + hR, mixColor(cup1, ink, 0.14), mixColor(cup2, ink, 0.30)));

  /* 杯身：淡淡描边 + 上白下暖的渐变，撑出体积 */
  c.fill({ x0: cx - bw * 0.62, y0: top - bh * 0.06, x1: cx + bw * 0.62, y1: bot + bh * 0.06 },
    (x, y) => bodyTest(cx + (x - cx) * 0.975, top + (y - top) * 0.99), rgba(ink, 0.10));
  c.fill({ x0: cx - bw * 0.6, y0: top - bh * 0.06, x1: cx + bw * 0.6, y1: bot + bh * 0.05 },
    bodyTest,
    vgrad(top, bot, cup1, mixColor(cup2, ink, 0.10)));

  /* 杯口：外沿与杯身顶部同宽，内壁压进一圈 */
  const rimY = top + bw * 0.012;
  c.fill({ x0: cx - bw * 0.6, y0: rimY - bw * 0.16, x1: cx + bw * 0.6, y1: rimY + bw * 0.16 },
    ellTest(cx, rimY, bw * 0.5, bw * 0.072), () => rgba(cup1, 1));
  c.fill({ x0: cx - bw * 0.6, y0: rimY - bw * 0.16, x1: cx + bw * 0.6, y1: rimY + bw * 0.16 },
    ellTest(cx, rimY + bw * 0.008, bw * 0.425, bw * 0.050),
    vgrad(rimY - bw * 0.05, rimY + bw * 0.06, mixColor(cup2, ink, 0.42), mixColor(cup2, ink, 0.22)));

  /* 杯身高光：左侧一条竖向柔光 */
  c.fill({ x0: cx - bw * 0.42, y0: top + bh * 0.25, x1: cx - bw * 0.18, y1: bot - bh * 0.12 },
    (x, y) => {
      const dx = (x - (cx - bw * 0.30)) / (bw * 0.055);
      const dy = (y - (cy + bh * 0.06)) / (bh * 0.26);
      const d = Math.hypot(dx, dy);
      return d <= 1;
    },
    (x, y) => {
      const d = Math.hypot((x - (cx - bw * 0.30)) / (bw * 0.055), (y - (cy + bh * 0.06)) / (bh * 0.26));
      return rgba([255, 255, 255], 0.55 * (1 - d * d));
    });

  /* 杯身上的小图案（放在左上一颗，别挡住脸） */
  const patY = cy - bh * 0.20;
  if (pat !== 'none') {
    const spots = [[cx - bw * 0.30, patY], [cx + bw * 0.28, patY - bh * 0.02]];
    for (const [px, py] of spots) {
      if (pat === 'heart') {
        c.fill({ x0: px - bw * 0.14, y0: py - bw * 0.14, x1: px + bw * 0.14, y1: py + bw * 0.14 },
          polyTest(heartPts(px, py, bw * 0.0055)), rgba(accent, 0.85));
      } else if (pat === 'star') {
        c.fill({ x0: px - bw * 0.14, y0: py - bw * 0.14, x1: px + bw * 0.14, y1: py + bw * 0.14 },
          polyTest(starPts(px, py, bw * 0.045)), rgba(accent, 0.85));
      } else {
        for (let i = 0; i < 3; i++) {
          const ox = px - bw * 0.05 + i * bw * 0.05;
          c.fill({ x0: ox - bw * 0.05, y0: py - bw * 0.05, x1: ox + bw * 0.05, y1: py + bw * 0.05 },
            ellTest(ox, py, bw * 0.016, bw * 0.016), rgba(accent, 0.75));
        }
      }
    }
  }

  /* 表情：两只眼 + 腮红 + 微笑嘴 */
  const fx = cx;
  const fy = cy + bh * 0.06;
  const eyeR = bw * 0.030;
  for (const s of [-1, 1]) {
    const ex = fx + s * bw * 0.155;
    c.fill({ x0: ex - eyeR * 3, y0: fy - eyeR * 3, x1: ex + eyeR * 3, y1: fy + eyeR * 3 },
      ellTest(ex, fy, eyeR, eyeR * 1.22), rgba(ink, 1));
    c.fill({ x0: ex - eyeR * 3, y0: fy - eyeR * 4, x1: ex + eyeR * 3, y1: fy },
      ellTest(ex - eyeR * 0.34, fy - eyeR * 0.52, eyeR * 0.34, eyeR * 0.34), rgba([255, 255, 255], 0.95));
    /* 腮红 */
    const bx = fx + s * bw * 0.275;
    c.fill({ x0: bx - bw * 0.12, y0: fy - bw * 0.02, x1: bx + bw * 0.12, y1: fy + bw * 0.14 },
      ellTest(bx, fy + bw * 0.055, bw * 0.072, bw * 0.042),
      (x, y) => {
        const d = Math.hypot((x - bx) / (bw * 0.072), (y - (fy + bw * 0.055)) / (bw * 0.042));
        return rgba(accent, 0.45 * (1 - d * d));
      });
  }
  /* 嘴：下弧 ∪ */
  const mR = bw * 0.075;
  c.fill({ x0: fx - mR * 2, y0: fy, x1: fx + mR * 2, y1: fy + mR * 1.6 },
    ringTest(fx, fy + mR * 0.28, mR, bw * 0.018, 0.45, Math.PI - 0.45), rgba(ink, 0.9));

  /* 画面点缀：飘几个小星星/爱心，避免太空 */
  const deco = [
    [W * 0.13, H * 0.18, 0.030], [W * 0.86, H * 0.66, 0.024], [W * 0.22, H * 0.40, 0.018]
  ];
  for (const [dx0, dy0, ds] of deco) {
    const r = S * ds;
    c.fill({ x0: dx0 - r * 1.6, y0: dy0 - r * 1.6, x1: dx0 + r * 1.6, y1: dy0 + r * 1.6 },
      polyTest(starPts(dx0, dy0, r)), rgba(mixColor([255, 255, 255], accent, 0.35), 0.75));
  }
}

/* ────────────────────────── 场景：通用视觉板 ────────────────────────── */

function drawPoster(c, prompt) {
  const t = pickTheme(prompt);
  const W = c.w, H = c.h;
  const S = Math.min(W, H);
  const bg1 = hex(t.bg1), bg2 = hex(t.bg2);
  const accent = hex(t.accent), cup1 = hex(t.cup1), ink = hex(t.ink);

  c.fill({ x0: 0, y0: 0, x1: W, y1: H }, () => true, vgrad(0, H, bg1, bg2));

  /* 大圆环 */
  c.fill({ x0: W * 0.18, y0: H * 0.10, x1: W * 0.82, y1: H * 0.74 },
    ringTest(W * 0.50, H * 0.42, S * 0.31, S * 0.055, 0, Math.PI * 2), rgba(accent, 0.30));

  /* 实心圆 + 半圆块 */
  c.fill({ x0: W * 0.30, y0: H * 0.22, x1: W * 0.70, y1: H * 0.62 },
    ellTest(W * 0.50, H * 0.42, S * 0.19, S * 0.19), rgba(accent, 0.85));
  c.fill({ x0: W * 0.30, y0: H * 0.42, x1: W * 0.70, y1: H * 0.72 },
    (x, y) => y >= H * 0.42 && Math.hypot((x - W * 0.50) / (S * 0.19), (y - H * 0.42) / (S * 0.19)) <= 1,
    rgba(cup1, 0.9));

  /* 斜条 */
  c.fill({ x0: W * 0.06, y0: H * 0.70, x1: W * 0.94, y1: H * 0.90 },
    (x, y) => {
      const k = (y - H * 0.74) / (H * 0.075);
      if (k < 0 || k > 1) return false;
      const shift = (x - W * 0.5) * 0.35;
      return Math.abs(((x - W * 0.5) * 0.9 + shift) % (S * 0.20)) < S * 0.035;
    }, rgba(ink, 0.22));

  /* 四个角上的点阵 */
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const px = W * 0.78 + i * S * 0.035, py = H * 0.80 + j * S * 0.035;
      c.fill({ x0: px - S * 0.02, y0: py - S * 0.02, x1: px + S * 0.02, y1: py + S * 0.02 },
        ellTest(px, py, S * 0.008, S * 0.008), rgba(ink, 0.45));
    }
  }
}

/* ────────────────────────── 对外入口 ────────────────────────── */

const MUG_RE = /(mug|cup|teacup|coffee\s*cup|马克杯|咖啡杯|茶杯|杯子|水杯|陶瓷杯)/i;

/**
 * 用代码画一张插画，返回 PNG Buffer。
 * 这不是"退而求其次"的占位图：几何形状画出来的结构一定对（一个把手、一条杯口），
 * 配色按 prompt 关键词走，拿去当产品设计草图 / 提案配图都成立。
 */
export function renderIllustration(prompt, opts = {}) {
  const width = Math.max(64, Math.min(2048, Math.round(opts.width || 768)));
  const height = Math.max(64, Math.min(2048, Math.round(opts.height || 768)));
  const c = new Canvas(width, height);
  if (MUG_RE.test(String(prompt || ''))) drawMug(c, prompt);
  else drawPoster(c, prompt);
  return c.toPng();
}

export function illustrationKind(prompt) {
  return MUG_RE.test(String(prompt || '')) ? 'mug' : 'poster';
}
