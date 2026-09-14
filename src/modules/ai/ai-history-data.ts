/**
 * Locates the most recent DATA tool result in a conversation history so that artifact tools
 * (PDF, Excel, CSV, image, table) can be fed the real rows instead of whatever the model
 * re-types from memory.
 *
 * Pure (no Prisma/LLM imports) so it is unit-testable. Rules:
 * - Artifact results (a PDF, a rendered table, an image...) are NOT data: they are skipped, so
 *   "dame un PDF" right after "generateTable" still finds the querySalesOrders rows underneath.
 *   (Before this, the scan stopped at the generateTable result, found no rows, and the PDF tool
 *   returned "No hay datos" in 0 ms — the "problema técnico persistente" the user saw.)
 * - Error results are skipped.
 * - The originating tool call is resolved by `toolCallId`, never by "the last call of the
 *   previous assistant message" (which is wrong whenever one message issued several calls).
 */

export interface HistoryMessageLike {
  role: string;
  content: string | null;
  toolCallId?: string | null;
  toolCalls?: unknown;
}

export interface LastDataToolResult {
  result: Record<string, unknown>;
  rows: Record<string, unknown>[];
  /** Field of `result` that `rows` came from (so every export page reads the same field). */
  rowKey: string;
  /** Every array-of-objects field in the result, keyed by field name (for multi-section PDFs). */
  arrays: Record<string, Record<string, unknown>[]>;
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
}

export const ARTIFACT_TOOL_NAMES = new Set([
  'generatePdfReport',
  'generateExcelReport',
  'generateWordReport',
  'generateCsvExport',
  'generateChart',
  'generateReportImage',
  'generateTable',
  'listArtifacts',
  'cleanupArtifacts',
]);

const ARTIFACT_RESULT_TYPES = new Set(['pdf', 'excel', 'xlsx', 'csv', 'chart', 'image', 'table', 'markdown']);

/** True when a parsed tool result describes a generated artifact rather than business data. */
export function isArtifactResult(parsed: Record<string, unknown>): boolean {
  if (Array.isArray(parsed.artifacts)) return true;
  if (typeof parsed.artifactId === 'string') return true;
  if (typeof parsed.type === 'string' && ARTIFACT_RESULT_TYPES.has(parsed.type) && ('downloadUrl' in parsed || 'inlineRender' in parsed)) {
    return true;
  }
  return false;
}

/** All top-level array-of-object fields of a tool result. */
export function collectRowArrays(result: Record<string, unknown>): Record<string, Record<string, unknown>[]> {
  const arrays: Record<string, Record<string, unknown>[]> = {};
  for (const key of Object.keys(result)) {
    const val = result[key];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      arrays[key] = val as Record<string, unknown>[];
    }
  }
  return arrays;
}

/** Array fields that DESCRIBE a result (breakdowns, examples) instead of being its records. */
const SUMMARY_ARRAY_KEY = /(breakdown|distribution|summary|reconciliation|examples?|samples?)$/i;
/** Names data tools use for their main list of records, most common first. */
const PRIMARY_ROW_KEYS = [
  'orders', 'rows', 'records', 'results', 'invoices', 'bills', 'payments', 'packages',
  'purchaseOrders', 'vendorCredits', 'quotes', 'contacts', 'customers', 'vendors', 'products', 'groups',
];

/**
 * The array that holds the RECORDS of a data result — what a report must list.
 *
 * Never "the first array": querySalesOrders returns `ticketStatusBreakdown` (1-3 summary rows)
 * BEFORE `orders`, so the first-array rule exported the breakdown, and the orchestrator then kept
 * the 9 rows the model had hand-typed because they were "more" — a PDF with 9 of 65 orders under
 * KPI cards that said 65 (bug reported 2026-09-14).
 */
export function pickPrimaryRowArray(result: Record<string, unknown>): { key: string; rows: Record<string, unknown>[] } | null {
  const arrays = collectRowArrays(result);
  const keys = Object.keys(arrays);
  if (keys.length === 0) return null;
  const records = keys.filter((k) => !SUMMARY_ARRAY_KEY.test(k));
  const pool = records.length > 0 ? records : keys;
  const showing = typeof result.showing === 'number' ? result.showing : NaN;
  const sameSizeAsShowing = pool.filter((k) => arrays[k].length === showing);
  const key =
    (sameSizeAsShowing.length === 1 ? sameSizeAsShowing[0] : undefined) ??
    PRIMARY_ROW_KEYS.find((k) => pool.includes(k)) ??
    pool[0];
  return { key, rows: arrays[key] };
}

