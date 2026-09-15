import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake(),
    getCurrentSession: vi.fn(),
    runAssistant: vi.fn(),
    getConversation: vi.fn(),
    getOrCreateSurfaceConversation: vi.fn(),
    getSurfaceMode: vi.fn(),
    shouldRunAutoTurn: vi.fn(),
    listPendingProposals: vi.fn(),
    canViewArea: vi.fn(),
    authorizeOperationsChannel: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/authorization')>()),
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock('@/modules/ai/ai-orchestrator', () => ({ runAssistant: mocks.runAssistant }));
vi.mock('@/modules/ai/ai-sessions-service', () => ({ getConversation: mocks.getConversation }));
vi.mock('@/modules/ai/copilot-surfaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/ai/copilot-surfaces')>()),
  getOrCreateSurfaceConversation: mocks.getOrCreateSurfaceConversation,
  getSurfaceMode: mocks.getSurfaceMode,
  shouldRunAutoTurn: mocks.shouldRunAutoTurn,
}));
vi.mock('@/modules/extensions/proposals-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/extensions/proposals-service')>()),
  listPendingProposals: mocks.listPendingProposals,
}));
vi.mock('@/modules/operations/work-items-service', () => ({ canViewArea: mocks.canViewArea }));
vi.mock('@/modules/operations/events-service', () => ({
  authorizeOperationsChannel: mocks.authorizeOperationsChannel,
}));

import { areaMemberPermissionKeys } from '@/modules/agents/permissions';
import { makeCurrentUser } from '@/modules/operations/testing/fixtures';
import { GET as towerGet, POST as towerPost } from '../../admin/control-tower/api/copilot/route';
import { GET as areaGet, POST as areaPost } from './areas/[key]/copilot/route';
import { GET as caseGet, POST as casePost } from './cases/[id]/copilot/route';
import { GET as myWorkGet, POST as myWorkPost } from './mywork/copilot/route';

const perms = (...keys: string[]) => keys as CurrentUser['permissionKeys'];
const nobody = makeCurrentUser({ id: 'u-none', permissionKeys: perms('assistant.use') });
const noAssistant = makeCurrentUser({ id: 'u-noai', permissionKeys: perms('operations.view', 'operations.admin') });
const viewer = makeCurrentUser({ id: 'u-view', permissionKeys: perms('operations.view', 'assistant.use') });
const opsAdmin = makeCurrentUser({ id: 'u-admin', permissionKeys: perms('operations.admin', 'assistant.use') });

