import { redirect } from 'next/navigation';
import { requireAnyPermission, hasPermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { IntegrationsPanel } from '@/components/integrations/IntegrationsPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const actor = await requireAnyPermission(['integrations.view']);

  if (!hasPermission(actor, 'integrations.view')) {
    redirect('/app');
  }

  const canManage = hasPermission(actor, 'integrations.manage');

  return (
    <div>
      <PageHeader
        title="Integraciones"
        description="Monitorea y configura las APIs conectadas a UNIK. Llamadas, consumo, frecuencias y errores."
      />
      <IntegrationsPanel canManage={canManage} />
    </div>
  );
}
