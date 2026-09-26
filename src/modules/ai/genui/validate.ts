import type { z } from 'zod';
import {
  GENUI_ACTIONS,
  GENUI_BUILTIN_ACTIONS,
  GENUI_COMPONENTS,
  GENUI_LIMITS,
  type GenUiComponentDef,
  type GenUiElement,
  type GenUiSpec,
} from './catalog';

/**
 * Sanitizes a json-render spec against the UNIK catalog. Runs on the server
 * when an agent emits a card AND again on the client before rendering (the
 * renderer itself does not validate props).
 *
 * Keeps only: catalog components with props that pass their Zod schema,
 * well-formed expressions ($state, $bindState, $item, $bindItem, $index,
 * $cond, $template — never $computed), catalog/built-in actions with valid
 * params, https/app URLs, a reachable acyclic tree and bounded sizes.
 * Everything else is dropped and reported so the model can fix it.
 *
 * Pure — no I/O. Unit tested.
 */

export interface GenUiValidation {
  spec: GenUiSpec | null;
  /** Human-readable problems (dropped elements/props/actions). */
  issues: string[];
}

const KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;
const POINTER_RE = /^\/[A-Za-z0-9_\-./~[\]]{0,200}$/;
const COMPARISON_KEYS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'not']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isPointer(v: unknown): v is string {
  return typeof v === 'string' && POINTER_RE.test(v) && !v.includes('..');
}

/** Plain JSON value with bounded size and no functions/prototype tricks. */
function isPlainJson(v: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
    return typeof v !== 'number' || Number.isFinite(v as number);
  }
  if (Array.isArray(v)) return v.length <= 500 && v.every((x) => isPlainJson(x, depth + 1));
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length > 200) return false;
    return keys.every(
      (k) => k !== '__proto__' && k !== 'constructor' && isPlainJson(v[k], depth + 1)
    );
  }
  return false;
}

/** Only https URLs or in-app paths. */
export function isSafeHref(v: unknown): boolean {
  if (typeof v !== 'string' || v.length > 2000) return false;
  if (v.startsWith('/app/') || v === '/app') return !v.startsWith('//');
  try {
    const u = new URL(v);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isExpression(v: unknown): v is Record<string, unknown> {
  if (!isObj(v)) return false;
  return (
    '$state' in v ||
    '$bindState' in v ||
    '$item' in v ||
    '$bindItem' in v ||
    '$index' in v ||
    '$cond' in v ||
    '$template' in v ||
    '$computed' in v
  );
}

/** Visibility / condition grammar of json-render (subset, strict). */
export function isValidCondition(c: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof c === 'boolean') return true;
  if (Array.isArray(c)) return c.length <= 8 && c.every((x) => isValidCondition(x, depth + 1));
  if (!isObj(c)) return false;
  if ('$and' in c || '$or' in c) {
    const list = (c.$and ?? c.$or) as unknown;
    return (
      Object.keys(c).length === 1 &&
      Array.isArray(list) &&
      list.length <= 8 &&
      list.every((x) => isValidCondition(x, depth + 1))
    );
  }
  const sources = ['$state', '$item', '$index'].filter((k) => k in c);
  if (sources.length !== 1) return false;
  const src = sources[0];
  if (src === '$state' && !isPointer(c.$state)) return false;
  if (src === '$item' && (typeof c.$item !== 'string' || c.$item.length > 80)) return false;
  if (src === '$index' && c.$index !== true) return false;
  for (const [k, v] of Object.entries(c)) {
    if (k === src) continue;
    if (!COMPARISON_KEYS.has(k)) return false;
    if (k === 'not') {
      if (typeof v !== 'boolean') return false;
    } else if (!(isPlainJson(v) || isExpression(v)) || jsonSize(v) > 400) return false;
  }
  return true;
}

/** Dynamic value expression (props, action params). */
export function isValidExpression(v: Record<string, unknown>, depth = 0): boolean {
  if (depth > 4) return false;
  if ('$computed' in v) return false; // no functions are registered: never allowed
  if ('$state' in v) return Object.keys(v).length === 1 && isPointer(v.$state);
  if ('$bindState' in v) return Object.keys(v).length === 1 && isPointer(v.$bindState);
  if ('$item' in v)
    return Object.keys(v).length === 1 && typeof v.$item === 'string' && v.$item.length <= 80;
  if ('$bindItem' in v)
    return (
      Object.keys(v).length === 1 && typeof v.$bindItem === 'string' && v.$bindItem.length <= 80
    );
  if ('$index' in v) return Object.keys(v).length === 1 && v.$index === true;
  if ('$template' in v)
    return (
      Object.keys(v).length === 1 && typeof v.$template === 'string' && v.$template.length <= 2000
    );
  if ('$cond' in v) {
    const keys = Object.keys(v);
    if (!keys.every((k) => k === '$cond' || k === '$then' || k === '$else')) return false;
    if (!isValidCondition(v.$cond)) return false;
    const branch = (b: unknown) =>
      b === undefined ||
      (isExpression(b) ? isValidExpression(b, depth + 1) : isPlainJson(b) && jsonSize(b) <= 4000);
    return branch(v.$then) && branch(v.$else);
  }
  return false;
}

/** Top-level shape of a component's props (z.object). */
function shapeOf(def: GenUiComponentDef): Record<string, z.ZodTypeAny> {
  return def.props.shape as Record<string, z.ZodTypeAny>;
}

function isOptional(schema: z.ZodTypeAny): boolean {
  return schema.safeParse(undefined).success;
}

function cleanProps(
  key: string,
  type: string,
  def: GenUiComponentDef,
  raw: unknown,
  issues: string[]
): Record<string, unknown> | null {
  const input = isObj(raw) ? raw : {};
  const shape = shapeOf(def);
  const out: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(input)) {
    const schema = shape[prop];
    if (!schema) {
      issues.push(`${key} (${type}): se ignoró la prop desconocida "${prop}"`);
      continue;
    }
    // null/undefined = absent (a required prop then fails below).
    if (value === undefined || value === null) continue;
    if (isExpression(value)) {
      if (isValidExpression(value)) out[prop] = value;
      else issues.push(`${key} (${type}): expresión inválida en "${prop}"`);
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      issues.push(
        `${key} (${type}): "${prop}" inválido — ${parsed.error.issues[0]?.message ?? 'formato'}`
      );
      continue;
    }
    out[prop] = parsed.data;
  }
  for (const [prop, schema] of Object.entries(shape)) {
    if (!(prop in out) && !isOptional(schema)) {
      issues.push(`${key} (${type}): falta la prop requerida "${prop}"`);
      return null;
    }
  }
  // URL policy on the props that hold links.
  if (type === 'Image' && typeof out.src === 'string' && !isSafeHref(out.src)) {
    issues.push(`${key} (Image): solo se permiten imágenes https`);
    return null;
  }
  if (type === 'FilePreview' && typeof out.href === 'string' && !isSafeHref(out.href)) {
    issues.push(`${key} (FilePreview): enlace no permitido`);
    delete out.href;
  }
  return out;
}

