import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  return {
    fake: createOpsFake(),
    notifyUser: vi.fn<(input: Record<string, unknown>) => Promise<Record<string, unknown>>>(
      async () => ({ id: 'n', inApp: true, push: false, suppressed: false })
    ),
    publishRealtime: vi.fn(async () => ({
      id: '1',
      channel: '',
      type: '',
      payload: {},
      createdAt: '',
    })),
    recordUsage: vi.fn(async () => undefined),
    expireDueLegacyClaims: vi.fn(async () => ({ checked: 0, expired: 0, rejected: 0 })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/extensions/usage-meter', () => ({ recordUsage: mocks.recordUsage }));
vi.mock('@/modules/inventory/inventory-commands', () => ({
  expireDueLegacyClaims: mocks.expireDueLegacyClaims,
}));

import { requireCommandContext } from './commands';
import { invalidateOperationsConfigCache, updateOperationsConfig } from './operations-config';
import { registerSupervisorCaseAdvancer, runSupervisorTick } from './supervisor';
import {
  RAW_NOT_HANDLED,
  addRawHandler,
  seedAreas,
  seedResponsible,
  seedUser,
} from './testing/fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const OPEN_CASE = ['open', 'waiting', 'blocked', 'ready_to_close'];
const OPEN_WORK = ['open', 'in_progress', 'waiting', 'escalated'];

// Emulates the two bounded SQL queries of the supervisor over the in-memory rows.
addRawHandler(fake, (query) => {
  const limitOf = () => Number(query.values[query.values.length - 1]);
  if (query.sql.includes('"lastWorkItemAt"')) {
    const cutoff = query.values.find((v): v is Date => v instanceof Date)!;
    return fake
      .rows('operationalCase')
      .filter(
        (c) =>
          OPEN_CASE.includes(c.status) &&
          c.lastActivityAt <= cutoff &&
          !fake.rows('workItem').some((w) => w.caseId === c.id && OPEN_WORK.includes(w.status)) &&
          !fake
            .rows('caseStep')
            .some((s) => s.caseId === c.id && ['active', 'waiting'].includes(s.status))
      )
      .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime())
      .slice(0, limitOf())
      .map((c) => {
        const updates = fake
          .rows('workItem')
          .filter((w) => w.caseId === c.id)
          .map((w) => w.updatedAt.getTime());
        return {
          id: c.id,
          version: c.version,
          lastActivityAt: c.lastActivityAt,
          lastWorkItemAt: updates.length ? new Date(Math.max(...updates)) : null,
        };
      });
  }
  if (query.sql.includes('JOIN "SalesOrder"')) {
    return fake
      .rows('operationalCase')
      .filter((c) => {
        if (!OPEN_CASE.includes(c.status)) return false;
        const so = fake.rows('salesOrder').find((o) => o.zohoSalesOrderId === c.zohoSalesOrderId);
        if (!so || so.invoicedStatus !== 'invoiced' || so.paidStatus !== 'paid') return false;
        return (
          c.status === 'ready_to_close' ||
          fake
            .rows('caseStep')
            .some(
              (s) =>
                s.caseId === c.id &&
                s.stepKey === 'cierre_financiero' &&
                ['ready', 'active', 'waiting'].includes(s.status)
            )
        );
      })
      .slice(0, limitOf())
      .map((c) => ({ id: c.id, version: c.version }));
  }
  return RAW_NOT_HANDLED;
});

const events = (type: string) => fake.rows('operationalEvent').filter((e) => e.type === type);
const row = (model: string, id: string) => fake.rows(model).find((r) => r.id === id)!;

function seedBase() {
  seedAreas(fake);
  fake.rows('area').find((a) => a.key === 'logistica')!.leadUserId = 'lead';
  for (const id of ['owner', 'backup', 'lead', 'admin', 'seller', 'seller_backup']) {
    seedUser(fake, { id, name: id });
  }
  seedResponsible(fake, { area: 'logistica', userId: 'owner', backupUserId: 'backup' });
  seedResponsible(fake, { area: 'administracion', userId: 'admin' });
  seedResponsible(fake, { area: 'ventas', userId: 'seller', backupUserId: 'seller_backup' });
}

function seedCase(overrides: Record<string, unknown> = {}) {
  return fake.seed('operationalCase', {
    id: 'case1',
    caseSeq: 1,
    caseNumber: 'EXP-000001',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so1',
    zohoSalesOrderId: 'so1',
    salesOrderNumber: 'SO-00001',
    customerName: 'Constructora Norte',
    processVersionId: 'pv1',
    ownerUserId: 'seller',
    openedAt: at(-90),
    lastActivityAt: at(-30),
    ...overrides,
  });
}

let unregisterAdvancer: (() => void) | null = null;

beforeEach(() => {
  fake.tables.clear();
  invalidateOperationsConfigCache();
  vi.clearAllMocks();
});

afterEach(() => {
  unregisterAdvancer?.();
  unregisterAdvancer = null;
});

describe('rule 1 — orphan cases', () => {
  it('reports an orphan case once, with an incident and a follow-up for Administración', async () => {
    seedBase();
    seedCase();

    const first = await runSupervisorTick({ now: NOW });
    expect(first.counters.orphanCases).toMatchObject({ checked: 1, actions: 1, incidents: 1 });
    const incident = fake.rows('incident').find((i) => i.kind === 'orphan_case')!;
    expect(incident).toMatchObject({
      dedupeKey: 'orphan_case:case1',
      areaKey: 'administracion',
      caseId: 'case1',
      severity: 'high',
      ownerUserId: 'admin',
    });
    expect(fake.rows('workItem')).toEqual([
      expect.objectContaining({
        areaKey: 'administracion',
        kind: 'incident_followup',
        caseId: 'case1',
        ownerUserId: 'admin',
        objectType: 'incident',
        objectId: incident.id,
      }),
    ]);
    expect(events('case.stuck')).toHaveLength(1);

    const second = await runSupervisorTick({ now: at(4) });
    expect(second.counters.orphanCases.checked).toBe(0);
    expect(fake.rows('incident')).toHaveLength(1);
    expect(fake.rows('workItem')).toHaveLength(1);
  });

  it('lets the case engine advance the case before reporting it', async () => {
    seedBase();
    seedCase();
    unregisterAdvancer = registerSupervisorCaseAdvancer(async (tx, caseId) => {
      await requireCommandContext(tx).createWorkItem({
        areaKey: 'logistica',
        kind: 'action',
        title: 'Planear entrega',
        caseId,
      });
    });

    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.counters.orphanCases).toMatchObject({ checked: 1, actions: 1, incidents: 0 });
    expect(fake.rows('incident')).toHaveLength(0);
    expect(fake.rows('workItem')).toEqual([
      expect.objectContaining({ caseId: 'case1', ownerUserId: 'owner', title: 'Planear entrega' }),
    ]);
  });

  it('leaves alone cases with pending work, explicit waits or recent activity', async () => {
    seedBase();
    seedCase({ id: 'busy', caseSeq: 1, caseNumber: 'EXP-1', sourceId: 'a' });
    fake.seed('workItem', {
      caseId: 'busy',
      areaKey: 'ventas',
      kind: 'action',
      title: 'Plan',
      ownerUserId: 'seller',
      dueAt: at(60),
    });
    seedCase({ id: 'waiting', caseSeq: 2, caseNumber: 'EXP-2', sourceId: 'b' });
    fake.seed('caseStep', {
      caseId: 'waiting',
      processVersionId: 'pv1',
      stepKey: 'asignar_transporte',
      areaKey: 'logistica',
      kind: 'external_sync',
      status: 'waiting',
    });
    seedCase({ id: 'fresh', caseSeq: 3, caseNumber: 'EXP-3', sourceId: 'c', lastActivityAt: NOW });

    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.counters.orphanCases.checked).toBe(0);
    expect(fake.rows('incident')).toHaveLength(0);
  });
});

