import type { PermissionDefinition } from '@/modules/auth/permissions';

/**
 * Manufacturing permissions (plan 6.2; code-first registry, no migration).
 *
 * - `manufacturing.view`: production orders, floor board, load per shift, work
 *   centers and bills of materials (read only).
 * - `manufacturing.manage_boms`: work centers and bills of materials (create,
 *   edit drafts, activate, retire).
 * - `manufacturing.manage_orders`: create, schedule, reserve materials, prepare,
 *   release and cancel production orders.
 * - `manufacturing.operate`: start, pause and finish operations and record
 *   consumptions, finished goods, leftovers and scrap.
 * - `manufacturing.inspect`: quality checks (a failure orders a rework).
 * - `manufacturing.approve_incidents`: approver of the `production_incident`
 *   business approvals (substitutions outside the BOM, scrap beyond tolerance)
 *   and release with an accepted material balance difference.
 *
 * super_admin bypasses the list, so these keys apply to that role automatically.
 */
export const MANUFACTURING_PERMISSIONS: PermissionDefinition[] = [
  {
    key: 'manufacturing.view',
    group: 'Manufactura',
    label: 'Ver manufactura',
    description:
      'Permite consultar órdenes de producción, el tablero de planta, la carga por turno, los centros de trabajo y las listas de materiales',
  },
  {
    key: 'manufacturing.manage_boms',
    group: 'Manufactura',
    label: 'Gestionar centros y listas de materiales',
    description:
      'Permite crear y editar centros de trabajo y listas de materiales, activarlas y retirarlas',
  },
  {
    key: 'manufacturing.manage_orders',
    group: 'Manufactura',
    label: 'Gestionar órdenes de producción',
    description:
      'Permite crear, programar, reservar materiales, preparar, liberar y cancelar órdenes de producción',
  },
  {
    key: 'manufacturing.operate',
    group: 'Manufactura',
    label: 'Operar producción',
    description:
      'Permite iniciar, pausar y terminar operaciones y registrar consumos, producto terminado, sobrantes y merma',
  },
  {
    key: 'manufacturing.inspect',
    group: 'Manufactura',
    label: 'Inspeccionar calidad',
    description: 'Permite registrar inspecciones de calidad y ordenar retrabajos cuando fallan',
  },
  {
    key: 'manufacturing.approve_incidents',
    group: 'Manufactura',
    label: 'Aprobar incidencias de producción',
    description:
      'Permite aprobar sustituciones fuera de la lista de materiales y merma fuera de tolerancia, y liberar con diferencias de balance',
  },
];

export const MANUFACTURING_PERMISSION_KEYS: readonly string[] = MANUFACTURING_PERMISSIONS.map(
  (permission) => permission.key
);

/** Approver permission of the `production_incident` scope (registered with approvals-service). */
export const MANUFACTURING_APPROVER_PERMISSION = 'manufacturing.approve_incidents';

/**
 * Action keys an area coordinator bot may hold (`AGENT_AREA_PERMISSION_CANDIDATES.manufactura.act`):
 * never viewing-only, configuration (BOMs), human judgement (quality) or approval keys.
 */
export const MANUFACTURING_AGENT_ACT_PERMISSIONS: readonly string[] = [
  'manufacturing.manage_orders',
  'manufacturing.operate',
];

/** Keys that let a person act for Manufactura (`AREA_ACT_PERMISSION_CANDIDATES.manufactura`). */
export const MANUFACTURING_AREA_ACT_PERMISSIONS: readonly string[] = [
  'manufacturing.manage_orders',
  'manufacturing.operate',
  'manufacturing.inspect',
  'manufacturing.manage_boms',
];
