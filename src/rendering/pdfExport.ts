import { decodePng, splitRgbAndAlpha } from './png';
import { buildSinglePageImagePdf } from './pdfWriter';

/**
 * Converts a `data:image/png;base64,...` string (as produced by the preview
 * webview's canvas rasterizer — see webviews/media/previewMain.ts) into a
 * single-page PDF that embeds it. This is the bridge between "we already
 * have PNG export working" and "PDF export ships too", without needing a
 * second rendering path or a headless browser.
 */
export function pngDataUrlToPdf(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!match) {
    throw new Error('Expected a PNG data URL for PDF conversion.');
  }
  const pngBuffer = Buffer.from(match[1], 'base64');
  const decoded = decodePng(pngBuffer);
  const { rgb, alpha } = splitRgbAndAlpha(decoded);
  return buildSinglePageImagePdf({ widthPx: decoded.width, heightPx: decoded.height, rgb, alpha });
}
