import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { formatTimelineLine } from '@/modules/agents/templates';
import { getCaseSnapshot } from '@/modules/operations/case-service';
import { authorizeOperationsChannel, listCaseEvents } from '@/modules/operations/events-service';
import { OperationsError } from '@/modules/operations/errors';
import { getAreaRequest } from '@/modules/operations/area-requests-service';
import { canViewArea, getWorkItem } from '@/modules/operations/work-items-service';
import {
  AI_TURN_EVENT_TYPES,
  AREA_LABELS,
  CASE_PHASE_LABELS,
  isAreaKey,
  type AreaKey,
} from '@/modules/operations/types';
import type { AreaMeta } from './area-registry';
import { areaWorkBranches } from './area-server-registry';
import {
  extraString,
  isOpenRowStatus,
  markSensitive,
  parseWorkRowId,
  priorityLabel,
  rowKindLabel,
  workRowId,
  workRowStatusLabel,
  workRowStatusTone,
  type AreaRowCaseSummary,
  type AreaRowDetail,
  type AreaRowEvidence,
  type AreaRowField,
  type AreaWorkRow,
} from './area-work-row';
import { ensureAreaRegistrations } from './register-all';
import { maskRowFields } from './row-mask';
import { getAreaServer } from './area-server-registry';
import type { AreaWorkQueryState } from './work-filters';
import { buildAreaWorkRowsSql, type AreaWorkRowRecord } from './work-rows-sql';

/**
 * Reads of the area work centres (plan 7.4). SERVER ONLY.
 *
 * Access is the area rule (`canViewArea`: `operations.view`, member of the area
 * channel, area lead or its responsible/backup). Opening ONE row that belongs
 * to a case adds the case rule (`authorizeOperationsChannel('case')`, plan
 * pending 3): `operations.view` alone never opens every case, so the timeline
 * and the case summary are omitted — and said to be omitted — for somebody who
 * only works the area.
 */

const TIMELINE_LIMIT = 20;
const MAX_EXPORT_ROWS = 5000;

