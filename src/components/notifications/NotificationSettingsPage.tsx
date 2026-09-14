'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BellOff,
  BellRing,
  Laptop,
  Moon,
  Send,
  Share,
  Smartphone,
  Trash2,
  Bell,
} from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/shadcn/switch';
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
  return platform === 'desktop' ? <Laptop size={16} /> : <Smartphone size={16} />;
}

function deviceLabel(device: PushDevice, isCurrent: boolean): string {
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
  return `${name}${browser ? ` · ${browser}` : ''}${isCurrent ? ' (este dispositivo)' : ''}`;
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
      categories: { ...s.categories, [key]: { ...s.categories[key as keyof typeof s.categories], [field]: value } },
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
    <div>
      <div className="page-header page-header-row">
        <div className="page-header-info">
          <h1 className="page-title">Mis notificaciones</h1>
          <p className="page-description">
            Decide qué te avisamos en la app y qué te llega al teléfono.
          </p>
        </div>
        <div className="row-actions">
          {saving ? <span className="text-muted" style={{ fontSize: 'var(--unik-text-sm)' }}>Guardando…</span> : null}
          <Link href="/app/notifications" className="btn btn-ghost btn-sm">
            <Bell size={14} /> Ver notificaciones
          </Link>
        </div>
      </div>

      {/* ---------------------------------------------------------------- Push en este dispositivo */}
      <div className="card">
        <h2 className="heading-3" style={{ marginBottom: 'var(--unik-space-2)' }}>
          Notificaciones en este dispositivo
        </h2>
        <PushStatusBlock push={push} onTest={onTest} />
      </div>

      {/* ---------------------------------------------------------------- Dispositivos */}
      {push.devices.length > 0 ? (
        <div className="card">
          <h2 className="heading-3" style={{ marginBottom: 'var(--unik-space-3)' }}>
            Dispositivos registrados
          </h2>
          <ul className="notif-device-list">
            {push.devices.map((d) => {
              const isCurrent = d.endpoint === push.currentEndpoint;
              return (
                <li key={d.id} className="notif-device">
                  <span className="notif-device-icon">{deviceIcon(d.platform)}</span>
                  <div className="notif-device-info">
                    <strong>{deviceLabel(d, isCurrent)}</strong>
                    <span className="text-muted">
                      Registrado {new Date(d.createdAt).toLocaleDateString('es-MX')}
                      {d.lastUsedAt
                        ? ` · último aviso ${new Date(d.lastUsedAt).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}`
                        : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label="Quitar dispositivo"
                    onClick={() => void push.removeDevice(d.endpoint)}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- Global */}
      <div className="card">
        <h2 className="heading-3" style={{ marginBottom: 'var(--unik-space-3)' }}>
          Push en general
        </h2>
        <label className="notif-row">
          <div className="notif-row-text">
            <strong>Enviar avisos a mis dispositivos</strong>
            <span className="text-muted">Apaga esto para pausar todos los push sin quitar los dispositivos.</span>
          </div>
          <Switch
            checked={settings.pushEnabled}
            onCheckedChange={(v) => {
              setSettings((s) => ({ ...s, pushEnabled: v }));
              persist({ pushEnabled: v });
            }}
            aria-label="Push activado"
          />
        </label>

        <div className="notif-row">
          <div className="notif-row-text">
            <strong>
              <BellOff size={14} style={{ verticalAlign: '-2px' }} /> Silenciar temporalmente
            </strong>
            <span className="text-muted">
              {muted
                ? `Silenciado hasta ${new Date(settings.mutedUntil!).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}. Las llamadas entrantes siguen sonando.`
                : 'Pausa los push por un rato. Las llamadas entrantes siguen sonando.'}
            </span>
          </div>
          <div className="notif-row-actions">
            {muted ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => mute(null)}>
                Reactivar
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => mute(1)}>
                  1 h
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => mute(4)}>
                  4 h
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => mute(24)}>
                  Hasta mañana
                </button>
              </>
            )}
          </div>
        </div>

        <div className="notif-row">
          <div className="notif-row-text">
            <strong>
              <Moon size={14} style={{ verticalAlign: '-2px' }} /> Horario silencioso
            </strong>
            <span className="text-muted">
              Sin push en este rango (hora de {settings.timezone}). Las llamadas entrantes siguen sonando.
            </span>
          </div>
          <div className="notif-row-actions">
            <Switch
              checked={quietOn}
              onCheckedChange={(v) => (v ? setQuietHours(22, 7) : setQuietHours(null, null))}
              aria-label="Horario silencioso"
            />
            {quietOn ? (
              <>
                <select
                  className="notif-select"
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
                <span className="text-muted">a</span>
                <select
                  className="notif-select"
                  aria-label="Hasta"
                  value={settings.quietHoursEnd ?? 7}
                  onChange={(e) => setQuietHours(settings.quietHoursStart, Number(e.target.value))}
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

      {/* ---------------------------------------------------------------- Categorías */}
      <div className="card">
        <h2 className="heading-3" style={{ marginBottom: 'var(--unik-space-1)' }}>
          Qué me avisan
        </h2>
        <p className="text-muted" style={{ marginBottom: 'var(--unik-space-4)' }}>
          <strong>En la app</strong> = campana y lista de notificaciones. <strong>Teléfono</strong> = push a tus dispositivos.
        </p>
        <div className="notif-table-head">
          <span>Tipo</span>
          <span>En la app</span>
          <span>Teléfono</span>
        </div>
        {groups.map(([group, items]) => (
          <div key={group} className="notif-group">
            <div className="notif-group-title">{group}</div>
            {items.map((c) => {
              const pref = settings.categories[c.key];
              return (
                <div key={c.key} className="notif-table-row">
                  <div className="notif-row-text">
                    <strong>
                      {c.label}
                      {c.urgent ? <span className="badge badge-danger notif-badge">urgente</span> : null}
                    </strong>
                    <span className="text-muted">{c.description}</span>
                  </div>
                  <Switch
                    checked={pref.inApp}
                    disabled={Boolean(c.lockedInApp)}
                    onCheckedChange={(v) => setCategory(c.key, 'inApp', v)}
                    aria-label={`${c.label} en la app`}
                  />
                  <Switch
                    checked={pref.push}
                    onCheckedChange={(v) => setCategory(c.key, 'push', v)}
                    aria-label={`${c.label} en el teléfono`}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
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
      return <p className="text-muted">Comprobando…</p>;
    case 'subscribed':
      return (
        <div className="notif-status notif-status-ok">
          <BellRing size={18} />
          <div className="notif-row-text">
            <strong>Activas en este dispositivo</strong>
            <span className="text-muted">
              Te llegarán aunque la app esté cerrada. Prueba que todo funcione:
            </span>
          </div>
          <div className="notif-row-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void onTest()}>
              <Send size={14} /> Enviar prueba
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void push.unsubscribe()}
              disabled={push.busy}
            >
              Desactivar aquí
            </button>
          </div>
        </div>
      );
    case 'prompt':
      return (
        <div className="notif-status">
          <Smartphone size={18} />
          <div className="notif-row-text">
            <strong>Aún no activas los avisos en este dispositivo</strong>
            <span className="text-muted">
              Al tocar “Activar” el {push.ios ? 'iPhone' : 'navegador'} te pedirá permiso una sola vez.
            </span>
            {push.error ? <span style={{ color: 'var(--unik-danger)' }}>{push.error}</span> : null}
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void push.subscribe().then((ok) => ok && toast.success('Notificaciones activadas'))}
            disabled={push.busy}
          >
            <BellRing size={14} /> Activar
          </button>
        </div>
      );
    case 'needs_install':
      return (
        <div className="notif-status notif-status-warn">
          <Share size={18} />
          <div className="notif-row-text">
            <strong>En iPhone/iPad primero instala UNIK</strong>
            <span className="text-muted">
              Safari no permite push desde el navegador. Toca <strong>Compartir</strong> (el cuadro con la
              flecha) → <strong>“Agregar a pantalla de inicio”</strong>, abre UNIK desde el ícono y vuelve
              aquí para activar. Requiere iOS 16.4 o más reciente.
            </span>
          </div>
        </div>
      );
    case 'denied':
      return (
        <div className="notif-status notif-status-warn">
          <BellOff size={18} />
          <div className="notif-row-text">
            <strong>Permiso bloqueado</strong>
            <span className="text-muted">
              {push.ios
                ? 'Ve a Ajustes → Notificaciones → UNIK y permite las notificaciones; luego recarga esta página.'
                : 'Permite las notificaciones para este sitio desde el candado de la barra de direcciones (o los ajustes del navegador) y recarga.'}
            </span>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void push.refresh()}>
            Volver a comprobar
          </button>
        </div>
      );
    case 'server_not_configured':
      return (
        <div className="notif-status notif-status-warn">
          <BellOff size={18} />
          <div className="notif-row-text">
            <strong>Push no configurado en el servidor</strong>
            <span className="text-muted">
              Faltan las llaves VAPID (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). Las notificaciones dentro de
              la app siguen funcionando.
            </span>
          </div>
        </div>
      );
    default:
      return (
        <div className="notif-status notif-status-warn">
          <BellOff size={18} />
          <div className="notif-row-text">
            <strong>Este navegador no soporta notificaciones push</strong>
            <span className="text-muted">Usa Chrome, Edge, Firefox o Safari 16.4+ (instalado en inicio).</span>
          </div>
        </div>
      );
  }
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (prev && typeof prev === 'object' && !Array.isArray(prev) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
