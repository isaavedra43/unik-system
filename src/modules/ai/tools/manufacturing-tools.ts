import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { PRODUCTION_ORDER_STATUSES } from '@/modules/manufacturing/manufacturing-types';
import { orderActionError } from '@/modules/manufacturing/production-state';
import {
  OperationsToolError,
  assertCaseInAgentScope,
  assertReadingScope,
  canActForArea,
  checkActingScope,
  creationCommandId,
  isBotActor,
  loadOperationsCommands,
  registerOperationsTool,
  resolveCase,
  truncateText,
  unwrapCommand,
} from './operations-tool-kit';
import type { ToolExecutionContext } from './registry';

/**
 * Manufacturing tools (plan 6.2 / 6.6): read the orders and the floor board,
 * draft a transformation order, and record production output and scrap.
 *
 * - Readings are limited to the actor's area for bots (the administrator reads all).
 * - Writes go through the manufacturing commands (the engine checks
 *   `manufacturing.manage_orders` / `manufacturing.operate` again). A bot acts only
 *   for Manufactura and, in a mention turn, with the limits of the person who
 *   mentioned it; a person executing an agent proposal is bound to its area.
 * - `createTransformationOrderDraft` is a `draft`: it creates the order in
 *   `draft` without committing material. Output and scrap are `business_write`
 *   and become an approval card; exceeding the scrap tolerance opens the
 *   production incident and its business approval.
 */

const AREA = 'manufactura' as const;
const idArg = z.string().trim().min(1).max(120);

async function actingReason(actor: CurrentUser, ctx?: ToolExecutionContext): Promise<string | null> {
  const scope = checkActingScope(actor, AREA, ctx);
  if (scope) return scope;
  return isBotActor(actor) ? canActForArea(actor, AREA, ctx) : null;
}

async function assertMayAct(actor: CurrentUser, ctx?: ToolExecutionContext): Promise<void> {
  const reason = await actingReason(actor, ctx);
  if (reason) throw new OperationsToolError(reason, 'forbidden');
}

/** Order by folio (`OP-123`, `OP-000123`) or id. */
export async function resolveProductionOrderRef(ref: string) {
  const value = String(ref ?? '').trim();
  if (!value) throw new OperationsToolError('Indica la orden de producción', 'invalid_args');
  const folio = /^op-?(\d{1,12})$/i.exec(value);
  const order = folio
    ? await prisma.productionOrder.findUnique({ where: { number: `OP-${folio[1].padStart(6, '0')}` } })
    : await prisma.productionOrder.findUnique({ where: { id: value } });
  if (!order) throw new OperationsToolError(`No se encontró la orden de producción ${value}`, 'not_found');
  return order;
}

/** Catalog item by Zoho id or SKU. */
export async function resolveCatalogItem(ref: string): Promise<{ zohoItemId: string; name: string | null; sku: string | null; unit: string | null }> {
  const value = String(ref ?? '').trim();
  if (!value) throw new OperationsToolError('Indica el artículo', 'invalid_args');
  const select = { zohoItemId: true, name: true, sku: true, unit: true } as const;
  const product =
    (await prisma.product.findUnique({ where: { zohoItemId: value }, select })) ??
    (await prisma.product.findFirst({ where: { sku: { equals: value, mode: 'insensitive' } }, select, orderBy: { zohoItemId: 'asc' } }));
  if (!product) throw new OperationsToolError(`No se encontró el artículo ${value} en el catálogo`, 'not_found');
  return product;
}

