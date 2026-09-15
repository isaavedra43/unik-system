/**
 * Settings of the coordinated AI layer (plan 5.4 / 5.6), isomorphic so the admin panel
 * can render the same labels and defaults the server validates with. Stored inside
 * `AiSettings.agents` (see ai-admin-config-service.ts).
 *
 * By decision of the user the AI is behind every user and area from minute one
 * (`enabled: true`); the brakes are budgets, quiet hours and per-case caps.
 */

/** Triggers on which a coordinator agent may call the model; rules and templates never need it. */
export const AGENT_LLM_TRIGGERS = [
  'interpret_request',
  'unblock',
  'triage',
  'replan_check',
  'stuck_review',
  'mention',
  'action_failed',
  'case_summary',
  'digest',
] as const;

export type AgentLlmTrigger = (typeof AGENT_LLM_TRIGGERS)[number];

export const AGENT_LLM_TRIGGER_LABELS: Record<AgentLlmTrigger, { label: string; description: string }> = {
  interpret_request: {
    label: 'Interpretar solicitudes',
    description: 'Una solicitud entre áreas trae texto libre o es una pregunta abierta.',
  },
  unblock: {
    label: 'Destrabar vencidos',
    description: 'Una solicitud o un trabajo venció y nadie lo ha movido.',
  },
  triage: { label: 'Clasificar incidencias', description: 'Se abrió una incidencia con descripción libre.' },
  replan_check: {
    label: 'Revisar replanificación',
    description: 'Una solicitud se bloqueó o el expediente cambió con nota del cliente.',
  },
  stuck_review: { label: 'Expedientes atorados', description: 'Un expediente lleva 24 h sin movimiento.' },
  mention: { label: 'Menciones en el chat', description: 'Alguien menciona con @ a la IA de un área.' },
  action_failed: {
    label: 'Acción aprobada que falló',
    description: 'Una propuesta aprobada no se pudo ejecutar.',
  },
  case_summary: {
    label: 'Resumen al entregar',
    description: 'Resumen del expediente entregado que tuvo incidencias.',
  },
  digest: { label: 'Resumen diario', description: 'Narrativa del pulso diario para Administración.' },
};

export interface AgentQuietHours {
  /** HH:MM (24 h). */
  start: string;
  /** HH:MM (24 h); earlier than `start` = crosses midnight. */
  end: string;
  /** IANA time zone. It also defines the "day" and the "month" of the AI budgets. */
  tz: string;
}

export interface AgentSettings {
  enabled: boolean;
  quietHours: AgentQuietHours;
  /** Automatic model turns per case per day (per agent). */
  maxTurnsPerCasePerDay: number;
  /** Tool iterations of one automatic turn. */
  maxIterationsPerAutoTurn: number;
  /** % of the daily token or monthly cost budget from which the agent degrades to on-demand. */
  degradeAtPct: number;
  /** % of the budget from which administrators get the daily budget notice. */
  alertAdminAtPct: number;
  llmTriggers: Record<AgentLlmTrigger, boolean>;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: true,
  quietHours: { start: '20:00', end: '07:00', tz: 'America/Mexico_City' },
  maxTurnsPerCasePerDay: 4,
  maxIterationsPerAutoTurn: 4,
  degradeAtPct: 80,
  alertAdminAtPct: 80,
  llmTriggers: {
    interpret_request: true,
    unblock: true,
    triage: true,
    replan_check: true,
    stuck_review: true,
    mention: true,
    action_failed: true,
    case_summary: true,
    digest: true,
  },
};

/** Ranges accepted for the numeric settings (the panel uses them as input limits). */
export const AGENT_SETTING_LIMITS = {
  maxTurnsPerCasePerDay: { min: 0, max: 50 },
  maxIterationsPerAutoTurn: { min: 1, max: 10 },
  degradeAtPct: { min: 1, max: 100 },
  alertAdminAtPct: { min: 1, max: 100 },
} as const;

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function intInRange(value: unknown, limits: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Field-by-field validation of a stored/incoming `agents` bag over the defaults. Pure. */
export function normalizeAgentSettings(stored: unknown): AgentSettings {
  const d = DEFAULT_AGENT_SETTINGS;
  const s = asRecord(stored);
  const qh = asRecord(s.quietHours);
  const triggers = asRecord(s.llmTriggers);
  const llmTriggers = { ...d.llmTriggers };
  for (const trigger of AGENT_LLM_TRIGGERS) {
    if (typeof triggers[trigger] === 'boolean') llmTriggers[trigger] = triggers[trigger] as boolean;
  }
  const tz = typeof qh.tz === 'string' ? qh.tz.trim() : '';
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : d.enabled,
    quietHours: {
      start: typeof qh.start === 'string' && HH_MM.test(qh.start) ? qh.start : d.quietHours.start,
      end: typeof qh.end === 'string' && HH_MM.test(qh.end) ? qh.end : d.quietHours.end,
      tz: tz && isValidTimeZone(tz) ? tz : d.quietHours.tz,
    },
    maxTurnsPerCasePerDay: intInRange(
      s.maxTurnsPerCasePerDay,
      AGENT_SETTING_LIMITS.maxTurnsPerCasePerDay,
      d.maxTurnsPerCasePerDay
    ),
    maxIterationsPerAutoTurn: intInRange(
      s.maxIterationsPerAutoTurn,
      AGENT_SETTING_LIMITS.maxIterationsPerAutoTurn,
      d.maxIterationsPerAutoTurn
    ),
    degradeAtPct: intInRange(s.degradeAtPct, AGENT_SETTING_LIMITS.degradeAtPct, d.degradeAtPct),
    alertAdminAtPct: intInRange(s.alertAdminAtPct, AGENT_SETTING_LIMITS.alertAdminAtPct, d.alertAdminAtPct),
    llmTriggers,
  };
}
