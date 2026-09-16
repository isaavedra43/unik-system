import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { getCaseAiCostUsd } from '@/modules/agents/budget';
import { OperationsError } from '@/modules/operations/errors';
import { AREA_LABELS, isAreaKey } from '@/modules/operations/types';
import { assertControlTowerAccess } from './control-tower-service';
import { maskNodes, type GraphNode, type GraphViewer } from './graph-mask';
import {
  DEFAULT_PERSPECTIVE_KEY,
  canUsePerspective,
  clampDepth,
  clampNodeLimit,
  getPerspective,
  nodeTypeLabel,
  relationLabel,
  type GraphPerspective,
} from './perspectives';

/**
 * Grafo operativo temporal (plan 7.9 `graph-service.ts`). SÓLO SERVIDOR.
 *
 * `ObjectRelation` es la proyección reconstruible que une todo lo que pasó: un
 * expediente con su orden de compra, la orden con su proveedor, el proveedor con
 * su obligación, la entrega con su viaje. Aquí se recorre esa red desde unas
 * raíces, en AMBAS direcciones, con:
 *
 * - una CTE recursiva sobre `ObjectRelation` (profundidad ≤ 3, `UNION` que
 *   deduplica y por eso no puede ciclar);
 * - `relation = ANY(...)` con las relaciones de la perspectiva, de modo que una
 *   perspectiva de Logística no arrastra la contabilidad entera;
 * - `validFrom <= at` y `validTo IS NULL OR validTo > at`, que es lo que
 *   permite fijar el tiempo con el TimeSlider y ver la red como estaba ese día;
 * - `LIMIT` de servidor (2 000) con bandera `truncated`, para que la pantalla
 *   diga "hay más" en vez de tardar un minuto.
 *
 * SEGURIDAD: todo valor va como parámetro (`Prisma.sql`); no se construye ni un
 * identificador con texto de nadie. Los nodos se leen con `select` mínimo y
 * pasan por `maskNode`, así que ver la RELACIÓN nunca revela el importe ni el
 * teléfono a quien no tiene ese permiso.
 */

export const GRAPH_ROOT_LIMIT = 20;

/** Tope de nodos que se leen por tipo (los demás quedan como nodo mínimo). */
const NODES_PER_TYPE = 500;

export interface GraphRef {
  type: string;
  id: string;
}

export interface GraphEdge {
  key: string;
  fromKey: string;
  toKey: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  relationLabel: string;
  validFrom: string;
  validTo: string | null;
}

/** Nodo del grafo con la distancia mínima a una raíz (la usa el trazado). */
export interface GraphNodeAtDepth extends GraphNode {
  depth: number;
  /** Es una de las raíces de la consulta. */
  root: boolean;
}

export interface OperationalGraph {
  perspectiveKey: string;
  perspectiveLabel: string;
  at: string;
  depth: number;
  roots: GraphRef[];
  nodes: GraphNodeAtDepth[];
  edges: GraphEdge[];
  /** Se alcanzó el tope del servidor: hay más red de la que se devolvió. */
  truncated: boolean;
  limit: number;
  computedAt: string;
}

export interface QueryGraphInput {
  perspectiveKey?: string | null;
  roots: readonly GraphRef[];
  depth?: number | null;
  limit?: number | null;
  /** Instante fijado (TimeSlider). Por omisión, ahora. */
  at?: Date | null;
  /** Subconjunto de relaciones de la perspectiva. */
  relations?: readonly string[] | null;
  /** Subconjunto de tipos de nodo de la perspectiva. */
  nodeTypes?: readonly string[] | null;
}

interface WalkRow {
  nodeType: string;
  nodeId: string;
  depth: number;
}

interface EdgeRow {
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  relation: string;
  validFrom: Date;
  validTo: Date | null;
}

const nodeKey = (type: string, id: string): string => `${type}:${id}`;

function toViewer(actor: CurrentUser): GraphViewer {
  return { permissionKeys: actor.permissionKeys, isSuperAdmin: actor.isSuperAdmin === true };
}

