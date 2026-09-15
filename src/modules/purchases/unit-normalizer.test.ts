import { describe, expect, it } from 'vitest';
import {
  baseUnitsPer,
  canonicalUnit,
  convertQuantity,
  parseLocaleNumber,
  resolveUnitFactor,
  sameCanonicalUnit,
  standardFactor,
  unitFamily,
} from './unit-normalizer';

const tiles = { baseUnit: 'm2', conversions: [{ unit: 'caja', factor: '1.44' }] };

describe('canonicalUnit', () => {
  it.each([
    ['Metros cuadrados', 'm2'],
    ['M²', 'm2'],
    ['PZA.', 'pz'],
    ['Piezas', 'pz'],
    ['Centímetros', 'cm'],
    ['Kilos', 'kg'],
    ['Toneladas', 'ton'],
    ['metro lineal', 'm'],
    ['Pies cuadrados', 'ft2'],
    ['Docenas', 'docena'],
    ['Cajas', 'caja'],
    ['', ''],
  ])('%s → %s', (raw, expected) => {
    expect(canonicalUnit(raw)).toBe(expected);
  });

  it('deja "ml" ambiguo (metro lineal o mililitro) sin convertir', () => {
    expect(canonicalUnit('ml')).toBe('ml');
    expect(unitFamily('ml')).toBeNull();
    expect(resolveUnitFactor('ml', 'm')).toBeNull();
    expect(canonicalUnit('mililitros')).toBe('mililitro');
  });
});

describe('standardFactor', () => {
  it('convierte dentro de la misma familia física', () => {
    expect(standardFactor('km', 'm')).toBe(1000);
    expect(standardFactor('cm', 'm')).toBeCloseTo(0.01, 10);
    expect(standardFactor('ton', 'kg')).toBe(1000);
    expect(standardFactor('docena', 'pz')).toBe(12);
    expect(standardFactor('lb', 'kg')).toBeCloseTo(0.45359237, 8);
    expect(standardFactor('litros', 'm3')).toBeCloseTo(0.001, 10);
  });

  it('no mezcla familias ni unidades comerciales', () => {
    expect(standardFactor('m', 'kg')).toBeNull();
    expect(standardFactor('caja', 'pz')).toBeNull();
    expect(standardFactor('', 'm')).toBeNull();
    expect(unitFamily('caja')).toBeNull();
    expect(unitFamily('cm')).toBe('length');
  });
});

describe('resolveUnitFactor con el perfil del artículo', () => {
  it('usa las conversiones explícitas y las tablas físicas a través de la unidad base', () => {
    expect(baseUnitsPer('caja', tiles)).toBeCloseTo(1.44, 10);
    expect(baseUnitsPer('cm2', tiles)).toBeCloseTo(0.0001, 10);
    expect(resolveUnitFactor('caja', 'm2', tiles)).toBeCloseTo(1.44, 10);
    expect(resolveUnitFactor('m2', 'caja', tiles)).toBeCloseTo(1 / 1.44, 10);
    expect(resolveUnitFactor('caja', 'cm2', tiles)).toBeCloseTo(14_400, 6);
  });

  it('dos unidades vacías son la misma; una vacía es desconocida', () => {
    expect(resolveUnitFactor('', '')).toBe(1);
    expect(resolveUnitFactor('pz', '')).toBeNull();
    expect(resolveUnitFactor('Metros cuadrados', 'm2')).toBe(1);
  });

  it('una conversión inválida del perfil no inventa factor', () => {
    expect(resolveUnitFactor('caja', 'm2', { baseUnit: 'm2', conversions: [{ unit: 'caja', factor: '0' }] })).toBeNull();
  });

  it('convertQuantity redondea a 6 decimales', () => {
    expect(convertQuantity(3, 'caja', 'm2', tiles)).toBe(4.32);
    expect(convertQuantity(10, 'rollo', 'm2', tiles)).toBeNull();
    expect(convertQuantity(Number.NaN, 'm2', 'm2')).toBeNull();
  });

  it('sameCanonicalUnit compara textos distintos de la misma unidad', () => {
    expect(sameCanonicalUnit('M2', 'metro cuadrado')).toBe(true);
    expect(sameCanonicalUnit('pz', 'caja')).toBe(false);
    expect(sameCanonicalUnit('', '')).toBe(false);
  });
});

describe('parseLocaleNumber', () => {
  it.each([
    ['$1,250.50', 1250.5],
    ['1.250,50', 1250.5],
    ['1,250', 1250],
    ['12,5', 12.5],
    ['1.25', 1.25],
    ['1.250.000', 1_250_000],
    ['1 250', 1250],
    ['MXN 350', 350],
    ['-45.5', -45.5],
    ['(12)', -12],
  ])('%s → %s', (raw, expected) => {
    expect(parseLocaleNumber(raw)).toBe(expected);
  });

  it('acepta números y rechaza lo que no es número', () => {
    expect(parseLocaleNumber(-3)).toBe(-3);
    expect(parseLocaleNumber(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseLocaleNumber('sin precio')).toBeNull();
    expect(parseLocaleNumber(null)).toBeNull();
    expect(parseLocaleNumber({})).toBeNull();
  });
});
