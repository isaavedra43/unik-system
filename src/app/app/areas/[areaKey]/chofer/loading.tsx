import { LoadingState } from '@/components/patterns/LoadingState';

export default function DriverLoading() {
  return <LoadingState variant="table" rows={5} label="Cargando las entregas de hoy…" />;
}
