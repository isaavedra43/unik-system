'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Feather,
  Gauge,
  Rocket,
  Search,
  Zap,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { cn } from '@/lib/utils';
import { DEFAULT_EFFORT, EFFORT_LEVELS, type EffortLevel } from '@/modules/ai/effort-levels';

/**
 * Effort picker — how hard the agent works, not which engine: Ultra-rápido,
 * Ligero, Medio, Alto, Ultra. The server turns the level into a real policy
 * (model by capabilities, reasoning, steps, verification, fallbacks). A
 * specific model stays available under "Modelo específico" for power users.
 */

export interface ModelOption {
  id: string;
  provider: string;
  providerLabel: string;
  label: string;
  power: number;
  bestFor: string;
  speed: 'fast' | 'medium' | 'slow';
  capabilities: string[];
  description: string;
  health?: { lastKind?: string; retryAt?: string | null } | null;
}

export interface EffortValue {
  effort: EffortLevel;
  /** A specific model the user fixed (null = chosen by the effort level). */
  model: string | null;
}

const EFFORT_KEY = 'unik.universo.effort';
const MODEL_KEY = 'unik.universo.model';

export const LEVEL_ICON: Record<EffortLevel, React.ComponentType<{ size?: number }>> = {
  instant: Zap,
  light: Feather,
  medium: Gauge,
  high: Brain,
  ultra: Rocket,
};

export function loadStoredEffort(): EffortValue {
  try {
    const e = window.localStorage.getItem(EFFORT_KEY) as EffortLevel | null;
    const m = window.localStorage.getItem(MODEL_KEY);
    return {
      effort: e && EFFORT_LEVELS.some((l) => l.id === e) ? e : DEFAULT_EFFORT,
      // "auto" was the old router default: it means no fixed model.
      model: m && m !== 'auto' ? m : null,
    };
  } catch {
    return { effort: DEFAULT_EFFORT, model: null };
  }
}

function store(value: EffortValue) {
  try {
    window.localStorage.setItem(EFFORT_KEY, value.effort);
    if (value.model) window.localStorage.setItem(MODEL_KEY, value.model);
    else window.localStorage.removeItem(MODEL_KEY);
  } catch {
    /* private mode */
  }
}

function failureText(kind?: string): string {
  switch (kind) {
    case 'auth':
      return 'La llave no tiene acceso';
    case 'not_found':
      return 'No está habilitado en tu cuenta';
    case 'rate_limit':
      return 'Límite de uso alcanzado';
    case 'timeout':
      return 'No respondió a tiempo';
    case 'empty':
      return 'Devolvió respuestas vacías';
    default:
      return 'Falló hace poco';
  }
}

