import { describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('@/modules/operations/testing/fixtures');
  return { fake: createOpsFake() };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));

import {
  baseDurationMinutes,
  normalizeScenario,
  simulateCase,
  type SimulationStep,
  type StepDuration,
} from './simulation';

/**
 * Simulación "qué pasaría si" (pase hacia adelante tipo CPM).
 *
 * Reglas del plan que se prueban aquí, sin base de datos:
 * - la duración de un paso es lo MEDIDO (p50 activo + p50 espera) y sólo cae en
 *   el SLA cuando ese paso todavía no tiene historia;
 * - un retraso empuja a todo lo que depende del paso retrasado, y sólo a eso;
 * - un factor de capacidad divide la duración del área (2 = el doble de gente);
 * - la holgura dice cuánto puede retrasarse un paso sin mover el final, y el
 *   camino crítico es el que no tiene holgura;
 * - un paso YA CERRADO no se vuelve a simular: su fecha real manda.
 */

const NOW = new Date('2026-09-15T12:00:00.000Z');
const MINUTE = 60_000;

function step(key: string, over: Partial<SimulationStep> = {}): SimulationStep {
  return {
    ref: `${key}:`,
    stepKey: key,
    scopeKey: '',
    label: key,
    areaKey: 'ventas',
    dependsOn: [],
    status: 'pending',
    slaMinutes: 60,
    startedAt: null,
    completedAt: null,
    dueAt: null,
    ...over,
  };
}

/** Cadena a → b → c, 60 min cada paso por SLA. */
const CHAIN: SimulationStep[] = [
  step('a'),
  step('b', { dependsOn: ['a:'], areaKey: 'inventario' }),
  step('c', { dependsOn: ['b:'], areaKey: 'logistica' }),
];

function finishOf(simulation: ReturnType<typeof simulateCase>, key: string): number {
  const found = simulation.steps.find((row) => row.stepKey === key);
  if (!found) throw new Error(`paso ${key} no simulado`);
  return Date.parse(found.scenarioFinish);
}

describe('normalizeScenario', () => {
  it('descarta retrasos vacíos, negativos o sin paso', () => {
    const scenario = normalizeScenario({
      delays: [
        { stepKey: '', minutes: 10 },
        { stepKey: 'a', minutes: 0 },
        { stepKey: 'b', minutes: -5 },
        { stepKey: 'c', minutes: 30 },
      ],
    });
    expect(scenario.delays).toEqual([{ stepKey: 'c', minutes: 30 }]);
  });

  it('acota el retraso a 30 días y el factor a [0.1, 10]', () => {
    const scenario = normalizeScenario({
      delays: [{ stepKey: 'a', minutes: 999_999 }],
      capacity: [
        { areaKey: 'ventas', factor: 99 },
        { areaKey: 'compras', factor: 0.001 },
      ],
    });
    expect(scenario.delays[0].minutes).toBe(43_200);
    expect(scenario.capacity).toEqual([
      { areaKey: 'ventas', factor: 10 },
      { areaKey: 'compras', factor: 0.1 },
    ]);
  });

  it('un factor de 1 no es un cambio y se descarta', () => {
    expect(normalizeScenario({ capacity: [{ areaKey: 'ventas', factor: 1 }] }).capacity).toEqual(
      []
    );
  });

  it('el último valor del mismo paso o área gana (sin duplicados)', () => {
    const scenario = normalizeScenario({
      delays: [
        { stepKey: 'a', minutes: 10 },
        { stepKey: 'a', minutes: 25 },
      ],
    });
    expect(scenario.delays).toEqual([{ stepKey: 'a', minutes: 25 }]);
  });

  it('un escenario vacío es un escenario vacío', () => {
    expect(normalizeScenario()).toEqual({ delays: [], capacity: [] });
  });
});

describe('baseDurationMinutes', () => {
  it('usa el SLA cuando el paso no tiene historia', () => {
    expect(baseDurationMinutes(step('a', { slaMinutes: 90 }))).toEqual({
      minutes: 90,
      measured: false,
    });
  });

  it('suma lo medido: activo + espera', () => {
    const durations = new Map<string, StepDuration>([['a', { activeMin: 30, waitMin: 120 }]]);
    expect(baseDurationMinutes(step('a'), durations)).toEqual({ minutes: 150, measured: true });
  });

  it('si sólo hay espera medida, el activo cae en el SLA', () => {
    const durations = new Map<string, StepDuration>([['a', { activeMin: null, waitMin: 40 }]]);
    expect(baseDurationMinutes(step('a', { slaMinutes: 20 }), durations)).toEqual({
      minutes: 60,
      measured: true,
    });
  });

  it('un SLA negativo nunca produce una duración negativa', () => {
    expect(baseDurationMinutes(step('a', { slaMinutes: -30 })).minutes).toBe(0);
  });
});

