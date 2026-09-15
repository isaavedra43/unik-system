/**
 * Report customization — what the user asks for about the SHAPE of a report.
 *
 * Two sources feed the same structure:
 *  1. `detectReportCustomization(message)` reads the user's own words ("sin totales",
 *     "quita la columna vendedor", "ordénalo por cliente", "en rojo", "en vertical").
 *  2. The model can pass an explicit `customization` object to any artifact tool when the
 *     request is more specific than the phrase matcher can catch.
 * The model's explicit object wins field by field (`mergeReportCustomization`).
 *
 * Everything here is pure (no Prisma/LLM imports) so it can be unit tested directly.
 */

/** Money columns of an order row: shown only when the user actually asked for amounts. */
export const OPTIONAL_MONEY_KEYS = new Set(['total', 'balance']);

export type ColumnAlign = 'left' | 'right' | 'center';

export interface ReportCustomization {
  /** Show the money columns (Total/Saldo), the TOTAL row and the money KPI cards. */
  showTotals?: boolean;
  /** Show the KPI cards above the table at all. */
  showSummaryCards?: boolean;
  /** Show the bold TOTAL row under the table. */
  showTotalsRow?: boolean;
  /** Exact set of columns, in this order (keys or Spanish labels). Replaces the default set. */
  columns?: string[];
  /** Extra columns to add to the default set. */
  addColumns?: string[];
  /** Columns to remove. */
  hideColumns?: string[];
  /** Rename headers: { balance: "Por cobrar" }. */
  columnLabels?: Record<string, string>;
  /** Force alignment per column. */
  columnAlign?: Record<string, ColumnAlign>;
  /** Relative width weights per column. */
  columnWidths?: Record<string, number>;
  /** Render these as full-width lines under the row instead of as a column. */
  asDetail?: string[];
  /** Force these back into the table as a normal column. */
  asColumn?: string[];
  /** Sort the rows by this column. */
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  brandColor?: string;
  accentColor?: string;
  /** Text color of the table header row. */
  headerTextColor?: string;
  /** Background of the alternating rows (zebra stripes). */
  rowStripeColor?: string;
  /** Body text color. */
  textColor?: string;
  /** Turn the zebra stripes off. */
  zebra?: boolean;
  orientation?: 'portrait' | 'landscape';
  fontSize?: number;
  /** Rows per image in generateReportImage. */
  rowsPerImage?: number;
  /** How the product list of each order is written out. */
  itemsStyle?: 'list' | 'compact' | 'none';
  /** Fields of each product line to print (name, sku, quantity, unit, rate, lineTotal, description). */
  itemFields?: string[];
  /**
   * Prices inside the product lines. On by default even when the table carries no money
   * columns: "quita el total y el saldo" is about the columns/KPIs, not about what each
   * product costs. Only an explicit "sin precios" turns them off.
   */
  itemPrices?: boolean;
  /** Uppercase the header labels (default true — that's the current look). */
  uppercaseHeaders?: boolean;
}

/* ------------------------------------------------------------------ */
/* Column naming                                                      */
/* ------------------------------------------------------------------ */

/**
 * Spanish (and loose) names the user may type for a column → the row key it refers to.
 * Lets "quita la columna vendedor" and "quita salesperson" mean the same thing.
 */
