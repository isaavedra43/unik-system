import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import {
  DATE_SHORTCUTS,
  buildDateWhereFlexible,
  buildOrderDateWhereFlexible,
  formatDate,
  resolveDateRange,
} from './date-helpers';
import {
  DELIVERY_TYPES,
  matchesStatus,
  resolveStatusQuery,
  statusDistribution,
  statusLabel,
  textMatches,
  toAmount,
  valueDistribution,
  type DeliveryType,
} from './ai-filter-matching';
import { applySalesOrderFilters } from './sales-order-ai-filters';
import {
  auditPendingDelivery,
  percentile,
  reconcileCashClose,
  round2,
  summarizeProductRelations,
  type AuditPackageInput,
} from './audit-logic';

const periodDescription =
  'Periodo: "today", "yesterday", "this_week", "this_month", "last_month", "last_7_days", "last_30_days", "custom" (con dateFrom/dateTo) o "all".';

function pickNames(values: Array<string | null>, query: string): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v) && textMatches(v, query)))];
}

async function loadPackagesByOrder(zohoSalesOrderIds: string[]): Promise<Map<string, AuditPackageInput[]>> {
  const map = new Map<string, AuditPackageInput[]>();
  for (let i = 0; i < zohoSalesOrderIds.length; i += 5000) {
    const packages = await prisma.package.findMany({
      where: { zohoSalesOrderId: { in: zohoSalesOrderIds.slice(i, i + 5000) } },
      select: { zohoSalesOrderId: true, packageNumber: true, status: true },
    });
    for (const p of packages) {
      if (!p.zohoSalesOrderId) continue;
      map.set(p.zohoSalesOrderId, [...(map.get(p.zohoSalesOrderId) ?? []), p]);
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* auditPendingDeliveries                                             */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'auditPendingDeliveries',
  description:
    'Auditoría de ventas POR ENTREGAR con el MOTIVO de cada una. Detecta: días sin entregar o sin recoger, pagadas sin entregar, saldo pendiente, borradores, órdenes cerradas con entrega pendiente, ' +
    'entregas sin dirección o con "pedir ubicación", entregas programadas escritas en notas/dirección, entregas parciales, paquetes creados o enviados con la orden aún pendiente, pagos incongruentes y montos altos. ' +
    'Úsalo para "ventas raras que no he entregado y por qué", "entregas atrasadas/atoradas", "revisa mis pendientes de entrega", "qué pedidos tienen problema". Por defecto revisa todo el historial.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: z.enum(DATE_SHORTCUTS).default('all').describe(`${periodDescription} Default "all".`),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    deliveryMethod: z.string().optional().describe('Método de entrega por nombre o palabra genérica ("a pie de obra", "a domicilio", "recoge").'),
    deliveryType: z.enum(DELIVERY_TYPES).optional().describe('"entrega_a_cliente", "recoge_en_bodega", "instalacion", "pie_de_obra" o "domicilio".'),
    shippingLocation: z.string().optional().describe('Estado, ciudad, colonia o calle de entrega.'),
    salesperson: z.string().optional().describe('Vendedor (nombre parcial).'),
    customer: z.string().optional().describe('Cliente (nombre parcial).'),
    staleDays: z.number().int().min(1).max(365).default(5).describe('Días sin entregar a partir de los cuales se considera atrasada. Default 5.'),
    onlyFlagged: z.boolean().default(false).describe('true = solo órdenes con alguna alerta ("ventas raras").'),
    limit: z.number().int().min(1).max(300).default(100).describe('Máximo de órdenes a listar (el resumen siempre cubre todas).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      deliveryMethod?: string;
      deliveryType?: DeliveryType;
      shippingLocation?: string;
      salesperson?: string;
      customer?: string;
      staleDays: number;
      onlyFlagged: boolean;
      limit: number;
    };

    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);
    const openRaws = resolveStatusQuery('salesShipped', 'por entregar') ?? [];
    const orders = await prisma.salesOrder.findMany({
      where: {
        ...dateWhere,
        OR: [
          ...openRaws.map((raw) => ({ shippedStatus: { equals: raw, mode: 'insensitive' } })),
          { status: { equals: 'draft', mode: 'insensitive' } },
        ],
      } as never,
      select: {
        zohoSalesOrderId: true,
        salesOrderNumber: true,
        orderDate: true,
        customerName: true,
        customerPhone: true,
        salespersonName: true,
        status: true,
        paidStatus: true,
        invoicedStatus: true,
        shippedStatus: true,
        paymentMethod: true,
        deliveryMethod: true,
        shippingAttention: true,
        shippingAddressLine1: true,
        shippingAddressLine2: true,
        shippingCity: true,
        shippingState: true,
        shippingPostalCode: true,
        shippingPhone: true,
        notes: true,
        total: true,
        balance: true,
      },
      orderBy: { orderDate: 'asc' },
      take: 20000,
    });

    const active = orders.filter((o) => !matchesStatus('salesOrder', o.status, 'Anulada, Cancelada'));
    const scoped = applySalesOrderFilters(active, {
      deliveryMethod: args.deliveryMethod,
      deliveryType: args.deliveryType,
      shippingLocation: args.shippingLocation,
      salesperson: args.salesperson,
      customer: args.customer,
    });

    const packagesByOrder = await loadPackagesByOrder(scoped.map((o) => o.zohoSalesOrderId));
    const today = resolveDateRange('today').from ?? new Date();
    const highTotalThreshold = scoped.length >= 10 ? percentile(scoped.map((o) => toAmount(o.total)), 0.9) : null;

    const audited = scoped.map((order) => ({
      order,
      audit: auditPendingDelivery(order, {
        today,
        staleDays: args.staleDays,
        highTotalThreshold,
        packages: packagesByOrder.get(order.zohoSalesOrderId) ?? [],
      }),
    }));

    const alerts = new Map<string, { code: string; severity: string; count: number; example: string }>();
    for (const { audit } of audited) {
      for (const f of audit.flags) {
        const e = alerts.get(f.code) ?? { code: f.code, severity: f.severity, count: 0, example: f.reason };
        e.count++;
        alerts.set(f.code, e);
      }
    }

    const listed = (args.onlyFlagged ? audited.filter((a) => a.audit.flags.length > 0) : audited).sort(
      (a, b) => b.audit.score - a.audit.score || (b.audit.daysOpen ?? 0) - (a.audit.daysOpen ?? 0)
    );

    const oldest = audited[0];
    return {
      period: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      summary: {
        pendingOrders: scoped.length,
        withAlerts: audited.filter((a) => a.audit.flags.length > 0).length,
        totalAmount: round2(scoped.reduce((s, o) => s + toAmount(o.total), 0)),
        pendingBalance: round2(scoped.reduce((s, o) => s + toAmount(o.balance), 0)),
        oldestOrder: oldest
          ? { number: oldest.order.salesOrderNumber, date: formatDate(oldest.order.orderDate), daysOpen: oldest.audit.daysOpen }
          : null,
        byDeliveryMethod: valueDistribution(scoped.map((o) => o.deliveryMethod)),
        bySalesperson: valueDistribution(scoped.map((o) => o.salespersonName)),
        byShippedStatus: statusDistribution('salesShipped', scoped.map((o) => o.shippedStatus)),
        alerts: [...alerts.values()].sort((a, b) => b.count - a.count),
      },
      total: listed.length,
      showing: Math.min(listed.length, args.limit),
      orders: listed.slice(0, args.limit).map(({ order: o, audit }) => ({
        number: o.salesOrderNumber,
        date: formatDate(o.orderDate),
        daysOpen: audit.daysOpen,
        customer: o.customerName,
        phone: o.shippingPhone ?? o.customerPhone,
        salesperson: o.salespersonName,
        deliveryMethod: o.deliveryMethod,
        status: statusLabel('salesOrder', o.status),
        shippedStatus: statusLabel('salesShipped', o.shippedStatus),
        paidStatus: statusLabel('salesPaid', o.paidStatus),
        invoicedStatus: statusLabel('salesInvoiced', o.invoicedStatus),
        total: round2(toAmount(o.total)),
        balance: round2(toAmount(o.balance)),
        address:
          [o.shippingAddressLine1, o.shippingAddressLine2, o.shippingCity, o.shippingState, o.shippingPostalCode]
            .filter((p) => p && p.trim())
            .join(', ') || null,
        notes: o.notes ? o.notes.slice(0, 250) : null,
        alerts: audit.flags.map((f) => `[${f.severity}] ${f.reason}`),
      })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* getCashCloseReconciliation                                         */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getCashCloseReconciliation',
  description:
    'Corte / cierre de caja: ventas del periodo separadas por método de pago (total, cobrado, saldo y lista de órdenes) contra los pagos de clientes registrados por modo de pago, con diferencias por categoría ' +
    '(efectivo, transferencia, tarjeta, depósito...) e incongruencias: pagadas con saldo, efectivo con saldo, saldo $0 no pagada, pagos combinados, sin método de pago, posibles duplicados, ventas cobradas sin pago registrado y pagos sin venta. ' +
    'Úsalo para "corte de caja", "cuadrar la caja", "ventas que no coinciden con el cierre", "revisar faltantes, incongruencias o robo" y para comparar contra un reporte manual del contador.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: z.enum(DATE_SHORTCUTS).default('today').describe(`${periodDescription} Default "today".`),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    location: z.string().optional().describe('Sucursal (nombre parcial). Solo filtra ventas; los pagos no traen sucursal.'),
    salesperson: z.string().optional().describe('Vendedor (nombre parcial). Solo filtra ventas.'),
    includeOrderLists: z.boolean().default(true).describe('true = incluir la lista de órdenes de cada método de pago.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      location?: string;
      salesperson?: string;
      includeOrderLists: boolean;
    };

    const [orders, payments] = await Promise.all([
      prisma.salesOrder.findMany({
        where: buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo) as never,
        select: {
          salesOrderNumber: true,
          customerName: true,
          salespersonName: true,
          paymentMethod: true,
          status: true,
          paidStatus: true,
          total: true,
          balance: true,
          orderDate: true,
          locationName: true,
        },
        orderBy: { orderDate: 'asc' },
        take: 20000,
      }),
      prisma.customerPayment.findMany({
        where: buildDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo, 'date') as never,
        select: { paymentNumber: true, customerName: true, paymentMode: true, amount: true, date: true, referenceNumber: true, status: true },
        orderBy: { date: 'asc' },
        take: 20000,
      }),
    ]);

    const scopedOrders = orders.filter((o) => textMatches(o.locationName, args.location) && textMatches(o.salespersonName, args.salesperson));
    const validPayments = payments.filter((p) => !matchesStatus('customerPayment', p.status, 'Anulado, Fallido'));
    const result = reconcileCashClose(scopedOrders, validPayments);

    return {
      period: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      filters: { location: args.location ?? null, salesperson: args.salesperson ?? null },
      ...result,
      ordersByPaymentMethod: args.includeOrderLists ? result.ordersByPaymentMethod : undefined,
      notes: [
        'Ventas por fecha de la orden; pagos por fecha del pago. "collectedPerSales" = total - saldo de las ventas; "difference" = pagos registrados - cobrado según ventas.',
        ...(args.location || args.salesperson ? ['Los pagos no tienen sucursal ni vendedor en Zoho: se comparan todos los pagos del periodo.'] : []),
        'Para comparar con un reporte manual: cruza primero totales por método (comparisonByCategory) y después folio por folio (ordersByPaymentMethod).',
      ],
    };
  },
});

