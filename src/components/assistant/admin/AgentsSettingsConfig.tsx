'use client';

import React from 'react';
import { Bot, Clock, Coins, Gauge, Zap } from 'lucide-react';
import {
  AGENT_LLM_TRIGGERS,
  AGENT_LLM_TRIGGER_LABELS,
  AGENT_SETTING_LIMITS,
  normalizeAgentSettings,
  type AgentSettings,
} from '@/modules/ai/agent-settings';

/**
 * "IA coordinada por áreas": the AI behind every user and area (plan 5.4/5.6). It is on
 * from minute one; the brakes shown here are the quiet hours, the per-case caps, the
 * budget thresholds and which exceptions may call the model. Rules and templates
 * between areas never use the model and keep working even when this is off.
 */

interface ProviderEntry {
  monthlyFeeUsd?: number;
  [key: string]: unknown;
}

interface Props {
  settings: Record<string, unknown>;
  canManage: boolean;
  onChange: (patch: Record<string, unknown>) => void;
}

type NumericKey = keyof typeof AGENT_SETTING_LIMITS;

const NUMERIC_FIELDS: Array<{ key: NumericKey; label: string; hint: string; suffix?: string }> = [
  {
    key: 'maxTurnsPerCasePerDay',
    label: 'Turnos automáticos por expediente al día',
    hint: 'Por cada IA de área. 0 = sólo reglas y plantillas en los expedientes.',
  },
  {
    key: 'maxIterationsPerAutoTurn',
    label: 'Pasos de herramientas por turno automático',
    hint: 'Cuántas herramientas encadena la IA antes de concluir el turno.',
  },
  {
    key: 'degradeAtPct',
    label: 'Modo bajo demanda desde (%)',
    hint: 'Al consumir este % del presupuesto diario de tokens o mensual de costo, la IA sólo responde si la mencionan.',
    suffix: '%',
  },
  {
    key: 'alertAdminAtPct',
    label: 'Avisar a administradores desde (%)',
    hint: 'Aviso "Presupuesto de la IA de un área", una vez al día por área.',
    suffix: '%',
  },
];

/** Text being typed in the quiet-hours fields is kept as-is; the server validates it on save. */
function draftQuietHours(raw: unknown, normalized: AgentSettings['quietHours']): AgentSettings['quietHours'] {
  const qh =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? ((raw as Record<string, unknown>).quietHours as Record<string, unknown> | undefined)
      : undefined;
  return {
    start: typeof qh?.start === 'string' ? qh.start : normalized.start,
    end: typeof qh?.end === 'string' ? qh.end : normalized.end,
    tz: typeof qh?.tz === 'string' ? qh.tz : normalized.tz,
  };
}

