'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { areaDetailHref, areaHref } from '@/modules/areas/area-registry';
import { AuthorizationError, getCurrentSession } from '@/modules/auth/authorization';
import type { CommandResult } from '@/modules/operations/commands';
import {
  confirmRfqResponse,
  createRfq,
  inviteSuppliers,
  promoteCandidateToSupplier,
  recordGoodsReceipt,
  rejectRfqResponse,
  resolveReceiptDifference,
  runSourcingSearch,
  selectRfqResponse,
  setCandidateStatus,
} from '@/modules/purchases/purchases-commands';
import {
  DIFFERENCE_KINDS,
  DIFFERENCE_RESOLUTIONS,
  ORDER_DELIVERY_MODES,
} from '@/modules/purchases/purchases-types';

/**
 * Server actions of the Sourcing Lab (plan 7.6).
 *
 * They exist because two of these flows are NOT a single command: asking a
 * candidate for a quotation creates the RFQ (command) and then sends the
 * invitations through the inbox (`inviteSuppliers`, which talks to the comms
 * service). A browser can only execute commands, so the composition lives on
 * the server, where the same service functions the AI tools use are called.
 *
 * Permissions are NOT re-implemented here: every function ends in a command of
 * `purchases-commands.ts`, which checks `purchases.sourcing`,
 * `purchases.manage_orders` or `purchases.manage_suppliers` inside the
 * transaction and rejects the rest. The session user is always the actor.
 */

export type ComprasActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

function failure(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/** A rejected command carries a Spanish message from the domain; never leak a stack. */
function fromCommand<T>(result: CommandResult<T>, fallback: string): ComprasActionResult<T> {
  if (result.status === 'completed' && result.data !== undefined) {
    return { ok: true, data: result.data };
  }
  return failure(result.message ?? fallback);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthorizationError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

async function actor() {
  const session = await getCurrentSession();
  if (!session) throw new AuthorizationError('Tu sesión expiró; vuelve a entrar para continuar');
  return session.user;
}

function revalidateLab(): void {
  revalidatePath(areaHref('compras', 'sourcing'));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const searchSchema = z.object({
  query: z.string().trim().min(3, 'Escribe qué buscas (3 caracteres o más)').max(200),
  providerKey: z.enum(['brave_search', 'catalog_page']),
  urls: z.array(z.string().trim().url('La dirección del catálogo no es válida')).max(5).default([]),
  refresh: z.boolean().default(false),
});

export interface SourcingSearchStarted {
  searchId: string;
  cached: boolean;
  status: string;
  resultCount: number;
  jobQueued: boolean;
  remainingBudget: number;
}

/**
 * Starts a supplier search. A repeated query inside the cache window answers
 * from the cache without spending budget (`cached: true`); otherwise the
 * background job runs and the view follows its progress.
 */
export async function runSourcingSearchAction(
  input: z.input<typeof searchSchema>
): Promise<ComprasActionResult<SourcingSearchStarted>> {
  const parsed = searchSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const result = await runSourcingSearch(user, {
      query: parsed.data.query,
      providerKey: parsed.data.providerKey,
      urls: parsed.data.urls,
      filters: {},
      refresh: parsed.data.refresh,
    });
    const outcome = fromCommand(result, 'No se pudo iniciar la búsqueda');
    if (outcome.ok) revalidateLab();
    return outcome as ComprasActionResult<SourcingSearchStarted>;
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo iniciar la búsqueda'));
  }
}

// ---------------------------------------------------------------------------
// Ask a candidate for a quotation (RFQ through the inbox)
// ---------------------------------------------------------------------------

const requestQuoteSchema = z.object({
  candidateIds: z
    .array(z.string().trim().min(1).max(120))
    .min(1, 'Elige al menos un proveedor')
    .max(10, 'Puedes invitar hasta 10 proveedores a la vez'),
  title: z.string().trim().min(3, 'Escribe de qué es la cotización').max(200),
  description: z.string().trim().min(3, 'Describe el material').max(300),
  qty: z.number().finite().positive('La cantidad debe ser mayor que cero'),
  unit: z.string().trim().min(1, 'Indica la unidad').max(40),
  dueDays: z.number().int().min(1).max(60).default(3),
});

export interface QuoteRequested {
  rfqId: string;
  number: string;
  sent: number;
  failed: number;
}

/**
 * Creates the RFQ with one line and invites the chosen candidates through the
 * inbox (WhatsApp / SMS / Telegram with the approved template). Sending is
 * idempotent: repeating it never writes to a supplier twice.
 */
export async function requestQuoteFromCandidatesAction(
  input: z.input<typeof requestQuoteSchema>
): Promise<ComprasActionResult<QuoteRequested>> {
  const parsed = requestQuoteSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const dueAt = new Date(Date.now() + parsed.data.dueDays * 86_400_000).toISOString();
    const created = await createRfq(user, {
      title: parsed.data.title,
      dueAt,
      lines: [
        {
          description: parsed.data.description,
          qty: parsed.data.qty,
          unit: parsed.data.unit,
        },
      ],
    });
    const rfq = fromCommand(created, 'No se pudo crear la cotización');
    if (!rfq.ok) return rfq;

    const invited = await inviteSuppliers(user, {
      rfqId: rfq.data.rfqId,
      invitees: parsed.data.candidateIds.map((candidateId) => ({ candidateId })),
    });
    if (invited.command.status !== 'completed') {
      return failure(
        invited.command.message ??
          `Creamos la cotización ${rfq.data.number}, pero no pudimos invitar a los proveedores`
      );
    }
    revalidateLab();
    return {
      ok: true,
      data: {
        rfqId: rfq.data.rfqId,
        number: rfq.data.number,
        sent: invited.sent,
        failed: invited.failed,
      },
    };
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo enviar la solicitud de cotización'));
  }
}

// ---------------------------------------------------------------------------
// Promote a candidate to supplier
// ---------------------------------------------------------------------------

const promoteSchema = z.object({
  candidateId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(2, 'El nombre es muy corto').max(200).optional(),
  paymentMode: z.enum(['prepaid', 'credit', 'cod']).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
  leadTimeDaysDefault: z.number().int().min(0).max(365).nullish(),
});

export interface CandidatePromoted {
  supplierId: string;
  number: string;
  name: string;
  created: boolean;
}

/** Turns a candidate into a supplier of UNIK (or links it to the one that already existed). */
export async function promoteCandidateAction(
  input: z.input<typeof promoteSchema>
): Promise<ComprasActionResult<CandidatePromoted>> {
  const parsed = promoteSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const result = await promoteCandidateToSupplier(user, parsed.data);
    const outcome = fromCommand(result, 'No se pudo convertir el candidato en proveedor');
    if (!outcome.ok) return outcome;
    revalidateLab();
    return {
      ok: true,
      data: {
        supplierId: outcome.data.supplier.id,
        number: outcome.data.supplier.number,
        name: outcome.data.supplier.name,
        created: outcome.data.created,
      },
    };
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo convertir el candidato en proveedor'));
  }
}

