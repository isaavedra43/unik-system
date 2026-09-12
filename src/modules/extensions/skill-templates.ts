/**
 * Declarative template resolution for skills.
 *
 * Steps reference inputs and previous results with `{{path}}` expressions
 * such as `{{inputs.material}}` or `{{steps.lookup.result.items[0].sku}}`.
 * Resolution is a pure path lookup over a data object: there is no `eval`,
 * no function calls, no arithmetic — a template can only READ values.
 */

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[\d+\]))*$/;
const EXPR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export function lookupPath(data: unknown, path: string): unknown {
  if (!PATH_RE.test(path)) throw new TemplateError(`Expresión no permitida: ${path}`);
  const tokens = path.match(/[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g) ?? [];
  let current: unknown = data;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (token.startsWith('[')) {
      const index = Number(token.slice(1, -1));
      current = Array.isArray(current) ? current[index] : undefined;
    } else {
      if (typeof current !== 'object') return undefined;
      // Prototype pollution guard: only own enumerable properties.
      current = Object.prototype.hasOwnProperty.call(current, token)
        ? (current as Record<string, unknown>)[token]
        : undefined;
    }
  }
  return current;
}

/**
 * Resolves a template string. A string consisting of exactly one expression
 * returns the raw value (object, array, number...); mixed strings are
 * interpolated as text.
 */
export function resolveTemplateString(template: string, data: unknown): unknown {
  const single = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(template);
  if (single) return lookupPath(data, single[1]);
  return template.replace(EXPR_RE, (_m, expr: string) => {
    const value = lookupPath(data, expr);
    if (value === undefined || value === null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** Recursively resolves templates inside any JSON-like value. */
export function resolveTemplates<T>(value: T, data: unknown): T {
  if (typeof value === 'string') return resolveTemplateString(value, data) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, data)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = resolveTemplates(v, data);
    return out as unknown as T;
  }
  return value;
}

/**
 * Declarative conditions: `{ path, op, value }` where op ∈ eq, neq, gt, gte,
 * lt, lte, exists, empty, contains, in. No expressions, no code.
 */
export interface SkillCondition {
  path: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'empty' | 'contains' | 'in';
  value?: unknown;
}

export function evaluateCondition(condition: SkillCondition, data: unknown): boolean {
  const actual = lookupPath(data, condition.path);
  switch (condition.op) {
    case 'eq':
      return actual === condition.value;
    case 'neq':
      return actual !== condition.value;
    case 'gt':
      return (
        typeof actual === 'number' &&
        typeof condition.value === 'number' &&
        actual > condition.value
      );
    case 'gte':
      return (
        typeof actual === 'number' &&
        typeof condition.value === 'number' &&
        actual >= condition.value
      );
    case 'lt':
      return (
        typeof actual === 'number' &&
        typeof condition.value === 'number' &&
        actual < condition.value
      );
    case 'lte':
      return (
        typeof actual === 'number' &&
        typeof condition.value === 'number' &&
        actual <= condition.value
      );
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'empty':
      return (
        actual === undefined ||
        actual === null ||
        actual === '' ||
        (Array.isArray(actual) && actual.length === 0) ||
        (typeof actual === 'object' &&
          !Array.isArray(actual) &&
          Object.keys(actual as object).length === 0)
      );
    case 'contains':
      if (typeof actual === 'string')
        return typeof condition.value === 'string' && actual.includes(condition.value);
      if (Array.isArray(actual)) return actual.includes(condition.value);
      return false;
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(actual);
    default:
      return false;
  }
}
