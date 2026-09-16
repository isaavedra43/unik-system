import { LoadingState } from '@/components/patterns/LoadingState';

export default function BomLoading() {
  return <LoadingState variant="table" rows={6} label="Cargando listas de materiales…" />;
}
