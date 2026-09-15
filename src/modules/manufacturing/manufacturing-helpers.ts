import {
  Prisma,
  type CaseDemand,
  type DemandAllocation,
  type OperationalCase,
  type ProductionOperation,
  type ProductionOrder,
  type WorkCenter,
  type WorkItem,
} from '@prisma/client';
import { hasPermission } from '@/modules/auth/authorization';
import { DEFAULT_TOLERANCE_PCT, inventoryError } from '@/modules/inventory/inventory-types';
import {
  DEFAULT_BASE_UNIT,
  getOrCreateProfile,
  toUnitProfile,
} from '@/modules/inventory/profiles-service';
import {
  StockMathError,
  dec,
  normalizeUnit,
  roundQty,
  toBase,
  type DecimalLike,
  type UnitProfile,
} from '@/modules/inventory/stock-math';
import type { CommandContext, DomainCommand } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { WORK_ITEM_OPEN_STATUSES } from '@/modules/operations/types';
import { cancelWorkItemInTx, completeWorkItemInTx } from '@/modules/operations/work-items-service';
import {
  MANUFACTURING_AREA_KEY,
  MANUFACTURING_FLOOR_CHANNEL,
  MANUFACTURING_OBJECT_TYPES,
  MANUFACTURING_REALTIME_TYPES,
} from './manufacturing-types';

/**
 * Shared server helpers of the manufacturing services: authorization inside a
 * command, loads with Spanish errors, unit conversion, item labels, links to
 * the case and realtime of the floor board. Every writer here runs inside an
 * operations command (`tx` + `CommandContext`).
 */

export type Db = Prisma.TransactionClient;
export type Decimal = Prisma.Decimal;

export const QTY_EPSILON = new Prisma.Decimal('0.00005');

type Actorish = Pick<CommandContext, 'actor' | 'user'>;

/** System/Zoho actors are trusted; people and bots need one of the permissions. */
export function actorMayAny(ctx: Actorish, permissions: readonly string[]): boolean {
  if (ctx.actor.type === 'system' || ctx.actor.type === 'zoho') return true;
  const user = ctx.user;
  if (!user) return false;
  return permissions.some((key) => hasPermission(user, key));
}

export function assertActorMayAny(
  ctx: Actorish,
  permissions: readonly string[],
  message = 'No tienes permisos para realizar esta acción'
): void {
  if (!actorMayAny(ctx, permissions)) throw new OperationsError('forbidden', message);
}

/** When the command happened (offline queue), never after the server clock. */
export function instantOf(cmd: Pick<DomainCommand, 'occurredAt'>, now: Date): Date {
  if (!cmd.occurredAt) return now;
  const parsed = new Date(cmd.occurredAt);
  if (Number.isNaN(parsed.getTime())) return now;
  return parsed.getTime() > now.getTime() ? now : parsed;
}

export function requireId(value: string | null | undefined, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new OperationsError('invalid_payload', `Falta ${field}`);
  return text;
}

