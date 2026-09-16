import { LoadingState } from '@/components/patterns/LoadingState';

export default function ManufacturingOrderLoading() {
  return <LoadingState variant="table" rows={6} label="Cargando la orden de producción…" />;
}
