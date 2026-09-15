import { Prisma, type StorageLocation, type Warehouse } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getCommandContext, requireCommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import {
  GENERAL_LOCATION_CODE,
  INVENTORY_AREA_KEY,
  INVENTORY_EVENTS,
  LOCATION_KINDS,
  SCRAP_LOCATION_CODE,
  SYSTEM_LOCATION_CODES,
  inventoryError,
} from './inventory-types';

/**
 * Warehouses (`Warehouse`) and storage locations (`StorageLocation`).
 *
 * - Every warehouse has a `GENERAL` location (stock without an explicit
 *   location lands there) and, on demand, a virtual `SCRAP` location for
 *   production scrap. Both are created with INSERT … ON CONFLICT DO NOTHING,
 *   so concurrent callers never raise a unique violation (a P2002 inside a
 *   PostgreSQL transaction would abort it).
 * - `ensureDefaultWarehouse` creates one warehouse per Zoho location seen in
 *   synchronized sales orders (`SalesOrder.locationId/locationName`) and a
 *   "Bodega principal" when no location was ever seen. It is idempotent and
 *   safe under concurrent boots.
 * - Create/update functions run inside inventory commands (they emit events
 *   through the command context).
 */

type Db = Prisma.TransactionClient;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'inventory-warehouses', event, ...extra }));

export const DEFAULT_WAREHOUSE_KEY = 'principal';
export const DEFAULT_WAREHOUSE_NAME = 'Bodega principal';
export const WAREHOUSE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const LOCATION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.\-/]{0,39}$/;

const SYSTEM_LOCATIONS: Record<
  (typeof SYSTEM_LOCATION_CODES)[number],
  { label: string; kind: (typeof LOCATION_KINDS)[number] }
