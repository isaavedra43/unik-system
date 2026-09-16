import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  class FakeProposalError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ProposalError';
      this.status = status;
    }
  }
  return {
    fake: createOpsFake(),
    FakeProposalError,
    getCurrentSession: vi.fn(),
    runAssistant: vi.fn(),
    getConversation: vi.fn(),
    getOrCreateSurfaceConversation: vi.fn(),
    getSurfaceMode: vi.fn(),
    listSurfaceConversations: vi.fn(),
    shouldRunAutoTurn: vi.fn(),
    listPendingProposals: vi.fn(),
    listProposalsForScope: vi.fn(),
    canViewArea: vi.fn(),
    authorizeOperationsChannel: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/authorization')>()),
  getCurrentSession: mocks.getCurrentSession,
}));
// The ONE assistant is scripted: no provider is called.
vi.mock('@/modules/ai/ai-orchestrator', () => ({ runAssistant: mocks.runAssistant }));
vi.mock('@/modules/ai/ai-sessions-service', () => ({ getConversation: mocks.getConversation }));
vi.mock('@/modules/ai/copilot-surfaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/ai/copilot-surfaces')>()),
  getOrCreateSurfaceConversation: mocks.getOrCreateSurfaceConversation,
  getSurfaceMode: mocks.getSurfaceMode,
  listSurfaceConversations: mocks.listSurfaceConversations,
  shouldRunAutoTurn: mocks.shouldRunAutoTurn,
}));
vi.mock('@/modules/extensions/proposals-service', () => ({
  listPendingProposals: mocks.listPendingProposals,
  listProposalsForScope: mocks.listProposalsForScope,
  toProposalDTO: (p: { id: string }) => ({ id: p.id }),
  ProposalError: mocks.FakeProposalError,
}));
vi.mock('@/modules/operations/work-items-service', () => ({ canViewArea: mocks.canViewArea }));
vi.mock('@/modules/operations/events-service', () => ({
  authorizeOperationsChannel: mocks.authorizeOperationsChannel,
}));

import { areaMemberPermissionKeys } from '@/modules/agents/permissions';
import { AUTO_PREFIX } from '@/modules/ai/copilot-surfaces';
import { OperationsError } from '@/modules/operations/errors';
import { makeCurrentUser } from '@/modules/operations/testing/fixtures';
import {
  COPILOT_MAX_BODY_CHARS,
  CONTROL_TOWER_SCOPE,
  OperationsCopilotError,
  areaActivityAnchor,
  areaSurfaceSpec,
  caseActivityAnchor,
  caseSurfaceSpec,
  checkAreaCopilotAccess,
  checkCaseCopilotAccess,
  checkControlTowerAccess,
  companyActivityAnchor,
  controlTowerSurfaceSpec,
  handleSurfaceGet,
  handleSurfacePost,
  myWorkActivityAnchor,
  myWorkSurfaceSpec,
  operationsCopilotErrorResponse,
  planSurfaceTurn,
  readCopilotJson,
  requireOperationsUser,
  surfaceTurnContext,
  type OperationsSurfaceSpec,
} from './_copilot-shared';

const { fake } = mocks;
const perms = (...keys: string[]) => keys as CurrentUser['permissionKeys'];

const viewer = makeCurrentUser({ id: 'u-view', permissionKeys: perms('operations.view') });
const nobody = makeCurrentUser({ id: 'u-none' });
const admin = makeCurrentUser({ id: 'u-admin', permissionKeys: perms('operations.admin') });
const superAdmin = makeCurrentUser({ id: 'u-root', isSuperAdmin: true });

const ANCHOR = new Date('2026-09-15T10:00:00.000Z');

function testSpec(): OperationsSurfaceSpec {
  return { ...areaSurfaceSpec('inventario'), anchor: vi.fn(async () => ANCHOR) };
}

