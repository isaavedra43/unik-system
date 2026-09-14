import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { createArtifact } from '../ai-artifacts-service';
import { absoluteUrl } from '@/lib/app-url';
import { chatCompletion, type ContentPart } from '../ai-client';
import { getAiSettings } from '../ai-admin-config-service';
import { modelForTask } from '../model-policy';
import {
  attachmentKind,
  getAttachmentForActor,
  listAttachments,
  processAttachment,
  readAttachmentBytes,
  type AttachmentResult,
} from '../ai-attachments-service';
import { storeArtifactFile, withTempArtifactFile } from './artifact-tools';
import { generateComposedPdf } from '../generators/document-pdf-generator';
import { generateComposedDocx } from '../generators/document-docx-generator';
import { imageDimensions, type ComposedDocumentSpec, type DocBlock, type DocColumn, type DocImage, type DocKpi } from '../generators/document-spec';
import { parseJsonObject } from './documents-tools';

/**
 * Elaborate documents and attachment reading.
 *
 * - `readAttachment`: reliable, on-demand reading of any file of the
 *   conversation (also files sent in EARLIER messages, whose images are no
 *   longer in the model's context): text extraction for PDF/Word/Excel/text,
 *   faithful vision transcription for photos and scanned PDFs (handwritten
 *   notes included), optionally structured as rows.
 * - `composeDocument`: a professional multi-section document AUTHORED by the
 *   assistant (cover with big numbers, executive summary, findings, grouped
 *   tables it built itself, callouts, bar charts, appendix with the original
 *   photos) as PDF and/or Word. Unlike the tabular report tools, the rows here
 *   are written by the model: this is the tool for analyses, cross-checks and
 *   consolidated reports that no single data query produces.
 */

const MAX_BLOCKS = 120;
const MAX_TOTAL_ROWS = 4000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_APPENDIX_IMAGES = 12;

const toneSchema = z.enum(['info', 'success', 'warning', 'danger', 'muted']);

const kpiSchema = z.object({
  label: z.string().max(80),
  value: z.string().max(40),
  note: z.string().max(120).optional(),
  tone: toneSchema.optional(),
});

const columnSchema = z.object({
  header: z.string().max(60),
  key: z.string().max(60),
  align: z.enum(['left', 'right', 'center']).optional(),
  width: z.number().positive().optional().describe('Peso relativo de ancho (ej. 60 para folios, 160 para nombres).'),
  format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
  detail: z.boolean().optional().describe('true = texto largo que va como línea completa debajo de la fila (notas, direcciones).'),
});

const blockSchema = z.object({
  type: z.enum(['heading', 'paragraph', 'bullets', 'callout', 'kpis', 'keyValue', 'table', 'bars', 'image', 'divider', 'pageBreak']),
  text: z.string().max(6000).optional().describe('heading / paragraph / callout: el texto.'),
  level: z.number().int().min(1).max(3).optional().describe('heading: 1 = sección ("1. Resumen ejecutivo"), 2 = subsección, 3 = título menor.'),
  style: z.enum(['normal', 'lead', 'muted', 'note']).optional().describe('paragraph: lead = entrada destacada, muted = gris, note = nota pequeña en cursiva.'),
  title: z.string().max(200).optional().describe('bullets / table / bars / keyValue: título opcional del bloque.'),
  items: z.array(z.string().max(1500)).max(60).optional().describe('bullets: cada viñeta (texto completo, sin cortar).'),
  ordered: z.boolean().optional().describe('bullets: true = lista numerada.'),
  tone: toneSchema.optional().describe('callout: info (azul), success (verde), warning (ámbar), danger (rojo), muted (gris).'),
  kpis: z.array(kpiSchema).max(8).optional().describe('kpis: tarjetas con número grande.'),
  pairs: z.array(z.object({ label: z.string().max(120), value: z.string().max(1500) })).max(40).optional().describe('keyValue: filas etiqueta → valor.'),
  columns: z.array(columnSchema).max(14).optional().describe('table: columnas en orden. Si no las pasas se toman de las claves de la primera fila.'),
  rows: z.array(z.record(z.unknown())).max(MAX_TOTAL_ROWS).optional().describe('table: TODAS las filas del grupo, sin omitir ninguna (nunca "..." ni "y N más").'),
  totalsRow: z.record(z.unknown()).optional().describe('table: fila final en negritas (ej. {"orden": "TOTAL", "cantidad": 65}).'),
  caption: z.string().max(600).optional().describe('table / image: texto explicativo debajo del título (o de la imagen).'),
  footnote: z.string().max(600).optional().describe('table: nota en cursiva bajo la tabla (fuente, lecturas dudosas).'),
  bars: z.array(z.object({ label: z.string().max(80), value: z.number(), color: z.string().max(9).optional() })).max(30).optional().describe('bars: gráfica de barras horizontales (etiqueta y valor).'),
  valueSuffix: z.string().max(12).optional().describe('bars: sufijo del valor (" órdenes", "%").'),
  showPercent: z.boolean().optional().describe('bars: false = sin porcentaje del total junto al valor.'),
  attachmentId: z.string().optional().describe('image: id del adjunto (foto JPG/PNG) a incrustar en ese punto del documento.'),
  maxHeight: z.number().min(60).max(700).optional().describe('image: alto máximo en puntos (default 440).'),
});

