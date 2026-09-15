import { Prisma } from '@prisma/client';
import {
  onDeliveryRecorded,
  type DeliveryRecordedEvent,
} from '@/modules/logistics/delivery-service';
import { isOperationsError } from '@/modules/operations/errors';
import { qty } from './inventory-dto';
import { lockStockItems } from './inventory-locks';
import { consumeReservation } from './inventory-service';
import { INVENTORY_AREA_KEY } from './inventory-types';
import { dec, roundQty } from './stock-math';

/**
 * Inventory reaction to a recorded delivery (plan section 4, step 3): the
 * stock reservations of every delivered allocation are consumed with an
 * `issue` movement that references the delivery order, inside the delivery
 * transaction (`onDeliveryRecorded` of logistics).
 *
 * - A partial delivery consumes only the delivered quantity; the rest stays
 *   reserved for the remainder delivery order.
 * - Reservations are found by `allocationId` (a reservation split across
 *   locations has several rows) plus the allocation's primary reservation.
 * - Allocations without an active reservation (direct supplier, stock already
 *   issued) are skipped.
 * - A business rejection of inventory (e.g. the physical book no longer covers
 *   a CONTROLLED reservation) never undoes what the driver delivered: it opens
 *   a `stock_conflict` incident for Inventario and the delivery goes on.
 *   Unexpected errors still reject the delivery command.
 */

type Tx = Prisma.TransactionClient;

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ component: 'inventory-delivery-consumption', event, ...extra }));

export interface DeliveryConsumption {
  allocationId: string;
  reservationId: string;
  movementId: string | null;
  /** Base unit quantity consumed ('0' when inventory rejected it). */
  quantity: string;
  /** Code of the inventory rejection turned into an incident. */
  rejectedCode: string | null;
}

export async function consumeDeliveredReservations(
  tx: Tx,
  event: DeliveryRecordedEvent
): Promise<DeliveryConsumption[]> {
  const delivered = event.summary.lines.filter((line) => line.deliveredQty > 0);
  if (delivered.length === 0) return [];
  const { ctx, deliveryOrder } = event;

  const allocations = await tx.demandAllocation.findMany({
    where: { id: { in: delivered.map((line) => line.allocationId) } },
    select: { id: true, stockReservationId: true },
  });
  const primaryReservation = new Map(allocations.map((a) => [a.id, a.stockReservationId]));

  const reservationsByLine = new Map<
    string,
    Awaited<ReturnType<typeof tx.stockReservation.findMany>>
  >();
  for (const line of delivered) {
    const primary = primaryReservation.get(line.allocationId) ?? null;
    reservationsByLine.set(
      line.allocationId,
      await tx.stockReservation.findMany({
        where: {
          status: 'active',
          OR: [{ allocationId: line.allocationId }, ...(primary ? [{ id: primary }] : [])],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    );
  }
  // Every row of the delivery is locked up front in id order (the order reservations use).
  await lockStockItems(
    tx,
    [...reservationsByLine.values()].flat().map((reservation) => reservation.stockItemId)
  );

  const consumed: DeliveryConsumption[] = [];
  for (const line of delivered) {
    const reservations = reservationsByLine.get(line.allocationId) ?? [];
    let remaining = roundQty(dec(line.deliveredQty));
    for (const reservation of reservations) {
      if (remaining.lte(0)) break;
      const quantity = roundQty(Prisma.Decimal.min(remaining, reservation.quantity));
      try {
        const result = await consumeReservation(
          tx,
          {
            reservationId: reservation.id,
            quantity,
            kind: 'issue',
            referenceType: 'delivery_order',
            referenceId: deliveryOrder.id,
            note: `Entrega ${deliveryOrder.id}`,
          },
          ctx
        );
        consumed.push({
          allocationId: line.allocationId,
          reservationId: reservation.id,
          movementId: result.movement.id,
          quantity: qty(result.quantityBase),
          rejectedCode: null,
        });
        remaining = roundQty(remaining.minus(quantity));
      } catch (err) {
        if (!isOperationsError(err)) throw err;
        await ctx.openIncident({
          kind: 'stock_conflict',
          areaKey: INVENTORY_AREA_KEY,
          severity: 'medium',
          title: 'Entrega registrada sin poder descontar la reserva',
          dedupeKey: `delivery_consumption:${deliveryOrder.id}:${reservation.id}`,
          caseId: deliveryOrder.caseId,
          detail: {
            deliveryOrderId: deliveryOrder.id,
            allocationId: line.allocationId,
            reservationId: reservation.id,
            quantity: qty(quantity),
            code: err.code,
            message: err.message,
          },
        });
        consumed.push({
          allocationId: line.allocationId,
          reservationId: reservation.id,
          movementId: null,
          quantity: '0',
          rejectedCode: err.code,
        });
        log('reservation_consumption_rejected', {
          deliveryOrderId: deliveryOrder.id,
          reservationId: reservation.id,
          code: err.code,
          commandId: ctx.commandId,
        });
      }
    }
  }
  if (consumed.length > 0) {
    log('delivery_reservations_consumed', {
      deliveryOrderId: deliveryOrder.id,
      reservations: consumed.length,
      rejected: consumed.filter((c) => c.rejectedCode).length,
      commandId: ctx.commandId,
    });
  }
  return consumed;
}

type GlobalWithDeliveryConsumption = typeof globalThis & {
  __unikDeliveryConsumptionUnsubscribe?: () => void;
};

/** Subscribes once per module evaluation, replacing a previous subscription (hot reload, tests). */
export function registerDeliveryConsumption(): void {
  const scope = globalThis as GlobalWithDeliveryConsumption;
  scope.__unikDeliveryConsumptionUnsubscribe?.();
  scope.__unikDeliveryConsumptionUnsubscribe = onDeliveryRecorded(async (tx, event) => {
    await consumeDeliveredReservations(tx, event);
  });
}

registerDeliveryConsumption();
