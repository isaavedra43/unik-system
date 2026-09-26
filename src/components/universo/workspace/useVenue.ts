'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Live state of the user's virtual computer — ONE source of truth for the
 * browser and the desktop surfaces (the old panel mixed two and could say
 * "Navegador listo" over a "Preparando el navegador…" screen).
 *
 * Polls /venue/state for the surface being looked at: fast while something
 * is happening (booting, agent working, user in control), slow when idle,
 * paused while the tab is hidden. The endpoint is passive: watching never
 * wakes nor keeps a sandbox alive.
 */

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface SecureInputRequest {
  requestId: string;
  message: string | null;
  fields: Array<{ key: string; label: string; sensitive: boolean }>;
}

export interface BrowserState {
  ready: boolean;
  stage?: string | null;
  reason?: string | null;
  frame?: string | null;
  url?: string | null;
  title?: string | null;
  tabs?: BrowserTabInfo[] | null;
  viewport?: { width: number; height: number } | null;
  sensitive?: boolean;
  empty?: boolean;
  error?: string | null;
}

export interface DesktopState {
  running: boolean;
  reason?: string | null;
  frame?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface VenueState {
  active: boolean;
  sessionId?: string;
  startedAt?: string;
  paused?: boolean;
  sandboxState?: string;
  pendingInputs?: SecureInputRequest[];
  teach?: { recording: boolean; steps: number };
  browser?: BrowserState;
  desktop?: DesktopState;
}

export type Surface = 'browser' | 'desktop' | 'none';

export interface UseVenueOptions {
  /** Which surface needs frames right now. */
  surface: Surface;
  /** The workspace column is visible. */
  visible: boolean;
  /** Something is happening (agent working / user in control) → poll fast. */
  hot: boolean;
}

export function useVenue({ surface, visible, hot }: UseVenueOptions) {
  const [state, setState] = useState<VenueState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inflight = useRef(false);
  const alive = useRef(true);
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch(`/app/assistant/api/venue/state?surface=${surfaceRef.current}`, {
        cache: 'no-store',
      });
      if (res.status === 403) {
        if (alive.current) {
          setState({ active: false });
          setError('Tu usuario no tiene permiso para usar la computadora virtual.');
        }
        return;
      }
      const d = (await res.json().catch(() => null)) as VenueState | null;
      if (!alive.current || !d) return;
      setError(null);
      setState((prev) => {
        // Keep the last good frame while a new one is on its way (no flicker).
        if (d.browser && !d.browser.frame && prev?.browser?.frame && d.browser.ready) {
          d.browser = {
            ...d.browser,
            frame: prev.browser.frame,
            url: d.browser.url ?? prev.browser.url,
            title: d.browser.title ?? prev.browser.title,
          };
        }
        if (d.desktop && !d.desktop.frame && prev?.desktop?.frame && d.desktop.running) {
          d.desktop = { ...d.desktop, frame: prev.desktop.frame };
        }
        return d;
      });
    } catch {
      if (alive.current) setError('Sin conexión con la computadora virtual.');
    } finally {
      inflight.current = false;
    }
  }, []);

  const booting = Boolean(state?.active && !state.paused && state.browser && !state.browser.ready);

  useEffect(() => {
    if (!visible) return;
    void refresh();
    // Frames also arrive pushed (workspace.screen) whenever the agent acts,
    // so polling only fills the gaps.
    const delay = !state
      ? 2500
      : booting
        ? 1500
        : hot
          ? 2500
          : state.active && surface !== 'none'
            ? 5000
            : 15_000;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, delay);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, surface, hot, booting, state?.active, refresh]);

  const start = useCallback(
    async (target: 'browser' | 'desktop' = 'browser') => {
      setStarting(true);
      setError(null);
      try {
        const res = await fetch('/app/assistant/api/venue/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start', surface: target }),
        });
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(d.error ?? 'No se pudo encender la computadora virtual');
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo encender la computadora virtual');
      } finally {
        setStarting(false);
      }
    },
    [refresh]
  );

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await fetch('/app/assistant/api/venue/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      setState({ active: false });
    } finally {
      setStopping(false);
    }
  }, []);

  /** Apply a frame returned by a takeover action immediately. */
  const applyBrowser = useCallback((patch: Partial<BrowserState>) => {
    setState((prev) =>
      prev ? { ...prev, browser: { ...(prev.browser ?? { ready: true }), ...patch } } : prev
    );
  }, []);
  const applyDesktop = useCallback((patch: Partial<DesktopState>) => {
    setState((prev) =>
      prev ? { ...prev, desktop: { ...(prev.desktop ?? { running: true }), ...patch } } : prev
    );
  }, []);

  return {
    state,
    error,
    setError,
    starting,
    stopping,
    booting,
    refresh,
    start,
    stop,
    applyBrowser,
    applyDesktop,
  };
}

export type VenueApi = ReturnType<typeof useVenue>;
