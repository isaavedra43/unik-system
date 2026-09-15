import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import {
  estimateCost,
  getFlatRateTokensByMonth,
  isFlatRateModel,
} from '@/modules/ai/ai-admin-service';
import { getAiSettings, providerMonthlyFeeUsd } from '@/modules/ai/ai-admin-config-service';
import { DEFAULT_AGENT_SETTINGS, normalizeAgentSettings, type AgentSettings } from '@/modules/ai/agent-settings';
import { recordUsage } from '@/modules/extensions/usage-meter';
import { AREA_KEYS, AREA_LABELS, isAreaKey, type AreaKey } from '@/modules/operations/types';

/**
 * AI budgets and consumption of the coordinated AI layer (plan 5.6). No model is
 * called here: this module only meters what `runAssistant` already spent.
 *
 * - `recordAgentUsage` writes, per local day of the agents time zone, `tokens`,
 *   `usd` (paid cost; flat-rate models such as Canopy Wave cost 0) and
 *   `flat_tokens` (tokens under a flat-rate plan) on the `ai_area`, `ai_agent` and
 *   `ai_case` usage meters, plus `ai_tokens` on the user's meter. Metering never
 *   breaks a turn: write failures are logged and reported in the result.
 * - `checkAgentBudget` compares today's tokens with `dailyTokenBudget` and this
 *   month's paid USD with `monthlyCostBudgetUsd`: `degraded` from
 *   `agents.degradeAtPct`, `exhausted` at 100 %. A budget ≤ 0 means "no limit" on
 *   that dimension (pausing an agent is done with `AgentIdentity.mode`).
 * - `notifyBudgetOnce` warns administrators (`agent_budget`) once a day per
 *   identity and level (alert / exhausted).
 * - `getAreaAiUsage` feeds the dashboards, amortizing a configured flat monthly
 *   fee by each area's share of the month's flat-rate tokens.
 */

export const AI_USAGE_UNITS = {
  tokens: 'tokens',
  usd: 'usd',
  flatTokens: 'flat_tokens',
  skipped: 'skipped',
  userTokens: 'ai_tokens',
} as const;

export type AgentBudgetState = 'ok' | 'degraded' | 'exhausted';

/** The fields of `AgentIdentity` a budget needs. */
export interface AgentBudgetIdentity {
  key: string;
  dailyTokenBudget: number;
  monthlyCostBudgetUsd: number | string | Prisma.Decimal;
  displayName?: string | null;
  areaKey?: string | null;
}

export interface AgentBudgetStatus {
  state: AgentBudgetState;
  /** Highest consumption of the two budgets, in % (0 when both are unlimited). */
  pct: number;
  tokensToday: number;
  usdMonth: number;
  dailyTokenBudget: number;
  monthlyCostBudgetUsd: number;
  degradeAtPct: number;
  /** YYYY-MM-DD in the agents time zone. */
  day: string;
  /** YYYY-MM in the agents time zone. */
  month: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Local day (YYYY-MM-DD) and month (YYYY-MM) of `now` in `tz`. Pure. */
export function budgetPeriod(now: Date, tz: string): { day: string; month: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_AGENT_SETTINGS.quietHours.tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const month = `${get('year')}-${get('month')}`;
  return { day: `${month}-${get('day')}`, month };
}

function toNumber(value: number | string | Prisma.Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value.toString());
  return Number.isFinite(n) ? n : 0;
}

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** State of a budget from the consumed amounts. Pure. */
export function evaluateAgentBudget(input: {
  tokensToday: number;
  usdMonth: number;
  dailyTokenBudget: number;
  monthlyCostBudgetUsd: number;
  degradeAtPct: number;
}): { state: AgentBudgetState; pct: number } {
  const ratios: number[] = [];
  if (input.dailyTokenBudget > 0) ratios.push(input.tokensToday / input.dailyTokenBudget);
  if (input.monthlyCostBudgetUsd > 0) ratios.push(input.usdMonth / input.monthlyCostBudgetUsd);
  const pct = ratios.length > 0 ? round(Math.max(...ratios) * 100, 1) : 0;
  if (pct >= 100) return { state: 'exhausted', pct };
  if (pct >= input.degradeAtPct) return { state: 'degraded', pct };
  return { state: 'ok', pct };
}

