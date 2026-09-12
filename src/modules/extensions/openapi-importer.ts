import type { JsonSchema } from './json-schema-to-zod';

/**
 * OpenAPI 3.x importer for custom API extensions.
 *
 * Produces candidate operations (method, path, parameters, body schema,
 * response schema) for the administrator to SELECT and REVIEW. External
 * `$ref`s (http(s):// or file paths) are never downloaded; only local
 * `#/components/...` references are resolved, with cycle protection.
 */

export interface ImportedOperation {
  operationId: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  description: string;
  pathParams: JsonSchema;
  queryParams: JsonSchema;
  headerParams: string[];
  bodySchema: JsonSchema | null;
  bodyContentType: string | null;
  responseSchema: JsonSchema | null;
  /** Suggested effect classification (the admin decides the final one). */
  suggestedEffect: 'read' | 'business_write' | 'destructive';
  deprecated: boolean;
}

export interface OpenApiImportResult {
  title: string;
  version: string;
  servers: string[];
  operations: ImportedOperation[];
  warnings: string[];
}

export class OpenApiImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiImportError';
  }
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function isExternalRef(ref: string): boolean {
  return !ref.startsWith('#/');
}

function resolveLocalRef(doc: Record<string, unknown>, ref: string): unknown {
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = doc;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Deep-resolves local refs; external refs are replaced with `{}` and reported. */
function deref(
  doc: Record<string, unknown>,
  node: unknown,
  warnings: string[],
  seen: Set<string> = new Set(),
  depth = 0
): unknown {
  if (depth > 20) return {};
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, warnings, seen, depth + 1));
  if (!node || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref;
    if (isExternalRef(ref)) {
      warnings.push(`Referencia externa ignorada: ${ref}`);
      return {};
    }
    if (seen.has(ref)) return { description: `(recursivo: ${ref})` };
    const target = resolveLocalRef(doc, ref);
    if (target === undefined) {
      warnings.push(`Referencia no encontrada: ${ref}`);
      return {};
    }
    const next = new Set(seen);
    next.add(ref);
    return deref(doc, target, warnings, next, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = deref(doc, v, warnings, seen, depth + 1);
  return out;
}

function paramsToSchema(
  params: Array<Record<string, unknown>>,
  where: 'path' | 'query'
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const p of params) {
    if (p.in !== where || typeof p.name !== 'string') continue;
    const schema = (p.schema as JsonSchema | undefined) ?? { type: 'string' };
    properties[p.name] = {
      ...schema,
      description: (p.description as string | undefined) ?? schema.description,
    };
    if (p.required === true || where === 'path') required.push(p.name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function suggestEffect(
  method: string,
  path: string,
  summary: string
): ImportedOperation['suggestedEffect'] {
  if (method === 'GET') return 'read';
  if (method === 'DELETE' || /delete|remove|cancel|void/i.test(summary + path))
    return 'destructive';
  return 'business_write';
}

function slug(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

export function importOpenApi(document: unknown): OpenApiImportResult {
  if (!document || typeof document !== 'object')
    throw new OpenApiImportError('Documento OpenAPI inválido');
  const doc = document as Record<string, unknown>;
  const version = String(doc.openapi ?? '');
  if (!version.startsWith('3.')) throw new OpenApiImportError('Solo se admite OpenAPI 3.x');
  const info = (doc.info as Record<string, unknown> | undefined) ?? {};
  const warnings: string[] = [];
  const servers = Array.isArray(doc.servers)
    ? (doc.servers as Array<Record<string, unknown>>)
        .map((s) => String(s.url ?? ''))
        .filter((u) => u.length > 0)
    : [];
  const paths = (doc.paths as Record<string, Record<string, unknown>> | undefined) ?? {};
  const operations: ImportedOperation[] = [];

  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    const pathLevelParams = Array.isArray(item.parameters)
      ? (deref(doc, item.parameters, warnings) as Array<Record<string, unknown>>)
      : [];
    for (const method of METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op || typeof op !== 'object') continue;
      const opParams = Array.isArray(op.parameters)
        ? (deref(doc, op.parameters, warnings) as Array<Record<string, unknown>>)
        : [];
      const params = [...pathLevelParams, ...opParams];
      const requestBody = deref(doc, op.requestBody, warnings) as
        Record<string, unknown> | undefined;
      let bodySchema: JsonSchema | null = null;
      let bodyContentType: string | null = null;
      const content =
        (requestBody?.content as Record<string, Record<string, unknown>> | undefined) ?? {};
      const preferred = ['application/json', 'application/x-www-form-urlencoded'];
      for (const ct of [...preferred, ...Object.keys(content)]) {
        if (content[ct]) {
          bodySchema = (content[ct].schema as JsonSchema | undefined) ?? null;
          bodyContentType = ct;
          break;
        }
      }
      const responses =
        (deref(doc, op.responses, warnings) as
          Record<string, Record<string, unknown>> | undefined) ?? {};
      let responseSchema: JsonSchema | null = null;
      for (const code of ['200', '201', '2XX', 'default']) {
        const r = responses[code];
        const rc = (r?.content as Record<string, Record<string, unknown>> | undefined) ?? {};
        const json = rc['application/json'];
        if (json?.schema) {
          responseSchema = json.schema as JsonSchema;
          break;
        }
      }
      const summary = String(op.summary ?? '');
      const upper = method.toUpperCase() as ImportedOperation['method'];
      operations.push({
        operationId:
          typeof op.operationId === 'string' && op.operationId.length > 0
            ? slug(op.operationId)
            : slug(`${method}_${path}`),
        method: upper,
        path,
        summary,
        description: String(op.description ?? ''),
        pathParams: paramsToSchema(params, 'path'),
        queryParams: paramsToSchema(params, 'query'),
        headerParams: params
          .filter((p) => p.in === 'header' && typeof p.name === 'string')
          .map((p) => p.name as string),
        bodySchema,
        bodyContentType,
        responseSchema,
        suggestedEffect: suggestEffect(upper, path, summary),
        deprecated: op.deprecated === true,
      });
    }
  }

  if (operations.length === 0) warnings.push('El documento no contiene operaciones');
  return {
    title: String(info.title ?? 'API'),
    version: String(info.version ?? ''),
    servers,
    operations,
    warnings,
  };
}

/**
 * Selects the fields of a response the model may receive. `fields` are dot
 * paths; `items[].sku` keeps the array structure and projects each element.
 * Empty = whole (bounded) response.
 */
export function selectResponseFields(value: unknown, fields: string[]): unknown {
  if (fields.length === 0) return value;
  const tree: ProjectionNode = {};
  for (const field of fields) {
    let node = tree;
    for (const part of field.split('.')) {
      const isArray = part.endsWith('[]');
      const key = isArray ? part.slice(0, -2) : part;
      node[key] ??= { array: isArray, children: {} };
      if (isArray) node[key].array = true;
      node = node[key].children;
    }
  }
  return project(value, tree);
}

interface ProjectionNode {
  [key: string]: { array: boolean; children: ProjectionNode };
}

function project(value: unknown, tree: ProjectionNode): unknown {
  if (Object.keys(tree).length === 0) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(tree)) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    if (node.array) {
      if (!Array.isArray(child)) continue;
      out[key] = child.map((item) => project(item, node.children)).filter((v) => v !== undefined);
    } else {
      const projected = project(child, node.children);
      if (projected !== undefined) out[key] = projected;
    }
  }
  return out;
}
