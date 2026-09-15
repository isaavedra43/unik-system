import { Prisma } from '@prisma/client';
import type { FakePrisma, FakePrismaOptions, Row } from '@/modules/comms/testing/fake-prisma';
import { createOpsFake } from '@/modules/operations/testing/fixtures';
import { GENERAL_LOCATION_CODE } from '../inventory-types';
import type { ProductLockScope } from '../inventory-locks';
import { computeKnown, dec, type DecimalLike } from '../stock-math';

/**
 * Test fixtures of the inventory module: a FakePrisma with the inventory
 * models (defaults, unique keys and relations of prisma/schema.prisma) on top
 * of the operations core fake, seed helpers and an emulation of the row locks.
 *
 * Usage (inside `vi.hoisted`, so the fake exists before the mocks):
 *
 *   const mocks = await vi.hoisted(async () => {
 *     const f = await import('./testing/inventory-fixtures');
 *     const fake = f.createInventoryFake();
 *     return { fake, locks: f.createLockEmulation(fake) };
 *   });
 *   vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
 *   vi.mock('./inventory-locks', () => mocks.locks.module);
 *
 * Only pure modules are imported here (no `@/lib/prisma`).
 */

const zero = () => new Prisma.Decimal(0);

const INVENTORY_DEFAULTS: Record<string, () => Row> = {
  warehouse: () => ({ zohoLocationId: null, active: true }),
  storageLocation: () => ({ label: null, kind: 'floor', active: true }),
  productInventoryProfile: () => ({
    conversions: [],
    tolerancePct: zero(),
    isBulk: false,
    trackingPolicy: 'none',
    variantAxes: [],
    defaultSource: 'stock',
    confidence: 'UNCOUNTED',
    consecutiveGoodCounts: 0,
    lastCountAt: null,
    controlledAt: null,
    weightKgPerBaseUnit: null,
    areaM2PerBaseUnit: null,
    version: 1,
  }),
  stockItem: () => ({
    variantKey: '',
    variantJson: null,
    containerKey: '',
    baseline: zero(),
    receipts: zero(),
    returns: zero(),
    produced: zero(),
    issued: zero(),
    consumed: zero(),
    adjustments: zero(),
    reserved: zero(),
    blocked: zero(),
    assignedToProduction: zero(),
    knownQty: zero(),
    lastCountedAt: null,
    originProductionOrderId: null,
    dimensions: null,
    version: 1,
  }),
  stockMovement: () => ({
    referenceType: null,
    referenceId: null,
    commandId: null,
    note: null,
    occurredAt: new Date(),
  }),
  stockReservation: () => ({
    allocationId: null,
    status: 'active',
    expiresAt: null,
    releasedAt: null,
    version: 1,
  }),
  stockCount: () => ({ scope: 'spot', status: 'draft', closedAt: null, version: 1 }),
  stockCountLine: () => ({ resolution: 'pending', countedAt: new Date() }),
  legacyCommitmentClaim: () => ({
    variantKey: '',
    reference: null,
    caseId: null,
    status: 'claimed',
    resolvedAt: null,
    version: 1,
  }),
  product: () => ({
    name: null,
    sku: null,
    status: 'active',
    unit: null,
    stockOnHand: null,
    availableStock: null,
    sourceRemoteModifiedAt: new Date(),
    sourceSnapshotId: 'snapshot',
  }),
  salesOrder: () => ({ locationId: null, locationName: null, status: 'open' }),
};

const INVENTORY_UNIQUES: Record<string, string[][]> = {
  warehouse: [['key'], ['zohoLocationId']],
  storageLocation: [['warehouseId', 'code']],
  productInventoryProfile: [['zohoItemId']],
  stockItem: [['zohoItemId', 'warehouseId', 'locationId', 'variantKey', 'containerKey']],
  stockCountLine: [['countId', 'stockItemId']],
  product: [['zohoItemId']],
  salesOrder: [['zohoSalesOrderId']],
};

