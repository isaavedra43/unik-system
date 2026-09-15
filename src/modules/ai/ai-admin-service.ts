import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getAiSettings, providerMonthlyFeeUsd, type ProviderConfigEntry } from './ai-admin-config-service';
import { getModelById, getProviderForModel } from './model-catalog';
import { resolveProviderForModel } from './provider-resolution';
import { PROVIDER_IDS, type ProviderId } from './providers/types';

export interface AiStats {
  totalConversations: number;
  totalMessages: number;
  totalToolCalls: number;
  totalApiCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  activeUsers24h: number;
  activeUsers7d: number;
  successRate: number;
  errorCount: number;
  last24hMessages: number;
  last24hTokens: number;
}

// Pricing per 1M tokens (USD). Prices are identical across OpenAI direct and Azure OpenAI.
// Add entries here when new providers/models are activated.
const PRICING: Record<string, { prompt: number; completion: number }> = {
  'gpt-4o': { prompt: 2.5, completion: 10 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'gpt-4.1': { prompt: 2.0, completion: 8.0 },
  'gpt-4.1-mini': { prompt: 0.4, completion: 1.6 },
  'o1': { prompt: 15.0, completion: 60.0 },
  'o3-mini': { prompt: 1.1, completion: 4.4 },
  'claude-sonnet-4-5': { prompt: 3.0, completion: 15.0 },
  'claude-haiku-4-5': { prompt: 1.0, completion: 5.0 },
  'claude-opus-4-5': { prompt: 5.0, completion: 25.0 },
  'gemini-2.0-flash': { prompt: 0.1, completion: 0.4 },
};

/** Providers billed by a flat monthly plan instead of per token. */
export const FLAT_RATE_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(['canopywave']);

export interface CostContext {
  /** `AiSettings.providerConfigs`: discovered models, enabled providers and flat monthly fees. */
  providerConfigs?: Record<string, Partial<ProviderConfigEntry>>;
  /**
   * Tokens served by the flat-rate provider in the month of the call(s). Used to amortize
   * `monthlyFeeUsd` per token; absent = the call is the only known usage of the month.
   */
  flatRateMonthTokens?: number;
}

/** Provider that serves a model id for costing (catalog → discovered ids → namespaced open model). Pure. */
export function providerForCost(deployment: string, ctx: CostContext = {}): ProviderId {
  const configs = ctx.providerConfigs;
  const discovered: Partial<Record<ProviderId, string[]>> = {};
  const configured: ProviderId[] = [];
  for (const provider of PROVIDER_IDS) {
    const entry = configs?.[provider];
    if (Array.isArray(entry?.models)) discovered[provider] = entry.models;
    if (entry?.enabled) configured.push(provider);
  }
  // Without settings a namespaced id ("vendor/model") can only have been served by Canopy Wave:
  // OpenAI, Anthropic and Gemini ids never contain "/".
  if (!configs) configured.push('canopywave');
  return resolveProviderForModel(deployment, {
    catalogProvider: getProviderForModel(deployment),
    discovered,
    configured,
    defaultProvider: 'openai',
  });
}

/** Whether the model is billed by a flat monthly plan (its marginal cost is 0). Pure. */
export function isFlatRateModel(deployment: string, ctx: CostContext = {}): boolean {
  return FLAT_RATE_PROVIDERS.has(providerForCost(deployment, ctx));
}

/**
 * Estimated USD of a call. Pure.
 * - Flat-rate models (Canopy Wave): 0, unless `providerConfigs.canopywave.monthlyFeeUsd` is set;
 *   then the fee amortized per token of the month: tokens × fee / max(month tokens, tokens).
 * - Priced models: the pricing table, then the catalog price, then gpt-4o prices.
 */
export function estimateCost(
  promptTokens: number,
  completionTokens: number,
  deployment = 'gpt-4o',
  ctx: CostContext = {}
): number {
  const prompt = Math.max(0, Number(promptTokens) || 0);
  const completion = Math.max(0, Number(completionTokens) || 0);
  const provider = providerForCost(deployment, ctx);
  if (FLAT_RATE_PROVIDERS.has(provider)) {
    const fee = providerMonthlyFeeUsd(ctx.providerConfigs, provider);
    const tokens = prompt + completion;
    if (fee === null || tokens === 0) return 0;
    const monthTokens = Math.max(Number(ctx.flatRateMonthTokens) || 0, tokens);
    return (tokens * fee) / monthTokens;
  }
  const catalog = getModelById(deployment)?.costPer1M;
  const p =
    PRICING[deployment] ??
    (catalog ? { prompt: catalog.input, completion: catalog.output } : PRICING['gpt-4o']);
  return (prompt / 1_000_000) * p.prompt + (completion / 1_000_000) * p.completion;
}

/** YYYY-MM of a date (UTC, like the AiApiCall day buckets of these reports). */
function monthKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/**
 * Tokens served by flat-rate models per month (YYYY-MM), only when a flat fee is configured
 * (without a fee flat-rate calls cost 0 and nothing needs to be amortized).
 */
async function flatRateTokensByMonth(
  months: Iterable<string>,
  providerConfigs: CostContext['providerConfigs']
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const hasFee = [...FLAT_RATE_PROVIDERS].some((p) => providerMonthlyFeeUsd(providerConfigs, p) !== null);
  if (!hasFee) return result;
  for (const month of new Set(months)) {
    const [year, mon] = month.split('-').map(Number);
    const from = new Date(Date.UTC(year, mon - 1, 1));
    const to = new Date(Date.UTC(year, mon, 1));
    const groups = await prisma.aiApiCall.groupBy({
      by: ['deployment'],
      where: { createdAt: { gte: from, lt: to } },
      _sum: { promptTokens: true, completionTokens: true },
    });
    let tokens = 0;
    for (const g of groups) {
      if (!isFlatRateModel(g.deployment, { providerConfigs })) continue;
      tokens += (g._sum.promptTokens ?? 0) + (g._sum.completionTokens ?? 0);
    }
    result.set(month, tokens);
  }
  return result;
}

/** Exported for the agents usage reports (amortization denominator of each month). */
export const getFlatRateTokensByMonth = flatRateTokensByMonth;

async function loadProviderConfigs(): Promise<CostContext['providerConfigs']> {
  try {
    return (await getAiSettings()).providerConfigs;
  } catch {
    return undefined;
  }
}

/** Σ estimated cost of calls grouped by UTC month and deployment, amortizing flat fees per month. */
async function estimateGroupedCost(
  groups: Array<{ month: string; deployment: string; promptTokens: number; completionTokens: number }>,
  providerConfigs: CostContext['providerConfigs']
): Promise<number> {
  const flatByMonth = new Map<string, number>();
  for (const g of groups) {
    if (!isFlatRateModel(g.deployment, { providerConfigs })) continue;
    flatByMonth.set(g.month, (flatByMonth.get(g.month) ?? 0) + g.promptTokens + g.completionTokens);
  }
  let total = 0;
  for (const g of groups) {
    total += estimateCost(g.promptTokens, g.completionTokens, g.deployment, {
      providerConfigs,
      flatRateMonthTokens: flatByMonth.get(g.month),
    });
  }
  return total;
}

async function allTimeUsageByMonthAndDeployment(): Promise<
  Array<{ month: string; deployment: string; promptTokens: number; completionTokens: number }>
> {
  const rows = await prisma.$queryRaw<
    Array<{ month: string; deployment: string; prompt: bigint | number | null; completion: bigint | number | null }>
  >(Prisma.sql`
    SELECT to_char("createdAt", 'YYYY-MM') AS month,
           "deployment" AS deployment,
           COALESCE(SUM("promptTokens"), 0) AS prompt,
           COALESCE(SUM("completionTokens"), 0) AS completion
    FROM "AiApiCall"
    GROUP BY 1, 2
  `);
  return rows.map((r) => ({
    month: r.month,
    deployment: r.deployment,
    promptTokens: Number(r.prompt ?? 0),
    completionTokens: Number(r.completion ?? 0),
  }));
}

export async function getAiStats(): Promise<AiStats> {
  const [
    convs,
    msgs,
    toolCalls,
    apiCalls,
    apiAgg,
    errCount,
    last24hMsgs,
    last24hApiAgg,
    activeUsers24hRows,
    activeUsers7dRows,
  ] = await Promise.all([
    prisma.aiConversation.count(),
    prisma.aiMessage.count(),
    prisma.aiToolCall.count(),
    prisma.aiApiCall.count(),
    prisma.aiApiCall.aggregate({
      _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
    }),
    prisma.aiApiCall.count({ where: { success: false } }),
    prisma.aiMessage.count({ where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.aiApiCall.aggregate({
      where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
      _sum: { totalTokens: true },
    }),
    prisma.aiMessage.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 86_400_000) } },
      select: { conversation: { select: { userId: true } } },
    }),
    prisma.aiMessage.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 604_800_000) } },
      select: { conversation: { select: { userId: true } } },
    }),
  ]);

  const activeUsers24h = new Set(activeUsers24hRows.map((m) => m.conversation.userId)).size;
  const activeUsers7d = new Set(activeUsers7dRows.map((m) => m.conversation.userId)).size;
  const successRate = apiCalls > 0 ? ((apiCalls - errCount) / apiCalls) * 100 : 100;
  // Priced per model (flat-rate models cost 0 or their amortized monthly fee), not as if every token were gpt-4o.
  const estimatedCostUsd = await estimateGroupedCost(
    await allTimeUsageByMonthAndDeployment(),
    await loadProviderConfigs()
  );

  return {
    totalConversations: convs,
    totalMessages: msgs,
    totalToolCalls: toolCalls,
    totalApiCalls: apiCalls,
    totalPromptTokens: apiAgg._sum.promptTokens ?? 0,
    totalCompletionTokens: apiAgg._sum.completionTokens ?? 0,
    totalTokens: apiAgg._sum.totalTokens ?? 0,
    estimatedCostUsd,
    activeUsers24h,
    activeUsers7d,
    successRate,
    errorCount: errCount,
    last24hMessages: last24hMsgs,
    last24hTokens: last24hApiAgg._sum.totalTokens ?? 0,
  };
}

