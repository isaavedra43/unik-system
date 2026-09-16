'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Switch } from '@/components/shadcn/switch';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { Alert, Button, Checkbox, FormField, Input, Textarea } from '@/components/ui/primitives';
import { relativeSince } from '@/modules/areas/area-time';
import { WORK_ITEM_KINDS, type EscalationRung } from '@/modules/operations/types';
import type {
  OperationsConfig,
  OperationsConfigPatch,
} from '@/modules/operations/operations-config';
import {
  CT_OPS_FLAGS,
  CT_OPS_FLAG_DESCRIPTIONS,
  CT_OPS_FLAG_LABELS,
  ESCALATION_RUNG_LABELS,
  ESCALATION_RUNG_OPTIONS,
  SLA_KIND_HINTS,
  SLA_KIND_LABELS,
  describeEscalation,
  flagOffWarning,
  flagsBeingDisabled,
  isKillSwitchOff,
  parseMinutesList,
  settingsFormToPatch,
  toSettingsForm,
  type CtOpsFlag,
  type OperationsSettingsForm,
} from './settings-model';

/**
 * Editor of the operations configuration (plan 7.7 `configuración`): the module
 * flags, the cutover date, the pilot warehouses, the SLA of each kind of work,
 * the escalation ladder and the approval thresholds.
 *
 * Every field is validated here to say what is wrong in Spanish and, again, by
 * `operationsConfigPatchSchema` inside `updateOperationsConfig`, which also
 * guards the write with the row's `updatedAt`: two administrators never
 * overwrite each other silently.
 *
 * Turning a flag OFF stops part of the operation, so it always asks first and
 * names exactly what will stop happening.
 */

export interface SettingsPanelProps {
  config: OperationsConfig;
  /** Server action bound by the page; it re-checks `operations.admin`. */
  saveAction: (
    patch: OperationsConfigPatch
  ) => Promise<{ success: boolean; error: string | null; config: OperationsConfig | null }>;
  nowIso: string;
}

