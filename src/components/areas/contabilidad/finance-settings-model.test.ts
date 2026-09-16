import { describe, expect, it } from 'vitest';
import {
  defaultFinanceSettings,
  financeSettingsPatchSchema,
  normalizeFinanceSettings,
  type FinanceSettings,
} from '@/modules/finance/finance-config';
import {
  FINANCE_SETTINGS_BOUNDS,
  financeSettingsFormToPatch,
  financeSettingsWarnings,
  toFinanceSettingsForm,
  type FinanceSettingsForm,
} from './finance-settings-model';

/**
 * Plan 6.4: «Sólo las liquidaciones mueven caja (cuenta "Banco (Zoho)"
 * configurable)». Antes de esta pantalla `updateFinanceSettings` no lo llamaba
 * nadie, así que el sistema corría siempre con `defaultFinanceSettings()` y
 * repuntar la cuenta de cobros exigía editar la fila a mano.
 *
 * Lo que se prueba aquí es el modelo puro: que el parche que arma la pantalla
 * sea exactamente lo que acepta el esquema del servidor (la única fuente de
 * verdad), y que las advertencias digan qué deja de funcionar.
 */

const ACCOUNTS = [
  { key: 'banco_zoho', name: 'Banco (Zoho)', status: 'active' },
  { key: 'caja_chica', name: 'Caja chica', status: 'active' },
  { key: 'banco_viejo', name: 'Banco anterior', status: 'closed' },
];

function form(overrides: Partial<FinanceSettingsForm> = {}): FinanceSettingsForm {
  return { ...toFinanceSettingsForm(defaultFinanceSettings()), ...overrides };
}

function settings(overrides: Partial<FinanceSettings> = {}): FinanceSettings {
  return { ...defaultFinanceSettings(), ...overrides };
}

describe('finance-settings-model', () => {
  it('convierte los ajustes a formulario y de vuelta sin cambiar nada', () => {
    const current = settings({ collectionsCashAccountKey: 'caja_chica', expenseHistoryMonths: 12 });
    const result = financeSettingsFormToPatch(toFinanceSettingsForm(current));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toEqual(current);
  });

  it('el parche que arma la pantalla es EXACTAMENTE el que acepta el servidor', () => {
    const result = financeSettingsFormToPatch(
      form({
        collectionsCashAccountKey: 'caja_chica',
        obligationsDueAlertDays: '7',
        reconcileLookbackDays: '30',
        expenseHistoryMonths: '3',
        dailyCloseReminder: false,
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `strict()`: un campo de más lo rechaza, así que esto prueba el contrato entero.
    const parsed = financeSettingsPatchSchema.safeParse(result.patch);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(normalizeFinanceSettings(result.patch)).toEqual({
      collectionsCashAccountKey: 'caja_chica',
      obligationsDueAlertDays: 7,
      reconcileLookbackDays: 30,
      expenseHistoryMonths: 3,
      dailyCloseReminder: false,
    });
  });

  it('rechaza en español lo que el servidor también rechazaría', () => {
    const result = financeSettingsFormToPatch(
      form({
        collectionsCashAccountKey: 'Banco Zoho',
        obligationsDueAlertDays: '61',
        reconcileLookbackDays: '0',
        expenseHistoryMonths: '2.5',
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(4);
    expect(result.errors[0]).toMatch(/Cuenta de cobros/);
    expect(result.errors[1]).toMatch(/entre 0 y 60/);
    expect(result.errors[2]).toMatch(/entre 1 y 730/);
    expect(result.errors[3]).toMatch(/entre 1 y 24/);
    // Y lo mismo diría el servidor si el parche llegara igual de mal.
    expect(
      financeSettingsPatchSchema.safeParse({ collectionsCashAccountKey: 'Banco Zoho' }).success
    ).toBe(false);
  });

  it('las cotas de la pantalla son las del esquema del servidor', () => {
    for (const [field, bounds] of Object.entries(FINANCE_SETTINGS_BOUNDS)) {
      const key = field as keyof typeof FINANCE_SETTINGS_BOUNDS;
      expect(
        financeSettingsPatchSchema.safeParse({ [key]: bounds.min }).success,
        `${key} min`
      ).toBe(true);
      expect(
        financeSettingsPatchSchema.safeParse({ [key]: bounds.max }).success,
        `${key} max`
      ).toBe(true);
      expect(
        financeSettingsPatchSchema.safeParse({ [key]: bounds.min - 1 }).success,
        `${key} bajo el mínimo`
      ).toBe(false);
      expect(
        financeSettingsPatchSchema.safeParse({ [key]: bounds.max + 1 }).success,
        `${key} sobre el máximo`
      ).toBe(false);
    }
  });

  it('avisa cuando la cuenta de cobros no existe o está cerrada', () => {
    expect(financeSettingsWarnings(settings(), ACCOUNTS)).toEqual([]);
    expect(
      financeSettingsWarnings(settings({ collectionsCashAccountKey: 'inventada' }), ACCOUNTS)[0]
    ).toMatch(/No existe la cuenta «inventada»/);
    expect(
      financeSettingsWarnings(settings({ collectionsCashAccountKey: 'banco_viejo' }), ACCOUNTS)[0]
    ).toMatch(/está cerrada/);
    // Sin catálogo cargado la advertencia sigue siendo la de "no existe".
    expect(financeSettingsWarnings(settings(), [])).toHaveLength(1);
  });

  it('avisa del aviso previo apagado y del recordatorio de cierre apagado', () => {
    expect(financeSettingsWarnings(settings({ obligationsDueAlertDays: 0 }), ACCOUNTS)).toEqual([
      expect.stringContaining('0 días de aviso'),
    ]);
    expect(financeSettingsWarnings(settings({ dailyCloseReminder: false }), ACCOUNTS)).toEqual([
      expect.stringContaining('recordatorio de cierre diario está apagado'),
    ]);
  });
});
