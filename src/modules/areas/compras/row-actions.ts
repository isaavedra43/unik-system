import {
  ORDER_CANCELLABLE_STATUSES,
  ORDER_CLOSABLE_STATUSES,
  ORDER_PAYABLE_STATUSES,
  ORDER_STATUSES,
} from '@/modules/purchases/orders-state';
import { PURCHASES_PERMISSION } from '@/modules/purchases/permissions';
import {
  PURCHASES_COMMANDS,
  PURCHASES_OBJECT_TYPES,
  PURCHASE_REQUEST_OPEN_STATUSES,
  PURCHASE_REQUEST_STATUSES,
  RECEIPT_STATUSES,
  RFQ_OPEN_STATUSES,
  RFQ_STATUSES,
} from '@/modules/purchases/purchases-types';

/**
 * Acciones de dominio que ofrecen las filas de Compras en el centro de trabajo
 * (plan 7.4). PURO: sin Prisma, sin React, sin E/S.
 *
 * El catálogo lo serializan las ramas SQL (`compras-rows.ts`) dentro de
 * `extra.actions`, así que `work-actions.getRowActions` puede filtrarlo por
 * permiso en el servidor y en el navegador. Ocultar un botón es sólo una
 * cortesía: `executeCommand` vuelve a validar el permiso, la transición y la
 * versión optimista.
 *
 * Cada entrada nombra un comando REAL de Compras y lleva el payload fijo que
 * ese comando exige (`requestId`, `rfqId`, `orderId`, `receiptId`), porque cada
 * manejador comprueba que el agregado corresponda al id de su payload.
 *
 * NO están aquí las acciones que necesitan datos estructurados (capturar una
 * recepción con cantidades aceptadas y rechazadas, elegir una respuesta de RFQ,
 * resolver una diferencia, confirmar una entrega directa): ésas viven en los
 * paneles de gestión de Compras, donde la persona llena un formulario de verdad.
 * El diálogo genérico de la tabla sólo sabe recoger una nota o un motivo.
 */

const ORDER_AGGREGATE = PURCHASES_OBJECT_TYPES.order;
const REQUEST_AGGREGATE = PURCHASES_OBJECT_TYPES.request;
const RFQ_AGGREGATE = PURCHASES_OBJECT_TYPES.rfq;

const REQUEST = [PURCHASES_PERMISSION.request];
const MANAGE_ORDERS = [PURCHASES_PERMISSION.manageOrders];
const MANAGE_OR_SOURCING = [PURCHASES_PERMISSION.manageOrders, PURCHASES_PERMISSION.sourcing];
const RECEIVE = [PURCHASES_PERMISSION.receive];

export interface ComprasBranchAction {
  id: string;
  label: string;
  commandType: string;
  aggregateType: string;
  /** Dato que recoge el diálogo compartido ('reason'/'note' viajan con ese nombre). */
  form: 'none' | 'note' | 'reason';
  tone: 'primary' | 'default' | 'danger';
  confirm: string | null;
  successMessage: string;
  hint: string | null;
  /** Cualquiera de estos permisos ofrece la acción (el comando los revisa otra vez). */
  permissions: string[];
  /** Estados de la propia fila en los que se ofrece. */
  statuses: string[];
  /**
   * Payload fijo adicional al id del registro, que añade la rama SQL. Sólo
   * escalares: `work-actions.branchPayload` descarta cualquier otra cosa.
   */
  payload?: Record<string, string | number | boolean>;
}

/** Solicitudes de compra: cancelar mientras ninguna partida esté en una orden. */
export const PURCHASE_REQUEST_ROW_ACTIONS: readonly ComprasBranchAction[] = [
  {
    id: 'purchase_request.cancel',
    label: 'Cancelar solicitud',
    commandType: PURCHASES_COMMANDS.requestCancel,
    aggregateType: REQUEST_AGGREGATE,
    form: 'reason',
    tone: 'danger',
    confirm: '¿Cancelar la solicitud? El área que la pidió tendrá que replanear.',
    successMessage: 'Solicitud de compra cancelada',
    hint: 'Di por qué ya no se va a comprar: el área que la pidió lo verá en su solicitud.',
    permissions: REQUEST,
    statuses: [...PURCHASE_REQUEST_OPEN_STATUSES],
  },
];

