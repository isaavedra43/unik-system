import { LoadingState } from '@/components/patterns/LoadingState';

/** Skeleton of any Control Tower view while its data loads. */
export default function ControlTowerLoading() {
  return (
    <div className="grid gap-4">
      <LoadingState variant="kpi" rows={4} label="Cargando los indicadores de la operación…" />
      <LoadingState variant="table" rows={8} label="Cargando la vista del Control Tower…" />
    </div>
  );
}
