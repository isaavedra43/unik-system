import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Shared kit of the operations tools: bot scope, "act for an area", command ids,
 * command execution and the thin commands (handlers run with a fake tx/ctx).
 */

type Definition = {
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } };
  actorTypes?: readonly string[];
  handler: (tx: unknown, cmd: unknown, ctx: unknown) => Promise<{ data?: Record<string, unknown> } | void>;
};

const h = vi.hoisted(() => ({
  commands: new Map<string, unknown>(),
  executeCommand: vi.fn(),
  openOrReopenIncident: vi.fn(),
  reassignWorkItemInTx: vi.fn(),
  loadWorkItem: vi.fn(),
  requestApproval: vi.fn(),
  involvedAreasOfCase: vi.fn(async () => ['ventas', 'inventario']),
  loadActiveCurrentUser: vi.fn(),
  authorizeOperationsChannel: vi.fn(async () => false),
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/modules/operations/commands', () => ({
  registerCommand: (type: string, definition: unknown) => {
    h.commands.set(type, definition);
  },
  versionedAggregate: (type: string) => ({ type }),
  executeCommand: h.executeCommand,
}));
vi.mock('@/modules/operations/register-commands', () => ({}));
vi.mock('@/modules/operations/incidents-service', () => ({ openOrReopenIncident: h.openOrReopenIncident }));
vi.mock('@/modules/operations/work-items-service', () => ({
  loadWorkItem: h.loadWorkItem,
  reassignWorkItemInTx: h.reassignWorkItemInTx,
}));
vi.mock('@/modules/operations/approvals-service', () => ({ requestApproval: h.requestApproval }));
vi.mock('@/modules/agents/chat-bridge', () => ({ involvedAreasOfCase: h.involvedAreasOfCase }));
vi.mock('@/modules/auth/authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/authorization')>()),
  loadActiveCurrentUser: h.loadActiveCurrentUser,
}));
vi.mock('@/modules/operations/events-service', () => ({ authorizeOperationsChannel: h.authorizeOperationsChannel }));

import {
  AI_OPS_COMMANDS,
  OperationsToolError,
  assertCaseInAgentScope,
  botScopeOf,
  canActForArea,
  checkActingScope,
  checkReadingScope,
  creationCommandId,
  localDayKey,
  localDayStart,
  runOperationsCommand,
  transitionCommandId,
} from './operations-tool-kit';

const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/;

function person(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u-ana',
    username: 'ana',
    name: 'Ana',
    email: null,
    mustChangePassword: false,
    roleKeys: ['staff'],
    permissionKeys: ['operations.view'] as never,
    isSuperAdmin: false,
    ...overrides,
  };
}

function bot(area: string, permissions: string[] = []): CurrentUser {
  return person({
    id: `bot-${area}`,
    username: `ia_${area}`,
    name: `IA ${area}`,
    roleKeys: [`agent_${area}`],
    permissionKeys: ['chat.use', 'operations.view', ...permissions] as never,
    isBot: true,
  });
}

function fakeDb(data: {
  user?: { isActive: boolean; isBot: boolean } | null;
  opCase?: { id: string; status: string; caseNumber: string } | null;
  area?: { leadUserId: string | null; responsibleArea: string; chatChannelId: string | null } | null;
  responsible?: { userId: string; backupUserId: string | null; active: boolean } | null;
  member?: { id: string } | null;
  demand?: Record<string, unknown> | null;
  openWorkItem?: Record<string, unknown> | null;
  areaRequest?: Record<string, unknown> | null;
  causer?: { toId: string } | null;
} = {}) {
  return {
    user: { findUnique: vi.fn(async () => (data.user === undefined ? { isActive: true, isBot: false } : data.user)) },
    operationalCase: {
      findUnique: vi.fn(async () => (data.opCase === undefined ? { id: 'case-1', status: 'open', caseNumber: 'EXP-7' } : data.opCase)),
    },
    area: { findUnique: vi.fn(async () => data.area ?? null) },
    responsible: { findUnique: vi.fn(async () => data.responsible ?? null) },
    internalChatMember: { findFirst: vi.fn(async () => data.member ?? null) },
    caseDemand: { findUnique: vi.fn(async () => data.demand ?? null) },
    workItem: { findFirst: vi.fn(async () => data.openWorkItem ?? null) },
    areaRequest: { findUnique: vi.fn(async () => data.areaRequest ?? null) },
    objectRelation: { findFirst: vi.fn(async () => data.causer ?? null) },
  };
}

