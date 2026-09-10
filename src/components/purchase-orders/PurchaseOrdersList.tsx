'use client';

import { SimpleListWorkspace, type SimpleListColumn } from '@/components/common/SimpleListWorkspace';
import type { PurchaseOrderListRow } from '@/modules/purchase-orders/purchase-orders-contract';

interface PurchaseOrdersListProps {
  rows: PurchaseOrderListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
}

export function PurchaseOrdersList({ rows, total, page, pageSize, totalPages, search }: PurchaseOrdersListProps) {
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
    <SimpleListWorkspace
      rows={rows}
      total={total}
      page={page}
      pageSize={pageSize}
      totalPages={totalPages}
      search={search}
      basePath="/app/purchase-orders"
      entityLabel="Orden de Compra"
      entityLabelPlural="Órdenes de Compra"
      columns={columns}
    />
  );
}
