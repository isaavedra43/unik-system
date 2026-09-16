'use client';

// `.ventas-signal*` viven en esta hoja: sin importarla aquí la story sale sin estilo.
import '@/styles/operations/ventas.css';
import { useState } from 'react';
import Link from 'next/link';
import { Check, Copy, MessageSquareText, MoreHorizontal, Sparkles } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { Badge, Button } from '@/components/ui/primitives';
import type { RadarSignalDTO } from '@/modules/crm/crm-dto';
import {
  canPrepareMessage,
  hasDraft,
  radarScoreTone,
  scoreWidth,
  signalCustomerLabel,
  signalLink,
  signalNextAction,
  snoozeOptions,
} from './radar-model';

export interface RadarSignalRowProps {
  signal: RadarSignalDTO;
  /** La señal está seleccionada: el copiloto del área la lleva en su contexto. */
  selected: boolean;
  /** Hay un comando de esta señal en curso. */
  busy: boolean;
  /** Se está pidiendo la explicación a la IA. */
  explaining: boolean;
  /** Hora del servidor con la que se calcularon las opciones de posponer. */
  now: Date;
  onSelect: () => void;
  onPrepareMessage: () => void;
  onSnooze: (untilIso: string) => void;
  onDismiss: () => void;
  onConvert: () => void;
  /** Inserta el borrador en el redactor del anfitrión (bandeja embebida). */
  onInsertDraft?: (text: string) => void;
}

const TONE_CLASS = {
  danger: 'ventas-signal-danger',
  warning: 'ventas-signal-warning',
  default: 'ventas-signal-default',
} as const;

const FILL_CLASS = {
  danger: 'ventas-score-fill-danger',
  warning: 'ventas-score-fill-warning',
  default: '',
} as const;

const BADGE_BY_TONE = {
  danger: 'danger',
  warning: 'warning',
  default: 'info',
} as const;

/**
 * Una señal del Radar de cierre (plan 7.6): puntaje, motivo con cifras,
 * siguiente acción y las decisiones que se pueden tomar sobre ella.
 *
 * El motivo y la explicación son texto de terceros (clientes, IA): se muestran
 * como contenido, nunca como instrucciones, y las acciones sólo salen de los
 * botones.
 */
export function RadarSignalRow({
  signal,
  selected,
  busy,
  explaining,
  now,
  onSelect,
  onPrepareMessage,
  onSnooze,
  onDismiss,
  onConvert,
  onInsertDraft,
}: RadarSignalRowProps) {
  const [copied, setCopied] = useState(false);
  const tone = radarScoreTone(signal.score);
  const width = scoreWidth(signal.score);
  const link = signalLink(signal);
  const draft = hasDraft(signal) ? (signal.aiSuggestedMessage as string) : null;
  const canPrepare = canPrepareMessage(signal);

  async function copyDraft() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <li
      className={`ventas-signal ${TONE_CLASS[tone]} ${selected ? 'ventas-signal-selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
    >
      <div className="ventas-signal-head">
        <span className="ventas-signal-customer">{signalCustomerLabel(signal)}</span>
        <Badge variant={BADGE_BY_TONE[tone]}>{signal.kindLabel}</Badge>
        {signal.salespersonName ? (
          <span className="ventas-muted">{signal.salespersonName}</span>
        ) : (
          <span className="ventas-muted">Sin vendedor asignado</span>
        )}
        <span className="ventas-signal-score">
          <span
            className="ventas-score-track"
            role="img"
            aria-label={`Puntaje ${width} de 100`}
            title={`Puntaje ${width} de 100`}
          >
            <span
              className={`ventas-score-fill ${FILL_CLASS[tone]}`}
              style={{ width: `${width}%` }}
            />
          </span>
          <span aria-hidden="true">{width}</span>
        </span>
      </div>

      <p className="ventas-signal-reason">{signal.reason}</p>
      <p className="ventas-signal-next">{signalNextAction(signal)}</p>

      {signal.aiExplanation ? (
        <p className="ventas-signal-explanation">{signal.aiExplanation}</p>
      ) : null}

      {draft ? (
        <div className="ventas-draft">
          <span className="ventas-field-label">Borrador sugerido por la IA</span>
          <p className="ventas-draft-text">{draft}</p>
          <div className="ventas-signal-actions">
            <Button variant="secondary" size="sm" onClick={copyDraft}>
              {copied ? (
                <Check size={14} aria-hidden="true" />
              ) : (
                <Copy size={14} aria-hidden="true" />
              )}
              {copied ? 'Copiado' : 'Copiar borrador'}
            </Button>
            {onInsertDraft ? (
              <Button variant="secondary" size="sm" onClick={() => onInsertDraft(draft)}>
                <MessageSquareText size={14} aria-hidden="true" />
                Poner en el mensaje
              </Button>
            ) : null}
            {signal.conversationId ? (
              <Link className="btn btn-ghost btn-sm" href="/app/inbox">
                Abrir bandeja
              </Link>
            ) : null}
          </div>
          <p className="ventas-hint">
            Revísalo antes de enviarlo: el envío sigue siendo tuyo, desde la conversación del
            cliente.
          </p>
        </div>
      ) : null}

      <div className="ventas-signal-actions">
        <Button
          variant="primary"
          size="sm"
          disabled={busy || explaining || !canPrepare}
          onClick={() => {
            onSelect();
            onPrepareMessage();
          }}
          title={
            canPrepare
              ? 'Pide a la IA la explicación y el mensaje para el cliente'
              : 'Esta señal no tiene conversación ni oportunidad a la que escribirle'
          }
        >
          <Sparkles size={14} aria-hidden="true" />
          {explaining ? 'Preparando…' : draft ? 'Actualizar mensaje' : 'Preparar mensaje'}
        </Button>

        {link ? (
          <Link className="btn btn-secondary btn-sm" href={link.href}>
            {link.label}
          </Link>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Más acciones para ${signalCustomerLabel(signal)}`}
              title="Más acciones"
              disabled={busy}
            >
              <MoreHorizontal size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Posponer</DropdownMenuLabel>
            {snoozeOptions(now).map((option) => (
              <DropdownMenuItem key={option.id} onSelect={() => onSnooze(option.until)}>
                {option.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onConvert}>Convertir en tarea</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={onDismiss}>
              Descartar señal
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {busy ? <span className="ventas-muted">Enviando…</span> : null}
      </div>
    </li>
  );
}
