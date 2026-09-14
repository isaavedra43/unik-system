import { requireAuthenticatedUser } from '@/modules/auth/authorization';
import { getNotificationSettings } from '@/modules/notifications/preferences-service';
import { NOTIFICATION_CATALOG } from '@/modules/notifications/catalog';
import { NotificationSettingsPage } from '@/components/notifications/NotificationSettingsPage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function AccountNotificationsPage() {
  const user = await requireAuthenticatedUser();
  const settings = await getNotificationSettings(user.id);
  return <NotificationSettingsPage initialSettings={settings} catalog={NOTIFICATION_CATALOG} />;
}
