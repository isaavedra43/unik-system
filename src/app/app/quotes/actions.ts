'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { assertPermission, AuthorizationError, getCurrentSession } from '@/modules/auth/authorization';
import { upsertUserTablePreference, deleteUserTablePreference } from '@/modules/sales/table-preferences-service';
import { createTableView } from '@/modules/sales/table-views-service';
import { watchEntity, unwatchEntity, bulkWatchEntities, bulkUnwatchEntities } from '@/modules/sales/entity-watch-service';
import { tablePreferenceConfigSchema, tableViewVisibilitySchema, type TablePreferenceConfig } from '@/modules/quotes/quotes-filters';
import { QUOTES_TABLE_KEY } from '@/modules/quotes/quotes-columns';
import { QUOTE_ENTITY_TYPE } from '@/modules/quotes/permissions';
import { recordAuditEvent } from '@/modules/auth/audit-service';
import { formatExportValue } from '@/modules/quotes/quotes-service';
import type { QuoteDetail } from '@/modules/quotes/quotes-contract';
import { quoteStatusActionSchema, type QuoteFormInput, type QuoteEmailInput } from '@/modules/quotes/quotes-form-schema';
import {
  createQuote, updateQuote, changeQuoteStatus, emailQuote, cloneQuote, refreshQuoteFromZoho,
  QuoteWriteError, QuoteConflictError,
} from '@/modules/quotes/quotes-write-service';

const QUOTES_PATH = '/app/quotes';

