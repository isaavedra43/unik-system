import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { resolveDateRange, dateRangeSchema, formatDate, buildOrderDateWhere } from './date-helpers';

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. comparePeriods
registerTool({
  name: 'comparePeriods',
  description:
    'Compara dos períodos de tiempo: ventas totales, número de órdenes, ticket promedio y crecimiento porcentual. Útil para ver si las ventas subieron o bajaron vs el período anterior.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    period1: dateRangeSchema.describe('Primer período a comparar.'),
    period2: dateRangeSchema.describe('Segundo período a comparar.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { period1: string; period2: string };
    const r1 = resolveDateRange(args.period1);
    const r2 = resolveDateRange(args.period2);
    const [orders1, orders2] = await Promise.all([
      prisma.salesOrder.findMany({
        where: buildOrderDateWhere(args.period1) as never,
        select: { total: true },
      }),
      prisma.salesOrder.findMany({
        where: buildOrderDateWhere(args.period2) as never,
        select: { total: true },
      }),
    ]);
    const total1 = orders1.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const total2 = orders2.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const count1 = orders1.length;
    const count2 = orders2.length;
    const avg1 = count1 > 0 ? total1 / count1 : 0;
    const avg2 = count2 > 0 ? total2 / count2 : 0;
    const growth = total1 > 0 ? ((total2 - total1) / total1) * 100 : 0;
    const countGrowth = count1 > 0 ? ((count2 - count1) / count1) * 100 : 0;
    return {
      period1: {
        from: formatDate(r1.from),
        to: formatDate(r1.to),
        totalSales: total1.toFixed(2),
        orderCount: count1,
        avgTicket: avg1.toFixed(2),
      },
      period2: {
        from: formatDate(r2.from),
        to: formatDate(r2.to),
        totalSales: total2.toFixed(2),
        orderCount: count2,
        avgTicket: avg2.toFixed(2),
      },
      comparison: {
        salesGrowth: growth.toFixed(1) + '%',
        orderCountGrowth: countGrowth.toFixed(1) + '%',
        salesDifference: (total2 - total1).toFixed(2),
        ordersDifference: count2 - count1,
      },
    };
  },
});

// 2. getSalesRanking
registerTool({
  name: 'getSalesRanking',
  description:
    'Ranking general de ventas por dimensión (vendedor, sucursal, cliente, producto, método de pago). Devuelve top N con porcentaje del total.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dimension: z.enum(['salesperson', 'location', 'customer', 'product', 'paymentMethod'])
      .describe('Dimensión para el ranking.'),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dimension: 'salesperson' | 'location' | 'customer' | 'product' | 'paymentMethod';
      limit: number;
    };
    const dateWhere = buildOrderDateWhere(args.dateRange);
    if (args.dimension === 'product') {
      const items = await prisma.salesOrderItem.findMany({
        where: { salesOrder: dateWhere } as never,
        select: { name: true, lineTotal: true, quantity: true },
      });
      const byProduct = new Map<string, { total: number; qty: number }>();
      for (const i of items) {
        const name = i.name ?? 'Sin nombre';
        const entry = byProduct.get(name) ?? { total: 0, qty: 0 };
        entry.total += Number(i.lineTotal ?? 0);
        entry.qty += Number(i.quantity ?? 0);
        byProduct.set(name, entry);
      }
      const grandTotal = [...byProduct.values()].reduce((s, v) => s + v.total, 0);
      return {
        dimension: 'product',
        ranking: [...byProduct.entries()]
          .map(([name, v]) => ({
            name,
            total: v.total.toFixed(2),
            quantity: v.qty,
            percentage: grandTotal > 0 ? ((v.total / grandTotal) * 100).toFixed(1) + '%' : '0%',
          }))
          .sort((a, b) => Number(b.total) - Number(a.total))
          .slice(0, args.limit),
      };
    }
    const selectMap: Record<string, string> = {
      salesperson: 'salespersonName',
      location: 'locationName',
      customer: 'customerName',
      paymentMethod: 'paymentMethod',
    };
    const fieldName = selectMap[args.dimension];
    const orders = (await prisma.salesOrder.findMany({
      where: dateWhere as never,
      select: { [fieldName]: true, total: true } as never,
    })) as Array<Record<string, unknown>>;
    const byDim = new Map<string, { total: number; count: number }>();
    for (const o of orders) {
      const key = o[fieldName] as string | null;
      const name = key ?? 'Sin nombre';
      const entry = byDim.get(name) ?? { total: 0, count: 0 };
      entry.total += Number(o.total ?? 0);
      entry.count++;
      byDim.set(name, entry);
    }
    const grandTotal = [...byDim.values()].reduce((s, v) => s + v.total, 0);
    return {
      dimension: args.dimension,
      ranking: [...byDim.entries()]
        .map(([name, v]) => ({
          name,
          total: v.total.toFixed(2),
          orders: v.count,
          percentage: grandTotal > 0 ? ((v.total / grandTotal) * 100).toFixed(1) + '%' : '0%',
        }))
        .sort((a, b) => Number(b.total) - Number(a.total))
        .slice(0, args.limit),
    };
  },
});

