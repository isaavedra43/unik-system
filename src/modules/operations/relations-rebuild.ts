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
 * `ctx.relate` does. It never deletes or closes relations, so an edge only a
 * command could know is kept rather than lost.
 *
 * Every source lives in THIS file on purpose: the registry is reachable from a
 * single import, so a rebuild can never silently skip an area because that
 * area's module happened not to be loaded in the worker. `registerRelationSource`
 * stays exported for genuine extension.
 *
 * NOT reconstructible, and deliberately so — these edges have no column behind
 * them, only the command that wrote them, so the rebuild leaves them untouched:
 *  - `legacy_claim converted_to stock_reservation` (inventory)
 *  - `procurement_order caused_by user` and `area_request caused_by user`: who
 *    caused an AI turn is an argument of the turn, never a stored field.
 *  - `goods_receipt confirmed_delivery delivery_order` and
 *    `goods_receipt_line reserved_for stock_reservation` (direct delivery)
 *  - `area_request fulfilled_by purchase_request_line` (shortfall)
 *  - `production_order answers area_request` when the request pointed at a
 *    `case_demand` instead of a `demand_allocation`: the allocation was chosen
 *    by state that has since moved on.
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

/**
 * Builds one edge, or none when either endpoint is missing. Every derivation
 * below is a pure function of one source row plus, when the producer wrote an
 * id this table does not hold, a lookup map resolved once per batch.
 */
function rel(
  from: { type: string; id: string | null | undefined },
  to: { type: string; id: string | null | undefined },
  relation: string,
  validFrom: Date
): RelationEdge[] {
  if (!from.id || !to.id) return [];
  return [
    { fromType: from.type, fromId: from.id, toType: to.type, toId: to.id, relation, validFrom },
  ];
}

/** `case.start`: the case fulfills the LOCAL sales order row, not the Zoho id it stores. */
export function operationalCaseEdges(
  row: { id: string; zohoSalesOrderId: string | null; createdAt: Date },
  salesOrderIdByZohoId: ReadonlyMap<string, string>
): RelationEdge[] {
  const salesOrderId = row.zohoSalesOrderId
    ? salesOrderIdByZohoId.get(row.zohoSalesOrderId)
    : undefined;
  return rel(
    { type: 'operational_case', id: row.id },
    { type: 'sales_order', id: salesOrderId },
    'fulfills',
    row.createdAt
  );
}

export function demandAllocationEdges(row: {
  id: string;
  demandId: string;
  linkedType: string | null;
  linkedId: string | null;
  createdAt: Date;
}): RelationEdge[] {
  const self = { type: 'demand_allocation', id: row.id };
  return [
    ...rel(self, { type: 'case_demand', id: row.demandId }, 'allocates', row.createdAt),
    ...rel(
      self,
      { type: 'area_request', id: row.linkedType === 'area_request' ? row.linkedId : null },
      'requested_via',
      row.createdAt
    ),
  ];
}

/**
 * A payment request always points at the payable (`objectType = 'obligation'`),
 * which is what Contabilidad authorizes. `payment_for_order` needs the order
 * behind that payable, which lives on `Obligation.procurementOrderId`.
 */
export function areaRequestEdges(
  row: { id: string; objectType: string; objectId: string; createdAt: Date },
  procurementOrderIdByObligationId: ReadonlyMap<string, string>
): RelationEdge[] {
  if (row.objectType !== 'obligation') return [];
  const self = { type: 'area_request', id: row.id };
  return [
    ...rel(self, { type: 'obligation', id: row.objectId }, 'payment_for', row.createdAt),
    ...rel(
      self,
      { type: 'procurement_order', id: procurementOrderIdByObligationId.get(row.objectId) },
      'payment_for_order',
      row.createdAt
    ),
  ];
}

export function procurementOrderEdges(
  row: {
    id: string;
    supplierId: string;
    obligationId: string | null;
    rfqResponseId: string | null;
    directDeliveryCaseId: string | null;
    createdAt: Date;
  },
  rfqIdByResponseId: ReadonlyMap<string, string>
): RelationEdge[] {
  const self = { type: 'procurement_order', id: row.id };
  const rfqId = row.rfqResponseId ? rfqIdByResponseId.get(row.rfqResponseId) : undefined;
  return [
    ...rel(self, { type: 'supplier', id: row.supplierId }, 'ordered_from', row.createdAt),
    ...rel(self, { type: 'obligation', id: row.obligationId }, 'payable', row.createdAt),
    ...rel({ type: 'rfq', id: rfqId }, self, 'awarded_as', row.createdAt),
    // Direct delivery: the supplier ships to the customer of this case.
    ...rel(
      { type: 'operational_case', id: row.directDeliveryCaseId },
      self,
      'supplied_by',
      row.createdAt
    ),
  ];
}

