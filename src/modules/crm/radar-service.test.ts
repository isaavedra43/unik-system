import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Radar service on FakePrisma with the real command engine: the batch refresh
 * creates, keeps, resolves and reactivates signals; snoozed signals wake up and
 * dismissed ones stay dismissed; conversion into a work item; the AI explanation
 * (one utility call, cached, validated JSON) and visibility per salesperson.
 * The model, AI settings and budget are mocked.
 */

const mocks = await vi.hoisted(async () => {
  const { createCrmFake } = await import('./testing/crm-fixtures');
  return {
    fake: createCrmFake(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({
      id: '1',
      channel: '',
      type: '',
      payload: {},
      createdAt: '',
    })),
    chatCompletion: vi.fn(),
    recordAgentUsage: vi.fn(async () => ({ tokens: 0, meters: [] })),
    checkAgentBudget: vi.fn(async () => ({ state: 'ok' })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const { withCrmPermissions } = await import('./testing/crm-permissions-mock');
  return withCrmPermissions(await importOriginal<typeof import('@/modules/auth/permissions')>());
});
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: mocks.chatCompletion }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({
  getAiSettings: vi.fn(async () => ({
    isEnabled: true,
    deployment: 'gpt-4o',
    utilityModel: 'kimi-k2.6',
  })),
}));
vi.mock('@/modules/agents/budget', () => ({
  checkAgentBudget: mocks.checkAgentBudget,
  recordAgentUsage: mocks.recordAgentUsage,
}));

import type { Row } from '@/modules/comms/testing/fake-prisma';
import type { CommandResult } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedArea, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import { ensurePipelineSeed } from './pipeline-service';
import { localDateKey } from './radar-rules';
import {
  convertSignalToTask,
  dismissSignal,
  explainSignal,
  getRadarSignal,
  refreshRadar,
  snoozeSignal,
} from './radar-service';
import {
  seedInboxConversation,
  seedMessage,
  seedOpportunity,
  seedQuote,
} from './testing/crm-fixtures';

const { fake } = mocks;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const seller = seedUser(fake, {
  id: 'u-seller',
  name: 'Luis',
  permissions: ['crm.view', 'crm.manage', 'crm.radar'],
}).currentUser;
const ana = seedUser(fake, {
  id: 'u-ana',
  name: 'Ana',
  permissions: ['crm.view', 'crm.radar'],
}).currentUser;
seedArea(fake, 'ventas');
seedResponsible(fake, { area: 'ventas', userId: 'u-seller' });

beforeEach(async () => {
  invalidateOperationsConfigCache();
  mocks.chatCompletion.mockReset();
  mocks.recordAgentUsage.mockClear();
  mocks.publishRealtime.mockClear();
  mocks.notifyUser.mockClear();
  await ensurePipelineSeed();
});

function completed<D>(result: CommandResult<D>): D {
  expect(result, result.message).toMatchObject({ status: 'completed' });
  return result.data as D;
}

const signal = (kind: string, subjectKey: string) =>
  fake.rows('radarSignal').find((row) => row.kind === kind && row.subjectKey === subjectKey) as Row;
const stageId = (key: string) =>
  (fake.rows('pipelineStage').find((stage) => stage.key === key) as Row).id as string;

function waitingConversation(id: string, hours: number, now: Date) {
  const { conversation } = seedInboxConversation(fake, {
    id,
    assignedToUserId: 'u-ana',
    displayName: 'Constructora Norte',
    lastInboundAt: new Date(now.getTime() - hours * HOUR),
  });
  seedMessage(fake, conversation, {
    direction: 'inbound',
    body: 'Hola',
    createdAt: new Date(now.getTime() - hours * HOUR),
  });
  return conversation;
}

