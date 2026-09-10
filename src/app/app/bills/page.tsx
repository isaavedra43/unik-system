import { requirePermission } from '@/modules/auth/authorization';
import { getBillsWorkspace } from '@/modules/bills/bills-service';
import { BillsList } from '@/components/bills/BillsList';

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

  return (
    <BillsList
      rows={result.rows}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      totalPages={result.totalPages}
      search={params.search ?? ''}
    />
  );
}
