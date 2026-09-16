import {
  MANUFACTURING_COMMANDS,
  MANUFACTURING_OBJECT_TYPES,
  OPERATION_STATUSES,
  PRODUCTION_ORDER_STATUSES,
} from '@/modules/manufacturing/manufacturing-types';

/**
 * Actions the Manufactura work rows offer (plan 7.4). PURE: no Prisma, no React.
 *
 * The catalogue is serialized into `extra.actions` by the SQL branches
 * (`work-rows.ts`), so `work-actions.getRowActions` can filter it by status and
 * permission on both the server and the browser. Hiding a button is only a
 * courtesy: `executeCommand` validates the permission, the transition and the
 * optimistic version again.
 *
 * Every entry names a REAL manufacturing command and carries the payload those
 * commands require (`productionOrderId`, and `operationId` for the floor ones),
 * because each handler asserts that the aggregate matches its payload id.
 * Actions that need structured input (schedule, consumption, outputs, quality)
 * are NOT here: they live in the production board and the order workspace,
 * where the person fills a real form.
 */

export interface ManufacturaBranchAction {
  id: string;
  label: string;
  commandType: string;
  aggregateType: string;
  /** Input the shared dialog collects before sending ('reason'/'note' map to the command field). */
  form: 'none' | 'note' | 'reason';
  tone: 'primary' | 'default' | 'danger';
  confirm: string | null;
  successMessage: string;
  hint: string | null;
  /** Any of these permissions offers the action (the command checks them again). */
  permissions: string[];
  /** Statuses of the row itself in which the action is offered. */
  statuses: string[];
  /** Statuses the parent production order must be in (operation rows only). */
  orderStatuses?: string[];
}

const ORDER_AGGREGATE = MANUFACTURING_OBJECT_TYPES.productionOrder;

const MANAGE = ['manufacturing.manage_orders'];
const OPERATE = ['manufacturing.operate'];

/** Actions of a `production_order` row, by order status. */
export const ORDER_ROW_ACTIONS: readonly ManufacturaBranchAction[] = [
  {
    id: 'production_order.reserve_materials',
    label: 'Reservar materiales',
    commandType: MANUFACTURING_COMMANDS.orderReserveMaterials,
    aggregateType: ORDER_AGGREGATE,
    form: 'none',
    tone: 'primary',
    confirm: null,
    successMessage: 'Materiales reservados',
    hint: 'Aparta el material de la orden; si falta, se abre la solicitud a Compras.',
    permissions: MANAGE,
    statuses: ['draft', 'blocked', 'reserved'],
  },
  {
    id: 'production_order.prepare',
    label: 'Preparar material',
    commandType: MANUFACTURING_COMMANDS.orderPrepare,
    aggregateType: ORDER_AGGREGATE,
    form: 'none',
    tone: 'primary',
    confirm: null,
    successMessage: 'Orden preparada',
    hint: 'Pide a Inventario surtir el material al centro de trabajo.',
    permissions: [...MANAGE, 'inventory.manage'],
    statuses: ['reserved'],
  },
  {
    id: 'production_order.request_scrap_review',
    label: 'Solicitar revisión de merma',
    commandType: MANUFACTURING_COMMANDS.scrapReview,
    aggregateType: ORDER_AGGREGATE,
    form: 'reason',
    tone: 'default',
    confirm: null,
    successMessage: 'Revisión de merma solicitada',
    hint: 'Explica por qué la merma salió fuera de tolerancia; alguien con permiso la aprueba.',
    permissions: [...OPERATE, ...MANAGE],
    statuses: ['in_progress', 'inspection', 'completed'],
  },
  {
    id: 'production_order.release',
    label: 'Liberar',
    commandType: MANUFACTURING_COMMANDS.release,
    aggregateType: ORDER_AGGREGATE,
    form: 'note',
    tone: 'primary',
    confirm: null,
    successMessage: 'Orden liberada',
    hint: 'Entrega el producto terminado a Inventario o a Logística. Puedes dejar una nota.',
    permissions: MANAGE,
    statuses: ['completed'],
  },
  {
    id: 'production_order.cancel',
    label: 'Cancelar orden',
    commandType: MANUFACTURING_COMMANDS.cancel,
    aggregateType: ORDER_AGGREGATE,
    form: 'reason',
    tone: 'danger',
    confirm:
      '¿Cancelar la orden? Se libera el material reservado y el expediente tendrá que replanear.',
    successMessage: 'Orden cancelada',
    hint: 'Indica el motivo: queda en la cronología del expediente.',
    permissions: MANAGE,
    statuses: [
      'draft',
      'reserved',
      'prepared',
      'blocked',
      'in_progress',
      'inspection',
      'completed',
    ],
  },
];