export function procurementOrderLineEdges(
  row: { id: string; orderId: string; requestLineId: string | null; createdAt: Date },
  requestIdByLineId: ReadonlyMap<string, string>
): RelationEdge[] {
  const requestId = row.requestLineId ? requestIdByLineId.get(row.requestLineId) : undefined;
  return rel(
    { type: 'purchase_request', id: requestId },
    { type: 'procurement_order', id: row.orderId },
    'ordered_in',
    row.createdAt
  );
}

/** Warehouse path of `supplied_by`: order line → allocation → demand → case. */
export function procurementAllocationEdges(
  row: { id: string; orderLineId: string; demandId: string; createdAt: Date },
  orderIdByLineId: ReadonlyMap<string, string>,
  caseIdByDemandId: ReadonlyMap<string, string>
): RelationEdge[] {
  return rel(
    { type: 'operational_case', id: caseIdByDemandId.get(row.demandId) },
    { type: 'procurement_order', id: orderIdByLineId.get(row.orderLineId) },
    'supplied_by',
    row.createdAt
  );
}

export function purchaseRequestEdges(row: {
  id: string;
  caseId: string | null;
  createdAt: Date;
}): RelationEdge[] {
  return rel(
    { type: 'purchase_request', id: row.id },
    { type: 'operational_case', id: row.caseId },
    'for_case',
    row.createdAt
  );
}

export function supplierEdges(row: {
  id: string;
  zohoContactId: string | null;
  sourceCandidateId: string | null;
  createdAt: Date;
}): RelationEdge[] {
  const self = { type: 'supplier', id: row.id };
  return [
    ...rel(self, { type: 'zoho_contact', id: row.zohoContactId }, 'same_as', row.createdAt),
    ...rel(
      { type: 'sourcing_candidate', id: row.sourceCandidateId },
      self,
      'promoted_to',
      row.createdAt
    ),
  ];
}

export function rfqLineEdges(
  row: { id: string; rfqId: string; requestLineId: string | null; createdAt: Date },
  requestIdByLineId: ReadonlyMap<string, string>
): RelationEdge[] {
  const requestId = row.requestLineId ? requestIdByLineId.get(row.requestLineId) : undefined;
  return rel(
    { type: 'purchase_request', id: requestId },
    { type: 'rfq', id: row.rfqId },
    'quoted_in',
    row.createdAt
  );
}

export function rfqInvitationEdges(row: {
  id: string;
  rfqId: string;
  conversationId: string | null;
  createdAt: Date;
}): RelationEdge[] {
  return rel(
    { type: 'rfq', id: row.rfqId },
    { type: 'comm_conversation', id: row.conversationId },
    'negotiated_in',
    row.createdAt
  );
}

export function goodsReceiptEdges(row: {
  id: string;
  orderId: string;
  createdAt: Date;
}): RelationEdge[] {
  return rel(
    { type: 'goods_receipt', id: row.id },
    { type: 'procurement_order', id: row.orderId },
    'receipt_of',
    row.createdAt
  );
}

/** CRM stores Zoho ids; the producers related the LOCAL mirror rows. */
export function opportunityEdges(
  row: {
    id: string;
    conversationIds: string[];
    voiceCallIds: string[];
    zohoEstimateIds: string[];
    zohoSalesOrderIds: string[];
    createdAt: Date;
  },
  quoteIdByZohoEstimateId: ReadonlyMap<string, string>,
  salesOrderIdByZohoId: ReadonlyMap<string, string>
): RelationEdge[] {
  const self = { type: 'opportunity', id: row.id };
  const at = row.createdAt;
  return [
    ...row.conversationIds.flatMap((id) =>
      rel({ type: 'comm_conversation', id }, self, 'originated', at)
    ),
    ...row.voiceCallIds.flatMap((id) => rel({ type: 'voice_call', id }, self, 'originated', at)),
    ...row.zohoEstimateIds.flatMap((zohoId) =>
      rel(self, { type: 'quote', id: quoteIdByZohoEstimateId.get(zohoId) }, 'quoted', at)
    ),
    ...row.zohoSalesOrderIds.flatMap((zohoId) =>
      rel(self, { type: 'sales_order', id: salesOrderIdByZohoId.get(zohoId) }, 'resulted_in', at)
    ),
  ];
}

