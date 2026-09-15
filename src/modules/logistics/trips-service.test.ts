import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Trips, fleet availability and the driver read model on FakePrisma. */

const mocks = await vi.hoisted(async () => {
  const { createLogisticsFake } = await import('./testing/logistics-fixtures');
  return {
    fake: createLogisticsFake(),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async (channel: string, type: string, payload: unknown) => ({
      id: '1',
      channel,
      type,
      payload,
      createdAt: new Date().toISOString(),
    })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
}));

import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedUser } from '@/modules/operations/testing/fixtures';
import { getDriverToday } from './driver-service';
import { getFleetAvailability } from './fleet-service';
import {
  arriveStopCommand,
  buildTripCommand,
  closeTripCommand,
  completeStopCommand,
  createDeliveryOrderCommand,
  createVehicleCommand,
  failStopCommand,
  reorderStopsCommand,
  startTripCommand,
  updateVehicleCommand,
} from './logistics-commands';
import {
  D,
  seedEvidence,
  seedFleet,
  seedLogisticsBase,
  seedPackage,
  type LogisticsScenario,
} from './testing/logistics-fixtures';

const { fake } = mocks;
let scenario: LogisticsScenario;
let farOrderId: string;
let nearOrderId: string;

const ORIGIN = { lat: 19.4, lng: -99.1 };
const row = (model: string, id: string) => fake.rows(model).find((r) => r.id === id)!;
const eventsOf = (type: string) => fake.rows('operationalEvent').filter((e) => e.type === type);

async function createOwnFleetOrder(
  allocationId: string,
  coords: { lat: number; lng: number },
  commandId: string
) {
  const result = await createDeliveryOrderCommand(
    scenario.dispatcher,
    {
      caseId: scenario.caseId,
      allocationIds: [allocationId],
      mode: 'own_fleet',
      plannedDate: '2026-09-16',
      ...coords,
    },
    { commandId }
  );
  expect(result.status).toBe('completed');
  return result.data!.deliveryOrderId;
}

async function build(overrides: Record<string, unknown> = {}) {
  return buildTripCommand(
    scenario.dispatcher,
    {
      date: '2026-09-16',
      vehicleId: 'veh_1',
      driverId: 'drv_1',
      deliveryOrderIds: [farOrderId, nearOrderId],
      origin: ORIGIN,
      ...overrides,
    },
    { commandId: `cmd-build-${JSON.stringify(overrides).length}` }
  );
}

beforeEach(async () => {
  fake.tables.clear();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  scenario = seedLogisticsBase(fake);
  seedFleet(fake);
  // One Zoho package per delivery: its lines tell which order it belongs to.
  seedPackage(fake);
  seedPackage(fake);
  fake.seed('packageItem', { packageId: 'pkg_1', zohoItemId: 'item_piso', sortOrder: 0 });
  fake.seed('packageItem', { packageId: 'pkg_2', zohoItemId: 'item_zoclo', sortOrder: 0 });
  fake.seed('productInventoryProfile', {
    zohoItemId: 'item_piso',
    baseUnit: 'm2',
    weightKgPerBaseUnit: D(22),
    areaM2PerBaseUnit: D(1),
  });
  fake.seed('productInventoryProfile', {
    zohoItemId: 'item_zoclo',
    baseUnit: 'pz',
    weightKgPerBaseUnit: D(1.5),
  });
  farOrderId = await createOwnFleetOrder('alloc_1', { lat: 19.5, lng: -99.2 }, 'cmd-create-far');
  nearOrderId = await createOwnFleetOrder(
    'alloc_2',
    { lat: 19.41, lng: -99.11 },
    'cmd-create-near'
  );
});

describe('buildTrip', () => {
  it('rejects a load over the vehicle capacity', async () => {
    row('vehicle', 'veh_1').capacityKg = D(200);
    const result = await build();
    // 10 m² × 22 kg + 20 pz × 1.5 kg = 250 kg
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'capacity_exceeded' });
    expect(result.message).toBe('La carga de 250 kg supera la capacidad de 200 kg');
    expect(fake.rows('trip')).toHaveLength(0);
  });

  it('creates the trip with stops ordered by nearest neighbour and assigns vehicle and driver', async () => {
    const result = await build();
    expect(result.status).toBe('completed');
    expect(result.data).toMatchObject({ number: 'VJ-000001', load: { kg: 250, pieces: 21 } });
    expect(result.data!.stops.map((s) => s.deliveryOrderId)).toEqual([nearOrderId, farOrderId]);
    expect(result.data!.stops.every((s) => s.etaAt !== null)).toBe(true);
    const tripId = result.data!.tripId;
    expect(row('deliveryOrder', farOrderId)).toMatchObject({
      tripId,
      vehicleId: 'veh_1',
      driverId: 'drv_1',
    });
    expect(eventsOf('trip.built')).toHaveLength(1);

    const availability = await getFleetAvailability('2026-09-16');
    expect(availability.vehicles[0]).toMatchObject({
      code: 'CAM-01',
      available: false,
      reasons: ['busy'],
    });
    expect(availability.drivers[0]).toMatchObject({ available: false, busyTripIds: [tripId] });

    const second = await buildTripCommand(
      scenario.dispatcher,
      { date: '2026-09-16', vehicleId: 'veh_1', driverId: 'drv_1', deliveryOrderIds: [farOrderId] },
      { commandId: 'cmd-build-again' }
    );
    expect(second).toMatchObject({ status: 'rejected', errorCode: 'fleet_unavailable' });
  });
});

