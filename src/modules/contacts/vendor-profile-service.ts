import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  NON_COUNTABLE_STATUSES,
  PURCHASE_ORDER_OPEN_STATUSES,
  type VendorTransactionType,
} from './vendor-profile-helpers';

/**
 * Vendor profile: exact totals and history of a vendor's purchase orders, bills and vendor credits.
 *
 * Documents are linked ONLY by the Zoho vendor id (`zohoVendorId === contact.zohoContactId`), never
 * by name. Documents carrying the vendor's name but another/no vendor id are counted separately
 * (`unlinked`) so a broken link is visible instead of silently hiding or inflating history.
 */

export type { VendorTransactionType } from './vendor-profile-helpers';

export interface StatusCount {
  status: string | null;
  count: number;
}

export interface VendorTransactionRow {
  id: string;
  type: VendorTransactionType;
  number: string | null;
  status: string | null;
  date: string | null;
  dueDate: string | null;
  total: string | null;
  balance: string | null;
  currencyCode: string | null;
  reference: string | null;
  purchaseOrder: { id: string; number: string | null } | null;
  href: string;
}

export interface VendorProfile {
  zohoVendorId: string;
  purchaseOrders: { count: number; openCount: number; totalAmount: string; lastDate: string | null; statuses: StatusCount[] } | null;
  bills: { count: number; unpaidCount: number; unpaidBalance: string; overdueCount: number; overdueBalance: string; lastDate: string | null; statuses: StatusCount[] } | null;
  vendorCredits: { count: number; openCount: number; openBalance: string; lastDate: string | null; statuses: StatusCount[] } | null;
  products: number;
  recentPurchaseOrders: VendorTransactionRow[];
  recentVendorCredits: VendorTransactionRow[];
  unpaidBills: VendorTransactionRow[];
  unlinked: { purchaseOrders: number; bills: number; vendorCredits: number };
}

export interface VendorProfileAccess {
  purchaseOrders: boolean;
  bills: boolean;
  vendorCredits: boolean;
}

const countableStatus = { OR: [{ status: null }, { status: { notIn: NON_COUNTABLE_STATUSES } }] };

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const dec = (d: Prisma.Decimal | null | undefined) => d?.toString() ?? null;

function statusCounts(rows: Array<{ status: string | null; _count: { _all: number } }>): StatusCount[] {
  return rows.map((r) => ({ status: r.status, count: r._count._all })).sort((a, b) => b.count - a.count);
}

/** Same vendor name, but a different or missing vendor id. */
function unlinkedWhere(zohoVendorId: string, vendorName: string | null) {
  if (!vendorName?.trim()) return null;
  return {
    vendorName: { equals: vendorName.trim(), mode: 'insensitive' as const },
    OR: [{ zohoVendorId: null }, { zohoVendorId: { not: zohoVendorId } }],
  };
}

type PurchaseOrderRecord = { id: string; purchaseOrderNumber: string | null; status: string | null; date: Date | null; deliveryDate: Date | null; total: Prisma.Decimal | null; balance: Prisma.Decimal | null; currencyCode: string | null; referenceNumber: string | null };
type BillRecord = { id: string; billNumber: string | null; status: string | null; date: Date | null; dueDate: Date | null; total: Prisma.Decimal | null; balance: Prisma.Decimal | null; currencyCode: string | null; zohoPurchaseOrderId: string | null };
type VendorCreditRecord = { id: string; vendorCreditNumber: string | null; status: string | null; date: Date | null; total: Prisma.Decimal | null; balance: Prisma.Decimal | null; currencyCode: string | null };

const PO_SELECT = { id: true, purchaseOrderNumber: true, status: true, date: true, deliveryDate: true, total: true, balance: true, currencyCode: true, referenceNumber: true } as const;
const BILL_SELECT = { id: true, billNumber: true, status: true, date: true, dueDate: true, total: true, balance: true, currencyCode: true, zohoPurchaseOrderId: true } as const;
const VC_SELECT = { id: true, vendorCreditNumber: true, status: true, date: true, total: true, balance: true, currencyCode: true } as const;

