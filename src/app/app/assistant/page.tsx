import { requirePermission } from '@/modules/auth/authorization';
import { AssistantPageClient } from '@/components/assistant/AssistantPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  const user = await requirePermission('assistant.use');

  return (
    <div className="assistant-page">
      <AssistantPageClient user={user} />
    </div>
  );
}
