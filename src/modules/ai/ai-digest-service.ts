import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getActiveProvider } from './providers';
import { getAiSettings } from './ai-admin-config-service';

/**
 * Per-user daily work digest: what the person did across UNIK (assistant,
 * inbox, internal chat, quotes, calls, sales as salesperson, commitments) with
 * KPIs and a short narrative. Stored in AiUserDigest so the assistant can
 * answer "¿cómo voy hoy?" / "¿qué hizo X ayer?" and managers get context.
 */

export interface DigestMetrics {
  aiTurns: number;
  toolCalls: number;
  proposalsApproved: number;
  proposalsRejected: number;
  reportsGenerated: number;
  inboxMessagesSent: number;
  inboxConversationsTouched: number;
  chatMessagesSent: number;
  quotesCreated: number;
  quotesTotal: number;
  callsMade: number;
  commitmentsCreated: number;
  commitmentsCompleted: number;
  commitmentsOverdue: number;
  salesOrdersAsSalesperson: number;
  salesTotalAsSalesperson: number;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}

export interface UserDigest {
  metrics: DigestMetrics;
  narrative: string;
  kpis: Array<{ label: string; value: string }>;
  computedAt: string;
}

function dayRange(date: string): { from: Date; to: Date; day: Date } {
  const [y, m, d] = date.split('-').map(Number);
  // Mexico City is UTC-6; a "day" for digests is the local day.
  const from = new Date(Date.UTC(y, m - 1, d, 6, 0, 0));
  const to = new Date(from.getTime() + 86_400_000 - 1);
  return { from, to, day: new Date(Date.UTC(y, m - 1, d)) };
}

function n(v: Prisma.Decimal | null | undefined): number {
  return v ? Number(v.toString()) || 0 : 0;
}