export async function getAiStatsByDay(days: number): Promise<
  Array<{ date: string; messages: number; tokens: number; cost: number }>
> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.aiApiCall.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, totalTokens: true, promptTokens: true, completionTokens: true, deployment: true },
  });

  const providerConfigs = await loadProviderConfigs();
  const flatByMonth = await flatRateTokensByMonth(
    rows.map((row) => monthKeyOf(row.createdAt)),
    providerConfigs
  );
  const byDay = new Map<string, { messages: number; tokens: number; cost: number }>();
  for (const row of rows) {
    const date = row.createdAt.toISOString().slice(0, 10);
    const entry = byDay.get(date) ?? { messages: 0, tokens: 0, cost: 0 };
    entry.messages++;
    entry.tokens += row.totalTokens;
    entry.cost += estimateCost(row.promptTokens, row.completionTokens, row.deployment, {
      providerConfigs,
      flatRateMonthTokens: flatByMonth.get(monthKeyOf(row.createdAt)),
    });
    byDay.set(date, entry);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, messages: v.messages, tokens: v.tokens, cost: v.cost }));
}

export async function listAllConversations(filters: {
  userId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
  page?: number;
  pageSize?: number;
}) {
  const where: Prisma.AiConversationWhereInput = {};
  if (filters.userId) where.userId = filters.userId;
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = filters.dateFrom;
    if (filters.dateTo) where.createdAt.lte = filters.dateTo;
  }
  if (filters.search) where.title = { contains: filters.search, mode: 'insensitive' };

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 20, 100);

  const [data, total] = await Promise.all([
    prisma.aiConversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { name: true, username: true } },
        _count: { select: { messages: true } },
      },
    }),
    prisma.aiConversation.count({ where }),
  ]);

  return {
    data: data.map((c) => ({
      id: c.id,
      userId: c.userId,
      userName: c.user.name,
      username: c.user.username,
      title: c.title,
      isStarred: c.isStarred,
      messageCount: c._count.messages,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  };
}

export async function getConversationForAdmin(id: string) {
  const conv = await prisma.aiConversation.findUnique({
    where: { id },
    include: {
      user: { select: { name: true, username: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        include: { toolCallRecords: true },
      },
    },
  });
  if (!conv) return null;
  return {
    conversation: {
      id: conv.id,
      userId: conv.userId,
      userName: conv.user.name,
      username: conv.user.username,
      title: conv.title,
      isStarred: conv.isStarred,
      createdAt: conv.createdAt.toISOString(),
      updatedAt: conv.updatedAt.toISOString(),
    },
    messages: conv.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
      tokensIn: m.tokensIn,
      tokensOut: m.tokensOut,
      latencyMs: m.latencyMs,
      createdAt: m.createdAt.toISOString(),
      toolCallRecords: m.toolCallRecords.map((tc) => ({
        id: tc.id,
        toolName: tc.toolName,
        args: tc.args,
        result: tc.result,
        durationMs: tc.durationMs,
        success: tc.success,
        errorCode: tc.errorCode,
      })),
    })),
  };
}

