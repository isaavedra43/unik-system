import { existsSync, mkdirSync } from 'node:fs';
import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * Visual pass over the whole operations experience (plan section 7).
 *
 * It walks every area in its four spaces and subpages, the 360 case file, "Mi
 * trabajo", the internal chat with an area channel and a case room, the Control
 * Tower and each Neural Operations tool, at THE FOUR WIDTHS THE PLAN DEMANDS
 * (section 9.1): 1366, 1024, 768 and 390 CSS px. On every page and every width
 * it checks the four things a screenshot cannot tell you at a glance:
 *
 *   1. no console errors (a client crash still renders a header);
 *   2. no horizontal scroll (the responsive rule, `documentElement.scrollWidth`);
 *   3. no `undefined` / `NaN` leaking into the visible text;
 *   4. an empty screen says so — it is never blank.
 *
 * It needs the preview server running against the DISPOSABLE preview database,
 * with the seed already planted and a storageState to sign in. See
 * `docs/pilot-runbook.md` (section "Operaciones"):
 *
 *   PREVIEW_BASE_URL=http://localhost:3100 \
 *   PREVIEW_STORAGE_STATE=<scratchpad>/preview-auth.json \
 *   PREVIEW_SCREENS=<scratchpad>/screens \
 *     npx playwright test e2e/operations-visual.spec.ts
 *
 * Without `PREVIEW_STORAGE_STATE` the whole file is skipped, so `npm run
 * test:e2e` on a laptop with nothing running does not turn red.
 *
 * `PREVIEW_WIDTHS=768,390` narrows the run to those widths when you are chasing
 * one breakpoint; with the variable unset every page is measured at all four.
 */

const BASE_URL = process.env.PREVIEW_BASE_URL ?? 'http://localhost:3100';
const STORAGE_STATE = process.env.PREVIEW_STORAGE_STATE ?? '';
const SCREENS_DIR = process.env.PREVIEW_SCREENS ?? 'e2e/screens';

interface Viewport {
  width: number;
  height: number;
}

/**
 * Los cuatro anchos del plan (sección 9.1). No son decorativos: 1024 y 768 son
 * fronteras de verdad en esta hoja de estilos —hay reglas a `max-width: 1024px`
 * y a `max-width: 1023px`, a `max-width: 768px` y a `min-width: 769px`, y
 * `useIsMobile()` cambia de superficie exactamente en 768— así que a 768 px la
 * app YA está en su modo móvil con el ancho de una tableta, que es donde
 * vivieron los defectos de acomodo que encontró la revisión.
 */
const DESKTOP: Viewport = { width: 1366, height: 900 };
const LAPTOP: Viewport = { width: 1024, height: 768 };
const TABLET: Viewport = { width: 768, height: 1024 };
const PHONE: Viewport = { width: 390, height: 844 };

const ALL_WIDTHS: readonly Viewport[] = [DESKTOP, LAPTOP, TABLET, PHONE];

