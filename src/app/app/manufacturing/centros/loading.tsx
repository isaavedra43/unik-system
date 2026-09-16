import { LoadingState } from '@/components/patterns/LoadingState';

export default function CentersLoading() {
  return <LoadingState variant="table" rows={6} label="Cargando centros de trabajo…" />;
}
