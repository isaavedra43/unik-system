import { requireAnyPermission, hasPermission } from '@/modules/auth/authorization';
import { CallsPageClient } from '@/components/calls/CallsPageClient';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function CallsPage() {
  const user = await requireAnyPermission(['calls.use', 'calls.supervise']);
  return (
    <CallsPageClient
      user={user}
      canUse={hasPermission(user, 'calls.use')}
      canSupervise={hasPermission(user, 'calls.supervise')}
    />
  );
}
