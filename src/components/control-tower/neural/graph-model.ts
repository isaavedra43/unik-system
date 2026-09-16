/**
 * Explorador del grafo operativo: de la respuesta del servidor al lienzo
 * (plan 7.8c). Módulo PURO.
 *
 * El servidor ya acota a 2 000 nodos y enmascara los campos sensibles; aquí se
 * decide QUÉ SE DIBUJA (≤500 nodos: más que eso React Flow deja de ser útil y
 * hay que decirlo en pantalla, no esconderlo), dónde se coloca cada nodo y qué
 * muestra el inspector.
 */

import { maskNotice } from '@/modules/control-tower/graph-mask';
import type { GraphNode } from '@/modules/control-tower/graph-mask';
import type {
  GraphEdge,
  GraphNodeAtDepth,
  GraphRef,
  OperationalGraph,
} from '@/modules/control-tower/graph-service';
import { areaLabel, areaTone, formatDateTime } from './neural-model';
import type { ChartTone } from '@/components/patterns/dashboard/chart-theme';

/** Tope de nodos DIBUJADOS (el del servidor es 2 000). */
export const GRAPH_RENDER_LIMIT = 500;

/** Separación de la rejilla por profundidad. */
const COLUMN_WIDTH = 280;
const ROW_HEIGHT = 96;

export interface GraphNodePosition {
  x: number;
  y: number;
}

export interface GraphFlowNode {
  key: string;
  id: string;
  type: string;
  typeLabel: string;
  label: string;
  sublabel: string | null;
  status: string | null;
  areaKey: string | null;
  areaLabel: string;
  tone: ChartTone;
  depth: number;
  root: boolean;
  href: string | null;
  masked: string[];
  position: GraphNodePosition;
}

export interface GraphFlowEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  relation: string;
}

export interface GraphView {
  nodes: GraphFlowNode[];
  edges: GraphFlowEdge[];
  /** Nodos que llegaron del servidor pero no se dibujan. */
  hiddenNodes: number;
  /** Aristas descartadas porque alguno de sus extremos no se dibuja. */
  hiddenEdges: number;
  /** El servidor llegó a su propio tope: hay más red de la que mandó. */
  truncated: boolean;
  /** Frase en español cuando algo no se está mostrando; `null` si se ve todo. */
  notice: string | null;
  /** Tipos de nodo presentes, con su conteo (para el filtro y la leyenda). */
  typeCounts: Array<{ type: string; label: string; count: number }>;
}

function nodeSortKey(node: GraphNodeAtDepth): string {
  const rootRank = node.root ? '0' : '1';
  return `${String(node.depth).padStart(3, '0')}-${rootRank}-${node.label ?? ''}-${node.key}`;
}

/** Posiciones por profundidad: una columna por nivel, centrada verticalmente. */
export function layoutGraphNodes(
  nodes: readonly GraphNodeAtDepth[],
  saved: Record<string, GraphNodePosition> = {}
): Map<string, GraphNodePosition> {
  const byDepth = new Map<number, GraphNodeAtDepth[]>();
  for (const node of nodes) {
    const list = byDepth.get(node.depth) ?? [];
    list.push(node);
    byDepth.set(node.depth, list);
  }
  const tallest = Math.max(1, ...[...byDepth.values()].map((list) => list.length));
  const positions = new Map<string, GraphNodePosition>();
  for (const [depth, list] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...list].sort((a, b) => nodeSortKey(a).localeCompare(nodeSortKey(b)));
    const offset = ((tallest - ordered.length) * ROW_HEIGHT) / 2;
    ordered.forEach((node, index) => {
      const savedPosition = saved[node.key];
      positions.set(
        node.key,
        savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)
          ? { x: savedPosition.x, y: savedPosition.y }
          : { x: depth * COLUMN_WIDTH, y: offset + index * ROW_HEIGHT }
      );
    });
  }
  return positions;
}

export interface BuildGraphViewOptions {
  limit?: number;
  /** Posiciones guardadas en la escena (`layout.positions`). */
  positions?: Record<string, GraphNodePosition>;
  /** Tipos de nodo que la persona dejó visibles (vacío = todos). */
  visibleTypes?: readonly string[];
}

/**
 * Recorta a lo dibujable conservando lo más cercano a las raíces: si hay que
 * dejar nodos fuera, se dejan los más lejanos, no los del centro de la historia.
 */