// ---------------------------------------------------------------------------
// Work the candidate list
// ---------------------------------------------------------------------------

const candidateStatusSchema = z.object({
  candidateId: z.string().trim().min(1).max(120),
  status: z.enum(['new', 'contacted', 'approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});

/** Marks a candidate as contacted, approved or discarded (with the reason). */
export async function updateCandidateStatusAction(
  input: z.input<typeof candidateStatusSchema>
): Promise<ComprasActionResult<{ candidateId: string; status: string }>> {
  const parsed = candidateStatusSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const result = await setCandidateStatus(user, parsed.data);
    const outcome = fromCommand(result, 'No se pudo actualizar el candidato');
    if (outcome.ok) revalidateLab();
    return outcome;
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo actualizar el candidato'));
  }
}

// ---------------------------------------------------------------------------
// Paneles de gestión: recepciones, diferencias y revisión de cotizaciones
// ---------------------------------------------------------------------------

/**
 * Los flujos de Compras que el diálogo genérico de la tabla NO puede recoger,
 * porque piden datos estructurados: una recepción con cantidad aceptada y
 * rechazada por partida, la resolución de una diferencia y la revisión de una
 * respuesta de cotización sobre su comparación con puntaje (plan 6.1).
 *
 * Igual que arriba: aquí no se decide negocio ni se repiten permisos. Cada
 * función termina en el MISMO servicio que usan las tools de IA
 * (`purchases-commands.ts`), que valida el esquema, el permiso
 * (`purchases.receive` / `purchases.manage_orders`) y la transición dentro de
 * la transacción. La persona de la sesión siempre es el actor.
 */

function revalidateOrder(orderId: string): void {
  revalidatePath(areaDetailHref('compras', 'ordenes', orderId));
  revalidatePath(areaHref('compras', 'trabajo'));
}

function revalidateRfq(rfqId: string): void {
  revalidatePath(areaDetailHref('compras', 'rfq', rfqId));
  revalidatePath(areaHref('compras', 'trabajo'));
}

const receiptLineSchema = z.object({
  orderLineId: z.string().trim().min(1).max(120),
  qtyReceived: z.number().nonnegative(),
  qtyRejected: z.number().nonnegative().optional(),
  differenceKind: z.enum(DIFFERENCE_KINDS).optional(),
  lotCode: z.string().trim().max(80).optional(),
});

const recordReceiptActionSchema = z.object({
  orderId: z.string().trim().min(1).max(120),
  lines: z.array(receiptLineSchema).min(1, 'Registra al menos una partida').max(200),
  post: z.boolean().default(true),
  notes: z.string().trim().max(1000).optional(),
  warehouseId: z.string().trim().max(120).optional(),
  locationId: z.string().trim().max(120).optional(),
  evidenceObjectIds: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
});

export interface ReceiptRecorded {
  receiptId: string;
  number: string;
  status: string;
  /** Null when it stayed a draft: it is posted later from the receipt row. */
  posted: boolean;
}

/**
 * Captures a goods receipt with what actually arrived and what is rejected per
 * line. `post: false` leaves it as a draft, which the receipt row then posts
 * with `purchases.receipt.post`.
 */
export async function recordGoodsReceiptAction(
  input: z.input<typeof recordReceiptActionSchema>
): Promise<ComprasActionResult<ReceiptRecorded>> {
  const parsed = recordReceiptActionSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const result = await recordGoodsReceipt(user, parsed.data);
    const outcome = fromCommand(result, 'No se pudo registrar la recepción');
    if (!outcome.ok) return outcome;
    revalidateOrder(parsed.data.orderId);
    return {
      ok: true,
      data: {
        receiptId: outcome.data.receiptId,
        number: outcome.data.number,
        status: outcome.data.status,
        posted: outcome.data.posted !== null,
      },
    };
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo registrar la recepción'));
  }
}

const resolveDifferenceActionSchema = z.object({
  orderId: z.string().trim().min(1).max(120),
  receiptLineId: z.string().trim().min(1).max(120),
  resolution: z.enum(DIFFERENCE_RESOLUTIONS),
  note: z.string().trim().min(3, 'Describe cómo se resolvió').max(1000),
  creditQty: z.number().positive().optional(),
});

/** Settles a receipt difference (replacement, credit, return or accepting it). */
export async function resolveReceiptDifferenceAction(
  input: z.input<typeof resolveDifferenceActionSchema>
): Promise<ComprasActionResult<{ orderId: string; orderStatus: string; creditedQty: number }>> {
  const parsed = resolveDifferenceActionSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const { orderId, ...payload } = parsed.data;
    const result = await resolveReceiptDifference(user, payload);
    const outcome = fromCommand(result, 'No se pudo resolver la diferencia');
    if (outcome.ok) revalidateOrder(orderId);
    return outcome;
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo resolver la diferencia'));
  }
}

const rfqResponseSchema = z.object({
  rfqId: z.string().trim().min(1).max(120),
  responseId: z.string().trim().min(1).max(120),
});

/** Takes the interpretation of a supplier reply as good: it enters the comparison. */
export async function confirmRfqResponseAction(
  input: z.input<typeof rfqResponseSchema>
): Promise<ComprasActionResult<{ responseId: string; status: string }>> {
  const parsed = rfqResponseSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const result = await confirmRfqResponse(user, { responseId: parsed.data.responseId });
    const outcome = fromCommand(result, 'No se pudo confirmar la respuesta');
    if (!outcome.ok) return outcome;
    revalidateRfq(parsed.data.rfqId);
    return {
      ok: true,
      data: { responseId: outcome.data.response.id, status: outcome.data.response.status },
    };
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo confirmar la respuesta'));
  }
}

