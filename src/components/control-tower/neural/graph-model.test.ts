import { describe, expect, it } from 'vitest';
import type {
  GraphEdge,
  GraphNodeAtDepth,
  OperationalGraph,
} from '@/modules/control-tower/graph-service';
import {
  buildGraphView,
  cleanRoots,
  GRAPH_RENDER_LIMIT,
  inspectorFields,
  layoutGraphNodes,
  mergeGraphs,
  neighboursOf,
  parseSceneFilters,
  parseSceneLayout,
  refKey,
  replayCaseIdOf,
} from './graph-model';

function node(partial: Partial<GraphNodeAtDepth> & { id: string; type: string }): GraphNodeAtDepth {
  return {
    key: `${partial.type}:${partial.id}`,
    typeLabel: partial.type,
    label: partial.id,
    sublabel: null,
    status: null,
    areaKey: null,
    at: null,
    href: null,
    amount: null,
    currency: null,
    contact: null,
    aiCostUsd: null,
    masked: [],
    depth: 0,
    root: false,
    ...partial,
  };
}

function edge(from: GraphNodeAtDepth, to: GraphNodeAtDepth, relation = 'fulfills'): GraphEdge {
  return {
    key: `${from.key}|${relation}|${to.key}`,
    fromKey: from.key,
    toKey: to.key,
    fromType: from.type,
    fromId: from.id,
    toType: to.type,
    toId: to.id,
    relation,
    relationLabel: 'cumple',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: null,
  };
}

function graph(nodes: GraphNodeAtDepth[], edges: GraphEdge[] = []): OperationalGraph {
  return {
    perspectiveKey: 'expediente',
    perspectiveLabel: 'Expediente de punta a punta',
    at: '2026-03-01T00:00:00.000Z',
    depth: 2,
    roots: [{ type: nodes[0]?.type ?? 'operational_case', id: nodes[0]?.id ?? 'c1' }],
    nodes,
    edges,
    truncated: false,
    limit: 2000,
    computedAt: '2026-03-01T00:00:00.000Z',
  };
}

describe('buildGraphView', () => {
  it('sin grafo devuelve un lienzo vacío, no truena', () => {
    const view = buildGraphView(null);
    expect(view.nodes).toEqual([]);
    expect(view.notice).toBeNull();
  });

  it('dibuja nodos y aristas y traduce el área', () => {
    const root = node({ id: 'c1', type: 'operational_case', root: true, areaKey: 'ventas' });
    const order = node({ id: 'o1', type: 'procurement_order', depth: 1, areaKey: 'compras' });
    const view = buildGraphView(graph([root, order], [edge(root, order)]));
    expect(view.nodes).toHaveLength(2);
    expect(view.edges).toHaveLength(1);
    expect(view.nodes.find((n) => n.id === 'o1')?.areaLabel).toBe('Compras');
    expect(view.hiddenNodes).toBe(0);
    expect(view.notice).toBeNull();
  });

  it('recorta a lo dibujable conservando lo más cercano a la raíz', () => {
    const root = node({ id: 'c1', type: 'operational_case', root: true });
    const near = node({ id: 'n1', type: 'work_item', depth: 1 });
    const far = node({ id: 'f1', type: 'work_item', depth: 3 });
    const view = buildGraphView(graph([far, near, root], [edge(root, far)]), { limit: 2 });
    expect(view.nodes.map((n) => n.id)).toEqual(['c1', 'n1']);
    expect(view.hiddenNodes).toBe(1);
    expect(view.hiddenEdges).toBe(1);
    expect(view.notice).toContain('quedaron fuera');
  });

  it('nunca dibuja más de 500 nodos aunque se pida más', () => {
    const nodes = Array.from({ length: 600 }, (_, index) =>
      node({ id: `n${index}`, type: 'work_item', depth: 1 })
    );
    const view = buildGraphView(graph(nodes), { limit: 5_000 });
    expect(view.nodes).toHaveLength(GRAPH_RENDER_LIMIT);
    expect(view.hiddenNodes).toBe(100);
  });

  it('avisa cuando el corte fue del servidor', () => {
    const base = graph([node({ id: 'c1', type: 'operational_case', root: true })]);
    const view = buildGraphView({ ...base, truncated: true });
    expect(view.notice).toContain('tope');
  });

  it('el filtro de tipos nunca esconde una raíz', () => {
    const root = node({ id: 'c1', type: 'operational_case', root: true });
    const other = node({ id: 'o1', type: 'procurement_order', depth: 1 });
    const view = buildGraphView(graph([root, other]), { visibleTypes: ['work_item'] });
    expect(view.nodes.map((n) => n.id)).toEqual(['c1']);
  });

  it('cuenta los tipos presentes para el filtro', () => {
    const view = buildGraphView(
      graph([
        node({ id: 'c1', type: 'operational_case', root: true }),
        node({ id: 'w1', type: 'work_item', depth: 1 }),
        node({ id: 'w2', type: 'work_item', depth: 1 }),
      ])
    );
    expect(view.typeCounts[0]).toMatchObject({ type: 'work_item', count: 2 });
  });
});

