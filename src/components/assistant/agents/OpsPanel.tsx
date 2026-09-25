'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ChevronRight,
  ExternalLink,
  FileText,
  Flag,
  Globe,
  Hand,
  KeyRound,
  Loader2,
  Monitor,
  MousePointerClick,
  RotateCcw,
  ShieldAlert,
  Terminal,
  Timer,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toolLabel } from '@/components/copilot/copilot-types';
import { hostOf, relTime } from './agent-types';
import { MISSION_STATUS_LABEL, missionProgress, type MissionItem } from './AgentSidebar';

/**
 * Ops panel — the team's operations column ("qué está pasando ahora").
 *
 * Data sources (all real, all degrade gracefully):
 * - SSE `assistant:{conversationId}` → workspace.* events (screen, tools,
 *   pages, browser actions, artifacts, media, secure-input).
 * - Poll `/app/assistant/api/venue/state` while a venue session is active.
 * - `GET /app/assistant/api/missions` → missions + vigils (schedule).
 * - `GET /app/assistant/api/proposals` → pending approvals.
 * - `GET /app/assistant/api/usage` → cost breakdown; hidden when absent.
 */

interface PageItem {
  url: string;
  title?: string;
  snippet?: string;
  source?: string;
  ts?: string;
}

interface ActivityItem {
  id: number;
  tool: string;
  ok: boolean;
  summary?: string;
  error?: string;
  ts?: string;
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
  url?: string;
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
  spent?: number;
  budget?: number;
  label?: string;
}

const TOOL_ICON: Record<string, React.ReactNode> = {
  web_search: <Globe size={13} />,
  fetch_url: <FileText size={13} />,
  web_crawl: <Globe size={13} />,
  browser: <MousePointerClick size={13} />,
  venueExec: <Terminal size={13} />,
  venueScreenshot: <Monitor size={13} />,
};

const MAX_ITEMS = 60;
const TERMINAL_LINES = 30;

