import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/prisma';
import { getArea } from '@/modules/areas/area-registry';
import { inventoryWorkRowBranches } from '@/modules/areas/inventario/work-rows';
import { parseAreaWorkQuery } from '@/modules/areas/work-filters';
import { buildAreaWorkRowsSql, type AreaWorkRowRecord } from '@/modules/areas/work-rows-sql';
import { parseBranchActions } from '@/modules/areas/work-actions';

/**
 * The SQL of the Inventario work rows, run against a REAL PostgreSQL.
 *
 * A branch is built with `Prisma.sql`, so TypeScript can say nothing about
 * whether Postgres accepts it: a wrong column name, a `jsonb_build_object` with
 * an odd number of arguments or a column list that does not line up across the
 * `UNION ALL` only fails the day somebody opens the area. This suite runs every
 * branch, the union of all of them and the filters over the area's own extra
 * columns (`extra.sku`, `extra.confidence`).
 *
 * It was written with the `legacy_claim` branch (plan §3.3 "corte"), the first
 * branch the area got after the visual pass, and it covers the other five too.
 *
 * It seeds ONLY its own rows (all of them prefixed `int-inv-`) and removes them
 * at the end, and it asserts nothing about rows it did not write: the other
 * integration suites truncate these tables, so anything else that is (or is
 * not) there has to be irrelevant.
 */

const DATABASE_READY = Boolean(process.env.UNIK_INTEGRATION_DATABASE_URL);
const NOW = new Date('2026-09-15T18:00:00.000Z');

const area = getArea('inventario');

const WAREHOUSE_ID = 'int-inv-wh';
const ITEM_ID = 'int-inv-item';
const OPEN_CLAIM_ID = 'int-inv-claim-open';
const CLOSED_CLAIM_ID = 'int-inv-claim-released';
const UNDECIDED_COUNT_ID = 'int-inv-count-undecided';
const SETTLED_COUNT_ID = 'int-inv-count-settled';

