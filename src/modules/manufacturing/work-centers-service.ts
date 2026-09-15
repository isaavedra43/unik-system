import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requireCommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { toOperationalJson } from '@/modules/operations/events-service';
import { validateShifts } from './capacity-rules';
import { toWorkCenterDTO, type WorkCenterDTO } from './manufacturing-dto';
import { assertActiveWarehouse, loadWorkCenter, type Db } from './manufacturing-helpers';
import {
  CAPACITY_UNITS,
  MANUFACTURING_AREA_KEY,
  MANUFACTURING_EVENTS,
  MANUFACTURING_FLOOR_CHANNEL,
  MANUFACTURING_OBJECT_TYPES,
  MANUFACTURING_REALTIME_TYPES,
  WORK_CENTER_STATUSES,
} from './manufacturing-types';

/**
 * Work centers (plan 6.2): cutting, finishing or assembly stations with a
 * capacity per shift (m², pieces or minutes) and local shifts. Every writer
 * runs inside a manufacturing command (`manufacturing-commands.ts`).
 */

export const WORK_CENTER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** "Corte Norte" → "corte-norte". */
export function normalizeWorkCenterKey(key: string): string {
  return key
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const idText = z.string().trim().min(1).max(120);
const capacity = z.number().finite().positive('La capacidad debe ser mayor que cero').max(10_000_000);
const money = z.number().finite().min(0).max(1_000_000_000);
const currency = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Moneda inválida (ISO 4217)');

export const createWorkCenterSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(120),
  warehouseId: idText.nullish(),
  capacityPerShift: capacity,
  capacityUnit: z.enum(CAPACITY_UNITS),
  shifts: z.array(z.unknown()).max(10).default([]),
  costPerHour: money.nullish(),
  currency: currency.default('MXN'),
});
export type CreateWorkCenterInput = z.input<typeof createWorkCenterSchema>;

export const updateWorkCenterSchema = z.object({
  workCenterId: idText,
  name: z.string().trim().min(1).max(120).optional(),
  warehouseId: idText.nullish(),
  capacityPerShift: capacity.optional(),
  capacityUnit: z.enum(CAPACITY_UNITS).optional(),
  shifts: z.array(z.unknown()).max(10).optional(),
  costPerHour: money.nullish(),
  currency: currency.optional(),
  status: z.enum(WORK_CENTER_STATUSES).optional(),
});
export type UpdateWorkCenterInput = z.input<typeof updateWorkCenterSchema>;

function shiftsOrThrow(value: unknown) {
  const validation = validateShifts(value);
  if (!validation.ok) throw new OperationsError('invalid_payload', validation.message);
  return validation.shifts;
}

export async function createWorkCenterInTx(
  tx: Db,
  input: z.output<typeof createWorkCenterSchema>
): Promise<WorkCenterDTO> {
  const ctx = requireCommandContext(tx);
  const key = normalizeWorkCenterKey(input.key);
  if (!WORK_CENTER_KEY_PATTERN.test(key)) {
    throw new OperationsError(
      'invalid_payload',
      'Clave de centro inválida: usa letras minúsculas, números y guiones'
    );
  }
  const shifts = shiftsOrThrow(input.shifts);
  if (input.warehouseId) await assertActiveWarehouse(tx, input.warehouseId);
  // ON CONFLICT DO NOTHING: a duplicate never aborts the command transaction.
  const [row] = await tx.workCenter.createManyAndReturn({
    data: [
      {
        key,
        name: input.name,
        warehouseId: input.warehouseId ?? null,
        capacityPerShift: new Prisma.Decimal(input.capacityPerShift),
        capacityUnit: input.capacityUnit,
        shifts: toOperationalJson(shifts),
        costPerHour: input.costPerHour === null || input.costPerHour === undefined ? null : new Prisma.Decimal(input.costPerHour),
        currency: input.currency,
        status: 'active',
      },
    ],
    skipDuplicates: true,
  });
  if (!row) {
    throw new OperationsError('duplicate_code', `Ya existe un centro de trabajo con la clave ${key}`);
  }
  ctx.emit(
    MANUFACTURING_EVENTS.workCenterCreated,
    {
      workCenterId: row.id,
      key: row.key,
      name: row.name,
      capacityPerShift: input.capacityPerShift,
      capacityUnit: row.capacityUnit,
      shifts: shifts.length,
      warehouseId: row.warehouseId,
    },
    { areaKey: MANUFACTURING_AREA_KEY, objectType: MANUFACTURING_OBJECT_TYPES.workCenter, objectId: row.id }
  );
  ctx.realtime(MANUFACTURING_FLOOR_CHANNEL, MANUFACTURING_REALTIME_TYPES.workCenters, {
    commandId: ctx.commandId,
    workCenterId: row.id,
    status: row.status,
  });
  return toWorkCenterDTO(row);
}

export async function updateWorkCenterInTx(
  tx: Db,
  input: z.output<typeof updateWorkCenterSchema>
): Promise<WorkCenterDTO> {
  const ctx = requireCommandContext(tx);
  const current = await loadWorkCenter(tx, input.workCenterId);
  const data: Prisma.WorkCenterUpdateInput = {};
  const changed: string[] = [];
  if (input.name !== undefined && input.name !== current.name) {
    data.name = input.name;
    changed.push('name');
  }
  if (input.warehouseId !== undefined && (input.warehouseId ?? null) !== current.warehouseId) {
    if (input.warehouseId) await assertActiveWarehouse(tx, input.warehouseId);
    data.warehouseId = input.warehouseId ?? null;
    changed.push('warehouseId');
  }
  if (input.capacityPerShift !== undefined) {
    data.capacityPerShift = new Prisma.Decimal(input.capacityPerShift);
    changed.push('capacityPerShift');
  }
  if (input.capacityUnit !== undefined && input.capacityUnit !== current.capacityUnit) {
    data.capacityUnit = input.capacityUnit;
    changed.push('capacityUnit');
  }
  if (input.shifts !== undefined) {
    data.shifts = toOperationalJson(shiftsOrThrow(input.shifts));
    changed.push('shifts');
  }
  if (input.costPerHour !== undefined) {
    data.costPerHour = input.costPerHour === null ? null : new Prisma.Decimal(input.costPerHour);
    changed.push('costPerHour');
  }
  if (input.currency !== undefined && input.currency !== current.currency) {
    data.currency = input.currency;
    changed.push('currency');
  }
  if (input.status !== undefined && input.status !== current.status) {
    if (input.status === 'inactive') {
      const running = await tx.productionOperation.count({
        where: { workCenterId: current.id, status: 'running' },
      });
      if (running > 0) {
        throw new OperationsError(
          'in_use',
          `El centro ${current.name} tiene ${running} operación(es) en curso; termínalas antes de desactivarlo`
        );
      }
    }
    data.status = input.status;
    changed.push('status');
  }
  if (changed.length === 0) return toWorkCenterDTO(current);
  const row = await tx.workCenter.update({ where: { id: current.id }, data });
  ctx.emit(
    MANUFACTURING_EVENTS.workCenterUpdated,
    { workCenterId: row.id, key: row.key, changed, status: row.status },
    { areaKey: MANUFACTURING_AREA_KEY, objectType: MANUFACTURING_OBJECT_TYPES.workCenter, objectId: row.id }
  );
  ctx.realtime(MANUFACTURING_FLOOR_CHANNEL, MANUFACTURING_REALTIME_TYPES.workCenters, {
    commandId: ctx.commandId,
    workCenterId: row.id,
    status: row.status,
    changed,
  });
  return toWorkCenterDTO(row);
}
