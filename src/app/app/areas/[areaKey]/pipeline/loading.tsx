import { LoadingState } from '@/components/patterns/LoadingState';

export default function VentasPipelineLoading() {
  return (
    <div className="area-space">
      <LoadingState variant="table" rows={6} label="Cargando el embudo comercial…" />
    </div>
  );
}