describe('refreshRadar', () => {
  it('creates signals from the batch facts, keeps them, resolves and reactivates them', async () => {
    const now = new Date();
    const conversation = waitingConversation('r-conv', 10, now);
    seedQuote(fake, {
      id: 'r-quote',
      zohoEstimateId: '4600019001',
      estimateNumber: 'COT-00901',
      status: 'sent',
      expiryDate: new Date(`${localDateKey(new Date(now.getTime() + DAY))}T00:00:00.000Z`),
      createdByUserId: 'u-ana',
      total: 5_000,
    });
    seedOpportunity(fake, {
      id: 'r-opp',
      stageId: stageId('negociacion'),
      nextActionAt: new Date(now.getTime() - 3.5 * DAY),
      nextActionText: 'Llamar para confirmar medidas',
      estimatedValue: new Prisma.Decimal(250_000),
    });

    expect(await refreshRadar({ now })).toMatchObject({
      evaluated: 3,
      created: 3,
      reactivated: 0,
      updated: 0,
      resolved: 0,
      active: 3,
    });
    expect(signal('no_first_reply', 'r-conv')).toMatchObject({
      status: 'active',
      score: 65,
      salespersonUserId: 'u-ana',
      conversationId: 'r-conv',
      customerName: 'Constructora Norte',
    });
    expect(signal('quote_expiring', 'r-quote')).toMatchObject({
      score: 72,
      quoteId: 'r-quote',
      salespersonUserId: 'u-ana',
    });
    expect(signal('next_action_overdue', 'r-opp')).toMatchObject({
      score: 94,
      opportunityId: 'r-opp',
      salespersonUserId: 'u-seller',
    });
    expect(mocks.publishRealtime).toHaveBeenCalledWith(
      'crm:radar',
      'radar_refreshed',
      expect.objectContaining({ created: 3 })
    );
    expect(mocks.publishRealtime).toHaveBeenCalledWith('user:u-ana', 'crm_radar_new', {
      count: 2,
      topScore: 72,
    });

    expect(await refreshRadar({ now })).toMatchObject({
      created: 0,
      updated: 0,
      resolved: 0,
      active: 3,
    });

    seedMessage(fake, conversation, {
      id: 'r-reply',
      direction: 'outbound',
      body: 'Buen día',
      createdAt: new Date(now.getTime() - HOUR),
    });
    expect(await refreshRadar({ now })).toMatchObject({ resolved: 1 });
    expect(signal('no_first_reply', 'r-conv').status).toBe('resolved');

    // The reply failed after all: the same subject comes back.
    (fake.rows('commMessage').find((row) => row.id === 'r-reply') as Row).status = 'failed';
    expect(await refreshRadar({ now })).toMatchObject({ reactivated: 1 });
    expect(signal('no_first_reply', 'r-conv')).toMatchObject({ status: 'active', version: 3 });
  });

  /**
   * Plan 6.6: la categoría `radar_signal` no es un adorno del catálogo. Una
   * señal NUEVA de alto puntaje avisa a su vendedor (y sólo a su vendedor);
   * una de puntaje bajo se queda en el tablero sin interrumpir, y la misma
   * señal no vuelve a sonar el mismo día.
   */
  it('avisa al vendedor de una señal nueva de alto puntaje y no repite la misma el mismo día', async () => {
    const now = new Date();
    // 94 puntos para u-seller: siguiente acción vencida de una oportunidad grande.
    seedOpportunity(fake, {
      id: 'r-notify-opp',
      stageId: stageId('negociacion'),
      nextActionAt: new Date(now.getTime() - 3.5 * DAY),
      nextActionText: 'Llamar para confirmar medidas',
      estimatedValue: new Prisma.Decimal(250_000),
      salespersonUserId: 'u-seller',
    });
    // 65 puntos para u-ana: por debajo del umbral, no interrumpe.
    waitingConversation('r-notify-conv', 10, now);

    expect(await refreshRadar({ now })).toMatchObject({ created: 2, notified: 1 });
    expect(mocks.notifyUser).toHaveBeenCalledTimes(1);
    expect(mocks.notifyUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-seller',
        category: 'radar_signal',
        type: 'crm_radar_signal',
        title: expect.stringContaining('Siguiente acción vencida'),
        url: '/app/areas/ventas/radar',
        entityType: 'radar_signal',
        dedupeKey: `crm_radar:u-seller:next_action_overdue:r-notify-opp:${localDateKey(now)}`,
      })
    );
    // u-ana ve su señal en el tablero y en el contador, pero no recibe aviso.
    expect(signal('no_first_reply', 'r-notify-conv').status).toBe('active');
    expect(mocks.publishRealtime).toHaveBeenCalledWith('user:u-ana', 'crm_radar_new', {
      count: 1,
      topScore: 65,
    });

    // Un segundo refresco no crea nada nuevo: nada que avisar.
    mocks.notifyUser.mockClear();
    expect(await refreshRadar({ now })).toMatchObject({ created: 0, notified: 0 });
    expect(mocks.notifyUser).not.toHaveBeenCalled();
  });

  it('wakes snoozed signals when their time passes and keeps dismissed ones', async () => {
    const now = new Date();
    waitingConversation('r-snooze', 20, now);
    await refreshRadar({ now });
    const target = signal('no_first_reply', 'r-snooze');

    completed(
      await snoozeSignal(ana, {
        signalId: target.id,
        until: new Date(Date.now() + 30 * 60_000).toISOString(),
        note: 'Le llamo después de comer',
      })
    );
    expect(signal('no_first_reply', 'r-snooze')).toMatchObject({
      status: 'snoozed',
      data: expect.objectContaining({ snoozedBy: 'u-ana' }),
    });

    await refreshRadar({ now: new Date(Date.now() + 10 * 60_000) });
    expect(signal('no_first_reply', 'r-snooze').status).toBe('snoozed');
    await refreshRadar({ now: new Date(Date.now() + 40 * 60_000) });
    expect(signal('no_first_reply', 'r-snooze')).toMatchObject({
      status: 'active',
      snoozedUntil: null,
    });

    completed(
      await dismissSignal(ana, { signalId: target.id, reason: 'Ya lo atendí por teléfono' })
    );
    await refreshRadar({ now: new Date(Date.now() + 41 * 60_000) });
    expect(signal('no_first_reply', 'r-snooze')).toMatchObject({
      status: 'dismissed',
      data: expect.objectContaining({ dismissReason: 'Ya lo atendí por teléfono' }),
    });
  });

  it('converts a signal into a work item of Ventas and keeps it quiet until the task is due', async () => {
    const now = new Date();
    seedOpportunity(fake, {
      id: 'r-task-opp',
      stageId: stageId('contactado'),
      nextActionAt: new Date(now.getTime() - 2 * DAY),
      nextActionText: 'Enviar muestras',
      salespersonUserId: 'u-seller',
    });
    await refreshRadar({ now });
    const target = signal('next_action_overdue', 'r-task-opp');

    const { workItemId } = completed(await convertSignalToTask(seller, { signalId: target.id }));

    expect(fake.rows('workItem').find((row) => row.id === workItemId)).toMatchObject({
      areaKey: 'ventas',
      kind: 'action',
      ownerUserId: 'u-seller',
      objectType: 'radar_signal',
      objectId: target.id,
      title: 'Siguiente acción vencida: Constructora Norte',
    });
    expect(signal('next_action_overdue', 'r-task-opp')).toMatchObject({
      status: 'snoozed',
      data: expect.objectContaining({ workItemId }),
    });
    expect(
      fake.rows('opportunityActivity').find((row) => row.opportunityId === 'r-task-opp')
    ).toMatchObject({
      kind: 'task',
      refType: 'work_item',
      refId: workItemId,
    });

    await refreshRadar({ now });
    expect(signal('next_action_overdue', 'r-task-opp').status).toBe('snoozed');
  });
});

