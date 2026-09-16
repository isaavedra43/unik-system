/**
 * Enmascarado de nodos del grafo operativo (plan 7.9). Módulo PURO.
 *
 * El grafo cruza áreas: un expediente lleva a su orden de compra, a su
 * proveedor, a su obligación y a su cliente. Ver la RELACIÓN no da derecho a
 * ver el DATO SENSIBLE, así que cada campo delicado exige su propio permiso:
 *
 * | campo            | permiso            | por qué |
 * |------------------|--------------------|---------|
 * | importes         | `finance.view`     | precios y saldos son de Contabilidad |
 * | datos de contacto| `customers.view`   | teléfono y correo del cliente/proveedor |
 * | costo de IA      | `operations.admin` | consumo por área y por expediente |
 *
 * `operations.admin` abre la Torre de Control pero NO levanta estas máscaras
 * (sólo `super_admin`, como en `hasPermission`): un administrador de
 * operaciones ve la red completa sin ver los importes de Contabilidad.
 *
 * El nodo enmascarado dice qué se ocultó (`masked`), para que el inspector
 * muestre "Importe oculto (requiere Contabilidad)" en vez de un hueco.
 *
 * `MASK_RULES` es la ÚNICA tabla de estas reglas en el programa: el detalle de
 * una fila del centro de trabajo de las áreas la reusa desde
 * `modules/areas/row-mask.ts` (plan 7.2), para que un importe no esté oculto en
 * el grafo y a la vista en el cajón del mismo objeto.
 */

/** Quien mira el grafo. No se importa `CurrentUser` para que el módulo siga siendo puro. */
export interface GraphViewer {
  permissionKeys: readonly string[];
  isSuperAdmin?: boolean;
}

export interface GraphNodeContact {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface GraphNode {
  /** `<tipo>:<id>`. */
  key: string;
  id: string;
  type: string;
  typeLabel: string;
  label: string;
  sublabel: string | null;
  status: string | null;
  areaKey: string | null;
  /** Instante representativo del nodo (creación, fecha planeada…). */
  at: string | null;
  /** Ruta interna para abrirlo (null si no hay pantalla). */
  href: string | null;
  amount: string | null;
  currency: string | null;
  contact: GraphNodeContact | null;
  aiCostUsd: number | null;
  /** Campos ocultos para quien lo está viendo. */
  masked: string[];
}

export type MaskedField = 'amount' | 'contact' | 'aiCost';

export interface MaskRule {
  field: MaskedField;
  permissions: readonly string[];
  label: string;
}

export const MASK_RULES: readonly MaskRule[] = [
  {
    field: 'amount',
    permissions: ['finance.view'],
    label: 'Importe oculto (requiere Contabilidad)',
  },
  {
    field: 'contact',
    permissions: ['customers.view'],
    label: 'Datos de contacto ocultos (requiere Clientes)',
  },
  {
    field: 'aiCost',
    permissions: ['operations.admin'],
    label: 'Costo de IA oculto (requiere administrar operaciones)',
  },
];

/** ¿El visor tiene alguno de esos permisos? `super_admin` los tiene todos. */
export function viewerHoldsAny(viewer: GraphViewer, permissions: readonly string[]): boolean {
  if (viewer.isSuperAdmin) return true;
  return permissions.some((permission) => viewer.permissionKeys.includes(permission));
}

/** Campos que este visor NO puede ver. */
export function maskedFieldsFor(viewer: GraphViewer): MaskedField[] {
  return MASK_RULES.filter((rule) => !viewerHoldsAny(viewer, rule.permissions)).map(
    (rule) => rule.field
  );
}

/** Copia del nodo sin los campos que el visor no puede ver. */
export function maskNode(node: GraphNode, viewer: GraphViewer): GraphNode {
  const hidden = maskedFieldsFor(viewer);
  if (hidden.length === 0) return { ...node, masked: [] };
  const masked: string[] = [];
  const out: GraphNode = { ...node, masked };
  for (const field of hidden) {
    if (field === 'amount') {
      if (out.amount !== null || out.currency !== null) masked.push('amount');
      out.amount = null;
      out.currency = null;
    } else if (field === 'contact') {
      if (out.contact !== null) masked.push('contact');
      out.contact = null;
    } else if (field === 'aiCost') {
      if (out.aiCostUsd !== null) masked.push('aiCost');
      out.aiCostUsd = null;
    }
  }
  return out;
}

export function maskNodes(nodes: readonly GraphNode[], viewer: GraphViewer): GraphNode[] {
  return nodes.map((node) => maskNode(node, viewer));
}

/** Frase en español para el inspector; null cuando no se ocultó nada. */
export function maskNotice(masked: readonly string[]): string | null {
  if (masked.length === 0) return null;
  const labels = MASK_RULES.filter((rule) => masked.includes(rule.field)).map((rule) => rule.label);
  return labels.length > 0 ? labels.join(' · ') : null;
}
