import { OPERATIONS_OPERATOR_PERMISSIONS } from '@/modules/operations/permissions';
import { extraString, isOpenRowStatus, rowKindLabel, type AreaWorkRow } from './area-work-row';

/**
 * Actions offered for a work row (plan 7.4). PURE: no Prisma, no React, no I/O.
 * The UI only decides what to SHOW; the engine decides what happens — every
 * command is validated again by `executeCommand` (permissions, transition and
 * optimistic version), so hiding a button is a courtesy, never the control.
 *
 * The transition tables mirror `work-items-service.WORK_ITEM_TRANSITIONS` and
 * `area-requests-service.AREA_REQUEST_TRANSITIONS`; those modules import Prisma
 * and cannot be loaded in the browser, so the rules are restated here and the
 * unit test walks every (row kind × status × role) combination.
 *
 * Domain rows (an order, a count, a delivery…) bring their own actions from the
 * SQL branch in `extra.actions`; they are validated here before being shown.
 */

export const WORK_ITEM_AGGREGATE = 'work_item';
export const AREA_REQUEST_AGGREGATE = 'area_request';

/** Extra input the dialog asks for before sending the command. */
export type AreaRowActionForm = 'none' | 'note' | 'reason' | 'wait' | 'answer';

export interface AreaRowAction {
  /** Stable id (`workitem.start`), unique per row. */
  id: string;
  label: string;
  /** Command type sent to `POST /app/operations/api/commands`. */
  commandType: string;
  aggregateType: string;
  form: AreaRowActionForm;
  tone: 'primary' | 'default' | 'danger';
  /** Question asked before running it; null runs straight away. */
  confirm: string | null;
  successMessage: string;
  /** Sentence shown above the form. */
  hint: string | null;
  /**
   * Fixed payload the command needs besides what the dialog collects. Domain
   * commands name their own record (`{productionOrderId}`, `{obligationId}`…)
   * and reject a command whose aggregate does not match it, so the SQL branch
   * declares it per row. Core work items and requests never need it.
   */
  payload?: Record<string, unknown>;
  /**
   * Key the collected text travels under when the command does not call it
   * `note` / `reason` / `answer` (`crm.opportunity.mark_lost` asks for
   * `lostReason`, `crm.opportunity.record_activity` for `summary`). Undefined
   * keeps the name of the form, which is what every core action uses.
   */
  payloadTextKey?: string;
  /**
   * Aggregate the command runs against when it is NOT the row's own id — a
   * production operation, for instance, acts on its production order.
   */
  aggregateId?: string;
  /**
   * The action ends in a core work item (a verification, for instance), so only
   * its owner, its backup or an operations manager may run it — exactly the rule
   * the engine applies (`assertCanActOnWorkItem`).
   */
  participantOnly?: boolean;
}

export interface RowActionActor {
  id: string;
  permissionKeys: readonly string[];
  isSuperAdmin: boolean;
}

export interface RowActionOptions {
  /**
   * Permissions that let this person act for the area (`areaActPermissions`).
   * They open the domain actions; core work items and requests always need the
   * person to be the owner / backup or to operate the core (`operations.manage`
   * or `operations.admin`).
   */
  actPermissions?: readonly string[];
}

/**
 * Quien opera el núcleo sin ser dueño de la fila. La lista NO se repite aquí: es la
 * misma constante que leen `assertCanActOnWorkItem`, `assertCanHandleIncident` y
 * `assertHumanDecider`, para que un botón ofrecido aquí nunca reciba un 403 allá.
 */
const MANAGE_PERMISSIONS = OPERATIONS_OPERATOR_PERMISSIONS;

/** Statuses of a work item in which each action is allowed (core: WORK_ITEM_TRANSITIONS). */
const WORK_ITEM_FROM: Readonly<Record<string, readonly string[]>> = {
  start: ['open', 'waiting', 'escalated'],
  complete: ['open', 'in_progress', 'waiting', 'escalated'],
  wait: ['open', 'in_progress', 'escalated'],
  escalate: ['open', 'in_progress', 'waiting', 'escalated'],
};

