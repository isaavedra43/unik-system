'use client';

import Link from 'next/link';
import { ErrorState } from '@/components/patterns/ErrorState';

export default function CaseError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid gap-4">
      <ErrorState
        title="No pudimos cargar el expediente"
        message={`Revisa tu conexión e inténtalo de nuevo. Si el problema sigue, avisa a Administración${
          error.digest ? ` (referencia ${error.digest})` : ''
        }.`}
        onRetry={reset}
      />
      <p className="text-muted text-sm">
        <Link href="/app/operations">Volver a la lista de expedientes</Link>
      </p>
    </div>
  );
}
