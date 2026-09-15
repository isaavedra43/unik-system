import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sourcing Lab searches on FakePrisma with the providers mocked: a search is
 * queued once, a repeated search answers from cache without spending, the
 * daily budget and the allowed hosts are enforced, results are deduplicated
 * against existing candidates and marked when they already are suppliers, and
 * candidates are promoted without duplicating suppliers.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('./testing/purchases-fixtures');
  return {
    fake: fixtures.createPurchasesFake(),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
    runBraveSearch: vi.fn(),
    runCatalogPages: vi.fn(),
    recordSourcingSpend: vi.fn(async () => undefined),
    usedToday: { units: 0 },
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
vi.mock('@/modules/comms/comms-service', () => ({ startConversation: vi.fn(), updateConversation: vi.fn(), sendOutboundMessage: vi.fn() }));
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: vi.fn() }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('./sourcing-providers', () => ({
  runBraveSearch: mocks.runBraveSearch,
  runCatalogPages: mocks.runCatalogPages,
  recordSourcingSpend: mocks.recordSourcingSpend,
  sourcingUnitsUsedToday: vi.fn(async () => mocks.usedToday.units),
  cleanupSourcingThrottle: vi.fn(async () => 0),
}));

import type { JobContext } from '@/modules/jobs/job-queue';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedAreas } from '@/modules/operations/testing/fixtures';
import * as purchases from './purchases-commands';
import { getSourcingCandidate, listSourcingCandidates } from './purchases-queries';
import { invalidateSourcingConfigCache } from './sourcing-config';
import { runSourcingSearchJob } from './sourcing-service';
import { seedPurchasesTeam, seedSupplier, type PurchasesTeam } from './testing/purchases-fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
let people: PurchasesTeam;
const rows = (model: string) => fake.rows(model);
const meter = (key: string, unit: string) =>
  rows('usageMeter').find((row) => row.dimension === 'extension' && row.key === key && row.unit === unit && row.period === '2026-09-15');
const unitsSpent = () => Number(meter('sourcing', 'units')?.amount ?? 0);
function seedSpent(units: number) {
  const existing = meter('sourcing', 'units');
  if (existing) existing.amount = units;
  else fake.seed('usageMeter', { dimension: 'extension', key: 'sourcing', period: '2026-09-15', unit: 'units', count: 1, amount: units });
}

function job(payload: unknown, id = 'job_search'): JobContext<unknown> {
  return {
    id,
    type: 'purchases.sourcing_search',
    payload,
    attempt: 1,
    signal: new AbortController().signal,
    async setProgress() {},
    log() {},
  };
}

const draft = (overrides: Record<string, unknown>) => ({
  url: null,
  domain: null,
  email: null,
  phone: null,
  location: null,
  productsSummary: null,
  priceSnippets: [],
  evidence: [{ url: 'https://buscador/x', fetchedAt: NOW.toISOString(), objectId: 'raw_1', sha256: null }],
  confidence: 0.35,
  ...overrides,
});

beforeEach(() => {
  fake.tables.clear();
  mocks.runBraveSearch.mockReset();
  mocks.runCatalogPages.mockReset();
  mocks.recordSourcingSpend.mockClear();
  mocks.notifyUser.mockClear();
  mocks.usedToday.units = 0;
  invalidateOperationsConfigCache();
  invalidateSourcingConfigCache();
  fake.seed('integrationConfig', { source: 'operations', displayName: 'Operaciones', isEnabled: true, settings: {}, updatedAt: NOW });
  seedAreas(fake);
  people = seedPurchasesTeam(fake);
});

