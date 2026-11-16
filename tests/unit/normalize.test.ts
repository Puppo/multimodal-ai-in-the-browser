import { describe, expect, it } from 'vitest';
import {
  assertWithinPixelLimit,
  computeNormalizedDimensions,
  ImageValidationError,
  inspectImageBytes,
  MAX_IMAGE_FILE_BYTES,
} from '../../src/images/normalize';

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  return out;
}

function makePng(
  width: number,
  height: number,
  options?: { animated?: boolean },
): Uint8Array {
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8;
  ihdrData[9] = 2;

  const chunks: Uint8Array[] = [signature, makeChunk('IHDR', ihdrData)];
  if (options?.animated) {
    chunks.push(makeChunk('acTL', new Uint8Array(8)));
  }
  chunks.push(makeChunk('IDAT', new Uint8Array([1, 2, 3])));
  chunks.push(makeChunk('IEND', new Uint8Array(0)));

  const total = chunks.reduce((acc, part) => acc + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function makeJpegWithSof(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0, // SOF0
    0x00,
    0x0b, // length = 11
    0x08, // precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // components
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9, // EOI
  ]);
}

function makeWebpVp8x(
  width: number,
  height: number,
  options?: { animated?: boolean },
): Uint8Array {
  const out = new Uint8Array(30);
  const ascii = (s: string, offset: number) => {
    for (let i = 0; i < s.length; i += 1) {
      out[offset + i] = s.charCodeAt(i);
    }
  };
  const view = new DataView(out.buffer);
  ascii('RIFF', 0);
  view.setUint32(4, out.length - 8, true);
  ascii('WEBP', 8);
  ascii('VP8X', 12);
  view.setUint32(16, 10, true);
  out[20] = options?.animated ? 0x02 : 0x00;
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  out[24] = wMinus1 & 0xff;
  out[25] = (wMinus1 >> 8) & 0xff;
  out[26] = (wMinus1 >> 16) & 0xff;
  out[27] = hMinus1 & 0xff;
  out[28] = (hMinus1 >> 8) & 0xff;
  out[29] = (hMinus1 >> 16) & 0xff;
  return out;
}

describe('inspectImageBytes', () => {
  it('accepts valid static PNG, JPEG, and WebP images within limits', () => {
    const pngBytes = makePng(1280, 720);
    const png = inspectImageBytes(pngBytes, 'image/png');
    expect(png).toEqual({
      mimeType: 'image/png',
      byteLength: pngBytes.byteLength,
      headerWidth: 1280,
      headerHeight: 720,
    });

    const jpeg = inspectImageBytes(makeJpegWithSof(1600, 1200), 'image/jpeg');
    expect(jpeg.mimeType).toBe('image/jpeg');
    expect(jpeg.headerWidth).toBe(1600);
    expect(jpeg.headerHeight).toBe(1200);

    const webp = inspectImageBytes(makeWebpVp8x(800, 600), 'image/webp');
    expect(webp.mimeType).toBe('image/webp');
    expect(webp.headerWidth).toBe(800);
    expect(webp.headerHeight).toBe(600);
  });

  it('rejects empty files and files exceeding 10 MiB', () => {
    expect(() => inspectImageBytes(new Uint8Array(0), 'image/png')).toThrow(
      ImageValidationError,
    );
    const oversized = new Uint8Array(MAX_IMAGE_FILE_BYTES + 1);
    expect(() => inspectImageBytes(oversized, 'image/png')).toThrow(/10 MiB/);
  });

  it('rejects SVG, GIF, and MIME mismatches', () => {
    const svgBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    expect(() => inspectImageBytes(svgBytes, 'image/svg+xml')).toThrow(/SVG/i);
    expect(() => inspectImageBytes(svgBytes, 'image/png')).toThrow(/SVG/i);

    const gifBytes = new TextEncoder().encode('GIF89a\x01\x00\x01\x00');
    expect(() => inspectImageBytes(gifBytes, 'image/gif')).toThrow(/GIF/i);

    expect(() => inspectImageBytes(makePng(100, 100), 'image/jpeg')).toThrow(
      /does not match/,
    );
  });

  it('rejects animated PNG (APNG) and animated WebP files', () => {
    expect(() =>
      inspectImageBytes(makePng(200, 200, { animated: true }), 'image/png'),
    ).toThrow(/Animated PNG/);

    expect(() =>
      inspectImageBytes(
        makeWebpVp8x(200, 200, { animated: true }),
        'image/webp',
      ),
    ).toThrow(/Animated WebP/);
  });

  it('rejects images exceeding 16 megapixels before full decode', () => {
    expect(() => inspectImageBytes(makePng(5000, 4000), 'image/png')).toThrow(
      /16 megapixel/,
    );
    expect(() =>
      inspectImageBytes(makeJpegWithSof(4001, 4000), 'image/jpeg'),
    ).toThrow(/16 megapixel/);
  });
});

describe('computeNormalizedDimensions and pixel limits', () => {
  it('never upscales images already within 1024 px longest edge', () => {
    expect(computeNormalizedDimensions(800, 600)).toEqual({
      width: 800,
      height: 600,
      wasResized: false,
    });
    expect(computeNormalizedDimensions(1024, 768)).toEqual({
      width: 1024,
      height: 768,
      wasResized: false,
    });
  });

  it('downscales landscape and portrait images while preserving aspect ratio', () => {
    expect(computeNormalizedDimensions(1280, 853)).toEqual({
      width: 1024,
      height: 682,
      wasResized: true,
    });
    expect(computeNormalizedDimensions(1200, 2400)).toEqual({
      width: 512,
      height: 1024,
      wasResized: true,
    });
  });

  it('accepts exact 16 MP boundary and rejects above it', () => {
    expect(() => assertWithinPixelLimit(4000, 4000)).not.toThrow();
    expect(() => assertWithinPixelLimit(4001, 4000)).toThrow(/16 megapixel/);
  });
});
