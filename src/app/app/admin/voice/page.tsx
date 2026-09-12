import { requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { VoiceAdminPanel } from '@/components/voice-admin/VoiceAdminPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function VoiceAdminPage() {
  await requirePermission('calls.admin');

  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Telefonía — Voz y supervisión"
        description="Estado de LiveKit y Twilio, IA por cuenta, catálogo de tareas permitidas, grabación por defecto y retención."
      />
      <VoiceAdminPanel />
    </div>
  );
}