export function SettingsPanel({ config, saveAction, nowIso }: SettingsPanelProps) {
  const [current, setCurrent] = useState(config);
  const [form, setForm] = useState<OperationsSettingsForm>(() => toSettingsForm(config));
  const [errors, setErrors] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const now = useMemo(() => Date.parse(nowIso) || Date.now(), [nowIso]);

  useEffect(() => {
    setCurrent(config);
    setForm(toSettingsForm(config));
  }, [config]);

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(toSettingsForm(current)),
    [form, current]
  );

  const disabledFlags = flagsBeingDisabled(current, form);
  const killSwitch = isKillSwitchOff(current, form);
  const needsConfirm = disabledFlags.length > 0 || killSwitch;

  const minutes = parseMinutesList(form.escalationAfterMinutes);

  const persist = useCallback(() => {
    const result = settingsFormToPatch(form);
    if (!result.ok) {
      setErrors(result.errors);
      setConfirming(false);
      return;
    }
    setErrors([]);
    startTransition(async () => {
      const outcome = await saveAction(result.patch);
      setConfirming(false);
      if (!outcome.success || !outcome.config) {
        toast.error(outcome.error ?? 'No pudimos guardar la configuración');
        setErrors(outcome.error ? [outcome.error] : []);
        return;
      }
      setCurrent(outcome.config);
      setForm(toSettingsForm(outcome.config));
      toast.success('Configuración guardada');
    });
  }, [form, saveAction]);

  function onSave() {
    const result = settingsFormToPatch(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    if (needsConfirm) {
      setConfirming(true);
      return;
    }
    persist();
  }

  const setFlag = (flag: CtOpsFlag, value: boolean) =>
    setForm((state) => ({ ...state, flags: { ...state.flags, [flag]: value } }));

  const toggleRung = (rung: EscalationRung, checked: boolean) =>
    setForm((state) => ({
      ...state,
      escalationLadder: checked
        ? [...state.escalationLadder, rung].filter(
            (entry, index, list) => list.indexOf(entry) === index
          )
        : state.escalationLadder.filter((entry) => entry !== rung),
    }));

  return (
    <div className="ct-settings">
      <Alert variant={current.isEnabled ? 'info' : 'warning'}>
        {current.isEnabled
          ? `Núcleo operativo encendido. Última modificación ${relativeSince(current.updatedAt, now)}.`
          : 'El núcleo operativo está APAGADO: ningún indicador está activo, aunque se vean encendidos abajo.'}
      </Alert>

      {errors.length > 0 ? (
        <Alert variant="error" title="Revisa estos campos">
          <ul>
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <ChartCard
        title="Interruptor general"
        description="Apagarlo deja sin efecto todos los indicadores de abajo, sin borrar nada."
        height="auto"
      >
        <div className="ct-flag">
          <Switch
            id="ct-core-enabled"
            checked={form.isEnabled}
            onCheckedChange={(value) => setForm((state) => ({ ...state, isEnabled: value }))}
            aria-label="Núcleo operativo encendido"
          />
          <span className="ct-flag-body">
            <label className="ct-flag-name" htmlFor="ct-core-enabled">
              Núcleo operativo
            </label>
            <span className="ct-flag-desc">
              Con el interruptor apagado, ningún módulo reacciona: no se abren expedientes, no se
              crean trabajos y la IA de área no responde.
            </span>
          </span>
        </div>
      </ChartCard>

      <ChartCard
        title="Qué está encendido"
        description="Cada indicador enciende una parte de la operación. Apagar uno detiene lo que dice su descripción."
        height="auto"
      >
        <ul className="ct-flag-list">
          {CT_OPS_FLAGS.map((flag) => (
            <li key={flag} className={`ct-flag ${form.flags[flag] ? '' : 'ct-flag-off'}`}>
              <Switch
                checked={form.flags[flag]}
                onCheckedChange={(value) => setFlag(flag, value)}
                aria-label={CT_OPS_FLAG_LABELS[flag]}
                id={`ct-flag-${flag}`}
              />
              <span className="ct-flag-body">
                <label className="ct-flag-name" htmlFor={`ct-flag-${flag}`}>
                  {CT_OPS_FLAG_LABELS[flag]}
                </label>
                <span className="ct-flag-desc">{CT_OPS_FLAG_DESCRIPTIONS[flag]}</span>
                {!form.flags[flag] ? (
                  <span className="ct-flag-desc ct-tone-warning">{flagOffWarning(flag)}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </ChartCard>

      <ChartCard
        title="Alcance del arranque"
        description="Desde cuándo una venta abre expediente sola y en qué bodegas."
        height="auto"
      >
        <div className="ct-settings-grid">
          <FormField
            label="Fecha de corte"
            htmlFor="ct-cutover"
            help="Las órdenes de venta creadas en Zoho ANTES de esta fecha nunca abren expediente solas."
          >
            <Input
              id="ct-cutover"
              type="date"
              value={form.cutoverDate}
              onChange={(event) =>
                setForm((state) => ({ ...state, cutoverDate: event.target.value }))
              }
            />
          </FormField>
          <FormField
            label="Bodegas piloto (una por línea)"
            htmlFor="ct-pilot"
            help="Vacío = todas las bodegas. Con una o más, sólo esas órdenes arrancan solas."
          >
            <Textarea
              id="ct-pilot"
              rows={4}
              value={form.pilotLocationIds}
              placeholder="Id de la ubicación de Zoho"
              onChange={(event) =>
                setForm((state) => ({ ...state, pilotLocationIds: event.target.value }))
              }
            />
          </FormField>
        </div>
      </ChartCard>

      <ChartCard
        title="SLA por tipo de trabajo"
        description="Minutos que tiene un pendiente antes de considerarse vencido."
        height="auto"
      >
        <div className="ct-settings-grid-3">
          {WORK_ITEM_KINDS.map((kind) => (
            <FormField
              key={kind}
              label={`${SLA_KIND_LABELS[kind]} (min)`}
              htmlFor={`ct-sla-${kind}`}
              help={SLA_KIND_HINTS[kind]}
            >
              <Input
                id={`ct-sla-${kind}`}
                type="number"
                min={0}
                max={525600}
                inputMode="numeric"
                value={form.slaDefaults[kind]}
                onChange={(event) =>
                  setForm((state) => ({
                    ...state,
                    slaDefaults: { ...state.slaDefaults, [kind]: event.target.value },
                  }))
                }
              />
            </FormField>
          ))}
        </div>
      </ChartCard>

      <ChartCard
        title="Escalera de escalamiento"
        description={describeEscalation(minutes.values, form.escalationLadder)}
        height="auto"
      >
        <div className="ct-settings-grid">
          <FormField
            label="Minutos de cada tramo"
            htmlFor="ct-escalation-minutes"
            help="Separados por coma y de menor a mayor. El primero se aplica al vencer."
            error={minutes.error}
          >
            <Input
              id="ct-escalation-minutes"
              value={form.escalationAfterMinutes}
              placeholder="0, 120, 480"
              onChange={(event) =>
                setForm((state) => ({ ...state, escalationAfterMinutes: event.target.value }))
              }
            />
          </FormField>
          <FormField
            label="Peldaños"
            help="A quién sube el pendiente en cada tramo, en orden."
            error={form.escalationLadder.length === 0 ? 'Elige al menos un peldaño' : null}
          >
            <div className="ct-ladder">
              {ESCALATION_RUNG_OPTIONS.map((rung) => (
                <Checkbox
                  key={rung}
                  label={ESCALATION_RUNG_LABELS[rung]}
                  checked={form.escalationLadder.includes(rung)}
                  onChange={(event) => toggleRung(rung, event.target.checked)}
                />
              ))}
            </div>
          </FormField>
        </div>
      </ChartCard>

      <ChartCard
        title="Umbrales y plazos"
        description="Cuándo se pide doble firma, cuándo un gasto se aprueba solo y cuánto espera el sistema."
        height="auto"
      >
        <div className="ct-settings-grid-3">
          <FormField
            label="Doble firma desde (MXN)"
            htmlFor="ct-double"
            help="Compras y pagos por encima de este importe piden dos firmas distintas."
          >
            <Input
              id="ct-double"
              type="number"
              min={0}
              inputMode="decimal"
              value={form.procurementDoubleApprovalMxn}
              onChange={(event) =>
                setForm((state) => ({
                  ...state,
                  procurementDoubleApprovalMxn: event.target.value,
                }))
              }
            />
          </FormField>
          <FormField
            label="Gasto sin firma hasta (MXN)"
            htmlFor="ct-expense-auto"
            help="Por debajo de este importe, un gasto se aprueba solo."
          >
            <Input
              id="ct-expense-auto"
              type="number"
              min={0}
              inputMode="decimal"
              value={form.expenseAutoApproveMxn}
              onChange={(event) =>
                setForm((state) => ({ ...state, expenseAutoApproveMxn: event.target.value }))
              }
            />
          </FormField>
          <FormField
            label="Escritura externa atorada (min)"
            htmlFor="ct-external"
            help="Minutos esperando a Zoho antes de tratarlo como excepción."
          >
            <Input
              id="ct-external"
              type="number"
              min={1}
              max={1440}
              inputMode="numeric"
              value={form.externalSyncStaleMinutes}
              onChange={(event) =>
                setForm((state) => ({ ...state, externalSyncStaleMinutes: event.target.value }))
              }
            />
          </FormField>
          <FormField
            label="Reclamo legado (días)"
            htmlFor="ct-legacy"
            help="Cuánto dura la reserva de existencia de una venta anterior al corte."
          >
            <Input
              id="ct-legacy"
              type="number"
              min={1}
              max={365}
              inputMode="numeric"
              value={form.legacyClaimTtlDays}
              onChange={(event) =>
                setForm((state) => ({ ...state, legacyClaimTtlDays: event.target.value }))
              }
            />
          </FormField>
          <FormField
            label="Alerta de reserva (días)"
            htmlFor="ct-reservation"
            help="Días antes de avisar que una reserva lleva demasiado tiempo activa."
          >
            <Input
              id="ct-reservation"
              type="number"
              min={1}
              max={365}
              inputMode="numeric"
              value={form.reservationAlertDays}
              onChange={(event) =>
                setForm((state) => ({ ...state, reservationAlertDays: event.target.value }))
              }
            />
          </FormField>
          <FormField
            label="Verificación provisional (horas)"
            htmlFor="ct-provisional"
            help="Cuánto vale una verificación hecha sobre existencia provisional."
          >
            <Input
              id="ct-provisional"
              type="number"
              min={1}
              max={8760}
              inputMode="numeric"
              value={form.provisionalVerificationMaxHours}
              onChange={(event) =>
                setForm((state) => ({
                  ...state,
                  provisionalVerificationMaxHours: event.target.value,
                }))
              }
            />
          </FormField>
        </div>
      </ChartCard>

      <div className="ct-sticky-bar">
        <span className="ct-sticky-note">
          {dirty
            ? 'Hay cambios sin guardar.'
            : `Sin cambios pendientes · guardado ${relativeSince(current.updatedAt, now)}.`}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={!dirty || pending}
          onClick={() => {
            setForm(toSettingsForm(current));
            setErrors([]);
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
          Descartar
        </Button>
        <Button size="sm" disabled={!dirty || pending} onClick={onSave}>
          <Save size={14} aria-hidden="true" />
          {pending ? 'Guardando…' : 'Guardar configuración'}
        </Button>
      </div>

      {confirming ? (
        <Dialog
          open
          onOpenChange={(open) => (!open && !pending ? setConfirming(false) : undefined)}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Vas a apagar parte de la operación</DialogTitle>
              <DialogDescription>
                Esto cambia lo que el sistema hace solo. Nada se borra y puedes volver a encenderlo.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3">
              {killSwitch ? (
                <Alert variant="error" title="Interruptor general">
                  Al apagar el núcleo operativo, ningún módulo reaccionará: no se abrirán
                  expedientes, no se crearán trabajos y la IA de área no responderá.
                </Alert>
              ) : null}
              {disabledFlags.map((flag) => (
                <Alert key={flag} variant="warning" title={CT_OPS_FLAG_LABELS[flag]}>
                  {flagOffWarning(flag)}
                </Alert>
              ))}
            </div>
            <DialogFooter>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirming(false)}
                disabled={pending}
              >
                Cancelar
              </Button>
              <Button variant="danger" size="sm" onClick={persist} disabled={pending}>
                {pending ? 'Guardando…' : 'Sí, apagar y guardar'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
