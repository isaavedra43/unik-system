import { Prisma } from '@prisma/client';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { FakePrisma, Row } from '@/modules/comms/testing/fake-prisma';
import type { JobContext } from '@/modules/jobs/job-queue';
import {
  createOpsFake,
  seedAreas,
  seedResponsible,
  seedUser,
} from '@/modules/operations/testing/fixtures';
import { FINANCE_PERMISSION_KEYS } from '../permissions';

/**
 * Test fixtures of the finance module on top of `createOpsFake()`: defaults,
 * relations and unique keys of the finance models (CashAccount …
 * PeriodClose) and of the synced Zoho rows it reads (SalesOrder,
 * CustomerPayment, Contact, Invoice, IntegrationSnapshot), a team with the
 * finance permissions and seed helpers.
 *
 * Pure test helper (no `@/lib/prisma`): import it from `vi.hoisted`.
 */

export const FINANCE_TEST_NOW = new Date('2026-09-15T18:00:00.000Z');
/** Operations cutover used by the tests (payments before it are never reconciled). */
export const FINANCE_TEST_CUTOVER = '2026-08-01T06:00:00.000Z';

export const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
export const dbDate = (key: string) => new Date(`${key}T00:00:00.000Z`);

const nulls = (keys: string[]): Row => Object.fromEntries(keys.map((key) => [key, null]));

