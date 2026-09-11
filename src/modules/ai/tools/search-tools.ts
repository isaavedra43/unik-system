import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { formatDate } from './date-helpers';

/* ------------------------------------------------------------------ */
/* universalSearch — Busca en TODA la base de datos de UNIK            */
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

/**
 * Normaliza texto para búsqueda fuzzy:
 * - minúsculas
 * - sin acentos
 * - sin espacios extra
 * - sin caracteres especiales
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/[^a-z0-9\s]/g, ' ') // caracteres especiales → espacio
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Genera variaciones de búsqueda para fuzzy matching:
 * - La frase completa normalizada
 * - Cada palabra individual
 * - Prefijos de palabras (para parciales)
 */
function buildSearchTerms(query: string): { full: string; words: string[]; prefixes: string[] } {
  const normalized = normalizeText(query);
  const words = normalized.split(' ').filter((w) => w.length >= 2);
  const prefixes = words.map((w) => w.slice(0, Math.max(3, Math.floor(w.length * 0.6))));
  return { full: normalized, words, prefixes };
}

/**
 * Construye un filtro Prisma OR que busca por:
 * 1. Frase completa (contains insensible)
 * 2. Cada palabra individual
 * 3. Prefijos de palabras (parciales)
 */
function buildFuzzyFilter<T extends string>(
  fields: readonly T[],
  terms: { full: string; words: string[]; prefixes: string[] }
): Record<string, unknown>[] {
  const conditions: Record<string, unknown>[] = [];
  for (const field of fields) {
    // Frase completa
    conditions.push({ [field]: { contains: terms.full, mode: 'insensitive' } });
    // Cada palabra individual
    for (const word of terms.words) {
      conditions.push({ [field]: { contains: word, mode: 'insensitive' } });
    }
    // Prefijos (parciales)
    for (const prefix of terms.prefixes) {
      conditions.push({ [field]: { contains: prefix, mode: 'insensitive' } });
    }
  }
  return conditions;
}

