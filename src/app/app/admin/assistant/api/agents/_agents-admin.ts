import { z } from 'zod';
import {
  AGENT_LLM_TRIGGERS,
  AGENT_LLM_TRIGGER_LABELS,
  AGENT_SETTING_LIMITS,
  normalizeAgentSettings,
  type AgentSettings,
} from '@/modules/ai/agent-settings';
import type { AgentAiUsageRow, AgentBudgetStatus, AreaAiUsage } from '@/modules/agents/budget';
import { AGENT_KEYS, isAgentKey } from '@/modules/agents/identity-catalog';

// ---------------------------------------------------------------------------
// API response (GET /app/admin/assistant/api/agents)
// ---------------------------------------------------------------------------

export interface AgentsAdminIdentity {
  key: string;
  kind: string;
  areaKey: string | null;
  displayName: string;
  mode: string;
  dailyTokenBudget: number;
  monthlyCostBudgetUsd: number;
  maxTurnsPerCasePerDay: number;
  bot: { id: string; username: string; name: string; isActive: boolean; isBot: boolean } | null;
  /** Null when the budget could not be read. */
  budget: AgentBudgetStatus | null;
  /** Consumption of the selected range. */
  usage: Pick<AgentAiUsageRow, 'tokens' | 'usd' | 'flatTokens' | 'turns' | 'skipped'>;
}

export interface AgentsAdminData {
  settings: AgentSettings;
  /** Local day (agents time zone). */
  today: string;
  range: { from: string; to: string; days: number };
  identities: AgentsAdminIdentity[];
  /** Agents of the catalog without identity yet (created on the next server start). */
  missingAgents: Array<{ key: string; displayName: string }>;
  usage: AreaAiUsage;
  /** Month to date. */
  month: AreaAiUsage['totals'];
  events: AgentEventSummary;
  /** More agent events than the sample limit in the range: trigger counts are partial. */
  eventsTruncated: boolean;
}

/**
 * Pure pieces of "Asistente IA → Agentes y presupuestos" (plan 5.6): the PATCH
 * schema, the merge of the agents settings, the usage ranges and the
 * aggregation of the `ai.turn*` events into "principales disparos". Isomorphic:
 * the API route validates with it and the admin panel reuses the labels/types.
 */

