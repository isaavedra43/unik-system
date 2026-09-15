import { Prisma, type AreaRequest, type PurchaseRequest, type PurchaseRequestLine } from '@prisma/client';
import { z } from 'zod';
import {
  isAreaRequestOpenStatus,
  transitionAreaRequestInTx,
} from '@/modules/operations/area-requests-service';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { AREA_KEYS, AREA_LABELS, PRIORITIES, WORK_ITEM_OPEN_STATUSES, isAreaKey } from '@/modules/operations/types';
import {
  D,
  assertFoundRow,
  emitPurchases,
  isoDay,
  nextFolio,
  num,
  publishBoard,
  recordActorId,
  round4,
  truncate,
  type Db,
} from './purchases-helpers';
import { idText, isoDateText, optionalText, positiveQty, toDate } from './purchases-schemas';
import {
  PURCHASES_AREA_KEY,
  PURCHASES_EVENTS,
  PURCHASES_OBJECT_TYPES,
  SHORTFALL_REQUEST_KINDS,
} from './purchases-types';
import {
  consolidationKey,
  remainingToOrder,
  requestLineStatus,
  requestStatusFromLines,
  suggestConsolidations,
  type ConsolidationGroup,
} from './request-rules';

/**
 * Purchase requests (plan 6.1, `requests-service`).
 *
 * - `createPurchaseRequestInTx`: manual or from case demands. A request of
 *   Inventario about a case demand also sends the blocking `purchase_shortfall`
 *   request to Compras (so the case shows who owes what).
 * - `syncShortfallRequestInTx`: the núcleo integration. Every area request of
 *   a shortfall addressed to Compras (the `solicitar_compra` engine step,
 *   `material_shortfall`, `direct_delivery`) creates — or updates — ONE purchase
 *   request line linked to the demand/allocation; a rejected, cancelled or
 *   expired request cancels the lines not ordered yet. Runs as a system command
 *   from the `purchases.shortfall_sync` job planned in the same transaction as
 *   the request (never lost).
 * - Consolidation keys `zohoItemId|ISO week` and the daily suggestion.
 */

const OBJ = PURCHASES_OBJECT_TYPES;
const EV = PURCHASES_EVENTS.request;
const EPS = 0.00005;

/** Relation area request → purchase request line created for it. */
export const SHORTFALL_LINE_RELATION = 'fulfilled_by';
export const CONSOLIDATION_OBJECT_TYPE = 'purchases_consolidation';
const DEAD_REQUEST_STATUSES = ['rejected', 'cancelled', 'expired'];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const requestLineInputSchema = z.object({
  demandId: idText.nullish(),
  allocationId: idText.nullish(),
  zohoItemId: idText.nullish(),
  description: optionalText(300),
  qty: positiveQty,
  unit: optionalText(40),
});

export const createPurchaseRequestSchema = z.object({
  caseId: idText.nullish(),
  /** Area that asks; with a case and Inventario, a blocking shortfall request reaches Compras. */
  areaKey: z.enum(AREA_KEYS).default('compras'),
  priority: z.enum(PRIORITIES).default('normal'),
  neededBy: isoDateText.nullish(),
  reason: optionalText(1000),
  status: z.enum(['draft', 'open']).default('open'),
  notifyCompras: z.boolean().default(true),
  lines: z.array(requestLineInputSchema).min(1, 'Agrega al menos una partida').max(100),
});
export type CreatePurchaseRequestInput = z.output<typeof createPurchaseRequestSchema>;

export const cancelPurchaseRequestSchema = z.object({
  requestId: idText,
  reason: z.string().trim().min(3, 'Indica el motivo').max(500),
});

export const syncShortfallSchema = z.object({ areaRequestId: idText });

// ---------------------------------------------------------------------------
// Line and request state helpers
// ---------------------------------------------------------------------------

function lineQuantities(line: PurchaseRequestLine) {
  return { status: line.status, qty: num(line.qty), qtyOrdered: num(line.qtyOrdered), qtyReceived: num(line.qtyReceived) };
}

