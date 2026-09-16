import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { formatTimelineLine } from '@/modules/agents/templates';
import { assertControlTowerAccess } from '@/modules/control-tower/control-tower-service';
import {
  stepLabels as definitionStepLabels,
  toConformanceDefinition,
  type ConformanceDefinition,
} from '@/modules/control-tower/conformance';
import {
  layoutProcess,
  ProcessLayoutCycleError,
  type ProcessLayout,
} from '@/modules/control-tower/process-layout';
import type { ReplayEvent } from '@/modules/control-tower/replay';
import { replayTimestamps } from '@/modules/control-tower/replay';
import { listCaseEvents } from '@/modules/operations/events-service';
import { AI_TURN_EVENT_TYPES, CASE_OPEN_STATUSES } from '@/modules/operations/types';
import type { ProcessVersionOption } from '@/components/control-tower/neural/ProcessViewer';
import type { ReplayTimelineEntry } from '@/components/control-tower/neural/replay-model';
import type {
  ReplayCaseHeader,
  ReplayCaseOption,
} from '@/components/control-tower/neural/CaseReplay';
import type { SimulationCaseOption } from '@/components/control-tower/neural/SimulationPanel';

/**
 * Lecturas de servidor de UNIK Neural Operations (plan 7.8).
 *
 * Todo lo que estas páginas necesitan y que la API de la Torre de Control no
 * expone todavía: el catálogo de versiones de proceso, la definición de una
 * versión (para dibujarla) y la bitácora de un expediente (para reproducirla).
 *
 * Cada función vuelve a exigir `operations.admin` con `assertControlTowerAccess`:
 * el gate del layout evita pagar la consulta, esto evita que una ruta nueva se
 * salte la regla.
 */

/** Cuántos expedientes ofrece el selector de replay / simulación. */
const CASE_PICKER_LIMIT = 50;

/** Tope de eventos que entran a una reproducción (el mismo que la API). */
const REPLAY_EVENT_LIMIT = 1_000;

// ---------------------------------------------------------------------------
// Procesos
// ---------------------------------------------------------------------------

function countSteps(definition: unknown): number {
  const parsed = toConformanceDefinition(definition);
  return parsed ? parsed.steps.length : 0;
}

/** Versiones publicadas, las activas primero y de la más nueva a la más vieja. */
export async function listProcessVersions(actor: CurrentUser): Promise<ProcessVersionOption[]> {
  assertControlTowerAccess(actor);
  const rows = await prisma.processVersion.findMany({
    orderBy: [{ processKey: 'asc' }, { version: 'desc' }],
    select: { id: true, processKey: true, version: true, active: true, definition: true },
    take: 100,
  });
  return rows
    .map((row) => ({
      id: row.id,
      processKey: row.processKey,
      version: row.version,
      active: row.active,
      steps: countSteps(row.definition),
    }))
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        a.processKey.localeCompare(b.processKey) ||
        b.version - a.version
    );
}

export interface ProcessDefinitionView {
  versionId: string;
  processKey: string;
  version: number;
  definition: ConformanceDefinition;
  /** Acomodo listo para el lienzo; `null` cuando el proceso tiene un ciclo. */
  layout: ProcessLayout | null;
  /** Ciclo encontrado (el proceso está mal definido y hay que decirlo). */
  cycle: string[] | null;
  labels: Record<string, string>;
}

/** Definición de una versión, ya acomodada por `process-layout.ts`. */
export async function loadProcessDefinition(
  actor: CurrentUser,
  versionId: string | null
): Promise<ProcessDefinitionView | null> {
  assertControlTowerAccess(actor);
  if (!versionId) return null;
  const row = await prisma.processVersion.findUnique({
    where: { id: versionId },
    select: { id: true, processKey: true, version: true, definition: true },
  });
  if (!row) return null;
  const definition = toConformanceDefinition(row.definition);
  if (!definition) return null;

  const steps = definition.steps.map((step) => ({
    key: step.key,
    label: step.label ?? step.key,
    ...(step.areaKey ? { areaKey: step.areaKey } : {}),
    dependsOn: step.dependsOn,
  }));

  let layout: ProcessLayout | null = null;
  let cycle: string[] | null = null;
  try {
    layout = layoutProcess(steps);
  } catch (error) {
    if (error instanceof ProcessLayoutCycleError) cycle = error.cycle;
    else throw error;
  }

  return {
    versionId: row.id,
    processKey: row.processKey,
    version: row.version,
    definition,
    layout,
    cycle,
    labels: Object.fromEntries(definitionStepLabels(definition)),
  };
}

