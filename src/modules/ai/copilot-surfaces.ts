import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { getCopilotMode, type CopilotMode, type CopilotSurfaceKind } from '@/modules/copilot/preferences-service';

/**
 * Copilot surfaces — ONE AI, several places to talk to it.
 *
 * A "surface" is a host conversation the assistant sits next to: an inbox
 * (Bandeja externa) conversation or an internal-chat channel. Each (user,
 * surface) pair owns a regular AiConversation (same orchestrator, tools,
 * approvals, memory, audit) tagged with `context.kind` so the assistant
 * sidebar hides it and the summaries can label it.
 *
 * Automatic analyses are ordinary user turns whose content starts with
 * AUTO_PREFIX; the UI renders them as system events instead of bubbles.
 */

export const COPILOT_KIND_BY_SURFACE: Record<CopilotSurfaceKind, string> = {
  inbox: 'inbox_copilot',
  chat: 'chat_copilot',
};

/** Conversation kinds that live inside their host surface, not in the assistant sidebar. */
export const HIDDEN_CONVERSATION_KINDS: ReadonlySet<string> = new Set(Object.values(COPILOT_KIND_BY_SURFACE));

export const SURFACE_CONTEXT_KEY: Record<CopilotSurfaceKind, string> = {
  inbox: 'commConversationId',
  chat: 'chatChannelId',
};

export const SURFACE_TITLES: Record<CopilotSurfaceKind, string> = {
  inbox: 'Copiloto de bandeja',
  chat: 'Copiloto de chat interno',
};

export const AUTO_PREFIX = '⟦auto:';
export type AutoTrigger = 'open' | 'inbound' | 'action_failed';

export interface AutoTriggerDetail {
  tool?: string;
  error?: string;
}

export function autoTriggerMessage(trigger: AutoTrigger, surface: CopilotSurfaceKind | 'assistant' = 'inbox', detail?: AutoTriggerDetail): string {
  if (trigger === 'action_failed') {
    const tool = detail?.tool ?? 'la acción';
    const error = (detail?.error ?? 'error desconocido').replace(/\s+/g, ' ').slice(0, 600);
    return `${AUTO_PREFIX}action_failed⟧ La acción que el usuario APROBÓ (${tool}) FALLÓ con este error: "${error}". Explica en una línea qué pasó y CORRÍGELO TÚ AHORA: si es un producto/cliente que no coincide, búscalo con las tools y vuelve a proponer la acción corregida; si es un dato inválido (precio 0, unidad, fecha), corrígelo y vuelve a proponer; si es configuración (Zoho, credenciales, permisos), dilo claramente e indica qué debe hacer el administrador. No pidas al usuario que lo haga a mano si tú puedes hacerlo.`;
  }
  if (surface === 'assistant') {
    return trigger === 'open' ? `${AUTO_PREFIX}open⟧ El usuario abrió el asistente.` : `${AUTO_PREFIX}inbound⟧ Hay novedades.`;
  }
  if (surface === 'chat') {
    return trigger === 'open'
      ? `${AUTO_PREFIX}open⟧ ${'El usuario acaba de abrir este canal del chat interno. Revisa lo reciente y sugiere acciones útiles.'}`
      : `${AUTO_PREFIX}inbound⟧ ${'Llegó un mensaje nuevo al canal. Analiza solo lo nuevo y actualiza las acciones sugeridas.'}`;
  }
  return trigger === 'open'
    ? `${AUTO_PREFIX}open⟧ El operador acaba de abrir esta conversación. Analízala y sugiere acciones.`
    : `${AUTO_PREFIX}inbound⟧ El cliente acaba de escribir. Analiza solo lo nuevo y actualiza las acciones sugeridas.`;
}

export function isAutoTurn(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.startsWith(AUTO_PREFIX);
}

export interface SurfaceRef {
  kind: CopilotSurfaceKind;
  /** Host id: inbox conversation id or internal chat channel id. */
  id: string;
}

