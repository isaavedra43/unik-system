import { z } from 'zod';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { registerTool } from './registry';
import { createArtifact } from '../ai-artifacts-service';
import { saveGeneratedFile } from '@/modules/storage/storage-service';
import {
  aiQueryQuotes,
  aiGetQuote,
  aiSearchCustomers,
  aiSearchProducts,
  aiPreviewQuote,
  aiCreateQuote,
  aiUpdateQuote,
  aiGetQuotePdf,
} from '@/modules/quotes/quotes-ai-adapter';
import { DISCOUNT_MODES, type QuoteLineInput } from '@/modules/quotes/quotes-form-schema';
import { QuoteWriteError } from '@/modules/quotes/quotes-write-service';
import { ZodError } from 'zod';
import { getZohoConfig } from '@/modules/integrations/zoho/config';
import { listEstimates } from '@/modules/integrations/zoho/estimates';
import { QUOTE_SEGMENTS } from '@/modules/quotes/quotes-filters';
import { getQuoteStatusLabel } from '@/modules/quotes/quotes-helpers';
import { prisma } from '@/lib/prisma';
import { getCustomerForQuote } from '@/modules/quotes/quotes-service';
import { absoluteUrl } from '@/lib/app-url';
import { previewText } from '@/modules/comms/normalize';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import { changeQuoteStatus } from '@/modules/quotes/quotes-write-service';
import { deliverToContact } from './messaging-tools';
import { resolveContact } from '@/modules/comms/contact-resolver';

/**
 * Cotizaciones (Zoho Books estimates). Every write goes through
 * quotes-write-service (idempotency, optimistic lock, Zoho as source of truth)
 * and — being business_write — through the approval card first.
 */

/**
 * Lenient line schema for the model: aliases (productId/price/qty…) are accepted
 * and every line is normalized + enriched from the catalog before Zoho sees it
 * (missing itemId → search by name; rate 0/missing → list price).
 */
const rawQuoteItemSchema = z.object({
  lineItemId: z.string().optional().nullable().describe('SOLO al editar (updateQuote): id de la línea existente en Zoho. Al crear NO lo uses.'),
  line_item_id: z.string().optional().nullable().describe('Alias de lineItemId'),
  itemId: z.string().optional().nullable().describe('zohoItemId del producto (de searchQuoteProducts). Si lo omites se busca por name.'),
  item_id: z.string().optional().nullable().describe('Alias de itemId'),
  productId: z.string().optional().describe('Alias de itemId'),
  zohoItemId: z.string().optional().describe('Alias de itemId'),
  sku: z.string().optional().describe('SKU del producto (se busca en el catálogo)'),
  name: z.string().optional().describe('Nombre del producto o concepto (obligatorio si no hay itemId)'),
  product: z.string().optional().describe('Alias de name'),
  productName: z.string().optional().describe('Alias de name'),
  description: z.string().optional().nullable(),
  quantity: z.number().optional().describe('Cantidad (> 0)'),
  qty: z.number().optional().describe('Alias de quantity'),
  cantidad: z.number().optional().describe('Alias de quantity'),
  rate: z.number().optional().describe('Precio unitario. Si lo omites o es 0 se usa el precio de lista del catálogo'),
  price: z.number().optional().describe('Alias de rate'),
  unitPrice: z.number().optional().describe('Alias de rate'),
  precio: z.number().optional().describe('Alias de rate'),
  unit: z.string().optional().nullable(),
  discountPercent: z.number().optional().nullable(),
  taxId: z.string().optional().nullable(),
});
type RawQuoteItem = z.infer<typeof rawQuoteItemSchema>;

/**
 * Pure alias mapping: what the model typed → the strict form line.
 * On create, a `lineItemId` can only be a confusion with the product id
 * (Zoho rejects "line_item_id no válido"): it is dropped and reused as itemId
 * candidate when no other id was given.
 */
export function normalizeQuoteItems(items: RawQuoteItem[], options: { forUpdate?: boolean } = {}): QuoteLineInput[] {
  return items.map((raw) => {
    const lineRef = raw.lineItemId ?? raw.line_item_id ?? null;
    let itemId = raw.itemId ?? raw.item_id ?? raw.productId ?? raw.zohoItemId ?? null;
    if (!itemId && !options.forUpdate && lineRef) itemId = lineRef;
    const name = (raw.name ?? raw.product ?? raw.productName ?? '').trim();
    const description = raw.description?.trim() ?? null;
    const quantity = raw.quantity ?? raw.qty ?? raw.cantidad ?? 1;
    const rate = raw.rate ?? raw.price ?? raw.unitPrice ?? raw.precio ?? 0;
    return {
      lineItemId: options.forUpdate ? (lineRef ?? null) : null,
      itemId: itemId ? String(itemId).trim() : null,
      name: name || (raw.sku ? raw.sku.trim() : '') || (description && description.length <= 120 ? description : '') || 'Concepto',
      description,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      rate: Number.isFinite(rate) && rate >= 0 ? rate : 0,
      unit: raw.unit ?? null,
      discountPercent: raw.discountPercent ?? null,
      taxId: raw.taxId ?? null,
    };
  });
}

/** Fills itemId / name / list price / unit from the synced catalog. */
async function enrichQuoteItems(items: QuoteLineInput[]): Promise<{ items: QuoteLineInput[]; notes: string[] }> {
  const notes: string[] = [];
  const out: QuoteLineInput[] = [];
  for (const item of items) {
    let itemId = item.itemId ?? null;
    let name = item.name === 'Concepto' ? '' : item.name;
    let rate = item.rate;
    let unit = item.unit ?? null;
    let product: { zohoItemId: string; name: string | null; rate: string | null; unit: string | null } | null = null;
    if (itemId) {
      const row = await prisma.product.findUnique({ where: { zohoItemId: itemId }, select: { zohoItemId: true, name: true, rate: true, unit: true } });
      if (row) product = { ...row, rate: row.rate ? String(row.rate) : null };
      else {
        // Not a Zoho item id: maybe a line id or a SKU typed in the wrong field.
        const bySku = await prisma.product.findFirst({ where: { sku: { equals: itemId, mode: 'insensitive' } }, select: { zohoItemId: true, name: true, rate: true, unit: true } });
        if (bySku) product = { ...bySku, rate: bySku.rate ? String(bySku.rate) : null };
        else notes.push(`itemId ${itemId} no existe en el catálogo sincronizado; se busca por nombre`);
      }
    }
    if (!product && name) {
      const found = await findCatalogProducts(name, 5);
      const q = name.toLowerCase();
      const exact = found.find((p) => (p.name ?? '').toLowerCase() === q || (p.sku ?? '').toLowerCase() === q);
      const best = exact ?? found[0] ?? null;
      if (best) {
        product = { zohoItemId: best.zohoItemId, name: best.name, rate: best.rate, unit: best.unit };
        if (!exact) notes.push(`"${name}" se interpretó como "${best.name}"`);
      }
    }
    if (product) {
      itemId = product.zohoItemId;
      if (!name) name = product.name ?? name;
      if (!rate || rate <= 0) {
        const listPrice = Number(product.rate ?? 0);
        if (listPrice > 0) {
          rate = listPrice;
          notes.push(`${product.name ?? name}: precio de lista ${listPrice}`);
        }
      }
      if (!unit && product.unit) unit = product.unit;
    } else if (itemId) {
      itemId = null;
    }
    if (!name) name = 'Concepto';
    if (!rate || rate <= 0) notes.push(`"${name}" quedó con precio 0: indica el precio o busca el producto con searchQuoteProducts`);
    out.push({ ...item, itemId, name, rate: rate ?? 0, unit });
  }
  return { items: out, notes };
}

