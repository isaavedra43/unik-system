import { describe, expect, it, vi } from 'vitest';
import { AREA_EXTRA_PAGES } from '@/components/layout/nav-config';
import {
  AREA_LINK_SLUGS,
  dispatchLink,
  inventoryStockLink,
  obligationsLink,
  periodCloseLink,
  procurementOrderLink,
  rfqLink,
  sourcingLabLink,
  stockCountLink,
  supplierLink,
  tripLink,
} from './area-links';
import { areaDetailHref, areaHref, findAreaSpace, getArea } from './area-registry';

// The unit project does not transform JSX, and `nav-config` pulls UNIK's own icon
// set. Same mock `nav-config.test.ts` uses; nothing here looks at an icon.
vi.mock('@/components/ui/icons', () => ({
  Home: function Home() {
    return null;
  },
  Shield: function Shield() {
    return null;
  },
  Users: function Users() {
    return null;
  },
}));

/**
 * The deep links of the notifications must land on a route that EXISTS
 * (plan 7.1 and principle 1: "nunca deja nada en el aire"). `area-links.ts`
 * restates the slugs so a domain service does not have to import the registry
 * (React + lucide); this test is what keeps both spellings together.
 */

describe('area-links', () => {
  it('cada slug de Compras es un espacio real del registro', () => {
    const compras = getArea('compras');
    expect(compras).not.toBeNull();
    for (const slug of Object.values(AREA_LINK_SLUGS.compras)) {
      expect(findAreaSpace(compras!, slug), `espacio ${slug}`).toBeTruthy();
    }
  });

  it('cada slug de Logística es un espacio real del registro', () => {
    const logistica = getArea('logistica');
    expect(logistica).not.toBeNull();
    for (const slug of Object.values(AREA_LINK_SLUGS.logistica)) {
      expect(findAreaSpace(logistica!, slug), `espacio ${slug}`).toBeTruthy();
    }
  });

  it('cada slug de Ventas es un espacio real del registro', () => {
    const ventas = getArea('ventas');
    expect(ventas).not.toBeNull();
    for (const slug of Object.values(AREA_LINK_SLUGS.ventas)) {
      expect(findAreaSpace(ventas!, slug), `espacio ${slug}`).toBeTruthy();
    }
  });

  it('los slugs de Contabilidad son espacios del registro o páginas declaradas en la navegación', () => {
    const contabilidad = getArea('contabilidad');
    expect(contabilidad).not.toBeNull();
    const extras = new Set(
      AREA_EXTRA_PAGES.filter((page) => page.areaKey === 'contabilidad').map((page) => page.slug)
    );
    for (const slug of Object.values(AREA_LINK_SLUGS.contabilidad)) {
      const known = Boolean(findAreaSpace(contabilidad!, slug)) || extras.has(slug);
      expect(known, `espacio o página ${slug}`).toBe(true);
    }
  });

  it('cada slug de Inventario es un espacio real del registro', () => {
    const inventario = getArea('inventario');
    expect(inventario).not.toBeNull();
    for (const slug of Object.values(AREA_LINK_SLUGS.inventario)) {
      expect(findAreaSpace(inventario!, slug), `espacio ${slug}`).toBeTruthy();
    }
    // El aviso de «Autorizar ajuste de conteo» aterriza en el conteo, que es
    // donde vive el panel que decide la diferencia.
    expect(stockCountLink('count_1')).toBe(areaDetailHref('inventario', 'conteos', 'count_1'));
    expect(inventoryStockLink()).toBe(areaHref('inventario', 'existencias'));
  });

  it('construye las mismas URLs que el registro', () => {
    expect(procurementOrderLink('ord_1')).toBe(areaDetailHref('compras', 'ordenes', 'ord_1'));
    expect(rfqLink('rfq_1')).toBe(areaDetailHref('compras', 'rfq', 'rfq_1'));
    expect(supplierLink('sup_1')).toBe(areaDetailHref('compras', 'proveedores', 'sup_1'));
    expect(sourcingLabLink()).toBe(areaHref('compras', 'sourcing'));
    expect(dispatchLink()).toBe(areaHref('logistica', 'despacho'));
    expect(tripLink('trip_1')).toBe(areaDetailHref('logistica', 'viajes', 'trip_1'));
  });

  it('ninguna URL apunta a las rutas inexistentes /app/purchases ni /app/finance', () => {
    const urls = [
      procurementOrderLink('ord_1'),
      rfqLink('rfq_1'),
      sourcingLabLink('sea_1'),
      obligationsLink({ status: 'open', overdueOnly: true }),
      periodCloseLink(),
    ];
    for (const url of urls) {
      expect(url.startsWith('/app/areas/')).toBe(true);
      expect(url).not.toContain('/app/purchases/');
      expect(url).not.toContain('/app/finance/');
    }
  });

  it('los parámetros de obligaciones son los que lee la página (estado, vencidas, obligacion)', () => {
    expect(obligationsLink({ status: 'open', overdueOnly: true })).toBe(
      '/app/areas/contabilidad/obligaciones?estado=open&vencidas=1'
    );
    expect(obligationsLink({ obligationId: 'obl_1' })).toBe(
      '/app/areas/contabilidad/obligaciones?obligacion=obl_1'
    );
    expect(obligationsLink()).toBe('/app/areas/contabilidad/obligaciones');
  });

  it('el laboratorio de sourcing recibe la búsqueda en `busqueda`', () => {
    expect(sourcingLabLink('sea_1')).toBe('/app/areas/compras/sourcing?busqueda=sea_1');
  });
});
