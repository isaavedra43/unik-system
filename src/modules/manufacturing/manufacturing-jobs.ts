import { prisma } from '@/lib/prisma';
import { JOB_PRIORITY, registerJobHandler, type JobContext } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import { loadWorkCenterLoads } from './capacity-service';
import { runManufacturingSystemCommand, type CapacityAlertResult, type IntakeResult } from './manufacturing-commands';
import { addDays } from './manufacturing-helpers';
import {
  CAPACITY_ALERTS_EVERY_MS,
  CAPACITY_ALERT_HORIZON_DAYS,
  MANUFACTURING_COMMANDS,
  MANUFACTURING_JOB_TYPES,
  MANUFACTURING_OBJECT_TYPES,
  RETRY_BLOCKED_BATCH,
} from './manufacturing-types';
import { parseTransformationInputs } from './production-state';
import type { ReserveMaterialsResult } from './production-service';

/**
 * Background jobs of manufacturing:
 * - `manufacturing.intake_request` `{requestId}`: a transformation request
 *   becomes a production order (system command, idempotent per request).
 * - `manufacturing.retry_blocked` `{zohoItemId? | requestId? | productionOrderId?}`:
 *   blocked orders that need the material try to reserve again.
 * - `manufacturing.capacity_alerts` (every hour): overloaded shifts of the next
 *   days raise a work item for Manufactura (one per center and shift).
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'manufacturing-jobs', event, ...extra }));

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function runIntakeRequestJob(
  job: JobContext<{ requestId?: string }>,
  options: { now?: Date } = {}
): Promise<Record<string, unknown>> {
  const requestId = text(job.payload?.requestId);
  if (!requestId) return { outcome: 'skipped', reason: 'missing_request' };
  const result = await runManufacturingSystemCommand<IntakeResult>({
    type: MANUFACTURING_COMMANDS.orderIntakeRequest,
    commandId: `mfg:intake:${requestId}`,
    aggregate: { type: 'area_request', id: requestId },
    payload: { requestId },
    now: options.now,
  });
  if (result.status === 'rejected') {
    if (result.errorCode === 'concurrency_conflict') throw new Error(result.message ?? 'concurrency_conflict');
    log('intake_rejected', { requestId, errorCode: result.errorCode, message: result.message });
    return { outcome: 'rejected', errorCode: result.errorCode ?? null, message: result.message ?? null };
  }
  if (result.status === 'accepted') throw new Error('La toma de la solicitud sigue en curso; se reintenta');
  log('intake_done', { requestId, outcome: result.data?.outcome ?? null });
  return { ...(result.data ?? {}) };
}

export interface RetryBlockedSummary {
  candidates: number;
  attempted: number;
  reserved: number;
  stillBlocked: number;
  rejected: number;
}

async function blockedOrdersNeeding(zohoItemId: string): Promise<string[]> {
  const blocked = await prisma.productionOrder.findMany({
    where: { status: 'blocked' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
    select: { id: true, kind: true, bomId: true, inputs: true },
  });
  const bomIds = blocked.filter((order) => order.kind === 'bom' && order.bomId).map((order) => order.bomId as string);
  const bomLines = bomIds.length
    ? await prisma.bomLine.findMany({
        where: { bomId: { in: [...new Set(bomIds)] } },
        select: { bomId: true, inputZohoItemId: true, substituteZohoItemIds: true },
      })
    : [];
  return blocked
    .filter((order) => {
      if (order.kind === 'bom') {
        return bomLines.some(
          (line) =>
            line.bomId === order.bomId &&
            (line.inputZohoItemId === zohoItemId || line.substituteZohoItemIds.includes(zohoItemId))
        );
      }
      return parseTransformationInputs(order.inputs).some((input) => input.zohoItemId === zohoItemId);
    })
    .map((order) => order.id);
}

export async function runRetryBlockedJob(
  job: JobContext<{ zohoItemId?: string; requestId?: string; productionOrderId?: string }>,
  options: { now?: Date } = {}
): Promise<RetryBlockedSummary> {
  const payload = job.payload ?? {};
  let orderIds: string[] = [];
  const productionOrderId = text(payload.productionOrderId);
  const requestId = text(payload.requestId);
  const zohoItemId = text(payload.zohoItemId);
  if (productionOrderId) orderIds = [productionOrderId];
  else if (requestId) {
    const request = await prisma.areaRequest.findUnique({
      where: { id: requestId },
      select: { objectType: true, objectId: true },
    });
    if (request?.objectType === MANUFACTURING_OBJECT_TYPES.productionOrder) orderIds = [request.objectId];
  } else if (zohoItemId) {
    orderIds = await blockedOrdersNeeding(zohoItemId);
  }
  const summary: RetryBlockedSummary = { candidates: orderIds.length, attempted: 0, reserved: 0, stillBlocked: 0, rejected: 0 };
  for (const orderId of orderIds.slice(0, RETRY_BLOCKED_BATCH)) {
    const order = await prisma.productionOrder.findUnique({ where: { id: orderId }, select: { status: true } });
    if (order?.status !== 'blocked') continue;
    summary.attempted += 1;
    const result = await runManufacturingSystemCommand<ReserveMaterialsResult>({
      type: MANUFACTURING_COMMANDS.orderReserveMaterials,
      commandId: `mfg:retry:${orderId}:${job.id}`.slice(0, 160),
      aggregate: { type: MANUFACTURING_OBJECT_TYPES.productionOrder, id: orderId },
      payload: { productionOrderId: orderId },
      now: options.now,
    });
    if (result.status === 'rejected') {
      summary.rejected += 1;
      log('retry_rejected', { orderId, errorCode: result.errorCode, message: result.message });
    } else if (result.data?.status === 'reserved') summary.reserved += 1;
    else summary.stillBlocked += 1;
  }
  log('retry_done', { ...summary, zohoItemId, requestId, productionOrderId });
  return summary;
}

export interface CapacityAlertsSummary {
  workCenters: number;
  overloadedWindows: number;
  alerts: number;
  rejected: number;
}

export async function runCapacityAlertsJob(
  _job: JobContext<unknown>,
  options: { now?: Date } = {}
): Promise<CapacityAlertsSummary> {
  const now = options.now ?? new Date();
  const centers = await prisma.workCenter.findMany({ where: { status: 'active' }, orderBy: { key: 'asc' } });
  const summary: CapacityAlertsSummary = { workCenters: centers.length, overloadedWindows: 0, alerts: 0, rejected: 0 };
  for (const center of centers) {
    const { loads } = await loadWorkCenterLoads(prisma, center, now, addDays(now, CAPACITY_ALERT_HORIZON_DAYS));
    for (const window of loads.filter((candidate) => candidate.overloaded)) {
      summary.overloadedWindows += 1;
      const result = await runManufacturingSystemCommand<CapacityAlertResult>({
        type: MANUFACTURING_COMMANDS.capacityAlert,
        commandId: `mfg:capacity:${center.id}:${window.start.toISOString()}`.slice(0, 160),
        aggregate: { type: MANUFACTURING_OBJECT_TYPES.workCenter, id: center.id },
        payload: { workCenterId: center.id, windowStart: window.start.toISOString() },
        now: options.now,
      });
      if (result.status === 'rejected') summary.rejected += 1;
      else if (!result.replayed && result.data?.alerted) summary.alerts += 1;
    }
  }
  log('capacity_alerts_done', { ...summary });
  return summary;
}

type GlobalWithManufacturingJobs = typeof globalThis & { __unikManufacturingJobsRegistered?: boolean };

export function registerManufacturingJobs(): void {
  const scope = globalThis as GlobalWithManufacturingJobs;
  if (scope.__unikManufacturingJobsRegistered) return;
  scope.__unikManufacturingJobsRegistered = true;
  registerJobHandler(MANUFACTURING_JOB_TYPES.intakeRequest, (job) => runIntakeRequestJob(job as JobContext<{ requestId?: string }>), {
    timeoutMs: 2 * 60_000,
  });
  registerJobHandler(MANUFACTURING_JOB_TYPES.retryBlocked, (job) => runRetryBlockedJob(job as JobContext<{ zohoItemId?: string }>), {
    timeoutMs: 5 * 60_000,
  });
  registerJobHandler(MANUFACTURING_JOB_TYPES.capacityAlerts, (job) => runCapacityAlertsJob(job), {
    timeoutMs: 5 * 60_000,
  });
  registerRecurringJob({
    type: MANUFACTURING_JOB_TYPES.capacityAlerts,
    everyMs: CAPACITY_ALERTS_EVERY_MS,
    priority: JOB_PRIORITY.maintenance,
  });
}

registerManufacturingJobs();