describe('rule 2 — overdue work items', () => {
  it('climbs the ladder one level per threshold and opens the SLA incident at the end', async () => {
    seedBase();
    seedCase();
    fake.seed('workItem', {
      id: 'wi1',
      caseId: 'case1',
      areaKey: 'logistica',
      kind: 'action',
      title: 'Planear entrega',
      ownerUserId: 'owner',
      backupUserId: 'backup',
      dueAt: at(-10),
    });

    const first = await runSupervisorTick({ now: NOW });
    expect(first.counters.overdueWorkItems).toMatchObject({ checked: 1, actions: 1 });
    expect(row('workItem', 'wi1')).toMatchObject({ escalationLevel: 0, status: 'open' });
    expect(row('workItem', 'wi1').escalatedAt).toEqual(NOW);
    expect(events('workitem.overdue')).toHaveLength(1);
    expect(mocks.notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'backup', category: 'ops_escalation' })
    );

    // Same level, next tick: not even a candidate.
    const repeat = await runSupervisorTick({ now: at(2) });
    expect(repeat.counters.overdueWorkItems.checked).toBe(0);
    expect(events('workitem.escalated')).toHaveLength(1);

    await runSupervisorTick({ now: at(120) });
    expect(row('workItem', 'wi1')).toMatchObject({
      escalationLevel: 1,
      status: 'escalated',
      ownerUserId: 'owner',
      backupUserId: 'lead',
    });

    await runSupervisorTick({ now: at(480) });
    expect(row('workItem', 'wi1')).toMatchObject({ escalationLevel: 2, backupUserId: 'admin' });

    const last = await runSupervisorTick({ now: at(840) });
    expect(row('workItem', 'wi1').escalationLevel).toBe(3);
    expect(last.counters.overdueWorkItems).toMatchObject({ actions: 1, incidents: 1 });
    expect(fake.rows('incident').find((i) => i.kind === 'sla_breach')).toMatchObject({
      severity: 'critical',
      dedupeKey: 'sla_breach:work_item:wi1',
      caseId: 'case1',
    });
    expect(events('workitem.escalated')).toHaveLength(4);

    const done = await runSupervisorTick({ now: at(2000) });
    expect(done.counters.overdueWorkItems.checked).toBe(0);
  });

  it('does not escalate work waiting for a future date', async () => {
    seedBase();
    seedCase();
    fake.seed('workItem', {
      id: 'wait1',
      caseId: 'case1',
      areaKey: 'logistica',
      kind: 'wait',
      title: 'Esperar al proveedor',
      ownerUserId: 'owner',
      status: 'waiting',
      dueAt: at(-300),
      waitUntil: at(60),
    });
    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.counters.overdueWorkItems.checked).toBe(0);
    expect(row('workItem', 'wait1').escalatedAt).toBeNull();
  });
});

