import { AREA_REQUEST_KIND_CATALOG, isAreaRequestKind } from '@/modules/operations/request-kinds';
import {
  AREA_LABELS,
  CASE_PHASE_LABELS,
  CASE_STATUS_LABELS,
  INCIDENT_KIND_LABELS,
  INCIDENT_SEVERITY_LABELS,
  isAreaKey,
} from '@/modules/operations/types';

/**
 * Template messages of the agents layer (plan 5.3): ZERO model calls. Pure and
 * deterministic (pass `now`/`occurredAt` for stable output).
 *
 * - `renderAgentMessage(kind, ctx)` → `{text, timelineLine}`: the chat post of a
 *   bot and the one-line entry of the case timeline.
 * - `formatTimelineLine(event, ctx?)` renders any `OperationalEvent` as
 *   `09:29 Compras recibió solicitud por 15 m²` in Mexico City time, so the
 *   case room and the case timeline never diverge.
 *
 * Every field of the context is optional: a missing value drops its part of
 * the sentence instead of breaking it. Free text is collapsed, truncated and
 * its `@` neutralized so a template never creates chat mentions.
 */

export const AGENT_TIMEZONE = 'America/Mexico_City';

export const AGENT_MESSAGE_KINDS = [
  'request.created',
  'request.acknowledged',
  'request.accepted',
  'request.blocked',
  'request.resolved',
  'request.rejected',
  'request.cancelled',
  'request.expired',
  'request.overdue',
  'workitem.assigned',
  'workitem.overdue',
  'workitem.completed',
  'incident.opened',
  'incident.resolved',
  'proposal.created',
  'proposal.approved',
  'proposal.rejected',
  'proposal.failed',
  'case.started',
  'case.delivered',
  'budget.exhausted',
] as const;

export type AgentMessageKind = (typeof AGENT_MESSAGE_KINDS)[number];

export function isAgentMessageKind(value: unknown): value is AgentMessageKind {
  return typeof value === 'string' && (AGENT_MESSAGE_KINDS as readonly string[]).includes(value);
}

type DateInput = Date | string | number | null | undefined;
type QuantityInput = number | string | null | undefined;

export interface AgentMessageContext {
  /** Reference time for "hoy/mañana" (default: now). */
  now?: Date;
  /** When the fact happened (timeline clock; default: `now`). */
  occurredAt?: DateInput;
  /** IANA time zone (default America/Mexico_City). */
  tz?: string;

  caseNumber?: string | null;
  salesOrderNumber?: string | null;
  customerName?: string | null;

  /** Area the message is about (work item, incident, case fact). */
  areaKey?: string | null;
  fromAreaKey?: string | null;
  toAreaKey?: string | null;

  requestKind?: string | null;
  title?: string | null;
  productName?: string | null;
  sku?: string | null;
  quantity?: QuantityInput;
  unit?: string | null;
  neededBy?: DateInput;
  blocksDelivery?: boolean | null;

  ownerName?: string | null;
  backupName?: string | null;
  dueAt?: DateInput;
  /** Person who did it (accepted, completed, resolved...). */
  actorName?: string | null;
  reason?: string | null;
  note?: string | null;

  workItemTitle?: string | null;
  overdueMinutes?: number | null;
  /** 0-based escalation level of the operations core. */
  escalationLevel?: number | null;

  incidentTitle?: string | null;
  incidentKind?: string | null;
  severity?: string | null;
  resolution?: string | null;

  toolName?: string | null;
  proposalSummary?: string | null;
  expiresAt?: DateInput;
  approverName?: string | null;
  error?: string | null;

  agentName?: string | null;
  responsibleName?: string | null;

  promisedAt?: DateInput;
  deliveredAt?: DateInput;
  incidentCount?: number | null;
}

export interface RenderedAgentMessage {
  text: string;
  timelineLine: string;
}

/** An `OperationalEvent` (or its record/DTO) as the timeline needs it. */
export interface TimelineEvent {
  id?: string | null;
  type: string;
  occurredAt: DateInput;
  areaKey?: string | null;
  actorType?: string | null;
  payload?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const UNIT_LABELS: Record<string, string> = {
  m2: 'm²',
  'm^2': 'm²',
  m3: 'm³',
  'm^3': 'm³',
};

/**
 * Neutralizes `@` with a zero-width space after it, so text written by a model or a third party
 * never resolves chat mentions (nor pushes notifications) when a bot posts it. Pure.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?!​)/g, '@​');
}

/** Collapses whitespace, truncates with an ellipsis and neutralizes `@` (no chat mentions). */
export function cleanText(value: unknown, max = 160): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).replace(/\s+/g, ' ').trim().replace(/@/g, '@​');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: string;
  minute: string;
}