> = {
  [GENERAL_LOCATION_CODE]: { label: 'General', kind: 'floor' },
  [SCRAP_LOCATION_CODE]: { label: 'Merma', kind: 'virtual' },
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** `'Bodega Centro (León)'` → `'bodega-centro-leon'` (never empty). */
export function slugifyWarehouseKey(name: string): string {
  const slug = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'bodega';
}

/** `' rack a 01 '` → `'RACK-A-01'`. */
export function normalizeLocationCode(code: string): string {
  return String(code ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/[^A-Z0-9_.\-/]/g, '')
    .slice(0, 40);
}

export function isSystemLocationCode(code: string): boolean {
  return (SYSTEM_LOCATION_CODES as readonly string[]).includes(code);
}

export interface SeenZohoLocation {
  zohoLocationId: string | null;
  locationName: string | null;
  orders: number;
}

export interface PlannedWarehouse {
  key: string;
  name: string;
  zohoLocationId: string;
  orders: number;
}

/**
 * Pure: warehouses to create for Zoho locations not linked yet. The name is
 * the most used one for the location; keys are deterministic slugs, suffixed
 * with the end of the Zoho id when the slug is taken.
 */
export function planWarehousesFromZohoLocations(
  seen: readonly SeenZohoLocation[],
  existing: ReadonlyArray<{ key: string; zohoLocationId: string | null }>
): PlannedWarehouse[] {
  const byId = new Map<string, { orders: number; names: Map<string, number> }>();
  for (const row of seen) {
    const id = row.zohoLocationId?.trim();
    if (!id) continue;
    const info = byId.get(id) ?? { orders: 0, names: new Map<string, number>() };
    const orders = Math.max(0, row.orders);
    info.orders += orders;
    const name = row.locationName?.trim();
    if (name) info.names.set(name, (info.names.get(name) ?? 0) + orders);
    byId.set(id, info);
  }
  const linked = new Set(existing.map((w) => w.zohoLocationId).filter(Boolean));
  const usedKeys = new Set(existing.map((w) => w.key));
  const plans: PlannedWarehouse[] = [];
  const ordered = [...byId.entries()].sort(
    (a, b) => b[1].orders - a[1].orders || a[0].localeCompare(b[0])
  );
  for (const [zohoLocationId, info] of ordered) {
    if (linked.has(zohoLocationId)) continue;
    const bestName =
      [...info.names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
      `Bodega ${zohoLocationId}`;
    const base = slugifyWarehouseKey(bestName);
    let key = base;
    if (usedKeys.has(key)) {
      const suffix =
        zohoLocationId
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .slice(-6) || 'zoho';
      const stem = base.slice(0, 40 - suffix.length - 1);
      key = `${stem}-${suffix}`;
      for (let n = 2; usedKeys.has(key); n++) {
        const tail = `-${suffix}-${n}`;
        key = `${base.slice(0, 40 - tail.length)}${tail}`;
      }
    }
    usedKeys.add(key);
    plans.push({ key, name: bestName.slice(0, 120), zohoLocationId, orders: info.orders });
  }
  return plans;
}

// ---------------------------------------------------------------------------
// System locations
// ---------------------------------------------------------------------------

/** Returns the GENERAL or SCRAP location of a warehouse, creating it when missing. */
export async function ensureSystemLocation(
  db: Db,
  warehouseId: string,
  code: (typeof SYSTEM_LOCATION_CODES)[number]
): Promise<StorageLocation> {
  const spec = SYSTEM_LOCATIONS[code];
  await db.storageLocation.createMany({
    data: [{ warehouseId, code, label: spec.label, kind: spec.kind }],
    skipDuplicates: true,
  });
  const location = await db.storageLocation.findUnique({
    where: { warehouseId_code: { warehouseId, code } },
  });
  if (!location) throw new Error(`Location ${code} of warehouse ${warehouseId} could not be read`);
  return location;
}

export function ensureGeneralLocation(db: Db, warehouseId: string): Promise<StorageLocation> {
  return ensureSystemLocation(db, warehouseId, GENERAL_LOCATION_CODE);
}

export function ensureScrapLocation(db: Db, warehouseId: string): Promise<StorageLocation> {
  return ensureSystemLocation(db, warehouseId, SCRAP_LOCATION_CODE);
}

// ---------------------------------------------------------------------------
// Default warehouses from Zoho locations
// ---------------------------------------------------------------------------

export interface EnsureDefaultWarehouseResult {
  defaultWarehouse: Warehouse;
  warehouses: Warehouse[];
  created: Warehouse[];
}

/**
 * Makes sure there is at least one warehouse: one per Zoho location seen in
 * sales orders, or "Bodega principal". Every warehouse gets its GENERAL
 * location. The default is the active warehouse with most orders (then the
 * oldest). Idempotent and race-safe.
 */
export async function ensureDefaultWarehouse(
  db: Db = prisma
): Promise<EnsureDefaultWarehouseResult> {
  const grouped = await db.salesOrder.groupBy({
    by: ['locationId', 'locationName'],
    where: { locationId: { not: null } },
    _count: { _all: true },
  });
  const seen: SeenZohoLocation[] = grouped.map((row) => ({
    zohoLocationId: row.locationId,
    locationName: row.locationName,
    orders: row._count._all,
  }));
  const existing = await db.warehouse.findMany({ select: { key: true, zohoLocationId: true } });
  const plans = planWarehousesFromZohoLocations(seen, existing);

  const created: Warehouse[] = [];
  if (plans.length > 0) {
    created.push(
      ...(await db.warehouse.createManyAndReturn({
        data: plans.map((plan) => ({
          key: plan.key,
          name: plan.name,
          zohoLocationId: plan.zohoLocationId,
        })),
        skipDuplicates: true,
      }))
    );
  }
  let warehouses = await db.warehouse.findMany({ orderBy: [{ createdAt: 'asc' }, { key: 'asc' }] });
  if (warehouses.length === 0) {
    created.push(
      ...(await db.warehouse.createManyAndReturn({
        data: [{ key: DEFAULT_WAREHOUSE_KEY, name: DEFAULT_WAREHOUSE_NAME }],
        skipDuplicates: true,
      }))
    );
    warehouses = await db.warehouse.findMany({ orderBy: [{ createdAt: 'asc' }, { key: 'asc' }] });
  }
  if (warehouses.length === 0) throw new Error('No warehouse could be created');

  await db.storageLocation.createMany({
    data: warehouses.map((warehouse) => ({
      warehouseId: warehouse.id,
      code: GENERAL_LOCATION_CODE,
      label: SYSTEM_LOCATIONS[GENERAL_LOCATION_CODE].label,
      kind: SYSTEM_LOCATIONS[GENERAL_LOCATION_CODE].kind,
    })),
    skipDuplicates: true,
  });

  const ordersByLocation = new Map<string, number>();
  for (const row of seen) {
    if (!row.zohoLocationId) continue;
    ordersByLocation.set(
      row.zohoLocationId,
      (ordersByLocation.get(row.zohoLocationId) ?? 0) + row.orders
    );
  }
  const orders = (w: Warehouse) =>
    w.zohoLocationId ? (ordersByLocation.get(w.zohoLocationId) ?? 0) : 0;
  const active = warehouses.filter((w) => w.active);
  const defaultWarehouse =
    [...active].sort(
      (a, b) => orders(b) - orders(a) || a.createdAt.getTime() - b.createdAt.getTime()
    )[0] ?? warehouses[0];

  if (created.length > 0) {
    log('warehouses_created', {
      count: created.length,
      keys: created.map((w) => w.key),
    });
    const ctx = getCommandContext(db);
    for (const warehouse of created) {
      ctx?.emit(
        INVENTORY_EVENTS.warehouseCreated,
        {
          warehouseId: warehouse.id,
          key: warehouse.key,
          name: warehouse.name,
          zohoLocationId: warehouse.zohoLocationId,
          automatic: true,
        },
        { areaKey: INVENTORY_AREA_KEY, objectType: 'warehouse', objectId: warehouse.id }
      );
    }
  }
  return { defaultWarehouse, warehouses, created };
}

/**
 * Warehouse for a Zoho location id (e.g. `CaseDemand.locationId`). Without an
 * id (or for an id never seen) it falls back to the default warehouse.
 */
export async function resolveWarehouseForZohoLocation(
  db: Db,
  zohoLocationId: string | null | undefined
): Promise<Warehouse> {
  const id = zohoLocationId?.trim();
  if (id) {
    const linked = await db.warehouse.findUnique({ where: { zohoLocationId: id } });
    if (linked) return linked;
  }
  const ensured = await ensureDefaultWarehouse(db);
  if (id) {
    const linked = ensured.warehouses.find((w) => w.zohoLocationId === id);
    if (linked) return linked;
  }
  return ensured.defaultWarehouse;
}

// ---------------------------------------------------------------------------
// Warehouse CRUD (commands)
// ---------------------------------------------------------------------------

export const createWarehouseInputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(WAREHOUSE_KEY_PATTERN, 'Clave inválida: usa minúsculas, números y guiones')
      .optional(),
    name: z.string().trim().min(1, 'Falta el nombre').max(120),
    zohoLocationId: z.string().trim().min(1).max(120).nullish(),
  })
  .strict();
