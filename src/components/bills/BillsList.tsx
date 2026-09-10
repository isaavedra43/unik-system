'use client';

import { Suspense } from 'react';
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

export function BillsList(props: BillsListProps) {
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
    <Suspense fallback={<div className="app-content p-8 text-center text-muted-foreground">Cargando...</div>}>
      <SimpleListWorkspace
        {...props}
        basePath="/app/bills"
        entityLabel="Bill"
        entityLabelPlural="Bills"
        columns={columns}
        syncEnabled
      />
    </Suspense>
  );
}
