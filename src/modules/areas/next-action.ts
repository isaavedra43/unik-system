import { extraString, isOpenRowStatus, type AreaWorkRow } from './area-work-row';

/**
 * "Mi siguiente acción" of an area work centre (plan 7.10). PURE: no Prisma,
 * no React, no I/O — the mobile surface renders whatever this decides and the
 * unit test walks every tier.
 *
 * Tiers, in order (the first non-empty one wins):
 *  1. Something the person already started (own row in progress): finishing
 *     beats starting anything else.
 *  2. Own open work, by due date (overdue first, rows without a date last).
 *  3. Work the person covers as backup that is already overdue.
 *  4. Work the area escalated and nobody has taken.
 *
 * Tiers 1–2 are the plan's "propio en curso → propio abierto por vencimiento";
 * tier 3 mirrors the rule "Mi trabajo" already applies to backups, and tier 4
 * is the plan's "escalado del área".
 *
 * It never decides whether the person may ACT on the row: that is
 * `getRowActions` (work-actions.ts), which the card asks separately.
 */

export type AreaNextActionReason =
  'in_progress' | 'overdue' | 'next_due' | 'no_due' | 'backup_overdue' | 'area_escalated';

export const AREA_NEXT_ACTION_REASON_LABELS: Readonly<Record<AreaNextActionReason, string>> = {
  in_progress: 'Ya lo empezaste: termínalo primero',
  overdue: 'Está vencido',
  next_due: 'Es lo siguiente que vence',
  no_due: 'Es tuyo y no tiene fecha de vencimiento',
  backup_overdue: 'Lo cubres como suplente y está vencido',
  area_escalated: 'El área lo escaló y sigue sin responsable',
};

export interface AreaNextAction {
  row: AreaWorkRow;
  reason: AreaNextActionReason;
}

/** Statuses that mean "somebody is already on it" across the row kinds. */
const IN_PROGRESS_STATUSES = new Set(['in_progress', 'active', 'started', 'picking', 'en_route']);

export function nextActionReasonLabel(reason: AreaNextActionReason): string {
  return AREA_NEXT_ACTION_REASON_LABELS[reason];
}

/** The row still needs somebody (the branch says so and the status agrees). */
function isOpenRow(row: AreaWorkRow): boolean {
  return row.open && isOpenRowStatus(row.rowKind, row.status);
}

export function isRowOwner(row: AreaWorkRow, userId: string): boolean {
  return Boolean(row.ownerUserId) && row.ownerUserId === userId;
}

export function isRowBackup(row: AreaWorkRow, userId: string): boolean {
  return extraString(row.extra, 'backupUserId') === userId;
}

/** Milliseconds of `dueAt`, or `null` when the row has no (valid) due date. */
function dueTime(row: AreaWorkRow): number | null {
  if (!row.dueAt) return null;
  const time = Date.parse(row.dueAt);
  return Number.isNaN(time) ? null : time;
}

/** Earliest due date first; rows without a date go last; ties broken by id. */
function byDue(a: AreaWorkRow, b: AreaWorkRow): number {
  const left = dueTime(a);
  const right = dueTime(b);
  if (left !== null && right !== null && left !== right) return left - right;
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;
  return a.id.localeCompare(b.id);
}

/** Highest escalation first, then the oldest due date. */
function byEscalation(a: AreaWorkRow, b: AreaWorkRow): number {
  if (a.escalationLevel !== b.escalationLevel) return b.escalationLevel - a.escalationLevel;
  return byDue(a, b);
}

function isEscalated(row: AreaWorkRow): boolean {
  return row.status === 'escalated' || row.escalationLevel > 0;
}

function isStarted(row: AreaWorkRow): boolean {
  return IN_PROGRESS_STATUSES.has(row.status) || row.startedAt !== null;
}

export interface PickNextActionOptions {
  /**
   * True when the row offers this person at least one command
   * (`getRowActions(...).length > 0`). Inside every tier a row that CAN be
   * acted on wins over one that cannot, so the card that says what to do now
   * never lands on a row whose only answer is «No hay acciones disponibles en
   * este estado». It never changes the tier: a row of a higher tier still wins.
   */
  hasActions?: (row: AreaWorkRow) => boolean;
}

/** First row of the (already sorted) list that offers an action; otherwise the first. */
function preferActionable(
  sorted: readonly AreaWorkRow[],
  hasActions: ((row: AreaWorkRow) => boolean) | undefined
): AreaWorkRow | undefined {
  if (!hasActions) return sorted[0];
  return sorted.find((row) => hasActions(row)) ?? sorted[0];
}

/**
 * What this person should attend next among the visible rows, or `null` when
 * nothing in the list is theirs and nothing is escalated.
 */
export function pickNextAction(
  rows: readonly AreaWorkRow[],
  userId: string,
  now: Date,
  options: PickNextActionOptions = {}
): AreaNextAction | null {
  const open = rows.filter(isOpenRow);
  const time = now.getTime();
  const { hasActions } = options;

  const own = open.filter((row) => isRowOwner(row, userId));

  const started = preferActionable(own.filter(isStarted).sort(byDue), hasActions);
  if (started) return { row: started, reason: 'in_progress' };

  const mine = preferActionable(own.sort(byDue), hasActions);
  if (mine) {
    const due = dueTime(mine);
    const reason: AreaNextActionReason =
      due === null ? 'no_due' : due < time ? 'overdue' : 'next_due';
    return { row: mine, reason };
  }

  const backup = preferActionable(
    open
      .filter((row) => !isRowOwner(row, userId) && isRowBackup(row, userId))
      .filter((row) => {
        const due = dueTime(row);
        return due !== null && due < time;
      })
      .sort(byDue),
    hasActions
  );
  if (backup) return { row: backup, reason: 'backup_overdue' };

  const escalated = preferActionable(
    open.filter((row) => !isRowOwner(row, userId) && isEscalated(row)).sort(byEscalation),
    hasActions
  );
  return escalated ? { row: escalated, reason: 'area_escalated' } : null;
}
