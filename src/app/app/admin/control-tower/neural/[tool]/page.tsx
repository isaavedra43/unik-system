import { notFound } from 'next/navigation';
import { requireAnyPermission, type CurrentUser } from '@/modules/auth/authorization';
import { CONTROL_TOWER_PERMISSION } from '@/modules/control-tower/control-tower-service';
import { maskedFieldsFor } from '@/modules/control-tower/graph-mask';
import {
  queryOperationalGraph,
  type GraphRef,
  type OperationalGraph,
} from '@/modules/control-tower/graph-service';
import {
  DEFAULT_PERSPECTIVE_KEY,
  GRAPH_NODE_TYPE_LABELS,
  MAX_GRAPH_DEPTH,
  clampDepth,
  getPerspective,
  listPerspectivesFor,
} from '@/modules/control-tower/perspectives';
import {
  getProjectionStatus,
  listCauses,
  listHandoffs,
  listStepMetrics,
  listVariants,
  type CausesView,
  type HandoffsView,
  type ProjectionStatusRow,
  type StepMetricsView,
  type VariantsView,
} from '@/modules/control-tower/projections-service';
import { listGraphScenes, type GraphScene } from '@/modules/control-tower/scenes-service';
import {
  APPLY_CASE_LIMIT,
  simulateBlueprint,
  simulateCaseById,
  type CaseSimulation,
} from '@/modules/control-tower/simulation';
import { CaseReplay } from '@/components/control-tower/neural/CaseReplay';
import { GraphExplorer } from '@/components/control-tower/neural/GraphExplorer';
import { NeuralShell } from '@/components/control-tower/neural/NeuralShell';
import {
  isNeuralTool,
  parseRange,
  type NeuralTool,
} from '@/components/control-tower/neural/neural-model';
import { buildProcessView } from '@/components/control-tower/neural/process-model';
import { ProcessViewer } from '@/components/control-tower/neural/ProcessViewer';
import { SimulationPanel } from '@/components/control-tower/neural/SimulationPanel';
import { VariantExplorer } from '@/components/control-tower/neural/VariantExplorer';
import {
  defaultVersionId,
  listProcessVersions,
  listRecentCases,
  listSimulationCases,
  loadProcessDefinition,
  loadReplayData,
} from '../_neural-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Una herramienta de UNIK Neural Operations (plan 7.8):
 * `procesos | variantes | grafo | replay | simulacion`.
 *
 * Server Component: carga lo que hace falta y se lo entrega ya serializado al
 * componente de cliente, que es quien monta React Flow con `dynamic()`. Cada
 * lectura va dentro de `safe()`: si una proyección todavía no existe (su tabla
 * sin migrar, el job sin correr), la herramienta lo dice en vez de tirar la
 * página entera.
 */

type SearchParams = Record<string, string | string[] | undefined>;

function flatten(params: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string' && first.trim()) out[key] = first.trim();
  }
  return out;
}

