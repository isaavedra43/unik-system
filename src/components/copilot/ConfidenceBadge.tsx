'use client';

import React from 'react';
import { Cpu, Database, HelpCircle, ShieldCheck, TrendingUp, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CONFIDENCE_META, type ConfidenceLevel } from '@/modules/ai/confidence';
import type { TurnMeta } from './copilot-types';

/**
 * One quiet line under an assistant answer: how much to trust it (verified
 * data / estimate / assumption), which model answered and whether tools ran
 * in parallel or from cache. Same component in every surface.
 */
export function ConfidenceBadge({ level, note, meta, compact = false }: { level: ConfidenceLevel | null | undefined; note?: string | null; meta?: TurnMeta | null; compact?: boolean }) {
  const cachedHits = meta?.tools?.cachedHits ?? 0;
  const parallel = meta?.tools?.parallelBatches ?? 0;
  const model = meta?.model;
  if (!level && !model) return null;
  const info = level ? CONFIDENCE_META[level] : null;
  const Icon = level === 'verified' ? ShieldCheck : level === 'estimate' ? TrendingUp : HelpCircle;
  return (
    <div className={cn('turn-meta', compact && 'is-compact')} aria-label="Confianza y modelo de la respuesta">
      {info && (
        <span className={cn('confidence-badge', `is-${level}`)} title={note ? `${info.hint} ${note}` : info.hint}>
          <Icon size={12} />
          {info.label}
          {note && !compact && <span className="confidence-note">· {note}</span>}
        </span>
      )}
      {model && (
        <span className="turn-chip" title={meta?.routing?.routed ? `Modelo elegido automáticamente: ${meta.routing.reason ?? ''}` : 'Modelo fijado por el usuario'}>
          <Cpu size={11} />
          {model}
          {meta?.routing?.routed && <span className="turn-chip-auto">auto</span>}
        </span>
      )}
      {parallel > 0 && (
        <span className="turn-chip" title="Consultas independientes ejecutadas al mismo tiempo">
          <Zap size={11} />
          en paralelo
        </span>
      )}
      {cachedHits > 0 && (
        <span className="turn-chip" title="Resultados recientes reutilizados (caché de segundos)">
          <Database size={11} />
          caché ×{cachedHits}
        </span>
      )}
    </div>
  );
}
