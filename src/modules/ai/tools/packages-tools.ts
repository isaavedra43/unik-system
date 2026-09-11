import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import {
  dateRangeSchema,
  formatDate,
  buildDateWhereFlexible,
} from './date-helpers';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

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
/* 1. queryPackages — Universal packages (shipments) query tool       */
/* ------------------------------------------------------------------ */

const PACKAGE_GROUP_BY = ['none', 'customer', 'status', 'carrier', 'deliveryMethod', 'date'] as const;

registerTool({
  name: 'queryPackages',
  description:
    'TOOL UNIVERSAL de paquetes/envíos. Úsalo para CUALQUIER consulta de paquetes y envíos. ' +
    'Soporta filtrar por fecha, cliente (customer), estado (status), tipo de envío (shipmentType), ' +
    'transportista (carrier), método de entrega (deliveryMethod) y búsqueda libre (search). ' +
    'Puede agrupar por cliente, estado, transportista, método de entrega o fecha. ' +
    'Puede incluir los items (productos) con includeItems=true y la dirección de envío con includeShippingAddress=true. ' +
    'EJEMPLOS: ' +
    '"paquetes de esta semana" → queryPackages(dateRange="this_week"). ' +
    '"paquetes abiertos" → queryPackages(status="open"). ' +
    '"paquetes del cliente X" → queryPackages(customer="X"). ' +
    '"paquetes con tracking" → queryPackages(dateRange="this_month"). ' +
    '"paquetes por transportista" → queryPackages(dateRange="this_month", groupBy="carrier"). ' +
    '"paquetes por cliente de esta semana" → queryPackages(dateRange="this_week", groupBy="customer"). ' +
    'PATRONES: "envíos abiertos" = status="open" • "envíos entregados" = status="delivered" • "envíos por DHL" = carrier="DHL" • "paquetes sin enviar" = status="open".',
  category: 'packages',
  requiredPermission: 'packages.view',
  enabledByDefault: true,
  parameters: z.object({
    dateRange: dateRangeSchema,
    dateFrom: z.string().optional().describe('Fecha inicio YYYY-MM-DD.'),
    dateTo: z.string().optional().describe('Fecha fin YYYY-MM-DD.'),
    customer: z.string().optional().describe('Filtrar por nombre del cliente (búsqueda parcial).'),
    status: z.string().optional().describe(
      'Filtrar por estado (búsqueda parcial). Valores típicos: "open", "shipped", "delivered", "void".'
    ),
    shipmentType: z.string().optional().describe('Filtrar por tipo de envío (búsqueda parcial).'),
    carrier: z.string().optional().describe('Filtrar por transportista (búsqueda parcial). Ej: "DHL", "FEDEX", "ESTAFETA".'),
    deliveryMethod: z.string().optional().describe('Filtrar por método de entrega (búsqueda parcial).'),
    search: z.string().optional().describe(
      'Búsqueda libre en número de paquete, cliente, número de tracking, número de orden de venta.'
    ),
    groupBy: z.enum(PACKAGE_GROUP_BY).default('none').describe(
      'Agrupar resultados. "none" = lista individual. "customer" = por cliente. "status" = por estado. "carrier" = por transportista. "deliveryMethod" = por método de entrega. "date" = por fecha.'
    ),
    includeItems: z.boolean().default(false).describe(
      'true = incluir los items (productos) de cada paquete con nombre, SKU y cantidad.'
    ),
    includeShippingAddress: z.boolean().default(false).describe(
      'true = incluir la dirección de envío de cada paquete.'
    ),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      dateRange: string; dateFrom?: string; dateTo?: string;
      customer?: string; status?: string; shipmentType?: string; carrier?: string;
      deliveryMethod?: string; search?: string;
      groupBy: (typeof PACKAGE_GROUP_BY)[number];
      includeItems: boolean; includeShippingAddress: boolean;
      page: number; pageSize: number;
    };

    const dateWhere = buildDateWhereFlexible(args.dateRange, args.dateFrom, args.dateTo, 'date');
    const where: Record<string, unknown> = { ...dateWhere };

    const packages = await prisma.package.findMany({
      where: where as never,
      select: {
        id: true,
        packageNumber: true,
        customerName: true,
        status: true,
        date: true,
        shipmentType: true,
        carrier: true,
        trackingNumber: true,
        deliveryMethod: true,
        shippingCharge: true,
        shipmentDate: true,
        shipmentStatus: true,
        salesorderNumber: true,
        quantity: true,
        shippingAttention: true,
        shippingAddress: true,
        shippingCity: true,
        shippingState: true,
        shippingZip: true,
        shippingCountry: true,
        shippingPhone: true,
        isCarrierShipment: true,
        isTrackingEnabled: true,
        salesChannel: true,
        ...(args.includeItems ? {
          items: {
            select: {
              name: true,
              sku: true,
              quantity: true,
              unit: true,
              description: true,
            },
          },
        } : {}),
      },
      orderBy: { date: 'desc' },
      take: 1000,
    });

    // Apply filters in JavaScript for reliability
    let filtered = packages;

    if (args.customer) {
      const c = args.customer.toLowerCase();
      filtered = filtered.filter((o) => (o.customerName?.toLowerCase() ?? '').includes(c));
    }
    if (args.status) {
      const s = args.status.toLowerCase();
      filtered = filtered.filter((o) => (o.status?.toLowerCase() ?? '').includes(s));
    }
    if (args.shipmentType) {
      const s = args.shipmentType.toLowerCase();
      filtered = filtered.filter((o) => (o.shipmentType?.toLowerCase() ?? '').includes(s));
    }
    if (args.carrier) {
      const c = args.carrier.toLowerCase();
      filtered = filtered.filter((o) => (o.carrier?.toLowerCase() ?? '').includes(c));
    }
    if (args.deliveryMethod) {
      const d = args.deliveryMethod.toLowerCase();
      filtered = filtered.filter((o) => (o.deliveryMethod?.toLowerCase() ?? '').includes(d));
    }
    if (args.search) {
      const s = args.search.toLowerCase();
      filtered = filtered.filter((o) =>
        (o.packageNumber?.toLowerCase() ?? '').includes(s) ||
        (o.customerName?.toLowerCase() ?? '').includes(s) ||
        (o.trackingNumber?.toLowerCase() ?? '').includes(s) ||
        (o.salesorderNumber?.toLowerCase() ?? '').includes(s)
      );
    }

    // Auto-diagnóstico
    const usedFilter = !!(args.status || args.carrier || args.deliveryMethod || args.shipmentType);
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && usedFilter) {
      const uniqueStatuses = new Map<string, number>();
      const uniqueCarriers = new Map<string, number>();
      const uniqueDeliveryMethods = new Map<string, number>();
      for (const o of packages) {
        if (o.status) uniqueStatuses.set(o.status, (uniqueStatuses.get(o.status) ?? 0) + 1);
        if (o.carrier) uniqueCarriers.set(o.carrier, (uniqueCarriers.get(o.carrier) ?? 0) + 1);
        if (o.deliveryMethod) uniqueDeliveryMethods.set(o.deliveryMethod, (uniqueDeliveryMethods.get(o.deliveryMethod) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta devolvió 0 resultados. Valores disponibles:',
        totalPackagesInDateRange: packages.length,
        availableStatuses: [...uniqueStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableCarriers: [...uniqueCarriers.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableDeliveryMethods: [...uniqueDeliveryMethods.entries()].map(([v, c]) => ({ value: v, count: c })),
        hint: 'Reintenta con un valor que SÍ exista.',
      };
    }

    if (args.groupBy === 'none') {
      const total = filtered.length;
      const totalPages = Math.ceil(total / args.pageSize);
      const paginated = filtered.slice((args.page - 1) * args.pageSize, args.page * args.pageSize);
      const shippingSum = filtered.reduce((s, o) => s + toNumber(o.shippingCharge), 0);

      return {
        mode: 'list',
        total, page: args.page, pageSize: args.pageSize, totalPages,
        shippingSum: shippingSum.toFixed(2),
        dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
        filters: {
          customer: args.customer ?? null, status: args.status ?? null,
          shipmentType: args.shipmentType ?? null, carrier: args.carrier ?? null,
          deliveryMethod: args.deliveryMethod ?? null, search: args.search ?? null,
        },
        ...(diagnostic ? { diagnostic } : {}),
        packages: paginated.map((o) => formatPackage(o, args.includeItems, args.includeShippingAddress)),
      };
    }

    // Group by
    const groups = new Map<string, { count: number; shipping: number; packages: typeof filtered }>();
    for (const o of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'customer') key = o.customerName ?? 'SIN CLIENTE';
      else if (args.groupBy === 'status') key = o.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'carrier') key = o.carrier ?? 'SIN TRANSPORTISTA';
      else if (args.groupBy === 'deliveryMethod') key = o.deliveryMethod ?? 'SIN MÉTODO DE ENTREGA';
      else if (args.groupBy === 'date') key = formatDate(o.date) ?? 'SIN FECHA';
      const g = groups.get(key) ?? { count: 0, shipping: 0, packages: [] as typeof filtered };
      g.count++; g.shipping += toNumber(o.shippingCharge); g.packages.push(o);
      groups.set(key, g);
    }

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key, count: g.count, shipping: g.shipping.toFixed(2),
        packages: g.packages.slice(0, 50).map((o) => formatPackage(o, args.includeItems, args.includeShippingAddress)),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      mode: 'grouped', groupBy: args.groupBy, groupCount: groups.size,
      totalPackages: filtered.length,
      dateFilter: { dateRange: args.dateRange, dateFrom: args.dateFrom ?? null, dateTo: args.dateTo ?? null },
      filters: {
        customer: args.customer ?? null, status: args.status ?? null,
        shipmentType: args.shipmentType ?? null, carrier: args.carrier ?? null,
        deliveryMethod: args.deliveryMethod ?? null, search: args.search ?? null,
      },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

function formatPackage(o: Record<string, unknown>, includeItems: boolean, includeShippingAddress: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {
    number: o.packageNumber,
    customer: o.customerName,
    status: o.status,
    date: formatDate(o.date as Date | null | undefined),
    shipmentType: o.shipmentType,
    carrier: o.carrier,
    trackingNumber: o.trackingNumber,
    deliveryMethod: o.deliveryMethod,
    shippingCharge: decimalToString(o.shippingCharge),
    shipmentDate: formatDate(o.shipmentDate as Date | null | undefined),
    shipmentStatus: o.shipmentStatus,
    salesorderNumber: o.salesorderNumber,
    quantity: decimalToString(o.quantity),
    isCarrierShipment: o.isCarrierShipment,
    isTrackingEnabled: o.isTrackingEnabled,
    salesChannel: o.salesChannel,
  };
  if (includeItems) {
    const items = (o.items as Array<Record<string, unknown>> | undefined) ?? [];
    result.items = items.map((item) => ({
      name: item.name,
      sku: item.sku,
      quantity: decimalToString(item.quantity),
      unit: item.unit,
      description: item.description,
    }));
  }
  if (includeShippingAddress) {
    const addrParts = [
      o.shippingAttention, o.shippingAddress, o.shippingCity, o.shippingState, o.shippingZip, o.shippingCountry,
    ].filter((p) => p !== null && p !== undefined && String(p).trim() !== '');
    result.shippingAddress = addrParts.length > 0 ? addrParts.join(', ') : null;
    result.shippingPhone = o.shippingPhone;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 2. getPackageDetail — Detail by number/ID with items and address   */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getPackageDetail',
  description:
    'Detalle completo de un paquete/envío por su número o ID interno, ' +
    'incluyendo items, dirección de envío, tracking y estado de envío.',
  category: 'packages',
  requiredPermission: 'packages.view',
  enabledByDefault: true,
  parameters: z.object({
    packageNumber: z.string().min(1).describe('Número del paquete (ej: PKG-001) o ID interno.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { packageNumber: string };
    const pkg = await prisma.package.findFirst({
      where: {
        OR: [
          { packageNumber: { equals: args.packageNumber, mode: 'insensitive' } },
          { id: args.packageNumber },
        ],
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!pkg) return { found: false, searchedNumber: args.packageNumber };
    return {
      found: true,
      package: {
        id: pkg.id,
        number: pkg.packageNumber,
        customer: pkg.customerName,
        status: pkg.status,
        date: formatDate(pkg.date),
        shipmentType: pkg.shipmentType,
        carrier: pkg.carrier,
        trackingNumber: pkg.trackingNumber,
        deliveryMethod: pkg.deliveryMethod,
        shippingCharge: decimalToString(pkg.shippingCharge),
        shipmentDate: formatDate(pkg.shipmentDate),
        shipmentStatus: pkg.shipmentStatus,
        salesorderNumber: pkg.salesorderNumber,
        quantity: decimalToString(pkg.quantity),
        isCarrierShipment: pkg.isCarrierShipment,
        isTrackingEnabled: pkg.isTrackingEnabled,
        labelFormat: pkg.labelFormat,
        salesChannel: pkg.salesChannel,
        // Shipping address
        shippingAttention: pkg.shippingAttention,
        shippingAddress: pkg.shippingAddress,
        shippingCity: pkg.shippingCity,
        shippingState: pkg.shippingState,
        shippingZip: pkg.shippingZip,
        shippingCountry: pkg.shippingCountry,
        shippingPhone: pkg.shippingPhone,
        // Items
        items: pkg.items.map((it) => ({
          sku: it.sku,
          name: it.name,
          description: it.description,
          quantity: decimalToString(it.quantity),
          unit: it.unit,
        })),
      },
    };
  },
});