/** Recomputes the status of requests after their lines changed; emits `purchases.request.updated`. */
export async function recomputeRequestStatuses(
  tx: Db,
  requestIds: Iterable<string>,
  ctx: CommandContext
): Promise<PurchaseRequest[]> {
  const out: PurchaseRequest[] = [];
  for (const requestId of new Set(requestIds)) {
    const request = await tx.purchaseRequest.findUnique({ where: { id: requestId } });
    if (!request) continue;
    const lines = await tx.purchaseRequestLine.findMany({ where: { requestId } });
    const next = requestStatusFromLines(request.status, lines.map(lineQuantities));
    if (next === request.status) {
      out.push(request);
      continue;
    }
    const updated = await tx.purchaseRequest.update({
      where: { id: request.id },
      data: { status: next, version: { increment: 1 } },
    });
    emitPurchases(
      ctx,
      next === 'cancelled' ? EV.cancelled : EV.updated,
      { requestId: request.id, number: request.number, status: next, previousStatus: request.status },
      { caseId: request.caseId, objectType: OBJ.request, objectId: request.id }
    );
    out.push(updated);
  }
  return out;
}

async function setLineQuantities(
  tx: Db,
  line: PurchaseRequestLine,
  data: { qtyOrdered?: Prisma.Decimal; qtyReceived?: Prisma.Decimal; qty?: Prisma.Decimal }
): Promise<PurchaseRequestLine> {
  const next = {
    status: line.status,
    qty: data.qty !== undefined ? num(data.qty) : num(line.qty),
    qtyOrdered: data.qtyOrdered !== undefined ? num(data.qtyOrdered) : num(line.qtyOrdered),
    qtyReceived: data.qtyReceived !== undefined ? num(data.qtyReceived) : num(line.qtyReceived),
  };
  return tx.purchaseRequestLine.update({
    where: { id: line.id },
    data: { ...data, status: requestLineStatus(next) },
  });
}

/** Adds (or with a negative delta, gives back) ordered quantity to a request line. */
export async function adjustRequestLineOrdered(tx: Db, requestLineId: string, delta: number): Promise<PurchaseRequestLine | null> {
  const line = await tx.purchaseRequestLine.findUnique({ where: { id: requestLineId } });
  if (!line || line.status === 'cancelled') return line;
  const qtyOrdered = D(Math.max(0, round4(num(line.qtyOrdered) + delta)));
  return setLineQuantities(tx, line, { qtyOrdered });
}

export async function addRequestLineReceived(tx: Db, requestLineId: string, delta: number): Promise<PurchaseRequestLine | null> {
  const line = await tx.purchaseRequestLine.findUnique({ where: { id: requestLineId } });
  if (!line || line.status === 'cancelled') return line;
  const qtyReceived = D(Math.max(0, round4(num(line.qtyReceived) + delta)));
  return setLineQuantities(tx, line, { qtyReceived });
}

/** Open request lines with quantity still to order, in the given order (throws when one is not available). */
export async function loadOrderableRequestLines(tx: Db, lineIds: readonly string[]): Promise<PurchaseRequestLine[]> {
  const ids = [...new Set(lineIds)];
  const lines = await tx.purchaseRequestLine.findMany({ where: { id: { in: ids } } });
  if (lines.length !== ids.length) throw new OperationsError('not_found', 'Alguna partida de solicitud no existe');
  const requests = await tx.purchaseRequest.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.requestId))] } },
    select: { id: true, status: true, number: true },
  });
  for (const line of lines) {
    const request = requests.find((r) => r.id === line.requestId);
    if (!request || request.status === 'cancelled' || request.status === 'closed' || request.status === 'draft') {
      throw new OperationsError('invalid_state', `La solicitud ${request?.number ?? ''} no está abierta`.trim());
    }
    if (remainingToOrder(lineQuantities(line)) <= EPS) {
      throw new OperationsError('invalid_state', `La partida "${truncate(line.description, 60)}" ya está ordenada`);
    }
  }
  return ids.map((id) => lines.find((l) => l.id === id)!);
}

