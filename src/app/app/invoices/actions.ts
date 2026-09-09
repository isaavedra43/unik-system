'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  assertPermission, AuthorizationError, getCurrentSession,
} from '@/modules/auth/authorization';
import {
  upsertUserTablePreference, deleteUserTablePreference,
} from '@/modules/sales/table-preferences-service';
import { createTableView } from '@/modules/sales/table-views-service';
import {
  watchEntity, unwatchEntity, bulkWatchEntities, bulkUnwatchEntities,
} from '@/modules/sales/entity-watch-service';
import {
  tablePreferenceConfigSchema, tableViewVisibilitySchema, type TablePreferenceConfig,
} from '@/modules/invoices/invoices-filters';
import { INVOICES_TABLE_KEY } from '@/modules/invoices/invoices-columns';
import { INVOICE_ENTITY_TYPE } from '@/modules/invoices/permissions';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { formatDateOnly, getInvoiceStatusConfig } from '@/modules/invoices/invoices-helpers';

const INVOICES_PATH = '/app/invoices';

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

export async function saveTablePreferenceJson(config: TablePreferenceConfig): Promise<{ error: string | null; success: boolean }> {
  try {
    const actor = await requireActor('invoices.view');
    const parsed = tablePreferenceConfigSchema.parse(config);
    await upsertUserTablePreference(actor.id, INVOICES_TABLE_KEY, parsed);
    return { error: null, success: true };
  } catch (error) { return { error: errorMessage(error), success: false }; }
}

export async function resetTablePreferenceAction(): Promise<{ error: string | null; success: boolean }> {
  try {
    const actor = await requireActor('invoices.view');
    await deleteUserTablePreference(actor.id, INVOICES_TABLE_KEY);
    revalidatePath(INVOICES_PATH);
    return { error: null, success: true };
  } catch (error) { return { error: errorMessage(error), success: false }; }
}

const createViewSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido').max(100),
  visibility: tableViewVisibilitySchema.default('private'),
  config: z.string(),
  isDefault: z.boolean().default(false),
});

export async function createViewAction(
  _prevState: { error: string | null; success: boolean; viewId: string | null },
  formData: FormData
): Promise<{ error: string | null; success: boolean; viewId: string | null }> {
  try {
    const actor = await requireActor('invoices.view');
    const parsed = createViewSchema.safeParse({
      name: formData.get('name'), visibility: formData.get('visibility') ?? 'private',
      config: formData.get('config'), isDefault: formData.get('isDefault') === 'true',
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos', success: false, viewId: null };
    let config: unknown;
    try { config = JSON.parse(parsed.data.config); } catch { return { error: 'Configuración inválida', success: false, viewId: null }; }
    const view = await createTableView(actor, {
      tableKey: INVOICES_TABLE_KEY, name: parsed.data.name, visibility: parsed.data.visibility, config, isDefault: parsed.data.isDefault,
    });
    revalidatePath(INVOICES_PATH);
    return { error: null, success: true, viewId: view.id };
  } catch (error) { return { error: errorMessage(error), success: false, viewId: null }; }
}

const watchSchema = z.object({ entityId: z.string().min(1) });

export async function watchAction(
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const actor = await requireActor('invoices.watch');
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    await watchEntity(actor, INVOICE_ENTITY_TYPE, parsed.data.entityId);
    revalidatePath(INVOICES_PATH);
    return { error: null, success: true, isWatched: true };
  } catch (error) { return { error: errorMessage(error), success: false, isWatched: false }; }
}

export async function unwatchAction(
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const actor = await requireActor('invoices.watch');
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    await unwatchEntity(actor, INVOICE_ENTITY_TYPE, parsed.data.entityId);
    revalidatePath(INVOICES_PATH);
    return { error: null, success: true, isWatched: false };
  } catch (error) { return { error: errorMessage(error), success: false, isWatched: false }; }
}

const bulkWatchSchema = z.object({ entityIds: z.array(z.string()).default([]), action: z.enum(['watch', 'unwatch']) });

