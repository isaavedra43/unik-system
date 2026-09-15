import type { Prisma, ProductionOrder } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  assertAnyPermission,
  assertPermission,
  hasPermission,
  type CurrentUser,
} from '@/modules/auth/authorization';
import { OperationsError } from '@/modules/operations/errors';
import { summarizeShiftLoads, type LoadSummary, type ShiftLoad } from './capacity-rules';
import { loadWorkCenterLoads } from './capacity-service';
import {
  toBomDTO,
  toConsumptionDTO,
  toOperationDTO,
  toOutputDTO,
  toProductionOrderDTO,
  toQualityCheckDTO,
  toWorkCenterDTO,
  type BomDTO,
  type MaterialConsumptionDTO,
  type ProductionOperationDTO,
  type ProductionOrderDTO,
  type ProductionOutputDTO,
  type QualityCheckDTO,
  type WorkCenterDTO,
} from './manufacturing-dto';
import { addDays, itemLabel, num, productInfo, qtyText, unitsResolver } from './manufacturing-helpers';
import {
  BOM_STATUSES,
  MANUFACTURING_OBJECT_TYPES,
  PRODUCTION_ORDER_KINDS,
  PRODUCTION_ORDER_OPEN_STATUSES,
  PRODUCTION_ORDER_STATUSES,
  PRODUCTION_ORDER_STATUS_LABELS,
  WORK_CENTER_STATUSES,
  type ProductionOrderStatus,
} from './manufacturing-types';
import { loadProductionFacts, releaseFactsOf } from './production-facts';
import {
  allowedOrderActions,
  compareBoardOrders,
  evaluateRelease,
  type ProductionOrderAction,
  type ReleaseEvaluation,
} from './production-state';
import type { MaterialBalance, ScrapApprovalState, ScrapEvaluation } from './scrap-rules';

/**
 * Read side of manufacturing for pages, routes, the floor board and AI tools.
 * Every function takes the session user and checks `manufacturing.view` on the
 * server (traces also accept `inventory.view`); lists are paginated (`page`
 * from 1, `pageSize` ≤ 200) and return JSON-safe DTOs. Reads never create
 * inventory profiles.
 */

const VIEW = 'manufacturing.view';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const idText = z.string().trim().min(1).max(120);

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

