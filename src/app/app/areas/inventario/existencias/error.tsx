'use client';

import { ErrorState } from '@/components/patterns/ErrorState';

export default function InventoryStockError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="area-space">
      <ErrorState
        title="No pudimos cargar las existencias"
        message={`Revisa tu conexión e inténtalo de nuevo. Si el problema sigue, avisa a Administración${
          error.digest ? ` (referencia ${error.digest})` : ''
        }.`}
        onRetry={reset}
      />
    </div>
  );
}
