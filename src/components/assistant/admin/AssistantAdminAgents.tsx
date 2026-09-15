'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bot, Coins, Gauge, RefreshCw, Save, SkipForward, Sparkles, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { AlertList, type AlertListItem } from '@/components/patterns/dashboard/AlertList';
import { ChartCard } from '@/components/patterns/dashboard/ChartCard';
import { KpiGrid } from '@/components/patterns/dashboard/KpiGrid';
import { StatCard } from '@/components/patterns/dashboard/StatCard';
import { BarBreakdown, TrendChart } from '@/components/patterns/dashboard/charts';
import { ErrorState } from '@/components/patterns/ErrorState';
import { LoadingState } from '@/components/patterns/LoadingState';
import { Switch } from '@/components/shadcn/switch';
import { Badge, Button } from '@/components/ui/primitives';
import { AGENT_LLM_TRIGGERS, AGENT_LLM_TRIGGER_LABELS, type AgentSettings } from '@/modules/ai/agent-settings';
import {
  AGENT_BUDGET_LIMITS,
  AGENT_MODES,
  AGENT_MODE_LABELS,
  BUDGET_STATE_LABELS,
  USAGE_RANGE_DAYS,
  buildIdentityDraftPatch,
  type AgentIdentityPatch,
  type AgentsAdminData,
  type AgentsAdminIdentity,
  type AgentsPatch,
  type UsageRangeDays,
} from '@/app/app/admin/assistant/api/agents/_agents-admin';

/**
 * "Asistente IA → Agentes y presupuestos" (plan 5.6): the AI identities of each
 * area and the administrator, their mode and budgets, AI consumption by area,
 * day and month (flat rate included), turns, skips, degraded agents and the
 * triggers that fired most. Rules and templates never consume model tokens.
 */

const API = '/app/admin/assistant/api/agents';

const fmtInt = (n: number) => Math.round(n).toLocaleString('es-MX');
const fmtUsd = (n: number) =>
  `US$ ${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDay = (value: string | number) => {
  const [, month, day] = String(value).split('-');
  return month && day ? `${Number(day)}/${Number(month)}` : String(value);
};

const STATE_BADGE = { ok: 'success', degraded: 'warning', exhausted: 'danger' } as const;

async function sendPatch(body: AgentsPatch): Promise<void> {
  const res = await fetch(API, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Error ${res.status}`);
  }
}

function buildAlerts(data: AgentsAdminData): AlertListItem[] {
  const items: AlertListItem[] = [];
  if (!data.settings.enabled) {
    items.push({
      id: 'agents-disabled',
      severity: 'warning',
      title: 'La IA coordinada está apagada',
      detail: 'Las reglas y plantillas entre áreas siguen funcionando; la IA no toma turnos automáticos.',
    });
  }
  for (const missing of data.missingAgents) {
    items.push({
      id: `missing:${missing.key}`,
      severity: 'danger',
      title: `Falta la identidad de ${missing.displayName}`,
      detail: 'Se crea sola al reiniciar el servidor.',
    });
  }
  for (const identity of data.identities) {
    if (!identity.bot || !identity.bot.isActive || !identity.bot.isBot) {
      items.push({
        id: `bot:${identity.key}`,
        severity: 'danger',
        title: `${identity.displayName}: su usuario de IA no está activo`,
        detail: 'No podrá publicar en los canales ni tomar turnos hasta repararlo.',
      });
    }
    if (identity.budget?.state === 'exhausted') {
      items.push({
        id: `exhausted:${identity.key}`,
        severity: 'danger',
        title: `${identity.displayName} agotó su presupuesto`,
        detail: `${identity.budget.pct}% consumido · queda en pausa; las reglas siguen y atiende el responsable.`,
      });
    } else if (identity.budget?.state === 'degraded') {
      items.push({
        id: `degraded:${identity.key}`,
        severity: 'warning',
        title: `${identity.displayName} está degradada`,
        detail: `${identity.budget.pct}% del presupuesto · sólo responde cuando la mencionan.`,
      });
    }
    if (identity.mode === 'paused') {
      items.push({
        id: `paused:${identity.key}`,
        severity: 'info',
        title: `${identity.displayName} está en pausa`,
        detail: 'Un administrador la pausó: no toma turnos con el modelo.',
      });
    }
  }
  return items;
}

