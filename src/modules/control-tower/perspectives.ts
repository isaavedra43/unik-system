import type { GraphViewer } from './graph-mask';
import { viewerHoldsAny } from './graph-mask';

/**
 * Perspectivas del grafo operativo (plan 7.8c). Módulo PURO.
 *
 * Una perspectiva es un recorte del grafo: qué tipos de nodo y qué relaciones
 * entran, desde qué raíces se empieza y hasta qué profundidad. Sin recorte, el
 * grafo de una empresa es una nube inútil; con perspectivas, cada área ve su
 * historia ("de la venta al embarque", "de la solicitud al pago").
 *
 * Las relaciones son EXACTAMENTE las que escriben los comandos con `ctx.relate`
 * (`relations-rebuild.ts` las reconstruye con los mismos nombres). Añadir una
 * relación nueva al sistema exige nombrarla aquí o no se recorrerá.
 */

export const MAX_GRAPH_DEPTH = 3;
export const MAX_GRAPH_NODES = 2000;
export const DEFAULT_PERSPECTIVE_KEY = 'expediente';

export interface GraphPerspective {
  key: string;
  label: string;
  description: string;
  /** Cualquiera de estos permisos abre la perspectiva. */
  permissions: readonly string[];
  /** Tipos de nodo que se muestran (vacío = cualquiera). */
  nodeTypes: readonly string[];
  /** Relaciones que se recorren. */
  relations: readonly string[];
  /** Tipos válidos como raíz. */
  rootTypes: readonly string[];
  defaultDepth: number;
}

/** Etiquetas en español de los tipos de nodo del grafo. */
export const GRAPH_NODE_TYPE_LABELS: Readonly<Record<string, string>> = {
  operational_case: 'Expediente',
  case_demand: 'Necesidad',
  demand_allocation: 'Asignación',
  case_step: 'Paso',
  work_item: 'Trabajo',
  area_request: 'Solicitud',
  incident: 'Incidencia',
  approval_request: 'Aprobación',
  sales_order: 'Orden de venta',
  package: 'Paquete',
  delivery_order: 'Orden de entrega',
  trip: 'Viaje',
  vehicle: 'Vehículo',
  driver: 'Chofer',
  stock_reservation: 'Reserva',
  stock_item: 'Existencia',
  legacy_claim: 'Compromiso previo',
  purchase_request: 'Solicitud de compra',
  purchase_request_line: 'Línea de solicitud',
  rfq: 'Cotización a proveedor',
  procurement_order: 'Orden de compra',
  goods_receipt: 'Recepción',
  supplier: 'Proveedor',
  sourcing_candidate: 'Candidato de sourcing',
  production_order: 'Orden de producción',
  obligation: 'Obligación',
  expense: 'Gasto',
  opportunity: 'Oportunidad',
  comm_conversation: 'Conversación',
  quote: 'Cotización',
  voice_call: 'Llamada',
  zoho_contact: 'Contacto de Zoho',
  user: 'Persona',
};

/** Etiquetas en español de las relaciones (`ObjectRelation.relation`). */
export const GRAPH_RELATION_LABELS: Readonly<Record<string, string>> = {
  fulfills: 'cumple',
  allocates: 'cubre la necesidad',
  requested_via: 'se pidió con',
  has_delivery: 'se entrega con',
  ships_with: 'viaja en',
  covers: 'cubre',
  remainder: 'remanente de',
  includes: 'incluye',
  uses: 'usa',
  driven_by: 'lo maneja',
  reserved_for: 'reservado para',
  claimed_for: 'comprometido para',
  converted_to: 'se convirtió en',
  supplied_by: 'se abastece con',
  ordered_in: 'se ordenó en',
  ordered_from: 'se compró a',
  fulfilled_by: 'lo atiende',
  quoted_in: 'se cotizó en',
  negotiated_in: 'se negoció en',
  awarded_as: 'se adjudicó como',
  receipt_of: 'recibe',
  confirmed_delivery: 'confirmó la entrega',
  payable: 'genera la obligación',
  payment_for_order: 'paga',
  same_as: 'es el mismo que',
  promoted_to: 'se promovió a',
  originated: 'originó',
  quoted: 'cotizó',
  resulted_in: 'terminó en',
  caused_by: 'la causó',
  answers: 'responde',
  for_case: 'del expediente',
};

