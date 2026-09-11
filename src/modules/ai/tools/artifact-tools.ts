import { z } from 'zod';
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { createArtifact } from '../ai-artifacts-service';
import { generatePdfReport, type PdfTableColumn, type PdfSection } from '../generators/pdf-generator';
import { generateExcelReport, type ExcelColumn } from '../generators/excel-generator';
import { generateCsvReport } from '../generators/csv-generator';
import { generateChartSvg } from '../generators/chart-generator';
import { generateReportImageSvg } from '../generators/image-report-generator';
import { hexToArgb } from '../generators/status-tone';
import { generateTableData } from '../generators/table-generator';
import { getAiSettings } from '../ai-admin-config-service';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const ARTIFACTS_DIR = path.join(process.cwd(), 'data', 'ai-artifacts');

async function ensureArtifactsDir(): Promise<void> {
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
}

function getArtifactPath(id: string, ext: string): string {
  return path.join(ARTIFACTS_DIR, `${id}.${ext}`);
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
    return `$${Number(value).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
  }
  if (format === 'number') {
    return Number(value).toLocaleString('es-MX');
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

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. generatePdfReport
registerTool({
  name: 'generatePdfReport',
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
      return { error: 'No hay datos para generar el PDF. Llama primero una tool de datos (ej: querySalesOrders, getTopProducts).' };
    }

    await ensureArtifactsDir();
    const artifactId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'pdf');

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
      }];
    }

    const { sizeBytes, pageCount } = await generatePdfReport(filePath, {
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

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'pdf',
      storagePath: filePath,
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
      return { error: 'No hay datos para generar el Excel. Llama primero una tool de datos.' };
    }

    await ensureArtifactsDir();
    const artifactId = `xlsx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'xlsx');

    const cols = args.columns ?? autoColumns(rows);

    const excelColumns: ExcelColumn[] = cols.map((c) => ({
      header: c.header,
      key: c.key,
      type: c.format === 'currency' ? 'currency' : c.format === 'number' ? 'number' : c.format === 'date' ? 'date' : c.format === 'percentage' ? 'percentage' : 'text',
    }));

    const { sizeBytes } = await generateExcelReport(filePath, {
      title: args.title,
      subtitle: args.subtitle,
      brandColor: args.brandColor ? hexToArgb(args.brandColor) : undefined,
      columns: excelColumns,
      rows,
      summaryCards: args.summaryCards,
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'xlsx',
      storagePath: filePath,
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
      return { error: 'No hay datos para generar el CSV. Llama primero una tool de datos.' };
    }

    await ensureArtifactsDir();
    const artifactId = `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'csv');

    const cols = args.columns ?? autoColumns(rows);

    const { sizeBytes } = generateCsvReport(filePath, {
      title: args.title,
      columns: cols.map((c) => ({
        header: c.header,
        key: c.key,
        format: (v: unknown) => formatValue(v, c.format),
      })),
      rows,
      includeMetadata: true,
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'csv',
      storagePath: filePath,
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
  description:
    'Genera IMÁGENES (PNG/SVG) con el reporte: título, KPIs y una tabla — NO es una gráfica de barras/línea/pie (para eso usa generateChart). ' +
    'Úsalo cuando el usuario pida explícitamente "una imagen del reporte", "una foto con los datos", o algo para compartir directo por WhatsApp/redes sin abrir un PDF. ' +
    'Cada imagen muestra hasta ~20 filas (ajustable con maxRows); si hay más filas de las que caben en una imagen, el sistema genera AUTOMÁTICAMENTE varias imágenes ("Parte 1 de 3", "Parte 2 de 3"...) hasta cubrir TODAS las filas (límite de 8 imágenes ≈ 160 filas — si el usuario pidió aún más, ofrece PDF/Excel para el resto). ' +
    'SOLO necesitas pasar title y rows; columnas y KPIs se auto-generan igual que en generatePdfReport. Los estados (Cerrado, Pendiente, etc.) se colorean automáticamente.',
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
    maxRows: z.number().int().min(1).max(60).default(20).describe('Filas por imagen (default 20). No limita el total: si hay más filas que esto, se generan más imágenes.'),
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
      return { error: 'No hay datos para generar la imagen. Llama primero una tool de datos (ej: querySalesOrders, getTopProducts).' };
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
    const MAX_IMAGE_PARTS = 8;
    const totalParts = Math.min(MAX_IMAGE_PARTS, Math.ceil(flatRows.length / args.maxRows));
    const rowsCovered = Math.min(flatRows.length, totalParts * args.maxRows);
    const rowsNotCovered = flatRows.length - rowsCovered;

    const artifacts: Array<Record<string, unknown>> = [];
    for (let part = 0; part < totalParts; part++) {
      const chunk = flatRows.slice(part * args.maxRows, (part + 1) * args.maxRows);
      const partTitle = totalParts > 1 ? `${args.title} — Parte ${part + 1} de ${totalParts}` : args.title;
      const { svg, width, height } = generateReportImageSvg({
        title: partTitle,
        subtitle: part === 0 ? args.subtitle : `Continuación · filas ${part * args.maxRows + 1}–${part * args.maxRows + chunk.length} de ${flatRows.length}`,
        logoText: 'UNIK',
        brandColor: args.brandColor,
        maxRows: chunk.length, // this chunk is never itself truncated
        columns: imageColumns,
        rows: chunk,
        summaryCards: part === 0 ? args.summaryCards : undefined, // KPIs describe the WHOLE set — show once, not per part
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
      return { error: 'No hay datos para generar la tabla. Llama primero una tool de datos.' };
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
      summary: args.summary,
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
  enabledByDefault: true,
  parameters: z.object({}),
  execute: async () => {
    const settings = await getAiSettings();
    const { cleanupExpiredArtifacts } = await import('../ai-artifacts-service');
    const deleted = await cleanupExpiredArtifacts(settings.artifactTtlHours);
    return { deletedCount: deleted, ttlHours: settings.artifactTtlHours };
  },
});
