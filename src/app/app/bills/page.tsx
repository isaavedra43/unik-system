import { requirePermission } from '@/modules/auth/authorization';
import { getBillsWorkspace } from '@/modules/bills/bills-service';
import { SimpleListWorkspace, type SimpleListColumn } from '@/components/common/SimpleListWorkspace';
import type { BillListRow } from '@/modules/bills/bills-contract';

export const runtime = 'nodejs';

interface SearchParams { search?: string; page?: string; page_size?: string }

export default async function BillsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission('bills.view');
  const params = await searchParams;

  const result = await getBillsWorkspace({
    search: params.search ?? '',
    page: params.page ? Number(params.page) : 1,
    pageSize: params.page_size ? Number(params.page_size) : 50,
  });

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
      rows={result.rows}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      totalPages={result.totalPages}
      search={params.search ?? ''}
      basePath="/app/bills"
      entityLabel="Bill"
      entityLabelPlural="Bills"
      columns={columns}
    />
  );
}
