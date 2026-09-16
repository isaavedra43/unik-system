import { describe, expect, it } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * SQL del área Ventas (plan 7.3 y 7.4) contra una base PostgreSQL REAL con
 * todas las migraciones aplicadas.
 *
 * Por qué existe esta suite: las ramas del centro de trabajo y el panel son
 * `$queryRaw` armados con `Prisma.sql` (jsonb_build_object, índices de arreglos,
 * `CASE … WHEN` con literales parametrizados y un `UNION ALL` de 24 columnas).
 * Un nombre de columna equivocado o un orden distinto entre ramas es invisible
 * para TypeScript y para las pruebas unitarias: sólo falla el día que alguien
 * abre el área. Aquí se ejecutan de verdad.
 *
 * NO SIEMBRA NADA y no afirma cuántas filas hay: las demás suites truncan las
 * tablas operativas de esta base desechable, así que esta tiene que ser
 * indiferente a lo que haya. Una página vacía es un éxito; un error de SQL es
 * una falla.
 *
 * Corre sólo con UNIK_INTEGRATION_DATABASE_URL (`npm run test:integration`).
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;
if (!integrationUrl) {
  console.warn(
    '[integration] Se omite el SQL del área Ventas: define UNIK_INTEGRATION_DATABASE_URL con una base ' +
      'PostgreSQL local y desechable con todas las migraciones aplicadas (por ejemplo unik_schema_check).'
  );
}

