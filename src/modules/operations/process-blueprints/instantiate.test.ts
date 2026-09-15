import { describe, expect, it } from 'vitest';
import {
  dependenciesSatisfied,
  instantiateSteps,
  parseStepRef,
  sameDependencies,
  stepRef,
  type InstantiateInput,
} from './instantiate';
import { SALES_FULFILLMENT_BLUEPRINT } from './sales-fulfillment';

const bp = SALES_FULFILLMENT_BLUEPRINT;

const withAllocations: InstantiateInput = {
  demands: [
    { id: 'd1', status: 'allocated' },
    { id: 'd2', status: 'allocated' },
  ],
  allocations: [
    { id: 'a1', demandId: 'd1', source: 'stock', status: 'reserved' },
    { id: 'a2', demandId: 'd1', source: 'purchase', status: 'requested' },
    { id: 'a3', demandId: 'd2', source: 'manufacture', status: 'planned' },
    { id: 'a4', demandId: 'd2', source: 'direct_supplier', status: 'planned' },
  ],
};

function byKey(input: InstantiateInput) {
  const steps = instantiateSteps(bp, input);
  return (stepKey: string, scopeKey = '') =>
    steps.find((s) => s.stepKey === stepKey && s.scopeKey === scopeKey);
}

describe('blueprint sales_fulfillment@1', () => {
  it('tiene los 15 pasos de la tabla 2.3 con área, tipo, alcance, dependencias, salida y SLA', () => {
    expect(bp.processKey).toBe('sales_fulfillment');
    expect(bp.version).toBe(1);
    expect(
      bp.steps.map((s) => [
        s.key,
        s.areaKey,
        s.kind,
        s.scope,
        s.appliesTo ?? null,
        s.dependsOn,
        s.exit.eventType,
        s.slaMinutes,
      ])
    ).toEqual([
      [
        'verificar_disponibilidad',
        'inventario',
        'verification',
        'demand',
        null,
        [],
        'demand.verified',
        120,
      ],
      [
        'plan_abastecimiento',
        'ventas',
        'approval',
        'demand',
        null,
        ['verificar_disponibilidad'],
        'demand.allocated',
        240,
      ],
      [
        'reservar_stock',
        'inventario',
        'action',
        'allocation',
        ['stock'],
        ['plan_abastecimiento'],
        'stock.reserved',
        15,
      ],
      [
        'solicitar_compra',
        'compras',
        'action',
        'allocation',
        ['purchase'],
        ['plan_abastecimiento'],
        'request.sent',
        240,
      ],
      [
        'esperar_recepcion',
        'compras',
        'wait',
        'allocation',
        ['purchase'],
        ['solicitar_compra'],
        'stock.received',
        1440,
      ],
      [
        'ordenar_produccion',
        'manufactura',
        'action',
        'allocation',
        ['manufacture'],
        ['plan_abastecimiento'],
        'request.sent',
        240,
      ],
      [
        'esperar_produccion',
        'manufactura',
        'wait',
        'allocation',
        ['manufacture'],
        ['ordenar_produccion'],
        'production.finished',
        1440,
      ],
      [
        'coordinar_entrega_directa',
        'compras',
        'action',
        'allocation',
        ['direct_supplier'],
        ['plan_abastecimiento'],
        'request.sent',
        240,
      ],
      [
        'confirmar_entrega_directa',
        'logistica',
        'verification',
        'allocation',
        ['direct_supplier'],
        ['coordinar_entrega_directa'],
        'delivery.confirmed',
        1440,
      ],
      [
        'preparar_pedido',
        'inventario',
        'action',
        'case',
        null,
        ['reservar_stock', 'esperar_recepcion', 'esperar_produccion'],
        'order.prepared',
        480,
      ],
      [
        'planear_entrega',
        'logistica',
        'action',
        'case',
        null,
        ['preparar_pedido'],
        'delivery.planned',
        240,
      ],
      [
        'asignar_transporte',
        'logistica',
        'external_sync',
        'case',
        null,
        ['planear_entrega'],
        'zoho.shipment_confirmed',
        60,
      ],
      [
        'entregar',
        'logistica',
        'action',
        'case',
        null,
        ['asignar_transporte'],
        'delivery.confirmed',
        1440,
      ],
      [
        'cierre_operativo',
        'ventas',
        'verification',
        'case',
        null,
        ['entregar', 'confirmar_entrega_directa'],
        'case.operational_closed',
        1440,
      ],
      [
        'cierre_financiero',
        'contabilidad',
        'wait',
        'case',
        null,
        ['cierre_operativo'],
        'case.financial_closed',
        43200,
      ],
    ]);
  });

  it('declara condiciones de cierre, anclas de SLA, dueño y escalera', () => {
    const step = (key: string) => bp.steps.find((s) => s.key === key)!;
    expect(step('verificar_disponibilidad')).toMatchObject({
      autoComplete: 'controlledStockSufficient',
      ownerResolution: { area: 'inventario', byLocation: true },
      exit: { evidence: ['availability_result'] },
    });
    expect(step('plan_abastecimiento')).toMatchObject({
      autoComplete: 'planCoveredByControlledStock',
      ownerResolution: { role: 'case_owner' },
    });
    expect(step('esperar_recepcion')).toMatchObject({ slaAnchor: 'expectedAt' });
    expect(step('entregar')).toMatchObject({
      slaAnchor: 'plannedDate',
      exit: { alternateEventTypes: ['delivery.partial'] },
    });
    expect(step('asignar_transporte')).toMatchObject({ entryCondition: 'requiresTransport' });
    expect(step('cierre_operativo').autoComplete).toBe('allDemandsFulfilled');
    expect(step('cierre_financiero').autoComplete).toBe('salesOrderInvoicedAndPaid');
    expect(bp.steps.filter((s) => s.engine).map((s) => [s.key, s.engine])).toEqual([
      ['reservar_stock', 'reserve_stock'],
      ['solicitar_compra', 'request_purchase'],
      ['ordenar_produccion', 'request_production'],
      ['coordinar_entrega_directa', 'request_direct_delivery'],
      ['planear_entrega', 'plan_delivery'],
    ]);
    for (const s of bp.steps) {
      expect(s.escalation).toEqual({
        afterMinutes: [0, 120, 480],
        ladder: ['backup', 'area_lead', 'administracion'],
      });
    }
  });
});

