'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/dialog';
import { Alert, Badge, Button, FormField, Input, Select, Textarea } from '@/components/ui/primitives';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import { uploadFile } from '@/lib/upload-client';
import {
  COMPLETE_NOTE_MAX,
  ESCALATE_NOTE_MAX,
  EVIDENCE_UPLOAD_TARGET,
  FILE_EVIDENCE_KINDS,
  WAIT_REASON_MAX,
  WORK_ITEM_ACTION_LABELS,
  WORK_ITEM_ACTION_SUCCESS,
  acceptForEvidenceKind,
  buildCompletePayload,
  buildEscalatePayload,
  buildWaitPayload,
  buildWorkItemCommand,
  completionFormError,
  completionRequirements,
  defaultUploadKind,
  evidenceLabel,
  evidenceUploadTargetId,
  isRequestWorkItem,
  validateEvidenceFiles,
  type FileEvidenceKind,
  type MyWorkItem,
  type WorkItemUiAction,
} from './mywork-model';

export type DialogWorkAction = Exclude<WorkItemUiAction, 'start'>;

export interface PendingWorkAction {
  action: DialogWorkAction;
  item: MyWorkItem;
}

interface Props {
  pending: PendingWorkAction;
  now: Date;
  online: boolean;
  onClose: () => void;
  /** Sends the command (or queues it offline); true when it was accepted or queued. */
  onSubmit: (input: OfflineCommandInput<Record<string, unknown>>, successMessage: string) => Promise<boolean>;
}

const TITLES: Record<DialogWorkAction, string> = {
  complete: 'Completar trabajo',
  wait: 'Poner en espera',
  escalate: 'Escalar trabajo',
};

