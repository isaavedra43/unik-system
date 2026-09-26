'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppWindow,
  Brain,
  Check,
  FileText,
  Globe,
  Image as ImageIcon,
  LayoutDashboard,
  Loader2,
  MousePointer2,
  Plug,
  Puzzle,
  RefreshCw,
  Repeat,
  Rocket,
  Search,
  Server,
  Sparkles,
  Terminal,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Everything the agent can use, grouped, with its real state for this user
 * (GET /app/assistant/api/capabilities). Picking a ready item attaches it to
 * the next message — the server turns it into the tools the agent gets. A
 * server that is down, an app without connection or a disabled power never
 * looks ready: it shows why and what to do.
 */

export type CapabilityState = 'ready' | 'degraded' | 'needs_connection' | 'down' | 'disabled';

export interface CapabilityItem {
  id: string;
  group: string;
  label: string;
  description: string;
  state: CapabilityState;
  stateText?: string;
  icon: string;
  toolCount: number;
  extensionId?: string;
  health?: { status: string; latencyMs: number | null; lastError: string | null } | null;
  connect?: { kind: 'oauth' | 'composio'; target: string };
}

export interface CapabilityGroupData {
  id: string;
  label: string;
  items: CapabilityItem[];
}

/** What the composer keeps for a picked capability (chip). */
export interface PickedCapability {
  id: string;
  label: string;
  icon: string;
}

const ICONS: Record<string, React.ComponentType<{ size?: number }>> = {
  globe: Globe,
  'mouse-pointer': MousePointer2,
  terminal: Terminal,
  'file-text': FileText,
  'layout-dashboard': LayoutDashboard,
  image: ImageIcon,
  rocket: Rocket,
  users: Users,
  repeat: Repeat,
  brain: Brain,
  server: Server,
  plug: Plug,
  puzzle: Puzzle,
  sparkles: Sparkles,
  app: AppWindow,
};

export function CapabilityIcon({ name, size = 15 }: { name: string; size?: number }) {
  const Icon = ICONS[name] ?? Sparkles;
  return <Icon size={size} />;
}

// One fetch serves every composer for a minute (the list changes rarely).
let cache: { at: number; groups: CapabilityGroupData[] } | null = null;

export function useCapabilities(enabled: boolean) {
  const [groups, setGroups] = useState<CapabilityGroupData[] | null>(cache?.groups ?? null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (force = false) => {
    if (!force && cache && Date.now() - cache.at < 60_000) {
      setGroups(cache.groups);
      return;
    }
    try {
      const res = await fetch('/app/assistant/api/capabilities');
      const d = (await res.json().catch(() => ({}))) as {
        groups?: CapabilityGroupData[];
        error?: string;
      };
      if (!res.ok) throw new Error(d.error ?? 'No se pudieron cargar las capacidades');
      cache = { at: Date.now(), groups: d.groups ?? [] };
      setGroups(cache.groups);
      setError(null);
    } catch (err) {
      setGroups((g) => g ?? []);
      setError(err instanceof Error ? err.message : 'No se pudieron cargar las capacidades');
    }
  }, []);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  return { groups, error, reload: () => load(true) };
}

const STATE_LABEL: Record<CapabilityState, string> = {
  ready: 'Lista',
  degraded: 'Inestable',
  needs_connection: 'Conectar',
  down: 'Caída',
  disabled: 'No disponible',
};

