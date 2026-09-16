import { describe, expect, it } from 'vitest';
import type { AreaWorkRow } from './area-work-row';
import {
  AREA_NEXT_ACTION_REASON_LABELS,
  isRowBackup,
  isRowOwner,
  nextActionReasonLabel,
  pickNextAction,
} from './next-action';

/**
 * "Mi siguiente acción" of an area: the tier order must never change silently,
 * because it is the one thing a person on a phone reads before acting.
 */

const NOW = new Date('2026-09-15T18:00:00.000Z');
const HOUR = 3_600_000;

function row(overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  const extra = { ...(overrides.extra ?? {}) };
  return {
    id: `work_item:${overrides.sourceId ?? 'wi-1'}`,
    rowKind: 'work_item',
    sourceId: 'wi-1',
    areaKey: 'compras',
    caseId: 'case-1',
    caseNumber: 'EXP-1',
    customerName: 'Constructora del Norte',
    title: 'Solicitar compra',
    status: 'open',
    statusLabel: 'Abierto',
    statusTone: 'default',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-me',
    ownerName: 'Ana',
    dueAt: new Date(NOW.getTime() + HOUR).toISOString(),
    startedAt: null,
    lastActivityAt: '2026-09-15T12:00:00.000Z',
    escalationLevel: 0,
    waitReason: null,
    objectType: null,
    objectId: null,
    counterpartyName: null,
    locationCode: null,
    amount: null,
    quantity: null,
    version: 1,
    overdue: false,
    open: true,
    ...overrides,
    extra,
  };
}

describe('pickNextAction', () => {
  it('returns null with no rows', () => {
    expect(pickNextAction([], 'u-me', NOW)).toBeNull();
  });

  it('returns null when nothing is the person’s and nothing is escalated', () => {
    const rows = [row({ sourceId: 'a', id: 'work_item:a', ownerUserId: 'u-other' })];
    expect(pickNextAction(rows, 'u-me', NOW)).toBeNull();
  });

  it('ignores closed rows even when they are the person’s', () => {
    const rows = [
      row({ sourceId: 'a', id: 'work_item:a', status: 'done', open: false }),
      row({ sourceId: 'b', id: 'work_item:b', status: 'cancelled', open: true }),
    ];
    expect(pickNextAction(rows, 'u-me', NOW)).toBeNull();
  });

  it('prefers own work already in progress over an overdue one', () => {
    const rows = [
      row({
        sourceId: 'overdue',
        id: 'work_item:overdue',
        dueAt: new Date(NOW.getTime() - 5 * HOUR).toISOString(),
        overdue: true,
      }),
      row({ sourceId: 'doing', id: 'work_item:doing', status: 'in_progress' }),
    ];
    const next = pickNextAction(rows, 'u-me', NOW);
    expect(next?.row.sourceId).toBe('doing');
    expect(next?.reason).toBe('in_progress');
  });

  it('treats a started domain row as in progress', () => {
    const rows = [
      row({
        sourceId: 'count',
        id: 'stock_count:count',
        rowKind: 'stock_count',
        status: 'counting',
        startedAt: '2026-09-15T17:00:00.000Z',
      }),
    ];
    expect(pickNextAction(rows, 'u-me', NOW)?.reason).toBe('in_progress');
  });

  it('picks the earliest due own row and says it is overdue', () => {
    const rows = [
      row({
        sourceId: 'later',
        id: 'work_item:later',
        dueAt: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
      }),
      row({
        sourceId: 'earlier',
        id: 'work_item:earlier',
        dueAt: new Date(NOW.getTime() - HOUR).toISOString(),
        overdue: true,
      }),
    ];
    const next = pickNextAction(rows, 'u-me', NOW);
    expect(next?.row.sourceId).toBe('earlier');
    expect(next?.reason).toBe('overdue');
  });

  it('says "next_due" when the earliest own row is still in the future', () => {
    expect(pickNextAction([row()], 'u-me', NOW)?.reason).toBe('next_due');
  });

  it('puts rows without a due date last and labels them', () => {
    const noDue = row({ sourceId: 'no-due', id: 'work_item:no-due', dueAt: null });
    expect(pickNextAction([noDue], 'u-me', NOW)?.reason).toBe('no_due');
    const withDue = row({ sourceId: 'due', id: 'work_item:due' });
    expect(pickNextAction([noDue, withDue], 'u-me', NOW)?.row.sourceId).toBe('due');
  });

  it('falls back to overdue work covered as backup', () => {
    const rows = [
      row({
        sourceId: 'backup-future',
        id: 'work_item:backup-future',
        ownerUserId: 'u-other',
        extra: { backupUserId: 'u-me' },
      }),
      row({
        sourceId: 'backup-late',
        id: 'work_item:backup-late',
        ownerUserId: 'u-other',
        extra: { backupUserId: 'u-me' },
        dueAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
        overdue: true,
      }),
    ];
    const next = pickNextAction(rows, 'u-me', NOW);
    expect(next?.row.sourceId).toBe('backup-late');
    expect(next?.reason).toBe('backup_overdue');
  });

  it('own work wins over work covered as backup', () => {
    const rows = [
      row({
        sourceId: 'backup-late',
        id: 'work_item:backup-late',
        ownerUserId: 'u-other',
        extra: { backupUserId: 'u-me' },
        dueAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
      }),
      row({ sourceId: 'mine', id: 'work_item:mine' }),
    ];
    expect(pickNextAction(rows, 'u-me', NOW)?.row.sourceId).toBe('mine');
  });

  it('offers escalated work of the area when nothing is the person’s', () => {
    const rows = [
      row({
        sourceId: 'escalated-1',
        id: 'work_item:escalated-1',
        ownerUserId: 'u-other',
        status: 'escalated',
        escalationLevel: 1,
      }),
      row({
        sourceId: 'escalated-2',
        id: 'work_item:escalated-2',
        ownerUserId: 'u-other',
        status: 'escalated',
        escalationLevel: 2,
      }),
    ];
    const next = pickNextAction(rows, 'u-me', NOW);
    expect(next?.row.sourceId).toBe('escalated-2');
    expect(next?.reason).toBe('area_escalated');
  });

  it('never suggests an escalated row the person already owns as "escalado del área"', () => {
    // It is their own open work: it comes as such, by due date, never as an area escalation.
    const rows = [
      row({ sourceId: 'mine', id: 'work_item:mine', status: 'escalated', escalationLevel: 3 }),
    ];
    expect(pickNextAction(rows, 'u-me', NOW)?.reason).toBe('next_due');

    const late = [
      row({
        sourceId: 'mine-late',
        id: 'work_item:mine-late',
        status: 'escalated',
        escalationLevel: 3,
        dueAt: new Date(NOW.getTime() - HOUR).toISOString(),
        overdue: true,
      }),
    ];
    expect(pickNextAction(late, 'u-me', NOW)?.reason).toBe('overdue');
  });

  it('breaks ties by id so the card never flickers between two rows', () => {
    const due = new Date(NOW.getTime() + HOUR).toISOString();
    const rows = [
      row({ sourceId: 'b', id: 'work_item:b', dueAt: due }),
      row({ sourceId: 'a', id: 'work_item:a', dueAt: due }),
    ];
    expect(pickNextAction(rows, 'u-me', NOW)?.row.id).toBe('work_item:a');
    expect(pickNextAction([...rows].reverse(), 'u-me', NOW)?.row.id).toBe('work_item:a');
  });

  it('ignores an invalid due date instead of crashing', () => {
    const rows = [row({ sourceId: 'bad', id: 'work_item:bad', dueAt: 'no-es-fecha' })];
    expect(pickNextAction(rows, 'u-me', NOW)?.reason).toBe('no_due');
  });
});

