import { getCurrentSession } from '@/modules/auth/authorization';
import { getNotifications } from '@/modules/notifications/notification-service';
import { NotificationsPage } from '@/components/notifications/NotificationsPage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function NotificationsPageServer() {
  const session = await getCurrentSession();
  if (!session) return null;

  const result = await getNotifications(session.user.id, { page: 1, pageSize: 100 });
  return <NotificationsPage userId={session.user.id} initialData={result} />;
}
