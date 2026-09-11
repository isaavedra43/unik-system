import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import {
  dateRangeSchema,
  formatDate,
  buildDateWhereFlexible,
} from './date-helpers';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String(value);
  }
  return String(value);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return Number(String(value));
  }
  return Number(value);
}

/* ------------------------------------------------------------------ */
/* 1. queryInvoices — Universal invoices query tool                   */
/* ------------------------------------------------------------------ */

const INVOICE_GROUP_BY = ['none', 'customer', 'status', 'salesperson', 'date', 'product'] as const;

registerTool({
  name: 'queryInvoices',
  description:
    'TOOL UNIVERSAL de facturas a clientes. Úsalo para CUALQUIER consulta de facturas. ' +
    'Soporta filtrar por fecha, cliente (customer), estado (status), vendedor (salesperson), moneda (currency) y producto (en items). ' +
    'Puede agrupar por cliente, estado, vendedor, fecha o producto. ' +
    'Puede incluir los items (productos) con includeItems=true y la dirección de envío con includeShippingAddress=true. ' +
    'Incluye campos CFDI (cfdiUuid, usoCfdi, metodoPago, formaPago) cuando se pida detalle. ' +
    'EJEMPLOS: ' +
    '"facturas de esta semana" → queryInvoices(dateRange="this_week"). ' +
    '"facturas abiertas" → queryInvoices(status="open"). ' +
    '"facturas del cliente X" → queryInvoices(customer="X"). ' +
    '"facturas con detalle de productos" → queryInvoices(dateRange="this_month", includeItems=true). ' +
    '"facturas por cliente de este mes" → queryInvoices(dateRange="this_month", groupBy="customer"). ' +
    'PATRONES: "facturas sin cobrar" = status="open" • "facturas vencidas" = status="overdue" • "facturas cerradas" = status="closed" • "facturas no enviadas" = status="draft".',
  category: 'invoices',
  requiredPermission: 'invoices.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    customer: z.string().optional().describe('Filtrar por nombre del cliente (búsqueda parcial).'),
    status: z.string().optional().describe(
      'Filtrar por estado (búsqueda parcial). Valores típicos: "open", "closed", "void", "sent", "overdue". ' +
      'Úsalo para "abiertas" → status="open", "cerradas" → status="closed", "vencidas" → status="overdue".'
    ),
    salesperson: z.string().optional().describe('Filtrar por vendedor (búsqueda parcial).'),
    currency: z.string().optional().describe('Filtrar por moneda (ej: "MXN", "USD").'),
    product: z.string().optional().describe(
      'Filtrar por nombre de producto (búsqueda parcial en los items).'
    ),
    search: z.string().optional().describe('Búsqueda libre en número de factura, cliente, referencia, UUID CFDI.'),
    groupBy: z.enum(INVOICE_GROUP_BY).default('none').describe(
      'Agrupar resultados. "none" = lista individual. "customer" = por cliente. "status" = por estado. "salesperson" = por vendedor. "date" = por fecha. "product" = por producto (requiere includeItems o product filter).'
    ),
    includeItems: z.boolean().default(false).describe(
      'true = incluir los items (productos) de cada factura con nombre, cantidad, unidad y total.'
    ),
    includeShippingAddress: z.boolean().default(false).describe(
      'true = incluir la dirección de envío de cada factura.'
    ),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string; dateFrom?: string; dateTo?: string;
      customer?: string; status?: string; salesperson?: string; currency?: string;
      product?: string; search?: string;
      groupBy: (typeof INVOICE_GROUP_BY)[number];
      includeItems: boolean; includeShippingAddress: boolean;
      page: number; pageSize: number;
    };

    const dateWhere = buildDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo, 'date');
    const where: Record<string, unknown> = { ...dateWhere };

    const invoices = await prisma.invoice.findMany({
      where: where as never,
      select: {
        id: true,
        invoiceNumber: true,
        customerName: true,
        status: true,
        date: true,
        dueDate: true,
        total: true,
        balance: true,
        currencyCode: true,
        salespersonName: true,
        referenceNumber: true,
        cfdiUuid: true,
        usoCfdi: true,
        metodoPago: true,
        formaPago: true,
        regimenFiscal: true,
        shippingAddress: true,
        shippingCity: true,
        shippingState: true,
        shippingZip: true,
        shippingCountry: true,
        billingAddress: true,
        billingCity: true,
        billingState: true,
        billingZip: true,
        billingCountry: true,
        notes: true,
        terms: true,
        ...(args.includeItems || args.product || args.groupBy === 'product' ? {
          items: {
            select: {
              name: true,
              quantity: true,
              unit: true,
              rate: true,
              lineTotal: true,
              description: true,
            },
          },
        } : {}),
      },
      orderBy: { date: 'desc' },
      take: 1000,
    });

    // Apply filters in JavaScript for reliability
    let filtered = invoices;

    if (args.customer) {
      const c = args.customer.toLowerCase();
      filtered = filtered.filter((o) => (o.customerName?.toLowerCase() ?? '').includes(c));
    }
    if (args.status) {
      const s = args.status.toLowerCase();
      filtered = filtered.filter((o) => (o.status?.toLowerCase() ?? '').includes(s));
    }
    if (args.salesperson) {
      const s = args.salesperson.toLowerCase();
      filtered = filtered.filter((o) => (o.salespersonName?.toLowerCase() ?? '').includes(s));
    }
    if (args.currency) {
      const c = args.currency.toUpperCase();
      filtered = filtered.filter((o) => (o.currencyCode?.toUpperCase() ?? '') === c);
    }
    if (args.product) {
      const p = args.product.toLowerCase();
      filtered = filtered.filter((o) => {
        const items = (o as { items?: Array<{ name?: string }> }).items ?? [];
        return items.some((item) => (item.name?.toLowerCase() ?? '').includes(p));
      });
    }
    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.invoiceNumber?.toLowerCase() ?? '').includes(s) ||
        (o.customerName?.toLowerCase() ?? '').includes(s) ||
        (o.referenceNumber?.toLowerCase() ?? '').includes(s) ||
        (o.cfdiUuid?.toLowerCase() ?? '').includes(s)
      );
    }

    // Auto-diagnóstico
    const usedStatusFilter = !!args.status;
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && usedStatusFilter) {
      const uniqueStatuses = new Map<string, number>();
      for (const o of invoices) {
        if (o.status) uniqueStatuses.set(o.status, (uniqueStatuses.get(o.status) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta devolvió 0 resultados. Valores de status disponibles:',
        totalInvoicesInDateRange: invoices.length,
        availableStatuses: [...uniqueStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        hint: 'Reintenta con un valor que SÍ exista.',
      };
    }

    if (args.groupBy === 'none') {
      const total = filtered.length;
      const totalPages = Math.ceil(total / args.pageSize);
      const paginated = filtered.slice((args.page - 1) * args.pageSize, args.page * args.pageSize);
      const totalSum = filtered.reduce((s, o) => s + toNumber(o.total), 0);
      const balanceSum = filtered.reduce((s, o) => s + toNumber(o.balance), 0);

      return {
        mode: 'list',
        total, page: args.page, pageSize: args.pageSize, totalPages,
        totalSum: totalSum.toFixed(2), balanceSum: balanceSum.toFixed(2),
        dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
        filters: {
          customer: args.customer ?? null, status: args.status ?? null, salesperson: args.salesperson ?? null,
          currency: args.currency ?? null, product: args.product ?? null, search: args.search ?? null,
        },
        ...(diagnostic ? { diagnostic } : {}),
        invoices: paginated.map((o) => formatInvoice(o, args.includeItems, args.includeShippingAddress)),
      };
    }

    // Group by
    const groups = new Map<string, { count: number; total: number; balance: number; invoices: typeof filtered; totalQuantity?: number; unit?: string }>();
    for (const o of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'customer') key = o.customerName ?? 'SIN CLIENTE';
      else if (args.groupBy === 'status') key = o.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'salesperson') key = o.salespersonName ?? 'SIN VENDEDOR';
      else if (args.groupBy === 'date') key = formatDate(o.date) ?? 'SIN FECHA';
      else if (args.groupBy === 'product') {
        const items = (o as { items?: Array<{ name?: string; quantity?: unknown; unit?: string; lineTotal?: unknown }> }).items ?? [];
        if (items.length === 0) {
          const g = groups.get('SIN PRODUCTOS') ?? { count: 0, total: 0, balance: 0, invoices: [] as typeof filtered };
          g.count++; g.total += toNumber(o.total); g.balance += toNumber(o.balance); g.invoices.push(o);
          groups.set('SIN PRODUCTOS', g);
        } else {
          for (const item of items) {
            const pkey = item.name ?? 'SIN NOMBRE';
            const g = groups.get(pkey) ?? { count: 0, total: 0, balance: 0, invoices: [] as typeof filtered, totalQuantity: 0, unit: item.unit ?? '' };
            g.count++; g.total += toNumber(item.lineTotal); g.balance += toNumber(o.balance);
            g.totalQuantity = (g.totalQuantity ?? 0) + toNumber(item.quantity);
            if (!g.unit && item.unit) g.unit = item.unit;
            g.invoices.push(o);
            groups.set(pkey, g);
          }
        }
        continue;
      }
      const g = groups.get(key) ?? { count: 0, total: 0, balance: 0, invoices: [] as typeof filtered };
      g.count++; g.total += toNumber(o.total); g.balance += toNumber(o.balance); g.invoices.push(o);
      groups.set(key, g);
    }

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key, count: g.count, total: g.total.toFixed(2), balance: g.balance.toFixed(2),
        ...(args.groupBy === 'product' && g.totalQuantity !== undefined ? { totalQuantity: g.totalQuantity.toFixed(2), unit: g.unit ?? '' } : {}),
        ...(args.includeItems || args.groupBy === 'product' ? {
          invoices: g.invoices.slice(0, 50).map((o) => formatInvoice(o, args.includeItems || args.groupBy === 'product', args.includeShippingAddress)),
        } : {}),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    return {
      mode: 'grouped', groupBy: args.groupBy, groupCount: groups.size,
      totalInvoices: filtered.length,
      totalRevenue: filtered.reduce((s, o) => s + toNumber(o.total), 0).toFixed(2),
      totalBalance: filtered.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2),
      dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      filters: {
        customer: args.customer ?? null, status: args.status ?? null, salesperson: args.salesperson ?? null,
        currency: args.currency ?? null, product: args.product ?? null, search: args.search ?? null,
      },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

function formatInvoice(o: Record<string, unknown>, includeItems: boolean, includeShippingAddress: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {
    number: o.invoiceNumber,
    customer: o.customerName,
    status: o.status,
    date: formatDate(o.date as Date | null | undefined),
    dueDate: formatDate(o.dueDate as Date | null | undefined),
    total: decimalToString(o.total),
    balance: decimalToString(o.balance),
    currency: o.currencyCode,
    salesperson: o.salespersonName,
    referenceNumber: o.referenceNumber,
    cfdiUuid: o.cfdiUuid,
    usoCfdi: o.usoCfdi,
    metodoPago: o.metodoPago,
    formaPago: o.formaPago,
    regimenFiscal: o.regimenFiscal,
  };
  if (includeItems) {
    const items = (o.items as Array<Record<string, unknown>> | undefined) ?? [];
    result.items = items.map((item) => ({
      name: item.name,
      quantity: decimalToString(item.quantity),
      unit: item.unit,
      rate: decimalToString(item.rate),
      lineTotal: decimalToString(item.lineTotal),
      description: item.description,
    }));
  }
  if (includeShippingAddress) {
    const addrParts = [
      o.shippingAddress, o.shippingCity, o.shippingState, o.shippingZip, o.shippingCountry,
    ].filter((p) => p !== null && p !== undefined && String(p).trim() !== '');
    result.shippingAddress = addrParts.length > 0 ? addrParts.join(', ') : null;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 2. getInvoiceDetail — Detail by number/ID with CFDI fields         */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getInvoiceDetail',
  description:
    'Detalle completo de una factura por su número (ej: INV-001), UUID CFDI o ID interno, ' +
    'incluyendo items, campos CFDI (cfdiUuid, usoCfdi, metodoPago, formaPago, regimenFiscal), ' +
    'direcciones de facturación y envío.',
  category: 'invoices',
  requiredPermission: 'invoices.view',
  enabledByDefault: true,
  parameters: z.object({
    invoiceNumber: z.string().min(1).describe('Número de la factura (ej: INV-001), UUID CFDI o ID interno.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { invoiceNumber: string };
    const invoice = await prisma.invoice.findFirst({
      where: {
        OR: [
          { invoiceNumber: { equals: args.invoiceNumber, mode: 'insensitive' } },
          { cfdiUuid: { equals: args.invoiceNumber, mode: 'insensitive' } },
          { id: args.invoiceNumber },
        ],
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!invoice) return { found: false, searchedNumber: args.invoiceNumber };
    return {
      found: true,
      invoice: {
        id: invoice.id,
        number: invoice.invoiceNumber,
        customer: invoice.customerName,
        status: invoice.status,
        date: formatDate(invoice.date),
        dueDate: formatDate(invoice.dueDate),
        currency: invoice.currencyCode,
        subTotal: decimalToString(invoice.subTotal),
        taxTotal: decimalToString(invoice.taxTotal),
        discountTotal: decimalToString(invoice.discountTotal),
        shippingCharge: decimalToString(invoice.shippingCharge),
        total: decimalToString(invoice.total),
        balance: decimalToString(invoice.balance),
        salesperson: invoice.salespersonName,
        referenceNumber: invoice.referenceNumber,
        notes: invoice.notes,
        terms: invoice.terms,
        // CFDI fields
        cfdiUuid: invoice.cfdiUuid,
        cfdiVersion: invoice.cfdiVersion,
        usoCfdi: invoice.usoCfdi,
        metodoPago: invoice.metodoPago,
        formaPago: invoice.formaPago,
        regimenFiscal: invoice.regimenFiscal,
        cfdiExportacion: invoice.cfdiExportacion,
        // Billing address
        billingAddress: invoice.billingAddress,
        billingCity: invoice.billingCity,
        billingState: invoice.billingState,
        billingZip: invoice.billingZip,
        billingCountry: invoice.billingCountry,
        // Shipping address
        shippingAddress: invoice.shippingAddress,
        shippingCity: invoice.shippingCity,
        shippingState: invoice.shippingState,
        shippingZip: invoice.shippingZip,
        shippingCountry: invoice.shippingCountry,
        // Items
        items: invoice.items.map((it) => ({
          name: it.name,
          description: it.description,
          quantity: decimalToString(it.quantity),
          unit: it.unit,
          rate: decimalToString(it.rate),
          lineTotal: decimalToString(it.lineTotal),
          taxName: it.taxName,
          taxPercentage: decimalToString(it.taxPercentage),
          taxAmount: decimalToString(it.taxAmount),
          discountAmount: decimalToString(it.discountAmount),
        })),
      },
    };
  },
});