registerTool({
  name: 'universalSearch',
  description:
    'BÚSQUEDA UNIVERSAL en toda la base de datos de UNIK. ' +
    'Busca simultáneamente en: órdenes de venta, productos/items, clientes, vendedores, métodos de pago, métodos de entrega, direcciones de envío, y notificaciones. ' +
    'Úsalo cuando el usuario busque algo sin saber exactamente dónde está, o cuando busque un producto sin folio, ' +
    'o cuando quiera encontrar cualquier cosa en el sistema. ' +
    'Devuelve resultados agrupados por tipo (orders, products, customers, salespeople, deliveryMethods, paymentMethods). ' +
    'EJEMPLOS: ' +
    '"busca el producto silla" → universalSearch(query="silla"). ' +
    '"busca a Juan" → universalSearch(query="Juan"). ' +
    '"busca OV-23275" → universalSearch(query="OV-23275"). ' +
    '"busca piso porcelanato" → universalSearch(query="piso porcelanato"). ' +
    '"busca transferencia" → universalSearch(query="transferencia"). ' +
    '"busca a pie de obra" → universalSearch(query="a pie de obra"). ' +
    '"busca Lomas de los Pinos" → universalSearch(query="Lomas de los Pinos"). ' +
    '"busca UPC-2308" → universalSearch(query="UPC-2308"). ' +
    '"busca Axel" → universalSearch(query="Axel").',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    query: z.string().min(1).describe(
      'Texto a buscar. Puede ser nombre de producto, SKU, número de orden, nombre de cliente, vendedor, método de pago, método de entrega, dirección, etc.'
    ),
    limit: z.number().int().min(1).max(50).default(10).describe('Máximo de resultados por categoría.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { query: string; limit: number };
    const limit = args.limit;
    const terms = buildSearchTerms(args.query);

    // Build fuzzy OR conditions for each entity type
    const orderFields = [
      'salesOrderNumber', 'referenceNumber', 'customerName', 'customerEmail',
      'customerPhone', 'salespersonName', 'paymentMethod', 'deliveryMethod',
      'locationName', 'branchName', 'status', 'subStatus', 'paidStatus',
      'shippingAttention', 'shippingAddressLine1', 'shippingAddressLine2',
      'shippingCity', 'shippingState', 'shippingPostalCode', 'notes',
    ] as const;
    const orderOrConditions = buildFuzzyFilter(orderFields, terms);

    const productFields = ['name', 'sku', 'description', 'taxName'] as const;
    const productOrConditions = buildFuzzyFilter(productFields, terms);

    const customerFields = ['customerName', 'customerEmail', 'customerPhone'] as const;
    const customerOrConditions = buildFuzzyFilter(customerFields, terms);

    const salespersonFields = ['salespersonName'] as const;
    const salespersonOrConditions = buildFuzzyFilter(salespersonFields, terms);

    const deliveryFields = ['deliveryMethod'] as const;
    const deliveryOrConditions = buildFuzzyFilter(deliveryFields, terms);

    const paymentFields = ['paymentMethod'] as const;
    const paymentOrConditions = buildFuzzyFilter(paymentFields, terms);

    // Build fuzzy conditions for new modules
    const invoiceFields = ['invoiceNumber', 'customerName', 'referenceNumber', 'cfdiUuid'] as const;
    const invoiceOrConditions = buildFuzzyFilter(invoiceFields, terms);

    const packageFields = ['packageNumber', 'customerName', 'trackingNumber', 'carrier', 'salesorderNumber'] as const;
    const packageOrConditions = buildFuzzyFilter(packageFields, terms);

    const billFields = ['billNumber', 'vendorName'] as const;
    const billOrConditions = buildFuzzyFilter(billFields, terms);

    const customerPaymentFields = ['paymentNumber', 'customerName', 'referenceNumber'] as const;
    const customerPaymentOrConditions = buildFuzzyFilter(customerPaymentFields, terms);

    const purchaseOrderFields = ['purchaseOrderNumber', 'vendorName', 'referenceNumber'] as const;
    const purchaseOrderOrConditions = buildFuzzyFilter(purchaseOrderFields, terms);

    const vendorCreditFields = ['vendorCreditNumber', 'vendorName'] as const;
    const vendorCreditOrConditions = buildFuzzyFilter(vendorCreditFields, terms);

    const productCatalogFields = ['name', 'sku', 'brand', 'manufacturer', 'categoryName', 'description'] as const;
    const productCatalogOrConditions = buildFuzzyFilter(productCatalogFields, terms);

    const contactFields = ['contactName', 'companyName', 'primaryEmail', 'primaryPhone'] as const;
    const contactOrConditions = buildFuzzyFilter(contactFields, terms);

    // Run all searches in parallel for maximum speed
    const [
      orders, products, customers, salespeople, deliveryMethods, paymentMethods,
      invoices, packages, bills, customerPayments, purchaseOrders, vendorCredits, productCatalog, contacts,
    ] = await Promise.all([
      // 1. Search in SalesOrders — ALL text fields with fuzzy matching
      prisma.salesOrder.findMany({
        where: { OR: orderOrConditions },
        select: {
          id: true,
          salesOrderNumber: true,
          customerName: true,
          customerEmail: true,
          customerPhone: true,
          salespersonName: true,
          status: true,
          subStatus: true,
          paidStatus: true,
          paymentMethod: true,
          deliveryMethod: true,
          locationName: true,
          branchName: true,
          total: true,
          balance: true,
          orderDate: true,
          shippingAddressLine1: true,
          shippingAddressLine2: true,
          shippingCity: true,
          shippingState: true,
          shippingPostalCode: true,
          notes: true,
        },
        orderBy: { orderDate: 'desc' },
        take: limit,
      }),

      // 2. Search in SalesOrderItems (products) — name, SKU, description with fuzzy
      prisma.salesOrderItem.findMany({
        where: { OR: productOrConditions },
        select: {
          name: true,
          sku: true,
          description: true,
          quantity: true,
          unit: true,
          rate: true,
          lineTotal: true,
          locationName: true,
          salesOrder: {
            select: {
              salesOrderNumber: true,
              orderDate: true,
              customerName: true,
              salespersonName: true,
              status: true,
            },
          },
        },
        orderBy: { salesOrder: { orderDate: 'desc' } },
        take: limit,
      }),

      // 3. Search distinct customers — name, email, phone with fuzzy
      prisma.salesOrder.findMany({
        where: { OR: customerOrConditions },
        select: {
          customerName: true,
          customerEmail: true,
          customerPhone: true,
          total: true,
          balance: true,
          orderDate: true,
          salespersonName: true,
          locationName: true,
        },
        orderBy: { orderDate: 'desc' },
        take: limit * 3, // Get more to aggregate
      }),

      // 4. Search distinct salespeople with fuzzy
      prisma.salesOrder.findMany({
        where: { OR: salespersonOrConditions },
        select: {
          salespersonName: true,
          total: true,
          balance: true,
          orderDate: true,
          status: true,
        },
        orderBy: { orderDate: 'desc' },
        take: limit * 3,
      }),

      // 5. Search by delivery method with fuzzy
      prisma.salesOrder.findMany({
        where: { OR: deliveryOrConditions },
        select: {
          deliveryMethod: true,
          total: true,
          balance: true,
          status: true,
          orderDate: true,
        },
        orderBy: { orderDate: 'desc' },
        take: limit * 3,
      }),

      // 6. Search by payment method with fuzzy
      prisma.salesOrder.findMany({
        where: { OR: paymentOrConditions },
        select: {
          paymentMethod: true,
          total: true,
          balance: true,
          status: true,
          orderDate: true,
        },
        orderBy: { orderDate: 'desc' },
        take: limit * 3,
      }),

      // 7. Search in Invoices
      prisma.invoice.findMany({
        where: { OR: invoiceOrConditions },
        select: {
          invoiceNumber: true,
          customerName: true,
          status: true,
          date: true,
          total: true,
          balance: true,
          currencyCode: true,
          referenceNumber: true,
          cfdiUuid: true,
        },
        orderBy: { date: 'desc' },
        take: limit,
      }),

      // 8. Search in Packages
      prisma.package.findMany({
        where: { OR: packageOrConditions },
        select: {
          packageNumber: true,
          customerName: true,
          status: true,
          date: true,
          carrier: true,
          trackingNumber: true,
          deliveryMethod: true,
          shipmentStatus: true,
          salesorderNumber: true,
        },
        orderBy: { date: 'desc' },
        take: limit,
      }),

      // 9. Search in Bills
      prisma.bill.findMany({
        where: { OR: billOrConditions },
        select: {
          billNumber: true,
          vendorName: true,
          status: true,
          date: true,
          total: true,
          balance: true,
          currencyCode: true,
        },
        orderBy: { date: 'desc' },
        take: limit,
      }),

      // 10. Search in CustomerPayments
      prisma.customerPayment.findMany({
        where: { OR: customerPaymentOrConditions },
        select: {
          paymentNumber: true,
          customerName: true,
          paymentMode: true,
          status: true,
          date: true,
          amount: true,
          currencyCode: true,
          referenceNumber: true,
        },
        orderBy: { date: 'desc' },
        take: limit,
      }),

      // 11. Search in PurchaseOrders
      prisma.purchaseOrder.findMany({
        where: { OR: purchaseOrderOrConditions },
        select: {
          purchaseOrderNumber: true,
          vendorName: true,
          status: true,
          date: true,
          total: true,
          balance: true,
          currencyCode: true,
          referenceNumber: true,
        },
        orderBy: { date: 'desc' },
        take: limit,
      }),

      // 12. Search in VendorCredits
      prisma.vendorCredit.findMany({
        where: { OR: vendorCreditOrConditions },
        select: {
          vendorCreditNumber: true,
          vendorName: true,
          status: true,
          date: true,
          total: true,
          balance: true,
          currencyCode: true,
        },
        orderBy: { date: 'desc' },
        take: limit,
      }),

      // 13. Search in Product catalog
      prisma.product.findMany({
        where: { OR: productCatalogOrConditions },
        select: {
          name: true,
          sku: true,
          status: true,
          rate: true,
          unit: true,
          stockOnHand: true,
          availableStock: true,
          categoryName: true,
          brand: true,
          manufacturer: true,
          vendorName: true,
        },
        orderBy: { name: 'asc' },
        take: limit,
      }),

      // 14. Search in Contacts
      prisma.contact.findMany({
        where: { OR: contactOrConditions },
        select: {
          contactName: true,
          companyName: true,
          contactType: true,
          status: true,
          primaryEmail: true,
          primaryPhone: true,
          outstandingReceivable: true,
          outstandingPayable: true,
        },
        orderBy: { contactName: 'asc' },
        take: limit,
      }),
    ]);

    // Group customers (distinct by name)
    const customerMap = new Map<string, {
      name: string;
      email: string | null;
      phone: string | null;
      totalSpent: number;
      balance: number;
      orderCount: number;
      lastOrder: string | null;
      salesperson: string | null;
      location: string | null;
    }>();
    for (const o of customers) {
      const name = o.customerName ?? 'Sin nombre';
      const existing = customerMap.get(name);
      if (existing) {
        existing.totalSpent += toNumber(o.total);
        existing.balance += toNumber(o.balance);
        existing.orderCount++;
        existing.lastOrder = formatDate(o.orderDate);
      } else {
        customerMap.set(name, {
          name,
          email: o.customerEmail ?? null,
          phone: o.customerPhone ?? null,
          totalSpent: toNumber(o.total),
          balance: toNumber(o.balance),
          orderCount: 1,
          lastOrder: formatDate(o.orderDate),
          salesperson: o.salespersonName,
          location: o.locationName,
        });
      }
    }

    // Group salespeople (distinct by name)
    const salespersonMap = new Map<string, {
      name: string;
      totalSold: number;
      balance: number;
      orderCount: number;
      closedCount: number;
      confirmedCount: number;
      lastOrder: string | null;
    }>();
    for (const o of salespeople) {
      const name = o.salespersonName ?? 'Sin vendedor';
      const existing = salespersonMap.get(name);
      if (existing) {
        existing.totalSold += toNumber(o.total);
        existing.balance += toNumber(o.balance);
        existing.orderCount++;
        if (o.status === 'closed') existing.closedCount++;
        if (o.status === 'confirmed') existing.confirmedCount++;
        existing.lastOrder = formatDate(o.orderDate);
      } else {
        salespersonMap.set(name, {
          name,
          totalSold: toNumber(o.total),
          balance: toNumber(o.balance),
          orderCount: 1,
          closedCount: o.status === 'closed' ? 1 : 0,
          confirmedCount: o.status === 'confirmed' ? 1 : 0,
          lastOrder: formatDate(o.orderDate),
        });
      }
    }

    // Group delivery methods
    const deliveryMap = new Map<string, {
      method: string;
      count: number;
      total: number;
      balance: number;
    }>();
    for (const o of deliveryMethods) {
      const method = o.deliveryMethod ?? 'Sin método';
      const existing = deliveryMap.get(method);
      if (existing) {
        existing.count++;
        existing.total += toNumber(o.total);
        existing.balance += toNumber(o.balance);
      } else {
        deliveryMap.set(method, {
          method,
          count: 1,
          total: toNumber(o.total),
          balance: toNumber(o.balance),
        });
      }
    }

    // Group payment methods
    const paymentMap = new Map<string, {
      method: string;
      count: number;
      total: number;
      balance: number;
    }>();
    for (const o of paymentMethods) {
      const method = o.paymentMethod ?? 'Sin método';
      const existing = paymentMap.get(method);
      if (existing) {
        existing.count++;
        existing.total += toNumber(o.total);
        existing.balance += toNumber(o.balance);
      } else {
        paymentMap.set(method, {
          method,
          count: 1,
          total: toNumber(o.total),
          balance: toNumber(o.balance),
        });
      }
    }

    const totalResults = orders.length + products.length + customerMap.size + salespersonMap.size + deliveryMap.size + paymentMap.size
      + invoices.length + packages.length + bills.length + customerPayments.length + purchaseOrders.length + vendorCredits.length + productCatalog.length + contacts.length;

    return {
      query: args.query,
      totalResults,
      orders: orders.map((o) => ({
        type: 'order',
        number: o.salesOrderNumber,
        customer: o.customerName,
        email: o.customerEmail,
        phone: o.customerPhone,
        salesperson: o.salespersonName,
        status: o.status,
        subStatus: o.subStatus,
        paidStatus: o.paidStatus,
        paymentMethod: o.paymentMethod,
        deliveryMethod: o.deliveryMethod,
        location: o.locationName,
        branch: o.branchName,
        total: decimalToString(o.total),
        balance: decimalToString(o.balance),
        date: formatDate(o.orderDate),
        shippingAddress: [
          o.shippingAddressLine1,
          o.shippingAddressLine2,
          o.shippingCity,
          o.shippingState,
          o.shippingPostalCode,
        ].filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(', ') || null,
        notes: o.notes,
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
        location: p.locationName,
        orderNumber: p.salesOrder.salesOrderNumber,
        orderDate: formatDate(p.salesOrder.orderDate),
        customer: p.salesOrder.customerName,
        salesperson: p.salesOrder.salespersonName,
        orderStatus: p.salesOrder.status,
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
          salesperson: c.salesperson,
          location: c.location,
        })),
      salespeople: [...salespersonMap.values()]
        .sort((a, b) => b.totalSold - a.totalSold)
        .slice(0, limit)
        .map((s) => ({
          type: 'salesperson',
          name: s.name,
          totalSold: s.totalSold.toFixed(2),
          balance: s.balance.toFixed(2),
          orderCount: s.orderCount,
          closedCount: s.closedCount,
          confirmedCount: s.confirmedCount,
          lastOrder: s.lastOrder,
        })),
      deliveryMethods: [...deliveryMap.values()]
        .sort((a, b) => b.total - a.total)
        .slice(0, limit)
        .map((d) => ({
          type: 'deliveryMethod',
          method: d.method,
          count: d.count,
          total: d.total.toFixed(2),
          balance: d.balance.toFixed(2),
        })),
      paymentMethods: [...paymentMap.values()]
        .sort((a, b) => b.total - a.total)
        .slice(0, limit)
        .map((p) => ({
          type: 'paymentMethod',
          method: p.method,
          count: p.count,
          total: p.total.toFixed(2),
          balance: p.balance.toFixed(2),
        })),
      invoices: invoices.map((inv) => ({
        type: 'invoice',
        number: inv.invoiceNumber,
        customer: inv.customerName,
        status: inv.status,
        date: formatDate(inv.date),
        total: decimalToString(inv.total),
        balance: decimalToString(inv.balance),
        currency: inv.currencyCode,
        referenceNumber: inv.referenceNumber,
        cfdiUuid: inv.cfdiUuid,
      })),
      packages: packages.map((pkg) => ({
        type: 'package',
        number: pkg.packageNumber,
        customer: pkg.customerName,
        status: pkg.status,
        date: formatDate(pkg.date),
        carrier: pkg.carrier,
        trackingNumber: pkg.trackingNumber,
        deliveryMethod: pkg.deliveryMethod,
        shipmentStatus: pkg.shipmentStatus,
        salesorderNumber: pkg.salesorderNumber,
      })),
      bills: bills.map((b) => ({
        type: 'bill',
        number: b.billNumber,
        vendor: b.vendorName,
        status: b.status,
        date: formatDate(b.date),
        total: decimalToString(b.total),
        balance: decimalToString(b.balance),
        currency: b.currencyCode,
      })),
      customerPayments: customerPayments.map((p) => ({
        type: 'customerPayment',
        number: p.paymentNumber,
        customer: p.customerName,
        paymentMode: p.paymentMode,
        status: p.status,
        date: formatDate(p.date),
        amount: decimalToString(p.amount),
        currency: p.currencyCode,
        referenceNumber: p.referenceNumber,
      })),
      purchaseOrders: purchaseOrders.map((po) => ({
        type: 'purchaseOrder',
        number: po.purchaseOrderNumber,
        vendor: po.vendorName,
        status: po.status,
        date: formatDate(po.date),
        total: decimalToString(po.total),
        balance: decimalToString(po.balance),
        currency: po.currencyCode,
        referenceNumber: po.referenceNumber,
      })),
      vendorCredits: vendorCredits.map((vc) => ({
        type: 'vendorCredit',
        number: vc.vendorCreditNumber,
        vendor: vc.vendorName,
        status: vc.status,
        date: formatDate(vc.date),
        total: decimalToString(vc.total),
        balance: decimalToString(vc.balance),
        currency: vc.currencyCode,
      })),
      productCatalog: productCatalog.map((p) => ({
        type: 'productCatalog',
        name: p.name,
        sku: p.sku,
        status: p.status,
        rate: decimalToString(p.rate),
        unit: p.unit,
        stockOnHand: decimalToString(p.stockOnHand),
        availableStock: decimalToString(p.availableStock),
        category: p.categoryName,
        brand: p.brand,
        manufacturer: p.manufacturer,
        vendor: p.vendorName,
      })),
      contacts: contacts.map((c) => ({
        type: 'contact',
        name: c.contactName,
        company: c.companyName,
        contactType: c.contactType,
        status: c.status,
        email: c.primaryEmail,
        phone: c.primaryPhone,
        outstandingReceivable: decimalToString(c.outstandingReceivable),
        outstandingPayable: decimalToString(c.outstandingPayable),
      })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* getDatabaseOverview — Resumen de TODA la base de datos             */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getDatabaseOverview',
  description:
    'Resumen completo de toda la base de datos de UNIK. ' +
    'Devuelve conteos totales, rangos de fechas, listas de valores únicos, y estadísticas generales. ' +
    'Úsalo cuando el usuario pregunte "qué información tienes", "qué datos hay", "dame un panorama", ' +
    'o cuando necesites entender qué datos existen antes de hacer una consulta específica. ' +
    'También úsalo al inicio de una conversación para entender el contexto de los datos disponibles.',
  category: 'sales',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({}),
  execute: async () => {
    // Run all counts in parallel
    const [
      totalOrders,
      totalItems,
      totalCustomers,
      totalSalespeople,
      totalLocations,
      totalProducts,
      dateRange,
      statusCounts,
      subStatusCounts,
      paidStatusCounts,
      invoicedStatusCounts,
      shippedStatusCounts,
      paymentMethodCounts,
      deliveryMethodCounts,
      recentOrders,
      // New modules
      totalInvoices,
      invoiceStatusCounts,
      invoiceDateRange,
      totalPackages,
      packageStatusCounts,
      packageDateRange,
      totalBills,
      billStatusCounts,
      billDateRange,
      totalCustomerPayments,
      paymentStatusCounts,
      paymentModeCounts,
      paymentDateRange,
      totalPurchaseOrders,
      purchaseOrderStatusCounts,
      purchaseOrderDateRange,
      totalVendorCredits,
      vendorCreditStatusCounts,
      vendorCreditDateRange,
      totalProductCatalog,
      productStatusCounts,
      productCategoryCounts,
      totalContacts,
      contactTypeCounts,
      contactStatusCounts,
    ] = await Promise.all([
      prisma.salesOrder.count(),
      prisma.salesOrderItem.count(),
      prisma.salesOrder.groupBy({
        by: ['customerName'],
        _count: { id: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['salespersonName'],
        _count: { id: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['locationName'],
        _count: { id: true },
      }),
      prisma.salesOrderItem.groupBy({
        by: ['sku'],
        _count: { id: true },
      }),
      prisma.salesOrder.aggregate({
        _min: { orderDate: true },
        _max: { orderDate: true },
        _sum: { total: true, balance: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['status'],
        _count: { id: true },
        _sum: { total: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['subStatus'],
        _count: { id: true },
        _sum: { total: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['paidStatus'],
        _count: { id: true },
        _sum: { total: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['invoicedStatus'],
        _count: { id: true },
        _sum: { total: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['shippedStatus'],
        _count: { id: true },
        _sum: { total: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['paymentMethod'],
        _count: { id: true },
        _sum: { total: true },
      }),
      prisma.salesOrder.groupBy({
        by: ['deliveryMethod'],
        _count: { id: true },
        _sum: { total: true },
      }),
      prisma.salesOrder.findMany({
        orderBy: { orderDate: 'desc' },
        take: 5,
        select: {
          salesOrderNumber: true,
          customerName: true,
          total: true,
          orderDate: true,
          status: true,
          subStatus: true,
          paidStatus: true,
          shippedStatus: true,
        },
      }),
      // New modules
      prisma.invoice.count(),
      prisma.invoice.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.invoice.aggregate({ _min: { date: true }, _max: { date: true } }),
      prisma.package.count(),
      prisma.package.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.package.aggregate({ _min: { date: true }, _max: { date: true } }),
      prisma.bill.count(),
      prisma.bill.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.bill.aggregate({ _min: { date: true }, _max: { date: true } }),
      prisma.customerPayment.count(),
      prisma.customerPayment.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.customerPayment.groupBy({ by: ['paymentMode'], _count: { id: true } }),
      prisma.customerPayment.aggregate({ _min: { date: true }, _max: { date: true } }),
      prisma.purchaseOrder.count(),
      prisma.purchaseOrder.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.purchaseOrder.aggregate({ _min: { date: true }, _max: { date: true } }),
      prisma.vendorCredit.count(),
      prisma.vendorCredit.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.vendorCredit.aggregate({ _min: { date: true }, _max: { date: true } }),
      prisma.product.count(),
      prisma.product.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.product.groupBy({ by: ['categoryName'], _count: { id: true } }),
      prisma.contact.count(),
      prisma.contact.groupBy({ by: ['contactType'], _count: { id: true } }),
      prisma.contact.groupBy({ by: ['status'], _count: { id: true } }),
    ]);

    return {
      summary: {
        totalOrders,
        totalItems,
        totalCustomers: totalCustomers.length,
        totalSalespeople: totalSalespeople.length,
        totalLocations: totalLocations.length,
        totalProducts: totalProducts.length,
        totalRevenue: decimalToString(dateRange._sum.total),
        totalBalance: decimalToString(dateRange._sum.balance),
        oldestOrder: formatDate(dateRange._min.orderDate),
        newestOrder: formatDate(dateRange._max.orderDate),
        // New modules summary
        totalInvoices,
        totalPackages,
        totalBills,
        totalCustomerPayments,
        totalPurchaseOrders,
        totalVendorCredits,
        totalProductCatalog,
        totalContacts,
        invoiceDateRange: { oldest: formatDate(invoiceDateRange._min.date), newest: formatDate(invoiceDateRange._max.date) },
        packageDateRange: { oldest: formatDate(packageDateRange._min.date), newest: formatDate(packageDateRange._max.date) },
        billDateRange: { oldest: formatDate(billDateRange._min.date), newest: formatDate(billDateRange._max.date) },
        paymentDateRange: { oldest: formatDate(paymentDateRange._min.date), newest: formatDate(paymentDateRange._max.date) },
        purchaseOrderDateRange: { oldest: formatDate(purchaseOrderDateRange._min.date), newest: formatDate(purchaseOrderDateRange._max.date) },
        vendorCreditDateRange: { oldest: formatDate(vendorCreditDateRange._min.date), newest: formatDate(vendorCreditDateRange._max.date) },
      },
      customers: totalCustomers
        .map((c) => ({ name: c.customerName ?? 'Sin nombre', orders: c._count.id }))
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 20),
      salespeople: totalSalespeople
        .map((s) => ({ name: s.salespersonName ?? 'Sin vendedor', orders: s._count.id }))
        .sort((a, b) => b.orders - a.orders),
      locations: totalLocations
        .map((l) => ({ name: l.locationName ?? 'Sin sucursal', orders: l._count.id }))
        .sort((a, b) => b.orders - a.orders),
      statuses: statusCounts
        .map((s) => ({
          status: s.status ?? 'Sin estado',
          count: s._count.id,
          total: decimalToString(s._sum.total),
        }))
        .sort((a, b) => b.count - a.count),
      subStatuses: subStatusCounts
        .map((s) => ({
          subStatus: s.subStatus ?? 'Sin sub-estado',
          count: s._count.id,
          total: decimalToString(s._sum.total),
        }))
        .sort((a, b) => b.count - a.count),
      paidStatuses: paidStatusCounts
        .map((p) => ({
          paidStatus: p.paidStatus ?? 'Sin estado de pago',
          count: p._count.id,
          total: decimalToString(p._sum.total),
        }))
        .sort((a, b) => b.count - a.count),
      invoicedStatuses: invoicedStatusCounts
        .map((i) => ({
          invoicedStatus: i.invoicedStatus ?? 'Sin estado de facturación',
          count: i._count.id,
          total: decimalToString(i._sum.total),
        }))
        .sort((a, b) => b.count - a.count),
      shippedStatuses: shippedStatusCounts
        .map((s) => ({
          shippedStatus: s.shippedStatus ?? 'Sin estado de envío',
          count: s._count.id,
          total: decimalToString(s._sum.total),
        }))
        .sort((a, b) => b.count - a.count),
      paymentMethods: paymentMethodCounts
        .map((p) => ({
          method: p.paymentMethod ?? 'Sin método',
          count: p._count.id,
          total: decimalToString(p._sum.total),
        }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
      deliveryMethods: deliveryMethodCounts
        .map((d) => ({
          method: d.deliveryMethod ?? 'Sin método',
          count: d._count.id,
          total: decimalToString(d._sum.total),
        }))
        .sort((a, b) => Number(b.total) - Number(a.total)),
      recentOrders: recentOrders.map((o) => ({
        number: o.salesOrderNumber,
        customer: o.customerName,
        total: decimalToString(o.total),
        date: formatDate(o.orderDate),
        status: o.status,
        subStatus: o.subStatus,
        paidStatus: o.paidStatus,
        shippedStatus: o.shippedStatus,
      })),
      // New modules
      invoiceStatuses: invoiceStatusCounts
        .map((s) => ({ status: s.status ?? 'Sin estado', count: s._count.id }))
        .sort((a, b) => b.count - a.count),
      packageStatuses: packageStatusCounts
        .map((s) => ({ status: s.status ?? 'Sin estado', count: s._count.id }))
        .sort((a, b) => b.count - a.count),
      billStatuses: billStatusCounts
        .map((s) => ({ status: s.status ?? 'Sin estado', count: s._count.id }))
        .sort((a, b) => b.count - a.count),
      paymentStatuses: paymentStatusCounts
        .map((s) => ({ status: s.status ?? 'Sin estado', count: s._count.id }))
        .sort((a, b) => b.count - a.count),
      paymentModes: paymentModeCounts
        .map((p) => ({ mode: p.paymentMode ?? 'Sin modo', count: p._count.id }))
        .sort((a, b) => b.count - a.count),
      purchaseOrderStatuses: purchaseOrderStatusCounts
        .map((s) => ({ status: s.status ?? 'Sin estado', count: s._count.id }))
        .sort((a, b) => b.count - a.count),
      vendorCreditStatuses: vendorCreditStatusCounts
        .map((s) => ({ status: s.status ?? 'Sin estado', count: s._count.id }))
        .sort((a, b) => b.count - a.count),
      productStatuses: productStatusCounts
        .map((s) => ({ status: s.status ?? 'Sin estado', count: s._count.id }))
        .sort((a, b) => b.count - a.count),
      productCategories: productCategoryCounts
        .map((c) => ({ category: c.categoryName ?? 'Sin categoría', count: c._count.id }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
      contactTypes: contactTypeCounts
        .map((c) => ({ type: c.contactType ?? 'Sin tipo', count: c._count.id }))
        .sort((a, b) => b.count - a.count),
      contactStatuses: contactStatusCounts
        .map((s) => ({ status: s.status ?? 'Sin estado', count: s._count.id }))
        .sort((a, b) => b.count - a.count),
    };
  },
});
