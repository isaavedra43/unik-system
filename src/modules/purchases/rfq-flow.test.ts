import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * RFQ by WhatsApp on FakePrisma (plan 6.1): invitations through the inbox
 * (mocked `startConversation`), tagged conversations, replies interpreted by
 * the utility model (mocked) as `parsed` / `needs_review`, confirmation,
 * landed-cost comparison and selection into a draft order (promoting the
 * candidate), manual quotes and expiry.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/purchases-fixtures');
  const fake = fixtures.createPurchasesFake();
  let conversations = 0;
  return {
    fake,
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
    chatCompletion: vi.fn(),
    startConversation: vi.fn(async (_actor: unknown, input: { accountId: string; to: string; body?: string }) => {
      conversations += 1;
      const conversation = fake.seed('commConversation', {
        id: `conv_${conversations}`,
        accountId: input.accountId,
        contactId: `contact_${conversations}`,
        status: 'open',
        tags: [],
        unreadCount: 0,
        priority: 'normal',
        lastMessageAt: new Date('2026-09-15T15:00:00.000Z'),
      });
      const message = fake.seed('commMessage', {
        id: `out_${conversations}`,
        accountId: input.accountId,
        conversationId: conversation.id,
        direction: 'outbound',
        body: input.body ?? null,
        mediaObjectIds: [],
        status: input.to.includes('000') ? 'failed' : 'sent',
        error: input.to.includes('000') ? 'Número inválido' : null,
        createdAt: new Date('2026-09-15T15:00:00.000Z'),
      });
      return { conversation: { id: conversation.id, tags: conversation.tags }, message: { id: message.id, status: message.status, error: message.error } };
    }),
    updateConversation: vi.fn(async (_actor: unknown, id: string, patch: { tags?: string[] }) => {
      const conversation = fake.rows('commConversation').find((row) => row.id === id)!;
      conversation.tags = patch.tags ?? conversation.tags;
      return conversation;
    }),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
}));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/modules/auth/permissions')>();
  const { PURCHASES_PERMISSIONS } = await import('./permissions');
  const registry = [...original.PERMISSION_REGISTRY, ...PURCHASES_PERMISSIONS];
  const keys = new Set(registry.map((p) => p.key));
  return {
    ...original,
    PERMISSION_REGISTRY: registry,
    isKnownPermission: (key: string) => keys.has(key),
    assertKnownPermission: (key: string) => {
      if (!keys.has(key)) throw new Error(`Unknown permission "${key}"`);
    },
    filterKnownPermissions: (list: string[]) => list.filter((key) => keys.has(key)),
  };
});
vi.mock('./finance-bridge', () => ({
  createProcurementPayable: vi.fn(),
  cancelProcurementPayable: vi.fn(),
  registerProcurementSettlementHandler: vi.fn(() => () => undefined),
  registerProcurementSettlementReversedHandler: vi.fn(() => () => undefined),
  requestProcurementPaymentAuthorization: vi.fn(async (_tx: unknown, input: { obligationId: string }) => ({
    obligationId: input.obligationId,
    approvalRequestId: 'apr_payment',
    status: 'pending',
    autoApproved: false,
    reused: false,
    requiredApprovals: 1,
    approverCount: 1,
  })),
}));
vi.mock('@/modules/comms/comms-service', () => ({
  startConversation: mocks.startConversation,
  updateConversation: mocks.updateConversation,
  sendOutboundMessage: vi.fn(),
}));
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: mocks.chatCompletion }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({ utilityModel: 'modelo-utilitario' })) }));
vi.mock('./sourcing-providers', () => ({
  runBraveSearch: vi.fn(),
  runCatalogPages: vi.fn(),
  recordSourcingSpend: vi.fn(),
  sourcingUnitsUsedToday: vi.fn(async () => 0),
  cleanupSourcingThrottle: vi.fn(async () => 0),
}));

import { seedProfile } from '@/modules/inventory/testing/inventory-fixtures';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedAreas, seedResponsible } from '@/modules/operations/testing/fixtures';
import * as purchases from './purchases-commands';
import { getRfq } from './purchases-queries';
import { runRfqExpireJob } from './purchases-jobs';
import { interpretRfqReplyIfTagged, runRfqInterpretation } from './rfq-service';
import { seedCommAccount, seedPurchasesTeam, seedSupplier, type PurchasesTeam } from './testing/purchases-fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
let people: PurchasesTeam;

