import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake, addRawHandler } = await import('@/modules/operations/testing/fixtures');
  return { fake: createOpsFake(), addRawHandler };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));

import { expandNode, getGraphNode, queryOperationalGraph, GRAPH_ROOT_LIMIT } from './graph-service';
import { maskedFieldsFor } from './graph-mask';
import { MAX_GRAPH_DEPTH, MAX_GRAPH_NODES } from './perspectives';
import { makeCurrentUser } from '@/modules/operations/testing/fixtures';

/**
 * Grafo operativo con `FakePrisma`: se comprueba la FORMA de la consulta (todo
 * parametrizado, profundidad y tope acotados por el servidor, recorrido en
 * ambas direcciones) y las reglas de acceso (perspectiva + enmascarado), sin
 * necesitar PostgreSQL.
 */

const ADMIN = makeCurrentUser({
  id: 'u-admin',
  permissionKeys: ['operations.admin'],
});
const ADMIN_FINANZAS = makeCurrentUser({
  id: 'u-fin',
  permissionKeys: ['operations.admin', 'finance.view', 'customers.view'],
});
const NOBODY = makeCurrentUser({ id: 'u-nadie', permissionKeys: [] });
const AT = new Date('2026-09-15T18:00:00.000Z');

interface RecordedQuery {
  sql: string;
  values: unknown[];
}

let recorded: RecordedQuery[] = [];
let walkRows: Array<{ nodeType: string; nodeId: string; depth: number }> = [];
let edgeRows: unknown[] = [];

mocks.addRawHandler(mocks.fake, (query) => {
  recorded.push({ sql: query.sql, values: [...query.values] });
  if (query.sql.includes('WITH RECURSIVE walk')) return walkRows;
  if (query.sql.includes('JOIN nodes a')) return edgeRows;
  return [];
});

function reset(): void {
  for (const table of mocks.fake.tables.keys()) mocks.fake.tables.set(table, []);
  recorded = [];
  walkRows = [];
  edgeRows = [];
}

function walkQuery(): RecordedQuery {
  const query = recorded.find((entry) => entry.sql.includes('WITH RECURSIVE walk'));
  if (!query) throw new Error('no se emitió la consulta del recorrido');
  return query;
}

