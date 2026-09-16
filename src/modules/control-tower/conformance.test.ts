import { describe, expect, it } from 'vitest';
import {
  checkConformance,
  finalSteps,
  isOptionalStep,
  stepLabels,
  toConformanceDefinition,
  type ConformanceDefinition,
} from './conformance';

/**
 * Conformidad contra el blueprint. Lo que se prueba es la REGLA de negocio:
 * saltarse un paso opcional NO es una desviación, completar algo fuera de orden
 * SÍ lo es, y repetir un paso es retrabajo (se cuenta aparte, no aquí).
 */

const DEFINITION: ConformanceDefinition = {
  processKey: 'sales_fulfillment',
  version: 1,
  steps: [
    { key: 'verificar', label: 'Verificar disponibilidad', dependsOn: [] },
    { key: 'plan', label: 'Plan de abastecimiento', dependsOn: ['verificar'] },
    {
      key: 'reservar',
      label: 'Reservar existencia',
      dependsOn: ['plan'],
      appliesTo: ['stock'],
    },
    {
      key: 'comprar',
      label: 'Solicitar compra',
      dependsOn: ['plan'],
      appliesTo: ['purchase'],
    },
    { key: 'preparar', label: 'Preparar pedido', dependsOn: ['plan'] },
    { key: 'entregar', label: 'Entregar', dependsOn: ['preparar'] },
    {
      key: 'facturar',
      label: 'Facturar',
      dependsOn: ['entregar'],
      entryCondition: 'requiere_factura',
    },
  ],
};

describe('isOptionalStep / finalSteps', () => {
  it('marca opcionales los pasos por fuente de asignación y los condicionados', () => {
    expect(isOptionalStep(DEFINITION.steps[2])).toBe(true); // appliesTo
    expect(isOptionalStep(DEFINITION.steps[6])).toBe(true); // entryCondition
    expect(isOptionalStep(DEFINITION.steps[0])).toBe(false);
  });

  it('los pasos finales son los que nadie declara como dependencia', () => {
    expect(finalSteps(DEFINITION.steps).map((step) => step.key)).toEqual([
      'reservar',
      'comprar',
      'facturar',
    ]);
  });
});