export function buildGraphView(
  graph: OperationalGraph | null,
  options: BuildGraphViewOptions = {}
): GraphView {
  const empty: GraphView = {
    nodes: [],
    edges: [],
    hiddenNodes: 0,
    hiddenEdges: 0,
    truncated: false,
    notice: null,
    typeCounts: [],
  };
  if (!graph) return empty;

  const visibleTypes = new Set((options.visibleTypes ?? []).filter(Boolean));
  const candidates = graph.nodes.filter(
    (node) => node.root || visibleTypes.size === 0 || visibleTypes.has(node.type)
  );

  const typeCounts = new Map<string, { type: string; label: string; count: number }>();
  for (const node of graph.nodes) {
    const current = typeCounts.get(node.type);
    if (current) current.count += 1;
    else typeCounts.set(node.type, { type: node.type, label: node.typeLabel, count: 1 });
  }

  const limit = Math.max(1, Math.min(options.limit ?? GRAPH_RENDER_LIMIT, GRAPH_RENDER_LIMIT));
  const sorted = [...candidates].sort((a, b) => nodeSortKey(a).localeCompare(nodeSortKey(b)));
  const kept = sorted.slice(0, limit);
  const keptKeys = new Set(kept.map((node) => node.key));
  const positions = layoutGraphNodes(kept, options.positions ?? {});

  const nodes: GraphFlowNode[] = kept.map((node) => ({
    key: node.key,
    id: node.id,
    type: node.type,
    typeLabel: node.typeLabel,
    label: node.label,
    sublabel: node.sublabel,
    status: node.status,
    areaKey: node.areaKey,
    areaLabel: areaLabel(node.areaKey),
    tone: areaTone(node.areaKey),
    depth: node.depth,
    root: node.root,
    href: node.href,
    masked: node.masked,
    position: positions.get(node.key) ?? { x: 0, y: 0 },
  }));

  const edges: GraphFlowEdge[] = [];
  let hiddenEdges = 0;
  for (const edge of graph.edges) {
    if (!keptKeys.has(edge.fromKey) || !keptKeys.has(edge.toKey)) {
      hiddenEdges += 1;
      continue;
    }
    edges.push({
      id: edge.key,
      source: edge.fromKey,
      target: edge.toKey,
      label: edge.relationLabel,
      relation: edge.relation,
    });
  }

  const hiddenNodes = graph.nodes.length - kept.length;
  return {
    nodes,
    edges,
    hiddenNodes,
    hiddenEdges,
    truncated: graph.truncated,
    notice: graphNotice({ hiddenNodes, hiddenEdges, truncated: graph.truncated, limit }),
    typeCounts: [...typeCounts.values()].sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label)
    ),
  };
}

function graphNotice(input: {
  hiddenNodes: number;
  hiddenEdges: number;
  truncated: boolean;
  limit: number;
}): string | null {
  const parts: string[] = [];
  if (input.hiddenNodes > 0) {
    parts.push(
      `Se dibujan ${input.limit} nodos: ${input.hiddenNodes.toLocaleString('es-MX')} quedaron fuera del lienzo`
    );
  }
  if (input.hiddenEdges > 0 && input.hiddenNodes > 0) {
    parts.push(`${input.hiddenEdges.toLocaleString('es-MX')} relaciones no se ven`);
  }
  if (input.truncated) {
    parts.push('el servidor alcanzó su tope: acota la perspectiva, la profundidad o el instante');
  }
  return parts.length > 0 ? `${parts.join(' · ')}.` : null;
}

/**
 * Une el resultado de "expandir" con lo que ya estaba dibujado, conservando la
 * profundidad MENOR de cada nodo (la distancia real a una raíz) y sin duplicar
 * aristas. Así el lienzo crece por partes en vez de pedir 2 000 nodos de golpe.
 */
export function mergeGraphs(
  base: OperationalGraph | null,
  addition: OperationalGraph | null
): OperationalGraph | null {
  if (!base) return addition;
  if (!addition) return base;
  const nodes = new Map<string, GraphNodeAtDepth>(base.nodes.map((node) => [node.key, node]));
  for (const node of addition.nodes) {
    const current = nodes.get(node.key);
    if (!current) {
      nodes.set(node.key, node);
      continue;
    }
    nodes.set(node.key, {
      ...current,
      depth: Math.min(current.depth, node.depth),
      root: current.root || node.root,
    });
  }
  const edges = new Map<string, GraphEdge>(base.edges.map((edge) => [edge.key, edge]));
  for (const edge of addition.edges) if (!edges.has(edge.key)) edges.set(edge.key, edge);
  return {
    ...base,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    depth: Math.max(base.depth, addition.depth),
    truncated: base.truncated || addition.truncated,
    computedAt: addition.computedAt,
  };
}

export interface InspectorField {
  key: string;
  label: string;
  value: string;
}

