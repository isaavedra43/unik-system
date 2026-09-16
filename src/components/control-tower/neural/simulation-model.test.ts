import { describe, expect, it } from 'vitest';
import type { CaseSimulation, SimulatedStep } from '@/modules/control-tower/simulation';
import { normalizeScenario } from '@/modules/control-tower/simulation';
import {
  capacityError,
  capacityLabel,
  capacityOptions,
  criticalPathLabels,
  delayError,
  delayOptions,
  describeScenario,
  diffRows,
  emptyScenario,
  factorToPercent,
  percentToFactor,
  scenarioIsEmpty,
  simulationTiles,
  toScenarioPayload,
} from './simulation-model';

function step(partial: Partial<SimulatedStep> & { ref: string }): SimulatedStep {
  return {
    stepKey: partial.ref,
    scopeKey: '',
    label: partial.ref,
    areaKey: 'compras',
    areaLabel: 'Compras',
    status: 'pending',
    durationMin: 60,
    baselineFinish: '2026-03-01T10:00:00.000Z',
    scenarioFinish: '2026-03-01T10:00:00.000Z',
    shiftMinutes: 0,
    slackMin: 0,
    critical: false,
    ...partial,
  };
}

function simulation(partial: Partial<CaseSimulation> = {}): CaseSimulation {
  return {
    caseId: 'c1',
    caseNumber: 'EXP-1',
    processKey: 'sales_fulfillment',
    start: '2026-03-01T08:00:00.000Z',
    baselineFinish: '2026-03-01T18:00:00.000Z',
    scenarioFinish: '2026-03-01T20:00:00.000Z',
    shiftMinutes: 120,
    promisedAt: '2026-03-01T19:00:00.000Z',
    lateBefore: false,
    lateAfter: true,
    steps: [],
    criticalPath: [],
    measuredSteps: 0,
    scenario: { delays: [], capacity: [] },
    ...partial,
  };
}

describe('escenario', () => {
  it('empieza vacío', () => {
    expect(scenarioIsEmpty(emptyScenario())).toBe(true);
  });

  it('descarta retrasos de cero y capacidades sin cambio', () => {
    const payload = toScenarioPayload({
      delays: { comprar: 0, producir: 120, '': 30 },
      capacity: { compras: 1, logistica: 0.5 },
    });
    expect(payload.delays).toEqual([{ stepKey: 'producir', minutes: 120 }]);
    expect(payload.capacity).toEqual([{ areaKey: 'logistica', factor: 0.5 }]);
  });

  it('acota igual que el servidor', () => {
    const payload = toScenarioPayload({
      delays: { producir: 999_999 },
      capacity: { compras: 50, ventas: 0.01 },
    });
    expect(payload.delays[0]?.minutes).toBe(43_200);
    expect(payload.capacity.find((entry) => entry.areaKey === 'compras')?.factor).toBe(10);
    expect(payload.capacity.find((entry) => entry.areaKey === 'ventas')?.factor).toBe(0.1);
  });

  it('el escenario que se envía sobrevive intacto a la normalización del motor', () => {
    const payload = toScenarioPayload({
      delays: { producir: 120 },
      capacity: { logistica: 0.5 },
    });
    expect(normalizeScenario(payload)).toEqual(payload);
  });

  it('valida lo que escribe la persona', () => {
    expect(delayError(30)).toBeNull();
    expect(delayError(-1)).toContain('negativo');
    expect(delayError(50_000)).toContain('30 días');
    expect(delayError(Number.NaN)).toContain('minutos');
    expect(capacityError(1.5)).toBeNull();
    expect(capacityError(0.05)).toContain('mínima');
    expect(capacityError(20)).toContain('máxima');
  });

  it('traduce el factor a lenguaje de operación', () => {
    expect(capacityLabel(1)).toBe('igual que hoy');
    expect(capacityLabel(2)).toBe('50 % más rápido');
    expect(capacityLabel(0.5)).toBe('100 % más lento');
    expect(factorToPercent(0.5)).toBe(50);
    expect(percentToFactor(150)).toBe(1.5);
  });

  it('describe el escenario con las etiquetas del proceso', () => {
    const text = describeScenario(
      { delays: { producir: 120 }, capacity: { logistica: 0.5 } },
      new Map([['producir', 'Producir']])
    );
    expect(text).toContain('Producir +2 h');
    expect(text).toContain('Logística 100 % más lento');
    expect(describeScenario(emptyScenario())).toContain('Sin cambios');
  });
});

