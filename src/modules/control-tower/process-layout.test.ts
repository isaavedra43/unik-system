import { describe, expect, it } from 'vitest';
import {
  ProcessLayoutCycleError,
  findCycle,
  layoutProcess,
  type LayoutStepInput,
} from './process-layout';

/**
 * Acomodo del visor de procesos. Las dos reglas que importan:
 * 1. una flecha NUNCA apunta hacia atrás (la capa es el camino más largo);
 * 2. un proceso con un ciclo no se dibuja "como se pueda": se rechaza diciendo
 *    cuál es el ciclo, porque un `dependsOn` circular es un blueprint roto.
 */

const LINEAL: LayoutStepInput[] = [
  { key: 'verificar', label: 'Verificar', areaKey: 'inventario', dependsOn: [] },
  { key: 'plan', label: 'Plan', areaKey: 'ventas', dependsOn: ['verificar'] },
  { key: 'preparar', label: 'Preparar', areaKey: 'logistica', dependsOn: ['plan'] },
];

const DIAMANTE: LayoutStepInput[] = [
  { key: 'a', dependsOn: [] },
  { key: 'b', dependsOn: ['a'] },
  { key: 'c', dependsOn: ['a'] },
  { key: 'd', dependsOn: ['b', 'c'] },
];

describe('layoutProcess', () => {
  it('pone cada paso en su capa y coloca las coordenadas', () => {
    const layout = layoutProcess(LINEAL);
    expect(layout.layers).toBe(3);
    expect(layout.nodes.map((node) => [node.key, node.layer])).toEqual([
      ['verificar', 0],
      ['plan', 1],
      ['preparar', 2],
    ]);
    expect(layout.nodes[0].x).toBe(0);
    expect(layout.nodes[1].x).toBe(300); // 220 de ancho + 80 de separación
    expect(layout.nodes.every((node) => node.width === 220 && node.height === 84)).toBe(true);
    expect(layout.width).toBe(3 * 220 + 2 * 80);
  });

  it('conserva la etiqueta y el área de cada paso, y cae en la clave sin etiqueta', () => {
    const layout = layoutProcess([{ key: 'x', areaKey: 'compras', dependsOn: [] }, ...LINEAL]);
    const x = layout.nodes.find((node) => node.key === 'x');
    expect(x).toMatchObject({ label: 'x', areaKey: 'compras' });
    expect(layout.nodes.find((node) => node.key === 'plan')?.label).toBe('Plan');
  });

  it('ninguna arista apunta hacia atrás (capa origen < capa destino)', () => {
    const layout = layoutProcess(DIAMANTE);
    const layerByKey = new Map(layout.nodes.map((node) => [node.key, node.layer]));
    for (const edge of layout.edges) {
      expect(layerByKey.get(edge.from)!).toBeLessThan(layerByKey.get(edge.to)!);
    }
  });

  it('la capa es el camino MÁS LARGO, no el más corto', () => {
    // a → b → c y además a → c: `c` debe quedar en la capa 2, no en la 1.
    const layout = layoutProcess([
      { key: 'a', dependsOn: [] },
      { key: 'b', dependsOn: ['a'] },
      { key: 'c', dependsOn: ['a', 'b'] },
    ]);
    const layerByKey = new Map(layout.nodes.map((node) => [node.key, node.layer]));
    expect(layerByKey.get('c')).toBe(2);
  });

  it('las dependencias a pasos inexistentes se reportan y no se dibujan', () => {
    const layout = layoutProcess([
      { key: 'a', dependsOn: ['no_existe'] },
      { key: 'b', dependsOn: ['a'] },
    ]);
    expect(layout.missingDependencies).toEqual([{ step: 'a', dependsOn: 'no_existe' }]);
    expect(layout.edges).toEqual([{ from: 'a', to: 'b' }]);
    expect(layout.nodes).toHaveLength(2);
  });

  it('las dependencias repetidas producen una sola arista', () => {
    const layout = layoutProcess([
      { key: 'a', dependsOn: [] },
      { key: 'b', dependsOn: ['a', 'a', ' a '] },
    ]);
    expect(layout.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('un proceso vacío devuelve un acomodo vacío y no truena', () => {
    const layout = layoutProcess([]);
    expect(layout).toMatchObject({ nodes: [], edges: [], layers: 0, width: 0, height: 0 });
  });

  it('acepta opciones de tamaño', () => {
    const layout = layoutProcess(LINEAL, { nodeWidth: 100, gapX: 20, nodeHeight: 40, gapY: 10 });
    expect(layout.nodes[1].x).toBe(120);
    expect(layout.width).toBe(3 * 100 + 2 * 20);
  });

  it('el orden dentro de la capa es estable entre corridas', () => {
    const first = layoutProcess(DIAMANTE).nodes.map(
      (node) => `${node.layer}:${node.order}:${node.key}`
    );
    const second = layoutProcess(DIAMANTE).nodes.map(
      (node) => `${node.layer}:${node.order}:${node.key}`
    );
    expect(first).toEqual(second);
  });

  it('RECHAZA un ciclo en vez de dibujar cualquier cosa', () => {
    const ciclico: LayoutStepInput[] = [
      { key: 'a', dependsOn: ['c'] },
      { key: 'b', dependsOn: ['a'] },
      { key: 'c', dependsOn: ['b'] },
    ];
    expect(() => layoutProcess(ciclico)).toThrow(ProcessLayoutCycleError);
    try {
      layoutProcess(ciclico);
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessLayoutCycleError);
      const cycle = (error as ProcessLayoutCycleError).cycle;
      expect(cycle.length).toBeGreaterThanOrEqual(3);
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect((error as Error).message).toContain('ciclo');
    }
  });

  it('un paso que depende de sí mismo también es un ciclo', () => {
    expect(() => layoutProcess([{ key: 'a', dependsOn: ['a'] }])).toThrow(ProcessLayoutCycleError);
  });

  it('un ciclo entre dos pasos sueltos no impide detectarlo', () => {
    expect(() =>
      layoutProcess([
        { key: 'ok', dependsOn: [] },
        { key: 'x', dependsOn: ['y'] },
        { key: 'y', dependsOn: ['x'] },
      ])
    ).toThrow(ProcessLayoutCycleError);
  });
});

describe('findCycle', () => {
  it('devuelve null cuando el proceso es acíclico', () => {
    expect(findCycle(LINEAL)).toBeNull();
    expect(findCycle(DIAMANTE)).toBeNull();
  });

  it('devuelve el ciclo encontrado, cerrado sobre sí mismo', () => {
    const cycle = findCycle([
      { key: 'a', dependsOn: ['b'] },
      { key: 'b', dependsOn: ['a'] },
    ]);
    expect(cycle).not.toBeNull();
    expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
  });

  it('detecta la autodependencia', () => {
    expect(findCycle([{ key: 'a', dependsOn: ['a'] }])).toEqual(['a', 'a']);
  });
});