const CORE_RELATIONS = [
  'fulfills',
  'allocates',
  'requested_via',
  'for_case',
  'answers',
  'caused_by',
] as const;

const LOGISTICS_RELATIONS = [
  'has_delivery',
  'ships_with',
  'covers',
  'remainder',
  'includes',
  'uses',
  'driven_by',
  'confirmed_delivery',
] as const;

const INVENTORY_RELATIONS = ['reserved_for', 'claimed_for', 'converted_to'] as const;

const PURCHASES_RELATIONS = [
  'supplied_by',
  'ordered_in',
  'ordered_from',
  'fulfilled_by',
  'quoted_in',
  'negotiated_in',
  'awarded_as',
  'receipt_of',
  'promoted_to',
  'same_as',
] as const;

const FINANCE_RELATIONS = ['payable', 'payment_for_order'] as const;

const CRM_RELATIONS = ['originated', 'quoted', 'resulted_in'] as const;

const ALL_RELATIONS = [
  ...CORE_RELATIONS,
  ...LOGISTICS_RELATIONS,
  ...INVENTORY_RELATIONS,
  ...PURCHASES_RELATIONS,
  ...FINANCE_RELATIONS,
  ...CRM_RELATIONS,
] as const;

export const GRAPH_PERSPECTIVES: readonly GraphPerspective[] = [
  {
    key: 'expediente',
    label: 'Expediente de punta a punta',
    description:
      'De la orden de venta a la entrega: necesidades, asignaciones, solicitudes, compras, entregas e incidencias.',
    permissions: ['operations.admin', 'operations.view'],
    nodeTypes: [
      'operational_case',
      'sales_order',
      'case_demand',
      'demand_allocation',
      'area_request',
      'work_item',
      'incident',
      'stock_reservation',
      'purchase_request',
      'procurement_order',
      'goods_receipt',
      'production_order',
      'delivery_order',
      'package',
      'trip',
      'supplier',
    ],
    relations: [...ALL_RELATIONS],
    rootTypes: ['operational_case', 'sales_order', 'area_request', 'incident'],
    defaultDepth: 2,
  },
  {
    key: 'ventas',
    label: 'Ventas y clientes',
    description: 'Oportunidades, conversaciones, cotizaciones, órdenes de venta y sus expedientes.',
    permissions: ['operations.admin', 'crm.view', 'crm.manage', 'sales_orders.view'],
    nodeTypes: [
      'opportunity',
      'comm_conversation',
      'quote',
      'voice_call',
      'sales_order',
      'operational_case',
      'delivery_order',
      'incident',
    ],
    relations: [...CRM_RELATIONS, 'fulfills', 'has_delivery', 'for_case'],
    rootTypes: ['opportunity', 'sales_order', 'operational_case', 'comm_conversation'],
    defaultDepth: 2,
  },
  {
    key: 'compras',
    label: 'Abasto y proveedores',
    description: 'Solicitudes de compra, cotizaciones a proveedor, órdenes, recepciones y pagos.',
    permissions: ['operations.admin', 'purchases.view'],
    nodeTypes: [
      'purchase_request',
      'purchase_request_line',
      'rfq',
      'procurement_order',
      'goods_receipt',
      'supplier',
      'sourcing_candidate',
      'obligation',
      'area_request',
      'operational_case',
      'comm_conversation',
    ],
    relations: [...PURCHASES_RELATIONS, ...FINANCE_RELATIONS, ...CORE_RELATIONS],
    rootTypes: ['procurement_order', 'purchase_request', 'supplier', 'rfq', 'operational_case'],
    defaultDepth: 2,
  },
  {
    key: 'inventario',
    label: 'Material comprometido',
    description: 'Reservas, compromisos previos, recepciones y a qué necesidad responde cada uno.',
    permissions: ['operations.admin', 'inventory.view'],
    nodeTypes: [
      'stock_reservation',
      'stock_item',
      'legacy_claim',
      'case_demand',
      'demand_allocation',
      'operational_case',
      'goods_receipt',
      'production_order',
    ],
    relations: [...INVENTORY_RELATIONS, 'allocates', 'fulfills', 'receipt_of', 'for_case'],
    rootTypes: ['stock_reservation', 'case_demand', 'operational_case'],
    defaultDepth: 2,
  },
  {
    key: 'manufactura',
    label: 'Producción',
    description: 'Órdenes de producción, el material que consumen y la venta que sostienen.',
    permissions: ['operations.admin', 'manufacturing.view'],
    nodeTypes: [
      'production_order',
      'case_demand',
      'demand_allocation',
      'operational_case',
      'stock_reservation',
      'area_request',
      'incident',
    ],
    relations: [...CORE_RELATIONS, ...INVENTORY_RELATIONS],
    rootTypes: ['production_order', 'operational_case', 'area_request'],
    defaultDepth: 2,
  },
  {
    key: 'logistica',
    label: 'Despacho y entregas',
    description: 'Entregas, viajes, unidades, choferes y los paquetes de Zoho.',
    permissions: ['operations.admin', 'logistics.view'],
    nodeTypes: [
      'delivery_order',
      'trip',
      'vehicle',
      'driver',
      'package',
      'operational_case',
      'demand_allocation',
      'incident',
    ],
    relations: [...LOGISTICS_RELATIONS, 'for_case', 'fulfills'],
    rootTypes: ['trip', 'delivery_order', 'operational_case', 'vehicle'],
    defaultDepth: 2,
  },
  {
    key: 'contabilidad',
    label: 'Dinero comprometido',
    description: 'Obligaciones, gastos y las órdenes de compra o ventas que los originaron.',
    permissions: ['operations.admin', 'finance.view'],
    nodeTypes: [
      'obligation',
      'expense',
      'procurement_order',
      'supplier',
      'operational_case',
      'sales_order',
      'area_request',
      'approval_request',
    ],
    relations: [...FINANCE_RELATIONS, 'ordered_from', 'supplied_by', 'fulfills', 'for_case'],
    rootTypes: ['obligation', 'expense', 'procurement_order', 'operational_case'],
    defaultDepth: 2,
  },
  {
    key: 'administracion',
    label: 'Todo (administración)',
    description: 'Sin recorte: cualquier tipo de nodo y cualquier relación conocida.',
    permissions: ['operations.admin'],
    nodeTypes: [],
    relations: [...ALL_RELATIONS],
    rootTypes: [],
    defaultDepth: 2,
  },
];

