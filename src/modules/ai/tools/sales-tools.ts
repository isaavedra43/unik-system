import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import {
  formatDate,
  buildOrderDateWhereFlexible,
  dateRangeSchema,
} from './date-helpers';
import {
  DELIVERY_TYPES,
  classifyDeliveryMethod,
  resolveStatusQuery,
  statusDistribution,
  statusLabel,
  valueDistribution,
  type StatusDomain,
} from './ai-filter-matching';
import {
  activeSalesOrderFilters,
  applySalesOrderFilters,
  interpretSalesOrderMatches,
  perFilterMatchCounts,
  type SalesOrderFilterArgs,
} from './sales-order-ai-filters';
import { getSalesOrderRelations } from '@/modules/cross-module/relationships-service';
import { getTicketStatus } from '@/modules/sales/sales-orders-helpers';

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

/**
 * The order's OVERALL ticket status — the same computed value that drives the "Ticket" column
 * in the Sales Orders Workspace (see getTicketStatus). Use this, not raw shippedStatus, whenever
 * the question is "is this order actually done" (e.g. "pendientes de entregar"): a
 * shippedStatus="shipped" order is only in transit here, not delivered.
 */
function ticketStatusOf(o: {
  status?: unknown;
  subStatus?: unknown;
  paidStatus?: unknown;
  invoicedStatus?: unknown;
  shippedStatus?: unknown;
}) {
  return getTicketStatus({
    status: (o.status as string | null) ?? null,
    subStatus: (o.subStatus as string | null) ?? null,
    paidStatus: (o.paidStatus as string | null) ?? null,
    invoicedStatus: (o.invoicedStatus as string | null) ?? null,
    shippedStatus: (o.shippedStatus as string | null) ?? null,
  });
}

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 0. querySalesOrders — UNIVERSAL sales query tool                   */
/* Handles ANY combination of filters + grouping + item details       */
/* ------------------------------------------------------------------ */
const GROUP_BY_DIMENSIONS = [
  'none', 'paymentMethod', 'deliveryMethod', 'status', 'subStatus', 'paidStatus', 'invoicedStatus',
  'shippedStatus', 'ticketStatus', 'salesperson', 'location', 'customer', 'date', 'product',
] as const;

const MAX_ORDERS_SCANNED = 20000;
const MAX_ORDERS_SCANNED_WITH_ITEMS = 5000;

const SALES_ORDER_SCALAR_SELECT = {
  id: true,
  salesOrderNumber: true,
  customerName: true,
  customerPhone: true,
  salespersonName: true,
  status: true,
  subStatus: true,
  paidStatus: true,
  invoicedStatus: true,
  shippedStatus: true,
  paymentMethod: true,
  deliveryMethod: true,
  locationName: true,
  total: true,
  balance: true,
  orderDate: true,
  referenceNumber: true,
  shippingAttention: true,
  shippingAddressLine1: true,
  shippingAddressLine2: true,
  shippingCity: true,
  shippingState: true,
  shippingPostalCode: true,
  shippingPhone: true,
  notes: true,
  saleMadeInWarehouse: true,
} as const;

const SALES_ORDER_ITEM_SELECT = {
  name: true,
  sku: true,
  quantity: true,
  unit: true,
  rate: true,
  lineTotal: true,
  description: true,
} as const;

/** SQL pre-filter for status queries that resolve to known raw values; keeps "all history" queries fast. */
function buildSalesStatusWhere(args: SalesOrderFilterArgs): Record<string, unknown> {
  const fields: Array<['status' | 'paidStatus' | 'invoicedStatus' | 'shippedStatus', StatusDomain]> = [
    ['status', 'salesOrder'],
    ['paidStatus', 'salesPaid'],
    ['invoicedStatus', 'salesInvoiced'],
    ['shippedStatus', 'salesShipped'],
  ];
  const and: Array<Record<string, unknown>> = [];
  for (const [field, domain] of fields) {
    const raws = resolveStatusQuery(domain, args[field]);
    if (raws) and.push({ OR: raws.map((raw) => ({ [field]: { equals: raw, mode: 'insensitive' } })) });
  }
  return and.length > 0 ? { AND: and } : {};
}

