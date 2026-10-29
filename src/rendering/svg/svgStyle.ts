/** 2D affine matrix [a b c d e f] in SVG/PDF convention. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Returns m1 * m2 (apply m2 first, then m1) — the SVG transform-chain order. */
export function multiplyMatrices(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function isIdentity(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

export function parseTransform(src: string | undefined): Matrix {
  if (!src) return IDENTITY;
  let result: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const args = m[2]
      .split(/[\s,]+/)
      .filter((s) => s.length)
      .map(Number);
    if (args.some((n) => !Number.isFinite(n))) continue;
    let t: Matrix | null = null;
    switch (m[1]) {
      case 'matrix':
        if (args.length === 6) t = args as Matrix;
        break;
      case 'translate':
        if (args.length >= 1) t = [1, 0, 0, 1, args[0], args[1] ?? 0];
        break;
      case 'scale':
        if (args.length >= 1) t = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
        break;
      case 'rotate':
        if (args.length >= 1) {
          const a = (args[0] * Math.PI) / 180;
          const rot: Matrix = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
          if (args.length >= 3) {
            t = multiplyMatrices(
              multiplyMatrices([1, 0, 0, 1, args[1], args[2]], rot),
              [1, 0, 0, 1, -args[1], -args[2]],
            );
          } else t = rot;
        }
        break;
      case 'skewX':
        if (args.length >= 1) t = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        if (args.length >= 1) t = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    if (t) result = multiplyMatrices(result, t);
  }
  return result;
}

export function parseStyleDeclarations(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const k = decl.slice(0, idx).trim().toLowerCase();
    const v = decl.slice(idx + 1).replace(/!important/i, '').trim();
    if (k) out[k] = v;
  }
  return out;
}

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  darkgray: [169, 169, 169],
  silver: [192, 192, 192],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  lime: [0, 255, 0],
  navy: [0, 0, 128],
  teal: [0, 128, 128],
  maroon: [128, 0, 0],
  olive: [128, 128, 0],
  aqua: [0, 255, 255],
  fuchsia: [255, 0, 255],
  gold: [255, 215, 0],
  indigo: [75, 0, 130],
  violet: [238, 130, 238],
  beige: [245, 245, 220],
  ivory: [255, 255, 240],
  khaki: [240, 230, 140],
  salmon: [250, 128, 114],
  tomato: [255, 99, 71],
  coral: [255, 127, 80],
  crimson: [220, 20, 60],
};

export interface RgbColor {
  r: number; // 0..1
  g: number;
  b: number;
  /** 0..1, from rgba() only; callers combine with opacity attributes. */
  a: number;
}

/** Returns null for 'none', 'transparent', url(...) references, and anything unparseable. */
export function parseColor(src: string | undefined | null): RgbColor | null {
  if (!src) return null;
  const s = src.trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent' || s.startsWith('url(') || s === 'currentcolor') return null;
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return {
      r: ((n >> 16) & 255) / 255,
      g: ((n >> 8) & 255) / 255,
      b: (n & 255) / 255,
      a: m[2] ? parseInt(m[2], 16) / 255 : 1,
    };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const ch = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
      const [r, g, b] = [ch(parts[0]), ch(parts[1]), ch(parts[2])];
      let a = 1;
      if (parts[3] !== undefined) a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      if ([r, g, b, a].every(Number.isFinite)) {
        const c = (v: number) => Math.min(255, Math.max(0, v)) / 255;
        return { r: c(r), g: c(g), b: c(b), a: Math.min(1, Math.max(0, a)) };
      }
    }
    return null;
  }
  const named = NAMED[s];
  return named ? { r: named[0] / 255, g: named[1] / 255, b: named[2] / 255, a: 1 } : null;
}