export function productionOrderEdges(
  row: {
    id: string;
    caseId: string | null;
    demandId: string | null;
    demandAllocationId: string | null;
    createdAt: Date;
  },
  areaRequestIdByAllocationId: ReadonlyMap<string, string>
): RelationEdge[] {
  const self = { type: 'production_order', id: row.id };
  const requestId = row.demandAllocationId
    ? areaRequestIdByAllocationId.get(row.demandAllocationId)
    : undefined;
  return [
    ...rel(self, { type: 'operational_case', id: row.caseId }, 'for_case', row.createdAt),
    ...rel(self, { type: 'case_demand', id: row.demandId }, 'produces_for', row.createdAt),
    ...rel(
      self,
      { type: 'demand_allocation', id: row.demandAllocationId },
      'fulfills',
      row.createdAt
    ),
    ...rel(self, { type: 'area_request', id: requestId }, 'answers', row.createdAt),
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

/** `Map(key → value)`; the first row wins, so an ordered scan picks the earliest. */
function indexBy<T>(
  rows: T[],
  key: (row: T) => string | null,
  value: (row: T) => string | null
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const k = key(row);
    const v = value(row);
    if (k && v && !map.has(k)) map.set(k, v);
  }
  return map;
}

const uniq = (ids: Array<string | null | undefined>): string[] => [
  ...new Set(ids.filter((id): id is string => Boolean(id))),
];

/** `PurchaseRequestLine.id → requestId`, shared by the order lines and the RFQ lines. */
async function requestIdsOfLines(lineIds: string[]): Promise<Map<string, string>> {
  if (lineIds.length === 0) return new Map();
  const rows = await prisma.purchaseRequestLine.findMany({
    where: { id: { in: lineIds } },
    select: { id: true, requestId: true },
  });
  return indexBy(
    rows,
    (r) => r.id,
    (r) => r.requestId
  );
}

registerRelationSource({
  key: 'cases',
  label: 'Expedientes',
  async scan(cursor, take) {
    const rows = await prisma.operationalCase.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, zohoSalesOrderId: true, createdAt: true },
    });
    const orders = await prisma.salesOrder.findMany({
      where: { zohoSalesOrderId: { in: uniq(rows.map((r) => r.zohoSalesOrderId)) } },
      select: { id: true, zohoSalesOrderId: true },
    });
    const byZohoId = indexBy(
      orders,
      (o) => o.zohoSalesOrderId,
      (o) => o.id
    );
    return {
      edges: rows.flatMap((row) => operationalCaseEdges(row, byZohoId)),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'demand_allocations',
  label: 'Asignaciones de demanda',
  async scan(cursor, take) {
    const rows = await prisma.demandAllocation.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, demandId: true, linkedType: true, linkedId: true, createdAt: true },
    });
    return {
      edges: rows.flatMap(demandAllocationEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'area_requests',
  label: 'Solicitudes entre áreas',
  async scan(cursor, take) {
    const rows = await prisma.areaRequest.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, objectType: true, objectId: true, createdAt: true },
    });
    const obligationIds = uniq(
      rows.filter((r) => r.objectType === 'obligation').map((r) => r.objectId)
    );
    const obligations = obligationIds.length
      ? await prisma.obligation.findMany({
          where: { id: { in: obligationIds }, procurementOrderId: { not: null } },
          select: { id: true, procurementOrderId: true },
        })
      : [];
    const orderByObligation = indexBy(
      obligations,
      (o) => o.id,
      (o) => o.procurementOrderId
    );
    return {
      edges: rows.flatMap((row) => areaRequestEdges(row, orderByObligation)),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'procurement_orders',
  label: 'Órdenes de compra',
  async scan(cursor, take) {
    const rows = await prisma.procurementOrder.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        supplierId: true,
        obligationId: true,
        rfqResponseId: true,
        directDeliveryCaseId: true,
        createdAt: true,
      },
    });
    const responseIds = uniq(rows.map((r) => r.rfqResponseId));
    const responses = responseIds.length
      ? await prisma.rfqResponse.findMany({
          where: { id: { in: responseIds } },
          select: { id: true, rfqId: true },
        })
      : [];
    const rfqByResponse = indexBy(
      responses,
      (r) => r.id,
      (r) => r.rfqId
    );
    return {
      edges: rows.flatMap((row) => procurementOrderEdges(row, rfqByResponse)),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'procurement_order_lines',
  label: 'Renglones de órdenes de compra',
  async scan(cursor, take) {
    const rows = await prisma.procurementOrderLine.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, orderId: true, requestLineId: true, createdAt: true },
    });
    const requestByLine = await requestIdsOfLines(uniq(rows.map((r) => r.requestLineId)));
    return {
      edges: rows.flatMap((row) => procurementOrderLineEdges(row, requestByLine)),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'procurement_allocations',
  label: 'Asignaciones de órdenes de compra',
  async scan(cursor, take) {
    const rows = await prisma.procurementAllocation.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, orderLineId: true, demandId: true, createdAt: true },
    });
    const [lines, demands] = await Promise.all([
      prisma.procurementOrderLine.findMany({
        where: { id: { in: uniq(rows.map((r) => r.orderLineId)) } },
        select: { id: true, orderId: true },
      }),
      prisma.caseDemand.findMany({
        where: { id: { in: uniq(rows.map((r) => r.demandId)) } },
        select: { id: true, caseId: true },
      }),
    ]);
    const orderByLine = indexBy(
      lines,
      (l) => l.id,
      (l) => l.orderId
    );
    const caseByDemand = indexBy(
      demands,
      (d) => d.id,
      (d) => d.caseId
    );
    return {
      edges: rows.flatMap((row) => procurementAllocationEdges(row, orderByLine, caseByDemand)),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'purchase_requests',
  label: 'Solicitudes de compra',
  async scan(cursor, take) {
    const rows = await prisma.purchaseRequest.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, caseId: true, createdAt: true },
    });
    return {
      edges: rows.flatMap(purchaseRequestEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'suppliers',
  label: 'Proveedores',
  async scan(cursor, take) {
    const rows = await prisma.supplier.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, zohoContactId: true, sourceCandidateId: true, createdAt: true },
    });
    return {
      edges: rows.flatMap(supplierEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'rfq_lines',
  label: 'Renglones de cotización a proveedores',
  async scan(cursor, take) {
    const rows = await prisma.rfqLine.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, rfqId: true, requestLineId: true, createdAt: true },
    });
    const requestByLine = await requestIdsOfLines(uniq(rows.map((r) => r.requestLineId)));
    return {
      edges: rows.flatMap((row) => rfqLineEdges(row, requestByLine)),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'rfq_invitations',
  label: 'Invitaciones a cotizar',
  async scan(cursor, take) {
    const rows = await prisma.rfqInvitation.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, rfqId: true, conversationId: true, createdAt: true },
    });
    return {
      edges: rows.flatMap(rfqInvitationEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'goods_receipts',
  label: 'Recepciones de mercancía',
  async scan(cursor, take) {
    const rows = await prisma.goodsReceipt.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: { id: true, orderId: true, createdAt: true },
    });
    return {
      edges: rows.flatMap(goodsReceiptEdges),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'opportunities',
  label: 'Oportunidades',
  async scan(cursor, take) {
    const rows = await prisma.opportunity.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        conversationIds: true,
        voiceCallIds: true,
        zohoEstimateIds: true,
        zohoSalesOrderIds: true,
        createdAt: true,
      },
    });
    const [quotes, orders] = await Promise.all([
      prisma.quote.findMany({
        where: { zohoEstimateId: { in: uniq(rows.flatMap((r) => r.zohoEstimateIds)) } },
        select: { id: true, zohoEstimateId: true },
      }),
      prisma.salesOrder.findMany({
        where: { zohoSalesOrderId: { in: uniq(rows.flatMap((r) => r.zohoSalesOrderIds)) } },
        select: { id: true, zohoSalesOrderId: true },
      }),
    ]);
    const quoteByZohoId = indexBy(
      quotes,
      (q) => q.zohoEstimateId,
      (q) => q.id
    );
    const orderByZohoId = indexBy(
      orders,
      (o) => o.zohoSalesOrderId,
      (o) => o.id
    );
    return {
      edges: rows.flatMap((row) => opportunityEdges(row, quoteByZohoId, orderByZohoId)),
      scanned: rows.length,
      nextCursor: nextCursorOf(rows, take),
    };
  },
});

registerRelationSource({
  key: 'production_orders',
  label: 'Órdenes de producción',
  async scan(cursor, take) {
    const rows = await prisma.productionOrder.findMany({
      where: afterCursor(cursor),
      orderBy: { id: 'asc' },
      take,
      select: {
        id: true,
        caseId: true,
        demandId: true,
        demandAllocationId: true,
        createdAt: true,
      },
    });
    const allocationIds = uniq(rows.map((r) => r.demandAllocationId));
    // The transformation request that asked for this allocation; the earliest wins.
    const requests = allocationIds.length
      ? await prisma.areaRequest.findMany({
          where: {
            objectType: 'demand_allocation',
            objectId: { in: allocationIds },
            kind: 'transformation',
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, objectId: true },
        })
      : [];
    const requestByAllocation = indexBy(
      requests,
      (r) => r.objectId,
      (r) => r.id
    );
    return {
      edges: rows.flatMap((row) => productionOrderEdges(row, requestByAllocation)),
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