/** `PREVIEW_WIDTHS=768,390` acota la corrida a esos anchos; vacío = los cuatro. */
const REQUESTED_WIDTHS = (process.env.PREVIEW_WIDTHS ?? '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const WIDTHS: readonly Viewport[] = REQUESTED_WIDTHS.length
  ? ALL_WIDTHS.filter((viewport) => REQUESTED_WIDTHS.includes(viewport.width))
  : ALL_WIDTHS;

if (WIDTHS.length === 0) {
  throw new Error(
    `PREVIEW_WIDTHS=${process.env.PREVIEW_WIDTHS} no coincide con ninguno de los anchos del plan (${ALL_WIDTHS.map((v) => v.width).join(', ')}).`
  );
}

/**
 * Anchos que además se comprueban con CARGA DIRECTA. Es todo menos 1366, que ya
 * es el ancho con el que cada visita abre la página. Importan los tres: el
 * servidor pinta siempre la variante ancha, así que a 1024 (`useWideScreen`
 * cambia en 1280) y a 768/390 (`useIsMobile` cambia en 768) la superficie
 * definitiva aparece en la hidratación, por un camino que redimensionar no
 * recorre.
 */
const FRESH_LOAD_WIDTHS = WIDTHS.filter((viewport) => viewport !== DESKTOP);

test.skip(
  !STORAGE_STATE || !existsSync(STORAGE_STATE),
  'Falta PREVIEW_STORAGE_STATE: esta suite necesita el servidor de vista previa y una sesión sembrada.'
);

test.use({ storageState: STORAGE_STATE || undefined, baseURL: BASE_URL });

if (!existsSync(SCREENS_DIR)) mkdirSync(SCREENS_DIR, { recursive: true });

const AREAS = [
  'ventas',
  'compras',
  'inventario',
  'manufactura',
  'logistica',
  'contabilidad',
] as const;

/** Spaces every area has, plus the ones each one adds. */
const AREA_SPACES: Record<string, readonly string[]> = {
  ventas: ['dashboard', 'trabajo', 'comunicaciones', 'radar', 'oportunidades', 'pipeline'],
  compras: ['dashboard', 'trabajo', 'comunicaciones', 'sourcing', 'ordenes', 'rfq', 'proveedores'],
  inventario: [
    'dashboard',
    'trabajo',
    'comunicaciones',
    'mapa',
    'existencias',
    'conteos',
    'movimientos',
    'ubicaciones',
  ],
  manufactura: ['dashboard', 'trabajo', 'comunicaciones', 'tablero', 'ordenes'],
  logistica: ['dashboard', 'trabajo', 'comunicaciones', 'despacho', 'viajes', 'flota', 'chofer'],
  contabilidad: [
    'dashboard',
    'trabajo',
    'comunicaciones',
    'libro',
    'gastos',
    'obligaciones',
    'nomina',
    'presupuestos',
    'cierre',
    'catalogos',
  ],
};

const NEURAL_TOOLS = ['procesos', 'variantes', 'grafo', 'replay', 'simulacion'] as const;
const CONTROL_TOWER_VIEWS = [
  'resumen',
  'personas',
  'excepciones',
  'aprobaciones',
  'auditoria',
  'configuracion',
] as const;

/**
 * Console noise that is not a defect of the page:
 * - the preview server runs with deliberately FAKE AI keys, so every AI call
 *   fails on purpose and that failure is what we want to see handled;
 * - Next reports a 404/500 of a sub-resource through the console too;
 * - React DevTools and HMR chatter.
 */
const IGNORED_CONSOLE = [
  /favicon/i,
  /react devtools/i,
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  /manifest\.webmanifest/i,
  /Service ?Worker/i,
  /sw\.js/i,
  /preload/i,
  /ERR_INTERNET_DISCONNECTED/i,
  // The preview server has no real AI provider: an assistant panel failing to answer is expected.
  /incorrect api key|invalid_api_key|401.*openai|openai.*401/i,
];

interface PageIssues {
  consoleErrors: string[];
  pageErrors: string[];
}

function watchPage(page: Page): PageIssues {
  const issues: PageIssues = { consoleErrors: [], pageErrors: [] };
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
    issues.consoleErrors.push(text);
  });
  page.on('pageerror', (error) => {
    const text = error.message;
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
    issues.pageErrors.push(text);
  });
  return issues;
}

/** Text that must never reach a person: a formatter that gave up. */
const BAD_TEXT = /\b(undefined|NaN|\[object Object\]|Invalid Date)\b/;

interface ClippedElement {
  selector: string;
  scrollWidth: number;
  clientWidth: number;
  right: number;
  text: string;
}

interface CheckResult {
  /** Ruta y ancho: un fallo tiene que decir EN QUÉ ancho se rompió. */
  path: string;
  status: number | null;
  horizontalOverflow: { scrollWidth: number; clientWidth: number } | null;
  /** Content wider than its box with nobody able to scroll it (the real defect). */
  clipped: ClippedElement[];
  /** Interactive controls painted past the right edge of the viewport. */
  outsideViewport: string[];
  badText: string | null;
  emptyBody: boolean;
}

