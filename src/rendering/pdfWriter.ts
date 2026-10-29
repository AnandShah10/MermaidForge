import { deflateSync } from 'zlib';

/**
 * Builds a minimal, valid single-page PDF that embeds one raster image
 * filling the page — exactly what "export the current diagram as a PDF"
 * needs, without pulling in a headless browser (Puppeteer/Playwright) or a
 * full PDF library for one feature. The tradeoff is explicit: this produces
 * a raster PDF (the diagram is one embedded image). This is the FALLBACK path;
 * the exporter prefers buildSinglePageVectorPdf (below) and only falls back
 * here when the SVG cannot be converted.
 *
 * PDF object layout:
 *   1: Catalog        4: Content stream ("draw the image full-page")
 *   2: Pages          5: Image XObject (DeviceRGB, FlateDecode)
 *   3: Page            6: SMask XObject (DeviceGray, FlateDecode) — only if alpha is present
 */
export interface PdfImageInput {
  widthPx: number;
  heightPx: number;
  rgb: Buffer; // width*height*3 bytes, row-major
  alpha: Buffer | null; // width*height bytes, or null for a fully-opaque image
}

function buildIndirectObject(objNumber: number, body: Buffer | string): Buffer {
  const head = Buffer.from(`${objNumber} 0 obj\n`, 'latin1');
  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
  const tail = Buffer.from('\nendobj\n', 'latin1');
  return Buffer.concat([head, bodyBuf, tail]);
}

function buildStreamObject(objNumber: number, dict: string, streamData: Buffer): Buffer {
  const head = Buffer.from(`${objNumber} 0 obj\n${dict}\nstream\n`, 'latin1');
  const tail = Buffer.from('\nendstream\nendobj\n', 'latin1');
  return Buffer.concat([head, streamData, tail]);
}

export function buildSinglePageImagePdf(input: PdfImageInput): Buffer {
  const { widthPx, heightPx, rgb, alpha } = input;
  const rgbCompressed = deflateSync(rgb);
  const alphaCompressed = alpha ? deflateSync(alpha) : null;

  const hasAlpha = alphaCompressed !== null;
  const imageObjNum = 5;
  const smaskObjNum = 6;

  const objects: Buffer[] = [];

  // 1: Catalog
  objects.push(buildIndirectObject(1, '<< /Type /Catalog /Pages 2 0 R >>'));

  // 2: Pages
  objects.push(buildIndirectObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));

  // 3: Page — MediaBox uses pixel dimensions as PDF points (72 dpi assumed);
  // good enough for "open and view/print", not a print-calibrated export.
  objects.push(
    buildIndirectObject(
      3,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPx} ${heightPx}] ` +
        `/Resources << /XObject << /Im0 ${imageObjNum} 0 R >> >> /Contents 4 0 R >>`,
    ),
  );

  // 4: Content stream — draw the image scaled to exactly fill the page.
  const contentStream = Buffer.from(`q\n${widthPx} 0 0 ${heightPx} 0 0 cm\n/Im0 Do\nQ`, 'latin1');
  objects.push(buildStreamObject(4, `<< /Length ${contentStream.length} >>`, contentStream));

  // 5: Image XObject
  const imageDictParts = [
    '<< /Type /XObject',
    '/Subtype /Image',
    `/Width ${widthPx}`,
    `/Height ${heightPx}`,
    '/ColorSpace /DeviceRGB',
    '/BitsPerComponent 8',
    '/Filter /FlateDecode',
    `/Length ${rgbCompressed.length}`,
  ];
  if (hasAlpha) imageDictParts.push(`/SMask ${smaskObjNum} 0 R`);
  imageDictParts.push('>>');
  objects.push(buildStreamObject(imageObjNum, imageDictParts.join(' '), rgbCompressed));

  // 6: SMask (alpha channel), only when the source image had one.
  if (hasAlpha) {
    const smaskDict =
      `<< /Type /XObject /Subtype /Image /Width ${widthPx} /Height ${heightPx} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alphaCompressed!.length} >>`;
    objects.push(buildStreamObject(smaskObjNum, smaskDict, alphaCompressed!));
  }

  return assemblePdf(objects);
}

/**
 * Assembles numbered objects (object N is objects[N-1]) into a complete PDF
 * with an accurate xref table — a wrong offset makes strict readers reject
 * the file even though lenient ones might still render it.
 */
export function assemblePdf(objects: Buffer[]): Buffer {
  const header = Buffer.from('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n', 'latin1');
  const offsets: number[] = [0];
  let cursor = header.length;
  const body: Buffer[] = [header];
  for (const obj of objects) {
    offsets.push(cursor);
    body.push(obj);
    cursor += obj.length;
  }
  const objectCount = objects.length + 1;
  const xrefStart = cursor;
  const xrefLines = ['xref', `0 ${objectCount}`, '0000000000 65535 f '];
  for (let i = 1; i < objectCount; i++) {
    xrefLines.push(`${offsets[i].toString().padStart(10, '0')} 00000 n `);
  }
  const xref = Buffer.from(xrefLines.join('\n') + '\n', 'latin1');
  const trailer = Buffer.from(
    `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
    'latin1',
  );
  return Buffer.concat([...body, xref, trailer]);
}

export interface PdfVectorPageInput {
  widthPt: number;
  heightPt: number;
  /** Page content stream (already in PDF operators). */
  contentStream: string;
  extGStates: Array<{ name: string; fillAlpha: number; strokeAlpha: number }>;
}

/**
 * Single-page vector PDF. Objects: 1 Catalog, 2 Pages, 3 Page, 4 content
 * (Flate), 5 Helvetica (standard-14, not embedded), 6+ ExtGState opacity
 * states. Text uses /F1 only — see svgToPdf for the font limitation.
 */
export function buildSinglePageVectorPdf(input: PdfVectorPageInput): Buffer {
  const fmtN = (n: number) => String(Math.round(n * 1000) / 1000);
  const objects: Buffer[] = [];
  const gsBase = 6;
  const gsDict = input.extGStates.length
    ? ` /ExtGState << ${input.extGStates.map((g, i) => `/${g.name} ${gsBase + i} 0 R`).join(' ')} >>`
    : '';

  objects.push(buildIndirectObject(1, '<< /Type /Catalog /Pages 2 0 R >>'));
  objects.push(buildIndirectObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  objects.push(
    buildIndirectObject(
      3,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmtN(input.widthPt)} ${fmtN(input.heightPt)}] ` +
        `/Resources << /Font << /F1 5 0 R >>${gsDict} >> /Contents 4 0 R >>`,
    ),
  );
  const compressed = deflateSync(Buffer.from(input.contentStream, 'latin1'));
  objects.push(buildStreamObject(4, `<< /Filter /FlateDecode /Length ${compressed.length} >>`, compressed));
  objects.push(buildIndirectObject(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  input.extGStates.forEach((g, i) => {
    objects.push(
      buildIndirectObject(gsBase + i, `<< /Type /ExtGState /ca ${fmtN(g.fillAlpha)} /CA ${fmtN(g.strokeAlpha)} >>`),
    );
  });
  return assemblePdf(objects);
}
