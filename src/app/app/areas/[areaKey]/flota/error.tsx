'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function FleetError({ reset }: { error: Error; reset: () => void }) {
  return (
    <ErrorState title="No pudimos cargar la flota" message="Inténtalo de nuevo." onRetry={reset} />
  );
}
