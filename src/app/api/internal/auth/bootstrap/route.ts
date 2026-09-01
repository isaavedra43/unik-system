import { NextResponse } from 'next/server';
import { z } from 'zod';
import { isInternalApiKeyValid } from '@/lib/internal-api-key';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { runSerializableWithRetry } from '@/lib/prisma-retry';
import { SUPER_ADMIN_ROLE_KEY } from '@/modules/auth/constants';
import { hashPassword, passwordSchema } from '@/modules/auth/password';
import { normalizeUsername, usernameSchema } from '@/modules/auth/username';

export const runtime = 'nodejs';

/**
 * Technical bootstrap endpoint: creates the FIRST super_admin user.
 * Protected by X-UNIK-API-Key and permanently disabled once any user exists.
 * Never returns or logs the password.
 * Runs under a SERIALIZABLE retried transaction to prevent concurrent races.
 */

const bootstrapSchema = z
  .object({
    name: z.string().min(1).max(200),
    username: usernameSchema,
    email: z.string().email().optional(),
    password: passwordSchema,
  })
  .strict();

export async function POST(request: Request) {
  if (!isInternalApiKeyValid(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const parsed = bootstrapSchema.safeParse(rawBody);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return NextResponse.json({ error: firstError?.message ?? 'Invalid request' }, { status: 400 });
  }

  const { name, username, email, password } = parsed.data;
  const passwordHash = await hashPassword(password);

  try {
    const user = await runSerializableWithRetry(prisma, async (tx) => {
      const stillEmpty = (await tx.user.count()) === 0;
      if (!stillEmpty) {
        throw new Error('BOOTSTRAP_RACE');
      }

      const role = await tx.role.upsert({
        where: { key: SUPER_ADMIN_ROLE_KEY },
        create: {
          key: SUPER_ADMIN_ROLE_KEY,
          name: 'Super Administrador',
          description: 'Acceso total al sistema. Rol de sistema, no eliminable.',
          isSystem: true,
        },
        update: {},
      });

      const created = await tx.user.create({
        data: {
          name: name.trim(),
          username: normalizeUsername(username),
          email: email?.trim().toLowerCase() || null,
          passwordHash,
          mustChangePassword: true,
        },
      });

      await tx.userRole.create({
        data: { userId: created.id, roleId: role.id },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: created.id,
          action: 'user.created',
          targetType: 'user',
          targetId: created.id,
          metadata: { bootstrap: true, roleKeys: [SUPER_ADMIN_ROLE_KEY] },
        },
      });

      return created;
    });

    return NextResponse.json(
      {
        status: 'created',
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          mustChangePassword: user.mustChangePassword,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'BOOTSTRAP_RACE') {
      return NextResponse.json({ error: 'Bootstrap already completed' }, { status: 409 });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      // Concurrency conflict: another bootstrap likely succeeded. If it did not,
      // a second attempt (from the retry) would have seen the user and thrown
      // BOOTSTRAP_RACE. Returning 409 is safe because a user now exists or the
      // caller must retry.
      return NextResponse.json({ error: 'Bootstrap already completed' }, { status: 409 });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'Username or email already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Bootstrap failed' }, { status: 500 });
  }
}