describe('laboratorio de sourcing', () => {
  it('busca una vez, deduplica, detecta proveedores existentes y responde repetidas desde caché sin gastar', async () => {
    const acme = seedSupplier(fake, { name: 'Acme Materiales', website: 'https://acme.mx' });
    const existing = fake.seed('sourcingCandidate', {
      id: 'cand_old',
      dedupeKey: 'tel:8112345678',
      name: 'Gamma Pisos',
      phone: '8112345678',
      evidence: [{ url: 'https://antes', fetchedAt: '2026-09-01T00:00:00.000Z', objectId: null, sha256: null }],
    });
    mocks.runBraveSearch.mockResolvedValue({
      candidates: [
        { ...draft({ name: 'Acme | Pisos', url: 'https://www.acme.mx/p', domain: 'acme.mx' }), dedupeKey: 'dom:acme.mx' },
        { ...draft({ name: 'Beta Azulejos', phone: '8199999999' }), dedupeKey: 'tel:8199999999' },
        { ...draft({ name: 'Gamma', phone: '+52 81 1234 5678', confidence: 0.7 }), dedupeKey: 'tel:8112345678' },
      ],
      costUnits: 1,
      rawResultObjectId: 'raw_1',
      error: null,
      detail: {},
    });

    const requested = await purchases.runSourcingSearch(people.buyer, { query: 'Porcelanato 60x60 Monterrey' }, { now: NOW });
    expect(requested).toMatchObject({ status: 'completed', data: { cached: false, jobQueued: true, estimatedCostUnits: 1, status: 'pending' } });
    const search = rows('sourcingSearch')[0];
    expect(search).toMatchObject({ providerKey: 'brave_search', status: 'pending', createdByUserId: 'u_buyer' });
    const queued = rows('backgroundJob').filter((row) => row.type === 'purchases.sourcing_search');
    expect(queued).toEqual([expect.objectContaining({ payload: { searchId: search.id }, createdBy: 'u_buyer' })]);

    const ran = await runSourcingSearchJob(job({ searchId: search.id }), { now: NOW });
    expect(ran).toMatchObject({ status: 'completed', candidates: 3, costUnits: 1 });
    expect(mocks.runBraveSearch).toHaveBeenCalledWith(
      'Porcelanato 60x60 Monterrey',
      { maxResults: undefined, country: undefined },
      expect.objectContaining({ searchId: search.id, actor: expect.objectContaining({ id: 'u_buyer' }) })
    );
    // Reserved when queued (1 unit), spent exactly that: nothing released, one search counted.
    expect(unitsSpent()).toBe(1);
    expect(meter('sourcing:brave_search', 'searches')).toMatchObject({ count: 1 });
    expect(search).toMatchObject({ status: 'done', resultCount: 3, costUnits: 1, rawResultObjectId: 'raw_1' });
    expect(search.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 86_400_000));
    const candidates = rows('sourcingCandidate');
    expect(candidates).toHaveLength(3);
    expect(candidates.find((c) => c.dedupeKey === 'dom:acme.mx')).toMatchObject({ supplierId: acme.id, status: 'new' });
    expect(existing).toMatchObject({ name: 'Gamma Pisos', searchId: search.id });
    expect((existing.evidence as unknown[]).length).toBe(2);
    expect(Number(existing.confidence)).toBe(0.7);
    expect(mocks.notifyUser).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u_buyer', type: 'purchase_sourcing_done', body: '3 candidato(s), 1 ya son proveedores' }));

    const cached = await purchases.runSourcingSearch(people.buyer, { query: '  porcelanato 60X60   monterrey ' }, { now: NOW });
    expect(cached).toMatchObject({ status: 'completed', data: { cached: true, jobQueued: false, estimatedCostUnits: 0, resultCount: 3, searchId: search.id } });
    expect(rows('backgroundJob').filter((row) => row.type === 'purchases.sourcing_search')).toHaveLength(1);
    expect(mocks.runBraveSearch).toHaveBeenCalledTimes(1);
    expect(unitsSpent()).toBe(1);

    const page = await listSourcingCandidates(people.buyer, { searchId: search.id as string, excludeKnown: true });
    expect(page.rows.map((c) => c.name).sort()).toEqual(['Beta Azulejos', 'Gamma Pisos']);
  });

  it('presupuesto diario, sitios autorizados y búsquedas fallidas', async () => {
    seedSpent(200);
    expect(await purchases.runSourcingSearch(people.buyer, { query: 'adhesivo cerámico' }, { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'budget_exhausted',
    });
    seedSpent(0);

    expect(
      await purchases.runSourcingSearch(people.buyer, { query: 'malla', providerKey: 'catalog_page', urls: ['https://catalogo.mx/malla'] }, { now: NOW })
    ).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    fake.seed('integrationConfig', { source: 'sourcing', displayName: 'Laboratorio', isEnabled: true, settings: { allowedHosts: ['catalogo.mx'] }, updatedAt: NOW });
    const allowed = await purchases.runSourcingSearch(
      people.buyer,
      { query: 'malla', providerKey: 'catalog_page', urls: ['https://catalogo.mx/malla'] },
      { now: NOW }
    );
    expect(allowed).toMatchObject({ status: 'completed', data: { estimatedCostUnits: 2, jobQueued: true } });

    mocks.runCatalogPages.mockResolvedValueOnce({ candidates: [], costUnits: 1, rawResultObjectId: null, error: 'El sitio pidió comprobar que no somos un robot; no se consulta', detail: {} });
    const search = rows('sourcingSearch')[0];
    await runSourcingSearchJob(job({ searchId: search.id }, 'job_catalog'), { now: NOW });
    expect(search).toMatchObject({ status: 'failed', expiresAt: null, error: 'El sitio pidió comprobar que no somos un robot; no se consulta' });
    // Two units reserved for one page; the provider spent one: the other is given back.
    expect(unitsSpent()).toBe(1);
    expect(mocks.runCatalogPages).toHaveBeenCalledWith('malla', ['https://catalogo.mx/malla'], expect.anything());

    // A failed search is not a cache hit: asking again queues it again.
    const retry = await purchases.runSourcingSearch(
      people.buyer,
      { query: 'malla', providerKey: 'catalog_page', urls: ['https://catalogo.mx/malla'] },
      { now: NOW }
    );
    expect(retry).toMatchObject({ status: 'completed', data: { cached: false, jobQueued: true } });

    expect(await purchases.runSourcingSearch(people.outsider, { query: 'malla' }, { now: NOW })).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });

  it('promover candidatos: crea proveedor con sus canales o liga el existente', async () => {
    const acme = seedSupplier(fake, { name: 'Acme Materiales', website: 'https://acme.mx' });
    fake.seed('sourcingCandidate', { id: 'cand_beta', dedupeKey: 'tel:8199999999', name: 'Beta Azulejos', phone: '8199999999', email: 'ventas@beta.mx', url: 'https://beta.mx' });
    fake.seed('sourcingCandidate', { id: 'cand_acme', dedupeKey: 'dom:acme.mx', name: 'ACME', domain: 'acme.mx', url: 'https://acme.mx' });
    fake.seed('contact', { zohoContactId: 'z_beta', contactType: 'vendor', companyName: 'Beta Azulejos SA', mobile: '+528199999999', sourceRemoteModifiedAt: NOW, sourceSnapshotId: 's' });

    const detail = await getSourcingCandidate(people.buyer, 'cand_beta');
    expect(detail.zohoVendor).toEqual({ zohoContactId: 'z_beta', name: 'Beta Azulejos SA', reason: 'phone' });

    const promoted = await purchases.promoteCandidateToSupplier(people.buyer, { candidateId: 'cand_beta', paymentMode: 'credit', paymentTermsDays: 15 }, { now: NOW });
    expect(promoted).toMatchObject({ status: 'completed', data: { created: true, supplier: { name: 'Beta Azulejos', zohoContactId: 'z_beta', paymentMode: 'credit' } } });
    expect(promoted.data!.supplier.channels).toEqual([
      { type: 'whatsapp', value: '8199999999' },
      { type: 'email', value: 'ventas@beta.mx' },
      { type: 'web', value: 'https://beta.mx' },
    ]);
    expect(rows('sourcingCandidate').find((c) => c.id === 'cand_beta')).toMatchObject({ status: 'promoted', supplierId: promoted.data!.supplier.id });

    const linked = await purchases.promoteCandidateToSupplier(people.buyer, { candidateId: 'cand_acme' }, { now: NOW });
    expect(linked).toMatchObject({ status: 'completed', data: { created: false, supplier: { id: acme.id } } });
    expect(rows('supplier')).toHaveLength(2);

    expect(await purchases.setCandidateStatus(people.buyer, { candidateId: 'cand_acme', status: 'rejected' }, { now: NOW })).toMatchObject({
      status: 'rejected',
      errorCode: 'invalid_state',
    });
    expect(
      await purchases.createSupplier(people.buyer, { name: 'Beta Azulejos', channels: [{ type: 'whatsapp', value: '+52 81 9999 9999' }] }, { now: NOW })
    ).toMatchObject({ status: 'rejected', errorCode: 'duplicate' });
  });
});

