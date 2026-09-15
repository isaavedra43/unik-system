import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AI tools of Compras: registration (names, effects, permissions), Spanish
 * approval summaries, argument preparation (display fields, authority of AI
 * identities) and execution through the purchases commands on FakePrisma.
 */

const mocks = await vi.hoisted(async () => {
  const fixtures = await import('@/modules/purchases/testing/purchases-fixtures');
  return {
    fake: fixtures.createPurchasesFake(),
    notifyUser: vi.fn(async () => ({ id: 'n1', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
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
  const { PURCHASES_PERMISSIONS } = await import('@/modules/purchases/permissions');
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
vi.mock('@/modules/purchases/finance-bridge', () => ({
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
vi.mock('@/modules/purchases/sourcing-providers', () => ({
  runBraveSearch: vi.fn(),
  runCatalogPages: vi.fn(),
  recordSourcingSpend: vi.fn(),
  sourcingUnitsUsedToday: vi.fn(async () => 0),
  cleanupSourcingThrottle: vi.fn(async () => 0),
}));

import { AuthorizationError, type CurrentUser } from '@/modules/auth/authorization';
import { AGENT_BOTS } from '@/modules/agents/identity-catalog';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedAreas } from '@/modules/operations/testing/fixtures';
import * as purchases from '@/modules/purchases/purchases-commands';
import { seedPurchasesTeam, seedSupplier, type PurchasesTeam } from '@/modules/purchases/testing/purchases-fixtures';
import { PROCUREMENT_TOOL_NAMES } from './procurement-tools';
import { OperationsToolError } from './operations-tool-kit';
import { getToolDefinition, type ToolDefinition } from './registry';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
let people: PurchasesTeam;

function tool(name: string): ToolDefinition {
  const def = getToolDefinition(name);
  if (!def) throw new Error(`Tool ${name} no registrada`);
  return def;
}

function botOf(areaKey: string): CurrentUser {
  const def = AGENT_BOTS.find((bot) => bot.kind === 'area' && bot.coversAreaKey === areaKey)!;
  return {
    id: `bot_${areaKey}`,
    username: `ia_${areaKey}`,
    name: `IA de ${areaKey}`,
    email: null,
    mustChangePassword: false,
    roleKeys: [def.roleKey],
    permissionKeys: ['purchases.view', 'purchases.manage_orders', 'purchases.sourcing'] as never,
    isSuperAdmin: false,
    isBot: true,
  };
}

beforeEach(() => {
  fake.tables.clear();
  invalidateOperationsConfigCache();
  fake.seed('integrationConfig', { source: 'operations', displayName: 'Operaciones', isEnabled: true, settings: {}, updatedAt: NOW });
  seedAreas(fake);
  people = seedPurchasesTeam(fake);
});

describe('registro', () => {
  it('nombres nuevos, categoría compras, efecto y permiso correctos', () => {
    const expected: Record<string, [string, string]> = {
      listPurchaseRequests: ['read', 'purchases.view'],
      searchSuppliers: ['read', 'purchases.view'],
      runSourcingSearch: ['internal_task', 'purchases.sourcing'],
      listSourcingCandidates: ['read', 'purchases.view'],
      draftRfq: ['draft', 'purchases.manage_orders'],
      sendRfq: ['external_send', 'purchases.manage_orders'],
      interpretRfqReply: ['internal_task', 'purchases.manage_orders'],
      compareRfq: ['read', 'purchases.view'],
      createProcurementOrderDraft: ['draft', 'purchases.manage_orders'],
      submitProcurementOrder: ['business_write', 'purchases.manage_orders'],
      recordGoodsReceipt: ['business_write', 'purchases.receive'],
    };
    expect([...PROCUREMENT_TOOL_NAMES].sort()).toEqual(Object.keys(expected).sort());
    for (const [name, [effect, permission]] of Object.entries(expected)) {
      expect(tool(name)).toMatchObject({ category: 'purchases', effect, requiredPermission: permission, enabledByDefault: true });
    }
  });

  it('lecturas abiertas a quien solicita o busca aunque no tenga compras.view', () => {
    const requester = { ...people.outsider, permissionKeys: ['purchases.request'] as never };
    const searcher = { ...people.outsider, permissionKeys: ['purchases.sourcing'] as never };
    expect(tool('listPurchaseRequests').allowActor!(requester)).toBe(true);
    expect(tool('listSourcingCandidates').allowActor!(searcher)).toBe(true);
    expect(tool('compareRfq').allowActor!(people.outsider)).toBe(false);
  });
});

describe('resúmenes para aprobación', () => {
  it('en español con los datos que completó el sistema', () => {
    expect(tool('runSourcingSearch').summarize!({ query: 'porcelanato 60x60', providerKey: 'brave_search' })).toBe(
      'Buscar proveedores de «porcelanato 60x60» en la web'
    );
    expect(
      tool('sendRfq').summarize!({ rfqId: 'r', supplierIds: ['a', 'b'], rfqNumber: 'RFQ-000003', recipients: ['Acme', 'Beta'], channel: 'whatsapp' })
    ).toBe('Enviar la cotización RFQ-000003 por WhatsApp a 2 destinatario(s): Acme, Beta');
    expect(
      tool('submitProcurementOrder').summarize!({ orderId: 'o', orderNumber: 'OC-000009', supplierName: 'Acme', total: '$69,600.00', signatures: 2 })
    ).toBe('Enviar a aprobación la orden OC-000009 de Acme por $69,600.00 (requiere 2 firmas distintas)');
    expect(tool('recordGoodsReceipt').summarize!({ orderId: 'o', lines: [], orderNumber: 'OC-000001', lineSummary: '3 pz Silicón (1 rechazado)' })).toBe(
      'Registrar recepción de OC-000001: 3 pz Silicón (1 rechazado)'
    );
    expect(tool('draftRfq').summarize!({ title: 'Obra Norte', requestLineIds: ['a'], lines: [{ description: 'x', qty: 1, unit: 'pz' }] })).toBe(
      'Borrador de cotización «Obra Norte» con 2 línea(s)'
    );
  });
});

describe('preparación de argumentos', () => {
  it('sendRfq valida destinatarios y completa folio y nombres', async () => {
    const send = tool('sendRfq');
    expect(await send.prepareArgs!(people.buyer, send.parameters.parse({ rfqId: 'rfq_x' }))).toEqual({ error: 'Indica al menos un proveedor o candidato' });
    expect(await send.prepareArgs!(people.buyer, send.parameters.parse({ rfqId: 'rfq_x', supplierIds: ['s'] }))).toEqual({ error: 'No se encontró la cotización' });
    const supplier = seedSupplier(fake, { name: 'Acme' });
    fake.seed('rfq', { id: 'rfq_1', number: 'RFQ-000003', title: 'x', status: 'draft', createdByUserId: 'u_buyer' });
    expect(await send.prepareArgs!(people.buyer, send.parameters.parse({ rfqId: 'rfq_1', supplierIds: [supplier.id] }))).toEqual({
      args: expect.objectContaining({ rfqNumber: 'RFQ-000003', recipients: ['Acme'] }),
    });
    const refused = await send.prepareArgs!(botOf('ventas'), send.parameters.parse({ rfqId: 'rfq_1', supplierIds: [supplier.id] }));
    expect(refused).toEqual({ error: expect.stringContaining('sólo puede actuar en Ventas') });
  });

  it('submitProcurementOrder calcula las firmas con el umbral de doble aprobación', async () => {
    const submit = tool('submitProcurementOrder');
    const supplier = seedSupplier(fake, { name: 'Acme' });
    fake.seed('procurementOrder', { id: 'po_big', number: 'OC-000009', supplierId: supplier.id, status: 'draft', total: '69600', currency: 'MXN', paymentMode: 'prepaid', createdByUserId: 'u_buyer' });
    fake.seed('procurementOrder', { id: 'po_small', number: 'OC-000010', supplierId: supplier.id, status: 'draft', total: '100', currency: 'MXN', paymentMode: 'prepaid', createdByUserId: 'u_buyer' });
    fake.seed('procurementOrder', { id: 'po_sent', number: 'OC-000011', supplierId: supplier.id, status: 'approved', total: '100', currency: 'MXN', paymentMode: 'prepaid', createdByUserId: 'u_buyer' });
    expect(await submit.prepareArgs!(people.buyer, { orderId: 'po_big' })).toEqual({
      args: expect.objectContaining({ orderNumber: 'OC-000009', supplierName: 'Acme', signatures: 2, total: '$69,600.00' }),
    });
    expect(await submit.prepareArgs!(people.buyer, { orderId: 'po_small' })).toEqual({ args: expect.objectContaining({ signatures: 1 }) });
    expect(await submit.prepareArgs!(people.buyer, { orderId: 'po_sent' })).toEqual({ error: 'Sólo se envía a aprobación una orden en borrador' });
  });
});

describe('ejecución', () => {
  it('listPurchaseRequests lee con el permiso del usuario', async () => {
    await purchases.createPurchaseRequest(people.buyer, { lines: [{ description: 'Silicón transparente', qty: 12, unit: 'pz' }] }, { now: NOW });
    const list = tool('listPurchaseRequests');
    const result = (await list.execute(people.buyer, list.parameters.parse({ status: 'open' }), {})) as {
      total: number;
      requests: Array<{ number: string; lines: Array<{ qty: string }> }>;
    };
    expect(result.total).toBe(1);
    expect(result.requests[0]).toMatchObject({ number: 'SC-000001', lines: [{ qty: '12 pz' }] });
    await expect(list.execute(people.outsider, list.parameters.parse({}), {})).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('draftRfq y runSourcingSearch corren como comandos; una IA de otra área no actúa por Compras', async () => {
    const draft = tool('draftRfq');
    const created = (await draft.execute(
      people.buyer,
      draft.parameters.parse({ title: 'Obra Norte', lines: [{ description: 'Porcelanato', qty: 100, unit: 'm2' }] }),
      {}
    )) as { number: string; status: string };
    expect(created).toMatchObject({ number: 'RFQ-000001', status: 'draft' });
    await expect(draft.execute(botOf('ventas'), draft.parameters.parse({ title: 'Otra', lines: [{ description: 'Pegazulejo', qty: 1, unit: 'pz' }] }), {})).rejects.toBeInstanceOf(
      OperationsToolError
    );

    const search = tool('runSourcingSearch');
    const queued = (await search.execute(people.buyer, search.parameters.parse({ query: 'adhesivo para porcelanato' }), {})) as { status: string; message: string };
    expect(queued).toMatchObject({ status: 'pending', message: 'Búsqueda en curso; consulta los candidatos en unos segundos' });
    expect(fake.rows('backgroundJob').filter((job) => job.type === 'purchases.sourcing_search')).toHaveLength(1);
  });
});
