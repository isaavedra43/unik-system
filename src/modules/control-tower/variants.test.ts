import { describe, expect, it } from 'vitest';
import {
  VARIANT_SEQUENCE_LIMIT,
  countRework,
  describeVariant,
  normalizeSequence,
  percentile,
  rankBottlenecks,
  summarizeVariants,
  variantHash,
  type StepMetricRow,
  type VariantCaseRow,
} from './variants';

/**
 * Variantes, retrabajo y cuellos de botella. El hash tiene que ser ESTABLE
 * (mismo camino ⇒ misma fila de la tabla, entre corridas y entre máquinas) y
 * SENSIBLE AL ORDEN (dos expedientes que hicieron lo mismo en otro orden son
 * variantes distintas: eso es justamente lo que se quiere ver).
 */

describe('normalizeSequence', () => {
  it('quita vacíos, recorta espacios y conserva el orden', () => {
    expect(normalizeSequence([' a ', '', null, 'b', undefined, '  ', 'c'])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('respeta el tope de pasos', () => {
    const long = Array.from({ length: VARIANT_SEQUENCE_LIMIT + 50 }, (_, i) => `p${i}`);
    expect(normalizeSequence(long)).toHaveLength(VARIANT_SEQUENCE_LIMIT);
  });
});

describe('variantHash', () => {
  it('es estable: el mismo camino siempre da el mismo hash', () => {
    const a = variantHash(['verificar', 'plan', 'entregar']);
    const b = variantHash(['verificar', 'plan', 'entregar']);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('cambia con el orden (otro camino es otra variante)', () => {
    expect(variantHash(['a', 'b'])).not.toBe(variantHash(['b', 'a']));
  });

  it('no se altera por espacios ni por entradas vacías', () => {
    expect(variantHash([' a ', '', 'b'])).toBe(variantHash(['a', 'b']));
  });

  it('una secuencia vacía tiene su propio hash y no truena', () => {
    expect(variantHash([])).toMatch(/^[0-9a-f]{16}$/);
    expect(variantHash([])).not.toBe(variantHash(['a']));
  });

  it('distingue la repetición de un paso', () => {
    expect(variantHash(['a', 'a', 'b'])).not.toBe(variantHash(['a', 'b']));
  });
});

describe('describeVariant', () => {
  const labels = new Map([
    ['verificar', 'Verificar disponibilidad'],
    ['plan', 'Plan de abastecimiento'],
  ]);

  it('usa las etiquetas y une con flechas', () => {
    expect(describeVariant(['verificar', 'plan'], labels)).toBe(
      'Verificar disponibilidad → Plan de abastecimiento'
    );
  });

  it('cae en la clave cuando no hay etiqueta', () => {
    expect(describeVariant(['otro'], labels)).toBe('otro');
  });

  it('recorta los caminos largos diciendo cuántos pasos tiene', () => {
    const long = Array.from({ length: 12 }, (_, i) => `p${i}`);
    expect(describeVariant(long, undefined, 3)).toBe('p0 → p1 → p2 → … (12 pasos)');
  });

  it('lo dice en español cuando no hubo pasos', () => {
    expect(describeVariant([])).toBe('Sin pasos completados');
  });
});

describe('countRework', () => {
  it('no cuenta retrabajo cuando cada paso se activó una vez', () => {
    expect(countRework([{ stepKey: 'a' }, { stepKey: 'b' }])).toEqual({ count: 0, steps: [] });
  });

  it('cuenta las activaciones EXTRA, no las activaciones', () => {
    const result = countRework([
      { stepKey: 'a' },
      { stepKey: 'a' },
      { stepKey: 'a' },
      { stepKey: 'b' },
      { stepKey: 'b' },
    ]);
    expect(result.count).toBe(3); // a: 2 extra, b: 1 extra
    expect(result.steps).toEqual([
      { stepKey: 'a', activations: 2 },
      { stepKey: 'b', activations: 1 },
    ]);
  });

  it('el mismo paso en necesidades distintas NO es retrabajo', () => {
    const result = countRework([
      { stepKey: 'verificar', scopeKey: 'd1' },
      { stepKey: 'verificar', scopeKey: 'd2' },
      { stepKey: 'verificar', scopeKey: 'd3' },
    ]);
    expect(result.count).toBe(0);
  });

  it('el mismo paso en la MISMA necesidad sí lo es', () => {
    const result = countRework([
      { stepKey: 'verificar', scopeKey: 'd1' },
      { stepKey: 'verificar', scopeKey: 'd1' },
    ]);
    expect(result.count).toBe(1);
    expect(result.steps).toEqual([{ stepKey: 'verificar', activations: 1 }]);
  });

  it('ignora entradas sin clave de paso', () => {
    expect(countRework([{ stepKey: '  ' }, { stepKey: '' }]).count).toBe(0);
  });
});

describe('percentile', () => {
  it('devuelve null sin datos', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([Number.NaN], 0.5)).toBeNull();
  });

  it('interpola linealmente', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 1)).toBe(40);
  });

  it('con un solo valor devuelve ese valor', () => {
    expect(percentile([7], 0.9)).toBe(7);
  });
});

