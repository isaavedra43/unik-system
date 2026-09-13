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
