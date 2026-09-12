import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  buildObjectKey,
  buildQuarantineKey,
  buildRecordingKey,
  isLegacyPathAllowed,
  isSafeKey,
  newVersionId,
} from './storage-keys';
import { parseRangeHeader } from './object-storage';
import { createUploadPartToken, verifyUploadPartToken } from './upload-tokens';

describe('storage keys', () => {
  it('builds opaque keys by purpose without user data', () => {
    const v = newVersionId();
    expect(buildObjectKey('chat', 'obj1', v)).toBe(`chat/obj1/${v}`);
    expect(buildObjectKey('ai_attachment', 'obj1', v)).toBe(`assistant/obj1/${v}`);
    expect(buildObjectKey('document', 'obj1', v)).toBe(`documents/obj1/${v}`);
    expect(buildQuarantineKey('obj1', v)).toBe(`quarantine/obj1/${v}`);
    expect(buildRecordingKey('call1', 'rec1')).toBe('recordings/call1/rec1');
  });

  it('refuses unsafe segments and keys', () => {
    expect(() => buildObjectKey('chat', '../x', 'v')).toThrow();
    expect(() => buildObjectKey('chat', 'cliente juan', 'v')).toThrow();
    expect(isSafeKey('a/b/c')).toBe(true);
    expect(isSafeKey('/a/b')).toBe(false);
    expect(isSafeKey('a/../b')).toBe(false);
    expect(isSafeKey('a//b')).toBe(false);
    expect(isSafeKey('a/b c')).toBe(false);
  });

  it('only allows legacy paths inside the legacy directories', () => {
    const cwd = '/srv/unik';
    expect(isLegacyPathAllowed(path.join(cwd, 'data/chat-attachments/chat-1.png'), cwd)).toBe(true);
    expect(isLegacyPathAllowed('data/ai-artifacts/x.pdf', cwd)).toBe(true);
    expect(isLegacyPathAllowed('data/ai-attachments/../../etc/passwd', cwd)).toBe(false);
    expect(isLegacyPathAllowed('/etc/passwd', cwd)).toBe(false);
    expect(isLegacyPathAllowed(path.join(cwd, 'data/chat-attachments-evil/x'), cwd)).toBe(false);
    expect(isLegacyPathAllowed('', cwd)).toBe(false);
  });
});

describe('parseRangeHeader', () => {
  it('parses simple, open-ended and suffix ranges', () => {
    expect(parseRangeHeader('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRangeHeader('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('returns null when absent/invalid and unsatisfiable when out of bounds', () => {
    expect(parseRangeHeader(null, 10)).toBeNull();
    expect(parseRangeHeader('items=1-2', 10)).toBeNull();
    expect(parseRangeHeader('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=5-2', 10)).toBe('unsatisfiable');
  });
});

describe('upload part tokens', () => {
  it('round-trips valid claims and rejects tampering/expiry', () => {
    process.env.STORAGE_SIGNING_SECRET = 'test-secret';
    const claims = {
      uploadId: 'up1',
      partNumber: 3,
      contentLength: 1024,
      expiresAt: Date.now() + 60_000,
    };
    const token = createUploadPartToken(claims);
    expect(verifyUploadPartToken(token)).toEqual(claims);
    expect(verifyUploadPartToken(token.slice(0, -2) + 'zz')).toBeNull();
    const expired = createUploadPartToken({ ...claims, expiresAt: Date.now() - 1 });
    expect(verifyUploadPartToken(expired)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ ...claims, partNumber: 9 })).toString('base64url');
    expect(verifyUploadPartToken(`${forged}.${token.split('.')[1]}`)).toBeNull();
  });
});
