/**
 * Clears stale "failed migration" records before `prisma migrate deploy`.
 *
 * Postgres runs each migration in a transaction: a migration that failed
 * applied NOTHING, but its row in `_prisma_migrations` (finished_at NULL)
 * blocks every future `migrate deploy` with P3009. Resolving it as
 * rolled-back lets deploy re-run the migration cleanly — which is safe
 * because the SQL either never applied or is written idempotently
 * (IF NOT EXISTS / NOT VALID, see AGENTS.md → Migraciones).
 *
 * Runs in the Railway pre-deploy image via `scripts/prisma-deploy.sh`.
 */
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';

const prisma = new PrismaClient();

try {
  let failed = [];
  try {
    failed = await prisma.$queryRawUnsafe(
      `SELECT migration_name FROM "_prisma_migrations"
       WHERE finished_at IS NULL AND rolled_back_at IS NULL
       ORDER BY started_at`
    );
  } catch {
    // _prisma_migrations doesn't exist yet (fresh DB) — nothing to resolve.
  }
  for (const { migration_name } of failed) {
    console.log(`[migrate] failed migration "${migration_name}" found — marking rolled-back so deploy can re-run it`);
    execFileSync('npx', ['prisma', 'migrate', 'resolve', '--rolled-back', migration_name], { stdio: 'inherit' });
  }
} finally {
  await prisma.$disconnect();
}
