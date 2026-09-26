import type { z } from 'zod';
import {
  GENUI_ACTIONS,
  GENUI_COMPONENTS,
  GENUI_ICONS,
  GENUI_TONES,
  type GenUiComponentDef,
} from './catalog';

/**
 * Compact catalog reference for the model (tool description of renderUi).
 * Written here instead of json-render's `catalog.prompt()`: its default rules
 * ask for "realistic sample data", which UNIK forbids — every value in a card
 * must come from a tool result of the turn.
 */

interface ZodDefLike {
  typeName?: string;
  innerType?: z.ZodTypeAny;
  values?: readonly string[];
  type?: z.ZodTypeAny;
  options?: z.ZodTypeAny[];
  shape?: () => Record<string, z.ZodTypeAny>;
}

function typeOf(schema: z.ZodTypeAny, depth = 0): string {
  const def = (schema as unknown as { _def: ZodDefLike })._def;
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return def.innerType ? typeOf(def.innerType, depth) : 'any';
    case 'ZodString':
      return 'string';
    case 'ZodNumber':
      return 'number';
    case 'ZodBoolean':
      return 'boolean';
    case 'ZodEnum': {
      const values = def.values ?? [];
      if (values.length === GENUI_ICONS.length && values[0] === GENUI_ICONS[0]) return 'ícono';
      if (values.length === GENUI_TONES.length && values[0] === GENUI_TONES[0]) return 'tono';
      return values.map((v) => `"${v}"`).join('|');
    }
    case 'ZodUnion':
      return (def.options ?? []).map((o) => typeOf(o, depth)).join('|');
    case 'ZodArray':
      return def.type ? `${typeOf(def.type, depth + 1)}[]` : 'any[]';
    case 'ZodRecord':
      return 'objeto';
    case 'ZodObject': {
      if (depth > 1) return '{…}';
      const shape = def.shape?.() ?? {};
      return `{${Object.entries(shape)
        .map(([k, v]) => `${k}${isOpt(v) ? '?' : ''}:${typeOf(v, depth + 1)}`)
        .join(', ')}}`;
    }
    default:
      return 'any';
  }
}

function isOpt(schema: z.ZodTypeAny): boolean {
  return schema.safeParse(undefined).success;
}

function describeComponent(name: string, def: GenUiComponentDef): string {
  const shape = def.props.shape as Record<string, z.ZodTypeAny>;
  const props = Object.entries(shape)
    .map(([k, v]) => `${k}${isOpt(v) ? '?' : ''}: ${typeOf(v)}`)
    .join('; ');
  const extras = [
    def.slots.includes('default') ? 'con hijos' : null,
    def.events?.length ? `eventos: ${def.events.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `- ${name}(${props})${extras ? ` [${extras}]` : ''} — ${def.description}`;
}

export function describeGenUiCatalog(): string {
  const components = Object.entries(GENUI_COMPONENTS as Record<string, GenUiComponentDef>)
    .map(([name, def]) => describeComponent(name, def))
    .join('\n');
  const actions = Object.entries(GENUI_ACTIONS)
    .map(([name, def]) => {
      const shape = def.params.shape as Record<string, z.ZodTypeAny>;
      return `- ${name}(${Object.entries(shape)
        .map(([k, v]) => `${k}: ${typeOf(v)}`)
        .join(', ')}) — ${def.description}`;
    })
    .join('\n');
  return [
    'FORMATO (json-render, plano): {"root":"id","elements":{"id":{"type":"Card","props":{…},"children":["id2"],"on":{"press":{"action":"ask","params":{"text":"…"}}},"visible":{"$state":"/tab","eq":"a"}}},"state":{…}}',
    'REGLAS: solo componentes y acciones de esta lista · cada hijo referenciado debe existir · datos SOLO de resultados reales de tus herramientas de este turno (nunca datos de ejemplo) · pon los datos en "state" y enlázalos con {"$state":"/ruta"} · los controles usan {"$bindState":"/ruta"} · para repetir usa "repeat":{"statePath":"/items","key":"id"} con {"$item":"campo"} en el hijo · acciones de estado: setState/pushState/removeState {statePath, value} · nada de HTML, estilos ni código.',
    `TONOS: ${GENUI_TONES.join('|')} · ÍCONOS: ${GENUI_ICONS.join(', ')}`,
    'COMPONENTES:',
    components,
    'ACCIONES:',
    actions,
  ].join('\n');
}
