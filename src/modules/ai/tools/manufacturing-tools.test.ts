import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Manufacturing tools through the common executor with the manufacturing
 * services mocked: readings and bot scope, the draft order, and the output /
 * scrap writes before the approval card and after it.
 */

const h = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() });
  return {
    prisma: {
      productionOrder: model(),
      product: model(),
      operationalCase: model(),
      caseDemand: model(),
      demandAllocation: model(),
      workCenter: model(),
    } as Record<string, ReturnType<typeof model>>,
    createProposal: vi.fn(),
    listProductionOrders: vi.fn(),
    getProductionBoard: vi.fn(),
    createTransformationOrder: vi.fn(),
    recordOutput: vi.fn(),
    involvedAreasOfCase: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: h.prisma }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/extensions/proposals-service', () => ({ createProposal: h.createProposal }));
vi.mock('@/modules/extensions/extension-audit', () => ({ recordExtensionExecution: vi.fn(async () => undefined) }));
vi.mock('@/modules/operations/commands', () => ({
  executeCommand: vi.fn(),
  registerCommand: vi.fn(),
  versionedAggregate: vi.fn(() => ({})),
}));
vi.mock('@/modules/operations/register-commands', () => ({}));
vi.mock('@/modules/agents/chat-bridge', () => ({ involvedAreasOfCase: h.involvedAreasOfCase }));
vi.mock('@/modules/manufacturing/manufacturing-queries', () => ({
  listProductionOrders: h.listProductionOrders,
  getProductionBoard: h.getProductionBoard,
}));
vi.mock('@/modules/manufacturing/manufacturing-commands', () => ({
  createTransformationOrder: h.createTransformationOrder,
  recordOutput: h.recordOutput,
}));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const { withManufacturingPermissions } = await import('@/modules/manufacturing/testing/permissions-mock');
  return withManufacturingPermissions(await importOriginal<typeof import('@/modules/auth/permissions')>());
});

import { executeTool, getToolDefinition, type ToolExecutionContext } from './registry';

function person(permissions: string[], overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 'u-luis',
    username: 'luis',
    name: 'Luis',
    email: null,
    mustChangePassword: false,
    roleKeys: ['staff'],
    permissionKeys: permissions as never,
    isSuperAdmin: false,
    ...overrides,
  };
}

const operator = person(['assistant.use', 'manufacturing.view', 'manufacturing.operate']);
const planner = person(['assistant.use', 'manufacturing.view', 'manufacturing.manage_orders'], { id: 'u-ana' });
const comprasBot = person(['chat.use', 'operations.view', 'manufacturing.view'], {
  id: 'bot-compras',
  username: 'ia_compras',
  roleKeys: ['agent_compras'],
  isBot: true,
});
const manufacturaBot = person(['chat.use', 'operations.view', 'manufacturing.view', 'manufacturing.operate'], {
  id: 'bot-manufactura',
  username: 'ia_manufactura',
  roleKeys: ['agent_manufactura'],
  isBot: true,
});

const ORDER = {
  id: 'po1',
  number: 'OP-000001',
  status: 'completed',
  plannedUnit: 'm2',
  outputName: 'Placa 60x60',
  outputZohoItemId: 'placa',
  caseId: null,
};

const approved = (id: string): ToolExecutionContext => ({ approvedProposalId: id, skipApproval: true });

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(h.prisma)) {
    model.findUnique.mockReset().mockResolvedValue(null);
    model.findFirst.mockReset().mockResolvedValue(null);
    model.findMany.mockReset().mockResolvedValue([]);
    model.count.mockReset().mockResolvedValue(0);
  }
  h.prisma.productionOrder.findUnique.mockResolvedValue(ORDER);
  h.createProposal.mockImplementation(async (input: { tool: { effect?: string }; summary: string }) => ({
    id: 'prop-1',
    summary: input.summary,
    effect: input.tool.effect ?? 'read',
    expiresAt: new Date(Date.now() + 3_600_000),
  }));
});

await import('./manufacturing-tools');

describe('registration', () => {
  it('registers the five tools with their effects', () => {
    expect(
      ['listProductionOrders', 'getProductionBoard', 'createTransformationOrderDraft', 'recordProductionOutput', 'reportScrap'].map((name) => [
        name,
        getToolDefinition(name)?.effect,
        getToolDefinition(name)?.category,
      ])
    ).toEqual([
      ['listProductionOrders', 'read', 'operations'],
      ['getProductionBoard', 'read', 'operations'],
      ['createTransformationOrderDraft', 'draft', 'operations'],
      ['recordProductionOutput', 'business_write', 'operations'],
      ['reportScrap', 'business_write', 'operations'],
    ]);
  });
});

