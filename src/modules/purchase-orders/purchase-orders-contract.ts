import { Prisma } from '@prisma/client';

export interface PurchaseOrderItemListRow {
  id: string;
  name: string | null;
  description: string | null;
  quantity: string | null;
  rate: string | null;
  unit: string | null;
  lineTotal: string | null;
}

export interface PurchaseOrderListRow {
  id: string;
  purchaseOrderNumber: string | null;
  status: string | null;
  date: string | null;
  vendorName: string | null;
  total: string | null;
  balance: string | null;
  currencyCode: string | null;
  sourceRemoteModifiedAt: string | null;
}

export interface PurchaseOrderDetail {
  id: string;
  zohoPurchaseOrderId: string;
  purchaseOrderNumber: string | null;
  status: string | null;
  date: string | null;
  dueDate: string | null;
  deliveryDate: string | null;
  zohoVendorId: string | null;
  vendorName: string | null;
  currencyCode: string | null;
  subTotal: string | null;
  taxTotal: string | null;
  discountTotal: string | null;
  shippingCharge: string | null;
  total: string | null;
  balance: string | null;
  salespersonName: string | null;
  notes: string | null;
  referenceNumber: string | null;
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
  items: PurchaseOrderItemListRow[];
}

function dec(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function toPurchaseOrderListRow(po: {
  id: string;
  purchaseOrderNumber: string | null;
  status: string | null;
  date: Date | null;
  vendorName: string | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  currencyCode: string | null;
  sourceRemoteModifiedAt: Date;
}): PurchaseOrderListRow {
  return {
    id: po.id,
    purchaseOrderNumber: po.purchaseOrderNumber,
    status: po.status,
    date: po.date?.toISOString() ?? null,
    vendorName: po.vendorName,
    total: dec(po.total),
    balance: dec(po.balance),
    currencyCode: po.currencyCode,
    sourceRemoteModifiedAt: po.sourceRemoteModifiedAt.toISOString(),
  };
}

export function toPurchaseOrderDetail(po: {
  id: string;
  zohoPurchaseOrderId: string;
  purchaseOrderNumber: string | null;
  status: string | null;
  date: Date | null;
  dueDate: Date | null;
  deliveryDate: Date | null;
  zohoVendorId: string | null;
  vendorName: string | null;
  currencyCode: string | null;
  subTotal: Prisma.Decimal | null;
  taxTotal: Prisma.Decimal | null;
  discountTotal: Prisma.Decimal | null;
  shippingCharge: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
  balance: Prisma.Decimal | null;
  salespersonName: string | null;
  notes: string | null;
  referenceNumber: string | null;
  sourceRemoteModifiedAt: Date;
  sourceSnapshotId: string;
  normalizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  items?: {
    id: string;
    name: string | null;
    description: string | null;
    quantity: Prisma.Decimal | null;
    rate: Prisma.Decimal | null;
    unit: string | null;
    lineTotal: Prisma.Decimal | null;
  }[];
}): PurchaseOrderDetail {
  return {
    id: po.id,
    zohoPurchaseOrderId: po.zohoPurchaseOrderId,
    purchaseOrderNumber: po.purchaseOrderNumber,
    status: po.status,
    date: po.date?.toISOString() ?? null,
    dueDate: po.dueDate?.toISOString() ?? null,
    deliveryDate: po.deliveryDate?.toISOString() ?? null,
    zohoVendorId: po.zohoVendorId,
    vendorName: po.vendorName,
    currencyCode: po.currencyCode,
    subTotal: dec(po.subTotal),
    taxTotal: dec(po.taxTotal),
    discountTotal: dec(po.discountTotal),
    shippingCharge: dec(po.shippingCharge),
    total: dec(po.total),
    balance: dec(po.balance),
    salespersonName: po.salespersonName,
    notes: po.notes,
    referenceNumber: po.referenceNumber,
    sourceRemoteModifiedAt: po.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: po.sourceSnapshotId,
    normalizedAt: po.normalizedAt.toISOString(),
    createdAt: po.createdAt.toISOString(),
    updatedAt: po.updatedAt.toISOString(),
    items: (po.items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      quantity: dec(item.quantity),
      rate: dec(item.rate),
      unit: item.unit,
      lineTotal: dec(item.lineTotal),
    })),
  };
}
