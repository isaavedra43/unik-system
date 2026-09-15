import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  StockMathError,
  applyMovement,
  canPromise,
  computeAvailable,
  computeKnown,
  conversionFactor,
  countDifference,
  dec,
  evaluateCountClose,
  evaluateReservation,
  fromBase,
  isVerificationRecent,
  itemAvailable,
  normalizeUnit,
  parseConversions,
  planReservationSplit,
  promotionEligible,
  roundQty,
  sameUnit,
  toBase,
  toStockState,
  unitDecimals,
  withinTolerance,
  type StockCounters,
  type UnitProfile,
} from './stock-math';

const str = (value: Prisma.Decimal) => value.toString();
const zeroCounters: StockCounters = {
  baseline: 0,
  receipts: 0,
  returns: 0,
  produced: 0,
  issued: 0,
  consumed: 0,
  adjustments: 0,
};
const NOW = new Date('2026-09-15T15:00:00.000Z');

describe('dec / roundQty', () => {
  it('convierte números, strings y Decimal; vacío es cero', () => {
    expect(str(dec(1.5))).toBe('1.5');
    expect(str(dec('2.25'))).toBe('2.25');
    expect(str(dec(new Prisma.Decimal(3)))).toBe('3');
    expect(str(dec(null))).toBe('0');
    expect(str(dec(undefined))).toBe('0');
    expect(str(dec(''))).toBe('0');
  });

  it('rechaza valores no numéricos o infinitos', () => {
    expect(() => dec('abc')).toThrow(StockMathError);
    expect(() => dec(Number.POSITIVE_INFINITY)).toThrow(StockMathError);
  });

  it('redondea al más cercano, hacia arriba o hacia abajo con 0…4 decimales', () => {
    expect(str(roundQty('1.23456'))).toBe('1.2346');
    expect(str(roundQty('2.5', 0))).toBe('3');
    expect(str(roundQty('2.1', 0, 'up'))).toBe('3');
    expect(str(roundQty('2.9', 0, 'down'))).toBe('2');
    expect(str(roundQty('1.23456', 9))).toBe('1.2346');
    expect(str(roundQty('7.8', -3))).toBe('8');
  });
});

describe('computeKnown', () => {
  it('suma línea base, entradas, devoluciones y producción; resta salidas y consumos; ajustes con signo', () => {
    const known = computeKnown({
      baseline: 100,
      receipts: 20,
      returns: 5,
      produced: 10,
      issued: 30,
      consumed: 12,
      adjustments: -3,
    });
    expect(str(known)).toBe('90');
  });

  it('no arrastra errores de coma flotante', () => {
    expect(str(computeKnown({ ...zeroCounters, baseline: 0.1, receipts: 0.2 }))).toBe('0.3');
  });

  it('acepta strings y Decimal y puede quedar negativo', () => {
    expect(
      str(computeKnown({ ...zeroCounters, baseline: '5.5', issued: new Prisma.Decimal(7) }))
    ).toBe('-1.5');
  });
});

describe('computeAvailable', () => {
  it('resta reservado, bloqueado, asignado a producción y reclamos legados', () => {
    expect(
      str(
        computeAvailable({
          known: 100,
          reserved: 30,
          blocked: 5,
          assignedToProduction: 10,
          legacyClaims: 15,
        })
      )
    ).toBe('40');
  });

  it('los valores ausentes cuentan como cero', () => {
    expect(str(computeAvailable({ known: '12.5' }))).toBe('12.5');
    expect(str(computeAvailable({ known: 10, reserved: null, blocked: undefined }))).toBe('10');
  });

  it('puede ser negativo (informativo, nunca se promete)', () => {
    expect(str(computeAvailable({ known: 10, reserved: 12 }))).toBe('-2');
  });
});

