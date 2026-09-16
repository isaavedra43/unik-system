#!/usr/bin/env node
/**
 * Creates a valid `AuthSession` for the super admin of a LOCAL, DISPOSABLE
 * preview database and writes a Playwright `storageState` with its cookie.
 *
 * Why this exists: the visual pass has to browse the real app as a signed-in
 * person, and logging in through the form would mean putting a password in a
 * script. This never touches passwords: it writes the same row `login()` writes
 * (the database only ever stores the SHA-256 of the token) and hands the raw
 * token to the browser in the same cookie the app sets.
 *
 * Refuses to run against anything but `unik_preview` / `unik_schema_check`, so
 * it can never mint a session on the real database.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user@localhost:5432/unik_preview \
 *     node scripts/create-preview-session.mjs [--out <storageState.json>] [--base-url http://localhost:3100]
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PrismaClient } from '@prisma/client';

const ALLOWED_DATABASES = new Set(['unik_preview', 'unik_schema_check']);
/** Same value as `AUTH_SESSION_TTL_HOURS` in src/modules/auth/constants.ts. */
const SESSION_TTL_HOURS = 12;
/** Same value as `SESSION_COOKIE_NAME`. */
const COOKIE_NAME = 'unik_session';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function databaseName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    return '';
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL');
  const name = databaseName(url);
  if (!ALLOWED_DATABASES.has(name)) {
    throw new Error(
      `Este script sólo corre contra bases desechables locales (${[...ALLOWED_DATABASES].join(', ')}); DATABASE_URL apunta a "${name}".`
    );
  }

  const out = arg('--out', 'preview-auth.json');
  const baseUrl = arg('--base-url', 'http://localhost:3100');
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  try {
    // The super admin of the preview database: whoever holds the immutable role.
    const membership = await prisma.userRole.findFirst({
      where: { role: { key: 'super_admin' }, user: { isActive: true, isBot: false } },
      include: { user: { select: { id: true, username: true, name: true } } },
      orderBy: { userId: 'asc' },
    });
    if (!membership) throw new Error('La base de vista previa no tiene ningún super admin activo.');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);
    const session = await prisma.authSession.create({
      data: {
        userId: membership.user.id,
        // Exactly what session-service.ts stores: the raw token never reaches the database.
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt,
      },
      select: { id: true },
    });

    const { hostname } = new URL(baseUrl);
    const storageState = {
      cookies: [
        {
          name: COOKIE_NAME,
          value: token,
          domain: hostname,
          path: '/',
          expires: Math.floor(expiresAt.getTime() / 1000),
          httpOnly: true,
          // The preview server runs over plain HTTP, like `next start` locally.
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    };

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(storageState, null, 2)}\n`);
    console.log(
      JSON.stringify({
        database: name,
        user: membership.user.username,
        sessionId: session.id,
        expiresAt: expiresAt.toISOString(),
        storageState: out,
      })
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
