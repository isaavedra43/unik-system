import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { RequestsPageClient } from '@/components/requests/RequestsPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const user = await requirePermission('requests.use');
  const { id } = await searchParams;
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Solicitudes internas"
        description="Pide algo a otra área con expediente, archivos y seguimiento. Se asigna sola al responsable del área cuando existe."
      />
      <RequestsPageClient
        user={{ id: user.id, name: user.name, isAdmin: hasPermission(user, 'inbox.admin') }}
        initialRequestId={id ?? null}
      />
    </div>
  );
}
