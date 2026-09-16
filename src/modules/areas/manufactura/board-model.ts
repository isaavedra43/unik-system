import type { OfflineCommandInput } from '@/lib/offline-commands';
import {
  MANUFACTURING_COMMANDS,
  MANUFACTURING_OBJECT_TYPES,
  PRODUCTION_ORDER_STATUS_LABELS,
  isProductionOrderStatus,
} from '@/modules/manufacturing/manufacturing-types';
import { canApplyOrderAction } from '@/modules/manufacturing/production-state';

/**
 * Pure view model of the production board (plan 7.6). No React, no Prisma, no
 * I/O: the server read fills it, the board renders it and the unit test walks
 * its rules, so what the board offers and what the engine accepts never drift.
 *
 * The board moves ORDERS between work centres with the real
 * `manufacturing.order.schedule` command (there is no per-operation reschedule
 * command in the module): dropping a card on a centre — or choosing it from
 * "Mover a…" — schedules the order there, and the service re-plans its pending
 * operations against the shifts of that centre.
 */

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export const BOARD_LANES = ['blocked', 'queued', 'active', 'done'] as const;
export type BoardLane = (typeof BOARD_LANES)[number];

export const BOARD_LANE_LABELS: Readonly<Record<BoardLane, string>> = {
  blocked: 'Bloqueadas',
  queued: 'En cola',
  active: 'En curso',
  done: 'Para liberar',
};

export const BOARD_LANE_HINTS: Readonly<Record<BoardLane, string>> = {
  blocked: 'Esperan material: alguien tiene que resolver el faltante.',
  queued: 'Con material apartado o preparado, listas para empezar.',
  active: 'En proceso o en inspección de calidad.',
  done: 'Inspeccionadas: falta liberarlas a Inventario o Logística.',
};

/** Lane of an order status; null for statuses the board does not show (liberada, cancelada). */
export function laneForStatus(status: string): BoardLane | null {
  switch (status) {
    case 'blocked':
      return 'blocked';
    case 'draft':
    case 'reserved':
    case 'prepared':
      return 'queued';
    case 'in_progress':
    case 'inspection':
      return 'active';
    case 'completed':
      return 'done';
    default:
      return null;
  }
}

