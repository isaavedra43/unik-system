import { z } from 'zod';
import { prisma } from '@/lib/prisma';

/**
 * Per-user assistant preferences: operating mode and personalization.
 *
 * Modes:
 * - paused: the assistant answers and drafts but never calls tools with side
 *   effects (external_send / business_write / destructive are hidden).
 * - on_request: default. Side-effecting actions produce approval proposals.
 * - autonomous_verified: the assistant may chain tools and verify results by
 *   itself; side effects STILL require human approval (proposals).
 */

export const preferencesSchema = z.object({
  mode: z.enum(['paused', 'on_request', 'autonomous_verified']).default('on_request'),
  tone: z.enum(['profesional', 'cercano', 'directo']).default('profesional'),
  language: z.enum(['es', 'en']).default('es'),
  depth: z.enum(['breve', 'normal', 'detallado']).default('normal'),
  format: z.enum(['markdown', 'texto', 'tablas']).default('markdown'),
  customInstructions: z.string().max(2000).nullable().optional(),
  memoryEnabled: z.boolean().default(true),
  /**
   * Inbox copilot: active = analyzes on its own when a conversation opens or the
   * customer writes; on_demand = only when asked; paused = completely off.
   */
  inboxCopilotMode: z.enum(['active', 'on_demand', 'paused']).default('active'),
});

export type AssistantPreferences = z.infer<typeof preferencesSchema>;
export type InboxCopilotMode = AssistantPreferences['inboxCopilotMode'];

export const DEFAULT_PREFERENCES: AssistantPreferences = {
  mode: 'on_request',
  tone: 'profesional',
  language: 'es',
  depth: 'normal',
  format: 'markdown',
  customInstructions: null,
  memoryEnabled: true,
  inboxCopilotMode: 'active',
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

/** Prompt fragment describing how the assistant must behave for this user. Pure. */
export function buildPreferencesPrompt(prefs: AssistantPreferences): string {
  const lines: string[] = ['## Personalización del usuario'];
  const modeText =
    prefs.mode === 'paused'
      ? 'MODO PAUSADO: responde, analiza y redacta borradores, pero NO ejecutes acciones con efectos (envíos, cambios comerciales, eliminaciones): esas herramientas no están disponibles ahora; ofrece prepararlas cuando el usuario reactive el modo.'
      : prefs.mode === 'autonomous_verified'
        ? 'MODO AUTÓNOMO CON VERIFICACIÓN: puedes encadenar varias consultas sin pedir permiso intermedio y debes verificar tus resultados (contrastar totales, revisar diagnósticos) antes de responder. Las acciones con efectos siguen requiriendo aprobación humana explícita.'
        : 'MODO A PETICIÓN: ejecuta consultas para responder lo que se te pide; propone acciones con efectos y espera la aprobación del usuario.';
  lines.push(`- ${modeText}`);
  lines.push(
    `- Tono: ${prefs.tone === 'cercano' ? 'cercano y cálido, sin perder precisión' : prefs.tone === 'directo' ? 'directo y conciso, sin rodeos' : 'profesional y claro'}.`
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
