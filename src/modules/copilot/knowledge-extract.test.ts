import { describe, it, expect } from 'vitest';
import {
  extractHtmlTitle,
  extractSameSiteLinks,
  fileKindOf,
  htmlToText,
  parseCsv,
  rankShareable,
  sheetPreview,
  sheetsToText,
  type ShareableCandidate,
} from './knowledge-extract';
import { chunkText } from './knowledge-chunker';

describe('htmlToText', () => {
  it('keeps headings, list items and table rows; drops scripts and styles', () => {
    const html = `<html><head><title>Garantías &amp; más</title><style>p{}</style></head><body>
      <h2>Garantía de instalación</h2><p>Cubre 5&nbsp;años.</p>
      <ul><li>Impermeabilizante</li><li>Pintura</li></ul>
      <table><tr><th>Producto</th><th>Precio</th></tr><tr><td>Acrílico</td><td>$1,200</td></tr></table>
      <script>alert(1)</script></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('## Garantía de instalación');
    expect(text).toContain('Cubre 5 años.');
    expect(text).toContain('- Impermeabilizante');
    expect(text).toContain('Acrílico | $1,200');
    expect(text).not.toContain('alert');
    expect(extractHtmlTitle(html)).toBe('Garantías & más');
  });
});

describe('extractSameSiteLinks', () => {
  it('returns absolute same-host page links without fragments, assets or other hosts', () => {
    const html = `<a href="/productos">P</a><a href="precios#tabla">Pr</a><a href="https://otro.com/x">O</a>
      <a href="/logo.png">L</a><a href="mailto:a@b.c">M</a><a href="#top">T</a>`;
    expect(extractSameSiteLinks(html, 'https://unik.mx/inicio/')).toEqual([
      'https://unik.mx/productos',
      'https://unik.mx/inicio/precios',
    ]);
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF and semicolon delimiters', () => {
    expect(parseCsv('producto;precio\r\n"Sellador ""pro""";"1,200"\r\n\r\nPintura;800')).toEqual([
      ['producto', 'precio'],
      ['Sellador "pro"', '1,200'],
      ['Pintura', '800'],
    ]);
  });
});

describe('sheetsToText', () => {
  it('repeats headers on every row so a fragment never loses what each number means', () => {
    const rows = [['Producto', 'Precio', 'Unidad'], ...Array.from({ length: 40 }, (_, i) => [`Producto ${i}`, `$${100 + i}`, 'cubeta'])];
    const text = sheetsToText([{ name: 'Precios', rows }]);
    expect(text).toContain('# Hoja: Precios (40 filas)');
    expect(text).toContain('Producto: Producto 37 · Precio: $137 · Unidad: cubeta');
    const chunks = chunkText(text, { targetChars: 600 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.section === 'Hoja: Precios (40 filas)')).toBe(true);
    expect(chunks[chunks.length - 1].content).toMatch(/Producto: Producto \d+ · Precio:/);
  });

  it('preview pads short rows and reports the real row count', () => {
    const p = sheetPreview({ name: 'H', rows: [['a', 'b', 'c'], ['1'], ['', ''], ['2', '3']] }, 1);
    expect(p.headers).toEqual(['a', 'b', 'c']);
    expect(p.rows).toEqual([['1', '', '']]);
    expect(p.totalRows).toBe(2);
  });
});

describe('fileKindOf', () => {
  it('classifies by mime or extension', () => {
    expect(fileKindOf('application/pdf')).toBe('pdf');
    expect(fileKindOf('application/octet-stream', 'lista.XLSX')).toBe('excel');
    expect(fileKindOf('text/csv')).toBe('csv');
    expect(fileKindOf(null, 'manual.docx')).toBe('word');
    expect(fileKindOf('text/plain', 'notas.txt')).toBe('text');
  });
});

describe('rankShareable ("mándale el PDF de promociones al cliente")', () => {
  const doc = (id: string, over: Partial<ShareableCandidate>): ShareableCandidate => ({
    id, title: id, description: null, tags: [], category: null, useWhen: null, fileName: null, ...over,
  });
  const docs = [
    doc('promo', { title: 'Promociones septiembre', category: 'promociones', fileName: 'promos-sep.pdf' }),
    doc('catalogo', { title: 'Catálogo de impermeabilizantes', tags: ['catalogo', 'impermeabilizante'] }),
    doc('precios', { title: 'Lista de precios mayoreo', useWhen: 'Cuando un distribuidor pide precios' }),
  ];

  it('picks the promotions PDF as the single clear match', () => {
    const r = rankShareable('mándale el PDF de promociones al cliente', docs);
    expect(r.decision).toBe('single');
    expect(r.ranked[0].id).toBe('promo');
  });

  it('matches accents and plurals ("catalogos" → Catálogo)', () => {
    expect(rankShareable('pasale los catalogos', docs).ranked[0].id).toBe('catalogo');
  });

  it('uses the "when to use" hint', () => {
    expect(rankShareable('el de distribuidor', docs).ranked[0].id).toBe('precios');
  });

  it('reports ambiguity instead of guessing and none when nothing matches', () => {
    const two = [doc('a', { title: 'Promociones septiembre' }), doc('b', { title: 'Promociones octubre' })];
    expect(rankShareable('promociones', two).decision).toBe('ambiguous');
    expect(rankShareable('factura de luz', docs).decision).toBe('none');
  });
});
