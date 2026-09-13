import { Prisma } from '@prisma/client';
import type { RelatedContactSummary } from '@/modules/cross-module/relationships-service';

export interface QuoteItemRow {
  id: string;
  zohoLineItemId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  name: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  unit: string | null;
  discount: string | null;
  discountAmount: string | null;
  taxId: string | null;
  taxName: string | null;
  taxPercentage: string | null;
  taxAmount: string | null;
  lineTotal: string | null;
}

export interface QuoteListRow {
  id: string;
  estimateNumber: string | null;
  referenceNumber: string | null;
  status: string | null;
  date: string | null;
  expiryDate: string | null;
  customerName: string | null;
  salespersonName: string | null;
  total: string | null;
  currencyCode: string | null;
  createdInUnik: boolean;
  sourceRemoteModifiedAt: string | null;
}

export interface QuoteDetail {
  id: string;
  zohoEstimateId: string;
  estimateNumber: string | null;
  referenceNumber: string | null;
  status: string | null;
  date: string | null;
  expiryDate: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  currencyId: string | null;
  currencyCode: string | null;
  exchangeRate: string | null;
  subTotal: string | null;
  taxTotal: string | null;
  discountTotal: string | null;
  discount: string | null;
  discountType: string | null;
  isDiscountBeforeTax: boolean | null;
  isInclusiveTax: boolean | null;
  shippingCharge: string | null;
  adjustment: string | null;
  adjustmentDescription: string | null;
  total: string | null;
  salespersonId: string | null;
  salespersonName: string | null;
  templateId: string | null;
  templateName: string | null;
  billingAddress: string | null; billingStreet2: string | null; billingCity: string | null;
  billingState: string | null; billingZip: string | null; billingCountry: string | null;
  shippingAddress: string | null; shippingStreet2: string | null; shippingCity: string | null;
  shippingState: string | null; shippingZip: string | null; shippingCountry: string | null;
  notes: string | null;
  terms: string | null;
  customFields: unknown;
  isViewedByClient: boolean | null;
  acceptedDate: string | null;
  declinedDate: string | null;
  zohoCreatedTime: string | null;
  zohoLastModifiedTime: string | null;
  createdInUnik: boolean;
  createdByUserId: string | null;
  lastEditedByUserId: string | null;
  lastEditedInUnikAt: string | null;
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
  items: QuoteItemRow[];
  /** Cross-module relations added by the API route. */
  relatedContact?: RelatedContactSummary | null;
  changeEvents?: QuoteChangeEventRow[];
}

export interface QuoteChangeEventRow {
  id: string;
  changes: unknown;
  sourceRemoteModifiedAt: string | null;
  createdAt: string;
}

