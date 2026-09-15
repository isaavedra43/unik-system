import { describe, expect, it } from 'vitest';
import { computeLandedCosts, scoreRfqResponses, type ScoringResponse, type ScoringRfqLine } from './rfq-scoring';

const NOW = new Date('2026-09-15T12:00:00.000Z');

function response(overrides: Partial<ScoringResponse> & { id: string }): ScoringResponse {
  return {
    currency: 'MXN',
    exchangeRate: null,
    taxIncluded: false,
    taxRate: 0.16,
    freight: 0,
    otherCosts: 0,
    leadTimeDays: 5,
    validUntil: null,
    confidence: null,
    supplierRating: 4,
    evaluationsCount: 3,
    isCandidate: false,
    lines: [],
    ...overrides,
  };
}

const oneLine: ScoringRfqLine[] = [{ id: 'L1', qty: 100, unit: 'm2' }];

describe('computeLandedCosts', () => {
  it('suma flete por unidad y aplica IVA cuando el precio no lo incluye', () => {
    const result = computeLandedCosts(
      oneLine,
      response({ id: 'a', freight: 1000, lines: [{ rfqLineId: 'L1', unitPrice: 200, qty: 100, unit: 'm2', unitsPerRfqUnit: 1 }] })
    );
    expect(result.lines[0]).toMatchObject({ pricePerRfqUnit: 200, landedUnitCost: 243.6, coveredQty: 100 });
    expect(result.landedTotal).toBe(24_360);
    expect(result.comparable).toBe(true);
  });

  it('con IVA incluido no se vuelve a sumar', () => {
    const result = computeLandedCosts(
      oneLine,
      response({ id: 'a', taxIncluded: true, freight: 1000, lines: [{ rfqLineId: 'L1', unitPrice: 200, qty: 100, unit: 'm2', unitsPerRfqUnit: 1 }] })
    );
    expect(result.lines[0].landedUnitCost).toBe(210);
  });

  it('convierte el precio por caja a la unidad de la cotización', () => {
    const result = computeLandedCosts(
      [{ id: 'L1', qty: 144, unit: 'm2' }],
      response({ id: 'a', lines: [{ rfqLineId: 'L1', unitPrice: 300, qty: 100, unit: 'caja', unitsPerRfqUnit: 1 / 1.44 }] })
    );
    expect(result.lines[0].pricePerRfqUnit).toBeCloseTo(208.3333, 4);
    expect(result.lines[0].landedUnitCost).toBeCloseTo(241.6667, 4);
    expect(result.landedTotal).toBeCloseTo(34_800, 2);
  });

  it('una moneda extranjera usa el tipo de cambio y sin él no es comparable', () => {
    const lines = [{ rfqLineId: 'L1', unitPrice: 10, qty: 10, unit: 'm2', unitsPerRfqUnit: 1 }];
    const withRate = computeLandedCosts(
      [{ id: 'L1', qty: 10, unit: 'm2' }],
      response({ id: 'usd', currency: 'USD', exchangeRate: 17, taxIncluded: true, lines })
    );
    expect(withRate.lines[0].landedUnitCost).toBe(170);
    const withoutRate = computeLandedCosts(
      [{ id: 'L1', qty: 10, unit: 'm2' }],
      response({ id: 'usd', currency: 'USD', taxIncluded: true, lines })
    );
    expect(withoutRate.comparable).toBe(false);
    expect(withoutRate.landedTotal).toBeNull();
    expect(withoutRate.issues.join(' ')).toContain('tipo de cambio');
  });

  it('sin tasa de IVA supone 16 % y lo avisa', () => {
    const result = computeLandedCosts(
      oneLine,
      response({ id: 'a', taxRate: null, lines: [{ rfqLineId: 'L1', unitPrice: 100, qty: null, unit: null, unitsPerRfqUnit: 1 }] })
    );
    expect(result.lines[0].landedUnitCost).toBe(116);
    expect(result.issues[0]).toContain('IVA no indicado');
  });

  it('reparte flete y otros costos por el valor de cada línea', () => {
    const result = computeLandedCosts(
      [
        { id: 'L1', qty: 10, unit: 'pz' },
        { id: 'L2', qty: 10, unit: 'pz' },
      ],
      response({
        id: 'a',
        taxIncluded: true,
        freight: 400,
        otherCosts: 0,
        lines: [
          { rfqLineId: 'L1', unitPrice: 100, qty: 10, unit: 'pz', unitsPerRfqUnit: 1 },
          { rfqLineId: 'L2', unitPrice: 300, qty: 10, unit: 'pz', unitsPerRfqUnit: 1 },
        ],
      })
    );
    expect(result.lines.map((l) => l.landedUnitCost)).toEqual([110, 330]);
    expect(result.landedTotal).toBe(4400);
  });

  it('marca líneas sin cotizar, cotizadas parcialmente o con unidad imposible', () => {
    const result = computeLandedCosts(
      [
        { id: 'L1', qty: 100, unit: 'm2' },
        { id: 'L2', qty: 5, unit: 'pz' },
        { id: 'L3', qty: 5, unit: 'kg' },
      ],
      response({
        id: 'a',
        lines: [
          { rfqLineId: 'L1', unitPrice: 100, qty: 50, unit: 'm2', unitsPerRfqUnit: 1 },
          { rfqLineId: 'L3', unitPrice: 100, qty: null, unit: 'rollo', unitsPerRfqUnit: null },
        ],
      })
    );
    expect(result.lines[0]).toMatchObject({ quoted: true, coveredQty: 50 });
    expect(result.lines[0].issues[0]).toContain('Cotiza 50 de 100');
    expect(result.lines[1]).toMatchObject({ quoted: false, landedUnitCost: null, issues: ['Sin cotizar'] });
    expect(result.lines[2].landedUnitCost).toBeNull();
    expect(result.lines[2].issues[0]).toContain('No se pudo convertir');
    expect(result.landedTotal).toBe(11_600);
  });
});

