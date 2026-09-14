import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool, type ToolExecutionContext } from './registry';
import type { CurrentUser } from '@/modules/auth/authorization';
import { getAiSettings } from '../ai-admin-config-service';
import { markdownLinksToPlain, rewriteArtifactLinksForSharing, shareArtifact } from '../artifact-share';
import { protectArtifact } from '../ai-artifacts-service';
import { previewText } from '@/modules/comms/normalize';
import { channelLabel, pickConversationForContact, resolveContact, type PreferredChannel } from '@/modules/comms/contact-resolver';
import { sendOutboundMessage, startConversation } from '@/modules/comms/comms-service';
import { CommsError } from '@/modules/comms/comms-errors';
import { extractArtifactIdsFromLinks, formatForCustomerChannel, stripArtifactLinks } from '../customer-message-format';
import { findShareableDocuments, listShareableDocuments, resolveApprovedDocumentFile } from '@/modules/copilot/knowledge-service';

/**
 * Messaging tools: WhatsApp / SMS to any contact (by name or phone), bulk
 * sends with a delivery report, attachable approved documents (catalogs),
 * share links for generated reports, pickup location and follow-ups.
 * Every external send is `external_send` → approval card first.
 */

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

const attachmentsSchema = z
  .object({
    artifactIds: z.array(z.string()).max(5).optional().describe('Reportes/PDFs generados en este chat (artifactId)'),
    knowledgeSourceIds: z.array(z.string()).max(5).optional().describe('Documentos aprobados de la biblioteca (knowledgeSourceId de findShareableDocument o listAttachableDocuments)'),
  })
  .optional();

export type Attachments = z.infer<typeof attachmentsSchema>;

interface DeliveryInput {
  contact: string;
  channel: PreferredChannel;
  body: string;
  attachments?: Attachments;
  templateKey?: string;
  /** The user explicitly asked to share stock/internal figures. */
  keepInternalData?: boolean;
}

/**
 * Customer-facing body: WhatsApp formatting, real signature, no internal data,
 * and every report the model linked becomes a REAL attachment (the customer
 * must see the document, never a bare link).
 */
const QUOTE_LINK_RE = /https?:\/\/[^\s)]+?\/app\/quotes\/([a-z0-9]+)[^\s)]*|\/app\/quotes\/([a-z0-9]+)[^\s)]*/gi;

export async function prepareCustomerMessage(
  actor: CurrentUser,
  body: string,
  attachments: Attachments,
  options: { keepInternalData?: boolean; aiConversationId?: string } = {}
): Promise<{ body: string; attachments: Attachments; autoAttached: string[] }> {
  const settings = await getAiSettings().catch(() => null);
  const known = new Set(attachments?.artifactIds ?? []);
  const autoAttached: string[] = [];
  // Internal quote pages (/app/quotes/<id>) need a login: the customer gets the official Zoho PDF instead.
  const quoteIds = [...new Set([...body.matchAll(QUOTE_LINK_RE)].map((m) => m[1] ?? m[2]).filter(Boolean))];
  if (quoteIds.length > 0) {
    const { ensureQuotePdfArtifact } = await import('./quotes-tools');
    for (const quoteId of quoteIds) {
      try {
        const pdf = await ensureQuotePdfArtifact(actor, quoteId, options.aiConversationId);
        if (pdf) {
          known.add(pdf.artifactId);
          autoAttached.push(pdf.artifactId);
        }
      } catch (err) {
        console.warn(JSON.stringify({ event: 'ai.message.quote_pdf_failed', quoteId, message: err instanceof Error ? err.message : 'unknown' }));
      }
    }
    body = body.replace(QUOTE_LINK_RE, '').replace(/(revisarla|verla|consultarla|descargarla)\s+en\s+el\s+siguiente\s+enlace\s*:?/gi, 'verla en el PDF adjunto').replace(/[ \t]{2,}/g, ' ');
  }
  const linked = extractArtifactIdsFromLinks(body);
  for (const id of linked) {
    if (known.has(id)) continue;
    const artifact = await prisma.aiArtifact.findFirst({ where: { id, conversation: { userId: actor.id } }, select: { id: true, storageObjectId: true } });
    if (artifact?.storageObjectId) {
      known.add(id);
      autoAttached.push(id);
    }
  }
  let text = autoAttached.length > 0 || (attachments?.artifactIds?.length ?? 0) > 0 ? stripArtifactLinks(body) : body;
  const formatted = formatForCustomerChannel(text, { senderName: actor.name, companyName: settings?.companyName ?? null, keepInternalData: options.keepInternalData });
  text = formatted.text;
  const merged: Attachments = { ...(attachments ?? {}), artifactIds: known.size > 0 ? [...known] : attachments?.artifactIds };
  if (!merged.artifactIds?.length) delete merged.artifactIds;
  if (!merged.knowledgeSourceIds?.length) delete merged.knowledgeSourceIds;
  return { body: text, attachments: Object.keys(merged).length > 0 ? merged : undefined, autoAttached };
}

