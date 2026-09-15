import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * "Mi trabajo" tools: the natural-language count parser (clear and ambiguous
 * cases), recordCount before the card and after approval, startWorkItem and the
 * ranking of next actions. Core services mocked.
 */

const h = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() });
  return {
    prisma: {
      workItem: model(),
      areaRequest: model(),
      operationalCase: model(),
      product: model(),
      productInventoryProfile: model(),
      warehouse: model(),
      stockCount: model(),
      stockItem: model(),
      storageLocation: model(),
      caseStep: model(),
      caseDemand: model(),
    } as Record<string, ReturnType<typeof model>>,
    createProposal: vi.fn(),
    listMyWorkItems: vi.fn(),
    listPendingApprovals: vi.fn(),
    startWorkItem: vi.fn(),
    startStockCount: vi.fn(),
    recordStockCountLine: vi.fn(),
    blockStockQuantity: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: h.prisma }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/extensions/proposals-service', () => ({ createProposal: h.createProposal }));
vi.mock('@/modules/operations/commands', () => ({ executeCommand: vi.fn(), registerCommand: vi.fn(), versionedAggregate: vi.fn(() => ({})) }));
vi.mock('@/modules/operations/register-commands', () => ({}));
vi.mock('@/modules/operations/work-items-service', () => ({
  listMyWorkItems: h.listMyWorkItems,
  startWorkItem: h.startWorkItem,
  canTransitionWorkItem: (_action: string, status: string) => ['open', 'waiting', 'escalated'].includes(status),
}));
vi.mock('@/modules/operations/approvals-service', () => ({ listPendingApprovals: h.listPendingApprovals }));
vi.mock('@/modules/inventory/profiles-service', () => ({
  DEFAULT_BASE_UNIT: 'pz',
  toUnitProfile: (profile: { baseUnit: string; conversions: Array<{ unit: string; factor: number }> }) => ({
    baseUnit: profile.baseUnit,
    conversions: profile.conversions,
  }),
}));
vi.mock('@/modules/inventory/warehouses-service', () => ({ normalizeLocationCode: (code: string) => code.trim().toUpperCase() }));
vi.mock('@/modules/inventory/inventory-commands', () => ({
  startStockCount: h.startStockCount,
  recordStockCountLine: h.recordStockCountLine,
  blockStockQuantity: h.blockStockQuantity,
}));

import { executeTool, getToolDefinition, type ToolExecutionContext } from './registry';
import { parseCountText, rankNextActions } from './mywork-tools';

const HOUR = 3_600_000;

function person(permissions: string[] = ['assistant.use', 'inventory.count'], overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u-ana',
    username: 'ana',
    name: 'Ana',
    email: null,
    mustChangePassword: false,
    roleKeys: ['staff'],
    permissionKeys: permissions as never,
    isSuperAdmin: false,
    ...overrides,
  };
}

const inventoryBot = person(['chat.use', 'operations.view', 'inventory.view', 'inventory.count', 'inventory.reserve'], {
  id: 'bot-inventario',
  username: 'ia_inventario',
  roleKeys: ['agent_inventario'],
});

const PRODUCT = { zohoItemId: 'z1', sku: 'LP-01', name: 'Loseta Perla', unit: 'm2' };

