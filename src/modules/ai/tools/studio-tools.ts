import { z } from 'zod';
import { registerTool } from './registry';
import {
  studioBlockSchema,
  studioContentSchema,
  applySelectionEdit,
} from '@/modules/studio/studio-content';
import {
  approveDocument,
  createDocument,
  getDocument,
  listDocuments,
  saveDocument,
  STUDIO_DOCUMENT_KINDS,
} from '@/modules/studio/studio-service';
import { requestExport } from '@/modules/studio/studio-export-service';
import { STUDIO_EXPORT_FORMATS } from '@/modules/studio/studio-exporters';

/**
 * Studio tools for the assistant ("cambios por selección").
 *
 * Effects: reads and drafts run directly (the document stays private to the
 * user); approving a document is a business write and therefore goes through
 * the common executor as a proposal the user must approve in the chat.
 *
 * PENDING INTEGRATION: add `import './studio-tools';` to src/modules/ai/tools/index.ts.
 */

const documentIdSchema = z.string().min(1).max(64).describe('Id del documento del estudio');

function documentSummary(doc: Awaited<ReturnType<typeof getDocument>>) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    status: doc.status,
    visibility: doc.visibility,
    currentVersion: doc.currentVersion,
    updatedAt: doc.updatedAt,
  };
}

registerTool({
  name: 'listStudioDocuments',
  description:
    'Lista los documentos del Estudio visual del usuario (propios o compartidos con el equipo): id, título, estado y versión actual.',
  category: 'export',
  effect: 'read',
  enabledByDefault: true,
  requiredPermission: 'studio.use',
  parameters: z.object({
    scope: z
      .enum(['mine', 'team'])
      .optional()
      .describe('mine (por defecto) = mis documentos; team = compartidos por el equipo'),
    includeArchived: z.boolean().optional(),
  }),
  execute: async (actor, args) => {
    const a = args as { scope?: 'mine' | 'team'; includeArchived?: boolean };
    const docs = await listDocuments(actor, {
      scope: a.scope ?? 'mine',
      includeArchived: a.includeArchived,
    });
    return {
      count: docs.length,
      documents: docs.map((d) => ({ ...documentSummary({ ...d } as never) })),
    };
  },
});

registerTool({
  name: 'getStudioDocument',
  description:
    'Obtiene un documento del Estudio visual con todos sus bloques (id, tipo y contenido) para poder proponer cambios por selección.',
  category: 'export',
  effect: 'read',
  enabledByDefault: true,
  requiredPermission: 'studio.use',
  parameters: z.object({ documentId: documentIdSchema }),
  execute: async (actor, args) => {
    const doc = await getDocument(actor, (args as { documentId: string }).documentId);
    return { ...documentSummary(doc), permissions: doc.permissions, blocks: doc.content.blocks };
  },
});

registerTool({
  name: 'createStudioDocument',
  description:
    'Crea un documento en el Estudio visual a partir de bloques (encabezados, párrafos, listas, tablas con columnas/filas, KPIs). Úsalo para convertir un reporte o tabla en un documento editable.',
  category: 'export',
  effect: 'draft',
  enabledByDefault: true,
  requiredPermission: 'studio.use',
  parameters: z.object({
    title: z.string().min(1).max(200),
    kind: z.enum(STUDIO_DOCUMENT_KINDS).optional(),
    blocks: z.array(studioBlockSchema).max(500).describe('Bloques del documento en orden'),
    conversationId: z.string().max(64).optional(),
  }),
  summarize: (args) => `Crear documento "${(args as { title: string }).title}"`,
  execute: async (actor, args, ctx) => {
    const a = args as {
      title: string;
      kind?: (typeof STUDIO_DOCUMENT_KINDS)[number];
      blocks: unknown[];
      conversationId?: string;
    };
    const content = studioContentSchema.parse({ version: 1, blocks: a.blocks });
    const doc = await createDocument(actor, {
      title: a.title,
      kind: a.kind ?? 'document',
      content,
      conversationId: a.conversationId ?? ctx.conversationId,
    });
    return { ...documentSummary(doc), blockCount: doc.content.blocks.length, url: '/app/studio' };
  },
});

