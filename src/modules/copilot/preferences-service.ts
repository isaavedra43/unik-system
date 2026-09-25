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
export type CopilotSurfaceKind = 'inbox' | 'chat';

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
});

export type AssistantPreferences = z.infer<typeof preferencesSchema>;
export type InboxCopilotMode = CopilotMode;

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
};

export async function getPreferences(userId: string): Promise<AssistantPreferences> {
  const row = await prisma.aiUserPreference.findUnique({ where: { userId } });
  if (!row) return { ...DEFAULT_PREFERENCES };
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
  });
  return parsed.success ? parsed.data : { ...DEFAULT_PREFERENCES };
}

export async function updatePreferences(
  userId: string,
  patch: Partial<AssistantPreferences>
): Promise<AssistantPreferences> {
  const current = await getPreferences(userId);
  const merged = preferencesSchema.parse({ ...current, ...patch });
  await prisma.aiUserPreference.upsert({
    where: { userId },
    create: { userId, ...merged, customInstructions: merged.customInstructions ?? null },
    update: { ...merged, customInstructions: merged.customInstructions ?? null },
  });
  return merged;
}

/** Proactivity of the copilot for one surface (inbox / internal chat). */
export function copilotModeFor(prefs: AssistantPreferences, surface: CopilotSurfaceKind): CopilotMode {
  return surface === 'inbox' ? prefs.inboxCopilotMode : prefs.chatCopilotMode;
}

export async function getCopilotMode(userId: string, surface: CopilotSurfaceKind): Promise<CopilotMode> {
  const prefs = await getPreferences(userId).catch(() => null);
  return prefs ? copilotModeFor(prefs, surface) : 'active';
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
        : '- Planificación automática: actúa directo en casi todo — proposePlan solo para trabajo de largo aliento (misiones, rutinas, tareas de 10+ pasos). Las acciones con efectos siempre pasan por aprobación al momento.'
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
