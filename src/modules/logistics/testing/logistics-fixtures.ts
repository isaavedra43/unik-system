import { Prisma } from '@prisma/client';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { FakePrisma, Row } from '@/modules/comms/testing/fake-prisma';
import type { JobContext } from '@/modules/jobs/job-queue';
import {
  createOpsFake,
  seedAreas,
  seedResponsible,
  seedUser,
} from '@/modules/operations/testing/fixtures';

/**
 * Test fixtures of the logistics module on top of `createOpsFake()`: defaults,
 * relations and unique keys of Vehicle / Driver / DeliveryOrder / Trip /
 * TripStop / DeliveryEvidence / Package / ProductInventoryProfile as in
 * prisma/schema.prisma, plus a seeded case with two ready allocations.
 *
 * Pure test helper (no `@/lib/prisma`): import it from `vi.hoisted`.
 */

export const D = (value: number | string) => new Prisma.Decimal(value);

const nulls = (keys: string[]): Row => Object.fromEntries(keys.map((key) => [key, null]));

export function createLogisticsFake(): FakePrisma {
  return createOpsFake({
    defaults: {
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
      trip: () => ({ status: 'planned', startedAt: null, endedAt: null, notes: null, version: 1 }),
      tripStop: () => ({
        status: 'pending',
        etaAt: null,
        arrivedAt: null,
        departedAt: null,
        lat: null,
        lng: null,
      }),
      deliveryEvidence: () => ({
        storageObjectId: null,
        deliveredLines: null,
        note: null,
        lat: null,
        lng: null,
        commandId: null,
      }),
      vehicle: () => ({
        capacityKg: null,
        capacityM2: null,
        capacityPieces: null,
        maintenanceUntil: null,
        active: true,
      }),
      driver: () => ({ userId: null, phone: null, licenseNumber: null, active: true }),
      package: () => ({
        ...nulls([
          'packageNumber',
          'status',
          'date',
          'shipmentType',
          'carrier',
          'trackingNumber',
          'deliveryMethod',
          'shippingCharge',
          'zohoSalesOrderId',
          'zohoCustomerId',
          'customerName',
          'shippingAttention',
          'shippingAddress',
          'shippingCity',
          'shippingState',
          'shippingZip',
          'shippingCountry',
          'shippingPhone',
          'shipmentDate',
          'shipmentStatus',
          'zohoShipmentId',
          'shipmentNumber',
          'deliveryDate',
          'trackingUrl',
          'notes',
          'lastDetailFetchedAt',
        ]),
        sourceRemoteModifiedAt: new Date('2026-09-10T00:00:00.000Z'),
        sourceSnapshotId: 'snapshot_1',
        normalizedAt: new Date(),
      }),
      productInventoryProfile: () => ({
        conversions: [],
        tolerancePct: D(0),
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
      storageObject: () => ({
        status: 'ready',
        purpose: 'evidence',
        createdBy: null,
        deletedAt: null,
      }),
    },
    relations: {
      trip: { stops: { model: 'tripStop', childFk: 'tripId' } },
      tripStop: { trip: { model: 'trip', fk: 'tripId' } },
    },
    uniques: {
      vehicle: [['code']],
      driver: [['userId']],
      trip: [['number']],
      tripStop: [['tripId', 'deliveryOrderId']],
      package: [['zohoPackageId']],
      productInventoryProfile: [['zohoItemId']],
    },
  });
}

export const CASE_ID = 'case_1';
export const ZOHO_SALES_ORDER_ID = 'zso_1';

export interface LogisticsScenario {
  dispatcher: CurrentUser;
  driverUser: CurrentUser;
  caseId: string;
  allocationIds: [string, string];
}

export function seedDemandWithAllocation(
  fake: FakePrisma,
  input: {
    demandId: string;
    allocationId: string;
    lineRef: string;
    zohoItemId: string;
    sku: string;
    name: string;
    qty: number;
    unit: string;
    caseId?: string;
    status?: string;
  }
): { demand: Row; allocation: Row } {
  const caseId = input.caseId ?? CASE_ID;
  const demand = fake.seed('caseDemand', {
    id: input.demandId,
    caseId,
    lineRef: input.lineRef,
    zohoItemId: input.zohoItemId,
    sku: input.sku,
    name: input.name,
    quantity: D(input.qty),
    unit: input.unit,
    baseQuantity: D(input.qty),
    baseUnit: input.unit,
  });
  const allocation = fake.seed('demandAllocation', {
    id: input.allocationId,
    demandId: input.demandId,
    caseId,
    source: 'stock',
    quantity: D(input.qty),
    status: input.status ?? 'ready',
    warehouseId: 'wh_1',
  });
  return { demand, allocation };
}

/**
 * Areas, responsibles (ventas → u_sales, logistica → u_logistics,
 * administracion → u_admin), a dispatcher, a driver user and case EXP-000001
 * (sales order zso_1) with two ready allocations: 10 m² of PISO-60 and 20 pz
 * of ZOCLO.
 */
export function seedLogisticsBase(fake: FakePrisma): LogisticsScenario {
  seedAreas(fake);
  const dispatcher = seedUser(fake, {
    id: 'u_dispatch',
    name: 'Despacho',
    permissions: [
      'logistics.view',
      'logistics.dispatch',
      'logistics.zoho_write',
      'logistics.manage_fleet',
    ],
  }).currentUser;
  const driverUser = seedUser(fake, {
    id: 'u_driver',
    name: 'Chofer Pedro',
    permissions: ['logistics.drive'],
  }).currentUser;
  seedUser(fake, { id: 'u_sales', name: 'Ventas' });
  seedUser(fake, { id: 'u_logistics', name: 'Logística' });
  seedUser(fake, { id: 'u_admin', name: 'Administración' });
  seedResponsible(fake, { area: 'ventas', userId: 'u_sales' });
  seedResponsible(fake, { area: 'logistica', userId: 'u_logistics' });
  seedResponsible(fake, { area: 'administracion', userId: 'u_admin' });
  fake.seed('operationalCase', {
    id: CASE_ID,
    caseSeq: 1,
    caseNumber: 'EXP-000001',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: ZOHO_SALES_ORDER_ID,
    zohoSalesOrderId: ZOHO_SALES_ORDER_ID,
    salesOrderNumber: 'SO-00001',
    customerName: 'Constructora Uno',
    processVersionId: 'pv_1',
    ownerUserId: 'u_sales',
  });
  seedDemandWithAllocation(fake, {
    demandId: 'dem_1',
    allocationId: 'alloc_1',
    lineRef: 'li_1',
    zohoItemId: 'item_piso',
    sku: 'PISO-60',
    name: 'Piso 60x60',
    qty: 10,
    unit: 'm2',
  });
  seedDemandWithAllocation(fake, {
    demandId: 'dem_2',
    allocationId: 'alloc_2',
    lineRef: 'li_2',
    zohoItemId: 'item_zoclo',
    sku: 'ZOCLO',
    name: 'Zoclo',
    qty: 20,
    unit: 'pz',
  });
  return { dispatcher, driverUser, caseId: CASE_ID, allocationIds: ['alloc_1', 'alloc_2'] };
}

export function seedPackage(fake: FakePrisma, overrides: Row = {}): Row {
  const index = fake.rows('package').length + 1;
  return fake.seed('package', {
    id: `pkg_${index}`,
    zohoPackageId: `zpkg_${index}`,
    packageNumber: `PKG-000${index}`,
    status: 'not_shipped',
    zohoSalesOrderId: ZOHO_SALES_ORDER_ID,
    date: new Date(`2026-09-1${index}T00:00:00.000Z`),
    shippingAddress: 'Av. Reforma 100',
    shippingCity: 'Ciudad de México',
    shippingState: 'CDMX',
    shippingZip: '06600',
    shippingAttention: 'Juan Pérez',
    shippingPhone: '5555555555',
    ...overrides,
  });
}

/** Vehicle CAM-01 (1 000 kg, 100 pieces) and driver drv_1 linked to u_driver. */
export function seedFleet(fake: FakePrisma, vehicle: Row = {}): { vehicle: Row; driver: Row } {
  return {
    vehicle: fake.seed('vehicle', {
      id: 'veh_1',
      code: 'CAM-01',
      plate: 'ABC123',
      label: 'Camioneta 1',
      capacityKg: D(1000),
      capacityPieces: 100,
      ...vehicle,
    }),
    driver: fake.seed('driver', {
      id: 'drv_1',
      name: 'Pedro',
      userId: 'u_driver',
      phone: '5511111111',
    }),
  };
}

/** A storage object already uploaded to the `delivery_evidence` target of an order. */
export function seedEvidence(
  fake: FakePrisma,
  deliveryOrderId: string,
  input: { objectId: string; kind?: 'photo' | 'signature'; status?: string }
): Row {
  fake.seed('storageObject', {
    id: input.objectId,
    provider: 'disk',
    bucketAlias: 'files',
    objectKey: `evidence/${input.objectId}/v1`,
    versionId: 'v1',
    originalName: 'entrega.jpg',
    declaredMimeType: 'image/jpeg',
    status: input.status ?? 'ready',
    purpose: 'evidence',
    createdBy: 'u_driver',
  });
  return fake.seed('deliveryEvidence', {
    deliveryOrderId,
    kind: input.kind ?? 'photo',
    storageObjectId: input.objectId,
    createdBy: 'u_driver',
  });
}

export function makeJob<P>(payload: P, attempt = 1): JobContext<P> {
  return {
    id: `job_attempt_${attempt}`,
    type: 'test',
    payload,
    attempt,
    signal: new AbortController().signal,
    async setProgress() {},
    log() {},
  };
}