export async function searchMessages(
  query: string,
  filters: {
    userId?: string;
    role?: string;
    dateFrom?: Date;
    dateTo?: Date;
    page?: number;
    pageSize?: number;
  }
) {
  const where: Prisma.AiMessageWhereInput = {
    content: { contains: query, mode: 'insensitive' },
  };
  if (filters.role) where.role = filters.role;
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = filters.dateFrom;
    if (filters.dateTo) where.createdAt.lte = filters.dateTo;
  }
  if (filters.userId) where.conversation = { userId: filters.userId };

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 20, 100);

  const [data, total] = await Promise.all([
    prisma.aiMessage.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        conversation: {
          select: {
            id: true,
            title: true,
            user: { select: { name: true, username: true } },
          },
        },
      },
    }),
    prisma.aiMessage.count({ where }),
  ]);

  return {
    data: data.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      conversationTitle: m.conversation.title,
      userId: m.conversation.user.name,
      userName: m.conversation.user.name,
      username: m.conversation.user.username,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  };
}

export async function listAllToolCalls(filters: {
  toolName?: string;
  success?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  pageSize?: number;
}) {
  const where: Prisma.AiToolCallWhereInput = {};
  if (filters.toolName) where.toolName = filters.toolName;
  if (filters.success !== undefined) where.success = filters.success;
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = filters.dateFrom;
    if (filters.dateTo) where.createdAt.lte = filters.dateTo;
  }

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 20, 100);

  const [data, total] = await Promise.all([
    prisma.aiToolCall.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        message: {
          select: {
            conversation: {
              select: {
                id: true,
                title: true,
                user: { select: { name: true, username: true } },
              },
            },
          },
        },
      },
    }),
    prisma.aiToolCall.count({ where }),
  ]);

  return {
    data: data.map((tc) => ({
      id: tc.id,
      toolName: tc.toolName,
      args: tc.args,
      result: tc.result,
      durationMs: tc.durationMs,
      success: tc.success,
      errorCode: tc.errorCode,
      createdAt: tc.createdAt.toISOString(),
      userName: tc.message.conversation.user.name,
      username: tc.message.conversation.user.username,
      conversationTitle: tc.message.conversation.title,
    })),
    total,
    page,
    pageSize,
  };
}

