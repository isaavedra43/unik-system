import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));

import { executeCommand, registerCommand } from './commands';
import {
  INCIDENT_COMMANDS,
  INCIDENT_HISTORY_LIMIT,
  appendIncidentHistory,
  getIncident,
  listIncidents,
  maxIncidentSeverity,
  nextIncidentStatus,
  openOrReopenIncident,
  shouldReopenIncident,
  type IncidentCommandData,
} from './incidents-service';
import { invalidateOperationsConfigCache } from './operations-config';
import { AREA_KEYS, INCIDENT_SEVERITIES } from './types';
import { seedArea, seedResponsible, seedUser } from './testing/fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');

type SessionUser = ReturnType<typeof seedUser>['currentUser'];
let users: Record<'owner' | 'stranger' | 'manager' | 'viewer' | 'lead' | 'seller', SessionUser>;

registerCommand('test.open_incident', {
  schema: z.object({
    severity: z.enum(INCIDENT_SEVERITIES).optional(),
    reopenDismissed: z.boolean().optional(),
  }),
  aggregate: 'none',
  async handler(tx, cmd) {
    const outcome = await openOrReopenIncident(tx, {
      kind: 'stock_conflict',
      areaKey: 'inventario',
      title: 'Conflicto de stock en LP-01',
      dedupeKey: 'stock:lp-01',
      severity: cmd.payload.severity ?? 'medium',
      caseId: 'case1',
      detail: { sku: 'LP-01' },
      reopenDismissed: cmd.payload.reopenDismissed,
    });
    return {
      data: {
        incidentId: outcome.incident.id,
        created: outcome.created,
        reopened: outcome.reopened,
      },
    };
  },
});

let seq = 0;

function act(
  actor: SessionUser | 'system',
  action: keyof typeof INCIDENT_COMMANDS,
  payload: Record<string, unknown> = {},
  incidentId = 'inc1',
  now = NOW
) {
  seq += 1;
  const system = actor === 'system';
  return executeCommand<IncidentCommandData>(
    {
      commandId: `inc-${seq}`,
      type: INCIDENT_COMMANDS[action],
      actor: system ? { type: 'system', id: 'ops.supervisor' } : { type: 'user', id: actor.id },
      aggregate: { type: 'incident', id: incidentId },
      payload,
    },
    system ? null : actor,
    { now }
  );
}

function open(payload: Record<string, unknown> = {}, now = NOW) {
  seq += 1;
  return executeCommand<{ incidentId: string; created: boolean; reopened: boolean }>(
    {
      commandId: `open-${seq}`,
      type: 'test.open_incident',
      actor: { type: 'system', id: 'ops.inventory' },
      aggregate: { type: 'test', id: `open-${seq}` },
      payload,
    },
    null,
    { now }
  );
}

const incidentRow = (id = 'inc1') => fake.rows('incident').find((r) => r.id === id)!;
const eventTypes = () => fake.rows('operationalEvent').map((e) => e.type as string);
const notifications = () => mocks.notifyUser.mock.calls.map(([input]) => input);

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  users = {
    owner: seedUser(fake, { id: 'owner', name: 'Olga' }).currentUser,
    stranger: seedUser(fake, { id: 'stranger' }).currentUser,
    manager: seedUser(fake, { id: 'manager', permissions: ['operations.manage'] }).currentUser,
    viewer: seedUser(fake, { id: 'viewer', permissions: ['operations.view'] }).currentUser,
    lead: seedUser(fake, { id: 'lead' }).currentUser,
    seller: seedUser(fake, { id: 'seller' }).currentUser,
  };
  for (const key of AREA_KEYS) {
    seedArea(fake, key, key === 'inventario' ? { leadUserId: 'lead' } : {});
  }
  seedResponsible(fake, { area: 'inventario', userId: 'owner' });
  fake.seed('operationalCase', {
    id: 'case1',
    caseSeq: 1,
    caseNumber: 'EXP-000001',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so1',
    processVersionId: 'pv1',
    ownerUserId: 'seller',
  });
  fake.seed('incident', {
    id: 'inc1',
    caseId: 'case1',
    areaKey: 'inventario',
    kind: 'count_dispute',
    severity: 'high',
    title: 'Conteo distinto en LP-01',
    ownerUserId: 'owner',
    dedupeKey: 'count:lp-01',
    openedAt: new Date('2026-09-15T09:00:00.000Z'),
  });
  fake.seed('workItem', {
    id: 'fu1',
    areaKey: 'inventario',
    kind: 'incident_followup',
    title: 'Recontar LP-01',
    ownerUserId: 'owner',
    dueAt: new Date('2026-09-15T18:00:00.000Z'),
    objectType: 'incident',
    objectId: 'inc1',
  });
});

