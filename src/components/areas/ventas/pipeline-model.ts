import type { OfflineCommandInput } from '@/lib/offline-commands';
import type { OpportunityDTO, PipelineStageDTO } from '@/modules/crm/crm-dto';
import type { PipelineBoard, PipelineBoardColumn } from '@/modules/crm/crm-queries';
import { CRM_COMMANDS, CRM_OBJECT_TYPES } from '@/modules/crm/types';
import { formatMoney, formatProbability } from '@/modules/areas/ventas/ventas-constants';

/**
 * Modelo PURO del embudo comercial (plan 7.4, subpágina de Ventas): columnas,
 * tarjetas, movimientos de etapa y el comando que los ejecuta. Sin React y sin
 * red; la vista sólo arrastra y pinta, y el motor vuelve a validar todo.
 */

export type StageTone = 'default' | 'success' | 'danger';

export function stageTone(kind: string | null | undefined): StageTone {
  if (kind === 'won') return 'success';
  if (kind === 'lost') return 'danger';
  return 'default';
}

export interface PipelineCardView {
  id: string;
  number: string;
  title: string;
  customerName: string;
  salespersonName: string | null;
  valueLabel: string;
  probabilityLabel: string;
  nextActionText: string | null;
  nextActionAt: string | null;
  nextActionOverdue: boolean;
  /** Horas por encima del SLA de la etapa (null = dentro del SLA o sin SLA). */
  stageSlaExceededHours: number | null;
  stageId: string;
  status: string;
  statusLabel: string;
  version: number;
}

export interface PipelineColumnView {
  stageId: string;
  stageKey: string;
  stageName: string;
  stageKind: string;
  tone: StageTone;
  count: number;
  totalLabel: string;
  weightedLabel: string;
  cards: PipelineCardView[];
}

export function toCard(opportunity: OpportunityDTO): PipelineCardView {
  return {
    id: opportunity.id,
    number: opportunity.number,
    title: opportunity.title,
    customerName: opportunity.contactName,
    salespersonName: opportunity.salespersonName,
    valueLabel: formatMoney(opportunity.estimatedValue, opportunity.currency),
    probabilityLabel: formatProbability(opportunity.effectiveProbability),
    nextActionText: opportunity.nextActionText,
    nextActionAt: opportunity.nextActionAt,
    nextActionOverdue: opportunity.nextActionOverdue,
    stageSlaExceededHours: opportunity.stageSlaExceededHours,
    stageId: opportunity.stageId,
    status: opportunity.status,
    statusLabel: opportunity.statusLabel,
    version: opportunity.version,
  };
}

function toColumn(column: PipelineBoardColumn): PipelineColumnView {
  return {
    stageId: column.stage.id,
    stageKey: column.stage.key,
    stageName: column.stage.name,
    stageKind: column.stage.kind,
    tone: stageTone(column.stage.kind),
    count: column.count,
    totalLabel: formatMoney(column.totalValue),
    weightedLabel: formatMoney(column.weightedValue),
    cards: column.opportunities.map(toCard),
  };
}

export function boardColumns(board: PipelineBoard): PipelineColumnView[] {
  return board.columns.map(toColumn);
}

export interface PipelineTotals {
  openLabel: string;
  valueLabel: string;
  weightedLabel: string;
}

export function boardTotals(board: PipelineBoard): PipelineTotals {
  return {
    openLabel: board.totals.open.toLocaleString('es-MX'),
    valueLabel: formatMoney(board.totals.openValue),
    weightedLabel: formatMoney(board.totals.weightedValue),
  };
}

/** Etapas a las que se puede mover una tarjeta (todas las activas menos la suya). */
export function moveTargets(
  stages: readonly PipelineStageDTO[],
  currentStageId: string
): PipelineStageDTO[] {
  return stages.filter((stage) => stage.active && stage.id !== currentStageId);
}