describe('rule 3 — stale Zoho syncs', () => {
  it('re-enqueues a stuck write once per window and opens an incident after an hour idle', async () => {
    seedBase();
    seedCase();
    fake.seed('deliveryOrder', {
      id: 'do1',
      caseId: 'case1',
      mode: 'carrier',
      status: 'pending_external',
      zohoSyncState: 'pending_write',
      allocationIds: [],
      version: 2,
      zohoLastAttemptAt: null,
      shipmentInput: {
        carrier: 'Paquetexpress',
        shipmentDate: '2026-09-15',
        trackingNumber: null,
        requestKey: 'zoho:ship:do1:2',
        requestedByUserId: null,
        requestedAt: null,
      },
      updatedAt: at(-20),
    });
    const shipJobs = () =>
      fake.rows('backgroundJob').filter((j) => j.type === 'ops.zoho.ship_package');

    const first = await runSupervisorTick({ now: NOW });
    expect(first.counters.staleSyncs).toMatchObject({ checked: 1, actions: 1, incidents: 0 });
    expect(shipJobs()).toEqual([
      expect.objectContaining({
        dedupeKey: 'zoho:ship:do1:2',
        status: 'pending',
        maxAttempts: 5,
        groupKey: 'case:case1',
        payload: { deliveryOrderId: 'do1', requestKey: 'zoho:ship:do1:2' },
      }),
    ]);
    expect(events('supervisor.sync_requeued')).toHaveLength(1);

    // Next window with the job still pending: nothing is duplicated.
    const alive = await runSupervisorTick({ now: at(16) });
    expect(alive.counters.staleSyncs).toMatchObject({ checked: 1, actions: 0 });
    expect(shipJobs()).toHaveLength(1);

    // The job died and nothing moved for more than an hour.
    Object.assign(shipJobs()[0], { status: 'failed', dedupeKey: null });
    const late = await runSupervisorTick({ now: at(45) });
    expect(late.counters.staleSyncs).toMatchObject({ actions: 1, incidents: 1 });
    expect(shipJobs()).toHaveLength(2);
    expect(fake.rows('incident').find((i) => i.kind === 'zoho_failure')).toMatchObject({
      areaKey: 'logistica',
      caseId: 'case1',
      severity: 'high',
      dedupeKey: 'zoho_failure:stale:do1:v2-pending_write',
    });
    expect(
      fake.rows('workItem').filter((w) => w.kind === 'external_sync' && w.objectId === 'do1')
    ).toHaveLength(1);

    const again = await runSupervisorTick({ now: at(61) });
    expect(again.counters.staleSyncs).toMatchObject({ actions: 0, incidents: 0 });
    expect(fake.rows('incident').filter((i) => i.kind === 'zoho_failure')).toHaveLength(1);
    expect(
      fake.rows('workItem').filter((w) => w.kind === 'external_sync' && w.objectId === 'do1')
    ).toHaveLength(1);
  });

  it('skips the rule when logistics is turned off', async () => {
    seedBase();
    seedCase();
    fake.seed('deliveryOrder', {
      id: 'do2',
      caseId: 'case1',
      mode: 'carrier',
      zohoSyncState: 'written',
      allocationIds: [],
      updatedAt: at(-300),
    });
    await updateOperationsConfig({ flags: { logistics: false } });
    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.counters.staleSyncs.checked).toBe(0);
    expect(fake.rows('backgroundJob')).toHaveLength(0);
  });
});

