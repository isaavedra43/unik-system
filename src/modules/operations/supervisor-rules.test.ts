import { describe, expect, it, vi } from 'vitest';

// The rules reuse the pure escalation math of the work item service, whose
// module also registers commands; no query ever runs here.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { defaultOperationsSettings } from './operations-config';
import {
  SUPERVISOR_RULE_KEYS,
  chooseReplacementOwner,
  emptySupervisorCounters,
  evaluateSyncStaleness,
  isApprovalExpiryDue,
  isFinancialCloseDue,
  isOrphanCase,
  isReservationAlertDue,
  isSalesOrderSettled,
  isWaitingForFutureDate,
  orphanBucket,
  overdueEscalationLevel,
  requestOverdueLevel,
  reservationAgeDays,
  reservationAlertBucket,
  summarizeSupervisorCounters,
  supervisorCommandId,
} from './supervisor-rules';

const NOW = new Date('2026-09-15T15:00:00.000Z');
const ESCALATION = defaultOperationsSettings(NOW).escalation;
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60_000);
const COMMAND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.\-]{0,159}$/;

describe('supervisorCommandId', () => {
  it('builds sup:{kind}:{objectId}:{bucket}', () => {
    expect(supervisorCommandId('overdue', 'wi_123', 'l1-d100')).toBe('sup:overdue:wi_123:l1-d100');
  });

  it('replaces characters outside the ledger alphabet', () => {
    const id = supervisorCommandId('owner_absent', 'wi 1', 'user@example.com');
    expect(id).toBe('sup:owner_absent:wi_1:user_example.com');
    expect(id).toMatch(COMMAND_ID_PATTERN);
  });

  it('shortens long ids with a stable hash', () => {
    const long = 'x'.repeat(300);
    const a = supervisorCommandId('orphan', long, 'b1');
    const b = supervisorCommandId('orphan', long, 'b1');
    const c = supervisorCommandId('orphan', long, 'b2');
    expect(a).toHaveLength(160);
    expect(a).toMatch(COMMAND_ID_PATTERN);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('orphan cases', () => {
  const base = { status: 'open', openWorkItems: 0, activeSteps: 0, lastActivityAt: minutesAgo(10) };

  it('is orphan when open, with nothing to do or wait for, past the grace period', () => {
    expect(isOrphanCase(base, NOW)).toBe(true);
    expect(isOrphanCase({ ...base, status: 'ready_to_close' }, NOW)).toBe(true);
  });

  it('is not orphan with open work, an active or waiting step, a closed status or recent activity', () => {
    expect(isOrphanCase({ ...base, openWorkItems: 1 }, NOW)).toBe(false);
    expect(isOrphanCase({ ...base, activeSteps: 2 }, NOW)).toBe(false);
    expect(isOrphanCase({ ...base, status: 'closed' }, NOW)).toBe(false);
    expect(isOrphanCase({ ...base, status: 'cancelled' }, NOW)).toBe(false);
    expect(isOrphanCase({ ...base, lastActivityAt: NOW }, NOW)).toBe(false);
  });

  it('changes the bucket when the case or its work items change', () => {
    const a = orphanBucket({ version: 3, lastActivityAt: minutesAgo(30), lastWorkItemAt: null });
    const b = orphanBucket({ version: 3, lastActivityAt: minutesAgo(30), lastWorkItemAt: NOW });
    const c = orphanBucket({ version: 4, lastActivityAt: minutesAgo(30), lastWorkItemAt: null });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(orphanBucket({ version: 3, lastActivityAt: minutesAgo(30), lastWorkItemAt: null })).toBe(
      a
    );
  });
});

describe('overdue work items', () => {
  const item = (overrides: Record<string, unknown> = {}) => ({
    status: 'open',
    dueAt: minutesAgo(10),
    escalationLevel: 0,
    escalatedAt: null as Date | null,
    waitUntil: null as Date | null,
    ...overrides,
  });

  it('applies the level that matches the lateness', () => {
    expect(overdueEscalationLevel(item({ dueAt: minutesAgo(-5) }), ESCALATION, NOW)).toBeNull();
    expect(overdueEscalationLevel(item(), ESCALATION, NOW)).toBe(0);
    expect(overdueEscalationLevel(item({ dueAt: minutesAgo(130) }), ESCALATION, NOW)).toBe(1);
    expect(overdueEscalationLevel(item({ dueAt: minutesAgo(500) }), ESCALATION, NOW)).toBe(2);
    // Last level: the critical incident ([0, 120, 480] → 840 minutes).
    expect(overdueEscalationLevel(item({ dueAt: minutesAgo(900) }), ESCALATION, NOW)).toBe(3);
  });

  it('never repeats a level already applied', () => {
    const escalated = item({
      dueAt: minutesAgo(130),
      escalationLevel: 1,
      escalatedAt: minutesAgo(5),
    });
    expect(overdueEscalationLevel(escalated, ESCALATION, NOW)).toBeNull();
    const behind = item({
      dueAt: minutesAgo(500),
      escalationLevel: 0,
      escalatedAt: minutesAgo(300),
    });
    expect(overdueEscalationLevel(behind, ESCALATION, NOW)).toBe(2);
  });

  it('skips closed items and items waiting for a future date', () => {
    expect(overdueEscalationLevel(item({ status: 'done' }), ESCALATION, NOW)).toBeNull();
    const waitingFuture = item({ status: 'waiting', waitUntil: minutesAgo(-60) });
    expect(isWaitingForFutureDate(waitingFuture, NOW)).toBe(true);
    expect(overdueEscalationLevel(waitingFuture, ESCALATION, NOW)).toBeNull();
    const waitingPast = item({ status: 'waiting', waitUntil: minutesAgo(1) });
    expect(overdueEscalationLevel(waitingPast, ESCALATION, NOW)).toBe(0);
    expect(overdueEscalationLevel(item({ status: 'waiting' }), ESCALATION, NOW)).toBe(0);
  });
});

describe('stale external syncs', () => {
  const order = (overrides: Record<string, unknown> = {}) => ({
    zohoSyncState: 'pending_write',
    zohoLastAttemptAt: null as Date | null,
    updatedAt: minutesAgo(10),
    version: 2,
    ...overrides,
  });

  it('ignores states that owe nothing to Zoho', () => {
    const result = evaluateSyncStaleness(
      order({ zohoSyncState: 'readback_ok', updatedAt: minutesAgo(500) }),
      NOW,
      15
    );
    expect(result).toMatchObject({ watched: false, requeueDue: false, incidentDue: false });
  });

  it('re-enqueues once per stale window and opens the incident after an hour', () => {
    expect(evaluateSyncStaleness(order(), NOW, 15)).toMatchObject({
      requeueDue: false,
      incidentDue: false,
    });
    const first = evaluateSyncStaleness(order({ updatedAt: minutesAgo(20) }), NOW, 15);
    expect(first).toMatchObject({ requeueDue: true, incidentDue: false, idleMinutes: 20 });
    const sameWindow = evaluateSyncStaleness(order({ updatedAt: minutesAgo(29) }), NOW, 15);
    expect(sameWindow.requeueBucket).toBe(first.requeueBucket);
    const nextWindow = evaluateSyncStaleness(order({ updatedAt: minutesAgo(31) }), NOW, 15);
    expect(nextWindow.requeueBucket).not.toBe(first.requeueBucket);
    const incident = evaluateSyncStaleness(order({ updatedAt: minutesAgo(61) }), NOW, 15);
    expect(incident).toMatchObject({
      requeueDue: true,
      incidentDue: true,
      incidentBucket: 'v2-pending_write',
    });
  });

  it('measures idleness from the latest attempt or change', () => {
    const attempted = order({ updatedAt: minutesAgo(90), zohoLastAttemptAt: minutesAgo(5) });
    expect(evaluateSyncStaleness(attempted, NOW, 15)).toMatchObject({
      idleMinutes: 5,
      requeueDue: false,
    });
    const changed = order({ updatedAt: minutesAgo(5), zohoLastAttemptAt: minutesAgo(90) });
    expect(evaluateSyncStaleness(changed, NOW, 15).idleMinutes).toBe(5);
  });

  it('never opens the incident before the stale window when the window is longer than an hour', () => {
    const slow = evaluateSyncStaleness(
      order({ zohoSyncState: 'written', updatedAt: minutesAgo(70) }),
      NOW,
      90
    );
    expect(slow).toMatchObject({ requeueDue: false, incidentDue: false });
  });
});

describe('overdue area requests', () => {
  it('maps the lateness of open requests to the ladder', () => {
    expect(
      requestOverdueLevel({ status: 'sent', dueAt: minutesAgo(-10) }, ESCALATION, NOW)
    ).toBeNull();
    expect(
      requestOverdueLevel({ status: 'acknowledged', dueAt: minutesAgo(5) }, ESCALATION, NOW)
    ).toBe(0);
    expect(
      requestOverdueLevel({ status: 'blocked', dueAt: minutesAgo(200) }, ESCALATION, NOW)
    ).toBe(1);
    expect(
      requestOverdueLevel({ status: 'resolved', dueAt: minutesAgo(200) }, ESCALATION, NOW)
    ).toBeNull();
  });
});

describe('old reservations', () => {
  it('alerts after the configured days, once per period', () => {
    expect(reservationAgeDays(daysAgo(7.5), NOW)).toBe(7);
    expect(isReservationAlertDue(daysAgo(6.9), NOW, 7)).toBe(false);
    expect(isReservationAlertDue(daysAgo(7), NOW, 7)).toBe(true);
    expect(reservationAlertBucket(daysAgo(8), NOW, 7)).toBe('p1');
    expect(reservationAlertBucket(daysAgo(13), NOW, 7)).toBe('p1');
    expect(reservationAlertBucket(daysAgo(14), NOW, 7)).toBe('p2');
  });
});

describe('chooseReplacementOwner', () => {
  const base = {
    ownerUserId: 'gone',
    backupUserId: 'backup' as string | null,
    backupActive: true,
    assignee: { ownerUserId: 'lead', backupUserId: 'lead_backup' as string | null },
    assigneeOwnerActive: true,
    assigneeBackupActive: true,
  };

  it('promotes the active backup and keeps the area assignee as backup', () => {
    expect(chooseReplacementOwner(base)).toEqual({ ownerUserId: 'backup', backupUserId: 'lead' });
    expect(
      chooseReplacementOwner({ ...base, assignee: { ownerUserId: 'backup', backupUserId: null } })
    ).toEqual({ ownerUserId: 'backup', backupUserId: null });
  });

  it('falls back to the area assignee when the backup is missing or inactive', () => {
    expect(chooseReplacementOwner({ ...base, backupActive: false })).toEqual({
      ownerUserId: 'lead',
      backupUserId: 'lead_backup',
    });
    expect(
      chooseReplacementOwner({ ...base, backupUserId: null, assigneeBackupActive: false })
    ).toEqual({ ownerUserId: 'lead', backupUserId: null });
  });

  it('returns null when nobody different and active is available', () => {
    expect(
      chooseReplacementOwner({
        ...base,
        backupActive: false,
        assignee: { ownerUserId: 'gone', backupUserId: null },
      })
    ).toBeNull();
    expect(
      chooseReplacementOwner({ ...base, backupUserId: null, assigneeOwnerActive: false })
    ).toBeNull();
    expect(chooseReplacementOwner({ ...base, backupUserId: null, assignee: null })).toBeNull();
  });
});

describe('financial close', () => {
  const settled = { status: 'confirmed', invoicedStatus: 'invoiced', paidStatus: 'paid' };

  it('recognizes an invoiced and paid sales order', () => {
    expect(isSalesOrderSettled(settled)).toBe(true);
    expect(
      isSalesOrderSettled({ ...settled, invoicedStatus: 'INVOICED', paidStatus: ' Paid ' })
    ).toBe(true);
    expect(isSalesOrderSettled({ ...settled, paidStatus: 'partially_paid' })).toBe(false);
    expect(isSalesOrderSettled({ ...settled, invoicedStatus: 'partially_invoiced' })).toBe(false);
    expect(isSalesOrderSettled({ ...settled, status: 'void' })).toBe(false);
  });

  it('closes only cases that wait for money alone', () => {
    const input = {
      caseStatus: 'waiting',
      financialStepStatus: 'waiting' as string | null,
      otherOpenWorkItems: 0,
      salesOrder: settled,
    };
    expect(isFinancialCloseDue(input)).toBe(true);
    expect(isFinancialCloseDue({ ...input, financialStepStatus: 'ready' })).toBe(true);
    expect(isFinancialCloseDue({ ...input, financialStepStatus: 'pending' })).toBe(false);
    expect(isFinancialCloseDue({ ...input, financialStepStatus: 'done' })).toBe(false);
    expect(isFinancialCloseDue({ ...input, otherOpenWorkItems: 1 })).toBe(false);
    expect(isFinancialCloseDue({ ...input, salesOrder: null })).toBe(false);
    expect(
      isFinancialCloseDue({ ...input, salesOrder: { ...settled, paidStatus: 'unpaid' } })
    ).toBe(false);
    expect(isFinancialCloseDue({ ...input, caseStatus: 'closed' })).toBe(false);
  });

  it('without blueprint steps requires the case to be ready to close', () => {
    const input = { financialStepStatus: null, otherOpenWorkItems: 0, salesOrder: settled };
    expect(isFinancialCloseDue({ ...input, caseStatus: 'ready_to_close' })).toBe(true);
    expect(isFinancialCloseDue({ ...input, caseStatus: 'open' })).toBe(false);
  });
});

describe('rule 8 — expired approvals', () => {
  it('expires only pending approvals whose deadline already passed', () => {
    const later = new Date(NOW.getTime() + 60_000);
    expect(isApprovalExpiryDue({ status: 'pending', expiresAt: minutesAgo(1) }, NOW)).toBe(true);
    expect(isApprovalExpiryDue({ status: 'pending', expiresAt: NOW }, NOW)).toBe(true);
    expect(isApprovalExpiryDue({ status: 'pending', expiresAt: later }, NOW)).toBe(false);
    expect(isApprovalExpiryDue({ status: 'pending', expiresAt: null }, NOW)).toBe(false);
    expect(isApprovalExpiryDue({ status: 'approved', expiresAt: minutesAgo(10) }, NOW)).toBe(false);
    expect(isApprovalExpiryDue({ status: 'expired', expiresAt: minutesAgo(10) }, NOW)).toBe(false);
  });
});

describe('counters', () => {
  it('starts every rule at zero and sums the totals', () => {
    const counters = emptySupervisorCounters();
    expect(Object.keys(counters)).toEqual([...SUPERVISOR_RULE_KEYS]);
    counters.overdueWorkItems.checked = 3;
    counters.overdueWorkItems.actions = 2;
    counters.orphanCases.incidents = 1;
    counters.staleSyncs.errors = 1;
    counters.absentOwners.rejected = 2;
    expect(summarizeSupervisorCounters(counters)).toEqual({
      checked: 3,
      actions: 2,
      incidents: 1,
      rejected: 2,
      errors: 1,
    });
  });
});