/** Moves open requests to a sourcing stage (`sourcing` for an RFQ, `consolidated` for a consolidation). */
export async function markRequestsStage(
  tx: Db,
  requestIds: Iterable<string>,
  stage: 'sourcing' | 'consolidated',
  ctx: CommandContext
): Promise<void> {
  for (const requestId of new Set(requestIds)) {
    const request = await tx.purchaseRequest.findUnique({ where: { id: requestId } });
    if (!request || !['open', 'sourcing', 'consolidated'].includes(request.status) || request.status === stage) continue;
    await tx.purchaseRequest.update({ where: { id: request.id }, data: { status: stage, version: { increment: 1 } } });
    emitPurchases(
      ctx,
      stage === 'consolidated' ? EV.consolidated : EV.updated,
      { requestId: request.id, number: request.number, status: stage, previousStatus: request.status },
      { caseId: request.caseId, objectType: OBJ.request, objectId: request.id }
    );
  }
}

// ---------------------------------------------------------------------------
// Shortfall area requests linked to lines and allocations
// ---------------------------------------------------------------------------

/** Open shortfall requests to Compras behind these request lines or case allocations. */
export async function openShortfallRequests(
  tx: Db,
  refs: { requestLineIds?: readonly string[]; allocationIds?: readonly string[] }
): Promise<AreaRequest[]> {
  const ids = new Set<string>();
  const lineIds = [...new Set(refs.requestLineIds ?? [])];
  if (lineIds.length > 0) {
    const relations = await tx.objectRelation.findMany({
      where: { fromType: 'area_request', toType: OBJ.requestLine, toId: { in: lineIds }, relation: SHORTFALL_LINE_RELATION, validTo: null },
      select: { fromId: true },
    });
    for (const relation of relations) ids.add(relation.fromId);
  }
  const allocationIds = [...new Set(refs.allocationIds ?? [])];
  if (allocationIds.length > 0) {
    const allocations = await tx.demandAllocation.findMany({
      where: { id: { in: allocationIds }, linkedType: 'area_request', linkedId: { not: null } },
      select: { linkedId: true },
    });
    for (const allocation of allocations) if (allocation.linkedId) ids.add(allocation.linkedId);
  }
  if (ids.size === 0) return [];
  const requests = await tx.areaRequest.findMany({ where: { id: { in: [...ids] } } });
  return requests.filter(
    (request) =>
      (SHORTFALL_REQUEST_KINDS as readonly string[]).includes(request.kind) &&
      request.toAreaKey === PURCHASES_AREA_KEY &&
      isAreaRequestOpenStatus(request.status)
  );
}

// ---------------------------------------------------------------------------
// Create / cancel
// ---------------------------------------------------------------------------

export interface CreatedPurchaseRequest {
  request: PurchaseRequest;
  lines: PurchaseRequestLine[];
  areaRequestIds: string[];
}

