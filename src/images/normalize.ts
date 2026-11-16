export type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_IMAGE_DECODED_PIXELS = 16_000_000; // 16 megapixels
export const MAX_IMAGE_LONGEST_EDGE = 1024;

export interface ImageInspectionResult {
  mimeType: SupportedImageMimeType;
  byteLength: number;
  headerWidth: number | null;
  headerHeight: number | null;
}

export interface NormalizedDimensions {
  width: number;
  height: number;
  wasResized: boolean;
}

export interface NormalizedImage {
  blob: Blob;
  mimeType: 'image/png';
  previewUrl: string;
  sourceLabel: string;
  originalMimeType: SupportedImageMimeType;
  originalByteLength: number;
  normalizedByteLength: number;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

const SUPPORTED_MIME_SET = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

function readUint16BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  if (b0 === undefined || b1 === undefined) {
    throw new ImageValidationError('Image header is truncated.');
  }
  return (b0 << 8) | b1;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  if (b0 === undefined || b1 === undefined) {
    throw new ImageValidationError('Image header is truncated.');
  }
  return b0 | (b1 << 8);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (
    b0 === undefined ||
    b1 === undefined ||
    b2 === undefined ||
    b3 === undefined
  ) {
    throw new ImageValidationError('Image header is truncated.');
  }
  return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (
    b0 === undefined ||
    b1 === undefined ||
    b2 === undefined ||
    b3 === undefined
  ) {
    throw new ImageValidationError('Image header is truncated.');
  }
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) {
      return out;
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

function looksLikeSvgOrXml(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 512);
  let text = '';
  for (let i = 0; i < limit; i += 1) {
    const b = bytes[i];
    if (b === undefined) {
      break;
    }
    // Strip UTF-8 BOM if present at byte 0..2
    if (i < 3 && (b === 0xef || b === 0xbb || b === 0xbf)) {
      continue;
    }
    text += String.fromCharCode(b);
  }
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith('<svg') || trimmed.startsWith('<?xml');
}

function detectFormatFromMagic(
  bytes: Uint8Array,
): SupportedImageMimeType | 'image/gif' | 'image/svg+xml' | null {
  if (looksLikeSvgOrXml(bytes)) {
    return 'image/svg+xml';
  }
  if (
    bytes.byteLength >= 6 &&
    (asciiAt(bytes, 0, 6) === 'GIF87a' || asciiAt(bytes, 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.byteLength >= 12 &&
    asciiAt(bytes, 0, 4) === 'RIFF' &&
    asciiAt(bytes, 8, 4) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function inspectPng(bytes: Uint8Array): { width: number; height: number } {
  let offset = 8;
  let width: number | null = null;
  let height: number | null = null;
  let sawIdat = false;

  while (offset + 8 <= bytes.byteLength) {
    const chunkLen = readUint32BE(bytes, offset);
    const chunkType = asciiAt(bytes, offset + 4, 4);
    const dataOffset = offset + 8;

    if (dataOffset + chunkLen + 4 > bytes.byteLength) {
      break;
    }

    if (chunkType === 'IHDR' && chunkLen >= 8) {
      width = readUint32BE(bytes, dataOffset);
      height = readUint32BE(bytes, dataOffset + 4);
    } else if (chunkType === 'acTL' && !sawIdat) {
      throw new ImageValidationError(
        'Animated PNG (APNG) files are not supported. Upload a static JPEG, PNG, or WebP image.',
      );
    } else if (chunkType === 'IDAT') {
      sawIdat = true;
      if (width !== null && height !== null) {
        break;
      }
    } else if (chunkType === 'IEND') {
      break;
    }

    offset = dataOffset + chunkLen + 4;
  }

  if (width === null || height === null || width <= 0 || height <= 0) {
    throw new ImageValidationError(
      'PNG image is missing valid IHDR dimension metadata.',
    );
  }

  return { width, height };
}

function isJpegSofMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function inspectJpeg(bytes: Uint8Array): {
  width: number | null;
  height: number | null;
} {
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    if (marker === undefined) {
      break;
    }
    offset += 1;

    // Standalone markers without length
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) {
        break;
      }
      continue;
    }

    if (offset + 2 > bytes.byteLength) {
      break;
    }
    const segmentLength = readUint16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      break;
    }

    if (isJpegSofMarker(marker) && segmentLength >= 7) {
      const height = readUint16BE(bytes, offset + 3);
      const width = readUint16BE(bytes, offset + 5);
      return {
        width: width > 0 ? width : null,
        height: height > 0 ? height : null,
      };
    }

    if (marker === 0xda) {
      // Start of Scan: dimensions should precede SOS
      break;
    }

    offset += segmentLength;
  }

  return { width: null, height: null };
}