/** Statuses of an area request in which each action is allowed (core: AREA_REQUEST_TRANSITIONS). */
const REQUEST_FROM: Readonly<Record<string, readonly string[]>> = {
  acknowledge: ['sent'],
  accept: ['sent', 'acknowledged', 'blocked'],
  block: ['sent', 'acknowledged', 'accepted'],
  resolve: ['sent', 'acknowledged', 'accepted', 'blocked'],
  reject: ['sent', 'acknowledged', 'accepted', 'blocked'],
  cancel: ['sent', 'acknowledged', 'accepted', 'blocked'],
};

function holds(actor: RowActionActor, keys: readonly string[]): boolean {
  return actor.isSuperAdmin || keys.some((key) => actor.permissionKeys.includes(key));
}

/** Owner or backup of the row. */
export function isRowParticipant(row: AreaWorkRow, actor: RowActionActor): boolean {
  if (row.ownerUserId && row.ownerUserId === actor.id) return true;
  return extraString(row.extra, 'backupUserId') === actor.id;
}

function action(
  input: Partial<AreaRowAction> &
    Pick<AreaRowAction, 'id' | 'label' | 'commandType' | 'aggregateType' | 'successMessage'>
): AreaRowAction {
  return { form: 'none', tone: 'default', confirm: null, hint: null, ...input };
}

function workItemActions(row: AreaWorkRow): AreaRowAction[] {
  const isApproval = row.objectType === 'approval_request';
  // Business approvals are signed in "Mi trabajo" with their own card (double signature).
  if (isApproval) return [];
  const answersRequest = row.objectType === 'area_request';
  const out: AreaRowAction[] = [];
  if (WORK_ITEM_FROM.start.includes(row.status) && row.status !== 'in_progress') {
    out.push(
      action({
        id: 'workitem.start',
        label: 'Iniciar',
        commandType: 'workitem.start',
        aggregateType: WORK_ITEM_AGGREGATE,
        tone: 'primary',
        successMessage: 'Trabajo iniciado',
      })
    );
  }
  if (WORK_ITEM_FROM.complete.includes(row.status)) {
    out.push(
      action({
        id: 'workitem.complete',
        label: 'Completar',
        commandType: 'workitem.complete',
        aggregateType: WORK_ITEM_AGGREGATE,
        form: 'note',
        tone: row.status === 'in_progress' ? 'primary' : 'default',
        successMessage: 'Trabajo completado',
        hint: answersRequest
          ? 'Escribe la respuesta para el área que hizo la solicitud.'
          : 'Agrega la nota o evidencia que deja constancia de lo que hiciste.',
      })
    );
  }
  if (WORK_ITEM_FROM.wait.includes(row.status)) {
    out.push(
      action({
        id: 'workitem.wait',
        label: 'Poner en espera',
        commandType: 'workitem.wait',
        aggregateType: WORK_ITEM_AGGREGATE,
        form: 'wait',
        successMessage: 'Trabajo en espera',
        hint: 'Di de qué depende y hasta cuándo esperas.',
      })
    );
  }
  if (WORK_ITEM_FROM.escalate.includes(row.status)) {
    out.push(
      action({
        id: 'workitem.escalate',
        label: 'Escalar',
        commandType: 'workitem.escalate',
        aggregateType: WORK_ITEM_AGGREGATE,
        form: 'note',
        successMessage: 'Trabajo escalado',
        hint: 'Explica por qué necesitas ayuda; avisamos al siguiente nivel.',
      })
    );
  }
  return out;
}

