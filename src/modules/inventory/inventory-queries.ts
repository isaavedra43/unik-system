import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  assertAnyPermission,
  assertPermission,
  type CurrentUser,
} from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import { getOperationsConfig } from '@/modules/operations/operations-config';
import { CASE_OPEN_STATUSES, INCIDENT_OPEN_STATUSES } from '@/modules/operations/types';
import {
  qty,
  toCountDTO,
  toCountLineDTO,
  toLegacyClaimDTO,
  toLocationDTO,
  toMovementDTO,
  toProfileDTO,
  toReservationDTO,
  toWarehouseDTO,
  type CountDTO,
  type CountLineDTO,
  type LegacyClaimDTO,
  type LocationDTO,
  type MovementDTO,
  type ProfileDTO,
  type ReservationDTO,
  type WarehouseDTO,
} from './inventory-dto';
import {
  getStockSnapshot,
  toAvailabilityDTO,
  verifyAvailability,
  type AvailabilityDTO,
  type AvailabilityQuery,
  type StockSnapshot,
  type StockSnapshotFilter,
} from './inventory-service';
import {
  CONFIDENCE_LABELS,
  COUNT_OPEN_STATUSES,
  isConfidenceLevel,
  isMovementKind,
  toConfidenceLevel,
  type ConfidenceLevel,
  type LegacyClaimStatus,
  type MovementKind,
} from './inventory-types';
import { resolveScan, type ScanResolution } from './labels-service';
import { computeAvailable, dec } from './stock-math';
import { describeVariant } from './variant-key';

/**
 * Read side of the inventory for the UI (built in another phase), tools and
 * routes. Every function takes the session user and checks `inventory.view`
 * on the server; lists are paginated (`page` from 1, `pageSize` ≤ 200) and
 * return JSON-safe DTOs.
 */

