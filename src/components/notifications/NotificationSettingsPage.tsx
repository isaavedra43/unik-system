'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'motion/react';
import {
  Bell,
  BellOff,
  BellRing,
  Laptop,
  Moon,
  Send,
  Share,
  Smartphone,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/shadcn/button';
import { Switch } from '@/components/shadcn/switch';
import { cn } from '@/lib/utils';
import { duration, ease } from '@/lib/motion/presets';
import type { CategoryDefinition } from '@/modules/notifications/catalog';
import type { NotificationSettings } from '@/modules/notifications/preferences-service';
import { usePushSubscription, type PushDevice } from './usePushSubscription';

interface Props {
  initialSettings: NotificationSettings;
  catalog: CategoryDefinition[];
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

function deviceIcon(platform: PushDevice['platform']) {
  return platform === 'desktop' ? <Laptop className="size-4" /> : <Smartphone className="size-4" />;
}

function deviceLabel(device: PushDevice): string {
  const ua = device.userAgent ?? '';
  let name = 'Dispositivo';
  if (device.platform === 'ios') name = /iPad/.test(ua) ? 'iPad' : 'iPhone';
  else if (device.platform === 'android') name = 'Android';
  else if (device.platform === 'desktop') {
    if (/Macintosh/.test(ua)) name = 'Mac';
    else if (/Windows/.test(ua)) name = 'Windows';
    else name = 'Computadora';
  }
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  return `${name}${browser ? ` · ${browser}` : ''}`;
}

export function NotificationSettingsPage({ initialSettings, catalog }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [saving, setSaving] = useState(false);
  const push = usePushSubscription();
  const pending = useRef<Record<string, unknown>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, CategoryDefinition[]>();
    for (const c of catalog) map.set(c.group, [...(map.get(c.group) ?? []), c]);
    return [...map.entries()];
  }, [catalog]);

  /** Debounced PUT: toggles feel instant, one request per burst. */
  const persist = useCallback((patch: Record<string, unknown>) => {
    pending.current = deepMerge(pending.current, patch);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const body = pending.current;
      pending.current = {};
      setSaving(true);
      try {
        const res = await fetch('/app/notifications/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error('save_failed');
        const json = (await res.json()) as { settings: NotificationSettings };
        setSettings(json.settings);
      } catch {
        toast.error('No se pudo guardar la configuración');
      } finally {
        setSaving(false);
      }
    }, 400);
  }, []);

  const setCategory = (key: string, field: 'inApp' | 'push', value: boolean) => {
    setSettings((s) => ({
      ...s,
      categories: {
        ...s.categories,
        [key]: { ...s.categories[key as keyof typeof s.categories], [field]: value },
      },
    }));
    persist({ categories: { [key]: { [field]: value } } });
  };

  const setQuietHours = (start: number | null, end: number | null) => {
    setSettings((s) => ({ ...s, quietHoursStart: start, quietHoursEnd: end }));
    persist({ quietHoursStart: start, quietHoursEnd: end });
  };

  const mute = (hours: number | null) => {
    const until = hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
    setSettings((s) => ({ ...s, mutedUntil: until }));
    persist({ mutedUntil: until });
  };

  const muted = settings.mutedUntil ? new Date(settings.mutedUntil) > new Date() : false;
  const quietOn = settings.quietHoursStart !== null && settings.quietHoursEnd !== null;

  const onTest = async () => {
    const result = await push.sendTest();
    if (result.sent > 0) toast.success('Enviado. Revisa la notificación en tu dispositivo.');
    else if (result.skipped) toast.error('Push no configurado o sin dispositivo registrado.');
    else toast.error('No se pudo enviar. Vuelve a activar las notificaciones en este dispositivo.');
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Mis notificaciones</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Decide qué te avisamos en la app y qué te llega a tus dispositivos.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving ? (
            <span className="text-xs text-muted-foreground" role="status">
              Guardando…
            </span>
          ) : null}
          <Button variant="ghost" size="sm" asChild>
            <Link href="/app/notifications">
              <Bell /> Ver notificaciones
            </Link>
          </Button>
        </div>
      </header>

      <Section title="En este dispositivo" index={0}>
        <PushStatusBlock push={push} onTest={onTest} />
      </Section>

      {push.devices.length > 0 ? (
        <Section title="Tus dispositivos" index={1}>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {push.devices.map((d) => {
              const isCurrent = d.endpoint === push.currentEndpoint;
              return (
                <li key={d.id} className="flex items-center gap-3 px-3.5 py-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    {deviceIcon(d.platform)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {deviceLabel(d)}
                      {isCurrent ? (
                        <span className="rounded-full bg-success/10 px-2 py-px text-[0.6875rem] font-semibold text-success">
                          Este dispositivo
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Registrado {new Date(d.createdAt).toLocaleDateString('es-MX')}
                      {d.lastUsedAt
                        ? ` · último aviso ${new Date(d.lastUsedAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}`
                        : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Quitar ${deviceLabel(d)}`}
                    onClick={() => void push.removeDevice(d.endpoint)}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : null}

      <Section title="Push en general" index={2}>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
            <div className="min-w-0">
              <p className="text-sm font-medium">Enviar avisos a mis dispositivos</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Apaga esto para pausar todos los push sin quitar los dispositivos.
              </p>
            </div>
            <Switch
              checked={settings.pushEnabled}
              onCheckedChange={(v) => {
                setSettings((s) => ({ ...s, pushEnabled: v }));
                persist({ pushEnabled: v });
              }}
              aria-label="Push activado"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <BellOff className="size-4 text-muted-foreground" /> Silenciar temporalmente
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {muted
                  ? `Silenciado hasta ${new Date(settings.mutedUntil!).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}. Las llamadas entrantes siguen sonando.`
                  : 'Pausa los push por un rato. Las llamadas entrantes siguen sonando.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {muted ? (
                <Button variant="secondary" size="sm" onClick={() => mute(null)}>
                  Reactivar
                </Button>
              ) : (
                <>
                  <Button variant="secondary" size="sm" onClick={() => mute(1)}>
                    1 h
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => mute(4)}>
                    4 h
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => mute(24)}>
                    Hasta mañana
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 py-3 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Moon className="size-4 text-muted-foreground" /> Horario silencioso
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Sin push en este rango (hora de {settings.timezone}). Las llamadas entrantes siguen
                sonando.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Switch
                checked={quietOn}
                onCheckedChange={(v) => (v ? setQuietHours(22, 7) : setQuietHours(null, null))}
                aria-label="Horario silencioso"
              />
              {quietOn ? (
                <>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    aria-label="Desde"
                    value={settings.quietHoursStart ?? 22}
                    onChange={(e) => setQuietHours(Number(e.target.value), settings.quietHoursEnd)}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                  <span className="text-sm text-muted-foreground">a</span>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    aria-label="Hasta"
                    value={settings.quietHoursEnd ?? 7}
                    onChange={(e) =>
                      setQuietHours(settings.quietHoursStart, Number(e.target.value))
                    }
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Qué me avisan"
        description="«En la app» es la campana y la lista de notificaciones; «Teléfono» es el push a tus dispositivos."
        index={3}
      >
        <div className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-2 pb-2 sm:grid-cols-[1fr_5rem_5rem]">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Tipo
          </span>
          <span className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            App
          </span>
          <span className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Push
          </span>
        </div>
        {groups.map(([group, items]) => (
          <div key={group}>
            <div className="rounded-md bg-muted/60 px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group}
            </div>
            {items.map((c) => {
              const pref = settings.categories[c.key];
              return (
                <div
                  key={c.key}
                  className="grid grid-cols-[1fr_3.5rem_3.5rem] items-center gap-2 border-b border-border px-1 py-3 last:border-0 sm:grid-cols-[1fr_5rem_5rem] sm:px-2.5"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {c.label}
                      {c.urgent ? (
                        <span className="rounded-full bg-destructive/10 px-1.5 py-px text-[0.625rem] font-semibold uppercase tracking-wide text-destructive">
                          urgente
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{c.description}</p>
                  </div>
                  <div className="flex justify-center">
                    <Switch
                      checked={pref.inApp}
                      disabled={Boolean(c.lockedInApp)}
                      onCheckedChange={(v) => setCategory(c.key, 'inApp', v)}
                      aria-label={`${c.label} en la app`}
                    />
                  </div>
                  <div className="flex justify-center">
                    <Switch
                      checked={pref.push}
                      onCheckedChange={(v) => setCategory(c.key, 'push', v)}
                      aria-label={`${c.label} en el teléfono`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  description,
  index,
  children,
}: {
  title: string;
  description?: string;
  index: number;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: duration.normal,
        ease: ease.out,
        delay: Math.min(index * 0.06, 0.24),
      }}
      className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5"
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </motion.section>
  );
}

function StatusRow({
  tone,
  icon: Icon,
  title,
  children,
  actions,
}: {
  tone: 'ok' | 'warn' | 'info' | 'muted';
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const tones = {
    ok: 'bg-success/10 text-success',
    warn: 'bg-warning/10 text-warning',
    info: 'bg-primary/10 text-primary',
    muted: 'bg-muted text-muted-foreground',
  } as const;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:flex-row sm:items-start">
      <span
        className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', tones[tone])}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        <div className="text-sm text-muted-foreground">{children}</div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

function PushStatusBlock({
  push,
  onTest,
}: {
  push: ReturnType<typeof usePushSubscription>;
  onTest: () => Promise<void>;
}) {
  switch (push.status) {
    case 'loading':
      return (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
          <span className="size-10 animate-pulse rounded-lg bg-muted" />
          <div className="flex-1 space-y-2">
            <span className="block h-3.5 w-40 animate-pulse rounded bg-muted" />
            <span className="block h-3 w-56 animate-pulse rounded bg-muted" />
          </div>
        </div>
      );
    case 'subscribed':
      return (
        <StatusRow
          tone="ok"
          icon={BellRing}
          title="Activas en este dispositivo"
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => void onTest()}>
                <Send /> Enviar prueba
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void push.unsubscribe()}
                disabled={push.busy}
              >
                Desactivar aquí
              </Button>
            </>
          }
        >
          Te llegarán aunque la app esté cerrada. Prueba que todo funcione:
        </StatusRow>
      );
    case 'prompt':
      return (
        <StatusRow
          tone="info"
          icon={Smartphone}
          title="Aún no activas los avisos en este dispositivo"
          actions={
            <Button
              size="sm"
              onClick={() =>
                void push.subscribe().then((ok) => ok && toast.success('Notificaciones activadas'))
              }
              disabled={push.busy}
            >
              <BellRing /> {push.busy ? 'Activando…' : 'Activar'}
            </Button>
          }
        >
          <p>
            Al tocar «Activar» el {push.ios ? 'iPhone' : 'navegador'} te pedirá permiso una sola
            vez.
          </p>
          {push.error ? <p className="text-destructive">{push.error}</p> : null}
        </StatusRow>
      );
    case 'needs_install':
      return (
        <StatusRow tone="warn" icon={Share} title="En iPhone/iPad primero instala UNIK">
          Safari no permite push desde el navegador. Toca <strong>Compartir</strong> (el cuadro con
          la flecha) → <strong>«Agregar a pantalla de inicio»</strong>, abre UNIK desde el ícono y
          vuelve aquí para activar. Requiere iOS 16.4 o más reciente.
        </StatusRow>
      );
    case 'denied':
      return (
        <StatusRow
          tone="warn"
          icon={BellOff}
          title="Permiso bloqueado"
          actions={
            <Button variant="secondary" size="sm" onClick={() => void push.refresh()}>
              Volver a comprobar
            </Button>
          }
        >
          {push.ios
            ? 'Ve a Ajustes → Notificaciones → UNIK y permite las notificaciones; luego recarga esta página.'
            : 'Permite las notificaciones para este sitio desde el candado de la barra de direcciones (o los ajustes del navegador) y recarga.'}
        </StatusRow>
      );
    case 'server_not_configured':
      return (
        <StatusRow tone="muted" icon={BellOff} title="Push no configurado en el servidor">
          Faltan las llaves VAPID (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). Las notificaciones dentro
          de la app siguen funcionando.
        </StatusRow>
      );
    default:
      return (
        <StatusRow
          tone="muted"
          icon={BellOff}
          title="Este navegador no soporta notificaciones push"
        >
          Usa Chrome, Edge, Firefox o Safari 16.4+ (instalado en inicio).
        </StatusRow>
      );
  }
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (
      prev &&
      typeof prev === 'object' &&
      !Array.isArray(prev) &&
      v &&
      typeof v === 'object' &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
