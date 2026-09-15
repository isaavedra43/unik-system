import type { ProductionOperation, WorkCenter } from '@prisma/client';
import { z } from 'zod';
import { requireCommandContext } from '@/modules/operations/commands';
import {
  capacityLoad,
  computeShiftLoads,
  parseStoredShifts,
  perOrderLoads,
  type ShiftLoad,
} from './capacity-rules';
import { addDays, loadWorkCenter, num, type Db } from './manufacturing-helpers';
import { DEFAULT_OPERATION_MINUTES, type CapacityUnit } from './manufacturing-types';
import { raiseCapacityAlert } from './production-service';

/**
 * Load of the work centers per shift (reads shared by the floor board, the
 * hourly `manufacturing.capacity_alerts` job and the alert command).
 */

export interface CenterOperationLoad {
  operationId: string;
  productionOrderId: string;
  number: string;
  name: string;
  status: string;
  plannedStartAt: Date;
  plannedMinutes: number | null;
  seq: number;
  load: number;
}

type OperationWithOrder = ProductionOperation & {
  productionOrder: { number: string; plannedQty: unknown; plannedUnit: string; status: string } | null;
};

export async function loadWorkCenterLoads(
  db: Db,
  center: WorkCenter,
  from: Date,
  to: Date
): Promise<{ loads: ShiftLoad[]; operations: CenterOperationLoad[] }> {
  const capacityUnit = center.capacityUnit as CapacityUnit;
  const rows = (await db.productionOperation.findMany({
    where: {
      workCenterId: center.id,
      status: { in: ['pending', 'running', 'paused'] },
      plannedStartAt: { gte: addDays(from, -1), lt: to },
    },
    include: {
      productionOrder: { select: { number: true, plannedQty: true, plannedUnit: true, status: true } },
    },
    orderBy: [{ plannedStartAt: 'asc' }, { id: 'asc' }],
  })) as OperationWithOrder[];
  const operations: CenterOperationLoad[] = rows
    .filter(
      (row) =>
        row.plannedStartAt &&
        row.productionOrder &&
        !['cancelled', 'released'].includes(row.productionOrder.status)
    )
    .map((row) => ({
      operationId: row.id,
      productionOrderId: row.productionOrderId,
      number: row.productionOrder?.number ?? '',
      name: row.name,
      status: row.status,
      plannedStartAt: row.plannedStartAt as Date,
      plannedMinutes: row.plannedMinutes,
      seq: row.seq,
      load: capacityLoad(capacityUnit, {
        minutes: row.plannedMinutes,
        defaultMinutes: DEFAULT_OPERATION_MINUTES,
        quantity: num(row.productionOrder?.plannedQty as never),
        unit: row.productionOrder?.plannedUnit,
      }),
    }));
  const counted = perOrderLoads(
    capacityUnit,
    operations.map((op) => ({ ...op, id: op.operationId, start: op.plannedStartAt }))
  );
  for (const op of operations) op.load = counted.find((item) => item.id === op.operationId)?.load ?? op.load;
  const loads = computeShiftLoads({
    shifts: parseStoredShifts(center.shifts),
    capacityPerShift: num(center.capacityPerShift),
    from,
    to,
    items: operations.map((op) => ({ id: op.operationId, start: op.plannedStartAt, load: op.load })),
  });
  return { loads, operations };
}

const instantText = z
  .string()
  .trim()
  .min(10)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Fecha inválida (usa formato ISO)');

export const capacityAlertSchema = z.object({
  workCenterId: z.string().trim().min(1).max(120),
  windowStart: instantText,
});

export interface CapacityAlertResult {
  workCenterId: string;
  windowStart: string;
  overloaded: boolean;
  alerted: boolean;
  workItemId: string | null;
}

/** Re-checks one shift of a center inside the command and raises the overload warning when it still applies. */
export async function capacityAlertInTx(
  tx: Db,
  input: z.output<typeof capacityAlertSchema>
): Promise<CapacityAlertResult> {
  const ctx = requireCommandContext(tx);
  const center = await loadWorkCenter(tx, input.workCenterId);
  const start = new Date(input.windowStart);
  const base = { workCenterId: center.id, windowStart: start.toISOString() };
  if (center.status !== 'active') return { ...base, overloaded: false, alerted: false, workItemId: null };
  const { loads } = await loadWorkCenterLoads(tx, center, start, addDays(start, 2));
  const window = loads.find((candidate) => candidate.start.getTime() === start.getTime());
  if (!window || !window.overloaded) return { ...base, overloaded: false, alerted: false, workItemId: null };
  const alert = await raiseCapacityAlert(tx, ctx, center, window);
  return { ...base, overloaded: true, alerted: alert.created, workItemId: alert.workItemId };
}
