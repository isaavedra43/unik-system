import {
  OUTPUT_KIND_LABELS,
  PRODUCTION_ORDER_STATUS_LABELS,
  productionOrderUrl,
  type OutputKind,
  type ProductionOrderStatus,
} from '@/modules/manufacturing/manufacturing-types';
import type { ProductionTrace } from '@/modules/manufacturing/manufacturing-queries';

/**
 * Pure model of the traceability of a production order (plan 6.2,
 * `recordOutput` → `produce` con `originProductionOrderId`).
 *
 * `getProductionTrace` and `traceStockItem` already read the chain from the
 * database; this file is the only place that decides HOW it reads on screen —
 * which side each row belongs to, what a substitution says, and what sale (if
 * any) the order was made for. ISOMORPHIC and pure: no Prisma, no React, so
 * the page, the panel and the tests agree.
 *
 * The two directions of the chain:
 *   materia prima  →  orden de producción  →  producto terminado  →  venta
 *   existencia     →  orden que la produjo  →  sus insumos
 */

export const TRACE_STOCK_PATH = '/app/manufacturing/trazabilidad';

/** Page of one existence: `/app/manufacturing/trazabilidad/<stockItemId>`. */
export function stockTraceUrl(stockItemId: string): string {
  return `${TRACE_STOCK_PATH}/${encodeURIComponent(stockItemId)}`;
}

export { productionOrderUrl };

export interface TraceLine {
  /** Stable key for React: the consumption / output id. */
  id: string;
  label: string;
  quantity: string;
  unit: string;
  /** Second line: substitution, container, warehouse, date. */
  hint: string | null;
  /** Existence this row moved, when it still is one (opens its own trace). */
  stockItemId: string | null;
}

export interface TraceSale {
  caseId: string;
  caseNumber: string | null;
  salesOrderNumber: string | null;
  customerName: string | null;
}

export interface TraceView {
  orderNumber: string;
  statusLabel: string;
  /** Materials that really went in (planned lines never appear here). */
  materials: TraceLine[];
  /** Outputs split the way the plant names them. */
  outputsByKind: Array<{ kind: OutputKind | 'other'; label: string; lines: TraceLine[] }>;
  /** The sale this order was made for, or null when it was made for stock. */
  sale: TraceSale | null;
  /** Said out loud for the person: what this order consumed and produced. */
  summary: string;
  /** True when nobody has recorded consumption nor output yet. */
  empty: boolean;
}

function outputKindLabel(kind: string): string {
  return (OUTPUT_KIND_LABELS as Record<string, string>)[kind] ?? 'Otra salida';
}

function statusLabel(status: string): string {
  return (
    (PRODUCTION_ORDER_STATUS_LABELS as Record<string, string>)[status as ProductionOrderStatus] ??
    status
  );
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/Mexico_City',
    }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
}

function joinHints(parts: Array<string | null | undefined>): string | null {
  const clean = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return clean.length > 0 ? clean.join(' · ') : null;
}

