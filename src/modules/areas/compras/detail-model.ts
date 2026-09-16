import {
  DIFFERENCE_KINDS,
  DIFFERENCE_KIND_LABELS,
  DIFFERENCE_RESOLUTIONS,
  type DifferenceKind,
  type DifferenceResolution,
} from '@/modules/purchases/purchases-types';

/**
 * Rules of the Compras management panels (plan 6.1) — the flows the generic row
 * dialog cannot collect because they need STRUCTURED input: a receipt with an
 * accepted and a rejected quantity per line, the review of an RFQ response over
 * its scored comparison, and the resolution of a receipt difference.
 *
 * PURE and isomorphic: no Prisma, no React, no I/O. It runs in the browser
 * (the panel says in Spanish what is wrong before sending anything) and in the
 * test. It decides NOTHING about business: every payload it builds is validated
 * again by the Zod schema of its command (`recordReceiptSchema`,
 * `selectResponseSchema`, `resolveDifferenceSchema`) inside the transaction,
 * which is the single source of truth.
 *
 * Why it exists: before these panels Compras could list an order, an RFQ and a
 * receipt but could not WORK them — `postReceipt` with quantities,
 * `selectResponse`, `confirmResponse` and `resolve_difference` had no caller
 * outside the AI tools.
 */

// ---------------------------------------------------------------------------
// Captura de una recepción
// ---------------------------------------------------------------------------

export interface ReceiptLineForm {
  orderLineId: string;
  /** Cantidad que llegó, tal como la escribió la persona. */
  received: string;
  /** Parte de lo que llegó que se rechaza (dañado, artículo equivocado…). */
  rejected: string;
  differenceKind: DifferenceKind | '';
  lotCode: string;
}

export interface ReceiptLinePayload {
  orderLineId: string;
  qtyReceived: number;
  qtyRejected: number;
  differenceKind?: DifferenceKind;
  lotCode?: string;
}

export interface ReceiptPayload {
  orderId: string;
  lines: ReceiptLinePayload[];
  post: boolean;
  notes?: string;
  warehouseId?: string;
  locationId?: string;
  evidenceObjectIds: string[];
}

export type ReceiptFormResult =
  { ok: true; payload: ReceiptPayload } | { ok: false; errors: string[] };

/** Line of the order the panel captures against (only what the rules need). */
export interface ReceiptOrderLine {
  id: string;
  description: string;
  qty: string;
  qtyPending: string;
  status: string;
}

const MAX_LINES = 200;

function parseQty(raw: string): number | null {
  const text = raw.trim();
  if (!text) return 0;
  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10_000) / 10_000;
}

/** Accepted = what arrived minus what is rejected. The service stores it that way. */
export function acceptedQty(line: ReceiptLineForm): number {
  const received = parseQty(line.received);
  const rejected = parseQty(line.rejected);
  if (received === null || rejected === null) return 0;
  return Math.max(0, Math.round((received - rejected) * 10_000) / 10_000);
}

/** Blank capture form for the lines of an order that still expect material. */
export function emptyReceiptForm(lines: readonly ReceiptOrderLine[]): ReceiptLineForm[] {
  return lines
    .filter((line) => line.status !== 'cancelled' && line.status !== 'closed')
    .slice(0, MAX_LINES)
    .map((line) => ({
      orderLineId: line.id,
      received: '',
      rejected: '',
      differenceKind: '',
      lotCode: '',
    }));
}

/**
 * Difference the quantities themselves show, so the person does not have to
 * classify the obvious case: less than expected is `short`, more is `over`, and
 * anything rejected without its own reason is `damaged`. Whatever the person
 * picked always wins.
 */
export function suggestedDifferenceKind(
  line: ReceiptLineForm,
  orderLine: ReceiptOrderLine | undefined
): DifferenceKind {
  if (line.differenceKind) return line.differenceKind;
  const received = parseQty(line.received) ?? 0;
  const rejected = parseQty(line.rejected) ?? 0;
  if (rejected > 0) return 'damaged';
  const pending = orderLine ? Number(orderLine.qtyPending) : NaN;
  if (!Number.isFinite(pending) || received === 0) return 'none';
  if (received + 1e-9 < pending) return 'short';
  if (received > pending + 1e-9) return 'over';
  return 'none';
}

export interface ReceiptFormInput {
  orderId: string;
  lines: readonly ReceiptLineForm[];
  orderLines: readonly ReceiptOrderLine[];
  /** false leaves it as a draft, to be posted later with `purchases.receipt.post`. */
  post: boolean;
  notes?: string;
  warehouseId?: string | null;
  locationId?: string | null;
  evidenceObjectIds?: readonly string[];
}

