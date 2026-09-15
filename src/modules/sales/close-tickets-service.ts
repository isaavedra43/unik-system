import { prisma } from '@/lib/prisma';
import { ZohoApiError } from '@/modules/integrations/zoho/client';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import { getSalesOrder } from '@/modules/integrations/zoho/sales-orders';
import { ENTITY_TYPE as SALES_ORDER_ENTITY_TYPE } from '@/modules/integrations/zoho/sales-orders-sync';
import {
  addSalesOrderComment,
  createInvoiceFromSalesOrder,
  createPackageForSalesOrder,
  extractCreatedPackageId,
  extractInvoice,
  markInvoiceSent,
  readSalesOrderForClose,
  type ZohoSalesOrderCloseView,
} from '@/modules/integrations/zoho/sales-order-close';
import {
  createShipmentOrder,
  extractShipmentOrder,
  markShipmentDelivered,
} from '@/modules/integrations/zoho/shipments';
import { SOURCE, withZohoRateBudget } from '@/modules/integrations/zoho/zoho-sync-engine';
import { recordAuditEvent } from '@/modules/auth/audit-service';

/**
 * "Cierre de ticket": closes a sales order in Zoho by completing what Zoho
 * needs to close it on its own (Zoho has no "mark as closed" endpoint):
 *   1. Invoice it (Books /invoices/fromsalesorder) and mark the invoice as sent.
 *   2. Package what is not packed yet (Inventory POST /packages).
 *   3. Ship every package without a shipment order and mark all as delivered.
 *   4. Leave the comment CLOSE_TICKET_COMMENT on the sales order.
 *   5. Re-read the order from Zoho and mirror its statuses in UNIK.
 * Every step re-checks the current Zoho state first, so running it again on
 * the same order does not duplicate invoices, packages or shipments.
 * With ZOHO_BOOKS_MOCK=true nothing is sent to Zoho; statuses are simulated.
 */

export const CLOSE_TICKET_COMMENT = 'cierre de ticket por claude';
export const CLOSE_TICKETS_MAX_ORDERS = 200;
const FALLBACK_CARRIER = 'Entrega directa';

export type CloseTicketOutcome = 'closed' | 'partial' | 'skipped' | 'failed';

export interface CloseTicketResult {
  orderId: string;
  salesOrderNumber: string | null;
  outcome: CloseTicketOutcome;
  finalStatus: string | null;
  steps: string[];
  error?: string;
}

interface Actor {
  id: string;
}

