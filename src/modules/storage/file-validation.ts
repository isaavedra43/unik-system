import {
  readZipDirectory,
  isTraversalName,
  type ZipRandomAccess,
  ZipFormatError,
} from './zip-reader';

/**
 * Content validation for uploaded files.
 *
 * Checks the REAL format (magic bytes) instead of trusting the extension or
 * the declared Content-Type, bounds archive expansion, refuses active
 * content in SVG previews and extracts light metadata (image dimensions).
 *
 * This is a first line of defense, not an antivirus: it does not guarantee
 * the absence of malicious content. Parsers that consume the files later
 * (PDF text extraction, spreadsheets, previews) also run with limits.
 */

export const HEAD_BYTES = 64 * 1024;

export interface DetectedType {
  mimeType: string;
  extension: string;
}

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/webm;codecs=opus': 'audio/webm',
  'application/x-zip-compressed': 'application/zip',
  'text/x-csv': 'text/csv',
  'application/csv': 'text/csv',
};

export function normalizeMime(mime: string): string {
  const lower = mime.trim().toLowerCase().split(';')[0].trim();
  return MIME_ALIASES[lower] ?? MIME_ALIASES[mime.trim().toLowerCase()] ?? lower;
}

const OOXML_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const ZIP_FAMILY = new Set(['application/zip', ...OOXML_MIMES]);

/** Containers shared by audio and video: the declared type decides which one it is. */
const MEDIA_CONTAINER_FAMILIES: Array<Set<string>> = [
  new Set(['audio/webm', 'video/webm', 'video/x-matroska']),
  new Set(['audio/ogg', 'video/ogg']),
  new Set(['audio/mp4', 'video/mp4', 'video/quicktime', 'audio/aac']),
];

const TEXT_LIKE = new Set([
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'text/html',
  'image/svg+xml',
  'application/xml',
  'text/xml',
]);

function startsWith(head: Uint8Array, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (head[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function ascii(head: Uint8Array, start: number, end: number): string {
  return Buffer.from(head.subarray(start, end)).toString('latin1');
}

/** Detects the container/format from the first bytes. Returns null when unknown. */
export function detectMimeFromBytes(head: Uint8Array): DetectedType | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', extension: 'jpg' };
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38]))
    return { mimeType: 'image/gif', extension: 'gif' };
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && head.length >= 12) {
    const tag = ascii(head, 8, 12);
    if (tag === 'WEBP') return { mimeType: 'image/webp', extension: 'webp' };
    if (tag === 'WAVE') return { mimeType: 'audio/wav', extension: 'wav' };
    if (tag === 'AVI ') return { mimeType: 'video/x-msvideo', extension: 'avi' };
  }
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46]))
    return { mimeType: 'application/pdf', extension: 'pdf' };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return { mimeType: 'application/zip', extension: 'zip' };
  }
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (brand.startsWith('M4A') || brand === 'M4B ')
      return { mimeType: 'audio/mp4', extension: 'm4a' };
    if (brand === 'qt  ') return { mimeType: 'video/quicktime', extension: 'mov' };
    return { mimeType: 'video/mp4', extension: 'mp4' };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Matroska/WebM — decide by DocType string within the first bytes.
    const text = ascii(head, 0, Math.min(head.length, 64));
    if (text.includes('webm')) return { mimeType: 'video/webm', extension: 'webm' };
    return { mimeType: 'video/x-matroska', extension: 'mkv' };
  }
  if (startsWith(head, [0x4f, 0x67, 0x67, 0x53])) {
    const text = ascii(head, 0, Math.min(head.length, 64));
    if (text.includes('theora')) return { mimeType: 'video/ogg', extension: 'ogv' };
    return { mimeType: 'audio/ogg', extension: 'ogg' };
  }
  if (
    startsWith(head, [0x49, 0x44, 0x33]) ||
    startsWith(head, [0xff, 0xfb]) ||
    startsWith(head, [0xff, 0xf3]) ||
    startsWith(head, [0xff, 0xf2])
  ) {
    return { mimeType: 'audio/mpeg', extension: 'mp3' };
  }
  if (startsWith(head, [0xff, 0xf1]) || startsWith(head, [0xff, 0xf9])) {
    return { mimeType: 'audio/aac', extension: 'aac' };
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    // Legacy Office (OLE2): xls/doc share the container.
    return { mimeType: 'application/x-ole-storage', extension: 'ole' };
  }
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46]))
    return { mimeType: 'application/x-elf', extension: 'elf' };
  if (startsWith(head, [0x4d, 0x5a]))
    return { mimeType: 'application/x-msdownload', extension: 'exe' };
  if (startsWith(head, [0x1f, 0x8b])) return { mimeType: 'application/gzip', extension: 'gz' };
  if (startsWith(head, [0x52, 0x61, 0x72, 0x21]))
    return { mimeType: 'application/vnd.rar', extension: 'rar' };
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))
    return { mimeType: 'application/x-7z-compressed', extension: '7z' };
  return null;
}

