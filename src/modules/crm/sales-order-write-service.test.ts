import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Accepted quote → sales order on FakePrisma with the real command engine, the
 * real sales order normalizer and the operations hook (plan 6.5):
 * one order in mock mode (snapshot, normalized row, case start job, opportunity
 * won, read-back scheduled), replay of the key, no second order for the same
 * quote, rejection of a quote that is not accepted with retry of the same key,
 * reuse of the Zoho order of a failed attempt, in-flight and reused keys,
 * permission, the real Zoho path with a mocked client, and the read-back that
 * opens an incident when Zoho disagrees.
 */

const mocks = await vi.hoisted(async () => {
  const { createCrmFake } = await import('./testing/crm-fixtures');
  return {
    fake: createCrmFake(),
    zoho: { mock: true },
    createSalesOrder: vi.fn(),
    getSalesOrder: vi.fn(),
    refreshQuoteFromZoho: vi.fn(async () => undefined),
    recordAuditEvent: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({
  notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
}));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const { withCrmPermissions } = await import('./testing/crm-permissions-mock');
  return withCrmPermissions(await importOriginal<typeof import('@/modules/auth/permissions')>());
});
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: mocks.recordAuditEvent }));
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/integrations/zoho/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/integrations/zoho/config')>()),
  isZohoBooksMockEnabled: () => mocks.zoho.mock,
}));
vi.mock('@/modules/integrations/zoho/sales-orders', () => ({
  createSalesOrder: mocks.createSalesOrder,
  getSalesOrder: mocks.getSalesOrder,
}));
vi.mock('@/modules/integrations/zoho/sales-orders-sync', () => ({ SOURCE: 'zoho', ENTITY_TYPE: 'sales_order' }));
vi.mock('@/modules/quotes/quotes-write-service', () => ({
  QuoteWriteError: class QuoteWriteError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status = 400
    ) {
      super(message);
    }
  },
  refreshQuoteFromZoho: mocks.refreshQuoteFromZoho,
}));

import type { Row } from '@/modules/comms/testing/fake-prisma';
import { ZohoApiError } from '@/modules/integrations/zoho/client';
import { invalidateOperationsConfigCache, updateOperationsConfig } from '@/modules/operations/operations-config';
import { seedArea, seedResponsible, seedUser } from '@/modules/operations/testing/fixtures';
import { CrmError } from './crm-helpers';
import { ensurePipelineSeed } from './pipeline-service';
import { buildMockSalesOrderResponse, buildSalesOrderPayload, type QuoteRow } from './sales-order-rules';
import { relinkCasesOfSalesOrder } from './opportunities-service';
import { createSalesOrderFromQuote, runSalesOrderReadback } from './sales-order-write-service';
import { seedOpportunity, seedQuote } from './testing/crm-fixtures';

const { fake } = mocks;

const seller = seedUser(fake, {
  id: 'u-seller',
  name: 'Luis Vendedor',
  permissions: ['crm.view', 'crm.manage', 'crm.create_sales_order'],
}).currentUser;
const viewer = seedUser(fake, { id: 'u-viewer', permissions: ['crm.view'] }).currentUser;
seedArea(fake, 'ventas');
seedResponsible(fake, { area: 'ventas', userId: 'u-seller' });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.zoho.mock = true;
  invalidateOperationsConfigCache();
  await ensurePipelineSeed();
});

const ordersWithReference = (reference: string) => fake.rows('salesOrder').filter((row) => row.referenceNumber === reference);
const ledger = (requestKey: string) => fake.rows('salesOrderWriteRequest').find((row) => row.requestKey === requestKey);
const jobsOf = (type: string) => fake.rows('backgroundJob').filter((job) => job.type === type);
const stageId = (key: string) => (fake.rows('pipelineStage').find((stage) => stage.key === key) as Row).id as string;
const activitiesOf = (opportunityId: string) => fake.rows('opportunityActivity').filter((row) => row.opportunityId === opportunityId);
const quoteRow = (id: string): Promise<QuoteRow> => fake.client.quote.findUnique({ where: { id }, include: { items: true } });

function acceptedQuote(id: string, estimateNumber: string, status = 'accepted') {
  return seedQuote(fake, { id, zohoEstimateId: `460${estimateNumber.replace(/\D/g, '')}`, estimateNumber, status });
}

