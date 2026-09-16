'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ExternalLink, History, Maximize2, Network, RefreshCw } from 'lucide-react';
import { EmptyState } from '@/components/ui/composite';
import { Alert, Button, Input, Select, Spinner } from '@/components/ui/primitives';
import { useIsMobile } from '@/hooks/use-is-mobile';
import type { GraphRef, OperationalGraph } from '@/modules/control-tower/graph-service';
import type { GraphScene } from '@/modules/control-tower/scenes-service';
import {
  buildGraphView,
  cleanRoots,
  GRAPH_RENDER_LIMIT,
  inspectorFields,
  mergeGraphs,
  neighboursOf,
  parseSceneFilters,
  parseSceneLayout,
  refKey,
  replayCaseIdOf,
  type GraphNodePosition,
} from './graph-model';
import { GraphNode } from './GraphNode';
import { formatDateTime, formatDay, neuralHref } from './neural-model';
import { SceneBar } from './SceneBar';
import { TimeSlider } from './TimeSlider';

/** React Flow entra al bundle SÓLO aquí (plan 7.8: `dynamic()` en estas rutas). */
const GraphCanvas = dynamic(() => import('./GraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="neural-canvas-loading" role="status">
      <Network className="h-5 w-5" aria-hidden="true" />
      Cargando la red operativa…
    </div>
  ),
});

export interface PerspectiveOption {
  key: string;
  label: string;
  description: string;
  rootTypes: readonly string[];
  nodeTypes: readonly string[];
  relations: readonly string[];
  defaultDepth: number;
}

export interface GraphExplorerProps {
  perspectives: readonly PerspectiveOption[];
  perspectiveKey: string;
  initialGraph: OperationalGraph | null;
  scenes: readonly GraphScene[];
  /** Tipos de nodo que este visor NO puede ver completos (importe, contacto…). */
  maskedFields: readonly string[];
  initialRoots: readonly GraphRef[];
  initialDepth: number;
  /** Escena abierta por enlace (`?escena=`). */
  initialSceneId: string | null;
  maxDepth: number;
  /** Etiquetas de tipo de nodo, para el selector de punto de partida. */
  nodeTypeLabels: Readonly<Record<string, string>>;
  /** Ahora del servidor: el deslizador cuenta días hacia atrás desde aquí. */
  nowIso: string;
}

const TIME_WINDOW_DAYS = 180;
const DAY_MS = 86_400_000;

interface FetchState {
  loading: boolean;
  error: string | null;
}

/**
 * Explorador del grafo operativo (plan 7.8c).
 *
 * Qué hace y qué NO: dibuja lo que el servidor deja ver (perspectiva + máscara
 * por campo), acota a 500 nodos dibujados y lo dice, carga vecinos de un nodo a
 * petición ("expandir"), fija el instante con el deslizador y guarda escenas.
 * No escribe nada del negocio: es una lectura.
 *
 * En ≤768 px no se monta el lienzo: la red se lee como lista de nodos.
 */
