import { LoadingState } from '@/components/patterns/LoadingState';

export default function TripLoading() {
  return <LoadingState variant="table" rows={5} label="Cargando el viaje…" />;
}
