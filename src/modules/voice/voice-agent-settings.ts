import { z } from 'zod';
import { getStorageState, setStorageState } from '@/modules/storage/storage-settings-service';

/**
 * Voice agent settings (persona, model, voice, allowed information, prompt).
 * Stored as a JSON state row (`voice:agent`) next to the other voice settings
 * and read on every call when UNIK builds the worker's brief, so a change here
 * applies to the next call without redeploying anything.
 *
 * What is NOT configurable on purpose: the honesty rule (the agent never
 * claims to be a person and acknowledges being a virtual assistant when
 * sincerely asked). It is appended after any custom prompt.
 */

export const VOICE_AGENT_SETTINGS_KEY = 'voice:agent';

/** Realtime models the worker can run (speech-to-speech). */
export const VOICE_AGENT_MODELS: Array<{ id: string; label: string; hint: string }> = [
  {
    id: 'gpt-realtime',
    label: 'GPT Realtime (recomendado)',
    hint: 'Máxima calidad de voz y comprensión; el más caro por minuto.',
  },
  {
    id: 'gpt-realtime-mini',
    label: 'GPT Realtime Mini',
    hint: 'Más económico y rápido; algo menos preciso en conversaciones complejas.',
  },
  {
    id: 'gpt-4o-realtime-preview',
    label: 'GPT-4o Realtime (preview)',
    hint: 'Generación anterior; útil si tu cuenta aún no tiene acceso a gpt-realtime.',
  },
];

export const VOICE_AGENT_VOICES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'marin', label: 'Marin', hint: 'Femenina, cálida y natural (recomendada).' },
  { id: 'cedar', label: 'Cedar', hint: 'Masculina, serena y clara (recomendada).' },
  { id: 'coral', label: 'Coral', hint: 'Femenina, amable.' },
  { id: 'sage', label: 'Sage', hint: 'Femenina, tranquila.' },
  { id: 'shimmer', label: 'Shimmer', hint: 'Femenina, enérgica.' },
  { id: 'alloy', label: 'Alloy', hint: 'Neutra.' },
  { id: 'ash', label: 'Ash', hint: 'Masculina, cercana.' },
  { id: 'ballad', label: 'Ballad', hint: 'Masculina, suave.' },
  { id: 'echo', label: 'Echo', hint: 'Masculina, firme.' },
  { id: 'verse', label: 'Verse', hint: 'Masculina, expresiva.' },
];

