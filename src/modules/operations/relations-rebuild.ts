import { prisma } from '@/lib/prisma';

/**
 * Rebuild of the `ObjectRelation` projection (plan section 2.1: "proyección
 * reconstruible para el grafo"). Commands write relations as they happen with
 * `ctx.relate`; this job re-derives them from the source tables so the graph
 * can be repaired after a bug, a manual data fix or an import that bypassed
 * the commands.
 *
 * Each source scans its table by id with a cursor (bounded batches), derives
 * edges with the SAME relation names the producers use, inserts the missing
 * ones (`createMany … skipDuplicates`, i.e. ON CONFLICT DO NOTHING on the
 * unique key) and reopens the ones that had been closed — exactly what
 * `ctx.relate` does. It never deletes or closes relations: a relation that no
 * source can derive (for example `legacy_claim converted_to stock_reservation`,
 * which only lives in the command that converted it) is kept.
 *
 * Modules with their own relations add a source with `registerRelationSource`.
 */

export interface RelationEdge {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  validFrom: Date;
}

export interface RelationSourceBatch {
  edges: RelationEdge[];
  /** Rows read from the source table in this batch. */
  scanned: number;
  /** Cursor for the next batch, or null when the table is exhausted. */
  nextCursor: string | null;
}

export interface RelationSource {
  key: string;
  label: string;
  scan(cursor: string | null, take: number): Promise<RelationSourceBatch>;
}

export interface RelationSourceSummary {
  scanned: number;
  edges: number;
  created: number;
  reopened: number;
}

export interface RelationsRebuildSummary {
  sources: Record<string, RelationSourceSummary>;
  unknownSources: string[];
  aborted: boolean;
  durationMs: number;
}

export const RELATIONS_REBUILD_BATCH = 500;
const REOPEN_CHUNK = 100;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'operations-relations', event, ...extra }));

// ---------------------------------------------------------------------------
// Pure derivations (relation names match the producers' ctx.relate calls)
// ---------------------------------------------------------------------------

export function deliveryOrderEdges(order: {
  id: string;
  caseId: string;
  packageId: string | null;
  allocationIds: string[];
  parentDeliveryOrderId: string | null;
  vehicleId: string | null;
  tripId: string | null;
  createdAt: Date;
}): RelationEdge[] {
  const at = order.createdAt;
  const self = { type: 'delivery_order', id: order.id };
  const edge = (
    from: { type: string; id: string },
    to: { type: string; id: string },
    relation: string
  ): RelationEdge => ({
    fromType: from.type,
    fromId: from.id,
    toType: to.type,
    toId: to.id,
    relation,
    validFrom: at,
  });
  const edges = [edge({ type: 'operational_case', id: order.caseId }, self, 'has_delivery')];
  if (order.packageId)
    edges.push(edge(self, { type: 'package', id: order.packageId }, 'ships_with'));
  for (const allocationId of new Set(order.allocationIds)) {
    edges.push(edge(self, { type: 'demand_allocation', id: allocationId }, 'covers'));
  }
  if (order.parentDeliveryOrderId) {
    edges.push(
      edge({ type: 'delivery_order', id: order.parentDeliveryOrderId }, self, 'remainder')
    );
  }
  if (order.vehicleId) edges.push(edge(self, { type: 'vehicle', id: order.vehicleId }, 'uses'));
  if (order.tripId) edges.push(edge({ type: 'trip', id: order.tripId }, self, 'includes'));
  return edges;
}

export function tripEdges(trip: {
  id: string;
  vehicleId: string;
  driverId: string;
  createdAt: Date;
}): RelationEdge[] {
  return [
    {
      fromType: 'trip',
      fromId: trip.id,
      toType: 'vehicle',
      toId: trip.vehicleId,
      relation: 'uses',
      validFrom: trip.createdAt,
    },
    {
      fromType: 'trip',
      fromId: trip.id,
      toType: 'driver',
      toId: trip.driverId,
      relation: 'driven_by',
      validFrom: trip.createdAt,
    },
  ];
}

export function stockReservationEdges(reservation: {
  id: string;
  demandId: string;
  createdAt: Date;
}): RelationEdge[] {
  return [
    {
      fromType: 'stock_reservation',
      fromId: reservation.id,
      toType: 'case_demand',
      toId: reservation.demandId,
      relation: 'reserved_for',
      validFrom: reservation.createdAt,
    },
  ];
}

export function legacyClaimEdges(claim: {
  id: string;
  caseId: string | null;
  createdAt: Date;
}): RelationEdge[] {
  if (!claim.caseId) return [];
  return [
    {
      fromType: 'legacy_claim',
      fromId: claim.id,
      toType: 'operational_case',
      toId: claim.caseId,
      relation: 'claimed_for',
      validFrom: claim.createdAt,
    },
  ];
}

export function edgeKey(edge: Omit<RelationEdge, 'validFrom'>): string {
  return [edge.fromType, edge.fromId, edge.toType, edge.toId, edge.relation].join('|');
}

