import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { buildSinglePageVectorPdf, assemblePdf } from '../src/rendering/pdfWriter';

const build = (extra = {}) =>
  buildSinglePageVectorPdf({ widthPt: 200, heightPt: 100, contentStream: '0 0 10 10 re f', extGStates: [], ...extra });

describe('buildSinglePageVectorPdf', () => {
  it('has PDF header, EOF and a correct startxref', () => {
    const pdf = build();
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const start = parseInt(/startxref\n(\d+)/.exec(text)![1], 10);
    expect(text.slice(start, start + 4)).toBe('xref');
  });
  it('xref offsets point at "N 0 obj"', () => {
    const text = build({ extGStates: [{ name: 'GS1', fillAlpha: 0.5, strokeAlpha: 1 }] }).toString('latin1');
    const xrefAt = parseInt(/startxref\n(\d+)/.exec(text)![1], 10);
    const lines = text.slice(xrefAt).split('\n');
    const count = parseInt(lines[1].split(' ')[1], 10);
    for (let i = 1; i < count; i++) {
      const off = parseInt(lines[2 + i].slice(0, 10), 10);
      expect(text.slice(off, off + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
    }
  });
  it('sets MediaBox from the page size', () => {
    expect(build().toString('latin1')).toContain('/MediaBox [0 0 200 100]');
  });
  it('content stream round-trips through Flate', () => {
    const pdf = build({ contentStream: 'BT (Hi) Tj ET' });
    const text = pdf.toString('latin1');
    const dictAt = text.indexOf('/Filter /FlateDecode');
    const s = text.indexOf('stream\n', dictAt) + 7;
    const e = text.indexOf('\nendstream', s);
    expect(inflateSync(pdf.subarray(s, e)).toString('latin1')).toBe('BT (Hi) Tj ET');
  });
  it('declares Helvetica with WinAnsiEncoding and no embedded font file', () => {
    const t = build().toString('latin1');
    expect(t).toContain('/BaseFont /Helvetica');
    expect(t).toContain('/WinAnsiEncoding');
    expect(t).not.toContain('FontFile');
  });
  it('writes ExtGState resources only when needed', () => {
    expect(build().toString('latin1')).not.toContain('/ExtGState');
    const t = build({ extGStates: [{ name: 'GS1', fillAlpha: 0.25, strokeAlpha: 0.75 }] }).toString('latin1');
    expect(t).toContain('/ExtGState << /GS1 6 0 R >>');
    expect(t).toContain('/ca 0.25 /CA 0.75');
  });
  it('trailer Size matches object count', () => {
    expect(build().toString('latin1')).toContain('/Size 6');
  });
});

describe('assemblePdf', () => {
  it('numbers objects from 1', () => {
    const pdf = assemblePdf([Buffer.from('1 0 obj\n<< >>\nendobj\n', 'latin1')]);
    expect(pdf.toString('latin1')).toContain('/Size 2');
  });
});
