import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  NOTIFICATION_CATALOG,
  NOTIFICATION_CATEGORIES,
  getCategoryDefinition,
  isNotificationCategory,
  type NotificationCategory,
} from './catalog';

/**
 * Per-user notification settings. The row is created lazily with the catalog
 * defaults; `preferences` only stores explicit overrides.
 */

export interface CategoryPreference {
  inApp: boolean;
  push: boolean;
}

export interface NotificationSettings {
  pushEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
  mutedUntil: string | null;
  categories: Record<NotificationCategory, CategoryPreference>;
}

type PreferencesJson = Partial<Record<string, Partial<CategoryPreference>>>;

function parsePreferences(value: Prisma.JsonValue | null | undefined): PreferencesJson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as PreferencesJson;
}

function resolveCategories(
  overrides: PreferencesJson
): Record<NotificationCategory, CategoryPreference> {
  const out = {} as Record<NotificationCategory, CategoryPreference>;
  for (const def of NOTIFICATION_CATALOG) {
    const o = overrides[def.key] ?? {};
    out[def.key] = {
      inApp: def.lockedInApp ? true : typeof o.inApp === 'boolean' ? o.inApp : def.defaults.inApp,
      push: typeof o.push === 'boolean' ? o.push : def.defaults.push,
    };
  }
  return out;
}

/** `db`: the caller's transaction client when there is one (never a second connection inside it). */
export async function getNotificationSettings(
  userId: string,
  db: Prisma.TransactionClient = prisma
): Promise<NotificationSettings> {
  const row = await db.userNotificationSettings.findUnique({ where: { userId } });
  return {
    pushEnabled: row?.pushEnabled ?? true,
    quietHoursStart: row?.quietHoursStart ?? null,
    quietHoursEnd: row?.quietHoursEnd ?? null,
    timezone: row?.timezone ?? 'America/Mexico_City',
    mutedUntil: row?.mutedUntil?.toISOString() ?? null,
    categories: resolveCategories(parsePreferences(row?.preferences)),
  };
}

export interface UpdateNotificationSettingsInput {
  pushEnabled?: boolean;
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
  timezone?: string;
  mutedUntil?: string | null;
  categories?: Partial<Record<string, Partial<CategoryPreference>>>;
}

export async function updateNotificationSettings(
  userId: string,
  input: UpdateNotificationSettingsInput
): Promise<NotificationSettings> {
  const existing = await prisma.userNotificationSettings.findUnique({ where: { userId } });
  const merged: PreferencesJson = { ...parsePreferences(existing?.preferences) };
  if (input.categories) {
    for (const [key, value] of Object.entries(input.categories)) {
      if (!isNotificationCategory(key) || !value) continue;
      const def = getCategoryDefinition(key);
      merged[key] = {
        ...(merged[key] ?? {}),
        ...(typeof value.inApp === 'boolean' && !def.lockedInApp ? { inApp: value.inApp } : {}),
        ...(typeof value.push === 'boolean' ? { push: value.push } : {}),
      };
    }
  }

  const data = {
    ...(typeof input.pushEnabled === 'boolean' ? { pushEnabled: input.pushEnabled } : {}),
    ...(input.quietHoursStart !== undefined ? { quietHoursStart: input.quietHoursStart } : {}),
    ...(input.quietHoursEnd !== undefined ? { quietHoursEnd: input.quietHoursEnd } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.mutedUntil !== undefined
      ? { mutedUntil: input.mutedUntil ? new Date(input.mutedUntil) : null }
      : {}),
    preferences: merged as Prisma.InputJsonValue,
  };

  await prisma.userNotificationSettings.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return getNotificationSettings(userId);
}

/** Hour (0-23) of `now` in the user's timezone. Falls back to server time on bad tz. */
function localHour(now: Date, timezone: string): number {
  try {
    const text = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone,
    }).format(now);
    const hour = Number.parseInt(text, 10);
    return Number.isFinite(hour) ? hour % 24 : now.getHours();
  } catch {
    return now.getHours();
  }
}

export function isInQuietHours(
  settings: Pick<NotificationSettings, 'quietHoursStart' | 'quietHoursEnd' | 'timezone'>,
  now = new Date()
): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = settings;
  if (start === null || end === null || start === end) return false;
  const hour = localHour(now, settings.timezone);
  // Window may wrap midnight (e.g. 22 → 7).
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export interface DeliveryDecision {
  inApp: boolean;
  push: boolean;
  /** Why push was suppressed (for logs / tests). */
  pushReason?: 'category_off' | 'push_disabled' | 'muted' | 'quiet_hours';
}

/**
 * What to do with a notification of `category` for this user, given their
 * settings. Urgent categories (incoming call) ignore mute and quiet hours.
 */
export function decideDelivery(
  settings: NotificationSettings,
  category: NotificationCategory,
  now = new Date()
): DeliveryDecision {
  const def = getCategoryDefinition(category);
  // A category the catalogue does not list has no entry in `settings.categories`
  // (`resolveCategories` only fills the catalogue keys). Falling back to the
  // definition — `getCategoryDefinition` answers `system` for an unknown key —
  // keeps a producer that ships a new category ahead of the catalogue from
  // crashing the delivery instead of merely losing its own defaults.
  const pref = settings.categories[category] ?? {
    inApp: def.lockedInApp ? true : def.defaults.inApp,
    push: def.defaults.push,
  };
  if (!pref.push) return { inApp: pref.inApp, push: false, pushReason: 'category_off' };
  if (!settings.pushEnabled) return { inApp: pref.inApp, push: false, pushReason: 'push_disabled' };
  if (!def.urgent) {
    if (settings.mutedUntil && new Date(settings.mutedUntil) > now) {
      return { inApp: pref.inApp, push: false, pushReason: 'muted' };
    }
    if (isInQuietHours(settings, now)) {
      return { inApp: pref.inApp, push: false, pushReason: 'quiet_hours' };
    }
  }
  return { inApp: pref.inApp, push: true };
}

export { NOTIFICATION_CATEGORIES };
