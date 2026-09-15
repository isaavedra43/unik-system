import type { CopilotProposal } from '@/components/copilot/copilot-types';
import type { OfflineCommandInput, QueueReason, SubmitOutcome } from '@/lib/offline-commands';
import { STRUCTURED_EVIDENCE_LABELS, WORK_ITEM_OPEN_STATUSES, type EvidenceKind } from '@/modules/operations/types';
import type { WorkItemDTO, WorkItemPermissionsDTO } from '@/modules/operations/work-items-service';

/**
 * Pure view model of "Mi trabajo" (plan 5.7 / 7.10): which work comes next,
 * counters, due labels, command payloads and the table context sent to the
 * copilot. No React, no I/O: shared by the server page, the client board and
 * the unit tests.
 */

export const MYWORK_PATH = '/app/mywork';
export const MYWORK_TIMEZONE = 'America/Mexico_City';

// ---------------------------------------------------------------------------
// View and rows
// ---------------------------------------------------------------------------

export type MyWorkView = 'open' | 'closed';

/** `?vista=cerrados` shows the recently closed work; anything else the open work. */
export function parseMyWorkView(value: unknown): MyWorkView {
  return value === 'cerrados' || value === 'closed' ? 'closed' : 'open';
}

export function myWorkViewHref(view: MyWorkView): string {
  return view === 'closed' ? `${MYWORK_PATH}?vista=cerrados` : MYWORK_PATH;
}

export type MyWorkRole = 'owner' | 'backup';

export interface MyWorkItem extends WorkItemDTO {
  role: MyWorkRole;
  permissions: WorkItemPermissionsDTO;
  /** Required evidence still missing (same rule the core applies when completing; empty when none). */
  missingEvidence: string[];
}

export function myWorkRole(item: Pick<WorkItemDTO, 'ownerUserId'>, userId: string): MyWorkRole {
  return item.ownerUserId === userId ? 'owner' : 'backup';
}

const OPEN = new Set<string>(WORK_ITEM_OPEN_STATUSES);

export function isOpenWorkStatus(status: string): boolean {
  return OPEN.has(status);
}

export const WORK_ITEM_STATUS_BADGE: Readonly<
  Record<string, 'default' | 'success' | 'danger' | 'warning' | 'info' | 'weak'>
> = {
  open: 'default',
  in_progress: 'info',
  waiting: 'warning',
  escalated: 'danger',
  done: 'success',
  cancelled: 'weak',
};

export function isApprovalWorkItem(item: Pick<WorkItemDTO, 'objectType'>): boolean {
  return item.objectType === 'approval_request';
}

/** Work items that answer an area request: completing them needs the answer in the note. */
export function isRequestWorkItem(item: Pick<WorkItemDTO, 'objectType'>): boolean {
  return item.objectType === 'area_request';
}

// ---------------------------------------------------------------------------
// Next action
// ---------------------------------------------------------------------------

type NextActionFields = Pick<
  WorkItemDTO,
  'id' | 'status' | 'dueAt' | 'ownerUserId' | 'backupUserId' | 'waitUntil'
>;

export type NextActionReason = 'in_progress' | 'overdue' | 'next_due' | 'wait_over' | 'backup_overdue';

export const NEXT_ACTION_REASON_LABELS: Readonly<Record<NextActionReason, string>> = {
  in_progress: 'Ya lo empezaste: termínalo primero',
  overdue: 'Está vencido',
  next_due: 'Es lo siguiente que vence',
  wait_over: 'Ya terminó el tiempo de espera',
  backup_overdue: 'Lo cubres como suplente y está vencido',
};

export interface NextAction<T> {
  item: T;
  reason: NextActionReason;
}

const byDue = (a: NextActionFields, b: NextActionFields) =>
  Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id);

/**
 * "Mi siguiente acción": own work in progress → own open/escalated work (or a
 * wait that is over) by due date → work covered as backup that is overdue.
 */