describe('rule 4 — overdue area requests', () => {
  it('flags the request once while its work item keeps escalating', async () => {
    seedBase();
    seedUser(fake, { id: 'buyer' });
    seedResponsible(fake, { area: 'compras', userId: 'buyer' });
    seedCase();
    fake.seed('workItem', {
      id: 'wir',
      caseId: 'case1',
      areaKey: 'compras',
      kind: 'action',
      title: 'Solicitud de Ventas: comprar faltante',
      ownerUserId: 'buyer',
      dueAt: at(-10),
      objectType: 'area_request',
      objectId: 'req1',
    });
    fake.seed('areaRequest', {
      id: 'req1',
      caseId: 'case1',
      fromAreaKey: 'ventas',
      toAreaKey: 'compras',
      kind: 'purchase_shortfall',
      objectType: 'case_demand',
      objectId: 'd1',
      title: 'Comprar faltante',
      payload: {},
      status: 'acknowledged',
      dueAt: at(-10),
      ownerUserId: 'buyer',
      workItemId: 'wir',
      createdByType: 'user',
      createdById: 'seller',
    });

    const first = await runSupervisorTick({ now: NOW });
    expect(first.counters.overdueRequests).toMatchObject({ checked: 1, actions: 1 });
    expect(events('request.overdue')).toHaveLength(1);

    const later = await runSupervisorTick({ now: at(125) });
    expect(later.counters.overdueRequests.checked).toBe(1);
    expect(events('request.overdue')).toHaveLength(1);
    expect(row('workItem', 'wir').escalationLevel).toBe(1);
  });
});

