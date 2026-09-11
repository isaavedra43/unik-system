import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import {
  formatDate,
  buildOrderDateWhereFlexible,
  dateRangeSchema,
} from './date-helpers';

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

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 0. querySalesOrders — UNIVERSAL sales query tool                   */
/* Handles ANY combination of filters + grouping + item details       */
/* ------------------------------------------------------------------ */
const GROUP_BY_DIMENSIONS = [
  'none', 'paymentMethod', 'deliveryMethod', 'status', 'subStatus', 'paidStatus',
  'salesperson', 'location', 'customer', 'date', 'product',
] as const;

registerTool({
  name: 'querySalesOrders',
  description:
    'TOOL UNIVERSAL de ventas. Úsalo para CUALQUIER consulta de ventas, sola o combinada. ' +
    'Soporta filtrar por fecha, método de pago, método de entrega, cliente, vendedor, estado general (status), sub-estado de entrega (subStatus), estado de pago (paidStatus), estado de facturación (invoicedStatus), sucursal, y producto. ' +
    'Puede agrupar por cualquier dimensión. Puede incluir los items (productos) y direcciones de entrega. ' +
    'ESTADOS: status="Confirmada", subStatus="Pendiente"/"Enviado", paidStatus="Pagada"/"Parcial"/"Pendiente". ' +
    '"Pendiente de entrega" = subStatus="Pendiente", NO status="pending". ' +
    '"No pagadas" = paidStatus="Pendiente" o paidStatus="Parcial". ' +
    'EJEMPLOS: ' +
    '"ventas de hoy en efectivo" → querySalesOrders(dateRange="today", paymentMethods=["EFECTIVO"]). ' +
    '"ventas a pie de obra de hoy" → querySalesOrders(dateRange="today", deliveryMethod="A PIE DE OBRA"). ' +
    '"ventas de efectivo y transferencia de ayer" → querySalesOrders(dateRange="yesterday", paymentMethods=["EFECTIVO","TRANSFERENCIA"]). ' +
    '"ventas por método de entrega de hoy" → querySalesOrders(dateRange="today", groupBy="deliveryMethod"). ' +
    '"ventas por vendedor de este mes" → querySalesOrders(dateRange="this_month", groupBy="salesperson"). ' +
    '"ventas del producto silla de hoy" → querySalesOrders(dateRange="today", product="silla"). ' +
    '"ventas de hoy con detalle de productos" → querySalesOrders(dateRange="today", includeItems=true). ' +
    '"ventas de hoy en efectivo a pie de obra" → querySalesOrders(dateRange="today", paymentMethods=["EFECTIVO"], deliveryMethod="A PIE DE OBRA"). ' +
    '"pendientes de entrega de hoy" → querySalesOrders(dateRange="today", shippedStatus="Pendiente"). ' +
    '"no pagadas de hoy" → querySalesOrders(dateRange="today", paidStatus="Pendiente"). ' +
    '"parcialmente pagadas de hoy" → querySalesOrders(dateRange="today", paidStatus="Parcial"). ' +
    '"ventas por enviar de la semana" → querySalesOrders(dateRange="this_week", shippedStatus="Pendiente"). ' +
    '"ventas no entregadas de ayer" → querySalesOrders(dateRange="yesterday", shippedStatus="Pendiente"). ' +
    'ENTREGAS ABIERTAS (CRÍTICOS): ' +
    '"entregas abiertas semana" → querySalesOrders(dateRange="this_week", shippedStatus="Pendiente", includeShippingAddress=true). ' +
    '"entregas abiertas a pie de obra" → querySalesOrders(deliveryMethod="A PIE DE OBRA", shippedStatus="Pendiente", includeShippingAddress=true). ' +
    '"entregas abiertas semana a pie de obra" → querySalesOrders(dateRange="this_week", deliveryMethod="A PIE DE OBRA", shippedStatus="Pendiente", includeShippingAddress=true, includeItems=true). ' +
    '"venta no he entregado" → querySalesOrders(shippedStatus="Pendiente", includeShippingAddress=true). ' +
    '"ordenes pendientes de entrega" → querySalesOrders(shippedStatus="Pendiente"). ' +
    'NOTA: Para entregas SIEMPRE usa shippedStatus, NO subStatus. deliveryMethod = CÓMO se entrega ("A PIE DE OBRA"). shippedStatus = ESTADO de la entrega ("Pendiente" o "Enviado").',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD. Para fechas específicas.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    // Payment filters
    paymentMethods: z.array(z.string()).optional().describe(
      'Filtrar por métodos de pago EXACTOS (mayúsculas). Ej: ["EFECTIVO"], ["EFECTIVO","TRANSFERENCIA"], ["EFECTIVO EN BODEGA"]. ' +
      'NUNCA incluyas "EFECTIVO EN BODEGA" si el usuario pide solo "efectivo".'
    ),
    // Delivery filter
    deliveryMethod: z.string().optional().describe(
      'Filtrar por método de entrega (búsqueda parcial, case-insensitive). Ej: "A PIE DE OBRA", "RECOGE EN BODEGA", "INSTALACIÓN".'
    ),
    // Other filters
    customer: z.string().optional().describe('Filtrar por nombre del cliente (búsqueda parcial).'),
    salesperson: z.string().optional().describe('Filtrar por vendedor (búsqueda parcial).'),
    status: z.string().optional().describe(
      'Filtrar por estado GENERAL de la orden (búsqueda parcial). ' +
      'Valores típicos: "Confirmada", "Cerrada". ' +
      'NO uses este filtro para "pendiente de entrega" o "no pagada" — usa subStatus o paidStatus.'
    ),
    subStatus: z.string().optional().describe(
      'Filtrar por sub-estado (búsqueda parcial). ' +
      'Valores típicos: "confirmed", "closed", "draft", "void". ' +
      'NO uses este filtro para "pendiente de entrega" — usa shippedStatus.'
    ),
    paidStatus: z.string().optional().describe(
      'Filtrar por estado de PAGO (búsqueda parcial). ' +
      'Valores típicos: "Pagada", "Parcial", "Pendiente". ' +
      'Úsalo cuando el usuario pregunte por "no pagadas", "con saldo", "pendientes de pago", "a crédito".'
    ),
    invoicedStatus: z.string().optional().describe(
      'Filtrar por estado de FACTURACIÓN (búsqueda parcial). ' +
      'Valores típicos: "Facturada", "Pendiente".'
    ),
    shippedStatus: z.string().optional().describe(
      'Filtrar por estado de ENVÍO/ENTREGA (búsqueda parcial). ' +
      'Valores típicos: "Pendiente" (pendiente de enviar), "Enviado" (ya enviado). ' +
      'Úsalo cuando el usuario pregunte por "pendientes de entrega", "no enviados", "por enviar", "no entregados", "faltan por enviar".'
    ),
    location: z.string().optional().describe('Filtrar por sucursal (búsqueda parcial). Ej: "Patio Unik".'),
    product: z.string().optional().describe(
      'Filtrar por nombre de producto (búsqueda parcial en los items de la orden). ' +
      'Ej: "silla", "loseta", "cemento". Solo devuelve órdenes que contienen ese producto.'
    ),
    search: z.string().optional().describe('Búsqueda libre en número de orden, cliente, referencia.'),
    // Grouping
    groupBy: z.enum(GROUP_BY_DIMENSIONS).default('none').describe(
      'Agrupar resultados por una dimensión. ' +
      '"none" = lista de órdenes individuales. ' +
      '"paymentMethod" = agrupar por método de pago. ' +
      '"deliveryMethod" = agrupar por método de entrega. ' +
      '"salesperson" = agrupar por vendedor. ' +
      '"location" = agrupar por sucursal. ' +
      '"customer" = agrupar por cliente. ' +
      '"status" = agrupar por estado general. ' +
      '"subStatus" = agrupar por sub-estado de entrega. ' +
      '"paidStatus" = agrupar por estado de pago. ' +
      '"date" = agrupar por fecha. ' +
      '"product" = agrupar por producto (requiere includeItems o product filter).'
    ),
    // Output options
    includeItems: z.boolean().default(false).describe(
      'true = incluir los items (productos) de cada orden con nombre, cantidad, unidad y total. ' +
      'Útil cuando el usuario pide "qué productos tiene cada venta" o "detalle de productos".'
    ),
    includeShippingAddress: z.boolean().default(false).describe(
      'true = incluir la dirección de entrega de cada orden. ' +
      'Útil cuando el usuario pide "dirección de entrega" o "dónde se entregó".'
    ),
    // Pagination
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string;
      dateFrom?: string;
      dateTo?: string;
      paymentMethods?: string[];
      deliveryMethod?: string;
      customer?: string;
      salesperson?: string;
      status?: string;
      subStatus?: string;
      paidStatus?: string;
      invoicedStatus?: string;
      shippedStatus?: string;
      location?: string;
      product?: string;
      search?: string;
      groupBy: (typeof GROUP_BY_DIMENSIONS)[number];
      includeItems: boolean;
      includeShippingAddress: boolean;
      page: number;
      pageSize: number;
    };

    const dateWhere = buildOrderDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo);

    // Build the base where clause — only date goes in SQL, everything else in JS
    const where: Record<string, unknown> = { ...dateWhere };

    // Fetch orders with items if needed
    const orders = await prisma.salesOrder.findMany({
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
        referenceNumber: true,
        shippingAddressLine1: true,
        shippingAddressLine2: true,
        shippingCity: true,
        shippingState: true,
        shippingPostalCode: true,
        ...(args.includeItems || args.product || args.groupBy === 'product' ? {
          items: {
            select: {
              name: true,
              sku: true,
              quantity: true,
              unit: true,
              rate: true,
              lineTotal: true,
              description: true,
            },
          },
        } : {}),
      },
      orderBy: { orderDate: 'desc' },
      take: 1000,
    });

    // Apply ALL filters in JavaScript for reliability
    let filtered = orders;

    // Payment methods filter (exact match, case-insensitive)
    if (args.paymentMethods && args.paymentMethods.length > 0) {
      const methods = args.paymentMethods.map((m) => m.toLowerCase());
      filtered = filtered.filter((o) => {
        const pm = o.paymentMethod?.toLowerCase() ?? '';
        return methods.includes(pm);
      });
    }

    // Delivery method filter (partial match, case-insensitive)
    if (args.deliveryMethod) {
      const dm = args.deliveryMethod.toLowerCase();
      filtered = filtered.filter((o) => {
        const odm = o.deliveryMethod?.toLowerCase() ?? '';
        return odm.includes(dm);
      });
    }

    // Customer filter (partial match)
    if (args.customer) {
      const c = args.customer.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.customerName?.toLowerCase() ?? '').includes(c)
      );
    }

    // Salesperson filter (partial match)
    if (args.salesperson) {
      const s = args.salesperson.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.salespersonName?.toLowerCase() ?? '').includes(s)
      );
    }

    // Status filter (partial match on status field)
    if (args.status) {
      const s = args.status.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.status?.toLowerCase() ?? '').includes(s)
      );
    }

    // SubStatus filter (partial match — for "pendiente de entrega", "enviado", etc.)
    if (args.subStatus) {
      const s = args.subStatus.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.subStatus?.toLowerCase() ?? '').includes(s)
      );
    }

    // PaidStatus filter (partial match — for "no pagadas", "con saldo", etc.)
    if (args.paidStatus) {
      const s = args.paidStatus.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.paidStatus?.toLowerCase() ?? '').includes(s)
      );
    }

    // InvoicedStatus filter (partial match — for "facturadas", "no facturadas", etc.)
    if (args.invoicedStatus) {
      const s = args.invoicedStatus.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.invoicedStatus?.toLowerCase() ?? '').includes(s)
      );
    }

    // ShippedStatus filter (partial match — for "pendiente de envío", "no enviados", etc.)
    if (args.shippedStatus) {
      const s = args.shippedStatus.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.shippedStatus?.toLowerCase() ?? '').includes(s)
      );
    }

    // Location filter (partial match)
    if (args.location) {
      const l = args.location.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.locationName?.toLowerCase() ?? '').includes(l)
      );
    }

    // Product filter (partial match on items)
    if (args.product) {
      const p = args.product.toLowerCase();
      filtered = filtered.filter((o) => {
        const items = (o as { items?: Array<{ name?: string }> }).items ?? [];
        return items.some((item) => (item.name?.toLowerCase() ?? '').includes(p));
      });
    }

    // Free text search
    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.salesOrderNumber?.toLowerCase() ?? '').includes(s) ||
        (o.customerName?.toLowerCase() ?? '').includes(s) ||
        (o.referenceNumber?.toLowerCase() ?? '').includes(s)
      );
    }

    // AUTO-DIAGNÓSTICO: Si hay 0 resultados Y se usó algún filtro de estado,
    // hacer una consulta sin ese filtro para mostrar qué valores existen realmente.
    // Esto evita que la IA afirme "no hay datos" cuando el filtro estaba mal.
    const usedStatusFilter = !!(args.status || args.subStatus || args.paidStatus || args.invoicedStatus || args.shippedStatus);
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && usedStatusFilter) {
      // Consultar sin filtros de estado para ver qué valores existen
      const ordersForDiagnosis = orders; // Ya tenemos todas las órdenes del rango de fechas
      const uniqueStatuses = new Map<string, number>();
      const uniqueSubStatuses = new Map<string, number>();
      const uniquePaidStatuses = new Map<string, number>();
      const uniqueInvoicedStatuses = new Map<string, number>();
      const uniqueShippedStatuses = new Map<string, number>();
      for (const o of ordersForDiagnosis) {
        if (o.status) uniqueStatuses.set(o.status, (uniqueStatuses.get(o.status) ?? 0) + 1);
        if (o.subStatus) uniqueSubStatuses.set(o.subStatus, (uniqueSubStatuses.get(o.subStatus) ?? 0) + 1);
        if (o.paidStatus) uniquePaidStatuses.set(o.paidStatus, (uniquePaidStatuses.get(o.paidStatus) ?? 0) + 1);
        if (o.invoicedStatus) uniqueInvoicedStatuses.set(o.invoicedStatus, (uniqueInvoicedStatuses.get(o.invoicedStatus) ?? 0) + 1);
        if (o.shippedStatus) uniqueShippedStatuses.set(o.shippedStatus, (uniqueShippedStatuses.get(o.shippedStatus) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta con los filtros actuales devolvió 0 resultados. Aquí están los valores disponibles en el rango de fechas:',
        totalOrdersInDateRange: ordersForDiagnosis.length,
        availableStatuses: [...uniqueStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableSubStatuses: [...uniqueSubStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        availablePaidStatuses: [...uniquePaidStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableInvoicedStatuses: [...uniqueInvoicedStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableShippedStatuses: [...uniqueShippedStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        hint: 'Reintenta con un valor que SÍ exista en la lista anterior. NO digas "no hay datos" — reintenta con el valor correcto.',
      };
    }

    // Build the response based on groupBy
    if (args.groupBy === 'none') {
      // Return individual orders (paginated)
      const total = filtered.length;
      const totalPages = Math.ceil(total / args.pageSize);
      const paginated = filtered.slice(
        (args.page - 1) * args.pageSize,
        args.page * args.pageSize
      );

      const totalSum = filtered.reduce((s, o) => s + toNumber(o.total), 0);
      const balanceSum = filtered.reduce((s, o) => s + toNumber(o.balance), 0);

      return {
        mode: 'list',
        total,
        page: args.page,
        pageSize: args.pageSize,
        totalPages,
        totalSum: totalSum.toFixed(2),
        balanceSum: balanceSum.toFixed(2),
        dateFilter: {
          dateRange: args.dateRange,
          dateFrom: args.dateFrom ?? null,
          dateTo: args.dateTo ?? null,
        },
        filters: {
          paymentMethods: args.paymentMethods ?? null,
          deliveryMethod: args.deliveryMethod ?? null,
          customer: args.customer ?? null,
          salesperson: args.salesperson ?? null,
          status: args.status ?? null,
          subStatus: args.subStatus ?? null,
          paidStatus: args.paidStatus ?? null,
          invoicedStatus: args.invoicedStatus ?? null,
          shippedStatus: args.shippedStatus ?? null,
          location: args.location ?? null,
          product: args.product ?? null,
          search: args.search ?? null,
        },
        ...(diagnostic ? { diagnostic } : {}),
        orders: paginated.map((o) => formatOrder(o, args.includeItems, args.includeShippingAddress)),
      };
    }

    // Group by dimension
    // For product grouping, we track total quantity per product and addresses per order
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
      else if (args.groupBy === 'status') key = o.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'subStatus') key = o.subStatus ?? 'SIN SUB-ESTADO';
      else if (args.groupBy === 'paidStatus') key = o.paidStatus ?? 'SIN ESTADO DE PAGO';
      else if (args.groupBy === 'salesperson') key = o.salespersonName ?? 'SIN VENDEDOR';
      else if (args.groupBy === 'location') key = o.locationName ?? 'SIN SUCURSAL';
      else if (args.groupBy === 'customer') key = o.customerName ?? 'SIN CLIENTE';
      else if (args.groupBy === 'date') key = formatDate(o.orderDate) ?? 'SIN FECHA';
      else if (args.groupBy === 'product') {
        // Group by product — each order's items expand into multiple groups
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

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key,
        count: g.count,
        total: g.total.toFixed(2),
        balance: g.balance.toFixed(2),
        // For product grouping, include total quantity (m²) and unit
        ...(args.groupBy === 'product' && g.totalQuantity !== undefined ? {
          totalQuantity: g.totalQuantity.toFixed(2),
          unit: g.unit ?? '',
        } : {}),
        ...(args.includeItems || args.groupBy === 'product' ? {
          orders: g.orders.slice(0, 50).map((o) => formatOrder(o, args.includeItems || args.groupBy === 'product', args.includeShippingAddress)),
        } : {}),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total));

    return {
      mode: 'grouped',
      groupBy: args.groupBy,
      groupCount: groups.size,
      totalOrders: filtered.length,
      totalRevenue: filtered.reduce((s, o) => s + toNumber(o.total), 0).toFixed(2),
      totalBalance: filtered.reduce((s, o) => s + toNumber(o.balance), 0).toFixed(2),
      dateFilter: {
        dateRange: args.dateRange,
        dateFrom: args.dateFrom ?? null,
        dateTo: args.dateTo ?? null,
      },
      filters: {
        paymentMethods: args.paymentMethods ?? null,
        deliveryMethod: args.deliveryMethod ?? null,
        customer: args.customer ?? null,
        salesperson: args.salesperson ?? null,
        status: args.status ?? null,
        subStatus: args.subStatus ?? null,
        paidStatus: args.paidStatus ?? null,
        invoicedStatus: args.invoicedStatus ?? null,
        location: args.location ?? null,
        product: args.product ?? null,
        search: args.search ?? null,
      },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

/** Helper to format an order for the response. */
function formatOrder(
  o: Record<string, unknown>,
  includeItems: boolean,
  includeShippingAddress: boolean
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    number: o.salesOrderNumber,
    customer: o.customerName,
    salesperson: o.salespersonName,
    status: o.status,
    subStatus: o.subStatus,
    paidStatus: o.paidStatus,
    invoicedStatus: o.invoicedStatus,
    shippedStatus: o.shippedStatus,
    paymentMethod: o.paymentMethod,
    deliveryMethod: o.deliveryMethod,
    location: o.locationName,
    total: decimalToString(o.total),
    balance: decimalToString(o.balance),
    date: formatDate(o.orderDate as Date | null | undefined),
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
