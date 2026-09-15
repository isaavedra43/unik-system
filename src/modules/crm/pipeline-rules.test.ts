import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIPELINE_STAGES,
  effectiveProbability,
  firstActiveStageOfKind,
  isValidStageKey,
  nextStageOrder,
  planStageInsertion,
  planStageReorder,
  sortStages,
  stageKeyFromName,
  toProbability,
  uniqueStageKey,
  validateActiveStageSet,
  type StageLike,
} from './pipeline-rules';

/** Pipeline rules: default seed, keys, active set invariants, insertion, reorder and probabilities. */

const stages = (): StageLike[] =>
  DEFAULT_PIPELINE_STAGES.map((stage) => ({ id: `s-${stage.key}`, key: stage.key, name: stage.name, order: stage.order, kind: stage.kind, active: true }));

describe('default pipeline', () => {
  it('seeds Nuevo, Contactado, Cotizado, Negociación, Ganado and Perdido in order', () => {
    expect(DEFAULT_PIPELINE_STAGES.map((s) => [s.name, s.kind])).toEqual([
      ['Nuevo', 'open'],
      ['Contactado', 'open'],
      ['Cotizado', 'open'],
      ['Negociación', 'open'],
      ['Ganado', 'won'],
      ['Perdido', 'lost'],
    ]);
    expect(validateActiveStageSet(stages())).toBeNull();
    expect(DEFAULT_PIPELINE_STAGES.every((s) => isValidStageKey(s.key))).toBe(true);
  });
});

describe('stage keys', () => {
  it('derives keys from names', () => {
    expect(stageKeyFromName('Negociación final')).toBe('negociacion_final');
    expect(stageKeyFromName('  2da Visita ')).toBe('etapa_2da_visita');
    expect(stageKeyFromName('¡¡!!')).toBe('etapa');
    expect(stageKeyFromName('A'.repeat(80))).toHaveLength(40);
  });

  it('makes keys unique', () => {
    expect(uniqueStageKey('visita', new Set())).toBe('visita');
    expect(uniqueStageKey('visita', new Set(['visita', 'visita_2']))).toBe('visita_3');
  });

  it('validates the key pattern', () => {
    expect(isValidStageKey('visita_obra')).toBe(true);
    expect(isValidStageKey('Visita')).toBe(false);
    expect(isValidStageKey('1visita')).toBe(false);
  });
});

describe('active stage set', () => {
  it('requires an active stage of each kind', () => {
    const noWon = stages().map((s) => (s.kind === 'won' ? { ...s, active: false } : s));
    expect(validateActiveStageSet(noWon)).toBe('El embudo necesita al menos una etapa activa de tipo «Ganada»');
    expect(validateActiveStageSet(stages().filter((s) => s.kind !== 'open'))).toContain('«Abierta»');
  });

  it('finds the first active stage of a kind', () => {
    const list = stages().map((s) => (s.key === 'nuevo' ? { ...s, active: false } : s));
    expect(firstActiveStageOfKind(list, 'open')?.key).toBe('contactado');
    expect(firstActiveStageOfKind(list, 'won')?.key).toBe('ganado');
  });
});

describe('insertion and reorder', () => {
  it('inserts an open stage before the closing stages', () => {
    expect(planStageInsertion(stages(), 'open')).toEqual({
      order: 5,
      shifts: [
        { id: 's-ganado', order: 6 },
        { id: 's-perdido', order: 7 },
      ],
    });
  });

  it('appends a closing stage', () => {
    expect(planStageInsertion(stages(), 'lost')).toEqual({ order: 7, shifts: [] });
    expect(nextStageOrder([])).toBe(1);
  });

  it('reorders active stages and keeps inactive ones after them', () => {
    const list = [...stages(), { id: 's-old', key: 'old', name: 'Antigua', order: 7, kind: 'open', active: false }];
    const ids = ['s-contactado', 's-nuevo', 's-cotizado', 's-negociacion', 's-ganado', 's-perdido'];
    const plan = planStageReorder(list, ids);
    expect(plan).toEqual({ ok: true, orders: [...ids, 's-old'].map((id, i) => ({ id, order: i + 1 })) });
  });

  it('rejects unknown, repeated or missing stages', () => {
    expect(planStageReorder(stages(), ['nope'])).toEqual({ ok: false, message: 'Una de las etapas no existe' });
    expect(planStageReorder(stages(), ['s-nuevo', 's-nuevo'])).toEqual({ ok: false, message: 'Una etapa aparece dos veces en el nuevo orden' });
    expect(planStageReorder(stages(), ['s-nuevo'])).toEqual({ ok: false, message: 'Falta ordenar la etapa «Contactado»' });
  });

  it('sorts by order then name', () => {
    expect(sortStages([{ order: 2, name: 'b' }, { order: 1, name: 'z' }, { order: 1, name: 'a' }]).map((s) => s.name)).toEqual(['a', 'z', 'b']);
  });
});

describe('probabilities', () => {
  it('parses and clamps probabilities', () => {
    expect(toProbability(null)).toBeNull();
    expect(toProbability('0.35')).toBe(0.35);
    expect(toProbability(1.5)).toBe(1);
    expect(toProbability(-1)).toBe(0);
    expect(toProbability('abc')).toBeNull();
  });

  it('falls back to the stage default', () => {
    expect(effectiveProbability(null, '0.5')).toBe(0.5);
    expect(effectiveProbability(0.8, 0.5)).toBe(0.8);
    expect(effectiveProbability(null, null)).toBe(0);
  });
});
