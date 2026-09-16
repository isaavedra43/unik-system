import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  caseNextAction,
  caseProgress,
  caseRisk,
  ALLOCATION_LINK_LABELS,
  CASE_RISK_LABELS,
  ALLOCATION_STATUS_LABELS,
  DEMAND_STATUS_LABELS,
  STEP_STATUS_LABELS,
  type CaseRequestView,
  type CaseStepView,
  type CaseTimelineEntry,
  type CaseWorkItemView,
} from '@/components/operations/case/case-model';
import type {
  CaseDeliveryOrderView,
  CaseDemandView,
  CaseEvidenceView,
  CaseHeaderView,
  CaseIncidentView,
  CaseViewData,
} from '@/components/operations/case/case-view';
import { evidenceLabel } from '@/components/operations/mywork-model';
import { getSalesOrderStatusLabel } from '@/modules/sales/sales-orders-helpers';
import { formatTimelineLine } from '@/modules/agents/templates';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { CONFIDENCE_LABELS, isConfidenceLevel } from '@/modules/inventory/inventory-types';
import {
  DELIVERY_MODE_LABELS,
  DELIVERY_ORDER_STATUS_LABELS,
  TRIP_STATUS_LABELS,
} from '@/modules/logistics/types';
import { ZOHO_SYNC_STATE_LABELS } from '@/modules/logistics/zoho-sync-state';
import { authorizeOperationsChannel, listCaseEvents } from '@/modules/operations/events-service';
import {
  findStepDef,
  loadProcessBlueprint,
} from '@/modules/operations/process-blueprints/registry';
import type { ProcessBlueprint } from '@/modules/operations/process-blueprints/types';
import { AREA_REQUEST_KIND_CATALOG } from '@/modules/operations/request-kinds';
import {
  AI_TURN_EVENT_TYPES,
  ALLOCATION_SOURCE_LABELS,
  AREA_LABELS,
  AREA_REQUEST_OPEN_STATUSES,
  AREA_REQUEST_STATUS_LABELS,
  CASE_PHASE_LABELS,
  CASE_STATUS_LABELS,
  INCIDENT_KIND_LABELS,
  INCIDENT_OPEN_STATUSES,
  INCIDENT_SEVERITY_LABELS,
  PRIORITY_LABELS,
  WORK_ITEM_KIND_LABELS,
  WORK_ITEM_OPEN_STATUSES,
  isAreaKey,
} from '@/modules/operations/types';
import {
  missingEvidenceForWorkItems,
  toWorkItemDTOs,
  workItemPermissions,
} from '@/modules/operations/work-items-service';

/**
 * Server loader of the Expediente 360 (plan 2.7): it reads the case with the
 * services and models of the core and hands the client components the
 * serialized view of `case-view.ts`. No business rule lives here — it only
 * reads, resolves names and applies the access rules.
 *
 * ACCESS: every entry point goes through `authorizeOperationsChannel('case')`
 * (`operations.admin`, the case owner, an owner/backup of one of its work
 * items or a member of its room). `operations.view` alone never opens every
 * case, so the list and the detail do not share the same rule on purpose.
 *
 * Secondary blocks (delivery, evidence, timeline…) are loaded with `settle`:
 * one of them failing turns into a notice, never into a broken page.
 */

const TIMELINE_PAGE = 60;
const REQUEST_LIMIT = 60;
const INCIDENT_LIMIT = 40;
const EVIDENCE_LIMIT = 50;
const WORK_ITEM_LIMIT = 100;

const OPEN_STEP_STATUSES = new Set(['pending', 'ready', 'active', 'waiting']);

export type CaseLoadResult =
  { ok: true; view: CaseViewData } | { ok: false; reason: 'not_found' | 'forbidden' };

/** What `loadProcessBlueprint` returns for the case's stored process version. */
type LoadedBlueprint = {
  version: { processKey: string; version: number };
  blueprint: ProcessBlueprint;
};

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ component: 'operations-case-page', event, ...extra }));
}

/** A secondary block that fails becomes a notice instead of breaking the page. */
async function settle<T>(
  promise: Promise<T>,
  fallback: T,
  label: string
): Promise<{ value: T; warning: string | null }> {
  try {
    return { value: await promise, warning: null };
  } catch (err) {
    log('block_failed', { part: label, message: err instanceof Error ? err.message : String(err) });
    return {
      value: fallback,
      warning: `No se pudo cargar ${label}. Recarga la página para intentarlo de nuevo.`,
    };
  }
}

