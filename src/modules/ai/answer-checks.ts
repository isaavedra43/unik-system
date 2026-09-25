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

// ─── Source & action claims ──────────────────────────────────────────────────
//
// The checks above verify DATA claims (folios, counts, sums). This block verifies
// SOURCE claims — the failure seen in production was the model writing "busqué
// en internet" while only an internal DB tool ran. An answer may only claim a
// source if the matching tool executed this turn.

/** The sentence admits the capability is missing — never flag honesty. */
const ADMISSION = /no (puedo|tengo|cuento|pude|logr[ée])|sin acceso|no está (disponible|habilitad|configurad)|est[áa] deshabilitad|no me es posible|aún no (puedo|tengo|está)|imposible|no tengo forma|no fue posible|no pude/i;

/** References an earlier turn ("la semana pasada vimos…") — memory is a real source. */
const PAST_OR_OTHER_TURN = /\b(antes|anterior|la semana pasada|ayer|esa vez|anteriormente|hace \d|el (lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)|conversaci[óo]n anterior|te hab[íi]a|ya vimos|como te dije)\b/i;

/** Offer or future tense ("puedo buscar", "voy a revisar") — not a claim of having done it. */
const OFFER_OR_FUTURE = /\b(puedo|podr[íi]a|podr[íi]as|quieres que|voy a|buscar[ée]|revisar[ée]|consultar[ée]|si quieres|puedes pedirme|har[ée]|har[íi]a|te puedo|puedo intentar)\b/i;

interface SourceRule {
  id: string;
  /** Human label of the claimed capability (for the issue text). */
  label: string;
  /** The source/context noun the sentence must mention. */
  source: RegExp;
  /** A verb/phrase proving the claim is that the action WAS performed. */
  action: RegExp;
  /** Tool names that satisfy the claim. */
  tools: RegExp;
}

const SOURCE_RULES: readonly SourceRule[] = [
  {
    id: 'web',
    label: 'internet/páginas web',
    source: /\b(internet|la web|google|amazon|mercado\s?libre|linkedin|facebook|instagram|tiktok|youtube|twitter|x\.com|en l[íi]nea|online|sitios? web|p[áa]ginas? web|el sitio (web )?de|la red)\b/i,
    action:
      /\b(busqu|encontr|revis|consult|investig|explor|naveg|abr[íi]|entr|visit|le[íi]|analiz|descargu|verifiqu|comprob|mir|a trav[ée]s de|seg[úu]n)/i,
    tools: /^(web_search|web_research|web_crawl|fetch_url|browser|browserProfile|venueScreenshot)$/,
  },
  {
    id: 'erp',
    label: 'la base de datos/el sistema UNIK',
    source: /\b(la base de datos|el sistema|el erp|el cat[áa]logo|la plataforma|en unik|el inventario|los registros)\b/i,
    action: /\b(busqu|encontr|revis|consult|verifiqu|comprob|mir|hay|tiene|existen|registr|cuenta con)/i,
    tools:
      /^(query|get|list|find|search|lookup|compare|audit|count|extract|read)\w*$|^universalSearch$|^getDatabaseOverview$|__/,
  },
  {
    id: 'send',
    label: 'envío de mensajes/notificaciones',
    source: /\b(mensaje|correo|email|whatsapp|aviso|notificaci[óo]n|propuesta|campaña)\b/i,
    action: /\b(envi[ée]|mand[ée]|notifiqu[ée]|program[ée]|agend[ée]|publiqu[ée]|compart[íi]|le escrib[íi])/i,
    tools: /^(send\w+|notify\w+|shareArtifact|pinChatMessage)$/,
  },
  {
    id: 'docs',
    label: 'generación de documentos/reportes',
    source: /\b(documento|reporte|pdf|excel|word|archivo|csv|presentaci[óo]n|gr[áa]fica|imagen|video)\b/i,
    action: /\b(gener[ée]|cre[ée]|prepar[ée]|arm[ée]|hice|dej[ée]|adjunt[ée]|descargu[ée])/i,
    tools: /^(composeDocument|generate\w+|renderView|previewQuote|getQuotePdf|shareArtifact)$/,
  },
  {
    id: 'venue',
    label: 'la computadora virtual',
    source: /\b(computadora virtual|m[áa]quina virtual|sandbox|la terminal|el navegador remoto)\b/i,
    action: /\b(ejecut[ée]|corr[íi]|corr[ée]i|abr[íi]|us[ée]|trabaj[ée])/i,
    tools: /^(venue\w+|browser|browserProfile)$/,
  },
];

/**
 * Sentences that claim a source/action whose tools never ran this turn.
 * One issue per capability (deduped); the fragment is quoted back to the model.
 */
export function sourceClaimsNotInTools(answer: string, toolsUsed: ReadonlyArray<string | { name: string }>): string[] {
  const names = toolsUsed.map((t) => (typeof t === 'string' ? t : t.name));
  const sentences = answer.split(/(?<=[.!?])\s+|\n+/);
  const flagged = new Set<string>();
  const issues: string[] = [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || s.length < 12) continue;
    if (ADMISSION.test(s) || PAST_OR_OTHER_TURN.test(s) || OFFER_OR_FUTURE.test(s)) continue;
    for (const rule of SOURCE_RULES) {
      if (flagged.has(rule.id)) continue;
      if (!rule.source.test(s) || !rule.action.test(s)) continue;
      if (names.some((n) => rule.tools.test(n))) continue;
      flagged.add(rule.id);
      issues.push(
        `Afirmaste "${s.slice(0, 140)}" — implica que usaste ${rule.label}, pero ninguna tool de esa capacidad corrió este turno ` +
          `(tools ejecutadas: ${names.length ? names.join(', ') : 'ninguna'}). ` +
          'Reescribe: admite la limitación ("no tengo acceso a internet ahora") o ejecuta la tool correcta primero.'
      );
    }
  }
  return issues;
}

/**
 * "Voy a buscar…" + zero tools executed = the model narrated an action it never
 * performed. Returns the issue text, or null when the turn acted (or never promised).
 */
export function promisedButNeverActed(answer: string, toolsUsed: ReadonlyArray<string | { name: string }>): string | null {
  const acted = toolsUsed.length > 0;
  if (acted) return null;
  const promise = /\b(voy a|d[ée]jame|perm[íi]teme|ahora (te |lo |la )?(busco|reviso|consulto|verifico|genero|preparo)|en un momento (te |lo )|dame un (momento|segundo)|en breve te|procedo a|paso a)\b/i.exec(answer);
  if (!promise) return null;
  return (
    `Dijiste "${promise[0]}…" pero no ejecutaste ninguna tool — el usuario quedó esperando una acción que no ocurrió. ` +
    'Si la acción necesita una tool disponible, ejecútala ahora; si la capacidad está deshabilitada o falta información indispensable, dilo claramente en tu respuesta final en vez de prometer.'
  );
}

export function checkAnswer(
  answer: string,
  knownFolios: Set<string>,
  knownTotals?: { counts: Set<number>; money: Set<number> },
  toolsUsed?: ReadonlyArray<string | { name: string }>
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
  if (toolsUsed) {
    issues.push(...sourceClaimsNotInTools(answer, toolsUsed));
    const empty = promisedButNeverActed(answer, toolsUsed);
    if (empty) issues.push(empty);
  }
  return { issues };
}
