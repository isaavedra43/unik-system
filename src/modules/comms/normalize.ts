import { createHash, timingSafeEqual } from 'crypto';

/**
 * Pure helpers shared by the communications module: identifier
 * normalization (phones, emails, names), consent keywords and constant-time
 * comparisons for webhook secrets. No I/O here so everything is unit-testable.
 */

/**
 * Normalizes a phone number to E.164 (+<digits>). Accepts "whatsapp:+52..."
 * prefixes, spaces, dashes and parentheses. Numbers without a country code
 * receive the default (Mexico, +52) when they have 10 digits.
 */
export function normalizePhone(raw: string | null | undefined, defaultCountry = '52'): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.toLowerCase().startsWith('whatsapp:')) value = value.slice('whatsapp:'.length);
  const hasPlus = value.startsWith('+');
  const digits = value.replace(/\D+/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  if (hasPlus) return `+${digits}`;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  return `+${digits}`;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value;
}

export function emailDomain(email: string | null | undefined): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return normalized.split('@')[1] ?? null;
}

/** Lowercase, accent-free, single-spaced name used for fuzzy duplicate matching. */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Twilio addresses: "whatsapp:+52..." → "+52...". */
export function stripChannelPrefix(address: string): string {
  return address.replace(/^whatsapp:/i, '').trim();
}

const OPT_OUT_WORDS = new Set(['BAJA', 'STOP', 'CANCELAR', 'UNSUBSCRIBE', 'DETENER', 'NO MOLESTAR']);
const OPT_IN_WORDS = new Set(['ALTA', 'START', 'UNSTOP', 'SUSCRIBIR', 'ACEPTO']);

function normalizeKeyword(body: string): string {
  return body
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Detects explicit consent keywords in an inbound message body. */
export function detectConsentKeyword(body: string | null | undefined): 'opted_out' | 'opted_in' | null {
  if (!body) return null;
  const text = normalizeKeyword(body);
  if (!text || text.length > 40) return null;
  if (OPT_OUT_WORDS.has(text)) return 'opted_out';
  if (OPT_IN_WORDS.has(text)) return 'opted_in';
  return null;
}

/** Constant-time string comparison that never throws on length mismatch. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Channel name stored in ConsentRecord for a provider. */
export function channelForProvider(provider: string): 'whatsapp' | 'sms' | 'telegram' {
  if (provider === 'twilio_whatsapp') return 'whatsapp';
  if (provider === 'twilio_sms') return 'sms';
  return 'telegram';
}

export function previewText(body: string | null | undefined, max = 120): string {
  if (!body) return '';
  const single = body.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