export function pickNextAction<T extends NextActionFields>(
  items: readonly T[],
  userId: string,
  now: Date
): NextAction<T> | null {
  const t = now.getTime();
  const own = items.filter((i) => i.ownerUserId === userId && OPEN.has(i.status)).sort(byDue);
  const inProgress = own.find((i) => i.status === 'in_progress');
  if (inProgress) return { item: inProgress, reason: 'in_progress' };

  const candidates = own
    .filter(
      (i) =>
        i.status === 'open' ||
        i.status === 'escalated' ||
        (i.status === 'waiting' && i.waitUntil !== null && Date.parse(i.waitUntil) <= t)
    )
    .sort(byDue);
  const first = candidates[0];
  if (first) {
    const reason: NextActionReason =
      first.status === 'waiting' ? 'wait_over' : Date.parse(first.dueAt) < t ? 'overdue' : 'next_due';
    return { item: first, reason };
  }

  const backup = items
    .filter(
      (i) =>
        i.ownerUserId !== userId &&
        i.backupUserId === userId &&
        OPEN.has(i.status) &&
        Date.parse(i.dueAt) < t
    )
    .sort(byDue)[0];
  return backup ? { item: backup, reason: 'backup_overdue' } : null;
}

// ---------------------------------------------------------------------------
// Counters and activity
// ---------------------------------------------------------------------------

/** YYYY-MM-DD of `date` in `tz` (UTC when the zone is invalid). */
export function localDay(date: Date, tz: string = MYWORK_TIMEZONE): string {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  try {
    return format(tz);
  } catch {
    return format('UTC');
  }
}

export interface MyWorkSummary {
  total: number;
  overdue: number;
  inProgress: number;
  waiting: number;
  dueToday: number;
  asBackup: number;
}

/** Counters over the OPEN work of the user. */
export function summarizeMyWork(
  items: readonly Pick<WorkItemDTO, 'status' | 'dueAt' | 'ownerUserId'>[],
  userId: string,
  now: Date,
  tz: string = MYWORK_TIMEZONE
): MyWorkSummary {
  const today = localDay(now, tz);
  const summary: MyWorkSummary = { total: 0, overdue: 0, inProgress: 0, waiting: 0, dueToday: 0, asBackup: 0 };
  for (const item of items) {
    if (!OPEN.has(item.status)) continue;
    summary.total++;
    const due = new Date(item.dueAt);
    if (due.getTime() < now.getTime()) summary.overdue++;
    else if (localDay(due, tz) === today) summary.dueToday++;
    if (item.status === 'in_progress') summary.inProgress++;
    if (item.status === 'waiting') summary.waiting++;
    if (item.ownerUserId !== userId) summary.asBackup++;
  }
  return summary;
}

/** Latest `updatedAt` of the list (drives the copilot "inbound" re-analysis). */
export function myWorkActivityAt(items: readonly Pick<WorkItemDTO, 'updatedAt'>[]): string | null {
  let latest: string | null = null;
  for (const item of items) {
    if (!latest || Date.parse(item.updatedAt) > Date.parse(latest)) latest = item.updatedAt;
  }
  return latest;
}

export const MYWORK_CONTEXT_ROWS = 25;

const clip = (value: string | null, max: number) =>
  value === null ? null : value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Visible list sent to the copilot on each turn (the server bounds and wraps it as data). */
