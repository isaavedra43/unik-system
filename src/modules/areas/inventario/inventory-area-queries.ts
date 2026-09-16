import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { assertPermission, type CurrentUser } from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import {
  getStockCountDetail,
  listInventoryWarehouses,
  listPendingCounts,
  listStockMovements,
  type CountDetail,
  type MovementRow,
} from '@/modules/inventory/inventory-queries';
import { getStockSnapshot, type StockSnapshot } from '@/modules/inventory/inventory-service';
import { qty, toProfileDTO, type ProfileDTO } from '@/modules/inventory/inventory-dto';
import {
  buildLocationLabel,
  buildStockLabel,
  type LabelDTO,
} from '@/modules/inventory/labels-service';
import {
  CONFIDENCE_LABELS,
  COUNT_OPEN_STATUSES,
  GENERAL_LOCATION_CODE,
  LOCATION_KIND_LABELS,
  SCRAP_LOCATION_CODE,
  toConfidenceLevel,
  type ConfidenceLevel,
} from '@/modules/inventory/inventory-types';

/**
 * Reads the Inventario experience needs on top of the module's own queries
 * (`@/modules/inventory/inventory-queries`): the map of a warehouse, the detail
 * of one location, the data of a product profile page and the labels to print.
 *
 * SERVER ONLY. Everything checks `inventory.view` first — the same key the
 * module's reads use — and nothing here writes: every mutation goes through
 * `executeCommand`.
 */

const DAY_MS = 86_400_000;
const MAX_LOCATIONS = 500;
const MAX_LABELS = 500;

