import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CATALOG,
  NOTIFICATION_CATEGORIES,
  getCategoryDefinition,
  isNotificationCategory,
  type NotificationCategory,
} from './catalog';
import { decideDelivery, type NotificationSettings } from './preferences-service';

/**
 * Categories the plan names in §6.6. They are not decoration: `notifyUser`
 * reads `settings.categories[category]`, and `resolveCategories` only fills the
 * keys of THIS catalogue — so a producer that used a category the catalogue did
 * not list crashed the delivery with a TypeError (that is exactly what the
 * hourly `finance.obligations_due` job did with `finance_alert`).
 */
const PLAN_CATEGORIES = [
  'approval_requested',
  'approval_decided',
  'purchase_update',
  'delivery_update',
  'finance_alert',
  'radar_signal',
  'production_update',
] as const;

function settingsOf(categories: NotificationSettings['categories']): NotificationSettings {
  return {
    pushEnabled: true,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'UTC',
    mutedUntil: null,
    categories,
  };
}

/** What `resolveCategories` builds: ONLY the keys the catalogue declares. */
function resolvedCategories(): NotificationSettings['categories'] {
  return Object.fromEntries(
    NOTIFICATION_CATALOG.map((definition) => [
      definition.key,
      {
        inApp: definition.lockedInApp ? true : definition.defaults.inApp,
        push: definition.defaults.push,
      },
    ])
  ) as NotificationSettings['categories'];
}

describe('catálogo de notificaciones', () => {
  it('declara las siete categorías del plan 6.6', () => {
    for (const key of PLAN_CATEGORIES) {
      expect(isNotificationCategory(key), `falta la categoría ${key}`).toBe(true);
      expect(NOTIFICATION_CATEGORIES).toContain(key);
    }
  });

  it('cada categoría tiene definición propia, no el respaldo de sistema', () => {
    for (const key of PLAN_CATEGORIES) {
      expect(getCategoryDefinition(key).key, `${key} cae al respaldo`).toBe(key);
    }
  });

  it('el radar llega a la aplicación con el push apagado (lo pide el plan)', () => {
    const radar = getCategoryDefinition('radar_signal');
    expect(radar.defaults).toEqual({ inApp: true, push: false });
  });

  it('no hay claves repetidas y la lista y el catálogo dicen lo mismo', () => {
    const keys = NOTIFICATION_CATALOG.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.slice().sort()).toEqual([...NOTIFICATION_CATEGORIES].sort());
  });

  it('decideDelivery resuelve cada categoría del plan sin reventar', () => {
    const settings = settingsOf(resolvedCategories());
    for (const key of PLAN_CATEGORIES) {
      expect(() => decideDelivery(settings, key)).not.toThrow();
      expect(decideDelivery(settings, key).inApp).toBe(true);
    }
    // `finance_alert` is what `finance.obligations_due` sends every hour.
    expect(decideDelivery(settings, 'finance_alert').push).toBe(true);
    expect(decideDelivery(settings, 'radar_signal')).toEqual({
      inApp: true,
      push: false,
      pushReason: 'category_off',
    });
  });

  it('una categoría que el catálogo no conoce degrada a los valores de sistema, no a un TypeError', () => {
    const settings = settingsOf(resolvedCategories());
    const unknown = 'categoria_inventada' as NotificationCategory;
    expect(() => decideDelivery(settings, unknown)).not.toThrow();
    expect(decideDelivery(settings, unknown)).toEqual({
      inApp: true,
      push: false,
      pushReason: 'category_off',
    });
  });
});