export function orderStatusLabel(status: string): string {
  return isProductionOrderStatus(status) ? PRODUCTION_ORDER_STATUS_LABELS[status] : status;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export interface BoardRunningOperation {
  id: string;
  seq: number;
  name: string;
  startedAt: string | null;
  assignedUserName: string | null;
}

/** One order on the board (JSON-safe: quantities are decimal strings). */
export interface BoardCard {
  id: string;
  number: string;
  title: string;
  status: string;
  statusLabel: string;
  lane: BoardLane;
  kind: string;
  priority: string;
  workCenterId: string | null;
  workCenterName: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  plannedQty: string;
  plannedUnit: string;
  producedQty: string;
  scrapQty: string;
  caseId: string | null;
  caseNumber: string | null;
  customerName: string | null;
  blockedReason: string | null;
  version: number;
  runningOperation: BoardRunningOperation | null;
  /** Operations of this order still pending or paused. */
  pendingOperations: number;
}

export interface BoardCenter {
  /** null = the "sin centro" column (orders nobody scheduled yet). */
  id: string | null;
  key: string | null;
  name: string;
  capacityUnit: string;
  capacityUnitLabel: string;
  capacityPerShift: number;
  status: string;
  windows: BoardWindow[];
  summary: BoardLoadSummary | null;
  cards: BoardCard[];
}

export interface BoardWindow {
  shiftName: string;
  day: string;
  start: string;
  end: string;
  capacity: number;
  load: number;
  available: number;
  utilizationPct: number;
  overloaded: boolean;
}

export interface BoardLoadSummary {
  windows: number;
  overloadedWindows: number;
  peakUtilizationPct: number;
  totalLoad: number;
  totalCapacity: number;
}

export interface BoardPayload {
  generatedAt: string;
  days: number;
  centers: BoardCenter[];
  totals: {
    orders: number;
    blocked: number;
    active: number;
    queued: number;
    done: number;
    unassigned: number;
  };
  /** The read hit its cap: the counts per lane are still exact. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type BoardBadgeTone = 'danger' | 'warning' | 'info' | 'success' | 'default';

export interface BoardBadge {
  id: string;
  label: string;
  tone: BoardBadgeTone;
  /** Full sentence for the tooltip and assistive technology. */
  title: string;
}

function toNumber(value: string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Scrap over what actually came out of the order (produced + scrap), which is
 * the basis `scrap-rules` uses for the output item. Null while nothing came out.
 */
export function scrapPercent(card: Pick<BoardCard, 'producedQty' | 'scrapQty'>): number | null {
  const scrap = toNumber(card.scrapQty);
  const basis = toNumber(card.producedQty) + scrap;
  if (basis <= 0) return null;
  return Math.round((scrap / basis) * 1000) / 10;
}

export function formatPercent(value: number): string {
  return `${value.toLocaleString('es-MX', { maximumFractionDigits: 1 })} %`;
}

/** Badges of a card: scrap, quality hold, missing material, delay and priority. */
export function cardBadges(card: BoardCard, now: Date): BoardBadge[] {
  const badges: BoardBadge[] = [];

  if (card.status === 'blocked') {
    badges.push({
      id: 'material',
      label: 'Material faltante',
      tone: 'danger',
      title: card.blockedReason?.trim()
        ? `Bloqueada: ${card.blockedReason.trim()}`
        : 'Bloqueada por falta de material',
    });
  }

  if (card.status === 'inspection') {
    badges.push({
      id: 'quality',
      label: 'Retención de calidad',
      tone: 'warning',
      title: 'Espera la inspección de calidad antes de continuar',
    });
  }

  const scrap = scrapPercent(card);
  if (scrap !== null && scrap > 0) {
    badges.push({
      id: 'scrap',
      label: `Merma ${formatPercent(scrap)}`,
      tone: scrap >= 10 ? 'danger' : 'warning',
      title: `Se registró ${card.scrapQty} ${card.plannedUnit} de merma sobre lo que salió de la orden`,
    });
  }

  const due = card.plannedEndAt ? Date.parse(card.plannedEndAt) : NaN;
  if (Number.isFinite(due) && due < now.getTime() && card.lane !== 'done') {
    badges.push({
      id: 'late',
      label: 'Atrasada',
      tone: 'danger',
      title: 'Ya pasó la fecha en la que debía terminar',
    });
  }

  if (card.priority === 'urgent' || card.priority === 'high') {
    badges.push({
      id: 'priority',
      label: card.priority === 'urgent' ? 'Urgente' : 'Alta',
      tone: card.priority === 'urgent' ? 'danger' : 'warning',
      title:
        card.priority === 'urgent' ? 'Prioridad urgente: va antes que el resto' : 'Prioridad alta',
    });
  }

  return badges;
}

// ---------------------------------------------------------------------------
// Moving an order between work centres
// ---------------------------------------------------------------------------

export interface MoveCheck {
  ok: boolean;
  /** Why it cannot be moved, in Spanish (null when it can). */
  reason: string | null;
}

/**
 * Whether this order can change work centre. Mirrors the rules
 * `scheduleOrderInTx` enforces, so the board never offers a move the engine
 * would reject (it validates them again anyway).
 */
export function canMoveOrder(card: Pick<BoardCard, 'status' | 'kind'>): MoveCheck {
  if (card.kind === 'bom') {
    return {
      ok: false,
      reason:
        'En una orden con lista de materiales el centro de trabajo se cambia en cada operación, no en la orden.',
    };
  }
  if (card.status === 'prepared') {
    return {
      ok: false,
      reason: 'El material ya se surtió al centro actual: una orden preparada no cambia de centro.',
    };
  }
  if (!canApplyOrderAction('schedule', card.status)) {
    return {
      ok: false,
      reason: `No se puede programar una orden ${orderStatusLabel(card.status).toLowerCase()}.`,
    };
  }
  return { ok: true, reason: null };
}

export interface MoveTarget {
  /** Work centre the order goes to. `manufacturing.order.schedule` never unassigns. */
  workCenterId: string;
  /** Start of the chosen shift window (ISO), or null to let the planner decide. */
  plannedStartAt?: string | null;
}

/** A drop that changes nothing (same centre, same start) must not send a command. */
export function isRealMove(card: Pick<BoardCard, 'workCenterId'>, target: MoveTarget): boolean {
  return Boolean(target.plannedStartAt) || card.workCenterId !== target.workCenterId;
}

/** Command sent to `POST /app/operations/api/commands` (or queued while offline). */
export function buildScheduleCommand(
  card: Pick<BoardCard, 'id' | 'version'>,
  target: MoveTarget
): OfflineCommandInput<Record<string, unknown>> {
  return {
    type: MANUFACTURING_COMMANDS.orderSchedule,
    aggregate: { type: MANUFACTURING_OBJECT_TYPES.productionOrder, id: card.id },
    payload: {
      productionOrderId: card.id,
      workCenterId: target.workCenterId,
      ...(target.plannedStartAt ? { plannedStartAt: target.plannedStartAt } : {}),
    },
    expectedVersion: card.version,
  };
}

/** Sentence confirming a move, for the toast and the dialog. */
export function describeMove(
  card: Pick<BoardCard, 'number' | 'workCenterName'>,
  centerName: string,
  window?: { shiftName: string; start: string } | null
): string {
  const from = card.workCenterName ? `de ${card.workCenterName} ` : '';
  const shift = window
    ? ` en el turno ${window.shiftName} (${formatWindowStart(window.start)})`
    : '';
  return `Mover ${card.number} ${from}a ${centerName}${shift}`;
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/** > 100 % danger, > 85 % warning, otherwise healthy. */
export function utilizationTone(pct: number): 'success' | 'warning' | 'danger' {
  if (!Number.isFinite(pct)) return 'success';
  if (pct > 100) return 'danger';
  if (pct > 85) return 'warning';
  return 'success';
}

export function formatQuantity(value: number, unitLabel: string): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded.toLocaleString('es-MX', { maximumFractionDigits: 2 })} ${unitLabel}`;
}

const WINDOW_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Mexico_City',
};

export function formatWindowStart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('es-MX', WINDOW_FORMAT).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Accessible description of a shift window ("Turno matutino · mar 16 sep 07:00 · 82 % usado"). */
export function describeWindow(window: BoardWindow): string {
  return `${window.shiftName} · ${formatWindowStart(window.start)} · ${formatPercent(window.utilizationPct)} usado`;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export function groupByLane(cards: readonly BoardCard[]): Record<BoardLane, BoardCard[]> {
  const lanes: Record<BoardLane, BoardCard[]> = {
    blocked: [],
    queued: [],
    active: [],
    done: [],
  };
  for (const card of cards) lanes[card.lane].push(card);
  return lanes;
}

/** Totals of the whole board, for the header strip. */
export function boardTotals(centers: readonly BoardCenter[]): BoardPayload['totals'] {
  const totals: BoardPayload['totals'] = {
    orders: 0,
    blocked: 0,
    active: 0,
    queued: 0,
    done: 0,
    unassigned: 0,
  };
  for (const center of centers) {
    for (const card of center.cards) {
      totals.orders += 1;
      totals[card.lane] += 1;
      if (center.id === null) totals.unassigned += 1;
    }
  }
  return totals;
}

/** Index of the next centre when swiping on a phone (wraps around). */
export function nextCenterIndex(index: number, direction: 1 | -1, total: number): number {
  if (total <= 0) return 0;
  return (index + direction + total) % total;
}
