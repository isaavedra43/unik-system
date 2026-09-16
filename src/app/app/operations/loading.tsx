import { LoadingState } from '@/components/patterns/LoadingState';

/** Skeleton of the case list while the first page loads. */
export default function OperationsLoading() {
  return (
    <div className="grid gap-4">
      <LoadingState variant="table" rows={8} label="Cargando los expedientes…" />
    </div>
  );
}