/** Removes duplicates (first occurrence wins) and edges with an empty endpoint. */
export function dedupeEdges(edges: RelationEdge[]): RelationEdge[] {
  const seen = new Set<string>();
  const out: RelationEdge[] = [];
  for (const edge of edges) {
    if (!edge.fromId || !edge.toId) continue;
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

type GlobalWithSources = typeof globalThis & {
  __unikRelationSources?: Map<string, RelationSource>;
};

function sources(): Map<string, RelationSource> {
  const scope = globalThis as GlobalWithSources;
  if (!scope.__unikRelationSources) scope.__unikRelationSources = new Map();
  return scope.__unikRelationSources;
}

/** Registers (or replaces, on hot reload) a source of derivable relations. */
export function registerRelationSource(source: RelationSource): void {
  sources().set(source.key, source);
}

export function listRelationSources(): Array<{ key: string; label: string }> {
  return [...sources().values()].map(({ key, label }) => ({ key, label }));
}

const afterCursor = (cursor: string | null) => (cursor ? { id: { gt: cursor } } : {});
const nextCursorOf = (rows: Array<{ id: string }>, take: number) =>
  rows.length === take ? rows[rows.length - 1].id : null;

registerRelationSource({
  key: 'delivery_orders',
  label: 'Órdenes de entrega',
  async scan(cursor, take) {
    const rows = await prisma.deliveryOrder.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        caseId: true,
        packageId: true,
        allocationIds: true,
        parentDeliveryOrderId: true,
        vehicleId: true,
        tripId: true,
        createdAt: true,
      },
    });
    return {
      edges: rows.flatMap(deliveryOrderEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'trips',
  label: 'Viajes',
  async scan(cursor, take) {
    const rows = await prisma.trip.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, vehicleId: true, driverId: true, createdAt: true },
    });
    return {
      edges: rows.flatMap(tripEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'stock_reservations',
  label: 'Reservas de inventario',
  async scan(cursor, take) {
    const rows = await prisma.stockReservation.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, demandId: true, createdAt: true },
    });
    return {
      edges: rows.flatMap(stockReservationEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'legacy_claims',
  label: 'Reclamos de compromisos previos',
  async scan(cursor, take) {
    const rows = await prisma.legacyCommitmentClaim.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, caseId: true, createdAt: true },
    });
    return {
      edges: rows.flatMap(legacyClaimEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Inserts missing edges and reopens closed ones (same semantics as `ctx.relate`). */
export async function upsertRelationEdges(
  input: RelationEdge[]
): Promise<{ created: number; reopened: number }> {
  const edges = dedupeEdges(input);
  if (edges.length === 0) return { created: 0, reopened: 0 };
  const { count: created } = await prisma.objectRelation.createMany({
    data: edges,
    skipDuplicates: true,
  });
  let reopened = 0;
  for (let i = 0; i < edges.length; i += REOPEN_CHUNK) {
    const chunk = edges.slice(i, i + REOPEN_CHUNK);
    const res = await prisma.objectRelation.updateMany({
      where: {
        validTo: { not: null },
        OR: chunk.map(({ fromType, fromId, toType, toId, relation }) => ({
          fromType,
          fromId,
          toType,
          toId,
          relation,
        })),
      },
      data: { validTo: null },
    });
    reopened += res.count;
  }
  return { created, reopened };
}

export interface RebuildRelationsOptions {
  /** Source keys to rebuild (default: every registered source). */
  sources?: string[];
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => Promise<void> | void;
}

export async function rebuildObjectRelations(
  options: RebuildRelationsOptions = {}
): Promise<RelationsRebuildSummary> {
  const startedAt = Date.now();
  const registry = sources();
  const requested = options.sources?.length ? [...new Set(options.sources)] : [...registry.keys()];
  const selected = requested.filter((key) => registry.has(key));
  const unknownSources = requested.filter((key) => !registry.has(key));
  const take = Math.min(
    Math.max(1, Math.floor(options.batchSize ?? RELATIONS_REBUILD_BATCH)),
    2000
  );
  const summary: RelationsRebuildSummary = {
    sources: {},
    unknownSources,
    aborted: false,
    durationMs: 0,
  };

  for (const [index, key] of selected.entries()) {
    const source = registry.get(key)!;
    const totals: RelationSourceSummary = { scanned: 0, edges: 0, created: 0, reopened: 0 };
    summary.sources[key] = totals;
    let cursor: string | null = null;
    do {
      if (options.signal?.aborted) {
        summary.aborted = true;
        break;
      }
      const batch = await source.scan(cursor, take);
      const { created, reopened } = await upsertRelationEdges(batch.edges);
      totals.scanned += batch.scanned;
      totals.edges += batch.edges.length;
      totals.created += created;
      totals.reopened += reopened;
      cursor = batch.nextCursor;
    } while (cursor);
    log('source_rebuilt', { source: key, ...totals });
    await options.onProgress?.(index + 1, selected.length);
    if (summary.aborted) break;
  }

  summary.durationMs = Date.now() - startedAt;
  log('rebuild_done', {
    sources: selected,
    unknownSources,
    aborted: summary.aborted,
    durationMs: summary.durationMs,
  });
  return summary;
}
