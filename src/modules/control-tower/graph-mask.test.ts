import { describe, expect, it } from 'vitest';
import {
  MASK_RULES,
  maskNode,
  maskNodes,
  maskNotice,
  maskedFieldsFor,
  viewerHoldsAny,
  type GraphNode,
  type GraphViewer,
} from './graph-mask';
import {
  DEFAULT_PERSPECTIVE_KEY,
  GRAPH_PERSPECTIVES,
  MAX_GRAPH_DEPTH,
  MAX_GRAPH_NODES,
  canUsePerspective,
  clampDepth,
  clampNodeLimit,
  getPerspective,
  listPerspectivesFor,
  nodeTypeLabel,
  relationLabel,
} from './perspectives';

/**
 * Enmascarado del grafo. La regla del plan es explícita: ver la RELACIÓN no da
 * derecho a ver el DATO SENSIBLE. Un administrador de operaciones puede
 * recorrer toda la red sin ver los importes de Contabilidad ni los teléfonos de
 * los clientes.
 */

function viewer(permissionKeys: string[], isSuperAdmin = false): GraphViewer {
  return { permissionKeys, isSuperAdmin };
}

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    key: 'procurement_order:o1',
    id: 'o1',
    type: 'procurement_order',
    typeLabel: 'Orden de compra',
    label: 'OC-100',
    sublabel: null,
    status: 'open',
    areaKey: 'compras',
    at: null,
    href: null,
    amount: '15000.00',
    currency: 'MXN',
    contact: { name: 'Aceros SA', phone: '555-1234', email: 'ventas@aceros.mx' },
    aiCostUsd: 0.42,
    masked: [],
    ...overrides,
  };
}

describe('viewerHoldsAny', () => {
  it('reconoce el permiso exacto', () => {
    expect(viewerHoldsAny(viewer(['finance.view']), ['finance.view'])).toBe(true);
    expect(viewerHoldsAny(viewer(['finance.manage']), ['finance.view'])).toBe(false);
  });

  it('super_admin los tiene todos', () => {
    expect(viewerHoldsAny(viewer([], true), ['lo.que.sea'])).toBe(true);
  });

  it('una lista vacía de permisos no autoriza a nadie (salvo super_admin)', () => {
    expect(viewerHoldsAny(viewer(['finance.view']), [])).toBe(false);
    expect(viewerHoldsAny(viewer([], true), [])).toBe(true);
  });
});

describe('maskedFieldsFor', () => {
  it('quien no tiene nada pierde los tres campos', () => {
    expect(maskedFieldsFor(viewer([]))).toEqual(['amount', 'contact', 'aiCost']);
  });

  it('operations.admin NO levanta la máscara de importes ni de contacto', () => {
    expect(maskedFieldsFor(viewer(['operations.admin']))).toEqual(['amount', 'contact']);
  });

  it('cada permiso levanta sólo su campo', () => {
    expect(maskedFieldsFor(viewer(['finance.view']))).toEqual(['contact', 'aiCost']);
    expect(maskedFieldsFor(viewer(['customers.view']))).toEqual(['amount', 'aiCost']);
  });

  it('super_admin no pierde nada', () => {
    expect(maskedFieldsFor(viewer([], true))).toEqual([]);
  });

  it('las reglas cubren los tres campos del plan', () => {
    expect(MASK_RULES.map((rule) => rule.field)).toEqual(['amount', 'contact', 'aiCost']);
  });
});

