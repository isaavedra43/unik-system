import type { ChartTone } from '@/components/patterns/dashboard/chart-theme';
import type { StatusSegment } from '@/components/patterns/dashboard/dashboard-utils';
import type { AreaRowTone } from '@/modules/areas/area-work-row';
import {
  CONFIDENCE_LABELS,
  CONFIDENCE_LEVELS,
  LEGACY_CLAIM_SOURCES,
  LEGACY_CLAIM_SOURCE_LABELS,
  MOVEMENT_KIND_LABELS,
  TRACKING_POLICIES,
  toConfidenceLevel,
  type ConfidenceLevel,
  type LegacyClaimSource,
  type TrackingPolicy,
} from '@/modules/inventory/inventory-types';
import { ALLOCATION_SOURCES, type AllocationSource } from '@/modules/operations/types';

/**
 * Pure view model of the Inventario area (plan 7.3 / 7.6 / 7.10): tones of the
 * confidence levels, links of its spaces, formatters of quantities and dates,
 * validation of everything a person types before a command is sent, and the
 * rules that decide what to count next.
 *
 * ISOMORPHIC AND PURE: no React, no Prisma, no I/O, no `@prisma/client`. The
 * server (dashboard, branches) and the browser (map, capture, tables) share it,
 * and it is unit tested on its own. The vocabulary (levels, labels, movement
 * kinds) is REUSED from `@/modules/inventory/inventory-types`, never restated.
 */

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export const INVENTORY_AREA_KEY = 'inventario';
export const INVENTORY_BASE_PATH = '/app/areas/inventario';

export const INVENTORY_SPACES = {
  dashboard: 'dashboard',
  work: 'trabajo',
  comms: 'comunicaciones',
  map: 'mapa',
  stock: 'existencias',
  counts: 'conteos',
  movements: 'movimientos',
  locations: 'ubicaciones',
  profiles: 'perfiles',
} as const;

export type InventorySpace = (typeof INVENTORY_SPACES)[keyof typeof INVENTORY_SPACES];

