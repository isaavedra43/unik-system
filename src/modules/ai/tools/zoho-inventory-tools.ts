import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { formatDate } from './date-helpers';

function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String(value);
  }
  return String(value);
}

/* ------------------------------------------------------------------ */
/* 1. getOrderPackages                                                */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getOrderPackages',
  description:
    'Obtiene los paquetes (packages) de envío asociados a una orden de venta por su ID o número de orden. ' +
    'Devuelve folio, fecha, guía, método de entrega, estado y los items incluidos.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    salesOrderId: z.string().optional().describe('ID de la orden de venta en Zoho.'),
    salesOrderNumber: z.string().optional().describe('Número de orden de venta (ej. SO-0001).'),
    includeItems: z.boolean().default(false).describe('Incluir los items de cada paquete.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      salesOrderId?: string;
      salesOrderNumber?: string;
      includeItems: boolean;
    };

    const where: Record<string, unknown> = {};
    if (args.salesOrderId) where.zohoSalesOrderId = args.salesOrderId;
    if (args.salesOrderNumber) where.salesOrderNumber = args.salesOrderNumber;

    const packages = await prisma.salesOrderPackage.findMany({
      where: where as never,
      orderBy: { packageDate: 'desc' },
      take: 100,
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    return {
      total: packages.length,
      packages: packages.map((pkg) => ({
        id: pkg.id,
        zohoPackageId: pkg.zohoPackageId,
        packageNumber: pkg.packageNumber,
        salesOrderNumber: pkg.salesOrderNumber,
        packageDate: formatDate(pkg.packageDate),
        shipmentDate: formatDate(pkg.shipmentDate),
        trackingNumber: pkg.trackingNumber,
        deliveryMethod: pkg.deliveryMethod,
        status: pkg.status,
        customerName: pkg.customerName,
        totalQuantity: decimalToString(pkg.totalQuantity),
        ...(args.includeItems
          ? {
              items: pkg.items.map((item) => ({
                name: item.name,
                sku: item.sku,
                quantity: decimalToString(item.quantity),
                unit: item.unit,
                isComboProduct: item.isComboProduct,
                comboType: item.comboType,
              })),
            }
          : {}),
      })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* 2. getInvoiceDetails                                               */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getInvoiceDetails',
  description:
    'Obtiene el detalle de una factura (invoice) incluyendo items, pagos aplicados y totales. ' +
    'Busca por número de factura.',
  category: 'finance',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    invoiceNumber: z.string().min(1).describe('Número de factura (ej. INV-0001).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { invoiceNumber: string };

    const invoice = await prisma.invoice.findFirst({
      where: { invoiceNumber: args.invoiceNumber },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        payments: { orderBy: { paymentDate: 'desc' } },
      },
    });

    if (!invoice) {
      return { found: false };
    }

    return {
      found: true,
      invoice: {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        salesOrderNumber: invoice.salesOrderNumber,
        invoiceDate: formatDate(invoice.invoiceDate),
        dueDate: formatDate(invoice.dueDate),
        status: invoice.status,
        paymentStatus: invoice.paymentStatus,
        customerName: invoice.customerName,
        salespersonName: invoice.salespersonName,
        currencyCode: invoice.currencyCode,
        subtotal: decimalToString(invoice.subtotal),
        taxTotal: decimalToString(invoice.taxTotal),
        discountTotal: decimalToString(invoice.discountTotal),
        shippingCharge: decimalToString(invoice.shippingCharge),
        adjustment: decimalToString(invoice.adjustment),
        total: decimalToString(invoice.total),
        balance: decimalToString(invoice.balance),
        amountPaid: decimalToString(invoice.amountPaid),
        items: invoice.items.map((item) => ({
          name: item.name,
          sku: item.sku,
          quantity: decimalToString(item.quantity),
          unit: item.unit,
          rate: decimalToString(item.rate),
          lineTotal: decimalToString(item.lineTotal),
        })),
        payments: invoice.payments.map((payment) => ({
          paymentNumber: payment.paymentNumber,
          paymentDate: formatDate(payment.paymentDate),
          paymentMode: payment.paymentMode,
          amount: decimalToString(payment.amount),
          referenceNumber: payment.referenceNumber,
        })),
      },
    };
  },
});

/* ------------------------------------------------------------------ */
/* 3. getOrderInvoices                                                */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getOrderInvoices',
  description: 'Obtiene las facturas generadas para una orden de venta.',
  category: 'finance',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    salesOrderId: z.string().optional().describe('ID de la orden de venta en Zoho.'),
    salesOrderNumber: z.string().optional().describe('Número de orden de venta (ej. SO-0001).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { salesOrderId?: string; salesOrderNumber?: string };

    const where: Record<string, unknown> = {};
    if (args.salesOrderId) where.zohoSalesOrderId = args.salesOrderId;
    if (args.salesOrderNumber) where.salesOrderNumber = args.salesOrderNumber;

    const invoices = await prisma.invoice.findMany({
      where: where as never,
      orderBy: { invoiceDate: 'desc' },
      take: 100,
    });

    return {
      total: invoices.length,
      invoices: invoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: formatDate(invoice.invoiceDate),
        status: invoice.status,
        paymentStatus: invoice.paymentStatus,
        total: decimalToString(invoice.total),
        balance: decimalToString(invoice.balance),
        amountPaid: decimalToString(invoice.amountPaid),
      })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* 4. getOrderPayments                                                */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getOrderPayments',
  description: 'Obtiene los pagos aplicados a las facturas de una orden de venta.',
  category: 'finance',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    salesOrderId: z.string().optional().describe('ID de la orden de venta en Zoho.'),
    salesOrderNumber: z.string().optional().describe('Número de orden de venta (ej. SO-0001).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { salesOrderId?: string; salesOrderNumber?: string };

    const where: Record<string, unknown> = {};
    if (args.salesOrderId) where.zohoSalesOrderId = args.salesOrderId;
    if (args.salesOrderNumber) where.salesOrderNumber = args.salesOrderNumber;

    const invoices = await prisma.invoice.findMany({
      where: where as never,
      include: {
        payments: { orderBy: { paymentDate: 'desc' } },
      },
      take: 100,
    });

    const payments = invoices.flatMap((invoice) =>
      invoice.payments.map((payment) => ({
        invoiceNumber: invoice.invoiceNumber,
        paymentNumber: payment.paymentNumber,
        paymentDate: formatDate(payment.paymentDate),
        paymentMode: payment.paymentMode,
        amount: decimalToString(payment.amount),
        referenceNumber: payment.referenceNumber,
        customerName: payment.customerName,
      }))
    );

    return {
      total: payments.length,
      payments,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 5. getVendorList                                                   */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getVendorList',
  description: 'Lista de proveedores (vendors) registrados. Permite buscar por nombre o email.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    search: z.string().optional().describe('Búsqueda parcial por nombre, email o teléfono.'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { search?: string; limit: number };

    const where: Record<string, unknown> = {};
    if (args.search) {
      const s = args.search;
      where.OR = [
        { companyName: { contains: s, mode: 'insensitive' } },
        { email: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s, mode: 'insensitive' } },
      ];
    }

    const vendors = await prisma.vendor.findMany({
      where: where as never,
      take: args.limit,
      orderBy: { companyName: 'asc' },
    });

    return {
      total: vendors.length,
      vendors: vendors.map((v) => ({
        id: v.id,
        zohoContactId: v.zohoContactId,
        companyName: v.companyName,
        contactType: v.contactType,
        status: v.status,
        email: v.email,
        phone: v.phone,
        paymentTermsLabel: v.paymentTermsLabel,
        currencyCode: v.currencyCode,
      })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* 6. getVendorDetails                                                */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getVendorDetails',
  description: 'Detalle de un proveedor (vendor) por su ID de contacto o nombre.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    contactId: z.string().optional().describe('ID del contacto en Zoho.'),
    companyName: z.string().optional().describe('Nombre de la empresa (búsqueda parcial).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { contactId?: string; companyName?: string };

    const where: Record<string, unknown> = {};
    if (args.contactId) where.zohoContactId = args.contactId;
    if (args.companyName) where.companyName = { contains: args.companyName, mode: 'insensitive' };

    const vendor = await prisma.vendor.findFirst({
      where: where as never,
    });

    if (!vendor) return { found: false };

    return {
      found: true,
      vendor: {
        id: vendor.id,
        zohoContactId: vendor.zohoContactId,
        companyName: vendor.companyName,
        contactType: vendor.contactType,
        status: vendor.status,
        paymentTerms: vendor.paymentTerms,
        paymentTermsLabel: vendor.paymentTermsLabel,
        currencyCode: vendor.currencyCode,
        website: vendor.website,
        phone: vendor.phone,
        mobile: vendor.mobile,
        email: vendor.email,
        primaryContactId: vendor.primaryContactId,
      },
    };
  },
});

/* ------------------------------------------------------------------ */
/* 7. getProductCatalogFull                                           */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getProductCatalogFull',
  description:
    'Catálogo completo de productos. Lista productos con SKU, nombre, tipo, stock, precio y categoría. ' +
    'Permite buscar por nombre o SKU.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    search: z.string().optional().describe('Búsqueda parcial por nombre o SKU.'),
    includeComponents: z.boolean().default(false).describe('Incluir componentes de combos/ensamblados.'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { search?: string; includeComponents: boolean; limit: number };

    const where: Record<string, unknown> = {};
    if (args.search) {
      where.OR = [
        { name: { contains: args.search, mode: 'insensitive' } },
        { sku: { contains: args.search, mode: 'insensitive' } },
      ];
    }

    const products = await prisma.product.findMany({
      where: where as never,
      take: args.limit,
      orderBy: { name: 'asc' },
      include: {
        components: { orderBy: { createdAt: 'asc' } },
      },
    });

    return {
      total: products.length,
      products: products.map((p) => ({
        id: p.id,
        zohoItemId: p.zohoItemId,
        name: p.name,
        sku: p.sku,
        productType: p.productType,
        unit: p.unit,
        rate: decimalToString(p.rate),
        stockOnHand: decimalToString(p.stockOnHand),
        reorderLevel: decimalToString(p.reorderLevel),
        status: p.status,
        categoryName: p.categoryName,
        brandName: p.brandName,
        manufacturer: p.manufacturer,
        ...(args.includeComponents
          ? {
              components: p.components.map((c) => ({
                childItemId: c.childItemId,
                childName: c.childName,
                childSku: c.childSku,
                quantity: decimalToString(c.quantity),
                unit: c.unit,
              })),
            }
          : {}),
      })),
    };
  },
});

/* ------------------------------------------------------------------ */
/* 8. getProductStock                                                 */
/* ------------------------------------------------------------------ */
registerTool({
  name: 'getProductStock',
  description:
    'Stock disponible de un producto específico. Busca por SKU o nombre; devuelve cantidad en mano y punto de reorden.',
  category: 'inventory',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    skuOrName: z.string().min(1).describe('SKU o nombre del producto (búsqueda parcial).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { skuOrName: string };

    const product = await prisma.product.findFirst({
      where: {
        OR: [
          { sku: { contains: args.skuOrName, mode: 'insensitive' } },
          { name: { contains: args.skuOrName, mode: 'insensitive' } },
        ],
      } as never,
    });

    if (!product) return { found: false };

    return {
      found: true,
      product: {
        id: product.id,
        zohoItemId: product.zohoItemId,
        name: product.name,
        sku: product.sku,
        unit: product.unit,
        stockOnHand: decimalToString(product.stockOnHand),
        reorderLevel: decimalToString(product.reorderLevel),
      },
    };
  },
});
