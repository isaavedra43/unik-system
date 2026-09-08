import { Prisma } from '@prisma/client';

/**
 * Canonical camelCase DTOs for the Sales Orders workspace and detail pages.
 *
 * These are the ONLY shapes exposed to the UI. Server-side mappers convert Prisma
 * results into these DTOs. The legacy `/api/internal/sales-orders` route keeps
 * its snake_case contract and is NOT changed.
 */

export interface SalesOrderListRow {
  id: string;
  orderDate: string | null;
  salesOrderNumber: string | null;
  referenceNumber: string | null;
  customerName: string | null;
  customerPhone: string | null;
  salespersonName: string | null;
  status: string | null;
  subStatus: string | null;
  paidStatus: string | null;
  invoicedStatus: string | null;
  shippedStatus: string | null;
  paymentMethod: string | null;
  deliveryMethod: string | null;
  locationName: string | null;
  branchName: string | null;
  currencyCode: string | null;
  subtotal: string | null;
  discountTotal: string | null;
  taxTotal: string | null;
  shippingCharge: string | null;
  adjustment: string | null;
  total: string | null;
  balance: string | null;
  saleMadeInWarehouse: boolean | null;
  sourceRemoteModifiedAt: string | null;
  shippingAddress: string | null;
}

export interface SalesOrderDetailItem {
  id: string;
  zohoLineItemId: string | null;
  zohoItemId: string | null;
  sku: string | null;
  name: string | null;
  description: string | null;
  quantity: string | null;
  unit: string | null;
  rate: string | null;
  discountAmount: string | null;
  taxName: string | null;
  taxPercentage: string | null;
  taxAmount: string | null;
  lineTotal: string | null;
  locationId: string | null;
  locationName: string | null;
  sortOrder: number;
}

export interface SalesOrderDetail {
  id: string;
  zohoSalesOrderId: string;
  salesOrderNumber: string | null;
  referenceNumber: string | null;
  orderDate: string | null;
  createdTime: string | null;
  status: string | null;
  subStatus: string | null;
  paidStatus: string | null;
  invoicedStatus: string | null;
  shippedStatus: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  zohoSalespersonId: string | null;
  salespersonName: string | null;
  paymentMethod: string | null;
  deliveryMethod: string | null;
  deliveryMethodId: string | null;
  locationId: string | null;
  locationName: string | null;
  branchId: string | null;
  branchName: string | null;
  shippingAttention: string | null;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingPostalCode: string | null;
  shippingCountry: string | null;
  shippingPhone: string | null;
  currencyCode: string | null;
  subtotal: string | null;
  discountTotal: string | null;
  taxTotal: string | null;
  shippingCharge: string | null;
  adjustment: string | null;
  total: string | null;
  balance: string | null;
  notes: string | null;
  saleMadeInWarehouse: boolean | null;
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
  items: SalesOrderDetailItem[];
  /** Added by the preview drawer API route. */
  change_events?: {
    id: string;
    changes: unknown;
    sourceRemoteModifiedAt: string | null;
    createdAt: string;
  }[];
}

function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

