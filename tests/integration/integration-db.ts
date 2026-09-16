import { prisma } from '@/lib/prisma';

/**
 * Piezas compartidas de las suites de integración (plan §9.1, regla (d) de
 * AGENTS.md).
 *
 * La exclusión mutua ENTRE corridas la resuelve el `globalSetup` del proyecto
 * vitest `integration` con un candado de aviso de PostgreSQL (ver
 * `integration-lock.ts`). Lo que falta ahí es lo que pasa DENTRO de una
 * corrida: el `TRUNCATE` con el que cada suite arranca pide
 * `AccessExclusiveLock` sobre decenas de tablas a la vez, y si otra conexión
 * del MISMO proceso sostiene un `AccessShareLock` sobre cualquiera de ellas
 * —trabajo asíncrono que una prueba anterior no esperó, una transacción
 * interactiva todavía abierta— el resultado sin `lock_timeout` es un
 * interbloqueo (`40P01 deadlock detected`) que mata la corrida entera desde el
 * `beforeEach`, y los errores que siguen parecen defectos de producto.
 *
 * Por eso aquí vive:
 * - `truncateTables`, la limpieza con `lock_timeout` y reintentos;
 * - `assertDisposableDatabase`, la guarda de base local y desechable que las
 *   tres suites grandes tenían copiada tres veces.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_NAME = /(check|test|integration|scratch|ci)/i;

const integrationUrl = process.env.UNIK_INTEGRATION_DATABASE_URL?.trim() || '';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Limpieza tolerante a bloqueos
// ---------------------------------------------------------------------------

/** `40P01` interbloqueo detectado, `55P03` no se pudo tomar el candado a tiempo. */
const RETRYABLE_LOCK_CODES = ['40P01', '55P03'];

/** Espera entre reintentos (crece linealmente con el intento). */
const RETRY_BASE_MS = 200;

/**
 * True si el error es un bloqueo pasajero: vale la pena reintentar.
 * Prisma envuelve los errores de `$executeRawUnsafe` en `P2010`, así que el
 * código de PostgreSQL llega en `meta.code` (y a veces sólo en el mensaje).
 */
export function isRetryableLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  const codes = [candidate.code, candidate.meta?.code].filter(
    (value): value is string => typeof value === 'string'
  );
  if (codes.some((code) => RETRYABLE_LOCK_CODES.includes(code))) return true;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return RETRYABLE_LOCK_CODES.some((code) => message.includes(code));
}

export interface TruncateOptions {
  cascade?: boolean;
  restartIdentity?: boolean;
  /** Intentos totales antes de rendirse con un mensaje explicativo. */
  attempts?: number;
  /** Cuánto espera PostgreSQL por el candado de cada intento. */
  lockTimeoutMs?: number;
}

/**
 * Vacía las tablas indicadas con `lock_timeout` y reintentos.
 *
 * Sin `lock_timeout`, un `TRUNCATE` bloqueado espera para siempre y, si el que
 * lo bloquea necesita a su vez una de las tablas que el `TRUNCATE` ya tomó,
 * PostgreSQL aborta con `40P01`. Con tiempo límite el intento falla rápido, se
 * suelta todo lo tomado y se vuelve a probar.
 */
export async function truncateTables(
  tables: readonly string[],
  options: TruncateOptions = {}
): Promise<void> {
  const { cascade = false, restartIdentity = true, attempts = 8, lockTimeoutMs = 4_000 } = options;
  if (tables.length === 0) return;
  const sql =
    `TRUNCATE TABLE ${tables.map((table) => `"${table}"`).join(', ')}` +
    (restartIdentity ? ' RESTART IDENTITY' : '') +
    (cascade ? ' CASCADE' : '');
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '${Math.max(1, lockTimeoutMs)}ms'`),
        prisma.$executeRawUnsafe(sql),
      ]);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableLockError(error)) throw error;
      await delay(RETRY_BASE_MS * attempt);
    }
  }
  throw new Error(
    `[integration] No se pudo vaciar la base tras ${attempts} intentos: algo sigue bloqueando las tablas. ` +
      'Suele ser trabajo asíncrono que una prueba no esperó (una promesa que nadie awaitó sigue ' +
      'consultando mientras la siguiente prueba limpia).',
    { cause: lastError }
  );
}

// ---------------------------------------------------------------------------
// Guarda de base desechable
// ---------------------------------------------------------------------------

export interface DisposableDatabaseOptions {
  /** Tablas que deben existir para que la suite tenga sentido. */
  requiredTables: readonly string[];
  /** Qué migraciones faltarían, para el mensaje de error. */
  missingLabel: string;
}

/**
 * Rechaza cualquier base que no sea local y desechable, y comprueba que tenga
 * las tablas que la suite necesita. Complementa a `assertDisposableIntegrationUrl`
 * (`integration-lock.ts`), que revisa la URL antes de que corra ningún archivo:
 * ésta pregunta a la base ya conectada por `current_database()` y su esquema.
 */
export async function assertDisposableDatabase(
  options: DisposableDatabaseOptions
): Promise<string> {
  if (process.env.DATABASE_URL !== integrationUrl) {
    throw new Error(
      '[integration] DATABASE_URL no coincide con UNIK_INTEGRATION_DATABASE_URL; ejecuta con `npm run test:integration`'
    );
  }
  const url = new URL(integrationUrl);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `[integration] Sólo se permite una base local (host recibido: ${url.hostname})`
    );
  }
  const [{ name }] = await prisma.$queryRaw<
    Array<{ name: string }>
  >`SELECT current_database() AS name`;
  const allowed = process.env.UNIK_INTEGRATION_ALLOW_DATABASE?.trim();
  if (name === 'unik_system' || (!DISPOSABLE_NAME.test(name) && allowed !== name)) {
    throw new Error(
      `[integration] La base "${name}" no parece desechable. Usa una base de prueba (p. ej. unik_schema_check) ` +
        'o confírmala con UNIK_INTEGRATION_ALLOW_DATABASE=<nombre>.'
    );
  }
  const missing: string[] = [];
  for (const table of options.requiredTables) {
    const [{ present }] = await prisma.$queryRaw<Array<{ present: boolean }>>`
      SELECT to_regclass(${`"${table}"`}) IS NOT NULL AS present`;
    if (!present) missing.push(table);
  }
  if (missing.length > 0) {
    throw new Error(
      `[integration] La base "${name}" no tiene las migraciones de ${options.missingLabel} ` +
        `(faltan: ${missing.join(', ')}); aplica \`prisma migrate deploy\` a esa base desechable`
    );
  }
  return name;
}