describe('layoutGraphNodes', () => {
  it('una columna por profundidad', () => {
    const a = node({ id: 'a', type: 'operational_case', depth: 0, root: true });
    const b = node({ id: 'b', type: 'work_item', depth: 1 });
    const c = node({ id: 'c', type: 'work_item', depth: 1 });
    const positions = layoutGraphNodes([a, b, c]);
    expect(positions.get(a.key)?.x).toBe(0);
    expect(positions.get(b.key)?.x).toBe(positions.get(c.key)?.x);
    expect(positions.get(b.key)?.x).toBeGreaterThan(0);
    expect(positions.get(b.key)?.y).not.toBe(positions.get(c.key)?.y);
  });

  it('respeta las posiciones guardadas en la escena', () => {
    const a = node({ id: 'a', type: 'operational_case', root: true });
    const positions = layoutGraphNodes([a], { [a.key]: { x: 42, y: 7 } });
    expect(positions.get(a.key)).toEqual({ x: 42, y: 7 });
  });

  it('ignora una posición corrupta y vuelve a la rejilla', () => {
    const a = node({ id: 'a', type: 'operational_case', root: true });
    const positions = layoutGraphNodes([a], {
      [a.key]: { x: Number.NaN, y: 0 },
    });
    expect(positions.get(a.key)).toEqual({ x: 0, y: 0 });
  });
});

describe('mergeGraphs', () => {
  it('une sin duplicar y se queda con la profundidad menor', () => {
    const root = node({ id: 'c1', type: 'operational_case', root: true });
    const far = node({ id: 'w1', type: 'work_item', depth: 3 });
    const near = node({ ...far, depth: 1 });
    const merged = mergeGraphs(graph([root, far]), graph([near], [edge(root, near)]));
    expect(merged?.nodes).toHaveLength(2);
    expect(merged?.nodes.find((n) => n.id === 'w1')?.depth).toBe(1);
    expect(merged?.edges).toHaveLength(1);
  });

  it('conserva la marca de raíz al expandir', () => {
    const root = node({ id: 'c1', type: 'operational_case', root: true });
    const merged = mergeGraphs(graph([root]), graph([{ ...root, root: false, depth: 2 }]));
    expect(merged?.nodes[0]?.root).toBe(true);
    expect(merged?.nodes[0]?.depth).toBe(0);
  });

  it('tolera que falte alguno de los dos lados', () => {
    const base = graph([node({ id: 'c1', type: 'operational_case', root: true })]);
    expect(mergeGraphs(null, base)).toBe(base);
    expect(mergeGraphs(base, null)).toBe(base);
    expect(mergeGraphs(null, null)).toBeNull();
  });
});