export function AssistantAdminAgents({ canManage }: { canManage: boolean }) {
  const [days, setDays] = useState<UsageRangeDays>(30);
  const [reloadKey, setReloadKey] = useState(0);
  const [data, setData] = useState<AgentsAdminData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API}?days=${days}`, { signal: controller.signal })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as AgentsAdminData & { error?: string };
        if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
        return json;
      })
      .then((json) => {
        setData(json);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'No se pudo cargar el consumo de los agentes');
      });
    return () => controller.abort();
  }, [days, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const saveSettings = useCallback(
    async (patch: NonNullable<AgentsPatch['agents']>, message: string) => {
      let previous: AgentSettings | null = null;
      setData((current) => {
        if (!current) return current;
        previous = current.settings;
        return {
          ...current,
          settings: {
            ...current.settings,
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            llmTriggers: { ...current.settings.llmTriggers, ...(patch.llmTriggers ?? {}) },
          },
        };
      });
      setSavingSettings(true);
      try {
        await sendPatch({ agents: patch });
        toast.success(message);
      } catch (err) {
        const restore = previous;
        if (restore) setData((current) => (current ? { ...current, settings: restore } : current));
        toast.error(err instanceof Error ? err.message : 'No se pudo guardar');
      } finally {
        setSavingSettings(false);
      }
    },
    []
  );

  const saveIdentity = useCallback(
    async (key: string, patch: Omit<AgentIdentityPatch, 'key'>) => {
      await sendPatch({ identities: [{ key: key as AgentIdentityPatch['key'], ...patch }] });
      toast.success('Agente actualizado');
      reload();
    },
    [reload]
  );

  const alerts = useMemo(() => (data ? buildAlerts(data) : []), [data]);

  if (error && !data) {
    return <ErrorState title="No se pudo cargar Agentes y presupuestos" message={error} onRetry={reload} />;
  }
  if (!data) return <LoadingState variant="kpi" rows={6} label="Cargando agentes y consumo…" />;

  const stale = data.range.days !== days;
  const totals = data.usage.totals;
  const degradedCount = data.identities.filter(
    (i) => i.budget && i.budget.state !== 'ok'
  ).length;
  const pausedCount = data.identities.filter((i) => i.mode === 'paused').length;
  // Distinct identities: one paused AND over budget counts once.
  const attentionCount = data.identities.filter(
    (i) => i.mode === 'paused' || (i.budget && i.budget.state !== 'ok')
  ).length;
  const fee = data.usage.monthlyFeeUsd;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="assistant-admin-muted">
          Periodo {data.range.from} a {data.range.to}
          {stale ? ' · actualizando…' : ''}
        </p>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Periodo de consumo">
          {USAGE_RANGE_DAYS.map((d) => (
            <Button
              key={d}
              type="button"
              size="sm"
              variant={d === days ? 'primary' : 'secondary'}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              {d} días
            </Button>
          ))}
          <Button type="button" size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={reload}>
            Actualizar
          </Button>
        </div>
      </div>

      {error ? <p className="assistant-admin-error">{error}</p> : null}

      <KpiGrid columns={3}>
        <StatCard
          label="Tokens del periodo"
          value={fmtInt(totals.tokens)}
          hint={`${fmtInt(totals.flatTokens)} en tarifa plana · mes: ${fmtInt(data.month.tokens)}`}
          icon={<Zap size={20} />}
          loading={stale}
        />
        <StatCard
          label="Costo pagado"
          value={fmtUsd(totals.usd)}
          hint={`Mes a la fecha: ${fmtUsd(data.month.usd)}`}
          icon={<Coins size={20} />}
          loading={stale}
        />
        <StatCard
          label="Costo amortizado"
          value={fee === null ? 'Sin tarifa plana' : fmtUsd(totals.amortizedUsd)}
          hint={fee === null ? 'Configura la cuota mensual de Canopy Wave' : `Cuota de ${fmtUsd(fee)} al mes`}
          icon={<Gauge size={20} />}
          loading={stale}
        />
        <StatCard
          label="Turnos de IA"
          value={fmtInt(totals.turns)}
          hint={`${fmtInt(data.events.failed)} fallidos en el periodo`}
          icon={<Sparkles size={20} />}
          loading={stale}
        />
        <StatCard
          label="Turnos saltados"
          value={fmtInt(totals.skipped)}
          hint={`${fmtInt(data.events.skippedByBudget)} por presupuesto`}
          tone={data.events.skippedByBudget > 0 ? 'warning' : 'default'}
          icon={<SkipForward size={20} />}
          loading={stale}
        />
        <StatCard
          label="Agentes degradados o en pausa"
          value={`${attentionCount} de ${data.identities.length}`}
          hint={`${degradedCount} por presupuesto · ${pausedCount} en pausa`}
          tone={degradedCount > 0 ? 'danger' : pausedCount > 0 ? 'warning' : 'success'}
          icon={<AlertTriangle size={20} />}
        />
      </KpiGrid>

      <AlertList items={alerts} emptyText="Todos los agentes operan con normalidad." label="Avisos de los agentes" />

      <section className="assistant-admin-config-section" aria-labelledby="agents-global-title">
        <h3 id="agents-global-title" className="assistant-admin-section-title">
          <Bot size={18} /> IA coordinada por áreas
        </h3>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="font-medium">IA coordinada activa</p>
            <p className="assistant-admin-config-hint">
              Apagada, las áreas se siguen avisando con reglas y plantillas, pero ninguna IA toma turnos con el modelo.
            </p>
          </div>
          <Switch
            checked={data.settings.enabled}
            disabled={!canManage || savingSettings}
            aria-label="IA coordinada activa"
            onCheckedChange={(checked) =>
              void saveSettings({ enabled: checked }, checked ? 'IA coordinada activada' : 'IA coordinada apagada')
            }
          />
        </div>
        <p className="assistant-admin-config-hint">Excepciones en las que la IA puede usar el modelo:</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {AGENT_LLM_TRIGGERS.map((trigger) => {
            const id = `agents-trigger-${trigger}`;
            return (
              <div key={trigger} className="flex items-start gap-3 rounded-md border border-border p-3">
                <Switch
                  id={id}
                  checked={data.settings.llmTriggers[trigger]}
                  disabled={!canManage || savingSettings || !data.settings.enabled}
                  onCheckedChange={(checked) =>
                    void saveSettings(
                      { llmTriggers: { [trigger]: checked } },
                      `${AGENT_LLM_TRIGGER_LABELS[trigger].label}: ${checked ? 'activado' : 'apagado'}`
                    )
                  }
                />
                <label htmlFor={id} className="grid gap-0.5">
                  <span className="font-medium">{AGENT_LLM_TRIGGER_LABELS[trigger].label}</span>
                  <span className="assistant-admin-config-hint">{AGENT_LLM_TRIGGER_LABELS[trigger].description}</span>
                </label>
              </div>
            );
          })}
        </div>
      </section>

      <section className="assistant-admin-section" aria-labelledby="agents-identities-title">
        <h3 id="agents-identities-title" className="assistant-admin-section-title">
          <Sparkles size={18} /> Identidades, modo y presupuestos
        </h3>
        <p className="assistant-admin-config-hint">
          Presupuesto diario de tokens y mensual de costo pagado. Al llegar al umbral de degradación la IA sólo
          responde si la mencionan; al 100% queda en pausa. 0 = sin tope en ese presupuesto.
        </p>
        {data.identities.length === 0 ? (
          <div className="assistant-admin-empty">
            Aún no hay identidades de IA. Se crean al arrancar el servidor.
          </div>
        ) : (
          <div className="assistant-admin-table-wrap">
            <table className="assistant-admin-table">
              <thead>
                <tr>
                  <th scope="col">Agente</th>
                  <th scope="col">Modo</th>
                  <th scope="col">Tokens al día</th>
                  <th scope="col">Costo al mes (USD)</th>
                  <th scope="col">Turnos por expediente al día</th>
                  <th scope="col">Consumo del periodo</th>
                  <th scope="col">Estado</th>
                  <th scope="col">
                    <span className="sr-only">Guardar</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.identities.map((identity) => (
                  <IdentityRow
                    key={`${identity.key}:${identity.mode}:${identity.dailyTokenBudget}:${identity.monthlyCostBudgetUsd}:${identity.maxTurnsPerCasePerDay}`}
                    identity={identity}
                    canManage={canManage}
                    onSave={saveIdentity}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Consumo por día"
          description="Tokens de IA de las áreas y de la IA administradora"
          state={stale ? 'loading' : data.usage.days.length === 0 ? 'empty' : undefined}
          emptyText="Sin consumo de IA en el periodo"
          height={260}
        >
          <TrendChart
            data={data.usage.days}
            xKey="period"
            kind="area"
            series={[{ key: 'tokens', label: 'Tokens', tone: 'brand' }]}
            xFormat={fmtDay}
            yFormat={fmtInt}
            height={240}
            ariaLabel="Tokens de IA por día"
          />
        </ChartCard>
        <ChartCard
          title="Consumo por área"
          description="Tokens del periodo por área"
          state={stale ? 'loading' : totals.tokens === 0 ? 'empty' : undefined}
          emptyText="Sin consumo de IA por área en el periodo"
          height={260}
        >
          <BarBreakdown
            data={data.usage.areas.map((area) => ({ label: area.label, value: area.tokens }))}
            valueFormat={fmtInt}
            valueLabel="Tokens"
            categoryLabel="Área"
            height={240}
            ariaLabel="Tokens de IA por área"
          />
        </ChartCard>
      </div>

      <section className="assistant-admin-section" aria-labelledby="agents-areas-title">
        <h3 id="agents-areas-title" className="assistant-admin-section-title">
          <Coins size={18} /> Consumo por área
        </h3>
        <div className="assistant-admin-table-wrap">
          <table className="assistant-admin-table">
            <thead>
              <tr>
                <th scope="col">Área</th>
                <th scope="col">Tokens</th>
                <th scope="col">Tarifa plana</th>
                <th scope="col">Costo pagado</th>
                <th scope="col">Costo amortizado</th>
                <th scope="col">Turnos</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.areas.map((area) => (
                <tr key={area.areaKey}>
                  <td>{area.label}</td>
                  <td>{fmtInt(area.tokens)}</td>
                  <td>{fmtInt(area.flatTokens)}</td>
                  <td>{fmtUsd(area.usd)}</td>
                  <td>{fee === null ? '—' : fmtUsd(area.amortizedUsd)}</td>
                  <td>{fmtInt(area.turns)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="assistant-admin-section" aria-labelledby="agents-triggers-title">
        <h3 id="agents-triggers-title" className="assistant-admin-section-title">
          <Zap size={18} /> Principales disparos
        </h3>
        {data.eventsTruncated ? (
          <p className="assistant-admin-config-hint">
            Hubo muchos turnos en el periodo: los conteos usan los 5,000 más recientes.
          </p>
        ) : null}
        {data.events.triggers.length === 0 ? (
          <div className="assistant-admin-empty">Ningún agente tomó turnos con el modelo en el periodo.</div>
        ) : (
          <div className="assistant-admin-table-wrap">
            <table className="assistant-admin-table">
              <thead>
                <tr>
                  <th scope="col">Disparo</th>
                  <th scope="col">Turnos</th>
                  <th scope="col">Saltados</th>
                  <th scope="col">Fallidos</th>
                  <th scope="col">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {data.events.triggers.map((stat) => (
                  <tr key={stat.trigger}>
                    <td>{stat.label}</td>
                    <td>{fmtInt(stat.turns)}</td>
                    <td>{fmtInt(stat.skipped)}</td>
                    <td>{fmtInt(stat.failed)}</td>
                    <td>{fmtInt(stat.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.events.skipReasons.length > 0 ? (
          <ul className="assistant-admin-list" aria-label="Motivos de turnos saltados">
            {data.events.skipReasons.map((reason) => (
              <li key={reason.reason} className="assistant-admin-list-item">
                <span className="assistant-admin-list-name">{reason.label}</span>
                <span className="assistant-admin-list-count">{fmtInt(reason.count)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function IdentityRow({
  identity,
  canManage,
  onSave,
}: {
  identity: AgentsAdminIdentity;
  canManage: boolean;
  onSave: (key: string, patch: Omit<AgentIdentityPatch, 'key'>) => Promise<void>;
}) {
  const [mode, setMode] = useState(identity.mode);
  const [daily, setDaily] = useState(String(identity.dailyTokenBudget));
  const [monthly, setMonthly] = useState(String(identity.monthlyCostBudgetUsd));
  const [turns, setTurns] = useState(String(identity.maxTurnsPerCasePerDay));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const draft = buildIdentityDraftPatch(identity, {
    mode,
    dailyTokenBudget: daily,
    monthlyCostBudgetUsd: monthly,
    maxTurnsPerCasePerDay: turns,
  });
  const dirty = draft.ok && Object.keys(draft.patch).length > 0;
  const disabled = !canManage || saving;
  const budget = identity.budget;

  async function handleSave() {
    if (!draft.ok || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(identity.key, draft.patch);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'No se pudo guardar');
    } finally {
      // The reload remounts the row when values change; if it does not (same values, failed reload)
      // the row never stays locked in "Guardando".
      setSaving(false);
    }
  }

  return (
    <tr>
      <td>
        <div className="font-medium">{identity.displayName}</div>
        <div className="assistant-admin-muted">
          {identity.bot ? `@${identity.bot.username}` : 'Sin usuario de IA'}
          {identity.bot && !identity.bot.isActive ? ' · inactivo' : ''}
        </div>
      </td>
      <td>
        <select
          className="assistant-admin-select"
          value={mode}
          disabled={disabled}
          aria-label={`Modo de ${identity.displayName}`}
          onChange={(e) => setMode(e.target.value)}
        >
          {AGENT_MODES.map((m) => (
            <option key={m} value={m}>
              {AGENT_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="number"
          className="assistant-admin-filter-input"
          min={AGENT_BUDGET_LIMITS.dailyTokenBudget.min}
          max={AGENT_BUDGET_LIMITS.dailyTokenBudget.max}
          step={1000}
          value={daily}
          disabled={disabled}
          aria-label={`Tokens al día de ${identity.displayName}`}
          onChange={(e) => setDaily(e.target.value)}
        />
        {budget ? <div className="assistant-admin-muted">Hoy: {fmtInt(budget.tokensToday)}</div> : null}
      </td>
      <td>
        <input
          type="number"
          className="assistant-admin-filter-input"
          min={AGENT_BUDGET_LIMITS.monthlyCostBudgetUsd.min}
          max={AGENT_BUDGET_LIMITS.monthlyCostBudgetUsd.max}
          step={0.01}
          value={monthly}
          disabled={disabled}
          aria-label={`Costo al mes de ${identity.displayName}`}
          onChange={(e) => setMonthly(e.target.value)}
        />
        {budget ? <div className="assistant-admin-muted">Mes: {fmtUsd(budget.usdMonth)}</div> : null}
      </td>
      <td>
        <input
          type="number"
          className="assistant-admin-filter-input"
          min={AGENT_BUDGET_LIMITS.maxTurnsPerCasePerDay.min}
          max={AGENT_BUDGET_LIMITS.maxTurnsPerCasePerDay.max}
          step={1}
          value={turns}
          disabled={disabled}
          aria-label={`Turnos por expediente al día de ${identity.displayName}`}
          onChange={(e) => setTurns(e.target.value)}
        />
      </td>
      <td>
        <div>{fmtInt(identity.usage.tokens)} tokens</div>
        <div className="assistant-admin-muted">
          {fmtInt(identity.usage.turns)} turnos · {fmtInt(identity.usage.skipped)} saltados
          {identity.usage.usd > 0 ? ` · ${fmtUsd(identity.usage.usd)}` : ''}
        </div>
      </td>
      <td>
        {budget ? (
          <Badge variant={STATE_BADGE[budget.state]}>
            {BUDGET_STATE_LABELS[budget.state]} · {budget.pct}%
          </Badge>
        ) : (
          <Badge variant="weak">Sin datos</Badge>
        )}
      </td>
      <td>
        <Button
          type="button"
          size="sm"
          variant={dirty ? 'primary' : 'secondary'}
          icon={<Save size={14} />}
          isLoading={saving}
          disabled={!canManage || !dirty}
          onClick={() => void handleSave()}
        >
          Guardar
        </Button>
        {!draft.ok ? <div className="assistant-admin-error">{draft.error}</div> : null}
        {saveError ? <div className="assistant-admin-error">{saveError}</div> : null}
      </td>
    </tr>
  );
}
