import { requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { KnowledgeAdminPanel } from '@/components/copilot/KnowledgeAdminPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function KnowledgeAdminPage() {
  await requirePermission('knowledge.manage');
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Biblioteca aprobada"
        description="Fuentes empresariales con versiones que el asistente puede citar. Nada entra por sí solo: cada versión se procesa y se aprueba aquí. Separa lo interno de lo publicable."
      />
      <KnowledgeAdminPanel />
    </div>
  );
}