export function normalizeManufacturingPage(input: PageInput = {}): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Math.trunc(Number.isFinite(input.page) ? Number(input.page) : 1));
  const size = Math.trunc(Number.isFinite(input.pageSize) ? Number(input.pageSize) : DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(Math.max(size, 1), MAX_PAGE_SIZE);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function pageOf<T>(rows: T[], total: number, page: number, pageSize: number): Page<T> {
  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

function parseFilters<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OperationsError('invalid_payload', `Filtros inválidos: ${issue?.path.join('.') || 'filtros'} ${issue?.message ?? ''}`.trim());
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Actions per actor
// ---------------------------------------------------------------------------

/** Permissions that enable each order action (any of them). */
export const ORDER_ACTION_PERMISSIONS: Record<ProductionOrderAction, readonly string[]> = {
  schedule: ['manufacturing.manage_orders'],
  reserve_materials: ['manufacturing.manage_orders'],
  prepare: ['manufacturing.manage_orders', 'inventory.manage'],
  start_operation: ['manufacturing.operate'],
  pause_operation: ['manufacturing.operate'],
  finish_operation: ['manufacturing.operate'],
  record_consumption: ['manufacturing.operate'],
  inspect: ['manufacturing.inspect'],
  record_finished_output: ['manufacturing.operate'],
  record_other_output: ['manufacturing.operate'],
  request_scrap_review: ['manufacturing.operate', 'manufacturing.manage_orders'],
  release: ['manufacturing.manage_orders'],
  cancel: ['manufacturing.manage_orders'],
};

function mayAny(actor: CurrentUser, keys: readonly string[]): boolean {
  return keys.some((key) => {
    try {
      return hasPermission(actor, key);
    } catch {
      return false;
    }
  });
}

/** Actions the actor may run on an order in `status` (state machine ∩ permissions). */
export function actionsForActor(actor: CurrentUser, status: string): ProductionOrderAction[] {
  return allowedOrderActions(status).filter((action) => mayAny(actor, ORDER_ACTION_PERMISSIONS[action]));
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export const productionOrderFiltersSchema = z.object({
  scope: z.enum(['open', 'closed', 'all']).default('open'),
  status: z.array(z.enum(PRODUCTION_ORDER_STATUSES)).max(PRODUCTION_ORDER_STATUSES.length).optional(),
  kind: z.enum(PRODUCTION_ORDER_KINDS).optional(),
  workCenterId: idText.optional(),
  caseId: idText.optional(),
  outputZohoItemId: idText.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['planned', 'created', 'number']).default('planned'),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});
export type ProductionOrderFilters = z.input<typeof productionOrderFiltersSchema>;

export interface ProductionOrderRow extends ProductionOrderDTO {
  workCenterName: string | null;
  caseNumber: string | null;
  outputSku: string | null;
  allowedActions: ProductionOrderAction[];
}

async function toOrderRows(actor: CurrentUser, orders: readonly ProductionOrder[]): Promise<ProductionOrderRow[]> {
  if (orders.length === 0) return [];
  const centerIds = [...new Set(orders.map((order) => order.workCenterId).filter((id): id is string => Boolean(id)))];
  const caseIds = [...new Set(orders.map((order) => order.caseId).filter((id): id is string => Boolean(id)))];
  const [centers, cases, products] = await Promise.all([
    centerIds.length ? prisma.workCenter.findMany({ where: { id: { in: centerIds } }, select: { id: true, name: true } }) : [],
    caseIds.length ? prisma.operationalCase.findMany({ where: { id: { in: caseIds } }, select: { id: true, caseNumber: true } }) : [],
    productInfo(prisma, orders.map((order) => order.outputZohoItemId)),
  ]);
  const centerNames = new Map(centers.map((center) => [center.id, center.name]));
  const caseNumbers = new Map(cases.map((row) => [row.id, row.caseNumber]));
  return orders.map((order) => ({
    ...toProductionOrderDTO(order),
    outputName: order.outputName ?? products.get(order.outputZohoItemId)?.name ?? null,
    workCenterName: order.workCenterId ? (centerNames.get(order.workCenterId) ?? null) : null,
    caseNumber: order.caseId ? (caseNumbers.get(order.caseId) ?? null) : null,
    outputSku: products.get(order.outputZohoItemId)?.sku ?? null,
    allowedActions: actionsForActor(actor, order.status),
  }));
}

export async function listProductionOrders(
  actor: CurrentUser,
  filters: ProductionOrderFilters = {}
): Promise<Page<ProductionOrderRow>> {
  assertPermission(actor, VIEW);
  const input = parseFilters(productionOrderFiltersSchema, filters);
  const where: Prisma.ProductionOrderWhereInput = {};
  if (input.status && input.status.length > 0) where.status = { in: input.status };
  else if (input.scope === 'open') where.status = { in: [...PRODUCTION_ORDER_OPEN_STATUSES] };
  else if (input.scope === 'closed') where.status = { in: ['released', 'cancelled'] };
  if (input.kind) where.kind = input.kind;
  if (input.workCenterId) where.workCenterId = input.workCenterId;
  if (input.caseId) where.caseId = input.caseId;
  if (input.outputZohoItemId) where.outputZohoItemId = input.outputZohoItemId;
  if (input.q) {
    where.OR = [
      { number: { contains: input.q, mode: 'insensitive' } },
      { outputName: { contains: input.q, mode: 'insensitive' } },
      { outputZohoItemId: input.q },
    ];
  }
  const orderBy: Prisma.ProductionOrderOrderByWithRelationInput[] =
    input.sort === 'created'
      ? [{ createdAt: 'desc' }, { id: 'desc' }]
      : input.sort === 'number'
        ? [{ number: 'desc' }]
        : [{ plannedStartAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }];
  const { page, pageSize, skip } = normalizeManufacturingPage(input);
  const [total, orders] = await Promise.all([
    prisma.productionOrder.count({ where }),
    prisma.productionOrder.findMany({ where, orderBy, skip, take: pageSize }),
  ]);
  return pageOf(await toOrderRows(actor, orders), total, page, pageSize);
}

export interface MaterialStatusRow {
  zohoItemId: string;
  label: string;
  baseUnit: string;
  required: string;
  assigned: string;
  held: string;
  consumed: string;
  leftover: string;
  scrap: string;
  substitutes: string[];
}

export interface ProductionOrderDetail {
  order: ProductionOrderRow;
  operations: ProductionOperationDTO[];
  consumptions: MaterialConsumptionDTO[];
  outputs: ProductionOutputDTO[];
  qualityChecks: QualityCheckDTO[];
  materials: MaterialStatusRow[];
  scrap: ScrapEvaluation;
  scrapApproval: ScrapApprovalState;
  scrapApprovalRequestId: string | null;
  balance: MaterialBalance;
  release: ReleaseEvaluation;
  pendingSubstitutionIds: string[];
  requests: Array<{ id: string; kind: string; status: string; title: string; toAreaKey: string; createdAt: string }>;
  workCenter: WorkCenterDTO | null;
  bom: BomDTO | null;
  case: { id: string; caseNumber: string; salesOrderNumber: string | null; customerName: string | null; status: string } | null;
}

export async function getProductionOrderDetail(actor: CurrentUser, productionOrderId: string): Promise<ProductionOrderDetail> {
  assertPermission(actor, VIEW);
  const order = await prisma.productionOrder.findUnique({ where: { id: productionOrderId } });
  if (!order) throw new OperationsError('not_found', 'No se encontró la orden de producción');
  const facts = await loadProductionFacts(prisma, order, unitsResolver(prisma, 'read'));
  const [rows, center, bom, opCase, requests] = await Promise.all([
    toOrderRows(actor, [order]),
    order.workCenterId ? prisma.workCenter.findUnique({ where: { id: order.workCenterId } }) : null,
    order.bomId ? prisma.bom.findUnique({ where: { id: order.bomId }, include: { lines: true, operations: true } }) : null,
    order.caseId
      ? prisma.operationalCase.findUnique({
          where: { id: order.caseId },
          select: { id: true, caseNumber: true, salesOrderNumber: true, customerName: true, status: true },
        })
      : null,
    prisma.areaRequest.findMany({
      where: { objectType: MANUFACTURING_OBJECT_TYPES.productionOrder, objectId: order.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { id: true, kind: true, status: true, title: true, toAreaKey: true, createdAt: true },
    }),
  ]);
  const products = await productInfo(prisma, facts.requirements.map((line) => line.zohoItemId));
  return {
    order: rows[0],
    operations: facts.operations.map(toOperationDTO),
    consumptions: facts.consumptions.map(toConsumptionDTO),
    outputs: facts.outputs.map(toOutputDTO),
    qualityChecks: facts.checks.map(toQualityCheckDTO),
    materials: facts.requirements.map((line) => ({
      zohoItemId: line.zohoItemId,
      label: itemLabel(products, line.zohoItemId),
      baseUnit: line.baseUnit,
      required: qtyText(line.requiredBase),
      assigned: qtyText(facts.assignedByItem[line.zohoItemId] ?? 0),
      held: qtyText(facts.heldByItem[line.zohoItemId] ?? 0),
      consumed: qtyText(facts.consumedByItem[line.zohoItemId] ?? 0),
      leftover: qtyText(facts.leftoverByItem[line.zohoItemId] ?? 0),
      scrap: qtyText(facts.scrapByItem[line.zohoItemId] ?? 0),
      substitutes: line.substitutes,
    })),
    scrap: facts.scrap,
    scrapApproval: facts.scrapApproval,
    scrapApprovalRequestId: facts.scrapApprovals.at(-1)?.id ?? null,
    balance: facts.balance,
    release: evaluateRelease(releaseFactsOf(facts)),
    pendingSubstitutionIds: facts.pendingSubstitutionIds,
    requests: requests.map((request) => ({ ...request, createdAt: request.createdAt.toISOString() })),
    workCenter: center ? toWorkCenterDTO(center) : null,
    bom: bom ? toBomDTO(bom) : null,
    case: opCase,
  };
}

// ---------------------------------------------------------------------------
// Floor board and load per shift
// ---------------------------------------------------------------------------

export interface ShiftLoadDTO {
  shiftName: string;
  day: string;
  start: string;
  end: string;
  capacity: number;
  load: number;
  available: number;
  utilizationPct: number;
  overloaded: boolean;
  operationIds: string[];
}

export function toShiftLoadDTO(load: ShiftLoad): ShiftLoadDTO {
  return {
    shiftName: load.shiftName,
    day: load.day,
    start: load.start.toISOString(),
    end: load.end.toISOString(),
    capacity: load.capacity,
    load: load.load,
    available: load.available,
    utilizationPct: load.utilizationPct,
    overloaded: load.overloaded,
    operationIds: [...load.itemIds],
  };
}

/** Board columns in flow order (blocked first: it needs someone). */
export const BOARD_STATUSES: readonly ProductionOrderStatus[] = [
  'blocked',
  'draft',
  'reserved',
  'prepared',
  'in_progress',
  'inspection',
  'completed',
];

export const productionBoardInputSchema = z.object({
  workCenterId: idText.optional(),
  days: z.number().int().min(1).max(14).default(3),
  perColumn: z.number().int().min(1).max(100).default(20),
});
export type ProductionBoardInput = z.input<typeof productionBoardInputSchema>;

export interface ProductionBoard {
  generatedAt: string;
  columns: Array<{ status: ProductionOrderStatus; label: string; count: number; orders: ProductionOrderRow[] }>;
  workCenters: Array<{
    workCenter: WorkCenterDTO;
    running: Array<{ operationId: string; productionOrderId: string; number: string; name: string; startedAt: string | null; assignedUserId: string | null }>;
    queued: number;
    windows: ShiftLoadDTO[];
    summary: LoadSummary;
  }>;
}

export async function getProductionBoard(
  actor: CurrentUser,
  input: ProductionBoardInput = {},
  options: { now?: Date } = {}
): Promise<ProductionBoard> {
  assertPermission(actor, VIEW);
  const parsed = parseFilters(productionBoardInputSchema, input);
  const now = options.now ?? new Date();
  const where: Prisma.ProductionOrderWhereInput = {
    status: { in: [...BOARD_STATUSES] },
    ...(parsed.workCenterId ? { workCenterId: parsed.workCenterId } : {}),
  };
  const [grouped, orders, centers] = await Promise.all([
    prisma.productionOrder.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.productionOrder.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 }),
    prisma.workCenter.findMany({
      where: { status: 'active', ...(parsed.workCenterId ? { id: parsed.workCenterId } : {}) },
      orderBy: [{ key: 'asc' }],
    }),
  ]);
  const counts = new Map(grouped.map((row) => [row.status, row._count._all]));
  const sorted = [...orders].sort(compareBoardOrders);
  const rows = await toOrderRows(actor, sorted);
  const columns = BOARD_STATUSES.map((status) => ({
    status,
    label: PRODUCTION_ORDER_STATUS_LABELS[status],
    count: counts.get(status) ?? 0,
    orders: rows.filter((row) => row.status === status).slice(0, parsed.perColumn),
  }));
  const centerIds = centers.map((center) => center.id);
  const [running, queued] = await Promise.all([
    centerIds.length
      ? prisma.productionOperation.findMany({
          where: { status: 'running', workCenterId: { in: centerIds } },
          include: { productionOrder: { select: { id: true, number: true } } },
          orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        })
      : [],
    centerIds.length
      ? prisma.productionOperation.groupBy({
          by: ['workCenterId'],
          where: {
            status: { in: ['pending', 'paused'] },
            workCenterId: { in: centerIds },
            productionOrder: { status: { in: [...PRODUCTION_ORDER_OPEN_STATUSES] } },
          },
          _count: { _all: true },
        })
      : [],
  ]);
  const queuedByCenter = new Map(queued.map((row) => [row.workCenterId, row._count._all]));
  const workCenters: ProductionBoard['workCenters'] = [];
  for (const center of centers) {
    const { loads } = await loadWorkCenterLoads(prisma, center, now, addDays(now, parsed.days));
    workCenters.push({
      workCenter: toWorkCenterDTO(center),
      running: running
        .filter((op) => op.workCenterId === center.id)
        .map((op) => ({
          operationId: op.id,
          productionOrderId: op.productionOrderId,
          number: (op as typeof op & { productionOrder?: { number: string } | null }).productionOrder?.number ?? '',
          name: op.name,
          startedAt: op.startedAt?.toISOString() ?? null,
          assignedUserId: op.assignedUserId,
        })),
      queued: queuedByCenter.get(center.id) ?? 0,
      windows: loads.map(toShiftLoadDTO),
      summary: summarizeShiftLoads(loads),
    });
  }
  return { generatedAt: now.toISOString(), columns, workCenters };
}

export const workCenterLoadInputSchema = z.object({
  workCenterId: idText,
  from: z.string().trim().min(10).max(40).refine((value) => !Number.isNaN(Date.parse(value)), 'Fecha inválida').optional(),
  days: z.number().int().min(1).max(31).default(7),
});
export type WorkCenterLoadInput = z.input<typeof workCenterLoadInputSchema>;

export async function getWorkCenterLoad(
  actor: CurrentUser,
  input: WorkCenterLoadInput,
  options: { now?: Date } = {}
): Promise<{
  workCenter: WorkCenterDTO;
  windows: ShiftLoadDTO[];
  summary: LoadSummary;
  operations: Array<{ operationId: string; productionOrderId: string; number: string; name: string; status: string; plannedStartAt: string; plannedMinutes: number | null; load: number }>;
}> {
  assertPermission(actor, VIEW);
  const parsed = parseFilters(workCenterLoadInputSchema, input);
  const center = await prisma.workCenter.findUnique({ where: { id: parsed.workCenterId } });
  if (!center) throw new OperationsError('not_found', 'No se encontró el centro de trabajo');
  const from = parsed.from ? new Date(parsed.from) : (options.now ?? new Date());
  const { loads, operations } = await loadWorkCenterLoads(prisma, center, from, addDays(from, parsed.days));
  return {
    workCenter: toWorkCenterDTO(center),
    windows: loads.map(toShiftLoadDTO),
    summary: summarizeShiftLoads(loads),
    operations: operations.map((op) => ({ ...op, plannedStartAt: op.plannedStartAt.toISOString() })),
  };
}

// ---------------------------------------------------------------------------
// Work centers and BOMs
// ---------------------------------------------------------------------------

export interface WorkCenterRow extends WorkCenterDTO {
  warehouseName: string | null;
}

export async function listWorkCenters(
  actor: CurrentUser,
  filters: { status?: (typeof WORK_CENTER_STATUSES)[number] } = {}
): Promise<WorkCenterRow[]> {
  assertPermission(actor, VIEW);
  const status = filters.status && (WORK_CENTER_STATUSES as readonly string[]).includes(filters.status) ? filters.status : undefined;
  const centers = await prisma.workCenter.findMany({
    where: status ? { status } : {},
    orderBy: [{ status: 'asc' }, { key: 'asc' }],
  });
  const warehouseIds = [...new Set(centers.map((center) => center.warehouseId).filter((id): id is string => Boolean(id)))];
  const warehouses = warehouseIds.length
    ? await prisma.warehouse.findMany({ where: { id: { in: warehouseIds } }, select: { id: true, name: true } })
    : [];
  const names = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse.name]));
  return centers.map((center) => ({
    ...toWorkCenterDTO(center),
    warehouseName: center.warehouseId ? (names.get(center.warehouseId) ?? null) : null,
  }));
}