describe('instantiateSteps', () => {
  it('crea un paso por caso, por necesidad y por asignación según appliesTo, con scopeKey', () => {
    const steps = instantiateSteps(bp, withAllocations);
    expect(steps).toHaveLength(17);
    const scopes = (key: string) => steps.filter((s) => s.stepKey === key).map((s) => s.scopeKey);
    expect(scopes('verificar_disponibilidad')).toEqual(['d1', 'd2']);
    expect(scopes('reservar_stock')).toEqual(['a1']);
    expect(scopes('solicitar_compra')).toEqual(['a2']);
    expect(scopes('esperar_produccion')).toEqual(['a3']);
    expect(scopes('confirmar_entrega_directa')).toEqual(['a4']);
    expect(scopes('preparar_pedido')).toEqual(['']);
    const reserve = steps.find((s) => s.stepKey === 'reservar_stock')!;
    expect(reserve).toMatchObject({
      scope: 'allocation',
      demandId: 'd1',
      allocationId: 'a1',
      areaKey: 'inventario',
    });
  });

  it('resuelve dependencias del mismo alcance y del alcance padre', () => {
    const get = byKey(withAllocations);
    expect(get('verificar_disponibilidad', 'd1')!.dependsOn).toEqual([]);
    expect(get('plan_abastecimiento', 'd2')!.dependsOn).toEqual(['verificar_disponibilidad:d2']);
    expect(get('reservar_stock', 'a1')!.dependsOn).toEqual(['plan_abastecimiento:d1']);
    expect(get('esperar_recepcion', 'a2')!.dependsOn).toEqual(['solicitar_compra:a2']);
    expect(get('planear_entrega')!.dependsOn).toEqual(['preparar_pedido:']);
    expect(get('cierre_financiero')!.dependsOn).toEqual(['cierre_operativo:']);
  });

  it('un paso del caso espera a todas las asignaciones y a que se planeen todas las necesidades', () => {
    const get = byKey(withAllocations);
    expect(get('preparar_pedido')!.dependsOn).toEqual([
      'esperar_produccion:a3',
      'esperar_recepcion:a2',
      'ordenar_produccion:a3',
      'plan_abastecimiento:d1',
      'plan_abastecimiento:d2',
      'reservar_stock:a1',
      'solicitar_compra:a2',
      'verificar_disponibilidad:d1',
      'verificar_disponibilidad:d2',
    ]);
    expect(get('cierre_operativo')!.dependsOn).toEqual([
      'confirmar_entrega_directa:a4',
      'coordinar_entrega_directa:a4',
      'entregar:',
      'plan_abastecimiento:d1',
      'plan_abastecimiento:d2',
      'verificar_disponibilidad:d1',
      'verificar_disponibilidad:d2',
    ]);
  });

  it('antes del plan no hay pasos por asignación y la preparación espera los planes', () => {
    const input: InstantiateInput = {
      demands: [
        { id: 'd1', status: 'verifying' },
        { id: 'd2', status: 'pending' },
      ],
      allocations: [],
    };
    const steps = instantiateSteps(bp, input);
    expect(steps.filter((s) => s.scope === 'allocation')).toHaveLength(0);
    expect(steps.find((s) => s.stepKey === 'preparar_pedido')!.dependsOn).toEqual([
      'plan_abastecimiento:d1',
      'plan_abastecimiento:d2',
      'verificar_disponibilidad:d1',
      'verificar_disponibilidad:d2',
    ]);
  });

  it('ignora necesidades y asignaciones canceladas', () => {
    const steps = instantiateSteps(bp, {
      demands: [
        { id: 'd1', status: 'allocated' },
        { id: 'd2', status: 'cancelled' },
      ],
      allocations: [
        { id: 'a1', demandId: 'd1', source: 'stock', status: 'cancelled' },
        { id: 'a2', demandId: 'd1', source: 'stock', status: 'planned' },
        { id: 'a3', demandId: 'd2', source: 'purchase', status: 'planned' },
      ],
    });
    expect(
      steps.filter((s) => s.scopeKey === 'd2' || s.scopeKey === 'a1' || s.scopeKey === 'a3')
    ).toEqual([]);
    expect(steps.find((s) => s.stepKey === 'reservar_stock')!.scopeKey).toBe('a2');
  });

  it('es determinista: la misma entrada produce los mismos pasos', () => {
    expect(instantiateSteps(bp, withAllocations)).toEqual(instantiateSteps(bp, withAllocations));
  });
});

