import { LoadingState } from '@/components/patterns/LoadingState';
import { PageHeader } from '@/components/ui/composite';

export default function MyWorkLoading() {
  return (
    <div className="grid gap-4">
      <PageHeader
        title="Mi trabajo"
        description="Lo que tienes a cargo y lo que cubres como suplente, ordenado por vencimiento."
      />
      <LoadingState variant="kpi" rows={4} label="Cargando tus indicadores…" />
      <LoadingState variant="table" rows={6} label="Cargando tus pendientes…" />
    </div>
  );
}
