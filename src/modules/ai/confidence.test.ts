import { describe, expect, it } from 'vitest';
import { inferConfidence, parseConfidence } from './confidence';
import { cosineSimilarity, reciprocalRankFusion } from './rag-fusion';

describe('parseConfidence', () => {
  it('extracts and strips the trailing label in its variants', () => {
    const a = parseConfidence('Hoy vendiste $12,300 en 8 órdenes.\n\n**Confianza:** Verificado — datos de querySalesOrders');
    expect(a.level).toBe('verified');
    expect(a.note).toBe('datos de querySalesOrders');
    expect(a.content).toBe('Hoy vendiste $12,300 en 8 órdenes.');

    const b = parseConfidence('Proyección: $40k este mes.\nConfianza: Estimación — tendencia de 3 semanas');
    expect(b.level).toBe('estimate');
    expect(b.content).toBe('Proyección: $40k este mes.');

    const c = parseConfidence('Creo que es el mejor cliente.\n_Confianza: suposición_');
    expect(c.level).toBe('assumption');
  });

  it('leaves normal text alone', () => {
    const p = parseConfidence('Hola, ¿en qué te ayudo?');
    expect(p.level).toBeNull();
    expect(p.content).toBe('Hola, ¿en qué te ayudo?');
  });
});

describe('inferConfidence', () => {
  it('derives a level from the turn when the model forgot the label', () => {
    expect(inferConfidence({ parsed: null, dataToolsSucceeded: 2, toolsFailed: 0, hasNumbers: true })).toBe('verified');
    expect(inferConfidence({ parsed: null, dataToolsSucceeded: 1, toolsFailed: 1, hasNumbers: true })).toBe('estimate');
    expect(inferConfidence({ parsed: null, dataToolsSucceeded: 0, toolsFailed: 1, hasNumbers: true })).toBe('assumption');
    expect(inferConfidence({ parsed: null, dataToolsSucceeded: 0, toolsFailed: 0, hasNumbers: false })).toBeNull();
    expect(inferConfidence({ parsed: 'estimate', dataToolsSucceeded: 3, toolsFailed: 0, hasNumbers: true })).toBe('estimate');
  });
});

describe('rag fusion', () => {
  it('ranks items present in both lists first', () => {
    const fused = reciprocalRankFusion([
      [{ key: 'a', item: 'a' }, { key: 'b', item: 'b' }],
      [{ key: 'c', item: 'c' }, { key: 'b', item: 'b' }],
    ]);
    expect(fused[0].key).toBe('b');
    expect(fused[0].sources).toEqual([0, 1]);
    expect(fused).toHaveLength(3);
  });

  it('cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