describe('incident rules (pure)', () => {
  it('encodes transitions, reopening and severity', () => {
    expect(nextIncidentStatus('acknowledge', 'open')).toBe('acknowledged');
    expect(nextIncidentStatus('acknowledge', 'acknowledged')).toBeNull();
    expect(nextIncidentStatus('resolve', 'acknowledged')).toBe('resolved');
    expect(nextIncidentStatus('dismiss', 'resolved')).toBeNull();
    expect(nextIncidentStatus('reopen', 'resolved')).toBe('open');
    expect(shouldReopenIncident('resolved')).toBe(true);
    expect(shouldReopenIncident('dismissed')).toBe(false);
    expect(shouldReopenIncident('dismissed', { reopenDismissed: true })).toBe(true);
    expect(shouldReopenIncident('open')).toBe(false);
    expect(maxIncidentSeverity('low', 'critical')).toBe('critical');
    expect(maxIncidentSeverity('high', 'medium')).toBe('high');
    expect(maxIncidentSeverity('bogus', 'low')).toBe('medium');
  });

  it('keeps a capped history of previous occurrences', () => {
    const first = appendIncidentHistory({}, { resolution: 'a' });
    expect(first).toEqual({ history: [{ resolution: 'a' }], reopenCount: 1 });
    const full = Array.from({ length: INCIDENT_HISTORY_LIMIT }, (_, i) => ({ n: i }));
    const capped = appendIncidentHistory({ history: full, reopenCount: 20 }, { n: 99 });
    expect(capped.history).toHaveLength(INCIDENT_HISTORY_LIMIT);
    expect(capped.history.at(-1)).toEqual({ n: 99 });
    expect(capped.reopenCount).toBe(21);
  });
});

