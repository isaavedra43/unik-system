import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { isKnownPermission } from '@/modules/auth/permissions';
import {
  onApprovalDecided,
  registerApprovalScopePermission,
} from '@/modules/operations/approvals-service';
import {
  executeCommand,
  registerCommand,
  versionedAggregate,
  type CommandResult,
} from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import {
  assertCanActOnWorkItem,
  completeWorkItemInTx,
  waitWorkItemInTx,
} from '@/modules/operations/work-items-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import {
  qty,
  toCountDTO,
  toCountLineDTO,
  toLegacyClaimDTO,
  toLocationDTO,
  toMovementDTO,
  toProfileDTO,
  toReservationDTO,
  toWarehouseDTO,
  type CountDTO,
  type CountLineDTO,
  type LegacyClaimDTO,
  type LocationDTO,
  type MovementDTO,
  type ProfileDTO,
  type ReservationDTO,
  type WarehouseDTO,
} from './inventory-dto';
import {
  blockStock,
  consumeReservation,
  createContainerStockItem,
  recordInventoryMovement,
  releaseReservation,
  reserveStock,
  transferStock,
  unblockStock,
  verifyAvailability,
} from './inventory-service';
import { COUNT_SCOPES, LEGACY_CLAIM_SOURCES, type ConfidenceLevel } from './inventory-types';
import { buildStockLabel, type LabelDTO } from './labels-service';
import {
  claimLegacyCommitment,
  confirmLegacyClaim,
  expireLegacyClaim,
  listDueLegacyClaimIds,
  releaseLegacyClaim,
} from './legacy-claims-service';
import { getOrCreateProfile, updateProfile, updateProfileInputSchema } from './profiles-service';
import {
  cancelCount,
  closeCount,
  decideCountAdjustment,
  handleAdjustmentApprovalDecision,
  recordCountLine,
  resolveCountDispute,
  startCount,
  type CloseCountResult,
} from './stock-count-service';
import {
  createLocation,
  createLocationInputSchema,
  createWarehouse,
  createWarehouseInputSchema,
  ensureDefaultWarehouse,
  resolveWarehouseForZohoLocation,
  updateLocation,
  updateLocationInputSchema,
  updateWarehouse,
  updateWarehouseInputSchema,
} from './warehouses-service';

/**
 * Operational commands of the inventory module (registered on import; the
 * barrel `operations/register-commands.ts` imports this file).
 *
 * | command                          | permission         | aggregate            |
 * |----------------------------------|--------------------|----------------------|
 * | stock.count.start                | inventory.count    | warehouse (none)     |
 * | stock.count.line                 | inventory.count    | stock_count (none)   |
 * | stock.count.close / cancel       | inventory.count    | stock_count (version)|
 * | stock.count.decide_adjustment    | inventory.adjust   | stock_count_line     |
 * | stock.count.resolve_dispute      | inventory.adjust   | stock_count_line     |
 * | stock.reserve / release          | inventory.reserve  | case_demand / res.   |
 * | stock.consume                    | inventory.manage   | stock_reservation    |
 * | stock.move (receipt, issue, return, produce, consume, transfer) | inventory.manage | stock_item |
 * | stock.adjust / block / unblock   | inventory.adjust   | stock_item           |
 * | stock.container.create           | inventory.manage   | stock_item           |
 * | stock.claim_legacy / confirm_legacy / release_legacy | inventory.reserve | legacy_claim |
 * | stock.expire_legacy              | system only        | legacy_claim         |
 * | profile.ensure / profile.update  | inventory.manage   | inventory_profile    |
 * | location.create / update         | inventory.manage   | storage_location     |
 * | warehouse.create / update / sync_zoho_locations | inventory.manage | warehouse |
 *
 * Every handler checks the `inventory` flag (kill switch). Service wrappers
 * with the uniform signature `fn(actor, input, options?)` are exported at the
 * end for server actions, routes and AI tools; commands can also be executed
 * by type through `executeCommand` (offline batch endpoint).
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'inventory-commands', event, ...extra }));

export const INVENTORY_COMMANDS = {
  countStart: 'stock.count.start',
  verifyCaseAvailability: 'stock.verify_case_availability',
  countLine: 'stock.count.line',
  countClose: 'stock.count.close',
  countCancel: 'stock.count.cancel',
  countDecideAdjustment: 'stock.count.decide_adjustment',
  countResolveDispute: 'stock.count.resolve_dispute',
  reserve: 'stock.reserve',
  release: 'stock.release',
  consume: 'stock.consume',
  move: 'stock.move',
  adjust: 'stock.adjust',
  block: 'stock.block',
  unblock: 'stock.unblock',
  containerCreate: 'stock.container.create',
  claimLegacy: 'stock.claim_legacy',
  confirmLegacy: 'stock.confirm_legacy',
  releaseLegacy: 'stock.release_legacy',
  expireLegacy: 'stock.expire_legacy',
  profileEnsure: 'profile.ensure',
  profileUpdate: 'profile.update',
  locationCreate: 'location.create',
  locationUpdate: 'location.update',
  warehouseCreate: 'warehouse.create',
  warehouseUpdate: 'warehouse.update',
  warehouseSyncZoho: 'warehouse.sync_zoho_locations',
  issueCaseMaterial: 'stock.issue_case_material',
} as const;

export type InventoryCommandType = (typeof INVENTORY_COMMANDS)[keyof typeof INVENTORY_COMMANDS];

async function assertInventoryEnabled(): Promise<void> {
  if (!(await isOpsFlagEnabled('inventory'))) {
    throw new OperationsError('module_disabled', 'El inventario progresivo está desactivado', {
      httpStatus: 409,
    });
  }
}

function assertAggregate(aggregateId: string, expected: string, label: string): void {
  if (aggregateId !== expected) {
    throw new OperationsError(
      'invalid_payload',
      `El ${label} no corresponde al registro del comando`
    );
  }
}

/** Metadata kept on the count work item. It makes a demand count auditable
 * without turning a conversation or a client-side URL into the source of truth. */
