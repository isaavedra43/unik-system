/**
 * Canonical variant keys of stock items (`StockItem.variantKey`).
 *
 * A variant is a set of `axis=value` pairs (medida, color, acabado, lote,
 * rollo, placa…). The key is canonical so the same physical variant always
 * lands in the same stock row regardless of how it was typed:
 *
 * - axes: lowercase, no accents, spaces/hyphens → `_`, `[a-z][a-z0-9_]{0,29}`;
 * - values: trimmed, inner whitespace collapsed, lowercase, no accents;
 * - pairs sorted by axis and joined with `|`; empty values are dropped;
 * - `%`, `|` and `=` inside values are percent-encoded.
 *
 * Example: `{Medida: '60X60', color: ' Gris '}` → `"color=gris|medida=60x60"`.
 * The empty string means "no variant".
 *
 * `buildVariant` also returns the display JSON (original casing, trimmed) that
 * goes to `StockItem.variantJson`. Pure module.
 */

export const VARIANT_KEY_MAX_LENGTH = 400;
const AXIS_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;
const VALUE_MAX_LENGTH = 80;
const MAX_AXES = 8;

export type VariantScalar = string | number | boolean | null | undefined;
export type VariantInput =
  Readonly<Record<string, VariantScalar>> | ReadonlyArray<{ axis: string; value: VariantScalar }>;

