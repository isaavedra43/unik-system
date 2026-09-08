import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import {
  resolveDateRange,
  formatDate,
  buildOrderDateWhere,
  buildOrderDateWhereFlexible,
  dateRangeSchema,
} from './date-helpers';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Converts a Decimal-like value to string (preserving precision). */
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
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. getSalesOrdersSummary
registerTool({
  name: 'getSalesOrdersSummary',
  description:
    'Resumen de órdenes de venta: conteo, total, balance, y distribución por método de pago, estado, vendedor y sucursal.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
    paymentMethod: z.string().optional().describe('Valor EXACTO: "EFECTIVO", "EFECTIVO EN BODEGA", o "TRANSFERENCIA". NO uses coincidencia parcial.'),
    status: z.string().optional().describe('Filtrar por estado de orden.'),
    salesperson: z.string().optional(),
    location: z.string().optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      paymentMethod?: string;
      status?: string;
      salesperson?: string;
      location?: string;
    };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const where: Record<string, unknown> = { ...dateWhere };
    if (args.paymentMethod) {
      where.paymentMethod = { equals: args.paymentMethod, mode: "insensitive" };
    }
    if (args.status) {
      where.status = { contains: args.status, mode: 'insensitive' };
    }
    if (args.salesperson) {
      where.salespersonName = { contains: args.salesperson, mode: 'insensitive' };
    }
    if (args.location) {
      where.locationName = { contains: args.location, mode: 'insensitive' };
    }

    const [orders, aggregates] = await Promise.all([
      prisma.salesOrder.findMany({
        where: where as never,
        select: {
          salesOrderNumber: true,
          customerName: true,
          total: true,
          balance: true,
          status: true,
          paymentMethod: true,
          salespersonName: true,
          locationName: true,
          orderDate: true,
        },
        take: 500,
      }),
      prisma.salesOrder.aggregate({
        where: where as never,
        _count: { _all: true },
        _sum: { total: true, balance: true },
      }),
    ]);

    const byPaymentMethod = new Map<string, { count: number; total: number }>();
    const byStatus = new Map<string, { count: number; total: number }>();
    const bySalesperson = new Map<string, { count: number; total: number }>();
    const byLocation = new Map<string, { count: number; total: number }>();

    for (const row of orders) {
      const total = toNumber(row.total);
      const pm = row.paymentMethod ?? 'Sin método';
      const st = row.status ?? 'Sin estado';
      const sp = row.salespersonName ?? 'Sin vendedor';
      const loc = row.locationName ?? 'Sin sucursal';

      const pmEntry = byPaymentMethod.get(pm) ?? { count: 0, total: 0 };
      pmEntry.count++;
      pmEntry.total += total;
      byPaymentMethod.set(pm, pmEntry);

      const stEntry = byStatus.get(st) ?? { count: 0, total: 0 };
      stEntry.count++;
      stEntry.total += total;
      byStatus.set(st, stEntry);

      const spEntry = bySalesperson.get(sp) ?? { count: 0, total: 0 };
      spEntry.count++;
      spEntry.total += total;
      bySalesperson.set(sp, spEntry);

      const locEntry = byLocation.get(loc) ?? { count: 0, total: 0 };
      locEntry.count++;
      locEntry.total += total;
      byLocation.set(loc, locEntry);
    }

    return {
      count: aggregates._count._all,
      total: decimalToString(aggregates._sum.total),
      balance: decimalToString(aggregates._sum.balance),
      byPaymentMethod: [...byPaymentMethod.entries()].map(([method, v]) => ({
        method,
        count: v.count,
        total: v.total.toFixed(2),
      })),
      byStatus: [...byStatus.entries()].map(([status, v]) => ({
        status,
        count: v.count,
        total: v.total.toFixed(2),
      })),
      bySalesperson: [...bySalesperson.entries()].map(([salesperson, v]) => ({
        salesperson,
        count: v.count,
        total: v.total.toFixed(2),
      })),
      byLocation: [...byLocation.entries()].map(([location, v]) => ({
        location,
        count: v.count,
        total: v.total.toFixed(2),
      })),
    };
  },
});

