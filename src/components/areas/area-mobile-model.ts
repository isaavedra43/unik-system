import { formatDueLabel, type DueLabel } from '@/components/operations/mywork-model';
import type { OfflineCommandInput } from '@/lib/offline-commands';
import { rowKindLabel, type AreaRowTone, type AreaWorkRow } from '@/modules/areas/area-work-row';

/**
 * Pure view model of the mobile area surface (plan 7.10): which column is on
 * screen, what a work card says, and the payload of the evidence a person
 * captures from a phone. No React and no I/O, so the rules are unit tested.
 *
 * Nothing here decides business: an evidence note is sent as the SAME
 * `evidence.attach` command the desktop uses (through the offline queue), and
 * the engine validates it again.
 */

export const MOBILE_VIEWS = ['list', 'detail', 'ai'] as const;
export type MobileView = (typeof MOBILE_VIEWS)[number];

export const MOBILE_VIEW_LABELS: Readonly<Record<MobileView, string>> = {
  list: 'Trabajo',
  detail: 'Detalle',
  ai: 'IA del área',
};

/**
 * Command and aggregate of `evidence-service.ts` (a server module that cannot
 * be imported from the browser). The unit test compares both constants with
 * the server ones so they can never drift.
 */
export const EVIDENCE_ATTACH_COMMAND = 'evidence.attach';
export const EVIDENCE_AGGREGATE_TYPE = 'evidence_target';

/** Same limit as the `note` field of `attachEvidenceSchema`. */
export const CAPTURE_NOTE_MAX = 2000;

export const CAPTURE_KINDS = ['note', 'photo', 'document'] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const CAPTURE_KIND_LABELS: Readonly<Record<CaptureKind, string>> = {
  note: 'Nota',
  photo: 'Foto',
  document: 'Documento',
};

/** Where the evidence goes, as the row detail reports it (`work_item:<id>`, …). */
export type EvidenceTargetRef =
  { workItemId: string } | { stepId: string } | { objectType: string; objectId: string };

const OBJECT_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,59}$/;
const MAX_ID_LENGTH = 120;

/** Splits `<prefix>:<id>` into what the `evidence.attach` payload expects. */
export function parseEvidenceTarget(targetId: string | null | undefined): EvidenceTargetRef | null {
  const value = typeof targetId === 'string' ? targetId.trim() : '';
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  const prefix = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!id || id.length > MAX_ID_LENGTH) return null;
  if (prefix === 'work_item') return { workItemId: id };
  if (prefix === 'case_step') return { stepId: id };
  if (!OBJECT_TYPE_PATTERN.test(prefix)) return null;
  return { objectType: prefix, objectId: id };
}

/** Upload target of a file (`operations_evidence` reads the `#kind` suffix). */
export function evidenceUploadTargetId(
  targetId: string,
  kind: Exclude<CaptureKind, 'note'>
): string {
  return `${targetId}#${kind}`;
}

export type CaptureCheck =
  | { ok: true; command: OfflineCommandInput<Record<string, unknown>> }
  | { ok: false; error: string };

/**
 * `evidence.attach` with a note (no file), so it works offline: the queue
 * keeps it and sends it when the phone reconnects.
 */
export function buildEvidenceNoteCommand(
  targetId: string | null | undefined,
  note: string
): CaptureCheck {
  const target = typeof targetId === 'string' ? targetId.trim() : '';
  const reference = parseEvidenceTarget(target);
  if (!reference) {
    return { ok: false, error: 'Este trabajo todavía no admite evidencia.' };
  }
  const text = note.trim();
  if (!text) return { ok: false, error: 'Escribe la nota antes de guardarla.' };
  if (text.length > CAPTURE_NOTE_MAX) {
    return { ok: false, error: `La nota admite hasta ${CAPTURE_NOTE_MAX} caracteres.` };
  }
  return {
    ok: true,
    command: {
      type: EVIDENCE_ATTACH_COMMAND,
      aggregate: { type: EVIDENCE_AGGREGATE_TYPE, id: target },
      payload: { ...reference, kind: 'note', note: text },
    },
  };
}

export interface WorkCardSummary {
  kindLabel: string;
  statusLabel: string;
  tone: AreaRowTone;
  /** Null when the row has no due date. */
  due: DueLabel | null;
  ownerLabel: string;
  /** Case number and customer, when the row belongs to one. */
  context: string | null;
}

/** Everything a work card shows, already formatted (es-MX). */
export function workCardSummary(row: AreaWorkRow, now: Date): WorkCardSummary {
  return {
    kindLabel: rowKindLabel(row.rowKind),
    statusLabel: row.statusLabel,
    tone: row.statusTone,
    due: row.dueAt ? formatDueLabel(row.dueAt, now, { closed: !row.open }) : null,
    ownerLabel: row.ownerName ?? 'Sin asignar',
    context: [row.caseNumber, row.customerName].filter(Boolean).join(' · ') || null,
  };
}

/** "12 filas" / "20 de 143": what the phone is actually showing. */
export function mobileCountLabel(shown: number, total: number): string {
  const safeShown = Math.max(0, Math.trunc(shown));
  const safeTotal = Math.max(safeShown, Math.trunc(total));
  if (safeTotal === 0) return 'Sin filas';
  if (safeShown >= safeTotal) return safeTotal === 1 ? '1 fila' : `${safeTotal} filas`;
  return `${safeShown} de ${safeTotal}`;
}

/** The PWA shortcut ("Escanear") opens a surface with `?scan=1`. */
export function isScanRequested(params: Record<string, string | undefined> | null): boolean {
  return params?.scan === '1';
}
