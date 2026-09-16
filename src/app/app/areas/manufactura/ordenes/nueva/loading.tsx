import { LoadingState } from '@/components/patterns/LoadingState';

export default function NewManufacturingOrderLoading() {
  return <LoadingState variant="list" rows={5} label="Preparando la orden de producción…" />;
}