function postRequest(body: unknown, raw?: string): Request {
  return new Request('http://localhost/app/operations/api/areas/inventario/copilot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

async function* scripted(...events: unknown[]) {
  for (const event of events) yield event;
}

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  mocks.getSurfaceMode.mockResolvedValue('active');
  mocks.getOrCreateSurfaceConversation.mockResolvedValue({ id: 'conv-1', created: false });
  mocks.shouldRunAutoTurn.mockResolvedValue(true);
  mocks.runAssistant.mockImplementation(() =>
    scripted(
      { type: 'text', data: { content: 'Hay 2 verificaciones vencidas' } },
      { type: 'done', data: {} }
    )
  );
  mocks.getConversation.mockResolvedValue({
    conversation: { id: 'conv-1' },
    messages: [{ id: 'm1', role: 'user' }],
  });
  mocks.listPendingProposals.mockResolvedValue([
    { id: 'p1', createdAt: new Date('2026-09-15T09:00:00.000Z') },
  ]);
  mocks.listProposalsForScope.mockResolvedValue([]);
  mocks.listSurfaceConversations.mockResolvedValue([{ id: 'conv-1', title: 'Copiloto del área' }]);
  mocks.canViewArea.mockResolvedValue(false);
  mocks.authorizeOperationsChannel.mockResolvedValue(false);
});

describe('sesión y errores', () => {
  it('sin sesión responde 401', async () => {
    mocks.getCurrentSession.mockResolvedValue(null);
    const auth = await requireOperationsUser();
    expect('response' in auth && auth.response.status).toBe(401);
    mocks.getCurrentSession.mockResolvedValue({ sessionId: 's', user: nobody });
    expect(await requireOperationsUser()).toEqual({ user: nobody });
  });

  it('mapea cada tipo de error sin filtrar detalles internos', async () => {
    const own = operationsCopilotErrorResponse(
      new OperationsCopilotError('Muy grande', 413, 'payload_too_large')
    );
    expect(own.status).toBe(413);
    expect(await own.json()).toEqual({ error: 'Muy grande', code: 'payload_too_large' });

    expect(
      operationsCopilotErrorResponse(new mocks.FakeProposalError('Propuesta no encontrada', 404))
        .status
    ).toBe(404);

    const core = operationsCopilotErrorResponse(
      new OperationsError('forbidden', 'No tienes acceso')
    );
    expect(core.status).toBe(403);
    expect(await core.json()).toEqual({ error: 'No tienes acceso', code: 'forbidden' });

    const zod = z.string().safeParse(1);
    expect(operationsCopilotErrorResponse(!zod.success ? zod.error : null).status).toBe(400);

    const crash = operationsCopilotErrorResponse(new Error('password=hunter2'));
    expect(crash.status).toBe(500);
    expect(JSON.stringify(await crash.json())).not.toContain('hunter2');
  });

  it('lee JSON vacío, inválido y demasiado grande', async () => {
    expect(await readCopilotJson(postRequest(null, ''))).toEqual({});
    await expect(readCopilotJson(postRequest(null, '{no'))).rejects.toMatchObject({ status: 400 });
    await expect(
      readCopilotJson(postRequest(null, 'x'.repeat(COPILOT_MAX_BODY_CHARS + 1)))
    ).rejects.toMatchObject({
      status: 413,
    });
  });
});

describe('acceso a las superficies', () => {
  it('área: llave inválida 404, operations.view, permiso del módulo o canViewArea', async () => {
    expect((await checkAreaCopilotAccess(viewer, 'marketing'))?.status).toBe(404);
    expect(await checkAreaCopilotAccess(viewer, 'inventario')).toBeNull();
    expect(mocks.canViewArea).not.toHaveBeenCalled();

    const moduleKey = areaMemberPermissionKeys('inventario')[0];
    expect(moduleKey).toBeDefined();
    expect(
      await checkAreaCopilotAccess(
        makeCurrentUser({ id: 'u-inv', permissionKeys: perms(moduleKey) }),
        'inventario'
      )
    ).toBeNull();

    const denied = await checkAreaCopilotAccess(nobody, 'inventario');
    expect(denied?.status).toBe(403);
    expect(mocks.canViewArea).toHaveBeenCalledWith(nobody, 'inventario');

    mocks.canViewArea.mockResolvedValue(true);
    expect(await checkAreaCopilotAccess(nobody, 'compras')).toBeNull();
  });

  it('expediente: 403 sin acceso aunque no exista; 404 si existe el acceso pero no el expediente', async () => {
    expect((await checkCaseCopilotAccess(viewer, 'caso con espacios'))?.status).toBe(404);
    expect((await checkCaseCopilotAccess(nobody, 'case-1'))?.status).toBe(403);

    mocks.authorizeOperationsChannel.mockResolvedValue(true);
    expect((await checkCaseCopilotAccess(viewer, 'case-404'))?.status).toBe(404);
    fake.seed('operationalCase', { id: 'case-1', caseNumber: 'EXP-1', lastActivityAt: ANCHOR });
    expect(await checkCaseCopilotAccess(viewer, 'case-1')).toBeNull();
    expect(mocks.authorizeOperationsChannel).toHaveBeenCalledWith(viewer, 'case', 'case-1');
  });

  it('Control Tower exige operations.admin', () => {
    expect(checkControlTowerAccess(nobody)?.status).toBe(403);
    expect(checkControlTowerAccess(viewer)?.status).toBe(403);
    expect(checkControlTowerAccess(admin)).toBeNull();
    expect(checkControlTowerAccess(superAdmin)).toBeNull();
  });
});