/** Capture form → payload of `purchases.receipt.record`. */
export function receiptFormToPayload(input: ReceiptFormInput): ReceiptFormResult {
  const errors: string[] = [];
  const byId = new Map(input.orderLines.map((line) => [line.id, line]));
  const lines: ReceiptLinePayload[] = [];

  for (const line of input.lines) {
    const orderLine = byId.get(line.orderLineId);
    const label = orderLine?.description ?? line.orderLineId;
    const received = parseQty(line.received);
    const rejected = parseQty(line.rejected);
    if (received === null) {
      errors.push(`${label}: la cantidad recibida no es un número válido`);
      continue;
    }
    if (rejected === null) {
      errors.push(`${label}: la cantidad rechazada no es un número válido`);
      continue;
    }
    if (received === 0 && rejected === 0) continue;
    if (rejected > received) {
      errors.push(`${label}: no puedes rechazar más de lo que llegó`);
      continue;
    }
    const kind = suggestedDifferenceKind(line, orderLine);
    lines.push({
      orderLineId: line.orderLineId,
      qtyReceived: received,
      qtyRejected: rejected,
      ...(kind !== 'none' ? { differenceKind: kind } : {}),
      ...(line.lotCode.trim() ? { lotCode: line.lotCode.trim().slice(0, 80) } : {}),
    });
  }

  if (lines.length === 0 && errors.length === 0) {
    errors.push('Escribe cuánto llegó de al menos una partida');
  }
  if (lines.length > MAX_LINES) {
    errors.push(`Como máximo ${MAX_LINES} partidas por recepción`);
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      orderId: input.orderId,
      lines,
      post: input.post,
      ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 1000) } : {}),
      ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
      ...(input.locationId ? { locationId: input.locationId } : {}),
      evidenceObjectIds: [...(input.evidenceObjectIds ?? [])].slice(0, 20),
    },
  };
}

// ---------------------------------------------------------------------------
// Resolución de una diferencia
// ---------------------------------------------------------------------------

export const DIFFERENCE_RESOLUTION_LABELS: Record<DifferenceResolution, string> = {
  replacement: 'El proveedor repone el faltante',
  credit: 'El proveedor abona lo que no llegó',
  return: 'Se devuelve el material',
  accept: 'Se acepta tal como llegó',
};

export interface DifferenceForm {
  receiptLineId: string;
  resolution: DifferenceResolution | '';
  note: string;
  /** Sólo para `credit`: lo que se quita de la orden (vacío = todo lo pendiente). */
  creditQty: string;
}

export type DifferenceFormResult =
  | {
      ok: true;
      payload: {
        receiptLineId: string;
        resolution: DifferenceResolution;
        note: string;
        creditQty?: number;
      };
    }
  | { ok: false; errors: string[] };

/** Resolution form → payload of `purchases.receipt.resolve_difference`. */
export function differenceFormToPayload(form: DifferenceForm): DifferenceFormResult {
  const errors: string[] = [];
  if (!form.receiptLineId.trim()) errors.push('Elige la partida con diferencia');
  if (!form.resolution || !DIFFERENCE_RESOLUTIONS.includes(form.resolution)) {
    errors.push('Elige cómo se resuelve la diferencia');
  }
  const note = form.note.trim();
  if (note.length < 3) errors.push('Describe cómo se resolvió (3 caracteres o más)');
  if (note.length > 1000) errors.push('La descripción es demasiado larga (1000 caracteres)');

  let creditQty: number | undefined;
  if (form.resolution === 'credit' && form.creditQty.trim()) {
    const parsed = parseQty(form.creditQty);
    if (parsed === null || parsed <= 0)
      errors.push('La cantidad a abonar tiene que ser mayor que cero');
    else creditQty = parsed;
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      receiptLineId: form.receiptLineId.trim(),
      resolution: form.resolution as DifferenceResolution,
      note: note.slice(0, 1000),
      ...(creditQty !== undefined ? { creditQty } : {}),
    },
  };
}

export function differenceKindLabel(kind: string): string {
  return DIFFERENCE_KIND_LABELS[kind as DifferenceKind] ?? kind;
}

export const DIFFERENCE_KIND_OPTIONS: ReadonlyArray<{ value: DifferenceKind; label: string }> =
  DIFFERENCE_KINDS.map((kind) => ({ value: kind, label: DIFFERENCE_KIND_LABELS[kind] }));

// ---------------------------------------------------------------------------
// Revisión de una respuesta de cotización
// ---------------------------------------------------------------------------

/** Response as the panel reads it (a subset of `RfqResponseDTO`). */
export interface ReviewableResponse {
  id: string;
  name: string | null;
  status: string;
  statusLabel: string;
  landedTotal: string | null;
  currency: string;
  leadTimeDays: number | null;
  reviewReasons: string[];
}

/** One row of the scored comparison (a subset of `RfqRankingEntry`). */
export interface ComparisonEntry {
  responseId: string;
  rank: number;
  score: number;
  landedTotal: number | null;
  comparable: boolean;
  recommended: boolean;
  reasons: string[];
}

export type ResponseActionId = 'confirm' | 'reject' | 'select';

export interface ResponseAction {
  id: ResponseActionId;
  label: string;
  tone: 'primary' | 'default' | 'danger';
  hint: string;
}

