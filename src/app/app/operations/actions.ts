'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  CASE_ENTITY_TYPE,
  CASE_EXPORT_COLUMNS,
  CASES_TABLE_KEY,
  caseExportValue,
} from '@/components/operations/case/cases-columns';
import {
  CasesQueryError,
  caseViewConfigSchema,
  parseCasesQuery,
} from '@/components/operations/case/cases-filters';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import {
  AuthorizationError,
  getCurrentSession,
  hasPermission,
  type CurrentUser,
} from '@/modules/auth/authorization';
import { startCaseManually } from '@/modules/operations/case-service';
import type { CommandResult } from '@/modules/operations/commands';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { CASE_KIND } from '@/modules/operations/sales-order-hooks';
// Every module registers its commands (and cross-module reactions) through this barrel.
import '@/modules/operations/register-commands';
import {
  bulkUnwatchEntities,
  bulkWatchEntities,
  unwatchEntity,
  watchEntity,
} from '@/modules/sales/entity-watch-service';
import { tablePreferenceConfigSchema } from '@/modules/sales/sales-orders-filters';
import {
  deleteUserTablePreference,
  upsertUserTablePreference,
} from '@/modules/sales/table-preferences-service';
import { createTableView } from '@/modules/sales/table-views-service';
import type { TablePreferenceConfig } from '@/modules/shared/entity-workspace-types';
import { exportCaseRows } from './_cases-data';

const BASE_PATH = '/app/operations';
const MANAGE_PERMISSION = 'operations.manage';
const VIEW_PERMISSION = 'operations.view';

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

// ---------------------------------------------------------------------------
// Case list: preferences, views, watch and export
// ---------------------------------------------------------------------------

/**
 * Server actions of the case list (`EntityWorkspace`). Every one of them
 * re-checks `operations.view`: the page gate is not the control.
 */
async function requireCaseActor(): Promise<CurrentUser> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (!hasPermission(session.user, VIEW_PERMISSION)) throw new AuthorizationError();
  return session.user;
}

function errorMessage(error: unknown): string {
  if (error instanceof CasesQueryError) return error.message;
  if (error instanceof AuthorizationError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Ocurrió un error inesperado';
}

export async function saveCasePreferenceAction(
  config: TablePreferenceConfig
): Promise<{ error: string | null; success: boolean }> {
  try {
    const user = await requireCaseActor();
    await upsertUserTablePreference(
      user.id,
      CASES_TABLE_KEY,
      tablePreferenceConfigSchema.parse(config)
    );
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

export async function resetCasePreferenceAction(): Promise<{
  error: string | null;
  success: boolean;
}> {
  try {
    const user = await requireCaseActor();
    await deleteUserTablePreference(user.id, CASES_TABLE_KEY);
    revalidatePath(BASE_PATH);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const createViewSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido').max(100),
  visibility: z.enum(['private', 'shared']).default('private'),
  config: z.string(),
  isDefault: z.boolean().default(false),
});

export async function createCaseViewAction(
  _prevState: { error: string | null; success: boolean; viewId: string | null },
  formData: FormData
): Promise<{ error: string | null; success: boolean; viewId: string | null }> {
  try {
    const user = await requireCaseActor();
    const parsed = createViewSchema.safeParse({
      name: formData.get('name'),
      visibility: formData.get('visibility') ?? 'private',
      config: formData.get('config'),
      isDefault: formData.get('isDefault') === 'true',
    });
    if (!parsed.success) {
      return {
        error: parsed.error.issues[0]?.message ?? 'Datos inválidos',
        success: false,
        viewId: null,
      };
    }
    if (parsed.data.visibility === 'shared' && !hasPermission(user, MANAGE_PERMISSION)) {
      return { error: 'No puedes compartir vistas de expedientes', success: false, viewId: null };
    }
    let config: unknown;
    try {
      config = JSON.parse(parsed.data.config);
    } catch {
      return { error: 'Configuración inválida', success: false, viewId: null };
    }
    const view = await createTableView(user, {
      tableKey: CASES_TABLE_KEY,
      name: parsed.data.name,
      visibility: parsed.data.visibility,
      config,
      isDefault: parsed.data.isDefault,
      // The case list has its own filterable fields and its own share rule.
      configSchema: caseViewConfigSchema,
      sharePermission: MANAGE_PERMISSION,
    });
    revalidatePath(BASE_PATH);
    return { error: null, success: true, viewId: view.id };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

const watchSchema = z.object({ entityId: z.string().min(1).max(200) });

export async function watchCaseAction(
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const user = await requireCaseActor();
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    await watchEntity(user, CASE_ENTITY_TYPE, parsed.data.entityId);
    return { error: null, success: true, isWatched: true };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: false };
  }
}

export async function unwatchCaseAction(
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const user = await requireCaseActor();
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: true };
    await unwatchEntity(user, CASE_ENTITY_TYPE, parsed.data.entityId);
    return { error: null, success: true, isWatched: false };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: true };
  }
}