export async function listAllApiCalls(filters: {
  deployment?: string;
  userId?: string;
  success?: boolean;
  dateFrom?: Date;
  dateTo?: Date;
  page?: number;
  pageSize?: number;
}) {
  const where: Prisma.AiApiCallWhereInput = {};
  if (filters.deployment) where.deployment = filters.deployment;
  if (filters.userId) where.userId = filters.userId;
  if (filters.success !== undefined) where.success = filters.success;
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = filters.dateFrom;
    if (filters.dateTo) where.createdAt.lte = filters.dateTo;
  }

  const page = filters.page ?? 1;
  const pageSize = Math.min(filters.pageSize ?? 20, 100);

  const [data, total] = await Promise.all([
    prisma.aiApiCall.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.aiApiCall.count({ where }),
  ]);
  const providerConfigs = await loadProviderConfigs();
  const flatByMonth = await flatRateTokensByMonth(
    data.map((c) => monthKeyOf(c.createdAt)),
    providerConfigs
  );

  return {
    data: data.map((c) => ({
      id: c.id,
      userId: c.userId,
      conversationId: c.conversationId,
      deployment: c.deployment,
      promptTokens: c.promptTokens,
      completionTokens: c.completionTokens,
      totalTokens: c.totalTokens,
      durationMs: c.durationMs,
      success: c.success,
      errorCode: c.errorCode,
      finishReason: c.finishReason,
      estimatedCostUsd: estimateCost(c.promptTokens, c.completionTokens, c.deployment, {
        providerConfigs,
        flatRateMonthTokens: flatByMonth.get(monthKeyOf(c.createdAt)),
      }),
      flatRate: isFlatRateModel(c.deployment, { providerConfigs }),
      createdAt: c.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  };
}

export async function getUserUsageRanking() {
  const rows = await prisma.aiApiCall.findMany({
    where: { userId: { not: null } },
    select: {
      userId: true,
      promptTokens: true,
      completionTokens: true,
      totalTokens: true,
      createdAt: true,
    },
  });

  const byUser = new Map<
    string,
    { tokenCount: number; lastActivity: Date }
  >();
  for (const row of rows) {
    if (!row.userId) continue;
    const entry = byUser.get(row.userId) ?? { tokenCount: 0, lastActivity: new Date(0) };
    entry.tokenCount += row.totalTokens;
    if (row.createdAt > entry.lastActivity) entry.lastActivity = row.createdAt;
    byUser.set(row.userId, entry);
  }

  const userIds = [...byUser.keys()];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      name: true,
      username: true,
      roles: { include: { role: { select: { key: true } } } },
    },
  });

  const messageCounts = await prisma.aiMessage.groupBy({
    by: ['conversationId'],
    _count: true,
  });
  // Map conversation → user
  const convs = await prisma.aiConversation.findMany({
    where: { userId: { in: userIds } },
    select: { id: true, userId: true },
  });
  const convToUser = new Map(convs.map((c) => [c.id, c.userId]));
  const msgByUser = new Map<string, number>();
  for (const mc of messageCounts) {
    const uid = convToUser.get(mc.conversationId);
    if (uid) msgByUser.set(uid, (msgByUser.get(uid) ?? 0) + mc._count);
  }

  return users.map((u) => ({
    userId: u.id,
    userName: u.name,
    username: u.username,
    roleKeys: u.roles.map((r) => r.role.key),
    messageCount: msgByUser.get(u.id) ?? 0,
    tokenCount: byUser.get(u.id)?.tokenCount ?? 0,
    estimatedCostUsd: 0,
    conversationCount: convs.filter((c) => c.userId === u.id).length,
    lastActivity: byUser.get(u.id)?.lastActivity.toISOString() ?? null,
  }));
}

