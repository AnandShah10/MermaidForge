import { describe, it, expect } from 'vitest';
import { deflateSync } from 'zlib';
import { decodePng, splitRgbAndAlpha } from '../src/rendering/png';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Hand-encodes a minimal, valid, non-interlaced 8-bit PNG (no filtering applied — filter type 0 for every row) purely with Node's built-in zlib, so this test has no dependency on any PNG-writing library (including our own encoder, since we don't have one). */
function encodeTestPng(width: number, height: number, colorType: 0 | 2 | 4 | 6, pixels: Buffer): Buffer {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type "None"
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = deflateSync(raw);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(colorType, 9);
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // interlace: none

  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

describe('decodePng', () => {
  it('round-trips a 2x2 RGB image with no alpha', () => {
    // 4 solid-color 1px "pixels" arranged 2x2: red, green, blue, white.
    const pixels = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const png = encodeTestPng(2, 2, 2, pixels);
    const decoded = decodePng(png);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(2);
    expect(decoded.channels).toBe(3);
    expect(decoded.pixels).toEqual(pixels);
  });

  it('round-trips a 2x1 RGBA image and splits alpha correctly', () => {
    const pixels = Buffer.from([255, 0, 0, 128, 0, 255, 0, 64]);
    const png = encodeTestPng(2, 1, 6, pixels);
    const decoded = decodePng(png);
    expect(decoded.channels).toBe(4);
    const { rgb, alpha } = splitRgbAndAlpha(decoded);
    expect(rgb).toEqual(Buffer.from([255, 0, 0, 0, 255, 0]));
    expect(alpha).toEqual(Buffer.from([128, 64]));
  });

  it('round-trips a grayscale image, expanding it to RGB with no alpha', () => {
    const pixels = Buffer.from([10, 200]);
    const png = encodeTestPng(2, 1, 0, pixels);
    const decoded = decodePng(png);
    const { rgb, alpha } = splitRgbAndAlpha(decoded);
    expect(rgb).toEqual(Buffer.from([10, 10, 10, 200, 200, 200]));
    expect(alpha).toBeNull();
  });

  it('throws a clear error on a bad signature', () => {
    expect(() => decodePng(Buffer.from('not a png'))).toThrow(/signature/i);
  });

  it('throws a clear error on 16-bit depth rather than misreading it', () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr.writeUInt8(16, 8);
    ihdr.writeUInt8(2, 9);
    const png = Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))]);
    expect(() => decodePng(png)).toThrow(/16-bit|bit depth/i);
  });
});