export function truncate(text: string | null | undefined, max: number): string | null {
  const clean = typeof text === 'string' ? text.trim() : '';
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

export function num(value: DecimalLike | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(dec(value).toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toDecimal(value: DecimalLike): Decimal {
  return roundQty(dec(value));
}

export function qtyText(value: DecimalLike | null | undefined): string {
  return roundQty(dec(value ?? 0)).toString();
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

export async function loadOrder(tx: Db, orderId: string): Promise<ProductionOrder> {
  const order = await tx.productionOrder.findUnique({
    where: { id: requireId(orderId, 'la orden de producción') },
  });
  if (!order) throw new OperationsError('not_found', 'No se encontró la orden de producción');
  return order;
}

export function assertAggregateMatches(cmd: Pick<DomainCommand, 'aggregate'>, orderId: string): void {
  if (cmd.aggregate.id !== orderId) {
    throw new OperationsError(
      'invalid_payload',
      'La orden de producción no corresponde al registro del comando'
    );
  }
}

export async function loadOperations(tx: Db, orderId: string): Promise<ProductionOperation[]> {
  return tx.productionOperation.findMany({
    where: { productionOrderId: orderId },
    orderBy: [{ seq: 'asc' }, { id: 'asc' }],
  });
}

export async function loadWorkCenter(
  tx: Db,
  workCenterId: string,
  options: { requireActive?: boolean } = {}
): Promise<WorkCenter> {
  const center = await tx.workCenter.findUnique({
    where: { id: requireId(workCenterId, 'el centro de trabajo') },
  });
  if (!center) throw new OperationsError('not_found', 'No se encontró el centro de trabajo');
  if (options.requireActive && center.status !== 'active') {
    throw new OperationsError('invalid_state', `El centro ${center.name} está inactivo`);
  }
  return center;
}

export async function assertActiveWarehouse(tx: Db, warehouseId: string): Promise<void> {
  const warehouse = await tx.warehouse.findUnique({ where: { id: warehouseId } });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  if (!warehouse.active) {
    throw new OperationsError('invalid_state', `La bodega ${warehouse.name} está desactivada`);
  }
}

// ---------------------------------------------------------------------------
// Units and items
// ---------------------------------------------------------------------------

export interface ItemUnits {
  zohoItemId: string;
  baseUnit: string;
  units: UnitProfile;
  tolerancePct: number;
  confidence: string;
}

export async function itemUnits(tx: Db, zohoItemId: string): Promise<ItemUnits> {
  const profile = await getOrCreateProfile(tx, zohoItemId);
  const units = toUnitProfile(profile);
  return {
    zohoItemId,
    baseUnit: units.baseUnit,
    units,
    tolerancePct: num(profile.tolerancePct),
    confidence: profile.confidence,
  };
}

/** Like `itemUnits` but never writes (read paths): a missing profile uses the product unit. */
export async function readItemUnits(db: Db, zohoItemId: string): Promise<ItemUnits> {
  const profile = await db.productInventoryProfile.findUnique({ where: { zohoItemId } });
  if (profile) {
    const units = toUnitProfile(profile);
    return {
      zohoItemId,
      baseUnit: units.baseUnit,
      units,
      tolerancePct: num(profile.tolerancePct),
      confidence: profile.confidence,
    };
  }
  const product = await db.product.findUnique({ where: { zohoItemId }, select: { unit: true } });
  const units = toUnitProfile({ baseUnit: normalizeUnit(product?.unit) || DEFAULT_BASE_UNIT, conversions: [] });
  return {
    zohoItemId,
    baseUnit: units.baseUnit,
    units,
    tolerancePct: DEFAULT_TOLERANCE_PCT,
    confidence: 'UNCOUNTED',
  };
}

export type UnitsResolver = (zohoItemId: string) => Promise<ItemUnits>;

/** Memoized unit lookups for one command or query (`write` creates missing profiles). */
export function unitsResolver(db: Db, mode: 'write' | 'read'): UnitsResolver {
  const cache = new Map<string, Promise<ItemUnits>>();
  return (zohoItemId: string) => {
    let found = cache.get(zohoItemId);
    if (!found) {
      found = mode === 'write' ? itemUnits(db, zohoItemId) : readItemUnits(db, zohoItemId);
      cache.set(zohoItemId, found);
    }
    return found;
  };
}

/** Quantity in the base unit of the item; unknown conversions are `invalid_unit`. */
export function convertToBase(
  quantity: DecimalLike,
  unit: string | null | undefined,
  item: Pick<ItemUnits, 'units' | 'baseUnit' | 'zohoItemId'>
): Decimal {
  try {
    return toBase(quantity, unit || item.baseUnit, item.units);
  } catch (err) {
    if (err instanceof StockMathError) {
      throw inventoryError(
        'invalid_unit',
        `No se puede convertir ${String(unit)} a ${item.baseUnit} para el artículo ${item.zohoItemId}`
      );
    }
    throw err;
  }
}

/** Base units per one `unit` (1 when `unit` is the base unit). */
export function unitFactor(unit: string | null | undefined, item: Pick<ItemUnits, 'units' | 'baseUnit' | 'zohoItemId'>): Decimal {
  return convertToBase(1, unit, item);
}

export function sameMeasure(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeUnit(a);
  return Boolean(left) && left === normalizeUnit(b);
}

export interface ProductInfo {
  name: string | null;
  sku: string | null;
  purchaseRate: Decimal | null;
}

export async function productInfo(
  db: Db,
  zohoItemIds: readonly string[]
): Promise<Map<string, ProductInfo>> {
  const ids = [...new Set(zohoItemIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.product.findMany({
    where: { zohoItemId: { in: ids } },
    select: { zohoItemId: true, name: true, sku: true, purchaseRate: true },
  });
  return new Map(
    rows.map((row) => [
      row.zohoItemId,
      { name: row.name, sku: row.sku, purchaseRate: row.purchaseRate ?? null },
    ])
  );
}

export function itemLabel(products: Map<string, ProductInfo>, zohoItemId: string): string {
  const product = products.get(zohoItemId);
  return product?.name ?? product?.sku ?? zohoItemId;
}

/**
 * Zoho item id of a reference written by a person or another area: the item of
 * the linked demand (by SKU or id), a product id, a product SKU or an item that
 * already has an inventory profile. Null when nothing matches.
 */
export async function resolveItemRef(
  db: Db,
  ref: string | null | undefined,
  demand?: Pick<CaseDemand, 'zohoItemId' | 'sku'> | null
): Promise<string | null> {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) return null;
  if (demand?.zohoItemId && (value === demand.zohoItemId || value === demand.sku)) {
    return demand.zohoItemId;
  }
  const byId = await db.product.findUnique({ where: { zohoItemId: value }, select: { zohoItemId: true } });
  if (byId) return byId.zohoItemId;
  const bySku = await db.product.findFirst({
    where: { sku: { equals: value, mode: 'insensitive' } },
    select: { zohoItemId: true },
    orderBy: { zohoItemId: 'asc' },
  });
  if (bySku) return bySku.zohoItemId;
  const profile = await db.productInventoryProfile.findUnique({
    where: { zohoItemId: value },
    select: { zohoItemId: true },
  });
  return profile?.zohoItemId ?? null;
}

// ---------------------------------------------------------------------------
// Case links
// ---------------------------------------------------------------------------

export interface DemandLink {
  opCase: OperationalCase | null;
  demand: CaseDemand | null;
  allocation: DemandAllocation | null;
}

const CLOSED_ALLOCATION_STATUSES = ['cancelled', 'released', 'delivered'];

/** Validates the case / demand / manufacture allocation a production order is made for. */
export async function resolveDemandLink(
  tx: Db,
  input: { caseId?: string | null; demandId?: string | null; demandAllocationId?: string | null }
): Promise<DemandLink> {
  let allocation: DemandAllocation | null = null;
  if (input.demandAllocationId) {
    allocation = await tx.demandAllocation.findUnique({ where: { id: input.demandAllocationId } });
    if (!allocation) throw new OperationsError('not_found', 'No se encontró la asignación de la partida');
    if (allocation.source !== 'manufacture') {
      throw new OperationsError('invalid_payload', 'La asignación no se surte con manufactura');
    }
    if (CLOSED_ALLOCATION_STATUSES.includes(allocation.status)) {
      throw new OperationsError('invalid_state', 'La asignación ya está cerrada');
    }
    if (input.demandId && input.demandId !== allocation.demandId) {
      throw new OperationsError('invalid_payload', 'La asignación no pertenece a esa partida');
    }
  }
  const demandId = allocation?.demandId ?? input.demandId ?? null;
  let demand: CaseDemand | null = null;
  if (demandId) {
    demand = await tx.caseDemand.findUnique({ where: { id: demandId } });
    if (!demand) throw new OperationsError('not_found', 'No se encontró la partida del expediente');
    if (demand.status === 'cancelled' || demand.status === 'fulfilled') {
      throw new OperationsError('invalid_state', 'La partida del expediente ya está cerrada');
    }
    if (input.caseId && input.caseId !== demand.caseId) {
      throw new OperationsError('invalid_payload', 'La partida no pertenece a ese expediente');
    }
  }
  const caseId = demand?.caseId ?? input.caseId ?? null;
  let opCase: OperationalCase | null = null;
  if (caseId) {
    opCase = await tx.operationalCase.findUnique({ where: { id: caseId } });
    if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
    if (opCase.status === 'closed' || opCase.status === 'cancelled') {
      throw new OperationsError('invalid_state', `El expediente ${opCase.caseNumber} está cerrado o cancelado`);
    }
  }
  return { opCase, demand, allocation };
}

// ---------------------------------------------------------------------------
// Events, realtime, work items
// ---------------------------------------------------------------------------

export function orderEventOptions(order: Pick<ProductionOrder, 'id' | 'caseId'>) {
  return {
    caseId: order.caseId,
    areaKey: MANUFACTURING_AREA_KEY,
    objectType: MANUFACTURING_OBJECT_TYPES.productionOrder,
    objectId: order.id,
  };
}

export const orderRef = (id: string) => ({ type: MANUFACTURING_OBJECT_TYPES.productionOrder, id });

export function publishOrderChange(
  ctx: Pick<CommandContext, 'realtime' | 'commandId' | 'commandType'>,
  order: Pick<ProductionOrder, 'id' | 'number' | 'status' | 'workCenterId' | 'caseId'>,
  extra: Record<string, unknown> = {}
): void {
  ctx.realtime(MANUFACTURING_FLOOR_CHANNEL, MANUFACTURING_REALTIME_TYPES.orders, {
    commandId: ctx.commandId,
    commandType: ctx.commandType,
    productionOrderId: order.id,
    number: order.number,
    status: order.status,
    workCenterId: order.workCenterId,
    caseId: order.caseId,
    ...extra,
  });
}

/**
 * Writes an order that is NOT the aggregate of the running command (the engine
 * bumps the aggregate's version itself): the version bump takes the row lock.
 */
export async function touchOrder(
  tx: Db,
  orderId: string,
  data: Prisma.ProductionOrderUpdateInput = {}
): Promise<ProductionOrder> {
  return tx.productionOrder.update({
    where: { id: orderId },
    data: { ...data, version: { increment: 1 } },
  });
}

export async function openWorkItemsFor(
  tx: Db,
  objectType: string,
  objectId: string,
  filter: { areaKey?: string; kind?: string } = {}
): Promise<WorkItem[]> {
  return tx.workItem.findMany({
    where: {
      objectType,
      objectId,
      status: { in: [...WORK_ITEM_OPEN_STATUSES] },
      ...(filter.areaKey ? { areaKey: filter.areaKey } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export async function closeWorkItems(
  tx: Db,
  items: readonly WorkItem[],
  action: 'complete' | 'cancel',
  reason: string
): Promise<string[]> {
  const closed: string[] = [];
  for (const item of items) {
    if (action === 'complete') {
      await completeWorkItemInTx(tx, item, { result: { closedBy: 'manufacturing', reason }, skipEvidenceCheck: true });
    } else {
      await cancelWorkItemInTx(tx, item, { reason });
    }
    closed.push(item.id);
  }
  return closed;
}