function dec(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function toQuoteListRow(q: {
  id: string; estimateNumber: string | null; referenceNumber: string | null; status: string | null;
  date: Date | null; expiryDate: Date | null; customerName: string | null; salespersonName: string | null;
  total: Prisma.Decimal | null; currencyCode: string | null; createdInUnik: boolean;
  sourceRemoteModifiedAt: Date;
}): QuoteListRow {
  return {
    id: q.id, estimateNumber: q.estimateNumber, referenceNumber: q.referenceNumber, status: q.status,
    date: iso(q.date), expiryDate: iso(q.expiryDate), customerName: q.customerName,
    salespersonName: q.salespersonName, total: dec(q.total), currencyCode: q.currencyCode,
    createdInUnik: q.createdInUnik, sourceRemoteModifiedAt: q.sourceRemoteModifiedAt.toISOString(),
  };
}

type QuoteItemModel = {
  id: string; zohoLineItemId: string | null; zohoItemId: string | null; sku: string | null;
  name: string | null; description: string | null; quantity: Prisma.Decimal | null;
  rate: Prisma.Decimal | null; unit: string | null; discount: string | null;
  discountAmount: Prisma.Decimal | null; taxId: string | null; taxName: string | null;
  taxPercentage: Prisma.Decimal | null; taxAmount: Prisma.Decimal | null; lineTotal: Prisma.Decimal | null;
};

export function toQuoteItemRow(item: QuoteItemModel): QuoteItemRow {
  return {
    id: item.id, zohoLineItemId: item.zohoLineItemId, zohoItemId: item.zohoItemId, sku: item.sku,
    name: item.name, description: item.description, quantity: dec(item.quantity), rate: dec(item.rate),
    unit: item.unit, discount: item.discount, discountAmount: dec(item.discountAmount), taxId: item.taxId,
    taxName: item.taxName, taxPercentage: dec(item.taxPercentage), taxAmount: dec(item.taxAmount),
    lineTotal: dec(item.lineTotal),
  };
}

export function toQuoteDetail(q: {
  id: string; zohoEstimateId: string; estimateNumber: string | null; referenceNumber: string | null;
  status: string | null; date: Date | null; expiryDate: Date | null; zohoCustomerId: string | null;
  customerName: string | null; currencyId: string | null; currencyCode: string | null;
  exchangeRate: Prisma.Decimal | null; subTotal: Prisma.Decimal | null; taxTotal: Prisma.Decimal | null;
  discountTotal: Prisma.Decimal | null; discount: Prisma.Decimal | null; discountType: string | null;
  isDiscountBeforeTax: boolean | null; isInclusiveTax: boolean | null; shippingCharge: Prisma.Decimal | null;
  adjustment: Prisma.Decimal | null; adjustmentDescription: string | null; total: Prisma.Decimal | null;
  salespersonId: string | null; salespersonName: string | null; templateId: string | null; templateName: string | null;
  billingAddress: string | null; billingStreet2: string | null; billingCity: string | null;
  billingState: string | null; billingZip: string | null; billingCountry: string | null;
  shippingAddress: string | null; shippingStreet2: string | null; shippingCity: string | null;
  shippingState: string | null; shippingZip: string | null; shippingCountry: string | null;
  notes: string | null; terms: string | null; customFields: Prisma.JsonValue | null;
  isViewedByClient: boolean | null; acceptedDate: Date | null; declinedDate: Date | null;
  zohoCreatedTime: Date | null; zohoLastModifiedTime: Date | null;
  createdInUnik: boolean; createdByUserId: string | null; lastEditedByUserId: string | null;
  lastEditedInUnikAt: Date | null;
  sourceRemoteModifiedAt: Date; sourceSnapshotId: string; normalizedAt: Date; createdAt: Date; updatedAt: Date;
  items?: QuoteItemModel[];
}): QuoteDetail {
  return {
    id: q.id, zohoEstimateId: q.zohoEstimateId, estimateNumber: q.estimateNumber, referenceNumber: q.referenceNumber,
    status: q.status, date: iso(q.date), expiryDate: iso(q.expiryDate), zohoCustomerId: q.zohoCustomerId,
    customerName: q.customerName, currencyId: q.currencyId, currencyCode: q.currencyCode,
    exchangeRate: dec(q.exchangeRate), subTotal: dec(q.subTotal), taxTotal: dec(q.taxTotal),
    discountTotal: dec(q.discountTotal), discount: dec(q.discount), discountType: q.discountType,
    isDiscountBeforeTax: q.isDiscountBeforeTax, isInclusiveTax: q.isInclusiveTax,
    shippingCharge: dec(q.shippingCharge), adjustment: dec(q.adjustment), adjustmentDescription: q.adjustmentDescription,
    total: dec(q.total), salespersonId: q.salespersonId, salespersonName: q.salespersonName,
    templateId: q.templateId, templateName: q.templateName,
    billingAddress: q.billingAddress, billingStreet2: q.billingStreet2, billingCity: q.billingCity,
    billingState: q.billingState, billingZip: q.billingZip, billingCountry: q.billingCountry,
    shippingAddress: q.shippingAddress, shippingStreet2: q.shippingStreet2, shippingCity: q.shippingCity,
    shippingState: q.shippingState, shippingZip: q.shippingZip, shippingCountry: q.shippingCountry,
    notes: q.notes, terms: q.terms, customFields: q.customFields ?? null,
    isViewedByClient: q.isViewedByClient, acceptedDate: iso(q.acceptedDate), declinedDate: iso(q.declinedDate),
    zohoCreatedTime: iso(q.zohoCreatedTime), zohoLastModifiedTime: iso(q.zohoLastModifiedTime),
    createdInUnik: q.createdInUnik, createdByUserId: q.createdByUserId, lastEditedByUserId: q.lastEditedByUserId,
    lastEditedInUnikAt: iso(q.lastEditedInUnikAt),
    sourceRemoteModifiedAt: q.sourceRemoteModifiedAt.toISOString(), sourceSnapshotId: q.sourceSnapshotId,
    normalizedAt: q.normalizedAt.toISOString(), createdAt: q.createdAt.toISOString(), updatedAt: q.updatedAt.toISOString(),
    items: (q.items ?? []).map(toQuoteItemRow),
  };
}