describe('trip execution', () => {
  it('start → arrive with GPS → complete with evidence → fail → close', async () => {
    const built = await build();
    const tripId = built.data!.tripId;
    const [nearStop, farStop] = built.data!.stops;

    const outsider = seedUser(fake, {
      id: 'u_other_driver',
      permissions: ['logistics.drive'],
    }).currentUser;
    expect(
      await startTripCommand(outsider, { tripId }, { commandId: 'cmd-start-outsider' })
    ).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });

    expect(
      (await startTripCommand(scenario.driverUser, { tripId }, { commandId: 'cmd-start' })).status
    ).toBe('completed');
    expect(row('trip', tripId)).toMatchObject({ status: 'en_route' });
    // Transport was never assigned: the loaded orders wait for Zoho with their shipment
    // write queued (vehicle and driver of the trip); nothing is confirmed by leaving.
    expect(row('deliveryOrder', nearOrderId)).toMatchObject({
      status: 'pending_external',
      zohoSyncState: 'pending_write',
      vehicleId: 'veh_1',
      driverId: 'drv_1',
    });
    expect(
      fake.rows('backgroundJob').filter((j) => j.type === 'ops.zoho.ship_package')
    ).toHaveLength(2);
    expect(eventsOf('zoho.shipment_queued')).toHaveLength(2);
    expect(eventsOf('delivery.dispatched')).toHaveLength(2);

    const arrived = await arriveStopCommand(
      scenario.driverUser,
      { tripId, stopId: nearStop.stopId, lat: 19.4101, lng: -99.1102 },
      { commandId: 'cmd-arrive' }
    );
    expect(arrived.data!.distanceFromDestinationKm).toBeLessThan(0.1);
    expect(row('tripStop', nearStop.stopId)).toMatchObject({ status: 'arrived' });

    const lines = [{ allocationId: 'alloc_2', deliveredQty: 20 }];
    const noEvidence = await completeStopCommand(
      scenario.driverUser,
      { tripId, stopId: nearStop.stopId, lines, receivedBy: 'Juan Pérez' },
      { commandId: 'cmd-complete-1' }
    );
    expect(noEvidence).toMatchObject({ status: 'rejected', errorCode: 'evidence_required' });
    expect(row('tripStop', nearStop.stopId)).toMatchObject({ status: 'arrived' });

    seedEvidence(fake, nearOrderId, { objectId: 'obj_near' });
    const completed = await completeStopCommand(
      scenario.driverUser,
      {
        tripId,
        stopId: nearStop.stopId,
        lines,
        receivedBy: 'Juan Pérez',
        evidenceObjectIds: ['obj_near'],
      },
      { commandId: 'cmd-complete-2' }
    );
    // Delivered; the Zoho write (shipment + delivered) is still owed, so the result waits for Zoho.
    expect(completed).toMatchObject({
      status: 'pending_external',
      data: { complete: true, status: 'delivered' },
    });
    expect(row('tripStop', nearStop.stopId)).toMatchObject({ status: 'done' });
    expect(row('deliveryOrder', nearOrderId)).toMatchObject({
      status: 'delivered',
      receivedBy: 'Juan Pérez',
    });

    expect(
      await closeTripCommand(scenario.driverUser, { tripId }, { commandId: 'cmd-close-early' })
    ).toMatchObject({ status: 'rejected', errorCode: 'stops_pending' });

    const failed = await failStopCommand(
      scenario.driverUser,
      { tripId, stopId: farStop.stopId, reason: 'Cliente ausente', lat: 19.5, lng: -99.2 },
      { commandId: 'cmd-fail' }
    );
    expect(failed.status).toBe('completed');
    expect(row('deliveryOrder', farOrderId)).toMatchObject({ status: 'failed', tripId: null });
    expect(row('workItem', failed.data!.workItemId)).toMatchObject({
      areaKey: 'logistica',
      status: 'open',
    });
    expect(row('areaRequest', failed.data!.areaRequestId)).toMatchObject({
      kind: 'customer_notice',
      toAreaKey: 'ventas',
    });

    const closed = await closeTripCommand(
      scenario.driverUser,
      { tripId },
      { commandId: 'cmd-close' }
    );
    expect(closed).toMatchObject({
      status: 'completed',
      data: { status: 'done', delivered: 1, failed: 1 },
    });
    expect(eventsOf('trip.closed')).toHaveLength(1);
  });

  it('a shipping delivery without its Zoho package never leaves', async () => {
    const built = await build();
    row('deliveryOrder', farOrderId).packageId = null;
    const started = await startTripCommand(
      scenario.driverUser,
      { tripId: built.data!.tripId },
      { commandId: 'cmd-start-no-package' }
    );
    expect(started).toMatchObject({ status: 'rejected', errorCode: 'package_missing' });
    expect(row('trip', built.data!.tripId)).toMatchObject({ status: 'planned' });
  });

  it('does not move visited stops when reordering', async () => {
    const built = await build();
    const tripId = built.data!.tripId;
    const [nearStop, farStop] = built.data!.stops;
    await startTripCommand(scenario.dispatcher, { tripId }, { commandId: 'cmd-start' });
    await arriveStopCommand(
      scenario.dispatcher,
      { tripId, stopId: nearStop.stopId },
      { commandId: 'cmd-arrive' }
    );

    const invalid = await reorderStopsCommand(
      scenario.dispatcher,
      { tripId, stopIds: [farStop.stopId, nearStop.stopId] },
      { commandId: 'cmd-reorder-bad' }
    );
    expect(invalid).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    const same = await reorderStopsCommand(
      scenario.dispatcher,
      { tripId, stopIds: [nearStop.stopId, farStop.stopId] },
      { commandId: 'cmd-reorder-ok' }
    );
    expect(same.status).toBe('completed');
  });
});