describe('createSalesOrderFromQuote (ZOHO_BOOKS_MOCK=true)', () => {
  it('creates one order, normalizes it, wins the opportunity, starts the case hook and schedules the read-back', async () => {
    acceptedQuote('q-1', 'COT-00042');
    seedOpportunity(fake, {
      id: 'opp-1',
      number: 'OPP-900001',
      stageId: stageId('cotizado'),
      zohoContactId: 'zc-1',
      zohoEstimateIds: ['46000042'],
    });

    const result = await createSalesOrderFromQuote(seller, { quoteId: 'q-1', requestKey: 'req-so-0001' });

    expect(result).toMatchObject({
      requestKey: 'req-so-0001',
      salesOrderNumber: expect.stringMatching(/^SO-MOCK-\d{5}$/),
      quoteId: 'q-1',
      estimateNumber: 'COT-00042',
      opportunityId: 'opp-1',
      opportunityNumber: 'OPP-900001',
      total: '5568',
      currencyCode: 'MXN',
      replayed: false,
      mock: true,
    });
    expect(mocks.createSalesOrder).not.toHaveBeenCalled();

    const orders = ordersWithReference('COT-00042');
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      id: result.salesOrderId,
      zohoSalesOrderId: result.zohoSalesOrderId,
      salesOrderNumber: result.salesOrderNumber,
      zohoCustomerId: 'zc-1',
      status: 'confirmed',
    });
    expect(fake.rows('salesOrderItem').filter((item) => item.salesOrderId === result.salesOrderId)).toHaveLength(1);
    expect(fake.rows('integrationSnapshot').filter((row) => row.externalId === result.zohoSalesOrderId)).toHaveLength(1);
    expect(ledger('req-so-0001')).toMatchObject({
      status: 'completed',
      operation: 'create_from_quote',
      userId: 'u-seller',
      salesOrderId: result.salesOrderId,
      zohoSalesOrderId: result.zohoSalesOrderId,
      zohoEstimateId: '46000042',
      opportunityId: 'opp-1',
    });

    const opportunity = fake.rows('opportunity').find((row) => row.id === 'opp-1') as Row;
    expect(opportunity).toMatchObject({ status: 'won', zohoSalesOrderIds: [result.zohoSalesOrderId], wonAt: expect.any(Date) });
    expect(activitiesOf('opp-1').map((a) => [a.kind, a.summary])).toEqual(
      expect.arrayContaining([
        ['order_created', `Orden de venta ${result.salesOrderNumber} creada por $5,568.00`],
        ['stage_change', 'Etapa: Cotizado → Ganado'],
      ])
    );

    const [readback] = jobsOf('crm.sales_order_readback');
    expect(readback).toMatchObject({
      payload: { requestKey: 'req-so-0001' },
      dedupeKey: `crm:so_readback:${result.zohoSalesOrderId}`,
      maxAttempts: 5,
    });
    expect((readback.runAt as Date).getTime()).toBeGreaterThan(Date.now() + 3_000);
    expect(jobsOf('ops.case.start')).toContainEqual(
      expect.objectContaining({ dedupeKey: `case:so:${result.zohoSalesOrderId}`, payload: { zohoSalesOrderId: result.zohoSalesOrderId } })
    );
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'crm.sales_order.created', targetId: result.salesOrderId })
    );
  });

  it('replays the same request key without creating a second order', async () => {
    acceptedQuote('q-2', 'COT-00043');
    const first = await createSalesOrderFromQuote(seller, { quoteId: 'q-2', requestKey: 'req-so-0002' });
    const again = await createSalesOrderFromQuote(seller, { quoteId: 'q-2', requestKey: 'req-so-0002' });

    expect(again).toMatchObject({ salesOrderId: first.salesOrderId, zohoSalesOrderId: first.zohoSalesOrderId, replayed: true });
    expect(ordersWithReference('COT-00043')).toHaveLength(1);
    expect(jobsOf('crm.sales_order_readback').filter((job) => (job.payload as Row).requestKey === 'req-so-0002')).toHaveLength(1);
  });

  it('never converts the same quote twice under another key', async () => {
    acceptedQuote('q-3', 'COT-00044');
    await createSalesOrderFromQuote(seller, { quoteId: 'q-3', requestKey: 'req-so-0003-a' });

    const attempt = createSalesOrderFromQuote(seller, { quoteId: 'q-3', requestKey: 'req-so-0003-b' });
    await expect(attempt).rejects.toBeInstanceOf(CrmError);
    await expect(attempt).rejects.toMatchObject({ code: 'quote_already_converted', status: 409 });
    expect(ordersWithReference('COT-00044')).toHaveLength(1);
    expect(ledger('req-so-0003-b')).toMatchObject({ status: 'failed', errorMessage: 'La cotización COT-00044 ya se convirtió en una orden de venta' });
  });

  it('rejects a quote that is not accepted and lets the same key retry once it is', async () => {
    acceptedQuote('q-4', 'COT-00045', 'sent');

    await expect(createSalesOrderFromQuote(seller, { quoteId: 'q-4', requestKey: 'req-so-0004' })).rejects.toMatchObject({
      code: 'quote_not_accepted',
      status: 409,
      message: 'La cotización COT-00045 está «Enviada»: sólo una cotización aceptada se convierte en orden de venta',
    });
    expect(ledger('req-so-0004')).toMatchObject({ status: 'failed' });
    expect(ordersWithReference('COT-00045')).toHaveLength(0);

    (fake.rows('quote').find((row) => row.id === 'q-4') as Row).status = 'accepted';
    const retried = await createSalesOrderFromQuote(seller, { quoteId: 'q-4', requestKey: 'req-so-0004' });

    expect(retried).toMatchObject({ estimateNumber: 'COT-00045', replayed: false });
    expect(ordersWithReference('COT-00045')).toHaveLength(1);
    expect(ledger('req-so-0004')).toMatchObject({ status: 'completed', errorMessage: null });
  });

  it('reuses the Zoho order of a failed attempt instead of creating another one', async () => {
    acceptedQuote('q-5', 'COT-00046');
    const quote = await quoteRow('q-5');
    const response = buildMockSalesOrderResponse({
      payload: buildSalesOrderPayload(quote, '2026-09-15'),
      quote,
      salesOrderId: '9555000000001',
      salesOrderNumber: 'SO-MOCK-09999',
      now: new Date(),
    });
    fake.seed('integrationSnapshot', {
      source: 'zoho',
      entityType: 'sales_order',
      externalId: '9555000000001',
      remoteModifiedAt: new Date(String(response.salesorder.last_modified_time)),
      payload: response,
      fetchedAt: new Date(),
    });
    fake.seed('salesOrderWriteRequest', {
      requestKey: 'req-so-0005',
      operation: 'create_from_quote',
      userId: 'u-seller',
      quoteId: 'q-5',
      zohoSalesOrderId: '9555000000001',
      status: 'failed',
      errorMessage: 'La base de datos no respondió',
      createdAt: new Date(Date.now() - 60_000),
    });

    const result = await createSalesOrderFromQuote(seller, { quoteId: 'q-5', requestKey: 'req-so-0005' });

    expect(result).toMatchObject({ zohoSalesOrderId: '9555000000001', salesOrderNumber: 'SO-MOCK-09999', replayed: false });
    expect(ordersWithReference('COT-00046')).toHaveLength(1);
  });

  it('rejects a request still in flight and a key used for another quote', async () => {
    acceptedQuote('q-6', 'COT-00047');
    fake.seed('salesOrderWriteRequest', {
      requestKey: 'req-so-0006',
      operation: 'create_from_quote',
      userId: 'u-seller',
      quoteId: 'q-6',
      status: 'pending',
      createdAt: new Date(),
    });
    await expect(createSalesOrderFromQuote(seller, { quoteId: 'q-6', requestKey: 'req-so-0006' })).rejects.toMatchObject({
      code: 'request_in_progress',
      status: 409,
    });
    await expect(createSalesOrderFromQuote(seller, { quoteId: 'q-6', requestKey: 'req-so-0001' })).rejects.toMatchObject({
      code: 'request_key_conflict',
      status: 409,
    });
    expect(ordersWithReference('COT-00047')).toHaveLength(0);
  });

  it('reuses the order Zoho already created under another key and lets the oldest request win', async () => {
    acceptedQuote('q-20', 'COT-00060');
    const quote = await quoteRow('q-20');
    const response = buildMockSalesOrderResponse({
      payload: buildSalesOrderPayload(quote, '2026-09-15'),
      quote,
      salesOrderId: '9555000000002',
      salesOrderNumber: 'SO-MOCK-08888',
      now: new Date(),
    });
    fake.seed('integrationSnapshot', {
      source: 'zoho',
      entityType: 'sales_order',
      externalId: '9555000000002',
      remoteModifiedAt: new Date(String(response.salesorder.last_modified_time)),
      payload: response,
      fetchedAt: new Date(),
    });
    // Zoho created it under key A; the local part failed, so the row keeps the order id.
    fake.seed('salesOrderWriteRequest', {
      requestKey: 'req-so-0008-a',
      operation: 'create_from_quote',
      userId: 'u-seller',
      quoteId: 'q-20',
      zohoSalesOrderId: '9555000000002',
      status: 'failed',
      errorMessage: 'La base de datos no respondió',
      createdAt: new Date(Date.now() - 60_000),
    });

    const recovered = await createSalesOrderFromQuote(seller, { quoteId: 'q-20', requestKey: 'req-so-0008-b' });
    expect(recovered).toMatchObject({ zohoSalesOrderId: '9555000000002', salesOrderNumber: 'SO-MOCK-08888' });
    expect(ordersWithReference('COT-00060')).toHaveLength(1);

    // A second key while an older request of the same quote is still in flight waits instead of posting.
    acceptedQuote('q-21', 'COT-00061');
    fake.seed('salesOrderWriteRequest', {
      requestKey: 'req-so-0021-a',
      operation: 'create_from_quote',
      userId: 'u-seller',
      quoteId: 'q-21',
      status: 'pending',
      createdAt: new Date(Date.now() - 1_000),
    });
    await expect(createSalesOrderFromQuote(seller, { quoteId: 'q-21', requestKey: 'req-so-0021-b' })).rejects.toMatchObject({
      code: 'request_in_progress',
      status: 409,
    });
    expect(ordersWithReference('COT-00061')).toHaveLength(0);
    expect(ledger('req-so-0021-b')).toMatchObject({ status: 'failed' });
  });

  it('re-links the cases of the order after creating it (the case may start first)', async () => {
    acceptedQuote('q-22', 'COT-00062');
    const created = await createSalesOrderFromQuote(seller, { quoteId: 'q-22', requestKey: 'req-so-0022' });
    const job = jobsOf('crm.link_cases').find((row) => (row.payload as Row).zohoSalesOrderId === created.zohoSalesOrderId);
    expect(job).toBeDefined();
    expect(job!.dedupeKey).toBe(`crm.link_cases:${created.zohoSalesOrderId}`);

    const opportunityId = (fake.rows('opportunity').find((row) => (row.zohoSalesOrderIds as string[]).includes(created.zohoSalesOrderId)) as Row).id as string;
    fake.seed('operationalCase', {
      id: 'case-late',
      caseSeq: 9001,
      caseNumber: 'EXP-9001',
      kind: 'sales_fulfillment',
      sourceType: 'sales_order',
      sourceId: created.zohoSalesOrderId,
      zohoSalesOrderId: created.zohoSalesOrderId,
      processVersionId: 'pv1',
      ownerUserId: 'u-seller',
    });
    expect(await relinkCasesOfSalesOrder(created.zohoSalesOrderId)).toBe(1);
    expect((fake.rows('opportunity').find((row) => row.id === opportunityId) as Row).caseIds).toEqual(['case-late']);
  });

  it('requires crm.create_sales_order', async () => {
    acceptedQuote('q-7', 'COT-00048');
    await expect(createSalesOrderFromQuote(viewer, { quoteId: 'q-7', requestKey: 'req-so-0007' })).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(ledger('req-so-0007')).toBeUndefined();
  });
});