const QUOTE_HINTS: Record<string, string> = {
  ZOHO_NOT_CONFIGURED: 'Faltan las variables ZOHO_* en el servidor (o activa ZOHO_BOOKS_MOCK=true para pruebas). Avisa al administrador; usa getZohoBooksStatus para el diagnóstico.',
  ZOHO_AUTH: 'El refresh token de Zoho no tiene permiso para cotizaciones (scope ZohoBooks.estimates.ALL o ZohoBooks.fullaccess.all). El administrador debe regenerarlo.',
  PRODUCT_NOT_FOUND: 'Busca el producto con searchQuoteProducts y usa su itemId, o envíalo como concepto libre sin itemId.',
  CUSTOMER_NOT_FOUND: 'Busca el cliente con searchQuoteCustomers y usa su zohoContactId.',
  ZOHO_RATE_LIMIT: 'Zoho limitó las llamadas: reintenta en un minuto.',
  ZOHO_TIMEOUT: 'Verifica en Zoho si la cotización se creó antes de reintentar (evita duplicados).',
  CONFLICT: 'La cotización cambió en Zoho: vuelve a leerla (getQuoteDetail) y reintenta con los datos actuales.',
  MOCK_NO_PDF: 'Zoho está en modo simulación: no hay PDF oficial hasta configurar credenciales.',
};

/** One clear message for the model AND the approval card (never a raw stack). */
function friendlyQuoteError(err: unknown): Error {
  if (err instanceof QuoteWriteError) {
    const hint = QUOTE_HINTS[err.code] ?? (err.code.startsWith('ZOHO_') ? 'Zoho rechazó la operación: revisa el mensaje y corrige los datos (producto, precio, unidad, impuestos).' : '');
    return new Error(hint ? `${err.message} ${hint}` : err.message);
  }
  if (err instanceof ZodError) {
    return new Error(`Datos de la cotización inválidos: ${err.issues.map((i) => `${i.path.join('.') || 'campo'}: ${i.message}`).join('; ')}`);
  }
  return err instanceof Error ? err : new Error('Error desconocido al cotizar');
}

