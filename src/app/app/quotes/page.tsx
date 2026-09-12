import { hasPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { QuotesWorkspace } from '@/components/quotes/QuotesWorkspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function QuotesPage() {
  const user = await requireAnyPermission(['quotes.use', 'quotes.approve']);
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Cotizaciones"
        description="Borradores con totales exactos, simulación de escenarios, paquete comercial y aprobación humana antes de crear la cotización oficial en Zoho Books."
      />
      <QuotesWorkspace canApprove={hasPermission(user, 'quotes.approve')} currentUserId={user.id} />
    </div>
  );
}
