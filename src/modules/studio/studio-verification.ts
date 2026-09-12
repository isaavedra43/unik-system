import fsp from 'fs/promises';
import ExcelJS from 'exceljs';
import { bufferRandomAccess, readZipDirectory, readZipEntry } from '@/modules/storage/zip-reader';
import {
  extractFigures,
  type StudioContent,
  type StudioFigure,
  type TableBlock,
} from './studio-content';
import { normalizeFigureText } from './studio-format';
import {
  kpiSheetName,
  sheetNameForTable,
  tableStrings,
  xlsxCellValue,
  type StudioExportFormat,
} from './studio-exporters';

/**
 * Render verification: every generated file is reopened and checked BEFORE it
 * is stored and linked. The goal is "no figure and no content is lost":
 *
 * - pdf  → text extracted with unpdf (pdf.js); page count > 0.
 * - xlsx → workbook re-read with exceljs; every table cell and KPI compared.
 * - docx/pptx → OOXML package opened with the bounded ZIP reader; figures
 *   searched in word/document.xml and ppt/slides/*.xml.
 * - html/md/csv/svg → figures searched in the text.
 *
 * A failed verification marks the export `failed` and no download link is
 * ever delivered for it.
 */

export interface VerificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerificationResult {
  ok: boolean;
  checks: VerificationCheck[];
}

export interface VerificationInput {
  title: string;
  content: StudioContent;
}

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&[a-z]+;/g, (m) => XML_ENTITIES[m] ?? m);
}

/** Strips tags (each becomes a space) and decodes entities. */
export function xmlToText(xml: string): string {
  return decodeEntities(xml.replace(/<[^>]+>/g, ' '));
}

function looseText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Figures the format is expected to carry (CSV/XLSX only hold data blocks). */
export function figuresForFormat(
  content: StudioContent,
  format: StudioExportFormat
): StudioFigure[] {
  const all = extractFigures(content);
  if (format === 'csv' || format === 'xlsx') return all.filter((f) => f.scope === 'data');
  return all;
}

export function checkFigures(figures: StudioFigure[], text: string): VerificationCheck {
  const haystack = normalizeFigureText(text);
  const missing = figures.filter((f) => !f.candidates.some((c) => haystack.includes(c)));
  if (figures.length === 0) {
    return { name: 'figures', ok: true, detail: 'El documento no contiene cifras que verificar' };
  }
  if (missing.length === 0) {
    return {
      name: 'figures',
      ok: true,
      detail: `${figures.length}/${figures.length} cifras encontradas`,
    };
  }
  const sample = missing
    .slice(0, 5)
    .map((f) => `${f.location}: ${f.raw}`)
    .join('; ');
  return {
    name: 'figures',
    ok: false,
    detail: `Faltan ${missing.length} de ${figures.length} cifras — ${sample}${missing.length > 5 ? '…' : ''}`,
  };
}

function checkTitle(title: string, text: string): VerificationCheck {
  const needle = looseText(title);
  if (needle.length === 0) return { name: 'title', ok: true, detail: 'Sin título que verificar' };
  const ok = looseText(text).includes(needle);
  return {
    name: 'title',
    ok,
    detail: ok ? 'Título presente' : 'El título no aparece en el archivo',
  };
}

function checkSize(bytes: number): VerificationCheck {
  return {
    name: 'file',
    ok: bytes > 0,
    detail: bytes > 0 ? `${bytes} bytes` : 'Archivo vacío',
  };
}

async function readFileBounded(filePath: string): Promise<Buffer> {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`El archivo generado excede ${MAX_FILE_BYTES} bytes`);
  }
  return fsp.readFile(filePath);
}

// ---------------------------------------------------------------------------
// Format readers
// ---------------------------------------------------------------------------

async function pdfText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text, pages: totalPages };
}

async function ooxmlText(
  buffer: Buffer,
  matcher: (name: string) => boolean
): Promise<{ text: string; entries: string[] }> {
  const source = bufferRandomAccess(buffer);
  const directory = await readZipDirectory(source, { maxEntries: 20_000 });
  if (directory.zip64) throw new Error('Paquete ZIP64 no soportado');
  const entries = directory.entries.filter((e) => !e.isDirectory && matcher(e.name));
  const parts: string[] = [];
  for (const entry of entries) {
    const xml = (await readZipEntry(source, entry, MAX_ZIP_ENTRY_BYTES)).toString('utf8');
    parts.push(xmlToText(xml));
  }
  return { text: parts.join('\n'), entries: entries.map((e) => e.name) };
}

type CellScalar = string | number;

function cellToScalar(value: ExcelJS.CellValue): CellScalar {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join('');
    }
    if ('result' in value && value.result !== undefined) {
      return cellToScalar(value.result as ExcelJS.CellValue);
    }
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('error' in value) return String(value.error);
  }
  return String(value);
}

function scalarsEqual(expected: CellScalar, actual: CellScalar): boolean {
  if (typeof expected === 'number') {
    const n = typeof actual === 'number' ? actual : Number(actual);
    return Number.isFinite(n) && Math.abs(n - expected) < 1e-9;
  }
  return String(actual) === expected;
}

