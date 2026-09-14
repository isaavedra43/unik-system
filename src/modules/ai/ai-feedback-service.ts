import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Quality feedback: explicit 👍/👎 per assistant message (owner only) and the
 * aggregated metrics the admin dashboard shows next to the automatic judge.
 */

export type FeedbackRating = 1 | -1;

export class FeedbackError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
  }
}

async function assertOwnedAssistantMessage(messageId: string, userId: string): Promise<void> {
  const message = await prisma.aiMessage.findUnique({
    where: { id: messageId },
    select: { role: true, conversation: { select: { userId: true } } },
  });
  if (!message || message.conversation.userId !== userId) throw new FeedbackError('Mensaje no encontrado', 404);
  if (message.role !== 'assistant') throw new FeedbackError('Solo se califican respuestas del asistente', 400);
}

export async function setMessageFeedback(userId: string, messageId: string, rating: FeedbackRating, comment?: string | null) {
  await assertOwnedAssistantMessage(messageId, userId);
  const clean = comment?.trim().slice(0, 1000) || null;
  const row = await prisma.aiMessageFeedback.upsert({
    where: { messageId },
    create: { messageId, userId, rating, comment: clean },
    update: { rating, comment: clean, userId },
    select: { rating: true, comment: true },
  });
  return row;
}

export async function clearMessageFeedback(userId: string, messageId: string): Promise<void> {
  await assertOwnedAssistantMessage(messageId, userId);
  await prisma.aiMessageFeedback.deleteMany({ where: { messageId } });
}

export interface FeedbackStats {
  days: number;
  up: number;
  down: number;
  total: number;
  /** % of rated answers marked useful (100 when nothing was rated yet). */
  helpfulRate: number;
  /** Automatic judge (when enabled): evaluated answers and average score 1-5. */
  judged: number;
  avgJudgeScore: number | null;
  /** Share of answers whose data came from tools in the same turn. */
  verifiedShare: number | null;
  recentComments: Array<{ messageId: string; rating: number; comment: string; createdAt: string }>;
}

export async function getFeedbackStats(days = 30): Promise<FeedbackStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [up, down, judgeRows, confidenceRows, comments] = await Promise.all([
    prisma.aiMessageFeedback.count({ where: { rating: 1, createdAt: { gte: since } } }),
    prisma.aiMessageFeedback.count({ where: { rating: -1, createdAt: { gte: since } } }),
    prisma.$queryRaw<Array<{ judged: bigint | number; avg: number | null }>>(Prisma.sql`
      SELECT COUNT(*) AS "judged", AVG(("meta"->'judge'->>'score')::float) AS "avg"
      FROM "AiMessage"
      WHERE "role" = 'assistant' AND "createdAt" >= ${since} AND ("meta"->'judge'->>'score') IS NOT NULL
    `),
    prisma.$queryRaw<Array<{ total: bigint | number; verified: bigint | number }>>(Prisma.sql`
      SELECT COUNT(*) AS "total",
             COUNT(*) FILTER (WHERE "meta"->>'confidence' = 'verified') AS "verified"
      FROM "AiMessage"
      WHERE "role" = 'assistant' AND "createdAt" >= ${since} AND ("meta"->>'confidence') IS NOT NULL
    `),
    prisma.aiMessageFeedback.findMany({
      where: { createdAt: { gte: since }, comment: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { messageId: true, rating: true, comment: true, createdAt: true },
    }),
  ]);
  const judged = Number(judgeRows[0]?.judged ?? 0);
  const labeled = Number(confidenceRows[0]?.total ?? 0);
  const verified = Number(confidenceRows[0]?.verified ?? 0);
  const total = up + down;
  return {
    days,
    up,
    down,
    total,
    helpfulRate: total > 0 ? (up / total) * 100 : 100,
    judged,
    avgJudgeScore: judged > 0 && judgeRows[0]?.avg != null ? Number(judgeRows[0].avg) : null,
    verifiedShare: labeled > 0 ? (verified / labeled) * 100 : null,
    recentComments: comments.map((c) => ({ messageId: c.messageId, rating: c.rating, comment: c.comment ?? '', createdAt: c.createdAt.toISOString() })),
  };
}