function fakeCtx(user: CurrentUser | null, actorType: 'user' | 'ai' | 'system') {
  return {
    actor: { type: actorType, id: user?.id ?? 'ops.system' },
    user,
    now: new Date('2026-09-15T16:00:00.000Z'),
    commandId: 'cmd-1',
    emit: vi.fn(),
    audit: vi.fn(),
    createAreaRequest: vi.fn(async (input: Record<string, unknown>) => ({
      request: {
        id: 'req-1',
        status: 'sent',
        kind: input.kind,
        fromAreaKey: input.fromAreaKey,
        toAreaKey: input.toAreaKey,
        ownerUserId: 'u-luis',
        backupUserId: null,
        dueAt: new Date('2026-09-15T20:00:00.000Z'),
        priority: 'high',
        blocksDelivery: true,
        version: 1,
      },
      workItem: { id: 'wi-1' },
    })),
    createWorkItem: vi.fn(async () => ({ id: 'wi-2', ownerUserId: 'u-luis', dueAt: new Date('2026-09-15T18:00:00.000Z'), version: 1 })),
    relate: vi.fn(async () => undefined),
  };
}

async function runHandler(type: string, payload: Record<string, unknown>, tx: unknown, ctx: ReturnType<typeof fakeCtx>, aggregateId = 'case-1') {
  const definition = h.commands.get(type) as Definition;
  const parsed = definition.schema.safeParse(payload);
  if (!parsed.success) throw new Error(`payload inválido: ${JSON.stringify(parsed.error)}`);
  return definition.handler(tx, { commandId: 'cmd-1', type, actor: ctx.actor, aggregate: { type: 'x', id: aggregateId }, payload: parsed.data }, ctx);
}

beforeEach(() => {
  h.executeCommand.mockReset();
  h.openOrReopenIncident.mockReset();
  h.reassignWorkItemInTx.mockReset();
  h.loadWorkItem.mockReset();
  h.requestApproval.mockReset();
  h.loadActiveCurrentUser.mockReset();
  h.authorizeOperationsChannel.mockReset().mockResolvedValue(false);
});

describe('bot scope (pure)', () => {
  it('recognises the bots by their fixed system role', () => {
    expect(botScopeOf(bot('compras'))).toBe('compras');
    expect(botScopeOf(bot('admin'))).toBe('admin');
    expect(botScopeOf(person())).toBeNull();
  });

  it('a person given an agent_* role is still a person (bot status comes from the AI identity flag)', () => {
    const disguised = person({ roleKeys: ['agent_admin', 'agent_inventario'] });
    expect(botScopeOf(disguised)).toBeNull();
    expect(checkActingScope(disguised, 'ventas')).toBeNull();
    expect(checkReadingScope(disguised, 'ventas')).toBeNull();
  });

  it('a coordinator acts only in its area and must agree with ctx.agentAreaKey', () => {
    expect(checkActingScope(bot('compras'), 'compras')).toBeNull();
    expect(checkActingScope(bot('compras'), 'inventario')).toMatch(/sólo puede actuar en Compras/);
    expect(checkActingScope(bot('compras'), 'compras', { agentAreaKey: 'inventario' })).toMatch(/no coincide/);
    expect(checkActingScope(bot('admin'), 'administracion', { agentAreaKey: 'admin' })).toBeNull();
    expect(checkActingScope(bot('admin'), 'ventas')).toMatch(/IA administradora/);
  });

  it('a person executing an approved agent proposal is bound to the proposal area', () => {
    expect(checkActingScope(person(), 'inventario')).toBeNull();
    expect(checkActingScope(person(), 'inventario', { agentAreaKey: 'compras' })).toMatch(/propuso la IA de Compras/);
    expect(checkActingScope(person(), 'administracion', { agentAreaKey: 'administracion' })).toBeNull();
  });

  it('coordinators read their own area; the administrator reads every area', () => {
    expect(checkReadingScope(bot('compras'), 'compras')).toBeNull();
    expect(checkReadingScope(bot('compras'), 'ventas')).toMatch(/sólo consulta/);
    expect(checkReadingScope(bot('admin'), 'ventas')).toBeNull();
    expect(checkReadingScope(person(), 'ventas')).toBeNull();
  });

  it('bots only read cases their area takes part in', async () => {
    await expect(assertCaseInAgentScope(bot('inventario'), 'case-1')).resolves.toBeUndefined();
    await expect(assertCaseInAgentScope(bot('compras'), 'case-1')).rejects.toThrow(/no involucra a Compras/);
    await expect(assertCaseInAgentScope(bot('admin'), 'case-1')).resolves.toBeUndefined();
    await expect(assertCaseInAgentScope(person(), 'case-1')).resolves.toBeUndefined();
  });
});

