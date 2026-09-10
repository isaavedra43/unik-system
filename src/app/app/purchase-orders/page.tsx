import { requirePermission } from '@/modules/auth/authorization';
import { getPurchaseOrdersWorkspace } from '@/modules/purchase-orders/purchase-orders-service';
import { PurchaseOrdersList } from '@/components/purchase-orders/PurchaseOrdersList';

export const runtime = 'nodejs';

interface SearchParams { search?: string; page?: string; page_size?: string }

export default async function PurchaseOrdersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission('purchase_orders.view');
  const params = await searchParams;

  const result = await getPurchaseOrdersWorkspace({
    search: params.search ?? '',
    page: params.page ? Number(params.page) : 1,
    pageSize: params.page_size ? Number(params.page_size) : 50,
  });

  return (
    <PurchaseOrdersList
      rows={result.rows}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      totalPages={result.totalPages}
      search={params.search ?? ''}
    />
  );
}