const COLUMN_ALIASES: Record<string, string> = {
  orden: 'number',
  ordenes: 'number',
  órdenes: 'number',
  folio: 'number',
  numero: 'number',
  número: 'number',
  ov: 'number',
  fecha: 'date',
  dia: 'date',
  día: 'date',
  cliente: 'customer',
  clientes: 'customer',
  vendedor: 'salesperson',
  vendedores: 'salesperson',
  agente: 'salesperson',
  ticket: 'ticketStatus',
  'estado del ticket': 'ticketStatus',
  pago: 'paidStatus',
  pagado: 'paidStatus',
  'estatus de pago': 'paidStatus',
  factura: 'invoicedStatus',
  facturado: 'invoicedStatus',
  facturacion: 'invoicedStatus',
  facturación: 'invoicedStatus',
  envio: 'shippedStatus',
  envío: 'shippedStatus',
  enviado: 'shippedStatus',
  metodo: 'paymentMethod',
  método: 'paymentMethod',
  'metodo de pago': 'paymentMethod',
  'método de pago': 'paymentMethod',
  forma_de_pago: 'paymentMethod',
  entrega: 'deliveryMethod',
  'metodo de entrega': 'deliveryMethod',
  'método de entrega': 'deliveryMethod',
  'tipo de entrega': 'deliveryMethod',
  estado: 'status',
  estatus: 'status',
  total: 'total',
  totales: 'total',
  importe: 'total',
  monto: 'total',
  saldo: 'balance',
  saldos: 'balance',
  'saldo pendiente': 'balance',
  adeudo: 'balance',
  'por cobrar': 'balance',
  sucursal: 'location',
  ubicacion: 'location',
  ubicación: 'location',
  productos: 'items',
  articulos: 'items',
  artículos: 'items',
  partidas: 'items',
  items: 'items',
  direccion: 'shippingAddress',
  dirección: 'shippingAddress',
  domicilio: 'shippingAddress',
  'direccion de envio': 'shippingAddress',
  'dirección de envío': 'shippingAddress',
  notas: 'notes',
  nota: 'notes',
  observaciones: 'notes',
  comentarios: 'notes',
  telefono: 'phone',
  teléfono: 'phone',
  tel: 'phone',
  celular: 'phone',
  cantidad: 'quantity',
  piezas: 'quantity',
  producto: 'product',
  articulo: 'product',
  artículo: 'product',
  ingreso: 'revenue',
  ingresos: 'revenue',
  ventas: 'revenue',
};

/** Strips accents and lowercases so "Dirección" and "direccion" match the same alias. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Resolves whatever the user/model called a column ("saldo", "Saldo Pendiente", "balance")
 * into the actual row key. Falls back to the raw name so unknown keys still work.
 */
export function resolveColumnKey(name: string, availableKeys: string[] = []): string {
  const raw = name.trim();
  if (availableKeys.includes(raw)) return raw;
  const norm = normalizeName(raw);
  const exact = availableKeys.find((k) => normalizeName(k) === norm);
  if (exact) return exact;
  const alias = COLUMN_ALIASES[norm] ?? COLUMN_ALIASES[norm.replace(/\s+/g, ' ')];
  if (alias) return alias;
  // "columna de cliente" / "la fecha" — try the last word too.
  const lastWord = norm.split(/\s+/).pop() ?? norm;
  return COLUMN_ALIASES[lastWord] ?? raw;
}

function resolveKeyList(
  names: string[] | undefined,
  availableKeys: string[]
): string[] | undefined {
  if (!names || names.length === 0) return undefined;
  return names.map((n) => resolveColumnKey(n, availableKeys));
}

function resolveKeyMap<T>(
  map: Record<string, T> | undefined,
  availableKeys: string[]
): Record<string, T> | undefined {
  if (!map) return undefined;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(map)) out[resolveColumnKey(k, availableKeys)] = v;
  return out;
}

/* ------------------------------------------------------------------ */
/* Detection from the user's own message                              */
/* ------------------------------------------------------------------ */

const HEX_RE = /#[0-9a-fA-F]{6}\b/;

const NAMED_COLORS: Record<string, string> = {
  rojo: '#dc2626',
  roja: '#dc2626',
  azul: '#2563eb',
  verde: '#16a34a',
  negro: '#0f172a',
  negra: '#0f172a',
  gris: '#64748b',
  morado: '#7c3aed',
  morada: '#7c3aed',
  violeta: '#7c3aed',
  lila: '#7c3aed',
  naranja: '#ea580c',
  anaranjado: '#ea580c',
  amarillo: '#ca8a04',
  amarilla: '#ca8a04',
  rosa: '#db2777',
  rosado: '#db2777',
  turquesa: '#0891b2',
  cyan: '#0891b2',
  celeste: '#0ea5e9',
  dorado: '#b45309',
  cafe: '#78350f',
  blanco: '#ffffff',
};

function colorFrom(text: string): string | undefined {
  const hex = text.match(HEX_RE);
  if (hex) return hex[0].toLowerCase();
  const norm = normalizeName(text);
  for (const [name, hexValue] of Object.entries(NAMED_COLORS)) {
    if (new RegExp(`\\b${name}\\b`).test(norm)) return hexValue;
  }
  return undefined;
}

/** Money words: the user is asking to SEE amounts (totals, balances, how much). */
const MONEY_RE =
  /\b(total(?:es)?|totaliza|suma(?:torias?|s|r)?|importes?|montos?|saldos?|adeudos?|deuda|por\s+cobrar|cobranza|cuanto|cuantos|precios?|valores?|facturacion|ingresos?|dinero|pesos|mxn)\b|\$/;