describe('rule 5 — old reservations and legacy claims', () => {
  function seedReservation(overrides: Record<string, unknown> = {}) {
    fake.seed('product', { zohoItemId: 'item1', name: 'Lámina galvanizada', sku: 'LG-1' });
    fake.seed('stockReservation', {
      id: 'res1',
      stockItemId: 'si1',
      zohoItemId: 'item1',
      warehouseId: 'wh1',
      caseId: 'case1',
      demandId: 'd1',
      quantity: new Prisma.Decimal(12),
      status: 'active',
      confidenceAtReserve: 'CONTROLLED',
      createdAt: at(-8 * 24 * 60),
      ...overrides,
    });
  }

  it('asks Ventas once about a reservation that waits too long for preparation', async () => {
    seedBase();
    seedCase();
    seedReservation();

    const first = await runSupervisorTick({ now: NOW });
    expect(first.counters.staleReservations).toMatchObject({ checked: 1, actions: 1 });
    const alerts = fake.rows('workItem').filter((w) => w.objectType === 'stock_reservation_alert');
    expect(alerts).toEqual([
      expect.objectContaining({
        areaKey: 'ventas',
        ownerUserId: 'seller',
        caseId: 'case1',
        objectId: 'case1',
      }),
    ]);
    expect(alerts[0].description).toContain('Lámina galvanizada: 12');
    expect(events('supervisor.reservation_alert')).toHaveLength(1);
    expect(mocks.expireDueLegacyClaims).toHaveBeenCalledWith({ now: NOW, limit: 200 });

    const second = await runSupervisorTick({ now: at(4) });
    expect(second.counters.staleReservations.checked).toBe(0);
    expect(
      fake.rows('workItem').filter((w) => w.objectType === 'stock_reservation_alert')
    ).toHaveLength(1);
  });

  it('does not alert when the order is already prepared', async () => {
    seedBase();
    seedCase();
    seedReservation();
    fake.seed('caseStep', {
      caseId: 'case1',
      processVersionId: 'pv1',
      stepKey: 'preparar_pedido',
      areaKey: 'inventario',
      kind: 'action',
      status: 'done',
    });
    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.counters.staleReservations).toMatchObject({
      checked: 1,
      skipped: 1,
      actions: 0,
    });
    expect(fake.rows('workItem').some((w) => w.objectType === 'stock_reservation_alert')).toBe(
      false
    );
  });

  it('counts the legacy claims released by inventory', async () => {
    seedBase();
    mocks.expireDueLegacyClaims.mockResolvedValueOnce({ checked: 3, expired: 2, rejected: 1 });
    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.counters.legacyClaims).toEqual({
      checked: 3,
      actions: 2,
      incidents: 0,
      skipped: 0,
      rejected: 1,
      errors: 0,
    });
  });
});

describe('rule 6 — absent owners', () => {
  it('hands the work of an inactive owner to the backup and the case to Ventas', async () => {
    seedBase();
    seedUser(fake, { id: 'gone', isActive: false });
    seedCase({ ownerUserId: 'gone' });
    fake.seed('workItem', {
      id: 'wi2',
      caseId: 'case1',
      areaKey: 'logistica',
      kind: 'action',
      title: 'Asignar transporte',
      ownerUserId: 'gone',
      backupUserId: 'backup',
      dueAt: at(600),
    });

    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.counters.absentOwners).toMatchObject({ checked: 2, actions: 2, incidents: 0 });
    expect(row('workItem', 'wi2')).toMatchObject({ ownerUserId: 'backup', backupUserId: 'owner' });
    expect(row('operationalCase', 'case1').ownerUserId).toBe('seller');
    expect(events('workitem.reassigned')).toHaveLength(1);
    expect(events('case.owner_changed')).toHaveLength(1);
    expect(mocks.notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'seller', type: 'ops_case_assigned' })
    );
  });

  it('opens one owner_absent incident when nobody can take the work, and replays it later', async () => {
    seedAreas(fake);
    seedUser(fake, { id: 'gone', isActive: false });
    fake.seed('workItem', {
      id: 'wi3',
      areaKey: 'compras',
      kind: 'action',
      title: 'Cotizar lámina',
      ownerUserId: 'gone',
      dueAt: at(600),
    });

    const first = await runSupervisorTick({ now: NOW });
    expect(first.counters.absentOwners).toMatchObject({ checked: 1, incidents: 1, actions: 0 });
    expect(fake.rows('incident')).toEqual([
      expect.objectContaining({
        kind: 'owner_absent',
        areaKey: 'compras',
        dedupeKey: 'owner_absent:gone:compras',
        ownerUserId: null,
      }),
    ]);
    expect(row('workItem', 'wi3').ownerUserId).toBe('gone');

    const second = await runSupervisorTick({ now: at(4) });
    expect(second.counters.absentOwners).toMatchObject({ checked: 1, incidents: 0, skipped: 1 });
    expect(fake.rows('incident')).toHaveLength(1);
  });
});

