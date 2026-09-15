import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Opportunities on FakePrisma with the real command engine: creation from a
 * conversation (contact from the inbox, salesperson = assignee), manual and call
 * opportunities, stage moves with their status, quote links, the messaging touch
 * (idempotent, forward-only timestamps, dormant wake-up), the sweep of quote
 * change events and objections.
 */

const mocks = await vi.hoisted(async () => {
  const { createCrmFake } = await import('./testing/crm-fixtures');
  return {
    fake: createCrmFake(),
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

import type { Row } from '@/modules/comms/testing/fake-prisma';
import type { CommandResult } from '@/modules/operations/commands';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedArea, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import {
  createOpportunity,
  createOpportunityFromCall,
  createOpportunityFromConversation,
  linkQuote,
  markDormant,
  moveStage,
  processRecentQuoteChanges,
  recordActivity,
  touchConversation,
} from './opportunities-service';
import { getOpportunityDetail, listOpportunityActivities } from './crm-queries';
import { seedInboxConversation, seedMessage, seedQuote } from './testing/crm-fixtures';

const { fake } = mocks;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

const seller = seedUser(fake, {
  id: 'u-seller',
  name: 'Luis Vendedor',
  roleKeys: ['team_ventas'],
  permissions: ['crm.view', 'crm.manage', 'inbox.use'],
}).currentUser;
seedUser(fake, { id: 'u-ana', name: 'Ana Asignada', roleKeys: ['team_ventas'], permissions: ['crm.view', 'inbox.use'] });
const viewer = seedUser(fake, { id: 'u-viewer', roleKeys: ['team_ventas'], permissions: ['crm.view', 'inbox.use'] }).currentUser;
const outsider = seedUser(fake, { id: 'u-out', roleKeys: ['team_cobranza'], permissions: ['crm.manage', 'inbox.use'] }).currentUser;
seedArea(fake, 'ventas');
seedResponsible(fake, { area: 'ventas', userId: 'u-seller' });

beforeEach(() => {
  invalidateOperationsConfigCache();
});

function completed<D>(result: CommandResult<D>): D {
  expect(result, result.message).toMatchObject({ status: 'completed' });
  return result.data as D;
}

const opportunityRow = (id: string) => fake.rows('opportunity').find((row) => row.id === id) as Row;
const activitiesOf = (id: string) => fake.rows('opportunityActivity').filter((row) => row.opportunityId === id);
const lastActivity = (id: string) => {
  const list = activitiesOf(id);
  return list[list.length - 1];
};
const stageKeyOf = (row: Row) => fake.rows('pipelineStage').find((stage) => stage.id === row.stageId)?.key;
const eventTypes = (objectId: string) =>
  fake.rows('operationalEvent').filter((event) => event.objectId === objectId).map((event) => event.type);

describe('createOpportunityFromConversation', () => {
  it('takes the contact from the inbox (with its Zoho customer) and the salesperson from the assignee', async () => {
    const { conversation, contact } = seedInboxConversation(fake, {
      id: 'conv-new',
      assignedToUserId: 'u-ana',
      zohoContactId: 'zc-1',
      lastInboundAt: ago(5 * HOUR),
    });
    seedMessage(fake, conversation, { direction: 'inbound', body: 'Hola, ¿tienen porcelanato?', createdAt: ago(5 * HOUR) });
    const repliedAt = ago(4 * HOUR);
    seedMessage(fake, conversation, { direction: 'outbound', body: 'Sí, ¿cuántos m2?', createdAt: repliedAt });
    seedMessage(fake, conversation, { direction: 'outbound', body: 'No llegó', createdAt: ago(HOUR), status: 'failed' });

    const data = completed(await createOpportunityFromConversation(seller, { conversationId: 'conv-new', estimatedValue: 48_000 }));

    expect(data.created).toBe(true);
    const row = opportunityRow(data.opportunityId);
    expect(row).toMatchObject({
      number: expect.stringMatching(/^OPP-\d{6}$/),
      title: 'Oportunidad con Constructora Norte',
      contactName: 'Constructora Norte',
      commContactId: contact.id,
      zohoContactId: 'zc-1',
      salespersonUserId: 'u-ana',
      source: 'inbox',
      status: 'open',
      conversationIds: ['conv-new'],
    });
    expect(Number(row.estimatedValue)).toBe(48_000);
    expect(row.lastOutboundAt).toEqual(repliedAt);
    expect(stageKeyOf(row)).toBe('nuevo');
    expect(activitiesOf(row.id).map((a) => [a.kind, a.summary, a.userId])).toEqual([
      ['note', 'Oportunidad creada desde la conversación con Constructora Norte', 'u-seller'],
    ]);
    expect(eventTypes(row.id)).toContain('crm.opportunity.created');
    expect(fake.rows('objectRelation')).toContainEqual(
      expect.objectContaining({ fromType: 'comm_conversation', fromId: 'conv-new', toType: 'opportunity', toId: row.id, relation: 'originated' })
    );
  });

  it('returns the live opportunity of the conversation instead of creating another', async () => {
    seedInboxConversation(fake, { id: 'conv-twice', assignedToUserId: 'u-ana' });
    const first = completed(await createOpportunityFromConversation(seller, { conversationId: 'conv-twice' }));
    const second = completed(await createOpportunityFromConversation(seller, { conversationId: 'conv-twice' }));
    expect(second).toMatchObject({ opportunityId: first.opportunityId, created: false });
    expect(fake.rows('opportunity').filter((row) => row.conversationIds.includes('conv-twice'))).toHaveLength(1);
  });

  it('rejects people without access to the inbox account or without crm.manage', async () => {
    seedInboxConversation(fake, { id: 'conv-locked' });
    expect(await createOpportunityFromConversation(outsider, { conversationId: 'conv-locked' })).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    expect(await createOpportunityFromConversation(viewer, { conversationId: 'conv-locked' })).toMatchObject({
      status: 'rejected',
      errorCode: 'forbidden',
    });
    expect(fake.rows('opportunity').filter((row) => row.conversationIds.includes('conv-locked'))).toHaveLength(0);
  });
});

describe('manual and call opportunities', () => {
  it('creates a manual opportunity for the person creating it, with its next action', async () => {
    const data = completed(
      await createOpportunity(seller, {
        contactName: 'Obra Las Lomas',
        estimatedValue: 9_500,
        nextActionAt: new Date(Date.now() + 24 * HOUR).toISOString(),
        nextActionText: 'Enviar muestras',
      })
    );
    const row = opportunityRow(data.opportunityId);
    expect(row).toMatchObject({ source: 'manual', salespersonUserId: 'u-seller', contactName: 'Obra Las Lomas', nextActionText: 'Enviar muestras' });
    expect(activitiesOf(row.id).map((a) => a.kind)).toEqual(['note', 'task']);
  });

  it('creates an opportunity from a call with its contact and the person who took it', async () => {
    const { contact } = seedInboxConversation(fake, { id: 'conv-call', displayName: 'Pisos del Norte' });
    fake.seed('voiceCall', {
      id: 'call-1',
      type: 'inbound',
      roomName: 'call-call-1',
      contactId: contact.id,
      initiatedByUserId: 'u-ana',
      summary: 'Pide 30 m2 de porcelanato para bodega',
      durationSec: 185,
    });
    const data = completed(await createOpportunityFromCall(seller, { voiceCallId: 'call-1' }));
    const row = opportunityRow(data.opportunityId);
    expect(row).toMatchObject({
      source: 'call',
      voiceCallIds: ['call-1'],
      commContactId: contact.id,
      contactName: 'Pisos del Norte',
      salespersonUserId: 'u-ana',
    });
    expect(activitiesOf(row.id)[0]).toMatchObject({
      kind: 'call',
      summary: 'Llamada entrante de 3 min: Pide 30 m2 de porcelanato para bodega',
      refType: 'voice_call',
      refId: 'call-1',
    });
  });
});

describe('stages', () => {
  it('requires the lost reason, records the move and reopens', async () => {
    const { opportunityId } = completed(await createOpportunity(seller, { contactName: 'Cliente Etapas' }));

    expect(await moveStage(seller, { opportunityId, stageKey: 'perdido' })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_payload',
      message: 'Indica el motivo por el que se perdió la oportunidad',
    });
    expect(opportunityRow(opportunityId).status).toBe('open');

    expect(completed(await moveStage(seller, { opportunityId, stageKey: 'perdido', lostReason: 'Eligió otro proveedor' }))).toMatchObject({
      status: 'lost',
      transition: 'lost',
    });
    expect(opportunityRow(opportunityId)).toMatchObject({ status: 'lost', lostReason: 'Eligió otro proveedor', lostAt: expect.any(Date) });
    expect(lastActivity(opportunityId)).toMatchObject({
      kind: 'stage_change',
      summary: 'Etapa: Nuevo → Perdido (motivo: Eligió otro proveedor)',
    });
    expect(eventTypes(opportunityId)).toEqual(expect.arrayContaining(['crm.opportunity.stage_changed', 'crm.opportunity.lost']));

    expect(completed(await moveStage(seller, { opportunityId, stageKey: 'contactado' }))).toMatchObject({ status: 'open', transition: 'reopened' });
    expect(opportunityRow(opportunityId)).toMatchObject({ status: 'open', lostReason: null, lostAt: null });
    expect(eventTypes(opportunityId)).toContain('crm.opportunity.reactivated');
  });

  it('rejects a stale expected version', async () => {
    const { opportunityId } = completed(await createOpportunity(seller, { contactName: 'Cliente Versión' }));
    expect(await moveStage(seller, { opportunityId, stageKey: 'contactado' }, { expectedVersion: 7 })).toMatchObject({
      status: 'rejected',
      errorCode: 'version_conflict',
    });
  });
});

describe('linkQuote', () => {
  it('links the quote, takes its value and advances to Cotizado', async () => {
    const { opportunityId } = completed(await createOpportunity(seller, { contactName: 'Acabados del Bajío' }));
    seedQuote(fake, {
      id: 'q-link',
      zohoEstimateId: '4600009101',
      estimateNumber: 'COT-00101',
      status: 'sent',
      zohoCustomerId: 'zc-2',
      customerName: 'Acabados del Bajío',
      total: 12_500,
    });

    expect(completed(await linkQuote(seller, { opportunityId, quoteId: 'q-link' }))).toEqual({
      opportunityId,
      quoteId: 'q-link',
      alreadyLinked: false,
      stageAdvanced: true,
    });
    const row = opportunityRow(opportunityId);
    expect(row).toMatchObject({ zohoEstimateIds: ['4600009101'], zohoContactId: 'zc-2' });
    expect(Number(row.estimatedValue)).toBe(12_500);
    expect(stageKeyOf(row)).toBe('cotizado');
    expect(activitiesOf(opportunityId).map((a) => [a.kind, a.summary])).toEqual(
      expect.arrayContaining([
        ['quote_sent', 'Cotización COT-00101 vinculada por $12,500.00 (Enviada)'],
        ['stage_change', 'Etapa: Nuevo → Cotizado'],
      ])
    );
    expect(completed(await linkQuote(seller, { opportunityId, quoteId: 'q-link' }))).toMatchObject({
      alreadyLinked: true,
      stageAdvanced: false,
    });
  });

  it('refuses a quote of another customer', async () => {
    const { opportunityId } = completed(await createOpportunity(seller, { contactName: 'Cliente A' }));
    seedQuote(fake, { id: 'q-a', zohoEstimateId: '4600009102', estimateNumber: 'COT-00102', zohoCustomerId: 'zc-3' });
    seedQuote(fake, { id: 'q-b', zohoEstimateId: '4600009103', estimateNumber: 'COT-00103', zohoCustomerId: 'zc-4', customerName: 'Cliente B' });
    completed(await linkQuote(seller, { opportunityId, quoteId: 'q-a' }));
    expect(await linkQuote(seller, { opportunityId, quoteId: 'q-b' })).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
  });
});

describe('touchConversation', () => {
  async function setup(id: string) {
    const { conversation } = seedInboxConversation(fake, { id, assignedToUserId: 'u-ana' });
    seedMessage(fake, conversation, { direction: 'inbound', body: 'Hola', createdAt: ago(3 * HOUR) });
    const { opportunityId } = completed(await createOpportunityFromConversation(seller, { conversationId: id }));
    return { conversation, opportunityId };
  }

  it('records inbound and outbound messages once and only moves timestamps forward', async () => {
    const { conversation, opportunityId } = await setup('conv-touch');
    const inbound = seedMessage(fake, conversation, { direction: 'inbound', body: '¿Me cotizas 40 m2?', createdAt: ago(60_000) });

    expect(await touchConversation(inbound.id)).toMatchObject({ status: 'touched' });
    await touchConversation(inbound.id);
    expect(activitiesOf(opportunityId).filter((a) => a.kind === 'message_in')).toEqual([
      expect.objectContaining({ summary: 'Cliente: «¿Me cotizas 40 m2?»', refType: 'comm_message', refId: inbound.id, userId: null }),
    ]);
    expect(opportunityRow(opportunityId).lastInboundAt).toEqual(inbound.createdAt);

    const outbound = seedMessage(fake, conversation, {
      direction: 'outbound',
      body: 'Claro, se la envío hoy',
      createdAt: new Date(),
      sentByUserId: 'u-ana',
    });
    await touchConversation(outbound.id);
    expect(activitiesOf(opportunityId).filter((a) => a.kind === 'message_out')).toEqual([expect.objectContaining({ userId: 'u-ana' })]);
    expect(opportunityRow(opportunityId).lastOutboundAt).toEqual(outbound.createdAt);

    const late = seedMessage(fake, conversation, { direction: 'inbound', body: 'mensaje atrasado', createdAt: ago(2 * HOUR) });
    await touchConversation(late.id);
    expect(opportunityRow(opportunityId).lastInboundAt).toEqual(inbound.createdAt);
  });

  it('skips failed outbound messages, conversations without opportunity and missing messages', async () => {
    const { conversation, opportunityId } = await setup('conv-failed');
    const failed = seedMessage(fake, conversation, { direction: 'outbound', body: 'x', createdAt: new Date(), status: 'failed' });
    expect(await touchConversation(failed.id)).toMatchObject({ status: 'skipped', reason: 'failed_outbound' });
    expect(activitiesOf(opportunityId).some((a) => a.refId === failed.id)).toBe(false);

    const lonely = seedInboxConversation(fake, { id: 'conv-lonely' });
    const message = seedMessage(fake, lonely.conversation, { direction: 'inbound', body: 'Hola', createdAt: new Date() });
    expect(await touchConversation(message.id)).toMatchObject({ status: 'skipped', reason: 'no_opportunity' });
    expect(await touchConversation('missing-message')).toMatchObject({ status: 'skipped', reason: 'message_not_found' });
  });

  it('wakes a dormant opportunity when the customer writes again', async () => {
    const { conversation, opportunityId } = await setup('conv-dormant');
    completed(await markDormant(seller, { opportunityId, reason: 'Sin respuesta en 30 días' }));
    expect(opportunityRow(opportunityId).status).toBe('dormant');

    const message = seedMessage(fake, conversation, { direction: 'inbound', body: 'Ya tengo presupuesto', createdAt: new Date() });
    const result = await touchConversation(message.id);

    expect(result.opportunities).toEqual([{ opportunityId, status: 'touched' }]);
    expect(opportunityRow(opportunityId).status).toBe('open');
    expect(activitiesOf(opportunityId).map((a) => a.summary)).toContain('La oportunidad se reactivó porque el cliente volvió a escribir');
    expect(eventTypes(opportunityId)).toContain('crm.opportunity.reactivated');
  });
});

describe('conversaciones que no son de Ventas', () => {
  it('no crea oportunidades ni toca la línea de tiempo con proveedores ni con cotizaciones de compra', async () => {
    const rfq = seedInboxConversation(fake, { id: 'conv-rfq', assignedToUserId: 'u-ana', tags: ['rfq:rfq_1'] });
    seedMessage(fake, rfq.conversation, { direction: 'inbound', body: 'Le cotizo a $300', createdAt: new Date() });
    const rejected = await createOpportunityFromConversation(seller, { conversationId: 'conv-rfq' });
    expect(rejected).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });

    const supplierConv = seedInboxConversation(fake, { id: 'conv-supplier', assignedToUserId: 'u-ana' });
    fake.seed('supplier', {
      id: 'sup-1',
      number: 'PRV-T00001',
      name: 'Aceros del Norte',
      commContactId: supplierConv.contact.id,
      createdByUserId: 'u-seller',
    });
    expect(await createOpportunityFromConversation(seller, { conversationId: 'conv-supplier' })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });

    // A customer conversation that later becomes an RFQ stops touching the opportunity.
    const { conversation } = seedInboxConversation(fake, { id: 'conv-mixed', assignedToUserId: 'u-ana' });
    seedMessage(fake, conversation, { direction: 'inbound', body: 'Hola', createdAt: ago(3 * HOUR) });
    completed(await createOpportunityFromConversation(seller, { conversationId: 'conv-mixed' }));
    conversation.tags = ['rfq:rfq_2'];
    const message = seedMessage(fake, conversation, { direction: 'inbound', body: 'Le mando precios', createdAt: new Date() });
    expect(await touchConversation(message.id)).toMatchObject({ status: 'skipped', reason: 'supplier_conversation' });
  });
});

