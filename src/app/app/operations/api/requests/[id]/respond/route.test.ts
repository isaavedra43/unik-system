import type { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return {
    fake: createOpsFake(),
    getCurrentSession: vi.fn(),
    acceptAreaRequest: vi.fn(),
    blockAreaRequest: vi.fn(),
    resolveAreaRequest: vi.fn(),
    rejectAreaRequest: vi.fn(),
    getAreaRequest: vi.fn(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/auth/authorization', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/auth/authorization')>()),
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock('@/modules/operations/area-requests-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/operations/area-requests-service')>()),
  acceptAreaRequest: mocks.acceptAreaRequest,
  blockAreaRequest: mocks.blockAreaRequest,
  resolveAreaRequest: mocks.resolveAreaRequest,
  rejectAreaRequest: mocks.rejectAreaRequest,
  getAreaRequest: mocks.getAreaRequest,
}));

import { OperationsError, httpStatusForCode } from '@/modules/operations/errors';
import { makeCurrentUser } from '@/modules/operations/testing/fixtures';
import { POST } from './route';

const user = makeCurrentUser({ id: 'u-ana', name: 'Ana' });

function commandResult(status: string, extra: Record<string, unknown> = {}) {
  return {
    commandId: 'cmd-1',
    type: 'request.accept',
    status,
    aggregateVersion: 2,
    emittedEventIds: ['1'],
    createdWorkItemIds: [],
    ...extra,
  };
}

function post(id: string, body: unknown, raw?: string) {
  const request = new Request(`http://localhost/app/operations/api/requests/${id}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest, { params: Promise.resolve({ id }) });
}

const serviceMocks = [mocks.acceptAreaRequest, mocks.blockAreaRequest, mocks.resolveAreaRequest, mocks.rejectAreaRequest];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ sessionId: 's1', user });
  for (const mock of serviceMocks) mock.mockResolvedValue(commandResult('completed'));
  mocks.getAreaRequest.mockResolvedValue({ id: 'req-1', status: 'accepted' });
});

describe('POST /app/operations/api/requests/[id]/respond', () => {
  it('sin sesión responde 401 y no decide nada', async () => {
    mocks.getCurrentSession.mockResolvedValue(null);
    const res = await post('req-1', { action: 'accept' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
    for (const mock of serviceMocks) expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: 'approve' }],
    [{ action: 'cancel', reason: 'ya no' }],
    [{}],
    [{ action: 42 }],
  ])('una acción inválida responde 400 (%j)', async (body) => {
    const res = await post('req-1', body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toMatchObject({ code: 'invalid_request' });
    expect(json.error).toContain('Acción inválida');
    for (const mock of serviceMocks) expect(mock).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: 'block' }, 'motivo'],
    [{ action: 'block', reason: 'no' }, 'motivo'],
    [{ action: 'reject', reason: 'x'.repeat(501) }, '500'],
    [{ action: 'resolve' }, 'respuesta'],
    [{ action: 'resolve', answer: '   ' }, 'respuesta'],
  ])('valida motivo y respuesta (%j)', async (body, message) => {
    const res = await post('req-1', body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
  });

  it('JSON inválido e id con caracteres raros', async () => {
    expect((await post('req-1', null, '{no')).status).toBe(400);
    expect((await post('req 1!', { action: 'accept' })).status).toBe(404);
  });

  it('acepta como la persona de la sesión y devuelve la solicitud actualizada', async () => {
    const res = await post('req-1', { action: 'accept' });
    expect(res.status).toBe(200);
    expect(mocks.acceptAreaRequest).toHaveBeenCalledWith(user, 'req-1', {}, {});
    expect(await res.json()).toMatchObject({
      message: 'Solicitud aceptada',
      result: { status: 'completed' },
      request: { id: 'req-1', status: 'accepted' },
    });
  });

  it('pasa nota, motivo, respuesta y la llave de idempotencia al comando correcto', async () => {
    await post('req-1', { action: 'accept', note: ' Voy ', commandId: 'chat-accept-123' });
    expect(mocks.acceptAreaRequest).toHaveBeenCalledWith(user, 'req-1', { note: 'Voy' }, { commandId: 'chat-accept-123' });
    await post('req-1', { action: 'block', reason: '  Falta material  ' });
    expect(mocks.blockAreaRequest).toHaveBeenCalledWith(user, 'req-1', { reason: 'Falta material' }, {});
    await post('req-1', { action: 'resolve', answer: 'Hay 15 m² en bodega 2' });
    expect(mocks.resolveAreaRequest).toHaveBeenCalledWith(user, 'req-1', { answer: 'Hay 15 m² en bodega 2' }, {});
    await post('req-1', { action: 'reject', reason: 'No es de Compras' });
    expect(mocks.rejectAreaRequest).toHaveBeenCalledWith(user, 'req-1', { reason: 'No es de Compras' }, {});
  });

  it('sin permiso el núcleo rechaza y la ruta responde 403 con el mensaje', async () => {
    mocks.acceptAreaRequest.mockResolvedValue(
      commandResult('rejected', {
        errorCode: 'forbidden',
        message: 'Sólo el responsable del área destino o un gestor de operaciones puede decidir esta solicitud',
      })
    );
    const res = await post('req-1', { action: 'accept' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'forbidden', error: expect.stringContaining('responsable') });
    expect(mocks.getAreaRequest).not.toHaveBeenCalled();
  });

  it('otros rechazos usan el estado HTTP de su código', async () => {
    mocks.blockAreaRequest.mockResolvedValue(commandResult('rejected', { errorCode: 'invalid_state' }));
    const res = await post('req-1', { action: 'block', reason: 'Falta material' });
    expect(res.status).toBe(httpStatusForCode('invalid_state'));
    expect((await res.json()).error).toBe('No se pudo completar la acción');
  });

  it('en vuelo responde 202 sin releer la solicitud', async () => {
    mocks.acceptAreaRequest.mockResolvedValue(commandResult('accepted'));
    const res = await post('req-1', { action: 'accept' });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ request: null });
    expect(mocks.getAreaRequest).not.toHaveBeenCalled();
  });

  it('si la relectura falla la decisión igual se reporta', async () => {
    mocks.getAreaRequest.mockRejectedValue(new Error('db'));
    const res = await post('req-1', { action: 'accept' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request: null });
  });

  it('errores lanzados: del núcleo con su estado; inesperados como 500 genérico', async () => {
    mocks.acceptAreaRequest.mockRejectedValue(new OperationsError('not_found', 'No se encontró la solicitud'));
    const notFound = await post('req-1', { action: 'accept' });
    expect(notFound.status).toBe(404);

    mocks.acceptAreaRequest.mockRejectedValue(new Error('connection reset'));
    const crash = await post('req-1', { action: 'accept' });
    expect(crash.status).toBe(500);
    const json = await crash.json();
    expect(json.error).not.toContain('connection');
    expect(json.code).toBe('internal_error');
  });
});
