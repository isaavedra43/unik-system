'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function OpportunityDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="area-space">
      <ErrorState
        title="No pudimos abrir la oportunidad"
        message={error.message || 'Intenta de nuevo; si el problema sigue, avisa a Administración.'}
        onRetry={reset}
      />
    </div>
  );
}