/** Explicit removal of the money columns/KPIs. */
const NO_MONEY_RE =
  /\b(sin|quita(?:r|le)?|quitame|elimina(?:r|le)?|borra(?:r|le)?|no\s+(?:pongas|incluyas|quiero|me\s+pongas))\b[^.;]{0,40}\b(total(?:es)?|saldos?|importes?|montos?|precios?|dinero)\b/;

const REMOVE_VERB =
  '(?:sin|quita(?:r|le|me)?|quitame|elimina(?:r|le)?|borra(?:r|le)?|omite|oculta(?:r)?|no\\s+(?:pongas|incluyas|muestres))';
const ADD_VERB =
  '(?:agrega(?:r|le|me)?|añade|anade|incluye(?:le)?|pon(?:le|me)?|mete(?:le)?|muestra(?:me)?)';

const COLUMN_WORD = '(?:la\\s+|las\\s+|el\\s+|los\\s+)?columnas?\\s+(?:de\\s+|del\\s+|con\\s+)?';

/** The plain name of a column, if this is one ("saldo", "método de pago", "dirección"). */
function knownColumnName(chunk: string): string | null {
  const n = normalizeName(chunk)
    .replace(/\s+/g, ' ')
    .replace(/^(?:la|el|las|los|de|del)\s+/, '');
  return COLUMN_ALIASES[n] ? n : null;
}

const NOT_A_COLUMN = new Set([
  'rojo',
  'roja',
  'azul',
  'verde',
  'negro',
  'negra',
  'gris',
  'morado',
  'naranja',
  'amarillo',
  'rosa',
  'vertical',
  'horizontal',
  'pdf',
  'excel',
  'csv',
  'imagen',
  'reporte',
  'tabla',
  'letra',
  'texto',
  'encabezado',
  'cabecera',
  'filas',
  'fila',
  'columna',
  'columnas',
  'eso',
  'esto',
  'ahi',
  'favor',
]);

/**
 * Splits "vendedor y método de pago, teléfono" into column names. A chunk with several words
 * only counts when the WHOLE chunk names a column — otherwise a run-on instruction
 * ("quita el vendedor, ordénalo por cliente y ponlo en rojo") would smuggle "cliente" and
 * "ponlo en rojo" into the list of columns to hide.
 */
function splitNameList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/\s*(?:,|;|\/|\by\b|\be\b)\s*/i)) {
    const chunk = part.replace(/^(?:la|el|las|los|de|del)\s+/i, '').trim();
    if (chunk.length < 2 || chunk.length > 40) continue;
    const known = knownColumnName(chunk);
    if (known) {
      if (!out.includes(known)) out.push(known);
      continue;
    }
    // A single unknown word can still be a real row key the aliases don't list.
    const norm = normalizeName(chunk);
    if (/^[a-z][a-z0-9_]{1,19}$/.test(norm) && !NOT_A_COLUMN.has(norm) && !out.includes(norm))
      out.push(norm);
  }
  return out;
}

/**
 * First column name inside a free run of words — for "ordénalo por cliente y ponlo en rojo",
 * where the capture cannot stop cleanly at the end of the column name.
 */
function firstColumnName(text: string): string | null {
  const words = normalizeName(text).split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let len = Math.min(3, words.length - i); len >= 1; len--) {
      const phrase = words.slice(i, i + len).join(' ');
      if (COLUMN_ALIASES[phrase]) return phrase;
    }
  }
  return null;
}

/**
 * Reads layout instructions out of a plain Spanish request. Only matches explicit
 * instructions — a message with no styling words returns `{}` (plus `showTotals` when the
 * user asked for amounts), so normal report requests keep the default look.
 */
