import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import type { AreaRowDetail, AreaRowField, AreaWorkRow } from '@/modules/areas/area-work-row';
import { extraNumber, extraString } from '@/modules/areas/area-work-row';
import { getProductionOrderDetail } from '@/modules/manufacturing/manufacturing-queries';
import {
  MANUFACTURING_OBJECT_TYPES,
  OPERATION_STATUS_LABELS,
  PRODUCTION_ORDER_KIND_LABELS,
  PRODUCTION_ORDER_STATUS_LABELS,
  productionOrderUrl,
  type OperationStatus,
  type ProductionOrderKind,
  type ProductionOrderStatus,
} from '@/modules/manufacturing/manufacturing-types';

/**
 * Detail of the Manufactura rows for the drawer and the detail page (plan 7.4).
 * SERVER ONLY.
 *
 * It reuses `getProductionOrderDetail`, the module's own read, so materials,
 * scrap, balance and release blockers are computed in ONE place. Somebody who
 * opens the area through `operations.admin` without `manufacturing.view` still
 * gets the row facts: the rich part is simply omitted and said to be omitted,
 * instead of failing.
 */

const VIEW = 'manufacturing.view';

function field(
  label: string,
  value: string | null | undefined,
  hint?: string | null
): AreaRowField | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? { label, value: text, hint: hint ?? null } : null;
}

function compact(fields: Array<AreaRowField | null>): AreaRowField[] {
  return fields.filter((entry): entry is AreaRowField => entry !== null);
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Mexico_City',
};

function formatDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('es-MX', DATE_FORMAT).format(date);
  } catch {
    return date.toISOString();
  }
}

function minutesText(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

async function userName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return user?.name ?? null;
}

/** Facts of a production order: plan, material, quality, scrap and what blocks its release. */
async function orderDetail(actor: CurrentUser, row: AreaWorkRow): Promise<Partial<AreaRowDetail>> {
  const evidenceTargetId = `${MANUFACTURING_OBJECT_TYPES.productionOrder}:${row.sourceId}`;

  if (!hasPermission(actor, VIEW)) {
    return {
      fields: compact([
        field('Orden', extraString(row.extra, 'number')),
        field('Estado', row.statusLabel),
        field('Producto', extraString(row.extra, 'outputName')),
        field('Centro de trabajo', extraString(row.extra, 'workCenter')),
        field(
          'Detalle de producción',
          'No tienes permiso para ver el detalle de manufactura (materiales, calidad y merma).'
        ),
      ]),
      evidenceTargetId,
    };
  }

  const detail = await getProductionOrderDetail(actor, row.sourceId);
  const { order } = detail;
  const pendingMaterials = detail.materials.filter(
    (material) => Number(material.consumed) <= 0 && Number(material.assigned) > 0
  );
  const blockers = detail.release.blockers.map((blocker) => blocker.message);
  const lastCheck = detail.qualityChecks.at(-1) ?? null;
  const runningOperation =
    detail.operations.find((operation) => operation.status === 'running') ?? null;
  const pendingOperations = detail.operations.filter(
    (operation) => operation.status === 'pending' || operation.status === 'paused'
  );

  return {
    fields: compact([
      field('Orden', order.number),
      field('Tipo', PRODUCTION_ORDER_KIND_LABELS[order.kind as ProductionOrderKind] ?? order.kind),
      field('Estado', order.statusLabel, order.blockedReason),
      field(
        'Producto',
        order.outputName ?? order.outputZohoItemId,
        `${order.plannedQty} ${order.plannedUnit} planeados`
      ),
      field(
        'Producido',
        `${order.producedQty} ${order.plannedUnit}`,
        `Merma ${order.scrapQty} · Sobrante ${order.leftoverQty}`
      ),
      field('Centro de trabajo', detail.workCenter?.name ?? null),
      field('Inicia', formatDate(order.plannedStartAt)),
      field('Termina', formatDate(order.plannedEndAt)),
      field('Se libera a', order.releaseTargetLabel),
      field(
        'Operaciones',
        detail.operations.length > 0
          ? `${detail.operations.filter((operation) => operation.status === 'done').length} de ${detail.operations.length} terminadas`
          : null,
        runningOperation
          ? `En curso: ${runningOperation.seq}. ${runningOperation.name}`
          : pendingOperations.length > 0
            ? `Siguiente: ${pendingOperations[0].seq}. ${pendingOperations[0].name}`
            : null
      ),
      field(
        'Material',
        detail.materials.length > 0
          ? `${detail.materials.length} ${detail.materials.length === 1 ? 'insumo' : 'insumos'}`
          : null,
        pendingMaterials.length > 0
          ? `Sin consumo registrado: ${pendingMaterials.map((material) => material.label).join(', ')}`
          : null
      ),
      field(
        'Merma',
        detail.scrap.maxPct === null
          ? null
          : `${detail.scrap.maxPct} % (tolerancia ${detail.scrap.allowancePct} %)`,
        detail.scrap.exceeded ? 'Fuera de tolerancia: requiere aprobación' : null
      ),
      field(
        'Calidad',
        lastCheck ? lastCheck.resultLabel : 'Sin inspección registrada',
        lastCheck ? formatDate(lastCheck.inspectedAt) : null
      ),
      detail.pendingSubstitutionIds.length > 0
        ? field(
            'Sustituciones por aprobar',
            String(detail.pendingSubstitutionIds.length),
            'No se puede liberar mientras estén pendientes'
          )
        : null,
      field(
        'Listo para liberar',
        detail.release.ready ? 'Sí' : 'No',
        blockers.length > 0 ? blockers.join(' · ') : null
      ),
      field(
        'Ficha completa',
        productionOrderUrl(order.id),
        'Materiales, operaciones, calidad y salidas'
      ),
    ]),
    evidenceTargetId,
  };
}

