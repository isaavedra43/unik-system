import { Prisma, type MaterialConsumption, type ProductionOrder, type StockItem, type WorkCenter } from '@prisma/client';
import { lockStockItem, lockStockItemsForProduct } from '@/modules/inventory/inventory-locks';
import {
  loadGroupAvailability,
  recordInventoryMovement,
  transferStock,
} from '@/modules/inventory/inventory-service';
import {
  GENERAL_LOCATION_CODE,
  inventoryError,
  toConfidenceLevel,
} from '@/modules/inventory/inventory-types';
import {
  dec,
  evaluateReservation,
  itemAvailable,
  planReservationSplit,
  roundQty,
  sumDecimals,
} from '@/modules/inventory/stock-math';
import type { CommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { num, qtyText, type Db, type Decimal } from './manufacturing-helpers';
import type { MaterialRequirement } from './production-facts';

/**
 * Material commitments of production orders over the progressive inventory.
 *
 * Inputs are committed with `StockItem.assignedToProduction` (the inventory's
 * production counter: `available = known − reserved − blocked −
 * assignedToProduction − legacyClaims`), recorded as `planned`
 * `MaterialConsumption` rows per stock row. `reserveStock` is not used for
 * inputs: it ties a reservation to a case demand OF THE SAME ITEM and caps it at
 * the demand's outstanding quantity, so it cannot hold a transformation's raw
 * material (or anything of a make-to-stock order) without corrupting the demand
 * accounting. The same confidence rules apply (`evaluateReservation`: UNCOUNTED
 * and DISPUTED never commit, PROVISIONAL only by a person with a recent count),
 * under the same product-group row locks.
 *
 * Consumption draws from the assignment first (the counter goes down and a
 * `consume` movement is posted against the same row); leftovers of the
 * assignment are released when the order is released or cancelled.
 */

const EPS = new Prisma.Decimal('0.00005');

export type AssignmentReason =
  | 'ok'
  | 'insufficient'
  | 'uncounted'
  | 'disputed'
  | 'provisional_not_allowed'
  | 'provisional_stale';

export const ASSIGNMENT_REASON_LABELS: Record<AssignmentReason, string> = {
  ok: 'asignado',
  insufficient: 'sin existencia suficiente',
  uncounted: 'sin contar',
  disputed: 'con diferencia de conteo',
  provisional_not_allowed: 'existencia provisional',
  provisional_stale: 'conteo provisional vencido',
};

export interface AssignmentLineOutcome {
  zohoItemId: string;
  baseUnit: string;
  required: number;
  assignedBefore: number;
  assignedNow: number;
  missing: number;
  reason: AssignmentReason;
  message: string | null;
}

/** Warehouses the material of an order is taken from: the center's first, then the output warehouse. */
export function materialWarehouses(
  order: Pick<ProductionOrder, 'outputWarehouseId'>,
  workCenter: Pick<WorkCenter, 'warehouseId'> | null
): string[] {
  return [...new Set([workCenter?.warehouseId, order.outputWarehouseId].filter((id): id is string => Boolean(id)))];
}

export function heldQuantity(row: Pick<MaterialConsumption, 'qtyPlanned' | 'qtyActual'>): Decimal {
  return roundQty(Prisma.Decimal.max(dec(row.qtyPlanned).minus(row.qtyActual), 0));
}

const REJECTION_REASON: Record<string, AssignmentReason> = {
  stock_uncounted: 'uncounted',
  stock_disputed: 'disputed',
  provisional_not_allowed: 'provisional_not_allowed',
  provisional_verification_stale: 'provisional_stale',
  insufficient_stock: 'insufficient',
};

/** Changes the production counter of a stock row (never below zero). */
export async function adjustAssigned(tx: Db, stockItemId: string, delta: Decimal): Promise<StockItem> {
  if (delta.gte(0)) {
    return tx.stockItem.update({
      where: { id: stockItemId },
      data: { assignedToProduction: { increment: delta }, version: { increment: 1 } },
    });
  }
  await lockStockItem(tx, stockItemId);
  const row = await tx.stockItem.findUnique({ where: { id: stockItemId } });
  if (!row) throw new OperationsError('not_found', 'No se encontró la existencia asignada');
  const next = roundQty(Prisma.Decimal.max(dec(row.assignedToProduction).plus(delta), 0));
  return tx.stockItem.update({
    where: { id: stockItemId },
    data: { assignedToProduction: next, version: { increment: 1 } },
  });
}

/**
 * Commits the missing material of every requirement from the order's
 * warehouses (partial commitments are kept: what is on hand is not taken by
 * another order while the rest arrives).
 */
export async function assignMaterials(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  requirements: readonly MaterialRequirement[],
  options: { allowProvisional: boolean; warehouseIds: readonly string[] }
): Promise<AssignmentLineOutcome[]> {
  const config = await getOperationsConfig();
  const outcomes: AssignmentLineOutcome[] = [];
  for (const requirement of requirements) {
    const zohoItemId = requirement.zohoItemId;
    const planned = await tx.materialConsumption.findMany({
      where: { productionOrderId: order.id, kind: 'planned', inputZohoItemId: zohoItemId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const assignedBefore = roundQty(sumDecimals(planned.map((row) => row.qtyPlanned)));
    let need = roundQty(dec(requirement.requiredBase).minus(assignedBefore));
    let assignedNow = new Prisma.Decimal(0);
    let reason: AssignmentReason = 'insufficient';
    let message: string | null = null;
    if (need.gt(EPS)) {
      for (const warehouseId of options.warehouseIds) {
        if (need.lte(EPS)) break;
        const scope = { zohoItemId, warehouseId, variantKey: requirement.variantKey };
        await lockStockItemsForProduct(tx, scope);
        const group = await loadGroupAvailability(tx, scope);
        const take = roundQty(Prisma.Decimal.min(need, Prisma.Decimal.max(group.available, 0)));
        if (take.lte(EPS)) continue;
        const profile = await tx.productInventoryProfile.findUnique({ where: { zohoItemId } });
        const decision = evaluateReservation({
          confidence: toConfidenceLevel(profile?.confidence),
          available: group.available,
          quantity: take,
          allowProvisional: options.allowProvisional,
          lastVerifiedAt: group.lastVerifiedAt,
          now: ctx.now,
          provisionalMaxHours: config.provisionalVerificationMaxHours,
        });
        if (!decision.ok) {
          reason = REJECTION_REASON[decision.code] ?? 'insufficient';
          message = decision.message;
          // The confidence of an item is the same in every warehouse; only a stale count may differ.
          if (reason !== 'provisional_stale' && reason !== 'insufficient') break;
          continue;
        }
        const parts = planReservationSplit(
          group.usable.map((row) => ({ id: row.id, available: itemAvailable(row) })),
          take
        );
        if (!parts || parts.length === 0) continue;
        for (const part of parts) {
          await adjustAssigned(tx, part.id, part.quantity);
          const existing = planned.find((row) => row.stockItemId === part.id);
          if (existing) {
            const updated = await tx.materialConsumption.update({
              where: { id: existing.id },
              data: { qtyPlanned: { increment: part.quantity } },
            });
            planned[planned.indexOf(existing)] = updated;
          } else {
            planned.push(
              await tx.materialConsumption.create({
                data: {
                  productionOrderId: order.id,
                  inputZohoItemId: zohoItemId,
                  stockItemId: part.id,
                  qtyPlanned: part.quantity,
                  qtyActual: new Prisma.Decimal(0),
                  unit: requirement.baseUnit,
                  kind: 'planned',
                  recordedByUserId: ctx.actor.id,
                },
              })
            );
          }
        }
        assignedNow = roundQty(assignedNow.plus(take));
        need = roundQty(need.minus(take));
      }
    }
    const missing = roundQty(Prisma.Decimal.max(need, 0));
    const covered = missing.lte(EPS);
    outcomes.push({
      zohoItemId,
      baseUnit: requirement.baseUnit,
      required: requirement.requiredBase,
      assignedBefore: num(assignedBefore),
      assignedNow: num(assignedNow),
      missing: covered ? 0 : num(missing),
      reason: covered ? 'ok' : reason,
      message: covered
        ? null
        : (message ?? `Faltan ${qtyText(missing)} ${requirement.baseUnit} disponibles`),
    });
  }
  return outcomes;
}

export interface PostedConsumption {
  consumptionId: string;
  stockItemId: string;
  movementId: string;
  warehouseId: string;
  quantity: string;
}

/** Consumes an input against the order's assignment; returns what the assignment could not cover. */
export async function drawAssigned(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: {
    zohoItemId: string;
    quantity: Decimal;
    baseUnit: string;
    stockItemId?: string | null;
    preferWarehouseId?: string | null;
    operationId?: string | null;
    note?: string | null;
  }
): Promise<{ posted: PostedConsumption[]; remaining: Decimal }> {
  const rows = await tx.materialConsumption.findMany({
    where: {
      productionOrderId: order.id,
      kind: 'planned',
      inputZohoItemId: input.zohoItemId,
      stockItemId: { not: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const held = rows.filter((row) => heldQuantity(row).gt(EPS));
  const stocks = held.length
    ? await tx.stockItem.findMany({ where: { id: { in: held.map((row) => row.stockItemId as string) } } })
    : [];
  const stockById = new Map(stocks.map((stock) => [stock.id, stock]));
  const rank = (row: MaterialConsumption) => {
    if (input.stockItemId && row.stockItemId === input.stockItemId) return 0;
    if (input.preferWarehouseId && stockById.get(row.stockItemId as string)?.warehouseId === input.preferWarehouseId) return 1;
    return 2;
  };
  held.sort((a, b) => rank(a) - rank(b));

  const posted: PostedConsumption[] = [];
  let left = roundQty(input.quantity);
  for (const row of held) {
    if (left.lte(EPS)) break;
    const stock = stockById.get(row.stockItemId as string);
    if (!stock) continue;
    const take = roundQty(Prisma.Decimal.min(left, heldQuantity(row)));
    if (take.lte(EPS)) continue;
    // Group lock first (the same one the consume movement takes), then the counter: two orders
    // drawing rows of the same product never hold one row each while waiting for the group.
    await lockStockItemsForProduct(tx, { zohoItemId: stock.zohoItemId, warehouseId: stock.warehouseId, variantKey: stock.variantKey });
    await adjustAssigned(tx, stock.id, take.negated());
    const result = await recordInventoryMovement(
      tx,
      {
        kind: 'consume',
        zohoItemId: input.zohoItemId,
        warehouseId: stock.warehouseId,
        stockItemId: stock.id,
        quantity: take,
        unit: input.baseUnit,
        referenceType: 'production_order',
        referenceId: order.id,
        note: input.note ?? null,
        caseId: order.caseId,
      },
      ctx
    );
    await tx.materialConsumption.update({
      where: { id: row.id },
      data: { qtyActual: { increment: take } },
    });
    const actual = await tx.materialConsumption.create({
      data: {
        productionOrderId: order.id,
        operationId: input.operationId ?? null,
        inputZohoItemId: input.zohoItemId,
        stockItemId: stock.id,
        qtyPlanned: take,
        qtyActual: take,
        unit: input.baseUnit,
        kind: 'actual',
        stockMovementId: result.movement.id,
        recordedByUserId: ctx.actor.id,
      },
    });
    posted.push({
      consumptionId: actual.id,
      stockItemId: stock.id,
      movementId: result.movement.id,
      warehouseId: stock.warehouseId,
      quantity: qtyText(take),
    });
    left = roundQty(left.minus(take));
  }
  return { posted, remaining: Prisma.Decimal.max(left, 0) };
}

/**
 * Consumes material without an assignment (over-consumption, substitutes).
 * The whole plan is computed under lock before any movement is posted, so a
 * rejection never leaves part of it written. CONTROLLED stock never goes below
 * what is available; other confidence levels may leave a negative book (the
 * inventory opens its incident).
 */
export async function consumeUnassigned(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  input: {
    zohoItemId: string;
    quantity: Decimal;
    baseUnit: string;
    warehouseIds: readonly string[];
    kind: 'actual' | 'substitution';
    stockItemId?: string | null;
    substitutedForZohoItemId?: string | null;
    operationId?: string | null;
    approvalRequestId?: string | null;
    /** Existing pending substitution row posted by this call (approved substitution). */
    consumptionId?: string | null;
    note?: string | null;
    label?: string;
  }
): Promise<PostedConsumption[]> {
  const quantity = roundQty(input.quantity);
  const parts: Array<{ stock: StockItem; quantity: Decimal }> = [];
  const label = input.label ?? input.zohoItemId;
  if (input.stockItemId) {
    const found = await tx.stockItem.findUnique({ where: { id: input.stockItemId } });
    if (!found || found.zohoItemId !== input.zohoItemId) {
      throw new OperationsError('invalid_payload', 'La existencia indicada no es de ese material');
    }
    if (input.warehouseIds.length > 0 && !input.warehouseIds.includes(found.warehouseId)) {
      throw new OperationsError('invalid_payload', 'La existencia indicada no está en las bodegas de la orden');
    }
    await lockStockItemsForProduct(tx, { zohoItemId: found.zohoItemId, warehouseId: found.warehouseId, variantKey: found.variantKey });
    const stock = (await tx.stockItem.findUnique({ where: { id: found.id } })) ?? found;
    const free = itemAvailable(stock);
    if (quantity.gt(Prisma.Decimal.max(free, 0).plus(EPS)) && isCommitted(stock)) {
      throw inventoryError(
        'insufficient_stock',
        `La existencia indicada de ${label} está comprometida con otras ventas u órdenes (disponible ${qtyText(Prisma.Decimal.max(free, 0))} ${input.baseUnit})`,
        { zohoItemId: input.zohoItemId, available: qtyText(Prisma.Decimal.max(free, 0)) }
      );
    }
    parts.push({ stock, quantity });
  } else {
    let left = quantity;
    for (const warehouseId of input.warehouseIds) {
      if (left.lte(EPS)) break;
      const scope = { zohoItemId: input.zohoItemId, warehouseId };
      await lockStockItemsForProduct(tx, scope);
      const group = await loadGroupAvailability(tx, scope);
      const take = roundQty(Prisma.Decimal.min(left, Prisma.Decimal.max(group.available, 0)));
      if (take.lte(EPS)) continue;
      const split = planReservationSplit(
        group.usable.map((row) => ({ id: row.id, available: itemAvailable(row) })),
        take
      );
      if (!split) continue;
      for (const piece of split) {
        const stock = group.usable.find((row) => row.id === piece.id);
        if (stock) parts.push({ stock, quantity: piece.quantity });
      }
      left = roundQty(left.minus(take));
    }
    if (left.gt(EPS)) {
      const profile = await tx.productInventoryProfile.findUnique({ where: { zohoItemId: input.zohoItemId } });
      if (toConfidenceLevel(profile?.confidence) === 'CONTROLLED') {
        throw inventoryError(
          'insufficient_stock',
          `Existencia disponible insuficiente de ${label}: faltan ${qtyText(left)} ${input.baseUnit}`,
          { zohoItemId: input.zohoItemId, missing: qtyText(left) }
        );
      }
      const candidates = await tx.stockItem.findMany({
        where: { zohoItemId: input.zohoItemId, warehouseId: { in: [...input.warehouseIds] } },
        orderBy: [{ knownQty: 'desc' }, { id: 'asc' }],
      });
      const scrapLocations = await tx.storageLocation.findMany({
        where: { warehouseId: { in: [...input.warehouseIds] }, code: 'SCRAP' },
        select: { id: true },
      });
      const scrap = new Set(scrapLocations.map((location) => location.id));
      // A book that may go negative (uncounted stock), but never on material reserved for other sales or
      // assigned to other orders: that shortage is a count/incident, not something production takes.
      const fallback = candidates.find((row) => !scrap.has(row.locationId) && !isCommitted(row));
      if (!fallback) {
        const committed = candidates.some((row) => !scrap.has(row.locationId));
        throw inventoryError(
          'insufficient_stock',
          committed
            ? `La existencia de ${label} está comprometida con otras ventas u órdenes: pide un conteo o una aprobación antes de consumirla`
            : `No hay existencia registrada de ${label} en la bodega de producción`,
          { zohoItemId: input.zohoItemId }
        );
      }
      const same = parts.find((part) => part.stock.id === fallback.id);
      if (same) same.quantity = roundQty(same.quantity.plus(left));
      else parts.push({ stock: fallback, quantity: left });
    }
  }

  const posted: PostedConsumption[] = [];
  for (const [index, part] of parts.entries()) {
    const result = await recordInventoryMovement(
      tx,
      {
        kind: 'consume',
        zohoItemId: input.zohoItemId,
        warehouseId: part.stock.warehouseId,
        stockItemId: part.stock.id,
        quantity: part.quantity,
        unit: input.baseUnit,
        referenceType: 'production_order',
        referenceId: order.id,
        note: input.note ?? null,
        caseId: order.caseId,
      },
      ctx
    );
    let consumptionId: string;
    if (input.consumptionId && index === 0) {
      await tx.materialConsumption.update({
        where: { id: input.consumptionId },
        data: {
          stockItemId: part.stock.id,
          stockMovementId: result.movement.id,
          qtyActual: part.quantity,
          approvalRequestId: input.approvalRequestId ?? undefined,
        },
      });
      consumptionId = input.consumptionId;
    } else {
      const row = await tx.materialConsumption.create({
        data: {
          productionOrderId: order.id,
          operationId: input.operationId ?? null,
          inputZohoItemId: input.zohoItemId,
          stockItemId: part.stock.id,
          qtyPlanned: new Prisma.Decimal(0),
          qtyActual: part.quantity,
          unit: input.baseUnit,
          kind: input.kind,
          substitutedForZohoItemId: input.substitutedForZohoItemId ?? null,
          stockMovementId: result.movement.id,
          approvalRequestId: input.approvalRequestId ?? null,
          recordedByUserId: ctx.actor.id,
        },
      });
      consumptionId = row.id;
    }
    posted.push({
      consumptionId,
      stockItemId: part.stock.id,
      movementId: result.movement.id,
      warehouseId: part.stock.warehouseId,
      quantity: qtyText(part.quantity),
    });
  }
  return posted;
}

/** A stock row holds material promised elsewhere (reserved for a sale or assigned to an order). */
function isCommitted(row: Pick<StockItem, 'reserved' | 'assignedToProduction'>): boolean {
  return dec(row.reserved).gt(EPS) || dec(row.assignedToProduction).gt(EPS);
}

export interface AssignmentTransfer {
  zohoItemId: string;
  quantity: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  fromStockItemId: string;
  toStockItemId: string;
}

/**
 * Moves the held assignment of an order to the work center's warehouse
 * (`transfer_out` + `transfer_in`) and keeps it assigned on the destination
 * row. A container that is only partly assigned stays where it is.
 */
export async function moveAssignmentsToWarehouse(
  tx: Db,
  ctx: CommandContext,
  order: ProductionOrder,
  toWarehouseId: string
): Promise<AssignmentTransfer[]> {
  const rows = await tx.materialConsumption.findMany({
    where: { productionOrderId: order.id, kind: 'planned', stockItemId: { not: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const transfers: AssignmentTransfer[] = [];
  for (const row of rows) {
    const held = heldQuantity(row);
    if (held.lte(EPS)) continue;
    const stock = await tx.stockItem.findUnique({ where: { id: row.stockItemId as string } });
    if (!stock || stock.warehouseId === toWarehouseId) continue;
    if (stock.containerKey && !dec(stock.knownQty).equals(held)) continue;
    await lockStockItemsForProduct(tx, { zohoItemId: stock.zohoItemId, warehouseId: stock.warehouseId, variantKey: stock.variantKey });
    await adjustAssigned(tx, stock.id, held.negated());
    const result = await transferStock(
      tx,
      {
        zohoItemId: stock.zohoItemId,
        fromWarehouseId: stock.warehouseId,
        fromStockItemId: stock.id,
        toWarehouseId,
        toLocationCode: GENERAL_LOCATION_CODE,
        quantity: held,
        unit: row.unit,
        referenceType: 'production_order',
        referenceId: order.id,
        caseId: order.caseId,
        note: `Surtido a producción ${order.number}`,
      },
      ctx
    );
    const destination = result.in.stockItem;
    await adjustAssigned(tx, destination.id, held);
    if (dec(row.qtyActual).lte(EPS)) {
      await tx.materialConsumption.update({ where: { id: row.id }, data: { stockItemId: destination.id } });
    } else {
      await tx.materialConsumption.update({ where: { id: row.id }, data: { qtyPlanned: row.qtyActual } });
      await tx.materialConsumption.create({
        data: {
          productionOrderId: order.id,
          inputZohoItemId: row.inputZohoItemId,
          stockItemId: destination.id,
          qtyPlanned: held,
          qtyActual: new Prisma.Decimal(0),
          unit: row.unit,
          kind: 'planned',
          recordedByUserId: ctx.actor.id,
        },
      });
    }
    transfers.push({
      zohoItemId: stock.zohoItemId,
      quantity: qtyText(held),
      fromWarehouseId: stock.warehouseId,
      toWarehouseId,
      fromStockItemId: stock.id,
      toStockItemId: destination.id,
    });
  }
  return transfers;
}

/** Gives back every assignment still held by the order (release or cancel). */
export async function releaseAssignments(
  tx: Db,
  order: Pick<ProductionOrder, 'id'>
): Promise<Array<{ zohoItemId: string; stockItemId: string; quantity: string }>> {
  const rows = await tx.materialConsumption.findMany({
    where: { productionOrderId: order.id, kind: 'planned' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const released: Array<{ zohoItemId: string; stockItemId: string; quantity: string }> = [];
  for (const row of rows) {
    const held = heldQuantity(row);
    if (held.lte(EPS)) continue;
    if (row.stockItemId) {
      await adjustAssigned(tx, row.stockItemId, held.negated());
      released.push({ zohoItemId: row.inputZohoItemId, stockItemId: row.stockItemId, quantity: qtyText(held) });
    }
    await tx.materialConsumption.update({ where: { id: row.id }, data: { qtyPlanned: row.qtyActual } });
  }
  return released;
}