export type CreateWarehouseInput = z.output<typeof createWarehouseInputSchema>;

export async function createWarehouse(
  tx: Db,
  input: CreateWarehouseInput
): Promise<{ warehouse: Warehouse; general: StorageLocation }> {
  const ctx = requireCommandContext(tx);
  const key = input.key ?? slugifyWarehouseKey(input.name);
  const zohoLocationId = input.zohoLocationId ?? null;
  if (zohoLocationId) {
    const linked = await tx.warehouse.findUnique({ where: { zohoLocationId } });
    if (linked) {
      throw inventoryError(
        'duplicate',
        `La ubicación de Zoho ya está ligada a la bodega ${linked.name}`
      );
    }
  }
  const [warehouse] = await tx.warehouse.createManyAndReturn({
    data: [{ key, name: input.name, zohoLocationId }],
    skipDuplicates: true,
  });
  if (!warehouse) throw inventoryError('duplicate', `Ya existe una bodega con la clave "${key}"`);
  const general = await ensureGeneralLocation(tx, warehouse.id);
  ctx.emit(
    INVENTORY_EVENTS.warehouseCreated,
    { warehouseId: warehouse.id, key, name: warehouse.name, zohoLocationId, automatic: false },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'warehouse', objectId: warehouse.id }
  );
  return { warehouse, general };
}

export const updateWarehouseInputSchema = z
  .object({
    warehouseId: z.string().trim().min(1),
    name: z.string().trim().min(1, 'Falta el nombre').max(120).optional(),
    active: z.boolean().optional(),
    zohoLocationId: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();
export type UpdateWarehouseInput = z.output<typeof updateWarehouseInputSchema>;

async function hasStockOrReservations(tx: Db, where: Prisma.StockItemWhereInput): Promise<boolean> {
  const count = await tx.stockItem.count({
    where: { ...where, OR: [{ knownQty: { not: 0 } }, { reserved: { not: 0 } }] },
  });
  return count > 0;
}

export async function updateWarehouse(tx: Db, input: UpdateWarehouseInput): Promise<Warehouse> {
  const ctx = requireCommandContext(tx);
  const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId } });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  const data: Prisma.WarehouseUpdateInput = {};
  const fields: string[] = [];
  if (input.name !== undefined && input.name !== warehouse.name) {
    data.name = input.name;
    fields.push('name');
  }
  if (input.zohoLocationId !== undefined && input.zohoLocationId !== warehouse.zohoLocationId) {
    if (input.zohoLocationId) {
      const linked = await tx.warehouse.findUnique({
        where: { zohoLocationId: input.zohoLocationId },
      });
      if (linked && linked.id !== warehouse.id) {
        throw inventoryError(
          'duplicate',
          `La ubicación de Zoho ya está ligada a la bodega ${linked.name}`
        );
      }
    }
    data.zohoLocationId = input.zohoLocationId;
    fields.push('zohoLocationId');
  }
  if (input.active !== undefined && input.active !== warehouse.active) {
    if (!input.active && (await hasStockOrReservations(tx, { warehouseId: warehouse.id }))) {
      throw new OperationsError(
        'invalid_state',
        'La bodega tiene existencias o reservas; traspásalas o libéralas antes de desactivarla'
      );
    }
    data.active = input.active;
    fields.push('active');
  }
  if (fields.length === 0) return warehouse;
  const updated = await tx.warehouse.update({ where: { id: warehouse.id }, data });
  ctx.emit(
    INVENTORY_EVENTS.warehouseUpdated,
    { warehouseId: updated.id, fields, active: updated.active },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'warehouse', objectId: updated.id }
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Location CRUD (commands)
// ---------------------------------------------------------------------------