function cleanRefs(roots: readonly GraphRef[]): GraphRef[] {
  const seen = new Set<string>();
  const out: GraphRef[] = [];
  for (const root of roots) {
    const type = typeof root?.type === 'string' ? root.type.trim() : '';
    const id = typeof root?.id === 'string' ? root.id.trim() : '';
    if (!type || !id) continue;
    const key = nodeKey(type, id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type, id });
    if (out.length >= GRAPH_ROOT_LIMIT) break;
  }
  return out;
}

/** Relaciones efectivas: las de la perspectiva, recortadas por el filtro de la persona. */
function effectiveRelations(
  perspective: GraphPerspective,
  requested: readonly string[] | null | undefined
): string[] {
  const allowed = new Set(perspective.relations);
  if (!requested || requested.length === 0) return [...allowed];
  const picked = requested.filter((relation) => allowed.has(relation));
  return picked.length > 0 ? picked : [...allowed];
}

/** Tipos efectivos: los de la perspectiva (vacío = todos), recortados por el filtro. */
function effectiveNodeTypes(
  perspective: GraphPerspective,
  requested: readonly string[] | null | undefined
): string[] {
  const base = perspective.nodeTypes;
  if (!requested || requested.length === 0) return [...base];
  if (base.length === 0) return [...new Set(requested)];
  const allowed = new Set(base);
  const picked = requested.filter((type) => allowed.has(type));
  return picked.length > 0 ? picked : [...base];
}

/**
 * CTE recursiva en ambas direcciones. La referencia recursiva aparece UNA vez y
 * en un `JOIN` interno (PostgreSQL no admite que aparezca dentro de una
 * subconsulta o del lado anulable de un `LEFT JOIN`).
 */
function walkSql(input: {
  rootTypes: string[];
  rootIds: string[];
  relations: string[];
  nodeTypes: string[];
  depth: number;
  at: Date;
  limit: number;
}): Prisma.Sql {
  const filterTypes = input.nodeTypes.length > 0;
  return Prisma.sql`
    WITH RECURSIVE walk AS (
      SELECT seed."nodeType" AS "nodeType", seed."nodeId" AS "nodeId", 0 AS "depth"
      FROM unnest(${input.rootTypes}::text[], ${input.rootIds}::text[]) AS seed("nodeType", "nodeId")
      UNION
      SELECT
        CASE WHEN o."fromType" = w."nodeType" AND o."fromId" = w."nodeId"
          THEN o."toType" ELSE o."fromType" END,
        CASE WHEN o."fromType" = w."nodeType" AND o."fromId" = w."nodeId"
          THEN o."toId" ELSE o."fromId" END,
        w."depth" + 1
      FROM walk w
      JOIN "ObjectRelation" o
        ON (o."fromType" = w."nodeType" AND o."fromId" = w."nodeId")
        OR (o."toType" = w."nodeType" AND o."toId" = w."nodeId")
      WHERE w."depth" < ${input.depth}
        AND o."relation" = ANY(${input.relations}::text[])
        AND o."validFrom" <= ${input.at}
        AND (o."validTo" IS NULL OR o."validTo" > ${input.at})
        AND (
          ${!filterTypes}
          OR (CASE WHEN o."fromType" = w."nodeType" AND o."fromId" = w."nodeId"
                THEN o."toType" ELSE o."fromType" END) = ANY(${input.nodeTypes}::text[])
        )
    )
    SELECT w."nodeType" AS "nodeType", w."nodeId" AS "nodeId", MIN(w."depth")::int AS "depth"
    FROM walk w
    GROUP BY 1, 2
    ORDER BY MIN(w."depth") ASC, 1 ASC, 2 ASC
    LIMIT ${input.limit}
  `;
}