describe('applyMovement', () => {
  const base = toStockState({ ...zeroCounters, baseline: 50, reserved: 10, blocked: 2 });

  it.each([
    ['baseline', 5, 'baseline', '55'],
    ['receipt', 5, 'receipts', '55'],
    ['transfer_in', 5, 'receipts', '55'],
    ['return', 5, 'returns', '55'],
    ['produce', 5, 'produced', '55'],
    ['issue', 5, 'issued', '45'],
    ['transfer_out', 5, 'issued', '45'],
    ['consume', 5, 'consumed', '45'],
    ['adjust', -4, 'adjustments', '46'],
  ] as const)('%s actualiza %s y el conocido', (kind, quantity, counter, known) => {
    const next = applyMovement(base, kind, quantity);
    expect(str(next[counter])).toBe(
      kind === 'baseline' ? '55' : String(Math.abs(quantity) * (kind === 'adjust' ? -1 : 1))
    );
    expect(str(next.knownQty)).toBe(known);
    expect(str(next.reserved)).toBe('10');
  });

  it('bloquear y desbloquear no cambian el conocido', () => {
    const blocked = applyMovement(base, 'block', 3);
    expect(str(blocked.blocked)).toBe('5');
    expect(str(blocked.knownQty)).toBe('50');
    const unblocked = applyMovement(blocked, 'unblock', 4);
    expect(str(unblocked.blocked)).toBe('1');
    expect(str(unblocked.knownQty)).toBe('50');
  });

  it('no modifica el estado original', () => {
    applyMovement(base, 'receipt', 1);
    expect(str(base.receipts)).toBe('0');
  });

  it('rechaza cantidades cero o negativas salvo en ajustes y línea base', () => {
    expect(() => applyMovement(base, 'receipt', 0)).toThrow(StockMathError);
    expect(() => applyMovement(base, 'issue', -1)).toThrow(StockMathError);
    expect(() => applyMovement(base, 'adjust', 0)).toThrow(StockMathError);
    expect(str(applyMovement(base, 'baseline', -2).knownQty)).toBe('48');
  });

  it('itemAvailable descuenta reservas, bloqueos y reclamos', () => {
    expect(str(itemAvailable({ ...zeroCounters, baseline: 20, reserved: 5, blocked: 1 }))).toBe(
      '14'
    );
    expect(str(itemAvailable({ ...zeroCounters, baseline: 20, reserved: 5 }, 3))).toBe('12');
  });
});

describe('unidades y conversiones', () => {
  const tile: UnitProfile = {
    baseUnit: 'm2',
    conversions: [
      { unit: 'caja', factor: '1.44' },
      { unit: 'pz', factor: '0.36' },
    ],
  };

  it.each([
    ['PZA.', 'pz'],
    ['Piezas', 'pz'],
    ['unidad', 'pz'],
    ['M²', 'm2'],
    ['mts2', 'm2'],
    ['Metros', 'm'],
    ['Kilos', 'kg'],
    ['LTS', 'l'],
    ['Cajas', 'caja'],
    ['rollos', 'rollo'],
    ['galón', 'galon'],
    ['xyz', 'xyz'],
    ['', ''],
  ])('normaliza "%s" como "%s"', (input, expected) => {
    expect(normalizeUnit(input)).toBe(expected);
  });

  it('normalizeUnit tolera null y sameUnit compara formas canónicas', () => {
    expect(normalizeUnit(null)).toBe('');
    expect(sameUnit('PZA', 'piezas')).toBe(true);
    expect(sameUnit('', '')).toBe(false);
  });

  it('toBase convierte con el factor y redondea a la precisión de la unidad base', () => {
    expect(str(toBase(3, 'caja', tile))).toBe('4.32');
    expect(str(toBase(3, 'Cajas', tile))).toBe('4.32');
    expect(str(toBase(10, 'pz', tile))).toBe('3.6');
    expect(str(toBase('5.555', 'm2', tile))).toBe('5.56');
    expect(str(toBase(5, null, tile))).toBe('5');
  });

  it('fromBase convierte a la unidad pedida con su redondeo y modo', () => {
    expect(str(fromBase('4.32', 'caja', tile))).toBe('3');
    expect(str(fromBase(5, 'caja', tile))).toBe('3');
    expect(str(fromBase(5, 'caja', tile, 'up'))).toBe('4');
    expect(str(fromBase(5, 'caja', tile, 'down'))).toBe('3');
    expect(str(fromBase(5, 'm2', tile))).toBe('5');
  });

  it('redondea por unidad: piezas sin decimales', () => {
    const boxes: UnitProfile = { baseUnit: 'pz', conversions: [{ unit: 'caja', factor: 12 }] };
    expect(str(toBase('0.25', 'caja', boxes))).toBe('3');
    expect(str(toBase('0.1', 'caja', boxes))).toBe('1');
    expect(str(toBase('0.1', 'caja', boxes, 'up'))).toBe('2');
  });

  it('respeta los decimales explícitos del perfil', () => {
    const bulk: UnitProfile = {
      baseUnit: 'kg',
      conversions: [
        { unit: 'kg', factor: 1, decimals: 1 },
        { unit: 'bulto', factor: 25, decimals: 0 },
      ],
    };
    expect(unitDecimals('kg', bulk)).toBe(1);
    expect(unitDecimals('bulto', bulk)).toBe(0);
    expect(str(toBase('1.26', 'kg', bulk))).toBe('1.3');
    expect(str(fromBase(60, 'bulto', bulk, 'up'))).toBe('3');
    expect(unitDecimals('m')).toBe(2);
    expect(unitDecimals('desconocida')).toBe(4);
  });

  it('una unidad sin conversión o con factor inválido es un error de unidad', () => {
    expect(() => toBase(1, 'tarima', tile)).toThrow(StockMathError);
    try {
      conversionFactor('tarima', tile);
    } catch (err) {
      expect((err as StockMathError).code).toBe('invalid_unit');
    }
    expect(() =>
      conversionFactor('caja', { baseUnit: 'm2', conversions: [{ unit: 'caja', factor: 0 }] })
    ).toThrow(StockMathError);
    expect(str(conversionFactor('m2', tile))).toBe('1');
  });

  it('parseConversions normaliza, deduplica y descarta entradas inválidas', () => {
    expect(
      parseConversions([
        { unit: 'Cajas', factor: '1.44', decimals: 0 },
        { unit: 'caja', factor: 2 },
        { unit: 'pz', factor: -1 },
        { unit: '', factor: 1 },
        { unit: 'rollo', factor: 'x' },
        { unit: 'm', factor: 3, decimals: 9 },
        'basura',
      ])
    ).toEqual([
      { unit: 'caja', factor: '1.44', decimals: 0 },
      { unit: 'm', factor: '3', decimals: 4 },
    ]);
    expect(parseConversions(null)).toEqual([]);
  });
});

