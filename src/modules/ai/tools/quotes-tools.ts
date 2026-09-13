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
import { quoteLineInputSchema, DISCOUNT_MODES } from '@/modules/quotes/quotes-form-schema';
import { QUOTE_SEGMENTS } from '@/modules/quotes/quotes-filters';
import { getQuoteStatusLabel } from '@/modules/quotes/quotes-helpers';
import { prisma } from '@/lib/prisma';
import { absoluteUrl } from '@/lib/app-url';
import { previewText } from '@/modules/comms/normalize';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import { changeQuoteStatus } from '@/modules/quotes/quotes-write-service';
import { deliverToContact } from './messaging-tools';

/**
 * Cotizaciones (Zoho Books estimates). Every write goes through
 * quotes-write-service (idempotency, optimistic lock, Zoho as source of truth)
 * and — being business_write — through the approval card first.
 */

const quoteDraftShape = {
  customerId: z.string().min(1).describe('zohoContactId del cliente (usa searchQuoteCustomers)'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('yyyy-mm-dd; por defecto hoy'),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  referenceNumber: z.string().max(100).optional().nullable(),
  salespersonName: z.string().max(120).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  terms: z.string().max(5000).optional().nullable(),
  discountMode: z.enum(DISCOUNT_MODES).default('none'),
  discountValue: z.number().min(0).optional().nullable(),
  discountIsPercent: z.boolean().default(true),
  shippingCharge: z.number().min(0).optional().nullable(),
  items: z.array(quoteLineInputSchema).min(1).max(200).describe('Conceptos; usa itemId (zohoItemId) de searchQuoteProducts para productos del catálogo'),
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
    const { values, totals } = aiPreviewQuote({ ...args, date: args.date ?? today });
    return { valid: true, customerId: values.customerId, date: values.date, expiryDate: values.expiryDate ?? null, lines: values.items.length, totals, note: 'Totales preliminares; Zoho recalcula impuestos y asigna el folio al crear.' };
  },
});