interface AvailabilitySpotCountLink {
  availabilityWorkItemId: string;
  caseId: string;
  demandId: string;
  zohoItemId: string;
  variantKey: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function availabilitySpotCountLink(value: unknown): AvailabilitySpotCountLink | null {
  const source = record(value);
  const link = record(source.availabilitySpotCount);
  const fields = [
    'availabilityWorkItemId',
    'caseId',
    'demandId',
    'zohoItemId',
    'variantKey',
  ] as const;
  if (!fields.every((field) => typeof link[field] === 'string' && link[field].trim())) return null;
  return {
    availabilityWorkItemId: link.availabilityWorkItemId as string,
    caseId: link.caseId as string,
    demandId: link.demandId as string,
    zohoItemId: link.zohoItemId as string,
    variantKey: link.variantKey as string,
  };
}

async function openAvailabilitySpotCount(tx: Parameters<typeof startCount>[0], countId: string) {
  const links = await tx.workItem.findMany({
    where: {
      objectType: 'stock_count',
      objectId: countId,
      areaKey: 'inventario',
      status: { in: ['open', 'in_progress', 'waiting', 'escalated'] },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  for (const link of links) {
    const parsed = availabilitySpotCountLink(link.result);
    if (parsed) return { tracking: link, link: parsed };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const DECIMAL_PATTERN = /^-?\d{1,14}(\.\d{1,6})?$/;

const idSchema = z.string().trim().min(1).max(120);
const quantitySchema = z
  .union([z.number().finite(), z.string().trim().regex(DECIMAL_PATTERN, 'Cantidad inválida')])
  .transform((value) => String(value));
const positiveQuantitySchema = quantitySchema.refine((value) => Number(value) > 0, {
  message: 'La cantidad debe ser mayor que cero',
});
const signedQuantitySchema = quantitySchema.refine((value) => Number(value) !== 0, {
  message: 'La cantidad no puede ser cero',
});
const unitSchema = z.string().trim().min(1).max(30).nullish();
const noteSchema = z.string().trim().max(500).nullish();
const reasonSchema = z.string().trim().min(1, 'Indica el motivo').max(500);
const locationCodeSchema = z.string().trim().min(1).max(40).nullish();
const variantKeySchema = z.string().max(400).nullish();
const variantSchema = z
  .record(z.string().max(30), z.union([z.string().max(80), z.number(), z.null()]))
  .nullish();
const containerKeySchema = z.string().trim().min(1).max(40).nullish();
const referenceTypeSchema = z.string().trim().min(1).max(60).nullish();
const referenceIdSchema = z.string().trim().min(1).max(120).nullish();

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

const startCountSchema = z
  .object({ warehouseId: idSchema, scope: z.enum(COUNT_SCOPES).default('spot') })
  .strict();

/**
 * Starts the only valid human path for a non-controlled demand: a spot count
 * tied to the verification work item. The count itself, its captured line and
 * the final `availability_result` remain separate auditable records.
 */
const verifyCaseAvailabilitySchema = z.object({ workItemId: idSchema }).strict();

export interface VerifyCaseAvailabilityData {
  workItemId: string;
  countId: string | null;
  state: 'count_opened' | 'already_counting' | 'verified';
  confidence: ConfidenceLevel;
  available: string;
  quantity: string;
  unit: string;
}

registerCommand<z.output<typeof verifyCaseAvailabilitySchema>, VerifyCaseAvailabilityData>(
  INVENTORY_COMMANDS.verifyCaseAvailability,
  {
    schema: verifyCaseAvailabilitySchema,
    permission: 'inventory.count',
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const item = await tx.workItem.findUnique({ where: { id: cmd.payload.workItemId } });
      if (!item || item.areaKey !== 'inventario' || !item.stepId || !item.caseId) {
        throw new OperationsError('not_found', 'No se encontró la verificación de Inventario');
      }
      assertCanActOnWorkItem(ctx, item);
      const step = await tx.caseStep.findUnique({ where: { id: item.stepId } });
      if (
        !step ||
        step.caseId !== item.caseId ||
        step.stepKey !== 'verificar_disponibilidad' ||
        !step.demandId
      ) {
        throw new OperationsError(
          'invalid_state',
          'Este trabajo no corresponde a verificar disponibilidad'
        );
      }
      const demand = await tx.caseDemand.findUnique({ where: { id: step.demandId } });
      if (!demand?.zohoItemId) {
        throw new OperationsError('invalid_state', 'La necesidad no tiene un artículo que contar');
      }
      const warehouse = await resolveWarehouseForZohoLocation(tx, demand.locationId ?? null);
      const availability = await verifyAvailability(tx, {
        zohoItemId: demand.zohoItemId,
        warehouseId: warehouse.id,
        variantKey: demand.variantKey,
        quantityBase: demand.baseQuantity,
      });

      // Controlled inventory has a fresh, deterministic answer; no physical
      // count is opened and the work item closes with the checked values.
      if (!availability.requiresCount) {
        await completeWorkItemInTx(tx, item, {
          result: {
            availability_result: {
              source: 'controlled_stock',
              confidence: availability.confidence,
              available: qty(availability.available),
              quantity: qty(demand.baseQuantity),
              unit: demand.baseUnit,
              verifiedAt: ctx.now.toISOString(),
            },
          },
        });
        return {
          data: {
            workItemId: item.id,
            countId: null,
            state: 'verified',
            confidence: availability.confidence,
            available: qty(availability.available),
            quantity: qty(demand.baseQuantity),
            unit: demand.baseUnit,
          },
        };
      }

      const existing = await tx.workItem.findMany({
        where: {
          caseId: item.caseId,
          objectType: 'stock_count',
          areaKey: 'inventario',
          status: { in: ['open', 'in_progress', 'waiting', 'escalated'] },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      for (const candidate of existing) {
        const link = availabilitySpotCountLink(candidate.result);
        if (link?.availabilityWorkItemId !== item.id) continue;
        const count = await tx.stockCount.findUnique({ where: { id: candidate.objectId ?? '' } });
        if (count && (count.status === 'draft' || count.status === 'in_progress')) {
          return {
            data: {
              workItemId: item.id,
              countId: count.id,
              state: 'already_counting',
              confidence: availability.confidence,
              available: qty(availability.available),
              quantity: qty(demand.baseQuantity),
              unit: demand.baseUnit,
            },
          };
        }
      }

      const count = await startCount(tx, { warehouseId: warehouse.id, scope: 'spot' }, ctx);
      const tracking = await ctx.createWorkItem({
        areaKey: 'inventario',
        kind: 'action',
        title: `Conteo spot: ${demand.sku || demand.name}`,
        description: `Cuenta únicamente ${demand.sku || demand.name} para confirmar ${qty(demand.baseQuantity)} ${demand.baseUnit} del expediente. Al cerrar un conteo sin diferencias pendientes, la disponibilidad se registrará sola.`,
        caseId: item.caseId,
        objectType: 'stock_count',
        objectId: count.id,
        ownerUserId: item.ownerUserId,
        backupUserId: item.backupUserId,
      });
      await tx.workItem.update({
        where: { id: tracking.id },
        data: {
          result: {
            availabilitySpotCount: {
              availabilityWorkItemId: item.id,
              caseId: item.caseId,
              demandId: demand.id,
              zohoItemId: demand.zohoItemId,
              variantKey: demand.variantKey,
            },
          },
        },
      });
      if (item.status !== 'waiting') {
        await waitWorkItemInTx(tx, item, {
          reason: `Esperando conteo spot ${count.id} para confirmar disponibilidad`,
        });
      }
      return {
        data: {
          workItemId: item.id,
          countId: count.id,
          state: 'count_opened',
          confidence: availability.confidence,
          available: qty(availability.available),
          quantity: qty(demand.baseQuantity),
          unit: demand.baseUnit,
        },
      };
    },
  }
);

registerCommand<z.output<typeof startCountSchema>, { count: CountDTO }>(
  INVENTORY_COMMANDS.countStart,
  {
    schema: startCountSchema,
    permission: 'inventory.count',
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const count = await startCount(tx, cmd.payload, ctx);
      return { data: { count: toCountDTO(count) }, aggregateVersion: count.version };
    },
  }
);

const countLineSchema = z
  .object({
    countId: idSchema,
    stockItemId: idSchema.nullish(),
    zohoItemId: idSchema.nullish(),
    locationId: idSchema.nullish(),
    locationCode: locationCodeSchema,
    variantKey: variantKeySchema,
    variant: variantSchema,
    containerKey: containerKeySchema,
    countedQty: quantitySchema,
    unit: unitSchema,
  })
  .strict()
  .refine((value) => Boolean(value.stockItemId || value.zohoItemId), {
    message: 'Indica la existencia o el artículo contado',
    path: ['zohoItemId'],
  });

export interface CountLineData {
  line: CountLineDTO;
  stockItemId: string;
  expected: string;
  counted: string;
  diff: string;
  withinTolerance: boolean;
  baseUnit: string;
  confidence: ConfidenceLevel;
  recount: boolean;
}

registerCommand<z.output<typeof countLineSchema>, CountLineData>(INVENTORY_COMMANDS.countLine, {
  schema: countLineSchema,
  permission: 'inventory.count',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    assertAggregate(cmd.aggregate.id, cmd.payload.countId, 'conteo');
    const result = await recordCountLine(tx, cmd.payload, ctx);
    return {
      data: {
        line: toCountLineDTO(result.line),
        stockItemId: result.stockItem.id,
        expected: qty(result.expected),
        counted: qty(result.counted),
        diff: qty(result.diff),
        withinTolerance: result.withinTolerance,
        baseUnit: result.baseUnit,
        confidence: result.confidence,
        recount: result.recount,
      },
    };
  },
});

const countIdSchema = z.object({ countId: idSchema }).strict();

/**
 * A linked spot count may close the original case step only after the physical
 * line was accepted/adjusted. Pending approvals and disputed quantities stay
 * visibly open; a user can never replace that decision with a free-text note.
 */
async function resolveAvailabilityAfterSpotCount(
  tx: Parameters<typeof startCount>[0],
  countId: string,
  summary?: Pick<CloseCountResult, 'pending' | 'disputed'>
): Promise<{ availabilityWorkItemId: string | null; autoClosed: boolean }> {
  const linked = await openAvailabilitySpotCount(tx, countId);
  if (!linked) return { availabilityWorkItemId: null, autoClosed: false };

  const { tracking, link } = linked;
  // `closeCount` gives us its authoritative summary. Subsequent adjustment
  // approvals and dispute decisions reach this function later, so re-read the
  // unresolved lines instead of relying on the summary from the original close.
  const unresolved =
    summary ??
    (
      await tx.stockCountLine.groupBy({
        by: ['resolution'],
        where: { countId, resolution: { in: ['pending', 'disputed'] } },
        _count: { _all: true },
      })
    ).reduce(
      (result, row) => ({
        pending: result.pending + (row.resolution === 'pending' ? row._count._all : 0),
        disputed: result.disputed + (row.resolution === 'disputed' ? row._count._all : 0),
      }),
      { pending: 0, disputed: 0 }
    );
  if (unresolved.pending > 0 || unresolved.disputed > 0) {
    if (tracking.status !== 'waiting') {
      await waitWorkItemInTx(tx, tracking, {
        reason:
          unresolved.disputed > 0
            ? 'El conteo tiene una diferencia en disputa; resuélvela antes de confirmar disponibilidad'
            : 'El conteo espera autorización de ajuste antes de confirmar disponibilidad',
      });
    }
    return { availabilityWorkItemId: link.availabilityWorkItemId, autoClosed: false };
  }

  const [caseItem, demand, countLines] = await Promise.all([
    tx.workItem.findUnique({ where: { id: link.availabilityWorkItemId } }),
    tx.caseDemand.findUnique({ where: { id: link.demandId } }),
    tx.stockCountLine.findMany({
      where: { countId },
      select: { stockItemId: true },
    }),
  ]);
  if (
    !caseItem ||
    !demand ||
    demand.caseId !== link.caseId ||
    demand.zohoItemId !== link.zohoItemId
  ) {
    throw new OperationsError(
      'invalid_state',
      'El conteo ya no corresponde a una necesidad activa'
    );
  }
  const stockItems = countLines.length
    ? await tx.stockItem.findMany({
        where: { id: { in: countLines.map((line) => line.stockItemId) } },
        select: { zohoItemId: true, variantKey: true },
      })
    : [];
  const targetCaptured = stockItems.some(
    (item) => item.zohoItemId === link.zohoItemId && item.variantKey === link.variantKey
  );
  if (!targetCaptured) {
    throw new OperationsError(
      'invalid_state',
      'El conteo debe incluir el artículo y la variante solicitados antes de cerrarse'
    );
  }

  const count = await tx.stockCount.findUnique({ where: { id: countId } });
  if (!count) throw new OperationsError('not_found', 'No se encontró el conteo');
  const availability = await verifyAvailability(tx, {
    zohoItemId: link.zohoItemId,
    warehouseId: count.warehouseId,
    variantKey: link.variantKey,
    quantityBase: demand.baseQuantity,
  });
  if (caseItem.status !== 'done' && caseItem.status !== 'cancelled') {
    await completeWorkItemInTx(tx, caseItem, {
      result: {
        availability_result: {
          source: 'spot_count',
          countId,
          confidence: availability.confidence,
          available: qty(availability.available),
          quantity: qty(demand.baseQuantity),
          unit: demand.baseUnit,
          countedAt: count.closedAt?.toISOString() ?? null,
        },
      },
    });
  }
  if (tracking.status !== 'done' && tracking.status !== 'cancelled') {
    await completeWorkItemInTx(tx, tracking, {
      result: {
        availability_spot_count: {
          countId,
          availabilityWorkItemId: caseItem.id,
          confidence: availability.confidence,
        },
      },
      skipEvidenceCheck: true,
    });
  }
  return { availabilityWorkItemId: caseItem.id, autoClosed: true };
}

registerCommand<
  z.output<typeof countIdSchema>,
  CloseCountResult & { availabilityWorkItemId: string | null; availabilityAutoClosed: boolean }
>(INVENTORY_COMMANDS.countClose, {
  schema: countIdSchema,
  permission: 'inventory.count',
  aggregate: versionedAggregate('stock_count', 'stockCount'),
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    assertAggregate(cmd.aggregate.id, cmd.payload.countId, 'conteo');
    const summary = await closeCount(tx, cmd.payload, ctx);
    const completion = await resolveAvailabilityAfterSpotCount(tx, cmd.payload.countId, summary);
    return {
      data: {
        ...summary,
        availabilityWorkItemId: completion.availabilityWorkItemId,
        availabilityAutoClosed: completion.autoClosed,
      },
    };
  },
});

registerCommand<z.output<typeof countIdSchema>, { count: CountDTO }>(
  INVENTORY_COMMANDS.countCancel,
  {
    schema: countIdSchema,
    permission: 'inventory.count',
    aggregate: versionedAggregate('stock_count', 'stockCount'),
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      assertAggregate(cmd.aggregate.id, cmd.payload.countId, 'conteo');
      const count = await cancelCount(tx, cmd.payload, ctx);
      return { data: { count: toCountDTO(count) } };
    },
  }
);

const decideAdjustmentSchema = z
  .object({ lineId: idSchema, decision: z.enum(['approve', 'reject']), note: noteSchema })
  .strict();

/**
 * `awaitingApproval` es verdadero cuando la política de `inventory_adjustment`
 * pide dos o más firmas: se abrió la aprobación de negocio, la línea sigue
 * pendiente y el ajuste lo aplica la reacción a esa firma, no este comando.
 * `noApprovers` avisa que la política pide más firmas de las que hay personas
 * que puedan darlas.
 */
export interface DecideAdjustmentData {
  line: CountLineDTO;
  movementId: string | null;
  workItemIds: string[];
  approvalRequestId: string | null;
  awaitingApproval: boolean;
  noApprovers: boolean;
}

registerCommand<z.output<typeof decideAdjustmentSchema>, DecideAdjustmentData>(
  INVENTORY_COMMANDS.countDecideAdjustment,
  {
    schema: decideAdjustmentSchema,
    permission: 'inventory.adjust',
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const result = await decideCountAdjustment(tx, cmd.payload, ctx);
      if (!result.awaitingApproval) {
        await resolveAvailabilityAfterSpotCount(tx, result.line.countId);
      }
      return {
        data: {
          line: toCountLineDTO(result.line),
          movementId: result.movementId,
          workItemIds: result.workItemIds,
          approvalRequestId: result.approvalRequestId,
          awaitingApproval: result.awaitingApproval,
          noApprovers: result.noApprovers,
        },
      };
    },
  }
);

const resolveDisputeSchema = z
  .object({
    lineId: idSchema,
    decision: z.enum(['adjust', 'keep_book']),
    confirmedQty: quantitySchema.nullish(),
    unit: unitSchema,
    note: reasonSchema,
  })
  .strict();

registerCommand<
  z.output<typeof resolveDisputeSchema>,
  {
    line: CountLineDTO;
    movementId: string | null;
    confidence: ConfidenceLevel;
    disputeResolved: boolean;
    resolvedIncidentIds: string[];
  }
>(INVENTORY_COMMANDS.countResolveDispute, {
  schema: resolveDisputeSchema,
  permission: 'inventory.adjust',
  aggregate: 'none',
  audit: 'always',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    const result = await resolveCountDispute(tx, cmd.payload, ctx);
    await resolveAvailabilityAfterSpotCount(tx, result.line.countId);
    return { data: { ...result, line: toCountLineDTO(result.line) } };
  },
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

const reserveSchema = z
  .object({
    caseId: idSchema,
    demandId: idSchema,
    allocationId: idSchema.nullish(),
    zohoItemId: idSchema,
    warehouseId: idSchema,
    variantKey: variantKeySchema,
    quantity: positiveQuantitySchema,
    unit: unitSchema,
    stockItemId: idSchema.nullish(),
    allowProvisional: z.boolean().default(false),
    note: noteSchema,
  })
  .strict();

export interface ReserveData {
  reservations: ReservationDTO[];
  primaryReservationId: string;
  provisional: boolean;
  confidence: ConfidenceLevel;
  quantity: string;
  baseUnit: string;
  availableBefore: string;
  availableAfter: string;
}

registerCommand<z.output<typeof reserveSchema>, ReserveData>(INVENTORY_COMMANDS.reserve, {
  schema: reserveSchema,
  permission: 'inventory.reserve',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    const result = await reserveStock(tx, cmd.payload, ctx);
    return {
      data: {
        reservations: result.reservations.map(toReservationDTO),
        primaryReservationId: result.primaryReservationId,
        provisional: result.provisional,
        confidence: result.confidence,
        quantity: qty(result.quantityBase),
        baseUnit: result.baseUnit,
        availableBefore: qty(result.availableBefore),
        availableAfter: qty(result.availableAfter),
      },
    };
  },
});

const releaseSchema = z.object({ reservationId: idSchema, reason: noteSchema }).strict();

registerCommand<z.output<typeof releaseSchema>, { reservation: ReservationDTO }>(
  INVENTORY_COMMANDS.release,
  {
    schema: releaseSchema,
    permission: 'inventory.reserve',
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const reservation = await releaseReservation(tx, cmd.payload, ctx);
      return { data: { reservation: toReservationDTO(reservation) } };
    },
  }
);

const consumeSchema = z
  .object({
    reservationId: idSchema,
    quantity: positiveQuantitySchema.nullish(),
    unit: unitSchema,
    kind: z.enum(['issue', 'consume']).default('issue'),
    referenceType: referenceTypeSchema,
    referenceId: referenceIdSchema,
    note: noteSchema,
  })
  .strict();

registerCommand<
  z.output<typeof consumeSchema>,
  { movement: MovementDTO; reservation: ReservationDTO }
>(INVENTORY_COMMANDS.consume, {
  schema: consumeSchema,
  permission: 'inventory.manage',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    const result = await consumeReservation(tx, cmd.payload, ctx);
    return {
      data: {
        movement: toMovementDTO(result.movement),
        reservation: toReservationDTO(result.reservation),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

const movementBase = {
  zohoItemId: idSchema,
  warehouseId: idSchema,
  stockItemId: idSchema.nullish(),
  locationId: idSchema.nullish(),
  locationCode: locationCodeSchema,
  variantKey: variantKeySchema,
  variant: variantSchema,
  containerKey: containerKeySchema,
  quantity: positiveQuantitySchema,
  unit: unitSchema,
  referenceType: referenceTypeSchema,
  referenceId: referenceIdSchema,
  note: noteSchema,
  caseId: idSchema.nullish(),
};

const dimensionsSchema = z
  .record(z.string().max(30), z.union([z.string().max(80), z.number().finite()]))
  .nullish();

const moveSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('receipt'), ...movementBase, newContainer: z.boolean().optional() })
    .strict(),
  z
    .object({ kind: z.literal('return'), ...movementBase, newContainer: z.boolean().optional() })
    .strict(),
  z
    .object({
      kind: z.literal('produce'),
      ...movementBase,
      newContainer: z.boolean().optional(),
      originProductionOrderId: idSchema.nullish(),
      dimensions: dimensionsSchema,
    })
    .strict(),
  z.object({ kind: z.literal('issue'), ...movementBase }).strict(),
  z.object({ kind: z.literal('consume'), ...movementBase }).strict(),
  z
    .object({
      kind: z.literal('transfer'),
      zohoItemId: idSchema,
      fromWarehouseId: idSchema,
      fromStockItemId: idSchema.nullish(),
      fromLocationId: idSchema.nullish(),
      fromLocationCode: locationCodeSchema,
      variantKey: variantKeySchema,
      variant: variantSchema,
      containerKey: containerKeySchema,
      toWarehouseId: idSchema,
      toLocationId: idSchema.nullish(),
      toLocationCode: locationCodeSchema,
      quantity: positiveQuantitySchema,
      unit: unitSchema,
      referenceType: referenceTypeSchema,
      referenceId: referenceIdSchema,
      note: noteSchema,
      caseId: idSchema.nullish(),
    })
    .strict(),
]);

export interface MoveData {
  kind: 'receipt' | 'return' | 'produce' | 'issue' | 'consume' | 'transfer';
  movements: MovementDTO[];
  stockItemIds: string[];
  /** Container created by an inbound movement. */
  containerKey: string | null;
}

/**
 * Surtido guiado de un expediente. Consume las reservas que ya unen la
 * existencia con sus asignaciones y guarda los movimientos como evidencia.
 */
const issueCaseMaterialSchema = z.object({ workItemId: idSchema }).strict();

registerCommand<
  z.output<typeof issueCaseMaterialSchema>,
  { workItemId: string; caseId: string; movementIds: string[] }
>(INVENTORY_COMMANDS.issueCaseMaterial, {
  schema: issueCaseMaterialSchema,
  permission: 'inventory.manage',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    const item = await tx.workItem.findUnique({ where: { id: cmd.payload.workItemId } });
    if (!item || item.areaKey !== 'inventario' || !item.stepId) {
      throw new OperationsError('not_found', 'No se encontró el surtido de Inventario');
    }
    const step = await tx.caseStep.findUnique({ where: { id: item.stepId } });
    if (!step || step.caseId !== item.caseId || step.stepKey !== 'preparar_pedido') {
      throw new OperationsError(
        'invalid_state',
        'Este trabajo no corresponde a preparar un pedido'
      );
    }
    const reservations = await tx.stockReservation.findMany({
      where: { caseId: step.caseId, status: 'active', allocationId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (reservations.length === 0) {
      throw new OperationsError(
        'invalid_state',
        'No hay reservas activas que surtir; verifica las asignaciones del expediente'
      );
    }
    const movementIds: string[] = [];
    for (const reservation of reservations) {
      const result = await recordInventoryMovement(
        tx,
        {
          kind: 'issue',
          zohoItemId: reservation.zohoItemId,
          warehouseId: reservation.warehouseId,
          stockItemId: reservation.stockItemId,
          reservationId: reservation.id,
          quantity: reservation.quantity,
          referenceType: 'stock_reservation',
          referenceId: reservation.id,
          note: `Surtido del expediente ${step.caseId}`,
          caseId: step.caseId,
        },
        ctx
      );
      movementIds.push(result.movement.id);
    }
    await completeWorkItemInTx(tx, item, {
      result: { issue_movements: { movementIds } },
      skipEvidenceCheck: true,
    });
    return { data: { workItemId: item.id, caseId: step.caseId, movementIds } };
  },
});

registerCommand<z.output<typeof moveSchema>, MoveData>(INVENTORY_COMMANDS.move, {
  schema: moveSchema,
  permission: 'inventory.manage',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    const payload = cmd.payload;
    if (payload.kind === 'transfer') {
      const { kind, ...input } = payload;
      const result = await transferStock(tx, input, ctx);
      return {
        data: {
          kind,
          movements: [toMovementDTO(result.out.movement), toMovementDTO(result.in.movement)],
          stockItemIds: [result.out.stockItem.id, result.in.stockItem.id],
          containerKey: null,
        },
      };
    }
    const { kind, ...input } = payload;
    const result = await recordInventoryMovement(tx, { ...input, kind }, ctx);
    return {
      data: {
        kind,
        movements: [toMovementDTO(result.movement)],
        stockItemIds: [result.stockItem.id],
        containerKey: result.createdContainerKey || null,
      },
    };
  },
});

const adjustSchema = z
  .object({
    zohoItemId: idSchema,
    warehouseId: idSchema,
    stockItemId: idSchema.nullish(),
    locationId: idSchema.nullish(),
    locationCode: locationCodeSchema,
    variantKey: variantKeySchema,
    variant: variantSchema,
    containerKey: containerKeySchema,
    quantity: signedQuantitySchema,
    unit: unitSchema,
    reason: reasonSchema,
  })
  .strict();

registerCommand<z.output<typeof adjustSchema>, { movement: MovementDTO; known: string }>(
  INVENTORY_COMMANDS.adjust,
  {
    schema: adjustSchema,
    permission: 'inventory.adjust',
    aggregate: 'none',
    audit: 'always',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const { reason, ...input } = cmd.payload;
      const result = await recordInventoryMovement(
        tx,
        { ...input, kind: 'adjust', note: reason, referenceType: 'manual_adjustment' },
        ctx
      );
      return {
        data: { movement: toMovementDTO(result.movement), known: qty(result.stockItem.knownQty) },
      };
    },
  }
);

const blockSchema = z
  .object({
    stockItemId: idSchema,
    quantity: positiveQuantitySchema,
    unit: unitSchema,
    reason: reasonSchema,
  })
  .strict();

registerCommand<z.output<typeof blockSchema>, { movement: MovementDTO; blocked: string }>(
  INVENTORY_COMMANDS.block,
  {
    schema: blockSchema,
    permission: 'inventory.adjust',
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const result = await blockStock(tx, cmd.payload, ctx);
      return {
        data: { movement: toMovementDTO(result.movement), blocked: qty(result.stockItem.blocked) },
      };
    },
  }
);

registerCommand<z.output<typeof blockSchema>, { movement: MovementDTO; blocked: string }>(
  INVENTORY_COMMANDS.unblock,
  {
    schema: blockSchema,
    permission: 'inventory.adjust',
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const result = await unblockStock(tx, cmd.payload, ctx);
      return {
        data: { movement: toMovementDTO(result.movement), blocked: qty(result.stockItem.blocked) },
      };
    },
  }
);

