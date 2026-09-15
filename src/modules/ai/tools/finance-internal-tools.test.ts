import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Internal accounting tools: registration (effects and permissions), the
 * draft capture, approval cards of submitExpense / matchPaymentToObligation
 * (prepared arguments, summaries, execution after approval, bots never
 * execute), AI identity scope and the readings. Finance services mocked.
 */

const h = vi.hoisted(() => {
  const models = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const model = (name: string) => {
    if (!models.has(name)) {
      models.set(name, {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => 0),
      });
    }
    return models.get(name)!;
  };
  const prisma = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => (typeof prop === 'string' && prop !== 'then' ? model(prop) : undefined),
  });
  return {
    prisma,
    model,
    reset: () => models.clear(),
    captureExpense: vi.fn(),
    submitExpense: vi.fn(),
    matchPaymentToObligation: vi.fn(),
    getExpense: vi.fn(),
    listUnassignedCollections: vi.fn(),
    getCashflowProjection: vi.fn(),
    getBudgetVsActual: vi.fn(),
    getCashBook: vi.fn(),
    findExpenseDuplicates: vi.fn(),
    buildExtractionMaterial: vi.fn(),
    proposeExpenseWithAi: vi.fn(),
    loadCatalogRefs: vi.fn(),
    createProposal: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: h.prisma }));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/auth/permissions')>();
  const { withFinancePermissions } = await import('@/modules/finance/testing/finance-permissions');
  return withFinancePermissions(actual);
});
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/extensions/proposals-service', () => ({ createProposal: h.createProposal }));
vi.mock('@/modules/operations/commands', () => ({ executeCommand: vi.fn(), registerCommand: vi.fn(), versionedAggregate: vi.fn(() => ({})) }));
vi.mock('@/modules/operations/register-commands', () => ({}));
vi.mock('@/modules/finance/finance-commands', () => ({
  captureExpense: h.captureExpense,
  submitExpense: h.submitExpense,
  matchPaymentToObligation: h.matchPaymentToObligation,
}));
vi.mock('@/modules/finance/finance-queries', () => ({ getExpense: h.getExpense, listUnassignedCollections: h.listUnassignedCollections }));
vi.mock('@/modules/finance/cashflow-service', () => ({
  getCashflowProjection: h.getCashflowProjection,
  getBudgetVsActual: h.getBudgetVsActual,
  getCashBook: h.getCashBook,
}));
vi.mock('@/modules/finance/expenses-service', () => ({ findExpenseDuplicates: h.findExpenseDuplicates }));
vi.mock('@/modules/finance/expense-extraction', () => ({
  buildExtractionMaterial: h.buildExtractionMaterial,
  proposeExpenseWithAi: h.proposeExpenseWithAi,
}));
vi.mock('@/modules/finance/finance-helpers', () => ({ loadCatalogRefs: h.loadCatalogRefs }));

import { expenseProposalSchema } from '@/modules/finance/expense-rules';
import { executeTool, getToolDefinition, type ToolExecutionContext } from './registry';
import { FINANCE_INTERNAL_TOOL_NAMES } from './finance-internal-tools';

