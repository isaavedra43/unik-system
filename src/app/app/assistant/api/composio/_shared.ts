import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ComposioError } from '@/modules/composio/composio-client';

export function composioErrorResponse(err: unknown): NextResponse {
  if (err instanceof ComposioError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json({ error: 'Datos inválidos', details: err.issues }, { status: 400 });
  }
  console.error('[composio-api]', err instanceof Error ? err.message : err);
  return NextResponse.json({ error: 'Error interno' }, { status: 500 });
}