registerTool({
  name: 'querySalesOrders',
  description:
    'TOOL UNIVERSAL de ventas (órdenes de venta). Úsalo para CUALQUIER consulta de ventas, por compuesta que sea: combina en UNA llamada todos los filtros que mencione el usuario. ' +
    'Filtra por periodo, método de pago, método o tipo de entrega, lugar de entrega (estado/ciudad/colonia), cliente, vendedor, producto/material, estados de entrega/pago/facturación, sucursal, montos y saldo. ' +
    'Agrupa por cualquier dimensión e incluye productos, direcciones, teléfonos y notas. ' +
    'Los filtros de texto ignoran acentos y mayúsculas; los de estado aceptan español o inglés ("por entregar", "Pendiente", "con saldo", "sin facturar"). ' +
    'Si no hay resultados devuelve "diagnostic" con qué filtro vació la consulta y cuántas coinciden fuera del periodo. ' +
    'EJEMPLOS: ' +
    '"pendientes de entregar de este mes a pie de obra" → (dateRange="this_month", deliveryType="pie_de_obra", ticketStatus="pendiente de entrega", includeShippingAddress=true). ' +
    '"ventas que tengo que entregar a domicilio" → (dateRange="all", deliveryType="entrega_a_cliente", ticketStatus="pendiente de entrega", includeShippingAddress=true). ' +
    '"ventas de agosto en efectivo de porcelanato con entrega en Jalisco" → (dateRange="custom", dateFrom="2026-08-01", dateTo="2026-08-31", paymentMethods=["EFECTIVO"], product="porcelanato", shippingLocation="Jalisco", includeItems=true, includeShippingAddress=true). ' +
    '"quién me debe por vendedor" → (dateRange="all", paidStatus="con saldo", groupBy="salesperson"). ' +
    '"ventas de hoy por método de pago" → (dateRange="today", groupBy="paymentMethod"). ' +
    '"ventas de más de 100 mil sin facturar" → (dateRange="all", minTotal=100000, invoicedStatus="sin facturar").',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD (con dateRange="custom").'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD (con dateRange="custom").'),
    paymentMethods: z.array(z.string()).optional().describe(
      'Métodos de pago exactos (sin importar acentos/mayúsculas). Ej: ["EFECTIVO"], ["EFECTIVO","TRANSFERENCIA"], ["TARJETA"], ["DEPOSITO"], ["CREDITO"]. ' +
      '"EFECTIVO EN BODEGA" y "EFECTIVO Y TARJETA" son métodos distintos de "EFECTIVO": inclúyelos solo si el usuario los pide.'
    ),
    deliveryMethod: z.string().optional().describe(
      'Método de entrega por nombre (palabras parciales). Ej: "a pie de obra", "recoge en bodega", "instalacion". Para tipos genéricos ("a domicilio", "que recogen") usa deliveryType.'
    ),
    deliveryType: z.enum(DELIVERY_TYPES).optional().describe(
      'Tipo de entrega inferido: "entrega_a_cliente" = todo lo que se lleva al cliente (a domicilio, a pie de obra, instalación, envío); "recoge_en_bodega" = el cliente recoge; "instalacion"; "pie_de_obra"; "domicilio".'
    ),
    shippingLocation: z.string().optional().describe(
      'Lugar de entrega: estado, ciudad, colonia, calle o CP. Busca en toda la dirección de envío y entiende abreviaturas de estados (gto, jal, ags, qro, cdmx) y ciudades principales. Ej: "Jalisco", "León", "Lomas del Molino".'
    ),
    customer: z.string().optional().describe('Cliente (nombre parcial).'),
    salesperson: z.string().optional().describe('Vendedor (nombre parcial).'),
    status: z.string().optional().describe('Estado GENERAL: "Confirmada", "Cerrada", "Borrador", "Anulada". No lo uses para entrega, pago o facturación.'),
    subStatus: z.string().optional().describe('Sub-estado interno de Zoho. Casi nunca se necesita.'),
    paidStatus: z.string().optional().describe(
      'Estado de PAGO: "Pagada", "Parcial", "Pendiente", "sin pagar" (no pagadas), "con saldo" (sin pagar + parciales), "Vencida".'
    ),
    invoicedStatus: z.string().optional().describe('Estado de FACTURACIÓN: "Facturada", "sin facturar", "Parcial".'),
    shippedStatus: z.string().optional().describe(
      'Estado de DESPACHO/ALMACÉN (mecánica de envío, NO si el pedido ya quedó resuelto): "por entregar" = Pendiente + No enviado + Parcial (aún NO ha salido de bodega). "Enviado" = ya salió pero no ha llegado. "entregadas" = enviadas, entregadas o cumplidas. ' +
      'Úsalo SOLO para preguntas específicas de despacho ("qué no ha salido de bodega", "qué ya se envió"). Para "qué me falta entregar" o pendientes en general usa ticketStatus.'
    ),
    ticketStatus: z.string().optional().describe(
      'Estado GENERAL del pedido — misma fuente de verdad que la columna "Ticket" del listado de ventas (resume status+pago+factura+entrega en un solo estado). ' +
      'Valores: "Cerrado", "Anulado", "Borrador", "En espera", "Entregado", "En tránsito", "Pendiente de envío", "Pago pendiente", "Sin facturar", "Abierto". ' +
      'ÚSALO POR DEFAULT para "qué me falta entregar", "pendientes de entrega", "qué no se ha cerrado": ticketStatus="pendiente de entrega" incluye TODO lo que no está Cerrado, Anulado ni Entregado — incluye lo que YA SALIÓ de bodega pero no ha llegado (En tránsito). ' +
      'Una orden con shippedStatus="Enviado" (ya salió) SIGUE pendiente de entrega: nunca la cuentes como entregada solo por eso.'
    ),
    location: z.string().optional().describe('Sucursal (nombre parcial). Ej: "Patio Unik".'),
    product: z.string().optional().describe('Producto o material: nombre, SKU o descripción (palabras parciales). Solo devuelve órdenes que lo contienen.'),
    minTotal: z.number().optional().describe('Total mínimo de la orden en MXN.'),
    maxTotal: z.number().optional().describe('Total máximo de la orden en MXN.'),
    hasBalance: z.boolean().optional().describe('true = solo órdenes con saldo por cobrar; false = solo saldadas.'),
    saleMadeInWarehouse: z.boolean().optional().describe('true = ventas realizadas en almacén/bodega.'),
    search: z.string().optional().describe('Búsqueda libre en folio, cliente, referencia, dirección, teléfono y notas.'),
    groupBy: z.enum(GROUP_BY_DIMENSIONS).default('none').describe(
      'Agrupar: "none" (lista), "paymentMethod", "deliveryMethod", "salesperson", "location", "customer", "status", "paidStatus", "invoicedStatus", "shippedStatus", "ticketStatus", "date", "product" (suma cantidades por producto).'
    ),
    includeItems: z.boolean().default(false).describe('true = incluir productos de cada orden (nombre, cantidad, unidad, total).'),
    includeShippingAddress: z.boolean().default(false).describe('true = incluir dirección de entrega, teléfono y notas de cada orden.'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as SalesOrderFilterArgs & {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      groupBy: (typeof GROUP_BY_DIMENSIONS)[number];
      includeItems: boolean;
      includeShippingAddress: boolean;
      page: number;
      pageSize: number;
    };

    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);
    const hasDateFilter = Object.keys(dateWhere).length > 0;
    const needItems = args.includeItems || Boolean(args.product) || args.groupBy === 'product';
    const scanLimit = needItems ? MAX_ORDERS_SCANNED_WITH_ITEMS : MAX_ORDERS_SCANNED;
    const statusWhere = buildSalesStatusWhere(args);
    const activeFilters = activeSalesOrderFilters(args);

    const fetchOrders = (where: Record<string, unknown>) =>
      prisma.salesOrder.findMany({
        where: where as never,
        select: {
          ...SALES_ORDER_SCALAR_SELECT,
          ...(needItems ? { items: { select: SALES_ORDER_ITEM_SELECT } } : {}),
        },
        orderBy: { orderDate: 'desc' },
        take: scanLimit,
      });

    const orders = await fetchOrders({ ...dateWhere, ...statusWhere });
    const truncated = orders.length >= scanLimit;
    const filtered = applySalesOrderFilters(orders, args);

    // Zero results: say which filter emptied the result and whether matches exist outside the period.
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0) {
      const inRange = activeFilters.length > 0 ? await fetchOrders(dateWhere) : orders;
      const allDates =
        hasDateFilter && activeFilters.length > 0 ? applySalesOrderFilters(await fetchOrders(statusWhere), args) : null;
      diagnostic = {
        message: 'La consulta devolvió 0 resultados. NO respondas "no hay" sin revisar este diagnóstico y reintentar.',
        totalOrdersInDateRange: inRange.length,
        matchesPerFilterInDateRange: perFilterMatchCounts(inRange, args),
        ...(allDates
          ? {
              matchesWithSameFiltersAllDates: allDates.length,
              examplesOutsideDateRange: allDates.slice(0, 5).map((o) => ({
                number: o.salesOrderNumber,
                date: formatDate(o.orderDate),
                customer: o.customerName,
              })),
            }
          : {}),
        availableValuesInDateRange: {
          ticketStatus: statusDistribution('salesTicket', inRange.map((o) => ticketStatusOf(o).raw)),
          shippedStatus: statusDistribution('salesShipped', inRange.map((o) => o.shippedStatus)),
          paidStatus: statusDistribution('salesPaid', inRange.map((o) => o.paidStatus)),
          invoicedStatus: statusDistribution('salesInvoiced', inRange.map((o) => o.invoicedStatus)),
          status: statusDistribution('salesOrder', inRange.map((o) => o.status)),
          deliveryMethod: valueDistribution(inRange.map((o) => o.deliveryMethod)),
          paymentMethod: valueDistribution(inRange.map((o) => o.paymentMethod)),
          salesperson: valueDistribution(inRange.map((o) => o.salespersonName)),
        },
        hint:
          'El filtro con menos coincidencias en matchesPerFilterInDateRange es el que vació el resultado: corrige su valor con availableValuesInDateRange y reintenta. ' +
          'Si matchesWithSameFiltersAllDates > 0 las órdenes existen fuera del periodo: si el usuario no pidió fecha usa dateRange="all"; si la pidió, díselo con el número.',
      };
    }

    // Reconciliation: deliveryType is a heuristic classifier (only "pickup" vs "delivered to
    // customer"), so when it's used, surface how many orders matching the OTHER filters were left
    // out because their deliveryMethod didn't classify — otherwise sub-totals silently don't add
    // up to the total (e.g. "133 a domicilio + 148 en bodega" without saying 265 were unclassified).
    let deliveryReconciliation: Record<string, unknown> | null = null;
    if (args.deliveryType) {
      const withoutDeliveryType = { ...args, deliveryType: undefined };
      const sameOtherFilters = applySalesOrderFilters(orders, withoutDeliveryType);
      const unclassified = sameOtherFilters.filter((o) => classifyDeliveryMethod(o.deliveryMethod).length === 0);
      if (unclassified.length > 0) {
        deliveryReconciliation = {
          totalMatchingOtherFilters: sameOtherFilters.length,
          matchedThisDeliveryType: filtered.length,
          unclassifiedDeliveryMethod: unclassified.length,
          note:
            `${unclassified.length} de esas órdenes tienen un método de entrega vacío o no reconocido — no cuentan como "${args.deliveryType}" ni como el otro tipo. ` +
            'Para que la suma cierre, muéstralas aparte o usa groupBy="deliveryMethod" (sin deliveryType) para ver el desglose real por valor exacto.',
          exampleUnclassifiedDeliveryMethods: valueDistribution(unclassified.map((o) => o.deliveryMethod), 10),
        };
      }
    }

    const common = {
      dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      filters: Object.fromEntries(activeFilters.map((k) => [k, args[k]])),
      ...(filtered.length > 0 && activeFilters.length > 0 ? { interpretation: interpretSalesOrderMatches(filtered, args) } : {}),
      ...(deliveryReconciliation ? { deliveryReconciliation } : {}),
      ...(truncated
        ? {
            truncated: true,
            truncatedNote: `Se revisaron solo las ${scanLimit} órdenes más recientes del periodo; acota el periodo para totales exactos.`,
          }
        : {}),
      ...(diagnostic ? { diagnostic } : {}),
    };
    const totalRevenue = filtered.reduce((s, o) => s + toNumber(o.total), 0).toFixed(2);
    const totalBalance = filtered.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2);

    if (args.groupBy === 'none') {
      const paginated = filtered.slice((args.page - 1) * args.pageSize, args.page * args.pageSize);
      return {
        mode: 'list',
        total: filtered.length,
        showing: paginated.length,
        page: args.page,
        pageSize: args.pageSize,
        totalPages: Math.ceil(filtered.length / args.pageSize),
        totalSum: totalRevenue,
        balanceSum: totalBalance,
        ...common,
        orders: paginated.map((o) => formatOrder(o, args.includeItems, args.includeShippingAddress)),
      };
    }

    const groups = new Map<string, {
      count: number;
      total: number;
      balance: number;
      orders: typeof filtered;
      totalQuantity?: number;
      unit?: string;
    }>();

    for (const o of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'paymentMethod') key = o.paymentMethod ?? 'SIN MÉTODO DE PAGO';
      else if (args.groupBy === 'deliveryMethod') key = o.deliveryMethod ?? 'SIN MÉTODO DE ENTREGA';
      else if (args.groupBy === 'status') key = statusLabel('salesOrder', o.status) ?? 'SIN ESTADO';
      else if (args.groupBy === 'subStatus') key = o.subStatus ?? 'SIN SUB-ESTADO';
      else if (args.groupBy === 'paidStatus') key = statusLabel('salesPaid', o.paidStatus) ?? 'SIN ESTADO DE PAGO';
      else if (args.groupBy === 'invoicedStatus') key = statusLabel('salesInvoiced', o.invoicedStatus) ?? 'SIN ESTADO DE FACTURACIÓN';
      else if (args.groupBy === 'shippedStatus') key = statusLabel('salesShipped', o.shippedStatus) ?? 'SIN ESTADO DE ENTREGA';
      else if (args.groupBy === 'ticketStatus') key = ticketStatusOf(o).label;
      else if (args.groupBy === 'salesperson') key = o.salespersonName ?? 'SIN VENDEDOR';
      else if (args.groupBy === 'location') key = o.locationName ?? 'SIN SUCURSAL';
      else if (args.groupBy === 'customer') key = o.customerName ?? 'SIN CLIENTE';
      else if (args.groupBy === 'date') key = formatDate(o.orderDate) ?? 'SIN FECHA';
      else if (args.groupBy === 'product') {
        const items = (o as { items?: Array<{ name?: string; quantity?: unknown; unit?: string; lineTotal?: unknown }> }).items ?? [];
        if (items.length === 0) {
          const g = groups.get('SIN PRODUCTOS') ?? { count: 0, total: 0, balance: 0, orders: [] as typeof filtered };
          g.count++;
          g.total += toNumber(o.total);
          g.balance += toNumber(o.balance);
          g.orders.push(o);
          groups.set('SIN PRODUCTOS', g);
        } else {
          for (const item of items) {
            const pkey = item.name ?? 'SIN NOMBRE';
            const g = groups.get(pkey) ?? {
              count: 0,
              total: 0,
              balance: 0,
              orders: [] as typeof filtered,
              totalQuantity: 0,
              unit: item.unit ?? '',
            };
            g.count++;
            g.total += toNumber(item.lineTotal);
            g.balance += toNumber(o.balance);
            g.totalQuantity = (g.totalQuantity ?? 0) + toNumber(item.quantity);
            if (!g.unit && item.unit) g.unit = item.unit;
            g.orders.push(o);
            groups.set(pkey, g);
          }
        }
        continue;
      }

      const g = groups.get(key) ?? { count: 0, total: 0, balance: 0, orders: [] as typeof filtered };
      g.count++;
      g.total += toNumber(o.total);
      g.balance += toNumber(o.balance);
      g.orders.push(o);
      groups.set(key, g);
    }

    const includeGroupOrders = args.includeItems || args.includeShippingAddress || args.groupBy === 'product';
    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key,
        count: g.count,
        total: g.total.toFixed(2),
        balance: g.balance.toFixed(2),
        ...(args.groupBy === 'product' && g.totalQuantity !== undefined
          ? { totalQuantity: g.totalQuantity.toFixed(2), unit: g.unit ?? '' }
          : {}),
        orderNumbers: g.orders.slice(0, 50).map((o) => o.salesOrderNumber),
        ...(includeGroupOrders
          ? {
              orders: g.orders
                .slice(0, 50)
                .map((o) => formatOrder(o, args.includeItems || args.groupBy === 'product', args.includeShippingAddress)),
            }
          : {}),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    return {
      mode: 'grouped',
      groupBy: args.groupBy,
      groupCount: groups.size,
      totalOrders: filtered.length,
      totalRevenue,
      totalBalance,
      ...common,
      groups: groupedResult,
    };
  },
});

