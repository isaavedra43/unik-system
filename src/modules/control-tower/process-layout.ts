/**
 * Acomodo del visor de procesos (plan 7.8a). Módulo PURO, sin dagre.
 *
 * Dos pasadas clásicas de dibujo de grafos por capas:
 * 1. CAPA = camino más largo desde un paso sin dependencias. Así una flecha
 *    nunca apunta hacia atrás y el proceso se lee de izquierda a derecha.
 * 2. ORDEN dentro de la capa = baricentro (promedio de la posición de sus
 *    vecinos), alternando barridos hacia adelante y hacia atrás. Reduce los
 *    cruces sin necesitar una librería.
 *
 * Un ciclo NO se acomoda: `dependsOn` describe un proceso, y un proceso con un
 * ciclo está mal definido. En vez de dibujar cualquier cosa se lanza
 * `ProcessLayoutCycleError` con el ciclo encontrado, para que la vista lo diga.
 */

export class ProcessLayoutCycleError extends Error {
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`El proceso tiene un ciclo: ${cycle.join(' → ')}`);
    this.name = 'ProcessLayoutCycleError';
    this.cycle = cycle;
  }
}

export interface LayoutStepInput {
  key: string;
  label?: string;
  areaKey?: string;
  dependsOn?: readonly string[];
}

export interface LayoutNode {
  key: string;
  label: string;
  areaKey: string | null;
  layer: number;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

export interface ProcessLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  layers: number;
  width: number;
  height: number;
  /** Dependencias que apuntan a pasos inexistentes (se ignoran como aristas). */
  missingDependencies: Array<{ step: string; dependsOn: string }>;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
  /** Barridos de baricentro (por omisión 4). */
  sweeps?: number;
}

const DEFAULTS = { nodeWidth: 220, nodeHeight: 84, gapX: 80, gapY: 28, sweeps: 4 };

interface Graph {
  keys: string[];
  successors: Map<string, string[]>;
  predecessors: Map<string, string[]>;
  edges: LayoutEdge[];
  missing: Array<{ step: string; dependsOn: string }>;
}

function buildGraph(steps: readonly LayoutStepInput[]): Graph {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const key = typeof step?.key === 'string' ? step.key.trim() : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  const successors = new Map<string, string[]>(keys.map((key) => [key, []]));
  const predecessors = new Map<string, string[]>(keys.map((key) => [key, []]));
  const edges: LayoutEdge[] = [];
  const missing: Array<{ step: string; dependsOn: string }> = [];
  const edgeSeen = new Set<string>();
  for (const step of steps) {
    const key = typeof step?.key === 'string' ? step.key.trim() : '';
    if (!key || !seen.has(key)) continue;
    for (const raw of step.dependsOn ?? []) {
      const dependency = typeof raw === 'string' ? raw.trim() : '';
      if (!dependency) continue;
      if (!seen.has(dependency)) {
        missing.push({ step: key, dependsOn: dependency });
        continue;
      }
      if (dependency === key) throw new ProcessLayoutCycleError([key, key]);
      const edgeKey = `${dependency}->${key}`;
      if (edgeSeen.has(edgeKey)) continue;
      edgeSeen.add(edgeKey);
      edges.push({ from: dependency, to: key });
      successors.get(dependency)!.push(key);
      predecessors.get(key)!.push(dependency);
    }
  }
  return { keys, successors, predecessors, edges, missing };
}

/** Ciclo (si lo hay) por búsqueda en profundidad con pila de visita. */
export function findCycle(steps: readonly LayoutStepInput[]): string[] | null {
  let graph: Graph;
  try {
    graph = buildGraph(steps);
  } catch (error) {
    if (error instanceof ProcessLayoutCycleError) return error.cycle;
    throw error;
  }
  const state = new Map<string, 0 | 1 | 2>(); // 0 sin visitar, 1 en la pila, 2 terminado
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    const current = state.get(key) ?? 0;
    if (current === 1) {
      const start = stack.indexOf(key);
      return [...stack.slice(start === -1 ? 0 : start), key];
    }
    if (current === 2) return null;
    state.set(key, 1);
    stack.push(key);
    for (const next of graph.successors.get(key) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };

  for (const key of graph.keys) {
    const cycle = visit(key);
    if (cycle) return cycle;
  }
  return null;
}

