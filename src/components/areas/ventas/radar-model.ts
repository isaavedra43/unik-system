import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { RadarSignalDTO } from '@/modules/crm/crm-dto';
import {
  CRM_COMMANDS,
  CRM_OBJECT_TYPES,
  RADAR_KIND_LABELS,
  isRadarKind,
  type RadarKind,
} from '@/modules/crm/types';
import { INBOX_HREF, opportunityHref, quoteHref } from '@/modules/areas/ventas/ventas-constants';

/**
 * Modelo PURO del Radar de cierre (plan 7.6): agrupación, filtros, textos de
 * "siguiente acción" y los comandos que envía cada decisión. Sin React y sin
 * red, así que se prueba solo y la vista sólo pinta.
 *
 * Las decisiones son comandos del motor (`crm.radar.*`), nunca escrituras
 * directas: el servidor vuelve a validar permiso, visibilidad y versión.
 */

export type RadarSalespersonFilter = 'all' | 'me' | 'unassigned' | (string & {});

export interface RadarFilterState {
  salesperson: RadarSalespersonFilter;
  kinds: RadarKind[];
  search: string;
}

export const EMPTY_RADAR_FILTERS: RadarFilterState = { salesperson: 'all', kinds: [], search: '' };

/**
 * Orden de los grupos: primero lo que ya está doliendo al cliente, luego lo que
 * se puede cerrar y al final lo que sólo pide seguimiento.
 */
export const RADAR_KIND_ORDER: readonly RadarKind[] = [
  'delivery_incident',
  'no_first_reply',
  'quote_expiring',
  'high_intent',
  'next_action_overdue',
  'objection_open',
  'no_followup',
  'repurchase_overdue',
];

export const RADAR_GROUP_HINTS: Readonly<Record<RadarKind, string>> = {
  delivery_incident: 'Avísale al cliente antes de que pregunte.',
  no_first_reply: 'Nadie ha contestado el primer mensaje.',
  quote_expiring: 'La cotización vence pronto: confirma o extiéndela.',
  high_intent: 'Quiere comprar y todavía no tiene cotización.',
  next_action_overdue: 'Lo que prometiste hacer ya venció.',
  objection_open: 'Hay una objeción sin resolver.',
  no_followup: 'El cliente escribió al último y nadie siguió.',
  repurchase_overdue: 'Ya le tocaba volver a comprar.',
};

export type RadarTone = 'danger' | 'warning' | 'default';

/** Tono de la barra de puntaje: 75+ urgente, 50+ atención. */
export function radarScoreTone(score: number): RadarTone {
  if (!Number.isFinite(score)) return 'default';
  if (score >= 75) return 'danger';
  if (score >= 50) return 'warning';
  return 'default';
}