const containerSchema = z
  .object({
    zohoItemId: idSchema,
    warehouseId: idSchema,
    locationId: idSchema.nullish(),
    locationCode: locationCodeSchema,
    variantKey: variantKeySchema,
    variant: variantSchema,
  })
  .strict();

registerCommand<
  z.output<typeof containerSchema>,
  { stockItemId: string; containerKey: string; label: LabelDTO }
>(INVENTORY_COMMANDS.containerCreate, {
  schema: containerSchema,
  permission: 'inventory.manage',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    const { stockItem, containerKey } = await createContainerStockItem(tx, cmd.payload, ctx);
    const [product, location, warehouse, profile] = await Promise.all([
      tx.product.findUnique({
        where: { zohoItemId: stockItem.zohoItemId },
        select: { name: true, sku: true },
      }),
      tx.storageLocation.findUnique({
        where: { id: stockItem.locationId },
        select: { code: true },
      }),
      tx.warehouse.findUnique({ where: { id: stockItem.warehouseId }, select: { name: true } }),
      tx.productInventoryProfile.findUnique({
        where: { zohoItemId: stockItem.zohoItemId },
        select: { baseUnit: true },
      }),
    ]);
    return {
      data: {
        stockItemId: stockItem.id,
        containerKey,
        label: buildStockLabel(stockItem, {
          productName: product?.name,
          sku: product?.sku,
          locationCode: location?.code,
          warehouseName: warehouse?.name,
          baseUnit: profile?.baseUnit,
        }),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Legacy claims
// ---------------------------------------------------------------------------

const claimSchema = z
  .object({
    zohoItemId: idSchema,
    warehouseId: idSchema,
    variantKey: variantKeySchema,
    variant: variantSchema,
    quantity: positiveQuantitySchema,
    unit: unitSchema,
    source: z.enum(LEGACY_CLAIM_SOURCES),
    reference: z.string().trim().max(200).nullish(),
    expiresAt: z.string().datetime({ offset: true }).nullish(),
    note: noteSchema,
  })
  .strict();

export interface ClaimData {
  claim: LegacyClaimDTO;
  confidence: ConfidenceLevel;
  availableBefore: string;
  availableAfter: string;
  exceedsAvailable: boolean;
  incidentId: string | null;
}

registerCommand<z.output<typeof claimSchema>, ClaimData>(INVENTORY_COMMANDS.claimLegacy, {
  schema: claimSchema,
  permission: 'inventory.reserve',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    const { expiresAt, ...input } = cmd.payload;
    const result = await claimLegacyCommitment(
      tx,
      { ...input, expiresAt: expiresAt ? new Date(expiresAt) : null },
      ctx
    );
    return {
      data: {
        claim: toLegacyClaimDTO(result.claim),
        confidence: result.confidence,
        availableBefore: qty(result.availableBefore),
        availableAfter: qty(result.availableAfter),
        exceedsAvailable: result.exceedsAvailable,
        incidentId: result.incidentId,
      },
      aggregateVersion: result.claim.version,
    };
  },
});

const confirmClaimSchema = z
  .object({
    claimId: idSchema,
    caseId: idSchema,
    demandId: idSchema,
    allocationId: idSchema.nullish(),
    stockItemId: idSchema.nullish(),
    allowProvisional: z.boolean().default(false),
  })
  .strict();

registerCommand<
  z.output<typeof confirmClaimSchema>,
  { claim: LegacyClaimDTO; reservations: ReservationDTO[]; provisional: boolean }
>(INVENTORY_COMMANDS.confirmLegacy, {
  schema: confirmClaimSchema,
  permission: 'inventory.reserve',
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    await assertInventoryEnabled();
    const result = await confirmLegacyClaim(tx, cmd.payload, ctx);
    return {
      data: {
        claim: toLegacyClaimDTO(result.claim),
        reservations: result.reservation.reservations.map(toReservationDTO),
        provisional: result.reservation.provisional,
      },
    };
  },
});

const releaseClaimSchema = z.object({ claimId: idSchema, reason: noteSchema }).strict();

registerCommand<z.output<typeof releaseClaimSchema>, { claim: LegacyClaimDTO }>(
  INVENTORY_COMMANDS.releaseLegacy,
  {
    schema: releaseClaimSchema,
    permission: 'inventory.reserve',
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const claim = await releaseLegacyClaim(tx, cmd.payload, ctx);
      return { data: { claim: toLegacyClaimDTO(claim) } };
    },
  }
);

const expireClaimSchema = z.object({ claimId: idSchema }).strict();

registerCommand<z.output<typeof expireClaimSchema>, { claim: LegacyClaimDTO }>(
  INVENTORY_COMMANDS.expireLegacy,
  {
    schema: expireClaimSchema,
    aggregate: 'none',
    actorTypes: ['system'],
    audit: 'never',
    async handler(tx, cmd, ctx) {
      await assertInventoryEnabled();
      const claim = await expireLegacyClaim(tx, cmd.payload, ctx);
      return { data: { claim: toLegacyClaimDTO(claim) } };
    },
  }
);

// ---------------------------------------------------------------------------
// Profiles, locations, warehouses
// ---------------------------------------------------------------------------

const ensureProfileSchema = z.object({ zohoItemId: idSchema }).strict();

registerCommand<z.output<typeof ensureProfileSchema>, { profile: ProfileDTO }>(
  INVENTORY_COMMANDS.profileEnsure,
  {
    schema: ensureProfileSchema,
    permission: 'inventory.manage',
    aggregate: 'none',
    async handler(tx, cmd) {
      await assertInventoryEnabled();
      const profile = await getOrCreateProfile(tx, cmd.payload.zohoItemId);
      return { data: { profile: toProfileDTO(profile) }, aggregateVersion: profile.version };
    },
  }
);

registerCommand<z.output<typeof updateProfileInputSchema>, { profile: ProfileDTO }>(
  INVENTORY_COMMANDS.profileUpdate,
  {
    schema: updateProfileInputSchema,
    permission: 'inventory.manage',
    aggregate: versionedAggregate('inventory_profile', 'productInventoryProfile'),
    async handler(tx, cmd) {
      await assertInventoryEnabled();
      assertAggregate(cmd.aggregate.id, cmd.payload.profileId, 'perfil');
      const profile = await updateProfile(tx, cmd.payload);
      return { data: { profile: toProfileDTO(profile) } };
    },
  }
);

registerCommand<z.output<typeof createLocationInputSchema>, { location: LocationDTO }>(
  INVENTORY_COMMANDS.locationCreate,
  {
    schema: createLocationInputSchema,
    permission: 'inventory.manage',
    aggregate: 'none',
    async handler(tx, cmd) {
      await assertInventoryEnabled();
      const location = await createLocation(tx, cmd.payload);
      return { data: { location: toLocationDTO(location) } };
    },
  }
);

registerCommand<z.output<typeof updateLocationInputSchema>, { location: LocationDTO }>(
  INVENTORY_COMMANDS.locationUpdate,
  {
    schema: updateLocationInputSchema,
    permission: 'inventory.manage',
    aggregate: 'none',
    async handler(tx, cmd) {
      await assertInventoryEnabled();
      const location = await updateLocation(tx, cmd.payload);
      return { data: { location: toLocationDTO(location) } };
    },
  }
);

registerCommand<
  z.output<typeof createWarehouseInputSchema>,
  { warehouse: WarehouseDTO; general: LocationDTO }
>(INVENTORY_COMMANDS.warehouseCreate, {
  schema: createWarehouseInputSchema,
  permission: 'inventory.manage',
  aggregate: 'none',
  async handler(tx, cmd) {
    await assertInventoryEnabled();
    const { warehouse, general } = await createWarehouse(tx, cmd.payload);
    return { data: { warehouse: toWarehouseDTO(warehouse), general: toLocationDTO(general) } };
  },
});

registerCommand<z.output<typeof updateWarehouseInputSchema>, { warehouse: WarehouseDTO }>(
  INVENTORY_COMMANDS.warehouseUpdate,
  {
    schema: updateWarehouseInputSchema,
    permission: 'inventory.manage',
    aggregate: 'none',
    async handler(tx, cmd) {
      await assertInventoryEnabled();
      const warehouse = await updateWarehouse(tx, cmd.payload);
      return { data: { warehouse: toWarehouseDTO(warehouse) } };
    },
  }
);

const syncWarehousesSchema = z.object({}).strict();

registerCommand<
  z.output<typeof syncWarehousesSchema>,
  { defaultWarehouseId: string; warehouses: WarehouseDTO[]; created: number }
>(INVENTORY_COMMANDS.warehouseSyncZoho, {
  schema: syncWarehousesSchema,
  permission: 'inventory.manage',
  aggregate: 'none',
  async handler(tx) {
    await assertInventoryEnabled();
    const result = await ensureDefaultWarehouse(tx);
    return {
      data: {
        defaultWarehouseId: result.defaultWarehouse.id,
        warehouses: result.warehouses.map(toWarehouseDTO),
        created: result.created.length,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Aprobaciones de negocio del inventario
// ---------------------------------------------------------------------------

/** La misma llave que exige el comando de ajuste (`inventory.adjust`). */
const ADJUST_PERMISSION = 'inventory.adjust';

type GlobalWithInventoryApprovals = typeof globalThis & {
  __unikInventoryApprovalReactions?: Array<() => void>;
};

/**
 * Alcance `inventory_adjustment` del plan 6.0, de punta a punta:
 *
 * - `registerApprovalScopePermission`: quien puede ajustar inventario es quien
 *   puede FIRMAR el ajuste. Sin esta línea el único aprobador elegible era el
 *   respaldo `operations.admin`, así que una política de ajuste de inventario
 *   configurada en la Torre de Control no tenía quién la firmara dentro del área.
 * - `onApprovalDecided('stock_count_line', …)`: la firma aplica el ajuste (o
 *   conserva el saldo en libros) dentro de la MISMA transacción de la decisión.
 *
 * Se registra al importar el módulo, igual que Compras y Manufactura, y se
 * desuscribe lo anterior para que recargarlo en pruebas no duplique reacciones.
 */
function registerInventoryApprovalReactions(): void {
  const scope = globalThis as GlobalWithInventoryApprovals;
  for (const unsubscribe of scope.__unikInventoryApprovalReactions ?? []) unsubscribe();
  scope.__unikInventoryApprovalReactions = [
    onApprovalDecided('stock_count_line', async (tx, event) => {
      const line = await tx.stockCountLine.findUnique({
        where: { id: event.approvalRequest.targetId },
        select: { countId: true },
      });
      await handleAdjustmentApprovalDecision(tx, event);
      if (line) await resolveAvailabilityAfterSpotCount(tx, line.countId);
    }),
  ];
  if (isKnownPermission(ADJUST_PERMISSION)) {
    registerApprovalScopePermission('inventory_adjustment', ADJUST_PERMISSION);
  }
}

registerInventoryApprovalReactions();

// ---------------------------------------------------------------------------
// Service wrappers: fn(actor, input, options?) → CommandResult
// ---------------------------------------------------------------------------

export interface InventoryCommandOptions {
  /** Client UUID (offline queue); a new one by default. */
  commandId?: string;
  expectedVersion?: number;
  deviceId?: string;
  /** ISO instant on the device. */
  occurredAt?: string;
  /** Server clock (tests). */
  now?: Date;
}

function runAsUser<D>(
  actor: CurrentUser,
  type: InventoryCommandType,
  aggregate: { type: string; id: unknown },
  payload: unknown,
  options: InventoryCommandOptions = {}
): Promise<CommandResult<D>> {
  return executeCommand<D>(
    {
      commandId: options.commandId ?? randomUUID(),
      type,
      actor: { type: 'user', id: actor.id },
      aggregate: { type: aggregate.type, id: String(aggregate.id ?? '') },
      expectedVersion: options.expectedVersion,
      payload,
      deviceId: options.deviceId,
      occurredAt: options.occurredAt,
    },
    actor,
    { now: options.now }
  );
}

type Input<S extends z.ZodTypeAny> = z.input<S>;

export function startStockCount(
  actor: CurrentUser,
  input: Input<typeof startCountSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ count: CountDTO }>(
    actor,
    INVENTORY_COMMANDS.countStart,
    { type: 'warehouse', id: input.warehouseId },
    input,
    options
  );
}

export function recordStockCountLine(
  actor: CurrentUser,
  input: Input<typeof countLineSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<CountLineData>(
    actor,
    INVENTORY_COMMANDS.countLine,
    { type: 'stock_count', id: input.countId },
    input,
    options
  );
}

export function closeStockCount(
  actor: CurrentUser,
  input: Input<typeof countIdSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<CloseCountResult>(
    actor,
    INVENTORY_COMMANDS.countClose,
    { type: 'stock_count', id: input.countId },
    input,
    options
  );
}

export function cancelStockCount(
  actor: CurrentUser,
  input: Input<typeof countIdSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ count: CountDTO }>(
    actor,
    INVENTORY_COMMANDS.countCancel,
    { type: 'stock_count', id: input.countId },
    input,
    options
  );
}

export function decideStockCountAdjustment(
  actor: CurrentUser,
  input: Input<typeof decideAdjustmentSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<DecideAdjustmentData>(
    actor,
    INVENTORY_COMMANDS.countDecideAdjustment,
    { type: 'stock_count_line', id: input.lineId },
    input,
    options
  );
}

export function resolveStockCountDispute(
  actor: CurrentUser,
  input: Input<typeof resolveDisputeSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{
    line: CountLineDTO;
    movementId: string | null;
    confidence: ConfidenceLevel;
    disputeResolved: boolean;
    resolvedIncidentIds: string[];
  }>(
    actor,
    INVENTORY_COMMANDS.countResolveDispute,
    { type: 'stock_count_line', id: input.lineId },
    input,
    options
  );
}

export function reserveStockForDemand(
  actor: CurrentUser,
  input: Input<typeof reserveSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<ReserveData>(
    actor,
    INVENTORY_COMMANDS.reserve,
    { type: 'case_demand', id: input.demandId },
    input,
    options
  );
}

export function releaseStockReservation(
  actor: CurrentUser,
  input: Input<typeof releaseSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ reservation: ReservationDTO }>(
    actor,
    INVENTORY_COMMANDS.release,
    { type: 'stock_reservation', id: input.reservationId },
    input,
    options
  );
}

export function consumeStockReservation(
  actor: CurrentUser,
  input: Input<typeof consumeSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ movement: MovementDTO; reservation: ReservationDTO }>(
    actor,
    INVENTORY_COMMANDS.consume,
    { type: 'stock_reservation', id: input.reservationId },
    input,
    options
  );
}

export function issueCaseMaterial(
  actor: CurrentUser,
  input: Input<typeof issueCaseMaterialSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ workItemId: string; caseId: string; movementIds: string[] }>(
    actor,
    INVENTORY_COMMANDS.issueCaseMaterial,
    { type: 'work_item', id: input.workItemId },
    input,
    options
  );
}

export function moveStock(
  actor: CurrentUser,
  input: Input<typeof moveSchema>,
  options?: InventoryCommandOptions
) {
  const aggregateId =
    input.kind === 'transfer'
      ? (input.fromStockItemId ?? `${input.zohoItemId}:${input.fromWarehouseId}`)
      : (input.stockItemId ?? `${input.zohoItemId}:${input.warehouseId}`);
  return runAsUser<MoveData>(
    actor,
    INVENTORY_COMMANDS.move,
    { type: 'stock_item', id: aggregateId },
    input,
    options
  );
}

export function adjustStock(
  actor: CurrentUser,
  input: Input<typeof adjustSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ movement: MovementDTO; known: string }>(
    actor,
    INVENTORY_COMMANDS.adjust,
    { type: 'stock_item', id: input.stockItemId ?? `${input.zohoItemId}:${input.warehouseId}` },
    input,
    options
  );
}

