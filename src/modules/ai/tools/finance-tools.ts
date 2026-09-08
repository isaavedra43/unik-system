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

// 1. getAccountsReceivable
registerTool({
  name: 'getAccountsReceivable',
  description:
    'Cuentas por cobrar: órdenes con balance pendiente (no pagadas o parcialmente pagadas). Incluye total por cobrar, clientes deudores y antigüedad.',
  category: 'finance',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    status: z.string().optional().describe('Filtrar por estado (ej: "Open").'),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { status?: string; limit: number };
    const where: Record<string, unknown> = {
      balance: { gt: 0 },
    };
    if (args.status) {
      where.status = { contains: args.status, mode: 'insensitive' };
    }
    const orders = await prisma.salesOrder.findMany({
      where: where as never,
      select: {
        salesOrderNumber: true,
        customerName: true,
        orderDate: true,
        total: true,
        balance: true,
        status: true,
        paidStatus: true,
        salespersonName: true,
      },
      orderBy: { orderDate: 'asc' },
      take: args.limit,
    });
    const totalBalance = orders.reduce((s, o) => s + Number(o.balance ?? 0), 0);
    const now = new Date();
    const byCustomer = new Map<string, { balance: number; orders: number }>();
    const byAge = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
    for (const o of orders) {
      const name = o.customerName ?? 'Sin nombre';
      const entry = byCustomer.get(name) ?? { balance: 0, orders: 0 };
      entry.balance += Number(o.balance ?? 0);
      entry.orders++;
      byCustomer.set(name, entry);
      if (o.orderDate) {
        const days = Math.floor((now.getTime() - new Date(o.orderDate).getTime()) / (1000 * 60 * 60 * 24));
        const bal = Number(o.balance ?? 0);
        if (days <= 30) byAge.current += bal;
        else if (days <= 60) byAge.days30 += bal;
        else if (days <= 90) byAge.days60 += bal;
        else if (days <= 120) byAge.days90 += bal;
        else byAge.over90 += bal;
      }
    }
    return {
      totalReceivable: totalBalance.toFixed(2),
      totalOrders: orders.length,
      byAge: {
        current: byAge.current.toFixed(2),
        days31_60: byAge.days30.toFixed(2),
        days61_90: byAge.days60.toFixed(2),
        days91_120: byAge.days90.toFixed(2),
        over120: byAge.over90.toFixed(2),
      },
      topDebtors: [...byCustomer.entries()]
        .map(([customer, v]) => ({ customer, balance: v.balance.toFixed(2), orders: v.orders }))
        .sort((a, b) => Number(b.balance) - Number(a.balance))
        .slice(0, 10),
      orders: orders.map((o) => ({
        number: o.salesOrderNumber,
        customer: o.customerName,
        date: o.orderDate ? dateToIsoDateOnly(o.orderDate) : null,
        total: Number(o.total ?? 0).toFixed(2),
        balance: Number(o.balance ?? 0).toFixed(2),
        status: o.status,
        paidStatus: o.paidStatus,
        salesperson: o.salespersonName,
      })),
    };
  },
});

// 2. getRevenueAnalysis
registerTool({
  name: 'getRevenueAnalysis',
  description:
    'Análisis de ingresos: total facturado, total cobrado, pendiente por cobrar, descuentos aplicados e impuestos. Desglose por método de pago.',
  category: 'finance',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema> };
    const { from, to } = resolveDateRange(args.dateRange);
    const orders = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: {
        total: true,
        balance: true,
        discountTotal: true,
        taxTotal: true,
        subtotal: true,
        paymentMethod: true,
        paidStatus: true,
      },
    });
    const totalBilled = orders.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const totalCollected = orders.reduce((s, o) => s + (Number(o.total ?? 0) - Number(o.balance ?? 0)), 0);
    const totalPending = orders.reduce((s, o) => s + Number(o.balance ?? 0), 0);
    const totalDiscount = orders.reduce((s, o) => s + Number(o.discountTotal ?? 0), 0);
    const totalTax = orders.reduce((s, o) => s + Number(o.taxTotal ?? 0), 0);
    const totalSubtotal = orders.reduce((s, o) => s + Number(o.subtotal ?? 0), 0);
    const byPaymentMethod = new Map<string, { count: number; total: number }>();
    for (const o of orders) {
      const pm = o.paymentMethod ?? 'Sin método';
      const entry = byPaymentMethod.get(pm) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += Number(o.total ?? 0);
      byPaymentMethod.set(pm, entry);
    }
    return {
      summary: {
        totalBilled: totalBilled.toFixed(2),
        totalCollected: totalCollected.toFixed(2),
        totalPending: totalPending.toFixed(2),
        collectionRate: totalBilled > 0 ? ((totalCollected / totalBilled) * 100).toFixed(1) + '%' : '0%',
        totalDiscount: totalDiscount.toFixed(2),
        totalTax: totalTax.toFixed(2),
        totalSubtotal: totalSubtotal.toFixed(2),
        orderCount: orders.length,
      },
      byPaymentMethod: [...byPaymentMethod.entries()]
        .map(([method, v]) => ({ method, count: v.count, total: v.total.toFixed(2) }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
    };
  },
});

// 3. getDailyRevenue
registerTool({
  name: 'getDailyRevenue',
  description:
    'Ingresos diarios: desglose día por día del total facturado, cobrado y pendiente. Útil para ver la evolución de ingresos.',
  category: 'finance',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema> };
    const { from, to } = resolveDateRange(args.dateRange ?? 'last_30_days');
    const orders = await prisma.salesOrder.findMany({
      where: { orderDate: { gte: from, lte: to } },
      select: { orderDate: true, total: true, balance: true },
    });
    const byDay = new Map<string, { billed: number; collected: number; pending: number; count: number }>();
    for (const o of orders) {
      if (!o.orderDate) continue;
      const key = dateToIsoDateOnly(o.orderDate) ?? 'Sin fecha';
      const entry = byDay.get(key) ?? { billed: 0, collected: 0, pending: 0, count: 0 };
      entry.billed += Number(o.total ?? 0);
      entry.collected += Number(o.total ?? 0) - Number(o.balance ?? 0);
      entry.pending += Number(o.balance ?? 0);
      entry.count++;
      byDay.set(key, entry);
    }
    return {
      dailyRevenue: [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({
          date,
          billed: v.billed.toFixed(2),
          collected: v.collected.toFixed(2),
          pending: v.pending.toFixed(2),
          orders: v.count,
        })),
    };
  },
});