const rejectRfqResponseActionSchema = rfqResponseSchema.extend({
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});

/** Drops a response out of the comparison, with the reason. */
export async function rejectRfqResponseAction(
  input: z.input<typeof rejectRfqResponseActionSchema>
): Promise<ComprasActionResult<{ responseId: string; status: string }>> {
  const parsed = rejectRfqResponseActionSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const result = await rejectRfqResponse(user, {
      responseId: parsed.data.responseId,
      reason: parsed.data.reason,
    });
    const outcome = fromCommand(result, 'No se pudo descartar la respuesta');
    if (outcome.ok) revalidateRfq(parsed.data.rfqId);
    return outcome;
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo descartar la respuesta'));
  }
}

const selectRfqResponseActionSchema = rfqResponseSchema.extend({
  deliveryMode: z.enum(ORDER_DELIVERY_MODES).optional(),
  warehouseId: z.string().trim().max(120).optional(),
  directDeliveryCaseId: z.string().trim().max(120).optional(),
  expectedAt: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export interface RfqResponseSelected {
  responseId: string;
  orderId: string;
  orderNumber: string;
}

/** Picks the winning response: closes the RFQ and creates the draft of the order. */
export async function selectRfqResponseAction(
  input: z.input<typeof selectRfqResponseActionSchema>
): Promise<ComprasActionResult<RfqResponseSelected>> {
  const parsed = selectRfqResponseActionSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? 'Datos inválidos');
  try {
    const user = await actor();
    const { rfqId, ...payload } = parsed.data;
    const result = await selectRfqResponse(user, payload);
    const outcome = fromCommand(result, 'No se pudo elegir la respuesta');
    if (!outcome.ok) return outcome;
    revalidateRfq(rfqId);
    revalidateOrder(outcome.data.orderId);
    return {
      ok: true,
      data: {
        responseId: outcome.data.responseId,
        orderId: outcome.data.orderId,
        orderNumber: outcome.data.orderNumber,
      },
    };
  } catch (error) {
    return failure(errorMessage(error, 'No se pudo elegir la respuesta'));
  }
}
