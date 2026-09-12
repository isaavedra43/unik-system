import { z } from 'zod';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { createArtifact } from '../ai-artifacts-service';
import { saveGeneratedFile } from '@/modules/storage/storage-service';
import { generatePdfReport, type PdfTableColumn, type PdfSection } from '../generators/pdf-generator';
import { generateExcelReport, type ExcelColumn } from '../generators/excel-generator';
import { generateCsvReport } from '../generators/csv-generator';
import { generateChartSvg } from '../generators/chart-generator';
import { generateReportImageSvg } from '../generators/image-report-generator';
import { hexToArgb } from '../generators/status-tone';
import { generateTableData } from '../generators/table-generator';
import { getAiSettings } from '../ai-admin-config-service';
import { parseNumeric, sumColumn } from '../ai-report-helpers';

/**
 * Shared parameter for every row-consuming artifact tool. The orchestrator ALWAYS replaces the
 * model's `rows` with the complete result of the last data tool unless this is true — that's
 * what guarantees a report covers every matching row with raw (unformatted) values.
 */
const subsetOnlySchema = z.boolean().optional().describe(
  'Déjalo vacío casi siempre: el sistema llena rows con TODAS las filas de la última consulta de datos. ' +
  'Pon true SOLO si el usuario pidió explícitamente un subconjunto pequeño que tú eliges a mano (ej. "solo estas 3 órdenes") — ' +
  'para subconjuntos por filtro (cerradas, pagadas, de un cliente...) NO uses esto: vuelve a llamar la tool de datos con el filtro y luego genera el reporte.'
);

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Generators write to a per-job temporary directory; the finished file is then
 * uploaded to the object storage (R2 in production) and the temporary directory
 * is removed. Nothing permanent is ever written to the local disk.
 */
