import { Prisma } from '@prisma/client';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { FakePrisma, Row } from '@/modules/comms/testing/fake-prisma';
import {
  createInventoryFake,
  seedProduct,
  seedProfile,
  seedStockItem,
  seedWarehouse,
} from '@/modules/inventory/testing/inventory-fixtures';
import type { JobContext } from '@/modules/jobs/job-queue';
import { AREA_KEYS } from '../types';
import { seedAreas, seedResponsible, seedUser } from './fixtures';

/** Row shape returned by the reconciler's SQL (type-only: no runtime import of the jobs module). */
export type { ReconcileCandidate as ReconcileRow } from '../case-jobs';

/**
 * Fixtures of the case engine tests (case.start, advance, replan, cancel,
 * jobs): the inventory fake plus SalesOrder / SalesOrderItem / DeliveryOrder /
 * Package / EntityChangeEvent defaults, a team with one responsible per area,
 * the operations config row and seed helpers for orders and stock.
 *
 * Pure test helper (no `@/lib/prisma`): import it from `vi.hoisted`.
 */

export const CASE_TEST_NOW = new Date('2026-09-15T15:00:00.000Z');
export const CASE_TEST_CUTOVER = '2026-09-01T00:00:00.000Z';
export const DEFAULT_ZOHO_LOCATION = 'loc-1';

const nulls = (keys: string[]): Row => Object.fromEntries(keys.map((key) => [key, null]));

export function createCaseFake(): FakePrisma {
  return createInventoryFake({
    defaults: {
      salesOrder: () => ({
        ...nulls([
          'salesOrderNumber',
          'referenceNumber',
          'orderDate',
          'createdTime',
          'subStatus',
          'paidStatus',
          'invoicedStatus',
          'shippedStatus',
          'zohoCustomerId',
          'customerName',
          'customerEmail',
          'customerPhone',
          'zohoSalespersonId',
          'salespersonName',
          'paymentMethod',
          'deliveryMethod',
          'deliveryMethodId',
          'locationId',
          'locationName',
          'branchId',
          'branchName',
          'shippingAttention',
          'shippingAddressLine1',
          'shippingAddressLine2',
          'shippingCity',
          'shippingState',
          'shippingPostalCode',
          'shippingCountry',
          'shippingPhone',
          'currencyCode',
          'total',
          'balance',
          'notes',
          'saleMadeInWarehouse',
        ]),
        status: 'confirmed',
        sourceRemoteModifiedAt: new Date('2026-09-10T00:00:00.000Z'),
        sourceSnapshotId: 'snapshot_1',
        normalizedAt: new Date('2026-09-10T00:00:00.000Z'),
      }),
      salesOrderItem: () => ({
        ...nulls([
          'zohoLineItemId',
          'zohoItemId',
          'sku',
          'name',
          'description',
          'quantity',
          'unit',
          'rate',
          'locationId',
          'locationName',
        ]),
        sortOrder: 0,
      }),
      deliveryOrder: () => ({
        allocationIds: [],
        ...nulls([
          'packageId',
          'zohoPackageId',
          'carrier',
          'vehicleId',
          'driverId',
          'tripId',
          'plannedDate',
          'windowStart',
          'windowEnd',
          'addressLine',
          'city',
          'state',
          'postalCode',
          'contactName',
          'contactPhone',
          'lat',
          'lng',
          'shipmentInput',
          'zohoShipmentId',
          'zohoReadback',
          'conflictDetail',
          'zohoLastAttemptAt',
          'zohoError',
          'deliveredLines',
          'partialReason',
          'parentDeliveryOrderId',
          'deliveredAt',
          'receivedBy',
        ]),
        status: 'pending',
        zohoSyncState: 'not_required',
        version: 1,
      }),
      package: () => ({
        ...nulls([
          'packageNumber',
          'status',
          'date',
          'carrier',
          'trackingNumber',
          'zohoSalesOrderId',
          'shippingAttention',
          'shippingAddress',
          'shippingCity',
          'shippingState',
          'shippingZip',
          'shippingPhone',
          'shipmentStatus',
        ]),
        sourceRemoteModifiedAt: new Date('2026-09-10T00:00:00.000Z'),
        sourceSnapshotId: 'snapshot_1',
      }),
      entityChangeEvent: () => ({ sourceRemoteModifiedAt: null }),
      tripStop: () => ({ status: 'pending' }),
    },
    relations: {
      salesOrder: { items: { model: 'salesOrderItem', childFk: 'salesOrderId' } },
    },
    uniques: {
      package: [['zohoPackageId']],
      entityChangeEvent: [['sourceSnapshotId']],
    },
  });
}

