import { describe, expect, it } from 'vitest';
import { layoutProcess } from '@/modules/control-tower/process-layout';
import type { StepMetricRow } from '@/modules/control-tower/variants';
import {
  buildProcessView,
  describeStep,
  formatShortMinutes,
  processStepRows,
  stepBadges,
  stepMetricMap,
} from './process-model';

const STEPS = [
  { key: 'cotizar', label: 'Cotizar', areaKey: 'ventas', dependsOn: [] },
  { key: 'comprar', label: 'Comprar material', areaKey: 'compras', dependsOn: ['cotizar'] },
  { key: 'producir', label: 'Producir', areaKey: 'manufactura', dependsOn: ['comprar'] },
  { key: 'entregar', label: 'Entregar', areaKey: 'logistica', dependsOn: ['producir', 'cotizar'] },
];

function metric(partial: Partial<StepMetricRow> & { stepKey: string }): StepMetricRow {
  return {
    areaKey: 'compras',
    started: 0,
    completed: 0,
    p50ActiveMin: null,
    p90ActiveMin: null,
    p50WaitMin: null,
    p90WaitMin: null,
    breached: 0,
    reworked: 0,
    ...partial,
  };
}

describe('stepMetricMap', () => {
  it('calcula los porcentajes sobre lo iniciado', () => {
    const map = stepMetricMap([
      metric({ stepKey: 'comprar', started: 20, breached: 5, reworked: 2 }),
    ]);
    const row = map.get('comprar');
    expect(row?.breachPct).toBe(25);
    expect(row?.reworkPct).toBe(10);
    expect(row?.tone).toBe('danger');
  });

  it('sin pasos iniciados no inventa un 0 %', () => {
    const map = stepMetricMap([metric({ stepKey: 'comprar', started: 0, breached: 0 })]);
    expect(map.get('comprar')?.breachPct).toBeNull();
    expect(map.get('comprar')?.tone).toBe('default');
  });
});

describe('buildProcessView', () => {
  const layout = layoutProcess(STEPS);

  it('conserva el acomodo y le pega las métricas', () => {
    const view = buildProcessView({
      layout,
      metrics: [metric({ stepKey: 'comprar', areaKey: 'compras', started: 10, p50ActiveMin: 90 })],
    });
    expect(view.steps).toHaveLength(4);
    const comprar = view.steps.find((step) => step.key === 'comprar');
    expect(comprar?.metrics?.p50ActiveMin).toBe(90);
    expect(comprar?.areaLabel).toBe('Compras');
    expect(view.steps.find((step) => step.key === 'entregar')?.metrics).toBeNull();
    expect(view.edges).toHaveLength(4);
  });

  it('sin variante seleccionada nada se atenúa', () => {
    const view = buildProcessView({ layout });
    expect(view.steps.every((step) => !step.dimmed && !step.highlighted)).toBe(true);
    expect(view.edges.every((edge) => !edge.dimmed && !edge.onPath)).toBe(true);
  });

  it('resalta el camino de la variante y atenúa el resto', () => {
    const view = buildProcessView({ layout, path: ['cotizar', 'comprar', 'producir'] });
    const highlighted = view.steps.filter((step) => step.highlighted).map((step) => step.key);
    expect(highlighted.sort()).toEqual(['comprar', 'cotizar', 'producir']);
    expect(view.steps.find((step) => step.key === 'entregar')?.dimmed).toBe(true);
    expect(view.steps.find((step) => step.key === 'comprar')?.sequenceIndex).toBe(2);
    const onPath = view.edges.filter((edge) => edge.onPath).map((edge) => edge.id);
    expect(onPath).toContain('cotizar->comprar');
    expect(onPath).not.toContain('producir->entregar');
  });

  it('reporta los pasos de la variante que el proceso ya no define', () => {
    const view = buildProcessView({ layout, path: ['cotizar', 'paso_viejo'] });
    expect(view.unknownPathSteps).toEqual(['paso_viejo']);
  });

  it('lista las áreas presentes para la leyenda, sin repetir', () => {
    const view = buildProcessView({ layout });
    expect(view.areaKeys).toEqual(['ventas', 'compras', 'manufactura', 'logistica']);
  });

  it('las filas salen en orden de lectura del proceso', () => {
    const rows = processStepRows(buildProcessView({ layout }));
    expect(rows[0]?.key).toBe('cotizar');
    expect(rows.at(-1)?.key).toBe('entregar');
    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1]!;
      const current = rows[i]!;
      expect(
        current.layer > previous.layer ||
          (current.layer === previous.layer && current.order >= previous.order)
      ).toBe(true);
    }
  });
});

describe('insignias del nodo', () => {
  it('sin métricas no hay insignias (no se inventan ceros)', () => {
    expect(stepBadges(null)).toEqual([]);
  });

  it('sólo muestra lo medido', () => {
    const map = stepMetricMap([
      metric({ stepKey: 'comprar', started: 4, p50ActiveMin: 30, breached: 1 }),
    ]);
    const badges = stepBadges(map.get('comprar') ?? null);
    expect(badges.map((badge) => badge.key)).toEqual(['active', 'breach']);
    expect(badges[0]?.value).toBe('30m');
    expect(badges[1]?.value).toBe('25%');
  });
});

describe('formatShortMinutes', () => {
  it('compacta para que quepa en una insignia', () => {
    expect(formatShortMinutes(null)).toBe('—');
    expect(formatShortMinutes(30)).toBe('30m');
    expect(formatShortMinutes(150)).toBe('2.5h');
    expect(formatShortMinutes(2880)).toBe('2d');
  });
});

describe('describeStep', () => {
  it('un paso sin historia lo dice, no finge medición', () => {
    const view = buildProcessView({ layout: layoutProcess(STEPS) });
    const text = describeStep(view.steps.find((step) => step.key === 'entregar')!);
    expect(text).toContain('Entregar');
    expect(text).toContain('sin mediciones');
  });

  it('un paso de la variante dice su posición', () => {
    const view = buildProcessView({
      layout: layoutProcess(STEPS),
      path: ['cotizar', 'comprar'],
      metrics: [metric({ stepKey: 'comprar', started: 8, p50ActiveMin: 12, breached: 2 })],
    });
    const text = describeStep(view.steps.find((step) => step.key === 'comprar')!);
    expect(text).toContain('paso 2 de la variante');
    expect(text).toContain('8 iniciados');
    expect(text).toContain('25%');
  });
});
