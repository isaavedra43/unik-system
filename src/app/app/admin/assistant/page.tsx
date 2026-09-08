import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { AssistantAdminPanel } from '@/components/assistant/admin/AssistantAdminPanel';
import { PageHeader } from '@/components/ui/composite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AssistantAdminPage() {
  const session = await getCurrentSession();
  if (!session) {
    return (
      <div className="assistant-admin-page">
        <PageHeader title="Asistente IA — Administración" />
        <div className="assistant-admin-error">No autenticado</div>
      </div>
    );
  }

  const canManage = session.user.isSuperAdmin || hasPermission(session.user, 'assistant.admin');
  if (!canManage) {
    return (
      <div className="assistant-admin-page">
        <PageHeader title="Asistente IA — Administración" />
        <div className="assistant-admin-error">Sin permiso para administrar el asistente</div>
      </div>
    );
  }

  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Asistente IA — Administración"
        description="Monitorea, configura y supervisa el asistente de IA de UNIK."
      />
      <AssistantAdminPanel canManage={canManage} />
    </div>
  );
}