function decimalText(value: Prisma.Decimal | number | string): string {
  const text = typeof value === 'object' ? value.toString() : String(value);
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

function areaLabelOf(areaKey: string | null): string | null {
  return areaKey && isAreaKey(areaKey) ? AREA_LABELS[areaKey] : areaKey;
}

function labelOf(map: Readonly<Record<string, string>>, value: string): string {
  return map[value] ?? value;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** True when this person may open this case (same rule as the `case:{id}` channel). */
export async function canOpenCase(user: CurrentUser, caseId: string): Promise<boolean> {
  return authorizeOperationsChannel(user, 'case', caseId);
}

// ---------------------------------------------------------------------------
// Full view
// ---------------------------------------------------------------------------

export async function loadCaseView(
  user: CurrentUser,
  caseId: string,
  options: { now?: Date } = {}
): Promise<CaseLoadResult> {
  const now = options.now ?? new Date();
  const operationalCase = await prisma.operationalCase.findUnique({ where: { id: caseId } });
  if (!operationalCase) return { ok: false, reason: 'not_found' };
  if (!(await canOpenCase(user, caseId))) return { ok: false, reason: 'forbidden' };

  const warnings: string[] = [];
  const push = (warning: string | null) => {
    if (warning) warnings.push(warning);
  };

  const [demandRows, allocationRows, stepRows, requestRows] = await Promise.all([
    prisma.caseDemand.findMany({
      where: { caseId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.demandAllocation.findMany({
      where: { caseId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.caseStep.findMany({ where: { caseId } }),
    prisma.areaRequest.findMany({
      where: { caseId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: REQUEST_LIMIT,
    }),
  ]);

  const [workItems, incidents, delivery, evidence, timeline, blueprint, confidence] =
    await Promise.all([
      settle(loadWorkItems(user, caseId, now), [] as CaseWorkItemView[], 'los trabajos abiertos'),
      settle(loadIncidents(caseId), [] as CaseIncidentView[], 'las incidencias'),
      settle(loadDelivery(user, caseId), [] as CaseDeliveryOrderView[], 'la entrega'),
      settle(loadEvidence(caseId), [] as CaseEvidenceView[], 'las evidencias'),
      settle(
        loadTimeline(caseId, operationalCase, now, {}),
        { entries: [] as CaseTimelineEntry[], olderCursor: null as string | null },
        'la cronología'
      ),
      settle<LoadedBlueprint | null>(
        loadProcessBlueprint(prisma, operationalCase.processVersionId),
        null,
        'la definición del proceso'
      ),
      settle(
        loadConfidence(user, demandRows),
        new Map<string, { level: string; lastCountAt: Date | null }>(),
        'la confianza de inventario'
      ),
    ]);
  push(workItems.warning);
  push(incidents.warning);
  push(delivery.warning);
  push(evidence.warning);
  push(timeline.warning);
  push(blueprint.warning);
  push(confidence.warning);

  const definition = blueprint.value?.blueprint ?? null;
  const process = blueprint.value
    ? `${blueprint.value.version.processKey}@${blueprint.value.version.version}`
    : operationalCase.processVersionId;

  const demandById = new Map(demandRows.map((demand) => [demand.id, demand]));
  const allocationById = new Map(allocationRows.map((allocation) => [allocation.id, allocation]));
  const warehouseIds = [
    ...new Set(
      allocationRows
        .map((allocation) => allocation.warehouseId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const requestOwnerIds = [...new Set(requestRows.map((request) => request.ownerUserId))];
  const [warehouses, requestOwners] = await Promise.all([
    warehouseIds.length
      ? prisma.warehouse.findMany({
          where: { id: { in: warehouseIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    requestOwnerIds.length
      ? prisma.user.findMany({
          where: { id: { in: requestOwnerIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const warehouseNames = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse.name]));

  const steps = mapSteps(stepRows, definition, demandById, allocationById, now);
  const requests = mapRequests(
    requestRows,
    now,
    new Map(requestOwners.map((owner) => [owner.id, owner.name]))
  );
  const demands = mapDemands(demandRows, allocationRows, warehouseNames, confidence.value);

  const progress = caseProgress(steps, CASE_PHASE_LABELS, operationalCase.phase);
  const next = caseNextAction({ workItems: workItems.value, requests, steps });

  const openIncidents = incidents.value.filter((incident) => incident.open).length;
  const risk = caseRisk(
    {
      status: operationalCase.status,
      promisedAt: operationalCase.promisedAt?.toISOString() ?? null,
      overdueWorkItems: workItems.value.filter((item) => item.overdue).length,
      openIncidents,
      blockingRequests: requests.filter((request) => request.open && request.blocksDelivery).length,
    },
    now
  );

  const header = await buildHeader(user, operationalCase, { process, risk });

  const activityAt =
    timeline.value.entries[0]?.occurredAt ?? operationalCase.lastActivityAt.toISOString();

  return {
    ok: true,
    view: {
      header,
      progress,
      next,
      steps,
      workItems: workItems.value,
      requests,
      incidents: incidents.value,
      demands,
      delivery: delivery.value,
      evidence: evidence.value,
      timeline: timeline.value.entries,
      timelineCursor: timeline.value.olderCursor,
      activityAt,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

type CaseRecord = Awaited<ReturnType<typeof prisma.operationalCase.findUnique>>;

async function buildHeader(
  user: CurrentUser,
  operationalCase: NonNullable<CaseRecord>,
  extra: { process: string; risk: CaseHeaderView['risk'] }
): Promise<CaseHeaderView> {
  const [owner, salesOrder, chatMember] = await Promise.all([
    prisma.user.findUnique({
      where: { id: operationalCase.ownerUserId },
      select: { name: true },
    }),
    operationalCase.zohoSalesOrderId && hasPermission(user, 'sales_orders.view')
      ? prisma.salesOrder.findUnique({
          where: { zohoSalesOrderId: operationalCase.zohoSalesOrderId },
          select: { id: true, status: true, salesOrderNumber: true },
        })
      : Promise.resolve(null),
    operationalCase.chatChannelId
      ? prisma.internalChatMember.findFirst({
          where: { channelId: operationalCase.chatChannelId, userId: user.id, leftAt: null },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    id: operationalCase.id,
    caseNumber: operationalCase.caseNumber,
    status: operationalCase.status,
    statusLabel: labelOf(CASE_STATUS_LABELS, operationalCase.status),
    phase: operationalCase.phase,
    phaseLabel: labelOf(CASE_PHASE_LABELS, operationalCase.phase),
    priority: operationalCase.priority,
    priorityLabel: labelOf(PRIORITY_LABELS, operationalCase.priority),
    customerName: operationalCase.customerName,
    salesOrderNumber: operationalCase.salesOrderNumber,
    zohoSalesOrderId: operationalCase.zohoSalesOrderId,
    salesOrderHref: salesOrder ? `/app/sales/orders/${salesOrder.id}` : null,
    // Zoho guarda el estado en inglés: se traduce con el mismo mapa que usa
    // /app/sales/orders, nunca se pinta el valor crudo («draft»).
    salesOrderStatus: salesOrder?.status ? getSalesOrderStatusLabel(salesOrder.status) : null,
    locationName: operationalCase.locationName,
    deliveryMethod: operationalCase.deliveryMethod,
    promisedAt: operationalCase.promisedAt?.toISOString() ?? null,
    openedAt: operationalCase.openedAt.toISOString(),
    lastActivityAt: operationalCase.lastActivityAt.toISOString(),
    closedAt: operationalCase.closedAt?.toISOString() ?? null,
    cancelledAt: operationalCase.cancelledAt?.toISOString() ?? null,
    closeReason: operationalCase.closeReason,
    ownerUserId: operationalCase.ownerUserId,
    ownerName: owner?.name ?? null,
    process: extra.process,
    // The case room only opens for its members: the chat itself would refuse otherwise.
    chatHref:
      operationalCase.chatChannelId && chatMember
        ? `/app/chat?channel=${encodeURIComponent(operationalCase.chatChannelId)}`
        : null,
    risk: extra.risk,
    version: operationalCase.version,
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function mapSteps(
  rows: Array<Awaited<ReturnType<typeof prisma.caseStep.findMany>>[number]>,
  blueprint: ProcessBlueprint | null,
  demandById: Map<string, { name: string }>,
  allocationById: Map<string, { source: string; demandId: string }>,
  now: Date
): CaseStepView[] {
  const order = new Map((blueprint?.steps ?? []).map((step, index) => [step.key, index]));
  return rows
    .map((row): CaseStepView => {
      const def = blueprint ? findStepDef(blueprint, row.stepKey) : null;
      const open = OPEN_STEP_STATUSES.has(row.status);
      const allocation = row.allocationId ? allocationById.get(row.allocationId) : null;
      const demand = row.demandId
        ? demandById.get(row.demandId)
        : allocation
          ? demandById.get(allocation.demandId)
          : null;
      const scopeLabel = allocation
        ? `${labelOf(ALLOCATION_SOURCE_LABELS, allocation.source)}${demand ? ` · ${demand.name}` : ''}`
        : (demand?.name ?? null);
      return {
        id: row.id,
        stepKey: row.stepKey,
        label: def?.label ?? row.stepKey,
        areaKey: row.areaKey,
        areaLabel: areaLabelOf(row.areaKey) ?? row.areaKey,
        scopeKey: row.scopeKey,
        scopeLabel,
        kind: row.kind,
        kindLabel: labelOf(WORK_ITEM_KIND_LABELS, row.kind),
        status: row.status,
        statusLabel: labelOf(STEP_STATUS_LABELS, row.status),
        phase: def?.phase ?? 'planning',
        order: order.get(row.stepKey) ?? 999,
        slaMinutes: row.slaMinutes,
        dueAt: row.dueAt?.toISOString() ?? null,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        overdue: Boolean(row.dueAt && open && row.dueAt.getTime() < now.getTime()),
      };
    })
    .sort((a, b) => a.order - b.order || a.scopeKey.localeCompare(b.scopeKey));
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

async function loadWorkItems(
  user: CurrentUser,
  caseId: string,
  now: Date
): Promise<CaseWorkItemView[]> {
  const rows = await prisma.workItem.findMany({
    where: { caseId, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: WORK_ITEM_LIMIT,
  });
  const dtos = await toWorkItemDTOs(rows, now);
  const missing = await missingEvidenceForWorkItems(dtos);
  return dtos.map((item) => ({
    id: item.id,
    title: item.title,
    areaKey: item.areaKey,
    areaLabel: item.areaLabel,
    kind: item.kind,
    kindLabel: item.kindLabel,
    status: item.status,
    statusLabel: item.statusLabel,
    ownerUserId: item.ownerUserId,
    ownerName: item.ownerName,
    backupUserId: item.backupUserId,
    backupName: item.backupName,
    dueAt: item.dueAt,
    overdue: item.overdue,
    escalationLevel: item.escalationLevel,
    waitReason: item.waitReason,
    stepId: item.stepId,
    objectType: item.objectType,
    objectId: item.objectId,
    requiredEvidence: item.requiredEvidence,
    missingEvidence: missing.get(item.id) ?? [],
    version: item.version,
    permissions: workItemPermissions(user, {
      ownerUserId: item.ownerUserId,
      backupUserId: item.backupUserId,
      status: item.status,
      objectType: item.objectType,
    }),
  }));
}

// ---------------------------------------------------------------------------
// Requests between areas
// ---------------------------------------------------------------------------

function mapRequests(
  rows: Array<Awaited<ReturnType<typeof prisma.areaRequest.findMany>>[number]>,
  now: Date,
  ownerNames: Map<string, string> = new Map()
): CaseRequestView[] {
  const open = new Set<string>(AREA_REQUEST_OPEN_STATUSES);
  return rows.map((row): CaseRequestView => {
    const isOpen = open.has(row.status);
    const kindDef = AREA_REQUEST_KIND_CATALOG[row.kind as keyof typeof AREA_REQUEST_KIND_CATALOG];
    return {
      id: row.id,
      kind: row.kind,
      kindLabel: kindDef?.label ?? row.kind,
      title: row.title,
      fromAreaKey: row.fromAreaKey,
      fromAreaLabel: areaLabelOf(row.fromAreaKey) ?? row.fromAreaKey,
      toAreaKey: row.toAreaKey,
      toAreaLabel: areaLabelOf(row.toAreaKey) ?? row.toAreaKey,
      status: row.status,
      statusLabel: labelOf(AREA_REQUEST_STATUS_LABELS, row.status),
      blocksDelivery: row.blocksDelivery,
      dueAt: row.dueAt.toISOString(),
      overdue: isOpen && row.dueAt.getTime() < now.getTime(),
      ownerUserId: row.ownerUserId,
      ownerName: ownerNames.get(row.ownerUserId) ?? null,
      workItemId: row.workItemId,
      // Untrusted text written by a person: the UI renders it as an escaped quote.
      freeText: row.freeText,
      open: isOpen,
    };
  });
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

async function loadIncidents(caseId: string): Promise<CaseIncidentView[]> {
  const rows = await prisma.incident.findMany({
    where: { caseId },
    orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
    take: INCIDENT_LIMIT,
  });
  const ownerIds = [
    ...new Set(rows.map((row) => row.ownerUserId).filter((id): id is string => Boolean(id))),
  ];
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(owners.map((owner) => [owner.id, owner.name]));
  const open = new Set<string>(INCIDENT_OPEN_STATUSES);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    kindLabel: labelOf(INCIDENT_KIND_LABELS, row.kind),
    severity: row.severity,
    severityLabel: labelOf(INCIDENT_SEVERITY_LABELS, row.severity),
    status: row.status,
    statusLabel: INCIDENT_STATUS_LABELS[row.status] ?? row.status,
    title: row.title,
    areaLabel: areaLabelOf(row.areaKey) ?? row.areaKey,
    ownerName: row.ownerUserId ? (names.get(row.ownerUserId) ?? null) : null,
    openedAt: row.openedAt.toISOString(),
    open: open.has(row.status),
  }));
}

/** Spanish labels of `Incident.status` (the core stores the raw value). */
const INCIDENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'Abierta',
  acknowledged: 'Atendiéndose',
  resolved: 'Resuelta',
  dismissed: 'Descartada',
};

// ---------------------------------------------------------------------------
// Demands and allocations
// ---------------------------------------------------------------------------

async function loadConfidence(
  user: CurrentUser,
  demands: Array<{ zohoItemId: string | null }>
): Promise<Map<string, { level: string; lastCountAt: Date | null }>> {
  if (!hasPermission(user, 'inventory.view')) return new Map();
  const itemIds = [
    ...new Set(
      demands.map((demand) => demand.zohoItemId).filter((id): id is string => Boolean(id))
    ),
  ];
  if (itemIds.length === 0) return new Map();
  const profiles = await prisma.productInventoryProfile.findMany({
    where: { zohoItemId: { in: itemIds } },
    select: { zohoItemId: true, confidence: true, lastCountAt: true },
  });
  return new Map(
    profiles.map((profile) => [
      profile.zohoItemId,
      { level: profile.confidence, lastCountAt: profile.lastCountAt },
    ])
  );
}

function mapDemands(
  demands: Array<Awaited<ReturnType<typeof prisma.caseDemand.findMany>>[number]>,
  allocations: Array<Awaited<ReturnType<typeof prisma.demandAllocation.findMany>>[number]>,
  warehouseNames: Map<string, string>,
  confidence: Map<string, { level: string; lastCountAt: Date | null }>
): CaseDemandView[] {
  const byDemand = new Map<string, typeof allocations>();
  for (const allocation of allocations) {
    const list = byDemand.get(allocation.demandId);
    if (list) list.push(allocation);
    else byDemand.set(allocation.demandId, [allocation]);
  }
  return demands.map((demand): CaseDemandView => {
    const profile = demand.zohoItemId ? confidence.get(demand.zohoItemId) : undefined;
    return {
      id: demand.id,
      lineRef: demand.lineRef,
      name: demand.name,
      sku: demand.sku,
      quantity: decimalText(demand.quantity),
      unit: demand.unit,
      baseQuantity: decimalText(demand.baseQuantity),
      baseUnit: demand.baseUnit,
      fulfilledQuantity: decimalText(demand.fulfilledQuantity),
      status: demand.status,
      statusLabel: labelOf(DEMAND_STATUS_LABELS, demand.status),
      confidence:
        profile && isConfidenceLevel(profile.level)
          ? {
              level: profile.level,
              label: CONFIDENCE_LABELS[profile.level],
              lastCountAt: profile.lastCountAt?.toISOString() ?? null,
            }
          : null,
      allocations: (byDemand.get(demand.id) ?? []).map((allocation) => ({
        id: allocation.id,
        source: allocation.source,
        sourceLabel: labelOf(ALLOCATION_SOURCE_LABELS, allocation.source),
        quantity: decimalText(allocation.quantity),
        status: allocation.status,
        statusLabel: labelOf(ALLOCATION_STATUS_LABELS, allocation.status),
        expectedAt: allocation.expectedAt?.toISOString() ?? null,
        deliveredQuantity: decimalText(allocation.deliveredQuantity),
        warehouseName: allocation.warehouseId
          ? (warehouseNames.get(allocation.warehouseId) ?? null)
          : null,
        linkedLabel: allocation.linkedType
          ? (ALLOCATION_LINK_LABELS[allocation.linkedType] ?? allocation.linkedType)
          : null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Zoho sync states that need a person to look at them (plan 4: conflicto o falla). */
const ZOHO_ATTENTION_STATES = new Set(['readback_mismatch', 'failed']);

async function loadDelivery(user: CurrentUser, caseId: string): Promise<CaseDeliveryOrderView[]> {
  const orders = await prisma.deliveryOrder.findMany({
    where: { caseId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (orders.length === 0) return [];

  const tripIds = [
    ...new Set(orders.map((order) => order.tripId).filter((id): id is string => Boolean(id))),
  ];
  const packageIds = [
    ...new Set(orders.map((order) => order.packageId).filter((id): id is string => Boolean(id))),
  ];
  const canSeePackages = hasPermission(user, 'packages.view');
  const [trips, packages] = await Promise.all([
    tripIds.length
      ? prisma.trip.findMany({
          where: { id: { in: tripIds } },
          select: {
            id: true,
            number: true,
            status: true,
            date: true,
            vehicleId: true,
            driverId: true,
          },
        })
      : Promise.resolve([]),
    packageIds.length
      ? prisma.package.findMany({
          where: { id: { in: packageIds } },
          select: { id: true, packageNumber: true },
        })
      : Promise.resolve([]),
  ]);
  const vehicleIds = [...new Set(trips.map((trip) => trip.vehicleId))];
  const driverIds = [...new Set(trips.map((trip) => trip.driverId))];
  const [vehicles, drivers] = await Promise.all([
    vehicleIds.length
      ? prisma.vehicle.findMany({
          where: { id: { in: vehicleIds } },
          select: { id: true, label: true, plate: true },
        })
      : Promise.resolve([]),
    driverIds.length
      ? prisma.driver.findMany({
          where: { id: { in: driverIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const vehicleById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const driverById = new Map(drivers.map((driver) => [driver.id, driver]));
  const tripById = new Map(trips.map((trip) => [trip.id, trip]));
  const packageById = new Map(packages.map((row) => [row.id, row]));

  return orders.map((order): CaseDeliveryOrderView => {
    const trip = order.tripId ? tripById.get(order.tripId) : null;
    const vehicle = trip ? vehicleById.get(trip.vehicleId) : null;
    const localPackage = order.packageId ? packageById.get(order.packageId) : null;
    return {
      id: order.id,
      status: order.status,
      statusLabel: labelOf(DELIVERY_ORDER_STATUS_LABELS, order.status),
      mode: order.mode,
      modeLabel: labelOf(DELIVERY_MODE_LABELS, order.mode),
      zohoSyncState: order.zohoSyncState,
      zohoSyncLabel: labelOf(ZOHO_SYNC_STATE_LABELS, order.zohoSyncState),
      zohoNeedsAttention:
        order.status === 'conflict' || ZOHO_ATTENTION_STATES.has(order.zohoSyncState),
      plannedDate: order.plannedDate?.toISOString() ?? null,
      deliveredAt: order.deliveredAt?.toISOString() ?? null,
      carrier: order.carrier,
      addressLine: order.addressLine,
      contactName: order.contactName,
      packageNumber: localPackage?.packageNumber ?? null,
      packageHref: localPackage && canSeePackages ? `/app/packages/${localPackage.id}` : null,
      trip: trip
        ? {
            id: trip.id,
            number: trip.number,
            status: trip.status,
            statusLabel: labelOf(TRIP_STATUS_LABELS, trip.status),
            date: trip.date.toISOString(),
            vehicleLabel: vehicle ? `${vehicle.label} (${vehicle.plate})` : null,
            driverName: driverById.get(trip.driverId)?.name ?? null,
          }
        : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

async function loadEvidence(caseId: string): Promise<CaseEvidenceView[]> {
  const rows = await prisma.evidenceLink.findMany({
    where: { caseId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: EVIDENCE_LIMIT,
  });
  if (rows.length === 0) return [];
  const objectIds = [
    ...new Set(rows.map((row) => row.storageObjectId).filter((id): id is string => Boolean(id))),
  ];
  const authorIds = [...new Set(rows.map((row) => row.createdBy))];
  const [objects, authors] = await Promise.all([
    objectIds.length
      ? prisma.storageObject.findMany({
          where: { id: { in: objectIds } },
          select: { id: true, originalName: true, status: true },
        })
      : Promise.resolve([]),
    prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } }),
  ]);
  const objectById = new Map(objects.map((object) => [object.id, object]));
  const authorById = new Map(authors.map((author) => [author.id, author.name]));

  return rows.map((row): CaseEvidenceView => {
    const object = row.storageObjectId ? objectById.get(row.storageObjectId) : null;
    const ready = object?.status === 'ready';
    return {
      id: row.id,
      kindLabel: evidenceLabel(row.kind),
      note: row.note,
      createdByName: authorById.get(row.createdBy) ?? null,
      createdAt: row.createdAt.toISOString(),
      fileName: object?.originalName ?? null,
      // The stream re-checks who may read the object (storage access resolver).
      fileUrl:
        object && ready ? `/app/files/api/objects/${encodeURIComponent(object.id)}/content` : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Business timeline of the case: every `OperationalEvent` except the AI turn
 * audit, rendered with `formatTimelineLine` so the page and the case room read
 * exactly the same.
 */
async function loadTimeline(
  caseId: string,
  operationalCase: NonNullable<CaseRecord>,
  now: Date,
  options: { beforeId?: string }
): Promise<{ entries: CaseTimelineEntry[]; olderCursor: string | null }> {
  const page = await listCaseEvents(caseId, {
    limit: TIMELINE_PAGE,
    excludeTypes: AI_TURN_EVENT_TYPES,
    ...(options.beforeId ? { beforeId: options.beforeId } : {}),
  });
  const actorIds = [
    ...new Set(
      page.events
        .filter((event) => event.actorType === 'user' || event.actorType === 'ai')
        .map((event) => event.actorId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const actors = actorIds.length
    ? await prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true },
      })
    : [];
  const actorNames = new Map(actors.map((actor) => [actor.id, actor.name]));

  const entries = page.events
    .slice()
    .reverse()
    .map((event): CaseTimelineEntry => {
      const areaKey = event.areaKey;
      return {
        id: event.id,
        line: formatTimelineLine(event, {
          now,
          occurredAt: event.occurredAt,
          caseNumber: operationalCase.caseNumber,
          salesOrderNumber: operationalCase.salesOrderNumber,
          customerName: operationalCase.customerName,
          areaKey,
          actorName: event.actorId ? (actorNames.get(event.actorId) ?? null) : null,
        }),
        type: event.type,
        areaKey,
        areaLabel: areaLabelOf(areaKey),
        actorType: event.actorType,
        occurredAt: event.occurredAt,
      };
    });

  return { entries, olderCursor: page.olderCursor };
}

/** Older page of the timeline (`Ver historia anterior`). Applies the case access rule. */
export async function loadCaseTimelinePage(
  user: CurrentUser,
  caseId: string,
  beforeId: string,
  options: { now?: Date } = {}
): Promise<{ entries: CaseTimelineEntry[]; olderCursor: string | null } | null> {
  const operationalCase = await prisma.operationalCase.findUnique({ where: { id: caseId } });
  if (!operationalCase) return null;
  if (!(await canOpenCase(user, caseId))) return null;
  return loadTimeline(caseId, operationalCase, options.now ?? new Date(), { beforeId });
}

// ---------------------------------------------------------------------------
// Compact summary (preview drawer of the list)
// ---------------------------------------------------------------------------

export interface CaseSummaryView {
  id: string;
  caseNumber: string;
  customerName: string | null;
  salesOrderNumber: string | null;
  statusLabel: string;
  phaseLabel: string;
  ownerName: string | null;
  promisedAt: string | null;
  riskLabel: string;
  openWorkItems: number;
  overdueWorkItems: number;
  openRequests: number;
  openIncidents: number;
  next: { title: string; reason: string; ownerName: string | null; dueAt: string | null } | null;
  /** Last lines of the timeline, newest first. */
  timeline: string[];
}

const SUMMARY_TIMELINE = 8;

/** Compact case for the preview drawer. Null when it does not exist or is not open to this person. */
export async function loadCaseSummary(
  user: CurrentUser,
  caseId: string,
  options: { now?: Date } = {}
): Promise<CaseSummaryView | null> {
  const now = options.now ?? new Date();
  const operationalCase = await prisma.operationalCase.findUnique({ where: { id: caseId } });
  if (!operationalCase) return null;
  if (!(await canOpenCase(user, caseId))) return null;

  const [workItemRows, requestRows, incidentCount, owner, stepRows, events] = await Promise.all([
    prisma.workItem.findMany({
      where: { caseId, status: { in: [...WORK_ITEM_OPEN_STATUSES] } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: WORK_ITEM_LIMIT,
    }),
    prisma.areaRequest.findMany({
      where: { caseId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: REQUEST_LIMIT,
    }),
    prisma.incident.count({ where: { caseId, status: { in: [...INCIDENT_OPEN_STATUSES] } } }),
    prisma.user.findUnique({ where: { id: operationalCase.ownerUserId }, select: { name: true } }),
    prisma.caseStep.findMany({ where: { caseId } }),
    listCaseEvents(caseId, { limit: SUMMARY_TIMELINE, excludeTypes: AI_TURN_EVENT_TYPES }),
  ]);

  const dtos = await toWorkItemDTOs(workItemRows, now);
  const workItems: CaseWorkItemView[] = dtos.map((item) => ({
    id: item.id,
    title: item.title,
    areaKey: item.areaKey,
    areaLabel: item.areaLabel,
    kind: item.kind,
    kindLabel: item.kindLabel,
    status: item.status,
    statusLabel: item.statusLabel,
    ownerUserId: item.ownerUserId,
    ownerName: item.ownerName,
    backupUserId: item.backupUserId,
    backupName: item.backupName,
    dueAt: item.dueAt,
    overdue: item.overdue,
    escalationLevel: item.escalationLevel,
    waitReason: item.waitReason,
    stepId: item.stepId,
    objectType: item.objectType,
    objectId: item.objectId,
    requiredEvidence: item.requiredEvidence,
    missingEvidence: [],
    version: item.version,
    permissions: workItemPermissions(user, {
      ownerUserId: item.ownerUserId,
      backupUserId: item.backupUserId,
      status: item.status,
      objectType: item.objectType,
    }),
  }));
  const requestOwnerIds = [...new Set(requestRows.map((request) => request.ownerUserId))];
  const requestOwners = requestOwnerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: requestOwnerIds } },
        select: { id: true, name: true },
      })
    : [];
  const requests = mapRequests(
    requestRows,
    now,
    new Map(requestOwners.map((owner) => [owner.id, owner.name]))
  );
  const steps = mapSteps(stepRows, null, new Map(), new Map(), now);
  const next = caseNextAction({ workItems, requests, steps });
  const openRequests = requests.filter((request) => request.open);
  const risk = caseRisk(
    {
      status: operationalCase.status,
      promisedAt: operationalCase.promisedAt?.toISOString() ?? null,
      overdueWorkItems: workItems.filter((item) => item.overdue).length,
      openIncidents: incidentCount,
      blockingRequests: openRequests.filter((request) => request.blocksDelivery).length,
    },
    now
  );

  return {
    id: operationalCase.id,
    caseNumber: operationalCase.caseNumber,
    customerName: operationalCase.customerName,
    salesOrderNumber: operationalCase.salesOrderNumber,
    statusLabel: labelOf(CASE_STATUS_LABELS, operationalCase.status),
    phaseLabel: labelOf(CASE_PHASE_LABELS, operationalCase.phase),
    ownerName: owner?.name ?? null,
    promisedAt: operationalCase.promisedAt?.toISOString() ?? null,
    riskLabel: CASE_RISK_LABELS[risk],
    openWorkItems: workItems.length,
    overdueWorkItems: workItems.filter((item) => item.overdue).length,
    openRequests: openRequests.length,
    openIncidents: incidentCount,
    next:
      next.kind === 'none'
        ? null
        : {
            title: next.title,
            reason: next.reason,
            ownerName: next.ownerName,
            dueAt: next.dueAt,
          },
    timeline: events.events
      .slice()
      .reverse()
      .map((event) =>
        formatTimelineLine(event, {
          now,
          occurredAt: event.occurredAt,
          caseNumber: operationalCase.caseNumber,
          customerName: operationalCase.customerName,
          areaKey: event.areaKey,
        })
      ),
  };
}

// ---------------------------------------------------------------------------
// People who can take the work of the case
// ---------------------------------------------------------------------------

export interface CaseAssignee {
  id: string;
  name: string;
}

const ASSIGNEE_LIMIT = 100;

/**
 * Active people (never bots) who can receive a work item of this case: the ones
 * already taking part in it plus the responsible and backup of each area with
 * open work. The engine checks the new owner again (`reassignWorkItemInTx`).
 */
export async function listCaseAssignees(
  user: CurrentUser,
  caseId: string
): Promise<CaseAssignee[] | null> {
  if (!(await canOpenCase(user, caseId))) return null;
  const operationalCase = await prisma.operationalCase.findUnique({
    where: { id: caseId },
    select: { ownerUserId: true },
  });
  if (!operationalCase) return null;

  const [items, responsibles] = await Promise.all([
    prisma.workItem.findMany({
      where: { caseId },
      select: { ownerUserId: true, backupUserId: true, areaKey: true },
      take: WORK_ITEM_LIMIT,
    }),
    prisma.responsible.findMany({
      where: { active: true },
      select: { userId: true, backupUserId: true },
      take: ASSIGNEE_LIMIT,
    }),
  ]);

  const ids = new Set<string>([operationalCase.ownerUserId, user.id]);
  for (const item of items) {
    ids.add(item.ownerUserId);
    if (item.backupUserId) ids.add(item.backupUserId);
  }
  for (const responsible of responsibles) {
    if (responsible.userId) ids.add(responsible.userId);
    if (responsible.backupUserId) ids.add(responsible.backupUserId);
  }

  const users = await prisma.user.findMany({
    where: { id: { in: [...ids] }, isActive: true, isBot: false },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
    take: ASSIGNEE_LIMIT,
  });
  return users;
}