/** True when the first bytes look like text (no NUL bytes, mostly printable). */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  let control = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i];
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++;
  }
  return control / head.length < 0.05;
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Best-effort dimensions for PNG, GIF, WEBP and JPEG from the head bytes. */
export function readImageDimensions(head: Uint8Array, mimeType: string): ImageDimensions | null {
  const buf = Buffer.from(head);
  try {
    if (mimeType === 'image/png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mimeType === 'image/gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mimeType === 'image/webp' && buf.length >= 30) {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        const b0 = buf[21],
          b1 = buf[22],
          b2 = buf[23],
          b3 = buf[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height };
      }
      if (chunk === 'VP8X') {
        const width = 1 + buf.readUIntLE(24, 3);
        const height = 1 + buf.readUIntLE(27, 3);
        return { width, height };
      }
    }
    if (mimeType === 'image/jpeg') {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const length = buf.readUInt16BE(offset + 2);
        const isSof =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSof) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Elements and attributes that make an SVG active content. */
const SVG_DANGEROUS = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /<\s*iframe/i,
  /<\s*embed/i,
  /<\s*object/i,
  /\son[a-z]+\s*=/i,
  /javascript\s*:/i,
  /data\s*:\s*text\/html/i,
  /<\s*set\b/i,
  /<\s*animate[a-z]*\b[^>]*\battributeName\s*=\s*["']?(href|xlink:href)/i,
];

export function inspectSvg(text: string): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];
  for (const re of SVG_DANGEROUS) {
    if (re.test(text)) reasons.push(re.source);
  }
  // External references (http(s) hrefs) leak requests; only same-document (#id) refs are fine.
  if (/(xlink:href|href)\s*=\s*["'](?!#|data:image\/)/i.test(text)) {
    reasons.push('external-reference');
  }
  if (!/<\s*svg[\s>]/i.test(text)) reasons.push('not-svg');
  return { safe: reasons.length === 0, reasons };
}

/**
 * Conservative sanitizer for SVG previews: drops scripts, foreign objects,
 * event handlers and external references. Anything unsure is removed.
 */
export function sanitizeSvg(text: string): string {
  let out = text;
  out = out.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  out = out.replace(
    /<\s*(foreignObject|iframe|embed|object|set)\b[\s\S]*?(<\s*\/\s*\1\s*>|\/>)/gi,
    ''
  );
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(
    /(xlink:href|href)\s*=\s*("(?!#|data:image\/)[^"]*"|'(?!#|data:image\/)[^']*')/gi,
    ''
  );
  out = out.replace(/javascript\s*:/gi, '');
  return out;
}

export interface ValidationLimits {
  /** Hard maximum for the object. */
  maxBytes: number;
  /** Declared types the target accepts (normalized). Empty = accept any detected type. */
  allowedMimeTypes: string[];
  /** Max total uncompressed bytes for zip-like content. */
  maxZipExpansionBytes?: number;
  /** Max ratio uncompressed/compressed for zip-like content. */
  maxZipRatio?: number;
  /** Max entries in a zip-like package. */
  maxZipEntries?: number;
}

export interface ValidationInput {
  declaredMimeType: string;
  declaredSize: number;
  actualSize: number;
  /** First HEAD_BYTES of the object. */
  head: Uint8Array;
  /** Random access to the object for archive inspection. */
  randomAccess?: ZipRandomAccess;
  limits: ValidationLimits;
}