describeDb('área Ventas · SQL contra PostgreSQL', () => {
  const NOW = new Date('2026-09-15T18:00:00.000Z');

  /** El módulo del área registra sus ramas y su panel al importarse. */
  async function load() {
    await import('@/modules/areas/ventas/register');
    const { prisma } = await import('@/lib/prisma');
    const { AREA_REGISTRY } = await import('@/modules/areas/area-registry');
    const { areaWorkBranches, getAreaServer } =
      await import('@/modules/areas/area-server-registry');
    const { buildAreaWorkRowsSql } = await import('@/modules/areas/work-rows-sql');
    const { parseAreaWorkQuery } = await import('@/modules/areas/work-filters');
    const area = AREA_REGISTRY.ventas;
    return {
      prisma,
      area,
      branches: areaWorkBranches(area),
      server: getAreaServer('ventas'),
      buildAreaWorkRowsSql,
      parseAreaWorkQuery,
    };
  }

  /** Ejecuta un estado de consulta y devuelve la página y el total, ambos de la base. */
  async function run(raw: Record<string, unknown>) {
    const { prisma, area, branches, buildAreaWorkRowsSql, parseAreaWorkQuery } = await load();
    const query = parseAreaWorkQuery(raw, area);
    const { rows, count } = buildAreaWorkRowsSql({ area, branches, query, now: NOW });
    const [page, totals] = await Promise.all([
      prisma.$queryRaw<Array<Record<string, unknown>>>(rows),
      prisma.$queryRaw<Array<{ count: number }>>(count),
    ]);
    return { page, total: Number(totals[0]?.count ?? 0) };
  }

  it('registra las tres ramas de Ventas además de las comunes', async () => {
    const { branches, server } = await load();
    expect(branches.map((branch) => branch.rowKind).sort()).toStrictEqual(
      ['case', 'opportunity', 'quote', 'request_in', 'request_out', 'work_item'].sort()
    );
    expect(typeof server.loadDashboard).toBe('function');
    expect(typeof server.getRowDetail).toBe('function');
  });

  const kinds = ['work_item', 'request_in', 'request_out', 'case', 'opportunity', 'quote'] as const;

  it.each(kinds)('la rama %s se ejecuta y devuelve las columnas canónicas', async (kind) => {
    const { page, total } = await run({ kind: [kind], scope: 'all', page_size: 5 });
    expect(Array.isArray(page)).toBe(true);
    expect(Number.isFinite(total)).toBe(true);
    for (const row of page) {
      expect(row.rowKind).toBe(kind);
      expect(typeof row.sourceId).toBe('string');
      expect(typeof row.title).toBe('string');
      expect(typeof row.status).toBe('string');
      expect(typeof row.open).toBe('boolean');
      expect(row.extra === null || typeof row.extra === 'object').toBe(true);
    }
  });

  it.each(['open', 'closed', 'all'] as const)(
    'el UNION ALL de las seis ramas corre con scope %s',
    async (scope) => {
      const { page, total } = await run({ scope, page_size: 25 });
      expect(Array.isArray(page)).toBe(true);
      expect(Number.isFinite(total)).toBe(true);
    }
  );

  it('ordena y busca sobre el UNION sin romper el orden estable', async () => {
    const { page } = await run({
      scope: 'all',
      search: 'a',
      sort: [
        { field: 'dueAt', direction: 'asc' },
        { field: 'lastActivityAt', direction: 'desc' },
      ],
      page_size: 10,
    });
    expect(Array.isArray(page)).toBe(true);
  });

  it('filtra por las columnas extra del registro (jsonb) con sus tipos reales', async () => {
    // `extra.promisedAt` se castea a timestamptz y `extra.phase` a texto: si el
    // jsonb no trae lo que el registro declara, Postgres falla aquí.
    const byDate = await run({
      scope: 'all',
      kind: ['case'],
      filters: {
        logic: 'AND',
        rules: [{ field: 'extra.promisedAt', operator: 'after', value: '2020-01-01' }],
      },
      page_size: 5,
    });
    expect(Array.isArray(byDate.page)).toBe(true);

    const byPhase = await run({
      scope: 'all',
      kind: ['case'],
      filters: {
        logic: 'AND',
        rules: [{ field: 'extra.phase', operator: 'contains', value: 'Planeación' }],
      },
      page_size: 5,
    });
    expect(Array.isArray(byPhase.page)).toBe(true);

    const sorted = await run({
      scope: 'all',
      kind: ['case'],
      sort: [{ field: 'extra.promisedAt', direction: 'desc' }],
      page_size: 5,
    });
    expect(Array.isArray(sorted.page)).toBe(true);
  });

  it('acota las filas de un expediente y de una persona sin romper ninguna rama', async () => {
    const byCase = await run({ scope: 'all', caseId: 'no-existe', page_size: 5 });
    expect(byCase.total).toBe(0);
    const byOwner = await run({ scope: 'open', ownerUserId: 'no-existe', page_size: 5 });
    expect(Number.isFinite(byOwner.total)).toBe(true);
  });

  it('el panel de Ventas se calcula contra la base y respeta el contrato del plan', async () => {
    const { area, server } = await load();
    const actor: CurrentUser = {
      id: 'it-ventas-actor',
      username: 'it-ventas',
      name: 'Integración Ventas',
      email: null,
      mustChangePassword: false,
      roleKeys: [],
      permissionKeys: [],
      isSuperAdmin: true,
    };
    const payload = await server.loadDashboard!(actor, area, { now: NOW });

    expect(payload.areaKey).toBe('ventas');
    expect(payload.source).toBe('live');
    expect(payload.tiles).toHaveLength(8);
    expect(payload.charts).toHaveLength(2);
    expect(payload.alerts.length).toBeLessThanOrEqual(6);
    expect(payload.tiles.filter((tile) => tile.live).length).toBeLessThanOrEqual(3);
    for (const tile of payload.tiles) {
      expect(typeof tile.value).toBe('string');
      expect(tile.value.length).toBeGreaterThan(0);
    }
    const [trend, phases] = payload.charts;
    expect(trend.kind).toBe('trend');
    if (trend.kind === 'trend') {
      // 30 días de serie continua, incluido hoy.
      expect(trend.data).toHaveLength(30);
      expect(trend.series.map((serie) => serie.key)).toStrictEqual(['creados', 'cerrados']);
    }
    expect(phases.kind).toBe('status');
  });
});