describe('scoreRfqResponses', () => {
  it('pondera costo 50 %, tiempo 25 %, riesgo 15 % y especificación 10 %', () => {
    const scores = scoreRfqResponses(
      [{ id: 'L1', qty: 10, unit: 'm2' }],
      [
        response({ id: 'cheap', taxIncluded: true, leadTimeDays: 10, lines: [{ rfqLineId: 'L1', unitPrice: 210, qty: 10, unit: 'm2', unitsPerRfqUnit: 1 }] }),
        response({ id: 'fast', taxIncluded: true, leadTimeDays: 5, lines: [{ rfqLineId: 'L1', unitPrice: 230, qty: 10, unit: 'm2', unitsPerRfqUnit: 1 }] }),
      ],
      { now: NOW }
    );
    const cheap = scores.find((s) => s.responseId === 'cheap')!;
    const fast = scores.find((s) => s.responseId === 'fast')!;
    expect(cheap).toMatchObject({ costScore: 1, timeScore: 0.5455, risk: 0.25, specMatch: 1, score: 0.8489 });
    expect(fast).toMatchObject({ costScore: 0.913, timeScore: 1, score: 0.919 });
    expect(scores[0]).toMatchObject({ responseId: 'fast', rank: 1, recommended: true });
    expect(scores[1]).toMatchObject({ responseId: 'cheap', rank: 2, recommended: false });
  });

  it('castiga candidato nuevo, baja confianza y cotización vencida', () => {
    const lines = [{ rfqLineId: 'L1', unitPrice: 100, qty: 10, unit: 'm2', unitsPerRfqUnit: 1 }];
    const scores = scoreRfqResponses(
      [{ id: 'L1', qty: 10, unit: 'm2' }],
      [
        response({ id: 'known', lines }),
        response({
          id: 'risky',
          lines,
          isCandidate: true,
          supplierRating: null,
          evaluationsCount: 0,
          confidence: 0.5,
          validUntil: new Date('2026-09-01T00:00:00.000Z'),
        }),
      ],
      { now: NOW }
    );
    const risky = scores.find((s) => s.responseId === 'risky')!;
    expect(risky.risk).toBe(1);
    expect(risky.reasons).toEqual(expect.arrayContaining(['Proveedor nuevo (candidato)', 'Interpretación con baja confianza', 'Cotización vencida']));
    expect(scores[0].responseId).toBe('known');
  });

  it('cotizar menos líneas baja costo y especificación', () => {
    const rfqLines = [
      { id: 'L1', qty: 10, unit: 'pz' },
      { id: 'L2', qty: 10, unit: 'pz' },
    ];
    const scores = scoreRfqResponses(
      rfqLines,
      [
        response({
          id: 'full',
          lines: [
            { rfqLineId: 'L1', unitPrice: 100, qty: 10, unit: 'pz', unitsPerRfqUnit: 1 },
            { rfqLineId: 'L2', unitPrice: 100, qty: 10, unit: 'pz', unitsPerRfqUnit: 1 },
          ],
        }),
        response({ id: 'half', lines: [{ rfqLineId: 'L1', unitPrice: 100, qty: 10, unit: 'pz', unitsPerRfqUnit: 1 }] }),
      ],
      { now: NOW }
    );
    const half = scores.find((s) => s.responseId === 'half')!;
    expect(half.specMatch).toBe(0.5);
    expect(half.costScore).toBe(0.5);
    expect(scores[0].responseId).toBe('full');
  });

  it('desempata por costo total y deja sin recomendar lo no comparable', () => {
    const scores = scoreRfqResponses(
      [{ id: 'L1', qty: 10, unit: 'pz' }],
      [response({ id: 'usd', currency: 'USD', lines: [{ rfqLineId: 'L1', unitPrice: 5, qty: 10, unit: 'pz', unitsPerRfqUnit: 1 }] })],
      { now: NOW }
    );
    expect(scores[0]).toMatchObject({ comparable: false, recommended: false, landedTotal: null });
    expect(scoreRfqResponses(oneLine, [], { now: NOW })).toEqual([]);
  });
});