export interface CaseTeam {
  manager: CurrentUser;
  viewer: CurrentUser;
  stranger: CurrentUser;
  byArea: Record<(typeof AREA_KEYS)[number], CurrentUser>;
}

/**
 * Areas, one active responsible per area (`u_<area>`), a manager with
 * `operations.manage` and the permissions used by the engine, a viewer and a
 * user without permissions.
 */
export function seedCaseTeam(fake: FakePrisma): CaseTeam {
  seedAreas(fake);
  const byArea = {} as CaseTeam['byArea'];
  for (const area of AREA_KEYS) {
    byArea[area] = seedUser(fake, { id: `u_${area}`, name: `Responsable ${area}` }).currentUser;
    seedResponsible(fake, { area, userId: `u_${area}` });
  }
  const manager = seedUser(fake, {
    id: 'u_manager',
    name: 'Gestora',
    permissions: [
      'operations.view',
      'operations.manage',
      'inventory.view',
      'inventory.reserve',
      'logistics.view',
      'logistics.dispatch',
    ],
  }).currentUser;
  const viewer = seedUser(fake, {
    id: 'u_viewer',
    name: 'Consulta',
    permissions: ['operations.view'],
  }).currentUser;
  const stranger = seedUser(fake, { id: 'u_stranger', name: 'Sin permisos' }).currentUser;
  return { manager, viewer, stranger, byArea };
}

