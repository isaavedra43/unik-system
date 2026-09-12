import { hasPermission, requireAnyPermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { CampaignsWorkspace } from '@/components/campaigns/CampaignsWorkspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const user = await requireAnyPermission([
    'campaigns.view',
    'campaigns.manage',
    'campaigns.approve',
  ]);
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Campañas"
        description="Envíos masivos por WhatsApp, SMS y Telegram con audiencia y contenido congelados, consentimiento verificado, ensayo, presupuesto y aprobación humana."
      />
      <CampaignsWorkspace
        canManage={hasPermission(user, 'campaigns.manage')}
        canApprove={hasPermission(user, 'campaigns.approve')}
      />
    </div>
  );
}
