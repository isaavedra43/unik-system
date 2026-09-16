'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function TraceError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="No pudimos cargar la trazabilidad"
      message="Inténtalo de nuevo."
      onRetry={reset}
    />
  );
}
