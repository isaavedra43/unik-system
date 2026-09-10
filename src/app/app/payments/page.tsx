import { requirePermission } from '@/modules/auth/authorization';
import { getPaymentsWorkspace } from '@/modules/payments/payments-service';
import { PaymentsList } from '@/components/payments/PaymentsList';

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

  return (
    <PaymentsList
      rows={result.rows}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      totalPages={result.totalPages}
      search={params.search ?? ''}
    />
  );
}