function requireView(actor: CurrentUser): void {
  assertPermission(actor, 'inventory.view');
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

// ---------------------------------------------------------------------------
// Map of a warehouse
// ---------------------------------------------------------------------------

export interface MapWarehouse {
  id: string;
  key: string;
  name: string;
  zohoLocationId: string | null;
}

export interface MapLocation {
  id: string;
  warehouseId: string;
  code: string;
  label: string | null;
  kind: string;
  kindLabel: string;
  active: boolean;
  system: boolean;
  /** Stock rows stored here (one per SKU, variant and container). */
  items: number;
  /** Known quantity in base unit, as a decimal string. */
  known: string;
  reserved: string;
  /** Worst confidence of what it holds; null when it is empty. */
  confidence: ConfidenceLevel | null;
  byConfidence: Record<ConfidenceLevel, number>;
  lastCountedAt: string | null;
  daysSinceCount: number | null;
}

export interface MapOpenCount {
  id: string;
  scope: string;
  scopeLabel: string;
  status: string;
  statusLabel: string;
  lines: number;
  outOfTolerance: number;
  warehouseId: string;
  warehouseName: string | null;
  startedBy: string;
  startedByName: string | null;
  createdAt: string;
}

export interface WarehouseMap {
  warehouses: MapWarehouse[];
  warehouseId: string | null;
  locations: MapLocation[];
  openCounts: MapOpenCount[];
  truncated: boolean;
  computedAt: string;
}

interface LocationAggregateRow {
  locationId: string;
  items: number;
  known: Prisma.Decimal | string | null;
  reserved: Prisma.Decimal | string | null;
  lastCountedAt: Date | null;
  uncounted: number;
  provisional: number;
  controlled: number;
  disputed: number;
}

function emptyByConfidence(): Record<ConfidenceLevel, number> {
  return { UNCOUNTED: 0, PROVISIONAL: 0, CONTROLLED: 0, DISPUTED: 0 };
}

function worstConfidence(counts: Record<ConfidenceLevel, number>): ConfidenceLevel | null {
  if (counts.DISPUTED > 0) return 'DISPUTED';
  if (counts.UNCOUNTED > 0) return 'UNCOUNTED';
  if (counts.PROVISIONAL > 0) return 'PROVISIONAL';
  if (counts.CONTROLLED > 0) return 'CONTROLLED';
  return null;
}

/**
 * Warehouses, their locations coloured by confidence and the counts still open
 * (plan 7.6 "Mapa de ubicaciones"). One aggregate query per warehouse: the
 * stock rows are grouped in the database, never in memory.
 */
export async function getWarehouseMap(
  actor: CurrentUser,
  options: { warehouseId?: string | null; now?: Date } = {}
): Promise<WarehouseMap> {
  requireView(actor);
  const now = options.now ?? new Date();
  const warehouses = await prisma.warehouse.findMany({
    where: { active: true },
    orderBy: [{ name: 'asc' }],
    select: { id: true, key: true, name: true, zohoLocationId: true },
  });
  const warehouseId =
    options.warehouseId && warehouses.some((warehouse) => warehouse.id === options.warehouseId)
      ? options.warehouseId
      : (warehouses[0]?.id ?? null);

  if (!warehouseId) {
    return {
      warehouses,
      warehouseId: null,
      locations: [],
      openCounts: [],
      truncated: false,
      computedAt: now.toISOString(),
    };
  }

  const [locations, aggregates, counts] = await Promise.all([
    prisma.storageLocation.findMany({
      where: { warehouseId },
      orderBy: [{ active: 'desc' }, { code: 'asc' }],
      take: MAX_LOCATIONS + 1,
    }),
    prisma.$queryRaw<LocationAggregateRow[]>`
      SELECT si."locationId"                                                       AS "locationId",
             count(*)::int                                                         AS "items",
             COALESCE(sum(si."knownQty"), 0)                                       AS "known",
             COALESCE(sum(si."reserved"), 0)                                       AS "reserved",
             max(si."lastCountedAt")                                               AS "lastCountedAt",
             count(*) FILTER (WHERE COALESCE(p."confidence", 'UNCOUNTED') = 'UNCOUNTED')::int   AS "uncounted",
             count(*) FILTER (WHERE COALESCE(p."confidence", 'UNCOUNTED') = 'PROVISIONAL')::int AS "provisional",
             count(*) FILTER (WHERE COALESCE(p."confidence", 'UNCOUNTED') = 'CONTROLLED')::int  AS "controlled",
             count(*) FILTER (WHERE COALESCE(p."confidence", 'UNCOUNTED') = 'DISPUTED')::int    AS "disputed"
      FROM "StockItem" si
      LEFT JOIN "ProductInventoryProfile" p ON p."zohoItemId" = si."zohoItemId"
      WHERE si."warehouseId" = ${warehouseId}
      GROUP BY si."locationId"`,
    listPendingCounts(actor, { warehouseId, pageSize: 20 }),
  ]);

  const byLocation = new Map(aggregates.map((row) => [row.locationId, row]));
  const startedByIds = [...new Set(counts.rows.map((row) => row.startedBy))];
  const people = startedByIds.length
    ? await prisma.user.findMany({
        where: { id: { in: startedByIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(people.map((person) => [person.id, person.name]));

  const mapped = locations.slice(0, MAX_LOCATIONS).map((location): MapLocation => {
    const aggregate = byLocation.get(location.id);
    const byConfidence = emptyByConfidence();
    if (aggregate) {
      byConfidence.UNCOUNTED = aggregate.uncounted;
      byConfidence.PROVISIONAL = aggregate.provisional;
      byConfidence.CONTROLLED = aggregate.controlled;
      byConfidence.DISPUTED = aggregate.disputed;
    }
    const lastCountedAt = aggregate?.lastCountedAt ?? null;
    return {
      id: location.id,
      warehouseId: location.warehouseId,
      code: location.code,
      label: location.label,
      kind: location.kind,
      kindLabel: (LOCATION_KIND_LABELS as Record<string, string>)[location.kind] ?? location.kind,
      active: location.active,
      system: location.code === GENERAL_LOCATION_CODE || location.code === SCRAP_LOCATION_CODE,
      items: aggregate?.items ?? 0,
      known: qty(aggregate?.known ?? 0),
      reserved: qty(aggregate?.reserved ?? 0),
      confidence: worstConfidence(byConfidence),
      byConfidence,
      lastCountedAt: lastCountedAt ? lastCountedAt.toISOString() : null,
      daysSinceCount: lastCountedAt ? daysBetween(lastCountedAt, now) : null,
    };
  });

  return {
    warehouses,
    warehouseId,
    locations: mapped,
    openCounts: counts.rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      scopeLabel: row.scopeLabel,
      status: row.status,
      statusLabel: row.statusLabel,
      lines: row.lines,
      outOfTolerance: row.outOfTolerance,
      warehouseId: row.warehouseId,
      warehouseName: row.warehouseName,
      startedBy: row.startedBy,
      startedByName: nameById.get(row.startedBy) ?? null,
      createdAt: row.createdAt,
    })),
    truncated: locations.length > MAX_LOCATIONS,
    computedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// One location
// ---------------------------------------------------------------------------

export interface LocationDetail {
  location: MapLocation;
  warehouse: MapWarehouse;
  snapshot: StockSnapshot;
}

/** What one location holds right now, with its totals per product. */
export async function getLocationDetail(
  actor: CurrentUser,
  locationId: string,
  options: { now?: Date } = {}
): Promise<LocationDetail> {
  requireView(actor);
  const now = options.now ?? new Date();
  const location = await prisma.storageLocation.findUnique({ where: { id: locationId } });
  if (!location) throw new OperationsError('not_found', 'No se encontró la ubicación');
  const warehouse = await prisma.warehouse.findUnique({
    where: { id: location.warehouseId },
    select: { id: true, key: true, name: true, zohoLocationId: true },
  });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');

  const [aggregates, snapshot] = await Promise.all([
    prisma.$queryRaw<LocationAggregateRow[]>`
      SELECT si."locationId"                                                       AS "locationId",
             count(*)::int                                                         AS "items",
             COALESCE(sum(si."knownQty"), 0)                                       AS "known",
             COALESCE(sum(si."reserved"), 0)                                       AS "reserved",
             max(si."lastCountedAt")                                               AS "lastCountedAt",
             count(*) FILTER (WHERE COALESCE(p."confidence", 'UNCOUNTED') = 'UNCOUNTED')::int   AS "uncounted",
             count(*) FILTER (WHERE COALESCE(p."confidence", 'UNCOUNTED') = 'PROVISIONAL')::int AS "provisional",
             count(*) FILTER (WHERE COALESCE(p."confidence", 'UNCOUNTED') = 'CONTROLLED')::int  AS "controlled",
             count(*) FILTER (WHERE COALESCE(p."confidence", 'UNCOUNTED') = 'DISPUTED')::int    AS "disputed"
      FROM "StockItem" si
      LEFT JOIN "ProductInventoryProfile" p ON p."zohoItemId" = si."zohoItemId"
      WHERE si."locationId" = ${locationId}
      GROUP BY si."locationId"`,
    getStockSnapshot({ locationId }, prisma),
  ]);

  const aggregate = aggregates[0];
  const byConfidence = emptyByConfidence();
  if (aggregate) {
    byConfidence.UNCOUNTED = aggregate.uncounted;
    byConfidence.PROVISIONAL = aggregate.provisional;
    byConfidence.CONTROLLED = aggregate.controlled;
    byConfidence.DISPUTED = aggregate.disputed;
  }
  const lastCountedAt = aggregate?.lastCountedAt ?? null;

  return {
    warehouse,
    snapshot,
    location: {
      id: location.id,
      warehouseId: location.warehouseId,
      code: location.code,
      label: location.label,
      kind: location.kind,
      kindLabel: (LOCATION_KIND_LABELS as Record<string, string>)[location.kind] ?? location.kind,
      active: location.active,
      system: location.code === GENERAL_LOCATION_CODE || location.code === SCRAP_LOCATION_CODE,
      items: aggregate?.items ?? 0,
      known: qty(aggregate?.known ?? 0),
      reserved: qty(aggregate?.reserved ?? 0),
      confidence: worstConfidence(byConfidence),
      byConfidence,
      lastCountedAt: lastCountedAt ? lastCountedAt.toISOString() : null,
      daysSinceCount: lastCountedAt ? daysBetween(lastCountedAt, now) : null,
    },
  };
}

/** Count with its lines, for the capture screen. */
export function getCountForCapture(actor: CurrentUser, countId: string): Promise<CountDetail> {
  requireView(actor);
  return getStockCountDetail(actor, countId);
}

// ---------------------------------------------------------------------------
// Locations without a recent count (dashboard tile)
// ---------------------------------------------------------------------------

/**
 * Active locations holding stock whose newest count is older than `days` (or
 * that were never counted). Aggregated in the database so the tile never walks
 * thousands of rows in memory.
 */
export async function countStaleLocations(
  actor: CurrentUser,
  options: { days?: number; warehouseId?: string | null; now?: Date } = {}
): Promise<number> {
  requireView(actor);
  const now = options.now ?? new Date();
  const days = Math.min(Math.max(Math.trunc(options.days ?? 30), 1), 365);
  const threshold = new Date(now.getTime() - days * DAY_MS);
  const warehouseFilter = options.warehouseId
    ? Prisma.sql`AND si."warehouseId" = ${options.warehouseId}`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
    SELECT count(*)::int AS "total"
    FROM (
      SELECT si."locationId", max(si."lastCountedAt") AS "lastCountedAt"
      FROM "StockItem" si
      JOIN "StorageLocation" loc ON loc."id" = si."locationId" AND loc."active" = TRUE
      WHERE si."knownQty" <> 0 ${warehouseFilter}
      GROUP BY si."locationId"
    ) grouped
    WHERE grouped."lastCountedAt" IS NULL OR grouped."lastCountedAt" < ${threshold}`);
  return Number(rows[0]?.total ?? 0);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export interface PrintableLabel extends LabelDTO {
  id: string;
  kind: 'location' | 'container';
}

/**
 * Labels of a warehouse: one per location (`unik:loc:<id>`) and one per
 * container row (`unik:stock:<id>`), ready to print. The payloads are exactly
 * the ones `resolveScan` understands.
 */
export async function listPrintableLabels(
  actor: CurrentUser,
  input: { warehouseId: string; kind?: 'location' | 'container' }
): Promise<PrintableLabel[]> {
  requireView(actor);
  const warehouse = await prisma.warehouse.findUnique({
    where: { id: input.warehouseId },
    select: { id: true, name: true },
  });
  if (!warehouse) throw new OperationsError('not_found', 'No se encontró la bodega');
  const kind = input.kind ?? 'location';

  if (kind === 'location') {
    const locations = await prisma.storageLocation.findMany({
      where: { warehouseId: warehouse.id, active: true },
      orderBy: [{ code: 'asc' }],
      take: MAX_LABELS,
    });
    return locations.map((location) => ({
      id: location.id,
      kind: 'location' as const,
      ...buildLocationLabel(location, { name: warehouse.name }),
    }));
  }

  const items = await prisma.stockItem.findMany({
    where: { warehouseId: warehouse.id, containerKey: { not: '' } },
    orderBy: [{ containerKey: 'asc' }],
    take: MAX_LABELS,
  });
  if (items.length === 0) return [];
  const [products, profiles, locations] = await Promise.all([
    prisma.product.findMany({
      where: { zohoItemId: { in: [...new Set(items.map((item) => item.zohoItemId))] } },
      select: { zohoItemId: true, name: true, sku: true },
    }),
    prisma.productInventoryProfile.findMany({
      where: { zohoItemId: { in: [...new Set(items.map((item) => item.zohoItemId))] } },
      select: { zohoItemId: true, baseUnit: true },
    }),
    prisma.storageLocation.findMany({
      where: { id: { in: [...new Set(items.map((item) => item.locationId))] } },
      select: { id: true, code: true },
    }),
  ]);
  const productBy = new Map(products.map((product) => [product.zohoItemId, product]));
  const profileBy = new Map(profiles.map((profile) => [profile.zohoItemId, profile]));
  const locationBy = new Map(locations.map((location) => [location.id, location.code]));
  return items.map((item) => ({
    id: item.id,
    kind: 'container' as const,
    ...buildStockLabel(item, {
      productName: productBy.get(item.zohoItemId)?.name ?? null,
      sku: productBy.get(item.zohoItemId)?.sku ?? null,
      locationCode: locationBy.get(item.locationId) ?? null,
      warehouseName: warehouse.name,
      baseUnit: profileBy.get(item.zohoItemId)?.baseUnit ?? null,
    }),
  }));
}

// ---------------------------------------------------------------------------
// Product profile page
// ---------------------------------------------------------------------------

export interface ProfilePageData {
  zohoItemId: string;
  profile: ProfileDTO | null;
  product: {
    name: string | null;
    sku: string | null;
    unit: string | null;
    /** Zoho figures: informational column, never part of a formula. */
    stockOnHand: string | null;
    availableStock: string | null;
  } | null;
  totals: { known: string; reserved: string; blocked: string; available: string; rows: number };
  /** Whether the base unit can still be changed (no movements, reservations or claims). */
  baseUnitLocked: boolean;
  movements: MovementRow[];
}

/** Everything the profile page of one item shows (plan 7.6 "perfiles"). */
export async function getProfilePageData(
  actor: CurrentUser,
  zohoItemId: string
): Promise<ProfilePageData> {
  requireView(actor);
  const [profile, product, totals, movements, blockers] = await Promise.all([
    prisma.productInventoryProfile.findUnique({ where: { zohoItemId } }),
    prisma.product.findUnique({
      where: { zohoItemId },
      select: {
        name: true,
        sku: true,
        unit: true,
        stockOnHand: true,
        availableStock: true,
      },
    }),
    prisma.stockItem.aggregate({
      where: { zohoItemId },
      _sum: { knownQty: true, reserved: true, blocked: true, assignedToProduction: true },
      _count: { _all: true },
    }),
    listStockMovements(actor, { zohoItemId, pageSize: 10 }),
    Promise.all([
      prisma.stockMovement.count({ where: { zohoItemId } }),
      prisma.stockReservation.count({ where: { zohoItemId, status: 'active' } }),
      prisma.legacyCommitmentClaim.count({ where: { zohoItemId, status: 'claimed' } }),
      prisma.caseDemand.count({
        where: { zohoItemId, status: { notIn: ['cancelled', 'fulfilled'] } },
      }),
    ]),
  ]);

  if (!profile && !product) {
    throw new OperationsError('not_found', 'No encontramos el artículo');
  }

  const known = totals._sum.knownQty ?? new Prisma.Decimal(0);
  const reserved = totals._sum.reserved ?? new Prisma.Decimal(0);
  const blocked = totals._sum.blocked ?? new Prisma.Decimal(0);
  const assigned = totals._sum.assignedToProduction ?? new Prisma.Decimal(0);

  return {
    zohoItemId,
    profile: profile ? toProfileDTO(profile) : null,
    product: product
      ? {
          name: product.name,
          sku: product.sku,
          unit: product.unit,
          stockOnHand: product.stockOnHand ? qty(product.stockOnHand) : null,
          availableStock: product.availableStock ? qty(product.availableStock) : null,
        }
      : null,
    totals: {
      known: qty(known),
      reserved: qty(reserved),
      blocked: qty(blocked),
      available: qty(known.minus(reserved).minus(blocked).minus(assigned)),
      rows: totals._count._all,
    },
    baseUnitLocked: blockers.some((count) => count > 0),
    movements: movements.rows,
  };
}

// ---------------------------------------------------------------------------
// Filters shared by the stock table and the map
// ---------------------------------------------------------------------------

export interface InventoryFilterOptions {
  warehouses: Array<{ id: string; name: string; key: string }>;
  confidences: Array<{ value: ConfidenceLevel; label: string }>;
}

/** Options of the pickers, so the pages never invent a warehouse that is not there. */
export async function getInventoryFilterOptions(
  actor: CurrentUser
): Promise<InventoryFilterOptions> {
  requireView(actor);
  const warehouses = await listInventoryWarehouses(actor);
  return {
    warehouses: warehouses.map((warehouse) => ({
      id: warehouse.id,
      name: warehouse.name,
      key: warehouse.key,
    })),
    confidences: (['DISPUTED', 'UNCOUNTED', 'PROVISIONAL', 'CONTROLLED'] as ConfidenceLevel[]).map(
      (value) => ({ value, label: CONFIDENCE_LABELS[value] })
    ),
  };
}

/** Counts still open in a warehouse (the capture screen offers them). */
export async function listOpenCountIds(actor: CurrentUser, warehouseId: string): Promise<string[]> {
  requireView(actor);
  const rows = await prisma.stockCount.findMany({
    where: { warehouseId, status: { in: [...COUNT_OPEN_STATUSES] } },
    orderBy: [{ createdAt: 'desc' }],
    select: { id: true },
    take: 20,
  });
  return rows.map((row) => row.id);
}

/** Confidence of one item (used by the capture screen to warn before counting). */
export async function getItemConfidence(
  actor: CurrentUser,
  zohoItemId: string
): Promise<ConfidenceLevel> {
  requireView(actor);
  const profile = await prisma.productInventoryProfile.findUnique({
    where: { zohoItemId },
    select: { confidence: true },
  });
  return toConfidenceLevel(profile?.confidence);
}

// ---------------------------------------------------------------------------
// Stock of ONE item, for the movement panel
// ---------------------------------------------------------------------------

export interface ItemStockForCapture {
  zohoItemId: string;
  productName: string | null;
  sku: string | null;
  baseUnit: string;
  confidence: ConfidenceLevel;
  confidenceLabel: string;
  totals: {
    known: string;
    reserved: string;
    blocked: string;
    available: string;
    legacyClaims: string;
  };
  /** Rows of the item (a block or an unblock always acts on one of these). */
  items: Array<{
    id: string;
    warehouseId: string;
    warehouseName: string | null;
    locationCode: string | null;
    variantLabel: string;
    containerKey: string;
    known: string;
    blocked: string;
    available: string;
  }>;
  warehouses: Array<{ id: string; name: string; key: string }>;
  truncated: boolean;
}

/**
 * What the capture panel of a movement needs about ONE article: its rows with
 * warehouse, location, variant and container, and the warehouses it may move to.
 *
 * It REUSES `getStockSnapshot` (the same read the profile page and the AI use);
 * nothing new is computed here.
 */
export async function getItemStockForCapture(
  actor: CurrentUser,
  zohoItemId: string
): Promise<ItemStockForCapture> {
  requireView(actor);
  const id = zohoItemId.trim();
  if (!id) throw new OperationsError('invalid_payload', 'Falta el artículo');
  const [snapshot, warehouses] = await Promise.all([
    getStockSnapshot({ zohoItemId: id }, prisma),
    listInventoryWarehouses(actor),
  ]);
  const product = snapshot.products[0];
  if (!product) throw new OperationsError('not_found', 'No se encontró el artículo en inventario');
  return {
    zohoItemId: product.zohoItemId,
    productName: product.productName,
    sku: product.sku,
    baseUnit: product.baseUnit,
    confidence: product.confidence,
    confidenceLabel: product.confidenceLabel,
    totals: {
      known: product.totals.known,
      reserved: product.totals.reserved,
      blocked: product.totals.blocked,
      available: product.totals.available,
      legacyClaims: product.totals.legacyClaims,
    },
    items: product.items.map((item) => ({
      id: item.id,
      warehouseId: item.warehouseId,
      warehouseName: item.warehouseName,
      locationCode: item.locationCode,
      variantLabel: item.variantLabel,
      containerKey: item.containerKey,
      known: item.known,
      blocked: item.blocked,
      available: item.available,
    })),
    warehouses: warehouses
      .filter((warehouse) => warehouse.active)
      .map((warehouse) => ({ id: warehouse.id, name: warehouse.name, key: warehouse.key })),
    truncated: snapshot.truncated,
  };
}

// ---------------------------------------------------------------------------
// Legacy claim: what the panel needs to confirm or release it
// ---------------------------------------------------------------------------

/** Demand of a case a legacy claim can be tied to (same article, still open). */
export interface ClaimableDemand {
  demandId: string;
  caseId: string;
  caseNumber: string;
  customerName: string | null;
  name: string;
  sku: string | null;
  baseQuantity: string;
  fulfilledQuantity: string;
  pendingQuantity: string;
  baseUnit: string;
  status: string;
}

export interface LegacyClaimDetail {
  claim: {
    id: string;
    zohoItemId: string;
    productName: string | null;
    sku: string | null;
    warehouseId: string;
    warehouseName: string | null;
    variantKey: string;
    quantity: string;
    unit: string;
    source: string;
    reference: string | null;
    status: string;
    caseId: string | null;
    expiresAt: string;
    createdAt: string;
    version: number;
  };
  demands: ClaimableDemand[];
}

const MAX_CLAIMABLE_DEMANDS = 50;

/**
 * The claim with the demands it could fund: same article, case still open and
 * something left to promise. Confirming picks ONE of them, which is why the
 * generic row dialog (a note, a reason) can never do this.
 */
export async function getLegacyClaimDetail(
  actor: CurrentUser,
  claimId: string
): Promise<LegacyClaimDetail> {
  requireView(actor);
  const claim = await prisma.legacyCommitmentClaim.findUnique({ where: { id: claimId } });
  if (!claim) throw new OperationsError('not_found', 'No se encontró el reclamo');
  const [product, warehouse, profile] = await Promise.all([
    prisma.product.findUnique({
      where: { zohoItemId: claim.zohoItemId },
      select: { name: true, sku: true },
    }),
    prisma.warehouse.findUnique({ where: { id: claim.warehouseId }, select: { name: true } }),
    prisma.productInventoryProfile.findUnique({
      where: { zohoItemId: claim.zohoItemId },
      select: { baseUnit: true },
    }),
  ]);

  const demands =
    claim.status === 'claimed'
      ? await prisma.caseDemand.findMany({
          where: {
            zohoItemId: claim.zohoItemId,
            status: { in: ['pending', 'verifying', 'planned', 'allocated'] },
            case: { status: { in: ['open', 'waiting', 'blocked', 'ready_to_close'] } },
          },
          include: { case: { select: { caseNumber: true, customerName: true } } },
          orderBy: [{ requestedAt: 'asc' }, { createdAt: 'asc' }],
          take: MAX_CLAIMABLE_DEMANDS,
        })
      : [];

  return {
    claim: {
      id: claim.id,
      zohoItemId: claim.zohoItemId,
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      warehouseId: claim.warehouseId,
      warehouseName: warehouse?.name ?? null,
      variantKey: claim.variantKey,
      quantity: qty(claim.quantity),
      unit: claim.unit || profile?.baseUnit || '',
      source: claim.source,
      reference: claim.reference,
      status: claim.status,
      caseId: claim.caseId,
      expiresAt: claim.expiresAt.toISOString(),
      createdAt: claim.createdAt.toISOString(),
      version: claim.version,
    },
    demands: demands.map((demand) => {
      const pending = demand.baseQuantity.minus(demand.fulfilledQuantity);
      return {
        demandId: demand.id,
        caseId: demand.caseId,
        caseNumber: demand.case.caseNumber,
        customerName: demand.case.customerName,
        name: demand.name,
        sku: demand.sku,
        baseQuantity: qty(demand.baseQuantity),
        fulfilledQuantity: qty(demand.fulfilledQuantity),
        pendingQuantity: qty(pending.lessThan(0) ? new Prisma.Decimal(0) : pending),
        baseUnit: demand.baseUnit,
        status: demand.status,
      };
    }),
  };
}