/** Versión que se abre por omisión: la activa más reciente. */
export function defaultVersionId(
  versions: readonly ProcessVersionOption[],
  requested: string | null
): string | null {
  if (requested && versions.some((version) => version.id === requested)) return requested;
  return versions[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Expedientes
// ---------------------------------------------------------------------------

/** Expedientes recientes para el selector del reproductor. */
export async function listRecentCases(actor: CurrentUser): Promise<ReplayCaseOption[]> {
  assertControlTowerAccess(actor);
  const rows = await prisma.operationalCase.findMany({
    orderBy: [{ openedAt: 'desc' }],
    take: CASE_PICKER_LIMIT,
    select: {
      id: true,
      caseNumber: true,
      customerName: true,
      openedAt: true,
      status: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    caseNumber: row.caseNumber,
    customerName: row.customerName,
    openedAt: row.openedAt.toISOString(),
    status: row.status,
  }));
}

/** Expedientes abiertos con fecha prometida: los que la simulación puede mover. */
export async function listSimulationCases(actor: CurrentUser): Promise<SimulationCaseOption[]> {
  assertControlTowerAccess(actor);
  const rows = await prisma.operationalCase.findMany({
    where: { status: { in: [...CASE_OPEN_STATUSES] } },
    orderBy: [{ promisedAt: 'asc' }, { openedAt: 'desc' }],
    take: CASE_PICKER_LIMIT,
    select: { id: true, caseNumber: true, customerName: true, promisedAt: true },
  });
  return rows.map((row) => ({
    id: row.id,
    caseNumber: row.caseNumber,
    customerName: row.customerName,
    promisedAt: row.promisedAt ? row.promisedAt.toISOString() : null,
  }));
}

/**
 * Llaves del payload que `foldCaseState` realmente lee. Sólo estas viajan al
 * navegador: la bitácora puede traer importes u otros datos del negocio que la
 * reproducción no necesita, y lo que no se manda no se puede filtrar.
 */
const REPLAY_PAYLOAD_KEYS = [
  'caseNumber',
  'customerName',
  'salesOrderNumber',
  'ownerUserId',
  'to',
  'areaKey',
  'stepKey',
  'scopeKey',
  'dueAt',
  'reason',
  'workItemId',
  'title',
  'backupUserId',
  'level',
  'requestId',
  'kind',
  'fromAreaKey',
  'toAreaKey',
  'blocksDelivery',
  'incidentId',
  'severity',
] as const;

function pickPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of REPLAY_PAYLOAD_KEYS) {
    if (payload[key] !== undefined) out[key] = payload[key];
  }
  return out;
}

export interface ReplayData {
  header: ReplayCaseHeader | null;
  events: ReplayEvent[];
  timeline: ReplayTimelineEntry[];
  timestamps: string[];
  stepLabels: Record<string, string>;
  truncated: boolean;
}

const EMPTY_REPLAY: ReplayData = {
  header: null,
  events: [],
  timeline: [],
  timestamps: [],
  stepLabels: {},
  truncated: false,
};

/**
 * Bitácora de un expediente lista para reproducir en el navegador.
 *
 * La cronología se arma SIEMPRE con `formatTimelineLine` y sin los eventos de
 * auditoría de la IA, para que esta página, la sala del chat y el Expediente
 * 360 cuenten exactamente la misma historia.
 */
export async function loadReplayData(
  actor: CurrentUser,
  caseId: string | null
): Promise<ReplayData> {
  assertControlTowerAccess(actor);
  if (!caseId) return EMPTY_REPLAY;

  const opCase = await prisma.operationalCase.findUnique({
    where: { id: caseId },
    select: {
      id: true,
      caseNumber: true,
      customerName: true,
      salesOrderNumber: true,
      status: true,
      phase: true,
      openedAt: true,
      promisedAt: true,
      processVersionId: true,
    },
  });
  if (!opCase) return EMPTY_REPLAY;

  const [page, definition] = await Promise.all([
    listCaseEvents(caseId, { limit: REPLAY_EVENT_LIMIT, excludeTypes: AI_TURN_EVENT_TYPES }),
    loadProcessDefinition(actor, opCase.processVersionId),
  ]);

  const events: ReplayEvent[] = page.events.map((event) => ({
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    areaKey: event.areaKey,
    actorType: event.actorType,
    actorId: event.actorId,
    objectType: event.objectType,
    objectId: event.objectId,
    payload: pickPayload(event.payload),
  }));

  const timeline: ReplayTimelineEntry[] = page.events.map((event) => ({
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    areaKey: event.areaKey,
    actorType: event.actorType,
    // La vista del Replay pinta su propia columna de hora.
    line: formatTimelineLine(
      {
        id: event.id,
        type: event.type,
        occurredAt: event.occurredAt,
        areaKey: event.areaKey,
        actorType: event.actorType,
        payload: event.payload,
      },
      undefined,
      { withClock: false }
    ),
  }));

  return {
    header: {
      id: opCase.id,
      caseNumber: opCase.caseNumber,
      customerName: opCase.customerName,
      salesOrderNumber: opCase.salesOrderNumber,
      status: opCase.status,
      phase: opCase.phase,
      openedAt: opCase.openedAt.toISOString(),
      promisedAt: opCase.promisedAt ? opCase.promisedAt.toISOString() : null,
    },
    events,
    timeline,
    timestamps: replayTimestamps(events),
    stepLabels: definition?.labels ?? {},
    truncated: page.olderCursor !== null,
  };
}
