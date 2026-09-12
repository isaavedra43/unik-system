import { getStorageState, setStorageState } from '@/modules/storage/storage-settings-service';

/**
 * Voice runtime settings (task catalog, AI per account, recording default).
 * Stored as a simple JSON state row (`voice:settings`) next to the storage
 * settings. Retention values are NOT stored here: they come from the storage
 * settings (`recordingRetentionDays`, `transcriptRetentionDays`).
 */

export const VOICE_SETTINGS_KEY = 'voice:settings';

/** Catalog of task types the AI may create from a call, with labels for the UI. */
export const VOICE_TASK_TYPE_CATALOG: Array<{ type: string; label: string }> = [
  { type: 'callback', label: 'Devolver llamada' },
  { type: 'quote_request', label: 'Solicitud de cotización (preparación, sin envío)' },
  { type: 'info_request', label: 'Solicitud de información' },
  { type: 'order_followup', label: 'Seguimiento de pedido' },
  { type: 'complaint', label: 'Queja o incidencia' },
  { type: 'delivery_change', label: 'Cambio de entrega (requiere confirmación humana)' },
];

/** Types allowed by default. `delivery_change` stays off until an admin enables it. */
export const VOICE_ALLOWED_TASK_TYPES: string[] = [
  'callback',
  'quote_request',
  'info_request',
  'order_followup',
  'complaint',
];

export interface VoiceSettings {
  /** Task types the AI may create from calls (subset of the catalog). */
  allowedTaskTypes: string[];
  /** Per CommAccount id: true = the AI answers inbound calls for that account. */
  aiAnswerByAccount: Record<string, boolean>;
  /** Default for accounts not listed above (and for calls without account). */
  aiAnswerDefault: boolean;
  /** Copilot suggestions for human calls (listening + suggestions, never speaks). */
  copilotEnabled: boolean;
  /** Generate copilot suggestions every N transcript segments. */
  copilotEveryNSegments: number;
  /** Start recording automatically when a call becomes active. */
  recordByDefault: boolean;
  /** User that owns tasks created by the AI when no human user is on the call. */
  defaultTaskOwnerUserId: string | null;
  /** Max seconds an AI-answered call keeps the AI talking before offering a transfer. */
  maxAiAnswerSeconds: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  allowedTaskTypes: [...VOICE_ALLOWED_TASK_TYPES],
  aiAnswerByAccount: {},
  aiAnswerDefault: false,
  copilotEnabled: true,
  copilotEveryNSegments: 4,
  recordByDefault: false,
  defaultTaskOwnerUserId: null,
  maxAiAnswerSeconds: 600,
};

const CATALOG_TYPES = new Set(VOICE_TASK_TYPE_CATALOG.map((t) => t.type));

export function normalizeVoiceSettings(stored: unknown): VoiceSettings {
  const defaults = DEFAULT_VOICE_SETTINGS;
  if (!stored || typeof stored !== 'object')
    return { ...defaults, allowedTaskTypes: [...defaults.allowedTaskTypes] };
  const s = stored as Record<string, unknown>;
  const allowed = Array.isArray(s.allowedTaskTypes)
    ? (s.allowedTaskTypes as unknown[]).filter(
        (t): t is string => typeof t === 'string' && CATALOG_TYPES.has(t)
      )
    : [...defaults.allowedTaskTypes];
  const byAccount: Record<string, boolean> = {};
  if (s.aiAnswerByAccount && typeof s.aiAnswerByAccount === 'object') {
    for (const [k, v] of Object.entries(s.aiAnswerByAccount as Record<string, unknown>)) {
      if (typeof v === 'boolean' && /^[A-Za-z0-9_-]{1,64}$/.test(k)) byAccount[k] = v;
    }
  }
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
  return {
    allowedTaskTypes: allowed,
    aiAnswerByAccount: byAccount,
    aiAnswerDefault:
      typeof s.aiAnswerDefault === 'boolean' ? s.aiAnswerDefault : defaults.aiAnswerDefault,
    copilotEnabled:
      typeof s.copilotEnabled === 'boolean' ? s.copilotEnabled : defaults.copilotEnabled,
    copilotEveryNSegments: num(s.copilotEveryNSegments, defaults.copilotEveryNSegments, 1, 50),
    recordByDefault:
      typeof s.recordByDefault === 'boolean' ? s.recordByDefault : defaults.recordByDefault,
    defaultTaskOwnerUserId:
      typeof s.defaultTaskOwnerUserId === 'string' && s.defaultTaskOwnerUserId.length > 0
        ? s.defaultTaskOwnerUserId
        : null,
    maxAiAnswerSeconds: num(s.maxAiAnswerSeconds, defaults.maxAiAnswerSeconds, 30, 3600),
  };
}

export async function getVoiceSettings(): Promise<VoiceSettings> {
  const stored = await getStorageState<unknown>(VOICE_SETTINGS_KEY);
  return normalizeVoiceSettings(stored);
}

export async function updateVoiceSettings(patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  const current = await getVoiceSettings();
  const merged = normalizeVoiceSettings({ ...current, ...patch });
  await setStorageState(VOICE_SETTINGS_KEY, merged);
  return merged;
}

/** Whether the AI should answer inbound calls of `accountId` (null = no account). */
export function aiAnswersAccount(settings: VoiceSettings, accountId: string | null): boolean {
  if (accountId && accountId in settings.aiAnswerByAccount) {
    return settings.aiAnswerByAccount[accountId];
  }
  return settings.aiAnswerDefault;
}

export function isTaskTypeAllowed(settings: VoiceSettings, type: string): boolean {
  return settings.allowedTaskTypes.includes(type);
}