async function verifyXlsx(
  filePath: string,
  input: VerificationInput
): Promise<{ checks: VerificationCheck[]; text: string }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const checks: VerificationCheck[] = [];
  const textParts: string[] = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        const scalar = cellToScalar(cell.value);
        textParts.push(typeof scalar === 'number' ? `${scalar} ${cell.text}` : scalar);
      });
    });
  });

  const summary = workbook.getWorksheet(kpiSheetName());
  checks.push({
    name: 'summary_sheet',
    ok: Boolean(summary),
    detail: summary ? `Hoja "${kpiSheetName()}" presente` : `Falta la hoja "${kpiSheetName()}"`,
  });

  // KPI cards: every label/value pair must exist as a row of the summary sheet.
  const kpiCards = input.content.blocks.flatMap((b) => (b.type === 'kpi' ? b.cards : []));
  if (kpiCards.length > 0) {
    const rows: Array<[string, string]> = [];
    summary?.eachRow((row) => {
      rows.push([
        String(cellToScalar(row.getCell(1).value)),
        String(cellToScalar(row.getCell(2).value)),
      ]);
    });
    const missing = kpiCards.filter((c) => !rows.some(([l, v]) => l === c.label && v === c.value));
    checks.push({
      name: 'kpis',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${kpiCards.length}/${kpiCards.length} indicadores en "${kpiSheetName()}"`
          : `Faltan indicadores: ${missing.map((m) => m.label).join(', ')}`,
    });
  }

  const used = new Set<string>();
  const tables = input.content.blocks.filter((b): b is TableBlock => b.type === 'table');
  let mismatches = 0;
  let compared = 0;
  const problems: string[] = [];
  tables.forEach((block, index) => {
    const name = sheetNameForTable(index, block.title, used);
    const sheet = workbook.getWorksheet(name);
    if (!sheet) {
      mismatches++;
      problems.push(`falta la hoja "${name}"`);
      return;
    }
    const { header } = tableStrings(block);
    header.forEach((h, i) => {
      compared++;
      const actual = cellToScalar(sheet.getRow(1).getCell(i + 1).value);
      if (!scalarsEqual(h, actual)) {
        mismatches++;
        if (problems.length < 5) problems.push(`${name}!${columnLetter(i + 1)}1 encabezado`);
      }
    });
    block.rows.forEach((row, r) => {
      block.columns.forEach((col, c) => {
        compared++;
        const expected = xlsxCellValue(row[col.key], col.format);
        const actual = cellToScalar(sheet.getRow(r + 2).getCell(c + 1).value);
        if (!scalarsEqual(expected, actual)) {
          mismatches++;
          if (problems.length < 5) {
            problems.push(
              `${name}!${columnLetter(c + 1)}${r + 2}: esperado ${String(expected)}, leído ${String(actual)}`
            );
          }
        }
      });
    });
    const extraRows = sheet.rowCount - (block.rows.length + 1);
    if (extraRows > 0 && sheet.getRow(block.rows.length + 2).hasValues) {
      mismatches++;
      problems.push(`${name}: filas de más`);
    }
  });
  checks.push({
    name: 'cells',
    ok: mismatches === 0,
    detail:
      mismatches === 0
        ? `${compared} celdas verificadas en ${tables.length} hoja${tables.length === 1 ? '' : 's'}`
        : `${mismatches} discrepancias — ${problems.join('; ')}`,
  });
  return { checks, text: textParts.join('\n') };
}

function columnLetter(n: number): string {
  let s = '';
  let v = n;
  while (v > 0) {
    const m = (v - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    v = Math.floor((v - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function verifyStudioExport(
  format: StudioExportFormat,
  filePath: string,
  input: VerificationInput
): Promise<VerificationResult> {
  const checks: VerificationCheck[] = [];
  try {
    const stat = await fsp.stat(filePath);
    checks.push(checkSize(stat.size));
    if (stat.size === 0) return { ok: false, checks };

    const figures = figuresForFormat(input.content, format);
    let text = '';

    switch (format) {
      case 'pdf': {
        const buffer = await readFileBounded(filePath);
        const pdf = await pdfText(buffer);
        checks.push({
          name: 'pages',
          ok: pdf.pages > 0,
          detail:
            pdf.pages > 0 ? `${pdf.pages} página${pdf.pages === 1 ? '' : 's'}` : 'PDF sin páginas',
        });
        text = pdf.text;
        checks.push(checkTitle(input.title, text));
        break;
      }
      case 'docx': {
        const buffer = await readFileBounded(filePath);
        const { text: t, entries } = await ooxmlText(buffer, (n) => n === 'word/document.xml');
        checks.push({
          name: 'structure',
          ok: entries.length === 1,
          detail: entries.length === 1 ? 'word/document.xml presente' : 'Falta word/document.xml',
        });
        text = t;
        checks.push(checkTitle(input.title, text));
        break;
      }
      case 'pptx': {
        const buffer = await readFileBounded(filePath);
        const { text: t, entries } = await ooxmlText(buffer, (n) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(n)
        );
        checks.push({
          name: 'structure',
          ok: entries.length > 0,
          detail:
            entries.length > 0
              ? `${entries.length} diapositiva${entries.length === 1 ? '' : 's'}`
              : 'Sin diapositivas',
        });
        text = t;
        checks.push(checkTitle(input.title, text));
        break;
      }
      case 'xlsx': {
        const { checks: xlsxChecks, text: t } = await verifyXlsx(filePath, input);
        checks.push(...xlsxChecks);
        text = t;
        checks.push(checkTitle(input.title, text));
        break;
      }
      case 'html':
      case 'svg': {
        text = xmlToText((await readFileBounded(filePath)).toString('utf8'));
        checks.push(checkTitle(input.title, text));
        break;
      }
      case 'md':
      case 'csv': {
        text = (await readFileBounded(filePath)).toString('utf8');
        checks.push(checkTitle(input.title, text));
        break;
      }
      default: {
        const never: never = format;
        throw new Error(`Formato no soportado: ${String(never)}`);
      }
    }
    checks.push(checkFigures(figures, text));
  } catch (err) {
    checks.push({
      name: 'read',
      ok: false,
      detail: `No se pudo reabrir el archivo: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
