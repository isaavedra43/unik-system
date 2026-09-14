import { prisma } from '@/lib/prisma';
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