export function CapabilityMenu({
  picked,
  onToggle,
  onConnectApp,
}: {
  picked: PickedCapability[];
  onToggle: (item: PickedCapability) => void;
  /** Composio apps connect in the Apps view (hosted authorization + polling). */
  onConnectApp: () => void;
}) {
  const { groups, error, reload } = useCapabilities(true);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [probe, setProbe] = useState<Record<string, string>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (groups ?? [])
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) => !q || `${i.label} ${i.description} ${g.label}`.toLowerCase().includes(q)
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  const connectOauth = async (item: CapabilityItem) => {
    if (!item.connect) return;
    setBusy(item.id);
    try {
      const res = await fetch(
        `/app/assistant/api/extensions/${encodeURIComponent(item.connect.target)}/oauth/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scopeType: 'personal' }),
        }
      );
      const d = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !d.url) throw new Error(d.error ?? 'No se pudo iniciar la conexión');
      window.open(d.url, '_blank', 'noopener,noreferrer');
      setProbe((p) => ({ ...p, [item.id]: 'Autoriza en la pestaña nueva y vuelve aquí.' }));
    } catch (err) {
      setProbe((p) => ({
        ...p,
        [item.id]: err instanceof Error ? err.message : 'No se pudo conectar',
      }));
    } finally {
      setBusy(null);
    }
  };

  const retry = async (item: CapabilityItem) => {
    if (!item.extensionId) return;
    setBusy(item.id);
    try {
      const res = await fetch('/app/assistant/api/capabilities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extensionId: item.extensionId }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        latencyMs?: number;
        error?: string;
      };
      setProbe((p) => ({
        ...p,
        [item.id]: d.ok
          ? `Responde de nuevo (${d.latencyMs ?? 0} ms).`
          : `Sigue sin responder: ${d.error ?? 'error'}`,
      }));
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const total = (groups ?? []).reduce((n, g) => n + g.items.length, 0);

  return (
    <div className="uv-capmenu">
      <label className="uv-pop-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={total ? `Buscar entre ${total} capacidades` : 'Buscar capacidad'}
          aria-label="Buscar capacidad"
        />
      </label>
      <div className="uv-pop-list uv-capmenu-list">
        {groups === null && (
          <div aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="uv-skel" style={{ height: 40, margin: '4px 6px' }} />
            ))}
          </div>
        )}
        {error && <p className="uv-section-note">{error}</p>}
        {groups !== null && filtered.length === 0 && !error && (
          <div className="uv-empty" style={{ padding: 16 }}>
            Sin capacidades que coincidan.
          </div>
        )}
        {filtered.map((g) => (
          <div key={g.id} role="group" aria-label={g.label}>
            <div className="uv-pop-title">{g.label}</div>
            {g.items.map((item) => {
              const selected = picked.some((p) => p.id === item.id);
              const usable = item.state === 'ready' || item.state === 'degraded';
              const note = probe[item.id] ?? item.stateText;
              return (
                <div
                  key={item.id}
                  className={cn('uv-cap-row', `is-${item.state}`, selected && 'is-selected')}
                >
                  <button
                    type="button"
                    className="uv-cap-main"
                    disabled={!usable}
                    aria-pressed={usable ? selected : undefined}
                    onClick={() =>
                      usable && onToggle({ id: item.id, label: item.label, icon: item.icon })
                    }
                    title={item.description}
                  >
                    <span className="uv-pop-item-icon">
                      <CapabilityIcon name={item.icon} />
                    </span>
                    <span className="uv-pop-item-text">
                      <span className="uv-pop-item-name">
                        {item.label}
                        {selected && <Check size={13} />}
                      </span>
                      <span className="uv-pop-item-sub">
                        {usable ? item.description : (note ?? item.description)}
                      </span>
                      {usable && note && <span className="uv-cap-note">{note}</span>}
                    </span>
                  </button>
                  {item.state === 'needs_connection' ? (
                    <button
                      type="button"
                      className="uv-btn is-secondary is-sm"
                      disabled={busy === item.id}
                      onClick={() =>
                        item.connect?.kind === 'composio' ? onConnectApp() : void connectOauth(item)
                      }
                    >
                      {busy === item.id ? (
                        <Loader2 size={12} className="uv-spin" />
                      ) : (
                        <Plug size={12} />
                      )}
                      Conectar
                    </button>
                  ) : item.state === 'down' && item.extensionId ? (
                    <button
                      type="button"
                      className="uv-btn is-ghost is-sm"
                      disabled={busy === item.id}
                      onClick={() => void retry(item)}
                      aria-label={`Probar ${item.label} de nuevo`}
                    >
                      {busy === item.id ? (
                        <Loader2 size={12} className="uv-spin" />
                      ) : (
                        <RefreshCw size={12} />
                      )}
                      Probar
                    </button>
                  ) : (
                    <span className={cn('uv-cap-state', `is-${item.state}`)}>
                      <i aria-hidden="true" />
                      {STATE_LABEL[item.state]}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
