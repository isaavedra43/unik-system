import { createHash } from 'crypto';
import { Prisma, type Bom, type BomLine, type BomOperation } from '@prisma/client';
import { z } from 'zod';
import { requireCommandContext } from '@/modules/operations/commands';
import { OperationsError } from '@/modules/operations/errors';
import { nextSequenceValue } from '@/modules/operations/sequence-service';
import { toBomDTO, type BomDTO } from './manufacturing-dto';
import { convertToBase, itemUnits, type Db } from './manufacturing-helpers';
import {
  BOM_KINDS,
  MANUFACTURING_AREA_KEY,
  MANUFACTURING_EVENTS,
  MANUFACTURING_FLOOR_CHANNEL,
  MANUFACTURING_OBJECT_TYPES,
  MANUFACTURING_REALTIME_TYPES,
  manufacturingError,
} from './manufacturing-types';

/**
 * Versioned bills of materials (plan 6.2), only for repeatable products; the
 * default production order is a transformation with an implicit BOM.
 *
 * - A BOM is edited only while `draft`; `version` is the revision number of the
 *   output item (never a concurrency guard).
 * - Activating a draft retires the active revision of the same output under a
 *   row lock of every revision, so two activations never leave two actives.
 * - A line lists the substitutes the BOM allows: consuming one needs no
 *   approval; consuming anything else is a substitution outside the BOM.
 */

const idText = z.string().trim().min(1).max(120);

export const bomLineSchema = z.object({
  inputZohoItemId: idText,
  qtyPerOutput: z.number().finite().positive('La cantidad por unidad debe ser mayor que cero').max(1_000_000_000),
  unit: z.string().trim().min(1).max(40),
  substituteZohoItemIds: z.array(idText).max(10).default([]),
  scrapPct: z.number().finite().min(0).max(100).nullish(),
});

export const bomOperationSchema = z.object({
  seq: z.number().int().min(1).max(999),
  workCenterId: idText,
  name: z.string().trim().min(1).max(120),
  stdMinutes: z.number().int().min(0).max(100_000),
  setupMinutes: z.number().int().min(0).max(100_000).default(0),
  qcRequired: z.boolean().default(false),
});

const bomFields = {
  kind: z.enum(BOM_KINDS),
  outputQty: z.number().finite().positive().max(1_000_000_000),
  outputUnit: z.string().trim().min(1).max(40),
  expectedYield: z.number().finite().gt(0).max(1).nullish(),
  scrapAllowancePct: z.number().finite().min(0).max(100).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  lines: z.array(bomLineSchema).min(1, 'La lista necesita al menos un insumo').max(100),
  operations: z.array(bomOperationSchema).max(50).default([]),
};

export const createBomSchema = z.object({ outputZohoItemId: idText, ...bomFields });
export type CreateBomInput = z.input<typeof createBomSchema>;

export const updateBomSchema = z.object({ bomId: idText, ...bomFields });
export type UpdateBomInput = z.input<typeof updateBomSchema>;

export const activateBomSchema = z.object({ bomId: idText });
export const retireBomSchema = z.object({
  bomId: idText,
  reason: z.string().trim().max(500).optional(),
});

type BomDefinition = z.output<typeof updateBomSchema> & { outputZohoItemId: string };
type BomWithRouting = Bom & { lines: BomLine[]; operations: BomOperation[] };

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

export interface BomDefinitionIssue {
  path: string;
  message: string;
}