/**
 * Finds (or creates) the AI thread for this user + surface. The caller MUST
 * have verified the user can see the host conversation/channel beforehand.
 */
export async function getOrCreateSurfaceConversation(
  actor: CurrentUser,
  surface: SurfaceRef
): Promise<{ id: string; created: boolean }> {
  const key = SURFACE_CONTEXT_KEY[surface.kind];
  const existing = await prisma.aiConversation.findFirst({
    where: { userId: actor.id, context: { path: [key], equals: surface.id } },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };
  const created = await prisma.aiConversation.create({
    data: {
      userId: actor.id,
      title: SURFACE_TITLES[surface.kind],
      context: { kind: COPILOT_KIND_BY_SURFACE[surface.kind], [key]: surface.id } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { id: created.id, created: true };
}

/**
 * Decides whether an automatic analysis should run. It is skipped when the
 * copilot thread already has ANY turn after `anchor` (the last message from the
 * other party), so re-opening, duplicate realtime events or a failing provider
 * never loop.
 */
export async function shouldRunAutoTurn(aiConversationId: string, anchor: Date): Promise<boolean> {
  const turnSince = await prisma.aiMessage.findFirst({
    where: { conversationId: aiConversationId, createdAt: { gt: anchor } },
    select: { id: true },
  });
  return !turnSince;
}

export async function getSurfaceMode(userId: string, surface: CopilotSurfaceKind): Promise<CopilotMode> {
  return getCopilotMode(userId, surface);
}

export function relativeTime(iso: string | Date | null | undefined): string {
  if (!iso) return 'sin actividad';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

/** Shared "how to behave inside a side panel" rules for every copilot surface. */
export function buildCopilotPanelRules(opts: { draftTool: string; surfaceNoun: string }): string[] {
  return [
    `1. Un mensaje que empieza con "${AUTO_PREFIX}" es un EVENTO AUTOMÁTICO, no una pregunta: no saludes, no expliques qué eres, no repitas la transcripción. Da una lectura de máximo 3 líneas (qué se necesita, tono/urgencia, qué falta o qué riesgo ves) y LLAMA suggestNextActions con 2 a 5 acciones concretas que puedas ejecutar ahora mismo. Si ya habías analizado y solo llegó un mensaje nuevo, comenta únicamente lo nuevo.`,
    `2. Toda acción sugerida debe ser algo que TÚ puedas hacer con tus tools. Nunca sugieras algo que no puedes hacer.`,
    `3. Para proponer un texto a enviar usa ${opts.draftTool} y escribe TÚ el texto completo. El usuario decide insertarlo en el redactor. NUNCA envíes por tu cuenta: los envíos siempre pasan por aprobación.`,
    `4. Cuando el usuario te dé instrucciones ("dile que…", "pregúntale…", "más formal", "traduce", "resume", "qué respondo") actúa de inmediato con la tool adecuada. Traducciones y resúmenes van directamente en texto. Si te pide algo ambiguo, elige la lectura más probable, dilo en una línea y actúa.`,
    `5. Antes de afirmar cualquier dato comercial (órdenes, saldos, facturas, entregas, cotizaciones) consúltalo con las tools; si no hay coincidencia, dilo con claridad.`,
    `6. Formato: esto es un panel lateral angosto junto a ${opts.surfaceNoun}. Párrafos cortos, listas breves, sin encabezados grandes ni tablas anchas. Máximo ~120 palabras salvo que el usuario pida detalle. Para reportes largos ofrece generar un PDF/Excel.`,
    `7. Nunca inventes mensajes, datos ni acuerdos. Si algo no está en la transcripción o en las tools, no existe.`,
    `8. Tienes el mismo contexto que en el Asistente IA: memoria personal, conversaciones recientes y biblioteca aprobada. Úsalo cuando ayude, sin repetirlo.`,
  ];
}
