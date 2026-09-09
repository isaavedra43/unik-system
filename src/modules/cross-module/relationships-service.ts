import { prisma } from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Cross-module relationship queries.
// Links Contacts ↔ Packages/Invoices and Invoices ↔ Sales Orders.
// ---------------------------------------------------------------------------

export interface RelatedPackageSummary {
  id: string;
  packageNumber: string | null;
  status: string | null;
  date: string | null;
  trackingNumber: string | null;
  carrier: string | null;
}

export interface RelatedInvoiceSummary {
  id: string;
  invoiceNumber: string | null;
  status: string | null;
  date: string | null;
  total: string | null;
  balance: string | null;
  currencyCode: string | null;
}

export interface RelatedContactSummary {
  id: string;
  zohoContactId: string;
  contactName: string | null;
  companyName: string | null;
  contactType: string | null;
}

export interface RelatedSalesOrderSummary {
  id: string;
  salesOrderNumber: string | null;
  status: string | null;
  date: string | null;
  total: string | null;
}

// ---------------------------------------------------------------------------
// Contact → Packages / Invoices
// ---------------------------------------------------------------------------

export async function getPackagesByContactZohoId(
  zohoCustomerId: string,
  limit = 10
): Promise<RelatedPackageSummary[]> {
  const packages = await prisma.package.findMany({
    where: { zohoCustomerId },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: {
      id: true, packageNumber: true, status: true, date: true,
      trackingNumber: true, carrier: true,
    },
  });
  return packages.map((p) => ({
    id: p.id, packageNumber: p.packageNumber, status: p.status,
    date: p.date?.toISOString() ?? null,
    trackingNumber: p.trackingNumber, carrier: p.carrier,
  }));
}