export interface AreaWorkRowsPage {
  data: AreaWorkRow[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface AreaWorkOptions {
  now?: Date;
}

/** Throws when the person may not see the area (same rule as the work items service). */
export async function assertAreaAccess(actor: CurrentUser, area: AreaMeta): Promise<void> {
  if (!(await canViewArea(actor, area.key))) {
    throw new OperationsError('forbidden', `No tienes acceso al trabajo de ${area.label}`);
  }
}

function decimalToString(value: Prisma.Decimal | string | number | null): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

function toRow(record: AreaWorkRowRecord, now: Date, names: Map<string, string>): AreaWorkRow {
  const extra =
    record.extra && typeof record.extra === 'object' && !Array.isArray(record.extra)
      ? (record.extra as Record<string, unknown>)
      : {};
  const open = record.open === true && isOpenRowStatus(record.rowKind, record.status);
  const dueAt = record.dueAt ? record.dueAt.toISOString() : null;
  const overdue = open && record.dueAt !== null && record.dueAt.getTime() < now.getTime();
  const priority = record.priority ?? 'normal';
  const ownerUserId = record.ownerUserId;
  return {
    id: workRowId(record.rowKind, record.sourceId),
    rowKind: record.rowKind,
    sourceId: record.sourceId,
    areaKey: record.areaKey ?? '',
    caseId: record.caseId,
    caseNumber: record.caseNumber,
    customerName: record.customerName,
    title: record.title,
    status: record.status,
    statusLabel: workRowStatusLabel(record.rowKind, record.status, extra),
    statusTone: workRowStatusTone(record.rowKind, record.status, { overdue, extra }),
    priority,
    priorityLabel: priorityLabel(priority),
    ownerUserId,
    ownerName: ownerUserId ? (names.get(ownerUserId) ?? null) : null,
    dueAt,
    startedAt: record.startedAt ? record.startedAt.toISOString() : null,
    lastActivityAt: record.lastActivityAt.toISOString(),
    escalationLevel: record.escalationLevel ?? 0,
    waitReason: record.waitReason,
    objectType: record.objectType,
    objectId: record.objectId,
    counterpartyName: counterpartyLabel(record.rowKind, record.counterpartyName),
    locationCode: record.locationCode,
    amount: decimalToString(record.amount),
    quantity: decimalToString(record.quantity),
    version: record.version ?? 1,
    overdue,
    open,
    extra,
  };
}

/** Requests carry an area key as counterparty: show its Spanish label. */
function counterpartyLabel(rowKind: string, value: string | null): string | null {
  if (!value) return null;
  if ((rowKind === 'request_in' || rowKind === 'request_out') && isAreaKey(value)) {
    return AREA_LABELS[value as AreaKey];
  }
  return value;
}

async function resolveNames(records: AreaWorkRowRecord[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.ownerUserId) ids.add(record.ownerUserId);
    const backup = extraString(record.extra as Record<string, unknown> | null, 'backupUserId');
    if (backup) ids.add(backup);
  }
  if (ids.size === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

/** One page of the area work centre, already ordered, filtered and paginated. */
export async function listAreaWorkRows(
  actor: CurrentUser,
  area: AreaMeta,
  query: AreaWorkQueryState,
  options: AreaWorkOptions = {}
): Promise<AreaWorkRowsPage> {
  await assertAreaAccess(actor, area);
  await ensureAreaRegistrations();
  const now = options.now ?? new Date();
  const { rows, count } = buildAreaWorkRowsSql({
    area,
    branches: areaWorkBranches(area),
    query,
    now,
  });
  const [records, totals] = await Promise.all([
    prisma.$queryRaw<AreaWorkRowRecord[]>(rows),
    prisma.$queryRaw<Array<{ count: number }>>(count),
  ]);
  const names = await resolveNames(records);
  const total = Number(totals[0]?.count ?? 0);
  return {
    data: records.map((record) => toRow(record, now, names)),
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.max(1, Math.ceil(total / query.page_size)),
    },
  };
}

/** Rows for an export; `selected` keeps only the ids the person ticked. */
export async function exportAreaWorkRows(
  actor: CurrentUser,
  area: AreaMeta,
  query: AreaWorkQueryState,
  options: {
    scope: 'current_page' | 'selected' | 'filtered';
    selectedIds?: readonly string[];
    now?: Date;
  }
): Promise<AreaWorkRow[]> {
  const pageQuery: AreaWorkQueryState =
    options.scope === 'current_page'
      ? query
      : { ...query, page: 1, page_size: Math.min(MAX_EXPORT_ROWS, 200) };
  if (options.scope !== 'current_page') {
    // Pages of 200 until the export cap: one predictable query per page.
    const collected: AreaWorkRow[] = [];
    let page = 1;
    while (collected.length < MAX_EXPORT_ROWS) {
      const result = await listAreaWorkRows(actor, area, { ...pageQuery, page }, options);
      collected.push(...result.data);
      if (collected.length >= result.pagination.total || result.data.length === 0) break;
      page += 1;
    }
    const rows = collected.slice(0, MAX_EXPORT_ROWS);
    if (options.scope === 'selected' && options.selectedIds) {
      const wanted = new Set(options.selectedIds);
      return rows.filter((row) => wanted.has(row.id));
    }
    return rows;
  }
  // Only `current_page` reaches this point (the rest returned above).
  const result = await listAreaWorkRows(actor, area, pageQuery, options);
  return result.data;
}

/** One row by its `<rowKind>:<sourceId>` id, or null when it is not in this area. */
export async function getAreaWorkRow(
  actor: CurrentUser,
  area: AreaMeta,
  rowId: string,
  options: AreaWorkOptions = {}
): Promise<AreaWorkRow | null> {
  await assertAreaAccess(actor, area);
  await ensureAreaRegistrations();
  const parsed = parseWorkRowId(rowId);
  if (!parsed) return null;
  const branch = areaWorkBranches(area).find((entry) => entry.rowKind === parsed.rowKind);
  if (!branch) return null;
  const now = options.now ?? new Date();
  const union = branch.sql({ areaKey: area.key, scope: 'all', now });
  const records = await prisma.$queryRaw<AreaWorkRowRecord[]>(
    Prisma.sql`SELECT rows.* FROM (${union}) AS rows WHERE rows."sourceId" = ${parsed.sourceId} LIMIT 1`
  );
  const record = records[0];
  if (!record) return null;
  const names = await resolveNames([record]);
  return toRow(record, now, names);
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Mexico_City',
};

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('es-MX', DATE_FORMAT).format(date);
  } catch {
    return date.toISOString();
  }
}

function field(
  label: string,
  value: string | null | undefined,
  hint?: string | null
): AreaRowField | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { label, value: text, hint: hint ?? null } : null;
}

function compact(fields: Array<AreaRowField | null>): AreaRowField[] {
  return fields.filter((entry): entry is AreaRowField => entry !== null);
}