/** Responses that still need somebody to read them before they can be compared. */
export const RESPONSE_REVIEW_STATUSES = ['needs_review', 'parsed'] as const;
/** A response can be chosen once it is confirmed and the RFQ is still open. */
export const RESPONSE_SELECTABLE_STATUSES = ['confirmed'] as const;
const RFQ_CLOSED_STATUSES = ['closed', 'cancelled', 'expired'];

/**
 * What a person may do with ONE response, given its state and that of its RFQ.
 * The command checks `purchases.manage_orders` again, so this only decides what
 * to SHOW.
 */
export function responseActions(
  response: Pick<ReviewableResponse, 'status'>,
  rfqStatus: string
): ResponseAction[] {
  if (RFQ_CLOSED_STATUSES.includes(rfqStatus)) return [];
  const out: ResponseAction[] = [];
  if ((RESPONSE_REVIEW_STATUSES as readonly string[]).includes(response.status)) {
    out.push({
      id: 'confirm',
      label: 'Confirmar lo que entendimos',
      tone: 'primary',
      hint: 'Das por buena la lectura de la respuesta: entra a la comparación con su costo puesto en bodega.',
    });
  }
  if ((RESPONSE_SELECTABLE_STATUSES as readonly string[]).includes(response.status)) {
    out.push({
      id: 'select',
      label: 'Elegir y crear la orden',
      tone: 'primary',
      hint: 'Cierra la cotización con este proveedor y crea el borrador de la orden de compra.',
    });
  }
  if (response.status !== 'rejected' && response.status !== 'selected') {
    out.push({
      id: 'reject',
      label: 'Descartar',
      tone: 'danger',
      hint: 'Sale de la comparación. Di por qué: queda en la cronología de la cotización.',
    });
  }
  return out;
}

/** Comparison ordered as it is shown: by rank, with the non-comparable ones last. */
export function orderedComparison(entries: readonly ComparisonEntry[]): ComparisonEntry[] {
  return [...entries].sort((a, b) => {
    if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
    return a.rank - b.rank;
  });
}

/** Same values as `ORDER_DELIVERY_MODES` (the test compares them). */
export type SelectDeliveryMode = 'warehouse' | 'direct_to_customer';

export interface SelectResponseForm {
  responseId: string;
  deliveryMode: SelectDeliveryMode | '';
  warehouseId: string;
  directDeliveryCaseId: string;
  expectedAt: string;
  notes: string;
}

export type SelectResponseResult =
  | {
      ok: true;
      payload: {
        responseId: string;
        deliveryMode?: SelectDeliveryMode;
        warehouseId?: string;
        directDeliveryCaseId?: string;
        expectedAt?: string;
        notes?: string;
      };
    }
  | { ok: false; errors: string[] };

/** Selection form → payload of `purchases.rfq.select_response`. */
export function selectResponseFormToPayload(form: SelectResponseForm): SelectResponseResult {
  const errors: string[] = [];
  if (!form.responseId.trim()) errors.push('Elige la respuesta que gana');
  if (form.deliveryMode === 'direct_to_customer' && !form.directDeliveryCaseId.trim()) {
    errors.push('Una entrega directa necesita el expediente al que llega el material');
  }
  if (form.expectedAt.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(form.expectedAt.trim())) {
    errors.push('La fecha esperada no es válida');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      responseId: form.responseId.trim(),
      ...(form.deliveryMode ? { deliveryMode: form.deliveryMode } : {}),
      ...(form.deliveryMode === 'warehouse' && form.warehouseId.trim()
        ? { warehouseId: form.warehouseId.trim() }
        : {}),
      ...(form.deliveryMode === 'direct_to_customer' && form.directDeliveryCaseId.trim()
        ? { directDeliveryCaseId: form.directDeliveryCaseId.trim() }
        : {}),
      ...(form.expectedAt.trim() ? { expectedAt: form.expectedAt.trim() } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim().slice(0, 2000) } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Sin escribir nada todavía (para refrescar sin pisar el trabajo de alguien)
// ---------------------------------------------------------------------------

/**
 * True when nobody has typed anything into the receipt capture yet.
 *
 * `purchases:board` tells the panel that ITS order moved. If the form is
 * untouched the panel simply reloads; if there is typing in it, it offers the
 * refresh instead of throwing the capture away. PURE, so both branches are
 * decided here and tested without a browser.
 */
export function receiptFormIsPristine(lines: readonly ReceiptLineForm[], notes: string): boolean {
  if (notes.trim() !== '') return false;
  return lines.every(
    (line) =>
      line.received.trim() === '' &&
      line.rejected.trim() === '' &&
      line.differenceKind === '' &&
      line.lotCode.trim() === ''
  );
}

/** Same rule for the RFQ review: a started selection or rejection is work in progress. */
export function rfqReviewIsPristine(
  selection: SelectResponseForm,
  rejecting: { responseId: string; reason: string } | null
): boolean {
  if (rejecting !== null) return false;
  return (
    selection.responseId.trim() === '' &&
    selection.deliveryMode === '' &&
    selection.warehouseId.trim() === '' &&
    selection.directDeliveryCaseId.trim() === '' &&
    selection.expectedAt.trim() === '' &&
    selection.notes.trim() === ''
  );
}
