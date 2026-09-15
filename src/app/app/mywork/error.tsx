'use client';

import { ErrorState } from '@/components/patterns/ErrorState';
import { PageHeader } from '@/components/ui/composite';

export default function MyWorkError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid gap-4">
      <PageHeader title="Mi trabajo" />
      <ErrorState
        title="No pudimos cargar Mi trabajo"
        message={`Revisa tu conexión e inténtalo de nuevo. Si el problema sigue, avisa a Administración${
          error.digest ? ` (referencia ${error.digest})` : ''
        }.`}
        onRetry={reset}
      />
    </div>
  );
}
