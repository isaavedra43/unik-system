'use client';

import { SimpleListWorkspace, type SimpleListColumn } from '@/components/common/SimpleListWorkspace';
import type { VendorCreditListRow } from '@/modules/vendor-credits/vendor-credits-contract';

interface VendorCreditsListProps {
  rows: VendorCreditListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
}

export function VendorCreditsList({ rows, total, page, pageSize, totalPages, search }: VendorCreditsListProps) {
  const columns: SimpleListColumn<VendorCreditListRow>[] = [
    { key: 'vendorCreditNumber', label: 'Folio', href: (row) => `/app/vendor-credits/${row.id}` },
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
      basePath="/app/vendor-credits"
      entityLabel="Crédito de Proveedor"
      entityLabelPlural="Créditos de Proveedor"
      columns={columns}
    />
  );
}
