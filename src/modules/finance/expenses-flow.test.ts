import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Expenses on FakePrisma (plan 9.1): capture → proposal (AI mocked) →
 * duplicate → resolution → business approval → posting (paid entry or
 * payable obligation), auto-approval under the threshold, receipts, the
 * rules-only proposal when the model fails, and the reversal of a posted
 * expense.
 */

const mocks = await vi.hoisted(async () => {
  const { createFinanceFake } = await import('./testing/finance-fixtures');
  return {
    fake: createFinanceFake(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
    chatCompletion: vi.fn(),
    processAttachment: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/auth/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/auth/permissions')>();
  const { withFinancePermissions } = await import('./testing/finance-permissions');
  return withFinancePermissions(actual);
});
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/jobs/job-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/jobs/job-queue')>()),
  wakeJobWorker: vi.fn(),
  registerJobHandler: vi.fn(),
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: vi.fn() }));
vi.mock('@/modules/operations/case-service', () => ({ onCaseStarted: vi.fn(() => () => undefined) }));
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: mocks.chatCompletion }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/ai/ai-attachments-service', () => ({ processAttachment: mocks.processAttachment }));
vi.mock('@/modules/ai/json-utils', async () => {
  const { parseFirstJsonObject } = await import('./testing/finance-fixtures');
  return { parseJsonObject: parseFirstJsonObject };
});

import { decideApproval } from '@/modules/operations/approvals-service';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { ensureFinanceSeed } from './catalog-service';
import { proposeExpense } from './expenses-service';
import {
  captureExpense,
  postExpense,
  resolveExpenseDuplicate,
  reverseExpense,
  submitExpense,
  updateExpense,
} from './finance-commands';
import { invalidateFinanceSettingsCache } from './finance-config';
import { dateKeyOf } from './finance-dates';
import { settleObligation } from './obligations-service';
import {
  aiAnswer,
  byKey,
  D,
  dbDate,
  eventsOf,
  FINANCE_TEST_NOW,
  linesOf,
  resetFinanceFake,
  rowById,
  seedFinanceTeam,
  seedOperationsConfig,
  seedStorageObject,
  type FinanceTeam,
} from './testing/finance-fixtures';
import { seedUser } from '@/modules/operations/testing/fixtures';

const { fake } = mocks;
const NOW = FINANCE_TEST_NOW;
const tx = fake.client as unknown as Prisma.TransactionClient;
let team: FinanceTeam;
let seq = 0;
const opts = () => ({ commandId: `cmd-${++seq}`, now: NOW });
const cat = (key: string) => byKey(fake, 'financeCategory', key).id as string;
const center = (area: string) => byKey(fake, 'costCenter', `cc_${area}`).id as string;
const cash = (key: string) => byKey(fake, 'cashAccount', key);
const expense = (id: string) => rowById(fake, 'expense', id);

beforeEach(async () => {
  await resetFinanceFake(fake);
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  mocks.chatCompletion.mockReset();
  mocks.processAttachment.mockReset();
  mocks.notifyUser.mockClear();
  seedOperationsConfig(fake);
  team = seedFinanceTeam(fake);
  await ensureFinanceSeed(tx);
});

