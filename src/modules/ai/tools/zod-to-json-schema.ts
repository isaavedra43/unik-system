import {
  ZodArray,
  ZodBoolean,
  ZodDate,
  ZodDefault,
  ZodEnum,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodString,
  ZodType,
  ZodUnion,
} from 'zod';

/**
 * Converts a Zod schema to a JSON Schema object suitable for OpenAI
 * function calling parameters (also compatible with most providers). This is a minimal converter that handles the
 * types we use in tool definitions. For anything unsupported, it falls back
 * to a permissive string schema.
 */
export function zodToJsonSchema(schema: ZodType): Record<string, unknown> {
  if (schema instanceof ZodString) {
    return { type: 'string', description: schema.description };
  }
  if (schema instanceof ZodNumber) {
    return { type: 'number', description: schema.description };
  }
  if (schema instanceof ZodBoolean) {
    return { type: 'boolean', description: schema.description };
  }
  if (schema instanceof ZodEnum) {
    return { type: 'string', enum: schema.options, description: schema.description };
  }
  if (schema instanceof ZodDate) {
    return { type: 'string', format: 'date-time', description: schema.description };
  }
  if (schema instanceof ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema.element), description: schema.description };
  }
  if (schema instanceof ZodOptional) {
    return zodToJsonSchema(schema.unwrap());
  }
  if (schema instanceof ZodDefault) {
    return { ...zodToJsonSchema(schema.removeDefault()), default: schema._def.defaultValue() };
  }
  if (schema instanceof ZodUnion) {
    return {
      anyOf: schema.options.map((o: ZodType) => zodToJsonSchema(o)),
      description: schema.description,
    };
  }
  if (schema instanceof ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as ZodType);
      if (!(value instanceof ZodOptional)) {
        required.push(key);
      }
    }
    return {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
      description: schema.description,
    };
  }
  return { type: 'string' };
}
