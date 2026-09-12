import type { CommAccount } from '@prisma/client';
import type { ChannelAdapter } from '../channel-adapters';

/** Adapter extension used by the inbound job to download provider media. */
export interface MediaFetchResult {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}

export interface MediaCapableAdapter extends ChannelAdapter {
  fetchMedia(
    account: CommAccount,
    media: { url: string; contentType: string; fileName?: string }
  ): Promise<MediaFetchResult>;
}

export function hasMediaFetcher(adapter: ChannelAdapter): adapter is MediaCapableAdapter {
  return typeof (adapter as Partial<MediaCapableAdapter>).fetchMedia === 'function';
}

export const INBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** Content types accepted from providers (prefix match, as safeFetch expects). */
export const INBOUND_MEDIA_CONTENT_TYPES = [
  'image/',
  'audio/',
  'video/',
  'application/pdf',
  'application/octet-stream',
  'text/vcard',
  'text/x-vcard',
  'application/vnd.openxmlformats-officedocument',
  'application/msword',
  'application/vnd.ms-excel',
];

export function fileNameFromContentType(base: string, contentType: string): string {
  const ext: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/amr': 'amr',
    'video/mp4': 'mp4',
    'text/vcard': 'vcf',
  };
  const clean = contentType.split(';')[0].trim().toLowerCase();
  const suffix = ext[clean];
  return suffix && !base.includes('.') ? `${base}.${suffix}` : base;
}

/** Simple in-memory idempotency guard so a retried send never reaches the provider twice. */
export class SendIdempotencyCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  constructor(private readonly ttlMs = 10 * 60 * 1000) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: T): void {
    if (this.entries.size > 5000) this.entries.clear();
    this.entries.set(key, { value, at: Date.now() });
  }
}
