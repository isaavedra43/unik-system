import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import {
  getSalesOrdersWorkspace,
  getSalesOrderById,
} from '@/modules/sales/sales-orders-service';
import {
  salesOrderQueryStateSchema,
  type SalesOrderQueryState,
} from '@/modules/sales/sales-orders-filters';
import { dateToIsoDateOnly } from '@/modules/sales/sales-orders-helpers';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

type DateRangeShortcut =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'last_7_days'
  | 'last_30_days';

const dateRangeSchema = z.union([
  z.enum(['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days']),
  z.object({
    from: z.union([z.string(), z.date()]).describe('Fecha inicial (ISO o YYYY-MM-DD)'),
    to: z.union([z.string(), z.date()]).describe('Fecha final (ISO o YYYY-MM-DD)'),
  }),
]);

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay(); // 0 = Sunday
  const diff = (day + 6) % 7; // Lunes como inicio
  x.setDate(x.getDate() - diff);
  return x;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function resolveDateRange(range: DateRangeShortcut | { from: string | Date; to: string | Date } | undefined): {
  from: Date;
  to: Date;
} {
  const now = new Date();
  if (range === undefined || range === 'today') {
    return { from: startOfDay(now), to: endOfDay(now) };
  }
  if (range === 'yesterday') {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { from: startOfDay(y), to: endOfDay(y) };
  }
  if (range === 'this_week') {
    return { from: startOfWeek(now), to: endOfDay(now) };
  }
  if (range === 'this_month') {
    return { from: startOfMonth(now), to: endOfDay(now) };
  }
  if (range === 'last_7_days') {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { from: startOfDay(from), to: endOfDay(now) };
  }
  if (range === 'last_30_days') {
    const from = new Date(now);
    from.setDate(from.getDate() - 29);
    return { from: startOfDay(from), to: endOfDay(now) };
  }
  // Custom {from, to}
  const from = typeof range.from === 'string' ? new Date(range.from) : range.from;
  const to = typeof range.to === 'string' ? new Date(range.to) : range.to;
  return { from: startOfDay(from), to: endOfDay(to) };
}

/** Builds a workspace query input that passes salesOrderQueryStateSchema. */
function buildQueryInput(opts: {
  search?: string;
  filters?: Array<Record<string, unknown>>;
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  page?: number;
  page_size?: number;
}): unknown {
  return {
    search: opts.search ?? '',
    filters: {
      logic: 'AND',
      rules: opts.filters ?? [],
    },
    sort: opts.sort ?? [{ field: 'orderDate', direction: 'desc' }],
    page: opts.page ?? 1,
    page_size: opts.page_size ?? 50,
  };
}

