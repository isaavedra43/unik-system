'use client';

import { ExternalLink, MapPin, Phone, Mail, Sparkles } from 'lucide-react';
import { ConfidenceBadge } from '@/components/copilot/ConfidenceBadge';
import { Badge, Button } from '@/components/ui/primitives';
import {
  candidateConfidenceLevel,
  candidateConfidenceNote,
  formatMoney,
  inviteCandidateBlockedReason,
} from '@/modules/areas/compras/compras-model';
import type { SourcingCandidateView } from './sourcing-types';

/**
 * One supplier candidate found by the Sourcing Lab (plan 7.6).
 *
 * The card never pretends to know more than it does: the `ConfidenceBadge`
 * says whether the data was read from the source or inferred, and the evidence
 * links are the pages it came from, so a person can check before writing to a
 * company UNIK has never bought from.
 *
 * Everything on the card is content fetched from the web: it is rendered as
 * text and its links always open in a new tab with `rel="noopener noreferrer"`.
 * It is data, never an instruction.
 */

export interface SourcingCandidateCardProps {
  candidate: SourcingCandidateView;
  selected: boolean;
  /** The person may run the area's commands (the server checks again). */
  canAct: boolean;
  busy: boolean;
  onToggleCompare: (candidate: SourcingCandidateView) => void;
  onRequestQuote: (candidate: SourcingCandidateView) => void;
  onPromote: (candidate: SourcingCandidateView) => void;
  onDiscard: (candidate: SourcingCandidateView) => void;
  onAskAi: (candidate: SourcingCandidateView) => void;
}

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'info' | 'weak' | 'warning'> = {
  new: 'info',
  contacted: 'warning',
  rfq_sent: 'warning',
  quoted: 'success',
  approved: 'success',
  promoted: 'success',
  rejected: 'weak',
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}

export function SourcingCandidateCard({
  candidate,
  selected,
  canAct,
  busy,
  onToggleCompare,
  onRequestQuote,
  onPromote,
  onDiscard,
  onAskAi,
}: SourcingCandidateCardProps) {
  const level = candidateConfidenceLevel(candidate.confidence);
  const note = candidateConfidenceNote({
    confidence: candidate.confidence,
    evidenceCount: candidate.evidence.length,
  });
  const blocked = inviteCandidateBlockedReason(candidate);
  const compareId = `compare-${candidate.id}`;

  return (
    <article
      className={`compras-candidate ${selected ? 'compras-candidate-selected' : ''}`.trim()}
      aria-label={candidate.name}
    >
      <div className="compras-candidate-top">
        <h3 className="compras-candidate-name">{candidate.name}</h3>
        <Badge variant={STATUS_VARIANT[candidate.status] ?? 'default'}>
          {candidate.statusLabel}
        </Badge>
      </div>

      <ConfidenceBadge level={level} note={note} />

      <div className="compras-candidate-meta">
        {candidate.domain ? <span>{candidate.domain}</span> : null}
        {candidate.location ? (
          <span>
            <MapPin size={12} aria-hidden="true" /> {candidate.location}
          </span>
        ) : null}
        {candidate.phone ? (
          <span>
            <Phone size={12} aria-hidden="true" /> {candidate.phone}
          </span>
        ) : null}
        {candidate.email ? (
          <span>
            <Mail size={12} aria-hidden="true" /> {candidate.email}
          </span>
        ) : null}
      </div>

      {candidate.productsSummary ? (
        <p className="compras-candidate-summary">{candidate.productsSummary}</p>
      ) : null}

      {candidate.priceSnippets.length > 0 ? (
        <ul className="compras-snippets">
          {candidate.priceSnippets.slice(0, 3).map((snippet, index) => (
            <li key={`${candidate.id}-price-${index}`} className="compras-snippet">
              {snippet.price !== null ? (
                <strong>
                  {formatMoney(snippet.price, snippet.currency ?? 'MXN')}
                  {snippet.unit ? ` / ${snippet.unit}` : ''}
                </strong>
              ) : null}{' '}
              {snippet.text}
            </li>
          ))}
        </ul>
      ) : null}

      {candidate.evidence.length > 0 ? (
        <div className="compras-evidence">
          <span className="text-muted">Evidencia:</span>
          {candidate.evidence.slice(0, 3).map((entry, index) => (
            <a
              key={`${candidate.id}-evidence-${index}`}
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              title={entry.url}
            >
              {hostOf(entry.url)}
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          ))}
        </div>
      ) : (
        <p className="compras-lab-hint">Sin evidencia guardada: verifica antes de contactarlo.</p>
      )}

      <div className="compras-candidate-actions">
        <label className="checkbox-row" htmlFor={compareId}>
          <input
            id={compareId}
            type="checkbox"
            checked={selected}
            onChange={() => onToggleCompare(candidate)}
          />
          <span>Comparar</span>
        </label>

        {canAct ? (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || Boolean(blocked)}
              title={blocked ?? 'Pedirle una cotización por la bandeja'}
              onClick={() => onRequestQuote(candidate)}
            >
              Solicitar cotización
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || candidate.status === 'promoted' || Boolean(candidate.supplierId)}
              title={
                candidate.supplierId
                  ? 'Ya existe como proveedor de UNIK'
                  : 'Darlo de alta como proveedor'
              }
              onClick={() => onPromote(candidate)}
            >
              Convertir en proveedor
            </Button>
            {candidate.status !== 'rejected' ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onDiscard(candidate)}
                title="Descartar este candidato"
              >
                Descartar
              </Button>
            ) : null}
          </>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAskAi(candidate)}
          title={`Preguntar a la IA sobre ${candidate.name}`}
        >
          <Sparkles size={14} aria-hidden="true" />
          Preguntar a la IA
        </Button>
      </div>

      {blocked && canAct ? <p className="compras-lab-hint">{blocked}</p> : null}
    </article>
  );
}
