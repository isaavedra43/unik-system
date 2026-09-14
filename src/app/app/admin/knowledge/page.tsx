import { requirePermission } from '@/modules/auth/authorization';
import { PageHeader } from '@/components/ui/composite';
import { KnowledgeLibrary } from '@/components/knowledge/KnowledgeLibrary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function KnowledgeAdminPage() {
  await requirePermission('knowledge.manage');
  return (
    <div className="assistant-admin-page">
      <PageHeader
        title="Biblioteca aprobada"
        description="Todo lo que la IA sabe y puede compartir: documentos, hojas de cálculo, páginas web y conexiones. Solo usa lo aprobado y solo envía a clientes lo publicable."
      />
      <KnowledgeLibrary />
    </div>
  );
}
