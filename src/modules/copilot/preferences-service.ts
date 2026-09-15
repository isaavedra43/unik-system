import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';

/**
 * Per-user assistant preferences: ONE configuration for every AI surface
 * (assistant chat, inbox copilot, internal-chat copilot, voice, widget).
 * They are edited only in "Asistente IA → Preferencias y memoria".
 *
 * Working mode (applies everywhere):
 * - paused: the assistant answers and drafts but never calls tools with side
 *   effects (external_send / business_write / destructive are hidden).
 * - on_request: default. Side-effecting actions produce approval proposals.
 * - autonomous_verified: the assistant may chain tools and verify results by
 *   itself; side effects STILL require human approval (proposals).
 *
 * Copilot proactivity (per surface, same vocabulary):
 * - active: analyzes on its own when a conversation opens or someone writes.
 * - on_demand: only when the user asks.
 * - paused: the side panel is off for that surface.
 */

export const COPILOT_MODES = ['active', 'on_demand', 'paused'] as const;
export const PLAN_MODES = ['auto', 'always', 'never'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];
export type CopilotMode = (typeof COPILOT_MODES)[number];
export const COPILOT_SURFACE_KINDS = ['inbox', 'chat', 'area', 'case', 'mywork', 'control_tower'] as const;
export type CopilotSurfaceKind = (typeof COPILOT_SURFACE_KINDS)[number];

/**
 * Surfaces whose proactivity lives in `AiUserPreference.surfaceModes` (Json).
 * Inbox and internal chat keep their two literal columns.
 */
export const SURFACE_MODE_KINDS = ['area', 'case', 'mywork', 'control_tower'] as const;
export type SurfaceModeKind = (typeof SURFACE_MODE_KINDS)[number];
export type SurfaceModes = Record<SurfaceModeKind, CopilotMode>;

/** "Mi trabajo" analyzes on its own; the shared area/case/control tower panels wait to be asked. */
export const DEFAULT_SURFACE_MODES: Readonly<SurfaceModes> = {
  area: 'on_demand',
  case: 'on_demand',
  mywork: 'active',
  control_tower: 'on_demand',
};

export function isSurfaceModeKind(value: unknown): value is SurfaceModeKind {
  return typeof value === 'string' && (SURFACE_MODE_KINDS as readonly string[]).includes(value);
}

function isCopilotMode(value: unknown): value is CopilotMode {
  return typeof value === 'string' && (COPILOT_MODES as readonly string[]).includes(value);
}

/** Stored Json → complete map (unknown kinds dropped, invalid or missing modes → default). Pure. */
export function normalizeSurfaceModes(raw: unknown): SurfaceModes {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_SURFACE_MODES };
  for (const kind of SURFACE_MODE_KINDS) {
    if (isCopilotMode(source[kind])) out[kind] = source[kind];
  }
  return out;
}

const copilotModeEnum = z.enum(COPILOT_MODES);

/** Stored/complete surface modes: tolerant (bad values fall back to the defaults). */
const surfaceModesSchema = z
  .unknown()
  .transform((value) => normalizeSurfaceModes(value))
  .default({ ...DEFAULT_SURFACE_MODES });

/**
 * Partial update of surface modes: `{surfaceModes: {[kind]: mode}}`. Accepts
 * every surface kind; `inbox`/`chat` are written to their literal columns.
 */
export const surfaceModesPatchSchema = z
  .object({
    inbox: copilotModeEnum,
    chat: copilotModeEnum,
    area: copilotModeEnum,
    case: copilotModeEnum,
    mywork: copilotModeEnum,
    control_tower: copilotModeEnum,
  })
  .partial()
  .strict();
export type SurfaceModesPatch = z.infer<typeof surfaceModesPatchSchema>;

export const preferencesSchema = z.object({
  mode: z.enum(['paused', 'on_request', 'autonomous_verified']).default('on_request'),
  tone: z.enum(['profesional', 'cercano', 'directo']).default('profesional'),
  language: z.enum(['es', 'en']).default('es'),
  depth: z.enum(['breve', 'normal', 'detallado']).default('normal'),
  format: z.enum(['markdown', 'texto', 'tablas']).default('markdown'),
  customInstructions: z.string().max(2000).nullable().optional(),
  memoryEnabled: z.boolean().default(true),
  /** Inbox (Bandeja externa) copilot proactivity. */
  inboxCopilotMode: z.enum(COPILOT_MODES).default('active'),
  /** Internal chat copilot proactivity. */
  chatCopilotMode: z.enum(COPILOT_MODES).default('active'),
  /** Plan-then-execute: auto (solo tareas complejas) | always | never. */
  planMode: z.enum(PLAN_MODES).default('auto'),
  /** Proactivity of the operations surfaces (área, expediente, Mi trabajo, Control Tower). */
  surfaceModes: surfaceModesSchema,
});

