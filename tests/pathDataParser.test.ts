import { describe, it, expect } from 'vitest';
import { parsePathData, quadraticToCubic, arcToCubicBeziers, PathSegment } from '../src/rendering/svg/pathDataParser';

const last = (segs: PathSegment[]) => segs[segs.length - 1] as Extract<PathSegment, { x: number }>;

describe('parsePathData basics', () => {
  it('parses absolute M L Z', () => {
    expect(parsePathData('M 10 20 L 30 40 Z')).toEqual([
      { op: 'm', x: 10, y: 20 },
      { op: 'l', x: 30, y: 40 },
      { op: 'h' },
    ]);
  });
  it('parses relative commands', () => {
    const s = parsePathData('m10 10 l5 5 h10 v-3');
    expect(s).toEqual([
      { op: 'm', x: 10, y: 10 },
      { op: 'l', x: 15, y: 15 },
      { op: 'l', x: 25, y: 15 },
      { op: 'l', x: 25, y: 12 },
    ]);
  });
  it('treats implicit repeats after M as lineto', () => {
    expect(parsePathData('M0 0 10 0 10 10')).toEqual([
      { op: 'm', x: 0, y: 0 },
      { op: 'l', x: 10, y: 0 },
      { op: 'l', x: 10, y: 10 },
    ]);
  });
  it('treats implicit repeats after relative m as relative lineto', () => {
    const s = parsePathData('m1 1 2 2');
    expect(last(s)).toMatchObject({ op: 'l', x: 3, y: 3 });
  });
  it('handles compact number syntax like 1.5.5 and 1-2', () => {
    const s = parsePathData('M1.5.5L1-2');
    expect(s[0]).toEqual({ op: 'm', x: 1.5, y: 0.5 });
    expect(s[1]).toEqual({ op: 'l', x: 1, y: -2 });
  });
  it('handles exponents', () => {
    expect(parsePathData('M1e1 2E0')[0]).toEqual({ op: 'm', x: 10, y: 2 });
  });
  it('returns [] for empty/garbage', () => {
    expect(parsePathData('')).toEqual([]);
    expect(parsePathData('xyz')).toEqual([]);
  });
  it('close returns pen to subpath start', () => {
    const s = parsePathData('M5 5 L10 5 Z l1 1');
    expect(last(s)).toMatchObject({ x: 6, y: 6 });
  });
  it('drops malformed trailing args without throwing', () => {
    expect(() => parsePathData('M0 0 L5')).not.toThrow();
  });
});

describe('cubic and smooth commands', () => {
  it('parses C absolute', () => {
    expect(parsePathData('M0 0 C1 2 3 4 5 6')[1]).toEqual({ op: 'c', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 });
  });
  it('reflects control point for S', () => {
    const s = parsePathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0');
    expect(s[2]).toMatchObject({ op: 'c', x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 });
  });
  it('S without preceding C uses current point', () => {
    expect(parsePathData('M0 0 S5 5 10 0')[1]).toMatchObject({ x1: 0, y1: 0 });
  });
  it('relative c', () => {
    expect(parsePathData('M10 10 c1 1 2 2 3 3')[1]).toEqual({ op: 'c', x1: 11, y1: 11, x2: 12, y2: 12, x: 13, y: 13 });
  });
});