/** Structural rules of a BOM (pure): inputs, substitutes and routing sequence. */
export function validateBomDefinition(def: {
  kind: string;
  outputZohoItemId: string;
  lines: ReadonlyArray<{ inputZohoItemId: string; substituteZohoItemIds?: readonly string[] }>;
  operations: ReadonlyArray<{ seq: number }>;
}): BomDefinitionIssue[] {
  const issues: BomDefinitionIssue[] = [];
  const inputs = def.lines.map((line) => line.inputZohoItemId);
  const seenInputs = new Set<string>();
  def.lines.forEach((line, index) => {
    if (seenInputs.has(line.inputZohoItemId)) {
      issues.push({ path: `lines.${index}.inputZohoItemId`, message: `El insumo ${line.inputZohoItemId} está repetido` });
    }
    seenInputs.add(line.inputZohoItemId);
    if (def.kind === 'assembly' && line.inputZohoItemId === def.outputZohoItemId) {
      issues.push({ path: `lines.${index}.inputZohoItemId`, message: 'Un ensamble no puede consumir su propio producto' });
    }
    const substitutes = line.substituteZohoItemIds ?? [];
    const seenSubstitutes = new Set<string>();
    substitutes.forEach((substitute, subIndex) => {
      const path = `lines.${index}.substituteZohoItemIds.${subIndex}`;
      if (substitute === line.inputZohoItemId) {
        issues.push({ path, message: 'Un insumo no puede ser sustituto de sí mismo' });
      } else if (seenSubstitutes.has(substitute)) {
        issues.push({ path, message: `El sustituto ${substitute} está repetido` });
      } else if (inputs.includes(substitute)) {
        issues.push({ path, message: `El sustituto ${substitute} ya es un insumo de la lista` });
      } else if (substitute === def.outputZohoItemId) {
        issues.push({ path, message: 'El producto de salida no puede ser sustituto' });
      }
      seenSubstitutes.add(substitute);
    });
  });
  const seqs = new Set<number>();
  def.operations.forEach((op, index) => {
    if (seqs.has(op.seq)) {
      issues.push({ path: `operations.${index}.seq`, message: `La secuencia ${op.seq} está repetida` });
    }
    seqs.add(op.seq);
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sequence key of the revisions of an output item (hashed: item ids are free text). */
export function bomSequenceKey(outputZohoItemId: string): string {
  return `bom:${createHash('sha1').update(outputZohoItemId).digest('hex').slice(0, 32)}`;
}

/** Locks every revision of an output item (serializes activations). */
export async function lockBomsForOutput(tx: Db, outputZohoItemId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Bom" WHERE "outputZohoItemId" = ${outputZohoItemId}
    ORDER BY "id" FOR UPDATE`;
  return rows.map((row) => row.id);
}

async function loadBom(tx: Db, bomId: string): Promise<BomWithRouting> {
  const bom = await tx.bom.findUnique({
    where: { id: bomId },
    include: { lines: true, operations: true },
  });
  if (!bom) throw new OperationsError('not_found', 'No se encontró la lista de materiales');
  return bom as BomWithRouting;
}

async function assertDefinition(tx: Db, def: BomDefinition): Promise<void> {
  const issues = validateBomDefinition(def);
  if (issues.length > 0) {
    throw manufacturingError('bom_invalid', `Lista de materiales inválida: ${issues[0].message}`, { issues });
  }
  const output = await itemUnits(tx, def.outputZohoItemId);
  convertToBase(def.outputQty, def.outputUnit, output);
  for (const line of def.lines) {
    convertToBase(line.qtyPerOutput, line.unit, await itemUnits(tx, line.inputZohoItemId));
  }
  const centerIds = [...new Set(def.operations.map((op) => op.workCenterId))];
  if (centerIds.length > 0) {
    const centers = await tx.workCenter.findMany({ where: { id: { in: centerIds } }, select: { id: true } });
    const found = new Set(centers.map((center) => center.id));
    const missing = centerIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw manufacturingError('bom_invalid', 'Alguna operación usa un centro de trabajo que no existe', { workCenterIds: missing });
    }
  }
}

function decimalOrNull(value: number | null | undefined): Prisma.Decimal | null {
  return value === null || value === undefined ? null : new Prisma.Decimal(value);
}

async function writeRouting(tx: Db, bomId: string, def: BomDefinition): Promise<void> {
  await tx.bomLine.createMany({
    data: def.lines.map((line, index) => ({
      bomId,
      inputZohoItemId: line.inputZohoItemId,
      qtyPerOutput: new Prisma.Decimal(line.qtyPerOutput),
      unit: line.unit,
      substituteZohoItemIds: [...new Set(line.substituteZohoItemIds)],
      scrapPct: decimalOrNull(line.scrapPct),
      sortOrder: index,
    })),
  });
  if (def.operations.length > 0) {
    await tx.bomOperation.createMany({
      data: def.operations.map((op) => ({
        bomId,
        seq: op.seq,
        workCenterId: op.workCenterId,
        name: op.name,
        stdMinutes: op.stdMinutes,
        setupMinutes: op.setupMinutes,
        qcRequired: op.qcRequired,
      })),
    });
  }
}

function publishBom(ctx: ReturnType<typeof requireCommandContext>, bom: Pick<Bom, 'id' | 'status' | 'outputZohoItemId' | 'version'>): void {
  ctx.realtime(MANUFACTURING_FLOOR_CHANNEL, MANUFACTURING_REALTIME_TYPES.boms, {
    commandId: ctx.commandId,
    bomId: bom.id,
    outputZohoItemId: bom.outputZohoItemId,
    version: bom.version,
    status: bom.status,
  });
}

function bomEventOptions(bom: Pick<Bom, 'id'>) {
  return { areaKey: MANUFACTURING_AREA_KEY, objectType: MANUFACTURING_OBJECT_TYPES.bom, objectId: bom.id };
}

// ---------------------------------------------------------------------------
// Writers (inside commands)
// ---------------------------------------------------------------------------

export async function createBomInTx(tx: Db, input: z.output<typeof createBomSchema>): Promise<BomDTO> {
  const ctx = requireCommandContext(tx);
  const def: BomDefinition = { ...input, bomId: '' };
  await assertDefinition(tx, def);
  // The sequence row lock serializes creators of the same output; the max read after it
  // sees every committed revision (also the ones created before the sequence existed).
  const sequence = await nextSequenceValue(tx, bomSequenceKey(input.outputZohoItemId));
  const latest = await tx.bom.findFirst({
    where: { outputZohoItemId: input.outputZohoItemId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const version = Math.max(sequence, (latest?.version ?? 0) + 1);
  const bom = await tx.bom.create({
    data: {
      outputZohoItemId: input.outputZohoItemId,
      version,
      kind: input.kind,
      status: 'draft',
      outputQty: new Prisma.Decimal(input.outputQty),
      outputUnit: input.outputUnit,
      expectedYield: decimalOrNull(input.expectedYield),
      scrapAllowancePct: decimalOrNull(input.scrapAllowancePct),
      notes: input.notes ?? null,
    },
  });
  await writeRouting(tx, bom.id, def);
  const full = await loadBom(tx, bom.id);
  ctx.emit(
    MANUFACTURING_EVENTS.bomCreated,
    {
      bomId: bom.id,
      outputZohoItemId: bom.outputZohoItemId,
      version,
      kind: bom.kind,
      lines: full.lines.length,
      operations: full.operations.length,
    },
    bomEventOptions(bom)
  );
  publishBom(ctx, bom);
  return toBomDTO(full);
}

export async function updateBomDraftInTx(tx: Db, input: z.output<typeof updateBomSchema>): Promise<BomDTO> {
  const ctx = requireCommandContext(tx);
  const current = await loadBom(tx, input.bomId);
  if (current.status !== 'draft') {
    throw new OperationsError(
      'invalid_state',
      'Sólo se edita una lista en borrador; crea una nueva revisión para cambiar una activa'
    );
  }
  const def: BomDefinition = { ...input, outputZohoItemId: current.outputZohoItemId };
  await assertDefinition(tx, def);
  await tx.bomLine.deleteMany({ where: { bomId: current.id } });
  await tx.bomOperation.deleteMany({ where: { bomId: current.id } });
  await tx.bom.update({
    where: { id: current.id },
    data: {
      kind: input.kind,
      outputQty: new Prisma.Decimal(input.outputQty),
      outputUnit: input.outputUnit,
      expectedYield: decimalOrNull(input.expectedYield),
      scrapAllowancePct: decimalOrNull(input.scrapAllowancePct),
      notes: input.notes ?? null,
    },
  });
  await writeRouting(tx, current.id, def);
  const full = await loadBom(tx, current.id);
  ctx.emit(
    MANUFACTURING_EVENTS.bomUpdated,
    { bomId: full.id, version: full.version, lines: full.lines.length, operations: full.operations.length },
    bomEventOptions(full)
  );
  publishBom(ctx, full);
  return toBomDTO(full);
}

export async function activateBomInTx(tx: Db, input: z.output<typeof activateBomSchema>): Promise<BomDTO> {
  const ctx = requireCommandContext(tx);
  const initial = await loadBom(tx, input.bomId);
  await lockBomsForOutput(tx, initial.outputZohoItemId);
  const bom = await loadBom(tx, input.bomId);
  if (bom.status === 'active') {
    throw new OperationsError('invalid_state', 'La lista de materiales ya está activa');
  }
  if (bom.status !== 'draft') {
    throw new OperationsError('invalid_state', 'Una lista retirada no se reactiva; crea una nueva revisión');
  }
  if (bom.lines.length === 0) {
    throw manufacturingError('bom_invalid', 'La lista necesita al menos un insumo para activarse');
  }
  const centerIds = [...new Set(bom.operations.map((op) => op.workCenterId))];
  if (centerIds.length > 0) {
    const inactive = await tx.workCenter.findMany({
      where: { id: { in: centerIds }, status: { not: 'active' } },
      select: { name: true },
    });
    if (inactive.length > 0) {
      throw manufacturingError(
        'bom_invalid',
        `La ruta usa centros inactivos: ${inactive.map((center) => center.name).join(', ')}`
      );
    }
  }
  const previous = await tx.bom.findMany({
    where: { outputZohoItemId: bom.outputZohoItemId, status: 'active', id: { not: bom.id } },
    select: { id: true, version: true },
  });
  if (previous.length > 0) {
    await tx.bom.updateMany({
      where: { id: { in: previous.map((row) => row.id) } },
      data: { status: 'retired' },
    });
    for (const row of previous) {
      ctx.emit(
        MANUFACTURING_EVENTS.bomRetired,
        { bomId: row.id, version: row.version, outputZohoItemId: bom.outputZohoItemId, replacedByBomId: bom.id },
        bomEventOptions(row)
      );
    }
  }
  await tx.bom.update({ where: { id: bom.id }, data: { status: 'active' } });
  const full = await loadBom(tx, bom.id);
  ctx.emit(
    MANUFACTURING_EVENTS.bomActivated,
    {
      bomId: full.id,
      outputZohoItemId: full.outputZohoItemId,
      version: full.version,
      retiredBomIds: previous.map((row) => row.id),
    },
    bomEventOptions(full)
  );
  publishBom(ctx, full);
  return toBomDTO(full);
}

export async function retireBomInTx(tx: Db, input: z.output<typeof retireBomSchema>): Promise<BomDTO> {
  const ctx = requireCommandContext(tx);
  const bom = await loadBom(tx, input.bomId);
  if (bom.status === 'retired') {
    throw new OperationsError('invalid_state', 'La lista de materiales ya está retirada');
  }
  await tx.bom.update({ where: { id: bom.id }, data: { status: 'retired' } });
  const full = await loadBom(tx, bom.id);
  ctx.emit(
    MANUFACTURING_EVENTS.bomRetired,
    {
      bomId: full.id,
      outputZohoItemId: full.outputZohoItemId,
      version: full.version,
      previousStatus: bom.status,
      reason: input.reason ?? null,
    },
    bomEventOptions(full)
  );
  publishBom(ctx, full);
  return toBomDTO(full);
}

/** Active revision of an output item, with its lines and routing. */
export async function getActiveBom(db: Db, outputZohoItemId: string): Promise<BomWithRouting | null> {
  const bom = await db.bom.findFirst({
    where: { outputZohoItemId, status: 'active' },
    orderBy: { version: 'desc' },
    include: { lines: true, operations: true },
  });
  return (bom as BomWithRouting | null) ?? null;
}

export async function loadBomWithRouting(db: Db, bomId: string): Promise<BomWithRouting> {
  return loadBom(db, bomId);
}