export async function createPurchaseRequestInTx(
  tx: Db,
  input: CreatePurchaseRequestInput,
  ctx: CommandContext,
  options: { fromAreaRequest?: AreaRequest | null } = {}
): Promise<CreatedPurchaseRequest> {
  let caseId = input.caseId ?? null;
  const neededBy = toDate(input.neededBy ?? null);
  if (neededBy && neededBy.getTime() < ctx.now.getTime() - 86_400_000) {
    throw new OperationsError('invalid_payload', 'La fecha requerida ya pasó');
  }
  const prepared: Array<{
    demandId: string | null;
    allocationId: string | null;
    zohoItemId: string | null;
    description: string;
    qty: number;
    unit: string;
    demandName: string | null;
    sku: string | null;
  }> = [];
  for (const line of input.lines) {
    let zohoItemId = line.zohoItemId ?? null;
    let description = line.description ?? null;
    let unit = line.unit ?? null;
    let demandName: string | null = null;
    let sku: string | null = null;
    if (line.demandId) {
      const demand = assertFoundRow(await tx.caseDemand.findUnique({ where: { id: line.demandId } }), 'No se encontró la partida del expediente');
      if (caseId && demand.caseId !== caseId) {
        throw new OperationsError('invalid_payload', 'Todas las partidas deben ser del mismo expediente');
      }
      caseId = demand.caseId;
      if (demand.status === 'fulfilled' || demand.status === 'cancelled') {
        throw new OperationsError('invalid_state', `La partida "${demand.name}" ya está surtida o cancelada`);
      }
      zohoItemId = zohoItemId ?? demand.zohoItemId;
      description = description ?? demand.name;
      unit = unit ?? demand.baseUnit;
      demandName = demand.name;
      sku = demand.sku ?? demand.zohoItemId ?? demand.lineRef;
      if (line.allocationId) {
        const allocation = await tx.demandAllocation.findUnique({ where: { id: line.allocationId } });
        if (!allocation || allocation.demandId !== demand.id) {
          throw new OperationsError('invalid_payload', 'La asignación no pertenece a la partida');
        }
        if (allocation.source !== 'purchase' && allocation.source !== 'direct_supplier') {
          throw new OperationsError('invalid_payload', 'La asignación no se abastece con compra');
        }
      }
    } else if (line.allocationId) {
      throw new OperationsError('invalid_payload', 'Una asignación necesita su partida (demandId)');
    }
    if (!description) throw new OperationsError('invalid_payload', 'Describe cada partida sin expediente');
    if (!unit) throw new OperationsError('invalid_payload', `Indica la unidad de "${truncate(description, 60)}"`);
    prepared.push({
      demandId: line.demandId ?? null,
      allocationId: line.allocationId ?? null,
      zohoItemId,
      description,
      qty: line.qty,
      unit,
      demandName,
      sku,
    });
  }
  let caseNumber: string | null = null;
  if (caseId) {
    const opCase = assertFoundRow(
      await tx.operationalCase.findUnique({ where: { id: caseId }, select: { id: true, caseNumber: true, status: true } }),
      'No se encontró el expediente'
    );
    if (opCase.status === 'closed' || opCase.status === 'cancelled') {
      throw new OperationsError('invalid_state', `El expediente ${opCase.caseNumber} ya está cerrado o cancelado`);
    }
    caseNumber = opCase.caseNumber;
  }

  const number = await nextFolio(tx, 'request');
  const request = await tx.purchaseRequest.create({
    data: {
      number,
      caseId,
      requestedByUserId: options.fromAreaRequest
        ? options.fromAreaRequest.createdByType === 'user' && options.fromAreaRequest.createdById
          ? options.fromAreaRequest.createdById
          : `system:${options.fromAreaRequest.createdById ?? 'operations'}`.slice(0, 120)
        : recordActorId(ctx),
      areaKey: input.areaKey,
      status: input.status,
      priority: input.priority,
      neededBy,
      reason: input.reason ?? null,
    },
  });
  const keyDate = neededBy ?? ctx.now;
  const lines: PurchaseRequestLine[] = [];
  for (const [index, line] of prepared.entries()) {
    lines.push(
      await tx.purchaseRequestLine.create({
        data: {
          requestId: request.id,
          demandId: line.demandId,
          allocationId: line.allocationId,
          zohoItemId: line.zohoItemId,
          consolidationKey: consolidationKey(line.zohoItemId, keyDate),
          description: line.description,
          qty: D(line.qty),
          unit: line.unit,
          status: 'open',
          sortOrder: index,
        },
      })
    );
  }
  if (caseId) {
    await ctx.relate({ type: OBJ.request, id: request.id }, { type: 'operational_case', id: caseId }, 'for_case');
  }

  const areaRequestIds: string[] = [];
  if (options.fromAreaRequest) {
    for (const line of lines) {
      await ctx.relate({ type: 'area_request', id: options.fromAreaRequest.id }, { type: OBJ.requestLine, id: line.id }, SHORTFALL_LINE_RELATION);
    }
  } else if (caseId && input.areaKey === 'inventario' && input.notifyCompras && input.status === 'open') {
    // Inventario asks Compras for a case demand: the blocking request keeps the case honest.
    for (const [index, line] of lines.entries()) {
      const source = prepared[index];
      if (!source.demandId) continue;
      const { request: areaRequest } = await ctx.createAreaRequest({
        caseId,
        fromAreaKey: 'inventario',
        toAreaKey: PURCHASES_AREA_KEY,
        kind: 'purchase_shortfall',
        objectType: OBJ.requestLine,
        objectId: line.id,
        title: truncate(`Comprar ${source.qty} ${source.unit} de ${source.description} (${number})`, 200),
        payload: {
          demandId: source.demandId,
          ...(source.allocationId ? { allocationId: source.allocationId } : {}),
          sku: (source.sku ?? source.zohoItemId ?? source.demandId).slice(0, 120),
          productName: (source.demandName ?? source.description).slice(0, 300),
          missingQty: source.qty,
          unit: source.unit,
          neededBy: isoDay(neededBy ?? new Date(ctx.now.getTime() + 3 * 86_400_000)),
        },
        freeText: input.reason ?? null,
        priority: input.priority,
      });
      areaRequestIds.push(areaRequest.id);
      await ctx.relate({ type: 'area_request', id: areaRequest.id }, { type: OBJ.requestLine, id: line.id }, SHORTFALL_LINE_RELATION);
    }
  }

  emitPurchases(
    ctx,
    EV.created,
    {
      requestId: request.id,
      number,
      caseId,
      caseNumber,
      areaKey: request.areaKey,
      priority: request.priority,
      lines: lines.length,
      source: options.fromAreaRequest ? 'area_request' : 'manual',
      areaRequestId: options.fromAreaRequest?.id ?? null,
    },
    { caseId, objectType: OBJ.request, objectId: request.id }
  );
  publishBoard(ctx, { requestId: request.id });
  return { request, lines, areaRequestIds };
}

