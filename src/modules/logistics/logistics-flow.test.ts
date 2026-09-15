import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Delivery orders + transport + Zoho jobs on FakePrisma with the package
 * shipping services mocked (plan section 9.1: `delivery-service` with
 * `shipPackage` mocked). The mocked `shipPackage` writes the package row the
 * way Zoho's read-back (or the local patch) would.
 */

const mocks = await vi.hoisted(async () => {
  const { createLogisticsFake } = await import('./testing/logistics-fixtures');
  return {
    fake: createLogisticsFake(),
    zoho: { mock: false },
    shipPackage: vi.fn(),
    markPackageDelivered: vi.fn(),
    cancelPackageShipment: vi.fn(),
    refreshPackageOnDemand: vi.fn(),
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
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/integrations/zoho/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/integrations/zoho/config')>()),
  isZohoBooksMockEnabled: () => mocks.zoho.mock,
}));
vi.mock('@/modules/integrations/zoho/packages-shipment-sweep', () => ({
  refreshPackageOnDemand: mocks.refreshPackageOnDemand,
}));
vi.mock('@/modules/packages/packages-shipping-service', () => {
  class PackageShippingError extends Error {
    readonly status: number;
    readonly upstreamStatus?: number;
    constructor(message: string, status = 400, upstreamStatus?: number) {
      super(message);
      this.name = 'PackageShippingError';
      this.status = status;
      this.upstreamStatus = upstreamStatus;
    }
  }
  return {
    PackageShippingError,
    shipPackage: mocks.shipPackage,
    markPackageDelivered: mocks.markPackageDelivered,
    cancelPackageShipment: mocks.cancelPackageShipment,
  };
});

import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { PackageShippingError } from '@/modules/packages/packages-shipping-service';
import {
  assignTransportCommand,
  cancelDeliveryOrderCommand,
  createDeliveryOrderCommand,
  recordDeliveryCommand,
} from './logistics-commands';
import {
  isPermanentZohoError,
  runCancelShipmentJob,
  runMarkDeliveredJob,
  runShipPackageJob,
  runZohoReconcile,
} from './logistics-jobs';
import { toShipmentReadback } from './transport-service';
import { completeWorkItem } from '@/modules/operations/work-items-service';
import {
  makeJob,
  seedEvidence,
  seedLogisticsBase,
  seedPackage,
  type LogisticsScenario,
} from './testing/logistics-fixtures';

const { fake } = mocks;
let scenario: LogisticsScenario;

const HANDLERS: Record<string, (job: ReturnType<typeof makeJob>) => Promise<unknown>> = {
  'ops.zoho.ship_package': (job) => runShipPackageJob(job as never),
  'ops.zoho.mark_delivered': (job) => runMarkDeliveredJob(job as never),
  'ops.zoho.cancel_shipment': (job) => runCancelShipmentJob(job as never),
};

const order = (id: string) => fake.rows('deliveryOrder').find((row) => row.id === id)!;
const jobsOf = (type: string) => fake.rows('backgroundJob').filter((job) => job.type === type);
const eventsOf = (type: string) =>
  fake.rows('operationalEvent').filter((event) => event.type === type);
const incidentsOf = (kind: string) =>
  fake.rows('incident').filter((incident) => incident.kind === kind);
const allocation = (id: string) => fake.rows('demandAllocation').find((row) => row.id === id)!;

/** Runs the pending job of a type like the worker: on success it completes and frees the dedupe key. */
async function runPending(type: string, attempt = 1) {
  const job = fake
    .rows('backgroundJob')
    .find((row) => row.type === type && row.status === 'pending');
  if (!job) throw new Error(`No pending job ${type}`);
  const result = await HANDLERS[type](makeJob(job.payload, attempt));
  Object.assign(job, { status: 'completed', dedupeKey: null, result });
  return result;
}

