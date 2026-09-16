import { LoadingState } from '@/components/patterns/LoadingState';

/** Skeleton of a Contabilidad management page while its data loads. */
export default function ContabilidadLoading() {
  return (
    <div className="area-space">
      <LoadingState variant="kpi" rows={3} label="Cargando los saldos de Contabilidad…" />
      <LoadingState variant="table" rows={8} label="Cargando los movimientos…" />
    </div>
  );
}
