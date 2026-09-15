import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import {
  listAiConfig,
  mergeWithDefaults,
  updateAiConfig,
} from '@/modules/ai/ai-admin-config-service';
import { recordAiAuditEvent } from '@/modules/ai/ai-audit';
import { budgetPeriod, checkAgentBudget, getAreaAiUsage } from '@/modules/agents/budget';
import { AGENT_KEYS, agentBotFor } from '@/modules/agents/identity-catalog';
import {
  AGENT_TURN_EVENT_TYPES,
  agentsPatchSchema,
  identityUpdateData,
  mergeAgentSettingsPatch,
  monthStartOf,
  parseRangeDays,
  rangeEndingOn,
  summarizeAgentEvents,
  type AgentsAdminData,
  type AgentsAdminIdentity,
} from './_agents-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Most recent agent events read for "principales disparos" (the counts say when they are partial). */
const EVENT_SAMPLE_LIMIT = 5000;
const DAY_MS = 86_400_000;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'assistant-admin-agents-api', event, ...extra }));

async function requireAssistantAdmin(): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const session = await getCurrentSession();
  if (!session) {
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  }
  if (!session.user.isSuperAdmin && !hasPermission(session.user, 'assistant.admin')) {
    return { response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }) };
  }
  return { user: session.user };
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * GET ?days=7|30|90 — "Agentes y presupuestos": identities with their mode,
 * budgets and budget state, AI consumption by area/day (range) and month to
 * date, "principales disparos" from the `ai.turn*` events and the agents
 * settings (global switch and model triggers).
 */
export async function GET(request: NextRequest) {
  const auth = await requireAssistantAdmin();
  if ('response' in auth) return auth.response;
  try {
    const days = parseRangeDays(new URL(request.url).searchParams.get('days'));
    const config = await listAiConfig();
    const settings = mergeWithDefaults(config.settings).agents;
    const now = new Date();
    const { day: today } = budgetPeriod(now, settings.quietHours.tz);
    const range = rangeEndingOn(today, days);

    const [identities, usage, month, events] = await Promise.all([
      prisma.agentIdentity.findMany(),
      getAreaAiUsage(range),
      getAreaAiUsage({ from: monthStartOf(today), to: today }),
      prisma.operationalEvent.findMany({
        where: {
          type: { in: [...AGENT_TURN_EVENT_TYPES] },
          occurredAt: { gte: new Date(now.getTime() - days * DAY_MS) },
        },
        select: { type: true, payload: true },
        orderBy: { occurredAt: 'desc' },
        take: EVENT_SAMPLE_LIMIT,
      }),
    ]);

    const bots =
      identities.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: identities.map((i) => i.botUserId) } },
            select: { id: true, username: true, name: true, isActive: true, isBot: true },
          })
        : [];
    const botById = new Map(bots.map((b) => [b.id, b]));
    const order = new Map<string, number>(AGENT_KEYS.map((key, index) => [key, index]));
    const sorted = [...identities].sort(
      (a, b) =>
        (order.get(a.key) ?? AGENT_KEYS.length) - (order.get(b.key) ?? AGENT_KEYS.length) ||
        a.key.localeCompare(b.key)
    );
    const budgets = await Promise.all(
      sorted.map((identity) =>
        checkAgentBudget(identity, { now }).catch((err: unknown) => {
          log('budget_failed', {
            agentKey: identity.key,
            message: err instanceof Error ? err.message : String(err),
          });
          return null;
        })
      )
    );
    const usageByAgent = new Map(usage.agents.map((a) => [a.agentKey, a]));

    const rows: AgentsAdminIdentity[] = sorted.map((identity, index) => {
      const bot = botById.get(identity.botUserId);
      const agentUsage = usageByAgent.get(identity.key);
      return {
        key: identity.key,
        kind: identity.kind,
        areaKey: identity.areaKey,
        displayName: identity.displayName,
        mode: identity.mode,
        dailyTokenBudget: identity.dailyTokenBudget,
        monthlyCostBudgetUsd: toNumber(identity.monthlyCostBudgetUsd),
        maxTurnsPerCasePerDay: identity.maxTurnsPerCasePerDay,
        bot: bot ?? null,
        budget: budgets[index] ?? null,
        usage: {
          tokens: agentUsage?.tokens ?? 0,
          usd: agentUsage?.usd ?? 0,
          flatTokens: agentUsage?.flatTokens ?? 0,
          turns: agentUsage?.turns ?? 0,
          skipped: agentUsage?.skipped ?? 0,
        },
      };
    });

    const known = new Set(identities.map((i) => i.key));
    const data: AgentsAdminData = {
      settings,
      today,
      range: { ...range, days },
      identities: rows,
      missingAgents: AGENT_KEYS.filter((key) => !known.has(key)).map((key) => ({
        key,
        displayName: agentBotFor(key)?.displayName ?? key,
      })),
      usage,
      month: month.totals,
      events: summarizeAgentEvents(events),
      eventsTruncated: events.length >= EVENT_SAMPLE_LIMIT,
    };
    return NextResponse.json(data);
  } catch (err) {
    log('load_failed', { message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'No se pudo cargar el consumo de los agentes' }, { status: 500 });
  }
}

/**
 * PATCH { agents?: {enabled?, llmTriggers?}, identities?: [{key, mode?,
 * dailyTokenBudget?, monthlyCostBudgetUsd?, maxTurnsPerCasePerDay?}] } —
 * edits the global switch, the triggers that may call the model and each
 * agent's mode and budgets. Audited as `assistant.agents_changed`.
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireAssistantAdmin();
  if ('response' in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido', code: 'invalid_request' }, { status: 400 });
  }
  const parsed = agentsPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Datos inválidos', code: 'invalid_request' },
      { status: 400 }
    );
  }
  const patch = parsed.data;

  try {
    if (patch.identities) {
      const keys = patch.identities.map((i) => i.key);
      const existing = await prisma.agentIdentity.findMany({
        where: { key: { in: keys } },
        select: { key: true },
      });
      const found = new Set(existing.map((e) => e.key));
      const missing = keys.find((key) => !found.has(key));
      if (missing) {
        return NextResponse.json(
          {
            error: `Aún no existe la identidad del agente ${missing}: se crea al reiniciar el servidor`,
            code: 'not_found',
          },
          { status: 404 }
        );
      }
      for (const identityPatch of patch.identities) {
        await prisma.agentIdentity.update({
          where: { key: identityPatch.key },
          data: identityUpdateData(identityPatch),
        });
      }
    }

    let settings = undefined;
    if (patch.agents) {
      const config = await listAiConfig();
      settings = mergeAgentSettingsPatch(mergeWithDefaults(config.settings).agents, patch.agents);
      await updateAiConfig({ settings: { agents: settings } });
    }

    await recordAiAuditEvent({
      actorUserId: auth.user.id,
      action: 'assistant.agents_changed',
      targetType: 'agent_identity',
      targetId: patch.identities?.length === 1 ? patch.identities[0].key : 'global',
      metadata: {
        identities: (patch.identities ?? []).map((i) => ({
          key: i.key,
          changes: identityUpdateData(i),
        })),
        agents: patch.agents
          ? {
              ...(patch.agents.enabled !== undefined ? { enabled: patch.agents.enabled } : {}),
              llmTriggers: patch.agents.llmTriggers ?? {},
            }
          : null,
      },
    });

    return NextResponse.json({ ok: true, ...(settings ? { settings } : {}) });
  } catch (err) {
    log('save_failed', { message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'No se pudieron guardar los cambios' }, { status: 500 });
  }
}
