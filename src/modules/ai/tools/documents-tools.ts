import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { chatCompletion, type ContentPart } from '../ai-client';
import { getAiSettings } from '../ai-admin-config-service';
import { attachmentKind, getAttachmentForActor, processAttachment } from '../ai-attachments-service';
import { modelForTask } from '../model-policy';

/**
 * Document intelligence: list the files of the conversation, extract
 * structured data from invoices/receipts/orders (OCR via the vision model
 * when the PDF is scanned) and draft a vendor bill matched against UNIK's
 * vendors and products. Bills themselves are captured in Zoho Books (UNIK
 * syncs them read-only), so the draft is the deliverable — never a claim
 * that the bill already exists.
 */

const DOCUMENT_KINDS = ['invoice', 'receipt', 'purchase_order', 'quote', 'delivery_note', 'generic'] as const;
type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const KIND_LABEL: Record<DocumentKind, string> = {
  invoice: 'factura (CFDI o extranjera)',
  receipt: 'recibo / ticket de compra',
  purchase_order: 'orden de compra',
  quote: 'cotización',
  delivery_note: 'remisión / nota de entrega',
  generic: 'documento comercial',
};

const numberish = z.preprocess((v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());

const partySchema = z
  .object({
    name: z.string().nullable().optional(),
    rfc: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
  })
  .passthrough();

const extractedDocumentSchema = z
  .object({
    documentType: z.string().nullable().optional(),
    issuer: partySchema.nullable().optional(),
    receiver: partySchema.nullable().optional(),
    folio: z.string().nullable().optional(),
    series: z.string().nullable().optional(),
    uuid: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    dueDate: z.string().nullable().optional(),
    currency: z.string().nullable().optional(),
    items: z
      .array(
        z
          .object({
            description: z.string().nullable().optional(),
            sku: z.string().nullable().optional(),
            quantity: numberish.optional(),
            unit: z.string().nullable().optional(),
            unitPrice: numberish.optional(),
            amount: numberish.optional(),
          })
          .passthrough()
      )
      .default([]),
    subtotal: numberish.optional(),
    taxes: z.array(z.object({ name: z.string().nullable().optional(), rate: numberish.optional(), amount: numberish.optional() }).passthrough()).default([]),
    total: numberish.optional(),
    paymentMethod: z.string().nullable().optional(),
    paymentTerms: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    confidence: numberish.optional(),
    warnings: z.array(z.string()).default([]),
  })
  .passthrough();

export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;

const EXTRACTION_SYSTEM_PROMPT = `Eres un extractor de datos de documentos comerciales mexicanos (facturas CFDI, recibos, órdenes de compra, cotizaciones, remisiones).
Devuelve SOLO un objeto JSON válido, sin texto adicional ni bloques de código, con esta forma exacta:
{"documentType": string|null, "issuer": {"name","rfc","address","phone","email"}, "receiver": {"name","rfc"}, "folio": string|null, "series": string|null, "uuid": string|null, "date": "YYYY-MM-DD"|null, "dueDate": "YYYY-MM-DD"|null, "currency": "MXN"|"USD"|null, "items": [{"description","sku","quantity","unit","unitPrice","amount"}], "subtotal": number|null, "taxes": [{"name","rate","amount"}], "total": number|null, "paymentMethod": string|null, "paymentTerms": string|null, "notes": string|null, "confidence": 0..1, "warnings": [string]}
Reglas: usa null cuando un dato no aparece (nunca inventes); los importes son números sin símbolos; el RFC va en mayúsculas; si hay varios impuestos lista cada uno; en "warnings" indica ilegibilidades, totales que no cuadran o campos dudosos; "confidence" refleja qué tan legible y completo fue el documento.`;

/** Extracts the first JSON object of a model answer (tolerates code fences and prose). */
export function parseJsonObject(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('El modelo no devolvió JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function extractFromAttachment(
  actorId: string,
  conversationId: string,
  attachmentId: string | undefined,
  kind: DocumentKind,
  hints?: string
): Promise<{ attachment: { id: string; fileName: string; mimeType: string }; document: ExtractedDocument; source: 'text' | 'vision'; model: string }> {
  const attachment = await getAttachmentForActor(conversationId, actorId, attachmentId);
  if (!attachment) throw new Error(attachmentId ? 'Adjunto no encontrado en esta conversación' : 'No hay adjuntos en esta conversación: pide al usuario que suba el documento');
  const processed = await processAttachment(attachment);
  const parts: ContentPart[] = [
    { type: 'text', text: `Tipo esperado: ${KIND_LABEL[kind]}. Archivo: "${attachment.fileName}".${hints ? ` Indicaciones del usuario: ${hints}` : ''}` },
  ];
  let source: 'text' | 'vision' = 'text';
  if (processed.type === 'image') {
    parts.push({ type: 'image_url', image_url: { url: processed.dataUrl } });
    source = 'vision';
  } else if (processed.type === 'file_part') {
    parts.push({ type: 'file', file: { filename: processed.filename, file_data: processed.dataUrl } });
    source = 'vision';
  } else if (processed.type === 'text') {
    parts.push({ type: 'text', text: `Contenido del documento:\n${processed.content}` });
  } else {
    throw new Error(`Formato no soportado para extracción: ${attachment.mimeType}`);
  }
  const settings = await getAiSettings();
  const model = modelForTask(settings, 'vision');
  const res = await chatCompletion({
    model,
    temperature: 0,
    maxTokens: 8000,
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: parts },
    ],
  });
  const raw = parseJsonObject(res.content ?? '');
  const parsed = extractedDocumentSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Extracción inválida: ${parsed.error.issues[0]?.message ?? 'formato'}. Si el archivo no es una factura/recibo (notas, listas, fotos de libreta), usa readAttachment o el contenido que ya tienes en el mensaje.`);
  return { attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType }, document: parsed.data, source, model };
}

registerTool({
  name: 'listConversationAttachments',
  description: 'Lista los archivos que el usuario ha subido a esta conversación (id, nombre, tipo, tamaño). Úsala para saber qué documento procesar con extractDocumentData o draftBillFromDocument.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ conversationId: z.string().optional() }),
  execute: async (actor, _args, ctx) => {
    if (!ctx.conversationId) return { attachments: [], note: 'Sin conversación activa.' };
    const conv = await prisma.aiConversation.findFirst({ where: { id: ctx.conversationId, userId: actor.id }, select: { id: true } });
    if (!conv) return { attachments: [], note: 'Sin acceso a la conversación.' };
    const rows = await prisma.aiAttachment.findMany({
      where: { conversationId: ctx.conversationId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
    });
    return {
      attachments: rows.map((r) => ({ id: r.id, fileName: r.fileName, mimeType: r.mimeType, kind: attachmentKind(r.mimeType), sizeKb: Math.round(r.sizeBytes / 1024), uploadedAt: r.createdAt.toISOString() })),
      note: rows.length === 0 ? 'El usuario aún no ha subido archivos aquí.' : 'El más reciente va primero; si el usuario no especifica, usa ese.',
    };
  },
});

registerTool({
  name: 'extractDocumentData',
  description:
    'Extrae datos estructurados de un documento COMERCIAL adjunto (factura/CFDI, recibo, orden de compra, cotización, remisión): emisor y receptor con RFC, folio, UUID, fecha, conceptos con cantidades y precios, subtotal, impuestos y total. Funciona con PDF con texto, PDF escaneado e imágenes (OCR con visión). NO la uses para notas manuscritas, listas, reportes o fotos de libreta: para eso lee el adjunto directamente en tu contexto o usa readAttachment. Si no pasas attachmentId usa el archivo más reciente de la conversación.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    attachmentId: z.string().optional(),
    kind: z.enum(DOCUMENT_KINDS).default('generic'),
    hints: z.string().max(500).optional().describe('Pistas del usuario: moneda, proveedor esperado, qué campos importan'),
    conversationId: z.string().optional(),
  }),
  execute: async (actor, rawArgs, ctx) => {
    const args = rawArgs as { attachmentId?: string; kind: DocumentKind; hints?: string };
    if (!ctx.conversationId) throw new Error('Sin conversación activa');
    const out = await extractFromAttachment(actor.id, ctx.conversationId, args.attachmentId, args.kind, args.hints);
    const totalsOk =
      out.document.subtotal != null && out.document.total != null
        ? Math.abs((out.document.subtotal ?? 0) + out.document.taxes.reduce((s, t) => s + (t.amount ?? 0), 0) - (out.document.total ?? 0)) < 1
        : null;
    return {
      ...out,
      checks: { totalsMatch: totalsOk },
      note: 'Datos extraídos por IA: verifica RFC, folio y total antes de usarlos. Si el usuario quiere capturarlo como factura de proveedor, llama draftBillFromDocument.',
    };
  },
});

registerTool({
  name: 'draftBillFromDocument',
  description:
    'Prepara el borrador de una factura de proveedor (bill) a partir de una factura adjunta: extrae los datos, identifica al proveedor en UNIK por RFC/nombre y empareja cada concepto con productos del catálogo. Devuelve el borrador listo para revisar. La bill se captura en Zoho Books (UNIK la sincroniza): nunca afirmes que ya fue creada.',
  category: 'purchases',
  enabledByDefault: true,
  effect: 'draft',
  parameters: z.object({
    attachmentId: z.string().optional(),
    vendorHint: z.string().max(200).optional().describe('Nombre del proveedor si el usuario lo dijo'),
    conversationId: z.string().optional(),
  }),
  summarize: (args) => {
    const a = args as { vendorHint?: string };
    return `Borrador de factura de proveedor${a.vendorHint ? ` (${a.vendorHint})` : ''} a partir del documento adjunto`;
  },
  execute: async (actor, rawArgs, ctx) => {
    const args = rawArgs as { attachmentId?: string; vendorHint?: string };
    if (!ctx.conversationId) throw new Error('Sin conversación activa');
    const { attachment, document, source } = await extractFromAttachment(actor.id, ctx.conversationId, args.attachmentId, 'invoice', args.vendorHint ? `Proveedor esperado: ${args.vendorHint}` : undefined);

    const rfc = document.issuer?.rfc?.toUpperCase().replace(/[^A-Z0-9&Ñ]/g, '') || null;
    const issuerName = (args.vendorHint ?? document.issuer?.name ?? '').trim();
    const nameWords = issuerName.split(/\s+/).filter((w) => w.length > 2).slice(0, 3);
    const vendorCandidates = await prisma.contact.findMany({
      where: {
        OR: [
          ...(rfc ? [{ taxRegNo: { equals: rfc, mode: 'insensitive' as const } }] : []),
          ...(nameWords.length > 0
            ? [
                { contactName: { contains: nameWords[0], mode: 'insensitive' as const } },
                { companyName: { contains: nameWords[0], mode: 'insensitive' as const } },
                { legalName: { contains: nameWords[0], mode: 'insensitive' as const } },
              ]
            : []),
        ],
      },
      take: 8,
      select: { id: true, zohoContactId: true, contactName: true, companyName: true, legalName: true, taxRegNo: true, contactType: true, outstandingPayable: true },
    });
    const ranked = vendorCandidates
      .map((c) => {
        let score = 0;
        if (rfc && c.taxRegNo && c.taxRegNo.toUpperCase() === rfc) score += 10;
        if ((c.contactType ?? '').toLowerCase().includes('vendor')) score += 3;
        const hay = `${c.contactName ?? ''} ${c.companyName ?? ''} ${c.legalName ?? ''}`.toLowerCase();
        for (const w of nameWords) if (hay.includes(w.toLowerCase())) score += 2;
        return { ...c, score, outstandingPayable: c.outstandingPayable ? Number(c.outstandingPayable) : null };
      })
      .sort((a, b) => b.score - a.score);
    const vendor = ranked[0] && ranked[0].score >= 4 ? ranked[0] : null;

    const items = [] as Array<Record<string, unknown>>;
    for (const item of document.items.slice(0, 40)) {
      const desc = (item.description ?? '').trim();
      const words = desc.split(/\s+/).filter((w) => w.length > 2).slice(0, 2);
      let product: { id: string; zohoItemId: string; name: string | null; sku: string | null } | null = null;
      if (item.sku) {
        product = await prisma.product.findFirst({ where: { sku: { equals: item.sku, mode: 'insensitive' } }, select: { id: true, zohoItemId: true, name: true, sku: true } });
      }
      if (!product && words.length > 0) {
        product = await prisma.product.findFirst({
          where: { AND: words.map((w) => ({ name: { contains: w, mode: 'insensitive' as const } })) },
          select: { id: true, zohoItemId: true, name: true, sku: true },
        });
      }
      items.push({
        description: desc,
        quantity: item.quantity ?? null,
        unit: item.unit ?? null,
        unitPrice: item.unitPrice ?? null,
        amount: item.amount ?? null,
        matchedProduct: product ? { id: product.id, zohoItemId: product.zohoItemId, name: product.name, sku: product.sku } : null,
      });
    }
    const unmatched = items.filter((i) => !i.matchedProduct).length;

    return {
      attachment,
      source,
      vendor: vendor ? { id: vendor.id, zohoContactId: vendor.zohoContactId, name: vendor.companyName ?? vendor.contactName, rfc: vendor.taxRegNo, outstandingPayable: vendor.outstandingPayable } : null,
      vendorCandidates: vendor ? [] : ranked.slice(0, 5).map((c) => ({ id: c.id, name: c.companyName ?? c.contactName, rfc: c.taxRegNo, type: c.contactType })),
      bill: {
        vendorName: document.issuer?.name ?? null,
        vendorRfc: rfc,
        billNumber: [document.series, document.folio].filter(Boolean).join('-') || null,
        uuid: document.uuid ?? null,
        date: document.date ?? null,
        dueDate: document.dueDate ?? null,
        currency: document.currency ?? 'MXN',
        items,
        subtotal: document.subtotal ?? null,
        taxes: document.taxes,
        total: document.total ?? null,
        paymentTerms: document.paymentTerms ?? null,
        notes: document.notes ?? null,
      },
      warnings: [
        ...document.warnings,
        ...(vendor ? [] : ['Proveedor no identificado con certeza en UNIK: confirma con el usuario o elige entre vendorCandidates.']),
        ...(unmatched > 0 ? [`${unmatched} concepto(s) sin producto del catálogo: se capturarán como líneas libres.`] : []),
      ],
      canCreateInZoho: false,
      nextSteps:
        'Muestra el borrador (proveedor, folio, fecha, conceptos, total) y pide confirmación. La factura de proveedor se captura en Zoho Books → Compras → Facturas; UNIK la sincroniza automáticamente. Si el usuario quiere, programa un seguimiento (scheduleFollowUp) o avisa a compras por chat interno.',
      confidence: document.confidence ?? null,
    };
  },
});
