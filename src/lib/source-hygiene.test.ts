import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Higiene de fuentes: NINGÚN archivo del repositorio puede llevar bytes de
 * control literales.
 *
 * Por qué importa (no es cosmético): `grep`, `ugrep` y `ripgrep` deciden si un
 * archivo es binario mirando sus primeros bytes. Un NUL (0x00) o un 0x1f
 * escrito COMO CARÁCTER dentro de una expresión regular o de una cadena hace
 * que el archivo deje de ser texto para esas herramientas, y entonces lo OMITEN
 * EN SILENCIO de cualquier búsqueda: `grep -rn "direct_delivery" src/` no
 * devuelve nada aunque la cadena esté ahí. No falla nada en tiempo de
 * ejecución —las pruebas pasan igual—, pero toda auditoría por búsqueda da
 * falsos negativos sobre esos archivos, y quien audite concluirá que un hueco
 * sigue abierto cuando ya estaba cerrado. Eso ya ocurrió en este repositorio.
 *
 * El arreglo siempre es el mismo y no cambia el comportamiento: escribir el
 * byte como secuencia de escape (`\x00`, `\x1f`, `\x7f`) en vez de pegarlo
 * literal. El motor de JavaScript ve exactamente el mismo carácter; `grep` ve
 * texto.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

/** Carpetas que sí son fuente del proyecto. El resto no se audita. */
const SCAN_ROOTS = ['src', 'scripts', 'e2e', 'tests', 'prisma', '.storybook', 'docs'] as const;

/** Carpetas generadas o de terceros: nunca se revisan. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.turbo',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  'storybook-static',
]);

/** Extensiones de texto que se auditan. */
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.md',
  '.json',
  '.prisma',
  '.yml',
  '.yaml',
]);

/** Los únicos bytes por debajo de 0x20 que sí son texto. */
const ALLOWED_CONTROL_BYTES = new Set([0x09 /* tab */, 0x0a /* LF */, 0x0d /* CR */]);

/**
 * Decide si un byte rompe la detección de texto. Se expone para que la prueba
 * de control negativo compruebe que el detector NO es vacío.
 */
export function isLiteralControlByte(byte: number): boolean {
  if (byte === 0x7f) return true;
  if (byte >= 0x20) return false;
  return !ALLOWED_CONTROL_BYTES.has(byte);
}

interface ControlByteHit {
  /** Ruta relativa a la raíz del repositorio. */
  file: string;
  line: number;
  column: number;
  byte: number;
}

/** Recorre las carpetas de fuente y devuelve las rutas relativas auditables. */
function collectSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (absoluteDir: string) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SCANNED_EXTENSIONS.has(path.extname(entry.name))) continue;
      found.push(path.relative(repoRoot, absolute));
    }
  };
  for (const root of SCAN_ROOTS) {
    const absolute = path.join(repoRoot, root);
    try {
      if (!statSync(absolute).isDirectory()) continue;
    } catch {
      // Una raíz opcional que no existe no es un fallo; la prueba de cobertura
      // mínima detecta que el recorrido se quedó vacío.
      continue;
    }
    walk(absolute);
  }
  return found.sort();
}

/** Encuentra los bytes de control de un archivo, con línea y columna. */
export function findControlBytes(relativePath: string, contents: Buffer): ControlByteHit[] {
  const hits: ControlByteHit[] = [];
  let line = 1;
  let column = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const byte = contents[index];
    if (isLiteralControlByte(byte)) {
      hits.push({ file: relativePath, line, column, byte });
    }
    if (byte === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return hits;
}

function describeHit(hit: ControlByteHit): string {
  const hex = `0x${hit.byte.toString(16).padStart(2, '0')}`;
  const escape = `\\x${hit.byte.toString(16).padStart(2, '0')}`;
  return `${hit.file}:${hit.line}:${hit.column} → byte ${hex} literal (escríbelo como ${escape})`;
}

describe('higiene de fuentes: bytes de control literales', () => {
  const files = collectSourceFiles();

  it('el recorrido encuentra el árbol de fuentes (si esto falla, el resto sería un falso verde)', () => {
    expect(files.length).toBeGreaterThan(300);
    // Los archivos que ya tuvieron el defecto: si alguno se mueve y deja de
    // auditarse, es mejor que falle aquí que quedarse sin red.
    expect(files).toContain(path.join('src', 'modules', 'operations', 'request-kinds.ts'));
    expect(files).toContain(path.join('src', 'modules', 'inventory', 'labels-service.ts'));
    expect(files).toContain(path.join('src', 'modules', 'control-tower', 'conformance.ts'));
    expect(files).toContain(path.join('src', 'modules', 'control-tower', 'replay.ts'));
    expect(files).toContain(path.join('src', 'modules', 'control-tower', 'variants.ts'));
  });

  it('el detector reconoce un NUL (control negativo: la prueba no es vacía)', () => {
    const sample = Buffer.from([0x61, 0x00, 0x0a, 0x62, 0x1f]);
    const hits = findControlBytes('ejemplo.ts', sample);
    expect(hits).toEqual([
      { file: 'ejemplo.ts', line: 1, column: 2, byte: 0x00 },
      { file: 'ejemplo.ts', line: 2, column: 2, byte: 0x1f },
    ]);
    expect(isLiteralControlByte(0x09)).toBe(false);
    expect(isLiteralControlByte(0x0a)).toBe(false);
    expect(isLiteralControlByte(0x0d)).toBe(false);
    expect(isLiteralControlByte(0x7f)).toBe(true);
  });

  it('ningún archivo de fuente lleva bytes de control literales', () => {
    const hits = files.flatMap((relativePath) =>
      findControlBytes(relativePath, readFileSync(path.join(repoRoot, relativePath)))
    );
    expect(
      hits.map(describeHit),
      'Estos archivos dejan de ser texto para grep/ripgrep y desaparecen en silencio de las búsquedas de código.'
    ).toEqual([]);
  });

  it('todo archivo auditado sigue siendo texto para una herramienta de búsqueda', () => {
    // Misma heurística que usa grep: revisa el primer bloque del archivo.
    const noTexto = files.filter((relativePath) => {
      const head = readFileSync(path.join(repoRoot, relativePath)).subarray(0, 32 * 1024);
      return head.some((byte) => isLiteralControlByte(byte));
    });
    expect(noTexto).toEqual([]);
  });
});
