import {
  OPERATION_STATUS_LABELS,
  PRODUCTION_ORDER_OPEN_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
  isProductionOrderStatus,
  type OperationStatus,
  type ProductionOrderStatus,
  type QualityResult,
} from './manufacturing-types';
import type { ScrapApprovalState } from './scrap-rules';

/**
 * State machine and pure rules of production orders (plan 6.2).
 *
 * Flow: draft → (reserve materials) reserved | blocked → prepared → in_progress
 * (operations) → inspection → completed (inspection passed) → released.
 * `blocked` means material could not be committed; a later reservation moves it
 * to `reserved`. A failed inspection adds a rework operation and goes back to
 * `in_progress`. Cancelling is possible until the release.
 */

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Order actions
// ---------------------------------------------------------------------------

export const PRODUCTION_ORDER_ACTIONS = [
  'schedule',
  'reserve_materials',
  'prepare',
  'start_operation',
  'pause_operation',
  'finish_operation',
  'record_consumption',
  'inspect',
  'record_finished_output',
  'record_other_output',
  'request_scrap_review',
  'release',
  'cancel',
] as const;
export type ProductionOrderAction = (typeof PRODUCTION_ORDER_ACTIONS)[number];

export const ORDER_ACTION_STATUSES: Record<ProductionOrderAction, readonly ProductionOrderStatus[]> = {
  schedule: ['draft', 'reserved', 'prepared', 'blocked'],
  reserve_materials: ['draft', 'blocked', 'reserved'],
  prepare: ['reserved'],
  start_operation: ['prepared', 'in_progress'],
  pause_operation: ['in_progress'],
  finish_operation: ['in_progress'],
  record_consumption: ['in_progress', 'inspection', 'completed'],
  inspect: ['in_progress', 'inspection'],
  record_finished_output: ['completed'],
  record_other_output: ['in_progress', 'inspection', 'completed'],
  request_scrap_review: ['in_progress', 'inspection', 'completed'],
  release: ['completed'],
  cancel: ['draft', 'reserved', 'prepared', 'blocked', 'in_progress', 'inspection', 'completed'],
};

export const ORDER_ACTION_LABELS: Record<ProductionOrderAction, string> = {
  schedule: 'programar',
  reserve_materials: 'reservar materiales de',
  prepare: 'preparar',
  start_operation: 'iniciar operaciones de',
  pause_operation: 'pausar operaciones de',
  finish_operation: 'terminar operaciones de',
  record_consumption: 'registrar consumos de',
  inspect: 'inspeccionar',
  record_finished_output: 'registrar producto terminado de',
  record_other_output: 'registrar sobrante o merma de',
  request_scrap_review: 'solicitar revisión de merma de',
  release: 'liberar',
  cancel: 'cancelar',
};

export function canApplyOrderAction(action: ProductionOrderAction, status: string): boolean {
  return (ORDER_ACTION_STATUSES[action] as readonly string[]).includes(status);
}

function statusLabel(status: string): string {
  return isProductionOrderStatus(status) ? PRODUCTION_ORDER_STATUS_LABELS[status] : status;
}

/** Spanish reason when the action is not allowed in `status`, null otherwise. */
export function orderActionError(action: ProductionOrderAction, status: string): string | null {
  if (canApplyOrderAction(action, status)) return null;
  if (action === 'record_finished_output' && (status === 'in_progress' || status === 'inspection')) {
    return 'El producto terminado se registra después de una inspección aprobada';
  }
  return `No se puede ${ORDER_ACTION_LABELS[action]} una orden ${statusLabel(status).toLowerCase()}`;
}

export function allowedOrderActions(status: string): ProductionOrderAction[] {
  return PRODUCTION_ORDER_ACTIONS.filter((action) => canApplyOrderAction(action, status));
}

