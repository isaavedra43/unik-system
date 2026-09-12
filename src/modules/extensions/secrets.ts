import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Secret storage for extension credentials.
 *
 * Secrets are encrypted with AES-256-GCM using a master key that lives
 * OUTSIDE PostgreSQL (environment variable). Every ciphertext records the key
 * id it was produced with so keys can be rotated: set the new key as
 * UNIK_SECRETS_MASTER_KEY / UNIK_SECRETS_KEY_ID and keep the previous one in
 * UNIK_SECRETS_MASTER_KEY_PREVIOUS / UNIK_SECRETS_KEY_ID_PREVIOUS until every
 * row has been re-encrypted (`reencrypt`).
 *
 * Plaintext never leaves the server: it is not returned to the browser, not
 * included in prompts, results or logs.
 */

export interface EncryptedSecret {
  keyId: string;
  ciphertext: string; // base64url(iv | authTag | data)
}

interface KeyRing {
  current: { id: string; key: Buffer };
  previous: { id: string; key: Buffer } | null;
}

function decodeKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} must be a base64-encoded 32-byte key`);
  }
  return key;
}

let cachedRing: KeyRing | null = null;

export function getKeyRing(): KeyRing {
  if (cachedRing) return cachedRing;
  const current = process.env.UNIK_SECRETS_MASTER_KEY;
  if (!current) {
    throw new Error('UNIK_SECRETS_MASTER_KEY is required to store extension credentials');
  }
  const previous = process.env.UNIK_SECRETS_MASTER_KEY_PREVIOUS;
  cachedRing = {
    current: {
      id: process.env.UNIK_SECRETS_KEY_ID ?? 'k1',
      key: decodeKey(current, 'UNIK_SECRETS_MASTER_KEY'),
    },
    previous: previous
      ? {
          id: process.env.UNIK_SECRETS_KEY_ID_PREVIOUS ?? 'k0',
          key: decodeKey(previous, 'UNIK_SECRETS_MASTER_KEY_PREVIOUS'),
        }
      : null,
  };
  return cachedRing;
}

export function resetKeyRingCache(): void {
  cachedRing = null;
}

export function isSecretsConfigured(): boolean {
  return Boolean(process.env.UNIK_SECRETS_MASTER_KEY);
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const ring = getKeyRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.current.key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyId: ring.current.id,
    ciphertext: Buffer.concat([iv, tag, data]).toString('base64url'),
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const ring = getKeyRing();
  const key =
    secret.keyId === ring.current.id
      ? ring.current.key
      : ring.previous && secret.keyId === ring.previous.id
        ? ring.previous.key
        : null;
  if (!key) throw new Error(`No key available for keyId ${secret.keyId}`);
  const raw = Buffer.from(secret.ciphertext, 'base64url');
  if (raw.length < 12 + 16) throw new Error('Ciphertext too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Re-encrypts with the current key when the ciphertext was made with a previous one. */
export function reencryptIfStale(secret: EncryptedSecret): EncryptedSecret {
  const ring = getKeyRing();
  if (secret.keyId === ring.current.id) return secret;
  return encryptSecret(decryptSecret(secret));
}

/** Constant-time comparison for opaque tokens (OAuth state, webhook secrets). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Masks a secret for display: never more than the last 4 characters. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return '';
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

/**
 * Removes anything that looks like a credential from a value before it is
 * logged, stored as a tool result or shown to the model. Heuristic, not a
 * guarantee — secrets must never be placed in those payloads to begin with.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(sk|rk|pk|xox[abp]|ghp|gho|AKIA)[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|token|password|api[_-]?key|authorization|credential)/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}
