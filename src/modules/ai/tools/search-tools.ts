import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { formatDate } from './date-helpers';

/* ------------------------------------------------------------------ */
/* universalSearch — Busca en TODA la base de datos                    */
/* ------------------------------------------------------------------ */

function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String(value);
  }
  return String(value);
}

registerTool({
  name: 'universalSearch',
  description:
    'BÚSQUEDA UNIVERSAL en toda la base de datos de UNIK. ' +
    'Busca simultáneamente en: órdenes de venta, productos/items, clientes, vendedores, y métodos de pago/entrega. ' +
    'Úsalo cuando el usuario busque algo sin saber exactamente dónde está, o cuando busque un producto sin folio, ' +
    'o cuando quiera encontrar cualquier cosa en el sistema. ' +
    'Devuelve resultados agrupados por tipo (orders, products, customers). ' +
    'EJEMPLOS: ' +
    '"busca el producto silla" → universalSearch(query="silla"). ' +
    '"busca a Juan" → universalSearch(query="Juan"). ' +
    '"busca OV-23275" → universalSearch(query="OV-23275"). ' +
    '"busca piso porcelanato" → universalSearch(query="piso porcelanato"). ' +
    '"busca transferencia" → universalSearch(query="transferencia"). ' +
    '"busca a pie de obra" → universalSearch(query="a pie de obra").',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    query: z.string().min(1).describe(
      'Texto a buscar. Puede ser nombre de producto, SKU, número de orden, nombre de cliente, vendedor, método de pago, método de entrega, etc.'
    ),
    limit: z.number().int().min(1).max(50).default(10).describe('Máximo de resultados por categoría.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { query: string; limit: number };
    const limit = args.limit;

    // Run all searches in parallel
    const [orders, products, customers] = await Promise.all([
      // Search in SalesOrders
      prisma.salesOrder.findMany({
        where: {
          OR: [
            { salesOrderNumber: { contains: args.query, mode: 'insensitive' } },
            { referenceNumber: { contains: args.query, mode: 'insensitive' } },
            { customerName: { contains: args.query, mode: 'insensitive' } },
            { salespersonName: { contains: args.query, mode: 'insensitive' } },
            { paymentMethod: { contains: args.query, mode: 'insensitive' } },
            { deliveryMethod: { contains: args.query, mode: 'insensitive' } },
            { locationName: { contains: args.query, mode: 'insensitive' } },
            { status: { contains: args.query, mode: 'insensitive' } },
            { shippingAddressLine1: { contains: args.query, mode: 'insensitive' } },
            { shippingCity: { contains: args.query, mode: 'insensitive' } },
            { notes: { contains: args.query, mode: 'insensitive' } },
          ],
        },
        select: {
          salesOrderNumber: true,
          customerName: true,
          salespersonName: true,
          status: true,
          paymentMethod: true,
          deliveryMethod: true,
          locationName: true,
          total: true,
          balance: true,
          orderDate: true,
        },
        orderBy: { orderDate: 'desc' },
        take: limit,
      }),
      // Search in SalesOrderItems (products)
      prisma.salesOrderItem.findMany({
        where: {
          OR: [
            { name: { contains: args.query, mode: 'insensitive' } },
            { sku: { contains: args.query, mode: 'insensitive' } },
            { description: { contains: args.query, mode: 'insensitive' } },
          ],
        },
        select: {
          name: true,
          sku: true,
          description: true,
          quantity: true,
          unit: true,
          rate: true,
          lineTotal: true,
          salesOrder: {
            select: {
              salesOrderNumber: true,
              orderDate: true,
              customerName: true,
              salespersonName: true,
            },
          },
        },
        orderBy: { salesOrder: { orderDate: 'desc' } },
        take: limit,
      }),
      // Search distinct customers
      prisma.salesOrder.findMany({
        where: {
          customerName: { contains: args.query, mode: 'insensitive' },
        },
        select: {
          customerName: true,
          customerEmail: true,
          customerPhone: true,
          total: true,
          balance: true,
          orderDate: true,
        },
        orderBy: { orderDate: 'desc' },
        take: limit * 2,
      }),
    ]);

    // Group customers (distinct by name)
    const customerMap = new Map<string, { name: string; email: string | null; phone: string | null; totalSpent: number; balance: number; orderCount: number; lastOrder: string | null }>();
    for (const o of customers) {
      const name = o.customerName ?? 'Sin nombre';
      const existing = customerMap.get(name);
      if (existing) {
        existing.totalSpent += Number(o.total ?? 0);
        existing.balance += Number(o.balance ?? 0);
        existing.orderCount++;
        existing.lastOrder = formatDate(o.orderDate);
      } else {
        customerMap.set(name, {
          name,
          email: o.customerEmail ?? null,
          phone: o.customerPhone ?? null,
          totalSpent: Number(o.total ?? 0),
          balance: Number(o.balance ?? 0),
          orderCount: 1,
          lastOrder: formatDate(o.orderDate),
        });
      }
    }

    return {
      query: args.query,
      totalResults: orders.length + products.length + customerMap.size,
      orders: orders.map((o) => ({
        type: 'order',
        number: o.salesOrderNumber,
        customer: o.customerName,
        salesperson: o.salespersonName,
        status: o.status,
        paymentMethod: o.paymentMethod,
        deliveryMethod: o.deliveryMethod,
        location: o.locationName,
        total: decimalToString(o.total),
        balance: decimalToString(o.balance),
        date: formatDate(o.orderDate),
      })),
      products: products.map((p) => ({
        type: 'product',
        name: p.name,
        sku: p.sku,
        description: p.description,
        quantity: decimalToString(p.quantity),
        unit: p.unit,
        rate: decimalToString(p.rate),
        lineTotal: decimalToString(p.lineTotal),
        orderNumber: p.salesOrder.salesOrderNumber,
        orderDate: formatDate(p.salesOrder.orderDate),
        customer: p.salesOrder.customerName,
        salesperson: p.salesOrder.salespersonName,
      })),
      customers: [...customerMap.values()]
        .sort((a, b) => b.totalSpent - a.totalSpent)
        .slice(0, limit)
        .map((c) => ({
          type: 'customer',
          name: c.name,
          email: c.email,
          phone: c.phone,
          totalSpent: c.totalSpent.toFixed(2),
          balance: c.balance.toFixed(2),
          orderCount: c.orderCount,
          lastOrder: c.lastOrder,
        })),
    };
  },
});
