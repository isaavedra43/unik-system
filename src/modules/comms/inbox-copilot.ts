import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { CommsError } from './comms-errors';
import { getConversation, listInboxUsers, listNotes, transcriptFor } from './comms-service';
import { buildTranscript } from './comms-ai';
import { listCommitments } from './commitments-service';
import { getPreferences, type InboxCopilotMode } from '@/modules/copilot/preferences-service';

/**
 * Inbox copilot: a per-user AI thread attached to ONE inbox conversation.
 * The thread is a regular AiConversation (so the orchestrator, tools,
 * approvals and audit all apply) tagged with `context.kind = 'inbox_copilot'`.
 * Automatic analyses are ordinary user turns whose content starts with
 * AUTO_PREFIX; the UI renders them as system events instead of bubbles.
 */

export const INBOX_COPILOT_KIND = 'inbox_copilot';
export const AUTO_PREFIX = '⟦auto:';

export type AutoTrigger = 'open' | 'inbound';

export function autoTriggerMessage(trigger: AutoTrigger): string {
  return trigger === 'open'
    ? `${AUTO_PREFIX}open⟧ El operador acaba de abrir esta conversación. Analízala y sugiere acciones.`
    : `${AUTO_PREFIX}inbound⟧ El cliente acaba de escribir. Analiza solo lo nuevo y actualiza las acciones sugeridas.`;
}

export function isAutoTurn(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.startsWith(AUTO_PREFIX);
}