describe('diferencias', () => {
  it('ordena por lo que más se movió y marca lo crítico', () => {
    const rows = diffRows(
      simulation({
        steps: [
          step({ ref: 'a', label: 'A', shiftMinutes: 0 }),
          step({ ref: 'b', label: 'B', shiftMinutes: 120, critical: true }),
          step({ ref: 'c', label: 'C', shiftMinutes: 30 }),
        ],
      })
    );
    expect(rows.map((row) => row.ref)).toEqual(['b', 'c', 'a']);
    expect(rows[0]?.tone).toBe('danger');
    expect(rows[1]?.tone).toBe('warning');
    expect(rows[2]?.changed).toBe(false);
    expect(rows[2]?.shiftLabel).toBe('Sin cambio');
  });

  it('un paso sin holgura lo dice', () => {
    const rows = diffRows(simulation({ steps: [step({ ref: 'a', critical: true, slackMin: 0 })] }));
    expect(rows[0]?.slackLabel).toBe('Sin holgura');
  });

  it('sin simulación no hay filas', () => {
    expect(diffRows(null)).toEqual([]);
  });
});

describe('tiles del resultado', () => {
  const format = (value: string | null) => value ?? 'Sin fecha';

  it('avisa cuando el escenario rompe la promesa', () => {
    const tiles = simulationTiles(simulation(), format);
    const promise = tiles.find((tile) => tile.key === 'promise');
    expect(promise?.tone).toBe('danger');
    expect(promise?.hint).toContain('El escenario la incumple');
  });

  it('no inventa problema cuando nada se mueve', () => {
    const tiles = simulationTiles(
      simulation({ shiftMinutes: 0, lateAfter: false, scenarioFinish: '2026-03-01T18:00:00.000Z' }),
      format
    );
    expect(tiles.find((tile) => tile.key === 'shift')?.value).toBe('Nada');
    expect(tiles.find((tile) => tile.key === 'finish')?.tone).toBe('default');
  });

  it('dice cuántos pasos tienen historia medida', () => {
    const tiles = simulationTiles(
      simulation({ measuredSteps: 0, steps: [step({ ref: 'a' })] }),
      format
    );
    const measured = tiles.find((tile) => tile.key === 'measured');
    expect(measured?.value).toBe('0 de 1');
    expect(measured?.tone).toBe('warning');
  });

  it('sin simulación no hay tiles', () => {
    expect(simulationTiles(null, format)).toEqual([]);
  });
});

describe('opciones del formulario', () => {
  const sim = simulation({
    steps: [
      step({
        ref: 'comprar:1',
        stepKey: 'comprar',
        label: 'Comprar',
        areaKey: 'compras',
        areaLabel: 'Compras',
      }),
      step({
        ref: 'comprar:2',
        stepKey: 'comprar',
        label: 'Comprar',
        areaKey: 'compras',
        areaLabel: 'Compras',
      }),
      step({
        ref: 'entregar',
        stepKey: 'entregar',
        label: 'Entregar',
        areaKey: 'logistica',
        areaLabel: 'Logística',
      }),
    ],
    criticalPath: ['comprar:1', 'entregar'],
  });

  it('el selector de retrasos no repite la misma clave de paso', () => {
    expect(delayOptions(sim).map((option) => option.stepKey)).toEqual(['comprar', 'entregar']);
  });

  it('las áreas salen por cuántos pasos aportan', () => {
    expect(capacityOptions(sim)).toEqual([
      { areaKey: 'compras', label: 'Compras', steps: 2 },
      { areaKey: 'logistica', label: 'Logística', steps: 1 },
    ]);
  });

  it('el camino crítico se muestra con etiquetas, no con refs', () => {
    expect(criticalPathLabels(sim)).toEqual(['Comprar', 'Entregar']);
    expect(criticalPathLabels(null)).toEqual([]);
  });
});
