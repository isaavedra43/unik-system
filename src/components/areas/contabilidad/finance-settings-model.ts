import type { FinanceSettings, FinanceSettingsPatch } from '@/modules/finance/finance-config';

/**
 * Editor de los ajustes de Contabilidad interna (plan 6.4, `IntegrationConfig`
 * con `source = 'finance'`). PURO e isomórfico: corre en el navegador, así que
 * NO puede importar el runtime de `finance-config.ts` (ese módulo carga Prisma),
 * sólo sus tipos.
 *
 * Aquí no se decide nada del negocio: el parche que arma se vuelve a validar con
 * `financeSettingsPatchSchema` dentro de `updateFinanceSettings`, que es la
 * única fuente de verdad de lo que es una configuración válida y que además
 * exige `finance.manage_catalog`.
 *
 * Por qué existe esta pantalla: la cuenta que recibe los cobros sincronizados
 * de Zoho estaba fija en `banco_zoho`. Si la empresa cobra en otra cuenta —o
 * alguien renombra la sembrada— `cashAccountByKey` lanza `invalid_config` en
 * CADA conciliación y no había ninguna pantalla ni API para repuntarla.
 */

export interface FinanceSettingsForm {
  collectionsCashAccountKey: string;
  obligationsDueAlertDays: string;
  reconcileLookbackDays: string;
  expenseHistoryMonths: string;
  dailyCloseReminder: boolean;
}

export function toFinanceSettingsForm(settings: FinanceSettings): FinanceSettingsForm {
  return {
    collectionsCashAccountKey: settings.collectionsCashAccountKey,
    obligationsDueAlertDays: String(settings.obligationsDueAlertDays),
    reconcileLookbackDays: String(settings.reconcileLookbackDays),
    expenseHistoryMonths: String(settings.expenseHistoryMonths),
    dailyCloseReminder: settings.dailyCloseReminder,
  };
}

/** Cotas espejo de `FIELD_SCHEMAS` de `finance-config.ts` (la prueba las compara). */
export const FINANCE_SETTINGS_BOUNDS = {
  obligationsDueAlertDays: { min: 0, max: 60 },
  reconcileLookbackDays: { min: 1, max: 730 },
  expenseHistoryMonths: { min: 1, max: 24 },
} as const;

/** Misma forma de llave que acepta el servidor y que usa el catálogo de cuentas. */
const ACCOUNT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,59}$/;

const NUMBER_LABELS = {
  obligationsDueAlertDays: 'Días de aviso de vencimiento',
  reconcileLookbackDays: 'Ventana de conciliación',
  expenseHistoryMonths: 'Meses de historial de gastos',
} as const;

function parseIntField(
  raw: string,
  label: string,
  bounds: { min: number; max: number }
): { ok: true; value: number } | { ok: false; error: string } {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return { ok: false, error: `${label}: escribe un entero entre ${bounds.min} y ${bounds.max}` };
  }
  return { ok: true, value };
}

export type FinanceSettingsPatchResult =
  { ok: true; patch: FinanceSettingsPatch } | { ok: false; errors: string[] };

export function financeSettingsFormToPatch(form: FinanceSettingsForm): FinanceSettingsPatchResult {
  const errors: string[] = [];

  const accountKey = form.collectionsCashAccountKey.trim();
  if (!ACCOUNT_KEY_PATTERN.test(accountKey)) {
    errors.push(
      'Cuenta de cobros: elige una cuenta del catálogo (la llave son minúsculas, números y guion bajo)'
    );
  }

  const numbers: Record<string, number> = {};
  for (const field of [
    'obligationsDueAlertDays',
    'reconcileLookbackDays',
    'expenseHistoryMonths',
  ] as const) {
    const parsed = parseIntField(form[field], NUMBER_LABELS[field], FINANCE_SETTINGS_BOUNDS[field]);
    if (parsed.ok) numbers[field] = parsed.value;
    else errors.push(parsed.error);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    patch: {
      collectionsCashAccountKey: accountKey,
      obligationsDueAlertDays: numbers.obligationsDueAlertDays,
      reconcileLookbackDays: numbers.reconcileLookbackDays,
      expenseHistoryMonths: numbers.expenseHistoryMonths,
      dailyCloseReminder: form.dailyCloseReminder,
    },
  };
}

export interface FinanceAccountOption {
  key: string;
  name: string;
  /** `active` | `closed`: una cuenta cerrada sigue existiendo para el histórico. */
  status: string;
}

/**
 * Qué deja de funcionar con la configuración tal como está, en español. Se pinta
 * arriba del formulario para que nadie tenga que leer el código para enterarse
 * de por qué la conciliación responde «Configuración inválida».
 */
export function financeSettingsWarnings(
  settings: FinanceSettings,
  accounts: readonly FinanceAccountOption[]
): string[] {
  const out: string[] = [];
  const account = accounts.find((row) => row.key === settings.collectionsCashAccountKey);
  if (!account) {
    out.push(
      `No existe la cuenta «${settings.collectionsCashAccountKey}» en el catálogo: cada conciliación de cobros de Zoho falla con «Configuración inválida» hasta que elijas una cuenta que exista.`
    );
  } else if (account.status !== 'active') {
    out.push(
      `La cuenta de cobros «${account.name}» está cerrada: los cobros sincronizados de Zoho no se pueden asentar en ella.`
    );
  }
  if (settings.obligationsDueAlertDays === 0) {
    out.push(
      'Con 0 días de aviso sólo se avisa de obligaciones YA vencidas: nadie recibe el aviso previo.'
    );
  }
  if (!settings.dailyCloseReminder) {
    out.push(
      'El recordatorio de cierre diario está apagado: nadie recibe el aviso de que ayer quedó sin cerrar.'
    );
  }
  return out;
}