export async function cancelPurchaseRequestInTx(
  tx: Db,
  input: z.output<typeof cancelPurchaseRequestSchema>,
  ctx: CommandContext
): Promise<PurchaseRequest> {
  const request = assertFoundRow(await tx.purchaseRequest.findUnique({ where: { id: input.requestId } }), 'No se encontró la solicitud de compra');
  if (request.status === 'cancelled' || request.status === 'closed') {
    throw new OperationsError('invalid_state', 'La solicitud ya está cerrada o cancelada');
  }
  const lines = await tx.purchaseRequestLine.findMany({ where: { requestId: request.id } });
  const ordered = lines.filter((line) => line.status !== 'cancelled' && num(line.qtyOrdered) > EPS);
  if (ordered.length > 0) {
    throw new OperationsError(
      'invalid_state',
      'La solicitud ya tiene partidas en una orden de compra: cancela o ajusta primero la orden'
    );
  }
  for (const line of lines) {
    if (line.status !== 'cancelled') await tx.purchaseRequestLine.update({ where: { id: line.id }, data: { status: 'cancelled' } });
  }
  const updated = await tx.purchaseRequest.update({ where: { id: request.id }, data: { status: 'cancelled' } });
  // Compras will not buy it: the case re-plans the allocation instead of waiting forever.
  for (const areaRequest of await openShortfallRequests(tx, { requestLineIds: lines.map((l) => l.id) })) {
    await transitionAreaRequestInTx(tx, areaRequest, 'reject', {
      reason: `Compras canceló la solicitud ${request.number}: ${input.reason}`,
    });
  }
  emitPurchases(
    ctx,
    EV.cancelled,
    { requestId: request.id, number: request.number, reason: input.reason, previousStatus: request.status },
    { caseId: request.caseId, objectType: OBJ.request, objectId: request.id }
  );
  publishBoard(ctx, { requestId: request.id });
  return updated;
}

// ---------------------------------------------------------------------------
// Núcleo integration: shortfall area requests → purchase requests
// ---------------------------------------------------------------------------

const shortfallPayloadSchema = z
  .object({
    demandId: z.string().min(1).optional(),
    allocationId: z.string().min(1).optional(),
    productionOrderId: z.string().min(1).optional(),
    sku: z.string().optional(),
    productName: z.string().optional(),
    missingQty: z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite().positive()),
    unit: z.string().trim().min(1),
    neededBy: z.string().optional(),
  })
  .passthrough();

export interface ShortfallSyncResult {
  action: 'created' | 'updated' | 'unchanged' | 'cancelled' | 'skipped';
  reason?: string;
  requestId?: string;
  lineIds?: string[];
}