export function createFinanceFake(): FakePrisma {
  return createOpsFake({
    defaults: {
      cashAccount: () => ({ currency: 'MXN', openingBalance: D(0), currentBalance: D(0), status: 'active', version: 1 }),
      financeCategory: () => ({ isDirect: false, parentId: null, defaultCostCenterId: null, status: 'active' }),
      costCenter: () => ({ areaKey: null, parentId: null, status: 'active' }),
      ledgerEntry: () => ({
        currency: 'MXN',
        sourceType: null,
        sourceId: null,
        reversesEntryId: null,
        reversedByEntryId: null,
        postedAt: new Date(),
        evidenceObjectIds: [],
        meta: null,
      }),
      ledgerLine: () => ({
        debit: D(0),
        credit: D(0),
        ...nulls(['costCenterId', 'caseId', 'procurementOrderId', 'projectRef', 'memo']),
      }),
      obligation: () => ({
        ...nulls([
          'counterpartyName',
          'supplierId',
          'zohoContactId',
          'employeeId',
          'caseId',
          'procurementOrderId',
          'payrollRunId',
          'expenseId',
          'zohoSalesOrderId',
          'zohoInvoiceId',
          'dueAt',
          'expectedCashAt',
          'costCenterId',
          'ledgerEntryId',
        ]),
        currency: 'MXN',
        settledAmount: D(0),
        status: 'expected',
        version: 1,
      }),
      obligationSettlement: () => ({
        settledAt: new Date(),
        cashAccountId: null,
        zohoPaymentId: null,
        externalRef: null,
        evidenceObjectIds: [],
      }),
      expense: () => ({
        ...nulls([
          'rawInput',
          'aiProposal',
          'supplierId',
          'supplierNameFree',
          'categoryId',
          'costCenterId',
          'cashAccountId',
          'paymentMethod',
          'description',
          'receiptHash',
          'duplicateKey',
          'duplicateOfId',
          'approvalRequestId',
          'ledgerEntryId',
          'obligationId',
          'templateId',
          'caseId',
          'approvedByUserId',
          'postedAt',
          'rejectedReason',
        ]),
        status: 'draft',
        captureMode: 'form',
        amount: D(0),
        currency: 'MXN',
        isPaid: true,
        receiptObjectIds: [],
        duplicateStatus: 'none',
        version: 1,
      }),
      expenseSplit: () => ({ costCenterId: null, caseId: null, projectRef: null, pct: null }),
      expenseTemplate: () => ({
        costCenterId: null,
        supplierId: null,
        defaultAmount: null,
        currency: 'MXN',
        recurrence: null,
        nextRunAt: null,
        active: true,
      }),
      budget: () => ({ costCenterId: '', categoryId: '', currency: 'MXN' }),
      employee: () => ({ position: null, userId: null, areaKey: null, costCenterId: null, active: true }),
      payrollRun: () => ({
        status: 'draft',
        currency: 'MXN',
        totalGross: D(0),
        totalDeductions: D(0),
        totalNet: D(0),
        approvalRequestId: null,
        version: 1,
      }),
      payrollLine: () => ({ deductions: [], advancesApplied: D(0), costCenterId: null, obligationId: null, status: 'pending' }),
      periodClose: () => ({
        status: 'open',
        closedByUserId: null,
        closedAt: null,
        snapshot: null,
        checks: null,
        reopenReason: null,
        version: 1,
      }),
      salesOrder: () => ({
        ...nulls([
          'salesOrderNumber',
          'referenceNumber',
          'orderDate',
          'status',
          'zohoCustomerId',
          'customerName',
          'currencyCode',
          'total',
          'balance',
        ]),
        sourceRemoteModifiedAt: new Date(),
        sourceSnapshotId: 'snap',
      }),
      customerPayment: () => ({
        ...nulls([
          'paymentNumber',
          'paymentMode',
          'status',
          'date',
          'amount',
          'balance',
          'zohoCustomerId',
          'customerName',
          'currencyCode',
          'referenceNumber',
          'description',
        ]),
        sourceRemoteModifiedAt: new Date(),
        sourceSnapshotId: 'snap',
      }),
      contact: () => ({ contactType: 'customer', contactName: null, paymentTerms: null }),
      invoice: () => ({ invoiceNumber: null, status: null, zohoCustomerId: null, sourceRemoteModifiedAt: new Date(), sourceSnapshotId: 'snap' }),
      invoiceItem: () => ({ zohoSalesOrderId: null, zohoItemId: null, sortOrder: 0 }),
      integrationSnapshot: () => ({ fetchedAt: new Date(), normalizationVersion: 0 }),
      storageObject: () => ({
        provider: 'disk',
        bucketAlias: 'files',
        versionId: 'v1',
        status: 'ready',
        sha256: null,
        detectedMimeType: null,
        createdBy: null,
        purpose: 'evidence',
        sizeBytes: BigInt(2048),
      }),
      supplier: () => ({ status: 'active', legalName: null, taxRegNo: null, paymentTermsDays: null }),
    },
    relations: {
      ledgerEntry: { lines: { model: 'ledgerLine', childFk: 'entryId' } },
      ledgerLine: { entry: { model: 'ledgerEntry', fk: 'entryId' } },
      obligation: { settlements: { model: 'obligationSettlement', childFk: 'obligationId' } },
      obligationSettlement: { obligation: { model: 'obligation', fk: 'obligationId' } },
      expense: { splits: { model: 'expenseSplit', childFk: 'expenseId' } },
      expenseSplit: { expense: { model: 'expense', fk: 'expenseId' } },
      payrollRun: { lines: { model: 'payrollLine', childFk: 'payrollRunId' } },
      payrollLine: { payrollRun: { model: 'payrollRun', fk: 'payrollRunId' } },
      invoice: { items: { model: 'invoiceItem', childFk: 'invoiceId' } },
      invoiceItem: { invoice: { model: 'invoice', fk: 'invoiceId' } },
    },
    uniques: {
      cashAccount: [['key']],
      financeCategory: [['key']],
      costCenter: [['key']],
      ledgerEntry: [['number'], ['reversesEntryId']],
      ledgerLine: [['entryId', 'seq']],
      obligation: [['number']],
      obligationSettlement: [['externalRef']],
      expense: [['number']],
      budget: [['periodKey', 'costCenterId', 'categoryId']],
      employee: [['number'], ['userId']],
      payrollRun: [['number']],
      payrollLine: [['payrollRunId', 'employeeId']],
      periodClose: [['periodKey', 'kind']],
      salesOrder: [['zohoSalesOrderId']],
      customerPayment: [['zohoPaymentId']],
      contact: [['zohoContactId']],
      invoice: [['zohoInvoiceId']],
    },
  });
}

interface FakeInternals {
  defaults: Record<string, () => Row>;
  relations: Record<string, Record<string, unknown>>;
  uniques: Record<string, unknown[]>;
  compoundKeys: Record<string, string[]>;
}

/**
 * Adds the finance models (defaults, relations, unique keys) to a FakePrisma
 * created by another module's fixture, for cross-module flows (e.g. Compras
 * paying through the real obligations service). Models the target already
 * defines keep their definition.
 */
