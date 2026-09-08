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
/* 1. getSalesByDeliveryMethod — Ventas por método de entrega         */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getSalesByDeliveryMethod',
  description:
    'Ventas por método de entrega (deliveryMethod). ' +
    'Métodos comunes: "RECOGE EN BODEGA", "A PIE DE OBRA (LIBRE DE MANIOBRAS)", "INSTALACIÓN A DOMICILIO". ' +
    'Si el usuario pide un método específico (ej: "a pie de obra", "recoge en bodega"), filtra por ese método. ' +
    'Si pide "por método de entrega" sin especificar, devuelve la distribución de todos los métodos. ' +
    'Siempre devuelve las órdenes individuales con folios.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD. Para fechas específicas.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    deliveryMethod: z.string().optional().describe(
      'Filtrar por un método de entrega específico (búsqueda parcial, case-insensitive). ' +
      'Ej: "A PIE DE OBRA", "RECOGE EN BODEGA", "INSTALACIÓN". ' +
      'Si se omite, devuelve todos los métodos agrupados.'
    ),
    includeOrders: z.boolean().default(true).describe(
      'true = incluir la lista de órdenes individuales con folios. false = solo resumen agregado.'
    ),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string; deliveryMethod?: string; includeOrders: boolean };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const where: Record<string, unknown> = { ...dateWhere };
    if (args.deliveryMethod) {
      where.deliveryMethod = { contains: args.deliveryMethod, mode: 'insensitive' };
    }

    const orders = await prisma.salesOrder.findMany({
      where: where as never,
      select: {
        salesOrderNumber: true,
        customerName: true,
        total: true,
        balance: true,
        status: true,
        orderDate: true,
        deliveryMethod: true,
        paymentMethod: true,
        salespersonName: true,
      },
      orderBy: { orderDate: 'desc' },
      take: 500,
    });

    // Group by delivery method
    const groups = new Map<string, { count: number; total: number; balance: number; orders: typeof orders }>();
    for (const o of orders) {
      const key = o.deliveryMethod ?? 'SIN MÉTODO';
      const g = groups.get(key) ?? { count: 0, total: 0, balance: 0, orders: [] as typeof orders };
      g.count++;
      g.total += toNumber(o.total);
      g.balance += toNumber(o.balance);
      g.orders.push(o);
      groups.set(key, g);
    }

    const byMethod = [...groups.entries()]
      .map(([method, g]) => ({
        deliveryMethod: method,
        count: g.count,
        total: g.total.toFixed(2),
        balance: g.balance.toFixed(2),
        ...(args.includeOrders ? {
          orders: g.orders.map((o) => ({
            number: o.salesOrderNumber,
            customer: o.customerName,
            total: decimalToString(o.total),
            balance: decimalToString(o.balance),
            status: o.status,
            date: formatDate(o.orderDate),
            deliveryMethod: o.deliveryMethod,
            paymentMethod: o.paymentMethod,
            salesperson: o.salespersonName,
          })),
        } : {}),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    return {
      totalOrders: orders.length,
      totalRevenue: orders.reduce((s, o) => s + toNumber(o.total), 0).toFixed(2),
      methodCount: groups.size,
      byDeliveryMethod: byMethod,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 2. getCrossTabAnalysis — Tabulación cruzada                        */
/* ------------------------------------------------------------------ */
const CROSS_TAB_DIMENSIONS = [
  'salesperson',
  'paymentMethod',
  'status',
  'deliveryMethod',
  'location',
] as const;

registerTool({
  name: 'getCrossTabAnalysis',
  description:
    'Análisis cruzado de dos dimensiones (filas × columnas). Ej: vendedor × método de pago, sucursal × estado, método de entrega × método de pago. Devuelve una matriz con totales.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    rowDimension: z.enum(CROSS_TAB_DIMENSIONS).describe('Dimensión para las filas de la tabla.'),
    columnDimension: z
      .enum(CROSS_TAB_DIMENSIONS)
      .describe('Dimensión para las columnas de la tabla.'),
    metric: z
      .enum(['total', 'count', 'avgTicket'])
      .describe('Métrica a calcular: "total" (suma de ventas), "count" (número de órdenes), "avgTicket" (ticket promedio).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      rowDimension: (typeof CROSS_TAB_DIMENSIONS)[number];
      columnDimension: (typeof CROSS_TAB_DIMENSIONS)[number];
      metric: 'total' | 'count' | 'avgTicket';
    };

    const fieldMap: Record<string, string> = {
      salesperson: 'salespersonName',
      paymentMethod: 'paymentMethod',
      status: 'status',
      deliveryMethod: 'deliveryMethod',
      location: 'locationName',
    };

    const rowField = fieldMap[args.rowDimension];
    const colField = fieldMap[args.columnDimension];

    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);
    const orders = await prisma.salesOrder.findMany({
      where: dateWhere,
      select: {
        salespersonName: true,
        paymentMethod: true,
        status: true,
        deliveryMethod: true,
        locationName: true,
        total: true,
      },
    });

    const rows = new Map<string, Map<string, { total: number; count: number }>>();

    for (const o of orders) {
      const rowKey = String((o as Record<string, unknown>)[rowField] ?? 'N/A');
      const colKey = String((o as Record<string, unknown>)[colField] ?? 'N/A');
      if (!rows.has(rowKey)) rows.set(rowKey, new Map());
      const cols = rows.get(rowKey)!;
      const cell = cols.get(colKey) ?? { total: 0, count: 0 };
      cell.total += toNumber(o.total);
      cell.count++;
      cols.set(colKey, cell);
    }

    // Collect all column keys
    const allCols = new Set<string>();
    for (const cols of rows.values()) {
      for (const k of cols.keys()) allCols.add(k);
    }
    const colKeys = [...allCols].sort();

    // Build matrix
    const matrix = [...rows.entries()]
      .map(([rowKey, cols]) => {
        const cells: Record<string, string | number> = { [args.rowDimension]: rowKey };
        let rowTotal = 0;
        let rowCount = 0;
        for (const ck of colKeys) {
          const cell = cols.get(ck);
          if (cell) {
            if (args.metric === 'count') {
              cells[ck] = cell.count;
              rowCount += cell.count;
            } else if (args.metric === 'avgTicket') {
              cells[ck] = cell.count > 0 ? (cell.total / cell.count).toFixed(2) : '0';
            } else {
              cells[ck] = cell.total.toFixed(2);
            }
            rowTotal += cell.total;
            rowCount += cell.count;
          } else {
            cells[ck] = args.metric === 'count' ? 0 : '0';
          }
        }
        if (args.metric === 'count') {
          cells['__total__'] = rowCount;
        } else if (args.metric === 'avgTicket') {
          cells['__total__'] = rowCount > 0 ? (rowTotal / rowCount).toFixed(2) : '0';
        } else {
          cells['__total__'] = rowTotal.toFixed(2);
        }
        return cells;
      })
      .sort((a, b) => Number(b.__total__) - Number(a.__total__));

    return {
      rowDimension: args.rowDimension,
      columnDimension: args.columnDimension,
      metric: args.metric,
      columns: [...colKeys, 'TOTAL'],
      rows: matrix,
      totalOrders: orders.length,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 3. getSalesForecast — Proyección simple de ventas                  */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getSalesForecast',
  description:
    'Proyección de ventas para los próximos N días basada en el promedio y tendencia del período especificado. Usa regresión lineal simple sobre los datos diarios.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.describe(
      'Período histórico base para la proyección. Recomendado: "last_30_days" o "this_month".'
    ),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    forecastDays: z
      .number()
      .min(1)
      .max(30)
      .describe('Número de días a proyectar (1-30).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      forecastDays: number;
    };

    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);
    const orders = await prisma.salesOrder.findMany({
      where: dateWhere,
      select: { orderDate: true, total: true },
    });

    // Group by day
    const dailyMap = new Map<string, number>();
    for (const o of orders) {
      const key = formatDate(o.orderDate) ?? 'unknown';
      dailyMap.set(key, (dailyMap.get(key) ?? 0) + toNumber(o.total));
    }

    const days = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (days.length < 2) {
      return {
        error: 'Se necesitan al menos 2 días de datos para proyectar.',
        historicalDays: days.length,
      };
    }

    // Simple linear regression: y = mx + b
    const n = days.length;
    const xs = days.map((_, i) => i);
    const ys = days.map(([, v]) => v);
    const sumX = xs.reduce((a, b) => a + b, 0);
    const sumY = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
    const sumXX = xs.reduce((s, x) => s + x * x, 0);
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    const avg = sumY / n;
    const lastDay = days[days.length - 1][1];

    // Project next N days
    const forecast: Array<{ day: number; projected: string; trend: string }> = [];
    for (let i = 0; i < args.forecastDays; i++) {
      const x = n + i;
      const projected = Math.max(0, slope * x + intercept);
      forecast.push({
        day: i + 1,
        projected: projected.toFixed(2),
        trend: slope > 0 ? 'creciente' : slope < 0 ? 'decreciente' : 'estable',
      });
    }

    const totalProjected = forecast.reduce((s, f) => s + Number(f.projected), 0);

    return {
      historicalDays: n,
      historicalAvg: avg.toFixed(2),
      historicalLastDay: lastDay.toFixed(2),
      slope: slope.toFixed(4),
      trend: slope > 0 ? 'creciente' : slope < 0 ? 'decreciente' : 'estable',
      forecastDays: args.forecastDays,
      projectedTotal: totalProjected.toFixed(2),
      projectedDailyAvg: (totalProjected / args.forecastDays).toFixed(2),
      forecast,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 4. getSalesAlerts — Detección de anomalías                         */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getSalesAlerts',
  description:
    'Detecta anomalías en ventas: días con ventas inusualmente altas o bajas, clientes con saldo alto, órdenes atípicas. Devuelve alertas accionables.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.describe('Período a analizar. Recomendado: "last_30_days" o "this_month".'),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const orders = await prisma.salesOrder.findMany({
      where: dateWhere,
      select: {
        orderDate: true,
        total: true,
        balance: true,
        salesOrderNumber: true,
        customerName: true,
        salespersonName: true,
        status: true,
      },
    });

    const alerts: Array<{
      type: string;
      severity: string;
      message: string;
      data: Record<string, unknown>;
    }> = [];

    // Group by day
    const dailyMap = new Map<string, { total: number; count: number }>();
    for (const o of orders) {
      const key = formatDate(o.orderDate) ?? 'unknown';
      const d = dailyMap.get(key) ?? { total: 0, count: 0 };
      d.total += toNumber(o.total);
      d.count++;
      dailyMap.set(key, d);
    }

    const days = [...dailyMap.entries()];
    if (days.length > 3) {
      const totals = days.map(([, v]) => v.total);
      const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
      const stdDev = Math.sqrt(
        totals.reduce((s, t) => s + (t - avg) ** 2, 0) / totals.length
      );

      for (const [date, d] of days) {
        if (d.total > avg + 2 * stdDev) {
          alerts.push({
            type: 'high_sales_day',
            severity: 'info',
            message: `Día ${date} tuvo ventas inusualmente altas: $${d.total.toFixed(2)} (promedio: $${avg.toFixed(2)})`,
            data: { date, total: d.total.toFixed(2), average: avg.toFixed(2), orders: d.count },
          });
        }
        if (d.total < avg - 2 * stdDev && d.count > 0) {
          alerts.push({
            type: 'low_sales_day',
            severity: 'warning',
            message: `Día ${date} tuvo ventas inusualmente bajas: $${d.total.toFixed(2)} (promedio: $${avg.toFixed(2)})`,
            data: { date, total: d.total.toFixed(2), average: avg.toFixed(2), orders: d.count },
          });
        }
      }
    }

    // Large outstanding balances
    const highBalance = orders
      .filter((o) => toNumber(o.balance) > 10000)
      .sort((a, b) => toNumber(b.balance) - toNumber(a.balance))
      .slice(0, 5);
    for (const o of highBalance) {
      alerts.push({
        type: 'high_balance',
        severity: 'warning',
        message: `Orden ${o.salesOrderNumber ?? 'N/A'} de ${o.customerName ?? 'N/A'} tiene saldo pendiente de $${toNumber(o.balance).toFixed(2)}`,
        data: {
          orderNumber: o.salesOrderNumber,
          customer: o.customerName,
          balance: decimalToString(o.balance),
          status: o.status,
        },
      });
    }

    // Stuck orders (confirmed but not closed)
    const stuck = orders.filter(
      (o) => o.status === 'confirmed' && toNumber(o.balance) > 0
    );
    if (stuck.length > 0) {
      alerts.push({
        type: 'stuck_orders',
        severity: 'warning',
        message: `${stuck.length} órdenes confirmadas con saldo pendiente total de $${stuck
          .reduce((s, o) => s + toNumber(o.balance), 0)
          .toFixed(2)}`,
        data: {
          count: stuck.length,
          totalBalance: stuck.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2),
        },
      });
    }

    return {
      period: { from: formatDate(resolveDateRange(args.dateRange).from), to: formatDate(resolveDateRange(args.dateRange).to) },
      totalOrders: orders.length,
      alertCount: alerts.length,
      alerts,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 5. getSalesVelocity — Velocidad de cierre de órdenes               */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getSalesVelocity',
  description:
    'Mide la velocidad de cierre de órdenes: cuántas se cierran vs cuántas quedan pendientes, tiempo promedio de cierre, tasa de conversión por estado.',
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
        status: true,
        total: true,
        balance: true,
        orderDate: true,
        createdTime: true,
      },
    });

    const total = orders.length;
    const closed = orders.filter((o) => o.status === 'closed').length;
    const confirmed = orders.filter((o) => o.status === 'confirmed').length;
    const pending = orders.filter((o) => o.status === 'pending').length;
    const cancelled = orders.filter((o) => o.status === 'cancelled').length;

    const closeRate = total > 0 ? (closed / total) * 100 : 0;
    const totalRevenue = orders.reduce((s, o) => s + toNumber(o.total), 0);
    const collectedRevenue = orders
      .filter((o) => toNumber(o.balance) === 0)
      .reduce((s, o) => s + toNumber(o.total), 0);
    const collectionRate = totalRevenue > 0 ? (collectedRevenue / totalRevenue) * 100 : 0;

    return {
      totalOrders: total,
      closed,
      confirmed,
      pending,
      cancelled,
      closeRate: closeRate.toFixed(1) + '%',
      collectionRate: collectionRate.toFixed(1) + '%',
      totalRevenue: totalRevenue.toFixed(2),
      collectedRevenue: collectedRevenue.toFixed(2),
      pendingRevenue: (totalRevenue - collectedRevenue).toFixed(2),
    };
  },
});

