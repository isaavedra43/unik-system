import { prisma } from '@/lib/prisma';
import { obligationsLink, periodCloseLink } from '@/modules/areas/area-links';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import { isKnownPermission } from '@/modules/auth/permissions';
import { JOB_PRIORITY, registerJobHandler, type JobContext } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import type { NotificationCategory } from '@/modules/notifications/catalog';
import { notifyUser } from '@/modules/notifications/notification-service';
import { isOpsFlagEnabled } from '@/modules/operations/operations-config';
import { yesterdayKeyOf } from './close-service';
import {
  reconcileCollections,
  registerCollectionsCaseListener,
  type ReconcileSummary,
} from './collections-service';
import { proposeExpense, type ProposeExpenseOutcome } from './expenses-service';
import { getFinanceSettings } from './finance-config';
import {
  addDaysToKey,
  compareKeys,
  dateKeyOf,
  localDateKey,
  periodKeyOfKey,
  toDbDate,
} from './finance-dates';
import { runFinanceSystemCommand } from './finance-helpers';
import { formatMxn } from './money';
import { remainingOf } from './obligation-rules';
import {
  FINANCE_ALERT_CATEGORY,
  FINANCE_COMMANDS,
  FINANCE_JOB_TYPES,
  FINANCE_OBJECT_TYPES,
  FINANCE_RECURRING_EVERY_MS,
  OBLIGATION_OPEN_STATUSES,
} from './types';

/**
 * Background jobs of the internal accounting (plan 6.4):
 *
 * - `finance.expense_propose` (outbox of capture / receipt upload): proposal
 *   of the expense fields (AI + history rules).
 * - `finance.recurring_expenses` (24 h): drafts of due recurring templates,
 *   catching up missed runs one by one.
 * - `finance.reconcile_collections` (30 min): expected receivables of new
 *   cases, voided orders and the matching of Zoho payments.
 * - `finance.obligations_due` (1 h): one daily digest per person with
 *   `finance.manage_obligations` of overdue / soon-due obligations.
 * - `finance.daily_close_reminder` (24 h): reminds `finance.close` holders
 *   when yesterday had activity and was not closed.
 *
 * Plus the `onCaseStarted` subscription that expects each case's receivable.
 * The recurring jobs do nothing while the `finance` flag is off.
 *
 * Notifications use the `finance_alert` category of the notification catalogue,
 * so a person configures them apart from the rest in /app/account/notifications.
 */

const FINANCE_ALERT: NotificationCategory = FINANCE_ALERT_CATEGORY;
const MAX_RECIPIENTS = 50;
const MAX_CATCH_UP_RUNS = 62;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'finance-jobs', event, ...extra }));

