import { describe, it, expect } from 'vitest';
import {
  applySelectionEdit,
  canonicalJson,
  contentFromTable,
  diffContent,
  extractFigures,
  hashContent,
  parseStudioContent,
  StudioContentError,
  type StudioContent,
} from './studio-content';
import { figureCandidates, normalizeFigureText, renderCellText } from './studio-format';
import { sampleContent } from './studio-test-utils';

describe('renderCellText / figures normalization', () => {
  it('formats currency, numbers, percentages and dates deterministically', () => {
    expect(renderCellText(1234.5, 'currency')).toBe('$1,234.50');
    expect(renderCellText('18,000.50', 'currency')).toBe('$18,000.50');
    expect(renderCellText(1234567.891, 'number')).toBe('1,234,567.89');
    expect(renderCellText(41.5, 'percentage')).toBe('41.5%');
    expect(renderCellText('2026-09-15', 'date')).toBe('15/09/2026');
    expect(renderCellText(true)).toBe('Sí');
    expect(renderCellText(null)).toBe('');
    expect(renderCellText(-1500, 'currency')).toBe('$-1,500.00');
  });

  it('normalizes rendered text and produces candidates that match either form', () => {
    expect(normalizeFigureText('$ 1,234.50 MXN')).toBe('1234.50');
    const candidates = figureCandidates('1234.5');
    expect(candidates).toContain('1234.5');
    expect(candidates).toContain('1234.50');
  });
});

describe('extractFigures', () => {
  it('lists every number in tables, KPIs, paragraphs and lists with a location', () => {
    const figures = extractFigures(sampleContent());
    const raws = figures.map((f) => f.raw);
    // KPI values
    expect(raws).toContain('1,234,567.89');
    expect(raws).toContain('18.5');
    // paragraph amounts
    expect(raws).toContain('45,000.50');
    // numeric table cells (raw JSON value) and string cells
    expect(raws).toContain('512300.5');
    expect(raws).toContain('18,000.50');
    // list item figure
    expect(figures.some((f) => f.blockId === 'b_list' && f.raw === '45,000.50')).toBe(true);
    // table cells are "data" scope, prose is "text" scope
    expect(figures.find((f) => f.blockId === 'b_t1')?.scope).toBe('data');
    expect(figures.find((f) => f.blockId === 'b_p1')?.scope).toBe('text');
    expect(figures.find((f) => f.blockId === 'b_t1')?.location).toContain(
      'tabla Ventas por sucursal'
    );
    // dates in the second table contribute digits too
    expect(raws).toContain('2026');
  });

  it('numeric cells carry both the raw and the rendered candidates', () => {
    const fig = extractFigures(sampleContent()).find((f) => f.raw === '512300.5');
    expect(fig?.candidates).toContain('512300.5');
    expect(fig?.candidates).toContain('512300.50');
  });

  it('ignores images, dividers and page breaks', () => {
    const content: StudioContent = {
      version: 1,
      blocks: [
        { id: 'a', type: 'image', storageObjectId: 'o1', alt: 'Foto 2026' },
        { id: 'b', type: 'divider' },
        { id: 'c', type: 'pageBreak' },
      ],
    };
    expect(extractFigures(content)).toEqual([]);
  });
});

