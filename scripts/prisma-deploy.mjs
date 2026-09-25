#!/usr/bin/env node
/**
 * Production migration runner — Railway pre-deploy command.
 *
 *   node scripts/prisma-deploy.mjs
 *
 * Why this exists instead of a bare `prisma migrate deploy`:
 *
 * A migration that fails leaves a row in `_prisma_migrations` with
 * `finished_at NULL`. From that moment EVERY later `migrate deploy` aborts with
 * P3009 — including deploys that have nothing to do with the bad migration. A
 * single bad SQL file bricks every release until someone edits the production
 * database by hand (2026-09-25: `20260923231444_visual_studio` re-created an FK
 * that already existed, error 42710, and blocked the pipeline).
 *
 * So, before deploying, any migration that is recorded as FAILED is marked
 * rolled-back, which is what `prisma migrate resolve --rolled-back <name>` does
 * (https://pris.ly/d/migrate-resolve). That is safe because PostgreSQL runs each
 * migration inside a transaction: a failed migration applied NOTHING. Re-running
 * it is also safe because every migration in this repo is written to be
 * re-runnable (AGENTS.md → Migraciones; enforced by
 * src/modules/shared/prisma-migrations.test.ts).
 *
 * A migration still IN PROGRESS looks the same in the table, so a record is only
 * touched when Prisma already wrote its error into `logs`, or when it has been
 * stuck for longer than STALE_MINUTES. A concurrent deploy is never interrupted.
 *
 * This never hides a broken migration: it is re-run, and if it fails again the
 * deploy fails again with the real error in the logs.
 */
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/** A record older than this with no error logged is considered abandoned (killed container). */
const STALE_MINUTES = 15;

async function resolveFailedMigrations() {
  const prisma = new PrismaClient();
  try {
    let stuck = [];
    try {
      stuck = await prisma.$queryRawUnsafe(
        `SELECT migration_name, (logs IS NOT NULL) AS failed
           FROM "_prisma_migrations"
          WHERE finished_at IS NULL
            AND rolled_back_at IS NULL
            AND (logs IS NOT NULL OR started_at < now() - interval '${STALE_MINUTES} minutes')
          ORDER BY started_at`
      );
    } catch (err) {
      // Fresh database (no _prisma_migrations yet) or unreachable: nothing to
      // resolve here. `migrate deploy` below reports the real problem.
      console.log(`[migrate] no migration history to check (${err?.message ?? err})`);
      return;
    }

    for (const row of stuck) {
      const why = row.failed ? 'failed' : `stuck for over ${STALE_MINUTES} min`;
      console.log(`[migrate] "${row.migration_name}" is ${why} — marking it rolled back so it can be applied again`);
      await prisma.$executeRawUnsafe(
        `UPDATE "_prisma_migrations"
            SET rolled_back_at = now()
          WHERE migration_name = $1
            AND finished_at IS NULL
            AND rolled_back_at IS NULL`,
        row.migration_name
      );
    }
    if (stuck.length === 0) console.log('[migrate] no failed migrations pending');
  } finally {
    // Release the connection before handing over to the Prisma CLI.
    await prisma.$disconnect();
  }
}

await resolveFailedMigrations();

const deploy = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
if (deploy.error) {
  console.error('[migrate] could not run "prisma migrate deploy":', deploy.error.message);
  process.exit(1);
}
process.exit(deploy.status ?? 1);
