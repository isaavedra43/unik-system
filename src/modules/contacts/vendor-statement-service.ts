import { prisma } from '@/lib/prisma';
import { BILLS_ENTITY_TYPE, getLatestBillsSyncRun } from '@/modules/integrations/zoho/bills-sync';
import { VENDOR_CREDITS_ENTITY_TYPE, getLatestVendorCreditsSyncRun } from '@/modules/integrations/zoho/vendor-credits-sync';
import { CURRENT_BILL_NORMALIZER_VERSION } from '@/modules/bills/bills-normalizer';
import { CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION } from '@/modules/vendor-credits/vendor-credits-normalizer';
import { buildVendorStatement, type StatementDocument, type StatementShow, type VendorStatement } from './vendor-statement';

/** Every bill and vendor credit of a vendor (linked by Zoho vendor id), oldest first. */
export async function loadVendorStatementDocuments(zohoVendorId: string): Promise<StatementDocument[]> {
  const [bills, credits] = await Promise.all([
    prisma.bill.findMany({
      where: { zohoVendorId },
      orderBy: { date: 'asc' },
      select: { id: true, billNumber: true, status: true, date: true, dueDate: true, total: true, balance: true, notes: true },
    }),
    prisma.vendorCredit.findMany({
      where: { zohoVendorId },
      orderBy: { date: 'asc' },
      select: { id: true, vendorCreditNumber: true, status: true, date: true, total: true, balance: true, notes: true },
    }),
  ]);
  return [
    ...bills.map<StatementDocument>((b) => ({
      id: b.id,
      kind: 'bill',
      number: b.billNumber,
      status: b.status,
      date: b.date?.toISOString() ?? null,
      dueDate: b.dueDate?.toISOString() ?? null,
      total: b.total?.toString() ?? null,
      balance: b.balance?.toString() ?? null,
      notes: b.notes,
      href: `/app/bills/${b.id}`,
    })),
    ...credits.map<StatementDocument>((c) => ({
      id: c.id,
      kind: 'credit',
      number: c.vendorCreditNumber,
      status: c.status,
      date: c.date?.toISOString() ?? null,
      dueDate: null,
      total: c.total?.toString() ?? null,
      balance: c.balance?.toString() ?? null,
      notes: c.notes,
      href: `/app/vendor-credits/${c.id}`,
    })),
  ];
}

export async function getVendorStatement(zohoVendorId: string, range: { from?: string | null; to?: string | null; show?: StatementShow }): Promise<VendorStatement> {
  return buildVendorStatement(await loadVendorStatementDocuments(zohoVendorId), range);
}

export interface StatementSyncInfo {
  lastCompletedAt: string | null;
  lastStatus: string | null;
  /** Snapshots downloaded from Zoho but not yet turned into documents. */
  pendingSnapshots: number;
  /** Snapshots that could not be normalized. */
  failedSnapshots: number;
}

export interface StatementSyncDiagnostics {
  bills: StatementSyncInfo;
  vendorCredits: StatementSyncInfo;
  /** Bills/credits with this vendor's name but a different or missing vendor id in Zoho. */
  unlinkedBills: number;
  unlinkedCredits: number;
}

async function syncInfo(entityType: string, version: number, latest: () => Promise<{ status: string; completedAt: Date | null } | null>): Promise<StatementSyncInfo> {
  const base = { source: 'zoho', entityType, normalizationVersion: { lt: version } };
  const [run, pending, failed] = await Promise.all([
    latest().catch(() => null),
    prisma.integrationSnapshot.count({ where: { ...base, normalizationErrorCode: null } }),
    prisma.integrationSnapshot.count({ where: { ...base, normalizationErrorCode: { not: null } } }),
  ]);
  return { lastCompletedAt: run?.completedAt?.toISOString() ?? null, lastStatus: run?.status ?? null, pendingSnapshots: pending, failedSnapshots: failed };
}

/** Why a document might be missing from the statement: sync backlog, failures, or documents not linked to this vendor id. */
export async function getStatementSyncDiagnostics(zohoVendorId: string, vendorName: string | null): Promise<StatementSyncDiagnostics> {
  const name = vendorName?.trim();
  const unlinkedWhere = name
    ? { vendorName: { equals: name, mode: 'insensitive' as const }, OR: [{ zohoVendorId: null }, { zohoVendorId: { not: zohoVendorId } }] }
    : null;
  const [bills, vendorCredits, unlinkedBills, unlinkedCredits] = await Promise.all([
    syncInfo(BILLS_ENTITY_TYPE, CURRENT_BILL_NORMALIZER_VERSION, getLatestBillsSyncRun),
    syncInfo(VENDOR_CREDITS_ENTITY_TYPE, CURRENT_VENDOR_CREDIT_NORMALIZER_VERSION, getLatestVendorCreditsSyncRun),
    unlinkedWhere ? prisma.bill.count({ where: unlinkedWhere }) : 0,
    unlinkedWhere ? prisma.vendorCredit.count({ where: unlinkedWhere }) : 0,
  ]);
  return { bills, vendorCredits, unlinkedBills, unlinkedCredits };
}