export type MovePlan =
  | { kind: 'noop'; message: string }
  | { kind: 'needs_reason'; stage: PipelineStageDTO; message: string }
  | { kind: 'ready'; stage: PipelineStageDTO; confirm: string | null };

/**
 * Qué pasa al soltar una tarjeta en una etapa: nada (misma etapa), pedir el
 * motivo (etapa perdida) o ejecutar (con confirmación al ganar).
 */
export function planStageMove(card: PipelineCardView, stage: PipelineStageDTO): MovePlan {
  if (card.stageId === stage.id) {
    return { kind: 'noop', message: 'La oportunidad ya está en esa etapa.' };
  }
  if (!stage.active) {
    return { kind: 'noop', message: `La etapa «${stage.name}» está desactivada.` };
  }
  if (stage.kind === 'lost') {
    return {
      kind: 'needs_reason',
      stage,
      message: `Indica por qué se perdió ${card.number} antes de moverla a «${stage.name}».`,
    };
  }
  if (stage.kind === 'won') {
    return {
      kind: 'ready',
      stage,
      confirm: `¿Marcar ${card.number} como ganada en «${stage.name}»?`,
    };
  }
  return { kind: 'ready', stage, confirm: null };
}

export const LOST_REASON_MIN = 3;
export const LOST_REASON_MAX = 500;

export function lostReasonError(reason: string): string | null {
  const text = reason.trim();
  if (text.length < LOST_REASON_MIN) return 'Indica el motivo (mínimo 3 caracteres)';
  if (text.length > LOST_REASON_MAX) return 'El motivo admite hasta 500 caracteres';
  return null;
}

/** Comando de cambio de etapa (mismo que usa la IA con aprobación). */
export function buildMoveStageCommand(
  card: PipelineCardView,
  stage: PipelineStageDTO,
  lostReason?: string
): OfflineCommandInput<Record<string, unknown>> {
  const reason = lostReason?.trim();
  return {
    type: CRM_COMMANDS.opportunityMoveStage,
    aggregate: { type: CRM_OBJECT_TYPES.opportunity, id: card.id },
    payload: {
      opportunityId: card.id,
      stageKey: stage.key,
      ...(reason ? { lostReason: reason } : {}),
    },
    expectedVersion: card.version,
  };
}

/** Comando para fijar la siguiente acción de una oportunidad. */
export function buildNextActionCommand(input: {
  opportunityId: string;
  version: number;
  nextActionText: string;
  nextActionAt: string;
}): OfflineCommandInput<Record<string, unknown>> {
  return {
    type: CRM_COMMANDS.opportunityUpdate,
    aggregate: { type: CRM_OBJECT_TYPES.opportunity, id: input.opportunityId },
    payload: {
      opportunityId: input.opportunityId,
      nextActionText: input.nextActionText.trim(),
      nextActionAt: new Date(input.nextActionAt).toISOString(),
    },
    expectedVersion: input.version,
  };
}

/** Comando para registrar una actividad manual (nota, llamada, tarea, objeción). */
export function buildActivityCommand(input: {
  opportunityId: string;
  kind: string;
  summary: string;
  nextActionText?: string;
  nextActionAt?: string;
}): OfflineCommandInput<Record<string, unknown>> {
  const nextActionText = input.nextActionText?.trim();
  const nextActionAt = input.nextActionAt?.trim();
  return {
    type: CRM_COMMANDS.opportunityRecordActivity,
    // Comando sin agregado versionado: su id sólo identifica la intención.
    aggregate: { type: CRM_OBJECT_TYPES.opportunity, id: `activity:${input.opportunityId}` },
    payload: {
      opportunityId: input.opportunityId,
      kind: input.kind,
      summary: input.summary.trim(),
      ...(nextActionText ? { nextActionText } : {}),
      ...(nextActionAt ? { nextActionAt: new Date(nextActionAt).toISOString() } : {}),
    },
  };
}