/** Capa de cada paso = camino más largo desde un paso sin dependencias. */
function longestPathLayers(graph: Graph): Map<string, number> {
  const layer = new Map<string, number>();
  const indegree = new Map<string, number>(
    graph.keys.map((key) => [key, (graph.predecessors.get(key) ?? []).length])
  );
  const queue = graph.keys.filter((key) => (indegree.get(key) ?? 0) === 0);
  for (const key of queue) layer.set(key, 0);
  let processed = 0;
  while (queue.length > 0) {
    const key = queue.shift()!;
    processed += 1;
    const base = layer.get(key) ?? 0;
    for (const next of graph.successors.get(key) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, base + 1));
      const pending = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, pending);
      if (pending === 0) queue.push(next);
    }
  }
  if (processed !== graph.keys.length) {
    const cycle = findCycle(
      graph.keys.map((key) => ({ key, dependsOn: graph.predecessors.get(key) ?? [] }))
    );
    throw new ProcessLayoutCycleError(cycle ?? ['ciclo']);
  }
  return layer;
}

function barycenter(
  order: string[],
  neighbours: Map<string, string[]>,
  positions: Map<string, number>
) {
  return order
    .map((key, index) => {
      const related = (neighbours.get(key) ?? [])
        .map((other) => positions.get(other))
        .filter((value): value is number => value !== undefined);
      const weight =
        related.length === 0
          ? index
          : related.reduce((sum, value) => sum + value, 0) / related.length;
      return { key, weight, index };
    })
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .map((entry) => entry.key);
}

/**
 * Acomoda los pasos en capas y devuelve coordenadas listas para React Flow.
 * Lanza `ProcessLayoutCycleError` si el proceso tiene un ciclo.
 */
export function layoutProcess(
  steps: readonly LayoutStepInput[],
  options: LayoutOptions = {}
): ProcessLayout {
  const config = { ...DEFAULTS, ...options };
  const graph = buildGraph(steps);
  const metaByKey = new Map(
    steps.map((step) => [
      typeof step?.key === 'string' ? step.key.trim() : '',
      { label: step?.label ?? step?.key ?? '', areaKey: step?.areaKey ?? null },
    ])
  );

  if (graph.keys.length === 0) {
    return {
      nodes: [],
      edges: [],
      layers: 0,
      width: 0,
      height: 0,
      missingDependencies: graph.missing,
    };
  }

  const layer = longestPathLayers(graph);
  const layerCount = Math.max(...graph.keys.map((key) => layer.get(key) ?? 0)) + 1;
  const byLayer: string[][] = Array.from({ length: layerCount }, () => []);
  for (const key of graph.keys) byLayer[layer.get(key) ?? 0].push(key);

  const positions = new Map<string, number>();
  byLayer.forEach((keys) => keys.forEach((key, index) => positions.set(key, index)));

  for (let sweep = 0; sweep < Math.max(0, config.sweeps); sweep += 1) {
    const forward = sweep % 2 === 0;
    const order = forward
      ? byLayer.map((keys, index) => ({ keys, index })).slice(1)
      : byLayer
          .map((keys, index) => ({ keys, index }))
          .slice(0, -1)
          .reverse();
    for (const entry of order) {
      const neighbours = forward ? graph.predecessors : graph.successors;
      const sorted = barycenter(entry.keys, neighbours, positions);
      byLayer[entry.index] = sorted;
      sorted.forEach((key, index) => positions.set(key, index));
    }
  }

  const nodes: LayoutNode[] = [];
  byLayer.forEach((keys, layerIndex) => {
    keys.forEach((key, index) => {
      const meta = metaByKey.get(key);
      nodes.push({
        key,
        label: meta?.label || key,
        areaKey: meta?.areaKey ?? null,
        layer: layerIndex,
        order: index,
        x: layerIndex * (config.nodeWidth + config.gapX),
        y: index * (config.nodeHeight + config.gapY),
        width: config.nodeWidth,
        height: config.nodeHeight,
      });
    });
  });

  const rows = Math.max(...byLayer.map((keys) => keys.length));
  return {
    nodes,
    edges: graph.edges,
    layers: layerCount,
    width: layerCount * config.nodeWidth + Math.max(0, layerCount - 1) * config.gapX,
    height: rows * config.nodeHeight + Math.max(0, rows - 1) * config.gapY,
    missingDependencies: graph.missing,
  };
}