describe('incident commands', () => {
  it('lets the owner acknowledge once', async () => {
    const result = await act(users.owner, 'acknowledge', { note: 'Voy a recontar' });
    expect(result).toMatchObject({
      status: 'completed',
      data: { status: 'acknowledged', previousStatus: 'open' },
    });
    expect(incidentRow()).toMatchObject({
      status: 'acknowledged',
      version: 2,
      detail: expect.objectContaining({
        acknowledgedBy: 'owner',
        acknowledgeNote: 'Voy a recontar',
      }),
    });
    expect(eventTypes()).toEqual(['incident.acknowledged']);
    expect(await act(users.owner, 'acknowledge')).toMatchObject({ errorCode: 'invalid_state' });
  });

  it('rejects outsiders and AI actors', async () => {
    for (const actor of [users.stranger, users.viewer, users.lead]) {
      expect(await act(actor, 'resolve', { resolution: 'Listo' })).toMatchObject({
        status: 'rejected',
        errorCode: 'forbidden',
      });
    }
    const byAi = await executeCommand(
      {
        commandId: 'ai-inc',
        type: INCIDENT_COMMANDS.acknowledge,
        actor: { type: 'ai', id: 'stranger' },
        aggregate: { type: 'incident', id: 'inc1' },
        payload: {},
      },
      users.stranger,
      { now: NOW }
    );
    expect(byAi).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    expect(incidentRow().status).toBe('open');
  });

  /** Plan 7.7: la Torre se abre con `operations.admin` y ofrece cerrar la incidencia. */
  it('accepts operations.admin, the key the Control Tower is gated with', async () => {
    const opsAdmin = seedUser(fake, {
      id: 'opsAdmin',
      permissions: ['operations.admin'],
    }).currentUser;
    expect((await act(opsAdmin, 'acknowledge')).status).toBe('completed');
    expect(
      (await act(opsAdmin, 'resolve', { resolution: 'Se recontó y se ajustó el inventario' }))
        .status
    ).toBe('completed');
    expect(incidentRow().status).toBe('resolved');
  });

  it('makes a manager the owner of an unowned incident when acknowledging it', async () => {
    incidentRow().ownerUserId = null;
    expect(await act(users.owner, 'acknowledge')).toMatchObject({ errorCode: 'forbidden' });
    await act(users.manager, 'acknowledge');
    expect(incidentRow()).toMatchObject({ status: 'acknowledged', ownerUserId: 'manager' });
  });

  it('resolves with a resolution and completes the follow-up work', async () => {
    expect(await act(users.owner, 'resolve', { resolution: 'x' })).toMatchObject({
      errorCode: 'invalid_payload',
    });
    const result = await act(users.owner, 'resolve', {
      resolution: 'Se recontó: había 12 cajas, se ajustó',
    });
    expect(result.data).toMatchObject({ status: 'resolved', closedWorkItemIds: ['fu1'] });
    expect(incidentRow()).toMatchObject({
      status: 'resolved',
      resolvedAt: NOW,
      resolvedBy: 'owner',
      resolution: 'Se recontó: había 12 cajas, se ajustó',
    });
    expect(fake.rows('workItem')[0]).toMatchObject({
      status: 'done',
      result: { incidentStatus: 'resolved', resolution: 'Se recontó: había 12 cajas, se ajustó' },
    });
    expect(eventTypes()).toEqual(['workitem.completed', 'incident.resolved']);
    expect(await act(users.owner, 'dismiss', { reason: 'Duplicada' })).toMatchObject({
      errorCode: 'invalid_state',
    });
  });

  it('dismisses with a reason, cancels the follow-up and tells the owner', async () => {
    const result = await act(users.manager, 'dismiss', { reason: 'Era un error de captura' });
    expect(result.data).toMatchObject({ status: 'dismissed', closedWorkItemIds: ['fu1'] });
    expect(incidentRow()).toMatchObject({
      status: 'dismissed',
      resolvedBy: 'manager',
      resolution: 'Era un error de captura',
    });
    expect(fake.rows('workItem')[0]).toMatchObject({ status: 'cancelled' });
    expect(notifications()).toContainEqual(
      expect.objectContaining({
        userId: 'owner',
        category: 'ops_incident',
        type: 'ops_incident_dismissed',
      })
    );
  });

  it('accepts system actors', async () => {
    expect(
      (await act('system', 'resolve', { resolution: 'Zoho confirmó el paquete' })).status
    ).toBe('completed');
  });
});

describe('openOrReopenIncident', () => {
  it('opens once, keeps an open incident and reopens it when it repeats after being resolved', async () => {
    const first = await open();
    expect(first.data).toMatchObject({ created: true, reopened: false });
    const incidentId = first.data!.incidentId;
    expect(incidentRow(incidentId)).toMatchObject({ ownerUserId: 'owner', status: 'open' });

    expect((await open()).data).toMatchObject({ created: false, reopened: false, incidentId });
    expect(fake.rows('incident')).toHaveLength(2);

    await act(users.owner, 'resolve', { resolution: 'Se liberó la reserva duplicada' }, incidentId);
    mocks.notifyUser.mockClear();
    const later = new Date('2026-09-16T10:00:00.000Z');
    const reopened = await open({ severity: 'critical' }, later);
    expect(reopened.data).toMatchObject({ created: false, reopened: true, incidentId });
    expect(incidentRow(incidentId)).toMatchObject({
      status: 'open',
      severity: 'critical',
      openedAt: later,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      detail: expect.objectContaining({
        sku: 'LP-01',
        reopenCount: 1,
        history: [
          expect.objectContaining({
            status: 'resolved',
            resolution: 'Se liberó la reserva duplicada',
            resolvedBy: 'owner',
          }),
        ],
      }),
    });
    const lastEvent = fake.rows('operationalEvent').at(-1)!;
    expect(lastEvent).toMatchObject({
      type: 'incident.opened',
      payload: expect.objectContaining({
        reopened: true,
        reopenCount: 1,
        previousStatus: 'resolved',
      }),
    });
    expect(notifications()).toEqual([
      expect.objectContaining({
        userId: 'owner',
        type: 'ops_incident_reopened',
        push: { urgency: 'high', requireInteraction: true },
      }),
    ]);
  });

  it('leaves dismissed incidents alone unless asked', async () => {
    const { incidentId } = (await open()).data!;
    await act(users.owner, 'dismiss', { reason: 'Falso positivo' }, incidentId);
    expect((await open()).data).toMatchObject({ reopened: false });
    expect(incidentRow(incidentId).status).toBe('dismissed');
    expect((await open({ reopenDismissed: true })).data).toMatchObject({ reopened: true });
    expect(incidentRow(incidentId).status).toBe('open');
  });
});

