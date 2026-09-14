'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Bot, ChevronDown, ChevronUp, Circle, ExternalLink, Phone, PhoneForwarded, PhoneOff, Square, X } from 'lucide-react';
import type { CurrentUser } from '@/modules/auth/authorization';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';
import type { IssuedToken } from '@/modules/voice/livekit-service';
import { cn } from '@/lib/utils';
import { CallRoom } from './CallRoom';

/**
 * Floating call dock: ONE phone call that survives navigation between modules.
 * Anyone (inbox header, copilots, the assistant) can start or join a call via
 * the context or the window events below; the dock shows status, timer, mic,
 * "Pasar a la IA / Pausar IA", transfer to a teammate, recording and hang up.
 */

export interface DialInput {
  toNumber: string;
  accountId?: string | null;
  contactId?: string | null;
  label?: string | null;
}

export interface JoinInput {
  callId: string;
  label?: string | null;
  /** The voice agent is on the call: keep the user's mic off until they choose to speak. */
  aiCall?: boolean;
}

export interface ActiveCall {
  callId: string;
  label: string | null;
  aiCall: boolean;
  token: IssuedToken | null;
  call: VoiceCallDTO | null;
  startedAt: number;
  ended: boolean;
  error: string | null;
}

interface CallDockApi {
  enabled: boolean;
  active: ActiveCall | null;
  dial: (input: DialInput) => Promise<void>;
  join: (input: JoinInput) => Promise<void>;
  hangup: () => Promise<void>;
}

export const CALL_JOIN_EVENT = 'unik:call:join';
export const CALL_DIAL_EVENT = 'unik:call:dial';
const STORAGE_KEY = 'unik-call-dock';
const LIVE_STATUSES = new Set(['ringing', 'active']);

const CallDockContext = createContext<CallDockApi>({ enabled: false, active: null, dial: async () => undefined, join: async () => undefined, hangup: async () => undefined });

export function useCallDock(): CallDockApi {
  return useContext(CallDockContext);
}

export function requestCallJoin(detail: JoinInput): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CALL_JOIN_EVENT, { detail }));
}

export function requestCallDial(detail: DialInput): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CALL_DIAL_EVENT, { detail }));
}

const STATUS_LABEL: Record<string, string> = {
  ringing: 'Sonando…',
  active: 'En llamada',
  ended: 'Terminada',
  failed: 'Falló',
  missed: 'Sin respuesta',
};

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function postCall(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`/app/calls/api/calls${path}`, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
  return data;
}