/** Facts of one operation of the floor. */
async function operationDetail(
  actor: CurrentUser,
  row: AreaWorkRow
): Promise<Partial<AreaRowDetail> | null> {
  const operation = await prisma.productionOperation.findUnique({
    where: { id: row.sourceId },
    select: {
      id: true,
      seq: true,
      name: true,
      status: true,
      plannedStartAt: true,
      plannedMinutes: true,
      startedAt: true,
      finishedAt: true,
      actualMinutes: true,
      assignedUserId: true,
      workCenterId: true,
      productionOrderId: true,
    },
  });
  if (!operation) return null;

  const [order, center, assignedName] = await Promise.all([
    prisma.productionOrder.findUnique({
      where: { id: operation.productionOrderId },
      select: {
        number: true,
        status: true,
        outputName: true,
        outputZohoItemId: true,
        plannedQty: true,
        plannedUnit: true,
        plannedEndAt: true,
      },
    }),
    operation.workCenterId
      ? prisma.workCenter.findUnique({
          where: { id: operation.workCenterId },
          select: { name: true, key: true },
        })
      : null,
    userName(operation.assignedUserId),
  ]);

  return {
    fields: compact([
      field('Operación', `${operation.seq}. ${operation.name}`),
      field(
        'Estado',
        OPERATION_STATUS_LABELS[operation.status as OperationStatus] ?? operation.status
      ),
      field('Centro de trabajo', center ? `${center.name} (${center.key})` : null),
      field('Responsable', assignedName, assignedName ? null : 'Sin asignar'),
      field('Planeada', formatDate(operation.plannedStartAt)),
      field('Minutos planeados', minutesText(operation.plannedMinutes)),
      field('Inició', formatDate(operation.startedAt)),
      field('Terminó', formatDate(operation.finishedAt)),
      field('Minutos reales', minutesText(operation.actualMinutes)),
      order
        ? field(
            'Orden',
            `${order.number} · ${order.outputName ?? order.outputZohoItemId}`,
            `${order.plannedQty} ${order.plannedUnit} · ${
              PRODUCTION_ORDER_STATUS_LABELS[order.status as ProductionOrderStatus] ?? order.status
            }`
          )
        : null,
      field(
        'Ficha completa',
        productionOrderUrl(operation.productionOrderId),
        'Abre la orden con su material, calidad y salidas'
      ),
    ]),
    // Evidence of an operation belongs to its order (one file trail per order).
    evidenceTargetId: `${MANUFACTURING_OBJECT_TYPES.productionOrder}:${operation.productionOrderId}`,
  };
}

/** `AreaServerModule.getRowDetail` of Manufactura. */
export async function getManufacturaRowDetail(
  actor: CurrentUser,
  row: AreaWorkRow
): Promise<Partial<AreaRowDetail> | null> {
  if (row.rowKind === 'production_order') return orderDetail(actor, row);
  if (row.rowKind === 'production_operation') {
    if (!hasPermission(actor, VIEW)) {
      return {
        fields: compact([
          field('Operación', extraString(row.extra, 'operationName')),
          field('Estado', row.statusLabel),
          field('Centro de trabajo', extraString(row.extra, 'workCenter')),
          field('Orden', extraString(row.extra, 'orderNumber')),
          field('Detalle de producción', 'No tienes permiso para ver el detalle de manufactura.'),
          field('Minutos planeados', minutesText(extraNumber(row.extra, 'plannedMinutes'))),
        ]),
      };
    }
    return operationDetail(actor, row);
  }
  return null;
}