/** Deja que hidraten los componentes de cliente y asiente la primera lectura. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

async function measure(
  page: Page,
  path: string,
  viewport: Viewport,
  name: string,
  status: number | null
): Promise<CheckResult> {
  // `fullPage`: in a dense ERP the first screen is a third of the page, and the
  // grid of locations, the charts and the tables all live below the fold.
  await page.screenshot({ path: `${SCREENS_DIR}/${name}-w${viewport.width}.png`, fullPage: true });

  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    // 1px of rounding is not an overflow.
    return el.scrollWidth - el.clientWidth > 1
      ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      : null;
  });

  /*
   * `documentElement.scrollWidth` is NOT enough: a table wider than its column
   * inside a `main` with `overflow-x: hidden` leaves the document at exactly the
   * viewport width while half its columns (ACCIONES among them) are unreachable.
   * So we also walk the descendants of `main` and fail when one is wider than
   * its box and no ancestor can scroll it.
   */
  const clipped = await page.evaluate(() => {
    const root = document.querySelector('main');
    if (!root) return [] as Array<Record<string, unknown>>;
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const cls =
        typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
      return `${el.tagName.toLowerCase()}${id}${cls}`;
    };
    const scrollable = (el: Element): boolean => {
      const style = getComputedStyle(el);
      return style.overflowX === 'auto' || style.overflowX === 'scroll';
    };
    /** Lienzos que se recorren arrastrando: su contenido ES más ancho a propósito. */
    const PANNABLE = '.leaflet-container, .react-flow';
    const out: Array<Record<string, unknown>> = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      // Menos de 16 px es casi siempre un redondeo o una caja decorativa.
      if (el.scrollWidth - el.clientWidth <= 16) continue;
      // Sin texto visible no hay nada que se pueda perder de vista.
      if (!(el.textContent ?? '').trim()) continue;
      if (scrollable(el)) continue;
      // Recorte deliberado: el texto lleva sus puntos suspensivos.
      if (getComputedStyle(el).textOverflow === 'ellipsis') continue;
      // Sólo para lectores de pantalla (1 px de caja, nunca se ve).
      if (el.classList.contains('sr-only')) continue;
      if (el.matches(PANNABLE) || el.closest(PANNABLE)) continue;
      let ancestor: Element | null = el.parentElement;
      let rescued = false;
      while (ancestor && ancestor !== document.body) {
        if (scrollable(ancestor)) {
          rescued = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (rescued) continue;
      out.push({
        selector: describe(el),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        right: Math.round(el.getBoundingClientRect().right),
        text: (el.textContent ?? '').trim().slice(0, 60),
      });
      if (out.length >= 5) break;
    }
    return out;
  });

  /** A control the person cannot reach because it is painted past the viewport. */
  const outsideViewport = await page.evaluate(() => {
    const out: string[] = [];
    const controls = document.querySelectorAll('main button, main a, main input, main select');
    const scrollableAncestor = (el: Element): boolean => {
      let node: Element | null = el.parentElement;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') return true;
        node = node.parentElement;
      }
      return false;
    };
    for (const el of Array.from(controls)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      if (rect.right <= window.innerWidth + 1 && rect.left >= -1) continue;
      // Se alcanza desplazando su carril (pestañas, tabla, chips): no es un corte.
      if (scrollableAncestor(el)) continue;
      const label =
        (el.textContent ?? '').trim().slice(0, 40) || el.getAttribute('aria-label') || '';
      out.push(`${el.tagName.toLowerCase()} «${label}» → ${Math.round(rect.right)}px`);
      if (out.length >= 5) break;
    }
    return out;
  });

  const bodyText = await page.evaluate(() => document.body.innerText ?? '');
  const badMatch = bodyText.match(BAD_TEXT);

  return {
    path: `${path} @${viewport.width}px`,
    status,
    horizontalOverflow: overflow,
    clipped: clipped as unknown as ClippedElement[],
    outsideViewport,
    badText: badMatch
      ? bodyText.slice(Math.max(0, (badMatch.index ?? 0) - 90), (badMatch.index ?? 0) + 90)
      : null,
    emptyBody: bodyText.trim().length < 20,
  };
}

/**
 * Abre la página en el PRIMER ancho de la lista (el mayor: van de 1366 a 390) y
 * la vuelve a medir en cada uno de los demás redimensionando la ventana.
 *
 * Redimensionar —en vez de navegar cuatro veces— es fiel en esta app y cuesta
 * un tercio: las reglas responsivas son media queries puras y los componentes
 * que cambian de superficie (`useIsMobile`, `useWideScreen`) escuchan
 * `matchMedia(...).change`, así que se vuelven a pintar solos. Lo único que el
 * redimensionado NO ejercita es la hidratación a ese ancho (el servidor siempre
 * pinta la variante ancha), y para eso está la prueba de CARGA DIRECTA a 1024,
 * 768 y 390.
 */
