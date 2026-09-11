import { Prisma } from '@prisma/client';
import type {
  RelatedSalesOrderSummary,
  RelatedPaymentSummary,
  RelatedContactSummary,
} from '@/modules/cross-module/relationships-service';

interface InvoiceItemListRow {
  id: string; name: string | null; description: string | null;
  quantity: string | null; rate: string | null; unit: string | null; lineTotal: string | null;
  zohoSalesOrderId: string | null;
}

export interface InvoiceListRow {
  id: string; invoiceNumber: string | null; status: string | null;
  date: string | null; dueDate: string | null; customerName: string | null;
  total: string | null; balance: string | null; currencyCode: string | null;
  salesOrderStatus: string | null;
  sourceRemoteModifiedAt: string | null;
}

export interface InvoiceDetail {
  id: string; zohoInvoiceId: string; invoiceNumber: string | null; status: string | null;
  date: string | null; dueDate: string | null; zohoCustomerId: string | null;
  customerName: string | null; currencyCode: string | null;
  subTotal: string | null; taxTotal: string | null; discountTotal: string | null;
  shippingCharge: string | null; total: string | null; balance: string | null;
  salespersonName: string | null;
  cfdiUuid: string | null; cfdiVersion: string | null; usoCfdi: string | null;
  metodoPago: string | null; formaPago: string | null; regimenFiscal: string | null;
  cfdiExportacion: string | null;
  // Address fields
  billingAddress: string | null; billingCity: string | null; billingState: string | null;
  billingZip: string | null; billingCountry: string | null;
  shippingAddress: string | null; shippingCity: string | null; shippingState: string | null;
  shippingZip: string | null; shippingCountry: string | null;
  // Additional fields
  notes: string | null; terms: string | null; referenceNumber: string | null;
  exchangeRate: string | null; discount: string | null; discountType: string | null;
  isDiscountBeforeTax: boolean | null;
  zohoCreatedTime: string | null; zohoLastModifiedTime: string | null;
  sourceRemoteModifiedAt: string; sourceSnapshotId: string;
  normalizedAt: string; createdAt: string; updatedAt: string;
  items: InvoiceItemListRow[];
  /** Cross-module relations added by the API route. */
  relatedSalesOrders?: RelatedSalesOrderSummary[];
  relatedPayments?: RelatedPaymentSummary[];
  relatedContact?: RelatedContactSummary | null;
}

function dec(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function toInvoiceListRow(inv: {
  id: string; invoiceNumber: string | null; status: string | null;
  date: Date | null; dueDate: Date | null; customerName: string | null;
  total: Prisma.Decimal | null; balance: Prisma.Decimal | null; currencyCode: string | null;
  sourceRemoteModifiedAt: Date;
  salesOrderStatus?: string | null;
}): InvoiceListRow {
  return {
    id: inv.id, invoiceNumber: inv.invoiceNumber, status: inv.status,
    date: inv.date?.toISOString() ?? null, dueDate: inv.dueDate?.toISOString() ?? null,
    customerName: inv.customerName, total: dec(inv.total), balance: dec(inv.balance),
    currencyCode: inv.currencyCode, salesOrderStatus: inv.salesOrderStatus ?? null,
    sourceRemoteModifiedAt: inv.sourceRemoteModifiedAt.toISOString(),
  };
}

export function toInvoiceDetail(inv: {
  id: string; zohoInvoiceId: string; invoiceNumber: string | null; status: string | null;
  date: Date | null; dueDate: Date | null; zohoCustomerId: string | null;
  customerName: string | null; currencyCode: string | null;
  subTotal: Prisma.Decimal | null; taxTotal: Prisma.Decimal | null;
  discountTotal: Prisma.Decimal | null; shippingCharge: Prisma.Decimal | null;
  total: Prisma.Decimal | null; balance: Prisma.Decimal | null;
  salespersonName: string | null;
  cfdiUuid: string | null; cfdiVersion: string | null; usoCfdi: string | null;
  metodoPago: string | null; formaPago: string | null; regimenFiscal: string | null;
  cfdiExportacion: string | null;
  billingAddress: string | null; billingCity: string | null; billingState: string | null;
  billingZip: string | null; billingCountry: string | null;
  shippingAddress: string | null; shippingCity: string | null; shippingState: string | null;
  shippingZip: string | null; shippingCountry: string | null;
  notes: string | null; terms: string | null; referenceNumber: string | null;
  exchangeRate: Prisma.Decimal | null; discount: Prisma.Decimal | null; discountType: string | null;
  isDiscountBeforeTax: boolean | null;
  zohoCreatedTime: Date | null; zohoLastModifiedTime: Date | null;
  sourceRemoteModifiedAt: Date; sourceSnapshotId: string;
  normalizedAt: Date; createdAt: Date; updatedAt: Date;
  items?: { id: string; name: string | null; description: string | null; quantity: Prisma.Decimal | null; rate: Prisma.Decimal | null; unit: string | null; lineTotal: Prisma.Decimal | null; zohoSalesOrderId: string | null }[];
}): InvoiceDetail {
  return {
    id: inv.id, zohoInvoiceId: inv.zohoInvoiceId, invoiceNumber: inv.invoiceNumber,
    status: inv.status, date: inv.date?.toISOString() ?? null, dueDate: inv.dueDate?.toISOString() ?? null,
    zohoCustomerId: inv.zohoCustomerId, customerName: inv.customerName, currencyCode: inv.currencyCode,
    subTotal: dec(inv.subTotal), taxTotal: dec(inv.taxTotal), discountTotal: dec(inv.discountTotal),
    shippingCharge: dec(inv.shippingCharge), total: dec(inv.total), balance: dec(inv.balance),
    salespersonName: inv.salespersonName,
    cfdiUuid: inv.cfdiUuid, cfdiVersion: inv.cfdiVersion, usoCfdi: inv.usoCfdi,
    metodoPago: inv.metodoPago, formaPago: inv.formaPago, regimenFiscal: inv.regimenFiscal,
    cfdiExportacion: inv.cfdiExportacion,
    billingAddress: inv.billingAddress, billingCity: inv.billingCity, billingState: inv.billingState,
    billingZip: inv.billingZip, billingCountry: inv.billingCountry,
    shippingAddress: inv.shippingAddress, shippingCity: inv.shippingCity, shippingState: inv.shippingState,
    shippingZip: inv.shippingZip, shippingCountry: inv.shippingCountry,
    notes: inv.notes, terms: inv.terms, referenceNumber: inv.referenceNumber,
    exchangeRate: dec(inv.exchangeRate), discount: dec(inv.discount), discountType: inv.discountType,
    isDiscountBeforeTax: inv.isDiscountBeforeTax,
    zohoCreatedTime: inv.zohoCreatedTime?.toISOString() ?? null,
    zohoLastModifiedTime: inv.zohoLastModifiedTime?.toISOString() ?? null,
    sourceRemoteModifiedAt: inv.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: inv.sourceSnapshotId,
    normalizedAt: inv.normalizedAt.toISOString(), createdAt: inv.createdAt.toISOString(),
    updatedAt: inv.updatedAt.toISOString(),
    items: (inv.items ?? []).map((item) => ({
      id: item.id, name: item.name, description: item.description,
      quantity: dec(item.quantity), rate: dec(item.rate), unit: item.unit,
      lineTotal: dec(item.lineTotal), zohoSalesOrderId: item.zohoSalesOrderId,
    })),
  };
}