export async function getInvoicesByContactZohoId(
  zohoCustomerId: string,
  limit = 10
): Promise<RelatedInvoiceSummary[]> {
  const invoices = await prisma.invoice.findMany({
    where: { zohoCustomerId },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: {
      id: true, invoiceNumber: true, status: true, date: true,
      total: true, balance: true, currencyCode: true,
    },
  });
  return invoices.map((i) => ({
    id: i.id, invoiceNumber: i.invoiceNumber, status: i.status,
    date: i.date?.toISOString() ?? null,
    total: i.total?.toString() ?? null,
    balance: i.balance?.toString() ?? null,
    currencyCode: i.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Package / Invoice → Contact
// ---------------------------------------------------------------------------

export async function getContactByZohoId(
  zohoContactId: string
): Promise<RelatedContactSummary | null> {
  const contact = await prisma.contact.findUnique({
    where: { zohoContactId },
    select: {
      id: true, zohoContactId: true, contactName: true,
      companyName: true, contactType: true,
    },
  });
  if (!contact) return null;
  return contact;
}

// ---------------------------------------------------------------------------
// Invoice → Sales Orders (through line items)
// ---------------------------------------------------------------------------

export async function getRelatedSalesOrdersByInvoice(
  invoiceId: string
): Promise<RelatedSalesOrderSummary[]> {
  const items = await prisma.invoiceItem.findMany({
    where: { invoiceId, zohoSalesOrderId: { not: null } },
    select: { zohoSalesOrderId: true },
    distinct: ['zohoSalesOrderId'],
  });
  const zohoSalesOrderIds = items
    .map((i) => i.zohoSalesOrderId)
    .filter((id): id is string => id !== null);
  if (zohoSalesOrderIds.length === 0) return [];
  const salesOrders = await prisma.salesOrder.findMany({
    where: { zohoSalesOrderId: { in: zohoSalesOrderIds } },
    select: { id: true, salesOrderNumber: true, status: true, orderDate: true, total: true },
  });
  return salesOrders.map((so) => ({
    id: so.id,
    salesOrderNumber: so.salesOrderNumber,
    status: so.status,
    date: so.orderDate?.toISOString() ?? null,
    total: so.total?.toString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Package → Sales Order (direct field)
// ---------------------------------------------------------------------------

export async function getPackageSalesOrderLink(
  packageId: string
): Promise<{ zohoSalesOrderId: string } | null> {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    select: { zohoSalesOrderId: true },
  });
  if (!pkg?.zohoSalesOrderId) return null;
  return { zohoSalesOrderId: pkg.zohoSalesOrderId };
}

// ---------------------------------------------------------------------------
// New relationship types
// ---------------------------------------------------------------------------

export interface RelatedPaymentSummary {
  id: string;
  paymentNumber: string | null;
  paymentMode: string | null;
  status: string | null;
  date: string | null;
  amount: string | null;
  currencyCode: string | null;
}

export interface RelatedPurchaseOrderSummary {
  id: string;
  purchaseOrderNumber: string | null;
  status: string | null;
  date: string | null;
  total: string | null;
  balance: string | null;
  currencyCode: string | null;
}

export interface RelatedBillSummary {
  id: string;
  billNumber: string | null;
  status: string | null;
  date: string | null;
  total: string | null;
  balance: string | null;
  currencyCode: string | null;
  zohoPurchaseOrderId: string | null;
}

export interface RelatedVendorCreditSummary {
  id: string;
  vendorCreditNumber: string | null;
  status: string | null;
  date: string | null;
  total: string | null;
  balance: string | null;
  currencyCode: string | null;
}

export interface RelatedProductSummary {
  id: string;
  name: string | null;
  sku: string | null;
  status: string | null;
  productType: string | null;
}

export interface ProductTransactionHistoryRow {
  id: string;
  date: string | null;
  documentNumber: string | null;
  documentType: 'sales_order' | 'invoice' | 'package';
  documentId: string;
  customerName: string | null;
  quantity: string | null;
  rate: string | null;
  total: string | null;
  status: string | null;
}

// ---------------------------------------------------------------------------
// Contact → Sales Orders
// ---------------------------------------------------------------------------

export async function getSalesOrdersByContactZohoId(
  zohoCustomerId: string,
  limit = 10
): Promise<{ id: string; salesOrderNumber: string | null; status: string | null; date: string | null; total: string | null }[]> {
  const salesOrders = await prisma.salesOrder.findMany({
    where: { zohoCustomerId },
    orderBy: { orderDate: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, salesOrderNumber: true, status: true, orderDate: true, total: true },
  });
  return salesOrders.map((so) => ({
    id: so.id,
    salesOrderNumber: so.salesOrderNumber,
    status: so.status,
    date: so.orderDate?.toISOString() ?? null,
    total: so.total?.toString() ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Contact → Payments
// ---------------------------------------------------------------------------

export async function getPaymentsByContactZohoId(
  zohoCustomerId: string,
  limit = 10
): Promise<RelatedPaymentSummary[]> {
  const payments = await prisma.customerPayment.findMany({
    where: { zohoCustomerId },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, paymentNumber: true, paymentMode: true, status: true, date: true, amount: true, currencyCode: true },
  });
  return payments.map((p) => ({
    id: p.id, paymentNumber: p.paymentNumber, paymentMode: p.paymentMode, status: p.status,
    date: p.date?.toISOString() ?? null, amount: p.amount?.toString() ?? null, currencyCode: p.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Vendor → Purchase Orders
// ---------------------------------------------------------------------------

export async function getPurchaseOrdersByVendorZohoId(
  zohoVendorId: string,
  limit = 10
): Promise<RelatedPurchaseOrderSummary[]> {
  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: { zohoVendorId },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, purchaseOrderNumber: true, status: true, date: true, total: true, balance: true, currencyCode: true },
  });
  return purchaseOrders.map((po) => ({
    id: po.id, purchaseOrderNumber: po.purchaseOrderNumber, status: po.status,
    date: po.date?.toISOString() ?? null, total: po.total?.toString() ?? null,
    balance: po.balance?.toString() ?? null, currencyCode: po.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Vendor → Bills
// ---------------------------------------------------------------------------

export async function getBillsByVendorZohoId(
  zohoVendorId: string,
  limit = 10
): Promise<RelatedBillSummary[]> {
  const bills = await prisma.bill.findMany({
    where: { zohoVendorId },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, billNumber: true, status: true, date: true, total: true, balance: true, currencyCode: true, zohoPurchaseOrderId: true },
  });
  return bills.map((b) => ({
    id: b.id, billNumber: b.billNumber, status: b.status,
    date: b.date?.toISOString() ?? null, total: b.total?.toString() ?? null,
    balance: b.balance?.toString() ?? null, currencyCode: b.currencyCode,
    zohoPurchaseOrderId: b.zohoPurchaseOrderId,
  }));
}

// ---------------------------------------------------------------------------
// Vendor → Vendor Credits
// ---------------------------------------------------------------------------

export async function getVendorCreditsByVendorZohoId(
  zohoVendorId: string,
  limit = 10
): Promise<RelatedVendorCreditSummary[]> {
  const vendorCredits = await prisma.vendorCredit.findMany({
    where: { zohoVendorId },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, vendorCreditNumber: true, status: true, date: true, total: true, balance: true, currencyCode: true },
  });
  return vendorCredits.map((vc) => ({
    id: vc.id, vendorCreditNumber: vc.vendorCreditNumber, status: vc.status,
    date: vc.date?.toISOString() ?? null, total: vc.total?.toString() ?? null,
    balance: vc.balance?.toString() ?? null, currencyCode: vc.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Vendor → Products
// ---------------------------------------------------------------------------

export async function getProductsByVendorZohoId(
  zohoVendorId: string,
  limit = 10
): Promise<RelatedProductSummary[]> {
  const products = await prisma.product.findMany({
    where: { zohoVendorId },
    orderBy: { name: 'asc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, name: true, sku: true, status: true, productType: true },
  });
  return products.map((p) => ({
    id: p.id, name: p.name, sku: p.sku, status: p.status, productType: p.productType,
  }));
}

// ---------------------------------------------------------------------------
// Product → Transaction History (Sales Order Items, Invoice Items, Package Items)
// ---------------------------------------------------------------------------

export async function getProductSalesOrderHistory(
  zohoItemId: string,
  limit = 20
): Promise<ProductTransactionHistoryRow[]> {
  const items = await prisma.salesOrderItem.findMany({
    where: { zohoItemId },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.min(limit, 100)),
    include: {
      salesOrder: { select: { id: true, salesOrderNumber: true, status: true, orderDate: true, customerName: true } },
    },
  });
  return items.map((item) => ({
    id: item.id,
    date: item.salesOrder.orderDate?.toISOString() ?? null,
    documentNumber: item.salesOrder.salesOrderNumber,
    documentType: 'sales_order' as const,
    documentId: item.salesOrder.id,
    customerName: item.salesOrder.customerName,
    quantity: item.quantity?.toString() ?? null,
    rate: item.rate?.toString() ?? null,
    total: item.lineTotal?.toString() ?? null,
    status: item.salesOrder.status,
  }));
}

export async function getProductInvoiceHistory(
  zohoItemId: string,
  limit = 20
): Promise<ProductTransactionHistoryRow[]> {
  const items = await prisma.invoiceItem.findMany({
    where: { zohoItemId },
    orderBy: { sortOrder: 'desc' },
    take: Math.max(1, Math.min(limit, 100)),
    include: {
      invoice: { select: { id: true, invoiceNumber: true, status: true, date: true, customerName: true } },
    },
  });
  return items.map((item) => ({
    id: item.id,
    date: item.invoice.date?.toISOString() ?? null,
    documentNumber: item.invoice.invoiceNumber,
    documentType: 'invoice' as const,
    documentId: item.invoice.id,
    customerName: item.invoice.customerName,
    quantity: item.quantity?.toString() ?? null,
    rate: item.rate?.toString() ?? null,
    total: item.lineTotal?.toString() ?? null,
    status: item.invoice.status,
  }));
}

export async function getProductPackageHistory(
  zohoItemId: string,
  limit = 20
): Promise<ProductTransactionHistoryRow[]> {
  const items = await prisma.packageItem.findMany({
    where: { zohoItemId },
    orderBy: { sortOrder: 'desc' },
    take: Math.max(1, Math.min(limit, 100)),
    include: {
      package: { select: { id: true, packageNumber: true, status: true, date: true, customerName: true } },
    },
  });
  return items.map((item) => ({
    id: item.id,
    date: item.package.date?.toISOString() ?? null,
    documentNumber: item.package.packageNumber,
    documentType: 'package' as const,
    documentId: item.package.id,
    customerName: item.package.customerName,
    quantity: item.quantity?.toString() ?? null,
    rate: null,
    total: null,
    status: item.package.status,
  }));
}

// ---------------------------------------------------------------------------
// Sales Order → Packages / Invoices
// ---------------------------------------------------------------------------

export async function getPackagesBySalesOrderZohoId(
  zohoSalesOrderId: string,
  limit = 10
): Promise<RelatedPackageSummary[]> {
  const packages = await prisma.package.findMany({
    where: { zohoSalesOrderId },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, packageNumber: true, status: true, date: true, trackingNumber: true, carrier: true },
  });
  return packages.map((p) => ({
    id: p.id, packageNumber: p.packageNumber, status: p.status,
    date: p.date?.toISOString() ?? null, trackingNumber: p.trackingNumber, carrier: p.carrier,
  }));
}

export async function getInvoicesBySalesOrderZohoId(
  zohoSalesOrderId: string,
  limit = 10
): Promise<RelatedInvoiceSummary[]> {
  const invoices = await prisma.invoice.findMany({
    where: { items: { some: { zohoSalesOrderId } } },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, invoiceNumber: true, status: true, date: true, total: true, balance: true, currencyCode: true },
    distinct: ['id'],
  });
  return invoices.map((i) => ({
    id: i.id, invoiceNumber: i.invoiceNumber, status: i.status,
    date: i.date?.toISOString() ?? null, total: i.total?.toString() ?? null,
    balance: i.balance?.toString() ?? null, currencyCode: i.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Purchase Order → Bills
// ---------------------------------------------------------------------------

export async function getBillsByPurchaseOrderZohoId(
  zohoPurchaseOrderId: string,
  limit = 10
): Promise<RelatedBillSummary[]> {
  const bills = await prisma.bill.findMany({
    where: { zohoPurchaseOrderId },
    orderBy: { date: 'desc' },
    take: Math.max(1, Math.min(limit, 50)),
    select: { id: true, billNumber: true, status: true, date: true, total: true, balance: true, currencyCode: true, zohoPurchaseOrderId: true },
  });
  return bills.map((b) => ({
    id: b.id, billNumber: b.billNumber, status: b.status,
    date: b.date?.toISOString() ?? null, total: b.total?.toString() ?? null,
    balance: b.balance?.toString() ?? null, currencyCode: b.currencyCode,
    zohoPurchaseOrderId: b.zohoPurchaseOrderId,
  }));
}