describe('incident reads', () => {
  beforeEach(() => {
    fake.seed('incident', {
      id: 'inc2',
      areaKey: 'logistica',
      kind: 'zoho_failure',
      severity: 'critical',
      title: 'Zoho no respondió',
      ownerUserId: 'manager',
      dedupeKey: 'zoho:1',
      openedAt: new Date('2026-09-15T11:00:00.000Z'),
    });
    fake.seed('incident', {
      id: 'inc3',
      areaKey: 'inventario',
      kind: 'stock_conflict',
      severity: 'low',
      status: 'resolved',
      title: 'Reserva duplicada',
      ownerUserId: 'owner',
      dedupeKey: 'stock:9',
      openedAt: new Date('2026-09-14T11:00:00.000Z'),
    });
  });

  it('lists everything for viewers and only what the actor may see otherwise', async () => {
    const all = await listIncidents(users.viewer);
    expect(all.items.map((i) => i.id)).toEqual(['inc2', 'inc1']);
    expect(all.items[1]).toMatchObject({
      caseNumber: 'EXP-000001',
      areaLabel: 'Inventario',
      kindLabel: 'Diferencia de conteo',
      severityLabel: 'Alta',
      statusLabel: 'Abierta',
      ownerName: 'Olga',
      reopenCount: 0,
    });
    expect(
      (await listIncidents(users.viewer, { severity: ['critical'] })).items.map((i) => i.id)
    ).toEqual(['inc2']);
    expect((await listIncidents(users.viewer, { scope: 'closed' })).items.map((i) => i.id)).toEqual(
      ['inc3']
    );

    const firstPage = await listIncidents(users.viewer, { limit: 1 });
    const secondPage = await listIncidents(users.viewer, {
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect([...firstPage.items, ...secondPage.items].map((i) => i.id)).toEqual(['inc2', 'inc1']);
    expect(secondPage.nextCursor).toBeNull();

    expect((await listIncidents(users.stranger)).items).toEqual([]);
    expect((await listIncidents(users.owner, { scope: 'all' })).items.map((i) => i.id)).toEqual([
      'inc1',
      'inc3',
    ]);
    expect(
      (await listIncidents(users.lead, { areaKey: 'inventario', scope: 'all' })).items.map(
        (i) => i.id
      )
    ).toEqual(['inc1', 'inc3']);
    expect((await listIncidents(users.viewer, { mine: true })).items).toEqual([]);
    await expect(listIncidents(users.viewer, { limit: 500 })).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('returns one incident with permissions and hides it from outsiders', async () => {
    expect((await getIncident(users.owner, 'inc1')).permissions).toEqual({
      canAcknowledge: true,
      canResolve: true,
      canDismiss: true,
    });
    expect((await getIncident(users.viewer, 'inc1')).permissions).toEqual({
      canAcknowledge: false,
      canResolve: false,
      canDismiss: false,
    });
    await expect(getIncident(users.seller, 'inc1')).resolves.toMatchObject({ id: 'inc1' });
    await expect(getIncident(users.lead, 'inc1')).resolves.toMatchObject({ id: 'inc1' });
    await expect(getIncident(users.stranger, 'inc2')).rejects.toMatchObject({ code: 'not_found' });
  });
});