export function blockStockQuantity(
  actor: CurrentUser,
  input: Input<typeof blockSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ movement: MovementDTO; blocked: string }>(
    actor,
    INVENTORY_COMMANDS.block,
    { type: 'stock_item', id: input.stockItemId },
    input,
    options
  );
}

export function unblockStockQuantity(
  actor: CurrentUser,
  input: Input<typeof blockSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ movement: MovementDTO; blocked: string }>(
    actor,
    INVENTORY_COMMANDS.unblock,
    { type: 'stock_item', id: input.stockItemId },
    input,
    options
  );
}

export function createStockContainer(
  actor: CurrentUser,
  input: Input<typeof containerSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ stockItemId: string; containerKey: string; label: LabelDTO }>(
    actor,
    INVENTORY_COMMANDS.containerCreate,
    { type: 'stock_item', id: `${input.zohoItemId}:${input.warehouseId}` },
    input,
    options
  );
}

export function claimLegacyStock(
  actor: CurrentUser,
  input: Input<typeof claimSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<ClaimData>(
    actor,
    INVENTORY_COMMANDS.claimLegacy,
    { type: 'legacy_claim', id: `${input.zohoItemId}:${input.warehouseId}` },
    input,
    options
  );
}

export function confirmLegacyStockClaim(
  actor: CurrentUser,
  input: Input<typeof confirmClaimSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ claim: LegacyClaimDTO; reservations: ReservationDTO[]; provisional: boolean }>(
    actor,
    INVENTORY_COMMANDS.confirmLegacy,
    { type: 'legacy_claim', id: input.claimId },
    input,
    options
  );
}

