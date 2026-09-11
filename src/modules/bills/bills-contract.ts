import { Prisma } from '@prisma/client';
import type {
  RelatedPurchaseOrderDetail,
  RelatedContactSummary,
  RelatedVendorCreditSummary,
} from '@/modules/cross-module/relationships-service';

export interface BillListRow {
  id: string;
  billNumber: string | null;
  status: string | null;
  date: string | null;
  dueDate: string | null;
  vendorName: string | null;
  total: string | null;
  balance: string | null;
  currencyCode: string | null;
  purchaseOrderStatus: string | null;
  sourceRemoteModifiedAt: string | null;
}

export interface BillDetail {
  id: string;
  zohoBillId: string;
  billNumber: string | null;
  status: string | null;
  date: string | null;
  dueDate: string | null;
  zohoVendorId: string | null;
  vendorName: string | null;
  zohoPurchaseOrderId: string | null;
  currencyCode: string | null;
  subTotal: string | null;
  taxTotal: string | null;
  total: string | null;
  balance: string | null;
  vendorCreditsApplied: string | null;
  notes: string | null;
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Cross-module relations added by the API route. */
  relatedPurchaseOrder?: RelatedPurchaseOrderDetail | null;
  relatedContact?: RelatedContactSummary | null;
  relatedVendorCredits?: RelatedVendorCreditSummary[];
}

function dec(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function toBillListRow(b: {
  id: string;
  billNumber: string | null;
  status: string | null;
  date: Date | null;
  dueDate: Date | null;
  vendorName: string | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  currencyCode: string | null;
  sourceRemoteModifiedAt: Date;
  purchaseOrderStatus?: string | null;
}): BillListRow {
  return {
    id: b.id,
    billNumber: b.billNumber,
    status: b.status,
    date: b.date?.toISOString() ?? null,
    dueDate: b.dueDate?.toISOString() ?? null,
    vendorName: b.vendorName,
    total: dec(b.total),
    balance: dec(b.balance),
    currencyCode: b.currencyCode,
    purchaseOrderStatus: b.purchaseOrderStatus ?? null,
    sourceRemoteModifiedAt: b.sourceRemoteModifiedAt.toISOString(),
  };
}

export function toBillDetail(b: {
  id: string;
  zohoBillId: string;
  billNumber: string | null;
  status: string | null;
  date: Date | null;
  dueDate: Date | null;
  zohoVendorId: string | null;
  vendorName: string | null;
  zohoPurchaseOrderId: string | null;
  currencyCode: string | null;
  subTotal: Prisma.Decimal | null;
  taxTotal: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  vendorCreditsApplied: Prisma.Decimal | null;
  notes: string | null;
  sourceRemoteModifiedAt: Date;
  sourceSnapshotId: string;
  normalizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): BillDetail {
  return {
    id: b.id,
    zohoBillId: b.zohoBillId,
    billNumber: b.billNumber,
    status: b.status,
    date: b.date?.toISOString() ?? null,
    dueDate: b.dueDate?.toISOString() ?? null,
    zohoVendorId: b.zohoVendorId,
    vendorName: b.vendorName,
    zohoPurchaseOrderId: b.zohoPurchaseOrderId,
    currencyCode: b.currencyCode,
    subTotal: dec(b.subTotal),
    taxTotal: dec(b.taxTotal),
    total: dec(b.total),
    balance: dec(b.balance),
    vendorCreditsApplied: dec(b.vendorCreditsApplied),
    notes: b.notes,
    sourceRemoteModifiedAt: b.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: b.sourceSnapshotId,
    normalizedAt: b.normalizedAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}