export async function getTopTools(limit = 10) {
  const rows = await prisma.aiToolCall.findMany({
    select: { toolName: true, success: true, durationMs: true },
  });
  const byTool = new Map<
    string,
    { count: number; successCount: number; totalDuration: number }
  >();
  for (const row of rows) {
    const entry = byTool.get(row.toolName) ?? { count: 0, successCount: 0, totalDuration: 0 };
    entry.count++;
    if (row.success) entry.successCount++;
    entry.totalDuration += row.durationMs;
    byTool.set(row.toolName, entry);
  }
  return [...byTool.entries()]
    .map(([toolName, v]) => ({
      toolName,
      count: v.count,
      successRate: v.count > 0 ? (v.successCount / v.count) * 100 : 100,
      avgDurationMs: v.count > 0 ? Math.round(v.totalDuration / v.count) : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export async function getTopUsers(limit = 10) {
  const ranking = await getUserUsageRanking();
  return ranking
    .sort((a, b) => b.tokenCount - a.tokenCount)
    .slice(0, limit)
    .map((u) => ({
      userId: u.userId,
      userName: u.userName,
      messageCount: u.messageCount,
      tokenCount: u.tokenCount,
    }));
}

export async function getRecentErrors(limit = 20) {
  return prisma.aiApiCall.findMany({
    where: { success: false },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      errorCode: true,
      deployment: true,
      createdAt: true,
    },
  });
}
