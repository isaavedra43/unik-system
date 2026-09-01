import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { getActiveWatchers } from './entity-watch-service';

/**
 * Change detection and notification service for Sales Orders.
 *
 * IMPORTANT RULES:
 * - First import of an order does NOT generate a change event.
 * - Retry of the normalizer does NOT generate duplicate events (idempotency
 *   via sourceSnapshotId unique constraint).
 * - Only meaningful business fields are compared (never updatedAt,
 *   normalizedAt, sourceSnapshotId, internal IDs, technical timestamps).
 * - Change events are created for ALL real changes, even if nobody watches
 *   the order (so the detail page can show history).
 * - Notifications are created ONLY for active watchers.
 */

export const SALES_ORDER_ENTITY_TYPE = 'sales_order';

interface SalesOrderSnapshot {
  id: string;
  status: string | null;
  subStatus: string | null;
  paidStatus: string | null;
  invoicedStatus: string | null;
  shippedStatus: string | null;
  customerName: string | null;
  customerPhone: string | null;
  salespersonName: string | null;
  paymentMethod: string | null;
  deliveryMethod: string | null;
  locationName: string | null;
  branchName: string | null;
  shippingAddressLine1: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPostalCode: string | null;
  subtotal: Prisma.Decimal | null;
  discountTotal: Prisma.Decimal | null;
  taxTotal: Prisma.Decimal | null;
  shippingCharge: Prisma.Decimal | null;
  adjustment: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  saleMadeInWarehouse: boolean | null;
}

interface ItemSnapshot {
  zohoLineItemId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  name: string | null;
  quantity: Prisma.Decimal | null;
  rate: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
  taxPercentage: Prisma.Decimal | null;
  lineTotal: Prisma.Decimal | null;
}

const MEANINGFUL_FIELDS: (keyof SalesOrderSnapshot)[] = [
  'status',
  'subStatus',
  'paidStatus',
  'invoicedStatus',
  'shippedStatus',
  'customerName',
  'customerPhone',
  'salespersonName',
  'paymentMethod',
  'deliveryMethod',
  'locationName',
  'branchName',
  'shippingAddressLine1',
  'shippingCity',
  'shippingState',
  'shippingPostalCode',
  'subtotal',
  'discountTotal',
  'taxTotal',
  'shippingCharge',
  'adjustment',
  'total',
  'balance',
  'saleMadeInWarehouse',
];

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a instanceof Prisma.Decimal && b instanceof Prisma.Decimal) return a.equals(b);
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return String(a) === String(b);
}

function diffFields(
  before: SalesOrderSnapshot,
  after: SalesOrderSnapshot
): Record<string, { before: unknown; after: unknown }> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of MEANINGFUL_FIELDS) {
    const b = before[field];
    const a = after[field];
    if (!valuesEqual(b, a)) {
      changes[field] = {
        before: b instanceof Prisma.Decimal ? b.toString() : b,
        after: a instanceof Prisma.Decimal ? a.toString() : a,
      };
    }
  }
  return changes;
}

function itemKey(item: ItemSnapshot): string {
  return item.zohoLineItemId ?? item.zohoItemId ?? item.sku ?? item.name ?? '';
}

function diffItems(before: ItemSnapshot[], after: ItemSnapshot[]): Record<string, unknown> | null {
  const beforeMap = new Map(before.map((i) => [itemKey(i), i]));
  const afterMap = new Map(after.map((i) => [itemKey(i), i]));

  const added: string[] = [];
  const removed: string[] = [];
  const modified: Record<string, Record<string, { before: unknown; after: unknown }>> = {};

  for (const [key, afterItem] of afterMap) {
    if (!beforeMap.has(key)) {
      added.push(key);
      continue;
    }
    const beforeItem = beforeMap.get(key)!;
    const itemChanges: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of [
      'quantity',
      'rate',
      'discountAmount',
      'taxPercentage',
      'lineTotal',
    ] as (keyof ItemSnapshot)[]) {
      if (!valuesEqual(beforeItem[field], afterItem[field])) {
        itemChanges[field] = {
          before:
            beforeItem[field] instanceof Prisma.Decimal
              ? beforeItem[field].toString()
              : beforeItem[field],
          after:
            afterItem[field] instanceof Prisma.Decimal
              ? afterItem[field].toString()
              : afterItem[field],
        };
      }
    }
    if (Object.keys(itemChanges).length > 0) {
      modified[key] = itemChanges;
    }
  }

  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) removed.push(key);
  }

  if (added.length === 0 && removed.length === 0 && Object.keys(modified).length === 0) {
    return null;
  }

  return { added, removed, modified };
}

