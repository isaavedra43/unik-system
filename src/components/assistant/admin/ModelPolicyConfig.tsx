'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Coins, RefreshCw, Sparkles, Trophy, Zap } from 'lucide-react';
import { AI_TASK_LABELS, type AiTask } from '@/modules/ai/model-policy';
import { CANOPY_PLAN_MODELS } from './CanopyWaveSetup';

/**
 * "Reparto de modelos": which model serves each kind of work. The admin can
 * apply a preset (Canopy for the daily volume, OpenAI for complex turns) and
 * then fine-tune any row. Values are plain model ids so any provider works;
 * the datalist offers every model the configured providers expose.
 */

interface ModelOption {
  id: string;
  label: string;
  provider: string;
  costPer1M?: { input: number; output: number };
}

interface Props {
  settings: Record<string, unknown>;
  canManage: boolean;
  canopyConfigured: boolean;
  openaiConfigured: boolean;
  onChange: (patch: Record<string, unknown>) => void;
}

interface Row {
  key: string;
  task: AiTask | 'primary' | 'fallback';
  label: string;
  description: string;
  placeholder: string;
}

const ROWS: Row[] = [
  {
    key: 'routingSimpleModel',
    task: 'simple',
    label: AI_TASK_LABELS.simple.label,
    description: AI_TASK_LABELS.simple.description,
    placeholder: 'Vacío = modelo fallback',
  },
  {
    key: 'routingStandardModel',
    task: 'routine',
    label: AI_TASK_LABELS.routine.label,
    description: AI_TASK_LABELS.routine.description,
    placeholder: 'Vacío = modelo principal',
  },
  {
    key: 'routingComplexModel',
    task: 'complex',
    label: AI_TASK_LABELS.complex.label,
    description: AI_TASK_LABELS.complex.description,
    placeholder: 'Vacío = modelo principal',
  },
  {
    key: 'utilityModel',
    task: 'utility',
    label: AI_TASK_LABELS.utility.label,
    description: AI_TASK_LABELS.utility.description,
    placeholder: 'Vacío = modelo de tareas simples',
  },
  {
    key: 'qualityJudgeModel',
    task: 'judge',
    label: AI_TASK_LABELS.judge.label,
    description: AI_TASK_LABELS.judge.description,
    placeholder: 'Vacío = procesos de fondo',
  },
  {
    key: 'computerUseModel',
    task: 'computer',
    label: AI_TASK_LABELS.computer.label,
    description: AI_TASK_LABELS.computer.description,
    placeholder: 'Vacío = Gemini 2.5 Flash (OpenRouter) o rutina',
  },
  {
    key: 'deployment',
    task: 'primary',
    label: 'Modelo principal',
    description:
      'Respaldo de todo lo anterior cuando una fila está vacía; también lee documentos (visión).',
    placeholder: 'gpt-4o',
  },
  {
    key: 'fallbackDeployment',
    task: 'fallback',
    label: 'Modelo de emergencia',
    description:
      'Se usa a mitad de una respuesta si el modelo elegido falla (error del proveedor).',
    placeholder: 'gpt-4o-mini',
  },
];

const [KIMI, MINIMAX] = CANOPY_PLAN_MODELS;

