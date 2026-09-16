'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function TripError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState title="No pudimos cargar el viaje" message="Inténtalo de nuevo." onRetry={reset} />
  );
}