function normalizeName(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Zoho Books can require a salesperson on estimates. Order of preference:
 * the one the model named (resolved to its Zoho id), the user themself when
 * they are a Zoho salesperson, the salesperson of the customer's latest quote
 * or order, and finally the first salesperson of the organization.
 */
async function resolveSalesperson(actor: { name: string }, input: { salespersonId?: string | null; salespersonName?: string | null; customerId?: string | null; customerName?: string | null }): Promise<{ salespersonId: string | null; salespersonName: string | null; note: string | null }> {
  const { getSalespersonsForQuote } = await import('@/modules/quotes/quotes-salespersons');
  const list = await getSalespersonsForQuote().catch(() => [] as Array<{ id: string | null; name: string }>);
  const byName = (name: string | null | undefined) => (name ? list.find((s) => normalizeName(s.name) === normalizeName(name)) ?? null : null);
  if (input.salespersonId) {
    const found = list.find((s) => s.id === input.salespersonId);
    return { salespersonId: input.salespersonId, salespersonName: found?.name ?? input.salespersonName ?? null, note: null };
  }
  const named = byName(input.salespersonName);
  if (named) return { salespersonId: named.id, salespersonName: named.name, note: null };
  if (input.salespersonName?.trim()) return { salespersonId: null, salespersonName: input.salespersonName.trim(), note: null };
  const self = byName(actor.name);
  if (self) return { salespersonId: self.id, salespersonName: self.name, note: `vendedor: ${self.name} (tú)` };
  const lastQuote = input.customerId ? await prisma.quote.findFirst({ where: { zohoCustomerId: input.customerId, salespersonName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { salespersonName: true, salespersonId: true } }) : null;
  if (lastQuote?.salespersonName) {
    const match = byName(lastQuote.salespersonName);
    return { salespersonId: match?.id ?? lastQuote.salespersonId ?? null, salespersonName: match?.name ?? lastQuote.salespersonName, note: `vendedor: ${lastQuote.salespersonName} (última cotización del cliente)` };
  }
  const lastOrder = input.customerName ? await prisma.salesOrder.findFirst({ where: { customerName: { equals: input.customerName, mode: 'insensitive' }, salespersonName: { not: null } }, orderBy: { createdAt: 'desc' }, select: { salespersonName: true } }) : null;
  if (lastOrder?.salespersonName) {
    const match = byName(lastOrder.salespersonName);
    return { salespersonId: match?.id ?? null, salespersonName: match?.name ?? lastOrder.salespersonName, note: `vendedor: ${lastOrder.salespersonName} (última orden del cliente)` };
  }
  const first = list[0];
  if (first) return { salespersonId: first.id, salespersonName: first.name, note: `vendedor: ${first.name} (primero de la lista de Zoho)` };
  return { salespersonId: null, salespersonName: null, note: 'sin vendedor: Zoho no tiene vendedores configurados' };
}

/**
 * Completes the lines from the catalog BEFORE the approval card (create/preview)
 * and refuses lines Zoho would reject: no product and no name, or price 0.
 */
async function prepareQuoteArgs(rawArgs: unknown, options: { forUpdate?: boolean; actor?: { name: string } } = {}): Promise<{ args: unknown } | { error: string }> {
  const args = rawArgs as { items: RawQuoteItem[]; customerId?: string };
  const customer = args.customerId ? await prisma.contact.findUnique({ where: { zohoContactId: args.customerId }, select: { zohoContactId: true, contactName: true } }) : null;
  if (args.customerId && !customer) {
    return { error: `El customerId ${args.customerId} no es un cliente de Zoho sincronizado. Usa searchQuoteCustomers y pasa su zohoContactId.` };
  }
  const { items, notes } = await enrichQuoteItems(normalizeQuoteItems(args.items, options));
  const problems: string[] = [];
  items.forEach((line, i) => {
    if (!line.itemId && (line.name === 'Concepto' || !line.name.trim())) problems.push(`línea ${i + 1}: sin producto. Pasa itemId (de searchQuoteProducts) o name.`);
    else if (!line.rate || line.rate <= 0) problems.push(`línea ${i + 1} (${line.name}): precio 0 y sin precio de lista. Indica rate.`);
  });
  if (problems.length > 0) return { error: `Cotización incompleta — ${problems.join(' ')}` };
  const a = args as { salespersonId?: string | null; salespersonName?: string | null };
  const sp = await resolveSalesperson(options.actor ?? { name: '' }, { salespersonId: a.salespersonId, salespersonName: a.salespersonName, customerId: args.customerId ?? null, customerName: customer?.contactName ?? null });
  if (sp.note) notes.push(sp.note);
  return { args: { ...args, salespersonId: sp.salespersonId ?? undefined, salespersonName: sp.salespersonName ?? undefined, items: items.map((l) => ({ ...l, lineItemId: options.forUpdate ? l.lineItemId : undefined })), _prepared: notes } };
}

const quoteDraftShape = {
  customerId: z.string().min(1).describe('zohoContactId del cliente (usa searchQuoteCustomers)'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('yyyy-mm-dd; por defecto hoy'),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  referenceNumber: z.string().max(100).optional().nullable(),
  salespersonName: z.string().max(120).optional().nullable().describe('Vendedor de Zoho; si lo omites se usa el usuario actual o el de la última venta del cliente'),
  salespersonId: z.string().max(40).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  terms: z.string().max(5000).optional().nullable(),
  discountMode: z.enum(DISCOUNT_MODES).default('none'),
  discountValue: z.number().min(0).optional().nullable(),
  discountIsPercent: z.boolean().default(true),
  shippingCharge: z.number().min(0).optional().nullable(),
  items: z.array(rawQuoteItemSchema).min(1).max(200).describe('Conceptos. Lo ideal: itemId (zohoItemId de searchQuoteProducts) + quantity; si solo das name, el sistema busca el producto y aplica el precio de lista'),
};

function summarizeQuoteRow(q: {
  id: string; estimateNumber: string | null; status: string | null; date: string | null; expiryDate: string | null;
  customerName: string | null; total: string | null; currencyCode: string | null; salespersonName: string | null; createdInUnik: boolean;
}) {
  return {
    id: q.id,
    folio: q.estimateNumber,
    estado: getQuoteStatusLabel(q.status),
    statusRaw: q.status,
    fecha: q.date?.slice(0, 10) ?? null,
    vence: q.expiryDate?.slice(0, 10) ?? null,
    cliente: q.customerName,
    total: q.total ? Number(q.total) : null,
    moneda: q.currencyCode,
    vendedor: q.salespersonName,
    origen: q.createdInUnik ? 'UNIK' : 'Zoho',
    url: `/app/quotes/${q.id}`,
  };
}

registerTool({
  name: 'queryQuotes',
  description:
    'Consulta cotizaciones (estimates de Zoho Books): por cliente, estado (draft/sent/accepted/declined/invoiced/expired), segmento (abiertas, por vencer, vencidas), texto libre o rango de fechas. Devuelve folio, estado, fechas, cliente, total, vendedor y enlace.',
  category: 'sales',
  requiredPermission: 'quotes.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    search: z.string().max(200).optional().describe('Folio, cliente, vendedor o producto'),
    segment: z.enum(QUOTE_SEGMENTS).default('all'),
    status: z.array(z.string()).optional().describe('Estados raw de Zoho, p. ej. ["sent","draft"]'),
    customerName: z.string().max(200).optional(),
    dateFrom: z.string().optional().describe('yyyy-mm-dd'),
    dateTo: z.string().optional().describe('yyyy-mm-dd'),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { search?: string; segment: string; status?: string[]; customerName?: string; dateFrom?: string; dateTo?: string; page: number; pageSize: number };
    const rules: Record<string, unknown>[] = [];
    if (args.status?.length) rules.push({ field: 'status', operator: 'in', value: args.status });
    if (args.customerName) rules.push({ field: 'customerName', operator: 'contains', value: args.customerName });
    if (args.dateFrom && args.dateTo) rules.push({ field: 'date', operator: 'between', value: args.dateFrom, valueTo: args.dateTo });
    else if (args.dateFrom) rules.push({ field: 'date', operator: 'after', value: args.dateFrom });
    else if (args.dateTo) rules.push({ field: 'date', operator: 'before', value: args.dateTo });
    const result = await aiQueryQuotes(
      { search: args.search ?? '', segment: args.segment, filters: { logic: 'AND', rules }, sort: [{ field: 'date', direction: 'desc' }], page: args.page, page_size: args.pageSize },
      actor
    );
    return {
      total: result.pagination.total,
      showing: result.data.length,
      page: result.pagination.page,
      totalAmount: result.aggregates.totalAmount ? Number(result.aggregates.totalAmount) : null,
      rows: result.data.map(summarizeQuoteRow),
      hint: result.pagination.total === 0 ? 'Sin cotizaciones con esos filtros. Prueba segment="all" o sin filtros de estado; los estados se guardan en inglés (draft, sent, accepted, declined, invoiced, expired).' : undefined,
    };
  },
});

registerTool({
  name: 'getQuoteDetail',
  description: 'Detalle completo de una cotización (conceptos, totales, direcciones, notas, vigencia, estado en Zoho).',
  category: 'sales',
  requiredPermission: 'quotes.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ quoteId: z.string().min(1).describe('id interno de UNIK (de queryQuotes)') }),
  execute: async (_actor, rawArgs) => {
    const { quoteId } = rawArgs as { quoteId: string };
    const quote = await aiGetQuote(quoteId);
    if (!quote) return { error: 'Cotización no encontrada' };
    return {
      ...summarizeQuoteRow(quote),
      zohoEstimateId: quote.zohoEstimateId,
      subTotal: quote.subTotal ? Number(quote.subTotal) : null,
      taxTotal: quote.taxTotal ? Number(quote.taxTotal) : null,
      discountTotal: quote.discountTotal ? Number(quote.discountTotal) : null,
      shippingCharge: quote.shippingCharge ? Number(quote.shippingCharge) : null,
      notes: quote.notes,
      terms: quote.terms,
      customerZohoId: quote.zohoCustomerId,
      lastModifiedInZoho: quote.zohoLastModifiedTime,
      editable: ['draft', 'sent', 'expired'].includes(quote.status ?? ''),
      items: quote.items.map((i) => ({
        lineItemId: i.zohoLineItemId, itemId: i.zohoItemId, sku: i.sku, name: i.name, description: i.description,
        quantity: i.quantity ? Number(i.quantity) : null, rate: i.rate ? Number(i.rate) : null, unit: i.unit,
        discount: i.discount, tax: i.taxName, lineTotal: i.lineTotal ? Number(i.lineTotal) : null,
      })),
      pdfUrl: `/app/quotes/${quote.id}/pdf`,
    };
  },
});

registerTool({
  name: 'searchQuoteCustomers',
  description: 'Busca clientes sincronizados desde Zoho para cotizar (devuelve zohoContactId, nombre, empresa, correo, moneda).',
  category: 'sales',
  requiredPermission: 'quotes.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ search: z.string().max(100).default(''), limit: z.number().int().min(1).max(30).default(10) }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { search: string; limit: number };
    const rows = await aiSearchCustomers(args.search, args.limit);
    return { count: rows.length, customers: rows.map((c) => ({ customerId: c.zohoContactId, name: c.contactName, company: c.companyName, email: c.primaryEmail, currency: c.currencyCode, status: c.status })) };
  },
});

registerTool({
  name: 'searchQuoteProducts',
  description: 'Busca productos del catálogo sincronizado desde Zoho para cotizar (devuelve itemId, nombre, SKU, precio de lista, unidad, impuesto, stock).',
  category: 'sales',
  requiredPermission: 'quotes.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ search: z.string().max(100).default(''), limit: z.number().int().min(1).max(30).default(10) }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { search: string; limit: number };
    const rows = await aiSearchProducts(args.search, args.limit);
    return { count: rows.length, products: rows.map((p) => ({ itemId: p.zohoItemId, name: p.name, sku: p.sku, rate: p.rate ? Number(p.rate) : null, unit: p.unit, tax: p.taxName, taxPercent: p.taxPercentage ? Number(p.taxPercentage) : null, stock: p.availableStock ? Number(p.availableStock) : null, status: p.status })) };
  },
});