/** Comando para crear la oportunidad de una conversación de la bandeja. */
export function buildCreateFromConversationCommand(input: {
  conversationId: string;
  title?: string;
}): OfflineCommandInput<Record<string, unknown>> {
  const title = input.title?.trim();
  return {
    type: CRM_COMMANDS.opportunityCreateFromConversation,
    aggregate: {
      type: CRM_OBJECT_TYPES.opportunity,
      id: `opportunity:conversation:${input.conversationId}`,
    },
    payload: {
      conversationId: input.conversationId,
      ...(title && title.length >= 2 ? { title } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Etapas del embudo (plan 6.5: «editable afterwards with `crm.manage_stages`»)
// ---------------------------------------------------------------------------

/**
 * Agregado de los comandos de etapa. `crm.stage.*` se registra con
 * `aggregate: 'none'`, así que el id sólo identifica la intención: es el mismo
 * que usa `pipeline-service` al ejecutarlos desde el servidor.
 */
export const PIPELINE_STAGE_AGGREGATE = {
  type: CRM_OBJECT_TYPES.pipelineStage,
  id: 'pipeline',
} as const;

export interface StageFormInput {
  name: string;
  kind: string;
  /** Vacío = la probabilidad por omisión del tipo. */
  probabilityPct: string;
  /** Vacío = sin SLA (la etapa nunca marca atraso). */
  slaHours: string;
}

export const STAGE_NAME_MIN = 2;
export const STAGE_NAME_MAX = 60;
export const STAGE_SLA_MIN = 1;
export const STAGE_SLA_MAX = 8760;

/**
 * Lo que la pantalla puede decir en español antes de mandar el comando. El
 * motor vuelve a validar TODO (`createStageSchema` / `updateStageSchema`), y
 * además las reglas que sólo él conoce: nombre repetido, el embudo necesita una
 * etapa activa de cada tipo y una etapa con oportunidades vivas no se apaga.
 */
export function stageFormIssues(
  form: StageFormInput,
  existing: readonly PipelineStageDTO[] = []
): string[] {
  const issues: string[] = [];
  const name = form.name.trim();
  if (name.length < STAGE_NAME_MIN || name.length > STAGE_NAME_MAX) {
    issues.push(`Escribe un nombre de entre ${STAGE_NAME_MIN} y ${STAGE_NAME_MAX} caracteres`);
  } else if (
    existing.some(
      (stage) =>
        stage.active && stage.name.trim().toLocaleLowerCase('es') === name.toLocaleLowerCase('es')
    )
  ) {
    issues.push(`Ya existe una etapa activa llamada «${name}»`);
  }
  if (!['open', 'won', 'lost'].includes(form.kind)) {
    issues.push('Elige si la etapa es abierta, ganada o perdida');
  }
  const pct = form.probabilityPct.trim();
  if (pct !== '') {
    const value = Number(pct);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      issues.push('La probabilidad va de 0 a 100');
    }
  }
  const sla = form.slaHours.trim();
  if (sla !== '') {
    const value = Number(sla);
    if (!Number.isInteger(value) || value < STAGE_SLA_MIN || value > STAGE_SLA_MAX) {
      issues.push(`El SLA son horas enteras entre ${STAGE_SLA_MIN} y ${STAGE_SLA_MAX}`);
    }
  }
  return issues;
}

/** Comando de alta de etapa (`crm.manage_stages`). La clave la genera el motor. */
export function buildCreateStageCommand(
  form: StageFormInput
): OfflineCommandInput<Record<string, unknown>> {
  const pct = form.probabilityPct.trim();
  const sla = form.slaHours.trim();
  return {
    type: CRM_COMMANDS.stageCreate,
    aggregate: { ...PIPELINE_STAGE_AGGREGATE },
    payload: {
      name: form.name.trim(),
      kind: form.kind,
      ...(pct === '' ? {} : { probabilityDefault: Number(pct) / 100 }),
      ...(sla === '' ? {} : { slaHours: Number(sla) }),
    },
  };
}

/**
 * Comando de cambio de una etapa. `slaHours: null` la deja sin SLA; omitirlo la
 * deja como está, igual que `updateStageSchema` distingue en el servidor.
 */
export function buildUpdateStageCommand(input: {
  stageId: string;
  name?: string;
  probabilityPct?: string;
  slaHours?: string | null;
  active?: boolean;
}): OfflineCommandInput<Record<string, unknown>> {
  const pct = input.probabilityPct?.trim();
  const sla = input.slaHours === null ? null : input.slaHours?.trim();
  return {
    type: CRM_COMMANDS.stageUpdate,
    aggregate: { ...PIPELINE_STAGE_AGGREGATE },
    payload: {
      stageId: input.stageId,
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(pct === undefined || pct === '' ? {} : { probabilityDefault: Number(pct) / 100 }),
      ...(sla === undefined ? {} : { slaHours: sla === null || sla === '' ? null : Number(sla) }),
      ...(input.active === undefined ? {} : { active: input.active }),
    },
  };
}

/** Comando de reordenamiento: la lista completa de etapas activas, en su nuevo orden. */
export function buildReorderStagesCommand(
  stageIds: readonly string[]
): OfflineCommandInput<Record<string, unknown>> {
  return {
    type: CRM_COMMANDS.stageReorder,
    aggregate: { ...PIPELINE_STAGE_AGGREGATE },
    payload: { stageIds: [...stageIds] },
  };
}

/**
 * Nueva lista de ids tras mover una etapa un lugar arriba o abajo. Devuelve la
 * MISMA lista cuando el movimiento no cabe, para que la pantalla no mande un
 * comando que no cambia nada.
 */
export function moveStageInOrder(
  stageIds: readonly string[],
  stageId: string,
  direction: 'up' | 'down'
): string[] {
  const index = stageIds.indexOf(stageId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= stageIds.length) return [...stageIds];
  const next = [...stageIds];
  next[index] = next[target];
  next[target] = stageId;
  return next;
}

/** Etapas activas, en orden: lo que el comando de reordenamiento debe listar. */
export function activeStageIds(stages: readonly PipelineStageDTO[]): string[] {
  return [...stages]
    .filter((stage) => stage.active)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'es'))
    .map((stage) => stage.id);
}

/**
 * Por qué NO se puede apagar una etapa, en español, con lo que la pantalla ya
 * sabe (el motor vuelve a comprobarlo y además cuenta las oportunidades vivas).
 */
export function deactivateStageIssue(
  stages: readonly PipelineStageDTO[],
  stageId: string,
  openCount: number
): string | null {
  const stage = stages.find((row) => row.id === stageId);
  if (!stage) return 'La etapa ya no existe';
  if (openCount > 0) {
    return openCount === 1
      ? `Mueve primero la oportunidad abierta de «${stage.name}» a otra etapa`
      : `Mueve primero las ${openCount} oportunidades abiertas de «${stage.name}» a otra etapa`;
  }
  const siblings = stages.filter(
    (row) => row.id !== stage.id && row.active && row.kind === stage.kind
  );
  if (siblings.length === 0) {
    return `El embudo necesita al menos una etapa activa de este tipo: «${stage.name}» es la única`;
  }
  return null;
}

/**
 * Oportunidades VIVAS (abiertas o dormidas) por etapa, según lo que el tablero
 * trajo. Es lo que la pantalla puede saber sin otra consulta; el motor cuenta
 * de verdad antes de apagar una etapa y rechaza con el número exacto.
 */
export function openStageCounts(board: PipelineBoard): Record<string, number> {
  const out: Record<string, number> = {};
  for (const column of board.columns) {
    out[column.stage.id] = column.opportunities.filter((opportunity) =>
      ['open', 'dormant'].includes(opportunity.status)
    ).length;
  }
  return out;
}