function resetPrisma() {
  for (const model of Object.values(h.prisma)) {
    model.findUnique.mockReset().mockResolvedValue(null);
    model.findFirst.mockReset().mockResolvedValue(null);
    model.findMany.mockReset().mockResolvedValue([]);
    model.count.mockReset().mockResolvedValue(0);
  }
  h.prisma.product.findMany.mockResolvedValue([PRODUCT]);
  h.prisma.product.findUnique.mockResolvedValue(PRODUCT);
  h.prisma.productInventoryProfile.findUnique.mockResolvedValue({ baseUnit: 'm2', conversions: [{ unit: 'caja', factor: 1.44 }], variantAxes: [] });
  h.prisma.warehouse.findMany.mockResolvedValue([{ id: 'wh1', key: 'central', name: 'Bodega Central' }]);
  h.prisma.storageLocation.findUnique.mockResolvedValue({ active: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPrisma();
  h.createProposal.mockImplementation(async (input: { tool: { effect?: string }; summary: string }) => ({
    id: 'prop-1',
    summary: input.summary,
    effect: input.tool.effect ?? 'read',
    expiresAt: new Date(Date.now() + HOUR),
  }));
});

await import('./mywork-tools');

const approved = (id: string): ToolExecutionContext => ({ approvedProposalId: id, skipApproval: true });

describe('parseCountText (pure)', () => {
  it('reads the counted quantity, unit and damaged pieces', () => {
    expect(parseCountText('conté 10 m², 2 dañadas')).toEqual({
      countedQty: 10,
      unit: 'm2',
      damagedQty: 2,
      locationCode: null,
      skuHint: null,
      issues: [],
    });
  });

  it('finds SKU and location without taking the digits of the codes as quantities', () => {
    expect(parseCountText('Conté 24 piezas de LP-01 en R-03')).toMatchObject({
      countedQty: 24,
      unit: 'pz',
      damagedQty: null,
      skuHint: 'LP-01',
      locationCode: 'R-03',
      issues: [],
    });
    expect(parseCountText('sku PL-9 conté 5')).toMatchObject({ skuHint: 'PL-9', countedQty: 5 });
    expect(parseCountText('rack B2: hay 7 cajas')).toMatchObject({ locationCode: 'B2', countedQty: 7 });
  });

  it('ignores measures, accepts decimal commas and damaged written first', () => {
    expect(parseCountText('conté 12,5 metros cuadrados de loseta 60x60')).toMatchObject({ countedQty: 12.5, unit: 'm2', issues: [] });
    expect(parseCountText('dañadas: 3, total 40 m2')).toMatchObject({ countedQty: 40, damagedQty: 3, unit: 'm2' });
  });

  it('reports ambiguity instead of guessing', () => {
    const several = parseCountText('hay 10 o 12 cajas');
    expect(several.countedQty).toBeNull();
    expect(several.issues[0]).toMatch(/varias cantidades \(10, 12\)/);
    expect(parseCountText('2 dañadas')).toMatchObject({ countedQty: null, damagedQty: 2 });
    expect(parseCountText('conté 10 m2 y 3 kg').issues.join(' ')).toMatch(/varias cantidades|varias unidades/);
  });
});

describe('recordCount before the card', () => {
  it('turns a clear sentence into the structured count of the card', async () => {
    h.prisma.stockCount.findFirst.mockResolvedValue({ id: 'cnt-1' });
    const result = await executeTool('recordCount', person(), { text: 'conté 10 m², 2 dañadas en R-03', sku: 'LP-01' });
    expect(result).toMatchObject({ success: false, needsApproval: true });
    const { args, summary } = h.createProposal.mock.calls[0][0];
    expect(args).toEqual({
      text: 'conté 10 m², 2 dañadas en R-03',
      zohoItemId: 'z1',
      sku: 'LP-01',
      productName: 'Loseta Perla',
      warehouseId: 'wh1',
      warehouseName: 'Bodega Central',
      locationCode: 'R-03',
      countedQty: 10,
      damagedQty: 2,
      unit: 'm2',
      baseUnit: 'm2',
      countId: 'cnt-1',
    });
    expect(summary).toBe('Registrar conteo: 10 m2 de Loseta Perla (LP-01) en Bodega Central · ubicación R-03 · 2 m2 dañadas');
    expect(h.prisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sku: { equals: 'LP-01', mode: 'insensitive' } } }));
  });

  it('takes the product from the only pending verification of the person', async () => {
    h.prisma.workItem.findMany.mockResolvedValue([{ objectType: 'case_demand', objectId: 'd1', stepId: null }]);
    h.prisma.caseDemand.findMany.mockResolvedValue([{ zohoItemId: 'z1', sku: 'LP-01', name: 'Loseta Perla' }]);
    const result = await executeTool('recordCount', person(), { text: 'conté 8' });
    expect(result.needsApproval).toBe(true);
    expect(h.createProposal.mock.calls[0][0].args).toMatchObject({ zohoItemId: 'z1', countedQty: 8, unit: 'm2', damagedQty: 0 });
  });

  it('rejects ambiguous or impossible counts before the card', async () => {
    const cases: Array<[Record<string, unknown>, RegExp, () => void]> = [
      [{ text: 'hay 10 o 12', sku: 'LP-01' }, /varias cantidades/, () => undefined],
      [{ text: '2 dañadas', sku: 'LP-01' }, /Cuántas contaste/, () => undefined],
      [{ text: 'conté 3, 5 dañadas', sku: 'LP-01' }, /no pueden ser más que lo contado/, () => undefined],
      [{ text: 'conté 3 rollos', sku: 'LP-01' }, /no tiene conversión/, () => undefined],
      [
        { text: 'conté 4', product: 'loseta' },
        /Varios artículos coinciden/,
        () => h.prisma.product.findMany.mockResolvedValue([PRODUCT, { zohoItemId: 'z2', sku: 'LG-02', name: 'Loseta Gris', unit: 'm2' }]),
      ],
      [{ text: 'conté 4' }, /De qué artículo/, () => undefined],
      [
        { text: 'conté 4', sku: 'LP-01' },
        /En qué bodega/,
        () =>
          h.prisma.warehouse.findMany.mockResolvedValue([
            { id: 'wh1', key: 'central', name: 'Bodega Central' },
            { id: 'wh2', key: 'norte', name: 'Bodega Norte' },
          ]),
      ],
      [{ text: 'conté 4 en Z-99', sku: 'LP-01' }, /No existe la ubicación Z-99/, () => h.prisma.storageLocation.findUnique.mockResolvedValue(null)],
    ];
    for (const [args, message, arrange] of cases) {
      resetPrisma();
      arrange();
      const result = await executeTool('recordCount', person(), args);
      expect(result.success, JSON.stringify(args)).toBe(false);
      expect(result.error, JSON.stringify(args)).toMatch(message);
    }
    expect(h.createProposal).not.toHaveBeenCalled();
  });

  it('is a business write of inventory.count: the Inventario coordinator proposes, others cannot', async () => {
    expect(getToolDefinition('recordCount')).toMatchObject({ effect: 'business_write', requiredPermission: 'inventory.count', category: 'operations' });
    const botResult = await executeTool('recordCount', inventoryBot, { text: 'conté 10 m2', sku: 'LP-01' }, { agentAreaKey: 'inventario' });
    expect(botResult.needsApproval).toBe(true);
    const noPermission = await executeTool('recordCount', person(['assistant.use']), { text: 'conté 10 m2', sku: 'LP-01' });
    expect(noPermission.errorCode).toBe('forbidden');
  });
});