registerTool({
  name: 'previewQuote',
  description:
    'Valida y calcula un preliminar de cotización SIN crear nada en Zoho (subtotal, descuento, impuestos estimados, total). Úsalo antes de createQuote para mostrarle al usuario qué se va a crear.',
  category: 'sales',
  requiredPermission: 'quotes.create',
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object(quoteDraftShape),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as z.infer<z.ZodObject<typeof quoteDraftShape>>;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const { items, notes } = await enrichQuoteItems(normalizeQuoteItems(args.items));
      const { values, totals } = aiPreviewQuote({ ...args, items, date: args.date ?? today });
      return {
        valid: true,
        customerId: values.customerId,
        date: values.date,
        expiryDate: values.expiryDate ?? null,
        lines: values.items.map((i) => ({ itemId: i.itemId ?? null, name: i.name, quantity: i.quantity, rate: i.rate, unit: i.unit ?? null })),
        totals,
        adjustments: notes,
        note: 'Totales preliminares; Zoho recalcula impuestos y asigna el folio al crear. Usa EXACTAMENTE estas líneas (itemId, rate) en createQuote.',
      };
    } catch (err) {
      throw friendlyQuoteError(err);
    }
  },
});

function draftSummary(args: unknown, verb: string): string {
  const a = args as { customerId?: string; items?: RawQuoteItem[] };
  const lines = normalizeQuoteItems(a.items ?? []);
  const items = lines.slice(0, 3).map((i) => `${i.quantity}× ${i.name} @ ${i.rate > 0 ? i.rate : 'precio de lista'}`).join(', ');
  const more = lines.length > 3 ? ` (+${lines.length - 3} más)` : '';
  return `${verb} cotización en Zoho Books para el cliente ${a.customerId ?? '?'}: ${items}${more}`;
}

registerTool({
  name: 'createQuote',
  description:
    'Crea una cotización en Zoho Books (folio asignado por Zoho, sin duplicados) con clientes y productos ya sincronizados. Requiere aprobación del usuario. Antes muestra un previewQuote y confirma cliente y conceptos.',
  category: 'sales',
  requiredPermission: 'quotes.create',
  enabledByDefault: true,
  effect: 'business_write',
  summarize: (args) => draftSummary(args, 'Crear'),
  parameters: z.object(quoteDraftShape),
  prepareArgs: (actor, args) => prepareQuoteArgs(args, { actor }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as z.infer<z.ZodObject<typeof quoteDraftShape>>;
    const today = new Date().toISOString().slice(0, 10);
    try {
      const { items, notes } = await enrichQuoteItems(normalizeQuoteItems(args.items));
      const quote = await aiCreateQuote(actor, { ...args, items, date: args.date ?? today });
      return { created: true, ...summarizeQuoteRow(quote), adjustments: notes, pdfUrl: `/app/quotes/${quote.id}/pdf`, url: absoluteUrl(`/app/quotes/${quote.id}`), note: 'La cotización ya existe en Zoho Books. Comparte el enlace y ofrece el PDF oficial (getQuotePdf) o envíala con sendQuoteToContact.' };
    } catch (err) {
      throw friendlyQuoteError(err);
    }
  },
});

registerTool({
  name: 'updateQuote',
  description:
    'Edita una cotización existente en Zoho Books (solo en borrador, enviada o vencida). Envía TODOS los conceptos finales (los que no incluyas se eliminan); conserva lineItemId de los que ya existían. Requiere aprobación del usuario.',
  category: 'sales',
  requiredPermission: 'quotes.edit',
  enabledByDefault: true,
  effect: 'business_write',
  summarize: (args) => draftSummary(args, `Editar (${(args as { quoteId: string }).quoteId})`),
  parameters: z.object({ quoteId: z.string().min(1), ...quoteDraftShape }),
  prepareArgs: (actor, args) => prepareQuoteArgs(args, { forUpdate: true, actor }),
  execute: async (actor, rawArgs) => {
    const { quoteId, ...args } = rawArgs as { quoteId: string } & z.infer<z.ZodObject<typeof quoteDraftShape>>;
    const current = await aiGetQuote(quoteId);
    if (!current) return { error: 'Cotización no encontrada' };
    try {
      const { items, notes } = await enrichQuoteItems(normalizeQuoteItems(args.items, { forUpdate: true }));
      const quote = await aiUpdateQuote(actor, quoteId, {
        ...args,
        items,
        requestKey: `ai-update-${quoteId}-${Date.now()}`,
        date: args.date ?? current.date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        expectedRemoteModifiedAt: current.zohoLastModifiedTime,
      });
      return { updated: true, ...summarizeQuoteRow(quote), adjustments: notes, pdfUrl: `/app/quotes/${quote.id}/pdf` };
    } catch (err) {
      throw friendlyQuoteError(err);
    }
  },
});

