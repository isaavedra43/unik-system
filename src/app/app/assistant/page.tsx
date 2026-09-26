import { requirePermission } from '@/modules/auth/authorization';
import { UniversoApp } from '@/components/universo/UniversoApp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  const user = await requirePermission('assistant.use');

  return (
    <div className="assistant-page">
      <UniversoApp
        user={{
          id: user.id,
          name: user.name,
          username: user.username,
          isSuperAdmin: user.isSuperAdmin,
          permissionKeys: [...user.permissionKeys],
        }}
      />
    </div>
  );
}
