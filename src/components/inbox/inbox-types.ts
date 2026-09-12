import type {
  CommAccountDTO,
  CommContactDTO,
  CommConversationDTO,
  CommMessageDTO,
  CommNoteDTO,
} from '@/modules/comms/comms-service';
import type { CommitmentDTO, CommitmentSuggestion } from '@/modules/comms/commitments-service';

export type {
  CommAccountDTO,
  CommContactDTO,
  CommConversationDTO,
  CommMessageDTO,
  CommNoteDTO,
  CommitmentDTO,
  CommitmentSuggestion,
};

export interface InboxUserInfo {
  id: string;
  name: string;
  roleKeys: string[];
  canAssign: boolean;
  isAdmin: boolean;
}

export interface InboxUserOption {
  id: string;
  name: string;
  username: string;
}

export interface InboxFilters {
  accountId: string;
  status: 'open' | 'pending' | 'snoozed' | 'resolved' | 'all';
  assigned: 'me' | 'unassigned' | 'all';
  search: string;
}

export interface RealtimeEnvelope {
  channel: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const PROVIDER_LABELS: Record<string, string> = {
  twilio_whatsapp: 'WhatsApp',
  twilio_sms: 'SMS',
  telegram: 'Telegram',
};

export const STATUS_LABELS: Record<string, string> = {
  open: 'Abierta',
  pending: 'Pendiente',
  snoozed: 'Pospuesta',
  resolved: 'Resuelta',
};

export const MESSAGE_STATUS_LABELS: Record<string, string> = {
  received: 'Recibido',
  queued: 'En cola',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'Falló',
  undelivered: 'No entregado',
};

export async function apiJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return data;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}