// 2. getCashSales
registerTool({
  name: 'getCashSales',
  description:
    'Ventas en efectivo: conteo, total y lista de órdenes. ' +
    'Por defecto trae solo EFECTIVO (no incluye EFECTIVO EN BODEGA). ' +
    'Si el usuario pide "efectivo en bodega", pasa bodega=true. ' +
    'Si pide "efectivo" sin más, pasa bodega=false (default). ' +
    'NO son lo mismo: EFECTIVO y EFECTIVO EN BODEGA son métodos de pago diferentes.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
    bodega: z.boolean().describe(
      'false = solo EFECTIVO. true = solo EFECTIVO EN BODEGA. ' +
      'Si el usuario pide "efectivo en bodega", pasa true. Si pide solo "efectivo", pasa false.'
    ),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string; bodega: boolean };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    // Exact match: EFECTIVO and EFECTIVO EN BODEGA are DIFFERENT payment methods
    const paymentMethodValue = args.bodega ? 'EFECTIVO EN BODEGA' : 'EFECTIVO';

    const orders = await prisma.salesOrder.findMany({
      where: {
        ...dateWhere,
        paymentMethod: { equals: paymentMethodValue, mode: 'insensitive' },
      } as never,
      select: {
        salesOrderNumber: true,
        customerName: true,
        total: true,
        balance: true,
        status: true,
        orderDate: true,
        paymentMethod: true,
        salespersonName: true,
      },
      orderBy: { orderDate: 'desc' },
      take: 200,
    });

    const total = orders.reduce((s, o) => s + toNumber(o.total), 0);

    return {
      count: orders.length,
      total: total.toFixed(2),
      orders: orders.map((o) => ({
        number: o.salesOrderNumber,
        customer: o.customerName,
        total: decimalToString(o.total),
        balance: decimalToString(o.balance),
        status: o.status,
        date: formatDate(o.orderDate),
        paymentMethod: o.paymentMethod,
        salesperson: o.salespersonName,
      })),
    };
  },
});

// 3. searchSalesOrders
registerTool({
  name: 'searchSalesOrders',
  description: 'Buscar órdenes de venta por filtros simples. Devuelve lista paginada con datos básicos.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
    customer: z.string().optional().describe('Nombre del cliente (búsqueda parcial).'),
    status: z.string().optional(),
    salesperson: z.string().optional(),
    paymentMethod: z.string().optional(),
    location: z.string().optional(),
    search: z.string().optional().describe('Búsqueda libre en número, cliente, referencia.'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      customer?: string;
      status?: string;
      salesperson?: string;
      paymentMethod?: string;
      location?: string;
      search?: string;
      page: number;
      pageSize: number;
    };

    const where: Record<string, unknown> = { ...buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo) };
    if (args.customer) {
      where.customerName = { contains: args.customer, mode: 'insensitive' };
    }
    if (args.status) {
      where.status = { contains: args.status, mode: 'insensitive' };
    }
    if (args.salesperson) {
      where.salespersonName = { contains: args.salesperson, mode: 'insensitive' };
    }
    if (args.paymentMethod) {
      where.paymentMethod = { equals: args.paymentMethod, mode: "insensitive" };
    }
    if (args.location) {
      where.locationName = { contains: args.location, mode: 'insensitive' };
    }
    if (args.search) {
      where.OR = [
        { salesOrderNumber: { contains: args.search, mode: 'insensitive' } },
        { customerName: { contains: args.search, mode: 'insensitive' } },
        { referenceNumber: { contains: args.search, mode: 'insensitive' } },
      ];
    }

    const [orders, total, totalSum, balanceSum] = await Promise.all([
      prisma.salesOrder.findMany({
        where: where as never,
        select: {
          id: true,
          salesOrderNumber: true,
          customerName: true,
          salespersonName: true,
          status: true,
          paymentMethod: true,
          locationName: true,
          total: true,
          balance: true,
          orderDate: true,
        },
        orderBy: { orderDate: 'desc' },
        skip: (args.page - 1) * args.pageSize,
        take: args.pageSize,
      }),
      prisma.salesOrder.count({ where: where as never }),
      prisma.salesOrder.aggregate({ where: where as never, _sum: { total: true } }),
      prisma.salesOrder.aggregate({ where: where as never, _sum: { balance: true } }),
    ]);

    return {
      rows: orders.map((o) => ({
        id: o.id,
        number: o.salesOrderNumber,
        customer: o.customerName,
        salesperson: o.salespersonName,
        status: o.status,
        paymentMethod: o.paymentMethod,
        location: o.locationName,
        total: decimalToString(o.total),
        balance: decimalToString(o.balance),
        date: formatDate(o.orderDate),
      })),
      total,
      page: args.page,
      pageSize: args.pageSize,
      totalPages: Math.ceil(total / args.pageSize),
      totalSum: decimalToString(totalSum._sum.total),
      balanceSum: decimalToString(balanceSum._sum.balance),
    };
  },
});

