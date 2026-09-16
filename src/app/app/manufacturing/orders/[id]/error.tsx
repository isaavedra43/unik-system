'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function ManufacturingOrderError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="No pudimos cargar la orden de producción"
      message="Inténtalo de nuevo."
      onRetry={reset}
    />
  );
}
