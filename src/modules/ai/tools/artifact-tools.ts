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

/** Generic data source: accepts rows directly or queries sales orders. */
const dataSourceSchema = z.object({
  rows: z.array(z.record(z.unknown())).describe('Filas de datos a incluir en el artefacto.'),
  columns: z.array(
    z.object({
      header: z.string().describe('Título de la columna'),
      key: z.string().describe('Clave del campo en las filas'),
      align: z.enum(['left', 'right', 'center']).optional(),
      format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
      width: z.number().optional(),
    })
  ).describe('Definición de columnas'),
});

const styleSchema = z.object({
  title: z.string().describe('Título del documento'),
  subtitle: z.string().optional().describe('Subtítulo'),
  brandColor: z.string().optional().describe('Color de marca en hex (ej: #2563eb)'),
  logoText: z.string().optional().describe('Texto del logo (ej: UNIK)'),
  author: z.string().optional(),
  summaryCards: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        color: z.string().optional(),
      })
    )
    .optional()
    .describe('Tarjetas de KPI/resumen a mostrar'),
  metadata: z.record(z.string()).optional().describe('Metadatos adicionales al pie'),
}).describe('Estilo y personalización del documento');

/* ------------------------------------------------------------------ */
/* Tools                                                              */
/* ------------------------------------------------------------------ */

// 1. generatePdfReportTool
registerTool({
  name: 'generatePdfReport',
  description:
    'Genera un reporte PDF profesional con tablas, KPIs y diseño de marca. El usuario puede personalizar título, colores, logo y contenido. El PDF se guarda y se puede descargar desde el chat.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    data: dataSourceSchema,
    style: styleSchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      data: z.infer<typeof dataSourceSchema>;
      style: z.infer<typeof styleSchema>;
    };

    await ensureArtifactsDir();
    const artifactId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'pdf');

    const pdfColumns: PdfTableColumn[] = args.data.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
      align: c.align,
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
      title: args.style.title,
      subtitle: args.style.subtitle,
      author: args.style.author,
      brandColor: args.style.brandColor,
      logoText: args.style.logoText ?? 'UNIK',
      columns: pdfColumns,
      rows: args.data.rows,
      summaryCards: args.style.summaryCards,
      metadata: args.style.metadata,
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'pdf',
      storagePath: filePath,
      meta: {
        title: args.style.title,
        filename: `${args.style.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes,
        pageCount,
        rowCount: args.data.rows.length,
        columns: args.data.columns.map((c) => c.header),
        brandColor: args.style.brandColor,
      },
    });

    return {
      artifactId: artifact.id,
      type: 'pdf',
      title: args.style.title,
      filename: `${args.style.title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
      sizeBytes,
      pageCount,
      rowCount: args.data.rows.length,
      downloadUrl: `/app/assistant/api/artifacts/${artifact.id}/download`,
    };
  },
});

// 2. generateExcelReportTool
registerTool({
  name: 'generateExcelReport',
  description:
    'Genera un reporte Excel (XLSX) con datos tabulares, hoja de resumen con KPIs, filtros automáticos y diseño profesional. Personalizable con colores de marca.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    data: dataSourceSchema,
    style: styleSchema,
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      data: z.infer<typeof dataSourceSchema>;
      style: z.infer<typeof styleSchema>;
    };

    await ensureArtifactsDir();
    const artifactId = `xlsx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'xlsx');

    const excelColumns: ExcelColumn[] = args.data.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
      type: c.format === 'currency' ? 'currency' : c.format === 'number' ? 'number' : c.format === 'date' ? 'date' : c.format === 'percentage' ? 'percentage' : 'text',
    }));

    const { sizeBytes } = await generateExcelReport(filePath, {
      title: args.style.title,
      subtitle: args.style.subtitle,
      author: args.style.author,
      brandColor: args.style.brandColor ? args.style.brandColor.replace('#', 'FF').toUpperCase() : undefined,
      columns: excelColumns,
      rows: args.data.rows,
      summaryCards: args.style.summaryCards,
    });

    const artifact = await createArtifact({
      conversationId: args.conversationId,
      type: 'xlsx',
      storagePath: filePath,
      meta: {
        title: args.style.title,
        filename: `${args.style.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes,
        rowCount: args.data.rows.length,
        columns: args.data.columns.map((c) => c.header),
      },
    });

    return {
      artifactId: artifact.id,
      type: 'xlsx',
      title: args.style.title,
      filename: `${args.style.title.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`,
      sizeBytes,
      rowCount: args.data.rows.length,
      downloadUrl: `/app/assistant/api/artifacts/${artifact.id}/download`,
    };
  },
});

