import { describe, it, expect } from 'vitest';
import { decideDelivery, isInQuietHours, type NotificationSettings } from './preferences-service';
import { NOTIFICATION_CATALOG } from './catalog';

function settings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  const categories = Object.fromEntries(
    NOTIFICATION_CATALOG.map((c) => [c.key, { ...c.defaults }])
  ) as NotificationSettings['categories'];
  return {
    pushEnabled: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'UTC',
    mutedUntil: null,
    categories,
    ...overrides,
  };
}

/** A Date whose UTC hour is `hour` (timezone above is UTC so local == UTC). */
const at = (hour: number) => new Date(Date.UTC(2026, 0, 1, hour, 30));

describe('isInQuietHours', () => {
  it('is off when either bound is missing or the window is empty', () => {
    expect(isInQuietHours(settings(), at(3))).toBe(false);
    expect(isInQuietHours(settings({ quietHoursStart: 22, quietHoursEnd: 22 }), at(22))).toBe(false);
  });

  it('handles a window that wraps midnight (22 → 7)', () => {
    const s = settings({ quietHoursStart: 22, quietHoursEnd: 7 });
    expect(isInQuietHours(s, at(23))).toBe(true);
    expect(isInQuietHours(s, at(3))).toBe(true);
    expect(isInQuietHours(s, at(7))).toBe(false);
    expect(isInQuietHours(s, at(12))).toBe(false);
  });

  it('handles a same-day window (13 → 15)', () => {
    const s = settings({ quietHoursStart: 13, quietHoursEnd: 15 });
    expect(isInQuietHours(s, at(14))).toBe(true);
    expect(isInQuietHours(s, at(16))).toBe(false);
  });
});

describe('decideDelivery', () => {
  it('follows the category toggles', () => {
    const s = settings();
    s.categories.chat_message = { inApp: true, push: false };
    expect(decideDelivery(s, 'chat_message')).toEqual({ inApp: true, push: false, pushReason: 'category_off' });
    expect(decideDelivery(s, 'chat_mention')).toEqual({ inApp: true, push: true });
  });

  it('global push switch suppresses push but keeps in-app', () => {
    const d = decideDelivery(settings({ pushEnabled: false }), 'inbox_message');
    expect(d).toEqual({ inApp: true, push: false, pushReason: 'push_disabled' });
  });

  it('mute and quiet hours stop normal pushes but not urgent ones (incoming call)', () => {
    const muted = settings({ mutedUntil: new Date(Date.now() + 60_000).toISOString() });
    expect(decideDelivery(muted, 'chat_message').pushReason).toBe('muted');
    expect(decideDelivery(muted, 'call_incoming').push).toBe(true);

    const quiet = settings({ quietHoursStart: 22, quietHoursEnd: 7 });
    expect(decideDelivery(quiet, 'entity_change', at(2)).pushReason).toBe('quiet_hours');
    expect(decideDelivery(quiet, 'call_incoming', at(2)).push).toBe(true);
    expect(decideDelivery(quiet, 'entity_change', at(10)).push).toBe(true);
  });

  it('an expired mute no longer applies', () => {
    const s = settings({ mutedUntil: new Date(Date.now() - 1000).toISOString() });
    expect(decideDelivery(s, 'chat_message').push).toBe(true);
  });
});
