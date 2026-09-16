import { describe, expect, it } from 'vitest';

/**
 * SQL de la Torre de Control (plan 7.7 a 7.9) contra una base PostgreSQL REAL
 * con todas las migraciones aplicadas.
 *
 * Por qué existe esta suite: las proyecciones, las excepciones y el grafo son
 * `$queryRaw` armados con `Prisma.sql`. Un nombre de columna equivocado, un
 * `LATERAL` mal cerrado, un `percentile_cont` sin `WITHIN GROUP` o una CTE
 * recursiva que PostgreSQL rechaza (por ejemplo, referenciarse a sí misma
 * dentro de una subconsulta) son INVISIBLES para TypeScript y para las pruebas
 * con `FakePrisma`: sólo fallan el día que alguien abre la pantalla. Aquí cada
 * consulta se ejecuta de verdad.
 *
 * NO AFIRMA NADA sobre el número de filas que ya haya: las demás suites truncan
 * las tablas operativas de esta base desechable, así que ésta tiene que ser
 * indiferente a lo que haya (o no haya). Un resultado vacío es un acierto; un
 * error de SQL es una falla.
 *
 * La única excepción es la salud de sincronización: ese escenario SIEMBRA sus
 * propias corridas bajo la fuente `it_sync_health` y las borra al terminar
 * (también antes de empezar, por si una corrida anterior murió a medias),
 * porque el defecto que cubre sólo aparece con historia suficiente.
 *
 * Corre sólo con UNIK_INTEGRATION_DATABASE_URL definida (`npm run test:integration`).
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;
if (!integrationUrl) {
  console.warn(
    '[integration] Se omite el SQL de la Torre de Control: define UNIK_INTEGRATION_DATABASE_URL ' +
      'con una base PostgreSQL local y desechable con todas las migraciones aplicadas (por ejemplo unik_schema_check).'
  );
}

describeDb('Torre de Control · SQL contra PostgreSQL', () => {
  const NOW = new Date('2026-09-15T18:00:00.000Z');
  const WINDOW = {
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-09-16T00:00:00.000Z'),
  };
  const WINDOW_FROM = new Date('2026-07-01T00:00:00.000Z');

  const ADMIN = {
    id: 'it-ct-admin',
    username: 'it-ct-admin',
    name: 'Torre de Control (prueba)',
    email: null,
    mustChangePassword: false,
    roleKeys: [],
    permissionKeys: ['operations.admin'],
    isSuperAdmin: false,
  };

  async function db() {
    const { prisma } = await import('@/lib/prisma');
    return prisma;
  }

  // -------------------------------------------------------------------------
  // Proyecciones
  // -------------------------------------------------------------------------

  it('ejecuta las consultas de la marca de agua y de los expedientes tocados', async () => {
    const prisma = await db();
    const sql = await import('@/modules/control-tower/projections-sql');

    const maxRows = await prisma.$queryRaw<Array<{ maxId: bigint | null }>>(sql.maxEventIdSql());
    expect(Array.isArray(maxRows)).toBe(true);

    const affected = await prisma.$queryRaw<Array<{ caseId: string }>>(
      sql.affectedCaseIdsSql({ lastEventId: BigInt(0), since: WINDOW.from, limit: 50 })
    );
    expect(Array.isArray(affected)).toBe(true);
    for (const row of affected) expect(typeof row.caseId).toBe('string');
  });

  it('ejecuta la secuencia y las activaciones de un lote de expedientes', async () => {
    const prisma = await db();
    const sql = await import('@/modules/control-tower/projections-sql');
    const cases = await prisma.operationalCase.findMany({ select: { id: true }, take: 5 });
    const ids = cases.length > 0 ? cases.map((row) => row.id) : ['sin-expedientes'];

    const sequences = await prisma.$queryRaw<
      Array<{ caseId: string; sequence: string[]; scopes: string[] }>
    >(sql.caseSequenceSql(ids));
    for (const row of sequences) {
      expect(Array.isArray(row.sequence)).toBe(true);
      expect(Array.isArray(row.scopes)).toBe(true);
    }

    const activations = await prisma.$queryRaw<Array<{ activations: number }>>(
      sql.caseActivationsSql(ids)
    );
    for (const row of activations) expect(Number.isFinite(Number(row.activations))).toBe(true);
  });

  it('ejecuta las cuatro consultas de métricas por paso (percentiles incluidos)', async () => {
    const prisma = await db();
    const sql = await import('@/modules/control-tower/projections-sql');
    await expect(prisma.$queryRaw(sql.stepCompletionMetricsSql(WINDOW))).resolves.toBeDefined();
    await expect(prisma.$queryRaw(sql.stepStartedSql(WINDOW))).resolves.toBeDefined();
    await expect(prisma.$queryRaw(sql.stepReworkSql(WINDOW))).resolves.toBeDefined();
    await expect(
      prisma.$queryRaw(sql.stepWaitSql({ ...WINDOW, windowFrom: WINDOW_FROM }))
    ).resolves.toBeDefined();
  });

  it('ejecuta los traspasos por solicitud y por reasignación de trabajo', async () => {
    const prisma = await db();
    const sql = await import('@/modules/control-tower/projections-sql');
    await expect(prisma.$queryRaw(sql.handoffRequestsSql(WINDOW))).resolves.toBeDefined();
    await expect(prisma.$queryRaw(sql.handoffWorkItemsSql(WINDOW))).resolves.toBeDefined();
  });

  it('ejecuta las cinco consultas de causas de bloqueo', async () => {
    const prisma = await db();
    const sql = await import('@/modules/control-tower/projections-sql');
    const queries = sql.blockCauseQueries({ ...WINDOW, windowFrom: WINDOW_FROM, now: NOW });
    expect(queries).toHaveLength(5);
    for (const query of queries) {
      await expect(prisma.$queryRaw(query)).resolves.toBeDefined();
    }
  });

  it('una corrida completa de refreshProjections deja las cuatro marcas de agua', async () => {
    const { refreshProjections, PROJECTION_KEYS } =
      await import('@/modules/control-tower/projections-service');
    const result = await refreshProjections({ now: NOW, full: true });
    const errors = result.runs.filter((run) => !run.ok).map((run) => `${run.key}: ${run.error}`);
    expect(errors).toStrictEqual([]);
    expect(result.runs.map((run) => run.key)).toStrictEqual([...PROJECTION_KEYS]);

    const prisma = await db();
    const watermarks = await prisma.ctProjectionWatermark.findMany({
      where: { key: { in: [...PROJECTION_KEYS] } },
    });
    expect(watermarks.map((row) => row.key).sort()).toStrictEqual([...PROJECTION_KEYS].sort());
  });

  it('la segunda corrida es idempotente: no duplica filas de proyección', async () => {
    const prisma = await db();
    const { refreshProjections } = await import('@/modules/control-tower/projections-service');
    await refreshProjections({ now: NOW, full: true });
    const before = await Promise.all([
      prisma.ctCaseVariant.count(),
      prisma.ctStepMetricDaily.count(),
      prisma.ctHandoffDaily.count(),
      prisma.ctBlockCauseDaily.count(),
    ]);
    await refreshProjections({ now: NOW, full: true });
    const after = await Promise.all([
      prisma.ctCaseVariant.count(),
      prisma.ctStepMetricDaily.count(),
      prisma.ctHandoffDaily.count(),
      prisma.ctBlockCauseDaily.count(),
    ]);
    expect(after).toStrictEqual(before);
  });

  // -------------------------------------------------------------------------
  // Lecturas de la Torre
  // -------------------------------------------------------------------------

  it('calcula el resumen completo (conteos, sync, jobs, IA y frescura)', async () => {
    const { computeControlTowerOverview } =
      await import('@/modules/control-tower/control-tower-service');
    const overview = await computeControlTowerOverview({ now: NOW });
    expect(typeof overview.cases.open).toBe('number');
    expect(Array.isArray(overview.areas)).toBe(true);
    expect(Array.isArray(overview.tiles)).toBe(true);
    expect(Array.isArray(overview.charts)).toBe(true);
    expect(Array.isArray(overview.projections)).toBe(true);
  });

  it('el costo de IA de un expediente suma el medidor `ai_case` (Decimal real)', async () => {
    // `UsageMeter.amount` es `Decimal(18,4)`: con un fake devuelve un número y
    // el error no se ve. Aquí la suma la hace PostgreSQL de verdad.
    const prisma = await db();
    const { getCaseAiCostUsd } = await import('@/modules/agents/budget');
    const CASE_ID = 'it-ai-cost-case';
    const OTHER_CASE = 'it-ai-cost-otro';
    const AREA_KEY = 'it-ai-cost-area';
    const keys = [CASE_ID, OTHER_CASE, AREA_KEY];
    await prisma.usageMeter.deleteMany({ where: { key: { in: keys } } });
    try {
      await prisma.usageMeter.createMany({
        data: [
          {
            dimension: 'ai_case',
            key: CASE_ID,
            period: '2026-09-14',
            unit: 'usd',
            count: 3,
            amount: 0.25,
          },
          {
            dimension: 'ai_case',
            key: CASE_ID,
            period: '2026-09-15',
            unit: 'usd',
            count: 2,
            amount: 0.17,
          },
          // Ni los tokens ni otra dimensión cuentan como dinero de este expediente.
          {
            dimension: 'ai_case',
            key: CASE_ID,
            period: '2026-09-15',
            unit: 'tokens',
            count: 2,
            amount: 9000,
          },
          {
            dimension: 'ai_area',
            key: AREA_KEY,
            period: '2026-09-15',
            unit: 'usd',
            count: 1,
            amount: 5,
          },
        ],
      });

      const costs = await getCaseAiCostUsd([CASE_ID, OTHER_CASE]);
      expect(costs.get(CASE_ID)).toBeCloseTo(0.42, 6);
      // Sin medidor no hay entrada: el inspector lo lee como «no aplica», no 0.
      expect(costs.has(OTHER_CASE)).toBe(false);
      expect(await getCaseAiCostUsd([])).toStrictEqual(new Map());
    } finally {
      await prisma.usageMeter.deleteMany({ where: { key: { in: keys } } });
    }
  });

  it('la salud de sync ve la ÚLTIMA corrida de cada entidad, por vieja que sea', async () => {
    // El hueco de §7.7: se leían las 60 corridas más recientes y se deduplicaba
    // después, así que la entidad que DEJA de sincronizar salía de la ventana
    // antes de cumplir los 120 min que la pintan en ámbar y su fila desaparecía
    // del panel justo cuando había que verla. Aquí se siembra ese escenario:
    // una entidad callada hace 6 h detrás de 80 corridas recientes de otra.
    const prisma = await db();
    const { latestSyncRunsSql, toSyncHealthRows } =
      await import('@/modules/control-tower/control-tower-service');
    const SOURCE = 'it_sync_health';
    const QUIET_ENTITY = 'it_entidad_callada';
    const NOISY_ENTITY = 'it_entidad_ruidosa';
    await prisma.integrationSyncRun.deleteMany({ where: { source: SOURCE } });
    try {
      const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
      await prisma.integrationSyncRun.create({
        data: {
          source: SOURCE,
          entityType: QUIET_ENTITY,
          mode: 'quick',
          status: 'COMPLETED',
          startedAt: at(361),
          completedAt: at(360),
          recordsSeen: 7,
        },
      });
      await prisma.integrationSyncRun.createMany({
        data: Array.from({ length: 80 }, (_, index) => ({
          source: SOURCE,
          entityType: NOISY_ENTITY,
          mode: 'quick',
          status: 'COMPLETED',
          startedAt: at(index + 2),
          completedAt: at(index + 1),
          recordsSeen: index,
        })),
      });

      const rows = await prisma.$queryRaw<
        Array<{
          source: string;
          entityType: string;
          status: string;
          startedAt: Date;
          completedAt: Date | null;
          errorCode: string | null;
          recordsSeen: number;
        }>
      >(latestSyncRunsSql());
      const mine = rows.filter((row) => row.source === SOURCE);
      // Una fila por entidad, no 81.
      expect(mine).toHaveLength(2);
      const health = toSyncHealthRows(mine, NOW);
      const quiet = health.find((row) => row.entityType === QUIET_ENTITY);
      expect(quiet).toBeDefined();
      expect(quiet?.minutesAgo).toBe(360);
      expect(quiet?.stale).toBe(true);
      // Y de la ruidosa se ve la ÚLTIMA, no una cualquiera de las 80.
      const noisy = health.find((row) => row.entityType === NOISY_ENTITY);
      expect(noisy?.minutesAgo).toBe(1);
      expect(noisy?.stale).toBe(false);

      const { computeControlTowerOverview } =
        await import('@/modules/control-tower/control-tower-service');
      const overview = await computeControlTowerOverview({ now: NOW });
      expect(
        overview.sync.runs.some(
          (row) => row.source === SOURCE && row.entityType === QUIET_ENTITY && row.stale
        )
      ).toBe(true);
      expect(overview.sync.stale).toBeGreaterThan(0);
      expect(overview.alerts.some((alert) => alert.id === 'sync_stale')).toBe(true);
    } finally {
      await prisma.integrationSyncRun.deleteMany({ where: { source: SOURCE } });
    }
  });

  it('ejecuta el UNION de excepciones con filtros, búsqueda y cada orden posible', async () => {
    const { listControlTowerExceptions } =
      await import('@/modules/control-tower/exceptions-service');
    const base = await listControlTowerExceptions(ADMIN, {}, { now: NOW });
    expect(base.pagination.page).toBe(1);
    expect(Array.isArray(base.data)).toBe(true);

    for (const sort of ['since', 'dueAt', 'severity', 'caseNumber', 'areaKey'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const page = await listControlTowerExceptions(
          ADMIN,
          { sort, direction, page_size: 5 },
          { now: NOW }
        );
        expect(page.pagination.page_size).toBe(5);
      }
    }

    const filtered = await listControlTowerExceptions(
      ADMIN,
      {
        kind: ['work_overdue', 'incident'],
        areaKey: ['compras', 'logistica'],
        severity: ['high', 'critical'],
        // comodines y comilla: tienen que viajar escapados, no romper la consulta
        search: '100%_\'; DROP TABLE "WorkItem"; --',
        page: 2,
        page_size: 10,
      },
      { now: NOW }
    );
    expect(filtered.pagination.page).toBe(2);
    expect(Array.isArray(filtered.counts)).toBe(true);
  });

  it('lista a las personas con su carga y su último evento', async () => {
    const { listPeopleNow } = await import('@/modules/control-tower/people-service');
    const result = await listPeopleNow(ADMIN, { now: NOW, limit: 20 });
    expect(Array.isArray(result.people)).toBe(true);
    for (const person of result.people) {
      expect(typeof person.userId).toBe('string');
      expect(['active', 'idle', 'inactive', 'unassigned']).toContain(person.presence);
    }
  });

  it('lee las proyecciones ya calculadas (variantes, pasos, traspasos y causas)', async () => {
    const service = await import('@/modules/control-tower/projections-service');
    const range = { from: WINDOW.from, to: NOW };
    const variants = await service.listVariants(ADMIN, range, { now: NOW });
    expect(Array.isArray(variants.variants)).toBe(true);
    const steps = await service.listStepMetrics(ADMIN, range, { now: NOW });
    expect(Array.isArray(steps.bottlenecks)).toBe(true);
    const handoffs = await service.listHandoffs(ADMIN, { ...range, kind: 'request' }, { now: NOW });
    expect(Array.isArray(handoffs.cells)).toBe(true);
    const causes = await service.listCauses(ADMIN, range, { now: NOW });
    expect(Array.isArray(causes.causes)).toBe(true);
    const status = await service.getProjectionStatus(ADMIN, { now: NOW });
    expect(status).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // Grafo
  // -------------------------------------------------------------------------

  it('ejecuta la CTE recursiva del grafo en ambas direcciones y a cada profundidad', async () => {
    const { queryOperationalGraph } = await import('@/modules/control-tower/graph-service');
    const prisma = await db();
    const relation = await prisma.objectRelation.findFirst({
      select: { fromType: true, fromId: true },
    });
    const root = relation
      ? { type: relation.fromType, id: relation.fromId }
      : { type: 'operational_case', id: 'sin-relaciones' };

    for (const depth of [1, 2, 3]) {
      const graph = await queryOperationalGraph(ADMIN, {
        perspectiveKey: 'administracion',
        roots: [root],
        depth,
        at: NOW,
      });
      expect(graph.depth).toBe(depth);
      expect(Array.isArray(graph.nodes)).toBe(true);
      expect(Array.isArray(graph.edges)).toBe(true);
      const keys = new Set(graph.nodes.map((node) => node.key));
      // Toda arista devuelta une dos nodos presentes: la pantalla nunca recibe
      // una flecha que apunte a la nada.
      for (const edge of graph.edges) {
        expect(keys.has(edge.fromKey)).toBe(true);
        expect(keys.has(edge.toKey)).toBe(true);
      }
      // La raíz siempre está, aunque no tenga vecinos.
      expect(graph.nodes.some((node) => node.root)).toBe(true);
    }
  });

  it('el grafo respeta el tope del servidor y marca el corte', async () => {
    const { queryOperationalGraph } = await import('@/modules/control-tower/graph-service');
    const prisma = await db();
    const relations = await prisma.objectRelation.findMany({
      select: { fromType: true, fromId: true },
      take: 3,
    });
    const roots =
      relations.length > 0
        ? relations.map((row) => ({ type: row.fromType, id: row.fromId }))
        : [{ type: 'operational_case', id: 'sin-relaciones' }];
    const graph = await queryOperationalGraph(ADMIN, {
      perspectiveKey: 'administracion',
      roots,
      depth: 3,
      limit: 1,
      at: NOW,
    });
    expect(graph.nodes.length).toBeLessThanOrEqual(1);
    expect(typeof graph.truncated).toBe('boolean');
  });

  it('cada perspectiva se puede recorrer (relaciones y tipos reales)', async () => {
    const { queryOperationalGraph } = await import('@/modules/control-tower/graph-service');
    const { GRAPH_PERSPECTIVES } = await import('@/modules/control-tower/perspectives');
    for (const perspective of GRAPH_PERSPECTIVES) {
      const root = perspective.rootTypes[0] ?? 'operational_case';
      await expect(
        queryOperationalGraph(ADMIN, {
          perspectiveKey: perspective.key,
          roots: [{ type: root, id: 'id-inexistente' }],
          at: NOW,
        })
      ).resolves.toMatchObject({ perspectiveKey: perspective.key });
    }
  });

  it('el instante fijado (TimeSlider) recorta la red al pasado', async () => {
    const { queryOperationalGraph } = await import('@/modules/control-tower/graph-service');
    const prisma = await db();
    const relation = await prisma.objectRelation.findFirst({
      select: { fromType: true, fromId: true },
    });
    if (!relation) return; // base vacía: la consulta ya se probó arriba
    const past = await queryOperationalGraph(ADMIN, {
      perspectiveKey: 'administracion',
      roots: [{ type: relation.fromType, id: relation.fromId }],
      depth: 3,
      at: new Date('2000-01-01T00:00:00.000Z'),
    });
    // Antes de que existiera nada, sólo queda la raíz.
    expect(past.nodes).toHaveLength(1);
    expect(past.edges).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Simulación y reproducción
  // -------------------------------------------------------------------------

  it('simula el blueprint con las duraciones medidas de la base', async () => {
    const { simulateBlueprint } = await import('@/modules/control-tower/simulation');
    const simulation = await simulateBlueprint(ADMIN, {
      now: NOW,
      scenario: {
        delays: [{ stepKey: 'verificar_disponibilidad', minutes: 120 }],
        capacity: [{ areaKey: 'inventario', factor: 2 }],
      },
    });
    expect(simulation.steps.length).toBeGreaterThan(0);
    expect(simulation.scenarioFinish).not.toBeNull();
    expect(simulation.criticalPath.length).toBeGreaterThan(0);
  });

  it('aplica un escenario a los expedientes abiertos sin escribir nada', async () => {
    const { applyToOpenCases } = await import('@/modules/control-tower/simulation');
    const prisma = await db();
    const before = await prisma.operationalCase.count();
    const result = await applyToOpenCases(ADMIN, {
      now: NOW,
      scenario: { delays: [{ stepKey: 'esperar_recepcion', minutes: 1_440 }] },
      limit: 50,
    });
    expect(typeof result.evaluated).toBe('number');
    expect(Array.isArray(result.breaching)).toBe(true);
    expect(await prisma.operationalCase.count()).toBe(before);
  });

  it('reproduce un expediente real si lo hay', async () => {
    const prisma = await db();
    const { listCaseEvents } = await import('@/modules/operations/events-service');
    const { AI_TURN_EVENT_TYPES } = await import('@/modules/operations/types');
    const { foldCaseState } = await import('@/modules/control-tower/replay');
    const opCase = await prisma.operationalCase.findFirst({ select: { id: true } });
    if (!opCase) return; // base truncada por otra suite: nada que reproducir
    const page = await listCaseEvents(opCase.id, {
      limit: 200,
      excludeTypes: AI_TURN_EVENT_TYPES,
    });
    const state = foldCaseState(page.events, NOW);
    expect(state.eventsApplied).toBe(page.events.length);
    expect(typeof state.counters.openWorkItems).toBe('number');
  });

  // -------------------------------------------------------------------------
  // Escenas
  // -------------------------------------------------------------------------

  it('guarda, actualiza y borra una escena del grafo', async () => {
    const prisma = await db();
    const scenes = await import('@/modules/control-tower/scenes-service');
    await prisma.user.upsert({
      where: { id: ADMIN.id },
      create: {
        id: ADMIN.id,
        username: ADMIN.username,
        name: ADMIN.name,
        passwordHash: 'x',
        isActive: true,
      },
      update: {},
    });

    const created = await scenes.createGraphScene(ADMIN, {
      name: 'Escena de prueba',
      perspectiveKey: 'expediente',
      roots: [{ type: 'operational_case', id: 'c-it' }],
      filters: { area: 'compras' },
      shared: true,
    });
    expect(created.version).toBe(1);

    const updated = await scenes.updateGraphScene(ADMIN, created.id, {
      name: 'Escena renombrada',
      expectedVersion: 1,
    });
    expect(updated).toMatchObject({ name: 'Escena renombrada', version: 2 });

    await expect(
      scenes.updateGraphScene(ADMIN, created.id, { name: 'tarde', expectedVersion: 1 })
    ).rejects.toMatchObject({ code: 'version_conflict' });

    const listed = await scenes.listGraphScenes(ADMIN, { perspectiveKey: 'expediente' });
    expect(listed.some((scene) => scene.id === created.id)).toBe(true);

    await expect(scenes.deleteGraphScene(ADMIN, created.id)).resolves.toEqual({ id: created.id });
    await prisma.user.deleteMany({ where: { id: ADMIN.id } });
  });
});
