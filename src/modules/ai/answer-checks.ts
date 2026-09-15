/**
 * Deterministic checks on a finished answer, run before it is delivered:
 *
 * - every sales-order folio the answer cites must have come back from a tool
 *   in this turn (a folio nobody returned is a hallucination or a typo);
 * - a group heading that announces a count ("### Recolección — 20",
 *   "Producción (14)") must be followed by a markdown table with that many rows.
 *
 * Findings go back to the model as an internal correction note; the user
 * never sees the draft. Pure — unit tested.
 */

const FOLIO_IN_TEXT = /\bOV-?\s?(\d{4,7})\b/gi;
const FOLIO_IN_JSON = /"(?:number|salesOrderNumber|requested|likely|written|actual|orden|folio|orderNumber)":"(?:OV-?)?(\d{4,7})"/g;
const MAX_JSON_SCAN = 3_000_000;

/** Folios present in a tool result (any depth). Numbers and "OV-" strings in the usual fields. */
export function collectFolios(result: unknown, into: Set<string>): void {
  if (result === null || result === undefined) return;
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch {
    return;
  }
  if (!json || json.length > MAX_JSON_SCAN) return;
  for (const m of json.matchAll(FOLIO_IN_TEXT)) into.add(m[1]);
  for (const m of json.matchAll(FOLIO_IN_JSON)) into.add(m[1]);
}

/** Folios the answer mentions that no tool of this turn returned. Empty when the turn returned none. */
export function citedFoliosNotInResults(answer: string, known: Set<string>): string[] {
  if (known.size === 0) return [];
  const cited = new Set<string>();
  for (const m of answer.matchAll(FOLIO_IN_TEXT)) cited.add(m[1]);
  return [...cited].filter((f) => !known.has(f));
}

const COUNT_IN_HEADING = /(?:\((\d{1,4})\)|[—–-]\s*(\d{1,4})\s*(?:órdenes|ordenes|registros|filas|casos|clientes|productos)?\s*$|\b(\d{1,4})\s+(?:órdenes|ordenes|registros|filas|casos|clientes|productos)\b)/i;

/** "### Recolección — 20" followed by a table of 12 rows → one issue. */
export function findMarkdownCountMismatches(answer: string): string[] {
  const lines = answer.split('\n');
  const issues: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isHeading = /^#{1,6}\s+/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line);
    if (!isHeading) continue;
    const label = line.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').trim();
    const m = label.match(COUNT_IN_HEADING);
    if (!m) continue;
    const declared = Number(m[1] ?? m[2] ?? m[3]);
    if (!Number.isFinite(declared) || declared === 0) continue;
    // Next table before the next heading.
    let j = i + 1;
    while (j < lines.length && !/^\|/.test(lines[j].trim()) && !/^#{1,6}\s+/.test(lines[j].trim())) j++;
    if (j >= lines.length || !/^\|/.test(lines[j].trim())) continue;
    let rows = 0;
    let k = j;
    while (k < lines.length && /^\|/.test(lines[k].trim())) {
      rows++;
      k++;
    }
    const dataRows = Math.max(0, rows - 2); // header + separator
    if (dataRows !== declared) issues.push(`"${label}" anuncia ${declared} pero la tabla trae ${dataRows} filas`);
  }
  return issues;
}

export interface AnswerCheckResult {
  issues: string[];
}

export function checkAnswer(answer: string, knownFolios: Set<string>): AnswerCheckResult {
  const issues: string[] = [];
  const ghosts = citedFoliosNotInResults(answer, knownFolios);
  if (ghosts.length > 0) {
    issues.push(
      `Folios citados que NINGUNA tool devolvió en este turno (posible error de dígito o invención): ${ghosts
        .slice(0, 12)
        .map((f) => `OV-${f}`)
        .join(', ')}${ghosts.length > 12 ? ` y ${ghosts.length - 12} más` : ''}. Verifícalos con lookupSalesOrdersByNumber o quítalos.`
    );
  }
  issues.push(...findMarkdownCountMismatches(answer).map((i) => `${i}: corrige el conteo o completa la tabla.`));
  return { issues };
}
