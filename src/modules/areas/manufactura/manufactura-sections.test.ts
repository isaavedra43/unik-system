import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getArea } from '@/modules/areas/area-registry';
import {
  MANUFACTURING_BOM_PATH,
  MANUFACTURING_NEW_ORDER_PATH,
  MANUFACTURING_WORK_CENTERS_PATH,
} from '@/modules/manufacturing/manufacturing-types';
import {
  MANUFACTURA_BOARD_SLUG,
  MANUFACTURA_ORDERS_SLUG,
  MANUFACTURA_SECTIONS,
  manufacturaSection,
  manufacturaSectionTabs,
  visibleManufacturaSections,
} from './manufactura-sections';

/**
 * La entrega 6 del plan promete la gestión de listas de materiales (crear,
 * versionar, activar, retirar) y su orden de trabajo termina en UI. La página
 * existía desde el primer día, pero NADIE la enlazaba: el único camino era
 * teclear `/app/manufacturing/bom`. Estas pruebas son la red que lo impide:
 * fijan qué secciones hay, quién las ve y —sobre todo— que la interfaz las
 * enlaza de verdad.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const read = (relative: string) => readFileSync(resolve(repoRoot, relative), 'utf8');

/** Archivo de ruta que atiende un href de la aplicación (`/app/x` → `src/app/app/x/page.tsx`). */
function routeFileFor(href: string): string {
  return `src/app${href}/page.tsx`;
}

describe('secciones de Manufactura', () => {
  it('incluye las dos superficies de gestión que viven fuera de /app/areas', () => {
    const bom = manufacturaSection('bom');
    const centros = manufacturaSection('centros');
    expect(bom?.href).toBe(MANUFACTURING_BOM_PATH);
    expect(centros?.href).toBe(MANUFACTURING_WORK_CENTERS_PATH);
  });

  it('los slugs del área son los que declara el registro, no copias a mano', () => {
    const area = getArea('manufactura');
    expect(area?.special.slug).toBe(MANUFACTURA_BOARD_SLUG);
    expect(area?.subpages.map((subpage) => subpage.slug)).toContain(MANUFACTURA_ORDERS_SLUG);
    expect(manufacturaSection(MANUFACTURA_BOARD_SLUG)?.href).toBe('/app/areas/manufactura/tablero');
    expect(manufacturaSection(MANUFACTURA_ORDERS_SLUG)?.href).toBe(
      '/app/areas/manufactura/ordenes'
    );
  });

  it('cada href de gestión tiene su archivo de ruta (ningún enlace a la nada)', () => {
    for (const href of [
      MANUFACTURING_BOM_PATH,
      MANUFACTURING_WORK_CENTERS_PATH,
      MANUFACTURING_NEW_ORDER_PATH,
    ]) {
      expect({ href, exists: existsSync(resolve(repoRoot, routeFileFor(href))) }).toEqual({
        href,
        exists: true,
      });
    }
  });

  it('los ids son únicos y sirven de activeId del TabNav compartido', () => {
    const ids = MANUFACTURA_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('quién ve cada sección', () => {
  it('sin permisos de manufactura no ve ninguna', () => {
    expect(visibleManufacturaSections({ permissionKeys: ['sales_orders.view'] })).toEqual([]);
  });

  it('`manufacturing.view` abre las cuatro', () => {
    const sections = visibleManufacturaSections({ permissionKeys: ['manufacturing.view'] });
    expect(sections.map((section) => section.id)).toEqual([
      MANUFACTURA_BOARD_SLUG,
      MANUFACTURA_ORDERS_SLUG,
      'bom',
      'centros',
    ]);
  });

  it('un super admin las ve todas sin llaves sueltas', () => {
    expect(
      visibleManufacturaSections({ permissionKeys: [], isSuperAdmin: true }).map((s) => s.id)
    ).toEqual(MANUFACTURA_SECTIONS.map((section) => section.id));
  });

  it('`operations.admin` sólo ve las que puede abrir de verdad', () => {
    // `/app/areas/**` acepta `operations.admin` (areaViewPermissions); las dos
    // páginas de gestión llaman `requirePermission('manufacturing.view')`, que
    // esa clave NO satisface: ofrecérselas sería enlazar a un 403.
    const ids = visibleManufacturaSections({ permissionKeys: ['operations.admin'] }).map(
      (section) => section.id
    );
    expect(ids).toEqual([MANUFACTURA_BOARD_SLUG, MANUFACTURA_ORDERS_SLUG]);
    expect(ids).not.toContain('bom');
    expect(ids).not.toContain('centros');
  });

  it('manufacturaSectionTabs entrega exactamente lo que pide TabNav', () => {
    const tabs = manufacturaSectionTabs({ permissionKeys: ['manufacturing.view'] });
    expect(tabs).toHaveLength(4);
    for (const tab of tabs) {
      expect(Object.keys(tab).sort()).toEqual(['href', 'id', 'label']);
      expect(tab.href.startsWith('/app/')).toBe(true);
      expect(tab.label.length).toBeGreaterThan(0);
    }
  });
});

describe('las listas de materiales son alcanzables desde la interfaz', () => {
  // El hueco de la sección 8: `manufacturing.bom.create|update|activate|retire`
  // sólo se podía usar tecleando la URL. Si alguien quita estos enlaces, aquí
  // se entera.
  it('el tablero de producción enlaza la página de listas de materiales', () => {
    const board = read('src/components/areas/manufactura/ProductionBoard.tsx');
    expect(board).toContain('MANUFACTURING_BOM_PATH');
    expect(board).toContain('Listas de materiales');
  });

  it('las tres páginas de gestión pintan la tira de secciones', () => {
    for (const page of [
      'src/app/app/areas/manufactura/bom/page.tsx',
      'src/app/app/areas/manufactura/centros/page.tsx',
      'src/app/app/areas/manufactura/ordenes/nueva/page.tsx',
    ]) {
      const source = read(page);
      expect({ page, usesTabs: source.includes('manufacturaSectionTabs') }).toEqual({
        page,
        usesTabs: true,
      });
      expect({ page, usesTabNav: source.includes('<TabNav') }).toEqual({ page, usesTabNav: true });
    }
  });

  it('ningún archivo de la interfaz vuelve a escribir la ruta a mano', () => {
    // Una sola constante: `MANUFACTURING_BOM_PATH`. Si vuelve a aparecer el
    // literal en un componente o en una acción, es que se duplicó.
    for (const file of [
      'src/components/areas/manufactura/ProductionBoard.tsx',
      'src/app/app/manufacturing/actions.ts',
    ]) {
      expect({ file, literal: read(file).includes("'/app/manufacturing/bom'") }).toEqual({
        file,
        literal: false,
      });
    }
  });
});
