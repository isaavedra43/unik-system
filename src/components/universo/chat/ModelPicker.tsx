'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { Brain, Check, ChevronDown, Eye, Search, Sparkles, Wrench, Zap } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { cn } from '@/lib/utils';

/**
 * Model picker. "Automático" is the default: the router gives quick questions
 * a fast model and complex / coding / computer work the strongest one. An
 * explicit pick always wins (persisted per browser).
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
  costPer1M?: { input: number; output: number };
}

export const AUTO_MODEL = 'auto';
const STORE_KEY = 'unik.universo.model';

const SPEED: Record<string, string> = { fast: 'Rápido', medium: 'Equilibrado', slow: 'Profundo' };

export function loadStoredModel(): string {
  try {
    return window.localStorage.getItem(STORE_KEY) || AUTO_MODEL;
  } catch {
    return AUTO_MODEL;
  }
}

function Power({ value }: { value: number }) {
  const on = Math.max(1, Math.min(5, Math.round(value / 2)));
  return (
    <span className="uv-power" aria-label={`Potencia ${value} de 10`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={cn(i <= on && 'is-on')} />
      ))}
    </span>
  );
}

export function ModelPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/app/assistant/api/models')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { models?: ModelOption[] } | null) => {
        if (!alive) return;
        const list = d?.models ?? [];
        setModels(list);
        // A stored pick that no longer exists falls back to the router.
        if (value !== AUTO_MODEL && list.length > 0 && !list.some((m) => m.id === value))
          onChange(AUTO_MODEL);
      })
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const select = (id: string) => {
    onChange(id);
    try {
      window.localStorage.setItem(STORE_KEY, id);
    } catch {
      /* private mode */
    }
    setOpen(false);
  };

  const current = models?.find((m) => m.id === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = models ?? [];
    return q
      ? list.filter((m) => `${m.label} ${m.providerLabel} ${m.bestFor}`.toLowerCase().includes(q))
      : list;
  }, [models, query]);
  const groups = useMemo(() => {
    const map = new Map<string, ModelOption[]>();
    for (const m of filtered) {
      const k = m.providerLabel || m.provider;
      map.set(k, [...(map.get(k) ?? []), m]);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="uv-model-trigger"
          disabled={disabled}
          aria-label="Elegir modelo de IA"
        >
          {value === AUTO_MODEL ? <Sparkles size={14} /> : <Zap size={14} />}
          <span>{value === AUTO_MODEL ? 'Automático' : (current?.label ?? value)}</span>
          <ChevronDown size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="uv-pop uv-scope"
        style={{ width: 340 }}
      >
        <div className="uv-pop-title">Modelo</div>
        <button
          type="button"
          className={cn('uv-pop-item', value === AUTO_MODEL && 'is-selected')}
          onClick={() => select(AUTO_MODEL)}
        >
          <span className="uv-pop-item-icon">
            <Sparkles size={15} />
          </span>
          <span className="uv-pop-item-text">
            <span className="uv-pop-item-name">
              Automático {value === AUTO_MODEL && <Check size={13} />}
            </span>
            <span className="uv-pop-item-sub">
              Elige el mejor modelo en cada mensaje: rápido para preguntas, el más potente para
              código, análisis y la computadora.
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
        <div className="uv-pop-list">
          {models === null && <div className="uv-skel" style={{ height: 44, margin: 6 }} />}
          {models !== null && filtered.length === 0 && (
            <div className="uv-empty" style={{ padding: 16 }}>
              Sin modelos que coincidan.
            </div>
          )}
          {groups.map(([provider, list]) => (
            <div key={provider}>
              <div className="uv-pop-title">{provider}</div>
              {list.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={cn('uv-pop-item', value === m.id && 'is-selected')}
                  onClick={() => select(m.id)}
                  title={m.description}
                >
                  <span className="uv-pop-item-text">
                    <span className="uv-pop-item-name">
                      {m.label}
                      {value === m.id && <Check size={13} />}
                      <span style={{ marginLeft: 'auto' }}>
                        <Power value={m.power} />
                      </span>
                    </span>
                    <span className="uv-pop-item-sub">{m.bestFor}</span>
                    <span className="uv-pop-item-tags">
                      <span>{SPEED[m.speed] ?? m.speed}</span>
                      {m.capabilities.includes('reasoning') && (
                        <span>
                          <Brain size={10} /> Razona
                        </span>
                      )}
                      {m.capabilities.includes('vision') && (
                        <span>
                          <Eye size={10} /> Ve imágenes
                        </span>
                      )}
                      {m.capabilities.includes('tool_use') && (
                        <span>
                          <Wrench size={10} /> Usa herramientas
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
