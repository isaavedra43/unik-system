'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Button, FormField, Select, Textarea } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { CtExceptionRow } from '@/modules/control-tower/exceptions-service';
import {
  ACTION_FIELD_LABELS,
  actionFieldMax,
  buildExceptionCommand,
  buildExceptionPayload,
  type CtExceptionAction,
} from './exception-actions';

export interface PendingExceptionAction {
  row: CtExceptionRow;
  action: CtExceptionAction;
}

export interface ExceptionAssignee {
  id: string;
  name: string;
  areaLabel: string | null;
}

export interface ExceptionActionDialogProps {
  pending: PendingExceptionAction;
  /** People who can receive a reassigned work item. */
  assignees: readonly ExceptionAssignee[];
  online: boolean;
  onClose: () => void;
  /** Sends the command (or queues it offline); true when accepted or queued. */
  onSubmit: (
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
}

/**
 * One exception action that needs something more than a click: a note, a
 * reason, an answer or a new owner. Mounted per action, so its state starts
 * clean. The engine validates the same rules again — this only avoids sending
 * something it would surely reject.
 */
export function ExceptionActionDialog({
  pending,
  assignees,
  online,
  onClose,
  onSubmit,
}: ExceptionActionDialogProps) {
  const { row, action } = pending;
  const [text, setText] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldId = `ct-action-${action.id}-${row.id}`;
  const label = ACTION_FIELD_LABELS[action.form];

  async function submit() {
    if (busy) return;
    setError(null);
    const payload = buildExceptionPayload(action, { text, ownerUserId });
    if (!payload.ok) {
      setError(payload.error);
      return;
    }
    setBusy(true);
    try {
      const done = await onSubmit(
        buildExceptionCommand(action, row, payload.payload),
        action.successMessage
      );
      if (done) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar la acción');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{action.label}</DialogTitle>
          <DialogDescription>{row.title}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {action.confirm ? <Alert variant="warning">{action.confirm}</Alert> : null}
          {!online ? (
            <Alert variant="info">
              Sin conexión: la acción se guarda en este dispositivo y se envía sola al volver.
            </Alert>
          ) : null}

          {action.form === 'none' ? (
            <p className="text-muted text-sm">
              {action.hint ?? 'Se registrará con tu nombre y la hora en el expediente.'}
            </p>
          ) : null}

          {action.form === 'assignee' ? (
            <>
              <FormField
                label="Nuevo responsable"
                htmlFor={fieldId}
                help={action.hint ?? undefined}
                error={assignees.length === 0 ? 'No hay personas disponibles para recibirlo' : null}
              >
                <Select
                  id={fieldId}
                  value={ownerUserId}
                  onChange={(event) => setOwnerUserId(event.target.value)}
                  disabled={assignees.length === 0}
                  autoFocus
                >
                  <option value="">Elige a quién le pasa…</option>
                  {assignees.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.areaLabel ? `${person.name} · ${person.areaLabel}` : person.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label="Motivo (opcional)" htmlFor={`${fieldId}-reason`}>
                <Textarea
                  id={`${fieldId}-reason`}
                  rows={3}
                  maxLength={500}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </FormField>
            </>
          ) : null}

          {action.form !== 'none' && action.form !== 'assignee' ? (
            <FormField
              label={`${label}${action.required ? '' : ' (opcional)'}`}
              htmlFor={fieldId}
              help={action.hint ?? undefined}
            >
              <Textarea
                id={fieldId}
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={4}
                maxLength={actionFieldMax(action.form)}
                required={action.required}
                autoFocus
              />
            </FormField>
          ) : null}

          {error ? <Alert variant="error">{error}</Alert> : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={action.tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? 'Enviando…' : action.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