describe('createSalesOrderFromQuote with Zoho (client mocked)', () => {
  it('refreshes the quote, posts the order once and flags a missing order on read-back', async () => {
    mocks.zoho.mock = false;
    acceptedQuote('q-9', 'COT-00049');
    // The real POST waits for the field set to be validated against the organization (operations flag).
    await expect(createSalesOrderFromQuote(seller, { quoteId: 'q-9', requestKey: 'req-so-0009-off' })).rejects.toMatchObject({
      code: 'module_disabled',
      status: 503,
    });
    expect(mocks.createSalesOrder).not.toHaveBeenCalled();
    await updateOperationsConfig({ flags: { crmSalesOrderWrite: true } });
    mocks.createSalesOrder.mockImplementation(async (payload) =>
      buildMockSalesOrderResponse({
        payload,
        quote: await quoteRow('q-9'),
        salesOrderId: '4600012345',
        salesOrderNumber: 'SO-00777',
        now: new Date(),
      })
    );

    const result = await createSalesOrderFromQuote(seller, { quoteId: 'q-9', requestKey: 'req-so-0009' });

    expect(result).toMatchObject({ zohoSalesOrderId: '4600012345', salesOrderNumber: 'SO-00777', mock: false });
    expect(mocks.refreshQuoteFromZoho).toHaveBeenCalledWith('q-9', 'u-seller');
    expect(mocks.createSalesOrder).toHaveBeenCalledTimes(1);
    expect(mocks.createSalesOrder.mock.calls[0][0]).toMatchObject({
      customer_id: 'zc-1',
      reference_number: 'COT-00049',
      salesperson_name: 'Ana López',
      line_items: [expect.objectContaining({ item_id: '4600000400', quantity: 15, rate: 320 })],
    });

    mocks.getSalesOrder.mockRejectedValue(new ZohoApiError('Zoho request failed', 'GET /salesorders/4600012345', 404));
    expect(await runSalesOrderReadback('req-so-0009')).toMatchObject({ status: 'mismatch', zohoSalesOrderId: '4600012345' });
    expect(fake.rows('incident').find((row) => row.dedupeKey === 'crm:so_readback:4600012345')).toMatchObject({
      kind: 'sales_order_readback_mismatch',
      title: 'La orden SO-00777 no se encontró en Zoho al releerla',
      detail: expect.objectContaining({ missing: true }),
    });
  });
});

