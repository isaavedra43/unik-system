'use client';

import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, Star, Wrench, XCircle, Zap } from 'lucide-react';

/** Models of the Canopy Wave Unlimited Token Plan (ids verified on canopywave.com, 2026-09-14). */
export const CANOPY_PLAN_MODELS = [
  { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6' },
  { id: 'minimax/minimax-m3', label: 'MiniMax M3' },
];

interface Check {
  model: string;
  listed: boolean;
  chat: { success: boolean; latencyMs: number; error?: string };
  tools: { success: boolean; error?: string };
}

interface TestResponse {
  ok: boolean;
  error?: string;
  models: string[];
  checks: Check[];
}

interface CanopyWaveSetupProps {
  canManage: boolean;
  hasSavedKey: boolean;
  hasUnsavedKey: boolean;
  discoveredModels: string[];
  isDefault: boolean;
  onSave: () => Promise<void>;
  onReload: () => Promise<void>;
  onUseAsDefault: () => void;
}

/** Canopy Wave card extras: where to get the key, test + detect models, use as main provider. */
export function CanopyWaveSetup({
  canManage,
  hasSavedKey,
  hasUnsavedKey,
  discoveredModels,
  isDefault,
  onSave,
  onReload,
  onUseAsDefault,
}: CanopyWaveSetupProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  async function runTest() {
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      if (hasUnsavedKey) await onSave();
      const res = await fetch('/app/admin/assistant/api/providers/canopywave/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: CANOPY_PLAN_MODELS.map((m) => m.id) }),
      });
      const json = (await res.json().catch(() => ({}))) as TestResponse & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `Error ${res.status}`);
      setResult(json);
      if (json.ok) await onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo probar la conexión');
    } finally {
      setTesting(false);
    }
  }

  const models = result?.models ?? discoveredModels;
  const visibleModels = showAll ? models : models.slice(0, 8);
  const allGood = result?.ok && result.checks.every((c) => c.chat.success && c.tools.success);

  return (
    <div className="provider-card-fields" style={{ marginTop: 12 }}>
      <p className="assistant-admin-config-hint" style={{ margin: 0 }}>
        1. En Canopy Wave abre <strong>Model API → Model API Key → Monthly Subscription</strong> y copia la llave de tu plan.
        2. Pégala arriba. 3. Pulsa <strong>Probar y detectar modelos</strong>.{' '}
        <a href="https://canopywave.com/docs/guide-to-claiming-and-canceling-your-plan" target="_blank" rel="noopener noreferrer">
          Guía <ExternalLink size={11} style={{ display: 'inline' }} />
        </a>
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button
          type="button"
          className="assistant-admin-test-btn"
          onClick={() => void runTest()}
          disabled={!canManage || testing || (!hasSavedKey && !hasUnsavedKey)}
        >
          {testing ? <Loader2 size={14} className="spin" /> : <Zap size={14} />}
          {testing ? 'Probando… (hasta 1 min)' : hasUnsavedKey ? 'Guardar, probar y detectar modelos' : 'Probar y detectar modelos'}
        </button>
        <button
          type="button"
          className="assistant-admin-test-btn"
          onClick={onUseAsDefault}
          disabled={!canManage || isDefault || (!hasSavedKey && !hasUnsavedKey)}
          title="Kimi K2.6 como principal y MiniMax M3 como respaldo. Después pulsa Guardar configuración."
        >
          <Star size={14} /> {isDefault ? 'Es el proveedor principal' : 'Usar como principal'}
        </button>
      </div>

      {error && (
        <div className="assistant-admin-error" role="alert">
          <AlertCircle size={14} /> {error}
        </div>
      )}
      {result && !result.ok && (
        <div className="assistant-admin-error" role="alert">
          <AlertCircle size={14} /> {result.error}
        </div>
      )}

      {result?.ok && (
        <div className={allGood ? 'assistant-admin-success' : 'assistant-admin-error'} role="status" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <strong>{allGood ? 'Listo: la IA ya puede usar tu plan de Canopy Wave.' : 'Conectado, pero algo necesita atención:'}</strong>
          {result.checks.map((c) => (
            <div key={c.model} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontSize: 12 }}>
              <span style={{ minWidth: 150, fontWeight: 600 }}>{CANOPY_PLAN_MODELS.find((m) => m.id === c.model)?.label ?? c.model}</span>
              <span>
                {c.chat.success ? <CheckCircle2 size={12} style={{ display: 'inline' }} /> : <XCircle size={12} style={{ display: 'inline' }} />} Chat
                {c.chat.success ? ` (${(c.chat.latencyMs / 1000).toFixed(1)} s)` : ''}
              </span>
              <span>
                {c.tools.success ? <CheckCircle2 size={12} style={{ display: 'inline' }} /> : <Wrench size={12} style={{ display: 'inline' }} />} Herramientas
              </span>
              {!c.listed && <span>· no aparece en /models de tu llave</span>}
              {(c.chat.error || (!c.tools.success && c.tools.error)) && (
                <span style={{ flexBasis: '100%', opacity: 0.85 }}>{c.chat.error ?? c.tools.error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {models.length > 0 && (
        <div>
          <span className="assistant-admin-config-hint">
            {models.length} modelo{models.length === 1 ? '' : 's'} disponible{models.length === 1 ? '' : 's'} con tu llave (aparecen en el selector del chat):
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            {visibleModels.map((id) => (
              <code key={id} className="assistant-admin-badge" style={CANOPY_PLAN_MODELS.some((m) => m.id === id) ? { fontWeight: 700 } : undefined}>
                {id}
              </code>
            ))}
            {models.length > 8 && (
              <button type="button" className="assistant-admin-test-btn" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Ver menos' : `Ver ${models.length - 8} más`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