describe('recordCount after approval', () => {
  const prepared = {
    zohoItemId: 'z1',
    sku: 'LP-01',
    productName: 'Loseta Perla',
    warehouseId: 'wh1',
    warehouseName: 'Bodega Central',
    locationCode: 'R-03',
    countedQty: 10,
    damagedQty: 2,
    unit: 'm2',
    baseUnit: 'm2',
    countId: 'cnt-1',
  };
  const line = { status: 'completed', data: { stockItemId: 'si-1', expected: '8', counted: '10', diff: '2', withinTolerance: false, baseUnit: 'm2', confidence: 'PROVISIONAL', recount: false } };

  it('captures the line in the open count and blocks the damaged pieces with the adjust permission', async () => {
    h.prisma.stockCount.findUnique.mockResolvedValue({ status: 'in_progress', warehouseId: 'wh1' });
    h.recordStockCountLine.mockResolvedValueOnce(line);
    h.blockStockQuantity.mockResolvedValueOnce({ status: 'completed', data: { blocked: '2' } });
    const result = await executeTool('recordCount', person(['inventory.count', 'inventory.adjust']), prepared, approved('prop-2'));
    expect(h.startStockCount).not.toHaveBeenCalled();
    expect(h.recordStockCountLine).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-ana' }),
      { countId: 'cnt-1', zohoItemId: 'z1', locationCode: 'R-03', variantKey: null, countedQty: '10', unit: 'm2' },
      { commandId: 'proposal:prop-2:recordCount:line' }
    );
    expect(h.blockStockQuantity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stockItemId: 'si-1', quantity: '2', unit: 'm2' }), { commandId: 'proposal:prop-2:recordCount:block' });
    expect(result.result).toMatchObject({ countId: 'cnt-1', countStarted: false, diff: '2', damaged: { quantity: 2, blocked: true } });
  });

  it('opens a count when none is open and leaves the damaged pieces to Inventario without the adjust permission', async () => {
    h.startStockCount.mockResolvedValueOnce({ status: 'completed', data: { count: { id: 'cnt-9' } } });
    h.recordStockCountLine.mockResolvedValueOnce(line);
    const result = await executeTool('recordCount', person(['inventory.count']), { ...prepared, countId: undefined }, approved('prop-3'));
    expect(h.startStockCount).toHaveBeenCalledWith(expect.anything(), { warehouseId: 'wh1', scope: 'spot' }, { commandId: 'proposal:prop-3:recordCount:start' });
    expect(h.recordStockCountLine.mock.calls[0][1]).toMatchObject({ countId: 'cnt-9' });
    expect(h.blockStockQuantity).not.toHaveBeenCalled();
    expect(result.result).toMatchObject({ countStarted: true, damaged: { blocked: false } });
  });

  it('keeps the count when blocking the damaged pieces fails', async () => {
    h.prisma.stockCount.findUnique.mockResolvedValue({ status: 'in_progress', warehouseId: 'wh1' });
    h.recordStockCountLine.mockResolvedValueOnce(line);
    h.blockStockQuantity.mockResolvedValueOnce({ status: 'rejected', errorCode: 'negative_stock', message: 'No hay existencia suficiente para bloquear' });
    const result = await executeTool('recordCount', person(['inventory.count', 'inventory.adjust']), prepared, approved('prop-4'));
    expect(result.success).toBe(true);
    expect((result.result as { damaged: { blocked: boolean; note: string } }).damaged).toMatchObject({ blocked: false, note: expect.stringContaining('No hay existencia suficiente') });
  });
});

