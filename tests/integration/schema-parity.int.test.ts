import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Paridad entre el conjunto de migraciones y `prisma/schema.prisma`, contra una
 * base PostgreSQL REAL construida con `prisma migrate deploy`.
 *
 * Por qué existe esta suite: el plan (§9.2) dice explícitamente que las migraciones
 * las aplica Israel en Railway con `prisma migrate deploy`. Si ese conjunto no
 * reproduce el esquema, la base desplegada NO es la que el cliente de Prisma asume,
 * y nada lo avisa: `prisma validate`, `tsc`, `eslint` y las pruebas unitarias con
 * `FakePrisma` no miran la base. Así se coló la deriva heredada que corrige
 * `20260916181500_align_legacy_schema_drift` (FK faltante de `AiAttachment.messageId`,
 * tres FK con `ON UPDATE` distinto, dos defaults de `internal_chat_config` y un
 * índice con otro nombre en `IntegrationEntityState`).
 *
 * NO SIEMBRA NADA y no lee ninguna fila: sólo mira el catálogo de PostgreSQL, así que
 * es indiferente a que las demás suites trunquen las tablas de esta base desechable.
 *
 * Corre sólo con UNIK_INTEGRATION_DATABASE_URL definida (`npm run test:integration`).
 */

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';
const describeDb = integrationUrl ? describe : describe.skip;
if (!integrationUrl) {
  console.warn(
    '[integration] Se omite la paridad de esquema: define UNIK_INTEGRATION_DATABASE_URL ' +
      'con una base PostgreSQL local y desechable con todas las migraciones aplicadas (por ejemplo unik_schema_check).'
  );
}

/** `confupdtype`/`confdeltype` de `pg_constraint`: a = NO ACTION, c = CASCADE, n = SET NULL. */
type FkRow = { conname: string; onupdate: string; ondelete: string };

describeDb('Paridad de esquema · migraciones contra schema.prisma', () => {
  // Vitest corre desde la raíz del repositorio; `__dirname` no existe bajo ESM.
  const repoRoot = process.cwd();

  /** Corre `prisma migrate diff` y devuelve SIEMPRE código de salida, no una excepción. */
  async function migrateDiff(
    extra: string[]
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        'npx',
        [
          'prisma',
          'migrate',
          'diff',
          '--from-url',
          integrationUrl,
          '--to-schema-datamodel',
          path.join(repoRoot, 'prisma', 'schema.prisma'),
          ...extra,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, DATABASE_URL: integrationUrl },
          maxBuffer: 16 * 1024 * 1024,
        }
      );
      return { code: 0, stdout, stderr };
    } catch (err) {
      const failure = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
      };
    }
  }

  it('las migraciones aplicadas reproducen prisma/schema.prisma (deriva cero)', async () => {
    // `--exit-code`: 0 = sin diferencias, 2 = hay diferencias. Sin `--script` la salida
    // ya es legible, y es justo lo que hay que enseñar cuando falla.
    const result = await migrateDiff(['--exit-code']);
    if (result.code !== 0) {
      const detail = await migrateDiff([]);
      throw new Error(
        `La base de integración no coincide con prisma/schema.prisma (prisma migrate diff --exit-code = ${result.code}).\n` +
          'Hay que emitir una migración correctiva o corregir la última. Diferencias:\n' +
          `${detail.stdout || detail.stderr || result.stderr}`
      );
    }
    expect(result.code).toBe(0);
  }, 180_000);

  it('las cinco correcciones de deriva heredada están presentes en la base', async () => {
    const { prisma } = await import('@/lib/prisma');

    // 1 y 2. Llaves foráneas: AiAttachment.messageId debe EXISTIR (SET NULL al borrar,
    // CASCADE al actualizar) y las tres de detalle deben ser CASCADE/CASCADE.
    const fks = await prisma.$queryRaw<FkRow[]>`
      SELECT conname,
             confupdtype::text AS onupdate,
             confdeltype::text AS ondelete
        FROM pg_constraint
       WHERE contype = 'f'
         AND conname IN (
           'AiAttachment_messageId_fkey',
           'InvoiceItem_invoiceId_fkey',
           'PackageItem_packageId_fkey',
           'PurchaseOrderItem_purchaseOrderId_fkey'
         )
       ORDER BY conname
    `;
    const byName = new Map(fks.map((row) => [row.conname, row]));

    expect(byName.get('AiAttachment_messageId_fkey')).toEqual({
      conname: 'AiAttachment_messageId_fkey',
      onupdate: 'c',
      ondelete: 'n',
    });
    for (const name of [
      'InvoiceItem_invoiceId_fkey',
      'PackageItem_packageId_fkey',
      'PurchaseOrderItem_purchaseOrderId_fkey',
    ]) {
      expect(byName.get(name), `falta la llave foránea ${name}`).toEqual({
        conname: name,
        onupdate: 'c',
        ondelete: 'c',
      });
    }

    // 3. Defaults de internal_chat_config: `id` = 'singleton', `value` sin default.
    const configColumns = await prisma.$queryRaw<
      Array<{ column_name: string; column_default: string | null }>
    >`
      SELECT column_name, column_default
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'internal_chat_config'
         AND column_name IN ('id', 'value')
       ORDER BY column_name
    `;
    const configByColumn = new Map(
      configColumns.map((row) => [row.column_name, row.column_default])
    );
    expect(configByColumn.get('id')).toBe(`'singleton'::text`);
    expect(configByColumn.get('value')).toBeNull();

    // 4. Índice de IntegrationEntityState con el nombre que genera Prisma, y sin el
    //    nombre truncado por PostgreSQL conviviendo con él.
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'IntegrationEntityState'
         AND indexname LIKE '%remote%'
       ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toEqual([
      'IntegrationEntityState_source_entityType_needsSync_remoteMo_idx',
    ]);
  }, 60_000);
});
