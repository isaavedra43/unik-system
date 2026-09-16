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
import { Alert, Button, FormField, Input, Textarea } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import type { AreaRowAction } from '@/modules/areas/work-actions';
import {
  ANSWER_MAX,
  NOTE_MAX,
  REASON_MAX,
  actionFieldLabel,
  actionFieldRequired,
  buildActionPayload,
  buildRowCommand,
} from './area-workspace-model';

export interface PendingRowAction {
  row: AreaWorkRow;
  action: AreaRowAction;
}

export interface AreaActionDialogProps {
  pending: PendingRowAction;
  now: Date;
  online: boolean;
  onClose: () => void;
  /** Sends the command (or queues it offline); true when it was accepted or queued. */
  onSubmit: (
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
}

const MAX_BY_FORM: Record<AreaRowAction['form'], number> = {
  none: 0,
  note: NOTE_MAX,
  reason: REASON_MAX,
  answer: ANSWER_MAX,
  wait: 500,
};

function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One row action that needs something more than a click: a note, a reason, an
 * answer or a waiting period. Mounted per action, so its state starts clean.
 * The engine validates the same rules again.
 */
export function AreaActionDialog({
  pending,
  now,
  online,
  onClose,
  onSubmit,
}: AreaActionDialogProps) {
  const { row, action } = pending;
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldId = `area-action-${action.id}-${row.id}`;
  const required = actionFieldRequired(action.form);
  const label = actionFieldLabel(action.form);

  async function submit() {
    if (busy) return;
    setError(null);
    const payload = buildActionPayload(action, { text, until }, now);
    if (!payload.ok) {
      setError(payload.error);
      return;
    }
    setBusy(true);
    try {
      const done = await onSubmit(
        buildRowCommand(action, row, payload.payload),
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
              {action.hint ?? 'Se registrará en el expediente con tu nombre y la hora.'}
            </p>
          ) : (
            <FormField
              label={`${label}${required ? '' : ' (opcional)'}`}
              htmlFor={fieldId}
              help={action.hint ?? undefined}
            >
              <Textarea
                id={fieldId}
                value={text}
                onChange={(event) => setText(event.target.value)}
                rows={4}
                maxLength={MAX_BY_FORM[action.form]}
                required={required}
                autoFocus
              />
            </FormField>
          )}

          {action.form === 'wait' ? (
            <FormField
              label="Hasta (opcional)"
              htmlFor={`${fieldId}-until`}
              help="Si lo dejas vacío, la espera no tiene fecha de fin."
            >
              <Input
                id={`${fieldId}-until`}
                type="datetime-local"
                value={until}
                min={toLocalInputValue(now)}
                onChange={(event) => setUntil(event.target.value)}
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
