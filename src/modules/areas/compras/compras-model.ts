import type { ConfidenceLevel } from '@/modules/ai/confidence';
import {
  CANDIDATE_STATUS_LABELS,
  DIFFERENCE_KINDS,
  PURCHASE_REQUEST_STATUS_LABELS,
  RECEIPT_STATUS_LABELS,
  RFQ_INVITATION_STATUS_LABELS,
  RFQ_RESPONSE_STATUS_LABELS,
  RFQ_STATUS_LABELS,
  SUPPLIER_STATUS_LABELS,
  labelOf,
  type DifferenceKind,
} from '@/modules/purchases/purchases-types';

/**
 * Pure model of the Compras area experience (plan 7.3, 7.4 and 7.6).
 *
 * ISOMORPHIC and pure: no Prisma, no React, no I/O, so the SQL branches, the
 * dashboard, the Sourcing Lab and the receipt capture all agree on the same
 * labels and the same arithmetic, and every rule here is unit-tested.
 *
 * It deliberately does NOT import `orders-state.ts` nor anything else that
 * pulls `@prisma/client`: this file is bundled into the browser. The Spanish
 * label of a row status is computed on the server and travels in
 * `row.extra.statusLabel`.
 */

// ---------------------------------------------------------------------------
// Row kinds of the area
// ---------------------------------------------------------------------------

/** Row kinds Compras contributes to its work centre, on top of the common ones. */
export const COMPRAS_ROW_KINDS = [
  'purchase_request',
  'rfq',
  'procurement_order',
  'goods_receipt',
  'supplier',
] as const;

export type ComprasRowKind = (typeof COMPRAS_ROW_KINDS)[number];

export const COMPRAS_ROW_KIND_LABELS: Readonly<Record<ComprasRowKind, string>> = {
  purchase_request: 'Solicitud de compra',
  rfq: 'Cotización a proveedor',
  procurement_order: 'Orden de compra',
  goods_receipt: 'Recepción',
  supplier: 'Proveedor',
};

export const COMPRAS_ROW_KIND_PLURAL_LABELS: Readonly<Record<ComprasRowKind, string>> = {
  purchase_request: 'Solicitudes',
  rfq: 'Cotizaciones',
  procurement_order: 'Órdenes',
  goods_receipt: 'Recepciones',
  supplier: 'Proveedores',
};

/** Status label maps used by the SQL branches, so a row never shows a raw English state. */
export const COMPRAS_STATUS_LABELS = {
  purchase_request: PURCHASE_REQUEST_STATUS_LABELS,
  rfq: RFQ_STATUS_LABELS,
  goods_receipt: RECEIPT_STATUS_LABELS,
  supplier: SUPPLIER_STATUS_LABELS,
} as const;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Money already rounded by the domain (decimals travel as strings, never floats). */
export function formatMoney(value: string | number | null | undefined, currency = 'MXN'): string {
  if (value === null || value === undefined || value === '') return '—';
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return '—';
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatQty(value: string | number | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const qty = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(qty)) return '—';
  const text = qty.toLocaleString('es-MX', { maximumFractionDigits: 4 });
  return unit ? `${text} ${unit}` : text;
}

/** Lead time in days as a person says it ("3 días", "1 día", "sin plazo"). */
export function formatLeadTime(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return 'Sin plazo';
  const value = Math.max(0, Math.round(days));
  if (value === 0) return 'Inmediato';
  return value === 1 ? '1 día' : `${value} días`;
}

/**
 * Score 0–1 of the RFQ comparison as a percentage ("83 %"). A response without
 * a score shows a dash, never "0 %": not having been scored is not the same as
 * having scored the worst.
 */