/** What Zoho keeps after the write; `refreshed: false` simulates the local patch (API budget). */
function zohoStores(
  values: { carrier?: string; trackingNumber?: string | null; refreshed?: boolean } = {}
) {
  mocks.shipPackage.mockImplementation(
    async (
      _actor: { id: string },
      packageId: string,
      input: { carrier: string; date: string; trackingNumber?: string; delivered?: boolean }
    ) => {
      const pkg = fake.rows('package').find((row) => row.id === packageId)!;
      Object.assign(pkg, {
        carrier: values.carrier ?? input.carrier,
        deliveryMethod: values.carrier ?? input.carrier,
        shipmentDate: new Date(`${input.date}T00:00:00.000Z`),
        trackingNumber:
          values.trackingNumber !== undefined
            ? values.trackingNumber
            : input.trackingNumber || null,
        zohoShipmentId: pkg.zohoShipmentId ?? 'zship_1',
        shipmentNumber: pkg.shipmentNumber ?? 'NE-28815',
        status: input.delivered ? 'delivered' : 'shipped',
        lastDetailFetchedAt: values.refreshed === false ? null : new Date(),
      });
      return { id: packageId };
    }
  );
}

async function createOrder(options: { withPackage?: boolean } = {}): Promise<string> {
  if (options.withPackage !== false) seedPackage(fake);
  const result = await createDeliveryOrderCommand(
    scenario.dispatcher,
    {
      caseId: scenario.caseId,
      allocationIds: scenario.allocationIds,
      mode: 'carrier',
      plannedDate: '2026-09-16',
    },
    { commandId: 'cmd-create' }
  );
  expect(result.status).toBe('completed');
  return result.data!.deliveryOrderId;
}

const transport = (deliveryOrderId: string) => ({
  deliveryOrderId,
  carrier: 'Paquetexpress',
  date: '2026-09-16',
  trackingNumber: 'PX123',
});

async function assignAndShip(deliveryOrderId: string) {
  const result = await assignTransportCommand(scenario.dispatcher, transport(deliveryOrderId), {
    commandId: 'cmd-assign-1',
  });
  expect(result.status).toBe('pending_external');
  zohoStores();
  await runPending('ops.zoho.ship_package');
}

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  mocks.zoho.mock = false;
  invalidateOperationsConfigCache();
  scenario = seedLogisticsBase(fake);
});

describe('createDeliveryOrder', () => {
  it('links the free Zoho package of the sales order and plans the delivery', async () => {
    const id = await createOrder();
    expect(order(id)).toMatchObject({
      caseId: 'case_1',
      status: 'planned',
      packageId: 'pkg_1',
      zohoPackageId: 'zpkg_1',
      addressLine: 'Av. Reforma 100',
      contactName: 'Juan Pérez',
      zohoSyncState: 'not_required',
    });
    expect(eventsOf('delivery.planned')).toHaveLength(1);
    expect(fake.rows('areaRequest')).toHaveLength(0);
  });

  it('without a package asks Ventas for it (blocking) and links it when the package appears in Zoho', async () => {
    const id = await createOrder({ withPackage: false });
    expect(order(id)).toMatchObject({ status: 'pending', packageId: null });
    const [request] = fake.rows('areaRequest');
    expect(request).toMatchObject({
      kind: 'create_package_in_zoho',
      fromAreaKey: 'logistica',
      toAreaKey: 'ventas',
      blocksDelivery: true,
      status: 'sent',
      objectType: 'delivery_order',
      objectId: id,
      ownerUserId: 'u_sales',
    });
    expect((request.payload as { lines: unknown[] }).lines).toHaveLength(2);

    const blocked = await assignTransportCommand(scenario.dispatcher, transport(id), {
      commandId: 'cmd-assign-x',
    });
    expect(blocked).toMatchObject({ status: 'rejected', errorCode: 'package_missing' });

    seedPackage(fake);
    const summary = await runZohoReconcile(null);
    expect(summary.linked).toBe(1);
    expect(order(id)).toMatchObject({ status: 'planned', packageId: 'pkg_1' });
    expect(fake.rows('areaRequest')[0]).toMatchObject({ status: 'resolved' });
    const requestWork = fake.rows('workItem').find((w) => w.objectType === 'area_request');
    expect(requestWork).toMatchObject({ status: 'done' });
    expect(eventsOf('delivery.package_linked')).toHaveLength(1);
  });

  it('with split deliveries each order links the package whose lines are its items', async () => {
    seedPackage(fake); // pkg_1: item_zoclo
    seedPackage(fake); // pkg_2: item_piso
    fake.seed('packageItem', { packageId: 'pkg_1', zohoItemId: 'item_zoclo', sortOrder: 0 });
    fake.seed('packageItem', { packageId: 'pkg_2', zohoItemId: 'item_piso', sortOrder: 0 });
    const floor = await createDeliveryOrderCommand(
      scenario.dispatcher,
      { caseId: scenario.caseId, allocationIds: ['alloc_1'], mode: 'carrier' },
      { commandId: 'cmd-create-floor' }
    );
    const trim = await createDeliveryOrderCommand(
      scenario.dispatcher,
      { caseId: scenario.caseId, allocationIds: ['alloc_2'], mode: 'carrier' },
      { commandId: 'cmd-create-trim' }
    );
    expect(order(floor.data!.deliveryOrderId)).toMatchObject({ packageId: 'pkg_2' });
    expect(order(trim.data!.deliveryOrderId)).toMatchObject({ packageId: 'pkg_1' });
  });

  it('never links by date when the lines of the packages do not tell which order they belong to', async () => {
    seedPackage(fake);
    seedPackage(fake);
    const first = await createDeliveryOrderCommand(
      scenario.dispatcher,
      { caseId: scenario.caseId, allocationIds: ['alloc_1'], mode: 'carrier' },
      { commandId: 'cmd-create-first' }
    );
    expect(order(first.data!.deliveryOrderId)).toMatchObject({
      status: 'pending',
      packageId: null,
    });
    expect(fake.rows('areaRequest')[0]).toMatchObject({ kind: 'create_package_in_zoho' });
  });

  it('rejects allocations already in another open delivery', async () => {
    await createOrder();
    const again = await createDeliveryOrderCommand(
      scenario.dispatcher,
      { caseId: scenario.caseId, allocationIds: ['alloc_2'], mode: 'carrier' },
      { commandId: 'cmd-create-2' }
    );
    expect(again).toMatchObject({ status: 'rejected', errorCode: 'allocation_in_delivery' });
  });
});