describe('checkConformance', () => {
  it('un camino normal es conforme aunque se salte los pasos opcionales', () => {
    const result = checkConformance(DEFINITION, [
      'verificar',
      'plan',
      'reservar',
      'preparar',
      'entregar',
    ]);
    expect(result.conformant).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.covered).toBe(5);
    expect(result.defined).toBe(7);
    expect(result.coverage).toBeCloseTo(0.714, 3);
  });

  it('una dependencia que nunca ocurrió NO es desviación (el paso se saltó a propósito)', () => {
    const result = checkConformance(DEFINITION, ['verificar', 'plan', 'preparar', 'entregar']);
    expect(result.conformant).toBe(true);
  });

  it('detecta un paso completado antes que su dependencia', () => {
    const result = checkConformance(DEFINITION, ['plan', 'verificar', 'preparar']);
    expect(result.conformant).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ kind: 'out_of_order', stepKey: 'plan' });
    expect(result.violations[0].detail).toContain('Verificar disponibilidad');
  });

  it('detecta un paso que la versión del proceso no define, y lo reporta una sola vez', () => {
    const result = checkConformance(DEFINITION, [
      'verificar',
      'paso_fantasma',
      'plan',
      'paso_fantasma',
    ]);
    expect(result.violations.filter((v) => v.kind === 'unknown_step')).toHaveLength(1);
    expect(result.violations[0].detail).toContain('sales_fulfillment@1');
    expect(result.covered).toBe(2); // el fantasma no cuenta como cobertura
  });

  it('en un expediente cerrado exige los pasos finales obligatorios, no los opcionales', () => {
    const result = checkConformance(DEFINITION, ['verificar', 'plan', 'preparar'], {
      closed: true,
    });
    // `facturar` es condicionado y `reservar`/`comprar` son por fuente: ninguno se exige.
    expect(result.violations.map((v) => v.kind)).toEqual([]);
    expect(result.conformant).toBe(true);
  });

  it('un final obligatorio que falta sí se reporta al cerrar', () => {
    const definition: ConformanceDefinition = {
      processKey: 'p',
      version: 2,
      steps: [
        { key: 'a', label: 'Uno', dependsOn: [] },
        { key: 'b', label: 'Dos', dependsOn: ['a'] },
      ],
    };
    const open = checkConformance(definition, ['a']);
    expect(open.conformant).toBe(true);
    const closed = checkConformance(definition, ['a'], { closed: true });
    expect(closed.conformant).toBe(false);
    expect(closed.violations[0]).toMatchObject({ kind: 'missing_final', stepKey: 'b' });
    expect(closed.violations[0].detail).toContain('Dos');
  });

  it('repetir un paso no es desviación (eso es retrabajo)', () => {
    const result = checkConformance(DEFINITION, ['verificar', 'plan', 'verificar', 'preparar']);
    expect(result.conformant).toBe(true);
    expect(result.observed).toBe(4);
    expect(result.covered).toBe(3);
  });

  it('el mismo paso en necesidades distintas (scopeKey) no se confunde entre sí', () => {
    const result = checkConformance(DEFINITION, [
      { stepKey: 'verificar', scopeKey: 'd1' },
      { stepKey: 'verificar', scopeKey: 'd2' },
      { stepKey: 'plan', scopeKey: 'd2' },
    ]);
    expect(result.conformant).toBe(true);
    expect(result.observed).toBe(3);
    expect(result.covered).toBe(2);
  });

  it('ignora entradas vacías y una definición sin pasos no divide entre cero', () => {
    const result = checkConformance({ processKey: 'x', version: 1, steps: [] }, [
      '',
      '   ',
      'algo',
    ]);
    expect(result.defined).toBe(0);
    expect(result.coverage).toBe(0);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('unknown_step');
  });
});

describe('toConformanceDefinition', () => {
  it('lee el JSON guardado en ProcessVersion.definition', () => {
    const definition = toConformanceDefinition({
      processKey: 'sales_fulfillment',
      version: 1,
      steps: [
        { key: 'a', label: 'A', dependsOn: ['z'], appliesTo: ['stock'], scope: 'demand' },
        { key: 'b', dependsOn: null, entryCondition: 'cond' },
        { nope: true },
      ],
    });
    expect(definition).not.toBeNull();
    expect(definition!.steps.map((step) => step.key)).toEqual(['a', 'b']);
    expect(definition!.steps[0].dependsOn).toEqual(['z']);
    expect(definition!.steps[1].dependsOn).toEqual([]);
    expect(definition!.steps[1].entryCondition).toBe('cond');
  });

  it('devuelve null cuando el JSON no tiene la forma esperada (la proyección salta el caso)', () => {
    expect(toConformanceDefinition(null)).toBeNull();
    expect(toConformanceDefinition('texto')).toBeNull();
    expect(toConformanceDefinition([])).toBeNull();
    expect(toConformanceDefinition({ processKey: 'p' })).toBeNull();
    expect(toConformanceDefinition({ processKey: 'p', steps: [] })).toBeNull();
    expect(toConformanceDefinition({ steps: [{ key: 'a' }] })).toBeNull();
  });
});

describe('stepLabels', () => {
  it('mapea clave → etiqueta y cae en la clave cuando no hay etiqueta', () => {
    const labels = stepLabels({
      processKey: 'p',
      version: 1,
      steps: [
        { key: 'a', label: 'Alfa', dependsOn: [] },
        { key: 'b', dependsOn: [] },
      ],
    });
    expect(labels.get('a')).toBe('Alfa');
    expect(labels.get('b')).toBe('b');
  });
});
