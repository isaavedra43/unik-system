import { describe, expect, it } from 'vitest';
import {
  QR_MAX_BYTES,
  encodeQr,
  formatBits,
  generatorPolynomial,
  qrPath,
  reedSolomon,
} from './qr-code';

/**
 * The encoder is verified by the invariants of the standard, not by eyeballing
 * a picture: the Reed-Solomon codeword must be divisible by the generator, the
 * format information must satisfy its BCH code, and the symbol must carry the
 * three finder patterns, the timing patterns and the dark module where
 * ISO/IEC 18004 puts them.
 */

const LOCATION_PAYLOAD = 'unik:loc:clz9k2h4c0000qw0h8m2n5xyz';
const STOCK_PAYLOAD = 'unik:stock:clz9k2h4c0000qw0h8m2n5xyz';

/** GF(256) multiplication, rebuilt here so the test does not trust the module. */
function gfMul(a: number, b: number): number {
  let result = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if (y & 1) result ^= x;
    y >>= 1;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  return result;
}

/** Remainder of a polynomial divided by the generator, computed independently. */
function remainder(codewords: readonly number[], generator: readonly number[]): number[] {
  const work = [...codewords];
  const degree = generator.length - 1;
  for (let i = 0; i < work.length - degree; i += 1) {
    const factor = work[i];
    if (factor === 0) continue;
    for (let j = 0; j <= degree; j += 1) {
      work[i + j] ^= gfMul(generator[j], factor);
    }
  }
  return work.slice(work.length - degree);
}

describe('Reed-Solomon', () => {
  it('el polinomio generador tiene el grado pedido y empieza en 1', () => {
    const generator = generatorPolynomial(10);
    expect(generator).toHaveLength(11);
    expect(generator[0]).toBe(1);
  });

  it('la palabra de código completa es divisible entre el generador', () => {
    const data = [64, 196, 132, 84, 196, 196, 242, 194, 4, 132, 20, 5, 68, 5, 96, 236];
    for (const ecCount of [10, 16, 26, 18]) {
      const ec = reedSolomon(data, ecCount);
      expect(ec).toHaveLength(ecCount);
      const zero = remainder([...data, ...ec], generatorPolynomial(ecCount));
      expect(
        zero.every((value) => value === 0),
        `EC ${ecCount}`
      ).toBe(true);
    }
  });
});

describe('información de formato', () => {
  it('cumple el código BCH de la norma', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const bits = formatBits(mask);
      expect(bits).toBeGreaterThan(0);
      expect(bits).toBeLessThan(1 << 15);
      // Quitando la máscara fija, los 15 bits deben ser múltiplo del generador 0x537.
      let value = bits ^ 0x5412;
      for (let i = 4; i >= 0; i -= 1) {
        if (value & (1 << (i + 10))) value ^= 0x537 << i;
      }
      expect(value, `máscara ${mask}`).toBe(0);
    }
  });

  it('coincide con el valor publicado para nivel M y máscara 0', () => {
    expect(formatBits(0)).toBe(0b101010000010010);
  });
});

describe('símbolo', () => {
  const symbol = encodeQr(LOCATION_PAYLOAD);

  it('elige la versión más pequeña que admite el contenido', () => {
    expect(symbol).not.toBeNull();
    if (!symbol) return;
    // 28 bytes caben en la versión 2 (26) apenas no, así que sube a la 3.
    expect(symbol.version).toBe(3);
    expect(symbol.size).toBe(17 + 4 * symbol.version);
    expect(symbol.modules).toHaveLength(symbol.size);
    expect(symbol.modules.every((row) => row.length === symbol.size)).toBe(true);
  });

  it('coloca los tres patrones de búsqueda con su separador', () => {
    if (!symbol) return;
    const corners: Array<[number, number]> = [
      [0, 0],
      [0, symbol.size - 7],
      [symbol.size - 7, 0],
    ];
    for (const [row, column] of corners) {
      expect(symbol.modules[row][column]).toBe(true);
      expect(symbol.modules[row + 1][column + 1]).toBe(false);
      expect(symbol.modules[row + 3][column + 3]).toBe(true);
      expect(symbol.modules[row + 6][column + 6]).toBe(true);
    }
  });

  it('dibuja los patrones de tiempo alternados', () => {
    if (!symbol) return;
    for (let i = 8; i < symbol.size - 8; i += 1) {
      expect(symbol.modules[6][i], `fila 6, columna ${i}`).toBe(i % 2 === 0);
      expect(symbol.modules[i][6], `columna 6, fila ${i}`).toBe(i % 2 === 0);
    }
  });

  it('deja siempre oscuro el módulo obligatorio', () => {
    if (!symbol) return;
    expect(symbol.modules[symbol.size - 8][8]).toBe(true);
  });

  it('usa una de las ocho máscaras y no deja el símbolo en blanco', () => {
    if (!symbol) return;
    expect(symbol.mask).toBeGreaterThanOrEqual(0);
    expect(symbol.mask).toBeLessThan(8);
    const dark = symbol.modules.flat().filter(Boolean).length;
    const ratio = dark / (symbol.size * symbol.size);
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.7);
  });

  it('dos contenidos distintos producen símbolos distintos', () => {
    const other = encodeQr(STOCK_PAYLOAD);
    expect(other).not.toBeNull();
    if (!symbol || !other) return;
    expect(JSON.stringify(other.modules)).not.toBe(JSON.stringify(symbol.modules));
  });

  it('devuelve null cuando no cabe o no es imprimible', () => {
    expect(encodeQr('')).toBeNull();
    expect(encodeQr('x'.repeat(QR_MAX_BYTES + 1))).toBeNull();
    expect(encodeQr('ünïcödé ✅ fuera de ISO-8859-1')).toBeNull();
  });

  it('el mismo contenido siempre da el mismo símbolo', () => {
    const again = encodeQr(LOCATION_PAYLOAD);
    expect(JSON.stringify(again)).toBe(JSON.stringify(symbol));
  });
});

describe('ruta SVG', () => {
  it('dibuja un cuadrito por módulo oscuro', () => {
    const symbol = encodeQr('unik:loc:abc');
    expect(symbol).not.toBeNull();
    if (!symbol) return;
    const path = qrPath(symbol);
    const dark = symbol.modules.flat().filter(Boolean).length;
    expect(path.split('M').length - 1).toBe(dark);
    expect(path.startsWith('M')).toBe(true);
  });
});
