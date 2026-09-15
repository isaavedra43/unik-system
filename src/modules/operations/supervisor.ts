import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { recordUsage, type UsageDimension } from '@/modules/extensions/usage-meter';
import { expireDueLegacyClaims } from '@/modules/inventory/inventory-commands';
import { JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { readShipmentInput } from '@/modules/logistics/logistics-helpers';
import {
  LOGISTICS_JOB_TYPES,
  LOGISTICS_ZOHO_MAX_ATTEMPTS,
  zohoCancelKey,
  zohoDeliveredKey,
} from '@/modules/logistics/types';
import { pendingZohoOperation } from '@/modules/logistics/zoho-sync-state';
import { expireApprovalInTx } from './approvals-service';
import { loadAreaRequest, markAreaRequestOverdue } from './area-requests-service';
import {
  executeCommand,
  registerCommand,
  resolveAreaAssignee,
  versionedAggregate,
  type AreaAssignee,
  type CommandResult,
} from './commands';
import { isOperationsError, OperationsError } from './errors';
import { recordOperationalEvents, toOperationalJson } from './events-service';
import { openOrReopenIncident } from './incidents-service';
import { getOperationsConfig, type OperationsConfig } from './operations-config';
import {
  FINANCIAL_CLOSE_STEP_KEY,
  ORPHAN_GRACE_MINUTES,
  PREPARE_ORDER_STEP_KEY,
  RESERVATION_ALERT_OBJECT_TYPE,
  SUPERVISOR_ACTOR,
  SUPERVISOR_ACTOR_ID,
  SUPERVISOR_BATCH_SIZE,
  SUPERVISOR_COMMANDS,
  SUPERVISOR_EVENTS,
  WATCHED_SYNC_STATES,
  chooseReplacementOwner,
  emptySupervisorCounters,
  evaluateSyncStaleness,
  isApprovalExpiryDue,
  isFinancialCloseDue,
  isOrphanCase,
  isReservationAlertDue,
  orphanBucket,
  overdueEscalationLevel,
  requestOverdueLevel,
  reservationAgeDays,
  reservationAlertBucket,
  summarizeSupervisorCounters,
  supervisorCommandId,
  type SupervisorCounters,
  type SupervisorFindingKind,
  type SupervisorRuleCounters,
} from './supervisor-rules';
import {
  AREA_LABELS,
  CASE_OPEN_STATUSES,
  OPS_EVENTS,
  WORK_ITEM_OPEN_STATUSES,
  isAreaKey,
  type AreaKey,
} from './types';
import {
  WORK_ITEM_AGGREGATE_TYPE,
  WORK_ITEM_COMMANDS,
  completeWorkItemInTx,
  escalationThresholds,
  isActiveHumanUser,
  loadWorkItem,
  reassignWorkItemInTx,
  type WorkItemEscalationData,
} from './work-items-service';

/**
 * Deterministic supervisor of the operations core (plan section 2.6), run by
 * the recurring job `ops.supervisor` (every 4 minutes, one attempt).
 *
 * Every rule reads a bounded candidate list (`take 200`) and turns each
 * finding into a `system` command with `commandId = sup:{kind}:{objectId}:{bucket}`.
 * The command ledger makes ticks idempotent: the same finding in the same
 * bucket replays the stored result, so a repeated or overlapping tick never
 * escalates, re-enqueues, reassigns or closes twice. Handlers always re-check
 * the finding inside their transaction, because the candidate list is read
 * outside it.
 *
 * 1. Orphan cases (open, no open work item, no active/waiting step) → the
 *    registered case advancer; still orphan → `orphan_case` incident plus a
 *    follow-up work item for Administración.
 * 2. Overdue work items → `workitem.escalate` at the level that matches the
 *    lateness (backup → area lead → Administración → critical `sla_breach`).
 * 3. Stale Zoho syncs of delivery orders → re-enqueue the owed job when none
 *    is alive; idle for 60 minutes → `zoho_failure` incident + work item.
 * 4. Overdue area requests → escalate the linked work item and emit
 *    `request.overdue` once.
 * 5. Reservations older than `reservationAlertDays` whose order was not
 *    prepared → one work item for Ventas per case; expired legacy claims are
 *    released through inventory.
 * 6. Inactive owners of open work items and cases → reassigned through the
 *    area responsible; nobody available → `owner_absent` incident.
 * 7. Cases waiting only for money whose synchronized sales order is invoiced
 *    and paid → financial close.
 * 8. Pending business approvals past `expiresAt` → `expired`, their approval
 *    work items cancelled and the requester notified (`approval.expired`).
 * 9. `supervisor.tick` event with the counters and usage meters under the
 *    `ops.supervisor` dimension.
 *
 * A failing candidate or rule is logged and counted; it never stops the tick.
 */

export const OPS_SUPERVISOR_JOB = 'ops.supervisor';
export const SUPERVISOR_USAGE_DIMENSION = 'ops.supervisor';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const OWNER_SCAN_LIMIT = 1000;
const OPEN_ALERT_SCAN_LIMIT = 1000;
const RESERVATION_DETAIL_LIMIT = 10;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-supervisor', event, ...extra }));

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Case advancer hook
// ---------------------------------------------------------------------------

/**
 * Re-evaluates the steps of a case inside the supervisor's transaction
 * (`advanceCase(tx, caseId)` of the case engine). The case engine registers it
 * when it loads; without it, orphan cases go straight to the incident.
 */
export type SupervisorCaseAdvancer = (tx: Tx, caseId: string) => Promise<unknown>;

type GlobalWithAdvancer = typeof globalThis & {
  __unikSupervisorCaseAdvancer?: SupervisorCaseAdvancer | null;
};

export function registerSupervisorCaseAdvancer(advancer: SupervisorCaseAdvancer): () => void {
  const scope = globalThis as GlobalWithAdvancer;
  scope.__unikSupervisorCaseAdvancer = advancer;
  return () => {
    if (scope.__unikSupervisorCaseAdvancer === advancer) scope.__unikSupervisorCaseAdvancer = null;
  };
}

export function hasSupervisorCaseAdvancer(): boolean {
  return Boolean((globalThis as GlobalWithAdvancer).__unikSupervisorCaseAdvancer);
}

function caseAdvancer(): SupervisorCaseAdvancer | null {
  return (globalThis as GlobalWithAdvancer).__unikSupervisorCaseAdvancer ?? null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const OPEN_WORK = [...WORK_ITEM_OPEN_STATUSES];
const OPEN_CASES = [...CASE_OPEN_STATUSES];

function caseUrl(caseId: string): string {
  return `/app/operations/cases/${caseId}`;
}

async function tryAssignee(tx: Tx, areaKey: AreaKey): Promise<AreaAssignee | null> {
  try {
    return await resolveAreaAssignee(tx, areaKey);
  } catch (err) {
    if (isOperationsError(err) && err.code === 'no_responsible') return null;
    throw err;
  }
}

async function hasOpenWorkItem(tx: Tx, where: Prisma.WorkItemWhereInput): Promise<boolean> {
  const found = await tx.workItem.findFirst({
    where: { ...where, status: { in: OPEN_WORK } },
    select: { id: true },
  });
  return Boolean(found);
}

async function orphanCounts(tx: Tx, caseId: string) {
  const [openWorkItems, activeSteps] = await Promise.all([
    tx.workItem.count({ where: { caseId, status: { in: OPEN_WORK } } }),
    tx.caseStep.count({ where: { caseId, status: { in: ['active', 'waiting'] } } }),
  ]);
  return { openWorkItems, activeSteps };
}

const systemOnly = { actorTypes: ['system'] as const, audit: 'never' as const };
const emptySchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Rule 1 — orphan cases
// ---------------------------------------------------------------------------

export interface OrphanCaseData {
  caseId: string;
  outcome: 'not_open' | 'not_orphan' | 'advanced' | 'incident';
  advancerRegistered: boolean;
  incidentId: string | null;
  incidentCreated: boolean;
  workItemId: string | null;
}

const caseIdSchema = z.object({ caseId: z.string().trim().min(1).max(120) });

registerCommand<z.output<typeof caseIdSchema>, OrphanCaseData>(SUPERVISOR_COMMANDS.orphanCase, {
  ...systemOnly,
  schema: caseIdSchema,
  aggregate: 'none',
  async handler(tx, cmd, ctx) {
    const caseId = cmd.payload.caseId;
    const advancer = caseAdvancer();
    const data: OrphanCaseData = {
      caseId,
      outcome: 'not_open',
      advancerRegistered: Boolean(advancer),
      incidentId: null,
      incidentCreated: false,
      workItemId: null,
    };
    const opCase = await tx.operationalCase.findUnique({ where: { id: caseId } });
    if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
    if (!OPEN_CASES.includes(opCase.status as (typeof OPEN_CASES)[number])) return { data };

    const orphanNow = async () =>
      isOrphanCase(
        {
          status: opCase.status,
          lastActivityAt: opCase.lastActivityAt,
          ...(await orphanCounts(tx, caseId)),
        },
        ctx.now
      );
    if (!(await orphanNow())) return { data: { ...data, outcome: 'not_orphan' } };

    if (advancer) {
      await advancer(tx, caseId);
      if (!(await orphanNow())) return { data: { ...data, outcome: 'advanced' } };
    }

    const idleMinutes = Math.max(
      0,
      Math.floor((ctx.now.getTime() - opCase.lastActivityAt.getTime()) / MINUTE_MS)
    );
    ctx.emit(
      OPS_EVENTS.case.stuck,
      {
        caseId,
        caseNumber: opCase.caseNumber,
        status: opCase.status,
        phase: opCase.phase,
        idleMinutes,
        advancerRegistered: Boolean(advancer),
      },
      { caseId, objectType: 'operational_case', objectId: caseId }
    );
    const { incident, created, reopened } = await openOrReopenIncident(tx, {
      kind: 'orphan_case',
      areaKey: 'administracion',
      severity: 'high',
      title: `Expediente ${opCase.caseNumber} sin trabajo pendiente`,
      dedupeKey: `orphan_case:${caseId}`,
      caseId,
      detail: {
        caseNumber: opCase.caseNumber,
        salesOrderNumber: opCase.salesOrderNumber,
        customerName: opCase.customerName,
        status: opCase.status,
        phase: opCase.phase,
        lastActivityAt: opCase.lastActivityAt.toISOString(),
        idleMinutes,
        advancerRegistered: Boolean(advancer),
      },
    });
    let workItemId: string | null = null;
    if (!(await hasOpenWorkItem(tx, { objectType: 'incident', objectId: incident.id }))) {
      const workItem = await ctx.createWorkItem({
        areaKey: 'administracion',
        kind: 'incident_followup',
        title: `Revisar expediente sin trabajo pendiente: ${opCase.caseNumber}`,
        description:
          'El expediente sigue abierto pero ninguna área tiene trabajo ni espera registrada. ' +
          'Decide el siguiente paso, reasigna o cierra el expediente.',
        caseId,
        objectType: 'incident',
        objectId: incident.id,
        notification: { category: 'ops_escalation' },
      });
      workItemId = workItem.id;
    }
    return {
      data: {
        ...data,
        outcome: 'incident',
        incidentId: incident.id,
        incidentCreated: created || reopened,
        workItemId,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Rule 3 — stale Zoho syncs
// ---------------------------------------------------------------------------

export interface StaleSyncData {
  deliveryOrderId: string;
  outcome: 'not_stale' | 'requeued' | 'job_alive' | 'no_job';
  jobType: string | null;
  idleMinutes: number;
  incidentId: string | null;
  incidentCreated: boolean;
}

interface OwedJob {
  type: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  maxAttempts: number;
  priority: number;
}

/** Job that moves a delivery order's Zoho sync forward (same types and keys as logistics). */
function owedZohoJob(order: {
  id: string;
  status: string;
  zohoSyncState: string;
  shipmentInput: Prisma.JsonValue | null;
}): OwedJob | null {
  if (order.zohoSyncState === 'written') {
    // Nothing to write: the logistics sweep re-reads Zoho. Same key as the recurring run.
    return {
      type: LOGISTICS_JOB_TYPES.reconcile,
      dedupeKey: `recurring:${LOGISTICS_JOB_TYPES.reconcile}`,
      payload: {},
      maxAttempts: 1,
      priority: JOB_PRIORITY.maintenance,
    };
  }
  const operation = pendingZohoOperation(order.status, order.zohoSyncState);
  const write = { maxAttempts: LOGISTICS_ZOHO_MAX_ATTEMPTS, priority: JOB_PRIORITY.normal };
  if (operation === 'mark_delivered') {
    return {
      ...write,
      type: LOGISTICS_JOB_TYPES.markDelivered,
      dedupeKey: zohoDeliveredKey(order.id),
      payload: { deliveryOrderId: order.id },
    };
  }
  if (operation === 'cancel_shipment') {
    return {
      ...write,
      type: LOGISTICS_JOB_TYPES.cancelShipment,
      dedupeKey: zohoCancelKey(order.id),
      payload: { deliveryOrderId: order.id },
    };
  }
  if (operation === 'ship') {
    const shipment = readShipmentInput(order.shipmentInput);
    if (!shipment) return null;
    return {
      ...write,
      type: LOGISTICS_JOB_TYPES.shipPackage,
      dedupeKey: shipment.requestKey,
      payload: { deliveryOrderId: order.id, requestKey: shipment.requestKey },
    };
  }
  return null;
}

const SYNC_STATE_LABELS: Record<string, string> = {
  pending_write: 'pendiente de escribir en Zoho',
  delivered_pending_write: 'entrega pendiente de marcar en Zoho',
  written: 'escrita en Zoho sin confirmar',
};

const deliveryOrderIdSchema = z.object({ deliveryOrderId: z.string().trim().min(1).max(120) });

registerCommand<z.output<typeof deliveryOrderIdSchema>, StaleSyncData>(
  SUPERVISOR_COMMANDS.staleSync,
  {
    ...systemOnly,
    schema: deliveryOrderIdSchema,
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      const order = await tx.deliveryOrder.findUnique({
        where: { id: cmd.payload.deliveryOrderId },
      });
      if (!order) throw new OperationsError('not_found', 'No se encontró la orden de entrega');
      const config = await getOperationsConfig();
      const staleness = evaluateSyncStaleness(order, ctx.now, config.externalSyncStaleMinutes);
      const data: StaleSyncData = {
        deliveryOrderId: order.id,
        outcome: 'not_stale',
        jobType: null,
        idleMinutes: staleness.idleMinutes,
        incidentId: null,
        incidentCreated: false,
      };
      if (!staleness.requeueDue) return { data };

      const job = owedZohoJob(order);
      if (job) {
        data.jobType = job.type;
        const alive = await tx.backgroundJob.findFirst({
          where: { dedupeKey: job.dedupeKey, status: { in: ['pending', 'running'] } },
          select: { id: true },
        });
        if (alive) {
          data.outcome = 'job_alive';
        } else {
          ctx.outbox({
            type: job.type,
            payload: job.payload,
            dedupeKey: job.dedupeKey,
            groupKey: `case:${order.caseId}`,
            maxAttempts: job.maxAttempts,
            priority: job.priority,
            createdBy: SUPERVISOR_ACTOR_ID,
          });
          data.outcome = 'requeued';
          ctx.emit(
            SUPERVISOR_EVENTS.syncRequeued,
            {
              deliveryOrderId: order.id,
              zohoSyncState: order.zohoSyncState,
              jobType: job.type,
              dedupeKey: job.dedupeKey,
              idleMinutes: staleness.idleMinutes,
            },
            {
              caseId: order.caseId,
              areaKey: 'logistica',
              objectType: 'delivery_order',
              objectId: order.id,
            }
          );
        }
      } else {
        data.outcome = 'no_job';
      }

      // Without a job that can move it, the order is stuck right away.
      if (staleness.incidentDue || !job) {
        const stateLabel = SYNC_STATE_LABELS[order.zohoSyncState] ?? order.zohoSyncState;
        const { incident, created, reopened } = await openOrReopenIncident(tx, {
          kind: 'zoho_failure',
          areaKey: 'logistica',
          severity: 'high',
          title: `Entrega ${stateLabel} desde hace ${staleness.idleMinutes} min`.slice(0, 200),
          dedupeKey: `zoho_failure:stale:${order.id}:${staleness.incidentBucket ?? `v${order.version}-${order.zohoSyncState}`}`,
          caseId: order.caseId,
          detail: {
            deliveryOrderId: order.id,
            status: order.status,
            zohoSyncState: order.zohoSyncState,
            zohoLastAttemptAt: order.zohoLastAttemptAt?.toISOString() ?? null,
            zohoError: order.zohoError,
            idleMinutes: staleness.idleMinutes,
            jobType: job?.type ?? null,
            requeued: data.outcome === 'requeued',
            reason: job ? 'stale' : 'missing_shipment_input',
          },
        });
        data.incidentId = incident.id;
        data.incidentCreated = created || reopened;
        const followUp = await hasOpenWorkItem(tx, {
          kind: 'external_sync',
          objectType: 'delivery_order',
          objectId: order.id,
        });
        if (!followUp) {
          await ctx.createWorkItem({
            areaKey: 'logistica',
            kind: 'external_sync',
            title: 'Revisar sincronización con Zoho de una entrega detenida',
            description:
              `La entrega lleva ${staleness.idleMinutes} minutos ${stateLabel}. ` +
              'Verifica el paquete en Zoho y vuelve a asignar transporte si hace falta.',
            caseId: order.caseId,
            objectType: 'delivery_order',
            objectId: order.id,
          });
        }
      }
      return { data };
    },
  }
);

// ---------------------------------------------------------------------------
// Rule 4 — overdue area requests
// ---------------------------------------------------------------------------

export interface RequestOverdueData {
  requestId: string;
  outcome: 'not_overdue' | 'flagged' | 'escalated' | 'already_flagged';
  level: number | null;
  incidentId: string | null;
}

const requestIdSchema = z.object({ requestId: z.string().trim().min(1).max(120) });

registerCommand<z.output<typeof requestIdSchema>, RequestOverdueData>(
  SUPERVISOR_COMMANDS.requestOverdue,
  {
    ...systemOnly,
    schema: requestIdSchema,
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      const request = await loadAreaRequest(tx, cmd.payload.requestId);
      const { escalation } = await getOperationsConfig();
      const level = requestOverdueLevel(request, escalation, ctx.now);
      if (level === null) {
        return {
          data: { requestId: request.id, outcome: 'not_overdue', level: null, incidentId: null },
        };
      }
      const result = await markAreaRequestOverdue(tx, request, level);
      const escalated = Boolean(result.escalation?.applied);
      return {
        data: {
          requestId: request.id,
          outcome: result.emitted ? 'flagged' : escalated ? 'escalated' : 'already_flagged',
          level,
          incidentId: result.escalation?.incidentId ?? null,
        },
      };
    },
  }
);

// ---------------------------------------------------------------------------
// Rule 5 — old reservations without preparation
// ---------------------------------------------------------------------------

export interface StaleReservationsData {
  caseId: string;
  outcome: 'none' | 'prepared' | 'already_open' | 'alerted';
  reservationIds: string[];
  workItemId: string | null;
}

registerCommand<z.output<typeof caseIdSchema>, StaleReservationsData>(
  SUPERVISOR_COMMANDS.staleReservations,
  {
    ...systemOnly,
    schema: caseIdSchema,
    aggregate: 'none',
    async handler(tx, cmd, ctx) {
      const caseId = cmd.payload.caseId;
      const base: StaleReservationsData = {
        caseId,
        outcome: 'none',
        reservationIds: [],
        workItemId: null,
      };
      const config = await getOperationsConfig();
      const cutoff = new Date(ctx.now.getTime() - config.reservationAlertDays * DAY_MS);
      const reservations = await tx.stockReservation.findMany({
        where: { caseId, status: 'active', createdAt: { lte: cutoff } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: SUPERVISOR_BATCH_SIZE,
      });
      const due = reservations.filter((r) =>
        isReservationAlertDue(r.createdAt, ctx.now, config.reservationAlertDays)
      );
      if (due.length === 0) return { data: base };
      const reservationIds = due.map((r) => r.id);

      const prepared = await tx.caseStep.findFirst({
        where: { caseId, stepKey: PREPARE_ORDER_STEP_KEY, status: { in: ['done', 'skipped'] } },
        select: { id: true },
      });
      if (prepared) return { data: { ...base, outcome: 'prepared', reservationIds } };
      if (
        await hasOpenWorkItem(tx, { objectType: RESERVATION_ALERT_OBJECT_TYPE, objectId: caseId })
      ) {
        return { data: { ...base, outcome: 'already_open', reservationIds } };
      }

      const opCase = await tx.operationalCase.findUnique({ where: { id: caseId } });
      const products = await tx.product.findMany({
        where: { zohoItemId: { in: [...new Set(due.map((r) => r.zohoItemId))] } },
        select: { zohoItemId: true, name: true, sku: true },
      });
      const productBy = new Map(products.map((p) => [p.zohoItemId, p]));
      const ageDays = reservationAgeDays(due[0].createdAt, ctx.now);
      const caseLabel = opCase?.caseNumber ?? caseId;
      const lines = due.slice(0, RESERVATION_DETAIL_LIMIT).map((r) => {
        const product = productBy.get(r.zohoItemId);
        const name = product?.name ?? product?.sku ?? r.zohoItemId;
        return `• ${name}: ${r.quantity.toString()} (${reservationAgeDays(r.createdAt, ctx.now)} días)`;
      });
      if (due.length > RESERVATION_DETAIL_LIMIT) {
        lines.push(`• y ${due.length - RESERVATION_DETAIL_LIMIT} reservas más`);
      }
      const ownerActive = opCase ? await isActiveHumanUser(tx, opCase.ownerUserId) : false;
      const workItem = await ctx.createWorkItem({
        areaKey: 'ventas',
        kind: 'action',
        title: `Reserva sin preparar desde hace ${ageDays} días: ${caseLabel}`,
        description: [
          'Hay inventario apartado para este expediente y el pedido todavía no se prepara.',
          'Confirma con el cliente la fecha de entrega o libera la reserva.',
          ...lines,
        ].join('\n'),
        caseId,
        objectType: RESERVATION_ALERT_OBJECT_TYPE,
        objectId: caseId,
        ...(opCase && ownerActive ? { ownerUserId: opCase.ownerUserId } : {}),
      });
      ctx.emit(
        SUPERVISOR_EVENTS.reservationAlert,
        {
          caseId,
          reservationIds,
          oldestAgeDays: ageDays,
          alertDays: config.reservationAlertDays,
          workItemId: workItem.id,
        },
        { caseId, areaKey: 'ventas', objectType: 'operational_case', objectId: caseId }
      );
      return {
        data: { ...base, outcome: 'alerted', reservationIds, workItemId: workItem.id },
      };
    },
  }
);

// ---------------------------------------------------------------------------
// Rule 6 — absent owners
// ---------------------------------------------------------------------------

export interface OwnerAbsentData {
  outcome: 'closed' | 'owner_active' | 'reassigned' | 'incident';
  previousOwnerUserId: string;
  ownerUserId: string;
  incidentId: string | null;
  incidentCreated: boolean;
}

async function isUserActive(tx: Tx, userId: string): Promise<boolean> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { isActive: true } });
  return Boolean(user?.isActive);
}

async function reportAbsentOwner(
  tx: Tx,
  input: {
    userId: string;
    areaKey: AreaKey;
    caseId: string | null;
    detail: Record<string, unknown>;
  }
) {
  return openOrReopenIncident(tx, {
    kind: 'owner_absent',
    areaKey: input.areaKey,
    severity: 'high',
    title: `Trabajo de ${AREA_LABELS[input.areaKey]} asignado a una persona inactiva sin reemplazo`,
    dedupeKey: `owner_absent:${input.userId}:${input.areaKey}`,
    caseId: input.caseId,
    detail: { userId: input.userId, ...input.detail },
  });
}

registerCommand<z.output<typeof emptySchema>, OwnerAbsentData>(
  SUPERVISOR_COMMANDS.workItemOwnerAbsent,
  {
    ...systemOnly,
    schema: emptySchema,
    aggregate: versionedAggregate(WORK_ITEM_AGGREGATE_TYPE, 'workItem'),
    async handler(tx, cmd) {
      const item = await loadWorkItem(tx, cmd.aggregate.id);
      const base: OwnerAbsentData = {
        outcome: 'closed',
        previousOwnerUserId: item.ownerUserId,
        ownerUserId: item.ownerUserId,
        incidentId: null,
        incidentCreated: false,
      };
      if (!OPEN_WORK.includes(item.status as (typeof OPEN_WORK)[number])) return { data: base };
      if (await isUserActive(tx, item.ownerUserId))
        return { data: { ...base, outcome: 'owner_active' } };

      const areaKey: AreaKey = isAreaKey(item.areaKey) ? item.areaKey : 'administracion';
      const assignee = await tryAssignee(tx, areaKey);
      const replacement = chooseReplacementOwner({
        ownerUserId: item.ownerUserId,
        backupUserId: item.backupUserId,
        backupActive: item.backupUserId ? await isActiveHumanUser(tx, item.backupUserId) : false,
        assignee,
        assigneeOwnerActive: assignee ? await isActiveHumanUser(tx, assignee.ownerUserId) : false,
        assigneeBackupActive: assignee?.backupUserId
          ? await isActiveHumanUser(tx, assignee.backupUserId)
          : false,
      });
      if (replacement) {
        const updated = await reassignWorkItemInTx(
          tx,
          item,
          {
            ownerUserId: replacement.ownerUserId,
            backupUserId: replacement.backupUserId,
            reason: 'El responsable anterior está inactivo',
          },
          { aggregate: true }
        );
        return { data: { ...base, outcome: 'reassigned', ownerUserId: updated.ownerUserId } };
      }
      const { incident, created, reopened } = await reportAbsentOwner(tx, {
        userId: item.ownerUserId,
        areaKey,
        caseId: item.caseId,
        detail: { workItemId: item.id, workItemTitle: item.title },
      });
      return {
        data: {
          ...base,
          outcome: 'incident',
          incidentId: incident.id,
          incidentCreated: created || reopened,
        },
      };
    },
  }
);

registerCommand<z.output<typeof emptySchema>, OwnerAbsentData>(
  SUPERVISOR_COMMANDS.caseOwnerAbsent,
  {
    ...systemOnly,
    schema: emptySchema,
    aggregate: versionedAggregate('operational_case', 'operationalCase'),
    async handler(tx, cmd, ctx) {
      const opCase = await tx.operationalCase.findUnique({ where: { id: cmd.aggregate.id } });
      if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
      const base: OwnerAbsentData = {
        outcome: 'closed',
        previousOwnerUserId: opCase.ownerUserId,
        ownerUserId: opCase.ownerUserId,
        incidentId: null,
        incidentCreated: false,
      };
      if (!OPEN_CASES.includes(opCase.status as (typeof OPEN_CASES)[number])) return { data: base };
      if (await isUserActive(tx, opCase.ownerUserId))
        return { data: { ...base, outcome: 'owner_active' } };

      const assignee = await tryAssignee(tx, 'ventas');
      const candidate =
        assignee &&
        assignee.ownerUserId !== opCase.ownerUserId &&
        (await isActiveHumanUser(tx, assignee.ownerUserId))
          ? assignee.ownerUserId
          : null;
      if (candidate) {
        await tx.operationalCase.update({
          where: { id: opCase.id },
          data: {
            ownerUserId: candidate,
            lastActivityAt: latestOf(opCase.lastActivityAt, ctx.now),
          },
        });
        ctx.emit(
          OPS_EVENTS.case.ownerChanged,
          {
            caseId: opCase.id,
            previousOwnerUserId: opCase.ownerUserId,
            ownerUserId: candidate,
            reason: 'owner_inactive',
          },
          {
            caseId: opCase.id,
            areaKey: 'ventas',
            objectType: 'operational_case',
            objectId: opCase.id,
          }
        );
        ctx.notify({
          userId: candidate,
          category: 'ops_workitem',
          type: 'ops_case_assigned',
          title: `Ahora eres responsable del expediente ${opCase.caseNumber}`,
          body: [opCase.customerName, 'El responsable anterior está inactivo']
            .filter(Boolean)
            .join(' · '),
          url: caseUrl(opCase.id),
          entityType: 'operational_case',
          entityId: opCase.id,
        });
        return { data: { ...base, outcome: 'reassigned', ownerUserId: candidate } };
      }
      const { incident, created, reopened } = await reportAbsentOwner(tx, {
        userId: opCase.ownerUserId,
        areaKey: 'ventas',
        caseId: opCase.id,
        detail: { caseId: opCase.id, caseNumber: opCase.caseNumber },
      });
      return {
        data: {
          ...base,
          outcome: 'incident',
          incidentId: incident.id,
          incidentCreated: created || reopened,
        },
      };
    },
  }
);

// ---------------------------------------------------------------------------
// Rule 7 — financial close
// ---------------------------------------------------------------------------

export interface FinancialCloseData {
  caseId: string;
  outcome: 'not_open' | 'not_due' | 'closed';
  completedWorkItemIds: string[];
  stepCompleted: boolean;
}

const CLOSED_STEP_STATUSES = ['done', 'skipped', 'cancelled', 'failed'];

registerCommand<z.output<typeof emptySchema>, FinancialCloseData>(
  SUPERVISOR_COMMANDS.financialClose,
  {
    ...systemOnly,
    schema: emptySchema,
    aggregate: versionedAggregate('operational_case', 'operationalCase'),
    async handler(tx, cmd, ctx) {
      const caseId = cmd.aggregate.id;
      const opCase = await tx.operationalCase.findUnique({ where: { id: caseId } });
      if (!opCase) throw new OperationsError('not_found', 'No se encontró el expediente');
      const base: FinancialCloseData = {
        caseId,
        outcome: 'not_open',
        completedWorkItemIds: [],
        stepCompleted: false,
      };
      if (!OPEN_CASES.includes(opCase.status as (typeof OPEN_CASES)[number])) return { data: base };

      const salesOrder = opCase.zohoSalesOrderId
        ? await tx.salesOrder.findUnique({
            where: { zohoSalesOrderId: opCase.zohoSalesOrderId },
            select: {
              status: true,
              invoicedStatus: true,
              paidStatus: true,
              salesOrderNumber: true,
              total: true,
              balance: true,
            },
          })
        : null;
      const step = await tx.caseStep.findFirst({
        where: { caseId, stepKey: FINANCIAL_CLOSE_STEP_KEY },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const stepItems = step
        ? await tx.workItem.findMany({
            where: { stepId: step.id, status: { in: OPEN_WORK } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : [];
      const openTotal = await tx.workItem.count({ where: { caseId, status: { in: OPEN_WORK } } });
      const due = isFinancialCloseDue({
        caseStatus: opCase.status,
        financialStepStatus: step?.status ?? null,
        otherOpenWorkItems: openTotal - stepItems.filter((w) => w.caseId === caseId).length,
        salesOrder,
      });
      if (!due || !salesOrder) return { data: { ...base, outcome: 'not_due' } };

      const evidence = {
        source: 'zoho_sales_order',
        salesOrderNumber: salesOrder.salesOrderNumber,
        invoicedStatus: salesOrder.invoicedStatus,
        paidStatus: salesOrder.paidStatus,
        total: salesOrder.total?.toString() ?? null,
        balance: salesOrder.balance?.toString() ?? null,
        closedBy: SUPERVISOR_ACTOR_ID,
        at: ctx.now.toISOString(),
      };
      const completedWorkItemIds: string[] = [];
      for (const item of stepItems) {
        await completeWorkItemInTx(
          tx,
          item,
          { result: { financialClose: evidence }, skipEvidenceCheck: true },
          {}
        );
        completedWorkItemIds.push(item.id);
      }

      let stepCompleted = false;
      if (step) {
        const fresh = await tx.caseStep.findUnique({ where: { id: step.id } });
        if (fresh && !CLOSED_STEP_STATUSES.includes(fresh.status)) {
          await tx.caseStep.update({
            where: { id: step.id },
            data: {
              status: 'done',
              completedAt: ctx.now,
              exitEvidence: toOperationalJson(evidence),
              version: { increment: 1 },
            },
          });
          stepCompleted = true;
          ctx.emit(
            OPS_EVENTS.step.completed,
            { stepId: step.id, stepKey: step.stepKey, auto: true, evidence },
            { caseId, areaKey: step.areaKey, objectType: 'case_step', objectId: step.id }
          );
        }
      }

      // A work item hook of the case engine may already have closed the case.
      const current = await tx.operationalCase.findUnique({ where: { id: caseId } });
      if (current && OPEN_CASES.includes(current.status as (typeof OPEN_CASES)[number])) {
        await tx.operationalCase.update({
          where: { id: caseId },
          data: {
            status: 'closed',
            phase: 'closing',
            closedAt: ctx.now,
            closeReason: 'financial_close',
            lastActivityAt: latestOf(current.lastActivityAt, ctx.now),
          },
        });
        ctx.emit(
          OPS_EVENTS.case.statusChanged,
          { caseId, from: current.status, to: 'closed', reason: 'financial_close' },
          { caseId, objectType: 'operational_case', objectId: caseId }
        );
      }
      ctx.emit(
        OPS_EVENTS.case.financialClosed,
        { caseId, caseNumber: opCase.caseNumber, ...evidence },
        { caseId, areaKey: 'contabilidad', objectType: 'operational_case', objectId: caseId }
      );
      if (await isActiveHumanUser(tx, opCase.ownerUserId)) {
        ctx.notify({
          userId: opCase.ownerUserId,
          category: 'ops_workitem',
          type: 'ops_case_closed',
          title: `Expediente cerrado: ${opCase.caseNumber}`,
          body: 'La orden de venta quedó facturada y pagada en Zoho',
          url: caseUrl(caseId),
          entityType: 'operational_case',
          entityId: caseId,
        });
      }
      return { data: { caseId, outcome: 'closed', completedWorkItemIds, stepCompleted } };
    },
  }
);

// ---------------------------------------------------------------------------
// Rule 8 — expired business approvals
// ---------------------------------------------------------------------------

export interface ApprovalExpiredData {
  approvalRequestId: string;
  outcome: 'not_found' | 'closed' | 'not_due' | 'expired';
  cancelledWorkItemIds: string[];
}

registerCommand<z.output<typeof emptySchema>, ApprovalExpiredData>(
  SUPERVISOR_COMMANDS.approvalExpired,
  {
    ...systemOnly,
    schema: emptySchema,
    aggregate: versionedAggregate('approval_request', 'approvalRequest'),
    async handler(tx, cmd) {
      const expired = await expireApprovalInTx(tx, cmd.aggregate.id);
      return {
        data: {
          approvalRequestId: cmd.aggregate.id,
          outcome: expired.outcome,
          cancelledWorkItemIds: expired.cancelledWorkItemIds,
        },
      };
    },
  }
);

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

export interface SupervisorTickOptions {
  now?: Date;
  /** Candidates per rule (default and maximum 200). */
  limit?: number;
  /** Stops between commands when aborted (job timeout). */
  signal?: AbortSignal;
}

export interface SupervisorTickSummary {
  skipped: 'core_disabled' | 'supervisor_disabled' | null;
  aborted: boolean;
  startedAt: string;
  durationMs: number;
  counters: SupervisorCounters;
  totals: ReturnType<typeof summarizeSupervisorCounters>;
  tickEventId: string | null;
}

interface TickContext {
  /** Instant of the tick: queries and pure rules. */
  now: Date;
  /**
   * Clock of each command: the wall clock (a tick can last minutes, and the
   * ledger, `lastActivityAt` and event times must not go back to its start),
   * or the injected `now` in tests.
   */
  commandNow: () => Date;
  limit: number;
  config: OperationsConfig;
  counters: SupervisorCounters;
  signal?: AbortSignal;
  aborted: boolean;
}

/** Never moves an activity timestamp backwards (the row is read under the command's lock). */
function latestOf(current: Date, candidate: Date): Date {
  return candidate.getTime() > current.getTime() ? candidate : current;
}

class TickAborted extends Error {
  constructor() {
    super('Supervisor tick aborted');
    this.name = 'TickAborted';
  }
}

function assertNotAborted(tick: TickContext): void {
  if (tick.signal?.aborted) {
    tick.aborted = true;
    throw new TickAborted();
  }
}

async function runSystemCommand<D>(
  tick: TickContext,
  input: {
    kind: SupervisorFindingKind;
    type: string;
    aggregate: { type: string; id: string };
    bucket: string;
    payload: unknown;
  }
): Promise<CommandResult<D>> {
  assertNotAborted(tick);
  return executeCommand<D>(
    {
      commandId: supervisorCommandId(input.kind, input.aggregate.id, input.bucket),
      type: input.type,
      actor: SUPERVISOR_ACTOR,
      aggregate: input.aggregate,
      payload: input.payload,
    },
    null,
    { now: tick.commandNow() }
  );
}

/** Counts a command result; `classify` inspects fresh (non-replayed) completed results. */
function track<D>(
  counters: SupervisorRuleCounters,
  result: CommandResult<D>,
  classify: (data: D) => { action?: boolean; incident?: boolean }
): void {
  if (result.status === 'rejected') {
    counters.rejected += 1;
    return;
  }
  if (result.replayed || result.data === undefined) {
    counters.skipped += 1;
    return;
  }
  const verdict = classify(result.data);
  if (verdict.action) counters.actions += 1;
  if (verdict.incident) counters.incidents += 1;
  if (!verdict.action && !verdict.incident) counters.skipped += 1;
}

/** Runs `fn` per candidate; an unexpected error is counted and logged, the rule goes on. */
async function eachCandidate<T>(
  tick: TickContext,
  rule: keyof SupervisorCounters,
  candidates: T[],
  describe: (candidate: T) => string,
  fn: (candidate: T) => Promise<void>
): Promise<void> {
  for (const candidate of candidates) {
    try {
      await fn(candidate);
    } catch (err) {
      if (err instanceof TickAborted) throw err;
      tick.counters[rule].errors += 1;
      log('candidate_failed', { rule, candidate: describe(candidate), message: errorText(err) });
    }
  }
}

interface OrphanRow {
  id: string;
  version: number;
  lastActivityAt: Date;
  lastWorkItemAt: Date | null;
}

async function ruleOrphanCases(tick: TickContext): Promise<void> {
  const counters = tick.counters.orphanCases;
  const graceCutoff = new Date(tick.now.getTime() - ORPHAN_GRACE_MINUTES * MINUTE_MS);
  const rows = await prisma.$queryRaw<OrphanRow[]>`
    SELECT c."id", c."version", c."lastActivityAt",
      (SELECT MAX(w."updatedAt") FROM "WorkItem" w WHERE w."caseId" = c."id") AS "lastWorkItemAt"
    FROM "OperationalCase" c
    WHERE c."status" IN (${Prisma.join(OPEN_CASES)})
      AND c."lastActivityAt" <= ${graceCutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "WorkItem" w
        WHERE w."caseId" = c."id" AND w."status" IN (${Prisma.join(OPEN_WORK)})
      )
      AND NOT EXISTS (
        SELECT 1 FROM "CaseStep" s
        WHERE s."caseId" = c."id" AND s."status" IN ('active', 'waiting')
      )
    ORDER BY c."lastActivityAt" ASC
    LIMIT ${tick.limit}
  `;
  counters.checked += rows.length;
  await eachCandidate(
    tick,
    'orphanCases',
    rows,
    (r) => r.id,
    async (row) => {
      const result = await runSystemCommand<OrphanCaseData>(tick, {
        kind: 'orphan',
        type: SUPERVISOR_COMMANDS.orphanCase,
        aggregate: { type: 'operational_case', id: row.id },
        bucket: orphanBucket(row),
        payload: { caseId: row.id },
      });
      track(counters, result, (data) => ({
        action: data.outcome === 'advanced' || Boolean(data.workItemId),
        incident: data.incidentCreated,
      }));
    }
  );
}

async function ruleOverdueWorkItems(tick: TickContext): Promise<void> {
  const counters = tick.counters.overdueWorkItems;
  const { escalation } = tick.config;
  const nowMs = tick.now.getTime();
  // Only items whose lateness already reaches a level they do not have yet.
  const levelConditions: Prisma.WorkItemWhereInput[] = escalationThresholds(escalation).map(
    (minutes, level) => ({
      AND: [
        {
          dueAt: minutes > 0 ? { lte: new Date(nowMs - minutes * MINUTE_MS) } : { lt: tick.now },
        },
        { OR: [{ escalatedAt: null }, { escalationLevel: { lt: level } }] },
      ],
    })
  );
  const items = await prisma.workItem.findMany({
    where: {
      status: { in: OPEN_WORK },
      AND: [
        { OR: levelConditions },
        {
          OR: [
            { status: { not: 'waiting' } },
            { waitUntil: null },
            { waitUntil: { lte: tick.now } },
          ],
        },
      ],
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: tick.limit,
    select: {
      id: true,
      status: true,
      dueAt: true,
      escalationLevel: true,
      escalatedAt: true,
      waitUntil: true,
    },
  });
  counters.checked += items.length;
  await eachCandidate(
    tick,
    'overdueWorkItems',
    items,
    (i) => i.id,
    async (item) => {
      const level = overdueEscalationLevel(item, escalation, tick.now);
      if (level === null) {
        counters.skipped += 1;
        return;
      }
      const result = await runSystemCommand<WorkItemEscalationData>(tick, {
        kind: 'overdue',
        type: WORK_ITEM_COMMANDS.escalate,
        aggregate: { type: WORK_ITEM_AGGREGATE_TYPE, id: item.id },
        bucket: `l${level}-d${item.dueAt.getTime()}`,
        payload: { level, reason: 'overdue' },
      });
      track(counters, result, (data) => ({
        action: data.applied,
        incident: data.applied && data.step === 'incident' && Boolean(data.incidentId),
      }));
    }
  );
}

async function ruleStaleSyncs(tick: TickContext): Promise<void> {
  const counters = tick.counters.staleSyncs;
  if (!tick.config.flags.logistics) return;
  const staleMinutes = tick.config.externalSyncStaleMinutes;
  const orders = await prisma.deliveryOrder.findMany({
    where: {
      zohoSyncState: { in: [...WATCHED_SYNC_STATES] },
      updatedAt: { lte: new Date(tick.now.getTime() - staleMinutes * MINUTE_MS) },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: tick.limit,
    select: {
      id: true,
      zohoSyncState: true,
      zohoLastAttemptAt: true,
      updatedAt: true,
      version: true,
    },
  });
  counters.checked += orders.length;
  await eachCandidate(
    tick,
    'staleSyncs',
    orders,
    (o) => o.id,
    async (order) => {
      const staleness = evaluateSyncStaleness(order, tick.now, staleMinutes);
      if (!staleness.requeueDue || !staleness.requeueBucket) {
        counters.skipped += 1;
        return;
      }
      const result = await runSystemCommand<StaleSyncData>(tick, {
        kind: 'sync_stale',
        type: SUPERVISOR_COMMANDS.staleSync,
        aggregate: { type: 'delivery_order', id: order.id },
        bucket: staleness.requeueBucket,
        payload: { deliveryOrderId: order.id },
      });
      track(counters, result, (data) => ({
        action: data.outcome === 'requeued',
        incident: data.incidentCreated,
      }));
    }
  );
}

async function ruleOverdueRequests(tick: TickContext): Promise<void> {
  const counters = tick.counters.overdueRequests;
  const requests = await prisma.areaRequest.findMany({
    where: {
      status: { in: ['sent', 'acknowledged', 'accepted', 'blocked'] },
      dueAt: { lt: tick.now },
    },
    // Newest overdue first: the ones not flagged yet; older ones are already escalating.
    orderBy: [{ dueAt: 'desc' }, { id: 'asc' }],
    take: tick.limit,
    select: { id: true, status: true, dueAt: true },
  });
  counters.checked += requests.length;
  await eachCandidate(
    tick,
    'overdueRequests',
    requests,
    (r) => r.id,
    async (request) => {
      const level = requestOverdueLevel(request, tick.config.escalation, tick.now);
      if (level === null) {
        counters.skipped += 1;
        return;
      }
      const result = await runSystemCommand<RequestOverdueData>(tick, {
        kind: 'request_overdue',
        type: SUPERVISOR_COMMANDS.requestOverdue,
        aggregate: { type: 'area_request', id: request.id },
        bucket: `l${level}-d${request.dueAt.getTime()}`,
        payload: { requestId: request.id },
      });
      track(counters, result, (data) => ({
        action: data.outcome === 'flagged' || data.outcome === 'escalated',
        incident: Boolean(data.incidentId),
      }));
    }
  );
}

async function ruleStaleReservations(tick: TickContext): Promise<void> {
  if (!tick.config.flags.inventory) return;
  const counters = tick.counters.staleReservations;
  const alertDays = tick.config.reservationAlertDays;
  const openAlerts = await prisma.workItem.findMany({
    where: { objectType: RESERVATION_ALERT_OBJECT_TYPE, status: { in: OPEN_WORK } },
    select: { objectId: true },
    take: OPEN_ALERT_SCAN_LIMIT,
  });
  const alerted = [
    ...new Set(openAlerts.map((a) => a.objectId).filter((id): id is string => !!id)),
  ];
  const reservations = await prisma.stockReservation.findMany({
    where: {
      status: 'active',
      createdAt: { lte: new Date(tick.now.getTime() - alertDays * DAY_MS) },
      ...(alerted.length > 0 ? { caseId: { notIn: alerted } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: tick.limit,
    select: { id: true, caseId: true, createdAt: true },
  });
  const oldestByCase = new Map<string, Date>();
  for (const reservation of reservations) {
    if (!oldestByCase.has(reservation.caseId)) {
      oldestByCase.set(reservation.caseId, reservation.createdAt);
    }
  }
  const caseIds = [...oldestByCase.keys()];
  const prepared =
    caseIds.length > 0
      ? await prisma.caseStep.findMany({
          where: {
            caseId: { in: caseIds },
            stepKey: PREPARE_ORDER_STEP_KEY,
            status: { in: ['done', 'skipped'] },
          },
          select: { caseId: true },
        })
      : [];
  const preparedIds = new Set(prepared.map((p) => p.caseId));
  counters.checked += caseIds.length;
  counters.skipped += caseIds.filter((id) => preparedIds.has(id)).length;
  const pending = caseIds.filter((id) => !preparedIds.has(id));
  await eachCandidate(
    tick,
    'staleReservations',
    pending,
    (id) => id,
    async (caseId) => {
      const result = await runSystemCommand<StaleReservationsData>(tick, {
        kind: 'stale_reservation',
        type: SUPERVISOR_COMMANDS.staleReservations,
        aggregate: { type: 'operational_case', id: caseId },
        bucket: reservationAlertBucket(oldestByCase.get(caseId)!, tick.now, alertDays),
        payload: { caseId },
      });
      track(counters, result, (data) => ({ action: data.outcome === 'alerted' }));
    }
  );
}

async function ruleLegacyClaims(tick: TickContext): Promise<void> {
  if (!tick.config.flags.inventory) return;
  assertNotAborted(tick);
  const counters = tick.counters.legacyClaims;
  const outcome = await expireDueLegacyClaims({ now: tick.now, limit: tick.limit });
  counters.checked += outcome.checked;
  counters.actions += outcome.expired;
  counters.rejected += outcome.rejected;
  counters.skipped += Math.max(0, outcome.checked - outcome.expired - outcome.rejected);
}

async function absentUserIds(ownerIds: string[]): Promise<string[]> {
  if (ownerIds.length === 0) return [];
  const active = await prisma.user.findMany({
    where: { id: { in: ownerIds }, isActive: true },
    select: { id: true },
  });
  const activeIds = new Set(active.map((u) => u.id));
  return ownerIds.filter((id) => !activeIds.has(id));
}

async function ruleAbsentOwners(tick: TickContext): Promise<void> {
  const counters = tick.counters.absentOwners;

  const itemOwners = await prisma.workItem.groupBy({
    by: ['ownerUserId'],
    where: { status: { in: OPEN_WORK } },
    orderBy: { ownerUserId: 'asc' },
    take: OWNER_SCAN_LIMIT,
  });
  const absentItemOwners = await absentUserIds(itemOwners.map((g) => g.ownerUserId));
  const items =
    absentItemOwners.length > 0
      ? await prisma.workItem.findMany({
          where: { status: { in: OPEN_WORK }, ownerUserId: { in: absentItemOwners } },
          orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
          take: tick.limit,
          select: { id: true, ownerUserId: true },
        })
      : [];
  counters.checked += items.length;
  await eachCandidate(
    tick,
    'absentOwners',
    items,
    (i) => i.id,
    async (item) => {
      const result = await runSystemCommand<OwnerAbsentData>(tick, {
        kind: 'owner_absent',
        type: SUPERVISOR_COMMANDS.workItemOwnerAbsent,
        aggregate: { type: WORK_ITEM_AGGREGATE_TYPE, id: item.id },
        bucket: item.ownerUserId,
        payload: {},
      });
      track(counters, result, (data) => ({
        action: data.outcome === 'reassigned',
        incident: data.incidentCreated,
      }));
    }
  );

  const caseOwners = await prisma.operationalCase.groupBy({
    by: ['ownerUserId'],
    where: { status: { in: OPEN_CASES } },
    orderBy: { ownerUserId: 'asc' },
    take: OWNER_SCAN_LIMIT,
  });
  const absentCaseOwners = await absentUserIds(caseOwners.map((g) => g.ownerUserId));
  const cases =
    absentCaseOwners.length > 0
      ? await prisma.operationalCase.findMany({
          where: { status: { in: OPEN_CASES }, ownerUserId: { in: absentCaseOwners } },
          orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }],
          take: tick.limit,
          select: { id: true, ownerUserId: true },
        })
      : [];
  counters.checked += cases.length;
  await eachCandidate(
    tick,
    'absentOwners',
    cases,
    (c) => c.id,
    async (opCase) => {
      const result = await runSystemCommand<OwnerAbsentData>(tick, {
        kind: 'case_owner_absent',
        type: SUPERVISOR_COMMANDS.caseOwnerAbsent,
        aggregate: { type: 'operational_case', id: opCase.id },
        bucket: opCase.ownerUserId,
        payload: {},
      });
      track(counters, result, (data) => ({
        action: data.outcome === 'reassigned',
        incident: data.incidentCreated,
      }));
    }
  );
}

interface FinancialCloseRow {
  id: string;
  version: number;
}

async function ruleFinancialClose(tick: TickContext): Promise<void> {
  const counters = tick.counters.financialClose;
  const rows = await prisma.$queryRaw<FinancialCloseRow[]>`
    SELECT c."id", c."version"
    FROM "OperationalCase" c
    JOIN "SalesOrder" so ON so."zohoSalesOrderId" = c."zohoSalesOrderId"
    WHERE c."status" IN (${Prisma.join(OPEN_CASES)})
      AND LOWER(COALESCE(so."invoicedStatus", '')) = 'invoiced'
      AND LOWER(COALESCE(so."paidStatus", '')) = 'paid'
      AND LOWER(COALESCE(so."status", '')) <> 'void'
      AND (
        c."status" = 'ready_to_close'
        OR EXISTS (
          SELECT 1 FROM "CaseStep" s
          WHERE s."caseId" = c."id"
            AND s."stepKey" = ${FINANCIAL_CLOSE_STEP_KEY}
            AND s."status" IN ('ready', 'active', 'waiting')
        )
      )
    ORDER BY c."lastActivityAt" ASC
    LIMIT ${tick.limit}
  `;
  counters.checked += rows.length;
  // Re-evaluated at most once per hour per case version (e.g. while other work is still open).
  const hour = Math.floor(tick.now.getTime() / HOUR_MS);
  await eachCandidate(
    tick,
    'financialClose',
    rows,
    (r) => r.id,
    async (row) => {
      const result = await runSystemCommand<FinancialCloseData>(tick, {
        kind: 'financial_close',
        type: SUPERVISOR_COMMANDS.financialClose,
        aggregate: { type: 'operational_case', id: row.id },
        bucket: `v${row.version}-h${hour}`,
        payload: {},
      });
      track(counters, result, (data) => ({ action: data.outcome === 'closed' }));
    }
  );
}

async function ruleExpiredApprovals(tick: TickContext): Promise<void> {
  const counters = tick.counters.expiredApprovals;
  const rows = await prisma.approvalRequest.findMany({
    where: { status: 'pending', expiresAt: { lte: tick.now } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    take: tick.limit,
    select: { id: true, status: true, expiresAt: true },
  });
  counters.checked += rows.length;
  await eachCandidate(
    tick,
    'expiredApprovals',
    rows,
    (r) => r.id,
    async (row) => {
      if (!row.expiresAt || !isApprovalExpiryDue(row, tick.now)) {
        counters.skipped += 1;
        return;
      }
      const result = await runSystemCommand<ApprovalExpiredData>(tick, {
        kind: 'approval_expired',
        type: SUPERVISOR_COMMANDS.approvalExpired,
        aggregate: { type: 'approval_request', id: row.id },
        bucket: `e${row.expiresAt.getTime()}`,
        payload: {},
      });
      track(counters, result, (data) => ({ action: data.outcome === 'expired' }));
    }
  );
}

const RULES: Array<{ key: keyof SupervisorCounters; run: (tick: TickContext) => Promise<void> }> = [
  { key: 'orphanCases', run: ruleOrphanCases },
  { key: 'overdueWorkItems', run: ruleOverdueWorkItems },
  { key: 'staleSyncs', run: ruleStaleSyncs },
  { key: 'overdueRequests', run: ruleOverdueRequests },
  { key: 'staleReservations', run: ruleStaleReservations },
  { key: 'legacyClaims', run: ruleLegacyClaims },
  { key: 'absentOwners', run: ruleAbsentOwners },
  { key: 'financialClose', run: ruleFinancialClose },
  { key: 'expiredApprovals', run: ruleExpiredApprovals },
];

async function recordTick(
  tick: TickContext,
  startedAt: Date,
  durationMs: number
): Promise<string | null> {
  const totals = summarizeSupervisorCounters(tick.counters);
  let tickEventId: string | null = null;
  try {
    const [event] = await recordOperationalEvents([
      {
        type: OPS_EVENTS.supervisor.tick,
        actorType: 'system',
        actorId: SUPERVISOR_ACTOR_ID,
        occurredAt: tick.now,
        payload: {
          startedAt: startedAt.toISOString(),
          durationMs,
          aborted: tick.aborted,
          totals,
          counters: tick.counters,
        },
      },
    ]);
    tickEventId = event?.id ?? null;
  } catch (err) {
    log('tick_event_failed', { message: errorText(err) });
  }
  const dimension: UsageDimension = SUPERVISOR_USAGE_DIMENSION;
  const meters: Array<[string, string, number]> = [
    ['tick', 'ms', durationMs],
    ['findings', 'candidates', totals.checked],
    ['actions', 'commands', totals.actions],
    ['incidents', 'incidents', totals.incidents],
    ['errors', 'errors', totals.errors + totals.rejected],
  ];
  for (const [key, unit, amount] of meters) {
    await recordUsage(dimension, key, unit, amount).catch((err) =>
      log('usage_failed', { key, message: errorText(err) })
    );
  }
  return tickEventId;
}

/** One supervisor pass over every rule (see the module comment). */
export async function runSupervisorTick(
  options: SupervisorTickOptions = {}
): Promise<SupervisorTickSummary> {
  const startedAt = new Date();
  const now = options.now ?? startedAt;
  const config = await getOperationsConfig();
  const counters = emptySupervisorCounters();
  const skipped = !config.isEnabled
    ? ('core_disabled' as const)
    : !config.flags.supervisor
      ? ('supervisor_disabled' as const)
      : null;
  if (skipped) {
    log('tick_skipped', { reason: skipped });
    return {
      skipped,
      aborted: false,
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      counters,
      totals: summarizeSupervisorCounters(counters),
      tickEventId: null,
    };
  }

  const tick: TickContext = {
    now,
    commandNow: options.now ? () => now : () => new Date(),
    limit: Math.min(
      Math.max(1, Math.floor(options.limit ?? SUPERVISOR_BATCH_SIZE)),
      SUPERVISOR_BATCH_SIZE
    ),
    config,
    counters,
    signal: options.signal,
    aborted: false,
  };
  for (const rule of RULES) {
    try {
      await rule.run(tick);
    } catch (err) {
      if (err instanceof TickAborted) break;
      counters[rule.key].errors += 1;
      log('rule_failed', { rule: rule.key, message: errorText(err) });
    }
  }

  const durationMs = Date.now() - startedAt.getTime();
  const tickEventId = await recordTick(tick, startedAt, durationMs);
  const totals = summarizeSupervisorCounters(counters);
  log('tick_done', { ...totals, aborted: tick.aborted, durationMs, tickEventId });
  return {
    skipped: null,
    aborted: tick.aborted,
    startedAt: startedAt.toISOString(),
    durationMs,
    counters,
    totals,
    tickEventId,
  };
}
