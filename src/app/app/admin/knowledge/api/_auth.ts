import { NextResponse } from 'next/server';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { KnowledgeError } from '@/modules/copilot/knowledge-service';
import { ZodError } from 'zod';
import '@/modules/jobs/register-handlers';

export async function requireKnowledgeAdmin(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'knowledge.manage'))
    return { response: NextResponse.json({ error: 'Sin permiso' }, { status: 403 }) };
  return { user: session.user };
}

export function knowledgeError(err: unknown): NextResponse {
  if (err instanceof KnowledgeError)
    return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError)
    return NextResponse.json({ error: 'Datos inválidos', details: err.issues }, { status: 400 });
  console.error('[knowledge-api]', err instanceof Error ? err.message : err);
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}