function requestInActions(row: AreaWorkRow): AreaRowAction[] {
  const out: AreaRowAction[] = [];
  if (REQUEST_FROM.acknowledge.includes(row.status)) {
    out.push(
      action({
        id: 'request.acknowledge',
        label: 'Marcar como recibida',
        commandType: 'request.acknowledge',
        aggregateType: AREA_REQUEST_AGGREGATE,
        successMessage: 'Solicitud recibida',
      })
    );
  }
  if (REQUEST_FROM.accept.includes(row.status)) {
    out.push(
      action({
        id: 'request.accept',
        label: 'Aceptar',
        commandType: 'request.accept',
        aggregateType: AREA_REQUEST_AGGREGATE,
        form: 'note',
        tone: 'primary',
        successMessage: 'Solicitud aceptada',
        hint: 'Puedes agregar una nota para el área que la envió.',
      })
    );
  }
  if (REQUEST_FROM.resolve.includes(row.status)) {
    out.push(
      action({
        id: 'request.resolve',
        label: 'Resolver',
        commandType: 'request.resolve',
        aggregateType: AREA_REQUEST_AGGREGATE,
        form: 'answer',
        successMessage: 'Solicitud resuelta',
        hint: 'Escribe la respuesta: es lo que verá el área que la envió.',
      })
    );
  }
  if (REQUEST_FROM.block.includes(row.status)) {
    out.push(
      action({
        id: 'request.block',
        label: 'Bloquear',
        commandType: 'request.block',
        aggregateType: AREA_REQUEST_AGGREGATE,
        form: 'reason',
        successMessage: 'Solicitud bloqueada',
        hint: 'Di qué te lo impide; el área que la envió tiene que replanear.',
      })
    );
  }
  if (REQUEST_FROM.reject.includes(row.status)) {
    out.push(
      action({
        id: 'request.reject',
        label: 'Rechazar',
        commandType: 'request.reject',
        aggregateType: AREA_REQUEST_AGGREGATE,
        form: 'reason',
        tone: 'danger',
        confirm:
          '¿Rechazar esta solicitud? El área que la envió tendrá que resolverlo de otra forma.',
        successMessage: 'Solicitud rechazada',
        hint: 'Explica por qué no procede.',
      })
    );
  }
  return out;
}

function requestOutActions(row: AreaWorkRow): AreaRowAction[] {
  if (!REQUEST_FROM.cancel.includes(row.status)) return [];
  return [
    action({
      id: 'request.cancel',
      label: 'Cancelar solicitud',
      commandType: 'request.cancel',
      aggregateType: AREA_REQUEST_AGGREGATE,
      form: 'reason',
      tone: 'danger',
      confirm: '¿Cancelar la solicitud que enviaste?',
      successMessage: 'Solicitud cancelada',
      hint: 'Di por qué ya no hace falta.',
    }),
  ];
}

const ACTION_FORMS: readonly AreaRowActionForm[] = ['none', 'note', 'reason', 'wait', 'answer'];

const PAYLOAD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const MAX_PAYLOAD_KEYS = 12;

/**
 * Fixed payload of a branch action: a flat object of scalars. Anything else
 * (nested objects, arrays, functions, oversized text) is dropped, so a branch
 * can never smuggle arbitrary structure into a command.
 */
function branchPayload(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PAYLOAD_KEYS) break;
    if (!PAYLOAD_KEY.test(key)) continue;
    if (typeof raw === 'string') out[key] = raw.slice(0, 200);
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === 'boolean' || raw === null) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function branchAggregateId(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && text.length <= 200 ? text : undefined;
}

/** Key of the text field a branch action renames (`lostReason`, `summary`…). */
function branchTextKey(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return PAYLOAD_KEY.test(text) ? text : undefined;
}

/** Actions a domain branch attached to the row (`extra.actions`), validated before use. */
export function parseBranchActions(
  value: unknown
): Array<AreaRowAction & { permissions: string[] }> {
  if (!Array.isArray(value)) return [];
  const out: Array<AreaRowAction & { permissions: string[] }> = [];
  for (const raw of value.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const commandType = typeof record.commandType === 'string' ? record.commandType.trim() : '';
    const aggregateType =
      typeof record.aggregateType === 'string' ? record.aggregateType.trim() : '';
    if (!id || !label || !commandType || !aggregateType) continue;
    if (!/^[a-z][a-z0-9_.]{2,79}$/.test(commandType)) continue;
    const form = ACTION_FORMS.includes(record.form as AreaRowActionForm)
      ? (record.form as AreaRowActionForm)
      : 'none';
    const tone =
      record.tone === 'primary' || record.tone === 'danger' ? record.tone : ('default' as const);
    out.push({
      id,
      label: label.slice(0, 60),
      commandType,
      aggregateType,
      form,
      tone,
      confirm: typeof record.confirm === 'string' ? record.confirm.slice(0, 200) : null,
      successMessage:
        typeof record.successMessage === 'string'
          ? record.successMessage.slice(0, 120)
          : 'Acción registrada',
      hint: typeof record.hint === 'string' ? record.hint.slice(0, 200) : null,
      ...(branchPayload(record.payload) ? { payload: branchPayload(record.payload) } : {}),
      ...(branchTextKey(record.payloadTextKey)
        ? { payloadTextKey: branchTextKey(record.payloadTextKey) }
        : {}),
      ...(branchAggregateId(record.aggregateId)
        ? { aggregateId: branchAggregateId(record.aggregateId) }
        : {}),
      ...(record.participantOnly === true ? { participantOnly: true } : {}),
      permissions: Array.isArray(record.permissions)
        ? record.permissions.filter((key): key is string => typeof key === 'string').slice(0, 8)
        : [],
    });
  }
  return out;
}

