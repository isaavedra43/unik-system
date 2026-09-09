import { Prisma } from '@prisma/client';

export interface PackageItemListRow {
  id: string;
  name: string | null;
  sku: string | null;
  quantity: string | null;
  unit: string | null;
}

export interface PackageListRow {
  id: string;
  packageNumber: string | null;
  status: string | null;
  date: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  customerName: string | null;
  zohoSalesOrderId: string | null;
  sourceRemoteModifiedAt: string | null;
}

export interface PackageDetail {
  id: string;
  zohoPackageId: string;
  packageNumber: string | null;
  status: string | null;
  date: string | null;
  shipmentType: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  deliveryMethod: string | null;
  shippingCharge: string | null;
  zohoSalesOrderId: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
  items: PackageItemListRow[];
}

function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function toPackageListRow(pkg: {
  id: string;
  packageNumber: string | null;
  status: string | null;
  date: Date | null;
  carrier: string | null;
  trackingNumber: string | null;
  customerName: string | null;
  zohoSalesOrderId: string | null;
  sourceRemoteModifiedAt: Date;
}): PackageListRow {
  return {
    id: pkg.id,
    packageNumber: pkg.packageNumber,
    status: pkg.status,
    date: pkg.date?.toISOString() ?? null,
    carrier: pkg.carrier,
    trackingNumber: pkg.trackingNumber,
    customerName: pkg.customerName,
    zohoSalesOrderId: pkg.zohoSalesOrderId,
    sourceRemoteModifiedAt: pkg.sourceRemoteModifiedAt.toISOString(),
  };
}

export function toPackageDetail(pkg: {
  id: string;
  zohoPackageId: string;
  packageNumber: string | null;
  status: string | null;
  date: Date | null;
  shipmentType: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  deliveryMethod: string | null;
  shippingCharge: Prisma.Decimal | null;
  zohoSalesOrderId: string | null;
  zohoCustomerId: string | null;
  customerName: string | null;
  sourceRemoteModifiedAt: Date;
  sourceSnapshotId: string;
  normalizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  items?: { id: string; name: string | null; sku: string | null; quantity: Prisma.Decimal | null; unit: string | null }[];
}): PackageDetail {
  return {
    id: pkg.id,
    zohoPackageId: pkg.zohoPackageId,
    packageNumber: pkg.packageNumber,
    status: pkg.status,
    date: pkg.date?.toISOString() ?? null,
    shipmentType: pkg.shipmentType,
    carrier: pkg.carrier,
    trackingNumber: pkg.trackingNumber,
    deliveryMethod: pkg.deliveryMethod,
    shippingCharge: decimalToString(pkg.shippingCharge),
    zohoSalesOrderId: pkg.zohoSalesOrderId,
    zohoCustomerId: pkg.zohoCustomerId,
    customerName: pkg.customerName,
    sourceRemoteModifiedAt: pkg.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: pkg.sourceSnapshotId,
    normalizedAt: pkg.normalizedAt.toISOString(),
    createdAt: pkg.createdAt.toISOString(),
    updatedAt: pkg.updatedAt.toISOString(),
    items: (pkg.items ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      sku: item.sku,
      quantity: decimalToString(item.quantity),
      unit: item.unit,
    })),
  };
}
