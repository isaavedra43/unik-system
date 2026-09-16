import {
  MASK_RULES,
  viewerHoldsAny,
  type GraphViewer,
  type MaskedField,
} from '@/modules/control-tower/graph-mask';
import type { AreaRowField, AreaRowFieldSensitivity } from './area-work-row';

/**
 * Enmascarado de los campos del detalle de una fila del centro de trabajo
 * (plan 7.2: «gate en layout + `assertPermission` en cada acción + enmascarado
 * de campos en el detalle»). Módulo PURO.
 *
 * NO hay una segunda tabla de permisos: se aplica la MISMA que la Torre de
 * Control (`control-tower/graph-mask.MASK_RULES`), para que el importe de una
 * entrega no esté oculto en el grafo y a la vista en el cajón de la misma
 * entrega. Hoy: `amount` → `finance.view`, `contact` → `customers.view`
 * (`aiCost` no aparece en una fila, así que no se usa aquí).
 *
 * QUÉ SE ENMASCARA Y QUÉ NO, con el mismo criterio que el grafo: se oculta el
 * DATO (el importe, el teléfono, el correo, la dirección del contacto) y NUNCA
 * el nombre que identifica la fila — `maskNode` borra el objeto `contact` del
 * nodo pero deja su `label`/`sublabel`, que es el nombre del cliente o del
 * proveedor. Sin esa distinción el centro de trabajo del área sería ilegible:
 * su propia tabla ya muestra la columna «Cliente».
 *
 * El campo oculto no desaparece: se sustituye por la frase de la regla
 * («Importe oculto (requiere Contabilidad)»), para que nadie crea que el dato
 * no existe.
 */

/** Regla de cada clase sensible, tomada de la tabla de la Torre. */
function ruleFor(sensitive: AreaRowFieldSensitivity) {
  return MASK_RULES.find((rule) => rule.field === (sensitive as MaskedField)) ?? null;
}

/** Clases sensibles que este visor NO puede ver. */
export function maskedRowFieldKinds(viewer: GraphViewer): AreaRowFieldSensitivity[] {
  const kinds: AreaRowFieldSensitivity[] = ['amount', 'contact'];
  return kinds.filter((kind) => {
    const rule = ruleFor(kind);
    return rule ? !viewerHoldsAny(viewer, rule.permissions) : false;
  });
}

/**
 * Copia de los campos sin los datos que el visor no puede ver. Los campos sin
 * marca (la mayoría: folios, estados, fechas, responsables) pasan intactos.
 */
export function maskRowFields(
  fields: readonly AreaRowField[],
  viewer: GraphViewer
): AreaRowField[] {
  const hidden = new Set(maskedRowFieldKinds(viewer));
  if (hidden.size === 0) return fields.map((entry) => ({ ...entry }));
  return fields.map((entry) => {
    if (!entry.sensitive || !hidden.has(entry.sensitive)) return { ...entry };
    const rule = ruleFor(entry.sensitive);
    return {
      label: entry.label,
      value: rule ? rule.label : 'Oculto',
      hint: null,
      sensitive: entry.sensitive,
    };
  });
}

/** True cuando el detalle ocultó algo (para decirlo una vez en la cabecera). */
export function rowFieldsWereMasked(
  original: readonly AreaRowField[],
  viewer: GraphViewer
): boolean {
  const hidden = new Set(maskedRowFieldKinds(viewer));
  return original.some((entry) => entry.sensitive !== undefined && hidden.has(entry.sensitive));
}