describe('maskNode', () => {
  it('borra importe, contacto y costo de IA a quien no los puede ver, y lo dice', () => {
    const masked = maskNode(node(), viewer([]));
    expect(masked.amount).toBeNull();
    expect(masked.currency).toBeNull();
    expect(masked.contact).toBeNull();
    expect(masked.aiCostUsd).toBeNull();
    expect(masked.masked).toEqual(['amount', 'contact', 'aiCost']);
  });

  it('no toca la identidad ni el estado del nodo (se sigue viendo la relación)', () => {
    const masked = maskNode(node(), viewer([]));
    expect(masked.label).toBe('OC-100');
    expect(masked.type).toBe('procurement_order');
    expect(masked.status).toBe('open');
    expect(masked.areaKey).toBe('compras');
  });

  it('con finance.view conserva el importe y oculta lo demás', () => {
    const masked = maskNode(node(), viewer(['finance.view']));
    expect(masked.amount).toBe('15000.00');
    expect(masked.currency).toBe('MXN');
    expect(masked.contact).toBeNull();
    expect(masked.masked).toEqual(['contact', 'aiCost']);
  });

  it('no marca como oculto un campo que ya venía vacío', () => {
    const masked = maskNode(
      node({ amount: null, currency: null, contact: null, aiCostUsd: null }),
      viewer([])
    );
    expect(masked.masked).toEqual([]);
  });

  it('super_admin recibe el nodo intacto', () => {
    const original = node();
    const masked = maskNode(original, viewer([], true));
    expect(masked).toEqual({ ...original, masked: [] });
  });

  it('no muta el nodo original', () => {
    const original = node();
    maskNode(original, viewer([]));
    expect(original.amount).toBe('15000.00');
    expect(original.contact).not.toBeNull();
  });

  it('maskNodes aplica la misma regla a toda la lista', () => {
    const masked = maskNodes(
      [node(), node({ key: 'x:1', id: '1', type: 'x' })],
      viewer(['finance.view'])
    );
    expect(masked).toHaveLength(2);
    expect(masked.every((row) => row.contact === null)).toBe(true);
    expect(masked.every((row) => row.amount === '15000.00')).toBe(true);
  });
});

describe('maskNotice', () => {
  it('sin campos ocultos no dice nada', () => {
    expect(maskNotice([])).toBeNull();
  });

  it('explica en español qué se ocultó y por qué', () => {
    const notice = maskNotice(['amount', 'contact']);
    expect(notice).toContain('Importe oculto');
    expect(notice).toContain('Contabilidad');
    expect(notice).toContain('Datos de contacto');
  });

  it('un campo desconocido no produce ruido', () => {
    expect(maskNotice(['inventado'])).toBeNull();
  });
});

describe('perspectivas', () => {
  it('la perspectiva por omisión existe', () => {
    expect(getPerspective(DEFAULT_PERSPECTIVE_KEY)).not.toBeNull();
    expect(getPerspective('no_existe')).toBeNull();
    expect(getPerspective(null)).toBeNull();
  });

  it('todas declaran permisos, raíces y relaciones', () => {
    for (const perspective of GRAPH_PERSPECTIVES) {
      expect(perspective.permissions.length).toBeGreaterThan(0);
      expect(perspective.relations.length).toBeGreaterThan(0);
      expect(perspective.defaultDepth).toBeGreaterThanOrEqual(1);
      expect(perspective.defaultDepth).toBeLessThanOrEqual(MAX_GRAPH_DEPTH);
    }
  });

  it('cada perspectiva la abre operations.admin', () => {
    const admin = viewer(['operations.admin']);
    expect(listPerspectivesFor(admin)).toHaveLength(GRAPH_PERSPECTIVES.length);
  });

  it('quien sólo ve Logística abre las suyas, no la de Contabilidad', () => {
    const logistics = viewer(['logistics.view']);
    const keys = listPerspectivesFor(logistics).map((perspective) => perspective.key);
    expect(keys).toContain('logistica');
    expect(keys).not.toContain('contabilidad');
    expect(keys).not.toContain('administracion');
  });

  it('canUsePerspective coincide con el listado', () => {
    const buyer = viewer(['purchases.view']);
    expect(canUsePerspective(buyer, getPerspective('compras')!)).toBe(true);
    expect(canUsePerspective(buyer, getPerspective('administracion')!)).toBe(false);
  });

  it('acota la profundidad y el tope de nodos', () => {
    const perspective = getPerspective(DEFAULT_PERSPECTIVE_KEY)!;
    expect(clampDepth(99, perspective)).toBe(MAX_GRAPH_DEPTH);
    expect(clampDepth(0, perspective)).toBe(1);
    expect(clampDepth(null, perspective)).toBe(perspective.defaultDepth);
    expect(clampDepth(Number.NaN, perspective)).toBe(perspective.defaultDepth);
    expect(clampNodeLimit(999_999)).toBe(MAX_GRAPH_NODES);
    expect(clampNodeLimit(-5)).toBe(1);
    expect(clampNodeLimit(null)).toBe(MAX_GRAPH_NODES);
  });

  it('las etiquetas caen con elegancia en lo desconocido', () => {
    expect(nodeTypeLabel('operational_case')).not.toBe('operational_case');
    expect(nodeTypeLabel('tipo_nuevo')).toBe('tipo_nuevo');
    expect(relationLabel('relacion_nueva')).toBe('relacion nueva');
  });
});