async function visit(
  page: Page,
  path: string,
  viewports: readonly Viewport[],
  name: string
): Promise<CheckResult[]> {
  const widths = viewports.length > 0 ? viewports : [DESKTOP];
  await page.setViewportSize(widths[0]);
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  const status = response?.status() ?? null;

  const results: CheckResult[] = [];
  for (const [index, viewport] of widths.entries()) {
    if (index > 0) {
      await page.setViewportSize(viewport);
      // Dos cuadros: uno para que corran las media queries y el `useSyncExternalStore`
      // de `useIsMobile`, otro para que se asiente el acomodo que eso provoca.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          })
      );
    }
    await settle(page);
    results.push(await measure(page, path, viewport, name, status));
  }
  return results;
}

function assertOne(result: CheckResult, issues: PageIssues): void {
  expect(result.status, `${result.path}: respuesta HTTP`).toBeLessThan(400);
  expect(issues.pageErrors, `${result.path}: excepción en el cliente`).toEqual([]);
  expect(issues.consoleErrors, `${result.path}: errores de consola`).toEqual([]);
  expect(
    result.horizontalOverflow,
    `${result.path}: scroll horizontal (${result.horizontalOverflow?.scrollWidth} > ${result.horizontalOverflow?.clientWidth})`
  ).toBeNull();
  expect(
    result.clipped,
    `${result.path}: contenido recortado sin barra para alcanzarlo → ${JSON.stringify(result.clipped)}`
  ).toEqual([]);
  expect(
    result.outsideViewport,
    `${result.path}: controles fuera de la pantalla → ${result.outsideViewport.join(' | ')}`
  ).toEqual([]);
  expect(result.badText, `${result.path}: texto roto visible → «${result.badText}»`).toBeNull();
  // A page that renders nothing is worse than one that says it is empty.
  expect(result.emptyBody, `${result.path}: la página no pintó nada`).toBe(false);
}

/**
 * Revisa la página en todos sus anchos y LIMPIA los avisos de consola antes de
 * la siguiente. La limpieza vive aquí a propósito: cuando estaba en el llamador
 * era fácil olvidarla al añadir un caso, y entonces el error de una página se le
 * atribuía a la siguiente.
 */
function assertHealthy(results: CheckResult[], issues: PageIssues): void {
  try {
    for (const result of results) assertOne(result, issues);
  } finally {
    issues.consoleErrors.length = 0;
    issues.pageErrors.length = 0;
  }
}

/** One id the seed always plants, so the deep links are stable. */
const SEED_CASE = 'seed-case-c';

/** One work item the seed always plants, open and owned by the preview user. */
const SEED_WORK_ITEM = 'seed-wi-f';