/** Aristas entre los nodos ya encontrados (no agrega nodos nuevos). */
function edgesSql(input: {
  types: string[];
  ids: string[];
  relations: string[];
  at: Date;
  limit: number;
}): Prisma.Sql {
  return Prisma.sql`
    WITH nodes AS (
      SELECT n."nodeType" AS "nodeType", n."nodeId" AS "nodeId"
      FROM unnest(${input.types}::text[], ${input.ids}::text[]) AS n("nodeType", "nodeId")
    )
    SELECT o."fromType" AS "fromType", o."fromId" AS "fromId",
      o."toType" AS "toType", o."toId" AS "toId",
      o."relation" AS "relation", o."validFrom" AS "validFrom", o."validTo" AS "validTo"
    FROM "ObjectRelation" o
    JOIN nodes a ON a."nodeType" = o."fromType" AND a."nodeId" = o."fromId"
    JOIN nodes b ON b."nodeType" = o."toType" AND b."nodeId" = o."toId"
    WHERE o."relation" = ANY(${input.relations}::text[])
      AND o."validFrom" <= ${input.at}
      AND (o."validTo" IS NULL OR o."validTo" > ${input.at})
    ORDER BY o."validFrom" ASC
    LIMIT ${input.limit}
  `;
}

// ---------------------------------------------------------------------------
// Lectura de nodos
// ---------------------------------------------------------------------------

type NodeDraft = Omit<GraphNode, 'key' | 'typeLabel' | 'masked'> & { masked?: string[] };

type NodeLoader = (ids: string[]) => Promise<Map<string, Partial<NodeDraft>>>;

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