function purchaseOrderRow(po: PurchaseOrderRecord): VendorTransactionRow {
  return {
    id: po.id,
    type: 'purchase_orders',
    number: po.purchaseOrderNumber,
    status: po.status,
    date: iso(po.date),
    dueDate: iso(po.deliveryDate),
    total: dec(po.total),
    balance: dec(po.balance),
    currencyCode: po.currencyCode,
    reference: po.referenceNumber,
    purchaseOrder: null,
    href: `/app/purchase-orders/${po.id}`,
  };
}

async function billRows(bills: BillRecord[]): Promise<VendorTransactionRow[]> {
  const poIds = [...new Set(bills.map((b) => b.zohoPurchaseOrderId).filter((v): v is string => Boolean(v)))];
  const pos = poIds.length
    ? await prisma.purchaseOrder.findMany({ where: { zohoPurchaseOrderId: { in: poIds } }, select: { id: true, zohoPurchaseOrderId: true, purchaseOrderNumber: true } })
    : [];
  const poByZohoId = new Map(pos.map((p) => [p.zohoPurchaseOrderId, p]));
  return bills.map((b) => {
    const po = b.zohoPurchaseOrderId ? poByZohoId.get(b.zohoPurchaseOrderId) : undefined;
    return {
      id: b.id,
      type: 'bills',
      number: b.billNumber,
      status: b.status,
      date: iso(b.date),
      dueDate: iso(b.dueDate),
      total: dec(b.total),
      balance: dec(b.balance),
      currencyCode: b.currencyCode,
      reference: null,
      purchaseOrder: po ? { id: po.id, number: po.purchaseOrderNumber } : null,
      href: `/app/bills/${b.id}`,
    };
  });
}

function vendorCreditRow(vc: VendorCreditRecord): VendorTransactionRow {
  return {
    id: vc.id,
    type: 'vendor_credits',
    number: vc.vendorCreditNumber,
    status: vc.status,
    date: iso(vc.date),
    dueDate: null,
    total: dec(vc.total),
    balance: dec(vc.balance),
    currencyCode: vc.currencyCode,
    reference: null,
    purchaseOrder: null,
    href: `/app/vendor-credits/${vc.id}`,
  };
}

