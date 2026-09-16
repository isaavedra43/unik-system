/**
 * Exclusión mutua entre corridas de integración.
 *
 * Las suites de `tests/integration` comparten UNA base desechable real
 * (`unik_schema_check`) y cada una la deja limpia con `TRUNCATE` + `DELETE` por
 * prefijo. Dentro de una corrida eso es seguro porque el proyecto `integration`
 * usa `fileParallelism: false`. Entre corridas NO lo era: dos `npm run
 * test:integration` al mismo tiempo (dos terminales, dos agentes, CI y local)
 * se borran las filas mutuamente y producen fallos que parecen aleatorios —
 * `deadlock detected` (40P01) cuando un `TRUNCATE` pide `AccessExclusiveLock`
 * mientras la otra corrida ya tiene `AccessShareLock` sobre otra tabla de la
 * misma lista, violaciones de unicidad al sembrar (`Responsible.area`) y
 * `Notification_userId_fkey` cuando la otra corrida borra los usuarios a media
 * ejecución.
 *
 * La red es un candado de aviso (advisory lock) a nivel de SESIÓN tomado por el
 * proceso principal de vitest antes del primer archivo y liberado al final: la
 * segunda corrida espera su turno en vez de corromper la base.
 */

/** Par (classid, objid) del `pg_advisory_lock`: 0x554e = "UN", 0x494b = "IK". */
export const INTEGRATION_LOCK_CLASS_ID = 0x554e;
export const INTEGRATION_LOCK_OBJ_ID = 0x494b;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_NAME = /(check|test|integration|scratch|ci)/i;

/**
 * Comprueba que la URL apunte a una base local y desechable. Es la misma regla
 * que aplican las suites (`assertDisposableDatabase`), repetida aquí porque el
 * candado se toma ANTES de que corra ningún archivo de prueba.
 */
export function assertDisposableIntegrationUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `[integration] Sólo se permite una base local (host recibido: ${url.hostname})`
    );
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const allowed = process.env.UNIK_INTEGRATION_ALLOW_DATABASE?.trim();
  if (name === 'unik_system' || (!DISPOSABLE_NAME.test(name) && allowed !== name)) {
    throw new Error(
      `[integration] La base "${name}" no parece desechable. Usa una base de prueba (p. ej. unik_schema_check) ` +
        'o confírmala con UNIK_INTEGRATION_ALLOW_DATABASE=<nombre>.'
    );
  }
  return url;
}

/**
 * Fuerza una sola conexión: los candados de aviso de sesión viven en la
 * conexión, así que tomar y soltar desde un pool con varias no es fiable.
 */
export function singleConnectionUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('pool_timeout', '30');
  return url.toString();
}

/** Nombre de la base tal como lo reporta `current_database()`. */
export function databaseNameOf(rawUrl: string): string {
  return decodeURIComponent(new URL(rawUrl).pathname.replace(/^\//, ''));
}
