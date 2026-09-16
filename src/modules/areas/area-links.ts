/**
 * Deep links of the area workspaces (plan 7.1). PURE: no React, no lucide, no
 * Prisma — so a domain service (`purchases`, `finance`, `logistics`…) can build
 * the URL of a notification without importing `area-registry.ts`, which pulls
 * icons and copilot starters into the server bundle.
 *
 * The slugs restated here are the SAME ones the registry declares
 * (`subpages[].slug`, `special.slug`) and the same the navigation declares for
 * the pages that live under an area without being a space of the registry
 * (`AREA_EXTRA_PAGES` of `nav-config.ts`). `area-links.test.ts` asserts that
 * parity against both sources, so a renamed slug fails the test instead of
 * shipping a notification that lands on a 404.
 *
 * Rule of the plan (principle 1, "nunca deja nada en el aire"): every
 * notification of a domain module points at a route that EXISTS and shows the
 * record it is talking about.
 */

// El tipo se importa SÓLO como tipo (se borra al compilar): así este módulo
// sigue sin arrastrar `work-filters.ts` —y con él zod— al bundle del cliente.
import type { AreaWorkScope } from './work-filters';

export const AREA_LINK_BASE = '/app/areas';

/** Slugs the deep links of each area use (mirror of the registry / the nav). */
export const AREA_LINK_SLUGS = {
  compras: { orders: 'ordenes', rfqs: 'rfq', suppliers: 'proveedores', sourcing: 'sourcing' },
  contabilidad: { obligations: 'obligaciones', close: 'cierre', expenses: 'gastos', book: 'libro' },
  inventario: { counts: 'conteos', stock: 'existencias' },
  logistica: { dispatch: 'despacho', trips: 'viajes' },
  ventas: { radar: 'radar', opportunities: 'oportunidades', pipeline: 'pipeline' },
} as const;

function href(areaKey: string, slug: string): string {
  return `${AREA_LINK_BASE}/${encodeURIComponent(areaKey)}/${encodeURIComponent(slug)}`;
}

