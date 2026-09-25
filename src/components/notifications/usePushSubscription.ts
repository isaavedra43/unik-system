'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Browser-side Web Push subscription state for the settings screen.
 *
 * Platform notes baked in here:
 * - iOS/iPadOS: push only works from the installed app (Add to Home Screen)
 *   on iOS 16.4+. In Safari itself `PushManager` is undefined → `needs_install`.
 * - Permission must be requested from a user gesture (the "Activar" button).
 * - A `denied` permission cannot be re-requested from code; the user has to
 *   re-enable it in the browser/OS settings.
 */

export type PushStatus =
  | 'loading'
  | 'unsupported'
  | 'needs_install'
  | 'server_not_configured'
  | 'denied'
  | 'prompt'
  | 'subscribed';

export interface PushDevice {
  id: string;
  endpoint: string;
  platform: 'ios' | 'android' | 'desktop' | 'unknown';
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ServerInfo {
  configured: boolean;
  publicKey: string | null;
  subscriptions: PushDevice[];
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration('/');
    if (existing) return existing;
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return null;
  }
}

export function usePushSubscription() {
  const [status, setStatus] = useState<PushStatus>('loading');
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [currentEndpoint, setCurrentEndpoint] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ios = typeof window !== 'undefined' ? isIos() : false;
  const standalone = typeof window !== 'undefined' ? isStandalone() : false;

  const loadServer = useCallback(async (): Promise<ServerInfo | null> => {
    try {
      const res = await fetch('/app/notifications/api/push', { cache: 'no-store' });
      if (!res.ok) return null;
      const json = (await res.json()) as ServerInfo;
      setDevices(json.subscriptions);
      setPublicKey(json.publicKey);
      return json;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const server = await loadServer();
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) {
      setStatus(ios && !standalone ? 'needs_install' : 'unsupported');
      return;
    }
    if (server && !server.configured) {
      setStatus('server_not_configured');
      return;
    }
    if (Notification.permission === 'denied') {
      setStatus('denied');
      return;
    }
    const registration = await getRegistration();
    const sub = registration ? await registration.pushManager.getSubscription() : null;
    if (sub) {
      setCurrentEndpoint(sub.endpoint);
      const known = server?.subscriptions.some((d) => d.endpoint === sub.endpoint);
      if (!known && server?.publicKey) {
        // Browser has a subscription the server forgot (re-login, DB reset): re-register.
        await fetch('/app/notifications/api/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
        }).catch(() => undefined);
        await loadServer();
      }
      setStatus('subscribed');
      return;
    }
    setCurrentEndpoint(null);
    setStatus('prompt');
  }, [ios, standalone, loadServer]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const key = publicKey ?? (await loadServer())?.publicKey;
      if (!key) {
        setStatus('server_not_configured');
        return false;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus(permission === 'denied' ? 'denied' : 'prompt');
        return false;
      }
      const registration = await getRegistration();
      if (!registration) {
        setError('No se pudo registrar el service worker.');
        return false;
      }
      await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      });
      const res = await fetch('/app/notifications/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent }),
      });
      if (!res.ok) {
        setError('El servidor no aceptó la suscripción.');
        return false;
      }
      setCurrentEndpoint(sub.endpoint);
      setStatus('subscribed');
      await loadServer();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo activar.');
      return false;
    } finally {
      setBusy(false);
    }
  }, [publicKey, loadServer]);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await getRegistration();
      const sub = registration ? await registration.pushManager.getSubscription() : null;
      if (sub) {
        await fetch('/app/notifications/api/push', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => undefined);
        await sub.unsubscribe().catch(() => undefined);
      }
      setCurrentEndpoint(null);
      setStatus(Notification.permission === 'denied' ? 'denied' : 'prompt');
      await loadServer();
    } finally {
      setBusy(false);
    }
  }, [loadServer]);

  const removeDevice = useCallback(
    async (endpoint: string) => {
      if (endpoint === currentEndpoint) return unsubscribe();
      await fetch('/app/notifications/api/push', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      }).catch(() => undefined);
      await loadServer();
    },
    [currentEndpoint, unsubscribe, loadServer]
  );

  const sendTest = useCallback(async () => {
    const res = await fetch('/app/notifications/api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentEndpoint ? { endpoint: currentEndpoint } : {}),
    });
    if (!res.ok) return { sent: 0, failed: 1, removed: 0, skipped: true };
    return (await res.json()) as { sent: number; failed: number; removed: number; skipped: boolean };
  }, [currentEndpoint]);

  return {
    status,
    devices,
    currentEndpoint,
    busy,
    error,
    ios,
    standalone,
    subscribe,
    unsubscribe,
    removeDevice,
    sendTest,
    refresh,
  };
}
