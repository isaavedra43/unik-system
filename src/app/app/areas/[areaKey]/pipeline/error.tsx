'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function VentasPipelineError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="area-space">
      <ErrorState
        title="No pudimos cargar el embudo"
        message={error.message || 'Intenta de nuevo; si el problema sigue, avisa a Administración.'}
        onRetry={reset}
      />
    </div>
  );
}