export const bomFiltersSchema = z.object({
  status: z.enum(BOM_STATUSES).optional(),
  outputZohoItemId: idText.optional(),
  q: z.string().trim().max(100).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
});
export type BomFilters = z.input<typeof bomFiltersSchema>;

export interface BomRow extends BomDTO {
  outputName: string | null;
  outputSku: string | null;
}

export async function listBoms(actor: CurrentUser, filters: BomFilters = {}): Promise<Page<BomRow>> {
  assertPermission(actor, VIEW);
  const input = parseFilters(bomFiltersSchema, filters);
  const where: Prisma.BomWhereInput = {};
  if (input.status) where.status = input.status;
  if (input.outputZohoItemId) where.outputZohoItemId = input.outputZohoItemId;
  if (input.q) {
    const matches = await prisma.product.findMany({
      where: { OR: [{ name: { contains: input.q, mode: 'insensitive' } }, { sku: { contains: input.q, mode: 'insensitive' } }] },
      select: { zohoItemId: true },
      take: 200,
    });
    where.outputZohoItemId = { in: [...new Set([input.q, ...matches.map((row) => row.zohoItemId)])] };
  }
  const { page, pageSize, skip } = normalizeManufacturingPage(input);
  const [total, boms] = await Promise.all([
    prisma.bom.count({ where }),
    prisma.bom.findMany({
      where,
      orderBy: [{ outputZohoItemId: 'asc' }, { version: 'desc' }],
      skip,
      take: pageSize,
      include: { lines: true, operations: true },
    }),
  ]);
  const products = await productInfo(prisma, boms.map((bom) => bom.outputZohoItemId));
  return pageOf(
    boms.map((bom) => ({
      ...toBomDTO(bom),
      outputName: products.get(bom.outputZohoItemId)?.name ?? null,
      outputSku: products.get(bom.outputZohoItemId)?.sku ?? null,
    })),
    total,
    page,
    pageSize
  );
}

