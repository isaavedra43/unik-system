import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import type { PipelineStageDTO, RadarSignalDTO } from '@/modules/crm/crm-dto';
import {
  getPipelineBoard,
  listRadarSignals,
  getRadarSummary,
  type PipelineBoard,
  type RadarSummary,
} from '@/modules/crm/crm-queries';
import { listPipelineStages } from '@/modules/crm/pipeline-service';
import { decimalString } from '@/modules/crm/crm-helpers';
import type { RadarKind, RadarStatus } from '@/modules/crm/types';

/**
 * Lecturas propias de las vistas de Ventas (plan 7.6 y subpáginas). SÓLO
 * SERVIDOR: envuelven los servicios del módulo CRM (que ya validan permisos y
 * visibilidad por vendedor) y agregan lo que la pantalla necesita para no hacer
 * varias llamadas.
 */

export interface RadarBoardPayload {
  signals: RadarSignalDTO[];
  total: number;
  nextCursor: string | null;
  summary: RadarSummary;
  permissions: {
    canManage: boolean;
    canCreateSalesOrder: boolean;
    canUseInbox: boolean;
  };
  computedAt: string;
}

export interface RadarBoardQuery {
  salesperson?: string;
  kinds?: RadarKind[];
  status?: RadarStatus;
  minScore?: number;
  limit?: number;
  cursor?: string;
}

/** Señales visibles para la persona + el resumen por tipo y vendedor. */
export async function getRadarBoard(
  actor: CurrentUser,
  query: RadarBoardQuery = {}
): Promise<RadarBoardPayload> {
  const [page, summary] = await Promise.all([
    listRadarSignals(actor, {
      ...(query.salesperson ? { salespersonUserId: query.salesperson } : {}),
      ...(query.kinds && query.kinds.length > 0 ? { kinds: query.kinds } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.minScore !== undefined ? { minScore: query.minScore } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit ?? 50,
    }),
    getRadarSummary(actor),
  ]);
  return {
    signals: page.items,
    total: page.total,
    nextCursor: page.nextCursor,
    summary,
    permissions: {
      canManage: hasPermission(actor, 'crm.manage'),
      canCreateSalesOrder: hasPermission(actor, 'crm.create_sales_order'),
      canUseInbox: hasPermission(actor, 'inbox.use'),
    },
    computedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Embudo
// ---------------------------------------------------------------------------

export interface VentasPipelinePayload {
  board: PipelineBoard;
  /** Etapas activas: las columnas del tablero. */
  stages: PipelineStageDTO[];
  /**
   * Todas las etapas, incluidas las apagadas. Sólo se llena para quien tiene
   * `crm.manage_stages`: es la lista que administra el embudo (plan 6.5).
   */
  allStages: PipelineStageDTO[];
  permissions: { canManage: boolean; canCreateSalesOrder: boolean; canManageStages: boolean };
}

export async function getVentasPipeline(
  actor: CurrentUser,
  options: { salesperson?: string; search?: string } = {}
): Promise<VentasPipelinePayload> {
  const canManageStages = hasPermission(actor, 'crm.manage_stages');
  const [board, stages, allStages] = await Promise.all([
    getPipelineBoard(actor, {
      ...(options.salesperson ? { salespersonUserId: options.salesperson } : {}),
      ...(options.search ? { search: options.search } : {}),
      perStage: 25,
    }),
    listPipelineStages(actor),
    canManageStages
      ? listPipelineStages(actor, { includeInactive: true })
      : Promise.resolve([] as PipelineStageDTO[]),
  ]);
  return {
    board,
    stages,
    allStages,
    permissions: {
      canManage: hasPermission(actor, 'crm.manage'),
      canCreateSalesOrder: hasPermission(actor, 'crm.create_sales_order'),
      canManageStages,
    },
  };
}

// ---------------------------------------------------------------------------
// Cotizaciones aceptadas por convertir
// ---------------------------------------------------------------------------

export interface ConvertibleQuote {
  quoteId: string;
  estimateNumber: string;
  customerName: string | null;
  total: string | null;
  currencyCode: string | null;
  acceptedAt: string | null;
  opportunityId: string | null;
  opportunityNumber: string | null;
}

const CONVERTIBLE_WINDOW_DAYS = 180;
const CONVERTIBLE_LIMIT = 20;

/**
 * Cotizaciones aceptadas que todavía no se convirtieron en orden de venta
 * (la llave real es el ledger `SalesOrderWriteRequest`, no un estado local).
 * Vacío para quien no puede ver cotizaciones.
 */
export async function listConvertibleQuotes(actor: CurrentUser): Promise<ConvertibleQuote[]> {
  if (!hasPermission(actor, 'quotes.view')) return [];
  const since = new Date(Date.now() - CONVERTIBLE_WINDOW_DAYS * 86_400_000);
  const quotes = await prisma.quote.findMany({
    where: {
      status: 'accepted',
      OR: [{ acceptedDate: { gte: since } }, { acceptedDate: null, date: { gte: since } }],
    },
    orderBy: [{ acceptedDate: 'desc' }, { date: 'desc' }],
    take: CONVERTIBLE_LIMIT * 3,
    select: {
      id: true,
      zohoEstimateId: true,
      estimateNumber: true,
      customerName: true,
      total: true,
      currencyCode: true,
      acceptedDate: true,
    },
  });
  if (quotes.length === 0) return [];

  const converted = await prisma.salesOrderWriteRequest.findMany({
    where: { quoteId: { in: quotes.map((quote) => quote.id) }, status: 'completed' },
    select: { quoteId: true },
  });
  const convertedIds = new Set(converted.map((row) => row.quoteId));
  const pending = quotes.filter((quote) => !convertedIds.has(quote.id)).slice(0, CONVERTIBLE_LIMIT);
  if (pending.length === 0) return [];

  const opportunities = await prisma.opportunity.findMany({
    where: { zohoEstimateIds: { hasSome: pending.map((quote) => quote.zohoEstimateId) } },
    orderBy: { lastActivityAt: 'desc' },
    select: { id: true, number: true, zohoEstimateIds: true },
  });
  const byEstimate = new Map<string, { id: string; number: string }>();
  for (const opportunity of opportunities) {
    for (const estimateId of opportunity.zohoEstimateIds) {
      if (!byEstimate.has(estimateId)) {
        byEstimate.set(estimateId, { id: opportunity.id, number: opportunity.number });
      }
    }
  }

  return pending.map((quote) => {
    const opportunity = byEstimate.get(quote.zohoEstimateId) ?? null;
    return {
      quoteId: quote.id,
      estimateNumber: quote.estimateNumber ?? quote.zohoEstimateId,
      customerName: quote.customerName,
      total: decimalString(quote.total),
      currencyCode: quote.currencyCode,
      acceptedAt: quote.acceptedDate ? quote.acceptedDate.toISOString() : null,
      opportunityId: opportunity?.id ?? null,
      opportunityNumber: opportunity?.number ?? null,
    };
  });
}