function cleanParams(
  action: string,
  raw: unknown,
  issues: string[],
  where: string
): Record<string, unknown> | null {
  const params = isObj(raw) ? raw : {};
  if (GENUI_BUILTIN_ACTIONS.includes(action)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === 'statePath' || k === 'clearStatePath') {
        if (!isPointer(v)) {
          issues.push(`${where}: ${action} necesita un statePath válido`);
          return null;
        }
        out[k] = v;
      } else if (k === 'index') {
        if (typeof v !== 'number' && !(isExpression(v) && isValidExpression(v))) return null;
        out[k] = v;
      } else if (k === 'value') {
        if (isExpression(v) ? !isValidExpression(v) : !isPlainJson(v) || jsonSize(v) > 20_000)
          return null;
        out[k] = v;
      }
    }
    if (action !== 'validateForm' && typeof out.statePath !== 'string') return null;
    return out;
  }
  const def = GENUI_ACTIONS[action as keyof typeof GENUI_ACTIONS];
  if (!def) return null;
  const shape = def.params.shape as Record<string, z.ZodTypeAny>;
  const out: Record<string, unknown> = {};
  for (const [k, schema] of Object.entries(shape)) {
    const v = params[k];
    if (v === undefined) {
      if (!isOptional(schema)) {
        issues.push(`${where}: a la acción ${action} le falta "${k}"`);
        return null;
      }
      continue;
    }
    if (isExpression(v)) {
      if (!isValidExpression(v)) return null;
      out[k] = v;
      continue;
    }
    const parsed = schema.safeParse(v);
    if (!parsed.success) {
      issues.push(`${where}: parámetro "${k}" inválido para ${action}`);
      return null;
    }
    out[k] = parsed.data;
  }
  if (action === 'openUrl' && typeof out.url === 'string' && !isSafeHref(out.url)) {
    issues.push(`${where}: openUrl solo abre https o rutas /app`);
    return null;
  }
  return out;
}

