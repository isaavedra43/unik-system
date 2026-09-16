import { LoadingState } from '@/components/patterns/LoadingState';

/** Skeleton of any area space while its data loads. */
export default function AreaSpaceLoading() {
  return (
    <div className="area-space">
      <LoadingState variant="kpi" rows={4} label="Cargando los indicadores del área…" />
      <LoadingState variant="table" rows={8} label="Cargando el trabajo del área…" />
    </div>
  );
}