describe('anclas de la regla anti-bucle', () => {
  const at = (iso: string) => new Date(iso);
  const event = (id: number, fields: Record<string, unknown>) =>
    fake.seed('operationalEvent', { id: BigInt(id), actorType: 'user', payload: {}, ...fields });

  it('área: último evento del área que no sea de la IA', async () => {
    expect((await areaActivityAnchor('inventario')).getTime()).toBe(0);
    event(1, {
      areaKey: 'inventario',
      type: 'request.created',
      occurredAt: at('2026-09-15T10:00:00Z'),
      recordedAt: at('2026-09-15T10:00:00Z'),
    });
    event(2, {
      areaKey: 'inventario',
      type: 'ai.turn',
      occurredAt: at('2026-09-15T11:00:00Z'),
      recordedAt: at('2026-09-15T11:00:00Z'),
    });
    event(3, {
      areaKey: 'compras',
      type: 'request.created',
      occurredAt: at('2026-09-15T12:00:00Z'),
      recordedAt: at('2026-09-15T12:00:00Z'),
    });
    expect((await areaActivityAnchor('inventario')).toISOString()).toBe('2026-09-15T10:00:00.000Z');
  });

  it('expediente: último evento o, sin eventos, su última actividad', async () => {
    expect((await caseActivityAnchor('case-x')).getTime()).toBe(0);
    fake.seed('operationalCase', {
      id: 'case-1',
      caseNumber: 'EXP-1',
      lastActivityAt: at('2026-09-14T09:00:00Z'),
    });
    expect((await caseActivityAnchor('case-1')).toISOString()).toBe('2026-09-14T09:00:00.000Z');
    event(1, {
      caseId: 'case-1',
      type: 'step.completed',
      occurredAt: at('2026-09-15T08:00:00Z'),
      recordedAt: at('2026-09-15T08:00:00Z'),
    });
    event(2, {
      caseId: 'case-1',
      type: 'ai.turn_skipped',
      occurredAt: at('2026-09-15T09:00:00Z'),
      recordedAt: at('2026-09-15T09:00:00Z'),
    });
    expect((await caseActivityAnchor('case-1')).toISOString()).toBe('2026-09-15T08:00:00.000Z');
  });

  it('Mi trabajo: último cambio de sus trabajos abiertos hecho por otra persona o el sistema (nunca por ella misma)', async () => {
    expect((await myWorkActivityAnchor('u-ana')).getTime()).toBe(0);
    const work = (id: string, fields: Record<string, unknown>) =>
      fake.seed('workItem', {
        id,
        areaKey: 'inventario',
        kind: 'action',
        title: id,
        ownerUserId: 'u-otro',
        status: 'open',
        dueAt: at('2026-09-16T00:00:00Z'),
        createdAt: at('2026-09-01T00:00:00Z'),
        ...fields,
      });
    work('w1', { ownerUserId: 'u-ana' });
    work('w2', { backupUserId: 'u-ana' });
    work('w3', {});
    work('w4', { ownerUserId: 'u-ana', status: 'done' });
    const onItem = (id: number, objectId: string, fields: Record<string, unknown>) =>
      event(id, {
        objectType: 'work_item',
        objectId,
        type: 'workitem.reassigned',
        recordedAt: fields.occurredAt,
        ...fields,
      });
    onItem(1, 'w1', { actorId: 'u-jefe', occurredAt: at('2026-09-15T08:00:00Z') });
    onItem(2, 'w2', { actorType: 'system', actorId: null, occurredAt: at('2026-09-15T09:30:00Z') });
    // Her own actions, AI events, other people's work and closed work never move the anchor.
    onItem(3, 'w1', {
      actorId: 'u-ana',
      type: 'workitem.completed',
      occurredAt: at('2026-09-15T10:00:00Z'),
    });
    onItem(4, 'w2', {
      actorType: 'ai',
      actorId: 'bot',
      type: 'ai.turn',
      occurredAt: at('2026-09-15T10:30:00Z'),
    });
    onItem(5, 'w3', { actorId: 'u-jefe', occurredAt: at('2026-09-15T11:00:00Z') });
    onItem(6, 'w4', { actorId: 'u-jefe', occurredAt: at('2026-09-15T11:30:00Z') });
    expect((await myWorkActivityAnchor('u-ana')).toISOString()).toBe('2026-09-15T09:30:00.000Z');
  });

  it('Control Tower: último evento registrado de la empresa', async () => {
    event(1, {
      type: 'case.created',
      occurredAt: at('2026-09-15T08:00:00Z'),
      recordedAt: at('2026-09-15T08:00:05Z'),
    });
    event(2, {
      type: 'ai.turn',
      occurredAt: at('2026-09-15T09:00:00Z'),
      recordedAt: at('2026-09-15T09:00:05Z'),
    });
    expect((await companyActivityAnchor()).toISOString()).toBe('2026-09-15T08:00:05.000Z');
  });
});

