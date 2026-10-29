import { describe, it, expect } from 'vitest';
import { parseTransform, multiplyMatrices, isIdentity, IDENTITY, parseColor, parseStyleDeclarations } from '../src/rendering/svg/svgStyle';
import { estimateTextWidth, charWidth } from '../src/rendering/svg/helveticaWidths';

const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

describe('parseTransform', () => {
  it('returns identity for empty', () => {
    expect(isIdentity(parseTransform(undefined))).toBe(true);
    expect(isIdentity(parseTransform(''))).toBe(true);
  });
  it('translate (one and two args)', () => {
    expect(parseTransform('translate(5)')).toEqual([1, 0, 0, 1, 5, 0]);
    expect(parseTransform('translate(5, 7)')).toEqual([1, 0, 0, 1, 5, 7]);
  });
  it('scale (uniform and non-uniform)', () => {
    expect(parseTransform('scale(2)')).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform('scale(2 3)')).toEqual([2, 0, 0, 3, 0, 0]);
  });
  it('rotate about origin', () => {
    const [x, y] = apply(parseTransform('rotate(90)'), 1, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
  });
  it('rotate about a centre keeps the centre fixed', () => {
    const [x, y] = apply(parseTransform('rotate(90 10 10)'), 10, 10);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(10);
  });
  it('skewX / skewY', () => {
    expect(apply(parseTransform('skewX(45)'), 0, 1)[0]).toBeCloseTo(1);
    expect(apply(parseTransform('skewY(45)'), 1, 0)[1]).toBeCloseTo(1);
  });
  it('matrix', () => {
    expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('chains left to right (translate then scale = scale applied first to points)', () => {
    const m = parseTransform('translate(10 0) scale(2)');
    expect(apply(m, 1, 0)).toEqual([12, 0]);
  });
  it('ignores malformed functions', () => {
    expect(isIdentity(parseTransform('translate(a b)'))).toBe(true);
    expect(isIdentity(parseTransform('matrix(1 2)'))).toBe(true);
  });
  it('multiplyMatrices with identity is a no-op', () => {
    expect(multiplyMatrices(IDENTITY, [1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('parseColor', () => {
  it('hex3 / hex6 / hex8', () => {
    expect(parseColor('#f00')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('#00ff00')).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(parseColor('#0000ff80')?.a).toBeCloseTo(128 / 255);
  });
  it('rgb / rgba / percent', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0,0,255,0.5)')?.a).toBe(0.5);
    expect(parseColor('rgb(100%, 0%, 0%)')?.r).toBe(1);
  });
  it('named colours (case-insensitive)', () => {
    expect(parseColor('Black')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor('white')?.r).toBe(1);
  });
  it('returns null for none / transparent / url / unknown / empty', () => {
    for (const v of ['none', 'transparent', 'url(#g)', 'notacolor', '', undefined, null]) {
      expect(parseColor(v as string)).toBeNull();
    }
  });
  it('clamps out-of-range channels', () => {
    expect(parseColor('rgb(300, -5, 0)')).toMatchObject({ r: 1, g: 0 });
  });
});

describe('parseStyleDeclarations', () => {
  it('parses declarations and lower-cases keys', () => {
    expect(parseStyleDeclarations('Fill: red; stroke-width:2')).toEqual({ fill: 'red', 'stroke-width': '2' });
  });
  it('strips !important and tolerates junk', () => {
    expect(parseStyleDeclarations('fill:red !important;;junk')).toEqual({ fill: 'red' });
    expect(parseStyleDeclarations(undefined)).toEqual({});
  });
});

describe('helvetica widths', () => {
  it('matches known AFM widths', () => {
    expect(charWidth(' ')).toBe(278);
    expect(charWidth('A')).toBe(667);
    expect(charWidth('i')).toBe(222);
    expect(charWidth('W')).toBe(944);
    expect(charWidth('~')).toBe(584);
  });
  it('scales with font size', () => {
    expect(estimateTextWidth('A', 10)).toBeCloseTo(6.67);
    expect(estimateTextWidth('AA', 20)).toBeCloseTo(26.68);
  });
  it('uses a fallback width for non-ASCII', () => {
    expect(charWidth('é')).toBe(556);
  });
  it('empty text has zero width', () => {
    expect(estimateTextWidth('', 12)).toBe(0);
  });
});
