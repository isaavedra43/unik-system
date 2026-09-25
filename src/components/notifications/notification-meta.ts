import {
  AtSign,
  Bell,
  Bot,
  Eye,
  Inbox,
  MessageCircle,
  Phone,
  PhoneCall,
  PhoneMissed,
  type LucideIcon,
} from 'lucide-react';

export const CATEGORY_META: Record<string, { icon: LucideIcon; tile: string }> = {
  call_incoming: { icon: Phone, tile: 'bg-success/10 text-success' },
  call_missed: { icon: PhoneMissed, tile: 'bg-destructive/10 text-destructive' },
  call_summary: { icon: PhoneCall, tile: 'bg-info/10 text-info' },
  chat_message: { icon: MessageCircle, tile: 'bg-info/10 text-info' },
  chat_mention: { icon: AtSign, tile: 'bg-info/10 text-info' },
  inbox_message: { icon: Inbox, tile: 'bg-info/10 text-info' },
  inbox_assigned: { icon: Inbox, tile: 'bg-info/10 text-info' },
  ai_task_done: { icon: Bot, tile: 'bg-primary/10 text-primary' },
  ai_user_message: { icon: Bot, tile: 'bg-primary/10 text-primary' },
  entity_change: { icon: Eye, tile: 'bg-warning/10 text-warning' },
  system: { icon: Bell, tile: 'bg-muted text-muted-foreground' },
};
export const FALLBACK_META = { icon: Bell, tile: 'bg-muted text-muted-foreground' };

export function notificationMeta(category: string) {
  return CATEGORY_META[category] ?? FALLBACK_META;
}

export function relativeTime(value: string): string {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `hace ${days} d`;
  try {
    return date.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return value;
  }
}
