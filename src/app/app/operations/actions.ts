'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { startCaseManually } from '@/modules/operations/case-service';
import type { CommandResult } from '@/modules/operations/commands';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { CASE_KIND } from '@/modules/operations/sales-order-hooks';
// Every module registers its commands (and cross-module reactions) through this barrel.
import '@/modules/operations/register-commands';

const BASE_PATH = '/app/operations';
const MANAGE_PERMISSION = 'operations.manage';

const salesOrderSchema = z.string().trim().min(1).max(60);

function noticeUrl(notice: string, caseNumber?: string | null): string {
  const query = new URLSearchParams({ notice });
  if (caseNumber) query.set('case', caseNumber);
  return `${BASE_PATH}?${query.toString()}`;
}

/** Notice key shown by the page for the outcome of `case.start`. */
function noticeFor(result: CommandResult<{ caseNumber: string; created: boolean }>): string {
  switch (result.status) {
    case 'completed':
      return result.data?.created === false ? 'already_started' : 'started';
    case 'accepted':
    case 'pending_external':
      return 'queued';
    default:
      break;
  }
  switch (result.errorCode) {
    case 'case_not_eligible':
      return 'not_eligible';
    case 'forbidden':
    case 'unauthenticated':
      return 'forbidden';
    case 'not_found':
      return 'not_found';
    case 'invalid_state':
      return 'no_lines';
    default:
      return 'failed';
  }
}

/**
 * "Iniciar seguimiento": starts the case of a synchronized sales order that did
 * not start on its own (created before the cutover or outside the pilot
 * locations). Requires `operations.manage`, validated here and again by the
 * command engine.
 *
 * Runs `case.start` right away through `startCaseManually` (manual start:
 * skips the cutover and pilot checks, never the status filters of the start
 * policy). `case.start` is idempotent per sales order, so a double click or a
 * concurrent automatic start returns the same case; the engine writes the
 * audit entry of the user command.
 */
export async function startTrackingAction(formData: FormData): Promise<void> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const user = session.user;
  if (!hasPermission(user, MANAGE_PERMISSION)) redirect(noticeUrl('forbidden'));

  const parsed = salesOrderSchema.safeParse(formData.get('salesOrder'));
  if (!parsed.success) redirect(noticeUrl('invalid'));
  const term = parsed.data;

  const order = await prisma.salesOrder.findFirst({
    where: {
      OR: [{ salesOrderNumber: { equals: term, mode: 'insensitive' } }, { zohoSalesOrderId: term }],
    },
    orderBy: { createdAt: 'desc' },
    select: { zohoSalesOrderId: true, salesOrderNumber: true },
  });
  if (!order) redirect(noticeUrl('not_found'));

  const existing = await prisma.operationalCase.findFirst({
    where: { kind: CASE_KIND, zohoSalesOrderId: order.zohoSalesOrderId },
    orderBy: { openedAt: 'desc' },
    select: { caseNumber: true },
  });
  if (existing) redirect(noticeUrl('already_started', existing.caseNumber));

  const config = await getOperationsConfig();
  if (!config.isEnabled) redirect(noticeUrl('unavailable'));

  let notice = 'failed';
  let caseNumber: string | null = null;
  try {
    const result = await startCaseManually(user, order.zohoSalesOrderId, {
      commandId: `case.start:manual:${randomUUID()}`,
    });
    notice = noticeFor(result);
    caseNumber = result.data?.caseNumber ?? null;
    if (result.status === 'rejected') {
      console.info(
        JSON.stringify({
          component: 'operations-actions',
          event: 'manual_start_rejected',
          userId: user.id,
          zohoSalesOrderId: order.zohoSalesOrderId,
          errorCode: result.errorCode ?? null,
          message: result.message ?? null,
        })
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        component: 'operations-actions',
        event: 'manual_start_failed',
        userId: user.id,
        zohoSalesOrderId: order.zohoSalesOrderId,
        message: err instanceof Error ? err.message : String(err),
      })
    );
  }

  revalidatePath(BASE_PATH);
  redirect(noticeUrl(notice, caseNumber));
}
