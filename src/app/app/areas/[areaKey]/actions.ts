'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import {
  AuthorizationError,
  getCurrentSession,
  hasAnyPermission,
  type CurrentUser,
} from '@/modules/auth/authorization';
import {
  areaActPermissions,
  areaExportPermissions,
  areaHref,
  areaViewPermissions,
  getArea,
  holdsAny,
  type AreaMeta,
} from '@/modules/areas/area-registry';
import { AREA_ROW_ENTITY_TYPE } from '@/modules/areas/area-work-row';
import { ensureAreaRegistrations } from '@/modules/areas/register-all';
import { areaWorkExportColumns, extraFieldKey } from '@/modules/areas/work-columns';
import {
  areaViewConfigSchema,
  parseAreaWorkQuery,
  tablePreferenceConfigSchema,
  tableViewVisibilitySchema,
  type AreaTablePreferenceConfig,
} from '@/modules/areas/work-filters';
import { findRowAction } from '@/modules/areas/work-actions';
import {
  exportAreaWorkRows,
  getAreaWorkRow,
  listAreaWorkRows,
} from '@/modules/areas/work-rows-service';
import { executeCommand } from '@/modules/operations/commands';
// Every module registers its commands through this barrel.
import '@/modules/operations/register-commands';
import {
  bulkUnwatchEntities,
  bulkWatchEntities,
  unwatchEntity,
  watchEntity,
} from '@/modules/sales/entity-watch-service';
import {
  deleteUserTablePreference,
  upsertUserTablePreference,
} from '@/modules/sales/table-preferences-service';
import { createTableView } from '@/modules/sales/table-views-service';

/**
 * Server actions of an area (plan 7.2). Every one of them is bound to its
 * `areaKey` by the page (`action.bind(null, area.key)`) and re-checks the
 * permissions of that area: a person who may not see the area cannot save a
 * preference, export it or run one of its commands.
 *
 * Row commands go through `executeCommand` — the same engine the API and the
 * offline queue use — so idempotency, the optimistic version and the audit
 * entry behave exactly the same from here.
 */

function errorMessage(error: unknown): string {
  if (error instanceof AuthorizationError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Ocurrió un error inesperado';
}

async function requireAreaActor(areaKey: string): Promise<{ user: CurrentUser; area: AreaMeta }> {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  const area = getArea(areaKey);
  if (!area) throw new AuthorizationError('Área desconocida');
  if (!hasAnyPermission(session.user, areaViewPermissions(area))) throw new AuthorizationError();
  return { user: session.user, area };
}

// ---------------------------------------------------------------------------
// Table preferences and views
// ---------------------------------------------------------------------------

export async function saveAreaPreferenceAction(
  areaKey: string,
  config: AreaTablePreferenceConfig
): Promise<{ error: string | null; success: boolean }> {
  try {
    const { user, area } = await requireAreaActor(areaKey);
    const parsed = tablePreferenceConfigSchema.parse(config);
    await upsertUserTablePreference(user.id, area.workCenter.tableKey, parsed);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

export async function resetAreaPreferenceAction(
  areaKey: string
): Promise<{ error: string | null; success: boolean }> {
  try {
    const { user, area } = await requireAreaActor(areaKey);
    await deleteUserTablePreference(user.id, area.workCenter.tableKey);
    revalidatePath(areaHref(area.key, 'trabajo'));
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const createViewSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido').max(100),
  visibility: tableViewVisibilitySchema.default('private'),
  config: z.string(),
  isDefault: z.boolean().default(false),
});

export async function createAreaViewAction(
  areaKey: string,
  _prevState: { error: string | null; success: boolean; viewId: string | null },
  formData: FormData
): Promise<{ error: string | null; success: boolean; viewId: string | null }> {
  try {
    const { user, area } = await requireAreaActor(areaKey);
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
    if (parsed.data.visibility === 'shared' && !holdsAny(user, areaActPermissions(area))) {
      return { error: 'No puedes compartir vistas de esta área', success: false, viewId: null };
    }
    let config: unknown;
    try {
      config = JSON.parse(parsed.data.config);
    } catch {
      return { error: 'Configuración inválida', success: false, viewId: null };
    }
    const view = await createTableView(user, {
      tableKey: area.workCenter.tableKey,
      name: parsed.data.name,
      visibility: parsed.data.visibility,
      config,
      isDefault: parsed.data.isDefault,
      // Validate against THIS area's columns, not the sales orders table (its default).
      configSchema: areaViewConfigSchema(area),
      // Sharing a view of the area needs the area's own right to act, not `sales_orders.share_views`.
      sharePermission: areaActPermissions(area),
    });
    revalidatePath(areaHref(area.key, 'trabajo'));
    return { error: null, success: true, viewId: view.id };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

const watchSchema = z.object({ entityId: z.string().min(1).max(200) });

export async function watchAreaRowAction(
  areaKey: string,
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const { user } = await requireAreaActor(areaKey);
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    await watchEntity(user, AREA_ROW_ENTITY_TYPE, parsed.data.entityId);
    return { error: null, success: true, isWatched: true };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: false };
  }
}

export async function unwatchAreaRowAction(
  areaKey: string,
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const { user } = await requireAreaActor(areaKey);
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: true };
    await unwatchEntity(user, AREA_ROW_ENTITY_TYPE, parsed.data.entityId);
    return { error: null, success: true, isWatched: false };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: true };
  }
}

