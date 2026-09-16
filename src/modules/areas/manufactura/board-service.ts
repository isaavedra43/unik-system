import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import {
  getProductionBoard,
  type ProductionOrderRow,
} from '@/modules/manufacturing/manufacturing-queries';
import {
  CAPACITY_UNIT_LABELS,
  PRODUCTION_ORDER_OPEN_STATUSES,
  type CapacityUnit,
} from '@/modules/manufacturing/manufacturing-types';
import {
  boardTotals,
  laneForStatus,
  type BoardCard,
  type BoardCenter,
  type BoardPayload,
  type BoardRunningOperation,
  type BoardWindow,
} from './board-model';

/**
 * Read of the production board (plan 7.6). SERVER ONLY.
 *
 * It reuses `getProductionBoard` — the module's own read, which checks
 * `manufacturing.view`, sorts by priority and computes the load of every shift —
 * and re-groups its orders BY WORK CENTRE, which is how the floor reads the
 * board. The only extra queries are the operations of the visible orders (what
 * is running and what is queued) and the names of the operators.
 */

const DEFAULT_DAYS = 3;
const PER_COLUMN = 60;
const UNASSIGNED_NAME = 'Sin centro asignado';

export interface ProductionBoardInput {
  /** Days of shifts shown in the capacity bars (1–14). */
  days?: number;
  /** Single work centre (the mobile board and the deep links use it). */
  workCenterId?: string;
}

interface OperationSummary {
  running: BoardRunningOperation | null;
  pending: number;
}

function clampDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.min(Math.max(Math.trunc(value as number), 1), 14);
}

function toCard(
  order: ProductionOrderRow,
  operations: OperationSummary | undefined
): BoardCard | null {
  const lane = laneForStatus(order.status);
  if (!lane) return null;
  return {
    id: order.id,
    number: order.number,
    title: order.outputName ?? order.outputSku ?? order.outputZohoItemId,
    status: order.status,
    statusLabel: order.statusLabel,
    lane,
    kind: order.kind,
    priority: order.priority,
    workCenterId: order.workCenterId,
    workCenterName: order.workCenterName,
    plannedStartAt: order.plannedStartAt,
    plannedEndAt: order.plannedEndAt,
    plannedQty: order.plannedQty,
    plannedUnit: order.plannedUnit,
    producedQty: order.producedQty,
    scrapQty: order.scrapQty,
    caseId: order.caseId,
    caseNumber: order.caseNumber,
    customerName: null,
    blockedReason: order.blockedReason,
    version: order.version,
    runningOperation: operations?.running ?? null,
    pendingOperations: operations?.pending ?? 0,
  };
}

/** Running and queued operations of the visible orders, in two grouped queries. */
async function loadOperationSummaries(orderIds: string[]): Promise<Map<string, OperationSummary>> {
  const summaries = new Map<string, OperationSummary>();
  if (orderIds.length === 0) return summaries;

  const [running, queued] = await Promise.all([
    prisma.productionOperation.findMany({
      where: { productionOrderId: { in: orderIds }, status: 'running' },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        seq: true,
        name: true,
        startedAt: true,
        assignedUserId: true,
        productionOrderId: true,
      },
    }),
    prisma.productionOperation.groupBy({
      by: ['productionOrderId'],
      where: { productionOrderId: { in: orderIds }, status: { in: ['pending', 'paused'] } },
      _count: { _all: true },
    }),
  ]);

  const operatorIds = [
    ...new Set(
      running.map((operation) => operation.assignedUserId).filter((id): id is string => Boolean(id))
    ),
  ];
  const operators = operatorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: operatorIds } },
        select: { id: true, name: true },
      })
    : [];
  const operatorNames = new Map(operators.map((user) => [user.id, user.name]));

  for (const operation of running) {
    if (summaries.has(operation.productionOrderId)) continue;
    summaries.set(operation.productionOrderId, {
      running: {
        id: operation.id,
        seq: operation.seq,
        name: operation.name,
        startedAt: operation.startedAt?.toISOString() ?? null,
        assignedUserName: operation.assignedUserId
          ? (operatorNames.get(operation.assignedUserId) ?? null)
          : null,
      },
      pending: 0,
    });
  }
  for (const row of queued) {
    const current = summaries.get(row.productionOrderId) ?? { running: null, pending: 0 };
    current.pending = row._count._all;
    summaries.set(row.productionOrderId, current);
  }
  return summaries;
}

export async function loadProductionBoard(
  actor: CurrentUser,
  input: ProductionBoardInput = {}
): Promise<BoardPayload> {
  const days = clampDays(input.days);
  const board = await getProductionBoard(actor, {
    days,
    perColumn: PER_COLUMN,
    ...(input.workCenterId ? { workCenterId: input.workCenterId } : {}),
  });

  // One order can only appear in one status column, but dedupe defensively so a
  // card is never rendered twice with two different drag ids.
  const orders = new Map<string, ProductionOrderRow>();
  for (const column of board.columns) {
    for (const order of column.orders) orders.set(order.id, order);
  }
  const summaries = await loadOperationSummaries([...orders.keys()]);

  const cards: BoardCard[] = [];
  for (const order of orders.values()) {
    const card = toCard(order, summaries.get(order.id));
    if (card) cards.push(card);
  }

  const centers: BoardCenter[] = board.workCenters.map((entry) => {
    const windows: BoardWindow[] = entry.windows.map((window) => ({
      shiftName: window.shiftName,
      day: window.day,
      start: window.start,
      end: window.end,
      capacity: window.capacity,
      load: window.load,
      available: window.available,
      utilizationPct: window.utilizationPct,
      overloaded: window.overloaded,
    }));
    return {
      id: entry.workCenter.id,
      key: entry.workCenter.key,
      name: entry.workCenter.name,
      capacityUnit: entry.workCenter.capacityUnit,
      capacityUnitLabel:
        CAPACITY_UNIT_LABELS[entry.workCenter.capacityUnit as CapacityUnit] ??
        entry.workCenter.capacityUnitLabel,
      capacityPerShift: Number(entry.workCenter.capacityPerShift) || 0,
      status: entry.workCenter.status,
      windows,
      summary: entry.summary,
      cards: cards.filter((card) => card.workCenterId === entry.workCenter.id),
    };
  });

  const unassigned = cards.filter((card) => card.workCenterId === null);
  if (unassigned.length > 0 && !input.workCenterId) {
    centers.unshift({
      id: null,
      key: null,
      name: UNASSIGNED_NAME,
      capacityUnit: 'minutes',
      capacityUnitLabel: CAPACITY_UNIT_LABELS.minutes,
      capacityPerShift: 0,
      status: 'active',
      windows: [],
      summary: null,
      cards: unassigned,
    });
  }

  const truncated = board.columns.some((column) => column.count > column.orders.length);

  return {
    generatedAt: board.generatedAt,
    days,
    centers,
    totals: boardTotals(centers),
    truncated,
  };
}

/** Open orders of one work centre (the "Mover a…" dialog lists the centres, not these). */
export async function countOpenOrdersOfCenter(workCenterId: string): Promise<number> {
  return prisma.productionOrder.count({
    where: { workCenterId, status: { in: [...PRODUCTION_ORDER_OPEN_STATUSES] } },
  });
}