const rows = (model: string) => fake.rows(model);

function reply(conversationId: string, body: string, minutes = 60) {
  return fake.seed('commMessage', {
    accountId: 'acc_wa',
    conversationId,
    direction: 'inbound',
    body,
    mediaObjectIds: [],
    status: 'received',
    createdAt: new Date(NOW.getTime() + minutes * 60_000),
  });
}

function aiAnswer(json: Record<string, unknown>) {
  mocks.chatCompletion.mockResolvedValueOnce({ content: `Aquí está:\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, finishReason: 'stop' });
}

beforeEach(() => {
  fake.tables.clear();
  mocks.chatCompletion.mockReset();
  mocks.startConversation.mockClear();
  mocks.notifyUser.mockClear();
  invalidateOperationsConfigCache();
  fake.seed('integrationConfig', { source: 'operations', displayName: 'Operaciones', isEnabled: true, settings: {}, updatedAt: NOW });
  seedAreas(fake);
  people = seedPurchasesTeam(fake);
  seedResponsible(fake, { area: 'compras', userId: 'u_buyer' });
  seedCommAccount(fake);
  seedProfile(fake, { zohoItemId: 'item-1', baseUnit: 'm2', conversions: [{ unit: 'caja', factor: '1.44' }] });
  // The approved WhatsApp template of quotation requests (a business may only write first with one).
  fake.seed('integrationConfig', { source: 'sourcing', displayName: 'Laboratorio de Sourcing', isEnabled: true, settings: { rfqTemplateKey: 'HX_rfq' }, updatedAt: NOW });
});

/** A contact of the inbox with its consent to receive messages by WhatsApp. */
function seedConsentingContact(phone: string) {
  const contact = fake.seed('commContact', { id: `contact_${phone}`, displayName: phone, phone, tags: [] });
  fake.seed('consentRecord', { contactId: contact.id, channel: 'whatsapp', status: 'opted_in', source: 'phone_call', recordedAt: new Date('2026-09-01T00:00:00.000Z') });
  return contact;
}

describe('RFQ por WhatsApp', () => {
  it('invita, interpreta respuestas, confirma, compara y selecciona en una orden', async () => {
    const acme = seedSupplier(fake, { name: 'Acme Materiales', channels: [{ type: 'whatsapp', value: '+528111111111' }] });
    const broken = seedSupplier(fake, { name: 'Teléfono malo', primaryPhone: '+528100000000' });
    const candidate = fake.seed('sourcingCandidate', { id: 'cand_1', dedupeKey: 'tel:8122222222', name: 'Pisos del Norte', phone: '8122222222', confidence: '0.6' });
    seedConsentingContact('+528122222222');
    const blocked = seedSupplier(fake, { name: 'Bloqueado', status: 'blocked', primaryPhone: '+528133333333' });

    const created = await purchases.createRfq(
      people.buyer,
      { title: 'Obra Norte', dueAt: '2026-09-20', lines: [{ description: 'Porcelanato 60x60', qty: 100, unit: 'm2', zohoItemId: 'item-1' }] },
      { now: NOW }
    );
    expect(created).toMatchObject({ status: 'completed', data: { number: 'RFQ-000001', status: 'draft', lines: 1 } });
    const rfqId = created.data!.rfqId;

    const invited = await purchases.inviteSuppliers(
      people.buyer,
      { rfqId, invitees: [{ supplierId: acme.id as string }, { candidateId: 'cand_1' }, { supplierId: broken.id as string }, { supplierId: blocked.id as string }] },
      { commandId: 'invite-1', now: NOW }
    );
    expect(invited).toMatchObject({ sent: 2, failed: 1 });
    expect(invited.command.data!.skipped).toEqual([expect.objectContaining({ supplierId: blocked.id, reason: 'Bloqueado está bloqueado o archivado' })]);
    expect(mocks.startConversation).toHaveBeenCalledTimes(3);
    const firstCall = mocks.startConversation.mock.calls[0][1] as { body: string; to: string; accountId: string; templateKey?: string };
    expect(firstCall).toMatchObject({
      to: '+528111111111',
      accountId: 'acc_wa',
      templateKey: 'HX_rfq',
      templateVariables: { '1': 'Acme Materiales', '3': 'RFQ-000001', '4': 'Obra Norte', '5': '100 m2 Porcelanato 60x60' },
    });
    expect(mocks.updateConversation).not.toHaveBeenCalled();
    expect(firstCall.body).toContain('Hola Acme Materiales');
    expect(firstCall.body).toContain('RFQ-000001 (Obra Norte)');
    expect(firstCall.body).toContain('1. Porcelanato 60x60 — 100 m2');
    const invitations = rows('rfqInvitation');
    expect(invitations.map((i) => i.status)).toEqual(['sent', 'sent', 'failed']);
    expect(rows('commConversation').filter((c) => (c.tags as string[]).includes(`rfq:${rfqId}`))).toHaveLength(3);
    expect(candidate.status).toBe('rfq_sent');
    expect(rows('rfq')[0].status).toBe('sent');

    // Repeating the same command never sends twice.
    const replay = await purchases.inviteSuppliers(
      people.buyer,
      { rfqId, invitees: [{ supplierId: acme.id as string }, { candidateId: 'cand_1' }, { supplierId: broken.id as string }, { supplierId: blocked.id as string }] },
      { commandId: 'invite-1', now: NOW }
    );
    expect(replay.sent).toBe(0);
    expect(mocks.startConversation).toHaveBeenCalledTimes(3);

    // Acme answers in boxes, without tax: parsed.
    const acmeInvitation = invitations[0];
    const acmeReply = reply(acmeInvitation.conversationId as string, 'Le cotizo a $300 la caja de 1.44 m2 más IVA, flete $500, entrega 5 días');
    expect(await interpretRfqReplyIfTagged(acmeReply.id as string)).toEqual({ enqueued: 1 });
    const job = rows('backgroundJob').find((row) => row.type === 'purchases.rfq_interpret')!;
    expect(job).toMatchObject({
      payload: { invitationId: acmeInvitation.id, messageId: acmeReply.id },
      dedupeKey: `purchases.rfq_interpret:${acmeInvitation.id}:${acmeReply.id}`,
    });
    aiAnswer({ currency: 'MXN', taxIncluded: false, taxRate: 0.16, freight: 500, leadTimeDays: 5, lines: [{ rfqLineRef: 'L1', unitPrice: 300, unit: 'caja' }], confidence: 0.92 });
    const parsed = await runRfqInterpretation(acmeInvitation.id as string, { now: NOW });
    expect(parsed).toMatchObject({ status: 'completed', data: { status: 'parsed', reasons: [] } });
    const aiCall = mocks.chatCompletion.mock.calls[0][0] as { model: string; messages: Array<{ content: string }> };
    expect(aiCall.model).toBe('modelo-utilitario');
    expect(aiCall.messages[1].content).toContain('<untrusted source="respuesta_proveedor">');
    const acmeResponse = rows('rfqResponse').find((r) => r.supplierId === acme.id)!;
    expect(acmeResponse).toMatchObject({ status: 'parsed', receivedVia: 'conversation', sourceMessageIds: [acmeReply.id] });
    expect(Number(acmeResponse.landedTotal)).toBeCloseTo(24_746.67, 1);
    expect(String(rows('rfqResponseLine').find((l) => l.responseId === acmeResponse.id)!.unitFactorToBase)).toBe('1.44');
    expect(acmeInvitation.status).toBe('replied');
    expect(rows('rfq')[0].status).toBe('collecting');

    // An inbound message without an RFQ tag or an outbound one enqueues nothing.
    expect(await interpretRfqReplyIfTagged('out_1')).toEqual({ enqueued: 0 });

    // The candidate quotes in dollars: needs review, then confirmed with the exchange rate.
    const candidateInvitation = invitations[1];
    const candidateReply = reply(candidateInvitation.conversationId as string, 'Tenemos a 12 dólares el m2, IVA incluido');
    aiAnswer({ currency: 'USD', taxIncluded: true, lines: [{ rfqLineRef: 'L1', unitPrice: 12, unit: 'm2' }], confidence: 0.8, missingInfo: ['No indicó tiempo de entrega'] });
    const review = await runRfqInterpretation(candidateInvitation.id as string, { now: NOW });
    expect(review.status).toBe('completed');
    expect((review as { data: { status: string; reasons: string[] } }).data).toMatchObject({
      status: 'needs_review',
      reasons: ['Moneda USD: falta el tipo de cambio', 'No indicó tiempo de entrega'],
    });
    const candidateResponse = rows('rfqResponse').find((r) => r.candidateId === 'cand_1')!;
    expect(candidateResponse.sourceMessageIds).toEqual([candidateReply.id]);
    const reviewItem = rows('workItem').find((w) => w.objectType === 'rfq_response' && w.objectId === candidateResponse.id)!;
    expect(reviewItem).toMatchObject({ areaKey: 'compras', kind: 'verification', ownerUserId: 'u_buyer', status: 'open' });
    expect(candidate.status).toBe('quoted');
    const confirmed = await purchases.confirmRfqResponse(people.buyer, { responseId: candidateResponse.id as string, exchangeRate: 17.5 }, { now: NOW });
    expect(confirmed).toMatchObject({ status: 'completed', data: { response: { status: 'confirmed', landedTotal: '21000' } } });
    expect(reviewItem.status).toBe('done');

    // The AI can fail: the response waits for a person, nothing stops.
    const brokenInvitation = rows('rfqInvitation')[2];
    brokenInvitation.status = 'sent';
    reply(brokenInvitation.conversationId as string, 'Sí tengo');
    mocks.chatCompletion.mockRejectedValueOnce(new Error('sin llave de API'));
    const failed = await runRfqInterpretation(brokenInvitation.id as string, { now: NOW });
    expect((failed as { data: { status: string; reasons: string[] } }).data).toMatchObject({ status: 'needs_review' });
    expect((failed as { data: { reasons: string[] } }).data.reasons[0]).toContain('No se pudo interpretar con IA');

    // Comparison by landed cost: Acme (MXN, known lead time) beats the cheaper but riskier candidate.
    const compared = await purchases.compareRfq(people.buyer, { rfqId }, { now: NOW });
    expect(compared.status).toBe('completed');
    const ranking = compared.data!.ranking;
    expect(ranking.map((r) => r.name)).toEqual(['Acme Materiales', 'Pisos del Norte', 'Teléfono malo']);
    expect(ranking[0]).toMatchObject({ recommended: true, rank: 1 });
    expect(ranking[1].reasons).toContain('Proveedor nuevo (candidato)');
    expect(rows('rfq')[0].status).toBe('compared');
    const detail = await getRfq(people.buyer, rfqId, NOW);
    expect(detail.comparison.map((r) => r.responseId)).toEqual(ranking.map((r) => r.responseId));
    expect(detail.responses.find((r) => r.id === candidateResponse.id)).toMatchObject({ name: 'Pisos del Norte', status: 'confirmed' });

    // A response under review cannot be selected; the confirmed candidate is (and becomes a supplier).
    const brokenResponse = rows('rfqResponse').find((r) => r.supplierId === broken.id)!;
    expect(await purchases.selectRfqResponse(people.buyer, { responseId: brokenResponse.id as string }, { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
    // What the AI read (parsed) is not an order until a person confirms it; an expired quote neither.
    expect(await purchases.selectRfqResponse(people.buyer, { responseId: acmeResponse.id as string }, { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
      message: 'Revisa y confirma la respuesta antes de seleccionarla',
    });
    await purchases.confirmRfqResponse(people.buyer, { responseId: acmeResponse.id as string, validUntil: '2026-09-10' }, { now: NOW });
    const expired = await purchases.selectRfqResponse(people.buyer, { responseId: acmeResponse.id as string }, { now: NOW });
    expect(expired).toMatchObject({ status: 'rejected', errorCode: 'invalid_state' });
    expect(expired.message).toContain('venció');
    const selected = await purchases.selectRfqResponse(people.buyer, { responseId: candidateResponse.id as string, expectedAt: '2026-09-25' }, { now: NOW });
    expect(selected).toMatchObject({ status: 'completed', data: { orderNumber: 'OC-000001', quantityWarnings: [] } });
    const newSupplier = rows('supplier').find((s) => s.sourceCandidateId === 'cand_1')!;
    expect(newSupplier).toMatchObject({ name: 'Pisos del Norte', number: 'PRV-000001', tags: ['sourcing'] });
    expect(candidate).toMatchObject({ status: 'promoted', supplierId: newSupplier.id });
    const order = rows('procurementOrder')[0];
    expect(order).toMatchObject({ supplierId: newSupplier.id, currency: 'USD', status: 'draft', rfqResponseId: candidateResponse.id });
    const [orderLine] = rows('procurementOrderLine');
    expect(orderLine).toMatchObject({ description: 'Porcelanato 60x60', unit: 'm2', zohoItemId: 'item-1' });
    expect(Number(orderLine.unitPrice)).toBeCloseTo(12 / 1.16, 3);
    expect(rows('rfq')[0].status).toBe('closed');
    expect(candidateResponse.status).toBe('selected');
    expect(rows('supplierProduct').find((p) => p.supplierId === newSupplier.id)).toMatchObject({ zohoItemId: 'item-1', source: 'rfq', currency: 'USD' });
  });

  it('respuesta manual: exige unidades convertibles o el factor explícito', async () => {
    const supplier = seedSupplier(fake, { name: 'Beta' });
    const { data } = await purchases.createRfq(
      people.buyer,
      { title: 'Rollos', dueAt: '2026-09-22', lines: [{ description: 'Malla', qty: 50, unit: 'm2' }] },
      { now: NOW }
    );
    const [line] = rows('rfqLine');
    expect(
      await purchases.recordManualRfqResponse(
        people.buyer,
        { rfqId: data!.rfqId, supplierId: supplier.id as string, lines: [{ rfqLineId: line.id as string, unitPrice: 900, unit: 'rollo' }] },
        { now: NOW }
      )
    ).toMatchObject({ status: 'rejected', errorCode: 'invalid_unit' });
    const ok = await purchases.recordManualRfqResponse(
      people.buyer,
      {
        rfqId: data!.rfqId,
        supplierId: supplier.id as string,
        taxIncluded: true,
        leadTimeDays: 3,
        lines: [{ rfqLineId: line.id as string, unitPrice: 900, unit: 'rollo', unitsPerRfqUnit: 0.04 }],
      },
      { now: NOW }
    );
    expect(ok).toMatchObject({ status: 'completed', data: { response: { status: 'confirmed', receivedVia: 'manual', landedTotal: '1800' } } });
    expect(rows('rfq')[0].status).toBe('collecting');
  });

  it('vence sin respuestas: invitaciones expiradas, cotización cerrada y solicitudes de vuelta a abiertas', async () => {
    const supplier = seedSupplier(fake, { channels: [{ type: 'whatsapp', value: '+528144444444' }] });
    await purchases.createPurchaseRequest(people.buyer, { lines: [{ description: 'Pegazulejo', qty: 20, unit: 'bulto' }] }, { now: NOW });
    const [requestLine] = rows('purchaseRequestLine');
    const { data } = await purchases.createRfq(
      people.buyer,
      { title: 'Pegazulejo', dueAt: '2026-09-16', lines: [{ requestLineId: requestLine.id as string }] },
      { now: NOW }
    );
    expect(rows('purchaseRequest')[0].status).toBe('sourcing');
    await purchases.inviteSuppliers(people.buyer, { rfqId: data!.rfqId, invitees: [{ supplierId: supplier.id as string }] }, { now: NOW });
    const later = new Date('2026-09-17T00:00:00.000Z');
    const expired = await purchases.runRfqExpiration(data!.rfqId, '2026-09-17T00', later);
    expect(expired).toMatchObject({ status: 'completed', data: { expired: true, invitations: 1, responses: 0, status: 'closed' } });
    expect(rows('rfqInvitation')[0].status).toBe('expired');
    expect(rows('purchaseRequest')[0].status).toBe('open');
    expect(mocks.notifyUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u_buyer', type: 'purchase_rfq_expired' }));
  });
});

describe('primer contacto por WhatsApp y respuestas que no se pierden', () => {
  async function newRfq(title: string) {
    const created = await purchases.createRfq(
      people.buyer,
      { title, dueAt: '2026-09-20', lines: [{ description: 'Porcelanato 60x60', qty: 10, unit: 'm2', zohoItemId: 'item-1' }] },
      { now: NOW }
    );
    return created.data!.rfqId;
  }

  it('sin plantilla aprobada sólo escribe dentro de la ventana de 24 h, y nunca a un candidato sin consentimiento', async () => {
    const sourcing = rows('integrationConfig').find((row) => row.source === 'sourcing')!;
    sourcing.settings = {};
    const cold = seedSupplier(fake, { name: 'Sin conversación', channels: [{ type: 'whatsapp', value: '+528155555555' }] });
    const warm = seedSupplier(fake, { name: 'Con conversación', channels: [{ type: 'whatsapp', value: '+528166666666' }] });
    const warmContact = fake.seed('commContact', { id: 'contact_warm', displayName: 'Con conversación', phone: '+528166666666', tags: [] });
    fake.seed('commConversation', {
      id: 'conv_warm',
      accountId: 'acc_wa',
      contactId: warmContact.id,
      status: 'open',
      tags: [],
      unreadCount: 0,
      priority: 'normal',
      lastMessageAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
      lastInboundAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
    });
    fake.seed('sourcingCandidate', { id: 'cand_web', dedupeKey: 'tel:8177777777', name: 'Encontrado en la web', phone: '8177777777', confidence: '0.5' });
    const rfqId = await newRfq('Primer contacto');

    const invited = await purchases.inviteSuppliers(
      people.buyer,
      { rfqId, invitees: [{ supplierId: cold.id as string }, { supplierId: warm.id as string }, { candidateId: 'cand_web' }] },
      { commandId: 'invite-cold', now: NOW }
    );
    expect(invited).toMatchObject({ sent: 1, failed: 0 });
    const skipped = invited.command.data!.skipped;
    expect(skipped.find((s) => s.supplierId === cold.id)?.reason).toContain('plantilla aprobada');
    expect(skipped.find((s) => s.candidateId === 'cand_web')?.reason).toContain('sin consentimiento');
    const call = mocks.startConversation.mock.calls[0][1] as { to: string; templateKey?: string };
    expect(call.to).toBe('+528166666666');
    expect(call.templateKey).toBeUndefined();
    expect(rows('rfqInvitation')).toHaveLength(1);
  });

  it('concilia invitaciones que salieron sin registrarse y sólo interpreta la respuesta más reciente', async () => {
    const supplier = seedSupplier(fake, { name: 'Proveedor caído', channels: [{ type: 'whatsapp', value: '+528188888888' }] });
    const lost = seedSupplier(fake, { name: 'Nunca salió', channels: [{ type: 'whatsapp', value: '+528199999999' }] });
    const rfqId = await newRfq('Envío interrumpido');
    const sentAt = new Date(NOW.getTime() - 30 * 60_000);
    const pending = fake.seed('rfqInvitation', { id: 'inv_crash', rfqId, supplierId: supplier.id, channel: 'whatsapp', accountId: 'acc_wa', status: 'pending', sentAt });
    fake.seed('rfqInvitation', { id: 'inv_lost', rfqId, supplierId: lost.id, channel: 'whatsapp', accountId: 'acc_wa', status: 'pending', sentAt });
    const contact = fake.seed('commContact', { id: 'contact_crash', displayName: 'Proveedor caído', phone: '+528188888888', tags: [] });
    fake.seed('commConversation', { id: 'conv_crash', accountId: 'acc_wa', contactId: contact.id, status: 'open', tags: [], unreadCount: 0, priority: 'normal', lastMessageAt: sentAt });
    fake.seed('commMessage', { id: 'out_crash', accountId: 'acc_wa', conversationId: 'conv_crash', direction: 'outbound', body: 'Hola', mediaObjectIds: [], status: 'sent', createdAt: sentAt });

    const summary = await runRfqExpireJob(NOW);
    expect(summary).toMatchObject({ reconciledInvitations: 2 });
    expect(pending).toMatchObject({ status: 'sent', conversationId: 'conv_crash', messageId: 'out_crash' });
    expect(rows('rfqInvitation').find((i) => i.id === 'inv_lost')).toMatchObject({ status: 'failed' });
    expect(rows('commConversation').find((c) => c.id === 'conv_crash')!.tags).toEqual([`rfq:${rfqId}`]);

    const first = reply('conv_crash', 'Le cotizo mañana', 1);
    const second = reply('conv_crash', 'Ya tengo precio: $250 el m2', 2);
    expect(await interpretRfqReplyIfTagged(first.id as string)).toEqual({ enqueued: 1 });
    expect(await interpretRfqReplyIfTagged(second.id as string)).toEqual({ enqueued: 1 });
    expect(rows('backgroundJob').filter((job) => job.type === 'purchases.rfq_interpret')).toHaveLength(2);
    expect(await runRfqInterpretation('inv_crash', { now: NOW, messageId: first.id as string })).toEqual({ status: 'skipped', reason: 'superseded' });
    expect(mocks.chatCompletion).not.toHaveBeenCalled();
  });
});