/** Link of an inventory space, with its query string already encoded. */
export function inventoryHref(
  space: InventorySpace,
  params: Record<string, string | number | boolean | null | undefined> = {}
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${INVENTORY_BASE_PATH}/${space}?${query}` : `${INVENTORY_BASE_PATH}/${space}`;
}

/** Profile page of one Zoho item (reached from the stock table). */
export function profileHref(zohoItemId: string): string {
  return `${INVENTORY_BASE_PATH}/${INVENTORY_SPACES.profiles}/${encodeURIComponent(zohoItemId)}`;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/** Order the levels are shown in: from the least trustworthy to the most. */
export const CONFIDENCE_ORDER: readonly ConfidenceLevel[] = [
  'DISPUTED',
  'UNCOUNTED',
  'PROVISIONAL',
  'CONTROLLED',
];

const CONFIDENCE_TONE: Readonly<Record<ConfidenceLevel, AreaRowTone>> = {
  UNCOUNTED: 'weak',
  PROVISIONAL: 'warning',
  CONTROLLED: 'success',
  DISPUTED: 'danger',
};

const CONFIDENCE_CHART_TONE: Readonly<Record<ConfidenceLevel, ChartTone>> = {
  UNCOUNTED: 'muted',
  PROVISIONAL: 'warning',
  CONTROLLED: 'success',
  DISPUTED: 'danger',
};

/** Tone of a confidence level for badges and location tiles. */
export function confidenceTone(value: unknown): AreaRowTone {
  return CONFIDENCE_TONE[toConfidenceLevel(value)];
}

export function confidenceLabel(value: unknown): string {
  return CONFIDENCE_LABELS[toConfidenceLevel(value)];
}

export function confidenceChartTone(value: unknown): ChartTone {
  return CONFIDENCE_CHART_TONE[toConfidenceLevel(value)];
}

/** What a level means for the person reading it (one short sentence). */
export const CONFIDENCE_HINTS: Readonly<Record<ConfidenceLevel, string>> = {
  UNCOUNTED: 'Nunca se ha contado: no se puede prometer.',
  PROVISIONAL: 'Contado una vez: se puede reservar con autorización.',
  CONTROLLED: 'Dos conteos buenos seguidos: se puede prometer.',
  DISPUTED: 'Hay una diferencia sin resolver: bloquea compromisos.',
};

/**
 * Confidence of a whole location: the worst level of what guarda. A location
 * without existencias no está "controlada", está vacía.
 */
export function aggregateConfidence(counts: {
  disputed: number;
  uncounted: number;
  provisional: number;
  controlled: number;
}): ConfidenceLevel | null {
  if (counts.disputed > 0) return 'DISPUTED';
  if (counts.uncounted > 0) return 'UNCOUNTED';
  if (counts.provisional > 0) return 'PROVISIONAL';
  if (counts.controlled > 0) return 'CONTROLLED';
  return null;
}

/** Segments of the confidence chart, in a stable order and with their tones. */
export function confidenceSegments(
  rows: ReadonlyArray<{ confidence: string; items: number }>
): StatusSegment[] {
  const byLevel = new Map<ConfidenceLevel, number>();
  for (const row of rows) {
    const level = toConfidenceLevel(row.confidence);
    byLevel.set(level, (byLevel.get(level) ?? 0) + (Number.isFinite(row.items) ? row.items : 0));
  }
  return CONFIDENCE_LEVELS.map((level) => ({
    key: level,
    label: CONFIDENCE_LABELS[level],
    count: byLevel.get(level) ?? 0,
    tone: CONFIDENCE_CHART_TONE[level],
  }));
}

/** Share of `CONTROLLED` items over the total, as a percentage (0 when there is nothing). */
export function controlledShare(
  rows: ReadonlyArray<{ confidence: string; items: number }>
): number {
  let total = 0;
  let controlled = 0;
  for (const row of rows) {
    const items = Number.isFinite(row.items) ? row.items : 0;
    total += items;
    if (toConfidenceLevel(row.confidence) === 'CONTROLLED') controlled += items;
  }
  return total > 0 ? Math.round((controlled / total) * 100) : 0;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const NUMBER_FORMAT: Intl.NumberFormatOptions = { maximumFractionDigits: 4 };

/** Decimal string of the engine → readable quantity ("1,240.5 m2"). */
export function formatQty(value: string | number | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  const text = Number.isFinite(number)
    ? number.toLocaleString('es-MX', NUMBER_FORMAT)
    : String(value);
  return unit ? `${text} ${unit}` : text;
}

/** Signed quantity of a movement ("+12", "−3"). */
export function formatSignedQty(
  value: string | number | null | undefined,
  unit?: string | null
): string {
  const number = Number(value ?? NaN);
  if (!Number.isFinite(number)) return formatQty(value, unit);
  const sign = number > 0 ? '+' : number < 0 ? '−' : '';
  return `${sign}${formatQty(Math.abs(number), unit)}`;
}

export function movementKindLabel(kind: string): string {
  return (MOVEMENT_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

/** Days without a count → short sentence for the tile and the drawer. */
export function stalenessLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return 'Nunca se ha contado';
  if (days <= 0) return 'Contado hoy';
  if (days === 1) return 'Contado ayer';
  if (days < 30) return `Contado hace ${days} días`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'Contado hace un mes' : `Contado hace ${months} meses`;
}

/** Progress of an open count, for the capture header. */
export function countProgressLabel(input: {
  lines: number;
  pending?: number;
  disputed?: number;
}): string {
  const lines = Math.max(0, Math.trunc(input.lines));
  if (lines === 0) return 'Sin líneas capturadas';
  const parts = [lines === 1 ? '1 línea capturada' : `${lines} líneas capturadas`];
  const disputed = Math.max(0, Math.trunc(input.disputed ?? 0));
  if (disputed > 0) parts.push(disputed === 1 ? '1 en disputa' : `${disputed} en disputa`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// What to count next (mobile "siguiente acción", plan 7.10)
// ---------------------------------------------------------------------------

export interface LocationLike {
  id: string;
  code: string;
  label: string | null;
  items: number;
  confidence: ConfidenceLevel | null;
  daysSinceCount: number | null;
}

export type NextLocationReason = 'disputed' | 'uncounted' | 'stale' | 'oldest';

export const NEXT_LOCATION_REASONS: Readonly<Record<NextLocationReason, string>> = {
  disputed: 'Tiene una diferencia sin resolver',
  uncounted: 'Nunca se ha contado',
  stale: 'Lleva más de 30 días sin conteo',
  oldest: 'Es la que lleva más tiempo sin contarse',
};

export const STALE_COUNT_DAYS = 30;

/**
 * Location to count first: disputes, then what was never counted, then what is
 * stale, then the oldest. Empty locations are never proposed.
 */
export function pickNextLocation(
  locations: readonly LocationLike[]
): { location: LocationLike; reason: NextLocationReason } | null {
  const withStock = locations.filter((location) => location.items > 0);
  if (withStock.length === 0) return null;

  const byOldest = (a: LocationLike, b: LocationLike) =>
    (b.daysSinceCount ?? Number.MAX_SAFE_INTEGER) - (a.daysSinceCount ?? Number.MAX_SAFE_INTEGER) ||
    a.code.localeCompare(b.code, 'es-MX');

  const disputed = withStock.filter((location) => location.confidence === 'DISPUTED');
  if (disputed.length > 0) return { location: [...disputed].sort(byOldest)[0], reason: 'disputed' };

  const uncounted = withStock.filter(
    (location) => location.confidence === 'UNCOUNTED' || location.daysSinceCount === null
  );
  if (uncounted.length > 0) {
    return { location: [...uncounted].sort((a, b) => b.items - a.items)[0], reason: 'uncounted' };
  }

  const stale = withStock.filter((location) => (location.daysSinceCount ?? 0) >= STALE_COUNT_DAYS);
  if (stale.length > 0) return { location: [...stale].sort(byOldest)[0], reason: 'stale' };

  return { location: [...withStock].sort(byOldest)[0], reason: 'oldest' };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * What the map should do with a scan. The lookup itself is resolved by the
 * shared endpoint (`GET /app/operations/api/scan` → `ScanLookup`), which
 * already checked permissions and formatted the numbers: this only decides
 * where to land.
 */
export type ScanTarget =
  | { kind: 'location'; locationId: string; code: string }
  | { kind: 'stock_item'; stockItemId: string; locationCode: string | null }
  | { kind: 'sku'; stockItemIds: string[] }
  | { kind: 'unknown' };

/** Shape of `ScanLookup` this model needs (kept structural to avoid a server import). */
export interface ScanLookupLike {
  kind: 'stock_item' | 'location' | 'sku' | 'unknown';
  title: string;
  items: ReadonlyArray<{ id: string; locationCode: string | null }>;
}

/** Title the shared resolver builds for a location (`Ubicación A-01`). */
const SCAN_LOCATION_TITLE = /^Ubicaci[oó]n\s+(.+)$/i;

/**
 * Where a scan lands on the map: a location tile, one stock row or the rows of
 * a SKU. The location is matched by its code against the warehouse already on
 * screen, so the map never has to ask the server who that location is.
 */
export function scanTarget(
  lookup: ScanLookupLike | null | undefined,
  locations: readonly LocationLike[] = []
): ScanTarget {
  if (!lookup || lookup.kind === 'unknown') return { kind: 'unknown' };

  if (lookup.kind === 'location') {
    const fromTitle = SCAN_LOCATION_TITLE.exec(lookup.title.trim())?.[1]?.trim();
    const code = (fromTitle || lookup.items[0]?.locationCode || '').trim();
    if (!code) return { kind: 'unknown' };
    const match = locations.find((location) => location.code.toUpperCase() === code.toUpperCase());
    return match
      ? { kind: 'location', locationId: match.id, code: match.code }
      : { kind: 'unknown' };
  }

  if (lookup.kind === 'stock_item') {
    const item = lookup.items[0];
    return item
      ? { kind: 'stock_item', stockItemId: item.id, locationCode: item.locationCode }
      : { kind: 'unknown' };
  }

  const ids = lookup.items.map((item) => item.id).filter(Boolean);
  return ids.length > 0 ? { kind: 'sku', stockItemIds: ids } : { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Validation of what a person types (the engine validates again)
// ---------------------------------------------------------------------------

export type FieldCheck<T> = { ok: true; value: T } | { ok: false; error: string };

const QUANTITY_PATTERN = /^-?\d{1,14}([.,]\d{1,6})?$/;

/** Counted quantity: a positive-or-zero number with at most six decimals. */
export function parseCountedQty(input: string): FieldCheck<string> {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Escribe la cantidad contada' };
  if (!QUANTITY_PATTERN.test(text)) {
    return { ok: false, error: 'Usa sólo números (hasta seis decimales)' };
  }
  const normalized = text.replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false, error: 'La cantidad no es válida' };
  if (value < 0) return { ok: false, error: 'La cantidad contada no puede ser negativa' };
  return { ok: true, value: normalized };
}

/** Quantity of a movement, a bloqueo or a reclamo: always greater than zero. */
export function parsePositiveQty(input: string): FieldCheck<string> {
  const parsed = parseCountedQty(input);
  if (!parsed.ok) return parsed;
  if (Number(parsed.value) <= 0) return { ok: false, error: 'La cantidad debe ser mayor que cero' };
  return parsed;
}

/** Adjustment quantity: signed and never zero (that is what the engine accepts). */
export function parseSignedQty(input: string): FieldCheck<string> {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Escribe la cantidad' };
  if (!QUANTITY_PATTERN.test(text)) {
    return { ok: false, error: 'Usa sólo números (hasta seis decimales)' };
  }
  const normalized = text.replace(',', '.');
  if (Number(normalized) === 0) return { ok: false, error: 'La cantidad no puede ser cero' };
  return { ok: true, value: normalized };
}

export const LOCATION_CODE_HINT = 'Letras, números, guiones o puntos (se guarda en mayúsculas).';
const LOCATION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_.\-/]{0,39}$/;
const RESERVED_LOCATION_CODES = ['GENERAL', 'SCRAP'];

/** Location code as the engine stores it (uppercase, spaces → hyphen). */
export function parseLocationCode(input: string): FieldCheck<string> {
  const code = input.trim().toUpperCase().replace(/\s+/g, '-');
  if (!code) return { ok: false, error: 'Escribe el código de la ubicación' };
  if (!LOCATION_CODE_PATTERN.test(code)) {
    return { ok: false, error: `Código inválido. ${LOCATION_CODE_HINT}` };
  }
  if (RESERVED_LOCATION_CODES.includes(code)) {
    return { ok: false, error: `El código ${code} está reservado por el sistema` };
  }
  return { ok: true, value: code };
}

export interface ProfileFormValues {
  baseUnit: string;
  tolerancePct: string;
  trackingPolicy: string;
  defaultSource: string;
  isBulk: boolean;
  variantAxes: string;
  conversions: Array<{ unit: string; factor: string }>;
  weightKgPerBaseUnit: string;
  areaM2PerBaseUnit: string;
}

export interface ProfilePatch {
  baseUnit: string;
  tolerancePct: number;
  trackingPolicy: TrackingPolicy;
  defaultSource: AllocationSource;
  isBulk: boolean;
  variantAxes: string[];
  conversions: Array<{ unit: string; factor: string }>;
  weightKgPerBaseUnit: number | null;
  areaM2PerBaseUnit: number | null;
}

export const MAX_CONVERSIONS = 12;
export const MAX_VARIANT_AXES = 6;

function normalizeUnitText(value: string): string {
  return value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '');
}

function normalizeAxis(value: string): string {
  return normalizeUnitText(value).replace(/[^a-z0-9_]/g, '_');
}

/**
 * Validates the profile form with the same rules the module applies
 * (`profiles-service`), so nothing is sent just to bounce back. Returns the
 * patch the command expects, or the errors by field.
 */
export function validateProfileForm(
  values: ProfileFormValues
): { ok: true; patch: ProfilePatch } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const baseUnit = normalizeUnitText(values.baseUnit);
  if (!baseUnit) errors.baseUnit = 'Escribe la unidad base (por ejemplo pz, m2, kg)';
  if (baseUnit.length > 30) errors.baseUnit = 'La unidad base admite hasta 30 caracteres';

  const toleranceText = values.tolerancePct.trim().replace(',', '.');
  const tolerance = Number(toleranceText === '' ? '0' : toleranceText);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) {
    errors.tolerancePct = 'La tolerancia va de 0 a 100 por ciento';
  }

  const axes: string[] = [];
  for (const raw of values.variantAxes.split(',')) {
    const axis = normalizeAxis(raw);
    if (!axis) continue;
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(axis)) {
      errors.variantAxes = `Eje inválido: "${raw.trim()}"`;
      break;
    }
    if (!axes.includes(axis)) axes.push(axis);
  }
  if (axes.length > MAX_VARIANT_AXES) {
    errors.variantAxes = `Máximo ${MAX_VARIANT_AXES} ejes de variante`;
  }

  const conversions: Array<{ unit: string; factor: string }> = [];
  const seen = new Set<string>();
  values.conversions.forEach((entry, index) => {
    const unit = normalizeUnitText(entry.unit);
    const factorText = entry.factor.trim().replace(',', '.');
    if (!unit && !factorText) return;
    if (!unit) {
      errors[`conversions.${index}.unit`] = 'Falta la unidad';
      return;
    }
    if (seen.has(unit)) {
      errors[`conversions.${index}.unit`] = `La unidad ${unit} está repetida`;
      return;
    }
    const factor = Number(factorText);
    if (!Number.isFinite(factor) || factor <= 0 || factor > 1_000_000_000) {
      errors[`conversions.${index}.factor`] = 'El factor debe ser mayor que cero';
      return;
    }
    if (unit === baseUnit && factor !== 1) {
      errors[`conversions.${index}.factor`] = `La unidad base ${baseUnit} sólo admite factor 1`;
      return;
    }
    seen.add(unit);
    conversions.push({ unit, factor: String(factor) });
  });
  if (conversions.length > MAX_CONVERSIONS) {
    errors.conversions = `Máximo ${MAX_CONVERSIONS} conversiones por artículo`;
  }

  const measure = (raw: string, field: string): number | null => {
    const text = raw.trim().replace(',', '.');
    if (!text) return null;
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
      errors[field] = 'Escribe un número mayor o igual que cero';
      return null;
    }
    return value;
  };
  const weight = measure(values.weightKgPerBaseUnit, 'weightKgPerBaseUnit');
  const area = measure(values.areaM2PerBaseUnit, 'areaM2PerBaseUnit');

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  // A value outside the module's vocabulary never reaches the command.
  const trackingPolicy = (TRACKING_POLICIES as readonly string[]).includes(values.trackingPolicy)
    ? (values.trackingPolicy as TrackingPolicy)
    : 'none';
  const defaultSource = (ALLOCATION_SOURCES as readonly string[]).includes(values.defaultSource)
    ? (values.defaultSource as AllocationSource)
    : 'stock';
  return {
    ok: true,
    patch: {
      baseUnit,
      tolerancePct: tolerance,
      trackingPolicy,
      defaultSource,
      isBulk: values.isBulk,
      variantAxes: axes,
      conversions,
      weightKgPerBaseUnit: weight,
      areaM2PerBaseUnit: area,
    },
  };
}

// ---------------------------------------------------------------------------
// Decisiones sobre las diferencias de un conteo (plan §3.3)
// ---------------------------------------------------------------------------

/**
 * Lo que se puede decidir sobre una línea que quedó esperando: autorizar el
 * ajuste (mueve el libro) o conservar el saldo en libros. Es exactamente el
 * vocabulario del comando `stock.count.decide_adjustment`.
 */
export const ADJUSTMENT_DECISIONS = ['approve', 'reject'] as const;
export type AdjustmentDecision = (typeof ADJUSTMENT_DECISIONS)[number];

export const ADJUSTMENT_DECISION_LABELS: Readonly<Record<AdjustmentDecision, string>> = {
  approve: 'Autorizar el ajuste',
  reject: 'Conservar el saldo en libros',
};

/** Vocabulario del comando `stock.count.resolve_dispute`. */
export const DISPUTE_DECISIONS = ['adjust', 'keep_book'] as const;
export type DisputeDecision = (typeof DISPUTE_DECISIONS)[number];

export const DISPUTE_DECISION_LABELS: Readonly<Record<DisputeDecision, string>> = {
  adjust: 'Ajustar a lo contado',
  keep_book: 'Conservar el saldo en libros',
};

/** Igual que `noteSchema` / `reasonSchema` de los comandos del módulo. */
export const DECISION_NOTE_MAX = 500;

export interface AdjustmentDecisionInput {
  lineId: string;
  decision: AdjustmentDecision;
  note?: string;
}

/** Autorización (o rechazo) de una diferencia dentro de tolerancia; la nota es opcional. */
export function buildAdjustmentDecision(values: {
  lineId: string;
  decision: string;
  note?: string;
}): FieldCheck<AdjustmentDecisionInput> {
  const lineId = values.lineId.trim();
  if (!lineId) return { ok: false, error: 'No sabemos qué diferencia estás decidiendo' };
  if (!(ADJUSTMENT_DECISIONS as readonly string[]).includes(values.decision)) {
    return { ok: false, error: 'Elige si autorizas el ajuste o conservas el saldo en libros' };
  }
  const note = (values.note ?? '').trim().slice(0, DECISION_NOTE_MAX);
  return {
    ok: true,
    value: {
      lineId,
      decision: values.decision as AdjustmentDecision,
      ...(note ? { note } : {}),
    },
  };
}

export interface DisputeResolutionInput {
  lineId: string;
  decision: DisputeDecision;
  confirmedQty?: string;
  unit?: string;
  note: string;
}

/**
 * Resolución de una línea en disputa. La nota es OBLIGATORIA (el servicio la
 * exige) y la cantidad confirmada sólo tiene sentido cuando se ajusta: es el
 * reconteo que manda sobre lo capturado.
 */
export function buildDisputeResolution(values: {
  lineId: string;
  decision: string;
  confirmedQty?: string;
  unit?: string;
  note: string;
}): FieldCheck<DisputeResolutionInput> {
  const lineId = values.lineId.trim();
  if (!lineId) return { ok: false, error: 'No sabemos qué diferencia estás resolviendo' };
  if (!(DISPUTE_DECISIONS as readonly string[]).includes(values.decision)) {
    return { ok: false, error: 'Elige si ajustas a lo contado o conservas el saldo en libros' };
  }
  const note = values.note.trim();
  if (!note) return { ok: false, error: 'Explica cómo se resolvió la diferencia' };
  const decision = values.decision as DisputeDecision;
  const input: DisputeResolutionInput = {
    lineId,
    decision,
    note: note.slice(0, DECISION_NOTE_MAX),
  };
  const confirmed = (values.confirmedQty ?? '').trim();
  if (confirmed) {
    if (decision !== 'adjust') {
      return {
        ok: false,
        error: 'La cantidad confirmada sólo aplica cuando se ajusta a lo contado',
      };
    }
    const parsed = parseCountedQty(confirmed);
    if (!parsed.ok) return parsed;
    input.confirmedQty = parsed.value;
    const unit = (values.unit ?? '').trim();
    if (unit) input.unit = unit.slice(0, 30);
  }
  return { ok: true, value: input };
}

/** Las líneas de un conteo separadas por lo que falta decidir. */
export function groupCountLines<T extends { resolution: string }>(
  lines: readonly T[]
): { pending: T[]; disputed: T[]; settled: T[] } {
  const pending: T[] = [];
  const disputed: T[] = [];
  const settled: T[] = [];
  for (const line of lines) {
    if (line.resolution === 'pending') pending.push(line);
    else if (line.resolution === 'disputed') disputed.push(line);
    else settled.push(line);
  }
  return { pending, disputed, settled };
}

/**
 * Qué pasó realmente al decidir: con una política de dos firmas el ajuste NO se
 * aplicó todavía, y si nadie más puede firmar hay que decirlo en vez de dejar a
 * la persona esperando.
 */
export function describeAdjustmentOutcome(result: {
  decision: AdjustmentDecision;
  awaitingApproval: boolean;
  noApprovers: boolean;
}): string {
  if (result.awaitingApproval) {
    return result.noApprovers
      ? 'Se abrió la aprobación, pero no hay suficientes personas que puedan firmarla: avisa a la Torre de Control.'
      : 'Se abrió la aprobación del ajuste: falta otra firma para que el libro se mueva.';
  }
  return result.decision === 'approve'
    ? 'Ajuste aplicado: el libro ya refleja lo contado.'
    : 'Se conservó el saldo en libros.';
}

// ---------------------------------------------------------------------------
// Movimientos capturados a mano (plan §3.3 `recordInventoryMovement`)
// ---------------------------------------------------------------------------

/**
 * Lo que una persona puede registrar sobre una existencia desde el producto.
 * `transfer` es UN comando (salida + entrada) y `adjust`, `block` y `unblock`
 * exigen `inventory.adjust`; el resto, `inventory.manage`.
 */
export const STOCK_ACTION_KINDS = [
  'receipt',
  'issue',
  'return',
  'transfer',
  'adjust',
  'block',
  'unblock',
] as const;
export type StockActionKind = (typeof STOCK_ACTION_KINDS)[number];

export const STOCK_ACTION_LABELS: Readonly<Record<StockActionKind, string>> = {
  receipt: 'Entrada',
  issue: 'Salida',
  return: 'Devolución',
  transfer: 'Traspaso',
  adjust: 'Ajuste',
  block: 'Bloqueo',
  unblock: 'Desbloqueo',
};

export const STOCK_ACTION_HINTS: Readonly<Record<StockActionKind, string>> = {
  receipt: 'Material que entra a la bodega sin una orden de compra detrás.',
  issue: 'Material que sale de la bodega (muestra, préstamo, merma entregada).',
  return: 'Material que regresa a la bodega.',
  transfer: 'Mueve la misma existencia de una bodega o ubicación a otra.',
  adjust: 'Corrige el saldo en libros: la cantidad lleva signo y nunca es cero.',
  block: 'Aparta existencia para que nadie la prometa (daño, revisión, calidad).',
  unblock: 'Devuelve al disponible existencia que estaba bloqueada.',
};

/** Ajustes y bloqueos mueven el libro: el motor pide `inventory.adjust`. */
export function stockActionNeedsAdjustPermission(kind: StockActionKind): boolean {
  return kind === 'adjust' || kind === 'block' || kind === 'unblock';
}

/** Bloquear y desbloquear actúan sobre UNA fila concreta, no sobre el artículo. */
export function stockActionNeedsStockItem(kind: StockActionKind): boolean {
  return kind === 'block' || kind === 'unblock';
}

/** El motor exige un motivo escrito para ajustar, bloquear y desbloquear. */
export function stockActionNeedsReason(kind: StockActionKind): boolean {
  return stockActionNeedsAdjustPermission(kind);
}

export function stockActionNeedsDestination(kind: StockActionKind): boolean {
  return kind === 'transfer';
}

export interface StockActionFormValues {
  kind: StockActionKind;
  zohoItemId: string;
  warehouseId: string;
  /** Fila concreta (obligatoria para bloquear/desbloquear, opcional para el resto). */
  stockItemId: string;
  locationCode: string;
  toWarehouseId: string;
  toLocationCode: string;
  quantity: string;
  unit: string;
  reason: string;
  reference: string;
}

export function emptyStockActionForm(
  overrides: Partial<StockActionFormValues> = {}
): StockActionFormValues {
  return {
    kind: 'receipt',
    zohoItemId: '',
    warehouseId: '',
    stockItemId: '',
    locationCode: '',
    toWarehouseId: '',
    toLocationCode: '',
    quantity: '',
    unit: '',
    reason: '',
    reference: '',
    ...overrides,
  };
}

/** Lo que la acción del servidor recibe; su Zod lo vuelve a validar. */
export interface StockActionInput {
  kind: StockActionKind;
  zohoItemId: string;
  warehouseId: string;
  stockItemId?: string;
  locationCode?: string;
  toWarehouseId?: string;
  toLocationCode?: string;
  quantity: string;
  unit?: string;
  reason?: string;
  reference?: string;
}

/**
 * Valida el formulario con las MISMAS reglas del módulo (cantidad positiva,
 * ajuste con signo, motivo obligatorio, destino del traspaso, fila concreta
 * para bloquear) para que nada salga sólo a rebotar.
 */
export function buildStockAction(values: StockActionFormValues): FieldCheck<StockActionInput> {
  if (!(STOCK_ACTION_KINDS as readonly string[]).includes(values.kind)) {
    return { ok: false, error: 'Elige qué movimiento vas a registrar' };
  }
  const zohoItemId = values.zohoItemId.trim();
  if (!zohoItemId) return { ok: false, error: 'No sabemos de qué artículo es el movimiento' };
  const warehouseId = values.warehouseId.trim();
  if (!warehouseId) return { ok: false, error: 'Elige la bodega' };

  const stockItemId = values.stockItemId.trim();
  if (stockActionNeedsStockItem(values.kind) && !stockItemId) {
    return { ok: false, error: 'Elige la existencia sobre la que actúas' };
  }

  const quantity = stockActionNeedsAdjustPermission(values.kind)
    ? values.kind === 'adjust'
      ? parseSignedQty(values.quantity)
      : parsePositiveQty(values.quantity)
    : parsePositiveQty(values.quantity);
  if (!quantity.ok) return quantity;

  const input: StockActionInput = {
    kind: values.kind,
    zohoItemId,
    warehouseId,
    quantity: quantity.value,
  };
  if (stockItemId) input.stockItemId = stockItemId;

  // Con una fila elegida manda SU ubicación: el motor ignora el código, así que
  // no se envía (una ubicación que no se va a usar es una promesa falsa).
  if (!stockItemId) {
    const code = values.locationCode.trim();
    if (code) {
      const parsed = parseLocationCode(code);
      if (!parsed.ok) return parsed;
      input.locationCode = parsed.value;
    }
  }

  if (stockActionNeedsDestination(values.kind)) {
    const toWarehouseId = values.toWarehouseId.trim();
    if (!toWarehouseId) return { ok: false, error: 'Elige la bodega de destino' };
    input.toWarehouseId = toWarehouseId;
    const toCode = values.toLocationCode.trim();
    if (toCode) {
      const parsed = parseLocationCode(toCode);
      if (!parsed.ok) return parsed;
      input.toLocationCode = parsed.value;
    }
    if (toWarehouseId === warehouseId && !toCode) {
      return { ok: false, error: 'El traspaso necesita otra bodega o una ubicación de destino' };
    }
  }

  const reason = values.reason.trim();
  if (stockActionNeedsReason(values.kind) && !reason) {
    return { ok: false, error: 'Escribe el motivo: queda en la bitácora del artículo' };
  }
  if (reason) input.reason = reason.slice(0, DECISION_NOTE_MAX);

  const unit = values.unit.trim();
  if (unit) input.unit = unit.slice(0, 30);
  const reference = values.reference.trim();
  if (reference) input.reference = reference.slice(0, 120);
  return { ok: true, value: input };
}

// ---------------------------------------------------------------------------
// Reclamos legados (plan §3.3 "corte")
// ---------------------------------------------------------------------------

export const LEGACY_SOURCE_OPTIONS: ReadonlyArray<{ value: LegacyClaimSource; label: string }> =
  LEGACY_CLAIM_SOURCES.map((value) => ({ value, label: LEGACY_CLAIM_SOURCE_LABELS[value] }));

export interface LegacyClaimFormValues {
  zohoItemId: string;
  warehouseId: string;
  quantity: string;
  unit: string;
  source: string;
  reference: string;
  note: string;
}

export function emptyLegacyClaimForm(
  overrides: Partial<LegacyClaimFormValues> = {}
): LegacyClaimFormValues {
  return {
    zohoItemId: '',
    warehouseId: '',
    quantity: '',
    unit: '',
    source: 'pre_cutover_order',
    reference: '',
    note: '',
    ...overrides,
  };
}

export interface LegacyClaimInput {
  zohoItemId: string;
  warehouseId: string;
  quantity: string;
  unit?: string;
  source: LegacyClaimSource;
  /** Obligatoria: es lo que permite reconocer el compromiso meses después. */
  reference: string;
  note?: string;
}

/** Compromiso previo al corte: resta del disponible hasta confirmarse o liberarse. */
export function buildLegacyClaim(values: LegacyClaimFormValues): FieldCheck<LegacyClaimInput> {
  const zohoItemId = values.zohoItemId.trim();
  if (!zohoItemId) return { ok: false, error: 'No sabemos de qué artículo es el compromiso' };
  const warehouseId = values.warehouseId.trim();
  if (!warehouseId) return { ok: false, error: 'Elige la bodega comprometida' };
  if (!(LEGACY_CLAIM_SOURCES as readonly string[]).includes(values.source)) {
    return { ok: false, error: 'Elige de dónde viene el compromiso' };
  }
  const quantity = parsePositiveQty(values.quantity);
  if (!quantity.ok) return quantity;
  const reference = values.reference.trim();
  if (!reference) {
    return { ok: false, error: 'Escribe la referencia (número de orden, cliente o acuerdo)' };
  }
  const input: LegacyClaimInput = {
    zohoItemId,
    warehouseId,
    quantity: quantity.value,
    source: values.source as LegacyClaimSource,
    reference: reference.slice(0, 200),
  };
  const unit = values.unit.trim();
  if (unit) input.unit = unit.slice(0, 30);
  const note = values.note.trim();
  if (note) input.note = note.slice(0, DECISION_NOTE_MAX);
  return { ok: true, value: input };
}

/** Clave de la necesidad en el selector: `caseId:demandId` (sin ids sueltos en el DOM). */
export function demandOptionKey(caseId: string, demandId: string): string {
  return `${caseId}:${demandId}`;
}

export interface ConfirmLegacyClaimInput {
  claimId: string;
  caseId: string;
  demandId: string;
  allowProvisional: boolean;
}

/** Confirmar un reclamo lo vuelve reserva de UNA necesidad del expediente. */
export function buildClaimConfirmation(values: {
  claimId: string;
  demandKey: string;
  allowProvisional?: boolean;
}): FieldCheck<ConfirmLegacyClaimInput> {
  const claimId = values.claimId.trim();
  if (!claimId) return { ok: false, error: 'No sabemos qué reclamo estás confirmando' };
  const separator = values.demandKey.indexOf(':');
  const caseId = separator > 0 ? values.demandKey.slice(0, separator).trim() : '';
  const demandId = separator > 0 ? values.demandKey.slice(separator + 1).trim() : '';
  if (!caseId || !demandId) {
    return { ok: false, error: 'Elige la necesidad del expediente que cubre el compromiso' };
  }
  return {
    ok: true,
    value: { claimId, caseId, demandId, allowProvisional: values.allowProvisional === true },
  };
}

/** Cuánto le queda al reclamo antes de que el supervisor lo expire. */
export function claimExpiryLabel(expiresAt: string, now: string | Date = new Date()): string {
  const end = Date.parse(expiresAt);
  const from = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(end) || !Number.isFinite(from)) return 'Sin vencimiento conocido';
  // Días COMPLETOS que faltan: seis horas antes de vencer se dice «hoy», no «mañana».
  const days = Math.floor((end - from) / 86_400_000);
  if (days < 0) return 'Venció: el supervisor lo liberará';
  if (days === 0) return 'Vence hoy';
  if (days === 1) return 'Vence mañana';
  return `Vence en ${days} días`;
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

/** Realtime messages that make the map and the capture reload (`area:inventario`). */
export const INVENTORY_REALTIME_TYPES = ['ops.events', 'ops.requests'] as const;

// ---------------------------------------------------------------------------
// Lo que viene en camino (compras comprometidas, nunca disponible)
// ---------------------------------------------------------------------------

/** Lines of `listExpectedSupply` reduced to what one article is still waiting for. */
export interface ExpectedSupplySummary {
  /** Sum of what the supplier still owes for that article. */
  quantity: number;
  /** Purchase orders behind it. */
  orders: number;
  /** At least one of those orders passed its promised date. */
  overdue: boolean;
}

/**
 * Groups the expected supply by article. It is reported APART from the stock
 * and never added to it: material that is only expected is not available, and
 * the plan says so for Compras and for Inventario alike.
 *
 * PURE: the page reads the lines with `listExpectedSupply` (one query for the
 * whole page) and this decides what each row shows.
 */
export function summarizeExpectedSupply(
  lines: ReadonlyArray<{
    zohoItemId: string | null;
    orderId: string;
    expectedQty: string | number;
    overdue: boolean;
  }>
): Record<string, ExpectedSupplySummary> {
  const byItem = new Map<string, { quantity: number; orders: Set<string>; overdue: boolean }>();
  for (const line of lines) {
    if (!line.zohoItemId) continue;
    const amount =
      typeof line.expectedQty === 'number' ? line.expectedQty : Number(line.expectedQty);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const current = byItem.get(line.zohoItemId) ?? {
      quantity: 0,
      orders: new Set<string>(),
      overdue: false,
    };
    current.quantity = Math.round((current.quantity + amount) * 10_000) / 10_000;
    current.orders.add(line.orderId);
    current.overdue = current.overdue || line.overdue;
    byItem.set(line.zohoItemId, current);
  }
  return Object.fromEntries(
    [...byItem.entries()].map(([zohoItemId, value]) => [
      zohoItemId,
      { quantity: value.quantity, orders: value.orders.size, overdue: value.overdue },
    ])
  );
}

/** «12.5 pza en 2 órdenes» / «—» when nothing is coming. */
export function expectedSupplyText(
  summary: ExpectedSupplySummary | undefined,
  unit?: string | null
): string {
  if (!summary || summary.quantity <= 0) return '—';
  const orders = summary.orders === 1 ? '1 orden' : `${summary.orders} órdenes`;
  return `${formatQty(summary.quantity, unit)} en ${orders}`;
}