function localParts(date: Date, tz: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[];
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { ...options, timeZone: AGENT_TIMEZONE }).formatToParts(date);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: get('hour').padStart(2, '0'),
    minute: get('minute').padStart(2, '0'),
  };
}

/** `09:29` in the time zone (24 h). */
export function formatClock(value: DateInput, tz = AGENT_TIMEZONE): string {
  const date = toDate(value);
  if (!date) return '--:--';
  const p = localParts(date, tz);
  return `${p.hour}:${p.minute}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `18 sep` in the time zone. A date-only string (`2026-09-18`) is a calendar day, not UTC midnight. */
export function formatShortDate(value: DateInput, tz = AGENT_TIMEZONE): string {
  if (typeof value === 'string') {
    const match = DATE_ONLY.exec(value.trim());
    if (match) {
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return `${day} ${MONTHS[month - 1]}`;
    }
  }
  const date = toDate(value);
  if (!date) return '';
  const p = localParts(date, tz);
  return `${p.day} ${MONTHS[p.month - 1] ?? ''}`.trim();
}

/** `hoy 17:00`, `mañana 09:00`, `ayer 18:30` or `18 sep 17:00` relative to `now`. */
export function formatDueLabel(value: DateInput, now: Date = new Date(), tz = AGENT_TIMEZONE): string {
  const date = toDate(value);
  if (!date) return '';
  const target = localParts(date, tz);
  const today = localParts(now, tz);
  const days = Math.round(
    (Date.UTC(target.year, target.month - 1, target.day) - Date.UTC(today.year, today.month - 1, today.day)) /
      86_400_000
  );
  const clock = `${target.hour}:${target.minute}`;
  if (days === 0) return `hoy ${clock}`;
  if (days === 1) return `mañana ${clock}`;
  if (days === -1) return `ayer ${clock}`;
  const sameYear = target.year === today.year;
  return `${target.day} ${MONTHS[target.month - 1] ?? ''}${sameYear ? '' : ` ${target.year}`} ${clock}`;
}

/** `45 min`, `2 h`, `2 h 30 min`, `1 d 3 h`. */
export function formatDuration(minutes: number | null | undefined): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return '';
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  if (total < 1440) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  return h > 0 ? `${d} d ${h} h` : `${d} d`;
}

/** `15 m²`, `1,250.5 kg`; empty when the quantity is not a finite number. */
export function formatQuantity(quantity: QuantityInput, unit?: string | null): string {
  if (quantity === null || quantity === undefined || quantity === '') return '';
  const n = typeof quantity === 'number' ? quantity : Number(String(quantity).trim());
  if (!Number.isFinite(n)) return '';
  const amount = n.toLocaleString('es-MX', { maximumFractionDigits: 3 });
  const cleanUnit = cleanText(unit ?? '', 20);
  const label = UNIT_LABELS[cleanUnit.toLowerCase()] ?? cleanUnit;
  return label ? `${amount} ${label}` : amount;
}

export function areaLabel(areaKey: unknown): string | null {
  if (isAreaKey(areaKey)) return AREA_LABELS[areaKey];
  const text = cleanText(areaKey, 40);
  return text || null;
}

function requestKindLabel(kind: unknown): string | null {
  return isAreaRequestKind(kind) ? AREA_REQUEST_KIND_CATALOG[kind].label : null;
}

function severityLabel(severity: unknown): string | null {
  return typeof severity === 'string' && severity in INCIDENT_SEVERITY_LABELS
    ? INCIDENT_SEVERITY_LABELS[severity as keyof typeof INCIDENT_SEVERITY_LABELS].toLowerCase()
    : null;
}

function incidentKindLabel(kind: unknown): string | null {
  return typeof kind === 'string' && kind in INCIDENT_KIND_LABELS
    ? INCIDENT_KIND_LABELS[kind as keyof typeof INCIDENT_KIND_LABELS]
    : null;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const num = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};

function reference(ctx: AgentMessageContext): string {
  const ref = cleanText(ctx.salesOrderNumber, 40) || cleanText(ctx.caseNumber, 40);
  return ref ? ` · ${ref}` : '';
}

function stripEndPeriod(text: string): string {
  return text.replace(/[.\s]+$/, '');
}

function sentence(icon: string, head: string, subject: string, tails: Array<string | null | undefined | false>): string {
  const parts = tails.filter((t): t is string => typeof t === 'string' && t.length > 0);
  const body = subject ? ` — ${stripEndPeriod(subject)}` : '';
  return `${icon} ${head}${body}${parts.length > 0 ? `. ${parts.join(' · ')}` : ''}`;
}

function responsiblePart(ctx: AgentMessageContext): string | null {
  const owner = cleanText(ctx.ownerName, 60);
  if (!owner) return null;
  const backup = cleanText(ctx.backupName, 60);
  return `Responsable: ${owner}${backup ? ` (respaldo ${backup})` : ''}`;
}

function duePart(ctx: AgentMessageContext, label = 'Vence'): string | null {
  const due = formatDueLabel(ctx.dueAt, ctx.now ?? new Date(), ctx.tz ?? AGENT_TIMEZONE);
  return due ? `${label} ${due}` : null;
}

function actorPart(ctx: AgentMessageContext): string | null {
  const actor = cleanText(ctx.actorName, 60);
  return actor ? `Por ${actor}` : null;
}

function reasonPart(ctx: AgentMessageContext, label = 'Motivo'): string | null {
  const reason = cleanText(ctx.reason, 200);
  return reason ? `${label}: ${reason}` : null;
}

const SHORTFALL_KINDS = new Set(['purchase_shortfall', 'material_shortfall', 'direct_delivery']);

/** Subject of a request: the missing quantity when known, else its title or kind. */
function requestSubject(ctx: AgentMessageContext): string {
  const tz = ctx.tz ?? AGENT_TIMEZONE;
  const qty = formatQuantity(ctx.quantity, ctx.unit);
  const product = cleanText(ctx.productName, 80);
  const sku = cleanText(ctx.sku, 40);
  const item = product ? `${product}${sku ? ` (${sku})` : ''}` : sku;
  const needed = formatShortDate(ctx.neededBy, tz);
  const kind = str(ctx.requestKind);
  if (qty && item) {
    const shortfall = !kind || SHORTFALL_KINDS.has(kind);
    const base = shortfall ? `Faltan ${qty} de ${item}` : `${requestKindLabel(kind) ?? 'Solicitud'}: ${qty} de ${item}`;
    return needed ? `${base} para entregar el ${needed}` : base;
  }
  const title = cleanText(ctx.title, 160);
  if (title) return title;
  return requestKindLabel(kind) ?? '';
}

function timelineQuantity(ctx: AgentMessageContext | undefined, payload: Record<string, unknown>): string {
  return (
    formatQuantity(ctx?.quantity, ctx?.unit) ||
    formatQuantity(
      num(payload.missingQty) ?? num(payload.quantity) ?? num(payload.qty),
      str(payload.unit)
    )
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

type PhraseBuilder = (event: TimelineEvent, payload: Record<string, unknown>, ctx: AgentMessageContext | undefined) => string;

function requestAreas(event: TimelineEvent, payload: Record<string, unknown>, ctx: AgentMessageContext | undefined) {
  const to = areaLabel(ctx?.toAreaKey ?? payload.toAreaKey ?? event.areaKey) ?? 'El área destino';
  const from = areaLabel(ctx?.fromAreaKey ?? payload.fromAreaKey);
  return { to, ofFrom: from ? ` de ${from}` : '' };
}

function timelineReason(payload: Record<string, unknown>, ctx: AgentMessageContext | undefined): string {
  const reason = cleanText(ctx?.reason ?? payload.reason, 120);
  return reason ? `: ${reason}` : '';
}

function workItemTitle(payload: Record<string, unknown>, ctx: AgentMessageContext | undefined): string {
  return cleanText(ctx?.workItemTitle ?? ctx?.title ?? payload.title, 100);
}

function eventArea(event: TimelineEvent, ctx: AgentMessageContext | undefined, fallback: string): string {
  return areaLabel(event.areaKey ?? ctx?.areaKey) ?? fallback;
}

const AGENT_TRIGGER_LABELS: Record<string, string> = {
  interpret_request: 'una solicitud con texto libre',
  unblock: 'un bloqueo',
  triage: 'una incidencia',
  replan_check: 'una replanificación',
  stuck_review: 'un expediente detenido',
  mention: 'una mención',
  action_failed: 'una acción que falló',
  case_summary: 'el resumen del expediente',
};

/** Spanish name of an agent identity key (`area:compras` → IA de Compras). Pure. */
function agentLabelOf(agentKey: unknown): string {
  if (agentKey === 'admin') return 'IA administradora';
  if (typeof agentKey === 'string' && agentKey.startsWith('area:')) {
    const area = areaLabel(agentKey.slice(5));
    if (area) return `IA de ${area}`;
  }
  return 'La IA';
}

function triggerLabelOf(trigger: unknown): string {
  return typeof trigger === 'string' ? (AGENT_TRIGGER_LABELS[trigger] ?? 'un aviso') : 'un aviso';
}

const PHRASES: Record<string, PhraseBuilder> = {
  'request.created': (event, p, ctx) => {
    const { to, ofFrom } = requestAreas(event, p, ctx);
    const qty = timelineQuantity(ctx, p);
    if (qty) return `${to} recibió solicitud por ${qty}`;
    const kind = requestKindLabel(ctx?.requestKind ?? p.kind);
    return `${to} recibió solicitud${ofFrom}${kind ? `: ${kind}` : ''}`;
  },
  'request.acknowledged': (e, p, c) => {
    const { to, ofFrom } = requestAreas(e, p, c);
    return `${to} acusó recibo de la solicitud${ofFrom}`;
  },
  'request.accepted': (e, p, c) => {
    const { to, ofFrom } = requestAreas(e, p, c);
    return `${to} aceptó la solicitud${ofFrom}`;
  },
  'request.blocked': (e, p, c) => {
    const { to, ofFrom } = requestAreas(e, p, c);
    return `${to} bloqueó la solicitud${ofFrom}${timelineReason(p, c)}`;
  },
  'request.resolved': (e, p, c) => {
    const { to, ofFrom } = requestAreas(e, p, c);
    return `${to} resolvió la solicitud${ofFrom}`;
  },
  'request.rejected': (e, p, c) => {
    const { to, ofFrom } = requestAreas(e, p, c);
    return `${to} rechazó la solicitud${ofFrom}${timelineReason(p, c)}`;
  },
  'request.cancelled': (e, p, c) => `Se canceló la solicitud a ${requestAreas(e, p, c).to}${timelineReason(p, c)}`,
  'request.expired': (e, p, c) => `Venció sin respuesta la solicitud a ${requestAreas(e, p, c).to}`,
  'request.overdue': (e, p, c) => {
    const late = formatDuration(c?.overdueMinutes ?? num(p.overdueMinutes));
    return `Venció la solicitud a ${requestAreas(e, p, c).to}${late ? ` (hace ${late})` : ''}`;
  },
  'workitem.created': (e, p, c) => {
    const title = workItemTitle(p, c);
    return `${eventArea(e, c, 'Un área')} tiene trabajo nuevo${title ? `: ${title}` : ''}`;
  },
  'workitem.assigned': (e, p, c) => {
    const title = workItemTitle(p, c);
    const owner = cleanText(c?.ownerName, 60);
    return `${eventArea(e, c, 'Un área')} tiene trabajo nuevo${title ? `: ${title}` : ''}${owner ? ` (${owner})` : ''}`;
  },
  'workitem.reassigned': (e, _p, c) => {
    const owner = cleanText(c?.ownerName, 60);
    return `Se reasignó un trabajo de ${eventArea(e, c, 'un área')}${owner ? ` a ${owner}` : ''}`;
  },
  'workitem.started': (e, p, c) => {
    const title = workItemTitle(p, c);
    return `${eventArea(e, c, 'Un área')} empezó ${title ? `"${title}"` : 'un trabajo'}`;
  },
  'workitem.waiting': (e, _p, c) => `Un trabajo de ${eventArea(e, c, 'un área')} quedó en espera`,
  'workitem.completed': (e, p, c) => {
    const title = workItemTitle(p, c);
    return `${eventArea(e, c, 'Un área')} completó ${title ? `"${title}"` : 'un trabajo'}`;
  },
  'workitem.cancelled': (e, _p, c) => `Se canceló un trabajo de ${eventArea(e, c, 'un área')}`,
  'workitem.overdue': (e, p, c) => {
    const title = workItemTitle(p, c);
    const late = formatDuration(c?.overdueMinutes ?? num(p.overdueMinutes));
    return `Venció un trabajo de ${eventArea(e, c, 'un área')}${title ? `: ${title}` : ''}${late ? ` (hace ${late})` : ''}`;
  },
  'workitem.escalated': (e, p, c) => {
    const level = c?.escalationLevel ?? num(p.level);
    return `Se escaló un trabajo de ${eventArea(e, c, 'un área')}${level !== null && level !== undefined ? ` (nivel ${level + 1})` : ''}`;
  },
  'incident.opened': (e, p, c) => {
    const title = cleanText(c?.incidentTitle ?? c?.title ?? p.title, 100) || incidentKindLabel(c?.incidentKind ?? p.kind) || 'sin título';
    const severity = severityLabel(c?.severity ?? p.severity);
    return `Incidencia${severity ? ` ${severity}` : ''} en ${eventArea(e, c, 'un área')}: ${title}`;
  },
  'incident.acknowledged': (e, _p, c) => `${eventArea(e, c, 'Un área')} tomó la incidencia`,
  'incident.resolved': (e, p, c) => {
    const title = cleanText(c?.incidentTitle ?? c?.title ?? p.title, 100);
    return `Se resolvió la incidencia${title ? ` "${title}"` : ''} en ${eventArea(e, c, 'un área')}`;
  },
  'incident.dismissed': (e, _p, c) => `Se descartó la incidencia en ${eventArea(e, c, 'un área')}`,
  'case.created': (_e, p, c) => {
    const caseNumber = cleanText(c?.caseNumber ?? p.caseNumber, 40);
    const so = cleanText(c?.salesOrderNumber ?? p.salesOrderNumber, 40);
    return `Se abrió el expediente${caseNumber ? ` ${caseNumber}` : ''}${so ? ` de ${so}` : ''}`;
  },
  'case.replanned': (_e, p) => {
    const summary = cleanText(p.summary, 120);
    return `Se replanificó el expediente${summary ? `: ${summary}` : ''}`;
  },
  'case.stuck': (_e, p) => {
    const idle = formatDuration(num(p.idleMinutes));
    return idle ? `El expediente lleva ${idle} sin avance` : 'El expediente se atoró sin avance';
  },
  'case.delivered': (e, _p, c) => `${eventArea(e, c, 'Logística')} entregó el pedido`,
  'case.operational_closed': () => 'Cierre operativo del expediente',
  'case.financial_closed': () => 'Cierre financiero del expediente',
  'case.cancelled': (_e, p, c) => `Se canceló el expediente${timelineReason(p, c)}`,
  'case.owner_changed': () => 'Cambió el responsable del expediente',
  'case.status_changed': (_e, p) => {
    const to = typeof p.to === 'string' ? (CASE_STATUS_LABELS as Record<string, string>)[p.to] : undefined;
    return to ? `El expediente pasó a ${to.toLowerCase()}` : 'Cambió el estado del expediente';
  },
  'case.phase_changed': (_e, p) => {
    const to = typeof p.to === 'string' ? (CASE_PHASE_LABELS as Record<string, string>)[p.to] : undefined;
    return to ? `El expediente pasó a la fase de ${to.toLowerCase()}` : 'Cambió la fase del expediente';
  },
  'demand.shortfall_confirmed': (e, p, c) => {
    const qty = timelineQuantity(c, p);
    return `${eventArea(e, c, 'Inventario')} confirmó faltante${qty ? ` de ${qty}` : ''}`;
  },
  'demand.cancelled': () => 'Se canceló una partida del expediente',
  'demand.changed': () => 'Cambió una partida del expediente',
  'demand.fulfilled': () => 'Se cubrió una partida del expediente',
  'stock.reserved': (e, _p, c) => `${eventArea(e, c, 'Inventario')} reservó existencias`,
  'stock.reserved_provisional': (e, _p, c) => `${eventArea(e, c, 'Inventario')} reservó existencias sin conteo confirmado`,
  'stock.released': (e, _p, c) => `${eventArea(e, c, 'Inventario')} liberó una reserva`,
  'stock.received': (e, _p, c) => `${eventArea(e, c, 'Inventario')} recibió material`,
  'stock.issued': (e, _p, c) => `${eventArea(e, c, 'Inventario')} surtió material`,
  'order.prepared': (e, _p, c) => `${eventArea(e, c, 'Inventario')} preparó el pedido`,
  'production.started': (e, _p, c) => `${eventArea(e, c, 'Manufactura')} inició producción`,
  'production.finished': (e, _p, c) => `${eventArea(e, c, 'Manufactura')} terminó producción`,
  'delivery.planned': (e, _p, c) => `${eventArea(e, c, 'Logística')} planeó la entrega`,
  'delivery.dispatched': () => 'Salió el pedido a entrega',
  'delivery.confirmed': () => 'Se confirmó la entrega',
  'delivery.partial': () => 'Entrega parcial',
  'delivery.failed': () => 'Falló la entrega',
  'zoho.shipment_queued': () => 'Embarque en cola para Zoho',
  'zoho.shipment_confirmed': () => 'Zoho confirmó el embarque',
  'zoho.shipment_conflict': () => 'Zoho devolvió datos distintos del embarque',
  'zoho.shipment_failed': () => 'Falló el envío del embarque a Zoho',
  'approval.requested': () => 'Se pidió una aprobación',
  'approval.approved': () => 'Se aprobó una solicitud de aprobación',
  'approval.rejected': () => 'Se rechazó una solicitud de aprobación',
  'step.completed': (_e, p) => {
    const label = cleanText(p.label ?? p.stepKey, 80);
    return label ? `Se completó el paso ${label}` : 'Se completó un paso';
  },
  'proposal.created': (_e, p, c) => {
    const summary = cleanText(c?.proposalSummary ?? p.summary ?? c?.toolName ?? p.toolName, 100);
    return `${cleanText(c?.agentName, 40) || 'La IA'} propuso${summary ? `: ${summary}` : ' una acción'}`;
  },
  'ai.proposal_created': (_e, p, c) => {
    const summary = cleanText(c?.proposalSummary ?? p.summary ?? c?.toolName ?? p.toolName, 100);
    const agent = cleanText(c?.agentName, 40) || agentLabelOf(p.agentKey);
    return `${agent} propuso${summary ? `: ${summary}` : ' una acción'} · falta aprobación`;
  },
  'ai.budget_exhausted': (_e, p, c) => `${cleanText(c?.agentName, 40) || agentLabelOf(p.agentKey)} quedó en pausa por presupuesto`,
  'ai.turn': (_e, p, c) => `${cleanText(c?.agentName, 40) || agentLabelOf(p.agentKey)} atendió ${triggerLabelOf(p.trigger)}`,
  'ai.turn_skipped': (_e, p, c) => `${cleanText(c?.agentName, 40) || agentLabelOf(p.agentKey)} no tomó turno (${triggerLabelOf(p.trigger)})`,
  'ai.turn_failed': (_e, p, c) => `${cleanText(c?.agentName, 40) || agentLabelOf(p.agentKey)} no pudo completar ${triggerLabelOf(p.trigger)}`,
  'proposal.approved': (_e, p, c) => {
    const summary = cleanText(c?.proposalSummary ?? p.summary, 100);
    return `${cleanText(c?.approverName, 60) || 'El responsable'} aprobó${summary ? `: ${summary}` : ' la propuesta'}`;
  },
  'proposal.rejected': (_e, p, c) => {
    const summary = cleanText(c?.proposalSummary ?? p.summary, 100);
    return `${cleanText(c?.approverName, 60) || 'El responsable'} rechazó${summary ? `: ${summary}` : ' la propuesta'}`;
  },
  'proposal.failed': (_e, p, c) => {
    const summary = cleanText(c?.proposalSummary ?? p.summary, 100);
    return `Falló la acción aprobada${summary ? `: ${summary}` : ''}`;
  },
};
PHRASES['case.started'] = PHRASES['case.created'];

function humanizeType(type: string): string {
  return cleanText(type.replace(/[._]+/g, ' '), 60);
}

/** `09:29 Compras recibió solicitud por 15 m²` (Mexico City time). */
export function formatTimelineLine(event: TimelineEvent, ctx?: AgentMessageContext): string {
  const clock = formatClock(event.occurredAt ?? ctx?.occurredAt ?? ctx?.now, ctx?.tz ?? AGENT_TIMEZONE);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const builder = PHRASES[event.type];
  let phrase: string;
  if (builder) {
    phrase = builder(event, payload, ctx);
  } else {
    const area = areaLabel(event.areaKey);
    phrase = area ? `${area}: ${humanizeType(event.type)}` : humanizeType(event.type) || 'Evento';
  }
  return `${clock} ${cleanText(phrase, 180)}`;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const ICONS: Record<AgentMessageKind, string> = {
  'request.created': '📦',
  'request.acknowledged': '📥',
  'request.accepted': '✅',
  'request.blocked': '⛔',
  'request.resolved': '✔️',
  'request.rejected': '✖️',
  'request.cancelled': '🚫',
  'request.expired': '⌛',
  'request.overdue': '⏰',
  'workitem.assigned': '📝',
  'workitem.overdue': '⏰',
  'workitem.completed': '✅',
  'incident.opened': '⚠️',
  'incident.resolved': '✅',
  'proposal.created': '🤖',
  'proposal.approved': '👍',
  'proposal.rejected': '👎',
  'proposal.failed': '❗',
  'case.started': '🧾',
  'case.delivered': '🚚',
  'budget.exhausted': '⏸️',
};

/** Event type rendered as the timeline line of each message kind. */
const TIMELINE_TYPE: Record<AgentMessageKind, string> = {
  'request.created': 'request.created',
  'request.acknowledged': 'request.acknowledged',
  'request.accepted': 'request.accepted',
  'request.blocked': 'request.blocked',
  'request.resolved': 'request.resolved',
  'request.rejected': 'request.rejected',
  'request.cancelled': 'request.cancelled',
  'request.expired': 'request.expired',
  'request.overdue': 'request.overdue',
  'workitem.assigned': 'workitem.assigned',
  'workitem.overdue': 'workitem.overdue',
  'workitem.completed': 'workitem.completed',
  'incident.opened': 'incident.opened',
  'incident.resolved': 'incident.resolved',
  'proposal.created': 'ai.proposal_created',
  'proposal.approved': 'proposal.approved',
  'proposal.rejected': 'proposal.rejected',
  'proposal.failed': 'proposal.failed',
  'case.started': 'case.started',
  'case.delivered': 'case.delivered',
  'budget.exhausted': 'ai.budget_exhausted',
};

function toArea(ctx: AgentMessageContext): string {
  return areaLabel(ctx.toAreaKey ?? ctx.areaKey) ?? 'otra área';
}

function ownArea(ctx: AgentMessageContext): string {
  return areaLabel(ctx.areaKey) ?? 'el área';
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

type TextBuilder = (ctx: AgentMessageContext, icon: string) => string;

const TEXTS: Record<AgentMessageKind, TextBuilder> = {
  'request.created': (c, i) =>
    sentence(i, `Solicitud a ${toArea(c)}${reference(c)}`, requestSubject(c), [
      responsiblePart(c),
      duePart(c),
      c.blocksDelivery ? 'Bloquea la entrega' : null,
    ]),
  'request.acknowledged': (c, i) =>
    sentence(i, `${capitalize(toArea(c))} recibió la solicitud${reference(c)}`, requestSubject(c), [
      responsiblePart(c),
      duePart(c),
    ]),
  'request.accepted': (c, i) =>
    sentence(i, `${capitalize(toArea(c))} aceptó la solicitud${reference(c)}`, requestSubject(c), [
      actorPart(c),
      duePart(c),
    ]),
  'request.blocked': (c, i) =>
    sentence(i, `${capitalize(toArea(c))} bloqueó la solicitud${reference(c)}`, requestSubject(c), [
      reasonPart(c),
      actorPart(c),
    ]),
  'request.resolved': (c, i) =>
    sentence(i, `${capitalize(toArea(c))} resolvió la solicitud${reference(c)}`, requestSubject(c), [
      cleanText(c.note, 200) ? `Respuesta: ${cleanText(c.note, 200)}` : null,
      actorPart(c),
    ]),
  'request.rejected': (c, i) =>
    sentence(i, `${capitalize(toArea(c))} rechazó la solicitud${reference(c)}`, requestSubject(c), [
      reasonPart(c),
      actorPart(c),
    ]),
  'request.cancelled': (c, i) =>
    sentence(i, `Se canceló la solicitud a ${toArea(c)}${reference(c)}`, requestSubject(c), [reasonPart(c)]),
  'request.expired': (c, i) =>
    sentence(i, `Venció sin respuesta la solicitud a ${toArea(c)}${reference(c)}`, requestSubject(c), [
      responsiblePart(c),
    ]),
  'request.overdue': (c, i) => {
    const late = formatDuration(c.overdueMinutes);
    return sentence(i, `Solicitud vencida en ${toArea(c)}${reference(c)}`, requestSubject(c), [
      late ? `Vencida hace ${late}` : null,
      responsiblePart(c),
    ]);
  },
  'workitem.assigned': (c, i) =>
    sentence(i, `Trabajo nuevo en ${ownArea(c)}${reference(c)}`, cleanText(c.workItemTitle ?? c.title, 160), [
      responsiblePart(c),
      duePart(c),
    ]),
  'workitem.overdue': (c, i) => {
    const late = formatDuration(c.overdueMinutes);
    const level = typeof c.escalationLevel === 'number' && c.escalationLevel >= 0 ? c.escalationLevel + 1 : null;
    return sentence(i, `Trabajo vencido en ${ownArea(c)}${reference(c)}`, cleanText(c.workItemTitle ?? c.title, 160), [
      late ? `Vencido hace ${late}` : null,
      responsiblePart(c),
      level ? `Escalación nivel ${level}` : null,
    ]);
  },
  'workitem.completed': (c, i) =>
    sentence(i, `${capitalize(ownArea(c))} terminó un trabajo${reference(c)}`, cleanText(c.workItemTitle ?? c.title, 160), [
      actorPart(c),
    ]),
  'incident.opened': (c, i) => {
    const severity = severityLabel(c.severity);
    const subject = cleanText(c.incidentTitle ?? c.title, 160) || incidentKindLabel(c.incidentKind) || '';
    return sentence(i, `Incidencia${severity ? ` ${severity}` : ''} en ${ownArea(c)}${reference(c)}`, subject, [
      responsiblePart(c),
    ]);
  },
  'incident.resolved': (c, i) =>
    sentence(i, `Incidencia resuelta en ${ownArea(c)}${reference(c)}`, cleanText(c.incidentTitle ?? c.title, 160), [
      cleanText(c.resolution, 200) ? `Resolución: ${cleanText(c.resolution, 200)}` : null,
      actorPart(c),
    ]),
  'proposal.created': (c, i) => {
    const approver = cleanText(c.approverName, 60) || cleanText(c.responsibleName, 60) || 'el responsable del área';
    const expires = formatDueLabel(c.expiresAt, c.now ?? new Date(), c.tz ?? AGENT_TIMEZONE);
    return sentence(
      i,
      `${cleanText(c.agentName, 40) || 'La IA'} propone una acción${reference(c)}`,
      cleanText(c.proposalSummary, 200) || cleanText(c.toolName, 60),
      [`Aprueba ${approver}`, expires ? `Vence ${expires}` : null]
    );
  },
  'proposal.approved': (c, i) =>
    sentence(
      i,
      `${cleanText(c.approverName, 60) || 'El responsable'} aprobó la propuesta${reference(c)}`,
      cleanText(c.proposalSummary, 200) || cleanText(c.toolName, 60),
      []
    ),
  'proposal.rejected': (c, i) =>
    sentence(
      i,
      `${cleanText(c.approverName, 60) || 'El responsable'} rechazó la propuesta${reference(c)}`,
      cleanText(c.proposalSummary, 200) || cleanText(c.toolName, 60),
      [reasonPart(c)]
    ),
  'proposal.failed': (c, i) =>
    sentence(i, `Falló una acción aprobada${reference(c)}`, cleanText(c.proposalSummary, 200) || cleanText(c.toolName, 60), [
      cleanText(c.error, 200) ? `Error: ${cleanText(c.error, 200)}` : null,
      cleanText(c.agentName, 40) ? `${cleanText(c.agentName, 40)} lo revisa` : null,
    ]),
  'case.started': (c, i) => {
    const caseNumber = cleanText(c.caseNumber, 40);
    const so = cleanText(c.salesOrderNumber, 40);
    const promised = formatShortDate(c.promisedAt, c.tz ?? AGENT_TIMEZONE);
    return sentence(i, `Expediente${caseNumber ? ` ${caseNumber}` : ''} abierto${so ? ` · ${so}` : ''}`, cleanText(c.customerName, 120), [
      responsiblePart(c),
      promised ? `Promesa de entrega ${promised}` : null,
    ]);
  },
  'case.delivered': (c, i) => {
    const delivered = formatDueLabel(c.deliveredAt, c.now ?? new Date(), c.tz ?? AGENT_TIMEZONE);
    const incidents = typeof c.incidentCount === 'number' && c.incidentCount > 0 ? c.incidentCount : 0;
    return sentence(i, `Pedido entregado${reference(c)}`, cleanText(c.customerName, 120), [
      delivered ? `Entregado ${delivered}` : null,
      incidents > 0 ? `Con ${incidents} ${incidents === 1 ? 'incidencia' : 'incidencias'}` : null,
    ]);
  },
  'budget.exhausted': (c, i) => {
    const agent = cleanText(c.agentName, 40) || 'La IA del área';
    const responsible = cleanText(c.responsibleName, 60) || cleanText(c.ownerName, 60) || 'el responsable del área';
    return `${i} ${agent} en pausa por presupuesto, atiende ${responsible}`;
  },
};

/**
 * Chat text and timeline line of a template kind. Never calls a model and never
 * throws for missing optional fields; an unknown kind throws (programming error).
 */
export function renderAgentMessage(kind: AgentMessageKind, ctx: AgentMessageContext = {}): RenderedAgentMessage {
  if (!isAgentMessageKind(kind)) throw new Error(`Unknown agent message kind "${String(kind)}"`);
  const text = TEXTS[kind](ctx, ICONS[kind]).replace(/\s+/g, ' ').trim();
  const timelineLine = formatTimelineLine(
    {
      type: TIMELINE_TYPE[kind],
      occurredAt: ctx.occurredAt ?? ctx.now ?? new Date(),
      areaKey: kind.startsWith('request.') ? (ctx.toAreaKey ?? ctx.areaKey ?? null) : (ctx.areaKey ?? null),
      payload: {},
    },
    ctx
  );
  return { text, timelineLine };
}