/** Cotizaciones a proveedor. */
export const RFQ_ROW_ACTIONS: readonly ComprasBranchAction[] = [
  {
    id: 'rfq.compare',
    label: 'Comparar respuestas',
    commandType: PURCHASES_COMMANDS.rfqCompare,
    aggregateType: RFQ_AGGREGATE,
    form: 'none',
    tone: 'primary',
    confirm: null,
    successMessage: 'Cotización comparada',
    hint: 'Calcula el costo puesto en bodega y el puntaje de cada respuesta recibida.',
    permissions: MANAGE_OR_SOURCING,
    statuses: ['sent', 'collecting', 'compared'],
  },
  {
    id: 'rfq.cancel',
    label: 'Cancelar cotización',
    commandType: PURCHASES_COMMANDS.rfqCancel,
    aggregateType: RFQ_AGGREGATE,
    form: 'reason',
    tone: 'danger',
    confirm: '¿Cancelar la cotización? Las invitaciones pendientes quedan sin efecto.',
    successMessage: 'Cotización cancelada',
    hint: 'Indica el motivo: las solicitudes que la originaron vuelven a quedar abiertas.',
    permissions: MANAGE_ORDERS,
    statuses: [...RFQ_OPEN_STATUSES],
  },
];

/** Órdenes de compra: firma, pago, cierre y cancelación. */
export const ORDER_ROW_ACTIONS: readonly ComprasBranchAction[] = [
  {
    id: 'procurement_order.submit',
    label: 'Enviar a aprobación',
    commandType: PURCHASES_COMMANDS.orderSubmit,
    aggregateType: ORDER_AGGREGATE,
    form: 'note',
    tone: 'primary',
    confirm: null,
    successMessage: 'Orden enviada a aprobación',
    hint: 'Desde el umbral configurado pide doble firma. Puedes dejar una nota para quien firma.',
    permissions: MANAGE_ORDERS,
    statuses: ['draft'],
  },
  {
    id: 'procurement_order.request_payment',
    label: 'Solicitar el pago',
    commandType: PURCHASES_COMMANDS.orderRequestPayment,
    aggregateType: ORDER_AGGREGATE,
    form: 'none',
    tone: 'primary',
    confirm: null,
    successMessage: 'Pago solicitado a Contabilidad',
    hint: 'Registra la obligación por pagar de la orden en Contabilidad.',
    permissions: MANAGE_ORDERS,
    statuses: [...ORDER_PAYABLE_STATUSES],
  },
  {
    id: 'procurement_order.close',
    label: 'Cerrar orden',
    commandType: PURCHASES_COMMANDS.orderClose,
    aggregateType: ORDER_AGGREGATE,
    form: 'reason',
    tone: 'primary',
    confirm: null,
    successMessage: 'Orden cerrada',
    hint: 'Llegó todo lo que se pidió. Escribe una nota de cierre.',
    permissions: MANAGE_ORDERS,
    statuses: ['received'],
  },
  {
    id: 'procurement_order.close_accepting_shortage',
    label: 'Cerrar aceptando el faltante',
    commandType: PURCHASES_COMMANDS.orderClose,
    aggregateType: ORDER_AGGREGATE,
    form: 'reason',
    tone: 'default',
    confirm: '¿Cerrar la orden aceptando que el proveedor ya no entregará el resto?',
    successMessage: 'Orden cerrada con faltante aceptado',
    hint: 'Explica por qué se da por cerrado el faltante: queda en la cronología de la orden.',
    permissions: MANAGE_ORDERS,
    statuses: ['partially_received', 'disputed'],
    payload: { acceptShortages: true },
  },
  {
    id: 'procurement_order.cancel',
    label: 'Cancelar orden',
    commandType: PURCHASES_COMMANDS.orderCancel,
    aggregateType: ORDER_AGGREGATE,
    form: 'reason',
    tone: 'danger',
    confirm:
      '¿Cancelar la orden? Se liberan sus asignaciones y el expediente tendrá que replanear.',
    successMessage: 'Orden cancelada',
    hint: 'Indica el motivo: queda en la cronología de la orden y del expediente.',
    permissions: MANAGE_ORDERS,
    statuses: [...ORDER_CANCELLABLE_STATUSES],
  },
];