const money = (value: Prisma.Decimal | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toString();

const areaLabel = (key: string | null | undefined): string | null => {
  if (!key) return null;
  return isAreaKey(key) ? AREA_LABELS[key] : key;
};

function indexBy<T extends { id: string }>(
  rows: T[],
  build: (row: T) => Partial<NodeDraft>
): Map<string, Partial<NodeDraft>> {
  return new Map(rows.map((row) => [row.id, build(row)]));
}

/**
 * Un lector por tipo de nodo. Los tipos sin lector se muestran con su id (el
 * grafo nunca se rompe porque un módulo todavía no tiene pantalla).
 */
const NODE_LOADERS: Record<string, NodeLoader> = {
  operational_case: async (ids) =>
    indexBy(
      await prisma.operationalCase.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          caseNumber: true,
          customerName: true,
          status: true,
          phase: true,
          openedAt: true,
        },
      }),
      (row) => ({
        label: row.caseNumber,
        sublabel: row.customerName,
        status: row.status,
        at: iso(row.openedAt),
        href: `/app/operations/cases/${row.id}`,
      })
    ),
  sales_order: async (ids) =>
    indexBy(
      await prisma.salesOrder.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          salesOrderNumber: true,
          zohoSalesOrderId: true,
          customerName: true,
          status: true,
          orderDate: true,
          total: true,
          currencyCode: true,
        },
      }),
      (row) => ({
        label: row.salesOrderNumber ?? row.zohoSalesOrderId,
        sublabel: row.customerName,
        status: row.status,
        at: iso(row.orderDate),
        amount: money(row.total),
        currency: row.currencyCode,
        href: `/app/sales/orders/${row.id}`,
      })
    ),
  case_demand: async (ids) =>
    indexBy(
      await prisma.caseDemand.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, sku: true, status: true, unit: true, quantity: true },
      }),
      (row) => ({
        label: row.name,
        sublabel: row.sku ? `${row.sku} · ${row.quantity.toString()} ${row.unit}` : null,
        status: row.status,
      })
    ),
  demand_allocation: async (ids) =>
    indexBy(
      await prisma.demandAllocation.findMany({
        where: { id: { in: ids } },
        select: { id: true, source: true, status: true, quantity: true, expectedAt: true },
      }),
      (row) => ({
        label: ALLOCATION_SOURCE_LABELS[row.source] ?? row.source,
        sublabel: row.quantity.toString(),
        status: row.status,
        at: iso(row.expectedAt),
      })
    ),
  area_request: async (ids) =>
    indexBy(
      await prisma.areaRequest.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          kind: true,
          status: true,
          toAreaKey: true,
          dueAt: true,
        },
      }),
      (row) => ({
        label: row.title,
        sublabel: areaLabel(row.toAreaKey),
        status: row.status,
        areaKey: row.toAreaKey,
        at: iso(row.dueAt),
      })
    ),
  work_item: async (ids) =>
    indexBy(
      await prisma.workItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true, status: true, areaKey: true, dueAt: true },
      }),
      (row) => ({
        label: row.title,
        sublabel: areaLabel(row.areaKey),
        status: row.status,
        areaKey: row.areaKey,
        at: iso(row.dueAt),
        href: '/app/mywork',
      })
    ),
  incident: async (ids) =>
    indexBy(
      await prisma.incident.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          kind: true,
          severity: true,
          status: true,
          areaKey: true,
          openedAt: true,
        },
      }),
      (row) => ({
        label: row.title,
        sublabel: `${row.kind} · ${row.severity}`,
        status: row.status,
        areaKey: row.areaKey,
        at: iso(row.openedAt),
      })
    ),
  stock_reservation: async (ids) =>
    indexBy(
      await prisma.stockReservation.findMany({
        where: { id: { in: ids } },
        select: { id: true, zohoItemId: true, status: true, quantity: true, expiresAt: true },
      }),
      (row) => ({
        label: `Reserva ${row.zohoItemId}`,
        sublabel: row.quantity.toString(),
        status: row.status,
        areaKey: 'inventario',
        at: iso(row.expiresAt),
      })
    ),
  legacy_claim: async (ids) =>
    indexBy(
      await prisma.legacyCommitmentClaim.findMany({
        where: { id: { in: ids } },
        select: { id: true, zohoItemId: true, status: true, quantity: true, expiresAt: true },
      }),
      (row) => ({
        label: `Compromiso previo ${row.zohoItemId}`,
        sublabel: row.quantity.toString(),
        status: row.status,
        areaKey: 'inventario',
        at: iso(row.expiresAt),
      })
    ),
  stock_item: async (ids) =>
    indexBy(
      await prisma.stockItem.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          zohoItemId: true,
          warehouseId: true,
          knownQty: true,
          lastCountedAt: true,
        },
      }),
      (row) => ({
        label: row.zohoItemId,
        sublabel: `${row.knownQty.toString()} en ${row.warehouseId}`,
        areaKey: 'inventario',
        at: iso(row.lastCountedAt),
      })
    ),
  purchase_request: async (ids) =>
    indexBy(
      await prisma.purchaseRequest.findMany({
        where: { id: { in: ids } },
        select: { id: true, number: true, status: true, areaKey: true, neededBy: true },
      }),
      (row) => ({
        label: row.number,
        sublabel: areaLabel(row.areaKey),
        status: row.status,
        areaKey: row.areaKey,
        at: iso(row.neededBy),
      })
    ),
  purchase_request_line: async (ids) =>
    indexBy(
      await prisma.purchaseRequestLine.findMany({
        where: { id: { in: ids } },
        select: { id: true, description: true, qty: true, unit: true },
      }),
      (row) => ({
        label: row.description,
        sublabel: `${row.qty.toString()} ${row.unit}`,
        areaKey: 'compras',
      })
    ),
  rfq: async (ids) =>
    indexBy(
      await prisma.rfq.findMany({
        where: { id: { in: ids } },
        select: { id: true, number: true, title: true, status: true, dueAt: true },
      }),
      (row) => ({
        label: row.number,
        sublabel: row.title,
        status: row.status,
        areaKey: 'compras',
        at: iso(row.dueAt),
      })
    ),
  procurement_order: async (ids) =>
    indexBy(
      await prisma.procurementOrder.findMany({
        where: { id: { in: ids } },
        select: { id: true, number: true, status: true, total: true, currency: true },
      }),
      (row) => ({
        label: row.number,
        status: row.status,
        amount: money(row.total),
        currency: row.currency,
        areaKey: 'compras',
      })
    ),
  goods_receipt: async (ids) =>
    indexBy(
      await prisma.goodsReceipt.findMany({
        where: { id: { in: ids } },
        select: { id: true, number: true, status: true, receivedAt: true },
      }),
      (row) => ({
        label: row.number,
        status: row.status,
        areaKey: 'inventario',
        at: iso(row.receivedAt),
      })
    ),
  supplier: async (ids) =>
    indexBy(
      await prisma.supplier.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          number: true,
          name: true,
          status: true,
          primaryPhone: true,
          primaryEmail: true,
        },
      }),
      (row) => ({
        label: row.name,
        sublabel: row.number,
        status: row.status,
        areaKey: 'compras',
        contact: { name: row.name, phone: row.primaryPhone, email: row.primaryEmail },
      })
    ),
  sourcing_candidate: async (ids) =>
    indexBy(
      await prisma.sourcingCandidate.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, domain: true, phone: true, email: true, status: true },
      }),
      (row) => ({
        label: row.name,
        sublabel: row.domain,
        status: row.status,
        areaKey: 'compras',
        contact: { name: row.name, phone: row.phone, email: row.email },
      })
    ),
  production_order: async (ids) =>
    indexBy(
      await prisma.productionOrder.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          number: true,
          status: true,
          outputName: true,
          outputZohoItemId: true,
        },
      }),
      (row) => ({
        label: row.number,
        sublabel: row.outputName ?? row.outputZohoItemId,
        status: row.status,
        areaKey: 'manufactura',
        href: `/app/manufacturing/orders/${row.id}`,
      })
    ),
  delivery_order: async (ids) =>
    indexBy(
      await prisma.deliveryOrder.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          status: true,
          mode: true,
          plannedDate: true,
          contactName: true,
          contactPhone: true,
          city: true,
        },
      }),
      (row) => ({
        label: `Entrega ${DELIVERY_MODE_LABELS[row.mode] ?? row.mode}`,
        sublabel: row.city,
        status: row.status,
        areaKey: 'logistica',
        at: iso(row.plannedDate),
        contact: { name: row.contactName, phone: row.contactPhone, email: null },
      })
    ),
  package: async (ids) =>
    indexBy(
      await prisma.package.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          packageNumber: true,
          zohoPackageId: true,
          status: true,
          date: true,
          carrier: true,
        },
      }),
      (row) => ({
        label: row.packageNumber ?? row.zohoPackageId,
        sublabel: row.carrier,
        status: row.status,
        areaKey: 'logistica',
        at: iso(row.date),
        href: `/app/packages/${row.id}`,
      })
    ),
  trip: async (ids) =>
    indexBy(
      await prisma.trip.findMany({
        where: { id: { in: ids } },
        select: { id: true, number: true, status: true, date: true },
      }),
      (row) => ({
        label: `Viaje ${row.number}`,
        status: row.status,
        areaKey: 'logistica',
        at: iso(row.date),
        href: `/app/areas/logistica/viajes/${row.id}`,
      })
    ),
  vehicle: async (ids) =>
    indexBy(
      await prisma.vehicle.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, plate: true, label: true, active: true },
      }),
      (row) => ({
        label: row.label || row.code,
        sublabel: row.plate,
        status: row.active ? 'active' : 'inactive',
        areaKey: 'logistica',
      })
    ),
  driver: async (ids) =>
    indexBy(
      await prisma.driver.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, phone: true, active: true },
      }),
      (row) => ({
        label: row.name,
        status: row.active ? 'active' : 'inactive',
        areaKey: 'logistica',
        contact: { name: row.name, phone: row.phone, email: null },
      })
    ),
  obligation: async (ids) =>
    indexBy(
      await prisma.obligation.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          number: true,
          description: true,
          status: true,
          expectedAmount: true,
          currency: true,
          dueAt: true,
        },
      }),
      (row) => ({
        label: row.number,
        sublabel: row.description,
        status: row.status,
        areaKey: 'contabilidad',
        amount: money(row.expectedAmount),
        currency: row.currency,
        at: iso(row.dueAt),
      })
    ),
  expense: async (ids) =>
    indexBy(
      await prisma.expense.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          number: true,
          status: true,
          amount: true,
          currency: true,
          date: true,
        },
      }),
      (row) => ({
        label: row.number,
        status: row.status,
        areaKey: 'contabilidad',
        amount: money(row.amount),
        currency: row.currency,
        at: iso(row.date),
      })
    ),
  approval_request: async (ids) =>
    indexBy(
      await prisma.approvalRequest.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          scope: true,
          targetType: true,
          status: true,
          amount: true,
          currency: true,
          createdAt: true,
        },
      }),
      (row) => ({
        label: `Aprobación ${row.scope}`,
        sublabel: row.targetType,
        status: row.status,
        amount: money(row.amount),
        currency: row.currency,
        at: iso(row.createdAt),
      })
    ),
  opportunity: async (ids) =>
    indexBy(
      await prisma.opportunity.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          number: true,
          title: true,
          status: true,
          contactName: true,
          estimatedValue: true,
          currency: true,
        },
      }),
      (row) => ({
        label: row.title,
        sublabel: row.number,
        status: row.status,
        areaKey: 'ventas',
        amount: money(row.estimatedValue),
        currency: row.currency,
        contact: { name: row.contactName, phone: null, email: null },
        href: `/app/areas/ventas/oportunidades/${row.id}`,
      })
    ),
  quote: async (ids) =>
    indexBy(
      await prisma.quote.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          estimateNumber: true,
          customerName: true,
          status: true,
          total: true,
          currencyCode: true,
          date: true,
        },
      }),
      (row) => ({
        label: row.estimateNumber ?? 'Cotización',
        sublabel: row.customerName,
        status: row.status,
        areaKey: 'ventas',
        amount: money(row.total),
        currency: row.currencyCode,
        at: iso(row.date),
        href: `/app/quotes/${row.id}`,
      })
    ),
  comm_conversation: async (ids) =>
    indexBy(
      await prisma.commConversation.findMany({
        where: { id: { in: ids } },
        select: { id: true, subject: true, status: true, lastMessageAt: true },
      }),
      (row) => ({
        label: row.subject ?? 'Conversación',
        status: row.status,
        at: iso(row.lastMessageAt),
        href: '/app/inbox',
      })
    ),
  voice_call: async (ids) =>
    indexBy(
      await prisma.voiceCall.findMany({
        where: { id: { in: ids } },
        select: { id: true, type: true, status: true, externalNumber: true, startedAt: true },
      }),
      (row) => ({
        label: row.externalNumber ?? `Llamada ${row.type}`,
        status: row.status,
        at: iso(row.startedAt),
        href: '/app/calls',
      })
    ),
  user: async (ids) =>
    indexBy(
      await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, username: true, isActive: true, isBot: true },
      }),
      (row) => ({
        label: row.name || row.username,
        sublabel: row.isBot ? 'Agente de IA' : row.username,
        status: row.isActive ? 'active' : 'inactive',
      })
    ),
  zoho_contact: async (ids) => {
    const rows = await prisma.contact.findMany({
      where: { zohoContactId: { in: ids } },
      select: {
        zohoContactId: true,
        contactName: true,
        companyName: true,
        status: true,
        primaryEmail: true,
        primaryPhone: true,
      },
    });
    return new Map(
      rows.map((row) => [
        row.zohoContactId,
        {
          label: row.contactName ?? row.companyName ?? row.zohoContactId,
          sublabel: row.companyName,
          status: row.status,
          contact: {
            name: row.contactName,
            phone: row.primaryPhone,
            email: row.primaryEmail,
          },
        } satisfies Partial<NodeDraft>,
      ])
    );
  },
};