describe('canActForArea ("operations.<área>.act")', () => {
  it('accepts module permissions of the area, operations.manage and super admins', async () => {
    const db = fakeDb();
    expect(await canActForArea(person({ permissionKeys: ['inventory.count'] as never }), 'inventario', undefined, db as never)).toBeNull();
    expect(await canActForArea(person({ permissionKeys: ['operations.manage'] as never }), 'compras', undefined, db as never)).toBeNull();
    expect(await canActForArea(person({ isSuperAdmin: true }), 'contabilidad', undefined, db as never)).toBeNull();
  });

  it('accepts the area responsible, backup or lead and rejects everybody else', async () => {
    const responsibleDb = fakeDb({
      area: { leadUserId: null, responsibleArea: 'compras', chatChannelId: null },
      responsible: { userId: 'u-other', backupUserId: 'u-ana', active: true },
    });
    expect(await canActForArea(person(), 'compras', undefined, responsibleDb as never)).toBeNull();
    const leadDb = fakeDb({ area: { leadUserId: 'u-ana', responsibleArea: 'compras', chatChannelId: null } });
    expect(await canActForArea(person(), 'compras', undefined, leadDb as never)).toBeNull();
    const outsider = await canActForArea(person(), 'compras', undefined, fakeDb() as never);
    expect(outsider).toMatch(/No puedes actuar en nombre de Compras/);
  });

  it('membership of the area channel and view-only permissions never grant authority to act', async () => {
    const memberDb = fakeDb({ area: { leadUserId: null, responsibleArea: 'compras', chatChannelId: 'ch-1' }, member: { id: 'm1' } });
    expect(await canActForArea(person(), 'compras', undefined, memberDb as never)).toMatch(/No puedes actuar en nombre de Compras/);
    expect(memberDb.internalChatMember.findFirst).not.toHaveBeenCalled();
    const viewOnly = person({ permissionKeys: ['operations.view', 'sales_orders.view', 'inventory.view'] as never });
    expect(await canActForArea(viewOnly, 'ventas', undefined, fakeDb() as never)).toMatch(/No puedes actuar en nombre de Ventas/);
    expect(await canActForArea(viewOnly, 'inventario', undefined, fakeDb() as never)).toMatch(/No puedes actuar en nombre de Inventario/);
  });

  it('in a mention turn the bot acts only where the mentioning person may act', async () => {
    const mention = { agentAreaKey: 'compras', agentOnBehalfOfUserId: 'u-marta' };
    h.loadActiveCurrentUser.mockResolvedValueOnce(person({ id: 'u-marta', permissionKeys: ['operations.view'] as never }));
    expect(await canActForArea(bot('compras'), 'compras', mention, fakeDb() as never)).toMatch(/Quien mencionó a la IA no puede actuar en nombre de Compras/);
    h.loadActiveCurrentUser.mockResolvedValueOnce(person({ id: 'u-marta', permissionKeys: ['purchases.request', 'operations.manage'] as never }));
    expect(await canActForArea(bot('compras'), 'compras', mention, fakeDb() as never)).toBeNull();
    h.loadActiveCurrentUser.mockResolvedValueOnce(null);
    expect(await canActForArea(bot('compras'), 'compras', mention, fakeDb() as never)).toMatch(/ya no está activo/);
  });

  it('in a mention turn the bot reads only the room case or cases the person may open', async () => {
    const marta = person({ id: 'u-marta' });
    h.loadActiveCurrentUser.mockResolvedValue(marta);
    const mention = { agentAreaKey: 'inventario', agentOnBehalfOfUserId: 'u-marta', agentCaseId: 'case-1' };
    await expect(assertCaseInAgentScope(bot('inventario'), 'case-1', mention)).resolves.toBeUndefined();
    expect(h.authorizeOperationsChannel).not.toHaveBeenCalled();
    await expect(assertCaseInAgentScope(bot('inventario'), 'case-57', mention)).rejects.toThrow(/no tiene acceso a ese expediente/);
    h.authorizeOperationsChannel.mockResolvedValueOnce(true);
    await expect(assertCaseInAgentScope(bot('inventario'), 'case-57', mention)).resolves.toBeUndefined();
    expect(h.authorizeOperationsChannel).toHaveBeenLastCalledWith(marta, 'case', 'case-57');
  });

  it('a bot is limited to its area without looking at the database', async () => {
    const db = fakeDb();
    expect(await canActForArea(bot('compras'), 'compras', { agentAreaKey: 'compras' }, db as never)).toBeNull();
    expect(await canActForArea(bot('compras'), 'ventas', undefined, db as never)).toMatch(/sólo puede actuar/);
    expect(db.area.findUnique).not.toHaveBeenCalled();
  });
});

