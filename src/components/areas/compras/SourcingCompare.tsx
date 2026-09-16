'use client';

import { X } from 'lucide-react';
import { Button, IconButton } from '@/components/ui/primitives';
import {
  MAX_COMPARED_CANDIDATES,
  candidateConfidenceLevel,
  formatMoney,
} from '@/modules/areas/compras/compras-model';
import type { SourcingCandidateView } from './sourcing-types';

/**
 * Side-by-side comparison of up to four candidates (plan 7.6). Attributes are
 * rows and candidates are columns, which is what lets a person read one
 * attribute across suppliers without scrolling vertically.
 *
 * The table scrolls inside its own box, never the page.
 */

export interface SourcingCompareProps {
  candidates: SourcingCandidateView[];
  canAct: boolean;
  busy: boolean;
  onRemove: (candidate: SourcingCandidateView) => void;
  onRequestQuote: (candidates: SourcingCandidateView[]) => void;
  onClear: () => void;
}

const CONFIDENCE_TEXT: Record<string, string> = {
  verified: 'Datos verificados',
  estimate: 'Estimación',
  assumption: 'Suposición',
};

/** Cheapest observed price of a candidate, when its snippets carried one. */
function bestPrice(candidate: SourcingCandidateView): string {
  const prices = candidate.priceSnippets
    .map((snippet) => ({ price: snippet.price, currency: snippet.currency, unit: snippet.unit }))
    .filter(
      (entry): entry is { price: number; currency: string | null; unit: string | null } =>
        typeof entry.price === 'number' && Number.isFinite(entry.price)
    );
  if (prices.length === 0) return 'Sin precio publicado';
  const cheapest = prices.reduce((best, entry) => (entry.price < best.price ? entry : best));
  return `${formatMoney(cheapest.price, cheapest.currency ?? 'MXN')}${cheapest.unit ? ` / ${cheapest.unit}` : ''}`;
}

function contactOf(candidate: SourcingCandidateView): string {
  return candidate.phone ?? candidate.email ?? 'Sin contacto';
}

export function SourcingCompare({
  candidates,
  canAct,
  busy,
  onRemove,
  onRequestQuote,
  onClear,
}: SourcingCompareProps) {
  if (candidates.length === 0) return null;

  const rows: Array<{ label: string; value: (candidate: SourcingCandidateView) => string }> = [
    { label: 'Estado', value: (candidate) => candidate.statusLabel },
    {
      label: 'Confianza',
      value: (candidate) => {
        const level = candidateConfidenceLevel(candidate.confidence);
        return level ? CONFIDENCE_TEXT[level] : 'Sin dato';
      },
    },
    { label: 'Precio observado', value: bestPrice },
    { label: 'Ubicación', value: (candidate) => candidate.location ?? 'Sin dato' },
    { label: 'Contacto', value: contactOf },
    { label: 'Sitio', value: (candidate) => candidate.domain ?? 'Sin sitio' },
    {
      label: 'Evidencias',
      value: (candidate) =>
        candidate.evidence.length === 1 ? '1 evidencia' : `${candidate.evidence.length} evidencias`,
    },
    {
      label: 'Ya es proveedor',
      value: (candidate) => (candidate.supplierId ? 'Sí' : 'No'),
    },
  ];

  return (
    <section className="compras-compare" aria-label="Comparación de candidatos">
      <div className="compras-lab-toolbar">
        <h3 className="compras-compare-title">
          Comparando {candidates.length} de {MAX_COMPARED_CANDIDATES}
        </h3>
        <div className="compras-panel-actions">
          {canAct ? (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => onRequestQuote(candidates)}
            >
              Solicitar cotización a los {candidates.length}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onClear}>
            Limpiar
          </Button>
        </div>
      </div>

      <div className="compras-table-scroll">
        <table className="compras-table">
          <caption className="sr-only">Comparación de candidatos de sourcing por atributo</caption>
          <thead>
            <tr>
              <th scope="col">Atributo</th>
              {candidates.map((candidate) => (
                <th key={candidate.id} scope="col" className="compras-table-wrap-cell">
                  {candidate.name}
                  <IconButton
                    aria-label={`Quitar ${candidate.name} de la comparación`}
                    onClick={() => onRemove(candidate)}
                  >
                    <X size={14} />
                  </IconButton>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {candidates.map((candidate) => (
                  <td key={`${candidate.id}-${row.label}`} className="compras-table-wrap-cell">
                    {row.value(candidate)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