/** Pads a date to the `YYYY-MM-DDTHH:MM` value of a datetime-local input (browser time). */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Complete (with evidence), wait or escalate one work item. Mounted per action, so its state starts clean. */
export function MyWorkActionDialog({ pending, now, online, onClose, onSubmit }: Props) {
  const { action, item } = pending;
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedKinds, setUploadedKinds] = useState<string[]>([]);
  const requirements = completionRequirements(item, uploadedKinds);
  const [kind, setKind] = useState<FileEvidenceKind>(() =>
    defaultUploadKind(requirements.files.length > 0 ? requirements.files : item.requiredEvidence)
  );
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRequest = isRequestWorkItem(item);
  const missingKeys = new Set(item.missingEvidence.filter((key) => !uploadedKinds.includes(key)));
  const fieldId = (name: string) => `mywork-${action}-${item.id}-${name}`;

  function close() {
    if (!busy) onClose();
  }

  /** Uploads the chosen files as evidence of the selected kind without completing (several kinds may be required). */
  async function uploadOnly() {
    if (busy) return;
    setError(null);
    const fileError = validateEvidenceFiles(files);
    if (fileError) return setError(fileError);
    if (files.length === 0) return setError('Adjunta al menos un archivo');
    if (!online) return setError('Sin conexión: la evidencia sólo se puede subir en línea.');
    setBusy(true);
    try {
      if (await uploadEvidence()) {
        setUploadedKinds((current) => [...new Set([...current, kind])]);
        setFiles([]);
        const next = requirements.files.find((k) => k !== kind);
        if (next) setKind(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir la evidencia');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function uploadEvidence(): Promise<boolean> {
    for (const [index, file] of files.entries()) {
      setProgress(`Subiendo evidencia ${index + 1} de ${files.length}…`);
      const result = await uploadFile(file, {
        target: { type: EVIDENCE_UPLOAD_TARGET, id: evidenceUploadTargetId(item.id, kind) },
        onProgress: (p) =>
          setProgress(`Subiendo evidencia ${index + 1} de ${files.length} · ${p.percent}%`),
      });
      if (result.status === 'rejected') {
        setError(result.rejectionReason ?? `No se aceptó "${file.name}" como evidencia`);
        return false;
      }
    }
    return true;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);

    let input: OfflineCommandInput<Record<string, unknown>>;
    if (action === 'complete') {
      const check = buildCompletePayload(item, note);
      if (!check.ok) return setError(check.error);
      const evidenceError = completionFormError(requirements, { note, filesSelected: files.length, selectedKind: kind });
      if (evidenceError) return setError(evidenceError);
      const fileError = validateEvidenceFiles(files);
      if (fileError) return setError(fileError);
      if (files.length > 0 && !online) {
        return setError('Sin conexión: la evidencia sólo se puede subir en línea. Quita los archivos o espera a reconectar.');
      }
      input = buildWorkItemCommand('complete', item, check.payload);
      // Evidence rows are written by the upload; never fail the completion on a stale version because of them.
      if (files.length > 0) delete input.expectedVersion;
    } else if (action === 'wait') {
      const check = buildWaitPayload(reason, until, new Date());
      if (!check.ok) return setError(check.error);
      input = buildWorkItemCommand('wait', item, check.payload);
    } else {
      const check = buildEscalatePayload(note);
      if (!check.ok) return setError(check.error);
      input = buildWorkItemCommand('escalate', item, check.payload);
    }

    setBusy(true);
    try {
      if (action === 'complete' && files.length > 0 && !(await uploadEvidence())) return;
      setProgress(null);
      if (await onSubmit(input, WORK_ITEM_ACTION_SUCCESS[action])) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo completar la acción');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? close() : undefined)}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{TITLES[action]}</DialogTitle>
          <DialogDescription>
            {item.title}
            {item.caseNumber ? ` · ${item.caseNumber}` : ''}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-3" onSubmit={(e) => void handleSubmit(e)} noValidate>
          {action === 'complete' ? (
            <>
              {item.requiredEvidence.length > 0 ? (
                <div className="grid gap-1">
                  <span className="text-sm font-medium">Evidencia requerida</span>
                  <ul className="flex flex-wrap gap-1" aria-label="Evidencia requerida">
                    {item.requiredEvidence.map((key) => (
                      <li key={key}>
                        <Badge variant={missingKeys.has(key) ? 'warning' : 'success'}>
                          {evidenceLabel(key)} · {missingKeys.has(key) ? 'falta' : 'lista'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {requirements.blockedReason ? (
                <Alert variant="warning">{requirements.blockedReason}</Alert>
              ) : null}
              <FormField
                label={
                  isRequest
                    ? 'Respuesta para el área que la pidió'
                    : requirements.noteRequired
                      ? 'Nota (obligatoria)'
                      : 'Nota (opcional)'
                }
                htmlFor={fieldId('note')}
                help={isRequest ? 'Se envía como respuesta de la solicitud.' : undefined}
              >
                <Textarea
                  id={fieldId('note')}
                  rows={3}
                  maxLength={COMPLETE_NOTE_MAX}
                  value={note}
                  required={requirements.noteRequired}
                  onChange={(e) => setNote(e.target.value)}
                />
              </FormField>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)]">
                <FormField label="Tipo de evidencia" htmlFor={fieldId('kind')}>
                  <Select
                    id={fieldId('kind')}
                    value={kind}
                    disabled={busy}
                    onChange={(e) => setKind(e.target.value as FileEvidenceKind)}
                  >
                    {FILE_EVIDENCE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {evidenceLabel(k)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  label={
                    requirements.files.length > 0
                      ? `Archivos (obligatorio: ${requirements.files.map(evidenceLabel).join(', ')})`
                      : 'Archivos (opcional)'
                  }
                  htmlFor={fieldId('files')}
                  help={online ? 'Hasta 5 archivos de 15 MB.' : 'Sin conexión: no se pueden subir archivos.'}
                >
                  <Input
                    id={fieldId('files')}
                    type="file"
                    multiple
                    accept={acceptForEvidenceKind(kind)}
                    disabled={busy || !online}
                    required={requirements.files.length > 0}
                    onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                  />
                </FormField>
              </div>
              {requirements.files.length > 1 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="secondary" disabled={busy || files.length === 0 || !online} onClick={() => void uploadOnly()}>
                    Subir evidencia
                  </Button>
                  <span className="text-muted text-xs">Sube cada tipo de evidencia y después completa el trabajo.</span>
                </div>
              ) : null}
            </>
          ) : null}

          {action === 'wait' ? (
            <>
              <FormField label="¿Qué estás esperando?" htmlFor={fieldId('reason')}>
                <Textarea
                  id={fieldId('reason')}
                  rows={3}
                  maxLength={WAIT_REASON_MAX}
                  value={reason}
                  required
                  onChange={(e) => setReason(e.target.value)}
                />
              </FormField>
              <FormField
                label="Retomar el (opcional)"
                htmlFor={fieldId('until')}
                help="Cuando llegue la fecha el trabajo vuelve a tu lista como siguiente acción."
              >
                <Input
                  id={fieldId('until')}
                  type="datetime-local"
                  min={toLocalInputValue(now)}
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </FormField>
            </>
          ) : null}

          {action === 'escalate' ? (
            <>
              <p className="text-muted text-sm">
                Avisaremos al siguiente nivel: primero al suplente, luego al líder del área y al final a
                Administración.
              </p>
              <FormField label="Nota para quien lo recibe (opcional)" htmlFor={fieldId('note')}>
                <Textarea
                  id={fieldId('note')}
                  rows={3}
                  maxLength={ESCALATE_NOTE_MAX}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </FormField>
            </>
          ) : null}

          {progress ? (
            <p className="text-muted text-sm" role="status">
              {progress}
            </p>
          ) : null}
          {error ? <Alert variant="error">{error}</Alert> : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={close} disabled={busy}>
              Cancelar
            </Button>
            <Button
              type="submit"
              isLoading={busy}
              disabled={action === 'complete' && Boolean(requirements.blockedReason)}
              variant={action === 'escalate' ? 'danger' : 'primary'}
            >
              {WORK_ITEM_ACTION_LABELS[action]}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