registerTool({
  name: 'editStudioDocumentSelection',
  description:
    'Aplica un cambio por selección en un documento del estudio: recibe los ids de los bloques seleccionados y los bloques YA REDACTADOS que los reemplazan (conserva ids de los bloques que se mantienen; usa [] para eliminar). Nada fuera de la selección cambia; se crea una nueva versión.',
  category: 'export',
  effect: 'draft',
  enabledByDefault: true,
  requiredPermission: 'studio.use',
  parameters: z.object({
    documentId: documentIdSchema,
    blockIds: z
      .array(z.string().min(1).max(64))
      .min(1)
      .max(50)
      .describe('Ids de los bloques seleccionados'),
    instruction: z
      .string()
      .min(1)
      .max(2000)
      .describe('Instrucción del usuario (queda en el historial de versiones)'),
    blocks: z.array(studioBlockSchema).max(200).describe('Bloques que reemplazan la selección'),
  }),
  summarize: (args) => {
    const a = args as { documentId: string; blockIds: string[]; instruction: string };
    return `Editar ${a.blockIds.length} bloque(s) del documento ${a.documentId}: ${a.instruction.slice(0, 120)}`;
  },
  execute: async (actor, args) => {
    const a = args as {
      documentId: string;
      blockIds: string[];
      instruction: string;
      blocks: unknown[];
    };
    const doc = await getDocument(actor, a.documentId);
    const blocks = z.array(studioBlockSchema).parse(a.blocks);
    const next = applySelectionEdit(doc.content, a.blockIds, { blocks });
    const saved = await saveDocument(actor, a.documentId, {
      content: next,
      changeSummary: `IA: ${a.instruction.slice(0, 160)}`,
    });
    return {
      ...documentSummary(saved.document),
      versionCreated: saved.versionCreated,
      diff: saved.diff?.summary ?? null,
      revertedToDraft: saved.revertedToDraft,
      invalidatedProposals: saved.invalidatedProposals,
    };
  },
});

registerTool({
  name: 'exportStudioDocument',
  description:
    'Exporta un documento del estudio a pdf, docx, xlsx, csv, pptx, html, md o svg. El archivo se verifica (cifras y contenido) antes de entregarse; devuelve el estado y, si está listo, la ruta de acceso.',
  category: 'export',
  effect: 'draft',
  enabledByDefault: true,
  requiredPermission: 'studio.use',
  timeoutMs: 120_000,
  parameters: z.object({
    documentId: documentIdSchema,
    format: z.enum(STUDIO_EXPORT_FORMATS as [string, ...string[]]),
  }),
  summarize: (args) => {
    const a = args as { documentId: string; format: string };
    return `Exportar documento ${a.documentId} a ${a.format.toUpperCase()}`;
  },
  execute: async (actor, args) => {
    const a = args as { documentId: string; format: (typeof STUDIO_EXPORT_FORMATS)[number] };
    const result = await requestExport(actor, a.documentId, a.format);
    return {
      exportId: result.id,
      status: result.status,
      format: result.format,
      fileName: result.fileName,
      verification: result.verification,
      error: result.error,
      accessPath: result.accessPath,
      note:
        result.status === 'ready'
          ? 'Archivo verificado y listo para descargar.'
          : result.status === 'failed'
            ? 'La exportación falló; no se entrega ningún enlace.'
            : 'La exportación sigue en proceso; consulta de nuevo en unos segundos.',
    };
  },
});

registerTool({
  name: 'approveStudioDocument',
  description:
    'Aprueba la versión actual de un documento del estudio (requiere aprobación humana y el permiso studio.approve). Tras aprobar, cualquier cambio de contenido devuelve el documento a borrador.',
  category: 'export',
  effect: 'business_write',
  enabledByDefault: false,
  requiredPermission: 'studio.approve',
  parameters: z.object({ documentId: documentIdSchema }),
  summarize: (args) =>
    `Aprobar la versión actual del documento ${(args as { documentId: string }).documentId}`,
  execute: async (actor, args) => {
    const doc = await approveDocument(actor, (args as { documentId: string }).documentId);
    return {
      ...documentSummary(doc),
      approvedVersionId: doc.approvedVersionId,
      approvedAt: doc.approvedAt,
    };
  },
});
