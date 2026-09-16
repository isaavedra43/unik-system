import { LoadingState } from '@/components/patterns/LoadingState';

export default function OpportunityDetailLoading() {
  return (
    <div className="area-space">
      <LoadingState variant="list" rows={6} label="Cargando la oportunidad…" />
    </div>
  );
}
