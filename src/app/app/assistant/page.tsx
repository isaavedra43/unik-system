import { requirePermission } from '@/modules/auth/authorization';
import { AssistantPageClient } from '@/components/assistant/AssistantPageClient';
import { PageHeader } from '@/components/ui/composite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  const user = await requirePermission('assistant.use');

  return (
    <div className="assistant-page">
      <PageHeader
        title="Asistente IA"
        description="Conversa con el asistente para consultar tus datos de negocio de forma natural."
      />
      <AssistantPageClient user={user} />
    </div>
  );
}