function inspectWebp(bytes: Uint8Array): {
  width: number | null;
  height: number | null;
} {
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkType = asciiAt(bytes, offset, 4);
    const chunkSize = readUint32LE(bytes, offset + 4);
    const dataOffset = offset + 8;

    if (dataOffset + chunkSize > bytes.byteLength) {
      break;
    }

    if (chunkType === 'VP8X' && chunkSize >= 10) {
      const flags = bytes[dataOffset] ?? 0;
      if ((flags & 0x02) !== 0) {
        throw new ImageValidationError(
          'Animated WebP files are not supported. Upload a static JPEG, PNG, or WebP image.',
        );
      }
      const w0 = bytes[dataOffset + 4] ?? 0;
      const w1 = bytes[dataOffset + 5] ?? 0;
      const w2 = bytes[dataOffset + 6] ?? 0;
      const h0 = bytes[dataOffset + 7] ?? 0;
      const h1 = bytes[dataOffset + 8] ?? 0;
      const h2 = bytes[dataOffset + 9] ?? 0;
      return {
        width: (w0 | (w1 << 8) | (w2 << 16)) + 1,
        height: (h0 | (h1 << 8) | (h2 << 16)) + 1,
      };
    }

    if (chunkType === 'VP8 ' && chunkSize >= 10) {
      if (
        bytes[dataOffset + 3] === 0x9d &&
        bytes[dataOffset + 4] === 0x01 &&
        bytes[dataOffset + 5] === 0x2a
      ) {
        const width = readUint16LE(bytes, dataOffset + 6) & 0x3fff;
        const height = readUint16LE(bytes, dataOffset + 8) & 0x3fff;
        return { width, height };
      }
    }

    if (chunkType === 'VP8L' && chunkSize >= 5 && bytes[dataOffset] === 0x2f) {
      const bits = readUint32LE(bytes, dataOffset + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }

    const paddedSize = chunkSize + (chunkSize % 2);
    offset = dataOffset + paddedSize;
  }

  return { width: null, height: null };
}

export function assertWithinPixelLimit(width: number, height: number): void {
  if (width <= 0 || height <= 0) {
    throw new ImageValidationError(
      'Decoded image dimensions must be positive.',
    );
  }
  const pixels = width * height;
  if (pixels > MAX_IMAGE_DECODED_PIXELS) {
    const mp = (pixels / 1_000_000).toFixed(1);
    throw new ImageValidationError(
      `Image resolution (${width}x${height}, ${mp} MP) exceeds the 16 megapixel limit.`,
    );
  }
}

