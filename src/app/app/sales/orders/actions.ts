'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  assertPermission,
  AuthorizationError,
  getCurrentSession,
} from '@/modules/auth/authorization';
import {
  upsertUserTablePreference,
  deleteUserTablePreference,
} from '@/modules/sales/table-preferences-service';
import {
  createTableView,
  updateTableView,
  deleteTableView,
  shareTableView,
  unshareTableView,
  duplicateTableView,
} from '@/modules/sales/table-views-service';
import {
  watchEntity,
  unwatchEntity,
  bulkWatchEntities,
  bulkUnwatchEntities,
  SALES_ORDER_ENTITY_TYPE,
} from '@/modules/sales/entity-watch-service';
import {
  markNotificationRead,
  markAllNotificationsRead,
} from '@/modules/sales/notifications-service';
import {
  tablePreferenceConfigSchema,
  tableViewVisibilitySchema,
  TablePreferenceConfig,
} from '@/modules/sales/sales-orders-filters';
import { SALES_ORDERS_TABLE_KEY } from '@/modules/sales/sales-orders-columns';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { formatDateOnly, getSalesOrderStatusConfig } from '@/modules/sales/sales-orders-helpers';

const SALES_ORDERS_PATH = '/app/sales/orders';

function errorMessage(error: unknown): string {
  if (error instanceof AuthorizationError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Ocurrió un error inesperado';
}

async function requireActor(permission: string) {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  assertPermission(session.user, permission);
  return session.user;
}

// ---------------------------------------------------------------------------
// Table preferences
// ---------------------------------------------------------------------------

export interface PreferenceFormState {
  error: string | null;
  success: boolean;
}

const preferenceConfigSchema = tablePreferenceConfigSchema;

export async function saveTablePreferenceAction(
  _prevState: PreferenceFormState,
  formData: FormData
): Promise<PreferenceFormState> {
  try {
    const actor = await requireActor('sales_orders.view');
    const configRaw = formData.get('config');
    if (typeof configRaw !== 'string') {
      return { error: 'Configuración inválida', success: false };
    }
    const parsed = preferenceConfigSchema.safeParse(JSON.parse(configRaw));
    if (!parsed.success) {
      return { error: 'Configuración inválida', success: false };
    }
    await upsertUserTablePreference(actor.id, SALES_ORDERS_TABLE_KEY, parsed.data);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

export async function saveTablePreferenceJson(
  config: TablePreferenceConfig
): Promise<{ error: string | null; success: boolean }> {
  try {
    const actor = await requireActor('sales_orders.view');
    const parsed = preferenceConfigSchema.parse(config);
    await upsertUserTablePreference(actor.id, SALES_ORDERS_TABLE_KEY, parsed);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

export async function resetTablePreferenceAction(): Promise<PreferenceFormState> {
  try {
    const actor = await requireActor('sales_orders.view');
    await deleteUserTablePreference(actor.id, SALES_ORDERS_TABLE_KEY);
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

const createViewSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido').max(100),
  visibility: tableViewVisibilitySchema.default('private'),
  config: z.string(),
  isDefault: z.boolean().default(false),
});

export interface ViewFormState {
  error: string | null;
  success: boolean;
  viewId: string | null;
}

export async function createViewAction(
  _prevState: ViewFormState,
  formData: FormData
): Promise<ViewFormState> {
  try {
    const actor = await requireActor('sales_orders.view');
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

    let config: unknown;
    try {
      config = JSON.parse(parsed.data.config);
    } catch {
      return { error: 'Configuración inválida', success: false, viewId: null };
    }

    const view = await createTableView(actor, {
      tableKey: SALES_ORDERS_TABLE_KEY,
      name: parsed.data.name,
      visibility: parsed.data.visibility,
      config,
      isDefault: parsed.data.isDefault,
    });

    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, viewId: view.id };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

const updateViewSchema = z.object({
  viewId: z.string().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  config: z.string().optional(),
  isDefault: z.boolean().optional(),
});

export async function updateViewAction(
  _prevState: ViewFormState,
  formData: FormData
): Promise<ViewFormState> {
  try {
    const actor = await requireActor('sales_orders.view');
    const parsed = updateViewSchema.safeParse({
      viewId: formData.get('viewId'),
      name: formData.get('name') || undefined,
      config: formData.get('config') || undefined,
      isDefault: formData.get('isDefault') === 'true' ? true : undefined,
    });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false, viewId: null };
    }

    const updates: { name?: string; config?: unknown; isDefault?: boolean } = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.config !== undefined) {
      try {
        updates.config = JSON.parse(parsed.data.config);
      } catch {
        return { error: 'Configuración inválida', success: false, viewId: null };
      }
    }
    if (parsed.data.isDefault !== undefined) updates.isDefault = parsed.data.isDefault;

    const view = await updateTableView(actor, parsed.data.viewId, updates);
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, viewId: view.id };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

const deleteViewSchema = z.object({ viewId: z.string().min(1) });

export async function deleteViewAction(
  _prevState: ViewFormState,
  formData: FormData
): Promise<ViewFormState> {
  try {
    const actor = await requireActor('sales_orders.view');
    const parsed = deleteViewSchema.safeParse({ viewId: formData.get('viewId') });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false, viewId: null };
    }
    await deleteTableView(actor, parsed.data.viewId);
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, viewId: null };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

const shareViewSchema = z.object({ viewId: z.string().min(1) });

export async function shareViewAction(
  _prevState: ViewFormState,
  formData: FormData
): Promise<ViewFormState> {
  try {
    const actor = await requireActor('sales_orders.share_views');
    const parsed = shareViewSchema.safeParse({ viewId: formData.get('viewId') });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false, viewId: null };
    }
    await shareTableView(actor, parsed.data.viewId);
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, viewId: parsed.data.viewId };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

export async function unshareViewAction(
  _prevState: ViewFormState,
  formData: FormData
): Promise<ViewFormState> {
  try {
    const actor = await requireActor('sales_orders.share_views');
    const parsed = shareViewSchema.safeParse({ viewId: formData.get('viewId') });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false, viewId: null };
    }
    await unshareTableView(actor, parsed.data.viewId);
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, viewId: parsed.data.viewId };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

const duplicateViewSchema = z.object({
  viewId: z.string().min(1),
  newName: z.string().trim().min(1).max(100),
});

export async function duplicateViewAction(
  _prevState: ViewFormState,
  formData: FormData
): Promise<ViewFormState> {
  try {
    const actor = await requireActor('sales_orders.view');
    const parsed = duplicateViewSchema.safeParse({
      viewId: formData.get('viewId'),
      newName: formData.get('newName'),
    });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false, viewId: null };
    }
    const view = await duplicateTableView(actor, parsed.data.viewId, parsed.data.newName);
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, viewId: view.id };
  } catch (error) {
    return { error: errorMessage(error), success: false, viewId: null };
  }
}

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