describe('rule 7 — financial close', () => {
  it('closes the case when the synchronized sales order is invoiced and paid', async () => {
    seedBase();
    seedUser(fake, { id: 'accountant' });
    seedResponsible(fake, { area: 'contabilidad', userId: 'accountant' });
    seedCase({ status: 'waiting', phase: 'closing' });
    fake.seed('caseStep', {
      id: 'step15',
      caseId: 'case1',
      processVersionId: 'pv1',
      stepKey: 'cierre_financiero',
      areaKey: 'contabilidad',
      kind: 'wait',
      status: 'waiting',
    });
    fake.seed('workItem', {
      id: 'wif',
      caseId: 'case1',
      stepId: 'step15',
      areaKey: 'contabilidad',
      kind: 'wait',
      title: 'Esperar cobro de la orden',
      ownerUserId: 'accountant',
      status: 'waiting',
      dueAt: at(30 * 24 * 60),
    });
    const salesOrder = fake.seed('salesOrder', {
      zohoSalesOrderId: 'so1',
      salesOrderNumber: 'SO-00001',
      status: 'confirmed',
      invoicedStatus: 'invoiced',
      paidStatus: 'unpaid',
      sourceRemoteModifiedAt: NOW,
      sourceSnapshotId: 'snap1',
    });

    const unpaid = await runSupervisorTick({ now: NOW });
    expect(unpaid.counters.financialClose.checked).toBe(0);
    expect(row('operationalCase', 'case1').status).toBe('waiting');

    salesOrder.paidStatus = 'paid';
    const paid = await runSupervisorTick({ now: at(5) });
    expect(paid.counters.financialClose).toMatchObject({ checked: 1, actions: 1 });
    expect(row('operationalCase', 'case1')).toMatchObject({
      status: 'closed',
      closeReason: 'financial_close',
      closedAt: at(5),
    });
    expect(row('caseStep', 'step15')).toMatchObject({ status: 'done', completedAt: at(5) });
    expect(row('workItem', 'wif')).toMatchObject({ status: 'done', completedBy: 'ops.supervisor' });
    expect(events('case.financial_closed')).toHaveLength(1);

    const after = await runSupervisorTick({ now: at(10) });
    expect(after.counters.financialClose.checked).toBe(0);
    expect(events('case.financial_closed')).toHaveLength(1);
  });

  it('keeps the case open while other work is still pending', async () => {
    seedBase();
    seedCase({ status: 'ready_to_close' });
    fake.seed('workItem', {
      caseId: 'case1',
      areaKey: 'logistica',
      kind: 'action',
      title: 'Subir evidencia de entrega',
      ownerUserId: 'owner',
      dueAt: at(600),
    });
    fake.seed('salesOrder', {
      zohoSalesOrderId: 'so1',
      invoicedStatus: 'invoiced',
      paidStatus: 'paid',
      sourceRemoteModifiedAt: NOW,
      sourceSnapshotId: 'snap1',
    });
    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.counters.financialClose).toMatchObject({ checked: 1, actions: 0, skipped: 1 });
    expect(row('operationalCase', 'case1').status).toBe('ready_to_close');
  });
});

describe('rule 8 — expired business approvals', () => {
  it('expires a pending approval past its deadline once, cancels its work and tells the requester', async () => {
    seedBase();
    fake.seed('approvalRequest', {
      id: 'apr1',
      scope: 'procurement',
      targetType: 'procurement_order',
      targetId: 'po1',
      amount: new Prisma.Decimal(12000),
      requiredApprovals: 1,
      requestedByUserId: 'seller',
      expiresAt: at(-5),
      areaKey: 'compras',
    });
    fake.seed('approvalRequest', {
      id: 'apr2',
      scope: 'expense',
      targetType: 'expense',
      targetId: 'ex1',
      amount: new Prisma.Decimal(3000),
      requiredApprovals: 1,
      requestedByUserId: 'seller',
      expiresAt: at(60),
      areaKey: 'contabilidad',
    });
    fake.seed('workItem', {
      id: 'wa1',
      areaKey: 'compras',
      kind: 'approval',
      title: 'Aprobar: Compra por $12,000.00',
      ownerUserId: 'admin',
      objectType: 'approval_request',
      objectId: 'apr1',
      dueAt: at(600),
    });

    const first = await runSupervisorTick({ now: NOW });
    expect(first.counters.expiredApprovals).toMatchObject({ checked: 1, actions: 1, errors: 0 });
    expect(row('approvalRequest', 'apr1')).toMatchObject({ status: 'expired', decidedAt: NOW });
    expect(row('approvalRequest', 'apr2')).toMatchObject({ status: 'pending', decidedAt: null });
    expect(row('workItem', 'wa1')).toMatchObject({ status: 'cancelled', completedAt: NOW });
    expect(events('approval.expired')).toEqual([
      expect.objectContaining({ objectId: 'apr1', areaKey: 'compras', actorId: 'ops.supervisor' }),
    ]);
    expect(events('workitem.cancelled')).toHaveLength(1);
    expect(mocks.notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'seller',
        category: 'approval_decided',
        type: 'approval_expired',
      })
    );

    const second = await runSupervisorTick({ now: at(4) });
    expect(second.counters.expiredApprovals.checked).toBe(0);
    expect(events('approval.expired')).toHaveLength(1);
  });
});

