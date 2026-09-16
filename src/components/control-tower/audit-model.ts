/**
 * Vocabulary and filter state of the operations audit (plan 7.7 `auditoría`).
 * PURE: no Prisma, no React.
 *
 * ESTA ES LA ÚNICA LISTA. La ruta `api/audit` la importa de aquí y la primera
 * carga del servidor (`[view]/_data.ts`) también, porque antes había DOS: la
 * ruta tenía su propia copia sin `integration_config`, así que elegir
 * «Configuración de integración» en el selector mandaba un tipo que la ruta
 * descartaba, la lista de tipos quedaba vacía y el `else` devolvía TODO lo
 * demás — es decir, el filtro devolvía justo lo contrario de lo que se pidió.
 *
 * QUÉ ENTRA AQUÍ: los objetos sobre los que la gente ACTÚA en la operación.
 * `executeCommand` escribe una fila de auditoría por comando con
 * `targetType: cmd.aggregate.type`, así que cada agregado de dominio que una
 * acción de fila o una pantalla puede mandar tiene que estar en esta lista o su
 * decisión no se puede leer desde ninguna parte de la aplicación (la Torre es
 * la única pantalla que lee `AuditLog` de operaciones).
 *
 * QUÉ NO ENTRA: lo que no es operación (usuarios, roles, chat, extensiones,
 * campañas…), que se audita igual pero se consulta en su propia administración.
 */

/** Motor de operaciones: expedientes, pasos, trabajo, solicitudes, decisiones. */
export const AUDIT_CORE_TARGET_TYPES = [
  'operational_case',
  'case_step',
  'work_item',
  'area_request',
  'incident',
  'approval_request',
  'ai_proposal',
  'agent_identity',
] as const;

/**
 * Agregados de dominio: lo que viaja en `aggregate.type` cuando alguien manda
 * un comando desde una fila del centro de trabajo o desde una pantalla de área.
 */
export const AUDIT_DOMAIN_TARGET_TYPES = [
  // Ventas
  'opportunity',
  'sales_order_write_request',
  // Compras
  'purchase_request',
  'rfq',
  'rfq_invitation',
  'procurement_order',
  'goods_receipt',
  'supplier',
  'sourcing_search',
  // Inventario
  'stock_count',
  'stock_count_line',
  'stock_reservation',
  'warehouse',
  'legacy_claim',
  // Manufactura
  'production_order',
  'production_operation',
  'work_center',
  'production_order_scrap',
  'material_consumption',
  // Logística
  'delivery_order',
  'trip',
  'vehicle',
  'driver',
  'delivery_evidence',
  // Contabilidad
  'expense',
  'expense_template',
  'obligation',
  'customer_payment',
  'period_close',
] as const;

/** Configuración y pantallas de administración de la propia operación. */
export const AUDIT_ADMIN_TARGET_TYPES = ['control_tower', 'integration_config', 'area'] as const;

export const AUDIT_TARGET_TYPES = [
  ...AUDIT_CORE_TARGET_TYPES,
  ...AUDIT_DOMAIN_TARGET_TYPES,
  ...AUDIT_ADMIN_TARGET_TYPES,
] as const;

export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/** Grupos del selector, en el orden en que se ofrecen. */
export const AUDIT_TARGET_GROUPS: ReadonlyArray<{
  label: string;
  types: readonly string[];
}> = [
  { label: 'Operación', types: AUDIT_CORE_TARGET_TYPES },
  { label: 'Objetos de las áreas', types: AUDIT_DOMAIN_TARGET_TYPES },
  { label: 'Administración', types: AUDIT_ADMIN_TARGET_TYPES },
];