/**
 * Actions this person can try on this row. Empty when the row is closed, when
 * the person is not part of it, or when the area has not declared actions for
 * that row kind yet.
 */
export function getRowActions(
  row: AreaWorkRow,
  actor: RowActionActor,
  options: RowActionOptions = {}
): AreaRowAction[] {
  if (!isOpenRowStatus(row.rowKind, row.status)) return [];
  const manages = holds(actor, MANAGE_PERMISSIONS);
  const participant = isRowParticipant(row, actor);

  if (row.rowKind === 'work_item') {
    return manages || participant ? workItemActions(row) : [];
  }
  if (row.rowKind === 'request_in') {
    // Core rule: the responsible of the destination area (owner / backup) or whoever operates the core.
    return manages || participant ? requestInActions(row) : [];
  }
  if (row.rowKind === 'request_out') {
    const requester = extraString(row.extra, 'createdById') === actor.id;
    return manages || participant || requester ? requestOutActions(row) : [];
  }

  const act = options.actPermissions ?? [];
  return parseBranchActions(row.extra.actions)
    .filter((entry) => {
      // A row that ends in a core work item keeps the core rule.
      if (entry.participantOnly && !(manages || participant)) return false;
      return entry.permissions.length > 0
        ? holds(actor, entry.permissions)
        : manages || holds(actor, act);
    })
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      commandType: entry.commandType,
      aggregateType: entry.aggregateType,
      form: entry.form,
      tone: entry.tone,
      confirm: entry.confirm,
      successMessage: entry.successMessage,
      hint: entry.hint,
      ...(entry.payload ? { payload: entry.payload } : {}),
      ...(entry.payloadTextKey ? { payloadTextKey: entry.payloadTextKey } : {}),
      ...(entry.aggregateId ? { aggregateId: entry.aggregateId } : {}),
      ...(entry.participantOnly ? { participantOnly: true } : {}),
    }));
}

/** The action of an id for this row, or null (server-side defence in depth). */
export function findRowAction(
  row: AreaWorkRow,
  actor: RowActionActor,
  actionId: string,
  options: RowActionOptions = {}
): AreaRowAction | null {
  return getRowActions(row, actor, options).find((entry) => entry.id === actionId) ?? null;
}

/** Primary action of a row (the one the mobile card and the drawer highlight). */
export function primaryRowAction(actions: readonly AreaRowAction[]): AreaRowAction | null {
  return actions.find((entry) => entry.tone === 'primary') ?? actions[0] ?? null;
}

/** Short sentence for the drawer when a row offers nothing to this person. */
export function noActionsReason(row: AreaWorkRow, actor: RowActionActor): string {
  if (!isOpenRowStatus(row.rowKind, row.status)) {
    return `Este ${rowKindLabel(row.rowKind).toLowerCase()} ya está cerrado.`;
  }
  if (row.objectType === 'approval_request') {
    return 'Esta aprobación se firma desde Mi trabajo, con su tarjeta de aprobación.';
  }
  // A branch may explain where its row IS attended when the engine has no
  // command for it (a Zoho write with its own ledger, a management panel).
  const note = extraString(row.extra, 'actionsNote');
  if (note) return note.slice(0, 200);
  if (!isRowParticipant(row, actor)) {
    return 'Lo atiende su responsable; tú puedes consultarlo y comentarlo.';
  }
  return 'No hay acciones disponibles en este estado.';
}
