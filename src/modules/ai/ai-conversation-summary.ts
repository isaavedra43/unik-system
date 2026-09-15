import { prisma } from '@/lib/prisma';
import { chatCompletion } from './ai-client';
import { modelForTask } from './model-policy';
import { getAiSettings } from './ai-admin-config-service';
import { COPILOT_KIND_BY_SURFACE, isAutoTurn } from './copilot-surfaces';

/**
 * Shared context across every AI surface.
 *
 * After a turn completes, the orchestrator asks this service to refresh a short
 * rolling summary of the conversation (cheap model, throttled). Every new turn —
 * in the assistant, the inbox copilot or the internal-chat copilot — then
 * receives a "Contexto reciente" block listing the user's other recent threads
 * and their summaries, so what was discussed in one place is known everywhere.
 */

const SUMMARY_MAX_CHARS = 600;
const SUMMARY_EVERY_N_MESSAGES = 4;
const RECENT_WINDOW_DAYS = 14;
const RECENT_MAX_THREADS = 8;
const TRANSCRIPT_MAX_CHARS = 9000;

function kindLabel(context: unknown): string {
  const kind = (context as { kind?: string } | null)?.kind;
  if (kind === COPILOT_KIND_BY_SURFACE.inbox) return 'Copiloto en bandeja externa';
  if (kind === COPILOT_KIND_BY_SURFACE.chat) return 'Copiloto en chat interno';
  if (kind === COPILOT_KIND_BY_SURFACE.area) return 'Copiloto de área';
  if (kind === COPILOT_KIND_BY_SURFACE.case) return 'Copiloto de expediente';
  if (kind === COPILOT_KIND_BY_SURFACE.mywork) return 'Copiloto de Mi trabajo';
  if (kind === COPILOT_KIND_BY_SURFACE.control_tower) return 'Copiloto de Control Tower';
  return 'Asistente IA';
}

// Area/case copilot kinds (copilot-surfaces.ts); literal fallback while that map is being extended.
const SURFACE_KINDS = COPILOT_KIND_BY_SURFACE as Record<string, string | undefined>;
const AREA_COPILOT_KIND = SURFACE_KINDS.area ?? 'area_copilot';
const CASE_COPILOT_KIND = SURFACE_KINDS.case ?? 'case_copilot';

async function surfaceLabel(context: unknown): Promise<string | null> {
  const ctx = context as {
    kind?: string;
    commConversationId?: string;
    chatChannelId?: string;
    areaKey?: string;
    caseId?: string;
  } | null;
  if (!ctx) return null;
  try {
    if (ctx.kind === AREA_COPILOT_KIND && ctx.areaKey) {
      const area = await prisma.area.findUnique({ where: { key: ctx.areaKey }, select: { label: true } });
      return area ? `del área ${area.label}` : null;
    }
    if (ctx.kind === CASE_COPILOT_KIND && ctx.caseId) {
      const operationalCase = await prisma.operationalCase.findUnique({
        where: { id: ctx.caseId },
        select: { caseNumber: true, customerName: true },
      });
      if (!operationalCase) return null;
      return `del expediente ${operationalCase.caseNumber}${operationalCase.customerName ? ` (${operationalCase.customerName})` : ''}`;
    }
    if (ctx.kind === COPILOT_KIND_BY_SURFACE.inbox && ctx.commConversationId) {
      const conv = await prisma.commConversation.findUnique({
        where: { id: ctx.commConversationId },
        select: { contact: { select: { displayName: true } } },
      });
      return conv?.contact?.displayName ? `con ${conv.contact.displayName}` : null;
    }
    if (ctx.kind === COPILOT_KIND_BY_SURFACE.chat && ctx.chatChannelId) {
      const channel = await prisma.internalChatChannel.findUnique({
        where: { id: ctx.chatChannelId },
        select: { name: true, type: true, members: { where: { leftAt: null }, select: { user: { select: { name: true } } }, take: 4 } },
      });
      if (!channel) return null;
      if (channel.type === 'group') return `grupo "${channel.name ?? 'sin nombre'}"`;
      if (channel.type === 'area') return `canal de área "${channel.name ?? 'sin nombre'}"`;
      if (channel.type === 'case') return `sala de venta "${channel.name ?? 'sin nombre'}"`;
      return `chat con ${channel.members.map((m) => m.user.name).join(', ')}`;
    }
  } catch {
    /* label is best-effort */
  }
  return null;
}

/**
 * Refreshes the rolling summary when enough new messages accumulated.
 * Fire-and-forget from the orchestrator: never throws.
 */