/** Campos del inspector de un nodo; los enmascarados se dicen, no se omiten. */
export function inspectorFields(node: GraphNode): InspectorField[] {
  const fields: InspectorField[] = [{ key: 'type', label: 'Tipo', value: node.typeLabel }];
  if (node.sublabel) fields.push({ key: 'sublabel', label: 'Detalle', value: node.sublabel });
  if (node.status) fields.push({ key: 'status', label: 'Estado', value: node.status });
  if (node.areaKey) fields.push({ key: 'area', label: 'Área', value: areaLabel(node.areaKey) });
  if (node.at) fields.push({ key: 'at', label: 'Fecha', value: formatDateTime(node.at) });
  if (node.amount) {
    fields.push({
      key: 'amount',
      label: 'Importe',
      value: node.currency ? `${node.amount} ${node.currency}` : node.amount,
    });
  }
  if (node.contact) {
    const contact = [node.contact.name, node.contact.phone, node.contact.email]
      .filter((value): value is string => Boolean(value))
      .join(' · ');
    if (contact) fields.push({ key: 'contact', label: 'Contacto', value: contact });
  }
  if (node.aiCostUsd !== null && node.aiCostUsd !== undefined) {
    fields.push({
      key: 'aiCost',
      label: 'Costo de IA',
      value: `${node.aiCostUsd.toLocaleString('es-MX', { maximumFractionDigits: 4 })} USD`,
    });
  }
  const notice = maskNotice(node.masked);
  if (notice) fields.push({ key: 'masked', label: 'Oculto', value: notice });
  return fields;
}

/** Vecinos dibujados de un nodo, con la relación en español. */
export function neighboursOf(
  view: GraphView,
  nodeKey: string
): Array<{ node: GraphFlowNode; relation: string; direction: 'out' | 'in' }> {
  const byKey = new Map(view.nodes.map((node) => [node.key, node]));
  const out: Array<{ node: GraphFlowNode; relation: string; direction: 'out' | 'in' }> = [];
  for (const edge of view.edges) {
    if (edge.source === nodeKey) {
      const node = byKey.get(edge.target);
      if (node) out.push({ node, relation: edge.label, direction: 'out' });
    } else if (edge.target === nodeKey) {
      const node = byKey.get(edge.source);
      if (node) out.push({ node, relation: edge.label, direction: 'in' });
    }
  }
  return out;
}

/** El expediente al que pertenece el nodo seleccionado, si lo hay (para "Abrir en replay"). */
export function replayCaseIdOf(node: GraphFlowNode | null, view: GraphView): string | null {
  if (!node) return null;
  if (node.type === 'operational_case') return node.id;
  const related = neighboursOf(view, node.key).find(
    (entry) => entry.node.type === 'operational_case'
  );
  return related ? related.node.id : null;
}

export interface SceneFilters {
  depth: number;
  relations: string[];
  nodeTypes: string[];
}

export interface SceneLayout {
  positions: Record<string, GraphNodePosition>;
  viewport?: { x: number; y: number; zoom: number };
}

/** Filtros guardados en una escena (`filters` es JSON libre: se lee con cuidado). */
export function parseSceneFilters(value: unknown, fallbackDepth: number): SceneFilters {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const depth =
    typeof raw.depth === 'number' && Number.isFinite(raw.depth) ? raw.depth : fallbackDepth;
  const relations = Array.isArray(raw.relations)
    ? raw.relations.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const nodeTypes = Array.isArray(raw.nodeTypes)
    ? raw.nodeTypes.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { depth: Math.min(Math.max(Math.round(depth), 1), 3), relations, nodeTypes };
}

/** Posiciones guardadas en una escena. */
export function parseSceneLayout(value: unknown): Record<string, GraphNodePosition> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = (value as Record<string, unknown>).positions;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, GraphNodePosition> = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const point = entry as Record<string, unknown>;
    if (typeof point.x !== 'number' || typeof point.y !== 'number') continue;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    out[key] = { x: point.x, y: point.y };
  }
  return out;
}

/** Raíces limpias para guardar o consultar (sin duplicados, tope del servidor). */
export function cleanRoots(refs: readonly GraphRef[], limit = 20): GraphRef[] {
  const seen = new Set<string>();
  const out: GraphRef[] = [];
  for (const ref of refs) {
    const type = typeof ref?.type === 'string' ? ref.type.trim() : '';
    const id = typeof ref?.id === 'string' ? ref.id.trim() : '';
    if (!type || !id) continue;
    const key = `${type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id });
    if (out.length >= limit) break;
  }
  return out;
}

/** `tipo:id` de un nodo (la llave que usa todo el lienzo). */
export function refKey(ref: GraphRef): string {
  return `${ref.type}:${ref.id}`;
}
