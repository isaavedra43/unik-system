import { z, type ZodTypeAny } from 'zod';

/**
 * Converts a (subset of) JSON Schema — what MCP servers and OpenAPI documents
 * publish for tool/operation parameters — into a Zod schema so external tools
 * are validated with the same executor as built-in ones.
 *
 * Supported: type (string/number/integer/boolean/array/object/null), enum,
 * const, properties/required/additionalProperties, items, anyOf/oneOf/allOf,
 * nullable, min/max, minLength/maxLength, pattern, description, default.
 * Anything unknown becomes `z.unknown()` (never a permissive string that could
 * silently pass garbage to a business system).
 */

export type JsonSchema = Record<string, unknown>;

const MAX_DEPTH = 12;

function withDescription(schema: ZodTypeAny, node: JsonSchema): ZodTypeAny {
  return typeof node.description === 'string' ? schema.describe(node.description) : schema;
}

export function jsonSchemaToZod(node: JsonSchema | boolean | undefined, depth = 0): ZodTypeAny {
  if (node === undefined || node === true) return z.unknown();
  if (node === false) return z.never();
  if (depth > MAX_DEPTH) return z.unknown();

  if (Array.isArray(node.enum)) {
    const values = node.enum as unknown[];
    const strings = values.filter((v): v is string => typeof v === 'string');
    if (strings.length === values.length && strings.length > 0) {
      return withDescription(z.enum(strings as [string, ...string[]]), node);
    }
    return withDescription(
      z.union(
        values.map((v) => z.literal(v as never)) as unknown as [
          ZodTypeAny,
          ZodTypeAny,
          ...ZodTypeAny[],
        ]
      ),
      node
    );
  }
  if ('const' in node) return withDescription(z.literal(node.const as never), node);

  const variants = (node.anyOf ?? node.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    const schemas = variants.map((v) => jsonSchemaToZod(v, depth + 1));
    const union =
      schemas.length === 1
        ? schemas[0]
        : z.union(schemas as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    return withDescription(union, node);
  }
  if (Array.isArray(node.allOf) && (node.allOf as JsonSchema[]).length > 0) {
    const schemas = (node.allOf as JsonSchema[]).map((v) => jsonSchemaToZod(v, depth + 1));
    let merged: ZodTypeAny = schemas[0];
    for (const s of schemas.slice(1)) merged = z.intersection(merged, s);
    return withDescription(merged, node);
  }

  let type = node.type as string | string[] | undefined;
  let nullable = node.nullable === true;
  if (Array.isArray(type)) {
    if (type.includes('null')) nullable = true;
    const rest = type.filter((t) => t !== 'null');
    if (rest.length > 1) {
      const union = z.union(
        rest.map((t) => jsonSchemaToZod({ ...node, type: t }, depth + 1)) as [
          ZodTypeAny,
          ZodTypeAny,
          ...ZodTypeAny[],
        ]
      );
      return nullable ? union.nullable() : union;
    }
    type = rest[0];
  }
  if (!type) {
    if (node.properties) type = 'object';
    else if (node.items) type = 'array';
  }

  let schema: ZodTypeAny;
  switch (type) {
    case 'string': {
      let s = z.string();
      if (typeof node.minLength === 'number') s = s.min(node.minLength);
      if (typeof node.maxLength === 'number') s = s.max(node.maxLength);
      if (typeof node.pattern === 'string') {
        try {
          s = s.regex(new RegExp(node.pattern));
        } catch {
          // invalid pattern: ignore rather than reject every value
        }
      }
      if (node.format === 'date-time') s = s.datetime({ offset: true });
      if (node.format === 'email') s = s.email();
      if (node.format === 'uri' || node.format === 'url') s = s.url();
      schema = s;
      break;
    }
    case 'integer':
    case 'number': {
      let n = z.number();
      if (type === 'integer') n = n.int();
      if (typeof node.minimum === 'number') n = n.min(node.minimum);
      if (typeof node.maximum === 'number') n = n.max(node.maximum);
      if (typeof node.exclusiveMinimum === 'number') n = n.gt(node.exclusiveMinimum);
      if (typeof node.exclusiveMaximum === 'number') n = n.lt(node.exclusiveMaximum);
      schema = n;
      break;
    }
    case 'boolean':
      schema = z.boolean();
      break;
    case 'null':
      schema = z.null();
      break;
    case 'array': {
      let a = z.array(jsonSchemaToZod(node.items as JsonSchema | undefined, depth + 1));
      if (typeof node.minItems === 'number') a = a.min(node.minItems);
      if (typeof node.maxItems === 'number') a = a.max(node.maxItems);
      schema = a;
      break;
    }
    case 'object': {
      const properties = (node.properties as Record<string, JsonSchema> | undefined) ?? {};
      const required = new Set((node.required as string[] | undefined) ?? []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, value] of Object.entries(properties)) {
        const child = jsonSchemaToZod(value, depth + 1);
        shape[key] = required.has(key) ? child : child.optional();
      }
      let o: ZodTypeAny = z.object(shape);
      const additional = node.additionalProperties;
      if (additional === false) {
        o = (o as z.ZodObject<Record<string, ZodTypeAny>>).strict();
      } else if (additional && typeof additional === 'object') {
        o = (o as z.ZodObject<Record<string, ZodTypeAny>>).catchall(
          jsonSchemaToZod(additional as JsonSchema, depth + 1)
        );
      } else {
        o = (o as z.ZodObject<Record<string, ZodTypeAny>>).passthrough();
      }
      schema = o;
      break;
    }
    default:
      schema = z.unknown();
  }
  if (node.default !== undefined) schema = schema.default(node.default as never);
  if (nullable) schema = schema.nullable();
  return withDescription(schema, node);
}

/** Stable, order-independent fingerprint of a schema (used to detect remote changes). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