/** "IA de Compras" for 'area:compras', "IA administradora" for 'admin'. Pure. */
export function agentDisplayName(identity: Pick<AgentBudgetIdentity, 'key' | 'displayName' | 'areaKey'>): string {
  if (identity.displayName?.trim()) return identity.displayName.trim();
  const areaKey = identity.areaKey ?? (identity.key.startsWith('area:') ? identity.key.slice(5) : null);
  if (areaKey && isAreaKey(areaKey)) return `IA de ${AREA_LABELS[areaKey]}`;
  return identity.key === 'admin' ? 'IA administradora' : `IA ${identity.key}`;
}

function monthRange(month: string): { gte: string; lte: string } {
  return { gte: `${month}-01`, lte: `${month}-31` };
}

async function loadAgentContext(): Promise<{
  agents: AgentSettings;
  providerConfigs: Awaited<ReturnType<typeof getAiSettings>>['providerConfigs'] | undefined;
}> {
  try {
    const settings = await getAiSettings();
    return { agents: normalizeAgentSettings(settings.agents), providerConfigs: settings.providerConfigs };
  } catch {
    return { agents: normalizeAgentSettings(undefined), providerConfigs: undefined };
  }
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

export interface RecordAgentUsageInput {
  /** AgentIdentity.key ('area:compras' | 'admin') when an agent turn spent the tokens. */
  agentKey?: string | null;
  areaKey?: string | null;
  caseId?: string | null;
  /** Conversation owner: the bot of an agent turn, or the human of an area/case surface. */
  userId: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
  now?: Date;
}

export interface RecordedAgentUsage {
  tokens: number;
  usd: number;
  flatRate: boolean;
  day: string;
  meters: Array<{ dimension: 'ai_area' | 'ai_agent' | 'ai_case' | 'user'; key: string }>;
  failedWrites: number;
}

export async function recordAgentUsage(input: RecordAgentUsageInput): Promise<RecordedAgentUsage> {
  const prompt = Math.max(0, Math.round(Number(input.promptTokens) || 0));
  const completion = Math.max(0, Math.round(Number(input.completionTokens) || 0));
  const tokens = prompt + completion;
  const { agents, providerConfigs } = await loadAgentContext();
  const { day } = budgetPeriod(input.now ?? new Date(), agents.quietHours.tz);
  const flatRate = isFlatRateModel(input.model, { providerConfigs });
  // The budget brakes spending: a flat-rate plan is already paid, so its marginal cost is 0.
  const usd = flatRate ? 0 : round(estimateCost(prompt, completion, input.model, { providerConfigs }), 6);

  const meters: RecordedAgentUsage['meters'] = [];
  const areaKey = input.areaKey?.trim();
  if (areaKey && isAreaKey(areaKey)) meters.push({ dimension: 'ai_area', key: areaKey });
  const agentKey = input.agentKey?.trim();
  if (agentKey) meters.push({ dimension: 'ai_agent', key: agentKey.slice(0, 64) });
  const caseId = input.caseId?.trim();
  if (caseId) meters.push({ dimension: 'ai_case', key: caseId.slice(0, 64) });

  const result: RecordedAgentUsage = { tokens, usd, flatRate, day, meters: [], failedWrites: 0 };
  if (tokens === 0 && usd === 0) return result;

  const writes: Array<Promise<void>> = [];
  for (const meter of meters) {
    writes.push(recordUsage(meter.dimension, meter.key, AI_USAGE_UNITS.tokens, tokens, day));
    writes.push(recordUsage(meter.dimension, meter.key, AI_USAGE_UNITS.usd, usd, day));
    if (flatRate) writes.push(recordUsage(meter.dimension, meter.key, AI_USAGE_UNITS.flatTokens, tokens, day));
  }
  if (input.userId) {
    meters.push({ dimension: 'user', key: input.userId });
    writes.push(recordUsage('user', input.userId, AI_USAGE_UNITS.userTokens, tokens, day));
  }
  const settled = await Promise.allSettled(writes);
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      result.failedWrites++;
      console.error(
        '[agents/budget] no se pudo registrar consumo',
        outcome.reason instanceof Error ? outcome.reason.message : outcome.reason
      );
    }
  }
  result.meters = meters;
  return result;
}

