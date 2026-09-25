/**
 * Bounds an arbitrary JSON value to a serialized size without breaking its
 * shape: long strings are cut, big arrays keep their first items and say how
 * many were omitted. The model still gets valid, navigable JSON (a hard slice
 * of the serialized text would not be).
 */

export interface ShrinkResult {
  value: unknown;
  bytes: number;
  truncated: boolean;
}

const size = (v: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(v) ?? 'null', 'utf8');
  } catch {
    return 0;
  }
};

function trim(
  value: unknown,
  limits: { str: number; arr: number; depth: number },
  depth = 0
): { v: unknown; cut: boolean } {
  if (typeof value === 'string') {
    return value.length > limits.str
      ? {
          v: `${value.slice(0, limits.str)}… [+${value.length - limits.str} caracteres]`,
          cut: true,
        }
      : { v: value, cut: false };
  }
  if (Array.isArray(value)) {
    let cut = value.length > limits.arr;
    const items = value.slice(0, limits.arr).map((item) => {
      const r = trim(item, limits, depth + 1);
      cut ||= r.cut;
      return r.v;
    });
    if (value.length > limits.arr) items.push({ _omitted: value.length - limits.arr });
    return { v: items, cut };
  }
  if (value && typeof value === 'object') {
    if (depth >= limits.depth) return { v: '[objeto anidado omitido]', cut: true };
    let cut = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = trim(v, limits, depth + 1);
      cut ||= r.cut;
      out[k] = r.v;
    }
    return { v: out, cut };
  }
  return { v: value, cut: false };
}

export function shrinkJson(value: unknown, maxBytes: number): ShrinkResult {
  const initial = size(value);
  if (initial <= maxBytes) return { value, bytes: initial, truncated: false };
  const steps = [
    { str: 2000, arr: 40, depth: 8 },
    { str: 800, arr: 25, depth: 7 },
    { str: 300, arr: 15, depth: 6 },
    { str: 120, arr: 8, depth: 5 },
    { str: 60, arr: 4, depth: 4 },
  ];
  for (const limits of steps) {
    const { v } = trim(value, limits);
    const bytes = size(v);
    if (bytes <= maxBytes) return { value: v, bytes, truncated: true };
  }
  const preview = JSON.stringify(value).slice(0, Math.max(200, maxBytes - 200));
  return {
    value: { _truncated: true, originalBytes: initial, preview },
    bytes: maxBytes,
    truncated: true,
  };
}
