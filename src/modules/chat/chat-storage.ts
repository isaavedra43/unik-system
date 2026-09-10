import fs from 'fs/promises';
import path from 'path';

/**
 * Chat file storage abstraction.
 *
 * Currently implemented with local disk (data/chat-attachments). The interface
 * is designed so a future S3/R2 implementation can be dropped in without
 * changing any service-layer code.
 */

export interface ChatStorage {
  save(buffer: Buffer, key: string, ext: string): Promise<string>;
  read(filePath: string): Promise<Buffer>;
  delete(filePath: string): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  getAbsolutePath(relPath: string): string;
}

const STORAGE_DIR = path.join(process.cwd(), 'data', 'chat-attachments');

async function ensureDir(): Promise<void> {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

class DiskChatStorage implements ChatStorage {
  async save(buffer: Buffer, key: string, ext: string): Promise<string> {
    await ensureDir();
    const fileName = `${key}.${ext}`;
    const fullPath = path.join(STORAGE_DIR, fileName);
    await fs.writeFile(fullPath, buffer);
    return fullPath;
  }

  async read(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  async delete(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore missing files
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  getAbsolutePath(relPath: string): string {
    if (path.isAbsolute(relPath)) return relPath;
    return path.join(STORAGE_DIR, relPath);
  }
}

export const chatStorage: ChatStorage = new DiskChatStorage();

export function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/msword': 'doc',
    'application/zip': 'zip',
    'application/octet-stream': 'bin',
  };
  return map[mimeType] ?? 'bin';
}
