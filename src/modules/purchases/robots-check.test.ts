import { describe, expect, it, vi } from 'vitest';
import {
  RobotsGuard,
  SOURCING_USER_AGENT,
  isPathAllowed,
  looksLikeCaptcha,
  parseRobotsTxt,
  robotsAvailabilityForStatus,
  selectRobotsGroup,
  redirectTarget,
  turnWaitMs,
  type HostSlotStore,
} from './robots-check';

const ROBOTS = `
# comentario
User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.pdf$
Crawl-delay: 1

User-agent: UNIKSourcingBot
User-agent: otrobot
Disallow: /solo-humanos
Allow: /page
Disallow: /page
Crawl-delay: 5
`;

describe('parseRobotsTxt / selectRobotsGroup', () => {
  it('agrupa agentes consecutivos y sus reglas', () => {
    const groups = parseRobotsTxt(ROBOTS);
    expect(groups).toHaveLength(2);
    expect(groups[1].agents).toEqual(['uniksourcingbot', 'otrobot']);
    expect(groups[1].crawlDelaySeconds).toBe(5);
    expect(selectRobotsGroup(groups, SOURCING_USER_AGENT)?.agents).toEqual(['uniksourcingbot', 'otrobot']);
    expect(selectRobotsGroup(groups, 'Mozilla/5.0')?.agents).toEqual(['*']);
  });

  it('un Disallow vacío no agrega regla', () => {
    const groups = parseRobotsTxt('User-agent: *\nDisallow:\n');
    expect(groups[0].rules).toEqual([]);
    expect(isPathAllowed(groups, 'x', '/lo-que-sea')).toBe(true);
  });
});

describe('isPathAllowed', () => {
  const groups = parseRobotsTxt(ROBOTS);
  const other = 'Mozilla/5.0';

  it('la regla más larga decide y Allow gana el empate', () => {
    expect(isPathAllowed(groups, other, '/private/x')).toBe(false);
    expect(isPathAllowed(groups, other, '/private/public/a')).toBe(true);
    expect(isPathAllowed(groups, SOURCING_USER_AGENT, '/page')).toBe(true);
  });

  it('soporta comodines y fin de ruta', () => {
    expect(isPathAllowed(groups, other, '/docs/catalogo.pdf')).toBe(false);
    expect(isPathAllowed(groups, other, '/docs/catalogo.pdf?v=2')).toBe(true);
  });

  it('el grupo específico sustituye al genérico y robots.txt siempre se puede leer', () => {
    expect(isPathAllowed(groups, SOURCING_USER_AGENT, '/private/x')).toBe(true);
    expect(isPathAllowed(groups, SOURCING_USER_AGENT, '/solo-humanos/1')).toBe(false);
    expect(isPathAllowed(groups, other, '/robots.txt')).toBe(true);
    expect(isPathAllowed([], other, '/cualquier')).toBe(true);
  });
});

describe('disponibilidad y CAPTCHA', () => {
  it('RFC 9309: 2xx se interpreta, 4xx permite, 5xx o red lo prohíbe todo', () => {
    expect(robotsAvailabilityForStatus(200)).toBe('parse');
    expect(robotsAvailabilityForStatus(404)).toBe('allow_all');
    expect(robotsAvailabilityForStatus(503)).toBe('disallow_all');
    expect(robotsAvailabilityForStatus(null)).toBe('disallow_all');
  });

  it('detecta retos anti-robot y nunca los resuelve', () => {
    expect(looksLikeCaptcha(403, '<title>Attention Required! | Cloudflare</title>')).toBe(true);
    expect(looksLikeCaptcha(429, 'Access denied')).toBe(true);
    expect(looksLikeCaptcha(200, '<div class="g-recaptcha" data-sitekey="x"></div>')).toBe(true);
    expect(looksLikeCaptcha(200, '<html><body>Porcelanato 60x60 $200 m2</body></html>')).toBe(false);
    expect(looksLikeCaptcha(200, `${'contenido '.repeat(10_000)} captcha`)).toBe(false);
  });

  it('turnWaitMs cuenta desde la última petición real, no desde cubetas fijas', () => {
    expect(turnWaitMs(null, 1_000)).toBe(0);
    expect(turnWaitMs(Date.parse('2026-09-15T10:00:01.900Z'), Date.parse('2026-09-15T10:00:02.001Z'))).toBe(1899);
    expect(turnWaitMs(0, 2_000)).toBe(0);
    expect(turnWaitMs(0, 1_000, 5_000)).toBe(4_000);
    expect(turnWaitMs(Number.NaN, 10)).toBe(0);
  });

  it('redirectTarget sólo sigue https a sitios autorizados', () => {
    const allowed = (host: string) => host === 'catalogo.mx' || host.endsWith('.catalogo.mx');
    expect(redirectTarget('https://catalogo.mx/a', '/b?x=1', allowed)).toBe('https://catalogo.mx/b?x=1');
    expect(redirectTarget('https://catalogo.mx/a', 'https://www.catalogo.mx/c', allowed)).toBe('https://www.catalogo.mx/c');
    expect(redirectTarget('https://catalogo.mx/a', 'http://catalogo.mx/b', allowed)).toBeNull();
    expect(redirectTarget('https://catalogo.mx/a', 'https://otro.mx/b', allowed)).toBeNull();
    expect(redirectTarget('https://catalogo.mx/a', null, allowed)).toBeNull();
    expect(redirectTarget('https://catalogo.mx/a', 'https://[::1', allowed)).toBeNull();
  });
});