/** Ancho de la barra en porcentaje (0–100), tolerante a datos raros. */
export function scoreWidth(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function radarKindLabel(kind: string): string {
  return isRadarKind(kind) ? RADAR_KIND_LABELS[kind] : kind;
}

export function radarKindHint(kind: string): string {
  return isRadarKind(kind) ? RADAR_GROUP_HINTS[kind] : '';
}

export interface RadarGroup {
  kind: string;
  label: string;
  hint: string;
  topScore: number;
  signals: RadarSignalDTO[];
}

const byScore = (a: RadarSignalDTO, b: RadarSignalDTO) =>
  b.score - a.score ||
  Date.parse(b.computedAt) - Date.parse(a.computedAt) ||
  a.id.localeCompare(b.id);

/** Agrupa por tipo de señal en el orden del radar; los tipos desconocidos van al final. */
export function groupSignalsByKind(signals: readonly RadarSignalDTO[]): RadarGroup[] {
  const groups = new Map<string, RadarSignalDTO[]>();
  for (const signal of signals) {
    groups.set(signal.kind, [...(groups.get(signal.kind) ?? []), signal]);
  }
  const order = (kind: string) => {
    const index = RADAR_KIND_ORDER.indexOf(kind as RadarKind);
    return index === -1 ? RADAR_KIND_ORDER.length : index;
  };
  return [...groups.entries()]
    .map(([kind, rows]) => {
      const sorted = [...rows].sort(byScore);
      return {
        kind,
        label: radarKindLabel(kind),
        hint: radarKindHint(kind),
        topScore: sorted[0]?.score ?? 0,
        signals: sorted,
      };
    })
    .sort((a, b) => order(a.kind) - order(b.kind) || b.topScore - a.topScore);
}

/** Filtro en memoria sobre la página ya cargada (el servidor filtra de nuevo). */
export function filterSignals(
  signals: readonly RadarSignalDTO[],
  filters: RadarFilterState,
  userId: string
): RadarSignalDTO[] {
  const search = filters.search.trim().toLowerCase();
  const kinds = new Set<string>(filters.kinds);
  return signals.filter((signal) => {
    if (filters.salesperson === 'me' && signal.salespersonUserId !== userId) return false;
    if (filters.salesperson === 'unassigned' && signal.salespersonUserId !== null) return false;
    if (
      filters.salesperson !== 'all' &&
      filters.salesperson !== 'me' &&
      filters.salesperson !== 'unassigned' &&
      signal.salespersonUserId !== filters.salesperson
    ) {
      return false;
    }
    if (kinds.size > 0 && !kinds.has(signal.kind)) return false;
    if (!search) return true;
    const haystack = [signal.customerName, signal.reason, signal.salespersonName]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLowerCase();
    return haystack.includes(search);
  });
}

export function signalCustomerLabel(signal: RadarSignalDTO): string {
  return signal.customerName?.trim() || 'Cliente sin nombre';
}

/** Qué hacer con la señal, en una frase corta y accionable. */
export function signalNextAction(signal: RadarSignalDTO): string {
  switch (signal.kind) {
    case 'no_first_reply':
      return 'Responde el primer mensaje hoy mismo.';
    case 'no_followup':
      return 'Retoma la conversación con un mensaje de seguimiento.';
    case 'quote_expiring':
      return 'Confirma la cotización o pide más tiempo antes de que venza.';
    case 'next_action_overdue':
      return 'Haz la acción que prometiste o vuelve a agendarla.';
    case 'objection_open':
      return 'Resuelve la objeción y registra la respuesta.';
    case 'high_intent':
      return 'Manda la cotización mientras el cliente está caliente.';
    case 'repurchase_overdue':
      return 'Búscalo: ya se pasó de su ciclo normal de compra.';
    case 'delivery_incident':
      return 'Avisa al cliente del problema de entrega y su nueva fecha.';
    default:
      return 'Revisa el caso y decide el siguiente paso.';
  }
}

/** Enlace del sujeto de la señal (oportunidad, cotización o la bandeja). */
export function signalLink(signal: RadarSignalDTO): { href: string; label: string } | null {
  if (signal.opportunityId) {
    return { href: opportunityHref(signal.opportunityId), label: 'Ver oportunidad' };
  }
  if (signal.quoteId) return { href: quoteHref(signal.quoteId), label: 'Ver cotización' };
  if (signal.conversationId) return { href: INBOX_HREF, label: 'Abrir bandeja' };
  return null;
}

/** La señal ya tiene un borrador de mensaje listo para revisar y enviar. */
export function hasDraft(signal: RadarSignalDTO): boolean {
  return Boolean(signal.aiSuggestedMessage && signal.aiSuggestedMessage.trim().length > 0);
}

/** Sólo se puede preparar un mensaje cuando hay a quién escribirle. */
export function canPrepareMessage(signal: RadarSignalDTO): boolean {
  return Boolean(signal.conversationId || signal.commContactId || signal.opportunityId);
}

// ---------------------------------------------------------------------------
// Posponer
// ---------------------------------------------------------------------------

export const SNOOZE_MIN_MINUTES = 5;
export const SNOOZE_MAX_DAYS = 30;

export interface SnoozeOption {
  id: string;
  label: string;
  until: string;
}

/** Opciones de "Posponer" calculadas desde la hora del servidor recibida. */
export function snoozeOptions(now: Date): SnoozeOption[] {
  const plus = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString();
  return [
    { id: '4h', label: 'En 4 horas', until: plus(4) },
    { id: '1d', label: 'Mañana', until: plus(24) },
    { id: '3d', label: 'En 3 días', until: plus(72) },
    { id: '7d', label: 'En una semana', until: plus(168) },
  ];
}

/** Mismo límite que el comando: entre 5 minutos y 30 días. */
export function snoozeError(untilIso: string, now: Date): string | null {
  const until = Date.parse(untilIso);
  if (!Number.isFinite(until)) return 'La fecha para posponer no es válida';
  if (until < now.getTime() + SNOOZE_MIN_MINUTES * 60_000) {
    return 'Pospón la señal al menos 5 minutos';
  }
  if (until > now.getTime() + SNOOZE_MAX_DAYS * 86_400_000) {
    return 'Una señal se pospone como máximo 30 días';
  }
  return null;
}

export function dismissError(reason: string): string | null {
  return reason.trim().length > 500 ? 'El motivo admite hasta 500 caracteres' : null;
}

export function convertError(input: { title: string; dueAt: string }, now: Date): string | null {
  const title = input.title.trim();
  if (title.length > 0 && title.length < 2) return 'El título necesita al menos 2 caracteres';
  if (title.length > 160) return 'El título admite hasta 160 caracteres';
  if (input.dueAt.trim()) {
    const due = Date.parse(input.dueAt);
    if (!Number.isFinite(due)) return 'La fecha de la tarea no es válida';
    if (due <= now.getTime()) return 'La tarea debe vencer en el futuro';
  }
  return null;
}

/** Título por defecto de la tarea que nace de una señal. */
export function defaultTaskTitle(signal: RadarSignalDTO): string {
  const title = `${radarKindLabel(signal.kind)}: ${signalCustomerLabel(signal)}`;
  return title.length > 160 ? `${title.slice(0, 159)}…` : title;
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

const aggregateOf = (signal: RadarSignalDTO) => ({
  type: CRM_OBJECT_TYPES.radarSignal,
  id: signal.id,
});

export function buildSnoozeCommand(
  signal: RadarSignalDTO,
  untilIso: string,
  note?: string
): OfflineCommandInput<Record<string, unknown>> {
  const trimmed = note?.trim();
  return {
    type: CRM_COMMANDS.radarSnooze,
    aggregate: aggregateOf(signal),
    payload: { signalId: signal.id, until: untilIso, ...(trimmed ? { note: trimmed } : {}) },
    expectedVersion: signal.version,
  };
}

export function buildDismissCommand(
  signal: RadarSignalDTO,
  reason?: string
): OfflineCommandInput<Record<string, unknown>> {
  const trimmed = reason?.trim();
  return {
    type: CRM_COMMANDS.radarDismiss,
    aggregate: aggregateOf(signal),
    payload: { signalId: signal.id, ...(trimmed ? { reason: trimmed } : {}) },
    expectedVersion: signal.version,
  };
}

export function buildConvertCommand(
  signal: RadarSignalDTO,
  input: { title?: string; dueAt?: string } = {}
): OfflineCommandInput<Record<string, unknown>> {
  const title = input.title?.trim();
  const dueAt = input.dueAt?.trim();
  return {
    type: CRM_COMMANDS.radarConvertToTask,
    aggregate: aggregateOf(signal),
    payload: {
      signalId: signal.id,
      ...(title ? { title } : {}),
      ...(dueAt ? { dueAt: new Date(dueAt).toISOString() } : {}),
    },
    expectedVersion: signal.version,
  };
}

// ---------------------------------------------------------------------------
// Contexto para la IA del área
// ---------------------------------------------------------------------------

export const RADAR_CONTEXT_SIGNALS = 15;

/**
 * Lo que ve la persona en el radar, enviado como DATOS al copiloto del área
 * (el orquestador lo acota y lo envuelve como contenido no confiable).
 */
export function radarCopilotContext(input: {
  signals: readonly RadarSignalDTO[];
  filters: RadarFilterState;
  selected: RadarSignalDTO | null;
  total: number;
}): Record<string, unknown> {
  return {
    surface: 'area',
    areaKey: 'ventas',
    space: 'radar',
    filters: {
      salesperson: input.filters.salesperson,
      kinds: input.filters.kinds,
      search: input.filters.search.trim() || null,
    },
    total: input.total,
    visible: Math.min(input.signals.length, RADAR_CONTEXT_SIGNALS),
    ...(input.selected
      ? {
          signalId: input.selected.id,
          signal: {
            id: input.selected.id,
            kind: input.selected.kind,
            kindLabel: input.selected.kindLabel,
            score: input.selected.score,
            reason: input.selected.reason,
            customerName: input.selected.customerName,
            opportunityId: input.selected.opportunityId,
            conversationId: input.selected.conversationId,
            quoteId: input.selected.quoteId,
            hasDraft: hasDraft(input.selected),
          },
        }
      : {}),
    signals: input.signals.slice(0, RADAR_CONTEXT_SIGNALS).map((signal) => ({
      id: signal.id,
      kind: signal.kind,
      score: signal.score,
      customerName: signal.customerName,
      salesperson: signal.salespersonName,
      reason: signal.reason,
      opportunityId: signal.opportunityId,
      conversationId: signal.conversationId,
    })),
  };
}

/** Arranques del copiloto en el radar (todo lo que pide existe como tool). */
export function radarStarters(selected: RadarSignalDTO | null): string[] {
  if (selected) {
    return [
      `Prepara el mensaje para ${signalCustomerLabel(selected)}`,
      '¿Por qué importa esta señal?',
      '¿Qué le digo si pide descuento?',
      '¿Qué señales cierro hoy?',
    ];
  }
  return [
    '¿Qué señales cierro hoy?',
    'Prepara mensajes de seguimiento',
    '¿Qué cotizaciones están por vencer?',
    '¿Qué clientes llevan más tiempo esperando?',
  ];
}
