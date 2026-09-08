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

/** Column definition — flat, simple for the IA to construct. */
const columnSchema = z.object({
  header: z.string().describe('Título de la columna (ej: "Cliente", "Total", "Fecha")'),
  key: z.string().describe('Clave del campo en las filas (ej: "customer", "total", "date")'),
  format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional().describe(
    'Formato: "currency" para dinero, "number" para números, "date" para fechas, "text" para texto'
  ),
});

/** Summary card / KPI — flat. */
const summaryCardSchema = z.object({
  label: z.string().describe('Etiqueta del KPI (ej: "Total ventas", "Número de órdenes")'),
  value: z.string().describe('Valor del KPI (ej: "$73,987.77", "8")'),
});

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. generatePdfReport
registerTool({
  name: 'generatePdfReport',
  description:
    'Genera un reporte PDF profesional con tablas y KPIs. Pasa los datos (rows) que obtuviste de otras tools y las columnas (columns) para mostrarlos. El PDF se descarga desde el chat.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().describe('Título del reporte (ej: "Ventas en Efectivo de Ayer")'),
    subtitle: z.string().optional().describe('Subtítulo del reporte'),
    columns: z.array(columnSchema).describe('Definición de columnas para la tabla'),
    rows: z.array(z.record(z.unknown())).describe(
      'Filas de datos. Cada fila es un objeto con las claves de las columnas. Usa los datos que obtuviste de tools anteriores.'
    ),
    summaryCards: z.array(summaryCardSchema).optional().describe(
      'KPIs/tarjetas de resumen (ej: [{label: "Total", value: "$73,987.77"}, {label: "Órdenes", value: "8"}])'
    ),
    brandColor: z.string().optional().describe('Color de marca en hex (ej: "#2563eb")'),
    author: z.string().optional().describe('Autor del reporte'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      subtitle?: string;
      columns: Array<{ header: string; key: string; format?: string }>;
      rows: Record<string, unknown>[];
      summaryCards?: Array<{ label: string; value: string }>;
      brandColor?: string;
      author?: string;
    };

    await ensureArtifactsDir();
    const artifactId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'pdf');

    const pdfColumns: PdfTableColumn[] = args.columns.map((c) => ({
      header: c.header,
      key: c.key,
      format: c.format === 'currency'
        ? (v) => `$${Number(v ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`
        : c.format === 'number'
        ? (v) => Number(v ?? 0).toLocaleString('es-MX')
        : c.format === 'percentage'
        ? (v) => `${v}%`
        : c.format === 'date'
        ? (v) => (v ? String(v) : '')
        : (v) => String(v ?? ''),
    }));

    const { sizeBytes, pageCount } = await generatePdfReport(filePath, {
      title: args.title,
      subtitle: args.subtitle,
      author: args.author,
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
        columns: args.columns.map((c) => c.header),
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
    'Genera un reporte Excel (XLSX) con datos tabulares y formato profesional. Pasa los datos (rows) que obtuviste de otras tools y las columnas (columns).',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().describe('Título del reporte'),
    subtitle: z.string().optional(),
    columns: z.array(columnSchema).describe('Definición de columnas'),
    rows: z.array(z.record(z.unknown())).describe('Filas de datos de tools anteriores'),
    summaryCards: z.array(summaryCardSchema).optional().describe('KPIs de resumen'),
    brandColor: z.string().optional().describe('Color de marca en hex'),
    author: z.string().optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      subtitle?: string;
      columns: Array<{ header: string; key: string; format?: string }>;
      rows: Record<string, unknown>[];
      summaryCards?: Array<{ label: string; value: string }>;
      brandColor?: string;
      author?: string;
    };

    await ensureArtifactsDir();
    const artifactId = `xlsx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'xlsx');

    const excelColumns: ExcelColumn[] = args.columns.map((c) => ({
      header: c.header,
      key: c.key,
      type: c.format === 'currency' ? 'currency' : c.format === 'number' ? 'number' : c.format === 'date' ? 'date' : c.format === 'percentage' ? 'percentage' : 'text',
    }));

    const { sizeBytes } = await generateExcelReport(filePath, {
      title: args.title,
      subtitle: args.subtitle,
      author: args.author,
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
        columns: args.columns.map((c) => c.header),
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
    'Genera un archivo CSV con los datos proporcionados. Compatible con Excel. Pasa los datos (rows) de tools anteriores y las columnas (columns).',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().optional().describe('Título del reporte'),
    columns: z.array(columnSchema).describe('Definición de columnas'),
    rows: z.array(z.record(z.unknown())).describe('Filas de datos de tools anteriores'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title?: string;
      columns: Array<{ header: string; key: string; format?: string }>;
      rows: Record<string, unknown>[];
    };

    await ensureArtifactsDir();
    const artifactId = `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'csv');

    const { sizeBytes } = generateCsvReport(filePath, {
      title: args.title,
      columns: args.columns.map((c) => ({
        header: c.header,
        key: c.key,
        format: c.format === 'currency'
          ? (v) => `$${Number(v ?? 0).toFixed(2)}`
          : c.format === 'number'
          ? (v) => String(v ?? 0)
          : c.format === 'percentage'
          ? (v) => `${v}%`
          : (v) => String(v ?? ''),
      })),
      rows: args.rows,
      includeMetadata: true,
    });

    const title = args.title ?? 'Export CSV';
    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'csv',
      storagePath: filePath,
      meta: {
        title,
        filename: `${title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`,
        mimeType: 'text/csv',
        sizeBytes,
        rowCount: args.rows.length,
        columns: args.columns.map((c) => c.header),
      },
    });

    return {
      artifactId: artifact.id,
      type: 'csv',
      title,
      filename: `${title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`,
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
    'Genera una gráfica (barras, línea, pie) como imagen SVG que se muestra en el chat. Pasa los labels y values de los datos.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    chartType: z.enum(['bar', 'horizontal-bar', 'line', 'pie', 'doughnut']).describe('Tipo de gráfica'),
    title: z.string().describe('Título de la gráfica'),
    subtitle: z.string().optional(),
    labels: z.array(z.string()).describe('Etiquetas para cada punto/barra (ej: ["Axel", "Andrea", "Laura"])'),
    series: z.array(
      z.object({
        label: z.string().describe('Nombre de la serie (ej: "Ventas")'),
        values: z.array(z.number()).describe('Valores numéricos (ej: [47052, 27064, 2664])'),
      })
    ).describe('Series de datos'),
    colors: z.array(z.string()).optional().describe('Colores personalizados (hex)'),
    showValues: z.boolean().optional().describe('Mostrar valores en la gráfica'),
    showLegend: z.boolean().optional().describe('Mostrar leyenda'),
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
    'Genera una tabla formateada que se muestra directamente en el chat. Pasa los datos (rows) de tools anteriores y las columnas (columns).',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().describe('Título de la tabla'),
    subtitle: z.string().optional(),
    columns: z.array(columnSchema).describe('Definición de columnas'),
    rows: z.array(z.record(z.unknown())).describe('Filas de datos de tools anteriores'),
    summary: z.array(summaryCardSchema).optional().describe('KPIs al pie de la tabla'),
    brandColor: z.string().optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      subtitle?: string;
      columns: Array<{ header: string; key: string; format?: string }>;
      rows: Record<string, unknown>[];
      summary?: Array<{ label: string; value: string }>;
      brandColor?: string;
    };

    const tableData = generateTableData({
      title: args.title,
      subtitle: args.subtitle,
      columns: args.columns.map((c) => ({
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
        columns: args.columns.map((c) => c.header),
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
  description: 'Lista los artefactos (PDFs, Excels, CSVs, gráficas, tablas) generados en la conversación actual.',
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
      select: {
        id: true,
        type: true,
        meta: true,
        createdAt: true,
      },
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
  description: 'Elimina artefactos expirados según el TTL configurado. Limpieza automática de PDFs, Excels y CSVs antiguos.',
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