export interface BomDetail extends BomRow {
  lineLabels: Record<string, string>;
  workCenterNames: Record<string, string>;
  openOrders: number;
}

export async function getBomDetail(actor: CurrentUser, bomId: string): Promise<BomDetail> {
  assertPermission(actor, VIEW);
  const bom = await prisma.bom.findUnique({ where: { id: bomId }, include: { lines: true, operations: true } });
  if (!bom) throw new OperationsError('not_found', 'No se encontró la lista de materiales');
  const itemIds = [
    bom.outputZohoItemId,
    ...bom.lines.flatMap((line) => [line.inputZohoItemId, ...line.substituteZohoItemIds]),
  ];
  const centerIds = [...new Set(bom.operations.map((op) => op.workCenterId))];
  const [products, centers, openOrders] = await Promise.all([
    productInfo(prisma, itemIds),
    centerIds.length ? prisma.workCenter.findMany({ where: { id: { in: centerIds } }, select: { id: true, name: true } }) : [],
    prisma.productionOrder.count({ where: { bomId: bom.id, status: { in: [...PRODUCTION_ORDER_OPEN_STATUSES] } } }),
  ]);
  return {
    ...toBomDTO(bom),
    outputName: products.get(bom.outputZohoItemId)?.name ?? null,
    outputSku: products.get(bom.outputZohoItemId)?.sku ?? null,
    lineLabels: Object.fromEntries([...new Set(itemIds)].map((id) => [id, itemLabel(products, id)])),
    workCenterNames: Object.fromEntries(centers.map((center) => [center.id, center.name])),
    openOrders,
  };
}