export function formatScore(score: number | string | null | undefined): string {
  if (score === null || score === undefined || score === '') return '—';
  const value = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)} %`;
}

// ---------------------------------------------------------------------------
// Confidence of a sourcing candidate
// ---------------------------------------------------------------------------

/** From this confidence the data of a candidate is treated as read from its source. */
export const CANDIDATE_CONFIDENCE_VERIFIED = 0.8;
/** Below this the candidate is an inference and must be checked before contacting it. */
export const CANDIDATE_CONFIDENCE_ESTIMATE = 0.5;

/**
 * Confidence level of a sourcing candidate for `ConfidenceBadge`. A candidate
 * without a confidence has no badge (never a false "verified"): the web search
 * could not tell how much of the card is real.
 */
export function candidateConfidenceLevel(
  confidence: string | number | null | undefined
): ConfidenceLevel | null {
  if (confidence === null || confidence === undefined || confidence === '') return null;
  const value = typeof confidence === 'number' ? confidence : Number(confidence);
  if (!Number.isFinite(value)) return null;
  if (value >= CANDIDATE_CONFIDENCE_VERIFIED) return 'verified';
  if (value >= CANDIDATE_CONFIDENCE_ESTIMATE) return 'estimate';
  return 'assumption';
}

/** Short Spanish note under the badge, with the evidence that backs the card. */
export function candidateConfidenceNote(input: {
  confidence: string | number | null | undefined;
  evidenceCount: number;
}): string | null {
  const level = candidateConfidenceLevel(input.confidence);
  if (!level) return null;
  if (input.evidenceCount === 0) return 'sin evidencia guardada';
  return input.evidenceCount === 1
    ? 'con 1 evidencia guardada'
    : `con ${input.evidenceCount} evidencias guardadas`;
}

// ---------------------------------------------------------------------------
// Comparison of candidates (plan 7.6: at most 4)
// ---------------------------------------------------------------------------

export const MAX_COMPARED_CANDIDATES = 4;

export type CompareToggle =
  { ok: true; selected: string[] } | { ok: false; selected: string[]; error: string };

/**
 * Adds or removes a candidate from the comparison, capped at four: more
 * columns than that stop being readable on a laptop and the person cannot
 * decide. Removing always works, even at the cap.
 */
export function toggleComparedCandidate(selected: readonly string[], id: string): CompareToggle {
  const current = selected.filter((entry) => entry !== id);
  if (current.length !== selected.length) return { ok: true, selected: current };
  if (selected.length >= MAX_COMPARED_CANDIDATES) {
    return {
      ok: false,
      selected: [...selected],
      error: `Puedes comparar hasta ${MAX_COMPARED_CANDIDATES} proveedores a la vez; quita uno para agregar otro.`,
    };
  }
  return { ok: true, selected: [...selected, id] };
}

/** A candidate already promoted (or matched) to a supplier is never invited again as a candidate. */
export function canInviteCandidate(candidate: {
  status: string;
  supplierId: string | null;
  phone: string | null;
  email: string | null;
}): boolean {
  if (candidate.status === 'rejected' || candidate.status === 'promoted') return false;
  return Boolean(candidate.phone || candidate.email);
}

/** Why the "Solicitar cotización" button is disabled, in Spanish. */
export function inviteCandidateBlockedReason(candidate: {
  status: string;
  supplierId: string | null;
  phone: string | null;
  email: string | null;
}): string | null {
  if (canInviteCandidate(candidate)) return null;
  if (candidate.status === 'promoted' || candidate.supplierId) {
    return 'Ya es proveedor de UNIK: cotízale desde su ficha de proveedor.';
  }
  if (candidate.status === 'rejected')
    return 'Lo descartaste; reactívalo para volver a contactarlo.';
  return 'No encontramos teléfono ni correo en la evidencia: agrégalo antes de invitarlo.';
}

// ---------------------------------------------------------------------------
// Progress of a sourcing search
// ---------------------------------------------------------------------------

export type SourcingProgressTone = 'info' | 'success' | 'danger' | 'weak';

export interface SourcingProgress {
  label: string;
  tone: SourcingProgressTone;
  /** The job is still running: the view keeps polling. */
  running: boolean;
}

/** State of the background search job, as the lab shows it. */
export function sourcingProgress(input: {
  status: string;
  resultCount: number;
  cached?: boolean;
  error?: string | null;
}): SourcingProgress {
  if (input.status === 'pending') {
    return { label: 'Buscando proveedores…', tone: 'info', running: true };
  }
  if (input.status === 'failed') {
    return {
      label: input.error ? `No se pudo buscar: ${input.error}` : 'No se pudo completar la búsqueda',
      tone: 'danger',
      running: false,
    };
  }
  if (input.status === 'done') {
    if (input.resultCount === 0) {
      return { label: 'Sin candidatos nuevos', tone: 'weak', running: false };
    }
    const found =
      input.resultCount === 1
        ? '1 candidato encontrado'
        : `${input.resultCount} candidatos encontrados`;
    return {
      label: input.cached ? `${found} · desde la caché, sin gasto` : found,
      tone: 'success',
      running: false,
    };
  }
  return { label: 'Sin ejecutar', tone: 'weak', running: false };
}

// ---------------------------------------------------------------------------
// Goods receipt capture (plan: accepted / rejected quantities per line)
// ---------------------------------------------------------------------------

/** Quantities below this are treated as zero (same epsilon as `orders-state.ts`). */
export const QTY_EPS = 0.00005;

export interface ReceiptLineDraft {
  orderLineId: string;
  /** Ordered quantity of the line. */
  ordered: number;
  /** Already accepted by earlier receipts of the same line. */
  receivedBefore: number;
  qtyReceived: number;
  qtyRejected: number;
  differenceKind: DifferenceKind | null;
}

export type ReceiptLineCheck =
  | { ok: true; accepted: number; differenceKind: DifferenceKind; over: number }
  | { ok: false; error: string };

/**
 * Validates one captured line with the SAME rules the engine applies
 * (`classifyReceiptLine`), so a person is told what is wrong before the command
 * travels: accepted = received − rejected, nothing negative, and a line with
 * nothing received only makes sense when the shortage is declared.
 *
 * Restated here (instead of imported) because `orders-state.ts` imports Prisma
 * and cannot be bundled into the browser; the engine validates again.
 */
export function checkReceiptLine(line: ReceiptLineDraft): ReceiptLineCheck {
  const received = Number(line.qtyReceived);
  const rejected = Number(line.qtyRejected);
  if (!Number.isFinite(received) || received < 0) {
    return { ok: false, error: 'La cantidad recibida no puede ser negativa' };
  }
  if (!Number.isFinite(rejected) || rejected < 0) {
    return { ok: false, error: 'La cantidad rechazada no puede ser negativa' };
  }
  if (rejected - received > QTY_EPS) {
    return { ok: false, error: 'No puedes rechazar más de lo que recibiste' };
  }
  const declared =
    line.differenceKind && line.differenceKind !== 'none' ? line.differenceKind : null;
  if (received <= QTY_EPS && !declared) {
    return { ok: false, error: 'Indica la cantidad recibida o declara el faltante' };
  }
  const accepted = round4(Math.max(0, received - rejected));
  const over = round4(Math.max(0, line.receivedBefore + received - line.ordered));
  let differenceKind: DifferenceKind = 'none';
  if (declared === 'wrong_item') differenceKind = 'wrong_item';
  else if (declared === 'damaged' || rejected > QTY_EPS) differenceKind = 'damaged';
  else if (declared === 'over' || over > QTY_EPS) differenceKind = 'over';
  else if (declared === 'short') differenceKind = 'short';
  return { ok: true, accepted, differenceKind, over };
}

export type ReceiptDraftCheck =
  | {
      ok: true;
      lines: Array<ReceiptLineDraft & { accepted: number; differenceKind: DifferenceKind }>;
    }
  | { ok: false; error: string; orderLineId: string | null };

/**
 * Validates the whole capture: every line individually, at least one line with
 * something received or a declared shortage, and evidence when anything is
 * rejected or missing (a difference with the supplier always needs proof).
 */
export function checkReceiptDraft(input: {
  lines: readonly ReceiptLineDraft[];
  evidenceCount: number;
}): ReceiptDraftCheck {
  if (input.lines.length === 0) {
    return { ok: false, error: 'Agrega al menos una partida recibida', orderLineId: null };
  }
  const checked: Array<ReceiptLineDraft & { accepted: number; differenceKind: DifferenceKind }> =
    [];
  let withDifference = 0;
  let touched = 0;
  for (const line of input.lines) {
    const result = checkReceiptLine(line);
    if (!result.ok) return { ok: false, error: result.error, orderLineId: line.orderLineId };
    if (line.qtyReceived > QTY_EPS || result.differenceKind !== 'none') touched += 1;
    if (result.differenceKind !== 'none') withDifference += 1;
    checked.push({ ...line, accepted: result.accepted, differenceKind: result.differenceKind });
  }
  if (touched === 0) {
    return {
      ok: false,
      error: 'No capturaste nada: indica lo que llegó o declara el faltante',
      orderLineId: null,
    };
  }
  if (withDifference > 0 && input.evidenceCount === 0) {
    return {
      ok: false,
      error: 'Sube una foto o el documento que respalde la diferencia antes de registrarla',
      orderLineId: null,
    };
  }
  return { ok: true, lines: checked };
}

/** Pending quantity of an order line (never available stock: it is only expected). */
export function pendingLineQty(line: {
  qty: string | number;
  qtyAccepted: string | number;
  status: string;
}): number {
  if (line.status === 'cancelled' || line.status === 'closed') return 0;
  const pending = Number(line.qty) - Number(line.qtyAccepted);
  return Number.isFinite(pending) ? Math.max(0, round4(pending)) : 0;
}

/**
 * What the person picks when the delivery did not match the order. The wording
 * is the one used at the dock, not the database value.
 */
const CAPTURE_DIFFERENCE_LABELS: Record<string, string> = {
  none: 'Sin diferencia',
  short: 'Faltante (no lo va a traer)',
  over: 'Llegó de más',
  damaged: 'Llegó dañado',
  wrong_item: 'Artículo equivocado',
};

export const DIFFERENCE_OPTIONS: ReadonlyArray<{ value: DifferenceKind; label: string }> =
  DIFFERENCE_KINDS.map((kind) => ({
    value: kind,
    label: labelOf(CAPTURE_DIFFERENCE_LABELS, kind),
  }));

// ---------------------------------------------------------------------------
// Next action of a procurement order
// ---------------------------------------------------------------------------

export interface OrderNextAction {
  /** Stable id used by the panel to open the right dialog. */
  id:
    | 'submit'
    | 'request_payment'
    | 'mark_sent'
    | 'receive'
    | 'confirm_direct'
    | 'resolve_difference'
    | 'close'
    | 'none';
  label: string;
  hint: string;
  /** Any of these permissions lets the person run it (the engine checks again). */
  permissions: readonly string[];
}

const NO_ACTION: OrderNextAction = {
  id: 'none',
  label: 'Sin acción pendiente',
  hint: 'Esta orden no necesita nada de Compras ahora mismo.',
  permissions: [],
};

/**
 * The single next thing Compras has to do with an order, from its state. One
 * primary action per view (UI rules): everything else stays in the panel as a
 * secondary action.
 */
export function orderNextAction(order: {
  status: string;
  paymentMode: string;
  paymentStatus: string;
  deliveryMode: string;
  sentToSupplierAt: string | null;
  obligationId: string | null;
  openDifferences: number;
}): OrderNextAction {
  if (order.openDifferences > 0) {
    return {
      id: 'resolve_difference',
      label: 'Resolver la diferencia',
      hint: 'La recepción encontró una diferencia; acuérdala con el proveedor para poder cerrar la orden.',
      permissions: ['purchases.receive', 'purchases.manage_orders'],
    };
  }
  switch (order.status) {
    case 'draft':
      return {
        id: 'submit',
        label: 'Enviar a aprobación',
        hint: 'Revisa partidas y precios; desde el umbral configurado necesita doble firma.',
        permissions: ['purchases.manage_orders'],
      };
    case 'approved':
      if (
        order.paymentMode === 'prepaid' &&
        order.paymentStatus !== 'paid' &&
        !order.obligationId
      ) {
        return {
          id: 'request_payment',
          label: 'Solicitar el pago',
          hint: 'El proveedor cobra por anticipado: Contabilidad tiene que autorizar el pago.',
          permissions: ['purchases.manage_orders'],
        };
      }
      return {
        id: 'mark_sent',
        label: 'Enviar al proveedor',
        hint: 'Manda la orden por WhatsApp o como PDF y deja constancia del envío.',
        permissions: ['purchases.manage_orders'],
      };
    case 'pending_payment':
      return {
        id: order.sentToSupplierAt ? 'none' : 'mark_sent',
        label: order.sentToSupplierAt ? 'Esperando el pago' : 'Enviar al proveedor',
        hint: order.sentToSupplierAt
          ? 'Contabilidad tiene que pagarla para que el proveedor surta.'
          : 'Puedes enviarla al proveedor mientras Contabilidad libera el pago.',
        permissions: ['purchases.manage_orders'],
      };
    case 'awaiting_receipt':
    case 'partially_received':
      return order.deliveryMode === 'direct_to_customer'
        ? {
            id: 'confirm_direct',
            label: 'Confirmar la entrega directa',
            hint: 'El proveedor entrega al cliente: registra qué dejó y sube la evidencia.',
            permissions: ['purchases.receive'],
          }
        : {
            id: 'receive',
            label: 'Registrar recepción',
            hint: 'Captura lo que llegó, lo que rechazas y la evidencia.',
            permissions: ['purchases.receive'],
          };
    case 'received':
      return {
        id: 'close',
        label: 'Cerrar la orden',
        hint: 'Todo llegó: ciérrala para que deje de aparecer como pendiente.',
        permissions: ['purchases.manage_orders'],
      };
    case 'disputed':
      return {
        id: 'resolve_difference',
        label: 'Resolver la diferencia',
        hint: 'La orden quedó en disputa: acuerda la reposición, la nota de crédito o la devolución.',
        permissions: ['purchases.receive', 'purchases.manage_orders'],
      };
    default:
      return NO_ACTION;
  }
}

// ---------------------------------------------------------------------------
// RFQ review
// ---------------------------------------------------------------------------

/** A response the model interpreted with low confidence has to be reviewed by a person. */
export function responseNeedsReview(response: {
  status: string;
  confidence: string | number | null;
  reviewReasons: readonly string[];
}): boolean {
  if (response.status === 'needs_review') return true;
  if (response.reviewReasons.length > 0 && response.status === 'parsed') return true;
  const confidence = Number(response.confidence);
  return response.status === 'parsed' && Number.isFinite(confidence) && confidence < 0.75;
}

/** Sentence explaining why a response is waiting for a person. */
export function reviewReasonText(reasons: readonly string[]): string | null {
  if (reasons.length === 0) return null;
  return reasons.length === 1
    ? `Revisa: ${reasons[0]}`
    : `Revisa: ${reasons.slice(0, 3).join('; ')}`;
}

export function invitationStatusLabel(status: string): string {
  return labelOf(RFQ_INVITATION_STATUS_LABELS, status);
}

export function responseStatusLabel(status: string): string {
  return labelOf(RFQ_RESPONSE_STATUS_LABELS, status);
}

export function candidateStatusLabel(status: string): string {
  return labelOf(CANDIDATE_STATUS_LABELS, status);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Realtime `purchases:board`
// ---------------------------------------------------------------------------

/**
 * Ids a `purchases.changed` message can carry (`publishBoard` of
 * `purchases-helpers.ts`). A command publishes only what it touched, so a
 * message about an order carries `orderId` and nothing else.
 */
export interface PurchasesBoardMessage {
  commandId?: string;
  commandType?: string;
  requestId?: string;
  requestLineIds?: string[];
  rfqId?: string;
  responseId?: string;
  orderId?: string;
  receiptId?: string;
  supplierId?: string;
  searchId?: string;
  candidateId?: string;
}

/** What a screen is showing, to decide whether a board message concerns it. */
export interface PurchasesBoardInterest {
  orderId?: string | null;
  rfqId?: string | null;
  searchId?: string | null;
  /** True for a screen that lists whatever changes (the Sourcing Lab's candidates). */
  anySourcing?: boolean;
}

const SOURCING_KEYS = ['searchId', 'candidateId', 'supplierId'] as const;

/**
 * True when a `purchases:board` message touches what the screen has on
 * display. PURE, so the decision is testable without a browser: the panels
 * only reload when the answer is yes, and a message about somebody else's
 * order never makes them refetch.
 *
 * An interest with no id at all matches every message (a board that shows the
 * whole area).
 */
export function purchasesBoardTouches(
  message: unknown,
  interest: PurchasesBoardInterest = {}
): boolean {
  if (!message || typeof message !== 'object') return false;
  const data = message as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  const wanted = [
    interest.orderId ? { key: 'orderId', id: interest.orderId } : null,
    interest.rfqId ? { key: 'rfqId', id: interest.rfqId } : null,
    interest.searchId ? { key: 'searchId', id: interest.searchId } : null,
  ].filter((entry): entry is { key: string; id: string } => entry !== null);

  if (wanted.some((entry) => text(entry.key) === entry.id)) return true;

  // A receipt of an order arrives as `{ orderId, receiptId }`, and picking an
  // RFQ response as `{ rfqId, orderId }`: the ids above already cover both.
  if (interest.anySourcing && SOURCING_KEYS.some((key) => text(key) !== null)) return true;

  return wanted.length === 0 && !interest.anySourcing;
}
