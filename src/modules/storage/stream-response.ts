import { Readable } from 'stream';
import type { ObjectStreamResult } from './object-storage';

/**
 * Builds a streaming HTTP response (200 or 206) from an object stream.
 * Never buffers the file: the Node Readable is converted to a Web stream.
 */
export interface StreamResponseOptions {
  fileName: string;
  mimeType: string;
  disposition: 'inline' | 'attachment';
  /** Content that must never render in the browser context (SVG/HTML/macros). */
  downloadOnly?: boolean;
  cacheControl?: string;
}

function contentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function streamResponse(
  result: ObjectStreamResult,
  options: StreamResponseOptions
): Response {
  const headers = new Headers();
  const mime = options.downloadOnly ? 'application/octet-stream' : options.mimeType;
  headers.set('Content-Type', mime);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', options.cacheControl ?? 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set(
    'Content-Disposition',
    contentDisposition(options.downloadOnly ? 'attachment' : options.disposition, options.fileName)
  );
  if (options.downloadOnly) {
    headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  }
  headers.set('Content-Length', String(result.contentLength));
  let status = 200;
  if (result.range) {
    status = 206;
    headers.set(
      'Content-Range',
      `bytes ${result.range.start}-${result.range.end}/${result.totalSize}`
    );
  }
  if (result.etag) headers.set('ETag', result.etag);

  const body = Readable.toWeb(result.stream as Readable) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}