export async function maybeSummarizeConversation(conversationId: string, userId: string): Promise<void> {
  try {
    const conv = await prisma.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true, summary: true, summaryMessageCount: true, context: true },
    });
    if (!conv) return;
    const total = await prisma.aiMessage.count({
      where: { conversationId, role: { in: ['user', 'assistant'] }, content: { not: null } },
    });
    if (total < 2) return;
    if (conv.summary && total - conv.summaryMessageCount < SUMMARY_EVERY_N_MESSAGES) return;

    const rows = await prisma.aiMessage.findMany({
      where: { conversationId, role: { in: ['user', 'assistant'] }, content: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 24,
      select: { role: true, content: true },
    });
    let transcript = '';
    for (const m of rows.reverse()) {
      const content = (m.content ?? '').trim();
      if (!content) continue;
      const line = `${m.role === 'user' ? (isAutoTurn(content) ? 'Evento' : 'Usuario') : 'Asistente'}: ${content.replace(/\s+/g, ' ').slice(0, 800)}\n`;
      transcript += line;
    }
    if (transcript.length > TRANSCRIPT_MAX_CHARS) transcript = transcript.slice(-TRANSCRIPT_MAX_CHARS);
    if (!transcript.trim()) return;

    const settings = await getAiSettings();
    const result = await chatCompletion({
      model: modelForTask(settings, 'utility'),
      temperature: 0.1,
      maxTokens: 300,
      userId,
      conversationId,
      messages: [
        {
          role: 'system',
          content:
            'Resume en español, en máximo 4 líneas y 600 caracteres, esta conversación entre un usuario de UNIK y su asistente de IA. Incluye: tema principal, datos concretos mencionados (folios, clientes, montos, fechas), decisiones tomadas y pendientes abiertos. Sin saludos ni introducción. Si hay un resumen previo, intégralo con lo nuevo.',
        },
        {
          role: 'user',
          content: `${conv.summary ? `Resumen previo: ${conv.summary}\n\n` : ''}Conversación (${kindLabel(conv.context)}):\n${transcript}`,
        },
      ],
    });
    const summary = (result.content ?? '').trim().slice(0, SUMMARY_MAX_CHARS);
    if (!summary) return;
    await prisma.aiConversation.update({
      where: { id: conversationId },
      data: { summary, summaryUpdatedAt: new Date(), summaryMessageCount: total },
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'ai.summary.failed', conversationId, message: error instanceof Error ? error.message : 'unknown' }));
  }
}

/**
 * Prompt block with the user's other recent threads (any surface) so the
 * assistant carries the same context everywhere. Returns '' when there is
 * nothing worth injecting.
 */
export async function buildRecentContextPrompt(userId: string, currentConversationId?: string | null): Promise<string> {
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 86_400_000);
  const rows = await prisma.aiConversation.findMany({
    where: {
      userId,
      updatedAt: { gte: since },
      ...(currentConversationId ? { id: { not: currentConversationId } } : {}),
      OR: [{ summary: { not: null } }, { messages: { some: { role: 'user' } } }],
    },
    orderBy: { updatedAt: 'desc' },
    take: RECENT_MAX_THREADS * 2,
    select: {
      id: true,
      title: true,
      summary: true,
      context: true,
      updatedAt: true,
      messages: {
        where: { role: { in: ['user', 'assistant'] }, content: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 2,
        select: { role: true, content: true },
      },
    },
  });
  if (rows.length === 0) return '';

  const lines: string[] = [];
  let count = 0;
  for (const row of rows) {
    if (count >= RECENT_MAX_THREADS) break;
    let gist = row.summary?.trim() ?? '';
    if (!gist) {
      const last = row.messages
        .filter((m) => m.content && !isAutoTurn(m.content))
        .reverse()
        .map((m) => `${m.role === 'user' ? 'U' : 'A'}: ${(m.content ?? '').replace(/\s+/g, ' ').slice(0, 160)}`)
        .join(' · ');
      gist = last;
    }
    if (!gist) continue;
    const where = await surfaceLabel(row.context);
    const when = row.updatedAt.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    lines.push(`- [${kindLabel(row.context)}${where ? ` ${where}` : ''} · ${when}] ${row.title !== 'Nueva conversación' ? `"${row.title}": ` : ''}${gist}`);
    count += 1;
  }
  if (lines.length === 0) return '';
  return [
    '## Contexto reciente del usuario (otras conversaciones contigo, en cualquier superficie)',
    'Úsalo para dar continuidad ("como vimos ayer…", retomar pendientes, no volver a preguntar lo que ya se dijo). No lo repitas si no viene al caso y nunca lo presentes como dato verificado del sistema: verifica con tools antes de afirmar cifras.',
    ...lines,
  ].join('\n');
}

/** Lightweight info for the current thread itself (own summary), used when history is truncated. */
export async function getOwnSummary(conversationId: string): Promise<string | null> {
  const row = await prisma.aiConversation.findUnique({ where: { id: conversationId }, select: { summary: true } });
  return row?.summary ?? null;
}