export async function bulkWatchAction(
  _prevState: { error: string | null; success: boolean; isWatched: boolean },
  formData: FormData
): Promise<{ error: string | null; success: boolean; isWatched: boolean }> {
  try {
    const actor = await requireActor('invoices.watch');
    const parsed = bulkWatchSchema.safeParse({ entityIds: formData.getAll('entityIds').map(String), action: formData.get('action') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    if (parsed.data.action === 'watch') await bulkWatchEntities(actor, INVOICE_ENTITY_TYPE, parsed.data.entityIds);
    else await bulkUnwatchEntities(actor, INVOICE_ENTITY_TYPE, parsed.data.entityIds);
    revalidatePath(INVOICES_PATH);
    return { error: null, success: true, isWatched: parsed.data.action === 'watch' };
  } catch (error) { return { error: errorMessage(error), success: false, isWatched: false }; }
}

const exportSchema = z.object({
  format: z.enum(['csv', 'xlsx']), scope: z.enum(['current_page', 'selected', 'filtered']),
  selectedIds: z.array(z.string()).optional(), includeAllColumns: z.boolean().optional(), query: z.string(),
});

export async function exportAction(
  _prevState: { error: string | null; success: boolean; content: string | null; filename: string | null; format: string | null },
  formData: FormData
): Promise<{ error: string | null; success: boolean; content: string | null; filename: string | null; format: string | null }> {
  try {
    const actor = await requireActor('invoices.export');
    const parsed = exportSchema.safeParse({
      format: formData.get('format'), scope: formData.get('scope'),
      selectedIds: formData.getAll('selectedIds').map(String),
      includeAllColumns: formData.get('includeAllColumns') === 'true', query: formData.get('query'),
    });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, content: null, filename: null, format: null };
    let query: unknown;
    try { query = JSON.parse(parsed.data.query); } catch { return { error: 'Query inválida', success: false, content: null, filename: null, format: null }; }

    const { getInvoicesForExport, buildCsv } = await import('@/modules/invoices/invoices-service');
    const { rows, columns } = await getInvoicesForExport(query, {
      format: parsed.data.format, scope: parsed.data.scope,
      selectedIds: parsed.data.selectedIds, includeAllColumns: parsed.data.includeAllColumns,
    });

    const timestamp = new Date().toISOString().split('T')[0];

    if (parsed.data.format === 'csv') {
      const csv = buildCsv(rows, columns);
      const content = Buffer.from('\ufeff' + csv, 'utf-8').toString('base64');
      await recordAuditEvent({ actorUserId: actor.id, action: 'invoices.exported', targetType: 'Invoice', metadata: { format: 'csv', rowCount: rows.length, scope: parsed.data.scope } });
      return { error: null, success: true, content, filename: `facturas-${timestamp}.csv`, format: 'csv' };
    }

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Facturas');
    sheet.columns = columns.map((c) => ({ header: c.label, key: c.id, width: Math.min(Math.max(c.defaultWidth / 8, 12), 40) }));
    for (const row of rows) {
      const rowData: Record<string, unknown> = {};
      for (const col of columns) {
        const val = (row as unknown as Record<string, unknown>)[col.id];
        if (val === null || val === undefined) rowData[col.id] = '';
        else if (col.type === 'currency' || col.type === 'number') rowData[col.id] = Number(val);
        else if (col.formatter === 'date') rowData[col.id] = formatDateOnly(val as string | Date);
        else if (col.formatter === 'statusDot') rowData[col.id] = getInvoiceStatusConfig(val as string | null).label;
        else rowData[col.id] = String(val);
      }
      sheet.addRow(rowData);
    }
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    const content = Buffer.from(buffer).toString('base64');
    await recordAuditEvent({ actorUserId: actor.id, action: 'invoices.exported', targetType: 'Invoice', metadata: { format: 'xlsx', rowCount: rows.length, scope: parsed.data.scope } });
    return { error: null, success: true, content, filename: `facturas-${timestamp}.xlsx`, format: 'xlsx' };
  } catch (error) { return { error: errorMessage(error), success: false, content: null, filename: null, format: null }; }
}