export async function resolveMediaObjectIds(actor: CurrentUser, attachments: Attachments, external: boolean): Promise<{ ids: string[]; labels: string[] }> {
  const ids: string[] = [];
  const labels: string[] = [];
  for (const artifactId of attachments?.artifactIds ?? []) {
    const artifact = await prisma.aiArtifact.findUnique({
      where: { id: artifactId },
      select: { id: true, storageObjectId: true, meta: true, conversation: { select: { userId: true } } },
    });
    if (!artifact || artifact.conversation.userId !== actor.id) throw new CommsError(`El reporte ${artifactId} no existe o no es tuyo`, 404);
    if (!artifact.storageObjectId) throw new CommsError('Ese artefacto no es un archivo adjuntable (tabla/gráfica en línea). Genera un PDF o Excel.', 400);
    await protectArtifact(artifact.id, true);
    ids.push(artifact.storageObjectId);
    labels.push(String((artifact.meta as Record<string, unknown> | null)?.title ?? 'Reporte'));
  }
  for (const sourceId of attachments?.knowledgeSourceIds ?? []) {
    // Always the APPROVED current version: a newer upload still under review is never sent.
    const doc = await resolveApprovedDocumentFile(sourceId);
    if (!doc || doc.status !== 'approved') throw new CommsError(`El documento ${sourceId} no está aprobado en la biblioteca`, 404);
    if (doc.expired) throw new CommsError(`"${doc.title}" está vencido: actualízalo en la biblioteca antes de enviarlo`, 409);
    if (external && doc.visibility !== 'publishable') throw new CommsError(`"${doc.title}" es interno: no puede enviarse a clientes`, 403);
    if (!doc.storageObjectId) throw new CommsError(`"${doc.title}" no tiene archivo adjuntable (es texto o URL)`, 400);
    ids.push(doc.storageObjectId);
    labels.push(doc.title);
  }
  return { ids, labels };
}

/** Shared delivery path: resolve → conversation → attachments → send. */
export async function deliverToContact(actor: CurrentUser, input: DeliveryInput, ctx: ToolExecutionContext) {
  const contact = await resolveContact(input.contact);
  if (!contact.phone && input.channel !== 'telegram') throw new CommsError(`${contact.displayName} no tiene teléfono registrado`, 400);
  const target = await pickConversationForContact(actor, contact, input.channel);

  let conversationId = target.conversationId;
  if (!conversationId) {
    const started = await startConversation(actor, { accountId: target.accountId, to: contact.phone ?? '', contactName: contact.displayName });
    conversationId = started.conversation.id;
  }

  const prepared = await prepareCustomerMessage(actor, input.body, input.attachments, { keepInternalData: input.keepInternalData, aiConversationId: ctx.conversationId });
  const { text: sharedBody } = await rewriteArtifactLinksForSharing(markdownLinksToPlain(prepared.body), actor.id);
  const media = await resolveMediaObjectIds(actor, prepared.attachments, true);

  const message = await sendOutboundMessage({
    accountId: target.accountId,
    conversationId,
    body: sharedBody,
    mediaObjectIds: media.ids,
    sentByUserId: actor.id,
    proposalId: ctx.approvedProposalId ?? null,
    templateKey: input.templateKey,
    actor,
  });

  const windowClosed =
    target.provider === 'twilio_whatsapp' && (!target.lastInboundAt || Date.now() - target.lastInboundAt.getTime() > WHATSAPP_WINDOW_MS) && !input.templateKey;
  return {
    to: contact.displayName,
    phone: contact.phone,
    channel: channelLabel(target.provider),
    conversationId,
    messageId: message.id,
    status: message.status,
    uncertain: message.uncertain,
    error: message.error,
    attachments: media.labels,
    warning: windowClosed
      ? 'El cliente no ha escrito en las últimas 24 h: WhatsApp puede rechazar mensajes libres; si falla, usa una plantilla aprobada (templateKey).'
      : undefined,
    inboxUrl: `/app/inbox?conversation=${conversationId}`,
  };
}

const channelSchema = z.enum(['whatsapp', 'sms', 'telegram', 'any']).default('any');

