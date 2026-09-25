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

/**
 * Totals a tool result declares. Walks the JSON and collects every number stored under a
 * count/total-style key (`total`, `count`, `matched`, `totalOrdersInDateRange`, breakdown
 * counts…) so a claim like "9 ventas" is verified against REAL totals — not against `showing`
 * or page sizes, which are deliberately excluded (a page of 9 is not "9 ventas" of 24).
 */
const TOTAL_KEY = /(?:^|_)(total|count|orders|matched|included|excluded|inrange)(?:$|[a-z_])/i;
const MONEY_KEY = /total|sum|revenue|balance|amount/i;
const MAX_NUMBERS = 400;

export function collectResultNumbers(result: unknown, counts: Set<number>, money: Set<number>, depth = 0): void {
  if (result === null || result === undefined || depth > 8) return;
  if (counts.size + money.size > MAX_NUMBERS) return;
  if (Array.isArray(result)) {
    for (const item of result) collectResultNumbers(item, counts, money, depth + 1);
    return;
  }
  if (typeof result !== 'object') return;
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (TOTAL_KEY.test(key) && Number.isInteger(value) && value >= 0 && value < 1_000_000) counts.add(value);
      if (MONEY_KEY.test(key)) money.add(Math.round(value * 100) / 100);
    } else if (typeof value === 'string' && MONEY_KEY.test(key)) {
      const n = Number(value.replace(/[$,\s]/g, ''));
      if (Number.isFinite(n)) money.add(n);
    } else {
      collectResultNumbers(value, counts, money, depth + 1);
    }
  }
}

const COUNT_CLAIM = /\b(\d{1,5})\s+(?:ventas|órdenes|ordenes|pedidos|registros|resultados|coincidencias|facturas|cotizaciones|compras|pagos)\b/gi;
const MONEY_CLAIM = /(?:total(?:\s+de)?|suman|sumaron|acumul\w*|por un total de|en total)\s+(?:de\s+)?\$?\s*([\d,]+(?:\.\d{1,2})?)/gi;

/**
 * Claims like "9 ventas" or "un total de $59,468" that match NO total the tools returned.
 * The set covers group/breakdown counts too, so legitimate sub-counts pass; a bare number
 * that equals `showing` but not `total` is exactly what this catches.
 */
export function numericClaimsNotInResults(answer: string, counts: Set<number>, money: Set<number>): string[] {
  const issues: string[] = [];
  if (counts.size > 0) {
    const seen = new Set<number>();
    for (const m of answer.matchAll(COUNT_CLAIM)) {
      const n = Number(m[1]);
      if (!Number.isFinite(n) || n === 0 || seen.has(n)) continue;
      seen.add(n);
      if (!counts.has(n)) {
        issues.push(
          `Afirmas "${m[0].trim()}" pero ninguna tool devolvió ese total este turno. ` +
            `Totales reales disponibles: ${[...counts].sort((a, b) => b - a).slice(0, 12).join(', ')}. ` +
            'Corrige con el número del tool result (campo total / reconciliaciones) o vuelve a consultar.'
        );
      }
    }
  }
  if (money.size > 0) {
    const seen = new Set<number>();
    for (const m of answer.matchAll(MONEY_CLAIM)) {
      const n = Number(m[1].replace(/,/g, ''));
      if (!Number.isFinite(n) || n === 0 || seen.has(n)) continue;
      seen.add(n);
      // Allow rounding to the peso and small aggregation drift.
      const ok = [...money].some((t) => Math.abs(t - n) < 1 || (t > 0 && Math.abs(t - n) / t < 0.001));
      if (!ok) {
        issues.push(
          `Afirmas "${m[0].trim()}" pero ninguna tool devolvió esa suma este turno. ` +
            'Usa el campo total/totalSum del resultado o re-consulta antes de dar la cifra.'
        );
      }
    }
  }
  return issues;
}

export function checkAnswer(
  answer: string,
  knownFolios: Set<string>,
  knownTotals?: { counts: Set<number>; money: Set<number> }
): AnswerCheckResult {
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
  if (knownTotals) {
    issues.push(...numericClaimsNotInResults(answer, knownTotals.counts, knownTotals.money));
  }
  return { issues };
}
