import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import {
  resolveDateRange,
  formatDate,
  buildOrderDateWhereFlexible,
  dateRangeSchema,
} from './date-helpers';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return Number(String(value));
  }
  return Number(value);
}

function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String(value);
  }
  return String(value);
}

/* ------------------------------------------------------------------ */
/* 1. getOrderItems — Items de una orden específica                  */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getOrderItems',
  description:
    'Obtiene los items (line items) de una orden de venta específica por su número (ej: OV-23131). Devuelve SKU, nombre, cantidad, precio unitario, descuento, impuesto y total por línea.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    salesOrderNumber: z
      .string()
      .describe('Número de la orden (ej: "OV-23131"). Puede ser el número o el ID interno.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { salesOrderNumber: string };

    const order = await prisma.salesOrder.findFirst({
      where: {
        OR: [{ salesOrderNumber: args.salesOrderNumber }, { id: args.salesOrderNumber }],
      },
      select: {
        id: true,
        salesOrderNumber: true,
        customerName: true,
        total: true,
        subtotal: true,
        discountTotal: true,
        taxTotal: true,
        items: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!order) {
      return { error: `No se encontró la orden ${args.salesOrderNumber}` };
    }

    return {
      orderNumber: order.salesOrderNumber,
      customer: order.customerName,
      subtotal: decimalToString(order.subtotal),
      discount: decimalToString(order.discountTotal),
      tax: decimalToString(order.taxTotal),
      total: decimalToString(order.total),
      items: order.items.map((item) => ({
        sku: item.sku,
        name: item.name,
        description: item.description,
        quantity: decimalToString(item.quantity),
        unit: item.unit,
        rate: decimalToString(item.rate),
        discountAmount: decimalToString(item.discountAmount),
        taxName: item.taxName,
        taxPercentage: decimalToString(item.taxPercentage),
        taxAmount: decimalToString(item.taxAmount),
        lineTotal: decimalToString(item.lineTotal),
      })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* 2. getNotifications — Notificaciones del usuario                  */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getNotifications',
  description:
    'Lista las notificaciones del usuario actual. Incluye alertas de cambios en órdenes, saldos pendientes, etc. Puede filtrar solo no leídas.',
  category: 'system',
  requiredPermission: undefined,
  enabledByDefault: true,
  parameters: z.object({
    unreadOnly: z
      .boolean()
      .default(false)
      .describe('true = solo no leídas, false = todas. Default: false.'),
    limit: z.number().min(1).max(50).default(20).describe('Número máximo de notificaciones (1-50). Default: 20.'),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { unreadOnly: boolean; limit: number };

    const where = {
      userId: actor.id,
      ...(args.unreadOnly ? { readAt: null } : {}),
    };

    const notifications = await prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: args.limit,
    });

    return {
      total: notifications.length,
      unread: notifications.filter((n) => n.readAt === null).length,
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        entityType: n.entityType,
        entityId: n.entityId,
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* 3. getIntegrationStatus — Estado de integraciones                 */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getIntegrationStatus',
  description:
    'Estado de las integraciones del sistema (Zoho, etc.). Muestra última sincronización, registros pendientes, errores recientes y salud general.',
  category: 'system',
  requiredPermission: undefined,
  enabledByDefault: true,
  parameters: z.object({}),
  execute: async () => {
    // Get integration configs
    const configs = await prisma.integrationConfig.findMany();
    // Get entity states summary
    const entityStates = await prisma.integrationEntityState.groupBy({
      by: ['source', 'entityType'],
      _count: { id: true },
      _max: { lastSeenAt: true },
      where: { needsSync: true },
    });

    // Get recent sync runs
    const recentSyncs = await prisma.integrationSyncRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 10,
    });

    // Get recent API call errors
    const recentErrors = await prisma.integrationApiCall.findMany({
      where: { success: false },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        source: true,
        method: true,
        path: true,
        httpStatus: true,
        errorCode: true,
        createdAt: true,
      },
    });

    return {
      integrations: configs.map((c) => ({
        source: c.source,
        displayName: c.displayName,
        isEnabled: c.isEnabled,
      })),
      pendingSync: entityStates.map((e) => ({
        source: e.source,
        entityType: e.entityType,
        pendingRecords: e._count.id,
        lastSeen: e._max.lastSeenAt?.toISOString() ?? null,
      })),
      recentSyncs: recentSyncs.map((s) => ({
        source: s.source,
        entityType: s.entityType,
        status: s.status,
        mode: s.mode,
        recordsSeen: s.recordsSeen,
        detailsFetched: s.detailsFetched,
        detailsFailed: s.detailsFailed,
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
        errorCode: s.errorCode,
      })),
      recentErrors,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 4. getTeamPerformance — Rendimiento del equipo de ventas          */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getTeamPerformance',
  description:
    'Comparativa de rendimiento del equipo de ventas: ranking por total vendido, órdenes cerradas, ticket promedio, tasa de cobranza y balance pendiente por vendedor.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const orders = await prisma.salesOrder.findMany({
      where: dateWhere,
      select: {
        salespersonName: true,
        status: true,
        total: true,
        balance: true,
      },
    });

    const teamMap = new Map<
      string,
      {
        total: number;
        count: number;
        closed: number;
        confirmed: number;
        balance: number;
        collected: number;
      }
    >();

    for (const o of orders) {
      const name = o.salespersonName ?? 'SIN VENDEDOR';
      const t = teamMap.get(name) ?? {
        total: 0,
        count: 0,
        closed: 0,
        confirmed: 0,
        balance: 0,
        collected: 0,
      };
      t.total += toNumber(o.total);
      t.count++;
      if (o.status === 'closed') t.closed++;
      if (o.status === 'confirmed') t.confirmed++;
      t.balance += toNumber(o.balance);
      if (toNumber(o.balance) === 0) t.collected += toNumber(o.total);
      teamMap.set(name, t);
    }

    const team = [...teamMap.entries()]
      .map(([name, t]) => ({
        salesperson: name,
        totalSold: t.total.toFixed(2),
        orders: t.count,
        closedOrders: t.closed,
        confirmedOrders: t.confirmed,
        closeRate: t.count > 0 ? ((t.closed / t.count) * 100).toFixed(1) + '%' : '0%',
        avgTicket: t.count > 0 ? (t.total / t.count).toFixed(2) : '0',
        collected: t.collected.toFixed(2),
        pendingBalance: t.balance.toFixed(2),
        collectionRate: t.total > 0 ? ((t.collected / t.total) * 100).toFixed(1) + '%' : '0%',
      }))
      .sort((a, b) => Number(b.totalSold) - Number(a.totalSold));

    return {
      totalSalespeople: team.length,
      totalRevenue: team.reduce((s, t) => s + Number(t.totalSold), 0).toFixed(2),
      totalOrders: orders.length,
      team,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 5. compareEntities — Comparar dos entidades                        */
/* ------------------------------------------------------------------ */
const COMPARE_DIMENSIONS = ['salesperson', 'location', 'paymentMethod', 'deliveryMethod'] as const;

registerTool({
  name: 'compareEntities',
  description:
    'Compara dos valores de una misma dimensión (ej: dos vendedores, dos sucursales, dos métodos de pago). Devuelve métricas lado a lado.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    dimension: z
      .enum(COMPARE_DIMENSIONS)
      .describe('Dimensión a comparar: "salesperson", "location", "paymentMethod", "deliveryMethod".'),
    entityA: z.string().describe('Valor exacto del primer elemento a comparar.'),
    entityB: z.string().describe('Valor exacto del segundo elemento a comparar.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      dimension: (typeof COMPARE_DIMENSIONS)[number];
      entityA: string;
      entityB: string;
    };

    const fieldMap: Record<string, string> = {
      salesperson: 'salespersonName',
      location: 'locationName',
      paymentMethod: 'paymentMethod',
      deliveryMethod: 'deliveryMethod',
    };

    const field = fieldMap[args.dimension];
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const [ordersA, ordersB] = await Promise.all([
      prisma.salesOrder.findMany({
        where: { ...dateWhere, [field]: args.entityA } as Record<string, unknown>,
        select: { total: true, balance: true, status: true },
      }),
      prisma.salesOrder.findMany({
        where: { ...dateWhere, [field]: args.entityB } as Record<string, unknown>,
        select: { total: true, balance: true, status: true },
      }),
    ]);

    function summarize(orders: typeof ordersA) {
      const total = orders.reduce((s, o) => s + toNumber(o.total), 0);
      const balance = orders.reduce((s, o) => s + toNumber(o.balance), 0);
      const closed = orders.filter((o) => o.status === 'closed').length;
      const collected = orders.filter((o) => toNumber(o.balance) === 0).reduce((s, o) => s + toNumber(o.total), 0);
      return {
        total: total.toFixed(2),
        orders: orders.length,
        closed,
        balance: balance.toFixed(2),
        collected: collected.toFixed(2),
        avgTicket: orders.length > 0 ? (total / orders.length).toFixed(2) : '0',
        closeRate: orders.length > 0 ? ((closed / orders.length) * 100).toFixed(1) + '%' : '0%',
        collectionRate: total > 0 ? ((collected / total) * 100).toFixed(1) + '%' : '0%',
      };
    }

    const summaryA = summarize(ordersA);
    const summaryB = summarize(ordersB);

    return {
      dimension: args.dimension,
      entityA: { name: args.entityA, ...summaryA },
      entityB: { name: args.entityB, ...summaryB },
      difference: {
        total: (Number(summaryA.total) - Number(summaryB.total)).toFixed(2),
        orders: summaryA.orders - summaryB.orders,
        avgTicket: (Number(summaryA.avgTicket) - Number(summaryB.avgTicket)).toFixed(2),
      },
      winner:
        Number(summaryA.total) > Number(summaryB.total) ? args.entityA : args.entityB,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 6. getProductSearch — Búsqueda de productos con datos de venta    */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getProductSearch',
  description:
    'Busca productos por nombre o SKU y devuelve sus estadísticas de venta: cantidad vendida, ingresos totales, número de órdenes, precio promedio.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.describe('Período de ventas a analizar.'),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    search: z.string().describe('Texto a buscar en nombre o SKU del producto.'),
    limit: z.number().min(1).max(50).default(20).describe('Número máximo de resultados (1-50). Default: 20.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      search: string;
      limit: number;
    };

    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const items = await prisma.salesOrderItem.findMany({
      where: {
        salesOrder: dateWhere,
        OR: [
          { name: { contains: args.search, mode: 'insensitive' } },
          { sku: { contains: args.search, mode: 'insensitive' } },
        ],
      },
      select: {
        sku: true,
        name: true,
        quantity: true,
        rate: true,
        lineTotal: true,
        salesOrder: { select: { id: true } },
      },
    });

    // Group by SKU+name
    const productMap = new Map<
      string,
      { sku: string | null; name: string | null; qty: number; revenue: number; orders: Set<string>; rates: number[] }
    >();

    for (const item of items) {
      const key = `${item.sku ?? 'N/A'}||${item.name ?? 'N/A'}`;
      const p = productMap.get(key) ?? {
        sku: item.sku,
        name: item.name,
        qty: 0,
        revenue: 0,
        orders: new Set<string>(),
        rates: [],
      };
      p.qty += toNumber(item.quantity);
      p.revenue += toNumber(item.lineTotal);
      p.orders.add(item.salesOrder.id);
      if (toNumber(item.rate) > 0) p.rates.push(toNumber(item.rate));
      productMap.set(key, p);
    }

    const results = [...productMap.values()]
      .map((p) => ({
        sku: p.sku,
        name: p.name,
        quantitySold: p.qty.toFixed(2),
        revenue: p.revenue.toFixed(2),
        orderCount: p.orders.size,
        avgRate: p.rates.length > 0 ? (p.rates.reduce((a, b) => a + b, 0) / p.rates.length).toFixed(2) : '0',
      }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue))
      .slice(0, args.limit);

    return {
      search: args.search,
      totalMatches: productMap.size,
      products: results,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 7. getDashboardSummary — Resumen ejecutivo completo                */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getDashboardSummary',
  description:
    'Resumen ejecutivo completo en una sola consulta: ventas totales, órdenes, ticket promedio, tasa de cobranza, top vendedores, top productos, top clientes, alertas, comparativa con período anterior. Ideal para "dame un resumen de hoy" o "cómo van las ventas".',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.describe('Período del resumen. Recomendado: "today", "this_week", "this_month".'),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    // Current period
    const orders = await prisma.salesOrder.findMany({
      where: dateWhere,
      select: {
        total: true,
        balance: true,
        status: true,
        salespersonName: true,
        customerName: true,
        paymentMethod: true,
        orderDate: true,
        items: { select: { name: true, quantity: true, lineTotal: true } },
      },
    });

    const total = orders.reduce((s, o) => s + toNumber(o.total), 0);
    const balance = orders.reduce((s, o) => s + toNumber(o.balance), 0);
    const collected = total - balance;
    const closed = orders.filter((o) => o.status === 'closed').length;
    const avgTicket = orders.length > 0 ? total / orders.length : 0;

    // Top salespeople
    const spMap = new Map<string, { total: number; count: number }>();
    for (const o of orders) {
      const name = o.salespersonName ?? 'N/A';
      const s = spMap.get(name) ?? { total: 0, count: 0 };
      s.total += toNumber(o.total);
      s.count++;
      spMap.set(name, s);
    }
    const topSalespeople = [...spMap.entries()]
      .map(([name, s]) => ({ salesperson: name, total: s.total.toFixed(2), orders: s.count }))
      .sort((a, b) => Number(b.total) - Number(a.total))
      .slice(0, 5);

    // Top products
    const prodMap = new Map<string, { qty: number; revenue: number }>();
    for (const o of orders) {
      for (const item of o.items) {
        const name = item.name ?? 'N/A';
        const p = prodMap.get(name) ?? { qty: 0, revenue: 0 };
        p.qty += toNumber(item.quantity);
        p.revenue += toNumber(item.lineTotal);
        prodMap.set(name, p);
      }
    }
    const topProducts = [...prodMap.entries()]
      .map(([name, p]) => ({ product: name, quantity: p.qty.toFixed(2), revenue: p.revenue.toFixed(2) }))
      .sort((a, b) => Number(b.revenue) - Number(a.revenue))
      .slice(0, 5);

    // Top customers
    const custMap = new Map<string, { total: number; count: number }>();
    for (const o of orders) {
      const name = o.customerName ?? 'N/A';
      const c = custMap.get(name) ?? { total: 0, count: 0 };
      c.total += toNumber(o.total);
      c.count++;
      custMap.set(name, c);
    }
    const topCustomers = [...custMap.entries()]
      .map(([name, c]) => ({ customer: name, total: c.total.toFixed(2), orders: c.count }))
      .sort((a, b) => Number(b.total) - Number(a.total))
      .slice(0, 5);

    // Payment methods
    const pmMap = new Map<string, { total: number; count: number }>();
    for (const o of orders) {
      const method = o.paymentMethod ?? 'N/A';
      const p = pmMap.get(method) ?? { total: 0, count: 0 };
      p.total += toNumber(o.total);
      p.count++;
      pmMap.set(method, p);
    }
    const byPaymentMethod = [...pmMap.entries()]
      .map(([method, p]) => ({ method, total: p.total.toFixed(2), orders: p.count }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    // Previous period comparison
    const { from, to } = resolveDateRange(args.dateRange);
    let prevTotal = 0;
    let prevCount = 0;
    if (from && to) {
      const days = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
      const prevFrom = new Date(from);
      prevFrom.setDate(prevFrom.getDate() - days);
      const prevTo = new Date(from);
      prevTo.setDate(prevTo.getDate() - 1);
      const prevOrders = await prisma.salesOrder.findMany({
        where: { orderDate: { gte: prevFrom, lte: prevTo } },
        select: { total: true },
      });
      prevTotal = prevOrders.reduce((s, o) => s + toNumber(o.total), 0);
      prevCount = prevOrders.length;
    }

    const growth = prevTotal > 0 ? ((total - prevTotal) / prevTotal * 100).toFixed(1) : 'N/A';

    return {
      period: { from: formatDate(from), to: formatDate(to) },
      kpis: {
        totalRevenue: total.toFixed(2),
        totalOrders: orders.length,
        avgTicket: avgTicket.toFixed(2),
        collected: collected.toFixed(2),
        pending: balance.toFixed(2),
        collectionRate: total > 0 ? ((collected / total) * 100).toFixed(1) + '%' : '0%',
        closedOrders: closed,
        closeRate: orders.length > 0 ? ((closed / orders.length) * 100).toFixed(1) + '%' : '0%',
      },
      comparison: {
        previousRevenue: prevTotal.toFixed(2),
        previousOrders: prevCount,
        growth: growth + '%',
      },
      topSalespeople,
      topProducts,
      topCustomers,
      byPaymentMethod,
    };
  },
});