export const AUDIT_TARGET_LABELS: Record<string, string> = {
  operational_case: 'Expediente',
  case_step: 'Paso del expediente',
  work_item: 'Trabajo',
  area_request: 'Solicitud entre áreas',
  incident: 'Incidencia',
  approval_request: 'Aprobación',
  ai_proposal: 'Propuesta de IA',
  agent_identity: 'Identidad de IA',
  opportunity: 'Oportunidad',
  sales_order_write_request: 'Escritura de orden de venta',
  purchase_request: 'Solicitud de compra',
  rfq: 'Solicitud de cotización',
  rfq_invitation: 'Invitación a cotizar',
  procurement_order: 'Orden de compra',
  goods_receipt: 'Recepción de material',
  supplier: 'Proveedor',
  sourcing_search: 'Búsqueda de proveedores',
  stock_count: 'Conteo de inventario',
  stock_count_line: 'Renglón del conteo',
  stock_reservation: 'Reserva de inventario',
  warehouse: 'Almacén',
  legacy_claim: 'Reclamo de existencias heredadas',
  production_order: 'Orden de producción',
  production_operation: 'Operación de producción',
  work_center: 'Centro de trabajo',
  production_order_scrap: 'Merma de producción',
  material_consumption: 'Consumo de material',
  delivery_order: 'Orden de entrega',
  trip: 'Viaje',
  vehicle: 'Unidad',
  driver: 'Chofer',
  delivery_evidence: 'Evidencia de entrega',
  expense: 'Gasto',
  expense_template: 'Plantilla de gasto',
  obligation: 'Obligación',
  customer_payment: 'Pago de cliente',
  period_close: 'Cierre de periodo',
  control_tower: 'Torre de Control',
  integration_config: 'Configuración de integración',
  area: 'Área',
};

export function auditTargetLabel(targetType: string): string {
  return AUDIT_TARGET_LABELS[targetType] ?? targetType;
}

/**
 * `sales_orders.view_created` → "Sales orders · view created". Actions are
 * `<módulo>.<hecho>` in snake case; this only makes them readable, it never
 * translates a fact it does not know.
 */
export function humanizeAuditAction(action: string): string {
  const [head, ...rest] = action.split('.');
  const tail = rest.join('.').replace(/[._]/g, ' ').trim();
  const moduleName = head.replace(/[_-]/g, ' ');
  const capitalized = moduleName.charAt(0).toUpperCase() + moduleName.slice(1);
  return tail ? `${capitalized} · ${tail}` : capitalized;
}

export interface AuditFilterState {
  action: string;
  targetType: string;
  targetId: string;
  actorUserId: string;
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterState = {
  action: '',
  targetType: '',
  targetId: '',
  actorUserId: '',
  from: '',
  to: '',
};

export function auditFiltersFromParams(
  params: Record<string, string | undefined>
): AuditFilterState {
  return {
    action: (params.accion ?? '').slice(0, 80),
    targetType: (params.objeto ?? '').slice(0, 60),
    targetId: (params.objetoId ?? '').slice(0, 120),
    actorUserId: (params.persona ?? '').slice(0, 120),
    from: (params.desde ?? '').slice(0, 10),
    to: (params.hasta ?? '').slice(0, 10),
  };
}

/** Query string for `GET /app/admin/control-tower/api/audit`. */
export function auditQueryString(
  filters: AuditFilterState,
  page: number,
  pageSize: number
): string {
  const params = new URLSearchParams();
  if (filters.action.trim()) params.set('action', filters.action.trim());
  if (filters.targetType) params.set('targetType', filters.targetType);
  if (filters.targetId.trim()) params.set('targetId', filters.targetId.trim());
  if (filters.actorUserId.trim()) params.set('actorUserId', filters.actorUserId.trim());
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  params.set('page', String(Math.max(1, page)));
  params.set('page_size', String(pageSize));
  return params.toString();
}

export function hasAuditFilters(filters: AuditFilterState): boolean {
  return Object.values(filters).some((value) => value.trim().length > 0);
}

/** One-line summary of an audit entry's metadata, without dumping raw JSON. */
export function summarizeAuditMetadata(metadata: unknown, max = 160): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const entries = Object.entries(metadata as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .slice(0, 6)
    .map(([key, value]) => {
      const text = Array.isArray(value)
        ? value.slice(0, 5).map(String).join(', ')
        : typeof value === 'object'
          ? '…'
          : String(value);
      return `${key}: ${text.slice(0, 60)}`;
    });
  if (entries.length === 0) return null;
  const line = entries.join(' · ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
