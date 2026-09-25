import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AuthorizationError } from '@/modules/auth/authorization';

/**
 * One error-to-response mapping for every API route.
 *
 * The rule: a client only sees a message when the thrown error *declared
 * itself* safe to show — either it carries a 4xx `.status` (StorageError,
 * VoiceError, CommsError, …) or its class name was explicitly allow-listed
 * for that route (`ChatError` has no status, the chat API answers 400).
 * Everything else — Prisma internals, network failures, programming bugs —
 * becomes a bare "Error interno": an unknown exception's message can contain
 * SQL, table names, paths or env detail and must never leave the server.
 *
 * Unknown errors are always logged server-side with the route context.
 */
export function apiErrorResponse(
  err: unknown,
  opts: {
    /** Fallback status for allow-listed error names without `.status`. Default 400. */
    status?: number;
    /** Error `name`s whose message may reach the client (e.g. 'ChatError'). */
    safeNames?: readonly string[];
    /** Tag for the server-side log line (route name). */
    context?: string;
  } = {}
): NextResponse {
  if (err instanceof AuthorizationError) {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    console.error(`[api-error${opts.context ? `:${opts.context}` : ''}] DB init`, err.message);
    return NextResponse.json({ error: 'No se pudo conectar a la base de datos' }, { status: 503 });
  }
  if (err instanceof Error) {
    // Domain errors that carry an explicit client-visible 4xx status.
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return NextResponse.json({ error: err.message }, { status });
    }
    // Named domain errors the route opted in to exposing.
    if (opts.safeNames?.includes(err.name)) {
      return NextResponse.json({ error: err.message }, { status: opts.status ?? 400 });
    }
  }
  console.error(`[api-error${opts.context ? `:${opts.context}` : ''}]`, err);
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}