function draftSummary(args: unknown, verb: string): string {
  const a = args as { customerId?: string; items?: { name?: string; quantity?: number; rate?: number }[] };
  const items = (a.items ?? []).slice(0, 3).map((i) => `${i.quantity ?? 1}× ${i.name ?? 'concepto'} @ ${i.rate ?? 0}`).join(', ');
  const more = (a.items?.length ?? 0) > 3 ? ` (+${(a.items?.length ?? 0) - 3} más)` : '';
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
  execute: async (actor, rawArgs) => {
    const args = rawArgs as z.infer<z.ZodObject<typeof quoteDraftShape>>;
    const today = new Date().toISOString().slice(0, 10);
    const quote = await aiCreateQuote(actor, { ...args, date: args.date ?? today });
    return { created: true, ...summarizeQuoteRow(quote), pdfUrl: `/app/quotes/${quote.id}/pdf`, note: 'La cotización ya existe en Zoho Books. Comparte el enlace y ofrece el PDF oficial (getQuotePdf).' };
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
  execute: async (actor, rawArgs) => {
    const { quoteId, ...args } = rawArgs as { quoteId: string } & z.infer<z.ZodObject<typeof quoteDraftShape>>;
    const current = await aiGetQuote(quoteId);
    if (!current) return { error: 'Cotización no encontrada' };
    const quote = await aiUpdateQuote(actor, quoteId, {
      ...args,
      requestKey: `ai-update-${quoteId}-${Date.now()}`,
      date: args.date ?? current.date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      expectedRemoteModifiedAt: current.zohoLastModifiedTime,
    });
    return { updated: true, ...summarizeQuoteRow(quote), pdfUrl: `/app/quotes/${quote.id}/pdf` };
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

async function resolveRequestedLine(line: { query: string; quantity: number; unit?: string; rate?: number; notes?: string }): Promise<ResolvedProductLine> {
  const candidates = await aiSearchProducts(line.query, 6);
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
    customer: z.string().optional().describe('Nombre o zohoContactId si no hay conversación'),
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
    expiryDays: z.number().int().min(1).max(90).default(15),
  }),
  execute: async (actor, rawArgs) => {
    const a = rawArgs as { inboxConversationId?: string; customer?: string; items: Array<{ query: string; quantity: number; unit?: string; rate?: number; notes?: string }>; delivery?: { mode: 'pickup' | 'delivery'; address?: string }; notes?: string; referenceNumber?: string; expiryDays: number };

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
        const found = await aiSearchCustomers(conv.contact.displayName, 5);
        const exact = found.find((c) => (c.contactName ?? '').toLowerCase() === conv.contact.displayName.toLowerCase());
        if (exact) customerId = exact.zohoContactId;
        else if (found.length === 1) customerId = found[0].zohoContactId;
        else return { error: `El contacto "${conv.contact.displayName}" no está vinculado a un cliente de Zoho. Pide al usuario que indique el cliente (searchQuoteCustomers) o que lo vincule en la bandeja.`, candidates: found.map((c) => ({ customerId: c.zohoContactId, name: c.contactName })) };
      }
    } else if (a.customer) {
      const found = await aiSearchCustomers(a.customer, 5);
      const exact = found.find((c) => c.zohoContactId === a.customer || (c.contactName ?? '').toLowerCase() === a.customer!.toLowerCase());
      const pick = exact ?? (found.length === 1 ? found[0] : null);
      if (!pick) return { error: `Cliente "${a.customer}" no encontrado o ambiguo`, candidates: found.map((c) => ({ customerId: c.zohoContactId, name: c.contactName })) };
      customerId = pick.zohoContactId;
      customerLabel = pick.contactName ?? a.customer;
    } else {
      return { error: 'Indica el cliente (inboxConversationId o customer).' };
    }

    // 2. Products
    const lines = await Promise.all(a.items.map(resolveRequestedLine));
    const unmatched = lines.filter((l) => !l.matched);
    const matched = lines.filter((l) => l.matched);
    if (matched.length === 0) return { error: 'Ningún producto coincidió con el catálogo.', unmatched: unmatched.map((l) => l.query) };

    // 3. Delivery + notes
    const deliveryText = a.delivery ? (a.delivery.mode === 'pickup' ? 'Entrega: el cliente RECOGE EN BODEGA.' : `Entrega: A DOMICILIO${a.delivery.address ? ` — ${a.delivery.address}` : ' (dirección por confirmar)'}.`) : null;
    const notes = [deliveryText, a.notes].filter(Boolean).join('\n') || null;
    const today = new Date();
    const expiry = new Date(today.getTime() + a.expiryDays * 86_400_000);
    const form = {
      customerId: customerId!,
      date: today.toISOString().slice(0, 10),
      expiryDate: expiry.toISOString().slice(0, 10),
      referenceNumber: a.referenceNumber ?? null,
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
    if (existing && existing.status === 'draft') {
      const currentLines = new Map(existing.items.map((i) => [i.zohoItemId ?? i.name ?? '', i.zohoLineItemId]));
      quote = await aiUpdateQuote(actor, existing.id, { ...form, requestKey, items: form.items.map((i) => ({ ...i, lineItemId: currentLines.get(i.itemId ?? i.name) ?? null })), expectedRemoteModifiedAt: existing.zohoLastModifiedTime });
      action = 'updated';
    } else {
      quote = await aiCreateQuote(actor, { ...form, requestKey });
      action = 'created';
    }

    return {
      action,
      quoteId: quote.id,
      folio: quote.estimateNumber,
      status: quote.status,
      customer: quote.customerName ?? customerLabel,
      customerPhone: contactPhone,
      total: quote.total ? Number(quote.total) : null,
      subTotal: quote.subTotal ? Number(quote.subTotal) : null,
      taxTotal: quote.taxTotal ? Number(quote.taxTotal) : null,
      currency: quote.currencyCode,
      expiryDate: quote.expiryDate?.slice(0, 10) ?? null,
      delivery: a.delivery ?? null,
      lines: matched.map((l) => ({ product: l.name, sku: l.sku, quantity: l.quantity, unit: l.unit, rate: l.rate, stock: l.stock, lowStock: l.stock !== null && l.stock < l.quantity, requested: l.query, alternatives: l.alternatives })),
      unmatched: unmatched.map((l) => ({ requested: l.query, alternatives: l.alternatives })),
      url: absoluteUrl(`/app/quotes/${quote.id}`),
      editUrl: absoluteUrl(`/app/quotes/${quote.id}/edit`),
      mock: isZohoBooksMockEnabled(),
      next: 'Muestra el resumen al usuario (folio, líneas, total, entrega). Si hay unmatched o lowStock, dilo. Luego propón el mensaje para el cliente y usa sendQuoteToContact (requiere aprobación).',
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
    const a = args as { quoteId: string; contact?: string; inboxConversationId?: string; message: string };
    return `Enviar cotización ${a.quoteId} con PDF de Zoho a ${a.contact ?? 'el cliente de la conversación'}: "${previewText(a.message, 160)}"`;
  },
  execute: async (actor, rawArgs, ctx) => {
    const a = rawArgs as { quoteId: string; inboxConversationId?: string; contact?: string; message: string; markAsSent: boolean; conversationId?: string };
    const quote = await aiGetQuote(a.quoteId);
    if (!quote) return { error: 'Cotización no encontrada' };
    let contactRef = a.contact ?? '';
    if (a.inboxConversationId) {
      const { getConversation } = await import('@/modules/comms/comms-service');
      const conv = await getConversation(actor, a.inboxConversationId);
      contactRef = conv.contact.id;
    }
    if (!contactRef) return { error: 'Indica el contacto o la conversación de bandeja.' };

    const artifactIds: string[] = [];
    let pdfNote: string | undefined;
    if (isZohoBooksMockEnabled()) {
      pdfNote = 'Modo simulación de Zoho: no hay PDF oficial; se envía solo el mensaje.';
    } else {
      const { bytes, filename } = await aiGetQuotePdf(quote.id);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unik-quote-send-'));
      const filePath = path.join(dir, filename);
      try {
        await fs.writeFile(filePath, Buffer.from(bytes));
        const object = await saveGeneratedFile({ createdBy: actor.id, purpose: 'ai_artifact', fileName: filename, mimeType: 'application/pdf', source: { filePath }, metadata: { source: 'zoho_books_estimate', quoteId: quote.id } });
        const aiConversationId = ctx.conversationId ?? a.conversationId;
        if (aiConversationId) {
          const artifact = await createArtifact({ conversationId: aiConversationId, type: 'pdf', storageObjectId: object.id, meta: { title: `Cotización ${quote.estimateNumber ?? ''}`.trim(), filename, mimeType: 'application/pdf', sizeBytes: Number(object.sizeBytes), source: 'zoho', protected: true } });
          artifactIds.push(artifact.id);
        }
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
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