const watchSchema = z.object({ entityId: z.string().min(1) });

export interface WatchFormState {
  error: string | null;
  success: boolean;
  isWatched: boolean;
}

export async function watchOrderAction(
  _prevState: WatchFormState,
  formData: FormData
): Promise<WatchFormState> {
  try {
    const actor = await requireActor('sales_orders.watch');
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false, isWatched: false };
    }
    await watchEntity(actor, SALES_ORDER_ENTITY_TYPE, parsed.data.entityId);
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, isWatched: true };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: false };
  }
}

export async function unwatchOrderAction(
  _prevState: WatchFormState,
  formData: FormData
): Promise<WatchFormState> {
  try {
    const actor = await requireActor('sales_orders.watch');
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false, isWatched: false };
    }
    await unwatchEntity(actor, SALES_ORDER_ENTITY_TYPE, parsed.data.entityId);
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, isWatched: false };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: false };
  }
}

const bulkWatchSchema = z.object({
  entityIds: z.array(z.string()).default([]),
  action: z.enum(['watch', 'unwatch']),
});

export async function bulkWatchAction(
  _prevState: WatchFormState,
  formData: FormData
): Promise<WatchFormState> {
  try {
    const actor = await requireActor('sales_orders.watch');
    const parsed = bulkWatchSchema.safeParse({
      entityIds: formData.getAll('entityIds').map(String),
      action: formData.get('action'),
    });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false, isWatched: false };
    }
    if (parsed.data.action === 'watch') {
      await bulkWatchEntities(actor, SALES_ORDER_ENTITY_TYPE, parsed.data.entityIds);
    } else {
      await bulkUnwatchEntities(actor, SALES_ORDER_ENTITY_TYPE, parsed.data.entityIds);
    }
    revalidatePath(SALES_ORDERS_PATH);
    return { error: null, success: true, isWatched: parsed.data.action === 'watch' };
  } catch (error) {
    return { error: errorMessage(error), success: false, isWatched: false };
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const markReadSchema = z.object({ notificationId: z.string().min(1) });

export interface NotificationFormState {
  error: string | null;
  success: boolean;
}

export async function markNotificationReadAction(
  _prevState: NotificationFormState,
  formData: FormData
): Promise<NotificationFormState> {
  try {
    const session = await getCurrentSession();
    if (!session) redirect('/login');
    const parsed = markReadSchema.safeParse({ notificationId: formData.get('notificationId') });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false };
    }
    await markNotificationRead(session.user.id, parsed.data.notificationId);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

export async function markAllNotificationsReadAction(): Promise<NotificationFormState> {
  try {
    const session = await getCurrentSession();
    if (!session) redirect('/login');
    await markAllNotificationsRead(session.user.id);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const exportSchema = z.object({
  format: z.enum(['csv', 'xlsx']),
  scope: z.enum(['current_page', 'selected', 'filtered']),
  selectedIds: z.array(z.string()).optional(),
  includeAllColumns: z.boolean().optional(),
  visibleColumns: z.string().optional(),
  query: z.string(),
});

export interface ExportFormState {
  error: string | null;
  success: boolean;
  content: string | null;
  filename: string | null;
  format: string | null;
}

export async function exportSalesOrdersAction(
  _prevState: ExportFormState,
  formData: FormData
): Promise<ExportFormState> {
  try {
    const actor = await requireActor('sales_orders.export');
    const parsed = exportSchema.safeParse({
      format: formData.get('format'),
      scope: formData.get('scope'),
      selectedIds: formData.getAll('selectedIds').map(String),
      includeAllColumns: formData.get('includeAllColumns') === 'true',
      visibleColumns: formData.get('visibleColumns') ?? undefined,
      query: formData.get('query'),
    });
    if (!parsed.success) {
      return {
        error: 'Datos inválidos',
        success: false,
        content: null,
        filename: null,
        format: null,
      };
    }

    let query: unknown;
    try {
      query = JSON.parse(parsed.data.query);
    } catch {
      return {
        error: 'Query inválida',
        success: false,
        content: null,
        filename: null,
        format: null,
      };
    }

    // Parse visibleColumns if provided
    let visibleColumns: string[] | undefined;
    if (parsed.data.visibleColumns) {
      try {
        visibleColumns = JSON.parse(parsed.data.visibleColumns);
      } catch {
        visibleColumns = undefined;
      }
    }

    // Dynamic import to keep exceljs out of the client bundle.
    const { getSalesOrdersForExport, buildCsv } =
      await import('@/modules/sales/sales-orders-service');
    const { rows, columns } = await getSalesOrdersForExport(query, {
      format: parsed.data.format,
      scope: parsed.data.scope,
      selectedIds: parsed.data.selectedIds,
      includeAllColumns: parsed.data.includeAllColumns,
      visibleColumns,
    });

    const timestamp = new Date().toISOString().split('T')[0];

    if (parsed.data.format === 'csv') {
      const csv = buildCsv(rows, columns);
      const content = Buffer.from('\ufeff' + csv, 'utf-8').toString('base64');
      await recordAuditEvent({
        actorUserId: actor.id,
        action: 'sales_orders.exported',
        targetType: 'SalesOrder',
        metadata: { format: 'csv', rowCount: rows.length, scope: parsed.data.scope },
      });
      return {
        error: null,
        success: true,
        content,
        filename: `ordenes-venta-${timestamp}.csv`,
        format: 'csv',
      };
    }

    // XLSX
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Órdenes de venta');
    sheet.columns = columns.map((c) => ({
      header: c.label,
      key: c.id,
      width: Math.min(Math.max(c.defaultWidth / 8, 12), 40),
    }));
    for (const row of rows) {
      const rowData: Record<string, unknown> = {};
      for (const col of columns) {
        const val = (row as unknown as Record<string, unknown>)[col.id];
        if (val === null || val === undefined) {
          rowData[col.id] = '';
        } else if (col.type === 'currency' || col.type === 'number') {
          rowData[col.id] = Number(val);
        } else if (col.type === 'boolean') {
          rowData[col.id] = val === true ? 'Sí' : val === false ? 'No' : '';
        } else if (col.formatter === 'date') {
          rowData[col.id] = formatDateOnly(val as string | Date);
        } else if (col.formatter === 'statusDot') {
          rowData[col.id] = getSalesOrderStatusConfig(
            val as string | null,
            col.statusCategory
          ).label;
        } else {
          rowData[col.id] = String(val);
        }
      }
      sheet.addRow(rowData);
    }
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    const content = Buffer.from(buffer).toString('base64');
    await recordAuditEvent({
      actorUserId: actor.id,
      action: 'sales_orders.exported',
      targetType: 'SalesOrder',
      metadata: { format: 'xlsx', rowCount: rows.length, scope: parsed.data.scope },
    });
    return {
      error: null,
      success: true,
      content,
      filename: `ordenes-venta-${timestamp}.xlsx`,
      format: 'xlsx',
    };
  } catch (error) {
    return {
      error: errorMessage(error),
      success: false,
      content: null,
      filename: null,
      format: null,
    };
  }
}