const bulkWatchSchema = z.object({
  entityIds: z.array(z.string().max(200)).max(500).default([]),
  action: z.enum(['watch', 'unwatch']),
});

export async function bulkWatchAreaRowsAction(
  areaKey: string,
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const { user } = await requireAreaActor(areaKey);
    const parsed = bulkWatchSchema.safeParse({
      entityIds: formData.getAll('entityIds').map(String),
      action: formData.get('action'),
    });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    if (parsed.data.action === 'watch') {
      await bulkWatchEntities(user, AREA_ROW_ENTITY_TYPE, parsed.data.entityIds);
    } else {
      await bulkUnwatchEntities(user, AREA_ROW_ENTITY_TYPE, parsed.data.entityIds);
    }
    return { error: null, success: true, isWatched: parsed.data.action === 'watch' };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: false };
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

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

function cellValue(row: Record<string, unknown>, field: string, columnId: string): string {
  const extraKey = extraFieldKey(field);
  const raw = extraKey
    ? ((row.extra as Record<string, unknown> | undefined)?.[extraKey] ?? null)
    : (row[columnId] ?? null);
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? 'Sí' : 'No';
  return String(raw);
}

export async function exportAreaRowsAction(
  areaKey: string,
  _prevState: ExportState,
  formData: FormData
): Promise<ExportState> {
  try {
    const { user, area } = await requireAreaActor(areaKey);
    // Exporting is a narrower door than reading (plan 6.1: `purchases.export`).
    // Somebody who may see Compras but does not hold its export key cannot take
    // its lists out of UNIK, from this action, the toolbar or a replayed form.
    if (!hasAnyPermission(user, areaExportPermissions(area))) {
      throw new AuthorizationError(`No tienes permisos para exportar ${area.label}`);
    }
    await ensureAreaRegistrations();
    const parsed = exportSchema.safeParse({
      format: formData.get('format'),
      scope: formData.get('scope'),
      selectedIds: formData.getAll('selectedIds').map(String),
      query: formData.get('query'),
    });
    if (!parsed.success) return { ...EMPTY_EXPORT, error: 'Datos inválidos' };
    let rawQuery: unknown;
    try {
      rawQuery = JSON.parse(parsed.data.query);
    } catch {
      return { ...EMPTY_EXPORT, error: 'Consulta inválida' };
    }

    const query = parseAreaWorkQuery(rawQuery, area);
    const rows = await exportAreaWorkRows(user, area, query, {
      scope: parsed.data.scope,
      ...(parsed.data.selectedIds ? { selectedIds: parsed.data.selectedIds } : {}),
    });
    const columns = areaWorkExportColumns(area);
    const timestamp = new Date().toISOString().split('T')[0];
    const base = `${area.key}-trabajo-${timestamp}`;

    await recordAuditEvent({
      actorUserId: user.id,
      action: 'areas.work_rows_exported',
      // snake_case, como el resto del vocabulario de la auditoría de la Torre:
      // con 'Area' el renglón se escribía y no se podía leer en ninguna parte.
      targetType: 'area',
      targetId: area.key,
      metadata: { format: parsed.data.format, rowCount: rows.length, scope: parsed.data.scope },
    });

    if (parsed.data.format === 'csv') {
      const header = columns.map((column) => `"${column.label.replace(/"/g, '""')}"`).join(',');
      const lines = rows.map((row) =>
        columns
          .map(
            (column) =>
              `"${cellValue(row as unknown as Record<string, unknown>, column.field, column.id).replace(/"/g, '""')}"`
          )
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
    const sheet = workbook.addWorksheet(area.label.slice(0, 28));
    sheet.columns = columns.map((column) => ({
      header: column.label,
      key: column.id,
      width: Math.min(Math.max(column.defaultWidth / 8, 12), 40),
    }));
    for (const row of rows) {
      const record = row as unknown as Record<string, unknown>;
      sheet.addRow(
        Object.fromEntries(
          columns.map((column) => [column.id, cellValue(record, column.field, column.id)])
        )
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

// ---------------------------------------------------------------------------
// Row commands
// ---------------------------------------------------------------------------

const rowCommandSchema = z.object({
  rowId: z.string().trim().min(3).max(200),
  actionId: z.string().trim().min(2).max(80),
  note: z.string().trim().max(4000).optional(),
  returnTo: z.string().trim().max(300).optional(),
});

/**
 * Runs one row action from a plain form (the detail pages use it, so they work
 * without JavaScript). The table and the drawer use the command endpoint with
 * the offline queue instead — both end in the same `executeCommand`.
 */
export async function runRowCommandAction(areaKey: string, formData: FormData): Promise<void> {
  const { user, area } = await requireAreaActor(areaKey);
  await ensureAreaRegistrations();
  const parsed = rowCommandSchema.safeParse({
    rowId: formData.get('rowId'),
    actionId: formData.get('actionId'),
    note: formData.get('note') ?? undefined,
    returnTo: formData.get('returnTo') ?? undefined,
  });
  const fallback = areaHref(area.key, 'trabajo');
  if (!parsed.success) redirect(`${fallback}?notice=invalid`);

  const target =
    parsed.data.returnTo && parsed.data.returnTo.startsWith(`/app/areas/${area.key}/`)
      ? parsed.data.returnTo
      : fallback;

  const row = await getAreaWorkRow(user, area, parsed.data.rowId);
  if (!row) redirect(`${target}?notice=not_found`);

  const actor = {
    id: user.id,
    permissionKeys: user.permissionKeys as string[],
    isSuperAdmin: user.isSuperAdmin,
  };
  const action = findRowAction(row, actor, parsed.data.actionId, {
    actPermissions: areaActPermissions(area),
  });
  if (!action) redirect(`${target}?notice=forbidden`);

  // A domain action carries the fixed payload its command requires (the record
  // it acts on); what the person typed is added on top.
  const payload: Record<string, unknown> = { ...(action.payload ?? {}) };
  if (parsed.data.note && action.form !== 'none') {
    // A branch may rename the text field its command expects (`lostReason`…).
    const key =
      action.payloadTextKey ??
      (action.form === 'answer'
        ? 'answer'
        : action.form === 'reason' || action.form === 'wait'
          ? 'reason'
          : 'note');
    payload[key] = parsed.data.note;
  }

  let notice = 'failed';
  try {
    const result = await executeCommand(
      {
        commandId: `area:${area.key}:${action.id}:${randomUUID()}`,
        type: action.commandType,
        actor: { type: 'user', id: user.id },
        aggregate: { type: action.aggregateType, id: action.aggregateId ?? row.sourceId },
        expectedVersion: row.version,
        payload,
      },
      user
    );
    notice =
      result.status === 'completed' || result.status === 'accepted'
        ? 'done'
        : result.status === 'pending_external'
          ? 'queued'
          : (result.errorCode ?? 'rejected');
  } catch (error) {
    console.error(
      JSON.stringify({
        component: 'areas-actions',
        event: 'row_command_failed',
        areaKey: area.key,
        rowId: row.id,
        actionId: action.id,
        message: errorMessage(error),
      })
    );
  }

  revalidatePath(target);
  redirect(`${target}?notice=${encodeURIComponent(notice)}`);
}

/** Rows of a space for a server-rendered list (detail pages and tests). */
export async function listAreaRowsAction(areaKey: string, rawQuery: unknown) {
  const { user, area } = await requireAreaActor(areaKey);
  await ensureAreaRegistrations();
  return listAreaWorkRows(user, area, parseAreaWorkQuery(rawQuery, area));
}