export function getPerspective(key: string | null | undefined): GraphPerspective | null {
  if (!key) return null;
  return GRAPH_PERSPECTIVES.find((perspective) => perspective.key === key) ?? null;
}

export function canUsePerspective(viewer: GraphViewer, perspective: GraphPerspective): boolean {
  return viewerHoldsAny(viewer, perspective.permissions);
}

/** Perspectivas que este visor puede abrir. */
export function listPerspectivesFor(viewer: GraphViewer): GraphPerspective[] {
  return GRAPH_PERSPECTIVES.filter((perspective) => canUsePerspective(viewer, perspective));
}

/** Etiqueta de un tipo de nodo (los desconocidos se muestran tal cual). */
export function nodeTypeLabel(type: string): string {
  return GRAPH_NODE_TYPE_LABELS[type] ?? type;
}

/** Etiqueta de una relación (las desconocidas se muestran tal cual). */
export function relationLabel(relation: string): string {
  return GRAPH_RELATION_LABELS[relation] ?? relation.replace(/_/g, ' ');
}

/** Profundidad válida para una perspectiva (1…3). */
export function clampDepth(
  depth: number | null | undefined,
  perspective: GraphPerspective
): number {
  const value =
    typeof depth === 'number' && Number.isFinite(depth)
      ? Math.round(depth)
      : perspective.defaultDepth;
  return Math.min(Math.max(value, 1), MAX_GRAPH_DEPTH);
}

/** Tope de nodos válido (1…2000). */
export function clampNodeLimit(limit: number | null | undefined): number {
  const value =
    typeof limit === 'number' && Number.isFinite(limit) ? Math.round(limit) : MAX_GRAPH_NODES;
  return Math.min(Math.max(value, 1), MAX_GRAPH_NODES);
}