export const VOICE_AGENT_STT_MODELS: Array<{ id: string; label: string }> = [
  { id: 'gpt-4o-transcribe', label: 'GPT-4o Transcribe (más preciso)' },
  { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o Mini Transcribe (rápido)' },
  { id: 'whisper-1', label: 'Whisper' },
];

/**
 * Information domains the agent may consult, mapped to registry tools. The
 * tools must also be in VOICE_TOOL_ALLOWLIST (read-only); this only narrows.
 */
export const VOICE_AGENT_DATA_DOMAINS: Array<{
  key: string;
  label: string;
  hint: string;
  tools: string[];
}> = [
  {
    key: 'orders',
    label: 'Pedidos y entregas',
    hint: 'Estado de pedidos, fechas y seguimiento del cliente verificado.',
    tools: ['searchSalesOrders', 'getSalesOrderDetail'],
  },
  {
    key: 'packages',
    label: 'Paquetes y envíos',
    hint: 'Guías y estatus de paquetes del cliente verificado.',
    tools: ['queryPackages', 'getPackageDetail'],
  },
  {
    key: 'products',
    label: 'Catálogo de productos',
    hint: 'Nombres, descripciones y disponibilidad general. Nunca precios comprometidos.',
    tools: ['queryProducts', 'getProductDetail', 'getProductSearch', 'getProductCatalog'],
  },
  {
    key: 'contacts',
    label: 'Directorio de clientes',
    hint: 'Buscar fichas de clientes. Desactivado por defecto: expone datos de terceros.',
    tools: ['queryContacts', 'getContactDetail'],
  },
  {
    key: 'library',
    label: 'Biblioteca aprobada',
    hint: 'Documentos aprobados por la empresa (políticas, FAQ, horarios).',
    tools: ['searchKnowledgeLibrary'],
  },
  {
    key: 'time',
    label: 'Fecha y hora',
    hint: 'Permite responder "qué día es" y calcular plazos.',
    tools: ['getSystemTime'],
  },
];

export const voiceAgentSettingsSchema = z.object({
  /** Name the assistant introduces herself/himself with. */
  personaName: z.string().trim().min(1).max(40),
  /** Company name used in greetings and rules. */
  companyName: z.string().trim().min(1).max(80),
  /** Short description of what the company does (helps the model stay on topic). */
  companyDescription: z.string().trim().max(600),
  model: z.string().trim().min(1).max(60),
  voice: z.string().trim().min(1).max(40),
  /** Speaking speed multiplier accepted by the realtime API (0.5–1.5). */
  speed: z.number().min(0.5).max(1.5),
  /** Reasoning effort for models that support it. */
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']),
  /** How eagerly the model takes its turn (semantic VAD). */
  turnEagerness: z.enum(['auto', 'low', 'medium', 'high']),
  language: z.enum(['es-MX', 'es', 'en', 'auto']),
  /** usted / tú */
  formality: z.enum(['usted', 'tu']),
  /** Personality in one or two adjectives lines the model follows. */
  personalityTraits: z.string().trim().max(400),
  /** Greeting template; {nombre} is replaced with the contact name when known. */
  greetingTemplate: z.string().trim().min(3).max(300),
  /** Public facts the agent MAY share (address, hours, website, general policies). */
  publicInfo: z.string().trim().max(3000),
  /** Topics the agent must decline politely, one per line. */
  forbiddenTopics: z.string().trim().max(2000),
  /** Extra instructions appended to the default prompt. */
  customInstructions: z.string().trim().max(6000),
  /** Replace the default prompt entirely with customInstructions (honesty rule still appended). */
  replaceDefaultPrompt: z.boolean(),
  /** Require name + phone match (or order number + company) before sharing account data. */
  requireIdentityVerification: z.boolean(),
  /** Data domains the agent may consult. */
  allowedDomains: z.array(z.string()).max(20),
  /** Transcription model for the caller's speech. */
  sttModel: z.string().trim().min(1).max(60),
  noiseReduction: z.enum(['near_field', 'far_field', 'off']),
  /** Seconds of silence before a courtesy check; a second silence ends the call. */
  silenceCheckSeconds: z.number().int().min(5).max(60),
  /** Offer a human when the caller is upset or asks for one. */
  transferOnRequest: z.boolean(),
});

export type VoiceAgentSettings = z.infer<typeof voiceAgentSettingsSchema>;

export const DEFAULT_VOICE_AGENT_SETTINGS: VoiceAgentSettings = {
  personaName: process.env.VOICE_AGENT_PERSONA_NAME?.trim() || 'Valeria',
  companyName: 'UNIK',
  companyDescription: '',
  model: process.env.VOICE_AGENT_MODEL?.trim() || 'gpt-realtime',
  voice: process.env.VOICE_AGENT_VOICE?.trim() || 'marin',
  speed: 1,
  reasoningEffort: 'low',
  turnEagerness: 'auto',
  language: 'es-MX',
  formality: 'usted',
  personalityTraits:
    'Cálida, paciente, profesional y resolutiva. Habla como una persona real, no como un menú.',
  greetingTemplate:
    'Gracias por llamar a {empresa}, le atiende {asistente}. ¿Hablo con {nombre}? ¿En qué le puedo ayudar el día de hoy?',
  publicInfo: '',
  forbiddenTopics: '',
  customInstructions: '',
  replaceDefaultPrompt: false,
  requireIdentityVerification: true,
  allowedDomains: ['orders', 'packages', 'products', 'library', 'time'],
  sttModel: 'gpt-4o-transcribe',
  noiseReduction: 'far_field',
  silenceCheckSeconds: 10,
  transferOnRequest: true,
};

export function normalizeVoiceAgentSettings(stored: unknown): VoiceAgentSettings {
  const parsed = voiceAgentSettingsSchema
    .partial()
    .safeParse(stored && typeof stored === 'object' ? stored : {});
  const partial = parsed.success ? parsed.data : {};
  const merged = { ...DEFAULT_VOICE_AGENT_SETTINGS, ...partial };
  const knownDomains = new Set(VOICE_AGENT_DATA_DOMAINS.map((d) => d.key));
  merged.allowedDomains = merged.allowedDomains.filter((d) => knownDomains.has(d));
  return merged;
}

export async function getVoiceAgentSettings(): Promise<VoiceAgentSettings> {
  const stored = await getStorageState<unknown>(VOICE_AGENT_SETTINGS_KEY);
  return normalizeVoiceAgentSettings(stored);
}

export async function updateVoiceAgentSettings(
  patch: Partial<VoiceAgentSettings>
): Promise<VoiceAgentSettings> {
  const current = await getVoiceAgentSettings();
  const next = normalizeVoiceAgentSettings({ ...current, ...patch });
  await setStorageState(VOICE_AGENT_SETTINGS_KEY, next);
  return next;
}

/** Registry tools enabled by the selected domains. */
export function toolsAllowedBySettings(settings: VoiceAgentSettings): Set<string> {
  const out = new Set<string>();
  for (const domain of VOICE_AGENT_DATA_DOMAINS) {
    if (settings.allowedDomains.includes(domain.key)) domain.tools.forEach((t) => out.add(t));
  }
  return out;
}

export function renderGreeting(settings: VoiceAgentSettings, contactName: string | null): string {
  const base = settings.greetingTemplate
    .replaceAll('{empresa}', settings.companyName)
    .replaceAll('{asistente}', settings.personaName);
  if (!base.includes('{nombre}')) return base;
  if (contactName) return base.replaceAll('{nombre}', contactName);
  // Unknown caller: drop the sentence that mentions the name and ask instead.
  const stripped = base
    .replace(/[^.!?]*\{nombre\}[^.!?]*[.!?]?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return `${stripped} ¿Con quién tengo el gusto?`.replace(/\s{2,}/g, ' ').trim();
}
