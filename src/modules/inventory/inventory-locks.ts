import { Prisma } from '@prisma/client';

/**
 * Pessimistic row locks of the inventory module (`SELECT … FOR UPDATE`).
 *
 * They are taken inside the command transaction right before reading the
 * counters that a decision depends on (available stock for a reservation, the
 * expected quantity of a count line, the status of a count). A concurrent
 * transaction that wants the same rows waits until the first one commits; in
 * READ COMMITTED every later statement then sees the committed values, so two
 * users can never reserve the same units (the second one is rejected).
 *
 * Multi-row locks are acquired in `id` order to keep a stable lock order
 * between transactions. FakePrisma cannot emulate row locks: unit tests mock
 * this module (plan §11, risk "SELECT … FOR UPDATE no es simulable").
 */

type Db = Prisma.TransactionClient;

/** Locks one stock item. Returns false when the row does not exist. */
export async function lockStockItem(tx: Db, stockItemId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StockItem" WHERE "id" = ${stockItemId} FOR UPDATE`;
  return rows.length === 1;
}

/** Locks several stock items in id order; returns the ids that exist. */
export async function lockStockItems(tx: Db, stockItemIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(stockItemIds.filter(Boolean))].sort();
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StockItem" WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id" FOR UPDATE`;
  return rows.map((row) => row.id);
}

export interface ProductLockScope {
  zohoItemId: string;
  /** Omitted: every warehouse. */
  warehouseId?: string | null;
  /** Omitted: every variant; '' is the "no variant" row set. */
  variantKey?: string | null;
}

/**
 * Locks every stock item of a product (optionally one warehouse / variant) in
 * id order and returns their ids. Reservations and legacy claims use it so the
 * availability of the whole group (items minus claims) is computed under lock.
 */
export async function lockStockItemsForProduct(tx: Db, scope: ProductLockScope): Promise<string[]> {
  const warehouseFilter =
    scope.warehouseId !== undefined && scope.warehouseId !== null
      ? Prisma.sql`AND "warehouseId" = ${scope.warehouseId}`
      : Prisma.empty;
  const variantFilter =
    scope.variantKey !== undefined && scope.variantKey !== null
      ? Prisma.sql`AND "variantKey" = ${scope.variantKey}`
      : Prisma.empty;
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StockItem"
    WHERE "zohoItemId" = ${scope.zohoItemId} ${warehouseFilter} ${variantFilter}
    ORDER BY "id" FOR UPDATE`;
  return rows.map((row) => row.id);
}

/** Locks a physical count (serializes line capture with closing). */
export async function lockStockCount(tx: Db, countId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StockCount" WHERE "id" = ${countId} FOR UPDATE`;
  return rows.length === 1;
}

/** Locks an item profile (confidence and good-count counter updated by count closes). */
export async function lockInventoryProfile(tx: Db, profileId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ProductInventoryProfile" WHERE "id" = ${profileId} FOR UPDATE`;
  return rows.length === 1;
}
