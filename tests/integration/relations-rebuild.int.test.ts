import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Reconstrucción de la proyección `ObjectRelation` (plan 2.1) contra una base
 * PostgreSQL REAL con todas las migraciones aplicadas.
 *
 * Por qué existe esta suite: cada fuente de `relations-rebuild.ts` es una
 * consulta de Prisma con su propio `select`, su cursor por id y, varias de
 * ellas, una segunda consulta para resolver el id que el productor sí conocía
 * y la tabla no guarda (la orden de venta LOCAL detrás de un id de Zoho, la
 * RFQ detrás de una respuesta, el expediente detrás de una demanda). Las
 * pruebas unitarias sólo pueden ejercer las derivaciones PURAS: con `prisma`
 * simulado, un `select` de una columna que no existe o un modelo mal nombrado
 * pasa desapercibido y sólo falla el día que alguien pide la reconstrucción.
 * Aquí cada fuente se ejecuta de verdad.
 *
 * NO AFIRMA NADA sobre las filas que ya haya: las demás suites truncan las
 * tablas operativas de esta base desechable. Un resultado vacío es un acierto;
 * un error de SQL es una falla. El escenario de punta a punta SIEMBRA sus
 * propias filas bajo el prefijo `it-relreb-` y las borra al terminar (y antes
 * de empezar, por si una corrida anterior murió a medias).
 *
 * Corre sólo con UNIK_INTEGRATION_DATABASE_URL definida (`npm run test:integration`).
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;
if (!integrationUrl) {
  console.warn(
    '[integration] Se omite la reconstrucción del grafo: define UNIK_INTEGRATION_DATABASE_URL ' +
      'con una base PostgreSQL local y desechable con todas las migraciones aplicadas (por ejemplo unik_schema_check).'
  );
}

describeDb('Grafo · reconstrucción de ObjectRelation contra PostgreSQL', () => {
  const PREFIX = 'it-relreb-';
  const SUPPLIER_ID = `${PREFIX}supplier`;
  const ZOHO_CONTACT_ID = `${PREFIX}zoho-contact`;
  const REQUEST_ID = `${PREFIX}request`;
  const CASE_ID = `${PREFIX}case`;

  async function db() {
    const { prisma } = await import('@/lib/prisma');
    return prisma;
  }

  async function cleanup() {
    const prisma = await db();
    // Las aristas primero: no hay FK, así que se borran por sus extremos.
    await prisma.objectRelation.deleteMany({
      where: { OR: [{ fromId: { startsWith: PREFIX } }, { toId: { startsWith: PREFIX } }] },
    });
    await prisma.supplier.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.purchaseRequest.deleteMany({ where: { id: { startsWith: PREFIX } } });
  }

  beforeAll(cleanup);
  afterAll(cleanup);

  /**
   * El defecto que cubre: un `select` con una columna inexistente, un modelo mal
   * nombrado o un `where` inválido. TypeScript ve el cliente generado, pero no
   * ve si la MIGRACIÓN que crea esa columna llegó a la base.
   */
  it('cada fuente registrada ejecuta su consulta real sin error de SQL', async () => {
    const { listRelationSources } = await import('@/modules/operations/relations-rebuild');
    const sources = listRelationSources();
    expect(sources.length).toBeGreaterThanOrEqual(17);

    const failures: string[] = [];
    for (const { key } of sources) {
      try {
        const { rebuildObjectRelations } = await import('@/modules/operations/relations-rebuild');
        // Un solo lote pequeño por fuente: basta para ejecutar la consulta.
        const summary = await rebuildObjectRelations({ sources: [key], batchSize: 5 });
        expect(summary.unknownSources).toEqual([]);
        expect(summary.sources[key]).toBeDefined();
      } catch (error) {
        failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('reconstruye de punta a punta las aristas de filas sembradas', async () => {
    const prisma = await db();
    const { rebuildObjectRelations } = await import('@/modules/operations/relations-rebuild');

    await prisma.supplier.create({
      data: {
        id: SUPPLIER_ID,
        number: `${PREFIX}PRV-1`,
        name: 'Proveedor de prueba (reconstrucción)',
        zohoContactId: ZOHO_CONTACT_ID,
        createdByUserId: `${PREFIX}user`,
      },
    });
    await prisma.purchaseRequest.create({
      data: {
        id: REQUEST_ID,
        number: `${PREFIX}SC-1`,
        caseId: CASE_ID,
        requestedByUserId: `${PREFIX}user`,
        areaKey: 'compras',
      },
    });

    // Ninguna de las dos aristas existe todavía: nadie ejecutó los comandos.
    const before = await prisma.objectRelation.count({
      where: { OR: [{ fromId: { startsWith: PREFIX } }, { toId: { startsWith: PREFIX } }] },
    });
    expect(before).toBe(0);

    const summary = await rebuildObjectRelations({ sources: ['suppliers', 'purchase_requests'] });
    expect(summary.aborted).toBe(false);
    expect(summary.sources.suppliers.scanned).toBeGreaterThan(0);
    expect(summary.sources.purchase_requests.scanned).toBeGreaterThan(0);

    const edges = await prisma.objectRelation.findMany({
      where: { OR: [{ fromId: { startsWith: PREFIX } }, { toId: { startsWith: PREFIX } }] },
      orderBy: { relation: 'asc' },
      select: { fromType: true, fromId: true, toType: true, toId: true, relation: true },
    });
    expect(edges).toEqual([
      {
        fromType: 'purchase_request',
        fromId: REQUEST_ID,
        toType: 'operational_case',
        toId: CASE_ID,
        relation: 'for_case',
      },
      {
        fromType: 'supplier',
        fromId: SUPPLIER_ID,
        toType: 'zoho_contact',
        toId: ZOHO_CONTACT_ID,
        relation: 'same_as',
      },
    ]);
  });

  it('es idempotente y reabre una arista que se había cerrado', async () => {
    const prisma = await db();
    const { rebuildObjectRelations } = await import('@/modules/operations/relations-rebuild');

    // Alguien cerró la arista (o un comando la dio de baja por error).
    await prisma.objectRelation.updateMany({
      where: { fromId: SUPPLIER_ID, relation: 'same_as' },
      data: { validTo: new Date('2026-09-01T00:00:00.000Z') },
    });

    const summary = await rebuildObjectRelations({ sources: ['suppliers'] });
    // No duplica: el índice único absorbe el insert y sólo reabre.
    expect(summary.sources.suppliers.created).toBe(0);
    expect(summary.sources.suppliers.reopened).toBeGreaterThanOrEqual(1);

    const reopened = await prisma.objectRelation.findMany({
      where: { fromId: SUPPLIER_ID, relation: 'same_as' },
      select: { validTo: true },
    });
    expect(reopened).toHaveLength(1);
    expect(reopened[0].validTo).toBeNull();
  });
});
