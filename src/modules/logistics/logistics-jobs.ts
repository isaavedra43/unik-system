import { ZodError } from 'zod';
import { prisma } from '@/lib/prisma';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import { refreshPackageOnDemand } from '@/modules/integrations/zoho/packages-shipment-sweep';
import {
  enqueueJob,
  JOB_PRIORITY,
  registerJobHandler,
  type JobContext,
} from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { getOperationsConfig, isOpsFlagEnabled } from '@/modules/operations/operations-config';
import type { CommandResult } from '@/modules/operations/commands';
import {
  cancelPackageShipment,
  markPackageDelivered,
  PackageShippingError,
  shipPackage,
} from '@/modules/packages/packages-shipping-service';
import { findLinkablePackage, isDeliveredPackage } from './delivery-service';
import { mexicoCityDay } from './fleet-rules';
import { executeLogisticsSystemCommand } from './logistics-commands';
import { readShipmentInput } from './logistics-helpers';
import {
  sameShipmentReadback,
  toShipmentReadback,
  type ReconcileShipmentResult,
} from './transport-service';

function asRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
import {
  LOGISTICS_COMMANDS,
  LOGISTICS_JOB_TYPES,
  LOGISTICS_RECONCILE_EVERY_MS,
  LOGISTICS_SYSTEM_ACTOR_ID,
  LOGISTICS_ZOHO_MAX_ATTEMPTS,
  zohoCancelKey,
  zohoDeliveredKey,
} from './types';
import {
  failedZohoOperation,
  pendingZohoOperation,
  readbackSource,
  type ReadbackSource,
  type ZohoOperation,
} from './zoho-sync-state';

/**
 * Outbox handlers that mirror logistics in Zoho, plus the recurring sweep.
 *
 * - `ops.zoho.ship_package` → `shipPackage` (create/update the shipment order;
 *   the service re-reads the package or patches it locally) → system command
 *   `delivery.reconcile_shipment` with the package row as read-back.
 * - `ops.zoho.mark_delivered` → `markPackageDelivered` (or `shipPackage` with
 *   `delivered: true` when the shipment order does not exist yet).
 * - `ops.zoho.cancel_shipment` → `cancelPackageShipment`.
 * - `logistics.zoho_reconcile` (every 30 min): re-enqueues writes owed without a
 *   live job, re-reads `written | readback_mismatch | failed` orders and links
 *   packages that appeared in Zoho for orders waiting for one.
 *
 * Zoho errors are retried by the queue (5 attempts, 1-4 minute backoff);
 * validation or "not found / conflict" errors of the shipping service are
 * permanent. On the last attempt (or a permanent error) the system command
 * `delivery.zoho_write_failed` marks the order `failed` and opens a
 * `zoho_failure` incident with a work item for Logística.
 *
 * The package services need an actor only for their audit log
 * (`AuditLog.actorUserId` has no foreign key): the user who asked for the
 * write, or `system:logistics`. With `ZOHO_BOOKS_MOCK=true` they only update
 * the package row, which then acts as Zoho's read-back.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'logistics-jobs', event, ...extra }));

const RECONCILE_BATCH = 100;

export interface ShipPackageJobPayload {
  deliveryOrderId: string;
  requestKey: string;
}

export interface ZohoDeliveryJobPayload {
  deliveryOrderId: string;
  requestedByUserId?: string | null;
}

export type ZohoJobOutcome = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

/** Zoho answers that retrying may fix (session renewal, timeout, rate limit). */
const TRANSIENT_ZOHO_STATUSES = [401, 408, 429];

/**
 * Validation, "not found / conflict" of the shipping service and 4xx rejections
 * of Zoho itself (e.g. the package was already shipped, an invalid field) are
 * permanent: retrying only repeats the call.
 */