/** Dimensions of a saleable leftover read as a person says them (2.40 × 1.20 m). */
export function dimensionsText(dimensions: Record<string, unknown> | null): string | null {
  if (!dimensions) return null;
  const value = (key: string): string | null => {
    const raw = dimensions[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    return null;
  };
  const largo = value('largo');
  const ancho = value('ancho');
  const espesor = value('espesor');
  const unidad = value('unidadMedida') ?? value('unidad');
  const measures = [largo, ancho, espesor].filter((part): part is string => part !== null);
  if (measures.length === 0) return null;
  return `${measures.join(' × ')}${unidad ? ` ${unidad}` : ''}`;
}

/** The trace of one production order, ready to render. */
export function traceView(trace: ProductionTrace): TraceView {
  const materials: TraceLine[] = trace.materials.map((material) => ({
    id: material.consumptionId,
    label: material.label,
    quantity: material.quantity,
    unit: material.unit,
    hint: joinHints([
      material.substitutedForZohoItemId ? `Sustituyó a ${material.substitutedForZohoItemId}` : null,
      material.containerKey ? `Contenedor ${material.containerKey}` : null,
      shortDate(material.occurredAt),
    ]),
    stockItemId: material.stockItemId,
  }));

  const grouped = new Map<string, TraceLine[]>();
  for (const output of trace.outputs) {
    const line: TraceLine = {
      id: output.outputId,
      label: output.label,
      quantity: output.quantity,
      unit: output.unit,
      hint: joinHints([
        dimensionsText(output.dimensions),
        output.containerKey ? `Contenedor ${output.containerKey}` : null,
      ]),
      stockItemId: output.stockItemId,
    };
    grouped.set(output.kind, [...(grouped.get(output.kind) ?? []), line]);
  }
  // Fixed order so the finished good always reads first.
  const order = ['finished', 'leftover', 'scrap'];
  const outputsByKind = [...grouped.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
    })
    .map(([kind, lines]) => ({
      kind: (order.includes(kind) ? kind : 'other') as OutputKind | 'other',
      label: outputKindLabel(kind),
      lines,
    }));

  const sale: TraceSale | null = trace.order.caseId
    ? {
        caseId: trace.order.caseId,
        caseNumber: trace.order.caseNumber,
        salesOrderNumber: trace.order.salesOrderNumber,
        customerName: trace.order.customerName,
      }
    : null;

  const producedLines = outputsByKind.reduce((total, group) => total + group.lines.length, 0);
  const summary = [
    materials.length === 0
      ? 'Todavía no se registra consumo de material'
      : materials.length === 1
        ? '1 material consumido'
        : `${materials.length} materiales consumidos`,
    producedLines === 0
      ? 'sin salidas registradas'
      : producedLines === 1
        ? '1 salida registrada'
        : `${producedLines} salidas registradas`,
    sale
      ? `para ${sale.caseNumber ?? 'un expediente'}${sale.customerName ? ` de ${sale.customerName}` : ''}`
      : 'para inventario, sin venta ligada',
  ].join(' · ');

  return {
    orderNumber: trace.order.number,
    statusLabel: statusLabel(trace.order.status),
    materials,
    outputsByKind,
    sale,
    summary,
    empty: materials.length === 0 && producedLines === 0,
  };
}

export interface StockTraceProduction {
  productionOrderId: string;
  number: string | null;
  quantity: string;
  lastProducedAt: string;
  href: string;
  /** «12 pza el 03 mar 14:20» — said the way the warehouse says it. */
  text: string;
}

export interface StockTraceView {
  /** Every production order that produced into this row, latest first. */
  productions: StockTraceProduction[];
  /** Trace of the order that produced it last (null when it was never produced). */
  production: TraceView | null;
  /** True when this existence never came out of a production order. */
  external: boolean;
  headline: string;
}

/** From an existence back to the order that produced it and to its raw materials. */
export function stockTraceView(result: {
  stockItem: { id: string; containerKey: string; originProductionOrderId: string | null };
  productions: Array<{
    productionOrderId: string;
    number: string | null;
    quantity: string;
    lastProducedAt: string;
  }>;
  production: ProductionTrace | null;
}): StockTraceView {
  const productions = result.productions.map((entry) => ({
    ...entry,
    href: productionOrderUrl(entry.productionOrderId),
    text: `${entry.quantity}${shortDate(entry.lastProducedAt) ? ` el ${shortDate(entry.lastProducedAt)}` : ''}`,
  }));
  const production = result.production ? traceView(result.production) : null;
  const external = productions.length === 0 && result.stockItem.originProductionOrderId === null;
  const headline = external
    ? 'Esta existencia no salió de una orden de producción: llegó de una compra, un ajuste o el inventario inicial.'
    : production
      ? `Producida en ${production.orderNumber}${production.sale?.caseNumber ? ` para ${production.sale.caseNumber}` : ''}.`
      : 'Esta existencia viene de una orden de producción que ya no se puede consultar.';
  return { productions, production, external, headline };
}