function dateToIsoDateOnly(value: Date | null | undefined): string | null {
  if (!value) return null;
  const y = value.getUTCFullYear();
  const m = String(value.getUTCMonth() + 1).padStart(2, '0');
  const d = String(value.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toSalesOrderListRow(order: {
  id: string;
  salesOrderNumber: string | null;
  referenceNumber: string | null;
  orderDate: Date | null;
  customerName: string | null;
  customerPhone: string | null;
  salespersonName: string | null;
  paymentMethod: string | null;
  deliveryMethod: string | null;
  locationName: string | null;
  branchName: string | null;
  status: string | null;
  subStatus: string | null;
  paidStatus: string | null;
  invoicedStatus: string | null;
  shippedStatus: string | null;
  currencyCode: string | null;
  subtotal: Prisma.Decimal | null;
  discountTotal: Prisma.Decimal | null;
  taxTotal: Prisma.Decimal | null;
  shippingCharge: Prisma.Decimal | null;
  adjustment: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  saleMadeInWarehouse: boolean | null;
  sourceRemoteModifiedAt: Date;
  shippingAddressLine1: string | null;
  shippingAddressLine2: string | null;
}): SalesOrderListRow {
  return {
    id: order.id,
    salesOrderNumber: order.salesOrderNumber,
    referenceNumber: order.referenceNumber,
    orderDate: dateToIsoDateOnly(order.orderDate),
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    salespersonName: order.salespersonName,
    paymentMethod: order.paymentMethod,
    deliveryMethod: order.deliveryMethod,
    locationName: order.locationName,
    branchName: order.branchName,
    status: order.status,
    subStatus: order.subStatus,
    paidStatus: order.paidStatus,
    invoicedStatus: order.invoicedStatus,
    shippedStatus: order.shippedStatus,
    currencyCode: order.currencyCode,
    subtotal: decimalToString(order.subtotal),
    discountTotal: decimalToString(order.discountTotal),
    taxTotal: decimalToString(order.taxTotal),
    shippingCharge: decimalToString(order.shippingCharge),
    adjustment: decimalToString(order.adjustment),
    total: decimalToString(order.total),
    balance: decimalToString(order.balance),
    saleMadeInWarehouse: order.saleMadeInWarehouse,
    sourceRemoteModifiedAt: order.sourceRemoteModifiedAt.toISOString(),
    shippingAddress:
      [order.shippingAddressLine1, order.shippingAddressLine2]
        .filter(Boolean)
        .join(', ') || null,
  };
}

export function toSalesOrderDetail(
  order: {
    id: string;
    zohoSalesOrderId: string;
    salesOrderNumber: string | null;
    referenceNumber: string | null;
    orderDate: Date | null;
    createdTime: Date | null;
    status: string | null;
    subStatus: string | null;
    paidStatus: string | null;
    invoicedStatus: string | null;
    shippedStatus: string | null;
    zohoCustomerId: string | null;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    zohoSalespersonId: string | null;
    salespersonName: string | null;
    paymentMethod: string | null;
    deliveryMethod: string | null;
    deliveryMethodId: string | null;
    locationId: string | null;
    locationName: string | null;
    branchId: string | null;
    branchName: string | null;
    shippingAttention: string | null;
    shippingAddressLine1: string | null;
    shippingAddressLine2: string | null;
    shippingCity: string | null;
    shippingState: string | null;
    shippingPostalCode: string | null;
    shippingCountry: string | null;
    shippingPhone: string | null;
    currencyCode: string | null;
    subtotal: Prisma.Decimal | null;
    discountTotal: Prisma.Decimal | null;
    taxTotal: Prisma.Decimal | null;
    shippingCharge: Prisma.Decimal | null;
    adjustment: Prisma.Decimal | null;
    total: Prisma.Decimal | null;
    balance: Prisma.Decimal | null;
    notes: string | null;
    saleMadeInWarehouse: boolean | null;
    sourceRemoteModifiedAt: Date;
    sourceSnapshotId: string;
    normalizedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  },
  items: {
    id: string;
    zohoLineItemId: string | null;
    zohoItemId: string | null;
    sku: string | null;
    name: string | null;
    description: string | null;
    quantity: Prisma.Decimal | null;
    unit: string | null;
    rate: Prisma.Decimal | null;
    discountAmount: Prisma.Decimal | null;
    taxName: string | null;
    taxPercentage: Prisma.Decimal | null;
    taxAmount: Prisma.Decimal | null;
    lineTotal: Prisma.Decimal | null;
    locationId: string | null;
    locationName: string | null;
    sortOrder: number;
  }[]
): SalesOrderDetail {
  return {
    id: order.id,
    zohoSalesOrderId: order.zohoSalesOrderId,
    salesOrderNumber: order.salesOrderNumber,
    referenceNumber: order.referenceNumber,
    orderDate: dateToIsoDateOnly(order.orderDate),
    createdTime: order.createdTime?.toISOString() ?? null,
    status: order.status,
    subStatus: order.subStatus,
    paidStatus: order.paidStatus,
    invoicedStatus: order.invoicedStatus,
    shippedStatus: order.shippedStatus,
    zohoCustomerId: order.zohoCustomerId,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    zohoSalespersonId: order.zohoSalespersonId,
    salespersonName: order.salespersonName,
    paymentMethod: order.paymentMethod,
    deliveryMethod: order.deliveryMethod,
    deliveryMethodId: order.deliveryMethodId,
    locationId: order.locationId,
    locationName: order.locationName,
    branchId: order.branchId,
    branchName: order.branchName,
    shippingAttention: order.shippingAttention,
    shippingAddressLine1: order.shippingAddressLine1,
    shippingAddressLine2: order.shippingAddressLine2,
    shippingCity: order.shippingCity,
    shippingState: order.shippingState,
    shippingPostalCode: order.shippingPostalCode,
    shippingCountry: order.shippingCountry,
    shippingPhone: order.shippingPhone,
    currencyCode: order.currencyCode,
    subtotal: decimalToString(order.subtotal),
    discountTotal: decimalToString(order.discountTotal),
    taxTotal: decimalToString(order.taxTotal),
    shippingCharge: decimalToString(order.shippingCharge),
    adjustment: decimalToString(order.adjustment),
    total: decimalToString(order.total),
    balance: decimalToString(order.balance),
    notes: order.notes,
    saleMadeInWarehouse: order.saleMadeInWarehouse,
    sourceRemoteModifiedAt: order.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: order.sourceSnapshotId,
    normalizedAt: order.normalizedAt.toISOString(),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: items.map((item) => ({
      id: item.id,
      zohoLineItemId: item.zohoLineItemId,
      zohoItemId: item.zohoItemId,
      sku: item.sku,
      name: item.name,
      description: item.description,
      quantity: decimalToString(item.quantity),
      unit: item.unit,
      rate: decimalToString(item.rate),
      discountAmount: decimalToString(item.discountAmount),
      taxName: item.taxName,
      taxPercentage: decimalToString(item.taxPercentage),
      taxAmount: decimalToString(item.taxAmount),
      lineTotal: decimalToString(item.lineTotal),
      locationId: item.locationId,
      locationName: item.locationName,
      sortOrder: item.sortOrder,
    })),
  };
}