describe('superficies', () => {
  it('fija tipo, anfitrión, página y contexto de cada superficie', () => {
    expect(areaSurfaceSpec('compras')).toMatchObject({
      surface: { kind: 'area', id: 'compras' },
      page: '/app/areas/compras/trabajo',
      context: { areaKey: 'compras' },
    });
    expect(caseSurfaceSpec('case-1')).toMatchObject({
      surface: { kind: 'case', id: 'case-1' },
      page: '/app/operations/cases/case-1',
      context: { caseId: 'case-1' },
    });
    expect(myWorkSurfaceSpec(nobody)).toMatchObject({
      surface: { kind: 'mywork', id: 'u-none' },
      page: '/app/mywork',
      context: { myWork: true },
    });
    expect(controlTowerSurfaceSpec()).toMatchObject({
      surface: { kind: 'control_tower', id: CONTROL_TOWER_SCOPE },
      context: { controlTower: true },
    });
  });

  it('el contexto de tabla sólo viaja si el cliente lo manda', () => {
    const spec = areaSurfaceSpec('inventario');
    expect(surfaceTurnContext(spec, {})).toEqual({
      page: '/app/areas/inventario/trabajo',
      areaKey: 'inventario',
    });
    expect(surfaceTurnContext(spec, { context: { total: 3 } })).toMatchObject({
      tableContext: { total: 3 },
    });
  });
});

