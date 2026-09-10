'use client';

import { SimpleListWorkspace, type SimpleListColumn } from '@/components/common/SimpleListWorkspace';
import type { PaymentListRow } from '@/modules/payments/payments-contract';

interface PaymentsListProps {
  rows: PaymentListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
}

export function PaymentsList({ rows, total, page, pageSize, totalPages, search }: PaymentsListProps) {
  const columns: SimpleListColumn<PaymentListRow>[] = [
    { key: 'paymentNumber', label: 'Folio', href: (row) => `/app/payments/${row.id}` },
    { key: 'paymentMode', label: 'Modo' },
    { key: 'status', label: 'Estado' },
    { key: 'date', label: 'Fecha', render: (row) => row.date ? new Date(row.date).toLocaleDateString() : '—' },
    { key: 'customerName', label: 'Cliente' },
    { key: 'amount', label: 'Monto', render: (row) => row.amount ?? '—' },
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
      basePath="/app/payments"
      entityLabel="Pago"
      entityLabelPlural="Pagos"
      columns={columns}
    />
  );
}