test.describe('Recorrido visual de operaciones', () => {
  // Cada prueba abre entre 5 y 10 páginas y mide cada una en los cuatro anchos.
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  for (const area of AREAS) {
    test(`área ${area}: sus espacios en los cuatro anchos`, async ({ page }) => {
      const issues = watchPage(page);
      for (const space of AREA_SPACES[area]) {
        assertHealthy(
          await visit(page, `/app/areas/${area}/${space}`, WIDTHS, `area-${area}-${space}`),
          issues
        );
      }
    });
  }

  /**
   * Lo que el redimensionado no puede ver: el servidor SIEMPRE pinta la variante
   * ancha, así que la superficie definitiva aparece en la HIDRATACIÓN. Esta
   * prueba la ejerce abriendo la página ya en cada ancho: panel, centro de
   * trabajo y vista especial de cada área, y el resumen de la Torre de Control,
   * que es donde vive `useWideScreen` (1280) y por eso 1024 no es un ancho de
   * adorno.
   */
  test('carga directa a 1024, 768 y 390: áreas y Torre de Control', async ({ page }) => {
    test.skip(FRESH_LOAD_WIDTHS.length === 0, 'PREVIEW_WIDTHS dejó sólo 1366.');
    const issues = watchPage(page);
    for (const area of AREAS) {
      const spaces = AREA_SPACES[area];
      const special = spaces[3];
      for (const space of ['dashboard', 'trabajo', special]) {
        for (const viewport of FRESH_LOAD_WIDTHS) {
          assertHealthy(
            await visit(
              page,
              `/app/areas/${area}/${space}`,
              [viewport],
              `carga-area-${area}-${space}`
            ),
            issues
          );
        }
      }
    }
    for (const viewport of FRESH_LOAD_WIDTHS) {
      assertHealthy(
        await visit(page, '/app/admin/control-tower/resumen', [viewport], 'carga-ct-resumen'),
        issues
      );
    }
  });

  /**
   * Las páginas de gestión que viven bajo un área sin ser espacios del registro
   * (`AREA_EXTRA_PAGES` en nav-config). Las demás ya entran por `AREA_SPACES`;
   * éstas dos sólo se alcanzan por su ruta, así que ninguna prueba las abría.
   */
  test('páginas de gestión bajo un área', async ({ page }) => {
    const issues = watchPage(page);
    for (const [path, name] of [
      ['/app/areas/contabilidad/gastos/nuevo', 'area-contabilidad-gasto-nuevo'],
      ['/app/areas/inventario/perfiles', 'area-inventario-perfiles'],
    ] as const) {
      assertHealthy(await visit(page, path, WIDTHS, name), issues);
    }
  });

  test('expedientes: lista y Expediente 360', async ({ page }) => {
    const issues = watchPage(page);
    for (const [path, name] of [
      ['/app/operations', 'operations-lista'],
      [`/app/operations/cases/${SEED_CASE}`, 'operations-expediente-360'],
    ] as const) {
      assertHealthy(await visit(page, path, WIDTHS, name), issues);
    }
  });

  test('Mi trabajo', async ({ page }) => {
    const issues = watchPage(page);
    assertHealthy(await visit(page, '/app/mywork', WIDTHS, 'mywork'), issues);
  });

  test('chat interno: bandeja, canal de área y sala de expediente', async ({ page }) => {
    const issues = watchPage(page);
    assertHealthy(await visit(page, '/app/chat', WIDTHS, 'chat'), issues);

    // The area channel and the case room live inside the area's communications space.
    assertHealthy(
      await visit(page, '/app/areas/ventas/comunicaciones?tab=chat', WIDTHS, 'chat-canal-area'),
      issues
    );
    assertHealthy(
      await visit(
        page,
        '/app/areas/ventas/comunicaciones?tab=solicitudes',
        WIDTHS,
        'chat-solicitudes'
      ),
      issues
    );
  });

  test('Control Tower: sus seis vistas', async ({ page }) => {
    const issues = watchPage(page);
    for (const view of CONTROL_TOWER_VIEWS) {
      assertHealthy(
        await visit(page, `/app/admin/control-tower/${view}`, WIDTHS, `ct-${view}`),
        issues
      );
    }
  });

  /**
   * Red permanente del defecto que dejó TODA acción de trabajo en HTTP 500
   * durante cinco fases: el motor de comandos y los servicios del núcleo
   * quedaron en copias distintas del módulo (Next compila un módulo de servidor
   * una vez por capa de webpack), así que el contexto que abría `executeCommand`
   * no lo veía el manejador. Las 3 497 pruebas unitarias no podían verlo porque
   * vitest resuelve el alias a una sola instancia: hay que pedirlo por HTTP
   * contra el servidor CONSTRUIDO.
   */
  test('una acción de fila de verdad responde 200 (no 500)', async ({ request }) => {
    const commandId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const response = await request.post('/app/operations/api/commands', {
      data: {
        commandId,
        type: 'workitem.start',
        aggregate: { type: 'work_item', id: SEED_WORK_ITEM },
        payload: {},
      },
    });
    const body = (await response.json()) as {
      result?: { status?: string; errorCode?: string; message?: string };
    };
    const detail = `workitem.start respondió ${response.status()} → ${JSON.stringify(body.result)}`;
    // Nunca un 5xx: la cola offline reintenta los 5xx para siempre.
    expect(response.status(), detail).toBeLessThan(500);
    expect(body.result?.errorCode ?? '', detail).not.toBe('outside_command');
    expect(body.result?.errorCode ?? '', detail).not.toBe('internal_error');
    // Con la semilla recién plantada el trabajo está abierto y el comando pasa;
    // si esta suite ya corrió antes, el rechazo esperado es «ya está empezado».
    const outcome = `${body.result?.status}:${body.result?.errorCode ?? ''}`;
    expect(['completed:', 'rejected:invalid_state'], detail).toContain(outcome);
  });

  test('Neural Operations: sus cinco herramientas', async ({ page }) => {
    const issues = watchPage(page);
    for (const tool of NEURAL_TOOLS) {
      const query = tool === 'replay' || tool === 'simulacion' ? `?caso=${SEED_CASE}` : '';
      assertHealthy(
        await visit(
          page,
          `/app/admin/control-tower/neural/${tool}${query}`,
          WIDTHS,
          `neural-${tool}`
        ),
        issues
      );
    }
  });
});