/** Active people holding `permissionKey` (explicitly); super admins only when nobody holds it. */
export async function usersWithPermission(permissionKey: string): Promise<string[]> {
  if (!isKnownPermission(permissionKey)) return [];
  const holders = await prisma.user.findMany({
    where: {
      isActive: true,
      isBot: false,
      roles: { some: { role: { isActive: true, permissions: { some: { permissionKey } } } } },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_RECIPIENTS,
  });
  if (holders.length > 0) return holders.map((u) => u.id);
  const admins = await prisma.user.findMany({
    where: {
      isActive: true,
      isBot: false,
      roles: { some: { role: { isActive: true, key: SUPER_ADMIN_ROLE_KEY } } },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });
  return admins.map((u) => u.id);
}

export async function runExpenseProposeJob(
  job: Pick<JobContext<{ expenseId?: string }>, 'payload'>
): Promise<ProposeExpenseOutcome> {
  const expenseId = typeof job.payload?.expenseId === 'string' ? job.payload.expenseId : '';
  if (!expenseId) return { status: 'not_found' };
  return proposeExpense(expenseId);
}

export interface RecurringSummary {
  templates: number;
  created: number;
  skipped?: string;
}

export async function runRecurringExpensesJob(
  options: { now?: Date } = {}
): Promise<RecurringSummary> {
  if (!(await isOpsFlagEnabled('finance')))
    return { templates: 0, created: 0, skipped: 'disabled' };
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const templates = await prisma.expenseTemplate.findMany({
    where: { active: true, nextRunAt: { lte: toDbDate(todayKey) } },
    select: { id: true, nextRunAt: true },
    orderBy: { nextRunAt: 'asc' },
    take: 500,
  });
  let created = 0;
  for (const template of templates) {
    let runDate: string | null = template.nextRunAt ? dateKeyOf(template.nextRunAt) : null;
    for (let i = 0; runDate && compareKeys(runDate, todayKey) <= 0 && i < MAX_CATCH_UP_RUNS; i++) {
      const result = await runFinanceSystemCommand<{ created: boolean; nextRunAt: string | null }>(
        {
          commandId: `finance:recurring:${template.id}:${runDate}`,
          type: FINANCE_COMMANDS.expenseRunRecurring,
          aggregate: { type: FINANCE_OBJECT_TYPES.expenseTemplate, id: template.id },
          payload: { templateId: template.id, runDate },
        },
        { now }
      );
      if (result.status === 'rejected' || !result.data?.created) break;
      created += 1;
      runDate = result.data.nextRunAt;
    }
  }
  log('recurring_expenses', { templates: templates.length, created });
  return { templates: templates.length, created };
}

export async function runReconcileCollectionsJob(
  options: { now?: Date } = {}
): Promise<ReconcileSummary | { skipped: string }> {
  if (!(await isOpsFlagEnabled('finance'))) return { skipped: 'disabled' };
  return reconcileCollections(options);
}

export async function runObligationsDueJob(
  options: { now?: Date } = {}
): Promise<{ obligations: number; notified: number; skipped?: string }> {
  if (!(await isOpsFlagEnabled('finance')))
    return { obligations: 0, notified: 0, skipped: 'disabled' };
  const now = options.now ?? new Date();
  const todayKey = localDateKey(now);
  const settings = await getFinanceSettings();
  const due = await prisma.obligation.findMany({
    where: {
      status: { in: [...OBLIGATION_OPEN_STATUSES] },
      dueAt: { lte: toDbDate(addDaysToKey(todayKey, settings.obligationsDueAlertDays)) },
    },
    orderBy: [{ dueAt: 'asc' }, { number: 'asc' }],
    take: 200,
  });
  if (due.length === 0) return { obligations: 0, notified: 0 };
  const overdue = due.filter((o) => o.dueAt && compareKeys(dateKeyOf(o.dueAt), todayKey) < 0);
  const payables = due.filter((o) => o.kind === 'payable').length;
  const receivables = due.length - payables;
  const lines = due
    .slice(0, 5)
    .map(
      (o) =>
        `${o.number} ${o.kind === 'payable' ? 'por pagar' : 'por cobrar'} ${formatMxn(remainingOf(o), o.currency)} · vence ${o.dueAt ? dateKeyOf(o.dueAt) : 'sin fecha'}`
    );
  const title =
    overdue.length > 0
      ? `${overdue.length} obligación(es) vencida(s) y ${due.length - overdue.length} por vencer`
      : `${due.length} obligación(es) vencen en ${settings.obligationsDueAlertDays} día(s)`;
  const recipients = await usersWithPermission('finance.manage_obligations');
  let notified = 0;
  for (const userId of recipients) {
    const result = await notifyUser({
      userId,
      category: FINANCE_ALERT,
      type: 'finance_obligations_due',
      title,
      body: `${payables} por pagar · ${receivables} por cobrar\n${lines.join('\n')}${due.length > 5 ? `\n… y ${due.length - 5} más` : ''}`,
      url: obligationsLink({ status: 'open', overdueOnly: true }),
      entityType: 'finance_obligations',
      metadata: { total: due.length, overdue: overdue.length, payables, receivables },
      dedupeKey: `finance_due:${userId}:${todayKey}`,
    });
    if (!result.suppressed) notified += 1;
  }
  log('obligations_due', { obligations: due.length, overdue: overdue.length, notified });
  return { obligations: due.length, notified };
}

export async function runDailyCloseReminderJob(
  options: { now?: Date } = {}
): Promise<{ notified: number; skipped?: string }> {
  if (!(await isOpsFlagEnabled('finance'))) return { notified: 0, skipped: 'disabled' };
  const settings = await getFinanceSettings();
  if (!settings.dailyCloseReminder) return { notified: 0, skipped: 'off' };
  const now = options.now ?? new Date();
  const yesterday = yesterdayKeyOf(localDateKey(now));
  const [dayClose, monthClose, entries, expenses] = await Promise.all([
    prisma.periodClose.findFirst({
      where: { kind: 'daily', periodKey: yesterday, status: 'closed' },
      select: { id: true },
    }),
    prisma.periodClose.findFirst({
      where: { kind: 'monthly', periodKey: periodKeyOfKey(yesterday), status: 'closed' },
      select: { id: true },
    }),
    prisma.ledgerEntry.count({ where: { date: toDbDate(yesterday) } }),
    prisma.expense.count({ where: { date: toDbDate(yesterday) } }),
  ]);
  if (dayClose || monthClose) return { notified: 0, skipped: 'closed' };
  if (entries === 0 && expenses === 0) return { notified: 0, skipped: 'no_activity' };
  const recipients = await usersWithPermission('finance.close');
  let notified = 0;
  for (const userId of recipients) {
    const result = await notifyUser({
      userId,
      category: FINANCE_ALERT,
      type: 'finance_daily_close_reminder',
      title: `Falta el cierre del ${yesterday}`,
      body: `${entries} asiento(s) y ${expenses} gasto(s) del día sin cierre ni arqueo`,
      url: periodCloseLink(),
      entityType: 'period_close',
      dedupeKey: `finance_close_reminder:${yesterday}:${userId}`,
    });
    if (!result.suppressed) notified += 1;
  }
  log('daily_close_reminder', { date: yesterday, notified });
  return { notified };
}

type GlobalWithFinanceJobs = typeof globalThis & { __unikFinanceJobsRegistered?: boolean };

export function registerFinanceJobs(): void {
  const scope = globalThis as GlobalWithFinanceJobs;
  if (scope.__unikFinanceJobsRegistered) return;
  scope.__unikFinanceJobsRegistered = true;

  registerJobHandler<{ expenseId?: string }>(
    FINANCE_JOB_TYPES.expensePropose,
    (job) => runExpenseProposeJob(job),
    {
      timeoutMs: 4 * 60_000,
    }
  );
  registerJobHandler(FINANCE_JOB_TYPES.recurringExpenses, () => runRecurringExpensesJob(), {
    timeoutMs: 10 * 60_000,
  });
  registerJobHandler(FINANCE_JOB_TYPES.reconcileCollections, () => runReconcileCollectionsJob(), {
    timeoutMs: 10 * 60_000,
  });
  registerJobHandler(FINANCE_JOB_TYPES.obligationsDue, () => runObligationsDueJob(), {
    timeoutMs: 2 * 60_000,
  });
  registerJobHandler(FINANCE_JOB_TYPES.dailyCloseReminder, () => runDailyCloseReminderJob(), {
    timeoutMs: 2 * 60_000,
  });

  registerRecurringJob({
    type: FINANCE_JOB_TYPES.recurringExpenses,
    everyMs: FINANCE_RECURRING_EVERY_MS.recurringExpenses,
    priority: JOB_PRIORITY.maintenance,
  });
  registerRecurringJob({
    type: FINANCE_JOB_TYPES.reconcileCollections,
    everyMs: FINANCE_RECURRING_EVERY_MS.reconcileCollections,
    priority: JOB_PRIORITY.maintenance,
  });
  registerRecurringJob({
    type: FINANCE_JOB_TYPES.obligationsDue,
    everyMs: FINANCE_RECURRING_EVERY_MS.obligationsDue,
    priority: JOB_PRIORITY.maintenance,
  });
  registerRecurringJob({
    type: FINANCE_JOB_TYPES.dailyCloseReminder,
    everyMs: FINANCE_RECURRING_EVERY_MS.dailyCloseReminder,
    priority: JOB_PRIORITY.maintenance,
  });

  registerCollectionsCaseListener();
}

registerFinanceJobs();