function money(v: number): string {
  return `$${v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function computeMetrics(userId: string, date: string): Promise<DigestMetrics> {
  const { from, to } = dayRange(date);
  const range = { gte: from, lte: to };
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const [aiTurns, toolCalls, approved, rejected, reports, inboxSent, chatSent, quotes, calls, commitmentsCreated, commitmentsCompleted, overdue, sales] = await Promise.all([
    prisma.aiMessage.count({ where: { role: 'user', createdAt: range, conversation: { userId } } }),
    prisma.aiToolCall.count({ where: { createdAt: range, message: { conversation: { userId } } } }),
    prisma.aiProposal.count({ where: { decisionBy: userId, decidedAt: range, status: { in: ['approved', 'executed', 'pending_review'] } } }),
    prisma.aiProposal.count({ where: { decisionBy: userId, decidedAt: range, status: 'rejected' } }),
    prisma.aiArtifact.count({ where: { createdAt: range, conversation: { userId }, type: { in: ['pdf', 'xlsx', 'docx', 'csv'] } } }),
    prisma.commMessage.findMany({ where: { sentByUserId: userId, direction: 'outbound', createdAt: range }, select: { conversationId: true, createdAt: true } }),
    prisma.internalChatMessage.findMany({ where: { senderId: userId, createdAt: range, deletedAt: null }, select: { createdAt: true } }),
    prisma.quote.findMany({ where: { createdByUserId: userId, createdAt: range }, select: { total: true } }),
    prisma.voiceCall.count({ where: { initiatedByUserId: userId, createdAt: range } }),
    prisma.commitment.count({ where: { ownerUserId: userId, createdAt: range } }),
    prisma.commitment.count({ where: { ownerUserId: userId, completedAt: range } }),
    prisma.commitment.count({ where: { ownerUserId: userId, status: 'pending', dueAt: { lt: to } } }),
    user?.name
      ? prisma.salesOrder.findMany({ where: { salespersonName: { equals: user.name, mode: 'insensitive' }, orderDate: range }, select: { total: true } })
      : Promise.resolve([] as Array<{ total: Prisma.Decimal | null }>),
  ]);
  const times = [...inboxSent.map((m) => m.createdAt.getTime()), ...chatSent.map((m) => m.createdAt.getTime())];
  return {
    aiTurns,
    toolCalls,
    proposalsApproved: approved,
    proposalsRejected: rejected,
    reportsGenerated: reports,
    inboxMessagesSent: inboxSent.length,
    inboxConversationsTouched: new Set(inboxSent.map((m) => m.conversationId)).size,
    chatMessagesSent: chatSent.length,
    quotesCreated: quotes.length,
    quotesTotal: Math.round(quotes.reduce((s, q) => s + n(q.total), 0) * 100) / 100,
    callsMade: calls,
    commitmentsCreated,
    commitmentsCompleted,
    commitmentsOverdue: overdue,
    salesOrdersAsSalesperson: sales.length,
    salesTotalAsSalesperson: Math.round(sales.reduce((s, o) => s + n(o.total), 0) * 100) / 100,
    firstActivityAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
    lastActivityAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

export function buildKpis(m: DigestMetrics): Array<{ label: string; value: string }> {
  return [
    { label: 'Ventas (vendedor)', value: `${m.salesOrdersAsSalesperson} · ${money(m.salesTotalAsSalesperson)}` },
    { label: 'Cotizaciones', value: `${m.quotesCreated} · ${money(m.quotesTotal)}` },
    { label: 'Mensajes a clientes', value: `${m.inboxMessagesSent} en ${m.inboxConversationsTouched} conv.` },
    { label: 'Chat interno', value: String(m.chatMessagesSent) },
    { label: 'Llamadas', value: String(m.callsMade) },
    { label: 'Compromisos', value: `${m.commitmentsCompleted} hechos · ${m.commitmentsOverdue} vencidos` },
    { label: 'IA', value: `${m.aiTurns} consultas · ${m.reportsGenerated} reportes · ${m.proposalsApproved} acciones aprobadas` },
  ];
}

function fallbackNarrative(name: string, date: string, m: DigestMetrics): string {
  const parts: string[] = [];
  if (m.salesOrdersAsSalesperson) parts.push(`${m.salesOrdersAsSalesperson} ventas por ${money(m.salesTotalAsSalesperson)}`);
  if (m.quotesCreated) parts.push(`${m.quotesCreated} cotizaciones (${money(m.quotesTotal)})`);
  if (m.inboxMessagesSent) parts.push(`${m.inboxMessagesSent} mensajes a clientes`);
  if (m.callsMade) parts.push(`${m.callsMade} llamadas`);
  if (m.reportsGenerated) parts.push(`${m.reportsGenerated} reportes`);
  if (m.commitmentsOverdue) parts.push(`${m.commitmentsOverdue} compromisos vencidos`);
  return parts.length ? `${name} · ${date}: ${parts.join(', ')}.` : `${name} · ${date}: sin actividad registrada.`;
}

async function narrate(name: string, date: string, m: DigestMetrics): Promise<string> {
  try {
    const settings = await getAiSettings();
    if (!settings.isEnabled) return fallbackNarrative(name, date, m);
    const provider = await getActiveProvider();
    const result = await provider.chatCompletion({
      model: settings.fallbackDeployment || settings.deployment,
      temperature: 0.2,
      maxTokens: 220,
      messages: [
        { role: 'system', content: 'Eres el analista de desempeño de UNIK. Escribe en español, en máximo 4 frases, un resumen honesto y útil del día de trabajo de una persona a partir de sus métricas: qué hizo bien, qué quedó pendiente (compromisos vencidos, clientes sin responder) y una sugerencia concreta para mañana. Sin saludos, sin adjetivos vacíos, sin inventar datos.' },
        { role: 'user', content: `Usuario: ${name}\nFecha: ${date}\nMétricas: ${JSON.stringify(m)}` },
      ],
    });
    return (result.content ?? '').trim() || fallbackNarrative(name, date, m);
  } catch {
    return fallbackNarrative(name, date, m);
  }
}

export async function computeUserDigest(userId: string, date: string, options: { persist?: boolean; narrate?: boolean } = {}): Promise<UserDigest> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const metrics = await computeMetrics(userId, date);
  const narrative = options.narrate === false ? fallbackNarrative(user?.name ?? 'Usuario', date, metrics) : await narrate(user?.name ?? 'Usuario', date, metrics);
  const digest: UserDigest = { metrics, narrative, kpis: buildKpis(metrics), computedAt: new Date().toISOString() };
  if (options.persist) {
    const { day } = dayRange(date);
    await prisma.aiUserDigest.upsert({
      where: { userId_date: { userId, date: day } },
      create: { userId, date: day, narrative, metrics: metrics as unknown as Prisma.InputJsonValue },
      update: { narrative, metrics: metrics as unknown as Prisma.InputJsonValue },
    });
  }
  return digest;
}

/** Stored digest for a day, only when it is at least 2 hours fresh for "today". */
export async function getUserDigest(userId: string, date: string): Promise<UserDigest | null> {
  const { day } = dayRange(date);
  const row = await prisma.aiUserDigest.findUnique({ where: { userId_date: { userId, date: day } } });
  if (!row) return null;
  const isToday = date === new Date().toISOString().slice(0, 10);
  if (isToday && Date.now() - row.updatedAt.getTime() > 2 * 3_600_000) return null;
  const metrics = row.metrics as unknown as DigestMetrics;
  return { metrics, narrative: row.narrative, kpis: buildKpis(metrics), computedAt: row.updatedAt.toISOString() };
}

/** Recomputes today's and yesterday's digests for every active user (recurring job). */
export async function refreshAllDigests(): Promise<{ users: number; days: number }> {
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const days = [yesterday, today].map((d) => d.toISOString().slice(0, 10));
  for (const u of users) {
    for (const date of days) {
      await computeUserDigest(u.id, date, { persist: true, narrate: true }).catch((error) => {
        console.warn(JSON.stringify({ event: 'ai.digest.failed', userId: u.id, date, message: error instanceof Error ? error.message : 'unknown' }));
      });
    }
  }
  return { users: users.length, days: days.length };
}
