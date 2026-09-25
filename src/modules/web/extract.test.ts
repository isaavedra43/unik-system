import { describe, it, expect } from 'vitest';
import { extractReadable, extractLinks } from './extract';

const ARTICLE_HTML = `<!doctype html><html><head><title>Noticia GPS</title></head>
<body>
<nav>menu que no importa</nav>
<main>
  <h1>La flota U-04 salió de geocerca</h1>
  <p>La unidad U-04 abandonó el perímetro de Bodega Norte a las 14:32.</p>
  <p>El operador reportó paro no programado en el km 12.</p>
  <a href="/unidades/U-04">Ver unidad</a>
  <a href="https://otro-dominio.com/externo">Enlace externo</a>
</main>
<footer>pie</footer>
</body></html>`;

describe('extractReadable', () => {
  it('extrae título y contenido legible de un artículo HTML', () => {
    const page = extractReadable(ARTICLE_HTML, 'https://fleet.ejemplo.mx/noticia');
    expect(page.title).toContain('U-04');
    expect(page.markdown).toContain('abandonó el perímetro');
    expect(page.markdown).not.toContain('menu que no importa');
    expect(page.extracted).toBe(true);
  });

  it('devuelve links same-origin https para el crawler', () => {
    const page = extractReadable(ARTICLE_HTML, 'https://fleet.ejemplo.mx/noticia');
    expect(page.links).toContain('https://fleet.ejemplo.mx/unidades/U-04');
    expect(page.links.some((l) => l.includes('otro-dominio'))).toBe(false);
  });

  it('hace fallback a texto plano cuando no hay artículo claro', () => {
    const page = extractReadable('<html><body><p>hola</p></body></html>', 'https://x.com/');
    expect(page.markdown).toContain('hola');
  });
});

describe('extractLinks', () => {
  it('ignora mailto, tel, fragments y otros orígenes', () => {
    const html = `<a href="mailto:a@b.c">m</a><a href="tel:123">t</a>
      <a href="#seccion">f</a><a href="https://a.com/p#x">ok</a>
      <a href="https://b.com/no">cross</a><a href="http://a.com/insecure">h</a>`;
    const links = extractLinks(html, 'https://a.com/');
    expect(links).toEqual(['https://a.com/p']);
  });
});
