import { describe, it, expect } from 'vitest';
import { svgToPdfContent } from '../src/rendering/svg/svgToPdf';

const wrap = (inner: string, attrs = 'viewBox="0 0 100 50"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
const content = (inner: string, attrs?: string) => svgToPdfContent(wrap(inner, attrs))!.contentStream;

describe('page geometry', () => {
  it('uses viewBox for size when width/height are missing or percentages', () => {
    const r = svgToPdfContent(wrap('', 'width="100%" viewBox="0 0 200 100"'))!;
    expect([r.widthPt, r.heightPt]).toEqual([200, 100]);
  });
  it('uses explicit width/height and scales the viewBox to fit', () => {
    const r = svgToPdfContent(wrap('', 'width="400" height="200" viewBox="0 0 200 100"'))!;
    expect([r.widthPt, r.heightPt]).toEqual([400, 200]);
    expect(r.contentStream).toContain('2 0 0 2 0 0 cm');
  });
  it('derives a missing dimension from the aspect ratio', () => {
    const r = svgToPdfContent(wrap('', 'width="300" viewBox="0 0 100 50"'))!;
    expect(r.heightPt).toBe(150);
  });
  it('offsets for a non-zero viewBox origin', () => {
    expect(content('', 'viewBox="10 20 100 50"')).toContain('1 0 0 1 -10 -20 cm');
  });
  it('flips Y first', () => {
    expect(content('').startsWith('1 0 0 -1 0 50 cm')).toBe(true);
  });
  it('returns null without an svg element or any size', () => {
    expect(svgToPdfContent('<div/>')).toBeNull();
    expect(svgToPdfContent('<svg/>')).toBeNull();
  });
  it('paints the background when requested', () => {
    const r = svgToPdfContent(wrap(''), { background: '#ff0000' })!;
    expect(r.contentStream).toContain('1 0 0 rg 0 0 100 50 re f');
  });
});

describe('shapes', () => {
  it('rect with fill', () => {
    const c = content('<rect x="1" y="2" width="30" height="10" fill="#ff0000"/>');
    expect(c).toContain('1 0 0 rg');
    expect(c).toContain('1 2 30 10 re');
    expect(c).toMatch(/\nf\n/);
  });
  it('rect fill defaults to black', () => {
    expect(content('<rect width="5" height="5"/>')).toContain('0 0 0 rg');
  });
  it('rect with stroke only', () => {
    const c = content('<rect width="5" height="5" fill="none" stroke="#00f" stroke-width="2"/>');
    expect(c).toContain('0 0 1 RG');
    expect(c).toContain('2 w');
    expect(c).toMatch(/\nS\n/);
  });
  it('fill+stroke uses B', () => {
    expect(content('<rect width="5" height="5" fill="red" stroke="blue"/>')).toMatch(/\nB\n/);
  });
  it('evenodd uses f*', () => {
    expect(content('<path d="M0 0L10 0L10 10Z" fill="red" fill-rule="evenodd"/>')).toMatch(/\nf\*\n/);
  });
  it('rounded rect emits curves', () => {
    const c = content('<rect width="20" height="10" rx="3" fill="red"/>');
    expect(c).toContain(' c');
    expect(c).not.toContain(' re');
  });
  it('rx is clamped to half the size', () => {
    expect(() => content('<rect width="4" height="4" rx="100" fill="red"/>')).not.toThrow();
  });
  it('circle becomes four cubics', () => {
    const c = content('<circle cx="10" cy="10" r="5" fill="red"/>');
    expect(c.match(/ c\n/g)!.length).toBe(4);
    expect(c).toContain('15 10 m');
  });
  it('ellipse', () => {
    expect(content('<ellipse cx="0" cy="0" rx="4" ry="2" fill="red"/>')).toContain('4 0 m');
  });
  it('line is stroke-only regardless of fill', () => {
    const c = content('<line x1="0" y1="0" x2="10" y2="10" stroke="black" fill="red"/>');
    expect(c).toMatch(/\nS\n/);
    expect(c).not.toMatch(/\nB\n/);
  });
  it('polygon closes, polyline does not', () => {
    expect(content('<polygon points="0,0 10,0 10,10" fill="red"/>')).toContain('\nh\n');
    expect(content('<polyline points="0,0 10,0 10,10" fill="none" stroke="red"/>')).not.toContain('\nh\n');
  });
  it('path data is converted', () => {
    const c = content('<path d="M0 0 L10 10" stroke="red" fill="none"/>');
    expect(c).toContain('0 0 m');
    expect(c).toContain('10 10 l');
  });
  it('skips shapes with no paint', () => {
    const c = content('<rect width="5" height="5" fill="none" stroke="none"/>');
    expect(c).not.toContain(' re');
  });
  it('skips degenerate geometry', () => {
    expect(content('<rect width="0" height="5" fill="red"/>')).not.toContain(' re');
    expect(content('<circle r="0" fill="red"/>')).not.toContain(' m\n');
  });
});

describe('style and inheritance', () => {
  it('inherits fill from a group', () => {
    expect(content('<g fill="#00ff00"><rect width="5" height="5"/></g>')).toContain('0 1 0 rg');
  });
  it('inline style overrides attributes', () => {
    expect(content('<rect width="5" height="5" fill="red" style="fill:#0000ff"/>')).toContain('0 0 1 rg');
  });
  it('display:none subtrees are skipped', () => {
    expect(content('<g style="display:none"><rect width="5" height="5"/></g>')).not.toContain(' re');
  });
  it('dash arrays are emitted', () => {
    expect(content('<path d="M0 0L9 9" stroke="red" stroke-dasharray="3 2"/>')).toContain('[3 2] 0 d');
  });
  it('odd dash arrays are doubled', () => {
    expect(content('<path d="M0 0L9 9" stroke="red" stroke-dasharray="3"/>')).toContain('[3 3] 0 d');
  });
  it('round caps/joins', () => {
    const c = content('<path d="M0 0L9 9" stroke="red" stroke-linecap="round" stroke-linejoin="round"/>');
    expect(c).toContain('1 J');
    expect(c).toContain('1 j');
  });
  it('transforms wrap in q/cm/Q', () => {
    const c = content('<g transform="translate(5 6)"><rect width="1" height="1" fill="red"/></g>');
    expect(c).toContain('q 1 0 0 1 5 6 cm');
  });
  it('skips defs, style, marker, clipPath etc.', () => {
    const c = content('<defs><rect id="a" width="9" height="9"/></defs><style>.a{fill:red}</style><marker><path d="M0 0L1 1"/></marker>');
    expect(c).not.toContain(' re');
    expect(c).not.toContain(' m\n');
  });
});

describe('opacity', () => {
  it('creates ExtGStates for fill-opacity', () => {
    const r = svgToPdfContent(wrap('<rect width="5" height="5" fill="red" fill-opacity="0.5"/>'))!;
    expect(r.extGStates).toEqual([{ name: 'GS1', fillAlpha: 0.5, strokeAlpha: 1 }]);
    expect(r.contentStream).toContain('/GS1 gs');
  });
  it('multiplies group opacity down the tree', () => {
    const r = svgToPdfContent(wrap('<g opacity="0.5"><rect width="5" height="5" fill="red" opacity="0.5"/></g>'))!;
    expect(r.extGStates[0].fillAlpha).toBeCloseTo(0.25);
  });
  it('de-duplicates identical states', () => {
    const r = svgToPdfContent(wrap('<rect width="5" height="5" opacity=".5"/><rect width="5" height="5" opacity=".5"/>'))!;
    expect(r.extGStates).toHaveLength(1);
  });
  it('rgba alpha contributes', () => {
    const r = svgToPdfContent(wrap('<rect width="5" height="5" fill="rgba(255,0,0,0.4)"/>'))!;
    expect(r.extGStates[0].fillAlpha).toBeCloseTo(0.4);
  });
  it('no ExtGState when fully opaque', () => {
    expect(svgToPdfContent(wrap('<rect width="5" height="5"/>'))!.extGStates).toEqual([]);
  });
});

describe('text', () => {
  it('emits BT/Tf/Tm/Tj/ET with a flipped text matrix', () => {
    const c = content('<text x="10" y="20" font-size="12" fill="#000">Hello</text>');
    expect(c).toContain('BT');
    expect(c).toContain('/F1 12 Tf');
    expect(c).toContain('1 0 0 -1 10 20 Tm');
    expect(c).toContain('(Hello) Tj');
    expect(c).toContain('ET');
  });
  it('centres with text-anchor middle using Helvetica widths', () => {
    // "AA" at 10pt = 13.34 wide; centred on x=50 → starts at 43.33
    expect(content('<text x="50" y="10" font-size="10" text-anchor="middle">AA</text>')).toContain('1 0 0 -1 43.33 10 Tm');
  });
  it('right-aligns with text-anchor end', () => {
    expect(content('<text x="50" y="10" font-size="10" text-anchor="end">AA</text>')).toContain('1 0 0 -1 36.66 10 Tm');
  });
  it('escapes parentheses and backslashes', () => {
    expect(content('<text y="5">a(b)c\\d</text>')).toContain('(a\\(b\\)c\\\\d) Tj');
  });
  it('maps smart punctuation to WinAnsi and unknown glyphs to ?', () => {
    const c = svgToPdfContent(wrap('<text y="5">a–b→c</text>'))!.contentStream;
    expect(c).toContain('a\u0096b?c');
  });
  it('handles tspans with their own x and dy (em units)', () => {
    const c = content('<text x="5" y="10" font-size="10"><tspan x="5" dy="1em">One</tspan><tspan x="5" dy="1em">Two</tspan></text>');
    expect(c).toContain('1 0 0 -1 5 20 Tm');
    expect(c).toContain('1 0 0 -1 5 30 Tm');
  });
  it('applies dominant-baseline middle', () => {
    expect(content('<text x="0" y="10" font-size="10" dominant-baseline="middle">x</text>')).toContain('1 0 0 -1 0 13.5 Tm');
  });
  it('skips whitespace-only text', () => {
    expect(content('<text y="5">   </text>')).not.toContain('BT');
  });
  it('inherits font-size from a group', () => {
    expect(content('<g font-size="20"><text y="5">x</text></g>')).toContain('/F1 20 Tf');
  });
  it('uses fill colour for text', () => {
    expect(content('<text y="5" fill="#ff0000">x</text>')).toContain('1 0 0 rg');
  });
});

describe('foreignObject labels', () => {
  const fo = (html: string) =>
    svgToPdfContent(wrap(`<foreignObject x="0" y="0" width="100" height="40">${html}</foreignObject>`))!;
  it('flattens HTML text, centred in the box', () => {
    const r = fo('<div xmlns="http://www.w3.org/1999/xhtml"><span>Hi</span></div>');
    expect(r.contentStream).toContain('(Hi) Tj');
    expect(r.warnings.join(' ')).toMatch(/foreignObject/);
  });
  it('splits lines on <br>', () => {
    const r = fo('<div><span>One<br/>Two</span></div>');
    expect(r.contentStream).toContain('(One) Tj');
    expect(r.contentStream).toContain('(Two) Tj');
  });
  it('honours inline colour', () => {
    expect(fo('<div><span style="color:#ff0000">Hi</span></div>').contentStream).toContain('1 0 0 rg');
  });
  it('ignores empty labels', () => {
    expect(fo('<div><span></span></div>').contentStream).not.toContain('BT');
  });
});

describe('unsupported content', () => {
  it('warns on <image> and <use>', () => {
    const r = svgToPdfContent(wrap('<image href="x.png"/><use href="#a"/>'))!;
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it('gradient fills render as none rather than black', () => {
    expect(content('<rect width="5" height="5" fill="url(#g)"/>')).not.toContain(' re');
  });
  it('does not throw on malformed input', () => {
    expect(() => svgToPdfContent('<svg viewBox="0 0 10 10"><g><rect')).not.toThrow();
  });
});

describe('dash units from computed styles', () => {
  it('accepts px-suffixed dash arrays', () => {
    expect(content('<path d="M0 0L9 9" stroke="red" stroke-dasharray="3px, 2px"/>')).toContain('[3 2] 0 d');
  });
});

describe('markers (arrowheads)', () => {
  const marker =
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse">' +
    '<path d="M 0 0 L 10 5 L 0 10 z" fill="#000000"/></marker></defs>';
  it('draws the marker at the path end, rotated to the path direction', () => {
    // heading right, end (50,10), scale 0.8 (8/10), ref (10,5): translation = (50-8, 10-4)
    const c = content(`${marker}<path d="M0 10 L50 10" stroke="red" fill="none" marker-end="url(#arrow)"/>`);
    expect(c).toContain('0.8 0 0 0.8 42 6 cm');
    expect(c).toContain('0 0 m');
    expect(c).toContain('10 5 l');
  });
  it('rotates for a downward path (angle 90deg)', () => {
    const c = content(`${marker}<path d="M10 0 L10 40" stroke="red" fill="none" marker-end="url(#arrow)"/>`);
    // rotation 90deg: (a b c d) = (0 .8 -.8 0); translation = (10,40) + R*(-8,-4) = (14,32)
    expect(c).toContain('0 0.8 -0.8 0 14 32 cm');
  });
  it('uses the curve tangent for cubic ends', () => {
    // last control point directly left of the end → heading right
    const c = content(`${marker}<path d="M0 0 C 10 20 30 10 50 10" stroke="red" fill="none" marker-end="url(#arrow)"/>`);
    expect(c).toContain('0.8 0 0 0.8 42 6 cm');
  });
  it('supports marker-start with auto-start-reverse', () => {
    const m2 = marker.replace('orient="auto"', 'orient="auto-start-reverse"');
    const c = content(`${m2}<path d="M10 10 L50 10" stroke="red" fill="none" marker-start="url(#arrow)"/>`);
    // rotated 180deg: -0.8 scale, translation = (10,10) + (8,4)
    expect(c).toContain('-0.8 0 0 -0.8 18 14 cm');
  });
  it('accepts quoted url() references as produced by getComputedStyle', () => {
    const c = content(`${marker}<path d="M0 10 L50 10" stroke="red" fill="none" style="marker-end:url(&quot;#arrow&quot;)"/>`);
    expect(c).toContain('0.8 0 0 0.8 42 6 cm');
  });
  it('ignores references to missing markers', () => {
    expect(() => content('<path d="M0 0L9 9" stroke="red" marker-end="url(#nope)"/>')).not.toThrow();
  });
  it('does not draw markers on closed shapes like rect', () => {
    const c = content(`${marker}<rect width="5" height="5" marker-end="url(#arrow)"/>`);
    expect(c).not.toContain('10 5 l');
  });
  it('markerUnits=strokeWidth scales by stroke width', () => {
    const m3 = marker.replace(' markerUnits="userSpaceOnUse"', '');
    const c = content(`${m3}<path d="M0 10 L50 10" stroke="red" stroke-width="2" fill="none" marker-end="url(#arrow)"/>`);
    expect(c).toContain('1.6 0 0 1.6');
  });
});