const ALLOCATION_SOURCE_LABELS: Record<string, string> = {
  stock: 'Desde existencia',
  purchase: 'Por compra',
  manufacture: 'Por producción',
  direct_supplier: 'Entrega directa',
};

const DELIVERY_MODE_LABELS: Record<string, string> = {
  own_fleet: 'flota propia',
  carrier: 'paquetería',
  pickup: 'recolección',
  supplier_direct: 'del proveedor',
};

function emptyNode(type: string, id: string): GraphNode {
  return {
    key: nodeKey(type, id),
    id,
    type,
    typeLabel: nodeTypeLabel(type),
    label: id,
    sublabel: null,
    status: null,
    areaKey: null,
    at: null,
    href: null,
    amount: null,
    currency: null,
    contact: null,
    aiCostUsd: null,
    masked: [],
  };
}

/** Lee los nodos por tipo, con `select` mínimo y sin romperse por un tipo sin lector. */
export async function loadGraphNodes(refs: readonly GraphRef[]): Promise<GraphNode[]> {
  const byType = new Map<string, string[]>();
  for (const ref of refs) {
    const list = byType.get(ref.type);
    if (list) list.push(ref.id);
    else byType.set(ref.type, [ref.id]);
  }

  const drafts = new Map<string, Partial<NodeDraft>>();
  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const loader = NODE_LOADERS[type];
      if (!loader) return;
      try {
        const loaded = await loader([...new Set(ids)].slice(0, NODES_PER_TYPE));
        for (const [id, draft] of loaded) drafts.set(nodeKey(type, id), draft);
      } catch (error) {
        console.error(
          JSON.stringify({
            component: 'control-tower-graph',
            event: 'node_loader_failed',
            type,
            message: error instanceof Error ? error.message : String(error),
          })
        );
      }
    })
  );

  // Costo de IA del expediente (plan 7.9: el tercer campo que `maskNode`
  // protege con `operations.admin`). El medidor `ai_case` lo escribe
  // `recordAgentUsage` por expediente, así que el único tipo de nodo que puede
  // llevarlo es `operational_case`; un fallo aquí deja el campo en null y nunca
  // tumba el grafo. Antes NINGÚN lector lo llenaba: el campo era siempre null,
  // la regla de máscara no borraba nada y el chip del inspector no se pintaba
  // jamás, ni para quien administra operaciones.
  const aiCostByCase = await loadCaseAiCost(byType.get(CASE_NODE_TYPE) ?? []);

  return refs.map((ref) => {
    const base = emptyNode(ref.type, ref.id);
    const aiCostUsd =
      ref.type === CASE_NODE_TYPE ? (aiCostByCase.get(ref.id) ?? null) : base.aiCostUsd;
    const draft = drafts.get(base.key);
    if (!draft) return { ...base, aiCostUsd };
    return {
      ...base,
      ...draft,
      aiCostUsd,
      key: base.key,
      id: base.id,
      type: base.type,
      typeLabel: base.typeLabel,
      label: draft.label ?? base.label,
      masked: [],
    };
  });
}