export const AGENT_MODES = ['active', 'on_demand', 'paused'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const AGENT_MODE_LABELS: Readonly<Record<AgentMode, string>> = {
  active: 'Activa',
  on_demand: 'Bajo demanda',
  paused: 'En pausa',
};

export const BUDGET_STATE_LABELS = {
  ok: 'Normal',
  degraded: 'Degradada',
  exhausted: 'Agotada',
} as const;

export const AGENT_BUDGET_LIMITS = {
  dailyTokenBudget: { min: 0, max: 100_000_000 },
  monthlyCostBudgetUsd: { min: 0, max: 1_000_000 },
  maxTurnsPerCasePerDay: AGENT_SETTING_LIMITS.maxTurnsPerCasePerDay,
} as const;

export const USAGE_RANGE_DAYS = [7, 30, 90] as const;
export type UsageRangeDays = (typeof USAGE_RANGE_DAYS)[number];

export function parseRangeDays(value: string | null | undefined): UsageRangeDays {
  const n = Number(value);
  return (USAGE_RANGE_DAYS as readonly number[]).includes(n) ? (n as UsageRangeDays) : 30;
}

const DAY_MS = 86_400_000;

/** Inclusive local-day range that ends on `today` (YYYY-MM-DD). */
export function rangeEndingOn(today: string, days: number): { from: string; to: string } {
  const noon = Date.parse(`${today}T12:00:00Z`);
  const from = new Date(noon - (Math.max(1, days) - 1) * DAY_MS).toISOString().slice(0, 10);
  return { from, to: today };
}

export function monthStartOf(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

const identityPatchSchema = z
  .object({
    key: z.string().refine(isAgentKey, 'Agente desconocido'),
    mode: z.enum(AGENT_MODES).optional(),
    dailyTokenBudget: z
      .number()
      .int()
      .min(AGENT_BUDGET_LIMITS.dailyTokenBudget.min)
      .max(AGENT_BUDGET_LIMITS.dailyTokenBudget.max)
      .optional(),
    monthlyCostBudgetUsd: z
      .number()
      .min(AGENT_BUDGET_LIMITS.monthlyCostBudgetUsd.min)
      .max(AGENT_BUDGET_LIMITS.monthlyCostBudgetUsd.max)
      .optional(),
    maxTurnsPerCasePerDay: z
      .number()
      .int()
      .min(AGENT_BUDGET_LIMITS.maxTurnsPerCasePerDay.min)
      .max(AGENT_BUDGET_LIMITS.maxTurnsPerCasePerDay.max)
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.mode !== undefined ||
      v.dailyTokenBudget !== undefined ||
      v.monthlyCostBudgetUsd !== undefined ||
      v.maxTurnsPerCasePerDay !== undefined,
    'Indica qué cambiar del agente'
  );

export type AgentIdentityPatch = z.infer<typeof identityPatchSchema>;

const KNOWN_TRIGGERS = new Set<string>(AGENT_LLM_TRIGGERS);

export const agentsPatchSchema = z
  .object({
    agents: z
      .object({
        enabled: z.boolean().optional(),
        llmTriggers: z
          .record(z.boolean())
          .refine((value) => Object.keys(value).every((key) => KNOWN_TRIGGERS.has(key)), 'Disparo desconocido')
          .optional(),
      })
      .strict()
      .optional(),
    identities: z.array(identityPatchSchema).min(1).max(AGENT_KEYS.length).optional(),
  })
  .strict()
  .refine((v) => v.agents !== undefined || v.identities !== undefined, 'No hay cambios que guardar')
  .refine(
    (v) => !v.identities || new Set(v.identities.map((i) => i.key)).size === v.identities.length,
    'Cada agente puede aparecer una sola vez'
  );

export type AgentsPatch = z.infer<typeof agentsPatchSchema>;

/** New `AiSettings.agents` after a partial change (validated field by field). */
export function mergeAgentSettingsPatch(
  current: AgentSettings,
  patch: NonNullable<AgentsPatch['agents']>
): AgentSettings {
  return normalizeAgentSettings({
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    llmTriggers: { ...current.llmTriggers, ...(patch.llmTriggers ?? {}) },
  });
}

/** Prisma data of an identity change (only the given fields). */
export function identityUpdateData(patch: AgentIdentityPatch): {
  mode?: AgentMode;
  dailyTokenBudget?: number;
  monthlyCostBudgetUsd?: number;
  maxTurnsPerCasePerDay?: number;
} {
  return {
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.dailyTokenBudget !== undefined ? { dailyTokenBudget: patch.dailyTokenBudget } : {}),
    ...(patch.monthlyCostBudgetUsd !== undefined
      ? { monthlyCostBudgetUsd: Math.round(patch.monthlyCostBudgetUsd * 10_000) / 10_000 }
      : {}),
    ...(patch.maxTurnsPerCasePerDay !== undefined
      ? { maxTurnsPerCasePerDay: patch.maxTurnsPerCasePerDay }
      : {}),
  };
}

export interface IdentityDraft {
  mode: string;
  dailyTokenBudget: string;
  monthlyCostBudgetUsd: string;
  maxTurnsPerCasePerDay: string;
}

/**
 * Fields of the identity editor that changed, validated like the API. An empty
 * `patch` means there is nothing to save.
 */
export function buildIdentityDraftPatch(
  identity: Pick<AgentsAdminIdentity, 'mode' | 'dailyTokenBudget' | 'monthlyCostBudgetUsd' | 'maxTurnsPerCasePerDay'>,
  draft: IdentityDraft
): { ok: true; patch: Omit<AgentIdentityPatch, 'key'> } | { ok: false; error: string } {
  const patch: Omit<AgentIdentityPatch, 'key'> = {};
  if (draft.mode !== identity.mode) {
    if (!(AGENT_MODES as readonly string[]).includes(draft.mode)) return { ok: false, error: 'Modo inválido' };
    patch.mode = draft.mode as AgentMode;
  }
  const integer = (raw: string, limits: { min: number; max: number }, label: string) => {
    const value = Number(raw.trim());
    if (raw.trim() === '' || !Number.isInteger(value) || value < limits.min || value > limits.max) {
      return { error: `${label}: escribe un entero entre ${limits.min} y ${limits.max.toLocaleString('es-MX')}` };
    }
    return { value };
  };
  const daily = integer(draft.dailyTokenBudget, AGENT_BUDGET_LIMITS.dailyTokenBudget, 'Tokens diarios');
  if ('error' in daily) return { ok: false, error: daily.error as string };
  if (daily.value !== identity.dailyTokenBudget) patch.dailyTokenBudget = daily.value;

  const usd = Number(draft.monthlyCostBudgetUsd.trim());
  const usdLimits = AGENT_BUDGET_LIMITS.monthlyCostBudgetUsd;
  if (draft.monthlyCostBudgetUsd.trim() === '' || !Number.isFinite(usd) || usd < usdLimits.min || usd > usdLimits.max) {
    return { ok: false, error: `Costo mensual: escribe un monto entre 0 y ${usdLimits.max.toLocaleString('es-MX')} USD` };
  }
  const roundedUsd = Math.round(usd * 10_000) / 10_000;
  if (Math.abs(roundedUsd - identity.monthlyCostBudgetUsd) > 0.00005) patch.monthlyCostBudgetUsd = roundedUsd;

  const turns = integer(draft.maxTurnsPerCasePerDay, AGENT_BUDGET_LIMITS.maxTurnsPerCasePerDay, 'Turnos por expediente');
  if ('error' in turns) return { ok: false, error: turns.error as string };
  if (turns.value !== identity.maxTurnsPerCasePerDay) patch.maxTurnsPerCasePerDay = turns.value;

  return { ok: true, patch };
}

// ---------------------------------------------------------------------------
// "Principales disparos"
// ---------------------------------------------------------------------------

export const AGENT_TURN_EVENT_TYPES = ['ai.turn', 'ai.turn_skipped', 'ai.turn_failed'] as const;

export const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(AGENT_LLM_TRIGGERS.map((t) => [t, AGENT_LLM_TRIGGER_LABELS[t].label])),
  open: 'Al abrir',
  inbound: 'Actividad nueva',
};

export const SKIP_REASON_LABELS: Readonly<Record<string, string>> = {
  disabled: 'IA coordinada apagada',
  agents_disabled: 'IA coordinada apagada',
  trigger_disabled: 'Disparo apagado',
  paused: 'Agente en pausa',
  on_demand: 'Agente bajo demanda',
  quiet_hours: 'Horario silencioso',
  budget: 'Presupuesto',
  budget_exhausted: 'Presupuesto agotado',
  budget_degraded: 'Presupuesto degradado',
  human_attending: 'Una persona ya atendía',
  case_cap: 'Tope de turnos del expediente',
  max_turns: 'Tope de turnos del expediente',
  duplicate: 'Disparo repetido',
  // Slugs written by the dispatcher (src/modules/agents/dispatcher.ts, DispatchSkipReason).
  identity_missing: 'Identidad del agente sin sembrar',
  agent_paused: 'Agente en pausa',
  already_handled: 'El hilo ya se atendió después del evento',
  human_handling: 'Una persona ya atendía',
  case_turn_cap: 'Tope de turnos del expediente',
  duplicate_trigger: 'Disparo repetido',
};

const BUDGET_REASONS = new Set(['budget', 'budget_exhausted', 'budget_degraded']);

export interface TriggerStat {
  trigger: string;
  label: string;
  turns: number;
  skipped: number;
  failed: number;
  tokens: number;
}

export interface SkipReasonStat {
  reason: string;
  label: string;
  count: number;
}

export interface AgentEventSummary {
  triggers: TriggerStat[];
  skipReasons: SkipReasonStat[];
  skippedByBudget: number;
  turns: number;
  failed: number;
}

const SLUG = /^[a-z][a-z0-9_]{0,40}$/;

function slugOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && SLUG.test(value) ? value : fallback;
}

