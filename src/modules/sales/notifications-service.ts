/**
 * @deprecated The notification service moved to `@/modules/notifications`.
 * This file only re-exports so existing imports keep working.
 */
export {
  getUnreadNotificationCount,
  getRecentNotifications,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  type NotificationRow,
} from '@/modules/notifications/notification-service';