export function detectReportCustomization(message: string): ReportCustomization {
  const cust: ReportCustomization = {};
  if (!message) return cust;
  const text = message.trim();
  const norm = normalizeName(text);

  // --- amounts -----------------------------------------------------
  if (NO_MONEY_RE.test(norm)) cust.showTotals = false;
  else if (MONEY_RE.test(norm)) cust.showTotals = true;

  if (
    /\b(sin|quita(?:r|le|me)?|no\s+pongas)\b[^.;]{0,30}\b(kpis?|tarjetas?|resumen|encabezado de kpis|cuadros)\b/.test(
      norm
    )
  ) {
    cust.showSummaryCards = false;
  }
  if (
    /\b(con|agrega|pon(?:le)?|incluye)\b[^.;]{0,30}\b(kpis?|tarjetas?\s+de\s+resumen)\b/.test(norm)
  ) {
    cust.showSummaryCards = true;
  }
  if (/\b(sin|quita(?:r|le|me)?|no\s+pongas)\b[^.;]{0,30}\bfila\s+de\s+totales?\b/.test(norm)) {
    cust.showTotalsRow = false;
  }

  // --- columns -----------------------------------------------------
  const only = norm.match(
    new RegExp(`\\b(?:solo|solamente|unicamente|nada mas)\\s+(?:${COLUMN_WORD})?([^.;]{3,120})`)
  );
  if (only) {
    const names = splitNameList(only[1]).filter((n) => COLUMN_ALIASES[n]);
    if (names.length > 1) cust.columns = names;
  }

  // The word "columna" is optional: "quita el vendedor" means the same as "quita la columna vendedor".
  const hide = [
    ...norm.matchAll(new RegExp(`${REMOVE_VERB}\\s+(?:${COLUMN_WORD})?([^.;]{2,120})`, 'g')),
  ];
  for (const m of hide) {
    const names = splitNameList(m[1]);
    if (names.length > 0) cust.hideColumns = [...(cust.hideColumns ?? []), ...names];
  }
  const add = [
    ...norm.matchAll(new RegExp(`${ADD_VERB}\\s+(?:${COLUMN_WORD})?([^.;]{2,120})`, 'g')),
  ];
  for (const m of add) {
    const names = splitNameList(m[1]);
    if (names.length > 0) cust.addColumns = [...(cust.addColumns ?? []), ...names];
  }

  // "llama/renombra la columna saldo como 'Por cobrar'"
  const rename = [
    ...norm.matchAll(
      /\b(?:renombra|llama|cambia(?:le)?\s+el\s+(?:nombre|titulo)\s+(?:de|a))\s+(?:la\s+columna\s+)?([a-zñ ]{3,25}?)\s+(?:a|como|por)\s+["'“]?([^"'”.;]{2,30})["'”]?/g
    ),
  ];
  for (const m of rename) {
    cust.columnLabels = { ...(cust.columnLabels ?? {}), [m[1].trim()]: m[2].trim() };
  }

  // --- rows --------------------------------------------------------
  const sort = norm.match(
    /\b(?:ordena(?:r|lo|los|das?)?|acomoda(?:r|lo|los)?|ordenado)\b[^.;]{0,20}?\bpor\s+(?:la\s+|el\s+)?(?:columna\s+)?([a-zñ ]{3,25})/
  );
  if (sort) {
    const sortColumn = firstColumnName(sort[1]);
    if (sortColumn) {
      cust.sortBy = sortColumn;
      cust.sortDirection =
        /\b(?:mayor a menor|descendente|desc|mas alto|reciente(?:s)? primero|de mas a menos)\b/.test(
          norm
        )
          ? 'desc'
          : 'asc';
    }
  }
  if (!cust.sortBy && /\bde\s+mayor\s+a\s+menor\b/.test(norm)) {
    cust.sortBy = 'total';
    cust.sortDirection = 'desc';
  }

  // --- look --------------------------------------------------------
  const headerColor = norm.match(/\b(?:encabezado|cabecera|header|titulo|barra)\b[^.;]{0,25}/);
  const rowColor = norm.match(/\b(?:filas?|renglones?|rayado|zebra)\b[^.;]{0,25}/);
  if (headerColor) {
    const c = colorFrom(headerColor[0]);
    if (c) cust.brandColor = c;
  }
  if (rowColor) {
    const c = colorFrom(rowColor[0]);
    if (c) cust.rowStripeColor = c;
  }
  if (!cust.brandColor) {
    // A color only counts as a styling instruction when something asks for it: "de color rojo",
    // "ponlo en rojo", a hex code. Otherwise "las ventas de marmol verde" would repaint the
    // report green.
    const styled =
      norm.match(/\b(?:de\s+)?colores?\s+([a-z]+)/) ??
      norm.match(
        /\b(?:pon(?:lo|le|me)?|hazlo|haz|cambia(?:lo|le|selo)?|dejalo|quiero(?:lo)?|estilo)\b[^.;]{0,25}?\ben\s+([a-z]+)/
      );
    const c = HEX_RE.test(text) ? colorFrom(text) : styled ? colorFrom(styled[1]) : undefined;
    if (c) cust.brandColor = c;
  }
  if (/\b(?:sin|quita(?:r|le)?)\b[^.;]{0,20}\b(?:rayado|zebra|franjas|sombreado)\b/.test(norm))
    cust.zebra = false;

  if (/\b(?:vertical|portrait|de\s+pie)\b/.test(norm)) cust.orientation = 'portrait';
  else if (/\b(?:horizontal|apaisado|landscape|acostado)\b/.test(norm))
    cust.orientation = 'landscape';

  if (
    /\b(?:letra|texto|fuente|tipografia)\b[^.;]{0,25}\b(?:mas\s+grande|grande|mayor)\b/.test(norm)
  )
    cust.fontSize = 9.5;
  else if (
    /\b(?:letra|texto|fuente|tipografia)\b[^.;]{0,25}\b(?:mas\s+chica|chica|pequena|mas\s+pequena|menor)\b/.test(
      norm
    )
  )
    cust.fontSize = 6.5;

  const rowsPerImage = norm.match(
    /\b(\d{1,2})\s+(?:filas|renglones|ordenes)\s+por\s+(?:imagen|hoja|pagina)\b/
  );
  if (rowsPerImage) cust.rowsPerImage = Number(rowsPerImage[1]);

  // --- products ----------------------------------------------------
  if (
    /\b(?:sin|quita(?:r|le|me)?|no\s+pongas)\b[^.;]{0,20}\b(?:productos|articulos|partidas|items)\b/.test(
      norm
    )
  ) {
    cust.itemsStyle = 'none';
  } else if (
    /\bproductos\b[^.;]{0,30}\b(?:en\s+una\s+linea|compact[oa]|resumid[oa]s?|cort[oa]s?)\b/.test(
      norm
    )
  ) {
    cust.itemsStyle = 'compact';
  }
  if (/\b(?:sin|quita(?:r|le|me)?|no\s+pongas)\b[^.;]{0,25}\bprecios?\b/.test(norm))
    cust.itemPrices = false;

  return cust;
}