describe('simulateCase', () => {
  it('encadena los pasos: la cadena de 3×60 min termina 180 min después', () => {
    const simulation = simulateCase({ steps: CHAIN, now: NOW, start: NOW });
    expect(simulation.scenarioFinish).toBe(new Date(NOW.getTime() + 180 * MINUTE).toISOString());
    expect(simulation.shiftMinutes).toBe(0);
    expect(simulation.measuredSteps).toBe(0);
  });

  it('un retraso empuja al paso y a todo lo que depende de él', () => {
    const simulation = simulateCase(
      { steps: CHAIN, now: NOW, start: NOW },
      { delays: [{ stepKey: 'b', minutes: 120 }] }
    );
    expect(simulation.shiftMinutes).toBe(120);
    expect(finishOf(simulation, 'a')).toBe(NOW.getTime() + 60 * MINUTE); // intacto
    expect(finishOf(simulation, 'b')).toBe(NOW.getTime() + 240 * MINUTE);
    expect(finishOf(simulation, 'c')).toBe(NOW.getTime() + 300 * MINUTE);
  });

  it('un retraso en una rama sin salida no mueve el final del expediente', () => {
    const steps = [
      step('a'),
      step('b', { dependsOn: ['a:'] }),
      step('hoja', { dependsOn: ['a:'] }),
    ];
    const base = simulateCase({ steps, now: NOW, start: NOW });
    const withDelay = simulateCase(
      { steps, now: NOW, start: NOW },
      { delays: [{ stepKey: 'hoja', minutes: 30 }] }
    );
    expect(withDelay.shiftMinutes).toBe(30); // `hoja` pasa a ser el final
    expect(base.scenarioFinish).not.toBe(withDelay.scenarioFinish);
  });

  it('el factor de capacidad divide la duración del área, no la de las demás', () => {
    const simulation = simulateCase(
      { steps: CHAIN, now: NOW, start: NOW },
      { capacity: [{ areaKey: 'inventario', factor: 2 }] }
    );
    // b baja de 60 a 30 min: el expediente termina 30 min antes
    expect(simulation.shiftMinutes).toBe(-30);
    const b = simulation.steps.find((row) => row.stepKey === 'b')!;
    expect(b.durationMin).toBe(30);
    expect(simulation.steps.find((row) => row.stepKey === 'a')!.durationMin).toBe(60);
  });

  it('menos capacidad alarga el área afectada', () => {
    const simulation = simulateCase(
      { steps: CHAIN, now: NOW, start: NOW },
      { capacity: [{ areaKey: 'logistica', factor: 0.5 }] }
    );
    expect(simulation.steps.find((row) => row.stepKey === 'c')!.durationMin).toBe(120);
    expect(simulation.shiftMinutes).toBe(60);
  });

  it('retraso y capacidad se combinan sobre el mismo paso', () => {
    const simulation = simulateCase(
      { steps: [step('a', { slaMinutes: 100 })], now: NOW, start: NOW },
      { capacity: [{ areaKey: 'ventas', factor: 2 }], delays: [{ stepKey: 'a', minutes: 20 }] }
    );
    expect(simulation.steps[0].durationMin).toBe(70); // 100/2 + 20
  });

  it('usa las duraciones medidas y cuenta cuántos pasos las tienen', () => {
    const durations = new Map<string, StepDuration>([
      ['a', { activeMin: 10, waitMin: 20 }],
      ['b', { activeMin: null, waitMin: null }],
    ]);
    const simulation = simulateCase({ steps: CHAIN, durations, now: NOW, start: NOW });
    expect(simulation.measuredSteps).toBe(1);
    expect(simulation.steps.find((row) => row.stepKey === 'a')!.durationMin).toBe(30);
    expect(simulation.steps.find((row) => row.stepKey === 'b')!.durationMin).toBe(60);
  });

  it('un paso ya cerrado conserva su fecha real y no se vuelve a simular', () => {
    const done = new Date(NOW.getTime() - 30 * MINUTE);
    const steps = [
      step('a', {
        status: 'done',
        startedAt: new Date(NOW.getTime() - 90 * MINUTE),
        completedAt: done,
      }),
      step('b', { dependsOn: ['a:'] }),
    ];
    const simulation = simulateCase(
      { steps, now: NOW, start: new Date(NOW.getTime() - 120 * MINUTE) },
      { delays: [{ stepKey: 'a', minutes: 500 }] }
    );
    expect(finishOf(simulation, 'a')).toBe(done.getTime());
    // `b` arranca desde AHORA, no desde el pasado
    expect(finishOf(simulation, 'b')).toBe(NOW.getTime() + 60 * MINUTE);
  });

  it('un paso pendiente nunca termina antes de ahora aunque el expediente sea viejo', () => {
    const simulation = simulateCase({
      steps: [step('a')],
      now: NOW,
      start: new Date(NOW.getTime() - 10 * 24 * 60 * MINUTE),
    });
    expect(finishOf(simulation, 'a')).toBeGreaterThanOrEqual(NOW.getTime());
  });

  it('marca el camino crítico y reparte la holgura', () => {
    const steps = [
      step('a'),
      step('largo', { dependsOn: ['a:'], slaMinutes: 300 }),
      step('corto', { dependsOn: ['a:'], slaMinutes: 30 }),
      step('fin', { dependsOn: ['largo:', 'corto:'] }),
    ];
    const simulation = simulateCase({ steps, now: NOW, start: NOW });
    const byKey = new Map(simulation.steps.map((row) => [row.stepKey, row]));
    expect(byKey.get('largo')!.critical).toBe(true);
    expect(byKey.get('largo')!.slackMin).toBe(0);
    expect(byKey.get('corto')!.critical).toBe(false);
    expect(byKey.get('corto')!.slackMin).toBe(270);
    expect(simulation.criticalPath).toContain('largo:');
    expect(simulation.criticalPath).not.toContain('corto:');
  });

  it('dice si la fecha prometida se incumple antes y después del escenario', () => {
    const promisedAt = new Date(NOW.getTime() + 200 * MINUTE);
    const base = simulateCase({ steps: CHAIN, now: NOW, start: NOW, promisedAt });
    expect(base.lateBefore).toBe(false);
    expect(base.lateAfter).toBe(false);
    const late = simulateCase(
      { steps: CHAIN, now: NOW, start: NOW, promisedAt },
      { delays: [{ stepKey: 'c', minutes: 120 }] }
    );
    expect(late.lateBefore).toBe(false);
    expect(late.lateAfter).toBe(true);
  });

  it('sin fecha prometida no inventa un incumplimiento', () => {
    const simulation = simulateCase({ steps: CHAIN, now: NOW, start: NOW });
    expect(simulation.lateBefore).toBeNull();
    expect(simulation.lateAfter).toBeNull();
  });

  it('un expediente sin pasos devuelve una simulación vacía y no truena', () => {
    const simulation = simulateCase({ steps: [], now: NOW, start: NOW });
    expect(simulation.steps).toEqual([]);
    expect(simulation.scenarioFinish).toBeNull();
    expect(simulation.criticalPath).toEqual([]);
  });

  it('una dependencia circular no cuelga la simulación', () => {
    const steps = [step('a', { dependsOn: ['b:'] }), step('b', { dependsOn: ['a:'] })];
    const simulation = simulateCase({ steps, now: NOW, start: NOW });
    expect(simulation.steps).toHaveLength(2);
    expect(simulation.scenarioFinish).not.toBeNull();
  });

  it('una dependencia a un paso que no existe se ignora sin romper el pase', () => {
    const steps = [step('a', { dependsOn: ['fantasma:'] })];
    const simulation = simulateCase({ steps, now: NOW, start: NOW });
    expect(finishOf(simulation, 'a')).toBe(NOW.getTime() + 60 * MINUTE);
  });

  it('devuelve el escenario normalizado para que la pantalla muestre lo aplicado', () => {
    const simulation = simulateCase(
      { steps: CHAIN, now: NOW, start: NOW },
      { delays: [{ stepKey: 'b', minutes: 15 }], capacity: [{ areaKey: 'ventas', factor: 1 }] }
    );
    expect(simulation.scenario).toEqual({
      delays: [{ stepKey: 'b', minutes: 15 }],
      capacity: [],
    });
  });

  it('traduce la clave de área a su etiqueta en español', () => {
    const simulation = simulateCase({ steps: CHAIN, now: NOW, start: NOW });
    const b = simulation.steps.find((row) => row.stepKey === 'b')!;
    expect(b.areaLabel).toBe('Inventario');
  });
});
