import { describe, expect, it } from 'vitest';
import {
  VariantKeyError,
  buildVariant,
  buildVariantKey,
  describeVariant,
  isCanonicalVariantKey,
  normalizeVariantAxis,
  normalizeVariantValue,
  parseVariantKey,
  validateVariant,
  variantAxesOf,
} from './variant-key';

describe('normalizeVariantAxis / normalizeVariantValue', () => {
  it.each([
    ['Color', 'color'],
    [' Acabado ', 'acabado'],
    ['Tamaño Nominal', 'tamano_nominal'],
    ['medida-real', 'medida_real'],
    ['9lote', ''],
    ['', ''],
    ['!!!', ''],
  ])('eje "%s" → "%s"', (input, expected) => {
    expect(normalizeVariantAxis(input)).toBe(expected);
  });

  it('valores: recorta, colapsa espacios, minúsculas y sin acentos', () => {
    expect(normalizeVariantValue('  Gris   Óxido ')).toBe('gris oxido');
    expect(normalizeVariantValue(60)).toBe('60');
    expect(normalizeVariantValue(null)).toBe('');
  });
});

describe('buildVariantKey', () => {
  it('ordena los ejes y usa forma canónica', () => {
    expect(buildVariantKey({ medida: '60X60', Color: ' Gris ' })).toBe('color=gris|medida=60x60');
  });

  it('el mismo contenido escrito distinto produce la misma llave', () => {
    const a = buildVariantKey({ color: 'Gris Perla', acabado: 'Mate' });
    const b = buildVariantKey([
      { axis: 'Acabado', value: 'mate' },
      { axis: 'COLOR', value: '  gris   perla' },
    ]);
    expect(a).toBe(b);
    expect(a).toBe('acabado=mate|color=gris perla');
  });

  it('descarta valores vacíos y sin variante devuelve cadena vacía', () => {
    expect(buildVariantKey({ color: '', medida: null, lote: undefined })).toBe('');
    expect(buildVariantKey(null)).toBe('');
    expect(buildVariantKey({})).toBe('');
  });

  it('escapa separadores dentro de los valores', () => {
    const key = buildVariantKey({ medida: '60|60', nota: 'a=b%' });
    expect(key).toBe('medida=60%7C60|nota=a%3Db%25');
    expect(parseVariantKey(key)).toEqual({ medida: '60|60', nota: 'a=b%' });
  });

  it('rechaza ejes inválidos, repetidos tras normalizar, demasiados o valores largos', () => {
    expect(() => buildVariantKey({ '9x': 'a' })).toThrow(VariantKeyError);
    expect(() => buildVariantKey({ Color: 'gris', color: 'negro' })).toThrow(VariantKeyError);
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`eje${i}`, 'x']));
    expect(() => buildVariantKey(many)).toThrow(VariantKeyError);
    expect(() => buildVariantKey({ color: 'x'.repeat(81) })).toThrow(VariantKeyError);
  });

  it('buildVariant conserva los valores para mostrar', () => {
    expect(buildVariant({ Color: '  Gris  Perla ', medida: '60X60' })).toEqual({
      key: 'color=gris perla|medida=60x60',
      json: { color: 'Gris Perla', medida: '60X60' },
      axes: ['color', 'medida'],
    });
  });
});

describe('parseVariantKey / isCanonicalVariantKey', () => {
  it('es la inversa de buildVariantKey', () => {
    const key = buildVariantKey({ rollo: 'R-12', color: 'blanco', lote: 'L2026' });
    expect(parseVariantKey(key)).toEqual({ color: 'blanco', lote: 'l2026', rollo: 'r-12' });
    expect(buildVariantKey(parseVariantKey(key))).toBe(key);
    expect(variantAxesOf(key)).toEqual(['color', 'lote', 'rollo']);
  });

  it('cadena vacía no tiene ejes', () => {
    expect(parseVariantKey('')).toEqual({});
    expect(parseVariantKey(null)).toEqual({});
  });

  it.each(['color', '=gris', 'color=', 'Color=gris', 'color=gris|color=negro'])(
    'rechaza la llave mal formada "%s"',
    (key) => {
      expect(() => parseVariantKey(key)).toThrow(VariantKeyError);
    }
  );

  it('detecta llaves no canónicas', () => {
    expect(isCanonicalVariantKey('color=gris|medida=60x60')).toBe(true);
    expect(isCanonicalVariantKey('')).toBe(true);
    expect(isCanonicalVariantKey('medida=60x60|color=gris')).toBe(false);
    expect(isCanonicalVariantKey('color=Gris')).toBe(false);
    expect(isCanonicalVariantKey('basura')).toBe(false);
  });
});

describe('validateVariant', () => {
  it('acepta ejes permitidos por el perfil (normalizados)', () => {
    expect(validateVariant({ Color: 'Gris' }, ['color', 'Medida'])).toEqual({
      ok: true,
      variantKey: 'color=gris',
      variantJson: { color: 'Gris' },
    });
  });

  it('rechaza ejes que el perfil no maneja', () => {
    const result = validateVariant({ color: 'gris', lote: 'L1' }, ['color']);
    expect(result).toMatchObject({ ok: false, code: 'invalid_variant', unknownAxes: ['lote'] });
  });

  it('un perfil sin ejes sólo acepta la variante vacía', () => {
    expect(validateVariant('', [])).toEqual({ ok: true, variantKey: '', variantJson: null });
    expect(validateVariant({ color: 'gris' }, [])).toMatchObject({
      ok: false,
      message: 'Este artículo no maneja variantes',
    });
  });

  it('acepta llaves ya canónicas y rechaza las que no lo son', () => {
    expect(validateVariant('color=gris', ['color'])).toEqual({
      ok: true,
      variantKey: 'color=gris',
      variantJson: { color: 'gris' },
    });
    expect(validateVariant('color=Gris', ['color'])).toMatchObject({ ok: false });
    expect(validateVariant('mal', ['color'])).toMatchObject({ ok: false });
  });
});

describe('describeVariant', () => {
  it('describe desde la llave o desde el JSON de despliegue', () => {
    expect(describeVariant('color=gris|medida=60x60')).toBe('color: gris · medida: 60x60');
    expect(describeVariant('color=gris', { color: 'Gris' })).toBe('color: Gris');
    expect(describeVariant('')).toBe('');
    expect(describeVariant('basura')).toBe('basura');
  });
});
