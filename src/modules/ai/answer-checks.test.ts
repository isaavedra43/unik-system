import { describe, expect, it } from 'vitest';
import { checkAnswer, citedFoliosNotInResults, collectFolios, findMarkdownCountMismatches } from './answer-checks';

describe('collectFolios / citedFoliosNotInResults', () => {
  it('collects folios from tool results and flags the ones the answer invented', () => {
    const known = new Set<string>();
    collectFolios({ orders: [{ number: 'OV-23354', customer: 'X' }, { salesOrderNumber: 'OV-23216' }], universe: { misreadCorrected: [{ written: '23364', actual: '23354' }] } }, known);
    expect([...known].sort()).toEqual(['23216', '23354', '23364']);
    expect(citedFoliosNotInResults('Revisa OV-23354, OV-23216 y OV-23999.', known)).toEqual(['23999']);
    expect(citedFoliosNotInResults('Revisa OV-23999.', new Set())).toEqual([]);
  });
});

describe('findMarkdownCountMismatches', () => {
  const table = (n: number) => ['| Orden | Nota |', '|---|---|', ...Array.from({ length: n }, (_, i) => `| OV-${23300 + i} | x |`)].join('\n');
  it('compares the announced count with the table rows', () => {
    const answer = `### Recolección — 20\n${table(12)}\n\n### Producción (14)\n${table(14)}\n\n## 3. Discrepancias\nTexto sin tabla.`;
    expect(findMarkdownCountMismatches(answer)).toEqual(['"Recolección — 20" anuncia 20 pero la tabla trae 12 filas']);
  });
  it('ignores headings without counts and bold labels that match', () => {
    expect(findMarkdownCountMismatches(`**Sin nota (1)**\n${table(1)}\n\n## Resumen`)).toEqual([]);
  });
});

describe('checkAnswer', () => {
  it('reports both kinds of issues as actionable notes', () => {
    const known = new Set(['23354']);
    const r = checkAnswer(`### Grupo — 2\n| a |\n|---|\n| OV-23354 |\n\nTambién OV-23777.`, known);
    expect(r.issues).toHaveLength(2);
    expect(r.issues[0]).toContain('OV-23777');
    expect(r.issues[1]).toContain('anuncia 2 pero la tabla trae 1');
  });
});