/** Actions of a `production_operation` row, by operation status and order status. */
export const OPERATION_ROW_ACTIONS: readonly ManufacturaBranchAction[] = [
  {
    id: 'production_operation.start',
    label: 'Iniciar operación',
    commandType: MANUFACTURING_COMMANDS.operationStart,
    aggregateType: ORDER_AGGREGATE,
    form: 'none',
    tone: 'primary',
    confirm: null,
    successMessage: 'Operación iniciada',
    hint: 'Empieza a contar los minutos reales de la operación.',
    permissions: OPERATE,
    statuses: ['pending', 'paused'],
    orderStatuses: ['prepared', 'in_progress'],
  },
  {
    id: 'production_operation.pause',
    label: 'Pausar operación',
    commandType: MANUFACTURING_COMMANDS.operationPause,
    aggregateType: ORDER_AGGREGATE,
    form: 'reason',
    tone: 'default',
    confirm: null,
    successMessage: 'Operación en pausa',
    hint: 'Di por qué se detiene: queda registrado en la orden.',
    permissions: OPERATE,
    statuses: ['running'],
    orderStatuses: ['in_progress'],
  },
  {
    id: 'production_operation.finish',
    label: 'Terminar operación',
    commandType: MANUFACTURING_COMMANDS.operationFinish,
    aggregateType: ORDER_AGGREGATE,
    form: 'note',
    tone: 'primary',
    confirm: null,
    successMessage: 'Operación terminada',
    hint: 'Puedes dejar una nota de lo que pasó en el centro de trabajo.',
    permissions: OPERATE,
    statuses: ['running', 'paused'],
    orderStatuses: ['in_progress'],
  },
];

/** Catalogue of a row kind (empty for a kind without domain actions). */
export function manufacturaRowActions(rowKind: string): readonly ManufacturaBranchAction[] {
  if (rowKind === 'production_order') return ORDER_ROW_ACTIONS;
  if (rowKind === 'production_operation') return OPERATION_ROW_ACTIONS;
  return [];
}

/**
 * Actions a row in `status` may offer. This is the SAME predicate the SQL
 * branches apply per row (`work-rows.ts` runs it inside Postgres so each row
 * only carries its own); the order workspace reuses it to decide which buttons
 * to render. `work-actions.getRowActions` then filters by permission — it never
 * re-checks the status of a domain row.
 */
export function actionsForStatus(
  rowKind: string,
  status: string,
  orderStatus?: string
): ManufacturaBranchAction[] {
  return manufacturaRowActions(rowKind).filter((action) => {
    if (!action.statuses.includes(status)) return false;
    if (!action.orderStatuses) return true;
    return orderStatus !== undefined && action.orderStatuses.includes(orderStatus);
  });
}

/** Statuses referenced by the catalogue that are not real states (must always be empty). */
export function unknownActionStatuses(): string[] {
  const orderStatuses = new Set<string>(PRODUCTION_ORDER_STATUSES);
  const operationStatuses = new Set<string>(OPERATION_STATUSES);
  const out: string[] = [];
  for (const action of ORDER_ROW_ACTIONS) {
    for (const status of action.statuses) {
      if (!orderStatuses.has(status)) out.push(`${action.id}:${status}`);
    }
  }
  for (const action of OPERATION_ROW_ACTIONS) {
    for (const status of action.statuses) {
      if (!operationStatuses.has(status)) out.push(`${action.id}:${status}`);
    }
    for (const status of action.orderStatuses ?? []) {
      if (!orderStatuses.has(status)) out.push(`${action.id}:order:${status}`);
    }
  }
  return out;
}
