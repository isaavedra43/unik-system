import { createHmac, timingSafeEqual } from 'crypto';
import { getStorageConfig } from './storage-config';

/**
 * HMAC tokens that authorize ONE part of ONE upload for a short time. They
 * play the role of a presigned URL for the disk driver. Tokens never carry
 * credentials and are useless once the upload is completed or aborted.
 */

export interface UploadPartClaims {
  uploadId: string;
  partNumber: number;
  contentLength: number;
  expiresAt: number; // epoch ms
}

function sign(payload: string): string {
  const { signingSecret } = getStorageConfig();
  return createHmac('sha256', signingSecret).update(payload).digest('base64url');
}

export function createUploadPartToken(claims: UploadPartClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyUploadPartToken(token: string): UploadPartClaims | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as UploadPartClaims;
    if (
      typeof claims.uploadId !== 'string' ||
      typeof claims.partNumber !== 'number' ||
      typeof claims.contentLength !== 'number' ||
      typeof claims.expiresAt !== 'number'
    ) {
      return null;
    }
    if (claims.expiresAt < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