// 4. getSalesOrderDetail
registerTool({
  name: 'getSalesOrderDetail',
  description: 'Detalle completo de una orden de venta por su número (ej: OV-23282) o ID interno, incluyendo items.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    salesOrderNumber: z.string().min(1).describe('Número de la orden (ej: OV-23282) o ID interno.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { salesOrderNumber: string };
    const order = await prisma.salesOrder.findFirst({
      where: {
        OR: [
          { salesOrderNumber: { equals: args.salesOrderNumber, mode: 'insensitive' } },
          { id: args.salesOrderNumber },
        ],
      },
      include: { items: true },
    });
    if (!order) return { found: false, searchedNumber: args.salesOrderNumber };
    return {
      found: true,
      order: {
        id: order.id,
        number: order.salesOrderNumber,
        customer: order.customerName,
        email: order.customerEmail,
        phone: order.customerPhone,
        salesperson: order.salespersonName,
        status: order.status,
        subStatus: order.subStatus,
        paidStatus: order.paidStatus,
        invoicedStatus: order.invoicedStatus,
        shippedStatus: order.shippedStatus,
        paymentMethod: order.paymentMethod,
        deliveryMethod: order.deliveryMethod,
        location: order.locationName,
        branch: order.branchName,
        orderDate: formatDate(order.orderDate),
        subtotal: decimalToString(order.subtotal),
        discountTotal: decimalToString(order.discountTotal),
        taxTotal: decimalToString(order.taxTotal),
        shippingCharge: decimalToString(order.shippingCharge),
        adjustment: decimalToString(order.adjustment),
        total: decimalToString(order.total),
        balance: decimalToString(order.balance),
        items: order.items.map((it) => ({
          sku: it.sku,
          name: it.name,
          description: it.description,
          quantity: decimalToString(it.quantity),
          rate: decimalToString(it.rate),
          discountAmount: decimalToString(it.discountAmount),
          taxName: it.taxName,
          taxPercentage: decimalToString(it.taxPercentage),
          taxAmount: decimalToString(it.taxAmount),
          lineTotal: decimalToString(it.lineTotal),
          location: it.locationName,
        })),
      },
    };
  },
});

// 5. getTopProducts
registerTool({
  name: 'getTopProducts',
  description: 'Productos más vendidos (desde los items de las órdenes) con cantidad y monto.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string;
      dateFrom?: string;
      dateTo?: string; limit: number };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const items = await prisma.salesOrderItem.findMany({
      where: { salesOrder: dateWhere as never },
      select: { name: true, sku: true, quantity: true, lineTotal: true },
    });

    const byProduct = new Map<string, { quantity: number; total: number; count: number }>();
    for (const item of items) {
      const name = item.name ?? 'Sin nombre';
      const qty = toNumber(item.quantity);
      const total = toNumber(item.lineTotal);
      const entry = byProduct.get(name) ?? { quantity: 0, total: 0, count: 0 };
      entry.quantity += qty;
      entry.total += total;
      entry.count++;
      byProduct.set(name, entry);
    }

    const ranked = [...byProduct.entries()]
      .map(([name, v]) => ({ name, quantity: v.quantity, total: v.total.toFixed(2), orders: v.count }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, args.limit);

    return { topProducts: ranked, totalProducts: byProduct.size };
  },
});

// 6. getSalesBySalesperson
registerTool({
  name: 'getSalesBySalesperson',
  description: 'Ventas agrupadas por vendedor con conteo, total y ticket promedio.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const rows = await prisma.salesOrder.findMany({
      where: dateWhere as never,
      select: { salespersonName: true, total: true },
    });

    const bySp = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const sp = row.salespersonName ?? 'Sin vendedor';
      const total = toNumber(row.total);
      const entry = bySp.get(sp) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += total;
      bySp.set(sp, entry);
    }

    return {
      bySalesperson: [...bySp.entries()]
        .map(([salesperson, v]) => ({
          salesperson,
          count: v.count,
          total: v.total.toFixed(2),
          avgTicket: v.count > 0 ? (v.total / v.count).toFixed(2) : '0',
        }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
    };
  },
});

