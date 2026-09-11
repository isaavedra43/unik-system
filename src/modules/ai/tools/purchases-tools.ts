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
/* 1. queryPurchaseOrders — Universal purchase order query tool        */
/* ------------------------------------------------------------------ */

const PO_GROUP_BY = ['none', 'vendor', 'status', 'date', 'product'] as const;

registerTool({
  name: 'queryPurchaseOrders',
  description:
    'TOOL UNIVERSAL de órdenes de compra. Úsalo para CUALQUIER consulta de órdenes de compra a proveedores. ' +
    'Soporta filtrar por fecha, proveedor (vendor), estado (status), vendedor (salesperson), moneda (currency) y producto (en items). ' +
    'Puede agrupar por proveedor, estado, fecha o producto. ' +
    'Puede incluir los items (productos) con includeItems=true. ' +
    'EJEMPLOS: ' +
    '"órdenes de compra de esta semana" → queryPurchaseOrders(dateRange="this_week"). ' +
    '"órdenes de compra al proveedor X" → queryPurchaseOrders(vendor="X"). ' +
    '"órdenes de compra abiertas" → queryPurchaseOrders(status="open"). ' +
    '"qué material le pedí al proveedor X esta semana" → queryPurchaseOrders(dateRange="this_week", vendor="X", includeItems=true). ' +
    '"órdenes de compra por proveedor de este mes" → queryPurchaseOrders(dateRange="this_month", groupBy="vendor").',
  category: 'purchases',
  requiredPermission: 'purchase_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    vendor: z.string().optional().describe('Filtrar por nombre del proveedor (búsqueda parcial).'),
    status: z.string().optional().describe(
      'Filtrar por estado (búsqueda parcial). Valores típicos: "open", "closed", "draft". ' +
      'Úsalo para "abiertas" → status="open", "cerradas" → status="closed".'
    ),
    salesperson: z.string().optional().describe('Filtrar por vendedor (búsqueda parcial).'),
    currency: z.string().optional().describe('Filtrar por moneda (ej: "MXN", "USD").'),
    product: z.string().optional().describe(
      'Filtrar por nombre de producto (búsqueda parcial en los items). Solo devuelve órdenes que contienen ese producto.'
    ),
    search: z.string().optional().describe('Búsqueda libre en número de orden, proveedor, referencia.'),
    groupBy: z.enum(PO_GROUP_BY).default('none').describe(
      'Agrupar resultados. "none" = lista individual. "vendor" = por proveedor. "status" = por estado. "date" = por fecha. "product" = por producto (requiere includeItems o product filter).'
    ),
    includeItems: z.boolean().default(false).describe(
      'true = incluir los items (productos) de cada orden con nombre, cantidad, unidad y total. ' +
      'Útil cuando el usuario pide "qué productos", "qué material", "detalle de productos".'
    ),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      vendor?: string;
      status?: string;
      salesperson?: string;
      currency?: string;
      product?: string;
      search?: string;
      groupBy: (typeof PO_GROUP_BY)[number];
      includeItems: boolean;
      page: number;
      pageSize: number;
    };

    const dateWhere = buildDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo, 'date');
    const where: Record<string, unknown> = { ...dateWhere };

    const orders = await prisma.purchaseOrder.findMany({
      where: where as never,
      select: {
        id: true,
        purchaseOrderNumber: true,
        vendorName: true,
        status: true,
        date: true,
        dueDate: true,
        deliveryDate: true,
        total: true,
        balance: true,
        currencyCode: true,
        salespersonName: true,
        referenceNumber: true,
        notes: true,
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
    let filtered = orders;

    if (args.vendor) {
      const v = args.vendor.toLowerCase();
      filtered = filtered.filter((o) => (o.vendorName?.toLowerCase() ?? '').includes(v));
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
        (o.purchaseOrderNumber?.toLowerCase() ?? '').includes(s) ||
        (o.vendorName?.toLowerCase() ?? '').includes(s) ||
        (o.referenceNumber?.toLowerCase() ?? '').includes(s)
      );
    }

    // Auto-diagnóstico
    const usedStatusFilter = !!args.status;
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && usedStatusFilter) {
      const uniqueStatuses = new Map<string, number>();
      for (const o of orders) {
        if (o.status) uniqueStatuses.set(o.status, (uniqueStatuses.get(o.status) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta con los filtros actuales devolvió 0 resultados. Valores de status disponibles:',
        totalOrdersInDateRange: orders.length,
        availableStatuses: [...uniqueStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        hint: 'Reintenta con un valor que SÍ exista en la lista anterior.',
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
        total,
        page: args.page,
        pageSize: args.pageSize,
        totalPages,
        totalSum: totalSum.toFixed(2),
        balanceSum: balanceSum.toFixed(2),
        dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
        filters: {
          vendor: args.vendor ?? null, status: args.status ?? null, salesperson: args.salesperson ?? null,
          currency: args.currency ?? null, product: args.product ?? null, search: args.search ?? null,
        },
        ...(diagnostic ? { diagnostic } : {}),
        orders: paginated.map((o) => formatPurchaseOrder(o, args.includeItems)),
      };
    }

    // Group by
    const groups = new Map<string, { count: number; total: number; balance: number; orders: typeof filtered; totalQuantity?: number; unit?: string }>();
    for (const o of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'vendor') key = o.vendorName ?? 'SIN PROVEEDOR';
      else if (args.groupBy === 'status') key = o.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'date') key = formatDate(o.date) ?? 'SIN FECHA';
      else if (args.groupBy === 'product') {
        const items = (o as { items?: Array<{ name?: string; quantity?: unknown; unit?: string; lineTotal?: unknown }> }).items ?? [];
        if (items.length === 0) {
          const g = groups.get('SIN PRODUCTOS') ?? { count: 0, total: 0, balance: 0, orders: [] as typeof filtered };
          g.count++; g.total += toNumber(o.total); g.balance += toNumber(o.balance); g.orders.push(o);
          groups.set('SIN PRODUCTOS', g);
        } else {
          for (const item of items) {
            const pkey = item.name ?? 'SIN NOMBRE';
            const g = groups.get(pkey) ?? { count: 0, total: 0, balance: 0, orders: [] as typeof filtered, totalQuantity: 0, unit: item.unit ?? '' };
            g.count++; g.total += toNumber(item.lineTotal); g.balance += toNumber(o.balance);
            g.totalQuantity = (g.totalQuantity ?? 0) + toNumber(item.quantity);
            if (!g.unit && item.unit) g.unit = item.unit;
            g.orders.push(o);
            groups.set(pkey, g);
          }
        }
        continue;
      }
      const g = groups.get(key) ?? { count: 0, total: 0, balance: 0, orders: [] as typeof filtered };
      g.count++; g.total += toNumber(o.total); g.balance += toNumber(o.balance); g.orders.push(o);
      groups.set(key, g);
    }

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key,
        count: g.count,
        total: g.total.toFixed(2),
        balance: g.balance.toFixed(2),
        ...(args.groupBy === 'product' && g.totalQuantity !== undefined ? { totalQuantity: g.totalQuantity.toFixed(2), unit: g.unit ?? '' } : {}),
        ...(args.includeItems || args.groupBy === 'product' ? {
          orders: g.orders.slice(0, 50).map((o) => formatPurchaseOrder(o, args.includeItems || args.groupBy === 'product')),
        } : {}),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    return {
      mode: 'grouped',
      groupBy: args.groupBy,
      groupCount: groups.size,
      totalOrders: filtered.length,
      totalRevenue: filtered.reduce((s, o) => s + toNumber(o.total), 0).toFixed(2),
      totalBalance: filtered.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2),
      dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      filters: {
        vendor: args.vendor ?? null, status: args.status ?? null, salesperson: args.salesperson ?? null,
        currency: args.currency ?? null, product: args.product ?? null, search: args.search ?? null,
      },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

function formatPurchaseOrder(o: Record<string, unknown>, includeItems: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {
    number: o.purchaseOrderNumber,
    vendor: o.vendorName,
    status: o.status,
    date: formatDate(o.date as Date | null | undefined),
    dueDate: formatDate(o.dueDate as Date | null | undefined),
    deliveryDate: formatDate(o.deliveryDate as Date | null | undefined),
    total: decimalToString(o.total),
    balance: decimalToString(o.balance),
    currency: o.currencyCode,
    salesperson: o.salespersonName,
    referenceNumber: o.referenceNumber,
    notes: o.notes,
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
  return result;
}

/* ------------------------------------------------------------------ */
/* 2. getPurchaseOrderDetail — Detail by number/ID                    */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getPurchaseOrderDetail',
  description: 'Detalle completo de una orden de compra por su número (ej: PO-001) o ID interno, incluyendo items.',
  category: 'purchases',
  requiredPermission: 'purchase_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    purchaseOrderNumber: z.string().min(1).describe('Número de la orden de compra (ej: PO-001) o ID interno.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { purchaseOrderNumber: string };
    const order = await prisma.purchaseOrder.findFirst({
      where: {
        OR: [
          { purchaseOrderNumber: { equals: args.purchaseOrderNumber, mode: 'insensitive' } },
          { id: args.purchaseOrderNumber },
        ],
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!order) return { found: false, searchedNumber: args.purchaseOrderNumber };
    return {
      found: true,
      order: {
        id: order.id,
        number: order.purchaseOrderNumber,
        vendor: order.vendorName,
        status: order.status,
        date: formatDate(order.date),
        dueDate: formatDate(order.dueDate),
        deliveryDate: formatDate(order.deliveryDate),
        currency: order.currencyCode,
        subTotal: decimalToString(order.subTotal),
        taxTotal: decimalToString(order.taxTotal),
        discountTotal: decimalToString(order.discountTotal),
        shippingCharge: decimalToString(order.shippingCharge),
        total: decimalToString(order.total),
        balance: decimalToString(order.balance),
        salesperson: order.salespersonName,
        referenceNumber: order.referenceNumber,
        notes: order.notes,
        items: order.items.map((it) => ({
          name: it.name,
          description: it.description,
          quantity: decimalToString(it.quantity),
          unit: it.unit,
          rate: decimalToString(it.rate),
          lineTotal: decimalToString(it.lineTotal),
          taxName: it.taxName,
          taxPercentage: decimalToString(it.taxPercentage),
          taxAmount: decimalToString(it.taxAmount),
        })),
      },
    };
  },
});

/* ------------------------------------------------------------------ */
/* 3. queryBills — Universal bills (facturas de compra) query tool    */
/* ------------------------------------------------------------------ */

const BILL_GROUP_BY = ['none', 'vendor', 'status', 'date'] as const;

registerTool({
  name: 'queryBills',
  description:
    'TOOL UNIVERSAL de facturas de compra (bills). Úsalo para CUALQUIER consulta de facturas recibidas de proveedores. ' +
    'Soporta filtrar por fecha, proveedor (vendor), estado (status) y moneda (currency). ' +
    'Puede agrupar por proveedor, estado o fecha. ' +
    'EJEMPLOS: ' +
    '"facturas de compra de esta semana" → queryBills(dateRange="this_week"). ' +
    '"facturas del proveedor X" → queryBills(vendor="X"). ' +
    '"facturas de compra abiertas" → queryBills(status="open"). ' +
    '"facturas por proveedor de este mes" → queryBills(dateRange="this_month", groupBy="vendor").',
  category: 'purchases',
  requiredPermission: 'bills.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    vendor: z.string().optional().describe('Filtrar por nombre del proveedor (búsqueda parcial).'),
    status: z.string().optional().describe(
      'Filtrar por estado (búsqueda parcial). Valores típicos: "open", "closed", "draft", "void".'
    ),
    currency: z.string().optional().describe('Filtrar por moneda (ej: "MXN", "USD").'),
    search: z.string().optional().describe('Búsqueda libre en número de factura, proveedor.'),
    groupBy: z.enum(BILL_GROUP_BY).default('none').describe(
      'Agrupar resultados. "none" = lista individual. "vendor" = por proveedor. "status" = por estado. "date" = por fecha.'
    ),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string; dateFrom?: string; dateTo?: string;
      vendor?: string; status?: string; currency?: string; search?: string;
      groupBy: (typeof BILL_GROUP_BY)[number]; page: number; pageSize: number;
    };

    const dateWhere = buildDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo, 'date');
    const where: Record<string, unknown> = { ...dateWhere };

    const bills = await prisma.bill.findMany({
      where: where as never,
      select: {
        id: true,
        billNumber: true,
        vendorName: true,
        status: true,
        date: true,
        dueDate: true,
        total: true,
        balance: true,
        currencyCode: true,
        zohoPurchaseOrderId: true,
        vendorCreditsApplied: true,
        notes: true,
      },
      orderBy: { date: 'desc' },
      take: 1000,
    });

    let filtered = bills;
    if (args.vendor) {
      const v = args.vendor.toLowerCase();
      filtered = filtered.filter((o) => (o.vendorName?.toLowerCase() ?? '').includes(v));
    }
    if (args.status) {
      const s = args.status.toLowerCase();
      filtered = filtered.filter((o) => (o.status?.toLowerCase() ?? '').includes(s));
    }
    if (args.currency) {
      const c = args.currency.toUpperCase();
      filtered = filtered.filter((o) => (o.currencyCode?.toUpperCase() ?? '') === c);
    }
    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.billNumber?.toLowerCase() ?? '').includes(s) ||
        (o.vendorName?.toLowerCase() ?? '').includes(s)
      );
    }

    // Auto-diagnóstico
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && args.status) {
      const uniqueStatuses = new Map<string, number>();
      for (const o of bills) {
        if (o.status) uniqueStatuses.set(o.status, (uniqueStatuses.get(o.status) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta devolvió 0 resultados. Valores de status disponibles:',
        totalBillsInDateRange: bills.length,
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
        filters: { vendor: args.vendor ?? null, status: args.status ?? null, currency: args.currency ?? null, search: args.search ?? null },
        ...(diagnostic ? { diagnostic } : {}),
        bills: paginated.map((o) => ({
          number: o.billNumber, vendor: o.vendorName, status: o.status,
          date: formatDate(o.date), dueDate: formatDate(o.dueDate),
          total: decimalToString(o.total), balance: decimalToString(o.balance),
          currency: o.currencyCode, vendorCreditsApplied: decimalToString(o.vendorCreditsApplied),
          notes: o.notes,
        })),
      };
    }

    // Group by
    const groups = new Map<string, { count: number; total: number; balance: number; bills: typeof filtered }>();
    for (const o of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'vendor') key = o.vendorName ?? 'SIN PROVEEDOR';
      else if (args.groupBy === 'status') key = o.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'date') key = formatDate(o.date) ?? 'SIN FECHA';
      const g = groups.get(key) ?? { count: 0, total: 0, balance: 0, bills: [] as typeof filtered };
      g.count++; g.total += toNumber(o.total); g.balance += toNumber(o.balance); g.bills.push(o);
      groups.set(key, g);
    }

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key, count: g.count, total: g.total.toFixed(2), balance: g.balance.toFixed(2),
        bills: g.bills.slice(0, 50).map((o) => ({
          number: o.billNumber, vendor: o.vendorName, status: o.status,
          date: formatDate(o.date), total: decimalToString(o.total), balance: decimalToString(o.balance),
        })),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    return {
      mode: 'grouped', groupBy: args.groupBy, groupCount: groups.size,
      totalBills: filtered.length,
      totalRevenue: filtered.reduce((s, o) => s + toNumber(o.total), 0).toFixed(2),
      totalBalance: filtered.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2),
      dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      filters: { vendor: args.vendor ?? null, status: args.status ?? null, currency: args.currency ?? null, search: args.search ?? null },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 4. getBillDetail — Detail by number/ID                             */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getBillDetail',
  description: 'Detalle completo de una factura de compra (bill) por su número o ID interno.',
  category: 'purchases',
  requiredPermission: 'bills.view',
  enabledByDefault: true,
  parameters: z.object({
    billNumber: z.string().min(1).describe('Número de la factura de compra o ID interno.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { billNumber: string };
    const bill = await prisma.bill.findFirst({
      where: {
        OR: [
          { billNumber: { equals: args.billNumber, mode: 'insensitive' } },
          { id: args.billNumber },
        ],
      },
    });
    if (!bill) return { found: false, searchedNumber: args.billNumber };
    return {
      found: true,
      bill: {
        id: bill.id,
        number: bill.billNumber,
        vendor: bill.vendorName,
        status: bill.status,
        date: formatDate(bill.date),
        dueDate: formatDate(bill.dueDate),
        currency: bill.currencyCode,
        subTotal: decimalToString(bill.subTotal),
        taxTotal: decimalToString(bill.taxTotal),
        total: decimalToString(bill.total),
        balance: decimalToString(bill.balance),
        vendorCreditsApplied: decimalToString(bill.vendorCreditsApplied),
        notes: bill.notes,
      },
    };
  },
});

