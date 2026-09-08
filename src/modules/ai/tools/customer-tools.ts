import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { dateToIsoDateOnly } from '@/modules/sales/sales-orders-helpers';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

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
  const day = x.getDay();
  const diff = (day + 6) % 7;
  x.setDate(x.getDate() - diff);
  return x;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

const dateRangeSchema = z.union([
  z.enum(['today', 'yesterday', 'this_week', 'this_month', 'last_7_days', 'last_30_days']),
  z.object({
    from: z.union([z.string(), z.date()]).describe('Fecha inicial (ISO o YYYY-MM-DD)'),
    to: z.union([z.string(), z.date()]).describe('Fecha final (ISO o YYYY-MM-DD)'),
  }),
]);

type DateRangeShortcut =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'last_7_days'
  | 'last_30_days';

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
  const from = typeof range.from === 'string' ? new Date(range.from) : range.from;
  const to = typeof range.to === 'string' ? new Date(range.to) : range.to;
  return { from: startOfDay(from), to: endOfDay(to) };
}

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. getTopCustomers
registerTool({
  name: 'getTopCustomers',
  description:
    'Top clientes por volumen de compras (monto total o número de órdenes) en un rango de fechas. Incluye ticket promedio y última compra.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10),
    sortBy: z.enum(['total', 'orders']).default('total').describe('Ordenar por monto total o número de órdenes.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema>; limit: number; sortBy: 'total' | 'orders' };
    const { from, to } = resolveDateRange(args.dateRange);
    const rows = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: { customerName: true, customerEmail: true, total: true, orderDate: true },
    });
    const byCustomer = new Map<string, { email: string | null; count: number; total: number; lastDate: Date | null }>();
    for (const row of rows) {
      const name = row.customerName ?? 'Sin nombre';
      const entry = byCustomer.get(name) ?? { email: row.customerEmail, count: 0, total: 0, lastDate: null };
      entry.count++;
      entry.total += Number(row.total ?? 0);
      if (!entry.lastDate || (row.orderDate && row.orderDate > entry.lastDate)) {
        entry.lastDate = row.orderDate;
      }
      byCustomer.set(name, entry);
    }
    const ranked = [...byCustomer.entries()]
      .map(([name, v]) => ({
        customer: name,
        email: v.email,
        orders: v.count,
        total: v.total.toFixed(2),
        avgTicket: v.count > 0 ? (v.total / v.count).toFixed(2) : '0',
        lastPurchase: v.lastDate ? dateToIsoDateOnly(v.lastDate) : null,
      }))
      .sort((a, b) => (args.sortBy === 'total' ? Number(b.total) - Number(a.total) : b.orders - a.orders))
      .slice(0, args.limit);
    return { topCustomers: ranked, totalCustomers: byCustomer.size };
  },
});

// 2. getCustomerDetails
registerTool({
  name: 'getCustomerDetails',
  description:
    'Detalles de un cliente específico: historial de compras, total gastado, órdenes, productos comprados, vendedores que lo atendieron.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    customerName: z.string().min(1).describe('Nombre del cliente (búsqueda parcial).'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { customerName: string; limit: number };
    const orders = await prisma.salesOrder.findMany({
      where: { customerName: { contains: args.customerName, mode: 'insensitive' } },
      select: {
        id: true,
        salesOrderNumber: true,
        orderDate: true,
        total: true,
        balance: true,
        status: true,
        paymentMethod: true,
        salespersonName: true,
        locationName: true,
        customerName: true,
        customerEmail: true,
        customerPhone: true,
        items: { select: { name: true, quantity: true, lineTotal: true } },
      },
      orderBy: { orderDate: 'desc' },
      take: args.limit,
    });
    if (orders.length === 0) return { found: false };
    const totalSpent = orders.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const totalBalance = orders.reduce((s, o) => s + Number(o.balance ?? 0), 0);
    const bySalesperson = new Map<string, number>();
    const products = new Map<string, number>();
    for (const o of orders) {
      const sp = o.salespersonName ?? 'Sin vendedor';
      bySalesperson.set(sp, (bySalesperson.get(sp) ?? 0) + 1);
      for (const item of o.items) {
        const name = item.name ?? 'Sin nombre';
        products.set(name, (products.get(name) ?? 0) + Number(item.quantity ?? 0));
      }
    }
    return {
      found: true,
      customer: {
        name: orders[0].customerName ?? args.customerName,
        email: orders[0].customerEmail ?? null,
        phone: orders[0].customerPhone ?? null,
        totalOrders: orders.length,
        totalSpent: totalSpent.toFixed(2),
        totalBalance: totalBalance.toFixed(2),
      },
      bySalesperson: [...bySalesperson.entries()]
        .map(([salesperson, count]) => ({ salesperson, orders: count }))
        .sort((a, b) => b.orders - a.orders),
      topProducts: [...products.entries()]
        .map(([name, qty]) => ({ name, quantity: qty }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 10),
      recentOrders: orders.map((o) => ({
        number: o.salesOrderNumber,
        date: o.orderDate ? dateToIsoDateOnly(o.orderDate) : null,
        total: Number(o.total ?? 0).toFixed(2),
        balance: Number(o.balance ?? 0).toFixed(2),
        status: o.status,
        paymentMethod: o.paymentMethod,
        salesperson: o.salespersonName,
        location: o.locationName,
      })),
    };
  },
});

// 3. getCustomerSegments
registerTool({
  name: 'getCustomerSegments',
  description:
    'Segmentación de clientes por frecuencia de compra: VIP (más de 10 órdenes), recurrentes (3-10), ocasionales (1-2). Útil para marketing y retención.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema> };
    const { from, to } = resolveDateRange(args.dateRange ?? 'last_30_days');
    const rows = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: { customerName: true, total: true },
    });
    const byCustomer = new Map<string, { count: number; total: number }>();
    for (const row of rows) {
      const name = row.customerName ?? 'Sin nombre';
      const entry = byCustomer.get(name) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += Number(row.total ?? 0);
      byCustomer.set(name, entry);
    }
    const vip: string[] = [];
    const recurrent: string[] = [];
    const occasional: string[] = [];
    for (const [name, v] of byCustomer) {
      if (v.count > 10) vip.push(name);
      else if (v.count >= 3) recurrent.push(name);
      else occasional.push(name);
    }
    return {
      segments: {
        vip: { count: vip.length, customers: vip.slice(0, 20) },
        recurrent: { count: recurrent.length, customers: recurrent.slice(0, 20) },
        occasional: { count: occasional.length, customers: occasional.slice(0, 20) },
      },
      totalCustomers: byCustomer.size,
    };
  },
});
