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
  zohoSalesOrderId: string;
  invoiceCount: number;
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
  return items
    .filter((i) => i.zohoSalesOrderId !== null)
    .map((i) => ({
      zohoSalesOrderId: i.zohoSalesOrderId!,
      invoiceCount: 0,
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