describe('inspector', () => {
  it('dice qué está oculto en vez de dejar un hueco', () => {
    const fields = inspectorFields(
      node({ id: 'o1', type: 'procurement_order', masked: ['amount', 'contact'] })
    );
    const masked = fields.find((field) => field.key === 'masked');
    expect(masked?.value).toContain('Importe oculto');
    expect(masked?.value).toContain('contacto');
  });

  it('muestra importe y contacto cuando el visor sí puede verlos', () => {
    const fields = inspectorFields(
      node({
        id: 'o1',
        type: 'procurement_order',
        amount: '1,200.00',
        currency: 'MXN',
        contact: { name: 'Aceros SA', phone: '55 0000', email: null },
        status: 'abierta',
      })
    );
    expect(fields.find((field) => field.key === 'amount')?.value).toBe('1,200.00 MXN');
    expect(fields.find((field) => field.key === 'contact')?.value).toContain('Aceros SA');
    expect(fields.some((field) => field.key === 'masked')).toBe(false);
  });

  it('muestra el costo de IA del expediente, y un costo de cero es un dato', () => {
    // Antes este chip no se pintaba nunca: `graph-service` dejaba `aiCostUsd`
    // en null para TODOS los nodos (nadie llenaba el campo). Ahora el nodo del
    // expediente trae la suma del medidor `ai_case`.
    const conCosto = inspectorFields(
      node({ id: 'c1', type: 'operational_case', aiCostUsd: 0.4217 })
    );
    expect(conCosto.find((field) => field.key === 'aiCost')?.value).toBe('0.4217 USD');

    // Un expediente que la IA sí tocó con un plan de tarifa plana cuesta 0: se
    // muestra, porque «cero» y «no aplica» no son lo mismo.
    const gratis = inspectorFields(node({ id: 'c2', type: 'operational_case', aiCostUsd: 0 }));
    expect(gratis.find((field) => field.key === 'aiCost')?.value).toBe('0 USD');

    // Sin medidor (null) no se inventa nada.
    const sinIa = inspectorFields(node({ id: 'c3', type: 'operational_case' }));
    expect(sinIa.some((field) => field.key === 'aiCost')).toBe(false);

    // Y a quien no administra operaciones se le dice que está oculto.
    const oculto = inspectorFields(
      node({ id: 'c4', type: 'operational_case', aiCostUsd: null, masked: ['aiCost'] })
    );
    expect(oculto.find((field) => field.key === 'masked')?.value).toContain('Costo de IA');
  });
});

describe('vecinos y replay', () => {
  const root = node({ id: 'c1', type: 'operational_case', root: true });
  const order = node({ id: 'o1', type: 'procurement_order', depth: 1 });
  const view = buildGraphView(graph([root, order], [edge(root, order)]));

  it('lista los vecinos dibujados con la dirección', () => {
    const neighbours = neighboursOf(view, root.key);
    expect(neighbours).toHaveLength(1);
    expect(neighbours[0]?.direction).toBe('out');
    expect(neighbours[0]?.relation).toBe('cumple');
  });

  it('un expediente se abre en replay directamente', () => {
    expect(
      replayCaseIdOf(
        view.nodes.find((n) => n.type === 'operational_case')!,
        view
      )
    ).toBe('c1');
  });

  it('otro nodo abre el replay de su expediente vecino', () => {
    expect(
      replayCaseIdOf(
        view.nodes.find((n) => n.type === 'procurement_order')!,
        view
      )
    ).toBe('c1');
  });

  it('sin nodo seleccionado no hay replay', () => {
    expect(replayCaseIdOf(null, view)).toBeNull();
  });
});

describe('escenas', () => {
  it('lee filtros corruptos sin romperse', () => {
    expect(parseSceneFilters(null, 2)).toEqual({ depth: 2, relations: [], nodeTypes: [] });
    expect(parseSceneFilters({ depth: 99, relations: ['fulfills', 7] }, 2)).toEqual({
      depth: 3,
      relations: ['fulfills'],
      nodeTypes: [],
    });
  });

  it('lee sólo posiciones numéricas', () => {
    expect(parseSceneLayout({ positions: { a: { x: 1, y: 2 }, b: { x: 'no' }, c: null } })).toEqual(
      { a: { x: 1, y: 2 } }
    );
    expect(parseSceneLayout('texto')).toEqual({});
  });

  it('limpia las raíces (sin vacíos, sin duplicados, con tope)', () => {
    expect(
      cleanRoots([
        { type: ' operational_case ', id: ' c1 ' },
        { type: 'operational_case', id: 'c1' },
        { type: '', id: 'x' },
      ])
    ).toEqual([{ type: 'operational_case', id: 'c1' }]);
    expect(
      cleanRoots(
        Array.from({ length: 30 }, (_, index) => ({ type: 'work_item', id: `w${index}` })),
        5
      )
    ).toHaveLength(5);
  });

  it('la llave del nodo es tipo:id', () => {
    expect(refKey({ type: 'trip', id: 't1' })).toBe('trip:t1');
  });
});
