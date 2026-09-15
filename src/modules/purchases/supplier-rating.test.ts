import { describe, expect, it } from 'vitest';
import { computeSupplierRating, decayWeight, isValidScore, supplierRiskFromRating } from './supplier-rating';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describe('computeSupplierRating', () => {
  it('sin evaluaciones no hay calificación', () => {
    expect(computeSupplierRating([], NOW)).toEqual({
      overall: null,
      onTime: null,
      quality: null,
      price: null,
      communication: null,
      count: 0,
      lastEvaluatedAt: null,
    });
  });

  it('pondera 35 % puntualidad, 35 % calidad, 20 % precio y 10 % comunicación', () => {
    const rating = computeSupplierRating([{ onTime: 5, quality: 1, price: 3, communication: 1, createdAt: NOW }], NOW);
    expect(rating.overall).toBe(2.8);
    expect(rating).toMatchObject({ onTime: 5, quality: 1, price: 3, communication: 1, count: 1 });
  });

  it('una evaluación reciente pesa más que una vieja (vida media de 180 días)', () => {
    const rating = computeSupplierRating(
      [
        { onTime: 1, quality: 1, price: 1, communication: 1, createdAt: daysAgo(360) },
        { onTime: 5, quality: 5, price: 5, communication: 5, createdAt: daysAgo(0) },
      ],
      NOW
    );
    expect(rating.overall).toBe(4.2);
    expect(rating.lastEvaluatedAt).toEqual(NOW);
  });

  it('ignora calificaciones fuera de 1–5 o no enteras', () => {
    const rating = computeSupplierRating(
      [
        { onTime: 0, quality: 5, price: 5, communication: 5, createdAt: NOW },
        { onTime: 6, quality: 5, price: 5, communication: 5, createdAt: NOW },
        { onTime: 2.5, quality: 5, price: 5, communication: 5, createdAt: NOW },
        { onTime: 4, quality: 4, price: 4, communication: 4, createdAt: NOW },
      ],
      NOW
    );
    expect(rating.count).toBe(1);
    expect(rating.overall).toBe(4);
    expect(isValidScore(3)).toBe(true);
    expect(isValidScore('3')).toBe(false);
  });

  it('decayWeight: la mitad a los 180 días, fechas futuras cuentan como hoy', () => {
    expect(decayWeight(180)).toBeCloseTo(0.5, 10);
    expect(decayWeight(-10)).toBe(1);
  });
});

describe('supplierRiskFromRating', () => {
  it('desconocido = 0.5; excelente = 0; pésimo = 1 con evaluaciones suficientes', () => {
    expect(supplierRiskFromRating(null, 0)).toBe(0.5);
    expect(supplierRiskFromRating(4, 0)).toBe(0.5);
    expect(supplierRiskFromRating(5, 3)).toBe(0);
    expect(supplierRiskFromRating(1, 3)).toBe(1);
    expect(supplierRiskFromRating(3, 10)).toBe(0.5);
  });

  it('con pocas evaluaciones se acerca a 0.5', () => {
    expect(supplierRiskFromRating(5, 1)).toBeCloseTo(1 / 3, 4);
    expect(supplierRiskFromRating(9, 5)).toBe(0);
  });
});