/** Helper to format an order for the response (statuses in Spanish). */
function formatOrder(
  o: Record<string, unknown>,
  includeItems: boolean,
  includeShippingAddress: boolean
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    number: o.salesOrderNumber,
    date: formatDate(o.orderDate as Date | null | undefined),
    customer: o.customerName,
    salesperson: o.salespersonName,
    status: statusLabel('salesOrder', o.status as string | null),
    paidStatus: statusLabel('salesPaid', o.paidStatus as string | null),
    invoicedStatus: statusLabel('salesInvoiced', o.invoicedStatus as string | null),
    shippedStatus: statusLabel('salesShipped', o.shippedStatus as string | null),
    ticketStatus: ticketStatusOf(o).label,
    paymentMethod: o.paymentMethod,
    deliveryMethod: o.deliveryMethod,
    location: o.locationName,
    total: decimalToString(o.total),
    balance: decimalToString(o.balance),
  };

  if (includeItems) {
    const items = (o.items as Array<Record<string, unknown>> | undefined) ?? [];
    result.items = items.map((item) => ({
      name: item.name,
      sku: item.sku,
      quantity: decimalToString(item.quantity),
      unit: item.unit,
      rate: decimalToString(item.rate),
      lineTotal: decimalToString(item.lineTotal),
      description: item.description,
    }));
  }

  if (includeShippingAddress) {
    const addrParts = [
      o.shippingAddressLine1,
      o.shippingAddressLine2,
      o.shippingCity,
      o.shippingState,
      o.shippingPostalCode,
    ].filter((p) => p !== null && p !== undefined && String(p).trim() !== '');
    result.shippingAddress = addrParts.length > 0 ? addrParts.join(', ') : null;
    result.phone = o.shippingPhone ?? o.customerPhone ?? null;
    if (o.notes) result.notes = String(o.notes).slice(0, 300);
  }

  return result;
}

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
    'Ventas filtradas por método de pago: conteo, total y lista de órdenes. ' +
    'Métodos de pago disponibles: EFECTIVO, EFECTIVO EN BODEGA, TRANSFERENCIA, DEPOSITO, TARJETA. ' +
    'IMPORTANTE: "EFECTIVO" y "EFECTIVO EN BODEGA" son métodos DIFERENTES — no los mezcles.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe("Fecha inicio YYYY-MM-DD. Para fechas especificas (ej: 19 de agosto 2026 = 2026-08-19) o meses (ej: agosto 2026 = 2026-08-01)."),
    dateTo: z.string().optional().describe("Fecha fin YYYY-MM-DD. Misma fecha que dateFrom para un dia especifico (ej: 2026-08-19) o fin de mes (ej: 2026-08-31)."),
    paymentMethods: z.array(
      z.enum(['EFECTIVO', 'EFECTIVO EN BODEGA', 'TRANSFERENCIA', 'DEPOSITO', 'TARJETA'])
    ).default(['EFECTIVO']).describe(
      'Métodos de pago EXACTOS a incluir (en mayúsculas). ' +
      'Si el usuario pide "efectivo" → ["EFECTIVO"]. ' +
      'Si pide "efectivo en bodega" → ["EFECTIVO EN BODEGA"]. ' +
      'Si pide "transferencia" → ["TRANSFERENCIA"]. ' +
      'Si pide "efectivo y transferencia" → ["EFECTIVO", "TRANSFERENCIA"]. ' +
      'NUNCA incluyas "EFECTIVO EN BODEGA" si el usuario pide solo "efectivo". ' +
      'Default: ["EFECTIVO"].'
    ),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { dateRange: string; dateFrom?: string; dateTo?: string; paymentMethods: string[] };
    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    const orders = await prisma.salesOrder.findMany({
      where: {
        ...dateWhere,
        paymentMethod: { in: args.paymentMethods, mode: 'insensitive' },
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
      paymentMethods: args.paymentMethods,
      dateFilter: {
        dateRange: args.dateRange,
        dateFrom: args.dateFrom ?? null,
        dateTo: args.dateTo ?? null,
      },
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
  description: 'Buscar órdenes de venta por filtros simples. Devuelve lista paginada con datos básicos, incluyendo folios, cliente, método de pago, método de entrega, estado, vendedor, total y balance.',
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
    deliveryMethod: z.string().optional().describe('Filtrar por método de entrega (búsqueda parcial). Ej: "A PIE DE OBRA", "RECOGE EN BODEGA", "INSTALACIÓN".'),
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
      deliveryMethod?: string;
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
    // NOTE: deliveryMethod is filtered in JavaScript (not in SQL) for reliability
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

    // Fetch all matching records (without deliveryMethod filter in SQL)
    // then filter by deliveryMethod in JavaScript for reliability
    const allOrders = await prisma.salesOrder.findMany({
      where: where as never,
      select: {
        id: true,
        salesOrderNumber: true,
        customerName: true,
        salespersonName: true,
        status: true,
        subStatus: true,
        paidStatus: true,
        invoicedStatus: true,
        shippedStatus: true,
        paymentMethod: true,
        deliveryMethod: true,
        locationName: true,
        total: true,
        balance: true,
        orderDate: true,
      },
      orderBy: { orderDate: 'desc' },
      take: 500,
    });

    // Filter by deliveryMethod in JavaScript (case-insensitive partial match)
    const filterMethod = args.deliveryMethod?.trim().toLowerCase();
    const filteredOrders = filterMethod
      ? allOrders.filter((o) => {
          const dm = o.deliveryMethod?.toLowerCase() ?? '';
          return dm.includes(filterMethod);
        })
      : allOrders;

    // Paginate the filtered results
    const total = filteredOrders.length;
    const paginatedOrders = filteredOrders.slice(
      (args.page - 1) * args.pageSize,
      args.page * args.pageSize
    );

    // Calculate sums from filtered results
    const totalSum = filteredOrders.reduce((s, o) => s + toNumber(o.total), 0);
    const balanceSum = filteredOrders.reduce((s, o) => s + toNumber(o.balance), 0);

    return {
      rows: paginatedOrders.map((o) => ({
        id: o.id,
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
      total,
      page: args.page,
      pageSize: args.pageSize,
      totalPages: Math.ceil(total / args.pageSize),
      totalSum: totalSum.toFixed(2),
      balanceSum: balanceSum.toFixed(2),
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

// 4b. getSalesOrderFullFile — Full file with all cross-module relations
registerTool({
  name: 'getSalesOrderFullFile',
  description: 'Expediente completo de una orden de venta: incluye la orden, sus items, facturas relacionadas, paquetes relacionados, pagos relacionados y datos del cliente. Útil para responder "¿en qué estado está este ticket?" o "¿qué falta por hacer?".',
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

    const relations = await getSalesOrderRelations(order.zohoSalesOrderId, order.zohoCustomerId, order.salesOrderNumber);
    const ticketStatus = getTicketStatus({
      status: order.status,
      subStatus: order.subStatus,
      paidStatus: order.paidStatus,
      invoicedStatus: order.invoicedStatus,
      shippedStatus: order.shippedStatus,
    });

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
        ticketStatus: ticketStatus.label,
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
          quantity: decimalToString(it.quantity),
          rate: decimalToString(it.rate),
          lineTotal: decimalToString(it.lineTotal),
        })),
      },
      relatedInvoices: relations.invoices,
      relatedPackages: relations.packages,
      relatedPayments: relations.payments,
      relatedContact: relations.contact,
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
