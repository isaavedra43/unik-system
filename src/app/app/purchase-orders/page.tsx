import { Suspense } from 'react';
import { requirePermission } from '@/modules/auth/authorization';
import { getPurchaseOrdersWorkspace } from '@/modules/purchase-orders/purchase-orders-service';
import { SimpleListWorkspace, type SimpleListColumn } from '@/components/common/SimpleListWorkspace';
import type { PurchaseOrderListRow } from '@/modules/purchase-orders/purchase-orders-contract';

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

  const columns: SimpleListColumn<PurchaseOrderListRow>[] = [
    { key: 'purchaseOrderNumber', label: 'Folio', href: (row) => `/app/purchase-orders/${row.id}` },
    { key: 'status', label: 'Estado' },
    { key: 'date', label: 'Fecha', render: (row) => row.date ? new Date(row.date).toLocaleDateString() : '—' },
    { key: 'vendorName', label: 'Proveedor' },
    { key: 'total', label: 'Total', render: (row) => row.total ?? '—' },
    { key: 'balance', label: 'Saldo', render: (row) => row.balance ?? '—' },
    { key: 'currencyCode', label: 'Moneda' },
  ];

  return (
    <Suspense fallback={<div className="app-content p-8 text-center text-muted-foreground">Cargando...</div>}>
      <SimpleListWorkspace
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        totalPages={result.totalPages}
        search={params.search ?? ''}
        basePath="/app/purchase-orders"
        entityLabel="Orden de Compra"
        entityLabelPlural="Órdenes de Compra"
        columns={columns}
      />
    </Suspense>
  );
}