export interface PageInput {
  page?: number;
  pageSize?: number;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const DAY_MS = 86_400_000;
const OPEN_DEMAND_STATUSES = ['pending', 'verifying', 'planned', 'allocated'];

export function normalizePage(input: PageInput = {}): {
  page: number;
  pageSize: number;
  skip: number;
} {
  const page = Math.max(1, Math.trunc(Number.isFinite(input.page) ? Number(input.page) : 1));
  const size = Math.trunc(
    Number.isFinite(input.pageSize) ? Number(input.pageSize) : DEFAULT_PAGE_SIZE
  );
  const pageSize = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function pageOf<T>(rows: T[], total: number, page: number, pageSize: number): Page<T> {
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

function paginate<T>(all: T[], input: PageInput): Page<T> {
  const { page, pageSize, skip } = normalizePage(input);
  return pageOf(all.slice(skip, skip + pageSize), all.length, page, pageSize);
}

function requireView(actor: CurrentUser): void {
  assertPermission(actor, 'inventory.view');
}

async function productsById(zohoItemIds: string[]) {
  if (zohoItemIds.length === 0)
    return new Map<string, { name: string | null; sku: string | null }>();
  const rows = await prisma.product.findMany({
    where: { zohoItemId: { in: [...new Set(zohoItemIds)] } },
    select: { zohoItemId: true, name: true, sku: true },
  });
  return new Map(rows.map((row) => [row.zohoItemId, { name: row.name, sku: row.sku }]));
}

async function warehouseNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.warehouse.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

// ---------------------------------------------------------------------------
// Stock by confidence
// ---------------------------------------------------------------------------

export interface StockByConfidenceRow {
  profileId: string;
  zohoItemId: string;
  productName: string | null;
  sku: string | null;
  baseUnit: string;
  confidence: ConfidenceLevel;
  confidenceLabel: string;
  consecutiveGoodCounts: number;
  lastCountAt: string | null;
  controlledAt: string | null;
  trackingPolicy: string;
  /** Book stock (includes blocked scrap). */
  known: string;
  reserved: string;
  blocked: string;
  assignedToProduction: string;
  legacyClaims: string;
  available: string;
  /** Zoho figures (informational). */
  zohoStockOnHand: string | null;
  zohoAvailableStock: string | null;
  version: number;
}

export async function listStockByConfidence(
  actor: CurrentUser,
  input: PageInput & {
    confidence?: ConfidenceLevel | ConfidenceLevel[];
    warehouseId?: string | null;
    search?: string | null;
  } = {}
): Promise<Page<StockByConfidenceRow>> {
  requireView(actor);
  const { page, pageSize, skip } = normalizePage(input);
  const where: Prisma.ProductInventoryProfileWhereInput = {};
  const levels = (
    Array.isArray(input.confidence) ? input.confidence : input.confidence ? [input.confidence] : []
  ).filter(isConfidenceLevel);
  if (levels.length > 0) where.confidence = { in: levels };

  let ids: string[] | null = null;
  const search = input.search?.trim().slice(0, 100);
  if (search) {
    const matches = await prisma.product.findMany({
      where: {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { sku: { contains: search, mode: 'insensitive' } },
          { zohoItemId: search },
        ],
      },
      select: { zohoItemId: true },
      take: 500,
    });
    ids = matches.map((m) => m.zohoItemId);
  }
  if (input.warehouseId) {
    const inWarehouse = await prisma.stockItem.findMany({
      where: { warehouseId: input.warehouseId },
      select: { zohoItemId: true },
      distinct: ['zohoItemId'],
      take: 5000,
    });
    const set = new Set(inWarehouse.map((row) => row.zohoItemId));
    ids = ids ? ids.filter((id) => set.has(id)) : [...set];
  }
  if (ids) where.zohoItemId = { in: ids };

  const [total, profiles] = await Promise.all([
    prisma.productInventoryProfile.count({ where }),
    prisma.productInventoryProfile.findMany({
      where,
      orderBy: [{ confidence: 'asc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ]);
  const itemIds = profiles.map((p) => p.zohoItemId);
  const warehouseFilter = input.warehouseId ? { warehouseId: input.warehouseId } : {};
  const [stockRows, claimRows, products] = await Promise.all([
    itemIds.length
      ? prisma.stockItem.findMany({
          where: { zohoItemId: { in: itemIds }, ...warehouseFilter },
          select: {
            zohoItemId: true,
            knownQty: true,
            reserved: true,
            blocked: true,
            assignedToProduction: true,
          },
        })
      : Promise.resolve([]),
    itemIds.length
      ? prisma.legacyCommitmentClaim.findMany({
          where: { zohoItemId: { in: itemIds }, status: 'claimed', ...warehouseFilter },
          select: { zohoItemId: true, quantity: true },
        })
      : Promise.resolve([]),
    itemIds.length
      ? prisma.product.findMany({
          where: { zohoItemId: { in: itemIds } },
          select: {
            zohoItemId: true,
            name: true,
            sku: true,
            stockOnHand: true,
            availableStock: true,
          },
        })
      : Promise.resolve([]),
  ]);
  const productBy = new Map(products.map((p) => [p.zohoItemId, p]));
  const rows = profiles.map((profile): StockByConfidenceRow => {
    const own = stockRows.filter((row) => row.zohoItemId === profile.zohoItemId);
    const sum = (field: 'knownQty' | 'reserved' | 'blocked' | 'assignedToProduction') =>
      own.reduce((acc, row) => acc.plus(dec(row[field])), new Prisma.Decimal(0));
    const known = sum('knownQty');
    const reserved = sum('reserved');
    const blocked = sum('blocked');
    const assignedToProduction = sum('assignedToProduction');
    const legacyClaims = claimRows
      .filter((row) => row.zohoItemId === profile.zohoItemId)
      .reduce((acc, row) => acc.plus(dec(row.quantity)), new Prisma.Decimal(0));
    const product = productBy.get(profile.zohoItemId);
    const dto = toProfileDTO(profile);
    return {
      profileId: profile.id,
      zohoItemId: profile.zohoItemId,
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      baseUnit: dto.baseUnit,
      confidence: dto.confidence,
      confidenceLabel: dto.confidenceLabel,
      consecutiveGoodCounts: profile.consecutiveGoodCounts,
      lastCountAt: dto.lastCountAt,
      controlledAt: dto.controlledAt,
      trackingPolicy: profile.trackingPolicy,
      known: qty(known),
      reserved: qty(reserved),
      blocked: qty(blocked),
      assignedToProduction: qty(assignedToProduction),
      legacyClaims: qty(legacyClaims),
      available: qty(
        computeAvailable({ known, reserved, blocked, assignedToProduction, legacyClaims })
      ),
      zohoStockOnHand: product?.stockOnHand ? qty(product.stockOnHand) : null,
      zohoAvailableStock: product?.availableStock ? qty(product.availableStock) : null,
      version: profile.version,
    };
  });
  return pageOf(rows, total, page, pageSize);
}

// ---------------------------------------------------------------------------
// Movements
// ---------------------------------------------------------------------------

export interface MovementRow extends MovementDTO {
  productName: string | null;
  sku: string | null;
  warehouseName: string | null;
  locationCode: string | null;
  variantLabel: string;
  containerKey: string;
}

export async function listStockMovements(
  actor: CurrentUser,
  input: PageInput & {
    zohoItemId?: string | null;
    warehouseId?: string | null;
    stockItemId?: string | null;
    kinds?: MovementKind[];
    referenceType?: string | null;
    referenceId?: string | null;
    from?: Date | null;
    to?: Date | null;
  } = {}
): Promise<Page<MovementRow>> {
  requireView(actor);
  const { page, pageSize, skip } = normalizePage(input);
  const kinds = (input.kinds ?? []).filter(isMovementKind);
  const where: Prisma.StockMovementWhereInput = {
    ...(input.zohoItemId ? { zohoItemId: input.zohoItemId } : {}),
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    ...(input.stockItemId ? { stockItemId: input.stockItemId } : {}),
    ...(kinds.length ? { kind: { in: kinds } } : {}),
    ...(input.referenceType ? { referenceType: input.referenceType } : {}),
    ...(input.referenceId ? { referenceId: input.referenceId } : {}),
    ...(input.from || input.to
      ? {
          occurredAt: {
            ...(input.from ? { gte: input.from } : {}),
            ...(input.to ? { lte: input.to } : {}),
          },
        }
      : {}),
  };
  const [total, movements] = await Promise.all([
    prisma.stockMovement.count({ where }),
    prisma.stockMovement.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      skip,
      take: pageSize,
    }),
  ]);
  const stockItems = movements.length
    ? await prisma.stockItem.findMany({
        where: { id: { in: [...new Set(movements.map((m) => m.stockItemId))] } },
        select: {
          id: true,
          locationId: true,
          variantKey: true,
          variantJson: true,
          containerKey: true,
        },
      })
    : [];
  const [products, warehouses, locations] = await Promise.all([
    productsById(movements.map((m) => m.zohoItemId)),
    warehouseNames(movements.map((m) => m.warehouseId)),
    stockItems.length
      ? prisma.storageLocation.findMany({
          where: { id: { in: [...new Set(stockItems.map((s) => s.locationId))] } },
          select: { id: true, code: true },
        })
      : Promise.resolve([]),
  ]);
  const itemBy = new Map(stockItems.map((s) => [s.id, s]));
  const locationBy = new Map(locations.map((l) => [l.id, l.code]));
  const rows = movements.map((movement): MovementRow => {
    const item = itemBy.get(movement.stockItemId);
    const product = products.get(movement.zohoItemId);
    return {
      ...toMovementDTO(movement),
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      warehouseName: warehouses.get(movement.warehouseId) ?? null,
      locationCode: item ? (locationBy.get(item.locationId) ?? null) : null,
      variantLabel: item
        ? describeVariant(
            item.variantKey,
            item.variantJson &&
              typeof item.variantJson === 'object' &&
              !Array.isArray(item.variantJson)
              ? (item.variantJson as Record<string, unknown>)
              : null
          )
        : '',
      containerKey: item?.containerKey ?? '',
    };
  });
  return pageOf(rows, total, page, pageSize);
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export interface ReservationRow extends ReservationDTO {
  caseNumber: string | null;
  customerName: string | null;
  productName: string | null;
  sku: string | null;
  warehouseName: string | null;
  ageDays: number;
  /** Older than `reservationAlertDays` (the supervisor asks Sales to act). */
  stale: boolean;
}

export async function listActiveReservations(
  actor: CurrentUser,
  input: PageInput & {
    caseId?: string | null;
    zohoItemId?: string | null;
    warehouseId?: string | null;
    olderThanDays?: number | null;
    now?: Date;
  } = {}
): Promise<Page<ReservationRow>> {
  requireView(actor);
  const { page, pageSize, skip } = normalizePage(input);
  const now = input.now ?? new Date();
  const config = await getOperationsConfig();
  const where: Prisma.StockReservationWhereInput = {
    status: 'active',
    ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(input.zohoItemId ? { zohoItemId: input.zohoItemId } : {}),
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    ...(input.olderThanDays && input.olderThanDays > 0
      ? { createdAt: { lte: new Date(now.getTime() - input.olderThanDays * DAY_MS) } }
      : {}),
  };
  const [total, reservations] = await Promise.all([
    prisma.stockReservation.count({ where }),
    prisma.stockReservation.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ]);
  const [cases, products, warehouses] = await Promise.all([
    reservations.length
      ? prisma.operationalCase.findMany({
          where: { id: { in: [...new Set(reservations.map((r) => r.caseId))] } },
          select: { id: true, caseNumber: true, customerName: true },
        })
      : Promise.resolve([]),
    productsById(reservations.map((r) => r.zohoItemId)),
    warehouseNames(reservations.map((r) => r.warehouseId)),
  ]);
  const caseBy = new Map(cases.map((c) => [c.id, c]));
  const rows = reservations.map((reservation): ReservationRow => {
    const ageDays = daysBetween(reservation.createdAt, now);
    const product = products.get(reservation.zohoItemId);
    return {
      ...toReservationDTO(reservation),
      caseNumber: caseBy.get(reservation.caseId)?.caseNumber ?? null,
      customerName: caseBy.get(reservation.caseId)?.customerName ?? null,
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      warehouseName: warehouses.get(reservation.warehouseId) ?? null,
      ageDays,
      stale: ageDays >= config.reservationAlertDays,
    };
  });
  return pageOf(rows, total, page, pageSize);
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export interface PendingCountRow extends CountDTO {
  warehouseName: string | null;
  lines: number;
  outOfTolerance: number;
}

/** Counts still open (draft or in progress). */
export async function listPendingCounts(
  actor: CurrentUser,
  input: PageInput & { warehouseId?: string | null } = {}
): Promise<Page<PendingCountRow>> {
  requireView(actor);
  const { page, pageSize, skip } = normalizePage(input);
  const where: Prisma.StockCountWhereInput = {
    status: { in: [...COUNT_OPEN_STATUSES] },
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
  };
  const [total, counts] = await Promise.all([
    prisma.stockCount.count({ where }),
    prisma.stockCount.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ]);
  const lines = counts.length
    ? await prisma.stockCountLine.findMany({
        where: { countId: { in: counts.map((c) => c.id) } },
        select: { countId: true, withinTolerance: true },
      })
    : [];
  const warehouses = await warehouseNames(counts.map((c) => c.warehouseId));
  const rows = counts.map((count): PendingCountRow => {
    const own = lines.filter((line) => line.countId === count.id);
    return {
      ...toCountDTO(count),
      warehouseName: warehouses.get(count.warehouseId) ?? null,
      lines: own.length,
      outOfTolerance: own.filter((line) => !line.withinTolerance).length,
    };
  });
  return pageOf(rows, total, page, pageSize);
}

export interface CountLineRow extends CountLineDTO {
  zohoItemId: string | null;
  productName: string | null;
  sku: string | null;
  warehouseId: string;
  warehouseName: string | null;
  locationCode: string | null;
  variantLabel: string;
  containerKey: string;
}

async function describeCountLines(
  lines: Array<Prisma.StockCountLineGetPayload<{ include: { count: true } }>>
): Promise<CountLineRow[]> {
  if (lines.length === 0) return [];
  const items = await prisma.stockItem.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.stockItemId))] } },
    select: {
      id: true,
      zohoItemId: true,
      locationId: true,
      variantKey: true,
      variantJson: true,
      containerKey: true,
    },
  });
  const itemBy = new Map(items.map((i) => [i.id, i]));
  const [products, warehouses, locations] = await Promise.all([
    productsById(items.map((i) => i.zohoItemId)),
    warehouseNames(lines.map((l) => l.count.warehouseId)),
    prisma.storageLocation.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.locationId))] } },
      select: { id: true, code: true },
    }),
  ]);
  const locationBy = new Map(locations.map((l) => [l.id, l.code]));
  return lines.map((line) => {
    const item = itemBy.get(line.stockItemId);
    const product = item ? products.get(item.zohoItemId) : undefined;
    return {
      ...toCountLineDTO(line),
      zohoItemId: item?.zohoItemId ?? null,
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      warehouseId: line.count.warehouseId,
      warehouseName: warehouses.get(line.count.warehouseId) ?? null,
      locationCode: item ? (locationBy.get(item.locationId) ?? null) : null,
      variantLabel: item
        ? describeVariant(
            item.variantKey,
            item.variantJson &&
              typeof item.variantJson === 'object' &&
              !Array.isArray(item.variantJson)
              ? (item.variantJson as Record<string, unknown>)
              : null
          )
        : '',
      containerKey: item?.containerKey ?? '',
    };
  });
}