registerTool({
  name: 'getQuotePdf',
  description: 'Obtiene el PDF OFICIAL de Zoho Books de una cotización y lo entrega como archivo descargable en el chat. UNIK nunca genera PDFs de cotización propios.',
  category: 'export',
  requiredPermission: 'quotes.view',
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object({ quoteId: z.string().min(1), conversationId: z.string().optional() }),
  execute: async (actor, rawArgs) => {
    const args = rawArgs as { quoteId: string; conversationId?: string };
    const { bytes, filename } = await aiGetQuotePdf(args.quoteId);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unik-quote-pdf-'));
    const filePath = path.join(dir, filename);
    try {
      await fs.writeFile(filePath, Buffer.from(bytes));
      const object = await saveGeneratedFile({
        createdBy: actor.id,
        purpose: 'ai_artifact',
        fileName: filename,
        mimeType: 'application/pdf',
        source: { filePath },
        metadata: { source: 'zoho_books_estimate', quoteId: args.quoteId },
      });
      const sizeBytes = Number(object.sizeBytes);
      if (!args.conversationId) return { filename, sizeBytes, storageObjectId: object.id, note: 'PDF oficial de Zoho listo' };
      const artifact = await createArtifact({
        conversationId: args.conversationId,
        type: 'pdf',
        storageObjectId: object.id,
        meta: { title: `Cotización ${filename.replace(/\.pdf$/i, '')}`, filename, mimeType: 'application/pdf', sizeBytes, source: 'zoho' },
      });
      return { artifactId: artifact.id, type: 'pdf', filename, sizeBytes, downloadUrl: `/app/assistant/api/artifacts/${artifact.id}/download`, note: 'PDF oficial de Zoho Books adjuntado a la conversación.' };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
});


/**
 * Fetches the official Zoho PDF of a quote and attaches it to an AI thread as an
 * artifact card (preview / download / send). Returns null in mock mode.
 */
export async function ensureQuotePdfArtifact(actor: { id: string }, quoteId: string, aiConversationId: string | undefined) {
  if (isZohoBooksMockEnabled() || !aiConversationId) return null;
  const quote = await aiGetQuote(quoteId);
  if (!quote) return null;
  const { bytes, filename } = await aiGetQuotePdf(quote.id);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unik-quote-pdf-'));
  const filePath = path.join(dir, filename);
  try {
    await fs.writeFile(filePath, Buffer.from(bytes));
    const object = await saveGeneratedFile({ createdBy: actor.id, purpose: 'ai_artifact', fileName: filename, mimeType: 'application/pdf', source: { filePath }, metadata: { source: 'zoho_books_estimate', quoteId: quote.id } });
    const sizeBytes = Number(object.sizeBytes);
    const title = `Cotización ${quote.estimateNumber ?? filename.replace(/\.pdf$/i, '')}`.trim();
    const artifact = await createArtifact({ conversationId: aiConversationId, type: 'pdf', storageObjectId: object.id, meta: { title, filename, mimeType: 'application/pdf', sizeBytes, source: 'zoho', protected: true, quoteId: quote.id } });
    return { artifactId: artifact.id, type: 'pdf' as const, title, filename, sizeBytes, mimeType: 'application/pdf', storageObjectId: object.id, quoteId: quote.id, downloadUrl: `/app/assistant/api/artifacts/${artifact.id}/download` };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Auto-quoting from a customer request
// ---------------------------------------------------------------------------

interface ResolvedProductLine {
  itemId: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  unit: string | null;
  rate: number;
  stock: number | null;
  matched: boolean;
  alternatives: Array<{ itemId: string; name: string; sku: string | null; rate: number | null }>;
  query: string;
  notes: string | null;
}

const PRODUCT_STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'con', 'para', 'por', 'm2', 'm²', 'metros', 'metro', 'piezas', 'pieza', 'pza', 'pzas', 'cm', 'mts']);

function productTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9ñ]+/)
    .filter((t) => t.length >= 2 && !PRODUCT_STOPWORDS.has(t) && !/^\d+$/.test(t));
}

const ACCENTS: Record<string, string> = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' };

/** "lamina" → ["lamina", "lámina", "lamína", "laminá"] (one accented vowel per word covers Spanish). */
function accentVariants(token: string): string[] {
  const out = [token];
  for (let i = 0; i < token.length; i++) {
    const acc = ACCENTS[token[i]];
    if (acc) out.push(`${token.slice(0, i)}${acc}${token.slice(i + 1)}`);
  }
  return out;
}

/**
 * Catalog search that survives word order and extra words: "piel de elefante 10xLL"
 * must find "Piel de Elefante Cafe 10xLL". Full text first, then all tokens (AND),
 * then progressively fewer tokens; candidates are ranked by matched tokens with a
 * bonus for size tokens ("10xll", "40x60"), which are what tells variants apart.
 */
export async function findCatalogProducts(query: string, limit = 6) {
  const direct = await aiSearchProducts(query, limit);
  if (direct.length > 0) return direct;
  const tokens = productTokens(query);
  if (tokens.length === 0) return [];
  const sizeTokens = tokens.filter((t) => /\d+x\d*[a-z]*|\d+[a-z]{1,3}$/.test(t));
  const wordTokens = tokens.filter((t) => !sizeTokens.includes(t));
  const attempts: string[][] = [tokens, wordTokens, wordTokens.slice(0, 2), wordTokens.slice(0, 1)].filter((a) => a.length > 0);
  for (const attempt of attempts) {
    const rows = await prisma.product.findMany({
      // Postgres `contains` is not accent-insensitive: "lamina" must still hit "Lámina".
      where: { AND: attempt.map((t) => ({ OR: accentVariants(t).map((v) => ({ name: { contains: v, mode: 'insensitive' as const } })) })) },
      take: 40,
      select: { zohoItemId: true, name: true, sku: true, description: true, rate: true, unit: true, taxName: true, taxPercentage: true, availableStock: true, status: true },
    });
    if (rows.length === 0) continue;
    const scored = rows
      .map((r) => {
        const name = (r.name ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        let score = 0;
        for (const t of tokens) if (name.includes(t)) score += sizeTokens.includes(t) ? 5 : 1;
        if (r.status && r.status !== 'active') score -= 2;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ r }) => ({
      zohoItemId: r.zohoItemId,
      name: r.name,
      sku: r.sku,
      description: r.description,
      rate: r.rate?.toString() ?? null,
      unit: r.unit,
      taxName: r.taxName,
      taxPercentage: r.taxPercentage?.toString() ?? null,
      availableStock: r.availableStock?.toString() ?? null,
      status: r.status,
    }));
  }
  return [];
}

