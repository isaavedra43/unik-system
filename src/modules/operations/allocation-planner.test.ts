import { describe, expect, it } from 'vitest';
import {
  allocationDecisionSchema,
  defaultRemainderSource,
  describePlanLines,
  planAllocations,
  type AllocationPlanResult,
} from './allocation-planner';

const NOW = new Date('2026-09-15T15:00:00.000Z');
const options = { now: NOW, provisionalMaxHours: 72 };

function lines(result: AllocationPlanResult) {
  if (!result.ok) throw new Error(`plan rechazado: ${result.code}`);
  return result.lines.map((line) => [line.source, line.quantity.toString()]);
}

describe('planAllocations sin decisión (propuesta)', () => {
  it('existencia CONTROLLED suficiente: una línea de existencia y autoaprobable', () => {
    const result = planAllocations(
      { baseQuantity: 10 },
      { confidence: 'CONTROLLED', available: 25, lastVerifiedAt: null },
      { defaultSource: 'stock' },
      undefined,
      options
    );
    expect(lines(result)).toEqual([['stock', '10']]);
    expect(result).toMatchObject({
      coveredByControlledStock: true,
      requiresDecision: false,
      provisional: false,
    });
  });

  it('CONTROLLED insuficiente: existencia disponible + el resto a compra (requiere decisión)', () => {
    const result = planAllocations(
      { baseQuantity: 10 },
      { confidence: 'CONTROLLED', available: 6, lastVerifiedAt: null },
      { defaultSource: 'stock' },
      undefined,
      options
    );
    expect(lines(result)).toEqual([
      ['stock', '6'],
      ['purchase', '4'],
    ]);
    expect(result).toMatchObject({ coveredByControlledStock: false, requiresDecision: true });
    if (result.ok) expect(result.shortfall.toString()).toBe('4');
  });

  it('el resto va a la fuente por defecto del perfil o a la indicada en la decisión', () => {
    const availability = { confidence: 'CONTROLLED', available: 0, lastVerifiedAt: null };
    expect(
      lines(
        planAllocations(
          { baseQuantity: 5 },
          availability,
          { defaultSource: 'manufacture' },
          undefined,
          options
        )
      )
    ).toEqual([['manufacture', '5']]);
    expect(
      lines(
        planAllocations(
          { baseQuantity: 5 },
          availability,
          { defaultSource: 'manufacture' },
          { remainderSource: 'direct_supplier' },
          options
        )
      )
    ).toEqual([['direct_supplier', '5']]);
    expect(defaultRemainderSource(null)).toBe('purchase');
    expect(defaultRemainderSource({ defaultSource: 'stock' })).toBe('purchase');
  });

  it('existencia UNCOUNTED o DISPUTED nunca se promete', () => {
    for (const confidence of ['UNCOUNTED', 'DISPUTED']) {
      const result = planAllocations(
        { baseQuantity: 8 },
        { confidence, available: 100, lastVerifiedAt: null },
        { defaultSource: 'stock' },
        undefined,
        options
      );
      expect(lines(result)).toEqual([['purchase', '8']]);
    }
    expect(lines(planAllocations({ baseQuantity: 8 }, null, null, undefined, options))).toEqual([
      ['purchase', '8'],
    ]);
  });

  it('PROVISIONAL sólo con decisión humana explícita y verificación reciente', () => {
    const recent = {
      confidence: 'PROVISIONAL',
      available: 20,
      lastVerifiedAt: new Date('2026-09-14T15:00:00.000Z'),
    };
    expect(lines(planAllocations({ baseQuantity: 8 }, recent, null, undefined, options))).toEqual([
      ['purchase', '8'],
    ]);
    const human = planAllocations(
      { baseQuantity: 8 },
      recent,
      null,
      { allowProvisional: true },
      { ...options, humanDecision: true }
    );
    expect(lines(human)).toEqual([['stock', '8']]);
    expect(human).toMatchObject({
      provisional: true,
      coveredByControlledStock: false,
      requiresDecision: true,
    });

    expect(
      planAllocations({ baseQuantity: 8 }, recent, null, { allowProvisional: true }, options)
    ).toMatchObject({
      ok: false,
      code: 'provisional_not_allowed',
    });
    const stale = { ...recent, lastVerifiedAt: new Date('2026-09-10T00:00:00.000Z') };
    expect(
      planAllocations(
        { baseQuantity: 8 },
        stale,
        null,
        { allowProvisional: true },
        { ...options, humanDecision: true }
      )
    ).toMatchObject({ ok: false, code: 'provisional_verification_stale' });
  });

  it('sólo planea lo que falta cubrir de la necesidad', () => {
    const availability = { confidence: 'CONTROLLED', available: 3, lastVerifiedAt: null };
    expect(
      lines(
        planAllocations(
          { baseQuantity: 10, allocatedQuantity: 6 },
          availability,
          null,
          undefined,
          options
        )
      )
    ).toEqual([
      ['stock', '3'],
      ['purchase', '1'],
    ]);
    const covered = planAllocations(
      { baseQuantity: 10, allocatedQuantity: 10 },
      null,
      null,
      undefined,
      options
    );
    expect(lines(covered)).toEqual([]);
    expect(covered).toMatchObject({ coveredByControlledStock: true, requiresDecision: false });
  });
});

