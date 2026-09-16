'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function NeuralToolError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="neural-shell">
      <ErrorState
        title="No pudimos abrir esta herramienta"
        message={`Las proyecciones de procesos se recalculan cada 15 minutos; si acaban de crearse las tablas, vuelve a intentarlo en un momento. Si el problema sigue, avisa a Administración${
          error.digest ? ` (referencia ${error.digest})` : ''
        }.`}
        onRetry={reset}
      />
    </div>
  );
}
