import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { AuthorizationError, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { normalizePage, type Page, type PageInput } from '@/modules/inventory/inventory-queries';
import { OperationsError } from '@/modules/operations/errors';
import { ORDER_COMMITTED_STATUSES, ORDER_OPEN_STATUSES, orderStatusLabel } from './orders-state';
import {
  toAllocationDTO,
  toCandidateDTO,
  toOrderDTO,
  toOrderLineDTO,
  toPurchaseRequestDTO,
  toReceiptDTO,
  toRfqDTO,
  toRfqInvitationDTO,
  toRfqResponseDTO,
  toSearchDTO,
  toSupplierDTO,
  toSupplierEvaluationDTO,
  toSupplierProductDTO,
  type GoodsReceiptDTO,
  type ProcurementOrderDTO,
  type PurchaseRequestDTO,
  type RfqDTO,
  type SourcingCandidateDTO,
  type SourcingSearchDTO,
  type SupplierDTO,
  type SupplierEvaluationDTO,
  type SupplierProductDTO,
} from './purchases-dto';
import { decText, num, parseChannels } from './purchases-helpers';
import { PURCHASE_REQUEST_OPEN_STATUSES, labelOf, RFQ_STATUS_LABELS } from './purchases-types';
import { loadRfqScoringInputs, rankingFromInputs, type RfqRankingEntry } from './rfq-service';
import { matchVendorContact } from './sourcing-dedupe';

/**
 * Read side of Compras for its surfaces, the AI tools and the routes. Every
 * function takes the session user and checks the permission on the server;
 * lists are paginated (`page` from 1, `pageSize` ≤ 200) and return JSON-safe
 * DTOs. Expected supply is always reported apart from stock: it is never
 * available.
 *
 * ONE implementation per datum: the lists of the work centre (requests, RFQs,
 * orders, receipts and suppliers as rows) are the SQL union of
 * `areas/compras/compras-rows.ts`, the panel counters live in
 * `compras-dashboard.ts` and the CSV/XLSX export is the one of the area
 * (`exportAreaRowsAction`, gated by `purchases.export`). The parallel
 * `listRfqs` / `listProcurementOrders` / `listGoodsReceipts` /
 * `getPurchasesBoard` / `exportProcurementOrdersCsv` that nothing called were
 * removed instead of kept as a second answer to the same question; what is
 * left here is what a real surface or tool reads: the DETAIL of one thing and
 * the reads Compras has no row for (expected supply, sourcing).
 */

const VIEW = 'purchases.view';

function assertAny(actor: CurrentUser, keys: readonly string[]): void {
  if (!keys.some((key) => hasPermission(actor, key))) {
    throw new AuthorizationError('No tienes permisos para consultar compras');
  }
}

function pageOf<T>(rows: T[], total: number, page: number, pageSize: number): Page<T> {
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

function statusFilter(
  value: string | readonly string[] | null | undefined
): Prisma.StringFilter | string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  return value.length > 0 ? { in: [...value] } : undefined;
}

async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [
    ...new Set(ids.filter((id): id is string => Boolean(id) && !String(id).includes(':'))),
  ];
  if (unique.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function caseNumbers(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.operationalCase.findMany({
    where: { id: { in: unique } },
    select: { id: true, caseNumber: true },
  });
  return new Map(rows.map((row) => [row.id, row.caseNumber]));
}

// ---------------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------------

export interface PurchaseRequestFilters extends PageInput {
  status?: string | string[];
  onlyOpen?: boolean;
  caseId?: string | null;
  areaKey?: string | null;
  search?: string | null;
}

export async function listPurchaseRequests(
  actor: CurrentUser,
  filters: PurchaseRequestFilters = {}
): Promise<Page<PurchaseRequestDTO>> {
  assertAny(actor, [VIEW, 'purchases.request']);
  const { page, pageSize, skip } = normalizePage(filters);
  const where: Prisma.PurchaseRequestWhereInput = {
    ...(filters.onlyOpen ? { status: { in: [...PURCHASE_REQUEST_OPEN_STATUSES] } } : {}),
    ...(filters.status ? { status: statusFilter(filters.status) } : {}),
    ...(filters.caseId ? { caseId: filters.caseId } : {}),
    ...(filters.areaKey ? { areaKey: filters.areaKey } : {}),
    ...(filters.search?.trim()
      ? {
          OR: [
            { number: { contains: filters.search.trim(), mode: 'insensitive' } },
            { reason: { contains: filters.search.trim(), mode: 'insensitive' } },
            {
              lines: {
                some: { description: { contains: filters.search.trim(), mode: 'insensitive' } },
              },
            },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.purchaseRequest.count({ where }),
    prisma.purchaseRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip,
      take: pageSize,
      include: { lines: true },
    }),
  ]);
  const [cases, names] = await Promise.all([
    caseNumbers(rows.map((r) => r.caseId)),
    userNames(rows.map((r) => r.requestedByUserId)),
  ]);
  return pageOf(
    rows.map((row) =>
      toPurchaseRequestDTO(row, row.lines, {
        caseNumber: row.caseId ? (cases.get(row.caseId) ?? null) : null,
        requestedByName: names.get(row.requestedByUserId) ?? null,
      })
    ),
    total,
    page,
    pageSize
  );
}

export interface PurchaseRequestDetail extends PurchaseRequestDTO {
  orders: Array<{ id: string; number: string; status: string; statusLabel: string }>;
  rfqs: Array<{ id: string; number: string; status: string; statusLabel: string }>;
  areaRequestIds: string[];
}

export async function getPurchaseRequest(
  actor: CurrentUser,
  requestId: string
): Promise<PurchaseRequestDetail> {
  assertAny(actor, [VIEW, 'purchases.request']);
  const row = await prisma.purchaseRequest.findUnique({
    where: { id: requestId },
    include: { lines: true },
  });
  if (!row) throw new OperationsError('not_found', 'No se encontró la solicitud de compra');
  const relations = await prisma.objectRelation.findMany({
    where: {
      fromType: 'purchase_request',
      fromId: row.id,
      validTo: null,
      toType: { in: ['procurement_order', 'rfq'] },
    },
    select: { toType: true, toId: true },
  });
  const lineIds = row.lines.map((l) => l.id);
  const areaRelations = lineIds.length
    ? await prisma.objectRelation.findMany({
        where: {
          fromType: 'area_request',
          toType: 'purchase_request_line',
          toId: { in: lineIds },
          validTo: null,
        },
        select: { fromId: true },
      })
    : [];
  const [orders, rfqs, cases, names] = await Promise.all([
    prisma.procurementOrder.findMany({
      where: {
        id: { in: relations.filter((r) => r.toType === 'procurement_order').map((r) => r.toId) },
      },
      select: { id: true, number: true, status: true },
    }),
    prisma.rfq.findMany({
      where: { id: { in: relations.filter((r) => r.toType === 'rfq').map((r) => r.toId) } },
      select: { id: true, number: true, status: true },
    }),
    caseNumbers([row.caseId]),
    userNames([row.requestedByUserId]),
  ]);
  return {
    ...toPurchaseRequestDTO(row, row.lines, {
      caseNumber: row.caseId ? (cases.get(row.caseId) ?? null) : null,
      requestedByName: names.get(row.requestedByUserId) ?? null,
    }),
    orders: orders.map((o) => ({ ...o, statusLabel: orderStatusLabel(o.status) })),
    rfqs: rfqs.map((r) => ({ ...r, statusLabel: labelOf(RFQ_STATUS_LABELS, r.status) })),
    areaRequestIds: [...new Set(areaRelations.map((r) => r.fromId))],
  };
}

// ---------------------------------------------------------------------------
// RFQ
// ---------------------------------------------------------------------------

export interface RfqDetail extends RfqDTO {
  comparison: RfqRankingEntry[];
}

export async function getRfq(
  actor: CurrentUser,
  rfqId: string,
  now: Date = new Date()
): Promise<RfqDetail> {
  assertAny(actor, [VIEW, 'purchases.sourcing']);
  const inputs = await loadRfqScoringInputs(prisma, rfqId);
  const invitations = await prisma.rfqInvitation.findMany({
    where: { rfqId },
    orderBy: { createdAt: 'asc' },
  });
  const allResponses = await prisma.rfqResponse.findMany({
    where: { rfqId },
    orderBy: { createdAt: 'asc' },
  });
  const responseLines = allResponses.length
    ? await prisma.rfqResponseLine.findMany({
        where: { responseId: { in: allResponses.map((r) => r.id) } },
      })
    : [];
  const supplierIds = [
    ...new Set(
      [...invitations, ...allResponses]
        .map((r) => r.supplierId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const candidateIds = [
    ...new Set(
      [...invitations, ...allResponses]
        .map((r) => r.candidateId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const [suppliers, candidates] = await Promise.all([
    prisma.supplier.findMany({
      where: { id: { in: supplierIds } },
      select: { id: true, name: true },
    }),
    prisma.sourcingCandidate.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, name: true },
    }),
  ]);
  const nameOf = (supplierId: string | null, candidateId: string | null) =>
    suppliers.find((s) => s.id === supplierId)?.name ??
    candidates.find((c) => c.id === candidateId)?.name ??
    null;
  return {
    ...toRfqDTO(inputs.rfq, {
      lines: inputs.lines,
      invitations: invitations.map((i) =>
        toRfqInvitationDTO(i, nameOf(i.supplierId, i.candidateId))
      ),
      responses: allResponses.map((r) =>
        toRfqResponseDTO(
          r,
          responseLines.filter((l) => l.responseId === r.id),
          nameOf(r.supplierId, r.candidateId)
        )
      ),
    }),
    comparison: inputs.responses.length ? rankingFromInputs(inputs, now) : [],
  };
}

export async function getRfqComparison(
  actor: CurrentUser,
  rfqId: string,
  now: Date = new Date()
): Promise<{ rfqId: string; number: string; ranking: RfqRankingEntry[] }> {
  assertAny(actor, [VIEW, 'purchases.sourcing']);
  const inputs = await loadRfqScoringInputs(prisma, rfqId);
  return {
    rfqId,
    number: inputs.rfq.number,
    ranking: inputs.responses.length ? rankingFromInputs(inputs, now) : [],
  };
}

// ---------------------------------------------------------------------------
// Procurement orders
// ---------------------------------------------------------------------------

export interface ProcurementOrderDetail extends ProcurementOrderDTO {
  receipts: GoodsReceiptDTO[];
  approval: {
    id: string;
    status: string;
    requiredApprovals: number;
    approvals: number;
    expiresAt: string | null;
  } | null;
  obligation: {
    id: string;
    number: string;
    status: string;
    expectedAmount: string;
    settledAmount: string;
    dueAt: string | null;
  } | null;
  caseIds: string[];
  openIncidents: Array<{ id: string; kind: string; severity: string; title: string }>;
}

export async function getProcurementOrder(
  actor: CurrentUser,
  orderId: string
): Promise<ProcurementOrderDetail> {
  assertAny(actor, [VIEW]);
  const order = await prisma.procurementOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new OperationsError('not_found', 'No se encontró la orden de compra');
  const [supplier, lines, receipts] = await Promise.all([
    prisma.supplier.findUnique({ where: { id: order.supplierId }, select: { name: true } }),
    prisma.procurementOrderLine.findMany({ where: { orderId }, orderBy: { sortOrder: 'asc' } }),
    prisma.goodsReceipt.findMany({
      where: { orderId },
      orderBy: { receivedAt: 'asc' },
      include: { lines: true },
    }),
  ]);
  const allocations = lines.length
    ? await prisma.procurementAllocation.findMany({
        where: { orderLineId: { in: lines.map((l) => l.id) } },
      })
    : [];
  const demands = allocations.length
    ? await prisma.caseDemand.findMany({
        where: { id: { in: allocations.map((a) => a.demandId) } },
        select: { id: true, caseId: true, name: true },
      })
    : [];
  const demandAllocations = allocations.some((a) => a.demandAllocationId)
    ? await prisma.demandAllocation.findMany({
        where: {
          id: {
            in: allocations
              .map((a) => a.demandAllocationId)
              .filter((id): id is string => Boolean(id)),
          },
        },
        select: { id: true, status: true },
      })
    : [];
  const cases = await caseNumbers([order.directDeliveryCaseId, ...demands.map((d) => d.caseId)]);
  const [approval, obligation] = await Promise.all([
    order.approvalRequestId
      ? prisma.approvalRequest.findUnique({ where: { id: order.approvalRequestId } })
      : null,
    order.obligationId ? prisma.obligation.findUnique({ where: { id: order.obligationId } }) : null,
  ]);
  const incidentIds = receipts
    .flatMap((r) => r.lines.map((l) => l.incidentId))
    .filter((id): id is string => Boolean(id));
  const incidents = incidentIds.length
    ? await prisma.incident.findMany({
        where: { id: { in: incidentIds }, status: { in: ['open', 'acknowledged'] } },
        select: { id: true, kind: true, severity: true, title: true },
      })
    : [];
  const approvals = Array.isArray(approval?.decisions)
    ? (approval!.decisions as Array<{ decision?: string }>).filter((d) => d?.decision === 'approve')
        .length
    : 0;
  const lineDtos = lines.map((line) =>
    toOrderLineDTO(
      line,
      allocations
        .filter((a) => a.orderLineId === line.id)
        .map((a) => {
          const demand = demands.find((d) => d.id === a.demandId);
          return toAllocationDTO(a, {
            caseId: demand?.caseId ?? null,
            caseNumber: demand ? (cases.get(demand.caseId) ?? null) : null,
            demandName: demand?.name ?? null,
            allocationStatus:
              demandAllocations.find((d) => d.id === a.demandAllocationId)?.status ?? null,
          });
        })
    )
  );
  return {
    ...toOrderDTO(order, lineDtos, { supplierName: supplier?.name ?? null }),
    receipts: receipts.map((r) => toReceiptDTO(r, r.lines)),
    approval: approval
      ? {
          id: approval.id,
          status: approval.status,
          requiredApprovals: approval.requiredApprovals,
          approvals,
          expiresAt: approval.expiresAt?.toISOString() ?? null,
        }
      : null,
    obligation: obligation
      ? {
          id: obligation.id,
          number: obligation.number,
          status: obligation.status,
          expectedAmount: decText(obligation.expectedAmount),
          settledAmount: decText(obligation.settledAmount),
          dueAt: obligation.dueAt?.toISOString() ?? null,
        }
      : null,
    caseIds: [
      ...new Set(
        [order.directDeliveryCaseId, ...demands.map((d) => d.caseId)].filter((id): id is string =>
          Boolean(id)
        )
      ),
    ],
    openIncidents: incidents,
  };
}

export interface ExpectedSupplyRow {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  supplierName: string | null;
  orderLineId: string;
  zohoItemId: string | null;
  description: string;
  unit: string;
  /** Still to arrive from the supplier. Expected, NEVER available stock. */
  expectedQty: string;
  expectedAt: string | null;
  overdue: boolean;
}

/**
 * What committed orders will bring, listed apart from the inventory (expected
 * is never available). `zohoItemIds` reads a whole page of Existencias in one
 * query; `zohoItemId` reads a single article.
 */
export async function listExpectedSupply(
  actor: CurrentUser,
  filters: { zohoItemId?: string | null; zohoItemIds?: readonly string[]; now?: Date } = {}
): Promise<ExpectedSupplyRow[]> {
  if (
    !hasPermission(actor, VIEW) &&
    !hasPermission(actor, 'inventory.view') &&
    !hasPermission(actor, 'operations.view')
  ) {
    throw new AuthorizationError('No tienes permisos para consultar compras');
  }
  const now = filters.now ?? new Date();
  const wanted = filters.zohoItemIds ? [...new Set(filters.zohoItemIds.filter(Boolean))] : null;
  if (wanted && wanted.length === 0) return [];
  const lines = await prisma.procurementOrderLine.findMany({
    where: {
      ...(filters.zohoItemId ? { zohoItemId: filters.zohoItemId } : {}),
      ...(wanted ? { zohoItemId: { in: wanted } } : {}),
      status: { in: ['open', 'partial'] },
      order: { status: { in: [...ORDER_COMMITTED_STATUSES] } },
    },
    include: {
      order: {
        select: { id: true, number: true, status: true, supplierId: true, expectedAt: true },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  const suppliers = await prisma.supplier.findMany({
    where: { id: { in: [...new Set(lines.map((l) => l.order.supplierId))] } },
    select: { id: true, name: true },
  });
  return lines
    .map((line) => ({ line, pending: Math.max(0, num(line.qty) - num(line.qtyAccepted)) }))
    .filter(({ pending }) => pending > 0)
    .map(({ line, pending }) => ({
      orderId: line.order.id,
      orderNumber: line.order.number,
      orderStatus: line.order.status,
      supplierName: suppliers.find((s) => s.id === line.order.supplierId)?.name ?? null,
      orderLineId: line.id,
      zohoItemId: line.zohoItemId,
      description: line.description,
      unit: line.unit,
      expectedQty: decText(pending),
      expectedAt: line.order.expectedAt?.toISOString() ?? null,
      overdue: Boolean(line.order.expectedAt && line.order.expectedAt.getTime() < now.getTime()),
    }));
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function listSuppliers(
  actor: CurrentUser,
  filters: PageInput & {
    search?: string | null;
    status?: string | string[];
    zohoItemId?: string | null;
  } = {}
): Promise<Page<SupplierDTO & { productsCount: number }>> {
  assertAny(actor, [VIEW, 'purchases.manage_suppliers']);
  const { page, pageSize, skip } = normalizePage(filters);
  const search = filters.search?.trim();
  const where: Prisma.SupplierWhereInput = {
    ...(filters.status ? { status: statusFilter(filters.status) } : {}),
    ...(filters.zohoItemId ? { products: { some: { zohoItemId: filters.zohoItemId } } } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { legalName: { contains: search, mode: 'insensitive' } },
            { number: { contains: search, mode: 'insensitive' } },
            { taxRegNo: { contains: search.toUpperCase() } },
            { primaryPhone: { contains: search.replace(/\D/g, '').slice(-8) || search } },
            { products: { some: { description: { contains: search, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.supplier.count({ where }),
    prisma.supplier.findMany({
      where,
      orderBy: [{ ratingOverall: 'desc' }, { name: 'asc' }],
      skip,
      take: pageSize,
      include: { products: { select: { id: true } } },
    }),
  ]);
  return pageOf(
    rows.map((row) => ({ ...toSupplierDTO(row), productsCount: row.products.length })),
    total,
    page,
    pageSize
  );
}

export interface SupplierDetail {
  supplier: SupplierDTO;
  products: SupplierProductDTO[];
  evaluations: SupplierEvaluationDTO[];
  recentOrders: Array<{
    id: string;
    number: string;
    status: string;
    statusLabel: string;
    total: string;
    currency: string;
    createdAt: string;
  }>;
  openOrders: number;
  sourceCandidate: { id: string; name: string } | null;
}

export async function getSupplier(actor: CurrentUser, supplierId: string): Promise<SupplierDetail> {
  assertAny(actor, [VIEW, 'purchases.manage_suppliers']);
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new OperationsError('not_found', 'No se encontró el proveedor');
  const [products, evaluations, orders, openOrders, candidate] = await Promise.all([
    prisma.supplierProduct.findMany({
      where: { supplierId },
      orderBy: [{ lastQuotedAt: 'desc' }, { description: 'asc' }],
      take: 200,
    }),
    prisma.supplierEvaluation.findMany({
      where: { supplierId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.procurementOrder.findMany({
      where: { supplierId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.procurementOrder.count({
      where: { supplierId, status: { in: [...ORDER_OPEN_STATUSES] } },
    }),
    supplier.sourceCandidateId
      ? prisma.sourcingCandidate.findUnique({
          where: { id: supplier.sourceCandidateId },
          select: { id: true, name: true },
        })
      : null,
  ]);
  return {
    supplier: toSupplierDTO(supplier),
    products: products.map(toSupplierProductDTO),
    evaluations: evaluations.map(toSupplierEvaluationDTO),
    recentOrders: orders.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      statusLabel: orderStatusLabel(o.status),
      total: decText(o.total),
      currency: o.currency,
      createdAt: o.createdAt.toISOString(),
    })),
    openOrders,
    sourceCandidate: candidate,
  };
}

// ---------------------------------------------------------------------------
// Sourcing Lab
// ---------------------------------------------------------------------------

export async function listSourcingSearches(
  actor: CurrentUser,
  filters: PageInput & { status?: string | string[]; mine?: boolean } = {}
): Promise<Page<SourcingSearchDTO>> {
  assertAny(actor, [VIEW, 'purchases.sourcing']);
  const { page, pageSize, skip } = normalizePage(filters);
  const where: Prisma.SourcingSearchWhereInput = {
    ...(filters.status ? { status: statusFilter(filters.status) } : {}),
    ...(filters.mine ? { createdByUserId: actor.id } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.sourcingSearch.count({ where }),
    prisma.sourcingSearch.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip,
      take: pageSize,
    }),
  ]);
  return pageOf(rows.map(toSearchDTO), total, page, pageSize);
}

export async function listSourcingCandidates(
  actor: CurrentUser,
  filters: PageInput & {
    searchId?: string | null;
    status?: string | string[];
    search?: string | null;
    excludeKnown?: boolean;
  } = {}
): Promise<Page<SourcingCandidateDTO>> {
  assertAny(actor, [VIEW, 'purchases.sourcing']);
  const { page, pageSize, skip } = normalizePage(filters);
  const search = filters.search?.trim();
  const where: Prisma.SourcingCandidateWhereInput = {
    ...(filters.searchId ? { searchId: filters.searchId } : {}),
    ...(filters.status ? { status: statusFilter(filters.status) } : {}),
    ...(filters.excludeKnown ? { supplierId: null } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { domain: { contains: search, mode: 'insensitive' } },
            { productsSummary: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.sourcingCandidate.count({ where }),
    prisma.sourcingCandidate.findMany({
      where,
      orderBy: [{ confidence: 'desc' }, { updatedAt: 'desc' }],
      skip,
      take: pageSize,
    }),
  ]);
  return pageOf(rows.map(toCandidateDTO), total, page, pageSize);
}

export interface SourcingCandidateDetail extends SourcingCandidateDTO {
  zohoVendor: { zohoContactId: string; name: string | null; reason: string } | null;
  invitations: Array<{ rfqId: string; rfqNumber: string | null; status: string; channel: string }>;
}

export async function getSourcingCandidate(
  actor: CurrentUser,
  candidateId: string
): Promise<SourcingCandidateDetail> {
  assertAny(actor, [VIEW, 'purchases.sourcing']);
  const candidate = await prisma.sourcingCandidate.findUnique({ where: { id: candidateId } });
  if (!candidate) throw new OperationsError('not_found', 'No se encontró el candidato');
  const or: Prisma.ContactWhereInput[] = [];
  if (candidate.domain) or.push({ website: { contains: candidate.domain, mode: 'insensitive' } });
  const digits = candidate.phone?.replace(/\D/g, '').slice(-8);
  if (digits) or.push({ primaryPhone: { contains: digits } }, { mobile: { contains: digits } });
  const firstWord = candidate.name.split(/\s+/)[0];
  if (firstWord && firstWord.length >= 3)
    or.push({ companyName: { contains: firstWord, mode: 'insensitive' } });
  const vendors = or.length
    ? await prisma.contact.findMany({
        where: { contactType: 'vendor', OR: or },
        take: 50,
        select: {
          zohoContactId: true,
          contactName: true,
          companyName: true,
          website: true,
          primaryPhone: true,
          mobile: true,
          primaryEmail: true,
        },
      })
    : [];
  const match = matchVendorContact(candidate, vendors);
  const vendor = match ? vendors.find((v) => v.zohoContactId === match.zohoContactId) : null;
  const invitations = await prisma.rfqInvitation.findMany({
    where: { candidateId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const rfqs = invitations.length
    ? await prisma.rfq.findMany({
        where: { id: { in: invitations.map((i) => i.rfqId) } },
        select: { id: true, number: true },
      })
    : [];
  return {
    ...toCandidateDTO(candidate),
    zohoVendor: match
      ? {
          zohoContactId: match.zohoContactId,
          name: vendor?.companyName ?? vendor?.contactName ?? null,
          reason: match.reason,
        }
      : null,
    invitations: invitations.map((i) => ({
      rfqId: i.rfqId,
      rfqNumber: rfqs.find((r) => r.id === i.rfqId)?.number ?? null,
      status: i.status,
      channel: i.channel,
    })),
  };
}

export { parseChannels as parseSupplierChannels };
