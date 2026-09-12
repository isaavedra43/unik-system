import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { CommsError } from '@/modules/comms/comms-errors';
import { ConnectionError } from '@/modules/extensions/connections-service';
import { EgressError } from '@/modules/extensions/safe-fetch';
import { StorageError } from '@/modules/storage/storage-service';
// Registers channel adapters, upload targets and file access resolvers.
import '@/modules/comms/comms-jobs';

export async function requireInboxUser(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'inbox.use') && !hasPermission(session.user, 'inbox.admin')) {
    return {
      response: NextResponse.json({ error: 'Sin permiso para la bandeja' }, { status: 403 }),
    };
  }
  return { user: session.user };
}

export async function requireRequestsUser(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'requests.use') && !hasPermission(session.user, 'inbox.admin')) {
    return {
      response: NextResponse.json({ error: 'Sin permiso para solicitudes' }, { status: 403 }),
    };
  }
  return { user: session.user };
}

export async function requireInboxAdmin(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'inbox.admin')) {
    return {
      response: NextResponse.json(
        { error: 'Sin permiso para administrar canales' },
        { status: 403 }
      ),
    };
  }
  return { user: session.user };
}

export function commsErrorResponse(err: unknown): NextResponse {
  if (err instanceof CommsError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: 'Datos inválidos', details: err.issues }, { status: 400 });
  }
  if (err instanceof StorageError || err instanceof ConnectionError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof EgressError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 502 });
  }
  const message = err instanceof Error ? err.message : 'Error desconocido';
  console.error('[comms-api]', message);
  // Configuration problems must be visible to the administrator instead of a bare 500.
  if (/UNIK_SECRETS_MASTER_KEY/.test(message)) {
    return NextResponse.json(
      {
        error:
          'UNIK_SECRETS_MASTER_KEY falta o no es válida: debe ser una clave de 32 bytes en base64 (openssl rand -base64 32). Corrígela en Railway y redespliega.',
      },
      { status: 503 }
    );
  }
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P2021' || err.code === 'P2022')
  ) {
    return NextResponse.json(
      {
        error:
          'La base de datos no tiene las tablas nuevas: falta aplicar las migraciones (npx prisma migrate deploy en el Pre-deploy de Railway).',
      },
      { status: 503 }
    );
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return NextResponse.json({ error: 'No se pudo conectar a la base de datos' }, { status: 503 });
  }
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CommsError('JSON inválido', 400);
  }
}
