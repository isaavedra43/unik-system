/**
 * Minimal image helpers for the exporters: pixel dimensions from PNG/JPEG
 * headers (no decoder dependency) and the MIME types each renderer accepts.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** Reads PNG (IHDR) or JPEG (SOFn) dimensions. Returns null when unknown. */
export function readImageSize(buffer: Buffer, mimeType: string): ImageSize | null {
  const mime = mimeType.toLowerCase();
  if (mime === 'image/png') {
    if (buffer.length < 24) return null;
    if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0..SOF15 except DHT(0xC4), JPG(0xC8), DAC(0xCC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }
  return null;
}

/** Fits an image inside a box keeping its aspect ratio. */
export function fitImage(size: ImageSize | null, maxWidth: number, maxHeight: number): ImageSize {
  if (!size || size.width <= 0 || size.height <= 0) {
    return { width: Math.min(maxWidth, 480), height: Math.min(maxHeight, 320) };
  }
  const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** pdfkit and docx only decode PNG/JPEG; WebP is embedded only where a data URI works. */
export function isPdfCompatibleImage(mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg';
}

export function docxImageType(mimeType: string): 'png' | 'jpg' | null {
  const mime = mimeType.toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  return null;
}

export function toDataUri(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}
