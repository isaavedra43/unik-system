'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ExternalLink,
  FileText,
  Globe,
  Monitor,
  MousePointerClick,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Agent Workspace — the assistant's third column.
 *
 * Subscribes to the persisted realtime channel `assistant:{conversationId}`
 * over /app/realtime/api/stream (SSE with cursor resume, so a reload replays
 * what the agent did). Mirrors the Grok/ChatGPT agent panel: the virtual
 * computer's screen on top, then a live feed of every page the agent found or
 * read, every browser action, and every file it produced.
 *
 * Everything here is a mirror of real tool executions — nothing is inferred
 * from the model's prose.
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

const TOOL_ICON: Record<string, React.ReactNode> = {
  web_search: <Globe size={13} />,
  fetch_url: <FileText size={13} />,
  web_crawl: <Globe size={13} />,
  browser: <MousePointerClick size={13} />,
  venueExec: <Terminal size={13} />,
  venueScreenshot: <Monitor size={13} />,
};

const MAX_ITEMS = 60;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function AssistantWorkspace({
  conversationId,
  onClose,
}: {
  conversationId: string | null;
  onClose?: () => void;
}) {
  const [screen, setScreen] = useState<ScreenState | null>(null);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [pageContent, setPageContent] = useState<Record<string, { title?: string; markdown: string }>>({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [browserActions, setBrowserActions] = useState<ActivityItem[]>([]);
  const [readerUrl, setReaderUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const counterRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);

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
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    const channel = `assistant:${conversationId}`;
    const es = new EventSource(`/app/realtime/api/stream?channels=${encodeURIComponent(channel)}`);

    es.addEventListener('ready', () => setConnected(true));

    es.addEventListener('workspace.tool', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { tool?: string; ok?: boolean; summary?: string; error?: string; ts?: string };
        if (!d.tool) return;
        setActivity((prev) =>
          [...prev, { id: ++counterRef.current, tool: d.tool!, ok: d.ok === true, summary: d.summary, error: d.error, ts: d.ts }].slice(-MAX_ITEMS)
        );
      } catch { /* ignore */ }
    });

    es.addEventListener('workspace.pages', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { source?: string; pages?: PageItem[]; ts?: string };
        const incoming = (d.pages ?? []).filter((p) => p.url);
        if (incoming.length === 0) return;
        setPages((prev) => {
          const seen = new Set(prev.map((p) => p.url));
          const fresh = incoming.filter((p) => !seen.has(p.url)).map((p) => ({ ...p, source: d.source }));
          return [...prev, ...fresh].slice(-MAX_ITEMS);
        });
      } catch { /* ignore */ }
    });

    es.addEventListener('workspace.page_content', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { url?: string; title?: string; markdown?: string };
        if (!d.url || !d.markdown) return;
        setPageContent((prev) => ({ ...prev, [d.url!]: { title: d.title, markdown: d.markdown! } }));
      } catch { /* ignore */ }
    });

    es.addEventListener('workspace.screen', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { dataUrl?: string; url?: string; ts?: string };
        if (d.dataUrl) setScreen({ dataUrl: d.dataUrl, url: d.url, ts: d.ts });
      } catch { /* ignore */ }
    });

    es.addEventListener('workspace.browser', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { action?: string; url?: string; ok?: boolean; error?: string; ts?: string };
        setBrowserActions((prev) =>
          [...prev, { id: ++counterRef.current, tool: `browser.${d.action ?? 'act'}`, ok: d.ok === true, summary: d.url, error: d.error, ts: d.ts }].slice(-MAX_ITEMS)
        );
      } catch { /* ignore */ }
    });

    es.addEventListener('workspace.artifact', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as ArtifactItem;
        if (!d.artifactId) return;
        setArtifacts((prev) => {
          if (prev.some((a) => a.artifactId === d.artifactId)) return prev;
          return [...prev, d].slice(-MAX_ITEMS);
        });
      } catch { /* ignore */ }
    });

    es.addEventListener('workspace.media', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { medium?: string; url?: string; providerTool?: string; ok?: boolean };
        setMedia((prev) => [...prev, { id: ++counterRef.current, medium: d.medium, url: d.url, providerTool: d.providerTool }].slice(-MAX_ITEMS));
      } catch { /* ignore */ }
    });

    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [conversationId]);

  // Keep the feed pinned to the bottom as items arrive.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity, browserActions]);

  const feedItems = [...activity, ...browserActions].sort((a, b) => a.id - b.id);
  const isEmpty = !screen && pages.length === 0 && feedItems.length === 0 && artifacts.length === 0 && media.length === 0;

  return (
    <aside className="assistant-workspace" aria-label="Espacio de trabajo del agente">
      <div className="assistant-workspace-header">
        <div className="assistant-workspace-title">
          <Monitor size={15} />
          <span>Espacio de trabajo</span>
          <span className={cn('assistant-workspace-live-dot', connected && 'is-live')} title={connected ? 'En vivo' : 'Desconectado'} />
        </div>
        {onClose && (
          <button type="button" className="assistant-workspace-close" onClick={onClose} aria-label="Cerrar espacio de trabajo">
            <X size={15} />
          </button>
        )}
      </div>

      <div className="assistant-workspace-body" ref={feedRef}>
        {isEmpty && (
          <div className="assistant-workspace-empty">
            <Monitor size={28} />
            <p>Aquí verás lo que el agente hace: páginas que abre, la pantalla de la computadora virtual, archivos que genera.</p>
          </div>
        )}

        {screen && (
          <section className="assistant-workspace-section">
            <h4 className="assistant-workspace-section-title">Pantalla</h4>
            <div className="assistant-workspace-screen">
              {/* Remote-computer frame; data URL, never user HTML.
                  <img> over next/image: data URLs can't be optimized anyway. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={screen.dataUrl} alt="Pantalla de la computadora virtual" />
            </div>
            {screen.url && <div className="assistant-workspace-screen-url">{hostOf(screen.url)} — {screen.url}</div>}
          </section>
        )}

        {pages.length > 0 && (
          <section className="assistant-workspace-section">
            <h4 className="assistant-workspace-section-title">Páginas ({pages.length})</h4>
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
                      <span className="assistant-workspace-page-title">{p.title || hostOf(p.url)}</span>
                      <span className="assistant-workspace-page-host">{hostOf(p.url)}</span>
                    </span>
                    {pageContent[p.url] && <FileText size={12} className="assistant-workspace-page-read" />}
                  </button>
                  {readerUrl === p.url && pageContent[p.url] && (
                    <div className="assistant-workspace-reader">
                      <div className="assistant-workspace-reader-title">{pageContent[p.url].title || p.url}</div>
                      {/* Untrusted external content — rendered as plain text, never as HTML */}
                      <pre className="assistant-workspace-reader-body">{pageContent[p.url].markdown.slice(0, 12000)}</pre>
                      <a href={p.url} target="_blank" rel="noreferrer noopener" className="assistant-workspace-reader-link">
                        Abrir página original <ExternalLink size={11} />
                      </a>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {feedItems.length > 0 && (
          <section className="assistant-workspace-section">
            <h4 className="assistant-workspace-section-title">
              <Activity size={12} /> Actividad
            </h4>
            <ul className="assistant-workspace-activity">
              {feedItems.map((a) => (
                <li key={a.id} className={cn('assistant-workspace-act', !a.ok && 'is-failed')}>
                  <span className="assistant-workspace-act-icon">
                    {TOOL_ICON[a.tool] ?? TOOL_ICON[a.tool.split('.')[0]] ?? <Wrench size={13} />}
                  </span>
                  <span className="assistant-workspace-act-text">
                    <span className="assistant-workspace-act-name">{a.tool}</span>
                    {a.summary && <span className="assistant-workspace-act-summary">{a.summary}</span>}
                    {a.error && <span className="assistant-workspace-act-error">{a.error}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {media.length > 0 && (
          <section className="assistant-workspace-section">
            <h4 className="assistant-workspace-section-title">Media generada ({media.length})</h4>
            <ul className="assistant-workspace-media">
              {media.map((m) => (
                <li key={m.id}>
                  {m.url && m.medium === 'image' ? (
                    <a href={m.url} target="_blank" rel="noreferrer noopener" className="assistant-workspace-media-link">
                      {/* Provider-hosted generated asset — external URL, not user HTML */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.url} alt={m.providerTool ?? 'Imagen generada'} className="assistant-workspace-media-img" />
                    </a>
                  ) : m.url ? (
                    <a href={m.url} target="_blank" rel="noreferrer noopener" className="assistant-workspace-artifact">
                      <Monitor size={14} />
                      <span>{m.medium === 'video' ? 'Video generado' : 'Media'} — {m.providerTool ?? 'ver'}</span>
                    </a>
                  ) : (
                    <div className="assistant-workspace-act is-failed">Generación sin URL ({m.providerTool ?? 'proveedor'})</div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {artifacts.length > 0 && (
          <section className="assistant-workspace-section">
            <h4 className="assistant-workspace-section-title">Archivos ({artifacts.length})</h4>
            <ul className="assistant-workspace-artifacts">
              {artifacts.map((a) => (
                <li key={a.artifactId}>
                  <a className="assistant-workspace-artifact" href={a.downloadUrl ?? '#'} target="_blank" rel="noreferrer noopener">
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