export async function syncShortfallRequestInTx(
  tx: Db,
  input: z.output<typeof syncShortfallSchema>,
  ctx: CommandContext
): Promise<ShortfallSyncResult> {
  const areaRequest = await tx.areaRequest.findUnique({ where: { id: input.areaRequestId } });
  if (!areaRequest) return { action: 'skipped', reason: 'not_found' };
  if (!(SHORTFALL_REQUEST_KINDS as readonly string[]).includes(areaRequest.kind) || areaRequest.toAreaKey !== PURCHASES_AREA_KEY) {
    return { action: 'skipped', reason: 'not_a_shortfall' };
  }
  const payload = shortfallPayloadSchema.safeParse(areaRequest.payload);
  if (!payload.success) return { action: 'skipped', reason: 'invalid_payload' };

  const relations = await tx.objectRelation.findMany({
    where: { fromType: 'area_request', fromId: areaRequest.id, toType: OBJ.requestLine, relation: SHORTFALL_LINE_RELATION, validTo: null },
    select: { toId: true },
  });
  let lines = relations.length
    ? await tx.purchaseRequestLine.findMany({ where: { id: { in: relations.map((r) => r.toId) } } })
    : [];
  if (lines.length === 0 && payload.data.allocationId) {
    lines = await tx.purchaseRequestLine.findMany({
      where: { allocationId: payload.data.allocationId, status: { not: 'cancelled' } },
    });
  }

  const allocation = payload.data.allocationId
    ? await tx.demandAllocation.findUnique({ where: { id: payload.data.allocationId }, select: { status: true } })
    : null;
  // A rejected/cancelled/expired request, or a purchase allocation the case re-planned away.
  if (DEAD_REQUEST_STATUSES.includes(areaRequest.status) || allocation?.status === 'cancelled') {
    const requestIds = new Set<string>();
    const cancelled: string[] = [];
    for (const line of lines) {
      if (line.status === 'cancelled') continue;
      if (num(line.qtyOrdered) <= EPS) {
        await tx.purchaseRequestLine.update({ where: { id: line.id }, data: { status: 'cancelled' } });
        cancelled.push(line.id);
        requestIds.add(line.requestId);
      } else if (num(line.qtyReceived) + EPS >= num(line.qty)) {
        // Already bought and received: nothing to compensate (the need was covered).
        continue;
      } else {
        await ctx.openIncident({
          kind: 'cancellation_compensation',
          areaKey: PURCHASES_AREA_KEY,
          severity: 'medium',
          title: truncate(`Ya no se necesita "${line.description}" pero ya está en una orden de compra`, 200),
          dedupeKey: `purchases.need_closed:${line.id}`,
          caseId: areaRequest.caseId,
          detail: { requestLineId: line.id, areaRequestId: areaRequest.id, status: areaRequest.status },
        });
      }
    }
    await recomputeRequestStatuses(tx, requestIds, ctx);
    if (cancelled.length > 0) publishBoard(ctx, { requestLineIds: cancelled });
    return { action: cancelled.length > 0 ? 'cancelled' : 'unchanged', lineIds: cancelled };
  }
  if (!isAreaRequestOpenStatus(areaRequest.status)) return { action: 'unchanged' };

  if (lines.length === 0) {
    const fromArea = isAreaKey(areaRequest.fromAreaKey) ? areaRequest.fromAreaKey : PURCHASES_AREA_KEY;
    const created = await createPurchaseRequestInTx(
      tx,
      {
        caseId: areaRequest.caseId,
        areaKey: fromArea,
        priority: (PRIORITIES as readonly string[]).includes(areaRequest.priority)
          ? (areaRequest.priority as (typeof PRIORITIES)[number])
          : 'normal',
        neededBy: payload.data.neededBy && !Number.isNaN(Date.parse(payload.data.neededBy)) ? payload.data.neededBy : null,
        reason: truncate(
          [areaRequest.title, areaRequest.freeText, `Solicitud de ${isAreaKey(fromArea) ? AREA_LABELS[fromArea] : fromArea}`]
            .filter(Boolean)
            .join(' · '),
          1000
        ),
        status: 'open',
        notifyCompras: false,
        lines: [
          {
            demandId: payload.data.demandId ?? null,
            allocationId: payload.data.demandId ? (payload.data.allocationId ?? null) : null,
            zohoItemId: null,
            description: payload.data.productName ?? payload.data.sku ?? null,
            qty: payload.data.missingQty,
            unit: payload.data.unit,
          },
        ],
      },
      ctx,
      { fromAreaRequest: areaRequest }
    );
    return { action: 'created', requestId: created.request.id, lineIds: created.lines.map((l) => l.id) };
  }

  const live = lines.filter((line) => line.status !== 'cancelled');
  if (live.length === 1 && num(live[0].qtyOrdered) <= EPS && Math.abs(num(live[0].qty) - payload.data.missingQty) > EPS) {
    const line = live[0];
    await setLineQuantities(tx, line, { qty: D(payload.data.missingQty) });
    const request = await tx.purchaseRequest.findUnique({ where: { id: line.requestId } });
    emitPurchases(
      ctx,
      EV.updated,
      { requestId: line.requestId, requestLineId: line.id, qty: String(payload.data.missingQty), previousQty: line.qty.toString() },
      { caseId: request?.caseId ?? null, objectType: OBJ.request, objectId: line.requestId }
    );
    publishBoard(ctx, { requestId: line.requestId });
    return { action: 'updated', requestId: line.requestId, lineIds: [line.id] };
  }
  return { action: 'unchanged', requestId: live[0]?.requestId, lineIds: live.map((l) => l.id) };
}

