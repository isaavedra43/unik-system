import { AREA_KEYS, isAreaKey, type AreaKey } from '@/modules/operations/types';

/**
 * Configuration shared by the operations copilot adapters (area, case room,
 * "Mi trabajo" and Control Tower): API endpoints, starters in Spanish and the
 * throttling of automatic analyses. Pure module, safe for client and server.
 *
 * Every starter is something the ONE assistant can do with its tools on that
 * surface (plan 5.2 / 7.4): no starter promises an action it cannot execute.
 */

export const OPERATIONS_COPILOT_ENDPOINTS = {
  area: (areaKey: string) => `/app/operations/api/areas/${encodeURIComponent(areaKey)}/copilot`,
  case: (caseId: string) => `/app/operations/api/cases/${encodeURIComponent(caseId)}/copilot`,
  mywork: '/app/operations/api/mywork/copilot',
  controlTower: '/app/admin/control-tower/api/copilot',
  /** Scope-aware decision route: proposer, area responsible/backup or holder of the scope permission. */
  proposal: (proposalId: string) =>
    `/app/operations/api/proposals/${encodeURIComponent(proposalId)}`,
} as const;

/** Area work tables re-analyze at most once a minute (plan 7.2). */
export const AREA_COPILOT_MIN_AUTO_INTERVAL_MS = 60_000;
/**
 * "Mi trabajo" re-analyzes only when someone else changed the user's work (the anchor ignores the
 * user's own actions), and at most every 5 minutes.
 */
export const MYWORK_COPILOT_MIN_AUTO_INTERVAL_MS = 5 * 60_000;

/**
 * Pages of the next phases. While they do not exist, links to them are not rendered (the case
 * number is shown as text): a primary button never lands on a 404.
 */
export const OPERATIONS_CASE_PAGE_ENABLED = true;
/** Area workspaces exist since the areas phase: `/app/areas/<key>/trabajo` is a real page. */
export const AREA_WORKSPACE_PAGE_ENABLED = true;

/** Link of a case (expediente) page, or null while that page does not exist. */
export function operationsCaseHref(caseId: string | null | undefined): string | null {
  return OPERATIONS_CASE_PAGE_ENABLED && caseId
    ? `/app/operations/cases/${encodeURIComponent(caseId)}`
    : null;
}

/** Link of an area work center, or null while that page does not exist. */
export function areaWorkspaceHref(areaKey: string | null | undefined): string | null {
  return AREA_WORKSPACE_PAGE_ENABLED && areaKey
    ? `/app/areas/${encodeURIComponent(areaKey)}/trabajo`
    : null;
}

/** Case rooms and the Control Tower react to events of many people: a bit slower. */
export const CASE_COPILOT_MIN_AUTO_INTERVAL_MS = 90_000;
export const CONTROL_TOWER_COPILOT_MIN_AUTO_INTERVAL_MS = 120_000;

/** Draft tool of the table surfaces: its result is offered to the host, never sent by itself. */
export const AREA_DRAFT_TOOL = 'proposeAreaAction';

const COMMON_AREA_STARTERS = ['¿Qué está atrasado?', '¿Qué cierro hoy?'] as const;

export const AREA_COPILOT_STARTERS: Readonly<Record<AreaKey, readonly string[]>> = {
  ventas: [
    '¿Qué expedientes están en riesgo de incumplir la fecha prometida?',
    '¿Qué solicitudes que enviamos siguen sin respuesta?',
    'Prepara mensajes de seguimiento para los clientes',
    ...COMMON_AREA_STARTERS,
  ],
  compras: [
    '¿Qué solicitudes de compra están atrasadas?',
    '¿Qué expedientes esperan una compra?',
    '¿Qué proveedor bloquea más entregas?',
    ...COMMON_AREA_STARTERS,
  ],
  inventario: [
    '¿Qué verifico primero?',
    '¿Qué SKU bloquea más expedientes?',
    '¿Qué conteos están vencidos?',
    ...COMMON_AREA_STARTERS,
  ],
  manufactura: [
    '¿Qué órdenes de producción van atrasadas?',
    '¿Qué está detenido por material faltante?',
    ...COMMON_AREA_STARTERS,
  ],
  logistica: [
    '¿Qué entregas de hoy siguen sin transportista?',
    '¿Qué entregas tienen conflicto con Zoho?',
    'Prepara avisos de entrega para los clientes',
    ...COMMON_AREA_STARTERS,
  ],
  contabilidad: [
    '¿Qué pagos vencen esta semana?',
    '¿Qué solicitudes de pago siguen sin autorizar?',
    '¿Qué gastos no tienen comprobante?',
    ...COMMON_AREA_STARTERS,
  ],
  administracion: [
    '¿Qué expedientes están atorados?',
    '¿Qué área tiene más trabajo vencido?',
    '¿Quién está bloqueando entregas?',
    'Resume el día de la operación',
  ],
};

/** Starters of an area; unknown keys fall back to the common questions. */
export function areaCopilotStarters(areaKey: string): string[] {
  return isAreaKey(areaKey) ? [...AREA_COPILOT_STARTERS[areaKey]] : [...COMMON_AREA_STARTERS];
}

export const CASE_ROOM_STARTERS: readonly string[] = [
  '¿Qué detiene este expediente?',
  '¿Quién tiene el siguiente paso?',
  '¿Llegamos a la fecha prometida?',
  'Resume lo que ha pasado',
];

/** Plan 5.7: "¿Qué hago primero?", "Registra un conteo", "¿Qué me falta para cerrar hoy?". */
export const MYWORK_STARTERS: readonly string[] = [
  '¿Qué hago primero?',
  'Registra un conteo',
  '¿Qué me falta para cerrar hoy?',
  '¿Qué tengo vencido?',
];

/** Starter that needs `inventory.count` (recordCount). */
export const MYWORK_COUNT_STARTER = 'Registra un conteo';

/** Starters of "Mi trabajo" the person can actually use: counting only with `inventory.count`. */
export function myWorkStarters(options: { canCount: boolean }): string[] {
  return MYWORK_STARTERS.map((starter) =>
    starter === MYWORK_COUNT_STARTER && !options.canCount ? '¿Qué puedo cerrar hoy mismo?' : starter
  );
}

export const CONTROL_TOWER_STARTERS: readonly string[] = [
  '¿Qué expedientes están atorados?',
  '¿Quién está bloqueando más entregas?',
  '¿Qué pasa si Compras se retrasa dos días?',
  '¿Cómo va el pulso de la empresa hoy?',
];

/** Areas in display order (same as the core). */
export const OPERATIONS_AREA_ORDER: readonly AreaKey[] = AREA_KEYS;
