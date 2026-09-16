'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function BomError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="No pudimos cargar las listas de materiales"
      message="Inténtalo de nuevo."
      onRetry={reset}
    />
  );
}
