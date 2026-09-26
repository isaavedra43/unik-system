'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File,
  FileText,
  Flag,
  Folder,
  FolderOpen,
  Globe,
  Hand,
  KeyRound,
  Loader2,
  Monitor,
  MousePointerClick,
  Power,
  PowerOff,
  Puzzle,
  RotateCw,
  ShieldAlert,
  Terminal,
  Timer,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolLabel } from '@/components/copilot/copilot-types';
import { hostOf, relTime, workspaceTabForTool, type WorkspaceTab } from './agent-types';
import { MISSION_STATUS_LABEL, missionProgress, type MissionItem } from './AgentSidebar';

/**
 * Workspace — the third column. Four surfaces, one at a time:
 *   Navegador   · the agent's browser (live frame + the pages it read)
 *   Computadora · the virtual machine (terminal with real outputs, files,
 *                 power button, secure-input takeover)
 *   Equipo      · missions, routines, approvals, cost, activity
 *   Archivos    · documents and media the team produced
 *
 * Data sources (all real, all degrade gracefully):
 * - SSE `assistant:{conversationId}` → workspace.* events.
 * - SSE `user:{id}` → agent.task delegation events.
 * - Poll `/app/assistant/api/venue/state` while the VM is on (tab visible only).
 * - `/app/assistant/api/missions`, `/proposals`, `/usage`, `/composio/toolkits`.
 */

interface PageItem {
  url: string;
  title?: string;
  snippet?: string;
  source?: string;
  ts?: string;
}

type ToolDetail =
  | {
      kind: 'exec';
      command: string;
      cwd?: string;
      exitCode: number | null;
      output: string;
      truncated?: boolean;
    }
  | {
      kind: 'files';
      path: string;
      files: {
        name: string;
        path?: string;
        isDir: boolean;
        size: number | null;
        modifiedAt?: string;
      }[];
      total: number;
    }
  | {
      kind: 'file';
      path?: string;
      preview?: string;
      bytes?: number | null;
      written?: boolean;
      truncated?: boolean;
    };

interface ActivityItem {
  id: number;
  tool: string;
  ok: boolean;
  summary?: string;
  error?: string;
  ts?: string;
  detail?: ToolDetail;
}

interface ArtifactItem {
  artifactId: string;
  title?: string;
  fileName?: string;
  mimeType?: string;
  downloadUrl?: string;
}

interface MediaItem {
  id: number;
  medium?: string;
  url?: string;
  providerTool?: string;
}

interface ScreenState {
  dataUrl: string;
  url?: string | null;
  title?: string | null;
  ts?: string;
}

interface SecureInputField {
  selector: string;
  label: string;
  sensitive?: boolean;
}

interface SecureInputRequest {
  requestId: string;
  venueSessionId?: string;
  message?: string | null;
  fields: SecureInputField[];
}

interface PendingProposal {
  id: string;
  toolName: string;
  summary: string;
  effect?: string;
  expiresAt?: string;
  conversationId?: string | null;
}

interface UsageData {
  jev?: number;
  llm?: number;
  venue?: number;
  venueMinutes?: number;
  spent?: number;
  budget?: number;
  label?: string;
}

interface ApiApp {
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
}

interface VenueState {
  active: boolean;
  booting: boolean;
  reason?: string | null;
  sessionId?: string;
}

export interface WorkspacePanelProps {
  conversationId: string | null;
  /** Owner channel for `agent.task` delegation events. */
  userId?: string;
  tab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  /** Auto-switch request from the chat (a tool just started). */
  hint?: { tab: WorkspaceTab; at: number } | null;
  onClose?: () => void;
  onOpenConversation?: (id: string) => void;
  /** Quick actions from empty states send a message on the user's behalf. */
  onSendText?: (text: string) => void;
}

const TOOL_ICON: Record<string, React.ReactNode> = {
  web_search: <Globe size={12} />,
  fetch_url: <FileText size={12} />,
  web_crawl: <Globe size={12} />,
  browser: <MousePointerClick size={12} />,
  venueExec: <Terminal size={12} />,
  venueListFiles: <FolderOpen size={12} />,
  venueReadFile: <File size={12} />,
  venueWriteFile: <File size={12} />,
  venueScreenshot: <Monitor size={12} />,
};

const MAX_ITEMS = 80;
const TERMINAL_LINES = 60;
/** A manual tab choice wins over auto-switching for this long. */
const MANUAL_TAB_HOLD_MS = 20_000;
const VENUE_TOOL_RE = /^(browser|browserProfile|venue\w*)/;