export function extendFakeWithFinance(fake: FakePrisma): FakePrisma {
  const source = createFinanceFake() as unknown as FakeInternals;
  const target = fake as unknown as FakeInternals;
  for (const [model, factory] of Object.entries(source.defaults)) {
    if (!(model in target.defaults)) target.defaults[model] = factory;
  }
  for (const [model, relations] of Object.entries(source.relations)) {
    target.relations[model] = { ...relations, ...(target.relations[model] ?? {}) };
  }
  for (const [model, rules] of Object.entries(source.uniques)) {
    if (!target.uniques[model] || target.uniques[model].length === 0) target.uniques[model] = [...rules];
  }
  for (const [key, fields] of Object.entries(source.compoundKeys)) {
    if (!(key in target.compoundKeys)) target.compoundKeys[key] = fields;
  }
  return fake;
}

/** Every model a finance test may touch (cleared between tests). */
export const FINANCE_FAKE_MODELS = [
  'user',
  'role',
  'userRole',
  'rolePermission',
  'responsible',
  'area',
  'integrationConfig',
  'sequence',
  'operationalCommand',
  'operationalEvent',
  'operationalCase',
  'workItem',
  'areaRequest',
  'incident',
  'approvalPolicy',
  'approvalRequest',
  'objectRelation',
  'evidenceLink',
  'notification',
  'auditLog',
  'backgroundJob',
  'realtimeEvent',
  'cashAccount',
  'financeCategory',
  'costCenter',
  'ledgerEntry',
  'ledgerLine',
  'obligation',
  'obligationSettlement',
  'expense',
  'expenseSplit',
  'expenseTemplate',
  'budget',
  'employee',
  'payrollRun',
  'payrollLine',
  'periodClose',
  'salesOrder',
  'customerPayment',
  'contact',
  'invoice',
  'invoiceItem',
  'integrationSnapshot',
  'storageObject',
  'supplier',
] as const;

export async function resetFinanceFake(fake: FakePrisma): Promise<void> {
  const client = fake.client as unknown as Record<string, { deleteMany(args: Row): Promise<unknown> }>;
  for (const model of FINANCE_FAKE_MODELS) await client[model].deleteMany({});
}

export function seedOperationsConfig(fake: FakePrisma, cutoverDate: string = FINANCE_TEST_CUTOVER): Row {
  return fake.seed('integrationConfig', {
    source: 'operations',
    displayName: 'Operaciones',
    isEnabled: true,
    settings: { cutoverDate },
  });
}

export interface FinanceTeam {
  /** Contabilidad: every finance permission (responsible of the area). */
  admin: CurrentUser;
  /** Captures expenses only. */
  capturer: CurrentUser;
  approver: CurrentUser;
  approver2: CurrentUser;
}

export function seedFinanceTeam(fake: FakePrisma): FinanceTeam {
  seedAreas(fake);
  const admin = seedUser(fake, { id: 'u-conta', name: 'Contadora', permissions: [...FINANCE_PERMISSION_KEYS, 'operations.view'] });
  const capturer = seedUser(fake, { id: 'u-ana', name: 'Ana', permissions: ['finance.capture_expense'] });
  const approver = seedUser(fake, { id: 'u-beto', name: 'Beto', permissions: ['finance.approve', 'finance.view'] });
  const approver2 = seedUser(fake, { id: 'u-carla', name: 'Carla', permissions: ['finance.approve'] });
  seedResponsible(fake, { area: 'contabilidad', userId: admin.user.id });
  seedResponsible(fake, { area: 'administracion', userId: admin.user.id });
  return {
    admin: admin.currentUser,
    capturer: capturer.currentUser,
    approver: approver.currentUser,
    approver2: approver2.currentUser,
  };
}

export function seedStorageObject(
  fake: FakePrisma,
  input: { id: string; createdBy: string; mimeType?: string; sha256?: string | null; originalName?: string; status?: string }
): Row {
  return fake.seed('storageObject', {
    id: input.id,
    objectKey: `evidence/${input.id}/v1`,
    originalName: input.originalName ?? `${input.id}.jpg`,
    declaredMimeType: input.mimeType ?? 'image/jpeg',
    createdBy: input.createdBy,
    sha256: input.sha256 ?? null,
    status: input.status ?? 'ready',
  });
}

export function seedContact(fake: FakePrisma, input: { zohoContactId: string; paymentTerms?: number | null; name?: string }): Row {
  return fake.seed('contact', {
    zohoContactId: input.zohoContactId,
    contactName: input.name ?? input.zohoContactId,
    paymentTerms: input.paymentTerms ?? null,
  });
}