export async function getVendorProfile(
  vendor: { zohoContactId: string; contactName: string | null },
  options: { recent?: number; access?: VendorProfileAccess } = {}
): Promise<VendorProfile> {
  const vid = vendor.zohoContactId;
  const recent = Math.max(1, Math.min(options.recent ?? 8, 20));
  const access = options.access ?? { purchaseOrders: true, bills: true, vendorCredits: true };
  const byVendor = { zohoVendorId: vid };
  const unlinked = unlinkedWhere(vid, vendor.contactName);

  const [purchaseOrders, bills, vendorCredits, products] = await Promise.all([
    access.purchaseOrders
      ? Promise.all([
          prisma.purchaseOrder.aggregate({ where: byVendor, _count: { _all: true }, _max: { date: true } }),
          prisma.purchaseOrder.aggregate({ where: { ...byVendor, ...countableStatus }, _sum: { total: true } }),
          prisma.purchaseOrder.count({ where: { ...byVendor, status: { in: PURCHASE_ORDER_OPEN_STATUSES } } }),
          prisma.purchaseOrder.groupBy({ by: ['status'], where: byVendor, _count: { _all: true } }),
          prisma.purchaseOrder.findMany({ where: byVendor, orderBy: [{ date: 'desc' }, { purchaseOrderNumber: 'desc' }], take: recent, select: PO_SELECT }),
          unlinked ? prisma.purchaseOrder.count({ where: unlinked }) : Promise.resolve(0),
        ])
      : null,
    access.bills
      ? Promise.all([
          prisma.bill.aggregate({ where: byVendor, _count: { _all: true }, _max: { date: true } }),
          prisma.bill.aggregate({ where: { ...byVendor, ...countableStatus, balance: { gt: 0 } }, _count: { _all: true }, _sum: { balance: true } }),
          prisma.bill.aggregate({ where: { ...byVendor, status: 'overdue' }, _count: { _all: true }, _sum: { balance: true } }),
          prisma.bill.groupBy({ by: ['status'], where: byVendor, _count: { _all: true } }),
          prisma.bill.findMany({ where: { ...byVendor, ...countableStatus, balance: { gt: 0 } }, orderBy: [{ dueDate: 'asc' }, { date: 'asc' }], take: recent, select: BILL_SELECT }),
          unlinked ? prisma.bill.count({ where: unlinked }) : Promise.resolve(0),
        ])
      : null,
    access.vendorCredits
      ? Promise.all([
          prisma.vendorCredit.aggregate({ where: byVendor, _count: { _all: true }, _max: { date: true } }),
          prisma.vendorCredit.aggregate({ where: { ...byVendor, ...countableStatus, balance: { gt: 0 } }, _count: { _all: true }, _sum: { balance: true } }),
          prisma.vendorCredit.groupBy({ by: ['status'], where: byVendor, _count: { _all: true } }),
          prisma.vendorCredit.findMany({ where: byVendor, orderBy: [{ date: 'desc' }, { vendorCreditNumber: 'desc' }], take: recent, select: VC_SELECT }),
          unlinked ? prisma.vendorCredit.count({ where: unlinked }) : Promise.resolve(0),
        ])
      : null,
    prisma.product.count({ where: { zohoVendorId: vid } }).catch(() => 0),
  ]);

  return {
    zohoVendorId: vid,
    purchaseOrders: purchaseOrders
      ? {
          count: purchaseOrders[0]._count._all,
          openCount: purchaseOrders[2],
          totalAmount: purchaseOrders[1]._sum.total?.toString() ?? '0',
          lastDate: iso(purchaseOrders[0]._max.date),
          statuses: statusCounts(purchaseOrders[3]),
        }
      : null,
    bills: bills
      ? {
          count: bills[0]._count._all,
          unpaidCount: bills[1]._count._all,
          unpaidBalance: bills[1]._sum.balance?.toString() ?? '0',
          overdueCount: bills[2]._count._all,
          overdueBalance: bills[2]._sum.balance?.toString() ?? '0',
          lastDate: iso(bills[0]._max.date),
          statuses: statusCounts(bills[3]),
        }
      : null,
    vendorCredits: vendorCredits
      ? {
          count: vendorCredits[0]._count._all,
          openCount: vendorCredits[1]._count._all,
          openBalance: vendorCredits[1]._sum.balance?.toString() ?? '0',
          lastDate: iso(vendorCredits[0]._max.date),
          statuses: statusCounts(vendorCredits[2]),
        }
      : null,
    products,
    recentPurchaseOrders: purchaseOrders ? purchaseOrders[4].map(purchaseOrderRow) : [],
    recentVendorCredits: vendorCredits ? vendorCredits[3].map(vendorCreditRow) : [],
    unpaidBills: bills ? await billRows(bills[4]) : [],
    unlinked: {
      purchaseOrders: purchaseOrders ? purchaseOrders[5] : 0,
      bills: bills ? bills[5] : 0,
      vendorCredits: vendorCredits ? vendorCredits[4] : 0,
    },
  };
}

/** Full, paginated history of one document type for a vendor (newest first), optionally by status. */
export async function listVendorTransactions(
  zohoVendorId: string,
  type: VendorTransactionType,
  options: { page: number; pageSize: number; status?: string | null }
): Promise<{ rows: VendorTransactionRow[]; total: number; page: number; pageSize: number }> {
  const where = { zohoVendorId, ...(options.status ? { status: options.status } : {}) };
  const skip = (options.page - 1) * options.pageSize;
  const take = options.pageSize;

  if (type === 'purchase_orders') {
    const [total, rows] = await Promise.all([
      prisma.purchaseOrder.count({ where }),
      prisma.purchaseOrder.findMany({ where, orderBy: [{ date: 'desc' }, { purchaseOrderNumber: 'desc' }], skip, take, select: PO_SELECT }),
    ]);
    return { rows: rows.map(purchaseOrderRow), total, page: options.page, pageSize: take };
  }
  if (type === 'bills') {
    const [total, rows] = await Promise.all([
      prisma.bill.count({ where }),
      prisma.bill.findMany({ where, orderBy: [{ date: 'desc' }, { billNumber: 'desc' }], skip, take, select: BILL_SELECT }),
    ]);
    return { rows: await billRows(rows), total, page: options.page, pageSize: take };
  }
  const [total, rows] = await Promise.all([
    prisma.vendorCredit.count({ where }),
    prisma.vendorCredit.findMany({ where, orderBy: [{ date: 'desc' }, { vendorCreditNumber: 'desc' }], skip, take, select: VC_SELECT }),
  ]);
  return { rows: rows.map(vendorCreditRow), total, page: options.page, pageSize: take };
}