type BlockArgs = z.infer<typeof blockSchema>;

const composeParams = z.object({
  conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
  title: z.string().min(3).max(160).describe('Título del documento (ej. "Reporte consolidado de órdenes de venta no cerradas").'),
  subtitle: z.string().max(240).optional().describe('Subtítulo (qué compara / de qué trata).'),
  headerLabel: z.string().max(120).optional().describe('Texto corto del encabezado de cada página (ej. "UNIK | Control de órdenes de venta").'),
  footerLabel: z.string().max(160).optional().describe('Texto del pie de página (ej. "Fuente: reporte UNIK + notas manuscritas"). Se agrega "Página X de N" solo.'),
  format: z.enum(['pdf', 'docx', 'both']).default('pdf').describe('pdf (default), docx (Word editable) o both.'),
  orientation: z.enum(['portrait', 'landscape']).optional().describe('portrait (default, documentos narrativos) o landscape (tablas de muchas columnas).'),
  brandColor: z.string().max(9).optional().describe('Color hex del acento (default azul UNIK).'),
  cover: z
    .object({
      metaLine: z.string().max(160).optional().describe('Línea de corte (ej. "Corte: 14 de septiembre de 2026 | 65 órdenes").'),
      kpis: z.array(kpiSchema).max(6).optional().describe('2 a 4 números grandes de portada.'),
      note: z.string().max(400).optional().describe('Nota al pie de la portada (alcance, advertencias de lectura).'),
    })
    .optional()
    .describe('Portada. Inclúyela en reportes formales; omítela en documentos cortos.'),
  blocks: z.array(blockSchema).min(1).max(MAX_BLOCKS).describe('Contenido en orden: encabezados, párrafos, viñetas, avisos, KPIs, tablas, barras, imágenes, saltos.'),
  appendix: z
    .object({
      includeAttachments: z.boolean().optional().describe('true = anexa al final TODAS las fotos/imágenes adjuntas en esta conversación como respaldo.'),
      attachmentIds: z.array(z.string()).max(MAX_APPENDIX_IMAGES).optional().describe('Anexar solo estos adjuntos (ids de listConversationAttachments).'),
      title: z.string().max(120).optional(),
      intro: z.string().max(600).optional(),
    })
    .optional(),
  fileName: z.string().max(120).optional().describe('Nombre del archivo sin extensión (default: el título).'),
});

type ComposeArgs = z.infer<typeof composeParams>;

function slugFileName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90);
  return base || 'Documento_UNIK';
}

async function attachmentsOfActor(conversationId: string, actorId: string): Promise<AttachmentResult[]> {
  const conv = await prisma.aiConversation.findFirst({ where: { id: conversationId, userId: actorId }, select: { id: true } });
  if (!conv) return [];
  const rows = await listAttachments(conversationId);
  return rows.filter((r) => r.status === 'ready' || r.status === 'legacy');
}

async function loadImage(attachment: AttachmentResult, warnings: string[]): Promise<DocImage | null> {
  if (attachmentKind(attachment.mimeType) !== 'image') {
    warnings.push(`"${attachment.fileName}" no es una imagen: no se anexa (solo JPG/PNG).`);
    return null;
  }
  try {
    const data = await readAttachmentBytes(attachment, MAX_IMAGE_BYTES);
    const dims = imageDimensions(data);
    if (!dims) {
      warnings.push(`"${attachment.fileName}" está en un formato que no se puede incrustar (solo JPG/PNG).`);
      return null;
    }
    return { data, mimeType: dims.mimeType, width: dims.width, height: dims.height, caption: attachment.fileName };
  } catch (err) {
    warnings.push(`No se pudo leer "${attachment.fileName}": ${err instanceof Error ? err.message : 'error'}`);
    return null;
  }
}