export function ModelPolicyConfig({
  settings,
  canManage,
  canopyConfigured,
  openaiConfigured,
  onChange,
}: Props) {
  const [options, setOptions] = useState<ModelOption[]>([]);

  useEffect(() => {
    let active = true;
    fetch('/app/assistant/api/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { models?: ModelOption[] } | null) => {
        if (active && json?.models) setOptions(json.models);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const byId = useMemo(() => new Map(options.map((m) => [m.id, m])), [options]);
  const routingEnabled = settings.routingEnabled !== false;

  const describe = (id: string): string | null => {
    const m = byId.get(id);
    if (!m) return null;
    const cost = m.costPer1M
      ? m.costPer1M.input === 0 && m.costPer1M.output === 0
        ? 'tarifa plana'
        : `$${m.costPer1M.input}/$${m.costPer1M.output} por 1M tokens`
      : '';
    return `${m.label} · ${m.provider}${cost ? ` · ${cost}` : ''}`;
  };

  const presetCanopyRoutine = () =>
    onChange({
      routingEnabled: true,
      routingSimpleModel: MINIMAX.id,
      routingStandardModel: KIMI.id,
      routingComplexModel: 'gpt-4o',
      utilityModel: MINIMAX.id,
      qualityJudgeModel: MINIMAX.id,
      deployment: 'gpt-4o',
      fallbackDeployment: 'gpt-4o-mini',
    });

  const presetAllCanopy = () =>
    onChange({
      routingEnabled: true,
      routingSimpleModel: MINIMAX.id,
      routingStandardModel: KIMI.id,
      routingComplexModel: KIMI.id,
      utilityModel: MINIMAX.id,
      qualityJudgeModel: MINIMAX.id,
      deployment: KIMI.id,
      fallbackDeployment: MINIMAX.id,
    });

  // "Como ChatGPT": the thinking model for everything hard (and for reading photos/documents,
  // which follows the complex row); the flat-rate provider keeps the daily volume when present.
  const presetMaxQuality = () => {
    const gpt5 = options.find((m) => /^gpt-5(\.\d+)?$/.test(m.id))?.id ?? 'gpt-5';
    const cheap = canopyConfigured
      ? MINIMAX.id
      : options.some((m) => m.id === 'gpt-5-mini')
        ? 'gpt-5-mini'
        : 'gpt-4o-mini';
    const routine = canopyConfigured ? KIMI.id : cheap;
    onChange({
      routingEnabled: true,
      routingSimpleModel: cheap,
      routingStandardModel: routine,
      routingComplexModel: gpt5,
      utilityModel: cheap,
      qualityJudgeModel: cheap,
      deployment: gpt5,
      fallbackDeployment: 'gpt-4o',
      reasoningEffort: 'medium',
      answerReviewEnabled: true,
    });
  };

  const [detecting, setDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState<string | null>(null);
  const detectOpenAiModels = async () => {
    setDetecting(true);
    setDetectNote(null);
    try {
      const res = await fetch('/app/admin/assistant/api/providers/openai/models', {
        method: 'POST',
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        models?: string[];
        hasGpt5?: boolean;
        recommended?: string | null;
      };
      if (!json.ok) {
        setDetectNote(json.error ?? 'No se pudo detectar');
        return;
      }
      const ids = json.models ?? [];
      setOptions((prev) => {
        const known = new Set(prev.map((m) => m.id));
        return [
          ...prev,
          ...ids
            .filter((id) => !known.has(id))
            .map((id) => ({ id, label: id, provider: 'openai' })),
        ];
      });
      setDetectNote(
        json.hasGpt5
          ? `Tu llave lista ${ids.length} modelos de chat, incluido ${json.recommended ?? 'GPT-5'}. Aplica "Máxima calidad" para usarlo en lo complejo.`
          : `Tu llave lista ${ids.length} modelos de chat pero ninguno GPT-5: revisa el acceso de tu cuenta en OpenAI.`
      );
    } catch (err) {
      setDetectNote(err instanceof Error ? err.message : 'Error al detectar');
    } finally {
      setDetecting(false);
    }
  };

  const presetAllOpenAi = () =>
    onChange({
      routingEnabled: true,
      routingSimpleModel: 'gpt-4o-mini',
      routingStandardModel: 'gpt-4o-mini',
      routingComplexModel: 'gpt-4o',
      utilityModel: 'gpt-4o-mini',
      qualityJudgeModel: 'gpt-4o-mini',
      deployment: 'gpt-4o',
      fallbackDeployment: 'gpt-4o-mini',
    });

  return (
    <div className="assistant-admin-config-section">
      <h3 className="assistant-admin-section-title">
        <Coins size={18} /> Reparto de modelos por tipo de tarea
      </h3>
      <p className="assistant-admin-config-hint" style={{ marginBottom: 12 }}>
        El asistente clasifica cada mensaje (simple / rutina / compleja) y los procesos de fondo
        piden su modelo aquí. Pon el volumen diario en el proveedor de tarifa plana y deja el caro
        solo para lo complejo. Puedes escribir cualquier id de modelo de un proveedor configurado.
      </p>

      <div className="model-policy-presets">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={presetCanopyRoutine}
          disabled={!canManage || !canopyConfigured || !openaiConfigured}
          title={
            !canopyConfigured || !openaiConfigured
              ? 'Requiere Canopy Wave y OpenAI configurados'
              : undefined
          }
        >
          <Coins size={14} /> Canopy para rutina, OpenAI para lo complejo
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={presetAllCanopy}
          disabled={!canManage || !canopyConfigured}
        >
          <Zap size={14} /> Todo en Canopy
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={presetAllOpenAi}
          disabled={!canManage || !openaiConfigured}
        >
          <Sparkles size={14} /> Todo en OpenAI
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={presetMaxQuality}
          disabled={!canManage || !openaiConfigured}
          title="GPT-5 (razonamiento) para análisis, documentos y lectura de fotos; revisión interna activada"
        >
          <Trophy size={14} /> Máxima calidad (GPT-5, como ChatGPT)
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={detectOpenAiModels}
          disabled={!canManage || !openaiConfigured || detecting}
        >
          <RefreshCw size={14} className={detecting ? 'copilot-spin' : undefined} />{' '}
          {detecting ? 'Detectando…' : 'Detectar modelos de OpenAI'}
        </button>
        <label className="model-policy-toggle">
          <input
            type="checkbox"
            checked={routingEnabled}
            onChange={(e) => onChange({ routingEnabled: e.target.checked })}
            disabled={!canManage}
          />
          <span>
            Clasificar mensajes automáticamente (si se apaga, todo usa el modelo principal)
          </span>
        </label>
      </div>

      {detectNote && (
        <p className="assistant-admin-config-hint" style={{ marginTop: 8 }}>
          {detectNote}
        </p>
      )}

      <datalist id="model-policy-options">
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} · {m.provider}
          </option>
        ))}
      </datalist>

      <div className="model-policy-table">
        {ROWS.map((row) => {
          const value = String(settings[row.key] ?? '');
          const effective = describe(value);
          return (
            <div key={row.key} className="model-policy-row">
              <div className="model-policy-row-text">
                <strong>{row.label}</strong>
                <span className="assistant-admin-config-hint">{row.description}</span>
              </div>
              <div className="model-policy-row-input">
                <input
                  type="text"
                  list="model-policy-options"
                  value={value}
                  placeholder={row.placeholder}
                  onChange={(e) => onChange({ [row.key]: e.target.value })}
                  disabled={!canManage}
                  aria-label={row.label}
                />
                <span className="assistant-admin-config-hint">
                  {value
                    ? (effective ??
                      'Id no reconocido: se enviará tal cual al proveedor que lo declare')
                    : row.placeholder}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