export function releaseLegacyStockClaim(
  actor: CurrentUser,
  input: Input<typeof releaseClaimSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ claim: LegacyClaimDTO }>(
    actor,
    INVENTORY_COMMANDS.releaseLegacy,
    { type: 'legacy_claim', id: input.claimId },
    input,
    options
  );
}

export function ensureInventoryProfile(
  actor: CurrentUser,
  input: Input<typeof ensureProfileSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ profile: ProfileDTO }>(
    actor,
    INVENTORY_COMMANDS.profileEnsure,
    { type: 'inventory_profile', id: `item:${input.zohoItemId}` },
    input,
    options
  );
}

export function updateInventoryProfile(
  actor: CurrentUser,
  input: Input<typeof updateProfileInputSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ profile: ProfileDTO }>(
    actor,
    INVENTORY_COMMANDS.profileUpdate,
    { type: 'inventory_profile', id: input.profileId },
    input,
    options
  );
}

export function createStorageLocation(
  actor: CurrentUser,
  input: Input<typeof createLocationInputSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ location: LocationDTO }>(
    actor,
    INVENTORY_COMMANDS.locationCreate,
    { type: 'storage_location', id: `${input.warehouseId}:${input.code}` },
    input,
    options
  );
}

export function updateStorageLocation(
  actor: CurrentUser,
  input: Input<typeof updateLocationInputSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ location: LocationDTO }>(
    actor,
    INVENTORY_COMMANDS.locationUpdate,
    { type: 'storage_location', id: input.locationId },
    input,
    options
  );
}

