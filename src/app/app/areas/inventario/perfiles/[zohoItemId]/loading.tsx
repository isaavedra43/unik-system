import { LoadingState } from '@/components/patterns/LoadingState';

export default function InventoryProfileLoading() {
  return (
    <div className="area-space">
      <LoadingState variant="list" rows={6} label="Cargando el perfil del artículo…" />
    </div>
  );
}