export type AssistantPreferences = z.infer<typeof preferencesSchema>;
export type InboxCopilotMode = CopilotMode;

/**
 * PATCH body of `/app/assistant/api/preferences`: every field optional and
 * `surfaceModes` partial, so changing one surface never resets the others.
 */
export const preferencesPatchSchema = preferencesSchema
  .omit({ surfaceModes: true })
  .partial()
  .extend({ surfaceModes: surfaceModesPatchSchema.optional() });
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

export const DEFAULT_PREFERENCES: AssistantPreferences = {
  mode: 'on_request',
  tone: 'profesional',
  language: 'es',
  depth: 'normal',
  format: 'markdown',
  customInstructions: null,
  memoryEnabled: true,
  inboxCopilotMode: 'active',
  chatCopilotMode: 'active',
  planMode: 'auto',
  surfaceModes: { ...DEFAULT_SURFACE_MODES },
};

function defaultPreferences(): AssistantPreferences {
  return { ...DEFAULT_PREFERENCES, surfaceModes: { ...DEFAULT_SURFACE_MODES } };
}

export async function getPreferences(userId: string): Promise<AssistantPreferences> {
  const row = await prisma.aiUserPreference.findUnique({ where: { userId } });
  if (!row) return defaultPreferences();
  const parsed = preferencesSchema.safeParse({
    mode: row.mode,
    tone: row.tone,
    language: row.language,
    depth: row.depth,
    format: row.format,
    customInstructions: row.customInstructions,
    memoryEnabled: row.memoryEnabled,
    inboxCopilotMode: row.inboxCopilotMode,
    chatCopilotMode: row.chatCopilotMode,
    planMode: row.planMode,
    surfaceModes: row.surfaceModes,
  });
  return parsed.success ? parsed.data : defaultPreferences();
}

/**
 * Current preferences + patch. `surfaceModes` is FUSED (only the kinds in the
 * patch change); `surfaceModes.inbox|chat` are written to their literal
 * columns, and an explicit `inboxCopilotMode`/`chatCopilotMode` wins. Pure.
 */
export function mergePreferences(current: AssistantPreferences, patch: PreferencesPatch): AssistantPreferences {
  const { surfaceModes: modesPatch, ...rest } = patch;
  const { inbox, chat, ...operationsModes } = modesPatch ?? {};
  const defined = <T extends Record<string, unknown>>(obj: T): Partial<T> =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
  return preferencesSchema.parse({
    ...current,
    ...(inbox ? { inboxCopilotMode: inbox } : {}),
    ...(chat ? { chatCopilotMode: chat } : {}),
    ...defined(rest),
    surfaceModes: { ...normalizeSurfaceModes(current.surfaceModes), ...defined(operationsModes) },
  });
}

export async function updatePreferences(userId: string, patch: PreferencesPatch): Promise<AssistantPreferences> {
  const current = await getPreferences(userId);
  const merged = mergePreferences(current, patch);
  const data = {
    ...merged,
    customInstructions: merged.customInstructions ?? null,
    surfaceModes: merged.surfaceModes as unknown as Prisma.InputJsonValue,
  };
  await prisma.aiUserPreference.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return merged;
}

/** Proactivity of the copilot for one surface: inbox/chat read their columns, the rest `surfaceModes`. */
export function copilotModeFor(prefs: AssistantPreferences, surface: CopilotSurfaceKind): CopilotMode {
  if (surface === 'inbox') return prefs.inboxCopilotMode;
  if (surface === 'chat') return prefs.chatCopilotMode;
  const stored = prefs.surfaceModes?.[surface];
  return isCopilotMode(stored) ? stored : DEFAULT_SURFACE_MODES[surface];
}

/** Mode used when preferences cannot be read (inbox/chat keep their historical 'active'). */
export function fallbackCopilotMode(surface: CopilotSurfaceKind): CopilotMode {
  return surface === 'inbox' || surface === 'chat' ? 'active' : DEFAULT_SURFACE_MODES[surface];
}

export async function getCopilotMode(userId: string, surface: CopilotSurfaceKind): Promise<CopilotMode> {
  const prefs = await getPreferences(userId).catch(() => null);
  return prefs ? copilotModeFor(prefs, surface) : fallbackCopilotMode(surface);
}

