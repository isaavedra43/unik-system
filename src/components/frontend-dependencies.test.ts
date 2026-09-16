import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `docs/frontend-dependencies.md` se declara puerta de aprobación de las
 * dependencias de frontend, pero nada lo obligaba y se quedó atrás: `@dnd-kit/core`
 * y `@dnd-kit/sortable` llevaban meses instalados y usados en nueve archivos
 * mientras el documento seguía diciendo «NO instalar», y `@dnd-kit/utilities` no
 * aparecía en absoluto. Un documento que miente justo donde decide qué se puede
 * instalar es peor que no tenerlo.
 *
 * Esta prueba es la red, en las cuatro direcciones en que el documento puede mentir:
 * 1. algo de «APPROVED ON DEMAND» / «NOT ALLOWED WITHOUT REVIEW» está instalado;
 * 2. una fila nombra un paquete que no está en `package.json`;
 * 3. se instaló un paquete de una familia ya aprobada (`@dnd-kit/*`, `@tanstack/*`…)
 *    sin darle su fila — que es exactamente como se coló `@dnd-kit/utilities`;
 * 4. un Client Component importa un paquete instalado que NO tiene fila. Las tres
 *    primeras no atrapaban ese caso y por eso Leaflet (`leaflet`, `react-leaflet`,
 *    `@types/leaflet`) llegó a dos mapas —el del chat y el del despacho— mientras el
 *    documento sólo mencionaba `MapLibre GL` en «APPROVED ON DEMAND».
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const docRelative = 'docs/frontend-dependencies.md';
const docPath = path.join(repoRoot, docRelative);

const markdown = readFileSync(docPath, 'utf8');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const installed = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

/** Un nombre de paquete npm (`lodash`, `@scope/nombre`), no un título humano. */
function isPackageName(value: string): boolean {
  return /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(value);
}

interface DocSection {
  title: string;
  lines: string[];
}

/** Corta el documento por encabezados `##`, conservando el orden. */
function sections(): DocSection[] {
  const found: DocSection[] = [];
  let current: DocSection | null = null;
  for (const raw of markdown.split('\n')) {
    const heading = /^##\s+(.*)$/.exec(raw.trim());
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      found.push(current);
      continue;
    }
    current?.lines.push(raw);
  }
  return found;
}

const allSections = sections();

function section(title: string): DocSection {
  const found = allSections.find((entry) => entry.title === title);
  if (!found) throw new Error(`${docRelative}: falta la sección "## ${title}"`);
  return found;
}

/** Paquetes nombrados en la primera celda de una tabla markdown. */
function tablePackages(entry: DocSection): string[] {
  const names: string[] = [];
  for (const raw of entry.lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const first = line.replace(/^\|/, '').split('|')[0]?.trim() ?? '';
    const name = /^`([^`]+)`$/.exec(first)?.[1];
    if (name && isPackageName(name)) names.push(name);
  }
  return names;
}

/**
 * Paquetes nombrados en una lista de viñetas. Las entradas humanas (`MapLibre GL`,
 * `Sigma.js` + `Graphology`, `moment.js`, o una viñeta en prosa) se ignoran: sólo
 * se comprueba lo que se puede buscar en `package.json`.
 */
function bulletPackages(entry: DocSection): string[] {
  const names: string[] = [];
  for (const raw of entry.lines) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const name = /^- `([^`]+)`/.exec(line)?.[1];
    if (name && isPackageName(name)) names.push(name);
  }
  return names;
}

const documented = [
  ...tablePackages(section('CORE INSTALLED')),
  ...tablePackages(section('STORYBOOK / TESTING')),
];

/**
 * Plataforma y validación compartida: no son «dependencias de frontend» que se
 * decidan en este documento, y el propio documento lo dice en «APPROVED ON DEMAND».
 */
const PLATFORM = new Set(['next', 'react', 'react-dom', 'zod']);