describe('línea de tiempo de mensajes', () => {
  it('oculta el texto del mensaje a quien no tiene acceso a esa cuenta de la bandeja', async () => {
    const { conversation } = seedInboxConversation(fake, { id: 'conv-privacy', assignedToUserId: 'u-ana' });
    seedMessage(fake, conversation, { direction: 'inbound', body: 'Hola', createdAt: ago(3 * HOUR) });
    const { opportunityId } = completed(await createOpportunityFromConversation(seller, { conversationId: 'conv-privacy' }));
    const inbound = seedMessage(fake, conversation, { direction: 'inbound', body: 'Mi presupuesto es de 250 mil', createdAt: new Date() });
    await touchConversation(inbound.id);

    const otherTeam = seedUser(fake, {
      id: 'u-cobranza',
      roleKeys: ['team_cobranza'],
      permissions: ['crm.view', 'inbox.use'],
    }).currentUser;
    const mine = await listOpportunityActivities(seller, { opportunityId });
    expect(mine.items.find((item) => item.refId === inbound.id)?.summary).toBe('Cliente: «Mi presupuesto es de 250 mil»');
    const theirs = await listOpportunityActivities(otherTeam, { opportunityId });
    const hidden = theirs.items.find((item) => item.refId === inbound.id);
    expect(hidden).toMatchObject({ summary: 'Mensaje del cliente (sin acceso a esa cuenta de la bandeja)', payload: null });
    const detail = await getOpportunityDetail(otherTeam, opportunityId);
    expect(detail.activities.items.find((item) => item.refId === inbound.id)?.summary).toBe(
      'Mensaje del cliente (sin acceso a esa cuenta de la bandeja)'
    );
  });
});

