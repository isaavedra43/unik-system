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

import type { Prisma } from '@prisma/client';
import { executeCommand } from './commands';
import { defaultOperationsSettings, invalidateOperationsConfigCache } from './operations-config';
import { AREA_KEYS } from './types';
import {
  missingEvidenceForWorkItems,
  WORK_ITEM_COMMANDS,
  appliedEscalationLevel,
  canTransitionWorkItem,
  decodeListCursor,
  encodeListCursor,
  escalateWorkItem,
  escalationLevelFor,
  escalationStepFor,
  escalationThresholds,
  getWorkItem,
  listAreaWorkItems,
  listMyWorkItems,
  nextEscalationLevel,
  registerWorkItemHooks,
  type WorkItemCommandData,
  type WorkItemEscalationData,
} from './work-items-service';
import { seedArea, seedResponsible, seedUser } from './testing/fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
const DEFAULT_ESCALATION = defaultOperationsSettings(NOW).escalation;

type SessionUser = ReturnType<typeof seedUser>['currentUser'];
type UserKey = 'owner' | 'backup' | 'stranger' | 'manager' | 'viewer' | 'lead' | 'admin' | 'seller';
let users: Record<UserKey, SessionUser>;

function seedWorkItem(overrides: Record<string, unknown> = {}) {
  return fake.seed('workItem', {
    id: 'wi1',
    areaKey: 'logistica',
    kind: 'action',
    title: 'Planear entrega',
    ownerUserId: 'owner',
    backupUserId: 'backup',
    dueAt: new Date('2026-09-15T12:00:00.000Z'),
    caseId: 'case1',
    createdAt: new Date('2026-09-15T10:00:00.000Z'),
    ...overrides,
  });
}

let seq = 0;
function run<D = WorkItemCommandData>(
  actor: SessionUser | 'system',
  type: string,
  payload: unknown,
  options: { id?: string; now?: Date } = {}
) {
  seq += 1;
  const system = actor === 'system';
  return executeCommand<D>(
    {
      commandId: `wi-${seq}`,
      type,
      actor: system ? { type: 'system', id: 'ops.supervisor' } : { type: 'user', id: actor.id },
      aggregate: { type: 'work_item', id: options.id ?? 'wi1' },
      payload,
    },
    system ? null : actor,
    { now: options.now ?? NOW }
  );
}

const escalate = (actor: SessionUser | 'system', payload: Record<string, unknown> = {}) =>
  run<WorkItemEscalationData>(actor, WORK_ITEM_COMMANDS.escalate, payload);

const row = (id = 'wi1') => fake.rows('workItem').find((r) => r.id === id)!;
const eventTypes = () => fake.rows('operationalEvent').map((e) => e.type as string);
const notifications = () => mocks.notifyUser.mock.calls.map(([input]) => input);
const userRow = (id: string) => fake.rows('user').find((u) => u.id === id)!;

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  users = {
    owner: seedUser(fake, { id: 'owner', name: 'Olga' }).currentUser,
    backup: seedUser(fake, { id: 'backup', name: 'Beto' }).currentUser,
    stranger: seedUser(fake, { id: 'stranger' }).currentUser,
    manager: seedUser(fake, { id: 'manager', permissions: ['operations.manage'] }).currentUser,
    viewer: seedUser(fake, { id: 'viewer', permissions: ['operations.view'] }).currentUser,
    lead: seedUser(fake, { id: 'lead' }).currentUser,
    admin: seedUser(fake, { id: 'admin' }).currentUser,
    seller: seedUser(fake, { id: 'seller' }).currentUser,
  };
  seedUser(fake, { id: 'adminBackup' });
  seedUser(fake, { id: 'bot', isBot: true });
  seedUser(fake, { id: 'gone', isActive: false });
  for (const key of AREA_KEYS) {
    seedArea(fake, key, key === 'logistica' ? { leadUserId: 'lead' } : {});
  }
  seedResponsible(fake, { area: 'logistica', userId: 'owner', backupUserId: 'backup' });
  seedResponsible(fake, { area: 'administracion', userId: 'admin', backupUserId: 'adminBackup' });
  fake.seed('operationalCase', {
    id: 'case1',
    caseSeq: 1,
    caseNumber: 'EXP-000001',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so1',
    processVersionId: 'pv1',
    ownerUserId: 'seller',
    customerName: 'Constructora Norte',
  });
  seedWorkItem();
});

