import { Prisma } from '@prisma/client';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { FakePrisma, Row } from '@/modules/comms/testing/fake-prisma';
import {
  createInventoryFake,
  seedDemand,
  seedProfile,
  seedStockItem,
  seedWarehouse,
} from '@/modules/inventory/testing/inventory-fixtures';
import type { JobContext } from '@/modules/jobs/job-queue';
import {
  RAW_NOT_HANDLED,
  addRawHandler,
  seedAreas,
  seedResponsible,
  seedUser,
} from '@/modules/operations/testing/fixtures';
import { AREA_KEYS } from '@/modules/operations/types';

/**
 * Fixtures of the manufacturing tests: the inventory fake (core + inventory
 * models) plus the manufacturing models with their defaults, relations and
 * unique keys as in prisma/schema.prisma, the raw handler of the BOM row lock,
 * a team with one person per permission and seeds for work centers, materials
 * and a case allocation that asks for a transformation.
 *
 * Pure test helper (no `@/lib/prisma`): import it from `vi.hoisted`.
 */

export const MFG_NOW = new Date('2026-09-15T15:00:00.000Z'); // Tuesday 09:00 in Mexico City
export const WAREHOUSE_ID = 'wh_principal';

const zero = () => new Prisma.Decimal(0);
export const D = (value: number | string) => new Prisma.Decimal(value);

const MANUFACTURING_DEFAULTS: Record<string, () => Row> = {
  workCenter: () => ({ warehouseId: null, shifts: [], costPerHour: null, currency: 'MXN', status: 'active' }),
  bom: () => ({ version: 1, status: 'draft', expectedYield: null, scrapAllowancePct: null, notes: null }),
  bomLine: () => ({ substituteZohoItemIds: [], scrapPct: null, sortOrder: 0 }),
  bomOperation: () => ({ setupMinutes: 0, qcRequired: false }),
  productionOrder: () => ({
    kind: 'transformation',
    bomId: null,
    caseId: null,
    demandId: null,
    demandAllocationId: null,
    outputName: null,
    producedQty: zero(),
    scrapQty: zero(),
    leftoverQty: zero(),
    status: 'draft',
    priority: 'normal',
    plannedStartAt: null,
    plannedEndAt: null,
    startedAt: null,
    completedAt: null,
    workCenterId: null,
    releaseTarget: 'inventory',
    outputLocationId: null,
    blockedReason: null,
    inputs: null,
    version: 1,
  }),
  productionOperation: () => ({
    status: 'pending',
    assignedUserId: null,
    plannedStartAt: null,
    plannedMinutes: null,
    startedAt: null,
    finishedAt: null,
    actualMinutes: null,
  }),
  materialConsumption: () => ({
    operationId: null,
    stockItemId: null,
    reservationId: null,
    qtyPlanned: zero(),
    qtyActual: zero(),
    substitutedForZohoItemId: null,
    stockMovementId: null,
    approvalRequestId: null,
  }),
  productionOutput: () => ({
    dimensions: null,
    stockMovementId: null,
    stockItemId: null,
    locationId: null,
    qualityCheckId: null,
  }),
  qualityCheck: () => ({ operationId: null, checklist: null, notes: null, evidenceObjectIds: [], inspectedAt: new Date() }),
  storageObject: () => ({ status: 'ready', purpose: 'evidence' }),
  product: () => ({
    name: null,
    sku: null,
    status: 'active',
    unit: null,
    stockOnHand: null,
    availableStock: null,
    purchaseRate: null,
    sourceRemoteModifiedAt: new Date(),
    sourceSnapshotId: 'snapshot',
  }),
  deliveryOrder: () => ({
    allocationIds: [],
    packageId: null,
    zohoPackageId: null,
    tripId: null,
    status: 'pending',
    zohoSyncState: 'not_required',
    version: 1,
  }),
};