export function createInventoryWarehouse(
  actor: CurrentUser,
  input: Input<typeof createWarehouseInputSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ warehouse: WarehouseDTO; general: LocationDTO }>(
    actor,
    INVENTORY_COMMANDS.warehouseCreate,
    { type: 'warehouse', id: input.key ?? input.name },
    input,
    options
  );
}

export function updateInventoryWarehouse(
  actor: CurrentUser,
  input: Input<typeof updateWarehouseInputSchema>,
  options?: InventoryCommandOptions
) {
  return runAsUser<{ warehouse: WarehouseDTO }>(
    actor,
    INVENTORY_COMMANDS.warehouseUpdate,
    { type: 'warehouse', id: input.warehouseId },
    input,
    options
  );
}

export function syncWarehousesFromZoho(actor: CurrentUser, options?: InventoryCommandOptions) {
  return runAsUser<{ defaultWarehouseId: string; warehouses: WarehouseDTO[]; created: number }>(
    actor,
    INVENTORY_COMMANDS.warehouseSyncZoho,
    { type: 'warehouse', id: 'zoho_locations' },
    {},
    options
  );
}

// ---------------------------------------------------------------------------
// Supervisor sweep
// ---------------------------------------------------------------------------

export interface ExpireLegacyClaimsOutcome {
  checked: number;
  expired: number;
  rejected: number;
}

/**
 * Expires legacy claims past their TTL, one idempotent system command per
 * claim (`sup:legacy_expire:{claimId}`). For the operations supervisor.
 */
export async function expireDueLegacyClaims(
  options: { now?: Date; limit?: number } = {}
): Promise<ExpireLegacyClaimsOutcome> {
  const now = options.now ?? new Date();
  const ids = await listDueLegacyClaimIds(prisma, now, options.limit ?? 200);
  const outcome: ExpireLegacyClaimsOutcome = { checked: ids.length, expired: 0, rejected: 0 };
  for (const claimId of ids) {
    const result = await executeCommand(
      {
        commandId: `sup:legacy_expire:${claimId}`,
        type: INVENTORY_COMMANDS.expireLegacy,
        actor: { type: 'system', id: 'inventory.supervisor' },
        aggregate: { type: 'legacy_claim', id: claimId },
        payload: { claimId },
      },
      null,
      { now }
    );
    if (result.status === 'completed') outcome.expired += 1;
    else if (result.status === 'rejected') outcome.rejected += 1;
  }
  if (ids.length > 0) log('legacy_claims_expired', { ...outcome });
  return outcome;
}