/** Una lectura que falla no tira la página: se registra y se devuelve el respaldo. */
async function safe<T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    console.error(
      JSON.stringify({
        component: 'neural-ops-page',
        event: 'load_failed',
        source: label,
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return fallback;
  }
}

const EMPTY_VARIANTS: VariantsView = {
  processKey: 'sales_fulfillment',
  from: '',
  to: '',
  cases: 0,
  conformantPct: 0,
  reworkPct: 0,
  variants: [],
  nonConformant: [],
  truncated: false,
};

const EMPTY_STEP_METRICS: StepMetricsView = {
  from: '',
  to: '',
  steps: [],
  bottlenecks: [],
  daily: [],
};

const EMPTY_CAUSES: CausesView = { from: '', to: '', causes: [], byType: [] };

function emptyHandoffs(kind: HandoffsView['kind']): HandoffsView {
  return { from: '', to: '', kind, cells: [], areas: [], total: 0, expired: 0 };
}

function handoffKindOf(value: string | undefined): HandoffsView['kind'] {
  return value === 'request' || value === 'workitem' ? value : 'all';
}

export default async function NeuralToolPage({
  params,
  searchParams,
}: {
  params: Promise<{ tool: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { tool } = await params;
  if (!isNeuralTool(tool)) notFound();
  const user = await requireAnyPermission([CONTROL_TOWER_PERMISSION]);
  const query = flatten(await searchParams);
  const now = new Date();

  const projections = await safe<ProjectionStatusRow[]>('projections', [], () =>
    getProjectionStatus(user, { now })
  );

  const content = await renderTool(tool as NeuralTool, { user, query, now });

  return (
    <NeuralShell tool={tool as NeuralTool} projections={projections}>
      {content}
    </NeuralShell>
  );
}

interface ToolContext {
  user: CurrentUser;
  query: Record<string, string>;
  now: Date;
}

async function renderTool(tool: NeuralTool, ctx: ToolContext) {
  switch (tool) {
    case 'procesos':
      return processesTool(ctx);
    case 'variantes':
      return variantsTool(ctx);
    case 'grafo':
      return graphTool(ctx);
    case 'replay':
      return replayTool(ctx);
    case 'simulacion':
      return simulationTool(ctx);
    default:
      return notFound();
  }
}

// ---------------------------------------------------------------------------
// a) Visor de procesos
// ---------------------------------------------------------------------------

async function processesTool({ user, query, now }: ToolContext) {
  const range = parseRange(
    { desde: query.desde ?? null, hasta: query.hasta ?? null, rango: query.rango ?? null },
    now
  );
  const versions = await safe('process-versions', [], () => listProcessVersions(user));
  const versionId = defaultVersionId(versions, query.proceso ?? null);
  const definition = await safe('process-definition', null, () =>
    loadProcessDefinition(user, versionId)
  );
  const metrics = await safe<StepMetricsView>('step-metrics', EMPTY_STEP_METRICS, () =>
    listStepMetrics(
      user,
      {
        processKey: definition?.processKey ?? null,
        from: new Date(`${range.from}T00:00:00.000Z`),
        to: new Date(`${range.to}T00:00:00.000Z`),
      },
      { now }
    )
  );

  const view = definition?.layout
    ? buildProcessView({ layout: definition.layout, metrics: metrics.steps })
    : null;

  return (
    <ProcessViewer
      versions={versions}
      selectedVersionId={versionId}
      view={view}
      cycle={definition?.cycle ?? null}
      range={{ from: range.from, to: range.to }}
      rangePreset={range.presetKey}
    />
  );
}

// ---------------------------------------------------------------------------
// b) Explorador de variantes
// ---------------------------------------------------------------------------

async function variantsTool({ user, query, now }: ToolContext) {
  const range = parseRange(
    { desde: query.desde ?? null, hasta: query.hasta ?? null, rango: query.rango ?? null },
    now
  );
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const to = new Date(`${range.to}T00:00:00.000Z`);
  const areaKey = query.area ?? null;
  const handoffKind = handoffKindOf(query.traspaso);
  const causeType = query.causa ?? null;

  const versions = await safe('process-versions', [], () => listProcessVersions(user));
  const versionId = defaultVersionId(versions, query.proceso ?? null);
  const definition = await safe('process-definition', null, () =>
    loadProcessDefinition(user, versionId)
  );
  const processKey = definition?.processKey ?? null;

  const [variants, stepMetrics, handoffs, causes] = await Promise.all([
    safe<VariantsView>('variants', EMPTY_VARIANTS, () =>
      listVariants(user, { processKey, from, to }, { now })
    ),
    safe<StepMetricsView>('step-metrics', EMPTY_STEP_METRICS, () =>
      listStepMetrics(user, { processKey, areaKey, from, to }, { now })
    ),
    safe<HandoffsView>('handoffs', emptyHandoffs(handoffKind), () =>
      listHandoffs(user, { kind: handoffKind, from, to }, { now })
    ),
    safe<CausesView>('causes', EMPTY_CAUSES, () =>
      listCauses(user, { causeType, from, to }, { now })
    ),
  ]);

  return (
    <VariantExplorer
      variants={variants}
      stepMetrics={stepMetrics}
      handoffs={handoffs}
      causes={causes}
      layout={definition?.layout ?? null}
      cycle={definition?.cycle ?? null}
      versions={versions}
      selectedVersionId={versionId}
      range={{ from: range.from, to: range.to }}
      rangePreset={range.presetKey}
      areaKey={areaKey}
      handoffKind={handoffKind}
      causeType={causeType}
    />
  );
}

// ---------------------------------------------------------------------------
// c) Explorador del grafo
// ---------------------------------------------------------------------------

async function graphTool({ user, query, now }: ToolContext) {
  const viewer = {
    permissionKeys: user.permissionKeys,
    isSuperAdmin: user.isSuperAdmin === true,
  };
  const available = listPerspectivesFor(viewer);
  const requested = getPerspective(query.perspectiva ?? null);
  const perspective =
    requested && available.some((entry) => entry.key === requested.key)
      ? requested
      : (available.find((entry) => entry.key === DEFAULT_PERSPECTIVE_KEY) ?? available[0] ?? null);

  const scenes = await safe<GraphScene[]>('scenes', [], () =>
    listGraphScenes(user, { perspectiveKey: perspective?.key ?? null })
  );

  const scene = query.escena ? (scenes.find((entry) => entry.id === query.escena) ?? null) : null;

  const roots: GraphRef[] = scene
    ? scene.roots
    : query.tipo && query.raiz
      ? [{ type: query.tipo, id: query.raiz }]
      : [];

  // Sin perspectiva disponible no hay recorrido; la profundidad sólo alimenta el
  // selector, así que basta con la del sistema (1…3).
  const depth = perspective
    ? clampDepth(query.profundidad ? Number(query.profundidad) : null, perspective)
    : 2;

  const graph =
    perspective && roots.length > 0
      ? await safe<OperationalGraph | null>('graph', null, () =>
          queryOperationalGraph(user, {
            perspectiveKey: perspective.key,
            roots,
            depth,
            ...(scene?.at ? { at: new Date(scene.at) } : {}),
          })
        )
      : null;

  return (
    <GraphExplorer
      perspectives={available.map((entry) => ({
        key: entry.key,
        label: entry.label,
        description: entry.description,
        rootTypes: entry.rootTypes,
        nodeTypes: entry.nodeTypes,
        relations: entry.relations,
        defaultDepth: entry.defaultDepth,
      }))}
      perspectiveKey={perspective?.key ?? ''}
      initialGraph={graph}
      scenes={scenes}
      maskedFields={maskedFieldsFor(viewer)}
      initialRoots={roots}
      initialDepth={depth}
      initialSceneId={scene?.id ?? null}
      maxDepth={MAX_GRAPH_DEPTH}
      nodeTypeLabels={GRAPH_NODE_TYPE_LABELS}
      nowIso={now.toISOString()}
    />
  );
}

// ---------------------------------------------------------------------------
// d) Reproducción de un expediente
// ---------------------------------------------------------------------------

async function replayTool({ user, query }: ToolContext) {
  const caseId = query.caso ?? null;
  const [cases, replay] = await Promise.all([
    safe('recent-cases', [], () => listRecentCases(user)),
    safe(
      'replay',
      {
        header: null,
        events: [],
        timeline: [],
        timestamps: [],
        stepLabels: {},
        truncated: false,
      },
      () => loadReplayData(user, caseId)
    ),
  ]);

  return (
    <CaseReplay
      cases={cases}
      caseId={caseId}
      header={replay.header}
      events={replay.events}
      timeline={replay.timeline}
      timestamps={replay.timestamps}
      stepLabels={replay.stepLabels}
      initialAt={query.at ?? null}
      truncated={replay.truncated}
    />
  );
}

// ---------------------------------------------------------------------------
// e) Simulación
// ---------------------------------------------------------------------------

async function simulationTool({ user, query, now }: ToolContext) {
  const caseId = query.caso ?? null;
  const cases = await safe('simulation-cases', [], () => listSimulationCases(user));

  let loadError: string | null = null;
  const initial = await (async (): Promise<CaseSimulation | null> => {
    try {
      return caseId
        ? await simulateCaseById(user, { caseId, scenario: {}, now })
        : await simulateBlueprint(user, { scenario: {}, now });
    } catch (error) {
      loadError =
        error instanceof Error
          ? error.message
          : 'No pudimos preparar la simulación con el proceso actual.';
      return null;
    }
  })();

  return (
    <SimulationPanel
      initial={initial}
      caseId={caseId}
      cases={cases}
      applyLimit={APPLY_CASE_LIMIT}
      loadError={loadError}
    />
  );
}