describe('readings', () => {
  it('lists orders with the filters and a compact shape', async () => {
    h.prisma.workCenter.findUnique.mockResolvedValue({ id: 'wc1' });
    h.listProductionOrders.mockResolvedValue({
      total: 1,
      page: 1,
      pageSize: 15,
      pageCount: 1,
      rows: [
        {
          id: 'po1',
          number: 'OP-000001',
          statusLabel: 'Bloqueada',
          outputName: 'Placa 60x60',
          outputSku: 'PLACA',
          outputZohoItemId: 'placa',
          plannedQty: '100',
          plannedUnit: 'm2',
          producedQty: '0',
          scrapQty: '0',
          priority: 'normal',
          workCenterName: 'Corte',
          caseNumber: 'EXP-000001',
          plannedStartAt: null,
          blockedReason: 'Faltan materiales',
          allowedActions: ['reserve_materials'],
        },
      ],
    });
    const result = await executeTool('listProductionOrders', operator, { workCenter: 'Corte', status: ['blocked'] });
    expect(result).toMatchObject({
      success: true,
      result: { total: 1, orders: [{ number: 'OP-000001', status: 'Bloqueada', planned: '100 m2', workCenter: 'Corte' }] },
    });
    expect(h.prisma.workCenter.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'corte' } }));
    expect(h.listProductionOrders).toHaveBeenCalledWith(operator, {
      scope: 'open',
      status: ['blocked'],
      workCenterId: 'wc1',
      sort: 'planned',
      pageSize: 15,
    });
  });

  it('keeps bots of other areas out of the floor', async () => {
    const result = await executeTool('listProductionOrders', comprasBot, {});
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/sólo consulta el trabajo de Compras/) });
    expect(h.listProductionOrders).not.toHaveBeenCalled();
  });

  it('summarizes the board by status and work center', async () => {
    h.getProductionBoard.mockResolvedValue({
      generatedAt: '2026-09-15T15:00:00.000Z',
      columns: [
        { status: 'blocked', label: 'Bloqueada', count: 1, orders: [{ number: 'OP-000002', outputName: 'Espejo', outputZohoItemId: 'espejo', plannedQty: '10', plannedUnit: 'm2', priority: 'urgent', blockedReason: 'Faltan materiales' }] },
        { status: 'draft', label: 'Borrador', count: 0, orders: [] },
      ],
      workCenters: [
        {
          workCenter: { name: 'Corte', capacityPerShift: '100', capacityUnitLabel: 'm²' },
          running: [{ number: 'OP-000001', name: 'Corte/acabado' }],
          queued: 3,
          summary: { overloadedWindows: 1, peakUtilizationPct: 140 },
          windows: [{ shiftName: 'Matutino', day: '2026-09-15', load: 140, capacity: 100, utilizationPct: 140, overloaded: true }],
        },
      ],
    });
    const result = await executeTool('getProductionBoard', manufacturaBot, { days: 1 });
    expect(result).toMatchObject({
      success: true,
      result: {
        columns: [{ status: 'Bloqueada', count: 1, top: ['OP-000002 · Espejo · 10 m2 · urgent · Faltan materiales'] }],
        workCenters: [{ name: 'Corte', capacity: '100 m² por turno', running: ['OP-000001 · Corte/acabado'], queued: 3, overloadedShifts: 1 }],
      },
    });
    expect(h.getProductionBoard).toHaveBeenCalledWith(manufacturaBot, { days: 1, perColumn: 5 });
  });
});

describe('createTransformationOrderDraft', () => {
  beforeEach(() => {
    h.prisma.product.findFirst.mockImplementation(async (args: { where: { sku: { equals: string } } }) => {
      const sku = args.where.sku.equals.toUpperCase();
      if (sku === 'LAMINA') return { zohoItemId: 'lamina', name: 'Lámina', sku: 'LAMINA', unit: 'm2' };
      if (sku === 'PLACA') return { zohoItemId: 'placa', name: 'Placa', sku: 'PLACA', unit: 'm2' };
      return null;
    });
  });

  it('creates the draft without committing material', async () => {
    h.createTransformationOrder.mockResolvedValue({
      status: 'completed',
      data: { productionOrderId: 'po2', number: 'OP-000002', status: 'draft', workCenterId: 'wc1', schedule: { plannedStartAt: '2026-09-15T15:00:00.000Z', overloaded: false } },
    });
    const result = await executeTool('createTransformationOrderDraft', planner, {
      inputSku: 'lamina',
      inputQty: 105,
      outputSku: 'placa',
      plannedQty: 100,
      plannedUnit: 'm2',
    });
    expect(result).toMatchObject({ success: true, result: { number: 'OP-000002', status: 'draft', overloaded: false } });
    expect(h.createProposal).not.toHaveBeenCalled();
    expect(h.createTransformationOrder).toHaveBeenCalledWith(
      planner,
      { outputZohoItemId: 'placa', plannedQty: 100, plannedUnit: 'm2', inputs: [{ zohoItemId: 'lamina', qty: 105 }], reserveNow: false },
      { commandId: expect.stringMatching(/^ai:createTransformationOrderDraft:/) }
    );
  });

  it('reuses the order a demand already has and reports unknown items', async () => {
    h.prisma.caseDemand.findUnique.mockResolvedValue({ id: 'd1', caseId: 'case_1', zohoItemId: 'placa' });
    h.prisma.demandAllocation.findFirst.mockResolvedValue({ id: 'a1' });
    h.prisma.productionOrder.findFirst.mockResolvedValue({ id: 'po9', number: 'OP-000009', status: 'reserved' });
    expect(await executeTool('createTransformationOrderDraft', planner, { inputSku: 'LAMINA', inputQty: 5, demandId: 'd1' })).toMatchObject({
      success: true,
      result: { existing: true, number: 'OP-000009' },
    });
    h.prisma.caseDemand.findUnique.mockResolvedValue(null);
    expect(await executeTool('createTransformationOrderDraft', planner, { inputSku: 'NADA', inputQty: 5, outputSku: 'placa' })).toMatchObject({
      success: false,
      error: expect.stringMatching(/No se encontró el artículo NADA/),
    });
    expect(h.createTransformationOrder).not.toHaveBeenCalled();
  });

  it('needs the permission to manage orders', async () => {
    const result = await executeTool('createTransformationOrderDraft', operator, { inputSku: 'LAMINA', inputQty: 5, outputSku: 'PLACA' });
    expect(result.success).toBe(false);
    expect(h.createTransformationOrder).not.toHaveBeenCalled();
  });
});