describe('quote changes from the existing change events', () => {
  it('turns a status change of a linked quote into an activity once', async () => {
    const { opportunityId } = completed(await createOpportunity(seller, { contactName: 'Constructora Sur' }));
    seedQuote(fake, { id: 'q-change', zohoEstimateId: '4600009201', estimateNumber: 'COT-00201', status: 'sent', zohoCustomerId: 'zc-9', total: 12_500 });
    completed(await linkQuote(seller, { opportunityId, quoteId: 'q-change' }));
    seedQuote(fake, { id: 'q-unlinked', zohoEstimateId: '4600009202', estimateNumber: 'COT-00202', status: 'sent', zohoCustomerId: 'zc-9' });
    fake.seed('entityChangeEvent', {
      id: 'ev-accepted',
      entityType: 'quote',
      entityId: 'q-change',
      sourceSnapshotId: 'snap-ev-accepted',
      changes: { fields: { status: { before: 'sent', after: 'accepted' }, total: { before: '12500', after: '13000' } } },
    });
    fake.seed('entityChangeEvent', {
      id: 'ev-unlinked',
      entityType: 'quote',
      entityId: 'q-unlinked',
      sourceSnapshotId: 'snap-ev-unlinked',
      changes: { fields: { status: { before: 'draft', after: 'sent' } } },
    });

    expect(await processRecentQuoteChanges()).toMatchObject({ events: 2, recorded: 1 });
    expect(activitiesOf(opportunityId).find((a) => a.refId === 'ev-accepted')).toMatchObject({
      kind: 'quote_accepted',
      refType: 'entity_change_event',
      summary: 'Cotización COT-00201 pasó a «Aceptada»; total $12,500.00 → $13,000.00',
      userId: null,
    });
    expect(Number(opportunityRow(opportunityId).estimatedValue)).toBe(13_000);
    expect(await processRecentQuoteChanges()).toMatchObject({ recorded: 0 });
  });
});

describe('recordActivity', () => {
  it('records an objection and its resolution by reference', async () => {
    const { opportunityId } = completed(await createOpportunity(seller, { contactName: 'Cliente Objeción' }));
    const objection = completed(await recordActivity(seller, { opportunityId, kind: 'objection', summary: 'El precio es alto' }));
    completed(
      await recordActivity(seller, {
        opportunityId,
        kind: 'objection_resolved',
        summary: 'Se ofreció otro acabado',
        resolvesActivityId: objection.activityId,
      })
    );
    expect(
      activitiesOf(opportunityId)
        .filter((a) => String(a.kind).startsWith('objection'))
        .map((a) => [a.kind, a.refId])
    ).toEqual([
      ['objection', null],
      ['objection_resolved', objection.activityId],
    ]);
    expect(
      await recordActivity(seller, { opportunityId, kind: 'objection_resolved', summary: 'x', resolvesActivityId: 'nope' })
    ).toMatchObject({ status: 'rejected', errorCode: 'not_found' });
  });
});
