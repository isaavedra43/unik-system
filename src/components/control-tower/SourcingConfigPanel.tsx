'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { Switch } from '@/components/shadcn/switch';
import { Alert, Button, FormField, Input, Select, Textarea } from '@/components/ui/primitives';
import { relativeSince } from '@/modules/areas/area-time';
import type { SourcingConfig, SourcingConfigPatch } from '@/modules/purchases/sourcing-config';
import {
  sourcingConfigWarnings,
  sourcingFormToPatch,
  toSourcingForm,
  type SourcingSettingsForm,
} from './sourcing-settings-model';

/**
 * Editor of the Sourcing Lab configuration (plan 6.1) inside the Control Tower
 * `configuración` view, next to the operations configuration and the approval
 * policies — the same place, the same gate (`operations.admin`) and the same
 * shape of server action.
 *
 * Before this panel the row could only be changed by editing the database by
 * hand, so in practice the lab shipped with `allowedHosts: []` (every catalog
 * page rejected), no approved WhatsApp template (no first message to a supplier
 * without an open window), no Brave connection (no web-search fallback) and no
 * chosen inbox account (whichever was first).
 *
 * The screen only says what is wrong in Spanish; `updateSourcingConfig`
 * validates everything again and guards the row with its `updatedAt`.
 */

export interface SourcingOption {
  id: string;
  label: string;
}

export interface SourcingConfigPanelProps {
  config: SourcingConfig;
  /** Inbox accounts that can write to a supplier (WhatsApp / SMS / Telegram). */
  accounts: SourcingOption[];
  /** Active extension connections that may hold the Brave Search key. */
  connections: SourcingOption[];
  /** Server action bound by the page; it re-checks `operations.admin`. */
  saveAction: (
    patch: SourcingConfigPatch
  ) => Promise<{ success: boolean; error: string | null; config: SourcingConfig | null }>;
  nowIso: string;
}