/** Lines of closed counts waiting for a decision: pending adjustments and open disputes. */
export async function listCountLinesAwaitingDecision(
  actor: CurrentUser,
  input: PageInput & {
    warehouseId?: string | null;
    resolution?: 'pending' | 'disputed' | null;
  } = {}
): Promise<Page<CountLineRow>> {
  requireView(actor);
  const { page, pageSize, skip } = normalizePage(input);
  const where: Prisma.StockCountLineWhereInput = {
    resolution: input.resolution ? input.resolution : { in: ['pending', 'disputed'] },
    count: { status: 'closed', ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}) },
  };
  const [total, lines] = await Promise.all([
    prisma.stockCountLine.count({ where }),
    prisma.stockCountLine.findMany({
      where,
      include: { count: true },
      orderBy: [{ countedAt: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ]);
  return pageOf(await describeCountLines(lines), total, page, pageSize);
}

export interface CountDetail {
  count: CountDTO;
  warehouseName: string | null;
  lines: CountLineRow[];
}

export async function getStockCountDetail(
  actor: CurrentUser,
  countId: string
): Promise<CountDetail> {
  requireView(actor);
  const count = await prisma.stockCount.findUnique({ where: { id: countId } });
  if (!count) throw new OperationsError('not_found', 'No se encontró el conteo');
  const lines = await prisma.stockCountLine.findMany({
    where: { countId },
    include: { count: true },
    orderBy: [{ countedAt: 'asc' }, { id: 'asc' }],
    take: 2000,
  });
  const warehouses = await warehouseNames([count.warehouseId]);
  return {
    count: toCountDTO(count),
    warehouseName: warehouses.get(count.warehouseId) ?? null,
    lines: await describeCountLines(lines),
  };
}

// ---------------------------------------------------------------------------
// Locations without a recent count
// ---------------------------------------------------------------------------

export interface StaleLocationRow {
  locationId: string;
  warehouseId: string;
  warehouseName: string | null;
  code: string;
  label: string | null;
  kind: string;
  stockItems: number;
  lastCountedAt: string | null;
  daysSinceCount: number | null;
}

/** Active locations holding stock whose last count is older than `days` (or never counted). */
export async function listLocationsWithoutRecentCount(
  actor: CurrentUser,
  input: PageInput & { days?: number; warehouseId?: string | null; now?: Date } = {}
): Promise<Page<StaleLocationRow>> {
  requireView(actor);
  const now = input.now ?? new Date();
  const days = Math.min(Math.max(Math.trunc(input.days ?? 30), 1), 365);
  const threshold = new Date(now.getTime() - days * DAY_MS);
  const items = await prisma.stockItem.findMany({
    where: {
      knownQty: { not: 0 },
      ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    },
    select: { locationId: true, lastCountedAt: true },
    take: 20000,
  });
  const byLocation = new Map<string, { items: number; last: Date | null }>();
  for (const item of items) {
    const entry = byLocation.get(item.locationId) ?? { items: 0, last: null };
    entry.items += 1;
    if (item.lastCountedAt && (!entry.last || item.lastCountedAt > entry.last))
      entry.last = item.lastCountedAt;
    byLocation.set(item.locationId, entry);
  }
  const staleIds = [...byLocation.entries()]
    .filter(([, entry]) => !entry.last || entry.last < threshold)
    .map(([id]) => id);
  const locations = staleIds.length
    ? await prisma.storageLocation.findMany({ where: { id: { in: staleIds }, active: true } })
    : [];
  const warehouses = await warehouseNames(locations.map((l) => l.warehouseId));
  const rows = locations
    .map((location): StaleLocationRow => {
      const entry = byLocation.get(location.id)!;
      return {
        locationId: location.id,
        warehouseId: location.warehouseId,
        warehouseName: warehouses.get(location.warehouseId) ?? null,
        code: location.code,
        label: location.label,
        kind: location.kind,
        stockItems: entry.items,
        lastCountedAt: entry.last?.toISOString() ?? null,
        daysSinceCount: entry.last ? daysBetween(entry.last, now) : null,
      };
    })
    .sort((a, b) => {
      if (a.lastCountedAt === null && b.lastCountedAt !== null) return -1;
      if (b.lastCountedAt === null && a.lastCountedAt !== null) return 1;
      const byDate = (a.lastCountedAt ?? '').localeCompare(b.lastCountedAt ?? '');
      return byDate !== 0
        ? byDate
        : `${a.warehouseName}${a.code}`.localeCompare(`${b.warehouseName}${b.code}`);
    });
  return paginate(rows, input);
}

// ---------------------------------------------------------------------------
// DISPUTED items blocking cases
// ---------------------------------------------------------------------------

export interface BlockingDisputeRow {
  zohoItemId: string;
  productName: string | null;
  sku: string | null;
  disputedSince: string;
  cases: Array<{
    caseId: string;
    caseNumber: string;
    customerName: string | null;
    status: string;
    priority: string;
    promisedAt: string | null;
    demandIds: string[];
  }>;
  incidents: Array<{ id: string; severity: string; openedAt: string }>;
}

/** DISPUTED items with open demands of open cases (they cannot be promised until resolved). */
export async function listDisputedSkusBlockingCases(
  actor: CurrentUser,
  input: PageInput = {}
): Promise<Page<BlockingDisputeRow>> {
  requireView(actor);
  const profiles = await prisma.productInventoryProfile.findMany({
    where: { confidence: 'DISPUTED' },
    select: { zohoItemId: true, updatedAt: true },
    take: 1000,
  });
  if (profiles.length === 0) return paginate([], input);
  const itemIds = profiles.map((p) => p.zohoItemId);
  const demands = await prisma.caseDemand.findMany({
    where: { zohoItemId: { in: itemIds }, status: { in: OPEN_DEMAND_STATUSES } },
    select: { id: true, caseId: true, zohoItemId: true },
    take: 5000,
  });
  const cases = demands.length
    ? await prisma.operationalCase.findMany({
        where: {
          id: { in: [...new Set(demands.map((d) => d.caseId))] },
          status: { in: [...CASE_OPEN_STATUSES] },
        },
        select: {
          id: true,
          caseNumber: true,
          customerName: true,
          status: true,
          priority: true,
          promisedAt: true,
        },
      })
    : [];
  const caseBy = new Map(cases.map((c) => [c.id, c]));
  const incidents = await prisma.incident.findMany({
    where: {
      kind: 'count_dispute',
      status: { in: [...INCIDENT_OPEN_STATUSES] },
      dedupeKey: { startsWith: 'count_dispute:' },
    },
    select: { id: true, dedupeKey: true, severity: true, openedAt: true },
    take: 2000,
  });
  const products = await productsById(itemIds);
  const rows: BlockingDisputeRow[] = [];
  for (const profile of profiles) {
    const caseMap = new Map<string, string[]>();
    for (const demand of demands) {
      if (demand.zohoItemId !== profile.zohoItemId || !caseBy.has(demand.caseId)) continue;
      caseMap.set(demand.caseId, [...(caseMap.get(demand.caseId) ?? []), demand.id]);
    }
    if (caseMap.size === 0) continue;
    const product = products.get(profile.zohoItemId);
    rows.push({
      zohoItemId: profile.zohoItemId,
      productName: product?.name ?? null,
      sku: product?.sku ?? null,
      disputedSince: profile.updatedAt.toISOString(),
      cases: [...caseMap.entries()].map(([caseId, demandIds]) => {
        const row = caseBy.get(caseId)!;
        return {
          caseId,
          caseNumber: row.caseNumber,
          customerName: row.customerName,
          status: row.status,
          priority: row.priority,
          promisedAt: row.promisedAt?.toISOString() ?? null,
          demandIds,
        };
      }),
      incidents: incidents
        .filter(
          (incident) => incident.dedupeKey.split(':').slice(2).join(':') === profile.zohoItemId
        )
        .map((incident) => ({
          id: incident.id,
          severity: incident.severity,
          openedAt: incident.openedAt.toISOString(),
        })),
    });
  }
  rows.sort(
    (a, b) => b.cases.length - a.cases.length || a.disputedSince.localeCompare(b.disputedSince)
  );
  return paginate(rows, input);
}

// ---------------------------------------------------------------------------
// Legacy claims, warehouses, profiles, availability, snapshot, scan
// ---------------------------------------------------------------------------

export interface LegacyClaimRow extends LegacyClaimDTO {
  productName: string | null;
  sku: string | null;
  warehouseName: string | null;
  expired: boolean;
}

export async function listLegacyClaims(
  actor: CurrentUser,
  input: PageInput & {
    status?: LegacyClaimStatus | null;
    zohoItemId?: string | null;
    warehouseId?: string | null;
    caseId?: string | null;
    now?: Date;
  } = {}
): Promise<Page<LegacyClaimRow>> {
  requireView(actor);
  const { page, pageSize, skip } = normalizePage(input);
  const now = input.now ?? new Date();
  const where: Prisma.LegacyCommitmentClaimWhereInput = {
    ...(input.status ? { status: input.status } : {}),
    ...(input.zohoItemId ? { zohoItemId: input.zohoItemId } : {}),
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    ...(input.caseId ? { caseId: input.caseId } : {}),
  };
  const [total, claims] = await Promise.all([
    prisma.legacyCommitmentClaim.count({ where }),
    prisma.legacyCommitmentClaim.findMany({
      where,
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ]);
  const [products, warehouses] = await Promise.all([
    productsById(claims.map((c) => c.zohoItemId)),
    warehouseNames(claims.map((c) => c.warehouseId)),
  ]);
  const rows = claims.map((claim): LegacyClaimRow => ({
    ...toLegacyClaimDTO(claim),
    productName: products.get(claim.zohoItemId)?.name ?? null,
    sku: products.get(claim.zohoItemId)?.sku ?? null,
    warehouseName: warehouses.get(claim.warehouseId) ?? null,
    expired: claim.status === 'claimed' && claim.expiresAt.getTime() <= now.getTime(),
  }));
  return pageOf(rows, total, page, pageSize);
}

export interface WarehouseWithLocations extends WarehouseDTO {
  locations: LocationDTO[];
}

export async function listInventoryWarehouses(
  actor: CurrentUser,
  input: { includeInactive?: boolean } = {}
): Promise<WarehouseWithLocations[]> {
  requireView(actor);
  const warehouses = await prisma.warehouse.findMany({
    where: input.includeInactive ? {} : { active: true },
    orderBy: [{ name: 'asc' }],
  });
  const locations = warehouses.length
    ? await prisma.storageLocation.findMany({
        where: {
          warehouseId: { in: warehouses.map((w) => w.id) },
          ...(input.includeInactive ? {} : { active: true }),
        },
        orderBy: [{ code: 'asc' }],
      })
    : [];
  return warehouses.map((warehouse) => ({
    ...toWarehouseDTO(warehouse),
    locations: locations.filter((l) => l.warehouseId === warehouse.id).map(toLocationDTO),
  }));
}

export async function getInventoryProfile(
  actor: CurrentUser,
  zohoItemId: string
): Promise<ProfileDTO | null> {
  requireView(actor);
  const profile = await prisma.productInventoryProfile.findUnique({ where: { zohoItemId } });
  return profile ? toProfileDTO(profile) : null;
}

export async function getItemAvailability(
  actor: CurrentUser,
  query: AvailabilityQuery
): Promise<AvailabilityDTO> {
  requireView(actor);
  return toAvailabilityDTO(await verifyAvailability(prisma, query));
}

export async function getStockSnapshotForActor(
  actor: CurrentUser,
  filter: StockSnapshotFilter
): Promise<StockSnapshot> {
  requireView(actor);
  return getStockSnapshot(filter, prisma);
}

/** Scan resolution for the counting/dispatch PWA (view, count or manage permission). */
export async function scanStockCode(
  actor: CurrentUser,
  text: string,
  options: { warehouseId?: string | null } = {}
): Promise<ScanResolution> {
  assertAnyPermission(actor, ['inventory.view', 'inventory.count', 'inventory.manage']);
  return resolveScan(text, { warehouseId: options.warehouseId });
}

/** Confidence summary for dashboards: items per level. */
export async function getConfidenceSummary(
  actor: CurrentUser
): Promise<Array<{ confidence: ConfidenceLevel; label: string; items: number }>> {
  requireView(actor);
  const grouped = await prisma.productInventoryProfile.groupBy({
    by: ['confidence'],
    _count: { _all: true },
  });
  const counts = new Map<ConfidenceLevel, number>();
  for (const row of grouped) {
    const level = toConfidenceLevel(row.confidence);
    counts.set(level, (counts.get(level) ?? 0) + row._count._all);
  }
  return (Object.keys(CONFIDENCE_LABELS) as ConfidenceLevel[]).map((confidence) => ({
    confidence,
    label: CONFIDENCE_LABELS[confidence],
    items: counts.get(confidence) ?? 0,
  }));
}
