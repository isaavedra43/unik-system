import { Suspense } from 'react';
import { requirePermission } from '@/modules/auth/authorization';
import { getPaymentsWorkspace } from '@/modules/payments/payments-service';
import { SimpleListWorkspace, type SimpleListColumn } from '@/components/common/SimpleListWorkspace';
import type { PaymentListRow } from '@/modules/payments/payments-contract';

export const runtime = 'nodejs';

interface SearchParams { search?: string; page?: string; page_size?: string }

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission('payments.view');
  const params = await searchParams;

  const result = await getPaymentsWorkspace({
    search: params.search ?? '',
    page: params.page ? Number(params.page) : 1,
    pageSize: params.page_size ? Number(params.page_size) : 50,
  });

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
        rows={result.rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        totalPages={result.totalPages}
        search={params.search ?? ''}
        basePath="/app/payments"
        entityLabel="Pago"
        entityLabelPlural="Pagos"
        columns={columns}
      />
    </Suspense>
  );
}
