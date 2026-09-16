import { LoadingState } from '@/components/patterns/LoadingState';

export default function InventoryLocationsLoading() {
  return (
    <div className="area-space">
      <LoadingState variant="table" rows={6} label="Cargando las bodegas y ubicaciones…" />
    </div>
  );
}