function clockOf(ts?: string): string {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

function elapsedLabel(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function OpsPanel({
  conversationId,
  userId,
  onClose,
  onOpenConversation,
}: {
  conversationId: string | null;
  /** Owner channel for `agent.task` delegation events (B4/B5). */
  userId?: string;
  onClose?: () => void;
  onOpenConversation?: (id: string) => void;
}) {
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
  const [venueActive, setVenueActive] = useState(false);
  const [secureInputs, setSecureInputs] = useState<SecureInputRequest[]>([]);
  const [secureInputBusy, setSecureInputBusy] = useState<string | null>(null);
  const [secureInputDone, setSecureInputDone] = useState<Set<string>>(new Set());
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [missionsLoaded, setMissionsLoaded] = useState(false);
  const [approvals, setApprovals] = useState<PendingProposal[]>([]);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [replayKey, setReplayKey] = useState(0);
  const counterRef = useRef(0);
  const startRef = useRef<number | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);

  // Reset when switching conversations.
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
    setVenueActive(false);
    setSecureInputs([]);
    setSecureInputDone(new Set());
    startRef.current = null;
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    const channel = `assistant:${conversationId}`;
    const es = new EventSource(`/app/realtime/api/stream?channels=${encodeURIComponent(channel)}`);

    es.addEventListener('ready', () => setConnected(true));

    es.addEventListener('workspace.tool', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          tool?: string;
          ok?: boolean;
          summary?: string;
          error?: string;
          ts?: string;
        };
        if (!d.tool) return;
        if (!startRef.current) startRef.current = Date.now();
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
            },
          ].slice(-MAX_ITEMS)
        );
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('workspace.pages', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          source?: string;
          pages?: PageItem[];
          ts?: string;
        };
        const incoming = (d.pages ?? []).filter((p) => p.url);
        if (incoming.length === 0) return;
        setPages((prev) => {
          const seen = new Set(prev.map((p) => p.url));
          const fresh = incoming
            .filter((p) => !seen.has(p.url))
            .map((p) => ({ ...p, source: d.source }));
          return [...prev, ...fresh].slice(-MAX_ITEMS);
        });
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('workspace.page_content', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          url?: string;
          title?: string;
          markdown?: string;
        };
        if (!d.url || !d.markdown) return;
        setPageContent((prev) => ({
          ...prev,
          [d.url!]: { title: d.title, markdown: d.markdown! },
        }));
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('workspace.screen', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          dataUrl?: string;
          url?: string;
          ts?: string;
        };
        setVenueActive(true);
        if (d.dataUrl) setScreen({ dataUrl: d.dataUrl, url: d.url, ts: d.ts });
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('workspace.browser', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          action?: string;
          url?: string;
          ok?: boolean;
          error?: string;
          ts?: string;
        };
        setVenueActive(true);
        if (!startRef.current) startRef.current = Date.now();
        setBrowserActions((prev) =>
          [
            ...prev,
            {
              id: ++counterRef.current,
              tool: `browser.${d.action ?? 'act'}`,
              ok: d.ok === true,
              summary: d.url,
              error: d.error,
              ts: d.ts,
            },
          ].slice(-MAX_ITEMS)
        );
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('workspace.secure_input', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as SecureInputRequest & {
          requestId?: string;
        };
        setVenueActive(true);
        if (!d.requestId) return;
        setSecureInputs((prev) =>
          prev.some((r) => r.requestId === d.requestId) ? prev : [...prev, d]
        );
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('workspace.artifact', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as ArtifactItem;
        if (!d.artifactId) return;
        setArtifacts((prev) => {
          if (prev.some((a) => a.artifactId === d.artifactId)) return prev;
          return [...prev, d].slice(-MAX_ITEMS);
        });
      } catch {
        /* ignore */
      }
    });

    es.addEventListener('workspace.media', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as {
          medium?: string;
          url?: string;
          providerTool?: string;
          ok?: boolean;
        };
        setMedia((prev) =>
          [
            ...prev,
            {
              id: ++counterRef.current,
              medium: d.medium,
              url: d.url,
              providerTool: d.providerTool,
            },
          ].slice(-MAX_ITEMS)
        );
      } catch {
        /* ignore */
      }
    });

    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [conversationId]);

  // Delegation events — `agent.task` on the owner channel: a task queued /
  // running / done / failed shows up as a terminal line in real time.
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

  // Live screen: while a venue session is active, poll the browser's live
  // screenshot + pending secure-input requests. Only while the tab is visible
  // — when the user stops watching, the venue's idle reaper stops the sandbox.
  useEffect(() => {
    if (!venueActive) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/app/assistant/api/venue/state', { cache: 'no-store' });
        if (!res.ok) return;
        const d = (await res.json()) as {
          active?: boolean;
          screen?: { dataUrl?: string; url?: string } | null;
          pendingInputs?: {
            requestId: string;
            message?: string | null;
            fields: SecureInputField[];
          }[];
        };
        if (d.active === false) {
          setVenueActive(false);
          return;
        }
        if (d.screen?.dataUrl) setScreen({ dataUrl: d.screen.dataUrl, url: d.screen.url });
        if (d.pendingInputs) {
          setSecureInputs((prev) => {
            const serverIds = new Set(d.pendingInputs!.map((r) => r.requestId));
            const kept = prev.filter((r) => serverIds.has(r.requestId));
            const known = new Set(kept.map((r) => r.requestId));
            return [...kept, ...d.pendingInputs!.filter((r) => !known.has(r.requestId))];
          });
        }
      } catch {
        /* poll is best-effort */
      }
    };
    void tick();
    const interval = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [venueActive]);

  // Missions + approvals + usage — all degrade: any failure hides its section.
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
    // Cost endpoint is not implemented yet — a 404 hides the section.
    fetch('/app/assistant/api/usage')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const d = (await res.json()) as UsageData;
        setUsage(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Elapsed counter ticks only while the terminal is live.
  const feedItems = [...activity, ...browserActions].sort((a, b) => a.id - b.id);
  const terminalLive = venueActive || feedItems.length > 0;
  useEffect(() => {
    if (!terminalLive) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [terminalLive]);

  // Keep the terminal pinned to the bottom as lines arrive.
  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity, browserActions, replayKey]);

  async function submitSecureInput(req: SecureInputRequest, form: HTMLFormElement) {
    if (!req.venueSessionId) return;
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
        body: JSON.stringify({ sessionId: req.venueSessionId, requestId: req.requestId, values }),
      });
      if (!res.ok) throw new Error('failed');
      // Wipe the fields immediately — values must not linger in the DOM.
      form.reset();
      setSecureInputs((prev) => prev.filter((r) => r.requestId !== req.requestId));
      setSecureInputDone((prev) => new Set(prev).add(req.requestId));
    } catch {
      // Leave the form in place so the user can retry.
    } finally {
      setSecureInputBusy(null);
    }
  }

  const activeMissions = missions.filter((m) =>
    ['active', 'blocked', 'awaiting_approval'].includes(m.status)
  );
  const vigils = missions.filter((m) => m.schedule);
  const isEmpty =
    !screen &&
    pages.length === 0 &&
    feedItems.length === 0 &&
    artifacts.length === 0 &&
    media.length === 0 &&
    activeMissions.length === 0 &&
    approvals.length === 0 &&
    secureInputs.length === 0;
  const elapsed = startRef.current ? elapsedLabel(startRef.current, now) : '+0:00';

  return (
    <aside className="ops-panel" aria-label="Panel de operación del equipo">
      <div className="ops-head">
        <div className="ops-title">
          <Monitor size={15} />
          <span>Operación del equipo</span>
          <span
            className={cn('ops-live-dot', connected && 'is-live')}
            title={connected ? 'En vivo' : 'Desconectado'}
          />
        </div>
        {onClose && (
          <button
            type="button"
            className="ops-close"
            onClick={onClose}
            aria-label="Cerrar panel de operación"
          >
            <X size={15} />
          </button>
        )}
      </div>

      <div className="ops-body" ref={feedRef}>
        {isEmpty && (
          <div className="assistant-workspace-empty ops-empty">
            <Monitor size={28} />
            <p>
              Aquí verás lo que el equipo hace: la pantalla de la computadora virtual, su terminal,
              misiones y aprobaciones.
            </p>
          </div>
        )}

        {/* Pantalla — the venue's live screenshot in a browser frame. */}
        {screen && (
          <section className="ops-section">
            <h4 className="ops-section-title">
              Pantalla
              {venueActive && (
                <span className="ops-live-tag">
                  <span className="ops-live-dot is-live" /> EN VIVO
                </span>
              )}
            </h4>
            <div className="venue-frame">
              <div className="venue-chrome">
                <span className="venue-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="venue-url" title={screen.url}>
                  {screen.url ? hostOf(screen.url) : 'computadora virtual'}
                </span>
              </div>
              <div className="venue-screen">
                {/* Remote-computer frame; data URL, never user HTML. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={screen.dataUrl} alt="Pantalla de la computadora virtual" />
              </div>
            </div>
            <div className="venue-caption">
              El agente está viendo:{' '}
              {screen.url
                ? `${hostOf(screen.url)} — ${screen.url}`
                : 'el escritorio de la computadora virtual'}
            </div>
          </section>
        )}

        {/* Takeover — the agent needs the user to type into the page. */}
        {secureInputs.map((req) => (
          <section key={req.requestId} className="ops-section">
            <div className="venue-takeover">
              <div className="venue-takeover-head">
                <Hand size={14} />
                <span>Computadora · acción necesaria</span>
              </div>
              <p className="venue-takeover-msg">
                {req.message ?? 'La página pide datos que solo tú debes escribir.'}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitSecureInput(req, e.currentTarget);
                }}
              >
                {req.fields.map((f) => (
                  <label key={f.selector} className="assistant-workspace-secure-field">
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
                <div className="venue-takeover-actions">
                  <button
                    type="submit"
                    className="gui-btn gui-btn-primary"
                    disabled={secureInputBusy === req.requestId}
                  >
                    {secureInputBusy === req.requestId ? (
                      <Loader2 size={12} className="copilot-spin" />
                    ) : (
                      <KeyRound size={12} />
                    )}{' '}
                    Tomar el control
                  </button>
                </div>
                <p className="assistant-workspace-secure-note">
                  Los datos van directo a la página de la computadora virtual — nunca pasan por el
                  chat ni por la IA.
                </p>
              </form>
            </div>
          </section>
        ))}
        {secureInputDone.size > 0 && secureInputs.length === 0 && (
          <div className="assistant-workspace-secure-done">
            Listo — datos escritos en la página. El agente continúa solo.
          </div>
        )}

        {/* Terminal vivo — every tool/browser action as a log line. */}
        {feedItems.length > 0 && (
          <section className="ops-section">
            <h4 className="ops-section-title">
              <Terminal size={12} /> Terminal vivo
              <span className="ops-elapsed" title="Tiempo de la sesión">
                <Timer size={11} /> {elapsed}
              </span>
              <button
                type="button"
                className="ops-replay"
                onClick={() => setReplayKey((k) => k + 1)}
                aria-label="Repetir la actividad"
                title="Repetir la actividad"
              >
                <RotateCcw size={11} />
              </button>
            </h4>
            <div className="ops-terminal" ref={termRef} aria-live="polite">
              {feedItems.slice(-TERMINAL_LINES).map((a, i) => (
                <div
                  key={`${replayKey}-${a.id}`}
                  className={cn('ops-term-line', !a.ok && 'is-failed')}
                  style={{ animationDelay: `${Math.min(i * 40, 480)}ms` }}
                >
                  <span className="ops-term-time">{clockOf(a.ts)}</span>
                  <span className="ops-term-icon">
                    {TOOL_ICON[a.tool] ?? TOOL_ICON[a.tool.split('.')[0]] ?? <Wrench size={12} />}
                  </span>
                  <span className="ops-term-text">
                    {toolLabel(a.tool, 'done')}
                    {a.summary && <span className="ops-term-summary"> · {a.summary}</span>}
                    {a.error && <span className="ops-term-error"> · {a.error}</span>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Misiones activas */}
        {missionsLoaded && (
          <section className="ops-section">
            <h4 className="ops-section-title">
              <Flag size={12} /> Misiones activas
              {activeMissions.length > 0 && (
                <span className="ops-count">{activeMissions.length}</span>
              )}
            </h4>
            {activeMissions.length === 0 ? (
              <div className="ops-empty-inline">Sin misiones en curso</div>
            ) : (
              <ul className="ops-missions">
                {activeMissions.map((m) => {
                  const { done, total } = missionProgress(m);
                  const pct = total > 0 ? done / total : 0;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        className="ops-mission"
                        onClick={() => m.conversationId && onOpenConversation?.(m.conversationId)}
                        disabled={!m.conversationId}
                        title={m.goal}
                      >
                        <span className="ops-mission-title">{m.goal}</span>
                        <span className="ops-mission-meta">
                          {MISSION_STATUS_LABEL[m.status] ?? m.status}
                          {total > 0 && ` · ${done}/${total}`}
                        </span>
                        {total > 0 && (
                          <span className="ops-progress" aria-hidden="true">
                            <span
                              className="ops-progress-bar"
                              style={{ transform: `scaleX(${pct})` }}
                            />
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

        {/* Vigilancias — missions with a schedule. */}
        {vigils.length > 0 && (
          <section className="ops-section">
            <h4 className="ops-section-title">
              <Timer size={12} /> Vigilancias
            </h4>
            <ul className="ops-missions">
              {vigils.map((m) => (
                <li key={m.id}>
                  <div className="ops-vigil">
                    <span className="ops-mission-title">{m.goal}</span>
                    <span className="ops-mission-meta">
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

        {/* Aprobaciones pendientes */}
        {approvals.length > 0 && (
          <section className="ops-section">
            <h4 className="ops-section-title">
              <ShieldAlert size={12} /> Aprobaciones
              <span className="ops-count">{approvals.length}</span>
            </h4>
            <ul className="ops-missions">
              {approvals.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="ops-approval"
                    onClick={() => p.conversationId && onOpenConversation?.(p.conversationId)}
                    disabled={!p.conversationId}
                    title={p.summary}
                  >
                    <span className="ops-mission-title">{toolLabel(p.toolName, 'done')}</span>
                    <span className="ops-mission-meta">
                      {p.summary}
                      {p.expiresAt && ` · caduca ${relTime(p.expiresAt)}`}
                    </span>
                    <ChevronRight size={13} className="ops-approval-chevron" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Costo — only when the usage endpoint exists. */}
        {usage && (
          <section className="ops-section">
            <h4 className="ops-section-title">Costo del equipo</h4>
            <div className="ops-cost">
              {usage.jev !== undefined && (
                <div className="ops-cost-row">
                  <span>Jev (router)</span>
                  <span>${usage.jev.toFixed(3)}</span>
                </div>
              )}
              {usage.llm !== undefined && (
                <div className="ops-cost-row">
                  <span>Modelos (OpenRouter)</span>
                  <span>${usage.llm.toFixed(3)}</span>
                </div>
              )}
              {usage.venue !== undefined && (
                <div className="ops-cost-row">
                  <span>Computadora</span>
                  <span>${usage.venue.toFixed(3)}</span>
                </div>
              )}
              {usage.spent !== undefined && usage.budget !== undefined && (
                <>
                  <div className="ops-cost-row is-total">
                    <span>{usage.label ?? 'Hoy'}</span>
                    <span>
                      ${usage.spent.toFixed(3)} de ${usage.budget.toFixed(2)}
                    </span>
                  </div>
                  <span className="ops-progress" aria-hidden="true">
                    <span
                      className="ops-progress-bar"
                      style={{
                        transform: `scaleX(${usage.budget > 0 ? Math.min(1, usage.spent / usage.budget) : 0})`,
                      }}
                    />
                  </span>
                </>
              )}
            </div>
          </section>
        )}

        {pages.length > 0 && (
          <section className="ops-section">
            <h4 className="ops-section-title">Páginas ({pages.length})</h4>
            <ul className="assistant-workspace-pages">
              {pages.map((p) => (
                <li key={p.url}>
                  <button
                    type="button"
                    className="assistant-workspace-page"
                    onClick={() => setReaderUrl(readerUrl === p.url ? null : p.url)}
                    title={p.url}
                  >
                    <Globe size={13} className="assistant-workspace-page-icon" />
                    <span className="assistant-workspace-page-text">
                      <span className="assistant-workspace-page-title">
                        {p.title || hostOf(p.url)}
                      </span>
                      <span className="assistant-workspace-page-host">{hostOf(p.url)}</span>
                    </span>
                    {pageContent[p.url] && (
                      <FileText size={12} className="assistant-workspace-page-read" />
                    )}
                  </button>
                  {readerUrl === p.url && pageContent[p.url] && (
                    <div className="assistant-workspace-reader">
                      <div className="assistant-workspace-reader-title">
                        {pageContent[p.url].title || p.url}
                      </div>
                      {/* Untrusted external content — rendered as plain text, never as HTML */}
                      <pre className="assistant-workspace-reader-body">
                        {pageContent[p.url].markdown.slice(0, 12000)}
                      </pre>
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="assistant-workspace-reader-link"
                      >
                        Abrir página original <ExternalLink size={11} />
                      </a>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Actividad completa — feed no-terminal (todo lo demás). */}
        {activity.length > 0 && (
          <section className="ops-section">
            <h4 className="ops-section-title">
              <Activity size={12} /> Actividad
            </h4>
            <ul className="assistant-workspace-activity">
              {activity.map((a) => (
                <li key={a.id} className={cn('assistant-workspace-act', !a.ok && 'is-failed')}>
                  <span className="assistant-workspace-act-icon">
                    {TOOL_ICON[a.tool] ?? TOOL_ICON[a.tool.split('.')[0]] ?? <Wrench size={13} />}
                  </span>
                  <span className="assistant-workspace-act-text">
                    <span className="assistant-workspace-act-name">{a.tool}</span>
                    {a.summary && (
                      <span className="assistant-workspace-act-summary">{a.summary}</span>
                    )}
                    {a.error && <span className="assistant-workspace-act-error">{a.error}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {media.length > 0 && (
          <section className="ops-section">
            <h4 className="ops-section-title">Media generada ({media.length})</h4>
            <ul className="assistant-workspace-media">
              {media.map((m) => (
                <li key={m.id}>
                  {m.url && m.medium === 'image' ? (
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="assistant-workspace-media-link"
                    >
                      {/* Provider-hosted generated asset — external URL, not user HTML */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={m.url}
                        alt={m.providerTool ?? 'Imagen generada'}
                        className="assistant-workspace-media-img"
                      />
                    </a>
                  ) : m.url ? (
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="assistant-workspace-artifact"
                    >
                      <Monitor size={14} />
                      <span>
                        {m.medium === 'video' ? 'Video generado' : 'Media'} —{' '}
                        {m.providerTool ?? 'ver'}
                      </span>
                    </a>
                  ) : (
                    <div className="assistant-workspace-act is-failed">
                      Generación sin URL ({m.providerTool ?? 'proveedor'})
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {artifacts.length > 0 && (
          <section className="ops-section">
            <h4 className="ops-section-title">Archivos ({artifacts.length})</h4>
            <ul className="assistant-workspace-artifacts">
              {artifacts.map((a) => (
                <li key={a.artifactId}>
                  <a
                    className="assistant-workspace-artifact"
                    href={a.downloadUrl ?? '#'}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <FileText size={14} />
                    <span>{a.title || a.fileName || 'Archivo'}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
