'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function ControlTowerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid gap-4">
      <ErrorState
        title="No pudimos cargar esta vista del Control Tower"
        message={`Revisa tu conexión e inténtalo de nuevo. Si el problema sigue, revisa los trabajos de fondo${
          error.digest ? ` (referencia ${error.digest})` : ''
        }.`}
        onRetry={reset}
      />
    </div>
  );
}
