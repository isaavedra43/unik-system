import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `.storybook/preview.tsx` sólo carga `src/styles/shadcn.css` y
 * `src/app/globals.css`. Las hojas de operaciones (`src/styles/operations/*.css`)
 * las importa cada ruta o cada componente, así que una pieza que usa sus clases y
 * no importa su hoja SE DIBUJA SIN ESTILO EN STORYBOOK — que es la superficie de
 * revisión de UI declarada en la puerta de la fase (`npm run build-storybook`).
 *
 * Pasaba con ocho stories (HealthList, AreaWorkChips, AreaCommsList, CapacityBar,
 * ContabilidadSectionNav, RadarSignalRow, CasePhaseProgress) y no lo veía nadie:
 * la story renderiza igual, sólo que fea, así que ninguna prueba fallaba.
 *
 * Esta prueba compara las clases que escribe cada componente CON STORY contra las
 * clases que define cada hoja de operaciones y exige que la hoja se importe desde
 * el componente o desde su story. Es deliberadamente conservadora: sólo mira
 * `className="..."` y literales de cadena del propio archivo, y descarta toda clase
 * que ya exista en `globals.css` o `shadcn.css` (esas sí las carga `preview.tsx`).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const componentsDir = here;
const operationsDir = path.join(repoRoot, 'src', 'styles', 'operations');

/** Nombres de clase que define una hoja CSS (`.foo-bar` → `foo-bar`). */
function classesOf(css: string): Set<string> {
  const found = new Set<string>();
  for (const match of css.matchAll(/\.([a-z][a-z0-9-]{2,})/g)) found.add(match[1]);
  return found;
}

const operationsSheets = new Map<string, Set<string>>();
for (const file of readdirSync(operationsDir)) {
  if (!file.endsWith('.css')) continue;
  operationsSheets.set(file, classesOf(readFileSync(path.join(operationsDir, file), 'utf8')));
}

/** Lo que `preview.tsx` ya carga: nada de esto necesita import propio. */
const previewClasses = classesOf(
  readFileSync(path.join(repoRoot, 'src', 'app', 'globals.css'), 'utf8') +
    readFileSync(path.join(repoRoot, 'src', 'styles', 'shadcn.css'), 'utf8')
);

function findStories(dir: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...findStories(path.join(dir, entry.name), relative));
    else if (entry.name.endsWith('.stories.tsx')) found.push(relative);
  }
  return found.sort();
}

/** Clases que el archivo escribe: atributos `className` y literales sueltos. */
function writtenClasses(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/className=["'`]([^"'`]*)["'`]/g)) {
    for (const name of match[1].split(/\s+/)) if (name) found.add(name);
  }
  for (const match of source.matchAll(/'([a-z][a-z0-9-]{3,})'/g)) found.add(match[1]);
  return found;
}

function importedSheets(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(/@\/styles\/operations\/([a-z0-9-]+\.css)/g)) {
    found.add(match[1]);
  }
  return found;
}

const stories = findStories(componentsDir);

describe('stories · hojas de estilo de operaciones', () => {
  it('hay stories que revisar', () => {
    expect(stories.length).toBeGreaterThan(10);
  });

  it('cada story carga las hojas de operaciones cuyas clases usa su componente', () => {
    const naked: string[] = [];
    for (const story of stories) {
      const componentRelative = story.replace(/\.stories\.tsx$/, '.tsx');
      const componentPath = path.join(componentsDir, componentRelative);
      if (!existsSync(componentPath)) continue;
      const component = readFileSync(componentPath, 'utf8');
      const storySource = readFileSync(path.join(componentsDir, story), 'utf8');
      const loaded = new Set([...importedSheets(component), ...importedSheets(storySource)]);

      const used = writtenClasses(component);
      const needed = new Set<string>();
      for (const name of used) {
        if (previewClasses.has(name)) continue;
        for (const [sheet, defined] of operationsSheets) {
          if (defined.has(name)) needed.add(sheet);
        }
      }
      for (const sheet of needed) {
        if (!loaded.has(sheet)) {
          naked.push(
            `src/components/${componentRelative} usa clases de ${sheet} y nadie la importa`
          );
        }
      }
    }
    expect(naked.sort()).toEqual([]);
  });
});
