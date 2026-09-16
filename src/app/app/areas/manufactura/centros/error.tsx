'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function CentersError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="No pudimos cargar los centros de trabajo"
      message="Inténtalo de nuevo."
      onRetry={reset}
    />
  );
}