/** Active customer by Zoho id or by name; exact names win, active wins over inactive, otherwise the candidates are returned. */
async function resolveQuoteCustomer(reference: string): Promise<{ customer: { zohoContactId: string; contactName: string | null } | null; candidates: Array<{ customerId: string; name: string | null; status: string | null }> }> {
  const ref = reference.trim();
  const byId = /^\d{6,}$/.test(ref) ? await getCustomerForQuote(ref) : null;
  if (byId) return { customer: { zohoContactId: byId.zohoContactId, contactName: byId.contactName }, candidates: [] };
  const found = await aiSearchCustomers(ref, 10);
  const isActive = (c: { status: string | null }) => (c.status ?? 'active').toLowerCase() === 'active';
  const norm = normalizeName(ref);
  const exact = found.filter((c) => normalizeName(c.contactName ?? '') === norm || normalizeName(c.companyName ?? '') === norm);
  const pool = exact.length > 0 ? exact : found;
  const active = pool.filter(isActive);
  const pick = active.length === 1 ? active[0] : pool.length === 1 && isActive(pool[0]) ? pool[0] : exact.length > 0 && active.length > 1 ? active[0] : null;
  if (pick) return { customer: { zohoContactId: pick.zohoContactId, contactName: pick.contactName }, candidates: [] };
  return { customer: null, candidates: found.map((c) => ({ customerId: c.zohoContactId, name: c.contactName ?? c.companyName, status: c.status })) };
}

async function resolveRequestedLine(line: { query: string; quantity: number; unit?: string; rate?: number; notes?: string }): Promise<ResolvedProductLine> {
  const candidates = await findCatalogProducts(line.query, 6);
  const q = line.query.trim().toLowerCase();
  const exact = candidates.find((p) => (p.name ?? '').toLowerCase() === q || (p.sku ?? '').toLowerCase() === q);
  const best = exact ?? candidates[0] ?? null;
  return {
    itemId: best?.zohoItemId ?? null,
    name: best?.name ?? line.query,
    sku: best?.sku ?? null,
    quantity: line.quantity,
    unit: line.unit ?? best?.unit ?? null,
    rate: line.rate ?? (best?.rate ? Number(best.rate) : 0),
    stock: best?.availableStock ? Number(best.availableStock) : null,
    matched: Boolean(best),
    alternatives: candidates.filter((p) => p.zohoItemId !== best?.zohoItemId).slice(0, 3).map((p) => ({ itemId: p.zohoItemId, name: p.name ?? '', sku: p.sku, rate: p.rate ? Number(p.rate) : null })),
    query: line.query,
    notes: line.notes ?? null,
  };
}

registerTool({
  name: 'draftQuoteFromRequest',
  description:
    'Convierte una solicitud en texto libre del cliente ("20 m2 de piel de elefante 5xll a domicilio") en un BORRADOR de cotización en Zoho Books: identifica al cliente (por la conversación de bandeja o por nombre), busca cada producto en el catálogo, arma las líneas (precio de lista salvo que indiques otro), registra entrega a domicilio o recoge en bodega y crea el borrador. Si la conversación ya tiene un borrador de hoy, lo ACTUALIZA con los cambios. No envía nada al cliente.',
  category: 'sales',
  requiredPermission: 'quotes.create',
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object({
    inboxConversationId: z.string().optional().describe('Conversación de bandeja (se inyecta en el copiloto)'),
    customer: z.string().optional().describe('Nombre o zohoContactId (customerId) del cliente cuando no hay conversación de bandeja. Si el sistema devuelve candidatos, vuelve a llamar con el customerId elegido.'),
    items: z.array(z.object({
      query: z.string().min(2).describe('Producto tal como lo pidió el cliente, ej. "piel de elefante 5xll"'),
      quantity: z.number().gt(0),
      unit: z.string().max(20).optional(),
      rate: z.number().min(0).optional().describe('Solo si el usuario fijó un precio distinto al de lista'),
      notes: z.string().max(200).optional(),
    })).min(1).max(50),
    delivery: z.object({ mode: z.enum(['pickup', 'delivery']), address: z.string().max(400).optional() }).optional(),
    notes: z.string().max(2000).optional(),
    referenceNumber: z.string().max(100).optional(),
    salesperson: z.string().max(120).optional().describe('Vendedor de Zoho; por defecto el usuario actual o el de la última venta del cliente'),
    expiryDays: z.number().int().min(1).max(90).default(15),
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
  }),
  execute: async (actor, rawArgs, ctx) => {
    const a = rawArgs as { inboxConversationId?: string; customer?: string; items: Array<{ query: string; quantity: number; unit?: string; rate?: number; notes?: string }>; delivery?: { mode: 'pickup' | 'delivery'; address?: string }; notes?: string; referenceNumber?: string; salesperson?: string; expiryDays: number; conversationId?: string };

    // 1. Customer
    let customerId: string | null = null;
    let customerLabel = a.customer ?? '';
    let contactPhone: string | null = null;
    if (a.inboxConversationId) {
      const { getConversation } = await import('@/modules/comms/comms-service');
      const conv = await getConversation(actor, a.inboxConversationId);
      contactPhone = conv.contact.phone;
      customerLabel = conv.contact.displayName;
      if (conv.contact.zohoContactId) customerId = conv.contact.zohoContactId;
      else {
        const resolved = await resolveQuoteCustomer(conv.contact.displayName);
        if (resolved.customer) customerId = resolved.customer.zohoContactId;
        else return { error: `El contacto "${conv.contact.displayName}" no está vinculado a un cliente de Zoho. Pide al usuario que indique el cliente (searchQuoteCustomers) o que lo vincule en la bandeja.`, candidates: resolved.candidates };
      }
    } else if (a.customer) {
      const resolved = await resolveQuoteCustomer(a.customer);
      if (!resolved.customer) {
        return {
          error: resolved.candidates.length === 0 ? `Cliente "${a.customer}" no existe en los clientes sincronizados de Zoho.` : `Cliente "${a.customer}" ambiguo: pregunta al usuario cuál de los candidatos es y vuelve a llamar con su customerId.`,
          candidates: resolved.candidates,
        };
      }
      customerId = resolved.customer.zohoContactId;
      customerLabel = resolved.customer.contactName ?? a.customer;
    } else {
      return { error: 'Indica el cliente (inboxConversationId o customer).' };
    }

    // 2. Products
    const lines = await Promise.all(a.items.map(resolveRequestedLine));
    const unmatched = lines.filter((l) => !l.matched);
    const matched = lines.filter((l) => l.matched);
    if (matched.length === 0) {
      return {
        error: `Ningún producto del catálogo coincidió con: ${unmatched.map((l) => `"${l.query}"`).join(', ')}. Busca con searchQuoteProducts (una o dos palabras clave, ej. "elefante") y vuelve a llamar draftQuoteFromRequest con el nombre exacto del producto en "query".`,
        unmatched: unmatched.map((l) => ({ requested: l.query, alternatives: l.alternatives })),
      };
    }

    // 3. Delivery + notes
    const deliveryText = a.delivery ? (a.delivery.mode === 'pickup' ? 'Entrega: el cliente RECOGE EN BODEGA.' : `Entrega: A DOMICILIO${a.delivery.address ? ` — ${a.delivery.address}` : ' (dirección por confirmar)'}.`) : null;
    const notes = [deliveryText, a.notes].filter(Boolean).join('\n') || null;
    const today = new Date();
    const expiry = new Date(today.getTime() + a.expiryDays * 86_400_000);
    const salesperson = await resolveSalesperson(actor, { salespersonName: a.salesperson ?? null, customerId, customerName: customerLabel || null });
    const form = {
      customerId: customerId!,
      date: today.toISOString().slice(0, 10),
      expiryDate: expiry.toISOString().slice(0, 10),
      referenceNumber: a.referenceNumber ?? null,
      salespersonId: salesperson.salespersonId,
      salespersonName: salesperson.salespersonName,
      notes,
      discountMode: 'none' as const,
      discountIsPercent: true,
      isDiscountBeforeTax: true,
      items: matched.map((l) => ({ itemId: l.itemId, name: l.name, description: l.notes ?? undefined, quantity: l.quantity, rate: l.rate, unit: l.unit ?? undefined })),
    };

    // 4. Create or update today's draft for this conversation/customer
    const prefix = a.inboxConversationId ? `ai-inbox-quote-${a.inboxConversationId}-` : `ai-quote-${customerId}-${actor.id}-`;
    const previous = await prisma.quoteWriteRequest.findFirst({ where: { requestKey: { startsWith: prefix }, status: 'completed', quoteId: { not: null } }, orderBy: { createdAt: 'desc' } });
    const existing = previous?.quoteId ? await aiGetQuote(previous.quoteId) : null;
    const requestKey = `${prefix}${Date.now()}`;
    let quote;
    let action: 'created' | 'updated';
    try {
      if (existing && existing.status === 'draft') {
        const currentLines = new Map(existing.items.map((i) => [i.zohoItemId ?? i.name ?? '', i.zohoLineItemId]));
        quote = await aiUpdateQuote(actor, existing.id, { ...form, requestKey, items: form.items.map((i) => ({ ...i, lineItemId: currentLines.get(i.itemId ?? i.name) ?? null })), expectedRemoteModifiedAt: existing.zohoLastModifiedTime });
        action = 'updated';
      } else {
        quote = await aiCreateQuote(actor, { ...form, requestKey });
        action = 'created';
      }
    } catch (err) {
      throw friendlyQuoteError(err);
    }

    // The official PDF goes straight to the chat as a card (preview / download / send).
    let pdf: Awaited<ReturnType<typeof ensureQuotePdfArtifact>> = null;
    try {
      pdf = await ensureQuotePdfArtifact(actor, quote.id, ctx.conversationId ?? a.conversationId);
    } catch (err) {
      console.warn(JSON.stringify({ event: 'ai.quote.pdf_failed', quoteId: quote.id, message: err instanceof Error ? err.message : 'unknown' }));
    }

    return {
      action,
      quoteId: quote.id,
      folio: quote.estimateNumber,
      pdfArtifactId: pdf?.artifactId ?? null,
      artifacts: pdf ? [pdf] : [],
      status: quote.status,
      customer: quote.customerName ?? customerLabel,
      customerPhone: contactPhone,
      total: quote.total ? Number(quote.total) : null,
      subTotal: quote.subTotal ? Number(quote.subTotal) : null,
      taxTotal: quote.taxTotal ? Number(quote.taxTotal) : null,
      currency: quote.currencyCode,
      expiryDate: quote.expiryDate?.slice(0, 10) ?? null,
      delivery: a.delivery ?? null,
      salesperson: salesperson.salespersonName,
      lines: matched.map((l) => ({ product: l.name, sku: l.sku, quantity: l.quantity, unit: l.unit, rate: l.rate, stock: l.stock, lowStock: l.stock !== null && l.stock < l.quantity, requested: l.query, alternatives: l.alternatives })),
      unmatched: unmatched.map((l) => ({ requested: l.query, alternatives: l.alternatives })),
      url: absoluteUrl(`/app/quotes/${quote.id}`),
      editUrl: absoluteUrl(`/app/quotes/${quote.id}/edit`),
      mock: isZohoBooksMockEnabled(),
      next: pdf
        ? 'El PDF oficial de Zoho ya aparece como tarjeta en el chat (vista previa y descarga). Muestra el resumen (folio, líneas, total, entrega); si hay unmatched o lowStock, dilo. Si el usuario pidió enviarla, llama sendQuoteToContact de inmediato (adjunta ese PDF; requiere una aprobación). No pongas enlaces internos (/app/quotes) en mensajes al cliente.'
        : 'Muestra el resumen al usuario (folio, líneas, total, entrega). Si hay unmatched o lowStock, dilo. Si el usuario pidió enviarla, llama sendQuoteToContact (requiere aprobación).',
    };
  },
});