/** Converts a Decimal-like value to string (preserving precision). */
function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String(value);
  }
  return String(value);
}

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. getSalesOrdersSummary
registerTool({
  name: 'getSalesOrdersSummary',
  description:
    'Resumen de órdenes de venta: conteo, total, balance, y distribución por método de pago, estado, vendedor y sucursal en un rango de fechas.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional().describe('Rango de fechas. Default: hoy.'),
    paymentMethod: z.string().optional().describe('Filtrar por método de pago (ej: "Efectivo").'),
    status: z.string().optional().describe('Filtrar por estado de orden.'),
    salesperson: z.string().optional(),
    location: z.string().optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange?: z.infer<typeof dateRangeSchema>;
      paymentMethod?: string;
      status?: string;
      salesperson?: string;
      location?: string;
    };
    const { from, to } = resolveDateRange(args.dateRange);

    const filters: Array<Record<string, unknown>> = [
      { field: 'orderDate', operator: 'between', value: dateToIsoDateOnly(from) ?? '', valueTo: dateToIsoDateOnly(to) ?? '' },
    ];
    if (args.paymentMethod) {
      filters.push({ field: 'paymentMethod', operator: 'contains', value: args.paymentMethod });
    }
    if (args.status) {
      filters.push({ field: 'status', operator: 'contains', value: args.status });
    }
    if (args.salesperson) {
      filters.push({ field: 'salespersonName', operator: 'contains', value: args.salesperson });
    }
    if (args.location) {
      filters.push({ field: 'locationName', operator: 'contains', value: args.location });
    }

    const queryInput = buildQueryInput({ filters, page_size: 500 });
    const query: SalesOrderQueryState = salesOrderQueryStateSchema.parse(queryInput);
    const result = await getSalesOrdersWorkspace(query);

    // Group by paymentMethod, status, salesperson, location from the returned rows
    const byPaymentMethod = new Map<string, { count: number; total: number }>();
    const byStatus = new Map<string, { count: number; total: number }>();
    const bySalesperson = new Map<string, { count: number; total: number }>();
    const byLocation = new Map<string, { count: number; total: number }>();

    for (const row of result.data) {
      const total = Number(row.total ?? 0);
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
      count: result.aggregates.count,
      total: result.aggregates.total_sum,
      balance: result.aggregates.balance_sum,
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

// 2. getCashSalesToday
registerTool({
  name: 'getCashSalesToday',
  description: 'Ventas en efectivo del día de hoy: conteo, total y lista de órdenes.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({}).describe('Sin parámetros. Usa la fecha de hoy.'),
  execute: async () => {
    const { from, to } = resolveDateRange('today');
    const filters: Array<Record<string, unknown>> = [
      { field: 'orderDate', operator: 'between', value: dateToIsoDateOnly(from) ?? '', valueTo: dateToIsoDateOnly(to) ?? '' },
      { field: 'paymentMethod', operator: 'contains', value: 'fectivo' },
    ];
    const queryInput = buildQueryInput({ filters, page_size: 100 });
    const query: SalesOrderQueryState = salesOrderQueryStateSchema.parse(queryInput);
    const result = await getSalesOrdersWorkspace(query);

    return {
      count: result.aggregates.count,
      total: result.aggregates.total_sum,
      orders: result.data.map((o) => ({
        number: o.salesOrderNumber,
        customer: o.customerName,
        total: o.total,
        status: o.status,
        date: o.orderDate,
        paymentMethod: o.paymentMethod,
      })),
    };
  },
});

// 3. searchSalesOrders
registerTool({
  name: 'searchSalesOrders',
  description:
    'Buscar órdenes de venta por filtros simples. Devuelve lista paginada con datos básicos.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    customer: z.string().optional().describe('Nombre del cliente (búsqueda parcial).'),
    status: z.string().optional(),
    salesperson: z.string().optional(),
    paymentMethod: z.string().optional(),
    location: z.string().optional(),
    dateFrom: z.string().optional().describe('Fecha inicial YYYY-MM-DD'),
    dateTo: z.string().optional().describe('Fecha final YYYY-MM-DD'),
    search: z.string().optional().describe('Búsqueda libre en número, cliente, referencia.'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      customer?: string;
      status?: string;
      salesperson?: string;
      paymentMethod?: string;
      location?: string;
      dateFrom?: string;
      dateTo?: string;
      search?: string;
      page: number;
      pageSize: number;
    };

    const filters: Array<Record<string, unknown>> = [];
    if (args.dateFrom && args.dateTo) {
      filters.push({
        field: 'orderDate',
        operator: 'between',
        value: args.dateFrom,
        valueTo: args.dateTo,
      });
    }
    if (args.customer) {
      filters.push({ field: 'customerName', operator: 'contains', value: args.customer });
    }
    if (args.status) {
      filters.push({ field: 'status', operator: 'contains', value: args.status });
    }
    if (args.salesperson) {
      filters.push({ field: 'salespersonName', operator: 'contains', value: args.salesperson });
    }
    if (args.paymentMethod) {
      filters.push({ field: 'paymentMethod', operator: 'contains', value: args.paymentMethod });
    }
    if (args.location) {
      filters.push({ field: 'locationName', operator: 'contains', value: args.location });
    }

    const queryInput = buildQueryInput({
      search: args.search,
      filters,
      page: args.page,
      page_size: args.pageSize,
    });
    const query: SalesOrderQueryState = salesOrderQueryStateSchema.parse(queryInput);
    const result = await getSalesOrdersWorkspace(query);

    return {
      rows: result.data.map((o) => ({
        number: o.salesOrderNumber,
        customer: o.customerName,
        salesperson: o.salespersonName,
        status: o.status,
        paymentMethod: o.paymentMethod,
        location: o.locationName,
        total: o.total,
        balance: o.balance,
        date: o.orderDate,
      })),
      total: result.pagination.total,
      page: result.pagination.page,
      pageSize: result.pagination.page_size,
      totalPages: result.pagination.total_pages,
      totalSum: result.aggregates.total_sum,
      balanceSum: result.aggregates.balance_sum,
    };
  },
});

// 4. getSalesOrderDetail
registerTool({
  name: 'getSalesOrderDetail',
  description: 'Detalle completo de una orden de venta por su ID interno, incluyendo items.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    salesOrderId: z.string().min(1).describe('ID interno de la orden de venta.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { salesOrderId: string };
    const order = await getSalesOrderById(args.salesOrderId);
    if (!order) return { found: false };
    return { found: true, order };
  },
});

