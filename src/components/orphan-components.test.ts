import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Un componente de las superficies de áreas y Control Tower que NADIE importa
 * es código muerto: no tiene pantalla, así que nadie lo ve fallar y nadie lo
 * mantiene, pero sigue apareciendo en las búsquedas de quien quiere reutilizar
 * una pieza (justo lo contrario de la regla de NO DUPLICAR de `AGENTS.md`).
 *
 * La fase 5 dejó tres: `AreaDashboardPanel.tsx` y `AreaCommsPanel.tsx` se
 * borraron a mano en la integración, y `AreaRefreshButton.tsx` sobrevivió a esa
 * pasada porque el barrido fue manual. Esta prueba sustituye ese barrido: si un
 * componente nuevo se queda sin superficie, falla aquí y no seis meses después.
 *
 * Es deliberadamente PERMISIVA — cuenta como referencia cualquier mención del
 * nombre del archivo en otro `.ts`/`.tsx` de `src`, incluida su propia story o
 * su prueba. Un componente que sólo vive en Storybook tiene al menos ese
 * contrato; el que no tiene ni eso no tiene nada. Esa holgura es a propósito:
 * más vale dejar pasar un caso dudoso que romper el trabajo de otra persona con
 * un falso positivo.
 *
 * `component-inventory.test.ts` cubre el problema complementario (un componente
 * CON story que no está en la tabla). Las dos pruebas no se solapan.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** `src/` */
const srcDir = path.resolve(here, '..');

/**
 * Carpetas cuyos componentes tienen que estar colgados de alguna superficie.
 * Son las que entregaron las fases 4 y 5 del programa Neural Operations, que es
 * donde apareció el problema.
 */
const WATCHED_DIRS = ['components/areas', 'components/control-tower'] as const;

export interface SourceFile {
  /** Ruta relativa a `src`, con separador `/`. */
  path: string;
  text: string;
}

/**
 * Nombres de archivo (sin extensión) que no tienen ninguna mención fuera de su
 * propio archivo. Función pura para poder ejercitarla con datos sintéticos.
 */
export function findOrphanModules(candidates: SourceFile[], corpus: SourceFile[]): string[] {
  const names = new Map<string, string[]>();
  for (const candidate of candidates) {
    const name = path.basename(candidate.path).replace(/\.tsx?$/, '');
    const paths = names.get(name);
    if (paths) paths.push(candidate.path);
    else names.set(name, [candidate.path]);
  }

  /** Por nombre, las rutas de los archivos que lo mencionan. */
  const mentions = new Map<string, Set<string>>();
  for (const name of names.keys()) mentions.set(name, new Set());

  for (const file of corpus) {
    // `-` entra en el token para que `area-client-registry` cuente como uno solo.
    const tokens = file.text.match(/[A-Za-z0-9_-]+/g) ?? [];
    for (const token of tokens) {
      const bucket = mentions.get(token);
      if (bucket) bucket.add(file.path);
    }
  }

  const orphans: string[] = [];
  for (const [name, paths] of names) {
    const seen = mentions.get(name) ?? new Set<string>();
    // Su propio archivo no cuenta como referencia. Si dos archivos comparten
    // basename (p. ej. seis `register-client.tsx`), la mención de uno vale por
    // el otro: es la holgura descrita arriba.
    const external = [...seen].filter((filePath) => !paths.includes(filePath));
    if (external.length === 0) orphans.push(...paths);
  }
  return orphans.sort();
}

/** Todos los `.ts`/`.tsx` bajo `dir`, en ruta relativa a `src`. */
function collect(dir: string, prefix: string): SourceFile[] {
  const found: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...collect(path.join(dir, entry.name), relative));
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    found.push({ path: relative, text: readFileSync(path.join(dir, entry.name), 'utf8') });
  }
  return found;
}

const corpus = collect(srcDir, '');
const candidates = corpus.filter(
  (file) =>
    WATCHED_DIRS.some((dir) => file.path.startsWith(`${dir}/`)) &&
    file.path.endsWith('.tsx') &&
    !file.path.endsWith('.stories.tsx') &&
    !file.path.endsWith('.test.tsx')
);

describe('componentes de áreas y Control Tower sin superficie', () => {
  it('el barrido encuentra los archivos que dice barrer', () => {
    // Si un cambio de rutas deja el barrido en cero, la prueba pasaría sin mirar
    // nada. Estos dos números lo impiden.
    expect(corpus.length).toBeGreaterThan(500);
    expect(candidates.length).toBeGreaterThan(40);
    expect(candidates.map((file) => file.path)).toContain('components/areas/AreaWorkspace.tsx');
  });

  it('ningún componente queda sin que nadie lo importe', () => {
    const orphans = findOrphanModules(candidates, corpus);
    // Mensaje largo a propósito: el fallo tiene que decir qué hacer.
    expect(
      orphans,
      orphans.length === 0
        ? ''
        : `Estos componentes no los menciona ningún otro archivo de src:\n` +
            orphans.map((file) => `  - src/${file}`).join('\n') +
            `\nConéctalos a una superficie (página, espacio del área, story) o bórralos.`
    ).toEqual([]);
  });

  it('AreaWorkspace no es huérfano y AreaRefreshButton ya no existe', () => {
    // Doble comprobación del caso concreto que originó la prueba.
    expect(candidates.map((file) => file.path)).not.toContain(
      'components/areas/AreaRefreshButton.tsx'
    );
    const orphans = findOrphanModules(candidates, corpus);
    expect(orphans).not.toContain('components/areas/AreaWorkspace.tsx');
  });
});

describe('findOrphanModules', () => {
  const importer: SourceFile = {
    path: 'app/page.tsx',
    text: `import { Usado } from '@/components/areas/Usado';\nexport default () => <Usado />;`,
  };
  const usado: SourceFile = {
    path: 'components/areas/Usado.tsx',
    text: 'export function Usado() {}',
  };
  const huerfano: SourceFile = {
    path: 'components/areas/Huerfano.tsx',
    // Se menciona a sí mismo dos veces: eso NO cuenta como referencia.
    text: 'export function Huerfano() {}\nexport type HuerfanoProps = Parameters<typeof Huerfano>;',
  };

  it('señala el que nadie importa y respeta el que sí', () => {
    expect(findOrphanModules([usado, huerfano], [importer, usado, huerfano])).toEqual([
      'components/areas/Huerfano.tsx',
    ]);
  });

  it('una story basta como superficie', () => {
    const story: SourceFile = {
      path: 'components/areas/Huerfano.stories.tsx',
      text: `import { Huerfano } from './Huerfano';`,
    };
    expect(findOrphanModules([huerfano], [huerfano, story])).toEqual([]);
  });

  it('un nombre con guiones se reconoce entero', () => {
    const registry: SourceFile = {
      path: 'components/areas/area-client-registry.tsx',
      text: 'export const registry = {};',
    };
    const user: SourceFile = {
      path: 'components/areas/AreaWorkspace.tsx',
      text: `import { registry } from './area-client-registry';`,
    };
    expect(findOrphanModules([registry], [registry, user])).toEqual([]);
  });
});