export function SourcingConfigPanel({
  config,
  accounts,
  connections,
  saveAction,
  nowIso,
}: SourcingConfigPanelProps) {
  const [current, setCurrent] = useState(config);
  const [form, setForm] = useState<SourcingSettingsForm>(() => toSourcingForm(config));
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const now = useMemo(() => Date.parse(nowIso) || Date.now(), [nowIso]);

  useEffect(() => {
    setCurrent(config);
    setForm(toSourcingForm(config));
  }, [config]);

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(toSourcingForm(current)),
    [form, current]
  );
  const warnings = useMemo(() => sourcingConfigWarnings(current), [current]);

  const set = <K extends keyof SourcingSettingsForm>(key: K, value: SourcingSettingsForm[K]) =>
    setForm((state) => ({ ...state, [key]: value }));

  function onSave() {
    const result = sourcingFormToPatch(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    startTransition(async () => {
      const outcome = await saveAction(result.patch);
      if (!outcome.success || !outcome.config) {
        toast.error(outcome.error ?? 'No pudimos guardar la configuración del laboratorio');
        setErrors(outcome.error ? [outcome.error] : []);
        return;
      }
      setCurrent(outcome.config);
      setForm(toSourcingForm(outcome.config));
      toast.success('Configuración del laboratorio guardada');
    });
  }

  return (
    <div className="ct-settings">
      <ChartCard
        title="Laboratorio de sourcing y mensajes a proveedores"
        description="Dónde puede buscar el laboratorio, cuánto puede gastar al día y con qué plantilla aprobada se escribe a un proveedor."
        height="auto"
      >
        <Alert variant={current.isEnabled ? 'info' : 'warning'}>
          {current.isEnabled
            ? `Laboratorio encendido. Última modificación ${relativeSince(current.updatedAt, now)}.`
            : 'El laboratorio está APAGADO: no se ejecuta ninguna búsqueda aunque los campos se vean llenos.'}
        </Alert>

        {warnings.length > 0 ? (
          <Alert variant="warning" title="Con esta configuración, esto no pasa">
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

        <div className="ct-flag">
          <Switch
            id="ct-sourcing-enabled"
            checked={form.isEnabled}
            onCheckedChange={(value) => set('isEnabled', value)}
            aria-label="Laboratorio de sourcing encendido"
          />
          <span className="ct-flag-body">
            <label className="ct-flag-name" htmlFor="ct-sourcing-enabled">
              Laboratorio encendido
            </label>
            <span className="ct-flag-desc">
              Apagarlo detiene las búsquedas sin borrar los candidatos ni las búsquedas anteriores.
            </span>
          </span>
        </div>
      </ChartCard>

      <ChartCard
        title="Dónde puede buscar"
        description="Sólo se descarga una página de catálogo si su dominio está en esta lista."
        height="auto"
      >
        <div className="ct-settings-grid">
          <FormField
            label="Sitios autorizados (uno por línea)"
            htmlFor="ct-sourcing-hosts"
            help="Escribe el dominio exacto (proveedor.com) o con comodín (*.proveedor.com). Vacío = el laboratorio rechaza toda página de catálogo."
          >
            <Textarea
              id="ct-sourcing-hosts"
              rows={5}
              value={form.allowedHosts}
              placeholder={'proveedor.com\n*.catalogo.mx'}
              onChange={(event) => set('allowedHosts', event.target.value)}
            />
          </FormField>
          <FormField
            label="Conexión de Brave Search"
            htmlFor="ct-sourcing-brave"
            help="Conexión de extensión que guarda la llave de Brave. Sólo se usa cuando no hay una herramienta MCP de búsqueda conectada."
          >
            <Select
              id="ct-sourcing-brave"
              value={form.braveConnectionId}
              onChange={(event) => set('braveConnectionId', event.target.value)}
            >
              <option value="">Sin conexión</option>
              {connections.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
              {form.braveConnectionId &&
              !connections.some((option) => option.id === form.braveConnectionId) ? (
                <option value={form.braveConnectionId}>
                  {form.braveConnectionId} (ya no existe)
                </option>
              ) : null}
            </Select>
          </FormField>
        </div>
      </ChartCard>

      <ChartCard
        title="Cuánto puede gastar"
        description="Una consulta web cuesta una unidad; leer una página de catálogo cuesta dos."
        height="auto"
      >
        <div className="ct-settings-grid-3">
          <FormField
            label="Presupuesto diario (unidades)"
            htmlFor="ct-sourcing-budget"
            help="0 deja el laboratorio sin presupuesto: ninguna búsqueda nueva sale."
          >
            <Input
              id="ct-sourcing-budget"
              inputMode="numeric"
              value={form.dailyBudgetUnits}
              onChange={(event) => set('dailyBudgetUnits', event.target.value)}
            />
          </FormField>
          <FormField
            label="Caché (días)"
            htmlFor="ct-sourcing-cache"
            help="Una búsqueda repetida dentro de este plazo se responde de la caché sin gastar presupuesto."
          >
            <Input
              id="ct-sourcing-cache"
              inputMode="numeric"
              value={form.cacheTtlDays}
              onChange={(event) => set('cacheTtlDays', event.target.value)}
            />
          </FormField>
          <FormField
            label="Páginas por búsqueda"
            htmlFor="ct-sourcing-pages"
            help="Cuántas páginas de catálogo se leen como máximo en una sola búsqueda (1 a 5)."
          >
            <Input
              id="ct-sourcing-pages"
              inputMode="numeric"
              value={form.maxPagesPerSearch}
              onChange={(event) => set('maxPagesPerSearch', event.target.value)}
            />
          </FormField>
        </div>
      </ChartCard>

      <ChartCard
        title="Cómo se le escribe a un proveedor"
        description="Cuenta de la bandeja, plantillas aprobadas por Meta y el texto que se envía por SMS o Telegram."
        height="auto"
      >
        <div className="ct-settings-grid">
          <FormField
            label="Cuenta de la bandeja"
            htmlFor="ct-sourcing-account"
            help="Por dónde salen las invitaciones a cotizar y las órdenes. Sin elegirla se usa la primera cuenta activa del canal."
          >
            <Select
              id="ct-sourcing-account"
              value={form.rfqAccountId}
              onChange={(event) => set('rfqAccountId', event.target.value)}
            >
              <option value="">La primera cuenta activa del canal</option>
              {accounts.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
              {form.rfqAccountId && !accounts.some((option) => option.id === form.rfqAccountId) ? (
                <option value={form.rfqAccountId}>{form.rfqAccountId} (ya no existe)</option>
              ) : null}
            </Select>
          </FormField>
          <FormField
            label="Nombre de la empresa en el mensaje"
            htmlFor="ct-sourcing-company"
            help="Así se presenta UNIK ante el proveedor."
          >
            <Input
              id="ct-sourcing-company"
              value={form.companyName}
              onChange={(event) => set('companyName', event.target.value)}
            />
          </FormField>
          <FormField
            label="Plantilla aprobada de cotización (Content SID)"
            htmlFor="ct-sourcing-rfq-template"
            help="Sin plantilla sólo se puede escribir por WhatsApp a un proveedor con ventana de 24 h abierta."
          >
            <Input
              id="ct-sourcing-rfq-template"
              value={form.rfqTemplateKey}
              placeholder="HX…"
              onChange={(event) => set('rfqTemplateKey', event.target.value)}
            />
          </FormField>
          <FormField
            label="Plantilla aprobada de orden (Content SID)"
            htmlFor="ct-sourcing-order-template"
            help="La que se usa para mandar la orden de compra al proveedor fuera de la ventana de 24 h."
          >
            <Input
              id="ct-sourcing-order-template"
              value={form.orderTemplateKey}
              placeholder="HX…"
              onChange={(event) => set('orderTemplateKey', event.target.value)}
            />
          </FormField>
          <FormField
            label="Días para responder una cotización"
            htmlFor="ct-sourcing-due"
            help="Vencimiento que se propone al crear una cotización nueva."
          >
            <Input
              id="ct-sourcing-due"
              inputMode="numeric"
              value={form.rfqDefaultDueDays}
              onChange={(event) => set('rfqDefaultDueDays', event.target.value)}
            />
          </FormField>
        </div>

        <div className="ct-settings-grid">
          <FormField
            label="Texto de la cotización"
            htmlFor="ct-sourcing-rfq-text"
            help="Lo que se envía por SMS o Telegram y lo que queda en la conversación."
          >
            <Textarea
              id="ct-sourcing-rfq-text"
              rows={5}
              value={form.rfqMessageTemplate}
              onChange={(event) => set('rfqMessageTemplate', event.target.value)}
            />
          </FormField>
          <FormField
            label="Texto de la orden"
            htmlFor="ct-sourcing-order-text"
            help="El mensaje con el que se manda la orden de compra al proveedor."
          >
            <Textarea
              id="ct-sourcing-order-text"
              rows={5}
              value={form.orderMessageTemplate}
              onChange={(event) => set('orderMessageTemplate', event.target.value)}
            />
          </FormField>
        </div>
      </ChartCard>

      <div className="ct-sticky-bar">
        <Button
          variant="secondary"
          size="sm"
          disabled={!dirty || pending}
          onClick={() => {
            setForm(toSourcingForm(current));
            setErrors([]);
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
          Descartar
        </Button>
        <Button size="sm" disabled={!dirty || pending} onClick={onSave}>
          <Save size={14} aria-hidden="true" />
          {pending ? 'Guardando…' : 'Guardar laboratorio'}
        </Button>
      </div>
    </div>
  );
}