function humanizeKey(key: string): string {
  const text = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_.]+/g, ' ')
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : key;
}

/** Up to six scalar entries of a request payload, as readable facts. */
function payloadFields(payload: unknown): AreaRowField[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const out: AreaRowField[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (out.length >= 6) break;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim()) {
      out.push({ label: humanizeKey(key), value: value.slice(0, 200), hint: null });
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push({ label: humanizeKey(key), value: String(value), hint: null });
    }
  }
  return out;
}

function baseFields(area: AreaMeta, row: AreaWorkRow): AreaRowField[] {
  const extras = (area.workCenter.extraColumns ?? []).map((column) => {
    const raw = row.extra[column.field];
    if (raw === null || raw === undefined || raw === '') return null;
    const value = column.type === 'date' ? formatDate(String(raw)) : String(raw).slice(0, 200);
    const entry = field(column.label, value);
    return column.type === 'currency' ? markSensitive(entry, 'amount') : entry;
  });
  return compact([
    field('Tipo', rowKindLabel(row.rowKind)),
    field('Estado', row.statusLabel),
    field('Responsable', row.ownerName),
    field('Vence', row.dueAt ? formatDate(row.dueAt) : null),
    field('Expediente', row.caseNumber),
    // El NOMBRE del cliente identifica la fila (la tabla ya tiene su columna) y
    // tampoco lo oculta la Torre: enmascarar el dato de contacto es lo que hace
    // `maskNode`, que borra `contact` pero deja `label`/`sublabel`.
    field('Cliente', row.customerName),
    field('Contraparte', row.counterpartyName),
    field('Ubicación', row.locationCode),
    markSensitive(field('Importe', row.amount), 'amount'),
    field('Cantidad', row.quantity),
    field('Última actividad', formatDate(row.lastActivityAt)),
    ...extras,
  ]);
}

function toEvidence(items: Array<Record<string, unknown>>): AreaRowEvidence[] {
  return items.slice(0, 20).map((item) => ({
    id: String(item.id ?? ''),
    kind: String(item.kind ?? 'document'),
    label: String(item.kindLabel ?? item.kind ?? 'Evidencia'),
    note: typeof item.note === 'string' ? item.note : null,
    createdAt: String(item.createdAt ?? ''),
    createdByName: typeof item.createdByName === 'string' ? item.createdByName : null,
    storageObjectId:
      item.file && typeof item.file === 'object'
        ? String((item.file as Record<string, unknown>).objectId ?? '') || null
        : null,
  }));
}

function toCaseSummary(
  snapshot: Awaited<ReturnType<typeof getCaseSnapshot>>
): AreaRowCaseSummary | null {
  if (!snapshot) return null;
  const phase = snapshot.case.phase as keyof typeof CASE_PHASE_LABELS;
  return {
    caseId: snapshot.case.id,
    caseNumber: snapshot.case.caseNumber,
    statusLabel: snapshot.case.statusLabel,
    phaseLabel: CASE_PHASE_LABELS[phase] ?? snapshot.case.phaseLabel,
    customerName: snapshot.case.customerName,
    salesOrderNumber: snapshot.case.salesOrderNumber,
    ownerName: snapshot.case.ownerName,
    promisedAt: snapshot.case.promisedAt,
    openWorkItems: snapshot.openWorkItems.length,
    openRequests: snapshot.requests.length,
    openIncidents: snapshot.incidents.length,
    demands: snapshot.demands.slice(0, 8).map((demand) => ({
      name: demand.name,
      quantity: demand.quantity,
      unit: demand.unit,
      statusLabel: workRowStatusLabel('demand', demand.status),
    })),
  };
}

/**
 * Case context of a row: timeline (without the AI audit events) and summary,
 * only for somebody the case rule lets in. `caseRestricted` says so out loud
 * instead of showing an empty drawer.
 */
async function caseContext(
  actor: CurrentUser,
  caseId: string
): Promise<{
  timeline: string[];
  caseSummary: AreaRowCaseSummary | null;
  caseRestricted: boolean;
}> {
  const allowed = await authorizeOperationsChannel(actor, 'case', caseId);
  if (!allowed) return { timeline: [], caseSummary: null, caseRestricted: true };
  const [page, snapshot] = await Promise.all([
    listCaseEvents(caseId, { limit: TIMELINE_LIMIT, excludeTypes: AI_TURN_EVENT_TYPES }),
    getCaseSnapshot(caseId).catch(() => null),
  ]);
  const timeline = page.events.map((event) =>
    formatTimelineLine({
      id: event.id,
      type: event.type,
      occurredAt: new Date(event.occurredAt),
      areaKey: event.areaKey,
      actorType: event.actorType,
      payload: event.payload,
    })
  );
  return { timeline, caseSummary: toCaseSummary(snapshot), caseRestricted: false };
}

