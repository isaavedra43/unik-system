/**
 * Next.js instrumentation hook. Runs once per server instance.
 * Registers all Zoho entity sync schedulers and the background job worker.
 * Each scheduler uses the shared organization-wide rate budget and
 * checks integration enabled status before starting.
 *
 * The import MUST stay inside `if (process.env.NEXT_RUNTIME === 'nodejs')`: Next replaces the
 * variable at compile time, so the Edge bundle drops the branch. An early `return` does not —
 * webpack still bundles the dynamic imports for Edge and fails on Node built-ins
 * ("Module not found: Can't resolve 'crypto'").
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startNodeInstrumentation } = await import('./instrumentation-node');
    await startNodeInstrumentation();
  }
}