describe('presupuesto del laboratorio con búsquedas simultáneas y reintentos', () => {
  it('reserva al encolar, nunca rebasa el día y un reintento vuelve a reservar antes de gastar', async () => {
    fake.seed('integrationConfig', { source: 'sourcing', displayName: 'Laboratorio', isEnabled: true, settings: { dailyBudgetUnits: 3, allowedHosts: ['catalogo.mx'] }, updatedAt: NOW });
    const first = await purchases.runSourcingSearch(people.buyer, { query: 'adhesivo uno' }, { now: NOW });
    const second = await purchases.runSourcingSearch(people.buyer, { query: 'adhesivo dos' }, { now: NOW });
    expect([first.status, second.status]).toEqual(['completed', 'completed']);
    expect(unitsSpent()).toBe(2);
    // Nothing has run yet, but the pending searches already hold their units.
    const catalog = await purchases.runSourcingSearch(
      people.buyer,
      { query: 'malla', providerKey: 'catalog_page', urls: ['https://catalogo.mx/malla'] },
      { now: NOW }
    );
    expect(catalog).toMatchObject({ status: 'rejected', errorCode: 'budget_exhausted' });
    expect(unitsSpent()).toBe(2);

    // A retry of the first search reserves again: with 1 unit left it runs; the next retry finds no budget.
    mocks.runBraveSearch.mockResolvedValue({ candidates: [], costUnits: 1, rawResultObjectId: null, error: 'Sin resultados', detail: {} });
    const searchId = first.data!.searchId;
    const retried = await runSourcingSearchJob({ ...job({ searchId }, 'job_retry'), attempt: 2 }, { now: NOW });
    expect(retried).toMatchObject({ costUnits: 1 });
    expect(unitsSpent()).toBe(3);
    const otherId = second.data!.searchId;
    const exhausted = await runSourcingSearchJob({ ...job({ searchId: otherId }, 'job_retry_2'), attempt: 2 }, { now: NOW });
    expect(exhausted).toMatchObject({ error: 'budget_exhausted', costUnits: 0 });
    expect(mocks.runBraveSearch).toHaveBeenCalledTimes(1);
    expect(rows('sourcingSearch').find((row) => row.id === otherId)).toMatchObject({ status: 'failed' });
    expect(unitsSpent()).toBe(3);
  });
});