/**
 * How many records a paginated list result says match in total, or null when the result does
 * not declare it (grouped results, summaries, or a `total` that is money rather than a count).
 */
export function declaredRowTotal(result: Record<string, unknown>): number | null {
  if (result.mode === 'grouped') return null;
  const paged = result.mode === 'list' || typeof result.showing === 'number' || typeof result.totalPages === 'number';
  if (!paged || typeof result.total !== 'number') return null;
  return Number.isInteger(result.total) && result.total >= 0 ? result.total : null;
}

export interface ReportRowsDecision {
  rows: Record<string, unknown>[];
  source: 'system' | 'model';
  expectedRows: number | null;
  includedRows: number;
  complete: boolean;
  /** Set when the report must NOT be generated because it would silently miss rows. */
  blockReason?: string;
}

/**
 * Decides which rows go into a report (PDF/Excel/CSV/image/table) and whether it may be delivered.
 * A report is never allowed to hold fewer rows than the query declared unless that is explicit:
 * the user picked a subset (subsetOnly) or the export cap was hit — both are labeled, never silent.
 */
export function resolveReportRows(input: {
  modelRows: Record<string, unknown>[] | null;
  systemRows: Record<string, unknown>[];
  expectedRows: number | null;
  subsetOnly: boolean;
  exportCap: number;
}): ReportRowsDecision {
  const { modelRows, systemRows, expectedRows: expected, subsetOnly, exportCap } = input;

  if (subsetOnly && modelRows && modelRows.length > 0) {
    const n = modelRows.length;
    return { rows: modelRows, source: 'model', expectedRows: expected, includedRows: n, complete: expected === null || n >= expected };
  }

  const systemComplete = expected === null || systemRows.length >= expected;
  if (systemComplete && modelRows && modelRows.length > systemRows.length) {
    // The model merged several results: more rows than the last query holds.
    return { rows: modelRows, source: 'model', expectedRows: expected, includedRows: modelRows.length, complete: true };
  }
  if (systemComplete) {
    return { rows: systemRows, source: 'system', expectedRows: expected, includedRows: systemRows.length, complete: true };
  }
  if (expected !== null && expected > exportCap && systemRows.length >= exportCap) {
    // Too many rows for one file: deliver the cap, labeled as partial.
    return { rows: systemRows, source: 'system', expectedRows: expected, includedRows: systemRows.length, complete: false };
  }
  return {
    rows: systemRows,
    source: 'system',
    expectedRows: expected,
    includedRows: systemRows.length,
    complete: false,
    blockReason:
      `El reporte NO se generó: solo se obtuvieron ${systemRows.length} de ${expected} filas de la consulta y entregar un archivo incompleto está prohibido. ` +
      'Vuelve a llamar la tool de datos con los mismos filtros y en cuanto responda genera el reporte de nuevo. Si vuelve a fallar, dile al usuario exactamente eso; no entregues ni describas un reporte parcial.',
  };
}

/**
 * Scans the history from newest to oldest and returns the last successful DATA tool result
 * that carries at least one array of rows, together with the call that produced it.
 */
export function findLastDataToolResult(history: HistoryMessageLike[]): LastDataToolResult | null {
  // toolCallId → call (name + parsed args), from every assistant message in the history.
  const callsById = new Map<string, { name: string; args: Record<string, unknown> | null }>();
  for (const m of history) {
    if (m.role !== 'assistant' || !Array.isArray(m.toolCalls)) continue;
    for (const tc of m.toolCalls as Array<{ id?: string; name?: string; arguments?: string }>) {
      if (!tc?.id || !tc.name) continue;
      let args: Record<string, unknown> | null = null;
      if (typeof tc.arguments === 'string') {
        try {
          const parsed = JSON.parse(tc.arguments);
          args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
          args = null;
        }
      }
      callsById.set(tc.id, { name: tc.name, args });
    }
  }

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'tool' || !m.content) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(m.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const result = parsed as Record<string, unknown>;
    if (result.error) continue;

    const call = m.toolCallId ? callsById.get(m.toolCallId) ?? null : null;
    if (call && ARTIFACT_TOOL_NAMES.has(call.name)) continue;
    if (isArtifactResult(result)) continue;

    const primary = pickPrimaryRowArray(result);
    if (!primary) continue;

    return {
      result,
      rows: primary.rows,
      rowKey: primary.key,
      arrays: collectRowArrays(result),
      toolName: call?.name ?? null,
      toolArgs: call?.args ?? null,
    };
  }
  return null;
}