registerTool({
  name: 'sendQuoteToContact',
  description:
    'Envía una cotización al cliente por WhatsApp/SMS con el PDF OFICIAL de Zoho adjunto y el mensaje indicado; marca la cotización como enviada en Zoho. Requiere aprobación del usuario.',
  category: 'sales',
  requiredPermission: 'quotes.view',
  enabledByDefault: true,
  effect: 'external_send',
  contextTags: ['all'],
  parameters: z.object({
    quoteId: z.string().min(1),
    inboxConversationId: z.string().optional().describe('Conversación de bandeja del cliente (se inyecta en el copiloto)'),
    contact: z.string().optional().describe('Nombre/teléfono si no hay conversación'),
    message: z.string().min(1).max(3000).describe('Mensaje de venta para el cliente (breve, claro, sin markdown)'),
    markAsSent: z.boolean().default(true),
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
  }),
  summarize: (args) => {
    const a = args as { quoteId: string; contact?: string; inboxConversationId?: string; message: string; _contactName?: string };
    return `Enviar cotización ${a.quoteId} con PDF de Zoho a ${a._contactName ?? a.contact ?? 'el cliente de la conversación'}: "${previewText(a.message, 160)}"`;
  },
  // Resolve WHO before the approval card: the inbox contact wins; an ambiguous name is refused so the model asks.
  prepareArgs: async (actor, rawArgs) => {
    const a = rawArgs as { quoteId: string; inboxConversationId?: string; contact?: string; message: string };
    if (a.inboxConversationId) {
      const { getConversation } = await import('@/modules/comms/comms-service');
      const conv = await getConversation(actor, a.inboxConversationId);
      return { args: { ...a, contact: conv.contact.id, _contactName: conv.contact.displayName } };
    }
    if (!a.contact) return { error: 'Indica el contacto o usa esta herramienta desde la conversación de bandeja del cliente.' };
    try {
      const contact = await resolveContact(a.contact);
      return { args: { ...a, contact: contact.commContactId ?? a.contact, _contactName: contact.displayName } };
    } catch (err) {
      return { error: `${err instanceof Error ? err.message : 'Contacto no encontrado'} Pregunta al usuario a cuál se refiere antes de proponer el envío.` };
    }
  },
  execute: async (actor, rawArgs, ctx) => {
    const a = rawArgs as { quoteId: string; inboxConversationId?: string; contact?: string; message: string; markAsSent: boolean; conversationId?: string };
    const quote = await aiGetQuote(a.quoteId);
    if (!quote) return { error: 'Cotización no encontrada' };
    const contactRef = a.contact ?? '';
    if (!contactRef) return { error: 'Indica el contacto o la conversación de bandeja.' };

    const artifactIds: string[] = [];
    let pdfNote: string | undefined;
    if (isZohoBooksMockEnabled()) {
      pdfNote = 'Modo simulación de Zoho: no hay PDF oficial; se envía solo el mensaje.';
    } else {
      const pdf = await ensureQuotePdfArtifact(actor, quote.id, ctx.conversationId ?? a.conversationId);
      if (pdf) artifactIds.push(pdf.artifactId);
    }

    const delivery = await deliverToContact(actor, { contact: contactRef, channel: 'any', body: a.message, attachments: artifactIds.length ? { artifactIds } : undefined }, ctx);
    let statusAfter = quote.status;
    if (a.markAsSent && quote.status === 'draft' && !isZohoBooksMockEnabled() && !delivery.error) {
      const updated = await changeQuoteStatus(actor, quote.id, 'sent').catch(() => null);
      statusAfter = updated?.status ?? statusAfter;
    }
    return { ...delivery, quoteId: quote.id, folio: quote.estimateNumber, quoteStatus: statusAfter, pdfAttached: artifactIds.length > 0, pdfNote };
  },
});