describe('work item rules (pure)', () => {
  it('allows each action only from its states', () => {
    for (const status of ['open', 'waiting', 'escalated']) {
      expect(canTransitionWorkItem('start', status)).toBe(true);
    }
    for (const status of ['in_progress', 'done', 'cancelled']) {
      expect(canTransitionWorkItem('start', status)).toBe(false);
    }
    expect(canTransitionWorkItem('complete', 'in_progress')).toBe(true);
    expect(canTransitionWorkItem('wait', 'waiting')).toBe(true);
    expect(canTransitionWorkItem('complete', 'done')).toBe(false);
    expect(canTransitionWorkItem('escalate', 'cancelled')).toBe(false);
  });

  it('derives the thresholds and level of every rung of the ladder', () => {
    expect(escalationThresholds(DEFAULT_ESCALATION)).toEqual([0, 120, 480, 840]);
    expect(escalationThresholds({ afterMinutes: [30], ladder: ['backup', 'area_lead'] })).toEqual([
      30, 90, 150,
    ]);
    const levels = [0, 1, 119, 120, 479, 480, 839, 840, 10_000].map((m) =>
      escalationLevelFor(m, DEFAULT_ESCALATION)
    );
    expect(levels).toEqual([null, 0, 0, 1, 1, 2, 2, 3, 3]);
    expect(escalationStepFor(0, DEFAULT_ESCALATION.ladder)).toBe('backup');
    expect(escalationStepFor(2, DEFAULT_ESCALATION.ladder)).toBe('administracion');
    expect(escalationStepFor(3, DEFAULT_ESCALATION.ladder)).toBe('incident');
    expect(escalationStepFor(4, DEFAULT_ESCALATION.ladder)).toBeNull();
    expect(escalationStepFor(-1, DEFAULT_ESCALATION.ladder)).toBeNull();
  });

  it('computes the next level only for open overdue items not escalated that far', () => {
    const base = {
      status: 'open',
      dueAt: new Date('2026-09-15T12:00:00.000Z'),
      escalationLevel: 0,
      escalatedAt: null as Date | null,
    };
    expect(appliedEscalationLevel(base)).toBe(-1);
    expect(nextEscalationLevel(base, DEFAULT_ESCALATION, NOW)).toBe(1);
    expect(
      nextEscalationLevel(
        { ...base, escalationLevel: 1, escalatedAt: NOW },
        DEFAULT_ESCALATION,
        NOW
      )
    ).toBeNull();
    expect(nextEscalationLevel({ ...base, status: 'done' }, DEFAULT_ESCALATION, NOW)).toBeNull();
    expect(
      nextEscalationLevel(
        { ...base, dueAt: new Date('2026-09-16T00:00:00Z') },
        DEFAULT_ESCALATION,
        NOW
      )
    ).toBeNull();
  });

  it('round-trips list cursors and rejects garbage', () => {
    const cursor = encodeListCursor(NOW, 'wi1');
    expect(decodeListCursor(cursor)).toEqual({ at: NOW, id: 'wi1' });
    expect(decodeListCursor(undefined)).toBeNull();
    expect(() => decodeListCursor('not-a-cursor')).toThrow(/Cursor inválido/);
  });
});