function toColumns(columns: BlockArgs['columns']): DocColumn[] {
  return (columns ?? []).map((c) => ({ header: c.header, key: c.key, align: c.align, width: c.width, format: c.format, detail: c.detail }));
}

function toKpis(items: BlockArgs['kpis']): DocKpi[] {
  return (items ?? []).map((k) => ({ label: k.label, value: k.value, note: k.note, tone: k.tone }));
}

/** Turns the flat tool blocks into the typed spec; collects problems instead of throwing. */
async function buildBlocks(
  blocks: BlockArgs[],
  images: Map<string, DocImage>,
  warnings: string[]
): Promise<{ blocks: DocBlock[]; rowCount: number }> {
  const out: DocBlock[] = [];
  let rowCount = 0;
  blocks.forEach((b, i) => {
    const where = `bloque ${i + 1} (${b.type})`;
    switch (b.type) {
      case 'heading':
        if (b.text?.trim()) out.push({ type: 'heading', text: b.text.trim(), level: (b.level as 1 | 2 | 3 | undefined) ?? 1 });
        else warnings.push(`${where}: sin texto, se omitió.`);
        return;
      case 'paragraph':
        if (b.text?.trim()) out.push({ type: 'paragraph', text: b.text.trim(), style: b.style });
        else warnings.push(`${where}: sin texto, se omitió.`);
        return;
      case 'bullets':
        if (b.items && b.items.length > 0) out.push({ type: 'bullets', items: b.items, ordered: b.ordered, title: b.title });
        else warnings.push(`${where}: sin items, se omitió.`);
        return;
      case 'callout':
        if (b.text?.trim()) out.push({ type: 'callout', tone: b.tone, title: b.title, text: b.text.trim() });
        else warnings.push(`${where}: sin texto, se omitió.`);
        return;
      case 'kpis':
        if (b.kpis && b.kpis.length > 0) out.push({ type: 'kpis', items: toKpis(b.kpis) });
        else warnings.push(`${where}: sin kpis, se omitió.`);
        return;
      case 'keyValue':
        if (b.pairs && b.pairs.length > 0) out.push({ type: 'keyValue', title: b.title, items: b.pairs });
        else warnings.push(`${where}: sin pairs, se omitió.`);
        return;
      case 'table': {
        const rows = (b.rows ?? []).filter((r) => r && typeof r === 'object');
        if (rows.length === 0 && !b.title) {
          warnings.push(`${where}: sin filas, se omitió.`);
          return;
        }
        rowCount += rows.length;
        out.push({ type: 'table', title: b.title, caption: b.caption, columns: toColumns(b.columns), rows, totalsRow: b.totalsRow, footnote: b.footnote });
        return;
      }
      case 'bars':
        if (b.bars && b.bars.length > 0) out.push({ type: 'bars', title: b.title, items: b.bars, valueSuffix: b.valueSuffix, showPercent: b.showPercent });
        else warnings.push(`${where}: sin bars, se omitió.`);
        return;
      case 'image': {
        const img = b.attachmentId ? images.get(b.attachmentId) : undefined;
        if (img) out.push({ type: 'image', image: img, caption: b.caption ?? b.title, maxHeight: b.maxHeight });
        else warnings.push(`${where}: adjunto ${b.attachmentId ?? '(sin id)'} no disponible como imagen, se omitió.`);
        return;
      }
      case 'divider':
        out.push({ type: 'divider' });
        return;
      case 'pageBreak':
        out.push({ type: 'pageBreak' });
        return;
      default:
        return;
    }
  });
  return { blocks: out, rowCount };
}