/** Later objects win, field by field (the model's explicit customization over the detected one). */
export function mergeReportCustomization(
  ...parts: Array<ReportCustomization | undefined | null>
): ReportCustomization {
  const out: ReportCustomization = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * The customization a report is actually generated with: the previous version's layout (when
 * revising a delivered file), the model's parameters on top, and the user's own words of THIS
 * message on top of everything — `showTotals` in particular can only be turned on by the user
 * (or inherited from the version being revised). The model deciding by itself that a report
 * wants amounts is exactly how Total/Saldo kept appearing unrequested.
 */
export function resolveReportCustomization(
  message: string,
  modelCustomization?: ReportCustomization | null,
  /** Customization of the previous version when this is a revision of a delivered file. */
  base?: ReportCustomization | null
): ReportCustomization {
  const detected = detectReportCustomization(message);
  // The user's words in THIS message decide; otherwise what the previous version had; never
  // the model. Then every money surface (columns, cards, totals row) follows that one flag.
  const showTotals = detected.showTotals ?? (base?.showTotals === true);
  return enforceMoneyOptIn(mergeReportCustomization(base, modelCustomization, detected, { showTotals }));
}

const MONEY_COLUMN_NAMES = /^(total(?:es)?|balance|saldos?|importes?|montos?|por cobrar|adeudos?)$/i;

/**
 * With `showTotals` off, no money can enter through any other door: not as a column the
 * model added, not as a KPI card, not as the totals row. Pure.
 */
export function enforceMoneyOptIn(cust: ReportCustomization): ReportCustomization {
  if (cust.showTotals === true) return cust;
  const strip = (list?: string[]) => list?.filter((c) => !OPTIONAL_MONEY_KEYS.has(c) && !MONEY_COLUMN_NAMES.test(c.trim()));
  return {
    ...cust,
    showTotals: false,
    showTotalsRow: false,
    columns: strip(cust.columns),
    addColumns: strip(cust.addColumns),
    asColumn: strip(cust.asColumn),
  };
}