export const createLocationInputSchema = z
  .object({
    warehouseId: z.string().trim().min(1),
    code: z.string().trim().min(1, 'Falta el código').max(40),
    label: z.string().trim().max(120).nullish(),
    kind: z.enum(LOCATION_KINDS).default('rack'),
  })
  .strict();
export type CreateLocationInput = z.output<typeof createLocationInputSchema>;

export async function createLocation(tx: Db, input: CreateLocationInput): Promise<StorageLocation> {
  const ctx = requireCommandContext(tx);
  const warehouse = await tx.warehouse.findUnique({ where: { id: input.warehouseId } });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  if (!warehouse.active) throw new OperationsError('invalid_state', 'La bodega está desactivada');
  const code = normalizeLocationCode(input.code);
  if (!LOCATION_CODE_PATTERN.test(code)) {
    throw new OperationsError(
      'invalid_payload',
      'Código de ubicación inválido: usa letras, números, guiones o puntos'
    );
  }
  if (isSystemLocationCode(code)) {
    throw new OperationsError('invalid_payload', `El código ${code} está reservado por el sistema`);
  }
  const [location] = await tx.storageLocation.createManyAndReturn({
    data: [
      {
        warehouseId: warehouse.id,
        code,
        label: input.label?.trim() || null,
        kind: input.kind,
      },
    ],
    skipDuplicates: true,
  });
  if (!location) {
    throw inventoryError('duplicate', `Ya existe la ubicación ${code} en ${warehouse.name}`);
  }
  ctx.emit(
    INVENTORY_EVENTS.locationCreated,
    { locationId: location.id, warehouseId: warehouse.id, code, kind: location.kind },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'storage_location', objectId: location.id }
  );
  return location;
}

export const updateLocationInputSchema = z
  .object({
    locationId: z.string().trim().min(1),
    label: z.string().trim().max(120).nullable().optional(),
    kind: z.enum(LOCATION_KINDS).optional(),
    active: z.boolean().optional(),
  })
  .strict();
export type UpdateLocationInput = z.output<typeof updateLocationInputSchema>;

export async function updateLocation(tx: Db, input: UpdateLocationInput): Promise<StorageLocation> {
  const ctx = requireCommandContext(tx);
  const location = await tx.storageLocation.findUnique({ where: { id: input.locationId } });
  if (!location) throw new OperationsError('not_found', 'No se encontró la ubicación');
  const system = isSystemLocationCode(location.code);
  const data: Prisma.StorageLocationUpdateInput = {};
  const fields: string[] = [];
  if (input.label !== undefined && (input.label?.trim() || null) !== location.label) {
    data.label = input.label?.trim() || null;
    fields.push('label');
  }
  if (input.kind !== undefined && input.kind !== location.kind) {
    if (system)
      throw new OperationsError('invalid_state', `No se puede cambiar el tipo de ${location.code}`);
    data.kind = input.kind;
    fields.push('kind');
  }
  if (input.active !== undefined && input.active !== location.active) {
    if (system)
      throw new OperationsError('invalid_state', `No se puede desactivar ${location.code}`);
    if (!input.active && (await hasStockOrReservations(tx, { locationId: location.id }))) {
      throw new OperationsError(
        'invalid_state',
        'La ubicación tiene existencias o reservas; traspásalas antes de desactivarla'
      );
    }
    data.active = input.active;
    fields.push('active');
  }
  if (fields.length === 0) return location;
  const updated = await tx.storageLocation.update({ where: { id: location.id }, data });
  ctx.emit(
    INVENTORY_EVENTS.locationUpdated,
    { locationId: updated.id, warehouseId: updated.warehouseId, code: updated.code, fields },
    { areaKey: INVENTORY_AREA_KEY, objectType: 'storage_location', objectId: updated.id }
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listWarehouses(
  db: Db = prisma,
  options: { includeInactive?: boolean } = {}
): Promise<Warehouse[]> {
  return db.warehouse.findMany({
    where: options.includeInactive ? {} : { active: true },
    orderBy: [{ name: 'asc' }],
  });
}

export async function listLocations(
  db: Db,
  options: { warehouseId: string; includeInactive?: boolean }
): Promise<StorageLocation[]> {
  return db.storageLocation.findMany({
    where: {
      warehouseId: options.warehouseId,
      ...(options.includeInactive ? {} : { active: true }),
    },
    orderBy: [{ code: 'asc' }],
  });
}
