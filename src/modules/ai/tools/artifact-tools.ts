import { z } from 'zod';
import path from 'path';
import fs from 'fs/promises';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';
import { createArtifact } from '../ai-artifacts-service';
import { generatePdfReport, type PdfTableColumn } from '../generators/pdf-generator';
import { generateExcelReport, type ExcelColumn } from '../generators/excel-generator';
import { generateCsvReport } from '../generators/csv-generator';
import { generateChartSvg } from '../generators/chart-generator';
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
  const keys = Object.keys(rows[0]);
  return keys.map((key) => {
    // Guess format from key name
    let format: string | undefined;
    const lower = key.toLowerCase();
    if (lower === 'total' || lower === 'balance' || lower === 'amount' || lower === 'revenue') {
      format = 'currency';
    } else if (lower === 'date' || lower === 'orderdate' || lower === 'createdat') {
      format = 'date';
    } else if (lower === 'count' || lower === 'quantity' || lower === 'orders') {
      format = 'number';
    }
    // Capitalize header
    const header = key.charAt(0).toUpperCase() + key.slice(1);
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
    return String(value);
  }
  return String(value);
}

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. generatePdfReport
registerTool({
  name: 'generatePdfReport',
  description:
    'Genera un PDF con los datos que le pases. SOLO necesitas pasar title y rows. ' +
    'rows es un array de objetos (los datos de la tool anterior). ' +
    'EJEMPLO: si getCashSales devolvio {orders: [{number: "OV-1", customer: "Juan", total: "100"}]}, ' +
    'pasa rows = [{number: "OV-1", customer: "Juan", total: "100"}] y title = "Ventas en Efectivo".',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().default('Reporte UNIK').describe('Título del reporte (ej: "Ventas en Efectivo de Ayer")'),
    subtitle: z.string().optional().describe('Subtítulo opcional'),
    rows: z.array(z.record(z.unknown())).describe(
      'Los datos a mostrar. Pasa el array de la tool anterior. ' +
      'EJ: si getCashSales devolvió orders, pasa ese array. ' +
      'EJ: si getTopProducts devolvió topProducts, pasa ese array.'
    ),
    columns: z.array(z.object({
      header: z.string(),
      key: z.string(),
      format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
    })).optional().describe(
      'OPCIONAL. Si no lo pasas, se generan automáticamente de las claves de las rows.'
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
      rows: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
      summaryCards?: Array<{ label: string; value: string }>;
      brandColor?: string;
    };

    await ensureArtifactsDir();
    const artifactId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'pdf');

    const cols = args.columns ?? autoColumns(args.rows);

    const pdfColumns: PdfTableColumn[] = cols.map((c) => ({
      header: c.header,
      key: c.key,
      format: (v: unknown) => formatValue(v, c.format),
    }));

    const { sizeBytes, pageCount } = await generatePdfReport(filePath, {
      title: args.title,
      subtitle: args.subtitle,
      brandColor: args.brandColor,
      logoText: 'UNIK',
      columns: pdfColumns,
      rows: args.rows,
      summaryCards: args.summaryCards,
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
        rowCount: args.rows.length,
        columns: cols.map((c) => c.header),
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
      rowCount: args.rows.length,
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
    rows: z.array(z.record(z.unknown())).describe('Los datos a mostrar (array de la tool anterior)'),
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
      rows: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
      summaryCards?: Array<{ label: string; value: string }>;
      brandColor?: string;
    };

    await ensureArtifactsDir();
    const artifactId = `xlsx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'xlsx');

    const cols = args.columns ?? autoColumns(args.rows);

    const excelColumns: ExcelColumn[] = cols.map((c) => ({
      header: c.header,
      key: c.key,
      type: c.format === 'currency' ? 'currency' : c.format === 'number' ? 'number' : c.format === 'date' ? 'date' : c.format === 'percentage' ? 'percentage' : 'text',
    }));

    const { sizeBytes } = await generateExcelReport(filePath, {
      title: args.title,
      subtitle: args.subtitle,
      brandColor: args.brandColor ? args.brandColor.replace('#', 'FF').toUpperCase() : undefined,
      columns: excelColumns,
      rows: args.rows,
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
        rowCount: args.rows.length,
        columns: cols.map((c) => c.header),
      },
    });

    return {
      artifactId: artifact.id,
      type: 'xlsx',
      title: args.title,
      filename: `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`,
      sizeBytes,
      rowCount: args.rows.length,
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
    rows: z.array(z.record(z.unknown())).describe('Los datos a exportar (array de la tool anterior)'),
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
      rows: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
    };

    await ensureArtifactsDir();
    const artifactId = `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'csv');

    const cols = args.columns ?? autoColumns(args.rows);

    const { sizeBytes } = generateCsvReport(filePath, {
      title: args.title,
      columns: cols.map((c) => ({
        header: c.header,
        key: c.key,
        format: (v: unknown) => formatValue(v, c.format),
      })),
      rows: args.rows,
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
        rowCount: args.rows.length,
        columns: cols.map((c) => c.header),
      },
    });

    return {
      artifactId: artifact.id,
      type: 'csv',
      title: args.title,
      filename: `${args.title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`,
      sizeBytes,
      rowCount: args.rows.length,
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
    chartType: z.enum(['bar', 'horizontal-bar', 'line', 'pie', 'doughnut']).describe('Tipo de gráfica'),
    title: z.string().describe('Título de la gráfica'),
    subtitle: z.string().optional(),
    labels: z.array(z.string()).describe('Etiquetas (ej: ["Axel", "Andrea", "Laura"])'),
    series: z.array(z.object({
      label: z.string().describe('Nombre de la serie'),
      values: z.array(z.number()).describe('Valores (ej: [47052, 27064, 2664])'),
    })).describe('Series de datos'),
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
      labels: string[];
      series: Array<{ label: string; values: number[] }>;
      colors?: string[];
      showValues?: boolean;
      showLegend?: boolean;
      brandColor?: string;
    };

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

// 5. generateTable
registerTool({
  name: 'generateTable',
  description:
    'Genera una tabla que se muestra en el chat. SOLO necesitas pasar title y rows.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().describe('Título de la tabla'),
    subtitle: z.string().optional(),
    rows: z.array(z.record(z.unknown())).describe('Los datos a mostrar (array de la tool anterior)'),
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
      rows: Record<string, unknown>[];
      columns?: Array<{ header: string; key: string; format?: string }>;
      summary?: Array<{ label: string; value: string }>;
      brandColor?: string;
    };

    const cols = args.columns ?? autoColumns(args.rows);

    const tableData = generateTableData({
      title: args.title,
      subtitle: args.subtitle,
      columns: cols.map((c) => ({
        header: c.header,
        key: c.key,
        format: c.format as 'currency' | 'number' | 'percentage' | 'date' | 'text' | undefined,
      })),
      rows: args.rows,
      summary: args.summary,
      brandColor: args.brandColor,
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'table',
      inlineData: tableData as never,
      meta: {
        title: args.title,
        rowCount: args.rows.length,
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
