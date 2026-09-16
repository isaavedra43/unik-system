/**
 * Trabajo de fondo «dispara y olvida», pero con rastro.
 *
 * Varios flujos terminan su respuesta y dejan corriendo trabajo que sigue
 * escribiendo en la base: avisar a los miembros de un canal, detectar alertas
 * de un mensaje, despertar al repartidor de notificaciones. Hasta ahora eso se
 * escribía como `hacerAlgo().catch(() => {})`: la promesa quedaba suelta, nadie
 * podía saber si seguía viva y el proceso podía escribir en la base MUCHO
 * después de que quien la lanzó ya había contestado.
 *
 * En producción eso está bien (el usuario no espera el push). En pruebas es la
 * causa de fallos que parecen aleatorios: las suites de `tests/integration`
 * vacían la base con `TRUNCATE` entre pruebas, y un `INSERT` rezagado sobre
 * `RealtimeEvent` o `Notification` bloquea ese `TRUNCATE`
 * (`canceling statement due to lock timeout`, `40P01 deadlock detected`) o
 * ensucia la prueba siguiente con filas que nadie sembró.
 *
 * Este módulo da una sola forma de lanzar ese trabajo:
 *
 * - `runBackgroundTask(nombre, fn)` lo lanza y lo APUNTA. Los errores se
 *   registran en vez de reventar, igual que hacía el `.catch()` vacío.
 * - En un proceso SIN trabajador de fondo (`UNIK_JOB_WORKER_ENABLED=false`, que
 *   es lo que usan las suites de integración, y durante `next build`) el
 *   trabajo se ejecuta EN LÍNEA y quien lo lanzó lo espera: no queda nada
 *   corriendo por detrás y la prueba es reproducible.
 * - `flushBackgroundTasks()` espera a lo que siga vivo, para un apagado limpio
 *   o para una prueba que necesite el estado final.
 *
 * Es la misma bandera que ya apagan `startJobWorker()` y
 * `startRecurringScheduler()`, para que «sin trabajador de fondo» signifique lo
 * mismo en todo el sistema.
 */

const log = (event: string, extra: Record<string, unknown> = {}) =>
  console.warn(JSON.stringify({ component: 'background-tasks', event, ...extra }));

type TaskScope = typeof globalThis & { __unikBackgroundTasks?: Set<Promise<void>> };

/**
 * El registro vive en `globalThis` a propósito: Next compila un mismo módulo de
 * servidor una vez por capa de webpack, así que una variable de módulo no sería
 * única dentro del proceso (ver la nota de `operations/commands.ts`).
 */
function registry(): Set<Promise<void>> {
  const scope = globalThis as TaskScope;
  scope.__unikBackgroundTasks ??= new Set<Promise<void>>();
  return scope.__unikBackgroundTasks;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * ¿Este proceso corre sin trabajador de fondo? Entonces tampoco abre trabajo
 * asíncrono suelto: lo hace en línea (o no lo hace, si es un temporizador).
 */
export function backgroundWorkDisabled(): boolean {
  return (
    process.env.UNIK_JOB_WORKER_ENABLED === 'false' ||
    process.env.NEXT_PHASE === 'phase-production-build'
  );
}

/** Cuántas tareas de fondo siguen vivas (diagnóstico y pruebas). */
export function pendingBackgroundTasks(): number {
  return registry().size;
}

/**
 * Lanza trabajo que no debe bloquear la respuesta.
 *
 * Devuelve una promesa que, en un proceso con trabajador de fondo, se resuelve
 * de inmediato (el trabajo sigue por detrás y queda apuntado), y en un proceso
 * sin trabajador de fondo se resuelve cuando el trabajo TERMINÓ. Nunca rechaza:
 * un fallo se registra, como hacía el `.catch()` que sustituye.
 */
export function runBackgroundTask(name: string, run: () => Promise<unknown>): Promise<void> {
  const task = (async () => {
    try {
      await run();
    } catch (err) {
      log('task_failed', { task: name, message: err instanceof Error ? err.message : String(err) });
    }
  })();
  const tasks = registry();
  tasks.add(task);
  // `task` nunca rechaza, así que este `finally` no deja rechazos sin manejar.
  void task.finally(() => {
    tasks.delete(task);
  });
  return backgroundWorkDisabled() ? task : Promise.resolve();
}

/**
 * Espera a que no quede trabajo de fondo vivo. Una tarea puede lanzar otra, así
 * que vuelve a mirar el registro hasta vaciarlo o hasta agotar `timeoutMs`.
 *
 * Devuelve `true` si quedó vacío y `false` si se agotó la espera (quien llama
 * decide si eso es un fallo; aquí nunca se lanza para no romper un apagado).
 */
export async function flushBackgroundTasks(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (registry().size > 0) {
    if (Date.now() >= deadline) {
      log('flush_timeout', { pending: registry().size });
      return false;
    }
    const batch = [...registry()];
    await Promise.race([Promise.all(batch), delay(Math.max(1, deadline - Date.now()))]);
  }
  return true;
}