describe('driver read model', () => {
  it("returns today's trip of the driver linked to the user with lines, contact and upload targets", async () => {
    await build();
    const today = await getDriverToday(scenario.driverUser, { date: '2026-09-16' });
    expect(today.driver).toMatchObject({ id: 'drv_1', name: 'Pedro' });
    expect(today.trips).toHaveLength(1);
    const [first] = today.trips[0].stops;
    expect(first.deliveryOrder).toMatchObject({
      id: nearOrderId,
      caseNumber: 'EXP-000001',
      customerName: 'Constructora Uno',
      contact: { name: 'Juan Pérez', phone: '5555555555' },
      coordinates: { lat: 19.41, lng: -99.11 },
      lines: [{ allocationId: 'alloc_2', sku: 'ZOCLO', pendingQuantity: 20, unit: 'pz' }],
      evidenceUpload: {
        photo: { type: 'delivery_evidence', id: nearOrderId },
        signature: { type: 'delivery_evidence', id: `${nearOrderId}:signature` },
      },
    });
    expect(today.commands.complete).toBe('trip.complete_stop');

    const nobody = seedUser(fake, { id: 'u_nobody' }).currentUser;
    await expect(getDriverToday(nobody)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('fleet commands', () => {
  it('rejects duplicate codes and maintenance over active trips', async () => {
    const duplicate = await createVehicleCommand(
      scenario.dispatcher,
      { code: 'cam 01', plate: 'XYZ999', label: 'Otra' },
      { commandId: 'cmd-vehicle-dup' }
    );
    expect(duplicate).toMatchObject({ status: 'rejected', errorCode: 'duplicate_code' });

    const created = await createVehicleCommand(
      scenario.dispatcher,
      { code: 'cam 02', plate: 'xyz999', label: 'Camión 2', capacityKg: 3500 },
      { commandId: 'cmd-vehicle-new' }
    );
    expect(created).toMatchObject({
      status: 'completed',
      data: { code: 'CAM-02', plate: 'XYZ999', capacityKg: 3500 },
    });

    await build();
    const maintenance = await updateVehicleCommand(
      scenario.dispatcher,
      { vehicleId: 'veh_1', maintenanceUntil: '2026-09-20' },
      { commandId: 'cmd-maintenance' }
    );
    expect(maintenance).toMatchObject({ status: 'rejected', errorCode: 'in_use' });

    const driverOnly = await createVehicleCommand(
      scenario.driverUser,
      { code: 'cam 03', plate: 'AAA111', label: 'Sin permiso' },
      { commandId: 'cmd-vehicle-forbidden' }
    );
    expect(driverOnly).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });
});
