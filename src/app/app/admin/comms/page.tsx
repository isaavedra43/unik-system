import { requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { CommsAdminPanel } from '@/components/comms-admin/CommsAdminPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CommsAdminPage() {
  await requirePermission('inbox.admin');
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Comunicaciones — Canales"
        description="Números de WhatsApp/SMS (Twilio) y bots de Telegram por equipo, credenciales cifradas, webhooks, directorio de responsables y revisión de contactos duplicados."
      />
      <CommsAdminPanel />
    </div>
  );
}