// 7. getSalesByLocation
registerTool({
  name: 'getSalesByLocation',
  description: 'Ventas agrupadas por sucursal con conteo y total.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const rows = await prisma.salesOrder.findMany({
      where: dateWhere as never,
      select: { locationName: true, total: true },
    });

    const byLoc = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const loc = row.locationName ?? 'Sin sucursal';
      const total = toNumber(row.total);
      const entry = byLoc.get(loc) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += total;
      byLoc.set(loc, entry);
    }

    return {
      byLocation: [...byLoc.entries()]
        .map(([location, v]) => ({ location, count: v.count, total: v.total.toFixed(2) }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
    };
  },
});

// 8. getSalesTrend
registerTool({
  name: 'getSalesTrend',
  description: 'Tendencia de ventas por día, semana o mes. Devuelve serie temporal con conteo y total por punto.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
    granularity: z.enum(['day', 'week', 'month']).default('day'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string;
      dateFrom?: string;
      dateTo?: string; granularity: 'day' | 'week' | 'month' };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const rows = await prisma.salesOrder.findMany({
      where: dateWhere as never,
      select: { orderDate: true, total: true },
    });

    const byBucket = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      if (!row.orderDate) continue;
      const d = new Date(row.orderDate);
      let key: string;
      if (args.granularity === 'day') {
        key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      } else if (args.granularity === 'week') {
        const day = d.getUTCDay();
        const diff = (day + 6) % 7;
        const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
        key = `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
      } else {
        key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      }
      const total = toNumber(row.total);
      const entry = byBucket.get(key) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += total;
      byBucket.set(key, entry);
    }

    return {
      granularity: args.granularity,
      trend: [...byBucket.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, count: v.count, total: v.total.toFixed(2) })),
    };
  },
});

// 9. getSalesByStatus
registerTool({
  name: 'getSalesByStatus',
  description: 'Distribución de órdenes por estado con conteo y total.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const rows = await prisma.salesOrder.findMany({
      where: dateWhere as never,
      select: { status: true, total: true },
    });

    const byStatus = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const st = row.status ?? 'Sin estado';
      const total = toNumber(row.total);
      const entry = byStatus.get(st) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += total;
      byStatus.set(st, entry);
    }

    return {
      byStatus: [...byStatus.entries()]
        .map(([status, v]) => ({ status, count: v.count, total: v.total.toFixed(2) }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
    };
  },
});

// 10. getSalesByPaymentMethod
registerTool({
  name: 'getSalesByPaymentMethod',
  description: 'Distribución de órdenes por método de pago con conteo y total.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const rows = await prisma.salesOrder.findMany({
      where: dateWhere as never,
      select: { paymentMethod: true, total: true },
    });

    const byMethod = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const pm = row.paymentMethod ?? 'Sin método';
      const total = toNumber(row.total);
      const entry = byMethod.get(pm) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += total;
      byMethod.set(pm, entry);
    }

    return {
      byPaymentMethod: [...byMethod.entries()]
        .map(([method, v]) => ({ method, count: v.count, total: v.total.toFixed(2) }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
    };
  },
});

// 11. getOrdersWithBalance
registerTool({
  name: 'getOrdersWithBalance',
  description: 'Órdenes con saldo pendiente (balance > 0). Devuelve lista con cliente, total y balance.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string;
      dateFrom?: string;
      dateTo?: string; limit: number };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const rows = await prisma.salesOrder.findMany({
      where: { ...dateWhere, balance: { gt: 0 } } as never,
      orderBy: { balance: 'desc' },
      take: args.limit,
      select: {
        id: true,
        salesOrderNumber: true,
        customerName: true,
        total: true,
        balance: true,
        status: true,
        orderDate: true,
      },
    });

    return {
      orders: rows.map((r) => ({
        id: r.id,
        number: r.salesOrderNumber,
        customer: r.customerName,
        total: decimalToString(r.total),
        balance: decimalToString(r.balance),
        status: r.status,
        date: formatDate(r.orderDate),
      })),
    };
  },
});