function cleanOn(
  key: string,
  def: GenUiComponentDef,
  raw: unknown,
  issues: string[]
): Record<string, unknown> | undefined {
  if (!isObj(raw)) return undefined;
  const allowed = new Set(def.events ?? []);
  const out: Record<string, unknown> = {};
  for (const [event, binding] of Object.entries(raw)) {
    if (!allowed.has(event)) {
      issues.push(`${key}: el evento "${event}" no existe en este componente`);
      continue;
    }
    const list = (Array.isArray(binding) ? binding : [binding]).slice(0, 4);
    const kept: Array<Record<string, unknown>> = [];
    for (const b of list) {
      if (!isObj(b) || typeof b.action !== 'string') continue;
      const action = b.action;
      if (!(action in GENUI_ACTIONS) && !GENUI_BUILTIN_ACTIONS.includes(action)) {
        issues.push(`${key}: acción desconocida "${action}"`);
        continue;
      }
      const params = cleanParams(action, b.params, issues, `${key}.on.${event}`);
      if (params === null) continue;
      // No `confirm`: json-render's dialog is unstyled (always white); real
      // confirmations are UNIK's approval cards.
      kept.push({ action, params });
    }
    if (kept.length === 1) out[event] = kept[0];
    else if (kept.length > 1) out[event] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function sanitizeGenUiSpec(input: unknown): GenUiValidation {
  const issues: string[] = [];
  if (!isObj(input) || typeof input.root !== 'string' || !isObj(input.elements)) {
    return { spec: null, issues: ['El spec necesita "root" (string) y "elements" (objeto).'] };
  }
  if (jsonSize(input) > GENUI_LIMITS.maxSpecBytes) {
    return { spec: null, issues: ['El spec es demasiado grande.'] };
  }
  const rawElements = Object.entries(input.elements).slice(0, GENUI_LIMITS.maxElements * 2);
  const elements: Record<string, GenUiElement> = {};
  for (const [key, raw] of rawElements) {
    if (!KEY_RE.test(key) || !isObj(raw)) {
      issues.push(`Elemento "${key.slice(0, 40)}" inválido`);
      continue;
    }
    const type = typeof raw.type === 'string' ? raw.type : '';
    const def = (GENUI_COMPONENTS as Record<string, GenUiComponentDef>)[type];
    if (!def) {
      issues.push(`${key}: el componente "${type}" no existe en el catálogo`);
      continue;
    }
    const props = cleanProps(key, type, def, raw.props, issues);
    if (!props) continue;
    const el: GenUiElement = { type, props };
    if (def.slots.includes('default') && Array.isArray(raw.children)) {
      el.children = raw.children
        .filter((c): c is string => typeof c === 'string' && KEY_RE.test(c))
        .slice(0, 60);
    } else {
      el.children = [];
    }
    if (raw.visible !== undefined) {
      if (isValidCondition(raw.visible)) el.visible = raw.visible;
      else issues.push(`${key}: condición "visible" inválida (se ignoró)`);
    }
    const on = cleanOn(key, def, raw.on, issues);
    if (on) el.on = on;
    if (isObj(raw.repeat)) {
      const sp = raw.repeat.statePath;
      if (isPointer(sp)) {
        el.repeat = {
          statePath: sp,
          ...(typeof raw.repeat.key === 'string' && raw.repeat.key.length <= 60
            ? { key: raw.repeat.key }
            : {}),
        };
      } else issues.push(`${key}: repeat.statePath inválido`);
    }
    elements[key] = el;
  }

  const root = input.root;
  if (!elements[root]) {
    return { spec: null, issues: [...issues, `La raíz "${root}" no es un elemento válido.`] };
  }

  // Reachable, acyclic tree from the root (depth-bounded); dangling refs dropped.
  const reachable: Record<string, GenUiElement> = {};
  const walk = (key: string, depth: number, path: Set<string>) => {
    const el = elements[key];
    if (!el || path.has(key)) return;
    if (depth > GENUI_LIMITS.maxDepth) {
      issues.push(`${key}: demasiada profundidad`);
      return;
    }
    if (Object.keys(reachable).length >= GENUI_LIMITS.maxElements && !reachable[key]) {
      issues.push('Demasiados elementos: se recortó el resto.');
      return;
    }
    const next = new Set(path).add(key);
    const children = (el.children ?? []).filter((c) => elements[c] && !next.has(c));
    reachable[key] = { ...el, children };
    for (const c of children) walk(c, depth + 1, next);
  };
  walk(root, 0, new Set());
  for (const [k, el] of Object.entries(reachable)) {
    el.children = (el.children ?? []).filter((c) => reachable[c]);
    if (el.repeat && el.children.length === 0) delete el.repeat;
    reachable[k] = el;
  }

  let state: Record<string, unknown> | undefined;
  if (input.state !== undefined) {
    if (
      isObj(input.state) &&
      isPlainJson(input.state) &&
      jsonSize(input.state) <= GENUI_LIMITS.maxStateBytes
    ) {
      state = input.state;
    } else {
      issues.push('El estado inicial es inválido o demasiado grande (se ignoró).');
    }
  }

  return { spec: { root, elements: reachable, ...(state ? { state } : {}) }, issues };
}
