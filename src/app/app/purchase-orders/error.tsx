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
    console.error('Purchase orders page error:', error);
  }, [error]);

  return (
    <div className="app-content">
      <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="rounded-lg border bg-card p-6 space-y-4">
          <h1 className="text-2xl font-bold tracking-tight">Error al cargar órdenes de compra</h1>
          <p className="text-sm text-muted-foreground">
            Ocurrió un error al cargar este módulo. Esto puede deberse a que la migración de base de datos
            aún no se ha aplicado. Asegúrate de que la migración{' '}
            <code className="px-1 py-0.5 rounded bg-muted text-xs">
              20260910160000_expand_modules_add_payments_po_bills_vendorcredits
            </code>{' '}
            se haya aplicado en Railway.
          </p>
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
