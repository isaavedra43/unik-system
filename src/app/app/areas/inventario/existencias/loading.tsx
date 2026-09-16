import { LoadingState } from '@/components/patterns/LoadingState';

export default function InventoryStockLoading() {
  return (
    <div className="area-space">
      <LoadingState variant="table" rows={8} label="Cargando las existencias…" />
    </div>
  );
}
