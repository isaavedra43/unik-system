'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react';
import {
  AtSign,
  Bell,
  BellRing,
  Bot,
  Check,
  CheckCheck,
  ChevronRight,
  Eye,
  Inbox,
  MessageCircle,
  Phone,
  PhoneCall,
  PhoneMissed,
  Settings,
  Smartphone,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/shadcn/button';
import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';
import { duration, ease } from '@/lib/motion/presets';
import type { NotificationRow } from '@/modules/notifications/notification-service';
import { NOTIFICATION_CATALOG } from '@/modules/notifications/catalog';
import { useNotificationStream } from './useNotificationStream';
import { usePushSubscription } from './usePushSubscription';

interface NotificationsPageProps {
  userId: string;
  initialData: { data: NotificationRow[]; total: number; unread: number };
}

type Filter = 'all' | 'unread';

const GROUP_ICONS: Record<string, LucideIcon> = {
  Llamadas: Phone,
  Mensajes: MessageCircle,
  'Asistente IA': Bot,
  Seguimiento: Eye,
  Sistema: Bell,
};

const CATEGORY_META: Record<string, { icon: LucideIcon; tile: string }> = {
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
const FALLBACK_META = { icon: Bell, tile: 'bg-muted text-muted-foreground' };

const GROUPS = [...new Set(NOTIFICATION_CATALOG.map((c) => c.group))];

const itemVariants: Variants = {
  initial: { opacity: 0, y: 6 },
  animate: (index: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: duration.normal, ease: ease.out, delay: Math.min(index * 0.025, 0.3) },
  }),
  exit: { opacity: 0, transition: { duration: duration.fast } },
};