describe('queryOperationalGraph', () => {
  beforeEach(reset);

  it('exige operations.admin', async () => {
    await expect(
      queryOperationalGraph(NOBODY, { roots: [{ type: 'operational_case', id: 'c1' }] })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rechaza una perspectiva inexistente y una sin permiso', async () => {
    await expect(
      queryOperationalGraph(ADMIN, { perspectiveKey: 'inventada', roots: [] })
    ).rejects.toMatchObject({ code: 'not_found' });

    const soloLogistica = makeCurrentUser({
      id: 'u-log',
      permissionKeys: ['operations.admin', 'logistics.view'],
    });
    // `operations.admin` abre todas; quien NO lo tiene no llega ni al permiso de la perspectiva.
    await expect(
      queryOperationalGraph(makeCurrentUser({ id: 'u-x', permissionKeys: ['logistics.view'] }), {
        perspectiveKey: 'contabilidad',
        roots: [],
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      queryOperationalGraph(soloLogistica, { perspectiveKey: 'logistica', roots: [] })
    ).resolves.toMatchObject({ perspectiveKey: 'logistica' });
  });

  it('sin raíces no consulta nada y devuelve un grafo vacío', async () => {
    const graph = await queryOperationalGraph(ADMIN, { roots: [] });
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.truncated).toBe(false);
    expect(recorded).toHaveLength(0);
  });

  it('acota la profundidad a 3 y el tope de nodos a 2000, aunque pidan más', async () => {
    await queryOperationalGraph(ADMIN, {
      roots: [{ type: 'operational_case', id: 'c1' }],
      depth: 99,
      limit: 999_999,
    });
    const query = walkQuery();
    expect(query.values).toContain(MAX_GRAPH_DEPTH);
    expect(query.values).toContain(MAX_GRAPH_NODES + 1); // limit + 1 para detectar el corte
  });

  it('pasa raíces, relaciones, tipos y el instante como parámetros (nada pegado al SQL)', async () => {
    await queryOperationalGraph(ADMIN, {
      perspectiveKey: 'logistica',
      roots: [{ type: 'trip', id: "t1'; DROP TABLE users; --" }],
      at: AT,
    });
    const query = walkQuery();
    expect(query.sql).not.toContain('DROP TABLE');
    expect(query.sql).not.toContain('trip');
    expect(query.values).toContainEqual(['trip']);
    expect(query.values).toContainEqual(["t1'; DROP TABLE users; --"]);
    expect(query.values).toContain(AT);
    const relations = query.values.find(
      (value): value is string[] => Array.isArray(value) && value.includes('has_delivery')
    );
    expect(relations).toBeDefined();
  });

  it('recorre en ambas direcciones y respeta la vigencia temporal', async () => {
    await queryOperationalGraph(ADMIN, { roots: [{ type: 'operational_case', id: 'c1' }], at: AT });
    const sql = walkQuery().sql;
    expect(sql).toContain('o."fromType" = w."nodeType"');
    expect(sql).toContain('o."toType" = w."nodeType"');
    expect(sql).toContain('o."validFrom" <=');
    expect(sql).toContain('o."validTo" IS NULL OR o."validTo" >');
    expect(sql).toContain('o."relation" = ANY(');
  });

  it('un filtro de relaciones fuera de la perspectiva no la amplía', async () => {
    await queryOperationalGraph(ADMIN, {
      perspectiveKey: 'logistica',
      roots: [{ type: 'trip', id: 't1' }],
      relations: ['payable', 'has_delivery'],
    });
    const relations = walkQuery().values.find(
      (value): value is string[] => Array.isArray(value) && value.includes('has_delivery')
    )!;
    expect(relations).toEqual(['has_delivery']);
    expect(relations).not.toContain('payable');
  });

  it('marca truncated cuando el recorrido alcanza el tope del servidor', async () => {
    walkRows = Array.from({ length: 4 }, (_, index) => ({
      nodeType: 'operational_case',
      nodeId: `c${index}`,
      depth: index === 0 ? 0 : 1,
    }));
    const graph = await queryOperationalGraph(ADMIN, {
      roots: [{ type: 'operational_case', id: 'c0' }],
      limit: 3,
    });
    expect(graph.truncated).toBe(true);
    expect(graph.nodes).toHaveLength(3);
  });

  it('carga los nodos reales, marca las raíces y conserva la profundidad', async () => {
    mocks.fake.seed('operationalCase', {
      id: 'c1',
      caseNumber: 'EXP-1',
      customerName: 'Aceros del Norte',
      status: 'open',
      phase: 'planning',
      openedAt: AT,
    });
    mocks.fake.seed('supplier', {
      id: 's1',
      number: 'PRV-1',
      name: 'Aceros SA',
      status: 'active',
      primaryPhone: '555-1234',
      primaryEmail: 'ventas@aceros.mx',
    });
    walkRows = [
      { nodeType: 'operational_case', nodeId: 'c1', depth: 0 },
      { nodeType: 'supplier', nodeId: 's1', depth: 2 },
    ];

    const graph = await queryOperationalGraph(ADMIN_FINANZAS, {
      roots: [{ type: 'operational_case', id: 'c1' }],
    });
    const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
    expect(byKey.get('operational_case:c1')).toMatchObject({
      label: 'EXP-1',
      sublabel: 'Aceros del Norte',
      status: 'open',
      depth: 0,
      root: true,
      href: '/app/operations/cases/c1',
    });
    expect(byKey.get('supplier:s1')).toMatchObject({ label: 'Aceros SA', depth: 2, root: false });
    expect(byKey.get('supplier:s1')!.contact).toMatchObject({ phone: '555-1234' });
  });

  it('el nodo del expediente trae su costo de IA acumulado (medidor `ai_case`)', async () => {
    // El hueco de §7.9: `aiCostUsd` sólo existía como `null` en `emptyNode`;
    // ningún lector lo llenaba, así que la regla de máscara no borraba nada y
    // el chip «Costo de IA» del inspector no se pintaba nunca. El dato SÍ está
    // en la base desde `recordAgentUsage` (dimensión `ai_case`, unidad `usd`).
    mocks.fake.seed('operationalCase', {
      id: 'c1',
      caseNumber: 'EXP-1',
      customerName: 'Aceros del Norte',
      status: 'open',
      phase: 'planning',
      openedAt: AT,
    });
    mocks.fake.seed('operationalCase', {
      id: 'c2',
      caseNumber: 'EXP-2',
      customerName: 'Sin IA',
      status: 'open',
      phase: 'planning',
      openedAt: AT,
    });
    // Dos días del mismo expediente: el costo se acumula.
    mocks.fake.seed('usageMeter', {
      id: 'm1',
      dimension: 'ai_case',
      key: 'c1',
      period: '2026-09-14',
      unit: 'usd',
      count: 3,
      amount: 0.25,
    });
    mocks.fake.seed('usageMeter', {
      id: 'm2',
      dimension: 'ai_case',
      key: 'c1',
      period: '2026-09-15',
      unit: 'usd',
      count: 2,
      amount: 0.17,
    });
    // Tokens no son dinero, y el medidor de otra dimensión no es de este caso.
    mocks.fake.seed('usageMeter', {
      id: 'm3',
      dimension: 'ai_case',
      key: 'c1',
      period: '2026-09-15',
      unit: 'tokens',
      count: 2,
      amount: 9_000,
    });
    mocks.fake.seed('usageMeter', {
      id: 'm4',
      dimension: 'ai_area',
      key: 'ventas',
      period: '2026-09-15',
      unit: 'usd',
      count: 2,
      amount: 5,
    });
    walkRows = [
      { nodeType: 'operational_case', nodeId: 'c1', depth: 0 },
      { nodeType: 'operational_case', nodeId: 'c2', depth: 1 },
    ];

    const graph = await queryOperationalGraph(ADMIN, {
      roots: [{ type: 'operational_case', id: 'c1' }],
    });
    const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
    expect(byKey.get('operational_case:c1')!.aiCostUsd).toBeCloseTo(0.42, 6);
    // Un expediente que la IA nunca tocó vale «no aplica», no 0: así el
    // inspector no pinta un costo inventado.
    expect(byKey.get('operational_case:c2')!.aiCostUsd).toBeNull();
    expect(byKey.get('operational_case:c1')!.masked).not.toContain('aiCost');
  });

  it('quien abre el grafo ya administra operaciones: ahí el costo nunca se enmascara', () => {
    // La regla `aiCost` de `maskNode` exige `operations.admin`, y la Torre
    // entera exige lo mismo, así que HOY nadie llega al grafo sin ese permiso y
    // el campo no se oculta en esta pantalla. La regla se conserva porque el
    // nodo puede viajar a otra superficie; su comportamiento se ejercita en
    // `graph-mask.test.ts`. Esto lo deja escrito para que no se lea como un
    // enmascarado que "no funciona".
    expect(
      maskedFieldsFor({ permissionKeys: ['operations.admin'], isSuperAdmin: false })
    ).not.toContain('aiCost');
    // El importe y el contacto SÍ se siguen ocultando a ese mismo visor: son
    // permisos de otro módulo, no del núcleo de operaciones.
    expect(maskedFieldsFor({ permissionKeys: ['operations.admin'], isSuperAdmin: false })).toEqual([
      'amount',
      'contact',
    ]);
    expect(maskedFieldsFor({ permissionKeys: ['logistics.view'], isSuperAdmin: false })).toContain(
      'aiCost'
    );
  });

  it('enmascara los datos sensibles según el permiso de quien mira', async () => {
    mocks.fake.seed('supplier', {
      id: 's1',
      number: 'PRV-1',
      name: 'Aceros SA',
      status: 'active',
      primaryPhone: '555-1234',
      primaryEmail: 'ventas@aceros.mx',
    });
    mocks.fake.seed('procurementOrder', {
      id: 'o1',
      number: 'OC-1',
      status: 'open',
      total: 15_000,
      currency: 'MXN',
    });
    walkRows = [
      { nodeType: 'supplier', nodeId: 's1', depth: 0 },
      { nodeType: 'procurement_order', nodeId: 'o1', depth: 1 },
    ];

    const sinFinanzas = await queryOperationalGraph(ADMIN, {
      perspectiveKey: 'compras',
      roots: [{ type: 'supplier', id: 's1' }],
    });
    const order = sinFinanzas.nodes.find((node) => node.type === 'procurement_order')!;
    const supplier = sinFinanzas.nodes.find((node) => node.type === 'supplier')!;
    expect(order.amount).toBeNull();
    expect(order.masked).toContain('amount');
    expect(supplier.contact).toBeNull();
    expect(supplier.masked).toContain('contact');
    // ...pero la RELACIÓN y la identidad siguen visibles
    expect(order.label).toBe('OC-1');

    recorded = [];
    walkRows = [
      { nodeType: 'supplier', nodeId: 's1', depth: 0 },
      { nodeType: 'procurement_order', nodeId: 'o1', depth: 1 },
    ];
    const conFinanzas = await queryOperationalGraph(ADMIN_FINANZAS, {
      perspectiveKey: 'compras',
      roots: [{ type: 'supplier', id: 's1' }],
    });
    expect(conFinanzas.nodes.find((node) => node.type === 'procurement_order')!.amount).toBe(
      '15000'
    );
  });

  it('un tipo de nodo sin lector se muestra con su id en vez de romper el grafo', async () => {
    walkRows = [{ nodeType: 'tipo_desconocido', nodeId: 'x1', depth: 0 }];
    const graph = await queryOperationalGraph(ADMIN, {
      perspectiveKey: 'administracion',
      roots: [{ type: 'tipo_desconocido', id: 'x1' }],
    });
    expect(graph.nodes[0]).toMatchObject({ label: 'x1', type: 'tipo_desconocido' });
  });

  it('devuelve las aristas con su etiqueta en español y su vigencia', async () => {
    walkRows = [
      { nodeType: 'operational_case', nodeId: 'c1', depth: 0 },
      { nodeType: 'procurement_order', nodeId: 'o1', depth: 1 },
    ];
    edgeRows = [
      {
        fromType: 'operational_case',
        fromId: 'c1',
        toType: 'procurement_order',
        toId: 'o1',
        relation: 'supplied_by',
        validFrom: AT,
        validTo: null,
      },
    ];
    const graph = await queryOperationalGraph(ADMIN, {
      roots: [{ type: 'operational_case', id: 'c1' }],
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      fromKey: 'operational_case:c1',
      toKey: 'procurement_order:o1',
      relation: 'supplied_by',
      validTo: null,
    });
    expect(graph.edges[0].relationLabel).not.toBe('supplied_by');
  });

  it('descarta raíces vacías y repetidas, y respeta el tope de raíces', async () => {
    const roots = [
      { type: '', id: 'x' },
      { type: 'operational_case', id: '  ' },
      { type: 'operational_case', id: 'c1' },
      { type: 'operational_case', id: 'c1' },
      ...Array.from({ length: GRAPH_ROOT_LIMIT + 10 }, (_, i) => ({
        type: 'operational_case',
        id: `c${i + 2}`,
      })),
    ];
    const graph = await queryOperationalGraph(ADMIN, { roots });
    expect(graph.roots).toHaveLength(GRAPH_ROOT_LIMIT);
    expect(graph.roots.filter((root) => root.id === 'c1')).toHaveLength(1);
  });
});

describe('expandNode', () => {
  beforeEach(reset);

  it('pide exactamente profundidad 1', async () => {
    await expandNode(ADMIN, { node: { type: 'operational_case', id: 'c1' } });
    expect(walkQuery().values).toContain(1);
  });
});

describe('getGraphNode', () => {
  beforeEach(reset);

  it('devuelve un nodo suelto ya enmascarado', async () => {
    mocks.fake.seed('obligation', {
      id: 'ob1',
      number: 'OBL-1',
      description: 'Pago a proveedor',
      status: 'expected',
      expectedAmount: 5_000,
      currency: 'MXN',
      dueAt: AT,
    });
    const node = await getGraphNode(ADMIN, { type: 'obligation', id: 'ob1' });
    expect(node).toMatchObject({ label: 'OBL-1', sublabel: 'Pago a proveedor' });
    expect(node!.amount).toBeNull();
    expect(node!.masked).toContain('amount');
  });

  it('una referencia vacía devuelve null', async () => {
    expect(await getGraphNode(ADMIN, { type: '', id: '' })).toBeNull();
  });

  it('exige operations.admin', async () => {
    await expect(getGraphNode(NOBODY, { type: 'obligation', id: 'ob1' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
