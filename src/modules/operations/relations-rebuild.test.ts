import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The derivations are pure, so no query runs here. `upsertRelationEdges` is the
 * only part that touches the database and it is exercised against this stub.
 */
const { createMany, updateMany } = vi.hoisted(() => ({
  createMany: vi.fn(async () => ({ count: 0 })),
  updateMany: vi.fn(async () => ({ count: 0 })),
}));
vi.mock('@/lib/prisma', () => ({ prisma: { objectRelation: { createMany, updateMany } } }));

import { ACTIVITY_REF_TYPES, CRM_OBJECT_TYPES } from '@/modules/crm/types';
import { FINANCE_OBJECT_TYPES } from '@/modules/finance/types';
import { LOGISTICS_OBJECT_TYPES } from '@/modules/logistics/types';
import { MANUFACTURING_OBJECT_TYPES } from '@/modules/manufacturing/manufacturing-types';
import { PURCHASES_OBJECT_TYPES } from '@/modules/purchases/purchases-types';
import {
  areaRequestEdges,
  dedupeEdges,
  demandAllocationEdges,
  goodsReceiptEdges,
  listRelationSources,
  opportunityEdges,
  operationalCaseEdges,
  procurementAllocationEdges,
  procurementOrderEdges,
  procurementOrderLineEdges,
  productionOrderEdges,
  purchaseRequestEdges,
  rebuildObjectRelations,
  registerRelationSource,
  rfqInvitationEdges,
  rfqLineEdges,
  supplierEdges,
  upsertRelationEdges,
  type RelationEdge,
} from './relations-rebuild';

const AT = new Date('2026-09-16T10:00:00.000Z');
const OBJ = PURCHASES_OBJECT_TYPES;

/** Compact view of an edge, so a failure names the triple that broke. */
const triples = (edges: RelationEdge[]) =>
  edges.map((e) => `${e.fromType}:${e.fromId} -${e.relation}-> ${e.toType}:${e.toId}`);

describe('fuentes registradas', () => {
  /**
   * The projection is only "reconstruible" (plan 2.1) if EVERY area that writes
   * relations can be re-derived. Before this list the rebuild covered four
   * tables while eight modules wrote edges, so a rebuild silently repaired
   * logistics and inventory and left purchases, CRM and manufacturing behind.
   */
  it('cubre las áreas que escriben relaciones, no sólo logística e inventario', () => {
    const keys = listRelationSources().map((s) => s.key);
    expect([...keys].sort()).toEqual(
      [
        'area_requests',
        'cases',
        'delivery_orders',
        'demand_allocations',
        'goods_receipts',
        'legacy_claims',
        'opportunities',
        'procurement_allocations',
        'procurement_order_lines',
        'procurement_orders',
        'production_orders',
        'purchase_requests',
        'rfq_invitations',
        'rfq_lines',
        'stock_reservations',
        'suppliers',
        'trips',
      ].sort()
    );
  });

  it('cada fuente tiene etiqueta en español para el panel', () => {
    for (const source of listRelationSources()) {
      expect(source.label.length).toBeGreaterThan(3);
    }
  });
});

describe('derivaciones del expediente y sus asignaciones', () => {
  it('el expediente cumple la orden de venta LOCAL, no el id de Zoho que guarda', () => {
    const row = { id: 'case1', zohoSalesOrderId: 'zso-1', createdAt: AT };
    expect(operationalCaseEdges(row, new Map([['zso-1', 'so-local-1']]))).toEqual([
      {
        fromType: 'operational_case',
        fromId: 'case1',
        toType: 'sales_order',
        toId: 'so-local-1',
        relation: 'fulfills',
        validFrom: AT,
      },
    ]);
  });

  it('sin fila espejo de la orden de venta no inventa la arista', () => {
    const row = { id: 'case1', zohoSalesOrderId: 'zso-1', createdAt: AT };
    expect(operationalCaseEdges(row, new Map())).toEqual([]);
  });

  it('la asignación apunta a su demanda y, si la pidió, a la solicitud de área', () => {
    const edges = demandAllocationEdges({
      id: 'alloc1',
      demandId: 'demand1',
      linkedType: 'area_request',
      linkedId: 'req1',
      createdAt: AT,
    });
    expect(triples(edges)).toEqual([
      'demand_allocation:alloc1 -allocates-> case_demand:demand1',
      'demand_allocation:alloc1 -requested_via-> area_request:req1',
    ]);
  });

  it('un linkedId que NO es una solicitud de área no se convierte en requested_via', () => {
    const edges = demandAllocationEdges({
      id: 'alloc1',
      demandId: 'demand1',
      linkedType: 'purchase_request',
      linkedId: 'pr1',
      createdAt: AT,
    });
    expect(triples(edges)).toEqual(['demand_allocation:alloc1 -allocates-> case_demand:demand1']);
  });
});