registerTool({
  name: 'sendMessageToContact',
  description:
    'Envía un WhatsApp/SMS a un contacto (por nombre, teléfono o id) con texto y, opcionalmente, reportes generados o documentos aprobados adjuntos. Crea la conversación en la bandeja si no existe. Requiere aprobación del usuario.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'external_send',
  contextTags: ['all'],
  parameters: z.object({
    contact: z.string().min(1).describe('Nombre, teléfono (+52…) o id del contacto'),
    channel: channelSchema,
    body: z.string().min(1).max(4000).describe('Texto final. Usa las URLs exactas que te dieron las tools; no inventes enlaces.'),
    attachments: attachmentsSchema,
    templateKey: z.string().optional().describe('Plantilla aprobada de WhatsApp cuando el cliente no ha escrito en 24 h'),
  }),
  summarize: (args) => {
    const a = args as { _contactName?: string; contact: string; channel: string; body: string; attachments?: Attachments };
    const n = (a.attachments?.artifactIds?.length ?? 0) + (a.attachments?.knowledgeSourceIds?.length ?? 0);
    return `Enviar ${a.channel === 'any' ? 'WhatsApp/SMS' : a.channel} a ${a._contactName ?? a.contact}${n ? ` con ${n} adjunto(s)` : ''}: "${previewText(a.body, 180)}"`;
  },
  // Who exactly? Resolved before the approval card; an ambiguous name is refused so the model asks the user.
  prepareArgs: async (_actor, rawArgs) => {
    const a = rawArgs as { contact: string };
    try {
      const contact = await resolveContact(a.contact);
      return { args: { ...a, contact: contact.commContactId ?? a.contact, _contactName: contact.displayName } };
    } catch (err) {
      return { error: `${err instanceof Error ? err.message : 'Contacto no encontrado'} Pregunta al usuario a cuál se refiere antes de proponer la acción.` };
    }
  },
  execute: async (actor, rawArgs, ctx) => {
    const a = rawArgs as z.infer<typeof messageArgs>;
    return deliverToContact(actor, a, ctx);
  },
});
const messageArgs = z.object({ contact: z.string(), channel: channelSchema, body: z.string(), attachments: attachmentsSchema, templateKey: z.string().optional() });

registerTool({
  name: 'sendBulkMessages',
  description:
    'Envía varios mensajes (misma o distinta información) a varios contactos en una sola aprobación y devuelve un reporte de a quién se envió y qué falló. Máximo 50 destinatarios.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'external_send',
  contextTags: ['all'],
  parameters: z.object({
    channel: channelSchema,
    recipients: z
      .array(
        z.object({
          contact: z.string().min(1),
          body: z.string().min(1).max(4000),
          attachments: attachmentsSchema,
          templateKey: z.string().optional(),
        })
      )
      .min(1)
      .max(50),
  }),
  summarize: (args) => {
    const a = args as { channel: string; recipients: Array<{ contact: string; body: string }> };
    const names = a.recipients.map((r) => r.contact).slice(0, 6).join(', ');
    return `Enviar ${a.recipients.length} mensaje(s) por ${a.channel === 'any' ? 'WhatsApp/SMS' : a.channel} a: ${names}${a.recipients.length > 6 ? '…' : ''}. Primer mensaje: "${previewText(a.recipients[0]?.body ?? '', 120)}"`;
  },
  execute: async (actor, rawArgs, ctx) => {
    const a = rawArgs as { channel: PreferredChannel; recipients: Array<{ contact: string; body: string; attachments?: Attachments; templateKey?: string }> };
    const results: Array<Record<string, unknown>> = [];
    let sent = 0;
    let failed = 0;
    for (const r of a.recipients) {
      try {
        const res = await deliverToContact(actor, { contact: r.contact, channel: a.channel, body: r.body, attachments: r.attachments, templateKey: r.templateKey }, ctx);
        results.push({ contact: r.contact, ok: !res.error, ...res });
        if (res.error) failed += 1; else sent += 1;
      } catch (error) {
        failed += 1;
        results.push({ contact: r.contact, ok: false, error: error instanceof Error ? error.message : 'Error desconocido' });
      }
    }
    return { requested: a.recipients.length, sent, failed, results, note: 'Presenta al usuario el reporte: a quién se envió, qué falló y por qué.' };
  },
});

registerTool({
  name: 'listAttachableDocuments',
  description:
    'Lista documentos aprobados y vigentes de la biblioteca que se pueden adjuntar a mensajes (catálogos, promociones, fichas, listas de precios). Devuelve knowledgeSourceId, título, categoría, etiquetas, "cuándo usarlo" y si es publicable (enviable a clientes). Si el usuario pide un archivo concreto ("mándale el PDF de promociones") usa findShareableDocument.',
  category: 'knowledge',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    search: z.string().max(100).optional().describe('Título, etiqueta o tema, ej. "catálogo"'),
    publishableOnly: z.boolean().default(true),
  }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { search?: string; publishableOnly: boolean };
    const docs = await listShareableDocuments({ includeInternal: !a.publishableOnly, search: a.search });
    return {
      count: docs.length,
      documents: docs,
      note:
        docs.length === 0
          ? 'No hay documentos adjuntables que coincidan. Un administrador puede subirlos en Biblioteca aprobada (publicables y aprobados).'
          : undefined,
    };
  },
});

