import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { CtExceptionRow } from '@/modules/control-tower/exceptions-service';

/**
 * Actions offered on an exception row (plan 7.7 `excepciones`: reasignar,
 * escalar, cerrar). PURE: no Prisma, no React, no fetch.
 *
 * Every action maps to a command that ALREADY exists in the core, with the
 * aggregate the engine expects. The engine checks the same rules again, so this
 * list only decides what to OFFER: a button that the engine would reject is
 * never rendered.
 *
 * Who may act (mirrors `assertCanActOnWorkItem`, `assertCanHandleIncident` and
 * `assertHumanDecider`): whoever operates the core — `operations.manage` or
 * `operations.admin`, the key the plan gates this whole surface with (7.7) —
 * or the person the row belongs to (owner / backup of a work item, owner of an
 * incident).
 *
 * `operations.admin` used to see every exception and be able to touch none,
 * which made the space a read-only list contradicting its own spec. The single
 * definition of that rule lives in `@/modules/operations/permissions`, and the
 * engine reads the same constant, so this list still only OFFERS what the
 * engine would accept.
 */

export {
  OPERATIONS_MANAGE_PERMISSION,
  OPERATIONS_ADMIN_PERMISSION,
  OPERATIONS_OPERATOR_PERMISSIONS,
} from '@/modules/operations/permissions';
import { OPERATIONS_OPERATOR_PERMISSIONS as OPERATOR_PERMISSIONS } from '@/modules/operations/permissions';

/** Shape of the person acting, without dragging `CurrentUser` into the bundle. */
export interface ExceptionActor {
  id: string;
  permissionKeys: readonly string[];
  isSuperAdmin: boolean;
}

export type ExceptionActionForm = 'none' | 'note' | 'reason' | 'answer' | 'assignee';

export interface CtExceptionAction {
  id: string;
  label: string;
  commandType: string;
  aggregateType: string;
  form: ExceptionActionForm;
  /** The text field is mandatory for the engine. */
  required: boolean;
  tone?: 'default' | 'danger';
  successMessage: string;
  hint?: string;
  confirm?: string;
  /** Fixed payload the command needs besides what the person types. */
  payload?: Record<string, unknown>;
}

export const NOTE_MAX = 2000;
export const REASON_MAX = 2000;
export const ANSWER_MAX = 4000;

export const ACTION_FIELD_LABELS: Record<ExceptionActionForm, string> = {
  none: '',
  note: 'Nota',
  reason: 'Motivo',
  answer: 'Respuesta',
  assignee: 'Nuevo responsable',
};

export function actionFieldMax(form: ExceptionActionForm): number {
  if (form === 'answer') return ANSWER_MAX;
  if (form === 'reason') return REASON_MAX;
  return NOTE_MAX;
}

function holdsAny(actor: ExceptionActor, permissionKeys: readonly string[]): boolean {
  return actor.isSuperAdmin || permissionKeys.some((key) => actor.permissionKeys.includes(key));
}

function extraString(row: CtExceptionRow, key: string): string | null {
  const value = row.extra[key];
  return typeof value === 'string' && value ? value : null;
}

/** True when the engine would let this person act on this row. */
export function canActOnException(row: CtExceptionRow, actor: ExceptionActor): boolean {
  if (holdsAny(actor, OPERATOR_PERMISSIONS)) return true;
  if (row.objectType === 'work_item') {
    return row.ownerUserId === actor.id || extraString(row, 'backupUserId') === actor.id;
  }
  if (row.objectType === 'incident') return row.ownerUserId === actor.id;
  // Area requests need the area responsible, which this row does not carry:
  // only whoever operates the core is offered the buttons here (the area
  // answers from its own work centre or from "Mi trabajo").
  return false;
}

const WORK_ITEM_ACTIONS: CtExceptionAction[] = [
  {
    id: 'reassign',
    label: 'Reasignar',
    commandType: 'workitem.reassign',
    aggregateType: 'work_item',
    form: 'assignee',
    required: true,
    successMessage: 'Trabajo reasignado',
    hint: 'La persona recibe el trabajo con su vencimiento actual y se le avisa.',
  },
  {
    id: 'escalate',
    label: 'Escalar',
    commandType: 'workitem.escalate',
    aggregateType: 'work_item',
    form: 'note',
    required: false,
    successMessage: 'Trabajo escalado',
    payload: { reason: 'manual' },
    hint: 'Sube un peldaño de la escalera configurada (suplente → líder → Administración).',
  },
  {
    id: 'complete',
    label: 'Cerrar',
    commandType: 'workitem.complete',
    aggregateType: 'work_item',
    form: 'note',
    required: false,
    successMessage: 'Trabajo cerrado',
    confirm: 'Cerrar el trabajo avanza el expediente. Hazlo sólo si ya está hecho.',
  },
];

const INCIDENT_OPEN_ACTION: CtExceptionAction = {
  id: 'acknowledge',
  label: 'Atender',
  commandType: 'incident.acknowledge',
  aggregateType: 'incident',
  form: 'note',
  required: false,
  successMessage: 'Incidencia en atención',
};