describe('assignTransport + ops.zoho.ship_package', () => {
  it('assigning twice does not duplicate the Zoho write (replay, same content, re-delivered job)', async () => {
    const id = await createOrder();
    const first = await assignTransportCommand(scenario.dispatcher, transport(id), {
      commandId: 'cmd-assign-1',
    });
    expect(first).toMatchObject({ status: 'pending_external', externalSyncStatus: 'queued' });
    const replay = await assignTransportCommand(scenario.dispatcher, transport(id), {
      commandId: 'cmd-assign-1',
    });
    expect(replay).toMatchObject({ replayed: true, status: 'pending_external' });
    const sameContent = await assignTransportCommand(scenario.dispatcher, transport(id), {
      commandId: 'cmd-assign-2',
    });
    expect(sameContent.data).toMatchObject({ unchanged: true });

    const shipJobs = jobsOf('ops.zoho.ship_package');
    expect(shipJobs).toHaveLength(1);
    expect(shipJobs[0]).toMatchObject({
      dedupeKey: `zoho:ship:${id}:2`,
      groupKey: 'case:case_1',
      maxAttempts: 5,
      payload: { deliveryOrderId: id, requestKey: `zoho:ship:${id}:2` },
    });
    expect(order(id)).toMatchObject({ status: 'pending_external', zohoSyncState: 'pending_write' });

    zohoStores();
    const payload = shipJobs[0].payload;
    await runShipPackageJob(makeJob(payload as never));
    // The same job delivered again (e.g. a worker crash after the write) does nothing.
    expect(await runShipPackageJob(makeJob(payload as never))).toEqual({
      skipped: 'state:readback_ok',
    });
    expect(mocks.shipPackage).toHaveBeenCalledTimes(1);
    expect(mocks.shipPackage).toHaveBeenCalledWith({ id: 'u_dispatch' }, 'pkg_1', {
      carrier: 'Paquetexpress',
      date: '2026-09-16',
      trackingNumber: 'PX123',
    });
  });

  it('equal read-back → assigned, zoho.shipment_confirmed and EvidenceLink zoho_readback', async () => {
    const id = await createOrder();
    await assignAndShip(id);
    expect(order(id)).toMatchObject({
      status: 'assigned',
      zohoSyncState: 'readback_ok',
      zohoShipmentId: 'zship_1',
      carrier: 'Paquetexpress',
    });
    expect(eventsOf('zoho.shipment_confirmed')).toHaveLength(1);
    expect(
      fake.rows('evidenceLink').filter((e) => e.kind === 'zoho_readback' && e.objectId === id)
    ).toHaveLength(1);
    expect(fake.rows('incident')).toHaveLength(0);
  });

  it('different read-back → conflict adopting Zoho values, zoho_conflict incident and work item; a new write closes it', async () => {
    const id = await createOrder();
    await assignTransportCommand(scenario.dispatcher, transport(id), { commandId: 'cmd-assign-1' });
    zohoStores({ carrier: 'DHL Express', trackingNumber: 'DHL999' });
    await runPending('ops.zoho.ship_package');

    const row = order(id);
    expect(row).toMatchObject({
      status: 'conflict',
      zohoSyncState: 'readback_mismatch',
      carrier: 'DHL Express',
    });
    expect(
      (row.conflictDetail as { differences: Array<{ field: string }> }).differences.map(
        (d) => d.field
      )
    ).toEqual(['carrier', 'trackingNumber']);
    expect(incidentsOf('zoho_conflict')).toMatchObject([
      { areaKey: 'logistica', severity: 'medium', status: 'open' },
    ]);
    const decision = fake
      .rows('workItem')
      .find((w) => w.kind === 'external_sync' && w.objectId === id);
    expect(decision).toMatchObject({
      areaKey: 'logistica',
      status: 'open',
      ownerUserId: 'u_logistics',
    });
    expect(eventsOf('zoho.shipment_conflict')).toHaveLength(1);

    const rewrite = await assignTransportCommand(scenario.dispatcher, transport(id), {
      commandId: 'cmd-assign-3',
    });
    expect(rewrite.status).toBe('pending_external');
    expect(decision).toMatchObject({ status: 'done' });
    expect(jobsOf('ops.zoho.ship_package').filter((j) => j.status === 'pending')).toHaveLength(1);
  });

  it('closing the conflict decision accepts Zoho values: confirmed, incident resolved, no more re-reads', async () => {
    const id = await createOrder();
    await assignTransportCommand(scenario.dispatcher, transport(id), { commandId: 'cmd-assign-1' });
    zohoStores({ carrier: 'DHL Express', trackingNumber: 'DHL999' });
    await runPending('ops.zoho.ship_package');
    const decision = fake
      .rows('workItem')
      .find((w) => w.kind === 'external_sync' && w.objectId === id)!;

    // The sweep does not re-run the reconciliation while Zoho keeps the same values.
    mocks.refreshPackageOnDemand.mockResolvedValue({ status: 'refreshed', at: new Date() });
    const versionBefore = order(id).version;
    const sweep = await runZohoReconcile(null);
    expect(sweep).toMatchObject({ reread: 1, conflicts: 0, errors: 0 });
    expect(order(id).version).toBe(versionBefore);

    const logistics = { ...scenario.dispatcher, id: 'u_logistics' };
    const closed = await completeWorkItem(logistics, decision.id as string, {
      result: { resolution: 'Se quedan los datos de Zoho' },
    });
    expect(closed.status).toBe('completed');
    expect(order(id)).toMatchObject({
      status: 'assigned',
      zohoSyncState: 'readback_ok',
      carrier: 'DHL Express',
    });
    expect(order(id).shipmentInput).toMatchObject({
      carrier: 'DHL Express',
      trackingNumber: 'DHL999',
    });
    expect(incidentsOf('zoho_conflict')).toMatchObject([{ status: 'resolved' }]);
    expect(eventsOf('zoho.shipment_confirmed')).toHaveLength(1);
  });

  it('a later write waits while an older write of the same case is still running in Zoho', async () => {
    const id = await createOrder();
    await assignTransportCommand(scenario.dispatcher, transport(id), { commandId: 'cmd-assign-1' });
    const pending = jobsOf('ops.zoho.ship_package')[0];
    Object.assign(pending, { id: 'job_attempt_1', status: 'running', createdAt: new Date() });
    fake.seed('backgroundJob', {
      id: 'job_older',
      type: 'ops.zoho.ship_package',
      payload: { deliveryOrderId: id, requestKey: 'zoho:ship:old' },
      status: 'running',
      groupKey: 'case:case_1',
      createdAt: new Date(Date.now() - 60_000),
    });
    zohoStores();
    await expect(runShipPackageJob(makeJob(pending.payload as never, 1))).rejects.toThrow(
      'sigue en curso'
    );
    expect(mocks.shipPackage).not.toHaveBeenCalled();
  });

  it('a stop the driver failed stays failed when the sweep confirms the shipment', async () => {
    const id = await createOrder();
    await assignTransportCommand(scenario.dispatcher, transport(id), { commandId: 'cmd-assign-1' });
    zohoStores({ refreshed: false });
    await runPending('ops.zoho.ship_package');
    Object.assign(order(id), { status: 'failed', tripId: null }); // failStop
    mocks.refreshPackageOnDemand.mockImplementation(async (packageId: string) => {
      fake.rows('package').find((p) => p.id === packageId)!.lastDetailFetchedAt = new Date();
      return { status: 'refreshed', at: new Date() };
    });
    await runZohoReconcile(null);
    expect(order(id)).toMatchObject({ status: 'failed', zohoSyncState: 'readback_ok' });
  });

  it('local patch by API budget keeps pending_external until the sweep re-reads Zoho', async () => {
    const id = await createOrder();
    await assignTransportCommand(scenario.dispatcher, transport(id), { commandId: 'cmd-assign-1' });
    zohoStores({ refreshed: false });
    await runPending('ops.zoho.ship_package');
    expect(order(id)).toMatchObject({ status: 'pending_external', zohoSyncState: 'written' });
    expect(eventsOf('zoho.shipment_confirmed')).toHaveLength(0);

    mocks.refreshPackageOnDemand.mockImplementation(async (packageId: string) => {
      const pkg = fake.rows('package').find((p) => p.id === packageId)!;
      pkg.lastDetailFetchedAt = new Date();
      return { status: 'refreshed', at: new Date() };
    });
    const summary = await runZohoReconcile(null);
    expect(mocks.refreshPackageOnDemand).toHaveBeenCalledWith('pkg_1', { force: true });
    expect(summary).toMatchObject({ reread: 1, confirmed: 1 });
    expect(order(id)).toMatchObject({ status: 'assigned', zohoSyncState: 'readback_ok' });
  });

  it('exhausted retries → failed, zoho_failure incident and work item to Logística', async () => {
    const id = await createOrder();
    await assignTransportCommand(scenario.dispatcher, transport(id), { commandId: 'cmd-assign-1' });
    mocks.shipPackage.mockRejectedValue(
      new PackageShippingError(
        'No se pudo crear la orden de envío en Zoho: tiempo de espera agotado',
        502
      )
    );
    const payload = jobsOf('ops.zoho.ship_package')[0].payload;
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(runShipPackageJob(makeJob(payload as never, attempt))).rejects.toThrow(
        'tiempo de espera'
      );
      expect(order(id)).toMatchObject({
        status: 'pending_external',
        zohoSyncState: 'pending_write',
      });
    }
    expect(order(id).zohoError).toContain('tiempo de espera');

    await expect(runShipPackageJob(makeJob(payload as never, 5))).rejects.toThrow(
      'tiempo de espera'
    );
    expect(order(id)).toMatchObject({ status: 'failed', zohoSyncState: 'failed' });
    expect(incidentsOf('zoho_failure')).toMatchObject([{ severity: 'high', areaKey: 'logistica' }]);
    expect(
      fake.rows('workItem').filter((w) => w.kind === 'external_sync' && w.objectId === id)
    ).toHaveLength(1);
    expect(eventsOf('zoho.shipment_failed')).toHaveLength(1);
    expect(mocks.shipPackage).toHaveBeenCalledTimes(5);
  });

  it('a permanent shipping error fails on the first attempt', async () => {
    const id = await createOrder();
    await assignTransportCommand(scenario.dispatcher, transport(id), { commandId: 'cmd-assign-1' });
    mocks.shipPackage.mockRejectedValue(new PackageShippingError('Paquete no encontrado', 404));
    const result = await runShipPackageJob(
      makeJob(jobsOf('ops.zoho.ship_package')[0].payload as never, 1)
    );
    expect(result).toMatchObject({ failed: true, permanent: true });
    expect(order(id)).toMatchObject({ status: 'failed', zohoSyncState: 'failed' });
  });

  it('a 4xx rejection of Zoho is permanent (no retries); timeouts and rate limits are not', () => {
    expect(isPermanentZohoError(new PackageShippingError('Ya enviado', 502, 400))).toBe(true);
    expect(isPermanentZohoError(new PackageShippingError('No existe', 502, 404))).toBe(true);
    expect(isPermanentZohoError(new PackageShippingError('Límite', 502, 429))).toBe(false);
    expect(isPermanentZohoError(new PackageShippingError('Sesión', 502, 401))).toBe(false);
    expect(isPermanentZohoError(new PackageShippingError('Caído', 502, 503))).toBe(false);
    expect(isPermanentZohoError(new PackageShippingError('Red', 502))).toBe(false);
  });

  it('compares the carrier UNIK wrote (delivery_method) even when the package has another carrier', () => {
    const pkg = {
      carrier: 'Estafeta',
      deliveryMethod: 'Paquetexpress',
      shipmentDate: new Date('2026-09-16T00:00:00.000Z'),
      trackingNumber: 'PX123',
      zohoShipmentId: 'zship_1',
      shipmentNumber: 'NE-1',
      status: 'shipped',
    };
    expect(toShipmentReadback(pkg, 'Paquetexpress').carrier).toBe('Paquetexpress');
    expect(toShipmentReadback(pkg, 'Estafeta').carrier).toBe('Estafeta');
    expect(toShipmentReadback(pkg).carrier).toBe('Paquetexpress');
  });

  it('requires logistics.zoho_write to ship', async () => {
    const id = await createOrder();
    const planner = { ...scenario.dispatcher, permissionKeys: ['logistics.dispatch'] };
    const result = await assignTransportCommand(planner, transport(id), {
      commandId: 'cmd-assign-noperm',
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    expect(jobsOf('ops.zoho.ship_package')).toHaveLength(0);
  });
});

describe('recordDelivery', () => {
  it('a delivery without evidence stays open', async () => {
    const id = await createOrder();
    const lines = [
      { allocationId: 'alloc_1', deliveredQty: 10 },
      { allocationId: 'alloc_2', deliveredQty: 20 },
    ];
    const withoutEvidence = await recordDeliveryCommand(
      scenario.dispatcher,
      { deliveryOrderId: id, lines, receivedBy: 'Juan Pérez' },
      { commandId: 'cmd-record-1' }
    );
    expect(withoutEvidence).toMatchObject({ status: 'rejected', errorCode: 'evidence_required' });

    // An upload that has not finished does not count either.
    seedEvidence(fake, id, { objectId: 'obj_pending', status: 'uploading' });
    const unfinished = await recordDeliveryCommand(
      scenario.dispatcher,
      { deliveryOrderId: id, lines, receivedBy: 'Juan Pérez', evidenceObjectIds: ['obj_pending'] },
      { commandId: 'cmd-record-2' }
    );
    expect(unfinished).toMatchObject({ status: 'rejected', errorCode: 'evidence_required' });

    expect(order(id)).toMatchObject({ status: 'planned', deliveredAt: null });
    expect(allocation('alloc_1')).toMatchObject({ status: 'ready' });
    expect(fake.rows('deliveryEvidence').filter((e) => e.kind === 'qty_confirmation')).toHaveLength(
      0
    );
    expect(jobsOf('ops.zoho.mark_delivered')).toHaveLength(0);
  });

  it('a shipping delivery without its Zoho package cannot be recorded', async () => {
    const id = await createOrder({ withPackage: false });
    seedEvidence(fake, id, { objectId: 'obj_photo' });
    const result = await recordDeliveryCommand(
      scenario.dispatcher,
      {
        deliveryOrderId: id,
        lines: [
          { allocationId: 'alloc_1', deliveredQty: 10 },
          { allocationId: 'alloc_2', deliveredQty: 20 },
        ],
        receivedBy: 'Juan Pérez',
        evidenceObjectIds: ['obj_photo'],
      },
      { commandId: 'cmd-record-no-package' }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'package_missing' });
    expect(order(id)).toMatchObject({ status: 'pending', deliveredAt: null });
  });

  it('only evidence of this attempt counts: a photo from before a failed stop does not close it', async () => {
    const id = await createOrder();
    seedEvidence(fake, id, { objectId: 'obj_gate' });
    fake.seed('tripStop', {
      tripId: 'trip_old',
      deliveryOrderId: id,
      sequence: 1,
      status: 'failed',
      departedAt: new Date(Date.now() + 60_000),
    });
    const lines = [
      { allocationId: 'alloc_1', deliveredQty: 10 },
      { allocationId: 'alloc_2', deliveredQty: 20 },
    ];
    const stale = await recordDeliveryCommand(
      scenario.dispatcher,
      { deliveryOrderId: id, lines, receivedBy: 'Juan Pérez', evidenceObjectIds: [] },
      { commandId: 'cmd-record-stale' }
    );
    expect(stale).toMatchObject({ status: 'rejected', errorCode: 'evidence_required' });

    const listed = await recordDeliveryCommand(
      scenario.dispatcher,
      { deliveryOrderId: id, lines, receivedBy: 'Juan Pérez', evidenceObjectIds: ['obj_gate'] },
      { commandId: 'cmd-record-listed' }
    );
    expect(listed.data).toMatchObject({ status: 'delivered' });
  });

  it('a short delivery reopens the remainder: child order, partial_delivery incident, work item to Ventas', async () => {
    const id = await createOrder();
    seedEvidence(fake, id, { objectId: 'obj_photo' });
    const result = await recordDeliveryCommand(
      scenario.dispatcher,
      {
        deliveryOrderId: id,
        lines: [
          { allocationId: 'alloc_1', deliveredQty: 10 },
          { allocationId: 'alloc_2', deliveredQty: 15 },
        ],
        receivedBy: 'Juan Pérez',
        evidenceObjectIds: ['obj_photo'],
        partialReason: 'Faltó zoclo en la carga',
      },
      { commandId: 'cmd-record-partial' }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { complete: false, totalDelivered: 25, totalShort: 5 },
    });
    const childId = result.data!.childDeliveryOrderId!;

    expect(order(id)).toMatchObject({
      status: 'partially_delivered',
      receivedBy: 'Juan Pérez',
      partialReason: 'Faltó zoclo en la carga',
    });
    expect(allocation('alloc_1')).toMatchObject({ status: 'delivered' });
    expect(Number(allocation('alloc_1').deliveredQuantity)).toBe(10);
    expect(allocation('alloc_2')).toMatchObject({ status: 'reopened' });
    expect(Number(allocation('alloc_2').deliveredQuantity)).toBe(15);
    expect(eventsOf('allocation.reopened')).toMatchObject([
      { payload: { allocationId: 'alloc_2', remainingQty: 5 } },
    ]);
    expect(order(childId)).toMatchObject({
      status: 'pending',
      allocationIds: ['alloc_2'],
      parentDeliveryOrderId: id,
      addressLine: 'Av. Reforma 100',
    });
    expect(incidentsOf('partial_delivery')).toMatchObject([
      { severity: 'low', areaKey: 'logistica' },
    ]);
    const remainder = fake
      .rows('workItem')
      .find((w) => w.areaKey === 'ventas' && w.objectId === childId);
    expect(remainder).toMatchObject({ status: 'open', ownerUserId: 'u_sales' });
    expect(remainder!.title).toContain('Decidir remanente');
    expect(fake.rows('caseDemand').find((d) => d.id === 'dem_1')).toMatchObject({
      status: 'fulfilled',
    });
    expect(Number(fake.rows('caseDemand').find((d) => d.id === 'dem_2')!.fulfilledQuantity)).toBe(
      15
    );
    expect(eventsOf('delivery.partial')).toHaveLength(1);

    // The remaining 5 pz are what the child order still owes.
    const replay = await recordDeliveryCommand(
      scenario.dispatcher,
      {
        deliveryOrderId: id,
        lines: [
          { allocationId: 'alloc_1', deliveredQty: 10 },
          { allocationId: 'alloc_2', deliveredQty: 15 },
        ],
        receivedBy: 'Juan Pérez',
        evidenceObjectIds: ['obj_photo'],
        partialReason: 'Faltó zoclo en la carga',
      },
      { commandId: 'cmd-record-partial' }
    );
    expect(replay.replayed).toBe(true);
    expect(fake.rows('deliveryOrder').filter((o) => o.parentDeliveryOrderId === id)).toHaveLength(
      1
    );
  });

  it('a complete delivery closes the order and marks it delivered in Zoho through the outbox', async () => {
    const id = await createOrder();
    await assignAndShip(id);
    seedEvidence(fake, id, { objectId: 'obj_signature', kind: 'signature' });
    const result = await recordDeliveryCommand(
      scenario.dispatcher,
      {
        deliveryOrderId: id,
        lines: [
          { allocationId: 'alloc_1', deliveredQty: 10 },
          { allocationId: 'alloc_2', deliveredQty: 20 },
        ],
        receivedBy: 'Juan Pérez',
        evidenceObjectIds: ['obj_signature'],
      },
      { commandId: 'cmd-record-full' }
    );
    expect(result).toMatchObject({
      status: 'pending_external',
      externalSyncStatus: 'queued',
      data: { complete: true },
    });
    expect(order(id)).toMatchObject({
      status: 'delivered',
      zohoSyncState: 'delivered_pending_write',
    });
    expect(jobsOf('ops.zoho.mark_delivered')).toMatchObject([
      { dedupeKey: `zoho:delivered:${id}`, maxAttempts: 5 },
    ]);
    expect(eventsOf('delivery.confirmed')).toHaveLength(1);

    mocks.markPackageDelivered.mockResolvedValue({ id: 'pkg_1' });
    await runPending('ops.zoho.mark_delivered');
    expect(mocks.markPackageDelivered).toHaveBeenCalledWith(
      { id: 'u_dispatch' },
      'pkg_1',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)
    );
    expect(order(id)).toMatchObject({ zohoSyncState: 'delivered_written' });
    expect(eventsOf('zoho.delivered_marked')).toHaveLength(1);
  });

  it('only the assigned driver or dispatch can record it', async () => {
    const id = await createOrder();
    seedEvidence(fake, id, { objectId: 'obj_photo' });
    const result = await recordDeliveryCommand(
      scenario.driverUser,
      {
        deliveryOrderId: id,
        lines: [{ allocationId: 'alloc_1', deliveredQty: 10 }],
        receivedBy: 'Juan Pérez',
        evidenceObjectIds: ['obj_photo'],
      },
      { commandId: 'cmd-record-driver' }
    );
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });
});

