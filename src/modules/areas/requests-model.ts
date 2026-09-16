import {
  nextAreaRequestStatus,
  type AreaRequestDTO,
} from '@/modules/operations/area-requests-service';

/**
 * Which buttons a person gets on an area request (plan 7.5). SERVER SIDE: it
 * reuses the transition table of the core (`nextAreaRequestStatus`), so the
 * panel never invents a decision the engine would refuse, and the result
 * travels to the client as plain data.
 *
 * The rule has two halves:
 * - WHO: the responsible or backup of the request (or of its area), the area
 *   lead, or somebody with `operations.manage`. The command checks it again —
 *   and a bit wider, because it also accepts the owner of the linked work item,
 *   who can always act from "Mi trabajo".
 * - WHEN: only from the statuses the transition allows.
 *
 * Outgoing requests are read-only here: they are decided by the destination
 * area, and cancelling one is a command of the case, not of this panel.
 */

export type AreaRequestDecision = 'accept' | 'block' | 'resolve' | 'reject';

export interface AreaRequestActor {
  userId: string;
  /** `operations.manage` (or `operations.admin`): decides any request. */
  canManage: boolean;
  /** Responsible, backup or lead of the destination area. */
  areaResponsible: boolean;
}

/** What the person has to write before the decision is sent. */
export type AreaRequestActionForm = 'none' | 'note' | 'reason' | 'answer';

export interface AreaRequestActionOption {
  id: AreaRequestDecision;
  label: string;
  tone: 'primary' | 'default' | 'danger';
  form: AreaRequestActionForm;
  /** Whether the text is required (the command rejects it empty). */
  required: boolean;
  fieldLabel: string;
  hint: string;
  successMessage: string;
}

const OPTIONS: Record<AreaRequestDecision, Omit<AreaRequestActionOption, 'id'>> = {
  accept: {
    label: 'Aceptar',
    tone: 'primary',
    form: 'note',
    required: false,
    fieldLabel: 'Nota para quien la envió',
    hint: 'La tomas tú: el trabajo ligado se pone en curso y avisamos al área que la envió.',
    successMessage: 'Solicitud aceptada',
  },
  resolve: {
    label: 'Responder',
    tone: 'primary',
    form: 'answer',
    required: true,
    fieldLabel: 'Respuesta',
    hint: 'Tu respuesta cierra la solicitud y queda en el expediente.',
    successMessage: 'Solicitud respondida',
  },
  block: {
    label: 'Bloquear',
    tone: 'default',
    form: 'reason',
    required: true,
    fieldLabel: 'Motivo del bloqueo',
    hint: 'Queda en espera con tu motivo a la vista del área que la envió.',
    successMessage: 'Solicitud bloqueada',
  },
  reject: {
    label: 'Rechazar',
    tone: 'danger',
    form: 'reason',
    required: true,
    fieldLabel: 'Motivo del rechazo',
    hint: 'Se cierra sin atenderse; el área que la envió tendrá que replantearla.',
    successMessage: 'Solicitud rechazada',
  },
};

/** Order the buttons are offered in: lo que normalmente se hace, primero. */
export const AREA_REQUEST_DECISIONS: readonly AreaRequestDecision[] = [
  'accept',
  'resolve',
  'block',
  'reject',
];

type DecidableRequest = Pick<AreaRequestDTO, 'ownerUserId' | 'backupUserId' | 'status'>;

/** True when this person may decide this request (the command re-checks it). */
export function canDecideAreaRequest(request: DecidableRequest, actor: AreaRequestActor): boolean {
  if (actor.canManage) return true;
  if (request.ownerUserId === actor.userId) return true;
  if (request.backupUserId !== null && request.backupUserId === actor.userId) return true;
  return actor.areaResponsible;
}

export interface AreaRequestActionsOptions {
  /** `in` = received by the area (decidable); `out` = sent by it (read-only here). */
  direction: 'in' | 'out';
}

/**
 * Decisions available on a request right now. Empty when the person may not
 * decide it, when it is already closed, or for requests the area sent.
 */
export function areaRequestActions(
  request: DecidableRequest,
  actor: AreaRequestActor,
  options: AreaRequestActionsOptions
): AreaRequestActionOption[] {
  if (options.direction !== 'in') return [];
  if (!canDecideAreaRequest(request, actor)) return [];
  return AREA_REQUEST_DECISIONS.filter(
    (decision) => nextAreaRequestStatus(decision, request.status) !== null
  ).map((decision) => ({ id: decision, ...OPTIONS[decision] }));
}

/** Why there is no button, in Spanish (the panel says it instead of showing nothing). */
export function noDecisionReason(
  request: DecidableRequest,
  actor: AreaRequestActor,
  options: AreaRequestActionsOptions
): string | null {
  if (options.direction !== 'in') return 'La decide el área a la que se envió.';
  if (!canDecideAreaRequest(request, actor)) {
    return 'La responde el responsable del área o quien la tenga a cargo.';
  }
  if (areaRequestActions(request, actor, options).length === 0) return 'Ya está cerrada.';
  return null;
}
