/**
 * SVG path `d` parser that normalises every command to absolute move/line/
 * cubic/close segments (the only operators the PDF writer needs).
 * Quadratics convert to cubics exactly; arcs convert via the SVG
 * endpoint-to-centre parameterisation, split into <=90 degree cubic pieces.
 */
export type PathSegment =
  | { op: 'm'; x: number; y: number }
  | { op: 'l'; x: number; y: number }
  | { op: 'c'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'h' };

interface Point {
  x: number;
  y: number;
}

export function quadraticToCubic(p0: Point, q: Point, p1: Point): PathSegment {
  return {
    op: 'c',
    x1: p0.x + (2 / 3) * (q.x - p0.x),
    y1: p0.y + (2 / 3) * (q.y - p0.y),
    x2: p1.x + (2 / 3) * (q.x - p1.x),
    y2: p1.y + (2 / 3) * (q.y - p1.y),
    x: p1.x,
    y: p1.y,
  };
}

export function arcToCubicBeziers(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x: number,
  y: number,
): PathSegment[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if ((x0 === x && y0 === y) ) return [];
  if (rx === 0 || ry === 0) return [{ op: 'l', x, y }];

  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / n;
  const alpha = (4 / 3) * Math.tan(step / 4);
  const out: PathSegment[] = [];
  let t = theta1;
  const pt = (th: number): Point => ({
    x: cx + rx * Math.cos(th) * cosPhi - ry * Math.sin(th) * sinPhi,
    y: cy + rx * Math.cos(th) * sinPhi + ry * Math.sin(th) * cosPhi,
  });
  const deriv = (th: number): Point => ({
    x: -rx * Math.sin(th) * cosPhi - ry * Math.cos(th) * sinPhi,
    y: -rx * Math.sin(th) * sinPhi + ry * Math.cos(th) * cosPhi,
  });
  for (let i = 0; i < n; i++) {
    const t2 = t + step;
    const p1 = pt(t);
    const p2 = i === n - 1 ? { x, y } : pt(t2);
    const d1 = deriv(t);
    const d2 = deriv(t2);
    out.push({
      op: 'c',
      x1: p1.x + alpha * d1.x,
      y1: p1.y + alpha * d1.y,
      x2: p2.x - alpha * d2.x,
      y2: p2.y - alpha * d2.y,
      x: p2.x,
      y: p2.y,
    });
    t = t2;
  }
  return out;
}

const ARGC: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

function tokenize(d: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) tokens.push(m[1]);
    else tokens.push(parseFloat(m[2]));
  }
  return tokens;
}

/**
 * Arc flags may be written without separators ("a1 1 0 00.5.5"); handle by
 * pre-splitting the flag digits for A commands.
 */
function tokenizeWithArcFlags(d: string): Array<string | number> {
  const out: Array<string | number> = [];
  let i = 0;
  let cmd = '';
  let argIdx = 0;
  while (i < d.length) {
    const ch = d[i];
    if (/[\s,]/.test(ch)) {
      i++;
      continue;
    }
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      out.push(ch);
      cmd = ch;
      argIdx = 0;
      i++;
      continue;
    }
    if ((cmd === 'A' || cmd === 'a') && (argIdx % 7 === 3 || argIdx % 7 === 4) && (ch === '0' || ch === '1')) {
      out.push(Number(ch));
      argIdx++;
      i++;
      continue;
    }
    const m = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
    m.lastIndex = i;
    const r = m.exec(d);
    if (!r) {
      i++;
      continue;
    }
    out.push(parseFloat(r[0]));
    argIdx++;
    i = m.lastIndex;
  }
  return out;
}

export function parsePathData(d: string): PathSegment[] {
  const tokens = d.includes('a') || d.includes('A') ? tokenizeWithArcFlags(d) : tokenize(d);
  const segs: PathSegment[] = [];
  let i = 0;
  let cmd = '';
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastCubicCtrl: Point | null = null;
  let lastQuadCtrl: Point | null = null;

  const next = (): number => tokens[i++] as number;
  const hasNumbers = (n: number): boolean => {
    for (let k = 0; k < n; k++) if (typeof tokens[i + k] !== 'number') return false;
    return true;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') {
        if (segs.length) segs.push({ op: 'h' });
        cur = { ...start };
        lastCubicCtrl = lastQuadCtrl = null;
        continue;
      }
    } else if (!cmd || cmd === 'Z' || cmd === 'z') {
      i++; // stray number
      continue;
    }
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const argc = ARGC[upper];
    if (argc === undefined || !hasNumbers(argc)) {
      // malformed: drop remaining tokens for this command
      while (i < tokens.length && typeof tokens[i] === 'number') i++;
      continue;
    }
    const ox = rel ? cur.x : 0;
    const oy = rel ? cur.y : 0;
    let newCubic: Point | null = null;
    let newQuad: Point | null = null;

    switch (upper) {
      case 'M': {
        const x = next() + ox;
        const y = next() + oy;
        segs.push({ op: 'm', x, y });
        cur = { x, y };
        start = { x, y };
        cmd = rel ? 'l' : 'L'; // implicit repeats are lineto
        break;
      }
      case 'L': {
        const x = next() + ox;
        const y = next() + oy;
        segs.push({ op: 'l', x, y });
        cur = { x, y };
        break;
      }
      case 'H': {
        const x = next() + ox;
        segs.push({ op: 'l', x, y: cur.y });
        cur = { x, y: cur.y };
        break;
      }
      case 'V': {
        const y = next() + oy;
        segs.push({ op: 'l', x: cur.x, y });
        cur = { x: cur.x, y };
        break;
      }
      case 'C': {
        const x1 = next() + ox, y1 = next() + oy, x2 = next() + ox, y2 = next() + oy, x = next() + ox, y = next() + oy;
        segs.push({ op: 'c', x1, y1, x2, y2, x, y });
        newCubic = { x: x2, y: y2 };
        cur = { x, y };
        break;
      }
      case 'S': {
        const x2 = next() + ox, y2 = next() + oy, x = next() + ox, y = next() + oy;
        const x1 = lastCubicCtrl ? 2 * cur.x - lastCubicCtrl.x : cur.x;
        const y1 = lastCubicCtrl ? 2 * cur.y - lastCubicCtrl.y : cur.y;
        segs.push({ op: 'c', x1, y1, x2, y2, x, y });
        newCubic = { x: x2, y: y2 };
        cur = { x, y };
        break;
      }
      case 'Q': {
        const qx = next() + ox, qy = next() + oy, x = next() + ox, y = next() + oy;
        segs.push(quadraticToCubic(cur, { x: qx, y: qy }, { x, y }));
        newQuad = { x: qx, y: qy };
        cur = { x, y };
        break;
      }
      case 'T': {
        const x = next() + ox, y = next() + oy;
        const q: Point = lastQuadCtrl ? { x: 2 * cur.x - lastQuadCtrl.x, y: 2 * cur.y - lastQuadCtrl.y } : { ...cur };
        segs.push(quadraticToCubic(cur, q, { x, y }));
        newQuad = q;
        cur = { x, y };
        break;
      }
      case 'A': {
        const rx = next(), ry = next(), rot = next(), large = next(), sweep = next();
        const x = next() + ox, y = next() + oy;
        segs.push(...arcToCubicBeziers(cur.x, cur.y, rx, ry, rot, large !== 0, sweep !== 0, x, y));
        cur = { x, y };
        break;
      }
    }
    lastCubicCtrl = newCubic;
    lastQuadCtrl = newQuad;
  }
  return segs;
}