export function buildMyWorkCopilotContext(
  items: readonly MyWorkItem[],
  view: MyWorkView,
  now: Date
): Record<string, unknown> {
  return {
    surface: 'mywork',
    view,
    total: items.length,
    overdue: items.filter((i) => OPEN.has(i.status) && Date.parse(i.dueAt) < now.getTime()).length,
    rows: items.slice(0, MYWORK_CONTEXT_ROWS).map((i) => ({
      id: i.id,
      title: clip(i.title, 120),
      kind: i.kind,
      status: i.status,
      role: i.role,
      areaKey: i.areaKey,
      caseNumber: i.caseNumber,
      dueAt: i.dueAt,
      overdue: OPEN.has(i.status) && Date.parse(i.dueAt) < now.getTime(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function safeFormat(date: Date, options: Intl.DateTimeFormatOptions, tz: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { ...options, timeZone: tz }).format(date);
  } catch {
    return new Intl.DateTimeFormat('es-MX', { ...options, timeZone: 'UTC' }).format(date);
  }
}

export function formatClock(date: Date, tz: string = MYWORK_TIMEZONE): string {
  return safeFormat(date, { hour: '2-digit', minute: '2-digit', hour12: false }, tz);
}

export function formatShortDate(date: Date, tz: string = MYWORK_TIMEZONE): string {
  return safeFormat(date, { day: 'numeric', month: 'short' }, tz).replace('.', '');
}

export function formatDateTime(iso: string | null, tz: string = MYWORK_TIMEZONE): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${formatShortDate(date, tz)} ${formatClock(date, tz)}`;
}

/** "12 min", "5 h", "3 d". */
export function formatElapsed(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export type DueTone = 'danger' | 'warning' | 'default';

export interface DueLabel {
  label: string;
  tone: DueTone;
  /** Full date and time for tooltips / screen readers. */
  title: string;
}

export function formatDueLabel(
  dueAtIso: string,
  now: Date,
  options: { closed?: boolean; tz?: string } = {}
): DueLabel {
  const tz = options.tz ?? MYWORK_TIMEZONE;
  const due = new Date(dueAtIso);
  if (Number.isNaN(due.getTime())) return { label: 'Sin fecha', tone: 'default', title: '' };
  const title = formatDateTime(dueAtIso, tz);
  if (options.closed) return { label: title, tone: 'default', title };
  const diff = due.getTime() - now.getTime();
  if (diff < 0) return { label: `Vencido hace ${formatElapsed(diff)}`, tone: 'danger', title };
  if (diff < 60 * 60_000) return { label: `Vence en ${formatElapsed(diff)}`, tone: 'warning', title };
  const dueDay = localDay(due, tz);
  if (dueDay === localDay(now, tz)) return { label: `Hoy ${formatClock(due, tz)}`, tone: 'warning', title };
  if (dueDay === localDay(new Date(now.getTime() + 24 * 60 * 60_000), tz)) {
    return { label: `Mañana ${formatClock(due, tz)}`, tone: 'default', title };
  }
  return { label: title, tone: 'default', title };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const WORK_ITEM_UI_ACTIONS = ['start', 'complete', 'wait', 'escalate'] as const;
export type WorkItemUiAction = (typeof WORK_ITEM_UI_ACTIONS)[number];

export const WORK_ITEM_ACTION_COMMANDS: Readonly<Record<WorkItemUiAction, string>> = {
  start: 'workitem.start',
  complete: 'workitem.complete',
  wait: 'workitem.wait',
  escalate: 'workitem.escalate',
};

export const WORK_ITEM_ACTION_LABELS: Readonly<Record<WorkItemUiAction, string>> = {
  start: 'Iniciar',
  complete: 'Completar',
  wait: 'Esperar',
  escalate: 'Escalar',
};

export const WORK_ITEM_ACTION_SUCCESS: Readonly<Record<WorkItemUiAction, string>> = {
  start: 'Trabajo iniciado',
  complete: 'Trabajo completado',
  wait: 'Trabajo en espera',
  escalate: 'Trabajo escalado',
};

/** Actions offered for a row (the server checks them again). Approvals are decided elsewhere. */
export function availableActions(
  item: Pick<MyWorkItem, 'status' | 'permissions' | 'objectType'>
): WorkItemUiAction[] {
  if (isApprovalWorkItem(item) || !OPEN.has(item.status)) return [];
  const actions: WorkItemUiAction[] = [];
  if (item.permissions.canStart && item.status !== 'in_progress') actions.push('start');
  if (item.permissions.canComplete) actions.push('complete');
  if (item.permissions.canWait && item.status !== 'waiting') actions.push('wait');
  if (item.permissions.canEscalate) actions.push('escalate');
  return actions;
}

export function buildWorkItemCommand(
  action: WorkItemUiAction,
  item: Pick<WorkItemDTO, 'id' | 'version'>,
  payload: Record<string, unknown> = {}
): OfflineCommandInput<Record<string, unknown>> {
  return {
    type: WORK_ITEM_ACTION_COMMANDS[action],
    aggregate: { type: 'work_item', id: item.id },
    payload,
    expectedVersion: item.version,
  };
}

export type PayloadCheck<P> = { ok: true; payload: P } | { ok: false; error: string };

export const WAIT_REASON_MIN = 3;
export const WAIT_REASON_MAX = 500;
export const COMPLETE_NOTE_MAX = 2000;
export const ESCALATE_NOTE_MAX = 500;

/** `untilLocal` is the value of a datetime-local input (browser time zone). */
export function buildWaitPayload(
  reason: string,
  untilLocal: string,
  now: Date
): PayloadCheck<{ reason: string; until?: string }> {
  const trimmed = reason.trim();
  if (trimmed.length < WAIT_REASON_MIN) return { ok: false, error: 'Indica el motivo de la espera (mínimo 3 caracteres)' };
  if (trimmed.length > WAIT_REASON_MAX) return { ok: false, error: 'El motivo admite hasta 500 caracteres' };
  if (!untilLocal.trim()) return { ok: true, payload: { reason: trimmed } };
  const until = new Date(untilLocal);
  if (Number.isNaN(until.getTime())) return { ok: false, error: 'La fecha de fin de la espera no es válida' };
  if (until.getTime() <= now.getTime()) return { ok: false, error: 'La espera debe terminar en el futuro' };
  return { ok: true, payload: { reason: trimmed, until: until.toISOString() } };
}

export function buildCompletePayload(
  item: Pick<WorkItemDTO, 'objectType'>,
  note: string
): PayloadCheck<{ note?: string }> {
  const trimmed = note.trim();
  if (isRequestWorkItem(item) && !trimmed) {
    return { ok: false, error: 'Escribe la respuesta para el área que hizo la solicitud' };
  }
  if (trimmed.length > COMPLETE_NOTE_MAX) return { ok: false, error: 'La nota admite hasta 2000 caracteres' };
  return { ok: true, payload: trimmed ? { note: trimmed } : {} };
}

export function buildEscalatePayload(note: string): PayloadCheck<{ note?: string }> {
  const trimmed = note.trim();
  if (trimmed.length > ESCALATE_NOTE_MAX) return { ok: false, error: 'La nota admite hasta 500 caracteres' };
  return { ok: true, payload: trimmed ? { note: trimmed } : {} };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** Upload target of operations evidence (`operations-storage.ts`). */
export const EVIDENCE_UPLOAD_TARGET = 'operations_evidence';

export const FILE_EVIDENCE_KINDS = ['photo', 'signature', 'document'] as const;
export type FileEvidenceKind = (typeof FILE_EVIDENCE_KINDS)[number];

/** Same labels as `EVIDENCE_KIND_LABELS` in evidence-service (server module); a test keeps them equal. */
export const EVIDENCE_LABELS: Readonly<Record<EvidenceKind, string>> = {
  photo: 'Foto',
  signature: 'Firma',
  document: 'Documento',
  note: 'Nota',
  count: 'Conteo',
  zoho_readback: 'Confirmación de Zoho',
};

export function evidenceLabel(key: string): string {
  return (EVIDENCE_LABELS as Record<string, string>)[key] ?? STRUCTURED_EVIDENCE_LABELS[key] ?? key.replace(/_/g, ' ');
}

/** Where each structured evidence key comes from (it is produced by a flow, never uploaded here). */
export const STRUCTURED_EVIDENCE_FLOWS: Readonly<Record<string, string>> = {
  availability_result: 'Se registra al verificar la existencia (conteo de Inventario o "Registra un conteo" en la IA).',
  allocation_plan: 'Lo genera el plan de abastecimiento del expediente (reservar, comprar o producir).',
  stock_reservation: 'Se registra al apartar el material del expediente.',
  purchase_request_ref: 'Se registra al crear la solicitud de compra.',
  receipt_movement: 'Se registra cuando Inventario recibe el material.',
  production_order_ref: 'Se registra al crear la orden de producción.',
  produce_movement: 'Se registra cuando Manufactura termina la producción.',
  supplier_confirmation: 'Se registra cuando el proveedor confirma la entrega directa.',
  delivery_evidence: 'Se registra al confirmar la entrega con su evidencia.',
  issue_movements: 'Se registra al surtir el material del pedido.',
  count: 'Se registra al capturar el conteo ("Registra un conteo" en la IA o el conteo de Inventario).',
  zoho_readback: 'Se registra cuando Zoho confirma el cambio.',
};

export interface CompletionRequirements {
  /** Results a flow must produce first: "Completar" stays disabled while any is missing. */
  blockedBy: string[];
  /** Spanish explanation of what is missing and which flow produces it (null when not blocked). */
  blockedReason: string | null;
  /** Files still required (photo, signature, document). */
  files: FileEvidenceKind[];
  /** A note is required: evidence `note` or the answer of an area request. */
  noteRequired: boolean;
}

/** What completing a work item still needs, from the evidence the server says is missing. Pure. */
export function completionRequirements(
  item: Pick<MyWorkItem, 'missingEvidence' | 'objectType'>,
  alreadyUploaded: readonly string[] = []
): CompletionRequirements {
  const uploaded = new Set(alreadyUploaded);
  const missing = [...new Set(item.missingEvidence ?? [])].filter((key) => !uploaded.has(key));
  const files = missing.filter(isFileEvidenceKind);
  const blockedBy = missing.filter((key) => !isFileEvidenceKind(key) && key !== 'note');
  const blockedReason =
    blockedBy.length === 0
      ? null
      : `Falta ${blockedBy.map(evidenceLabel).join(', ')}. ${[
          ...new Set(blockedBy.map((key) => STRUCTURED_EVIDENCE_FLOWS[key] ?? 'Lo registra el flujo de ese paso.')),
        ].join(' ')}`;
  return { blockedBy, blockedReason, files, noteRequired: missing.includes('note') || isRequestWorkItem(item) };
}

/** Why the completion form cannot be sent yet (null when it can). Pure. */
export function completionFormError(
  requirements: CompletionRequirements,
  form: { note: string; filesSelected: number; selectedKind: FileEvidenceKind }
): string | null {
  if (requirements.blockedReason) return requirements.blockedReason;
  if (requirements.noteRequired && !form.note.trim()) return 'Escribe la nota: es evidencia obligatoria de este trabajo';
  const covered = form.filesSelected > 0 ? form.selectedKind : null;
  const pending = requirements.files.filter((kind) => kind !== covered);
  if (pending.length > 0) {
    return `Falta adjuntar: ${pending.map(evidenceLabel).join(', ')}. Elige el tipo, adjunta el archivo y súbelo con "Subir evidencia" antes de completar.`;
  }
  return null;
}

export function isFileEvidenceKind(value: string): value is FileEvidenceKind {
  return (FILE_EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** `work_item:<id>#<kind>`: the upload creates the evidence link of the work item once validated. */
export function evidenceUploadTargetId(workItemId: string, kind: FileEvidenceKind): string {
  return `work_item:${workItemId}#${kind}`;
}

/** Same limit as `EVIDENCE_MAX_BYTES` of the evidence storage. */
export const EVIDENCE_MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_EVIDENCE_FILES = 5;

/** Checks the files picked for a completion before uploading them. */
export function validateEvidenceFiles(files: readonly { name: string; size: number }[]): string | null {
  if (files.length > MAX_EVIDENCE_FILES) return `Adjunta hasta ${MAX_EVIDENCE_FILES} archivos por vez`;
  const tooBig = files.find((f) => f.size > EVIDENCE_MAX_FILE_BYTES);
  if (tooBig) return `"${tooBig.name}" pesa más de 15 MB`;
  const empty = files.find((f) => f.size === 0);
  if (empty) return `"${empty.name}" está vacío`;
  return null;
}

/** Realtime message the core publishes on `user:{id}` when the user's work items change. */
export const MYWORK_REALTIME_TYPES = ['ops.workitems'] as const;

export function defaultUploadKind(requiredEvidence: readonly string[]): FileEvidenceKind {
  return requiredEvidence.find(isFileEvidenceKind) ?? 'photo';
}

/** `accept` attribute of the file input (the server validates the MIME type again). */
export function acceptForEvidenceKind(kind: FileEvidenceKind): string {
  return kind === 'document' ? 'application/pdf,image/*' : 'image/*';
}

// ---------------------------------------------------------------------------
// Submit feedback
// ---------------------------------------------------------------------------

export const QUEUE_REASON_MESSAGES: Readonly<Record<QueueReason, string>> = {
  offline: 'Sin conexión: la acción se enviará en cuanto vuelvas a estar en línea',
  network: 'No pudimos contactar al servidor: reintentaremos automáticamente',
  server: 'El servidor no respondió: reintentaremos automáticamente',
  unauthenticated: 'Tu sesión expiró: inicia sesión de nuevo para enviar la acción',
  in_flight: 'La acción se está procesando',
  actor_mismatch: 'Esta acción es de otro usuario de este dispositivo; se enviará cuando esa persona inicie sesión',
};

export interface SubmitFeedback {
  kind: 'success' | 'queued' | 'conflict' | 'error';
  message: string;
  /** Reload the list from the server. */
  refresh: boolean;
}

const REFRESH_ON_REJECTION = new Set(['not_found', 'invalid_state', 'approval_closed', 'approval_expired']);

export function describeSubmitOutcome(outcome: SubmitOutcome<unknown>, successMessage: string): SubmitFeedback {
  if (outcome.queued) {
    return { kind: 'queued', message: QUEUE_REASON_MESSAGES[outcome.reason], refresh: false };
  }
  const result = outcome.result;
  switch (result.status) {
    case 'completed':
    case 'accepted':
      return { kind: 'success', message: successMessage, refresh: true };
    case 'pending_external':
      return { kind: 'success', message: `${successMessage} · sincronizando`, refresh: true };
    case 'failed':
      return {
        kind: 'error',
        message: result.message ?? 'No se pudo procesar la acción; se reintentará automáticamente',
        refresh: false,
      };
    case 'rejected':
    default:
      if (result.errorCode === 'version_conflict' || result.errorCode === 'concurrency_conflict') {
        return { kind: 'conflict', message: 'Alguien actualizó este registro: recargamos la lista', refresh: true };
      }
      return {
        kind: 'error',
        message: result.message ?? 'No se pudo completar la acción',
        refresh: REFRESH_ON_REJECTION.has(result.errorCode ?? ''),
      };
  }
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface MyWorkApproval {
  id: string;
  scopeLabel: string;
  targetType: string;
  targetId: string;
  amount: string;
  currency: string;
  requiredApprovals: number;
  approvals: number;
  requestedByName: string | null;
  caseId: string | null;
  caseNumber: string | null;
  areaLabel: string | null;
  expiresAt: string | null;
  createdAt: string;
  version: number;
}

export interface MyWorkProposal extends CopilotProposal {
  conversationId: string | null;
  createdAt: string;
  awaitingSecondApproval: boolean;
  /** The user already gave the first signature: only another person can give the second one. */
  signedByMe: boolean;
}

export type ProposalFeedback =
  | { kind: 'success' | 'info'; message: string; closedNotice: null }
  | { kind: 'warning' | 'error'; message: string; closedNotice: string };

/** Toast and (for failures) the closed-row notice after deciding a proposal from Mi trabajo. Pure. */
export function describeProposalDecision(
  decision: 'approve' | 'reject',
  outcome: { awaitingSecondApproval: boolean; result: { success: boolean; error?: string; uncertain?: boolean } }
): ProposalFeedback {
  if (decision === 'reject') return { kind: 'success', message: 'Propuesta rechazada', closedNotice: null };
  if (outcome.awaitingSecondApproval) {
    return { kind: 'info', message: 'Primera firma registrada: falta la firma de otra persona con permiso', closedNotice: null };
  }
  if (!outcome.result.success) {
    const error = outcome.result.error?.trim() || 'error desconocido';
    return { kind: 'error', message: `La acción aprobada falló: ${error}`, closedNotice: `La acción aprobada falló: ${error}` };
  }
  if (outcome.result.uncertain) {
    const message = 'Aprobada; no se pudo confirmar el resultado, revisa el expediente';
    return { kind: 'warning', message, closedNotice: message };
  }
  return { kind: 'success', message: 'Propuesta aprobada y ejecutada', closedNotice: null };
}

export type MyWorkFocusNotice = { kind: 'closed' | 'missing'; title: string | null };

/** `?workItem=<id>` of the notifications: a plausible id or null. Pure. */
export function parseFocusWorkItem(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(raw) ? raw : null;
}

/** DOM id of the row/card of a work item (anchor of the notifications). */
export function myWorkItemAnchorId(workItemId: string): string {
  return `trabajo-${workItemId}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Reads the answer of `POST /app/operations/api/proposals/[id]`. A first
 * signature of a two-signature tool is not a failure: the card shows it as done
 * and the host tells the user that a second person must sign.
 */
export function interpretProposalDecisionResponse(data: unknown): {
  awaitingSecondApproval: boolean;
  result: { success: boolean; error?: string; uncertain?: boolean };
} {
  const record = isRecord(data) ? data : {};
  const proposal = isRecord(record.proposal) ? record.proposal : {};
  const execution = isRecord(record.execution) ? record.execution : null;
  if (
    proposal.status === 'awaiting_second_approval' ||
    execution?.errorCode === 'awaiting_second_approval'
  ) {
    return { awaitingSecondApproval: true, result: { success: true } };
  }
  if (!execution) return { awaitingSecondApproval: false, result: { success: true } };
  return {
    awaitingSecondApproval: false,
    result: {
      success: execution.success === true,
      ...(typeof execution.error === 'string' ? { error: execution.error } : {}),
      ...(execution.uncertain === true ? { uncertain: true } : {}),
    },
  };
}

export function formatMoney(amount: string, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${amount} ${currency}`.trim();
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toLocaleString('es-MX')} ${currency}`.trim();
  }
}

export const APPROVAL_DECIDE_COMMAND = 'approval.decide';

export function buildApprovalDecisionCommand(
  approval: Pick<MyWorkApproval, 'id' | 'version'>,
  decision: 'approve' | 'reject',
  note?: string
): OfflineCommandInput<Record<string, unknown>> {
  const trimmed = note?.trim();
  return {
    type: APPROVAL_DECIDE_COMMAND,
    aggregate: { type: 'approval_request', id: approval.id },
    payload: { approvalRequestId: approval.id, decision, ...(trimmed ? { note: trimmed.slice(0, 1000) } : {}) },
    expectedVersion: approval.version,
  };
}
