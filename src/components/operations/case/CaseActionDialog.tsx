'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Button, FormField, Input, Select, Textarea } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { PayloadCheck } from './case-model';

export type CaseActionForm = 'none' | 'note' | 'reason' | 'wait' | 'reassign';

export interface CaseActionCandidate {
  id: string;
  name: string;
}

export interface CasePendingAction {
  /** Stable id of the action, so the dialog remounts with clean state. */
  key: string;
  title: string;
  /** What it acts on: the case number or the title of the work item. */
  subject: string;
  form: CaseActionForm;
  tone: 'primary' | 'danger';
  confirm?: string | null;
  hint?: string | null;
  /** The text cannot be left empty. */
  required?: boolean;
  maxLength: number;
  successMessage: string;
  /** Turns what the person typed into the command payload (pure, from the model). */
  build: (input: {
    text: string;
    until: string;
    ownerUserId: string;
  }) => PayloadCheck<Record<string, unknown>>;
  /** Builds the command sent to `POST /app/operations/api/commands`. */
  command: (payload: Record<string, unknown>) => OfflineCommandInput<Record<string, unknown>>;
  /** Only for `reassign`: where to look for the people who can take the work. */
  assigneesUrl?: string;
  /** Person who has it now, excluded from the list. */
  currentOwnerUserId?: string | null;
}

export interface CaseActionDialogProps {
  pending: CasePendingAction;
  now: Date;
  online: boolean;
  onClose: () => void;
  /** Sends the command (or queues it offline); true when it was accepted or queued. */
  onSubmit: (
    input: OfflineCommandInput<Record<string, unknown>>,
    successMessage: string
  ) => Promise<boolean>;
}

const FIELD_LABELS: Record<CaseActionForm, string> = {
  none: '',
  note: 'Nota',
  reason: 'Motivo',
  wait: 'Motivo de la espera',
  reassign: 'Motivo del cambio',
};

/** Pads a date to the `YYYY-MM-DDTHH:MM` value of a datetime-local input (browser time). */
function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One action of the Expediente 360 that needs something more than a click: a
 * note, a reason, a waiting period or the person who takes the work. Mounted
 * per action (keyed), so its state always starts clean. The engine validates
 * the same rules again.
 */
export function CaseActionDialog({
  pending,
  now,
  online,
  onClose,
  onSubmit,
}: CaseActionDialogProps) {
  const [text, setText] = useState('');
  const [until, setUntil] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [candidates, setCandidates] = useState<CaseActionCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldId = `case-action-${pending.key}`;
  const needsAssignee = pending.form === 'reassign';

  useEffect(() => {
    if (!needsAssignee || !pending.assigneesUrl) return;
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        const response = await fetch(pending.assigneesUrl as string);
        const json = (await response.json().catch(() => ({}))) as {
          users?: CaseActionCandidate[];
          error?: string;
        };
        if (!response.ok || !json.users)
          throw new Error(json.error ?? 'No pudimos cargar a las personas');
        if (!cancelled) {
          setCandidates(json.users.filter((user) => user.id !== pending.currentOwnerUserId));
        }
      } catch (err) {
        if (!cancelled) {
          setCandidates([]);
          setLoadError(err instanceof Error ? err.message : 'No pudimos cargar a las personas');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsAssignee, pending.assigneesUrl, pending.currentOwnerUserId]);

  async function submit() {
    if (busy) return;
    setError(null);
    const payload = pending.build({ text, until, ownerUserId });
    if (!payload.ok) {
      setError(payload.error);
      return;
    }
    setBusy(true);
    try {
      const done = await onSubmit(pending.command(payload.payload), pending.successMessage);
      if (done) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar la acción');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(value) => (!value && !busy ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{pending.title}</DialogTitle>
          <DialogDescription>{pending.subject}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {pending.confirm ? <Alert variant="warning">{pending.confirm}</Alert> : null}
          {!online ? (
            <Alert variant="info">
              Sin conexión: la acción se guarda en este dispositivo y se envía sola al volver.
            </Alert>
          ) : null}
          {loadError ? <Alert variant="error">{loadError}</Alert> : null}

          {needsAssignee ? (
            <FormField label="Nuevo responsable" htmlFor={`${fieldId}-owner`}>
              <Select
                id={`${fieldId}-owner`}
                value={ownerUserId}
                disabled={candidates === null}
                onChange={(event) => setOwnerUserId(event.target.value)}
              >
                <option value="">
                  {candidates === null ? 'Cargando personas…' : 'Elige a quién le toca'}
                </option>
                {(candidates ?? []).map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {pending.form === 'wait' ? (
            <FormField
              label="Hasta cuándo (opcional)"
              htmlFor={`${fieldId}-until`}
              help="Si lo dejas vacío, el trabajo queda en espera sin fecha."
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

          {pending.form === 'none' ? (
            <p className="text-muted text-sm">
              {pending.hint ?? 'Se registrará en el expediente con tu nombre y la hora.'}
            </p>
          ) : (
            <FormField
              label={FIELD_LABELS[pending.form]}
              htmlFor={`${fieldId}-text`}
              help={pending.hint ?? undefined}
            >
              <Textarea
                id={`${fieldId}-text`}
                rows={3}
                maxLength={pending.maxLength}
                value={text}
                required={pending.required}
                onChange={(event) => setText(event.target.value)}
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
            variant={pending.tone === 'danger' ? 'danger' : 'primary'}
            size="sm"
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Enviando…' : pending.title}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
