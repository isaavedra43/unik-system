'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Plug, Search } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * Apps the agents can use through Composio (Gmail, Calendar, Slack, Drive,
 * CRM…): which are connected and a one-click hosted authorization for the
 * rest. The list only shows apps an administrator enabled for the user's role.
 */

export interface ToolkitItem {
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  isNoAuth?: boolean;
}

export function useToolkits(enabled = true) {
  const [items, setItems] = useState<ToolkitItem[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/app/assistant/api/composio/toolkits');
      const d = (await res.json().catch(() => ({}))) as {
        configured?: boolean;
        toolkits?: ToolkitItem[];
        error?: string;
      };
      if (!res.ok) throw new Error(d.error ?? 'No se pudieron cargar las apps');
      setConfigured(d.configured !== false);
      setItems(d.toolkits ?? []);
      setError(null);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las apps');
    }
  }, []);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  return { items, configured, error, reload: load, setItems };
}

function Logo({ item }: { item: ToolkitItem }) {
  const [broken, setBroken] = useState(false);
  if (item.logo && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- third-party app logos (any host)
      <img
        src={item.logo}
        alt=""
        width={20}
        height={20}
        onError={() => setBroken(true)}
        style={{ borderRadius: 5 }}
      />
    );
  }
  return <Plug size={15} />;
}

export function AppsList({
  compact = false,
  onConnected,
}: {
  compact?: boolean;
  onConnected?: (item: ToolkitItem) => void;
}) {
  const { items, configured, error, setItems } = useToolkits(true);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    },
    []
  );

  const connect = async (item: ToolkitItem) => {
    setBusy(item.slug);
    try {
      const res = await fetch('/app/assistant/api/composio/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolkit: item.slug }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        redirectUrl?: string | null;
        connected?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(d.error ?? 'No se pudo preparar la conexión');
      if (d.connected) {
        setItems(
          (prev) => prev?.map((t) => (t.slug === item.slug ? { ...t, connected: true } : t)) ?? prev
        );
        onConnected?.(item);
        return;
      }
      if (d.redirectUrl) window.open(d.redirectUrl, '_blank', 'noopener,noreferrer');
      setWaiting(item.slug);
      const started = Date.now();
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        if (Date.now() - started > 3 * 60_000) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setWaiting(null);
          return;
        }
        const r = await fetch(
          `/app/assistant/api/composio/toolkits?search=${encodeURIComponent(item.slug)}`
        ).catch(() => null);
        const j = (await r?.json().catch(() => null)) as { toolkits?: ToolkitItem[] } | null;
        const hit = j?.toolkits?.find((t) => t.slug === item.slug);
        if (hit?.connected) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          setWaiting(null);
          setItems(
            (prev) =>
              prev?.map((t) => (t.slug === item.slug ? { ...t, connected: true } : t)) ?? prev
          );
          onConnected?.(item);
        }
      }, 4000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo conectar');
    } finally {
      setBusy(null);
    }
  };

  if (items === null) {
    return (
      <div className="uv-apps" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="uv-skel" style={{ height: 36, margin: '4px 6px' }} />
        ))}
      </div>
    );
  }
  if (!configured) {
    return (
      <p className="uv-section-note">
        Las apps externas no están activadas en este servidor. Un administrador puede activarlas en
        Admin → Extensiones.
      </p>
    );
  }
  if (error) return <p className="uv-section-note">{error}</p>;
  if (items.length === 0) {
    return (
      <p className="uv-section-note">
        Tu rol todavía no tiene apps habilitadas. Pide a un administrador que las active en Admin →
        Extensiones → Composio.
      </p>
    );
  }
  const q = query.trim().toLowerCase();
  const list = [...items]
    .filter((t) => !q || t.name.toLowerCase().includes(q) || t.slug.includes(q))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));

  return (
    <div className={cn('uv-apps', compact && 'is-compact')}>
      {items.length > 8 && (
        <label className="uv-pop-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar app"
            aria-label="Buscar app"
          />
        </label>
      )}
      {list.map((t) => (
        <div key={t.slug} className="uv-app-row">
          <span className="uv-app-logo">
            <Logo item={t} />
          </span>
          <span className="uv-app-name">{t.name}</span>
          {t.connected ? (
            <span className="uv-pill is-live">
              <Check size={11} /> Conectada
            </span>
          ) : (
            <button
              type="button"
              className="uv-btn is-secondary is-sm"
              onClick={() => void connect(t)}
              disabled={busy !== null || waiting === t.slug}
            >
              {busy === t.slug || waiting === t.slug ? (
                <Loader2 size={12} className="uv-spin" />
              ) : (
                <Plug size={12} />
              )}
              {waiting === t.slug ? 'Esperando…' : 'Conectar'}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
