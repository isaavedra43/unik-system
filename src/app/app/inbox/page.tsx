import { requirePermission, hasPermission } from '@/modules/auth/authorization';
import { InboxPageClient } from '@/components/inbox/InboxPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  const user = await requirePermission('inbox.use');
  return (
    <InboxPageClient
      user={{
        id: user.id,
        name: user.name,
        roleKeys: user.roleKeys,
        canAssign: hasPermission(user, 'inbox.assign') || hasPermission(user, 'inbox.admin'),
        isAdmin: hasPermission(user, 'inbox.admin'),
      }}
    />
  );
}
