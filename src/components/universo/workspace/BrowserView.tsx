'use client';

import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  Globe,
  GraduationCap,
  Hand,
  Loader2,
  Lock,
  Plus,
  Power,
  RotateCw,
  Save,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { hostOf, timeAgo } from '../lib/format';
import { IconButton } from '../ui';
import { LiveScreen } from './LiveScreen';
import type { VenueApi } from './useVenue';

/**
 * The agent's browser — a real Chromium in the virtual computer. The user
 * watches it live, types an address, takes control (click / type / scroll on
 * the frame), teaches a procedure once ("Enséñale") and fills secure fields
 * the agent asked for without the values ever reaching the model.
 */

const BOOT_STEPS: Array<{ stage: string; label: string }> = [
  { stage: 'creating', label: 'Creando la computadora virtual' },
  { stage: 'uploading', label: 'Instalando el controlador del navegador' },
  { stage: 'provisioning', label: 'Preparando Chromium' },
  { stage: 'starting', label: 'Abriendo el navegador' },
];

export interface BrowserFeedItem {
  id: string;
  label: string;
  url?: string | null;
  ok: boolean;
  ts: number;
}

async function post<T>(
  url: string,
  body: unknown
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

function BootSteps({
  stage,
  failed,
  reason,
}: {
  stage?: string | null;
  failed?: boolean;
  reason?: string | null;
}) {
  const idx = Math.max(
    0,
    BOOT_STEPS.findIndex((s) => s.stage === stage)
  );
  return (
    <div className="uv-boot" role="status" aria-live="polite">
      {BOOT_STEPS.map((s, i) => {
        const state =
          failed && i === idx ? 'is-failed' : i < idx ? 'is-done' : i === idx ? 'is-active' : '';
        return (
          <div key={s.stage} className={cn('uv-boot-step', state)}>
            {state === 'is-done' ? (
              <Check size={14} />
            ) : state === 'is-active' ? (
              failed ? (
                <X size={14} />
              ) : (
                <Loader2 size={14} className="uv-spin" />
              )
            ) : (
              <Circle size={10} />
            )}
            <span>{s.label}</span>
          </div>
        );
      })}
      {failed && reason && <p style={{ marginTop: 6 }}>{reason}</p>}
    </div>
  );
}

function SecureForm({
  sessionId,
  request,
  onDone,
}: {
  sessionId: string;
  request: {
    requestId: string;
    message: string | null;
    fields: Array<{ key: string; label: string; sensitive: boolean }>;
  };
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post<{ error?: string }>('/app/assistant/api/venue/secure-input', {
        sessionId,
        requestId: request.requestId,
        values,
      });
      if (!r.ok) throw new Error(r.data.error ?? 'No se pudo escribir en la página');
      toast.success('Listo: lo escribí en la página. No se guardó ni lo vio la IA.');
      setValues({});
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo escribir');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="uv-secure" aria-label="Datos que pide el agente">
      <div className="uv-secure-head">
        <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          <strong>El agente necesita que escribas esto tú.</strong>
          <br />
          {request.message ??
            'Se escribe directo en la página: la IA nunca ve estos valores y no se guardan.'}
        </span>
      </div>
      <form onSubmit={submit}>
        {request.fields.map((f) => (
          <label key={f.key}>
            {f.label}
            <input
              className="uv-input"
              type={f.sensitive ? 'password' : 'text'}
              autoComplete="off"
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        ))}
        <button type="submit" className="uv-btn is-primary" disabled={busy}>
          {busy ? <Loader2 size={14} className="uv-spin" /> : <Lock size={14} />} Escribir en la
          página
        </button>
      </form>
    </section>
  );
}

export function BrowserView({
  venue,
  control,
  onControlChange,
  teachRequested,
  onTeachHandled,
  feed,
}: {
  venue: VenueApi;
  control: boolean;
  onControlChange: (on: boolean) => void;
  /** "Enséñale" was chosen in the composer: start recording once ready. */
  teachRequested: boolean;
  onTeachHandled: () => void;
  feed: BrowserFeedItem[];
}) {
  const { state, booting, starting } = venue;
  const b = state?.browser;
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [acting, setActing] = useState(false);
  const [teachName, setTeachName] = useState('');
  const [teachBusy, setTeachBusy] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const addressRef = React.useRef<HTMLInputElement>(null);
  const recording = Boolean(state?.teach?.recording);

  useEffect(() => {
    if (!editing) setAddress(b?.url && b.url !== 'about:blank' ? b.url : '');
  }, [b?.url, editing]);

  // "Enséñale" from the composer: power on if needed, then start recording.
  useEffect(() => {
    if (!teachRequested) return;
    if (!state) return;
    if (!state.active) {
      void venue.start('browser');
      return;
    }
    if (!b?.ready || recording) {
      if (recording) onTeachHandled();
      return;
    }
    void (async () => {
      const r = await post<{ error?: string }>('/app/assistant/api/venue/teach', {
        action: 'start',
      });
      if (r.ok) {
        onControlChange(true);
        toast.success('Grabando: haz la tarea en el navegador. Yo aprendo cada paso.');
        await venue.refresh();
      } else toast.error(r.data.error ?? 'No se pudo empezar a grabar');
      onTeachHandled();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teachRequested, state?.active, b?.ready, recording]);

  const act = async (body: Record<string, unknown>) => {
    setActing(true);
    try {
      const r = await post<{
        ok?: boolean;
        error?: string | null;
        frame?: string | null;
        url?: string | null;
        title?: string | null;
        tabs?: never;
        viewport?: { width: number; height: number } | null;
        sensitive?: boolean;
        empty?: boolean;
        booting?: boolean;
        teachSteps?: number | null;
      }>('/app/assistant/api/venue/browser', body);
      if (!r.ok) {
        venue.setError(r.data.error ?? 'El navegador no respondió');
        if (r.data.booting) void venue.refresh();
        return;
      }
      venue.setError(null);
      const d = r.data;
      venue.applyBrowser({
        ...(d.frame ? { frame: d.frame } : {}),
        url: d.url ?? b?.url ?? null,
        title: d.title ?? b?.title ?? null,
        ...(d.tabs ? { tabs: d.tabs } : {}),
        ...(d.viewport ? { viewport: d.viewport } : {}),
        sensitive: d.sensitive,
        empty: d.empty,
        error: d.ok === false ? (d.error ?? null) : null,
      });
      if (d.ok === false && d.error) venue.setError(d.error);
      if (typeof d.teachSteps === 'number') void venue.refresh();
    } catch {
      venue.setError('Sin conexión con el navegador');
    } finally {
      setActing(false);
    }
  };

  const saveTeach = async () => {
    setTeachBusy(true);
    try {
      const r = await post<{ error?: string; name?: string; steps?: number }>(
        '/app/assistant/api/venue/teach',
        { action: 'save', name: teachName.trim() || undefined }
      );
      if (!r.ok) throw new Error(r.data.error ?? 'No se pudo guardar');
      toast.success(
        `Aprendí «${r.data.name}» (${r.data.steps} pasos). Tus agentes ya pueden repetirlo.`
      );
      setTeachName('');
      await venue.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar');
    } finally {
      setTeachBusy(false);
    }
  };
  const discardTeach = async () => {
    setTeachBusy(true);
    await post('/app/assistant/api/venue/teach', { action: 'discard' }).catch(() => null);
    setTeachBusy(false);
    await venue.refresh();
  };

  const tabs = b?.tabs ?? [];
  const secure = /^https:/i.test(b?.url ?? '');
  const ready = Boolean(state?.active && !state.paused && b?.ready);

  let screenState: React.ReactNode = null;
  if (!state) {
    screenState = (
      <div className="uv-screen-state">
        <Loader2 size={22} className="uv-spin" />
        <p>Conectando con la computadora virtual…</p>
      </div>
    );
  } else if (!state.active) {
    screenState = (
      <div className="uv-screen-state">
        <Globe size={28} />
        <strong>El navegador del agente está apagado</strong>
        <p>
          Se enciende solo cuando un agente necesita navegar. También puedes encenderlo tú para
          entrar a un sitio, probar tu sistema o enseñarle una tarea.
        </p>
        <button
          type="button"
          className="uv-btn is-primary"
          onClick={() => void venue.start('browser')}
          disabled={starting}
        >
          {starting ? <Loader2 size={14} className="uv-spin" /> : <Power size={14} />} Encender el
          navegador
        </button>
      </div>
    );
  } else if (state.paused) {
    screenState = (
      <div className="uv-screen-state">
        <Power size={26} />
        <strong>La computadora está en pausa</strong>
        <p>
          Se pausó por inactividad para no gastar. Se reanuda sola cuando un agente la necesite.
        </p>
        <button
          type="button"
          className="uv-btn is-secondary"
          onClick={() => void venue.start('browser')}
          disabled={starting}
        >
          {starting ? <Loader2 size={14} className="uv-spin" /> : <Power size={14} />} Reanudar
          ahora
        </button>
      </div>
    );
  } else if (booting) {
    const failed = b?.stage === 'failed';
    screenState = (
      <div className="uv-screen-state">
        <strong>{failed ? 'El navegador no pudo arrancar' : 'Preparando el navegador…'}</strong>
        <BootSteps stage={failed ? 'starting' : b?.stage} failed={failed} reason={b?.reason} />
        {failed && (
          <button
            type="button"
            className="uv-btn is-secondary"
            onClick={() => void venue.start('browser')}
            disabled={starting}
          >
            <RotateCw size={14} /> Reintentar
          </button>
        )}
      </div>
    );
  } else if (ready && !b?.frame) {
    screenState = (
      <div className="uv-screen-state">
        <Loader2 size={22} className="uv-spin" />
        <p>Cargando la pantalla…</p>
      </div>
    );
  } else if (ready && b?.empty && !control) {
    screenState = (
      <div className="uv-screen-state" style={{ background: 'transparent', pointerEvents: 'none' }}>
        <p
          style={{
            background: 'color-mix(in srgb, black 55%, transparent)',
            padding: '8px 12px',
            borderRadius: 10,
            color: '#fff',
          }}
        >
          Página en blanco: escribe una dirección arriba o pídele al agente que abra un sitio.
        </p>
      </div>
    );
  }

  return (
    <div className="uv-ws-scroll">
      <div className="uv-browser">
        {ready && tabs.length > 1 && (
          <div className="uv-browser-tabs" role="tablist" aria-label="Pestañas del navegador">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.active}
                className={cn('uv-btab', t.active && 'is-active')}
                onClick={() => !t.active && void act({ action: 'switchTab', tabId: t.id })}
                title={t.url}
              >
                <span>{t.title || hostOf(t.url) || 'Pestaña'}</span>
                {!t.active && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="uv-btab-x"
                    aria-label="Cerrar pestaña"
                    onClick={(e) => {
                      e.stopPropagation();
                      void act({ action: 'closeTab', tabId: t.id });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation();
                        void act({ action: 'closeTab', tabId: t.id });
                      }
                    }}
                  >
                    <X size={11} />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="uv-browser-bar">
          <IconButton
            label="Atrás"
            size="sm"
            disabled={!ready || acting}
            onClick={() => void act({ action: 'back' })}
          >
            <ArrowLeft size={15} />
          </IconButton>
          <IconButton
            label="Adelante"
            size="sm"
            disabled={!ready || acting}
            onClick={() => void act({ action: 'forward' })}
          >
            <ArrowRight size={15} />
          </IconButton>
          <IconButton
            label="Recargar"
            size="sm"
            disabled={!ready || acting}
            onClick={() => void act({ action: 'reload' })}
          >
            {acting ? <Loader2 size={15} className="uv-spin" /> : <RotateCw size={15} />}
          </IconButton>
          <form
            className="uv-omnibox"
            onSubmit={(e) => {
              e.preventDefault();
              if (!address.trim() || !ready) return;
              setEditing(false);
              void act({ action: newTab ? 'newTab' : 'navigate', url: address.trim() });
              setNewTab(false);
              addressRef.current?.blur();
            }}
          >
            {secure ? <Lock size={13} className="is-secure" /> : <Globe size={13} />}
            <input
              ref={addressRef}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onFocus={(e) => {
                setEditing(true);
                e.currentTarget.select();
              }}
              onBlur={() => {
                setEditing(false);
                setNewTab(false);
              }}
              placeholder={
                !ready
                  ? state?.active
                    ? state.paused
                      ? 'La computadora está en pausa'
                      : 'Preparando el navegador…'
                    : 'El navegador está apagado'
                  : newTab
                    ? 'Dirección para la nueva pestaña'
                    : 'Escribe una dirección o búsqueda'
              }
              aria-label="Dirección"
              disabled={!ready}
              spellCheck={false}
            />
          </form>
          <IconButton
            label="Nueva pestaña"
            size="sm"
            disabled={!ready || acting}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setNewTab(true);
              setAddress('');
              addressRef.current?.focus();
            }}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <LiveScreen
          frame={ready ? b?.frame : null}
          alt={b?.title ? `Navegador: ${b.title}` : 'Navegador del agente'}
          width={b?.viewport?.width}
          height={b?.viewport?.height}
          control={control && ready}
          input={{
            onClick: (x, y, o) =>
              act({ action: 'clickAt', x, y, button: o.button, clickCount: o.clickCount }),
            onType: (text) => act({ action: 'typeText', text }),
            onKey: (key) => act({ action: 'key', key }),
            onWheel: (deltaX, deltaY) => act({ action: 'wheel', deltaX, deltaY }),
          }}
          top={
            ready ? (
              <>
                <span className="uv-screen-badge">
                  <span className={cn('uv-live-dot', control ? 'is-warn' : '')} />
                  {control ? 'Tú tienes el control' : 'En vivo'}
                </span>
                {b?.sensitive && (
                  <span className="uv-screen-badge">
                    <Lock size={11} /> Datos sensibles en pantalla
                  </span>
                )}
              </>
            ) : undefined
          }
        >
          {screenState}
        </LiveScreen>
        <div className="uv-browser-foot">
          {recording ? (
            <>
              <span className="uv-rec">
                <span className="uv-live-dot" style={{ display: 'inline-block', marginRight: 6 }} />
                Grabando · {state?.teach?.steps ?? 0} paso(s)
              </span>
              <input
                className="uv-input"
                style={{ height: 28, maxWidth: 200 }}
                placeholder="Nombre del procedimiento"
                value={teachName}
                onChange={(e) => setTeachName(e.target.value)}
                aria-label="Nombre del procedimiento"
              />
              <button
                type="button"
                className="uv-btn is-primary is-sm"
                disabled={teachBusy}
                onClick={() => void saveTeach()}
              >
                <Save size={13} /> Guardar
              </button>
              <IconButton
                label="Descartar grabación"
                size="sm"
                disabled={teachBusy}
                onClick={() => void discardTeach()}
              >
                <Trash2 size={14} />
              </IconButton>
            </>
          ) : (
            <>
              <span title={b?.url ?? undefined}>
                {ready
                  ? b?.title || hostOf(b?.url) || 'Listo'
                  : state?.active
                    ? 'Preparando…'
                    : 'Apagado'}
              </span>
              <button
                type="button"
                className={cn('uv-btn is-sm', control ? 'is-primary' : 'is-secondary')}
                disabled={!ready}
                onClick={() => onControlChange(!control)}
                aria-pressed={control}
              >
                <Hand size={13} /> {control ? 'Devolver el control' : 'Tomar el control'}
              </button>
              <button
                type="button"
                className="uv-btn is-ghost is-sm"
                disabled={!ready}
                onClick={async () => {
                  const r = await post<{ error?: string }>('/app/assistant/api/venue/teach', {
                    action: 'start',
                  });
                  if (!r.ok) {
                    toast.error(r.data.error ?? 'No se pudo empezar a grabar');
                    return;
                  }
                  onControlChange(true);
                  toast.success('Grabando: haz la tarea en el navegador. Yo aprendo cada paso.');
                  await venue.refresh();
                }}
                title="Hazlo una vez; el agente aprende los pasos y los repite solo"
              >
                <GraduationCap size={13} /> Enséñale
              </button>
            </>
          )}
        </div>
      </div>

      {venue.error && (
        <div className="uv-banner" role="alert">
          <span>{venue.error}</span>
          <IconButton
            label="Cerrar aviso"
            size="sm"
            tip={false}
            onClick={() => venue.setError(null)}
          >
            <X size={14} />
          </IconButton>
        </div>
      )}

      {state?.sessionId &&
        (state.pendingInputs ?? []).map((r) => (
          <SecureForm
            key={r.requestId}
            sessionId={state.sessionId as string}
            request={r}
            onDone={() => void venue.refresh()}
          />
        ))}

      {feed.length > 0 && (
        <div className="uv-block">
          <div className="uv-block-head">
            <span>Lo que hizo el agente</span>
          </div>
          <div className="uv-feed">
            {feed.slice(0, 12).map((f) => (
              <div key={f.id} className={cn('uv-feed-item', !f.ok && 'is-bad')}>
                {f.ok ? <Check size={14} /> : <X size={14} />}
                <div className="uv-feed-main">
                  <strong>{f.label}</strong>
                  {f.url && <span>{f.url}</span>}
                </div>
                <span className="uv-feed-time">{timeAgo(f.ts)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