describe('participants and labels', () => {
  it('recognises owner and backup', () => {
    const item = row({ ownerUserId: 'u-owner', extra: { backupUserId: 'u-backup' } });
    expect(isRowOwner(item, 'u-owner')).toBe(true);
    expect(isRowOwner(item, 'u-backup')).toBe(false);
    expect(isRowBackup(item, 'u-backup')).toBe(true);
    expect(isRowBackup(item, 'u-owner')).toBe(false);
  });

  it('never treats a row without owner as somebody’s', () => {
    expect(isRowOwner(row({ ownerUserId: null }), 'u-me')).toBe(false);
  });

  it('has a Spanish label for every reason', () => {
    for (const [reason, label] of Object.entries(AREA_NEXT_ACTION_REASON_LABELS)) {
      expect(label.length).toBeGreaterThan(3);
      expect(nextActionReasonLabel(reason as keyof typeof AREA_NEXT_ACTION_REASON_LABELS)).toBe(
        label
      );
    }
  });
});

describe('pickNextAction con filas accionables', () => {
  const HOUR_MS = HOUR;

  it('prefiere, dentro del mismo nivel, la fila en la que sí se puede actuar', () => {
    const rows = [
      // Vence antes, pero no ofrece ninguna acción a esta persona.
      row({
        sourceId: 'mirar',
        id: 'case:mirar',
        rowKind: 'case',
        dueAt: new Date(NOW.getTime() + HOUR_MS).toISOString(),
      }),
      row({
        sourceId: 'actuar',
        id: 'work_item:actuar',
        dueAt: new Date(NOW.getTime() + 2 * HOUR_MS).toISOString(),
      }),
    ];
    const picked = pickNextAction(rows, 'u-me', NOW, {
      hasActions: (candidate) => candidate.id === 'work_item:actuar',
    });
    expect(picked?.row.id).toBe('work_item:actuar');
  });

  it('no cambia de nivel: un propio en curso sin acciones sigue ganando a un abierto con acciones', () => {
    const rows = [
      row({
        sourceId: 'curso',
        id: 'case:curso',
        rowKind: 'case',
        status: 'in_progress',
        statusLabel: 'En curso',
      }),
      row({ sourceId: 'abierto', id: 'work_item:abierto' }),
    ];
    const picked = pickNextAction(rows, 'u-me', NOW, {
      hasActions: (candidate) => candidate.id === 'work_item:abierto',
    });
    expect(picked?.row.id).toBe('case:curso');
    expect(picked?.reason).toBe('in_progress');
  });

  it('si ninguna fila del nivel ofrece acciones, elige la misma de siempre', () => {
    const rows = [row({ sourceId: 'unica', id: 'work_item:unica' })];
    const withPredicate = pickNextAction(rows, 'u-me', NOW, { hasActions: () => false });
    expect(withPredicate?.row.id).toBe('work_item:unica');
    expect(withPredicate).toStrictEqual(pickNextAction(rows, 'u-me', NOW));
  });
});