async function getSalesOrderSnapshot(
  tx: Prisma.TransactionClient,
  salesOrderId: string
): Promise<{ order: SalesOrderSnapshot | null; items: ItemSnapshot[] }> {
  const order = await tx.salesOrder.findUnique({
    where: { id: salesOrderId },
    select: {
      id: true,
      status: true,
      subStatus: true,
      paidStatus: true,
      invoicedStatus: true,
      shippedStatus: true,
      customerName: true,
      customerPhone: true,
      salespersonName: true,
      paymentMethod: true,
      deliveryMethod: true,
      locationName: true,
      branchName: true,
      shippingAddressLine1: true,
      shippingCity: true,
      shippingState: true,
      shippingPostalCode: true,
      subtotal: true,
      discountTotal: true,
      taxTotal: true,
      shippingCharge: true,
      adjustment: true,
      total: true,
      balance: true,
      saleMadeInWarehouse: true,
    },
  });

  if (!order) return { order: null, items: [] };

  const items = await tx.salesOrderItem.findMany({
    where: { salesOrderId },
    orderBy: { sortOrder: 'asc' },
    select: {
      zohoLineItemId: true,
      zohoItemId: true,
      sku: true,
      name: true,
      quantity: true,
      rate: true,
      discountAmount: true,
      taxPercentage: true,
      lineTotal: true,
    },
  });

  return { order: order as SalesOrderSnapshot, items: items as ItemSnapshot[] };
}

/**
 * Wrapper that the normalizer calls. It receives the BEFORE state (captured
 * before the upsert) and the AFTER state (after the upsert), computes the diff,
 * and records the change event + notifications inside the transaction.
 */
export async function recordSalesOrderChange(
  tx: Prisma.TransactionClient,
  salesOrderId: string,
  salesOrderNumber: string | null,
  sourceSnapshotId: string,
  sourceRemoteModifiedAt: Date | null,
  beforeOrder: SalesOrderSnapshot | null,
  beforeItems: ItemSnapshot[],
  afterOrder: SalesOrderSnapshot,
  afterItems: ItemSnapshot[]
): Promise<void> {
  // First import: no previous version → no change event.
  if (beforeOrder === null) return;

  // Idempotency: skip if event already exists for this snapshot.
  const existing = await tx.entityChangeEvent.findUnique({
    where: { sourceSnapshotId },
    select: { id: true },
  });
  if (existing) return;

  const fieldChanges = diffFields(beforeOrder, afterOrder);
  const itemChanges = diffItems(beforeItems, afterItems);

  const hasChanges = Object.keys(fieldChanges).length > 0 || itemChanges !== null;
  if (!hasChanges) return;

  const changes: Record<string, unknown> = {};
  if (Object.keys(fieldChanges).length > 0) changes.fields = fieldChanges;
  if (itemChanges !== null) changes.items = itemChanges;

  const event = await tx.entityChangeEvent.create({
    data: {
      entityType: SALES_ORDER_ENTITY_TYPE,
      entityId: salesOrderId,
      sourceSnapshotId,
      sourceRemoteModifiedAt,
      changes: changes as Prisma.InputJsonValue,
    },
  });

  // Create notifications for active watchers (idempotent).
  const watchers = await tx.entityWatch.findMany({
    where: { entityType: SALES_ORDER_ENTITY_TYPE, entityId: salesOrderId, isActive: true },
    select: { userId: true },
  });

  if (watchers.length === 0) return;

  const title = `OV-${salesOrderNumber ?? salesOrderId.slice(-6)} tiene cambios`;
  const body = Object.keys(fieldChanges)
    .slice(0, 3)
    .map((f) => `${f}: ${fieldChanges[f].before ?? '—'} → ${fieldChanges[f].after ?? '—'}`)
    .join(', ');

  // Check for existing notifications to maintain idempotency.
  for (const watcher of watchers) {
    const existingNotif = await tx.notification.findFirst({
      where: { userId: watcher.userId, changeEventId: event.id },
      select: { id: true },
    });
    if (existingNotif) continue;

    await tx.notification.create({
      data: {
        userId: watcher.userId,
        type: 'sales_order_changed',
        title,
        body: body || 'Se detectaron cambios en la orden',
        entityType: SALES_ORDER_ENTITY_TYPE,
        entityId: salesOrderId,
        changeEventId: event.id,
        metadata: { salesOrderNumber } as Prisma.InputJsonValue,
      },
    });
  }
}

export { getActiveWatchers };

export async function getSalesOrderChangeEvents(
  salesOrderId: string,
  limit = 50
): Promise<
  {
    id: string;
    changes: unknown;
    sourceRemoteModifiedAt: string | null;
    createdAt: string;
  }[]
> {
  const events = await prisma.entityChangeEvent.findMany({
    where: { entityType: SALES_ORDER_ENTITY_TYPE, entityId: salesOrderId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
  });

  return events.map((e) => ({
    id: e.id,
    changes: e.changes,
    sourceRemoteModifiedAt: e.sourceRemoteModifiedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  }));
}

export type { SalesOrderSnapshot, ItemSnapshot };
