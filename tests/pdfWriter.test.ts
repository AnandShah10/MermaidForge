import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { buildSinglePageImagePdf } from '../src/rendering/pdfWriter';

function extractStream(pdf: Buffer, afterMarker: string): Buffer {
  const idx = pdf.indexOf(Buffer.from(afterMarker, 'latin1'));
  expect(idx).toBeGreaterThan(-1);
  const streamStart = pdf.indexOf(Buffer.from('stream\n', 'latin1'), idx) + 'stream\n'.length;
  const streamEnd = pdf.indexOf(Buffer.from('\nendstream', 'latin1'), streamStart);
  return pdf.subarray(streamStart, streamEnd);
}

describe('buildSinglePageImagePdf', () => {
  it('produces a file starting with the PDF header and ending with %%EOF', () => {
    const rgb = Buffer.alloc(2 * 2 * 3, 128);
    const pdf = buildSinglePageImagePdf({ widthPx: 2, heightPx: 2, rgb, alpha: null });
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(-6).toString('latin1').trim()).toBe('%%EOF');
  });

  it('embeds the correct MediaBox dimensions', () => {
    const rgb = Buffer.alloc(10 * 20 * 3, 0);
    const pdf = buildSinglePageImagePdf({ widthPx: 10, heightPx: 20, rgb, alpha: null });
    expect(pdf.toString('latin1')).toContain('/MediaBox [0 0 10 20]');
  });

  it('the image stream decompresses back to the exact RGB bytes given', () => {
    const rgb = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]); // 2x2 RGB
    const pdf = buildSinglePageImagePdf({ widthPx: 2, heightPx: 2, rgb, alpha: null });
    const stream = extractStream(pdf, '/Subtype /Image');
    expect(inflateSync(stream)).toEqual(rgb);
  });

  it('omits /SMask when there is no alpha channel', () => {
    const rgb = Buffer.alloc(4 * 3, 200);
    const pdf = buildSinglePageImagePdf({ widthPx: 2, heightPx: 2, rgb, alpha: null });
    expect(pdf.toString('latin1')).not.toContain('/SMask');
  });

  it('includes a valid SMask stream that decompresses to the given alpha bytes', () => {
    const rgb = Buffer.alloc(4 * 3, 200);
    const alpha = Buffer.from([255, 128, 64, 0]);
    const pdf = buildSinglePageImagePdf({ widthPx: 2, heightPx: 2, rgb, alpha });
    expect(pdf.toString('latin1')).toContain('/SMask 6 0 R');
    const smaskStream = extractStream(pdf, '/ColorSpace /DeviceGray');
    expect(inflateSync(smaskStream)).toEqual(alpha);
  });

  it('the xref offsets point at the correct "N 0 obj" markers', () => {
    const rgb = Buffer.alloc(2 * 2 * 3, 5);
    const pdf = buildSinglePageImagePdf({ widthPx: 2, heightPx: 2, rgb, alpha: null });
    const text = pdf.toString('latin1');
    const xrefIdx = text.indexOf('xref');
    const xrefBlock = text.slice(xrefIdx, text.indexOf('trailer'));
    const offsetLines = xrefBlock
      .split('\n')
      .filter((l) => / n $/.test(l))
      .map((l) => parseInt(l.slice(0, 10), 10));

    // Object 1 is always the Catalog, immediately after the header.
    expect(text.slice(offsetLines[0], offsetLines[0] + 6)).toBe('1 0 ob');
    // Every offset should land exactly on an "N 0 obj" marker.
    offsetLines.forEach((offset, i) => {
      expect(text.slice(offset, offset + 1)).toBe(String(i + 1));
    });
  });
});