async function withTempArtifactFile<T>(
  ext: string,
  work: (filePath: string) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unik-artifact-'));
  const filePath = path.join(dir, `artifact.${ext}`);
  try {
    return await work(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function storeArtifactFile(
  actorId: string,
  filePath: string,
  fileName: string,
  mimeType: string,
  meta: Record<string, unknown>
): Promise<{ storageObjectId: string; sizeBytes: number }> {
  const object = await saveGeneratedFile({
    createdBy: actorId,
    purpose: 'ai_artifact',
    fileName,
    mimeType,
    source: { filePath },
    metadata: meta,
  });
  return { storageObjectId: object.id, sizeBytes: Number(object.sizeBytes) };
}

/**
 * Auto-generates column definitions from the keys of the first row.
 * This lets the IA just pass `rows` without having to define columns.
 */
function autoColumns(rows: Record<string, unknown>[]): Array<{
  header: string;
  key: string;
  format?: string;
}> {
  if (rows.length === 0) return [];
  let keys = Object.keys(rows[0]);

  // Sales-order rows (from querySalesOrders/auditPendingDeliveries) carry ~16 fields; a report
  // that prints all of them is unreadable (headers/amounts break mid-word, four status columns
  // say what the single "Ticket" column already summarizes, "Sucursal" is always the same).
  // Curate a presentable default set; the model can still pass explicit `columns` for more.
  const isSalesOrderRow = keys.includes('number') && keys.includes('customer') && keys.includes('ticketStatus');
  if (isSalesOrderRow) {
    const curated = [
      'number', 'date', 'customer', 'salesperson', 'ticketStatus', 'paidStatus',
      'paymentMethod', 'deliveryMethod', 'total', 'balance',
      // long text → rendered as detail lines under the row by the PDF generator
      'shippingAddress', 'items',
    ];
    keys = curated.filter((k) => keys.includes(k));
  }

  // Preferred column order for sales data
  const preferredOrder = [
    'number', 'date', 'customer', 'salesperson', 'ticketStatus', 'status', 'paidStatus',
    'invoicedStatus', 'shippedStatus', 'paymentMethod', 'deliveryMethod', 'total', 'balance',
    'location', 'product', 'quantity', 'count', 'orders', 'revenue', 'amount',
    'shippingAddress', 'items',
  ];

  // Sort keys by preferred order, unknown keys go last
  const sortedKeys = [...keys].sort((a, b) => {
    const aIdx = preferredOrder.indexOf(a);
    const bIdx = preferredOrder.indexOf(b);
    if (aIdx === -1 && bIdx === -1) return 0;
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  // Human-readable header labels
  const headerLabels: Record<string, string> = {
    number: 'Orden',
    customer: 'Cliente',
    total: 'Total',
    balance: 'Saldo',
    status: 'Estado',
    date: 'Fecha',
    paymentMethod: 'Método',
    salesperson: 'Vendedor',
    location: 'Sucursal',
    product: 'Producto',
    quantity: 'Cantidad',
    count: 'Cantidad',
    orders: 'Órdenes',
    revenue: 'Ingreso',
    amount: 'Monto',
    paidStatus: 'Pago',
    invoicedStatus: 'Factura',
    shippedStatus: 'Envío',
    ticketStatus: 'Ticket',
    deliveryMethod: 'Entrega',
    subStatus: 'Sub-estado',
    items: 'Productos',
    shippingAddress: 'Dirección',
    notes: 'Notas',
    phone: 'Teléfono',
    key: 'Grupo',
    groupCount: 'Grupos',
  };

  return sortedKeys.map((key) => {
    let format: string | undefined;
    const lower = key.toLowerCase();
    if (lower === 'total' || lower === 'balance' || lower === 'amount' || lower === 'revenue') {
      format = 'currency';
    } else if (lower === 'date' || lower === 'orderdate' || lower === 'createdat') {
      format = 'date';
    } else if (lower === 'count' || lower === 'quantity' || lower === 'orders') {
      format = 'number';
    }
    const header = headerLabels[key] ?? (key.charAt(0).toUpperCase() + key.slice(1));
    return { header, key, format };
  });
}

function formatValue(value: unknown, format?: string): string {
  if (value === null || value === undefined) return '';
  if (format === 'currency') {
    // Values may be Prisma Decimal strings ("1797.00") or amounts the model already formatted
    // ("$1,797.00 MXN"); parse both — never print "$NaN".
    const n = parseNumeric(value);
    return n === null ? String(value) : `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (format === 'number') {
    const n = parseNumeric(value);
    return n === null ? String(value) : n.toLocaleString('es-MX', { maximumFractionDigits: 2 });
  }
  if (format === 'percentage') {
    return `${value}%`;
  }
  if (format === 'date') {
    // Format YYYY-MM-DD to DD/MM/YYYY
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-');
      return `${d}/${m}/${y}`;
    }
    return s;
  }
  // Handle arrays — join items with comma
  if (Array.isArray(value)) {
    return value.map((v) => formatValue(v)).join(', ');
  }
  // Handle objects — stringify to key: value pairs
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const formatted = formatValue(v);
      if (formatted) parts.push(`${k}: ${formatted}`);
    }
    return parts.join('; ');
  }
  // Translate status values to Spanish
  const s = String(value);
  const statusMap: Record<string, string> = {
    confirmed: 'Confirmada',
    draft: 'Borrador',
    closed: 'Cerrada',
    cancelled: 'Cancelada',
    pending: 'Pendiente',
  };
  if (statusMap[s.toLowerCase()]) {
    return statusMap[s.toLowerCase()];
  }
  return s;
}

/**
 * Flattens a row object so that nested objects/arrays are expanded into
 * separate columns or stringified. This prevents [object Object] in PDFs/Excel.
 *
 * Example: { customer: "Juan", items: [{name: "Silla", qty: 2}] }
 * becomes: { customer: "Juan", items: "name: Silla, qty: 2; name: ..." }
 */
function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) {
      result[key] = value;
    } else if (Array.isArray(value)) {
      // Arrays of objects: stringify each item and join
      result[key] = value.map((v) =>
        typeof v === 'object' && v !== null ? formatValue(v) : String(v)
      ).join('\n');
    } else if (typeof value === 'object') {
      // Nested object: stringify to key: value pairs
      result[key] = formatValue(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const SUMMABLE_COUNT_KEYS = new Set(['count', 'quantity', 'orders', 'totalquantity', 'totalproducts']);

/**
 * Builds the "TOTAL" row for a table: sums every currency column (and count-like numeric
 * columns) across ALL rows and labels the first text column "TOTAL (N filas)". Returns null when
 * nothing is summable, so plain text tables don't get an empty totals row.
 */
function buildTotalsRow(
  rows: Record<string, unknown>[],
  cols: Array<{ header: string; key: string; format?: string }>
): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  const totals: Record<string, unknown> = {};
  let any = false;
  for (const c of cols) {
    const lower = c.key.toLowerCase();
    const isMoney = c.format === 'currency';
    const isCount = c.format === 'number' || SUMMABLE_COUNT_KEYS.has(lower);
    if (!isMoney && !isCount) continue;
    const sum = sumColumn(rows, c.key);
    if (sum === null) continue;
    totals[c.key] = isMoney ? sum.toFixed(2) : String(Math.round(sum * 100) / 100);
    any = true;
  }
  if (!any) return null;
  // "TOTAL" in the first text column (usually the narrow id column) and the row count in the
  // next one, so neither label wraps inside a narrow column.
  const textCols = cols.filter((c) => !(c.key in totals) && c.format !== 'date');
  const countLabel = `${rows.length} ${rows.length === 1 ? 'fila' : 'filas'}`;
  if (textCols.length >= 2) {
    totals[textCols[0].key] = 'TOTAL';
    totals[textCols[1].key] = countLabel;
  } else if (textCols.length === 1) {
    totals[textCols[0].key] = `TOTAL · ${countLabel}`;
  }
  return totals;
}

/** Summary chips for the inline chat table: row count + every summable column, from ALL rows. */
function tableSummaryFromTotals(
  rows: Record<string, unknown>[],
  cols: Array<{ header: string; key: string; format?: string }>
): Array<{ label: string; value: string }> | undefined {
  const totals = buildTotalsRow(rows, cols);
  const summary: Array<{ label: string; value: string }> = [{ label: 'Filas', value: String(rows.length) }];
  if (totals) {
    for (const c of cols) {
      if (!(c.key in totals)) continue;
      const v = totals[c.key];
      if (typeof v === 'string' && v.startsWith('TOTAL')) continue;
      summary.push({ label: c.header, value: formatValue(v, c.format ?? 'number') });
    }
  }
  return summary;
}

const NO_ROWS_ERROR =
  'No recibí filas para el reporte. Vuelve a llamar la tool de datos (ej. querySalesOrders con los mismos filtros de la conversación) ' +
  'y en cuanto tengas su resultado llama esta tool otra vez: el sistema tomará automáticamente TODAS las filas de esa consulta.';

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. generatePdfReport
registerTool({
  name: 'generatePdfReport',
  effect: 'draft',
  description:
    'Genera un PDF con los datos que le pases. ' +
    'MODO SIMPLE: pasa title y rows (un array de objetos). ' +
    'MODO MULTI-SECCIÓN: pasa title y sections (array de secciones, cada una con title, rows y columns opcionales). ' +
    'Úsalo para reportes complejos con múltiples tablas (ej: resumen de ventas con desglose por método de pago, estado, vendedor y sucursal). ' +
    'EJEMPLO SIMPLE: si querySalesOrders devolvió {orders: [{number: "OV-1", customer: "Juan", total: "100"}]}, ' +
    'pasa rows = [{number: "OV-1", customer: "Juan", total: "100"}] y title = "Ventas en Efectivo". ' +
    'EJEMPLO MULTI-SECCIÓN: si getSalesOrdersSummary devolvió {byPaymentMethod: [...], byStatus: [...], bySalesperson: [...]}, ' +
    'pasa sections = [{title: "Por Método de Pago", rows: byPaymentMethod}, {title: "Por Estado", rows: byStatus}, {title: "Por Vendedor", rows: bySalesperson}].',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().default('Reporte UNIK').describe('Título del reporte (ej: "Ventas en Efectivo de Ayer")'),
    subtitle: z.string().optional().describe('Subtítulo opcional'),
    rows: z.array(z.record(z.unknown())).optional().describe(
      'MODO SIMPLE: Los datos a mostrar como una sola tabla. Pasa el array de la tool anterior. ' +
      'EJ: si querySalesOrders devolvió orders, pasa ese array.'
    ),
    columns: z.array(z.object({
      header: z.string(),
      key: z.string(),
      format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
    })).optional().describe(
      'OPCIONAL (modo simple). Si no lo pasas, se generan automáticamente de las claves de las rows.'
    ),
    sections: z.array(z.object({
      title: z.string().optional().describe('Título de la sección (ej: "Por Método de Pago")'),
      rows: z.array(z.record(z.unknown())).describe('Datos de esta sección'),
      columns: z.array(z.object({
        header: z.string(),
        key: z.string(),
        format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
      })).optional().describe('Columnas opcionales. Se auto-generan si no se pasan.'),
    })).optional().describe(
      'MODO MULTI-SECCIÓN: Array de secciones para reportes complejos. ' +
      'Cada sección tiene su propio título y tabla. ' +
      'Úsalo cuando el usuario pida un reporte completo con múltiples desgloses.'
    ),
    summaryCards: z.array(z.object({
      label: z.string(),
      value: z.string(),
    })).optional().describe('KPIs de resumen (ej: [{label: "Total", value: "$73,987.77"}, {label: "Órdenes", value: "8"}])'),
    brandColor: z.string().optional().describe('Color hex (ej: #2563eb)'),
    subsetOnly: subsetOnlySchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      subtitle?: string;
      rows?: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
      sections?: Array<{ title?: string; rows: Record<string, unknown>[]; columns?: Array<{ header: string; key: string; format?: string }> }>;
      summaryCards?: Array<{ label: string; value: string }>;
      brandColor?: string;
    };

    // Build sections from either args.sections or args.rows
    const hasSections = args.sections && args.sections.length > 0;
    const hasRows = args.rows && args.rows.length > 0;

    if (!hasSections && !hasRows) {
      return { error: NO_ROWS_ERROR };
    }


    // Relative column width WEIGHTS (the generator normalizes these to always fit the
    // page — a table can never overflow the page edge regardless of column count).
    const widthMap: Record<string, number> = {
      number: 62,
      customer: 130,
      total: 75,
      balance: 75,
      status: 65,
      paidStatus: 70,
      invoicedStatus: 75,
      shippedStatus: 70,
      date: 62,
      paymentMethod: 95,
      salesperson: 95,
      location: 85,
      quantity: 60,
      count: 55,
      orders: 55,
      name: 130,
      totalProducts: 60,
      deliveryMethod: 110,
      key: 130,
      revenue: 75,
      amount: 75,
      phone: 85,
      ticketStatus: 90,
    };

    // Short identifiers/amounts must never wrap mid-word ("OV-233/81", "$5,166.7/2").
    const NOWRAP_KEYS = new Set(['number', 'date', 'total', 'balance', 'amount', 'revenue', 'quantity', 'count', 'orders', 'phone']);

    // Long free-text fields never fit as a skinny table column without being clipped —
    // render them as a full-width wrapped line below the row instead.
    const DETAIL_KEYS = new Set(['items', 'shippingAddress', 'notes', 'description', 'address', 'direccion', 'dirección']);

    function buildPdfColumns(cols: Array<{ header: string; key: string; format?: string }>): PdfTableColumn[] {
      return cols.map((c) => ({
        header: c.header,
        key: c.key,
        width: widthMap[c.key] ?? 85,
        detail: DETAIL_KEYS.has(c.key),
        nowrap: NOWRAP_KEYS.has(c.key) || c.format === 'currency' || c.format === 'number' || c.format === 'date',
        align: c.format === 'currency' || c.format === 'number'
          ? 'right'
          : c.format === 'date' || c.key === 'status'
          ? 'center'
          : 'left',
        format: (v: unknown) => formatValue(v, c.format),
      }));
    }

    let pdfSections: PdfSection[] = [];
    let totalRowCount = 0;

    if (hasSections) {
      // Multi-section mode
      pdfSections = args.sections!.map((sec) => {
        const flatRows = sec.rows.map((r) => flattenRow(r));
        totalRowCount += flatRows.length;
        const cols = sec.columns ?? autoColumns(flatRows);
        return {
          title: sec.title,
          columns: buildPdfColumns(cols),
          rows: flatRows,
          totalsRow: buildTotalsRow(flatRows, cols) ?? undefined,
        };
      });
    } else {
      // Simple mode
      const flatRows = (args.rows ?? []).map((r) => flattenRow(r));
      totalRowCount = flatRows.length;
      const cols = args.columns ?? autoColumns(flatRows);
      pdfSections = [{
        columns: buildPdfColumns(cols),
        rows: flatRows,
        totalsRow: buildTotalsRow(flatRows, cols) ?? undefined,
      }];
    }

    const pdfFileName = `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
    const { sizeBytes, pageCount, storageObjectId } = await withTempArtifactFile('pdf', async (filePath) => {
      const generated = await generatePdfReport(filePath, {
        title: args.title,
        subtitle: args.subtitle,
        brandColor: args.brandColor,
        logoText: 'UNIK',
        columns: pdfSections[0]?.columns ?? [],
        rows: pdfSections[0]?.rows ?? [],
        sections: pdfSections,
        summaryCards: args.summaryCards,
        orientation: 'landscape',
      });
      const stored = await storeArtifactFile(_actor.id, filePath, pdfFileName, 'application/pdf', {
        title: args.title,
        pageCount: generated.pageCount,
      });
      return { ...generated, storageObjectId: stored.storageObjectId };
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'pdf',
      storageObjectId,
      meta: {
        title: args.title,
        filename: `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes,
        pageCount,
        rowCount: totalRowCount,
        sectionCount: pdfSections.length,
        brandColor: args.brandColor,
      },
    });

    return {
      artifactId: artifact.id,
      type: 'pdf',
      title: args.title,
      filename: `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
      sizeBytes,
      pageCount,
      rowCount: totalRowCount,
      sectionCount: pdfSections.length,
      downloadUrl: `/app/assistant/api/artifacts/${artifact.id}/download`,
    };
  },
});

// 2. generateExcelReport
registerTool({
  name: 'generateExcelReport',
  effect: 'draft',
  description:
    'Genera un Excel (XLSX) con los datos que le pases. SOLO necesitas pasar title y rows.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().default('Reporte UNIK').describe('Título del reporte'),
    subtitle: z.string().optional(),
    rows: z.array(z.record(z.unknown())).optional().describe('Los datos a mostrar (array de la tool anterior)'),
    columns: z.array(z.object({
      header: z.string(),
      key: z.string(),
      format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
    })).optional().describe('OPCIONAL. Se generan automáticamente si no se pasan.'),
    summaryCards: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    brandColor: z.string().optional(),
    subsetOnly: subsetOnlySchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      subtitle?: string;
      rows?: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
      summaryCards?: Array<{ label: string; value: string }>;
      brandColor?: string;
    };

    const rows = (args.rows ?? []).map((r) => flattenRow(r));
    if (rows.length === 0) {
      return { error: NO_ROWS_ERROR };
    }


    const cols = args.columns ?? autoColumns(rows);

    const excelColumns: ExcelColumn[] = cols.map((c) => ({
      header: c.header,
      key: c.key,
      type: c.format === 'currency' ? 'currency' : c.format === 'number' ? 'number' : c.format === 'date' ? 'date' : c.format === 'percentage' ? 'percentage' : 'text',
    }));

    const xlsxFileName = `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`;
    const xlsxMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const { sizeBytes, storageObjectId } = await withTempArtifactFile('xlsx', async (filePath) => {
      const generated = await generateExcelReport(filePath, {
        title: args.title,
        subtitle: args.subtitle,
        brandColor: args.brandColor ? hexToArgb(args.brandColor) : undefined,
        columns: excelColumns,
        rows,
        summaryCards: args.summaryCards,
      });
      const stored = await storeArtifactFile(_actor.id, filePath, xlsxFileName, xlsxMime, { title: args.title });
      return { ...generated, storageObjectId: stored.storageObjectId };
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'xlsx',
      storageObjectId,
      meta: {
        title: args.title,
        filename: `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes,
        rowCount: rows.length,
        columns: cols.map((c) => c.header),
      },
    });

    return {
      artifactId: artifact.id,
      type: 'xlsx',
      title: args.title,
      filename: `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`,
      sizeBytes,
      rowCount: rows.length,
      downloadUrl: `/app/assistant/api/artifacts/${artifact.id}/download`,
    };
  },
});

// 3. generateCsvExport
registerTool({
  name: 'generateCsvExport',
  effect: 'draft',
  description:
    'Genera un CSV con los datos que le pases. SOLO necesitas pasar title y rows.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().default('Export UNIK').describe('Título'),
    rows: z.array(z.record(z.unknown())).optional().describe('Los datos a exportar (array de la tool anterior)'),
    columns: z.array(z.object({
      header: z.string(),
      key: z.string(),
      format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
    })).optional().describe('OPCIONAL. Se generan automáticamente si no se pasan.'),
    subsetOnly: subsetOnlySchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      rows?: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
    };

    const rows = (args.rows ?? []).map((r) => flattenRow(r));
    if (rows.length === 0) {
      return { error: NO_ROWS_ERROR };
    }


    const cols = args.columns ?? autoColumns(rows);

    const csvFileName = `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`;
    const { sizeBytes, storageObjectId } = await withTempArtifactFile('csv', async (filePath) => {
      const generated = generateCsvReport(filePath, {
        title: args.title,
        columns: cols.map((c) => ({
          header: c.header,
          key: c.key,
          format: (v: unknown) => formatValue(v, c.format),
        })),
        rows,
        includeMetadata: true,
      });
      const stored = await storeArtifactFile(_actor.id, filePath, csvFileName, 'text/csv', { title: args.title });
      return { ...generated, storageObjectId: stored.storageObjectId };
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'csv',
      storageObjectId,
      meta: {
        title: args.title,
        filename: `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`,
        mimeType: 'text/csv',
        sizeBytes,
        rowCount: rows.length,
        columns: cols.map((c) => c.header),
      },
    });

    return {
      artifactId: artifact.id,
      type: 'csv',
      title: args.title,
      filename: `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`,
      sizeBytes,
      rowCount: rows.length,
      downloadUrl: `/app/assistant/api/artifacts/${artifact.id}/download`,
    };
  },
});

// 4. generateChart
registerTool({
  name: 'generateChart',
  effect: 'draft',
  description:
    'Genera una gráfica (barras, línea, pie) que se muestra en el chat. Pasa labels y values.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    chartType: z.enum(['bar', 'horizontal-bar', 'line', 'pie', 'doughnut']).default('bar').describe('Tipo de gráfica'),
    title: z.string().default('Gráfica de Datos').describe('Título de la gráfica'),
    subtitle: z.string().optional(),
    labels: z.array(z.string()).optional().describe('Etiquetas (se auto-generan de los datos)'),
    series: z.array(z.object({
      label: z.string().describe('Nombre de la serie'),
      values: z.array(z.number()).describe('Valores'),
    })).optional().describe('Series de datos (se auto-generan de los datos)'),
    colors: z.array(z.string()).optional(),
    showValues: z.boolean().optional(),
    showLegend: z.boolean().optional(),
    brandColor: z.string().optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      chartType: 'bar' | 'horizontal-bar' | 'line' | 'pie' | 'doughnut';
      title: string;
      subtitle?: string;
      labels?: string[];
      series?: Array<{ label: string; values: number[] }>;
      colors?: string[];
      showValues?: boolean;
      showLegend?: boolean;
      brandColor?: string;
    };

    if (!args.labels || !args.series) {
      return { error: 'No hay datos para generar la gráfica. Llama primero una tool de datos (ej: getCashSales, getTopProducts).' };
    }

    const svg = generateChartSvg({
      type: args.chartType,
      title: args.title,
      subtitle: args.subtitle,
      labels: args.labels,
      series: args.series,
      colors: args.colors,
      showValues: args.showValues ?? true,
      showLegend: args.showLegend ?? true,
      brandColor: args.brandColor,
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'chart',
      inlineData: { svg, chartType: args.chartType },
      meta: {
        title: args.title,
        chartType: args.chartType,
        labels: args.labels,
        seriesCount: args.series.length,
        brandColor: args.brandColor,
      },
    });

    return {
      artifactId: artifact.id,
      type: 'chart',
      title: args.title,
      chartType: args.chartType,
      inlineRender: true,
    };
  },
});

// 4b. generateReportImage — a REPORT rendered as a single image (title + KPIs + table),
// NOT a bar/line/pie chart. Use generateChart for those; use this when the user explicitly
// asks for "una imagen del reporte" / "una foto con los datos" / algo para compartir directo.
registerTool({
  name: 'generateReportImage',
  effect: 'draft',
  description:
    'Genera IMÁGENES (PNG/SVG) con el reporte: título, KPIs y una tabla — NO es una gráfica de barras/línea/pie (para eso usa generateChart). ' +
    'Úsalo cuando el usuario pida explícitamente "una imagen del reporte", "una foto con los datos", o algo para compartir directo por WhatsApp/redes sin abrir un PDF. ' +
    'Cada imagen muestra hasta ~25 filas (ajustable con maxRows); si hay más filas de las que caben en una imagen, el sistema genera AUTOMÁTICAMENTE varias imágenes ("Parte 1 de 3", "Parte 2 de 3"...) hasta cubrir TODAS las filas (límite de 40 imágenes ≈ 1000 filas — si el usuario pidió aún más, ofrece PDF/Excel para el resto). ' +
    'SOLO necesitas pasar title (las filas las toma el sistema de la última consulta de datos, TODAS, sin que las escribas); columnas y KPIs se auto-generan igual que en generatePdfReport. Los estados (Cerrado, Pendiente, etc.) se colorean automáticamente y la última imagen incluye la fila de TOTALES.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().default('Reporte UNIK').describe('Título del reporte'),
    subtitle: z.string().optional(),
    rows: z.array(z.record(z.unknown())).optional().describe('Los datos a mostrar (array de la tool anterior). Pasa TODAS las filas que quieras cubrir — si no caben en una imagen, se generan las que hagan falta.'),
    columns: z.array(z.object({
      header: z.string(),
      key: z.string(),
      format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
    })).optional().describe('OPCIONAL. Se generan automáticamente de las claves de las rows si no se pasan (columnas de texto largo como direcciones/items se omiten para mantener la imagen compacta).'),
    summaryCards: z.array(z.object({ label: z.string(), value: z.string() })).optional().describe('KPIs de resumen del TOTAL (ej: [{label: "Total", value: "$500,000.00"}]) — se muestran solo en la primera imagen.'),
    brandColor: z.string().optional().describe('Color hex (ej: #2563eb).'),
    maxRows: z.number().int().min(1).max(60).default(25).describe('Filas por imagen (default 25). No limita el total: si hay más filas que esto, se generan más imágenes.'),
    subsetOnly: subsetOnlySchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      subtitle?: string;
      rows?: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
      summaryCards?: Array<{ label: string; value: string }>;
      brandColor?: string;
      maxRows: number;
    };

    const flatRows = (args.rows ?? []).map((r) => flattenRow(r));
    if (flatRows.length === 0) {
      return { error: NO_ROWS_ERROR };
    }

    // Long free-text fields never fit in a compact image row — keep the snapshot glanceable.
    const IMAGE_EXCLUDE_KEYS = new Set(['items', 'shippingAddress', 'notes', 'description', 'address', 'direccion', 'dirección']);
    const cols = (args.columns ?? autoColumns(flatRows)).filter((c) => !IMAGE_EXCLUDE_KEYS.has(c.key));
    const imageColumns = cols.map((c) => ({
      header: c.header,
      key: c.key,
      align: c.format === 'currency' || c.format === 'number' ? 'right' as const : (c.key === 'status' || c.key === 'ticketStatus') ? 'center' as const : 'left' as const,
      format: (v: unknown) => formatValue(v, c.format),
    }));

    // If everything doesn't fit in one image, generate as many as needed to cover ALL rows —
    // never silently truncate to a "preview" and push the user to a file instead.
    const MAX_IMAGE_PARTS = 40;
    const totalParts = Math.min(MAX_IMAGE_PARTS, Math.ceil(flatRows.length / args.maxRows));
    const rowsCovered = Math.min(flatRows.length, totalParts * args.maxRows);
    const rowsNotCovered = flatRows.length - rowsCovered;
    // Totals over the WHOLE set, shown once on the last image (KPIs go on the first).
    const totalsRow = rowsNotCovered === 0 ? buildTotalsRow(flatRows, cols) : null;

    const artifacts: Array<Record<string, unknown>> = [];
    for (let part = 0; part < totalParts; part++) {
      const chunk = flatRows.slice(part * args.maxRows, (part + 1) * args.maxRows);
      const partTitle = totalParts > 1 ? `${args.title} — Parte ${part + 1} de ${totalParts}` : args.title;
      const isLast = part === totalParts - 1;
      const { svg, width, height } = generateReportImageSvg({
        title: partTitle,
        subtitle: part === 0 ? args.subtitle : `Continuación · filas ${part * args.maxRows + 1}–${part * args.maxRows + chunk.length} de ${flatRows.length}`,
        logoText: 'UNIK',
        brandColor: args.brandColor,
        maxRows: chunk.length, // this chunk is never itself truncated
        columns: imageColumns,
        rows: chunk,
        summaryCards: part === 0 ? args.summaryCards : undefined, // KPIs describe the WHOLE set — show once, not per part
        totalsRow: isLast && totalsRow ? totalsRow : undefined,
      });

      const artifact = await createArtifact({
        conversationId: args.conversationId,
        type: 'image',
        inlineData: { svg, width, height },
        meta: { title: partTitle, rowCount: chunk.length, part: part + 1, totalParts, brandColor: args.brandColor },
      });

      artifacts.push({ artifactId: artifact.id, type: 'image', title: partTitle, inlineRender: true, rowCount: chunk.length });
    }

    return {
      artifacts,
      imageCount: totalParts,
      totalRows: flatRows.length,
      rowsCovered,
      ...(rowsNotCovered > 0
        ? { note: `Se generaron ${totalParts} imágenes cubriendo ${rowsCovered} de ${flatRows.length} filas (límite de ${MAX_IMAGE_PARTS} imágenes por mensaje). Para las ${rowsNotCovered} filas restantes, genera el PDF o Excel.` }
        : { note: `Se generaron ${totalParts} imagen(es) cubriendo las ${flatRows.length} filas — no falta ninguna.` }),
    };
  },
});

// 5. generateTable
registerTool({
  name: 'generateTable',
  effect: 'draft',
  description:
    'Genera una tabla dentro del chat, en una caja con scroll propio (no un archivo, no una imagen). ÚSALA por default para cualquier lista de más de ~8 filas en vez de escribir la tabla tú mismo en markdown — ' +
    'el sistema toma las filas de los datos automáticamente (TODAS, sin límite de longitud) en vez de que tengas que escribirlas una por una, así nunca terminas cortando con "..." a medias. SOLO necesitas pasar title y rows.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().describe('Título de la tabla'),
    subtitle: z.string().optional(),
    rows: z.array(z.record(z.unknown())).optional().describe('Los datos a mostrar (array de la tool anterior)'),
    columns: z.array(z.object({
      header: z.string(),
      key: z.string(),
      format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
    })).optional().describe('OPCIONAL. Se generan automáticamente si no se pasan.'),
    summary: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    brandColor: z.string().optional(),
    subsetOnly: subsetOnlySchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      subtitle?: string;
      rows?: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
      summary?: Array<{ label: string; value: string }>;
      brandColor?: string;
    };

    const rows = (args.rows ?? []).map((r) => flattenRow(r));
    if (rows.length === 0) {
      return { error: NO_ROWS_ERROR };
    }

    const cols = args.columns ?? autoColumns(rows);

    const tableData = generateTableData({
      title: args.title,
      subtitle: args.subtitle,
      columns: cols.map((c) => ({
        header: c.header,
        key: c.key,
        format: c.format as 'currency' | 'number' | 'percentage' | 'date' | 'text' | undefined,
      })),
      rows,
      summary: args.summary ?? tableSummaryFromTotals(rows, cols),
      brandColor: args.brandColor,
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'table',
      inlineData: tableData as never,
      meta: {
        title: args.title,
        rowCount: rows.length,
        columns: cols.map((c) => c.header),
        brandColor: args.brandColor,
      },
    });

    return {
      artifactId: artifact.id,
      type: 'table',
      title: args.title,
      inlineRender: true,
      rowCount: rows.length,
      note: `La tabla muestra las ${rows.length} filas completas dentro del chat. No las repitas en markdown.`,
    };
  },
});

// 6. listArtifacts
registerTool({
  name: 'listArtifacts',
  description: 'Lista los artefactos generados en la conversación actual.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { conversationId: string };
    const artifacts = await prisma.aiArtifact.findMany({
      where: { conversationId: args.conversationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, meta: true, createdAt: true },
    });
    return {
      artifacts: artifacts.map((a) => ({
        id: a.id,
        type: a.type,
        title: (a.meta as Record<string, unknown>)?.title ?? 'Sin título',
        createdAt: a.createdAt.toISOString(),
        downloadUrl: a.type !== 'table' && a.type !== 'chart'
          ? `/app/assistant/api/artifacts/${a.id}/download`
          : null,
      })),
    };
  },
});

// 7. cleanupArtifacts
registerTool({
  name: 'cleanupArtifacts',
  description: 'Elimina artefactos expirados.',
  category: 'system',
  // Maintenance of already-expired artifacts: classified destructive but auto-approved
  // (nothing a user still relies on is removed; protected artifacts are never touched).
  effect: 'destructive',
  approvalPolicy: 'auto',
  enabledByDefault: true,
  parameters: z.object({}),
  execute: async () => {
    const settings = await getAiSettings();
    const { cleanupExpiredArtifacts } = await import('../ai-artifacts-service');
    const deleted = await cleanupExpiredArtifacts(settings.artifactTtlHours);
    return { deletedCount: deleted, ttlHours: settings.artifactTtlHours };
  },
});