/** Resolves every column name the caller used (Spanish labels included) to real row keys. */
export function normalizeCustomization(
  cust: ReportCustomization | undefined,
  availableKeys: string[] = []
): ReportCustomization {
  if (!cust) return {};
  return {
    ...cust,
    columns: resolveKeyList(cust.columns, availableKeys),
    addColumns: resolveKeyList(cust.addColumns, availableKeys),
    hideColumns: resolveKeyList(cust.hideColumns, availableKeys),
    asDetail: resolveKeyList(cust.asDetail, availableKeys),
    asColumn: resolveKeyList(cust.asColumn, availableKeys),
    columnLabels: resolveKeyMap(cust.columnLabels, availableKeys),
    columnAlign: resolveKeyMap(cust.columnAlign, availableKeys),
    columnWidths: resolveKeyMap(cust.columnWidths, availableKeys),
    sortBy: cust.sortBy ? resolveColumnKey(cust.sortBy, availableKeys) : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Applying it                                                        */
/* ------------------------------------------------------------------ */

export interface ReportColumn {
  header: string;
  key: string;
  format?: string;
}

/**
 * Applies the customization to a column list: drops the money columns when no amounts were
 * asked for, removes/adds/reorders columns and renames headers. Never returns an empty list
 * (a report with no columns is worse than the default one).
 */
export function applyColumnCustomization<T extends ReportColumn>(
  cols: T[],
  cust: ReportCustomization,
  allKeys: string[] = []
): T[] {
  if (cols.length === 0) return cols;
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const keyOf = (name: string) =>
    resolveColumnKey(name, allKeys.length > 0 ? allKeys : cols.map((c) => c.key));

  let result: T[];
  if (cust.columns && cust.columns.length > 0) {
    const wanted = cust.columns.map(keyOf);
    result = wanted
      .map((k) => byKey.get(k) ?? ({ header: k, key: k } as T))
      .filter((c) => allKeys.length === 0 || byKey.has(c.key) || allKeys.includes(c.key));
  } else {
    result = [...cols];
  }

  for (const name of cust.addColumns ?? []) {
    const k = keyOf(name);
    if (result.some((c) => c.key === k)) continue;
    const existing = byKey.get(k);
    result.push(existing ?? ({ header: k, key: k } as T));
  }

  const hidden = new Set((cust.hideColumns ?? []).map(keyOf));
  // Money columns are opt-in: only the user's words ("con totales", "saldo") turn them on.
  // A model that lists "total" in `columns` on its own does not count.
  if (cust.showTotals === false) {
    for (const k of OPTIONAL_MONEY_KEYS) hidden.add(k);
  }
  if (hidden.size > 0) {
    const kept = result.filter((c) => !hidden.has(c.key));
    if (kept.length > 0) result = kept;
  }

  if (cust.columnLabels || cust.columnAlign) {
    result = result.map((c) => {
      const label = cust.columnLabels?.[c.key];
      return label ? ({ ...c, header: label } as T) : c;
    });
  }
  return result;
}

/** Row order: sorts by the requested column (numbers numerically, text alphabetically). */
export function applyRowCustomization(
  rows: Record<string, unknown>[],
  cust: ReportCustomization,
  parseNumber: (v: unknown) => number | null
): Record<string, unknown>[] {
  if (!cust.sortBy) return rows;
  const key = cust.sortBy;
  if (rows.length === 0 || !(key in rows[0])) return rows;
  const dir = cust.sortDirection === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const na = parseNumber(a[key]);
    const nb = parseNumber(b[key]);
    if (na !== null && nb !== null) return (na - nb) * dir;
    return String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'es') * dir;
  });
}

/** Labels of KPI cards that report an amount, however the value happens to be written. */
const MONEY_CARD_LABEL =
  /\b(total(?:es)?|saldo(?:s)?|importe|monto|ingreso|ingresos|revenue|balance|adeudo|cobrar|facturad|venta\s+total)\b/i;

