import { LoadingState } from '@/components/patterns/LoadingState';

export default function FleetLoading() {
  return <LoadingState variant="table" rows={6} label="Cargando la flota…" />;
}