function req(path: string, body?: unknown): NextRequest {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

const keyParams = (key: string) => ({ params: Promise.resolve({ key }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

function signIn(user: CurrentUser | null) {
  mocks.getCurrentSession.mockResolvedValue(user ? { sessionId: 's1', user } : null);
}

async function* scripted() {
  yield { type: 'text', data: { content: 'Listo' } };
  yield { type: 'done', data: {} };
}

beforeEach(() => {
  mocks.fake.tables.clear();
  vi.clearAllMocks();
  signIn(viewer);
  mocks.getSurfaceMode.mockResolvedValue('on_demand');
  mocks.getOrCreateSurfaceConversation.mockResolvedValue({ id: 'conv-1', created: false });
  mocks.shouldRunAutoTurn.mockResolvedValue(true);
  mocks.runAssistant.mockImplementation(scripted);
  mocks.getConversation.mockResolvedValue({ conversation: { id: 'conv-1' }, messages: [] });
  mocks.listPendingProposals.mockResolvedValue([]);
  mocks.canViewArea.mockResolvedValue(false);
  mocks.authorizeOperationsChannel.mockResolvedValue(false);
});

describe('rutas de copiloto de operaciones: sesión', () => {
  it.each([
    ['GET área', () => areaGet(req('/a'), keyParams('inventario'))],
    ['POST área', () => areaPost(req('/a', { message: 'Hola' }), keyParams('inventario'))],
    ['GET expediente', () => caseGet(req('/c'), idParams('case-1'))],
    ['POST expediente', () => casePost(req('/c', { message: 'Hola' }), idParams('case-1'))],
    ['GET Mi trabajo', () => myWorkGet(req('/m'))],
    ['POST Mi trabajo', () => myWorkPost(req('/m', { message: 'Hola' }))],
    ['GET Control Tower', () => towerGet(req('/t'))],
    ['POST Control Tower', () => towerPost(req('/t', { message: 'Hola' }))],
  ])('%s sin sesión responde 401', async (_name, call) => {
    signIn(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(mocks.getOrCreateSurfaceConversation).not.toHaveBeenCalled();
    expect(mocks.runAssistant).not.toHaveBeenCalled();
  });
});

describe('rutas de copiloto de operaciones: acceso a la IA', () => {
  it.each([
    ['GET área', () => areaGet(req('/a'), keyParams('inventario'))],
    ['POST área', () => areaPost(req('/a', { message: 'Hola' }), keyParams('inventario'))],
    ['GET expediente', () => caseGet(req('/c'), idParams('case-1'))],
    ['POST expediente', () => casePost(req('/c', { message: 'Hola' }), idParams('case-1'))],
    ['GET Mi trabajo', () => myWorkGet(req('/m'))],
    ['POST Mi trabajo', () => myWorkPost(req('/m', { trigger: 'open' }))],
    ['GET Control Tower', () => towerGet(req('/t'))],
    ['POST Control Tower', () => towerPost(req('/t', { message: 'Hola' }))],
  ])('%s sin assistant.use responde 403 y nunca corre la IA', async (_name, call) => {
    signIn(noAssistant);
    mocks.authorizeOperationsChannel.mockResolvedValue(true);
    const res = await call();
    expect(res.status).toBe(403);
    expect(mocks.getOrCreateSurfaceConversation).not.toHaveBeenCalled();
    expect(mocks.runAssistant).not.toHaveBeenCalled();
  });

  it('sólo acepta modelos del catálogo o configurados (o auto)', async () => {
    const bad = await myWorkPost(req('/m', { message: 'Hola', model: 'modelo-carisimo-inventado' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_model' });
    expect(mocks.runAssistant).not.toHaveBeenCalled();
    const auto = await myWorkPost(req('/m', { message: 'Hola', model: 'auto' }));
    await auto.text();
    expect(auto.status).toBe(200);
    expect(mocks.runAssistant).toHaveBeenCalledTimes(1);
  });
});

describe('copiloto del área', () => {
  it('área desconocida 404; sin permiso del área 403 en GET y POST', async () => {
    expect((await areaGet(req('/a'), keyParams('marketing'))).status).toBe(404);
    signIn(nobody);
    expect((await areaGet(req('/a'), keyParams('inventario'))).status).toBe(403);
    expect((await areaPost(req('/a', { message: 'Hola' }), keyParams('inventario'))).status).toBe(403);
    expect(mocks.runAssistant).not.toHaveBeenCalled();
  });

  it('con operations.view abre el hilo del área', async () => {
    const res = await areaGet(req('/a?new=1'), keyParams('compras'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ conversationId: 'conv-1', mode: 'on_demand' });
    expect(mocks.getOrCreateSurfaceConversation).toHaveBeenCalledWith(viewer, { kind: 'area', id: 'compras' }, { threadId: null, createNew: true });
  });

  it('con el permiso del módulo conversa con el contexto de la tabla', async () => {
    const user = makeCurrentUser({ id: 'u-inv', permissionKeys: perms(areaMemberPermissionKeys('inventario')[0], 'assistant.use') });
    signIn(user);
    const res = await areaPost(req('/a', { message: '¿Qué verifico primero?', context: { total: 2 } }), keyParams('inventario'));
    expect(res.status).toBe(200);
    await res.text();
    expect(mocks.runAssistant.mock.calls[0][0].context).toEqual({
      page: '/app/areas/inventario/trabajo',
      areaKey: 'inventario',
      tableContext: { total: 2 },
    });
  });
});

describe('copiloto del expediente', () => {
  it('sin acceso al expediente 403', async () => {
    signIn(nobody);
    expect((await caseGet(req('/c'), idParams('case-1'))).status).toBe(403);
    expect((await casePost(req('/c', { message: 'Hola' }), idParams('case-1'))).status).toBe(403);
  });

  it('con acceso: 404 si no existe; si existe conversa con caseId', async () => {
    mocks.authorizeOperationsChannel.mockResolvedValue(true);
    expect((await caseGet(req('/c'), idParams('case-404'))).status).toBe(404);
    mocks.fake.seed('operationalCase', { id: 'case-1', caseNumber: 'EXP-1', lastActivityAt: new Date() });
    expect((await caseGet(req('/c'), idParams('case-1'))).status).toBe(200);
    const res = await casePost(req('/c', { message: '¿Qué detiene este expediente?' }), idParams('case-1'));
    await res.text();
    expect(mocks.runAssistant.mock.calls[0][0].context).toEqual({ page: '/app/operations/cases/case-1', caseId: 'case-1' });
  });
});

describe('copiloto de Mi trabajo', () => {
  it('cualquier usuario con sesión tiene su propio hilo', async () => {
    signIn(nobody);
    const res = await myWorkGet(req('/m'));
    expect(res.status).toBe(200);
    expect(mocks.getOrCreateSurfaceConversation).toHaveBeenCalledWith(nobody, { kind: 'mywork', id: 'u-none' }, { threadId: null, createNew: false });
    const post = await myWorkPost(req('/m', { message: '¿Qué hago primero?' }));
    await post.text();
    expect(mocks.runAssistant.mock.calls[0][0]).toMatchObject({ actor: nobody, context: { page: '/app/mywork', myWork: true } });
  });
});

describe('copiloto del Control Tower', () => {
  it('sin operations.admin 403 aunque tenga operations.view', async () => {
    expect((await towerGet(req('/t'))).status).toBe(403);
    expect((await towerPost(req('/t', { message: 'Hola' }))).status).toBe(403);
  });

  it('con operations.admin conversa sobre la empresa', async () => {
    signIn(opsAdmin);
    expect((await towerGet(req('/t'))).status).toBe(200);
    expect(mocks.getOrCreateSurfaceConversation).toHaveBeenCalledWith(opsAdmin, { kind: 'control_tower', id: 'company' }, { threadId: null, createNew: false });
    const res = await towerPost(req('/t', { message: '¿Qué está atorado?' }));
    await res.text();
    expect(mocks.runAssistant.mock.calls[0][0].context).toEqual({ page: '/app/admin/control-tower', controlTower: true });
  });
});