/* ------------------------------------------------------------------ */
/* findProductRelations                                               */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'findProductRelations',
  description:
    'Relaciona materiales/productos entre clientes y proveedores. Con customer: qué materiales compra el cliente y a qué proveedores se los compramos. Con vendor: qué materiales le compramos al proveedor, a qué clientes se los vendemos y cuánto le facturamos/acreditamos. ' +
    'Con customer + vendor: productos en común. Con product: qué clientes lo compran, qué proveedores lo surten y su stock. ' +
    'Úsalo para "materiales del cliente X y del proveedor Y, ¿están relacionados?", "¿a quién le compramos lo que se lleva X?", "¿quién compra/surte este material?".',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    customer: z.string().optional().describe('Cliente (nombre parcial).'),
    vendor: z.string().optional().describe('Proveedor (nombre parcial).'),
    product: z.string().optional().describe('Producto o material (nombre parcial).'),
    dateRange: z.enum(DATE_SHORTCUTS).default('all').describe(`${periodDescription} Default "all".`),
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      customer?: string;
      vendor?: string;
      product?: string;
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      limit: number;
    };
    if (!args.customer && !args.vendor && !args.product) {
      return { error: 'Indica al menos un cliente (customer), proveedor (vendor) o producto (product).' };
    }

    const orderDateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);
    const docDateWhere = buildDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo, 'date');

    let customerNames: string[] | null = null;
    if (args.customer) {
      const rows = await prisma.salesOrder.groupBy({ by: ['customerName'], _count: { id: true } });
      customerNames = pickNames(rows.map((r) => r.customerName), args.customer);
      if (customerNames.length === 0) return { customerNotFound: args.customer, message: `No existe un cliente que coincida con "${args.customer}".` };
    }

    let vendorNames: string[] | null = null;
    if (args.vendor) {
      const [po, bills, credits] = await Promise.all([
        prisma.purchaseOrder.groupBy({ by: ['vendorName'], _count: { id: true } }),
        prisma.bill.groupBy({ by: ['vendorName'], _count: { id: true } }),
        prisma.vendorCredit.groupBy({ by: ['vendorName'], _count: { id: true } }),
      ]);
      vendorNames = pickNames([...po, ...bills, ...credits].map((r) => r.vendorName), args.vendor);
      if (vendorNames.length === 0) return { vendorNotFound: args.vendor, message: `No existe un proveedor que coincida con "${args.vendor}".` };
    }

    let soldProductNames: string[] | null = null;
    let purchasedProductNames: string[] | null = null;
    if (args.product) {
      const [soldRows, purchasedRows] = await Promise.all([
        prisma.salesOrderItem.groupBy({ by: ['name'], _count: { id: true } }),
        prisma.purchaseOrderItem.groupBy({ by: ['name'], _count: { id: true } }),
      ]);
      soldProductNames = pickNames(soldRows.map((r) => r.name), args.product);
      purchasedProductNames = pickNames(purchasedRows.map((r) => r.name), args.product);
    }

    const fetchSold = (extraItemWhere: Record<string, unknown>) =>
      prisma.salesOrderItem.findMany({
        where: {
          ...extraItemWhere,
          salesOrder: { ...orderDateWhere, ...(customerNames ? { customerName: { in: customerNames } } : {}) },
        } as never,
        select: {
          name: true,
          sku: true,
          zohoItemId: true,
          quantity: true,
          unit: true,
          lineTotal: true,
          salesOrder: { select: { customerName: true, salesOrderNumber: true, orderDate: true } },
        },
        take: 50000,
      });

    const fetchPurchased = (extraItemWhere: Record<string, unknown>) =>
      prisma.purchaseOrderItem.findMany({
        where: {
          ...extraItemWhere,
          purchaseOrder: { ...docDateWhere, ...(vendorNames ? { vendorName: { in: vendorNames } } : {}) },
        } as never,
        select: {
          name: true,
          zohoItemId: true,
          quantity: true,
          unit: true,
          lineTotal: true,
          purchaseOrder: { select: { vendorName: true, purchaseOrderNumber: true, date: true } },
        },
        take: 50000,
      });

    const productFilter = (names: string[] | null) => (names ? { name: { in: names } } : {});
    let sold = args.customer || args.product ? await fetchSold(productFilter(soldProductNames)) : [];
    let purchased = args.vendor || args.product ? await fetchPurchased(productFilter(purchasedProductNames)) : [];

    // One-sided questions: follow the materials to the other side of the business.
    const relatedFilter = (items: Array<{ name: string | null; zohoItemId: string | null }>) => {
      const ids = [...new Set(items.map((i) => i.zohoItemId).filter((v): v is string => Boolean(v)))].slice(0, 2000);
      const names = [...new Set(items.map((i) => i.name).filter((v): v is string => Boolean(v)))].slice(0, 2000);
      return { OR: [{ zohoItemId: { in: ids } }, { name: { in: names } }] };
    };
    if (args.customer && !args.vendor && !args.product && sold.length > 0) {
      purchased = await fetchPurchased(relatedFilter(sold));
    }
    if (args.vendor && !args.customer && !args.product && purchased.length > 0) {
      sold = await fetchSold(relatedFilter(purchased));
    }

    const summary = summarizeProductRelations(
      sold.map((i) => ({ ...i, party: i.salesOrder.customerName, document: i.salesOrder.salesOrderNumber, date: i.salesOrder.orderDate })),
      purchased.map((i) => ({ ...i, party: i.purchaseOrder.vendorName, document: i.purchaseOrder.purchaseOrderNumber, date: i.purchaseOrder.date })),
      args.limit
    );

    let vendorDocuments: Record<string, unknown> | null = null;
    if (vendorNames) {
      const [bills, credits] = await Promise.all([
        prisma.bill.findMany({ where: { ...docDateWhere, vendorName: { in: vendorNames } } as never, select: { total: true, balance: true } }),
        prisma.vendorCredit.findMany({ where: { ...docDateWhere, vendorName: { in: vendorNames } } as never, select: { total: true, balance: true } }),
      ]);
      vendorDocuments = {
        bills: { count: bills.length, total: round2(bills.reduce((s, b) => s + toAmount(b.total), 0)), balance: round2(bills.reduce((s, b) => s + toAmount(b.balance), 0)) },
        vendorCredits: { count: credits.length, total: round2(credits.reduce((s, c) => s + toAmount(c.total), 0)), balance: round2(credits.reduce((s, c) => s + toAmount(c.balance), 0)) },
      };
    }

    let stock: Array<Record<string, unknown>> | null = null;
    if (args.product) {
      const products = await prisma.product.findMany({
        select: { name: true, sku: true, unit: true, stockOnHand: true, availableStock: true, vendorName: true, status: true },
        take: 20000,
      });
      stock = products
        .filter((p) => textMatches(p.name, args.product) || textMatches(p.sku, args.product))
        .slice(0, 20)
        .map((p) => ({
          product: p.name,
          sku: p.sku,
          unit: p.unit,
          stockOnHand: round2(toAmount(p.stockOnHand)),
          availableStock: round2(toAmount(p.availableStock)),
          vendor: p.vendorName,
          status: p.status,
        }));
    }

    return {
      period: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      matchedCustomers: customerNames?.slice(0, 10) ?? null,
      matchedVendors: vendorNames?.slice(0, 10) ?? null,
      matchedProducts: args.product ? [...new Set([...(soldProductNames ?? []), ...(purchasedProductNames ?? [])])].slice(0, 20) : null,
      ...summary,
      vendorDocuments,
      stock,
      note: 'Los productos se relacionan por el mismo artículo de Zoho o por el mismo nombre. Ventas por fecha de la orden; compras por fecha de la orden de compra.',
    };
  },
});