function person(permissions: string[], overrides: Partial<CurrentUser> = {}): CurrentUser {
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

const capturer = person(['finance.capture_expense']);
const accountant = person(['finance.capture_expense', 'finance.view', 'finance.manage_obligations'], { id: 'u-conta' });
const financeBot = person(['finance.view', 'finance.capture_expense', 'finance.manage_obligations'], {
  id: 'bot-conta',
  username: 'ia_contabilidad',
  roleKeys: ['agent_contabilidad'],
  isBot: true,
});
const logisticsBot = person(['finance.view', 'finance.capture_expense'], {
  id: 'bot-log',
  username: 'ia_logistica',
  roleKeys: ['agent_logistica'],
  isBot: true,
});

const read: ToolExecutionContext = { skipCache: true };

beforeEach(() => {
  h.reset();
  for (const fn of [
    h.captureExpense,
    h.submitExpense,
    h.matchPaymentToObligation,
    h.getExpense,
    h.listUnassignedCollections,
    h.getCashflowProjection,
    h.getBudgetVsActual,
    h.getCashBook,
    h.findExpenseDuplicates,
    h.buildExtractionMaterial,
    h.proposeExpenseWithAi,
    h.loadCatalogRefs,
    h.createProposal,
  ]) {
    fn.mockReset();
  }
  h.createProposal.mockImplementation(async (input: { summary: string; tool: { effect: string } }) => ({
    id: 'prop-1',
    summary: input.summary,
    effect: input.tool.effect,
    expiresAt: new Date('2026-09-16T00:00:00.000Z'),
  }));
});

describe('registration', () => {
  it.each([
    ['captureExpenseDraft', 'draft', 'finance.capture_expense'],
    ['proposeExpenseFields', 'read', 'finance.capture_expense'],
    ['checkExpenseDuplicate', 'read', 'finance.capture_expense'],
    ['submitExpense', 'business_write', 'finance.capture_expense'],
    ['getCashflowProjection', 'read', 'finance.view'],
    ['getBudgetVsActual', 'read', 'finance.view'],
    ['listUnmatchedPayments', 'read', 'finance.view'],
    ['matchPaymentToObligation', 'business_write', 'finance.manage_obligations'],
    ['getCashBook', 'read', 'finance.view'],
  ])('%s is %s with %s', (name, effect, permission) => {
    expect(getToolDefinition(name)).toMatchObject({ effect, requiredPermission: permission, category: 'finance', enabledByDefault: true });
  });

  it('exports the names', () => {
    expect(FINANCE_INTERNAL_TOOL_NAMES).toHaveLength(9);
  });
});

describe('captureExpenseDraft', () => {
  const created = {
    status: 'completed',
    data: { expenseId: 'e1', number: 'GX-000010', status: 'draft', duplicateStatus: 'none', proposalQueued: true, matches: [] },
  };

  it('captures a text draft without an approval card', async () => {
    h.captureExpense.mockResolvedValue(created);
    const result = await executeTool('captureExpenseDraft', capturer, { text: 'Gasolina 500 en Pemex', amount: 500, supplierName: 'Pemex', isPaid: true });
    expect(result).toMatchObject({ success: true, result: { number: 'GX-000010', proposalQueued: true } });
    expect(h.createProposal).not.toHaveBeenCalled();
    expect(h.captureExpense).toHaveBeenCalledWith(
      capturer,
      { captureMode: 'text', rawInput: 'Gasolina 500 en Pemex', amount: 500, supplierNameFree: 'Pemex', isPaid: true },
      { commandId: expect.stringMatching(/^ai:captureExpenseDraft:/) }
    );
  });

  it('needs the capture permission and reports rejected commands', async () => {
    expect(await executeTool('captureExpenseDraft', person(['finance.view']), { text: 'Gasolina' })).toMatchObject({ success: false, errorCode: 'forbidden' });
    h.captureExpense.mockResolvedValue({ status: 'rejected', errorCode: 'module_disabled', message: 'La contabilidad interna está desactivada' });
    expect(await executeTool('captureExpenseDraft', capturer, { text: 'Gasolina' })).toMatchObject({
      success: false,
      error: 'La contabilidad interna está desactivada',
    });
  });

  it('only the Contabilidad identity captures among the AI identities', async () => {
    h.captureExpense.mockResolvedValue(created);
    const outside = await executeTool('captureExpenseDraft', logisticsBot, { text: 'Gasolina' });
    expect(outside.success).toBe(false);
    expect(outside.error).toContain('sólo puede actuar en Logística');
    expect(await executeTool('captureExpenseDraft', financeBot, { text: 'Gasolina' })).toMatchObject({ success: true });
  });
});

describe('submitExpense', () => {
  const draft = {
    id: 'e1',
    number: 'GX-000010',
    status: 'draft',
    statusLabel: 'Borrador',
    duplicateStatus: 'none',
    amount: '2512.00',
    currency: 'MXN',
    description: 'Gasolina de reparto',
    supplierNameFree: 'Pemex',
  };

  it('prepares an approval card with the expense data', async () => {
    h.getExpense.mockResolvedValue(draft);
    const result = await executeTool('submitExpense', capturer, { expenseId: 'e1' }, { conversationId: 'c1' });
    expect(result).toMatchObject({ success: false, needsApproval: true, errorCode: 'needs_approval' });
    expect(result.proposal?.summary).toContain('GX-000010');
    expect(result.proposal?.summary).toContain('2,512.00');
    expect(result.proposal?.summary).toContain('Gasolina de reparto');
    expect(h.submitExpense).not.toHaveBeenCalled();
  });

  it('refuses a suspected duplicate or an expense already sent before the card', async () => {
    h.getExpense.mockResolvedValue({ ...draft, duplicateStatus: 'suspect' });
    const suspect = await executeTool('submitExpense', capturer, { expenseId: 'e1' });
    expect(suspect).toMatchObject({ success: false, errorCode: 'invalid_args' });
    expect(suspect.error).toContain('parece duplicado');
    h.getExpense.mockResolvedValue({ ...draft, status: 'posted', statusLabel: 'Contabilizado' });
    expect((await executeTool('submitExpense', capturer, { expenseId: 'e1' })).error).toContain('ya no es un borrador');
    expect(h.createProposal).not.toHaveBeenCalled();
  });

  it('runs as the approving person; an AI identity never submits', async () => {
    h.submitExpense.mockResolvedValue({
      status: 'completed',
      data: { expenseId: 'e1', number: 'GX-000010', status: 'approved', submitted: true, autoApproved: true, requiredApprovals: 0 },
    });
    const done = await executeTool('submitExpense', capturer, { expenseId: 'e1', number: 'GX-000010' }, { approvedProposalId: 'prop-9' });
    expect(done).toMatchObject({ success: true });
    expect((done.result as { message: string }).message).toContain('aprobado por la política');
    expect(h.submitExpense).toHaveBeenCalledWith(capturer, { expenseId: 'e1' }, { commandId: 'proposal:prop-9:submitExpense' });

    const bot = await executeTool('submitExpense', financeBot, { expenseId: 'e1' }, { approvedProposalId: 'prop-9' });
    expect(bot).toMatchObject({ success: false });
    expect(bot.error).toContain('Un gasto lo envía una persona');
  });
});

describe('matchPaymentToObligation', () => {
  const payment = { zohoPaymentId: 'P-1', paymentNumber: 'PAGO-1', customerName: 'Constructora Río' };
  const receivable = {
    id: 'ob1',
    number: 'OB-000001',
    kind: 'receivable',
    status: 'expected',
    expectedAmount: new Prisma.Decimal('3000'),
    settledAmount: new Prisma.Decimal('0'),
    currency: 'MXN',
    counterpartyName: 'Constructora Río',
  };

  it('prepares the card with the payment and the receivables', async () => {
    h.model('customerPayment').findUnique.mockResolvedValue(payment);
    h.model('obligation').findMany.mockResolvedValue([receivable]);
    const result = await executeTool('matchPaymentToObligation', accountant, { zohoPaymentId: 'P-1', allocations: [{ obligationId: 'ob1', amount: 3000 }] });
    expect(result).toMatchObject({ needsApproval: true });
    expect(result.proposal?.summary).toBe('Asignar el pago PAGO-1 de Constructora Río a OB-000001 (Constructora Río) $3,000.00');
  });

  it('validates the receivables before the card', async () => {
    h.model('customerPayment').findUnique.mockResolvedValue(payment);
    h.model('obligation').findMany.mockResolvedValue([{ ...receivable, kind: 'payable' }]);
    expect((await executeTool('matchPaymentToObligation', accountant, { zohoPaymentId: 'P-1', allocations: [{ obligationId: 'ob1', amount: 1 }] })).error).toContain(
      'no es una cuenta por cobrar'
    );
    h.model('obligation').findMany.mockResolvedValue([{ ...receivable, settledAmount: new Prisma.Decimal('2500') }]);
    expect((await executeTool('matchPaymentToObligation', accountant, { zohoPaymentId: 'P-1', allocations: [{ obligationId: 'ob1', amount: 600 }] })).error).toContain(
      'excede su saldo'
    );
    h.model('customerPayment').findUnique.mockResolvedValue(null);
    expect((await executeTool('matchPaymentToObligation', accountant, { zohoPaymentId: 'P-x', allocations: [{ obligationId: 'ob1', amount: 1 }] })).error).toBe(
      'No encontré ese pago de Zoho'
    );
    expect(await executeTool('matchPaymentToObligation', capturer, { zohoPaymentId: 'P-1', allocations: [{ obligationId: 'ob1', amount: 1 }] })).toMatchObject({
      errorCode: 'forbidden',
    });
  });

  it('assigns after approval with cents and the proposal command id', async () => {
    h.matchPaymentToObligation.mockResolvedValue({
      status: 'completed',
      data: { zohoPaymentId: 'P-1', applied: [{ obligationId: 'ob1', number: 'OB-000001', settlementId: 's1', amount: '3000.00', externalRef: 'x' }], skipped: [], remaining: '0.00', completedWorkItemIds: ['w1'] },
    });
    const result = await executeTool(
      'matchPaymentToObligation',
      accountant,
      { zohoPaymentId: 'P-1', allocations: [{ obligationId: 'ob1', amount: 3000 }] },
      { approvedProposalId: 'prop-2' }
    );
    expect(result).toMatchObject({ success: true });
    expect((result.result as { message: string }).message).toBe('Pago asignado a OB-000001');
    expect(h.matchPaymentToObligation).toHaveBeenCalledWith(
      accountant,
      { zohoPaymentId: 'P-1', allocations: [{ obligationId: 'ob1', amount: '3000.00' }] },
      { commandId: 'proposal:prop-2:matchPaymentToObligation' }
    );
    const bot = await executeTool('matchPaymentToObligation', financeBot, { zohoPaymentId: 'P-1', allocations: [{ obligationId: 'ob1', amount: 1 }] }, { approvedProposalId: 'p' });
    expect(bot.error).toContain('Una IA no asigna cobros');
  });
});

describe('readings', () => {
  it('projection, budget and unmatched payments need finance.view and the right identity', async () => {
    h.getCashflowProjection.mockResolvedValue({ weeks: [] });
    expect(await executeTool('getCashflowProjection', accountant, { weeks: 4 }, read)).toMatchObject({ success: true, result: { weeks: [] } });
    expect(h.getCashflowProjection).toHaveBeenCalledWith(accountant, { weeks: 4 });
    expect(await executeTool('getCashflowProjection', capturer, {}, read)).toMatchObject({ errorCode: 'forbidden' });
    const outside = await executeTool('getBudgetVsActual', logisticsBot, { periodKey: '2026-09' }, read);
    expect(outside.error).toContain('sólo consulta el trabajo de Logística');
    h.getBudgetVsActual.mockResolvedValue({ rows: [] });
    expect(await executeTool('getBudgetVsActual', financeBot, { periodKey: '2026-09' }, read)).toMatchObject({ success: true });
    h.listUnassignedCollections.mockResolvedValue([{ zohoPaymentId: 'P-2', remaining: '500.00' }]);
    expect(await executeTool('listUnmatchedPayments', accountant, {}, read)).toMatchObject({ result: { count: 1 } });
    expect(h.listUnassignedCollections).toHaveBeenCalledWith(accountant, { from: undefined, limit: 30 });
  });

  it('resolves the cash account by key for the cash book', async () => {
    h.model('cashAccount').findUnique.mockResolvedValue({ id: 'acc-bank' });
    h.getCashBook.mockResolvedValue({ rows: [] });
    await executeTool('getCashBook', accountant, { cashAccountKey: 'banco_zoho', from: '2026-09-01' }, read);
    expect(h.model('cashAccount').findUnique).toHaveBeenCalledWith({ where: { key: 'banco_zoho' }, select: { id: true } });
    expect(h.getCashBook).toHaveBeenCalledWith(accountant, { cashAccountId: 'acc-bank', from: '2026-09-01', to: undefined, page: undefined, pageSize: 50 });
    h.model('cashAccount').findUnique.mockResolvedValue(null);
    expect((await executeTool('getCashBook', accountant, { cashAccountKey: 'nada' }, read)).error).toBe('No existe la cuenta nada');
  });

  it('checks duplicates of an own expense, or by amount only with finance.view', async () => {
    h.getExpense.mockResolvedValue({ id: 'e1', amount: '1000.00', date: '2026-09-10', supplierId: null, supplierNameFree: 'Pemex', receiptHash: 'h1' });
    h.findExpenseDuplicates.mockResolvedValue([{ expenseId: 'e0', number: 'GX-000001', kind: 'receipt', reason: 'mismo archivo', daysApart: 0, amountDiffPct: 0 }]);
    const own = await executeTool('checkExpenseDuplicate', capturer, { expenseId: 'e1' }, read);
    expect(own).toMatchObject({ success: true, result: { verdict: '1 posible(s) duplicado(s)' } });
    expect(h.findExpenseDuplicates).toHaveBeenCalledWith(h.prisma, {
      id: 'e1',
      amount: '1000.00',
      dateKey: '2026-09-10',
      supplierId: null,
      supplierNameFree: 'Pemex',
      receiptHash: 'h1',
    });
    const blind = await executeTool('checkExpenseDuplicate', capturer, { amount: 1000, date: '2026-09-10' }, read);
    expect(blind.error).toContain('necesitas ver la contabilidad');
    h.findExpenseDuplicates.mockResolvedValue([]);
    expect(await executeTool('checkExpenseDuplicate', accountant, { amount: 1000, date: '2026-09-10' }, read)).toMatchObject({
      result: { verdict: 'Sin duplicados aparentes' },
    });
  });

  it('proposes fields from text with the model, or from rules when it fails', async () => {
    h.loadCatalogRefs.mockResolvedValue({
      categories: [
        { id: 'cat1', key: 'combustible', name: 'Combustible', kind: 'expense', status: 'active', defaultCostCenterId: null },
        { id: 'cat2', key: 'gastos_generales', name: 'Gastos generales', kind: 'expense', status: 'active', defaultCostCenterId: null },
      ],
      costCenters: [{ id: 'cc1', key: 'cc_logistica', name: 'Logística', areaKey: 'logistica', status: 'active' }],
      cashAccounts: [],
    });
    h.buildExtractionMaterial.mockResolvedValue({ text: 'x', parts: [], visual: false, notes: [] });
    h.proposeExpenseWithAi.mockResolvedValue({
      raw: expenseProposalSchema.parse({ amount: 500, categoryKey: 'combustible', costCenterKey: 'cc_logistica', confidence: 0.9 }),
      model: 'm',
    });
    const ai = await executeTool('proposeExpenseFields', capturer, { text: 'Gasolina 500' }, read);
    expect(ai).toMatchObject({
      success: true,
      result: { source: 'ai', proposal: { amount: '500.00', categoryName: 'Combustible', costCenterName: 'Logística', confidence: 0.9 } },
    });
    h.proposeExpenseWithAi.mockRejectedValue(new Error('sin modelo'));
    const rules = await executeTool('proposeExpenseFields', capturer, { text: 'Carga de gasolina' }, read);
    expect(rules).toMatchObject({ success: true, result: { source: 'rules', error: 'sin modelo', proposal: { categoryName: 'Combustible', amount: null } } });
    expect(await executeTool('proposeExpenseFields', capturer, {}, read)).toMatchObject({ errorCode: 'invalid_args' });
  });
});
