import { Prisma } from '@prisma/client';
import type {
  RelatedContactSummary,
  RelatedBillSummary,
} from '@/modules/cross-module/relationships-service';

export interface VendorCreditListRow {
  id: string;
  vendorCreditNumber: string | null;
  status: string | null;
  date: string | null;
  vendorName: string | null;
  total: string | null;
  balance: string | null;
  currencyCode: string | null;
  sourceRemoteModifiedAt: string | null;
}

export interface VendorCreditDetail {
  id: string;
  zohoVendorCreditId: string;
  vendorCreditNumber: string | null;
  status: string | null;
  date: string | null;
  zohoVendorId: string | null;
  vendorName: string | null;
  currencyCode: string | null;
  total: string | null;
  balance: string | null;
  notes: string | null;
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Cross-module relations added by the API route. */
  relatedContact?: RelatedContactSummary | null;
  relatedBills?: RelatedBillSummary[];
}

function dec(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function toVendorCreditListRow(vc: {
  id: string;
  vendorCreditNumber: string | null;
  status: string | null;
  date: Date | null;
  vendorName: string | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  currencyCode: string | null;
  sourceRemoteModifiedAt: Date;
}): VendorCreditListRow {
  return {
    id: vc.id,
    vendorCreditNumber: vc.vendorCreditNumber,
    status: vc.status,
    date: vc.date?.toISOString() ?? null,
    vendorName: vc.vendorName,
    total: dec(vc.total),
    balance: dec(vc.balance),
    currencyCode: vc.currencyCode,
    sourceRemoteModifiedAt: vc.sourceRemoteModifiedAt.toISOString(),
  };
}

export function toVendorCreditDetail(vc: {
  id: string;
  zohoVendorCreditId: string;
  vendorCreditNumber: string | null;
  status: string | null;
  date: Date | null;
  zohoVendorId: string | null;
  vendorName: string | null;
  currencyCode: string | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  notes: string | null;
  sourceRemoteModifiedAt: Date;
  sourceSnapshotId: string;
  normalizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): VendorCreditDetail {
  return {
    id: vc.id,
    zohoVendorCreditId: vc.zohoVendorCreditId,
    vendorCreditNumber: vc.vendorCreditNumber,
    status: vc.status,
    date: vc.date?.toISOString() ?? null,
    zohoVendorId: vc.zohoVendorId,
    vendorName: vc.vendorName,
    currencyCode: vc.currencyCode,
    total: dec(vc.total),
    balance: dec(vc.balance),
    notes: vc.notes,
    sourceRemoteModifiedAt: vc.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: vc.sourceSnapshotId,
    normalizedAt: vc.normalizedAt.toISOString(),
    createdAt: vc.createdAt.toISOString(),
    updatedAt: vc.updatedAt.toISOString(),
  };
}