function detailHref(areaKey: string, slug: string, id: string): string {
  return `${href(areaKey, slug)}/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------
// Compras
// ---------------------------------------------------------------------------

/** `/app/areas/compras/ordenes/{id}` — detail of a procurement order. */
export function procurementOrderLink(orderId: string): string {
  return detailHref('compras', AREA_LINK_SLUGS.compras.orders, orderId);
}

/** `/app/areas/compras/rfq/{id}` — detail of an RFQ with its responses. */
export function rfqLink(rfqId: string): string {
  return detailHref('compras', AREA_LINK_SLUGS.compras.rfqs, rfqId);
}

/** `/app/areas/compras/proveedores/{id}` — detail of a supplier. */
export function supplierLink(supplierId: string): string {
  return detailHref('compras', AREA_LINK_SLUGS.compras.suppliers, supplierId);
}

/**
 * `/app/areas/compras/sourcing` — the Sourcing Lab, focused on one search.
 * `busqueda` is the parameter `SourcingLab` reads to open that search.
 */
export function sourcingLabLink(searchId?: string | null): string {
  const base = href('compras', AREA_LINK_SLUGS.compras.sourcing);
  return searchId ? `${base}?busqueda=${encodeURIComponent(searchId)}` : base;
}

// ---------------------------------------------------------------------------
// Contabilidad
// ---------------------------------------------------------------------------

/** `/app/areas/contabilidad/obligaciones` — the board filters with `estado` / `vencidas`. */
export function obligationsLink(
  options: { overdueOnly?: boolean; status?: string; obligationId?: string } = {}
): string {
  const params = new URLSearchParams();
  if (options.status) params.set('estado', options.status);
  if (options.overdueOnly) params.set('vencidas', '1');
  if (options.obligationId) params.set('obligacion', options.obligationId);
  const query = params.toString();
  const base = href('contabilidad', AREA_LINK_SLUGS.contabilidad.obligations);
  return query ? `${base}?${query}` : base;
}

/** `/app/areas/contabilidad/cierre` — daily and monthly close (it takes no query). */
export function periodCloseLink(): string {
  return href('contabilidad', AREA_LINK_SLUGS.contabilidad.close);
}

// ---------------------------------------------------------------------------
// Inventario
// ---------------------------------------------------------------------------

/**
 * `/app/areas/inventario/conteos/{id}` — the count with its differences.
 *
 * It is where a difference is DECIDED (authorising the adjustment or settling
 * the dispute), so the work item that asks for that decision points here: a
 * notification that only said "autoriza el ajuste" left the person hunting for
 * the count.
 */
export function stockCountLink(countId: string): string {
  return detailHref('inventario', AREA_LINK_SLUGS.inventario.counts, countId);
}

/** `/app/areas/inventario/existencias` — stock by article and its capture panel. */
export function inventoryStockLink(): string {
  return href('inventario', AREA_LINK_SLUGS.inventario.stock);
}

// ---------------------------------------------------------------------------
// Logística
// ---------------------------------------------------------------------------

/** `/app/areas/logistica/despacho` — dispatch board of the day. */
export function dispatchLink(): string {
  return href('logistica', AREA_LINK_SLUGS.logistica.dispatch);
}

/** `/app/areas/logistica/viajes/{id}` — detail of a trip. */
export function tripLink(tripId: string): string {
  return detailHref('logistica', AREA_LINK_SLUGS.logistica.trips, tripId);
}

// ---------------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------------

/**
 * `/app/areas/ventas/radar` — Radar de cierre. It takes no query: the board
 * sorts by score and the signal the notification talks about is at the top, so
 * a parameter nobody reads would be a promise the screen does not keep.
 */
export function radarLink(): string {
  return href('ventas', AREA_LINK_SLUGS.ventas.radar);
}

/** `/app/areas/ventas/oportunidades/{id}` — detail of an opportunity. */
export function opportunityLink(opportunityId: string): string {
  return detailHref('ventas', AREA_LINK_SLUGS.ventas.opportunities, opportunityId);
}

// ---------------------------------------------------------------------------
// Chips of the work centre toolbar
// ---------------------------------------------------------------------------

/**
 * Chip state of a work centre toolbar, as it travels in the URL.
 *
 * `kind` admits `null` (and `'all'`) for "every kind": that is how the "Todo"
 * chip clears the filter, and `areaWorkQueryFromSearchParams` reads back the
 * absence of the param the same way.
 */
export interface AreaWorkChipState {
  kind?: string | null;
  scope?: AreaWorkScope;
  mine?: boolean;
  overdue?: boolean;
}

/**
 * Search params of a chip link, keeping the rest of the state readable in the URL.
 *
 * This is the ONE place that spells the chip params (`kind`, `scope`, `mios`,
 * `vencidos`); `areaWorkQueryFromSearchParams` (`work-filters.ts`, which
 * re-exports this) reads exactly these names, and `chipHref` in
 * `area-workspace-model.ts` builds every chip href with it, so a link a chip
 * writes is always a link the work centre can parse back.
 *
 * It lives HERE, and not next to the parser, for the reason at the top of this
 * file: the toolbar is a client component, and `work-filters.ts` carries the
 * zod schemas. Importing the parser's module to build four query params dragged
 * zod into the client entry of `/app/areas/[areaKey]/[space]`, already the
 * heaviest route of the repo. This module stays pure, so the chips cost nothing.
 */
export function areaWorkChipParams(
  current: AreaWorkChipState,
  patch: AreaWorkChipState
): URLSearchParams {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.kind && next.kind !== 'all') params.set('kind', next.kind);
  if (next.scope && next.scope !== 'open') params.set('scope', next.scope);
  if (next.mine) params.set('mios', '1');
  if (next.overdue) params.set('vencidos', '1');
  return params;
}