export interface ValidationResult {
  ok: boolean;
  detectedMimeType: string;
  reason?: string;
  /** Whether previews must be disabled (delivered as download only). */
  downloadOnly?: boolean;
  metadata: Record<string, unknown>;
}

function isAllowed(mime: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const normalized = allowed.map(normalizeMime);
  return normalized.includes(mime);
}

async function inspectZipLike(
  input: ValidationInput,
  detected: string
): Promise<{
  ok: boolean;
  reason?: string;
  resolvedMime: string;
  metadata: Record<string, unknown>;
}> {
  const limits = input.limits;
  const maxExpansion = limits.maxZipExpansionBytes ?? 512 * 1024 * 1024;
  const maxRatio = limits.maxZipRatio ?? 100;
  const maxEntries = limits.maxZipEntries ?? 10_000;
  if (!input.randomAccess) {
    return {
      ok: false,
      reason: 'No fue posible inspeccionar el archivo comprimido',
      resolvedMime: detected,
      metadata: {},
    };
  }
  let directory;
  try {
    directory = await readZipDirectory(input.randomAccess, { maxEntries });
  } catch (err) {
    const message = err instanceof ZipFormatError ? err.message : 'ZIP inválido';
    return { ok: false, reason: message, resolvedMime: detected, metadata: {} };
  }
  if (directory.zip64) {
    return {
      ok: false,
      reason: 'Archivos ZIP64 no admitidos',
      resolvedMime: detected,
      metadata: {},
    };
  }
  if (directory.entries.some((e) => isTraversalName(e.name))) {
    return {
      ok: false,
      reason: 'El ZIP contiene rutas no permitidas',
      resolvedMime: detected,
      metadata: {},
    };
  }
  if (directory.totalUncompressed > maxExpansion) {
    return {
      ok: false,
      reason: 'El contenido descomprimido excede el límite permitido',
      resolvedMime: detected,
      metadata: {},
    };
  }
  const ratio =
    directory.totalCompressed > 0 ? directory.totalUncompressed / directory.totalCompressed : 1;
  if (ratio > maxRatio && directory.totalUncompressed > 10 * 1024 * 1024) {
    return {
      ok: false,
      reason: 'Relación de compresión sospechosa (posible zip bomb)',
      resolvedMime: detected,
      metadata: {},
    };
  }
  const names = directory.entries.map((e) => e.name);
  let resolvedMime = 'application/zip';
  if (names.some((n) => n.startsWith('xl/'))) {
    resolvedMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else if (names.some((n) => n.startsWith('word/'))) {
    resolvedMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  } else if (names.some((n) => n.startsWith('ppt/'))) {
    resolvedMime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  // Macro-enabled packages are never executed by UNIK, but we record their presence.
  const hasMacros = names.some((n) => /vbaProject\.bin$/i.test(n));
  return {
    ok: true,
    resolvedMime,
    metadata: {
      zipEntries: directory.entries.length,
      zipUncompressedBytes: directory.totalUncompressed,
      hasMacros,
    },
  };
}

/**
 * Validates an object's real content against the declared type and the
 * target's limits. Pure function over bytes: no I/O other than the optional
 * random access reader for archives.
 */
export async function validateFileContent(input: ValidationInput): Promise<ValidationResult> {
  const declared = normalizeMime(input.declaredMimeType);
  const metadata: Record<string, unknown> = {};

  if (input.actualSize !== input.declaredSize) {
    return {
      ok: false,
      detectedMimeType: declared,
      reason: `Tamaño real (${input.actualSize}) distinto al declarado (${input.declaredSize})`,
      metadata,
    };
  }
  if (input.actualSize > input.limits.maxBytes) {
    return {
      ok: false,
      detectedMimeType: declared,
      reason: 'Archivo superior al tamaño autorizado',
      metadata,
    };
  }
  if (input.actualSize === 0) {
    return { ok: false, detectedMimeType: declared, reason: 'Archivo vacío', metadata };
  }

  const detected = detectMimeFromBytes(input.head);
  let resolved: string;

  if (detected) {
    if (ZIP_FAMILY.has(detected.mimeType)) {
      const zip = await inspectZipLike(input, detected.mimeType);
      if (!zip.ok)
        return { ok: false, detectedMimeType: detected.mimeType, reason: zip.reason, metadata };
      Object.assign(metadata, zip.metadata);
      resolved = zip.resolvedMime;
      // A declared xlsx must really be an xlsx package (not an arbitrary zip renamed).
      if (OOXML_MIMES.has(declared) && resolved !== declared) {
        return {
          ok: false,
          detectedMimeType: resolved,
          reason: 'El paquete Office no coincide con el tipo declarado',
          metadata,
        };
      }
      if (declared === 'application/zip' && resolved !== 'application/zip') {
        // A zip that is really an office package — keep the more specific type.
      }
    } else if (detected.mimeType === 'application/x-ole-storage') {
      // Legacy .xls/.doc share the OLE container; trust the declared one among those two.
      if (declared === 'application/vnd.ms-excel' || declared === 'application/msword') {
        resolved = declared;
      } else {
        return {
          ok: false,
          detectedMimeType: detected.mimeType,
          reason: 'Formato Office heredado no coincide con el tipo declarado',
          metadata,
        };
      }
    } else {
      resolved = detected.mimeType;
    }
  } else if (TEXT_LIKE.has(declared)) {
    if (!looksLikeText(input.head)) {
      return {
        ok: false,
        detectedMimeType: 'application/octet-stream',
        reason: 'El archivo declarado como texto contiene datos binarios',
        metadata,
      };
    }
    resolved = declared;
    if (declared === 'image/svg+xml') {
      const text = Buffer.from(input.head).toString('utf8');
      const svg = inspectSvg(text);
      metadata.svgSafeForPreview = svg.safe;
      if (!svg.safe) metadata.svgReasons = svg.reasons;
    }
  } else if (declared === 'application/octet-stream') {
    resolved = 'application/octet-stream';
  } else {
    return {
      ok: false,
      detectedMimeType: 'application/octet-stream',
      reason: `No se pudo verificar el formato declarado (${declared})`,
      metadata,
    };
  }

  // Executables are never accepted, whatever the target says.
  if (['application/x-msdownload', 'application/x-elf'].includes(resolved)) {
    return {
      ok: false,
      detectedMimeType: resolved,
      reason: 'Archivos ejecutables no permitidos',
      metadata,
    };
  }

  // Consistency between declared and detected. Families are tolerated: zip ↔ ooxml
  // (handled above), text-like types, and media containers shared by audio and video
  // (WebM/Matroska, Ogg, MP4) — a voice note is audio/webm inside a "video/webm" container.
  const declaredIsGeneric = declared === 'application/octet-stream';
  if (!declaredIsGeneric && resolved !== declared) {
    const bothZip = ZIP_FAMILY.has(resolved) && ZIP_FAMILY.has(declared);
    const bothText = TEXT_LIKE.has(resolved) && TEXT_LIKE.has(declared);
    const sameContainer = MEDIA_CONTAINER_FAMILIES.some((f) => f.has(resolved) && f.has(declared));
    if (!bothZip && !bothText && !sameContainer) {
      return {
        ok: false,
        detectedMimeType: resolved,
        reason: `Tipo declarado (${declared}) no coincide con el contenido (${resolved})`,
        metadata,
      };
    }
    if (sameContainer) resolved = declared;
  }

  if (
    !isAllowed(resolved, input.limits.allowedMimeTypes) &&
    !isAllowed(declared, input.limits.allowedMimeTypes)
  ) {
    return {
      ok: false,
      detectedMimeType: resolved,
      reason: `Tipo de archivo no permitido: ${resolved}`,
      metadata,
    };
  }

  if (resolved.startsWith('image/') && resolved !== 'image/svg+xml') {
    const dims = readImageDimensions(input.head, resolved);
    if (dims) {
      metadata.width = dims.width;
      metadata.height = dims.height;
    }
  }

  const downloadOnly =
    resolved === 'image/svg+xml' || resolved === 'text/html' || Boolean(metadata.hasMacros);
  return { ok: true, detectedMimeType: resolved, downloadOnly, metadata };
}
