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
    knowledgeSourceIds: z.array(z.string()).max(5).optional().describe('Documentos aprobados de la biblioteca (de listAttachableDocuments)'),
  })
  .optional();

type Attachments = z.infer<typeof attachmentsSchema>;

interface DeliveryInput {
  contact: string;
  channel: PreferredChannel;
  body: string;
  attachments?: Attachments;
  templateKey?: string;
}

async function resolveMediaObjectIds(actor: CurrentUser, attachments: Attachments, external: boolean): Promise<{ ids: string[]; labels: string[] }> {
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
    const source = await prisma.knowledgeSource.findUnique({
      where: { id: sourceId },
      select: { id: true, title: true, visibility: true, status: true, currentVersionId: true, versions: { where: { status: 'ready' }, orderBy: { version: 'desc' }, take: 1, select: { id: true, storageObjectId: true } } },
    });
    if (!source || source.status !== 'approved') throw new CommsError(`El documento ${sourceId} no está aprobado en la biblioteca`, 404);
    if (external && source.visibility !== 'publishable') throw new CommsError(`"${source.title}" es interno: no puede enviarse a clientes`, 403);
    const version = source.versions[0];
    if (!version?.storageObjectId) throw new CommsError(`"${source.title}" no tiene archivo adjuntable (es texto o URL)`, 400);
    ids.push(version.storageObjectId);
    labels.push(source.title);
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

  const { text: sharedBody } = await rewriteArtifactLinksForSharing(markdownLinksToPlain(input.body), actor.id);
  const media = await resolveMediaObjectIds(actor, input.attachments, true);

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
    const a = args as { contact: string; channel: string; body: string; attachments?: Attachments };
    const n = (a.attachments?.artifactIds?.length ?? 0) + (a.attachments?.knowledgeSourceIds?.length ?? 0);
    return `Enviar ${a.channel === 'any' ? 'WhatsApp/SMS' : a.channel} a ${a.contact}${n ? ` con ${n} adjunto(s)` : ''}: "${previewText(a.body, 180)}"`;
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
    'Lista documentos aprobados de la biblioteca que se pueden adjuntar a mensajes (catálogos, fichas, listas de precios). Devuelve id, título, etiquetas y si es publicable (enviable a clientes).',
  category: 'knowledge',
  enabledByDefault: true,
  effect: 'read',
  parameters: z.object({
    search: z.string().max(100).optional().describe('Título o etiqueta, ej. "catálogo"'),
    publishableOnly: z.boolean().default(true),
  }),
  execute: async (_actor, rawArgs) => {
    const a = rawArgs as { search?: string; publishableOnly: boolean };
    const term = a.search?.trim().toLowerCase();
    const sources = await prisma.knowledgeSource.findMany({
      where: { status: 'approved', ...(a.publishableOnly ? { visibility: 'publishable' } : {}) },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, description: true, kind: true, visibility: true, tags: true, versions: { where: { status: 'ready' }, orderBy: { version: 'desc' }, take: 1, select: { storageObjectId: true } } },
    });
    const objectIds = sources.map((s) => s.versions[0]?.storageObjectId).filter((id): id is string => Boolean(id));
    const objects = objectIds.length > 0
      ? await prisma.storageObject.findMany({ where: { id: { in: objectIds }, status: 'ready' }, select: { id: true, originalName: true, declaredMimeType: true, sizeBytes: true } })
      : [];
    const objectById = new Map(objects.map((o) => [o.id, o]));
    const docs = sources
      .filter((s) => s.versions[0]?.storageObjectId && objectById.has(s.versions[0].storageObjectId))
      .filter((s) => !term || s.title.toLowerCase().includes(term) || s.tags.some((t) => t.toLowerCase().includes(term)) || (s.description ?? '').toLowerCase().includes(term))
      .map((s) => {
        const object = objectById.get(s.versions[0]!.storageObjectId!)!;
        return {
          knowledgeSourceId: s.id,
          title: s.title,
          description: s.description,
          tags: s.tags,
          visibility: s.visibility,
          fileName: object.originalName,
          mimeType: object.declaredMimeType,
          sizeBytes: Number(object.sizeBytes),
        };
      });
    return { count: docs.length, documents: docs, note: docs.length === 0 ? 'No hay documentos adjuntables. Un administrador puede subirlos en Biblioteca aprobada (marcados como publicables).' : undefined };
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