function clockOf(ts?: string): string {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function elapsedLabel(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function faviconOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

const TABS: Array<{ id: WorkspaceTab; label: string; icon: React.ReactNode }> = [
  { id: 'browser', label: 'Navegador', icon: <Globe size={14} /> },
  { id: 'computer', label: 'Computadora', icon: <Terminal size={14} /> },
  { id: 'team', label: 'Equipo', icon: <Users size={14} /> },
  { id: 'files', label: 'Archivos', icon: <FolderOpen size={14} /> },
];

export function WorkspacePanel({
  conversationId,
  userId,
  tab,
  onTabChange,
  hint,
  onClose,
  onOpenConversation,
  onSendText,
}: WorkspacePanelProps) {
  const [screen, setScreen] = useState<ScreenState | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [pageContent, setPageContent] = useState<
    Record<string, { title?: string; markdown: string }>
  >({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [browserActions, setBrowserActions] = useState<ActivityItem[]>([]);
  const [readerUrl, setReaderUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [venue, setVenue] = useState<VenueState>({ active: false, booting: false });
  const [powerBusy, setPowerBusy] = useState<'start' | 'stop' | null>(null);
  const [powerError, setPowerError] = useState<string | null>(null);
  const [secureInputs, setSecureInputs] = useState<SecureInputRequest[]>([]);
  const [secureInputBusy, setSecureInputBusy] = useState<string | null>(null);
  const [secureInputDone, setSecureInputDone] = useState<Set<string>>(new Set());
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [missionsLoaded, setMissionsLoaded] = useState(false);
  const [approvals, setApprovals] = useState<PendingProposal[]>([]);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [apiApps, setApiApps] = useState<ApiApp[] | null>(null);
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const counterRef = useRef(0);
  const startRef = useRef<number | null>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const manualAtRef = useRef(0);
  const onTabChangeRef = useRef(onTabChange);
  onTabChangeRef.current = onTabChange;

  const autoTab = useCallback((next: WorkspaceTab) => {
    if (Date.now() - manualAtRef.current < MANUAL_TAB_HOLD_MS) return;
    onTabChangeRef.current(next);
  }, []);

  function pickTab(next: WorkspaceTab) {
    manualAtRef.current = Date.now();
    onTabChange(next);
  }

  // Chat-side hints ("browser tool just started") → bring that surface up.
  useEffect(() => {
    if (hint) autoTab(hint.tab);
  }, [hint, autoTab]);

  // Reset per-conversation state when switching threads.
  useEffect(() => {
    setScreen(null);
    setPages([]);
    setPageContent({});
    setActivity([]);
    setArtifacts([]);
    setMedia([]);
    setBrowserActions([]);
    setReaderUrl(null);
    setConnected(false);
    setSecureInputs([]);
    setSecureInputDone(new Set());
    setExpanded(new Set());
    startRef.current = null;
  }, [conversationId]);

  const readVenueState = useCallback(async (): Promise<void> => {
    const res = await fetch('/app/assistant/api/venue/state', { cache: 'no-store' });
    if (!res.ok) return;
    const d = (await res.json()) as {
      active?: boolean;
      booting?: boolean;
      reason?: string | null;
      sessionId?: string;
      screen?: { dataUrl?: string; url?: string | null; title?: string | null } | null;
      pendingInputs?: { requestId: string; message?: string | null; fields: SecureInputField[] }[];
    };
    setVenue({
      active: d.active === true,
      booting: d.booting === true,
      reason: d.reason ?? null,
      sessionId: d.sessionId,
    });
    if (d.active && d.screen?.dataUrl) {
      setScreen({ dataUrl: d.screen.dataUrl, url: d.screen.url, title: d.screen.title });
    }
    if (d.pendingInputs) {
      setSecureInputs((prev) => {
        const serverIds = new Set(d.pendingInputs!.map((r) => r.requestId));
        const kept = prev.filter((r) => serverIds.has(r.requestId));
        const known = new Set(kept.map((r) => r.requestId));
        return [
          ...kept,
          ...d
            .pendingInputs!.filter((r) => !known.has(r.requestId))
            .map((r) => ({ ...r, venueSessionId: d.sessionId })),
        ];
      });
    }
  }, []);

  // The sandbox is per-user, not per-thread: hydrate the real state on mount
  // and on thread switch so a reload never shows "apagada" while it runs.
  useEffect(() => {
    readVenueState().catch(() => undefined);
  }, [conversationId, readVenueState]);

  // Workspace events for this thread.
  useEffect(() => {
    if (!conversationId) return;
    const channel = `assistant:${conversationId}`;
    const es = new EventSource(`/app/realtime/api/stream?channels=${encodeURIComponent(channel)}`);
    const parse = <T,>(ev: Event): T | null => {
      try {
        return JSON.parse((ev as MessageEvent).data) as T;
      } catch {
        return null;
      }
    };

    es.addEventListener('ready', () => setConnected(true));

    es.addEventListener('workspace.tool', (ev) => {
      const d = parse<{
        tool?: string;
        ok?: boolean;
        summary?: string;
        error?: string;
        ts?: string;
        detail?: ToolDetail;
      }>(ev);
      if (!d?.tool) return;
      if (!startRef.current) startRef.current = Date.now();
      if (VENUE_TOOL_RE.test(d.tool)) setVenue((v) => ({ ...v, active: true }));
      const target = workspaceTabForTool(d.tool);
      if (target) autoTab(target);
      setActivity((prev) =>
        [
          ...prev,
          {
            id: ++counterRef.current,
            tool: d.tool!,
            ok: d.ok === true,
            summary: d.summary,
            error: d.error,
            ts: d.ts,
            detail: d.detail,
          },
        ].slice(-MAX_ITEMS)
      );
    });

    es.addEventListener('workspace.pages', (ev) => {
      const d = parse<{ source?: string; pages?: PageItem[]; ts?: string }>(ev);
      const incoming = (d?.pages ?? []).filter((p) => p.url);
      if (incoming.length === 0) return;
      setPages((prev) => {
        const seen = new Set(prev.map((p) => p.url));
        const fresh = incoming
          .filter((p) => !seen.has(p.url))
          .map((p) => ({ ...p, source: d?.source }));
        return [...prev, ...fresh].slice(-MAX_ITEMS);
      });
      autoTab('browser');
    });

    es.addEventListener('workspace.page_content', (ev) => {
      const d = parse<{ url?: string; title?: string; markdown?: string }>(ev);
      if (!d?.url || !d.markdown) return;
      setPageContent((prev) => ({ ...prev, [d.url!]: { title: d.title, markdown: d.markdown! } }));
    });

    es.addEventListener('workspace.screen', (ev) => {
      const d = parse<{ dataUrl?: string; url?: string; ts?: string }>(ev);
      setVenue((v) => ({ ...v, active: true, booting: false }));
      if (d?.dataUrl) setScreen({ dataUrl: d.dataUrl, url: d.url, ts: d.ts });
      autoTab('browser');
    });

    es.addEventListener('workspace.browser', (ev) => {
      const d = parse<{ action?: string; url?: string; ok?: boolean; error?: string; ts?: string }>(
        ev
      );
      setVenue((v) => ({ ...v, active: true }));
      if (!startRef.current) startRef.current = Date.now();
      setBrowserActions((prev) =>
        [
          ...prev,
          {
            id: ++counterRef.current,
            tool: `browser.${d?.action ?? 'act'}`,
            ok: d?.ok === true,
            summary: d?.url,
            error: d?.error,
            ts: d?.ts,
          },
        ].slice(-MAX_ITEMS)
      );
      autoTab('browser');
    });

    es.addEventListener('workspace.secure_input', (ev) => {
      const d = parse<SecureInputRequest & { requestId?: string }>(ev);
      if (!d?.requestId) return;
      setVenue((v) => ({ ...v, active: true }));
      setSecureInputs((prev) =>
        prev.some((r) => r.requestId === d.requestId) ? prev : [...prev, d]
      );
      autoTab('computer');
    });

    es.addEventListener('workspace.artifact', (ev) => {
      const d = parse<ArtifactItem>(ev);
      if (!d?.artifactId) return;
      setArtifacts((prev) =>
        prev.some((a) => a.artifactId === d.artifactId) ? prev : [...prev, d].slice(-MAX_ITEMS)
      );
      autoTab('files');
    });

    es.addEventListener('workspace.media', (ev) => {
      const d = parse<{ medium?: string; url?: string; providerTool?: string }>(ev);
      setMedia((prev) =>
        [
          ...prev,
          {
            id: ++counterRef.current,
            medium: d?.medium,
            url: d?.url,
            providerTool: d?.providerTool,
          },
        ].slice(-MAX_ITEMS)
      );
      autoTab('files');
    });

    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [conversationId, autoTab]);

  // Delegation events on the owner channel → team activity.
  useEffect(() => {
    if (!userId) return;
    const es = new EventSource(
      `/app/realtime/api/stream?channels=${encodeURIComponent(`user:${userId}`)}`
    );
    es.addEventListener('agent.task', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          taskId?: string;
          status?: string;
          title?: string;
        };
        if (!d.title && !d.status) return;
        if (!startRef.current) startRef.current = Date.now();
        setActivity((prev) =>
          [
            ...prev,
            {
              id: ++counterRef.current,
              tool: 'agent.task',
              ok: d.status !== 'failed' && d.status !== 'cancelled',
              summary: `${d.status ?? ''} ${d.title ?? ''}`.trim(),
              ts: new Date().toISOString(),
            },
          ].slice(-MAX_ITEMS)
        );
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [userId]);

  // Live screen: poll while the VM is on and the tab is visible.
  useEffect(() => {
    if (!venue.active) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        await readVenueState();
      } catch {
        /* best-effort */
      }
    };
    void tick();
    const interval = setInterval(tick, venue.booting ? 3000 : 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [venue.active, venue.booting, readVenueState]);

  // Missions + approvals + usage + API apps — every failure hides its section.
  useEffect(() => {
    let cancelled = false;
    fetch('/app/assistant/api/missions')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const d = (await res.json()) as { missions?: MissionItem[] };
        setMissions(d.missions ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setMissionsLoaded(true);
      });
    fetch('/app/assistant/api/proposals')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const d = (await res.json()) as { proposals?: PendingProposal[] };
        setApprovals(d.proposals ?? []);
      })
      .catch(() => undefined);
    fetch('/app/assistant/api/usage')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        setUsage((await res.json()) as UsageData);
      })
      .catch(() => undefined);
    fetch('/app/assistant/api/composio/toolkits')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const d = (await res.json()) as { configured?: boolean; toolkits?: ApiApp[] };
        setApiConfigured(d.configured === true);
        setApiApps(d.toolkits ?? []);
      })
      .catch(() => {
        if (!cancelled) setApiConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const feedItems = [...activity, ...browserActions].sort((a, b) => a.id - b.id);
  const terminalItems = feedItems.filter(
    (a) => VENUE_TOOL_RE.test(a.tool) || a.tool.startsWith('browser.')
  );
  const teamActivity = feedItems.filter(
    (a) => !VENUE_TOOL_RE.test(a.tool) && !a.tool.startsWith('browser.')
  );
  const terminalLive = venue.active || terminalItems.length > 0;

  useEffect(() => {
    if (!terminalLive) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [terminalLive]);

  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminalItems.length, tab]);

  async function togglePower(action: 'start' | 'stop') {
    setPowerBusy(action);
    setPowerError(null);
    try {
      const res = await fetch('/app/assistant/api/venue/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        browserReady?: boolean;
        reason?: string | null;
      };
      if (!res.ok || d.ok === false) throw new Error(d.error ?? 'No se pudo cambiar el estado');
      if (action === 'start') {
        setVenue({ active: true, booting: d.browserReady !== true, reason: d.reason ?? null });
      } else {
        setVenue({ active: false, booting: false });
        setScreen(null);
      }
    } catch (e) {
      setPowerError(e instanceof Error ? e.message : 'No se pudo cambiar el estado');
    } finally {
      setPowerBusy(null);
    }
  }

  async function refreshScreen() {
    setRefreshing(true);
    try {
      await readVenueState();
    } catch {
      /* ignore */
    } finally {
      setRefreshing(false);
    }
  }

  async function submitSecureInput(req: SecureInputRequest, form: HTMLFormElement) {
    const sessionId = req.venueSessionId ?? venue.sessionId;
    if (!sessionId) return;
    setSecureInputBusy(req.requestId);
    try {
      const values: Record<string, string> = {};
      for (const f of req.fields) {
        const el = form.elements.namedItem(f.selector) as HTMLInputElement | null;
        if (el?.value) values[f.selector] = el.value;
      }
      const res = await fetch('/app/assistant/api/venue/secure-input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, requestId: req.requestId, values }),
      });
      if (!res.ok) throw new Error('failed');
      form.reset();
      setSecureInputs((prev) => prev.filter((r) => r.requestId !== req.requestId));
      setSecureInputDone((prev) => new Set(prev).add(req.requestId));
    } catch {
      /* keep the form so the user can retry */
    } finally {
      setSecureInputBusy(null);
    }
  }

  const activeMissions = missions.filter((m) =>
    ['active', 'blocked', 'awaiting_approval'].includes(m.status)
  );
  const vigils = missions.filter((m) => m.schedule);
  const connectedApps = apiApps?.filter((a) => a.connected) ?? [];
  const elapsed = startRef.current ? elapsedLabel(startRef.current, now) : '0:00';
  const filesCount = artifacts.length + media.length;
  const teamCount = activeMissions.length + approvals.length;

  const tabMeta: Record<WorkspaceTab, { live?: boolean; count?: number }> = {
    browser: { live: venue.active && Boolean(screen), count: pages.length || undefined },
    computer: { live: venue.active },
    team: { count: teamCount || undefined },
    files: { count: filesCount || undefined },
  };

  /* ------------------------------------------------------------------ */
  /* Surfaces                                                             */
  /* ------------------------------------------------------------------ */

  const takeover = (
    <>
      {secureInputs.map((req) => (
        <div key={req.requestId} className="uv-takeover">
          <div className="uv-takeover-head">
            <Hand size={14} /> Acción necesaria en la página
          </div>
          <p>{req.message ?? 'La página pide datos que solo tú debes escribir.'}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitSecureInput(req, e.currentTarget);
            }}
          >
            {req.fields.map((f) => (
              <label key={f.selector}>
                <span>{f.label}</span>
                <input
                  name={f.selector}
                  type={f.sensitive ? 'password' : 'text'}
                  autoComplete="off"
                  required
                  disabled={secureInputBusy === req.requestId}
                />
              </label>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                type="submit"
                className="uv-btn is-brand"
                disabled={secureInputBusy === req.requestId}
              >
                {secureInputBusy === req.requestId ? (
                  <Loader2 size={12} className="copilot-spin" />
                ) : (
                  <KeyRound size={12} />
                )}
                Escribir en la página
              </button>
            </div>
            <p className="uv-takeover-note">
              Los datos van directo a la computadora virtual — nunca pasan por el chat ni por la IA.
            </p>
          </form>
        </div>
      ))}
      {secureInputDone.size > 0 && secureInputs.length === 0 && (
        <div className="uv-takeover-done">
          Listo — datos escritos en la página. El agente continúa solo.
        </div>
      )}
    </>
  );

  const browserSurface = (
    <>
      <div className="uv-browser">
        <div className="uv-browser-chrome">
          <span className="uv-browser-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="uv-browser-nav" aria-hidden="true">
            <span>
              <ChevronLeft size={14} />
            </span>
            <span>
              <ChevronRight size={14} />
            </span>
          </span>
          <span className="uv-browser-url" title={screen?.url ?? undefined}>
            {screen?.url ? (
              <>
                <Globe size={12} />
                <b>{hostOf(screen.url)}</b>
                <span style={{ opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {screen.url}
                </span>
                <a
                  href={screen.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="Abrir en pestaña nueva"
                >
                  <ExternalLink size={12} />
                </a>
              </>
            ) : (
              <>
                <Globe size={12} />{' '}
                {venue.active ? 'Navegador listo — sin página abierta' : 'Navegador del agente'}
              </>
            )}
          </span>
          <button
            type="button"
            className="uv-icon-btn"
            style={{ width: 28, height: 28 }}
            onClick={() => void refreshScreen()}
            disabled={!venue.active || refreshing}
            aria-label="Actualizar captura"
            title="Actualizar captura"
          >
            <RotateCw size={13} className={refreshing ? 'copilot-spin' : undefined} />
          </button>
        </div>
        <div className="uv-browser-screen">
          {screen ? (
            <>
              {/* Remote-computer frame: data URL, never user HTML. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={screen.dataUrl} alt={screen.title ?? 'Pantalla del navegador del agente'} />
              {venue.active && (
                <span className="uv-live-tag">
                  <i /> EN VIVO
                </span>
              )}
            </>
          ) : (
            <div className="uv-browser-idle">
              {venue.booting ? (
                <>
                  <Loader2 size={22} className="copilot-spin" />
                  <strong>Preparando el navegador…</strong>
                  <span>
                    {venue.reason
                      ? venue.reason.slice(0, 160)
                      : 'La computadora virtual está arrancando.'}
                  </span>
                </>
              ) : venue.active ? (
                <>
                  <Globe size={22} />
                  <strong>Navegador listo</strong>
                  <span>Pídele al agente que abra una página y la verás aquí en vivo.</span>
                  {onSendText && (
                    <button
                      type="button"
                      className="uv-btn"
                      onClick={() =>
                        onSendText(
                          'Abre https://www.google.com en el navegador de la computadora virtual y muéstrame la pantalla.'
                        )
                      }
                    >
                      <MousePointerClick size={13} /> Abrir Google de prueba
                    </button>
                  )}
                </>
              ) : (
                <>
                  <Monitor size={22} />
                  <strong>Computadora apagada</strong>
                  <span>Enciéndela para que el agente pueda navegar; verás cada página aquí.</span>
                  <button
                    type="button"
                    className="uv-btn is-brand"
                    onClick={() => void togglePower('start')}
                    disabled={powerBusy !== null}
                  >
                    {powerBusy === 'start' ? (
                      <Loader2 size={13} className="copilot-spin" />
                    ) : (
                      <Power size={13} />
                    )}
                    Encender
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="uv-browser-foot">
          {screen?.title ? (
            <span>{screen.title}</span>
          ) : (
            <span>Lo que el agente ve en su navegador</span>
          )}
          <span className="uv-spacer" />
          {screen?.ts && <span>{clockOf(screen.ts)}</span>}
        </div>
      </div>
      {powerError && <div className="uv-error">{powerError}</div>}

      {takeover}

      {pages.length > 0 && (
        <section className="uv-ws-section">
          <h4 className="uv-ws-title">
            <Globe size={12} /> Páginas leídas
            <span className="uv-spacer" />
            <span>{pages.length}</span>
          </h4>
          <ul className="uv-pages">
            {[...pages].reverse().map((p) => {
              const fav = faviconOf(p.url);
              const open = readerUrl === p.url;
              return (
                <li key={p.url}>
                  <button
                    type="button"
                    className={cn('uv-page', open && 'is-open')}
                    onClick={() => setReaderUrl(open ? null : p.url)}
                    title={p.url}
                  >
                    <span className="uv-favicon" aria-hidden="true">
                      {fav ? (
                        // Site favicon — decorative, external, 14px.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={fav}
                          alt=""
                          loading="lazy"
                          onError={(e) => (e.currentTarget.style.display = 'none')}
                        />
                      ) : (
                        <Globe size={12} />
                      )}
                    </span>
                    <span className="uv-page-text">
                      <span className="uv-page-title">{p.title || hostOf(p.url)}</span>
                      <span className="uv-page-host">
                        {hostOf(p.url)}
                        {p.source ? ` · ${p.source.replace('_', ' ')}` : ''}
                      </span>
                      {p.snippet && <span className="uv-page-snippet">{p.snippet}</span>}
                    </span>
                    {pageContent[p.url] && (
                      <FileText
                        size={13}
                        style={{ color: 'var(--unik-text-muted)', flexShrink: 0 }}
                      />
                    )}
                  </button>
                  {open && pageContent[p.url] && (
                    <div className="uv-reader" style={{ marginTop: 6 }}>
                      <div className="uv-reader-title">{pageContent[p.url].title || p.url}</div>
                      {/* Untrusted external content — text only, never HTML. */}
                      <pre className="uv-reader-body">
                        {pageContent[p.url].markdown.slice(0, 12000)}
                      </pre>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="uv-reader-link"
                      >
                        Abrir página original <ExternalLink size={11} />
                      </a>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );

  const computerSurface = (
    <>
      <div className="uv-card uv-power">
        <span
          className={cn(
            'uv-power-led',
            venue.active && !venue.booting && 'is-on',
            venue.booting && 'is-booting'
          )}
        />
        <div className="uv-power-state">
          <b>
            {venue.booting
              ? 'Arrancando…'
              : venue.active
                ? 'Computadora encendida'
                : 'Computadora apagada'}
          </b>
          <span>
            {venue.booting
              ? (venue.reason ?? 'Preparando navegador y herramientas')
              : venue.active
                ? `Sesión activa · ${elapsed}`
                : 'Sandbox desechable: navegador, terminal y archivos del agente'}
          </span>
        </div>
        {venue.active ? (
          <button
            type="button"
            className="uv-btn is-danger"
            onClick={() => void togglePower('stop')}
            disabled={powerBusy !== null}
          >
            {powerBusy === 'stop' ? (
              <Loader2 size={13} className="copilot-spin" />
            ) : (
              <PowerOff size={13} />
            )}
            Apagar
          </button>
        ) : (
          <button
            type="button"
            className="uv-btn is-brand"
            onClick={() => void togglePower('start')}
            disabled={powerBusy !== null}
          >
            {powerBusy === 'start' ? (
              <Loader2 size={13} className="copilot-spin" />
            ) : (
              <Power size={13} />
            )}
            Encender
          </button>
        )}
      </div>
      {powerError && <div className="uv-error">{powerError}</div>}

      {takeover}

      <div className="uv-term">
        <div className="uv-term-head">
          <Terminal size={12} /> Terminal
          <span className="uv-spacer" />
          {terminalLive && (
            <span className="uv-elapsed">
              <Timer size={11} style={{ verticalAlign: '-2px' }} /> {elapsed}
            </span>
          )}
        </div>
        <div className="uv-term-body" ref={termRef} aria-live="polite">
          {terminalItems.length === 0 ? (
            <div className="uv-term-empty">
              {venue.active
                ? 'Cada comando, archivo y acción del navegador aparecerá aquí con su salida real.'
                : 'Apagada. Enciende la computadora o pídele al agente algo que la necesite.'}
              {onSendText && venue.active && (
                <div className="uv-ws-empty-actions">
                  <button
                    type="button"
                    className="uv-btn"
                    onClick={() =>
                      onSendText(
                        'En la computadora virtual, lista los archivos de /home y dime qué hay.'
                      )
                    }
                  >
                    <FolderOpen size={12} /> Listar /home
                  </button>
                </div>
              )}
            </div>
          ) : (
            terminalItems.slice(-TERMINAL_LINES).map((a) => {
              const d = a.detail;
              const isOpen = expanded.has(a.id);
              return (
                <div key={a.id} className={cn('uv-term-line-wrap')}>
                  <div className={cn('uv-term-line', !a.ok && 'is-failed')}>
                    <span className="uv-term-time">{clockOf(a.ts)}</span>
                    <span className="uv-term-icon">
                      {TOOL_ICON[a.tool] ?? TOOL_ICON[a.tool.split('.')[0]] ?? <Wrench size={12} />}
                    </span>
                    <span className="uv-term-text">
                      {d?.kind === 'exec' ? (
                        <span className="uv-term-cmd">{d.command}</span>
                      ) : (
                        <>
                          {toolLabel(a.tool, 'done')}
                          {a.summary && <span className="uv-term-sum"> · {a.summary}</span>}
                        </>
                      )}
                      {a.error && <span className="uv-term-sum"> · {a.error}</span>}
                    </span>
                  </div>
                  {d?.kind === 'exec' && d.output && (
                    <>
                      <pre
                        className={cn(
                          'uv-term-out',
                          !isOpen && d.output.length > 600 && 'is-collapsed'
                        )}
                      >
                        {d.output}
                        {d.truncated ? '\n…' : ''}
                      </pre>
                      {d.output.length > 600 && (
                        <button
                          type="button"
                          className="uv-term-more"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(a.id)) next.delete(a.id);
                              else next.add(a.id);
                              return next;
                            })
                          }
                        >
                          {isOpen ? 'ver menos' : 'ver todo'}
                        </button>
                      )}
                    </>
                  )}
                  {d?.kind === 'exec' && d.exitCode !== null && d.exitCode !== 0 && (
                    <div className="uv-term-line is-failed">
                      <span className="uv-term-time" />
                      <span className="uv-term-text">exit {d.exitCode}</span>
                    </div>
                  )}
                  {d?.kind === 'files' && (
                    <div className="uv-files">
                      {d.files.length === 0 && <span className="uv-file">carpeta vacía</span>}
                      {d.files.map((f) => (
                        <span
                          key={f.path ?? f.name}
                          className={cn('uv-file', f.isDir && 'is-dir')}
                          title={f.path}
                        >
                          {f.isDir ? <Folder size={11} /> : <File size={11} />}
                          {f.name}
                          {!f.isDir && f.size !== null && <small>{formatBytes(f.size)}</small>}
                        </span>
                      ))}
                      {d.total > d.files.length && (
                        <span className="uv-file">… {d.total - d.files.length} más</span>
                      )}
                    </div>
                  )}
                  {d?.kind === 'file' && d.preview && (
                    <pre
                      className={cn(
                        'uv-term-out',
                        !isOpen && d.preview.length > 600 && 'is-collapsed'
                      )}
                    >
                      {d.preview}
                      {d.truncated ? '\n…' : ''}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {screen && (
        <div
          className="uv-card"
          style={{ padding: 8, display: 'flex', gap: 10, alignItems: 'center' }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={screen.dataUrl}
            alt=""
            style={{ width: 96, borderRadius: 8, border: '1px solid var(--unik-border)' }}
          />
          <div style={{ minWidth: 0, fontSize: 12, color: 'var(--unik-text-secondary)' }}>
            <div style={{ fontWeight: 500, color: 'var(--unik-text)' }}>Navegador</div>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {screen.url ? hostOf(screen.url) : 'sin página'}
            </div>
          </div>
          <span className="uv-spacer" style={{ flex: 1 }} />
          <button type="button" className="uv-btn" onClick={() => pickTab('browser')}>
            Ver <ChevronRight size={12} />
          </button>
        </div>
      )}
    </>
  );

  const teamSurface = (
    <>
      <section className="uv-ws-section">
        <h4 className="uv-ws-title">Superficies</h4>
        <div className="uv-surfaces">
          <button
            type="button"
            className={cn('uv-surface', venue.active && 'is-live')}
            onClick={() => pickTab('computer')}
          >
            <Monitor size={15} />
            <b>Computadora</b>
            <span>{venue.booting ? 'Arrancando' : venue.active ? 'Encendida' : 'Apagada'}</span>
          </button>
          <button
            type="button"
            className={cn('uv-surface', pages.length > 0 && 'is-live')}
            onClick={() => pickTab('browser')}
          >
            <Globe size={15} />
            <b>Navegador</b>
            <span>
              {pages.length > 0 ? `${pages.length} páginas` : screen ? 'En vivo' : 'Sin abrir'}
            </span>
          </button>
          <button
            type="button"
            className={cn('uv-surface', connectedApps.length > 0 && 'is-live')}
            disabled
          >
            <Puzzle size={15} />
            <b>Apps por API</b>
            <span>
              {apiConfigured === null
                ? '…'
                : apiConfigured === false
                  ? 'Sin configurar'
                  : `${connectedApps.length} conectadas`}
            </span>
          </button>
        </div>
        {connectedApps.length > 0 && (
          <div className="uv-apps">
            {connectedApps.slice(0, 10).map((a) => (
              <span key={a.slug} className="uv-app" title={a.name}>
                {a.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.logo} alt="" />
                ) : (
                  <Puzzle size={11} />
                )}
                {a.name}
              </span>
            ))}
          </div>
        )}
      </section>

      {approvals.length > 0 && (
        <section className="uv-ws-section">
          <h4 className="uv-ws-title">
            <ShieldAlert size={12} /> Aprobaciones pendientes
            <span className="uv-spacer" />
            <span className="uv-tab-count">{approvals.length}</span>
          </h4>
          <ul className="uv-list">
            {approvals.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="uv-row uv-approval"
                  onClick={() => p.conversationId && onOpenConversation?.(p.conversationId)}
                  disabled={!p.conversationId}
                  title={p.summary}
                >
                  <span className="uv-row-title">{toolLabel(p.toolName, 'done')}</span>
                  <span className="uv-row-meta">
                    {p.summary}
                    {p.expiresAt && ` · caduca ${relTime(p.expiresAt)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {missionsLoaded && (
        <section className="uv-ws-section">
          <h4 className="uv-ws-title">
            <Flag size={12} /> Misiones activas
            {activeMissions.length > 0 && (
              <>
                <span className="uv-spacer" />
                <span className="uv-tab-count">{activeMissions.length}</span>
              </>
            )}
          </h4>
          {activeMissions.length === 0 ? (
            <div className="uv-empty-inline">
              Sin misiones en curso — pídele una al Central desde el chat.
            </div>
          ) : (
            <ul className="uv-list">
              {activeMissions.map((m) => {
                const { done, total } = missionProgress(m);
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      className="uv-row"
                      onClick={() => m.conversationId && onOpenConversation?.(m.conversationId)}
                      disabled={!m.conversationId}
                      title={m.goal}
                    >
                      <span className="uv-row-title">{m.goal}</span>
                      <span className="uv-row-meta">
                        {MISSION_STATUS_LABEL[m.status] ?? m.status}
                        {total > 0 && ` · ${done}/${total}`}
                      </span>
                      {total > 0 && (
                        <span className="uv-progress" aria-hidden="true">
                          <i style={{ transform: `scaleX(${done / total})` }} />
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {vigils.length > 0 && (
        <section className="uv-ws-section">
          <h4 className="uv-ws-title">
            <Timer size={12} /> Rutinas
          </h4>
          <ul className="uv-list">
            {vigils.map((m) => (
              <li key={m.id}>
                <div className="uv-row" style={{ cursor: 'default' }}>
                  <span className="uv-row-title">{m.goal}</span>
                  <span className="uv-row-meta">
                    {m.schedule?.startsWith('daily:')
                      ? `Todos los días ${m.schedule.slice(6)}`
                      : m.schedule?.startsWith('every:')
                        ? `Cada ${m.schedule.slice(6)} min`
                        : m.schedule}
                    {m.nextRunAt && ` · próxima ${relTime(m.nextRunAt)}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {usage && (
        <section className="uv-ws-section">
          <h4 className="uv-ws-title">Costo del equipo · {usage.label ?? 'este mes'}</h4>
          <div className="uv-card uv-cost">
            {usage.jev !== undefined && (
              <div className="uv-cost-row">
                <span>Router (Jev)</span>
                <b>{usage.jev} llamadas</b>
              </div>
            )}
            {usage.llm !== undefined && (
              <div className="uv-cost-row">
                <span>Modelos</span>
                <b>${usage.llm.toFixed(3)}</b>
              </div>
            )}
            {(usage.venue !== undefined || usage.venueMinutes !== undefined) && (
              <div className="uv-cost-row">
                <span>Computadora virtual</span>
                <b>
                  {usage.venue && usage.venue > 0 ? `$${usage.venue.toFixed(3)} · ` : ''}
                  {usage.venueMinutes ?? 0} min
                </b>
              </div>
            )}
            {usage.spent !== undefined && (
              <div className="uv-cost-row is-total">
                <span>Total medido</span>
                <b>
                  ${usage.spent.toFixed(3)}
                  {usage.budget !== undefined ? ` de $${usage.budget.toFixed(2)}` : ''}
                </b>
              </div>
            )}
          </div>
        </section>
      )}

      {teamActivity.length > 0 && (
        <section className="uv-ws-section">
          <h4 className="uv-ws-title">
            <Activity size={12} /> Actividad
          </h4>
          <ul className="uv-activity">
            {[...teamActivity]
              .reverse()
              .slice(0, 40)
              .map((a) => (
                <li key={a.id} className={cn('uv-act', !a.ok && 'is-failed')}>
                  {TOOL_ICON[a.tool] ?? <Wrench size={12} />}
                  <span style={{ minWidth: 0 }}>
                    <span className="uv-act-name">
                      {a.tool === 'agent.task' ? 'Tarea delegada' : toolLabel(a.tool, 'done')}
                    </span>
                    {(a.summary || a.error) && (
                      <span className="uv-act-sum">{a.error ?? a.summary}</span>
                    )}
                  </span>
                  <span className="uv-spacer" style={{ flex: 1 }} />
                  <span className="uv-term-time" style={{ color: 'var(--unik-text-muted)' }}>
                    {clockOf(a.ts)}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}
    </>
  );

  const filesSurface = (
    <>
      {artifacts.length === 0 && media.length === 0 ? (
        <div className="uv-ws-empty">
          <span className="uv-ws-empty-icon">
            <FolderOpen size={22} />
          </span>
          <strong>Sin archivos todavía</strong>
          <span>
            Los reportes, PDFs, hojas de cálculo e imágenes que genere el equipo aparecerán aquí.
          </span>
          {onSendText && (
            <div className="uv-ws-empty-actions">
              <button
                type="button"
                className="uv-btn"
                onClick={() => onSendText('Genera un PDF con el resumen de ventas de hoy.')}
              >
                <FileText size={12} /> PDF de ventas de hoy
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {artifacts.length > 0 && (
            <section className="uv-ws-section">
              <h4 className="uv-ws-title">
                <FileText size={12} /> Documentos
                <span className="uv-spacer" />
                <span>{artifacts.length}</span>
              </h4>
              <ul className="uv-list">
                {[...artifacts].reverse().map((a) => (
                  <li key={a.artifactId}>
                    <a
                      className="uv-artifact"
                      href={a.downloadUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <FileText size={15} />
                      <span>{a.title || a.fileName || 'Archivo'}</span>
                      <ExternalLink size={12} style={{ marginLeft: 'auto' }} />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {media.length > 0 && (
            <section className="uv-ws-section">
              <h4 className="uv-ws-title">Media generada</h4>
              <div className="uv-media-grid">
                {[...media].reverse().map((m) =>
                  m.url && m.medium === 'image' ? (
                    <a
                      key={m.id}
                      href={m.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="uv-media"
                    >
                      {/* Provider-hosted generated asset — external URL, not user HTML */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.url} alt={m.providerTool ?? 'Imagen generada'} loading="lazy" />
                    </a>
                  ) : m.url ? (
                    <a
                      key={m.id}
                      href={m.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="uv-artifact"
                    >
                      <Monitor size={15} />
                      <span>
                        {m.medium === 'video' ? 'Video generado' : 'Media'} ·{' '}
                        {m.providerTool ?? 'ver'}
                      </span>
                    </a>
                  ) : (
                    <div key={m.id} className="uv-act is-failed">
                      Generación sin URL ({m.providerTool ?? 'proveedor'})
                    </div>
                  )
                )}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );

  return (
    <aside className="uv-ws" aria-label="Espacio de trabajo del equipo">
      <div className="uv-ws-head">
        <div className="uv-tabs" role="tablist" aria-label="Superficies">
          {TABS.map((t) => {
            const meta = tabMeta[t.id];
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={cn('uv-tab', tab === t.id && 'is-active')}
                onClick={() => pickTab(t.id)}
              >
                {t.icon}
                <span>{t.label}</span>
                {meta.live && <span className="uv-tab-dot is-live" aria-label="En vivo" />}
                {!meta.live && meta.count ? (
                  <span className="uv-tab-count">{meta.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
        <span
          className={cn('uv-tab-dot', connected && 'is-live')}
          title={connected ? 'Conectado en vivo' : 'Sin conexión en vivo'}
          aria-hidden="true"
        />
        {onClose && (
          <button
            type="button"
            className="uv-icon-btn"
            onClick={onClose}
            aria-label="Cerrar espacio de trabajo"
          >
            <X size={15} />
          </button>
        )}
      </div>

      <div className="uv-ws-body" role="tabpanel">
        {tab === 'browser' && browserSurface}
        {tab === 'computer' && computerSurface}
        {tab === 'team' && teamSurface}
        {tab === 'files' && filesSurface}
      </div>
    </aside>
  );
}