/** Archivos `.ts`/`.tsx` de una carpeta, sin pruebas ni stories. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|stories)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const IMPORT_SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/** `@scope/pkg/sub` → `@scope/pkg`; `leaflet/dist/leaflet.css` → `leaflet`. */
function packageOf(specifier: string): string | null {
  if (!specifier || /^[./]/.test(specifier) || specifier.startsWith('@/')) return null;
  if (specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Paquetes instalados que importa un Client Component (`'use client'`): todo lo
 * que termina en el bundle del navegador y por tanto es una decisión de frontend.
 * Un módulo de servidor puede importar `exceljs` o `@prisma/client` sin fila.
 */
function clientDependencies(): Map<string, string[]> {
  const roots = ['src/components', 'src/app', 'src/lib'].map((rel) => path.join(repoRoot, rel));
  const found = new Map<string, string[]>();
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8');
      if (!/^\s*['"]use client['"]/m.test(text.slice(0, 400))) continue;
      for (const match of text.matchAll(IMPORT_SPECIFIER)) {
        const name = packageOf(match[1]);
        if (!name || !installed.has(name) || PLATFORM.has(name)) continue;
        const files = found.get(name) ?? [];
        const relative = path.relative(repoRoot, file);
        if (files.length < 3 && !files.includes(relative)) files.push(relative);
        found.set(name, files);
      }
    }
  }
  return found;
}
const onDemand = bulletPackages(section('APPROVED ON DEMAND'));
const notAllowed = bulletPackages(section('NOT ALLOWED WITHOUT REVIEW'));

describe('docs/frontend-dependencies.md', () => {
  it('las tablas nombran paquetes', () => {
    expect(documented.length).toBeGreaterThan(10);
  });

  it('nada de «APPROVED ON DEMAND» está instalado', () => {
    const contradictions = onDemand
      .filter((name) => installed.has(name))
      .map((name) => `${name}: instalado y listado como "NO instalar hasta que haga falta"`);
    expect(contradictions).toEqual([]);
  });

  it('nada de «NOT ALLOWED WITHOUT REVIEW» está instalado', () => {
    const contradictions = notAllowed.filter((name) => installed.has(name));
    expect(contradictions).toEqual([]);
  });

  it('un paquete no puede estar aprobado y prohibido a la vez', () => {
    const both = documented.filter((name) => onDemand.includes(name) || notAllowed.includes(name));
    expect(both).toEqual([]);
  });

  it('cada fila apunta a un paquete realmente instalado', () => {
    const ghosts = documented.filter((name) => !installed.has(name));
    expect(ghosts).toEqual([]);
  });

  it('no repite un paquete entre las tablas', () => {
    const seen = new Set<string>();
    const duplicated = documented.filter((name) => {
      if (seen.has(name)) return true;
      seen.add(name);
      return false;
    });
    expect(duplicated).toEqual([]);
  });

  it('una familia aprobada está documentada entera (así se coló @dnd-kit/utilities)', () => {
    const approvedScopes = new Set(
      documented.filter((name) => name.startsWith('@')).map((name) => name.split('/')[0])
    );
    const missing = [...installed]
      .filter((name) => name.startsWith('@') && approvedScopes.has(name.split('/')[0]))
      .filter((name) => !documented.includes(name))
      .sort();
    expect(missing).toEqual([]);
  });

  it('cada paquete que llega al navegador tiene su fila (así se coló Leaflet)', () => {
    const undocumented = [...clientDependencies().entries()]
      .filter(([name]) => !documented.includes(name))
      .map(([name, files]) => `${name}: lo importa ${files.join(', ')} y no tiene fila`)
      .sort();
    expect(undocumented).toEqual([]);
  });

  it('`leaflet` está aprobado con sus condiciones de uso', () => {
    // El hueco: instalado y usado en los dos mapas mientras el documento sólo
    // hablaba de `MapLibre GL`, y ninguna de las tres direcciones lo veía.
    for (const name of ['leaflet', 'react-leaflet']) {
      expect(installed.has(name)).toBe(true);
      expect(documented).toContain(name);
    }
    expect(installed.has('@types/leaflet')).toBe(true);
    expect(markdown).toContain('### `leaflet` + `react-leaflet` — condiciones de uso');
    expect(markdown).toContain('dynamic(() => import(...), { ssr: false })');
  });

  it('`@dnd-kit/*` está aprobado con sus condiciones de uso', () => {
    // El hueco concreto que originó la prueba: los tres paquetes instalados, usados
    // en 7 `DndContext`, y el documento seguía diciendo que no se instalaran.
    for (const name of ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities']) {
      expect(installed.has(name)).toBe(true);
      expect(documented).toContain(name);
    }
    expect(markdown).toContain('### `@dnd-kit/*` — condiciones de uso');
    expect(markdown).toContain('id={useId()}');
  });
});