describe('runSalesOrderReadback (mock)', () => {
  it('confirms a faithful order and opens one incident when Zoho differs from the quote', async () => {
    acceptedQuote('q-10', 'COT-00050');
    const result = await createSalesOrderFromQuote(seller, { quoteId: 'q-10', requestKey: 'req-so-0010' });
    const dedupeKey = `crm:so_readback:${result.zohoSalesOrderId}`;

    expect(await runSalesOrderReadback('req-so-0010')).toMatchObject({ status: 'ok', differences: [] });
    expect(fake.rows('incident').filter((row) => row.dedupeKey === dedupeKey)).toHaveLength(0);

    const snapshot = fake.rows('integrationSnapshot').find((row) => row.externalId === result.zohoSalesOrderId) as Row;
    const salesorder = (snapshot.payload as { salesorder: Row }).salesorder;
    snapshot.payload = {
      code: 0,
      salesorder: { ...salesorder, line_items: [{ ...(salesorder.line_items as Row[])[0], quantity: 12 }] },
    };

    const mismatch = await runSalesOrderReadback('req-so-0010');
    expect(mismatch).toMatchObject({
      status: 'mismatch',
      differences: [{ field: 'line_quantity', label: 'Cantidad del concepto 1', expected: 15, actual: 12, line: 1 }],
    });
    const incidents = fake.rows('incident').filter((row) => row.dedupeKey === dedupeKey);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      kind: 'sales_order_readback_mismatch',
      areaKey: 'ventas',
      severity: 'high',
      ownerUserId: 'u-seller',
      title: `La orden ${result.salesOrderNumber} en Zoho no coincide con la cotización COT-00050`,
    });

    // The opportunity was created from the quote (there was none) and carries the warning.
    const opportunity = fake.rows('opportunity').find((row) => row.id === result.opportunityId) as Row;
    expect(opportunity).toMatchObject({ source: 'quote', status: 'won', zohoEstimateIds: ['46000050'] });
    expect(activitiesOf(opportunity.id as string).map((a) => a.summary)).toContainEqual(
      expect.stringContaining('Cantidad del concepto 1: esperado 15, Zoho 12')
    );

    await runSalesOrderReadback('req-so-0010');
    expect(fake.rows('incident').filter((row) => row.dedupeKey === dedupeKey)).toHaveLength(1);
    expect(await runSalesOrderReadback('unknown-key')).toEqual({ status: 'skipped', reason: 'not_completed' });
  });
});