export async function getOrCreateCopilotConversation(
  actor: CurrentUser,
  inboxConversationId: string
): Promise<{ id: string; created: boolean }> {
  // Visibility check (throws 404 when the user cannot see the conversation).
  await getConversation(actor, inboxConversationId);
  const existing = await prisma.aiConversation.findFirst({
    where: {
      userId: actor.id,
      context: { path: ['commConversationId'], equals: inboxConversationId },
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  const created = await prisma.aiConversation.create({
    data: {
      userId: actor.id,
      title: 'Copiloto de bandeja',
      context: {
        kind: INBOX_COPILOT_KIND,
        commConversationId: inboxConversationId,
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

export async function getInboxCopilotMode(userId: string): Promise<InboxCopilotMode> {
  const prefs = await getPreferences(userId).catch(() => null);
  return prefs?.inboxCopilotMode ?? 'active';
}

/**
 * Decides whether an automatic analysis should run. It is skipped when the
 * copilot thread already has ANY turn after the customer's last message
 * (a reply, or an automatic turn that failed), so re-opening a conversation,
 * duplicate realtime events or a misconfigured provider never loop.
 */
export async function shouldRunAutoAnalysis(
  aiConversationId: string,
  inboxConversationId: string
): Promise<boolean> {
  const conversation = await prisma.commConversation.findUnique({
    where: { id: inboxConversationId },
    select: { lastMessageAt: true, createdAt: true },
  });
  if (!conversation) throw new CommsError('Conversación no encontrada', 404);
  const lastInbound = await prisma.commMessage.findFirst({
    where: { conversationId: inboxConversationId, direction: 'inbound' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const anchor = lastInbound?.createdAt ?? conversation.lastMessageAt ?? conversation.createdAt;
  const turnSince = await prisma.aiMessage.findFirst({
    where: { conversationId: aiConversationId, createdAt: { gt: anchor } },
    select: { id: true },
  });
  return !turnSince;
}

function relativeTime(iso: string | Date | null): string {
  if (!iso) return 'sin actividad';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

const PROVIDER_NAMES: Record<string, string> = {
  twilio_whatsapp: 'WhatsApp',
  twilio_sms: 'SMS',
  telegram: 'Telegram',
};

const STATUS_NAMES: Record<string, string> = {
  open: 'abierta',
  pending: 'pendiente',
  snoozed: 'pospuesta',
  resolved: 'resuelta',
};

/**
 * System prompt block appended when the assistant runs inside the inbox.
 * Everything the copilot needs to act without extra round-trips: contact,
 * channel, state, transcript, internal notes, commitments and the team.
 */
export async function buildInboxCopilotPrompt(
  actor: CurrentUser,
  inboxConversationId: string
): Promise<string> {
  const conversation = await getConversation(actor, inboxConversationId);
  const contact = conversation.contact;
  const [transcript, notes, contactCommitments, users, mode] = await Promise.all([
    transcriptFor(inboxConversationId, 30),
    listNotes(actor, inboxConversationId).catch(() => []),
    listCommitments(actor, { contactId: contact.id, limit: 20 }).catch(() => []),
    listInboxUsers(actor).catch(() => []),
    getInboxCopilotMode(actor.id),
  ]);
  const transcriptText = transcript.messages.length
    ? buildTranscript(transcript.messages, contact.displayName)
    : '(sin mensajes todavía)';
  const identity = [
    contact.phone ? `tel ${contact.phone}` : null,
    contact.telegramId ? `telegram ${contact.telegramId}` : null,
    contact.email ? `email ${contact.email}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines: string[] = [];
  lines.push('## MODO COPILOTO DE BANDEJA — contexto activo');
  lines.push(
    `Estás trabajando codo a codo con ${actor.name} dentro de UNA conversación de la bandeja omnicanal de UNIK. Eres su colaborador en tiempo real: lees la conversación, entiendes qué necesita el cliente, propones cómo responder y ejecutas tareas del sistema cuando te lo piden. Modo elegido por el usuario: ${
      mode === 'active' ? 'ACTIVO (analizas por tu cuenta al abrir y cuando el cliente escribe)' : 'A PETICIÓN (solo actúas cuando el usuario te habla)'
    }.`
  );
  lines.push('');
  lines.push('### Conversación actual');
  lines.push(`- inboxConversationId: ${conversation.id}  ← usa ESTE id en las tools de bandeja (no el de este chat)`);
  lines.push(
    `- Canal: ${PROVIDER_NAMES[conversation.account.provider] ?? conversation.account.provider} · cuenta "${conversation.account.label}" (${conversation.account.identifier})`
  );
  lines.push(
    `- Contacto: ${contact.displayName}${identity ? ` · ${identity}` : ''} · ${
      contact.zohoContactId
        ? `vinculado a Zoho (zohoContactId ${contact.zohoContactId}; usa getContactFile con ese id para su expediente)`
        : 'NO vinculado a Zoho (búscalo por nombre/teléfono con queryContacts o getContactFile antes de afirmar datos comerciales)'
    }`
  );
  lines.push(
    `- Estado: ${STATUS_NAMES[conversation.status] ?? conversation.status} · Prioridad: ${conversation.priority} · Asignada a: ${conversation.assignedToName ?? 'nadie'} · Etiquetas: ${conversation.tags.length ? conversation.tags.join(', ') : 'ninguna'}${conversation.subject ? ` · Asunto: ${conversation.subject}` : ''}`
  );
  lines.push(`- Último mensaje del cliente: ${relativeTime(conversation.lastInboundAt)} · Sin leer: ${conversation.unreadCount}`);
  lines.push('');
  lines.push('### Transcripción (los últimos 30 mensajes; "Agente" = tu equipo)');
  lines.push(transcriptText);
  lines.push('');
  lines.push(`### Notas internas (${notes.length})`);
  lines.push(
    notes.length
      ? notes.slice(-8).map((n) => `- [${n.createdAt.slice(0, 16).replace('T', ' ')}] ${n.authorName ?? 'Equipo'}: ${n.body.slice(0, 300)}`).join('\n')
      : '- ninguna'
  );
  lines.push('');
  lines.push(`### Compromisos con este contacto (${contactCommitments.length})`);
  lines.push(
    contactCommitments.length
      ? contactCommitments
          .map((c) => `- (${c.status}${c.dueAt ? `, vence ${c.dueAt.slice(0, 16).replace('T', ' ')}` : ''}) ${c.description} — responsable ${c.ownerName ?? '—'} [id ${c.id}]`)
          .join('\n')
      : '- ninguno'
  );
  lines.push('');
  lines.push('### Equipo disponible para asignar (nombre → userId)');
  lines.push(users.length ? users.map((u) => `- ${u.name} → ${u.id}`).join('\n') : '- (sin otros usuarios)');
  lines.push(`- Usuario actual: ${actor.name} → ${actor.id}`);
  lines.push('');
  lines.push('### Cómo trabajar aquí');
  lines.push(
    `1. Un mensaje que empieza con "${AUTO_PREFIX}" es un EVENTO AUTOMÁTICO, no una pregunta: no saludes, no expliques qué eres, no repitas la transcripción. Da una lectura de máximo 3 líneas (qué quiere el cliente, tono/urgencia, qué falta o qué riesgo ves) y LLAMA suggestNextActions con 2 a 5 acciones concretas que puedas ejecutar ahora mismo. Si ya habías analizado y solo llegó un mensaje nuevo, comenta únicamente lo nuevo.`
  );
  lines.push(
    '2. Toda acción sugerida debe ser algo que TÚ puedas hacer con tus tools: redactar la respuesta (proposeInboxDraft), registrar un compromiso (createCommitment), cambiar estado/prioridad/asignación/etiquetas (updateInboxConversation), dejar una nota interna (addInboxNote), consultar el expediente en Zoho (getContactFile), revisar órdenes/facturas/pagos/paquetes, buscar en la biblioteca aprobada (searchKnowledgeLibrary) o preparar el envío (sendInboxMessage, requiere aprobación). Nunca sugieras algo que no puedes hacer.'
  );
  lines.push(
    '3. Para proponer una respuesta al cliente usa proposeInboxDraft y escribe TÚ el texto: breve, cordial, en el idioma y tono del cliente, sin prometer precios, plazos o existencias que no consten en el sistema. El usuario decide insertarla en el redactor. NUNCA envíes por tu cuenta: sendInboxMessage solo si el usuario pide explícitamente enviar, y siempre pasa por aprobación.'
  );
  lines.push(
    '4. Cuando el usuario te dé instrucciones ("dile que…", "pregúntale…", "más formal", "traduce", "resume", "qué le respondo") actúa de inmediato con la tool adecuada. Traducciones y resúmenes van directamente en texto. Si te pide algo ambiguo, elige la lectura más probable, dilo en una línea y actúa.'
  );
  lines.push(
    '5. Antes de afirmar cualquier dato comercial del contacto (órdenes, saldos, facturas, entregas) consúltalo con getContactFile o las tools de consulta; si no está vinculado a Zoho o no hay coincidencia, dilo con claridad.'
  );
  lines.push(
    '6. Formato: esto es un panel lateral angosto. Párrafos cortos, listas breves, sin encabezados grandes ni tablas anchas. Máximo ~120 palabras salvo que el usuario pida detalle.'
  );
  lines.push('7. Nunca inventes mensajes del cliente, datos ni acuerdos. Si algo no está en la transcripción o en las tools, no existe.');
  return lines.join('\n');
}
