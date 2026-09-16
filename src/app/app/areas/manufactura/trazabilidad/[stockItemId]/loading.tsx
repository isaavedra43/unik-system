import { LoadingState } from '@/components/patterns/LoadingState';

export default function TraceLoading() {
  return <LoadingState variant="table" rows={6} label="Cargando la trazabilidad…" />;
}