describe('quadratics', () => {
  it('converts exactly: CP = P + 2/3 (Q - P)', () => {
    const c = quadraticToCubic({ x: 0, y: 0 }, { x: 6, y: 6 }, { x: 12, y: 0 }) as Extract<PathSegment, { op: 'c' }>;
    expect(c.x1).toBeCloseTo(4);
    expect(c.y1).toBeCloseTo(4);
    expect(c.x2).toBeCloseTo(8);
    expect(c.y2).toBeCloseTo(4);
  });
  it('Q parses to a cubic', () => {
    expect(parsePathData('M0 0 Q6 6 12 0')[1].op).toBe('c');
  });
  it('T reflects the previous quadratic control point', () => {
    const s = parsePathData('M0 0 Q5 10 10 0 T20 0');
    // reflected control = (15, -10); cubic cp1 = 10 + 2/3*(15-10)
    expect(s[2]).toMatchObject({ op: 'c' });
    expect((s[2] as Extract<PathSegment, { op: 'c' }>).y1).toBeCloseTo((2 / 3) * -10);
  });
  it('quadratic curve midpoint is preserved', () => {
    const [m, c] = parsePathData('M0 0 Q10 20 20 0') as [PathSegment, Extract<PathSegment, { op: 'c' }>];
    void m;
    // cubic at t=.5: (P0 + 3C1 + 3C2 + P1)/8 ; quad at .5: y = 2*0.25*20 = 10
    const y = (0 + 3 * c.y1 + 3 * c.y2 + 0) / 8;
    expect(y).toBeCloseTo(10);
  });
});

describe('arcs', () => {
  it('zero-radius arc becomes a line', () => {
    expect(arcToCubicBeziers(0, 0, 0, 5, 0, false, true, 10, 10)).toEqual([{ op: 'l', x: 10, y: 10 }]);
  });
  it('coincident endpoints produce nothing', () => {
    expect(arcToCubicBeziers(3, 3, 5, 5, 0, false, true, 3, 3)).toEqual([]);
  });
  it('half circle splits into two <=90deg cubics ending exactly at target', () => {
    const segs = arcToCubicBeziers(0, 0, 10, 10, 0, false, true, 20, 0) as Array<Extract<PathSegment, { op: 'c' }>>;
    expect(segs).toHaveLength(2);
    expect(segs[1].x).toBeCloseTo(20);
    expect(segs[1].y).toBeCloseTo(0);
  });
  it('sweep=1 in y-down space bulges to negative y', () => {
    const segs = arcToCubicBeziers(0, 0, 10, 10, 0, false, true, 20, 0) as Array<Extract<PathSegment, { op: 'c' }>>;
    expect(segs[0].x2).toBeLessThan(20);
    // midpoint of the arc is the end of the first cubic: (10, -10)
    expect(segs[0].x).toBeCloseTo(10);
    expect(segs[0].y).toBeCloseTo(-10);
  });
  it('sweep=0 bulges the other way', () => {
    const segs = arcToCubicBeziers(0, 0, 10, 10, 0, false, false, 20, 0) as Array<Extract<PathSegment, { op: 'c' }>>;
    expect(segs[0].y).toBeCloseTo(10);
  });
  it('scales up too-small radii', () => {
    const segs = arcToCubicBeziers(0, 0, 1, 1, 0, false, true, 20, 0) as Array<Extract<PathSegment, { op: 'c' }>>;
    expect(segs[segs.length - 1].x).toBeCloseTo(20);
  });
  it('quarter circle control points use kappa', () => {
    const [c] = arcToCubicBeziers(10, 0, 10, 10, 0, false, true, 0, 10) as Array<Extract<PathSegment, { op: 'c' }>>;
    expect(c.x1).toBeCloseTo(10);
    expect(Math.abs(c.y1)).toBeCloseTo(5.5228, 3);
  });
  it('parses compact arc flags without separators', () => {
    const s = parsePathData('M0 0a10 10 0 0120 0');
    expect(last(s).x).toBeCloseTo(20);
    expect(s.length).toBeGreaterThan(1);
  });
  it('relative arc is offset by the current point', () => {
    const s = parsePathData('M5 5 a10 10 0 0 1 20 0');
    expect(last(s).x).toBeCloseTo(25);
    expect(last(s).y).toBeCloseTo(5);
  });
  it('large-arc flag selects the longer sweep', () => {
    const small = arcToCubicBeziers(0, 0, 10, 10, 0, false, true, 10, 10);
    const large = arcToCubicBeziers(0, 0, 10, 10, 0, true, true, 10, 10);
    expect(large.length).toBeGreaterThan(small.length);
  });
});