describe('withinTolerance / countDifference', () => {
  it.each([
    [100, 98, 2, true],
    [100, 102, 2, true],
    ['100', '97.99', 2, false],
    [50, 49, 2, true],
    [0, 0, 2, true],
    [0, '0.0001', 2, false],
    [10, 10, 0, true],
    [10, '10.0001', 0, false],
    [-10, -10.2, 2, true],
  ] as const)('esperado %s, contado %s, tolerancia %s%% → %s', (expected, counted, pct, result) => {
    expect(withinTolerance(expected, counted, pct)).toBe(result);
  });

  it('una tolerancia negativa se trata como exacta', () => {
    expect(withinTolerance(10, 10.1, -5)).toBe(false);
  });

  it('countDifference es contado − esperado', () => {
    expect(str(countDifference(10, '9.5'))).toBe('-0.5');
    expect(str(countDifference('3.3', 4))).toBe('0.7');
  });
});

describe('canPromise', () => {
  it('sólo CONTROLLED con disponible suficiente y cantidad positiva', () => {
    expect(canPromise('CONTROLLED', 10, 10)).toBe(true);
    expect(canPromise('CONTROLLED', 9.99, 10)).toBe(false);
    expect(canPromise('CONTROLLED', 10, 0)).toBe(false);
    expect(canPromise('PROVISIONAL', 100, 1)).toBe(false);
    expect(canPromise('UNCOUNTED', 100, 1)).toBe(false);
    expect(canPromise('DISPUTED', 100, 1)).toBe(false);
  });
});

describe('promotionEligible', () => {
  it('PROVISIONAL con un conteo bueno previo, dentro de tolerancia y sin disputas', () => {
    expect(
      promotionEligible({ confidence: 'PROVISIONAL', consecutiveGoodCounts: 1 }, true, 0)
    ).toBe(true);
  });

  it.each([
    ['sin conteos buenos previos', 'PROVISIONAL', 0, true, 0],
    ['fuera de tolerancia', 'PROVISIONAL', 1, false, 0],
    ['con disputas abiertas', 'PROVISIONAL', 3, true, 1],
    ['ya controlado', 'CONTROLLED', 5, true, 0],
    ['sin contar', 'UNCOUNTED', 1, true, 0],
    ['en disputa', 'DISPUTED', 1, true, 0],
  ] as const)('no promueve %s', (_label, confidence, good, within, disputes) => {
    expect(promotionEligible({ confidence, consecutiveGoodCounts: good }, within, disputes)).toBe(
      false
    );
  });
});

describe('isVerificationRecent', () => {
  it('compara contra la ventana en horas', () => {
    expect(isVerificationRecent(new Date(NOW.getTime() - 71 * 3_600_000), NOW, 72)).toBe(true);
    expect(isVerificationRecent(new Date(NOW.getTime() - 72 * 3_600_000), NOW, 72)).toBe(true);
    expect(isVerificationRecent(new Date(NOW.getTime() - 73 * 3_600_000), NOW, 72)).toBe(false);
    expect(isVerificationRecent(null, NOW, 72)).toBe(false);
  });
});

