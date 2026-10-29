import { inflateSync } from 'zlib';

/**
 * A minimal PNG decoder covering exactly what a browser <canvas>
 * `toDataURL('image/png')` ever produces: 8-bit depth, non-interlaced,
 * color type 0 (grayscale), 2 (RGB), 4 (grayscale+alpha), or 6 (RGBA). This
 * is not a general-purpose PNG reader — it deliberately does not support
 * 16-bit depth, palette (indexed) color, or Adam7 interlacing, and throws a
 * clear error if it encounters any of those rather than silently producing
 * garbage. It exists purely to make PDF export possible without adding an
 * image-processing dependency; see rendering/pdfExport.ts.
 *
 * CRC32 checksums on each chunk are intentionally not verified: the input is
 * always our own webview's canvas output, not untrusted user data, so the
 * extra work of checksum validation wouldn't buy us anything here.
 */

export interface DecodedPng {
  width: number;
  height: number;
  /** Number of 8-bit channels per pixel: 1 (gray), 2 (gray+alpha), 3 (RGB), or 4 (RGBA). */
  channels: number;
  /** Raw, unfiltered pixel data, `width * height * channels` bytes, row-major, no filter-type bytes. */
  pixels: Buffer;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function channelsForColorType(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // RGB
    case 4:
      return 2; // grayscale + alpha
    case 6:
      return 4; // RGBA
    default:
      throw new Error(`Unsupported PNG color type ${colorType} (indexed-color PNGs are not supported).`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Reverses PNG's per-scanline filtering (spec §9) to recover raw pixel bytes. */
function unfilter(filtered: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let srcOffset = 0;

  for (let y = 0; y < height; y++) {
    const filterType = filtered[srcOffset];
    srcOffset += 1;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const raw = filtered[srcOffset + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevRowStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevRowStart + x - bpp] : 0;

      let value: number;
      switch (filterType) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + a;
          break;
        case 2:
          value = raw + b;
          break;
        case 3:
          value = raw + Math.floor((a + b) / 2);
          break;
        case 4:
          value = raw + paeth(a, b, c);
          break;
        default:
          throw new Error(`Unsupported PNG scanline filter type ${filterType}.`);
      }
      out[rowStart + x] = value & 0xff;
    }
    srcOffset += stride;
  }
  return out;
}

export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature).');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const data = buffer.subarray(dataStart, dataStart + length);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idatChunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }

    offset = dataStart + length + 4; // skip CRC
  }

  if (width === 0 || height === 0) {
    throw new Error('PNG is missing a valid IHDR chunk.');
  }
  if (bitDepth !== 8) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8-bit PNGs are supported).`);
  }
  if (interlace !== 0) {
    throw new Error('Interlaced PNGs are not supported.');
  }

  const channels = channelsForColorType(colorType);
  const compressed = Buffer.concat(idatChunks);
  const filtered = inflateSync(compressed);
  const pixels = unfilter(filtered, width, height, channels);

  return { width, height, channels, pixels };
}

/** Splits decoded pixel data into an RGB plane and an optional alpha plane, for PDF's separate image + SMask model. */
export function splitRgbAndAlpha(png: DecodedPng): { rgb: Buffer; alpha: Buffer | null } {
  const { width, height, channels, pixels } = png;
  const pixelCount = width * height;
  const rgb = Buffer.alloc(pixelCount * 3);
  const hasAlpha = channels === 2 || channels === 4;
  const alpha = hasAlpha ? Buffer.alloc(pixelCount) : null;

  for (let i = 0; i < pixelCount; i++) {
    const src = i * channels;
    if (channels === 1) {
      const g = pixels[src];
      rgb[i * 3] = g;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = g;
    } else if (channels === 2) {
      const g = pixels[src];
      rgb[i * 3] = g;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = g;
      alpha![i] = pixels[src + 1];
    } else if (channels === 3) {
      rgb[i * 3] = pixels[src];
      rgb[i * 3 + 1] = pixels[src + 1];
      rgb[i * 3 + 2] = pixels[src + 2];
    } else {
      rgb[i * 3] = pixels[src];
      rgb[i * 3 + 1] = pixels[src + 1];
      rgb[i * 3 + 2] = pixels[src + 2];
      alpha![i] = pixels[src + 3];
    }
  }

  return { rgb, alpha };
}