describe('derivaciones de compras', () => {
  it('la solicitud de pago apunta al pagadero y a la orden detrás de él', () => {
    const edges = areaRequestEdges(
      { id: 'req1', objectType: 'obligation', objectId: 'ob1', createdAt: AT },
      new Map([['ob1', 'oc1']])
    );
    expect(triples(edges)).toEqual([
      `area_request:req1 -payment_for-> ${FINANCE_OBJECT_TYPES.obligation}:ob1`,
      `area_request:req1 -payment_for_order-> ${OBJ.order}:oc1`,
    ]);
  });

  it('una solicitud que no apunta a un pagadero no produce aristas de pago', () => {
    const edges = areaRequestEdges(
      { id: 'req1', objectType: 'demand_allocation', objectId: 'alloc1', createdAt: AT },
      new Map([['ob1', 'oc1']])
    );
    expect(edges).toEqual([]);
  });

  it('la orden de compra une proveedor, pagadero, RFQ adjudicada y entrega directa', () => {
    const edges = procurementOrderEdges(
      {
        id: 'oc1',
        supplierId: 'prv1',
        obligationId: 'ob1',
        rfqResponseId: 'resp1',
        directDeliveryCaseId: 'case1',
        createdAt: AT,
      },
      new Map([['resp1', 'rfq1']])
    );
    expect(triples(edges)).toEqual([
      `${OBJ.order}:oc1 -ordered_from-> ${OBJ.supplier}:prv1`,
      `${OBJ.order}:oc1 -payable-> ${FINANCE_OBJECT_TYPES.obligation}:ob1`,
      `${OBJ.rfq}:rfq1 -awarded_as-> ${OBJ.order}:oc1`,
      `operational_case:case1 -supplied_by-> ${OBJ.order}:oc1`,
    ]);
  });

  it('una orden sin RFQ ni entrega directa sólo deja proveedor y pagadero', () => {
    const edges = procurementOrderEdges(
      {
        id: 'oc1',
        supplierId: 'prv1',
        obligationId: null,
        rfqResponseId: null,
        directDeliveryCaseId: null,
        createdAt: AT,
      },
      new Map()
    );
    expect(triples(edges)).toEqual([`${OBJ.order}:oc1 -ordered_from-> ${OBJ.supplier}:prv1`]);
  });

  it('el renglón lleva la solicitud de compra a la orden (ordered_in)', () => {
    const edges = procurementOrderLineEdges(
      { id: 'line1', orderId: 'oc1', requestLineId: 'rl1', createdAt: AT },
      new Map([['rl1', 'sc1']])
    );
    expect(triples(edges)).toEqual([`${OBJ.request}:sc1 -ordered_in-> ${OBJ.order}:oc1`]);
  });

  it('el camino de bodega de supplied_by: renglón → asignación → demanda → expediente', () => {
    const edges = procurementAllocationEdges(
      { id: 'pa1', orderLineId: 'line1', demandId: 'demand1', createdAt: AT },
      new Map([['line1', 'oc1']]),
      new Map([['demand1', 'case1']])
    );
    expect(triples(edges)).toEqual([`operational_case:case1 -supplied_by-> ${OBJ.order}:oc1`]);
  });

  it('la solicitud de compra apunta a su expediente', () => {
    expect(triples(purchaseRequestEdges({ id: 'sc1', caseId: 'case1', createdAt: AT }))).toEqual([
      `${OBJ.request}:sc1 -for_case-> operational_case:case1`,
    ]);
    expect(purchaseRequestEdges({ id: 'sc1', caseId: null, createdAt: AT })).toEqual([]);
  });

  it('el proveedor se liga a su contacto de Zoho y al candidato del que se promovió', () => {
    const edges = supplierEdges({
      id: 'prv1',
      zohoContactId: 'zc1',
      sourceCandidateId: 'cand1',
      createdAt: AT,
    });
    expect(triples(edges)).toEqual([
      `${OBJ.supplier}:prv1 -same_as-> zoho_contact:zc1`,
      `${OBJ.candidate}:cand1 -promoted_to-> ${OBJ.supplier}:prv1`,
    ]);
  });

  it('el renglón de RFQ lleva la solicitud a la cotización (quoted_in)', () => {
    const edges = rfqLineEdges(
      { id: 'rl1', rfqId: 'rfq1', requestLineId: 'prl1', createdAt: AT },
      new Map([['prl1', 'sc1']])
    );
    expect(triples(edges)).toEqual([`${OBJ.request}:sc1 -quoted_in-> ${OBJ.rfq}:rfq1`]);
  });

  it('la invitación recuerda en qué conversación se negoció', () => {
    const edges = rfqInvitationEdges({
      id: 'inv1',
      rfqId: 'rfq1',
      conversationId: 'conv1',
      createdAt: AT,
    });
    expect(triples(edges)).toEqual([
      `${OBJ.rfq}:rfq1 -negotiated_in-> ${ACTIVITY_REF_TYPES.conversation}:conv1`,
    ]);
    expect(
      rfqInvitationEdges({ id: 'inv1', rfqId: 'rfq1', conversationId: null, createdAt: AT })
    ).toEqual([]);
  });

  it('la recepción apunta a su orden', () => {
    expect(triples(goodsReceiptEdges({ id: 'rc1', orderId: 'oc1', createdAt: AT }))).toEqual([
      `${OBJ.receipt}:rc1 -receipt_of-> ${OBJ.order}:oc1`,
    ]);
  });
});

