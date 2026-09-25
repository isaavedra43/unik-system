/**
 * Lenient argument check against a Composio tool's JSON Schema, run BEFORE the
 * approval card so the model can fix a bad call without wasting an approval:
 * required fields present and top-level types coherent. Composio validates the
 * full schema again on execution, so this never has to be exhaustive (a strict
 * converter would reject valid calls on exotic schemas).
 */

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? (type as string[]) : typeof type === 'string' ? [type] : [];
  if (types.length === 0) return true;
  const actual = typeOf(value);
  return types.some((t) => {
    if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (t === 'number') return typeof value === 'number';
    if (t === 'null') return value === null;
    return t === actual;
  });
}

export function validateComposioArgs(schema: unknown, args: unknown): string[] {
  const errors: string[] = [];
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return ['arguments debe ser un objeto con los parámetros de la herramienta'];
  }
  const s = (schema ?? {}) as Schema;
  const input = args as Record<string, unknown>;
  const properties = (s.properties ?? {}) as Record<string, Schema>;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];

  for (const key of required) {
    if (input[key] === undefined) errors.push(`Falta el parámetro obligatorio "${key}"`);
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = properties[key];
    if (!prop) {
      if (Object.keys(properties).length > 0 && s.additionalProperties === false) {
        errors.push(`El parámetro "${key}" no existe en esta herramienta`);
      }
      continue;
    }
    if (value === null && prop.nullable) continue;
    if (!matchesType(value, prop.type)) {
      errors.push(
        `El parámetro "${key}" debe ser ${JSON.stringify(prop.type)} y recibió ${typeOf(value)}`
      );
      continue;
    }
    if (
      Array.isArray(prop.enum) &&
      typeof value !== 'object' &&
      !(prop.enum as unknown[]).includes(value)
    ) {
      errors.push(
        `El parámetro "${key}" debe ser uno de: ${(prop.enum as unknown[]).slice(0, 12).join(', ')}`
      );
    }
  }
  return errors.slice(0, 8);
}