const INCIDENT_ACTIONS: CtExceptionAction[] = [
  {
    id: 'resolve',
    label: 'Resolver',
    commandType: 'incident.resolve',
    aggregateType: 'incident',
    form: 'reason',
    required: true,
    successMessage: 'Incidencia resuelta',
    hint: 'Describe cómo se resolvió: queda en el expediente.',
  },
  {
    id: 'dismiss',
    label: 'Descartar',
    commandType: 'incident.dismiss',
    aggregateType: 'incident',
    form: 'reason',
    required: true,
    tone: 'danger',
    successMessage: 'Incidencia descartada',
    confirm: 'Descartar cierra la incidencia sin resolverla y cancela sus seguimientos.',
  },
];

const REQUEST_ACK_ACTION: CtExceptionAction = {
  id: 'acknowledge',
  label: 'Acusar recibo',
  commandType: 'request.acknowledge',
  aggregateType: 'area_request',
  form: 'none',
  required: false,
  successMessage: 'Solicitud acusada',
};

const REQUEST_ACTIONS: CtExceptionAction[] = [
  {
    id: 'resolve',
    label: 'Responder',
    commandType: 'request.resolve',
    aggregateType: 'area_request',
    form: 'answer',
    required: true,
    successMessage: 'Solicitud respondida',
    hint: 'La respuesta llega al área que la pidió y cierra su espera.',
  },
  {
    id: 'reject',
    label: 'Rechazar',
    commandType: 'request.reject',
    aggregateType: 'area_request',
    form: 'reason',
    required: true,
    tone: 'danger',
    successMessage: 'Solicitud rechazada',
    confirm: 'Rechazar deja al área que la pidió sin lo que necesitaba.',
  },
];

/**
 * Actions of a row, already filtered by state and by what this person may do.
 * An exception with no command behind it (entregas en conflicto, expedientes
 * bloqueados o sin movimiento) returns an empty list on purpose: se atiende en
 * su propia superficie, no aquí.
 */
export function exceptionActions(row: CtExceptionRow, actor: ExceptionActor): CtExceptionAction[] {
  if (!canActOnException(row, actor)) return [];
  switch (row.objectType) {
    case 'work_item':
      return WORK_ITEM_ACTIONS;
    case 'incident':
      return row.status === 'open' ? [INCIDENT_OPEN_ACTION, ...INCIDENT_ACTIONS] : INCIDENT_ACTIONS;
    case 'area_request':
      return row.status === 'sent' ? [REQUEST_ACK_ACTION, ...REQUEST_ACTIONS] : REQUEST_ACTIONS;
    default:
      return [];
  }
}

export function findExceptionAction(
  row: CtExceptionRow,
  actor: ExceptionActor,
  actionId: string
): CtExceptionAction | null {
  return exceptionActions(row, actor).find((action) => action.id === actionId) ?? null;
}

/** Why a row shows no buttons, in Spanish. `null` when it does show them. */
export function noExceptionActionsReason(
  row: CtExceptionRow,
  actor: ExceptionActor
): string | null {
  if (exceptionActions(row, actor).length > 0) return null;
  if (row.objectType === 'delivery_order') {
    return 'La entrega se decide en Logística: abre el despacho o el viaje.';
  }
  if (row.objectType === 'operational_case') {
    return 'El expediente se destraba desde su propia página, con su siguiente paso.';
  }
  if (!canActOnException(row, actor)) {
    return 'Necesitas gestionar o administrar operaciones (o ser la persona responsable) para actuar aquí.';
  }
  return 'Esta excepción no tiene acciones disponibles en su estado actual.';
}

export interface ExceptionActionInput {
  /** What the person typed (note, reason or answer). */
  text?: string;
  /** User id picked for a reassignment. */
  ownerUserId?: string;
}

export type ExceptionPayloadResult =
  { ok: true; payload: Record<string, unknown> } | { ok: false; error: string };

/** Validates what the person typed BEFORE sending it (the engine validates again). */
export function buildExceptionPayload(
  action: CtExceptionAction,
  input: ExceptionActionInput
): ExceptionPayloadResult {
  const payload: Record<string, unknown> = { ...(action.payload ?? {}) };
  if (action.form === 'none') return { ok: true, payload };

  if (action.form === 'assignee') {
    const ownerUserId = (input.ownerUserId ?? '').trim();
    if (!ownerUserId) return { ok: false, error: 'Elige a quién le pasa el trabajo' };
    payload.ownerUserId = ownerUserId.slice(0, 120);
    const reason = (input.text ?? '').trim();
    if (reason) payload.reason = reason.slice(0, 500);
    return { ok: true, payload };
  }

  const text = (input.text ?? '').trim();
  if (!text) {
    if (action.required) {
      return { ok: false, error: `Escribe ${ACTION_FIELD_LABELS[action.form].toLowerCase()}` };
    }
    return { ok: true, payload };
  }
  if (action.required && text.length < 3) {
    return { ok: false, error: 'Escribe al menos 3 caracteres' };
  }
  const value = text.slice(0, actionFieldMax(action.form));
  if (action.form === 'answer') payload.answer = value;
  else if (action.form === 'reason') {
    // `incident.resolve` names its field `resolution`; the rest use `reason`.
    if (action.commandType === 'incident.resolve') payload.resolution = value;
    else payload.reason = value;
  } else payload.note = value;
  return { ok: true, payload };
}

/** Command for the offline queue: same aggregate and version the engine expects. */
export function buildExceptionCommand(
  action: CtExceptionAction,
  row: CtExceptionRow,
  payload: Record<string, unknown>
): OfflineCommandInput<Record<string, unknown>> {
  return {
    type: action.commandType,
    aggregate: { type: action.aggregateType, id: row.objectId },
    payload,
    expectedVersion: row.version,
  };
}
