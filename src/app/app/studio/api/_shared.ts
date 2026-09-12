import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { StorageError } from '@/modules/storage/storage-service';
import { StudioContentError } from '@/modules/studio/studio-content';
import { StudioError } from '@/modules/studio/studio-service';
// Registers the `studio_document` upload target and the `document` file access resolver.
import '@/modules/studio/studio-storage-access';

/** Session + permission guard shared by every studio route (deny by default). */
export async function requireStudio(
  permission: 'studio.use' | 'studio.approve' = 'studio.use'
): Promise<{ user: CurrentUser } | { response: NextResponse }> {
  const session = await getCurrentSession();
  if (!session) {
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  }
  if (!hasPermission(session.user, 'studio.use') || !hasPermission(session.user, permission)) {
    return { response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }) };
  }
  return { user: session.user };
}

/** Stable JSON errors; internals are never leaked. */
export function studioErrorResponse(err: unknown): NextResponse {
  if (err instanceof StudioError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof StorageError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof StudioContentError) {
    return NextResponse.json({ error: err.message, code: 'invalid' }, { status: 400 });
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return NextResponse.json(
      {
        error: `Datos inválidos${issue ? `: ${issue.path.join('.')} ${issue.message}` : ''}`,
        code: 'invalid',
      },
      { status: 400 }
    );
  }
  console.error('[studio-api]', err instanceof Error ? err.message : err);
  return NextResponse.json({ error: 'Error interno del estudio' }, { status: 500 });
}

export async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new StudioError('El cuerpo debe ser JSON', 'invalid', 400);
  }
}
