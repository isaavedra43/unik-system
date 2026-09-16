import { z } from 'zod';
import { resolveScan } from '@/modules/inventory/labels-service';
import { requireCommandContext, OperationsError } from '@/modules/operations/commands';
import { DELIVERY_ORDER_OPEN_STATUSES, LOGISTICS_EVENTS, LOGISTICS_OBJECT_TYPES } from './types';
import { loadDeliveryOrder, publishDeliveryChange, type Tx } from './logistics-helpers';

/**
 * Container reads at the loading dock and at dispatch. The command resolves the
 * QR on the server, checks that it belongs to an allocation of this delivery,
 * and records one immutable row per physical item and phase.
 */
export const scanDeliveryContainerSchema = z
  .object({
    deliveryOrderId: z.string().trim().min(1).max(120),
    code: z.string().trim().min(1, 'Escanea o escribe el código').max(200),
    phase: z.enum(['loading', 'dispatch']),
  })
  .strict();
export type ScanDeliveryContainerInput = z.infer<typeof scanDeliveryContainerSchema>;

export interface ScanDeliveryContainerResult {
  scanId: string;
  deliveryOrderId: string;
  stockItemId: string;
  containerKey: string;
  phase: 'loading' | 'dispatch';
  created: boolean;
}

export async function scanDeliveryContainer(
  tx: Tx,
  input: ScanDeliveryContainerInput
): Promise<ScanDeliveryContainerResult> {
  const ctx = requireCommandContext(tx);
  const order = await loadDeliveryOrder(tx, input.deliveryOrderId);
  if (!(DELIVERY_ORDER_OPEN_STATUSES as readonly string[]).includes(order.status)) {
    throw new OperationsError('invalid_state', 'No se puede escanear una entrega cerrada');
  }
  if (order.mode !== 'own_fleet') {
    throw new OperationsError(
      'invalid_state',
      'El escaneo de contenedores se usa en entregas cargadas por la flotilla propia'
    );
  }
  if (input.phase === 'dispatch' && !order.tripId) {
    throw new OperationsError(
      'invalid_state',
      'Carga la entrega en un viaje antes de marcarla como despachada'
    );
  }

  const resolution = await resolveScan(input.code, { db: tx });
  if (resolution.kind !== 'stock_item' || !resolution.stockItem.containerKey) {
    throw new OperationsError(
      'invalid_payload',
      'Escanea la etiqueta QR de un contenedor, rollo o placa identificados'
    );
  }
  const scanned = resolution.stockItem;
  const allocations = await tx.demandAllocation.findMany({
    where: { id: { in: order.allocationIds } },
    select: { demandId: true },
  });
  const demands = await tx.caseDemand.findMany({
    where: { id: { in: allocations.map((allocation) => allocation.demandId) } },
    select: { id: true, zohoItemId: true, variantKey: true },
  });
  const belongsToDelivery = demands.some(
    (demand) => demand.zohoItemId === scanned.zohoItemId && demand.variantKey === scanned.variantKey
  );
  if (!belongsToDelivery) {
    throw new OperationsError(
      'invalid_payload',
      'El contenedor escaneado no corresponde a ninguna partida de esta entrega'
    );
  }

  const existing = await tx.deliveryContainerScan.findUnique({
    where: {
      deliveryOrderId_stockItemId_phase: {
        deliveryOrderId: order.id,
        stockItemId: scanned.id,
        phase: input.phase,
      },
    },
  });
  if (existing) {
    return {
      scanId: existing.id,
      deliveryOrderId: order.id,
      stockItemId: existing.stockItemId,
      containerKey: existing.containerKey,
      phase: existing.phase as 'loading' | 'dispatch',
      created: false,
    };
  }

  const created = await tx.deliveryContainerScan.create({
    data: {
      deliveryOrderId: order.id,
      stockItemId: scanned.id,
      containerKey: scanned.containerKey,
      phase: input.phase,
      scannedBy: ctx.actor.id,
      scannedAt: ctx.now,
      commandId: ctx.commandId,
    },
  });
  await ctx.relate(
    { type: LOGISTICS_OBJECT_TYPES.deliveryOrder, id: order.id },
    { type: 'stock_item', id: scanned.id },
    input.phase === 'loading' ? 'loaded_container' : 'dispatched_container'
  );
  ctx.emit(
    LOGISTICS_EVENTS.delivery.containerScanned,
    {
      deliveryOrderId: order.id,
      stockItemId: scanned.id,
      containerKey: scanned.containerKey,
      phase: input.phase,
      scanId: created.id,
    },
    {
      caseId: order.caseId,
      areaKey: 'logistica',
      objectType: LOGISTICS_OBJECT_TYPES.deliveryOrder,
      objectId: order.id,
    }
  );
  publishDeliveryChange(ctx, order);
  return {
    scanId: created.id,
    deliveryOrderId: order.id,
    stockItemId: scanned.id,
    containerKey: scanned.containerKey,
    phase: input.phase,
    created: true,
  };
}