/** Tipo de nodo que tiene medidor de IA propio (`ai_case`). */
const CASE_NODE_TYPE = 'operational_case';

async function loadCaseAiCost(caseIds: readonly string[]): Promise<Map<string, number>> {
  if (caseIds.length === 0) return new Map();
  try {
    return await getCaseAiCostUsd([...new Set(caseIds)].slice(0, NODES_PER_TYPE));
  } catch (error) {
    console.error(
      JSON.stringify({
        component: 'control-tower-graph',
        event: 'ai_cost_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    );
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

function resolvePerspective(actor: CurrentUser, key: string | null | undefined): GraphPerspective {
  const perspective = getPerspective(key ?? DEFAULT_PERSPECTIVE_KEY);
  if (!perspective) throw new OperationsError('not_found', 'Esa perspectiva no existe');
  if (!canUsePerspective(toViewer(actor), perspective)) {
    throw new OperationsError('forbidden', 'No tienes permiso para esa perspectiva');
  }
  return perspective;
}

/**
 * Recorre el grafo desde las raíces. Exige `operations.admin` (la Torre de
 * Control) Y el permiso de la perspectiva; los campos sensibles se enmascaran
 * aparte, por campo.
 */
export async function queryOperationalGraph(
  actor: CurrentUser,
  input: QueryGraphInput
): Promise<OperationalGraph> {
  assertControlTowerAccess(actor);
  const perspective = resolvePerspective(actor, input.perspectiveKey);
  const roots = cleanRefs(input.roots ?? []);
  const at = input.at ?? new Date();
  const depth = clampDepth(input.depth ?? perspective.defaultDepth, perspective);
  const limit = clampNodeLimit(input.limit);
  const relations = effectiveRelations(perspective, input.relations);
  const nodeTypes = effectiveNodeTypes(perspective, input.nodeTypes);
  const computedAt = new Date();

  const base: OperationalGraph = {
    perspectiveKey: perspective.key,
    perspectiveLabel: perspective.label,
    at: at.toISOString(),
    depth,
    roots,
    nodes: [],
    edges: [],
    truncated: false,
    limit,
    computedAt: computedAt.toISOString(),
  };
  if (roots.length === 0) return base;

  const walk = await prisma.$queryRaw<WalkRow[]>(
    walkSql({
      rootTypes: roots.map((root) => root.type),
      rootIds: roots.map((root) => root.id),
      relations,
      nodeTypes,
      depth,
      at,
      limit: limit + 1,
    })
  );
  const truncated = walk.length > limit;
  const visible = truncated ? walk.slice(0, limit) : walk;
  const refs: GraphRef[] = visible.map((row) => ({ type: row.nodeType, id: row.nodeId }));

  const [nodes, edgeRows] = await Promise.all([
    loadGraphNodes(refs),
    refs.length === 0
      ? Promise.resolve<EdgeRow[]>([])
      : prisma.$queryRaw<EdgeRow[]>(
          edgesSql({
            types: refs.map((ref) => ref.type),
            ids: refs.map((ref) => ref.id),
            relations,
            at,
            limit: limit * 4,
          })
        ),
  ]);

  const depthByKey = new Map(visible.map((row) => [nodeKey(row.nodeType, row.nodeId), row.depth]));
  const rootKeys = new Set(roots.map((root) => nodeKey(root.type, root.id)));
  const masked = maskNodes(nodes, toViewer(actor));

  return {
    ...base,
    nodes: masked.map((node) => ({
      ...node,
      depth: depthByKey.get(node.key) ?? 0,
      root: rootKeys.has(node.key),
    })),
    edges: edgeRows.map((row) => ({
      key: `${row.fromType}:${row.fromId}|${row.relation}|${row.toType}:${row.toId}`,
      fromKey: nodeKey(row.fromType, row.fromId),
      toKey: nodeKey(row.toType, row.toId),
      fromType: row.fromType,
      fromId: row.fromId,
      toType: row.toType,
      toId: row.toId,
      relation: row.relation,
      relationLabel: relationLabel(row.relation),
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo ? row.validTo.toISOString() : null,
    })),
    truncated,
  };
}

export interface ExpandNodeInput {
  perspectiveKey?: string | null;
  node: GraphRef;
  at?: Date | null;
  limit?: number | null;
  relations?: readonly string[] | null;
  nodeTypes?: readonly string[] | null;
}

/** "Expandir": carga los vecinos directos de un nodo (profundidad 1). */
export async function expandNode(
  actor: CurrentUser,
  input: ExpandNodeInput
): Promise<OperationalGraph> {
  return queryOperationalGraph(actor, {
    ...(input.perspectiveKey !== undefined ? { perspectiveKey: input.perspectiveKey } : {}),
    roots: [input.node],
    depth: 1,
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.at !== undefined ? { at: input.at } : {}),
    ...(input.relations !== undefined ? { relations: input.relations } : {}),
    ...(input.nodeTypes !== undefined ? { nodeTypes: input.nodeTypes } : {}),
  });
}

/** Un nodo suelto (inspector), ya enmascarado. */
export async function getGraphNode(actor: CurrentUser, ref: GraphRef): Promise<GraphNode | null> {
  assertControlTowerAccess(actor);
  const cleaned = cleanRefs([ref]);
  if (cleaned.length === 0) return null;
  const nodes = await loadGraphNodes(cleaned);
  const masked = maskNodes(nodes, toViewer(actor));
  return masked[0] ?? null;
}