describe('rule 9 — tick', () => {
  it('records the tick event with counters and the usage meters', async () => {
    seedBase();
    seedCase();
    const summary = await runSupervisorTick({ now: NOW });
    expect(summary.skipped).toBeNull();
    const [tick] = events('supervisor.tick');
    expect(tick).toMatchObject({ actorType: 'system', actorId: 'ops.supervisor', caseId: null });
    expect(tick.payload).toMatchObject({ totals: summary.totals, aborted: false });
    expect(summary.tickEventId).toBe(String(tick.id));
    expect(summary.totals).toMatchObject({ checked: 1, actions: 1, incidents: 1 });
    expect(mocks.recordUsage).toHaveBeenCalledWith(
      'ops.supervisor',
      'tick',
      'ms',
      expect.any(Number)
    );
    expect(mocks.recordUsage).toHaveBeenCalledWith('ops.supervisor', 'actions', 'commands', 1);
    expect(mocks.recordUsage).toHaveBeenCalledWith('ops.supervisor', 'incidents', 'incidents', 1);
  });

  it('does nothing when the supervisor flag or the whole core is off', async () => {
    seedBase();
    seedCase();
    await updateOperationsConfig({ flags: { supervisor: false } });
    expect((await runSupervisorTick({ now: NOW })).skipped).toBe('supervisor_disabled');
    await updateOperationsConfig({ flags: { supervisor: true }, isEnabled: false });
    expect((await runSupervisorTick({ now: NOW })).skipped).toBe('core_disabled');
    expect(fake.rows('operationalEvent')).toHaveLength(0);
    expect(fake.rows('incident')).toHaveLength(0);
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('stops between commands when the job is aborted', async () => {
    seedBase();
    seedCase();
    const controller = new AbortController();
    controller.abort();
    const summary = await runSupervisorTick({ now: NOW, signal: controller.signal });
    expect(summary.aborted).toBe(true);
    expect(fake.rows('incident')).toHaveLength(0);
    expect(events('supervisor.tick')).toHaveLength(1);
  });

  it('is idempotent when two ticks see the same findings with the same clock', async () => {
    seedBase();
    seedUser(fake, { id: 'gone', isActive: false });
    seedCase();
    fake.seed('workItem', {
      id: 'wi1',
      caseId: 'case1',
      areaKey: 'logistica',
      kind: 'action',
      title: 'Planear entrega',
      ownerUserId: 'owner',
      dueAt: at(-10),
    });
    fake.seed('stockReservation', {
      stockItemId: 'si1',
      zohoItemId: 'item1',
      warehouseId: 'wh1',
      caseId: 'case1',
      demandId: 'd1',
      quantity: new Prisma.Decimal(1),
      status: 'active',
      confidenceAtReserve: 'CONTROLLED',
      createdAt: at(-10 * 24 * 60),
    });

    const first = await runSupervisorTick({ now: NOW });
    expect(first.totals.actions).toBeGreaterThan(0);
    const snapshot = () => ({
      events: fake.rows('operationalEvent').filter((e) => e.type !== 'supervisor.tick').length,
      workItems: fake.rows('workItem').length,
      incidents: fake.rows('incident').length,
      jobs: fake.rows('backgroundJob').length,
      notifications: mocks.notifyUser.mock.calls.length,
      versions: fake.rows('workItem').map((w) => w.version),
    });
    const before = snapshot();

    const second = await runSupervisorTick({ now: NOW });
    expect(second.totals).toMatchObject({ actions: 0, incidents: 0, errors: 0 });
    expect(snapshot()).toEqual(before);
  });
});