const bulkWatchSchema = z.object({
  entityIds: z.array(z.string().max(200)).max(500).default([]),
  action: z.enum(['watch', 'unwatch']),
});

export async function bulkWatchCasesAction(
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const user = await requireCaseActor();
    const parsed = bulkWatchSchema.safeParse({
      entityIds: formData.getAll('entityIds').map(String),
      action: formData.get('action'),
    });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    if (parsed.data.action === 'watch') {
      await bulkWatchEntities(user, CASE_ENTITY_TYPE, parsed.data.entityIds);
    } else {
      await bulkUnwatchEntities(user, CASE_ENTITY_TYPE, parsed.data.entityIds);
    }
    return { error: null, success: true, isWatched: parsed.data.action === 'watch' };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: false };
  }
}

const exportSchema = z.object({
  format: z.enum(['csv', 'xlsx']),
  scope: z.enum(['current_page', 'selected', 'filtered']),
  selectedIds: z.array(z.string().max(200)).max(500).optional(),
  query: z.string(),
});

type ExportState = {
  error: string | null;
  success: boolean;
  content: string | null;
  filename: string | null;
  format: string | null;
};

const EMPTY_EXPORT: ExportState = {
  error: null,
  success: false,
  content: null,
  filename: null,
  format: null,
};

export async function exportCasesAction(
  _prevState: ExportState,
  formData: FormData
): Promise<ExportState> {
  try {
    const user = await requireCaseActor();
    const parsed = exportSchema.safeParse({
      format: formData.get('format'),
      scope: formData.get('scope'),
      selectedIds: formData.getAll('selectedIds').map(String),
      query: formData.get('query'),
    });
    if (!parsed.success) return { ...EMPTY_EXPORT, error: 'Datos inválidos' };
    let raw: unknown;
    try {
      raw = JSON.parse(parsed.data.query);
    } catch {
      return { ...EMPTY_EXPORT, error: 'Consulta inválida' };
    }

    const query = parseCasesQuery(raw);
    const rows = await exportCaseRows(user, query, {
      scope: parsed.data.scope,
      ...(parsed.data.selectedIds ? { selectedIds: parsed.data.selectedIds } : {}),
    });
    const columns = CASE_EXPORT_COLUMNS;
    const base = `expedientes-${new Date().toISOString().split('T')[0]}`;

    await recordAuditEvent({
      actorUserId: user.id,
      action: 'operations.cases_exported',
      // El vocabulario de la auditoría de la Torre es snake_case y su filtro es
      // exacto (`targetType: { in: [...] }`): escrito 'OperationalCase' este
      // renglón no se podía leer desde ninguna pantalla.
      targetType: 'operational_case',
      targetId: CASES_TABLE_KEY,
      metadata: { format: parsed.data.format, rowCount: rows.length, scope: parsed.data.scope },
    });

    if (parsed.data.format === 'csv') {
      const header = columns.map((column) => `"${column.label.replace(/"/g, '""')}"`).join(',');
      const lines = rows.map((row) =>
        columns
          .map((column) => `"${caseExportValue(row, column.id).replace(/"/g, '""')}"`)
          .join(',')
      );
      const csv = [header, ...lines].join('\r\n');
      return {
        error: null,
        success: true,
        content: Buffer.from(`﻿${csv}`, 'utf-8').toString('base64'),
        filename: `${base}.csv`,
        format: 'csv',
      };
    }

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Expedientes');
    sheet.columns = columns.map((column) => ({
      header: column.label,
      key: column.id,
      width: Math.min(Math.max(column.defaultWidth / 8, 12), 40),
    }));
    for (const row of rows) {
      sheet.addRow(
        Object.fromEntries(columns.map((column) => [column.id, caseExportValue(row, column.id)]))
      );
    }
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    return {
      error: null,
      success: true,
      content: Buffer.from(buffer).toString('base64'),
      filename: `${base}.xlsx`,
      format: 'xlsx',
    };
  } catch (error) {
    return { ...EMPTY_EXPORT, error: errorMessage(error) };
  }
}