function relativeTime(value: string): string {
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

function dayLabel(value: string): string {
  const date = new Date(value);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (diffDays <= 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  try {
    const label = date.toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    return label.charAt(0).toUpperCase() + label.slice(1);
  } catch {
    return 'Anteriores';
  }
}

export function NotificationsPage({ userId, initialData }: NotificationsPageProps) {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const [notifications, setNotifications] = useState(initialData.data);
  const [filter, setFilter] = useState<Filter>('all');
  const [group, setGroup] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { unread, setUnread, latest } = useNotificationStream(userId, { toasts: false });
  const push = usePushSubscription();

  // Live: prepend new rows as they arrive on the SSE channel.
  useEffect(() => {
    if (!latest) return;
    setNotifications((prev) => (prev.some((n) => n.id === latest.id) ? prev : [latest, ...prev]));
  }, [latest]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page_size: '100' });
      if (filter === 'unread') params.set('unread', 'true');
      const res = await fetch(`/app/notifications/api?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) {
        const json = (await res.json()) as { data: NotificationRow[]; unread: number };
        setNotifications(json.data);
        setUnread(json.unread);
      }
    } finally {
      setLoading(false);
    }
  }, [filter, setUnread]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const categoriesInGroup = group
      ? new Set(NOTIFICATION_CATALOG.filter((c) => c.group === group).map((c) => c.key as string))
      : null;
    return notifications.filter((n) => {
      if (filter === 'unread' && n.readAt) return false;
      if (categoriesInGroup && !categoriesInGroup.has(n.category)) return false;
      return true;
    });
  }, [notifications, filter, group]);

  const groupUnread = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of notifications) {
      if (n.readAt) continue;
      const g = NOTIFICATION_CATALOG.find((c) => c.key === n.category)?.group;
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return counts;
  }, [notifications]);

  const sections = useMemo(() => {
    const map = new Map<string, NotificationRow[]>();
    for (const n of visible) {
      const key = dayLabel(n.createdAt);
      map.set(key, [...(map.get(key) ?? []), n]);
    }
    return [...map.entries()];
  }, [visible]);

  const markRead = useCallback(
    async (id: string) => {
      setNotifications((prev) =>
        prev.map((n) => (n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n))
      );
      setUnread((u) => Math.max(0, u - 1));
      await fetch('/app/notifications/api/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).catch(() => undefined);
    },
    [setUnread]
  );

  const open = async (n: NotificationRow) => {
    if (!n.readAt) void markRead(n.id);
    if (n.url) router.push(n.url);
  };

  const markAll = async () => {
    const res = await fetch('/app/notifications/api/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    if (res.ok) {
      setNotifications((prev) =>
        prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))
      );
      setUnread(0);
      toast.success('Todas las notificaciones marcadas como leídas');
    } else {
      toast.error('No se pudo marcar como leídas');
    }
  };

  const showPushBanner = push.status === 'prompt' || push.status === 'needs_install';
  const showSkeleton = loading && visible.length === 0;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight sm:text-2xl">
            Notificaciones
            {unread > 0 ? (
              <motion.span
                key={unread}
                initial={reduceMotion ? false : { scale: 0.7, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={ease.spring}
                className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground"
              >
                {unread > 99 ? '99+' : unread}
              </motion.span>
            ) : null}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {unread > 0 ? `${unread} sin leer — toca una para abrirla` : 'Todo al día'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unread > 0 ? (
            <Button variant="outline" size="sm" onClick={markAll} type="button">
              <CheckCheck /> Marcar todo leído
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" asChild>
            <Link href="/app/account/notifications">
              <Settings /> Configurar
            </Link>
          </Button>
        </div>
      </header>

      <AnimatePresence>
        {showPushBanner ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: duration.normal, ease: ease.out }}
            className="flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/[0.06] p-4 sm:flex-row sm:items-center"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Smartphone className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Recibe avisos en este dispositivo</p>
              <p className="text-sm text-muted-foreground">
                {push.status === 'needs_install'
                  ? 'En iPhone primero agrega UNIK a la pantalla de inicio (Compartir → “Agregar a inicio”) y ábrela desde ahí.'
                  : 'Llamadas, mensajes y tareas de la IA te llegarán aunque la app esté cerrada.'}
              </p>
            </div>
            {push.status === 'prompt' ? (
              <Button
                size="sm"
                className="shrink-0"
                onClick={() =>
                  void push
                    .subscribe()
                    .then((ok) => ok && toast.success('Notificaciones activadas'))
                }
                disabled={push.busy}
              >
                <BellRing /> Activar
              </Button>
            ) : (
              <Button variant="secondary" size="sm" className="shrink-0" asChild>
                <Link href="/app/account/notifications">Cómo instalar</Link>
              </Button>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="flex flex-col gap-3">
        <div
          className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1"
          role="tablist"
          aria-label="Filtro"
        >
          {(
            [
              { key: 'all', label: 'Todas' },
              { key: 'unread', label: 'No leídas' },
            ] as const
          ).map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                filter === f.key
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {f.label}
              {f.key === 'unread' && unread > 0 ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-px text-xs font-semibold',
                    filter === 'unread'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted-foreground/15 text-muted-foreground'
                  )}
                >
                  {unread}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1.5" aria-label="Tipo">
          <FilterChip active={group === null} onClick={() => setGroup(null)}>
            Todo
          </FilterChip>
          {GROUPS.map((g) => {
            const Icon = GROUP_ICONS[g] ?? Bell;
            const count = groupUnread.get(g) ?? 0;
            return (
              <FilterChip
                key={g}
                active={group === g}
                onClick={() => setGroup(group === g ? null : g)}
              >
                <Icon className="size-3.5" />
                {g}
                {count > 0 ? (
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-px text-[0.6875rem] font-semibold leading-4',
                      group === g
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted-foreground/15 text-muted-foreground'
                    )}
                  >
                    {count}
                  </span>
                ) : null}
              </FilterChip>
            );
          })}
        </div>
      </div>

      <div aria-busy={loading}>
        {showSkeleton ? (
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3.5">
                <Skeleton className="mt-0.5 size-9 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-2.5 w-16" />
                </div>
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: duration.normal, ease: ease.out }}
            className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center"
          >
            <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Bell className="size-7" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">
                {filter === 'unread' ? 'Nada pendiente' : 'Sin notificaciones'}
              </h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Aquí verás llamadas, mensajes, avisos de la IA y cambios en lo que sigues.
              </p>
            </div>
            {filter !== 'all' || group !== null ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilter('all');
                  setGroup(null);
                }}
              >
                Ver todas
              </Button>
            ) : null}
          </motion.div>
        ) : (
          sections.map(([label, items]) => (
            <section key={label} className="mb-5 last:mb-0">
              <h2 className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
              </h2>
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                <AnimatePresence initial={false}>
                  {items.map((n, i) => (
                    <NotificationItem
                      key={n.id}
                      n={n}
                      index={i}
                      onOpen={open}
                      onMarkRead={markRead}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function NotificationItem({
  n,
  index,
  onOpen,
  onMarkRead,
}: {
  n: NotificationRow;
  index: number;
  onOpen: (n: NotificationRow) => void;
  onMarkRead: (id: string) => void;
}) {
  const meta = CATEGORY_META[n.category] ?? FALLBACK_META;
  const Icon = meta.icon;
  const isUnread = n.readAt === null;

  return (
    <motion.div
      variants={itemVariants}
      custom={index}
      initial="initial"
      animate="animate"
      exit="exit"
      layout="position"
      role={n.url ? 'link' : undefined}
      tabIndex={0}
      onClick={() => void onOpen(n)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          void onOpen(n);
        }
      }}
      className={cn(
        'group relative flex items-start gap-3 px-4 py-3.5 transition-colors',
        'hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:outline-none',
        n.url && 'cursor-pointer',
        isUnread && 'bg-primary/[0.04]'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg',
          meta.tile
        )}
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {isUnread ? (
            <span
              className="size-2 shrink-0 rounded-full bg-primary"
              role="img"
              aria-label="Sin leer"
            />
          ) : null}
          <p
            className={cn(
              'truncate text-sm',
              isUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground/90'
            )}
          >
            {n.title}
          </p>
        </div>
        {n.body ? (
          <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{n.body}</p>
        ) : null}
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{relativeTime(n.createdAt)}</span>
          {n.url ? (
            <span className="inline-flex items-center gap-0.5 font-medium text-primary">
              Abrir
              <ChevronRight className="size-3" />
            </span>
          ) : null}
        </div>
      </div>
      {isUnread ? (
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label="Marcar como leída"
          className="shrink-0 text-muted-foreground sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            void onMarkRead(n.id);
          }}
        >
          <Check />
        </Button>
      ) : null}
    </motion.div>
  );
}