describe('evaluateReservation', () => {
  const base = { now: NOW, provisionalMaxHours: 72 };
  const recent = new Date(NOW.getTime() - 3_600_000);

  it('CONTROLLED con disponible suficiente reserva sin decisión', () => {
    expect(
      evaluateReservation({ ...base, confidence: 'CONTROLLED', available: 10, quantity: 10 })
    ).toEqual({
      ok: true,
      provisional: false,
    });
  });

  it('CONTROLLED nunca queda negativo', () => {
    const decision = evaluateReservation({
      ...base,
      confidence: 'CONTROLLED',
      available: 4,
      quantity: 5,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe('insufficient_stock');
      expect(str(decision.shortfall)).toBe('1');
    }
  });

  it('el faltante con disponible negativo es la cantidad completa', () => {
    const decision = evaluateReservation({
      ...base,
      confidence: 'CONTROLLED',
      available: -3,
      quantity: 5,
    });
    expect(!decision.ok && str(decision.shortfall)).toBe('5');
  });

  it.each([
    ['invalid_quantity', { confidence: 'CONTROLLED', available: 10, quantity: 0 }],
    ['stock_uncounted', { confidence: 'UNCOUNTED', available: 10, quantity: 1 }],
    [
      'stock_disputed',
      { confidence: 'DISPUTED', available: 10, quantity: 1, allowProvisional: true },
    ],
    [
      'provisional_not_allowed',
      { confidence: 'PROVISIONAL', available: 10, quantity: 1, lastVerifiedAt: recent },
    ],
    [
      'provisional_verification_stale',
      {
        confidence: 'PROVISIONAL',
        available: 10,
        quantity: 1,
        allowProvisional: true,
        lastVerifiedAt: new Date(NOW.getTime() - 80 * 3_600_000),
      },
    ],
    [
      'provisional_verification_stale',
      { confidence: 'PROVISIONAL', available: 10, quantity: 1, allowProvisional: true },
    ],
    [
      'insufficient_stock',
      {
        confidence: 'PROVISIONAL',
        available: 1,
        quantity: 2,
        allowProvisional: true,
        lastVerifiedAt: recent,
      },
    ],
  ] as const)('rechaza con %s', (code, input) => {
    const decision = evaluateReservation({ ...base, ...input });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.code).toBe(code);
      expect(decision.message.length).toBeGreaterThan(10);
    }
  });

  it('PROVISIONAL con decisión humana y verificación reciente se reserva como provisional', () => {
    expect(
      evaluateReservation({
        ...base,
        confidence: 'PROVISIONAL',
        available: 10,
        quantity: 10,
        allowProvisional: true,
        lastVerifiedAt: recent,
      })
    ).toEqual({ ok: true, provisional: true });
  });
});

