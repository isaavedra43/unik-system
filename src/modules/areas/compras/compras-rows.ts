import { Prisma } from '@prisma/client';
import { ORDER_RECEIVABLE_STATUSES, ORDER_STATUS_LABELS } from '@/modules/purchases/orders-state';
import {
  PURCHASE_REQUEST_OPEN_STATUSES,
  RFQ_OPEN_STATUSES,
} from '@/modules/purchases/purchases-types';
import type { AreaWorkScope } from '../work-filters';
import {
  areaWorkRowSelect,
  branchActionsSql,
  type AreaWorkSqlFilters,
  type WorkRowBranch,
} from '../work-rows-sql';
import { COMPRAS_STATUS_LABELS } from './compras-model';
import {
  GOODS_RECEIPT_ROW_ACTIONS,
  ORDER_ROW_ACTIONS,
  PURCHASE_REQUEST_ROW_ACTIONS,
  RFQ_ROW_ACTIONS,
} from './row-actions';

/**
 * SQL branches of the Compras work centre (plan 7.4): purchase requests, RFQs,
 * procurement orders, goods receipts and suppliers, on top of the common
 * branches (work items and area requests) every area already has.
 *
 * Every branch is built with `areaWorkRowSelect`, which fills the 24 canonical
 * columns in order — that is what makes the `UNION ALL` valid. Nothing a person
 * typed reaches the SQL as text: the only interpolations are bound parameters
 * and the label maps, which are constants of this module.
 *
 * `open` is the column that decides whether a row still needs somebody. It is
 * ANDed with `isOpenRowStatus` by the service, so both agree.
 */

const CLOSED_ORDER_STATUSES = ['closed', 'cancelled'];
const POSTED = 'posted';
const ACTIVE = 'active';

/**
 * `checkCloseOrder`: no se cierra una orden con diferencias de recepción
 * abiertas, ni antes de haber pedido su pago (obligación por pagar o pagada).
 */
const CLOSEABLE_ORDER = Prisma.sql`diff.open_differences = 0
  AND (o."paymentStatus" = 'paid' OR o."obligationId" IS NOT NULL)`;

/**
 * Spanish label of a state, resolved in SQL from a constant map so the row
 * never shows a raw English value. The map travels as a bound parameter.
 */
