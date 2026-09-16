import { describe, expect, it } from 'vitest';

/**
 * SQL of the Compras work centre (plan 7.4) against a REAL PostgreSQL database
 * with every migration applied.
 *
 * Why this suite exists: the branches of an area are `$queryRaw` built with
 * `Prisma.sql`, so a wrong column name, a broken LATERAL or a column list that
 * does not line up across the `UNION ALL` is invisible to TypeScript and to the
 * unit tests — it only fails the day somebody opens the area. Here every branch,
 * every scope, the filters, the sorting and the search are actually executed.
 *
 * It SEEDS NOTHING and asserts nothing about the number of rows: the other
 * integration suites truncate the operational tables of this disposable
 * database, so this one has to be indifferent to what is (or is not) there. An
 * empty result is a pass; a SQL error is a failure.
 *
 * Runs only when UNIK_INTEGRATION_DATABASE_URL is set (`npm run test:integration`).
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;
if (!integrationUrl) {
  console.warn(
    '[integration] Se omite el SQL del centro de trabajo de Compras: define UNIK_INTEGRATION_DATABASE_URL ' +
      'con una base PostgreSQL local y desechable con todas las migraciones aplicadas (por ejemplo unik_schema_check).'
  );
}

describeDb('centro de trabajo de Compras · SQL contra PostgreSQL', () => {
  const NOW = new Date('2026-09-15T18:00:00.000Z');

  /** The area module registers its branches when it is imported. */
  async function load() {
    await import('@/modules/areas/compras/register');
    const { prisma } = await import('@/lib/prisma');
    const { AREA_REGISTRY } = await import('@/modules/areas/area-registry');
    const { areaWorkBranches } = await import('@/modules/areas/area-server-registry');
    const { buildAreaWorkRowsSql } = await import('@/modules/areas/work-rows-sql');
    const { parseAreaWorkQuery } = await import('@/modules/areas/work-filters');
    const area = AREA_REGISTRY.compras;
    return {
      prisma,
      area,
      branches: areaWorkBranches(area),
      buildAreaWorkRowsSql,
      parseAreaWorkQuery,
    };
  }

  /** Runs a query state and returns the page and the total, both from the database. */
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

  it('registra las cinco ramas de Compras además de las comunes', async () => {
    const { branches } = await load();
    const kinds = branches.map((branch) => branch.rowKind).sort();
    expect(kinds).toStrictEqual(
      [
        'goods_receipt',
        'procurement_order',
        'purchase_request',
        'request_in',
        'request_out',
        'rfq',
        'supplier',
        'work_item',
      ].sort()
    );
  });

  const kinds = [
    'work_item',
    'request_in',
    'request_out',
    'purchase_request',
    'rfq',
    'procurement_order',
    'goods_receipt',
    'supplier',
  ] as const;

  it.each(kinds)('la rama %s se ejecuta y devuelve las columnas canónicas', async (kind) => {
    const { page, total } = await run({ kind: [kind], scope: 'all', page_size: 5 });
    expect(Array.isArray(page)).toBe(true);
    expect(Number.isFinite(total)).toBe(true);
    for (const row of page) {
      expect(row.rowKind).toBe(kind);
      expect(typeof row.sourceId).toBe('string');
      expect(typeof row.title).toBe('string');
      expect(typeof row.status).toBe('string');
      expect(row.lastActivityAt).toBeInstanceOf(Date);
      expect(typeof row.open).toBe('boolean');
      expect(row.extra === null || typeof row.extra === 'object').toBe(true);
    }
  });

  it.each(['open', 'closed', 'all'] as const)(
    'el alcance %s une todas las ramas',
    async (scope) => {
      const { page, total } = await run({ scope, page_size: 10 });
      expect(Array.isArray(page)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(0);
      if (scope === 'open') for (const row of page) expect(row.open).toBe(true);
      if (scope === 'closed') for (const row of page) expect(row.open).toBe(false);
    }
  );

  it('ordena por vencimiento y por las columnas extra del área', async () => {
    await expect(
      run({ scope: 'all', sort: [{ field: 'dueAt', direction: 'asc' }] })
    ).resolves.toBeDefined();
    await expect(
      run({ scope: 'all', sort: [{ field: 'extra.expectedAt', direction: 'desc' }] })
    ).resolves.toBeDefined();
    await expect(
      run({ scope: 'all', sort: [{ field: 'extra.vendorName', direction: 'asc' }] })
    ).resolves.toBeDefined();
  });

  it('filtra por las columnas extra declaradas por Compras', async () => {
    await expect(
      run({
        scope: 'all',
        filters: {
          logic: 'AND',
          rules: [{ field: 'extra.vendorName', operator: 'contains', value: 'acero' }],
        },
      })
    ).resolves.toBeDefined();
    await expect(
      run({
        scope: 'all',
        filters: {
          logic: 'AND',
          rules: [{ field: 'extra.expectedAt', operator: 'before', value: NOW.toISOString() }],
        },
      })
    ).resolves.toBeDefined();
  });

  it('trata los comodines y las comillas del buscador como texto literal', async () => {
    // `%`, `_` and a quote typed by a person must not change the query nor break it.
    await expect(run({ scope: 'all', search: "100% _ ' acero" })).resolves.toBeDefined();
    const { total } = await run({ scope: 'all', search: '%' });
    expect(total).toBe(0);
  });

  it('acota por expediente y por persona sin romper las ramas sin dueño', async () => {
    await expect(run({ scope: 'all', caseId: 'no-existe' })).resolves.toBeDefined();
    const byCase = await run({ scope: 'all', caseId: 'no-existe' });
    expect(byCase.total).toBe(0);
    await expect(run({ scope: 'all', ownerUserId: 'no-existe' })).resolves.toBeDefined();
  });

  it('pagina de forma estable', async () => {
    const first = await run({ scope: 'all', page: 1, page_size: 3 });
    const second = await run({ scope: 'all', page: 2, page_size: 3 });
    expect(first.total).toBe(second.total);
    const ids = new Set(first.page.map((row) => `${row.rowKind}:${row.sourceId}`));
    for (const row of second.page) {
      expect(ids.has(`${row.rowKind}:${row.sourceId}`)).toBe(false);
    }
  });

  /**
   * Las acciones de dominio (plan 7.4) las arma la rama SQL dentro de
   * `extra.actions`: el catálogo viaja como UN parámetro ligado y tanto el
   * filtro por estado como la regla de negocio de cada acción corren DENTRO de
   * Postgres. Nada de eso lo ve TypeScript, así que se prueba aquí, contra la
   * base de verdad.
   *
   * Esta prueba SIEMBRA sus propias filas con un folio único y las borra al
   * final, de modo que el resto de la suite sigue siendo indiferente a lo que
   * haya en la base.
   */
  it('las filas de dominio llegan con las acciones que su estado y su negocio permiten', async () => {
    const { prisma } = await load();
    const tag = `T${Date.now().toString(36).toUpperCase()}`;
    const actor = `it-compras-${tag}`;
    const ids: { supplier?: string; draft?: string; received?: string; receipt?: string } = {};

    /** `extra.actions` de una fila concreta, leída por el mismo SQL del área. */
    async function actionsOf(
      kind: string,
      sourceId: string
    ): Promise<Array<Record<string, unknown>>> {
      const { page } = await run({ kind: [kind], scope: 'all', search: tag, page_size: 20 });
      const found = page.find((row) => row.sourceId === sourceId);
      expect(found, `${kind}:${sourceId}`).toBeDefined();
      const extra = found!.extra as Record<string, unknown>;
      return (extra.actions ?? []) as Array<Record<string, unknown>>;
    }

    try {
      const supplier = await prisma.supplier.create({
        data: {
          number: `PRV-${tag}`,
          name: `Proveedor ${tag}`,
          paymentMode: 'credit',
          createdByUserId: actor,
        },
      });
      ids.supplier = supplier.id;

      // Borrador con una partida y total > 0: se puede firmar y cancelar.
      const draft = await prisma.procurementOrder.create({
        data: {
          number: `OC-${tag}-A`,
          supplierId: supplier.id,
          status: 'draft',
          paymentMode: 'credit',
          total: 1000,
          subtotal: 1000,
          createdByUserId: actor,
          lines: {
            create: [
              {
                description: `Partida ${tag}`,
                qty: 10,
                unit: 'pza',
                unitPrice: 100,
                lineTotal: 1000,
              },
            ],
          },
        },
      });
      ids.draft = draft.id;
      const draftActions = await actionsOf('procurement_order', draft.id);
      expect(draftActions.map((action) => action.id)).toStrictEqual([
        'procurement_order.submit',
        'procurement_order.cancel',
      ]);
      expect(draftActions[0].payload).toMatchObject({ orderId: draft.id });
      expect(draftActions[0].commandType).toBe('purchases.order.submit');

      // Orden recibida sin obligación de pago: `checkCloseOrder` la rechazaría,
      // así que la rama NO ofrece cerrarla; sí ofrece pedir el pago.
      const received = await prisma.procurementOrder.create({
        data: {
          number: `OC-${tag}-B`,
          supplierId: supplier.id,
          status: 'received',
          paymentMode: 'credit',
          total: 500,
          subtotal: 500,
          createdByUserId: actor,
          lines: {
            create: [
              {
                description: `Partida ${tag}`,
                qty: 5,
                unit: 'pza',
                unitPrice: 100,
                lineTotal: 500,
              },
            ],
          },
        },
      });
      ids.received = received.id;
      expect(
        (await actionsOf('procurement_order', received.id)).map((action) => action.id)
      ).toStrictEqual(['procurement_order.request_payment']);

      // Con el pago ya registrado sí se puede cerrar, y ya no se vuelve a pedir.
      await prisma.procurementOrder.update({
        where: { id: received.id },
        data: { obligationId: `ob-${tag}` },
      });
      expect(
        (await actionsOf('procurement_order', received.id)).map((action) => action.id)
      ).toStrictEqual(['procurement_order.close']);

      // Recepción en bodega en borrador de una orden que todavía espera material:
      // se registra, y el comando corre contra la ORDEN (agregado y versión
      // optimista de la orden, no de la recepción).
      const awaiting = await prisma.procurementOrder.create({
        data: {
          number: `OC-${tag}-C`,
          supplierId: supplier.id,
          status: 'awaiting_receipt',
          paymentMode: 'credit',
          total: 300,
          subtotal: 300,
          obligationId: `ob-${tag}-c`,
          createdByUserId: actor,
          lines: {
            create: [
              {
                description: `Partida ${tag}`,
                qty: 3,
                unit: 'pza',
                unitPrice: 100,
                lineTotal: 300,
              },
            ],
          },
        },
      });
      const receipt = await prisma.goodsReceipt.create({
        data: {
          number: `RC-${tag}`,
          orderId: awaiting.id,
          receivedByUserId: actor,
          mode: 'warehouse',
          warehouseId: `wh-${tag}`,
          status: 'draft',
        },
      });
      ids.receipt = receipt.id;
      const [post] = await actionsOf('goods_receipt', receipt.id);
      expect(post.id).toBe('goods_receipt.post');
      expect(post.commandType).toBe('purchases.receipt.post');
      expect(post.aggregateType).toBe('procurement_order');
      expect(post.aggregateId).toBe(awaiting.id);
      expect(post.payload).toMatchObject({ receiptId: receipt.id });

      // Una recepción de entrega directa no se registra con este comando.
      await prisma.goodsReceipt.update({
        where: { id: receipt.id },
        data: { mode: 'direct_delivery', warehouseId: null },
      });
      expect(await actionsOf('goods_receipt', receipt.id)).toStrictEqual([]);

      // Con una recepción ya contabilizada, la orden se cierra pero NO se cancela.
      await prisma.goodsReceipt.update({
        where: { id: receipt.id },
        data: { mode: 'warehouse', warehouseId: `wh-${tag}`, status: 'posted' },
      });
      await prisma.procurementOrder.update({
        where: { id: draft.id },
        data: { status: 'approved' },
      });
      const posted = await prisma.goodsReceipt.create({
        data: {
          number: `RC-${tag}-B`,
          orderId: draft.id,
          receivedByUserId: actor,
          mode: 'warehouse',
          warehouseId: `wh-${tag}`,
          status: 'posted',
        },
      });
      expect(
        (await actionsOf('procurement_order', draft.id)).map((action) => action.id)
      ).toStrictEqual(['procurement_order.request_payment']);
      await prisma.goodsReceipt.delete({ where: { id: posted.id } });
    } finally {
      await prisma.goodsReceipt.deleteMany({ where: { receivedByUserId: actor } });
      await prisma.procurementOrder.deleteMany({ where: { createdByUserId: actor } });
      await prisma.supplier.deleteMany({ where: { createdByUserId: actor } });
    }
  });

  it('rechaza un campo que el área no declara, en vez de ignorarlo', async () => {
    const { area, parseAreaWorkQuery } = await load();
    expect(() =>
      parseAreaWorkQuery(
        {
          filters: {
            logic: 'AND',
            rules: [{ field: 'extra.secreto', operator: 'contains', value: 'x' }],
          },
        },
        area
      )
    ).toThrow();
  });
});