function errorMessage(error: unknown): string {
  if (error instanceof AuthorizationError) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? 'Datos inválidos';
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
// Table preferences / views / watch / export (same contract as invoices)
// ---------------------------------------------------------------------------

export async function saveTablePreferenceJson(config: TablePreferenceConfig): Promise<{ error: string | null; success: boolean }> {
  try {
    const actor = await requireActor('quotes.view');
    const parsed = tablePreferenceConfigSchema.parse(config);
    await upsertUserTablePreference(actor.id, QUOTES_TABLE_KEY, parsed);
    return { error: null, success: true };
  } catch (error) { return { error: errorMessage(error), success: false }; }
}

export async function resetTablePreferenceAction(): Promise<{ error: string | null; success: boolean }> {
  try {
    const actor = await requireActor('quotes.view');
    await deleteUserTablePreference(actor.id, QUOTES_TABLE_KEY);
    revalidatePath(QUOTES_PATH);
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
    const actor = await requireActor('quotes.view');
    const parsed = createViewSchema.safeParse({
      name: formData.get('name'), visibility: formData.get('visibility') ?? 'private',
      config: formData.get('config'), isDefault: formData.get('isDefault') === 'true',
    });
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos', success: false, viewId: null };
    let config: unknown;
    try { config = JSON.parse(parsed.data.config); } catch { return { error: 'Configuración inválida', success: false, viewId: null }; }
    const view = await createTableView(actor, { tableKey: QUOTES_TABLE_KEY, name: parsed.data.name, visibility: parsed.data.visibility, config, isDefault: parsed.data.isDefault });
    revalidatePath(QUOTES_PATH);
    return { error: null, success: true, viewId: view.id };
  } catch (error) { return { error: errorMessage(error), success: false, viewId: null }; }
}

const watchSchema = z.object({ entityId: z.string().min(1) });
type WatchState = { error: string | null; success: boolean; isWatched: boolean };

export async function watchAction(_prevState: WatchState, formData: FormData): Promise<WatchState> {
  try {
    const actor = await requireActor('quotes.watch');
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    await watchEntity(actor, QUOTE_ENTITY_TYPE, parsed.data.entityId);
    revalidatePath(QUOTES_PATH);
    return { error: null, success: true, isWatched: true };
  } catch (error) { return { error: errorMessage(error), success: false, isWatched: false }; }
}

export async function unwatchAction(_prevState: WatchState, formData: FormData): Promise<WatchState> {
  try {
    const actor = await requireActor('quotes.watch');
    const parsed = watchSchema.safeParse({ entityId: formData.get('entityId') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    await unwatchEntity(actor, QUOTE_ENTITY_TYPE, parsed.data.entityId);
    revalidatePath(QUOTES_PATH);
    return { error: null, success: true, isWatched: false };
  } catch (error) { return { error: errorMessage(error), success: false, isWatched: false }; }
}

const bulkWatchSchema = z.object({ entityIds: z.array(z.string()).default([]), action: z.enum(['watch', 'unwatch']) });

export async function bulkWatchAction(_prevState: WatchState, formData: FormData): Promise<WatchState> {
  try {
    const actor = await requireActor('quotes.watch');
    const parsed = bulkWatchSchema.safeParse({ entityIds: formData.getAll('entityIds').map(String), action: formData.get('action') });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, isWatched: false };
    if (parsed.data.action === 'watch') await bulkWatchEntities(actor, QUOTE_ENTITY_TYPE, parsed.data.entityIds);
    else await bulkUnwatchEntities(actor, QUOTE_ENTITY_TYPE, parsed.data.entityIds);
    revalidatePath(QUOTES_PATH);
    return { error: null, success: true, isWatched: parsed.data.action === 'watch' };
  } catch (error) { return { error: errorMessage(error), success: false, isWatched: false }; }
}

const exportSchema = z.object({
  format: z.enum(['csv', 'xlsx']), scope: z.enum(['current_page', 'selected', 'filtered']),
  selectedIds: z.array(z.string()).optional(), includeAllColumns: z.boolean().optional(), query: z.string(),
});
type ExportState = { error: string | null; success: boolean; content: string | null; filename: string | null; format: string | null };

export async function exportAction(_prevState: ExportState, formData: FormData): Promise<ExportState> {
  try {
    const actor = await requireActor('quotes.export');
    const parsed = exportSchema.safeParse({
      format: formData.get('format'), scope: formData.get('scope'),
      selectedIds: formData.getAll('selectedIds').map(String),
      includeAllColumns: formData.get('includeAllColumns') === 'true', query: formData.get('query'),
    });
    if (!parsed.success) return { error: 'Datos inválidos', success: false, content: null, filename: null, format: null };
    let query: unknown;
    try { query = JSON.parse(parsed.data.query); } catch { return { error: 'Query inválida', success: false, content: null, filename: null, format: null }; }

    const { getQuotesForExport, buildCsv } = await import('@/modules/quotes/quotes-service');
    const { rows, columns } = await getQuotesForExport(query, {
      format: parsed.data.format, scope: parsed.data.scope,
      selectedIds: parsed.data.selectedIds, includeAllColumns: parsed.data.includeAllColumns,
    }, actor.id);
    const timestamp = new Date().toISOString().split('T')[0];

    if (parsed.data.format === 'csv') {
      const csv = buildCsv(rows, columns);
      const content = Buffer.from('\ufeff' + csv, 'utf-8').toString('base64');
      await recordAuditEvent({ actorUserId: actor.id, action: 'quotes.exported', targetType: 'Quote', metadata: { format: 'csv', rowCount: rows.length, scope: parsed.data.scope } });
      return { error: null, success: true, content, filename: `cotizaciones-${timestamp}.csv`, format: 'csv' };
    }

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Cotizaciones');
    sheet.columns = columns.map((c) => ({ header: c.label, key: c.id, width: Math.min(Math.max(c.defaultWidth / 8, 12), 40) }));
    for (const row of rows) {
      const rowData: Record<string, unknown> = {};
      for (const col of columns) {
        const val = (row as unknown as Record<string, unknown>)[col.id];
        if (val === null || val === undefined) rowData[col.id] = '';
        else if (col.type === 'currency' || col.type === 'number') rowData[col.id] = Number(val);
        else rowData[col.id] = formatExportValue(row, col.id);
      }
      sheet.addRow(rowData);
    }
    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    const content = Buffer.from(buffer).toString('base64');
    await recordAuditEvent({ actorUserId: actor.id, action: 'quotes.exported', targetType: 'Quote', metadata: { format: 'xlsx', rowCount: rows.length, scope: parsed.data.scope } });
    return { error: null, success: true, content, filename: `cotizaciones-${timestamp}.xlsx`, format: 'xlsx' };
  } catch (error) { return { error: errorMessage(error), success: false, content: null, filename: null, format: null }; }
}

// ---------------------------------------------------------------------------
// Write actions (Zoho Books)
// ---------------------------------------------------------------------------

export interface QuoteWriteResult {
  error: string | null;
  code: string | null;
  success: boolean;
  quote: QuoteDetail | null;
  /** Set on CONFLICT: the refreshed quote as Zoho has it now. */
  conflictQuote?: QuoteDetail | null;
}

function toWriteResult(error: unknown): QuoteWriteResult {
  if (error instanceof QuoteConflictError) return { error: error.message, code: error.code, success: false, quote: null, conflictQuote: error.quote };
  if (error instanceof QuoteWriteError) return { error: error.message, code: error.code, success: false, quote: null };
  return { error: errorMessage(error), code: 'ERROR', success: false, quote: null };
}

export async function createQuoteAction(input: QuoteFormInput): Promise<QuoteWriteResult> {
  try {
    const actor = await requireActor('quotes.create');
    const quote = await createQuote(actor, input);
    revalidatePath(QUOTES_PATH);
    return { error: null, code: null, success: true, quote };
  } catch (error) { return toWriteResult(error); }
}

export async function updateQuoteAction(quoteId: string, input: QuoteFormInput): Promise<QuoteWriteResult> {
  try {
    const actor = await requireActor('quotes.edit');
    const quote = await updateQuote(actor, quoteId, input);
    revalidatePath(QUOTES_PATH);
    revalidatePath(`${QUOTES_PATH}/${quoteId}`);
    return { error: null, code: null, success: true, quote };
  } catch (error) { return toWriteResult(error); }
}

export async function changeQuoteStatusAction(quoteId: string, action: string): Promise<QuoteWriteResult> {
  try {
    const actor = await requireActor('quotes.change_status');
    const parsed = quoteStatusActionSchema.safeParse(action);
    if (!parsed.success) return { error: 'Acción inválida', code: 'INVALID_ACTION', success: false, quote: null };
    const quote = await changeQuoteStatus(actor, quoteId, parsed.data);
    revalidatePath(QUOTES_PATH);
    revalidatePath(`${QUOTES_PATH}/${quoteId}`);
    return { error: null, code: null, success: true, quote };
  } catch (error) { return toWriteResult(error); }
}

export async function emailQuoteAction(quoteId: string, input: QuoteEmailInput): Promise<QuoteWriteResult> {
  try {
    const actor = await requireActor('quotes.send_email');
    const quote = await emailQuote(actor, quoteId, input);
    revalidatePath(QUOTES_PATH);
    revalidatePath(`${QUOTES_PATH}/${quoteId}`);
    return { error: null, code: null, success: true, quote };
  } catch (error) { return toWriteResult(error); }
}

export async function cloneQuoteAction(quoteId: string, requestKey: string): Promise<QuoteWriteResult> {
  try {
    const actor = await requireActor('quotes.create');
    const quote = await cloneQuote(actor, quoteId, requestKey);
    revalidatePath(QUOTES_PATH);
    return { error: null, code: null, success: true, quote };
  } catch (error) { return toWriteResult(error); }
}

export async function refreshQuoteAction(quoteId: string): Promise<QuoteWriteResult> {
  try {
    const actor = await requireActor('quotes.view');
    const quote = await refreshQuoteFromZoho(quoteId, actor.id);
    revalidatePath(`${QUOTES_PATH}/${quoteId}`);
    return { error: null, code: null, success: true, quote };
  } catch (error) { return toWriteResult(error); }
}