registerTool({
  name: 'findShareableDocument',
  description:
    'Elige EL archivo autorizado para enviar cuando el usuario lo pide por nombre o tema ("mándale el PDF de promociones al cliente", "pásale el catálogo"). Solo considera documentos de la biblioteca aprobados, publicables y vigentes, siempre en su versión aprobada. Devuelve decision (single | ambiguous | none), los candidatos con knowledgeSourceId y la instrucción a seguir. Úsala ANTES de preparar el envío.',
  category: 'knowledge',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    request: z.string().min(2).max(200).describe('Qué archivo pidió el usuario, con sus palabras. Ej: "pdf de promociones"'),
    limit: z.number().int().min(1).max(5).default(3),
  }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { request: string; limit: number };
    return findShareableDocuments(a.request, a.limit);
  },
});

registerTool({
  name: 'shareArtifact',
  description:
    'Genera un enlace público firmado (90 días) para un reporte/PDF generado, para compartirlo con alguien que no es el dueño del chat (compañeros o clientes). El archivo queda protegido contra limpieza.',
  category: 'export',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({ artifactId: z.string().min(1), ttlDays: z.number().int().min(1).max(365).default(90) }),
  execute: async (actor, rawArgs) => {
    const a = rawArgs as { artifactId: string; ttlDays: number };
    const link = await shareArtifact(a.artifactId, actor.id, a.ttlDays);
    if (!link) return { error: 'Artefacto no encontrado, no es tuyo o no es un archivo descargable' };
    return { ...link, note: 'Usa esta URL EXACTA en el mensaje; no la modifiques ni inventes otra.' };
  },
});

registerTool({
  name: 'getPickupLocation',
  description:
    'Devuelve la ubicación de la bodega/sucursal para recoger pedidos: dirección, enlace de Google Maps, horario e instrucciones. Úsalo cuando el cliente vaya a recoger o pida la ubicación.',
  category: 'system',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({}),
  execute: async () => {
    const s = await getAiSettings();
    const address = s.warehouseAddress?.trim();
    const mapsUrl = s.warehouseMapsUrl?.trim() || (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '');
    if (!address && !mapsUrl) {
      return { configured: false, note: 'La dirección de la bodega no está configurada. Un administrador puede capturarla en Administración → Asistente IA → Configuración (Perfil de la empresa).' };
    }
    return {
      configured: true,
      companyName: s.companyName || 'UNIK',
      address,
      mapsUrl,
      hours: s.warehouseHours || null,
      instructions: s.pickupInstructions || null,
      phone: s.companyPhone || null,
      note: 'Incluye la dirección y el enlace de Maps tal cual en el mensaje al cliente.',
    };
  },
});

registerTool({
  name: 'scheduleFollowUp',
  description:
    'Programa un seguimiento (compromiso con fecha) para el usuario: "recordarme llamar a X el viernes", "dar seguimiento a la cotización en 3 días". Aparece en sus compromisos y notificaciones.',
  category: 'communication',
  requiredPermission: 'inbox.use',
  enabledByDefault: true,
  effect: 'internal_task',
  parameters: z.object({
    description: z.string().min(3).max(500),
    dueAt: z.string().datetime().describe('Fecha/hora ISO del seguimiento'),
    contact: z.string().optional().describe('Contacto relacionado (nombre/teléfono)'),
    ownerUserId: z.string().optional().describe('Otro usuario responsable (por defecto, el usuario actual)'),
  }),
  summarize: (args) => `Programar seguimiento: ${(args as { description: string }).description}`,
  execute: async (actor, rawArgs) => {
    const a = rawArgs as { description: string; dueAt: string; contact?: string; ownerUserId?: string };
    const { createCommitment } = await import('@/modules/comms/commitments-service');
    let contactId: string | null = null;
    if (a.contact) {
      const c = await resolveContact(a.contact).catch(() => null);
      contactId = c?.commContactId ?? null;
    }
    const row = await createCommitment(actor, { description: a.description, dueAt: a.dueAt, contactId, sourceType: 'manual', ownerUserId: a.ownerUserId });
    return { commitmentId: row.id, dueAt: row.dueAt, description: row.description, owner: row.ownerName ?? actor.name };
  },
});
