import { createHash, randomBytes } from 'crypto';
import { z } from 'zod';
import {
  figureCandidates,
  renderCellText,
  type StudioCellValue,
  type StudioColumnFormat,
} from './studio-format';

/**
 * Editable content model of the visual studio.
 *
 * A document is an ordered list of typed blocks with STABLE ids. Every
 * exporter renders the same structure; every version stores a canonical hash
 * of it; selection edits (human or AI) replace blocks by id so nothing outside
 * the selection can change.
 *
 * Everything in this file is pure: no database, no storage, no I/O.
 */

export const STUDIO_CONTENT_VERSION = 1 as const;

const blockIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Id de bloque inválido');

export const studioCellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const studioColumnFormatSchema = z.enum([
  'text',
  'number',
  'currency',
  'percentage',
  'date',
]);

export const studioTableColumnSchema = z.object({
  key: z.string().min(1).max(64),
  header: z.string().max(200),
  format: studioColumnFormatSchema.optional(),
  align: z.enum(['left', 'right', 'center']).optional(),
});

export const headingBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal('heading'),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  text: z.string().max(500),
});

export const paragraphBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal('paragraph'),
  text: z.string().max(20_000),
});

export const listBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal('list'),
  items: z.array(z.string().max(2000)).max(500),
  ordered: z.boolean(),
});

export const tableBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal('table'),
  title: z.string().max(200).optional(),
  columns: z.array(studioTableColumnSchema).min(1).max(50),
  rows: z.array(z.record(z.string(), studioCellValueSchema)).max(5000),
});

export const kpiBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal('kpi'),
  cards: z
    .array(z.object({ label: z.string().max(120), value: z.string().max(120) }))
    .min(1)
    .max(12),
});

export const imageBlockSchema = z.object({
  id: blockIdSchema,
  type: z.literal('image'),
  storageObjectId: z.string().min(1).max(64),
  alt: z.string().max(300),
  caption: z.string().max(500).optional(),
  width: z.number().int().positive().max(10_000).optional(),
  height: z.number().int().positive().max(10_000).optional(),
});

export const pageBreakBlockSchema = z.object({ id: blockIdSchema, type: z.literal('pageBreak') });
export const dividerBlockSchema = z.object({ id: blockIdSchema, type: z.literal('divider') });

export const studioBlockSchema = z.discriminatedUnion('type', [
  headingBlockSchema,
  paragraphBlockSchema,
  listBlockSchema,
  tableBlockSchema,
  kpiBlockSchema,
  imageBlockSchema,
  pageBreakBlockSchema,
  dividerBlockSchema,
]);

