import { NextResponse } from 'next/server';
import { StorageError } from '@/modules/storage/storage-service';
// Registers upload targets and access resolvers of every module (AI, chat, knowledge, voice…).
import '@/modules/storage/register-access-resolvers';

/** Maps storage/service errors to stable JSON responses without leaking internals. */
export function storageErrorResponse(err: unknown): NextResponse {
  if (err instanceof StorageError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : 'Error desconocido';
  console.error('[files-api]', message);
  return NextResponse.json({ error: 'Error interno de almacenamiento' }, { status: 500 });
}
