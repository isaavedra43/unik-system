import { CRM_COMMANDS, CRM_OBJECT_TYPES, OPPORTUNITY_STATUSES } from '@/modules/crm/types';
import { CASE_OPEN_STATUSES, CASE_STATUSES } from '@/modules/operations/types';
import { QUOTE_OPEN_STATUSES, VENTAS_ROW_KINDS } from './ventas-constants';

/**
 * Acciones de dominio que ofrecen las filas de Ventas en el centro de trabajo
 * (plan 7.4 y entrega 5 del plan 8). PURO: sin Prisma, sin React, sin E/S.
 *
 * El catálogo lo serializa la rama SQL (`work-branches.ts`) dentro de
 * `extra.actions`, así que `work-actions.getRowActions` lo filtra por estado y
 * por permiso igual en el servidor que en el navegador. Ocultar un botón es
 * sólo una cortesía: `executeCommand` vuelve a validar permiso, transición y
 * versión optimista.
 *
 * Cada entrada nombra un comando REAL (`crm.opportunity.*` de
 * `modules/crm/opportunities-service.ts`, `case.*` del núcleo) y lleva el
 * payload fijo que ese comando exige, porque cada manejador comprueba que el
 * agregado corresponda al id de su payload (`assertAggregateTarget`).
 *
 * NO están aquí las acciones que necesitan datos estructurados (mover de etapa
 * eligiendo la etapa destino, replanear con su vista de impacto, convertir una
 * cotización aceptada en orden de venta de Zoho): la primera vive en el embudo,
 * la segunda en el expediente y la tercera es una escritura externa con su
 * propio ledger (`POST …/quotes/[id]/sales-order`), no un comando. El diálogo
 * genérico de la tabla sólo sabe recoger una nota o un motivo.
 */

export interface VentasBranchAction {
  id: string;
  label: string;
  commandType: string;
  aggregateType: string;
  /** Dato que recoge el diálogo compartido. */
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
   * Llave del payload en la que viaja el texto capturado, cuando el comando no
   * la llama `note`/`reason` (`crm.opportunity.mark_lost` exige `lostReason`).
   */
  payloadTextKey?: string;
  /** Payload fijo adicional al id del registro, que añade la rama SQL. */
  payload?: Record<string, string | number | boolean>;
}

const OPPORTUNITY_AGGREGATE = CRM_OBJECT_TYPES.opportunity;
const CASE_AGGREGATE = 'operational_case';

/**
 * Comandos del expediente. Se restablecen como literales, igual que hace
 * `work-actions.ts` con los del trabajo y las solicitudes, porque `CASE_COMMANDS`
 * vive en `operations/case-service.ts`, que importa Prisma y no puede cargarse
 * en el navegador. La prueba de este archivo compara los dos lados.
 */
const CASE_COMMAND = { advance: 'case.advance', cancel: 'case.cancel' } as const;

/** Gestionar el embudo es la llave de acción del área (AREA_REGISTRY.ventas.act). */
const MANAGE = ['crm.manage'];
/** Los comandos del expediente son del núcleo, no del CRM. */
const OPERATE_CASE = ['operations.manage', 'operations.admin'];

/** Oportunidades vivas: cerrar la venta, darla por perdida o dormirla. */
export const OPPORTUNITY_ROW_ACTIONS: readonly VentasBranchAction[] = [
  {
    id: 'opportunity.mark_won',
    label: 'Marcar ganada',
    commandType: CRM_COMMANDS.opportunityMarkWon,
    aggregateType: OPPORTUNITY_AGGREGATE,
    form: 'note',
    tone: 'primary',
    confirm: null,
    successMessage: 'Oportunidad ganada',
    hint: 'La mueve a la etapa ganada del embudo. Puedes dejar una nota de cierre.',
    permissions: MANAGE,
    statuses: ['open', 'dormant'],
  },
  {
    id: 'opportunity.mark_lost',
    label: 'Marcar perdida',
    commandType: CRM_COMMANDS.opportunityMarkLost,
    aggregateType: OPPORTUNITY_AGGREGATE,
    form: 'reason',
    tone: 'danger',
    confirm: '¿Dar la oportunidad por perdida? Se mueve a la etapa perdida del embudo.',
    successMessage: 'Oportunidad perdida',
    hint: 'Indica por qué se perdió: es lo que se analiza después por motivo de pérdida.',
    permissions: MANAGE,
    statuses: ['open', 'dormant'],
    // El comando la llama `lostReason` (el diálogo captura un motivo).
    payloadTextKey: 'lostReason',
  },
  {
    id: 'opportunity.mark_dormant',
    label: 'Marcar dormida',
    commandType: CRM_COMMANDS.opportunityMarkDormant,
    aggregateType: OPPORTUNITY_AGGREGATE,
    form: 'reason',
    tone: 'default',
    confirm: null,
    successMessage: 'Oportunidad dormida',
    hint: 'El cliente no responde por ahora; deja de contar como seguimiento vencido.',
    permissions: MANAGE,
    statuses: ['open'],
  },
  {
    id: 'opportunity.record_note',
    label: 'Registrar nota',
    commandType: CRM_COMMANDS.opportunityRecordActivity,
    aggregateType: OPPORTUNITY_AGGREGATE,
    form: 'note',
    tone: 'default',
    confirm: null,
    successMessage: 'Nota registrada',
    hint: 'Queda en la línea de tiempo de la oportunidad con tu nombre y la hora.',
    permissions: MANAGE,
    statuses: ['open', 'dormant'],
    // `crm.opportunity.record_activity` exige `kind` + `summary`.
    payloadTextKey: 'summary',
    payload: { kind: 'note' },
  },
];

