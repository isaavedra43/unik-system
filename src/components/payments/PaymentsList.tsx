'use client';

import { Suspense } from 'react';
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

export function PaymentsList(props: PaymentsListProps) {
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
    <Suspense fallback={<div className="app-content p-8 text-center text-muted-foreground">Cargando...</div>}>
      <SimpleListWorkspace
        {...props}
        basePath="/app/payments"
        entityLabel="Pago"
        entityLabelPlural="Pagos"
        columns={columns}
        syncEnabled
      />
    </Suspense>
  );
}
