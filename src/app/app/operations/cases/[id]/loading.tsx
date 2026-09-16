import { LoadingState } from '@/components/patterns/LoadingState';

/** Skeleton of the Expediente 360 while its blocks load. */
export default function CaseLoading() {
  return (
    <div className="grid gap-4">
      <LoadingState variant="kpi" rows={3} label="Cargando el expediente…" />
      <LoadingState variant="list" rows={6} label="Cargando los trabajos del expediente…" />
    </div>
  );
}