describe('derivaciones de CRM y manufactura', () => {
  it('la oportunidad usa las filas espejo LOCALES de cotización y orden de venta', () => {
    const edges = opportunityEdges(
      {
        id: 'opp1',
        conversationIds: ['conv1'],
        voiceCallIds: ['call1'],
        zohoEstimateIds: ['ze1', 'ze-sin-espejo'],
        zohoSalesOrderIds: ['zso1'],
        createdAt: AT,
      },
      new Map([['ze1', 'quote-local-1']]),
      new Map([['zso1', 'so-local-1']])
    );
    expect(triples(edges)).toEqual([
      `${ACTIVITY_REF_TYPES.conversation}:conv1 -originated-> ${CRM_OBJECT_TYPES.opportunity}:opp1`,
      `${ACTIVITY_REF_TYPES.voiceCall}:call1 -originated-> ${CRM_OBJECT_TYPES.opportunity}:opp1`,
      `${CRM_OBJECT_TYPES.opportunity}:opp1 -quoted-> ${ACTIVITY_REF_TYPES.quote}:quote-local-1`,
      `${CRM_OBJECT_TYPES.opportunity}:opp1 -resulted_in-> ${ACTIVITY_REF_TYPES.salesOrder}:so-local-1`,
    ]);
  });

  it('la orden de producción une expediente, demanda, asignación y la solicitud que contesta', () => {
    const edges = productionOrderEdges(
      {
        id: 'op1',
        caseId: 'case1',
        demandId: 'demand1',
        demandAllocationId: 'alloc1',
        createdAt: AT,
      },
      new Map([['alloc1', 'req1']])
    );
    const self = MANUFACTURING_OBJECT_TYPES.productionOrder;
    expect(triples(edges)).toEqual([
      `${self}:op1 -for_case-> operational_case:case1`,
      `${self}:op1 -produces_for-> case_demand:demand1`,
      `${self}:op1 -fulfills-> ${LOGISTICS_OBJECT_TYPES.allocation}:alloc1`,
      `${self}:op1 -answers-> area_request:req1`,
    ]);
  });

  it('sin solicitud de transformación para esa asignación no inventa answers', () => {
    const edges = productionOrderEdges(
      {
        id: 'op1',
        caseId: null,
        demandId: null,
        demandAllocationId: 'alloc1',
        createdAt: AT,
      },
      new Map()
    );
    expect(triples(edges)).toEqual([
      `${MANUFACTURING_OBJECT_TYPES.productionOrder}:op1 -fulfills-> demand_allocation:alloc1`,
    ]);
  });
});