describe('hashContent', () => {
  it('is stable regardless of key order and undefined fields', () => {
    const a = sampleContent();
    const reordered = JSON.parse(JSON.stringify(a)) as StudioContent;
    reordered.blocks = reordered.blocks.map((b) => {
      const entries = Object.entries(b).reverse();
      return Object.fromEntries(entries) as typeof b;
    });
    expect(hashContent(a)).toBe(hashContent(reordered));
    expect(hashContent(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });

  it('changes when a single figure changes', () => {
    const a = sampleContent();
    const b = JSON.parse(JSON.stringify(a)) as StudioContent;
    const table = b.blocks.find((x) => x.id === 'b_t1');
    if (table?.type === 'table') table.rows[0].total = 512300.51;
    expect(hashContent(a)).not.toBe(hashContent(b));
  });
});

describe('applySelectionEdit', () => {
  it('replaces the selection in place and leaves other blocks untouched', () => {
    const content = sampleContent();
    const next = applySelectionEdit(content, ['b_p1'], {
      blocks: [{ id: 'b_p1', type: 'paragraph', text: 'Resumen corto.' }],
    });
    expect(next.blocks.map((b) => b.id)).toEqual(content.blocks.map((b) => b.id));
    const p = next.blocks.find((b) => b.id === 'b_p1');
    expect(p?.type === 'paragraph' && p.text).toBe('Resumen corto.');
    expect(next.blocks.find((b) => b.id === 'b_t1')).toEqual(
      content.blocks.find((b) => b.id === 'b_t1')
    );
  });

  it('deletes with an empty patch and can expand one block into several', () => {
    const content = sampleContent();
    const removed = applySelectionEdit(content, ['b_p1', 'b_list'], { blocks: [] });
    expect(removed.blocks.some((b) => b.id === 'b_p1' || b.id === 'b_list')).toBe(false);
    expect(removed.blocks.length).toBe(content.blocks.length - 2);

    const expanded = applySelectionEdit(content, ['b_h2'], {
      blocks: [
        { id: 'b_h2', type: 'heading', level: 2, text: 'Cobranza' },
        { id: 'b_new', type: 'paragraph', text: 'Detalle.' },
      ],
    });
    const idx = expanded.blocks.findIndex((b) => b.id === 'b_h2');
    expect(expanded.blocks[idx + 1].id).toBe('b_new');
    expect(expanded.blocks[idx + 2].id).toBe('b_t2');
  });

  it('places multi-block selections at the first selected position', () => {
    const content = sampleContent();
    const next = applySelectionEdit(content, ['b_kpi', 'b_t1'], {
      blocks: [{ id: 'b_merged', type: 'paragraph', text: 'Fusionado' }],
    });
    const ids = next.blocks.map((b) => b.id);
    expect(ids.indexOf('b_merged')).toBe(1);
    expect(ids).not.toContain('b_kpi');
    expect(ids).not.toContain('b_t1');
  });

  it('regenerates ids that collide with blocks outside the selection', () => {
    const content = sampleContent();
    const next = applySelectionEdit(content, ['b_p1'], {
      blocks: [{ id: 'b_t2', type: 'paragraph', text: 'colisión' }],
    });
    const ids = next.blocks.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(next.blocks.filter((b) => b.id === 'b_t2')).toHaveLength(1);
    expect(next.blocks.find((b) => b.id === 'b_t2')?.type).toBe('table');
  });

  it('rejects unknown block ids, empty selections and invalid blocks', () => {
    const content = sampleContent();
    expect(() => applySelectionEdit(content, ['nope'], { blocks: [] })).toThrow(StudioContentError);
    expect(() => applySelectionEdit(content, [], { blocks: [] })).toThrow(StudioContentError);
    expect(() =>
      applySelectionEdit(content, ['b_p1'], {
        blocks: [{ id: 'x', type: 'heading', level: 9 } as never],
      })
    ).toThrow();
  });
});

describe('diffContent / parse / contentFromTable', () => {
  it('summarizes changes in Spanish', () => {
    const a = sampleContent();
    const b = applySelectionEdit(a, ['b_p1'], {
      blocks: [
        { id: 'b_p1', type: 'paragraph', text: 'Nuevo' },
        { id: 'b_extra', type: 'divider' },
      ],
    });
    const diff = diffContent(a, b);
    expect(diff.changed).toEqual(['b_p1']);
    expect(diff.added).toEqual(['b_extra']);
    expect(diff.removed).toEqual([]);
    expect(diff.summary).toBe('Bloques: 1 modificado, 1 añadido');
    expect(diffContent(a, a).summary).toBe('Sin cambios en los bloques');
  });

  it('rejects duplicate ids and unknown block types', () => {
    expect(() =>
      parseStudioContent({
        version: 1,
        blocks: [
          { id: 'a', type: 'divider' },
          { id: 'a', type: 'divider' },
        ],
      })
    ).toThrow(StudioContentError);
    expect(() => parseStudioContent({ version: 1, blocks: [{ id: 'a', type: 'video' }] })).toThrow(
      StudioContentError
    );
  });

  it('turns AI artifact rows/columns into title + KPIs + table', () => {
    const content = contentFromTable({
      title: 'Top clientes',
      columns: [
        { key: 'customer', header: 'Cliente' },
        { key: 'total', header: 'Total', format: 'currency' },
      ],
      rows: [
        { customer: 'ACME', total: '1797.00', extra: { nested: true } },
        { customer: 'Beta', total: 250 },
      ],
      summary: [{ label: 'Total', value: '$2,047.00' }],
    });
    expect(content.blocks.map((b) => b.type)).toEqual(['heading', 'kpi', 'table']);
    const table = content.blocks[2];
    expect(table.type === 'table' && table.rows[0]).toEqual({ customer: 'ACME', total: '1797.00' });
    expect(extractFigures(content).map((f) => f.raw)).toContain('1797.00');
  });
});