// 3. generateCsvExportTool
registerTool({
  name: 'generateCsvExport',
  description:
    'Genera un archivo CSV con los datos proporcionados. Compatible con Excel. Incluye BOM UTF-8 para caracteres especiales.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    data: dataSourceSchema,
    title: z.string().optional().describe('Título del reporte (se incluye como metadata)'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      data: z.infer<typeof dataSourceSchema>;
      title?: string;
    };

    await ensureArtifactsDir();
    const artifactId = `csv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const filePath = getArtifactPath(artifactId, 'csv');

    const { sizeBytes } = generateCsvReport(filePath, {
      title: args.title,
      columns: args.data.columns.map((c) => ({
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
      rows: args.data.rows,
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
        rowCount: args.data.rows.length,
        columns: args.data.columns.map((c) => c.header),
      },
    });

    return {
      artifactId: artifact.id,
      type: 'csv',
      title,
      filename: `${title.replace(/[^a-zA-Z0-9]/g, '_')}.csv`,
      sizeBytes,
      rowCount: args.data.rows.length,
      downloadUrl: `/app/assistant/api/artifacts/${artifact.id}/download`,
    };
  },
});

// 4. generateChartTool
registerTool({
  name: 'generateChart',
  description:
    'Genera una gráfica (barras, barras horizontales, línea, pie o doughnut) como imagen SVG. Se muestra directamente en el chat. Personalizable con colores de marca.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    chartType: z.enum(['bar', 'horizontal-bar', 'line', 'pie', 'doughnut'])
      .describe('Tipo de gráfica'),
    title: z.string().describe('Título de la gráfica'),
    subtitle: z.string().optional(),
    labels: z.array(z.string()).describe('Etiquetas para cada punto/barra'),
    series: z.array(
      z.object({
        label: z.string().describe('Nombre de la serie'),
        values: z.array(z.number()).describe('Valores numéricos'),
      })
    ).describe('Series de datos'),
    colors: z.array(z.string()).optional().describe('Colores personalizados (hex)'),
    showValues: z.boolean().optional().default(true).describe('Mostrar valores en la gráfica'),
    showLegend: z.boolean().optional().default(true),
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

// 5. generateTableTool
registerTool({
  name: 'generateTable',
  description:
    'Genera una tabla formateada que se muestra directamente en el chat. Útil para presentar datos de forma estructurada sin generar un archivo.',
  category: 'export',
  requiredPermission: 'sales_orders.view',
  enabledByDefault: true,
  parameters: z.object({
    conversationId: z.string().optional().describe('Se inyecta automáticamente, no lo pongas.'),
    title: z.string().describe('Título de la tabla'),
    subtitle: z.string().optional(),
    columns: z.array(
      z.object({
        header: z.string(),
        key: z.string(),
        align: z.enum(['left', 'right', 'center']).optional(),
        format: z.enum(['currency', 'number', 'percentage', 'date', 'text']).optional(),
      })
    ),
    rows: z.array(z.record(z.unknown())),
    summary: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
      })
    ).optional().describe('Resumen/KPIs al pie de la tabla'),
    brandColor: z.string().optional(),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      conversationId: string;
      title: string;
      subtitle?: string;
      columns: Array<{ header: string; key: string; align?: 'left' | 'right' | 'center'; format?: string }>;
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
        align: c.align,
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

// 6. listArtifactsTool
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

// 7. cleanupArtifactsTool
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