describe('recordProductionOutput and reportScrap', () => {
  it('turns finished goods into an approval card with the order data completed', async () => {
    const result = await executeTool('recordProductionOutput', operator, { productionOrder: 'op-1', qty: 100 });
    expect(result).toMatchObject({ success: false, needsApproval: true });
    expect(h.prisma.productionOrder.findUnique).toHaveBeenCalledWith({ where: { number: 'OP-000001' } });
    expect(h.createProposal.mock.calls[0][0].summary).toBe('Registrar 100 m2 de producto terminado (Placa 60x60) en OP-000001');
    expect(h.recordOutput).not.toHaveBeenCalled();
  });

  it('records the output once approved', async () => {
    h.recordOutput.mockResolvedValue({
      status: 'completed',
      data: { outputId: 'out1', kind: 'finished', quantity: '100', unit: 'm2', movementId: 'mv1', containerKey: '', producedQty: '100' },
    });
    const result = await executeTool(
      'recordProductionOutput',
      operator,
      { productionOrder: 'po1', kind: 'finished', qty: 100, unit: 'm2', orderNumber: 'OP-000001' },
      approved('prop-1')
    );
    expect(result).toMatchObject({ success: true, result: { orderNumber: 'OP-000001', outputId: 'out1', quantity: '100 m2', producedQty: '100' } });
    expect(h.recordOutput).toHaveBeenCalledWith(
      operator,
      { productionOrderId: 'po1', kind: 'finished', qty: 100, unit: 'm2' },
      { commandId: 'proposal:prop-1:recordProductionOutput' }
    );
  });

  it('rejects before the card what the order cannot accept', async () => {
    h.prisma.productionOrder.findUnique.mockResolvedValue({ ...ORDER, status: 'inspection' });
    expect(await executeTool('recordProductionOutput', operator, { productionOrder: 'po1', qty: 10 })).toMatchObject({
      success: false,
      error: expect.stringMatching(/después de una inspección aprobada/),
    });
    expect(await executeTool('recordProductionOutput', operator, { productionOrder: 'po1', kind: 'leftover', qty: 2 })).toMatchObject({
      success: false,
      error: expect.stringMatching(/medidas del sobrante/),
    });
    expect(await executeTool('reportScrap', comprasBot, { productionOrder: 'po1', qty: 2, reason: 'Roto' })).toMatchObject({ success: false });
    expect(h.createProposal).not.toHaveBeenCalled();
  });

  it('reports scrap and explains the tolerance outcome', async () => {
    h.prisma.productionOrder.findUnique.mockResolvedValue({ ...ORDER, status: 'in_progress' });
    const card = await executeTool('reportScrap', operator, { productionOrder: 'OP-1', qty: 10, unit: 'm2', reason: 'Lámina astillada' });
    expect(card).toMatchObject({ success: false, needsApproval: true });
    expect(h.createProposal.mock.calls[0][0].summary).toBe('Reportar merma de 10 m2 en OP-000001: Lámina astillada');
    h.recordOutput.mockResolvedValue({
      status: 'completed',
      data: { outputId: 'out2', quantity: '10', unit: 'm2', scrap: { exceeded: true, pending: false, maxPct: 9.52, approvalRequestId: 'ap1', approvalStatus: 'pending' } },
    });
    const done = await executeTool('reportScrap', operator, { productionOrder: 'po1', qty: 10, unit: 'm2', reason: 'Lámina astillada', orderNumber: 'OP-000001' }, approved('prop-2'));
    expect(done).toMatchObject({ success: true, result: { scrap: { exceeded: true }, note: expect.stringMatching(/supera la tolerancia/) } });
    expect(h.recordOutput).toHaveBeenCalledWith(
      operator,
      { productionOrderId: 'po1', kind: 'scrap', qty: 10, unit: 'm2', reason: 'Lámina astillada' },
      { commandId: 'proposal:prop-2:reportScrap' }
    );
  });
});
