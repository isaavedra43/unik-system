'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function NewManufacturingOrderError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="No pudimos preparar la orden"
      message="Inténtalo de nuevo."
      onRetry={reset}
    />
  );
}