// 3. getSalesKPIs
registerTool({
  name: 'getSalesKPIs',
  description:
    'KPIs principales de ventas: total, número de órdenes, ticket promedio, tasa de cobranza, productos únicos vendidos, clientes únicos, comparación vs período anterior.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string };
    const { from, to } = resolveDateRange(args.dateRange);
    const dateWhere = buildOrderDateWhere(args.dateRange);
    // Período anterior (mismo número de días antes)
    let prevFrom: Date | null = null;
    let prevTo: Date | null = null;
    if (from && to) {
      const days = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
      prevFrom = new Date(from);
      prevFrom.setDate(prevFrom.getDate() - days);
      prevTo = new Date(from);
      prevTo.setDate(prevTo.getDate() - 1);
    }
    const [current, previous, items] = await Promise.all([
      prisma.salesOrder.findMany({
        where: dateWhere as never,
        select: { total: true, balance: true, customerName: true },
      }),
      prisma.salesOrder.findMany({
        where: prevFrom && prevTo ? { orderDate: { gte: prevFrom, lte: prevTo } } : {},
        select: { total: true },
      }),
      prisma.salesOrderItem.findMany({
        where: { salesOrder: dateWhere } as never,
        select: { name: true, sku: true },
      }),
    ]);
    const totalSales = current.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const orderCount = current.length;
    const avgTicket = orderCount > 0 ? totalSales / orderCount : 0;
    const totalCollected = current.reduce((s, o) => s + (Number(o.total ?? 0) - Number(o.balance ?? 0)), 0);
    const collectionRate = totalSales > 0 ? (totalCollected / totalSales) * 100 : 0;
    const uniqueCustomers = new Set(current.map((o) => o.customerName)).size;
    const uniqueProducts = new Set(items.map((i) => i.sku ?? i.name)).size;
    const prevTotal = previous.reduce((s, o) => s + Number(o.total ?? 0), 0);
    const prevCount = previous.length;
    const salesGrowth = prevTotal > 0 ? ((totalSales - prevTotal) / prevTotal) * 100 : 0;
    const orderGrowth = prevCount > 0 ? ((orderCount - prevCount) / prevCount) * 100 : 0;
    return {
      period: { from: formatDate(from), to: formatDate(to) },
      kpis: {
        totalSales: totalSales.toFixed(2),
        orderCount,
        avgTicket: avgTicket.toFixed(2),
        collectionRate: collectionRate.toFixed(1) + '%',
        uniqueCustomers,
        uniqueProducts,
      },
      vsPrevious: {
        period: { from: formatDate(prevFrom), to: formatDate(prevTo) },
        totalSales: prevTotal.toFixed(2),
        orderCount: prevCount,
        salesGrowth: salesGrowth.toFixed(1) + '%',
        orderGrowth: orderGrowth.toFixed(1) + '%',
      },
    };
  },
});

// 4. getHourlySalesPattern
registerTool({
  name: 'getHourlySalesPattern',
  description:
    'Patrón de ventas por hora del día: en qué horas se hacen más órdenes. Útil para optimizar horarios de personal.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string };
    const dateWhere = buildOrderDateWhere(args.dateRange);
    const orders = await prisma.salesOrder.findMany({
      where: { ...dateWhere, createdTime: { not: null } } as never,
      select: { createdTime: true, total: true },
    });
    const byHour = new Map<number, { count: number; total: number }>();
    for (let h = 0; h < 24; h++) byHour.set(h, { count: 0, total: 0 });
    for (const o of orders) {
      if (!o.createdTime) continue;
      const hour = new Date(o.createdTime).getHours();
      const entry = byHour.get(hour) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += Number(o.total ?? 0);
      byHour.set(hour, entry);
    }
    return {
      hourlyPattern: [...byHour.entries()]
        .map(([hour, v]) => ({
          hour: `${String(hour).padStart(2, '0')}:00`,
          orders: v.count,
          total: v.total.toFixed(2),
        })),
      peakHour: [...byHour.entries()].sort((a, b) => b[1].count - a[1].count)[0]?.[0] ?? null,
    };
  },
});

// 5. getWeekdaySalesPattern
registerTool({
  name: 'getWeekdaySalesPattern',
  description:
    'Patrón de ventas por día de la semana: qué días se venden más. Útil para planificar inventario y personal.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string };
    const dateWhere = buildOrderDateWhere(args.dateRange);
    const orders = await prisma.salesOrder.findMany({
      where: dateWhere as never,
      select: { orderDate: true, total: true },
    });
    const weekdays = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    const byWeekday = new Map<number, { count: number; total: number }>();
    for (let d = 0; d < 7; d++) byWeekday.set(d, { count: 0, total: 0 });
    for (const o of orders) {
      if (!o.orderDate) continue;
      const day = new Date(o.orderDate).getDay();
      const entry = byWeekday.get(day) ?? { count: 0, total: 0 };
      entry.count++;
      entry.total += Number(o.total ?? 0);
      byWeekday.set(day, entry);
    }
    return {
      weekdayPattern: [...byWeekday.entries()]
        .map(([day, v]) => ({
          weekday: weekdays[day],
          orders: v.count,
          total: v.total.toFixed(2),
        })),
      bestDay: [...byWeekday.entries()].sort((a, b) => b[1].total - a[1].total)[0]?.[0] ?? null,
    };
  },
});
