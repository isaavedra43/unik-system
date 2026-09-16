import { Prisma, type StockCount, type StockCountLine, type StockItem } from '@prisma/client';
import { stockCountLink } from '@/modules/areas/area-links';
import {
  requestApproval,
  resolveApprovalRequirement,
  type ApprovalDecidedEvent,
} from '@/modules/operations/approvals-service';
import { requireCommandContext, type CommandContext } from '@/modules/operations/commands';
import { OperationsError, isOperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { OPS_EVENTS, WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';
import { qty } from './inventory-dto';
import {
  lockInventoryProfile,
  lockStockCount,
  lockStockItem,
  lockStockItems,
} from './inventory-locks';
import {
  actorMay,
  ensureStockItem,
  recordInventoryMovement,
  resolveLocation,
} from './inventory-service';
import {
  COUNT_OPEN_STATUSES,
  COUNT_SCOPES,
  INVENTORY_AREA_KEY,
  INVENTORY_EVENTS,
  inventoryError,
  toConfidenceLevel,
  type ConfidenceLevel,
  type CountScope,
} from './inventory-types';
import { normalizeContainerKey } from './labels-service';
import { getOrCreateProfile, toUnitProfile } from './profiles-service';
import {
  StockMathError,
  countDifference,
  dec,
  evaluateCountClose,
  toBase,
  withinTolerance,
  type DecimalLike,
} from './stock-math';
import { validateVariant, type VariantInput } from './variant-key';

/**
 * Physical counts (plan §3.3 `stock.count`): progressive adoption of the
 * inventory by demand, without stopping the warehouse.
 *
 * - `startCount` opens a count of a warehouse (spot, cycle or full).
 * - `recordCountLine` captures one stock row: the expected quantity is the
 *   book (`knownQty`) at capture time, so movements recorded between the
 *   capture and the close do not distort the difference. Quantities are
 *   stored in base unit; the captured quantity and unit travel in the event.
 * - `closeCount` applies `evaluateCountClose` per item: UNCOUNTED → baseline +
 *   PROVISIONAL; within tolerance → counter++ and adjustment (with
 *   `inventory.adjust`, otherwise a pending line + approval work item); two good
 *   counts without disputes → CONTROLLED (`stock.controlled`); out of tolerance
 *   → DISPUTED + `count_dispute` incident + follow-up work item.
 * - `decideCountAdjustment` approves or rejects pending lines;
 *   `resolveCountDispute` settles disputed lines and, when none is left, the
 *   item returns to PROVISIONAL with one good count.
 */

type Db = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;

function requireId(value: string | null | undefined, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new OperationsError('invalid_payload', `Falta ${field}`);
  return text;
}

function toBaseOrThrow(
  quantity: DecimalLike,
  unit: string | null | undefined,
  profile: ReturnType<typeof toUnitProfile>
): Decimal {
  try {
    return toBase(quantity, unit || profile.baseUnit, profile);
  } catch (err) {
    if (err instanceof StockMathError) throw inventoryError(err.code, err.message);
    throw err;
  }
}

async function productName(tx: Db, zohoItemId: string): Promise<string> {
  const product = await tx.product.findUnique({
    where: { zohoItemId },
    select: { name: true, sku: true },
  });
  return product?.name ?? product?.sku ?? zohoItemId;
}

/** Marks the open work items of an object as done (the decision closes them). */
async function completeWorkItems(
  tx: Db,
  ctx: CommandContext,
  objectType: string,
  objectId: string,
  result: Record<string, unknown>
): Promise<string[]> {
  const items = await tx.workItem.findMany({
    where: { objectType, objectId, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
  });
  for (const item of items) {
    await tx.workItem.update({
      where: { id: item.id },
      data: {
        status: 'done',
        completedBy: ctx.actor.id,
        completedAt: ctx.now,
        result: toOperationalJson(result),
        version: { increment: 1 },
      },
    });
    ctx.emit(
      OPS_EVENTS.workitem.completed,
      {
        workItemId: item.id,
        kind: item.kind,
        title: item.title,
        completedBy: ctx.actor.id,
        objectType,
        objectId,
      },
      { caseId: item.caseId, areaKey: item.areaKey, objectType: 'work_item', objectId: item.id }
    );
  }
  return items.map((item) => item.id);
}

async function productStockItemIds(tx: Db, zohoItemId: string): Promise<string[]> {
  const rows = await tx.stockItem.findMany({ where: { zohoItemId }, select: { id: true } });
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Start / capture / cancel
// ---------------------------------------------------------------------------

export interface StartCountInput {
  warehouseId: string;
  scope?: CountScope;
}

export async function startCount(
  tx: Db,
  input: StartCountInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<StockCount> {
  const warehouseId = requireId(input.warehouseId, 'la bodega');
  const scope = input.scope ?? 'spot';
  if (!(COUNT_SCOPES as readonly string[]).includes(scope)) {
    throw new OperationsError('invalid_payload', 'Tipo de conteo inválido');
  }
  const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  if (!warehouse.active)
    throw new OperationsError('invalid_state', `La bodega ${warehouse.name} está desactivada`);
  const count = await tx.stockCount.create({
    data: { warehouseId, scope, status: 'in_progress', startedBy: ctx.actor.id },
  });
  ctx.emit(
    INVENTORY_EVENTS.countStarted,
    { countId: count.id, warehouseId, scope },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count', objectId: count.id }
  );
  return count;
}

export interface CountLineInput {
  countId: string;
  /** Existing stock row, or the row is resolved (and created) from the fields below. */
  stockItemId?: string | null;
  zohoItemId?: string | null;
  locationId?: string | null;
  locationCode?: string | null;
  variantKey?: string | null;
  variant?: VariantInput | null;
  containerKey?: string | null;
  countedQty: DecimalLike;
  /** Unit of `countedQty` (default: base unit). */
  unit?: string | null;
}

export interface CountLineResult {
  line: StockCountLine;
  stockItem: StockItem;
  expected: Decimal;
  counted: Decimal;
  diff: Decimal;
  withinTolerance: boolean;
  baseUnit: string;
  confidence: ConfidenceLevel;
  recount: boolean;
}

/** Captures (or recaptures, while pending) the count of one stock row. */
export async function recordCountLine(
  tx: Db,
  input: CountLineInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<CountLineResult> {
  const countId = requireId(input.countId, 'el conteo');
  await lockStockCount(tx, countId);
  const count = await tx.stockCount.findUnique({ where: { id: countId } });
  if (!count) throw new OperationsError('not_found', 'No se encontró el conteo');
  if (!(COUNT_OPEN_STATUSES as readonly string[]).includes(count.status)) {
    throw new OperationsError('invalid_state', 'El conteo ya está cerrado o cancelado');
  }
  if (count.status === 'draft') {
    await tx.stockCount.update({ where: { id: count.id }, data: { status: 'in_progress' } });
  }

  let row: StockItem;
  if (input.stockItemId) {
    const found = await tx.stockItem.findUnique({ where: { id: input.stockItemId } });
    if (!found) throw new OperationsError('not_found', 'No se encontró la existencia');
    if (found.warehouseId !== count.warehouseId) {
      throw new OperationsError('invalid_payload', 'La existencia es de otra bodega');
    }
    row = found;
  } else {
    const zohoItemId = requireId(input.zohoItemId, 'el artículo');
    const profile = await getOrCreateProfile(tx, zohoItemId);
    const variant = validateVariant(input.variant ?? input.variantKey ?? '', profile.variantAxes);
    if (!variant.ok) throw inventoryError('invalid_variant', variant.message);
    const location = await resolveLocation(
      tx,
      count.warehouseId,
      input.locationId,
      input.locationCode
    );
    const containerKey = input.containerKey ? normalizeContainerKey(input.containerKey) : '';
    if (input.containerKey && !containerKey) {
      throw new OperationsError('invalid_payload', 'Código de contenedor inválido');
    }
    row = await ensureStockItem(
      tx,
      {
        zohoItemId,
        warehouseId: count.warehouseId,
        locationId: location.id,
        variantKey: variant.variantKey,
        containerKey,
      },
      { variantJson: variant.variantJson }
    );
  }

  await lockStockItem(tx, row.id);
  const fresh = (await tx.stockItem.findUnique({ where: { id: row.id } })) ?? row;
  const profile = await getOrCreateProfile(tx, fresh.zohoItemId);
  const units = toUnitProfile(profile);
  const counted = toBaseOrThrow(input.countedQty, input.unit, units);
  if (counted.lt(0))
    throw inventoryError('invalid_quantity', 'La cantidad contada no puede ser negativa');
  const expected = dec(fresh.knownQty);
  const diff = countDifference(expected, counted);
  const within = withinTolerance(expected, counted, profile.tolerancePct);

  const existing = await tx.stockCountLine.findUnique({
    where: { countId_stockItemId: { countId, stockItemId: fresh.id } },
  });
  if (existing && existing.resolution !== 'pending') {
    throw new OperationsError('invalid_state', 'Esta línea del conteo ya fue resuelta');
  }
  const data = {
    expectedQty: expected,
    countedQty: counted,
    unit: units.baseUnit,
    diffQty: diff,
    withinTolerance: within,
    countedBy: ctx.actor.id,
    countedAt: ctx.now,
  };
  const line = existing
    ? await tx.stockCountLine.update({ where: { id: existing.id }, data })
    : await tx.stockCountLine.create({ data: { countId, stockItemId: fresh.id, ...data } });

  const confidence = toConfidenceLevel(profile.confidence);
  ctx.emit(
    INVENTORY_EVENTS.counted,
    {
      countId,
      lineId: line.id,
      stockItemId: fresh.id,
      zohoItemId: fresh.zohoItemId,
      warehouseId: fresh.warehouseId,
      locationId: fresh.locationId,
      variantKey: fresh.variantKey,
      containerKey: fresh.containerKey,
      expected: qty(expected),
      counted: qty(counted),
      diff: qty(diff),
      withinTolerance: within,
      unit: units.baseUnit,
      capturedQuantity: String(input.countedQty),
      capturedUnit: input.unit || units.baseUnit,
      confidence,
      recount: Boolean(existing),
    },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count_line', objectId: line.id }
  );
  return {
    line,
    stockItem: fresh,
    expected,
    counted,
    diff,
    withinTolerance: within,
    baseUnit: units.baseUnit,
    confidence,
    recount: Boolean(existing),
  };
}

export async function cancelCount(
  tx: Db,
  input: { countId: string },
  ctx: CommandContext = requireCommandContext(tx)
): Promise<StockCount> {
  const countId = requireId(input.countId, 'el conteo');
  await lockStockCount(tx, countId);
  const count = await tx.stockCount.findUnique({ where: { id: countId } });
  if (!count) throw new OperationsError('not_found', 'No se encontró el conteo');
  if (!(COUNT_OPEN_STATUSES as readonly string[]).includes(count.status)) {
    throw new OperationsError('invalid_state', 'El conteo ya está cerrado o cancelado');
  }
  const updated = await tx.stockCount.update({
    where: { id: count.id },
    data: { status: 'cancelled', closedAt: ctx.now },
  });
  ctx.emit(
    INVENTORY_EVENTS.countCancelled,
    { countId, warehouseId: count.warehouseId },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count', objectId: count.id }
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

export interface CloseCountResult {
  countId: string;
  lines: number;
  accepted: number;
  adjusted: number;
  pending: number;
  disputed: number;
  baselines: number;
  /** Items promoted to CONTROLLED. */
  controlled: string[];
  /** Items that became (or stay) DISPUTED. */
  disputedItems: string[];
  incidentIds: string[];
  workItemIds: string[];
}

/** Closes a count and applies the confidence rules per item. */
export async function closeCount(
  tx: Db,
  input: { countId: string },
  ctx: CommandContext = requireCommandContext(tx)
): Promise<CloseCountResult> {
  const countId = requireId(input.countId, 'el conteo');
  await lockStockCount(tx, countId);
  const count = await tx.stockCount.findUnique({ where: { id: countId } });
  if (!count) throw new OperationsError('not_found', 'No se encontró el conteo');
  if (!(COUNT_OPEN_STATUSES as readonly string[]).includes(count.status)) {
    throw new OperationsError('invalid_state', 'El conteo ya está cerrado o cancelado');
  }
  const lines = await tx.stockCountLine.findMany({
    where: { countId, resolution: 'pending' },
    orderBy: [{ countedAt: 'asc' }, { id: 'asc' }],
  });
  if (lines.length === 0) {
    throw inventoryError(
      'empty_count',
      'El conteo no tiene líneas; captura al menos una o cancélalo'
    );
  }

  // Lock every counted row up front, in id order.
  await lockStockItems(
    tx,
    lines.map((line) => line.stockItemId)
  );
  const rows = await tx.stockItem.findMany({
    where: { id: { in: lines.map((line) => line.stockItemId) } },
  });
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const canAdjust = actorMay(ctx, 'inventory.adjust');

  const groups = new Map<string, StockCountLine[]>();
  for (const line of lines) {
    const row = rowById.get(line.stockItemId);
    if (!row) throw new OperationsError('not_found', 'Una existencia del conteo ya no existe');
    groups.set(row.zohoItemId, [...(groups.get(row.zohoItemId) ?? []), line]);
  }

  const summary: CloseCountResult = {
    countId,
    lines: lines.length,
    accepted: 0,
    adjusted: 0,
    pending: 0,
    disputed: 0,
    baselines: 0,
    controlled: [],
    disputedItems: [],
    incidentIds: [],
    workItemIds: [],
  };

  for (const [zohoItemId, productLines] of groups) {
    const initialProfile = await getOrCreateProfile(tx, zohoItemId);
    await lockInventoryProfile(tx, initialProfile.id);
    const profile =
      (await tx.productInventoryProfile.findUnique({ where: { id: initialProfile.id } })) ??
      initialProfile;
    const units = toUnitProfile(profile);
    const previous = toConfidenceLevel(profile.confidence);
    const itemIds = await productStockItemIds(tx, zohoItemId);
    const openDisputesOutsideCount = await tx.stockCountLine.count({
      where: { resolution: 'disputed', countId: { not: countId }, stockItemId: { in: itemIds } },
    });
    const outcome = evaluateCountClose({
      confidence: previous,
      consecutiveGoodCounts: profile.consecutiveGoodCounts,
      tolerancePct: profile.tolerancePct,
      lines: productLines.map((line) => ({ expected: line.expectedQty, counted: line.countedQty })),
      openDisputesOutsideCount,
      canAdjust,
    });
    const name = await productName(tx, zohoItemId);
    const disputedLines: Array<{ line: StockCountLine; diff: Decimal }> = [];

    for (const [index, line] of productLines.entries()) {
      const decision = outcome.lines[index];
      const row = rowById.get(line.stockItemId)!;
      if (decision.movement) {
        await recordInventoryMovement(
          tx,
          {
            kind: decision.movement,
            zohoItemId,
            warehouseId: row.warehouseId,
            stockItemId: row.id,
            quantity: decision.diff,
            unit: units.baseUnit,
            referenceType: 'stock_count_line',
            referenceId: line.id,
            note: `Conteo ${count.id}`,
            countedAt: line.countedAt,
            allowNegative: true,
          },
          ctx
        );
      } else if (decision.verified) {
        await tx.stockItem.update({
          where: { id: row.id },
          data: { lastCountedAt: line.countedAt, version: { increment: 1 } },
        });
      }
      await tx.stockCountLine.update({
        where: { id: line.id },
        data: { resolution: decision.resolution, withinTolerance: decision.withinTolerance },
      });
      if (decision.movement === 'baseline' || (outcome.baseline && !decision.movement))
        summary.baselines += 1;
      if (decision.resolution === 'accepted') summary.accepted += 1;
      if (decision.resolution === 'adjusted') summary.adjusted += 1;
      if (decision.resolution === 'disputed') {
        summary.disputed += 1;
        disputedLines.push({ line, diff: decision.diff });
      }
      if (decision.resolution === 'pending') {
        summary.pending += 1;
        const workItem = await ctx.createWorkItem({
          areaKey: INVENTORY_AREA_KEY,
          kind: 'approval',
          title: `Autorizar ajuste de conteo: ${name}`,
          description: `Diferencia de ${qty(decision.diff)} ${units.baseUnit} (esperado ${qty(line.expectedQty)}, contado ${qty(line.countedQty)}). Está dentro de la tolerancia; falta autorizar el ajuste.`,
          objectType: 'stock_count_line',
          objectId: line.id,
          // La decisión se toma en el conteo (panel «Diferencias por decidir»):
          // sin esta dirección el aviso dejaba a la persona buscando el conteo.
          notification: { url: stockCountLink(countId) },
        });
        summary.workItemIds.push(workItem.id);
        ctx.emit(
          INVENTORY_EVENTS.adjustmentPending,
          {
            countId,
            lineId: line.id,
            stockItemId: row.id,
            zohoItemId,
            diff: qty(decision.diff),
            workItemId: workItem.id,
          },
          { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count_line', objectId: line.id }
        );
      }
    }

    await tx.productInventoryProfile.update({
      where: { id: profile.id },
      data: {
        confidence: outcome.nextConfidence,
        consecutiveGoodCounts: outcome.nextConsecutiveGoodCounts,
        lastCountAt: ctx.now,
        ...(outcome.promoted ? { controlledAt: ctx.now } : {}),
        version: { increment: 1 },
      },
    });
    const profileEvent = {
      areaKey: INVENTORY_AREA_KEY,
      objectType: 'inventory_profile',
      objectId: profile.id,
    };
    if (outcome.promoted) {
      summary.controlled.push(zohoItemId);
      ctx.emit(
        INVENTORY_EVENTS.controlled,
        {
          zohoItemId,
          profileId: profile.id,
          countId,
          previousConfidence: previous,
          consecutiveGoodCounts: outcome.nextConsecutiveGoodCounts,
        },
        profileEvent
      );
    }
    if (outcome.disputeCleared) {
      ctx.emit(
        INVENTORY_EVENTS.disputeResolved,
        { zohoItemId, profileId: profile.id, countId, via: 'count' },
        profileEvent
      );
    }
    if (outcome.disputed) {
      summary.disputedItems.push(zohoItemId);
      const activeReservations = await tx.stockReservation.count({
        where: { zohoItemId, status: 'active' },
      });
      const { incident, created } = await ctx.openIncident({
        kind: 'count_dispute',
        areaKey: INVENTORY_AREA_KEY,
        title: `Diferencia de conteo: ${name}`,
        dedupeKey: `count_dispute:${countId}:${zohoItemId}`,
        severity: previous === 'CONTROLLED' || activeReservations > 0 ? 'high' : 'medium',
        detail: {
          countId,
          zohoItemId,
          warehouseId: count.warehouseId,
          previousConfidence: previous,
          activeReservations,
          baseUnit: units.baseUnit,
          tolerancePct: dec(profile.tolerancePct).toString(),
          lines: disputedLines.map(({ line, diff }) => ({
            lineId: line.id,
            stockItemId: line.stockItemId,
            expected: qty(line.expectedQty),
            counted: qty(line.countedQty),
            diff: qty(diff),
          })),
        },
      });
      summary.incidentIds.push(incident.id);
      if (created) {
        const followup = await ctx.createWorkItem({
          areaKey: INVENTORY_AREA_KEY,
          kind: 'incident_followup',
          title: `Resolver diferencia de conteo: ${name}`,
          description: `${disputedLines.length} línea(s) fuera de tolerancia. Recuenta y decide si se ajusta o se conserva el saldo en libros.`,
          objectType: 'incident',
          objectId: incident.id,
          notify: false,
        });
        summary.workItemIds.push(followup.id);
      }
      ctx.emit(
        INVENTORY_EVENTS.countDisputed,
        {
          countId,
          zohoItemId,
          incidentId: incident.id,
          lines: disputedLines.length,
          previousConfidence: previous,
        },
        profileEvent
      );
    }
  }

  await tx.stockCount.update({
    where: { id: count.id },
    data: { status: 'closed', closedAt: ctx.now },
  });
  ctx.emit(
    INVENTORY_EVENTS.countClosed,
    { ...summary, warehouseId: count.warehouseId, scope: count.scope },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count', objectId: count.id }
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Pending adjustments and disputes
// ---------------------------------------------------------------------------

async function loadLineWithCount(tx: Db, lineId: string) {
  const line = await tx.stockCountLine.findUnique({
    where: { id: requireId(lineId, 'la línea del conteo') },
    include: { count: true },
  });
  if (!line) throw new OperationsError('not_found', 'No se encontró la línea del conteo');
  return line;
}

export interface DecideAdjustmentInput {
  lineId: string;
  decision: 'approve' | 'reject';
  note?: string | null;
}

/**
 * Monetary value of an adjustment, so the `inventory_adjustment` approval policy
 * can have amount ranges like every other scope. `Product.purchaseRate` is the
 * only cost UNIK keeps; without it the value is 0 and the policy of the range
 * `[0, …)` decides.
 */
async function adjustmentValue(
  tx: Db,
  zohoItemId: string,
  diff: Prisma.Decimal
): Promise<Prisma.Decimal> {
  const product = await tx.product.findUnique({
    where: { zohoItemId },
    select: { purchaseRate: true },
  });
  const rate = product?.purchaseRate ?? null;
  return rate ? diff.abs().times(rate).toDecimalPlaces(4) : new Prisma.Decimal(0);
}

export interface AdjustmentApprovalOutcome {
  /** `ready`: the decision itself is the signature. `pending`: it waits for other people. */
  gate: 'ready' | 'pending';
  approvalRequestId: string | null;
  requiredApprovals: number;
  /** Nobody else could sign the policy that this adjustment needs. */
  noApprovers: boolean;
}

/**
 * Business approval of an inventory adjustment (plan 6.0, scope
 * `inventory_adjustment`). Until this existed the scope was configurable in the
 * Control Tower and NOTHING ever asked for it.
 *
 * How the two approval paths of Inventario fit together:
 *
 * - Whoever decides here already holds `inventory.adjust`, which is the
 *   approver permission of the scope (`registerApprovalScopePermission` in
 *   `inventory-commands.ts`), and the line only reaches this point through its
 *   `approval` work item. That IS one signature, so a policy of one signature —
 *   the default of `defaultApprovalPolicies` — is satisfied by the decision
 *   itself and the adjustment is applied right away, exactly as before.
 * - A policy the administrator configures with TWO or more signatures (say, for
 *   adjustments over a given value) is a different promise: it needs other
 *   people. Then a real `ApprovalRequest` is opened, the line stays pending and
 *   the adjustment is applied by the reaction to that decision.
 *
 * `no_approvers` is not a silent bypass: the line stays pending and the event
 * says nobody could sign, so the adjustment never happens behind the policy's
 * back.
 */
async function requestAdjustmentApproval(
  tx: Db,
  ctx: CommandContext,
  line: StockCountLine & { count: StockCount },
  row: StockItem,
  note: string | null | undefined
): Promise<AdjustmentApprovalOutcome> {
  const diff = dec(line.diffQty);
  const amount = await adjustmentValue(tx, row.zohoItemId, diff);
  const { requiredApprovals } = await resolveApprovalRequirement(tx, {
    scope: 'inventory_adjustment',
    amount,
    currency: 'MXN',
  });
  if (requiredApprovals <= 1) {
    return { gate: 'ready', approvalRequestId: null, requiredApprovals, noApprovers: false };
  }
  const detail = {
    countId: line.countId,
    lineId: line.id,
    stockItemId: row.id,
    zohoItemId: row.zohoItemId,
    diff: qty(diff),
    amount: amount.toString(),
    requiredApprovals,
  };
  try {
    const outcome = await requestApproval(tx, {
      scope: 'inventory_adjustment',
      targetType: 'stock_count_line',
      targetId: line.id,
      amount,
      currency: 'MXN',
      areaKey: INVENTORY_AREA_KEY,
      requestedByUserId: ctx.actor.id,
      title: `Ajuste de inventario: ${row.zohoItemId} (${qty(diff)})`.slice(0, 200),
      description:
        [
          `Conteo ${line.countId}: en libros ${qty(line.expectedQty)}, contado ${qty(line.countedQty)}.`,
          note?.trim() || null,
        ]
          .filter(Boolean)
          .join(' ')
          .slice(0, 1000) || null,
    });
    if (outcome.status === 'approved') {
      return {
        gate: 'ready',
        approvalRequestId: outcome.approvalRequest.id,
        requiredApprovals,
        noApprovers: false,
      };
    }
    ctx.emit(
      INVENTORY_EVENTS.adjustmentApprovalRequested,
      {
        ...detail,
        approvalRequestId: outcome.approvalRequest.id,
        approvers: outcome.approverUserIds.length,
        reused: outcome.reused,
      },
      { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count_line', objectId: line.id }
    );
    return {
      gate: 'pending',
      approvalRequestId: outcome.approvalRequest.id,
      requiredApprovals,
      noApprovers: false,
    };
  } catch (err) {
    if (!isOperationsError(err) || err.code !== 'no_approvers') throw err;
    // Nobody else can sign: the adjustment waits instead of slipping through.
    ctx.emit(
      INVENTORY_EVENTS.adjustmentApprovalRequested,
      { ...detail, approvalRequestId: null, approvers: 0, reused: false },
      { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count_line', objectId: line.id }
    );
    return { gate: 'pending', approvalRequestId: null, requiredApprovals, noApprovers: true };
  }
}

/**
 * Applies the decision on a pending line: records the movement when it adjusts,
 * closes the work items and emits `stock.adjustment_decided`. Both the person's
 * command and the reaction to the business approval land here, so the effect of
 * an adjustment is written in ONE place.
 */
async function applyCountAdjustment(
  tx: Db,
  ctx: CommandContext,
  line: StockCountLine & { count: StockCount },
  row: StockItem,
  input: DecideAdjustmentInput
): Promise<{ line: StockCountLine; movementId: string | null; workItemIds: string[] }> {
  let movementId: string | null = null;
  if (input.decision === 'approve' && !dec(line.diffQty).isZero()) {
    const profile = await getOrCreateProfile(tx, row.zohoItemId);
    const result = await recordInventoryMovement(
      tx,
      {
        kind: 'adjust',
        zohoItemId: row.zohoItemId,
        warehouseId: row.warehouseId,
        stockItemId: row.id,
        quantity: line.diffQty,
        unit: toUnitProfile(profile).baseUnit,
        referenceType: 'stock_count_line',
        referenceId: line.id,
        note: input.note ?? `Ajuste autorizado del conteo ${line.countId}`,
        countedAt: line.countedAt,
        allowNegative: true,
      },
      ctx
    );
    movementId = result.movement.id;
  }
  const updated = await tx.stockCountLine.update({
    where: { id: line.id },
    data: { resolution: input.decision === 'approve' ? 'adjusted' : 'accepted' },
  });
  const workItemIds = await completeWorkItems(tx, ctx, 'stock_count_line', line.id, {
    decision: input.decision,
    movementId,
  });
  ctx.emit(
    INVENTORY_EVENTS.adjustmentDecided,
    {
      countId: line.countId,
      lineId: line.id,
      stockItemId: row.id,
      zohoItemId: row.zohoItemId,
      decision: input.decision,
      diff: qty(line.diffQty),
      movementId,
      note: input.note?.trim().slice(0, 500) || null,
    },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count_line', objectId: line.id }
  );
  return { line: updated, movementId, workItemIds };
}

export interface DecideAdjustmentResult {
  line: StockCountLine;
  movementId: string | null;
  workItemIds: string[];
  /** Business approval opened (or reused) by this decision; null when nobody else had to sign. */
  approvalRequestId: string | null;
  /** True when the adjustment waits for other signatures: the line is still pending. */
  awaitingApproval: boolean;
  /** The policy asks for more signatures than there are people who can give them. */
  noApprovers: boolean;
}

/**
 * Approves (adjusts) or rejects (keeps the book) a pending within-tolerance
 * difference.
 *
 * Approving moves the book, so it passes the business approval of the
 * `inventory_adjustment` scope (plan 6.0): with the default policy (one
 * signature) the decision of somebody holding `inventory.adjust` IS that
 * signature and the adjustment is applied straight away; with a policy that
 * asks for two or more, a real `ApprovalRequest` is opened, the line stays
 * pending and the reaction to that decision applies it. Rejecting (keeping the
 * book) changes nothing physical and needs no approval.
 */
export async function decideCountAdjustment(
  tx: Db,
  input: DecideAdjustmentInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<DecideAdjustmentResult> {
  if (!actorMay(ctx, 'inventory.adjust')) {
    throw new OperationsError('forbidden', 'No tienes permiso para ajustar inventario');
  }
  const initialLine = await loadLineWithCount(tx, input.lineId);
  // Re-read under the row lock: two concurrent approvals never adjust twice.
  await lockStockItem(tx, initialLine.stockItemId);
  const line = await loadLineWithCount(tx, initialLine.id);
  if (line.count.status !== 'closed') {
    throw new OperationsError('invalid_state', 'El conteo aún no se cierra');
  }
  if (line.resolution !== 'pending') {
    throw new OperationsError('invalid_state', 'La diferencia ya fue resuelta');
  }
  const row = await tx.stockItem.findUnique({ where: { id: line.stockItemId } });
  if (!row) throw new OperationsError('not_found', 'No se encontró la existencia');

  let approvalRequestId: string | null = null;
  let noApprovers = false;
  if (input.decision === 'approve' && !dec(line.diffQty).isZero()) {
    const approval = await requestAdjustmentApproval(tx, ctx, line, row, input.note);
    approvalRequestId = approval.approvalRequestId;
    noApprovers = approval.noApprovers;
    if (approval.gate === 'pending') {
      return {
        line,
        movementId: null,
        workItemIds: [],
        approvalRequestId,
        awaitingApproval: true,
        noApprovers,
      };
    }
  }
  const applied = await applyCountAdjustment(tx, ctx, line, row, input);
  return { ...applied, approvalRequestId, awaitingApproval: false, noApprovers };
}

/**
 * Reaction to the decision on an inventory adjustment (`stock_count_line`):
 * approving applies the adjustment, rejecting keeps the book. It runs inside the
 * same transaction as the decision, so the signature and its effect are one
 * single fact.
 */
export async function handleAdjustmentApprovalDecision(
  tx: Db,
  event: ApprovalDecidedEvent
): Promise<void> {
  if (event.status !== 'approved' && event.status !== 'rejected') return;
  const line = await tx.stockCountLine.findUnique({
    where: { id: event.approvalRequest.targetId },
    include: { count: true },
  });
  // The line may have been settled by another path (a dispute, a recount).
  if (!line || line.resolution !== 'pending') return;
  const row = await tx.stockItem.findUnique({ where: { id: line.stockItemId } });
  if (!row) return;
  await lockStockItem(tx, line.stockItemId);
  await applyCountAdjustment(tx, event.ctx, line, row, {
    lineId: line.id,
    decision: event.status === 'approved' ? 'approve' : 'reject',
    note:
      event.status === 'approved'
        ? `Ajuste aprobado (solicitud ${event.approvalRequest.id})`
        : `Ajuste rechazado: se conserva el saldo en libros (solicitud ${event.approvalRequest.id})`,
  });
}

export interface ResolveDisputeInput {
  lineId: string;
  /** `adjust`: the count (or `confirmedQty` of a recount) is right; `keep_book`: the book is right. */
  decision: 'adjust' | 'keep_book';
  confirmedQty?: DecimalLike | null;
  unit?: string | null;
  note: string;
}

export interface ResolveDisputeResult {
  line: StockCountLine;
  movementId: string | null;
  confidence: ConfidenceLevel;
  /** True when no disputed line is left and the item returned to PROVISIONAL. */
  disputeResolved: boolean;
  resolvedIncidentIds: string[];
}

/** Settles one disputed line (plan §3.3 `resolveCountDispute`). */
export async function resolveCountDispute(
  tx: Db,
  input: ResolveDisputeInput,
  ctx: CommandContext = requireCommandContext(tx)
): Promise<ResolveDisputeResult> {
  if (!actorMay(ctx, 'inventory.adjust')) {
    throw new OperationsError('forbidden', 'No tienes permiso para resolver diferencias de conteo');
  }
  const resolutionNote = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '';
  if (!resolutionNote)
    throw new OperationsError('invalid_payload', 'Explica cómo se resolvió la diferencia');
  const initialLine = await loadLineWithCount(tx, input.lineId);
  // Same lock order as closeCount (stock row, then profile); the line is re-read
  // under the row lock so two concurrent resolutions never apply twice.
  await lockStockItem(tx, initialLine.stockItemId);
  const line = await loadLineWithCount(tx, initialLine.id);
  if (line.resolution !== 'disputed') {
    throw new OperationsError('invalid_state', 'La línea no está en disputa');
  }
  const row = await tx.stockItem.findUnique({ where: { id: line.stockItemId } });
  if (!row) throw new OperationsError('not_found', 'No se encontró la existencia');
  const initialProfile = await getOrCreateProfile(tx, row.zohoItemId);
  await lockInventoryProfile(tx, initialProfile.id);
  const profile =
    (await tx.productInventoryProfile.findUnique({ where: { id: initialProfile.id } })) ??
    initialProfile;
  const units = toUnitProfile(profile);

  let movementId: string | null = null;
  let diff = dec(line.diffQty);
  const lineData: Prisma.StockCountLineUpdateInput = {
    resolution: input.decision === 'adjust' ? 'adjusted' : 'accepted',
  };
  if (input.decision === 'adjust') {
    if (input.confirmedQty !== undefined && input.confirmedQty !== null) {
      const confirmed = toBaseOrThrow(input.confirmedQty, input.unit, units);
      if (confirmed.lt(0))
        throw inventoryError('invalid_quantity', 'La cantidad confirmada no puede ser negativa');
      diff = countDifference(line.expectedQty, confirmed);
      lineData.countedQty = confirmed;
      lineData.diffQty = diff;
      lineData.withinTolerance = withinTolerance(line.expectedQty, confirmed, profile.tolerancePct);
    }
    if (!diff.isZero()) {
      const result = await recordInventoryMovement(
        tx,
        {
          kind: 'adjust',
          zohoItemId: row.zohoItemId,
          warehouseId: row.warehouseId,
          stockItemId: row.id,
          quantity: diff,
          unit: units.baseUnit,
          referenceType: 'stock_count_line',
          referenceId: line.id,
          note: resolutionNote,
          countedAt: ctx.now,
          allowNegative: true,
        },
        ctx
      );
      movementId = result.movement.id;
    } else {
      await tx.stockItem.update({
        where: { id: row.id },
        data: { lastCountedAt: ctx.now, version: { increment: 1 } },
      });
    }
  }
  const updatedLine = await tx.stockCountLine.update({ where: { id: line.id }, data: lineData });
  ctx.emit(
    INVENTORY_EVENTS.disputeLineResolved,
    {
      countId: line.countId,
      lineId: line.id,
      stockItemId: row.id,
      zohoItemId: row.zohoItemId,
      decision: input.decision,
      diff: qty(diff),
      movementId,
      note: resolutionNote,
    },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'stock_count_line', objectId: line.id }
  );

  const itemIds = await productStockItemIds(tx, row.zohoItemId);
  const resolvedIncidentIds: string[] = [];
  const remainingInCount = await tx.stockCountLine.count({
    where: { countId: line.countId, resolution: 'disputed', stockItemId: { in: itemIds } },
  });
  if (remainingInCount === 0) {
    const incident = await tx.incident.findUnique({
      where: { dedupeKey: `count_dispute:${line.countId}:${row.zohoItemId}` },
    });
    if (incident && (incident.status === 'open' || incident.status === 'acknowledged')) {
      await tx.incident.update({
        where: { id: incident.id },
        data: {
          status: 'resolved',
          resolvedAt: ctx.now,
          resolvedBy: ctx.actor.id,
          resolution: resolutionNote,
          version: { increment: 1 },
        },
      });
      ctx.emit(
        OPS_EVENTS.incident.resolved,
        { incidentId: incident.id, kind: incident.kind, resolution: resolutionNote },
        {
          caseId: incident.caseId,
          areaKey: incident.areaKey,
          objectType: 'incident',
          objectId: incident.id,
        }
      );
      await completeWorkItems(tx, ctx, 'incident', incident.id, { resolution: resolutionNote });
      resolvedIncidentIds.push(incident.id);
    }
  }

  let confidence = toConfidenceLevel(profile.confidence);
  let disputeResolved = false;
  const remaining = await tx.stockCountLine.count({
    where: { resolution: 'disputed', stockItemId: { in: itemIds } },
  });
  if (remaining === 0 && confidence === 'DISPUTED') {
    await tx.productInventoryProfile.update({
      where: { id: profile.id },
      data: {
        confidence: 'PROVISIONAL',
        consecutiveGoodCounts: 1,
        lastCountAt: ctx.now,
        version: { increment: 1 },
      },
    });
    confidence = 'PROVISIONAL';
    disputeResolved = true;
    ctx.emit(
      INVENTORY_EVENTS.disputeResolved,
      {
        zohoItemId: row.zohoItemId,
        profileId: profile.id,
        countId: line.countId,
        via: 'resolution',
      },
      { areaKey: INVENTORY_AREA_KEY, objectType: 'inventory_profile', objectId: profile.id }
    );
  }
  return { line: updatedLine, movementId, confidence, disputeResolved, resolvedIncidentIds };
}
