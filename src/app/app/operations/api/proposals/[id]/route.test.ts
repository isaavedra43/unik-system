import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Decision route of AI proposals from the operations surfaces. The real
 * proposals-service decides the approver scope (proposer, listed responsible,
 * scope permission, bots never, second signature); Prisma is the in-memory
 * FakePrisma and the tool registry is scripted, so no tool really runs.
 */

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake(),
    getCurrentSession: vi.fn(),
    tools: new Map<string, Record<string, unknown>>(),
    executeTool: vi.fn(),
    addMessage: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/authorization')>()),
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock('@/modules/ai/tools/registry', () => ({
  getToolDefinition: (name: string) => mocks.tools.get(name),
  executeTool: mocks.executeTool,
}));
vi.mock('@/modules/extensions/external-tools', () => ({ refreshExternalTools: vi.fn(async () => undefined) }));
vi.mock('@/modules/ai/ai-sessions-service', () => ({ addMessage: mocks.addMessage }));

import { computeProposalHash } from '@/modules/extensions/proposals-service';
import { makeCurrentUser, seedUser } from '@/modules/operations/testing/fixtures';
import { POST } from './route';

const { fake } = mocks;
const perms = (...keys: string[]) => keys as CurrentUser['permissionKeys'];

const responsible = makeCurrentUser({ id: 'u-resp', username: 'ana' });
const backup = makeCurrentUser({ id: 'u-backup', username: 'luis' });
const manager = makeCurrentUser({ id: 'u-mgr', username: 'marta', permissionKeys: perms('operations.manage') });
const stranger = makeCurrentUser({ id: 'u-otro', username: 'otro', permissionKeys: perms('operations.view') });
const bot = makeCurrentUser({ id: 'bot-inv', username: 'ia_inventario', roleKeys: ['agent_inventario'] });

const ARGS = { sku: 'LP-01', quantity: 15, unit: 'm2' };
const SCOPE = { caseId: 'case-1', areaKey: 'inventario', userIds: ['u-resp', 'u-backup'], permission: 'operations.manage' };

function registerTool(overrides: Record<string, unknown> = {}) {
  mocks.tools.set('reserveStock', { name: 'reserveStock', version: '1', category: 'operations', ...overrides });
}

function seedProposal(overrides: Record<string, unknown> = {}) {
  const argsHash = computeProposalHash({
    toolName: 'reserveStock',
    toolVersion: '1',
    connectionId: null,
    args: ARGS,
    recipient: null,
    fileIds: [],
    contextHash: null,
  });
  return fake.seed('aiProposal', {
    id: 'prop-1',
    conversationId: null,
    messageId: null,
    userId: 'bot-inv',
    toolName: 'reserveStock',
    toolVersion: '1',
    capabilityId: null,
    connectionId: null,
    argsHash,
    args: ARGS,
    summary: 'Reservar 15 m² de Loseta Perla para EXP-1',
    recipient: null,
    fileIds: [],
    contextHash: null,
    effect: 'business_write',
    status: 'pending',
    decisionBy: null,
    decidedAt: null,
    approverScope: SCOPE,
    secondDecisionBy: null,
    secondDecidedAt: null,
    executedAt: null,
    result: null,
    error: null,
    expiresAt: new Date(Date.now() + 60 * 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

function decide(user: CurrentUser | null, body: unknown, id = 'prop-1') {
  mocks.getCurrentSession.mockResolvedValue(user ? { sessionId: 's1', user } : null);
  const request = new Request(`http://localhost/app/operations/api/proposals/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest, { params: Promise.resolve({ id }) });
}

const row = () => fake.rows('aiProposal').find((r) => r.id === 'prop-1')!;

beforeEach(() => {
  fake.tables.clear();
  mocks.tools.clear();
  vi.clearAllMocks();
  for (const id of ['u-resp', 'u-backup', 'u-mgr', 'u-otro']) seedUser(fake, { id });
  seedUser(fake, { id: 'bot-inv', isBot: true });
  registerTool();
  mocks.executeTool.mockResolvedValue({ success: true, result: { reservationId: 'res-1' }, durationMs: 4 });
});

describe('POST /app/operations/api/proposals/[id]', () => {
  it('sin sesión 401; decisión inválida 400; id raro 404', async () => {
    seedProposal();
    expect((await decide(null, { decision: 'approve' })).status).toBe(401);
    expect((await decide(responsible, { decision: 'maybe' })).status).toBe(400);
    expect((await decide(responsible, {})).status).toBe(400);
    expect((await decide(responsible, { decision: 'approve' }, 'prop 1!')).status).toBe(404);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it('alguien fuera del alcance no la ve (404) y nada se ejecuta', async () => {
    seedProposal();
    expect((await decide(stranger, { decision: 'approve' })).status).toBe(404);
    expect((await decide(stranger, { decision: 'reject', reason: 'no' })).status).toBe(404);
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(row().status).toBe('pending');
  });

  it('el responsable del alcance aprueba y la tool corre como esa persona con el alcance', async () => {
    seedProposal();
    const res = await decide(responsible, { decision: 'approve' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ proposal: { id: 'prop-1', status: 'executed' }, execution: { success: true } });
    expect(json.execution.result).toMatchObject({ reservationId: 'res-1' });
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    const [toolName, actor, args, ctx] = mocks.executeTool.mock.calls[0];
    expect(toolName).toBe('reserveStock');
    expect(actor).toBe(responsible);
    expect(args).toEqual(ARGS);
    expect(ctx).toMatchObject({ approverScope: SCOPE, agentAreaKey: 'inventario', skipApproval: true });
  });

  it('quien tiene el permiso del alcance puede rechazar con motivo', async () => {
    seedProposal();
    const res = await decide(manager, { decision: 'reject', reason: 'Ya se reservó a mano' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ proposal: { status: 'rejected' } });
    expect(row()).toMatchObject({ status: 'rejected', decisionBy: 'u-mgr', error: 'Ya se reservó a mano' });
  });

  it('un bot nunca decide, ni sus propias propuestas', async () => {
    seedProposal();
    expect((await decide(bot, { decision: 'approve' })).status).toBe(403);
    expect((await decide(bot, { decision: 'reject' })).status).toBe(403);
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expect(row().status).toBe('pending');
  });

  it('doble firma: la primera no ejecuta, la misma persona no firma dos veces, otra con permiso completa', async () => {
    registerTool({ requiresSecondApproval: true });
    seedProposal();

    const first = await decide(responsible, { decision: 'approve' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      proposal: { status: 'awaiting_second_approval', awaitingSecondApproval: true },
      execution: { success: false, errorCode: 'awaiting_second_approval' },
    });
    expect(mocks.executeTool).not.toHaveBeenCalled();

    expect((await decide(responsible, { decision: 'approve' })).status).toBe(403);
    expect((await decide(backup, { decision: 'approve' })).status).toBe(403);
    expect(mocks.executeTool).not.toHaveBeenCalled();

    const second = await decide(manager, { decision: 'approve' });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ proposal: { status: 'executed', secondDecisionBy: 'u-mgr' } });
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
  });

  it('ya procesada responde 409 y vencida 410', async () => {
    seedProposal({ status: 'executed' });
    expect((await decide(responsible, { decision: 'approve' })).status).toBe(409);

    fake.tables.clear();
    for (const id of ['u-resp']) seedUser(fake, { id });
    seedProposal({ expiresAt: new Date(Date.now() - 60_000) });
    expect((await decide(responsible, { decision: 'approve' })).status).toBe(410);
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});
