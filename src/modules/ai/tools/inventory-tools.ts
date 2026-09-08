import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { resolveDateRange, dateRangeSchema, formatDate } from './date-helpers';

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. getProductCatalog
registerTool({
  name: 'getProductCatalog',
  description:
    'Catálogo de productos vendidos: lista los productos que aparecen en las órdenes de venta con su SKU, nombre, precio promedio y unidades vendidas. Útil para ver qué productos existen en el sistema.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    search: z.string().optional().describe('Búsqueda parcial por nombre o SKU del producto.'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { search?: string; limit: number };
    const where = args.search
      ? {
          OR: [
            { name: { contains: args.search, mode: 'insensitive' as const } },
            { sku: { contains: args.search, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const items = await prisma.salesOrderItem.findMany({
      where,
      select: { sku: true, name: true, rate: true, quantity: true, unit: true },
      distinct: ['sku'],
      take: args.limit,
    });
    return {
      products: items.map((i) => ({
        sku: i.sku ?? 'Sin SKU',
        name: i.name ?? 'Sin nombre',
        avgRate: i.rate ? Number(i.rate).toFixed(2) : null,
        unit: i.unit ?? null,
      })),
      total: items.length,
    };
  },
});

// 2. getStockMovement
registerTool({
  name: 'getStockMovement',
  description:
    'Movimiento de inventario (productos vendidos por cantidad) en un rango de fechas. Muestra qué productos se vendieron, cuántas unidades y en cuántas órdenes.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema>; limit: number };
    const { from, to } = resolveDateRange(args.dateRange);
    const items = await prisma.salesOrderItem.findMany({
      where: { salesOrder: { orderDate: { gte: from, lte: to } } },
      select: { name: true, sku: true, quantity: true, lineTotal: true },
    });
    const byProduct = new Map<string, { sku: string | null; quantity: number; revenue: number; orders: number }>();
    for (const item of items) {
      const key = item.sku ?? item.name ?? 'Sin nombre';
      const entry = byProduct.get(key) ?? { sku: item.sku, quantity: 0, revenue: 0, orders: 0 };
      entry.quantity += Number(item.quantity ?? 0);
      entry.revenue += Number(item.lineTotal ?? 0);
      entry.orders++;
      byProduct.set(key, entry);
    }
    const ranked = [...byProduct.entries()]
      .map(([key, v]) => ({
        sku: v.sku ?? key,
        name: key,
        quantity: v.quantity,
        revenue: v.revenue.toFixed(2),
        orders: v.orders,
      }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, args.limit);
    return { stockMovement: ranked, totalProducts: byProduct.size };
  },
});

// 3. getLowStockAlerts
registerTool({
  name: 'getLowStockAlerts',
  description:
    'Alertas de productos con baja rotación en el período especificado. Identifica productos que se vendieron poco o nada para posible liquidación o reposición.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema.optional(),
    threshold: z.number().int().min(1).default(5).describe('Unidades mínimas vendidas para no considerar bajo.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange?: z.infer<typeof dateRangeSchema>; threshold: number };
    const { from, to } = resolveDateRange(args.dateRange ?? 'last_30_days');
    const items = await prisma.salesOrderItem.findMany({
      where: { salesOrder: { orderDate: { gte: from, lte: to } } },
      select: { name: true, sku: true, quantity: true },
    });
    const byProduct = new Map<string, { sku: string | null; quantity: number; orders: number }>();
    for (const item of items) {
      const key = item.sku ?? item.name ?? 'Sin nombre';
      const entry = byProduct.get(key) ?? { sku: item.sku, quantity: 0, orders: 0 };
      entry.quantity += Number(item.quantity ?? 0);
      entry.orders++;
      byProduct.set(key, entry);
    }
    const lowStock = [...byProduct.entries()]
      .filter(([, v]) => v.quantity < args.threshold)
      .map(([key, v]) => ({
        sku: v.sku ?? key,
        name: key,
        quantitySold: v.quantity,
        orders: v.orders,
      }))
      .sort((a, b) => a.quantitySold - b.quantitySold);
    return { lowStockProducts: lowStock, total: lowStock.length, threshold: args.threshold };
  },
});

// 4. getProductDetails
registerTool({
  name: 'getProductDetails',
  description:
    'Detalles de un producto específico: historial de ventas, precio promedio, sucursales donde se vende, vendedores que lo venden.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    skuOrName: z.string().min(1).describe('SKU o nombre del producto (búsqueda parcial).'),
    dateRange: dateRangeSchema.optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { skuOrName: string; dateRange?: z.infer<typeof dateRangeSchema> };
    const { from, to } = resolveDateRange(args.dateRange ?? 'last_30_days');
    const items = await prisma.salesOrderItem.findMany({
      where: {
        OR: [
          { sku: { contains: args.skuOrName, mode: 'insensitive' } },
          { name: { contains: args.skuOrName, mode: 'insensitive' } },
        ],
        salesOrder: { orderDate: { gte: from, lte: to } },
      },
      select: {
        name: true,
        sku: true,
        quantity: true,
        rate: true,
        lineTotal: true,
        salesOrder: {
          select: {
            salesOrderNumber: true,
            orderDate: true,
            salespersonName: true,
            locationName: true,
            customerName: true,
          },
        },
      },
    });
    if (items.length === 0) return { found: false };
    const totalQty = items.reduce((s, i) => s + Number(i.quantity ?? 0), 0);
    const totalRev = items.reduce((s, i) => s + Number(i.lineTotal ?? 0), 0);
    const avgRate = items.reduce((s, i) => s + Number(i.rate ?? 0), 0) / items.length;
    const byLocation = new Map<string, number>();
    const bySalesperson = new Map<string, number>();
    for (const i of items) {
      const loc = i.salesOrder.locationName ?? 'Sin sucursal';
      byLocation.set(loc, (byLocation.get(loc) ?? 0) + Number(i.quantity ?? 0));
      const sp = i.salesOrder.salespersonName ?? 'Sin vendedor';
      bySalesperson.set(sp, (bySalesperson.get(sp) ?? 0) + Number(i.quantity ?? 0));
    }
    return {
      found: true,
      product: {
        sku: items[0].sku ?? 'Sin SKU',
        name: items[0].name ?? 'Sin nombre',
        totalQuantity: totalQty,
        totalRevenue: totalRev.toFixed(2),
        avgRate: avgRate.toFixed(2),
        orders: items.length,
      },
      byLocation: [...byLocation.entries()]
        .map(([location, qty]) => ({ location, quantity: qty }))
        .sort((a, b) => b.quantity - a.quantity),
      bySalesperson: [...bySalesperson.entries()]
        .map(([salesperson, qty]) => ({ salesperson, quantity: qty }))
        .sort((a, b) => b.quantity - a.quantity),
      recentOrders: items.slice(0, 10).map((i) => ({
        orderNumber: i.salesOrder.salesOrderNumber,
        date: i.salesOrder.orderDate ? formatDate(i.salesOrder.orderDate) : null,
        customer: i.salesOrder.customerName,
        salesperson: i.salesOrder.salespersonName,
        location: i.salesOrder.locationName,
        quantity: Number(i.quantity ?? 0),
        total: Number(i.lineTotal ?? 0).toFixed(2),
      })),
    };
  },
});