describe('workitem.start and workitem.wait', () => {
  it('lets the owner start once and records the event', async () => {
    const result = await run(users.owner, WORK_ITEM_COMMANDS.start, {});
    expect(result).toMatchObject({ status: 'completed', aggregateVersion: 2 });
    expect(row()).toMatchObject({ status: 'in_progress', version: 2 });
    expect(eventTypes()).toEqual(['workitem.started']);

    const again = await run(users.owner, WORK_ITEM_COMMANDS.start, {});
    expect(again).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    expect(again.message).toBe('No se puede iniciar un trabajo en curso');
  });

  it('accepts the backup, managers and system actors but not other users', async () => {
    seedWorkItem({ id: 'wi2' });
    seedWorkItem({ id: 'wi3' });
    expect((await run(users.backup, WORK_ITEM_COMMANDS.start, {})).status).toBe('completed');
    expect((await run(users.manager, WORK_ITEM_COMMANDS.start, {}, { id: 'wi2' })).status).toBe(
      'completed'
    );
    expect((await run('system', WORK_ITEM_COMMANDS.start, {}, { id: 'wi3' })).status).toBe(
      'completed'
    );
    seedWorkItem({ id: 'wi4' });
    const denied = await run(users.stranger, WORK_ITEM_COMMANDS.start, {}, { id: 'wi4' });
    expect(denied).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    // FakePrisma has no rollback: only the business state is asserted after a rejection.
    expect(row('wi4')).toMatchObject({ status: 'open' });
  });

  it('puts a work item on hold with a reason and a future date, and resumes it', async () => {
    const until = '2026-09-17T15:00:00.000Z';
    const waited = await run(users.manager, WORK_ITEM_COMMANDS.wait, {
      reason: 'Esperando al proveedor',
      until,
    });
    expect(waited.status).toBe('completed');
    expect(row()).toMatchObject({ status: 'waiting', waitReason: 'Esperando al proveedor' });
    expect(row().waitUntil.toISOString()).toBe(until);
    expect(notifications()).toEqual([
      expect.objectContaining({ userId: 'owner', type: 'ops_workitem_waiting' }),
    ]);

    // waiting → waiting updates the reason.
    expect(
      (await run(users.owner, WORK_ITEM_COMMANDS.wait, { reason: 'Cliente cambió la fecha' }))
        .status
    ).toBe('completed');
    expect(row()).toMatchObject({ waitReason: 'Cliente cambió la fecha', waitUntil: null });

    await run(users.owner, WORK_ITEM_COMMANDS.start, {});
    expect(row()).toMatchObject({ status: 'in_progress', waitReason: null, waitUntil: null });
  });

  it('rejects invalid waits', async () => {
    expect(
      await run(users.owner, WORK_ITEM_COMMANDS.wait, {
        reason: 'Esperando',
        until: '2026-09-14T00:00:00.000Z',
      })
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    expect(await run(users.owner, WORK_ITEM_COMMANDS.wait, { reason: 'x' })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
    });
    expect(row().status).toBe('open');
  });
});

