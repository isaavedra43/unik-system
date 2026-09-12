import { Prisma, type Commitment } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { publishRealtime, REALTIME_CHANNELS } from '@/modules/realtime/realtime-service';
import { assertInboxUse, isInboxAdmin } from './comms-access';
import { CommsError, assertFound } from './comms-errors';

/**
 * Commitments made to contacts ("te envío la cotización mañana"). Created by
 * people (or by the assistant through an approved internal task), swept
 * hourly for overdue items, and SUGGESTED heuristically from outbound text —
 * suggestions are never persisted without confirmation.
 */

export const COMMITMENT_SOURCES = [
  'comm_message',
  'ai_conversation',
  'call',
  'request',
  'manual',
] as const;

export const createCommitmentSchema = z.object({
  description: z.string().min(3).max(500),
  dueAt: z.string().datetime().nullable().optional(),
  contactId: z.string().nullable().optional(),
  sourceType: z.enum(COMMITMENT_SOURCES).default('manual'),
  sourceId: z.string().nullable().optional(),
  ownerUserId: z.string().optional(),
});

export const updateCommitmentSchema = z.object({
  description: z.string().min(3).max(500).optional(),
  dueAt: z.string().datetime().nullable().optional(),
  status: z.enum(['pending', 'done', 'cancelled']).optional(),
});

export type CreateCommitmentInput = z.infer<typeof createCommitmentSchema>;

export interface CommitmentDTO {
  id: string;
  description: string;
  ownerUserId: string;
  ownerName: string | null;
  contactId: string | null;
  contactName: string | null;
  sourceType: string;
  sourceId: string | null;
  dueAt: string | null;
  status: string;
  completedAt: string | null;
  createdAt: string;
}

async function toDTOs(rows: Commitment[]): Promise<CommitmentDTO[]> {
  const userIds = [...new Set(rows.map((r) => r.ownerUserId))];
  const contactIds = [
    ...new Set(rows.map((r) => r.contactId).filter((x): x is string => Boolean(x))),
  ];
  const [users, contacts] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [],
    contactIds.length
      ? prisma.commContact.findMany({
          where: { id: { in: contactIds } },
          select: { id: true, displayName: true },
        })
      : [],
  ]);
  const userMap = new Map(users.map((u) => [u.id, u.name]));
  const contactMap = new Map(contacts.map((c) => [c.id, c.displayName]));
  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    ownerUserId: r.ownerUserId,
    ownerName: userMap.get(r.ownerUserId) ?? null,
    contactId: r.contactId,
    contactName: r.contactId ? (contactMap.get(r.contactId) ?? null) : null,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    dueAt: r.dueAt?.toISOString() ?? null,
    status: r.status,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function createCommitment(
  actor: CurrentUser,
  input: CreateCommitmentInput
): Promise<CommitmentDTO> {
  assertInboxUse(actor);
  const ownerUserId = input.ownerUserId ?? actor.id;
  if (ownerUserId !== actor.id) {
    const owner = await prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { isActive: true },
    });
    if (!owner || !owner.isActive) throw new CommsError('Responsable no válido', 400);
  }
  const row = await prisma.commitment.create({
    data: {
      description: input.description.trim(),
      ownerUserId,
      contactId: input.contactId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
    },
  });
  if (ownerUserId !== actor.id) {
    await publishRealtime(REALTIME_CHANNELS.user(ownerUserId), 'commitment', {
      commitmentId: row.id,
      type: 'assigned',
    }).catch(() => undefined);
  }
  return (await toDTOs([row]))[0];
}

export async function listCommitments(
  actor: CurrentUser,
  filters: { scope?: 'mine' | 'all'; status?: string; contactId?: string; limit?: number } = {}
): Promise<CommitmentDTO[]> {
  assertInboxUse(actor);
  const where: Prisma.CommitmentWhereInput = {};
  if (filters.scope !== 'all' || !isInboxAdmin(actor)) where.ownerUserId = actor.id;
  if (filters.contactId) {
    where.contactId = filters.contactId;
    // Anyone working the contact's conversation may see its commitments.
    delete where.ownerUserId;
  }
  if (filters.status && filters.status !== 'all') where.status = filters.status;
  else if (!filters.status) where.status = { in: ['pending', 'overdue'] };
  const rows = await prisma.commitment.findMany({
    where,
    orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
    take: Math.min(500, filters.limit ?? 100),
  });
  return toDTOs(rows);
}

export async function updateCommitment(
  actor: CurrentUser,
  id: string,
  patch: z.infer<typeof updateCommitmentSchema>
): Promise<CommitmentDTO> {
  assertInboxUse(actor);
  const row = assertFound(
    await prisma.commitment.findUnique({ where: { id } }),
    'Compromiso no encontrado'
  );
  if (row.ownerUserId !== actor.id && !isInboxAdmin(actor))
    throw new CommsError('Compromiso no encontrado', 404);
  const data: Prisma.CommitmentUpdateInput = {};
  if (patch.description !== undefined) data.description = patch.description.trim();
  if (patch.dueAt !== undefined) {
    data.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
    if (row.status === 'overdue' && data.dueAt && (data.dueAt as Date) > new Date())
      data.status = 'pending';
  }
  if (patch.status !== undefined) {
    data.status = patch.status;
    data.completedAt = patch.status === 'done' ? new Date() : null;
  }
  const updated = await prisma.commitment.update({ where: { id }, data });
  return (await toDTOs([updated]))[0];
}