/* ------------------------------------------------------------------ */
/* 5. queryVendorCredits — Universal vendor credits query tool         */
/* ------------------------------------------------------------------ */

const VC_GROUP_BY = ['none', 'vendor', 'status', 'date'] as const;

registerTool({
  name: 'queryVendorCredits',
  description:
    'TOOL UNIVERSAL de créditos de proveedor (vendor credits / notas de crédito). ' +
    'Úsalo para CUALQUIER consulta de notas de crédito recibidas de proveedores. ' +
    'Soporta filtrar por fecha, proveedor (vendor), estado (status) y moneda (currency). ' +
    'Puede agrupar por proveedor, estado o fecha. ' +
    'EJEMPLOS: ' +
    '"créditos de proveedor de esta semana" → queryVendorCredits(dateRange="this_week"). ' +
    '"qué proveedor recibió crédito esta semana" → queryVendorCredits(dateRange="this_week", groupBy="vendor"). ' +
    '"créditos del proveedor X" → queryVendorCredits(vendor="X"). ' +
    '"créditos abiertos" → queryVendorCredits(status="open").',
  category: 'purchases',
  requiredPermission: 'vendor_credits.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    vendor: z.string().optional().describe('Filtrar por nombre del proveedor (búsqueda parcial).'),
    status: z.string().optional().describe(
      'Filtrar por estado (búsqueda parcial). Valores típicos: "open", "closed", "void".'
    ),
    currency: z.string().optional().describe('Filtrar por moneda (ej: "MXN", "USD").'),
    search: z.string().optional().describe('Búsqueda libre en número de crédito, proveedor.'),
    groupBy: z.enum(VC_GROUP_BY).default('none').describe(
      'Agrupar resultados. "none" = lista individual. "vendor" = por proveedor. "status" = por estado. "date" = por fecha.'
    ),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string; dateFrom?: string; dateTo?: string;
      vendor?: string; status?: string; currency?: string; search?: string;
      groupBy: (typeof VC_GROUP_BY)[number]; page: number; pageSize: number;
    };

    const dateWhere = buildDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo, 'date');
    const where: Record<string, unknown> = { ...dateWhere };

    const credits = await prisma.vendorCredit.findMany({
      where: where as never,
      select: {
        id: true,
        vendorCreditNumber: true,
        vendorName: true,
        status: true,
        date: true,
        total: true,
        balance: true,
        currencyCode: true,
        notes: true,
      },
      orderBy: { date: 'desc' },
      take: 1000,
    });

    let filtered = credits;
    if (args.vendor) {
      const v = args.vendor.toLowerCase();
      filtered = filtered.filter((o) => (o.vendorName?.toLowerCase() ?? '').includes(v));
    }
    if (args.status) {
      const s = args.status.toLowerCase();
      filtered = filtered.filter((o) => (o.status?.toLowerCase() ?? '').includes(s));
    }
    if (args.currency) {
      const c = args.currency.toUpperCase();
      filtered = filtered.filter((o) => (o.currencyCode?.toUpperCase() ?? '') === c);
    }
    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.vendorCreditNumber?.toLowerCase() ?? '').includes(s) ||
        (o.vendorName?.toLowerCase() ?? '').includes(s)
      );
    }

    // Auto-diagnóstico
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && args.status) {
      const uniqueStatuses = new Map<string, number>();
      for (const o of credits) {
        if (o.status) uniqueStatuses.set(o.status, (uniqueStatuses.get(o.status) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta devolvió 0 resultados. Valores de status disponibles:',
        totalCreditsInDateRange: credits.length,
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
        filters: { vendor: args.vendor ?? null, status: args.status ?? null, currency: args.currency ?? null, search: args.search ?? null },
        ...(diagnostic ? { diagnostic } : {}),
        credits: paginated.map((o) => ({
          number: o.vendorCreditNumber, vendor: o.vendorName, status: o.status,
          date: formatDate(o.date), total: decimalToString(o.total), balance: decimalToString(o.balance),
          currency: o.currencyCode, notes: o.notes,
        })),
      };
    }

    // Group by
    const groups = new Map<string, { count: number; total: number; balance: number; credits: typeof filtered }>();
    for (const o of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'vendor') key = o.vendorName ?? 'SIN PROVEEDOR';
      else if (args.groupBy === 'status') key = o.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'date') key = formatDate(o.date) ?? 'SIN FECHA';
      const g = groups.get(key) ?? { count: 0, total: 0, balance: 0, credits: [] as typeof filtered };
      g.count++; g.total += toNumber(o.total); g.balance += toNumber(o.balance); g.credits.push(o);
      groups.set(key, g);
    }

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key, count: g.count, total: g.total.toFixed(2), balance: g.balance.toFixed(2),
        credits: g.credits.slice(0, 50).map((o) => ({
          number: o.vendorCreditNumber, vendor: o.vendorName, status: o.status,
          date: formatDate(o.date), total: decimalToString(o.total), balance: decimalToString(o.balance),
        })),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    return {
      mode: 'grouped', groupBy: args.groupBy, groupCount: groups.size,
      totalCredits: filtered.length,
      totalRevenue: filtered.reduce((s, o) => s + toNumber(o.total), 0).toFixed(2),
      totalBalance: filtered.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2),
      dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      filters: { vendor: args.vendor ?? null, status: args.status ?? null, currency: args.currency ?? null, search: args.search ?? null },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 6. getVendorCreditDetail — Detail by number/ID                      */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getVendorCreditDetail',
  description: 'Detalle completo de un crédito de proveedor por su número o ID interno.',
  category: 'purchases',
  requiredPermission: 'vendor_credits.view',
  enabledByDefault: true,
  parameters: z.object({
    vendorCreditNumber: z.string().min(1).describe('Número del crédito de proveedor o ID interno.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { vendorCreditNumber: string };
    const credit = await prisma.vendorCredit.findFirst({
      where: {
        OR: [
          { vendorCreditNumber: { equals: args.vendorCreditNumber, mode: 'insensitive' } },
          { id: args.vendorCreditNumber },
        ],
      },
    });
    if (!credit) return { found: false, searchedNumber: args.vendorCreditNumber };
    return {
      found: true,
      credit: {
        id: credit.id,
        number: credit.vendorCreditNumber,
        vendor: credit.vendorName,
        status: credit.status,
        date: formatDate(credit.date),
        currency: credit.currencyCode,
        total: decimalToString(credit.total),
        balance: decimalToString(credit.balance),
        notes: credit.notes,
      },
    };
  },
});