describe('summarizeVariants', () => {
  const rows: VariantCaseRow[] = [
    {
      caseId: 'c1',
      variantHash: 'h1',
      sequence: ['a', 'b'],
      durationMin: 100,
      conformant: true,
      reworkCount: 0,
    },
    {
      caseId: 'c2',
      variantHash: 'h1',
      sequence: ['a', 'b'],
      durationMin: 200,
      conformant: true,
      reworkCount: 1,
    },
    {
      caseId: 'c3',
      variantHash: 'h1',
      sequence: ['a', 'b'],
      durationMin: null,
      conformant: false,
      reworkCount: 0,
    },
    {
      caseId: 'c4',
      variantHash: 'h2',
      sequence: ['a'],
      durationMin: 50,
      conformant: true,
      reworkCount: 0,
    },
  ];

  it('agrupa por hash, de la variante más frecuente a la menos', () => {
    const summary = summarizeVariants(rows);
    expect(summary.map((row) => row.variantHash)).toEqual(['h1', 'h2']);
    expect(summary[0].cases).toBe(3);
    expect(summary[0].sharePct).toBe(75);
    expect(summary[1].sharePct).toBe(25);
  });

  it('los percentiles ignoran a los expedientes abiertos (duración null)', () => {
    const [first] = summarizeVariants(rows);
    expect(first.p50DurationMin).toBe(150);
    expect(first.p90DurationMin).toBe(190);
  });

  it('reporta conformidad y retrabajo por variante', () => {
    const [first] = summarizeVariants(rows);
    expect(first.conformantCases).toBe(2);
    expect(first.conformancePct).toBeCloseTo(66.7, 1);
    expect(first.reworkCases).toBe(1);
    expect(first.exampleCaseIds).toEqual(['c1', 'c2', 'c3']);
  });

  it('sin filas devuelve una lista vacía y no divide entre cero', () => {
    expect(summarizeVariants([])).toEqual([]);
  });
});

describe('rankBottlenecks', () => {
  const metric = (over: Partial<StepMetricRow>): StepMetricRow => ({
    stepKey: 'x',
    areaKey: 'ventas',
    started: 0,
    completed: 0,
    p50ActiveMin: null,
    p90ActiveMin: null,
    p50WaitMin: null,
    p90WaitMin: null,
    breached: 0,
    reworked: 0,
    ...over,
  });

  it('ordena por espera acumulada (p90 × iniciados), no por espera de un caso', () => {
    const ranking = rankBottlenecks([
      metric({ stepKey: 'lento_raro', started: 1, completed: 1, p90WaitMin: 5_000 }),
      metric({ stepKey: 'comun', started: 500, completed: 500, p90WaitMin: 60 }),
    ]);
    expect(ranking.map((row) => row.stepKey)).toEqual(['comun', 'lento_raro']);
    expect(ranking[0].impactMin).toBe(30_000);
  });

  it('suma los días del mismo paso y se queda con el peor percentil', () => {
    const ranking = rankBottlenecks([
      metric({ stepKey: 'a', started: 10, completed: 8, breached: 2, p90WaitMin: 30 }),
      metric({ stepKey: 'a', started: 5, completed: 4, breached: 1, p90WaitMin: 90 }),
    ]);
    expect(ranking).toHaveLength(1);
    expect(ranking[0].started).toBe(15);
    expect(ranking[0].completed).toBe(12);
    expect(ranking[0].breached).toBe(3);
    expect(ranking[0].p90WaitMin).toBe(90);
    expect(ranking[0].breachPct).toBe(25);
  });

  it('cuando no hay espera medida usa el tiempo activo', () => {
    const ranking = rankBottlenecks([
      metric({ stepKey: 'a', started: 10, completed: 10, p90ActiveMin: 12 }),
    ]);
    expect(ranking[0].impactMin).toBe(120);
  });

  it('respeta el tope y usa las etiquetas', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      metric({ stepKey: `p${i}`, started: i + 1, p90WaitMin: 10 })
    );
    const ranking = rankBottlenecks(rows, new Map([['p19', 'Paso 19']]), 3);
    expect(ranking).toHaveLength(3);
    expect(ranking[0].label).toBe('Paso 19');
  });

  it('un paso sin cierres no divide entre cero', () => {
    const ranking = rankBottlenecks([
      metric({ stepKey: 'a', started: 3, completed: 0, breached: 0 }),
    ]);
    expect(ranking[0].breachPct).toBe(0);
  });
});
