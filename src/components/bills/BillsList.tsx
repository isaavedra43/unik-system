'use client';

import { SimpleListWorkspace, type SimpleListColumn } from '@/components/common/SimpleListWorkspace';
import type { BillListRow } from '@/modules/bills/bills-contract';

interface BillsListProps {
  rows: BillListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
}

export function BillsList({ rows, total, page, pageSize, totalPages, search }: BillsListProps) {
  const columns: SimpleListColumn<BillListRow>[] = [
    { key: 'billNumber', label: 'Folio', href: (row) => `/app/bills/${row.id}` },
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
      basePath="/app/bills"
      entityLabel="Bill"
      entityLabelPlural="Bills"
      columns={columns}
    />
  );
}