describe('capture → proposal → duplicate → approval → posting', () => {
  it('runs the whole flow of a text expense with a fuzzy duplicate', async () => {
    fake.seed('expense', {
      id: 'gx-orig',
      number: 'GX-000900',
      status: 'posted',
      amount: D('2500.00'),
      date: dbDate('2026-09-13'),
      supplierNameFree: 'Gasolinera Pemex del Valle',
      categoryId: cat('combustible'),
      costCenterId: center('logistica'),
      createdByUserId: 'u-otro',
    });

    const captured = await captureExpense(
      team.capturer,
      { captureMode: 'text', rawInput: 'Cargué gasolina 2,512 en Pemex del Valle ayer, pagué en efectivo' },
      opts()
    );
    expect(captured.status).toBe('completed');
    const expenseId = captured.data!.expenseId;
    expect(captured.data).toMatchObject({ number: 'GX-000001', status: 'draft', proposalQueued: true, duplicateStatus: 'none' });
    expect(fake.rows('backgroundJob').filter((j) => j.type === 'finance.expense_propose')).toHaveLength(1);
    expect(eventsOf(fake, 'finance.expense.captured')).toHaveLength(1);

    mocks.chatCompletion.mockResolvedValueOnce(
      aiAnswer({
        amount: 2512,
        date: '2026-09-14',
        supplierName: 'Gasolinera Pemex del Valle, S.A. de C.V.',
        categoryKey: 'combustible',
        costCenterKey: 'cc_logistica',
        paymentMethod: 'cash',
        isPaid: true,
        description: 'Gasolina de reparto',
        confidence: 0.86,
      })
    );
    const proposal = await proposeExpense(expenseId, { now: NOW });
    expect(proposal).toMatchObject({ status: 'applied', source: 'ai' });
    const request = mocks.chatCompletion.mock.calls[0][0];
    expect(request.temperature).toBe(0);
    expect(JSON.stringify(request.messages[1].content)).toContain('untrusted source=\\"expense_capture\\"');
    expect(request.messages[0].content).toContain('combustible: Combustible');

    const row = expense(expenseId);
    expect(row).toMatchObject({
      duplicateStatus: 'suspect',
      duplicateOfId: 'gx-orig',
      supplierNameFree: 'Gasolinera Pemex del Valle, S.A. de C.V.',
      categoryId: cat('combustible'),
      costCenterId: center('logistica'),
      paymentMethod: 'cash',
      description: 'Gasolina de reparto',
    });
    expect(D(row.amount).toFixed(2)).toBe('2512.00');
    expect(dateKeyOf(row.date)).toBe('2026-09-14');
    expect((row.aiProposal as Record<string, unknown>).status).toBe('proposed');
    expect(eventsOf(fake, 'finance.expense.duplicate_suspected')).toHaveLength(1);

    const blocked = await submitExpense(team.capturer, { expenseId }, opts());
    expect(blocked).toMatchObject({ status: 'rejected', errorCode: 'duplicate_unresolved' });

    const resolved = await resolveExpenseDuplicate(team.capturer, { expenseId, decision: 'unique' }, opts());
    expect(resolved.data).toMatchObject({ duplicateStatus: 'confirmed_unique', duplicateOfId: null });

    const submitted = await submitExpense(team.capturer, { expenseId }, opts());
    expect(submitted.data).toMatchObject({ submitted: true, autoApproved: false, requiredApprovals: 1, status: 'pending_approval' });
    const approvalRequestId = submitted.data!.approvalRequestId!;
    const approvalItems = fake.rows('workItem').filter((w) => w.objectId === approvalRequestId);
    expect(approvalItems.map((w) => w.ownerUserId).sort()).toEqual(['u-beto', 'u-carla', 'u-conta']);

    const selfVote = await decideApproval(team.capturer, { approvalRequestId, decision: 'approve' }, { commandId: 'vote-self', now: NOW });
    expect(selfVote).toMatchObject({ status: 'rejected', errorCode: 'self_approval' });
    const vote = await decideApproval(team.approver, { approvalRequestId, decision: 'approve' }, { commandId: 'vote-1', now: NOW });
    expect(vote.data?.status).toBe('approved');
    expect(expense(expenseId)).toMatchObject({ status: 'approved', approvedByUserId: 'u-beto' });

    const caja = cash('caja_general');
    const posted = await postExpense(team.admin, { expenseId, cashAccountId: caja.id }, opts());
    expect(posted.data).toMatchObject({ status: 'posted', obligationId: null });
    const entry = rowById(fake, 'ledgerEntry', posted.data!.ledgerEntryId!);
    expect(entry).toMatchObject({ kind: 'expense', sourceType: 'expense', sourceId: expenseId, periodKey: '2026-09', number: 'AS-000001' });
    expect(dateKeyOf(entry.date)).toBe('2026-09-14');
    expect(linesOf(fake, entry.id)).toEqual([
      ['category', cat('combustible'), '2512.00', '0.00', center('logistica')],
      ['cash', caja.id, '0.00', '2512.00', null],
    ]);
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('-2512.00');
    expect(cash('caja_general').version).toBe(2);
    expect(eventsOf(fake, 'finance.expense.posted')).toHaveLength(1);
  });

  it('auto-approves under the threshold and books an unpaid expense as a payable obligation', async () => {
    const captured = await captureExpense(
      team.capturer,
      {
        captureMode: 'form',
        amount: '850',
        date: '2026-09-15',
        supplierNameFree: 'Papelería Lozano',
        categoryId: cat('papeleria'),
        costCenterId: center('administracion'),
        isPaid: false,
        description: 'Hojas y tóner',
      },
      opts()
    );
    const expenseId = captured.data!.expenseId;
    expect(captured.data?.proposalQueued).toBe(false);
    const submitted = await submitExpense(team.capturer, { expenseId }, opts());
    expect(submitted.data).toMatchObject({ autoApproved: true, requiredApprovals: 0, status: 'approved' });
    expect(eventsOf(fake, 'finance.expense.approved')[0].payload).toMatchObject({ auto: true });

    const posted = await postExpense(team.admin, { expenseId, dueDate: '2026-10-15' }, opts());
    expect(posted.status).toBe('completed');
    const obligation = rowById(fake, 'obligation', posted.data!.obligationId!);
    expect(obligation).toMatchObject({ kind: 'payable', counterpartyType: 'other', counterpartyName: 'Papelería Lozano', expenseId, status: 'expected' });
    expect(D(obligation.expectedAmount).toFixed(2)).toBe('850.00');
    expect(dateKeyOf(obligation.dueAt)).toBe('2026-10-15');
    expect(linesOf(fake, obligation.ledgerEntryId)).toEqual([
      ['category', cat('papeleria'), '850.00', '0.00', center('administracion')],
      ['payable', obligation.id, '0.00', '850.00', null],
    ]);
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('0.00');

    // a payable born from an approved expense needs no payment authorization
    const paid = await settleObligation(team.admin, { obligationId: obligation.id, amount: '850', cashAccountId: cash('caja_general').id }, opts());
    expect(paid.data).toMatchObject({ status: 'settled', remaining: '0.00' });
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('-850.00');
  });

  it('reads the receipt, keeps what the person typed and detects the same receipt twice', async () => {
    seedStorageObject(fake, { id: 'obj-1', createdBy: 'u-ana', sha256: 'sha-ticket-1', originalName: 'ticket.jpg' });
    const captured = await captureExpense(team.capturer, { captureMode: 'photo', amount: '1200', receiptObjectIds: ['obj-1'] }, opts());
    const expenseId = captured.data!.expenseId;
    expect(expense(expenseId)).toMatchObject({ receiptHash: 'sha-ticket-1', receiptObjectIds: ['obj-1'] });

    mocks.processAttachment.mockResolvedValueOnce({ type: 'image', dataUrl: 'data:image/jpeg;base64,AAAA' });
    mocks.chatCompletion.mockResolvedValueOnce(
      aiAnswer({ amount: 999, date: '2026-09-12', supplierName: 'Hotel Camino Real', categoryKey: 'viaticos', confidence: 0.7 })
    );
    await proposeExpense(expenseId, { now: NOW });
    expect(mocks.processAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ storageObjectId: 'obj-1', mimeType: 'image/jpeg', status: 'ready' }),
      expect.anything()
    );
    const content = mocks.chatCompletion.mock.calls[0][0].messages[1].content as Array<{ type: string }>;
    expect(content.some((part) => part.type === 'image_url')).toBe(true);
    const row = expense(expenseId);
    expect(D(row.amount).toFixed(2)).toBe('1200.00');
    expect(row).toMatchObject({ categoryId: cat('viaticos'), supplierNameFree: 'Hotel Camino Real' });
    expect(dateKeyOf(row.date)).toBe('2026-09-12');

    seedStorageObject(fake, { id: 'obj-2', createdBy: 'u-ana', sha256: 'sha-ticket-1' });
    const again = await captureExpense(team.capturer, { captureMode: 'photo', receiptObjectIds: ['obj-2'] }, opts());
    expect(again.data).toMatchObject({ duplicateStatus: 'suspect', duplicateOfId: expenseId });
    expect(again.data?.matches?.[0]).toMatchObject({ kind: 'receipt', number: 'GX-000001' });

    seedStorageObject(fake, { id: 'obj-3', createdBy: 'u-otro' });
    const foreign = await captureExpense(team.capturer, { captureMode: 'photo', receiptObjectIds: ['obj-3'] }, opts());
    expect(foreign).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });

  it('without the model the proposal still classifies from the supplier history', async () => {
    for (const [id, day] of [
      ['h1', '2026-08-01'],
      ['h2', '2026-08-20'],
    ]) {
      fake.seed('expense', {
        id,
        number: `GX-9${id}`,
        status: 'posted',
        amount: D('900'),
        date: dbDate(day),
        supplierNameFree: 'Fletes Rápidos',
        categoryId: cat('fletes'),
        costCenterId: center('logistica'),
        createdByUserId: 'u-otro',
      });
    }
    const captured = await captureExpense(
      team.capturer,
      { captureMode: 'text', rawInput: 'Pago de maniobra', supplierNameFree: 'FLETES RAPIDOS', amount: '1500' },
      opts()
    );
    mocks.chatCompletion.mockRejectedValueOnce(new Error('proveedor caído'));
    const proposal = await proposeExpense(captured.data!.expenseId, { now: NOW });
    expect(proposal).toMatchObject({ status: 'applied', source: 'rules', error: 'proveedor caído' });
    expect(expense(captured.data!.expenseId)).toMatchObject({ categoryId: cat('fletes'), costCenterId: center('logistica') });
    const aiProposal = expense(captured.data!.expenseId).aiProposal as Record<string, unknown>;
    expect(aiProposal).toMatchObject({ source: 'rules', error: 'proveedor caído' });
  });

  it('rejects an incomplete submission and a bot submission; an edit resets a confirmed duplicate', async () => {
    const captured = await captureExpense(team.capturer, { captureMode: 'form', amount: '300', date: '2026-09-15' }, opts());
    const expenseId = captured.data!.expenseId;
    const incomplete = await submitExpense(team.capturer, { expenseId }, opts());
    expect(incomplete).toMatchObject({ status: 'rejected', errorCode: 'expense_incomplete' });
    expect(incomplete.message).toContain('Falta la categoría');

    const bot = { ...seedUser(fake, { id: 'bot-conta', permissions: ['finance.capture_expense'], isBot: true }).currentUser, isBot: true };
    const botCapture = await captureExpense(bot, { captureMode: 'text', rawInput: 'Gasolina 300 pesos' }, opts());
    expect(botCapture.status).toBe('completed');
    const botSubmit = await submitExpense(bot, { expenseId: botCapture.data!.expenseId }, opts());
    expect(botSubmit).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });

    const other = await captureExpense(
      team.capturer,
      { captureMode: 'form', amount: '300', date: '2026-09-15', categoryId: cat('papeleria'), supplierNameFree: 'Ferretería Sol' },
      opts()
    );
    const twin = await captureExpense(
      team.capturer,
      { captureMode: 'form', amount: '300', date: '2026-09-15', categoryId: cat('papeleria'), supplierNameFree: 'Ferretería Sol' },
      opts()
    );
    expect(twin.data).toMatchObject({ duplicateStatus: 'suspect', duplicateOfId: other.data!.expenseId });
    await resolveExpenseDuplicate(team.capturer, { expenseId: twin.data!.expenseId, decision: 'unique' }, opts());
    const edited = await updateExpense(team.capturer, { expenseId: twin.data!.expenseId, amount: '301' }, opts());
    expect(edited.data).toMatchObject({ duplicateStatus: 'suspect' });
    const outsider = await updateExpense(team.approver, { expenseId: twin.data!.expenseId, amount: '1' }, opts());
    expect(outsider).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
  });

  it('a posted expense is corrected only by reversal', async () => {
    const caja = cash('caja_general');
    const captured = await captureExpense(
      team.capturer,
      { captureMode: 'form', amount: '500', date: '2026-09-15', categoryId: cat('papeleria'), cashAccountId: caja.id },
      opts()
    );
    const expenseId = captured.data!.expenseId;
    await submitExpense(team.capturer, { expenseId }, opts());
    const posted = await postExpense(team.admin, { expenseId }, opts());
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('-500.00');

    const notAllowed = await reverseExpense(team.capturer, { expenseId, reason: 'Me equivoqué' }, opts());
    expect(notAllowed).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    const reversed = await reverseExpense(team.admin, { expenseId, reason: 'Gasto capturado dos veces' }, opts());
    expect(reversed.data).toMatchObject({ status: 'rejected' });
    const original = rowById(fake, 'ledgerEntry', posted.data!.ledgerEntryId!);
    const reversal = rowById(fake, 'ledgerEntry', reversed.data!.ledgerEntryId!);
    expect(original.reversedByEntryId).toBe(reversal.id);
    expect(reversal).toMatchObject({ kind: 'reversal', reversesEntryId: original.id, sourceType: 'expense', sourceId: expenseId });
    expect(linesOf(fake, reversal.id)).toEqual([
      ['category', cat('papeleria'), '0.00', '500.00', null],
      ['cash', caja.id, '500.00', '0.00', null],
    ]);
    expect(D(cash('caja_general').currentBalance).toFixed(2)).toBe('0.00');
    expect(expense(expenseId).rejectedReason).toBe('Reversado: Gasto capturado dos veces');
  });
});
