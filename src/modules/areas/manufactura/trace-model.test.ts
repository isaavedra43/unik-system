import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProductionTrace } from '@/modules/manufacturing/manufacturing-queries';
import { dimensionsText, stockTraceUrl, stockTraceView, traceView } from './trace-model';

/**
 * Traceability read as a person reads it (plan 6.2). The chain is written by
 * `recordOutput` (`originProductionOrderId`); here we check that BOTH
 * directions say something true: from the order to its raw materials and its
 * sale, and from an existence back to the order that produced it.
 */

const TRACE: ProductionTrace = {
  order: {
    id: 'op_1',
    number: 'OP-000001',
    status: 'completed',
    outputZohoItemId: 'item_out',
    caseId: 'case_1',
    caseNumber: 'EXP-0007',
    salesOrderNumber: 'SO-123',
    customerName: 'Aceros del Norte',
    demandId: 'dem_1',
    allocationId: 'alloc_1',
  },
  materials: [
    {
      consumptionId: 'mc_1',
      kind: 'actual',
      zohoItemId: 'item_in',
      label: 'Lámina 3 mm',
      quantity: '12',
      unit: 'pza',
      substitutedForZohoItemId: null,
      stockItemId: 'stk_in',
      warehouseId: 'wh_1',
      containerKey: 'ROLLO-9',
      movementId: 'mv_1',
      occurredAt: '2026-03-03T20:00:00.000Z',
    },
    {
      consumptionId: 'mc_2',
      kind: 'substitution',
      zohoItemId: 'item_alt',
      label: 'Lámina 3.2 mm',
      quantity: '2',
      unit: 'pza',
      substitutedForZohoItemId: 'item_in',
      stockItemId: null,
      warehouseId: 'wh_1',
      containerKey: null,
      movementId: 'mv_2',
      occurredAt: null,
    },
  ],
  outputs: [
    {
      outputId: 'out_scrap',
      kind: 'scrap',
      zohoItemId: 'item_out',
      label: 'Recorte',
      quantity: '0.5',
      unit: 'pza',
      stockItemId: 'stk_scrap',
      containerKey: null,
      locationId: 'loc_scrap',
      movementId: 'mv_4',
      dimensions: null,
    },
    {
      outputId: 'out_fin',
      kind: 'finished',
      zohoItemId: 'item_out',
      label: 'Tapa cortada',
      quantity: '10',
      unit: 'pza',
      stockItemId: 'stk_out',
      containerKey: 'TARIMA-2',
      locationId: 'loc_1',
      movementId: 'mv_3',
      dimensions: null,
    },
  ],
  reservations: [
    { id: 'rs_1', demandId: 'dem_1', allocationId: 'alloc_1', quantity: '10', status: 'active' },
  ],
};

describe('trazabilidad de una orden de producción', () => {
  it('lista los materiales que de verdad entraron, con su sustitución', () => {
    const view = traceView(TRACE);
    expect(view.materials.map((line) => line.label)).toStrictEqual([
      'Lámina 3 mm',
      'Lámina 3.2 mm',
    ]);
    expect(view.materials[0]?.hint).toContain('Contenedor ROLLO-9');
    expect(view.materials[1]?.hint).toContain('Sustituyó a item_in');
    expect(view.materials[0]?.stockItemId).toBe('stk_in');
  });

  it('el producto terminado se lee primero, luego sobrante y merma', () => {
    const view = traceView(TRACE);
    expect(view.outputsByKind.map((group) => group.kind)).toStrictEqual(['finished', 'scrap']);
    expect(view.outputsByKind[0]?.label).toBe('Producto terminado');
    expect(view.outputsByKind[0]?.lines[0]?.stockItemId).toBe('stk_out');
  });

  it('dice para qué venta se fabricó', () => {
    const view = traceView(TRACE);
    expect(view.sale).toStrictEqual({
      caseId: 'case_1',
      caseNumber: 'EXP-0007',
      salesOrderNumber: 'SO-123',
      customerName: 'Aceros del Norte',
    });
    expect(view.summary).toContain('para EXP-0007 de Aceros del Norte');
    expect(view.empty).toBe(false);
  });

  it('una orden para inventario lo dice, no inventa un cliente', () => {
    const view = traceView({
      ...TRACE,
      order: {
        ...TRACE.order,
        caseId: null,
        caseNumber: null,
        salesOrderNumber: null,
        customerName: null,
      },
      materials: [],
      outputs: [],
    });
    expect(view.sale).toBeNull();
    expect(view.summary).toContain('para inventario, sin venta ligada');
    expect(view.summary).toContain('Todavía no se registra consumo');
    expect(view.empty).toBe(true);
  });

  it('un sobrante vendible muestra sus medidas', () => {
    expect(dimensionsText({ largo: '2.40', ancho: '1.20', unidadMedida: 'm' })).toBe(
      '2.40 × 1.20 m'
    );
    expect(dimensionsText(null)).toBeNull();
    expect(dimensionsText({ nota: 'sin medidas' })).toBeNull();
  });
});

describe('trazabilidad de una existencia', () => {
  it('lleva de la existencia a la orden que la produjo y a sus insumos', () => {
    const view = stockTraceView({
      stockItem: { id: 'stk_out', containerKey: 'TARIMA-2', originProductionOrderId: 'op_1' },
      productions: [
        {
          productionOrderId: 'op_1',
          number: 'OP-000001',
          quantity: '10',
          lastProducedAt: '2026-03-03T20:00:00.000Z',
        },
      ],
      production: TRACE,
    });
    expect(view.external).toBe(false);
    expect(view.headline).toContain('Producida en OP-000001');
    expect(view.headline).toContain('EXP-0007');
    expect(view.productions[0]?.href).toBe('/app/manufacturing/orders/op_1');
    expect(view.productions[0]?.text).toContain('10');
    expect(view.production?.materials).toHaveLength(2);
  });

  it('una existencia comprada no finge tener una orden detrás', () => {
    const view = stockTraceView({
      stockItem: { id: 'stk_buy', containerKey: 'CAJA-1', originProductionOrderId: null },
      productions: [],
      production: null,
    });
    expect(view.external).toBe(true);
    expect(view.production).toBeNull();
    expect(view.headline).toContain('no salió de una orden de producción');
  });

  it('el enlace de una existencia escapa el identificador', () => {
    expect(stockTraceUrl('stk 1/2')).toBe('/app/manufacturing/trazabilidad/stk%201%2F2');
  });
});

describe('la trazabilidad es alcanzable desde la aplicación', () => {
  // Las dos consultas existían y estaban probadas, pero NADIE las llamaba fuera
  // de los tests: el dato se escribía para nadie. Estas superficies son las que
  // lo consultan; si alguien las borra, este guardián lo dice.
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (path: string) => readFileSync(resolve(here, path), 'utf8');

  it('la ficha de la orden pinta su cadena con getProductionTrace', () => {
    const page = read('../../../app/app/manufacturing/orders/[id]/page.tsx');
    expect(page).toContain('getProductionTrace');
    expect(page).toContain('<TracePanel');
  });

  it('una existencia tiene su página y usa traceStockItem', () => {
    const page = read('../../../app/app/manufacturing/trazabilidad/[stockItemId]/page.tsx');
    expect(page).toContain('traceStockItem');
    expect(page).toContain('stockTraceView');
  });

  it('el inventario ofrece el salto desde la existencia que salió de planta', () => {
    const drawer = read('../../../components/areas/inventario/LocationDrawer.tsx');
    expect(drawer).toContain('stockTraceUrl');
    expect(drawer).toContain('originProductionOrderId');
  });
});
