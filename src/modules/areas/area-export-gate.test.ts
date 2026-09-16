import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AREA_REGISTRY,
  areaExportPermissions,
  areaViewPermissions,
  holdsAny,
} from './area-registry';

/**
 * The export key has to govern the real export (plan 6.1).
 *
 * `purchases.export` existed in the registry and in a CSV helper nobody called,
 * while the export that people actually use — the one of the work centre — was
 * opened with `canExport` hard-coded to `true` and a server action that only
 * demanded the area's VIEW permission. Both halves are checked here: the rule
 * itself (with the registry) and its two wiring points, which Vitest cannot
 * execute (a `'use server'` action and a React Server Component), so their
 * source is read instead of left unguarded.
 */

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../app/app/areas/[areaKey]');

const actionsSource = readFileSync(resolve(appDir, 'actions.ts'), 'utf8');
const pageSource = readFileSync(resolve(appDir, '[space]/page.tsx'), 'utf8');
const exportAction = actionsSource.slice(
  actionsSource.indexOf('export async function exportAreaRowsAction')
);

describe('puerta de exportación del centro de trabajo', () => {
  it('quien sólo ve Compras no la exporta; quien tiene la llave sí', () => {
    const lector = { permissionKeys: ['purchases.view'], isSuperAdmin: false };
    const comprador = {
      permissionKeys: ['purchases.view', 'purchases.export'],
      isSuperAdmin: false,
    };
    expect(holdsAny(lector, areaViewPermissions(AREA_REGISTRY.compras))).toBe(true);
    expect(holdsAny(lector, areaExportPermissions(AREA_REGISTRY.compras))).toBe(false);
    expect(holdsAny(comprador, areaExportPermissions(AREA_REGISTRY.compras))).toBe(true);
  });

  it('la acción de servidor exige la llave de exportación, no la de ver', () => {
    expect(exportAction).toContain('areaExportPermissions(area)');
    expect(exportAction).toContain('AuthorizationError');
    // El permiso se comprueba ANTES de leer una sola fila.
    expect(exportAction.indexOf('areaExportPermissions(area)')).toBeLessThan(
      exportAction.indexOf('exportAreaWorkRows(')
    );
  });

  it('la página ya no enciende el botón para cualquiera', () => {
    expect(pageSource).toContain('areaExportPermissions(area)');
    expect(pageSource).toContain('canExport={holdsAny(user, exportPermissions)}');
    // La regresión concreta que había: `canExport` sin valor (true literal).
    expect(pageSource).not.toMatch(/^\s+canExport$/m);
  });
});