describe('dedupeEdges', () => {
  const edge = (fromId: string, toId: string, relation = 'r'): RelationEdge => ({
    fromType: 'a',
    fromId,
    toType: 'b',
    toId,
    relation,
    validFrom: AT,
  });

  it('descarta duplicados y extremos vacíos', () => {
    expect(
      dedupeEdges([edge('1', '2'), edge('1', '2'), edge('', '2'), edge('1', ''), edge('1', '3')])
    ).toEqual([edge('1', '2'), edge('1', '3')]);
  });
});

describe('rebuildObjectRelations', () => {
  beforeEach(() => {
    createMany.mockClear();
    updateMany.mockClear();
  });

  const fakeSource = (key: string, pages: RelationEdge[][]) => {
    const scan = vi.fn(async (cursor: string | null, take: number) => {
      const index = cursor === null ? 0 : Number(cursor);
      const edges = pages[index] ?? [];
      return {
        edges,
        scanned: edges.length,
        // Emulates the real cursor rule: a full page means there may be more.
        nextCursor: index + 1 < pages.length ? String(index + 1) : null,
        take,
      };
    });
    registerRelationSource({ key, label: `Prueba ${key}`, scan });
    return scan;
  };

  const edge = (id: string): RelationEdge => ({
    fromType: 'a',
    fromId: id,
    toType: 'b',
    toId: id,
    relation: 'r',
    validFrom: AT,
  });

  it('recorre todas las páginas de la fuente y suma los totales', async () => {
    createMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });
    const scan = fakeSource('test_paginada', [[edge('1'), edge('2')], [edge('3')]]);
    const summary = await rebuildObjectRelations({ sources: ['test_paginada'] });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(summary.sources.test_paginada).toEqual({
      scanned: 3,
      edges: 3,
      created: 3,
      reopened: 0,
    });
    expect(summary.aborted).toBe(false);
  });

  it('reporta las fuentes pedidas que no existen en vez de fallar', async () => {
    fakeSource('test_existe', [[edge('1')]]);
    const summary = await rebuildObjectRelations({ sources: ['test_existe', 'no_existe'] });
    expect(summary.unknownSources).toEqual(['no_existe']);
    expect(Object.keys(summary.sources)).toEqual(['test_existe']);
  });

  it('se detiene entre lotes cuando la señal se aborta', async () => {
    const controller = new AbortController();
    controller.abort();
    fakeSource('test_abortada', [[edge('1')]]);
    const summary = await rebuildObjectRelations({
      sources: ['test_abortada'],
      signal: controller.signal,
    });
    expect(summary.aborted).toBe(true);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('informa el avance por fuente', async () => {
    fakeSource('test_avance_a', [[edge('1')]]);
    fakeSource('test_avance_b', [[edge('2')]]);
    const onProgress = vi.fn();
    await rebuildObjectRelations({
      sources: ['test_avance_a', 'test_avance_b'],
      onProgress,
    });
    expect(onProgress.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe('upsertRelationEdges', () => {
  beforeEach(() => {
    createMany.mockClear();
    updateMany.mockClear();
  });

  it('no consulta nada cuando no hay aristas', async () => {
    expect(await upsertRelationEdges([])).toEqual({ created: 0, reopened: 0 });
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('inserta sin duplicar y reabre las cerradas (igual que ctx.relate)', async () => {
    createMany.mockResolvedValueOnce({ count: 1 });
    updateMany.mockResolvedValueOnce({ count: 1 });
    const result = await upsertRelationEdges([
      {
        fromType: 'a',
        fromId: '1',
        toType: 'b',
        toId: '2',
        relation: 'r',
        validFrom: AT,
      },
    ]);
    expect(result).toEqual({ created: 1, reopened: 1 });
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ validTo: { not: null } }),
        data: { validTo: null },
      })
    );
  });
});

/**
 * The regression this file exists for: the job, the handler and
 * `enqueueRelationsRebuild` all existed and were registered, but NOTHING called
 * the enqueue, so the whole rebuild was dead code and the projection could only
 * ever be written by `ctx.relate`. A unit test cannot catch that, so this walks
 * the app tree and demands a real caller.
 */
describe('la reconstrucción es alcanzable desde la aplicación', () => {
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
    return out;
  };

  it('alguna ruta o acción del servidor llama a enqueueRelationsRebuild', () => {
    const callers = walk(join(process.cwd(), 'src', 'app')).filter((file) =>
      readFileSync(file, 'utf8').includes('enqueueRelationsRebuild(')
    );
    expect(callers.length).toBeGreaterThan(0);
  });
});