describe('conversaciones de compras', () => {
  it('no genera señales de Ventas para una cotización de compra ni para un proveedor', async () => {
    const now = new Date('2026-09-15T18:00:00.000Z');
    const rfq = waitingConversation('conv-rfq-radar', 5, now);
    rfq.tags = ['rfq:rfq_1'];
    const supplierConv = waitingConversation('conv-supplier-radar', 5, now);
    fake.seed('supplier', {
      id: 'sup-radar',
      number: 'PRV-T00002',
      name: 'Aceros del Norte',
      commContactId: `ct-conv-supplier-radar`,
      createdByUserId: 'u-seller',
    });
    const customer = waitingConversation('conv-customer-radar', 5, now);

    await refreshRadar({ now });
    const subjects = fake.rows('radarSignal').map((row) => row.subjectKey);
    expect(subjects).toContain(customer.id);
    expect(subjects).not.toContain(rfq.id);
    expect(subjects).not.toContain(supplierConv.id);
  });
});

describe('getRadarSignal', () => {
  it('devuelve la explicación guardada sin llamar al modelo', async () => {
    const now = new Date('2026-09-15T18:00:00.000Z');
    waitingConversation('conv-cached', 5, now);
    await refreshRadar({ now });
    const row = signal('no_first_reply', 'conv-cached');
    row.aiExplanation = 'El cliente lleva 5 horas esperando';
    row.aiSuggestedMessage = 'Hola, ya estoy revisando su solicitud';
    row.aiGeneratedAt = now;

    const cached = await getRadarSignal(ana, row.id as string);
    expect(cached).toMatchObject({ aiSuggestedMessage: 'Hola, ya estoy revisando su solicitud' });
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
    await expect(getRadarSignal(ana, 'missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('explainSignal', () => {
  it('makes one utility call, stores the explanation and serves it from cache', async () => {
    const now = new Date();
    waitingConversation('r-explain', 20, now);
    await refreshRadar({ now });
    const target = signal('no_first_reply', 'r-explain');
    mocks.chatCompletion.mockResolvedValueOnce({
      content:
        '```json\n{"explanation":"El cliente espera respuesta desde hace 20 horas; contéstale hoy para no perderlo.","suggestedMessage":"Hola, gracias por escribir. ¿Me confirma los metros para cotizarle hoy?"}\n```',
      promptTokens: 300,
      completionTokens: 80,
      totalTokens: 380,
      model: 'kimi-k2.6',
      finishReason: 'stop',
      durationMs: 900,
    });

    const dto = await explainSignal(ana, { signalId: target.id });

    expect(dto).toMatchObject({
      aiExplanation:
        'El cliente espera respuesta desde hace 20 horas; contéstale hoy para no perderlo.',
      aiSuggestedMessage: 'Hola, gracias por escribir. ¿Me confirma los metros para cotizarle hoy?',
    });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    const call = mocks.chatCompletion.mock.calls[0][0] as {
      model: string;
      messages: Array<{ content: string }>;
    };
    expect(call.model).toBe('kimi-k2.6');
    expect(call.messages[1].content).toContain('Motivo: Constructora Norte escribió hace 20 h');
    expect(call.messages[1].content).toContain('<untrusted source="conversacion_cliente"');
    expect(mocks.recordAgentUsage).toHaveBeenCalledWith(
      expect.objectContaining({ areaKey: 'ventas', promptTokens: 300, completionTokens: 80 })
    );

    await explainSignal(ana, { signalId: target.id });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);

    mocks.chatCompletion.mockResolvedValueOnce({
      content: 'sin JSON',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      model: 'kimi-k2.6',
      finishReason: 'stop',
      durationMs: 1,
    });
    await expect(explainSignal(ana, { signalId: target.id, force: true })).rejects.toMatchObject({
      code: 'ai_invalid',
    });
  });

  it('hides signals of other salespeople from people without crm.manage', async () => {
    const other = fake.seed('radarSignal', {
      kind: 'no_followup',
      subjectKey: 'r-hidden',
      salespersonUserId: 'u-seller',
      score: 50,
      reason: 'Sin seguimiento',
      expiresAt: new Date(Date.now() + HOUR),
    });
    expect(await dismissSignal(ana, { signalId: other.id })).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    await expect(explainSignal(ana, { signalId: other.id })).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
  });
});