export interface SalesOrderCaseInput {
  caseId: string;
  zohoSalesOrderId: string;
  total: string;
  zohoCustomerId: string;
  orderDate: string;
  customerName?: string;
  salesOrderNumber?: string;
  status?: string;
  openedAt?: Date;
  currencyCode?: string;
}

let caseSeq = 0;

/** A case of a sales order plus the synced SalesOrder row it points to. */
export function seedSalesOrderCase(fake: FakePrisma, input: SalesOrderCaseInput): { case: Row; order: Row } {
  caseSeq += 1;
  const order = fake.seed('salesOrder', {
    zohoSalesOrderId: input.zohoSalesOrderId,
    salesOrderNumber: input.salesOrderNumber ?? `OV-${input.zohoSalesOrderId}`,
    orderDate: dbDate(input.orderDate),
    status: input.status ?? 'confirmed',
    zohoCustomerId: input.zohoCustomerId,
    customerName: input.customerName ?? `Cliente ${input.zohoCustomerId}`,
    currencyCode: input.currencyCode ?? 'MXN',
    total: D(input.total),
  });
  const operationalCase = fake.seed('operationalCase', {
    id: input.caseId,
    caseSeq: 1000 + caseSeq,
    caseNumber: `EXP-${1000 + caseSeq}`,
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: input.zohoSalesOrderId,
    zohoSalesOrderId: input.zohoSalesOrderId,
    salesOrderNumber: order.salesOrderNumber,
    customerName: order.customerName,
    zohoCustomerId: input.zohoCustomerId,
    processVersionId: 'pv1',
    ownerUserId: 'u-conta',
    openedAt: input.openedAt ?? new Date('2026-09-01T12:00:00.000Z'),
  });
  return { case: operationalCase, order };
}

export function seedCustomerPayment(
  fake: FakePrisma,
  input: {
    zohoPaymentId: string;
    amount: string;
    zohoCustomerId: string | null;
    date: string;
    paymentNumber?: string;
    customerName?: string;
    status?: string | null;
    currencyCode?: string;
  }
): Row {
  return fake.seed('customerPayment', {
    zohoPaymentId: input.zohoPaymentId,
    paymentNumber: input.paymentNumber ?? input.zohoPaymentId,
    amount: D(input.amount),
    zohoCustomerId: input.zohoCustomerId,
    customerName: input.customerName ?? (input.zohoCustomerId ? `Cliente ${input.zohoCustomerId}` : null),
    date: dbDate(input.date),
    status: input.status ?? null,
    currencyCode: input.currencyCode ?? 'MXN',
  });
}

export function makeJob<P>(payload: P, attempt = 1): JobContext<P> {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    type: 'test',
    payload,
    attempt,
    signal: new AbortController().signal,
    setProgress: async () => undefined,
    log: () => undefined,
  };
}

export function rowById(fake: FakePrisma, model: string, id: string): Row {
  const row = fake.rows(model).find((r) => r.id === id);
  if (!row) throw new Error(`No ${model} ${id}`);
  return row;
}

export function byKey(fake: FakePrisma, model: 'financeCategory' | 'cashAccount' | 'costCenter', key: string): Row {
  const row = fake.rows(model).find((r) => r.key === key);
  if (!row) throw new Error(`No ${model} ${key}`);
  return row;
}

/** Lines of an entry as [accountType, accountId, debit, credit, costCenterId]. */
export function linesOf(fake: FakePrisma, entryId: string): Array<[string, string, string, string, string | null]> {
  return fake
    .rows('ledgerLine')
    .filter((l) => l.entryId === entryId)
    .sort((a, b) => a.seq - b.seq)
    .map((l) => [l.accountType, l.accountId, D(l.debit).toFixed(2), D(l.credit).toFixed(2), l.costCenterId ?? null]);
}

export function eventsOf(fake: FakePrisma, type: string): Row[] {
  return fake.rows('operationalEvent').filter((e) => e.type === type);
}

export function aiAnswer(json: unknown): {
  content: string;
  finishReason: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  durationMs: number;
} {
  return {
    content: `Aquí va:\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``,
    finishReason: 'stop',
    promptTokens: 120,
    completionTokens: 60,
    totalTokens: 180,
    model: 'gpt-4o-mini',
    durationMs: 5,
  };
}

/** Same contract as documents-tools `parseJsonObject` (first JSON object of an answer). */
export function parseFirstJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('El modelo no devolvió JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}