registerTool({
  name: 'findSimilarPastQuotes',
  description: 'Busca cotizaciones anteriores del mismo cliente o con los mismos productos (precios usados, si se aceptaron) para cotizar consistente y reutilizar condiciones.',
  category: 'sales',
  requiredPermission: 'quotes.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ customer: z.string().optional(), product: z.string().optional(), limit: z.number().int().min(1).max(20).default(8) }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { customer?: string; product?: string; limit: number };
    if (!a.customer && !a.product) return { error: 'Indica cliente o producto' };
    const quotes = await prisma.quote.findMany({
      where: {
        ...(a.customer ? { OR: [{ customerName: { contains: a.customer, mode: 'insensitive' } }, { zohoCustomerId: a.customer }] } : {}),
        ...(a.product ? { items: { some: { OR: [{ name: { contains: a.product, mode: 'insensitive' } }, { sku: { contains: a.product, mode: 'insensitive' } }] } } } : {}),
      },
      orderBy: { date: 'desc' },
      take: a.limit,
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    return {
      count: quotes.length,
      quotes: quotes.map((q) => ({
        quoteId: q.id, folio: q.estimateNumber, date: q.date?.toISOString().slice(0, 10), status: q.status, customer: q.customerName, total: q.total ? Number(q.total) : null,
        lines: q.items.filter((i) => !a.product || (i.name ?? '').toLowerCase().includes(a.product.toLowerCase()) || (i.sku ?? '').toLowerCase().includes(a.product.toLowerCase())).map((i) => ({ product: i.name, sku: i.sku, quantity: i.quantity ? Number(i.quantity) : null, rate: i.rate ? Number(i.rate) : null, unit: i.unit })),
      })),
    };
  },
});

registerTool({
  name: 'checkStockForRequest',
  description: 'Verifica existencias para una lista de productos/cantidades antes de cotizar o prometer entrega. Devuelve disponible vs. solicitado y faltantes.',
  category: 'inventory',
  requiredPermission: 'products.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ items: z.array(z.object({ query: z.string().min(2), quantity: z.number().gt(0) })).min(1).max(50) }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { items: Array<{ query: string; quantity: number }> };
    const rows = await Promise.all(a.items.map(async (it) => {
      const line = await resolveRequestedLine({ query: it.query, quantity: it.quantity });
      const available = line.stock;
      return { requested: it.query, product: line.matched ? line.name : null, sku: line.sku, quantity: it.quantity, available, ok: line.matched && available !== null && available >= it.quantity, shortage: line.matched && available !== null && available < it.quantity ? Math.round((it.quantity - available) * 100) / 100 : 0, unknownStock: line.matched && available === null };
    }));
    return { allAvailable: rows.every((r) => r.ok), rows };
  },
});

registerTool({
  name: 'getZohoBooksStatus',
  description:
    'Diagnóstico de la conexión con Zoho Books para cotizaciones: modo simulación, credenciales, organización, última cotización sincronizada y una lectura de prueba. Úsalo cuando crear/editar/enviar una cotización falle, para explicar la causa real y qué debe hacer el administrador.',
  category: 'system',
  requiredPermission: 'quotes.view',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({}),
  execute: async () => {
    const mock = isZohoBooksMockEnabled();
    let configured = false;
    let organizationId: string | null = null;
    let configError: string | null = null;
    try {
      const cfg = getZohoConfig();
      configured = Boolean(cfg.clientId && cfg.clientSecret && cfg.refreshToken);
      organizationId = cfg.booksOrganizationId ?? cfg.organizationId ?? null;
    } catch (err) {
      configError = err instanceof Error ? err.message : 'Configuración de Zoho inválida';
    }
    let probe: { ok: boolean; error?: string } | null = null;
    if (!mock && configured) {
      try {
        await listEstimates({ perPage: 1 });
        probe = { ok: true };
      } catch (err) {
        probe = { ok: false, error: err instanceof Error ? err.message : 'error' };
      }
    }
    const [count, last] = await Promise.all([
      prisma.quote.count(),
      prisma.quote.findFirst({ orderBy: { createdAt: 'desc' }, select: { estimateNumber: true, createdAt: true, createdInUnik: true } }),
    ]);
    const diagnosis = mock
      ? 'Zoho Books está en MODO SIMULACIÓN (ZOHO_BOOKS_MOCK=true): las cotizaciones se crean localmente, sin folio real ni PDF oficial.'
      : !configured
        ? `Zoho no está configurado: ${configError ?? 'faltan variables ZOHO_*'}. El administrador debe capturar ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN y ZOHO_ORGANIZATION_ID.`
        : probe && !probe.ok
          ? `Zoho rechaza las lecturas de cotizaciones: ${probe.error}. Casi siempre es el scope del refresh token (ZohoBooks.estimates.ALL / fullaccess) o el ID de organización de Books.`
          : 'Conexión con Zoho Books correcta: lectura de cotizaciones OK. Si crear falla, el error viene de los datos (producto/cliente/precio) y el mensaje de Zoho lo indica.';
    return { mock, configured, organizationId, probe, quotesSynced: count, lastQuote: last ? { folio: last.estimateNumber, at: last.createdAt.toISOString(), origin: last.createdInUnik ? 'UNIK' : 'Zoho' } : null, diagnosis };
  },
});