describe('handleSurfaceGet', () => {
  const spec = areaSurfaceSpec('inventario');

  it('?list=1 devuelve los hilos del usuario en la superficie', async () => {
    const res = await handleSurfaceGet(new Request('http://localhost/x?list=1'), viewer, spec);
    expect(await res.json()).toEqual({ threads: [{ id: 'conv-1', title: 'Copiloto del área' }] });
    expect(mocks.listSurfaceConversations).toHaveBeenCalledWith(viewer, {
      kind: 'area',
      id: 'inventario',
    });
  });

  it('abre el hilo pedido o uno nuevo y devuelve modo, mensajes y propuestas', async () => {
    const res = await handleSurfaceGet(
      new Request('http://localhost/x?thread=t-9&new=1'),
      viewer,
      spec
    );
    expect(mocks.getOrCreateSurfaceConversation).toHaveBeenCalledWith(
      viewer,
      { kind: 'area', id: 'inventario' },
      { threadId: 't-9', createNew: true }
    );
    expect(mocks.getSurfaceMode).toHaveBeenCalledWith('u-view', 'area');
    expect(mocks.listPendingProposals).toHaveBeenCalledWith('u-view', 'conv-1');
    expect(await res.json()).toEqual({
      conversationId: 'conv-1',
      mode: 'active',
      messages: [{ id: 'm1', role: 'user' }],
      proposals: [{ id: 'p1' }],
    });
  });

  it('los errores del núcleo conservan su estado', async () => {
    mocks.getOrCreateSurfaceConversation.mockRejectedValue(new OperationsError('forbidden', 'No'));
    expect((await handleSurfaceGet(new Request('http://localhost/x'), viewer, spec)).status).toBe(
      403
    );
  });

  /**
   * Plan 5.4: «`listProposalsForScope(actor, caseId)` alimenta la sala». La propuesta de un
   * agente nace en la conversación del BOT, así que el hilo propio nunca la trae: sin el alcance
   * la sala del expediente y el centro de trabajo del área se quedaban sin ella.
   */
  describe('propuestas del alcance', () => {
    const scoped = (id: string, iso: string) => ({ id, createdAt: new Date(iso) });

    it('el expediente suma las propuestas del alcance y las ordena por fecha', async () => {
      mocks.listProposalsForScope.mockResolvedValue([
        scoped('p-agente', '2026-09-15T11:00:00.000Z'),
        scoped('p-vieja', '2026-09-15T08:00:00.000Z'),
      ]);
      const res = await handleSurfaceGet(
        new Request('http://localhost/x'),
        viewer,
        caseSurfaceSpec('case-1')
      );
      expect(mocks.listProposalsForScope).toHaveBeenCalledWith(viewer, { caseId: 'case-1' });
      expect((await res.json()).proposals).toEqual([
        { id: 'p-agente' },
        { id: 'p1' },
        { id: 'p-vieja' },
      ]);
    });

    it('el área pide su alcance por areaKey y no duplica la que ya estaba en el hilo', async () => {
      mocks.listProposalsForScope.mockResolvedValue([
        scoped('p1', '2026-09-15T09:00:00.000Z'),
        scoped('p-area', '2026-09-15T12:00:00.000Z'),
      ]);
      const res = await handleSurfaceGet(new Request('http://localhost/x'), viewer, spec);
      expect(mocks.listProposalsForScope).toHaveBeenCalledWith(viewer, { areaKey: 'inventario' });
      expect((await res.json()).proposals).toEqual([{ id: 'p-area' }, { id: 'p1' }]);
    });

    it('Mi trabajo y la Torre de Control no tienen alcance de sala: siguen con su hilo', async () => {
      await handleSurfaceGet(new Request('http://localhost/x'), viewer, myWorkSurfaceSpec(viewer));
      await handleSurfaceGet(new Request('http://localhost/x'), admin, controlTowerSurfaceSpec());
      expect(mocks.listProposalsForScope).not.toHaveBeenCalled();
      expect(mocks.listPendingProposals).toHaveBeenCalledTimes(2);
    });
  });
});