describe.skipIf(!DATABASE_READY)('SQL del centro de trabajo de Inventario', () => {
  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
    await cleanUp();
    await prisma.warehouse.create({
      data: { id: WAREHOUSE_ID, key: 'int-inv', name: 'Bodega de integración' },
    });
    await prisma.product.create({
      data: {
        zohoItemId: ITEM_ID,
        name: 'Loseta de integración',
        sku: 'INT-LOS',
        unit: 'M2',
        sourceRemoteModifiedAt: NOW,
        sourceSnapshotId: 'int-inv-snapshot',
      },
    });
    await prisma.productInventoryProfile.create({
      data: { zohoItemId: ITEM_ID, baseUnit: 'm2', confidence: 'CONTROLLED' },
    });
    await prisma.legacyCommitmentClaim.createMany({
      data: [
        {
          id: OPEN_CLAIM_ID,
          zohoItemId: ITEM_ID,
          warehouseId: WAREHOUSE_ID,
          quantity: new Prisma.Decimal(25),
          unit: 'm2',
          source: 'pre_cutover_order',
          reference: 'SO-9001 (antes del corte)',
          status: 'claimed',
          claimedBy: 'int-inv-user',
          expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
        },
        {
          id: CLOSED_CLAIM_ID,
          zohoItemId: ITEM_ID,
          warehouseId: WAREHOUSE_ID,
          quantity: new Prisma.Decimal(5),
          unit: 'm2',
          source: 'verbal',
          status: 'released',
          claimedBy: 'int-inv-user',
          expiresAt: new Date(NOW.getTime() + 86_400_000),
          resolvedAt: NOW,
        },
      ],
    });
    // Dos conteos CERRADOS: uno con diferencias sin decidir (sigue siendo
    // trabajo) y otro con todo resuelto (ya no lo es).
    await prisma.stockCount.createMany({
      data: [
        {
          id: UNDECIDED_COUNT_ID,
          warehouseId: WAREHOUSE_ID,
          scope: 'spot',
          status: 'closed',
          startedBy: 'int-inv-user',
          closedAt: NOW,
        },
        {
          id: SETTLED_COUNT_ID,
          warehouseId: WAREHOUSE_ID,
          scope: 'spot',
          status: 'closed',
          startedBy: 'int-inv-user',
          closedAt: NOW,
        },
      ],
    });
    await prisma.stockCountLine.createMany({
      data: [
        {
          countId: UNDECIDED_COUNT_ID,
          stockItemId: 'int-inv-stock-1',
          expectedQty: new Prisma.Decimal(100),
          countedQty: new Prisma.Decimal(101),
          unit: 'm2',
          diffQty: new Prisma.Decimal(1),
          withinTolerance: true,
          resolution: 'pending',
          countedBy: 'int-inv-user',
        },
        {
          countId: UNDECIDED_COUNT_ID,
          stockItemId: 'int-inv-stock-2',
          expectedQty: new Prisma.Decimal(100),
          countedQty: new Prisma.Decimal(150),
          unit: 'm2',
          diffQty: new Prisma.Decimal(50),
          withinTolerance: false,
          resolution: 'disputed',
          countedBy: 'int-inv-user',
        },
        {
          countId: SETTLED_COUNT_ID,
          stockItemId: 'int-inv-stock-1',
          expectedQty: new Prisma.Decimal(100),
          countedQty: new Prisma.Decimal(100),
          unit: 'm2',
          diffQty: new Prisma.Decimal(0),
          withinTolerance: true,
          resolution: 'accepted',
          countedBy: 'int-inv-user',
        },
      ],
    });
  });

  afterAll(cleanUp);

  async function cleanUp(): Promise<void> {
    await prisma.stockCountLine.deleteMany({
      where: { countId: { in: [UNDECIDED_COUNT_ID, SETTLED_COUNT_ID] } },
    });
    await prisma.stockCount.deleteMany({
      where: { id: { in: [UNDECIDED_COUNT_ID, SETTLED_COUNT_ID] } },
    });
    await prisma.legacyCommitmentClaim.deleteMany({
      where: { id: { in: [OPEN_CLAIM_ID, CLOSED_CLAIM_ID] } },
    });
    await prisma.productInventoryProfile.deleteMany({ where: { zohoItemId: ITEM_ID } });
    await prisma.product.deleteMany({ where: { zohoItemId: ITEM_ID } });
    await prisma.storageLocation.deleteMany({ where: { warehouseId: WAREHOUSE_ID } });
    await prisma.warehouse.deleteMany({ where: { id: WAREHOUSE_ID } });
  }

  it('el área declara sus cinco tipos de fila propios', () => {
    expect(area).not.toBeNull();
    for (const kind of ['verification', 'stock_count', 'reservation', 'movement', 'legacy_claim']) {
      expect(area?.workCenter.rowKinds, kind).toContain(kind);
    }
  });

  it('cada rama corre sola contra Postgres, abierta y cerrada', async () => {
    for (const branch of inventoryWorkRowBranches()) {
      for (const scope of ['open', 'closed', 'all'] as const) {
        const sql = branch.sql({ areaKey: 'inventario', scope, now: NOW });
        const rows = await prisma.$queryRaw<AreaWorkRowRecord[]>(
          Prisma.sql`SELECT rows.* FROM (${sql}) AS rows LIMIT 5`
        );
        expect(Array.isArray(rows), `${branch.rowKind}/${scope}`).toBe(true);
      }
    }
  });

  it('la UNIÓN de las seis ramas alinea sus columnas y cuenta', async () => {
    const query = parseAreaWorkQuery({ scope: 'all', page_size: 10 }, area!);
    const { rows, count } = buildAreaWorkRowsSql({
      area: area!,
      branches: inventoryWorkRowBranches(),
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
        kind: ['legacy_claim', 'stock_count', 'reservation'],
        // Comodines y comillas escritos por una persona viajan como parámetro.
        search: "100% _ ' \\",
        filters: {
          logic: 'AND',
          rules: [
            { field: 'extra.sku', operator: 'contains', value: 'LOS' },
            { field: 'extra.confidence', operator: 'equals', value: 'DISPUTED' },
          ],
        },
        sort: [
          { field: 'dueAt', direction: 'asc' },
          { field: 'lastActivityAt', direction: 'desc' },
        ],
      },
      area!
    );
    const { rows } = buildAreaWorkRowsSql({
      area: area!,
      branches: inventoryWorkRowBranches(),
      query,
      now: NOW,
    });
    const data = await prisma.$queryRaw<AreaWorkRowRecord[]>(rows);
    expect(Array.isArray(data)).toBe(true);
  });

  it('un compromiso previo abierto ofrece liberarse, con su id en el payload', async () => {
    const branch = inventoryWorkRowBranches().find((entry) => entry.rowKind === 'legacy_claim');
    expect(branch).toBeDefined();
    const sql = branch!.sql({ areaKey: 'inventario', scope: 'all', now: NOW });
    const rows = await prisma.$queryRaw<AreaWorkRowRecord[]>(
      Prisma.sql`SELECT rows.* FROM (${sql}) AS rows WHERE rows."sourceId" IN (${OPEN_CLAIM_ID}, ${CLOSED_CLAIM_ID})`
    );
    expect(rows).toHaveLength(2);

    const open = rows.find((row) => row.sourceId === OPEN_CLAIM_ID)!;
    const extra = (open.extra as Record<string, unknown> | null) ?? {};
    expect(open.status).toBe('claimed');
    expect(open.open).toBe(true);
    expect(open.title).toBe('Compromiso previo · Loseta de integración');
    expect(open.counterpartyName).toBe('Bodega de integración');
    expect(Number(open.quantity)).toBe(25);
    expect(extra).toMatchObject({
      statusLabel: 'Reclamado',
      sourceLabel: 'Orden anterior al corte',
      reference: 'SO-9001 (antes del corte)',
      sku: 'INT-LOS',
      unit: 'm2',
      confidence: 'CONTROLLED',
      warehouseName: 'Bodega de integración',
    });
    // Vence con su TTL: es lo que el centro de trabajo muestra como fecha límite.
    expect(open.dueAt).not.toBeNull();

    const actions = parseBranchActions(extra.actions);
    expect(actions).toHaveLength(1);
    expect(actions[0].commandType).toBe('stock.release_legacy');
    expect(actions[0].aggregateType).toBe('legacy_claim');
    expect(actions[0].payload?.claimId).toBe(OPEN_CLAIM_ID);

    // Un compromiso ya resuelto no ofrece nada y no cuenta como abierto.
    const closed = rows.find((row) => row.sourceId === CLOSED_CLAIM_ID)!;
    expect(closed.open).toBe(false);
    expect(closed.dueAt).toBeNull();
    expect(
      parseBranchActions((closed.extra as Record<string, unknown> | null)?.actions)
    ).toStrictEqual([]);
  });

  it('el alcance "abiertos" deja fuera los compromisos ya resueltos', async () => {
    const branch = inventoryWorkRowBranches().find((entry) => entry.rowKind === 'legacy_claim');
    const sql = branch!.sql({ areaKey: 'inventario', scope: 'open', now: NOW });
    const rows = await prisma.$queryRaw<AreaWorkRowRecord[]>(
      Prisma.sql`SELECT rows."sourceId" FROM (${sql}) AS rows WHERE rows."sourceId" IN (${OPEN_CLAIM_ID}, ${CLOSED_CLAIM_ID})`
    );
    expect(rows.map((row) => row.sourceId)).toStrictEqual([OPEN_CLAIM_ID]);
  });

  it('un conteo cerrado con diferencias sin decidir sigue apareciendo en «abiertos»', async () => {
    const branch = inventoryWorkRowBranches().find((entry) => entry.rowKind === 'stock_count');
    const sql = branch!.sql({ areaKey: 'inventario', scope: 'open', now: NOW });
    const rows = await prisma.$queryRaw<AreaWorkRowRecord[]>(
      Prisma.sql`SELECT rows.* FROM (${sql}) AS rows WHERE rows."sourceId" IN (${UNDECIDED_COUNT_ID}, ${SETTLED_COUNT_ID})`
    );
    // El que ya se resolvió se queda fuera; el que espera decisión, no.
    expect(rows.map((row) => row.sourceId)).toStrictEqual([UNDECIDED_COUNT_ID]);

    const extra = (rows[0].extra as Record<string, unknown> | null) ?? {};
    expect(rows[0].status).toBe('closed');
    expect(extra).toMatchObject({ pendingLines: 1, disputedLines: 1, decisionsPending: 2 });
    // Cerrar y cancelar ya no aplican: la decisión se toma en el panel del conteo.
    expect(parseBranchActions(extra.actions)).toStrictEqual([]);
    expect(rows[0].dueAt).toBeNull();
  });

  it('un conteo abierto ofrece cerrarse y cancelarse, con su id en el payload', async () => {
    const branch = inventoryWorkRowBranches().find((entry) => entry.rowKind === 'stock_count');
    const sql = branch!.sql({ areaKey: 'inventario', scope: 'open', now: NOW });
    // Sólo los que siguen en captura: un conteo cerrado aparece en «abiertos»
    // cuando le quedan diferencias, pero ya no se cierra ni se cancela.
    const rows = await prisma.$queryRaw<AreaWorkRowRecord[]>(
      Prisma.sql`SELECT rows."extra", rows."sourceId" FROM (${sql}) AS rows
                  WHERE rows."status" IN ('draft', 'in_progress') LIMIT 20`
    );
    for (const row of rows) {
      const actions = parseBranchActions((row.extra as Record<string, unknown> | null)?.actions);
      expect(actions.map((action) => action.commandType).sort()).toStrictEqual([
        'stock.count.cancel',
        'stock.count.close',
      ]);
      for (const action of actions) expect(action.payload?.countId).toBe(row.sourceId);
    }
  });
});