export const COPILOT_MODE_LABELS: Record<CopilotMode, { label: string; hint: string }> = {
  active: {
    label: 'Activo',
    hint: 'Analiza por su cuenta al abrir la conversación y cada vez que alguien escribe.',
  },
  on_demand: {
    label: 'A petición',
    hint: 'Solo actúa cuando tú le hablas.',
  },
  paused: {
    label: 'Apagado',
    hint: 'El panel del copiloto queda en pausa en esa superficie.',
  },
};

export const PLAN_MODE_LABELS: Record<PlanMode, { label: string; hint: string }> = {
  auto: { label: 'Automático', hint: 'Propone un plan solo en tareas complejas (varios pasos o fuentes) y espera tu confirmación.' },
  always: { label: 'Siempre planear', hint: 'Antes de cualquier tarea con tools muestra el plan y espera "Ejecutar plan".' },
  never: { label: 'Nunca', hint: 'Actúa directo; las acciones con efectos siguen pidiendo aprobación.' },
};

/** Prompt fragment describing how the assistant must behave for this user. Pure. */
export function buildPreferencesPrompt(prefs: AssistantPreferences): string {
  const lines: string[] = ['## Personalización del usuario (aplica en todas las superficies: asistente, bandeja, chat interno, voz)'];
  const modeText =
    prefs.mode === 'paused'
      ? 'MODO PAUSADO: responde, analiza y redacta borradores, pero NO ejecutes acciones con efectos (envíos, cambios comerciales, eliminaciones): esas herramientas no están disponibles ahora; ofrece prepararlas cuando el usuario reactive el modo.'
      : prefs.mode === 'autonomous_verified'
        ? 'MODO AUTÓNOMO CON VERIFICACIÓN: puedes encadenar varias consultas sin pedir permiso intermedio y debes verificar tus resultados (contrastar totales, revisar diagnósticos) antes de responder. Las acciones con efectos siguen requiriendo aprobación humana explícita.'
        : 'MODO A PETICIÓN: ejecuta consultas para responder lo que se te pide; propone acciones con efectos y espera la aprobación del usuario.';
  lines.push(`- ${modeText}`);
  lines.push(
    `- Copiloto en bandeja externa: ${COPILOT_MODE_LABELS[prefs.inboxCopilotMode].label.toLowerCase()} · en chat interno: ${COPILOT_MODE_LABELS[prefs.chatCopilotMode].label.toLowerCase()}. El usuario cambia esto en "Asistente IA → Preferencias y memoria"; si te pide cambiar el modo, indícale ese lugar.`
  );
  lines.push(
    `- Tono: ${prefs.tone === 'cercano' ? 'cercano y cálido, sin perder precisión' : prefs.tone === 'directo' ? 'directo y conciso, sin rodeos' : 'profesional y claro'}.`
  );
  lines.push(
    prefs.planMode === 'always'
      ? '- PLANEAR SIEMPRE: antes de ejecutar cualquier tarea que use tools (salvo una consulta puntual de un solo paso), llama proposePlan y espera a que el usuario confirme con "Ejecutar plan".'
      : prefs.planMode === 'never'
        ? '- Sin planificación previa: ejecuta directo (las acciones con efectos siguen pasando por aprobación).'
        : '- Planificación automática: en tareas complejas (3+ pasos, varias fuentes, envíos múltiples) llama proposePlan primero y espera confirmación; en consultas simples actúa directo.'
  );
  lines.push(`- Idioma de respuesta: ${prefs.language === 'en' ? 'inglés' : 'español'}.`);
  lines.push(
    `- Profundidad: ${prefs.depth === 'breve' ? 'respuestas breves, solo lo esencial' : prefs.depth === 'detallado' ? 'respuestas detalladas con contexto, supuestos y siguientes pasos' : 'nivel de detalle normal'}.`
  );
  lines.push(
    `- Formato preferido: ${prefs.format === 'texto' ? 'texto corrido, evita tablas y listas salvo que el usuario las pida' : prefs.format === 'tablas' ? 'tablas siempre que haya más de dos datos comparables' : 'markdown con tablas y listas cuando ayuden'}.`
  );
  if (prefs.customInstructions && prefs.customInstructions.trim().length > 0) {
    lines.push(
      `- Instrucciones del usuario: ${prefs.customInstructions.trim().replace(/\s+/g, ' ').slice(0, 2000)}`
    );
  }
  return lines.join('\n');
}

/** Tool effects hidden from the model in paused mode. */
export const PAUSED_MODE_HIDDEN_EFFECTS = new Set([
  'external_send',
  'business_write',
  'destructive',
]);