export const studioContentSchema = z
  .object({
    version: z.literal(STUDIO_CONTENT_VERSION),
    blocks: z.array(studioBlockSchema).max(2000),
  })
  .superRefine((content, ctx) => {
    const seen = new Set<string>();
    for (const block of content.blocks) {
      if (seen.has(block.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Id de bloque duplicado: ${block.id}`,
          path: ['blocks'],
        });
      }
      seen.add(block.id);
    }
  });

export type StudioTableColumn = z.infer<typeof studioTableColumnSchema>;
export type HeadingBlock = z.infer<typeof headingBlockSchema>;
export type ParagraphBlock = z.infer<typeof paragraphBlockSchema>;
export type ListBlock = z.infer<typeof listBlockSchema>;
export type TableBlock = z.infer<typeof tableBlockSchema>;
export type KpiBlock = z.infer<typeof kpiBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type PageBreakBlock = z.infer<typeof pageBreakBlockSchema>;
export type DividerBlock = z.infer<typeof dividerBlockSchema>;
export type StudioBlock = z.infer<typeof studioBlockSchema>;
export type StudioBlockType = StudioBlock['type'];
export type StudioContent = z.infer<typeof studioContentSchema>;
export type { StudioCellValue, StudioColumnFormat };

export class StudioContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioContentError';
  }
}

export function newBlockId(): string {
  return `b_${randomBytes(6).toString('base64url')}`;
}

export function emptyContent(): StudioContent {
  return { version: STUDIO_CONTENT_VERSION, blocks: [] };
}

/** Validates unknown JSON (database, API, model output) into a StudioContent. Throws on error. */
export function parseStudioContent(input: unknown): StudioContent {
  const result = studioContentSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new StudioContentError(
      `Contenido inválido${first ? `: ${first.path.join('.')} ${first.message}` : ''}`
    );
  }
  return result.data;
}

/** Builds a document from tabular data (AI artifact rows/columns → title + optional KPIs + table). */
export function contentFromTable(input: {
  title?: string;
  columns: Array<{ key: string; header: string; format?: StudioColumnFormat }>;
  rows: Array<Record<string, unknown>>;
  summary?: Array<{ label: string; value: string }>;
}): StudioContent {
  const blocks: StudioBlock[] = [];
  if (input.title) blocks.push({ id: newBlockId(), type: 'heading', level: 1, text: input.title });
  if (input.summary && input.summary.length > 0) {
    blocks.push({
      id: newBlockId(),
      type: 'kpi',
      cards: input.summary.slice(0, 12).map((c) => ({ label: c.label, value: String(c.value) })),
    });
  }
  const columns = input.columns.map((c) => ({
    key: c.key,
    header: c.header,
    ...(c.format ? { format: c.format } : {}),
  }));
  const rows = input.rows.map((row) => {
    const out: Record<string, StudioCellValue> = {};
    for (const col of columns) {
      const raw = row[col.key];
      if (raw === null || raw === undefined) out[col.key] = null;
      else if (typeof raw === 'number' || typeof raw === 'boolean') out[col.key] = raw;
      else if (typeof raw === 'string') out[col.key] = raw;
      else out[col.key] = JSON.stringify(raw);
    }
    return out;
  });
  blocks.push({ id: newBlockId(), type: 'table', title: input.title, columns, rows });
  return { version: STUDIO_CONTENT_VERSION, blocks };
}

// ---------------------------------------------------------------------------
// Canonical JSON + hash
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: sorted keys, no undefined, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256 of the canonical JSON of the (re-validated) content. Stable across key order. */
export function hashContent(content: StudioContent): string {
  const normalized = studioContentSchema.parse(content);
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
}

// ---------------------------------------------------------------------------
// Selection edits
// ---------------------------------------------------------------------------

export interface SelectionPatch {
  /** Blocks that replace the selection (empty array = delete the selection). */
  blocks: StudioBlock[];
}

/**
 * Replaces the selected blocks (by id) with `patch.blocks`, at the position of
 * the first selected block. Blocks outside the selection are untouched — this
 * is what makes AI edits safe: the model can only rewrite what the user
 * selected. New blocks keep their ids when they do not collide with a block
 * outside the selection; otherwise a fresh id is generated.
 */
export function applySelectionEdit(
  content: StudioContent,
  blockIds: string[],
  patch: SelectionPatch
): StudioContent {
  if (blockIds.length === 0) throw new StudioContentError('Selecciona al menos un bloque');
  const selected = new Set(blockIds);
  const existingIds = new Set(content.blocks.map((b) => b.id));
  const missing = blockIds.filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    throw new StudioContentError(`Bloques inexistentes: ${missing.join(', ')}`);
  }
  const replacement = z.array(studioBlockSchema).max(500).parse(patch.blocks);

  const keptIds = new Set(content.blocks.filter((b) => !selected.has(b.id)).map((b) => b.id));
  const usedIds = new Set(keptIds);
  const normalizedReplacement = replacement.map((block) => {
    let id = block.id;
    if (usedIds.has(id)) id = newBlockId();
    usedIds.add(id);
    return { ...block, id } as StudioBlock;
  });

  const firstIndex = content.blocks.findIndex((b) => selected.has(b.id));
  const blocks: StudioBlock[] = [];
  content.blocks.forEach((block, index) => {
    if (index === firstIndex) blocks.push(...normalizedReplacement);
    if (!selected.has(block.id)) blocks.push(block);
  });
  return studioContentSchema.parse({ version: STUDIO_CONTENT_VERSION, blocks });
}

/** Moves a block to a new index (pure). */
export function moveBlock(content: StudioContent, blockId: string, toIndex: number): StudioContent {
  const from = content.blocks.findIndex((b) => b.id === blockId);
  if (from < 0) throw new StudioContentError('Bloque inexistente');
  const blocks = [...content.blocks];
  const [block] = blocks.splice(from, 1);
  const target = Math.max(0, Math.min(blocks.length, toIndex));
  blocks.splice(target, 0, block);
  return { version: STUDIO_CONTENT_VERSION, blocks };
}

// ---------------------------------------------------------------------------
// Diff summary
// ---------------------------------------------------------------------------

export interface ContentDiff {
  added: string[];
  removed: string[];
  changed: string[];
  moved: string[];
  unchanged: number;
  summary: string;
}

export function diffContent(before: StudioContent, after: StudioContent): ContentDiff {
  const beforeMap = new Map(before.blocks.map((b, i) => [b.id, { block: b, index: i }]));
  const afterMap = new Map(after.blocks.map((b, i) => [b.id, { block: b, index: i }]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const moved: string[] = [];
  let unchanged = 0;

  for (const [id, entry] of afterMap) {
    const prev = beforeMap.get(id);
    if (!prev) {
      added.push(id);
      continue;
    }
    if (canonicalJson(prev.block) !== canonicalJson(entry.block)) changed.push(id);
    else unchanged++;
  }
  for (const id of beforeMap.keys()) {
    if (!afterMap.has(id)) removed.push(id);
  }
  // Relative order of surviving blocks.
  const survivingBefore = before.blocks.map((b) => b.id).filter((id) => afterMap.has(id));
  const survivingAfter = after.blocks.map((b) => b.id).filter((id) => beforeMap.has(id));
  survivingAfter.forEach((id, i) => {
    if (survivingBefore[i] !== id) moved.push(id);
  });

  const parts: string[] = [];
  if (changed.length > 0)
    parts.push(`${changed.length} modificado${changed.length === 1 ? '' : 's'}`);
  if (added.length > 0) parts.push(`${added.length} añadido${added.length === 1 ? '' : 's'}`);
  if (removed.length > 0)
    parts.push(`${removed.length} eliminado${removed.length === 1 ? '' : 's'}`);
  if (moved.length > 0 && changed.length === 0 && added.length === 0 && removed.length === 0) {
    parts.push(`${moved.length} reordenado${moved.length === 1 ? '' : 's'}`);
  }
  const summary = parts.length > 0 ? `Bloques: ${parts.join(', ')}` : 'Sin cambios en los bloques';
  return { added, removed, changed, moved, unchanged, summary };
}

// ---------------------------------------------------------------------------
// Figures (numbers and amounts) for render verification
// ---------------------------------------------------------------------------

export interface StudioFigure {
  blockId: string;
  blockType: StudioBlockType;
  /** Human location, e.g. "tabla Ventas · fila 3 · total". */
  location: string;
  /** Source text or value as written in the content. */
  raw: string;
  /** Every normalized string form the figure may take once rendered. */
  candidates: string[];
  /** Data figures live in tables/KPIs; text figures in headings/paragraphs/lists. */
  scope: 'data' | 'text';
}

const TEXT_FIGURE_RE = /\d[\d,]*(?:\.\d+)?/g;

function textFigures(
  text: string,
  base: Pick<StudioFigure, 'blockId' | 'blockType' | 'location' | 'scope'>
): StudioFigure[] {
  const out: StudioFigure[] = [];
  for (const match of text.matchAll(TEXT_FIGURE_RE)) {
    const raw = match[0].replace(/,$/, '');
    const candidates = figureCandidates(raw);
    if (candidates.length === 0) continue;
    out.push({ ...base, raw, candidates });
  }
  return out;
}

/**
 * Lists every number/amount a reader expects to find in a rendered export:
 * table cells (numeric or numbers inside text), KPI values, and numbers inside
 * headings, paragraphs and list items. Image/divider/pageBreak carry none.
 */
export function extractFigures(content: StudioContent): StudioFigure[] {
  const figures: StudioFigure[] = [];
  content.blocks.forEach((block, blockIndex) => {
    switch (block.type) {
      case 'heading':
      case 'paragraph':
        figures.push(
          ...textFigures(block.text, {
            blockId: block.id,
            blockType: block.type,
            location: `${block.type === 'heading' ? 'encabezado' : 'párrafo'} ${blockIndex + 1}`,
            scope: 'text',
          })
        );
        break;
      case 'list':
        block.items.forEach((item, i) => {
          figures.push(
            ...textFigures(item, {
              blockId: block.id,
              blockType: 'list',
              location: `lista ${blockIndex + 1} · elemento ${i + 1}`,
              scope: 'text',
            })
          );
        });
        break;
      case 'kpi':
        block.cards.forEach((card, i) => {
          figures.push(
            ...textFigures(card.value, {
              blockId: block.id,
              blockType: 'kpi',
              location: `KPI ${i + 1} (${card.label})`,
              scope: 'data',
            })
          );
        });
        break;
      case 'table': {
        const name = block.title ? `tabla ${block.title}` : `tabla ${blockIndex + 1}`;
        block.rows.forEach((row, rowIndex) => {
          for (const col of block.columns) {
            const value = row[col.key];
            if (value === null || value === undefined || typeof value === 'boolean') continue;
            const location = `${name} · fila ${rowIndex + 1} · ${col.header || col.key}`;
            if (typeof value === 'number') {
              const rendered = renderCellText(value, col.format);
              const candidates = [
                ...new Set([...figureCandidates(String(value)), ...figureCandidates(rendered)]),
              ];
              figures.push({
                blockId: block.id,
                blockType: 'table',
                location,
                raw: String(value),
                candidates,
                scope: 'data',
              });
            } else {
              const rendered = renderCellText(value, col.format);
              for (const f of textFigures(value, {
                blockId: block.id,
                blockType: 'table',
                location,
                scope: 'data',
              })) {
                figures.push({
                  ...f,
                  candidates: [...new Set([...f.candidates, ...figureCandidates(rendered)])],
                });
              }
            }
          }
        });
        break;
      }
      default:
        break;
    }
  });
  return figures;
}

/** Plain-text projection used by previews and the AI prompt (no formatting). */
export function contentToPlainText(content: StudioContent): string {
  const lines: string[] = [];
  for (const block of content.blocks) {
    switch (block.type) {
      case 'heading':
        lines.push(block.text);
        break;
      case 'paragraph':
        lines.push(block.text);
        break;
      case 'list':
        block.items.forEach((item, i) =>
          lines.push(`${block.ordered ? `${i + 1}.` : '-'} ${item}`)
        );
        break;
      case 'kpi':
        lines.push(block.cards.map((c) => `${c.label}: ${c.value}`).join(' | '));
        break;
      case 'table':
        if (block.title) lines.push(block.title);
        lines.push(block.columns.map((c) => c.header).join(' | '));
        for (const row of block.rows) {
          lines.push(block.columns.map((c) => renderCellText(row[c.key], c.format)).join(' | '));
        }
        break;
      case 'image':
        lines.push(`[Imagen: ${block.alt}]${block.caption ? ` ${block.caption}` : ''}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}