export function inspectImageBytes(
  bytes: Uint8Array,
  declaredMimeType: string,
): ImageInspectionResult {
  const normalizedDeclared = declaredMimeType.trim().toLowerCase();

  if (bytes.byteLength === 0) {
    throw new ImageValidationError('The selected image file is empty.');
  }
  if (bytes.byteLength > MAX_IMAGE_FILE_BYTES) {
    const mib = (bytes.byteLength / (1024 * 1024)).toFixed(1);
    throw new ImageValidationError(
      `Image file size (${mib} MiB) exceeds the 10 MiB limit.`,
    );
  }

  if (normalizedDeclared === 'image/svg+xml') {
    throw new ImageValidationError(
      'SVG images are not supported. Upload a static JPEG, PNG, or WebP image.',
    );
  }
  if (normalizedDeclared === 'image/gif') {
    throw new ImageValidationError(
      'GIF images are not supported. Upload a static JPEG, PNG, or WebP image.',
    );
  }
  if (
    normalizedDeclared.length > 0 &&
    !SUPPORTED_MIME_SET.has(normalizedDeclared)
  ) {
    throw new ImageValidationError(
      `Unsupported image type "${declaredMimeType}". Only static JPEG, PNG, and WebP are accepted.`,
    );
  }

  const detected = detectFormatFromMagic(bytes);
  if (detected === 'image/svg+xml') {
    throw new ImageValidationError(
      'SVG images are not supported. Upload a static JPEG, PNG, or WebP image.',
    );
  }
  if (detected === 'image/gif') {
    throw new ImageValidationError(
      'GIF images are not supported. Upload a static JPEG, PNG, or WebP image.',
    );
  }
  if (detected === null) {
    throw new ImageValidationError(
      'Unrecognized or corrupted image file. Only static JPEG, PNG, and WebP images are accepted.',
    );
  }
  if (normalizedDeclared.length > 0 && normalizedDeclared !== detected) {
    throw new ImageValidationError(
      `Image content (${detected}) does not match file type (${normalizedDeclared}).`,
    );
  }

  let dims: { width: number | null; height: number | null };
  if (detected === 'image/png') {
    dims = inspectPng(bytes);
  } else if (detected === 'image/jpeg') {
    dims = inspectJpeg(bytes);
  } else {
    dims = inspectWebp(bytes);
  }

  if (dims.width !== null && dims.height !== null) {
    assertWithinPixelLimit(dims.width, dims.height);
  }

  return {
    mimeType: detected,
    byteLength: bytes.byteLength,
    headerWidth: dims.width,
    headerHeight: dims.height,
  };
}

export function computeNormalizedDimensions(
  width: number,
  height: number,
  maxLongestEdge = MAX_IMAGE_LONGEST_EDGE,
): NormalizedDimensions {
  if (width <= 0 || height <= 0) {
    throw new ImageValidationError('Image dimensions must be positive.');
  }
  const longest = Math.max(width, height);
  if (longest <= maxLongestEdge) {
    return { width, height, wasResized: false };
  }
  const scale = maxLongestEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    wasResized: true,
  };
}

async function renderBitmapToPngBlob(
  bitmap: ImageBitmap,
  targetWidth: number,
  targetHeight: number,
): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new ImageValidationError(
        'Could not create a 2D canvas context to normalize the image.',
      );
    }
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new ImageValidationError(
      'Could not create a 2D canvas context to normalize the image.',
    );
  }
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => {
      if (out) {
        resolve(out);
      } else {
        reject(
          new ImageValidationError('Failed to encode normalized PNG image.'),
        );
      }
    }, 'image/png');
  });
}

export async function normalizeImageBlob(
  blob: Blob,
  sourceLabel: string,
): Promise<NormalizedImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const inspection = inspectImageBytes(bytes, blob.type);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      imageOrientation: 'from-image',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ImageValidationError(
      `Unable to decode image "${sourceLabel}": ${detail}`,
    );
  }

  try {
    assertWithinPixelLimit(bitmap.width, bitmap.height);
    const normalized = computeNormalizedDimensions(
      bitmap.width,
      bitmap.height,
      MAX_IMAGE_LONGEST_EDGE,
    );
    const pngBlob = await renderBitmapToPngBlob(
      bitmap,
      normalized.width,
      normalized.height,
    );
    const previewUrl = URL.createObjectURL(pngBlob);

    return {
      blob: pngBlob,
      mimeType: 'image/png',
      previewUrl,
      sourceLabel,
      originalMimeType: inspection.mimeType,
      originalByteLength: bytes.byteLength,
      normalizedByteLength: pngBlob.size,
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
      width: normalized.width,
      height: normalized.height,
      wasResized: normalized.wasResized,
    };
  } finally {
    bitmap.close();
  }
}

export function revokeNormalizedImage(
  image: NormalizedImage | null | undefined,
): void {
  if (image?.previewUrl) {
    URL.revokeObjectURL(image.previewUrl);
  }
}
