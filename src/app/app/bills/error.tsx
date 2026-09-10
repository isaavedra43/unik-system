'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Bills page error:', error);
  }, [error]);

  return (
    <div className="app-content">
      <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <h1 className="text-2xl font-bold tracking-tight">Error al cargar bills</h1>
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive space-y-2">
            <div><strong>Mensaje:</strong> {error.message}</div>
            {error.digest && <div><strong>Digest:</strong> {error.digest}</div>}
            <div><strong>Stack:</strong> {error.stack?.split('\n').slice(0, 3).join(' ')}</div>
          </div>
          <div className="flex gap-3">
            <button onClick={reset} className="btn btn-primary btn-sm">
              Reintentar
            </button>
            <Link href="/app" className="btn btn-secondary btn-sm">
              Volver al inicio
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
