import { getCurrentSession } from '@/modules/auth/authorization';
import { getNotifications } from '@/modules/sales/notifications-service';
import { NotificationsPage } from '@/components/sales/NotificationsPage';

export const runtime = 'nodejs';

export default async function NotificationsPageServer() {
  const session = await getCurrentSession();
  if (!session) return null;

  const result = await getNotifications(session.user.id, { page: 1, pageSize: 50 });
  return <NotificationsPage initialData={result} />;
}