describe('referencias y dependencias', () => {
  it('stepRef y parseStepRef son inversas (también con scopeKey vacío)', () => {
    expect(stepRef('entregar', '')).toBe('entregar:');
    expect(parseStepRef('entregar:')).toEqual({ stepKey: 'entregar', scopeKey: '' });
    expect(parseStepRef(stepRef('reservar_stock', 'ck1'))).toEqual({
      stepKey: 'reservar_stock',
      scopeKey: 'ck1',
    });
  });

  it('una dependencia está cumplida si su paso terminó, se omitió, se canceló o ya no existe', () => {
    const statuses = new Map([
      ['a:', 'done'],
      ['b:', 'skipped'],
      ['c:', 'cancelled'],
      ['d:', 'ready'],
      ['e:', 'pending'],
    ]);
    expect(dependenciesSatisfied(['a:', 'b:', 'c:', 'zz:'], statuses)).toBe(true);
    expect(dependenciesSatisfied(['a:', 'd:'], statuses)).toBe(false);
    expect(dependenciesSatisfied(['e:'], statuses)).toBe(false);
    expect(dependenciesSatisfied([], statuses)).toBe(true);
  });

  it('sameDependencies no depende del orden', () => {
    expect(sameDependencies(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(sameDependencies(['a'], ['a', 'b'])).toBe(false);
  });
});