describe('planSurfaceTurn', () => {
  it.each([
    [{ message: 'Hola', trigger: 'open' }],
    [{}],
    [{ trigger: 'interpret_request' }],
    [{ message: 'x'.repeat(8001) }],
  ])('rechaza cuerpos inválidos con 400 (%j)', async (body) => {
    const plan = await planSurfaceTurn(postRequest(body), viewer, testSpec());
    expect(plan.kind === 'response' && plan.response.status).toBe(400);
    expect(mocks.getOrCreateSurfaceConversation).not.toHaveBeenCalled();
  });

  it('en pausa responde 409 con el mensaje de la superficie', async () => {
    mocks.getSurfaceMode.mockResolvedValue('paused');
    const spec = testSpec();
    const plan = await planSurfaceTurn(postRequest({ message: 'Hola' }), viewer, spec);
    expect(plan.kind).toBe('response');
    if (plan.kind !== 'response') return;
    expect(plan.response.status).toBe(409);
    expect(await plan.response.json()).toEqual({ error: spec.pausedMessage, code: 'paused' });
  });

  it('un disparo automático fuera de modo activo se salta', async () => {
    mocks.getSurfaceMode.mockResolvedValue('on_demand');
    const plan = await planSurfaceTurn(postRequest({ trigger: 'open' }), viewer, testSpec());
    expect(plan.kind === 'response' && (await plan.response.json())).toEqual({
      skipped: true,
      reason: 'mode',
    });
    expect(mocks.shouldRunAutoTurn).not.toHaveBeenCalled();
  });

  it('un disparo automático sin actividad nueva después del ancla se salta', async () => {
    mocks.shouldRunAutoTurn.mockResolvedValue(false);
    const spec = testSpec();
    const plan = await planSurfaceTurn(postRequest({ trigger: 'inbound' }), viewer, spec);
    expect(plan.kind === 'response' && (await plan.response.json())).toEqual({
      skipped: true,
      reason: 'up_to_date',
    });
    expect(spec.anchor).toHaveBeenCalled();
    expect(mocks.shouldRunAutoTurn).toHaveBeenCalledWith('conv-1', ANCHOR);
  });

  it('corre open/inbound en modo activo con la directiva de la superficie', async () => {
    const plan = await planSurfaceTurn(
      postRequest({ trigger: 'open', threadId: 't-1' }),
      viewer,
      testSpec()
    );
    expect(plan.kind).toBe('run');
    expect(plan.kind === 'run' && plan.text.startsWith(`${AUTO_PREFIX}open⟧`)).toBe(true);
    expect(mocks.getOrCreateSurfaceConversation).toHaveBeenCalledWith(
      viewer,
      { kind: 'area', id: 'inventario' },
      { threadId: 't-1' }
    );
  });

  it('una acción aprobada que falló corre aunque el modo sea a petición', async () => {
    mocks.getSurfaceMode.mockResolvedValue('on_demand');
    const plan = await planSurfaceTurn(
      postRequest({
        trigger: 'action_failed',
        detail: { tool: 'reserveStock', error: 'SKU sin existencia' },
      }),
      viewer,
      testSpec()
    );
    expect(plan.kind === 'run' && plan.text).toContain('reserveStock');
    expect(mocks.shouldRunAutoTurn).not.toHaveBeenCalled();
  });
});

describe('handleSurfacePost', () => {
  it('transmite el turno por SSE con el contexto fijado por el servidor', async () => {
    const res = await handleSurfacePost(
      postRequest({
        message: '¿Qué está atrasado?',
        context: { rows: [{ id: 'r1', title: 'Verificar LP-01' }], total: 1 },
        agent: { identityId: 'x', trigger: 'unblock' },
        areaKey: 'compras',
        caseId: 'case-ajeno',
      }),
      viewer,
      areaSurfaceSpec('inventario')
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const body = await res.text();
    expect(body).toContain('"type":"meta"');
    expect(body).toContain('"conversationId":"conv-1"');
    expect(body).toContain('Hay 2 verificaciones vencidas');
    expect(mocks.runAssistant).toHaveBeenCalledTimes(1);
    const input = mocks.runAssistant.mock.calls[0][0];
    expect(input).toMatchObject({
      conversationId: 'conv-1',
      message: '¿Qué está atrasado?',
      actor: viewer,
    });
    expect(input.context).toEqual({
      page: '/app/areas/inventario/trabajo',
      areaKey: 'inventario',
      tableContext: { rows: [{ id: 'r1', title: 'Verificar LP-01' }], total: 1 },
    });
  });

  it('un fallo del asistente se entrega como evento de error', async () => {
    mocks.runAssistant.mockImplementation(async function* () {
      yield { type: 'text', data: { content: 'Revisando' } };
      throw new Error('Proveedor no disponible');
    });
    const res = await handleSurfacePost(
      postRequest({ message: 'Hola' }),
      viewer,
      areaSurfaceSpec('inventario')
    );
    const body = await res.text();
    expect(body).toContain('"type":"error"');
    expect(body).toContain('Proveedor no disponible');
  });

  it('las respuestas de salto no abren flujo', async () => {
    mocks.getSurfaceMode.mockResolvedValue('on_demand');
    const res = await handleSurfacePost(
      postRequest({ trigger: 'inbound' }),
      viewer,
      areaSurfaceSpec('inventario')
    );
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(mocks.runAssistant).not.toHaveBeenCalled();
  });
});
