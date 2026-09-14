import { describe, expect, it } from 'vitest';
import { extractFolioCandidates, findCountMismatches } from './compose-document-tools';

describe('findCountMismatches', () => {
  it('flags a heading count that does not match the table that follows it', () => {
    const issues = findCountMismatches([
      { type: 'heading', text: 'Recolección — 20 órdenes' },
      { type: 'paragraph', text: 'Incluye…' },
      { type: 'table', rows: Array.from({ length: 12 }, () => ({ a: 1 })) },
      { type: 'table', title: 'Producción / material pendiente — 17 órdenes', rows: Array.from({ length: 17 }, () => ({ a: 1 })) },
      { type: 'heading', text: '3. Casos que requieren revisión' },
      { type: 'table', rows: [{ a: 1 }] },
    ]);
    expect(issues).toEqual(['"Recolección — 20 órdenes" anuncia 20 pero la tabla trae 12 filas']);
  });
  it('ignores headings without a count and counts followed by no table', () => {
    expect(findCountMismatches([{ type: 'heading', text: '1. Resumen ejecutivo' }, { type: 'paragraph', text: 'x' }, { type: 'heading', text: '5 prioridades' }, { type: 'bullets' }])).toEqual([]);
  });
});

describe('extractFolioCandidates', () => {
  it('collects folios from rows and text without duplicates', () => {
    const out = extractFolioCandidates('23297 - Recolección\n23298 Recolección\nOV-23300 Cerrado\n2026 no es folio', [{ orden: '23297', nota: 'x' }, { orden: 23364, nota: 'y' }]);
    expect(out).toEqual(['23297', '23364', '23298', '23300']);
  });
});