// ---------------------------------------------------------------------------
// Traceability
// ---------------------------------------------------------------------------

export interface ProductionTrace {
  order: {
    id: string;
    number: string;
    status: string;
    outputZohoItemId: string;
    caseId: string | null;
    caseNumber: string | null;
    salesOrderNumber: string | null;
    customerName: string | null;
    demandId: string | null;
    allocationId: string | null;
  };
  materials: Array<{
    consumptionId: string;
    kind: string;
    zohoItemId: string;
    label: string;
    quantity: string;
    unit: string;
    substitutedForZohoItemId: string | null;
    stockItemId: string | null;
    warehouseId: string | null;
    containerKey: string | null;
    movementId: string;
    occurredAt: string | null;
  }>;
  outputs: Array<{
    outputId: string;
    kind: string;
    zohoItemId: string;
    label: string;
    quantity: string;
    unit: string;
    stockItemId: string | null;
    containerKey: string | null;
    locationId: string | null;
    movementId: string | null;
    dimensions: Record<string, unknown> | null;
  }>;
  reservations: Array<{ id: string; demandId: string; allocationId: string | null; quantity: string; status: string }>;
}

/** Raw materials, outputs and sale of a production order. */
export async function getProductionTrace(actor: CurrentUser, productionOrderId: string): Promise<ProductionTrace> {
  assertAnyPermission(actor, [VIEW, 'inventory.view']);
  const order = await prisma.productionOrder.findUnique({ where: { id: productionOrderId } });
  if (!order) throw new OperationsError('not_found', 'No se encontró la orden de producción');
  const [consumptions, outputs, opCase, reservations] = await Promise.all([
    prisma.materialConsumption.findMany({
      where: { productionOrderId: order.id, kind: { in: ['actual', 'substitution'] }, stockMovementId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.productionOutput.findMany({ where: { productionOrderId: order.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    order.caseId
      ? prisma.operationalCase.findUnique({
          where: { id: order.caseId },
          select: { caseNumber: true, salesOrderNumber: true, customerName: true },
        })
      : null,
    order.demandAllocationId
      ? prisma.stockReservation.findMany({ where: { allocationId: order.demandAllocationId }, orderBy: { createdAt: 'asc' } })
      : [],
  ]);
  const movementIds = [
    ...consumptions.map((row) => row.stockMovementId as string),
    ...outputs.map((row) => row.stockMovementId).filter((id): id is string => Boolean(id)),
  ];
  const stockIds = [
    ...consumptions.map((row) => row.stockItemId),
    ...outputs.map((row) => row.stockItemId),
  ].filter((id): id is string => Boolean(id));
  const [movements, stocks, products] = await Promise.all([
    movementIds.length ? prisma.stockMovement.findMany({ where: { id: { in: movementIds } }, select: { id: true, occurredAt: true, warehouseId: true } }) : [],
    stockIds.length ? prisma.stockItem.findMany({ where: { id: { in: stockIds } }, select: { id: true, containerKey: true, warehouseId: true } }) : [],
    productInfo(prisma, [...consumptions.map((row) => row.inputZohoItemId), ...outputs.map((row) => row.zohoItemId)]),
  ]);
  const movementById = new Map(movements.map((movement) => [movement.id, movement]));
  const stockById = new Map(stocks.map((stock) => [stock.id, stock]));
  return {
    order: {
      id: order.id,
      number: order.number,
      status: order.status,
      outputZohoItemId: order.outputZohoItemId,
      caseId: order.caseId,
      caseNumber: opCase?.caseNumber ?? null,
      salesOrderNumber: opCase?.salesOrderNumber ?? null,
      customerName: opCase?.customerName ?? null,
      demandId: order.demandId,
      allocationId: order.demandAllocationId,
    },
    materials: consumptions.map((row) => {
      const stock = row.stockItemId ? stockById.get(row.stockItemId) : undefined;
      const movement = movementById.get(row.stockMovementId as string);
      return {
        consumptionId: row.id,
        kind: row.kind,
        zohoItemId: row.inputZohoItemId,
        label: itemLabel(products, row.inputZohoItemId),
        quantity: qtyText(row.qtyActual),
        unit: row.unit,
        substitutedForZohoItemId: row.substitutedForZohoItemId,
        stockItemId: row.stockItemId,
        warehouseId: stock?.warehouseId ?? movement?.warehouseId ?? null,
        containerKey: stock?.containerKey || null,
        movementId: row.stockMovementId as string,
        occurredAt: movement?.occurredAt.toISOString() ?? null,
      };
    }),
    outputs: outputs.map((row) => ({
      outputId: row.id,
      kind: row.kind,
      zohoItemId: row.zohoItemId,
      label: itemLabel(products, row.zohoItemId),
      quantity: qtyText(row.qty),
      unit: row.unit,
      stockItemId: row.stockItemId,
      containerKey: row.stockItemId ? stockById.get(row.stockItemId)?.containerKey || null : null,
      locationId: row.locationId,
      movementId: row.stockMovementId,
      dimensions: toOutputDTO(row).dimensions,
    })),
    reservations: reservations.map((row) => ({
      id: row.id,
      demandId: row.demandId,
      allocationId: row.allocationId,
      quantity: qtyText(row.quantity),
      status: row.status,
    })),
  };
}

/** From a stock row (finished good or leftover container) back to its production order and materials. */
export async function traceStockItem(
  actor: CurrentUser,
  stockItemId: string
): Promise<{
  stockItem: { id: string; zohoItemId: string; warehouseId: string; containerKey: string; originProductionOrderId: string | null };
  /** Every production order that produced into this row (latest first), with its quantity. */
  productions: Array<{ productionOrderId: string; number: string | null; quantity: string; lastProducedAt: string }>;
  /** Trace of the latest producing order (the row groups output of several orders). */
  production: ProductionTrace | null;
}> {
  assertAnyPermission(actor, [VIEW, 'inventory.view']);
  const stock = await prisma.stockItem.findUnique({ where: { id: stockItemId } });
  if (!stock) throw new OperationsError('not_found', 'No se encontró la existencia');
  const movements = await prisma.stockMovement.findMany({
    where: { stockItemId: stock.id, kind: 'produce', referenceType: 'production_order', referenceId: { not: null } },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    select: { referenceId: true, quantity: true, occurredAt: true },
    take: 500,
  });
  const byOrder = new Map<string, { quantity: number; lastProducedAt: Date }>();
  for (const movement of movements) {
    const id = movement.referenceId as string;
    const current = byOrder.get(id);
    byOrder.set(id, {
      quantity: (current?.quantity ?? 0) + num(movement.quantity),
      lastProducedAt: current?.lastProducedAt ?? movement.occurredAt,
    });
  }
  const orders = byOrder.size
    ? await prisma.productionOrder.findMany({ where: { id: { in: [...byOrder.keys()] } }, select: { id: true, number: true } })
    : [];
  const productions = [...byOrder.entries()].map(([productionOrderId, value]) => ({
    productionOrderId,
    number: orders.find((order) => order.id === productionOrderId)?.number ?? null,
    quantity: qtyText(value.quantity),
    lastProducedAt: value.lastProducedAt.toISOString(),
  }));
  const orderId = productions[0]?.productionOrderId ?? stock.originProductionOrderId;
  return {
    productions,
    stockItem: {
      id: stock.id,
      zohoItemId: stock.zohoItemId,
      warehouseId: stock.warehouseId,
      containerKey: stock.containerKey,
      originProductionOrderId: stock.originProductionOrderId,
    },
    production: orderId ? await getProductionTrace(actor, orderId) : null,
  };
}