/** Dispatches the guards skipped (budget, quiet hours, human attending…) count on the agent meter. */
export async function recordAgentSkip(agentKey: string, now: Date = new Date()): Promise<void> {
  const { agents } = await loadAgentContext();
  const { day } = budgetPeriod(now, agents.quietHours.tz);
  await recordUsage('ai_agent', agentKey.slice(0, 64), AI_USAGE_UNITS.skipped, 1, day);
}

// ---------------------------------------------------------------------------
// Budget check and notice
// ---------------------------------------------------------------------------

export async function checkAgentBudget(
  identity: AgentBudgetIdentity,
  options: { now?: Date } = {}
): Promise<AgentBudgetStatus> {
  const { agents } = await loadAgentContext();
  const { day, month } = budgetPeriod(options.now ?? new Date(), agents.quietHours.tz);
  const [tokensAgg, usdAgg] = await Promise.all([
    prisma.usageMeter.aggregate({
      where: { dimension: 'ai_agent', key: identity.key, unit: AI_USAGE_UNITS.tokens, period: day },
      _sum: { amount: true },
    }),
    prisma.usageMeter.aggregate({
      where: {
        dimension: 'ai_agent',
        key: identity.key,
        unit: AI_USAGE_UNITS.usd,
        period: monthRange(month),
      },
      _sum: { amount: true },
    }),
  ]);
  const tokensToday = Math.round(toNumber(tokensAgg._sum.amount));
  const usdMonth = round(toNumber(usdAgg._sum.amount), 4);
  const dailyTokenBudget = Math.max(0, Math.round(toNumber(identity.dailyTokenBudget)));
  const monthlyCostBudgetUsd = Math.max(0, toNumber(identity.monthlyCostBudgetUsd));
  const { state, pct } = evaluateAgentBudget({
    tokensToday,
    usdMonth,
    dailyTokenBudget,
    monthlyCostBudgetUsd,
    degradeAtPct: agents.degradeAtPct,
  });
  return {
    state,
    pct,
    tokensToday,
    usdMonth,
    dailyTokenBudget,
    monthlyCostBudgetUsd,
    degradeAtPct: agents.degradeAtPct,
    day,
    month,
  };
}

export interface BudgetNoticeResult {
  notified: number;
  skipped?: 'below_alert_threshold' | 'no_admins';
  dedupeKeyPrefix?: string;
}

/** Active human administrators: super_admin or `operations.admin` through an active role. */
async function budgetNoticeRecipients(): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      isBot: false,
      roles: {
        some: {
          role: {
            isActive: true,
            OR: [
              { key: SUPER_ADMIN_ROLE_KEY },
              { permissions: { some: { permissionKey: 'operations.admin' } } },
            ],
          },
        },
      },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  return users.map((u) => u.id);
}

/**
 * Warns administrators about an agent budget, at most once per local day per identity and
 * level: `alert` (consumption ≥ `alertAdminAtPct`, or `degraded` when no % is known) and
 * `exhausted`. Returns how many notices were delivered (duplicates of the day count 0).
 */
export async function notifyBudgetOnce(
  identity: AgentBudgetIdentity,
  budget: AgentBudgetState | AgentBudgetStatus,
  options: { now?: Date } = {}
): Promise<BudgetNoticeResult> {
  const status = typeof budget === 'string' ? null : budget;
  const state = typeof budget === 'string' ? budget : budget.state;
  const { agents } = await loadAgentContext();
  const exhausted = state === 'exhausted';
  const shouldAlert =
    exhausted || (status ? status.pct >= agents.alertAdminAtPct : state === 'degraded');
  if (!shouldAlert) return { notified: 0, skipped: 'below_alert_threshold' };

  const recipients = await budgetNoticeRecipients();
  if (recipients.length === 0) return { notified: 0, skipped: 'no_admins' };

  const day = status?.day ?? budgetPeriod(options.now ?? new Date(), agents.quietHours.tz).day;
  const level = exhausted ? 'exhausted' : 'alert';
  const dedupeKeyPrefix = `agent_budget:${identity.key}:${level}:${day}`;
  const name = agentDisplayName(identity);
  const title = exhausted
    ? `${name} en pausa por presupuesto`
    : status
      ? `${name} al ${Math.round(status.pct)} % de su presupuesto`
      : `${name} pasó a modo bajo demanda por presupuesto`;
  const usage = status
    ? `Hoy: ${status.tokensToday.toLocaleString('es-MX')} de ${status.dailyTokenBudget > 0 ? status.dailyTokenBudget.toLocaleString('es-MX') : 'sin límite de'} tokens. Mes: US$${status.usdMonth.toFixed(2)} de ${status.monthlyCostBudgetUsd > 0 ? `US$${status.monthlyCostBudgetUsd.toFixed(2)}` : 'sin límite'}. `
    : '';
  const effect = exhausted
    ? 'La IA ya no toma turnos automáticos; las reglas y plantillas siguen y los responsables atienden.'
    : 'La IA sólo responde cuando la mencionan o falla una acción aprobada.';

  const { notifyUsers } = await import('@/modules/notifications/notification-service');
  const results = await notifyUsers(recipients, {
    category: 'agent_budget',
    type: exhausted ? 'agent_budget_exhausted' : 'agent_budget_alert',
    title,
    body: `${usage}${effect}`,
    url: '/app/admin/assistant',
    entityType: 'agent_identity',
    entityId: identity.key,
    metadata: {
      agentKey: identity.key,
      state,
      pct: status?.pct ?? null,
      day,
    },
    dedupeKeyPrefix,
  });
  return { notified: results.filter((r) => !r.suppressed).length, dedupeKeyPrefix };
}