/** Marks due commitments as overdue and notifies each owner. Returns the ids changed. */
export async function markOverdueCommitments(now: Date = new Date()): Promise<string[]> {
  const due = await prisma.commitment.findMany({
    where: { status: 'pending', dueAt: { lt: now } },
    select: { id: true, ownerUserId: true, description: true },
    take: 500,
  });
  if (due.length === 0) return [];
  await prisma.commitment.updateMany({
    where: { id: { in: due.map((d) => d.id) } },
    data: { status: 'overdue' },
  });
  for (const item of due) {
    await publishRealtime(REALTIME_CHANNELS.user(item.ownerUserId), 'commitment', {
      commitmentId: item.id,
      type: 'overdue',
      description: item.description,
    }).catch(() => undefined);
  }
  return due.map((d) => d.id);
}

// ---------------------------------------------------------------------------
// Heuristic suggestions (never persisted automatically)
// ---------------------------------------------------------------------------

export interface CommitmentSuggestion {
  description: string;
  dueAt: string | null;
  confidence: 'high' | 'medium';
  matched: string;
}

const TRIGGERS: RegExp[] = [
  /\b(te|le|les|se lo|se la|se los|se las)\s+(env[ií]o|mando|comparto|paso|confirmo|llamo|marco|aviso|hago llegar|preparo|cotizo|entrego|resuelvo|reviso)\b/i,
  /\b(me comprometo|quedamos en|queda pendiente|lo reviso|lo checo|lo verifico|le doy seguimiento|damos seguimiento|te doy seguimiento)\b/i,
  /\b(mañana|hoy|pasado mañana|esta semana|la pr[oó]xima semana|la semana que viene)\s+(te|le|se lo|lo)\s+/i,
];

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sábado: 6,
};

function atHour(date: Date, hour: number, minute = 0): Date {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function nextWeekday(from: Date, weekday: number): Date {
  const d = new Date(from);
  const diff = (weekday - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

/** Resolves Spanish relative time expressions found in a sentence. */
export function parseRelativeDue(sentence: string, now: Date): Date | null {
  const text = sentence
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  let base: Date | null = null;
  let hour = 12;
  let minute = 0;
  const hourMatch = text.match(
    /\ba las?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|h|hrs|de la tarde|de la manana|de la noche)?/
  );
  if (hourMatch) {
    hour = Number(hourMatch[1]);
    minute = hourMatch[2] ? Number(hourMatch[2]) : 0;
    const suffix = hourMatch[3] ?? '';
    if ((suffix === 'pm' || suffix.includes('tarde') || suffix.includes('noche')) && hour < 12)
      hour += 12;
    if (hour > 23) hour = 23;
  }
  if (/\bpasado manana\b/.test(text)) {
    base = new Date(now);
    base.setDate(base.getDate() + 2);
  } else if (/\bmanana\b/.test(text)) {
    base = new Date(now);
    base.setDate(base.getDate() + 1);
  } else if (/\bhoy\b/.test(text)) {
    base = new Date(now);
    if (!hourMatch) hour = 18;
  } else if (/\b(la proxima semana|la semana que viene|la siguiente semana)\b/.test(text)) {
    base = nextWeekday(now, 1);
  } else if (/\besta semana\b/.test(text)) {
    base = now.getDay() >= 5 || now.getDay() === 0 ? nextWeekday(now, 5) : nextWeekday(now, 5);
  } else {
    const day = text.match(
      /\b(el|este|el proximo|el siguiente)?\s*(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/
    );
    if (day) base = nextWeekday(now, WEEKDAYS[day[2]] ?? 1);
    const rel = text.match(/\ben\s+(\d{1,3})\s+(minutos?|horas?|dias?|semanas?)\b/);
    if (!base && rel) {
      const n = Number(rel[1]);
      const unit = rel[2];
      const d = new Date(now);
      if (unit.startsWith('minuto')) d.setMinutes(d.getMinutes() + n);
      else if (unit.startsWith('hora')) d.setHours(d.getHours() + n);
      else if (unit.startsWith('dia')) d.setDate(d.getDate() + n);
      else d.setDate(d.getDate() + n * 7);
      return unit.startsWith('minuto') || unit.startsWith('hora') ? d : atHour(d, hour, minute);
    }
  }
  if (!base) return null;
  return atHour(base, hour, minute);
}

/** Proposes commitments found in an outbound text. Pure and deterministic. */
export function suggestCommitments(text: string, now: Date = new Date()): CommitmentSuggestion[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6);
  const out: CommitmentSuggestion[] = [];
  for (const sentence of sentences) {
    const trigger = TRIGGERS.find((re) => re.test(sentence));
    if (!trigger) continue;
    const dueAt = parseRelativeDue(sentence, now);
    out.push({
      description: sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence,
      dueAt: dueAt ? dueAt.toISOString() : null,
      confidence: dueAt ? 'high' : 'medium',
      matched: sentence.match(trigger)?.[0] ?? '',
    });
  }
  return out.slice(0, 5);
}
