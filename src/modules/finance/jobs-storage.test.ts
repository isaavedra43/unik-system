import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Finance jobs and storage on FakePrisma: recurring templates with catch-up,
 * the daily digest of due obligations, the daily close reminder, the proposal
 * job wrapper, the `expense_receipt` upload target (attaches the receipt,
 * queues the proposal, links the evidence) and the `evidence` read resolver.
 */

const mocks = await vi.hoisted(async () => {
  const { createFinanceFake } = await import('./testing/finance-fixtures');
  class StorageError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: number
    ) {
      super(message);
      this.name = 'StorageError';
    }
  }
  return {
    fake: createFinanceFake(),
    notifyUser: vi.fn<
      (input: { userId: string; category: string; title: string; body?: string | null; dedupeKey?: string | null }) => Promise<{
        id: string;
        inApp: boolean;
        push: boolean;
        suppressed: boolean;
      }>
    >(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({ id: '1', channel: '', type: '', payload: {}, createdAt: '' })),
    registerUpload: vi.fn(),
    registerAccess: vi.fn(),
    StorageError,
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
vi.mock('@/modules/ai/ai-client', () => ({ chatCompletion: vi.fn() }));
vi.mock('@/modules/ai/ai-admin-config-service', () => ({ getAiSettings: vi.fn(async () => ({})) }));
vi.mock('@/modules/ai/ai-attachments-service', () => ({ processAttachment: vi.fn() }));
vi.mock('@/modules/ai/json-utils', () => ({ parseJsonObject: vi.fn() }));
vi.mock('@/modules/storage/storage-access', () => ({
  registerUploadTargetResolver: mocks.registerUpload,
  registerFileAccessResolver: mocks.registerAccess,
}));
vi.mock('@/modules/storage/storage-service', () => ({ StorageError: mocks.StorageError }));

import type { CurrentUser } from '@/modules/auth/authorization';
import { invalidateOperationsConfigCache } from '@/modules/operations/operations-config';
import { seedUser } from '@/modules/operations/testing/fixtures';
import { ensureFinanceSeed } from './catalog-service';
import {
  captureExpense,
  createExpenseTemplate,
  createManualObligation,
  postManualEntry,
  runDailyClose,
} from './finance-commands';
import { invalidateFinanceSettingsCache } from './finance-config';
import { dateKeyOf } from './finance-dates';
import {
  runDailyCloseReminderJob,
  runExpenseProposeJob,
  runObligationsDueJob,
  runRecurringExpensesJob,
  usersWithPermission,
} from './finance-jobs';
import { EXPENSE_RECEIPT_UPLOAD_TARGET } from './finance-storage';
import {
  byKey,
  FINANCE_TEST_NOW,
  makeJob,
  resetFinanceFake,
  rowById,
  seedFinanceTeam,
  seedOperationsConfig,
  seedStorageObject,
  type FinanceTeam,
} from './testing/finance-fixtures';

const { fake } = mocks;
const NOW = FINANCE_TEST_NOW;
const tx = fake.client as unknown as Prisma.TransactionClient;
let team: FinanceTeam;
let seq = 0;
const opts = () => ({ commandId: `cmd-${++seq}`, now: NOW });
const cat = (key: string) => byKey(fake, 'financeCategory', key).id as string;
const cash = (key: string) => byKey(fake, 'cashAccount', key);

type UploadResolver = (
  actor: CurrentUser,
  targetId: string,
  declared: { fileName: string; mimeType: string; sizeBytes: number }
) => Promise<{ policy: { purpose: string; maxBytes: number }; createReference?: (object: { id: string }) => Promise<{ referenceId: string }> }>;
type AccessResolver = (actor: CurrentUser, object: { id: string; createdBy?: string | null }) => Promise<boolean>;

const uploadResolver = () =>
  (mocks.registerUpload.mock.calls.find((call) => call[0] === EXPENSE_RECEIPT_UPLOAD_TARGET)?.[1] as UploadResolver);
const financeAccessResolver = () => {
  const calls = mocks.registerAccess.mock.calls.filter((call) => call[0] === 'evidence');
  return calls[calls.length - 1]?.[1] as AccessResolver;
};

beforeEach(async () => {
  await resetFinanceFake(fake);
  invalidateOperationsConfigCache();
  invalidateFinanceSettingsCache();
  mocks.notifyUser.mockClear();
  seedOperationsConfig(fake);
  team = seedFinanceTeam(fake);
  await ensureFinanceSeed(tx);
});

describe('recurring expenses', () => {
  it('creates one draft per due run, catching up missed months, then waits for the next date', async () => {
    const template = await createExpenseTemplate(
      team.admin,
      {
        name: 'Renta de bodega',
        categoryId: cat('renta'),
        defaultAmount: '15000',
        recurrence: { freq: 'monthly', interval: 1, dayOfMonth: 1 },
        firstRunDate: '2026-07-01',
      },
      opts()
    );
    expect(template.data).toMatchObject({ nextRunAt: '2026-07-01' });
    const missingDate = await createExpenseTemplate(
      team.admin,
      { name: 'Sin fecha', categoryId: cat('renta'), recurrence: { freq: 'weekly', interval: 1 } },
      opts()
    );
    expect(missingDate).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });

    const summary = await runRecurringExpensesJob({ now: NOW });
    expect(summary).toMatchObject({ templates: 1, created: 3 });
    const drafts = fake.rows('expense').filter((e) => e.templateId === template.data!.templateId);
    expect(drafts.map((e) => [dateKeyOf(e.date), e.captureMode, e.status, e.createdByUserId])).toEqual([
      ['2026-07-01', 'recurring', 'draft', 'u-conta'],
      ['2026-08-01', 'recurring', 'draft', 'u-conta'],
      ['2026-09-01', 'recurring', 'draft', 'u-conta'],
    ]);
    expect(drafts.every((e) => e.duplicateStatus === 'none')).toBe(true);
    expect(dateKeyOf(rowById(fake, 'expenseTemplate', template.data!.templateId).nextRunAt)).toBe('2026-10-01');
    expect(await runRecurringExpensesJob({ now: NOW })).toMatchObject({ templates: 0, created: 0 });
  });
});