const MANUFACTURING_RELATIONS = {
  productionOrder: {
    operations: { model: 'productionOperation', childFk: 'productionOrderId' },
    consumptions: { model: 'materialConsumption', childFk: 'productionOrderId' },
    outputs: { model: 'productionOutput', childFk: 'productionOrderId' },
    qualityChecks: { model: 'qualityCheck', childFk: 'productionOrderId' },
  },
  productionOperation: { productionOrder: { model: 'productionOrder', fk: 'productionOrderId' } },
  materialConsumption: { productionOrder: { model: 'productionOrder', fk: 'productionOrderId' } },
  productionOutput: { productionOrder: { model: 'productionOrder', fk: 'productionOrderId' } },
  qualityCheck: { productionOrder: { model: 'productionOrder', fk: 'productionOrderId' } },
  bom: {
    lines: { model: 'bomLine', childFk: 'bomId' },
    operations: { model: 'bomOperation', childFk: 'bomId' },
  },
  bomLine: { bom: { model: 'bom', fk: 'bomId' } },
  bomOperation: { bom: { model: 'bom', fk: 'bomId' } },
};

export function createManufacturingFake(): FakePrisma {
  const fake = createInventoryFake({
    defaults: MANUFACTURING_DEFAULTS,
    relations: MANUFACTURING_RELATIONS,
    uniques: {
      workCenter: [['key']],
      bom: [['outputZohoItemId', 'version']],
      productionOrder: [['number']],
    },
  });
  addRawHandler(fake, (query, current) => {
    if (!/FROM "Bom"[\s\S]*FOR UPDATE/.test(query.sql)) return RAW_NOT_HANDLED;
    const output = String(query.values[0]);
    return current
      .rows('bom')
      .filter((row) => row.outputZohoItemId === output)
      .map((row) => ({ id: row.id }));
  });
  return fake;
}

export interface ManufacturingTeam {
  planner: CurrentUser;
  operator: CurrentUser;
  inspector: CurrentUser;
  approver: CurrentUser;
  viewer: CurrentUser;
  stranger: CurrentUser;
  byArea: Record<(typeof AREA_KEYS)[number], CurrentUser>;
}

/** Areas with one responsible each (`u_<area>`) and one person per manufacturing role. */
export function seedManufacturingTeam(fake: FakePrisma): ManufacturingTeam {
  seedAreas(fake);
  const byArea = {} as ManufacturingTeam['byArea'];
  for (const area of AREA_KEYS) {
    byArea[area] = seedUser(fake, { id: `u_${area}`, name: `Responsable ${area}` }).currentUser;
    seedResponsible(fake, { area, userId: `u_${area}` });
  }
  const planner = seedUser(fake, {
    id: 'u_planner',
    name: 'Planeadora',
    permissions: ['operations.view', 'manufacturing.view', 'manufacturing.manage_orders', 'manufacturing.manage_boms'],
  }).currentUser;
  const operator = seedUser(fake, {
    id: 'u_operator',
    name: 'Operador',
    permissions: ['manufacturing.view', 'manufacturing.operate'],
  }).currentUser;
  const inspector = seedUser(fake, {
    id: 'u_inspector',
    name: 'Calidad',
    permissions: ['manufacturing.view', 'manufacturing.inspect'],
  }).currentUser;
  const approver = seedUser(fake, {
    id: 'u_approver',
    name: 'Jefa de planta',
    permissions: ['manufacturing.view', 'manufacturing.approve_incidents'],
  }).currentUser;
  const viewer = seedUser(fake, { id: 'u_viewer', name: 'Consulta', permissions: ['manufacturing.view'] }).currentUser;
  const stranger = seedUser(fake, { id: 'u_stranger', name: 'Sin permisos' }).currentUser;
  return { planner, operator, inspector, approver, viewer, stranger, byArea };
}

export function ensureWarehouse(fake: FakePrisma, id = WAREHOUSE_ID, key = 'principal'): Row {
  const existing = fake.rows('warehouse').find((row) => row.id === id);
  if (existing) return existing;
  return seedWarehouse(fake, { id, key, name: key === 'principal' ? 'Bodega principal' : key, zohoLocationId: key === 'principal' ? 'loc-1' : null }).warehouse;
}

export function seedWorkCenterRow(fake: FakePrisma, overrides: Row = {}): Row {
  return fake.seed('workCenter', {
    id: 'wc_corte',
    key: 'corte',
    name: 'Corte',
    warehouseId: null,
    capacityPerShift: D(100),
    capacityUnit: 'm2',
    shifts: [{ name: 'Matutino', start: '08:00', end: '16:00', days: [1, 2, 3, 4, 5, 6] }],
    status: 'active',
    ...overrides,
  });
}