registerTool({
  name: 'composeDocument',
  category: 'export',
  effect: 'draft',
  enabledByDefault: true,
  requiredPermission: 'assistant.use',
  description:
    'Crea un DOCUMENTO PROFESIONAL Y ELABORADO (PDF y/o Word) cuyo contenido escribes TÚ: portada con números grandes, resumen ejecutivo, hallazgos, prioridades, secciones con tablas que tú armaste (agrupaciones, cruces, comparativos, discrepancias), avisos destacados, gráficas de barras, tabla maestra y anexo con las fotos originales adjuntas. ' +
    'Úsalo para reportes consolidados, análisis, cruces entre archivos adjuntos y el sistema, informes ejecutivos, minutas, propuestas y cualquier documento narrativo. ' +
    'A diferencia de generatePdfReport (que vuelca las filas de una consulta), aquí las filas de cada tabla las escribes tú y deben estar COMPLETAS (cada orden/registro que mencionas, sin "…"). ' +
    'Recomendado: cover con 2-4 KPIs → heading "1. Resumen ejecutivo" + párrafos → bullets "Prioridades" → una tabla por grupo/motivo con caption → callouts para lo urgente/dudoso → tabla maestra → appendix.includeAttachments=true cuando el análisis salió de fotos o documentos del usuario.',
  parameters: composeParams,
  summarize: (args) => {
    const a = args as ComposeArgs;
    return `Documento "${a.title}" (${a.format ?? 'pdf'}, ${a.blocks?.length ?? 0} bloques)`;
  },
  execute: async (actor, rawArgs, ctx) => {
    const args = rawArgs as ComposeArgs;
    const conversationId = args.conversationId ?? ctx.conversationId;
    if (!conversationId) return { error: 'Sin conversación activa: no se puede guardar el documento.' };
    const warnings: string[] = [];

    // Images referenced by blocks or requested for the appendix (only the actor's own files).
    const wantedIds = new Set<string>();
    for (const b of args.blocks) if (b.type === 'image' && b.attachmentId) wantedIds.add(b.attachmentId);
    for (const id of args.appendix?.attachmentIds ?? []) wantedIds.add(id);
    const conversationFiles = wantedIds.size > 0 || args.appendix?.includeAttachments ? await attachmentsOfActor(conversationId, actor.id) : [];
    const byId = new Map(conversationFiles.map((f) => [f.id, f] as const));
    const images = new Map<string, DocImage>();
    for (const id of wantedIds) {
      const att = byId.get(id);
      if (!att) {
        warnings.push(`Adjunto ${id} no existe en esta conversación.`);
        continue;
      }
      const img = await loadImage(att, warnings);
      if (img) images.set(id, img);
    }

    const built = await buildBlocks(args.blocks, images, warnings);
    if (built.blocks.length === 0) return { error: 'Ningún bloque tenía contenido válido. Revisa que cada bloque traiga text/items/rows según su tipo.', warnings };
    if (built.rowCount > MAX_TOTAL_ROWS) return { error: `Demasiadas filas (${built.rowCount}); máximo ${MAX_TOTAL_ROWS}. Divide el documento.`, warnings };

    const appendixImages: DocImage[] = [];
    if (args.appendix) {
      const ids = args.appendix.attachmentIds && args.appendix.attachmentIds.length > 0
        ? args.appendix.attachmentIds
        : args.appendix.includeAttachments
          ? conversationFiles.filter((f) => attachmentKind(f.mimeType) === 'image').map((f) => f.id)
          : [];
      for (const id of ids.slice(0, MAX_APPENDIX_IMAGES)) {
        const cached = images.get(id);
        if (cached) {
          appendixImages.push({ ...cached, caption: byId.get(id)?.fileName ?? cached.caption });
          continue;
        }
        const att = byId.get(id);
        if (!att) continue;
        const img = await loadImage(att, warnings);
        if (img) appendixImages.push(img);
      }
      if (ids.length > MAX_APPENDIX_IMAGES) warnings.push(`Solo se anexaron ${MAX_APPENDIX_IMAGES} de ${ids.length} imágenes.`);
    }

    const spec: ComposedDocumentSpec = {
      title: args.title.trim(),
      subtitle: args.subtitle?.trim() || undefined,
      headerLabel: args.headerLabel?.trim() || `UNIK | ${args.title.trim()}`.slice(0, 110),
      footerLabel: args.footerLabel?.trim() || undefined,
      author: 'UNIK Asistente IA',
      brandColor: args.brandColor,
      orientation: args.orientation,
      logoText: 'UNIK',
      cover: args.cover ? { metaLine: args.cover.metaLine, kpis: toKpis(args.cover.kpis), note: args.cover.note } : undefined,
      blocks: built.blocks,
      appendix: appendixImages.length > 0 ? { title: args.appendix?.title, intro: args.appendix?.intro, images: appendixImages } : undefined,
    };

    const baseName = slugFileName(args.fileName?.trim() || args.title);
    const formats: Array<'pdf' | 'docx'> = args.format === 'both' ? ['pdf', 'docx'] : [args.format ?? 'pdf'];
    const artifacts: Array<Record<string, unknown>> = [];
    for (const format of formats) {
      const mimeType = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const filename = `${baseName}.${format}`;
      const { info, storageObjectId } = await withTempArtifactFile(format, async (filePath) => {
        const generated = format === 'pdf' ? await generateComposedPdf(filePath, spec) : await generateComposedDocx(filePath, spec);
        const stored = await storeArtifactFile(actor.id, filePath, filename, mimeType, { title: spec.title, pageCount: generated.pageCount, composed: true });
        return { info: generated, storageObjectId: stored.storageObjectId };
      });
      const artifact = await createArtifact({
        conversationId,
        type: format,
        storageObjectId,
        meta: {
          title: spec.title,
          subtitle: spec.subtitle,
          filename,
          mimeType,
          sizeBytes: info.sizeBytes,
          pageCount: info.pageCount,
          rowCount: info.rowCount,
          sectionCount: info.tableCount,
          composed: true,
          imageCount: info.imageCount,
        },
      });
      artifacts.push({
        artifactId: artifact.id,
        type: format,
        title: spec.title,
        filename,
        sizeBytes: info.sizeBytes,
        pageCount: info.pageCount,
        rowCount: info.rowCount,
        downloadUrl: absoluteUrl(`/app/assistant/api/artifacts/${artifact.id}/download`),
      });
    }

    return {
      artifacts,
      title: spec.title,
      formats,
      blocks: built.blocks.length,
      tables: built.blocks.filter((b) => b.type === 'table').length,
      rowCount: built.rowCount,
      appendixImages: appendixImages.length,
      warnings,
      note:
        'Documento generado. Al entregarlo, resume en 2-4 líneas qué contiene (secciones, cuántos registros, anexos) y menciona las advertencias si las hay. ' +
        'Si el usuario pide cambios ("agrega una sección", "quita la tabla X", "en Word"), vuelve a llamar composeDocument con el contenido completo corregido.',
    };
  },
});