describe('RobotsGuard', () => {
  it('lee robots.txt una vez por origen y aplica el crawl-delay (mínimo 2 s)', async () => {
    const fetchRobots = vi.fn(async () => ({ status: 200, body: ROBOTS }));
    const guard = new RobotsGuard({ fetchRobots, slots: { claimTurn: async () => ({ granted: true, waitMs: 0 }) } });
    expect(await guard.check('https://proveedor.mx/private/x')).toMatchObject({ allowed: true, crawlDelayMs: 5000 });
    expect(await guard.check('https://proveedor.mx/solo-humanos')).toMatchObject({ allowed: false, reason: 'robots_disallowed' });
    expect(fetchRobots).toHaveBeenCalledTimes(1);
    expect(fetchRobots).toHaveBeenCalledWith('https://proveedor.mx/robots.txt');
  });

  it('robots.txt inalcanzable prohíbe; ausente permite; URL inválida se rechaza', async () => {
    const unreachable = new RobotsGuard({ fetchRobots: async () => { throw new Error('dns'); }, slots: { claimTurn: async () => ({ granted: true, waitMs: 0 }) } });
    expect(await unreachable.check('https://caido.mx/x')).toMatchObject({ allowed: false, reason: 'robots_unreachable' });
    const missing = new RobotsGuard({ fetchRobots: async () => ({ status: 404, body: '' }), slots: { claimTurn: async () => ({ granted: true, waitMs: 0 }) } });
    expect(await missing.check('https://sinrobots.mx/x')).toMatchObject({ allowed: true, crawlDelayMs: 2000 });
    expect(await missing.check('no-url')).toMatchObject({ allowed: false, reason: 'invalid_url' });
  });

  it('acquireSlot separa dos peticiones al menos el intervalo, aunque caigan en segundos distintos, y se rinde al exceder la espera', async () => {
    let clock = Date.parse('2026-09-15T10:00:01.900Z');
    let last: number | null = null;
    const granted: number[] = [];
    const store: HostSlotStore = {
      claimTurn: async (_host, intervalMs, now) => {
        const wait = turnWaitMs(last, now.getTime(), intervalMs);
        if (wait > 0) return { granted: false, waitMs: wait };
        last = now.getTime();
        granted.push(last);
        return { granted: true, waitMs: 0 };
      },
    };
    const guard = new RobotsGuard({
      fetchRobots: async () => ({ status: 404, body: '' }),
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      slots: store,
    });
    expect(await guard.acquireSlot('Proveedor.MX')).toBe(true);
    clock += 150;
    expect(await guard.acquireSlot('proveedor.mx')).toBe(true);
    expect(granted).toHaveLength(2);
    expect(granted[1] - granted[0]).toBeGreaterThanOrEqual(2_000);

    const busy = new RobotsGuard({
      fetchRobots: async () => ({ status: 404, body: '' }),
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      slots: { claimTurn: async () => ({ granted: false, waitMs: 2_000 }) },
    });
    expect(await busy.acquireSlot('lleno.mx', 2000, 5000)).toBe(false);
  });

  it('robots.txt también espera su turno del host; si sigue ocupado no se consulta ni se guarda', async () => {
    const claims: string[] = [];
    let free = false;
    const fetchRobots = vi.fn(async () => ({ status: 200, body: ROBOTS }));
    let clock = Date.parse('2026-09-15T10:00:00.000Z');
    const guard = new RobotsGuard({
      fetchRobots,
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      slots: {
        claimTurn: async (host) => {
          claims.push(host);
          return free ? { granted: true, waitMs: 0 } : { granted: false, waitMs: 25_000 };
        },
      },
    });
    expect(await guard.check('https://proveedor.mx/x')).toMatchObject({ allowed: false, reason: 'robots_unreachable' });
    expect(fetchRobots).not.toHaveBeenCalled();
    free = true;
    expect(await guard.check('https://proveedor.mx/x')).toMatchObject({ allowed: true });
    expect(fetchRobots).toHaveBeenCalledTimes(1);
    expect(claims.every((host) => host === 'proveedor.mx')).toBe(true);
  });
});