export function EffortPicker({
  value,
  onChange,
  disabled,
}: {
  value: EffortValue;
  onChange: (value: EffortValue) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(Boolean(value.model));
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [query, setQuery] = useState('');
  const latest = useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  // The model list is only needed once the picker opens.
  useEffect(() => {
    if (!open || models !== null) return;
    let alive = true;
    fetch('/app/assistant/api/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { models?: ModelOption[] } | null) => {
        if (!alive) return;
        const list = d?.models ?? [];
        setModels(list);
        // A stored model the account no longer serves goes back to the effort router.
        const { value: v, onChange: change } = latest.current;
        if (v.model && list.length > 0 && !list.some((m) => m.id === v.model)) {
          const next = { ...v, model: null };
          store(next);
          change(next);
        }
      })
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [open, models]);

  const set = (next: EffortValue, close = true) => {
    store(next);
    onChange(next);
    if (close) setOpen(false);
  };

  const level = EFFORT_LEVELS.find((l) => l.id === value.effort) ?? EFFORT_LEVELS[2];
  const Icon = LEVEL_ICON[level.id];
  const current = models?.find((m) => m.id === value.model);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = models ?? [];
    return q
      ? list.filter((m) => `${m.label} ${m.providerLabel} ${m.bestFor}`.toLowerCase().includes(q))
      : list;
  }, [models, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('uv-model-trigger', `is-${level.id}`)}
          disabled={disabled}
          aria-label={`Esfuerzo: ${level.label}${value.model ? ` · modelo ${current?.label ?? value.model}` : ''}`}
        >
          {value.model ? <Cpu size={14} /> : <Icon size={14} />}
          <span>{value.model ? (current?.label ?? value.model) : level.label}</span>
          <ChevronDown size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="uv-pop uv-scope uv-effort-pop"
        style={{ width: 350 }}
      >
        <div className="uv-pop-title">Esfuerzo</div>
        <div role="radiogroup" aria-label="Esfuerzo del agente" className="uv-effort-list">
          {EFFORT_LEVELS.map((l, i) => {
            const LIcon = LEVEL_ICON[l.id];
            const selected = !value.model && value.effort === l.id;
            return (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={cn(
                  'uv-pop-item uv-effort-item',
                  `is-${l.id}`,
                  selected && 'is-selected'
                )}
                onClick={() => set({ effort: l.id, model: null })}
              >
                <span className="uv-pop-item-icon uv-effort-icon">
                  <LIcon size={15} />
                </span>
                <span className="uv-pop-item-text">
                  <span className="uv-pop-item-name">
                    {l.label}
                    {selected && <Check size={13} />}
                    <span className="uv-effort-meter" aria-hidden="true">
                      {[0, 1, 2, 3, 4].map((n) => (
                        <i key={n} className={cn(n <= i && 'is-on')} />
                      ))}
                    </span>
                  </span>
                  <span className="uv-pop-item-sub">{l.description}</span>
                  <span className="uv-effort-expect">{l.expect}</span>
                </span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className="uv-effort-advanced"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
        >
          {advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          Modelo específico
          {value.model && <span className="uv-effort-fixed">{current?.label ?? value.model}</span>}
        </button>
        {advanced && (
          <div className="uv-effort-models">
            <button
              type="button"
              className={cn('uv-pop-item', !value.model && 'is-selected')}
              onClick={() => set({ ...value, model: null })}
            >
              <span className="uv-pop-item-text">
                <span className="uv-pop-item-name">
                  Según el esfuerzo {!value.model && <Check size={13} />}
                </span>
                <span className="uv-pop-item-sub">
                  JEV y el nivel eligen el mejor modelo disponible en cada mensaje.
                </span>
              </span>
            </button>
            {(models?.length ?? 0) > 6 && (
              <label className="uv-pop-search">
                <Search size={14} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar modelo"
                  aria-label="Buscar modelo"
                />
              </label>
            )}
            <div className="uv-pop-list" style={{ maxHeight: 220 }}>
              {models === null && <div className="uv-skel" style={{ height: 40, margin: 6 }} />}
              {models !== null && filtered.length === 0 && (
                <div className="uv-empty" style={{ padding: 12 }}>
                  Sin modelos que coincidan.
                </div>
              )}
              {filtered.map((m) => {
                const failing = Boolean(m.health);
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={cn('uv-pop-item', value.model === m.id && 'is-selected')}
                    onClick={() => set({ ...value, model: m.id })}
                    title={m.description}
                  >
                    <span className="uv-pop-item-text">
                      <span className="uv-pop-item-name">
                        {m.label}
                        {value.model === m.id && <Check size={13} />}
                        <span className="uv-effort-provider">{m.providerLabel}</span>
                      </span>
                      {failing ? (
                        <span className="uv-pop-item-sub uv-effort-failing">
                          <AlertTriangle size={11} /> {failureText(m.health?.lastKind)} · se usa
                          otro mientras tanto
                        </span>
                      ) : (
                        <span className="uv-pop-item-sub">{m.bestFor}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <p className="uv-effort-foot">
          Si un modelo falla, el agente sigue con el siguiente disponible y te dice cuál usó.
        </p>
      </PopoverContent>
    </Popover>
  );
}
