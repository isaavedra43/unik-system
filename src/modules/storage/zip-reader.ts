/**
 * Minimal, bounded ZIP central-directory reader.
 *
 * Used to (a) reject decompression bombs before a file is accepted and
 * (b) inspect OOXML packages (XLSX/DOCX/PPTX) and plugin packages without
 * inflating anything. It never extracts data by itself: callers decide what
 * to inflate, entry by entry, with their own limits.
 *
 * ZIP64 archives are reported as unsupported so they can be rejected safely.
 */

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate */
  compressionMethod: number;
  localHeaderOffset: number;
  crc32: number;
  isDirectory: boolean;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  totalUncompressed: number;
  totalCompressed: number;
  zip64: boolean;
}

export interface ZipRandomAccess {
  size: number;
  read(start: number, end: number): Promise<Buffer>;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SCAN = 65_557; // 22 bytes + 65535 max comment

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export function bufferRandomAccess(buffer: Buffer): ZipRandomAccess {
  return {
    size: buffer.length,
    async read(start, end) {
      return buffer.subarray(Math.max(0, start), Math.min(buffer.length, end));
    },
  };
}

/**
 * Reads the central directory. `maxEntries` bounds memory and time.
 */
export async function readZipDirectory(
  source: ZipRandomAccess,
  options: { maxEntries?: number; maxDirectoryBytes?: number } = {}
): Promise<ZipDirectory> {
  const maxEntries = options.maxEntries ?? 10_000;
  const maxDirectoryBytes = options.maxDirectoryBytes ?? 4 * 1024 * 1024;

  if (source.size < 22) throw new ZipFormatError('Archivo ZIP demasiado pequeño');

  const tailStart = Math.max(0, source.size - MAX_EOCD_SCAN);
  const tail = await source.read(tailStart, source.size);

  let eocdIndex = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdIndex = i;
      break;
    }
  }
  if (eocdIndex < 0) throw new ZipFormatError('No se encontró el directorio central del ZIP');

  const totalEntries = tail.readUInt16LE(eocdIndex + 10);
  const directorySize = tail.readUInt32LE(eocdIndex + 12);
  const directoryOffset = tail.readUInt32LE(eocdIndex + 16);

  let zip64 = false;
  if (totalEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    zip64 = true;
  }
  if (eocdIndex >= 20 && tail.readUInt32LE(eocdIndex - 20) === ZIP64_LOCATOR_SIGNATURE) {
    zip64 = true;
  }
  if (zip64) {
    return { entries: [], totalUncompressed: 0, totalCompressed: 0, zip64: true };
  }

  if (totalEntries > maxEntries) {
    throw new ZipFormatError(`El ZIP contiene demasiadas entradas (${totalEntries})`);
  }
  if (directorySize > maxDirectoryBytes) {
    throw new ZipFormatError('El directorio central del ZIP es demasiado grande');
  }
  if (directoryOffset + directorySize > source.size) {
    throw new ZipFormatError('Directorio central fuera de rango');
  }

  const directory = await source.read(directoryOffset, directoryOffset + directorySize);
  const entries: ZipEntry[] = [];
  let offset = 0;
  let totalUncompressed = 0;
  let totalCompressed = 0;

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > directory.length) throw new ZipFormatError('Directorio central truncado');
    if (directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError('Firma de entrada inválida en el directorio central');
    }
    const compressionMethod = directory.readUInt16LE(offset + 10);
    const crc32 = directory.readUInt32LE(offset + 16);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > directory.length) throw new ZipFormatError('Nombre de entrada truncado');
    const name = directory.subarray(nameStart, nameEnd).toString('utf8');

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      return { entries: [], totalUncompressed: 0, totalCompressed: 0, zip64: true };
    }

    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      localHeaderOffset,
      crc32,
      isDirectory: name.endsWith('/'),
    });
    totalUncompressed += uncompressedSize;
    totalCompressed += compressedSize;
    offset = nameEnd + extraLength + commentLength;
  }

  return { entries, totalUncompressed, totalCompressed, zip64: false };
}

/** True when an entry name tries to escape the package root. */
export function isTraversalName(name: string): boolean {
  if (name.length === 0) return true;
  if (name.startsWith('/') || name.startsWith('\\')) return true;
  if (/^[A-Za-z]:/.test(name)) return true;
  if (name.includes('\0')) return true;
  const parts = name.split(/[\\/]/);
  return parts.some((p) => p === '..');
}

/**
 * Reads and inflates ONE entry with a hard cap on the inflated size.
 * Deflate (8) and stored (0) are supported; anything else is rejected.
 */
export async function readZipEntry(
  source: ZipRandomAccess,
  entry: ZipEntry,
  maxBytes: number
): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) {
    throw new ZipFormatError(`La entrada ${entry.name} excede el tamaño permitido`);
  }
  const header = await source.read(entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError('Encabezado local inválido');
  }
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > source.size) throw new ZipFormatError('Datos de entrada fuera de rango');
  const compressed = await source.read(dataStart, dataEnd);

  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    const { inflateRawSync } = await import('zlib');
    const inflated = inflateRawSync(compressed, { maxOutputLength: maxBytes });
    return inflated;
  }
  throw new ZipFormatError(`Método de compresión no soportado (${entry.compressionMethod})`);
}
