import { requirePermission } from '@/modules/auth/authorization';
import { getVendorCreditsWorkspace } from '@/modules/vendor-credits/vendor-credits-service';
import { VendorCreditsList } from '@/components/vendor-credits/VendorCreditsList';

export const runtime = 'nodejs';

interface SearchParams { search?: string; page?: string; page_size?: string }

export default async function VendorCreditsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission('vendor_credits.view');
  const params = await searchParams;

  const result = await getVendorCreditsWorkspace({
    search: params.search ?? '',
    page: params.page ? Number(params.page) : 1,
    pageSize: params.page_size ? Number(params.page_size) : 50,
  });

  return (
    <VendorCreditsList
      rows={result.rows}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      totalPages={result.totalPages}
      search={params.search ?? ''}
    />
  );
}