/* ------------------------------------------------------------------ */
/* readAttachment                                                     */
/* ------------------------------------------------------------------ */

const TRANSCRIBE_SYSTEM_PROMPT = `Eres un transcriptor meticuloso de documentos de negocio en español (México): fotos de libretas y notas manuscritas, listas, tablas, tickets, capturas de pantalla y PDFs escaneados.
Devuelve SOLO un objeto JSON válido (sin bloques de código) con esta forma:
{"text": string, "rows": [ {…} ] | null, "uncertain": [string]}
Reglas:
- "text": la transcripción COMPLETA, línea por línea, en el mismo orden del documento. No resumas, no omitas líneas, no corrijas ortografía de nombres; expande abreviaturas evidentes entre corchetes solo si ayudan ("Prod." → "Producción").
- Números de folio/orden: transcribe cada dígito con cuidado (23354 vs 23364). Si un dígito es dudoso, escribe tu mejor lectura y agrega la duda en "uncertain" ("línea 7: 23354 podría ser 23364").
- Texto tachado: indícalo como "[tachado: …]" y transcribe lo que quedó vigente.
- "rows": cuando el contenido es una lista o tabla (folio + nota, producto + cantidad, etc.), una fila por renglón con claves cortas en español ("orden", "nota", "cantidad"…). Si no aplica, null.
- "uncertain": lecturas dudosas o ilegibles con su ubicación. Vacío si todo se leyó bien.
Nunca inventes contenido que no está en la imagen.`;

const readParams = z.object({
  attachmentId: z.string().optional().describe('Id del adjunto (de listConversationAttachments). Si no lo pasas, se usa fileName o el más reciente.'),
  fileName: z.string().max(200).optional().describe('Parte del nombre del archivo, si no tienes el id.'),
  mode: z.enum(['auto', 'text', 'table']).default('auto').describe('table = pide explícitamente filas estructuradas (folio → nota). auto decide.'),
  hints: z.string().max(500).optional().describe('Qué buscar o cómo interpretar (ej. "son órdenes de venta OV-xxxxx con el motivo de no entrega").'),
  maxChars: z.number().int().min(1000).max(200_000).default(40_000).describe('Límite de caracteres para documentos de texto.'),
  conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
});

