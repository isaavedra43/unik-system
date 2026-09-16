import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getArea } from '@/modules/areas/area-registry';
import { areaWorkBranches } from '@/modules/areas/area-server-registry';
import { manufacturaWorkRowBranches } from '@/modules/areas/manufactura/work-rows';
import { parseAreaWorkQuery } from '@/modules/areas/work-filters';
import { buildAreaWorkRowsSql, type AreaWorkRowRecord } from '@/modules/areas/work-rows-sql';
import { parseBranchActions } from '@/modules/areas/work-actions';

/**
 * The SQL of the Manufactura work rows, run against a REAL PostgreSQL.
 *
 * A branch is built with `Prisma.sql`, so TypeScript can say nothing about
 * whether Postgres accepts it: this suite executes it. It covers the parts that
 * only fail at runtime — the `UNION ALL` column alignment, the per-row action
 * catalogue (`jsonb_array_elements … WITH ORDINALITY`, `jsonb_exists`, the `||`
 * merge that adds the payload) and the filters and sorts over the area's extra
 * columns (`rows."extra" ->> 'workCenter'`).
 *
 * It SEEDS NOTHING and asserts no row content, so it tolerates the truncation
 * the other integration suites do: an empty plant is a perfectly valid answer.
 * What is being tested is that Postgres parses, plans and runs the statements.
 */

const DATABASE_READY = Boolean(process.env.UNIK_INTEGRATION_DATABASE_URL);
const NOW = new Date('2026-09-15T18:00:00.000Z');

const area = getArea('manufactura');

describe.skipIf(!DATABASE_READY)('SQL del centro de trabajo de Manufactura', () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  it('el área existe con sus dos tipos de fila propios', () => {
    expect(area).not.toBeNull();
    expect(area?.workCenter.rowKinds).toContain('production_order');
    expect(area?.workCenter.rowKinds).toContain('production_operation');
  });

  it('cada rama corre sola contra Postgres', async () => {
    for (const branch of manufacturaWorkRowBranches()) {
      const sql = branch.sql({ areaKey: 'manufactura', scope: 'open', now: NOW });
      const rows = await prisma.$queryRaw<AreaWorkRowRecord[]>(
        Prisma.sql`SELECT rows.* FROM (${sql}) AS rows LIMIT 5`
      );
      expect(Array.isArray(rows)).toBe(true);
    }
  });

  it('la UNIÓN de las ramas comunes y las de Manufactura alinea sus columnas', async () => {
    const branches = [...areaWorkBranches(area!), ...manufacturaWorkRowBranches()];
    // `areaWorkBranches` ya trae las de Manufactura cuando el registro cargó;
    // duplicarlas comprueba además que el UNION tolera ramas repetidas.
    const unique = new Map(branches.map((branch) => [branch.rowKind, branch]));
    const query = parseAreaWorkQuery({ scope: 'all', page_size: 10 }, area!);
    const { rows, count } = buildAreaWorkRowsSql({
      area: area!,
      branches: [...unique.values()],
      query,
      now: NOW,
    });
    const [data, totals] = await Promise.all([
      prisma.$queryRaw<AreaWorkRowRecord[]>(rows),
      prisma.$queryRaw<Array<{ count: number }>>(count),
    ]);
    expect(Array.isArray(data)).toBe(true);
    expect(Number(totals[0]?.count ?? 0)).toBeGreaterThanOrEqual(0);
  });

  it('filtra, busca y ordena por las columnas extra del área', async () => {
    const query = parseAreaWorkQuery(
      {
        scope: 'open',
        kind: ['production_order', 'production_operation'],
        // Comodines y comillas escritos por una persona viajan como parámetro.
        search: "100% _ ' \\",
        filters: {
          logic: 'AND',
          rules: [
            { field: 'extra.workCenter', operator: 'contains', value: 'corte' },
            { field: 'extra.plannedEndAt', operator: 'before', value: NOW.toISOString() },
          ],
        },
        sort: [
          { field: 'extra.plannedEndAt', direction: 'asc' },
          { field: 'dueAt', direction: 'desc' },
        ],
      },
      area!
    );
    const { rows } = buildAreaWorkRowsSql({
      area: area!,
      branches: manufacturaWorkRowBranches(),
      query,
      now: NOW,
    });
    const data = await prisma.$queryRaw<AreaWorkRowRecord[]>(rows);
    expect(Array.isArray(data)).toBe(true);
  });

  it('el catálogo de acciones se arma por fila y sobrevive a la validación del marco', async () => {
    // Se evalúa el mismo SELECT de acciones que lleva la rama, con un estado fijo.
    const branch = manufacturaWorkRowBranches().find(
      (entry) => entry.rowKind === 'production_order'
    );
    expect(branch).toBeDefined();
    const sql = branch!.sql({ areaKey: 'manufactura', scope: 'all', now: NOW });
    const rows = await prisma.$queryRaw<AreaWorkRowRecord[]>(
      Prisma.sql`SELECT rows."extra" FROM (${sql}) AS rows LIMIT 20`
    );
    for (const row of rows) {
      const actions = parseBranchActions((row.extra as Record<string, unknown> | null)?.actions);
      for (const action of actions) {
        // Todo comando de manufactura exige su propio id en el payload.
        expect(action.payload?.productionOrderId).toBeTruthy();
        expect(action.aggregateType).toBe('production_order');
      }
    }
  });

  it('una operación apunta su comando a la orden, no a sí misma', async () => {
    const branch = manufacturaWorkRowBranches().find(
      (entry) => entry.rowKind === 'production_operation'
    );
    const sql = branch!.sql({ areaKey: 'manufactura', scope: 'all', now: NOW });
    const rows = await prisma.$queryRaw<AreaWorkRowRecord[]>(
      Prisma.sql`SELECT rows."extra", rows."sourceId" FROM (${sql}) AS rows LIMIT 20`
    );
    for (const row of rows) {
      const extra = (row.extra as Record<string, unknown> | null) ?? {};
      const actions = parseBranchActions(extra.actions);
      for (const action of actions) {
        expect(action.aggregateId).toBe(extra.productionOrderId);
        expect(action.payload?.operationId).toBe(row.sourceId);
      }
    }
  });
});