describe('alerts', () => {
  it('sends one daily digest of overdue and soon-due obligations to who manages them', async () => {
    await createManualObligation(team.admin, { kind: 'payable', counterpartyType: 'supplier', counterpartyName: 'Aceros', description: 'Factura vencida', expectedAmount: '5000', dueAt: '2026-09-10' }, opts());
    await createManualObligation(team.admin, { kind: 'receivable', counterpartyType: 'customer', counterpartyName: 'Cliente', description: 'Cobro próximo', expectedAmount: '2000', dueAt: '2026-09-17' }, opts());
    await createManualObligation(team.admin, { kind: 'payable', counterpartyType: 'tax', counterpartyName: 'SAT', description: 'Lejano', expectedAmount: '100', dueAt: '2026-10-30' }, opts());
    expect(await usersWithPermission('finance.manage_obligations')).toEqual(['u-conta']);

    const result = await runObligationsDueJob({ now: NOW });
    expect(result).toMatchObject({ obligations: 2, notified: 1 });
    expect(mocks.notifyUser).toHaveBeenCalledTimes(1);
    expect(mocks.notifyUser.mock.calls[0][0]).toMatchObject({
      userId: 'u-conta',
      category: 'finance_alert',
      title: '1 obligación(es) vencida(s) y 1 por vencer',
      dedupeKey: 'finance_due:u-conta:2026-09-15',
    });
    expect((mocks.notifyUser.mock.calls[0][0] as { body: string }).body).toContain('1 por pagar · 1 por cobrar');
  });

  it('reminds the close owners about yesterday until it is closed', async () => {
    expect(await runDailyCloseReminderJob({ now: NOW })).toMatchObject({ skipped: 'no_activity' });
    await postManualEntry(
      team.admin,
      {
        kind: 'income',
        date: '2026-09-14',
        description: 'Venta',
        lines: [
          { accountType: 'cash', accountId: cash('caja_general').id, debit: '250' },
          { accountType: 'category', accountId: cat('otros_ingresos'), credit: '250' },
        ],
      },
      opts()
    );
    expect(await runDailyCloseReminderJob({ now: NOW })).toMatchObject({ notified: 1 });
    expect(mocks.notifyUser.mock.calls[0][0]).toMatchObject({
      userId: 'u-conta',
      title: 'Falta el cierre del 2026-09-14',
      dedupeKey: 'finance_close_reminder:2026-09-14:u-conta',
    });
    await runDailyClose(team.admin, { date: '2026-09-14', counts: [{ cashAccountId: cash('caja_general').id, counted: '250' }] }, opts());
    expect(await runDailyCloseReminderJob({ now: NOW })).toMatchObject({ skipped: 'closed' });
  });

  it('the proposal job ignores missing and non-draft expenses', async () => {
    expect(await runExpenseProposeJob(makeJob({}))).toEqual({ status: 'not_found' });
    expect(await runExpenseProposeJob(makeJob({ expenseId: 'nope' }))).toEqual({ status: 'not_found' });
    fake.seed('expense', { id: 'posted', number: 'GX-1', status: 'posted', date: new Date('2026-09-01T00:00:00Z'), createdByUserId: 'u-ana' });
    expect(await runExpenseProposeJob(makeJob({ expenseId: 'posted' }))).toEqual({ status: 'skipped' });
  });
});

