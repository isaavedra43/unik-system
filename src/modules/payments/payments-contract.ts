import { Prisma } from '@prisma/client';
import type {
  RelatedInvoiceSummary,
  RelatedSalesOrderSummary,
  RelatedContactSummary,
} from '@/modules/cross-module/relationships-service';

export interface PaymentListRow {
  id: string;
  paymentNumber: string | null;
  paymentMode: string | null;
  status: string | null;
  date: string | null;
  amount: string | null;
  balance: string | null;
  customerName: string | null;
  currencyCode: string | null;
  sourceRemoteModifiedAt: string | null;
}

export interface PaymentDetail {
  id: string;
  zohoPaymentId: string;
  paymentNumber: string | null;
  paymentMode: string | null;
  status: string | null;
  date: string | null;
  amount: string | null;
  balance: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  currencyCode: string | null;
  referenceNumber: string | null;
  description: string | null;
  exchangeRate: string | null;
  bankCharges: string | null;
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Cross-module relations added by the API route. */
  relatedContact?: RelatedContactSummary | null;
  relatedInvoices?: RelatedInvoiceSummary[];
  relatedSalesOrders?: RelatedSalesOrderSummary[];
}

function dec(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function toPaymentListRow(p: {
  id: string;
  paymentNumber: string | null;
  paymentMode: string | null;
  status: string | null;
  date: Date | null;
  amount: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  customerName: string | null;
  currencyCode: string | null;
  sourceRemoteModifiedAt: Date;
}): PaymentListRow {
  return {
    id: p.id,
    paymentNumber: p.paymentNumber,
    paymentMode: p.paymentMode,
    status: p.status,
    date: p.date?.toISOString() ?? null,
    amount: dec(p.amount),
    balance: dec(p.balance),
    customerName: p.customerName,
    currencyCode: p.currencyCode,
    sourceRemoteModifiedAt: p.sourceRemoteModifiedAt.toISOString(),
  };
}

export function toPaymentDetail(p: {
  id: string;
  zohoPaymentId: string;
  paymentNumber: string | null;
  paymentMode: string | null;
  status: string | null;
  date: Date | null;
  amount: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  currencyCode: string | null;
  referenceNumber: string | null;
  description: string | null;
  exchangeRate: Prisma.Decimal | null;
  bankCharges: Prisma.Decimal | null;
  sourceRemoteModifiedAt: Date;
  sourceSnapshotId: string;
  normalizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): PaymentDetail {
  return {
    id: p.id,
    zohoPaymentId: p.zohoPaymentId,
    paymentNumber: p.paymentNumber,
    paymentMode: p.paymentMode,
    status: p.status,
    date: p.date?.toISOString() ?? null,
    amount: dec(p.amount),
    balance: dec(p.balance),
    zohoCustomerId: p.zohoCustomerId,
    customerName: p.customerName,
    currencyCode: p.currencyCode,
    referenceNumber: p.referenceNumber,
    description: p.description,
    exchangeRate: dec(p.exchangeRate),
    bankCharges: dec(p.bankCharges),
    sourceRemoteModifiedAt: p.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: p.sourceSnapshotId,
    normalizedAt: p.normalizedAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
