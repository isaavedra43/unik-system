import { z } from 'zod';
import type { CommContact } from '@prisma/client';
import type { CommProvider } from '@/modules/comms/channel-adapters';

/**
 * Campaigns contract: channels, statuses, validation schemas, frozen
 * snapshot shapes and the (eval-free) personalization renderer.
 */

export const CAMPAIGN_CHANNELS = ['whatsapp', 'sms', 'telegram'] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const CHANNEL_PROVIDER: Record<CampaignChannel, CommProvider> = {
  whatsapp: 'twilio_whatsapp',
  sms: 'twilio_sms',
  telegram: 'telegram',
};

export const CAMPAIGN_STATUSES = [
  'draft',
  'rehearsal',
  'pending_approval',
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const RECIPIENT_STATUSES = [
  'pending',
  'queued',
  'sent',
  'delivered',
  'failed',
  'skipped',
  'opted_out',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const TERMINAL_CAMPAIGN_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled']);

const tagSchema = z.string().trim().min(1).max(60);

export const audienceFilterSchema = z.object({
  tags: z.array(tagSchema).max(50).default([]),
  /** any = at least one tag; all = every tag. Empty tags = every contact with a valid identifier. */
  tagMode: z.enum(['any', 'all']).default('any'),
  excludeTags: z.array(tagSchema).max(50).default([]),
});
export type AudienceFilter = z.infer<typeof audienceFilterSchema>;

export const contentSchema = z.object({
  body: z.string().trim().min(1, 'El mensaje no puede estar vacío').max(4000),
  /** Provider template (WhatsApp content SID / template key) when required. */
  templateKey: z.string().trim().max(120).optional(),
  /** Static defaults for variables not provided by the contact. */
  variables: z.record(z.string().max(60), z.string().max(500)).default({}),
});
export type CampaignContent = z.infer<typeof contentSchema>;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, 'Nombre requerido').max(120),
  channel: z.enum(CAMPAIGN_CHANNELS),
  accountId: z.string().trim().min(1, 'Cuenta requerida').max(64),
  audienceFilter: audienceFilterSchema.optional(),
  content: contentSchema.optional(),
  budgetLimit: z.number().min(0).max(1_000_000_000).nullable().optional(),
  costPerMessage: z.number().min(0).max(10_000).optional(),
  batchSize: z.number().int().min(1).max(10_000).optional(),
  ratePerMinute: z.number().int().min(1).max(600).optional(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = createCampaignSchema.partial();
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

export const rehearseSchema = z.object({
  sampleSize: z.number().int().min(1).max(50).default(5),
});

export const approveCampaignSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  /** Accept a budget that does not cover the whole audience (the campaign will pause when exhausted). */
  allowPartialBudget: z.boolean().default(false),
});

export const audiencePreviewSchema = z.object({
  channel: z.enum(CAMPAIGN_CHANNELS),
  filter: audienceFilterSchema,
});

export interface AudienceSnapshot {
  filter: AudienceFilter;
  count: number | null;
  frozenAt: string | null;
  excluded?: { noConsent: number; optedOut: number; noIdentifier: number };
}

export interface ContentSnapshot {
  body: string;
  templateKey?: string;
  variables: Record<string, string>;
  frozenAt: string | null;
}

export interface CampaignStats {
  counts: Record<RecipientStatus, number>;
  total: number;
  rehearsal?: { at: string; sampleSize: number; byUserId: string; failed: number };
  pauseReason?: string | null;
  lastBatchNo?: number;
  lastError?: string | null;
  cancelledAt?: string;
}

export function emptyCounts(): Record<RecipientStatus, number> {
  return { pending: 0, queued: 0, sent: 0, delivered: 0, failed: 0, skipped: 0, opted_out: 0 };
}

/* ------------------------------------------------------------------ */
/* Identifiers                                                        */
/* ------------------------------------------------------------------ */

const E164 = /^\+[1-9]\d{7,14}$/;

/** Normalizes a stored phone into E.164 (digits-only 10-15 chars get a leading "+"). */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = raw.replace(/[\s\-().]/g, '');
  const candidate = /^\d{10,15}$/.test(compact) ? `+${compact}` : compact;
  return E164.test(candidate) ? candidate : null;
}

/** Destination identifier for a channel, or null when the contact cannot be reached on it. */
export function identifierFor(
  channel: CampaignChannel,
  contact: Pick<CommContact, 'phone' | 'telegramId'>
): string | null {
  if (channel === 'telegram') {
    const id = contact.telegramId?.trim();
    return id && /^-?\d{1,20}$/.test(id) ? id : null;
  }
  return normalizePhone(contact.phone);
}

/** Masks an identifier for previews (never shows the full number to the UI list). */
export function maskIdentifier(value: string): string {
  if (value.length <= 4) return '••••';
  return `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/* Personalization (pure string substitution, no evaluation)          */
/* ------------------------------------------------------------------ */

const VARIABLE_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function extractVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(VARIABLE_RE)) found.add(match[1]);
  return [...found];
}

export interface RenderResult {
  text: string;
  missing: string[];
}

export function renderTemplate(body: string, values: Record<string, string>): RenderResult {
  const missing = new Set<string>();
  const text = body.replace(VARIABLE_RE, (_m, key: string) => {
    const value = values[key];
    if (value === undefined || value === null || value === '') {
      missing.add(key);
      return '';
    }
    return String(value);
  });
  return { text: text.replace(/[ \t]{2,}/g, ' ').trim(), missing: [...missing] };
}

/** Per-contact variables captured at freeze time (the frozen audience never re-reads the contact). */
export function personalizationFor(
  contact: Pick<CommContact, 'displayName' | 'phone' | 'email' | 'telegramId'>,
  identifier: string
): Record<string, string> {
  const name = contact.displayName?.trim() ?? '';
  return {
    nombre: name,
    primer_nombre: name.split(/\s+/)[0] ?? '',
    telefono: identifier,
    email: contact.email ?? '',
  };
}

export function toSnapshotVariables(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