registerTool({
  name: 'readAttachment',
  category: 'system',
  effect: 'read',
  enabledByDefault: true,
  description:
    'Lee un archivo adjunto de esta conversación y devuelve su contenido completo: texto de PDF/Word/Excel/CSV, o transcripción fiel con visión de fotos e imágenes (notas manuscritas, libretas, tickets, capturas) y PDFs escaneados, opcionalmente como filas estructuradas. ' +
    'Úsala cuando necesites releer un adjunto de un mensaje anterior, cuando el texto inyectado venga recortado, o para tener una transcripción literal línea por línea antes de cruzar datos. Los adjuntos del mensaje actual ya vienen en tu contexto: úsalos directamente y llama esta tool solo si necesitas más detalle.',
  parameters: readParams,
  execute: async (actor, rawArgs, ctx) => {
    const args = rawArgs as z.infer<typeof readParams>;
    const conversationId = args.conversationId ?? ctx.conversationId;
    if (!conversationId) return { error: 'Sin conversación activa.' };

    let attachment: AttachmentResult | null = null;
    if (args.attachmentId) {
      attachment = await getAttachmentForActor(conversationId, actor.id, args.attachmentId);
    } else if (args.fileName) {
      const needle = args.fileName.toLowerCase();
      const files = await attachmentsOfActor(conversationId, actor.id);
      attachment = files.reverse().find((f) => f.fileName.toLowerCase().includes(needle)) ?? null;
    } else {
      attachment = await getAttachmentForActor(conversationId, actor.id);
    }
    if (!attachment) {
      const files = await attachmentsOfActor(conversationId, actor.id);
      return {
        error: 'Adjunto no encontrado (o aún no está listo).',
        available: files.map((f) => ({ id: f.id, fileName: f.fileName, kind: attachmentKind(f.mimeType) })),
      };
    }

    const processed = await processAttachment(attachment, { maxTextChars: args.maxChars });
    const base = { attachment: { id: attachment.id, fileName: attachment.fileName, mimeType: attachment.mimeType, kind: attachmentKind(attachment.mimeType) } };

    if (processed.type === 'text') {
      return { ...base, source: 'text', text: processed.content, truncated: processed.truncated ?? false, rows: null, uncertain: [] };
    }
    if (processed.type === 'file') {
      return { ...base, error: `Formato no soportado para lectura: ${attachment.mimeType}` };
    }

    const parts: ContentPart[] = [
      {
        type: 'text',
        text: `Archivo: "${attachment.fileName}". Modo: ${args.mode === 'table' ? 'devuelve rows estructuradas' : args.mode === 'text' ? 'solo transcripción' : 'decide si aplica rows'}.${args.hints ? ` Contexto del usuario: ${args.hints}` : ''}`,
      },
    ];
    if (processed.type === 'image') parts.push({ type: 'image_url', image_url: { url: processed.dataUrl } });
    else parts.push({ type: 'file', file: { filename: processed.filename, file_data: processed.dataUrl } });

    const settings = await getAiSettings();
    const model = modelForTask(settings, 'vision');
    const res = await chatCompletion({
      model,
      temperature: 0,
      maxTokens: 8000,
      messages: [
        { role: 'system', content: TRANSCRIBE_SYSTEM_PROMPT },
        { role: 'user', content: parts },
      ],
    });
    const raw = res.content ?? '';
    let parsed: { text?: unknown; rows?: unknown; uncertain?: unknown } = {};
    try {
      parsed = parseJsonObject(raw) as typeof parsed;
    } catch {
      // The model answered in prose: still useful as a transcription.
      parsed = { text: raw, rows: null, uncertain: ['El modelo no devolvió JSON; se entrega la transcripción tal cual.'] };
    }
    const text = typeof parsed.text === 'string' ? parsed.text : raw;
    const rows = Array.isArray(parsed.rows) ? (parsed.rows as unknown[]).filter((r) => r && typeof r === 'object') : null;
    const uncertain = Array.isArray(parsed.uncertain) ? (parsed.uncertain as unknown[]).map(String) : [];
    return {
      ...base,
      source: 'vision',
      model,
      text,
      rows: args.mode === 'text' ? null : rows,
      lineCount: text.split('\n').filter((l) => l.trim().length > 0).length,
      uncertain,
      note: 'Transcripción hecha por IA con visión: los folios dudosos vienen en "uncertain"; verifícalos contra el sistema (querySalesOrders) antes de afirmar algo sobre ellos.',
    };
  },
});
