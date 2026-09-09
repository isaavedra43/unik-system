import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { ChatAdminPanel } from '@/components/chat/admin/ChatAdminPanel';
import { PageHeader } from '@/components/ui/composite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function ChatAdminPage() {
  const session = await getCurrentSession();
  if (!session) {
    return (
      <div className="chat-admin-page">
        <PageHeader title="Chat — Administración" />
        <div className="chat-admin-error">No autenticado</div>
      </div>
    );
  }

  const canManage = session.user.isSuperAdmin || hasPermission(session.user, 'chat.admin');
  if (!canManage) {
    return (
      <div className="chat-admin-page">
        <PageHeader title="Chat — Administración" />
        <div className="chat-admin-error">Sin permiso para administrar el chat</div>
      </div>
    );
  }

  return (
    <div className="chat-admin-page">
      <PageHeader
        title="Chat — Administración"
        description="Supervisa, controla y configura el chat interno de UNIK."
      />
      <ChatAdminPanel canManage={canManage} />
    </div>
  );
}