describe('workitem.complete', () => {
  it('requires the evidence listed in requiredEvidence', async () => {
    row().requiredEvidence = ['photo', 'delivery_order'];
    const missing = await run(users.owner, WORK_ITEM_COMMANDS.complete, {});
    expect(missing).toMatchObject({ status: 'rejected', errorCode: 'missing_evidence' });
    expect(missing.message).toContain('Foto');
    expect(missing.message).toContain('delivery order');
    expect(row().status).toBe('open');

    fake.seed('evidenceLink', {
      workItemId: 'wi1',
      objectType: 'work_item',
      objectId: 'wi1',
      kind: 'photo',
      createdBy: 'owner',
    });
    const done = await run(users.owner, WORK_ITEM_COMMANDS.complete, {
      result: { delivery_order: 'DO-1' },
    });
    expect(done.status).toBe('completed');
    expect(row()).toMatchObject({
      status: 'done',
      completedBy: 'owner',
      completedAt: NOW,
      result: { delivery_order: 'DO-1' },
      version: done.aggregateVersion,
    });
    expect(eventTypes()).toEqual(['workitem.completed']);
  });

  it('stores the closing note as note evidence and tells the owner when someone else closes', async () => {
    row().requiredEvidence = ['note'];
    const result = await run(users.manager, WORK_ITEM_COMMANDS.complete, {
      note: 'Entregado en recepción',
    });
    expect(result.status).toBe('completed');
    expect(fake.rows('evidenceLink')).toEqual([
      expect.objectContaining({ kind: 'note', note: 'Entregado en recepción', workItemId: 'wi1' }),
    ]);
    expect(row().result).toEqual({ note: 'Entregado en recepción' });
    expect(eventTypes()).toEqual(['evidence.attached', 'workitem.completed']);
    expect(notifications()).toEqual([
      expect.objectContaining({ userId: 'owner', type: 'ops_workitem_completed' }),
    ]);
  });

  it('runs after-complete hooks on every completion', async () => {
    const seen: string[] = [];
    const off = registerWorkItemHooks(
      '*',
      {
        async afterComplete({ item }) {
          seen.push(`${item.id}:${item.status}`);
        },
      },
      'test-after-complete'
    );
    try {
      await run(users.owner, WORK_ITEM_COMMANDS.complete, {});
    } finally {
      off();
    }
    expect(seen).toEqual(['wi1:done']);
  });

  it('does not close approval work items or closed items', async () => {
    seedWorkItem({
      id: 'approval',
      kind: 'approval',
      objectType: 'approval_request',
      objectId: 'ap1',
    });
    expect(
      await run(users.owner, WORK_ITEM_COMMANDS.complete, {}, { id: 'approval' })
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    expect(
      await run(users.owner, WORK_ITEM_COMMANDS.wait, { reason: 'Luego' }, { id: 'approval' })
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    await run(users.owner, WORK_ITEM_COMMANDS.complete, {});
    expect(await run(users.owner, WORK_ITEM_COMMANDS.complete, {})).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
      message: 'No se puede terminar un trabajo terminado',
    });
  });
});

describe('workitem.reassign', () => {
  it('hands the work to another active person and notifies the new owner', async () => {
    const result = await run(users.owner, WORK_ITEM_COMMANDS.reassign, {
      ownerUserId: 'stranger',
      reason: 'Salgo de vacaciones',
    });
    expect(result.status).toBe('completed');
    expect(row()).toMatchObject({ ownerUserId: 'stranger', backupUserId: 'backup' });
    const [event] = fake.rows('operationalEvent');
    expect(event).toMatchObject({
      type: 'workitem.reassigned',
      payload: expect.objectContaining({
        previousOwnerUserId: 'owner',
        ownerUserId: 'stranger',
        reason: 'Salgo de vacaciones',
      }),
    });
    expect(notifications()).toContainEqual(
      expect.objectContaining({ userId: 'stranger', type: 'ops_workitem_assigned' })
    );
  });

  it('drops the backup when it becomes the owner', async () => {
    await run(users.manager, WORK_ITEM_COMMANDS.reassign, { ownerUserId: 'backup' });
    expect(row()).toMatchObject({ ownerUserId: 'backup', backupUserId: null });
  });

  it('rejects bots, inactive users, no-op changes and outsiders', async () => {
    const cases: Array<[SessionUser, Record<string, unknown>, string]> = [
      [users.owner, { ownerUserId: 'bot' }, 'invalid_payload'],
      [users.owner, { ownerUserId: 'gone' }, 'invalid_payload'],
      [users.owner, { ownerUserId: 'stranger', backupUserId: 'stranger' }, 'invalid_payload'],
      [users.owner, { ownerUserId: 'owner' }, 'invalid_state'],
      [users.owner, { ownerUserId: 'lead', dueAt: '2026-09-14T00:00:00.000Z' }, 'invalid_payload'],
      [users.stranger, { ownerUserId: 'stranger' }, 'forbidden'],
    ];
    for (const [actor, payload, code] of cases) {
      expect(await run(actor, WORK_ITEM_COMMANDS.reassign, payload)).toMatchObject({
        status: 'rejected',
        errorCode: code,
      });
    }
    expect(row()).toMatchObject({ ownerUserId: 'owner', backupUserId: 'backup' });
  });

  it('restarts the escalation ladder when a new due date is given', async () => {
    Object.assign(row(), { status: 'escalated', escalationLevel: 2, escalatedAt: NOW });
    await run(users.manager, WORK_ITEM_COMMANDS.reassign, {
      ownerUserId: 'lead',
      dueAt: '2026-09-16T15:00:00.000Z',
    });
    expect(row()).toMatchObject({
      ownerUserId: 'lead',
      status: 'open',
      escalationLevel: 0,
      escalatedAt: null,
    });
    expect(row().dueAt.toISOString()).toBe('2026-09-16T15:00:00.000Z');
  });
});