export function GraphExplorer({
  perspectives,
  perspectiveKey,
  initialGraph,
  scenes,
  maskedFields,
  initialRoots,
  initialDepth,
  initialSceneId,
  maxDepth,
  nodeTypeLabels,
  nowIso,
}: GraphExplorerProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [, startTransition] = useTransition();

  const [graph, setGraph] = useState<OperationalGraph | null>(initialGraph);
  const [state, setState] = useState<FetchState>({ loading: false, error: null });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, GraphNodePosition>>({});
  const [visibleTypes, setVisibleTypes] = useState<string[]>([]);
  const [depth, setDepth] = useState(initialDepth);
  const [dayOffset, setDayOffset] = useState(0);
  const [rootType, setRootType] = useState(initialRoots[0]?.type ?? '');
  const [rootId, setRootId] = useState('');
  const [roots, setRoots] = useState<GraphRef[]>(cleanRoots(initialRoots));
  const [sceneList, setSceneList] = useState<GraphScene[]>([...scenes]);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(initialSceneId);
  const [sceneBusy, setSceneBusy] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);

  useEffect(() => {
    setGraph(initialGraph);
  }, [initialGraph]);

  useEffect(() => {
    setSceneList([...scenes]);
  }, [scenes]);

  const perspective = useMemo(
    () => perspectives.find((entry) => entry.key === perspectiveKey) ?? perspectives[0] ?? null,
    [perspectives, perspectiveKey]
  );

  const view = useMemo(
    () => buildGraphView(graph, { positions, visibleTypes }),
    [graph, positions, visibleTypes]
  );

  const selectedNode = view.nodes.find((node) => node.key === selectedKey) ?? null;
  const selectedRaw = graph?.nodes.find((node) => node.key === selectedKey) ?? null;
  const neighbours = selectedKey ? neighboursOf(view, selectedKey) : [];
  const replayCaseId = replayCaseIdOf(selectedNode, view);

  const at = useMemo(
    () =>
      dayOffset === 0 ? null : new Date(Date.parse(nowIso) + dayOffset * DAY_MS).toISOString(),
    [dayOffset, nowIso]
  );

  const runQuery = useCallback(
    async (input: {
      roots: GraphRef[];
      depth: number;
      at: string | null;
      perspectiveKey: string;
    }) => {
      if (input.roots.length === 0) {
        setGraph(null);
        return;
      }
      setState({ loading: true, error: null });
      try {
        const response = await fetch('/app/admin/control-tower/api/graph', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            perspectiveKey: input.perspectiveKey,
            roots: input.roots,
            depth: input.depth,
            at: input.at,
          }),
        });
        const payload = (await response.json()) as { graph?: OperationalGraph; error?: string };
        if (!response.ok) {
          setState({ loading: false, error: payload.error ?? 'No pudimos cargar la red' });
          return;
        }
        setGraph(payload.graph ?? null);
        setSelectedKey(null);
        setState({ loading: false, error: null });
      } catch {
        setState({ loading: false, error: 'No pudimos cargar la red. Revisa tu conexión.' });
      }
    },
    []
  );

  const expand = useCallback(
    async (key: string) => {
      const node = view.nodes.find((entry) => entry.key === key);
      if (!node) return;
      setState({ loading: true, error: null });
      try {
        const response = await fetch('/app/admin/control-tower/api/graph/expand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            perspectiveKey,
            node: { type: node.type, id: node.id },
            at,
          }),
        });
        const payload = (await response.json()) as { graph?: OperationalGraph; error?: string };
        if (!response.ok) {
          setState({ loading: false, error: payload.error ?? 'No pudimos expandir ese nodo' });
          return;
        }
        setGraph((current) => mergeGraphs(current, payload.graph ?? null));
        setState({ loading: false, error: null });
      } catch {
        setState({ loading: false, error: 'No pudimos expandir ese nodo. Revisa tu conexión.' });
      }
    },
    [at, perspectiveKey, view.nodes]
  );

  const addRoot = () => {
    const next = cleanRoots([...roots, { type: rootType, id: rootId }]);
    if (next.length === roots.length) return;
    setRoots(next);
    setActiveSceneId(null);
    void runQuery({ roots: next, depth, at, perspectiveKey });
  };

  const removeRoot = (ref: GraphRef) => {
    const next = roots.filter((entry) => refKey(entry) !== refKey(ref));
    setRoots(next);
    setActiveSceneId(null);
    void runQuery({ roots: next, depth, at, perspectiveKey });
  };

  const openScene = (scene: GraphScene) => {
    const filters = parseSceneFilters(scene.filters, perspective?.defaultDepth ?? 2);
    const layout = parseSceneLayout(scene.layout);
    setActiveSceneId(scene.id);
    setPositions(layout);
    setVisibleTypes(filters.nodeTypes);
    setDepth(filters.depth);
    setRoots(scene.roots);
    const sceneAt = scene.at;
    setDayOffset(sceneAt ? Math.round((Date.parse(sceneAt) - Date.parse(nowIso)) / DAY_MS) : 0);
    if (scene.perspectiveKey !== perspectiveKey) {
      startTransition(() => {
        router.push(
          neuralHref('grafo', {
            perspectiva: scene.perspectiveKey,
            escena: scene.id,
          })
        );
      });
      return;
    }
    void runQuery({
      roots: scene.roots,
      depth: filters.depth,
      at: sceneAt,
      perspectiveKey: scene.perspectiveKey,
    });
  };

  const scenePayload = () => ({
    perspectiveKey,
    roots,
    depth,
    filters: { depth, nodeTypes: visibleTypes, relations: [] },
    layout: { positions },
    at,
  });

  const createScene = async (input: { name: string; shared: boolean }) => {
    setSceneBusy(true);
    setSceneError(null);
    try {
      const response = await fetch('/app/admin/control-tower/api/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...scenePayload(), name: input.name, shared: input.shared }),
      });
      const payload = (await response.json()) as { scene?: GraphScene; error?: string };
      if (!response.ok || !payload.scene) {
        setSceneError(payload.error ?? 'No pudimos guardar la escena');
        return;
      }
      setSceneList((current) => [payload.scene as GraphScene, ...current]);
      setActiveSceneId(payload.scene.id);
    } catch {
      setSceneError('No pudimos guardar la escena. Revisa tu conexión.');
    } finally {
      setSceneBusy(false);
    }
  };

  const updateScene = async (scene: GraphScene) => {
    setSceneBusy(true);
    setSceneError(null);
    try {
      const response = await fetch(`/app/admin/control-tower/api/scenes/${scene.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...scenePayload(), expectedVersion: scene.version }),
      });
      const payload = (await response.json()) as { scene?: GraphScene; error?: string };
      if (!response.ok || !payload.scene) {
        setSceneError(payload.error ?? 'No pudimos actualizar la escena');
        return;
      }
      const saved = payload.scene;
      setSceneList((current) => current.map((entry) => (entry.id === saved.id ? saved : entry)));
    } catch {
      setSceneError('No pudimos actualizar la escena. Revisa tu conexión.');
    } finally {
      setSceneBusy(false);
    }
  };

  const deleteScene = async (scene: GraphScene) => {
    setSceneBusy(true);
    setSceneError(null);
    try {
      const response = await fetch(`/app/admin/control-tower/api/scenes/${scene.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        setSceneError(payload.error ?? 'No pudimos borrar la escena');
        return;
      }
      setSceneList((current) => current.filter((entry) => entry.id !== scene.id));
      setActiveSceneId((current) => (current === scene.id ? null : current));
    } catch {
      setSceneError('No pudimos borrar la escena. Revisa tu conexión.');
    } finally {
      setSceneBusy(false);
    }
  };

  const toggleType = (type: string) => {
    setVisibleTypes((current) =>
      current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type]
    );
  };

  if (perspectives.length === 0) {
    return (
      <EmptyState
        icon="shield"
        title="No tienes ninguna perspectiva disponible"
        message="Las perspectivas del grafo se abren con el permiso del área correspondiente. Pide el permiso de la operación que necesitas ver."
      />
    );
  }

  return (
    <div className="neural-shell">
      <div className="neural-toolbar">
        <div className="neural-toolbar-field">
          <label htmlFor="neural-graph-perspective">Perspectiva</label>
          <Select
            id="neural-graph-perspective"
            value={perspectiveKey}
            onChange={(event) =>
              startTransition(() =>
                router.push(neuralHref('grafo', { perspectiva: event.target.value }))
              )
            }
          >
            {perspectives.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="neural-toolbar-field">
          <label htmlFor="neural-graph-root-type">Tipo del punto de partida</label>
          <Select
            id="neural-graph-root-type"
            value={rootType}
            onChange={(event) => setRootType(event.target.value)}
          >
            <option value="">Elige un tipo…</option>
            {(perspective?.rootTypes ?? []).map((type) => (
              <option key={type} value={type}>
                {nodeTypeLabels[type] ?? type}
              </option>
            ))}
          </Select>
        </div>

        <div className="neural-toolbar-field">
          <label htmlFor="neural-graph-root-id">Identificador</label>
          <Input
            id="neural-graph-root-id"
            value={rootId}
            onChange={(event) => setRootId(event.target.value)}
            placeholder="Pega el id del expediente, la orden…"
            maxLength={120}
          />
        </div>

        <div className="neural-toolbar-field">
          <label htmlFor="neural-graph-depth">Profundidad</label>
          <Select
            id="neural-graph-depth"
            value={String(depth)}
            onChange={(event) => {
              const next = Number(event.target.value);
              setDepth(next);
              void runQuery({ roots, depth: next, at, perspectiveKey });
            }}
          >
            {Array.from({ length: maxDepth }, (_, index) => index + 1).map((value) => (
              <option key={value} value={value}>
                {value} {value === 1 ? 'salto' : 'saltos'}
              </option>
            ))}
          </Select>
        </div>

        <div className="neural-toolbar-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={addRoot}
            disabled={!rootType || !rootId.trim() || state.loading}
          >
            Agregar punto de partida
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void runQuery({ roots, depth, at, perspectiveKey })}
            disabled={roots.length === 0 || state.loading}
            icon={<RefreshCw className="h-4 w-4" />}
          >
            Actualizar
          </Button>
        </div>

        {perspective ? <p className="neural-toolbar-note">{perspective.description}</p> : null}
      </div>

      <TimeSlider
        label="Instante de la red"
        value={dayOffset}
        min={-TIME_WINDOW_DAYS}
        max={0}
        onChange={(value) => {
          setDayOffset(value);
          const nextAt =
            value === 0 ? null : new Date(Date.parse(nowIso) + value * DAY_MS).toISOString();
          void runQuery({ roots, depth, at: nextAt, perspectiveKey });
        }}
        formatValue={(value) =>
          value === 0 ? 'Ahora' : formatDay(new Date(Date.parse(nowIso) + value * DAY_MS))
        }
        minLabel={`Hace ${TIME_WINDOW_DAYS} días`}
        maxLabel="Ahora"
        description="Se dibujan las relaciones vigentes en ese momento: lo que todavía no existía, no aparece."
        disabled={roots.length === 0 || state.loading}
      />

      {roots.length > 0 ? (
        <div className="neural-chip-row" aria-label="Puntos de partida">
          {roots.map((ref) => (
            <span key={refKey(ref)} className="neural-scene-chip">
              <span className="neural-scene-chip-name">
                {nodeTypeLabels[ref.type] ?? ref.type}: {ref.id}
              </span>
              <button
                type="button"
                className="neural-row-button"
                onClick={() => removeRoot(ref)}
                aria-label={`Quitar el punto de partida ${ref.type} ${ref.id}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {maskedFields.length > 0 ? (
        <p className="neural-panel-hint">
          Ves la red completa, pero algunos campos van ocultos porque necesitan otro permiso
          (importes, datos de contacto o costo de IA). El inspector te dice cuáles.
        </p>
      ) : null}

      {roots.length === 0 ? (
        <EmptyState
          icon="search"
          title="Elige por dónde empezar"
          message="La red se recorre desde un punto de partida: un expediente, una orden de venta, una orden de compra, un viaje. Elige el tipo, pega su identificador y agrégalo."
        />
      ) : view.nodes.length === 0 && !state.loading ? (
        <EmptyState
          icon="layers"
          title="No encontramos nada conectado"
          message="Ese punto de partida no tiene relaciones dentro de esta perspectiva y este instante. Prueba con otra perspectiva, más profundidad o moviendo el deslizador hacia ahora."
        />
      ) : (
        <div className="neural-split">
          <div className="neural-shell">
            {view.notice ? (
              <p className="neural-notice" role="status">
                <Maximize2 className="h-4 w-4" aria-hidden="true" />
                <span>{view.notice}</span>
              </p>
            ) : null}

            {state.loading ? (
              <p className="neural-panel-hint" role="status">
                <Spinner /> Recorriendo la red…
              </p>
            ) : null}

            {isMobile ? (
              <ul className="neural-mini-grid" aria-label="Nodos de la red">
                {view.nodes.map((node) => (
                  <li key={node.key}>
                    <button
                      type="button"
                      className="neural-node-button"
                      onClick={() => setSelectedKey(node.key === selectedKey ? null : node.key)}
                      aria-pressed={node.key === selectedKey}
                    >
                      <GraphNode node={node} selected={node.key === selectedKey} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <GraphCanvas
                view={view}
                selectedKey={selectedKey}
                onSelect={setSelectedKey}
                onExpand={(key) => void expand(key)}
                onMove={(key, position) =>
                  setPositions((current) => ({ ...current, [key]: position }))
                }
                label={`Red operativa: ${view.nodes.length} nodos dibujados de un máximo de ${GRAPH_RENDER_LIMIT}`}
              />
            )}

            {view.typeCounts.length > 1 ? (
              <div className="neural-panel">
                <div className="neural-panel-head">
                  <h3 className="neural-panel-title">Qué se dibuja</h3>
                  {visibleTypes.length > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setVisibleTypes([])}
                    >
                      Ver todo
                    </Button>
                  ) : null}
                </div>
                <div className="neural-chip-row">
                  {view.typeCounts.map((entry) => (
                    <button
                      key={entry.type}
                      type="button"
                      className="neural-chip"
                      aria-pressed={visibleTypes.includes(entry.type)}
                      onClick={() => toggleType(entry.type)}
                    >
                      {entry.label} · {entry.count}
                    </button>
                  ))}
                </div>
                <p className="neural-panel-hint">
                  Filtrar oculta nodos del lienzo, no de la consulta. Los puntos de partida siempre
                  se ven.
                </p>
              </div>
            ) : null}
          </div>

          <aside className="neural-split-aside" aria-label="Inspector del nodo">
            <div className="neural-panel">
              <div className="neural-panel-head">
                <h3 className="neural-panel-title">
                  {selectedNode ? selectedNode.label : 'Inspector'}
                </h3>
              </div>
              {selectedNode && selectedRaw ? (
                <>
                  <dl className="neural-inspector-fields">
                    {inspectorFields(selectedRaw).map((field) => (
                      <div
                        key={field.key}
                        className={`neural-inspector-field${field.key === 'masked' ? ' neural-inspector-masked' : ''}`}
                      >
                        <dt>{field.label}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="neural-toolbar-actions">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => void expand(selectedNode.key)}
                      disabled={state.loading}
                    >
                      Expandir
                    </Button>
                    {replayCaseId ? (
                      <Link
                        className="btn btn-ghost btn-sm"
                        href={neuralHref('replay', { caso: replayCaseId, at })}
                      >
                        <History className="h-4 w-4" aria-hidden="true" /> Abrir en replay
                      </Link>
                    ) : null}
                    {selectedNode.href ? (
                      <Link className="btn btn-ghost btn-sm" href={selectedNode.href}>
                        <ExternalLink className="h-4 w-4" aria-hidden="true" /> Abrir ficha
                      </Link>
                    ) : null}
                  </div>
                  {neighbours.length > 0 ? (
                    <>
                      <p className="neural-panel-hint">Conectado con</p>
                      <ul className="neural-neighbours">
                        {neighbours.map((entry) => (
                          <li
                            key={`${entry.direction}-${entry.node.key}`}
                            className="neural-neighbour"
                          >
                            <span className="neural-neighbour-relation">
                              {entry.direction === 'out' ? '→' : '←'} {entry.relation}
                            </span>
                            <button
                              type="button"
                              className="neural-row-button"
                              onClick={() => setSelectedKey(entry.node.key)}
                            >
                              {entry.node.typeLabel}: {entry.node.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <p className="neural-panel-hint">
                      No hay vecinos dibujados. Usa «Expandir» para traer los suyos.
                    </p>
                  )}
                </>
              ) : (
                <p className="neural-panel-hint">
                  Elige un nodo del lienzo para ver sus datos, sus vecinos y abrirlo donde
                  corresponde.
                </p>
              )}
            </div>

            <SceneBar
              scenes={sceneList}
              activeSceneId={activeSceneId}
              canSave={roots.length > 0}
              busy={sceneBusy}
              error={sceneError}
              onOpen={openScene}
              onCreate={(input) => void createScene(input)}
              onUpdate={(scene) => void updateScene(scene)}
              onDelete={(scene) => void deleteScene(scene)}
            />

            {graph ? (
              <p className="neural-panel-hint">
                Red calculada al {formatDateTime(graph.computedAt)} · instante{' '}
                {formatDateTime(graph.at)}
              </p>
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}
