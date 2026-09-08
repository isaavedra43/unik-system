'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { ChevronDown, Zap, Check, Eye, Wrench, Radio, Brain, Code2 } from 'lucide-react';

export interface ModelOption {
  id: string;
  provider: string;
  providerLabel: string;
  label: string;
  power: number;
  bestFor: string;
  contextWindow: number;
  maxOutput: number;
  speed: 'fast' | 'medium' | 'slow';
  costPer1M: { input: number; output: number };
  capabilities: string[];
  description: string;
  available: boolean;
}

export interface ModelSelectorProps {
  value: string | null;
  onChange: (modelId: string) => void;
}

const SPEED_LABELS: Record<string, string> = {
  fast: 'Rápido',
  medium: 'Medio',
  slow: 'Lento',
};

const CAPABILITY_ICONS: Record<string, React.ReactNode> = {
  vision: <Eye size={12} />,
  tool_use: <Wrench size={12} />,
  streaming: <Radio size={12} />,
  reasoning: <Brain size={12} />,
  json_mode: <Code2 size={12} />,
  audio: <Radio size={12} />,
};

const CAPABILITY_LABELS: Record<string, string> = {
  vision: 'Visión',
  tool_use: 'Tools',
  streaming: 'Stream',
  reasoning: 'Razonamiento',
  json_mode: 'JSON',
  audio: 'Audio',
};

function PowerBars({ power }: { power: number }) {
  return (
    <div className="model-power-bars" aria-label={`Potencia ${power} de 10`}>
      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
        <div
          key={i}
          className={`model-power-bar ${i <= power ? 'active' : ''}`}
        />
      ))}
    </div>
  );
}

function formatCost(cost: { input: number; output: number }): string {
  if (cost.input === 0 && cost.output === 0) return 'Gratis';
  const inCost = cost.input < 1 ? `$${cost.input.toFixed(2)}` : `$${cost.input.toFixed(2)}`;
  const outCost = cost.output < 1 ? `$${cost.output.toFixed(2)}` : `$${cost.output.toFixed(2)}`;
  return `${inCost} / ${outCost}`;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/assistant/api/models');
      if (res.ok) {
        const data = await res.json();
        setModels(data.models ?? []);
        setDefaultModel(data.defaultModel ?? 'gpt-4o');
        // Set initial value if not set
        if (!value && data.defaultModel) {
          onChange(data.defaultModel);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [value, onChange]);

  useEffect(() => {
    load();
  }, [load]);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedModel = models.find((m) => m.id === value) ?? models.find((m) => m.id === defaultModel);

  // Group models by provider
  const grouped = models.reduce<Record<string, ModelOption[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="model-selector" ref={ref}>
      <button
        type="button"
        className="model-selector-trigger"
        onClick={() => setOpen(!open)}
        disabled={loading}
        aria-label="Seleccionar modelo"
        aria-expanded={open}
      >
        <Zap size={14} />
        <span className="model-selector-label">
          {loading ? 'Cargando…' : selectedModel ? selectedModel.label : 'Seleccionar'}
        </span>
        <ChevronDown size={14} className={`model-selector-chevron ${open ? 'open' : ''}`} />
      </button>

      {open && (
        <div className="model-selector-dropdown" role="listbox">
          {Object.entries(grouped).map(([provider, providerModels]) => (
            <div key={provider} className="model-selector-group">
              <div className="model-selector-group-header">
                {providerModels[0]?.providerLabel ?? provider}
              </div>
              {providerModels.map((m) => (
                <div
                  key={m.id}
                  className={`model-selector-item ${value === m.id ? 'selected' : ''}`}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  role="option"
                  aria-selected={value === m.id}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onChange(m.id);
                      setOpen(false);
                    }
                  }}
                >
                  <div className="model-selector-item-header">
                    <div className="model-selector-item-name">
                      {value === m.id && <Check size={14} className="model-selector-check" />}
                      {m.label}
                    </div>
                    <PowerBars power={m.power} />
                  </div>
                  <div className="model-selector-item-best-for">{m.bestFor}</div>
                  <div className="model-selector-item-meta">
                    <span className="model-selector-tag">{SPEED_LABELS[m.speed]}</span>
                    <span className="model-selector-tag">{formatContext(m.contextWindow)} ctx</span>
                    <span className="model-selector-tag">{formatCost(m.costPer1M)}/M</span>
                  </div>
                  <div className="model-selector-item-caps">
                    {m.capabilities.map((cap) => (
                      <span key={cap} className="model-selector-cap" title={CAPABILITY_LABELS[cap] ?? cap}>
                        {CAPABILITY_ICONS[cap]}
                        {CAPABILITY_LABELS[cap] ?? cap}
                      </span>
                    ))}
                  </div>
                  {/* Tooltip on hover */}
                  <div className="model-selector-tooltip">
                    <div className="model-selector-tooltip-title">{m.label}</div>
                    <p className="model-selector-tooltip-desc">{m.description}</p>
                    <div className="model-selector-tooltip-row">
                      <span className="model-selector-tooltip-key">Potencia</span>
                      <PowerBars power={m.power} />
                    </div>
                    <div className="model-selector-tooltip-row">
                      <span className="model-selector-tooltip-key">Ideal para</span>
                      <span>{m.bestFor}</span>
                    </div>
                    <div className="model-selector-tooltip-row">
                      <span className="model-selector-tooltip-key">Contexto</span>
                      <span>{formatContext(m.contextWindow)} tokens</span>
                    </div>
                    <div className="model-selector-tooltip-row">
                      <span className="model-selector-tooltip-key">Output máx</span>
                      <span>{formatContext(m.maxOutput)} tokens</span>
                    </div>
                    <div className="model-selector-tooltip-row">
                      <span className="model-selector-tooltip-key">Velocidad</span>
                      <span>{SPEED_LABELS[m.speed]}</span>
                    </div>
                    <div className="model-selector-tooltip-row">
                      <span className="model-selector-tooltip-key">Costo/1M</span>
                      <span>{formatCost(m.costPer1M)}</span>
                    </div>
                    <div className="model-selector-tooltip-row">
                      <span className="model-selector-tooltip-key">Capacidades</span>
                      <div className="model-selector-tooltip-caps">
                        {m.capabilities.map((cap) => (
                          <span key={cap} className="model-selector-cap">
                            {CAPABILITY_ICONS[cap]}
                            {CAPABILITY_LABELS[cap] ?? cap}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