export class VariantKeyError extends Error {
  readonly code = 'invalid_variant';
  constructor(message: string) {
    super(message);
    this.name = 'VariantKeyError';
  }
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** `'Acabado '` → `'acabado'`; returns '' when the axis cannot be normalized. */
export function normalizeVariantAxis(axis: string): string {
  const normalized = stripAccents(String(axis ?? ''))
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return AXIS_PATTERN.test(normalized) ? normalized : '';
}

/** Display form of a value: trimmed with inner whitespace collapsed ('' when empty). */
export function displayVariantValue(value: VariantScalar): string {
  if (value === null || value === undefined) return '';
  return String(value).normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** Canonical form of a value used inside the key. */
export function normalizeVariantValue(value: VariantScalar): string {
  return stripAccents(displayVariantValue(value)).toLowerCase();
}

function encodePart(text: string): string {
  return text.replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/=/g, '%3D');
}

function decodePart(text: string): string {
  return text.replace(/%(25|7C|3D)/gi, (_match, code: string) => {
    const upper = code.toUpperCase();
    return upper === '25' ? '%' : upper === '7C' ? '|' : '=';
  });
}

function entriesOf(input: VariantInput): Array<[string, VariantScalar]> {
  if (Array.isArray(input)) {
    return (input as ReadonlyArray<{ axis: string; value: VariantScalar }>).map((entry) => [
      entry?.axis,
      entry?.value,
    ]);
  }
  return Object.entries(input as Record<string, VariantScalar>);
}

export interface BuiltVariant {
  /** Canonical key ('' without variant). */
  key: string;
  /** Display values by normalized axis, or null without variant. */
  json: Record<string, string> | null;
  axes: string[];
}

/** Builds the canonical key and display JSON. Throws `VariantKeyError` on invalid input. */
export function buildVariant(input: VariantInput | null | undefined): BuiltVariant {
  if (input === null || input === undefined) return { key: '', json: null, axes: [] };
  const pairs = new Map<string, { value: string; display: string }>();
  for (const [rawAxis, rawValue] of entriesOf(input)) {
    const display = displayVariantValue(rawValue);
    if (!display) continue;
    const axis = normalizeVariantAxis(String(rawAxis ?? ''));
    if (!axis) throw new VariantKeyError(`Eje de variante inválido: "${String(rawAxis)}"`);
    if (pairs.has(axis)) throw new VariantKeyError(`El eje "${axis}" está repetido`);
    if (display.length > VALUE_MAX_LENGTH) {
      throw new VariantKeyError(`El valor de "${axis}" es demasiado largo`);
    }
    pairs.set(axis, { value: normalizeVariantValue(rawValue), display });
  }
  if (pairs.size > MAX_AXES) {
    throw new VariantKeyError(`Una variante admite como máximo ${MAX_AXES} ejes`);
  }
  const axes = [...pairs.keys()].sort();
  const key = axes.map((axis) => `${axis}=${encodePart(pairs.get(axis)!.value)}`).join('|');
  if (key.length > VARIANT_KEY_MAX_LENGTH) {
    throw new VariantKeyError('La variante es demasiado larga');
  }
  const json = axes.length
    ? Object.fromEntries(axes.map((axis) => [axis, pairs.get(axis)!.display]))
    : null;
  return { key, json, axes };
}

/** Canonical key of a variant (`"color=gris|medida=60x60"`, '' without variant). */
export function buildVariantKey(input: VariantInput | null | undefined): string {
  return buildVariant(input).key;
}

/** Inverse of `buildVariantKey` (values come back in canonical form). Throws on malformed keys. */
export function parseVariantKey(key: string | null | undefined): Record<string, string> {
  const text = key ?? '';
  if (text === '') return {};
  if (text.length > VARIANT_KEY_MAX_LENGTH) {
    throw new VariantKeyError('La variante es demasiado larga');
  }
  const out: Record<string, string> = {};
  for (const part of text.split('|')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new VariantKeyError(`Variante mal formada: "${part}"`);
    const axis = part.slice(0, eq);
    const value = decodePart(part.slice(eq + 1));
    if (!AXIS_PATTERN.test(axis)) throw new VariantKeyError(`Eje de variante inválido: "${axis}"`);
    if (!value) throw new VariantKeyError(`El eje "${axis}" no tiene valor`);
    if (axis in out) throw new VariantKeyError(`El eje "${axis}" está repetido`);
    out[axis] = value;
  }
  return out;
}

/** True when the key is exactly what `buildVariantKey` would produce for its own content. */
export function isCanonicalVariantKey(key: string): boolean {
  try {
    return buildVariantKey(parseVariantKey(key)) === key;
  } catch {
    return false;
  }
}

/** Axes present in a key. */
export function variantAxesOf(key: string): string[] {
  return Object.keys(parseVariantKey(key));
}

export type VariantValidation =
  | { ok: true; variantKey: string; variantJson: Record<string, string> | null }
  | { ok: false; code: 'invalid_variant'; message: string; unknownAxes: string[] };

/**
 * Validates a variant against the axes allowed by the item profile. A profile
 * without axes only accepts the empty variant. Accepts the structured input or
 * an already built key.
 */
export function validateVariant(
  input: VariantInput | string | null | undefined,
  allowedAxes: readonly string[]
): VariantValidation {
  let built: BuiltVariant;
  try {
    if (typeof input === 'string') {
      const parsed = parseVariantKey(input.trim());
      built = buildVariant(parsed);
      if (built.key !== input.trim()) {
        return {
          ok: false,
          code: 'invalid_variant',
          message: 'La variante no está en forma canónica',
          unknownAxes: [],
        };
      }
    } else {
      built = buildVariant(input);
    }
  } catch (err) {
    return {
      ok: false,
      code: 'invalid_variant',
      message: err instanceof Error ? err.message : 'Variante inválida',
      unknownAxes: [],
    };
  }
  const allowed = new Set(allowedAxes.map((axis) => normalizeVariantAxis(axis)).filter(Boolean));
  const unknownAxes = built.axes.filter((axis) => !allowed.has(axis));
  if (unknownAxes.length > 0) {
    return {
      ok: false,
      code: 'invalid_variant',
      message:
        allowed.size === 0
          ? 'Este artículo no maneja variantes'
          : `Ejes no permitidos para este artículo: ${unknownAxes.join(', ')}`,
      unknownAxes,
    };
  }
  return {
    ok: true,
    variantKey: built.key,
    variantJson:
      built.json ?? (typeof input === 'string' && built.key ? parseVariantKey(built.key) : null),
  };
}

/** Human description: `"color: gris · medida: 60x60"` ('' without variant). */
export function describeVariant(
  key: string | null | undefined,
  json?: Record<string, unknown> | null
): string {
  let values: Record<string, unknown>;
  try {
    values = json && Object.keys(json).length > 0 ? json : parseVariantKey(key ?? '');
  } catch {
    return key ?? '';
  }
  return Object.keys(values)
    .sort()
    .map((axis) => `${axis}: ${String(values[axis])}`)
    .join(' · ');
}