describe('expense receipts in storage', () => {
  it('attaches a receipt to a draft, queues the proposal and links the evidence', async () => {
    const draft = await captureExpense(team.capturer, { captureMode: 'photo' }, opts());
    const expenseId = draft.data!.expenseId;
    expect(draft.data?.proposalQueued).toBe(false);
    const resolver = uploadResolver();
    expect(resolver).toBeTypeOf('function');

    const resolution = await resolver(team.capturer, expenseId, { fileName: 'ticket.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 });
    expect(resolution.policy).toMatchObject({ purpose: 'evidence', maxBytes: 15 * 1024 * 1024 });
    seedStorageObject(fake, { id: 'obj-9', createdBy: 'u-ana', sha256: 'sha-9', status: 'validating' });
    await expect(resolution.createReference!({ id: 'obj-9' })).resolves.toEqual({ referenceId: expenseId });

    expect(rowById(fake, 'expense', expenseId)).toMatchObject({ receiptObjectIds: ['obj-9'], receiptHash: 'sha-9' });
    expect(fake.rows('backgroundJob').filter((j) => j.type === 'finance.expense_propose' && j.status === 'pending')).toHaveLength(1);
    expect(fake.rows('evidenceLink').find((l) => l.storageObjectId === 'obj-9')).toMatchObject({ objectType: 'expense', objectId: expenseId, kind: 'photo' });

    const access = financeAccessResolver();
    expect(await access(team.capturer, { id: 'obj-9' })).toBe(true);
    expect(await access(team.approver, { id: 'obj-9' })).toBe(true);
    const outsider = seedUser(fake, { id: 'u-sin', permissions: ['finance.capture_expense'] }).currentUser;
    expect(await access(outsider, { id: 'obj-9' })).toBe(false);
    expect(await access(team.approver, { id: 'obj-unrelated' })).toBe(false);
  });

  it('refuses other people, wrong formats and expenses that are no longer drafts', async () => {
    const draft = await captureExpense(team.capturer, { captureMode: 'photo' }, opts());
    const expenseId = draft.data!.expenseId;
    const resolver = uploadResolver();
    const declared = { fileName: 'ticket.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };
    const other = seedUser(fake, { id: 'u-otro', permissions: ['finance.capture_expense'] }).currentUser;
    await expect(resolver(other, expenseId, declared)).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(resolver(team.approver, expenseId, declared)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolver(team.capturer, expenseId, { ...declared, mimeType: 'text/plain' })).rejects.toMatchObject({ status: 415 });
    await expect(resolver(team.capturer, 'nope', declared)).rejects.toMatchObject({ code: 'not_found' });
    rowById(fake, 'expense', expenseId).status = 'approved';
    await expect(resolver(team.admin, expenseId, declared)).rejects.toMatchObject({ code: 'invalid', status: 409 });
  });
});