describe('cancelDeliveryOrder', () => {
  it('compensates a shipment UNIK wrote and closes what hung from the order', async () => {
    const id = await createOrder();
    await assignAndShip(id);
    const result = await cancelDeliveryOrderCommand(
      scenario.dispatcher,
      { deliveryOrderId: id, reason: 'El cliente canceló' },
      { commandId: 'cmd-cancel' }
    );
    expect(result).toMatchObject({ status: 'pending_external', data: { zohoCancelQueued: true } });
    expect(order(id)).toMatchObject({ status: 'cancelled', zohoSyncState: 'pending_write' });
    expect(jobsOf('ops.zoho.cancel_shipment')).toMatchObject([{ dedupeKey: `zoho:cancel:${id}` }]);

    mocks.cancelPackageShipment.mockResolvedValue({ id: 'pkg_1' });
    await runPending('ops.zoho.cancel_shipment');
    expect(mocks.cancelPackageShipment).toHaveBeenCalledWith({ id: 'u_dispatch' }, 'pkg_1');
    expect(order(id)).toMatchObject({ zohoSyncState: 'not_required', zohoShipmentId: null });
    expect(eventsOf('zoho.shipment_cancelled')).toHaveLength(1);
  });

  it('without a shipment it cancels locally and resolves nothing in Zoho', async () => {
    const id = await createOrder({ withPackage: false });
    const result = await cancelDeliveryOrderCommand(
      scenario.dispatcher,
      { deliveryOrderId: id, reason: 'Duplicada' },
      { commandId: 'cmd-cancel-local' }
    );
    expect(result).toMatchObject({ status: 'completed', data: { zohoCancelQueued: false } });
    expect(fake.rows('areaRequest')[0]).toMatchObject({ status: 'cancelled' });
    expect(jobsOf('ops.zoho.cancel_shipment')).toHaveLength(0);
  });
});