const lower = (v: string | null | undefined) => (v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const DELIVERED = new Set(['delivered', 'fulfilled']);
const todayMx = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

function describeError(error: unknown): string {
  if (error instanceof ZohoApiError) return error.zohoMessage ?? `Zoho respondió ${error.httpStatus ?? 'con error'}`;
  if (error instanceof Error && error.message.startsWith('Invalid or missing Zoho'))
    return 'Faltan credenciales de Zoho en el servidor';
  return error instanceof Error ? error.message : 'Error desconocido';
}

const zoho = <T>(call: () => Promise<T>) => withZohoRateBudget(call);

async function readZohoOrder(zohoSalesOrderId: string): Promise<ZohoSalesOrderCloseView> {
  const view = readSalesOrderForClose(await zoho(() => getSalesOrder(zohoSalesOrderId)));
  if (!view) throw new Error('Zoho no devolvió la orden de venta');
  return view;
}

/** Mirrors Zoho's statuses in UNIK now and flags the order so the sync refreshes the full record. */
async function mirrorStatuses(orderId: string, zohoSalesOrderId: string, view: ZohoSalesOrderCloseView) {
  await prisma.salesOrder.update({
    where: { id: orderId },
    data: {
      status: view.status,
      invoicedStatus: view.invoicedStatus,
      paidStatus: view.paidStatus,
      shippedStatus: view.shippedStatus,
    },
  });
  await prisma.integrationEntityState.updateMany({
    where: { source: SOURCE, entityType: SALES_ORDER_ENTITY_TYPE, externalId: zohoSalesOrderId },
    data: { needsSync: true },
  });
  await prisma.package.updateMany({
    where: { zohoSalesOrderId },
    data: { lastDetailFetchedAt: null },
  });
}

export async function closeSalesOrderTicket(actor: Actor, orderId: string): Promise<CloseTicketResult> {
  const order = await prisma.salesOrder.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      zohoSalesOrderId: true,
      salesOrderNumber: true,
      deliveryMethod: true,
      status: true,
    },
  });
  if (!order) {
    return { orderId, salesOrderNumber: null, outcome: 'failed', finalStatus: null, steps: [], error: 'Orden no encontrada' };
  }
  const steps: string[] = [];
  const result = (outcome: CloseTicketOutcome, finalStatus: string | null, error?: string): CloseTicketResult => ({
    orderId,
    salesOrderNumber: order.salesOrderNumber,
    outcome,
    finalStatus,
    steps,
    ...(error ? { error } : {}),
  });

  try {
    if (isZohoBooksMockEnabled()) {
      await prisma.salesOrder.update({
        where: { id: orderId },
        data: { status: 'closed', invoicedStatus: 'invoiced', shippedStatus: 'delivered' },
      });
      steps.push('Simulado (ZOHO_BOOKS_MOCK): facturada, entregada y cerrada');
      return await audited(actor, order, result('closed', 'closed'));
    }

    const zid = order.zohoSalesOrderId;
    let view = await readZohoOrder(zid);
    const status = lower(view.status);
    if (status === 'closed') {
      await mirrorStatuses(orderId, zid, view);
      steps.push('Ya estaba cerrada en Zoho');
      return result('skipped', view.status);
    }
    if (status === 'void' || status === 'cancelled') {
      steps.push('Está anulada en Zoho; no se puede cerrar');
      return result('skipped', view.status);
    }
    if (status === 'draft') {
      steps.push('Es borrador en Zoho; primero hay que confirmarla');
      return result('skipped', view.status);
    }

    const day = todayMx();

    // 1. Invoice
    if (lower(view.invoicedStatus) !== 'invoiced') {
      const invoice = extractInvoice(await zoho(() => createInvoiceFromSalesOrder(zid)));
      steps.push(`Factura creada${invoice.number ? ` ${invoice.number}` : ''}`);
      if (invoice.invoiceId && lower(invoice.status) === 'draft') {
        await zoho(() => markInvoiceSent(invoice.invoiceId!));
        steps.push('Factura marcada como enviada');
      }
    } else {
      steps.push('Ya estaba facturada');
    }

    // 2. Packages for what is not packed yet
    if (!DELIVERED.has(lower(view.shippedStatus))) {
      const knowsPacked = view.lineItems.every((l) => l.quantityPacked !== null);
      const pending = view.lineItems
        .map((l) => ({ so_line_item_id: l.lineItemId, quantity: l.quantity - (l.quantityPacked ?? 0) }))
        .filter((l) => l.quantity > 0);
      const noPackagesYet = view.packages !== null && view.packages.length === 0;
      if (pending.length > 0 && (knowsPacked || noPackagesYet)) {
        const lines = knowsPacked
          ? pending
          : view.lineItems.map((l) => ({ so_line_item_id: l.lineItemId, quantity: l.quantity }));
        const packageId = extractCreatedPackageId(
          await zoho(() => createPackageForSalesOrder({ salesOrderId: zid, date: day, lineItems: lines, notes: CLOSE_TICKET_COMMENT }))
        );
        steps.push(`Paquete creado${packageId ? '' : ' (sin id en la respuesta)'}`);
        view = await readZohoOrder(zid);
      }

      // 3. Ship + deliver every package
      const localPackages = await prisma.package.findMany({
        where: { zohoSalesOrderId: zid },
        select: { zohoPackageId: true, zohoShipmentId: true, status: true, carrier: true, deliveryMethod: true },
      });
      const packages =
        view.packages ??
        localPackages.map((p) => ({ packageId: p.zohoPackageId, status: p.status, shipmentId: p.zohoShipmentId }));
      if (packages.length === 0) steps.push('Sin paquetes en Zoho para enviar');
      for (const pkg of packages) {
        if (DELIVERED.has(lower(pkg.status))) continue;
        const local = localPackages.find((p) => p.zohoPackageId === pkg.packageId);
        let shipmentId = pkg.shipmentId ?? local?.zohoShipmentId ?? null;
        if (!shipmentId) {
          const carrier = local?.carrier || local?.deliveryMethod || order.deliveryMethod || FALLBACK_CARRIER;
          const created = extractShipmentOrder(
            await zoho(() =>
              createShipmentOrder({
                packageId: pkg.packageId,
                salesOrderId: zid,
                input: { date: day, delivery_method: carrier, notes: CLOSE_TICKET_COMMENT },
              })
            )
          );
          shipmentId = created?.shipment_id ?? null;
          steps.push(`Orden de envío creada${created?.shipment_number ? ` ${created.shipment_number}` : ''}`);
        }
        if (shipmentId) {
          await zoho(() => markShipmentDelivered(shipmentId!, day));
          steps.push('Envío marcado como entregado');
        } else {
          steps.push('Zoho no devolvió la orden de envío; no se pudo marcar entregado');
        }
      }
    } else {
      steps.push('Ya estaba entregada');
    }

    // 4. Comment
    await zoho(() => addSalesOrderComment(zid, CLOSE_TICKET_COMMENT));
    steps.push(`Comentario agregado: "${CLOSE_TICKET_COMMENT}"`);

    // 5. Read back
    view = await readZohoOrder(zid);
    await mirrorStatuses(orderId, zid, view);
    const closed = lower(view.status) === 'closed';
    if (!closed) {
      steps.push(
        `Zoho dejó la orden en "${view.status ?? '—'}". Revisa en Zoho las preferencias de cierre de órdenes de venta.`
      );
    }
    return await audited(actor, order, result(closed ? 'closed' : 'partial', view.status));
  } catch (error) {
    const message = describeError(error);
    return await audited(actor, order, result(steps.length > 0 ? 'partial' : 'failed', order.status, message));
  }
}

async function audited(
  actor: Actor,
  order: { id: string; zohoSalesOrderId: string },
  res: CloseTicketResult
): Promise<CloseTicketResult> {
  await recordAuditEvent({
    actorUserId: actor.id,
    action: 'sales_orders.ticket_closed',
    targetType: 'SalesOrder',
    targetId: order.id,
    metadata: {
      zohoSalesOrderId: order.zohoSalesOrderId,
      outcome: res.outcome,
      finalStatus: res.finalStatus,
      steps: res.steps,
      error: res.error ?? null,
    },
  }).catch(() => undefined);
  return res;
}
