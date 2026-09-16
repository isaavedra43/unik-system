'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Alert, Button, Checkbox, FormField, Input, Select } from '@/components/ui/primitives';
import type { CashAccountDTO } from '@/modules/finance/finance-dto';
import type { FinanceSettings, FinanceSettingsPatch } from '@/modules/finance/finance-config';
import {
  financeSettingsFormToPatch,
  financeSettingsWarnings,
  toFinanceSettingsForm,
  type FinanceSettingsForm,
} from './finance-settings-model';

/**
 * Ajustes de la contabilidad interna (plan 6.4), dentro de Catálogos porque es
 * la misma puerta: `finance.manage_catalog`.
 *
 * El campo que importa es la cuenta que recibe los cobros sincronizados de Zoho
 * («Banco (Zoho)» por omisión). Antes de esta pantalla estaba fija en el código:
 * si la empresa cobraba en otra cuenta, o alguien renombraba la sembrada, cada
 * conciliación fallaba con `invalid_config` y no había dónde repuntarla.
 *
 * La pantalla sólo avisa en español de lo que dejaría de funcionar;
 * `updateFinanceSettings` vuelve a exigir el permiso y a validar el parche.
 */

export interface FinanceSettingsPanelProps {
  settings: FinanceSettings;
  /** Catálogo de cuentas: la de cobros se elige de aquí, no se escribe a mano. */
  accounts: CashAccountDTO[];
  canManage: boolean;
  /** Server action ligada por la página; vuelve a comprobar `finance.manage_catalog`. */
  saveAction: (
    patch: FinanceSettingsPatch
  ) => Promise<{ success: boolean; error: string | null; settings: FinanceSettings | null }>;
}

export function FinanceSettingsPanel({
  settings,
  accounts,
  canManage,
  saveAction,
}: FinanceSettingsPanelProps) {
  const [current, setCurrent] = useState(settings);
  const [form, setForm] = useState<FinanceSettingsForm>(() => toFinanceSettingsForm(settings));
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    setCurrent(settings);
    setForm(toFinanceSettingsForm(settings));
  }, [settings]);

  const options = useMemo(
    () =>
      accounts.map((account) => ({ key: account.key, name: account.name, status: account.status })),
    [accounts]
  );
  const warnings = useMemo(() => financeSettingsWarnings(current, options), [current, options]);
  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(toFinanceSettingsForm(current)),
    [form, current]
  );
  const missingAccount =
    form.collectionsCashAccountKey !== '' &&
    !options.some((option) => option.key === form.collectionsCashAccountKey);

  const set = <K extends keyof FinanceSettingsForm>(key: K, value: FinanceSettingsForm[K]) =>
    setForm((state) => ({ ...state, [key]: value }));

  function onSave() {
    const result = financeSettingsFormToPatch(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    startTransition(async () => {
      const outcome = await saveAction(result.patch);
      if (!outcome.success || !outcome.settings) {
        toast.error(outcome.error ?? 'No pudimos guardar los ajustes de contabilidad');
        setErrors(outcome.error ? [outcome.error] : []);
        return;
      }
      setCurrent(outcome.settings);
      setForm(toFinanceSettingsForm(outcome.settings));
      toast.success('Ajustes de contabilidad guardados');
    });
  }

  return (
    <section className="fin-card" aria-labelledby="fin-settings-title">
      <h2 className="fin-card-title" id="fin-settings-title">
        Ajustes de contabilidad
      </h2>
      <p className="fin-card-hint">
        Dónde caen los cobros que llegan de Zoho, con cuánta anticipación se avisa de un vencimiento
        y cuánta historia mira la propuesta de gasto.
      </p>

      {warnings.length > 0 ? (
        <Alert variant="warning" title="Con estos ajustes, esto no pasa">
          <ul>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {errors.length > 0 ? (
        <Alert variant="error" title="Revisa estos campos">
          <ul>
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {!canManage ? (
        <Alert variant="info">
          Puedes consultar los ajustes; cambiarlos necesita el permiso de catálogo.
        </Alert>
      ) : null}

      <div className="fin-fields">
        <FormField
          label="Cuenta que recibe los cobros de Zoho"
          htmlFor="fin-settings-account"
          help="Sólo las liquidaciones mueven caja: el cobro sincronizado se asienta en esta cuenta."
        >
          <Select
            id="fin-settings-account"
            value={form.collectionsCashAccountKey}
            disabled={!canManage || pending}
            onChange={(event) => set('collectionsCashAccountKey', event.target.value)}
          >
            {options.map((option) => (
              <option key={option.key} value={option.key}>
                {option.name}
                {option.status === 'active' ? '' : ' (cerrada)'}
              </option>
            ))}
            {missingAccount ? (
              <option value={form.collectionsCashAccountKey}>
                {form.collectionsCashAccountKey} (no existe en el catálogo)
              </option>
            ) : null}
          </Select>
        </FormField>

        <FormField
          label="Días de aviso de vencimiento"
          htmlFor="fin-settings-due"
          help="Una obligación que vence dentro de estos días entra en el aviso diario (0 a 60)."
        >
          <Input
            id="fin-settings-due"
            inputMode="numeric"
            value={form.obligationsDueAlertDays}
            disabled={!canManage || pending}
            onChange={(event) => set('obligationsDueAlertDays', event.target.value)}
          />
        </FormField>

        <FormField
          label="Ventana de conciliación (días)"
          htmlFor="fin-settings-lookback"
          help="Un cobro de Zoho más viejo que esto ya no se concilia (1 a 730)."
        >
          <Input
            id="fin-settings-lookback"
            inputMode="numeric"
            value={form.reconcileLookbackDays}
            disabled={!canManage || pending}
            onChange={(event) => set('reconcileLookbackDays', event.target.value)}
          />
        </FormField>

        <FormField
          label="Historial para proponer un gasto (meses)"
          htmlFor="fin-settings-history"
          help="Cuántos meses de gastos mira la propuesta de categoría y centro de costo (1 a 24)."
        >
          <Input
            id="fin-settings-history"
            inputMode="numeric"
            value={form.expenseHistoryMonths}
            disabled={!canManage || pending}
            onChange={(event) => set('expenseHistoryMonths', event.target.value)}
          />
        </FormField>

        <div className="fin-field-wide">
          <Checkbox
            id="fin-settings-close-reminder"
            label="Recordar el cierre del día"
            description="Avisa a quien puede cerrar cuando ayer tuvo movimiento y quedó sin cerrar."
            checked={form.dailyCloseReminder}
            disabled={!canManage || pending}
            onChange={(event) => set('dailyCloseReminder', event.target.checked)}
          />
        </div>

        {canManage ? (
          <div className="fin-field-wide fin-actions">
            <Button variant="primary" size="sm" disabled={pending || !dirty} onClick={onSave}>
              {pending ? 'Guardando…' : 'Guardar ajustes'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending || !dirty}
              onClick={() => {
                setErrors([]);
                setForm(toFinanceSettingsForm(current));
              }}
            >
              Descartar cambios
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