describe('startWorkItem', () => {
  it('only the owner or backup starts the work item, as an internal task', async () => {
    h.prisma.workItem.findUnique.mockResolvedValue({ id: 'w1', title: 'Contar LP-01', status: 'open', ownerUserId: 'u-luis', backupUserId: null });
    const notMine = await executeTool('startWorkItem', person(), { workItemId: 'w1' });
    expect(notMine.error).toMatch(/dueño del trabajo o su suplente/);

    h.prisma.workItem.findUnique.mockResolvedValue({ id: 'w1', title: 'Contar LP-01', status: 'open', ownerUserId: 'u-luis', backupUserId: 'u-ana' });
    h.startWorkItem.mockResolvedValueOnce({ status: 'completed', data: { workItemId: 'w1', status: 'in_progress', dueAt: new Date(Date.now() + HOUR).toISOString() } });
    const started = await executeTool('startWorkItem', person(), { workItemId: 'w1' });
    expect(h.createProposal).not.toHaveBeenCalled();
    expect(h.startWorkItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-ana' }), 'w1', { commandId: expect.any(String) });
    expect(started.result).toMatchObject({ status: 'in_progress', title: 'Contar LP-01' });

    h.prisma.workItem.findUnique.mockResolvedValue({ id: 'w1', title: 'Contar LP-01', status: 'in_progress', ownerUserId: 'u-ana', backupUserId: null });
    const already = await executeTool('startWorkItem', person(), { workItemId: 'w1' });
    expect(already.error).toBe('El trabajo ya está en curso');

    const botTry = await executeTool('startWorkItem', inventoryBot, { workItemId: 'w1' });
    expect(botTry.errorCode).toBe('forbidden');
  });
});

describe('myNextActions', () => {
  const now = new Date('2026-09-15T16:00:00.000Z');

  it('ranks overdue work first, then blocking requests and approvals, without duplicating linked items', () => {
    const actions = rankNextActions(
      {
        now,
        workItems: [
          { id: 'w-late', title: 'Contar LP-01', status: 'open', kind: 'verification', dueAt: '2026-09-15T12:00:00.000Z', overdue: true, caseNumber: 'EXP-7', escalationLevel: 1, objectType: 'case_demand', objectId: 'd1' },
          { id: 'w-req', title: 'Solicitud de Ventas', status: 'open', kind: 'action', dueAt: '2026-09-15T17:00:00.000Z', overdue: false, caseNumber: 'EXP-7', escalationLevel: 0, objectType: 'area_request', objectId: 'r1' },
          { id: 'w-later', title: 'Preparar pedido', status: 'in_progress', kind: 'action', dueAt: '2026-09-16T16:00:00.000Z', overdue: false, caseNumber: 'EXP-8', escalationLevel: 0, objectType: null, objectId: null },
        ],
        requests: [
          { id: 'r1', title: 'Verificar disponibilidad', dueAt: new Date('2026-09-15T20:00:00.000Z'), status: 'acknowledged', fromAreaKey: 'ventas', blocksDelivery: true, priority: 'high', caseId: 'case-1', workItemId: 'w-req' },
        ],
        approvals: [
          { id: 'ap1', scope: 'payment', amount: '80000', currency: 'MXN', requiredApprovals: 2, approvals: 1, expiresAt: '2026-09-16T00:00:00.000Z', createdAt: '2026-09-15T10:00:00.000Z', caseId: null },
        ],
        caseNumbers: new Map([['case-1', 'EXP-7']]),
      },
      10
    );
    expect(actions.map((a) => a.id)).toEqual(['w-late', 'r1', 'ap1', 'w-later']);
    expect(actions[0]).toMatchObject({ kind: 'work_item', overdue: true, suggestedTool: 'recordCount' });
    expect(actions[1]).toMatchObject({ kind: 'request', suggestedTool: 'respondAreaRequest', caseNumber: 'EXP-7' });
    expect(actions[1].reason).toContain('bloquea la entrega');
    expect(actions[2]).toMatchObject({ kind: 'approval', suggestedTool: 'authorizePayment' });
    expect(actions[3]).toMatchObject({ suggestedTool: 'completeWorkItem' });
  });

  it('reads the work, requests and approvals of the person', async () => {
    h.listMyWorkItems.mockResolvedValueOnce({
      items: [{ id: 'w1', title: 'Contar', status: 'open', kind: 'verification', dueAt: new Date(Date.now() - HOUR).toISOString(), overdue: true, caseNumber: null, escalationLevel: 0, objectType: null, objectId: null }],
      nextCursor: null,
    });
    h.listPendingApprovals.mockResolvedValueOnce([]);
    const result = await executeTool('myNextActions', person(['assistant.use']), {});
    expect(h.listMyWorkItems).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-ana' }), { scope: 'open', limit: 100 }, { now: expect.any(Date) });
    expect(h.prisma.areaRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ OR: [{ ownerUserId: 'u-ana' }, { backupUserId: 'u-ana' }] }) }));
    expect(result.result).toMatchObject({ counts: { workItems: 1, overdueWorkItems: 1, requests: 0, approvals: 0 }, actions: [{ id: 'w1' }] });
  });
});
