import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';

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
/* 1. queryProducts — Universal product catalog query tool            */
/* ------------------------------------------------------------------ */

const PRODUCT_GROUP_BY = ['none', 'category', 'vendor', 'brand', 'status', 'productType'] as const;

registerTool({
  name: 'queryProducts',
  description:
    'TOOL UNIVERSAL del catálogo de productos (tabla Product). Úsalo para CUALQUIER consulta del catálogo real de productos. ' +
    'Soporta filtrar por búsqueda (nombre/SKU), estado (status), tipo (productType), categoría (category), ' +
    'proveedor (vendor), marca (brand), fabricante (manufacturer) y stock bajo (lowStock). ' +
    'Puede agrupar por categoría, proveedor, marca, estado o tipo. ' +
    'Incluye campos de stock (stockOnHand, availableStock, reorderLevel), SAT (satProductCode, satUnitCode), marca y fabricante. ' +
    'EJEMPLOS: ' +
    '"catálogo de productos" → queryProducts(). ' +
    '"busca cemento" → queryProducts(search="cemento"). ' +
    '"stock de silla" → queryProducts(search="silla"). ' +
    '"productos con stock bajo" → queryProducts(lowStock=true). ' +
    '"productos por categoría" → queryProducts(groupBy="category"). ' +
    '"productos del proveedor X" → queryProducts(vendor="X"). ' +
    '"productos de la marca Y" → queryProducts(brand="Y").',
  category: 'products',
  requiredPermission: 'products.view',
  enabledByDefault: true,
  parameters: z.object({
    search: z.string().optional().describe(
      'Búsqueda parcial por nombre o SKU del producto.'
    ),
    status: z.string().optional().describe(
      'Filtrar por estado (búsqueda parcial). Valores típicos: "active", "inactive".'
    ),
    productType: z.string().optional().describe('Filtrar por tipo de producto (búsqueda parcial). Ej: "goods", "service".'),
    category: z.string().optional().describe('Filtrar por categoría (búsqueda parcial).'),
    vendor: z.string().optional().describe('Filtrar por proveedor (búsqueda parcial).'),
    brand: z.string().optional().describe('Filtrar por marca (búsqueda parcial).'),
    manufacturer: z.string().optional().describe('Filtrar por fabricante (búsqueda parcial).'),
    lowStock: z.boolean().optional().describe(
      'true = solo productos con stock disponible <= reorderLevel (stock bajo). ' +
      'Úsalo para "productos con stock bajo", "qué necesito reabastecer".'
    ),
    groupBy: z.enum(PRODUCT_GROUP_BY).default('none').describe(
      'Agrupar resultados. "none" = lista individual. "category" = por categoría. "vendor" = por proveedor. "brand" = por marca. "status" = por estado. "productType" = por tipo.'
    ),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      search?: string; status?: string; productType?: string; category?: string;
      vendor?: string; brand?: string; manufacturer?: string; lowStock?: boolean;
      groupBy: (typeof PRODUCT_GROUP_BY)[number]; page: number; pageSize: number;
    };

    // Build where clause
    const where: Record<string, unknown> = {};

    if (args.search) {
      where.OR = [
        { name: { contains: args.search, mode: 'insensitive' } },
        { sku: { contains: args.search, mode: 'insensitive' } },
      ];
    }
    if (args.status) {
      where.status = { contains: args.status, mode: 'insensitive' };
    }
    if (args.productType) {
      where.productType = { contains: args.productType, mode: 'insensitive' };
    }
    if (args.category) {
      where.categoryName = { contains: args.category, mode: 'insensitive' };
    }
    if (args.vendor) {
      where.vendorName = { contains: args.vendor, mode: 'insensitive' };
    }
    if (args.brand) {
      where.brand = { contains: args.brand, mode: 'insensitive' };
    }
    if (args.manufacturer) {
      where.manufacturer = { contains: args.manufacturer, mode: 'insensitive' };
    }

    const products = await prisma.product.findMany({
      where: where as never,
      select: {
        id: true,
        name: true,
        sku: true,
        status: true,
        productType: true,
        rate: true,
        unit: true,
        currencyCode: true,
        stockOnHand: true,
        availableStock: true,
        reorderLevel: true,
        purchaseRate: true,
        categoryName: true,
        manufacturer: true,
        brand: true,
        vendorName: true,
        satProductCode: true,
        satUnitCode: true,
        description: true,
        taxName: true,
        taxPercentage: true,
        isTaxable: true,
      },
      orderBy: { name: 'asc' },
      take: 1000,
    });

    // Apply lowStock filter in JavaScript
    let filtered = products;
    if (args.lowStock) {
      filtered = filtered.filter((p) => {
        const available = toNumber(p.availableStock);
        const reorder = toNumber(p.reorderLevel);
        return available <= reorder;
      });
    }

    // Auto-diagnóstico
    const usedFilter = !!(args.status || args.productType || args.category || args.vendor || args.brand || args.manufacturer);
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && usedFilter) {
      const uniqueStatuses = new Map<string, number>();
      const uniqueCategories = new Map<string, number>();
      const uniqueBrands = new Map<string, number>();
      const uniqueVendors = new Map<string, number>();
      for (const p of products) {
        if (p.status) uniqueStatuses.set(p.status, (uniqueStatuses.get(p.status) ?? 0) + 1);
        if (p.categoryName) uniqueCategories.set(p.categoryName, (uniqueCategories.get(p.categoryName) ?? 0) + 1);
        if (p.brand) uniqueBrands.set(p.brand, (uniqueBrands.get(p.brand) ?? 0) + 1);
        if (p.vendorName) uniqueVendors.set(p.vendorName, (uniqueVendors.get(p.vendorName) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta devolvió 0 resultados. Valores disponibles:',
        totalProducts: products.length,
        availableStatuses: [...uniqueStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableCategories: [...uniqueCategories.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableBrands: [...uniqueBrands.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableVendors: [...uniqueVendors.entries()].map(([v, c]) => ({ value: v, count: c })),
        hint: 'Reintenta con un valor que SÍ exista.',
      };
    }

    if (args.groupBy === 'none') {
      const total = filtered.length;
      const totalPages = Math.ceil(total / args.pageSize);
      const paginated = filtered.slice((args.page - 1) * args.pageSize, args.page * args.pageSize);

      return {
        mode: 'list',
        total, page: args.page, pageSize: args.pageSize, totalPages,
        filters: {
          search: args.search ?? null, status: args.status ?? null,
          productType: args.productType ?? null, category: args.category ?? null,
          vendor: args.vendor ?? null, brand: args.brand ?? null,
          manufacturer: args.manufacturer ?? null, lowStock: args.lowStock ?? null,
        },
        ...(diagnostic ? { diagnostic } : {}),
        products: paginated.map((p) => ({
          name: p.name,
          sku: p.sku,
          status: p.status,
          productType: p.productType,
          rate: decimalToString(p.rate),
          unit: p.unit,
          currency: p.currencyCode,
          stockOnHand: decimalToString(p.stockOnHand),
          availableStock: decimalToString(p.availableStock),
          reorderLevel: decimalToString(p.reorderLevel),
          purchaseRate: decimalToString(p.purchaseRate),
          category: p.categoryName,
          manufacturer: p.manufacturer,
          brand: p.brand,
          vendor: p.vendorName,
          satProductCode: p.satProductCode,
          satUnitCode: p.satUnitCode,
          description: p.description,
        })),
      };
    }

    // Group by
    const groups = new Map<string, { count: number; products: typeof filtered; stockValue: number }>();
    for (const p of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'category') key = p.categoryName ?? 'SIN CATEGORÍA';
      else if (args.groupBy === 'vendor') key = p.vendorName ?? 'SIN PROVEEDOR';
      else if (args.groupBy === 'brand') key = p.brand ?? 'SIN MARCA';
      else if (args.groupBy === 'status') key = p.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'productType') key = p.productType ?? 'SIN TIPO';
      const g = groups.get(key) ?? { count: 0, products: [] as typeof filtered, stockValue: 0 };
      g.count++;
      g.stockValue += toNumber(p.availableStock) * toNumber(p.rate);
      g.products.push(p);
      groups.set(key, g);
    }

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key, count: g.count, stockValue: g.stockValue.toFixed(2),
        products: g.products.slice(0, 50).map((p) => ({
          name: p.name, sku: p.sku,
          stockOnHand: decimalToString(p.stockOnHand),
          availableStock: decimalToString(p.availableStock),
          rate: decimalToString(p.rate),
        })),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      mode: 'grouped', groupBy: args.groupBy, groupCount: groups.size,
      totalProducts: filtered.length,
      filters: {
        search: args.search ?? null, status: args.status ?? null,
        productType: args.productType ?? null, category: args.category ?? null,
        vendor: args.vendor ?? null, brand: args.brand ?? null,
        manufacturer: args.manufacturer ?? null, lowStock: args.lowStock ?? null,
      },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

/* ------------------------------------------------------------------ */
/* 2. getProductDetail — Detail by SKU/ID with all fields             */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getProductDetail',
  description:
    'Detalle completo de un producto del catálogo por su SKU, nombre o ID interno. ' +
    'Incluye todos los campos: stock, precio, categoría, marca, fabricante, proveedor, campos SAT, impuestos.',
  category: 'products',
  requiredPermission: 'products.view',
  enabledByDefault: true,
  parameters: z.object({
    skuOrName: z.string().min(1).describe('SKU, nombre del producto o ID interno (búsqueda parcial).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { skuOrName: string };
    const product = await prisma.product.findFirst({
      where: {
        OR: [
          { sku: { equals: args.skuOrName, mode: 'insensitive' } },
          { name: { contains: args.skuOrName, mode: 'insensitive' } },
          { sku: { contains: args.skuOrName, mode: 'insensitive' } },
          { id: args.skuOrName },
        ],
      },
    });
    if (!product) return { found: false, searched: args.skuOrName };
    return {
      found: true,
      product: {
        id: product.id,
        name: product.name,
        sku: product.sku,
        status: product.status,
        productType: product.productType,
        description: product.description,
        rate: decimalToString(product.rate),
        unit: product.unit,
        currency: product.currencyCode,
        purchaseRate: decimalToString(product.purchaseRate),
        stockOnHand: decimalToString(product.stockOnHand),
        availableStock: decimalToString(product.availableStock),
        reorderLevel: decimalToString(product.reorderLevel),
        category: product.categoryName,
        categoryId: product.categoryId,
        manufacturer: product.manufacturer,
        brand: product.brand,
        vendor: product.vendorName,
        // SAT fields
        satProductCode: product.satProductCode,
        satUnitCode: product.satUnitCode,
        // Tax fields
        taxName: product.taxName,
        taxPercentage: decimalToString(product.taxPercentage),
        isTaxable: product.isTaxable,
        taxPreference: product.taxPreference,
        purchaseTaxName: product.purchaseTaxName,
        // Additional
        itemType: product.itemType,
        source: product.source,
        zohoCreatedTime: product.zohoCreatedTime?.toISOString() ?? null,
        zohoLastModifiedTime: product.zohoLastModifiedTime?.toISOString() ?? null,
      },
    };
  },
});