describe('dates and command ids', () => {
  it('uses the local day of Mexico City', () => {
    const lateEvening = new Date('2026-09-15T03:00:00.000Z'); // 21:00 of the 14th in Mexico City
    expect(localDayKey(lateEvening)).toBe('2026-09-14');
    expect(localDayStart(lateEvening).toISOString()).toBe('2026-09-14T06:00:00.000Z');
  });

  it('creations replay on the same day and approved proposals run under their own id', () => {
    const now = new Date('2026-09-15T16:00:00.000Z');
    const a = creationCommandId('openIncident', 'u-ana', { title: 'x', kind: 'sla_breach' }, undefined, now);
    const b = creationCommandId('openIncident', 'u-ana', { kind: 'sla_breach', title: 'x' }, undefined, now);
    const nextDay = creationCommandId('openIncident', 'u-ana', { kind: 'sla_breach', title: 'x' }, undefined, new Date('2026-09-16T16:00:00.000Z'));
    expect(a).toBe(b);
    expect(a).not.toBe(nextDay);
    expect(a).toMatch(COMMAND_ID_PATTERN);
    expect(creationCommandId('authorizePayment', 'u-ana', {}, { approvedProposalId: 'prop1' }, now, 'approval')).toBe('proposal:prop1:authorizePayment:approval');
    expect(transitionCommandId('startWorkItem')).not.toBe(transitionCommandId('startWorkItem'));
    expect(transitionCommandId('startWorkItem')).toMatch(COMMAND_ID_PATTERN);
    expect(transitionCommandId('reserveStock', { approvedProposalId: 'prop2' })).toBe('proposal:prop2:reserveStock');
  });
});

describe('runOperationsCommand', () => {
  it('executes as ai for bots and as user for people, and throws the message of a rejection', async () => {
    h.executeCommand.mockResolvedValueOnce({ status: 'completed', data: { ok: true } });
    await runOperationsCommand(bot('compras'), { commandId: 'c1', type: 't.x', aggregate: { type: 'a', id: '1' }, payload: {} });
    expect(h.executeCommand.mock.calls[0][0].actor).toEqual({ type: 'ai', id: 'bot-compras' });

    h.executeCommand.mockResolvedValueOnce({ status: 'rejected', errorCode: 'forbidden', message: 'No tienes permisos' });
    const failure = runOperationsCommand(person(), { commandId: 'c2', type: 't.x', aggregate: { type: 'a', id: '1' }, payload: {} });
    await expect(failure).rejects.toBeInstanceOf(OperationsToolError);
    expect(h.executeCommand.mock.calls[1][0].actor).toEqual({ type: 'user', id: 'u-ana' });
  });
});