const INVENTORY_RELATIONS: FakePrismaOptions['relations'] = {
  stockCount: { lines: { model: 'stockCountLine', childFk: 'countId' } },
  stockCountLine: { count: { model: 'stockCount', fk: 'countId' } },
};

/** Operations fake plus the inventory models. */
export function createInventoryFake(options: FakePrismaOptions = {}): FakePrisma {
  const uniques: Record<string, string[][]> = { ...INVENTORY_UNIQUES };
  for (const [model, sets] of Object.entries(options.uniques ?? {})) {
    uniques[model] = [...(uniques[model] ?? []), ...sets];
  }
  return createOpsFake({
    defaults: { ...INVENTORY_DEFAULTS, ...options.defaults },
    relations: { ...INVENTORY_RELATIONS, ...options.relations },
    uniques,
    compoundKeys: options.compoundKeys,
  });
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

export function seedWarehouse(
  fake: FakePrisma,
  input: {
    id?: string;
    key: string;
    name?: string;
    zohoLocationId?: string | null;
    active?: boolean;
  }
): { warehouse: Row; general: Row } {
  const id = input.id ?? `wh_${input.key}`;
  const warehouse = fake.seed('warehouse', {
    id,
    key: input.key,
    name: input.name ?? input.key,
    zohoLocationId: input.zohoLocationId ?? null,
    active: input.active ?? true,
  });
  const general = fake.seed('storageLocation', {
    id: `${id}_general`,
    warehouseId: id,
    code: GENERAL_LOCATION_CODE,
    label: 'General',
    kind: 'floor',
  });
  return { warehouse, general };
}

export function seedLocation(
  fake: FakePrisma,
  input: {
    id?: string;
    warehouseId: string;
    code: string;
    kind?: string;
    label?: string | null;
    active?: boolean;
  }
): Row {
  return fake.seed('storageLocation', {
    id: input.id ?? `loc_${input.warehouseId}_${input.code}`,
    warehouseId: input.warehouseId,
    code: input.code,
    label: input.label ?? null,
    kind: input.kind ?? 'rack',
    active: input.active ?? true,
  });
}

export function seedProduct(
  fake: FakePrisma,
  input: {
    zohoItemId: string;
    name?: string;
    sku?: string | null;
    unit?: string | null;
    stockOnHand?: DecimalLike | null;
    availableStock?: DecimalLike | null;
  }
): Row {
  return fake.seed('product', {
    zohoItemId: input.zohoItemId,
    name: input.name ?? `Producto ${input.zohoItemId}`,
    sku: input.sku ?? null,
    unit: input.unit ?? null,
    stockOnHand:
      input.stockOnHand === undefined || input.stockOnHand === null ? null : dec(input.stockOnHand),
    availableStock:
      input.availableStock === undefined || input.availableStock === null
        ? null
        : dec(input.availableStock),
  });
}

export interface SeedProfileInput {
  id?: string;
  zohoItemId: string;
  baseUnit?: string;
  confidence?: string;
  consecutiveGoodCounts?: number;
  tolerancePct?: DecimalLike;
  conversions?: Array<{ unit: string; factor: DecimalLike; decimals?: number }>;
  trackingPolicy?: string;
  variantAxes?: string[];
  lastCountAt?: Date | null;
  controlledAt?: Date | null;
}

export function seedProfile(fake: FakePrisma, input: SeedProfileInput): Row {
  return fake.seed('productInventoryProfile', {
    id: input.id ?? `profile_${input.zohoItemId}`,
    zohoItemId: input.zohoItemId,
    baseUnit: input.baseUnit ?? 'pz',
    confidence: input.confidence ?? 'UNCOUNTED',
    consecutiveGoodCounts: input.consecutiveGoodCounts ?? 0,
    tolerancePct: dec(input.tolerancePct ?? 2),
    conversions: (input.conversions ?? []).map((c) => ({ ...c, factor: String(c.factor) })),
    trackingPolicy: input.trackingPolicy ?? 'none',
    variantAxes: input.variantAxes ?? [],
    lastCountAt: input.lastCountAt ?? null,
    controlledAt: input.controlledAt ?? null,
  });
}

export interface SeedStockItemInput {
  id?: string;
  zohoItemId: string;
  warehouseId: string;
  locationId: string;
  variantKey?: string;
  containerKey?: string;
  baseline?: DecimalLike;
  receipts?: DecimalLike;
  returns?: DecimalLike;
  produced?: DecimalLike;
  issued?: DecimalLike;
  consumed?: DecimalLike;
  adjustments?: DecimalLike;
  reserved?: DecimalLike;
  blocked?: DecimalLike;
  assignedToProduction?: DecimalLike;
  lastCountedAt?: Date | null;
}

export function seedStockItem(fake: FakePrisma, input: SeedStockItemInput): Row {
  const counters = {
    baseline: dec(input.baseline ?? 0),
    receipts: dec(input.receipts ?? 0),
    returns: dec(input.returns ?? 0),
    produced: dec(input.produced ?? 0),
    issued: dec(input.issued ?? 0),
    consumed: dec(input.consumed ?? 0),
    adjustments: dec(input.adjustments ?? 0),
  };
  return fake.seed('stockItem', {
    ...(input.id ? { id: input.id } : {}),
    zohoItemId: input.zohoItemId,
    warehouseId: input.warehouseId,
    locationId: input.locationId,
    variantKey: input.variantKey ?? '',
    containerKey: input.containerKey ?? '',
    ...counters,
    reserved: dec(input.reserved ?? 0),
    blocked: dec(input.blocked ?? 0),
    assignedToProduction: dec(input.assignedToProduction ?? 0),
    knownQty: computeKnown(counters),
    lastCountedAt: input.lastCountedAt ?? null,
  });
}

/** Seeds a case (if missing) and one of its demands. */
export function seedDemand(
  fake: FakePrisma,
  input: {
    id?: string;
    caseId: string;
    zohoItemId: string;
    quantity: DecimalLike;
    unit?: string;
    variantKey?: string;
    status?: string;
    lineRef?: string;
  }
): Row {
  if (!fake.rows('operationalCase').some((row) => row.id === input.caseId)) {
    const seq = fake.rows('operationalCase').length + 1;
    fake.seed('operationalCase', {
      id: input.caseId,
      caseSeq: seq,
      caseNumber: `EXP-${String(seq).padStart(6, '0')}`,
      kind: 'sales_fulfillment',
      sourceType: 'sales_order',
      sourceId: `so_${input.caseId}`,
      processVersionId: 'pv1',
      ownerUserId: 'owner',
    });
  }
  const id = input.id ?? `demand_${fake.rows('caseDemand').length + 1}`;
  // Like case.start: a demand is expressed in the base unit of the item's profile.
  const profileUnit = fake
    .rows('productInventoryProfile')
    .find((row) => row.zohoItemId === input.zohoItemId)?.baseUnit as string | undefined;
  const unit = input.unit ?? profileUnit ?? 'pz';
  return fake.seed('caseDemand', {
    id,
    caseId: input.caseId,
    lineRef: input.lineRef ?? id,
    zohoItemId: input.zohoItemId,
    name: `Artículo ${input.zohoItemId}`,
    quantity: dec(input.quantity),
    unit,
    baseQuantity: dec(input.quantity),
    baseUnit: unit,
    variantKey: input.variantKey ?? '',
    status: input.status ?? 'planned',
  });
}

// ---------------------------------------------------------------------------
// Row lock emulation
// ---------------------------------------------------------------------------

type LockFn<A extends unknown[], R> = (tx: unknown, ...args: A) => Promise<R>;

export interface LockEmulation {
  /** Drop-in replacement of `../inventory-locks` for `vi.mock`. */
  module: {
    lockStockItem: LockFn<[string], boolean>;
    lockStockItems: LockFn<[readonly string[]], string[]>;
    lockStockItemsForProduct: LockFn<[ProductLockScope], string[]>;
    lockStockCount: LockFn<[string], boolean>;
    lockInventoryProfile: LockFn<[string], boolean>;
  };
  /** Lock keys in acquisition order (`item:{id}`, `count:{id}`, `profile:{id}`). */
  readonly acquired: string[];
  reset(): void;
}

/**
 * Emulates `SELECT … FOR UPDATE` over FakePrisma: `$transaction` receives a
 * distinct client per transaction, a lock held by another transaction makes
 * the caller wait, and every lock is released when the transaction callback
 * settles. With it, two concurrent commands on the same stock serialize like
 * in PostgreSQL (there is still no rollback: a rejected command's writes stay).
 */
export function createLockEmulation(fake: FakePrisma): LockEmulation {
  const holders = new Map<string, object>();
  const waiters = new Map<string, Array<() => void>>();
  const held = new Map<object, Set<string>>();
  const acquired: string[] = [];

  const releaseAll = (tx: object) => {
    const keys = held.get(tx);
    if (!keys) return;
    held.delete(tx);
    for (const key of keys) {
      holders.delete(key);
      const queue = waiters.get(key) ?? [];
      waiters.delete(key);
      for (const resume of queue) resume();
    }
  };

  const original = fake.client.$transaction as (
    arg: unknown,
    options?: unknown
  ) => Promise<unknown>;
  fake.client.$transaction = async (arg: unknown, options?: unknown) => {
    if (typeof arg !== 'function') return original(arg, options);
    const txClient = new Proxy(fake.client, {});
    try {
      return await (arg as (tx: unknown) => Promise<unknown>)(txClient);
    } finally {
      releaseAll(txClient);
    }
  };

  const acquire = async (tx: unknown, key: string) => {
    const owner = tx as object;
    for (;;) {
      const holder = holders.get(key);
      if (!holder || holder === owner) break;
      await new Promise<void>((resolve) => {
        waiters.set(key, [...(waiters.get(key) ?? []), resolve]);
      });
    }
    holders.set(key, owner);
    const keys = held.get(owner) ?? new Set<string>();
    keys.add(key);
    held.set(owner, keys);
    acquired.push(key);
  };

  const exists = (model: string, id: string) => fake.rows(model).some((row) => row.id === id);

  return {
    acquired,
    reset() {
      holders.clear();
      waiters.clear();
      held.clear();
      acquired.length = 0;
    },
    module: {
      async lockStockItem(tx, id) {
        if (!exists('stockItem', id)) return false;
        await acquire(tx, `item:${id}`);
        return true;
      },
      async lockStockItems(tx, ids) {
        const sorted = [...new Set(ids)].filter((id) => exists('stockItem', id)).sort();
        for (const id of sorted) await acquire(tx, `item:${id}`);
        return sorted;
      },
      async lockStockItemsForProduct(tx, scope) {
        const ids = fake
          .rows('stockItem')
          .filter(
            (row) =>
              row.zohoItemId === scope.zohoItemId &&
              (scope.warehouseId === undefined ||
                scope.warehouseId === null ||
                row.warehouseId === scope.warehouseId) &&
              (scope.variantKey === undefined ||
                scope.variantKey === null ||
                row.variantKey === scope.variantKey)
          )
          .map((row) => String(row.id))
          .sort();
        for (const id of ids) await acquire(tx, `item:${id}`);
        return ids;
      },
      async lockStockCount(tx, id) {
        if (!exists('stockCount', id)) return false;
        await acquire(tx, `count:${id}`);
        return true;
      },
      async lockInventoryProfile(tx, id) {
        if (!exists('productInventoryProfile', id)) return false;
        await acquire(tx, `profile:${id}`);
        return true;
      },
    },
  };
}
