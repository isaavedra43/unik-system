'use client';

import { ErrorState } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/ui/composite';

export default function OperationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid gap-4">
      <PageHeader title="Expedientes" />
      <ErrorState
        title="No pudimos cargar los expedientes"
        message={`Revisa tu conexión e inténtalo de nuevo. Si el problema sigue, avisa a Administración${
          error.digest ? ` (referencia ${error.digest})` : ''
        }.`}
        onRetry={reset}
      />
    </div>
  );
}
