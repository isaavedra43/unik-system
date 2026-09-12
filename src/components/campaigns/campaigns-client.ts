/** Client-side types and helpers for the campaigns workspace (mirrors the API DTOs). */

export type RecipientStatus =
  'pending' | 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped' | 'opted_out';

export interface AudienceFilter {
  tags: string[];
  tagMode: 'any' | 'all';
  excludeTags: string[];
}

export interface CampaignDTO {
  id: string;
  name: string;
  channel: 'whatsapp' | 'sms' | 'telegram';
  accountId: string;
  accountLabel: string | null;
  status: string;
  audience: {
    filter: AudienceFilter;
    count: number | null;
    frozenAt: string | null;
    excluded?: { noConsent: number; optedOut: number; noIdentifier: number };
  } | null;
  content: {
    body: string;
    templateKey?: string;
    variables: Record<string, string>;
    frozenAt: string | null;
  } | null;
  frozen: boolean;
  budgetLimit: string | null;
  budgetSpent: string;
  costPerMessage: string;
  estimatedCost: string | null;
  batchSize: number;
  ratePerMinute: number;
  scheduledAt: string | null;
  startedAt: string | null;
  pausedAt: string | null;
  completedAt: string | null;
  stats: {
    counts: Record<RecipientStatus, number>;
    total: number;
    rehearsal?: { at: string; sampleSize: number; failed: number };
    pauseReason?: string | null;
  };
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  provider: string;
  label: string;
  identifier: string;
  status: string;
}

export interface RenderedRecipient {
  recipientId: string;
  contactId: string;
  to: string;
  body: string;
  missing: string[];
  status?: string;
  error?: string;
}

export const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  telegram: 'Telegram',
};
export const CHANNEL_PROVIDER: Record<string, string> = {
  whatsapp: 'twilio_whatsapp',
  sms: 'twilio_sms',
  telegram: 'telegram',
};

export const CAMPAIGN_STATUS_LABEL: Record<string, { label: string; badge: string }> = {
  draft: { label: 'Borrador', badge: 'badge-weak' },
  rehearsal: { label: 'Congelada / ensayo', badge: 'badge-info' },
  pending_approval: { label: 'Pendiente de aprobación', badge: 'badge-warning' },
  scheduled: { label: 'Programada', badge: 'badge-info' },
  running: { label: 'En envío', badge: 'badge-success' },
  paused: { label: 'Pausada', badge: 'badge-warning' },
  completed: { label: 'Completada', badge: 'badge-success' },
  cancelled: { label: 'Cancelada', badge: 'badge-danger' },
};

export const RECIPIENT_STATUS_LABEL: Record<RecipientStatus, { label: string; badge: string }> = {
  pending: { label: 'Pendiente', badge: 'badge-weak' },
  queued: { label: 'En cola', badge: 'badge-info' },
  sent: { label: 'Enviado', badge: 'badge-success' },
  delivered: { label: 'Entregado', badge: 'badge-success' },
  failed: { label: 'Fallido', badge: 'badge-danger' },
  skipped: { label: 'Omitido', badge: 'badge-weak' },
  opted_out: { label: 'Baja', badge: 'badge-warning' },
};

export const ACTIVE_STATUSES = new Set([
  'scheduled',
  'running',
  'paused',
  'completed',
  'cancelled',
]);

export function money(value: string | number | null): string {
  if (value === null) return '—';
  const n = Number(value);
  return new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}