/** Recepciones en bodega: registrar el borrador capturado antes. */
export const GOODS_RECEIPT_ROW_ACTIONS: readonly ComprasBranchAction[] = [
  {
    id: 'goods_receipt.post',
    label: 'Registrar recepción',
    commandType: PURCHASES_COMMANDS.receiptPost,
    aggregateType: ORDER_AGGREGATE,
    form: 'none',
    tone: 'primary',
    confirm: null,
    successMessage: 'Recepción registrada',
    hint: 'Da entrada al material en el almacén y libera lo que esperaban los expedientes.',
    permissions: RECEIVE,
    statuses: ['draft'],
  },
];

/** Catálogo de una clase de fila (vacío para una clase sin acciones de dominio). */
export function comprasRowActions(rowKind: string): readonly ComprasBranchAction[] {
  if (rowKind === 'purchase_request') return PURCHASE_REQUEST_ROW_ACTIONS;
  if (rowKind === 'rfq') return RFQ_ROW_ACTIONS;
  if (rowKind === 'procurement_order') return ORDER_ROW_ACTIONS;
  if (rowKind === 'goods_receipt') return GOODS_RECEIPT_ROW_ACTIONS;
  return [];
}

/**
 * Acciones que una fila en `status` puede ofrecer por su estado. Es el MISMO
 * predicado que aplican las ramas SQL (dentro de Postgres, para que cada fila
 * cargue sólo las suyas); las ramas añaden además la condición de negocio de
 * cada acción (que la orden tenga partidas, que no haya recepciones registradas,
 * que la cotización tenga respuestas…), que esta función no puede conocer.
 */
export function comprasActionsForStatus(rowKind: string, status: string): ComprasBranchAction[] {
  return comprasRowActions(rowKind).filter((action) => action.statuses.includes(status));
}

const STATUSES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  purchase_request: PURCHASE_REQUEST_STATUSES,
  rfq: RFQ_STATUSES,
  procurement_order: ORDER_STATUSES,
  goods_receipt: RECEIPT_STATUSES,
};

/** Estados citados por el catálogo que no son estados reales (debe estar siempre vacío). */
export function unknownComprasActionStatuses(): string[] {
  const out: string[] = [];
  for (const [rowKind, statuses] of Object.entries(STATUSES_BY_KIND)) {
    const known = new Set(statuses);
    for (const action of comprasRowActions(rowKind)) {
      for (const status of action.statuses) {
        if (!known.has(status)) out.push(`${action.id}:${status}`);
      }
    }
  }
  return out;
}

/** Ids de las acciones que el catálogo declara cerrables por estado (para las pruebas). */
export const COMPRAS_ACTION_IDS = [
  ...PURCHASE_REQUEST_ROW_ACTIONS,
  ...RFQ_ROW_ACTIONS,
  ...ORDER_ROW_ACTIONS,
  ...GOODS_RECEIPT_ROW_ACTIONS,
].map((action) => action.id);

/** Estados cerrables, para que la rama SQL de la orden no ofrezca cerrar lo que no se puede. */
export const ORDER_CLOSE_STATUSES: readonly string[] = ORDER_CLOSABLE_STATUSES;
