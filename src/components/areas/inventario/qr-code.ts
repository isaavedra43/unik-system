/**
 * Minimal QR encoder for the warehouse labels (plan 7.6 "ubicaciones … con
 * impresión de etiquetas QR").
 *
 * PURE and dependency free (no approved QR package exists in
 * `docs/frontend-dependencies.md`, and a label without a readable code is not a
 * label). Scope, on purpose:
 *
 * - byte mode (ISO-8859-1 / ASCII), which is what `unik:loc:<id>` and
 *   `unik:stock:<id>` need;
 * - error correction level M (~15 %), the usual choice for printed labels;
 * - versions 1 to 4 (up to 62 bytes), picked automatically;
 * - the eight mask patterns are generated and the one with the lowest penalty
 *   wins, exactly as ISO/IEC 18004 prescribes.
 *
 * Anything longer than 62 bytes returns `null`: the caller prints the code as
 * text instead of drawing a symbol nobody can scan.
 */

export const QR_MAX_BYTES = 62;

/** Error correction level M for every symbol we print. */
const EC_LEVEL_BITS = 0b00;

interface VersionSpec {
  version: number;
  /** Total data codewords of the symbol. */
  dataCodewords: number;
  /** Error correction codewords per block. */
  ecPerBlock: number;
  blocks: number;
  /** Row/column of the single alignment pattern (none in version 1). */
  alignment: number | null;
}

/** Table of ISO/IEC 18004 for EC level M, versions 1-4. */
const VERSIONS: VersionSpec[] = [
  { version: 1, dataCodewords: 16, ecPerBlock: 10, blocks: 1, alignment: null },
  { version: 2, dataCodewords: 28, ecPerBlock: 16, blocks: 1, alignment: 18 },
  { version: 3, dataCodewords: 44, ecPerBlock: 26, blocks: 1, alignment: 22 },
  { version: 4, dataCodewords: 64, ecPerBlock: 18, blocks: 2, alignment: 26 },
];

// ---------------------------------------------------------------------------
// Galois field GF(256), primitive polynomial 0x11D
// ---------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial of `degree` error correction codewords. */
export function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder of `data` for `ecCount` codewords. */
export function reedSolomon(data: readonly number[], ecCount: number): number[] {
  const generator = generatorPolynomial(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i += 1) {
        remainder[i] ^= gfMul(generator[i + 1], factor);
      }
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Format information (BCH 15,5 + mask 0x5412)
// ---------------------------------------------------------------------------

/** 15 bits of format information for EC level M and a mask pattern. */
export function formatBits(mask: number): number {
  const data = (EC_LEVEL_BITS << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if (value & (1 << (i + 10))) value ^= 0x537 << i;
  }
  return ((data << 10) | value) ^ 0x5412;
}

// ---------------------------------------------------------------------------
// Bit stream
// ---------------------------------------------------------------------------

function encodeData(bytes: readonly number[], spec: VersionSpec): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // versions 1-9 use an 8 bit count
  for (const byte of bytes) push(byte, 8);

  const capacityBits = spec.dataCodewords * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padding = [0xec, 0x11];
  let index = 0;
  while (codewords.length < spec.dataCodewords) {
    codewords.push(padding[index % 2]);
    index += 1;
  }
  return codewords;
}

/** Data and EC codewords interleaved as the standard requires. */
function interleave(codewords: readonly number[], spec: VersionSpec): number[] {
  const perBlock = spec.dataCodewords / spec.blocks;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let block = 0; block < spec.blocks; block += 1) {
    const slice = codewords.slice(block * perBlock, (block + 1) * perBlock);
    dataBlocks.push(slice);
    ecBlocks.push(reedSolomon(slice, spec.ecPerBlock));
  }
  const out: number[] = [];
  for (let i = 0; i < perBlock; i += 1) {
    for (const block of dataBlocks) out.push(block[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

type Grid = Array<Array<boolean | null>>;

function emptyGrid(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
}

function placeFinder(grid: Grid, row: number, column: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = column + c;
      if (y < 0 || x < 0 || y >= grid.length || x >= grid.length) continue;
      const border = r === 0 || r === 6 || c === 0 || c === 6;
      const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      grid[y][x] = inside ? border || center : false;
    }
  }
}

function placeAlignment(grid: Grid, center: number): void {
  for (let r = -2; r <= 2; r += 1) {
    for (let c = -2; c <= 2; c += 1) {
      grid[center + r][center + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
    }
  }
}

function placeFunctionPatterns(grid: Grid, spec: VersionSpec): void {
  const size = grid.length;
  placeFinder(grid, 0, 0);
  placeFinder(grid, 0, size - 7);
  placeFinder(grid, size - 7, 0);
  if (spec.alignment !== null) placeAlignment(grid, spec.alignment);

  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    grid[6][i] = dark;
    grid[i][6] = dark;
  }

  // Format information area (filled later) and the always dark module.
  for (let i = 0; i < 9; i += 1) {
    if (grid[8][i] === null) grid[8][i] = false;
    if (grid[i][8] === null) grid[i][8] = false;
  }
  for (let i = 0; i < 8; i += 1) {
    if (grid[8][size - 1 - i] === null) grid[8][size - 1 - i] = false;
    if (grid[size - 1 - i][8] === null) grid[size - 1 - i][8] = false;
  }
  grid[size - 8][8] = true;
}

function isFunctionModule(spec: VersionSpec, size: number, row: number, column: number): boolean {
  if (row === 6 || column === 6) return true;
  if (row < 9 && column < 9) return true;
  if (row < 9 && column >= size - 8) return true;
  if (row >= size - 8 && column < 9) return true;
  if (spec.alignment !== null) {
    const center = spec.alignment;
    if (Math.abs(row - center) <= 2 && Math.abs(column - center) <= 2) return true;
  }
  return false;
}

function placeCodewords(grid: Grid, spec: VersionSpec, codewords: readonly number[]): void {
  const size = grid.length;
  const bits: number[] = [];
  for (const codeword of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((codeword >> i) & 1);
  }

  let index = 0;
  let upward = true;
  let right = size - 1;
  while (right >= 1) {
    // Column 6 is the vertical timing pattern: the pairs jump over it.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const column of [right, right - 1]) {
        if (isFunctionModule(spec, size, row, column)) continue;
        grid[row][column] = index < bits.length ? bits[index] === 1 : false;
        index += 1;
      }
    }
    upward = !upward;
    right -= 2;
  }
}