export function CallDockProvider({ user, children }: { user: CurrentUser; children: React.ReactNode }) {
  const enabled = user.isSuperAdmin || user.permissionKeys.includes('calls.use');
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const activeRef = useRef<ActiveCall | null>(null);
  activeRef.current = active;

  const persist = useCallback((value: { callId: string; label: string | null; aiCall: boolean } | null) => {
    try {
      if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* private mode */
    }
  }, []);

  const refresh = useCallback(async (callId: string): Promise<VoiceCallDTO | null> => {
    try {
      const res = await fetch(`/app/calls/api/calls/${callId}`);
      if (!res.ok) return null;
      const data = (await res.json()) as { call?: VoiceCallDTO };
      return data.call ?? null;
    } catch {
      return null;
    }
  }, []);

  const join = useCallback(
    async ({ callId, label, aiCall }: JoinInput) => {
      if (!enabled) return;
      setMinimized(false);
      setTransferOpen(false);
      setActive({ callId, label: label ?? null, aiCall: Boolean(aiCall), token: null, call: null, startedAt: Date.now(), ended: false, error: null });
      try {
        const data = await postCall(`/${callId}/token`);
        const call = await refresh(callId);
        const startedAt = call?.startedAt ? Date.parse(call.startedAt) : Date.now();
        setActive((prev) => (prev && prev.callId === callId ? { ...prev, token: (data.token as IssuedToken) ?? null, call, startedAt: Number.isFinite(startedAt) ? startedAt : prev.startedAt } : prev));
        persist({ callId, label: label ?? null, aiCall: Boolean(aiCall) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'No se pudo unir a la llamada';
        setActive((prev) => (prev && prev.callId === callId ? { ...prev, ended: true, error: message } : prev));
        persist(null);
      }
    },
    [enabled, persist, refresh]
  );

  const dial = useCallback(
    async ({ toNumber, accountId, label }: DialInput) => {
      if (!enabled) return;
      setMinimized(false);
      setTransferOpen(false);
      // Contacts store numbers as people type them ("+52 55 4455 6677"); Twilio needs E.164.
      const digits = toNumber.replace(/[\s().-]/g, '');
      const e164 = digits.startsWith('+') ? digits : digits.length === 10 ? `+52${digits}` : `+${digits}`;
      setActive({ callId: 'pending', label: label ?? toNumber, aiCall: false, token: null, call: null, startedAt: Date.now(), ended: false, error: null });
      try {
        const data = await postCall('', { type: 'outbound', toNumber: e164, accountId: accountId || undefined });
        const call = data.call as VoiceCallDTO | undefined;
        if (!call) throw new Error('No se pudo iniciar la llamada');
        setActive({ callId: call.id, label: label ?? toNumber, aiCall: false, token: (data.token as IssuedToken) ?? null, call, startedAt: Date.now(), ended: false, error: null });
        persist({ callId: call.id, label: label ?? toNumber, aiCall: false });
      } catch (err) {
        setActive((prev) => (prev ? { ...prev, ended: true, error: err instanceof Error ? err.message : 'No se pudo iniciar la llamada' } : prev));
        persist(null);
      }
    },
    [enabled, persist]
  );

  const hangup = useCallback(async () => {
    const current = activeRef.current;
    if (!current || current.callId === 'pending') return;
    setBusy('end');
    try {
      await postCall(`/${current.callId}/end`);
      const call = await refresh(current.callId);
      setActive((prev) => (prev ? { ...prev, call, token: null, ended: true } : prev));
    } catch (err) {
      setActive((prev) => (prev ? { ...prev, error: err instanceof Error ? err.message : 'No se pudo colgar' } : prev));
    } finally {
      setBusy(null);
      persist(null);
    }
  }, [persist, refresh]);

  const act = useCallback(
    async (key: string, path: string, body?: unknown) => {
      const current = activeRef.current;
      if (!current || current.callId === 'pending') return;
      setBusy(key);
      try {
        await postCall(`/${current.callId}${path}`, body);
        const call = await refresh(current.callId);
        setActive((prev) => (prev ? { ...prev, call, error: null } : prev));
      } catch (err) {
        setActive((prev) => (prev ? { ...prev, error: err instanceof Error ? err.message : 'La acción falló' } : prev));
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  // Window events: copilots / assistant / any button can start or join a call.
  useEffect(() => {
    if (!enabled) return;
    const onJoin = (e: Event) => void join((e as CustomEvent<JoinInput>).detail);
    const onDial = (e: Event) => void dial((e as CustomEvent<DialInput>).detail);
    window.addEventListener(CALL_JOIN_EVENT, onJoin);
    window.addEventListener(CALL_DIAL_EVENT, onDial);
    return () => {
      window.removeEventListener(CALL_JOIN_EVENT, onJoin);
      window.removeEventListener(CALL_DIAL_EVENT, onDial);
    };
  }, [enabled, join, dial]);

  // Survive reloads within the tab.
  useEffect(() => {
    if (!enabled) return;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { callId: string; label: string | null; aiCall: boolean };
      if (saved?.callId) void join(saved);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Poll the call while it is live; close the dock a few seconds after it ends.
  useEffect(() => {
    if (!active || active.ended || active.callId === 'pending') return;
    let cancelled = false;
    const tick = async () => {
      const call = await refresh(active.callId);
      if (cancelled || !call) return;
      setActive((prev) => {
        if (!prev || prev.callId !== call.id) return prev;
        const live = LIVE_STATUSES.has(call.status);
        return { ...prev, call, ended: !live, token: live ? prev.token : null };
      });
      if (!LIVE_STATUSES.has(call.status)) persist(null);
    };
    const interval = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [active?.callId, active?.ended, refresh, persist, active]);

  useEffect(() => {
    if (!active || active.ended) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [active]);

  useEffect(() => {
    if (!active?.ended) return;
    const timeout = window.setTimeout(() => setActive((prev) => (prev?.ended ? null : prev)), active.error ? 12_000 : 7_000);
    return () => window.clearTimeout(timeout);
  }, [active?.ended, active?.error, active]);

  const openTransfer = useCallback(async () => {
    setTransferOpen((v) => !v);
    if (users.length === 0) {
      try {
        const res = await fetch('/app/calls/api/directory');
        const data = (await res.json().catch(() => ({}))) as { users?: Array<{ id: string; name: string }> };
        setUsers((data.users ?? []).filter((u) => u.id !== user.id));
      } catch {
        /* ignore */
      }
    }
  }, [users.length, user.id]);

  const value = useMemo<CallDockApi>(() => ({ enabled, active, dial, join, hangup }), [enabled, active, dial, join, hangup]);

  const status = active?.call?.status ?? (active?.callId === 'pending' ? 'ringing' : 'ringing');
  const statusLabel = active?.ended ? (active.error ? 'Error' : (STATUS_LABEL[status] ?? 'Terminada')) : (STATUS_LABEL[status] ?? status);
  const duration = active ? formatDuration((active.ended && active.call?.endedAt ? Date.parse(active.call.endedAt) : now) - active.startedAt) : '';
  const canControl = Boolean(active && !active.ended && active.call && active.callId !== 'pending');
  const aiState = active?.call?.aiState;

  return (
    <CallDockContext.Provider value={value}>
      {children}
      {enabled && active && (
        <div className={cn('call-dock', minimized && 'is-min', active.ended && 'is-ended', active.aiCall && 'is-ai')} role="region" aria-label="Llamada en curso">
          <div className="call-dock-head">
            <span className={cn('call-dock-icon', !active.ended && 'is-live')}>
              {active.aiCall ? <Bot size={16} /> : <Phone size={16} />}
            </span>
            <div className="call-dock-title">
              <strong title={active.label ?? undefined}>{active.label ?? active.call?.externalNumber ?? 'Llamada'}</strong>
              <span>
                {statusLabel}
                {active.callId !== 'pending' ? ` · ${duration}` : ''}
                {aiState === 'active' && !active.ended ? ' · IA en línea' : ''}
              </span>
            </div>
            <button type="button" className="call-dock-iconbtn" onClick={() => setMinimized((v) => !v)} aria-label={minimized ? 'Expandir llamada' : 'Minimizar llamada'}>
              {minimized ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {active.ended && (
              <button type="button" className="call-dock-iconbtn" onClick={() => setActive(null)} aria-label="Cerrar">
                <X size={16} />
              </button>
            )}
          </div>
          {!minimized && (
            <>
              {active.error && (
                <div className="call-dock-error" role="alert">
                  {active.error}
                </div>
              )}
              {!active.ended && (
                <div className="call-dock-room">
                  {active.token ? <CallRoom token={active.token} compact autoMic={!active.aiCall} /> : <span className="call-dock-muted">Conectando audio…</span>}
                </div>
              )}
              {canControl && (
                <div className="call-dock-actions">
                  <button type="button" className="btn btn-sm btn-secondary" disabled={busy !== null} onClick={() => act('ai', aiState === 'active' ? '/ai/pause' : '/ai/resume')} title={aiState === 'active' ? 'La IA deja de hablar; tú sigues en la llamada' : 'La asistente de voz entra a la llamada'}>
                    <Bot size={14} /> {aiState === 'active' ? 'Pausar IA' : 'Pasar a la IA'}
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" disabled={busy !== null} onClick={openTransfer} title="Escalar / transferir a un compañero">
                    <PhoneForwarded size={14} /> Escalar
                  </button>
                  <button type="button" className="btn btn-sm btn-secondary" disabled={busy !== null} onClick={() => act('rec', '/recording', { on: active.call?.recordingState !== 'recording' })} title={active.call?.recordingState === 'recording' ? 'Detener grabación' : 'Grabar la llamada'}>
                    {active.call?.recordingState === 'recording' ? <Square size={14} /> : <Circle size={14} />} {active.call?.recordingState === 'recording' ? 'Detener' : 'Grabar'}
                  </button>
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void hangup()}>
                    <PhoneOff size={14} /> Colgar
                  </button>
                </div>
              )}
              {canControl && transferOpen && (
                <div className="call-dock-transfer">
                  <select className="select" aria-label="Transferir a" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
                    <option value="">Elige a quién escalar…</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!transferTo || busy !== null}
                    onClick={async () => {
                      await act('transfer', '/transfer', { userId: transferTo });
                      setTransferOpen(false);
                    }}
                  >
                    Transferir
                  </button>
                </div>
              )}
              {active.callId !== 'pending' && (
                <Link href={`/app/calls?call=${active.callId}`} className="call-dock-link">
                  <ExternalLink size={12} /> Ver transcripción y detalle
                </Link>
              )}
            </>
          )}
        </div>
      )}
    </CallDockContext.Provider>
  );
}