describe('thin commands', () => {
  const request = {
    caseId: 'case-1',
    fromAreaKey: 'compras',
    toAreaKey: 'contabilidad',
    kind: 'payment_authorization',
    title: 'Pagar anticipo a Pisos del Norte',
    payload: { vendorId: 'v1', vendorName: 'Pisos del Norte', amount: 80000, currency: 'MXN', dueDate: '2026-09-20', reason: 'Anticipo' },
  };

  it('ai_ops.request.create lets a registered bot create requests from its own area only', async () => {
    const tx = fakeDb({ user: { isActive: true, isBot: true } });
    const ctx = fakeCtx(bot('compras'), 'ai');
    const out = await runHandler(AI_OPS_COMMANDS.createRequest, { ...request, scopeAreaKey: 'compras' }, tx, ctx);
    expect(ctx.createAreaRequest).toHaveBeenCalledWith(expect.objectContaining({ objectType: 'operational_case', objectId: 'case-1', fromAreaKey: 'compras' }));
    expect(out?.data).toMatchObject({ requestId: 'req-1', workItemId: 'wi-1', toAreaKey: 'contabilidad' });

    // The human who caused the turn is linked to the request.
    const causedCtx = fakeCtx(bot('compras'), 'ai');
    const causerTx = { ...fakeDb({ user: { isActive: true, isBot: false } }), user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === 'bot-compras' ? { isActive: true, isBot: true } : { isActive: true, isBot: false })) } };
    await runHandler(AI_OPS_COMMANDS.createRequest, { ...request, scopeAreaKey: 'compras', causedByUserId: 'u-marta' }, causerTx, causedCtx);
    expect(causedCtx.relate).toHaveBeenCalledWith({ type: 'area_request', id: 'req-1' }, { type: 'user', id: 'u-marta' }, 'caused_by');

    const wrongArea = runHandler(AI_OPS_COMMANDS.createRequest, { ...request, fromAreaKey: 'inventario' }, tx, fakeCtx(bot('compras'), 'ai'));
    await expect(wrongArea).rejects.toMatchObject({ code: 'forbidden' });

    const notABot = runHandler(AI_OPS_COMMANDS.createRequest, request, fakeDb({ user: { isActive: true, isBot: false } }), fakeCtx(bot('compras'), 'ai'));
    await expect(notABot).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('ai_ops.request.create rejects outsiders, closed cases, past due dates and a scope of another area', async () => {
    const outsider = runHandler(AI_OPS_COMMANDS.createRequest, request, fakeDb(), fakeCtx(person(), 'user'));
    await expect(outsider).rejects.toMatchObject({ code: 'forbidden' });

    const manager = person({ permissionKeys: ['operations.manage'] as never });
    const closed = runHandler(AI_OPS_COMMANDS.createRequest, request, fakeDb({ opCase: { id: 'case-1', status: 'closed', caseNumber: 'EXP-7' } }), fakeCtx(manager, 'user'));
    await expect(closed).rejects.toMatchObject({ code: 'invalid_state' });

    const past = runHandler(AI_OPS_COMMANDS.createRequest, { ...request, dueAt: '2026-09-01T10:00:00.000Z' }, fakeDb(), fakeCtx(manager, 'user'));
    await expect(past).rejects.toMatchObject({ code: 'invalid_payload' });

    const scoped = runHandler(AI_OPS_COMMANDS.createRequest, { ...request, scopeAreaKey: 'ventas' }, fakeDb(), fakeCtx(manager, 'user'));
    await expect(scoped).rejects.toMatchObject({ code: 'forbidden' });

    const system = runHandler(AI_OPS_COMMANDS.createRequest, request, fakeDb(), fakeCtx(null, 'system'));
    await expect(system).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('ai_ops.incident.open opens or reopens through the core with the reporter in the detail', async () => {
    h.openOrReopenIncident.mockResolvedValueOnce({
      incident: { id: 'inc-1', status: 'open', severity: 'high', ownerUserId: 'u-luis', version: 1 },
      created: true,
      reopened: false,
    });
    const ctx = fakeCtx(bot('logistica'), 'ai');
    const out = await runHandler(
      AI_OPS_COMMANDS.openIncident,
      { areaKey: 'logistica', kind: 'partial_delivery', severity: 'high', title: 'Entrega parcial', caseId: 'case-1', dedupeKey: 'ai:partial_delivery:case-1:abc' },
      fakeDb({ user: { isActive: true, isBot: true } }),
      ctx
    );
    expect(h.openOrReopenIncident).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'partial_delivery', areaKey: 'logistica', dedupeKey: 'ai:partial_delivery:case-1:abc', detail: expect.objectContaining({ source: 'ai_tool', reportedBy: { type: 'ai', id: 'bot-logistica' } }) })
    );
    expect(out?.data).toMatchObject({ incidentId: 'inc-1', created: true });
  });

  it('ai_ops.stock.request_verification never duplicates an open verification', async () => {
    const demand = { id: 'd1', caseId: 'case-1', status: 'planned', name: 'Loseta Perla' };
    const person1 = person({ permissionKeys: ['operations.manage'] as never });
    const existing = await runHandler(
      AI_OPS_COMMANDS.requestVerification,
      { caseId: 'case-1', demandId: 'd1', fromAreaKey: 'ventas' },
      fakeDb({ demand, openWorkItem: { id: 'wi-9', ownerUserId: 'u-luis', dueAt: new Date('2026-09-15T18:00:00.000Z') } }),
      fakeCtx(person1, 'user')
    );
    expect(existing?.data).toMatchObject({ workItemId: 'wi-9', created: false });

    const ctx = fakeCtx(person1, 'user');
    const created = await runHandler(AI_OPS_COMMANDS.requestVerification, { caseId: 'case-1', demandId: 'd1', fromAreaKey: 'ventas', reason: 'Cliente pide fecha' }, fakeDb({ demand }), ctx);
    expect(ctx.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({ areaKey: 'inventario', kind: 'verification', objectType: 'case_demand', objectId: 'd1', requiredEvidence: ['count'] }));
    expect(created?.data).toMatchObject({ workItemId: 'wi-2', created: true });
  });

  it('ai_ops.workitem.assign only reassigns work of the bot area to people of that area', async () => {
    const item = { id: 'wi-1', areaKey: 'inventario', status: 'open' };
    h.loadWorkItem.mockResolvedValue(item);
    h.reassignWorkItemInTx.mockResolvedValue({ id: 'wi-1', status: 'open', ownerUserId: 'u-luis', backupUserId: null, dueAt: new Date('2026-09-16T00:00:00.000Z') });
    const payload = { workItemId: 'wi-1', ownerUserId: 'u-luis' };

    const outsiderDb = fakeDb({ user: { isActive: true, isBot: true } });
    const outsider = runHandler(AI_OPS_COMMANDS.assignWorkItem, payload, outsiderDb, fakeCtx(bot('inventario'), 'ai'), 'wi-1');
    await expect(outsider).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.reassignWorkItemInTx).not.toHaveBeenCalled();

    const areaDb = fakeDb({
      user: { isActive: true, isBot: true },
      area: { leadUserId: null, responsibleArea: 'inventario', chatChannelId: null },
      responsible: { userId: 'u-luis', backupUserId: null, active: true },
    });
    const out = await runHandler(AI_OPS_COMMANDS.assignWorkItem, payload, areaDb, fakeCtx(bot('inventario'), 'ai'), 'wi-1');
    expect(h.reassignWorkItemInTx).toHaveBeenCalledWith(expect.anything(), item, expect.objectContaining({ ownerUserId: 'u-luis' }), { aggregate: true });
    expect(out?.data).toMatchObject({ workItemId: 'wi-1', ownerUserId: 'u-luis' });

    const otherArea = runHandler(AI_OPS_COMMANDS.assignWorkItem, payload, areaDb, fakeCtx(bot('compras'), 'ai'), 'wi-1');
    await expect(otherArea).rejects.toMatchObject({ code: 'forbidden' });
    expect((h.commands.get(AI_OPS_COMMANDS.assignWorkItem) as Definition).actorTypes).toEqual(['ai']);
  });
});