async function workCenterIdOf(key: string | undefined): Promise<string | undefined> {
  if (!key) return undefined;
  const center = await prisma.workCenter.findUnique({ where: { key: key.trim().toLowerCase() }, select: { id: true } });
  if (!center) throw new OperationsToolError(`No existe el centro de trabajo ${key}`, 'not_found');
  return center.id;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// listProductionOrders
// ---------------------------------------------------------------------------

const listParams = z.object({
  scope: z.enum(['open', 'closed', 'all']).describe('open = en curso; closed = liberadas o canceladas').default('open'),
  status: z.array(z.enum(PRODUCTION_ORDER_STATUSES)).max(9).describe('Estados a incluir').optional(),
  caseId: z.string().trim().max(60).describe('Expediente (EXP-123, OV-… o id)').optional(),
  workCenter: z.string().trim().max(60).describe('Clave del centro de trabajo').optional(),
  q: z.string().trim().max(100).describe('Folio OP- o nombre del producto').optional(),
  limit: z.number().int().min(1).max(50).describe('Cuántas órdenes mostrar').default(15),
});
type ListArgs = z.output<typeof listParams>;

registerOperationsTool({
  name: 'listProductionOrders',
  description:
    'Órdenes de producción (OP-) con su estado, producto, cantidad planeada y producida, centro de trabajo, expediente, motivo de bloqueo y las acciones que puedes hacer.',
  requiredPermission: 'manufacturing.view',
  effect: 'read',
  parameters: listParams,
  execute: async (actor, raw, ctx) => {
    const args = raw as ListArgs;
    assertReadingScope(actor, AREA, ctx);
    let caseId: string | undefined;
    if (args.caseId) {
      const ref = await resolveCase(args.caseId);
      await assertCaseInAgentScope(actor, ref.id, ctx);
      caseId = ref.id;
    }
    const { listProductionOrders } = await import('@/modules/manufacturing/manufacturing-queries');
    const page = await listProductionOrders(
      actor,
      compact({
        scope: args.scope,
        status: args.status,
        caseId,
        workCenterId: await workCenterIdOf(args.workCenter),
        q: args.q,
        sort: 'planned' as const,
        pageSize: args.limit,
      })
    );
    return {
      total: page.total,
      shown: page.rows.length,
      orders: page.rows.map((order) => ({
        id: order.id,
        number: order.number,
        status: order.statusLabel,
        product: order.outputName ?? order.outputSku ?? order.outputZohoItemId,
        planned: `${order.plannedQty} ${order.plannedUnit}`,
        produced: order.producedQty,
        scrap: order.scrapQty,
        priority: order.priority,
        workCenter: order.workCenterName,
        caseNumber: order.caseNumber,
        plannedStartAt: order.plannedStartAt,
        blockedReason: order.blockedReason,
        allowedActions: order.allowedActions,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// getProductionBoard
// ---------------------------------------------------------------------------

const boardParams = z.object({
  workCenter: z.string().trim().max(60).describe('Clave del centro de trabajo').optional(),
  days: z.number().int().min(1).max(7).describe('Días de carga por turno a revisar').default(2),
});
type BoardArgs = z.output<typeof boardParams>;

registerOperationsTool({
  name: 'getProductionBoard',
  description:
    'Tablero de planta: cuántas órdenes hay por estado (con las más urgentes), qué se está produciendo en cada centro, la cola y la carga por turno con sobrecargas.',
  requiredPermission: 'manufacturing.view',
  effect: 'read',
  parameters: boardParams,
  execute: async (actor, raw, ctx) => {
    const args = raw as BoardArgs;
    assertReadingScope(actor, AREA, ctx);
    const { getProductionBoard } = await import('@/modules/manufacturing/manufacturing-queries');
    const board = await getProductionBoard(actor, compact({ workCenterId: await workCenterIdOf(args.workCenter), days: args.days, perColumn: 5 }));
    return {
      generatedAt: board.generatedAt,
      columns: board.columns
        .filter((column) => column.count > 0)
        .map((column) => ({
          status: column.label,
          count: column.count,
          top: column.orders.map((order) =>
            truncateText(
              `${order.number} · ${order.outputName ?? order.outputZohoItemId} · ${order.plannedQty} ${order.plannedUnit}${order.priority !== 'normal' ? ` · ${order.priority}` : ''}${order.blockedReason ? ` · ${order.blockedReason}` : ''}`,
              240
            )
          ),
        })),
      workCenters: board.workCenters.map((center) => ({
        name: center.workCenter.name,
        capacity: `${center.workCenter.capacityPerShift} ${center.workCenter.capacityUnitLabel} por turno`,
        running: center.running.map((op) => `${op.number} · ${op.name}`),
        queued: center.queued,
        overloadedShifts: center.summary.overloadedWindows,
        peakUtilizationPct: center.summary.peakUtilizationPct,
        nextShifts: center.windows.slice(0, 4).map((window) => ({
          shift: window.shiftName,
          day: window.day,
          load: window.load,
          capacity: window.capacity,
          utilizationPct: window.utilizationPct,
          overloaded: window.overloaded,
        })),
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// createTransformationOrderDraft
// ---------------------------------------------------------------------------

const draftParams = z.object({
  inputSku: z.string().trim().min(1).max(120).describe('SKU o id del material de entrada'),
  inputQty: z.number().positive().describe('Cantidad de material que se consumirá (incluida la merma esperada)'),
  inputUnit: z.string().trim().max(40).describe('Unidad del material; por omisión su unidad base').optional(),
  outputSku: z.string().trim().min(1).max(120).describe('SKU o id del producto terminado; por omisión el de la partida').optional(),
  plannedQty: z.number().positive().describe('Cantidad a producir; por omisión la de la partida').optional(),
  plannedUnit: z.string().trim().max(40).describe('Unidad de la cantidad a producir').optional(),
  caseId: z.string().trim().max(60).describe('Expediente (EXP-123 u OV-…)').optional(),
  demandId: idArg.describe('Partida del expediente que se surte').optional(),
  workCenter: z.string().trim().max(60).describe('Clave del centro de trabajo; por omisión el primero activo').optional(),
  plannedStartAt: z.string().trim().max(40).describe('Inicio planeado en ISO (AAAA-MM-DDTHH:mm)').optional(),
  scrapAllowancePct: z.number().min(0).max(100).describe('Merma permitida en %, por omisión 5').optional(),
});
type DraftArgs = z.output<typeof draftParams>;

registerOperationsTool({
  name: 'createTransformationOrderDraft',
  description:
    'Crea en BORRADOR una orden de transformación (material de entrada → producto terminado + merma, operación "Corte/acabado"), opcionalmente ligada a una partida de expediente. No reserva material: después se reservan materiales y se prepara desde Manufactura.',
  requiredPermission: 'manufacturing.manage_orders',
  effect: 'draft',
  parameters: draftParams,
  execute: async (actor, raw, ctx) => {
    const args = raw as DraftArgs;
    await assertMayAct(actor, ctx);
    let caseId: string | undefined;
    if (args.caseId) {
      const ref = await resolveCase(args.caseId);
      await assertCaseInAgentScope(actor, ref.id, ctx);
      caseId = ref.id;
    }
    const demand = args.demandId ? await prisma.caseDemand.findUnique({ where: { id: args.demandId } }) : null;
    if (args.demandId && !demand) throw new OperationsToolError('No se encontró la partida del expediente', 'not_found');
    if (demand && caseId && demand.caseId !== caseId) {
      throw new OperationsToolError('La partida no pertenece a ese expediente', 'invalid_args');
    }
    if (demand && !caseId) {
      await assertCaseInAgentScope(actor, demand.caseId, ctx);
      caseId = demand.caseId;
    }
    const allocation = demand
      ? await prisma.demandAllocation.findFirst({
          where: { demandId: demand.id, source: 'manufacture', status: { notIn: ['cancelled', 'released', 'delivered'] } },
          orderBy: { createdAt: 'asc' },
        })
      : null;
    if (allocation) {
      const existing = await prisma.productionOrder.findFirst({
        where: { demandAllocationId: allocation.id, status: { not: 'cancelled' } },
        select: { id: true, number: true, status: true },
      });
      if (existing) {
        return { productionOrderId: existing.id, number: existing.number, status: existing.status, existing: true, note: `La partida ya tiene la orden ${existing.number}` };
      }
    }
    const input = await resolveCatalogItem(args.inputSku);
    const output = args.outputSku ? await resolveCatalogItem(args.outputSku) : null;
    if (!output && !demand?.zohoItemId) {
      throw new OperationsToolError('Indica el producto terminado (outputSku) o la partida del expediente', 'invalid_args');
    }
    const payload = compact({
      outputZohoItemId: output?.zohoItemId,
      plannedQty: args.plannedQty,
      plannedUnit: args.plannedUnit,
      inputs: [compact({ zohoItemId: input.zohoItemId, qty: args.inputQty, unit: args.inputUnit })],
      scrapAllowancePct: args.scrapAllowancePct,
      caseId,
      demandId: demand?.id,
      demandAllocationId: allocation?.id,
      workCenterId: await workCenterIdOf(args.workCenter),
      plannedStartAt: args.plannedStartAt,
      reserveNow: false,
    });
    await loadOperationsCommands();
    const { createTransformationOrder } = await import('@/modules/manufacturing/manufacturing-commands');
    const result = unwrapCommand(
      await createTransformationOrder(actor, payload, {
        commandId: creationCommandId('createTransformationOrderDraft', actor.id, payload, ctx),
      })
    );
    const data = result.data;
    return {
      productionOrderId: data?.productionOrderId ?? null,
      number: data?.number ?? null,
      status: data?.status ?? result.status,
      workCenterId: data?.workCenterId ?? null,
      plannedStartAt: data?.schedule?.plannedStartAt ?? null,
      overloaded: data?.schedule?.overloaded ?? false,
      note: 'Borrador creado: falta reservar materiales y prepararla desde Manufactura.',
    };
  },
});

// ---------------------------------------------------------------------------
// recordProductionOutput / reportScrap
// ---------------------------------------------------------------------------

const dimensionsArg = z.object({
  largo: z.number().positive(),
  ancho: z.number().positive().optional(),
  espesor: z.number().positive().optional(),
  unidad: z.string().trim().min(1).max(10),
});

const outputParams = z.object({
  productionOrder: z.string().trim().min(1).max(120).describe('Folio OP-000123 o id de la orden'),
  kind: z.enum(['finished', 'leftover']).describe('finished = producto terminado; leftover = sobrante vendible').default('finished'),
  qty: z.number().positive().describe('Cantidad'),
  unit: z.string().trim().max(40).describe('Unidad; por omisión la de la orden (terminado) o la del material (sobrante)').optional(),
  materialSku: z.string().trim().max(120).describe('Material del sobrante cuando la orden tiene varios').optional(),
  dimensions: dimensionsArg.describe('Medidas del sobrante (obligatorias para leftover)').optional(),
  locationCode: z.string().trim().max(40).describe('Ubicación de bodega').optional(),
  orderNumber: z.string().max(40).describe('Lo completa el sistema').optional(),
  productName: z.string().max(300).describe('Lo completa el sistema').optional(),
});
type OutputArgs = z.output<typeof outputParams>;

const scrapParams = z.object({
  productionOrder: z.string().trim().min(1).max(120).describe('Folio OP-000123 o id de la orden'),
  qty: z.number().positive().describe('Cantidad de merma'),
  unit: z.string().trim().max(40).describe('Unidad; por omisión la del material').optional(),
  materialSku: z.string().trim().max(120).describe('Material de la merma cuando la orden tiene varios').optional(),
  reason: z.string().trim().min(3).max(500).describe('Causa de la merma'),
  orderNumber: z.string().max(40).describe('Lo completa el sistema').optional(),
});
type ScrapArgs = z.output<typeof scrapParams>;

async function preparedOrder(
  actor: CurrentUser,
  ref: string,
  action: 'record_finished_output' | 'record_other_output',
  ctx?: ToolExecutionContext
): Promise<{ error: string } | { order: Awaited<ReturnType<typeof resolveProductionOrderRef>> }> {
  const reason = await actingReason(actor, ctx);
  if (reason) return { error: reason };
  const order = await resolveProductionOrderRef(ref);
  if (order.caseId) {
    try {
      await assertCaseInAgentScope(actor, order.caseId, ctx);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'El expediente de la orden está fuera de tu alcance' };
    }
  }
  const stateError = orderActionError(action, order.status);
  if (stateError) return { error: `${order.number}: ${stateError}` };
  return { order };
}

registerOperationsTool({
  name: 'recordProductionOutput',
  description:
    'Registra la salida de una orden de producción: producto terminado (después de la inspección aprobada) o sobrante vendible con sus medidas. Entra al inventario con trazabilidad a la orden. Queda como propuesta para el responsable.',
  requiredPermission: 'manufacturing.operate',
  effect: 'business_write',
  parameters: outputParams,
  summarize: (raw) => {
    const a = raw as OutputArgs;
    const target = a.orderNumber ?? a.productionOrder;
    if (a.kind === 'leftover') {
      const measures = a.dimensions
        ? ` (${[a.dimensions.largo, a.dimensions.ancho, a.dimensions.espesor].filter((value) => value !== undefined).join('×')} ${a.dimensions.unidad})`
        : '';
      return `Registrar sobrante de ${a.qty} ${a.unit ?? ''}${measures} en ${target}`.replace(/\s+/g, ' ');
    }
    return `Registrar ${a.qty} ${a.unit ?? ''} de producto terminado${a.productName ? ` (${a.productName})` : ''} en ${target}`.replace(/\s+/g, ' ');
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as OutputArgs;
    const prepared = await preparedOrder(actor, args.productionOrder, args.kind === 'finished' ? 'record_finished_output' : 'record_other_output', ctx);
    if ('error' in prepared) return prepared;
    const { order } = prepared;
    if (args.kind === 'leftover' && !args.dimensions) {
      return { error: 'Indica las medidas del sobrante (largo, ancho y unidad)' };
    }
    return {
      args: compact({
        ...args,
        productionOrder: order.id,
        unit: args.unit ?? (args.kind === 'finished' ? order.plannedUnit : undefined),
        orderNumber: order.number,
        productName: truncateText(order.outputName ?? order.outputZohoItemId, 300),
      }),
    };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as OutputArgs;
    await assertMayAct(actor, ctx);
    const order = await resolveProductionOrderRef(args.productionOrder);
    const material = args.materialSku ? await resolveCatalogItem(args.materialSku) : null;
    const payload = compact({
      productionOrderId: order.id,
      kind: args.kind,
      qty: args.qty,
      unit: args.unit,
      zohoItemId: material?.zohoItemId,
      dimensions: args.dimensions,
      locationCode: args.locationCode,
    });
    await loadOperationsCommands();
    const { recordOutput } = await import('@/modules/manufacturing/manufacturing-commands');
    const result = unwrapCommand(
      await recordOutput(actor, payload, { commandId: creationCommandId('recordProductionOutput', actor.id, payload, ctx) })
    );
    const data = result.data;
    return {
      orderNumber: order.number,
      outputId: data?.outputId ?? null,
      kind: args.kind,
      quantity: data ? `${data.quantity} ${data.unit}` : `${args.qty} ${args.unit ?? ''}`.trim(),
      movementId: data?.movementId ?? null,
      containerKey: data?.containerKey || null,
      producedQty: data?.producedQty ?? null,
    };
  },
});

registerOperationsTool({
  name: 'reportScrap',
  description:
    'Reporta merma de una orden de producción (entra bloqueada a la ubicación de merma). Si supera la tolerancia se abre una incidencia y una aprobación que bloquea la liberación. Queda como propuesta para el responsable.',
  requiredPermission: 'manufacturing.operate',
  effect: 'business_write',
  parameters: scrapParams,
  summarize: (raw) => {
    const a = raw as ScrapArgs;
    return truncateText(`Reportar merma de ${a.qty} ${a.unit ?? ''} en ${a.orderNumber ?? a.productionOrder}: ${a.reason}`.replace(/\s+/g, ' '), 300);
  },
  prepareArgs: async (actor, raw, ctx) => {
    const args = raw as ScrapArgs;
    const prepared = await preparedOrder(actor, args.productionOrder, 'record_other_output', ctx);
    if ('error' in prepared) return prepared;
    return { args: { ...args, productionOrder: prepared.order.id, orderNumber: prepared.order.number } };
  },
  execute: async (actor, raw, ctx) => {
    const args = raw as ScrapArgs;
    await assertMayAct(actor, ctx);
    const order = await resolveProductionOrderRef(args.productionOrder);
    const material = args.materialSku ? await resolveCatalogItem(args.materialSku) : null;
    const payload = compact({
      productionOrderId: order.id,
      kind: 'scrap' as const,
      qty: args.qty,
      unit: args.unit,
      zohoItemId: material?.zohoItemId,
      reason: args.reason,
    });
    await loadOperationsCommands();
    const { recordOutput } = await import('@/modules/manufacturing/manufacturing-commands');
    const result = unwrapCommand(
      await recordOutput(actor, payload, { commandId: creationCommandId('reportScrap', actor.id, payload, ctx) })
    );
    const scrap = result.data?.scrap ?? null;
    return {
      orderNumber: order.number,
      outputId: result.data?.outputId ?? null,
      quantity: result.data ? `${result.data.quantity} ${result.data.unit}` : `${args.qty} ${args.unit ?? ''}`.trim(),
      scrap,
      note: scrap?.exceeded
        ? 'La merma supera la tolerancia: se abrió una incidencia y se pidió aprobación; la orden no se libera hasta que se apruebe.'
        : scrap?.pending
          ? 'Aún no hay consumo registrado para evaluar la tolerancia de merma.'
          : 'Merma dentro de la tolerancia.',
    };
  },
});
