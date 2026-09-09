import { Prisma } from '@prisma/client';

export interface ProductListRow {
  id: string;
  name: string | null;
  sku: string | null;
  status: string | null;
  productType: string | null;
  rate: string | null;
  unit: string | null;
  currencyCode: string | null;
  stockOnHand: string | null;
  availableStock: string | null;
  categoryName: string | null;
  brand: string | null;
  vendorName: string | null;
  sourceRemoteModifiedAt: string | null;
}

export interface ProductDetail {
  id: string;
  zohoItemId: string;
  name: string | null;
  sku: string | null;
  status: string | null;
  productType: string | null;
  description: string | null;
  rate: string | null;
  unit: string | null;
  currencyCode: string | null;
  taxName: string | null;
  taxPercentage: string | null;
  isTaxable: boolean | null;
  stockOnHand: string | null;
  availableStock: string | null;
  reorderLevel: string | null;
  purchaseRate: string | null;
  categoryName: string | null;
  categoryId: string | null;
  manufacturer: string | null;
  brand: string | null;
  zohoVendorId: string | null;
  vendorName: string | null;
  satProductCode: string | null;
  satUnitCode: string | null;
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
}

function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function toProductListRow(product: {
  id: string;
  name: string | null;
  sku: string | null;
  status: string | null;
  productType: string | null;
  rate: Prisma.Decimal | null;
  unit: string | null;
  currencyCode: string | null;
  stockOnHand: Prisma.Decimal | null;
  availableStock: Prisma.Decimal | null;
  categoryName: string | null;
  brand: string | null;
  vendorName: string | null;
  sourceRemoteModifiedAt: Date;
}): ProductListRow {
  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    status: product.status,
    productType: product.productType,
    rate: decimalToString(product.rate),
    unit: product.unit,
    currencyCode: product.currencyCode,
    stockOnHand: decimalToString(product.stockOnHand),
    availableStock: decimalToString(product.availableStock),
    categoryName: product.categoryName,
    brand: product.brand,
    vendorName: product.vendorName,
    sourceRemoteModifiedAt: product.sourceRemoteModifiedAt.toISOString(),
  };
}

export function toProductDetail(product: {
  id: string;
  zohoItemId: string;
  name: string | null;
  sku: string | null;
  status: string | null;
  productType: string | null;
  description: string | null;
  rate: Prisma.Decimal | null;
  unit: string | null;
  currencyCode: string | null;
  taxName: string | null;
  taxPercentage: Prisma.Decimal | null;
  isTaxable: boolean | null;
  stockOnHand: Prisma.Decimal | null;
  availableStock: Prisma.Decimal | null;
  reorderLevel: Prisma.Decimal | null;
  purchaseRate: Prisma.Decimal | null;
  categoryName: string | null;
  categoryId: string | null;
  manufacturer: string | null;
  brand: string | null;
  zohoVendorId: string | null;
  vendorName: string | null;
  satProductCode: string | null;
  satUnitCode: string | null;
  sourceRemoteModifiedAt: Date;
  sourceSnapshotId: string;
  normalizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): ProductDetail {
  return {
    id: product.id,
    zohoItemId: product.zohoItemId,
    name: product.name,
    sku: product.sku,
    status: product.status,
    productType: product.productType,
    description: product.description,
    rate: decimalToString(product.rate),
    unit: product.unit,
    currencyCode: product.currencyCode,
    taxName: product.taxName,
    taxPercentage: decimalToString(product.taxPercentage),
    isTaxable: product.isTaxable,
    stockOnHand: decimalToString(product.stockOnHand),
    availableStock: decimalToString(product.availableStock),
    reorderLevel: decimalToString(product.reorderLevel),
    purchaseRate: decimalToString(product.purchaseRate),
    categoryName: product.categoryName,
    categoryId: product.categoryId,
    manufacturer: product.manufacturer,
    brand: product.brand,
    zohoVendorId: product.zohoVendorId,
    vendorName: product.vendorName,
    satProductCode: product.satProductCode,
    satUnitCode: product.satUnitCode,
    sourceRemoteModifiedAt: product.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: product.sourceSnapshotId,
    normalizedAt: product.normalizedAt.toISOString(),
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