export function AgentsSettingsConfig({ settings, canManage, onChange }: Props) {
  const normalized = normalizeAgentSettings(settings.agents);
  const agents: AgentSettings = { ...normalized, quietHours: draftQuietHours(settings.agents, normalized.quietHours) };
  const providerConfigs = (settings.providerConfigs as Record<string, ProviderEntry> | undefined) ?? {};
  const canopy = providerConfigs.canopywave ?? {};
  const fee = typeof canopy.monthlyFeeUsd === 'number' ? canopy.monthlyFeeUsd : null;

  function update(patch: Partial<AgentSettings>) {
    onChange({ agents: { ...agents, ...patch } });
  }

  function updateFee(raw: string) {
    const value = raw.trim() === '' ? null : Number(raw);
    onChange({
      providerConfigs: {
        ...providerConfigs,
        canopywave: {
          ...canopy,
          monthlyFeeUsd: value !== null && Number.isFinite(value) && value > 0 ? value : null,
        },
      },
    });
  }

  return (
    <div className="assistant-admin-config-section">
      <h3 className="assistant-admin-section-title">
        <Bot size={18} /> IA coordinada por áreas
      </h3>
      <p className="assistant-admin-config-hint" style={{ marginBottom: 16 }}>
        Cada área tiene su IA que anuncia solicitudes, destraba pendientes y propone acciones que aprueban los
        responsables. Los traspasos entre áreas son reglas y plantillas sin costo de modelo; aquí se ajustan los
        frenos de los turnos que sí usan el modelo.
      </p>

      <div className="assistant-admin-config-grid">
        <div className="assistant-admin-config-field">
          <span className="font-medium">IA coordinada activa</span>
          <span>{agents.enabled ? 'Encendida' : 'Apagada'}</span>
          <span className="assistant-admin-config-hint">
            Se enciende o apaga en la pestaña «Agentes y presupuestos». Apagada, las IA de área no toman turnos
            automáticos; las reglas, plantillas y avisos siguen.
          </span>
        </div>

        <div className="assistant-admin-config-field">
          <label htmlFor="cfg-agents-tz">
            <Clock size={12} style={{ display: 'inline', marginRight: 4 }} />
            Zona horaria de horario y presupuestos
          </label>
          <input
            id="cfg-agents-tz"
            type="text"
            value={agents.quietHours.tz}
            onChange={(e) => onChange({ agents: { ...agents, quietHours: { ...agents.quietHours, tz: e.target.value } } })}
            disabled={!canManage}
            placeholder="America/Mexico_City"
          />
          <span className="assistant-admin-config-hint">Define el día y el mes de los presupuestos.</span>
        </div>

        <div className="assistant-admin-config-field">
          <label htmlFor="cfg-agents-quiet-start">Horario silencioso desde</label>
          <input
            id="cfg-agents-quiet-start"
            type="text"
            inputMode="numeric"
            pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
            value={agents.quietHours.start}
            onChange={(e) =>
              onChange({ agents: { ...agents, quietHours: { ...agents.quietHours, start: e.target.value } } })
            }
            disabled={!canManage}
            placeholder="20:00"
          />
          <span className="assistant-admin-config-hint">
            HH:MM. En horario silencioso los turnos automáticos esperan; las menciones se atienden igual.
          </span>
        </div>

        <div className="assistant-admin-config-field">
          <label htmlFor="cfg-agents-quiet-end">Horario silencioso hasta</label>
          <input
            id="cfg-agents-quiet-end"
            type="text"
            inputMode="numeric"
            pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
            value={agents.quietHours.end}
            onChange={(e) =>
              onChange({ agents: { ...agents, quietHours: { ...agents.quietHours, end: e.target.value } } })
            }
            disabled={!canManage}
            placeholder="07:00"
          />
          <span className="assistant-admin-config-hint">HH:MM. Si es menor que el inicio, cruza la medianoche.</span>
        </div>

        {NUMERIC_FIELDS.map((field) => {
          const limits = AGENT_SETTING_LIMITS[field.key];
          return (
            <div key={field.key} className="assistant-admin-config-field">
              <label htmlFor={`cfg-agents-${field.key}`}>
                {field.suffix ? (
                  <Gauge size={12} style={{ display: 'inline', marginRight: 4 }} />
                ) : (
                  <Zap size={12} style={{ display: 'inline', marginRight: 4 }} />
                )}
                {field.label}
              </label>
              <input
                id={`cfg-agents-${field.key}`}
                type="number"
                min={limits.min}
                max={limits.max}
                step={1}
                value={agents[field.key]}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) update({ [field.key]: n } as Partial<AgentSettings>);
                }}
                disabled={!canManage}
              />
              <span className="assistant-admin-config-hint">{field.hint}</span>
            </div>
          );
        })}

        <div className="assistant-admin-config-field">
          <label htmlFor="cfg-agents-canopy-fee">
            <Coins size={12} style={{ display: 'inline', marginRight: 4 }} />
            Cuota mensual fija de Canopy Wave (USD)
          </label>
          <input
            id="cfg-agents-canopy-fee"
            type="number"
            min={0}
            step="0.01"
            value={fee ?? ''}
            onChange={(e) => updateFee(e.target.value)}
            disabled={!canManage}
            placeholder="Vacío = tarifa plana sin costo por token"
          />
          <span className="assistant-admin-config-hint">
            Los modelos de Canopy Wave cuentan como tokens de tarifa plana (US$0 contra el presupuesto). Con una
            cuota, los reportes muestran además el costo amortizado por token del mes.
          </span>
        </div>
      </div>

      <h4 className="assistant-admin-section-title" style={{ marginTop: 16 }}>
        <Zap size={16} /> Cuándo puede usar el modelo
      </h4>
      <p className="assistant-admin-config-hint">
        Se cambian en la pestaña «Agentes y presupuestos» (un solo lugar, con las mismas reglas).
      </p>
      <ul className="assistant-admin-list" aria-label="Excepciones que pueden usar el modelo">
        {AGENT_LLM_TRIGGERS.map((trigger) => (
          <li key={trigger} className="assistant-admin-list-item">
            <span className="assistant-admin-list-name">{AGENT_LLM_TRIGGER_LABELS[trigger].label}</span>
            <span className="assistant-admin-list-count">
              {agents.enabled && agents.llmTriggers[trigger] ? 'Activa' : 'Inactiva'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