/* ------------------------------------------------------------------ */
/* 6. getCustomerRetention — Análisis de retención                   */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getCustomerRetention',
  description:
    'Análisis de retención de clientes: clientes nuevos vs recurrentes, frecuencia de compra, ticket promedio por cohorte, tasa de retención.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.describe('Período a analizar.'),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const orders = await prisma.salesOrder.findMany({
      where: dateWhere,
      select: {
        customerName: true,
        orderDate: true,
        total: true,
      },
    });

    // Group by customer
    const customerMap = new Map<
      string,
      { orders: number; total: number; firstPurchase: string; lastPurchase: string }
    >();

    for (const o of orders) {
      const name = o.customerName ?? 'SIN NOMBRE';
      const c = customerMap.get(name) ?? {
        orders: 0,
        total: 0,
        firstPurchase: '9999-99-99',
        lastPurchase: '0000-00-00',
      };
      c.orders++;
      c.total += toNumber(o.total);
      const dateStr = formatDate(o.orderDate) ?? '';
      if (dateStr < c.firstPurchase) c.firstPurchase = dateStr;
      if (dateStr > c.lastPurchase) c.lastPurchase = dateStr;
      customerMap.set(name, c);
    }

    const customers = [...customerMap.entries()];
    const newCustomers = customers.filter(([, c]) => c.orders === 1);
    const recurringCustomers = customers.filter(([, c]) => c.orders >= 2);
    const vipCustomers = customers.filter(([, c]) => c.orders >= 5);

    const totalRevenue = customers.reduce((s, [, c]) => s + c.total, 0);
    const newRevenue = newCustomers.reduce((s, [, c]) => s + c.total, 0);
    const recurringRevenue = recurringCustomers.reduce((s, [, c]) => s + c.total, 0);

    return {
      totalCustomers: customers.length,
      newCustomers: newCustomers.length,
      recurringCustomers: recurringCustomers.length,
      vipCustomers: vipCustomers.length,
      retentionRate:
        customers.length > 0
          ? ((recurringCustomers.length / customers.length) * 100).toFixed(1) + '%'
          : '0%',
      newCustomerRevenue: newRevenue.toFixed(2),
      recurringCustomerRevenue: recurringRevenue.toFixed(2),
      avgTicketNew: newCustomers.length > 0 ? (newRevenue / newCustomers.length).toFixed(2) : '0',
      avgTicketRecurring:
        recurringCustomers.length > 0
          ? (recurringRevenue / recurringCustomers.length).toFixed(2)
          : '0',
      topRecurring: recurringCustomers
        .sort((a, b) => b[1].orders - a[1].orders)
        .slice(0, 10)
        .map(([name, c]) => ({
          customer: name,
          orders: c.orders,
          total: c.total.toFixed(2),
          avgTicket: (c.total / c.orders).toFixed(2),
        })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* 7. getProductBundles — Productos comprados juntos                 */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getProductBundles',
  description:
    'Identifica productos que se compran juntos frecuentemente (análisis de canasta). Devuelve pares de productos con frecuencia de co-ocurrencia.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.describe('Período a analizar.'),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    minFrequency: z
      .number()
      .min(2)
      .describe('Frecuencia mínima de co-ocurrencia (default 2).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      minFrequency: number;
    };

    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    // Get orders with items
    const orders = await prisma.salesOrder.findMany({
      where: dateWhere,
      select: {
        id: true,
        items: { select: { name: true, sku: true } },
      },
    });

    // Build co-occurrence map
    const pairMap = new Map<string, { productA: string; productB: string; count: number }>();

    for (const o of orders) {
      const products = o.items
        .map((i) => i.name ?? i.sku ?? 'N/A')
        .filter((p, idx, arr) => arr.indexOf(p) === idx); // unique
      for (let i = 0; i < products.length; i++) {
        for (let j = i + 1; j < products.length; j++) {
          const a = products[i];
          const b = products[j];
          const key = [a, b].sort().join('||');
          const pair = pairMap.get(key);
          if (pair) {
            pair.count++;
          } else {
            pairMap.set(key, { productA: a, productB: b, count: 1 });
          }
        }
      }
    }

    const bundles = [...pairMap.values()]
      .filter((p) => p.count >= args.minFrequency)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((p) => ({
        productA: p.productA,
        productB: p.productB,
        coOccurrence: p.count,
      }));

    return {
      totalOrders: orders.length,
      totalBundles: bundles.length,
      bundles,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 8. getBalanceAging — Saldo pendiente por antigüedad              */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getBalanceAging',
  description:
    'Análisis de antigüedad de saldos pendientes (aging). Agrupa órdenes con balance > 0 por rangos: 0-7 días, 8-15, 16-30, 31-60, 60+.',
  category: 'finance',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.describe('Período de las órdenes a analizar.'),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const orders = await prisma.salesOrder.findMany({
      where: { ...dateWhere, balance: { gt: 0 } },
      select: {
        salesOrderNumber: true,
        customerName: true,
        orderDate: true,
        total: true,
        balance: true,
        salespersonName: true,
      },
    });

    const now = new Date();
    const buckets = {
      '0-7': { count: 0, total: 0, orders: [] as Array<Record<string, unknown>> },
      '8-15': { count: 0, total: 0, orders: [] as Array<Record<string, unknown>> },
      '16-30': { count: 0, total: 0, orders: [] as Array<Record<string, unknown>> },
      '31-60': { count: 0, total: 0, orders: [] as Array<Record<string, unknown>> },
      '60+': { count: 0, total: 0, orders: [] as Array<Record<string, unknown>> },
    };

    for (const o of orders) {
      const orderDate = o.orderDate ? new Date(o.orderDate) : new Date();
      const daysDiff = Math.floor((now.getTime() - orderDate.getTime()) / (1000 * 60 * 60 * 24));
      const balance = toNumber(o.balance);
      const bucket = daysDiff <= 7 ? '0-7' : daysDiff <= 15 ? '8-15' : daysDiff <= 30 ? '16-30' : daysDiff <= 60 ? '31-60' : '60+';
      buckets[bucket].count++;
      buckets[bucket].total += balance;
      buckets[bucket].orders.push({
        orderNumber: o.salesOrderNumber,
        customer: o.customerName,
        balance: balance.toFixed(2),
        daysOld: daysDiff,
        salesperson: o.salespersonName,
      });
    }

    return {
      totalPending: orders.length,
      totalBalance: orders.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2),
      aging: Object.entries(buckets).map(([range, b]) => ({
        range: range + ' días',
        count: b.count,
        total: b.total.toFixed(2),
        topOrders: b.orders.slice(0, 5),
      })),
    };
  },
});