/** Expedientes de venta: lo que el núcleo permite hacer desde una fila. */
export const CASE_ROW_ACTIONS: readonly VentasBranchAction[] = [
  {
    id: 'case.advance',
    label: 'Avanzar el expediente',
    commandType: CASE_COMMAND.advance,
    aggregateType: CASE_AGGREGATE,
    form: 'none',
    tone: 'primary',
    confirm: null,
    successMessage: 'Expediente avanzado',
    hint: 'Vuelve a correr el proceso: abre los pasos que ya tengan todo lo que esperaban.',
    permissions: OPERATE_CASE,
    statuses: [...CASE_OPEN_STATUSES],
  },
  {
    id: 'case.cancel',
    label: 'Cancelar expediente',
    commandType: CASE_COMMAND.cancel,
    aggregateType: CASE_AGGREGATE,
    form: 'reason',
    tone: 'danger',
    confirm:
      '¿Cancelar el expediente? Se liberan sus reservas y se cancela lo que las demás áreas tuvieran pendiente.',
    successMessage: 'Expediente cancelado',
    hint: 'Indica el motivo: queda en la cronología y lo ven todas las áreas del expediente.',
    permissions: OPERATE_CASE,
    statuses: [...CASE_OPEN_STATUSES],
  },
];

/**
 * Las cotizaciones NO ofrecen comandos: convertir una cotización aceptada en
 * orden de venta es una escritura a Zoho con su propio ledger idempotente, no
 * un comando del motor. La nota dice dónde se hace, en vez de dejar el menú
 * vacío sin explicación (`work-actions.noActionsReason` la lee de
 * `extra.actionsNote`).
 */
export const QUOTE_ACTIONS_NOTE =
  'Una cotización aceptada se convierte en orden de venta desde el Embudo; aquí puedes consultarla y comentarla.';

/** Catálogo de una clase de fila (vacío para una clase sin acciones de dominio). */
export function ventasRowActions(rowKind: string): readonly VentasBranchAction[] {
  if (rowKind === VENTAS_ROW_KINDS.opportunity) return OPPORTUNITY_ROW_ACTIONS;
  if (rowKind === VENTAS_ROW_KINDS.case) return CASE_ROW_ACTIONS;
  return [];
}

/**
 * Acciones que una fila en `status` puede ofrecer por su estado. Es el MISMO
 * predicado que aplica la rama SQL (dentro de Postgres, para que cada fila
 * cargue sólo las suyas).
 */
export function ventasActionsForStatus(rowKind: string, status: string): VentasBranchAction[] {
  return ventasRowActions(rowKind).filter((action) => action.statuses.includes(status));
}

const STATUSES_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  [VENTAS_ROW_KINDS.opportunity]: OPPORTUNITY_STATUSES,
  [VENTAS_ROW_KINDS.case]: CASE_STATUSES,
  [VENTAS_ROW_KINDS.quote]: QUOTE_OPEN_STATUSES,
};

/** Estados citados por el catálogo que no son estados reales (debe estar siempre vacío). */
export function unknownVentasActionStatuses(): string[] {
  const out: string[] = [];
  for (const [rowKind, statuses] of Object.entries(STATUSES_BY_KIND)) {
    const known = new Set(statuses);
    for (const action of ventasRowActions(rowKind)) {
      for (const status of action.statuses) {
        if (!known.has(status)) out.push(`${action.id}:${status}`);
      }
    }
  }
  return out;
}

/** Ids del catálogo (para las pruebas y para el registro de cliente). */
export const VENTAS_ACTION_IDS = [...OPPORTUNITY_ROW_ACTIONS, ...CASE_ROW_ACTIONS].map(
  (action) => action.id
);
