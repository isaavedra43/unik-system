'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Badge, Button, FormField, Textarea } from '@/components/ui/primitives';
import { formatDueLabel } from '@/components/operations/mywork-model';
import type { AreaRequestActionOption } from '@/modules/areas/requests-model';
import {
  isOpenRequestStatus,
  requestMetaLine,
  requestStatusTone,
  summarizeRequests,
  type AreaRequestRow,
} from './area-comms-model';

/**
 * Requests of an area (plan 7.5): the ones it received, which it can accept,
 * answer, block or reject, and the ones it sent, which the other area decides.
 *
 * Every decision goes through the existing route
 * `POST /app/operations/api/requests/[id]/respond`, which runs the core command
 * (`request.accept|block|resolve|reject`): the same checks, the same events and
 * the same notifications as the chat card or "Mi trabajo". Nothing about the
 * business is decided here — the buttons are the ones the server computed.
 *
 * Free text written by other people is shown as a quote, never as instructions.
 */

export interface AreaRequestsPanelProps {
  areaLabel: string;
  incoming: AreaRequestRow[];
  outgoing: AreaRequestRow[];
  /** Spanish note when the list could not be read. */
  note: string | null;
  /** Server time of the render, so due labels match on hydration. */
  nowIso: string;
  /** Called after a decision lands, so the host can refresh its counters. */
  onDecided?: () => void;
}

interface PendingDecision {
  row: AreaRequestRow;
  action: AreaRequestActionOption;
}

const TEXT_MAX: Record<AreaRequestActionOption['form'], number> = {
  none: 0,
  note: 1000,
  reason: 500,
  answer: 4000,
};

function RequestCard({
  row,
  nowIso,
  onAct,
}: {
  row: AreaRequestRow;
  nowIso: string;
  onAct: (pending: PendingDecision) => void;
}) {
  const { request } = row;
  const open = isOpenRequestStatus(request.status);
  const due = formatDueLabel(request.dueAt, new Date(nowIso), { closed: !open });

  return (
    <article
      className={`area-comms-request${request.overdue && open ? ' area-comms-request-overdue' : ''}`}
    >
      <div className="area-comms-request-head">
        <span className="area-comms-request-title">{request.title}</span>
        <span className="area-comms-request-badges">
          <Badge variant={requestStatusTone(request)}>{request.statusLabel}</Badge>
          {request.blocksDelivery && open ? <Badge variant="warning">Bloquea entrega</Badge> : null}
          {request.priority !== 'normal' ? (
            <Badge variant="info">{request.priorityLabel}</Badge>
          ) : null}
        </span>
      </div>

      <p className="area-comms-request-meta">{requestMetaLine(request)}</p>
      <p className="area-comms-request-meta">
        <span title={due.title}>{due.label}</span>
        {request.ownerName ? ` · A cargo de ${request.ownerName}` : ' · Sin responsable'}
        {request.createdByName ? ` · La pidió ${request.createdByName}` : ''}
      </p>

      {request.freeText ? (
        <blockquote className="area-drawer-quote">{request.freeText}</blockquote>
      ) : null}

      <div className="area-comms-request-actions">
        {row.actions.map((action) => (
          <Button
            key={action.id}
            variant={
              action.tone === 'primary'
                ? 'primary'
                : action.tone === 'danger'
                  ? 'danger'
                  : 'secondary'
            }
            size="sm"
            onClick={() => onAct({ row, action })}
            title={action.hint}
          >
            {action.label}
          </Button>
        ))}
        {row.actions.length === 0 && row.noActionsReason ? (
          <span className="area-comms-request-reason">{row.noActionsReason}</span>
        ) : null}
      </div>
    </article>
  );
}

function DecisionDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: PendingDecision;
  onClose: () => void;
  onDone: () => void;
}) {
  const { row, action } = pending;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = `request-${action.id}-${row.request.id}`;

  async function submit() {
    if (busy) return;
    const value = text.trim();
    if (action.required && value.length < (action.form === 'reason' ? 3 : 1)) {
      setError(
        action.form === 'reason'
          ? 'Indica el motivo (mínimo 3 caracteres)'
          : `Escribe ${action.fieldLabel.toLowerCase()}`
      );
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { action: action.id, commandId: crypto.randomUUID() };
      if (action.form === 'note' && value) body.note = value;
      if (action.form === 'reason') body.reason = value;
      if (action.form === 'answer') body.answer = value;

      const response = await fetch(
        `/app/operations/api/requests/${encodeURIComponent(row.request.id)}/respond`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        setError(data.error ?? 'No se pudo completar la acción');
        return;
      }
      toast.success(data.message ?? action.successMessage);
      onDone();
      onClose();
    } catch {
      setError('No se pudo enviar la decisión; revisa tu conexión e inténtalo de nuevo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>{row.request.title}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <p className="text-muted text-sm">{action.hint}</p>
          {action.form === 'none' ? null : (
            <FormField
              label={`${action.fieldLabel}${action.required ? '' : ' (opcional)'}`}
              htmlFor={fieldId}
            >
              <Textarea
                id={fieldId}
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={4}
                maxLength={TEXT_MAX[action.form]}
                required={action.required}
                autoFocus
              />
            </FormField>
          )}
          {error ? <Alert variant="error">{error}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={action.tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Enviando…' : action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AreaRequestsPanel({
  areaLabel,
  incoming,
  outgoing,
  note,
  nowIso,
  onDecided,
}: AreaRequestsPanelProps) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const summary = summarizeRequests(incoming, outgoing);

  const done = () => {
    router.refresh();
    onDecided?.();
  };

  return (
    <div className="area-comms-requests">
      {note ? <Alert variant="warning">{note}</Alert> : null}

      <section className="area-comms-request-group" aria-labelledby="area-requests-in">
        <h3 className="area-comms-section-title" id="area-requests-in">
          Recibidas
          <span className="area-comms-section-count">
            {summary.incoming === 0
              ? 'ninguna abierta'
              : summary.incomingOverdue > 0
                ? `${summary.incoming} abiertas · ${summary.incomingOverdue} vencidas`
                : `${summary.incoming} abiertas`}
          </span>
        </h3>
        {incoming.length === 0 ? (
          <p className="area-comms-empty">
            {areaLabel} no tiene solicitudes pendientes de otras áreas.
          </p>
        ) : (
          incoming.map((row) => (
            <RequestCard
              key={row.request.id}
              row={row}
              nowIso={nowIso}
              onAct={(next) => setPending(next)}
            />
          ))
        )}
      </section>

      <section className="area-comms-request-group" aria-labelledby="area-requests-out">
        <h3 className="area-comms-section-title" id="area-requests-out">
          Enviadas
          <span className="area-comms-section-count">
            {summary.outgoing === 0
              ? 'ninguna abierta'
              : summary.outgoingOverdue > 0
                ? `${summary.outgoing} abiertas · ${summary.outgoingOverdue} vencidas`
                : `${summary.outgoing} abiertas`}
          </span>
        </h3>
        {outgoing.length === 0 ? (
          <p className="area-comms-empty">
            {areaLabel} no está esperando respuesta de otras áreas.
          </p>
        ) : (
          outgoing.map((row) => (
            <RequestCard
              key={row.request.id}
              row={row}
              nowIso={nowIso}
              onAct={(next) => setPending(next)}
            />
          ))
        )}
      </section>

      {pending ? (
        <DecisionDialog
          key={`${pending.row.request.id}-${pending.action.id}`}
          pending={pending}
          onClose={() => setPending(null)}
          onDone={done}
        />
      ) : null}
    </div>
  );
}
