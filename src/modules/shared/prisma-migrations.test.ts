import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every migration must survive being applied TWICE against a drifted production
 * database.
 *
 * Why this test exists: on 2026-09-25 `20260923231444_visual_studio` tried to
 * create a foreign key that production already had (`AiAttachment_messageId_fkey`,
 * PostgreSQL 42710). Prisma rolled the migration back but left it recorded as
 * failed, and from then on EVERY deploy died with P3009 — including deploys that
 * had nothing to do with that migration. Production was frozen until the file was
 * fixed by hand.
 *
 * The migration files are written by `prisma migrate diff` against a local
 * schema, so they assume production looks exactly like the local database. It
 * does not: it carries data and objects created by earlier states of the schema.
 * Guarding every statement makes that difference harmless, and lets
 * `scripts/prisma-deploy.mjs` re-run a failed migration instead of bricking the
 * pipeline.
 *
 * Migrations already applied in production before this rule are frozen: editing
 * them would change their checksum, so they are exempt.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'prisma', 'migrations');

/** Applied in production before the rule existed — never edit these. */
const FROZEN_THROUGH = '20260914170000_package_shipment_fields';

interface Rule {
  /** Matches something that must NOT appear outside a guard. */
  pattern: RegExp;
  problem: string;
  fix: string;
}

const RULES: Rule[] = [
  {
    pattern: /\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i,
    problem: 'CREATE TABLE without IF NOT EXISTS',
    fix: 'CREATE TABLE IF NOT EXISTS "X" (...)',
  },
  {
    pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)/i,
    problem: 'CREATE INDEX without IF NOT EXISTS',
    fix: 'CREATE INDEX IF NOT EXISTS "X" ON ...',
  },
  {
    pattern: /\bCREATE\s+EXTENSION\s+(?!IF\s+NOT\s+EXISTS)/i,
    problem: 'CREATE EXTENSION without IF NOT EXISTS',
    fix: 'CREATE EXTENSION IF NOT EXISTS "x"',
  },
  {
    pattern: /\bCREATE\s+TYPE\b/i,
    problem: 'CREATE TYPE (PostgreSQL has no IF NOT EXISTS for it)',
    fix: 'wrap it in DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = \'x\') THEN CREATE TYPE ... END IF; END $$;',
  },
  {
    pattern: /\bDROP\s+(?:CONSTRAINT|INDEX|TRIGGER|VIEW|SEQUENCE|TYPE|FUNCTION)\s+(?!IF\s+EXISTS)/i,
    problem: 'DROP without IF EXISTS',
    fix: 'DROP ... IF EXISTS "X"',
  },
  {
    pattern: /\bADD\s+CONSTRAINT\b/i,
    problem: 'ADD CONSTRAINT outside a guard (this is what broke production)',
    fix: "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'X') THEN ALTER TABLE ... ADD CONSTRAINT ... END IF; END $$;",
  },
  {
    pattern: /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i,
    problem: 'ADD COLUMN without IF NOT EXISTS',
    fix: 'ALTER TABLE "X" ADD COLUMN IF NOT EXISTS "y" ...',
  },
  {
    pattern: /\bRENAME\b/i,
    problem: 'RENAME outside a guard (it fails on the second run)',
    fix: 'wrap it in DO $$ BEGIN IF EXISTS (old) AND NOT EXISTS (new) THEN ... END IF; END $$;',
  },
];

/** Forbidden everywhere, guard or not: migrations are additive (AGENTS.md). */
const DESTRUCTIVE: Rule[] = [
  { pattern: /\bDROP\s+TABLE\b/i, problem: 'DROP TABLE', fix: 'migrations must be additive' },
  { pattern: /\bDROP\s+COLUMN\b/i, problem: 'DROP COLUMN', fix: 'migrations must be additive' },
  { pattern: /\bTRUNCATE\b/i, problem: 'TRUNCATE', fix: 'migrations must be additive' },
  { pattern: /\bDELETE\s+FROM\b/i, problem: 'DELETE FROM', fix: 'migrations must be additive' },
];

function listMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => {
      const dir = path.join(MIGRATIONS_DIR, name);
      return statSync(dir).isDirectory() && readdirSync(dir).includes('migration.sql');
    })
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }));
}

/** Drops `--` comments and lifts out DO $$ ... $$ blocks (statements inside carry their own guard). */
function split(sql: string): { plain: string; blocks: string[] } {
  const withoutComments = sql.replace(/--[^\n]*/g, '');
  const blocks: string[] = [];
  const plain = withoutComments.replace(/DO\s*\$\$[\s\S]*?\$\$\s*;?/gi, (block) => {
    blocks.push(block);
    return '\n';
  });
  return { plain, blocks };
}

/** Reports the offending line so the failure message points at the real spot. */
function locate(sql: string, pattern: RegExp): string {
  const line = sql
    .split('\n')
    .map((l) => l.trim())
    .find((l) => pattern.test(l) && !l.startsWith('--'));
  return line ? line.slice(0, 160) : '(see file)';
}

const migrations = listMigrations();
const guarded = migrations.filter((m) => m.name > FROZEN_THROUGH);

describe('prisma migrations', () => {
  it('finds the migrations directory', () => {
    expect(migrations.length).toBeGreaterThan(0);
    expect(guarded.length).toBeGreaterThan(0);
  });

  describe.each(guarded.map((m) => [m.name, m.sql] as const))('%s', (name, sql) => {
    const { plain, blocks } = split(sql);

    it('is re-runnable: every statement is guarded', () => {
      const problems = RULES.filter((rule) => rule.pattern.test(plain)).map(
        (rule) => `${rule.problem}\n    → ${locate(sql, rule.pattern)}\n    fix: ${rule.fix}`
      );
      expect(
        problems,
        `${name}/migration.sql must survive a second run against production:\n  ${problems.join('\n  ')}`
      ).toEqual([]);
    });

    it('guards every DO block with an existence check', () => {
      const unguarded = blocks.filter((block) => !/IF\s+(?:NOT\s+)?EXISTS/i.test(block));
      expect(unguarded.map((b) => b.slice(0, 120)), `${name}: a DO block runs unconditionally`).toEqual([]);
    });

    it('adds foreign keys NOT VALID so existing rows never block the deploy', () => {
      const fks = (sql.match(/ADD\s+CONSTRAINT[\s\S]*?FOREIGN\s+KEY[\s\S]*?;/gi) ?? []).filter(
        (fk) => !/NOT\s+VALID/i.test(fk)
      );
      expect(
        fks.map((fk) => fk.replace(/\s+/g, ' ').slice(0, 160)),
        `${name}: a FOREIGN KEY is validated against existing rows. Production carries synced data that may contain orphans, and a failed validation blocks every later deploy. Append NOT VALID (new writes are still enforced).`
      ).toEqual([]);
    });

    it('is additive', () => {
      const problems = DESTRUCTIVE.filter((rule) => rule.pattern.test(plain) || blocks.some((b) => rule.pattern.test(b))).map(
        (rule) => `${rule.problem} — ${rule.fix}`
      );
      expect(problems, `${name}: ${problems.join('; ')}`).toEqual([]);
    });
  });

  it('never edits a migration already applied in production', () => {
    // Guard against the frozen marker being moved forward by mistake.
    expect(migrations.some((m) => m.name === FROZEN_THROUGH)).toBe(true);
  });
});