export function isPermanentZohoError(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  if (!(error instanceof PackageShippingError)) return false;
  if (error.status < 500) return true;
  const upstream = error.upstreamStatus;
  return (
    typeof upstream === 'number' &&
    upstream >= 400 &&
    upstream < 500 &&
    !TRANSIENT_ZOHO_STATUSES.includes(upstream)
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return `Datos del embarque inválidos: ${error.issues.map((i) => i.message).join('; ')}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function zohoActor(userId: string | null | undefined) {
  return { id: userId || LOGISTICS_SYSTEM_ACTOR_ID };
}

async function hasLiveJob(dedupeKey: string): Promise<boolean> {
  const job = await prisma.backgroundJob.findFirst({
    where: { dedupeKey, status: { in: ['pending', 'running'] } },
    select: { id: true },
  });
  return Boolean(job);
}

function assertAccepted(result: CommandResult, context: string): void {
  if (result.status === 'rejected') {
    throw new Error(`${context}: ${result.errorCode ?? 'rejected'} ${result.message ?? ''}`.trim());
  }
}

const CONFIRM_ATTEMPTS = 3;

/**
 * Records in UNIK a write Zoho already accepted. A lost concurrency race is
 * retried here under the same command id (the ledger keeps those losses
 * retryable) instead of throwing, which would make the queue repeat the Zoho
 * write on the next attempt.
 */
async function confirmZohoWrite<D = unknown>(
  type: string,
  deliveryOrderId: string,
  payload: Record<string, unknown>,
  commandId: string,
  context: string
): Promise<CommandResult<D>> {
  let result = await executeLogisticsSystemCommand<D>(type, deliveryOrderId, payload, commandId);
  for (
    let attempt = 1;
    attempt < CONFIRM_ATTEMPTS &&
    result.status === 'rejected' &&
    result.errorCode === 'concurrency_conflict';
    attempt++
  ) {
    log('zoho_confirm_retry', { deliveryOrderId, commandId, attempt });
    result = await executeLogisticsSystemCommand<D>(type, deliveryOrderId, payload, commandId);
  }
  assertAccepted(result, context);
  return result;
}

async function reportFailure(
  deliveryOrderId: string,
  operation: ZohoOperation,
  requestKey: string,
  message: string,
  attempts: number
): Promise<void> {
  const result = await executeLogisticsSystemCommand(
    LOGISTICS_COMMANDS.deliveryZohoWriteFailed,
    deliveryOrderId,
    { deliveryOrderId, operation, requestKey, error: message.slice(0, 2000), attempts },
    `${requestKey}:failed:${attempts}`
  );
  assertAccepted(result, 'zoho_write_failed');
  log('zoho_write_failed', { deliveryOrderId, operation, requestKey, attempts, error: message });
}

/**
 * Transient error before the last attempt → record `zohoError` and re-throw so
 * the queue retries. Last attempt or permanent error → failure command.
 */
async function handleWriteError(
  job: JobContext<unknown>,
  deliveryOrderId: string,
  operation: ZohoOperation,
  requestKey: string,
  error: unknown
): Promise<ZohoJobOutcome> {
  const message = errorMessage(error);
  const permanent = isPermanentZohoError(error);
  const exhausted = job.attempt >= LOGISTICS_ZOHO_MAX_ATTEMPTS;
  if (!permanent && !exhausted) {
    await prisma.deliveryOrder.update({
      where: { id: deliveryOrderId },
      data: { zohoError: message.slice(0, 1000) },
    });
    log('zoho_write_retry', { deliveryOrderId, operation, attempt: job.attempt, error: message });
    throw error instanceof Error ? error : new Error(message);
  }
  await reportFailure(deliveryOrderId, operation, requestKey, message, job.attempt);
  if (permanent) return { failed: true, permanent: true, error: message };
  throw error instanceof Error ? error : new Error(message);
}

// ---------------------------------------------------------------------------
// ops.zoho.ship_package
// ---------------------------------------------------------------------------

export async function runShipPackageJob(
  job: JobContext<ShipPackageJobPayload>
): Promise<ZohoJobOutcome> {
  const { deliveryOrderId, requestKey } = job.payload ?? ({} as ShipPackageJobPayload);
  if (!deliveryOrderId || !requestKey) return { skipped: 'invalid_payload' };
  if (!(await isOpsFlagEnabled('logistics'))) return { skipped: 'logistics_disabled' };

  const order = await prisma.deliveryOrder.findUnique({ where: { id: deliveryOrderId } });
  if (!order) return { skipped: 'not_found' };
  const shipment = readShipmentInput(order.shipmentInput);
  if (order.status === 'cancelled' || !shipment || shipment.requestKey !== requestKey) {
    return { skipped: 'superseded' };
  }
  if (order.zohoSyncState !== 'pending_write') return { skipped: `state:${order.zohoSyncState}` };
  if (!order.packageId) {
    await reportFailure(
      order.id,
      'ship',
      requestKey,
      'La entrega no tiene paquete de Zoho',
      job.attempt
    );
    return { failed: true, permanent: true };
  }

  // groupKey does not serialize the queue: an older write of the same case still running
  // in Zoho goes first, so a later assignment is never overwritten by an earlier one.
  const own = await prisma.backgroundJob.findUnique({
    where: { id: job.id },
    select: { createdAt: true },
  });
  if (own) {
    const older = await prisma.backgroundJob.findFirst({
      where: {
        type: LOGISTICS_JOB_TYPES.shipPackage,
        groupKey: `case:${order.caseId}`,
        status: 'running',
        id: { not: job.id },
        createdAt: { lt: own.createdAt },
      },
      select: { id: true },
    });
    if (older) {
      throw new Error('Otra escritura del embarque sigue en curso en Zoho; se reintentará');
    }
  }

  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { zohoLastAttemptAt: new Date() },
  });
  const writeStartedAt = new Date();
  try {
    await shipPackage(zohoActor(shipment.requestedByUserId), order.packageId, {
      carrier: shipment.carrier,
      date: shipment.shipmentDate,
      trackingNumber: shipment.trackingNumber ?? '',
    });
  } catch (error) {
    return handleWriteError(job as JobContext<unknown>, order.id, 'ship', requestKey, error);
  }

  const pkg = await prisma.package.findUnique({ where: { id: order.packageId } });
  if (!pkg) throw new Error(`Package ${order.packageId} disappeared after the Zoho write`);
  const source = readbackSource({
    mock: isZohoBooksMockEnabled(),
    lastDetailFetchedAt: pkg.lastDetailFetchedAt,
    writeStartedAt,
  });
  const result = await confirmZohoWrite<ReconcileShipmentResult>(
    LOGISTICS_COMMANDS.deliveryReconcileShipment,
    order.id,
    {
      deliveryOrderId: order.id,
      requestKey,
      source,
      readback: toShipmentReadback(pkg, shipment.carrier),
    },
    `${requestKey}:reconcile:${job.attempt}`,
    'reconcile_shipment'
  );
  log('zoho_ship_reconciled', {
    deliveryOrderId: order.id,
    requestKey,
    source,
    outcome: result.data?.outcome,
  });
  return { outcome: result.data?.outcome ?? null, source };
}

// ---------------------------------------------------------------------------
// ops.zoho.mark_delivered
// ---------------------------------------------------------------------------

export async function runMarkDeliveredJob(
  job: JobContext<ZohoDeliveryJobPayload>
): Promise<ZohoJobOutcome> {
  const { deliveryOrderId, requestedByUserId } = job.payload ?? ({} as ZohoDeliveryJobPayload);
  if (!deliveryOrderId) return { skipped: 'invalid_payload' };
  if (!(await isOpsFlagEnabled('logistics'))) return { skipped: 'logistics_disabled' };

  const order = await prisma.deliveryOrder.findUnique({ where: { id: deliveryOrderId } });
  if (!order) return { skipped: 'not_found' };
  if (
    order.zohoSyncState !== 'delivered_pending_write' ||
    (order.status !== 'delivered' && order.status !== 'partially_delivered')
  ) {
    return { skipped: `state:${order.zohoSyncState}` };
  }
  const requestKey = zohoDeliveredKey(order.id);
  const pkg = order.packageId
    ? await prisma.package.findUnique({
        where: { id: order.packageId },
        select: { id: true, zohoShipmentId: true },
      })
    : null;
  if (!pkg) {
    await reportFailure(
      order.id,
      'mark_delivered',
      requestKey,
      'La entrega no tiene paquete de Zoho',
      job.attempt
    );
    return { failed: true, permanent: true };
  }

  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { zohoLastAttemptAt: new Date() },
  });
  const day = mexicoCityDay(order.deliveredAt ?? new Date());
  const actor = zohoActor(requestedByUserId);
  try {
    if (pkg.zohoShipmentId) {
      await markPackageDelivered(actor, pkg.id, day);
    } else {
      const shipment = readShipmentInput(order.shipmentInput);
      if (!shipment) {
        throw new PackageShippingError(
          'El paquete no tiene orden de envío en Zoho y la entrega no tiene transportista asignado',
          409
        );
      }
      if (await hasLiveJob(shipment.requestKey)) {
        throw new Error('La orden de envío todavía se está escribiendo en Zoho; se reintentará');
      }
      await shipPackage(actor, pkg.id, {
        carrier: shipment.carrier,
        date: shipment.shipmentDate,
        trackingNumber: shipment.trackingNumber ?? '',
        delivered: true,
        deliveryDate: day,
      });
    }
  } catch (error) {
    return handleWriteError(
      job as JobContext<unknown>,
      order.id,
      'mark_delivered',
      requestKey,
      error
    );
  }

  await confirmZohoWrite(
    LOGISTICS_COMMANDS.deliveryZohoDelivered,
    order.id,
    { deliveryOrderId: order.id, source: isZohoBooksMockEnabled() ? 'mock' : 'zoho' },
    `${requestKey}:confirmed`,
    'zoho_delivered'
  );
  log('zoho_delivered_marked', { deliveryOrderId: order.id, day });
  return { delivered: true, day };
}

// ---------------------------------------------------------------------------
// ops.zoho.cancel_shipment
// ---------------------------------------------------------------------------

export async function runCancelShipmentJob(
  job: JobContext<ZohoDeliveryJobPayload>
): Promise<ZohoJobOutcome> {
  const { deliveryOrderId, requestedByUserId } = job.payload ?? ({} as ZohoDeliveryJobPayload);
  if (!deliveryOrderId) return { skipped: 'invalid_payload' };
  if (!(await isOpsFlagEnabled('logistics'))) return { skipped: 'logistics_disabled' };

  const order = await prisma.deliveryOrder.findUnique({ where: { id: deliveryOrderId } });
  if (!order) return { skipped: 'not_found' };
  if (order.status !== 'cancelled' || order.zohoSyncState !== 'pending_write') {
    return { skipped: `state:${order.zohoSyncState}` };
  }
  const requestKey = zohoCancelKey(order.id);
  await prisma.deliveryOrder.update({
    where: { id: order.id },
    data: { zohoLastAttemptAt: new Date() },
  });
  let cancelled = false;
  try {
    const shipment = readShipmentInput(order.shipmentInput);
    if (shipment && (await hasLiveJob(shipment.requestKey))) {
      throw new Error('La orden de envío todavía se está escribiendo en Zoho; se reintentará');
    }
    const pkg = order.packageId
      ? await prisma.package.findUnique({
          where: { id: order.packageId },
          select: { id: true, zohoShipmentId: true },
        })
      : null;
    if (pkg?.zohoShipmentId) {
      await cancelPackageShipment(zohoActor(requestedByUserId), pkg.id);
      cancelled = true;
    }
  } catch (error) {
    return handleWriteError(
      job as JobContext<unknown>,
      order.id,
      'cancel_shipment',
      requestKey,
      error
    );
  }

  await confirmZohoWrite(
    LOGISTICS_COMMANDS.deliveryZohoShipmentCancelled,
    order.id,
    { deliveryOrderId: order.id, source: isZohoBooksMockEnabled() ? 'mock' : 'zoho' },
    `${requestKey}:confirmed`,
    'zoho_shipment_cancelled'
  );
  log('zoho_shipment_cancelled', { deliveryOrderId: order.id, cancelledInZoho: cancelled });
  return { cancelledInZoho: cancelled };
}

// ---------------------------------------------------------------------------
// logistics.zoho_reconcile
// ---------------------------------------------------------------------------

export interface ZohoReconcileSummary {
  requeued: number;
  reread: number;
  confirmed: number;
  conflicts: number;
  linked: number;
  errors: number;
  stoppedByBudget: boolean;
  skipped?: string;
}

function jobFor(
  order: {
    id: string;
    caseId: string;
    status: string;
    zohoSyncState: string;
    shipmentInput: unknown;
  },
  operation: ZohoOperation | null
): { type: string; dedupeKey: string; payload: Record<string, unknown> } | null {
  if (operation === 'mark_delivered') {
    return {
      type: LOGISTICS_JOB_TYPES.markDelivered,
      dedupeKey: zohoDeliveredKey(order.id),
      payload: { deliveryOrderId: order.id },
    };
  }
  if (operation === 'cancel_shipment') {
    return {
      type: LOGISTICS_JOB_TYPES.cancelShipment,
      dedupeKey: zohoCancelKey(order.id),
      payload: { deliveryOrderId: order.id },
    };
  }
  if (operation === 'ship') {
    const shipment = readShipmentInput(order.shipmentInput);
    if (!shipment) return null;
    return {
      type: LOGISTICS_JOB_TYPES.shipPackage,
      dedupeKey: shipment.requestKey,
      payload: { deliveryOrderId: order.id, requestKey: shipment.requestKey },
    };
  }
  return null;
}

export async function runZohoReconcile(
  _job: JobContext<unknown> | null,
  options: { now?: Date } = {}
): Promise<ZohoReconcileSummary> {
  const summary: ZohoReconcileSummary = {
    requeued: 0,
    reread: 0,
    confirmed: 0,
    conflicts: 0,
    linked: 0,
    errors: 0,
    stoppedByBudget: false,
  };
  if (!(await isOpsFlagEnabled('logistics'))) return { ...summary, skipped: 'logistics_disabled' };
  const now = options.now ?? new Date();
  const config = await getOperationsConfig();
  const staleBefore = new Date(now.getTime() - config.externalSyncStaleMinutes * 60_000);
  const bucket = Math.floor(now.getTime() / LOGISTICS_RECONCILE_EVERY_MS);
  const mock = isZohoBooksMockEnabled();

  // 1) Writes owed to Zoho whose job is gone (worker restart, flag toggled…).
  const owed = await prisma.deliveryOrder.findMany({
    where: {
      zohoSyncState: { in: ['pending_write', 'delivered_pending_write'] },
      updatedAt: { lt: staleBefore },
    },
    orderBy: { updatedAt: 'asc' },
    take: RECONCILE_BATCH,
  });
  for (const order of owed) {
    try {
      const job = jobFor(order, pendingZohoOperation(order.status, order.zohoSyncState));
      if (!job) continue;
      const result = await enqueueJob({
        ...job,
        groupKey: `case:${order.caseId}`,
        maxAttempts: LOGISTICS_ZOHO_MAX_ATTEMPTS,
        priority: JOB_PRIORITY.normal,
        createdBy: LOGISTICS_SYSTEM_ACTOR_ID,
      });
      if (!result.deduplicated) summary.requeued += 1;
    } catch (error) {
      summary.errors += 1;
      log('reconcile_requeue_failed', { deliveryOrderId: order.id, error: errorMessage(error) });
    }
  }

  // 2) Re-read from Zoho what is not confirmed.
  const toRead = await prisma.deliveryOrder.findMany({
    where: {
      zohoSyncState: { in: ['written', 'readback_mismatch', 'failed'] },
      packageId: { not: null },
    },
    orderBy: { updatedAt: 'asc' },
    take: RECONCILE_BATCH,
  });
  for (const order of toRead) {
    try {
      const packageId = order.packageId!;
      if (!mock) {
        const refresh = await refreshPackageOnDemand(packageId, { force: true });
        if (refresh.status === 'busy') {
          summary.stoppedByBudget = true;
          break;
        }
        if (refresh.status !== 'refreshed') {
          summary.errors += 1;
          continue;
        }
      }
      const pkg = await prisma.package.findUnique({ where: { id: packageId } });
      if (!pkg) continue;
      summary.reread += 1;
      const source: ReadbackSource = mock ? 'mock' : 'zoho';
      const commandId = `logistics:reconcile:${order.id}:${order.version}:${bucket}`;
      const failed = failedZohoOperation(order.status, order.zohoSyncState);
      let result: CommandResult<ReconcileShipmentResult> | null = null;
      if (failed === 'mark_delivered') {
        if (!isDeliveredPackage(pkg)) continue;
        result = await executeLogisticsSystemCommand(
          LOGISTICS_COMMANDS.deliveryZohoDelivered,
          order.id,
          { deliveryOrderId: order.id, source },
          commandId
        );
      } else if (failed === 'cancel_shipment') {
        if (pkg.zohoShipmentId) continue;
        result = await executeLogisticsSystemCommand(
          LOGISTICS_COMMANDS.deliveryZohoShipmentCancelled,
          order.id,
          { deliveryOrderId: order.id, source },
          commandId
        );
      } else {
        const shipment = readShipmentInput(order.shipmentInput);
        if (!shipment) continue;
        const readback = toShipmentReadback(pkg, shipment.carrier);
        // Nothing new in Zoho: re-running the reconciliation would only bump the
        // order version (stale forms in the PWA) and repeat the decision.
        if (
          order.zohoSyncState === 'readback_mismatch' &&
          sameShipmentReadback(asRecordValue(order.conflictDetail).actual, readback)
        ) {
          continue;
        }
        if (order.zohoSyncState === 'failed' && !readback.zohoShipmentId) continue;
        result = await executeLogisticsSystemCommand(
          LOGISTICS_COMMANDS.deliveryReconcileShipment,
          order.id,
          {
            deliveryOrderId: order.id,
            requestKey: shipment.requestKey,
            source,
            readback,
          },
          commandId
        );
      }
      if (result.status === 'rejected') {
        summary.errors += 1;
        continue;
      }
      if (result.externalSyncStatus === 'confirmed') summary.confirmed += 1;
      if (result.externalSyncStatus === 'conflict') summary.conflicts += 1;
    } catch (error) {
      summary.errors += 1;
      log('reconcile_reread_failed', { deliveryOrderId: order.id, error: errorMessage(error) });
    }
  }

  // 3) Orders waiting for their Zoho package.
  const waiting = await prisma.deliveryOrder.findMany({
    where: { status: 'pending', packageId: null },
    orderBy: { createdAt: 'asc' },
    take: RECONCILE_BATCH,
  });
  if (waiting.length > 0) {
    const cases = await prisma.operationalCase.findMany({
      where: { id: { in: [...new Set(waiting.map((o) => o.caseId))] } },
      select: { id: true, zohoSalesOrderId: true },
    });
    for (const order of waiting) {
      try {
        const zohoSalesOrderId = cases.find((c) => c.id === order.caseId)?.zohoSalesOrderId;
        if (!zohoSalesOrderId) continue;
        const pkg = await findLinkablePackage(prisma, zohoSalesOrderId, {
          allocationIds: order.allocationIds,
          excludeDeliveryOrderId: order.id,
        });
        if (!pkg) continue;
        const result = await executeLogisticsSystemCommand(
          LOGISTICS_COMMANDS.deliveryLinkPackage,
          order.id,
          { deliveryOrderId: order.id, packageId: pkg.id },
          `logistics:link:${order.id}:${order.version}`
        );
        if (result.status !== 'rejected') summary.linked += 1;
        else summary.errors += 1;
      } catch (error) {
        summary.errors += 1;
        log('reconcile_link_failed', { deliveryOrderId: order.id, error: errorMessage(error) });
      }
    }
  }

  log('zoho_reconcile_done', { ...summary, mock });
  return summary;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

type GlobalWithLogisticsJobs = typeof globalThis & { __unikLogisticsJobsRegistered?: boolean };

export function registerLogisticsJobs(): void {
  const scope = globalThis as GlobalWithLogisticsJobs;
  if (scope.__unikLogisticsJobsRegistered) return;
  scope.__unikLogisticsJobsRegistered = true;
  registerJobHandler(LOGISTICS_JOB_TYPES.shipPackage, runShipPackageJob, { timeoutMs: 2 * 60_000 });
  registerJobHandler(LOGISTICS_JOB_TYPES.markDelivered, runMarkDeliveredJob, {
    timeoutMs: 2 * 60_000,
  });
  registerJobHandler(LOGISTICS_JOB_TYPES.cancelShipment, runCancelShipmentJob, {
    timeoutMs: 2 * 60_000,
  });
  registerJobHandler(LOGISTICS_JOB_TYPES.reconcile, (job) => runZohoReconcile(job), {
    timeoutMs: 10 * 60_000,
  });
  registerRecurringJob({
    type: LOGISTICS_JOB_TYPES.reconcile,
    everyMs: LOGISTICS_RECONCILE_EVERY_MS,
    priority: JOB_PRIORITY.maintenance,
  });
}

registerLogisticsJobs();