function statusLabelSql(map: Readonly<Record<string, string>>, column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE(${JSON.stringify(map)}::jsonb ->> ${column}, ${column})`;
}

/** `scope` chip of the toolbar, applied inside each branch so the index is used. */
function scoped(scope: AreaWorkScope, open: Prisma.Sql): Prisma.Sql {
  if (scope === 'open') return Prisma.sql`AND ${open}`;
  if (scope === 'closed') return Prisma.sql`AND NOT (${open})`;
  return Prisma.empty;
}

/**
 * Rows with no case and no owner (suppliers) must not answer a query filtered
 * by case or by person: the union filter would drop them anyway, this just
 * avoids scanning the table.
 */
function skipWhenScopedToSomebody(filters: AreaWorkSqlFilters): Prisma.Sql {
  return filters.caseId || filters.ownerUserId ? Prisma.sql`AND FALSE` : Prisma.empty;
}

// ---------------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------------

function purchaseRequestBranch(): WorkRowBranch {
  return {
    rowKind: 'purchase_request',
    sql: (filters) => {
      const open = Prisma.sql`pr."status" IN (${Prisma.join([...PURCHASE_REQUEST_OPEN_STATUSES])})`;
      const caseFilter = filters.caseId
        ? Prisma.sql`AND pr."caseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND pr."requestedByUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: 'purchase_request',
        from: Prisma.sql`
          FROM "PurchaseRequest" pr
          LEFT JOIN "OperationalCase" c ON c."id" = pr."caseId"
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS lines,
                   COALESCE(sum(l."qty"), 0) AS qty,
                   COALESCE(sum(GREATEST(l."qty" - l."qtyOrdered", 0)), 0) AS pending,
                   count(*) FILTER (WHERE l."qtyOrdered" > 0)::int AS ordered_lines,
                   (array_agg(l."description" ORDER BY l."sortOrder", l."id"))[1] AS first_description
            FROM "PurchaseRequestLine" l
            WHERE l."requestId" = pr."id" AND l."status" <> 'cancelled'
          ) agg ON TRUE`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scoped(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`pr."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`pr."caseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`pr."number" || ' · ' || COALESCE(agg.first_description, 'Solicitud sin partidas')`,
          status: Prisma.sql`pr."status"`,
          priority: Prisma.sql`pr."priority"`,
          ownerUserId: Prisma.sql`pr."requestedByUserId"`,
          dueAt: Prisma.sql`pr."neededBy"`,
          lastActivityAt: Prisma.sql`pr."updatedAt"`,
          objectType: Prisma.sql`'purchase_request'::text`,
          objectId: Prisma.sql`pr."id"`,
          quantity: Prisma.sql`agg.qty`,
          version: Prisma.sql`pr."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${statusLabelSql(COMPRAS_STATUS_LABELS.purchase_request, Prisma.sql`pr."status"`)},
            'number', pr."number",
            'lines', agg.lines,
            'pendingQty', agg.pending,
            'reason', pr."reason",
            'originAreaKey', pr."areaKey",
            'neededBy', pr."neededBy",
            'actions', ${branchActionsSql({
              catalog: PURCHASE_REQUEST_ROW_ACTIONS,
              status: Prisma.sql`pr."status"`,
              payload: Prisma.sql`jsonb_build_object('requestId', pr."id")`,
              conditions: {
                // El servicio la rechaza si alguna partida ya está en una orden.
                'purchase_request.cancel': Prisma.sql`agg.ordered_lines = 0`,
              },
            })}
          )`,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// RFQ
// ---------------------------------------------------------------------------

function rfqBranch(): WorkRowBranch {
  return {
    rowKind: 'rfq',
    sql: (filters) => {
      const open = Prisma.sql`r."status" IN (${Prisma.join([...RFQ_OPEN_STATUSES])})`;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND r."createdByUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      // An RFQ is not attached to a case: it answers one or many requests.
      const caseFilter = filters.caseId ? Prisma.sql`AND FALSE` : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: 'rfq',
        from: Prisma.sql`
          FROM "Rfq" r
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS lines FROM "RfqLine" rl WHERE rl."rfqId" = r."id"
          ) ln ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS invitations,
                   count(*) FILTER (WHERE i."status" = 'sent')::int AS sent,
                   count(*) FILTER (WHERE i."status" = 'replied')::int AS replied
            FROM "RfqInvitation" i WHERE i."rfqId" = r."id"
          ) inv ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*) FILTER (WHERE rs."status" <> 'rejected')::int AS responses,
                   count(*) FILTER (WHERE rs."status" = 'needs_review')::int AS needs_review,
                   min(rs."landedTotal") FILTER (WHERE rs."status" <> 'rejected') AS best_total
            FROM "RfqResponse" rs WHERE rs."rfqId" = r."id"
          ) res ON TRUE`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scoped(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`r."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          title: Prisma.sql`r."number" || ' · ' || r."title"`,
          status: Prisma.sql`r."status"`,
          ownerUserId: Prisma.sql`r."createdByUserId"`,
          dueAt: Prisma.sql`r."dueAt"`,
          lastActivityAt: Prisma.sql`r."updatedAt"`,
          objectType: Prisma.sql`'rfq'::text`,
          objectId: Prisma.sql`r."id"`,
          amount: Prisma.sql`res.best_total`,
          version: Prisma.sql`r."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${statusLabelSql(COMPRAS_STATUS_LABELS.rfq, Prisma.sql`r."status"`)},
            'number', r."number",
            'lines', ln.lines,
            'invitations', inv.invitations,
            'sent', inv.sent,
            'replied', inv.replied,
            'responses', res.responses,
            'needsReview', res.needs_review,
            'sourcingSearchId', r."sourcingSearchId",
            'actions', ${branchActionsSql({
              catalog: RFQ_ROW_ACTIONS,
              status: Prisma.sql`r."status"`,
              payload: Prisma.sql`jsonb_build_object('rfqId', r."id")`,
              conditions: {
                // Comparar sin respuestas es un rechazo seguro del motor.
                'rfq.compare': Prisma.sql`res.responses > 0`,
              },
            })}
          )`,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Procurement orders
// ---------------------------------------------------------------------------

function procurementOrderBranch(): WorkRowBranch {
  return {
    rowKind: 'procurement_order',
    sql: (filters) => {
      const open = Prisma.sql`o."status" NOT IN (${Prisma.join(CLOSED_ORDER_STATUSES)})`;
      // A purchase serves a sale through its allocations, or directly when the
      // supplier delivers to the customer.
      const caseFilter = filters.caseId
        ? Prisma.sql`AND COALESCE(o."directDeliveryCaseId", lc."caseId") = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND o."createdByUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: 'procurement_order',
        from: Prisma.sql`
          FROM "ProcurementOrder" o
          JOIN "Supplier" s ON s."id" = o."supplierId"
          LEFT JOIN LATERAL (
            SELECT cd."caseId"
            FROM "ProcurementOrderLine" ol
            JOIN "ProcurementAllocation" pa ON pa."orderLineId" = ol."id"
            JOIN "CaseDemand" cd ON cd."id" = pa."demandId"
            WHERE ol."orderId" = o."id"
            LIMIT 1
          ) lc ON TRUE
          LEFT JOIN "OperationalCase" c ON c."id" = COALESCE(o."directDeliveryCaseId", lc."caseId")
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS lines,
                   COALESCE(sum(GREATEST(ol."qty" - ol."qtyAccepted", 0))
                     FILTER (WHERE ol."status" NOT IN ('cancelled', 'closed')), 0) AS pending
            FROM "ProcurementOrderLine" ol WHERE ol."orderId" = o."id"
          ) agg ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS open_differences
            FROM "GoodsReceiptLine" grl
            JOIN "GoodsReceipt" gr ON gr."id" = grl."receiptId"
            JOIN "Incident" inc ON inc."id" = grl."incidentId"
            WHERE gr."orderId" = o."id"
              AND grl."differenceKind" <> 'none'
              AND inc."status" IN ('open', 'acknowledged')
          ) diff ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS posted
            FROM "GoodsReceipt" gr2
            WHERE gr2."orderId" = o."id" AND gr2."status" = ${POSTED}
          ) rc ON TRUE`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scoped(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`o."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`COALESCE(o."directDeliveryCaseId", lc."caseId")`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`o."number" || ' · ' || s."name"`,
          status: Prisma.sql`o."status"`,
          ownerUserId: Prisma.sql`o."createdByUserId"`,
          dueAt: Prisma.sql`o."expectedAt"`,
          lastActivityAt: Prisma.sql`o."updatedAt"`,
          objectType: Prisma.sql`'procurement_order'::text`,
          objectId: Prisma.sql`o."id"`,
          counterpartyName: Prisma.sql`s."name"`,
          amount: Prisma.sql`o."total"`,
          quantity: Prisma.sql`agg.pending`,
          version: Prisma.sql`o."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${statusLabelSql(ORDER_STATUS_LABELS, Prisma.sql`o."status"`)},
            'number', o."number",
            'vendorName', s."name",
            'supplierId', o."supplierId",
            'expectedAt', o."expectedAt",
            'currency', o."currency",
            'paymentMode', o."paymentMode",
            'paymentStatus', o."paymentStatus",
            'deliveryMode', o."deliveryMode",
            'lines', agg.lines,
            'pendingQty', agg.pending,
            'openDifferences', diff.open_differences,
            'obligationId', o."obligationId",
            'approvalRequestId', o."approvalRequestId",
            'sentToSupplierAt', o."sentToSupplierAt",
            'rfqResponseId', o."rfqResponseId",
            'actions', ${branchActionsSql({
              catalog: ORDER_ROW_ACTIONS,
              status: Prisma.sql`o."status"`,
              payload: Prisma.sql`jsonb_build_object('orderId', o."id")`,
              conditions: {
                // `checkSubmitOrder`: sin partidas o con total cero no se firma.
                'procurement_order.submit': Prisma.sql`agg.lines > 0 AND o."total" > 0`,
                // `checkRequestPayment`: no se pide dos veces ni sobre lo pagado.
                'procurement_order.request_payment': Prisma.sql`o."paymentStatus" <> 'paid' AND o."obligationId" IS NULL`,
                // `checkCloseOrder`: sin diferencias abiertas y con el pago pedido.
                'procurement_order.close': Prisma.sql`${CLOSEABLE_ORDER}`,
                'procurement_order.close_accepting_shortage': Prisma.sql`${CLOSEABLE_ORDER}`,
                // `checkCancelOrder`: con material ya recibido se cierra, no se cancela.
                'procurement_order.cancel': Prisma.sql`rc.posted = 0`,
              },
            })}
          )`,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Goods receipts
// ---------------------------------------------------------------------------

function goodsReceiptBranch(): WorkRowBranch {
  return {
    rowKind: 'goods_receipt',
    sql: (filters) => {
      const open = Prisma.sql`g."status" <> ${POSTED}`;
      const caseFilter = filters.caseId
        ? Prisma.sql`AND o."directDeliveryCaseId" = ${filters.caseId}`
        : Prisma.empty;
      const ownerFilter = filters.ownerUserId
        ? Prisma.sql`AND g."receivedByUserId" = ${filters.ownerUserId}`
        : Prisma.empty;
      return areaWorkRowSelect({
        rowKind: 'goods_receipt',
        from: Prisma.sql`
          FROM "GoodsReceipt" g
          JOIN "ProcurementOrder" o ON o."id" = g."orderId"
          JOIN "Supplier" s ON s."id" = o."supplierId"
          LEFT JOIN "OperationalCase" c ON c."id" = o."directDeliveryCaseId"
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS lines,
                   count(*) FILTER (WHERE gl."differenceKind" <> 'none')::int AS differences,
                   COALESCE(sum(gl."qtyAccepted"), 0) AS accepted
            FROM "GoodsReceiptLine" gl WHERE gl."receiptId" = g."id"
          ) agg ON TRUE`,
        where: Prisma.sql`WHERE TRUE ${caseFilter} ${ownerFilter} ${scoped(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`g."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          caseId: Prisma.sql`o."directDeliveryCaseId"`,
          caseNumber: Prisma.sql`c."caseNumber"`,
          customerName: Prisma.sql`c."customerName"`,
          title: Prisma.sql`g."number" || ' · ' || o."number"`,
          status: Prisma.sql`g."status"`,
          ownerUserId: Prisma.sql`g."receivedByUserId"`,
          startedAt: Prisma.sql`g."receivedAt"`,
          lastActivityAt: Prisma.sql`g."updatedAt"`,
          objectType: Prisma.sql`'goods_receipt'::text`,
          objectId: Prisma.sql`g."id"`,
          counterpartyName: Prisma.sql`s."name"`,
          quantity: Prisma.sql`agg.accepted`,
          // La versión optimista de una recepción ES la de su orden: todo comando
          // de recepción corre contra el agregado `procurement_order`.
          version: Prisma.sql`o."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${statusLabelSql(COMPRAS_STATUS_LABELS.goods_receipt, Prisma.sql`g."status"`)},
            'number', g."number",
            'vendorName', s."name",
            'orderId', o."id",
            'orderNumber', o."number",
            'mode', g."mode",
            'lines', agg.lines,
            'differences', agg.differences,
            'receivedAt', g."receivedAt",
            'actions', ${branchActionsSql({
              catalog: GOODS_RECEIPT_ROW_ACTIONS,
              status: Prisma.sql`g."status"`,
              payload: Prisma.sql`jsonb_build_object('receiptId', g."id")`,
              aggregateId: Prisma.sql`o."id"`,
              conditions: {
                // `postReceiptInTx`: sólo una recepción de bodega, y sólo mientras
                // la orden puede recibir material.
                'goods_receipt.post': Prisma.sql`g."mode" = 'warehouse' AND g."warehouseId" IS NOT NULL AND o."status" IN (${Prisma.join([...ORDER_RECEIVABLE_STATUSES])})`,
              },
            })}
          )`,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

function supplierBranch(): WorkRowBranch {
  return {
    rowKind: 'supplier',
    sql: (filters) => {
      const open = Prisma.sql`s."status" = ${ACTIVE}`;
      return areaWorkRowSelect({
        rowKind: 'supplier',
        from: Prisma.sql`
          FROM "Supplier" s
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS products FROM "SupplierProduct" sp WHERE sp."supplierId" = s."id"
          ) prod ON TRUE
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS open_orders
            FROM "ProcurementOrder" po
            WHERE po."supplierId" = s."id" AND po."status" NOT IN ('closed', 'cancelled')
          ) ord ON TRUE`,
        where: Prisma.sql`WHERE TRUE ${skipWhenScopedToSomebody(filters)} ${scoped(filters.scope, open)}`,
        columns: {
          sourceId: Prisma.sql`s."id"`,
          areaKey: Prisma.sql`${filters.areaKey}::text`,
          title: Prisma.sql`s."name"`,
          status: Prisma.sql`s."status"`,
          lastActivityAt: Prisma.sql`s."updatedAt"`,
          objectType: Prisma.sql`'supplier'::text`,
          objectId: Prisma.sql`s."id"`,
          counterpartyName: Prisma.sql`s."number"`,
          version: Prisma.sql`s."version"`,
          open,
          extra: Prisma.sql`jsonb_build_object(
            'statusLabel', ${statusLabelSql(COMPRAS_STATUS_LABELS.supplier, Prisma.sql`s."status"`)},
            'number', s."number",
            'vendorName', s."name",
            'rating', s."ratingOverall",
            'evaluations', s."evaluationsCount",
            'paymentMode', s."paymentMode",
            'leadTimeDays', s."leadTimeDaysDefault",
            'products', prod.products,
            'openOrders', ord.open_orders,
            'zohoContactId', s."zohoContactId",
            'phone', s."primaryPhone",
            'email', s."primaryEmail",
            'taxRegNo', s."taxRegNo"
          )`,
        },
      });
    },
  };
}

/** Branches Compras adds to the common ones (their row kinds are declared in the registry). */
export function comprasWorkRowBranches(): WorkRowBranch[] {
  return [
    purchaseRequestBranch(),
    rfqBranch(),
    procurementOrderBranch(),
    goodsReceiptBranch(),
    supplierBranch(),
  ];
}