describe('evaluateCountClose', () => {
  const common = { tolerancePct: 2, openDisputesOutsideCount: 0, canAdjust: true };

  it('UNCOUNTED: línea base por la diferencia y PROVISIONAL con un conteo bueno', () => {
    const outcome = evaluateCountClose({
      ...common,
      confidence: 'UNCOUNTED',
      consecutiveGoodCounts: 0,
      canAdjust: false,
      lines: [
        { expected: 0, counted: 40 },
        { expected: 5, counted: 5 },
      ],
    });
    expect(outcome.baseline).toBe(true);
    expect(outcome.nextConfidence).toBe('PROVISIONAL');
    expect(outcome.nextConsecutiveGoodCounts).toBe(1);
    expect(outcome.lines.map((l) => [l.resolution, l.movement, str(l.diff)])).toEqual([
      ['accepted', 'baseline', '40'],
      ['accepted', null, '0'],
    ]);
  });

  it('PROVISIONAL con un conteo bueno previo y diferencia tolerable: ajusta y pasa a CONTROLLED', () => {
    const outcome = evaluateCountClose({
      ...common,
      confidence: 'PROVISIONAL',
      consecutiveGoodCounts: 1,
      lines: [{ expected: 50, counted: '49.5' }],
    });
    expect(outcome.promoted).toBe(true);
    expect(outcome.nextConfidence).toBe('CONTROLLED');
    expect(outcome.nextConsecutiveGoodCounts).toBe(2);
    expect(outcome.lines[0]).toMatchObject({
      resolution: 'adjusted',
      movement: 'adjust',
      verified: true,
    });
  });

  it('sin permiso de ajuste la diferencia queda pendiente, pero el conteo sigue siendo bueno', () => {
    const outcome = evaluateCountClose({
      ...common,
      canAdjust: false,
      confidence: 'PROVISIONAL',
      consecutiveGoodCounts: 1,
      lines: [{ expected: 50, counted: 49 }],
    });
    expect(outcome.lines[0]).toMatchObject({
      resolution: 'pending',
      movement: null,
      verified: true,
    });
    expect(outcome.nextConfidence).toBe('CONTROLLED');
  });

  it('con disputas abiertas en otro conteo cuenta el conteo pero no promueve', () => {
    const outcome = evaluateCountClose({
      ...common,
      openDisputesOutsideCount: 1,
      confidence: 'PROVISIONAL',
      consecutiveGoodCounts: 1,
      lines: [{ expected: 10, counted: 10 }],
    });
    expect(outcome.promoted).toBe(false);
    expect(outcome.nextConfidence).toBe('PROVISIONAL');
    expect(outcome.nextConsecutiveGoodCounts).toBe(2);
  });

  it('cualquier línea fuera de tolerancia deja el artículo DISPUTED con contador en cero', () => {
    const outcome = evaluateCountClose({
      ...common,
      confidence: 'CONTROLLED',
      consecutiveGoodCounts: 7,
      lines: [
        { expected: 100, counted: 99 },
        { expected: 100, counted: 80 },
      ],
    });
    expect(outcome.disputed).toBe(true);
    expect(outcome.nextConfidence).toBe('DISPUTED');
    expect(outcome.nextConsecutiveGoodCounts).toBe(0);
    expect(outcome.lines.map((l) => l.resolution)).toEqual(['adjusted', 'disputed']);
    expect(outcome.lines[1].verified).toBe(false);
  });

  it('CONTROLLED dentro de tolerancia sigue controlado y suma conteos', () => {
    const outcome = evaluateCountClose({
      ...common,
      confidence: 'CONTROLLED',
      consecutiveGoodCounts: 2,
      lines: [{ expected: 10, counted: 10 }],
    });
    expect(outcome).toMatchObject({
      nextConfidence: 'CONTROLLED',
      nextConsecutiveGoodCounts: 3,
      promoted: false,
    });
  });

  it('DISPUTED sin disputas abiertas regresa a PROVISIONAL con un conteo bueno', () => {
    const outcome = evaluateCountClose({
      ...common,
      confidence: 'DISPUTED',
      consecutiveGoodCounts: 0,
      lines: [{ expected: 10, counted: 10 }],
    });
    expect(outcome).toMatchObject({
      nextConfidence: 'PROVISIONAL',
      nextConsecutiveGoodCounts: 1,
      disputeCleared: true,
    });
  });

  it('DISPUTED con disputas abiertas en otros conteos se mantiene', () => {
    const outcome = evaluateCountClose({
      ...common,
      openDisputesOutsideCount: 2,
      confidence: 'DISPUTED',
      consecutiveGoodCounts: 0,
      lines: [{ expected: 10, counted: 10 }],
    });
    expect(outcome).toMatchObject({
      nextConfidence: 'DISPUTED',
      nextConsecutiveGoodCounts: 0,
      disputeCleared: false,
    });
  });

  it('sin líneas no cambia nada', () => {
    const outcome = evaluateCountClose({
      ...common,
      confidence: 'PROVISIONAL',
      consecutiveGoodCounts: 1,
      lines: [],
    });
    expect(outcome).toMatchObject({
      nextConfidence: 'PROVISIONAL',
      nextConsecutiveGoodCounts: 1,
      lines: [],
    });
  });
});

describe('planReservationSplit', () => {
  it('prefiere una sola existencia: la preferida, luego la menor que alcanza', () => {
    const items = [
      { id: 'a', available: 100 },
      { id: 'b', available: 12 },
      { id: 'c', available: 30 },
    ];
    expect(planReservationSplit(items, 10)).toEqual([
      { id: 'b', quantity: new Prisma.Decimal(10) },
    ]);
    expect(
      planReservationSplit([...items, { id: 'd', available: 50, preferred: true }], 10)?.[0].id
    ).toBe('d');
  });

  it('reparte de mayor a menor cuando ninguna alcanza sola', () => {
    const parts = planReservationSplit(
      [
        { id: 'a', available: 4 },
        { id: 'b', available: 7 },
        { id: 'c', available: 3 },
      ],
      12
    );
    expect(parts?.map((p) => [p.id, str(p.quantity)])).toEqual([
      ['b', '7'],
      ['a', '4'],
      ['c', '1'],
    ]);
  });

  it('devuelve null si no alcanza e ignora existencias sin disponible', () => {
    expect(
      planReservationSplit(
        [
          { id: 'a', available: 4 },
          { id: 'b', available: -2 },
          { id: 'c', available: 0 },
        ],
        5
      )
    ).toBeNull();
    expect(planReservationSplit([{ id: 'a', available: 4 }], 0)).toEqual([]);
  });
});