function maskBit(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

function writeFormat(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = formatBits(mask);
  const bit = (index: number) => ((bits >> index) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) grid[8][i] = bit(i);
  grid[8][7] = bit(6);
  grid[8][8] = bit(7);
  grid[7][8] = bit(8);
  for (let i = 9; i <= 14; i += 1) grid[14 - i][8] = bit(i);

  // Second copy: bits 0-6 go up the bottom-left column, bits 7-14 along the top-right row.
  for (let i = 0; i <= 6; i += 1) grid[size - 1 - i][8] = bit(i);
  for (let i = 7; i <= 14; i += 1) grid[8][size - 15 + i] = bit(i);
  grid[size - 8][8] = true;
}

function penalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let score = 0;

  // Rule 1: runs of five or more equal modules.
  const runScore = (run: number) => (run >= 5 ? 3 + (run - 5) : 0);
  for (let i = 0; i < size; i += 1) {
    let rowRun = 1;
    let columnRun = 1;
    for (let j = 1; j < size; j += 1) {
      if (matrix[i][j] === matrix[i][j - 1]) {
        rowRun += 1;
      } else {
        score += runScore(rowRun);
        rowRun = 1;
      }
      if (matrix[j][i] === matrix[j - 1][i]) {
        columnRun += 1;
      } else {
        score += runScore(columnRun);
        columnRun = 1;
      }
    }
    score += runScore(rowRun) + runScore(columnRun);
  }

  // Rule 2: 2x2 blocks of the same colour.
  for (let i = 0; i < size - 1; i += 1) {
    for (let j = 0; j < size - 1; j += 1) {
      const value = matrix[i][j];
      if (
        value === matrix[i][j + 1] &&
        value === matrix[i + 1][j] &&
        value === matrix[i + 1][j + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like patterns.
  const pattern = [true, false, true, true, true, false, true];
  const light = [false, false, false, false];
  const matches = (values: boolean[], start: number, reference: boolean[]) =>
    reference.every((value, offset) => values[start + offset] === value);
  for (let i = 0; i < size; i += 1) {
    const row = matrix[i];
    const column = matrix.map((line) => line[i]);
    for (const values of [row, column]) {
      for (let j = 0; j + 7 <= size; j += 1) {
        if (!matches(values, j, pattern)) continue;
        const before = j >= 4 && matches(values, j - 4, light);
        const after = j + 11 <= size && matches(values, j + 7, light);
        if (before || after) score += 40;
      }
    }
  }

  // Rule 4: balance of dark modules.
  let dark = 0;
  for (const row of matrix) for (const value of row) if (value) dark += 1;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QrSymbol {
  /** Square matrix of modules; `true` is dark. */
  modules: boolean[][];
  size: number;
  version: number;
  mask: number;
}

/** Bytes of a payload in ISO-8859-1 (labels only carry ASCII). */
function toBytes(text: string): number[] | null {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0xff) return null;
    out.push(code);
  }
  return out;
}

/**
 * Encodes a payload as a QR symbol, or `null` when it does not fit (more than
 * `QR_MAX_BYTES` bytes or a character outside ISO-8859-1). The caller prints
 * the code as text in that case.
 */
export function encodeQr(text: string): QrSymbol | null {
  const bytes = toBytes(text);
  if (!bytes || bytes.length === 0 || bytes.length > QR_MAX_BYTES) return null;
  const spec = VERSIONS.find((entry) => entry.dataCodewords - 2 >= bytes.length);
  if (!spec) return null;

  const codewords = interleave(encodeData(bytes, spec), spec);
  const size = 17 + 4 * spec.version;
  const base = emptyGrid(size);
  placeFunctionPatterns(base, spec);
  placeCodewords(base, spec, codewords);

  let best: { modules: boolean[][]; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate: Grid = base.map((row) => [...row]);
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (isFunctionModule(spec, size, row, column)) continue;
        if (maskBit(mask, row, column)) candidate[row][column] = !candidate[row][column];
      }
    }
    writeFormat(candidate, mask);
    const modules = candidate.map((row) => row.map((value) => value === true));
    const score = penalty(modules);
    if (!best || score < best.score) best = { modules, mask, score };
  }
  if (!best) return null;
  return { modules: best.modules, size, version: spec.version, mask: best.mask };
}

/**
 * Path of the dark modules as a single SVG `d` attribute, so a label is one
 * `<path>` that prints crisply at any size.
 */
export function qrPath(symbol: QrSymbol): string {
  const parts: string[] = [];
  for (let row = 0; row < symbol.size; row += 1) {
    for (let column = 0; column < symbol.size; column += 1) {
      if (symbol.modules[row][column]) parts.push(`M${column} ${row}h1v1h-1z`);
    }
  }
  return parts.join('');
}