// ---------------------------------------------------------------------------
// Daily consolidation suggestion
// ---------------------------------------------------------------------------

export async function suggestConsolidationInTx(
  tx: Db,
  ctx: CommandContext
): Promise<{ groups: ConsolidationGroup[]; workItemId: string | null }> {
  const lines = await tx.purchaseRequestLine.findMany({
    where: { status: 'open', consolidationKey: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: 2000,
  });
  const requests = await tx.purchaseRequest.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.requestId))] }, status: { in: ['open', 'consolidated', 'sourcing'] } },
    select: { id: true },
  });
  const openRequests = new Set(requests.map((r) => r.id));
  const groups = suggestConsolidations(
    lines
      .filter((line) => openRequests.has(line.requestId))
      .map((line) => ({
        id: line.id,
        requestId: line.requestId,
        zohoItemId: line.zohoItemId,
        consolidationKey: line.consolidationKey,
        description: line.description,
        qty: num(line.qty),
        qtyOrdered: num(line.qtyOrdered),
        unit: line.unit,
        status: line.status,
      }))
  );
  if (groups.length === 0) return { groups, workItemId: null };
  const dayKey = isoDay(ctx.now);
  const existing = await tx.workItem.findFirst({
    where: { objectType: CONSOLIDATION_OBJECT_TYPE, objectId: dayKey, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
    select: { id: true },
  });
  if (existing) return { groups, workItemId: existing.id };
  const description = groups
    .slice(0, 15)
    .map(
      (group) =>
        `• ${group.description} (${group.week}): ${group.lineIds.length} partidas de ${group.requestIds.length} solicitudes — ${group.totals
          .map((t) => `${t.qty} ${t.unit}`)
          .join(' + ')}`
    )
    .join('\n');
  const item = await ctx.createWorkItem({
    areaKey: PURCHASES_AREA_KEY,
    kind: 'action',
    title: `Consolidar ${groups.length} ${groups.length === 1 ? 'compra' : 'compras'} del mismo artículo y semana`,
    description: truncate(description, 1900),
    objectType: CONSOLIDATION_OBJECT_TYPE,
    objectId: dayKey,
    slaMinutes: 1440,
  });
  emitPurchases(
    ctx,
    EV.consolidationSuggested,
    { groups: groups.map((g) => ({ key: g.key, lineIds: g.lineIds, requestIds: g.requestIds })), workItemId: item.id },
    { objectType: CONSOLIDATION_OBJECT_TYPE, objectId: dayKey }
  );
  return { groups, workItemId: item.id };
}