describe('escalation ladder', () => {
  it('walks the configured ladder: owner+backup → area lead → administración → incident', async () => {
    // Level 0: owner and backup are warned; the item keeps its state.
    const level0 = await escalate('system', { level: 0 });
    expect(level0.data).toMatchObject({ applied: true, step: 'backup', level: 0 });
    expect(row()).toMatchObject({ status: 'open', escalationLevel: 0, escalatedAt: NOW });
    expect(eventTypes()).toEqual(['workitem.overdue', 'workitem.escalated']);
    expect(notifications().map((n) => [n.userId, n.category, n.type])).toEqual([
      ['owner', 'ops_escalation', 'ops_workitem_overdue'],
      ['backup', 'ops_escalation', 'ops_workitem_overdue'],
    ]);

    // Repeating a level changes nothing.
    const repeated = await escalate('system', { level: 0 });
    expect(repeated.data).toMatchObject({ applied: false });
    expect(eventTypes()).toHaveLength(2);

    // Level 1: the area lead backs the work item.
    mocks.notifyUser.mockClear();
    const level1 = await escalate('system', { level: 1 });
    expect(level1.data).toMatchObject({
      applied: true,
      step: 'area_lead',
      escalatedToUserId: 'lead',
    });
    expect(row()).toMatchObject({
      status: 'escalated',
      escalationLevel: 1,
      ownerUserId: 'owner',
      backupUserId: 'lead',
    });
    expect(notifications()).toEqual([
      expect.objectContaining({ userId: 'owner', push: { urgency: 'high' } }),
      expect.objectContaining({ userId: 'lead', type: 'ops_workitem_escalated' }),
    ]);

    // Level 2: Administración.
    const level2 = await escalate('system', { level: 2 });
    expect(level2.data).toMatchObject({ step: 'administracion', escalatedToUserId: 'admin' });
    expect(row()).toMatchObject({ escalationLevel: 2, backupUserId: 'admin' });

    // Level 3: critical SLA incident owned by Administración.
    const level3 = await escalate('system', { level: 3 });
    expect(level3.data).toMatchObject({ step: 'incident', applied: true });
    const [incident] = fake.rows('incident');
    expect(incident).toMatchObject({
      id: level3.data!.incidentId,
      kind: 'sla_breach',
      severity: 'critical',
      areaKey: 'logistica',
      caseId: 'case1',
      ownerUserId: 'admin',
      dedupeKey: 'sla_breach:work_item:wi1',
    });
    expect(row()).toMatchObject({ escalationLevel: 3, status: 'escalated' });

    expect(await escalate('system', { level: 4 })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
  });

  it('falls back to Administración when the area has no other lead', async () => {
    fake.rows('area').find((a) => a.key === 'logistica')!.leadUserId = null;
    fake.rows('responsible').find((r) => r.area === 'logistica')!.backupUserId = null;
    const result = await escalate('system', { level: 1 });
    expect(result.data).toMatchObject({ step: 'area_lead', escalatedToUserId: 'admin' });
    expect(row().backupUserId).toBe('admin');
  });

  it('replaces an inactive owner with the backup, or with the area assignee', async () => {
    userRow('owner').isActive = false;
    await escalate('system', { level: 0 });
    expect(row()).toMatchObject({ ownerUserId: 'backup', backupUserId: null });
    expect(fake.rows('operationalEvent')[0]).toMatchObject({
      type: 'workitem.reassigned',
      payload: expect.objectContaining({ reason: 'owner_inactive', previousOwnerUserId: 'owner' }),
    });

    seedWorkItem({ id: 'wi2' });
    userRow('backup').isActive = false;
    await run('system', WORK_ITEM_COMMANDS.escalate, { level: 0 }, { id: 'wi2' });
    // Neither responsible nor backup is active: the area lead takes it.
    expect(row('wi2')).toMatchObject({ ownerUserId: 'lead' });
  });

  it('lets the supervisor compute the level and skips straight to it', async () => {
    const result = await escalate('system');
    expect(result.data).toMatchObject({ level: 1, step: 'area_lead' });
    expect(eventTypes()).toEqual(['workitem.overdue', 'workitem.escalated']);

    seedWorkItem({ id: 'future', dueAt: new Date('2026-09-20T00:00:00Z') });
    expect(await run('system', WORK_ITEM_COMMANDS.escalate, {}, { id: 'future' })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
  });

  it('lets people escalate one level at a time and leaves the incident to managers', async () => {
    for (const expected of [0, 1, 2]) {
      const result = await escalate(users.owner);
      expect(result.data).toMatchObject({ level: expected, applied: true });
    }
    expect(await escalate(users.owner)).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    expect(await escalate(users.stranger)).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    expect((await escalate(users.manager)).data).toMatchObject({ level: 3, step: 'incident' });
  });

  it('follows a custom ladder from the configuration', async () => {
    fake.seed('integrationConfig', {
      source: 'operations',
      displayName: 'Operaciones',
      isEnabled: true,
      settings: {
        ...defaultOperationsSettings(NOW),
        escalation: { afterMinutes: [0], ladder: ['area_lead'] },
      },
    });
    const first = await escalate('system', { level: 0 });
    expect(first.data).toMatchObject({ step: 'area_lead', escalatedToUserId: 'lead' });
    const second = await escalate('system', { level: 1 });
    expect(second.data).toMatchObject({ step: 'incident' });
    expect(await escalate('system', { level: 2 })).toMatchObject({ errorCode: 'invalid_state' });
  });

  it('only escalates open items inside a command', async () => {
    await expect(
      escalateWorkItem(fake.client as unknown as Prisma.TransactionClient, 'wi1', 0)
    ).rejects.toMatchObject({ code: 'outside_command' });
    row().status = 'done';
    expect(await escalate('system', { level: 0 })).toMatchObject({ errorCode: 'invalid_state' });
  });
});

describe('work item reads', () => {
  beforeEach(() => {
    seedWorkItem({
      id: 'wi2',
      ownerUserId: 'backup',
      backupUserId: 'owner',
      dueAt: new Date('2026-09-15T13:00:00.000Z'),
      title: 'Confirmar ventana de entrega',
    });
    seedWorkItem({ id: 'wi3', status: 'done', dueAt: new Date('2026-09-14T12:00:00.000Z') });
    seedWorkItem({
      id: 'wi4',
      areaKey: 'inventario',
      dueAt: new Date('2026-09-16T12:00:00.000Z'),
      caseId: null,
    });
  });

  it('lists my open work, most urgent first, with pagination and filters', async () => {
    const all = await listMyWorkItems(users.owner, {}, { now: NOW });
    expect(all.items.map((i) => i.id)).toEqual(['wi1', 'wi2', 'wi4']);
    expect(all.items[0]).toMatchObject({
      caseNumber: 'EXP-000001',
      customerName: 'Constructora Norte',
      ownerName: 'Olga',
      backupName: 'Beto',
      areaLabel: 'Logística',
      kindLabel: 'Acción',
      statusLabel: 'Abierto',
      overdue: true,
    });

    const first = await listMyWorkItems(users.owner, { limit: 2 }, { now: NOW });
    expect(first.items.map((i) => i.id)).toEqual(['wi1', 'wi2']);
    const second = await listMyWorkItems(
      users.owner,
      { limit: 2, cursor: first.nextCursor! },
      { now: NOW }
    );
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items.map((i) => i.id)).toEqual(['wi4']);

    expect(
      (await listMyWorkItems(users.owner, { role: 'owner' }, { now: NOW })).items.map((i) => i.id)
    ).toEqual(['wi1', 'wi4']);
    expect(
      (await listMyWorkItems(users.owner, { scope: 'closed' }, { now: NOW })).items.map((i) => i.id)
    ).toEqual(['wi3']);
    expect(
      (await listMyWorkItems(users.owner, { overdueOnly: true }, { now: NOW })).items.map(
        (i) => i.id
      )
    ).toEqual(['wi1', 'wi2']);
    expect(
      (await listMyWorkItems(users.owner, { search: 'ventana' }, { now: NOW })).items.map(
        (i) => i.id
      )
    ).toEqual(['wi2']);
    await expect(listMyWorkItems(users.owner, { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('lists the work of an area only for those who can see it', async () => {
    const page = await listAreaWorkItems(users.viewer, 'logistica', {}, { now: NOW });
    expect(page.items.map((i) => i.id)).toEqual(['wi1', 'wi2']);
    await expect(listAreaWorkItems(users.lead, 'logistica')).resolves.toMatchObject({
      nextCursor: null,
    });
    await expect(listAreaWorkItems(users.stranger, 'logistica')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(listAreaWorkItems(users.viewer, 'bodega')).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('returns one work item with evidence and permissions, hiding it from outsiders', async () => {
    row().requiredEvidence = ['photo'];
    const forOwner = await getWorkItem(users.owner, 'wi1', { now: NOW });
    expect(forOwner).toMatchObject({
      missingEvidence: ['photo'],
      evidence: [],
      permissions: {
        canStart: true,
        canWait: true,
        canComplete: true,
        canReassign: true,
        canEscalate: true,
      },
    });
    const forViewer = await getWorkItem(users.viewer, 'wi1', { now: NOW });
    expect(forViewer.permissions).toEqual({
      canStart: false,
      canWait: false,
      canComplete: false,
      canReassign: false,
      canEscalate: false,
    });
    await expect(getWorkItem(users.seller, 'wi1')).resolves.toMatchObject({ id: 'wi1' });
    await expect(getWorkItem(users.stranger, 'wi1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(getWorkItem(users.viewer, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('missingEvidenceForWorkItems', () => {
  it('reports per open work item the evidence still missing, as the completion rule does', async () => {
    const created = new Date('2026-09-14T10:00:00.000Z');
    const dto = (id: string, fields: Record<string, unknown>) => ({
      id,
      stepId: null,
      objectType: null,
      objectId: null,
      createdAt: created.toISOString(),
      requiredEvidence: [] as string[],
      result: null as Record<string, unknown> | null,
      status: 'open',
      ...fields,
    });
    fake.seed('evidenceLink', { workItemId: 'wi_a', kind: 'photo', createdAt: new Date('2026-09-14T11:00:00.000Z') });
    const result = await missingEvidenceForWorkItems([
      dto('wi_a', { requiredEvidence: ['photo', 'signature'] }),
      dto('wi_b', { requiredEvidence: ['availability_result'], result: { availability_result: { ok: true } } }),
      dto('wi_c', { requiredEvidence: ['availability_result'] }),
      dto('wi_d', {}),
      dto('wi_e', { requiredEvidence: ['photo'], status: 'done' }),
    ]);
    expect(result.get('wi_a')).toEqual(['signature']);
    expect(result.get('wi_b')).toEqual([]);
    expect(result.get('wi_c')).toEqual(['availability_result']);
    expect(result.has('wi_d')).toBe(false);
    expect(result.has('wi_e')).toBe(false);
  });
});