/**
 * Everything the drawer and the detail page show for one row: facts, case
 * timeline, evidence and where new evidence goes. The area's own row kinds add
 * their part through `getRowDetail` of the server registry.
 */
export async function getWorkRowDetail(
  actor: CurrentUser,
  area: AreaMeta,
  rowId: string,
  options: AreaWorkOptions = {}
): Promise<AreaRowDetail | null> {
  const now = options.now ?? new Date();
  const row = await getAreaWorkRow(actor, area, rowId, { now });
  if (!row) return null;

  const detail: AreaRowDetail = {
    row,
    fields: baseFields(area, row),
    timeline: [],
    evidence: [],
    evidenceTargetId: null,
    missingEvidence: [],
    caseSummary: null,
    freeText: null,
    caseRestricted: false,
  };

  if (row.rowKind === 'work_item') {
    const item = await getWorkItem(actor, row.sourceId, { now });
    detail.fields = compact([
      field('Tipo de trabajo', item.kindLabel),
      field('Estado', item.statusLabel),
      field('Responsable', item.ownerName),
      field('Suplente', item.backupName),
      field('Vence', formatDate(item.dueAt)),
      field('Expediente', item.caseNumber),
      field('Cliente', item.customerName),
      field(
        'Motivo de la espera',
        item.waitReason,
        item.waitUntil ? `Hasta ${formatDate(item.waitUntil)}` : null
      ),
      field('Descripción', item.description),
      item.escalationLevel > 0 ? field('Escalación', `Nivel ${item.escalationLevel}`) : null,
    ]);
    detail.evidence = toEvidence(item.evidence as unknown as Array<Record<string, unknown>>);
    detail.missingEvidence = item.missingEvidence;
    detail.evidenceTargetId = `work_item:${item.id}`;
  } else if (row.rowKind === 'request_in' || row.rowKind === 'request_out') {
    const request = await getAreaRequest(actor, row.sourceId, { now });
    detail.fields = compact([
      field('Tipo de solicitud', request.kindLabel),
      field('De', request.fromAreaLabel),
      field('Para', request.toAreaLabel),
      field('Estado', request.statusLabel),
      field('Prioridad', request.priorityLabel),
      field('Vence', formatDate(request.dueAt)),
      field('Responsable', request.ownerName),
      field('Suplente', request.backupName),
      field('Expediente', request.caseNumber),
      request.blocksDelivery ? field('Bloquea la entrega', 'Sí') : null,
      field('Respondida', request.answeredAt ? formatDate(request.answeredAt) : null),
      ...payloadFields(request.payload),
      typeof request.answer === 'string' ? field('Respuesta', request.answer) : null,
    ]);
    detail.freeText = request.freeText;
    // Evidence of a request travels through the work item the engine created for it.
    detail.evidenceTargetId = request.workItemId ? `work_item:${request.workItemId}` : null;
  } else {
    const extra = await getAreaServer(area.key).getRowDetail?.(actor, row, { now });
    if (extra) {
      detail.fields = extra.fields ?? detail.fields;
      detail.evidence = extra.evidence ?? detail.evidence;
      detail.evidenceTargetId = extra.evidenceTargetId ?? detail.evidenceTargetId;
      detail.missingEvidence = extra.missingEvidence ?? detail.missingEvidence;
      detail.freeText = extra.freeText ?? detail.freeText;
    }
  }

  if (row.caseId) {
    const context = await caseContext(actor, row.caseId);
    detail.timeline = context.timeline;
    detail.caseSummary = context.caseSummary;
    detail.caseRestricted = context.caseRestricted;
  }

  /*
   * Enmascarado del detalle (plan 7.2), con la MISMA tabla de la Torre de
   * Control: los importes exigen `finance.view` y los datos de contacto
   * `customers.view`. Se aplica al final, así que cubre tanto los campos del
   * núcleo como los que agregó la rama de dominio del área — ninguna rama
   * puede olvidarse de aplicarlo, sólo de marcar su campo.
   */
  detail.fields = maskRowFields(detail.fields, {
    permissionKeys: actor.permissionKeys as string[],
    isSuperAdmin: actor.isSuperAdmin,
  });

  return detail;
}