/** A card is about money when its value is an amount or its label names one. */
export function isMoneyCard(card: { label: string; value: string }): boolean {
  const value = card.value.trim();
  if (/^[-(]?\s*\$/.test(value)) return true;
  if (/\b(?:mxn|usd|pesos)\b/i.test(value)) return true;
  return MONEY_CARD_LABEL.test(card.label);
}

/**
 * KPI cards: hidden entirely, or stripped of the money ones when no amounts were asked for.
 * Matching on the label too (not just a leading "$") is what keeps a hand-typed
 * {label: "Total", value: "3,080,682.99"} from slipping past.
 */
export function applySummaryCardCustomization(
  cards: Array<{ label: string; value: string }> | undefined,
  cust: ReportCustomization
): Array<{ label: string; value: string }> | undefined {
  if (!cards || cards.length === 0) return undefined;
  if (cust.showSummaryCards === false) return undefined;
  // Money cards need the user's explicit request; "showSummaryCards: true" alone (which the
  // model can pass) keeps only the count cards.
  if (cust.showTotals === false) {
    const kept = cards.filter((c) => !isMoneyCard(c));
    return kept.length > 0 ? kept : undefined;
  }
  return cards;
}

/** True when the bold TOTAL row under the table should be drawn. */
export function wantsTotalsRow(cust: ReportCustomization): boolean {
  // "showTotalsRow: true" from the model cannot override the user's "no amounts".
  if (cust.showTotals === false) return false;
  return cust.showTotalsRow !== false;
}

/* ------------------------------------------------------------------ */
/* Product lines                                                      */
/* ------------------------------------------------------------------ */

interface ItemLike {
  name?: unknown;
  sku?: unknown;
  quantity?: unknown;
  unit?: unknown;
  rate?: unknown;
  lineTotal?: unknown;
  description?: unknown;
}

/** An array is a product list when its objects carry a name plus a quantity or a line total. */
export function looksLikeItemList(value: unknown): value is ItemLike[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const o = v as Record<string, unknown>;
    return 'name' in o && ('quantity' in o || 'lineTotal' in o || 'sku' in o);
  });
}

function fmtQty(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return value === undefined || value === null ? null : String(value);
  return n.toLocaleString('es-MX', { maximumFractionDigits: 2 });
}

function fmtMoney(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Writes an order's products as readable lines instead of the raw
 * "name: X; sku: Y; quantity: 120; unit: m2; rate: 385; lineTotal: 46200" dump:
 *
 *   1. Marmol Jalapa Natural 30xLLx1 · SKU UPC-1110
 *      120 m2 × $385.00 = $46,200.00
 *   2. Flete · SKU UPC-1858
 *      MATERIAL LIBRE DE MANIOBRAS DE DESCARGA
 *
 * `style: 'compact'` keeps each product on a single line (for images/Excel cells).
 */
export function formatItemsList(
  items: ItemLike[],
  opts: { style?: 'list' | 'compact' | 'none'; fields?: string[]; showMoney?: boolean } = {}
): string {
  const style = opts.style ?? 'list';
  if (style === 'none' || items.length === 0) return '';
  const showMoney = opts.showMoney !== false;
  const fields = opts.fields && opts.fields.length > 0 ? new Set(opts.fields) : null;
  const wants = (f: string) => (fields ? fields.has(f) : true);

  const lines: string[] = [];
  items.forEach((item, i) => {
    const name = String(item.name ?? '').trim() || 'Producto';
    const sku = wants('sku') && item.sku ? String(item.sku).trim() : '';
    const qty = wants('quantity') ? fmtQty(item.quantity) : null;
    const unit = wants('unit') && item.unit ? String(item.unit).trim() : '';
    const rate = wants('rate') && showMoney ? fmtMoney(item.rate) : null;
    const lineTotal = wants('lineTotal') && showMoney ? fmtMoney(item.lineTotal) : null;
    const description =
      wants('description') && item.description ? String(item.description).trim() : '';

    // "120 m2 × $385.00 = $46,200.00" — each piece only when it says something.
    const amount: string[] = [];
    const hasMoney = Boolean((rate && rate !== '$0.00') || (lineTotal && lineTotal !== '$0.00'));
    if (qty && unit) amount.push(`${qty} ${unit}`);
    // A bare count says nothing on its own ("1" under a "Flete" line): label it, and drop it
    // entirely when it is a single unit with no price.
    else if (qty && (hasMoney || qty !== '1')) amount.push(hasMoney ? qty : `Cantidad: ${qty}`);
    if (rate && rate !== '$0.00') amount.push(`× ${rate}`);
    if (lineTotal && lineTotal !== '$0.00') amount.push(`= ${lineTotal}`);
    const amountText = amount.join(' ');

    const head = sku ? `${name} · SKU ${sku}` : name;
    const number = `${i + 1}.`;

    if (style === 'compact') {
      lines.push(
        [number, head, amountText && `— ${amountText}`, description && `(${description})`]
          .filter(Boolean)
          .join(' ')
      );
      return;
    }
    lines.push(`${number} ${head}`);
    if (amountText) lines.push(`    ${amountText}`);
    if (description) lines.push(`    ${description}`);
  });
  return lines.join('\n');
}