// ---------------------------------------------------------------------------
// Dashboards
// ---------------------------------------------------------------------------

export interface AreaAiUsageRow {
  areaKey: AreaKey;
  label: string;
  tokens: number;
  usd: number;
  flatTokens: number;
  /** Share of the flat monthly fee (0 when no fee is configured). */
  amortizedUsd: number;
  turns: number;
}

export interface AgentAiUsageRow {
  agentKey: string;
  label: string;
  tokens: number;
  usd: number;
  flatTokens: number;
  turns: number;
  skipped: number;
}

export interface AreaAiUsage {
  from: string;
  to: string;
  monthlyFeeUsd: number | null;
  areas: AreaAiUsageRow[];
  agents: AgentAiUsageRow[];
  days: Array<{ period: string; tokens: number; usd: number; turns: number }>;
  totals: { tokens: number; usd: number; flatTokens: number; amortizedUsd: number; turns: number; skipped: number };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

function toDay(value: string | Date, tz: string): string {
  if (value instanceof Date) return budgetPeriod(value, tz).day;
  if (!DAY_RE.test(value)) throw new Error(`Fecha inválida (se espera AAAA-MM-DD): ${value}`);
  return value;
}

/**
 * AI consumption per area and per agent between two local days (inclusive). Area-bound
 * usage is counted once in the totals: `ai_area` rows plus agents whose key is not
 * `area:<key>` (their turns have no area meter).
 */
export async function getAreaAiUsage(input: { from: string | Date; to: string | Date }): Promise<AreaAiUsage> {
  const { agents: agentSettings, providerConfigs } = await loadAgentContext();
  const tz = agentSettings.quietHours.tz;
  let from = toDay(input.from, tz);
  let to = toDay(input.to, tz);
  if (from > to) [from, to] = [to, from];
  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    from = new Date(Date.parse(`${to}T00:00:00Z`) - MAX_RANGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  }

  const rows = await prisma.usageMeter.findMany({
    where: { dimension: { in: ['ai_area', 'ai_agent'] }, period: { gte: from, lte: to } },
    orderBy: [{ period: 'asc' }, { key: 'asc' }],
    take: 50_000,
  });

  const areas = new Map<AreaKey, AreaAiUsageRow>(
    AREA_KEYS.map((key) => [
      key,
      { areaKey: key, label: AREA_LABELS[key], tokens: 0, usd: 0, flatTokens: 0, amortizedUsd: 0, turns: 0 },
    ])
  );
  const agentRows = new Map<string, AgentAiUsageRow>();
  const days = new Map<string, { period: string; tokens: number; usd: number; turns: number }>();
  /** month → area → flat tokens, and month → flat tokens metered on any area. */
  const areaFlatByMonth = new Map<string, Map<AreaKey, number>>();
  const meteredFlatByMonth = new Map<string, number>();

  const dayEntry = (period: string) => {
    let entry = days.get(period);
    if (!entry) {
      entry = { period, tokens: 0, usd: 0, turns: 0 };
      days.set(period, entry);
    }
    return entry;
  };

  for (const row of rows) {
    const amount = toNumber(row.amount);
    if (row.dimension === 'ai_area') {
      if (!isAreaKey(row.key)) continue;
      const area = areas.get(row.key)!;
      if (row.unit === AI_USAGE_UNITS.tokens) {
        area.tokens += amount;
        area.turns += row.count;
        const d = dayEntry(row.period);
        d.tokens += amount;
        d.turns += row.count;
      } else if (row.unit === AI_USAGE_UNITS.usd) {
        area.usd += amount;
        dayEntry(row.period).usd += amount;
      } else if (row.unit === AI_USAGE_UNITS.flatTokens) {
        area.flatTokens += amount;
        const month = row.period.slice(0, 7);
        const byArea = areaFlatByMonth.get(month) ?? new Map<AreaKey, number>();
        byArea.set(row.key, (byArea.get(row.key) ?? 0) + amount);
        areaFlatByMonth.set(month, byArea);
        meteredFlatByMonth.set(month, (meteredFlatByMonth.get(month) ?? 0) + amount);
      }
      continue;
    }
    let agent = agentRows.get(row.key);
    if (!agent) {
      agent = {
        agentKey: row.key,
        label: agentDisplayName({ key: row.key }),
        tokens: 0,
        usd: 0,
        flatTokens: 0,
        turns: 0,
        skipped: 0,
      };
      agentRows.set(row.key, agent);
    }
    const areaBound = row.key.startsWith('area:');
    if (row.unit === AI_USAGE_UNITS.tokens) {
      agent.tokens += amount;
      agent.turns += row.count;
      if (!areaBound) {
        const d = dayEntry(row.period);
        d.tokens += amount;
        d.turns += row.count;
      }
    } else if (row.unit === AI_USAGE_UNITS.usd) {
      agent.usd += amount;
      if (!areaBound) dayEntry(row.period).usd += amount;
    } else if (row.unit === AI_USAGE_UNITS.flatTokens) {
      agent.flatTokens += amount;
    } else if (row.unit === AI_USAGE_UNITS.skipped) {
      agent.skipped += row.count;
    }
  }

  const monthlyFeeUsd = providerMonthlyFeeUsd(providerConfigs, 'canopywave');
  if (monthlyFeeUsd !== null && areaFlatByMonth.size > 0) {
    const companyFlat = await getFlatRateTokensByMonth(areaFlatByMonth.keys(), providerConfigs);
    for (const [month, byArea] of areaFlatByMonth) {
      const denominator = Math.max(companyFlat.get(month) ?? 0, meteredFlatByMonth.get(month) ?? 0);
      if (denominator <= 0) continue;
      for (const [areaKey, flat] of byArea) {
        areas.get(areaKey)!.amortizedUsd += (monthlyFeeUsd * flat) / denominator;
      }
    }
  }

  const areaList = [...areas.values()].map((a) => ({
    ...a,
    tokens: Math.round(a.tokens),
    flatTokens: Math.round(a.flatTokens),
    usd: round(a.usd, 4),
    amortizedUsd: round(a.amortizedUsd, 2),
  }));
  const agentList = [...agentRows.values()]
    .map((a) => ({ ...a, tokens: Math.round(a.tokens), flatTokens: Math.round(a.flatTokens), usd: round(a.usd, 4) }))
    .sort((a, b) => b.tokens - a.tokens);
  const nonAreaAgents = agentList.filter((a) => !a.agentKey.startsWith('area:'));

  return {
    from,
    to,
    monthlyFeeUsd,
    areas: areaList,
    agents: agentList,
    days: [...days.values()]
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((d) => ({ ...d, tokens: Math.round(d.tokens), usd: round(d.usd, 4) })),
    totals: {
      tokens: areaList.reduce((s, a) => s + a.tokens, 0) + nonAreaAgents.reduce((s, a) => s + a.tokens, 0),
      usd: round(areaList.reduce((s, a) => s + a.usd, 0) + nonAreaAgents.reduce((s, a) => s + a.usd, 0), 4),
      flatTokens:
        areaList.reduce((s, a) => s + a.flatTokens, 0) + nonAreaAgents.reduce((s, a) => s + a.flatTokens, 0),
      amortizedUsd: round(areaList.reduce((s, a) => s + a.amortizedUsd, 0), 2),
      turns: areaList.reduce((s, a) => s + a.turns, 0) + nonAreaAgents.reduce((s, a) => s + a.turns, 0),
      skipped: agentList.reduce((s, a) => s + a.skipped, 0),
    },
  };
}