export function seedOperationsConfig(fake: FakePrisma, settings: Row = {}, isEnabled = true): Row {
  const existing = fake.rows('integrationConfig').find((row) => row.source === 'operations');
  if (existing) {
    Object.assign(existing, {
      isEnabled,
      settings: { ...(existing.settings as Row), ...settings },
      updatedAt: new Date(),
    });
    return existing;
  }
  return fake.seed('integrationConfig', {
    source: 'operations',
    displayName: 'Operaciones',
    isEnabled,
    settings: { cutoverDate: CASE_TEST_CUTOVER, ...settings },
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}

export interface SeedOrderLine {
  zohoLineItemId?: string | null;
  zohoItemId?: string | null;
  sku?: string | null;
  name?: string;
  quantity: number;
  unit?: string | null;
  locationId?: string | null;
}

export interface SeedSalesOrderInput {
  zohoSalesOrderId?: string;
  salesOrderNumber?: string;
  status?: string | null;
  shippedStatus?: string | null;
  invoicedStatus?: string | null;
  paidStatus?: string | null;
  createdTime?: Date | null;
  orderDate?: Date | null;
  locationId?: string | null;
  customerName?: string | null;
  salespersonName?: string | null;
  deliveryMethod?: string | null;
  shippingAddressLine1?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingPostalCode?: string | null;
  lines: SeedOrderLine[];
}

export function seedOrderItems(
  fake: FakePrisma,
  salesOrderId: string,
  lines: SeedOrderLine[]
): Row[] {
  fake.tables.set(
    'salesOrderItem',
    fake.rows('salesOrderItem').filter((row) => row.salesOrderId !== salesOrderId)
  );
  return lines.map((line, index) =>
    fake.seed('salesOrderItem', {
      salesOrderId,
      zohoLineItemId: line.zohoLineItemId === undefined ? `li-${index + 1}` : line.zohoLineItemId,
      zohoItemId: line.zohoItemId === undefined ? `item-${index + 1}` : line.zohoItemId,
      sku: line.sku === undefined ? `SKU-${index + 1}` : line.sku,
      name: line.name ?? `Artículo ${index + 1}`,
      quantity: new Prisma.Decimal(line.quantity),
      unit: line.unit === undefined ? 'pz' : line.unit,
      locationId: line.locationId === undefined ? DEFAULT_ZOHO_LOCATION : line.locationId,
      sortOrder: index + 1,
    })
  );
}

export function seedSalesOrder(
  fake: FakePrisma,
  input: SeedSalesOrderInput
): { order: Row; items: Row[] } {
  const zohoSalesOrderId = input.zohoSalesOrderId ?? 'zso-1';
  const order = fake.seed('salesOrder', {
    id: `so_${zohoSalesOrderId}`,
    zohoSalesOrderId,
    salesOrderNumber: input.salesOrderNumber ?? 'SO-00001',
    status: input.status === undefined ? 'confirmed' : input.status,
    shippedStatus: input.shippedStatus ?? 'pending',
    invoicedStatus: input.invoicedStatus ?? 'not_invoiced',
    paidStatus: input.paidStatus ?? 'unpaid',
    createdTime:
      input.createdTime === undefined ? new Date('2026-09-14T10:00:00.000Z') : input.createdTime,
    orderDate:
      input.orderDate === undefined ? new Date('2026-09-14T00:00:00.000Z') : input.orderDate,
    locationId: input.locationId === undefined ? DEFAULT_ZOHO_LOCATION : input.locationId,
    locationName: 'Bodega Norte',
    customerName: input.customerName === undefined ? 'Constructora Uno' : input.customerName,
    salespersonName: input.salespersonName ?? null,
    deliveryMethod: input.deliveryMethod ?? 'Entrega a domicilio',
    shippingAddressLine1:
      input.shippingAddressLine1 === undefined ? 'Av. Reforma 100' : input.shippingAddressLine1,
    shippingCity: input.shippingCity === undefined ? 'Monterrey' : input.shippingCity,
    shippingState: input.shippingState === undefined ? 'NL' : input.shippingState,
    shippingPostalCode: input.shippingPostalCode === undefined ? '64000' : input.shippingPostalCode,
    shippingAttention: 'Juan Pérez',
    shippingPhone: '8110000000',
  });
  return { order, items: seedOrderItems(fake, order.id as string, input.lines) };
}

export interface SeedItemStockInput {
  zohoItemId: string;
  quantity: number;
  confidence?: 'UNCOUNTED' | 'PROVISIONAL' | 'CONTROLLED' | 'DISPUTED';
  unit?: string;
  defaultSource?: string;
  lastCountedAt?: Date | null;
}

/** Warehouse `principal` (Zoho location `loc-1`), the item's product, profile and GENERAL stock row. */
export function seedItemStock(
  fake: FakePrisma,
  input: SeedItemStockInput
): { warehouse: Row; stockItem: Row; profile: Row } {
  let warehouse = fake.rows('warehouse').find((row) => row.id === 'wh_principal');
  if (!warehouse) {
    warehouse = seedWarehouse(fake, {
      id: 'wh_principal',
      key: 'principal',
      name: 'Bodega principal',
      zohoLocationId: DEFAULT_ZOHO_LOCATION,
    }).warehouse;
  }
  if (!fake.rows('product').some((row) => row.zohoItemId === input.zohoItemId)) {
    seedProduct(fake, { zohoItemId: input.zohoItemId, unit: input.unit ?? 'pz' });
  }
  const profile = seedProfile(fake, {
    zohoItemId: input.zohoItemId,
    baseUnit: input.unit ?? 'pz',
    confidence: input.confidence ?? 'CONTROLLED',
    lastCountAt: input.lastCountedAt ?? null,
  });
  if (input.defaultSource) profile.defaultSource = input.defaultSource;
  const stockItem = seedStockItem(fake, {
    zohoItemId: input.zohoItemId,
    warehouseId: warehouse.id as string,
    locationId: `${warehouse.id}_general`,
    baseline: input.quantity,
    lastCountedAt: input.lastCountedAt ?? null,
  });
  return { warehouse, stockItem, profile };
}

export function makeCaseJob<P>(
  payload: P,
  options: { id?: string; attempt?: number } = {}
): JobContext<P> {
  return {
    id: options.id ?? 'job_1',
    type: 'test',
    payload,
    attempt: options.attempt ?? 1,
    signal: new AbortController().signal,
    async setProgress() {},
    log() {},
  };
}