export function isOpenOrderStatus(status: string): boolean {
  return (PRODUCTION_ORDER_OPEN_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface OperationFacts {
  id: string;
  seq: number;
  name: string;
  status: string;
  /** The routing requires a passing quality check before the next operation. */
  qcRequired: boolean;
  /** A pass/conditional check exists for this operation. */
  passedCheck: boolean;
}

const CLOSED_OPERATION_STATUSES: readonly string[] = ['done', 'skipped'];

export function isClosedOperationStatus(status: string): boolean {
  return CLOSED_OPERATION_STATUSES.includes(status);
}

function operationLabel(op: Pick<OperationFacts, 'seq' | 'name'>): string {
  return `${op.seq}. ${op.name}`;
}

export function sortOperations<T extends { seq: number; id: string }>(ops: readonly T[]): T[] {
  return [...ops].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

/** Why an operation cannot start (or resume), null when it can. */
export function operationStartError(
  ops: readonly OperationFacts[],
  operationId: string
): string | null {
  const sorted = sortOperations(ops);
  const op = sorted.find((candidate) => candidate.id === operationId);
  if (!op) return 'La operación no pertenece a esta orden';
  if (op.status === 'running') return 'La operación ya está en curso';
  if (isClosedOperationStatus(op.status)) return 'La operación ya terminó';
  const running = sorted.find((candidate) => candidate.status === 'running');
  if (running) {
    return `Termina o pausa la operación en curso (${operationLabel(running)}) antes de iniciar otra`;
  }
  for (const previous of sorted) {
    if (previous.id === op.id || previous.seq > op.seq) break;
    if (previous.seq === op.seq) continue;
    if (!isClosedOperationStatus(previous.status)) {
      return `Primero termina la operación ${operationLabel(previous)}`;
    }
    if (previous.status === 'done' && previous.qcRequired && !previous.passedCheck) {
      return `La operación ${operationLabel(previous)} requiere una inspección aprobada antes de continuar`;
    }
  }
  return null;
}

/** First operation that can start or resume now. */
export function nextStartableOperation(ops: readonly OperationFacts[]): OperationFacts | null {
  for (const op of sortOperations(ops)) {
    if (op.status !== 'pending' && op.status !== 'paused') continue;
    return operationStartError(ops, op.id) === null ? op : null;
  }
  return null;
}

export function operationPauseError(op: Pick<OperationFacts, 'status'> | null): string | null {
  if (!op) return 'La operación no pertenece a esta orden';
  if (op.status !== 'running') {
    return `Sólo se pausa una operación en curso (está ${operationStatusLabel(op.status).toLowerCase()})`;
  }
  return null;
}

export function operationFinishError(op: Pick<OperationFacts, 'status'> | null): string | null {
  if (!op) return 'La operación no pertenece a esta orden';
  if (op.status !== 'running' && op.status !== 'paused') {
    return op.status === 'pending'
      ? 'Inicia la operación antes de terminarla'
      : 'La operación ya terminó';
  }
  return null;
}

export function operationStatusLabel(status: string): string {
  return (OPERATION_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

export function allOperationsClosed(ops: ReadonlyArray<{ status: string }>): boolean {
  return ops.length > 0 && ops.every((op) => isClosedOperationStatus(op.status));
}

/** Status of an in-progress order once its operations changed. */
export function orderStatusAfterOperations(
  ops: ReadonlyArray<{ status: string }>
): Extract<ProductionOrderStatus, 'inspection' | 'in_progress'> {
  return allOperationsClosed(ops) ? 'inspection' : 'in_progress';
}

/**
 * Sequence of a rework operation: right after the failed operation (later
 * operations move one place) or, for an order-level failure, at the end.
 */
export function reworkPlacement(
  ops: ReadonlyArray<{ id: string; seq: number }>,
  afterOperationId: string | null
): { seq: number; renumber: Array<{ id: string; seq: number }> } {
  const maxSeq = ops.reduce((max, op) => Math.max(max, op.seq), 0);
  const failed = afterOperationId ? ops.find((op) => op.id === afterOperationId) : null;
  if (!failed) return { seq: maxSeq + 1, renumber: [] };
  const seq = failed.seq + 1;
  const renumber = ops
    .filter((op) => op.id !== failed.id && op.seq >= seq)
    .sort((a, b) => b.seq - a.seq)
    .map((op) => ({ id: op.id, seq: op.seq + 1 }));
  return { seq, renumber };
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}

/** Real minutes of an operation: banked minutes plus the running segment. */
export function accumulatedMinutes(
  banked: number | null | undefined,
  segmentStart: Date | null,
  at: Date
): number {
  return Math.max(0, banked ?? 0) + (segmentStart ? minutesBetween(segmentStart, at) : 0);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface RecipeLine {
  inputZohoItemId: string;
  /** Input (in `unit`) per output unit. */
  qtyPerOutput: number;
  unit: string;
  substitutes: string[];
  /** Expected scrap of the input (percent). */
  scrapPct: number | null;
  /** Exact variant to take; null = any variant. */
  variantKey: string | null;
}

export function roundQty(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function requiredInputQty(line: Pick<RecipeLine, 'qtyPerOutput'>, plannedQty: number): number {
  return roundQty(Math.max(0, line.qtyPerOutput) * Math.max(0, plannedQty));
}

/**
 * Material to commit for a planned output: the net input grossed up by the
 * expected scrap of the line (`scrapPct`) and the expected yield of the BOM
 * (fraction, 0 < yield ≤ 1). The material balance keeps judging the net use.
 */
export function grossRequiredInputQty(
  line: Pick<RecipeLine, 'qtyPerOutput' | 'scrapPct'>,
  plannedQty: number,
  expectedYield: number | null = null
): number {
  const net = Math.max(0, line.qtyPerOutput) * Math.max(0, plannedQty);
  const scrapFactor = 1 + Math.max(0, line.scrapPct ?? 0) / 100;
  const yieldFactor = expectedYield !== null && expectedYield > EPS && expectedYield <= 1 ? expectedYield : 1;
  return roundQty((net * scrapFactor) / yieldFactor);
}

export interface TransformationInput {
  zohoItemId: string;
  qty: number;
  unit: string;
  substituteZohoItemIds: string[];
  variantKey: string | null;
  scrapAllowancePct: number | null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Tolerant read of `ProductionOrder.inputs` (invalid entries are skipped). */
export function parseTransformationInputs(value: unknown): TransformationInput[] {
  if (!Array.isArray(value)) return [];
  const out: TransformationInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const zohoItemId = text(record.zohoItemId, 120);
    const qty = Number(record.qty);
    const unit = text(record.unit, 40);
    if (!zohoItemId || !Number.isFinite(qty) || qty <= 0 || !unit) continue;
    const substitutes = Array.isArray(record.substituteZohoItemIds)
      ? record.substituteZohoItemIds
          .map((id) => text(id, 120))
          .filter((id): id is string => Boolean(id) && id !== zohoItemId)
      : [];
    const pct = Number(record.scrapAllowancePct);
    out.push({
      zohoItemId,
      qty,
      unit,
      substituteZohoItemIds: [...new Set(substitutes)],
      variantKey: typeof record.variantKey === 'string' ? record.variantKey : null,
      scrapAllowancePct:
        record.scrapAllowancePct !== undefined && record.scrapAllowancePct !== null && Number.isFinite(pct)
          ? Math.min(Math.max(pct, 0), 100)
          : null,
    });
  }
  return out;
}

/** Implicit BOM of a transformation order (kept in memory, never stored as a `Bom`). */
export function transformationRecipe(
  inputs: readonly TransformationInput[],
  plannedQty: number,
  defaultAllowancePct: number
): { lines: RecipeLine[]; allowancePct: number } {
  const planned = plannedQty > EPS ? plannedQty : 1;
  const lines = inputs.map((input) => ({
    inputZohoItemId: input.zohoItemId,
    qtyPerOutput: input.qty / planned,
    unit: input.unit,
    substitutes: input.substituteZohoItemIds,
    scrapPct: input.scrapAllowancePct,
    variantKey: input.variantKey,
  }));
  const pcts = inputs
    .map((input) => input.scrapAllowancePct)
    .filter((pct): pct is number => pct !== null);
  return { lines, allowancePct: pcts.length > 0 ? Math.max(...pcts) : defaultAllowancePct };
}

export interface MaterialNeed {
  zohoItemId: string;
  required: number;
  assigned: number;
  missing: number;
  covered: boolean;
}

export function materialNeeds(
  lines: ReadonlyArray<{ zohoItemId: string; required: number; assigned: number }>
): MaterialNeed[] {
  return lines.map((line) => {
    const missing = roundQty(Math.max(0, line.required - line.assigned));
    return {
      zohoItemId: line.zohoItemId,
      required: roundQty(line.required),
      assigned: roundQty(line.assigned),
      missing,
      covered: missing <= EPS,
    };
  });
}

export type ConsumptionRole =
  | { role: 'planned'; inputZohoItemId: string }
  | { role: 'declared_substitute'; inputZohoItemId: string }
  | { role: 'unplanned_substitute'; inputZohoItemId: string }
  | { role: 'invalid'; message: string };

/**
 * What a consumed material is for the order: a planned input, a substitute the
 * BOM allows, or a substitution outside the BOM (needs approval before posting).
 */
export function classifyConsumption(
  lines: readonly RecipeLine[],
  zohoItemId: string,
  substituteFor?: string | null
): ConsumptionRole {
  if (lines.some((line) => line.inputZohoItemId === zohoItemId)) {
    if (substituteFor && substituteFor !== zohoItemId) {
      return {
        role: 'invalid',
        message: 'El material ya es un insumo de la orden; no puede registrarse como sustituto',
      };
    }
    return { role: 'planned', inputZohoItemId: zohoItemId };
  }
  if (substituteFor) {
    const line = lines.find((candidate) => candidate.inputZohoItemId === substituteFor);
    if (!line) return { role: 'invalid', message: 'El insumo que se sustituye no está en la orden' };
    return line.substitutes.includes(zohoItemId)
      ? { role: 'declared_substitute', inputZohoItemId: line.inputZohoItemId }
      : { role: 'unplanned_substitute', inputZohoItemId: line.inputZohoItemId };
  }
  const declared = lines.filter((line) => line.substitutes.includes(zohoItemId));
  if (declared.length === 1) {
    return { role: 'declared_substitute', inputZohoItemId: declared[0].inputZohoItemId };
  }
  if (declared.length > 1) {
    return {
      role: 'invalid',
      message: 'El material sustituye a varios insumos; indica cuál sustituye',
    };
  }
  return {
    role: 'invalid',
    message: 'El material no está en la lista de materiales; indica qué insumo sustituye',
  };
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

export interface ReleaseFacts {
  status: string;
  operations: ReadonlyArray<{ status: string }>;
  /** Finished output in the output base unit. */
  producedBase: number;
  /** Quantity the linked allocation needs (null for make-to-stock orders). */
  requiredBase: number | null;
  baseUnit: string;
  lastOrderCheck: QualityResult | null;
  pendingSubstitutions: number;
  scrapExceeded: boolean;
  scrapApproval: ScrapApprovalState;
  balanceComparable: boolean;
  balanceBalanced: boolean;
  acceptBalanceDifference: boolean;
  /** Scrap recorded for a material nothing was consumed of (no basis to judge it). */
  scrapPending?: boolean;
  /**
   * Materials of the recipe as they stand at release: what is still assigned,
   * what was consumed (substitutes of the same measure included) and what the
   * production actually made needs. `comparable` = judged by the balance.
   */
  materials?: ReadonlyArray<{
    zohoItemId: string;
    label?: string;
    assigned: number;
    consumed: number;
    expected: number;
    tolerancePct: number;
    comparable: boolean;
  }>;
}

export type ReleaseBlockerCode =
  | 'status'
  | 'operations'
  | 'quality'
  | 'no_output'
  | 'short_output'
  | 'substitution_pending'
  | 'scrap_approval'
  | 'scrap_pending'
  | 'not_consumed'
  | 'under_consumed'
  | 'balance';

export interface ReleaseBlocker {
  code: ReleaseBlockerCode;
  message: string;
}

export interface ReleaseEvaluation {
  ready: boolean;
  blockers: ReleaseBlocker[];
  /** The release must open the excess-scrap approval (none yet, or scrap recorded after the last one). */
  requestScrapApproval: boolean;
}

function fmt(value: number): string {
  return String(roundQty(value));
}

export function evaluateRelease(facts: ReleaseFacts): ReleaseEvaluation {
  const blockers: ReleaseBlocker[] = [];
  if (facts.status !== 'completed') {
    blockers.push({
      code: 'status',
      message: `La orden está ${statusLabel(facts.status).toLowerCase()}; se libera después de la inspección`,
    });
  }
  if (!allOperationsClosed(facts.operations)) {
    blockers.push({ code: 'operations', message: 'Hay operaciones sin terminar' });
  }
  if (facts.lastOrderCheck !== 'pass' && facts.lastOrderCheck !== 'conditional') {
    blockers.push({ code: 'quality', message: 'Falta una inspección de calidad aprobada' });
  }
  if (facts.producedBase <= EPS) {
    blockers.push({ code: 'no_output', message: 'No se ha registrado producto terminado' });
  } else if (facts.requiredBase !== null && facts.producedBase + EPS < facts.requiredBase) {
    blockers.push({
      code: 'short_output',
      message: `Se produjeron ${fmt(facts.producedBase)} de ${fmt(facts.requiredBase)} ${facts.baseUnit} que necesita la venta`,
    });
  }
  if (facts.pendingSubstitutions > 0) {
    blockers.push({
      code: 'substitution_pending',
      message:
        facts.pendingSubstitutions === 1
          ? 'Hay una sustitución de material pendiente de aprobación'
          : `Hay ${facts.pendingSubstitutions} sustituciones de material pendientes de aprobación`,
    });
  }
  let requestScrapApproval = false;
  if (facts.scrapExceeded) {
    switch (facts.scrapApproval) {
      case 'approved':
        break;
      case 'pending':
        blockers.push({
          code: 'scrap_approval',
          message: 'La merma fuera de tolerancia espera aprobación',
        });
        break;
      case 'rejected':
        blockers.push({
          code: 'scrap_approval',
          message: 'La merma fuera de tolerancia fue rechazada; solicita una nueva revisión',
        });
        break;
      default:
        requestScrapApproval = true;
        blockers.push({
          code: 'scrap_approval',
          message: 'La merma supera la tolerancia y requiere aprobación',
        });
    }
  }
  if (facts.scrapPending) {
    blockers.push({
      code: 'scrap_pending',
      message: 'Hay merma registrada de un material sin consumo: registra el consumo antes de liberar',
    });
  }
  for (const material of facts.materials ?? []) {
    const name = material.label ?? material.zohoItemId;
    if (material.assigned > EPS && material.consumed <= EPS) {
      // Releasing would give the assigned material back to stock although it was used on the floor.
      blockers.push({
        code: 'not_consumed',
        message: `No se registró el consumo de ${name}: regístralo antes de liberar (su asignación volvería a disponible)`,
      });
    } else if (
      !material.comparable &&
      !facts.acceptBalanceDifference &&
      material.expected > EPS &&
      material.consumed + (material.expected * Math.max(0, material.tolerancePct)) / 100 + EPS < material.expected
    ) {
      blockers.push({
        code: 'under_consumed',
        message: `Se consumieron ${fmt(material.consumed)} de ${name} y la producción necesitaba ${fmt(material.expected)}: registra el consumo o libera aceptando la diferencia`,
      });
    }
  }
  if (facts.balanceComparable && !facts.balanceBalanced && !facts.acceptBalanceDifference) {
    blockers.push({
      code: 'balance',
      message:
        'El balance de material no cuadra: registra el sobrante o la merma, o libera aceptando la diferencia',
    });
  }
  return { ready: blockers.length === 0, blockers, requestScrapApproval };
}

// ---------------------------------------------------------------------------
// Board ordering
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2 };

export function compareBoardOrders(
  a: { priority: string; plannedStartAt: Date | null; createdAt: Date; id: string },
  b: { priority: string; plannedStartAt: Date | null; createdAt: Date; id: string }
): number {
  const rank = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
  if (rank !== 0) return rank;
  const aStart = a.plannedStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bStart = b.plannedStartAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aStart !== bStart) return aStart < bStart ? -1 : 1;
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

export function isOperationStatus(value: unknown): value is OperationStatus {
  return typeof value === 'string' && value in OPERATION_STATUS_LABELS;
}
