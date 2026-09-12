import { getStorageState, setStorageState } from '@/modules/storage/storage-settings-service';

/**
 * Voice runtime settings (AI per account, copilot, recording default).
 * Stored as a simple JSON state row (`voice:settings`) next to the storage
 * settings. Retention values are NOT stored here: they come from the storage
 * settings (`recordingRetentionDays`, `transcriptRetentionDays`).
 */

export const VOICE_SETTINGS_KEY = 'voice:settings';

export interface VoiceSettings {
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
  /** Max seconds an AI-answered call keeps the AI talking before offering a transfer. */
  maxAiAnswerSeconds: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  aiAnswerByAccount: {},
  aiAnswerDefault: false,
  copilotEnabled: true,
  copilotEveryNSegments: 4,
  recordByDefault: false,
  maxAiAnswerSeconds: 600,
};

export function normalizeVoiceSettings(stored: unknown): VoiceSettings {
  const defaults = DEFAULT_VOICE_SETTINGS;
  if (!stored || typeof stored !== 'object') return { ...defaults };
  const s = stored as Record<string, unknown>;
  const byAccount: Record<string, boolean> = {};
  if (s.aiAnswerByAccount && typeof s.aiAnswerByAccount === 'object') {
    for (const [k, v] of Object.entries(s.aiAnswerByAccount as Record<string, unknown>)) {
      if (typeof v === 'boolean' && /^[A-Za-z0-9_-]{1,64}$/.test(k)) byAccount[k] = v;
    }
  }
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
  return {
    aiAnswerByAccount: byAccount,
    aiAnswerDefault:
      typeof s.aiAnswerDefault === 'boolean' ? s.aiAnswerDefault : defaults.aiAnswerDefault,
    copilotEnabled:
      typeof s.copilotEnabled === 'boolean' ? s.copilotEnabled : defaults.copilotEnabled,
    copilotEveryNSegments: num(s.copilotEveryNSegments, defaults.copilotEveryNSegments, 1, 50),
    recordByDefault:
      typeof s.recordByDefault === 'boolean' ? s.recordByDefault : defaults.recordByDefault,
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