function tokensOf(payload: Record<string, unknown>): number {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return Math.round(n(payload.promptTokens) + n(payload.completionTokens));
}

/** Aggregates `ai.turn | ai.turn_skipped | ai.turn_failed` events (payloads are untrusted JSON). */
export function summarizeAgentEvents(
  events: readonly { type: string; payload: unknown }[],
  limit = 10
): AgentEventSummary {
  const triggers = new Map<string, TriggerStat>();
  const reasons = new Map<string, number>();
  let skippedByBudget = 0;
  let turns = 0;
  let failed = 0;
  for (const event of events) {
    const payload =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    const trigger = slugOf(payload.trigger, 'otro');
    let stat = triggers.get(trigger);
    if (!stat) {
      stat = { trigger, label: TRIGGER_LABELS[trigger] ?? (trigger === 'otro' ? 'Otro' : trigger.replace(/_/g, ' ')), turns: 0, skipped: 0, failed: 0, tokens: 0 };
      triggers.set(trigger, stat);
    }
    if (event.type === 'ai.turn') {
      stat.turns++;
      stat.tokens += tokensOf(payload);
      turns++;
    } else if (event.type === 'ai.turn_skipped') {
      stat.skipped++;
      const reason = slugOf(payload.reason, 'otro');
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (BUDGET_REASONS.has(reason)) skippedByBudget++;
    } else if (event.type === 'ai.turn_failed') {
      stat.failed++;
      failed++;
    }
  }
  return {
    triggers: [...triggers.values()]
      .sort((a, b) => b.turns + b.skipped + b.failed - (a.turns + a.skipped + a.failed) || a.trigger.localeCompare(b.trigger))
      .slice(0, limit),
    skipReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, label: SKIP_REASON_LABELS[reason] ?? (reason === 'otro' ? 'Otro' : reason.replace(/_/g, ' ')), count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    skippedByBudget,
    turns,
    failed,
  };
}