export interface SeedMaterialInput {
  zohoItemId: string;
  quantity: number;
  unit?: string;
  confidence?: 'UNCOUNTED' | 'PROVISIONAL' | 'CONTROLLED' | 'DISPUTED';
  warehouseId?: string;
  name?: string;
  sku?: string | null;
  purchaseRate?: number | null;
  tolerancePct?: number;
}

/** Product, inventory profile and GENERAL stock row of a material. */
export function seedMaterial(fake: FakePrisma, input: SeedMaterialInput): { stockItem: Row; profile: Row; product: Row } {
  const warehouseId = input.warehouseId ?? WAREHOUSE_ID;
  ensureWarehouse(fake, warehouseId, warehouseId === WAREHOUSE_ID ? 'principal' : warehouseId.replace(/^wh_/, ''));
  const unit = input.unit ?? 'm2';
  let product = fake.rows('product').find((row) => row.zohoItemId === input.zohoItemId);
  if (!product) {
    product = fake.seed('product', {
      zohoItemId: input.zohoItemId,
      name: input.name ?? `Material ${input.zohoItemId}`,
      sku: input.sku === undefined ? input.zohoItemId.toUpperCase() : input.sku,
      unit,
      purchaseRate: input.purchaseRate === undefined || input.purchaseRate === null ? null : D(input.purchaseRate),
    });
  }
  let profile = fake.rows('productInventoryProfile').find((row) => row.zohoItemId === input.zohoItemId);
  if (!profile) {
    profile = seedProfile(fake, {
      zohoItemId: input.zohoItemId,
      baseUnit: unit,
      confidence: input.confidence ?? 'CONTROLLED',
      tolerancePct: input.tolerancePct ?? 2,
      lastCountAt: MFG_NOW,
    });
  }
  const stockItem = seedStockItem(fake, {
    zohoItemId: input.zohoItemId,
    warehouseId,
    locationId: `${warehouseId}_general`,
    baseline: input.quantity,
    lastCountedAt: MFG_NOW,
  });
  return { stockItem, profile, product };
}

export interface SeedAllocationInput {
  caseId?: string;
  zohoItemId: string;
  quantity: number;
  unit?: string;
  withRequest?: boolean;
  sourceSku?: string;
  targetSku?: string;
}

/** Case + demand + manufacture allocation (+ the engine's transformation request). */
export function seedManufactureAllocation(
  fake: FakePrisma,
  input: SeedAllocationInput
): { opCase: Row; demand: Row; allocation: Row; request: Row | null } {
  const caseId = input.caseId ?? 'case_1';
  const demand = seedDemand(fake, {
    caseId,
    zohoItemId: input.zohoItemId,
    quantity: input.quantity,
    unit: input.unit ?? 'm2',
    status: 'planned',
  });
  const opCase = fake.rows('operationalCase').find((row) => row.id === caseId) as Row;
  const allocationId = `alloc_${fake.rows('demandAllocation').length + 1}`;
  const requestId = `req_${fake.rows('areaRequest').length + 1}`;
  const allocation = fake.seed('demandAllocation', {
    id: allocationId,
    demandId: demand.id,
    caseId,
    source: 'manufacture',
    quantity: D(input.quantity),
    status: input.withRequest === false ? 'planned' : 'requested',
    linkedType: input.withRequest === false ? null : 'area_request',
    linkedId: input.withRequest === false ? null : requestId,
  });
  let request: Row | null = null;
  if (input.withRequest !== false) {
    request = fake.seed('areaRequest', {
      id: requestId,
      caseId,
      fromAreaKey: 'inventario',
      toAreaKey: 'manufactura',
      kind: 'transformation',
      objectType: 'demand_allocation',
      objectId: allocationId,
      title: `Producir ${input.quantity} ${input.unit ?? 'm2'}`,
      payload: {
        sourceSku: input.sourceSku ?? input.zohoItemId,
        targetSku: input.targetSku ?? input.zohoItemId,
        qty: input.quantity,
        unit: input.unit ?? 'm2',
        dueAt: '2026-09-20',
      },
      status: 'sent',
      dueAt: new Date('2026-09-20T00:00:00.000Z'),
      ownerUserId: 'u_manufactura',
      createdByType: 'system',
    });
  }
  return { opCase, demand, allocation, request };
}

export function makeManufacturingJob<P>(payload: P, id = 'job_1'): JobContext<P> {
  return {
    id,
    type: 'test',
    payload,
    attempt: 1,
    signal: new AbortController().signal,
    async setProgress() {},
    log() {},
  };
}