describe('planAllocations con líneas decididas', () => {
  const availability = { confidence: 'CONTROLLED', available: 6, lastVerifiedAt: null };

  it('acepta un reparto exacto y une fuentes repetidas', () => {
    const result = planAllocations(
      { baseQuantity: 10 },
      availability,
      null,
      {
        lines: [
          { source: 'stock', quantity: 2 },
          { source: 'manufacture', quantity: 5, expectedAt: '2026-09-20' },
          { source: 'stock', quantity: 3 },
        ],
      },
      options
    );
    expect(lines(result)).toEqual([
      ['stock', '5'],
      ['manufacture', '5'],
    ]);
    if (result.ok)
      expect(result.lines[1].expectedAt?.toISOString()).toBe('2026-09-20T00:00:00.000Z');
  });

  it('rechaza sumas distintas a lo que falta, más existencia de la disponible o existencia sin contar', () => {
    expect(
      planAllocations(
        { baseQuantity: 10 },
        availability,
        null,
        { lines: [{ source: 'purchase', quantity: 9 }] },
        options
      )
    ).toMatchObject({
      ok: false,
      code: 'plan_quantity_mismatch',
    });
    expect(
      planAllocations(
        { baseQuantity: 10 },
        availability,
        null,
        { lines: [{ source: 'stock', quantity: 10 }] },
        options
      )
    ).toMatchObject({ ok: false, code: 'plan_stock_exceeded' });
    expect(
      planAllocations(
        { baseQuantity: 10 },
        { confidence: 'UNCOUNTED', available: 50, lastVerifiedAt: null },
        null,
        { lines: [{ source: 'stock', quantity: 10 }] },
        options
      )
    ).toMatchObject({ ok: false, code: 'stock_not_promisable' });
  });

  it('el esquema de la decisión convierte cantidades en texto y rechaza campos desconocidos', () => {
    expect(
      allocationDecisionSchema.parse({ lines: [{ source: 'purchase', quantity: '4.5' }] }).lines![0]
        .quantity
    ).toBe(4.5);
    expect(
      allocationDecisionSchema.safeParse({ lines: [{ source: 'regalo', quantity: 1 }] }).success
    ).toBe(false);
    expect(allocationDecisionSchema.safeParse({ acceptProposal: true, extra: 1 }).success).toBe(
      false
    );
  });
});

describe('describePlanLines', () => {
  it('describe el plan en español', () => {
    const result = planAllocations(
      { baseQuantity: 10 },
      { confidence: 'CONTROLLED', available: 6, lastVerifiedAt: null },
      null,
      undefined,
      options
    );
    if (!result.ok) throw new Error('plan rechazado');
    expect(describePlanLines(result.lines, 'pz')).toBe('6 pz de existencia + 4 pz de compra');
    expect(describePlanLines([], 'pz')).toBe('Nada por cubrir');
  });
});
