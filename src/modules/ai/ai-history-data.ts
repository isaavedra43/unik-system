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
  /** Every array-of-objects field in the result, keyed by field name (for multi-section PDFs). */
  arrays: Record<string, Record<string, unknown>[]>;
  toolName: string | null;
  toolArgs: Record<string, unknown> | null;
}

export const ARTIFACT_TOOL_NAMES = new Set([
  'generatePdfReport',
  'generateExcelReport',
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

    const arrays = collectRowArrays(result);
    const firstKey = Object.keys(arrays)[0];
    if (!firstKey) continue;

    return {
      result,
      rows: arrays[firstKey],
      arrays,
      toolName: call?.name ?? null,
      toolArgs: call?.args ?? null,
    };
  }
  return null;
}