// 5. getTopProducts
registerTool({
  name: 'getTopProducts',
  description:
    'Productos más vendidos (desde los items de las órdenes) con cantidad y monto. Opcionalmente filtrado por rango de fechas.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema>; limit: number };
    const { from, to } = resolveDateRange(args.dateRange);

    const items = await prisma.salesOrderItem.findMany({
      where: {
        salesOrder: { orderDate: { gte: from, lte: to } },
      },
      select: {
        name: true,
        quantity: true,
        lineTotal: true,
      },
    });

    const byProduct = new Map<string, { quantity: number; total: number; count: number }>();
    for (const item of items) {
      const name = item.name ?? 'Sin nombre';
      const qty = Number(item.quantity ?? 0);
      const total = Number(item.lineTotal ?? 0);
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
    dateRange: dateRangeSchema.optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema> };
    const { from, to } = resolveDateRange(args.dateRange);

    const rows = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: { salespersonName: true, total: true },
    });

    const bySp = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const sp = row.salespersonName ?? 'Sin vendedor';
      const total = Number(row.total ?? 0);
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
    dateRange: dateRangeSchema.optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema> };
    const { from, to } = resolveDateRange(args.dateRange);

    const rows = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: { locationName: true, total: true },
    });

    const byLoc = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const loc = row.locationName ?? 'Sin sucursal';
      const total = Number(row.total ?? 0);
      const entry = byLoc.get(loc) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += total;
      byLoc.set(loc, entry);
    }

    return {
      byLocation: [...byLoc.entries()]
        .map(([location, v]) => ({
          location,
          count: v.count,
          total: v.total.toFixed(2),
        }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
    };
  },
});

// 8. getSalesTrend
registerTool({
  name: 'getSalesTrend',
  description:
    'Tendencia de ventas por día, semana o mes. Devuelve serie temporal con conteo y total por punto.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional(),
    granularity: z.enum(['day', 'week', 'month']).default('day'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema>; granularity: 'day' | 'week' | 'month' };
    const { from, to } = resolveDateRange(args.dateRange ?? 'last_30_days');

    const rows = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: { orderDate: true, total: true },
    });

    const byBucket = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      if (!row.orderDate) continue;
      const d = new Date(row.orderDate);
      let key: string;
      if (args.granularity === 'day') {
        key = d.toISOString().slice(0, 10);
      } else if (args.granularity === 'week') {
        const weekStart = startOfWeek(d);
        key = weekStart.toISOString().slice(0, 10);
      } else {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
      const total = Number(row.total ?? 0);
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
    dateRange: dateRangeSchema.optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema> };
    const { from, to } = resolveDateRange(args.dateRange);

    const rows = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: { status: true, total: true },
    });

    const byStatus = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const st = row.status ?? 'Sin estado';
      const total = Number(row.total ?? 0);
      const entry = byStatus.get(st) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += total;
      byStatus.set(st, entry);
    }

    return {
      byStatus: [...byStatus.entries()]
        .map(([status, v]) => ({
          status,
          count: v.count,
          total: v.total.toFixed(2),
        }))
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
    dateRange: dateRangeSchema.optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema> };
    const { from, to } = resolveDateRange(args.dateRange);

    const rows = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: { paymentMethod: true, total: true },
    });

    const byMethod = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const pm = row.paymentMethod ?? 'Sin método';
      const total = Number(row.total ?? 0);
      const entry = byMethod.get(pm) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += total;
      byMethod.set(pm, entry);
    }

    return {
      byPaymentMethod: [...byMethod.entries()]
        .map(([method, v]) => ({
          method,
          count: v.count,
          total: v.total.toFixed(2),
        }))
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
    dateRange: dateRangeSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema>; limit: number };
    const { from, to } = resolveDateRange(args.dateRange);

    const rows = await prisma.salesOrder.findMany({
      where: {
        orderDate: { gte: from, lte: to },
        balance: { gt: 0 },
      },
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
        date: r.orderDate,
      })),
    };
  },
});
