import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `docs/component-inventory.md` se declara a sí mismo «tabla viva de
 * componentes compartidos». Nada lo obligaba, así que se quedó atrás: las 13
 * piezas compartidas de las fases 4 y 5 tenían story pero ninguna fila, y quien
 * buscara un componente para reutilizar no lo encontraba (justo lo que la regla
 * de NO DUPLICAR quiere evitar).
 *
 * Esta prueba es la única red: obliga a que cada componente con story esté en
 * la tabla, a que cada fila apunte a un archivo que existe y a que la columna
 * «Story» diga la verdad.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const componentsDir = here;
const repoRoot = path.resolve(here, '..', '..');
const inventoryPath = path.join(repoRoot, 'docs', 'component-inventory.md');
const inventoryRelative = 'docs/component-inventory.md';

/** Valores admitidos en la columna «Story». */
const STORY_VALUES = ['yes', 'planned', 'no', 'n/a'] as const;
type StoryValue = (typeof STORY_VALUES)[number];

interface InventoryRow {
  component: string;
  /** Primera ruta entre comillas invertidas de la columna «Path». */
  primaryPath: string;
  purpose: string;
  variants: string;
  story: string;
  category: string;
  /** Línea del documento (1-based), para que el fallo diga dónde mirar. */
  line: number;
}

/**
 * Componentes de UNA SOLA PANTALLA: tienen story para la regresión visual, pero
 * no son piezas compartidas y por eso no llevan fila. Cada excepción carga su
 * motivo, así que añadir una story nueva obliga a decidir entre poner la fila o
 * justificar aquí por qué no la lleva. Ampliar esta lista casi nunca es la
 * respuesta correcta (lo dice `docs/component-inventory.md`).
 */
const FEATURE_COMPONENTS = new Map<string, string>([
  [
    'sales/SalesOrdersWorkspace.stories.tsx',
    'Pantalla completa del módulo de Ventas (se monta sólo en /app/sales/orders): su story existe para la regresión visual de la tabla, no para reutilizar la pieza.',
  ],
]);

/**
 * Los componentes compartidos que nacieron en las fases 4 y 5 (áreas, Control
 * Tower, Neural y Expediente 360). Se nombran uno por uno para que borrar una
 * fila sea un fallo y no un olvido silencioso.
 */
const PHASE_4_5_SHARED = [
  'src/components/areas/AreaWorkChips.tsx',
  'src/components/areas/NextActionCard.tsx',
  'src/components/areas/OfflineBadge.tsx',
  'src/components/areas/ScanInput.tsx',
  'src/components/areas/spaces/AreaCommsList.tsx',
  'src/components/areas/ventas/RadarSignalRow.tsx',
  'src/components/areas/manufactura/CapacityBar.tsx',
  'src/components/areas/logistica/ZohoSyncPill.tsx',
  'src/components/areas/contabilidad/ContabilidadSectionNav.tsx',
  'src/components/control-tower/HealthList.tsx',
  'src/components/control-tower/neural/StepNode.tsx',
  'src/components/control-tower/neural/TimeSlider.tsx',
  'src/components/operations/case/CasePhaseProgress.tsx',
] as const;

/** Separa una fila de tabla markdown respetando las barras escapadas (`\|`). */
function splitCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function parseInventory(markdown: string): InventoryRow[] {
  const rows: InventoryRow[] = [];
  markdown.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith('|')) return;
    const cells = splitCells(line);
    if (cells.length < 6) return;
    // Encabezado y separador de la tabla.
    if (cells[0] === 'Component') return;
    if (/^:?-{3,}:?$/.test(cells[0])) return;
    const pathCell = cells[1];
    const primaryPath = /`([^`]+)`/.exec(pathCell)?.[1] ?? '';
    rows.push({
      component: cells[0],
      primaryPath,
      purpose: cells[2],
      variants: cells[3],
      story: cells[4],
      category: cells[5],
      line: index + 1,
    });
  });
  return rows;
}

/** Todas las stories bajo `src/components`, en ruta relativa a esa carpeta. */
function findStories(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...findStories(path.join(dir, entry.name), relative));
    } else if (entry.name.endsWith('.stories.tsx')) {
      found.push(relative);
    }
  }
  return found.sort();
}

const markdown = readFileSync(inventoryPath, 'utf8');
const rows = parseInventory(markdown);
const rowsByPath = new Map(rows.map((row) => [row.primaryPath, row]));
const stories = findStories(componentsDir);

describe('docs/component-inventory.md', () => {
  it('tiene una tabla con filas', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it('cada fila apunta a un archivo que existe', () => {
    const broken = rows
      .filter((row) => !row.primaryPath || !existsSync(path.join(repoRoot, row.primaryPath)))
      .map((row) => `${inventoryRelative}:${row.line} · ${row.component} → ${row.primaryPath}`);
    expect(broken).toEqual([]);
  });

  it('no repite un componente', () => {
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const row of rows) {
      if (seen.has(row.primaryPath)) duplicated.push(row.primaryPath);
      seen.add(row.primaryPath);
    }
    expect(duplicated).toEqual([]);
  });

  it('todas las columnas están llenas y la columna Story usa un valor conocido', () => {
    const problems: string[] = [];
    for (const row of rows) {
      for (const [name, value] of [
        ['Component', row.component],
        ['Purpose', row.purpose],
        ['Variants', row.variants],
        ['Category', row.category],
      ] as const) {
        if (value.length === 0) problems.push(`${row.primaryPath}: falta ${name}`);
      }
      if (!STORY_VALUES.includes(row.story as StoryValue)) {
        problems.push(
          `${row.primaryPath}: Story="${row.story}" (admitidos: ${STORY_VALUES.join(', ')})`
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('la columna Story dice la verdad sobre el archivo .stories.tsx', () => {
    const lying: string[] = [];
    for (const row of rows) {
      if (!row.primaryPath.endsWith('.tsx')) {
        // Un módulo que no es componente (p. ej. chart-theme.ts) no lleva story.
        if (row.story === 'yes') lying.push(`${row.primaryPath}: no es un .tsx y dice "yes"`);
        continue;
      }
      const hasStory = existsSync(
        path.join(repoRoot, row.primaryPath.replace(/\.tsx$/, '.stories.tsx'))
      );
      if (hasStory && row.story !== 'yes') {
        lying.push(`${row.primaryPath}: tiene story y la tabla dice "${row.story}"`);
      }
      if (!hasStory && row.story === 'yes') {
        lying.push(`${row.primaryPath}: la tabla dice "yes" y no hay .stories.tsx`);
      }
    }
    expect(lying).toEqual([]);
  });

  it('cada componente con story está en la tabla', () => {
    const missing = stories
      .filter((story) => !FEATURE_COMPONENTS.has(story))
      .map((story) => `src/components/${story.replace(/\.stories\.tsx$/, '.tsx')}`)
      .filter((componentPath) => !rowsByPath.has(componentPath));
    expect(missing).toEqual([]);
  });

  it('las excepciones declaradas siguen existiendo', () => {
    const stale = [...FEATURE_COMPONENTS.keys()].filter((story) => !stories.includes(story));
    expect(stale).toEqual([]);
  });

  it('están las 13 piezas compartidas de las fases 4 y 5', () => {
    const missing = PHASE_4_5_SHARED.filter((componentPath) => !rowsByPath.has(componentPath));
    expect(missing).toEqual([]);
  });
});
