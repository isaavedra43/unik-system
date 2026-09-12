import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentSession, hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { QuoteError } from '@/modules/quotes/quotes-service';

/** quotes.use or quotes.approve may read/draft; approval routes re-check quotes.approve themselves. */
export async function requireQuotesUser(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  const user = session.user;
  if (!hasPermission(user, 'quotes.use') && !hasPermission(user, 'quotes.approve')) {
    return {
      response: NextResponse.json({ error: 'Sin permiso para cotizaciones' }, { status: 403 }),
    };
  }
  return { user };
}

export async function requireQuotesApprover(): Promise<
  { user: CurrentUser } | { response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session)
    return { response: NextResponse.json({ error: 'No autenticado' }, { status: 401 }) };
  if (!hasPermission(session.user, 'quotes.approve')) {
    return {
      response: NextResponse.json(
        { error: 'Sin permiso para aprobar cotizaciones' },
        { status: 403 }
      ),
    };
  }
  return { user: session.user };
}

export function quoteErrorResponse(err: unknown): NextResponse {
  if (err instanceof QuoteError)
    return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    return NextResponse.json({ error: 'Datos inválidos', details: err.issues }, { status: 400 });
  }
  if (err instanceof SyntaxError)
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  console.error('[quotes-api]', err instanceof Error ? err.message : err);
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}
