'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function DriverError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState
      title="No pudimos cargar la aplicación de chofer"
      message="Inténtalo de nuevo."
      onRetry={reset}
    />
  );
}
